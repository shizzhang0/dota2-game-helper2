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
    /// 当前文件属于哪一局。换局就收尾，下一包懒建新文件。
    match_id: Option<String>,
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

/// 这一包说自己属于哪一局。`"0"` 和空串当作"不知道"——主菜单就是这个样子。
fn match_id(v: &serde_json::Value) -> Option<String> {
    let s = v.get("map")?.get("matchid")?.as_str()?;
    if s.is_empty() || s == "0" { None } else { Some(s.to_string()) }
}

/// 收尾之后把 matchid 补进文件名：`raw_<秒>.jsonl.gz` -> `raw_<秒>_m<matchid>.jsonl.gz`。
///
/// **时间戳留在前面**：同一局可能被录两次（比如回放看两遍），只有 matchid 会撞名。
/// 改名放在 `finish()` 之后——这时文件已经关上了，是一次普通的重命名；
/// 不去动正在写的那个文件的名字，Windows 上那取决于句柄的共享位，不值得赌。
fn tag_with_match(path: std::path::PathBuf, id: Option<&str>) -> std::path::PathBuf {
    let Some(id) = id else { return path };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return path };
    let Some(stem) = name.strip_suffix(".jsonl.gz") else { return path };
    if stem.contains("_m") {
        return path;
    }
    let to = path.with_file_name(format!("{stem}_m{id}.jsonl.gz"));
    match std::fs::rename(&path, &to) {
        Ok(()) => to,
        Err(e) => {
            logf!(Level::Warn, "[record] 改名失败（{} -> {}）: {e}",
                  path.display(), to.display());
            path
        }
    }
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
        let id = self.match_id.take();
        match enc.finish() {
            Ok(_) => {
                let p = path.map(|p| tag_with_match(p, id.as_deref()));
                logf!(Level::Info, "[record] 收尾（{why}）：{}",
                      p.map(|p| p.display().to_string()).unwrap_or_default());
            }
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
    *REC.lock().unwrap() = Some(Recorder { enabled: false, sink: None, since_flush: 0,
                                           match_id: None });
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
///
/// 收的是解析好的 `Value` 而不是字符串：换局要看 `map.matchid`，
/// 而 gsi.rs 那边本来就已经解析过一次了，没必要为了取一个字段再解析一遍。
pub fn write(app: &tauri::AppHandle, v: &serde_json::Value) {
    let mut g = REC.lock().unwrap();
    let Some(r) = g.as_mut() else { return };
    if !r.enabled {
        return;
    }
    // 换局就收尾，下面会懒建新文件。**两个都是真 matchid 且不相等**才算换局：
    // `map` 段可能整包缺席（GSI 推的是增量），主菜单里的 matchid 是 "0" 或没有，
    // 这些一律当"不知道"，跟着当前文件走——宁可让菜单数据粘在某一局的尾巴上，
    // 也不要凭空造出一堆碎文件。
    let id = match_id(v);
    if let (Some(now), Some(cur)) = (id.as_deref(), r.match_id.as_deref()) {
        if now != cur {
            r.close("换局");
        }
    }
    if r.sink.is_none() {
        // **没有 matchid 的包不建文件。** Dota 在主菜单里推的是这样的心跳包：
        // `{"provider":{…},"player":{},"events":[]}`，一包 114 字节。
        // 懒建是"第一包数据到来时才建"，而心跳包也算数据——于是断流封口之后
        // 只要 Dota 还开着，就会立刻建出一个只有心跳包的空壳文件。
        // 开关叫「记录对局数据」，没有对局就不该有文件。
        if id.is_none() {
            return;
        }
        r.open(app);
    }
    if id.is_some() {
        r.match_id = id;
    }
    let line = v.to_string();
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

/// 看门狗：2 秒一跳，管两件事。
///
/// 1. **断流** —— 超过 `IDLE_SECS` 没写过东西就给当前文件收尾封口。
///    之后若又来了包，`write` 会懒建一个新文件。
/// 2. **文件被删** —— 见 `vanished()`。
fn watchdog() {
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let idle = {
            let last = LAST_WRITE.load(Ordering::Relaxed);
            last != 0 && now().saturating_sub(last) >= IDLE_SECS
        };
        let mut g = REC.lock().unwrap();
        let Some(r) = g.as_mut() else { continue };
        if r.sink.is_none() {
            continue;
        }
        if idle {
            r.close("断流");
        } else if vanished() {
            // 收尾的是个幽灵句柄，写不到任何地方，但要把 sink 清掉，
            // 好让下一包懒建出一个新文件，这一局剩下的部分还能录到
            logf!(Level::Error,
                  "[record] 录制文件不见了（被外部删除？），这之前写的那段已经丢失；换新文件继续");
            r.close("文件被删");
        }
    });
}

/// 正在录的那个文件还在不在。
///
/// **Rust 的 `File::create` 在 Windows 上默认带 `FILE_SHARE_DELETE`**，所以
/// 外部（资源管理器、清理工具）可以删掉我们正在写的文件。删掉之后它进入"删除挂起"：
/// 目录项没了，而我们的句柄照样可写——实测 `write_all` 和 `flush` **都返回 `Ok`**。
/// 没有任何一层会报错，2026-09-19 就这么静默丢了 26 分钟的数据。
///
/// 不去改 `share_mode` 挡住删除：那只会让资源管理器弹"文件正在使用"，
/// 而用户并不知道哪个是正在录的。**让删除成功、但别让它静默。**
fn vanished() -> bool {
    match CURRENT.lock().unwrap().as_deref() {
        Some(p) => !p.exists(),
        None => false,
    }
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
