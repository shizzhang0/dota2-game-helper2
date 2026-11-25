// "真视 + 视野照到了却没出现就删"的视野模型（2026-11-25，影子统计，**程序里还没用**）。
// 见 docs/design/wards.md「用地形高度和树判断看不看得见」。
//
// 判断一个记着的敌方眼所在的点 p 此刻是不是真的对我们可见：
//   · 真视：1000 以内有我方真眼（照射 1050 扣一点），或者自己带着宝石、900 以内（扣到 850）
//   · 普通视野：有个我方单位离 p 不超过它的 visionrange − 150（两包之间会走动），而且
//       - 它所在的地面不低于 p（低处看不到高处，容差 32）
//       - 视线上没有比它更高的地形，也没有树（树所在格和周围一圈都算挡；按"树都在"算，砍掉的只会让实际更看得见）
// 可见却没出现、连续 2 秒，记一次候选；**再等 8 秒确认**当时给真视的那个真眼还在报——
// 眼死后 GSI 还会报 6~7 秒尸体，刚被排掉的我方真眼会让模型以为那里还有真视（不确认时十二对里误删的 5 次全是这个）。
// 拿不准的一律当看不见：宁可少删。
//
// 地形高度和树来自 tools/map_dump.py 导出的 devdata/map_dump.json（不进 git）。

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MAP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "devdata", "map_dump.json");

const P = {
  margin: 150, hTol: 32, treeR: 1, step: 32,
  sentrySight: 1000, gemSight: 850,
  hold: 2, confirm: 8,
};

/** 读地图数据；没有就返回 null（调用方提示去跑 tools/map_dump.py） */
export function loadMap(path = MAP_PATH) {
  if (!existsSync(path)) return null;
  const m = JSON.parse(readFileSync(path, "utf8"));
  const tree = new Uint8Array(m.w * m.h);
  for (const [x, y] of m.trees) {
    const c = Math.floor((x - m.x0) / m.cell), r = Math.floor((y - m.y0) / m.cell);
    if (c >= 0 && c < m.w && r >= 0 && r < m.h) tree[r * m.w + c] = 1;
  }
  return { ...m, tree };
}

export class WardVision {
  constructor(map) {
    this.m = map;
    this.cand = new Map();       // 敌方眼 key -> 连续"可见却没出现"的起始时刻
    this.pend = new Map();       // key|firstSeen -> { t0, src }：等确认
    this.done = new Set();       // key|firstSeen：已经"删了"
  }

  ground(x, y) {
    const { cell, x0, y0, w, h, heights } = this.m;
    const c = Math.floor((x - x0) / cell), r = Math.floor((y - y0) / cell);
    return c < 0 || c >= w || r < 0 || r >= h ? -16384 : heights[r * w + c];
  }

  treeNear(x, y) {
    const { cell, x0, y0, w, h, tree } = this.m;
    const c = Math.floor((x - x0) / cell), r = Math.floor((y - y0) / cell);
    for (let dr = -P.treeR; dr <= P.treeR; dr++) for (let dc = -P.treeR; dc <= P.treeR; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < h && cc >= 0 && cc < w && tree[rr * w + cc]) return true;
    }
    return false;
  }

  /** 单位 u（x, y, vr）能不能用普通视野看到点 p */
  sees(u, p) {
    const d = Math.hypot(u.x - p.x, u.y - p.y);
    if (d > u.vr - P.margin) return false;
    const hu = this.ground(u.x, u.y), hp = this.ground(p.x, p.y);
    if (hu < -1000 || hp < -1000) return false;
    if (hu + P.hTol < hp) return false;
    const n = Math.max(1, Math.floor(d / P.step));
    for (let i = 1; i < n; i++) {
      const x = u.x + (p.x - u.x) * i / n, y = u.y + (p.y - u.y) * i / n;
      if (this.ground(x, y) > hu + P.hTol) return false;
      // 起点 / 终点那一格不算：单位、眼本身可能紧贴着树
      if (i * P.step > 64 && d - i * P.step > 64 && this.treeNear(x, y)) return false;
    }
    return true;
  }

  /** 每包调一次。返回这一包新"删掉"的敌方眼：[{ key, firstSeen, kind, x, y, unsure }] */
  update(st, info, wards) {
    const c = info.clock, me = info.myTeam;
    if (c === null || me === null) return [];
    const mine = Object.values(st.minimap || {}).filter(o => o && o.team === me && !(o.xpos === 0 && o.ypos === 0));
    const units = mine.filter(o => (o.visionrange || 0) > 0).map(o => ({ x: o.xpos, y: o.ypos, vr: o.visionrange }));
    const sentries = mine.filter(o => /sentry/.test(o.unitname || ""));
    const h = st.hero;
    const gem = Object.values(st.items || {}).some(i => i?.name === "item_gem") && h && typeof h.xpos === "number";
    const out = [];
    for (const [k, w] of wards.enemy) {
      const dk = `${k}|${w.firstSeen}`;
      if (w.lastSeen === c) { this.cand.delete(k); this.pend.delete(dk); this.done.delete(dk); continue; }
      if (this.done.has(dk)) continue;
      const pd = this.pend.get(dk);
      if (pd) {
        if (c - pd.t0 < P.confirm) continue;
        this.pend.delete(dk);
        if (pd.src.length && !pd.src.some(key => sentries.some(s => `${s.xpos}|${s.ypos}` === key))) continue;
        this.done.add(dk);
        out.push({ key: k, firstSeen: w.firstSeen, kind: w.kind, x: w.x, y: w.y, unsure: w.placed === false });
        continue;
      }
      const src = sentries.filter(s => Math.hypot(s.xpos - w.x, s.ypos - w.y) <= P.sentrySight).map(s => `${s.xpos}|${s.ypos}`);
      const ts = src.length > 0 || (gem && Math.hypot(h.xpos - w.x, h.ypos - w.y) <= P.gemSight);
      if (!ts || !units.some(u => this.sees(u, w))) { this.cand.delete(k); continue; }
      if (!this.cand.has(k)) this.cand.set(k, c);
      if (c - this.cand.get(k) >= P.hold) {
        this.pend.set(dk, { t0: c, src });
        this.cand.delete(k);
      }
    }
    return out;
  }

  /** 这个眼（这一次记着的）是不是已经被"删了" */
  isDone(key, firstSeen) { return this.done.has(`${key}|${firstSeen}`); }
}
