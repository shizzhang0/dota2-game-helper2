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

export function computeEcon(state, prices, C) {
  const p = state.player || {}, h = state.hero || {}, items = state.items || {};
  let nw = p.gold ?? 0;
  for (const [slot, it] of Object.entries(items)) {
    if (!it || typeof it !== "object") continue;
    if (slot.startsWith("neutral") || slot.startsWith("preserved_neutral")) continue;
    const name = it.name;
    if (!name || name === "empty") continue;
    nw += prices[name.replace(/^item_/, "")]?.cost || 0;
  }
  if (h.aghanims_shard) nw += C.aghsShardValue;
  if (h.permanent_buffs && "modifier_item_ultimate_scepter_consumed" in h.permanent_buffs)
    nw += C.aghsScepterValue;
  return { networth: nw, gpm: p.gpm ?? 0, xpm: p.xpm ?? 0 };
}
