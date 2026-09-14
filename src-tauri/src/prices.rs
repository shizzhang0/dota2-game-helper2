use tauri::Manager;
use crate::log::Level;
use crate::logf;

/// 价格表，**程序里唯一的一份**。见下面 `get_item_prices` 说明为什么不放配置目录。
const EMBEDDED: &str = include_str!("../../constants/item_prices.json");

/// 配置目录里几份已经不起作用的旧文件，升级上来的用户盘上还留着。
///
/// - `item_prices.json`（配置目录根下）：更早的版本缓存 OpenDota 响应的地方。
///   写盘时只留了 cost，丢掉 consumable / charges，而消耗品折价正靠这两个字段。
/// - `constants/item_price_overrides.json`：价格源换成游戏本体后不再读取。
/// - `constants/item_prices.json`：曾经播种到配置目录，现在价格只从内嵌那份读。
///   **这一条尤其要删**：不删的话它就是那张"静默压住新表的旧表"，正是不再播种要躲开的东西。
/// - `constants/patch.json`：1.1.0 为了判断价格表旧没旧而写的，版本号现在只在程序里。
///
/// **都得删掉，不能只是不读。** 留着比删掉更坏：排查差额时它们看上去正是价格来源，
/// 用户改了不生效，而没有任何东西告诉他这文件已经作废了。
///
/// 按路径片段存而不是 `"constants/xxx.json"`：后者在日志里会打出
/// `...app\constants/item_prices.json` 这种混着两种分隔符的路径，排查时看着像 bug。
const LEGACY: [&[&str]; 4] = [&["item_prices.json"],
                              &["constants", "item_price_overrides.json"],
                              &["constants", "item_prices.json"],
                              &["constants", "patch.json"]];

pub fn drop_legacy_cache(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    for parts in LEGACY {
        let p = parts.iter().fold(dir.clone(), |acc, part| acc.join(part));
        if !p.exists() { continue; }
        match std::fs::remove_file(&p) {
            Ok(()) => logf!(Level::Info, "[prices] 已删除失效的旧文件 {}", p.display()),
            Err(e) => logf!(Level::Warn, "[prices] 旧文件 {} 删除失败: {e}", p.display()),
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
/// **价格表只有内嵌这一份**，配置目录里不放，也不读。这是它和其他常数表唯一的不同：
/// 盘上那份优先级更高，会静默压住内嵌的新表，而「缺键即补」修不了已经改过价的物品。
/// 价格源换成游戏本体之后用户也没有再手改它的理由，于是副本整个去掉——
/// 详见 design/networth.md 的「为什么价格表不再播种到配置目录」。
///
/// 一并消失的还有两层历史包袱：`item_price_overrides.json`（修正 OpenDota 滞后用的），
/// 以及 1.1.0 那套"版本一变就整表覆盖"的机制——副本没了，就没有旧表要覆盖。
/// 升级上来的用户盘上那几份由 `drop_legacy_cache` 一次性删掉。
#[tauri::command]
pub fn get_item_prices() -> serde_json::Value {
    serde_json::from_str(EMBEDDED).unwrap_or_else(|_| serde_json::json!({}))
}
