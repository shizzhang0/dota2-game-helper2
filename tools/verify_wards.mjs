// 眼位对账：覆盖层当时画的眼 vs 回放里双方实际的眼。
//
//   node tools/verify_wards.mjs <对局号>            # 对一局
//   node tools/verify_wards.mjs <对局号> --top 20   # 多列几条
//   node tools/verify_wards.mjs                     # 列出有成对录制的对局
//
// 要两份录制：自己打的 + 同一局的回放（回放里 minimap 有双方所有的眼）。见 verify_common.mjs 的头注释。
//
// 比的是"用户当时能看到的"：敌方眼 = 我们记着的全部（有视野时原生小地图画着、没视野时我们画着，
// 对用户来说是同一件事）。四项：
//   · 幽灵：我们画着，回放里那个位置已经没有敌方眼了
//   · 漏显示：回放里有、我们**见过**、却没画——从没见过的不算，那是本来就不可能知道的
//   · 被排的叉：我们画的叉，回放里那个我方眼是不是真在到期前没了；以及该画没画的
//   · 我方眼倒计时：我们显示的剩余秒数 vs 回放里那个眼真实的剩余寿命
// 另外两项是给以后攒证据的（2026-10-21）：
//   · 淡化：没视野、我们自己画着的敌方眼，幽灵和活眼各画得多实（平均 conf）——幽灵该比活眼淡
//   · 排眼播报的两种没处理的情形：无主（-1，小兵 / 塔打掉的）、迟到（来时没有 3 秒内看见过的候选）。
//     各自数一数回放里那几秒是不是正好死了一个敌方同类眼，攒够了再决定要不要处理（wards.md）
//   · 有歧义的播报（来时 3 秒内看见过的候选不止一个）：逐条列出每个候选离自己英雄多远、回放里死没死，
//     攒着看"死的总是离我们近的那个"之类的规律成不成立
// 漏显示是危险的一侧（以为安全其实有眼），幽灵是吵的一侧——wards.md 一直按这个方向取舍。

import { findRecordings, matchIdFromArgs, requirePair, runSelf, spectateTimeline, atClock, mmss,
         CachePool, parseWards, loadConstants } from "./verify_common.mjs";

const USAGE = "用法：node tools/verify_wards.mjs <对局号> [--top N]";
const matchId = matchIdFromArgs(USAGE);
const topArg = process.argv.indexOf("--top");
const TOP = topArg > 0 ? Number(process.argv[topArg + 1]) || 8 : 8;

/** 两个点算同一个眼的距离。眼不会动，同一个眼两边报的坐标应当完全一样，留一点余量 */
const SAME = 150;
/** 回放里一个眼消失多久才算"没了"：GSI 偶尔漏一两包，别把一个眼切成两段 */
const GAP = 10;
/** 短于这么多秒的幽灵 / 漏显示单独计：两边上报时机差一两包就会出现，不是判据的问题 */
const SHORT = 10;
/** 眼死了之后 GSI 还会再报 6~7 秒（wards.md「死眼的尸体」），回放这边同样如此。
    我们这边按规则提前删掉的（到期上界、排眼事件），在回放里还会多活这一截，不算漏 */
const TAIL = 10;

const recs = findRecordings(matchId);
requirePair(matchId, recs);

// ── 回放：每一包的眼（minimap 可能整段缺席，用缓存池合并，同程序本身），再连成"一个眼的一生" ──
const truthFrames = [];          // { clock, wards }
{
  const pool = new CachePool();
  for (const { clock, pkt } of spectateTimeline(recs.spectate)) {
    const st = pool.update(pkt);
    truthFrames.push({ clock, wards: parseWards(st) });
  }
}
/** 回放里的每个眼：{ team, kind, x, y, start, end, ended }。ended = 回放结束前就没了 */
const lives = [];
{
  const open = new Map();        // key -> life
  for (const { clock, wards } of truthFrames) {
    for (const w of wards) {
      const l = open.get(w.key);
      if (l && clock - l.end <= GAP) { l.end = clock; continue; }
      const life = { team: w.team, kind: w.kind, x: w.x, y: w.y, start: clock, end: clock, ended: true };
      open.set(w.key, life); lives.push(life);
    }
  }
  const lastClock = truthFrames.at(-1)?.clock ?? 0;
  for (const l of lives) if (lastClock - l.end <= GAP) l.ended = false;
}
const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= SAME;

// ── 自己打的：跑真实管线，逐包和回放同一时刻比 ──
let myTeam = null, C = null, prevClock = null;
const seenEnemy = [];            // 自己视角里看见过的敌方眼：{ kind, x, y, at }
const ghosts = new Map();        // 我们画着、回放里没有：key -> { kind, x, y, sec, from, to, conf }
const misses = new Map();        // 回放里有、见过、没画：life -> { sec, from, to }
const ownDiff = [];              // 我方眼倒计时：我们 - 真实
const crosses = new Map();       // 我们画的叉：`x|y|at` -> { x, y, kind, at }
let posErr = 0, frames = 0;
const confGhost = [], confAlive = [];   // 没视野、我们画着的敌方眼的 conf
const broadcasts = [];                  // 排眼播报：{ clock, kind, pid, ours, live, held }
const seenBroadcast = new Set();

await runSelf(recs.self, ({ st, info, C: c, wards }) => {
  if (info.clock === null || info.clock < 0 || !info.inMatch || info.myTeam === null) return;
  myTeam = info.myTeam; C = c;
  const clock = info.clock;
  const dt = prevClock === null ? 0 : Math.min(3, Math.max(0, clock - prevClock));
  prevClock = clock;
  const enemyTeam = myTeam === 2 ? 3 : 2;
  for (const w of parseWards(st)) if (w.team === enemyTeam) seenEnemy.push({ ...w, at: clock });
  const list = wards.list(info);
  for (const k of list.killed) crosses.set(`${k.x}|${k.y}|${k.at}`, k);
  // 排眼播报：同 minimap.js noteWardKills 的去重和候选口径
  for (const e of st.events || []) {
    if (e?.event_type !== "generic_event" || typeof e.data !== "string") continue;
    let j; try { j = JSON.parse(e.data); } catch { continue; }
    if (!String(j.type || "").includes("WARD_KILLED")) continue;
    const id = `${j.type}|${j.time}|${j.playerid1}`;
    if (seenBroadcast.has(id)) continue;
    seenBroadcast.add(id);
    const kind = j.type.includes("SENTRY") ? "sentry" : "obs";
    const lo = myTeam === 2 ? 0 : 5;
    const mine = [...wards.enemy.values()].filter(w => w.kind === kind);
    const liveW = mine.filter(w => clock - w.lastSeen <= C.wardKillConfirm);
    const h = st.hero;
    const me = h && typeof h.xpos === "number" ? { x: h.xpos, y: h.ypos } : null;
    broadcasts.push({ clock, kind, pid: j.playerid1, ours: j.playerid1 >= lo && j.playerid1 <= lo + 4,
                      live: liveW.length,
                      cands: liveW.map(w => ({ x: w.x, y: w.y, d: me ? Math.round(Math.hypot(w.x - me.x, w.y - me.y)) : null })),
                      held: mine.map(w => ({ x: w.x, y: w.y })) });
  }

  const t = atClock(truthFrames, clock, 4);
  if (!t) return;
  frames++;
  const truthEnemy = t.wards.filter(w => w.team === enemyTeam);

  // 幽灵
  for (const d of list.enemy) {
    const m = truthEnemy.filter(w => w.kind === d.kind && near(w, d));
    if (!d.visible) (m.length ? confAlive : confGhost).push(d.conf);
    if (m.length) { posErr = Math.max(posErr, Math.min(...m.map(w => Math.hypot(w.x - d.x, w.y - d.y)))); continue; }
    const key = `${d.kind}|${d.x}|${d.y}`;
    const g = ghosts.get(key) || { kind: d.kind, x: d.x, y: d.y, sec: 0, from: clock, to: clock, conf: d.conf };
    g.sec += dt; g.to = clock; g.conf = d.conf;
    ghosts.set(key, g);
  }
  // 漏显示：回放里此刻活着的敌方眼，自己这边在它插下之后见过，却不在我们的列表里
  for (const w of truthEnemy) {
    const life = lives.find(l => l.team === w.team && l.kind === w.kind && l.x === w.x && l.y === w.y
                                 && l.start <= clock + 1 && l.end >= t.clock - 1);
    if (!life || (life.ended && clock > life.end - TAIL)) continue;
    const seen = seenEnemy.some(s => s.kind === w.kind && near(s, w) && s.at >= life.start - 2 && s.at <= clock);
    if (!seen || list.enemy.some(d => d.kind === w.kind && near(d, w))) continue;
    const m = misses.get(life) || { sec: 0, from: clock, to: clock };
    m.sec += dt; m.to = clock;
    misses.set(life, m);
  }
  // 我方眼倒计时
  for (const o of list.own) {
    if (o.remaining === null) continue;
    const life = lives.find(l => l.team === myTeam && l.kind === o.kind && near(l, o)
                                 && l.start <= clock + 3 && l.end >= clock - GAP);
    if (!life) continue;
    const dur = o.kind === "sentry" ? C.wardSentryDuration : C.wardObserverDuration;
    ownDiff.push(o.remaining - (life.start + dur - clock));
  }
});
if (myTeam === null) { console.log("自己那份录制里没有对局中的数据"); process.exit(1); }

const kindName = (k) => k === "sentry" ? "真眼" : "假眼";
const where = (o) => `(${o.x}, ${o.y})`;
const enemyTeam = myTeam === 2 ? 3 : 2;
const enemyLives = lives.filter(l => l.team === enemyTeam);
console.log(`我方 team${myTeam}；对上了 ${frames} 个时刻；回放里敌方插了 ${enemyLives.length} 个眼，` +
            `其中自己视角见过 ${enemyLives.filter(l => seenEnemy.some(s => s.kind === l.kind && near(s, l) && s.at >= l.start - 2 && s.at <= l.end + GAP)).length} 个\n`);

// ── 幽灵 ──
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const gs = [...ghosts.values()], longG = gs.filter(g => g.sec >= SHORT);
console.log(`幽灵（画着、实际已经没了）：${longG.length} 个，合计 ${Math.round(sum(longG.map(g => g.sec)))} 秒` +
            `；另有 ${gs.length - longG.length} 个短于 ${SHORT} 秒（两边上报差一两包）`);
for (const g of longG.sort((a, b) => b.sec - a.sec).slice(0, TOP)) {
  console.log(`  ${kindName(g.kind)} ${where(g)}  ${mmss(g.from)} ~ ${mmss(g.to)}  挂了 ${Math.round(g.sec)} 秒` +
              `，最后的淡化程度 ${g.conf.toFixed(2)}（1 = 实心，0 = 最淡）`);
}

// ── 漏显示 ──
const ms = [...misses], longM = ms.filter(([, m]) => m.sec >= SHORT);
console.log(`\n漏显示（见过、还活着、没画）：${longM.length} 个，合计 ${Math.round(sum(longM.map(([, m]) => m.sec)))} 秒` +
            `；另有 ${ms.length - longM.length} 个短于 ${SHORT} 秒（眼死后回放里还会多报的最后 ${TAIL} 秒不算）`);
for (const [l, m] of longM.sort((a, b) => b[1].sec - a[1].sec).slice(0, TOP)) {
  console.log(`  ${kindName(l.kind)} ${where(l)}  回放里活在 ${mmss(l.start)} ~ ${mmss(l.end)}` +
              `，我们 ${mmss(m.from)} ~ ${mmss(m.to)} 没画，共 ${Math.round(m.sec)} 秒`);
}

// ── 被排的叉 ──
// 回放里我方眼"提前没了" = 消失时离寿命还差 wardKilledGrace 秒以上（同 minimap.js 判被排的口径）
const ownLives = lives.filter(l => l.team === myTeam);
const grace = C.wardKilledGrace + 3;      // 回放 2 倍速时包稀，多给 3 秒
const lifeOf = (l) => l.kind === "sentry" ? C.wardSentryDuration : C.wardObserverDuration;
const killedEarly = ownLives.filter(l => l.ended && l.end - l.start < lifeOf(l) - grace);
let right = 0; const wrong = [];
for (const k of crosses.values()) {
  const l = ownLives.find(l => l.kind === k.kind && near(l, k) && Math.abs(l.end - k.at) <= 15);
  if (l && killedEarly.includes(l)) right++; else wrong.push({ k, l });
}
const missedKills = killedEarly.filter(l => ![...crosses.values()].some(k => k.kind === l.kind && near(l, k) && Math.abs(l.end - k.at) <= 15));
console.log(`\n被排的叉：画了 ${crosses.size} 个，对 ${right} 个，错 ${wrong.length} 个；` +
            `回放里我方眼提前没了 ${killedEarly.length} 个，没画叉的 ${missedKills.length} 个`);
for (const { k, l } of wrong.slice(0, TOP)) {
  console.log(`  错：${kindName(k.kind)} ${where(k)} ${mmss(k.at)} 画了叉，` +
              (l ? `回放里它活了 ${l.end - l.start} 秒（寿命 ${lifeOf(l)}），是自然到期` : "回放里那个时刻附近没有对应的眼"));
}
for (const l of missedKills.slice(0, TOP)) {
  console.log(`  漏：${kindName(l.kind)} ${where(l)} ${mmss(l.end)} 没了（只活了 ${l.end - l.start} 秒），没画叉` +
              `——插在程序开之前、或者插下就被排，我们没记住它也会这样`);
}

// ── 我方眼倒计时 ──
if (ownDiff.length) {
  const a = ownDiff.map(Math.abs);
  console.log(`\n我方眼倒计时（我们 - 真实）：${ownDiff.length} 个采样，平均 |差| ${(sum(a) / a.length).toFixed(1)} 秒，` +
              `最大 ${Math.max(...a)} 秒（回放 2 倍速时包稀，插眼时刻本身就有一两秒误差）`);
} else {
  console.log("\n我方眼倒计时：没有可比的采样");
}
console.log(`\n画的位置和真眼的最大距离：${posErr.toFixed(0)}（世界坐标，地图是 ±8400）`);

// ── 淡化 ──
const avg = (xs) => xs.length ? (sum(xs) / xs.length).toFixed(2) : "-";
console.log(`\n没视野、我们画着的敌方眼，平均实心程度（1 = 实心，0 = 最淡）：` +
            `幽灵 ${avg(confGhost)}（${confGhost.length} 个采样），活眼 ${avg(confAlive)}（${confAlive.length} 个采样）`);

// ── 排眼播报里还没处理的两种 ──
// 对得上 = 回放里播报前 3 秒到后 10 秒之间，正好死了一个提前没了的敌方同类眼，而且我们那时记着它
const endClock = truthFrames.at(-1)?.clock ?? 0;
const earlyEnemy = enemyLives.filter(l => l.ended && l.end - l.start < lifeOf(l) - grace);
function judge(b) {
  if (endClock - b.clock <= 10) return "比赛快结束，分不清";
  const dead = earlyEnemy.filter(l => l.kind === b.kind && l.end >= b.clock - 3 && l.end <= b.clock + 10);
  if (dead.length !== 1) return `那几秒死了 ${dead.length} 个敌方同类眼，对不上`;
  return b.held.some(h => near(h, dead[0])) ? "对得上（我们记着它）" : "对得上，但我们没记着它";
}
const tally = (bs) => {
  const c = new Map();
  for (const b of bs) { const r = judge(b); c.set(r, (c.get(r) || 0) + 1); }
  return [...c].map(([r, n]) => `${r} ${n}`).join("，") || "无";
};
const unowned = broadcasts.filter(b => b.pid === -1);
const late = broadcasts.filter(b => b.ours && b.live === 0);
console.log(`\n排眼播报（攒证据用，见 wards.md）：`);
console.log(`  无主（-1，小兵 / 塔）：${unowned.length} 条 —— ${tally(unowned)}`);
console.log(`  我方排、来时没有 ${C.wardKillConfirm} 秒内看见过的候选：${late.length} 条 —— ${tally(late)}`);
const ambiguous = broadcasts.filter(b => b.ours && b.live > 1);
console.log(`  我方排、候选不止一个（先记下、过 ${C.wardKillSuppress} 秒按消失的个数判）：${ambiguous.length} 条`);
for (const b of ambiguous) {
  const fate = (c) => {
    const l = enemyLives.find(l => l.kind === b.kind && near(l, c) && l.start <= b.clock + 2 && l.end >= b.clock - GAP);
    if (!l) return "回放里对不上";
    if (l.end <= b.clock + 10 && l.ended) return l.end - l.start < lifeOf(l) - grace ? "**被排了**" : "到期了";
    return `还活着（到 ${mmss(l.end)}）`;
  };
  console.log(`    ${mmss(b.clock)} ${kindName(b.kind)}：` +
              b.cands.map(c => `${where(c)} 离自己英雄 ${c.d ?? "?"} ${fate(c)}`).join("；"));
}
