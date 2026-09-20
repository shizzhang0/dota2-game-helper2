import { isTauri, fetchConstant } from "./source.js";

let PRICES = null;
export function loadPrices() {
  if (!PRICES) {
    PRICES = isTauri()
      ? window.__TAURI__.core.invoke("get_item_prices")
      : fetchConstant("item_prices.json");
  }
  return PRICES;
}

const TRANSIT_TTL = 90;   // 秒（游戏时钟）：信使飞完全图也用不了这么久

/** 一笔"说不清去向的支出"至少要这么多才记账。低于这个数分不清是买东西还是取样噪声。 */
const SPEND_MIN = 150;

/** 买活事件之后多久之内不记支出账。掉钱和事件不一定落在同一包。 */
const BUYBACK_GRACE = 5;

const DISPENSER_GRACE = 20;   // 秒：眼架被信使拿着时 GSI 看不见它，别急着把价值清零
const SELL_TOL = 20;      // 金：判"卖出"时允许的偏差，主要用来吸收同一包里的被动收入

/** 储藏处少了 V，这是「卖掉了」还是「被信使取走了」？
 *
 * 两者在 GSI 里长得一模一样（储藏处少了、装备栏没多），但**卖出会当场到账**：
 * 买入 10 秒内退全额、之后退半价；被信使取走时金钱纹丝不动。
 * 不分开的话，卖掉的东西会记进在途账继续算着，而卖得的钱也算进金钱——
 * 同一件东西算两遍，直到 TTL 超时（实测虚高整整 90 秒）。
 *
 * **宁可漏判**：漏判只是退回旧行为（虚高一个 TTL），误判则会丢掉真正的在途账、
 * 反而少算。被动收入每包才 +2，而这个信号是几百金，分得很开——
 * 传送卷轴那 100 被噪声淹掉正是反例。
 */
function soldFromStash(lost, dGold) {
  if (!(dGold > 0)) return false;
  return Math.abs(dGold - lost) <= SELL_TOL || Math.abs(dGold - lost / 2) <= SELL_TOL;
}

/**
 * 本包里"我"新买了哪些东西。GSI 的购买事件只给物品 id，靠价格表里的 id 反查名字。
 *
 * **必须去重**：events 是缓存池里的一段，同一条事件会在后续每一包里重复出现，
 * 直接累加会把一次购买算上几十次（实测眼架能涨到一万多）。用 `type|time` 当键，
 * 和 EventTracker 里的做法一致。
 */
function myPurchases(state, prices, mine, seen) {
  const out = [];
  if (mine === null) return out;
  for (const e of Object.values(state.events || {})) {
    if (!e || e.event_type !== "generic_event" || typeof e.data !== "string") continue;
    let d;
    try { d = JSON.parse(e.data); } catch { continue; }
    if (d.type !== "CHAT_MESSAGE_ITEM_PURCHASE") continue;
    const key = d.type + "|" + d.time + "|" + d.value + "|" + d.playerid1;
    if (seen.has(key)) continue;
    seen.add(key);
    if (d.playerid1 === mine) out.push(d.value);
  }
  return out;
}

/** 物品 id -> 表里的条目。只建一次，价格表一局之内不变。 */
let BY_ID = null, BY_ID_SRC = null;
function byId(prices, id) {
  if (BY_ID_SRC !== prices) {
    BY_ID_SRC = prices;
    BY_ID = new Map();
    for (const [name, v] of Object.entries(prices))
      if (v && typeof v.id === "number") BY_ID.set(v.id, name);
  }
  return BY_ID.get(id);
}

/**
 * 单件物品的价值。消耗品按充能数折算——`价格 × 当前充能 ÷ 满充能`。
 * 这一个公式同时管两件事：
 *   · **用剩的**（树苗 1/4 → 23）不值一整份的钱
 *   · **叠起来的**（烟 ×2 → 100）值两份的钱
 * 表里的 charges 是"一份卖几个充能"，物品栏里的 charges 是当前实际数量，
 * 两者相除才是份数——所以**不能给它设上限**。
 * 早期版本写了 `charges <= max` 才折算，超过就退回单份价格，
 * 于是一叠两个烟只算 50。实测 2026-09-08 快速局 21:30 官方净资产就比我们多这 50。
 *
 * 注意瓶子有充能但不算消耗品，空瓶依然值全价，这里靠 consumable 标志区分。
 */
function itemCost(it, prices) {
  const n = it.name;
  if (!n || n === "empty") return 0;
  const info = prices[n.replace(/^item_/, "")];
  if (!info) return 0;
  const base = info.cost || 0;
  const max = info.charges;
  if (info.consumable && max > 0 && typeof it.charges === "number" && it.charges >= 0) {
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
/**
 * 这件东西算不算持有者的钱。**官方完全按 `purchaser` 算：等于自己才算。**
 *
 * 2026-09-20 用 matchid 9006189153（观战，有官方 net_worth 当真值）验的。
 * 最硬的一例是同一件物品只有 purchaser 变了：slot0 捡起肉山掉的刷新球碎片后
 * `purchaser` 一直是 -1，官方一分不算；等它变成 0（= 他自己），官方净资产
 * **同包 +1000**。物品没变、人没变、金币没变。
 *
 * 原先这里对 `p < 0` 返回 false（= 照计），会在刚捡起肉山掉落物的那段时间
 * 虚高 1000；而"同队与否"这个分法本身也是错的——slot2 末局拿着一个从地上捡的
 * 敌方的雾（`purchaser=9`），旧规则不排除，他的终值一直虚高 50。
 * 判据就是**等于不等于自己**。改完这局十个人的终值偏差全部是 0。
 */
function notOwnedBy(it, mine) {
  if (mine === null) return false;
  const p = it.purchaser;
  if (typeof p !== "number") return false;   // 没这个字段就别猜，按自己的算
  return p !== mine;                         // 队友、敌方、无主(-1) 都不算
}

/** 魔晶值多少。价格优先查表（随版本自动更新），查不到再退回常数表。 */
function shardValue(prices, C) {
  return prices.aghanims_shard?.cost ?? C.aghsShardValue ?? 0;
}

/** 把物品栏拆成"装备栏价值 / 储藏处价值"。中立物品不花钱（价格表里也确实是 0）；
 *  传送槽每局白送一个 TP，计入会让开局虚高 100。 */
function itemValues(items, prices, player) {
  const mine = mySlot(player);
  let slot = 0, stash = 0, wards = 0, dispenser = false;
  for (const [k, it] of Object.entries(items || {})) {
    if (!it || typeof it !== "object") continue;
    if (k.startsWith("neutral") || k.startsWith("preserved_neutral") || k.startsWith("teleport")) continue;
    if (notOwnedBy(it, mine)) continue;
    const name = (it.name || "").replace(/^item_/, "");
    // 眼架的价值等于里面装的眼，而 GSI 只给 charges:1，从不说装了什么。
    // 所以它不走物品价，由 EconTracker 单独跟踪，见 dispenserValue。
    if (name === "ward_dispenser") { dispenser = true; continue; }
    const cost = itemCost(it, prices);
    // 散装的眼要单独记：眼架合成的那一刻，它们的价值要平移进眼架
    if (name === "ward_sentry" || name === "ward_observer") wards += cost;
    if (k.startsWith("stash")) stash += cost; else slot += cost;
  }
  return { slot, stash, wards, dispenser };
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
 * **修饰符名会带来源后缀**，所以下面一律用前缀匹配，不能精确查表：炼金送的那根
 * 叫 modifier_item_ultimate_scepter_consumed_alchemist。精确匹配会让这一整类静默计 0，
 * 2026-09-14 观战对账实测每人少 4200。详见 design/networth.md。
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
      // **必须含普通神杖 `ultimate_scepter`**：它当物品拿着时本身不会变成 buff，
      // 所以"见过它 + buff 出现" = 升级成了祝福（5800）。只认祝福卷轴的话，
      // 买进储藏处就地合成、卷轴从没在物品栏出现过的那种，会退回 4200——
      // 2026-09-14 观战对账实测差 1600。详见 design/networth.md。
      items: ["ultimate_scepter", "ultimate_scepter_2", "ultimate_scepter_roshan",
              "recipe_ultimate_scepter_2"],
    },
  },
  { mods: ["modifier_item_moon_shard_consumed"], api: "moon_shard", constKey: "moonShardValue" },
];

/** 需要记进物品栏历史的物品名 */
const TRACKED_ITEMS = CONSUMED_BUFFS.flatMap(b => b.upgrade?.items ?? []);

/** buff 里有没有这几个修饰符之一。**按前缀比，不精确查表**——
    GSI 会给修饰符名加来源后缀（炼金送的神杖是 ..._consumed_alchemist）。
    这里前缀是安全的：..._scepter_consumed 不是 ..._scepter_2_consumed 的前缀，两档不会互吞。 */
function hasMod(buffs, mods) {
  const keys = Object.keys(buffs);
  return mods.some(m => keys.some(k => k.startsWith(m)));
}

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
    this.dispenserValue = 0;        // 眼架里装的眼值多少钱（GSI 不告诉我们，只能自己跟）
    this.seenBuys = new Set();      // 已处理过的购买事件，events 段会重复推送
    this.dispenserGone = null;      // 架子从什么时候开始看不见了（信使在送）
    this.prevWards = 0;             // 上一包散装眼的价值，用来接住"合成眼架"那一刻
    this.prevDispenser = false;
    this.prevGold = null;           // 上一包的金钱，用来把"卖出"和"被信使取走"分开
    this.prevTp = null;             // 传送槽充能数
    this.prevDeaths = null;         // 上一包的阵亡数，用来认出"系统白送的那张"
    this.prevShard = false;         // 上一包有没有魔晶，用来冲销吃掉时留下的在途账
    this.spend = [];                // 说不清去向的支出：钱花了、东西还没出现（见 noteSpend）
    this.lastBuyback = null;        // 最近一次自己买活的时刻，买活掉的钱不是花钱
    this.prevBase = null;           // 上一包的"非金钱资产"（不含 spend 账），给 noteSpend 做差用
    this.tpQueue = [];              // 每个充能是不是自己买的；用掉时先扣白送的
    this.boughtTp = 0;              // 其中自己花钱买的张数（由 tpQueue 派生）
    this.activeBuffs = new Set();   // 已经生效的吞噬类 buff
  }

  /** 某个吞噬 buff 当前该按多少钱计 */
  buffPrice(b, prices, C, buffs) {
    const up = b.upgrade;
    const byUpMod = !!up && hasMod(buffs, up.mods);
    const upgraded = byUpMod || (!!up && up.items.some(n => this.seenVariants.has(n)));
    return prices[upgraded ? up.api : b.api]?.cost ?? C[b.constKey] ?? 0;
  }

  /**
   * buff 刚出现的那一刻，把对应价值从"在途"账上冲销。
   * 因为物品被合成/吞噬时会从物品栏凭空消失，长得和"被信使取走"一模一样，
   * 不冲销的话这部分价值会既算进 buff、又挂在在途账上，重复计到超时为止。
   */
  noteBuffs(hero, prices, C) {
    const buffs = (hero || {}).permanent_buffs || {};
    for (const b of CONSUMED_BUFFS) {
      const active = hasMod(buffs, b.mods)
                     || (!!b.upgrade && hasMod(buffs, b.upgrade.mods));
      if (active && !this.activeBuffs.has(b.api)) {
        this.activeBuffs.add(b.api);
        this.deliver(this.buffPrice(b, prices, C, buffs));
      } else if (!active) {
        this.activeBuffs.delete(b.api);
      }
    }
  }

  /**
   * 传送卷轴：开局白送一张，**被英雄击杀时**还会再送一张，这些不计入官方净资产。
   * 但自己买的确实花了 100，要算。判据是**充能增加的这一包 `player.deaths` 涨没涨**。
   *
   * 早先用的是"充能增加时人是活的"。四局观战录制的 142 次充能增加表明
   * **`hero.alive` 比发放晚一包的有 14 次（约 10%）**，那一包还报着活着，
   * 于是判成自购、多算 100；`player.deaths` 一次都不晚。换判据后四局全量对账
   * 一致率 50.3→59.5 / 45.3→53.2 / 56.6→60.2 / 55.7→60.7，四局全赢。
   * `player.deaths` 自视角也有，且不从基线派生——这是它和上一次失败的
   * "基线掉 100"判据的本质区别，详见 docs/design/networth.md。
   *
   * 一包里涨多张又恰好阵亡时，这里把它们**全算白送**（宁可少算），
   * 与上面那组对账数字的口径一致。
   *
   * **用掉的先扣白送的那张。** 传送槽是个充能堆叠，用掉的那一张没有身份，
   * 只能靠对账反推。2026-09-08 快速局 8988706327 取七个点：全局只买过一张 TP，
   * 而官方净资产从买入那一刻起**一直算着这 100**，中间用掉过四张也没掉——
   * 只有"先扣白送"能产生这个行为。
   *
   * 早先短暂用过 FIFO，依据是另一局两个点里它 2/2、另两个模型 1/2。
   * 但**那次测量时还带着两个 bug**（消耗品叠加只算一份、眼架按固定价 50），
   * 它们各值 50~150，足以把那一个点判反。现在两个 bug 都修了，
   * 这局七个点里"先扣白送"全中、FIFO 中四个。
   */
  /**
   * 这一包是不是刚阵亡。**用 `player.deaths` 而不是 `hero.alive`**——后者比事实
   * 晚一包（142 次充能增加里有 14 次，见 `noteTp`）。阵亡这一刻金钱也会掉，
   * `noteSpend` 同样要靠它把"掉钱"和"花钱"分开。
   */
  noteDeaths(player) {
    const n = typeof player?.deaths === "number" ? player.deaths : null;
    const died = n !== null && this.prevDeaths !== null && n > this.prevDeaths;
    if (n !== null) this.prevDeaths = n;   // 漏字段时保持上一包，别误判成阵亡
    return died;
  }

  /**
   * 记下自己最近一次买活的时刻。
   *
   * **不能靠 `hero.alive` 挡买活**：买活的瞬间人就复活了，掉钱那一包 `alive`
   * 已经是 `true`。实测不挡的话，1789397873 的 slot9 买活共花 5376，
   * 终值偏差就正好炸出 5376。
   */
  noteBuyback(state, clock) {
    const mine = mySlot(state.player);
    if (mine === null || clock === null) return;
    for (const e of Object.values(state.events || {})) {
      if (!e || e.event_type !== "generic_event" || typeof e.data !== "string") continue;
      let d;
      try { d = JSON.parse(e.data); } catch { continue; }
      if (d.type === "CHAT_MESSAGE_BUYBACK" && d.playerid1 === mine) this.lastBuyback = clock;
    }
  }

  noteTp(items, died, clock) {
    const tp = (items || {}).teleport0;
    const ch = tp && tp.name === "item_tpscroll" ? (tp.charges ?? 1) : 0;
    if (this.prevTp === null) {
      this.tpQueue = Array(ch).fill(false);          // 首次见到的都算白送
    } else if (clock !== null && clock >= 0) {
      const d = ch - this.prevTp;
      for (let i = 0; i < d; i++) this.tpQueue.push(!died);
      for (let i = 0; i < -d; i++) {
        const free = this.tpQueue.indexOf(false);      // 先扣白送的
        this.tpQueue.splice(free >= 0 ? free : 0, 1);
      }
    }
    // 漏包会让队列和实际充能对不上，以实际为准；补进来的一律算白送，不虚高
    while (this.tpQueue.length > ch) this.tpQueue.shift();
    while (this.tpQueue.length < ch) this.tpQueue.unshift(false);
    this.boughtTp = this.tpQueue.filter(Boolean).length;
    this.prevTp = ch;
  }

  /**
   * 眼架里装了多少钱的眼。
   *
   * **GSI 对 `ward_dispenser` 永远只给 `charges: 1`**，装了几个眼、什么眼，
   * 一个字都不说。实测一局：22:47 买三个真眼合成眼架（150 金），26:27 又补一个
   * （200 金），而按表里的固定价 50 算，官方净资产比我们高 100~150。
   *
   * 能观测到的只有两件事，于是就靠这两件事推：
   *   · **合成的那一刻**散装的眼从物品栏消失 → 把它们的价值平移进眼架
   *   · **拿着眼架时再买眼**，新眼直接进架子、物品栏毫无变化 →
   *     只能靠 `CHAT_MESSAGE_ITEM_PURCHASE` 事件看见
   *
   * 插眼这一半**注定不精确**：minimap 的眼条目只有 `team`，没有玩家 id，
   * 也没有"插眼"事件——队友插的真眼和自己插的分不出来。所以这里按"我方插了真眼
   * 就扣"处理，扣到 0 为止。队友插眼会让我们少算，方向和修之前一样（偏保守），
   * 幅度不超过架子里的存货，且眼架一空就归零、不会跨局累积。
   * 假眼不用管，它本来就不要钱。
   */
  noteDispenser(state, prices, wards, dispenser, placedSentries, clock) {
    // **每一包都要把购买事件消费掉**，哪怕当时没有架子。只在有架子时才读，
    // 那些"合成之前买的眼"就会一直留在未处理集合里，等架子一出现被重新算一遍——
    // 于是价值既随物品平移进来、又被事件加一次，正好翻倍。
    const buys = myPurchases(state, prices, mySlot(state.player), this.seenBuys)
      .map(id => byId(prices, id));
    if (!dispenser) {
      // 架子会短暂消失：被信使拿走的十几秒里 GSI 完全看不见它（实测一次 10 秒）。
      // 立刻清零就把刚合成的价值丢了，所以给一段宽限；真的用完了，
      // 上面的插眼扣减本来也已经把它扣到 0。
      if (this.dispenserGone === null) this.dispenserGone = clock;
      if (clock !== null && clock - this.dispenserGone > DISPENSER_GRACE) this.dispenserValue = 0;
    } else {
      this.dispenserGone = null;
      if (!this.prevDispenser) this.dispenserValue += this.prevWards;   // 刚合成，价值平移
      for (const name of buys) {
        if (name === "ward_sentry" || name === "ward_observer")
          this.dispenserValue += prices[name]?.cost ?? 0;
      }
      const sentry = prices.ward_sentry?.cost ?? 50;
      this.dispenserValue = Math.max(0, this.dispenserValue - placedSentries * sentry);
    }
    this.prevWards = wards;
    this.prevDispenser = dispenser;
  }

  /** 记下见过哪件升级物品——神杖和祝福可能共用 buff 名，靠这个区分 4200 还是 5800 */
  noteVariants(items) {
    for (const it of Object.values(items || {})) {
      if (!it || typeof it !== "object") continue;
      const n = (it.name || "").replace(/^item_/, "");
      if (TRACKED_ITEMS.includes(n)) this.seenVariants.add(n);
    }
  }

  update(state, prices, C, clock, placedSentries = 0) {
    const { slot, stash, wards, dispenser } = itemValues(state.items, prices, state.player);
    const gold = (state.player || {}).gold ?? 0;
    const goldBefore = this.prevGold;   // 下面会把 prevGold 覆盖掉，noteSpend 要的是这个
    this.noteDispenser(state, prices, wards, dispenser, placedSentries, clock);
    this.noteVariants(state.items);
    const died = this.noteDeaths(state.player);
    this.noteBuyback(state, clock);
    this.noteTp(state.items, died, clock);

    // 号角前 clock_time 不单调（选人/策略阶段先倒计时一轮，再重置到 -90 数到 0），
    // 用它算超时不成立；换局重开同理。这两种情况下只记录状态，不做在途推断。
    if (clock === null || clock < 0 || (this.lastClock !== null && clock < this.lastClock - 5)) {
      this.transit = [];
      this.spend = [];
      this.prevBase = null;
      this.prevSlot = slot;
      this.prevStash = stash;
      this.prevGold = gold;
      this.lastClock = clock;
      return this.total(state, prices, C, slot, stash);
    }
    this.lastClock = clock;

    if (this.prevStash !== null) {
      const lost = this.prevStash - stash;      // 储藏处减少的价值
      const gained = slot - this.prevSlot;      // 装备栏增加的价值
      if (lost > 0 && gained < lost && !soldFromStash(lost, gold - this.prevGold)) {
        this.transit.push({ v: lost - Math.max(0, gained), at: clock });
      } else if (gained > 0) {
        this.deliver(gained);                   // 装备栏变多 = 在途的东西到货了
      }
      this.transit = this.transit.filter(t => clock - t.at < TRANSIT_TTL);
    }
    this.prevSlot = slot;
    this.prevStash = stash;
    this.prevGold = gold;
    this.noteBuffs(state.hero, prices, C);
    this.noteShard(state.hero, prices, C);
    const out = this.total(state, prices, C, slot, stash);
    this.noteSpend(out, gold, goldBefore, clock, died, state.hero);
    return out;
  }

  /**
   * 说不清去向的支出：**钱花了，而我们能看见的资产一点没多。**
   *
   * 两种真实情况会这样，自视角下形状完全相同：
   *
   * 1. **买了但东西还没出现。** 在外面买东西，金钱立刻扣，而物品要过几十秒才
   *    出现在储藏处——实测 matchid 9006189153 的 slot4：29:19 花掉 2000，
   *    30:16 才出现 `stash0:lesser_crit`，**整整 57 秒**。官方从掏钱那一刻就算着。
   * 2. **买了给队友带。** 官方按 `purchaser` 算在买方头上，而 GSI 只给我们各人
   *    自己物品栏里的东西——买方这边东西压根不会出现。slot8 买 900 的真视宝石
   *    给 slot7 带，三段共 620 秒一直低 900。
   *
   * 两种共用一套账：东西出现时冲销（第 1 种），不出现就一直留着（第 2 种，
   * **而官方也一直算着，所以留着才是对的**）。因此这本账**不设 TTL**——
   * 与信使在途那本不同，那本的前提是"东西一定会到"。
   *
   * **必须挡住阵亡**：死了也会掉钱，那不是花钱。用 `player.deaths` 判，
   * 不用 `hero.alive`（后者晚一包，正好错过掉钱那一刻）。
   */
  noteSpend(out, gold, goldBefore, clock, died, hero) {
    const ledger = this.spend.reduce((a, t) => a + t.v, 0);
    const base = out.networth - gold - ledger;      // 不含金钱、也不含这本账的资产
    const prev = this.prevBase;
    this.prevBase = base;
    if (prev === null || goldBefore === null) return;
    const got = base - prev;                        // 资产侧多了多少
    if (got > 0) this.deliverSpend(got);            // 东西出现了，冲销掉对应的那笔
    // 死着的时候不记账：阵亡会掉钱，**买活更会**——而买活的钱官方不算
    // （实测 1789397873 的 slot9 买活共 5376，正是不挡时终值炸出来的那个数）。
    // 阵亡那一包用 deaths 判（alive 晚一包，正好错过掉钱那一刻），
    // 之后整段死亡期用 alive 判（这时它已经不滞后了）。
    if (died || hero?.alive === false) return;
    if (this.lastBuyback !== null && clock - this.lastBuyback <= BUYBACK_GRACE) return;
    const spent = goldBefore - gold;
    const missing = spent - Math.max(0, got);
    if (spent >= SPEND_MIN && missing >= SPEND_MIN) this.spend.push({ v: missing, at: clock });
    out.networth = out.networth - ledger + this.spend.reduce((a, t) => a + t.v, 0);
  }

  /** 东西终于出现了，按先进先出冲销这本账。 */
  deliverSpend(value) {
    for (const t of this.spend) {
      const d = Math.min(t.v, value);
      t.v -= d; value -= d;
      if (value <= 0) break;
    }
    this.spend = this.spend.filter(t => t.v > 0);
  }

  /**
   * 魔晶吃掉的那一刻，把它从在途账里冲销掉。
   *
   * 买来的魔晶先在物品栏里待十几到二十秒，吃掉时**从物品栏消失而金币不动**——
   * 这正是"被信使取走"的形状，于是被记成在途；同时 `hero.aghanims_shard` 翻真，
   * `total()` 又加一次 1400。**重复计，直到在途账 90 秒 TTL 到期。**
   *
   * 2026-09-20 在 matchid 9006189153 里三例全中，起止精确到秒：
   * slot3 物品 22:49 消失 / 标志 23:03 / 虚高到 24:18（22:49+90 = 24:19）·
   * slot7 25:24 / 25:41 / 26:54（= 25:24+90）· slot0 28:05 / 28:28 / 29:34（= 28:05+90）。
   *
   * 吞噬类 buff 早就在 `noteBuffs` 里这么冲销了；魔晶不走 `CONSUMED_BUFFS`
   * （它是 `total()` 里单独加的），所以一直漏掉。
   */
  noteShard(hero, prices, C) {
    const has = !!(hero || {}).aghanims_shard;
    if (has && !this.prevShard) this.deliver(shardValue(prices, C));
    this.prevShard = has;
  }

  total(state, prices, C, slot, stash) {
    const p = state.player || {}, h = state.hero || {};
    const inTransit = this.transit.reduce((a, t) => a + t.v, 0);
    let nw = (p.gold ?? 0) + slot + stash + inTransit + this.dispenserValue
           + this.spend.reduce((a, t) => a + t.v, 0)
           + this.boughtTp * (prices.tpscroll?.cost ?? 100);
    if (h.aghanims_shard) nw += shardValue(prices, C);
    const buffs = h.permanent_buffs || {};
    for (const b of CONSUMED_BUFFS) {
      const up = b.upgrade;
      // 门槛只看 buff 是否真的存在。物品栏历史仅用于决定价格档次——
      // 若拿它当"buff 已生效"的依据，卷轴还在包里时会物品价和 buff 价重复计。
      const byMod = hasMod(buffs, b.mods);
      const byUpMod = !!up && hasMod(buffs, up.mods);
      if (!byMod && !byUpMod) continue;
      nw += this.buffPrice(b, prices, C, buffs);
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
