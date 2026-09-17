use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

use crate::log::Level;
use crate::logf;

/// 对局录制。全量保真不裁字段——录制的价值就在于事后能查任何东西。
/// 实测 11 分钟正常局原始 37MB，gzip 后约 4MB。
///
/// **录制器是全局的，不再是 GSI 线程的局部变量**（2026-09-16）。原先它活在那条线程里，
/// 而处理开关的 `refresh()` 只在 `n % 100 == 0` 时被调用——也就是**只有 Dota 在推包
/// 时才会跑**。于是开关在没开游戏时完全失灵：勾上不建文件，取消勾选也停不掉；
/// 更糟的是 `finish()` 只在"从开变关"那条路径上调用，托盘退出、Dota 关掉、GSI 断流
/// 都不收尾，不足 50 包的那一局整个消失且毫无提示。
/// 挪到全局之后，设置、退出、断流三条路都能够到它。详见 design/overlay.md。
struct Recorder {
    enabled: bool,
    sink: Option<GzEncoder<std::fs::File>>,
    since_flush: u32,
}

/// 每多少包 flush 一次。gzip 把数据缓存在内存里，只有 finish/flush 才落盘；
/// 而进程被杀时析构不会执行，不定期 flush 就整段全丢。
/// 真实 GSI 约 10 包/秒，50 包 ≈ 5 秒，最坏只丢这么多。
const FLUSH_EVERY: u32 = 50;

/// 多久没收到包就给当前文件收尾。Dota 在主菜单里照样推包，所以这条实际只在
/// **游戏整个关掉**时触发——它解决的是"收尾"，不是"按对局分文件"（那条要靠 matchid）。
const IDLE_SECS: u64 = 20;

static REC: Mutex<Option<Recorder>> = Mutex::new(None);
/// 最后一次写入的 unix 秒。看门狗靠它判断断流；0 表示还没写过任何东西。
static LAST_WRITE: AtomicU64 = AtomicU64::new(0);
/// 当前正在写的那个文件。清理命令必须知道它——见 `clear_records` 的注释。
static CURRENT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("records"))
}

/// 录制文件列表。只认自己写出来的那个后缀，别把用户放进去的东西也算上、更别删掉。
fn files(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let Some(d) = dir(app) else { return vec![] };
    let Ok(rd) = std::fs::read_dir(d) else { return vec![] };
    rd.filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("raw_") && n.ends_with(".jsonl.gz"))
        })
        .collect()
}

fn size(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

impl Recorder {
    /// 收尾。**这是唯一会调 `finish()` 的地方**，四条路都汇到这里：
    /// 开关关掉、程序退出、断流看门狗、写入出错。
    fn close(&mut self, why: &str) {
        let Some(enc) = self.sink.take() else { return };
        let path = CURRENT.lock().unwrap().take();
        match enc.finish() {
            Ok(_) => logf!(Level::Info, "[record] 收尾（{why}）：{}",
                           path.map(|p| p.display().to_string()).unwrap_or_default()),
            Err(e) => logf!(Level::Error, "[record] 收尾失败（{why}）: {e}"),
        }
        self.since_flush = 0;
    }

    /// 懒建文件：只有真有数据要写的时候才建。
    ///
    /// **这样"勾上开关但没开游戏"不再产生任何文件**，也就不会再留下 0 字节的空壳；
    /// 文件名里的时间戳含义也从"你什么时候拨的开关"变成了"数据什么时候开始"。
    fn open(&mut self, app: &tauri::AppHandle) {
        let Some(d) = dir(app) else { return };
        let _ = std::fs::create_dir_all(&d);
        let path = d.join(format!("raw_{}.jsonl.gz", now()));
        match std::fs::File::create(&path) {
            Ok(f) => {
                logf!(Level::Info, "[record] 开始录制 {}", path.display());
                *CURRENT.lock().unwrap() = Some(path);
                self.sink = Some(GzEncoder::new(f, Compression::default()));
                self.since_flush = 0;
            }
            Err(e) => logf!(Level::Error, "[record] 建文件失败: {e}"),
        }
    }
}

/// 启动录制子系统。必须在 GSI 起来之前调用。
pub fn init(app: &tauri::AppHandle) {
    *REC.lock().unwrap() = Some(Recorder { enabled: false, sink: None, since_flush: 0 });
    refresh(app);
    watchdog();
}

/// 按当前设置开关录制。**由 `set_settings` 直接调用**，所以拨动开关立刻生效，
/// 不再等 GSI 推包——那正是原先失灵的根源。
pub fn refresh(app: &tauri::AppHandle) {
    let want = crate::settings::load(app)["recordMatches"].as_bool().unwrap_or(false);
    let mut g = REC.lock().unwrap();
    let Some(r) = g.as_mut() else { return };
    if want == r.enabled {
        return;
    }
    r.enabled = want;
    if want {
        logf!(Level::Info, "[record] 录制已开启，等第一包数据再建文件");
    } else {
        r.close("关闭开关");
        logf!(Level::Info, "[record] 录制已停止");
    }
}

/// 写一包。文件在这里懒建，所以调用方不需要关心有没有开着。
pub fn write(app: &tauri::AppHandle, line: &str) {
    let mut g = REC.lock().unwrap();
    let Some(r) = g.as_mut() else { return };
    if !r.enabled {
        return;
    }
    if r.sink.is_none() {
        r.open(app);
    }
    let Some(enc) = r.sink.as_mut() else { return };
    if writeln!(enc, "{line}").is_err() {
        logf!(Level::Error, "[record] 写入失败，停止录制");
        r.close("写入失败");
        return;
    }
    LAST_WRITE.store(now(), Ordering::Relaxed);
    r.since_flush += 1;
    if r.since_flush >= FLUSH_EVERY {
        r.since_flush = 0;
        if enc.flush().is_err() {
            logf!(Level::Error, "[record] flush 失败，停止录制");
            r.close("flush 失败");
        }
    }
}

/// 程序退出时收尾。挂在 `RunEvent::Exit` 上——托盘退出走 `app.exit()`，
/// 析构不会执行，不在这里 finish 就会丢掉最后没 flush 的那一段。
pub fn shutdown() {
    if let Some(r) = REC.lock().unwrap().as_mut() {
        r.close("程序退出");
    }
}

/// 断流看门狗：2 秒一跳，超过 `IDLE_SECS` 没写过东西就给当前文件收尾封口。
/// 之后若又来了包，`write` 会懒建一个新文件。
fn watchdog() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let last = LAST_WRITE.load(Ordering::Relaxed);
        if last == 0 || now().saturating_sub(last) < IDLE_SECS {
            continue;
        }
        let mut g = REC.lock().unwrap();
        if let Some(r) = g.as_mut() {
            if r.sink.is_some() {
                r.close("断流");
            }
        }
    });
}

/// 开发区那一行：有几个文件、一共多大。
#[tauri::command]
pub fn records_stat(app: tauri::AppHandle) -> serde_json::Value {
    let fs_ = files(&app);
    serde_json::json!({ "count": fs_.len(), "bytes": fs_.iter().map(|p| size(p)).sum::<u64>() })
}

/// 清空录制。**刻意不做自动清理**：按时间或大小自动删，删掉的很可能正是
/// 待验清单在等的那一局，而打过的对局回不来。做决定的必须是人。
///
/// **正在录的那个跳过。** `Recorder` 攥着它的 `GzEncoder<File>`，删掉之后这一局
/// 后面的数据会静默流进一个已经不存在的文件。跳过而不是"先停录再删"——
/// 别让一次清理顺手关掉用户正在录的对局。
#[tauri::command]
pub fn clear_records(app: tauri::AppHandle) -> serde_json::Value {
    let cur = CURRENT.lock().unwrap().clone();
    let (mut deleted, mut freed, mut kept) = (0u32, 0u64, 0u32);
    for p in files(&app) {
        if cur.as_deref() == Some(p.as_path()) {
            kept += 1;
            continue;
        }
        let n = size(&p);
        match std::fs::remove_file(&p) {
            Ok(()) => {
                deleted += 1;
                freed += n;
            }
            Err(e) => {
                kept += 1;
                logf!(Level::Error, "[record] 删除 {} 失败: {e}", p.display());
            }
        }
    }
    logf!(Level::Info, "[record] 清空录制：删了 {deleted} 个（{freed} 字节），留下 {kept} 个");
    serde_json::json!({ "deleted": deleted, "freed": freed, "kept": kept })
}
