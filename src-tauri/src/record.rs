use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

use crate::log::Level;
use crate::logf;

/// 对局录制。全量保真不裁字段——录制的价值就在于事后能查任何东西。
/// 实测 11 分钟正常局原始 37MB，gzip 后约 4MB。
pub struct Recorder {
    enabled: bool,
    sink: Option<GzEncoder<std::fs::File>>,
    since_flush: u32,
}

/// 每多少包 flush 一次。gzip 把数据缓存在内存里，只有 finish/flush 才落盘；
/// 而进程被杀（包括托盘退出走的 app.exit）时析构不会执行，不定期 flush 就整段全丢。
/// 真实 GSI 约 10 包/秒，50 包 ≈ 5 秒，最坏只丢这么多。
const FLUSH_EVERY: u32 = 50;

/// 当前正在写的那个文件。`Recorder` 活在 GSI 那条线程里，拿不到，
/// 而清理命令**必须**知道它——见 `clear_records` 的注释。
static CURRENT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("records"))
}

/// 录制文件列表。只认自己写出来的那个后缀，别把用户放进去的东西也算上、更别删掉。
fn files(app: &tauri::AppHandle) -> Vec<std::path::PathBuf> {
    let Some(d) = dir(app) else { return vec![] };
    let Ok(rd) = std::fs::read_dir(d) else { return vec![] };
    rd.filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("raw_") && n.ends_with(".jsonl.gz")))
        .collect()
}

fn size(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
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
        if cur.as_deref() == Some(p.as_path()) { kept += 1; continue; }
        let n = size(&p);
        match std::fs::remove_file(&p) {
            Ok(()) => { deleted += 1; freed += n; }
            Err(e) => { kept += 1; logf!(Level::Error, "[record] 删除 {} 失败: {e}", p.display()); }
        }
    }
    logf!(Level::Info, "[record] 清空录制：删了 {deleted} 个（{freed} 字节），留下 {kept} 个");
    serde_json::json!({ "deleted": deleted, "freed": freed, "kept": kept })
}

impl Recorder {
    pub fn new(app: &tauri::AppHandle) -> Recorder {
        let mut r = Recorder { enabled: false, sink: None, since_flush: 0 };
        r.refresh(app);
        r
    }

    /// 按当前设置开关录制。关闭时把已写内容收尾，否则 gzip 文件不完整读不出来。
    pub fn refresh(&mut self, app: &tauri::AppHandle) {
        let want = crate::settings::load(app)["recordMatches"].as_bool().unwrap_or(false);
        if want == self.enabled {
            return;
        }
        self.enabled = want;
        if !want {
            if let Some(enc) = self.sink.take() {
                let _ = enc.finish();
            }
            *CURRENT.lock().unwrap() = None;
            logf!(Level::Info, "[record] 录制已停止");
            return;
        }
        let Some(dir) = dir(app) else { return };
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("raw_{stamp}.jsonl.gz"));
        match std::fs::File::create(&path) {
            Ok(f) => {
                logf!(Level::Info, "[record] 开始录制 {}", path.display());
                *CURRENT.lock().unwrap() = Some(path.clone());
                self.sink = Some(GzEncoder::new(f, Compression::default()));
            }
            Err(e) => logf!(Level::Error, "[record] 建文件失败: {e}"),
        }
    }

    pub fn write(&mut self, line: &str) {
        let Some(enc) = self.sink.as_mut() else { return };
        if writeln!(enc, "{line}").is_err() {
            logf!(Level::Error, "[record] 写入失败，停止录制");
            self.sink = None;
            return;
        }
        self.since_flush += 1;
        if self.since_flush >= FLUSH_EVERY {
            self.since_flush = 0;
            if enc.flush().is_err() {
                logf!(Level::Error, "[record] flush 失败，停止录制");
                self.sink = None;
            }
        }
    }
}
