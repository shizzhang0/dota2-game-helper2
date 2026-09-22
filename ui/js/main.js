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
let lastAt = 0;              // 上一包到达的墙钟时间，用来判断 GSI 是不是断了

// **断流多久算断。** Dota 崩了、被关掉、或者网络断了之后不会有任何通知，
// `last` 会一直留着最后一包——按住 Alt 仍然显示一份**冻结**的旧面板：
// 倒计时不动、净资产不动，而它看起来和正常面板一模一样，比不显示更坏。
//
// 阈值要分两档，因为 GSI 配置里 `heartbeat` 是 **30 秒**（见 `gsicfg.rs`）：
//   · 没暂停时 `clock_time` 每秒都在变，`throttle 0.1` 下包是连着来的，
//     5 秒没包必然是断了
//   · **暂停时什么都不变**，GSI 就只剩心跳，30 秒才推一次——
//     用 5 秒判会把正常的暂停误判成断流，把面板关掉
const STALE_MS = 5000;
const STALE_PAUSED_MS = 40000;

const towers = await loadTowers();
const prices = await loadPrices();
let cfg = await loadSettings();
onSettingsChange(v => { cfg = v; });
initPanel(document.getElementById("panel"), towers);

// ── 面板位置：Tauri 存配置文件，浏览器开发时存 localStorage ──
async function loadLayout() {
  let raw = null;
  try {
    raw = isTauri() ? JSON.parse(await window.__TAURI__.core.invoke("load_layout"))
                    : JSON.parse(localStorage.getItem("layout") || "{}");
  } catch { raw = null; }
  // 老格式是整块面板的单坐标 {x, y}。沿用为 timers 的位置，其余三块取默认值——
  // 不迁的话用户已经摆好的位置会直接丢。
  if (raw && typeof raw.x === "number") return { timers: { x: raw.x, y: raw.y } };
  return raw;
}
function saveLayout(all) {
  const s = JSON.stringify(all);
  if (isTauri()) window.__TAURI__.core.invoke("save_layout", { layout: s });
  else localStorage.setItem("layout", s);
}
const savedLayout = await loadLayout();
let layout = applyLayout(savedLayout, cfg.scale ?? 1);
// 迁移与钳位的结果要落盘，否则每次启动都要重算一遍。但只在结果确实变了时才写——
// applyLayout 返回 null 表示视口还没量出来、这次没摆，那更不能写。
if (layout && JSON.stringify(layout) !== JSON.stringify(savedLayout)) saveLayout(layout);
enableDrag((id, pos) => { layout[id] = pos; saveLayout(layout); });

// 视口尺寸变了要重新钳位（换分辨率、拔掉副屏）；同时兜住"启动时视口还没量出来"，
// 那种情况下上面这次 applyLayout 什么都没做，得靠这里补上。
addEventListener("resize", () => {
  const next = applyLayout(layout || savedLayout, cfg.scale ?? 1);
  if (!next) return;
  const changed = JSON.stringify(next) !== JSON.stringify(layout);
  layout = next;
  if (changed) saveLayout(layout);
});

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
// 四块独立可拖之后，把某块拖丢是真会发生的事（虽然有钳位兜底）。这是显式的复位入口。
// scale 由调用方传入：卡片刚把设置存下去，cfg 要等 settings 事件回来才更新。
function resetLayout(scale = cfg.scale ?? 1) {
  const next = applyLayout(null, scale);
  if (!next) return;                     // 视口没准备好，别把负坐标写进去
  layout = next;
  saveLayout(layout);
}
await initEditor(document.getElementById("editor"), exitEdit, resetLayout);
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
  // 插眼数要在 wards.update 之后取：净资产靠它把眼架里的存货扣掉
  last = { st, info, econ: econ.update(st, prices, C, info.clock, wards.newOwnSentries) };
  lastAt = Date.now();
});

onAltChange((d) => { alt = d; });

// 没有 GSI 数据时的占位，用于编辑态摆位置——调位置这件事恰恰要在开游戏之前做，
// 若等到有数据才渲染，没开 Dota 时面板根本不出现，也就无从拖动。
const IDLE = {
  st: {},
  info: { matchid: null, clock: null, gameState: null, inMatch: false, spectating: false,
          myTeam: null, mode: null, modeOrDefault: "turbo", paused: false, newMatch: false },
  econ: { networth: 0, gpm: 0, xpm: 0 },
};

setInterval(() => {
  // 不要在这里提前 return：退出编辑态时若恰好没有 GSI 数据，
  // render 就再也不会被调用，面板会永远停在编辑态的样子上。
  // 有 IDLE 占位，照常渲染即可（visible 自然算成 false，面板隐藏）。
  // 断流就退回待机：宁可不显示，也不要显示一份冻结的旧数据（见 STALE_MS）。
  // 只是不渲染，**不重置各个 tracker**——数据回来时若还是同一局，接着算就是了；
  // 换局了 `newMatch` 自然会触发重置。
  const stale = last !== null
             && Date.now() - lastAt > (last.info.paused ? STALE_PAUSED_MS : STALE_MS);
  const cur = stale ? IDLE : (last || IDLE);
  const { st, info } = cur;
  const e = cur.econ;
  render({
    // 「始终显示」**不绕过 inMatch**：勾了它也只在对局中显示，主菜单里照样消失——
    // 它的意思是"把按住 Alt 这个条件去掉"，不是"永远杵在桌面上"。
    // 编辑态则要绕过，摆位置这件事恰恰要在开游戏之前做。
    // 开发页的 forceShow（v 键）保留绕过，那是开发时要的。
    visible: (alt || cfg.alwaysShow || forceShow || editMode)
          && (info.inMatch || forceShow || editMode),
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
