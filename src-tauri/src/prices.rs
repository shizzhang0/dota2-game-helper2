use tauri::Manager;
use crate::log::Level;
use crate::logf;

/// 兜底：配置目录里那份被删了也不能让净资产失去价格表
const EMBEDDED: &str = include_str!("../../constants/item_prices.json");

/// 配置目录里两份已经不起作用的旧文件，升级上来的用户盘上还留着。
///
/// - `item_prices.json`（配置目录根下，不是 `constants/` 里那份）：旧版本缓存 OpenDota
///   响应的地方。写盘时只留了 cost，丢掉 consumable / charges，而消耗品折价正靠这两个字段。
/// - `constants/item_price_overrides.json`：价格源换成游戏本体后不再读取。
///
/// **都得删掉，不能只是不读。** 留着比删掉更坏：排查差额时它们看上去正是价格来源，
/// 用户改了不生效，而没有任何东西告诉他这文件已经作废了。
const LEGACY: [&str; 2] = ["item_prices.json", "constants/item_price_overrides.json"];

pub fn drop_legacy_cache(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    for rel in LEGACY {
        let p = dir.join(rel);
        if !p.exists() { continue; }
        match std::fs::remove_file(&p) {
            Ok(()) => logf!(Level::Info, "[prices] 已删除失效的旧文件 {}", p.display()),
            Err(e) => logf!(Level::Warn, "[prices] 旧文件 {} 删除失败: {e}", p.display()),
        }
    }
}

fn read_constant(app: &tauri::AppHandle, name: &str, embedded: &str) -> Option<serde_json::Value> {
    let dir = app.path().app_config_dir().ok()?;
    let path = dir.join("constants").join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| embedded.to_string());
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            logf!(Level::Error, "[prices] {name}.json 解析失败（用内嵌快照）: {e}");
            serde_json::from_str(embedded).ok()
        }
    }
}

/// 价格表是本地常数，**不联网**。
///
/// 原先每次启动都后台拉一次 OpenDota，有两个问题：
/// 1. 写盘时只留了 `cost`，把 `consumable` / `charges` 丢了，而消耗品按剩余充能折价
///    正靠这两个字段——联网成功一次，折价就静默失效，且缓存优先级高于内嵌快照，
///    这个错会一直盖住对的那份。
/// 2. 拉取是异步的，首次进对局多半用的还是上次的缓存，价格总滞后一次启动。
///
/// 而价格只随游戏版本变，本就该跟着版本走。
///
/// 数据源是游戏本体自己的 `scripts/npc/items.txt`（在 VPK 里），在开发机上解析、
/// 结果作为快照提交：跑 `python tools/sync_constants.py`，提交，重新构建。
/// **运行时既不联网、也不读游戏文件**——用户拿到的必须是一份确定的常数，
/// 否则出了差额我们无从知道他手上那份价格表是哪一版。对齐的版本号见 `constants/patch.json`。
///
/// 曾经还有一张 `item_price_overrides.json` 盖在上面，用来修正 OpenDota 的滞后。
/// 源头换成游戏文件之后它没有存在理由了，已删除：想手改单个价格，
/// 直接改配置目录里的 `item_prices.json`（盘上的值本来就盖过内嵌快照），少一层就少一处对不上。
#[tauri::command]
pub fn get_item_prices(app: tauri::AppHandle) -> serde_json::Value {
    read_constant(&app, "item_prices", EMBEDDED).unwrap_or_else(|| serde_json::json!({}))
}
