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

/** 眼是不是插在自己英雄脚下。hero.xpos/ypos 与 minimap 用的是同一套世界坐标。 */
const PLACE_RADIUS = 1000;
function nearMe(state, w) {
  const h = state.hero;
  if (!h || typeof h.xpos !== "number" || typeof h.ypos !== "number") return false;
  return Math.hypot(w.x - h.xpos, w.y - h.ypos) <= PLACE_RADIUS;
}

export class WardTracker {
  constructor(C) { this.C = C; this.reset(); }
  reset() {
    this.own = new Map();      // key -> {x, y, kind, firstSeen|null}
    this.enemy = new Map();    // key -> {x, y, kind, lastSeen}
    this.killed = [];          // [{x, y, kind, at}]
    this.lastClock = null;
    this.joined = false;       // 是否已处理过本局第一包
    this.newOwnSentries = 0;   // 本包新出现的己方真眼数，净资产拿它扣眼架库存
    this.seenKills = new Set();   // 排眼事件去重（同一条会在连续几包里重复出现）
    this.dewarded = new Map();    // key -> 判定被我方排掉的 clock，见 update()
  }

  /** 我方排掉敌方眼的事件 -> 把对应的记忆删掉。

      **为什么需要它**：敌方眼在我方真视之外被排掉时，我们无从得知，只能挂到名义
      寿命——那就是"幽灵眼"。而 `CHAT_MESSAGE_{OBSERVER,SENTRY}_WARD_KILLED`
      恰好只报**本方**排眼（实测：我方的眼被排时一条事件都没有），正好覆盖这种情形。

      **事件不带坐标**，只有 `playerid1`（谁排的）。所以要自己判断删哪一个：

      1. `playerid1` 必须在我方槽位内。`-1`（无主）一律不认——拿不准就别动记忆。
      2. 候选只取**当前仍可见**的（距上次确认 <= `wardKillConfirm`）。
         **排眼需要真视**，刚被排掉的那个此刻必然还在我们的真视里；
         几分钟前才确认过的那个不可能是它。
      3. 恰好一个才删，**否则什么都不做**。

      实测（自己打的那局，12 条本方排眼事件）：只按类型分只有 7 条无歧义，
      加上第 2 条过滤之后变成 **11 条**，剩下 1 条是两个眼同时都可见——那种就留着。

      > **歧义时宁可不删。** 留幽灵最多让你多绕一次路；删错会把**活着的**眼从地图上
      > 抹掉，而你会以为那儿安全。这和敌方眼淡化那次是同一个取舍方向。

      > backlog 原先设想的是"按排眼者位置就近删"。**那条行不通**：minimap 的英雄
      > 图标没有玩家槽位，自视角也拿不到队友的英雄，`playerid1` 根本落不到地图上。
      > 而且实测"离我方英雄最近"在能定真值的样本上全错——后来发现真值本身就定不了
      > （自视角下"之后没再出现"只说明离开视野）。 */
  noteWardKills(state, info) {
    const clock = info.clock;
    if (clock === null || info.myTeam === null) return;
    const lo = info.myTeam === 2 ? 0 : 5;
    for (const e of state.events || []) {
      if (e?.event_type !== "generic_event" || typeof e.data !== "string") continue;
      let j; try { j = JSON.parse(e.data); } catch { continue; }
      const type = String(j.type || "");
      if (!type.includes("WARD_KILLED")) continue;
      const id = `${type}|${j.time}|${j.playerid1}`;
      if (this.seenKills.has(id)) continue;
      this.seenKills.add(id);
      if (!(j.playerid1 >= lo && j.playerid1 <= lo + 4)) continue;
      const kind = type.includes("SENTRY") ? "sentry" : "obs";
      const live = [...this.enemy].filter(([, w]) =>
        w.kind === kind && clock - w.lastSeen <= this.C.wardKillConfirm);
      if (live.length !== 1) continue;
      this.enemy.delete(live[0][0]);
      // **必须压制一段时间**：GSI 上报有滞后（实测约 7 秒），眼死了之后还会在
      // minimap 里留一会儿。不压制的话下一包又把它加回来，而且 firstSeen 会重置成
      // 现在——等于把一个旧幽灵换成一个**满寿命**的新幽灵，比不删还糟。
      this.dewarded.set(live[0][0], clock);
    }
  }

  update(state, info) {
    const clock = info.clock;
    this.newOwnSentries = 0;
    if (clock === null) return;
    // 时钟倒流 = 换局/重开，旧状态作废（号角前 clock 本就不单调）
    if (this.lastClock !== null && clock < this.lastClock - 5) this.reset();
    this.lastClock = clock;

    // 先处理排眼事件，再刷新记忆：候选集要反映"这一包刷新之前"的状态，
    // 和验证时量的是同一个口径。
    this.noteWardKills(state, info);
    for (const [k, at] of [...this.dewarded]) {
      if (clock - at > this.C.wardKillSuppress) this.dewarded.delete(k);
    }

    const seen = parseWards(state);
    const seenKeys = new Set(seen.map(w => w.key));

    for (const w of seen) {
      if (info.myTeam !== null && w.team === info.myTeam) {
        if (!this.own.has(w.key)) {
          // 本局第一包里就存在的眼，插放时间未知，倒计时显示为未知
          this.own.set(w.key, { x: w.x, y: w.y, kind: w.kind,
                                firstSeen: this.joined ? clock : null });
          // 刚插下的己方真眼，且**插在自己英雄脚下**——净资产拿它扣眼架库存。
          // minimap 的眼条目只有 team、没有玩家 id，也没有"插眼"事件，
          // 所以队友的眼只能靠距离排除：施法距离 500，再加一包的位移（移速约 300），
          // 取 1000。
          // 见 design/networth.md 的眼架一节。
          if (this.joined && w.kind === "sentry" && nearMe(state, w)) this.newOwnSentries++;
        }
      } else {
        // 刚判定被我方排掉的，压制期内不再加回来（GSI 滞后，见 noteWardKills）
        if (this.dewarded.has(w.key)) continue;
        const was = this.enemy.get(w.key);
        // firstSeen 要留住：眼**不可能活过"第一次看见 + 寿命"**——我们第一次看见它时
        // 它已经活着了，所以这是个物理上界，用它剪枝不会漏报。
        //
        // **但眼位是会重复使用的**，而 key 只认坐标。同一个点被重新插眼时还是同一个 key，
        // firstSeen 若停在上一个眼那里，就会把新眼提前剪掉——实测每局漏报十来秒。
        // 判据很干净：**过了物理上界还能看见它，那它必然是新插的**，重置即可。
        const life = w.kind === "sentry" ? this.C.wardSentryDuration : this.C.wardObserverDuration;
        const stale = was && clock - was.firstSeen > life;
        this.enemy.set(w.key, { x: w.x, y: w.y, kind: w.kind, lastSeen: clock,
                                firstSeen: (was && !stale) ? was.firstSeen : clock });
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
      // 两个上界取紧的那个：从最后一次看见起算的兜底，以及"第一次看见 + 寿命"这个
      // 物理上界。后者是新加的——原先只按 lastSeen 算，一个被反复看见的眼会被
      // 一直往后顺延，实测能挂到五分钟。用 firstSeen 剪枝不会漏报（见上）。
      if (clock - w.lastSeen > memory || clock - (w.firstSeen ?? w.lastSeen) > memory) {
        this.enemy.delete(key);
      }
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
      // conf：这条线索有多新。1 = 此刻真视里确认着，0 = 已经放到寿命上限、马上要删。
      // 敌方眼的插放时刻无从得知，能诚实表达的只有"多久没看见了"——渲染层据此淡化。
      // 见本文件对应的 design/wards.md「敌方眼按多久没看见淡化」。
      enemy: [...this.enemy.values()].map(w => {
        const life = w.kind === "sentry" ? this.C.wardSentryDuration : this.C.wardObserverDuration;
        // 用"离物理上界还剩多少"当置信度，比"多久没看见"更贴近真实剩余寿命
        const left = life - (clock - (w.firstSeen ?? w.lastSeen));
        const conf = life > 0 ? Math.min(left / life, 1 - (clock - w.lastSeen) / life) : 1;
        return { x: w.x, y: w.y, kind: w.kind, conf: Math.max(0, Math.min(1, conf)) };
      }),
      killed: this.killed.slice(),
    };
  }
}
