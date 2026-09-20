use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::log::Level;
use crate::logf;

/// 双击时要吞掉的那一个 `Click{Up}`。见 `setup` 里对消息序列的说明。
static SWALLOW_UP: AtomicBool = AtomicBool::new(false);

/// 托盘补的是一个真窟窿：窗口无边框 + skipTaskbar，没有托盘就没有任何退出途径。
///
/// 只有两项：设置已并入编辑态（面板旁边的卡片），不再有独立设置窗口。
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // 热键拼在 Rust 里，不进语言包：`Ctrl+Alt+F10` 两种语言一个样，
    // 而且语言包**只补缺键、不覆盖已有值**——改包里的 tray.edit 到不了老用户手上。
    //
    // 为什么要标出来：这个热键此前**只在 README 里出现过**，产品本身一个字没提。
    // 而它恰恰是「三条退出路径」里的最后一条兜底——被编辑态困住时最需要它的人，
    // 正是最没机会去翻 README 的人。托盘是进编辑态的主路径，标在这里学一次就记住。
    let edit_label = format!("{} ({})", crate::lang::t(app, "tray.edit"), crate::EDIT_HOTKEY_LABEL);
    let edit = MenuItem::with_id(app, "edit", edit_label, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", crate::lang::t(app, "tray.quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&edit, &sep, &quit])
}

/// 切语言后整个菜单重建再换上去。不用 set_text 逐项改——那要把菜单项句柄
/// 存进全局状态，为两个词不值当。
pub fn apply_lang(app: &tauri::AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("dota2-game-helper2")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "edit" => crate::toggle_edit(app),
            "quit" => app.exit(0),
            _ => {}
        })
        // **只认左键抬起。** 原先写的是 `Click { button: Left, .. }`，没有过滤
        // `button_state`，于是按下和抬起各触发一次——
        //
        // | 操作 | Windows 发来的消息 | 原先 toggle 次数 | 表现 |
        // |---|---|---|---|
        // | 单击 | DOWN, UP | 2 | 开了又关，**看起来没反应** |
        // | 双击 | DOWN, UP, DBLCLK, UP | 3（DBLCLK 被忽略） | 停在"开" |
        //
        // 也就是说文档里写的"左键单击 toggle 编辑态"一直是不成立的，
        // 真正能用的是双击，而那是凑出来的奇数次。
        //
        // 改成只在 `Up` 上动手之后，单击恰好一次。双击还会多出一个 `Up`
        // （序列里 DBLCLK 之后那个），用 `SWALLOW_UP` 吞掉它——
        // **让双击和单击表现一致**，而不是开了立刻又关。
        .on_tray_icon_event(|tray, ev| match ev {
            TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                logf!(Level::Debug, "[tray] 左键双击");
                SWALLOW_UP.store(true, Ordering::Relaxed);
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                if SWALLOW_UP.swap(false, Ordering::Relaxed) {
                    logf!(Level::Debug, "[tray] 吞掉双击后多出来的那次抬起");
                    return;
                }
                logf!(Level::Debug, "[tray] 左键抬起 -> toggle 编辑态");
                crate::toggle_edit(tray.app_handle());
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
