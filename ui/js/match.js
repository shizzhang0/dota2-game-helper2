const IN_MATCH = new Set(["DOTA_GAMERULES_STATE_PRE_GAME",
                          "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"]);
export class MatchTracker {
  constructor() { this.matchid = null; this.mode = null; this.myTeam = null; }
  update(state) {
    const m = state.map || {}, p = state.player || {};
    // 观战 / 看回放时 GSI 推的是全员结构：player 变成 { team2: { player0: ... } }，
    // 没有 team_name。不判掉的话净资产会把 undefined 一路算成 0，
    // 显示一个"看起来正常"的错数字。见 design/overlay.md 的智能显隐。
    const spectating = !p.team_name && Object.keys(p).some(k => /^team\d+$/.test(k));
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
    // inMatch 一直就是"我正在打的这一局"的意思——events.js 拿它决定要不要
    // 从 minimap 反推塔的状态，观战下那份数据不是自己的，同样不该进。
    // 所以观战这道闸门就设在这里一处，不到处补判断。
    return { matchid: this.matchid, clock, gameState: m.game_state, spectating,
             inMatch: IN_MATCH.has(m.game_state) && !spectating, myTeam: this.myTeam,
             mode: this.mode, modeOrDefault: this.mode ?? "turbo",
             paused: m.paused === true, newMatch };
  }
}
