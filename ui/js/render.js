// Alt 面板渲染。DOM 只在 initPanel 建一次，render 仅改文本/类名/CSS 变量，避免每帧重建。
const SLOT_COLORS = ["#3375FF", "#66FFBF", "#BF00BF", "#F3F00B", "#FF6B00",
                     "#FE86C2", "#A1B447", "#65D9F7", "#008321", "#A46900"];
const R = 26, CIRC = 2 * Math.PI * R;
const TIMER_IDS = ["mid", "bounty", "lotus", "wisdom", "stack"];

let root = null, els = null, prev = {};

function ring(id) {
  return `<div class="cell" data-cell="${id}" data-urgency="far">
    <svg viewBox="0 0 60 60" aria-hidden="true">
      <circle class="ring-bg" cx="30" cy="30" r="${R}"/>
      <circle class="ring-fg" cx="30" cy="30" r="${R}"
              stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
    </svg>
    <div class="num">--</div>
    <div class="lab">--</div>
  </div>`;
}

export function initPanel(el) {
  root = el;
  root.className = "panel";
  root.removeAttribute("hidden");
  root.innerHTML = `
    <div class="grp">${TIMER_IDS.map(ring).join("")}</div>
    <div class="sep"></div>
    <div class="grp">
      ${ring("glyph")}
      <div class="cell wide" data-cell="buyback">
        <div class="dots">${[0, 1, 2, 3, 4].map(i =>
          `<div class="dot" data-i="${i}"><i></i><span>--</span></div>`).join("")}</div>
        <div class="lab">敌买活</div>
      </div>
    </div>
    <div class="sep"></div>
    <div class="grp">
      <div class="cell wide econ">
        <div class="nw">--</div>
        <div class="rate"><span class="gpm">--</span><span class="xpm">--</span></div>
        <div class="lab">净资产</div>
      </div>
    </div>`;

  els = { cells: {}, dots: [...root.querySelectorAll(".dot")].map(d => ({
            root: d, span: d.querySelector("span") })),
          nw: root.querySelector(".nw"),
          gpm: root.querySelector(".gpm"),
          xpm: root.querySelector(".xpm") };
  for (const c of root.querySelectorAll("[data-cell]")) {
    els.cells[c.dataset.cell] = { root: c, num: c.querySelector(".num"),
      lab: c.querySelector(".lab"), fg: c.querySelector(".ring-fg") };
  }
  prev = {};
}

function set(node, key, value) {           // 只在变化时写 DOM
  if (prev[key] === value) return;
  prev[key] = value;
  node.textContent = value;
}

function fmt(sec) {
  if (sec <= 0) return "0";
  return sec < 60 ? String(sec) : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function urgency(sec) { return sec <= 10 ? "now" : sec <= 30 ? "near" : "far"; }

export function render(m) {
  if (!root) return;
  root.classList.toggle("on", !!m.visible);
  root.classList.toggle("edit", !!m.editMode);

  for (const t of m.timers || []) {
    const c = els.cells[t.id];
    if (!c) continue;
    set(c.num, t.id + ".n", fmt(t.remaining));
    set(c.lab, t.id + ".l", t.id === "mid" ? `中·${t.label}` : t.label);
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
  set(g.num, "g.n", gm.ready ? "可用" : fmt(gm.remaining));
  set(g.lab, "g.l", "敌塔防");
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
}

// 编辑态拖拽：只改 left/top，松手回调保存
export function enableDrag(onDrop) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  root.addEventListener("pointerdown", (ev) => {
    if (!root.classList.contains("edit")) return;
    dragging = true; root.setPointerCapture(ev.pointerId);
    sx = ev.clientX; sy = ev.clientY;
    const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
  });
  root.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    root.style.left = `${ox + ev.clientX - sx}px`;
    root.style.top = `${oy + ev.clientY - sy}px`;
    root.style.transform = "none";
  });
  root.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false; root.releasePointerCapture(ev.pointerId);
    const r = root.getBoundingClientRect();
    onDrop && onDrop({ x: Math.round(r.left), y: Math.round(r.top) });
  });
}

export function applyLayout(pos) {
  if (!root || !pos || typeof pos.x !== "number") return;
  root.style.left = `${pos.x}px`;
  root.style.top = `${pos.y}px`;
  root.style.transform = "none";
}
