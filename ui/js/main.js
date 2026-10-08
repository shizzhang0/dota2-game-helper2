import { connectSource, onAltChange, isTauri } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
import { loadConstants, computeTimers } from "./timers.js";
import { EventTracker, loadTowers } from "./events.js";
import { loadPrices, EconTracker } from "./networth.js";
import { initPanel, render } from "./render.js";
import { WardTracker, deadTowers } from "./minimap.js";
import { loadSettings, saveSettings, onSettingsChange } from "./settings.js";
import { initEditor, setEditorOpen } from "./editor.js";
import { checkUpdate } from "./update.js";
import { readDotaHud, minimapOpts } from "./dotahud.js";

// 正式版没有控制台也开不出 devtools，前端异常必须转发给 Rust 写进日志
const send = (lv, m) => {
  if (!isTauri()) return;
  try {
    window.__TAURI__.core.invoke("log_front", { level: lv, msg: String(m) });
  } catch { /* 日志本身绝不能把主流程带崩 */ }
};
if (isTauri()) {
  addEventListener("error", e => send("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", e => send("error", e.reason?.stack || e.reason));
}

const pool = new CachePool(), match = new MatchTracker(), econ = new EconTracker();
let tracker = null, C = null, alt = false, last = null, editMode = false;
let wards = null;
let lastAt = 0;              // 上一包到达的墙钟时间，用来判断 GSI 是不是断了
// Dota 自己的 HUD 设置：启动时读一次，之后每局开始再读（见 dotahud.js）
readDotaHud();

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
await initEditor(document.getElementById("editor"), exitEdit);
// 启动时静默查一次新版本，结果只显示在开发页的版本号旁边。不等它：
// 连不上要等满超时，而覆盖层不该因此晚一步出来（只在 Tauri 里查，见 update.js）
checkUpdate();
// 不判断 editMode：锁定态窗口穿透且没有焦点，压根收不到 keydown，
// 只有编辑态才会走到这里；靠本地状态位反而可能因事件漏收而彻底失灵。
addEventListener("keydown", (ev) => { if (ev.key === "Escape") exitEdit(); });

connectSource(async (pkt) => {
  const st = pool.update(pkt);
  const info = match.update(st);
  if (info.newMatch) { pool.reset(); readDotaHud(); }
  C = await loadConstants(info.modeOrDefault);
  if (!tracker || info.newMatch) tracker = new EventTracker(C, towers);
  tracker.C = C;                       // 模式判定完成后热切常数
  tracker.update(pkt, st, info);
  if (!wards || info.newMatch) wards = new WardTracker(C);
  wards.C = C;
  wards.update(st, info);
  if (info.newMatch) econ.reset();
  // **游戏结束后净资产定格在结束那一包**（2026-10-09）。遗迹倒下、状态变成 POST_GAME 之后，
  // Dota 还会接着往金钱里加（时钟已经停了），GSI 照推——m9035205154 里结束后十几包
  // 从 9017 涨到 9069，而结算画面 / OpenDota 定格在 9015。不停住的话，赛后进编辑态
  // 对账看到的就是一路涨上去的数。只算结束的第一包，之后沿用它；
  // 包大约 2 秒一个，和结算值会差几块（那一局差 2）。
  const ended = info.gameState === "DOTA_GAMERULES_STATE_POST_GAME";
  const frozen = ended && last?.info.gameState === "DOTA_GAMERULES_STATE_POST_GAME"
                 && last.info.matchid === info.matchid;
  // 插眼数要在 wards.update 之后取：净资产靠它把眼架里的存货扣掉
  last = { st, info, econ: frozen ? last.econ
                                  : econ.update(st, prices, C, info.clock, wards.newOwnSentries) };
  lastAt = Date.now();
});

// **只在真的变化时才记日志。** Rust 那边每秒会无条件重发一次当前状态
// （见 `altkey.rs` 的失步自愈），不过滤的话日志一秒一条。
// debug 级，默认的 info 下不落盘；真遇上"Alt 变成切换键"再把级别调到 debug 看这条。
onAltChange((d) => {
  if (d !== alt) send("debug", `[alt] ${alt} -> ${d}`);
  alt = d;
});

// 没有 GSI 数据时的占位，用于编辑态——调设置、看位置对不对，恰恰要在开游戏之前做，
// 若等到有数据才渲染，没开 Dota 时面板根本不出现。
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
  // 断流就藏起来：宁可不显示，也不要显示一份冻结的旧数据（见 STALE_MS）。
  // **只藏面板，不换数据**：原先换成空的 IDLE，而各个 tracker 不跟着清，结果只有净资产
  // 归零、其余停在最后一刻，编辑态里看到半份 0 半份旧值；对账要看的正是最后那个净资产。
  // 不重置 tracker——数据回来时若还是同一局，接着算就是了；换局了 `newMatch` 自然会重置。
  // `HELPER2_FREEZE` 只有截图页面会设：切片"播完就停在最后一包"是故意的，不是断流。
  // 不挡的话截图那一刻面板早已藏起来，截出来一片空白（tools/make_shots.py）。
  const stale = !window.HELPER2_FREEZE && last !== null
             && Date.now() - lastAt > (last.info.paused ? STALE_PAUSED_MS : STALE_MS);
  const cur = last || IDLE;
  const { st, info } = cur;
  const e = cur.econ;
  render({
    // 「始终显示」**不绕过 inMatch**：勾了它也只在对局中显示，主菜单里照样消失——
    // 它的意思是"把按住 Alt 这个条件去掉"，不是"永远杵在桌面上"。
    // 编辑态则要绕过，调设置这件事恰恰要在开游戏之前做；断流时同理，编辑态里照样看得到最后一刻。
    visible: editMode || ((alt || cfg.alwaysShow) && info.inMatch && !stale),
    editMode,
    timers: C ? computeTimers(info.clock, C) : [],
    glyph: tracker ? tracker.enemyGlyph(info) : { ready: true, remaining: 0 },
    buybacks: tracker ? tracker.buybacks(info) : [],
    myTeam: info.myTeam,
    econ: e,
    settings: cfg,
    wardmap: wards ? { wards: wards.list(info), dead: deadTowers(st, towers) } : null,
    minimap: minimapOpts(cfg),
  });
  const hud = document.getElementById("hud");
  if (hud) hud.textContent =
    `${info.matchid} clock=${info.clock} ${info.mode} team=${info.myTeam} in=${info.inMatch}` +
    ` nw=${e.networth} gpm=${e.gpm}`;
}, 250);

// 开发快捷键：和正式版同一套热键——Ctrl+Alt+F11 始终显示、Ctrl+Alt+F10 编辑态，
// v / e 是简写。**v 改的就是卡片上那个「始终显示」**，不另起一份状态——原先是独立的
// forceShow，两者互不知道。见 design/overlay.md「只有一个值，卡片要跟着它变」。
//
// **只在带 body.dev 的开发页生效**（index.html 没有它）：Tauri 里这两个热键由 Rust 注册成
// 全局热键，编辑态下 webview 有焦点也会收到同一个按键，这里再切一次就等于没切。
// 项目主页的 demo 也不带，那里只该有 Alt。
addEventListener("keydown", (ev) => {
  if (!document.body.classList.contains("dev")) return;
  const hot = ev.ctrlKey && ev.altKey;
  const toggleShow = hot ? ev.key === "F11" : ev.key === "v" && !ev.ctrlKey && !ev.altKey;
  const toggleEdit = hot ? ev.key === "F10" : ev.key === "e" && !ev.ctrlKey && !ev.altKey;
  if (toggleShow || toggleEdit) ev.preventDefault();   // F11 在浏览器里是全屏
  if (toggleShow) saveSettings({ ...cfg, alwaysShow: !cfg.alwaysShow });
  if (toggleEdit) applyEdit(!editMode);
});
