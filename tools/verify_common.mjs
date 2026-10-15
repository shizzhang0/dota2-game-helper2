// verify_networth.mjs / verify_wards.mjs 共用的部分：找录制、读录制、按 main.js 的顺序跑真实前端模块。
//
// **思路**：同一局录两份——自己打时录一份（覆盖层当时真正看到的数据），赛后看回放再录一份
// （回放里 GSI 推十个人的数据、官方净资产、双方所有的眼）。回放那份当标准答案，
// 按游戏时钟和自己那份对齐，逐时刻比"覆盖层当时显示的"和"实际是什么"。
// 怎么录见 docs/design/dev-tools.md「准确性对账」。
//
// **跑的是 ui/js 下的真模块，不另写一份计算逻辑**（同 dev-tools.md「离线复算」）：
// 测的必须是产品本身，不是它的复制品。只有 main.js 那段装配要照抄（它带 DOM、不能直接 import），
// 见下面的 runSelf——**改了 main.js 的收包流程，记得同步这里**。

import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync, constants as zc } from "node:zlib";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ui/js 的模块在浏览器分支里用 fetch 读 constants/，这里接到本地文件上；window 给个空对象，isTauri() 就是假
globalThis.window = globalThis.window || {};
globalThis.fetch = async (u) => ({ json: async () => JSON.parse(readFileSync(join(ROOT, String(u)), "utf8")) });

const ui = (f) => import(pathToFileURL(join(ROOT, "ui", "js", f)).href);
export const { CachePool } = await ui("cachepool.js");
export const { MatchTracker } = await ui("match.js");
export const { loadConstants } = await ui("timers.js");
export const { EventTracker, loadTowers } = await ui("events.js");
export const { loadPrices, EconTracker } = await ui("networth.js");
export const { WardTracker, parseWards } = await ui("minimap.js");

/** 程序录制的目录（和 record.rs 一致）。可以用环境变量 HELPER2_RECORDS 换 */
export const RECORDS = process.env.HELPER2_RECORDS
  || join(process.env.APPDATA || "", "dev.dota2helper2.app", "records");

/** 读一份录制。**被强杀的录制没有 gzip 结尾**，用 SYNC_FLUSH 读到哪算哪（同 replay.py 的处理） */
export function readRecording(path) {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw, { finishFlush: zc.Z_SYNC_FLUSH }).toString("utf8")
                                    : raw.toString("utf8");
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 截断的最后一行 */ }
  }
  return out;
}

/** 观战 / 回放视角：player 是 { team2: { player0: ... } } 这种全员结构（判法同 match.js） */
export function isSpectate(pkt) {
  const p = pkt.player;
  return !!p && typeof p === "object" && !p.team_name && Object.keys(p).some(k => /^team\d+$/.test(k));
}

/** 按对局号找录制，分成"自己打的"和"回放"两组，各自按文件名里的开始时间排好。
    **同一局可能有好几份**：中途崩了重连、断流 40 秒自动收尾，都会切出新文件——按时间连起来就是一局。 */
export function findRecordings(matchId) {
  const files = readdirSync(RECORDS).filter(f => f.includes(`_m${matchId}.`)).sort();
  const self = [], spectate = [];
  for (const f of files) {
    const path = join(RECORDS, f);
    const pk = readRecording(path);
    const probe = pk.find(p => p.player && Object.keys(p.player).length);
    (probe && isSpectate(probe) ? spectate : self).push({ file: f, packets: pk });
  }
  return { self, spectate };
}

/** 命令行里的对局号；没给就列出有成对录制的对局 */
export function matchIdFromArgs(usage) {
  const id = process.argv.slice(2).find(a => /^\d+$/.test(a));
  if (id) return id;
  const byId = new Map();
  for (const f of readdirSync(RECORDS)) {
    const m = /_m(\d+)\./.exec(f);
    if (m) byId.set(m[1], (byId.get(m[1]) || 0) + 1);
  }
  console.log(usage);
  console.log(`\n录制目录：${RECORDS}`);
  console.log("有两份及以上录制的对局（可能是自己打 + 回放）：");
  for (const [k, n] of byId) if (n >= 2) console.log(`  ${k}  ${n} 份`);
  process.exit(1);
}

/** 主菜单的包（同 main.js 的 isMenu） */
function isMenu(pkt) {
  const p = pkt.player;
  return pkt.map === undefined && p !== null && typeof p === "object" && !Array.isArray(p)
         && Object.keys(p).length === 0;
}

/** 把自己打的录制按 main.js 的顺序喂一遍，每包回调一次 onFrame({ pkt, st, info, econ, wards, tracker })。
    几份录制按顺序连着喂，中间不重置——和程序一直开着、Dota 崩了重连是同一个情形。 */
export async function runSelf(recordings, onFrame) {
  const towers = await loadTowers(), prices = await loadPrices();
  const pool = new CachePool(), match = new MatchTracker(), econ = new EconTracker();
  let tracker = null, wards = null, last = null;
  for (const { packets } of recordings) {
    for (const pkt of packets) {
      if (isMenu(pkt)) continue;
      let st = pool.update(pkt);
      const info = match.update(st);
      if (info.newMatch) { pool.reset(); st = pool.update(pkt); }
      const C = await loadConstants(info.modeOrDefault);
      if (!tracker || info.newMatch) tracker = new EventTracker(C, towers);
      tracker.C = C; tracker.update(pkt, st, info);
      if (!wards || info.newMatch) wards = new WardTracker(C);
      wards.C = C; wards.update(st, info);
      if (info.newMatch) econ.reset();
      const ended = info.gameState === "DOTA_GAMERULES_STATE_POST_GAME";
      const frozen = ended && last?.info.gameState === "DOTA_GAMERULES_STATE_POST_GAME"
                     && last.info.matchid === info.matchid;
      const e = frozen ? last.econ : econ.update(st, prices, C, info.clock, wards.newOwnSentries);
      last = { info, econ: e };
      onFrame({ pkt, st, info, C, econ: e, wards, tracker });
    }
  }
}

/** 把几份回放录制连成一条按时钟排的序列，每项 { clock, pkt }（clock 为 null 的包丢掉）。
    回放 2 倍速时一秒里可能好几包、也可能两三秒一包，调用方按时钟查最近的那包 */
export function spectateTimeline(recordings) {
  const out = [];
  for (const { packets } of recordings) {
    for (const pkt of packets) {
      const c = pkt.map?.clock_time;
      if (typeof c === "number") out.push({ clock: c, pkt });
    }
  }
  return out;
}

/** 时钟 ≤ clock 的最后一项（二分）。超过 maxGap 秒没有就返回 null */
export function atClock(timeline, clock, maxGap = 3) {
  let lo = 0, hi = timeline.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].clock <= clock) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0 || clock - timeline[best].clock > maxGap) return null;
  return timeline[best];
}

/** 秒数 → m:ss（负数带符号） */
export function mmss(sec) {
  if (sec === null || sec === undefined) return "—";
  const s = Math.round(sec), neg = s < 0, a = Math.abs(s);
  return `${neg ? "-" : ""}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
}

/** 两组录制都在才能对账；缺哪组就说清楚要怎么补 */
export function requirePair(matchId, { self, spectate }) {
  const list = (g) => g.map(r => `    ${r.file}（${r.packets.length} 包）`).join("\n") || "    （没有）";
  console.log(`对局 ${matchId}\n  自己打的：\n${list(self)}\n  回放：\n${list(spectate)}\n`);
  if (!self.length) { console.log("缺自己打的录制：打这一局时要开着「记录对局数据」。"); process.exit(1); }
  if (!spectate.length) {
    console.log("缺回放录制：在 Dota 客户端下载这一局的回放，开着「记录对局数据」从头 2 倍速看完。");
    process.exit(1);
  }
}
