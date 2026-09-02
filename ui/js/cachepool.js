const SECTIONS = ["provider","map","player","hero","abilities","items",
                  "events","minimap","buildings","wearables"];
function isEmptyObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;
}

export class CachePool {
  constructor() { this.state = {}; }
  update(packet) {
    for (const s of SECTIONS) {
      const v = packet[s];
      if (v === undefined) continue;
      // GSI 在开局号角前会推空的 items/hero，别让空对象把已有数据抹掉
      // （数组不适用：events 为空是有意义的"本包无事件"）
      if (isEmptyObject(v) && !isEmptyObject(this.state[s]) && this.state[s] !== undefined) continue;
      this.state[s] = v;
    }
    return this.state;
  }
  reset() { this.state = {}; }
}
