import { initWardMap, renderWardMap } from "./wardmap.js";
import { icon, CELL_ICON } from "./icons.js";

// Alt 面板渲染。DOM 只在 initPanel 建一次，render 仅改文本/类名/CSS 变量，避免每帧重建。
const SLOT_COLORS = ["#3375FF", "#66FFBF", "#BF00BF", "#F3F00B", "#FF6B00",
                     "#FE86C2", "#A1B447", "#65D9F7", "#008321", "#A46900"];
const R = 26, CIRC = 2 * Math.PI * R;
const TIMER_IDS = ["mid", "bounty", "lotus", "wisdom", "stack"];

// 四个可独立摆位的块。cells 用来判断"这一块是不是该整体隐藏"。
export const BLOCKS = [
  { id: "timers",  cells: ["mid", "bounty", "lotus", "wisdom", "stack"] },
  { id: "enemy",   cells: ["glyph", "buyback"] },
  { id: "econ",    cells: ["econ"] },
  { id: "wardmap", cells: ["wardmap"] },
];

// 块被整体隐藏时 offsetWidth 为 0，算默认摆位会把四块全挤到左上角。
// 这张表只用于兜底，取的是 1× 下实测的 offsetWidth/offsetHeight（含 1px 边框）。
// econ 比另两个矮，是因为它那格没有圆环、CSS 里写死了 height: 52px。
const NOMINAL = {
  timers: { w: 350, h: 85 }, enemy:   { w: 196, h: 85 },
  econ:   { w: 142, h: 70 }, wardmap: { w: 214, h: 213 },   // wardmap 随 wardSize 变，这是默认 180 时的值
};

let root = null, els = null, prev = {}, scale = 1;

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
  enemy: () => ring("glyph") + `
    <div class="cell wide" data-cell="buyback">
      <div class="bb-box">
        <div class="dots">${[0, 1, 2, 3, 4].map(i =>
          `<div class="dot" data-i="${i}"><i></i><span>--</span></div>`).join("")}</div>
        <div class="lab">${icon("buyback")}</div>
      </div>
    </div>`,
  econ: () => `
    <div class="cell wide econ" data-cell="econ">
      <div class="inline-row">
        <div class="lab">${icon("coin")}</div>
        <div class="nw">--</div>
      </div>
      <div class="rate"><span class="gpm">--</span><span class="xpm">--</span></div>
    </div>`,
  wardmap: () => `<div class="cell wide wardmap" data-cell="wardmap"></div>`,
};

// container（#panel）只是个容器，自己不带样式；块是 fixed 定位，父节点有没有尺寸都不影响。
export function initPanel(container, towers) {
  root = container;
  root.removeAttribute("hidden");
  root.innerHTML = BLOCKS.map(b =>
    `<div class="block" data-block="${b.id}">${INNER[b.id]()}</div>`).join("");

  els = { blocks: {}, cells: {},
          dots: [...root.querySelectorAll(".dot")].map(d => ({
            root: d, span: d.querySelector("span") })),
          nw: root.querySelector(".nw"),
          gpm: root.querySelector(".gpm"),
          xpm: root.querySelector(".xpm") };
  for (const b of BLOCKS) els.blocks[b.id] = root.querySelector(`[data-block="${b.id}"]`);
  for (const c of root.querySelectorAll("[data-cell]")) {
    els.cells[c.dataset.cell] = { root: c, num: c.querySelector(".num"),
      lab: c.querySelector(".lab"), fg: c.querySelector(".ring-fg") };
  }
  initWardMap(root.querySelector('[data-cell="wardmap"]'), towers);
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
  scale = cfg.scale ?? 1;
  // CSS 变量沿 DOM 树继承，设在容器上四个块都吃得到；缩放与透明度都走合成器，不触发重排
  root.style.setProperty("--panel-scale", scale);
  root.style.setProperty("--panel-opacity", cfg.opacity ?? 1);
  root.style.setProperty("--ward-size", `${cfg.wardSize ?? 180}px`);
  for (const [id, cell] of Object.entries(els.cells)) {
    cell.root.hidden = show[id] === false;
  }
  for (const b of BLOCKS) {
    const el = els.blocks[b.id];
    el.hidden = b.cells.every(id => show[id] === false);   // 整块关掉时连底板一起消失
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

  // 敌方塔防：ready 是威胁态，点亮；冷却中压暗并显示剩余
  const g = els.cells.glyph, gm = m.glyph || { ready: true, remaining: 0 };
  // 数字位永远只放数字：ready 时留空，靠环画满 + 盾点亮表达
  set(g.num, "g.n", gm.ready ? "" : fmt(gm.remaining));
  setHtml(g.lab, "g.l", icon("glyph"));
  const gu = gm.ready ? "now" : "far";
  if (prev["g.u"] !== gu) { prev["g.u"] = gu; g.root.dataset.urgency = gu; }
  if (prev["g.k"] !== 1) { prev["g.k"] = 1; g.root.style.setProperty("--accent", "var(--k-threat)"); }
  const gf = gm.ready ? 1 : Math.max(0, Math.min(1, gm.remaining / 300));
  const goff = (CIRC * (1 - gf)).toFixed(1);
  if (prev["g.o"] !== goff) { prev["g.o"] = goff; g.fg.style.strokeDashoffset = goff; }

  // 敌方买活：点亮 = 该敌人买活在冷却（可强杀），是机会态
  const byIdx = {};
  for (const b of m.buybacks || []) byIdx[b.slot % 5] = b;
  els.dots.forEach((d, i) => {
    const b = byIdx[i];
    if (prev["d" + i + ".c"] !== (b ? 1 : 0)) {
      prev["d" + i + ".c"] = b ? 1 : 0;
      d.root.dataset.on = b ? "1" : "0";
    }
    const color = SLOT_COLORS[(m.enemyBase ?? 5) + i] || "#888";
    if (prev["d" + i + ".col"] !== color) {
      prev["d" + i + ".col"] = color;
      d.root.style.setProperty("--slot", color);
    }
    set(d.span, "d" + i + ".t", b ? fmt(b.remaining) : "");
  });

  const e = m.econ || { networth: 0, gpm: 0, xpm: 0 };
  set(els.nw, "e.nw", e.networth.toLocaleString("en-US"));
  set(els.gpm, "e.gpm", `${e.gpm} GPM`);
  set(els.xpm, "e.xpm", `${e.xpm} XPM`);

  if (!wmOff) renderWardMap(m.wardmap || { wards: null, dead: [] });
}

/** 块在屏幕上的实际占位（offsetWidth 不含 transform，要自己乘缩放） */
function box(id) {
  const el = els.blocks[id];
  return { w: (el.offsetWidth  || NOMINAL[id].w) * scale,
           h: (el.offsetHeight || NOMINAL[id].h) * scale };
}

/** 把坐标钳进视口。块比视口还大时钳到 0，不让它跑到负数。 */
function clamp(id, p) {
  // 视口量不出来时绝不能钳：那会把四块全压到 (0,0)，而调用方会把结果回存，
  // 用户摆好的位置就没了。实测浏览器里改完窗口尺寸的头一帧 innerWidth 确实是 0。
  if (!innerWidth || !innerHeight) return { x: Math.round(p.x), y: Math.round(p.y) };
  const { w, h } = box(id);
  return { x: Math.round(Math.min(Math.max(0, p.x), Math.max(0, innerWidth  - w))),
           y: Math.round(Math.min(Math.max(0, p.y), Math.max(0, innerHeight - h))) };
}

/** 默认摆位：timers 与 enemy 都水平居中、上下叠放；econ 与 wardmap 靠左边缘叠放。
    全部按视口比例算，不写死像素——换分辨率也成立。
    y0 取屏高 7.5% 是为了让开 Dota 顶部计分板（1080 屏上是 81px）。 */
function defaultLayout() {
  const W = innerWidth, H = innerHeight, y0 = Math.round(H * 0.075), GAP = 10;
  const t = box("timers"), e = box("enemy"), c = box("econ");
  return {
    timers:  { x: Math.round((W - t.w) / 2), y: y0 },
    enemy:   { x: Math.round((W - e.w) / 2), y: Math.round(y0 + t.h + GAP) },
    econ:    { x: 16, y: y0 },
    wardmap: { x: 16, y: Math.round(y0 + c.h + GAP) },
  };
}

/** 摆位。视口量不出来时返回 null，表示"这次没摆"——调用方据此跳过写盘。
    实测浏览器里 navigate 之后的头几百毫秒 innerWidth 确实是 0，那时 defaultLayout
    会算出负坐标（(0 - 350) / 2 = -175），一旦被回存就毁掉了摆好的位置。 */
export function applyLayout(saved, panelScale = 1) {
  scale = panelScale;                    // 在首次 render 之前就要知道缩放，否则 box() 算错
  if (!innerWidth || !innerHeight) return null;
  const def = defaultLayout(), out = {};
  for (const b of BLOCKS) {
    const p = saved?.[b.id];
    out[b.id] = clamp(b.id, typeof p?.x === "number" ? p : def[b.id]);
    const el = els.blocks[b.id];
    el.style.left = `${out[b.id].x}px`;
    el.style.top  = `${out[b.id].y}px`;
  }
  return out;
}

// 编辑态拖拽：逐块绑定，只改 left/top，松手回调保存该块
export function enableDrag(onDrop) {
  for (const b of BLOCKS) {
    const el = els.blocks[b.id];
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    el.addEventListener("pointerdown", (ev) => {
      if (!el.classList.contains("edit")) return;
      dragging = true; el.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY;
      // 读 style 而不是 getBoundingClientRect：块被 scale 过，rect 的宽高含缩放，
      // 混着用会在缩放不为 1 时逐次漂移
      ox = parseFloat(el.style.left) || 0; oy = parseFloat(el.style.top) || 0;
    });
    el.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      el.style.left = `${ox + ev.clientX - sx}px`;
      el.style.top  = `${oy + ev.clientY - sy}px`;
    });
    el.addEventListener("pointerup", (ev) => {
      if (!dragging) return;
      dragging = false; el.releasePointerCapture(ev.pointerId);
      // 落点也钳一次：否则拖出屏幕的块要等到下次启动才回得来，本次会话里就丢了
      const p = clamp(b.id, { x: parseFloat(el.style.left) || 0,
                              y: parseFloat(el.style.top)  || 0 });
      el.style.left = `${p.x}px`;
      el.style.top  = `${p.y}px`;
      onDrop(b.id, p);
    });
  }
}
