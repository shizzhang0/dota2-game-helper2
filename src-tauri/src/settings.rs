use std::path::PathBuf;
use tauri::{Emitter, Manager};
use crate::logf;

fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

/// 默认值。读盘时缺什么补什么，所以老配置文件遇上新增字段也能直接用。
fn defaults() -> serde_json::Value {
    serde_json::json!({
        "show": { "mid": true, "bounty": true, "wisdom": true, "lotus": true,
                  "stack": true, "glyph": true, "buyback": true, "econ": true,
                  "wardmap": true },
        // 小地图在哪、多大：auto = 读 Dota 自己的设置（dotacfg.rs），其余是手动指定
        "minimap": "auto",
        "logLevel": "info",
        "recordMatches": false,
        // 开发者开关，界面上没有：手写进 settings.json 才显示录制、录制器才工作。
        // 见 design/overlay.md「设置」里「开发区」那条
        "devTools": false,
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

/// **解析不了的设置文件改名留着，不静默丢掉**（2026-10-15）。原先解析失败就悄悄回默认值，
/// 下一次在卡片上动任何控件，set_settings 就把默认值整份写回去——手写的 devTools、语言、
/// 各个开关全没了，日志里一个字都没有。改名成 `.bad` 之后：坏文件还在、能看出坏在哪，
/// 这之后读到的是"没有设置文件"，按默认值走，和第一次启动一样。
pub fn load(app: &tauri::AppHandle) -> serde_json::Value {
    let mut v = defaults();
    if let Some(p) = path(app) {
        if let Ok(s) = std::fs::read_to_string(&p) {
            match serde_json::from_str::<serde_json::Value>(&s) {
                Ok(disk) => merge(&mut v, &disk),
                Err(e) => {
                    let bad = p.with_extension("json.bad");
                    let moved = std::fs::rename(&p, &bad).is_ok();
                    logf!(crate::log::Level::Warn, "[settings] settings.json 解析失败（{e}），按默认值走；{}",
                          if moved { "坏文件已改名为 settings.json.bad" } else { "坏文件改名失败" });
                }
            }
        }
    }
    v
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> serde_json::Value {
    load(&app)
}

/// 写盘时**盖在盘上那份之上**，不是盖在默认值之上。前端只收卡片上有的控件，
/// 原先盖在默认值上，手写进去的 `devTools` 在卡片上随便动一下就被抹掉了。
#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, value: serde_json::Value) {
    let mut merged = load(&app);
    merge(&mut merged, &value);
    if let Some(p) = path(&app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // **先写临时文件再改名盖过去**：直接 fs::write 是先截断再写，写到一半断电 / 被杀，
        // 留下的是半截 JSON，下次启动就读不出来（见 load）。同一目录里的 rename 是整个换掉，
        // Windows 上 std::fs::rename 会覆盖已有的目标文件
        let tmp = p.with_extension("json.tmp");
        let body = serde_json::to_string_pretty(&merged).unwrap_or_default();
        if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &p)) {
            logf!(crate::log::Level::Error, "[settings] 写 settings.json 失败：{e}");
        }
    }
    // 托盘菜单在 Rust 侧，前端那份 emit 管不到它——切语言要两边都动
    crate::tray::apply_lang(&app);
    // 录制开关立刻生效。原先它挂在 GSI 收包循环上（每 100 包轮询一次设置），
    // 结果没开游戏时拨动开关完全没反应——连"关掉"都停不下来。
    crate::record::refresh(&app);
    let _ = app.emit("settings", merged); // 覆盖层监听后实时生效
}

/// 用默认浏览器打开 Releases 页，给开发区的「打开下载页」。
///
/// **地址写死在这里**，前端只能说"开它"，传不进任意 URL。
/// `explorer <url>` 交给系统的默认浏览器，和 open_data_dir 同一个办法。
#[tauri::command]
pub fn open_release_page() {
    let _ = std::process::Command::new("explorer")
        .arg("https://github.com/shizzhang0/dota2-game-helper2/releases/latest")
        .spawn();
}

/// 开配置目录**本身**，不是它下面某一个子目录。`records/`、`logs/` 和两份设置文件
/// 是同级兄弟，给每个配一个按钮等于把文件树抄到卡片上；开父目录一次全覆盖，
/// 而且是唯一通向日志的入口——理由见 design/overlay.md 的「设置」里的「开发区」那条。
#[tauri::command]
pub fn open_data_dir(app: tauri::AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::process::Command::new("explorer").arg(dir).spawn();
    }
}
