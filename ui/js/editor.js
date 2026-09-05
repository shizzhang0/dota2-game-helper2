import { SHOW_ITEMS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";

// 编辑态的设置卡片。与 .panel 平级而非其子节点——面板受 --panel-scale 缩放，
// 卡片跟着缩到 2× 或 0.8× 都没法用。
const GAP = 10;                 // 卡片与面板的间距
let card = null, panel = null, raf = 0;

export async function initEditor(cardEl, panelEl, onDone) {
  card = cardEl; panel = panelEl;
  const s = await loadSettings();
  card.className = "editor";
  card.innerHTML = `
    <div class="ed-sec"><h3>显示项</h3>
      <div class="ed-grid">${SHOW_ITEMS.map(([k, label]) =>
        `<label class="ed-chk"><input type="checkbox" data-show="${k}"${
          s.show?.[k] !== false ? " checked" : ""}>${label}</label>`).join("")}</div>
    </div>
    <div class="ed-sec"><h3>面板</h3>
      <label class="ed-row">缩放
        <input id="edScale" type="range" min="0.8" max="2" step="0.05">
        <output id="edScaleOut"></output></label>
      <label class="ed-row">透明度
        <input id="edOpacity" type="range" min="0.3" max="1" step="0.05">
        <output id="edOpacityOut"></output></label>
    </div>
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
      <span class="ed-hint">拖动面板摆放位置 · 或按 ESC</span>
      <button id="edDone" type="button">完成</button>
    </div>`;

  const $ = (id) => card.querySelector("#" + id);
  const scale = $("edScale"), opacity = $("edOpacity"),
        log = $("edLog"), record = $("edRecord");
  scale.value = s.scale ?? 1;
  opacity.value = s.opacity ?? 1;
  log.value = s.logLevel ?? "debug";
  record.checked = !!s.recordMatches;

  const sync = () => {
    $("edScaleOut").textContent = Number(scale.value).toFixed(2) + "×";
    $("edOpacityOut").textContent = Math.round(Number(opacity.value) * 100) + "%";
  };
  const collect = () => ({
    show: Object.fromEntries([...card.querySelectorAll("[data-show]")]
      .map(el => [el.dataset.show, el.checked])),
    scale: Number(scale.value),
    opacity: Number(opacity.value),
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
}

/** 锚在面板下方并跟随；下方放不下就翻到上方，两侧钳在视口内 */
function place() {
  const r = panel.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let y = r.bottom + GAP;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - GAP - h);
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

export function setEditorOpen(on) {
  if (!card) return;
  card.hidden = !on;
  if (on) place();   // 先同步定位一次，不能只靠下面的 rAF
  // rAF 只负责拖动时的逐帧跟随，且只在编辑态跑——平时一帧都不该浪费。
  // 注意 rAF 在窗口被遮挡/最小化时不触发，所以初次定位必须走上面那行同步调用，
  // 否则卡片会停在 (0,0)。实测：隐藏的浏览器面板里 600ms 内 0 帧。
  if (on && !raf) {
    const tick = () => { place(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  } else if (!on && raf) {
    cancelAnimationFrame(raf); raf = 0;
  }
}
