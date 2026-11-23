// 眼位**直接画在 Dota 的小地图上**（2026-10-08 起）。原先是一块自带底图（塔 + 我方眼 +
// 敌方眼）的独立小地图，可拖、可调大小。贴上去之后只画原生小地图**不显示**的两样：
//   · 敌方眼：原生只在真视罩着时才画，一离开就没了；我们记住它，实心画到寿命上限（不知何时插的外面套一圈虚线）
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

// 我方眼的到期倒计时：只在最后 LABEL_BELOW 秒标数字，最后 URGENT 秒变琥珀（2026-10-09）。
// 眼本身原生小地图画着，我们只在它正上方补一个秒数——原生不说还剩多久。
// 只标最后 60 秒：实测满屏最多 14 个己方眼，全标会糊成一片，而要的信息本就是"哪个快没了该补了"。
// 程序启动前就插下的眼不知道插放时刻（remaining 为 null），不标。
const LABEL_BELOW = 60, URGENT = 10;

// **敌方眼画成和游戏里同样的形状，只是换成品红**（2026-10-08）。
// 原先是红色圆点：原生小地图上小兵、敌方英雄本来就是红色小圆点，一混就分不出来。
// 形状照抄原生小地图（用户截图里放大对过）：
//   · 假眼：黑色眼眶，上面一个半圆瞳孔，下面一道弧线当下眼睑
//   · 真眼：空心的柠檬形，一圈粗边套黑描边
// 原生自己的眼是绿色的同款形状，所以一看就知道"这是眼"；颜色用品红，
// 因为原生小地图上没有任何东西用它——放在哪都跳出来，不会被红兵红塔吃掉。
// 大小约为原生的八成：叠在原生图标旁边时不至于把它盖住。
// 坐标都是 viewBox 单位、以 (0,0) 为中心；图例复用这个函数，所以图例和地图永远一致。
//
// **不知何时插的敌方眼（unsure）：原生图标不动，外面套一圈品红虚线**（2026-11-23，用户从几轮示意图里挑的 R2）。
// 假眼、真眼都画（第一次看见时旁边没有敌方英雄的）。演变：
//   · 11-21 起只给真眼、在眼上压品红问号（G）。实战反馈**和普通敌方眼分不出来**：实际大小下眼只有十几像素，
//     同色同轮廓、只多一个问号，看上去是同一种东西
//   · 换轮廓的几种（菱形问号等）能分开了，但用户指出**有了问号就看不出真假眼**——中间那块被问号占了
//   · 所以图标保持原生的样子（真假眼一眼可辨），"不确定"放在外面：一圈虚线，整体轮廓变大变圆，和普通眼分得开。
//     代价是多挡一点旁边的东西，圈贴紧、线细一点（半径 3.4、线宽 .45）就是为了少挡
// 不确定靠形状表达，不靠透明度（淡化在实战里看不出来，已去掉，见 renderWardMap）。
const LENS = "M-2.3 0Q0 -3.1 2.3 0Q0 3.1 -2.3 0Z";
const BALL = "M-2.4 .1Q0 -3.1 2.4 .1Q0 3 -2.4 .1Z";
const RING = `<circle class="wm-ring-under" r="3.4"/><circle class="wm-ring" r="3.4"/>`;
export function wardIcon(kind, x, y, scale = 1, extra = "", unsure = false) {
  const t = `transform="translate(${x} ${y})${scale !== 1 ? ` scale(${scale})` : ""}"`;
  const ring = unsure ? RING : "";
  return kind === "sentry"
    ? `<g class="wm-eye" ${t}${extra}>${ring}<path class="wm-eye-under" d="${LENS}"/>` +
      `<path class="wm-eye-line" d="${LENS}"/></g>`
    : `<g class="wm-eye" ${t}${extra}>${ring}<path class="wm-eye-ball" d="${BALL}"/>` +
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

/** 原生小地图那个 ±8400 正方形在屏幕上的位置（像素）：左、上、边长。
    净资产和敌方塔防那一栏贴在它上方，也用这个（render.js 的 minibar）。 */
export function minimapBox(opt, W = innerWidth, H = innerHeight) {
  const g = opt.large ? GEO.large : GEO.normal, k = H / 1080;
  const size = 2 * g.half * k;
  const cx = opt.right ? W - g.cx * k : g.cx * k;
  return { left: cx - size / 2, top: H - g.cy * k - size / 2, size };
}

/** 摆到小地图上。只在视口或小地图设置变了时才重算。 */
function place(opt) {
  const W = innerWidth, H = innerHeight;
  const key = `${W}x${H}:${opt.large}:${opt.right}`;
  if (!W || !H || key === geo) return;
  geo = key;
  const b = minimapBox(opt, W, H);
  root.style.left = `${b.left}px`;
  root.style.top = `${b.top}px`;
  root.style.width = root.style.height = `${b.size}px`;
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
  const w = m.wards || { own: [], enemy: [], killed: [] };
  // 真假眼的形状见上面的 wardIcon。
  // **一律实心，不再按"多久没看见"淡化**（2026-11-21，用户定）。原先 0.12 + 0.88 × conf，
  // 用户实战里反馈淡化很不明显、淡了也照样误导；而五对 7.42 成对录制里幽灵全出在"没看见插眼的真眼"，
  // 假眼和看见插眼的真眼没视野时画着的 2513 秒全是活的。所以确定的画实心，不确定的外面套一圈虚线（unsure），
  // 删除时机照旧是"第一次看见 + 寿命"（minimap.js）。
  const dot = (o) => wardIcon(o.kind, sx(o.x).toFixed(1), sy(o.y).toFixed(1), 1, "", !!o.unsure);
  // 被排的画叉不画点（见 crossIcon）。半径 R_DOT 比眼略小，两者在图上是同一个量级的东西。
  // 显示 wardKilledShow 秒（45），期间一直实心、到点消失（2026-11-21 起；原先按时间淡出，同上不明显）。
  const cross = (o) => crossIcon(sx(o.x), sy(o.y), R_DOT);
  // **有视野的敌方眼不画**（2026-10-09）：那时原生小地图正画着它，再画一遍就叠在一起。
  // 一离开视野原生的图标就没了，我们的标记在同一个位置接上——视野盲区（被树挡住之类）
  // 里的眼，正是这一层该出场的时候。代价是离开视野后最多晚一包（1~2 秒）才出现。
  const label = (o) =>
    `<text class="wm-own-t${o.remaining <= URGENT ? " urgent" : ""}" ` +
    `x="${sx(o.x).toFixed(1)}" y="${(sy(o.y) - 2.6).toFixed(1)}">${o.remaining}</text>`;
  wardLayer.innerHTML = w.enemy.filter(o => !o.visible).map(dot).join("") +
                        w.killed.map(cross).join("") +
                        // 到 0 就不写：眼在游戏里已经没了，GSI 还会多报 7 秒左右（见 wards.md），
                        // 不挡的话一个"0"会飘在空地上（2026-10-11 截图里看到的）
                        (w.own || []).filter(o => o.remaining !== null && o.remaining > 0 && o.remaining <= LABEL_BELOW)
                          .map(label).join("");
}
