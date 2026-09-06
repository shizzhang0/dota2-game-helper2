use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use crate::log::Level;
use crate::logf;

const URL: &str = "https://api.opendota.com/api/constants/items";
/// 兜底快照：断网且无磁盘缓存时用它，保证净资产永远有数
const EMBEDDED: &str = include_str!("../../constants/item_prices.json");
/// 覆盖表兜底：配置目录里的那份被删了也不能让修正失效
const EMBEDDED_OVERRIDES: &str = include_str!("../../constants/item_price_overrides.json");

static CACHE: Mutex<Option<serde_json::Value>> = Mutex::new(None);

fn disk_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("item_prices.json"))
}

/// 只留 cost，其余字段（lore/attrib 等）占了原始响应九成体积且用不到
fn slim(v: &serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Some(obj) = v.as_object() {
        for (k, item) in obj {
            if let Some(c) = item.get("cost").and_then(|c| c.as_i64()) {
                out.insert(k.clone(), serde_json::json!({ "cost": c }));
            }
        }
    }
    serde_json::Value::Object(out)
}

/// 后台拉取，不阻塞启动也不阻塞任何命令
pub fn spawn_refresh(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .user_agent("dota2-game-helper2/0.1")
            .timeout(std::time::Duration::from_secs(15))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                logf!(Level::Error, "[prices] 客户端构建失败: {e}");
                return;
            }
        };
        let value = client
            .get(URL)
            .send()
            .and_then(|r| r.json::<serde_json::Value>());
        let v = match value {
            Ok(v) => v,
            Err(e) => {
                logf!(Level::Info, "[prices] 拉取失败（{e}），沿用缓存或内嵌快照");
                return;
            }
        };
        let s = slim(&v);
        // 响应异常时不要用坏数据覆盖好缓存
        if s.as_object().map_or(0, |o| o.len()) < 100 {
            logf!(Level::Error, "[prices] 返回条目过少，忽略");
            return;
        }
        if let Some(p) = disk_path(&app) {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&p, s.to_string());
        }
        logf!(Level::Info, "[prices] 已从 OpenDota 更新 {} 条", s.as_object().map_or(0, |o| o.len()));
        *CACHE.lock().unwrap() = Some(s);
    });
}

/// 套用本地覆盖表。OpenDota 的价格会落后于游戏版本（实测龙心 5100 而游戏收 5200），
/// 而游戏自己的价格在 VPK 包里、要自己写解析且格式随版本变，不划算。
/// 覆盖表走 constants/ 那套：改 JSON 重启生效，不必重新编译。
fn apply_overrides(app: &tauri::AppHandle, mut base: serde_json::Value) -> serde_json::Value {
    let Some(dir) = app.path().app_config_dir().ok() else { return base };
    let path = dir.join("constants").join("item_price_overrides.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| EMBEDDED_OVERRIDES.to_string());
    let Ok(ov) = serde_json::from_str::<serde_json::Value>(&text) else {
        logf!(Level::Error, "[prices] 覆盖表解析失败，忽略：{}", path.display());
        return base;
    };
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
        obj.insert(name.clone(), serde_json::json!({ "cost": want }));
    }
    base
}

/// 三层回退：内存 → 磁盘缓存 → 内嵌快照。覆盖表在最后统一套用，
/// 因此三条回退路径拿到的价格是一致的。
#[tauri::command]
pub fn get_item_prices(app: tauri::AppHandle) -> serde_json::Value {
    // 必须先把值取出来单独成一条语句：写成 `if let Some(v) = CACHE.lock()...clone()`
    // 时，MutexGuard 这个临时量会活到整个 if/else 链结束，else 分支里再 lock 一次
    // 就是自死锁（std 的 Mutex 不可重入）——首次调用 CACHE 必为 None，必然踩中，
    // 表现为前端 await loadPrices() 永不返回、整个面板起不来。
    let cached = CACHE.lock().unwrap().clone();
    let base = if let Some(v) = cached {
        v
    } else if let Some(v) = disk_path(&app)
        .and_then(|p| std::fs::read_to_string(&p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    {
        *CACHE.lock().unwrap() = Some(v.clone());
        v
    } else {
        serde_json::from_str(EMBEDDED).unwrap_or_else(|_| serde_json::json!({}))
    };
    apply_overrides(&app, base)
}
