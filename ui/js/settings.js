import { isTauri } from "./source.js";

// 只有键，显示名在语言包的 show.* 里。顺序就是卡片上九个勾的顺序。
export const SHOW_KEYS = ["mid", "bounty", "wisdom", "lotus", "stack",
                          "glyph", "buyback", "econ", "wardmap"];

// lang 缺省给中文：Rust 侧的 defaults() 会按系统语言填好这个字段，
// 这份只在浏览器开发时用得上。
export const DEFAULTS = {
  show: Object.fromEntries(SHOW_KEYS.map(k => [k, true])),
  // 小地图在哪、多大：auto = 读 Dota 自己的设置，见 dotahud.js
  minimap: "auto",
  logLevel: "info", recordMatches: false, devTools: false, lang: "zh-CN",
};

/** 浏览器分支（开发页、主页 demo）存设置用的 localStorage 键。**带 `helper2:` 前缀**（2026-10-15）：
    主页和 demo 同源（github.io 下整个用户名共用一个源），裸的 `settings` 谁都可能用。
    Tauri 里不走这里，设置在 Rust 那边的 settings.json */
export const STORE_KEY = "helper2:settings";

export async function loadSettings() {
  try {
    if (isTauri()) return await window.__TAURI__.core.invoke("get_settings");
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(v) {
  if (isTauri()) return window.__TAURI__.core.invoke("set_settings", { value: v });
  // 盖在已存的那份之上，和 Rust 的 set_settings 一样：卡片不收的键（devTools）要留住
  let old = {};
  try { old = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { /* 坏了就当没有 */ }
  localStorage.setItem(STORE_KEY, JSON.stringify({ ...old, ...v }));
  dispatchEvent(new CustomEvent("settings", { detail: v }));   // 浏览器开发时自发自收
}

export function onSettingsChange(cb) {
  if (isTauri()) window.__TAURI__.event.listen("settings", e => cb(e.payload));
  else addEventListener("settings", e => cb(e.detail));
}
