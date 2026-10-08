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

/** 小地图的摆法：读到 Dota 的设置就用它的，没读到（或缺这一项）退回卡片里的兜底选项。
    对应 Dota 设置里「小地图」那一节（用户截图确认，2026-10-08）：
      · 使用特大尺寸小地图 → dota_hud_extra_large_minimap
      · 地图位置：靠左 / 靠右 → dota_minimap_position_option，0 靠左、1 靠右
    `dota_hud_flip` 是老版本的"整个 HUD 左右翻转"，新版设置里已经没有这一项了；
    只在读不到「地图位置」时才拿它兜一下。 */
export function minimapOpts(cfg) {
  const h = hud?.found ? hud : null;
  const pos = h?.minimapPosition;
  return {
    large: h?.extraLargeMinimap ?? !!cfg.minimapLarge,
    right: typeof pos === "number" ? pos === 1 : (h?.hudFlip ?? !!cfg.minimapRight),
    fromDota: !!h,
  };
}
