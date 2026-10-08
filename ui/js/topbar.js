import { icon } from "./icons.js";

// 买活与敌方塔防**贴着 Dota 自己的顶栏画**：每个人的买活冷却在他头像正下方，
// 敌方塔防在左端那块空底板里。位置跟着游戏走，不进编辑态拖动。
//
// **自己打的时候顶栏是"敌方在左、己方在右"**，不管自己是天辉还是夜魇（用户实测，
// 2026-10-08）。只有观战和看录像才是固定的天辉左、夜魇右——而那两种场合覆盖层整个藏起来，
// 所以这里只按"敌左我右"排，每一侧内部按槽位从左到右（2026-10-08 实战核过）。
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
// 买活这一行的中心。两头都有原生的东西，要夹在中间：
//   · 上面：阵亡后头像下面挂复活倒计时框，底边到 64——死人的复活时间正是看买活时最想同时看到的；
//     开了 Dota Plus 按住 Alt 时，头像下面是血条、蓝条、金条（能买活），金条底边约 57
//   · 下面：开了 Dota Plus 按住 Alt 时，再往下一排是 TP 冷却圈，顶边约 83
// 取 71：文字约占 66.5~75.5，离金条 9、离 TP 圈 7.5，离复活框 2.5（2026-10-09 按 Plus 截图调，原先 74）
const BB_Y = 71;
// 顶栏两头的空底板：离中线 414~533、高 34。塔防放在左边那块——敌方永远在左
const STRIP_IN = 414, STRIP_OUT = 533, STRIP_H = 34;

/** 槽位（0-9，天辉 0-4、夜魇 5-9）的头像中心离中线多远。
    敌方那一队排在左边、己方排在右边，每队内部槽位小的在左。
    还不知道自己是哪一方时（没开局、编辑态摆位置）按天辉算——编辑态的占位十个都画，
    排法不影响它们的位置。 */
function slotX(slot, myTeam) {
  const mine = (slot < 5 ? 2 : 3) === (myTeam === 3 ? 3 : 2);
  const i = slot % 5;
  return mine ? INNER + PITCH * i : -(INNER + PITCH * (4 - i));
}

let els = null, prev = {}, geo = "";

export function initTopbar(root) {
  root.insertAdjacentHTML("beforeend",
    Array.from({ length: 10 }, (_, s) =>
      `<div class="tb tb-bb" data-slot="${s}">${icon("buyback")}<span>--</span></div>`).join("") +
    `<div class="tb tb-glyph">${icon("glyph")}<span></span><i></i></div>`);
  els = {
    bb: [...root.querySelectorAll(".tb-bb")].map(r => ({ root: r, num: r.querySelector("span") })),
    glyph: root.querySelector(".tb-glyph"),
  };
  els.gnum = els.glyph.querySelector("span");
  els.gbar = els.glyph.querySelector("i");
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
    b.root.style.left = `${cx + slotX(s, myTeam) * k}px`;
    b.root.style.top = `${BB_Y * k}px`;
  });
  // 底板是从左上角缩放的（transform-origin: top left），所以给它的左边缘
  els.glyph.style.left = `${cx - STRIP_OUT * k}px`;
  els.glyph.style.width = `${STRIP_OUT - STRIP_IN}px`;
  els.glyph.style.height = `${STRIP_H}px`;
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
  // 数字位永远只放数字：ready 时留空，靠盾填实表达（和原先圆环那一版同一条规矩）
  const txt = gm.ready ? "" : fmt(gm.remaining);
  if (prev["g.t"] !== txt) { prev["g.t"] = txt; els.gnum.textContent = txt; }
  // 底边那条线是原先圆环的对应物：剩下多少冷却就有多长
  const frac = gm.ready ? 0 : Math.max(0, Math.min(1, gm.remaining / (gm.total || 300)));
  const f = frac.toFixed(3);
  if (prev["g.f"] !== f) { prev["g.f"] = f; els.gbar.style.transform = `scaleX(${f})`; }
}
