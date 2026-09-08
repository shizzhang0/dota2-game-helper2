use std::path::PathBuf;
use tauri::{Emitter, Manager};

fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

/// 默认值。读盘时缺什么补什么，所以老配置文件遇上新增字段也能直接用。
fn defaults() -> serde_json::Value {
    serde_json::json!({
        "show": { "mid": true, "bounty": true, "lotus": true, "wisdom": true,
                  "stack": true, "glyph": true, "buyback": true, "econ": true,
                  "wardmap": true },
        "scale": 1.0,
        "opacity": 1.0,
        "panelBg": 0.72,
        "wardSize": 180,
        "logLevel": "debug",
        "recordMatches": false,
        "lang": crate::lang::system_default()
    })
}

/// 把 over 盖到 base 上（对象递归、其余整体替换）。constants.rs 也用它。
pub(crate) fn merge(base: &mut serde_json::Value, over: &serde_json::Value) {
    let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) else { return };
    for (k, v) in o {
        match b.get_mut(k) {
            Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
            _ => {
                b.insert(k.clone(), v.clone());
            }
        }
    }
}

pub fn load(app: &tauri::AppHandle) -> serde_json::Value {
    let mut v = defaults();
    if let Some(p) = path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            if let Ok(disk) = serde_json::from_str::<serde_json::Value>(&s) {
                merge(&mut v, &disk);
            }
        }
    }
    v
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> serde_json::Value {
    load(&app)
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, value: serde_json::Value) {
    let mut merged = defaults();
    merge(&mut merged, &value);
    if let Some(p) = path(&app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&p, serde_json::to_string_pretty(&merged).unwrap_or_default());
    }
    // 托盘菜单在 Rust 侧，前端那份 emit 管不到它——切语言要两边都动
    crate::tray::apply_lang(&app);
    let _ = app.emit("settings", merged); // 覆盖层监听后实时生效
}

#[tauri::command]
pub fn open_constants_dir(app: tauri::AppHandle) {
    if let Ok(d) = app.path().app_config_dir() {
        let dir = d.join("constants");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
}
