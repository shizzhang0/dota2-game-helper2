# Dota 2 GSI 覆盖层 v2 实施计划

> 逐任务执行，步骤用 checkbox（`- [ ]`）跟踪进度。

**Goal:** 按 [design-v2.md](design-v2.md) 实现：眼位小地图、托盘与编辑态、文件日志、对局录制。

**Architecture:** 前端新增三个模块（minimap 解析与眼位状态、SVG 小地图渲染、编辑态设置卡片）并接入现有 render 管线；Rust 新增四个模块（settings / log / record / tray）。设置存 `settings.json`，保存后 emit 事件让覆盖层实时生效。

> **Task 4/6 已返工**：设置最初做成独立窗口（Task 4）、托盘分「设置」与「调整面板位置」两项（Task 6），上手后推翻，合并为单一编辑态。**最终形态以 [Task 9](#task-9-设置窗口并入编辑态返工) 为准**，Task 4/6 保留作为过程记录。

**Tech Stack:** 与 v1 相同（Tauri 2 / vanilla JS + SVG / Python 开发工具），新增 Rust 依赖 `flate2`（gzip）与 `tauri` 的 `tray-icon` feature。

## Global Constraints

- **禁止 `git commit`**（用户全局规则），除非用户明确要求。本计划所有任务均无提交步骤。
- **不保留单元测试**（用户全局规则）。验证用临时脚本，文件名前缀 `tmp_verify_`，运行确认后**必须删除**。
- **纯接收器**：不读内存、不改游戏文件（GSI cfg 除外）、不注入、不模拟输入。
- **常数一律外置**到 `constants/*.json`，代码不写死游戏常数。
- **动画只用 `transform` / `opacity`**；不引入任何前端框架或图表库。
- **前端是编译期嵌入的**：改 `ui/` 后 cargo 不会自动重编，必须 `touch src-tauri/src/main.rs` 再 build。
- dump 数据位于同级目录 `../dota2_gsi_dump/dump/`：`raw_20260831_202544.jsonl`（两场快速局）、`raw_20260831_215612.jsonl`（一场正常局）。验证必须按 `map.matchid` 切分。
- 地图坐标：±8400 正方形，x 向右、y 向上（画到屏幕 y 要翻转）。
- 眼的 `team` 是 2（天辉）/ 3（夜魇），**与买活事件的 0-9 全局槽位不是一套编号**。
- 配置目录：`%APPDATA%\dev.dota2helper2.app\`，已有 `constants/`、`layout.json`、`item_prices.json`。

## 文件结构

```
ui/
├─ js/
│  ├─ minimap.js        # 新增：minimap 段解析 + 眼位状态跟踪
│  ├─ wardmap.js        # 新增：小地图 SVG 渲染
│  ├─ settings.js       # 新增：设置读写（Rust 与浏览器双通道）
│  ├─ editor.js         # 新增（Task 9）：编辑态设置卡片
│  ├─ render.js         # 修改：接入小地图、显示项过滤、缩放与透明度
│  └─ main.js           # 修改：装配、前端错误转发、编辑态出入口
├─ index.html / dev.html  # 修改（Task 9）：加 #editor
└─ css/overlay.css      # 修改（Task 9）：设置卡片样式

  ~~ui/settings.html~~ / ~~ui/js/settings-page.js~~ / ~~ui/css/settings.css~~
                        # Task 4 建，Task 9 删

src-tauri/src/
├─ settings.rs          # 新增：settings.json 读写 + 命令 + 变更广播
├─ log.rs               # 新增：分级文件日志 + 前端错误转发命令
├─ record.rs            # 新增：对局录制（gzip jsonl）
├─ tray.rs              # 新增：托盘图标与菜单（Task 9 收敛为两项）
└─ main.rs              # 修改：装配、编辑态抽公共函数

constants/normal.json, constants/turbo.json   # 修改：加 4 个眼位常数
tools/replay.py                               # 修改：支持读 .jsonl.gz
```

---

### Task 1: minimap 解析与眼位跟踪

**Files:**
- Create: `ui/js/minimap.js`
- Modify: `constants/normal.json`, `constants/turbo.json`

**Interfaces:**
- Produces: `parseWards(state) → Array<{key, team, kind, x, y}>`，`kind` 为 `"obs"` 或 `"sentry"`
- Produces: `deadTowers(state, towers) → Array<{team, tier, x, y}>`（towers.json 里有、但 minimap 上已消失的塔）
- Produces: `class WardTracker { constructor(C); reset(); update(state, info); list(info) }`
  - `list(info)` 返回 `{ own: [{x, y, kind, remaining}], enemy: [{x, y, kind}], killed: [{x, y, kind, at}] }`
  - `remaining` 为 `null` 表示插放时间未知（程序中途启动时已存在的眼）
  - `killed` 只保留最近 3 秒内判定被排的，供渲染层闪红

- [ ] **Step 1: 给两张常数表加眼位常数**

在 `constants/normal.json` 与 `constants/turbo.json` 里，把 `"moonShardValue": 4000` 这一行改为：

```json
  "moonShardValue": 4000,
  "wardObserverDuration": 366,
  "wardSentryDuration": 426,
  "wardKilledGrace": 5,
  "enemyWardMemory": 366
```

实测值：假眼存续 364~373s（11 个样本）取 366，真眼 426s（12 个样本几乎不差），两种模式一致。

- [ ] **Step 2: 写 `ui/js/minimap.js`**

```js
// minimap 段派生的状态。两个实测坑：
//   1. 双方泉水也用 minimap_ward_obs 图标绘制且贯穿全局，必须按 unitname 过滤
//   2. 数据里存在坐标 (0,0) 的幽灵条目，需丢弃
const WARD_UNITS = {
  npc_dota_observer_wards: "obs",
  npc_dota_sentry_wards: "sentry",
};

function objects(state) {
  const out = [];
  for (const o of Object.values(state.minimap || {})) {
    if (!o || typeof o !== "object") continue;
    if (o.xpos === 0 && o.ypos === 0) continue;      // 幽灵条目
    out.push(o);
  }
  return out;
}

export function parseWards(state) {
  const out = [];
  for (const o of objects(state)) {
    const kind = WARD_UNITS[o.unitname];
    if (!kind) continue;
    out.push({ key: `${o.team}|${kind}|${o.xpos}|${o.ypos}`,
               team: o.team, kind, x: o.xpos, y: o.ypos });
  }
  return out;
}

/** towers.json 里有、但 minimap 上已经找不到的塔 = 已被推掉 */
export function deadTowers(state, towers) {
  const alive = objects(state).filter(o => String(o.image || "").startsWith("minimap_tower"));
  const tol = towers.tolerance;
  return towers.towers.filter(t => !alive.some(o =>
    o.team === t.team && Math.abs(o.xpos - t.x) <= tol && Math.abs(o.ypos - t.y) <= tol));
}

export class WardTracker {
  constructor(C) { this.C = C; this.reset(); }
  reset() {
    this.own = new Map();      // key -> {x, y, kind, firstSeen|null}
    this.enemy = new Map();    // key -> {x, y, kind, lastSeen}
    this.killed = [];          // [{x, y, kind, at}]
    this.lastClock = null;
    this.joined = false;       // 是否已处理过本局第一包
  }

  update(state, info) {
    const clock = info.clock;
    if (clock === null) return;
    // 时钟倒流 = 换局/重开，旧状态作废（号角前 clock 本就不单调）
    if (this.lastClock !== null && clock < this.lastClock - 5) this.reset();
    this.lastClock = clock;

    const seen = parseWards(state);
    const seenKeys = new Set(seen.map(w => w.key));

    for (const w of seen) {
      if (info.myTeam !== null && w.team === info.myTeam) {
        if (!this.own.has(w.key)) {
          // 本局第一包里就存在的眼，插放时间未知，倒计时显示为未知
          this.own.set(w.key, { x: w.x, y: w.y, kind: w.kind,
                                firstSeen: this.joined ? clock : null });
        }
      } else {
        this.enemy.set(w.key, { x: w.x, y: w.y, kind: w.kind, lastSeen: clock });
      }
    }
    this.joined = true;

    // 我方眼消失：倒计时还没走完就是被排
    for (const [key, w] of [...this.own]) {
      if (seenKeys.has(key)) continue;
      const rem = this.remaining(w, clock);
      if (rem !== null && rem > this.C.wardKilledGrace) {
        this.killed.push({ x: w.x, y: w.y, kind: w.kind, at: clock });
      }
      this.own.delete(key);
    }
    this.killed = this.killed.filter(k => clock - k.at < 3);

    // 敌方眼记忆到期（保留一个假眼寿命 = 最长可能还活着的时间）
    for (const [key, w] of [...this.enemy]) {
      if (clock - w.lastSeen > this.C.enemyWardMemory) this.enemy.delete(key);
    }
  }

  remaining(w, clock) {
    if (w.firstSeen === null) return null;
    const life = w.kind === "sentry" ? this.C.wardSentryDuration : this.C.wardObserverDuration;
    return Math.max(0, Math.ceil(w.firstSeen + life - clock));
  }

  list(info) {
    const clock = info.clock ?? 0;
    return {
      own: [...this.own.values()].map(w => ({ x: w.x, y: w.y, kind: w.kind,
                                              remaining: this.remaining(w, clock) })),
      enemy: [...this.enemy.values()].map(w => ({ x: w.x, y: w.y, kind: w.kind })),
      killed: this.killed.slice(),
    };
  }
}
```

- [ ] **Step 3: 写临时验证脚本并运行**

写 `tmp_verify_wards.mjs`（仓库根目录）：

```js
import fs from "fs";
import readline from "readline";
import { CachePool } from "./ui/js/cachepool.js";
import { MatchTracker } from "./ui/js/match.js";
import { WardTracker, parseWards, deadTowers } from "./ui/js/minimap.js";
const C = JSON.parse(fs.readFileSync("constants/normal.json", "utf-8"));
const TOWERS = JSON.parse(fs.readFileSync("constants/towers.json", "utf-8"));
const D = "../dota2_gsi_dump/dump/";
for (const f of ["raw_20260831_202544.jsonl", "raw_20260831_215612.jsonl"]) {
  const pool = new CachePool(), match = new MatchTracker();
  const trackers = {};
  let fountain = false, ghost = false, maxOwn = 0, killedFrames = 0, deadMax = 0;
  let probe = null;
  const rl = readline.createInterface({ input: fs.createReadStream(D + f) });
  for await (const line of rl) {
    const pkt = JSON.parse(line);
    const st = pool.update(pkt);
    const info = match.update(st);
    if (info.newMatch) pool.reset();
    if (!info.matchid) continue;
    trackers[info.matchid] ??= new WardTracker(C);
    const t = trackers[info.matchid];
    t.update(st, info);
    for (const w of parseWards(st)) {
      if (Math.abs(w.x) > 7000 && Math.abs(w.y) > 6500) fountain = true;
      if (w.x === 0 && w.y === 0) ghost = true;
    }
    const l = t.list(info);
    maxOwn = Math.max(maxOwn, l.own.length);
    if (l.killed.length) killedFrames++;
    if (info.inMatch) deadMax = Math.max(deadMax, deadTowers(st, TOWERS).length);
    // 抽查：正常局我方假眼 (-196,-61) 首见 clock=-50、末见 319，
    // 到 clock=310 时倒计时应接近 0
    if (info.matchid === "8976073372" && info.clock === 310 && probe === null) {
      const w = l.own.find(o => Math.abs(o.x + 196) < 5 && Math.abs(o.y + 61) < 5);
      probe = w ? w.remaining : "未找到";
    }
  }
  console.log(`=== ${f}`);
  console.log(`  泉水被当成眼: ${fountain ? "❌ 是" : "✅ 否"}`);
  console.log(`  (0,0) 幽灵混入: ${ghost ? "❌ 是" : "✅ 否"}`);
  console.log(`  我方眼同时在场峰值 ${maxOwn} 个（正常应 1~6）`);
  console.log(`  判定被排的帧数 ${killedFrames}（>0 说明检测生效）`);
  console.log(`  终局已推掉的塔 ${deadMax} 座（应 >0）`);
  if (probe !== null) console.log(`  抽查眼 (-196,-61) 在 clock=310 的剩余：${probe} 秒（应接近 0）`);
}
```

Run: `node tmp_verify_wards.mjs`

Expected：
- 两个文件都是「泉水 ✅ 否」「幽灵 ✅ 否」——这两条一旦为「是」，说明过滤写错了
- 我方眼峰值落在 1~6
- 快速局 `raw_20260831_202544.jsonl` 的被排帧数 >0（该局有大量存续仅几十秒的己方眼）
- 终局已推塔数 >0
- 抽查眼剩余接近 0（±10 秒内）。若明显偏大，按实测调 `wardObserverDuration`

- [ ] **Step 4: 删除 `tmp_verify_wards.mjs`**

Run: `rm -f tmp_verify_wards.mjs && ls tmp_verify_* 2>/dev/null || echo "已清理"`

---

### Task 2: 小地图渲染

**Files:**
- Create: `ui/js/wardmap.js`
- Modify: `ui/css/overlay.css`

**Interfaces:**
- Consumes: Task 1 的 `WardTracker.list(info)` 与 `deadTowers(state, towers)`
- Produces: `initWardMap(container, towers) → void`（建一次 DOM）
- Produces: `renderWardMap({ wards, dead }) → void`，`wards` 为 `list()` 的返回值原样，`dead` 为 `deadTowers()` 的返回值

- [ ] **Step 1: 写 `ui/js/wardmap.js`**

```js
// 地图是 ±8400 正方形，游戏坐标 x 向右、y 向上，画到屏幕 y 要翻转。
// 校准：天辉泉水 (-7456,-6938) 应落在左下角，夜魇 (7408,6848) 落在右上角。
const HALF = 8400, SIZE = 108;

const sx = x => (x + HALF) / (HALF * 2) * SIZE;
const sy = y => (1 - (y + HALF) / (HALF * 2)) * SIZE;

let root = null, towerLayer = null, wardLayer = null, allTowers = [], prevDead = null;

export function initWardMap(container, towers) {
  allTowers = towers.towers;
  container.innerHTML =
    `<svg class="wardmap" viewBox="0 0 ${SIZE} ${SIZE}" aria-hidden="true">
       <rect class="wm-bg" x="0" y="0" width="${SIZE}" height="${SIZE}" rx="4"/>
       <g class="wm-towers"></g>
       <g class="wm-wards"></g>
     </svg>
     <div class="lab">眼位</div>`;
  root = container;
  towerLayer = container.querySelector(".wm-towers");
  wardLayer = container.querySelector(".wm-wards");
  prevDead = null;
  drawTowers([]);
}

function drawTowers(dead) {
  const key = dead.map(t => `${t.x},${t.y}`).join(";");
  if (key === prevDead) return;               // 塔的状态很少变，变了才重画
  prevDead = key;
  const isDead = t => dead.some(d => d.x === t.x && d.y === t.y);
  towerLayer.innerHTML = allTowers.map(t =>
    `<rect class="wm-tower${isDead(t) ? " dead" : ""}" ` +
    `x="${(sx(t.x) - 1.4).toFixed(1)}" y="${(sy(t.y) - 1.4).toFixed(1)}" ` +
    `width="2.8" height="2.8" data-team="${t.team}"/>`).join("");
}

function fmt(sec) {
  return sec < 60 ? String(sec)
                  : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function renderWardMap(m) {
  if (!root) return;
  drawTowers(m.dead || []);
  const w = m.wards || { own: [], enemy: [], killed: [] };
  const dot = (o, cls) =>
    `<circle class="wm-ward ${cls}" cx="${sx(o.x).toFixed(1)}" cy="${sy(o.y).toFixed(1)}" r="2.2"/>`;
  const label = o => o.remaining === null ? "" :
    `<text class="wm-t" x="${sx(o.x).toFixed(1)}" y="${(sy(o.y) - 3.4).toFixed(1)}">${fmt(o.remaining)}</text>`;
  wardLayer.innerHTML =
    w.enemy.map(o => dot(o, "enemy")).join("") +
    w.own.map(o => dot(o, "own" + (o.remaining !== null && o.remaining <= 30 ? " soon" : "")) + label(o)).join("") +
    w.killed.map(o => dot(o, "killed")).join("");
}
```

- [ ] **Step 2: 在 `ui/css/overlay.css` 末尾追加样式**

```css
/* ── 眼位小地图 ─────────────────────────────────────── */
.cell.wardmap { width: 116px; }
.wardmap { width: 108px; height: 108px; display: block; }
.wm-bg { fill: rgba(0, 0, 0, .35); }
.wm-tower { fill: #9AA6B4; opacity: .55; }
.wm-tower[data-team="2"] { fill: #66BB6A; }
.wm-tower[data-team="3"] { fill: #E57373; }
.wm-tower.dead { fill: #5A6470; opacity: .3; }
.wm-ward { stroke: rgba(0, 0, 0, .85); stroke-width: .6; }
.wm-ward.own { fill: #65D9F7; }
.wm-ward.own.soon { fill: #FFC24B; }
.wm-ward.enemy { fill: #AA3333; }
.wm-ward.killed { fill: #FF4D4D; }
.wm-t { fill: #EDF1F6; font-size: 5px; text-anchor: middle;
        paint-order: stroke; stroke: #000; stroke-width: 1.4; }
```

- [ ] **Step 3: 浏览器验证坐标没画反**

先在 `ui/dev.html` 的最后一个 `<script>` 块里**临时**加入：

```js
  import("./js/wardmap.js").then(async (wm) => {
    const towers = await (await fetch("/constants/towers.json")).json();
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:12px;top:60px;width:116px";
    document.body.appendChild(box);
    wm.initWardMap(box, towers);
  });
```

Run: 起 `python tools/replay.py`，打开
`http://127.0.0.1:8000/dev.html?file=raw_20260831_215612.jsonl&speed=200`

Expected：左上角出现一块小地图，塔点排成两条对角基地 + 三路；
**绿色（天辉，team 2）塔在左下、红色（夜魇，team 3）在右上**。
若上下颠倒，说明 `sy()` 的翻转写反了。

- [ ] **Step 4: 删除 Step 3 加进 `ui/dev.html` 的临时代码**

---

### Task 3: 设置的 Rust 侧

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces: `settings::load(app) -> serde_json::Value`（供 Rust 内部读日志级别、录制开关；缺字段用默认值补齐）
- Produces: `#[tauri::command] get_settings(app) -> serde_json::Value`
- Produces: `#[tauri::command] set_settings(app, value: serde_json::Value)`（写盘并 `emit("settings", merged)`）
- Produces: `#[tauri::command] open_constants_dir(app)`

- [ ] **Step 1: 写 `src-tauri/src/settings.rs`**

```rust
use std::path::PathBuf;
use tauri::{Emitter, Manager};

fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

/// 默认值。读盘时缺什么补什么，所以老配置文件遇上新增字段也能直接用。
fn defaults() -> serde_json::Value {
    serde_json::json!({
        "show": { "mid": true, "bounty": true, "lotus": true, "wisdom": true,
                  "stack": true, "glyph": true, "buyback": true, "econ": true,
                  "wardmap": true },
        "scale": 1.0,
        "opacity": 1.0,
        "logLevel": "debug",
        "recordMatches": false
    })
}

fn merge(base: &mut serde_json::Value, over: &serde_json::Value) {
    let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) else { return };
    for (k, v) in o {
        match b.get_mut(k) {
            Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
            _ => { b.insert(k.clone(), v.clone()); }
        }
    }
}

pub fn load(app: &tauri::AppHandle) -> serde_json::Value {
    let mut v = defaults();
    if let Some(p) = path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(disk) = serde_json::from_str::<serde_json::Value>(&s) {
                merge(&mut v, &disk);
            }
        }
    }
    v
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> serde_json::Value {
    load(&app)
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, value: serde_json::Value) {
    let mut merged = defaults();
    merge(&mut merged, &value);
    if let Some(p) = path(&app) {
        if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&merged).unwrap_or_default());
    }
    let _ = app.emit("settings", merged);   // 覆盖层监听后实时生效
}

#[tauri::command]
pub fn open_constants_dir(app: tauri::AppHandle) {
    if let Ok(d) = app.path().app_config_dir() {
        let dir = d.join("constants");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
}
```

- [ ] **Step 2: 在 `src-tauri/src/main.rs` 注册**

在 `mod` 区加 `mod settings;`；把这三项加进 `tauri::generate_handler![...]`：
`settings::get_settings, settings::set_settings, settings::open_constants_dir`。

- [ ] **Step 3: 编译**

Run: `cd src-tauri && cargo build 2>&1 | grep -E "^(error|warning)|Finished"`
Expected: `Finished`，无 error。

- [ ] **Step 4: 验证默认值补齐**

Run（PowerShell）：
```powershell
'{"scale":1.5}' | Set-Content "$env:APPDATA\dev.dota2helper2.app\settings.json"
Start-Process ".\src-tauri\target\debug\dota2-game-helper2.exe"
Start-Sleep -Seconds 4
Stop-Process -Name dota2-game-helper2 -Force
Get-Content "$env:APPDATA\dev.dota2helper2.app\settings.json"
```
说明：程序启动只会**读**，不会写回，所以此步只验证 `load()` 不会因缺字段崩溃。
真正的补齐写盘在 Task 4 的设置页保存后发生。
Expected：程序正常启动与退出、日志/控制台无 panic。

---

### Task 4: 设置窗口

> ⚠️ **本任务已被 [Task 9](#task-9-设置窗口并入编辑态返工) 返工。**
> 独立窗口与 `settings-page.js` 已删除；仅 `ui/js/settings.js`（Step 1）保留至今。

**Files:**
- Create: `ui/settings.html`, `ui/css/settings.css`, `ui/js/settings.js`, `ui/js/settings-page.js`
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: Task 3 的 `get_settings` / `set_settings` / `open_constants_dir`
- Produces: `ui/js/settings.js` 导出 `SHOW_ITEMS`、`loadSettings()`、`saveSettings(obj)`、`onSettingsChange(cb)`
- Produces: 标签为 `settings` 的窗口（默认隐藏）与命令 `open_settings`

- [ ] **Step 1: 写 `ui/js/settings.js`**

```js
import { isTauri } from "./source.js";

export const SHOW_ITEMS = [
  ["mid", "中路符"], ["bounty", "赏金"], ["lotus", "莲花"],
  ["wisdom", "智慧"], ["stack", "堆野"], ["glyph", "敌塔防"],
  ["buyback", "敌买活"], ["econ", "净资产"], ["wardmap", "眼位小地图"],
];

const DEFAULTS = {
  show: Object.fromEntries(SHOW_ITEMS.map(([k]) => [k, true])),
  scale: 1.0, opacity: 1.0, logLevel: "debug", recordMatches: false,
};

export async function loadSettings() {
  try {
    if (isTauri()) return await window.__TAURI__.core.invoke("get_settings");
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(v) {
  if (isTauri()) return window.__TAURI__.core.invoke("set_settings", { value: v });
  localStorage.setItem("settings", JSON.stringify(v));
  dispatchEvent(new CustomEvent("settings", { detail: v }));   // 浏览器开发时自发自收
}

export function onSettingsChange(cb) {
  if (isTauri()) window.__TAURI__.event.listen("settings", e => cb(e.payload));
  else addEventListener("settings", e => cb(e.detail));
}
```

- [ ] **Step 2: 写 `ui/settings.html`**

```html
<!doctype html>
<meta charset="utf-8">
<title>设置 · dota2-game-helper2</title>
<link rel="stylesheet" href="css/settings.css">
<h1>设置</h1>

<section>
  <h2>显示项</h2>
  <div id="items" class="grid"></div>
</section>

<section>
  <h2>面板</h2>
  <label class="row">缩放
    <input id="scale" type="range" min="0.8" max="2" step="0.05">
    <output id="scaleOut"></output></label>
  <label class="row">透明度
    <input id="opacity" type="range" min="0.3" max="1" step="0.05">
    <output id="opacityOut"></output></label>
</section>

<section>
  <h2>开发</h2>
  <label class="row">日志级别
    <select id="logLevel">
      <option value="error">error</option>
      <option value="warn">warn</option>
      <option value="info">info</option>
      <option value="debug">debug（全量）</option>
    </select></label>
  <label class="row"><input id="record" type="checkbox"> 记录对局数据（gzip，一局约 4MB）</label>
  <button id="openDir" type="button">打开常数表目录</button>
</section>

<p class="hint">改动即时生效，无需重启。</p>
<script type="module" src="js/settings-page.js"></script>
```

- [ ] **Step 3: 写 `ui/js/settings-page.js`**

```js
import { SHOW_ITEMS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";

const s = await loadSettings();

document.getElementById("items").innerHTML = SHOW_ITEMS.map(([k, label]) =>
  `<label class="chk"><input type="checkbox" data-show="${k}"` +
  `${s.show?.[k] !== false ? " checked" : ""}> ${label}</label>`).join("");

const scale = document.getElementById("scale");
const scaleOut = document.getElementById("scaleOut");
const opacity = document.getElementById("opacity");
const opacityOut = document.getElementById("opacityOut");
const logLevel = document.getElementById("logLevel");
const record = document.getElementById("record");

scale.value = s.scale ?? 1;
opacity.value = s.opacity ?? 1;
logLevel.value = s.logLevel ?? "debug";
record.checked = !!s.recordMatches;

function collect() {
  return {
    show: Object.fromEntries([...document.querySelectorAll("[data-show]")]
      .map(el => [el.dataset.show, el.checked])),
    scale: Number(scale.value),
    opacity: Number(opacity.value),
    logLevel: logLevel.value,
    recordMatches: record.checked,
  };
}

function sync() {
  scaleOut.textContent = Number(scale.value).toFixed(2) + "×";
  opacityOut.textContent = Math.round(Number(opacity.value) * 100) + "%";
}

sync();
for (const el of document.querySelectorAll("input, select")) {
  el.addEventListener("input", () => { sync(); saveSettings(collect()); });
}
document.getElementById("openDir").addEventListener("click", () => {
  if (isTauri()) window.__TAURI__.core.invoke("open_constants_dir");
});
```

- [ ] **Step 4: 写 `ui/css/settings.css`**

```css
:root { color-scheme: dark; }
body {
  margin: 0; padding: 16px 18px;
  background: #0E1319; color: #EDF1F6;
  font-family: Bahnschrift, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
}
h1 { font-size: 17px; margin: 0 0 14px; }
h2 { font-size: 12px; color: #93A0B0; margin: 0 0 8px; font-weight: 600; }
section { margin-bottom: 18px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; }
.chk, .row { display: flex; align-items: center; gap: 8px; }
.row { margin-bottom: 8px; }
input[type="range"] { flex: 1; }
output { min-width: 46px; text-align: right; color: #B3BECB;
         font-variant-numeric: tabular-nums; }
select, button {
  background: #1A222C; color: #EDF1F6; border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 6px; padding: 4px 10px; font: inherit;
}
button { cursor: pointer; }
button:hover { background: #232D3A; }
.hint { color: #93A0B0; font-size: 12px; margin: 0; }
```

- [ ] **Step 5: 在 `tauri.conf.json` 的 `app.windows` 数组里追加设置窗口**

```json
      {
        "label": "settings",
        "url": "settings.html",
        "title": "设置 · dota2-game-helper2",
        "width": 380,
        "height": 470,
        "resizable": false,
        "visible": false,
        "skipTaskbar": false
      }
```

- [ ] **Step 6: 给设置窗口开权限**

`src-tauri/capabilities/default.json` 的 `"windows"` 数组从 `["overlay"]` 改为
`["overlay", "settings"]`——否则设置页调不了任何命令。

- [ ] **Step 7: 加打开设置窗口的命令**

在 `src-tauri/src/main.rs` 增加，并加进 `generate_handler!`：

```rust
#[tauri::command]
fn open_settings(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 8: 验证**

先把 `tauri.conf.json` 里 settings 窗口的 `"visible"` **临时**改成 `true`，然后：

Run:
```bash
cd src-tauri && touch src/main.rs && cargo build 2>&1 | grep -E "^error|Finished"
```
启动 `.\src-tauri\target\debug\dota2-game-helper2.exe`。

Expected：
- 出现深色小窗，九个复选框、两个滑块、日志级别下拉、录制开关、按钮齐全
- 拖滑块时右侧数值实时变化（如 `1.30×`、`60%`）
- 点「打开常数表目录」弹出资源管理器
- 改动任一项后，`%APPDATA%\dev.dota2helper2.app\settings.json` 被写出完整结构

- [ ] **Step 9: 把 `"visible"` 改回 `false` 并重新构建**

---

### Task 5: 覆盖层应用设置

**Files:**
- Modify: `ui/js/render.js`, `ui/js/main.js`, `ui/css/overlay.css`

**Interfaces:**
- Consumes: Task 1 `WardTracker`/`deadTowers`、Task 2 `initWardMap`/`renderWardMap`、Task 4 `loadSettings`/`onSettingsChange`
- Produces: `initPanel(el, towers)` 增加第二个参数；`render(model)` 的 model 增加 `settings` 与 `wardmap` 两个字段

- [ ] **Step 1: `render.js` 顶部引入小地图**

```js
import { initWardMap, renderWardMap } from "./wardmap.js";
```

- [ ] **Step 2: `render.js` 的 `initPanel` 接受 towers 并加小地图格子**

签名改为 `export function initPanel(el, towers) {`。
在 `root.innerHTML` 模板里，经济那一组之后追加：

```js
    <div class="sep" data-sep="wardmap"></div>
    <div class="grp"><div class="cell wide wardmap" data-cell="wardmap"></div></div>
```

在 `initPanel` 末尾（`prev = {};` 之前）加：

```js
  initWardMap(root.querySelector('[data-cell="wardmap"]'), towers);
```

- [ ] **Step 3: `render.js` 的 `render(m)` 应用设置并画小地图**

在 `render(m)` 里 `root.classList.toggle("edit", ...)` 之后插入：

```js
  // 缩放与整体透明度都走合成器，不触发重排
  const cfg = m.settings || {};
  const show = cfg.show || {};
  root.style.setProperty("--panel-scale", cfg.scale ?? 1);
  root.style.setProperty("--panel-opacity", cfg.opacity ?? 1);
  for (const [id, cell] of Object.entries(els.cells)) {
    cell.root.hidden = show[id] === false;
  }
  const wmCell = root.querySelector('[data-cell="wardmap"]');
  const wmSep = root.querySelector('[data-sep="wardmap"]');
  const wmOff = show.wardmap === false;
  if (wmCell) wmCell.hidden = wmOff;
  if (wmSep) wmSep.hidden = wmOff;
```

在 `render(m)` 末尾（经济那段之后）加：

```js
  if (!wmOff) renderWardMap(m.wardmap || { wards: null, dead: [] });
```

- [ ] **Step 4: `overlay.css` 让缩放与透明度生效**

把 `.panel` 规则里的 `transform: translateX(-50%);` 改为：

```css
  transform: translateX(-50%) scale(var(--panel-scale, 1));
  transform-origin: top center;
```

把 `.panel.on` 里的 `opacity: 1;` 改为 `opacity: var(--panel-opacity, 1);`。

- [ ] **Step 5: `main.js` 装配**

顶部增加：
```js
import { WardTracker, deadTowers } from "./minimap.js";
import { loadSettings, onSettingsChange } from "./settings.js";
```

模块级变量增加 `let wards = null;`，并在 `const prices = await loadPrices();` 之后加：
```js
let cfg = await loadSettings();
onSettingsChange(v => { cfg = v; });
```

`initPanel(document.getElementById("panel"));` 改为
`initPanel(document.getElementById("panel"), towers);`
（注意：`initPanel` 的调用要移到 `const towers = await loadTowers();` 之后）。

在 `connectSource` 回调里 `tracker.update(pkt, st, info);` 之后加：
```js
  if (!wards || info.newMatch) wards = new WardTracker(C);
  wards.C = C;
  wards.update(st, info);
```

在 `setInterval` 的 `render({ ... })` 参数里追加：
```js
    settings: cfg,
    wardmap: wards ? { wards: wards.list(info), dead: deadTowers(st, towers) } : null,
```

- [ ] **Step 6: 浏览器验证**

Run: 起 `python tools/replay.py`，打开
`http://127.0.0.1:8000/dev.html?file=raw_20260831_215612.jsonl&speed=200`，按 `v` 常显。

Expected：面板最右侧出现小地图，塔与眼位可见，无控制台报错。

再在 DevTools 控制台执行：
```js
localStorage.setItem("settings", JSON.stringify({show:{lotus:false,econ:false},scale:1.3,opacity:0.6}));
location.reload();
```
Expected：莲花格与净资产格消失、整块面板放大约 1.3 倍并淡到 60%。

- [ ] **Step 7: 恢复浏览器设置**

控制台执行 `localStorage.removeItem("settings"); location.reload();`

---

### Task 6: 托盘

> ⚠️ **菜单部分已被 [Task 9](#task-9-设置窗口并入编辑态返工) 返工**（四项收敛为两项）。
> `toggle_edit` 抽公共函数（Step 2）保留，但函数体已按 Task 9 修正——
> 见下方 Step 2 的「事后修正」。

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: Task 4 的 `settings` 窗口、`main.rs` 里已有的 `EDIT: AtomicBool`
- Produces: `tray::setup(app: &tauri::AppHandle) -> tauri::Result<()>`
- Produces: `main.rs` 的公共函数 `pub fn toggle_edit(app: &tauri::AppHandle)`（热键与托盘共用）

- [ ] **Step 1: Cargo.toml 开启 tray-icon**

把 `tauri = { version = "2", features = [] }` 改为
`tauri = { version = "2", features = ["tray-icon"] }`。

- [ ] **Step 2: `main.rs` 把编辑态切换抽成公共函数**

现在这段逻辑写在热键闭包里，托盘也要用，抽出来避免两处各存一份状态：

```rust
pub fn toggle_edit(app: &tauri::AppHandle) {
    let on = !EDIT.load(Ordering::Relaxed);
    EDIT.store(on, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(!on);
    }
    let _ = app.emit("edit", on);
    crate::logf!(crate::log::Level::Info, "[hotkey] 编辑态 = {on}");
}
```

热键回调体改为只调用 `toggle_edit(app);`。

> **事后修正（实测）**：上面这个版本后来拆成 `set_edit(app, on)` + `toggle_edit(app)`，
> 因为托盘、热键、卡片上的「完成」按钮都要能**设定**而不只是翻转。
> 并且进入编辑态时要 `w.set_focus()`，否则前端收不到 ESC 的 keydown。
> **`set_edit` 内绝不能调 `global_shortcut` 的 register/unregister**——
> 它会从热键回调里被调用，而插件派发回调时持有内部锁，在回调里再动注册直接死锁，
> 实测整个程序卡死。

> 注：`logf!` 由 Task 7 引入。若先做本任务，此行暂用 `println!("[hotkey] 编辑态 = {on}");`，
> 到 Task 7 统一替换。

- [ ] **Step 3: 写 `src-tauri/src/tray.rs`**

```rust
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 托盘补的是一个真窟窿：窗口无边框 + skipTaskbar，没有托盘就没有任何退出途径。
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "设置…", true, None::<&str>)?;
    let edit = MenuItem::with_id(app, "edit", "调整面板位置", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &edit, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("dota2-game-helper2")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_settings(app),
            "edit" => crate::toggle_edit(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = ev {
                show_settings(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_settings(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 4: 在 `main.rs` 注册**

`mod` 区加 `mod tray;`；在 `setup` 钩子里（`w.set_ignore_cursor_events(true)?;` 之后）加
`tray::setup(app.handle())?;`。

- [ ] **Step 5: 验证**

Run:
```bash
cd src-tauri && touch src/main.rs && cargo build 2>&1 | grep -E "^error|Finished"
```
启动 `.\src-tauri\target\debug\dota2-game-helper2.exe`。

Expected：
- a. 通知区出现金色圆环图标
- b. 右键弹出四项菜单
- c. 点「设置…」弹出设置窗口
- d. 点「调整面板位置」后面板可拖拽，再点一次恢复穿透（与 Ctrl+Alt+F10 效果一致，且两者互不冲突：连续用热键和菜单交替切换，状态应始终正确翻转）
- e. 点「退出」后 `Get-Process dota2-game-helper2 -ErrorAction SilentlyContinue` 无输出

---

### Task 7: 文件日志

**Files:**
- Create: `src-tauri/src/log.rs`
- Modify: `src-tauri/src/main.rs`, `src-tauri/src/gsi.rs`, `src-tauri/src/gsicfg.rs`, `src-tauri/src/prices.rs`, `src-tauri/src/constants.rs`, `ui/js/main.js`

**Interfaces:**
- Consumes: Task 3 的 `settings::load`（读级别）
- Produces: `log::init(app)`、`log::Level`、宏 `logf!(level, "格式", 参数…)`
- Produces: `#[tauri::command] log_front(level: String, msg: String)`

- [ ] **Step 1: 写 `src-tauri/src/log.rs`**

```rust
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

#[derive(PartialEq, PartialOrd, Clone, Copy)]
pub enum Level { Error = 0, Warn = 1, Info = 2, Debug = 3 }

impl Level {
    fn parse(s: &str) -> Level {
        match s {
            "error" => Level::Error,
            "warn" => Level::Warn,
            "info" => Level::Info,
            _ => Level::Debug,
        }
    }
    fn tag(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }
}

static STATE: Mutex<Option<(std::path::PathBuf, Level)>> = Mutex::new(None);

pub fn init(app: &tauri::AppHandle) {
    let level = Level::parse(
        crate::settings::load(app)["logLevel"].as_str().unwrap_or("debug"));
    let Ok(dir) = app.path().app_config_dir().map(|d| d.join("logs")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("helper2.log");
    // 超过 5MB 轮转一次，只留一个备份，够排查用
    if std::fs::metadata(&file).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("helper2.1.log"));
    }
    *STATE.lock().unwrap() = Some((file, level));
}

pub fn write(level: Level, msg: &str) {
    let guard = STATE.lock().unwrap();
    let Some((path, min)) = guard.as_ref() else { return };
    if level > *min { return }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{secs} [{}] {msg}", level.tag());
    }
}

#[macro_export]
macro_rules! logf {
    ($lv:expr, $($a:tt)*) => { $crate::log::write($lv, &format!($($a)*)) };
}

/// 前端错误转发。没有它的话，正式版里前端一抛异常就是面板空白且无声无息。
#[tauri::command]
pub fn log_front(level: String, msg: String) {
    write(Level::parse(&level), &format!("[front] {msg}"));
}
```

- [ ] **Step 2: `main.rs` 注册**

`mod` 区加 `mod log;`；在 `setup` 钩子的**最开头**（取窗口之前）加
`log::init(app.handle());`——否则其他模块的启动日志会丢。
`log::log_front` 加进 `generate_handler!`。

- [ ] **Step 3: 把现有 print 换成日志**

在 `gsi.rs` / `gsicfg.rs` / `prices.rs` / `constants.rs` 四个文件顶部各加：

```rust
use crate::logf;
use crate::log::Level;
```

然后逐条替换（消息文本保持不变）：
- `println!("...")` → `logf!(Level::Info, "...")`
- `eprintln!("...")` → `logf!(Level::Error, "...")`

`main.rs` 里 Task 6 Step 2 留下的那条 `println!("[hotkey] 编辑态 = {on}")`
一并换成 `logf!(Level::Info, "[hotkey] 编辑态 = {on}")`。

- [ ] **Step 4: 前端错误转发**

在 `ui/js/main.js` 顶部（各 import 之后）加：

```js
// 正式版没有控制台也开不出 devtools，前端异常必须转发给 Rust 写进日志
if (isTauri()) {
  const send = (lv, m) =>
    window.__TAURI__.core.invoke("log_front", { level: lv, msg: String(m) });
  addEventListener("error", e => send("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", e => send("error", e.reason?.stack || e.reason));
}
```

- [ ] **Step 5: 验证写入与级别过滤**

Run:
```bash
cd src-tauri && touch src/main.rs && cargo build 2>&1 | grep -E "^error|Finished"
```
启动程序，等 5 秒后：
```powershell
Get-Content "$env:APPDATA\dev.dota2helper2.app\logs\helper2.log" -Tail 20
```
Expected：可见 `[INFO]` 的启动信息（GSI 监听、常数表目录、价格表更新等）。

再验证级别过滤：在设置窗口把日志级别改成 `error`，重启程序，重新查看日志尾部。
Expected：新增的行里不再出现 `[INFO]` 与 `[DEBUG]`。验证完改回 `debug`。

---

### Task 8: 对局录制

**Files:**
- Create: `src-tauri/src/record.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src-tauri/src/gsi.rs`, `tools/replay.py`

**Interfaces:**
- Consumes: Task 3 的 `settings::load`（读 `recordMatches`）、Task 7 的 `logf!`
- Produces: `record::Recorder`，方法 `new(app)`、`write(&str)`、`refresh(app)`
- Produces: 录制文件 `<配置目录>/records/raw_<时间戳>.jsonl.gz`，与 `tools/gsi_dump.py` 同格式

- [ ] **Step 1: Cargo.toml 加 flate2**

在 `[dependencies]` 里加一行 `flate2 = "1"`。

- [ ] **Step 2: 写 `src-tauri/src/record.rs`**

```rust
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use tauri::Manager;

use crate::log::Level;
use crate::logf;

/// 对局录制。全量保真不裁字段——录制的价值就在于事后能查任何东西。
/// 实测 11 分钟正常局原始 37MB，gzip 后约 4MB。
pub struct Recorder {
    enabled: bool,
    sink: Option<GzEncoder<std::fs::File>>,
}

impl Recorder {
    pub fn new(app: &tauri::AppHandle) -> Recorder {
        let mut r = Recorder { enabled: false, sink: None };
        r.refresh(app);
        r
    }

    /// 按当前设置开关录制。关闭时把已写内容收尾，否则 gzip 文件不完整读不出来。
    pub fn refresh(&mut self, app: &tauri::AppHandle) {
        let want = crate::settings::load(app)["recordMatches"].as_bool().unwrap_or(false);
        if want == self.enabled { return }
        self.enabled = want;
        if !want {
            if let Some(enc) = self.sink.take() { let _ = enc.finish(); }
            logf!(Level::Info, "[record] 录制已停止");
            return;
        }
        let Ok(dir) = app.path().app_config_dir().map(|d| d.join("records")) else { return };
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("raw_{stamp}.jsonl.gz"));
        match std::fs::File::create(&path) {
            Ok(f) => {
                logf!(Level::Info, "[record] 开始录制 {}", path.display());
                self.sink = Some(GzEncoder::new(f, Compression::default()));
            }
            Err(e) => logf!(Level::Error, "[record] 建文件失败: {e}"),
        }
    }

    pub fn write(&mut self, line: &str) {
        let Some(enc) = self.sink.as_mut() else { return };
        if writeln!(enc, "{line}").is_err() {
            logf!(Level::Error, "[record] 写入失败，停止录制");
            self.sink = None;
        }
    }
}
```

- [ ] **Step 3: `main.rs` 注册**

`mod` 区加 `mod record;`。

- [ ] **Step 4: 在 `gsi.rs` 接上**

在 `spawn` 的线程里，`println!/logf!` 打印监听地址之后、`for` 循环之前加：

```rust
        let mut rec = crate::record::Recorder::new(&app);
        let mut n: u32 = 0;
```

在循环体内，读完 `body`、回完 200 之后，解析 JSON 之前加：

```rust
            rec.write(&body);          // 写原始文本，保证与 gsi_dump.py 完全同格式
            n = n.wrapping_add(1);
            if n % 100 == 0 { rec.refresh(&app); }   // 让设置开关不重启也能生效
```

- [ ] **Step 5: `tools/replay.py` 支持 .gz**

顶部 `import json, time, mimetypes` 那行加上 `gzip`。
把 `stream()` 里的：

```python
            with open(path, encoding="utf-8") as fh:
```
改为：
```python
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as fh:
```

并把 `path = DUMP / name` 之后的存在性判断改为——找不到就再去配置目录的 `records/` 找：

```python
        path = DUMP / name
        if not path.is_file():
            alt = Path(os.environ.get("APPDATA", "")) / "dev.dota2helper2.app" / "records" / name
            if alt.is_file():
                path = alt
```
（文件顶部需 `import os`。）

- [ ] **Step 6: 验证**

Run:
```bash
cd src-tauri && touch src/main.rs && cargo build 2>&1 | grep -E "^error|Finished"
```
启动程序，在设置窗口勾上「记录对局数据」，然后灌 50 个包：

```powershell
1..50 | ForEach-Object { Invoke-WebRequest -Method POST -Uri http://127.0.0.1:53000/ -ContentType application/json -Body '{"map":{"clock_time":100,"matchid":"1","game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"}}' | Out-Null }
```

再取消勾选（触发收尾），等待约 10 秒让下一次 `refresh` 生效，然后：

```powershell
Get-ChildItem "$env:APPDATA\dev.dota2helper2.app\records\"
```
Expected：出现 `raw_<时间戳>.jsonl.gz`。

验证内容可读：
```bash
python -c "import gzip,glob,os;p=sorted(glob.glob(os.path.expandvars(r'%APPDATA%\dev.dota2helper2.app\records\*.gz')))[-1];print(sum(1 for _ in gzip.open(p,'rt',encoding='utf-8')),'行')"
```
Expected：50 行（若取消勾选前又灌了包则更多）。

> 注：录制以 100 包为粒度检查设置变化，真实 GSI 约 10 包/秒，
> 所以开关最多延迟约 10 秒生效。这是为了避免每包都读一次设置文件。

---

### Task 9: 设置窗口并入编辑态（返工）

**Why:** 设置窗口必须 `alwaysOnTop`（否则被覆盖层压住，实测"打开后看不见"），
而面板默认在屏幕顶部正中、弹窗在屏幕中央，**两个都置顶必然互相遮**；
更要命的是面板平时藏着，调缩放/透明度/显示项全是盲调。
详见 [design-v2.md §六.五](design-v2.md)。

> **后续修正**：本任务原设计的第四条出口「点空白处退出」（`#backdrop`）上手后移除——
> 摆位时易误触，且真被困住时能救场的是系统级热键而非点击。下述步骤已反映移除后的形态。

**Files:**
- Create: `ui/js/editor.js`
- Modify: `ui/index.html`, `ui/dev.html`, `ui/css/overlay.css`, `ui/js/render.js`, `ui/js/main.js`
- Modify: `src-tauri/src/tray.rs`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Delete: `ui/settings.html`, `ui/js/settings-page.js`, `ui/css/settings.css`

**Interfaces:**
- Consumes: `ui/js/settings.js` 的 `SHOW_ITEMS` / `loadSettings` / `saveSettings`（Task 4 Step 1，不改）
- Consumes: Task 3 的 `get_settings` / `set_settings` / `open_constants_dir`
- Produces: `ui/js/editor.js` 导出 `initEditor(cardEl, panelEl, onDone)`、`setEditorOpen(on)`
- Removes: `open_settings` 命令、`settings` 窗口

---

- [ ] **Step 1: 两个页面加容器**

`ui/index.html` 与 `ui/dev.html` 里，`<div id="panel"></div>` 前后各加一个兄弟节点：

```html
<div id="panel"></div>
<div id="editor" hidden></div>
```

顺序即 z 序。`#editor` 必须与 `#panel` **平级**——做成子节点会跟着
`--panel-scale` 一起缩到 2× 或 0.8×，都没法用。

- [ ] **Step 2: `render.js` 摘掉 `.edit-hint`**

- `initPanel` 的 `innerHTML` 末尾删掉整行 `<div class="edit-hint">…</div>`
- 删掉 `els.done = root.querySelector('#editDone');`
- 删掉导出的 `onEditDone` 函数
- `enableDrag` 里删掉 `if (ev.target.closest(".edit-hint")) return;`
  —— 卡片已不在面板内，拖拽监听根本看不到它的事件，这个守卫失去意义

- [ ] **Step 3: 写 `ui/js/editor.js`**

```js
import { SHOW_ITEMS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";

// 编辑态的设置卡片。与 .panel 平级而非其子节点——面板受 --panel-scale 缩放，
// 卡片跟着缩到 2× 或 0.8× 都没法用。
const GAP = 10;                 // 卡片与面板的间距
let card = null, panel = null, raf = 0;

export async function initEditor(cardEl, panelEl, onDone) {
  card = cardEl; panel = panelEl;
  const s = await loadSettings();
  card.className = "editor";
  card.innerHTML = `
    <div class="ed-sec"><h3>显示项</h3>
      <div class="ed-grid">${SHOW_ITEMS.map(([k, label]) =>
        `<label class="ed-chk"><input type="checkbox" data-show="${k}"${
          s.show?.[k] !== false ? " checked" : ""}>${label}</label>`).join("")}</div>
    </div>
    <div class="ed-sec"><h3>面板</h3>
      <label class="ed-row">缩放
        <input id="edScale" type="range" min="0.8" max="2" step="0.05">
        <output id="edScaleOut"></output></label>
      <label class="ed-row">透明度
        <input id="edOpacity" type="range" min="0.3" max="1" step="0.05">
        <output id="edOpacityOut"></output></label>
    </div>
    <details class="ed-sec"><summary>开发</summary>
      <label class="ed-row">日志级别
        <select id="edLog">
          <option value="error">error</option><option value="warn">warn</option>
          <option value="info">info</option><option value="debug">debug（全量）</option>
        </select></label>
      <label class="ed-row"><input id="edRecord" type="checkbox">记录对局数据（gzip，一局约 4MB）</label>
      <button id="edDir" type="button">打开常数表目录</button>
    </details>
    <div class="ed-foot">
      <span class="ed-hint">拖动面板摆放位置 · 或按 ESC</span>
      <button id="edDone" type="button">完成</button>
    </div>`;

  const $ = (id) => card.querySelector("#" + id);
  const scale = $("edScale"), opacity = $("edOpacity"),
        log = $("edLog"), record = $("edRecord");
  scale.value = s.scale ?? 1;
  opacity.value = s.opacity ?? 1;
  log.value = s.logLevel ?? "debug";
  record.checked = !!s.recordMatches;

  const sync = () => {
    $("edScaleOut").textContent = Number(scale.value).toFixed(2) + "×";
    $("edOpacityOut").textContent = Math.round(Number(opacity.value) * 100) + "%";
  };
  const collect = () => ({
    show: Object.fromEntries([...card.querySelectorAll("[data-show]")]
      .map(el => [el.dataset.show, el.checked])),
    scale: Number(scale.value),
    opacity: Number(opacity.value),
    logLevel: log.value,
    recordMatches: record.checked,
  });

  sync();
  for (const el of card.querySelectorAll("input, select")) {
    el.addEventListener("input", () => { sync(); saveSettings(collect()); });
  }
  $("edDir").addEventListener("click", () => {
    if (isTauri()) window.__TAURI__.core.invoke("open_constants_dir");
  });
  $("edDone").addEventListener("click", onDone);
}

/** 锚在面板下方并跟随；下方放不下就翻到上方，两侧钳在视口内 */
function place() {
  const r = panel.getBoundingClientRect();
  const w = card.offsetWidth, h = card.offsetHeight;
  let y = r.bottom + GAP;
  if (y + h > innerHeight - 8) y = Math.max(8, r.top - GAP - h);
  const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

export function setEditorOpen(on) {
  if (!card) return;
  card.hidden = !on;
  if (on) place();   // 先同步定位一次，不能只靠下面的 rAF
  // rAF 只负责拖动时的逐帧跟随，且只在编辑态跑——平时一帧都不该浪费。
  // 注意 rAF 在窗口被遮挡/最小化时不触发，所以初次定位必须走上面那行同步调用，
  // 否则卡片会停在 (0,0)。实测：隐藏的浏览器面板里 600ms 内 0 帧。
  if (on && !raf) {
    const tick = () => { place(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  } else if (!on && raf) {
    cancelAnimationFrame(raf); raf = 0;
  }
}
```

- [ ] **Step 4: `ui/css/overlay.css` 换掉 `.edit-hint` 一节**

删掉文件末尾 `.edit-hint` 相关全部规则，改为：

```css
/* ── 编辑态：设置卡片 ───────────────────────────────── */

.editor {
  position: fixed;
  z-index: 2;                    /* 压在面板之上，拖动时不被面板边缘盖住 */
  /* 下拉弹出层由系统绘制，不声明配色方案就是白底，而 option 继承卡片的浅色文字
     → 白字白底看不见。只能限定在卡片内：给 :root 定配色方案会连带
     画上背景底色，覆盖层就不透明了。 */
  color-scheme: dark;
  width: 300px;
  padding: 12px 14px;
  background: var(--bg-lit);
  border: 1px solid var(--hair);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, .55);
  pointer-events: auto;
  font-size: 13px;
}
.ed-sec { margin-bottom: 12px; }
.ed-sec h3, .ed-sec summary {
  font-size: 11px; color: var(--dim); font-weight: 600;
  margin: 0 0 7px; cursor: default;
}
.ed-sec summary { cursor: pointer; margin-bottom: 0; }
details[open] > summary { margin-bottom: 7px; }
.ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; }
.ed-chk, .ed-row { display: flex; align-items: center; gap: 7px; }
.ed-row { margin-bottom: 7px; }
.editor input[type="range"] { flex: 1; min-width: 0; }
.editor output {
  min-width: 44px; text-align: right; color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.editor option { background: #0E1319; color: var(--fg); }
.editor select, .editor button {
  background: rgba(255, 255, 255, .08); color: var(--fg);
  border: 1px solid var(--hair); border-radius: 6px;
  padding: 3px 10px; font: inherit;
}
.editor button { cursor: pointer; }
.editor button:hover { background: rgba(255, 255, 255, .14); }
.ed-foot {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; margin-top: 4px;
}
.ed-hint { color: var(--dim); font-size: 11px; }
.ed-foot button {
  background: var(--k-chance); color: #06202B; border: 0;
  font-weight: 600; padding: 4px 16px;
}
.ed-foot button:hover { background: var(--k-chance); filter: brightness(1.12); }
```

> `.panel` 已有的 `pointer-events`、`transform`、`.panel.edit` 描边规则**不动**。

- [ ] **Step 5: `ui/js/main.js` 装配**

- import 改为 `import { initPanel, render, enableDrag, applyLayout } from "./render.js";`
  （去掉 `onEditDone`），并新增 `import { initEditor, setEditorOpen } from "./editor.js";`
- `initPanel(...)` 之后加：

```js
const panelEl = document.getElementById("panel");
await initEditor(document.getElementById("editor"), panelEl, exitEdit);
```

- 编辑态状态变化时同步卡片与 Rust：

```js
function applyEdit(on) {
  editMode = on;
  setEditorOpen(on);
}
if (isTauri()) window.__TAURI__.event.listen("edit", e => applyEdit(e.payload === true));

function exitEdit() {
  applyEdit(false);
  if (isTauri()) window.__TAURI__.core.invoke("exit_edit");
}
```

- 开发页的 `e` 键改成 `applyEdit(!editMode)`；`ESC` 监听保持不变（不判 `editMode`：
  锁定态窗口穿透且无焦点，压根收不到 keydown）

> **声明顺序**：`exitEdit` 与 `applyEdit` 用 `function` 声明，
> 会被提升，可以在上面的 `initEditor(...)` 调用中直接引用。

- [ ] **Step 6: `tray.rs` 菜单收敛为两项**

```rust
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let edit = MenuItem::with_id(app, "edit", "编辑面板", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&edit, &sep, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("dota2-game-helper2")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "edit" => crate::toggle_edit(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = ev {
                crate::toggle_edit(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
```

`show_settings` 整个函数删掉，`use tauri::Manager;` 若因此不再被用到也一并删。

- [ ] **Step 7: Rust 侧清理第二窗口**

- `main.rs`：删掉 `open_settings` 函数与 `invoke_handler` 里的 `open_settings,`
- `tauri.conf.json`：删掉 `windows` 数组里 label 为 `settings` 的整个对象
- `capabilities/default.json`：`windows` 改为 `["overlay"]`

- [ ] **Step 8: 删除旧文件**

```bash
rm ui/settings.html ui/js/settings-page.js ui/css/settings.css
```

- [ ] **Step 9: 浏览器验证（dev.html）**

```bash
python tools/replay.py
```

浏览器开 `http://127.0.0.1:8000/dev.html`，按 `e` 进编辑态。Expected：

- a. 面板下方出现设置卡片，虚线描边在面板上
- b. 勾掉「眼位小地图」→ 面板立刻变窄，卡片跟着重新居中对齐
- c. 拖缩放到 2× → 面板变大而**卡片尺寸不变**（关键：证明卡片没被 `--panel-scale` 波及）
- d. 把面板拖到屏幕底部 → 卡片翻到面板**上方**且完整可见
- e. 点「完成」→ `#panel` 的 class 由 `panel on edit` 变回 `panel`，卡片隐藏
- f. 再进编辑态，按 ESC → 同样退出
- g. 再进编辑态，点面板与卡片以外的空白处 → **不退出**（曾有此行为，因摆位时易误触已移除）

- [ ] **Step 10: 正式版验证**

```bash
cd src-tauri && cargo build --release 2>&1 | grep -E "^error|Finished"
```

启动 `.\src-tauri\target\release\dota2-game-helper2.exe`。Expected：

- a. 托盘右键只有「编辑面板」「退出」两项
- b. 左键单击托盘图标 = 进/出编辑态
- c. `Ctrl+Alt+F10` 与托盘交替切换，状态始终正确翻转，**不卡死**
- d. 三条退出路径（完成 / ESC / 热键）都能让桌面恢复可点
- e. 日志里 `[edit] 编辑态 = true` 与 `= false` **成对出现**
  （只有 true 没有 false 就是没真正退出，桌面会一直被覆盖层捂着）
- f. 改设置后 `%APPDATA%\dev.dota2helper2.app\settings.json` 内容随之更新

---

## Self-Review 记录

- **设计覆盖**：眼位小地图（Task 1/2）✓ 我方眼倒计时与被排检测（Task 1）✓ 敌方眼只标位置（Task 1/2）✓ 底图只画塔、推掉的画灰点（Task 1 `deadTowers` + Task 2）✓ 九个显示开关（Task 4/5）✓ 面板缩放（Task 4/5）✓ 面板整体透明度（Task 4/5）✓ 打开常数表目录（Task 3/4）✓ 托盘四项菜单含退出（Task 6）✓ 分级文件日志（Task 7）✓ 前端错误转发（Task 7）✓ 录制 gzip 且 replay 兼容（Task 8）✓ 4 个眼位常数外置（Task 1）✓ 设计文档「明确不做」三项均未进计划 ✓
- **一致性**：`WardTracker.list()` 的返回结构在 Task 1 定义、Task 2/5 消费，字段名一致；`settings` 事件名与 `show` 各键名（含 `wardmap`）在 Task 3/4/5 全文一致；编辑态由 `toggle_edit` 单点管理，热键与托盘共用（Task 6 Step 2）；`logf!`/`Level` 在 Task 7 定义，Task 6/8 引用时已注明先后顺序。
- **返工记录**：Task 4/6 的「独立设置窗口 + 托盘四项」上手后推翻，由 Task 9 合并为单一编辑态；理由（双置顶必互遮 + 面板平时藏着导致盲调）已写入 design-v2.md 六.五。Task 4 Step 1 的 settings.js 是唯一存活至今的产物。
- **已知妥协**（有意为之）：敌方眼不做倒计时（无法得知插放时间，设计文档第五节已论证）；中途启动时已存在的我方眼只画点不画倒计时；录制以 100 包为粒度响应开关（最多延迟约 10 秒，换取不必每包读盘）。
