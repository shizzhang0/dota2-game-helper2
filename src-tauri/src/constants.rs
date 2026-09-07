use std::path::PathBuf;
use tauri::Manager;
use crate::log::Level;
use crate::logf;

// 编译期内嵌一份默认值，仅用于首次播种和读取失败时兜底
const NORMAL: &str = include_str!("../../constants/normal.json");
const TURBO: &str = include_str!("../../constants/turbo.json");
const TOWERS: &str = include_str!("../../constants/towers.json");
const PRICE_OVERRIDES: &str = include_str!("../../constants/item_price_overrides.json");

const NAMES: [&str; 4] = ["normal", "turbo", "towers", "item_price_overrides"];

/// 缺键即补的表。这几张里出现新键一定是版本升级带来的，补齐才是用户想要的。
///
/// **`item_price_overrides` 不在其列**：那张表里"删掉某一项"是用户的明确意图
/// （上游价格修好后就该删，程序还会在日志里提示哪些覆盖已经多余），
/// 补回去等于跟用户对着干。
const TOPUP: [&str; 3] = ["normal", "turbo", "towers"];

fn embedded_value(name: &str) -> serde_json::Value {
    serde_json::from_str(embedded(name)).unwrap_or_else(|_| serde_json::json!({}))
}

/// 盘上的值盖在内置默认值之上：用户改过的保留，版本新增的键自动出现。
fn with_defaults(name: &str, disk: &serde_json::Value) -> serde_json::Value {
    let mut v = embedded_value(name);
    crate::settings::merge(&mut v, disk);
    v
}

fn missing_keys(embedded: &serde_json::Value, disk: &serde_json::Value) -> Vec<String> {
    let (Some(e), Some(d)) = (embedded.as_object(), disk.as_object()) else { return vec![] };
    e.keys().filter(|k| !d.contains_key(*k)).cloned().collect()
}

fn embedded(name: &str) -> &'static str {
    match name {
        "turbo" => TURBO,
        "towers" => TOWERS,
        "item_price_overrides" => PRICE_OVERRIDES,
        _ => NORMAL,
    }
}

fn dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("constants"))
}

/// 首次运行把默认常数表落到用户配置目录。之后用户改 JSON 即可生效，
/// 不需要重新编译——上一个项目正是死于常数写死在代码里，版本一改就静默失效。
///
/// **已存在的文件还要补齐新增的键。** 只写"文件不存在才播种"曾让这个失败模式
/// 换了个形式长回来：9/1 播种的 normal.json 遇上 9/5 新增的 ward 常数，
/// `this.C.wardSentryDuration` 是 undefined，前端算出 NaN 直接显示在地图上，
/// 而被排检测和敌方眼移除因为 `x > undefined` 恒假而彻底静默失效。
pub fn seed(app: &tauri::AppHandle) {
    let Some(d) = dir(app) else { return };
    if let Err(e) = std::fs::create_dir_all(&d) {
        logf!(Level::Error, "[constants] 建目录失败: {e}");
        return;
    }
    for name in NAMES {
        let p = d.join(format!("{name}.json"));
        let Ok(text) = std::fs::read_to_string(&p) else {
            let _ = std::fs::write(&p, embedded(name));       // 首次播种
            continue;
        };
        if !TOPUP.contains(&name) { continue; }
        let disk = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => v,
            // 用户把 JSON 改坏了：读取时会退到内置默认值，但绝不覆盖他的文件
            Err(e) => { logf!(Level::Error, "[constants] {name}.json 解析失败，未补齐: {e}"); continue; }
        };
        let added = missing_keys(&embedded_value(name), &disk);
        if added.is_empty() { continue; }
        match serde_json::to_string_pretty(&with_defaults(name, &disk)) {
            Ok(txt) => match std::fs::write(&p, txt) {
                Ok(()) => logf!(Level::Info, "[constants] {name}.json 补齐新增的键: {}", added.join(", ")),
                Err(e) => logf!(Level::Error, "[constants] {name}.json 写回失败: {e}"),
            },
            Err(e) => logf!(Level::Error, "[constants] {name}.json 序列化失败: {e}"),
        }
    }
    logf!(Level::Info, "[constants] 常数表目录：{}（可直接编辑，重启生效）", d.display());
}

#[tauri::command]
pub fn get_constants(app: tauri::AppHandle, name: String) -> serde_json::Value {
    // 名字只认白名单，避免被拼成任意路径
    let name = if NAMES.contains(&name.as_str()) { name } else { "normal".to_string() };
    if let Some(d) = dir(&app) {
        if let Ok(s) = std::fs::read_to_string(d.join(format!("{name}.json"))) {
            match serde_json::from_str::<serde_json::Value>(&s) {
                // 读取时也补一次默认值。seed 已经把文件写全了，但那次写盘可能失败
                // （权限、只读目录），而缺一个键前端就是静默的 NaN，代价太大。
                Ok(v) => return if TOPUP.contains(&name.as_str()) { with_defaults(&name, &v) } else { v },
                Err(e) => logf!(Level::Error, "[constants] {name}.json 解析失败（用内置默认值）: {e}"),
            }
        }
    }
    embedded_value(&name)
}
