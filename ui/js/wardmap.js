// 眼位**直接画在 Dota 的小地图上**（2026-10-08 起）。原先是一块自带底图（塔 + 我方眼 +
// 敌方眼）的独立小地图，可拖、可调大小。贴上去之后只画原生小地图**不显示**的两样：
//   · 敌方眼：原生只在真视罩着时才画，一离开就没了；我们记住它、按多久没看见淡化
//   · 我方眼刚被排掉的叉：原生不提示
// 塔和我方眼不画——原生小地图本来就画着，再画一遍是重复。
//
// 地图是 ±8400 正方形，游戏坐标 x 向右、y 向上，画到屏幕 y 要翻转。
// 校准：天辉泉水 (-7456,-6938) 应落在左下角，夜魇 (7408,6848) 落在右上角。
const HALF = 8400, SIZE = 108;

// **小地图的几何**：从两张实战截图（2560×1600，普通 / 加大小地图）里用 22 座塔的图标
// 反推"世界坐标 → 屏幕像素"，平均误差约 1px（2026-10-08）。换算成 1080 高下、
// 以屏幕左下角为原点的值。Dota 的界面按屏高等比缩放（顶栏在 16:9 和 16:10 上都核过），
// 所以任何分辨率都是 `值 × 屏高/1080`；小地图靠右时 x 从右边量——就是左边的镜像，
// 用一张靠右的截图核过，中心差不到 1px、大小一样。
//   cx / cy：±8400 那个正方形的中心离左边 / 底边多远；half：正方形的半边长
const GEO = {
  normal: { cx: 120.6, cy: 122.3, half: 115.4 },
  large:  { cx: 138.9, cy: 140.3, half: 131.7 },
};

// 叉的半径（viewBox 单位）。原先独立小地图时是 2.2；贴到原生小地图上之后
// 比原生的眼位图标还大一圈（换算到 1080 高，原生敌方眼直径约 9，我们约 11.5），
// 盖住了原生图标。缩到 1.6——比原生的小，叠在旁边也认得出是哪一个。
const R_DOT = 1.6;

// **敌方眼画成和游戏里同样的形状，只是换成品红**（2026-10-08）。
// 原先是红色圆点：原生小地图上小兵、敌方英雄本来就是红色小圆点，一混就分不出来。
// 形状照抄原生小地图（用户截图里放大对过）：
//   · 假眼：黑色眼眶，上面一个半圆瞳孔，下面一道弧线当下眼睑
//   · 真眼：空心的柠檬形，一圈粗边套黑描边
// 原生自己的眼是绿色的同款形状，所以一看就知道"这是眼"；颜色用品红，
// 因为原生小地图上没有任何东西用它——放在哪都跳出来，不会被红兵红塔吃掉。
// 大小约为原生的八成：叠在原生图标旁边时不至于把它盖住。
// 坐标都是 viewBox 单位、以 (0,0) 为中心；图例复用这个函数，所以图例和地图永远一致。
const LENS = "M-2.3 0Q0 -3.1 2.3 0Q0 3.1 -2.3 0Z";
const BALL = "M-2.4 .1Q0 -3.1 2.4 .1Q0 3 -2.4 .1Z";
export function wardIcon(kind, x, y, scale = 1, extra = "") {
  const t = `transform="translate(${x} ${y})${scale !== 1 ? ` scale(${scale})` : ""}"`;
  return kind === "sentry"
    ? `<g class="wm-eye" ${t}${extra}><path class="wm-eye-under" d="${LENS}"/>` +
      `<path class="wm-eye-line" d="${LENS}"/></g>`
    : `<g class="wm-eye" ${t}${extra}><path class="wm-eye-ball" d="${BALL}"/>` +
      `<path class="wm-eye-pupil" d="M-.85 -.1A.85 .85 0 0 1 .85 -.1Z"/>` +
      `<path class="wm-eye-lid" d="M-1.55 .3Q0 1.8 1.55 .3"/></g>`;
}

/** 我方眼被排掉的叉：**绿色 + 黑描边**（2026-10-08 起，原先是青色）。
    绿色是原生小地图上我方眼的颜色、黑描边也和原生图标一样——读起来就是"这里原来有个我方眼，没了"，
    和品红眼睛（敌方、还在）正好对称：颜色分敌我，形状分在不在。
    青色的毛病是压在河道上看不见：简易背景下河道正是浅蓝，而河道恰恰是最常插眼的地方。
    图例复用这个函数。 */
export function crossIcon(x, y, r = R_DOT, extra = "") {
  const d = `M${(x - r).toFixed(1)} ${(y - r).toFixed(1)}L${(x + r).toFixed(1)} ${(y + r).toFixed(1)}` +
            `M${(x + r).toFixed(1)} ${(y - r).toFixed(1)}L${(x - r).toFixed(1)} ${(y + r).toFixed(1)}`;
  return `<g class="wm-kill"${extra}><path class="wm-kill-under" d="${d}"/><path class="wm-kill-line" d="${d}"/></g>`;
}

const sx = x => (x + HALF) / (HALF * 2) * SIZE;
const sy = y => (1 - (y + HALF) / (HALF * 2)) * SIZE;

let root = null, towerLayer = null, wardLayer = null, allTowers = [], prevDead = null, geo = "";

export function initWardMap(container, towers) {
  allTowers = towers.towers;
  container.innerHTML =
    `<svg class="wardmap" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true">
       <rect class="wm-frame" x="0" y="0" width="${SIZE}" height="${SIZE}"/>
       <g class="wm-towers"></g>
       <g class="wm-wards"></g>
     </svg>`;
  root = container;
  towerLayer = container.querySelector(".wm-towers");
  wardLayer = container.querySelector(".wm-wards");
  prevDead = null; geo = "";
}

/** 摆到小地图上。只在视口或小地图设置变了时才重算。 */
function place(opt) {
  const W = innerWidth, H = innerHeight;
  const key = `${W}x${H}:${opt.large}:${opt.right}`;
  if (!W || !H || key === geo) return;
  geo = key;
  const g = opt.large ? GEO.large : GEO.normal, k = H / 1080;
  const size = 2 * g.half * k;
  const cx = opt.right ? W - g.cx * k : g.cx * k;
  root.style.left = `${cx - size / 2}px`;
  root.style.top = `${H - g.cy * k - size / 2}px`;
  root.style.width = root.style.height = `${size}px`;
}

/** 塔只在编辑态画，当作对齐的参照：进编辑态看一眼，我们的塔压不压在原生的塔上，
    就知道这一层摆得准不准。被推掉的不画——原生小地图上它也没了，画出来对不上。 */
function drawTowers(dead, edit) {
  const key = edit ? dead.map(t => `${t.x},${t.y}`).join(";") : "off";
  if (key === prevDead) return;
  prevDead = key;
  if (!edit) { towerLayer.innerHTML = ""; return; }
  const isDead = t => dead.some(d => d.x === t.x && d.y === t.y);
  towerLayer.innerHTML = allTowers.filter(t => !isDead(t)).map(t =>
    `<rect class="wm-tower" x="${(sx(t.x) - 1.4).toFixed(1)}" y="${(sy(t.y) - 1.4).toFixed(1)}" ` +
    `width="2.8" height="2.8"/>`).join("");
}

export function renderWardMap(m, opt, edit) {
  if (!root) return;
  place(opt);
  drawTowers(m.dead || [], edit);
  const w = m.wards || { enemy: [], killed: [] };
  // 真假眼的形状见上面的 wardIcon。
  // 敌方眼带 conf（这条线索有多新）：刚在真视里确认过的实心，久未确认的淡。
  //
  // **下限 0.12**（2026-09-21 从 0.3 降下来）。仍然不给 0——线索再旧也不该彻底
  // 消失，漏显示才是危险的那一侧。但 0.3 太实了：**敌方眼自然到期时 GSI 不推任何
  // 东西**（实测过，游戏里那个残留特效是客户端粒子不是实体），所以一个早就死了的眼
  // 会按"第一次看见 + 寿命"这个**上界**一直挂着——而我们往往是它活了一半才第一次
  // 看见的，于是幽灵能挂好几分钟。0.3 的圆点看着和真眼一样确凿，0.12 才像"记忆"。
  //
  // 治本要知道眼什么时候到期，而 GSI 给不了；这里能做的只有把不确定画出来。
  const dot = (o) => wardIcon(o.kind, sx(o.x).toFixed(1), sy(o.y).toFixed(1), 1,
    typeof o.conf === "number" ? ` opacity="${(0.12 + 0.88 * o.conf).toFixed(2)}"` : "");
  // 被排的画叉不画点（见 crossIcon）。半径 R_DOT 比眼略小，两者在图上是同一个量级的东西。
  //
  // **叉也按 conf 淡化**（2026-09-23），和上面敌方眼同一个公式。原先是"实心显示
  // N 秒然后啪地消失"，时长一放长就变成一片同样实的叉、分不出哪个是刚发生的。
  // 淡化之后新旧一眼可分，时长才敢从 3 秒放到 20 秒（2026-10-08 再放到 45 秒）。
  const cross = (o) => crossIcon(sx(o.x), sy(o.y), R_DOT,
    typeof o.conf === "number" ? ` opacity="${(0.12 + 0.88 * o.conf).toFixed(2)}"` : "");
  wardLayer.innerHTML = w.enemy.map(dot).join("") + w.killed.map(cross).join("");
}
