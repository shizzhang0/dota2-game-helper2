import { isTauri } from "./source.js";

/** 检查更新。设计见 docs/design/overlay.md 的「检查更新」。

    **请求从前端发**：WebView2 的 fetch 和 Edge 用同一套代理设置（系统代理、PAC），
    而 Rust 的 HTTP 库默认不读 Windows 系统代理——很多人能上 GitHub 靠的就是它。

    **只查 GitHub**（曾有 jsDelivr 备用源，去掉了，理由见设计文档）。结果只有三种：
      { state: "new", version, dota }  有新版（dota 可能是 null，取不到就不显示）
      { state: "latest" }              已是最新
      { state: "fail" }                连不上 */
const REPO = "shizzhang0/dota2-game-helper2";
const TIMEOUT_MS = 4000;

/** Releases API。Dota 版本从 Release 标题里取：发版时写成 `v1.3.5 · Dota 7.41f` */
async function fromGithub(signal) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
                        { signal, headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j = await r.json();
  const dota = /Dota\s*([0-9][0-9.]*[a-z]?)/i.exec(j.name || "");
  return { version: j.tag_name, dota: dota ? dota[1] : null };
}

/** `v1.3.5` / `1.3.5` → [1, 3, 5]；认不出来返回 null */
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? m.slice(1).map(Number) : null;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function fetchLatest() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fromGithub(ctl.signal);
    return parse(r.version) ? r : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 最近一次的结果，给开发页建卡片时直接套用（切语言会整卡重建） */
let last = null;
let running = null;
const listeners = new Set();

export function lastUpdate() { return last; }
export function onUpdate(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/** 查一次。同时只跑一个：启动那次没回来时又点了按钮，就等同一个结果。
    **只在 Tauri 里查**：浏览器开发和 Pages 的 demo 用的是同一份 ui/js，
    那里没有"程序版本"，也不该替访客去请求 GitHub。 */
export function checkUpdate() {
  if (!isTauri()) return Promise.resolve(null);
  if (running) return running;
  for (const cb of listeners) cb({ state: "checking" });
  running = (async () => {
    const [latest, v] = await Promise.all([
      fetchLatest(),
      window.__TAURI__.core.invoke("get_versions").catch(() => ({})),
    ]);
    const mine = parse(v.app);
    if (!latest || !mine) last = { state: "fail" };
    else if (newer(parse(latest.version), mine)) {
      last = { state: "new", version: latest.version.replace(/^v?/, "v"), dota: latest.dota };
    } else last = { state: "latest" };
    for (const cb of listeners) cb(last);
    return last;
  })().finally(() => { running = null; });
  return running;
}

/** 用默认浏览器打开 Releases 页。地址写死在 Rust 那边，前端传不进任意 URL。 */
export function openReleasePage() {
  if (isTauri()) window.__TAURI__.core.invoke("open_release_page");
}
