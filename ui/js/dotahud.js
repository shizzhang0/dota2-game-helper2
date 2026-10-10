import { isTauri } from "./source.js";

// Dota 自己的 HUD 设置（小地图在哪、多大、分辨率），由 Rust 的 dota_hud 命令读出来。
// 见 src-tauri/src/dotacfg.rs 和 design/overlay.md「读 Dota 的设置」。
//
// 单独一个模块是因为两处要用：渲染要它摆小地图那一层，设置卡片要它决定
// 那两个兜底选项是灰着（已经读到了）还是能勾（没读到，用户自己照着 Dota 勾）。

let hud = null;
const subs = [];

/** 启动时读一次，之后每局开始再读——玩家可能在两局之间改了设置。
    浏览器里没有这个命令，保持 null，用到的地方退回卡片里的设置。 */
export async function readDotaHud() {
  if (!isTauri()) return;
  try {
    hud = await window.__TAURI__.core.invoke("dota_hud");
    for (const cb of subs) cb(hud);
  } catch (e) {
    window.__TAURI__.core.invoke("log_front", { level: "warn", msg: `[dotacfg] ${e}` }).catch(() => {});
  }
}

export const dotaHud = () => hud;
export function onDotaHud(cb) { subs.push(cb); }

/** 设置卡片里「小地图」那个下拉框的取值。`auto` = 跟着 Dota 的设置走，其余是手动指定——
    读错了（比如以后 Valve 改了设置项）或读不到时用。 */
export const MINIMAP_MODES = ["auto", "left", "left-large", "right", "right-large"];

/** 小地图的摆法：手动指定了就用指定的；`auto` 时读到 Dota 的设置就用它的，读不到按左下、普通大小。
    对应 Dota 设置里「小地图」那一节（用户截图确认，2026-10-08）：
      · 使用特大尺寸小地图 → dota_hud_extra_large_minimap
      · 地图位置：靠左 / 靠右 → dota_minimap_position_option，0 靠左、1 靠右
    `dota_hud_flip` 是老版本的"整个 HUD 左右翻转"，新版设置里已经没有这一项了；
    只在读不到「地图位置」时才拿它兜一下。 */
export function minimapOpts(cfg) {
  const mode = MINIMAP_MODES.includes(cfg.minimap) ? cfg.minimap : "auto";
  if (mode !== "auto") {
    return { large: mode.endsWith("-large"), right: mode.startsWith("right"), fromDota: false, auto: false };
  }
  const h = hud?.found ? hud : null;
  const pos = h?.minimapPosition;
  return {
    large: h?.extraLargeMinimap ?? false,
    right: typeof pos === "number" ? pos === 1 : (h?.hudFlip ?? false),
    fromDota: !!h, auto: true,
  };
}
