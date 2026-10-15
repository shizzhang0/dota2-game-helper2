#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod constants;
mod dotacfg;
mod gsi;
mod gsicfg;
mod hittest;
mod lang;
mod log;
mod prices;
mod record;
mod settings;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

use crate::log::Level;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 编辑态：打开设置卡片。鼠标穿透由 hittest.rs 管——只有卡片上不穿透
pub(crate) static EDIT: AtomicBool = AtomicBool::new(false);

/// 设置编辑态。热键、托盘菜单、面板上的「完成」按钮共用这一份，别各存一份状态。
///
/// 注意：这里**绝不能**调用 global_shortcut 的 register/unregister。
/// 本函数会从热键回调里被调用，而插件派发回调时持有内部锁，
/// 在回调里再去动热键注册会直接死锁、整个程序卡住。
/// 退出编辑态的 ESC 因此改由前端监听 keydown 实现（见 ui/js/main.js）。
pub fn set_edit(app: &tauri::AppHandle, on: bool) {
    EDIT.store(on, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window("overlay") {
        // **进出编辑态都先设成穿透**：编辑态下只有设置卡片吃鼠标，由 hittest.rs 按鼠标位置
        // 随时切换（v1.4.0 起；原先编辑态整窗不穿透，卡片以外点不到游戏，见那个文件的头注释）
        let _ = w.set_ignore_cursor_events(true);
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

/// 临时隐藏覆盖层的热键：按一下收起、再按一下恢复。**不存盘**，前端记着，换下一局或重启程序自动恢复显示。
/// 给人看的写法在设置卡片底部的提示里（`card.hint`），改这里记得改那边。
///
/// 原先是「按住 Alt 才显示」那个开关的热键；2026-10-14 那个开关连同 Alt 检测一起去掉了
/// （对局中一直显示），这个键留下来当临时隐藏——截干净的游戏截图、某一刻嫌它挡东西时用，
/// 不切出游戏就能收起来（进设置卡片会抢焦点，那一刻没法继续玩）。
///
/// **不能用裸字母**：Dota 几乎把字母键占满了。带两个修饰键的 F 区组合不会撞游戏，
/// 和编辑态的 `Ctrl+Alt+F10` 挨着，同一族好记。
pub const HIDE_HOTKEY: &str = "ctrl+alt+F11";

pub fn toggle_edit(app: &tauri::AppHandle) {
    set_edit(app, !EDIT.load(Ordering::Relaxed));
}

/// 供前端的「完成」按钮与 ESC 调用
#[tauri::command]
fn exit_edit(app: tauri::AppHandle) {
    set_edit(&app, false);
}

fn main() {
    // 卸载器在删文件之前带这个参数启动我们一次：只删 GSI 配置，不起窗口（见 windows/hooks.nsh）
    if std::env::args().any(|a| a == "--cleanup") {
        gsicfg::remove_cfg();
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            // 只装回调，热键在 setup 里注册（见那里的注释）
            tauri_plugin_global_shortcut::Builder::new()
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
                    } else if is(HIDE_HOTKEY) {
                        let _ = app.emit("toggle-hide", ());
                        logf!(Level::Info, "[hide] 切换临时隐藏");
                    }
                })
                .build(),
        )
        .setup(|app| {
            log::init(app.handle());   // 必须最先，否则其他模块的启动日志会丢

            // **热键注册失败不退出，记一条 Error 接着跑**（2026-10-15）。原先用插件 Builder 的
            // with_shortcuts 注册：它跑在 setup 之前、log::init 之前，RegisterHotKey 一失败
            // （热键被别的程序占了，或者程序已经开着又双击了一次）就在 .expect("tauri build")
            // 处 panic，窗口不出、日志没有，看起来就是"双击没反应"。挪到这里之后能记下来，
            // 托盘菜单照样能进设置。逐个注册：一个被占不连累另一个。
            // 这里不是热键回调里，可以注册（回调里绝不能，见 set_edit 的注释）
            for hk in [EDIT_HOTKEY, HIDE_HOTKEY] {
                if let Err(e) = app.global_shortcut().register(hk) {
                    logf!(Level::Error, "[hotkey] 注册 {hk} 失败：{e}");
                }
            }
            let w = app.get_webview_window("overlay").unwrap();
            if let Some(mon) = w.primary_monitor()? {
                let pos = mon.position();
                w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y))?;
                w.set_size(*mon.size())?;
            }
            w.set_ignore_cursor_events(true)?;

            tray::setup(app.handle())?;

            constants::log_version();
            record::init(app.handle());          // 必须在 gsi 之前：第一包来的时候它得已经在
            gsi::spawn(app.handle().clone());
            hittest::spawn(app.handle().clone());
            gsicfg::ensure_cfg();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            constants::get_constants,
            constants::get_versions,
            dotacfg::dota_hud,
            hittest::set_card_rect,
            updater::app_installed,
            updater::set_update_available,
            updater::update_install,
            prices::get_item_prices,
            settings::get_settings,
            settings::set_settings,
            settings::open_data_dir,
            settings::open_release_page,
            record::records_stat,
            record::clear_records,
            log::log_front,
            exit_edit
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
