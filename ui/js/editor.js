import { SHOW_KEYS, DEFAULTS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";
import { icon, CELL_ICON } from "./icons.js";
import { t, loadLang, LANGS } from "./i18n.js";

// 编辑态的设置卡片。与 .block 平级而非其子节点——块受 --panel-scale 缩放，
// 卡片跟着缩到 2× 或 0.8× 都没法用。
//
// 卡片自己也能拖，但**只能靠顶部标题栏**：拖拽要 setPointerCapture，
// 而它会把 pointerup 改派到捕获元素，click 便落不到内部的按钮上。
// 整块可拖会打死「完成」按钮、九个复选框、三个滑块和两个下拉框——
// 「完成」失效等于编辑态出不去。见 design/overlay.md 的第 3 号坑。
let card = null, doneCb = null, resetCb = null;

/** 显示项那九行前面的图标——卡片因此同时是设置和图例，一份数据两用。
    每行一个图标，眼位也不例外：曾经放过"眼 + 塔"两个（想表达那块地图画了哪两类
    东西），但九行里只有它是两个，反而不齐。塔图标仍留在 icons.js 里，
    将来眼位图例那一节要用。 */
function showIcon(k) {
  if (k === "mid") return icon("bounty", 13);   // 中路符取它的首个阶段
  if (k === "wardmap") return icon("eye", 13);
  return icon(CELL_ICON[k], 13);
}

// 图例。刻意复用地图自己的 wm-ward / wm-tower class 画色块——
// 另写一套颜色迟早会和地图对不上。只在编辑态可见，游戏中不占任何屏幕空间。
const LEGEND = [
  [`<circle class="wm-ward own" cx="5" cy="5" r="3.4"/>`,          "ownObs"],
  [`<circle class="wm-ward own sentry" cx="5" cy="5" r="3.1"/>`,   "ownSentry"],
  [`<circle class="wm-ward enemy" cx="5" cy="5" r="3.4"/>`,        "enemyObs"],
  [`<circle class="wm-ward enemy sentry" cx="5" cy="5" r="3.1"/>`, "enemySentry"],
  [`<circle class="wm-ward own soon" cx="5" cy="5" r="3.4"/>`,     "soon"],
  [`<circle class="wm-ward killed" cx="5" cy="5" r="3.4"/>`,       "killed"],
  [`<rect class="wm-tower" data-team="2" x="1.6" y="1.6" width="6.8" height="6.8"/>`, "towerRadiant"],
  [`<rect class="wm-tower" data-team="3" x="1.6" y="1.6" width="6.8" height="6.8"/>`, "towerDire"],
  [`<rect class="wm-tower dead" x="1.6" y="1.6" width="6.8" height="6.8"/>`,          "towerDead"],
];
const legendHTML = () => LEGEND.map(([shape, key]) =>
  `<span><svg viewBox="0 0 10 10" aria-hidden="true">${shape}</svg>${t("legend." + key)}</span>`).join("");

/** 开发区那两行版本号。只读，用户报"数字不对"时直接念给我们听——
    价格表旧了的症状是净资产看起来正常但偏低，没有任何报错。

    整个进程只取一次：切语言会重建整张卡片，而版本号在运行期不会变。
    取不到就留着破折号，这是排查信息，**不该因为它取不到而让卡片建不出来**。 */
let verOnce = null;
function versions() {
  if (!verOnce) {
    verOnce = (isTauri()
      ? window.__TAURI__.core.invoke("get_versions")
      // 浏览器开发时没有 Tauri，也就没有"程序版本"这个东西；价格表版本还是照读
      : fetch("/constants/patch.json").then(r => r.json()).then(v => ({ app: "dev", dota: v.dota }))
    ).catch(() => ({}));
  }
  return verOnce;
}

/** 四个页签：`[页面 id, 词条键, 图标名]`。顺序就是屏幕上的顺序。

    **页签只有图标**，名字显示在页签条下面那一行。这样中英文的卡片宽度完全一致——
    英文的 `Display / Panel / Legend / Developer` 并排写出来撑得开 329px，
    而图标不受语言影响。这是覆盖层图标化那次的同一个收益，只是搬到了卡片上。 */
const TABS = [
  ["show",   "card.show",   "grid"],
  ["panel",  "card.panel",  "sliders"],
  ["legend", "card.legend", "legend"],
  ["dev",    "card.dev",    "wrench"],
];
/** 当前页。**模块级而不是存进 settings**：它是瞬时的界面状态，不是用户的偏好，
    存盘会让 settings.json 里多一个和外观无关的键。切语言要整卡重建，
    靠它把选中项接回去——否则每次换语言都被踢回第一页。 */
let activeTab = TABS[0][0];

const MB = 1024 * 1024;
/** 体积按 MB 给一位小数；不到 0.1MB 的显示 <0.1，别写成 0.0 让人以为是空的。 */
function mb(bytes) {
  const v = bytes / MB;
  return (v > 0 && v < 0.05 ? "<0.1" : v.toFixed(1)) + " MB";
}

/** 开发区的录制那一组：一行统计 + 一个清空按钮。

    **清空要点两下。** 第一下把按钮文字换成"确定删除？"，第二下才动手，
    5 秒无操作自动退回。录像不可再生——打过的对局回不来——所以这一下值得。
    不用 `confirm()`：它会弹一个抢焦点的系统框，而编辑态本来就在跟焦点较劲。 */
function initRecords(stat, btn) {
  if (!isTauri()) { stat.textContent = "—"; btn.disabled = true; return; }
  const inv = (cmd) => window.__TAURI__.core.invoke(cmd);
  const label = btn.textContent;
  let armed = 0, timer = 0;

  const show = (s) => {
    // 单位跟着语言走。**别在 JS 里写死"个"**——英文那份会变成 "3 个 · 12.0 MB"。
    stat.textContent = s && s.count ? `${s.count}${t("card.recUnit")} · ${mb(s.bytes)}` : "—";
    btn.disabled = !(s && s.count);
  };
  const disarm = () => { armed = 0; clearTimeout(timer); btn.textContent = label; };
  const refresh = () => inv("records_stat").then(show).catch(() => show(null));

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = 1;
      btn.textContent = t("card.clearRecConfirm");
      timer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    // 留下的那个是正在录的——不提示反而像没删干净，所以把它说出来
    const r = await inv("clear_records").catch(() => null);
    if (r && r.kept) stat.textContent = t("card.recKept");
    else await refresh();
    if (r && r.kept) setTimeout(refresh, 2500);
  });
  refresh();
}

export async function initEditor(cardEl, onDone, onReset) {
  card = cardEl; doneCb = onDone; resetCb = onReset;
  await build(await loadSettings());
}

/** 建卡片和绑事件必须是同一个函数：切语言要整个 innerHTML 重建，
    而重建会换掉所有节点——包括 .ed-bar 那个拖拽把手。只重建不重绑就把卡片钉死了。 */
async function build(s) {
  await loadLang(s.lang ?? DEFAULTS.lang);
  card.className = "editor";
  pinnedH = 0;                // 节点要整批换掉，量过的高度作废；中英文也不一样高
  card.innerHTML = `
    <div class="ed-bar">${t("card.title")}</div>
    <div class="ed-tabs" role="tablist">${TABS.map(([id, key, ic]) =>
      `<button class="ed-tab" type="button" role="tab" data-tab="${id}" title="${t(key)}"
        aria-label="${t(key)}">${icon(ic, 15)}</button>`).join("")}</div>
    <div class="ed-tabname" id="edTabName"></div>
    <div class="ed-pane" data-pane="show">
      <div class="ed-grid">${SHOW_KEYS.map(k =>
        `<label class="ed-chk"><input type="checkbox" data-show="${k}"${
          s.show?.[k] !== false ? " checked" : ""
        }><span class="ed-ico">${showIcon(k)}</span>${t("show." + k)}</label>`).join("")}</div>
    </div>
    <div class="ed-pane" data-pane="panel">
      <label class="ed-row">${t("card.lang")}
        <select id="edLang">${LANGS.map(([v, name]) =>
          `<option value="${v}">${name}</option>`).join("")}</select></label>
      <label class="ed-row">${t("card.scale")}
        <input id="edScale" type="range" min="0.8" max="2" step="0.05">
        <output id="edScaleOut"></output></label>
      <label class="ed-row">${t("card.opacity")}
        <input id="edOpacity" type="range" min="0.3" max="1" step="0.05">
        <output id="edOpacityOut"></output></label>
      <label class="ed-row">${t("card.bg")}
        <input id="edBg" type="range" min="0" max="1" step="0.02">
        <output id="edBgOut"></output></label>
      <label class="ed-row">${t("card.wardSize")}
        <input id="edWard" type="range" min="108" max="360" step="4">
        <output id="edWardOut"></output></label>
      <div class="ed-row"><button id="edReset" type="button">${t("card.reset")}</button></div>
    </div>
    <div class="ed-pane" data-pane="legend">
      <div class="ed-legend-note">${t("card.legendNote")}</div>
      <div class="ed-legend">${legendHTML()}</div>
    </div>
    <div class="ed-pane" data-pane="dev">
      <label class="ed-row">${t("card.logLevel")}
        <select id="edLog">
          <option value="error">error</option><option value="warn">warn</option>
          <option value="info">info</option><option value="debug">${t("card.logDebug")}</option>
        </select></label>
      <label class="ed-row"><input id="edRecord" type="checkbox">${t("card.record")}</label>
      <div class="ed-row ed-ver">${t("card.recFiles")}<b id="edRecStat">—</b></div>
      <div class="ed-row">
        <button id="edClear" type="button">${t("card.clearRec")}</button>
        <button id="edDir" type="button">${t("card.openDir")}</button>
      </div>
      <div class="ed-row ed-ver">${t("card.appVersion")}<b id="edAppVer">—</b></div>
      <div class="ed-row ed-ver">${t("card.dotaVersion")}<b id="edDotaVer">—</b></div>
    </div>
    <div class="ed-foot">
      <span class="ed-hint">${t("card.hint")}</span>
      <button id="edDone" type="button">${t("card.done")}</button>
    </div>`;

  const $ = (id) => card.querySelector("#" + id);
  const scale = $("edScale"), opacity = $("edOpacity"), ward = $("edWard"),
        bg = $("edBg"), log = $("edLog"), record = $("edRecord"), lang = $("edLang");
  scale.value = s.scale ?? DEFAULTS.scale;
  opacity.value = s.opacity ?? DEFAULTS.opacity;
  ward.value = s.wardSize ?? DEFAULTS.wardSize;
  bg.value = s.panelBg ?? DEFAULTS.panelBg;
  log.value = s.logLevel ?? DEFAULTS.logLevel;
  record.checked = !!s.recordMatches;
  lang.value = s.lang ?? DEFAULTS.lang;

  const sync = () => {
    $("edScaleOut").textContent = Number(scale.value).toFixed(2) + "×";
    $("edOpacityOut").textContent = Math.round(Number(opacity.value) * 100) + "%";
    $("edWardOut").textContent = ward.value + "px";
    $("edBgOut").textContent = Math.round(Number(bg.value) * 100) + "%";
  };
  const collect = () => ({
    show: Object.fromEntries([...card.querySelectorAll("[data-show]")]
      .map(el => [el.dataset.show, el.checked])),
    scale: Number(scale.value),
    opacity: Number(opacity.value),
    wardSize: Number(ward.value),
    panelBg: Number(bg.value),
    logLevel: log.value,
    recordMatches: record.checked,
    lang: lang.value,
  });

  // 页签切换。只改 hidden 和一个 class，不动任何控件——控件在四个页里一直都在，
  // 切页只是把它们藏起来，所以 collect() 永远收得齐。
  const panes = [...card.querySelectorAll(".ed-pane")];
  const tabs = [...card.querySelectorAll(".ed-tab")];
  const name = $("edTabName");
  const selectTab = (id) => {
    if (!TABS.some(([t0]) => t0 === id)) id = TABS[0][0];
    activeTab = id;
    for (const p of panes) p.hidden = p.dataset.pane !== id;
    for (const b of tabs) {
      const on = b.dataset.tab === id;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    name.textContent = t(TABS.find(([t0]) => t0 === id)[1]);
  };
  for (const b of tabs) b.addEventListener("click", () => selectTab(b.dataset.tab));
  selectTab(activeTab);

  sync();
  // 建完再填：切语言会重建这两个节点，所以要等到这一刻才去拿它们
  versions().then(v => {
    const put = (id, val) => { const el = card.querySelector("#" + id); if (el && val) el.textContent = val; };
    put("edAppVer", v.app);
    put("edDotaVer", v.dota);
  });
  for (const el of card.querySelectorAll("input, select")) {
    el.addEventListener("input", () => { sync(); saveSettings(collect()); });
  }
  // 语言换了整卡重建。用手上这份设置重建，不重新 loadSettings()——
  // 上面那次保存在 Tauri 下是异步的 invoke，读回来可能还是旧的 lang。
  lang.addEventListener("change", async () => {
    const next = collect();
    await saveSettings(next);
    await build(next);
    if (!card.hidden) { pinPaneHeight(); place(); }   // 中英文卡片不一样宽也不一样高
  });

  // 「重置」把这张卡片管的外观一次还原：九个勾 + 四条滑块 + 四块摆位。
  // 开发区那两项不动——悄悄关掉正在录的对局，用户不会知道自己丢了数据。
  // **语言也不动**：重置回中文会让看不懂中文的用户无法退出这个状态，
  // 他得先猜出哪一行是语言、再猜哪个选项是英文。可恢复性是重置的前提。
  // 摆位要按**新的**缩放重算，而 main.js 里的 cfg 靠 settings 事件异步刷新、
  // 这会儿还是旧值，所以把 scale 直接传过去，别让它自己去读。
  $("edReset").addEventListener("click", () => {
    for (const el of card.querySelectorAll("[data-show]")) el.checked = DEFAULTS.show[el.dataset.show];
    scale.value = DEFAULTS.scale;
    opacity.value = DEFAULTS.opacity;
    bg.value = DEFAULTS.panelBg;
    ward.value = DEFAULTS.wardSize;
    sync();
    saveSettings(collect());
    resetCb(DEFAULTS.scale);
  });
  $("edDir").addEventListener("click", () => {
    if (isTauri()) window.__TAURI__.core.invoke("open_data_dir");
  });
  initRecords($("edRecStat"), $("edClear"));
  $("edDone").addEventListener("click", doneCb);

  const bar = card.querySelector(".ed-bar");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true; bar.setPointerCapture(ev.pointerId);
    sx = ev.clientX; sy = ev.clientY;
    ox = parseFloat(card.style.left) || 0; oy = parseFloat(card.style.top) || 0;
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    card.style.left = `${ox + ev.clientX - sx}px`;
    card.style.top  = `${oy + ev.clientY - sy}px`;
  });
  bar.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false; bar.releasePointerCapture(ev.pointerId);
  });
}

/** 每次进编辑态回到屏幕中央偏下。位置不存盘——四块之后没有"面板"这个唯一锚点，
    与其猜一个，不如每次给个确定的起点，要挪自己拖。 */
function place() {
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = `${Math.round(Math.max(8, (innerWidth - w) / 2))}px`;
  card.style.top  = `${Math.round(Math.max(8, Math.min(innerHeight * 0.6, innerHeight - h - 8)))}px`;
}

export function setEditorOpen(on) {
  if (!card) return;
  card.hidden = !on;          // 必须先取消隐藏再量尺寸，hidden 时 offsetWidth 为 0
  if (on) { pinPaneHeight(); place(); }
}

/** 把四页拉到同高，卡片切页时就不会忽高忽低。

    **不是为了好看，是为了「完成」按钮别动。** 四页实测 270/316/282/293，
    最大差 46px；不钉住的话每点一次页签，底部那个按钮就上下跳一次——
    而编辑态下覆盖层全屏吃鼠标，它是三条退出路径里最可靠的一条，不该是个移动靶。

    **只能在卡片显示之后量**：hidden 的时候 offsetHeight 是 0，
    在 build() 里量到的会是一排 0（和上面 place() 那条注释同一个坑）。
    量完缓存住，之后每次打开直接套用；切语言会重建节点并清掉缓存，重量一次。 */
let pinnedH = 0;
function pinPaneHeight() {
  const panes = [...card.querySelectorAll(".ed-pane")];
  if (!panes.length) return;
  if (!pinnedH) {
    const was = panes.map(p => p.hidden);
    for (const p of panes) p.style.minHeight = "";
    for (const p of panes) {
      p.hidden = false;
      pinnedH = Math.max(pinnedH, p.offsetHeight);
      p.hidden = true;
    }
    panes.forEach((p, i) => { p.hidden = was[i]; });
  }
  for (const p of panes) p.style.minHeight = pinnedH + "px";
}
