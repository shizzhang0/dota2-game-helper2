use std::path::PathBuf;
use tauri::Manager;

// 编译期内嵌一份默认值，仅用于首次播种和读取失败时兜底
const NORMAL: &str = include_str!("../../constants/normal.json");
const TURBO: &str = include_str!("../../constants/turbo.json");
const TOWERS: &str = include_str!("../../constants/towers.json");

const NAMES: [&str; 3] = ["normal", "turbo", "towers"];

fn embedded(name: &str) -> &'static str {
    match name {
        "turbo" => TURBO,
        "towers" => TOWERS,
        _ => NORMAL,
    }
}

fn dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("constants"))
}

/// 首次运行把默认常数表落到用户配置目录。之后用户改 JSON 即可生效，
/// 不需要重新编译——上一个项目正是死于常数写死在代码里，版本一改就静默失效。
pub fn seed(app: &tauri::AppHandle) {
    let Some(d) = dir(app) else { return };
    if let Err(e) = std::fs::create_dir_all(&d) {
        eprintln!("[constants] 建目录失败: {e}");
        return;
    }
    for name in NAMES {
        let p = d.join(format!("{name}.json"));
        if !p.exists() {
            let _ = std::fs::write(&p, embedded(name));
        }
    }
    println!("[constants] 常数表目录：{}（可直接编辑，重启生效）", d.display());
}

#[tauri::command]
pub fn get_constants(app: tauri::AppHandle, name: String) -> serde_json::Value {
    // 名字只认白名单，避免被拼成任意路径
    let name = if NAMES.contains(&name.as_str()) { name } else { "normal".to_string() };
    if let Some(d) = dir(&app) {
        if let Ok(s) = std::fs::read_to_string(d.join(format!("{name}.json"))) {
            match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(v) => return v,
                Err(e) => eprintln!("[constants] {name}.json 解析失败（用内置默认值）: {e}"),
            }
        }
    }
    serde_json::from_str(embedded(&name)).unwrap_or_else(|_| serde_json::json!({}))
}
