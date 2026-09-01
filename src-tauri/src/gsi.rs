use tauri::{AppHandle, Emitter};

/// 监听 GSI 推送。收包先回 200 再处理，绝不让游戏等待。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:53000") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[gsi] 无法监听 53000: {e}");
                return;
            }
        };
        println!("[gsi] 监听 http://127.0.0.1:53000");
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let _ = req.respond(tiny_http::Response::from_string("ok"));
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    let _ = app.emit("gsi", v);
                }
                Err(e) => eprintln!("[gsi] JSON 解析失败: {e}"),
            }
        }
    });
}
