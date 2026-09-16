use std::path::PathBuf;
use tauri::Manager;
use crate::log::Level;
use crate::logf;

// 编译期内嵌一份默认值，仅用于首次播种和读取失败时兜底
const NORMAL: &str = include_str!("../../constants/normal.json");
const TURBO: &str = include_str!("../../constants/turbo.json");
const TOWERS: &str = include_str!("../../constants/towers.json");
const LANG_ZH: &str = include_str!("../../constants/lang.zh-CN.json");
const LANG_EN: &str = include_str!("../../constants/lang.en.json");

/// 播种到用户配置目录的常数表，也是 `read` 认的白名单。一律**缺键即补**：
/// 这里面出现新键一定是版本升级带来的，补齐才是用户想要的。语言包也在其列——
/// 新版本加了词条，用户已有的文件里要自动出现，否则那几行会静默回退成中文，
/// 而用户根本不知道有个键可以改。
///
/// **价格表不在其列，它根本不播种**：盘上那份会静默压住内嵌的新表，而"只补缺键"
/// 修不了已经改过价的物品。价格源换成游戏本体之后用户也没有再手改它的理由，
/// 于是副本整个去掉——理由见 design/networth.md 的「为什么价格表不再播种到配置目录」。
const NAMES: [&str; 5] = ["normal", "turbo", "towers", "lang.zh-CN", "lang.en"];

/// 这份常数对齐到哪个 Dota 版本，由 `tools/sync_constants.py` 跟着价格表一起更新。
///
/// **版本号只在 `constants/patch.json` 里定义**，别处一律是它的产物：这里编译期内嵌、
/// 启动写一条日志、设置卡片的开发区显示一行、README 顶部那枚徽章由同一个脚本改。
/// 它不进 `NAMES`、不落配置目录——配置目录里已经没有任何东西需要知道版本了。
const PATCH: &str = include_str!("../../constants/patch.json");

/// 形如 `7.41e`，读不出来时返回 `未知`。用于启动日志和设置卡片的开发区。
pub fn dota_version() -> String {
    serde_json::from_str::<serde_json::Value>(PATCH)
        .ok()
        .and_then(|v| v["dota"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "未知".into())
}

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
        "lang.zh-CN" => LANG_ZH,
        "lang.en" => LANG_EN,
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
    logf!(Level::Info, "[constants] 对齐 Dota 版本 {}", dota_version());
}

#[tauri::command]
pub fn get_constants(app: tauri::AppHandle, name: String) -> serde_json::Value {
    read(&app, &name)
}

/// 读一张常数表。前端走上面那个命令，Rust 侧（语言包）直接调这里。
pub fn read(app: &tauri::AppHandle, name: &str) -> serde_json::Value {
    // 名字只认白名单，避免被拼成任意路径
    let name = if NAMES.contains(&name) { name.to_string() } else { "normal".to_string() };
    if let Some(d) = dir(app) {
        if let Ok(s) = std::fs::read_to_string(d.join(format!("{name}.json"))) {
            match serde_json::from_str::<serde_json::Value>(&s) {
                // 读取时也补一次默认值。seed 已经把文件写全了，但那次写盘可能失败
                // （权限、只读目录），而缺一个键前端就是静默的 NaN，代价太大。
                Ok(v) => return with_defaults(&name, &v),
                Err(e) => logf!(Level::Error, "[constants] {name}.json 解析失败（用内置默认值）: {e}"),
            }
        }
    }
    embedded_value(&name)
}

/// 给设置卡片的开发区用：程序版本 + 价格表对齐的 Dota 版本。
///
/// **不走 `get_constants`**：那个命令只认 `NAMES` 白名单，而 `patch.json` 刻意不在其列
/// （不播种、配置目录里不该有它的副本）。单开一个命令比为了它破例简单。
#[tauri::command]
pub fn get_versions(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "dota": dota_version(),
    })
}
