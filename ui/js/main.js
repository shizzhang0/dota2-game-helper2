import { connectSource, onAltChange, isTauri } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
import { loadConstants, computeTimers } from "./timers.js";
import { EventTracker, loadTowers } from "./events.js";
import { loadPrices, EconTracker } from "./networth.js";
import { initPanel, render, enableDrag, applyLayout } from "./render.js";

const pool = new CachePool(), match = new MatchTracker(), econ = new EconTracker();
let tracker = null, C = null, alt = false, last = null, editMode = false, forceShow = false;

initPanel(document.getElementById("panel"));
const towers = await loadTowers();
const prices = await loadPrices();

// ── 面板位置：Tauri 存配置文件，浏览器开发时存 localStorage ──
async function loadLayout() {
  try {
    if (isTauri()) return JSON.parse(await window.__TAURI__.core.invoke("load_layout"));
    return JSON.parse(localStorage.getItem("layout") || "{}");
  } catch { return {}; }
}
function saveLayout(pos) {
  const s = JSON.stringify(pos);
  if (isTauri()) window.__TAURI__.core.invoke("save_layout", { layout: s });
  else localStorage.setItem("layout", s);
}
applyLayout(await loadLayout());
enableDrag(saveLayout);

if (isTauri()) window.__TAURI__.event.listen("edit", (e) => { editMode = e.payload === true; });

connectSource(async (pkt) => {
  const st = pool.update(pkt);
  const info = match.update(st);
  if (info.newMatch) pool.reset();
  C = await loadConstants(info.modeOrDefault);
  if (!tracker || info.newMatch) tracker = new EventTracker(C, towers);
  tracker.C = C;                       // 模式判定完成后热切常数
  tracker.update(pkt, st, info);
  if (info.newMatch) econ.reset();
  last = { st, info, econ: econ.update(st, prices, C, info.clock) };
});

onAltChange((d) => { alt = d; });

setInterval(() => {
  if (!last) return;
  const { st, info } = last;
  const e = last.econ;
  render({
    visible: (alt || forceShow || editMode) && (info.inMatch || forceShow || editMode),
    editMode,
    timers: C ? computeTimers(info.clock, C) : [],
    glyph: tracker ? tracker.enemyGlyph(info) : { ready: true, remaining: 0 },
    buybacks: tracker ? tracker.enemyBuybacks(info) : [],
    enemyBase: info.myTeam === 2 ? 5 : 0,
    econ: e,
  });
  const hud = document.getElementById("hud");
  if (hud) hud.textContent =
    `${info.matchid} clock=${info.clock} ${info.mode} team=${info.myTeam} in=${info.inMatch}` +
    ` nw=${e.networth} gpm=${e.gpm}`;
}, 250);

// 开发快捷键：v 常显、e 编辑态（Tauri 下由全局热键控制编辑态）
addEventListener("keydown", (ev) => {
  if (!document.body.classList.contains("dev")) return;
  if (ev.key === "v") forceShow = !forceShow;
  if (ev.key === "e") editMode = !editMode;
});
