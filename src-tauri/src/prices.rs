use tauri::Manager;
use crate::log::Level;
use crate::logf;

/// 兜底：配置目录里那份被删了也不能让净资产失去价格表
const EMBEDDED: &str = include_str!("../../constants/item_prices.json");
/// 覆盖表兜底，同上
const EMBEDDED_OVERRIDES: &str = include_str!("../../constants/item_price_overrides.json");

/// 旧版本把 OpenDota 的响应缓存在这里。现在价格表走 constants/ 那套，
/// 这个文件已经没用了——留着只会在排查时被误认成价格来源。
const LEGACY_CACHE: &str = "item_prices.json";

/// 清掉旧版遗留的价格缓存。它还有害：旧代码写盘时只留了 cost，
/// 丢掉了 consumable / charges，而消耗品折价正靠这两个字段。
pub fn drop_legacy_cache(app: &tauri::AppHandle) {
    let Ok(dir) = app.path().app_config_dir() else { return };
    let p = dir.join(LEGACY_CACHE);
    if p.exists() {
        match std::fs::remove_file(&p) {
            Ok(()) => logf!(Level::Info, "[prices] 已删除旧版价格缓存 {}", p.display()),
            Err(e) => logf!(Level::Warn, "[prices] 旧版价格缓存删除失败: {e}"),
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

/// 套用本地覆盖表。价格表整体来自 OpenDota 的快照，而它会落后于游戏版本
/// （实测龙心 5100 而游戏收 5200）；游戏自己的价格在 VPK 包里、要写解析且格式随版本变，
/// 不划算。覆盖表走 constants/ 那套：改 JSON 重启生效，不必重新编译。
fn apply_overrides(app: &tauri::AppHandle, mut base: serde_json::Value) -> serde_json::Value {
    let Some(ov) = read_constant(app, "item_price_overrides", EMBEDDED_OVERRIDES) else { return base };
    let (Some(ov), Some(obj)) = (ov.as_object(), base.as_object_mut()) else { return base };
    for (name, want) in ov {
        if name.starts_with('_') {
            continue; // 下划线开头的键是注释
        }
        let Some(want) = want.as_i64() else { continue };
        let had = obj.get(name).and_then(|v| v["cost"].as_i64());
        if had == Some(want) {
            logf!(Level::Info, "[prices] 覆盖 {name}={want} 与上游已一致，可以从覆盖表里删掉");
        } else {
            logf!(Level::Info, "[prices] 覆盖 {name}: {} -> {want}",
                  had.map_or("(无)".into(), |c| c.to_string()));
        }
        // 只改价格，保留 consumable / charges——消耗品折价要用
        match obj.get_mut(name).and_then(|v| v.as_object_mut()) {
            Some(item) => { item.insert("cost".into(), serde_json::json!(want)); }
            None => { obj.insert(name.clone(), serde_json::json!({ "cost": want })); }
        }
    }
    base
}

/// 价格表是本地常数，**不联网**。
///
/// 原先每次启动都后台拉一次 OpenDota，有两个问题：
/// 1. 写盘时只留了 `cost`，把 `consumable` / `charges` 丢了，而消耗品按剩余充能折价
///    正靠这两个字段——联网成功一次，折价就静默失效，且缓存优先级高于内嵌快照，
///    这个错会一直盖住对的那份。
/// 2. 拉取是异步的，首次进对局多半用的还是上次的缓存，价格总滞后一次启动。
///
/// 而价格只随游戏版本变，本就该跟着版本走。更新方式：跑 `tools/fetch_prices.py`
/// 重新生成 `constants/item_prices.json`，提交，重新构建。
#[tauri::command]
pub fn get_item_prices(app: tauri::AppHandle) -> serde_json::Value {
    let base = read_constant(&app, "item_prices", EMBEDDED)
        .unwrap_or_else(|| serde_json::json!({}));
    apply_overrides(&app, base)
}
