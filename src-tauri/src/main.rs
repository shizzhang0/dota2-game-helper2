#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod altkey;
mod constants;
mod gsi;
mod gsicfg;
mod log;
mod prices;
mod record;
mod settings;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

use crate::log::Level;
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

/// 设置编辑态。热键、托盘菜单、面板上的「完成」按钮共用这一份，别各存一份状态。
///
/// 注意：这里**绝不能**调用 global_shortcut 的 register/unregister。
/// 本函数会从热键回调里被调用，而插件派发回调时持有内部锁，
/// 在回调里再去动热键注册会直接死锁、整个程序卡住。
/// 退出编辑态的 ESC 因此改由前端监听 keydown 实现（见 ui/js/main.js）。
pub fn set_edit(app: &tauri::AppHandle, on: bool) {
    EDIT.store(on, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_ignore_cursor_events(!on);
        // 编辑态给窗口焦点，前端才收得到 ESC 的 keydown
        if on {
            let _ = w.set_focus();
        }
    }
    let _ = app.emit("edit", on);
    logf!(Level::Info, "[edit] 编辑态 = {on}");
}

pub fn toggle_edit(app: &tauri::AppHandle) {
    set_edit(app, !EDIT.load(Ordering::Relaxed));
}

/// 供前端的「完成」按钮与 ESC 调用
#[tauri::command]
fn exit_edit(app: tauri::AppHandle) {
    set_edit(&app, false);
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
                    if event.state() == ShortcutState::Pressed {
                        toggle_edit(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            log::init(app.handle());   // 必须最先，否则其他模块的启动日志会丢
            let w = app.get_webview_window("overlay").unwrap();
            if let Some(mon) = w.primary_monitor()? {
                let pos = mon.position();
                w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y))?;
                w.set_size(*mon.size())?;
            }
            w.set_ignore_cursor_events(true)?;

            tray::setup(app.handle())?;

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
            settings::get_settings,
            settings::set_settings,
            settings::open_constants_dir,
            log::log_front,
            exit_edit,
            save_layout,
            load_layout
        ])
        .run(tauri::generate_context!())
        .expect("tauri run");
}
