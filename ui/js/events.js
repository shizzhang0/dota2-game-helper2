import { isTauri, fetchConstant } from "./source.js";

let TOWERS = null;
export function loadTowers() {
  if (!TOWERS) {
    TOWERS = isTauri()
      ? window.__TAURI__.core.invoke("get_constants", { name: "towers" })
      : fetchConstant("towers.json");
  }
  return TOWERS;
}

export class EventTracker {
  constructor(C) { this.C = C; this.reset(); }
  reset() {
    this.seen = new Set();
    // 7.42 起塔防是充能制，每队只记"什么时候开过"，剩几次、多久补下一次都在 glyphState 里现算。
    // **不在这里存具体时刻**：模式（普通/快速）要到 clock >= 60 才判得出来，
    // 两种模式的开局可用时刻不同（快速 3:30、普通 3:00），存死了就不会跟着改。
    this.glyph = { 2: [], 3: [] };
    this.buyback = {};          // slot -> usedAtClock
    this.lastClock = null;
  }
  update(packet, state, info) {
    const now = info.clock;
    // 时钟倒流 = 换局/重开，旧状态全部作废（否则会算出超过冷却上限的剩余时间）
    if (this.lastClock !== null && now !== null && now < this.lastClock - 5) this.reset();
    if (now !== null) this.lastClock = now;
    for (const ev of packet.events || []) {
      if (ev.event_type !== "generic_event") continue;
      let j; try { j = JSON.parse(ev.data); } catch { continue; }
      const key = j.type + "|" + j.time;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      this.handle(j, now);
    }
  }
  handle(j, now) {
    if (now === null) return;
    switch (j.type) {
      case "CHAT_MESSAGE_GLYPH_USED":
        this.glyph[j.playerid1]?.push(now);
        break;
      case "CHAT_MESSAGE_BUYBACK":
        this.buyback[j.playerid1] = now;
        break;
    }
  }
  /** 开局第一次充能到账的时刻（clock）。充能从**开局倒计时开始**那一刻起算，
      所以 = -倒计时长度 + glyphFirstReady：快速 3:30、普通 3:00。 */
  firstReadyAt() {
    return -(this.C.pregameLength ?? 0) + (this.C.glyphFirstReady ?? 0);
  }
  /** 某队此刻的塔防：可用次数、下一次充能到账时刻、上次使用时刻。
      7.42：开局 0 次，最多存 glyphCharges 次，不满时每 glyphRecharge 秒补一次（满了就停表，
      用掉一次才重新开始走）；两次使用之间隔 glyphUseCooldown 秒；推塔不再刷新。 */
  glyphState(team, now) {
    const max = this.C.glyphCharges ?? 2, every = this.C.glyphRecharge ?? 360;
    let charges = 0, next = this.firstReadyAt(), lastUse = null;
    const advance = (t) => {
      while (next !== null && next <= t) { charges++; next = charges < max ? next + every : null; }
    };
    for (const at of this.glyph[team] || []) {
      if (at > now) break;
      advance(at);
      if (next === null) next = at + every;   // 满的时候用掉一次，充能表从这一刻重新走
      // 算出来 0 次却开了 = 我们漏了什么（中途启动之类），按开之前刚好有一次处理，不扣成负数
      charges = Math.max(0, charges - 1);
      lastUse = at;
    }
    advance(now);
    return { charges, next, lastUse };
  }
  enemyGlyph(info) {
    const every = this.C.glyphRecharge ?? 360;
    // 没有 clock 就没有"还剩多久"可言（待机、换局那一瞬）。按 ready 显示，
    // 和没有 tracker 时的占位一致。
    const max = this.C.glyphCharges ?? 2;
    if (info.clock === null) return { ready: true, remaining: 0, total: every, charges: max, progress: 1 };
    const enemy = info.myTeam === 2 ? 3 : 2;
    const { charges, next, lastUse } = this.glyphState(enemy, info.clock);
    const gap = this.C.glyphUseCooldown ?? 0;
    // **total 是"当前这段等待有多长"，渲染层用它算环的进度。**
    // 没次数时等的是充能：开局那次是 glyphFirstReady（270），之后是 glyphRecharge（360）；
    // 有次数但刚用过，等的是两次之间那 7 秒。
    // progress = 下一次充能补到哪（0~1），存满了是 1。渲染层在"可用但没存满"时拿它画环。
    const progress = next === null ? 1 : Math.max(0, Math.min(1, 1 - (next - info.clock) / every));
    if (charges === 0) {
      const total = next === this.firstReadyAt() ? (this.C.glyphFirstReady ?? every) : every;
      return { ready: false, remaining: Math.max(1, Math.ceil(next - info.clock)), total, charges, progress };
    }
    const rem = lastUse === null ? 0 : Math.max(0, Math.ceil(lastUse + gap - info.clock));
    return { ready: rem === 0, remaining: rem, total: gap || 1, charges, progress };
  }
  // **十个人都给，包括自己和队友**（2026-10-08 起）。原生界面里队友的买活冷却
  // 哪儿都看不到——记分板没有、顶栏也没有（用户实测）；自己的只在死了以后的按钮上有。
  // 事件本来就双方都推，原先只是把己方那一半筛掉了。
  buybacks(info) {
    // 没有 clock 时什么都不给，同 enemyGlyph。不挡的话 null 在减法里被当成 0，
    // 算出来是"买活时刻 + 480"那么大的剩余秒数，格子挂着一个离谱的数
    if (info.clock === null) return [];
    const out = [];
    for (const [slot, at] of Object.entries(this.buyback)) {
      const s = Number(slot);
      const rem = Math.ceil(at + this.C.buybackCooldown - info.clock);
      if (rem > 0) out.push({ slot: s, remaining: rem });
    }
    return out;
  }
}
