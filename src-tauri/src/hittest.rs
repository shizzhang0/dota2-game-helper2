//! 编辑态下**只有设置卡片吃鼠标**，其余地方照常穿透到游戏（2026-10-09）。
//!
//! 原先编辑态整窗 `set_ignore_cursor_events(false)`，等于在全屏盖了一层透明的膜：
//! 卡片以外点不到游戏、桌面、任务栏。那是给"拖动各个块"用的——块可能在屏幕任何位置。
//! v1.4.0 块不能拖了，真正要点的只剩卡片，这层膜就没有存在的理由。
//!
//! Tauri 只能整窗切换穿透，没法只放开一块区域，所以这里轮询鼠标位置：
//! 编辑态下鼠标在卡片上就关掉穿透，离开就恢复。卡片的位置和大小由前端报过来
//! （打开、拖动、尺寸变化时），见 `ui/js/editor.js` 的 `reportRect`。
//!
//! **按住左键时不切**：拖卡片拖得快，鼠标可能跑到还没更新的矩形外面；
//! 下拉框的弹出层也可能伸出卡片。这时切成穿透，松手那一下就落进游戏里了。
//! 所以只有在左键松开时才允许从"吃鼠标"切回"穿透"。

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// 卡片在窗口客户区里的矩形，**物理像素**（前端乘过 devicePixelRatio）：[x, y, w, h]。
/// `None` = 卡片没开。
static CARD: Mutex<Option<[f64; 4]>> = Mutex::new(None);

/// 矩形往外放这么多物理像素再判，免得贴着边缘时一会儿穿透一会儿不穿透
const MARGIN: f64 = 8.0;

#[tauri::command]
pub fn set_card_rect(rect: Option<[f64; 4]>) {
    *CARD.lock().unwrap() = rect;
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // 上一次实际设下去的值。None = 还没设过（启动时窗口本来就是穿透的）
        let mut applied: Option<bool> = None;
        // 窗口客户区左上角的屏幕坐标。窗口启动时就铺满主屏、之后不再挪，进编辑态时读一次
        let mut origin: Option<(f64, f64)> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let Some(w) = app.get_webview_window("overlay") else { continue };
            let edit = crate::EDIT.load(Ordering::Relaxed);
            // 不在编辑态一律穿透。set_edit 自己也会设，这里再兜一次：
            // 万一两边的时序交错（这一圈读到的还是编辑态），下一圈就纠正回来，
            // 不会留下一张挡住全屏的膜
            let ignore = if !edit {
                origin = None;
                true
            } else {
                if origin.is_none() {
                    origin = w.inner_position().ok().map(|p| (p.x as f64, p.y as f64));
                }
                let inside = match (*CARD.lock().unwrap(), origin) {
                    (Some([x, y, cw, ch]), Some((ox, oy))) => {
                        let mut pt = POINT::default();
                        unsafe { GetCursorPos(&mut pt) }.is_ok() && {
                            let (px, py) = (pt.x as f64 - ox, pt.y as f64 - oy);
                            px >= x - MARGIN && px <= x + cw + MARGIN
                                && py >= y - MARGIN && py <= y + ch + MARGIN
                        }
                    }
                    _ => false,
                };
                let held = (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0;
                // 按住左键时维持现状（见文件头）；第一次进编辑态还没设过，按鼠标位置定
                if held && applied.is_some() { applied.unwrap() } else { !inside }
            };
            if applied != Some(ignore) && w.set_ignore_cursor_events(ignore).is_ok() {
                applied = Some(ignore);
            }
        }
    });
}
