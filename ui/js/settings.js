import { isTauri } from "./source.js";

// 只有键，显示名在语言包的 show.* 里。顺序就是卡片上九个勾的顺序。
export const SHOW_KEYS = ["mid", "bounty", "lotus", "wisdom", "stack",
                          "glyph", "buyback", "econ", "wardmap"];

// lang 缺省给中文：Rust 侧的 defaults() 会按系统语言填好这个字段，
// 这份只在浏览器开发时用得上。
export const DEFAULTS = {
  show: Object.fromEntries(SHOW_KEYS.map(k => [k, true])),
  alwaysShow: false,
  scale: 1.0, opacity: 1.0,
  // 小地图的兜底选项：只在读不到 Dota 自己的设置时才用，见 dotahud.js
  minimapLarge: false, minimapRight: false,
  logLevel: "info", recordMatches: false, devTools: false, lang: "zh-CN",
};

export async function loadSettings() {
  try {
    if (isTauri()) return await window.__TAURI__.core.invoke("get_settings");
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(v) {
  if (isTauri()) return window.__TAURI__.core.invoke("set_settings", { value: v });
  // 盖在已存的那份之上，和 Rust 的 set_settings 一样：卡片不收的键（devTools）要留住
  let old = {};
  try { old = JSON.parse(localStorage.getItem("settings") || "{}"); } catch { /* 坏了就当没有 */ }
  localStorage.setItem("settings", JSON.stringify({ ...old, ...v }));
  dispatchEvent(new CustomEvent("settings", { detail: v }));   // 浏览器开发时自发自收
}

export function onSettingsChange(cb) {
  if (isTauri()) window.__TAURI__.event.listen("settings", e => cb(e.payload));
  else addEventListener("settings", e => cb(e.detail));
}
