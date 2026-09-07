// minimap 段派生的状态。两个实测坑：
//   1. 双方泉水也用 minimap_ward_obs 图标绘制且贯穿全局，必须按 unitname 过滤
//   2. 数据里存在坐标 (0,0) 的幽灵条目，需丢弃
const WARD_UNITS = {
  npc_dota_observer_wards: "obs",
  npc_dota_sentry_wards: "sentry",
};

function objects(state) {
  const out = [];
  for (const o of Object.values(state.minimap || {})) {
    if (!o || typeof o !== "object") continue;
    if (o.xpos === 0 && o.ypos === 0) continue;      // 幽灵条目
    out.push(o);
  }
  return out;
}

export function parseWards(state) {
  const out = [];
  for (const o of objects(state)) {
    const kind = WARD_UNITS[o.unitname];
    if (!kind) continue;
    out.push({ key: `${o.team}|${kind}|${o.xpos}|${o.ypos}`,
               team: o.team, kind, x: o.xpos, y: o.ypos });
  }
  return out;
}

/** towers.json 里有、但 minimap 上已经找不到的塔 = 已被推掉 */
export function deadTowers(state, towers) {
  const alive = objects(state).filter(o => String(o.image || "").startsWith("minimap_tower"));
  // 一座塔都没有 = minimap 还没数据（换局瞬间缓存池刚重置），
  // 此时应当作"未知"而不是"全被推了"，否则地图会整片变灰
  if (alive.length === 0) return [];
  const tol = towers.tolerance;
  return towers.towers.filter(t => !alive.some(o =>
    o.team === t.team && Math.abs(o.xpos - t.x) <= tol && Math.abs(o.ypos - t.y) <= tol));
}

export class WardTracker {
  constructor(C) { this.C = C; this.reset(); }
  reset() {
    this.own = new Map();      // key -> {x, y, kind, firstSeen|null}
    this.enemy = new Map();    // key -> {x, y, kind, lastSeen}
    this.killed = [];          // [{x, y, kind, at}]
    this.lastClock = null;
    this.joined = false;       // 是否已处理过本局第一包
  }

  update(state, info) {
    const clock = info.clock;
    if (clock === null) return;
    // 时钟倒流 = 换局/重开，旧状态作废（号角前 clock 本就不单调）
    if (this.lastClock !== null && clock < this.lastClock - 5) this.reset();
    this.lastClock = clock;

    const seen = parseWards(state);
    const seenKeys = new Set(seen.map(w => w.key));

    for (const w of seen) {
      if (info.myTeam !== null && w.team === info.myTeam) {
        if (!this.own.has(w.key)) {
          // 本局第一包里就存在的眼，插放时间未知，倒计时显示为未知
          this.own.set(w.key, { x: w.x, y: w.y, kind: w.kind,
                                firstSeen: this.joined ? clock : null });
        }
      } else {
        this.enemy.set(w.key, { x: w.x, y: w.y, kind: w.kind, lastSeen: clock });
      }
    }
    this.joined = true;

    // 我方眼消失：倒计时还没走完就是被排
    for (const [key, w] of [...this.own]) {
      if (seenKeys.has(key)) continue;
      const rem = this.remaining(w, clock);
      if (rem !== null && rem > this.C.wardKilledGrace) {
        this.killed.push({ x: w.x, y: w.y, kind: w.kind, at: clock });
      }
      this.own.delete(key);
    }
    this.killed = this.killed.filter(k => clock - k.at < 3);

    // 我方真眼此刻的位置。用本包看到的而不是 this.own：真眼要是同一刻也没了，
    // 就不该再拿它当"真视还在"的凭据。
    const sentries = seen.filter(w => w.kind === "sentry" &&
                                      info.myTeam !== null && w.team === info.myTeam);
    const covered = (x, y) => sentries.some(
      s => Math.hypot(x - s.x, y - s.y) <= this.C.sentryTrueSight);

    for (const [key, w] of [...this.enemy]) {
      // 本包还看得见的不动——它就在真视范围内，covered() 必然为真，会被误删
      if (seenKeys.has(key)) continue;
      // 消失的那一刻仍被我方真视覆盖 = 它是真没了（被排或到期），立刻移除。
      // GSI 没有击杀眼的事件，这是唯一能判定的途径：敌方眼平时每局几十次进出
      // 视野，"从数据里消失"本身完全不能说明问题，但"在我方真视底下消失"可以。
      if (covered(w.x, w.y)) { this.enemy.delete(key); continue; }
      // 否则只能当作真视断了，按该类型的寿命兜底保留。必须按类型分——
      // 原先真假眼都用一个 366，敌方真眼（426）会在还活着时就被抹掉。
      const memory = w.kind === "sentry" ? this.C.wardSentryDuration
                                         : this.C.wardObserverDuration;
      if (clock - w.lastSeen > memory) this.enemy.delete(key);
    }
  }

  remaining(w, clock) {
    if (w.firstSeen === null) return null;
    const life = w.kind === "sentry" ? this.C.wardSentryDuration : this.C.wardObserverDuration;
    return Math.max(0, Math.ceil(w.firstSeen + life - clock));
  }

  list(info) {
    const clock = info.clock ?? 0;
    return {
      own: [...this.own.values()].map(w => ({ x: w.x, y: w.y, kind: w.kind,
                                              remaining: this.remaining(w, clock) })),
      enemy: [...this.enemy.values()].map(w => ({ x: w.x, y: w.y, kind: w.kind })),
      killed: this.killed.slice(),
    };
  }
}
