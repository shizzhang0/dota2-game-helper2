import { SHOW_ITEMS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";
import { icon, CELL_ICON } from "./icons.js";

// 编辑态的设置卡片。与 .block 平级而非其子节点——块受 --panel-scale 缩放，
// 卡片跟着缩到 2× 或 0.8× 都没法用。
//
// 卡片自己也能拖，但**只能靠顶部标题栏**：拖拽要 setPointerCapture，
// 而它会把 pointerup 改派到捕获元素，click 便落不到内部的按钮上。
// 整块可拖会打死「完成」按钮、九个复选框、两个滑块和下拉框——
// 「完成」失效等于编辑态出不去。见 design/overlay.md 的第 3 号坑。
let card = null;

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
  [`<circle class="wm-ward own" cx="5" cy="5" r="3.4"/>`,          "我方假眼"],
  [`<circle class="wm-ward own sentry" cx="5" cy="5" r="3.1"/>`,   "我方真眼"],
  [`<circle class="wm-ward enemy" cx="5" cy="5" r="3.4"/>`,        "敌方假眼"],
  [`<circle class="wm-ward enemy sentry" cx="5" cy="5" r="3.1"/>`, "敌方真眼"],
  [`<circle class="wm-ward own soon" cx="5" cy="5" r="3.4"/>`,     "60 秒内到期"],
  [`<circle class="wm-ward killed" cx="5" cy="5" r="3.4"/>`,       "刚被排掉"],
  [`<rect class="wm-tower" data-team="2" x="1.6" y="1.6" width="6.8" height="6.8"/>`, "天辉塔"],
  [`<rect class="wm-tower" data-team="3" x="1.6" y="1.6" width="6.8" height="6.8"/>`, "夜魇塔"],
  [`<rect class="wm-tower dead" x="1.6" y="1.6" width="6.8" height="6.8"/>`,          "已推掉"],
];
const legendHTML = () => LEGEND.map(([shape, label]) =>
  `<span><svg viewBox="0 0 10 10" aria-hidden="true">${shape}</svg>${label}</span>`).join("");

export async function initEditor(cardEl, onDone, onResetLayout) {
  card = cardEl;
  const s = await loadSettings();
  card.className = "editor";
  card.innerHTML = `
    <div class="ed-bar">面板设置</div>
    <div class="ed-sec"><h3>显示项</h3>
      <div class="ed-grid">${SHOW_ITEMS.map(([k, label]) =>
        `<label class="ed-chk"><input type="checkbox" data-show="${k}"${
          s.show?.[k] !== false ? " checked" : ""
        }><span class="ed-ico">${showIcon(k)}</span>${label}</label>`).join("")}</div>
    </div>
    <div class="ed-sec"><h3>面板</h3>
      <label class="ed-row">缩放
        <input id="edScale" type="range" min="0.8" max="2" step="0.05">
        <output id="edScaleOut"></output></label>
      <label class="ed-row">整体
        <input id="edOpacity" type="range" min="0.3" max="1" step="0.05">
        <output id="edOpacityOut"></output></label>
      <label class="ed-row">底板
        <input id="edBg" type="range" min="0" max="1" step="0.02">
        <output id="edBgOut"></output></label>
      <label class="ed-row">眼位地图
        <input id="edWard" type="range" min="108" max="360" step="4">
        <output id="edWardOut"></output></label>
      <div class="ed-row"><button id="edReset" type="button">恢复默认摆位</button></div>
    </div>
    <details class="ed-sec"><summary>眼位地图图例</summary>
      <div class="ed-legend-note">实心＝假眼　空心＝真眼</div>
      <div class="ed-legend">${legendHTML()}</div>
    </details>
    <details class="ed-sec"><summary>开发</summary>
      <label class="ed-row">日志级别
        <select id="edLog">
          <option value="error">error</option><option value="warn">warn</option>
          <option value="info">info</option><option value="debug">debug（全量）</option>
        </select></label>
      <label class="ed-row"><input id="edRecord" type="checkbox">记录对局数据（gzip，一局约 4MB）</label>
      <button id="edDir" type="button">打开常数表目录</button>
    </details>
    <div class="ed-foot">
      <span class="ed-hint">拖各块摆位 · 拖标题栏移动本卡片 · ESC 退出</span>
      <button id="edDone" type="button">完成</button>
    </div>`;

  const $ = (id) => card.querySelector("#" + id);
  const scale = $("edScale"), opacity = $("edOpacity"), ward = $("edWard"),
        bg = $("edBg"), log = $("edLog"), record = $("edRecord");
  scale.value = s.scale ?? 1;
  opacity.value = s.opacity ?? 1;
  ward.value = s.wardSize ?? 180;
  bg.value = s.panelBg ?? 0.72;
  log.value = s.logLevel ?? "debug";
  record.checked = !!s.recordMatches;

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
  });

  sync();
  for (const el of card.querySelectorAll("input, select")) {
    el.addEventListener("input", () => { sync(); saveSettings(collect()); });
  }
  $("edDir").addEventListener("click", () => {
    if (isTauri()) window.__TAURI__.core.invoke("open_constants_dir");
  });
  $("edDone").addEventListener("click", onDone);
  $("edReset").addEventListener("click", onResetLayout);

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
  if (on) place();
}
