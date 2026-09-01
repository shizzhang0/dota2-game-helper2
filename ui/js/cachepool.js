const SECTIONS = ["provider","map","player","hero","abilities","items",
                  "events","minimap","buildings","wearables"];
export class CachePool {
  constructor() { this.state = {}; }
  update(packet) {
    for (const s of SECTIONS)
      if (packet[s] !== undefined) this.state[s] = packet[s];
    return this.state;
  }
  reset() { this.state = {}; }
}
