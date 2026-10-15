//! **Dota 不在前台时整窗不显示**（2026-10-15）。
//!
//! 覆盖层是置顶的透明窗口，原先只看 GSI：对局中就画。而切到浏览器、Discord、桌面时
//! Dota 照样在后台推包，面板就压在别的程序上面——那一刻它什么用都没有，只挡东西。
//!
//! 这里轮询前台窗口属于哪个进程，**按进程名认 `dota2.exe`**，不认窗口标题或类名：
//! 标题随语言变、类名是 SDL 的通用名，进程名是唯一稳定的。结果变了才发 `dota-front`
//! 事件给前端，前端拿它和 inMatch、断流、临时隐藏一起算 visible。
//!
//! **前台是我们自己的窗口时维持原状**：编辑态会把焦点给覆盖层（要收 ESC），
//! 这时不能因为"前台不是 Dota"把面板藏了——编辑态本来就要看着面板调。
//! 从 Dota 里按热键进编辑态，退出后焦点留在覆盖层上，也还是按"在 Dota 里"算。
//!
//! 只读、不注入、不碰 Dota 的进程：拿到 pid 后只用 `PROCESS_QUERY_LIMITED_INFORMATION`
//! 读一下 exe 路径，和任务管理器显示进程名是同一个权限级别。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use windows::core::PWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::log::Level;
use crate::logf;

/// 当前是不是"Dota 在前台"。前端启动时用 `dota_front` 取一次，之后靠事件。
/// 初值为真：还没轮询到之前宁可显示，和原先的行为一样
static DOTA_FRONT: AtomicBool = AtomicBool::new(true);

/// 250ms 一次：切回游戏时面板最多晚四分之一秒出现，察觉不到；比 hittest 的 30ms 宽松得多，
/// 因为这里不跟手
const POLL_MS: u64 = 250;

enum Front {
    Dota,
    Mine,
    Other,
}

fn front() -> Front {
    // SAFETY: 都是只读查询；句柄用完就关
    unsafe {
        let hwnd = GetForegroundWindow();
        // 前台为空：Alt+Tab 切换的那一瞬间、锁屏时都会这样，按"不是 Dota"算
        if hwnd.0.is_null() {
            return Front::Other;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return Front::Other;
        }
        if pid == std::process::id() {
            return Front::Mine;
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return Front::Other;
        };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return Front::Other;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or("");
        if name.eq_ignore_ascii_case("dota2.exe") { Front::Dota } else { Front::Other }
    }
}

#[tauri::command]
pub fn dota_front() -> bool {
    DOTA_FRONT.load(Ordering::Relaxed)
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let mut cur: Option<bool> = None;
        loop {
            let now = match front() {
                Front::Dota => true,
                Front::Other => false,
                Front::Mine => cur.unwrap_or(true),
            };
            if cur != Some(now) {
                cur = Some(now);
                DOTA_FRONT.store(now, Ordering::Relaxed);
                let _ = app.emit("dota-front", now);
                logf!(Level::Debug, "[foreground] Dota 在前台 = {now}");
            }
            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        }
    });
}
