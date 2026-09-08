//! 界面语言。只覆盖两处：编辑态卡片（前端自己读）和托盘菜单（这里读）。
//! 覆盖层上一个字都没有，代码里的中文全是注释和日志，都不进语言包。
//!
//! 词条走"常数外置"那套，和其他常数表一起播种、一起补齐新增的键。
//! 见 docs/design/overlay.md 的「多语言」。

use windows::Win32::Globalization::GetUserDefaultLocaleName;

pub const FALLBACK: &str = "zh-CN";

/// 首次运行跟随系统语言：`zh` 开头给中文，其余一律英文。
/// 仓库是公开的，默认给陌生人一个看不懂的界面没道理；对中文用户结果和写死中文一样。
pub fn system_default() -> String {
    let mut buf = [0u16; 85]; // LOCALE_NAME_MAX_LENGTH
    let n = unsafe { GetUserDefaultLocaleName(&mut buf) };
    // 返回值含结尾的 NUL，减一才是真正的长度；失败时返回 0
    let name = if n > 1 { String::from_utf16_lossy(&buf[..(n as usize - 1)]) } else { String::new() };
    if name.to_ascii_lowercase().starts_with("zh") { FALLBACK.into() } else { "en".into() }
}

/// 当前语言。settings 的 defaults() 已经把 lang 填成系统语言，这里再兜一层。
pub fn current(app: &tauri::AppHandle) -> String {
    crate::settings::load(app)
        .get("lang")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(system_default)
}

/// 取一条词条。**缺键回退中文，不回退键名**——漏翻的地方显示中文至少还是句人话。
pub fn t(app: &tauri::AppHandle, key: &str) -> String {
    let lang = current(app);
    let pick = |v: &serde_json::Value| v.get(key).and_then(|s| s.as_str()).map(str::to_string);
    pick(&crate::constants::read(app, &format!("lang.{lang}")))
        .or_else(|| pick(&crate::constants::read(app, &format!("lang.{FALLBACK}"))))
        .unwrap_or_else(|| key.to_string())
}
