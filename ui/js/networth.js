import { isTauri } from "./source.js";

let PRICES = null;
export function loadPrices() {
  if (!PRICES) {
    PRICES = isTauri()
      ? window.__TAURI__.core.invoke("get_item_prices")
      : fetch("/constants/item_prices.json").then(r => r.json());
  }
  return PRICES;
}

const TRANSIT_TTL = 90;   // 秒（游戏时钟）：信使飞完全图也用不了这么久

/**
 * 单件物品的价值。消耗品按剩余充能折价——只剩一口的树苗不值一整份的钱。
 * 注意瓶子有充能但不算消耗品，空瓶依然值全价，这里靠 consumable 标志区分。
 */
function itemCost(it, prices) {
  const n = it.name;
  if (!n || n === "empty") return 0;
  const info = prices[n.replace(/^item_/, "")];
  if (!info) return 0;
  const base = info.cost || 0;
  const max = info.charges;
  if (info.consumable && max > 0 && typeof it.charges === "number"
      && it.charges >= 0 && it.charges <= max) {
    return Math.round(base * it.charges / max);
  }
  return base;
}

/**
 * 自己的全局槽位（0-9，天辉 0-4 / 夜魇 5-9）——物品的 purchaser 用的就是这套编号。
 * 注意不是 team_slot：夜魇要加 5，否则打夜魇时自己的装备会全被判成别人的。
 */
function mySlot(player) {
  if (!player || typeof player.team_slot !== "number") return null;
  return player.team_slot + (player.team_name === "dire" ? 5 : 0);
}

/** 队友塞过来让你带的东西（圣剑、宝石）不该算进自己的资产；
 *  自己买的、无主的、从敌人手里缴获的都算。
 *  槽位算错时会退化成"全都算"，也就是原来的行为，不会把资产错误地清空。 */
function isTeammates(it, mine) {
  if (mine === null) return false;
  const p = it.purchaser;
  if (typeof p !== "number" || p < 0 || p === mine) return false;
  return (p < 5) === (mine < 5);      // 同队但不是自己
}

/** 把物品栏拆成"装备栏价值 / 储藏处价值"。中立物品不花钱（OpenDota 表里价格也确实是 0）；
 *  传送槽每局白送一个 TP，计入会让开局虚高 100。 */
function itemValues(items, prices, player) {
  const mine = mySlot(player);
  let slot = 0, stash = 0;
  for (const [k, it] of Object.entries(items || {})) {
    if (!it || typeof it !== "object") continue;
    if (k.startsWith("neutral") || k.startsWith("preserved_neutral") || k.startsWith("teleport")) continue;
    if (isTeammates(it, mine)) continue;
    const cost = itemCost(it, prices);
    if (k.startsWith("stash")) stash += cost; else slot += cost;
  }
  return { slot, stash };
}

/**
 * 只以永久 buff 形式存在、物品栏里看不到的东西。价格优先查表（随版本自动更新），
 * 查不到再退回常数表。
 *
 * 神杖系的真实机制（别按"吞掉物品"去理解）：
 *   · 阿哈利姆神杖 4200 是**当物品拿着**的，本身不会变成 buff，按物品价计。
 *   · 神杖 + 祝福卷轴 1600 会**自动合成为 buff**，两件物品同时从物品栏消失
 *     → 这时 buff 代表的是阿哈利姆祝福，值 5800。
 *   · 炼金术士把神杖送给队友，受赠方也是**直接得到 buff**，物品栏里从没出现过东西
 *     → 这时 buff 代表一根神杖，值 4200。
 *   · 肉山掉的祝福是当物品捡起来的，消耗后同样只剩 buff，值 5800。
 *
 * 两种来源共用 modifier_item_ultimate_scepter_consumed 这一个名字，光看 buff 分不出，
 * 所以靠物品栏历史判断：见过祝福卷轴 / 祝福成品 / 肉山祝福 → 5800；
 * 什么都没见过（炼金送的）→ 4200。实测物品消失与 buff 出现是同一时刻切换，不会重复计。
 *
 * 一律计入，不管自己买的、肉山掉的还是炼金送的——到手就是永久属性，
 * 和"队友让你代拿的物品"（随时能还回去，不计）不同。
 */
const CONSUMED_BUFFS = [
  {
    mods: ["modifier_item_ultimate_scepter_consumed"],
    api: "ultimate_scepter",
    constKey: "aghsScepterValue",
    upgrade: {
      api: "ultimate_scepter_2",
      mods: ["modifier_item_ultimate_scepter_2_consumed"],
      items: ["ultimate_scepter_2", "ultimate_scepter_roshan", "recipe_ultimate_scepter_2"],
    },
  },
  { mods: ["modifier_item_moon_shard_consumed"], api: "moon_shard", constKey: "moonShardValue" },
];

/** 需要记进物品栏历史的物品名 */
const TRACKED_ITEMS = CONSUMED_BUFFS.flatMap(b => b.upgrade?.items ?? []);

/**
 * 净资产 = 金钱 + 装备栏 + 储藏处 + 在途 + 魔晶/神杖修正。
 *
 * "在途"是必须的：物品被信使取走后、送达前，既不在装备栏也不在储藏处，
 * GSI 完全看不见它。实测每局会造成 1~10 次凹陷，幅度 1000~5000，持续中位 6~29 秒。
 * 这里把从储藏处消失又没出现在装备栏的价值记下来，等它送达或超时再抹掉。
 *
 * 已知误差：从储藏处直接卖东西会让净资产虚高最多 90 秒（这个操作很少见）。
 */
export class EconTracker {
  constructor() { this.reset(); }
  reset() {
    this.prevSlot = null; this.prevStash = null; this.transit = []; this.lastClock = null;
    this.seenVariants = new Set();  // 本局在物品栏里见过的吞噬类物品，用来决定按哪个价计
  }

  /** 记下见过哪件升级物品——神杖和祝福可能共用 buff 名，靠这个区分 4200 还是 5800 */
  noteVariants(items) {
    for (const it of Object.values(items || {})) {
      if (!it || typeof it !== "object") continue;
      const n = (it.name || "").replace(/^item_/, "");
      if (TRACKED_ITEMS.includes(n)) this.seenVariants.add(n);
    }
  }

  update(state, prices, C, clock) {
    const { slot, stash } = itemValues(state.items, prices, state.player);
    this.noteVariants(state.items);

    // 号角前 clock_time 不单调（选人/策略阶段先倒计时一轮，再重置到 -90 数到 0），
    // 用它算超时不成立；换局重开同理。这两种情况下只记录状态，不做在途推断。
    if (clock === null || clock < 0 || (this.lastClock !== null && clock < this.lastClock - 5)) {
      this.transit = [];
      this.prevSlot = slot;
      this.prevStash = stash;
      this.lastClock = clock;
      return this.total(state, prices, C, slot, stash);
    }
    this.lastClock = clock;

    if (this.prevStash !== null) {
      const lost = this.prevStash - stash;      // 储藏处减少的价值
      const gained = slot - this.prevSlot;      // 装备栏增加的价值
      if (lost > 0 && gained < lost) {
        this.transit.push({ v: lost - Math.max(0, gained), at: clock });
      } else if (gained > 0) {
        this.deliver(gained);                   // 装备栏变多 = 在途的东西到货了
      }
      this.transit = this.transit.filter(t => clock - t.at < TRANSIT_TTL);
    }
    this.prevSlot = slot;
    this.prevStash = stash;
    return this.total(state, prices, C, slot, stash);
  }

  total(state, prices, C, slot, stash) {
    const p = state.player || {}, h = state.hero || {};
    const inTransit = this.transit.reduce((a, t) => a + t.v, 0);
    let nw = (p.gold ?? 0) + slot + stash + inTransit;
    if (h.aghanims_shard) nw += prices.aghanims_shard?.cost ?? C.aghsShardValue ?? 0;
    const buffs = h.permanent_buffs || {};
    for (const b of CONSUMED_BUFFS) {
      const up = b.upgrade;
      const upActive = up && (up.mods.some(m => m in buffs)
                              || up.items.some(n => this.seenVariants.has(n)));
      if (!b.mods.some(m => m in buffs) && !upActive) continue;
      const id = upActive ? up.api : b.api;
      nw += prices[id]?.cost ?? C[b.constKey] ?? 0;
    }
    return { networth: nw, gpm: p.gpm ?? 0, xpm: p.xpm ?? 0 };
  }

  deliver(value) {
    for (const t of this.transit) {
      const d = Math.min(t.v, value);
      t.v -= d; value -= d;
      if (value <= 0) break;
    }
    this.transit = this.transit.filter(t => t.v > 0);
  }
}
