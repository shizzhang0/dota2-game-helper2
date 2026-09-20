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
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let _ = req.respond(tiny_http::Response::from_string("ok"));
            // 这里**不再**轮询录制开关。原先是 `n % 100 == 0` 时调一次 refresh，
            // 于是开关只在 Dota 推包时才生效——没开游戏就完全失灵。
            // 现在 set_settings 直接通知录制器，见 record.rs 顶部的注释。
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    // **传解析好的 Value，不传 body**。两个原因：
                    // 一是录制要压成一行——Dota 推来的 body 是带制表符缩进的多行 JSON，
                    // 原样落盘一包就摊成几十行，根本不是 JSONL，replay.py 按行读
                    // 会一条都解析不出来（gsi_dump.py 用的同样是紧凑序列化）；
                    // 二是按对局分文件要读 map.matchid，这里既然已经解析过了，
                    // 就别让录制侧为了一个字段再解析一遍。
                    // 解析不了的 body 干脆不写：回放也用不了，只会破坏文件结构。
                    crate::record::write(&app, &v);
                    let _ = app.emit("gsi", v);
                }
                Err(e) => logf!(Level::Error, "[gsi] JSON 解析失败: {e}"),
            }
        }
    });
}
