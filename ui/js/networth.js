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

/** 把物品栏拆成"装备栏价值 / 储藏处价值"。中立物品不花钱（OpenDota 表里价格也确实是 0）；
 *  传送槽每局白送一个 TP，计入会让开局虚高 100。 */
function itemValues(items, prices) {
  let slot = 0, stash = 0;
  for (const [k, it] of Object.entries(items || {})) {
    if (!it || typeof it !== "object") continue;
    if (k.startsWith("neutral") || k.startsWith("preserved_neutral") || k.startsWith("teleport")) continue;
    const cost = itemCost(it, prices);
    if (k.startsWith("stash")) stash += cost; else slot += cost;
  }
  return { slot, stash };
}

/** 吃掉后只留永久 buff、物品栏里看不到的东西。价格优先查表（随版本自动更新），
 *  查不到再退回常数表。 */
const CONSUMED_BUFFS = [
  ["modifier_item_ultimate_scepter_consumed", "ultimate_scepter", "aghsScepterValue"],
  ["modifier_item_moon_shard_consumed",       "moon_shard",       "moonShardValue"],
];

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
  reset() { this.prevSlot = null; this.prevStash = null; this.transit = []; this.lastClock = null; }

  update(state, prices, C, clock) {
    const { slot, stash } = itemValues(state.items, prices);

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
    for (const [mod, api, key] of CONSUMED_BUFFS) {
      if (mod in buffs) nw += prices[api]?.cost ?? C[key] ?? 0;
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
