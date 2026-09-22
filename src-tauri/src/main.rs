#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod altkey;
mod constants;
mod gsi;
mod gsicfg;
mod lang;
mod log;
mod prices;
mod record;
mod settings;
mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

use crate::log::Level;
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

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

/// 编辑态热键。**注册用的和给人看的必须一致**，改一个记得改另一个——
/// 全局热键的写法要小写，而托盘菜单上要显示成 Windows 的惯用大小写。
pub const EDIT_HOTKEY: &str = "ctrl+alt+F10";
pub const EDIT_HOTKEY_LABEL: &str = "Ctrl+Alt+F10";

/// 「始终显示」开关的热键，规则同上。
///
/// **为什么值得再占一个全局热键**：想在对局中途开关它，原本唯一的入口是编辑态，
/// 而编辑态会抢焦点、取消鼠标穿透——那一刻根本没法继续玩。于是这个开关事实上
/// 退化成了"开局前设好就别动"，而它最有价值的用法恰恰是中途切换
/// （对线打钱时开着，团战时关掉免得挡视野）。
///
/// **不能用裸字母**：Dota 几乎把字母键占满了。带两个修饰键的 F 区组合不会撞游戏，
/// 和编辑态的 `Ctrl+Alt+F10` 挨着，同一族好记。
pub const ALWAYS_HOTKEY: &str = "ctrl+alt+F11";
pub const ALWAYS_HOTKEY_LABEL: &str = "Ctrl+Alt+F11";

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
                .with_shortcuts([EDIT_HOTKEY, ALWAYS_HOTKEY])
                .expect("注册全局热键失败")
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // **比解析后的 Shortcut，不比字符串**：Display 的规范化写法
                    // 未必和这里的字面量一致（大小写、修饰键顺序）。
                    let is = |lit: &str| {
                        lit.parse::<Shortcut>().map(|s| &s == shortcut).unwrap_or(false)
                    };
                    if is(EDIT_HOTKEY) {
                        toggle_edit(app);
                    } else if is(ALWAYS_HOTKEY) {
                        settings::toggle_always_show(app);
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
            record::init(app.handle());          // 必须在 gsi 之前：第一包来的时候它得已经在
            gsi::spawn(app.handle().clone());
            altkey::spawn(app.handle().clone());
            gsicfg::ensure_cfg();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            constants::get_constants,
            constants::get_versions,
            prices::get_item_prices,
            settings::get_settings,
            settings::set_settings,
            settings::open_data_dir,
            record::records_stat,
            record::clear_records,
            log::log_front,
            exit_edit,
            save_layout,
            load_layout
        ])
        .build(tauri::generate_context!())
        .expect("tauri build")
        // 托盘退出走的是 app.exit()，析构**不会**执行——不在这里收尾，
        // 录制缓冲区里最后没 flush 的那一段就丢了，而且毫无提示。
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                record::shutdown();
            }
        });
}
