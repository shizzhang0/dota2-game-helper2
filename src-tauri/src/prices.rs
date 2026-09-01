use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

const URL: &str = "https://api.opendota.com/api/constants/items";
/// 兜底快照：断网且无磁盘缓存时用它，保证净资产永远有数
const EMBEDDED: &str = include_str!("../../constants/item_prices.json");

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
                eprintln!("[prices] 客户端构建失败: {e}");
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
                println!("[prices] 拉取失败（{e}），沿用缓存或内嵌快照");
                return;
            }
        };
        let s = slim(&v);
        // 响应异常时不要用坏数据覆盖好缓存
        if s.as_object().map_or(0, |o| o.len()) < 100 {
            eprintln!("[prices] 返回条目过少，忽略");
            return;
        }
        if let Some(p) = disk_path(&app) {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&p, s.to_string());
        }
        println!("[prices] 已从 OpenDota 更新 {} 条", s.as_object().map_or(0, |o| o.len()));
        *CACHE.lock().unwrap() = Some(s);
    });
}

/// 三层回退：内存 → 磁盘缓存 → 内嵌快照
#[tauri::command]
pub fn get_item_prices(app: tauri::AppHandle) -> serde_json::Value {
    if let Some(v) = CACHE.lock().unwrap().clone() {
        return v;
    }
    if let Some(p) = disk_path(&app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                *CACHE.lock().unwrap() = Some(v.clone());
                return v;
            }
        }
    }
    serde_json::from_str(EMBEDDED).unwrap_or_else(|_| serde_json::json!({}))
}
