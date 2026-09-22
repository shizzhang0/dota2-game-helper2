use tauri::{AppHandle, Emitter};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_MENU};

/// 每隔这么久无条件重发一次当前状态，见下。
const RESYNC: std::time::Duration = std::time::Duration::from_secs(1);

/// 被动轮询 Alt 键状态：只读取，不注册热键、不拦截、不注入，
/// 游戏内 Alt 的原有功能完全不受影响（"纯接收器"定位的一部分）。
///
/// **纯边沿触发会永久失步。** 原先的写法是「状态变了就 `let _ = app.emit(...)`，
/// 同时把 `prev` 推进」。这里有两个问题叠在一起：
///
/// 1. `emit` 的错误被丢掉了，而 `prev` **已经推进**——这一个边沿就此永远补不回来
/// 2. 之后只要状态不再变化，就再也不会重发
///
/// 失步之后前端会比实际**落后一个边沿**，用户看到的就是"Alt 变成了切换键"：
/// 按住显示、松开却不消失，再按一次才消失——因为消失发生在第二次的松开上。
///
/// 两道防线：`prev` 只在 `emit` 成功后推进；再加一个 1 秒的无条件重发，
/// 任何原因造成的失步最多一秒就自愈。前端那边 `alt = d` 是幂等的，重发无副作用。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut prev: Option<bool> = None;
        let mut last_sync = std::time::Instant::now();
        loop {
            let down = (unsafe { GetAsyncKeyState(VK_MENU.0 as i32) } as u16 & 0x8000) != 0;
            if prev != Some(down) || last_sync.elapsed() >= RESYNC {
                if app.emit("alt", down).is_ok() {
                    prev = Some(down);
                }
                last_sync = std::time::Instant::now();
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    });
}
