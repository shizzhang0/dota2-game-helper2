#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod altkey;
mod constants;
mod gsi;
mod gsicfg;
mod prices;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::ShortcutState;

/// 编辑态：可拖拽调位置；锁定态整窗鼠标穿透
static EDIT: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn save_layout(app: tauri::AppHandle, layout: String) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("layout.json"), layout);
    }
}

#[tauri::command]
fn load_layout(app: tauri::AppHandle) -> String {
    app.path()
        .app_config_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("layout.json")).ok())
        .unwrap_or_else(|| "{}".to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+alt+F10"])
                .expect("注册热键 Ctrl+Alt+F10 失败")
                .with_handler(|app, _shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let on = !EDIT.load(Ordering::Relaxed);
                    EDIT.store(on, Ordering::Relaxed);
                    if let Some(w) = app.get_webview_window("overlay") {
                        let _ = w.set_ignore_cursor_events(!on);
                    }
                    let _ = app.emit("edit", on);
                    println!("[hotkey] 编辑态 = {on}");
                })
                .build(),
        )
        .setup(|app| {
            let w = app.get_webview_window("overlay").unwrap();
            if let Some(mon) = w.primary_monitor()? {
                let pos = mon.position();
                w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y))?;
                w.set_size(*mon.size())?;
            }
            w.set_ignore_cursor_events(true)?;

            constants::seed(app.handle());
            gsi::spawn(app.handle().clone());
            altkey::spawn(app.handle().clone());
            prices::spawn_refresh(app.handle().clone());
            gsicfg::ensure_cfg();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            constants::get_constants,
            prices::get_item_prices,
            save_layout,
            load_layout
        ])
        .run(tauri::generate_context!())
        .expect("tauri run");
}
