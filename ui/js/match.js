const IN_MATCH = new Set(["DOTA_GAMERULES_STATE_PRE_GAME",
                          "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"]);
export class MatchTracker {
  constructor() { this.matchid = null; this.mode = null; this.myTeam = null; }
  update(state) {
    const m = state.map || {}, p = state.player || {};
    let newMatch = false;
    if (m.matchid && m.matchid !== this.matchid) {
      this.matchid = m.matchid; this.mode = null; this.myTeam = null; newMatch = true;
    }
    if (p.team_name === "radiant") this.myTeam = 2;
    else if (p.team_name === "dire") this.myTeam = 3;
    const clock = typeof m.clock_time === "number" ? m.clock_time : null;
    if (this.mode === null && clock !== null && clock >= 60
        && typeof p.gold_from_income === "number") {
      this.mode = (p.gold_from_income / clock > 2.2) ? "turbo" : "normal";
    }
    return { matchid: this.matchid, clock, gameState: m.game_state,
             inMatch: IN_MATCH.has(m.game_state), myTeam: this.myTeam,
             mode: this.mode, modeOrDefault: this.mode ?? "turbo",
             paused: m.paused === true, newMatch };
  }
}
