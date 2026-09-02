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

/** 把物品栏拆成"装备栏价值 / 储藏处价值"。中立物品不花钱；传送槽每局白送一个 TP。 */
function itemValues(items, prices) {
  let slot = 0, stash = 0;
  for (const [k, it] of Object.entries(items || {})) {
    if (!it || typeof it !== "object") continue;
    if (k.startsWith("neutral") || k.startsWith("preserved_neutral") || k.startsWith("teleport")) continue;
    const n = it.name;
    if (!n || n === "empty") continue;
    const cost = prices[n.replace(/^item_/, "")]?.cost || 0;
    if (k.startsWith("stash")) stash += cost; else slot += cost;
  }
  return { slot, stash };
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
  reset() { this.prevSlot = null; this.prevStash = null; this.transit = []; }

  update(state, prices, C, clock) {
    const { slot, stash } = itemValues(state.items, prices);

    if (this.prevStash !== null && clock !== null) {
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

    const p = state.player || {}, h = state.hero || {};
    const inTransit = this.transit.reduce((a, t) => a + t.v, 0);
    let nw = (p.gold ?? 0) + slot + stash + inTransit;
    if (h.aghanims_shard) nw += C.aghsShardValue ?? 0;
    if (h.permanent_buffs && "modifier_item_ultimate_scepter_consumed" in h.permanent_buffs) {
      nw += C.aghsScepterValue ?? 0;
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
