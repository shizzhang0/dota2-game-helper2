import { isTauri } from "./source.js";

let TOWERS = null;
export function loadTowers() {
  if (!TOWERS) {
    TOWERS = isTauri()
      ? window.__TAURI__.core.invoke("get_constants", { name: "towers" })
      : fetch("/constants/towers.json").then(r => r.json());
  }
  return TOWERS;
}

export class EventTracker {
  constructor(C, towers) { this.C = C; this.towers = towers; this.reset(); }
  reset() {
    this.seen = new Set();
    this.glyph = { 2: { readyAt: -Infinity, milestones: new Set() },
                   3: { readyAt: -Infinity, milestones: new Set() } };
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
        if (j.value3 >= 1 && j.value3 <= 3) this.milestone(loser, "t" + j.value3, now);
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
      if (t.tier === 4) continue;
      const found = alive.some(o => o.team === t.team &&
        Math.abs(o.xpos - t.x) <= tol && Math.abs(o.ypos - t.y) <= tol);
      if (!found) this.glyph[t.team].milestones.add("t" + t.tier);
    }
  }
  enemyGlyph(info) {
    const enemy = info.myTeam === 2 ? 3 : 2;
    const rem = Math.max(0, Math.ceil(this.glyph[enemy].readyAt - info.clock));
    return { ready: rem === 0, remaining: rem };
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
