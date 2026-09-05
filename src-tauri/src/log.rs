use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

#[derive(PartialEq, PartialOrd, Clone, Copy)]
pub enum Level {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

impl Level {
    fn parse(s: &str) -> Level {
        match s {
            "error" => Level::Error,
            "warn" => Level::Warn,
            "info" => Level::Info,
            _ => Level::Debug,
        }
    }
    fn tag(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }
}

static STATE: Mutex<Option<(std::path::PathBuf, Level)>> = Mutex::new(None);

pub fn init(app: &tauri::AppHandle) {
    let level = Level::parse(crate::settings::load(app)["logLevel"].as_str().unwrap_or("debug"));
    let Ok(dir) = app.path().app_config_dir().map(|d| d.join("logs")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("helper2.log");
    // 超过 5MB 轮转一次，只留一个备份，够排查用
    if std::fs::metadata(&file).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("helper2.1.log"));
    }
    // 新建时写 UTF-8 BOM：日志是给人看的，中文 Windows 上有些工具不带 BOM 会认错编码
    if !file.exists() {
        if let Ok(mut f) = std::fs::File::create(&file) {
            let _ = f.write_all(&[0xEF, 0xBB, 0xBF]);
        }
    }
    *STATE.lock().unwrap() = Some((file, level));
}

pub fn write(level: Level, msg: &str) {
    let guard = STATE.lock().unwrap();
    let Some((path, min)) = guard.as_ref() else { return };
    if level > *min {
        return;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{secs} [{}] {msg}", level.tag());
    }
}

#[macro_export]
macro_rules! logf {
    ($lv:expr, $($a:tt)*) => { $crate::log::write($lv, &format!($($a)*)) };
}

/// 前端错误转发。没有它的话，正式版里前端一抛异常就是面板空白且无声无息。
#[tauri::command]
pub fn log_front(level: String, msg: String) {
    write(Level::parse(&level), &format!("[front] {msg}"));
}
