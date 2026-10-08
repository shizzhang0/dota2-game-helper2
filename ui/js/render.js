import { initWardMap, renderWardMap } from "./wardmap.js";
import { icon, CELL_ICON } from "./icons.js";
import { initTopbar, renderTopbar } from "./topbar.js";

// Alt 面板渲染。DOM 只在 initPanel 建一次，render 仅改文本/类名/CSS 变量，避免每帧重建。
const R = 26, CIRC = 2 * Math.PI * R;
const TIMER_IDS = ["mid", "bounty", "lotus", "wisdom", "stack"];

// 两个块。cells 用来判断"这一块是不是该整体隐藏"。位置固定，见下面的 placeBlocks。
// 敌方塔防、买活和眼位不在这里：它们贴着 Dota 自己的顶栏 / 小地图画、位置跟着游戏走，
// 见 topbar.js 和 wardmap.js。
export const BLOCKS = [
  { id: "timers",  cells: ["mid", "bounty", "lotus", "wisdom", "stack"] },
  { id: "econ",    cells: ["econ"] },
];

let root = null, els = null, prev = {};

function ring(id) {
  return `<div class="cell" data-cell="${id}" data-urgency="far">
    <svg viewBox="0 0 60 60" aria-hidden="true">
      <circle class="ring-bg" cx="30" cy="30" r="${R}"/>
      <circle class="ring-fg" cx="30" cy="30" r="${R}"
              stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
    </svg>
    <div class="lab"></div>
    <div class="num">--</div>
  </div>`;
}

const INNER = {
  timers: () => TIMER_IDS.map(ring).join(""),
  econ: () => `
    <div class="cell wide econ" data-cell="econ">
      <div class="inline-row">
        <div class="lab">${icon("coin")}</div>
        <div class="nw">--</div>
      </div>
      <div class="rate"><span class="gpm">--</span><span class="xpm">--</span></div>
    </div>`,
};

// container（#panel）只是个容器，自己不带样式；块是 fixed 定位，父节点有没有尺寸都不影响。
export function initPanel(container, towers) {
  root = container;
  root.removeAttribute("hidden");
  root.innerHTML = BLOCKS.map(b =>
    `<div class="block" data-block="${b.id}">${INNER[b.id]()}</div>`).join("") +
    // 眼位那一层不是块：不能拖，位置由 wardmap.js 按原生小地图算。
    // 仍然带 data-cell，显示项开关照常管它
    `<div class="mm" data-cell="wardmap"></div>`;

  els = { blocks: {}, cells: {},
          nw: root.querySelector(".nw"),
          gpm: root.querySelector(".gpm"),
          xpm: root.querySelector(".xpm") };
  for (const b of BLOCKS) els.blocks[b.id] = root.querySelector(`[data-block="${b.id}"]`);
  for (const c of root.querySelectorAll("[data-cell]")) {
    els.cells[c.dataset.cell] = { root: c, num: c.querySelector(".num"),
      lab: c.querySelector(".lab"), fg: c.querySelector(".ring-fg") };
  }
  initWardMap(root.querySelector('[data-cell="wardmap"]'), towers);
  initTopbar(root);
  prev = {};
}

function set(node, key, value) {           // 只在变化时写 DOM
  if (prev[key] === value) return;
  prev[key] = value;
  node.textContent = value;
}

// 图标要整段替换 SVG，走不了上面那个 textContent 的路子。
// 同样只在变化时才动 DOM——渲染是 250ms 一轮，每帧重建 SVG 太浪费。
function setHtml(node, key, html) {
  if (prev[key] === html) return;
  prev[key] = html;
  node.innerHTML = html;
}

function fmt(sec) {
  if (sec <= 0) return "0";
  return sec < 60 ? String(sec) : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function urgency(sec) { return sec <= 10 ? "now" : sec <= 30 ? "near" : "far"; }

export function render(m) {
  if (!root) return;
  const cfg = m.settings || {};
  const show = cfg.show || {};
  // CSS 变量沿 DOM 树继承，设在容器上每一块都吃得到（贴顶栏那一层也吃）；缩放与透明度都走合成器，不触发重排
  root.style.setProperty("--panel-opacity", cfg.opacity ?? 1);
  for (const [id, cell] of Object.entries(els.cells)) {
    cell.root.hidden = show[id] === false;
  }
  for (const b of BLOCKS) {
    const el = els.blocks[b.id];
    el.hidden = b.cells.every(id => show[id] === false);   // 格子全关掉时整块消失（编辑态的虚线框也不留）
    el.classList.toggle("on", !!m.visible);
    el.classList.toggle("edit", !!m.editMode);
  }
  const wmOff = show.wardmap === false;

  for (const t of m.timers || []) {
    const c = els.cells[t.id];
    if (!c) continue;
    set(c.num, t.id + ".n", fmt(t.remaining));
    // 中路符的图标随阶段变（kind 就是 bounty/water/power），其余按格子 id 取；
    // 赏金格子刻意用钱袋而不是币堆，否则 0:00 时会和中路符一模一样
    setHtml(c.lab, t.id + ".l", icon(t.id === "mid" ? t.kind : CELL_ICON[t.id]));
    const u = urgency(t.remaining);
    if (prev[t.id + ".u"] !== u) { prev[t.id + ".u"] = u; c.root.dataset.urgency = u; }
    if (prev[t.id + ".k"] !== t.kind) {
      prev[t.id + ".k"] = t.kind;
      c.root.style.setProperty("--accent", `var(--k-${t.kind})`);
    }
    const frac = t.period ? Math.max(0, Math.min(1, t.remaining / t.period)) : 0;
    const off = (CIRC * (1 - frac)).toFixed(1);
    if (prev[t.id + ".o"] !== off) { prev[t.id + ".o"] = off; c.fg.style.strokeDashoffset = off; }
  }

  placeBlocks(cfg.scale ?? 1);
  renderTopbar(root, m, show);

  const e = m.econ || { networth: 0, gpm: 0, xpm: 0 };
  set(els.nw, "e.nw", e.networth.toLocaleString("en-US"));
  set(els.gpm, "e.gpm", `${e.gpm} GPM`);
  set(els.xpm, "e.xpm", `${e.xpm} XPM`);

  const mm = els.cells.wardmap.root;
  mm.classList.toggle("on", !!m.visible);
  mm.classList.toggle("edit", !!m.editMode);
  if (!wmOff) renderWardMap(m.wardmap || { wards: null, dead: [] },
                            m.minimap || { large: false, right: false }, !!m.editMode);
}

/** 两块的位置也贴着 Dota 自己的界面走（2026-10-08 起），不再能拖、不再存 layout.json。
    和顶栏、小地图同一个路子：量出 1080 高下的锚点，任何分辨率都乘 `屏高/1080`。
    块的大小同样按屏高缩放，再乘用户的「缩放」滑块——这样换分辨率时它和游戏界面一起变大变小。
      · 倒计时：紧贴顶栏中间那块计时牌下面、水平居中，圆环顶边在 44（计时牌底边约 41）。
        只有圆环没有数字，整排宽约 ±104，夹在两侧最靠中线的买活（±118 起）之间
      · 净资产：Dota 左上角「击 / 死 / 助」那块面板的**右边**，和它的两行字齐平。
        原先放在面板下面，会挡住 Dota 在那里显示的挑战目标（用户实测，2026-10-08）；
        面板文字右边缘约在 160、两行字的顶边在 65（量自 2560×1600 的实战截图）。
        右边一直空到顶栏左端的塔防（离中线 533，16:10 上约在 331），够放 */
const TIMERS_TOP = 44, ECON_TOP = 64, ECON_LEFT = 175;
// 各块自己的基准大小。倒计时原先 0.62：圆环直径约 32，去掉数字之后一排五个刚好塞进
// 计时牌下面、两侧买活中间那块空地（用户指定的位置，2026-10-08）；之后缩到 0.5 嫌小，回到 0.6
const BASE = { timers: 0.6, econ: 1 };
// 块的边框 1 + 上内边距 8：内容顶边离块顶边多远（未缩放）
const INSET = 9;

function placeBlocks(userScale) {
  const W = innerWidth, H = innerHeight;
  if (!W || !H) return;
  const k = H / 1080;
  // 缩放写在各块自己身上（不再写在容器上），因为两块的基准不一样
  const sc = (id) => {
    const s = k * userScale * BASE[id];
    if (prev["ps." + id] !== s) { prev["ps." + id] = s; els.blocks[id].style.setProperty("--panel-scale", s); }
    return s;
  };
  const put = (el, x, y) => {
    const l = `${Math.round(x)}px`, t = `${Math.round(y)}px`;
    if (el.style.left !== l) el.style.left = l;
    if (el.style.top !== t) el.style.top = t;
  };
  // 宽度每轮现量：显示项开关会让块变窄，字体加载前后也不一样。offsetWidth 是未缩放的值
  const t = els.blocks.timers, st = sc("timers");
  put(t, W / 2 - t.offsetWidth * st / 2, TIMERS_TOP * k - INSET * st);
  // 金币图标在块里的横向偏移（未缩放）：.lab 的 offsetParent 是 .cell（position: relative）
  const cell = els.cells.econ.root, lab = cell.querySelector(".lab"), se = sc("econ");
  put(els.blocks.econ, ECON_LEFT * k - (cell.offsetLeft + lab.offsetLeft) * se, ECON_TOP * k - INSET * se);
}
