# 面板拆块实施计划

> **历史过程记录，不再维护。** 拆块已经做完，结论都已并入
> [../design/overlay.md](../design/overlay.md)，两边冲突时以 design 为准。
> 保留本文是为了记住当时是怎么权衡的。

设计见 [panel-split.md](panel-split.md)。

**目标：** 把现在这条 815px 宽的整体面板拆成四个可独立摆位的块。

**做法：** `#panel` 从"面板本体"降级为无样式容器，`render.js` 在它里面建四个
`position: fixed` 的 `.block`。`layout.json` 从 `{x,y}` 变成四份坐标。
编辑态里四块各自可拖，设置卡片改为靠标题栏拖动。

**技术栈：** vanilla ES 模块 + SVG，无框架无构建。Rust 侧一行不改。

## 全局约束

- **不写单元测试**（Timothy 的全局规则）。本仓库也没有任何测试设施。
  每个任务的验证一律走 `tools/replay.py` + `dev.html` 手动核对，步骤里写死了要看什么。
- **不自动 `git commit`**（同上）。每个任务末尾给出建议的提交信息，
  **等 Timothy 明确说了才执行**。
- 前端是编译期嵌入二进制的：改完 `ui/` 要重新 `cargo build` 才在正式版生效。
  开发期一律用回放服务器验证，不必重编。
- 硬约束不变：`html, body` 保持 `pointer-events: none`；动画只用 `transform` / `opacity`；
  `[hidden] { display: none !important }` 必须保留（`.block` 和 `.cell` 都是 `display: flex`，
  会盖过 UA 默认的 `[hidden]`）。
- 拖拽一律 `setPointerCapture`，因此**拖拽区内不能有需要点击的控件**。

## 起回放服务器（每个任务的验证都从这里开始）

```bash
python tools/replay.py
```

打开 <http://127.0.0.1:8000/dev.html>。页面内按键：`v` 常显 · `e` 编辑态 · `b` 换背景。
浏览器里 `layout` 存在 `localStorage`，用 devtools 的 Console 就能读写，方便造测试数据。

---

## Task 1: 四块渲染与默认摆位

**文件：**
- 修改：`ui/css/overlay.css`（`.panel` → `.block`，删 `.grp` / `.sep`）
- 修改：`ui/js/render.js`（建四块、默认摆位、逐块拖拽）
- 修改：`ui/js/main.js:42-43`（`applyLayout` / `enableDrag` 新签名，四坐标存盘）

**接口：**
- 产出给后续任务：
  - `BLOCKS`：`{ id: string, cells: string[] }[]`，四项，顺序 timers / enemy / econ / wardmap
  - `applyLayout(saved: object|null, panelScale: number): { [id]: {x, y} }` —— 返回**实际生效的**四坐标
  - `enableDrag(onDrop: (id: string, pos: {x, y}) => void)`
- 消费：无

- [x] **Step 1: 改 CSS —— `.panel` 拆成 `.block`**

`ui/css/overlay.css` 里把 `.panel` 那一段（`/* ── 面板 ── */` 到 `.panel.edit` 结束）整体替换成：

```css
/* ── 块 ─────────────────────────────────────────────
   四个可独立摆位的块。位置一律由 JS 写 left/top，CSS 不给默认坐标——
   默认摆位要按视口比例算（见 render.js 的 defaultLayout）。
   transform-origin 是左上角：缩放时块从自己的左上角长大，存的坐标才不会失真。 */

.block {
  position: fixed;
  transform: scale(var(--panel-scale, 1));
  transform-origin: top left;
  display: flex;
  align-items: stretch;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--hair);
  border-radius: 10px;
  pointer-events: none;          /* 锁定态整窗穿透 */
  opacity: 0;
  visibility: hidden;
  transition: opacity .12s linear, visibility 0s linear .12s;
}
.block.on {
  opacity: var(--panel-opacity, 1);
  visibility: visible;
  transition: opacity .12s linear;
}
.block.edit {
  pointer-events: auto;
  cursor: grab;
  outline: 1px dashed var(--k-chance);
  outline-offset: 3px;
  opacity: 1;
  visibility: visible;
}
.block.edit:active { cursor: grabbing; }
```

再删掉这两行（块与块之间已有物理间隔，不需要画竖线；块本身就是分组，`.grp` 也没用了）：

```css
.grp { display: flex; align-items: flex-start; gap: 6px; }
.sep { width: 1px; background: var(--hair); align-self: stretch; }
```

`[hidden] { display: none !important; }` 那条**保留**，注释里把"`.cell` 的 `display:flex`"
改成"`.block` 与 `.cell` 的 `display:flex`"。

- [x] **Step 2: 改 `render.js` —— 顶部常量**

在 `ui/js/render.js` 的 `let root = null, els = null, prev = {};` 这一行上方补进：

```js
// 四个可独立摆位的块。cells 用来判断"这一块是不是该整体隐藏"。
export const BLOCKS = [
  { id: "timers",  cells: ["mid", "bounty", "lotus", "wisdom", "stack"] },
  { id: "enemy",   cells: ["glyph", "buyback"] },
  { id: "econ",    cells: ["econ"] },
  { id: "wardmap", cells: ["wardmap"] },
];

// 块被整体隐藏时 offsetWidth 为 0，算默认摆位会把四块全挤到左上角。
// 这张表只用于兜底，取的是 1× 下实测的 offsetWidth/offsetHeight（含 1px 边框）。
// econ 比另两个矮，是因为它那格没有圆环、CSS 里写死了 height: 52px。
const NOMINAL = {
  timers: { w: 350, h: 85 }, enemy:   { w: 196, h: 85 },
  econ:   { w: 142, h: 70 }, wardmap: { w: 142, h: 126 },
};
```

并把状态行改成（多一个 `scale`，`defaultLayout` 要用）：

```js
let root = null, els = null, prev = {}, scale = 1;
```

- [x] **Step 3: 改 `render.js` —— `initPanel` 建四块**

把现有 `initPanel` 整个替换成：

```js
const INNER = {
  timers: () => TIMER_IDS.map(ring).join(""),
  enemy: () => ring("glyph") + `
    <div class="cell wide" data-cell="buyback">
      <div class="dots">${[0, 1, 2, 3, 4].map(i =>
        `<div class="dot" data-i="${i}"><i></i><span>--</span></div>`).join("")}</div>
      <div class="lab">敌买活</div>
    </div>`,
  econ: () => `
    <div class="cell wide econ" data-cell="econ">
      <div class="nw">--</div>
      <div class="rate"><span class="gpm">--</span><span class="xpm">--</span></div>
      <div class="lab">净资产</div>
    </div>`,
  wardmap: () => `<div class="cell wide wardmap" data-cell="wardmap"></div>`,
};

// container（#panel）只是个容器，自己不带样式；块是 fixed 定位，父节点有没有尺寸都不影响。
export function initPanel(container, towers) {
  root = container;
  root.removeAttribute("hidden");
  root.innerHTML = BLOCKS.map(b =>
    `<div class="block" data-block="${b.id}">${INNER[b.id]()}</div>`).join("");

  els = { blocks: {}, cells: {},
          dots: [...root.querySelectorAll(".dot")].map(d => ({
            root: d, span: d.querySelector("span") })),
          nw: root.querySelector(".nw"),
          gpm: root.querySelector(".gpm"),
          xpm: root.querySelector(".xpm") };
  for (const b of BLOCKS) els.blocks[b.id] = root.querySelector(`[data-block="${b.id}"]`);
  for (const c of root.querySelectorAll("[data-cell]")) {
    els.cells[c.dataset.cell] = { root: c, num: c.querySelector(".num"),
      lab: c.querySelector(".lab"), fg: c.querySelector(".ring-fg") };
  }
  initWardMap(root.querySelector('[data-cell="wardmap"]'), towers);
  prev = {};
}
```

- [x] **Step 4: 改 `render.js` —— `render()` 的开头**

把 `render(m)` 开头到 `for (const sep of ...)` 那个循环结束为止的这一段：

```js
  root.classList.toggle("on", !!m.visible);
  root.classList.toggle("edit", !!m.editMode);
  const cfg = m.settings || {};
  const show = cfg.show || {};
  root.style.setProperty("--panel-scale", cfg.scale ?? 1);
  root.style.setProperty("--panel-opacity", cfg.opacity ?? 1);
  for (const [id, cell] of Object.entries(els.cells)) {
    cell.root.hidden = show[id] === false;
  }
  const wmOff = show.wardmap === false;
  for (const sep of root.querySelectorAll(".sep")) {
    const grp = sep.nextElementSibling;
    sep.hidden = !grp || ![...grp.querySelectorAll(".cell")].some(c => !c.hidden);
  }
```

替换成：

```js
  const cfg = m.settings || {};
  const show = cfg.show || {};
  scale = cfg.scale ?? 1;
  // CSS 变量沿 DOM 树继承，设在容器上四个块都吃得到；缩放与透明度都走合成器，不触发重排
  root.style.setProperty("--panel-scale", scale);
  root.style.setProperty("--panel-opacity", cfg.opacity ?? 1);
  for (const [id, cell] of Object.entries(els.cells)) {
    cell.root.hidden = show[id] === false;
  }
  for (const b of BLOCKS) {
    const el = els.blocks[b.id];
    el.hidden = b.cells.every(id => show[id] === false);   // 整块关掉时连底板一起消失
    el.classList.toggle("on", !!m.visible);
    el.classList.toggle("edit", !!m.editMode);
  }
  const wmOff = show.wardmap === false;
```

- [x] **Step 5: 改 `render.js` —— 摆位与拖拽**

把文件末尾的 `enableDrag` 和 `applyLayout` 两个函数整体替换成：

```js
/** 块在屏幕上的实际占位（offsetWidth 不含 transform，要自己乘缩放） */
function box(id) {
  const el = els.blocks[id];
  return { w: (el.offsetWidth  || NOMINAL[id].w) * scale,
           h: (el.offsetHeight || NOMINAL[id].h) * scale };
}

/** 默认摆位：timers 与 enemy 都水平居中、上下叠放；econ 与 wardmap 靠左边缘叠放。
    全部按视口比例算，不写死像素——换分辨率也成立。
    y0 取屏高 7.5% 是为了让开 Dota 顶部计分板（1080 屏上是 81px）。 */
function defaultLayout() {
  const W = innerWidth, H = innerHeight, y0 = Math.round(H * 0.075), GAP = 10;
  const t = box("timers"), e = box("enemy"), c = box("econ");
  return {
    timers:  { x: Math.round((W - t.w) / 2), y: y0 },
    enemy:   { x: Math.round((W - e.w) / 2), y: Math.round(y0 + t.h + GAP) },
    econ:    { x: 16, y: y0 },
    wardmap: { x: 16, y: Math.round(y0 + c.h + GAP) },
  };
}

export function applyLayout(saved, panelScale = 1) {
  scale = panelScale;                    // 在首次 render 之前就要知道缩放，否则 box() 算错
  const def = defaultLayout(), out = {};
  for (const b of BLOCKS) {
    const p = saved?.[b.id];
    out[b.id] = typeof p?.x === "number" ? { x: p.x, y: p.y } : def[b.id];
    const el = els.blocks[b.id];
    el.style.left = `${out[b.id].x}px`;
    el.style.top  = `${out[b.id].y}px`;
  }
  return out;
}

// 编辑态拖拽：逐块绑定，只改 left/top，松手回调保存该块
export function enableDrag(onDrop) {
  for (const b of BLOCKS) {
    const el = els.blocks[b.id];
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    el.addEventListener("pointerdown", (ev) => {
      if (!el.classList.contains("edit")) return;
      dragging = true; el.setPointerCapture(ev.pointerId);
      sx = ev.clientX; sy = ev.clientY;
      // 读 style 而不是 getBoundingClientRect：块被 scale 过，rect 的宽高含缩放，
      // 混着用会在缩放不为 1 时逐次漂移
      ox = parseFloat(el.style.left) || 0; oy = parseFloat(el.style.top) || 0;
    });
    el.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      el.style.left = `${ox + ev.clientX - sx}px`;
      el.style.top  = `${oy + ev.clientY - sy}px`;
    });
    el.addEventListener("pointerup", (ev) => {
      if (!dragging) return;
      dragging = false; el.releasePointerCapture(ev.pointerId);
      onDrop(b.id, { x: Math.round(parseFloat(el.style.left) || 0),
                     y: Math.round(parseFloat(el.style.top)  || 0) });
    });
  }
}
```

- [x] **Step 6: 改 `main.js` —— 四坐标存盘**

把 `ui/js/main.js:42-43` 这两行：

```js
applyLayout(await loadLayout());
enableDrag(saveLayout);
```

替换成：

```js
let layout = applyLayout(await loadLayout(), cfg.scale ?? 1);
enableDrag((id, pos) => { layout[id] = pos; saveLayout(layout); });
```

`saveLayout` 的函数体不用改（它本来就是 `JSON.stringify` 整个对象），
但形参名从 `pos` 改成 `all` 更准确：

```js
function saveLayout(all) {
  const s = JSON.stringify(all);
  if (isTauri()) window.__TAURI__.core.invoke("save_layout", { layout: s });
  else localStorage.setItem("layout", s);
}
```

- [x] **Step 7: 验证**

```bash
python tools/replay.py
```

打开 <http://127.0.0.1:8000/dev.html>，先在 Console 里清掉旧坐标保证走默认摆位：

```js
localStorage.removeItem("layout"); location.reload();
```

按 `e` 进编辑态，逐条核对：

1. 屏幕上出现**四个**独立的圆角块，每块各自一圈青色虚线描边，块之间**没有竖分隔线**。
2. `timers`（五个环）和 `enemy`（塔防+买活）上下叠放、都水平居中；
   `econ` 和 `wardmap` 贴在左边缘上下叠放，`econ` 与 `timers` 同一水平线。
3. 四块**都能各自拖动**，互不影响。
4. 拖完刷新页面，四块回到刚才拖的位置。Console 里 `JSON.parse(localStorage.layout)`
   应该是四个键，每个带 `{x, y}`。
5. 在卡片里关掉「中路符 / 赏金 / 莲花 / 智慧 / 堆野」五项，`timers` 那一块
   **连底板一起消失**（不是留个空壳）；再打开任意一项，块回来。
6. 拖动缩放滑块，四块各自从**自己的左上角**长大，位置不乱跳。
7. 按 `e` 退出编辑态再按 `v`，四块正常显示（不带虚线描边）。
8. **换个视口尺寸再试一遍默认摆位**（默认值是按比例算的，这条才是它成立的证据）：
   把浏览器窗口拉窄到约 1280 宽，然后 `localStorage.removeItem("layout"); location.reload();`
   按 `e`。期望：`timers` 与 `enemy` 仍水平居中、上下不重叠，
   `econ` 与 `wardmap` 仍贴左边缘，四块都没有任何部分在视口外。

- [ ] **Step 8: 提交点**

**等 Timothy 说了再执行。** 建议信息：

```
refactor: 面板拆成四个可独立摆位的块
```

---

## Task 2: 越界钳位与旧配置迁移

拆块之后把某块拖到 `x = -400` 就彻底找不回来了——它平时隐藏，编辑态下也在屏幕外，
没有任何入口能救。本任务补这个安全网，顺带把老的单坐标 `layout.json` 迁过来。

**文件：**
- 修改：`ui/js/render.js`（加 `clamp`，接进 `applyLayout` 与拖拽落点）
- 修改：`ui/js/main.js`（`loadLayout` 里做格式迁移；把钳位后的结果回存）

**接口：**
- 消费：Task 1 的 `BLOCKS` / `applyLayout(saved, panelScale)` / `enableDrag(onDrop)`
- 产出：`applyLayout` 的返回值现在是**钳位后**的坐标；`enableDrag` 回调给的也是钳位后的

- [x] **Step 1: `render.js` 加 `clamp`**

在 `box()` 下方、`defaultLayout()` 上方插入：

```js
/** 把坐标钳进视口。块比视口还大时钳到 0，不让它跑到负数。 */
function clamp(id, p) {
  const { w, h } = box(id);
  return { x: Math.round(Math.min(Math.max(0, p.x), Math.max(0, innerWidth  - w))),
           y: Math.round(Math.min(Math.max(0, p.y), Math.max(0, innerHeight - h))) };
}
```

- [x] **Step 2: `applyLayout` 里接上钳位**

把 `applyLayout` 中这一行：

```js
    out[b.id] = typeof p?.x === "number" ? { x: p.x, y: p.y } : def[b.id];
```

改成：

```js
    out[b.id] = clamp(b.id, typeof p?.x === "number" ? p : def[b.id]);
```

- [x] **Step 3: 拖拽落点也钳位**

把 `enableDrag` 里 `pointerup` 的函数体改成：

```js
      if (!dragging) return;
      dragging = false; el.releasePointerCapture(ev.pointerId);
      // 落点也钳一次：否则拖出屏幕的块要等到下次启动才回得来，本次会话里就丢了
      const p = clamp(b.id, { x: parseFloat(el.style.left) || 0,
                              y: parseFloat(el.style.top)  || 0 });
      el.style.left = `${p.x}px`;
      el.style.top  = `${p.y}px`;
      onDrop(b.id, p);
```

- [x] **Step 4: `main.js` 里做格式迁移**

把 `loadLayout` 整个替换成：

```js
// ── 面板位置：Tauri 存配置文件，浏览器开发时存 localStorage ──
async function loadLayout() {
  let raw = null;
  try {
    raw = isTauri() ? JSON.parse(await window.__TAURI__.core.invoke("load_layout"))
                    : JSON.parse(localStorage.getItem("layout") || "{}");
  } catch { raw = null; }
  // 老格式是整块面板的单坐标 {x, y}。沿用为 timers 的位置，其余三块取默认值——
  // 不迁的话用户已经摆好的位置会直接丢。
  if (raw && typeof raw.x === "number") return { timers: { x: raw.x, y: raw.y } };
  return raw;
}
```

- [x] **Step 5: 钳位后的结果要回存**

把 Task 1 Step 6 写下的这一行：

```js
let layout = applyLayout(await loadLayout(), cfg.scale ?? 1);
```

改成两行（迁移和钳位的结果要落盘，否则每次启动都要重算一遍老格式）：

```js
let layout = applyLayout(await loadLayout(), cfg.scale ?? 1);
saveLayout(layout);
```

- [x] **Step 6: 验证**

回放服务器已在跑的话不用重启（它直接读盘上的 `ui/`）。
打开 <http://127.0.0.1:8000/dev.html>，在 Console 里逐条造数据。

**迁移：**

```js
localStorage.setItem("layout", JSON.stringify({ x: 300, y: 500 })); location.reload();
```

按 `e`。期望：`timers` 落在 (300, 500)，其余三块在默认位置。
`JSON.parse(localStorage.layout)` 现在应该是四个键的新格式。

**越界钳位：**

```js
localStorage.setItem("layout", JSON.stringify({
  timers: { x: -600, y: -400 }, enemy: { x: 99999, y: 99999 },
  econ: { x: 16, y: 81 }, wardmap: { x: 16, y: 216 },
})); location.reload();
```

按 `e`。期望：`timers` 被钳到左上角 (0, 0) 且**完整可见**；
`enemy` 被钳到右下角、整块仍在视口内。两块都没有任何部分在屏幕外。

**落点钳位：** 把某一块往屏幕左边界外拖，松手 —— 它应当立刻弹回边界内，而不是留在外面。

**坏数据不崩：**

```js
localStorage.setItem("layout", "{{{"); location.reload();
```

期望：四块在默认位置，Console 无报错。

- [ ] **Step 7: 提交点**

**等 Timothy 说了再执行。** 建议信息：

```
fix: 块坐标越界钳位 + 旧 layout.json 迁移
```

---

## Task 3: 设置卡片改为可拖，靠标题栏

四块之后"面板"没有唯一所指，原来"锚在面板下方跟随"的逻辑失去意义，连同它的 rAF 一起删掉。

> **卡片不能整块当拖拽区。** 拖拽在 `pointerdown` 时 `setPointerCapture`，
> 之后 `pointerup` 被改派到捕获元素，`click` 便落在卡片而不是它内部的按钮上。
> 卡片里装着「完成」按钮、九个复选框、两个滑块和一个下拉框，
> 整块可拖会把它们**全部打死**，而「完成」失效等于编辑态出不去。
> 这就是 `design/overlay.md` 里记的第 3 号坑，换个壳会原样重演。
> 所以只有顶部那条标题栏可拖。

**文件：**
- 修改：`ui/css/overlay.css`（加 `.ed-bar`）
- 修改：`ui/js/editor.js`（加标题栏、自身拖拽；删 `place()` 的锚定逻辑与 rAF）
- 修改：`ui/js/main.js:57`（`initEditor` 少一个参数）

**接口：**
- 消费：无（与 Task 1/2 不耦合）
- 产出：`initEditor(cardEl, onDone)` —— **第二个参数不再是 panel 元素**，直接是 onDone 回调

- [x] **Step 1: CSS 加标题栏**

在 `ui/css/overlay.css` 的 `.editor { ... }` 规则块之后插入：

```css
/* 卡片的拖拽把手。负 margin 把它顶到卡片内边距之外，视觉上占满整个顶边。
   只有这条能拖——卡片其余部分全是要点的控件，见 editor.js 顶部的注释。 */
.ed-bar {
  margin: -12px -14px 10px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--hair);
  border-radius: 10px 10px 0 0;
  background: rgba(255, 255, 255, .05);
  font-size: 11px;
  color: var(--dim);
  cursor: grab;
  user-select: none;
}
.ed-bar:active { cursor: grabbing; }
```

- [x] **Step 2: `editor.js` 换掉文件头**

把 `ui/js/editor.js` 第 1-7 行替换成：

```js
import { SHOW_ITEMS, loadSettings, saveSettings } from "./settings.js";
import { isTauri } from "./source.js";

// 编辑态的设置卡片。与 .block 平级而非其子节点——块受 --panel-scale 缩放，
// 卡片跟着缩到 2× 或 0.8× 都没法用。
//
// 卡片自己也能拖，但**只能靠顶部标题栏**：拖拽要 setPointerCapture，
// 而它会把 pointerup 改派到捕获元素，click 便落不到内部的按钮上。
// 整块可拖会打死「完成」按钮、九个复选框、两个滑块和下拉框——
// 「完成」失效等于编辑态出不去。见 design/overlay.md 的第 3 号坑。
let card = null;
```

- [x] **Step 3: `initEditor` 改签名并加标题栏**

把函数签名与 `card.innerHTML` 的开头改成：

```js
export async function initEditor(cardEl, onDone) {
  card = cardEl;
  const s = await loadSettings();
  card.className = "editor";
  card.innerHTML = `
    <div class="ed-bar">面板设置</div>
    <div class="ed-sec"><h3>显示项</h3>
```

（`card.innerHTML` 后面的内容原样不动。）

- [x] **Step 4: 绑定卡片拖拽**

在 `initEditor` 末尾、`$("edDone").addEventListener("click", onDone);` 这一行**之后**插入：

```js
  const bar = card.querySelector(".ed-bar");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true; bar.setPointerCapture(ev.pointerId);
    sx = ev.clientX; sy = ev.clientY;
    ox = parseFloat(card.style.left) || 0; oy = parseFloat(card.style.top) || 0;
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    card.style.left = `${ox + ev.clientX - sx}px`;
    card.style.top  = `${oy + ev.clientY - sy}px`;
  });
  bar.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false; bar.releasePointerCapture(ev.pointerId);
  });
```

- [x] **Step 5: 换掉 `place()` 与 `setEditorOpen`**

把文件末尾的 `place()` 与 `setEditorOpen()` 整体替换成：

```js
/** 每次进编辑态回到屏幕中央偏下。位置不存盘——四块之后没有"面板"这个唯一锚点，
    与其猜一个，不如每次给个确定的起点，要挪自己拖。 */
function place() {
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = `${Math.round(Math.max(8, (innerWidth - w) / 2))}px`;
  card.style.top  = `${Math.round(Math.max(8, Math.min(innerHeight * 0.6, innerHeight - h - 8)))}px`;
}

export function setEditorOpen(on) {
  if (!card) return;
  card.hidden = !on;          // 必须先取消隐藏再量尺寸，hidden 时 offsetWidth 为 0
  if (on) place();
}
```

原来跟随用的 `raf` 变量、`panel` 变量和 `GAP` 常量一起删掉，没有别处引用。

- [x] **Step 6: `main.js` 少传一个参数**

把 `ui/js/main.js:57`：

```js
await initEditor(document.getElementById("editor"), document.getElementById("panel"), exitEdit);
```

改成：

```js
await initEditor(document.getElementById("editor"), exitEdit);
```

- [x] **Step 7: 验证 —— 重点是控件有没有被拖拽打死**

打开 <http://127.0.0.1:8000/dev.html>，按 `e`。

1. 卡片出现在屏幕中央偏下，顶部有一条写着「面板设置」的标题栏。
2. 鼠标移到标题栏上光标变抓手；**按住标题栏能把卡片拖到任意位置**，按下时变握拳。
3. 鼠标移到卡片其余部分光标是普通箭头，**按住拖不动卡片**。
4. **把卡片拖到别处之后**，逐个点一遍，全部必须仍然有反应：
   - 九个显示项复选框 —— 勾掉任意一个，对应格子当场消失
   - 缩放滑块 —— 拖动，四块当场缩放，右侧数字跟着变
   - 透明度滑块 —— 同上
   - 展开「开发」，日志级别下拉框能弹开且**文字看得见**（不是白底白字）
   - 「记录对局数据」复选框能勾
   - 「打开常数表目录」按钮（浏览器下不做事，但不该报错）
   - **「完成」按钮 —— 点了必须退出编辑态**
5. 按 `e` 关掉再按 `e` 打开，卡片回到屏幕中央偏下（不记住刚才拖的位置）。
6. 按 ESC 也能退出。

> 第 4 条是本任务的全部风险所在，一条都不能跳。

- [ ] **Step 8: 提交点**

**等 Timothy 说了再执行。** 建议信息：

```
feat: 设置卡片改为靠标题栏拖动
```

---

## Task 4: 恢复默认摆位

**文件：**
- 修改：`ui/js/editor.js`（加按钮、改提示文案）
- 修改：`ui/js/main.js`（`resetLayout` 并接到 `initEditor`）

**接口：**
- 消费：Task 1 的 `applyLayout(saved, panelScale)`（传 `null` 即回默认）；Task 3 的 `initEditor(cardEl, onDone)`
- 产出：`initEditor(cardEl, onDone, onResetLayout)` —— 第三个参数是无参回调

- [x] **Step 1: 卡片加按钮**

把 `editor.js` 里「面板」那一节的结尾改成：

```js
      <label class="ed-row">透明度
        <input id="edOpacity" type="range" min="0.3" max="1" step="0.05">
        <output id="edOpacityOut"></output></label>
      <div class="ed-row"><button id="edReset" type="button">恢复默认摆位</button></div>
    </div>
```

- [x] **Step 2: 改提示文案**

把 `.ed-foot` 里的提示：

```js
      <span class="ed-hint">拖动面板摆放位置 · 或按 ESC</span>
```

改成：

```js
      <span class="ed-hint">拖各块摆位 · 拖标题栏移动本卡片 · ESC 退出</span>
```

- [x] **Step 3: 接回调**

`initEditor` 签名改成三参：

```js
export async function initEditor(cardEl, onDone, onResetLayout) {
```

并在 `$("edDone").addEventListener("click", onDone);` 之后补一行：

```js
  $("edReset").addEventListener("click", onResetLayout);
```

- [x] **Step 4: `main.js` 实现 `resetLayout`**

在 `main.js` 的 `exitEdit()` 函数之后、`initEditor` 调用之前插入：

```js
// 四块独立可拖之后，把某块拖丢是真会发生的事（虽然有钳位兜底）。这是显式的复位入口。
function resetLayout() {
  layout = applyLayout(null, cfg.scale ?? 1);
  saveLayout(layout);
}
```

并把 `initEditor` 的调用改成：

```js
await initEditor(document.getElementById("editor"), exitEdit, resetLayout);
```

> `layout` 是用 `let` 声明的（Task 1 Step 6），这里能直接重新赋值。

- [x] **Step 5: 验证**

打开 <http://127.0.0.1:8000/dev.html>，按 `e`：

1. 「面板」那一节的透明度滑块下方有「恢复默认摆位」按钮。
2. 把四块拖得乱七八糟，点它 —— 四块**当场**跳回默认位置（不需要刷新）。
3. 刷新页面，四块仍在默认位置（说明落盘了）。
4. 底部提示文案是「拖各块摆位 · 拖标题栏移动本卡片 · ESC 退出」。
5. 把缩放调到 2.0 再点「恢复默认摆位」—— 四块按 2× 后的尺寸重新居中，不重叠、不越界。

- [ ] **Step 6: 提交点**

**等 Timothy 说了再执行。** 建议信息：

```
feat: 编辑态加恢复默认摆位
```

---

## Task 5: 文档回填

代码落地之后，把结论从 plan 挪进 design，plan 与 spec 一起归档。

**文件：**
- 修改：`docs/design/overlay.md`
- 修改：`docs/backlog.md`
- 修改：`README.md`
- 修改：`docs/plans/panel-split.md` 与本文件（加归档头）

- [x] **Step 1: `design/overlay.md`**

- 「硬约束」里"宽度写死"那条保留，**补一句**：块之间不再有分隔线，块本身就是分组边界。
- 新增一节「四个可独立摆位的块」，把 spec 里的分组表、默认摆位表、`layout.json` 结构、
  迁移规则、钳位与恢复默认摆位搬进来。
- 「编辑态 → 构成」那一段现在是错的（写着"卡片锚在面板下方并跟随拖动"），
  改成：四块各自可拖；卡片靠标题栏拖动、位置不存盘。
  **rAF 那段跟随逻辑连同它的注意事项一起删掉**，代码里已经没有了。
- 「四个必须避开的坑」的第 3 条**要改写而不是删除**：原文说"按钮随卡片移到面板外之后此问题
  自然消失"，拆块之后卡片自己也能拖，这个坑以"卡片必须有专门的标题栏把手"的形式回来了。
- 前端模块表里 `render` 的职责改成"四块渲染、摆位与拖拽"。

- [x] **Step 2: `docs/backlog.md`**

「面板布局」那一节整节删掉（已完成）。顺带确认「多语言 → 界面」那一节里
"面板宽度是写死的（`.cell` 60px、买活 104px、净资产 116px）"这句仍然成立
—— 成立，格子宽度没动，改的是块的组织方式。

- [x] **Step 3: `README.md`**

「设置」那一节里这两句现在是错的：

> **「编辑面板」进入编辑态**（快捷键 `Ctrl+Alt+F10`）：面板强制常显、可以直接拖动摆位，
> 旁边浮出一张设置卡片

改成：四个块（倒计时 / 敌方 / 净资产 / 眼位地图）各自常显可拖，设置卡片靠标题栏拖动。
「显示什么」那张表不用动。

- [x] **Step 4: 给 plan 与 spec 加归档头**

在 `docs/plans/panel-split.md` 和 `docs/plans/panel-split-tasks.md` 顶部各加一段，
与 `plan-v1.md` / `plan-v2.md` 的写法一致：说明这是历史过程记录、不再维护、
冲突时以 `docs/design/` 为准。

- [x] **Step 5: 验证**

```bash
grep -rn "锚在面板下方\|跟随拖动\|\.sep\|\.grp" docs/ README.md ui/
```

期望：`docs/` 与 `README.md` 里不再有描述旧行为的句子（归档的 `plan-v1` / `plan-v2`
里的历史记述除外），`ui/` 下不再有 `.sep` / `.grp`。

再通读一遍 `docs/design/overlay.md`，确认没有自相矛盾的地方。

- [ ] **Step 6: 提交点**

**等 Timothy 说了再执行。** 建议信息：

```
docs: 面板拆块的结论并入 design，plan 归档
```
