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
  constructor(C, towers) { this.C = C; this.towers = towers; this.reset(); }
  reset() {
    this.seen = new Set();
    // readyAt = null 表示"还没用过也没刷新过"——这时按当前常数算**开局那次冷却**。
    // **不能在这里把初值写成具体数字**：模式（普通/快速）要到 clock >= 60 才判得出来，
    // 而两种模式的开局可用时刻不同（快速 3:30、普通 3:00）。写死就不会跟着改。
    this.glyph = { 2: { readyAt: null, milestones: new Set() },
                   3: { readyAt: null, milestones: new Set() } };
    this.buyback = {};          // slot -> usedAtClock
    this.reconstructed = false;
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
    if (!this.reconstructed && info.inMatch && now !== null && now > 60 && state.minimap) {
      this.reconstruct(state.minimap); this.reconstructed = true;
    }
  }
  handle(j, now) {
    if (now === null) return;
    switch (j.type) {
      case "CHAT_MESSAGE_GLYPH_USED": {
        const g = this.glyph[j.playerid1];
        if (g) g.readyAt = now + this.C.glyphCooldown;
        break;
      }
      case "CHAT_MESSAGE_TOWER_KILL":
      case "CHAT_MESSAGE_TOWER_DENY": {
        const loser = j.type === "CHAT_MESSAGE_TOWER_DENY" ? j.value : 5 - j.value;
        // **只认 T1 和 T2，T3 不刷新**（2026-09-17 改）。原先把 T3 也算进来，
        // 按 5 份录像重做归因后去掉了——理由和证据见 design/timers.md。
        if (j.value3 >= 1 && j.value3 <= 2) this.milestone(loser, "t" + j.value3, now);
        break;
      }
      case "CHAT_MESSAGE_BARRACKS_KILL":
        if (j.value2 === 155) this.milestone(5 - j.value, "melee", now);
        break;
      case "CHAT_MESSAGE_BUYBACK":
        this.buyback[j.playerid1] = now;
        break;
    }
  }
  milestone(team, key, now) {
    const g = this.glyph[team];
    if (g && !g.milestones.has(key)) { g.milestones.add(key); g.readyAt = now; }
  }
  // 中途启动：已消失的塔 = 里程碑已消耗（只标记消耗，不置 ready）
  reconstruct(minimap) {
    const alive = [];
    for (const o of Object.values(minimap)) {
      if (o && typeof o === "object" && String(o.image || "").startsWith("minimap_tower"))
        alive.push(o);
    }
    const tol = this.towers.tolerance;
    for (const t of this.towers.towers) {
      // 只有 T1/T2 是刷新里程碑，T3/T4 不是——重建时也就没必要标记
      if (t.tier > 2) continue;
      const found = alive.some(o => o.team === t.team &&
        Math.abs(o.xpos - t.x) <= tol && Math.abs(o.ypos - t.y) <= tol);
      if (!found) this.glyph[t.team].milestones.add("t" + t.tier);
    }
  }
  /** 开局那次冷却结束的时刻（clock）。冷却从**开局倒计时开始**那一刻起算，
      所以可用时刻 = -倒计时长度 + 冷却长度：快速 3:30、普通 3:00。 */
  firstReadyAt() {
    return -(this.C.pregameLength ?? 0) + (this.C.glyphFirstReady ?? 0);
  }
  enemyGlyph(info) {
    // 没有 clock 就没有"还剩多久"可言（待机、换局那一瞬）。按 ready 显示，
    // 和没有 tracker 时的占位一致。
    if (info.clock === null) return { ready: true, remaining: 0, total: this.C.glyphCooldown };
    const enemy = info.myTeam === 2 ? 3 : 2;
    const g = this.glyph[enemy];
    const at = g.readyAt ?? this.firstReadyAt();
    const rem = Math.max(0, Math.ceil(at - info.clock));
    // **total 是"当前这次冷却有多长"，渲染层用它算环的进度。**
    // 开局那次不是 300 而是 glyphFirstReady（270）——写死 300 会把开局的环画错，
    // 而且常数就不该出现在渲染层里。
    const total = g.readyAt === null
      ? (this.C.glyphFirstReady ?? this.C.glyphCooldown)
      : this.C.glyphCooldown;
    return { ready: rem === 0, remaining: rem, total };
  }
  enemyBuybacks(info) {
    const range = info.myTeam === 2 ? [5, 9] : [0, 4];
    const out = [];
    for (const [slot, at] of Object.entries(this.buyback)) {
      const s = Number(slot);
      if (s < range[0] || s > range[1]) continue;
      const rem = Math.ceil(at + this.C.buybackCooldown - info.clock);
      if (rem > 0) out.push({ slot: s, remaining: rem });
    }
    return out;
  }
}
