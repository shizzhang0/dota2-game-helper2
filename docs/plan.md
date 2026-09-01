# Dota 2 GSI 覆盖层 v1 实施计划

> 逐任务执行，步骤用 checkbox（`- [ ]`）跟踪进度。

**Goal:** 按设计文档 `docs/design.md` 实现 Tauri 2 桌面覆盖层：五项时钟倒计时 + 敌方塔防 + 敌方买活 + 经济面板，纯 Alt 查询交互。

**Architecture:** 前端 vanilla JS + SVG，先用回放服务器（重放真实 dump）在浏览器里开发全部逻辑与样式；Rust/Tauri 壳（GSI 监听、Alt 轮询、窗口/热键/配置）最后接入。数据流：GSI 包 → 缓存池合并 → 对局管理 → 倒计时引擎/事件状态机/经济计算 → 渲染。

**Tech Stack:** Tauri 2（Rust: tiny_http, windows, winreg, reqwest, tauri-plugin-global-shortcut）；前端无框架 ES Modules；开发工具 Python 3 标准库（回放服务器）。

## Global Constraints

- **禁止 `git commit`**（用户全局规则）。本计划所有任务均无提交步骤；也不要 `git init`。
- **不保留单元测试**（用户全局规则）。验证用临时脚本（文件名前缀 `tmp_verify_`），运行确认后**必须删除**。
- **纯接收器**：不读内存、不改游戏文件（GSI cfg 除外，这是 Valve 官方机制）、不注入、不模拟输入。Alt 检测只用 `GetAsyncKeyState` 被动轮询。
- **时间常数一律外置** `constants/normal.json` / `constants/turbo.json`，代码不写死任何游戏常数。
- **动画只用 `transform` / `opacity`**；每秒 `setInterval` 驱动，不用 `requestAnimationFrame` 循环；不引入任何前端框架/库。
- GSI 端口固定 `127.0.0.1:53000`。
- dump 数据位于本仓库**同级目录** `../dota2_gsi_dump/dump/`（下称 `$DUMP`）：`raw_20260831_202544.jsonl`（两场快速局，用户先夜魇后天辉）、`raw_20260831_215612.jsonl`（一场正常局，用户天辉）。
- Dota 内部队伍常量：**2=天辉（slots 0-4），3=夜魇（slots 5-9）**。
- 事件字段解码以设计文档第四节为准（GLYPH playerid1=队伍；TOWER_KILL value=击杀方/value3=层级；TOWER_DENY value=丢塔方；BARRACKS_KILL value2 155近战/90远程；BUYBACK playerid1=槽位）。

## 文件结构

```
dota2-game-helper2/
├─ ui/                      # 前端（浏览器可直接开发，Tauri 直接复用）
│  ├─ index.html
│  ├─ css/overlay.css
│  └─ js/
│     ├─ source.js          # 数据源抽象：回放 SSE / Tauri event 二选一
│     ├─ cachepool.js       # GSI 增量包合并
│     ├─ match.js           # matchid 切分、game_state、模式判定
│     ├─ timers.js          # 倒计时引擎（纯函数）
│     ├─ events.js          # 事件去重 + 塔防/买活状态机
│     ├─ networth.js        # 净资产/GPM/XPM
│     ├─ render.js          # Alt 面板渲染（SVG 环）
│     └─ main.js            # 装配
├─ constants/
│  ├─ normal.json  turbo.json  towers.json  item_prices.json(快照)
├─ tools/
│  ├─ replay.py             # 回放服务器（SSE + 静态文件，保留为开发工具）
│  └─ fetch_prices.py       # OpenDota 价格快照（保留为开发工具）
└─ src-tauri/               # Task 9 起
   ├─ tauri.conf.json  Cargo.toml
   └─ src/main.rs  gsi.rs  altkey.rs  gsicfg.rs  prices.rs
```

---

### Task 1: 回放服务器

**Files:**
- Create: `tools/replay.py`

**Interfaces:**
- Produces: `GET /stream?file=<jsonl文件名>&speed=<倍速,默认8>` → SSE 流，每包一条 `data: <原始JSON>\n\n`，按 `provider.timestamp` 差值/speed 节奏推送（无 timestamp 时固定 0.3s/speed）
- Produces: `GET /<path>` → 静态服务 `ui/` 目录；`GET /constants/<f>` → 静态服务 `constants/` 目录
- 端口 8000

- [ ] **Step 1: 写 `tools/replay.py`**

```python
#!/usr/bin/env python3
"""回放服务器：静态服务 ui/ 与 constants/，SSE 重放 dump。用法：python tools/replay.py"""
import json, time, mimetypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT.parent / "dota2_gsi_dump" / "dump"
PORT = 8000

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/stream":
            return self.stream(parse_qs(u.query))
        rel = u.path.lstrip("/") or "index.html"
        base = ROOT / ("constants" if rel.startswith("constants/") else "ui")
        f = (ROOT / rel) if rel.startswith("constants/") else (base / rel)
        f = f.resolve()
        if not (str(f).startswith(str(ROOT)) and f.is_file()):
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.end_headers()
        self.wfile.write(f.read_bytes())

    def stream(self, q):
        name = q.get("file", ["raw_20260831_215612.jsonl"])[0]
        speed = float(q.get("speed", ["8"])[0])
        path = DUMP / name
        if not path.is_file():
            self.send_error(404, f"no dump {name}"); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        prev_ts = None
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line: continue
                    ts = None
                    try: ts = json.loads(line).get("provider", {}).get("timestamp")
                    except Exception: pass
                    delay = 0.3 if (ts is None or prev_ts is None) else max(0.0, min(ts - prev_ts, 2.0))
                    prev_ts = ts if ts is not None else prev_ts
                    time.sleep(delay / speed)
                    self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}  (stream: /stream?file=...&speed=8)")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
```

- [ ] **Step 2: 验证 SSE**

Run: 后台起 `python tools/replay.py`，然后
`curl -s -N "http://127.0.0.1:8000/stream?speed=100" | head -c 400`
Expected: 若干行以 `data: {"provider"` 开头的 JSON。

---

### Task 2: 前端骨架 + 数据源

**Files:**
- Create: `ui/index.html`, `ui/js/source.js`, `ui/js/main.js`（最小版）, `ui/css/overlay.css`（空壳）

**Interfaces:**
- Produces: `connectSource(onPacket: (obj)=>void): void` — 浏览器下连 `/stream`（URL 查询参数 `?file=&speed=` 透传），Tauri 下监听 `gsi` 事件
- Produces: `onAltChange(cb: (down: boolean)=>void): void` — 浏览器下用 keydown/keyup(Alt, 需 preventDefault)，Tauri 下监听 `alt` 事件
- Produces: `isTauri(): boolean`（判据 `!!window.__TAURI__`）

- [ ] **Step 1: 写 `ui/js/source.js`**

```js
export function isTauri() { return !!window.__TAURI__; }

export function connectSource(onPacket) {
  if (isTauri()) {
    window.__TAURI__.event.listen("gsi", (e) => onPacket(e.payload));
    return;
  }
  const qs = new URLSearchParams(location.search);
  const file = qs.get("file"), speed = qs.get("speed") || "8";
  const url = `/stream?speed=${speed}` + (file ? `&file=${file}` : "");
  const es = new EventSource(url);
  es.onmessage = (m) => onPacket(JSON.parse(m.data));
}

export function onAltChange(cb) {
  if (isTauri()) {
    window.__TAURI__.event.listen("alt", (e) => cb(e.payload === true));
    return;
  }
  addEventListener("keydown", (e) => { if (e.key === "Alt") { e.preventDefault(); cb(true); } });
  addEventListener("keyup",   (e) => { if (e.key === "Alt") { e.preventDefault(); cb(false); } });
  addEventListener("blur", () => cb(false));
}
```

- [ ] **Step 2: 写 `ui/index.html` 与最小 `ui/js/main.js`**

```html
<!doctype html>
<meta charset="utf-8">
<title>helper2</title>
<link rel="stylesheet" href="css/overlay.css">
<div id="hud"></div>
<div id="panel" hidden></div>
<script type="module" src="js/main.js"></script>
```

```js
// main.js（骨架版，后续任务逐步替换）
import { connectSource, onAltChange } from "./source.js";
let n = 0;
connectSource((pkt) => {
  n++;
  document.getElementById("hud").textContent =
    `pkt=${n} clock=${pkt.map?.clock_time} state=${pkt.map?.game_state}`;
});
onAltChange((d) => { document.getElementById("panel").hidden = !d; });
```

- [ ] **Step 3: 浏览器验证**

Run: replay.py 运行中，打开 `http://127.0.0.1:8000/?speed=50`
Expected: hud 行的 pkt 递增、clock 递增、state 走到 GAME_IN_PROGRESS；按住 Alt 时 `#panel`（暂空）hidden 切换（DevTools 里看）。

---

### Task 3: 缓存池 + 对局管理 + 模式判定

**Files:**
- Create: `ui/js/cachepool.js`, `ui/js/match.js`
- Modify: `ui/js/main.js`

**Interfaces:**
- Produces: `class CachePool { update(packet): state; reset(): void }` — state 为分段合并结果（包里出现的顶层段整段替换，未出现的保留旧值；`previously`/`added` 段丢弃不并入）
- Produces: `class MatchTracker { update(state): info }`，info = `{ matchid, clock, gameState, inMatch, myTeam(2|3|null), mode("turbo"|"normal"|null), modeOrDefault, paused }`；matchid 变化时返回 `info.newMatch === true`（供 main 重置其他模块）
- 模式判定：`clock >= 60 && gold_from_income/clock > 2.2` → turbo，否则 normal；判定一次后锁定；`modeOrDefault` 未判定时返回 `"turbo"`

- [ ] **Step 1: 写 `ui/js/cachepool.js`**

```js
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
```

- [ ] **Step 2: 写 `ui/js/match.js`**

```js
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
```

- [ ] **Step 3: main.js 接入并在 hud 显示 `matchid/mode/myTeam/inMatch`**

```js
import { connectSource, onAltChange } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
const pool = new CachePool(), match = new MatchTracker();
connectSource((pkt) => {
  const st = pool.update(pkt);
  const info = match.update(st);
  if (info.newMatch) pool.reset();          // 新对局清池（保留本包已并入的段即可）
  document.getElementById("hud").textContent =
    `${info.matchid} clock=${info.clock} mode=${info.mode} team=${info.myTeam} in=${info.inMatch}`;
});
onAltChange((d) => { document.getElementById("panel").hidden = !d; });
```

- [ ] **Step 4: 三份回放验证模式判定**

Run: 浏览器分别打开
`/?file=raw_20260831_215612.jsonl&speed=100` → Expected: mode=normal，team=2；
`/?file=raw_20260831_202544.jsonl&speed=100` → Expected: 第一场 mode=turbo，team=3；matchid 中途切换为 8975953942，mode 重判仍 turbo，team=2。

---

### Task 4: 常数表 + 倒计时引擎

**Files:**
- Create: `constants/normal.json`, `constants/turbo.json`, `ui/js/timers.js`
- Modify: `ui/js/main.js`

**Interfaces:**
- Produces: `loadConstants(mode): Promise<C>`（fetch `/constants/<mode>.json`，缓存）
- Produces: `computeTimers(clock, C): Timer[]`，Timer = `{ id, label, remaining(秒), kind }`；id ∈ `mid|bounty|wisdom|lotus|stack`；clock 为 null 或 <0 时只返回未来首刷项（remaining 相对 clock 计算，负 clock 也成立）
- 后续任务依赖常数：`C.glyphCooldown`、`C.buybackCooldown`、`C.aghsShardValue`、`C.aghsScepterValue`

- [ ] **Step 1: 写 `constants/normal.json`**

```json
{
  "mode": "normal",
  "midRune": {
    "fixed": [ { "clock": 0, "kind": "bounty" },
               { "clock": 120, "kind": "water" },
               { "clock": 240, "kind": "water" } ],
    "repeat": { "fromClock": 360, "every": 120, "kind": "power" }
  },
  "bounty": { "start": 0, "every": 180 },
  "lotus":  { "start": 180, "every": 180 },
  "wisdom": { "start": 420, "every": 420 },
  "stack":  { "every": 60, "windowStart": 50 },
  "glyphCooldown": 300,
  "buybackCooldown": 480,
  "aghsShardValue": 1400,
  "aghsScepterValue": 4200
}
```

- [ ] **Step 2: 写 `constants/turbo.json`** — 内容与 normal.json 相同（mode 改 "turbo"）。**已知快速模式主要差异在金钱/经验倍率而非符时间**；Step 5 用 dump 校准赏金符，其余项待 Task 13 进游戏实测修正（这正是双表外置的意义）。

- [ ] **Step 3: 写 `ui/js/timers.js`**

```js
const KIND_LABEL = { bounty: "赏金", water: "圣水", power: "强化",
                     wisdom: "智慧", lotus: "莲花", stack: "堆野" };
const cache = {};
export async function loadConstants(mode) {
  if (!cache[mode]) cache[mode] = await (await fetch(`/constants/${mode}.json`)).json();
  return cache[mode];
}
function nextTick(clock, start, every) {
  return clock < start ? start
       : start + (Math.floor((clock - start) / every) + 1) * every;
}
function nextMidRune(clock, mr) {
  for (const e of mr.fixed) if (clock < e.clock) return e;
  const r = mr.repeat;
  return { clock: nextTick(clock, r.fromClock - r.every, r.every) < r.fromClock
                  ? r.fromClock : nextTick(clock, r.fromClock, r.every),
           kind: r.kind };
}
export function computeTimers(clock, C) {
  if (clock === null) return [];
  const t = [];
  const mr = nextMidRune(clock, C.midRune);
  t.push({ id: "mid", label: KIND_LABEL[mr.kind], kind: mr.kind, remaining: mr.clock - clock });
  for (const id of ["bounty", "lotus", "wisdom"]) {
    const c = C[id];
    t.push({ id, label: KIND_LABEL[id === "bounty" ? "bounty" : id], kind: id,
             remaining: nextTick(clock, c.start, c.every) - clock });
  }
  if (clock >= 0) {
    const next = (Math.floor(clock / 60) + 1) * 60;
    t.push({ id: "stack", label: KIND_LABEL.stack, kind: "stack", remaining: next - clock });
  }
  return t;
}
```

注意 `nextMidRune` 的 repeat 分支要处理"clock 已过 fromClock"与"还没到 fromClock"两种情况：clock<360 时下一次是 360（若 fixed 已耗尽），clock≥360 时是下一个 360+120k。上面实现如有疑义可简化为：

```js
function nextMidRune(clock, mr) {
  for (const e of mr.fixed) if (clock < e.clock) return e;
  const r = mr.repeat;
  if (clock < r.fromClock) return { clock: r.fromClock, kind: r.kind };
  return { clock: nextTick(clock, r.fromClock, r.every), kind: r.kind };
}
```

（用第二版，语义直白。）

- [ ] **Step 4: 临时脚本验证引擎**

写 `tmp_verify_timers.mjs`：

```js
import { computeTimers } from "./ui/js/timers.js";
const C = JSON.parse((await import("fs")).readFileSync("constants/normal.json", "utf-8"));
const cases = [
  [-30, "mid", 30],    // 开局前30s → 0:00 赏金
  [0,   "mid", 120],   // 0:00 已刷 → 下一个 2:00 圣水
  [130, "mid", 110],   // → 4:00 圣水
  [250, "mid", 110],   // → 6:00 强化
  [400, "mid", 80],    // → 8:00 强化
  [0,   "bounty", 180],
  [170, "lotus", 10],
  [419, "wisdom", 1],
  [420, "wisdom", 420],
  [61,  "stack", 59],
];
let fail = 0;
for (const [clock, id, want] of cases) {
  const got = computeTimers(clock, C).find(t => t.id === id)?.remaining;
  if (got !== want) { console.log(`FAIL clock=${clock} ${id}: got ${got} want ${want}`); fail++; }
}
console.log(fail ? `${fail} FAIL` : "ALL PASS");
```

Run: `node tmp_verify_timers.mjs`（timers.js 中 `fetch` 未被该脚本触发，仅用纯函数）
Expected: `ALL PASS`

- [ ] **Step 5: 校准快速模式赏金符**

写 `tmp_verify_turbo.mjs`：读 `$DUMP/raw_20260831_202544.jsonl`，收集 `bounty_rune_pickup` 事件的 `game_time`，同包 `map.clock_time` 与 `map.game_time` 差值换算成 clock，打印各拾取 clock 对 180 取模的余数分布。
Expected: 余数集中在 0~40s 区间（拾取滞后于刷新），证明快速模式赏金符同为 3 分钟周期。若明显不是 180 周期，按实测改 `turbo.json`。

- [ ] **Step 6: 删除 `tmp_verify_timers.mjs`、`tmp_verify_turbo.mjs`**

- [ ] **Step 7: main.js 接入**：`loadConstants(info.modeOrDefault)` 后每包计算 timers，hud 追加显示各 id 的 remaining。回放 normal 局抽查两个时刻与手算一致。

---

### Task 5: 事件管线：去重 + 塔防 + 买活状态机

**Files:**
- Create: `ui/js/events.js`, `constants/towers.json`
- Modify: `ui/js/main.js`

**Interfaces:**
- Consumes: MatchTracker 的 info（`myTeam`、`clock`）、CachePool 的 state（`minimap`）、原始 packet（`events`）
- Produces: `class EventTracker { constructor(C); reset(); update(packet, state, info); enemyGlyph(info): {ready, remaining}; enemyBuybacks(info): Array<{slot, remaining}> }`
  - `enemyGlyph` remaining 单位秒，ready=true 时 remaining=0
  - `enemyBuybacks` 只返回冷却中的敌方槽位（remaining>0）

- [ ] **Step 1: 写 `constants/towers.json`**（坐标提取自实测 dump，层级按地图位置人工标定）

```json
{ "tolerance": 300, "towers": [
  { "team": 2, "tier": 1, "x": -6336, "y": 1856 },
  { "team": 2, "tier": 2, "x": -6501, "y": -872 },
  { "team": 2, "tier": 3, "x": -6592, "y": -3408 },
  { "team": 2, "tier": 1, "x": -1544, "y": -1408 },
  { "team": 2, "tier": 2, "x": -3190, "y": -2926 },
  { "team": 2, "tier": 3, "x": -4640, "y": -4144 },
  { "team": 2, "tier": 1, "x": 4859,  "y": -6379 },
  { "team": 2, "tier": 2, "x": -360,  "y": -6256 },
  { "team": 2, "tier": 3, "x": -3952, "y": -6112 },
  { "team": 2, "tier": 4, "x": -5712, "y": -4864 },
  { "team": 2, "tier": 4, "x": -5392, "y": -5192 },
  { "team": 3, "tier": 1, "x": -5274, "y": 6036 },
  { "team": 3, "tier": 2, "x": -128,  "y": 6016 },
  { "team": 3, "tier": 3, "x": 3552,  "y": 5776 },
  { "team": 3, "tier": 1, "x": 524,   "y": 652 },
  { "team": 3, "tier": 2, "x": 2496,  "y": 2112 },
  { "team": 3, "tier": 3, "x": 4272,  "y": 3759 },
  { "team": 3, "tier": 1, "x": 6269,  "y": -2240 },
  { "team": 3, "tier": 2, "x": 6400,  "y": 384 },
  { "team": 3, "tier": 3, "x": 6336,  "y": 3032 },
  { "team": 3, "tier": 4, "x": 4944,  "y": 4776 },
  { "team": 3, "tier": 4, "x": 5280,  "y": 4432 }
] }
```

- [ ] **Step 2: 写 `ui/js/events.js`**

```js
let TOWERS = null;
export async function loadTowers() {
  if (!TOWERS) TOWERS = await (await fetch("/constants/towers.json")).json();
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
  }
  update(packet, state, info) {
    const now = info.clock;
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
```

- [ ] **Step 3: main.js 接入**（`info.newMatch` 时 `tracker.reset()`；每包 `tracker.update(pkt, st, info)`；hud 追加 glyph/buyback 状态）

- [ ] **Step 4: 三局回归验证（关键步骤）**

写 `tmp_verify_events.mjs`（node 无 fetch 静态文件问题：直接 `fs.readFileSync` towers.json 传入构造函数）：

```js
import fs from "fs";
import readline from "readline";
import { EventTracker } from "./ui/js/events.js";
import { CachePool } from "./ui/js/cachepool.js";
import { MatchTracker } from "./ui/js/match.js";
const C = JSON.parse(fs.readFileSync("constants/normal.json", "utf-8"));
const TOWERS = JSON.parse(fs.readFileSync("constants/towers.json", "utf-8"));
const DUMP = "../dota2_gsi_dump/dump/";   // 脚本在仓库根目录运行
let fails = 0, checks = 0;
for (const f of ["raw_20260831_202544.jsonl", "raw_20260831_215612.jsonl"]) {
  const pool = new CachePool(), match = new MatchTracker();
  let tracker = new EventTracker(C, TOWERS);
  const rl = readline.createInterface({ input: fs.createReadStream(DUMP + f) });
  for await (const line of rl) {
    const pkt = JSON.parse(line);
    const st = pool.update(pkt);
    const info = match.update(st);
    if (info.newMatch) { tracker = new EventTracker(C, TOWERS); }
    // 断言：每次观察到 GLYPH_USED 时，状态机在“处理该事件前”必须处于 ready
    for (const ev of pkt.events || []) {
      if (ev.event_type !== "generic_event" || !ev.data.includes("GLYPH_USED")) continue;
      const j = JSON.parse(ev.data);
      if (tracker.seen.has(j.type + "|" + j.time)) continue;
      const g = tracker.glyph[j.playerid1];
      checks++;
      if (info.clock !== null && info.clock < g.readyAt) {
        console.log(`FAIL ${f} clock=${info.clock} team=${j.playerid1} readyAt=${g.readyAt}`);
        fails++;
      }
    }
    tracker.update(pkt, st, info);
  }
}
console.log(`${checks} glyph uses checked, ${fails} FAIL${fails ? "" : " — ALL PASS"}`);
```

Run: `node tmp_verify_events.mjs`
Expected: `16 glyph uses checked, 0 FAIL — ALL PASS`（16 = 三局去重后的塔防总数）。若有 FAIL，逐条对照设计文档第四节的规则排查，禁止靠放宽断言过关。

- [ ] **Step 5: 删除 `tmp_verify_events.mjs`**

---

### Task 6: 经济面板逻辑

**Files:**
- Create: `ui/js/networth.js`, `tools/fetch_prices.py`, `constants/item_prices.json`（快照产物）
- Modify: `ui/js/main.js`

**Interfaces:**
- Produces: `computeEcon(state, prices, C): { networth, gpm, xpm }`
- prices 形状 = OpenDota `constants/items` 原样（`{ blink: { cost: 2250, ... }, ... }`）
- Produces: `loadPrices(): Promise<prices>` — Tauri 下 `invoke("get_item_prices")`（Task 11 提供），浏览器下 fetch `/constants/item_prices.json`

- [ ] **Step 1: 写 `tools/fetch_prices.py` 并运行生成快照**

```python
#!/usr/bin/env python3
import json, urllib.request
from pathlib import Path
URL = "https://api.opendota.com/api/constants/items"
out = Path(__file__).resolve().parent.parent / "constants" / "item_prices.json"
data = json.load(urllib.request.urlopen(URL))
out.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
print(f"{len(data)} items -> {out}")
```

Run: `python tools/fetch_prices.py`
Expected: 打印条目数（数百），生成 `constants/item_prices.json`。

- [ ] **Step 2: 写 `ui/js/networth.js`**

```js
import { isTauri } from "./source.js";
export async function loadPrices() {
  if (isTauri()) return await window.__TAURI__.core.invoke("get_item_prices");
  return await (await fetch("/constants/item_prices.json")).json();
}
export function computeEcon(state, prices, C) {
  const p = state.player || {}, h = state.hero || {}, items = state.items || {};
  let nw = p.gold ?? 0;
  for (const [slot, it] of Object.entries(items)) {
    if (!it || typeof it !== "object") continue;
    if (slot.startsWith("neutral") || slot.startsWith("preserved_neutral")) continue;
    const name = it.name;
    if (!name || name === "empty") continue;
    nw += prices[name.replace(/^item_/, "")]?.cost || 0;
  }
  if (h.aghanims_shard) nw += C.aghsShardValue;
  if (h.permanent_buffs && "modifier_item_ultimate_scepter_consumed" in h.permanent_buffs)
    nw += C.aghsScepterValue;
  return { networth: nw, gpm: p.gpm ?? 0, xpm: p.xpm ?? 0 };
}
```

- [ ] **Step 3: main.js 接入并回放验证**

Run: 回放 normal 局 speed=100 看到终盘；hud 显示 networth/gpm/xpm。
Expected: networth 随时间单调上升为主（买装备瞬间不跌为负）、量级合理（终盘普通局 1w~2w）；gpm/xpm 与 dump 实测（Pugna 局 gpm≈512@600s）同量级。

---

### Task 7: Alt 面板 UI 与样式

**Files:**
- Create: `ui/css/overlay.css`（完整版）, `ui/js/render.js`, `ui/dev.html`
- Modify: `ui/js/main.js`, `ui/index.html`

**Interfaces:**
- Consumes: Timer[]、`enemyGlyph()`、`enemyBuybacks()`、`computeEcon()` 的返回值
- Produces: `initPanel(rootEl): void`；`render(model): void`，model =
  `{ visible, editMode, timers: Timer[], glyph: {ready, remaining}, buybacks: [{slot, remaining}], econ: {networth, gpm, xpm} }`
- 槽位颜色常量（Dota 固定玩家色，按槽位 0-9）：
  `["#3375FF","#66FFBF","#BF00BF","#F3F00B","#FF6B00","#FE86C2","#A1B447","#65D9F7","#008321","#A46900"]`

- [ ] **Step 1: 写 `ui/js/render.js`** — 结构：一行水平排列的格子，每格 = SVG 环 + 中央数字 + 底部小标签；塔防格用图标底色区分 ready（绿）/冷却（灰+倒计时）；买活为一排小色点（冷却中显示剩余秒）；经济为纯文本格。环实现：

```js
const R = 26, CIRC = 2 * Math.PI * R;
function cell(id, label) {
  return `<div class="cell" id="c-${id}">
    <svg viewBox="0 0 60 60">
      <circle class="ring-bg" cx="30" cy="30" r="${R}"/>
      <circle class="ring-fg" cx="30" cy="30" r="${R}"
              stroke-dasharray="${CIRC}" stroke-dashoffset="0"/>
    </svg>
    <div class="num">--</div><div class="lab">${label}</div></div>`;
}
```

`render()` 每次更新：`.num` 文本 = remaining 格式化（`m:ss`，<60 只显秒）；`.ring-fg` 的 `stroke-dashoffset = CIRC * (1 - remaining / period)`，period 取各计时器周期（mid 用当前段间隔，stack 用 60）——**offset 变化经 CSS `transition: stroke-dashoffset .9s linear` 平滑**。塔防/买活/经济不用环也可以（塔防用状态色块）。

- [ ] **Step 2: 写 `ui/css/overlay.css`** — 硬约束逐条落实：
  - `#panel` `position:fixed`，位置来自配置（默认屏幕上方中央），`pointer-events:none`（编辑态除外）
  - 文字 `paint-order` 不适用于 HTML，用 `text-shadow: 0 0 3px #000, 0 1px 2px #000` + 格子半透明深底 `background:rgba(0,0,0,.55); border-radius:8px`
  - 字体 `font-family:"Segoe UI",sans-serif; font-variant-numeric:tabular-nums; font-weight:600`
  - 出现/消失用 `opacity` transition（120ms）；除 `stroke-dashoffset`/`opacity`/`transform` 外无任何 transition
  - `body{background:transparent}`（Tauri 透明窗口必需）

- [ ] **Step 3: 写 `ui/dev.html`** — 与 index.html 相同但 body 背景铺一张游戏截图：`<body style="background:url(dev/bg.jpg) center/cover">`。**请用户放 1~3 张实战截图**（最亮团战/最暗野区/特效最花）到 `ui/dev/`，无截图时用深色渐变兜底。

- [ ] **Step 4: main.js 完整装配**（此后 main.js 为最终形态）：

```js
import { connectSource, onAltChange } from "./source.js";
import { CachePool } from "./cachepool.js";
import { MatchTracker } from "./match.js";
import { loadConstants, computeTimers } from "./timers.js";
import { EventTracker, loadTowers } from "./events.js";
import { loadPrices, computeEcon } from "./networth.js";
import { initPanel, render } from "./render.js";

const pool = new CachePool(), match = new MatchTracker();
let tracker = null, C = null, prices = null, alt = false, last = null;

initPanel(document.getElementById("panel"));
prices = await loadPrices();
const towers = await loadTowers();

connectSource(async (pkt) => {
  const st = pool.update(pkt);
  const info = match.update(st);
  C = await loadConstants(info.modeOrDefault);
  if (!tracker || info.newMatch) tracker = new EventTracker(C, towers);
  tracker.C = C;                       // 模式判定完成后热切常数
  tracker.update(pkt, st, info);
  last = { st, info };
});
onAltChange((d) => { alt = d; });

setInterval(() => {
  if (!last) return;
  const { st, info } = last;
  render({
    visible: alt && info.inMatch,
    editMode: false,
    timers: C ? computeTimers(info.clock, C) : [],
    glyph: tracker ? tracker.enemyGlyph(info) : { ready: true, remaining: 0 },
    buybacks: tracker ? tracker.enemyBuybacks(info) : [],
    econ: prices && C ? computeEcon(st, prices, C) : { networth: 0, gpm: 0, xpm: 0 },
  });
}, 250);
```

- [ ] **Step 5: 样式验证** — 回放 turbo 局，`dev.html` 三张截图背景下按住 Alt 逐张检查：数字在最亮/最暗背景都可读；倒计时数字宽度不抖；环平滑。DevTools Performance 录 10s：无每帧重排（Layout 次数≈0）。

---

### Task 8: Rust 环境 + Tauri 脚手架

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`（骨架）, `src-tauri/build.rs`, `src-tauri/icons/`（tauri 默认图标）

**Interfaces:**
- Produces: 可 `cargo tauri dev` 启动的透明/无边框/置顶/全屏幕尺寸/默认穿透窗口，加载 `ui/`

- [ ] **Step 1: 安装环境**（若已装则跳过）：`winget install Rustlang.Rustup` 后 `rustup default stable-msvc`；确认 VS Build Tools（含 C++ 工作负载）已装；`cargo install tauri-cli --version "^2"`。验证：`cargo tauri --version`。

- [ ] **Step 2: 写 `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "dota2-game-helper2",
  "version": "0.1.0",
  "identifier": "dev.dota2helper2.app",
  "build": { "frontendDist": "../ui" },
  "app": {
    "windows": [{
      "label": "overlay", "transparent": true, "decorations": false,
      "alwaysOnTop": true, "skipTaskbar": true, "resizable": false,
      "shadow": false, "fullscreen": false
    }],
    "security": { "csp": null }
  }
}
```

- [ ] **Step 3: 写 `src-tauri/src/main.rs` 骨架** — setup 钩子里：取主显示器尺寸，`set_size` / `set_position(0,0)`、`set_ignore_cursor_events(true)`。

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod gsi; mod altkey; mod gsicfg; mod prices;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let w = app.get_webview_window("overlay").unwrap();
            if let Some(mon) = w.primary_monitor()? {
                w.set_position(tauri::PhysicalPosition::new(0, 0))?;
                w.set_size(*mon.size())?;
            }
            w.set_ignore_cursor_events(true)?;
            gsi::spawn(app.handle().clone());
            altkey::spawn(app.handle().clone());
            gsicfg::ensure_cfg();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            prices::get_item_prices, save_layout, load_layout, set_edit_mode
        ])
        .run(tauri::generate_context!())
        .expect("tauri run");
}
```

（`save_layout` / `load_layout` / `set_edit_mode` 在 Task 10 实现；本任务先放空实现让编译通过：）

```rust
#[tauri::command] fn save_layout(_layout: String) {}
#[tauri::command] fn load_layout() -> String { String::from("{}") }
#[tauri::command] fn set_edit_mode(_on: bool) {}
```

`gsi.rs` / `altkey.rs` / `gsicfg.rs` / `prices.rs` 本任务先建空壳（`pub fn spawn(_: tauri::AppHandle) {}` / `pub fn ensure_cfg() {}` / 返回空 JSON 的 command），Task 9-11 填实。

- [ ] **Step 4: 验证**：`cargo tauri dev` — 出现覆盖整屏的透明窗口（桌面上按住 Alt 无数据不显示面板属正常）；鼠标点击穿透到桌面；任务栏无图标。

---

### Task 9: GSI 监听 + 自动写 cfg（Rust）

**Files:**
- Modify: `src-tauri/src/gsi.rs`, `src-tauri/src/gsicfg.rs`, `src-tauri/Cargo.toml`（加 `tiny_http = "0.12"`, `winreg = "0.55"`, `serde_json = "1"`）

**Interfaces:**
- Produces: POST 到 `127.0.0.1:53000` 的 GSI 包 → `app.emit("gsi", <serde_json::Value>)`（前端 source.js 已监听）
- Produces: `gsicfg::ensure_cfg()` — 定位 Dota 目录并写入 GSI 配置（已存在且内容相同则跳过）

- [ ] **Step 1: 写 `gsi.rs`**

```rust
use tauri::{AppHandle, Emitter};
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let server = tiny_http::Server::http("127.0.0.1:53000").expect("bind 53000");
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            use std::io::Read;
            let _ = req.as_reader().read_to_string(&mut body);
            let _ = req.respond(tiny_http::Response::from_string("ok"));
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let _ = app.emit("gsi", v);
            }
        }
    });
}
```

- [ ] **Step 2: 写 `gsicfg.rs`** — 定位：注册表 `HKCU\Software\Valve\Steam` 的 `SteamPath` → 读 `steamapps/libraryfolders.vdf`，正则提取所有 `"path"\s+"([^"]+)"`，在每个库找 `steamapps/common/dota 2 beta/game/dota/cfg/`；找到后建 `gamestate_integration/` 并写：

```rust
const CFG: &str = r#""dota2-game-helper2"
{
  "uri" "http://127.0.0.1:53000/"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.1"
  "heartbeat" "30.0"
  "data"
  {
    "provider" "1"  "map" "1"  "player" "1"  "hero" "1"
    "abilities" "1" "items" "1" "events" "1" "minimap" "1"
  }
}
"#;
```

文件名 `gamestate_integration_helper2.cfg`。找不到 Dota 目录时仅打印日志，不报错（用户可手动放）。

- [ ] **Step 3: 验证**：`cargo tauri dev` 后——
  a. `Invoke-WebRequest -Method POST -Uri http://127.0.0.1:53000/ -Body '{"map":{"clock_time":100,"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":"1","paused":false}}' -ContentType application/json`，按住 Alt 应见面板出现且 clock 生效；
  b. 检查 Dota cfg 目录出现 `gamestate_integration_helper2.cfg`，内容一致。

---

### Task 10: Alt 轮询 + 热键 + 编辑模式 + 配置持久化

**Files:**
- Modify: `src-tauri/src/altkey.rs`, `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`（加 `windows = { version = "0.58", features = ["Win32_UI_Input_KeyboardAndMouse"] }`, `tauri-plugin-global-shortcut = "2"`）, `ui/js/render.js`, `ui/js/main.js`

**Interfaces:**
- Produces: `app.emit("alt", bool)`（仅状态变化时发）
- Produces: 全局热键 `Ctrl+Alt+F10` → `app.emit("edit", bool)`（切换编辑态）+ 同步 `set_ignore_cursor_events(!edit)`
- Produces（补全 Task 8 空实现）: `save_layout(layout: String)` / `load_layout() -> String` — JSON 字符串 `{"x":..,"y":..}` 存 `app_config_dir()/layout.json`
- 前端：编辑态给 `#panel` 加 `pointer-events:auto` + 拖拽（pointerdown/move/up 改 `left/top`），拖完 `invoke("save_layout", ...)`；启动时 `load_layout` 恢复位置

- [ ] **Step 1: 写 `altkey.rs`**

```rust
use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut prev = false;
        loop {
            let down = unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } as u16 & 0x8000 != 0;
            if down != prev { prev = down; let _ = app.emit("alt", down); }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });
}
```

- [ ] **Step 2: main.rs 注册热键**（plugin global-shortcut，`CmdOrCtrl+Alt+F10`），回调里翻转 `AtomicBool` 编辑态、`set_ignore_cursor_events(!edit)`、`emit("edit", edit)`。实现 `save_layout`/`load_layout`（`std::fs` 读写 `app.path().app_config_dir()`）。

- [ ] **Step 3: 前端编辑态**：render.js 监听 `edit` 事件（Tauri 下）或按键 `e` （浏览器 dev 下）切换；编辑态显示面板边框虚线 + 可拖拽；位置应用到 `#panel.style.left/top`，浏览器 dev 下存 localStorage。

- [ ] **Step 4: 验证**：`cargo tauri dev` + 桌面手动 POST 数据（同 Task 9）——按住物理 Alt 面板出现；Ctrl+Alt+F10 后面板可拖，拖动后重启程序位置保留；再按热键恢复穿透（点击穿到桌面）。

---

### Task 11: 价格表拉取（Rust）

**Files:**
- Modify: `src-tauri/src/prices.rs`, `src-tauri/Cargo.toml`（加 `reqwest = { version = "0.12", features = ["blocking", "json", "rustls-tls"], default-features = false }`）

**Interfaces:**
- Produces（补全空壳）: `#[tauri::command] get_item_prices() -> serde_json::Value` — 内存缓存 → 磁盘缓存（`app_config_dir()/item_prices.json`）→ OpenDota `https://api.opendota.com/api/constants/items`（成功后写盘）；全部失败返回打包的 `constants/item_prices.json`（`include_str!` 内嵌快照兜底）

- [ ] **Step 1: 实现 `prices.rs`**（阻塞 fetch 放 `tauri::async_runtime::spawn_blocking`；三层回退顺序：内存 → OpenDota（写盘+入内存）→ 磁盘缓存 → 内嵌快照）

- [ ] **Step 2: 验证**：断网跑一次（应回退内嵌快照，面板净资产仍有数）、联网跑一次（`app_config_dir` 出现 `item_prices.json`）。

---

### Task 12: 进游戏联调与校准（人工，用户参与）

**Files:**
- Modify: `constants/turbo.json`（按实测）, `docs/design.md`（回填实测结论）

- [ ] **Step 1**: Dota 启动项确认 `-gamestateintegration`；游戏内切**无边框窗口**。
- [ ] **Step 2**: 打一局快速模式（人机即可），核对清单：
  - 面板只在按住 Alt 且局内出现；锁定态完全不影响操作
  - 五项倒计时与游戏实际刷新对齐（重点：圣水 2:00/4:00、强化 6:00 起、快速模式差异记录进 turbo.json）
  - 敌方塔防：敌方开塔防瞬间进入冷却；己方推掉敌方一塔后显示 ready
  - 敌方买活出现色点倒计时；净资产量级与赛后面板对比误差 < 5%
  - 性能：游戏帧率无感知下降（对照关闭程序）
- [ ] **Step 3**: 中途重启程序一次，验证塔防里程碑重建（minimap 路径）不出错。
- [ ] **Step 4**: 实测差异回填 `turbo.json` 与设计文档"待实测"处；把 Alt 在游戏内按住时是否与游戏自身 Alt 功能有体感冲突记录下来，若有则考虑改配置键。

---

## Self-Review 记录

- **Spec 覆盖**：五项倒计时（Task 4/7）✓ 塔防+买活（Task 5）✓ 经济面板（Task 6）✓ 纯 Alt（Task 2/10）✓ 智能显隐（main.js `visible = alt && inMatch`）✓ 自动写 cfg（Task 9）✓ 模式判定（Task 3）✓ 锁定/编辑+热键+位置持久化（Task 10）✓ OpenDota 价格三层回退（Task 11）✓ 中途启动重建（Task 5 reconstruct + Task 12 实测）✓ v2 眼位监控不在本计划 ✓
- **一致性**：队伍常量 2/3、槽位区间、`modeOrDefault` 默认 turbo、事件去重键 `type|time`、towers.json tolerance=300 全文一致；`get_item_prices` 在 Task 6 消费、Task 11 生产，签名一致。
- **已知妥协**（有意为之，非遗漏）：近战兵营里程碑不做中途重建（minimap 无法区分近/远程兵营，后果是极端情况下把敌方塔防显示为 ready 而实际在冷却，方向安全）；事件时间用观察时刻 clock 而非事件 time 字段（误差 ≤2s，低于显示粒度）。
