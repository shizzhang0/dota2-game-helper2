use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};

/// 被动轮询 Alt 键状态：只读取，不注册热键、不拦截、不注入，
/// 游戏内 Alt 的原有功能完全不受影响（"纯接收器"定位的一部分）。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut prev = false;
        loop {
            let down = (unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } as u16 & 0x8000) != 0;
            if down != prev {
                prev = down;
                let _ = app.emit("alt", down);
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });
}
