import { connectSource, onToggleHide, onDotaFront, isTauri } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
import { loadConstants, computeTimers } from "./timers.js";
import { EventTracker, loadTowers } from "./events.js";
import { loadPrices, EconTracker } from "./networth.js";
import { initPanel, render } from "./render.js";
import { WardTracker, deadTowers } from "./minimap.js";
import { loadSettings, onSettingsChange } from "./settings.js";
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
let tracker = null, C = null, last = null, editMode = false;
// 临时隐藏（Ctrl+Alt+F11）：只在内存里，换下一局、重启程序都自动恢复显示
let hidden = false;
// Dota 在不在前台（2026-10-15）：切到别的程序时面板收起，切回来再出现。见 foreground.rs
let dotaFront = true;
let wards = null;
let lastAt = 0;              // 上一包到达的墙钟时间，用来判断 GSI 是不是断了
// Dota 自己的 HUD 设置：启动时读一次，之后每局开始再读（见 dotahud.js）
readDotaHud();

// **断流多久算断。** Dota 崩了、被关掉、或者网络断了之后不会有任何通知，
// `last` 会一直留着最后一包——覆盖层仍然显示一份**冻结**的旧面板：
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

/** 主菜单的包：没有 map、player 是空对象（和 record.rs 的 is_menu 同一判法）。 */
function isMenu(pkt) {
  const p = pkt.player;
  return pkt.map === undefined && p !== null && typeof p === "object" && !Array.isArray(p)
         && Object.keys(p).length === 0;
}

// **一包处理完再处理下一包**（2026-10-15）。回调里有 await（loadConstants），Tauri 事件和 SSE
// 又是来一包调一次、不等上一次——上一包卡在 await 上时下一包先跑完，而两包手里的 st
// 是池子里同一个对象，tracker 拿到的就是后一包的状态，顺序也乱了。
// 串成一条链：每包排在上一包后面。返回值就是这一包处理完的 promise，
// source.js 回放预热那边的 await 照样等得到。出错只断这一包，不断整条链
let queue = Promise.resolve();
connectSource((pkt) => (queue = queue.then(() => onPacket(pkt)).catch((e) => {
  console.error("[main] 处理一包时出错:", e);
  send("error", e?.stack || e);
})));

async function onPacket(pkt) {
  // **回到主菜单就退回待机**（2026-10-15）。原先这种包照常进池子：池子守着空对象不覆盖，
  // 留着上一局的 map，inMatch 按旧的 game_state 算成"还在打"，而主菜单每 30 秒一次的心跳
  // 又不停刷新 lastAt——面板挂着旧数据迟迟不消失；最后一包若是暂停态（STALE_PAUSED_MS 40 秒
  // 长于心跳），就一直挂到下一局。
  // 只把 inMatch 改成 false，不清数据：编辑态里照样看得到最后一刻（同断流，见下面 setInterval）；
  // 池子和 tracker 也不清——重连回同一局接着算，换局了 newMatch 自然会重置
  if (isMenu(pkt)) {
    if (last) last = { ...last, info: { ...last.info, inMatch: false } };
    lastAt = Date.now();
    return;
  }
  let st = pool.update(pkt);
  const info = match.update(st);
  // 换局要**重新取一次 st**：update 返回的是池子里那个对象的引用，reset 只是把池子换成新对象，
  // 手里的 st 还指着上一局的合并状态；新局第一包的空 items/hero 又被池子的空对象守卫挡住，
  // 不重取的话刚重置的净资产和新建的眼位会拿上一局的装备、眼位初始化
  if (info.newMatch) { pool.reset(); st = pool.update(pkt); readDotaHud(); hidden = false; }
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
}

onToggleHide(() => { hidden = !hidden; send("info", `[hide] 临时隐藏 = ${hidden}`); });
onDotaFront((v) => { dotaFront = v; });

// 没有 GSI 数据时的占位，用于编辑态——调设置、看位置对不对，恰恰要在开游戏之前做，
// 若等到有数据才渲染，没开 Dota 时面板根本不出现。
const IDLE = {
  st: {},
  info: { matchid: null, clock: null, gameState: null, inMatch: false, spectating: false,
          myTeam: null, mode: null, modeOrDefault: "turbo", paused: false, newMatch: false },
  econ: { networth: 0, gpm: 0, xpm: 0 },
};

setInterval(() => {
  // 主页 demo 预热时不刷新：状态正从开局一路追到要播的那一刻，画出来就是数字乱跳（见 source.js）
  if (window.HELPER2_WARMING) return;
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
    // **对局中一直显示**（2026-10-14 起；原先有「按住 Alt 才显示」可选，连同 Alt 检测一起去掉了）。
    // 不绕过 inMatch：主菜单里照样消失，不会杵在桌面上。Ctrl+Alt+F11 可以临时收起。
    // 编辑态则要绕过，调设置这件事恰恰要在开游戏之前做；断流时同理，编辑态里照样看得到最后一刻。
    // 切到别的程序（Dota 不在前台）也收起：后台照样推包，不挡的话面板压在浏览器、桌面上（2026-10-15）。
    visible: editMode || (info.inMatch && !stale && !hidden && dotaFront),
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

// 开发快捷键：和正式版同一套热键——Ctrl+Alt+F11 临时隐藏、Ctrl+Alt+F10 编辑态，v / e 是简写。
//
// **只在带 body.dev 的开发页生效**（index.html 没有它）：Tauri 里这两个热键由 Rust 注册成
// 全局热键，编辑态下 webview 有焦点也会收到同一个按键，这里再切一次就等于没切。
// 项目主页的 demo 也不带。
addEventListener("keydown", (ev) => {
  if (!document.body.classList.contains("dev")) return;
  const hot = ev.ctrlKey && ev.altKey;
  const toggleShow = hot ? ev.key === "F11" : ev.key === "v" && !ev.ctrlKey && !ev.altKey;
  const toggleEdit = hot ? ev.key === "F10" : ev.key === "e" && !ev.ctrlKey && !ev.altKey;
  if (toggleShow || toggleEdit) ev.preventDefault();   // F11 在浏览器里是全屏
  if (toggleShow) hidden = !hidden;
  if (toggleEdit) applyEdit(!editMode);
});
