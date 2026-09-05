use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

/// 托盘补的是一个真窟窿：窗口无边框 + skipTaskbar，没有托盘就没有任何退出途径。
///
/// 只有两项：设置已并入编辑态（面板旁边的卡片），不再有独立设置窗口。
pub fn setup(app: &tauri::AppHandle) -> tauri::Result<()> {
    let edit = MenuItem::with_id(app, "edit", "编辑面板", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&edit, &sep, &quit])?;

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
