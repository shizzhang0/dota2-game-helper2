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
            n = n.wrapping_add(1);
            if n % 100 == 0 { rec.refresh(&app); }   // 让设置开关不重启也能生效
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    // 压成一行再写。Dota 推来的 body 是带制表符缩进的多行 JSON，
                    // 原样落盘一包就摊成几十行，根本不是 JSONL——replay.py 按行读
                    // 会一条都解析不出来。gsi_dump.py 用的同样是紧凑序列化。
                    // 解析不了的 body 干脆不写：回放也用不了，只会破坏文件结构。
                    rec.write(&v.to_string());
                    let _ = app.emit("gsi", v);
                }
                Err(e) => logf!(Level::Error, "[gsi] JSON 解析失败: {e}"),
            }
        }
    });
}
