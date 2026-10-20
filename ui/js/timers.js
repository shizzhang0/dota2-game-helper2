import { isTauri, fetchConstant } from "./source.js";

// 缓存 Promise 而非结果：GSI 每秒推多包，缓存结果会让首个请求未返回前的所有调用各发一次
const cache = {};
export function loadConstants(mode) {
  if (!cache[mode]) {
    // Tauri 下走命令，读编译期内嵌的那份（不落配置目录，见 design/timers.md「常数外置」）
    cache[mode] = isTauri()
      ? window.__TAURI__.core.invoke("get_constants", { name: mode })
      : fetchConstant(`${mode}.json`);
  }
  return cache[mode];
}
function nextTick(clock, start, every) {
  return clock < start ? start
       : start + (Math.floor((clock - start) / every) + 1) * every;
}
/** 下一次刷新，连同上一次刷新的时刻（prev）。第一次刷新之前没有"上一次"，算作策略阶段开始那一刻 */
function nextMidRune(clock, mr, pregame) {
  let prev = pregame;
  for (const e of mr.fixed) {
    if (clock < e.clock) return { ...e, prev };
    prev = e.clock;
  }
  const r = mr.repeat;
  if (clock < r.fromClock) return { clock: r.fromClock, kind: r.kind, prev };
  const next = nextTick(clock, r.fromClock, r.every);
  return { clock: next, kind: r.kind, prev: next - r.every };
}
export function computeTimers(clock, C) {
  if (clock === null) return [];
  const t = [];
  // **环的周期 = 上一次刷新到下一次刷新**（2026-10-20）。原先直接用间隔，号角前就不对了：中路符和赏金符
  // 都在倒数 0:00 那波赏金符，周期却一个 120 一个 240，同一个剩余秒数两个环一快一慢；智慧神龛、莲花
  // 剩余比一个间隔还长，环钳在满格一动不动。第一次刷新前从策略阶段开始算（-pregameLength），号角前也在走
  const pregame = -(C.pregameLength ?? 0);
  const mr = nextMidRune(clock, C.midRune, pregame);
  t.push({ id: "mid", kind: mr.kind,
           remaining: mr.clock - clock, period: mr.clock - mr.prev });
  for (const id of ["bounty", "lotus", "wisdom"]) {
    const c = C[id];
    const next = nextTick(clock, c.start, c.every);
    const prev = next === c.start ? pregame : next - c.every;
    t.push({ id, kind: id, remaining: next - clock, period: next - prev });
  }
  if (clock >= 0) {
    const next = (Math.floor(clock / C.stack.every) + 1) * C.stack.every;
    t.push({ id: "stack", kind: "stack",
             remaining: next - clock, period: C.stack.every });
  }
  return t;
}
