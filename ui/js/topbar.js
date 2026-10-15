import { icon } from "./icons.js";

// 买活与敌方塔防**贴着 Dota 自己的顶栏画**：每个人的买活冷却在他头像正下方，
// 敌方塔防在敌方那一端的顶栏外侧。位置跟着游戏走，不进编辑态拖动。
//
// **顶栏固定天辉在左、夜魇在右**，自己打和观战都一样，每一侧内部按槽位从左到右。
// 2026-10-08 曾按用户的印象改成"敌方永远在左"——那几局用户恰好都在夜魇（敌方天辉本来就在左），
// 一局天辉的截图（10-09）推翻了它：按住 Alt 时只有队友才有的血条、TP 冷却圈都在**左边**，
// 而那局用户是天辉。
//
// 原先是一个独立可拖的块（塔防圆环 + 五个槽位色圆点），两个毛病：占地方；
// 圆点得去顶栏对颜色才知道是谁。贴到头像底下之后，**位置本身就是身份**。
// 见 design/overlay.md「顶栏锚定」。
//
// **几何量自一张 1047 高的实战截图，换算成 1080 高下的值**（2026-10-08）：
// Dota 的界面按屏幕高度等比缩放、顶栏水平居中，所以只记"离中线多远"，
// 任何分辨率都是 `中线 + 偏移 × 屏高/1080`。覆盖层窗口铺满主屏，视口就是屏幕。
// 例外是 4:3 拉伸（游戏横向拉伸了、视口却还是 16:9）和比 16:9 更窄的屏，没验过。
const REF_H = 1080;
const INNER = 138;      // 最靠中线那个头像的中心离中线多远
const PITCH = 62.3;     // 相邻头像中心的间距
// 买活这一行的中心。按住 Alt 时（不开 Dota Plus 也一样）头像下面从上到下是：
//   · 40~57  血条、蓝条、金条（能买活）——只有队友有
//   · 73~85  「打赏」按钮——双方都有
//   · 89~123 TP 冷却圈——只有队友有
// 另外阵亡时头像下挂复活倒计时框，底边到 64（不按 Alt 也在）。
// 取 68：文字约占 63.5~72.5，正好落在血条和「打赏」之间那段空当里，和复活框只擦个边。
// （量自 2560×1600 按住 Alt 的实战截图，2026-10-09；原先 74，再之前按一张模糊的 Plus 截图调成 71）
const BB_Y = 68;
// 敌方塔防：一个和倒计时同款的圆（直径约 37），中心离中线 434、离屏顶 19——
// 挨着顶栏最外侧那个头像（头像外缘在 413），高度和顶栏对齐（顶栏高约 38）。
// 原先是一条 120 宽的深色底板，里面放盾 + 数字 + 进度线，用户嫌太长（2026-10-09）
const GLYPH_X = 434, GLYPH_Y = 19;
const R = 26, CIRC = 2 * Math.PI * R;

/** 槽位（0-9，天辉 0-4、夜魇 5-9）的头像中心离中线多远。天辉 0 号最左，夜魇 9 号最右 */
function slotX(slot) {
  return slot < 5 ? -(INNER + PITCH * (4 - slot)) : INNER + PITCH * (slot - 5);
}

let els = null, prev = {}, geo = "";

export function initTopbar(root) {
  root.insertAdjacentHTML("beforeend",
    Array.from({ length: 10 }, (_, s) =>
      `<div class="tb tb-bb" data-slot="${s}">${icon("buyback")}<span>--</span></div>`).join("") +
    `<div class="tb tb-glyph">
       <svg class="ring" viewBox="0 0 60 60" aria-hidden="true">
         <circle class="ring-bg" cx="30" cy="30" r="${R}"/>
         <circle class="ring-fg" cx="30" cy="30" r="${R}" stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
       </svg>
       <div class="tb-glyph-ico">${icon("glyph")}<span></span></div>
     </div>`);
  els = {
    bb: [...root.querySelectorAll(".tb-bb")].map(r => ({ root: r, num: r.querySelector("span") })),
    glyph: root.querySelector(".tb-glyph"),
  };
  els.gring = els.glyph.querySelector(".ring-fg");
  els.gnum = els.glyph.querySelector(".tb-glyph-ico span");
  prev = {}; geo = "";
}

function fmt(sec) {
  return sec < 60 ? String(sec) : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function attr(node, key, name, value) {    // 只在变化时写 DOM，同 render.js
  if (prev[key] === value) return;
  prev[key] = value;
  node.dataset[name] = value;
}

/** 摆位只在视口或自己的阵营变了时才重算。缩放用 --hud-k 交给 CSS——
    这一层的大小要跟着头像走。 */
function place(root, myTeam) {
  const W = innerWidth, H = innerHeight;
  const key = `${W}x${H}:${myTeam}`;
  if (!W || !H || key === geo) return;
  geo = key;
  const k = H / REF_H, cx = W / 2;
  root.style.setProperty("--hud-k", k);
  els.bb.forEach((b, s) => {
    b.root.style.left = `${cx + slotX(s) * k}px`;
    b.root.style.top = `${BB_Y * k}px`;
  });
  // 敌方在哪一头：我方天辉 → 敌方夜魇在右；我方夜魇 → 敌方天辉在左。
  // 还不知道自己是哪一方时（没开局、编辑态）按天辉算，画在右边。
  const enemyLeft = myTeam === 3;
  els.glyph.style.left = `${cx + (enemyLeft ? -GLYPH_X : GLYPH_X) * k}px`;
  els.glyph.style.top = `${GLYPH_Y * k}px`;
}

export function renderTopbar(root, m, show) {
  if (!els) return;
  place(root, m.myTeam);
  const on = !!m.visible, edit = !!m.editMode;

  const bbOff = show.buyback === false;
  const cd = {};
  for (const b of m.buybacks || []) cd[b.slot] = b.remaining;
  els.bb.forEach((b, s) => {
    b.root.hidden = bbOff;
    const rem = cd[s];
    // 不在冷却的那一格平时什么都不画；编辑态画成占位框，好让人一眼看出十个位置对不对得上头像
    attr(b.root, `b${s}.v`, "v", rem ? "1" : edit ? "slot" : "0");
    b.root.classList.toggle("on", on);
    const txt = rem ? fmt(rem) : "--";
    if (prev[`b${s}.t`] !== txt) { prev[`b${s}.t`] = txt; b.num.textContent = txt; }
  });

  const g = els.glyph, gm = m.glyph || { ready: true, remaining: 0, total: 300 };
  g.hidden = show.glyph === false;
  g.classList.toggle("on", on);
  attr(g, "g.r", "ready", gm.ready ? "1" : "0");
  // 剩下多少冷却环就有多长（逆时针退回 12 点）；好了的时候环是满的，塔点亮——
  // "敌方此刻有塔防"是威胁态，要最显眼。
  // **冷却中在圆心写剩余时间**（和游戏里技能、塔防按钮冷却时一样，压在变暗的图标上）：
  // 倒计时那排不写数字，但塔防要算"还剩几秒能强推"，用户要精确值（2026-10-09）
  const txt = gm.ready ? "" : fmt(gm.remaining);
  if (prev["g.t"] !== txt) { prev["g.t"] = txt; els.gnum.textContent = txt; }
  const frac = gm.ready ? 1 : Math.max(0, Math.min(1, gm.remaining / (gm.total || 300)));
  const off = (CIRC * (1 - frac)).toFixed(1);
  if (prev["g.o"] !== off) { prev["g.o"] = off; els.gring.style.strokeDashoffset = off; }
}
