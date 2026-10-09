use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

use crate::log::Level;
use crate::logf;

/// 双击时要吞掉的那一个 `Click{Up}`。见 `setup` 里对消息序列的说明。
static SWALLOW_UP: AtomicBool = AtomicBool::new(false);

/// 托盘补的是一个真窟窿：窗口无边框 + skipTaskbar，没有托盘就没有任何退出途径。
///
/// 三项：「始终显示」（带勾）、「设置」、「退出」。
/// 设置本身就是编辑态里那张卡片，不再有独立设置窗口——
/// 之所以把「始终显示」单拎出来，是因为它是唯一需要**在对局中途**拨的开关，
/// 而中途进编辑态会抢焦点、没法继续玩。
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // 热键拼在 Rust 里，不进语言包：`Ctrl+Alt+F10` 两种语言一个样。
    //
    // 为什么要标出来：这个热键此前**只在 README 里出现过**，产品本身一个字没提。
    // 而它恰恰是「三条退出路径」里的最后一条兜底——被编辑态困住时最需要它的人，
    // 正是最没机会去翻 README 的人。托盘是进编辑态的主路径，标在这里学一次就记住。
    // 文案复用卡片里那一条（`card.alwaysShow`），不新开语言包的键：两处说的是同一件事，
    // 分成两个键迟早会不一致。
    let always_label = format!("{} ({})",
                               crate::lang::t(app, "card.alwaysShow"), crate::ALWAYS_HOTKEY_LABEL);
    let always_on = crate::settings::load(app)["alwaysShow"].as_bool().unwrap_or(true);
    let always = CheckMenuItem::with_id(app, "always", always_label, true, always_on, None::<&str>)?;

    let edit_label = format!("{} ({})", crate::lang::t(app, "tray.edit"), crate::EDIT_HOTKEY_LABEL);
    let edit = MenuItem::with_id(app, "edit", edit_label, true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", crate::lang::t(app, "tray.quit"), true, None::<&str>)?;
    // 查到新版本时多一项，点了打开设置卡片——更新按钮在卡片版本那一行（见 updater.rs）
    if let Some(v) = crate::updater::available() {
        let label = format!("{} {v}", crate::lang::t(app, "tray.update"));
        let upd = MenuItem::with_id(app, "update", label, true, None::<&str>)?;
        let sep2 = PredefinedMenuItem::separator(app)?;
        return Menu::with_items(app, &[&upd, &sep2, &always, &edit, &sep, &quit]);
    }
    Menu::with_items(app, &[&always, &edit, &sep, &quit])
}

/// 切语言、或「始终显示」被拨动之后，整个菜单重建再换上去（勾选状态也在里面）。
/// 不用 set_text / set_checked 逐项改——那要把菜单项句柄存进全局状态，
/// 为三个词不值当。`set_settings` 每次都会调它。
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
        // 悬停提示带版本号：用户报问题时鼠标移上去就能念出来，不用进设置卡片
        .tooltip(format!("dota2-game-helper2 v{}", app.package_info().version))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            // 不读菜单项自己的勾选状态，直接翻设置里那个值——
            // 勾选状态由 `set_settings` 重建菜单时统一刷，单一数据源。
            "always" => crate::settings::toggle_always_show(app),
            "edit" => crate::toggle_edit(app),
            "update" => crate::set_edit(app, true),
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
