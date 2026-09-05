use tauri::{AppHandle, Emitter};
use crate::log::Level;
use crate::logf;

/// 监听 GSI 推送。收包先回 200 再处理，绝不让游戏等待。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:53000") {
            Ok(s) => s,
            Err(e) => {
                logf!(Level::Error, "[gsi] 无法监听 53000: {e}");
                return;
            }
        };
        logf!(Level::Info, "[gsi] 监听 http://127.0.0.1:53000");
        let mut rec = crate::record::Recorder::new(&app);
        let mut n: u32 = 0;
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let _ = req.respond(tiny_http::Response::from_string("ok"));
            rec.write(&body);          // 写原始文本，保证与 gsi_dump.py 完全同格式
            n = n.wrapping_add(1);
            if n % 100 == 0 { rec.refresh(&app); }   // 让设置开关不重启也能生效
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    let _ = app.emit("gsi", v);
                }
                Err(e) => logf!(Level::Error, "[gsi] JSON 解析失败: {e}"),
            }
        }
    });
}
