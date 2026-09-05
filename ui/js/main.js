import { connectSource, onAltChange, isTauri } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
import { loadConstants, computeTimers } from "./timers.js";
import { EventTracker, loadTowers } from "./events.js";
import { loadPrices, EconTracker } from "./networth.js";
import { initPanel, render, enableDrag, applyLayout } from "./render.js";
import { WardTracker, deadTowers } from "./minimap.js";
import { loadSettings, onSettingsChange } from "./settings.js";
import { initEditor, setEditorOpen } from "./editor.js";

// 正式版没有控制台也开不出 devtools，前端异常必须转发给 Rust 写进日志
if (isTauri()) {
  const send = (lv, m) =>
    window.__TAURI__.core.invoke("log_front", { level: lv, msg: String(m) });
  addEventListener("error", e => send("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", e => send("error", e.reason?.stack || e.reason));
}

const pool = new CachePool(), match = new MatchTracker(), econ = new EconTracker();
let tracker = null, C = null, alt = false, last = null, editMode = false, forceShow = false;
let wards = null;

const towers = await loadTowers();
const prices = await loadPrices();
let cfg = await loadSettings();
onSettingsChange(v => { cfg = v; });
initPanel(document.getElementById("panel"), towers);

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

function applyEdit(on) {
  editMode = on;
  setEditorOpen(on);
}
if (isTauri()) window.__TAURI__.event.listen("edit", (e) => applyEdit(e.payload === true));

// 退出编辑态。不能用全局热键做 ESC——set_edit 会从热键回调里被调用，
// 在回调里再动热键注册会死锁。这里走前端，「完成」按钮不依赖焦点，最可靠。
function exitEdit() {
  applyEdit(false);
  if (isTauri()) window.__TAURI__.core.invoke("exit_edit");
}
await initEditor(document.getElementById("editor"), document.getElementById("panel"), exitEdit);
// 不判断 editMode：锁定态窗口穿透且没有焦点，压根收不到 keydown，
// 只有编辑态才会走到这里；靠本地状态位反而可能因事件漏收而彻底失灵。
addEventListener("keydown", (ev) => { if (ev.key === "Escape") exitEdit(); });

connectSource(async (pkt) => {
  const st = pool.update(pkt);
  const info = match.update(st);
  if (info.newMatch) pool.reset();
  C = await loadConstants(info.modeOrDefault);
  if (!tracker || info.newMatch) tracker = new EventTracker(C, towers);
  tracker.C = C;                       // 模式判定完成后热切常数
  tracker.update(pkt, st, info);
  if (!wards || info.newMatch) wards = new WardTracker(C);
  wards.C = C;
  wards.update(st, info);
  if (info.newMatch) econ.reset();
  last = { st, info, econ: econ.update(st, prices, C, info.clock) };
});

onAltChange((d) => { alt = d; });

// 没有 GSI 数据时的占位，用于编辑态摆位置——调位置这件事恰恰要在开游戏之前做，
// 若等到有数据才渲染，没开 Dota 时面板根本不出现，也就无从拖动。
const IDLE = {
  st: {},
  info: { matchid: null, clock: null, gameState: null, inMatch: false,
          myTeam: null, mode: null, modeOrDefault: "turbo", paused: false, newMatch: false },
  econ: { networth: 0, gpm: 0, xpm: 0 },
};

setInterval(() => {
  // 不要在这里提前 return：退出编辑态时若恰好没有 GSI 数据，
  // render 就再也不会被调用，面板会永远停在编辑态的样子上。
  // 有 IDLE 占位，照常渲染即可（visible 自然算成 false，面板隐藏）。
  const { st, info } = last || IDLE;
  const e = (last || IDLE).econ;
  render({
    visible: (alt || forceShow || editMode) && (info.inMatch || forceShow || editMode),
    editMode,
    timers: C ? computeTimers(info.clock, C) : [],
    glyph: tracker ? tracker.enemyGlyph(info) : { ready: true, remaining: 0 },
    buybacks: tracker ? tracker.enemyBuybacks(info) : [],
    enemyBase: info.myTeam === 2 ? 5 : 0,
    econ: e,
    settings: cfg,
    wardmap: wards ? { wards: wards.list(info), dead: deadTowers(st, towers) } : null,
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
  if (ev.key === "e") applyEdit(!editMode);
});
