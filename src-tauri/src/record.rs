use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;
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
            logf!(Level::Info, "[record] 录制已停止");
            return;
        }
        let Ok(dir) = app.path().app_config_dir().map(|d| d.join("records")) else { return };
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("raw_{stamp}.jsonl.gz"));
        match std::fs::File::create(&path) {
            Ok(f) => {
                logf!(Level::Info, "[record] 开始录制 {}", path.display());
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
