import { isTauri } from "./source.js";

const KIND_LABEL = { bounty: "赏金", water: "圣水", power: "强化",
                     wisdom: "智慧", lotus: "莲花", stack: "堆野" };
// 缓存 Promise 而非结果：GSI 每秒推多包，缓存结果会让首个请求未返回前的所有调用各发一次
const cache = {};
export function loadConstants(mode) {
  if (!cache[mode]) {
    // Tauri 下走命令，常数表存在用户配置目录里，改完重启即可生效（不必重新编译）
    cache[mode] = isTauri()
      ? window.__TAURI__.core.invoke("get_constants", { name: mode })
      : fetch(`/constants/${mode}.json`).then(r => r.json());
  }
  return cache[mode];
}
function nextTick(clock, start, every) {
  return clock < start ? start
       : start + (Math.floor((clock - start) / every) + 1) * every;
}
function nextMidRune(clock, mr) {
  for (const e of mr.fixed) if (clock < e.clock) return e;
  const r = mr.repeat;
  if (clock < r.fromClock) return { clock: r.fromClock, kind: r.kind };
  return { clock: nextTick(clock, r.fromClock, r.every), kind: r.kind };
}
export function computeTimers(clock, C) {
  if (clock === null) return [];
  const t = [];
  const mr = nextMidRune(clock, C.midRune);
  t.push({ id: "mid", label: KIND_LABEL[mr.kind], kind: mr.kind,
           remaining: mr.clock - clock, period: C.midRune.repeat.every });
  for (const id of ["bounty", "lotus", "wisdom"]) {
    const c = C[id];
    t.push({ id, label: KIND_LABEL[id], kind: id,
             remaining: nextTick(clock, c.start, c.every) - clock, period: c.every });
  }
  if (clock >= 0) {
    const next = (Math.floor(clock / C.stack.every) + 1) * C.stack.every;
    t.push({ id: "stack", label: KIND_LABEL.stack, kind: "stack",
             remaining: next - clock, period: C.stack.every });
  }
  return t;
}
