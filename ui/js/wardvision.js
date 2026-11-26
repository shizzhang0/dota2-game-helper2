// **照到了没出现就删**（2026-11-26 做进程序；11-25 起先当影子统计跑了十四对）。见 design/wards.md「用地形高度和树判断看不看得见」。
//
// 敌方眼从数据里消失不说明它没了——多半只是我们没视野了，所以一律按寿命挂着（minimap.js）。
// 但要是那个点此刻**真视和普通视野都照得到**、它却没出现，那它就是真没了：
//   · 真视：1000 以内有我方真眼（照射 1050 扣一点），或者自己带着宝石、850 以内（900 扣一点）。
//     队友的宝石、粉不算：自视角拿不到队友的物品；粉也不是区域真视，只是给范围里的英雄上个状态
//   · 普通视野：有个我方单位离 p 不超过它的 visionrange − 150（两包之间会走动），而且
//       - 它所在的地面不低于 p（低处看不到高处，容差 32）
//       - 视线上没有比它更高的地形，也没有树（树所在格和周围一圈都算挡；按"树都在"算，砍掉的只会让实际更看得见）
//     拿十四对录制里的敌方小兵 / 野怪 / 英雄验证过：模型说看得见而自视角里没出现的，小兵 0.1%、野怪 1.7%、英雄 5.1%
// 可见却没出现、连续 2 秒，记一次候选；**再等 8 秒确认**当时给真视的那个真眼还在报——
// 眼死后 GSI 还会报 6~7 秒尸体，刚被排掉的我方真眼会让模型以为那里还有真视（不确认时十二对里误删的 5 次全是这个）。
// 拿不准的一律当看不见：宁可少删。十四对：删 6 次全对，幽灵少约 1110 秒，漏显示不变。
//
// 地形高度和树是 tools/map_dump.py 用 Workshop Tools 导出、打成 ui/data/map.bin 随程序发的。
// **地图一改，模型就会照着旧地形判**（新树、新台阶挡住的地方当成看得见）——那就是误删活眼。
// 所以文件头里记着导出时 dota.trm（树）和 dota.gnv（可走的格子）的 CRC32，启动和每局开始拿本机地图包里的比（mapcheck.rs），
// 对不上、或者读不到，这条规则就关掉，其余照旧。

import { isTauri } from "./source.js";

const P = {
  margin: 150, hTol: 32, treeR: 1, step: 32,
  sentrySight: 1000, gemSight: 850,
  hold: 2, confirm: 8,
};

/** ui/data/map.bin -> { cell, x0, y0, w, h, heights, tree, trm, gnv }。格式见 tools/map_dump.py 的 pack */
export function parseMap(buf) {
  const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
  if (magic !== "DMAP" || v.getUint16(4, true) !== 1) throw new Error(`map.bin 格式不对（${magic} v${v.getUint16(4, true)}）`);
  const m = { cell: v.getUint16(6, true), x0: v.getInt32(8, true), y0: v.getInt32(12, true),
              w: v.getUint16(16, true), h: v.getUint16(18, true),
              trm: v.getUint32(20, true), gnv: v.getUint32(24, true) };
  const n = m.w * m.h, trees = v.getUint32(28, true);
  if (v.byteLength !== 32 + 2 * n + 4 * trees) throw new Error(`map.bin 长度不对（${v.byteLength}）`);
  m.heights = new Int16Array(n);
  for (let i = 0; i < n; i++) m.heights[i] = v.getInt16(32 + 2 * i, true);
  m.tree = new Uint8Array(n);
  for (let i = 0, o = 32 + 2 * n; i < trees; i++, o += 4) {
    const c = Math.floor((v.getInt16(o, true) - m.x0) / m.cell), r = Math.floor((v.getInt16(o + 2, true) - m.y0) / m.cell);
    if (c >= 0 && c < m.w && r >= 0 && r < m.h) m.tree[r * m.w + c] = 1;
  }
  return m;
}

let parsed = null;     // 文件只读一次；比对每次都重新做（Dota 可能在程序开着的时候更新）

/** 读地图并和本机地图包比对。能用就给地图，不能用给 null 和原因：{ map, why } */
export async function loadVisionMap() {
  try {
    parsed ??= fetch(new URL("../data/map.bin", import.meta.url)).then(r => r.arrayBuffer()).then(parseMap);
    const m = await parsed;
    // 浏览器里（开发用的回放、Pages 演示、对账脚本）没有本机地图包可比，照用
    if (!isTauri()) return { map: m, why: "" };
    const local = await window.__TAURI__.core.invoke("map_crc");
    if (!local) return { map: null, why: "读不到本机的 maps/dota.vpk" };
    if (local.trm !== m.trm || local.gnv !== m.gnv) {
      const hex = (x) => "0x" + (x >>> 0).toString(16).padStart(8, "0");
      return { map: null, why: `地图改过了（本机 dota.trm ${hex(local.trm)} / dota.gnv ${hex(local.gnv)}，` +
                               `导出时 ${hex(m.trm)} / ${hex(m.gnv)}），等重新导出` };
    }
    return { map: m, why: "" };
  } catch (e) {
    parsed = null;
    return { map: null, why: `读地图数据失败：${e?.message || e}` };
  }
}

export class WardVision {
  constructor(map) {
    this.m = map;
    this.cand = new Map();       // 敌方眼 key -> 连续"可见却没出现"的起始时刻
    this.pend = new Map();       // key -> { t0, src, firstSeen }：等确认
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

  /** 每包调一次，在 WardTracker 刷新完记忆之后。返回这一包判定已经没了的敌方眼：[{ key, firstSeen, kind, x, y, unsure }]，
      由调用方删掉。enemy 是 WardTracker.enemy（key -> { x, y, kind, lastSeen, firstSeen, placed }） */
  update(st, info, enemy) {
    const c = info.clock, me = info.myTeam;
    if (c === null || me === null) return [];
    for (const k of this.cand.keys()) if (!enemy.has(k)) this.cand.delete(k);
    for (const k of this.pend.keys()) if (!enemy.has(k)) this.pend.delete(k);
    const mine = Object.values(st.minimap || {}).filter(o => o && o.team === me && !(o.xpos === 0 && o.ypos === 0));
    const units = mine.filter(o => (o.visionrange || 0) > 0).map(o => ({ x: o.xpos, y: o.ypos, vr: o.visionrange }));
    const sentries = mine.filter(o => o.unitname === "npc_dota_sentry_wards");
    const h = st.hero;
    const gem = Object.values(st.items || {}).some(i => i?.name === "item_gem") && h && typeof h.xpos === "number";
    const out = [];
    for (const [k, w] of enemy) {
      // 还看得见，或者换了一个眼（同一个点重新插的，firstSeen 变了）：从头来
      if (w.lastSeen === c) { this.cand.delete(k); this.pend.delete(k); continue; }
      const pd = this.pend.get(k);
      if (pd && pd.firstSeen !== w.firstSeen) this.pend.delete(k);
      else if (pd) {
        if (c - pd.t0 < P.confirm) continue;
        this.pend.delete(k);
        // 给真视的那个我方真眼 8 秒后还在报，才信"那时那里有真视"；它被排了（报的是尸体）就不算
        if (pd.src.length && !pd.src.some(key => sentries.some(s => `${s.xpos}|${s.ypos}` === key))) continue;
        out.push({ key: k, firstSeen: w.firstSeen, kind: w.kind, x: w.x, y: w.y, unsure: w.placed === false });
        continue;
      }
      const src = sentries.filter(s => Math.hypot(s.xpos - w.x, s.ypos - w.y) <= P.sentrySight).map(s => `${s.xpos}|${s.ypos}`);
      const ts = src.length > 0 || (gem && Math.hypot(h.xpos - w.x, h.ypos - w.y) <= P.gemSight);
      if (!ts || !units.some(u => this.sees(u, w))) { this.cand.delete(k); continue; }
      if (!this.cand.has(k)) this.cand.set(k, c);
      if (c - this.cand.get(k) >= P.hold) {
        this.pend.set(k, { t0: c, src, firstSeen: w.firstSeen });
        this.cand.delete(k);
      }
    }
    return out;
  }
}
