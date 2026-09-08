use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

/// 托盘补的是一个真窟窿：窗口无边框 + skipTaskbar，没有托盘就没有任何退出途径。
///
/// 只有两项：设置已并入编辑态（面板旁边的卡片），不再有独立设置窗口。
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let edit = MenuItem::with_id(app, "edit", crate::lang::t(app, "tray.edit"), true, None::<&str>)?;
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
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = ev {
                crate::toggle_edit(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
