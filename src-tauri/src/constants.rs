use std::path::PathBuf;
use tauri::Manager;
use crate::log::Level;
use crate::logf;

// 编译期内嵌一份默认值，仅用于首次播种和读取失败时兜底
const NORMAL: &str = include_str!("../../constants/normal.json");
const TURBO: &str = include_str!("../../constants/turbo.json");
const TOWERS: &str = include_str!("../../constants/towers.json");
const ITEM_PRICES: &str = include_str!("../../constants/item_prices.json");
const LANG_ZH: &str = include_str!("../../constants/lang.zh-CN.json");
const LANG_EN: &str = include_str!("../../constants/lang.en.json");

/// 播种到用户配置目录的常数表，也是 `read` 认的白名单。默认**缺键即补**：
/// 这里面出现新键一定是版本升级带来的，补齐才是用户想要的。语言包也在其列——
/// 新版本加了词条，用户已有的文件里要自动出现，否则那几行会静默回退成中文，
/// 而用户根本不知道有个键可以改。（`PATCH_BOUND` 里那几张是例外，见下。）
///
/// 曾经有过一张不该补齐的表（价格覆盖表——那里"删掉某一项"是用户的明确意图），
/// 为它单开过一个 `TOPUP` 白名单。价格源换成游戏本体后覆盖表删掉了，
/// 白名单跟着退化成 `NAMES` 的副本，一并去掉——两个永远相等的常量只会让人以为它们会不等。
const NAMES: [&str; 6] = ["normal", "turbo", "towers", "item_prices",
                          "lang.zh-CN", "lang.en"];

/// 这份常数对齐到哪个 Dota 版本，由 `tools/sync_constants.py` 跟着价格表一起更新。
///
/// 它也落到配置目录，但**每次启动无条件覆盖**，不进 `NAMES`、不走"缺键即补"：
/// 那套逻辑只补缺键、不改已有键，版本号会被永久钉在旧值上，而它必须准确——
/// 程序正是靠"盘上记的版本 ≠ 内嵌的版本"来判断该不该换掉价格表。
/// 用户改它也没有意义，它描述的是程序自己是哪一版。
const PATCH: &str = include_str!("../../constants/patch.json");

/// 跟着 Dota 版本走的表：数据源是游戏本体，用户没有理由长期保留自己那份。
/// 版本一变，盘上那份就是过时的，**直接覆盖**，不走下面的"缺键即补"。
///
/// 这是必须的，不是图省事。价格表原先靠一张覆盖表修正上游滞后；覆盖表删掉之后，
/// 如果只补缺键，升级上来的用户盘上那份 9/7 的旧价格表会**继续盖住**内嵌的新表，
/// 龙心悄悄退回 5100——比改这一版之前还差。
const PATCH_BOUND: [&str; 1] = ["item_prices"];

/// 形如 `7.41e`，读不出来时返回 `未知`。只用于日志。
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
        "item_prices" => ITEM_PRICES,
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
    // 盘上记着上次播种时对齐的版本。**始终覆盖写**——这份只反映"程序是哪一版"，
    // 用户改它没有意义，而它要是也走"缺键即补"就会永远停在旧版本号，
    // 那正是下面 PATCH_BOUND 要靠它判断的东西。
    let disk_patch = std::fs::read_to_string(d.join("patch.json")).ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["dota"].as_str().map(str::to_owned));
    let version = dota_version();
    let bumped = disk_patch.as_deref() != Some(version.as_str());
    if let Err(e) = std::fs::write(d.join("patch.json"), PATCH) {
        logf!(Level::Warn, "[constants] patch.json 写入失败: {e}");
    }

    for name in NAMES {
        let p = d.join(format!("{name}.json"));
        let Ok(text) = std::fs::read_to_string(&p) else {
            let _ = std::fs::write(&p, embedded(name));       // 首次播种
            continue;
        };
        if bumped && PATCH_BOUND.contains(&name) {
            match std::fs::write(&p, embedded(name)) {
                Ok(()) => logf!(Level::Info,
                    "[constants] Dota 版本 {} -> {}，{name}.json 已换成新表（原先手改的价格被覆盖）",
                    disk_patch.as_deref().unwrap_or("未知"), version),
                Err(e) => logf!(Level::Error, "[constants] {name}.json 覆盖失败: {e}"),
            }
            continue;
        }
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
    logf!(Level::Info, "[constants] 对齐 Dota 版本 {version}");
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
