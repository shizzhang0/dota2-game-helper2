// 净资产对账：覆盖层当时显示的净资产 vs 回放里的官方净资产。
//
//   node tools/verify_networth.mjs <对局号>            # 对一局
//   node tools/verify_networth.mjs <对局号> --top 20   # 多列几段偏差
//   node tools/verify_networth.mjs                     # 列出有成对录制的对局
//
// 要两份录制：自己打的（覆盖层当时的输入）+ 同一局的回放（带官方净资产）。见 verify_common.mjs 的头注释。
//
// **这是端到端的对账**，和以前"拿回放录制把十个人都算一遍"不是一回事：那种验证的是算法，
// 但自己打时 GSI 给的东西和回放里不完全一样（眼架靠"插在自己脚下"判断、储藏处、信使），
// 用户屏幕上那个数只能拿自己那份录制算。两种都有用：这个看用户实际看到的对不对，
// 十人那种样本多十倍，适合评估规则改动（networth.md 的"单独关掉逐次看"）。

import { findRecordings, matchIdFromArgs, requirePair, runSelf, spectateTimeline, mmss } from "./verify_common.mjs";

const USAGE = "用法：node tools/verify_networth.mjs <对局号> [--top N]";
const matchId = matchIdFromArgs(USAGE);
const topArg = process.argv.indexOf("--top");
const TOP = topArg > 0 ? Number(process.argv[topArg + 1]) || 10 : 10;
/** 差多少算一段"偏差"。100 是一件最便宜的成品物品的量级，再小的多半是买卖时序差一包 */
const EPISODE_MIN = 100;

const recs = findRecordings(matchId);
requirePair(matchId, recs);

// ── 自己打的：跑一遍真实管线，每个时钟留最后一包的结果 ──
const ours = new Map();          // clock -> { nw, items }
let heroName = null;
const itemNames = (st) => {
  const out = [];
  for (const [k, it] of Object.entries(st.items || {})) {
    if (!/^(slot|stash|teleport|neutral)/.test(k) || !it?.name || it.name === "empty") continue;
    out.push(it.name.replace(/^item_/, "") + (it.charges > 1 ? `×${it.charges}` : ""));
  }
  return out;
};
// 结束后那个定格的数（main.js 在 POST_GAME 第一包定格）——用户在结算画面对照的就是它
let ourFinal = null, truthFinal = null;
let undone = [];                 // networth.js 认成"撤销购买"销掉的账，见文末
await runSelf(recs.self, ({ st, info, econ }) => {
  heroName ??= st.hero?.name || null;
  if (info.gameState === "DOTA_GAMERULES_STATE_POST_GAME") ourFinal ??= econ.networth;
  undone = econ.undone ?? undone;
  if (info.clock === null || !info.inMatch && info.gameState !== "DOTA_GAMERULES_STATE_POST_GAME") return;
  ours.set(info.clock, { nw: econ.networth, items: itemNames(st), gameState: info.gameState });
});
if (!heroName) { console.log("自己那份录制里找不到英雄名"); process.exit(1); }

// ── 回放：找到同一个英雄，取官方净资产 ──
let who = null;
const truth = new Map();         // clock -> net_worth（每个时钟取最后一包）
for (const { clock, pkt } of spectateTimeline(recs.spectate)) {
  if (!who) {
    for (const [team, players] of Object.entries(pkt.hero || {})) {
      for (const [slot, h] of Object.entries(players || {})) {
        if (h?.name === heroName) who = { team, slot };
      }
    }
  }
  const nw = who && pkt.player?.[who.team]?.[who.slot]?.net_worth;
  if (typeof nw === "number" && pkt.map?.game_state === "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS") truth.set(clock, nw);
  if (typeof nw === "number" && pkt.map?.game_state === "DOTA_GAMERULES_STATE_POST_GAME") truthFinal ??= nw;
}
if (!who) { console.log(`回放里找不到 ${heroName}`); process.exit(1); }
console.log(`英雄 ${heroName.replace("npc_dota_hero_", "")}（回放里是 ${who.team}.${who.slot}）\n`);

// ── 对齐：以回放的时钟为准（回放 2 倍速时包更稀），取我们在同一秒或之前 2 秒内的最后一个值 ──
const ourClocks = [...ours.keys()].sort((a, b) => a - b);
function ourAt(c) {
  for (let d = 0; d <= 2; d++) if (ours.has(c - d)) return ours.get(c - d);
  return null;
}
const rows = [];
for (const [c, t] of [...truth].sort((a, b) => a[0] - b[0])) {
  const o = ourAt(c);
  if (o) rows.push({ clock: c, ours: o.nw, truth: t, d: o.nw - t, items: o.items });
}
if (!rows.length) { console.log("两份录制的时钟对不上（是同一局吗？）"); process.exit(1); }

// ── 总体 ──
const n = rows.length, abs = rows.map(r => Math.abs(r.d));
const pct = (f) => `${(100 * rows.filter(f).length / n).toFixed(1)}%`;
const mean = abs.reduce((a, b) => a + b, 0) / n;
const sorted = [...abs].sort((a, b) => a - b);
const last = rows[n - 1];
console.log(`对上了 ${n} 个时刻（${mmss(rows[0].clock)} ~ ${mmss(last.clock)}，自己那份 ${ourClocks.length} 个时刻）`);
console.log(`  完全一致     ${pct(r => r.d === 0)}`);
console.log(`  差 50 以内   ${pct(r => Math.abs(r.d) <= 50)}`);
console.log(`  差 100 以内  ${pct(r => Math.abs(r.d) <= 100)}`);
console.log(`  平均 |差|    ${mean.toFixed(0)}    中位 ${sorted[n >> 1]}    最大 ${sorted[n - 1]}`);
// **终局看结束后的定格，不看"对局中最后一包"**：后者和结束那一刻之间还有一两秒被动收入，
// 两边按整秒对齐时会差几块（m9045983491 报过 +2，而结算画面上两边一分不差）
const sign = (d) => `${d >= 0 ? "+" : ""}${d}`;
if (ourFinal !== null && truthFinal !== null) {
  console.log(`  终局（结束后定格，即结算画面上的数）  我们 ${ourFinal}  官方 ${truthFinal}  差 ${sign(ourFinal - truthFinal)}\n`);
} else {
  console.log(`  终局（录制里没有结束后的包，取对局中最后一刻）  我们 ${last.ours}  官方 ${last.truth}  差 ${sign(last.d)}（${mmss(last.clock)}）\n`);
}

// ── 偏差段：|差| ≥ EPISODE_MIN 的连续时刻并成一段（中间断开不超过 5 秒），按"时长 × 平均偏差"排 ──
const eps = [];
for (const r of rows) {
  if (Math.abs(r.d) < EPISODE_MIN) continue;
  const e = eps.at(-1);
  if (e && r.clock - e.end <= 5 && Math.sign(r.d) === Math.sign(e.peak)) {
    e.end = r.clock; e.sum += Math.abs(r.d); e.n++;
    if (Math.abs(r.d) > Math.abs(e.peak)) e.peak = r.d;
  } else {
    eps.push({ start: r.clock, end: r.clock, peak: r.d, sum: Math.abs(r.d), n: 1 });
  }
}
for (const e of eps) e.score = (e.end - e.start + 1) * (e.sum / e.n);
eps.sort((a, b) => b.score - a.score);
if (!eps.length) { console.log(`没有 |差| ≥ ${EPISODE_MIN} 的时刻`); process.exit(0); }
console.log(`|差| ≥ ${EPISODE_MIN} 的偏差段共 ${eps.length} 段，最大的 ${Math.min(TOP, eps.length)} 段：`);
console.log("（多 = 我们算多了；物品变化是这段开始前 15 秒到开始后 5 秒，自己物品栏 / 储藏处 / TP 里多了、少了什么）\n");
const itemsAt = (c) => {
  const i = ourClocks.findLastIndex(x => x <= c);
  return i >= 0 ? ours.get(ourClocks[i]).items : [];
};
const diffItems = (a, b) => {
  const left = [...a], added = [];
  for (const x of b) { const i = left.indexOf(x); if (i >= 0) left.splice(i, 1); else added.push(x); }
  return { added, removed: left };
};
for (const e of eps.slice(0, TOP)) {
  const dur = e.end - e.start + 1;
  const { added, removed } = diffItems(itemsAt(e.start - 15), itemsAt(e.start + 5));
  console.log(`  ${mmss(e.start)} ~ ${mmss(e.end)}  ${String(dur).padStart(4)} 秒  ` +
              `${e.peak > 0 ? "多" : "少"} ${Math.abs(e.peak)}（平均 ${Math.round(e.sum / e.n)}）`);
  if (added.length || removed.length) {
    console.log(`      物品  +[${added.join(", ")}]  -[${removed.join(", ")}]`);
  }
}

// ── 撤销购买（2026-10-21 起采用，攒证据）──
// networth.js 把"10 秒内钱又涨回同样数额、这一包没有赏金事件"认成买了又卖回，销掉那笔说不清的支出。
// 逐次看销掉之后对不对：之后和官方对得上 = 销对了（不销的话会一直多算这笔）；之后少算了约这笔 = 销错了
// （其实是还在路上 / 给队友买的东西，见 networth.md 证据清单）
const diffAt = (c) => { for (let d = 0; d <= 3; d++) { const r = rows.find(r => r.clock === c + d); if (r) return r.d; } return null; };
console.log(`
撤销购买退款（认成买了又卖回、销掉那笔支出）：${undone.length} 次`);
for (const u of undone) {
  const after = diffAt(u.at + 5);
  const verdict = after === null ? "对不上时刻" : after <= -u.v / 2 ? `**销错了**：之后少算约 ${-after}` :
    Math.abs(after) <= Math.max(100, u.v / 4) ? "销对了" : "说不清";
  console.log(`  ${mmss(u.at)} 销掉 ${u.v}：之后和官方差 ${after ?? "?"} → ${verdict}`);
}
