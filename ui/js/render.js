import { initWardMap, renderWardMap, minimapBox } from "./wardmap.js";
import { icon, CELL_ICON } from "./icons.js";
import { initTopbar, renderTopbar } from "./topbar.js";

// 覆盖层渲染。DOM 只在 initPanel 建一次，render 仅改文本/类名/CSS 变量，避免每帧重建。
const R = 26, CIRC = 2 * Math.PI * R;
// 顺序跟 Dota Plus 自带的符文倒计时一致（中路 / 赏金 / 智慧 / 莲花 / 野怪，2026-10-08 起），
// 用过 Dota Plus 的人不用重新记位置
const TIMER_IDS = ["mid", "bounty", "wisdom", "lotus", "stack"];

// 两个块。cells 用来判断"这一块是不是该整体隐藏"。位置固定，见下面的 placeBlocks。
// 买活和眼位不在这里：它们贴着 Dota 自己的顶栏 / 小地图画、位置跟着游戏走，见 topbar.js 和 wardmap.js。
// minibar 是小地图上方那一栏：自己的净资产 + 敌方塔防（2026-10-18 起，见 placeBlocks）
export const BLOCKS = [
  { id: "timers",  cells: ["mid", "bounty", "lotus", "wisdom", "stack"] },
  { id: "minibar", cells: ["econ", "glyph"] },
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
  // 两格：自己的净资产、敌方塔防。塔防格子里是一个和倒计时同款的小圆环（进度 = 剩余冷却），
  // 格子本身带一圈淡红光晕表示"这是敌人的"，可用时光晕加深（overlay.css 的 .mb-glyph）
  minibar: () => `
    <div class="cell wide econ" data-cell="econ">
      <div class="inline-row">
        <div class="lab">${icon("coin")}</div>
        <div class="nw">--</div>
      </div>
      <div class="rate"><span class="gpm">--</span><span class="xpm">--</span></div>
    </div>
    <div class="mb-glyph" data-cell="glyph" data-ready="1">
      <div class="mb-ring">
        <svg class="ring" viewBox="0 0 60 60" aria-hidden="true">
          <circle class="ring-bg" cx="30" cy="30" r="${R}"/>
          <circle class="ring-fg" cx="30" cy="30" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
        </svg>
        <div class="mb-glyph-ico">${icon("glyph")}<span></span></div>
      </div>
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
          xpm: root.querySelector(".xpm"),
          glyph: root.querySelector(".mb-glyph") };
  els.gnum = els.glyph.querySelector(".mb-glyph-ico span");
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
  // **这一刻没给出来的格子退回初始的 "--"**（2026-10-15）。号角前 computeTimers 不出堆野
  //（clock < 0 时没有意义），而上面只写给出来的那几格——堆野格子就停在上一局最后的数字和环上，
  // 新局选人、策略阶段一直挂着旧值。和 ring() 建出来时一个样子：数字 "--"、满环、远。
  const given = new Set((m.timers || []).map(t => t.id));
  for (const id of TIMER_IDS) {
    const c = els.cells[id];
    if (!c || given.has(id)) continue;
    set(c.num, id + ".n", "--");
    if (prev[id + ".u"] !== "far") { prev[id + ".u"] = "far"; c.root.dataset.urgency = "far"; }
    if (prev[id + ".o"] !== "0") { prev[id + ".o"] = "0"; c.fg.style.strokeDashoffset = "0"; }
  }

  // 敌方塔防：剩下多少冷却环就有多长（逆时针退回 12 点）；可用时环是满的、塔点亮、光晕加深——
  // "敌方此刻有塔防"是威胁态，要最显眼。冷却中在圆心写剩余时间（和游戏里技能冷却一样），
  // 倒计时那排不写数字，但塔防要算"还剩几秒能强推"，用户要精确值（2026-10-09）
  const gm = m.glyph || { ready: true, remaining: 0, total: 300 };
  if (prev["g.r"] !== gm.ready) { prev["g.r"] = gm.ready; els.glyph.dataset.ready = gm.ready ? "1" : "0"; }
  set(els.gnum, "g.t", gm.ready ? "" : fmt(gm.remaining));
  const gfrac = gm.ready ? 1 : Math.max(0, Math.min(1, gm.remaining / (gm.total || 300)));
  const goff = (CIRC * (1 - gfrac)).toFixed(1);
  if (prev["g.o"] !== goff) { prev["g.o"] = goff; els.cells.glyph.fg.style.strokeDashoffset = goff; }

  placeBlocks(m.minimap || { large: false, right: false });
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
    块的大小同样按屏高缩放——换分辨率时它和游戏界面一起变大变小。
    （原先还乘一个用户的「缩放」滑块、另有「整体透明度」滑块，2026-10-08 一并去掉：
    位置和大小都已经跟着游戏界面定好了，再给一个能调的旋钮只会把它调歪。）
      · 倒计时：紧贴顶栏中间那块计时牌下面、水平居中，圆环顶边在 42（计时牌底边约 40），见下面 TIMERS_TOP。
        只有圆环没有数字，整排宽约 ±112，夹在两侧最靠中线的买活（±118 起）之间
      · minibar（自己的净资产 + 敌方塔防）：**原生小地图外框的"顶盖"**——底边贴着外框顶边，左边一直到屏幕边、
        右边和外框对齐；小地图在右边时整栏挪过去、贴屏幕右边，**内部不镜像**，见 FRAME_TOP / FRAME_SIDE。样子见 overlay.css 的 minibar 那段。
        （2026-10-18 先是离小地图 7、和地图区域对齐的两块灰底；2026-10-19 用户嫌空、像漂着，改成贴外框的顶盖）
        经过：净资产在左上角 KDA 右边、塔防在顶栏敌方那一端 → 开了 Dota Plus，左上角那块面板变宽
        （多一列「目标」和承受伤害条，横到约 270），压住净资产 → 净资产挪到顶栏我方那一端（2026-10-16）
        → 用户觉得两样**跟着阵营左右换边很奇怪** → 用试验版（编辑态里能拖）实战找位置，
        定在小地图上方：和阵营无关；Dota 自己的塔防按钮就在小地图旁边；开不开 Plus 都空着。
        两样放一起时用两格区分——敌方那格带一圈淡红光晕，可用时加深（用户否掉了顶边色条、描边，嫌丑）。
        只开一样时剩下那格贴着小地图边缘（flex 自然收拢），都关掉时整栏不画。
        击杀播报从小地图上方往上堆（约 725~785），碰不到这一栏（793~835），用户实战确认（2026-10-18） */
// 倒计时紧贴计时牌底边（约 40），**塞在计时牌和下面那行字之间**：按住 Alt 时游戏在 73~84
// 写"5:00 UNTIL NIGHT"，开局号角前也有提示。空当只有约 33，所以环缩到外径约 28（见 BASE），上下各留 2~3。
// 不按 Alt 时那一块游戏什么都不放（Dota Plus 自带的符文倒计时也只在按住 Alt 时出现），环就贴着计时牌，
// 和开了 Plus 的样子一样。经过：44 → 50（用户要求下移一点）→ 88（挪到字下面，不挡字；
// 但不按 Alt 时悬在半空、按住 Alt 时和队友的 TP 圈挤成一排）→ 42（2026-10-14，挪到字上面）
const TIMERS_TOP = 42;
// 小地图**外框**比地图区域（minimapBox 给的那个正方形）大多少：顶边高出 5.3、靠屏幕中间那一侧宽出 7，
// 靠屏幕边那一侧外框一直到屏幕边。量自普通大小小地图的截图（2560×1600：外框顶边 1240px、右边到 360px，
// 地图区域顶边 1248、右边 350，2026-10-19）。特大小地图没单独量，按同样厚度算
const FRAME_TOP = 5.3, FRAME_SIDE = 7;
// 顶盖高度（未缩放，和 overlay.css 里 minibar 的 height 一致）
const MB_H = 42;
// 各块自己的基准大小。倒计时原先 0.62：圆环直径约 32，去掉数字之后一排五个刚好塞进
// 计时牌下面、两侧买活中间那块空地（用户指定的位置，2026-10-08）；之后缩到 0.5 嫌小，回到 0.6；
// 再参照 Dota Plus 的符文倒计时加了底盘、放到 0.72（实测外径约 35，Plus 自带的约 34、中心距约 40，
// 我们 42——比例基本一样），同时把格子从 60 收到 52，整排不变宽。
// 2026-10-14 挪到计时牌和 UNTIL NIGHT 之间，空当放不下 Plus 那么大的环，整体缩到 0.58（外径约 28，Plus 的八成）
const BASE = { timers: 0.58, minibar: 1 };
// 块的边框 1 + 上内边距 8：内容顶边离块顶边多远（未缩放）
const INSET = 9;

function placeBlocks(mmOpt) {
  const W = innerWidth, H = innerHeight;
  if (!W || !H) return;
  const k = H / 1080;
  // 缩放写在各块自己身上（不再写在容器上），因为两块的基准不一样
  const sc = (id) => {
    const s = k * BASE[id];
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

  // minibar：宽度 = 小地图外框的宽（屏幕边到外框另一侧），底边贴外框顶边。
  // 小地图在右边时只是整栏挪过去，内部顺序不变（用户定：不镜像）；只开一样时 .solo（不斜切）
  const b = els.blocks.minibar, sm = sc("minibar");
  const right = !!mmOpt.right;
  const solo = els.cells.econ.root.hidden !== els.glyph.hidden;
  if (prev["mb.s"] !== solo) { prev["mb.s"] = solo; b.classList.toggle("solo", solo); }
  const mm = minimapBox(mmOpt, W, H);
  const width = (right ? W - mm.left : mm.left + mm.size) / sm + FRAME_SIDE;   // 未缩放
  const wpx = `${width.toFixed(1)}px`;
  if (b.style.width !== wpx) b.style.width = wpx;
  put(b, right ? W - width * sm : 0, mm.top - FRAME_TOP * k - MB_H * sm);
}
