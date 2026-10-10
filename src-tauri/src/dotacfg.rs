//! 读 Dota 自己的设置：小地图在哪一侧、是不是加大小地图、游戏分辨率。
//!
//! 覆盖层要把眼位画到原生小地图上，而小地图的位置和大小取决于玩家在 Dota 里的设置。
//! 让玩家在我们这边再设一遍（或者手动拖着对齐）都不如直接读——零操作，而且不会差几个像素。
//! 读不到时（文件不存在、Valve 改了格式）前端退回设置卡片里的同名选项。
//! 见 docs/design/overlay.md「读 Dota 的设置」。
//!
//! 两个文件都在 `Steam\userdata\<账号>\570\` 下，**只读不写**：
//! - `remote\user_convars.vcfg`：HUD 相关的 convar（随 Steam 云同步）
//! - `local\cfg\video.txt`：分辨率与窗口模式（只在本机）
//!
//! 一台机器可能登过好几个 Steam 账号，取 `user_convars.vcfg` **最近被写过**的那个——
//! Dota 每次退出都会写它，最近写过的就是正在用的。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use serde_json::{json, Value};
use crate::log::Level;
use crate::logf;

/// Valve 的 KeyValues 文本：我们只要 `"键"  "值"` 这种一行两个引号串的扁平项，
/// 不关心嵌套结构。同名键取第一个。
fn kv(text: &str, key: &str) -> Option<String> {
    for line in text.lines() {
        let mut it = line.split('"');
        // 一行 `\t\t"key"\t\t"value"` 按引号切开是 ["\t\t", key, "\t\t", value, ""]
        let (_, k, _, v) = (it.next(), it.next(), it.next(), it.next());
        if k == Some(key) {
            return v.map(str::to_string);
        }
    }
    None
}

fn flag(text: &str, key: &str) -> Option<bool> {
    kv(text, key).map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

fn num(text: &str, key: &str) -> Option<i64> {
    kv(text, key).and_then(|v| v.trim().parse::<f64>().ok()).map(|f| f as i64)
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// 正在用的那个账号的 `userdata\<id>\570` 目录
fn account_dir() -> Option<PathBuf> {
    let users = crate::gsicfg::steam_path()?.join("userdata");
    fs::read_dir(users).ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("570"))
        .filter_map(|d| mtime(&d.join("remote").join("user_convars.vcfg")).map(|t| (t, d)))
        .max_by_key(|(t, _)| *t)
        .map(|(_, d)| d)
}

/// 前端在启动时和每局开始时各调一次——玩家可能在两局之间改了设置。
/// 文件很小，读一次不到一毫秒，不缓存。
#[tauri::command]
pub fn dota_hud() -> Value {
    let Some(dir) = account_dir() else {
        logf!(Level::Info, "[dotacfg] 没找到 Dota 的设置文件，用卡片里的设置");
        return json!({ "found": false });
    };
    let conv = fs::read_to_string(dir.join("remote").join("user_convars.vcfg")).unwrap_or_default();
    let video = fs::read_to_string(dir.join("local").join("cfg").join("video.txt")).unwrap_or_default();
    let out = json!({
        "found": true,
        "extraLargeMinimap": flag(&conv, "dota_hud_extra_large_minimap"),
        "hudFlip": flag(&conv, "dota_hud_flip"),
        "minimapPosition": num(&conv, "dota_minimap_position_option"),
        "resW": num(&video, "setting.defaultres"),
        "resH": num(&video, "setting.defaultresheight"),
        "fullscreen": flag(&video, "setting.fullscreen"),
        "borderless": flag(&video, "setting.nowindowborder"),
        "aspectMode": num(&video, "setting.aspectratiomode"),
    });
    logf!(Level::Info, "[dotacfg] {out}");
    out
}
