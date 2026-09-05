// 地图是 ±8400 正方形，游戏坐标 x 向右、y 向上，画到屏幕 y 要翻转。
// 校准：天辉泉水 (-7456,-6938) 应落在左下角，夜魇 (7408,6848) 落在右上角。
const HALF = 8400, SIZE = 108;

// 只给快到期的眼标数字。实测终局高地战时己方眼可同时有 14 颗，
// 14 个数字挤在 108px 上会糊成一团，而你要的信息本就是"哪颗快没了该补了"。
const LABEL_BELOW = 60;

const sx = x => (x + HALF) / (HALF * 2) * SIZE;
const sy = y => (1 - (y + HALF) / (HALF * 2)) * SIZE;

let root = null, towerLayer = null, wardLayer = null, allTowers = [], prevDead = null;

export function initWardMap(container, towers) {
  allTowers = towers.towers;
  container.innerHTML =
    `<svg class="wardmap" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true">
       <rect class="wm-bg" x="0" y="0" width="${SIZE}" height="${SIZE}" rx="4"/>
       <g class="wm-towers"></g>
       <g class="wm-wards"></g>
     </svg>
     <div class="lab">眼位</div>`;
  root = container;
  towerLayer = container.querySelector(".wm-towers");
  wardLayer = container.querySelector(".wm-wards");
  prevDead = null;
  drawTowers([]);
}

function drawTowers(dead) {
  const key = dead.map(t => `${t.x},${t.y}`).join(";");
  if (key === prevDead) return;               // 塔的状态很少变，变了才重画
  prevDead = key;
  const isDead = t => dead.some(d => d.x === t.x && d.y === t.y);
  towerLayer.innerHTML = allTowers.map(t =>
    `<rect class="wm-tower${isDead(t) ? " dead" : ""}" ` +
    `x="${(sx(t.x) - 1.4).toFixed(1)}" y="${(sy(t.y) - 1.4).toFixed(1)}" ` +
    `width="2.8" height="2.8" data-team="${t.team}"/>`).join("");
}

function fmt(sec) {
  return sec < 60 ? String(sec)
                  : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function renderWardMap(m) {
  if (!root) return;
  drawTowers(m.dead || []);
  const w = m.wards || { own: [], enemy: [], killed: [] };
  const dot = (o, cls) =>
    `<circle class="wm-ward ${cls}" cx="${sx(o.x).toFixed(1)}" cy="${sy(o.y).toFixed(1)}" r="2.2"/>`;
  const label = o => (o.remaining === null || o.remaining > LABEL_BELOW) ? "" :
    `<text class="wm-t" x="${sx(o.x).toFixed(1)}" y="${(sy(o.y) - 3.4).toFixed(1)}">${fmt(o.remaining)}</text>`;
  wardLayer.innerHTML =
    w.enemy.map(o => dot(o, "enemy")).join("") +
    w.own.map(o => dot(o, "own" + (o.remaining !== null && o.remaining <= LABEL_BELOW ? " soon" : "")) + label(o)).join("") +
    w.killed.map(o => dot(o, "killed")).join("");
}
