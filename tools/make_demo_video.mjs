// 主页 demo 的背景录屏：裁一段、缩到 1280×800、给玩家名字打码，输出 site/demo.mp4。
//
//   node tools/make_demo_video.mjs <录屏.mp4> --clock --from 12          # ① 找 clock0
//   node tools/make_demo_video.mjs <录屏.mp4> --from 12 --to 50 --debug  # ② 看打码框准不准
//   node tools/make_demo_video.mjs <录屏.mp4> --from 12 --to 50          # ③ 出片
//
// ffmpeg 没进 PATH 的话用 --ffmpeg <bin 目录> 或环境变量 FFMPEG_BIN 指过去。
// 录屏要 16:10（2560×1600 录出来是 1728×1080 之类的都行），覆盖层按 1280×800 的 iframe 画。
// 完整流程（录屏要求、clock0 怎么填进 make_demo.py）见 docs/design/dev-tools.md「主页 demo 录屏」。
//
// **打码分两种**（2026-10-19，第一次做时的画面）：
//   固定区域  左侧击杀播报 + 队伍聊天那一带、顶部中间的连杀播报。位置不随镜头动，横着切成 15px 一条，
//             **哪条里有字才打哪条**（连上下各一条，并保持 STATIC_HOLD 帧）。起初整块常开，没字时也在糊画面（2026-10-20）。
//   头顶名字  队友名字挂在血条正上方，跟着人走。逐帧找**亮绿色的实心血条**（友方英雄才是绿的，
//             敌方是红的、头上也没名字），在它上方打一块。血条左端不随血量变，框按左端定位。
//             自己英雄的血条也是绿的、头上没名字：**框里有亮字才打**（TEXT_MIN）。起初不分，平静画面里
//             镜头跟着自己，一块马赛克一直挂在自己头上，很扎眼（2026-10-20）。光看亮像素的话神龛强光也会被当成字，
//             所以还要有足够的明暗突变（EDGE_MIN，字有描边）。两道门槛离得不远：**改了画面一定要用 --debug 核对**。
//             笔画太少的名字（旧录屏里有个队友叫 "'''"）过不了这道门槛，不会打码。
//             团战特效偶尔盖住血条一两帧，取最近 HOLD 帧的并集，名字不会闪出来；代价是镜头拉动时框拖尾巴。
// 小兵血条又细又短，靠"至少 4 行高、14px 宽"排掉；小地图上的绿点靠排除左下角。

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const W = 1280, H = 800, FPS = 30, FRAME = W * H * 3;

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const IN = argv[0];
if (!IN || IN.startsWith("--")) {
  console.error("用法：node tools/make_demo_video.mjs <录屏.mp4> [--clock] --from 秒 [--to 秒] [--out 路径] [--crf N] [--debug] [--ffmpeg 目录]");
  process.exit(1);
}
const FROM = Number(opt("--from", "0"));
const TO = opt("--to", null);
const OUT = opt("--out", path.join(ROOT, "site", "demo.mp4"));
const CRF = opt("--crf", "30");
const BIN = opt("--ffmpeg", process.env.FFMPEG_BIN || "");
const ff = (name) => (BIN ? path.join(BIN, name) : name);

// 固定区域（1280×800 坐标），按 STRIP 高的横条判断有没有字
const STATIC = [
  [0, 455, 720, 590],     // 击杀播报 + 队伍聊天（聊天行能伸到 x≈710），往上最多长到四五行
  [500, 50, 850, 108],    // 连杀播报（"xxx 已经超神"）
];
// 游戏时钟（顶栏正中那个 "24:10"）
const CLOCK = [610, 12, 670, 30];
const HOLD = 8;
const STRIP = 15;
// 横条里明暗突变占到这么多算有字。实测：有字的条 2~12%，空的 0~0.8%，团战时的空白背景能到 1.5%（多打无妨）
const STRIP_EDGE = 0.01;
// 播报淡出时字越来越淡，判断会先掉下去：多保持半秒
const STATIC_HOLD = 15;
// 血条上方亮像素占到这么多才算有名字。实测（2026-10-20）：夜里自己英雄头上 0~1.2%，队友名字 2~7%（蓝字最暗）
const TEXT_MIN = 0.015;
// 再加一道明暗突变：神龛强光 0.3~1.9%，队友名字 5~19%，最低一次 2.1%（半个身子在屏幕外、名字截掉一半）
const EDGE_MIN = 0.02;

function decoder(from, dur) {
  const args = ["-v", "error", "-ss", String(from)];
  if (dur != null) args.push("-t", String(dur));
  args.push("-i", IN, "-vf", `fps=${FPS},scale=${W}:${H}:flags=lanczos`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1");
  const p = spawn(ff("ffmpeg"), args);
  p.stderr.pipe(process.stderr);
  p.on("error", () => { console.error(`找不到 ffmpeg（${ff("ffmpeg")}），用 --ffmpeg 或 FFMPEG_BIN 指定 bin 目录`); process.exit(1); });
  return p;
}

/** 按帧回调，回调可以是 async；解码比处理快，排队超过几帧就让 ffmpeg 停一停，免得几 GB 的帧堆在内存里 */
function eachFrame(dec, fn) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0), chain = Promise.resolve(), pending = 0, n = 0;
    dec.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= FRAME) {
        const f = Buffer.from(buf.subarray(0, FRAME)); buf = buf.subarray(FRAME);
        const k = n++; pending++;
        chain = chain.then(() => fn(f, k)).then(() => { if (--pending < 3) dec.stdout.resume(); });
      }
      if (pending > 6) dec.stdout.pause();
    });
    dec.on("close", () => chain.then(() => resolve(n)));
  });
}

const green = (b, i) => { const r = b[i], g = b[i + 1], bl = b[i + 2]; return g > 140 && g > r + 50 && g > bl + 70; };

/** 找友方英雄血条，返回各自名字所在的框 */
function nameBoxes(b) {
  const runs = [];
  for (let y = 50; y < 660; y++) {
    let x = 0;
    while (x < W) {
      if (!green(b, (y * W + x) * 3)) { x++; continue; }
      const x0 = x;
      while (x < W && green(b, (y * W + x) * 3)) x++;
      if (x - x0 >= 14) runs.push({ y, x0, x1: x });
    }
  }
  const groups = [];
  for (const r of runs) {
    const g = groups.find(g => Math.abs(g.x0 - r.x0) <= 3 && r.y > g.y1 && r.y - g.y1 <= 2);
    if (g) { g.y1 = r.y; g.n++; } else groups.push({ x0: r.x0, y0: r.y, y1: r.y, n: 1 });
  }
  // 血条是一格一格的，一条会认成好几段：同一行、挨着的并成一条，取最左端
  const bars = [];
  for (const g of groups
    .filter(g => { const h = g.y1 - g.y0 + 1; return h >= 4 && h <= 9 && g.n >= 3 && !(g.x0 < 200 && g.y0 > 590); })
    .sort((a, c) => a.y0 - c.y0 || a.x0 - c.x0)) {
    const bar = bars.find(r => Math.abs(r.y0 - g.y0) <= 2 && g.x0 - r.xr <= 40 && g.x0 >= r.x0);
    if (bar) bar.xr = Math.max(bar.xr, g.x0); else bars.push({ x0: g.x0, xr: g.x0, y0: g.y0 });
  }
  // 名字居中在整条血条上方，最长的（17 位数字那种）从左端往左伸出 20 多像素
  return bars.map(r => {
    const box = [r.x0 - 32, r.y0 - 19, r.x0 + 120, r.y0 - 1];
    return { box, text: brightShare(b, box) >= TEXT_MIN && edgeShare(b, box) >= EDGE_MIN };
  });
}

/** 框里明暗突变（和右边隔一个像素的亮度差 > 90）的占比。名字是带描边的字，满是这种突变；
    神龛、技能的强光是一大片平滑的亮，单看亮像素会被当成字（2026-10-20 神龛那一段整个糊掉） */
function edgeShare(b, box) {
  const [x0, y0, x1, y1] = clip(box);
  const lum = (i) => (b[i] * 30 + b[i + 1] * 59 + b[i + 2] * 11) / 100;
  let n = 0, hit = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1 - 2; x++) {
    const i = (y * W + x) * 3; n++;
    if (Math.abs(lum(i) - lum(i + 6)) > 90) hit++;
  }
  return n ? hit / n : 0;
}

/** 框里亮像素（任一通道 > 200）的占比。名字是亮字；自己英雄头上没名字，只有地面 */
function brightShare(b, box) {
  const [x0, y0, x1, y1] = clip(box);
  let n = 0, hit = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 3; n++;
    if (b[i] > 200 || b[i + 1] > 200 || b[i + 2] > 200) hit++;
  }
  return n ? hit / n : 0;
}

function clip([x0, y0, x1, y1]) {
  return [Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1)];
}

/** 固定区域里有字的横条（连上下各一条） */
function textStrips(b) {
  const out = [];
  for (const [x0, y0, x1, y1] of STATIC) {
    const strips = [];
    for (let y = y0; y < y1; y += STRIP) strips.push([x0, y, x1, Math.min(y + STRIP, y1)]);
    const hit = strips.map(r => edgeShare(b, r) >= STRIP_EDGE);
    strips.forEach((r, k) => { if (hit[k] || hit[k - 1] || hit[k + 1]) out.push(r); });
  }
  return out;
}

/** 马赛克：每格取平均色 */
function pixelate(b, box, s = 8) {
  const [x0, y0, x1, y1] = clip(box);
  for (let by = y0; by < y1; by += s) for (let bx = x0; bx < x1; bx += s) {
    const ey = Math.min(by + s, y1), ex = Math.min(bx + s, x1);
    let r = 0, g = 0, bl = 0, n = 0;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * W + x) * 3; r += b[i]; g += b[i + 1]; bl += b[i + 2]; n++; }
    r /= n; g /= n; bl /= n;
    for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) { const i = (y * W + x) * 3; b[i] = r; b[i + 1] = g; b[i + 2] = bl; }
  }
}

/** --debug 用：只描边框不打码。品红 = 会打码，青色 = 认出了血条但上面没字、不打 */
function outline(b, box, [cr, cg, cb] = [255, 0, 255]) {
  const [x0, y0, x1, y1] = clip(box).map((v, k) => k >= 2 ? v - 1 : v);
  const p = (x, y) => { const i = (y * W + x) * 3; b[i] = cr; b[i + 1] = cg; b[i + 2] = cb; };
  for (let x = x0; x <= x1; x++) { p(x, y0); p(x, y1); }
  for (let y = y0; y <= y1; y++) { p(x0, y); p(x1, y); }
}

/** ① clock0：--from 起两秒内，时钟那块像素突变的时刻就是游戏时钟跳秒的时刻。
    clock0 = 跳秒后显示的游戏时间 − (跳秒时刻 − from)。显示的时间要人看：顺手存一张 from 那一帧 */
async function findClock() {
  const [x0, y0, x1, y1] = CLOCK;
  let prev = null;
  const ticks = [];
  await eachFrame(decoder(FROM, 2.2), (b, k) => {
    const cur = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cur.push(b[(y * W + x) * 3]);
    if (prev) {
      let d = 0; for (let i = 0; i < cur.length; i++) d += Math.abs(cur[i] - prev[i]);
      if (d > 2000) ticks.push(k / FPS);
    }
    prev = cur;
  });
  const png = OUT.replace(/\.mp4$/, "") + "-clock.png";
  await new Promise(r => spawn(ff("ffmpeg"), ["-v", "error", "-y", "-ss", String(FROM), "-i", IN, "-frames:v", "1",
    "-vf", `scale=${W}:${H}`, png]).on("close", r));
  console.log(`--from ${FROM} 之后时钟跳秒的时刻（相对 from，秒）：${ticks.map(t => t.toFixed(3)).join(" ") || "没找到"}`);
  console.log(`from 那一帧存在 ${png}，看顶栏正中的时钟读数 T（秒）`);
  if (ticks.length) console.log(`clock0 = T + 1 − ${ticks[0].toFixed(3)}，填给 make_demo.py 的 --clock0`);
}

async function render() {
  const dur = TO != null ? Number(TO) - FROM : null;
  const enc = spawn(ff("ffmpeg"), ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    "-c:v", "libx264", "-preset", "slow", "-crf", CRF, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", OUT]);
  enc.stderr.pipe(process.stderr);
  const debug = argv.includes("--debug");
  const recent = [], recentStatic = [];
  let found = 0;
  const n = await eachFrame(decoder(FROM, dur), async (b) => {
    const bars = nameBoxes(b);
    const named = bars.filter(r => r.text).map(r => r.box);
    if (named.length) found++;
    recent.push(named); if (recent.length > HOLD) recent.shift();
    recentStatic.push(textStrips(b)); if (recentStatic.length > STATIC_HOLD) recentStatic.shift();
    const boxes = [...recentStatic.flat(), ...recent.flat()];
    if (debug) {
      for (const r of bars) if (!r.text) outline(b, r.box, [0, 255, 255]);
      for (const box of boxes) outline(b, box);
    } else for (const box of boxes) pixelate(b, box);
    if (!enc.stdin.write(b)) await new Promise(r => enc.stdin.once("drain", r));
  });
  enc.stdin.end();
  await new Promise(r => enc.on("close", r));
  console.log(`${n} 帧（${(n / FPS).toFixed(1)} 秒），${found} 帧有要打码的头顶名字${debug ? "（--debug：只描框没打码）" : ""}`);
  console.log(`写出 ${OUT}`);
}

await (argv.includes("--clock") ? findClock() : render());
