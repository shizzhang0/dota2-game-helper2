use crate::log::Level;
use crate::logf;

// 编译期内嵌，**程序只读这一份**
const NORMAL: &str = include_str!("../../constants/normal.json");
const TURBO: &str = include_str!("../../constants/turbo.json");
const TOWERS: &str = include_str!("../../constants/towers.json");
const LANG_ZH: &str = include_str!("../../constants/lang.zh-CN.json");
const LANG_EN: &str = include_str!("../../constants/lang.en.json");

/// `read` 认的白名单，名字拼不出任意路径。
///
/// **这些表不再播种到用户配置目录**（2026-09-29）。原先会落到
/// `%APPDATA%\...\constants\` 供用户改，而那份副本和仓库里的一路悄悄分叉：
/// 新增的键缺失（前端拿到 undefined，被排检测静默失效）、改过的措辞和删掉的死键
/// 永远留在老用户盘上——"缺键即补"只补缺的，改值和删键都送不到。
/// 价格表早先已为同一个原因去掉了副本，现在其余几张照办：**不存在第二份，就不会分叉。**
/// 详见 design/timers.md 的「常数外置」。
const NAMES: [&str; 5] = ["normal", "turbo", "towers", "lang.zh-CN", "lang.en"];

/// 这份常数对齐到哪个 Dota 版本，由 `tools/sync_constants.py` 跟着价格表一起更新。
///
/// **版本号只在 `constants/patch.json` 里定义**，别处一律是它的产物：这里编译期内嵌、
/// 启动写一条日志、设置卡片的开发区显示一行、README 顶部那枚徽章由同一个脚本改。
const PATCH: &str = include_str!("../../constants/patch.json");

/// 形如 `7.41e`，读不出来时返回 `未知`。用于启动日志和设置卡片的开发区。
pub fn dota_version() -> String {
    serde_json::from_str::<serde_json::Value>(PATCH)
        .ok()
        .and_then(|v| v["dota"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "未知".into())
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

/// 启动时记一笔常数对齐到哪个版本——用户报"数字不对"时第一件要对的就是它。
pub fn log_version() {
    logf!(Level::Info, "[constants] 对齐 Dota 版本 {}", dota_version());
}

#[tauri::command]
pub fn get_constants(name: String) -> serde_json::Value {
    read(&name)
}

/// 读一张常数表。前端走上面那个命令，Rust 侧（语言包）直接调这里。
pub fn read(name: &str) -> serde_json::Value {
    // 名字只认白名单，避免被拼成任意路径
    let name = if NAMES.contains(&name) { name } else { "normal" };
    serde_json::from_str(embedded(name)).unwrap_or_else(|_| serde_json::json!({}))
}

/// 给设置卡片的开发区用：程序版本 + 价格表对齐的 Dota 版本。
///
/// **不走 `get_constants`**：那个命令只认 `NAMES` 白名单，而 `patch.json` 不在其列。
/// 单开一个命令比为了它破例简单。
#[tauri::command]
pub fn get_versions(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "app": app.package_info().version.to_string(),
        "dota": dota_version(),
    })
}
