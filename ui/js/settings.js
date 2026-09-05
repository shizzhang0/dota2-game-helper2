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
