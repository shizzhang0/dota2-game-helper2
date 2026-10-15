use std::io::Read;
use tauri::{AppHandle, Emitter};
use crate::log::Level;
use crate::logf;

/// 一包的上限。实测 Dota 的包是几 KB 到几十 KB，4MB 是留足了余量的"明显不是 Dota"。
/// 没有上限的话，一个本机连接报个巨大的 Content-Length 就能让我们把它整个读进内存
const MAX_BODY: usize = 4 * 1024 * 1024;

/// 这一包带的 auth.token 对不对。
///
/// **认的是"别的东西误发到 53000"，不是防攻击**：token 写在开源的配置文件里，本机进程谁都读得到。
/// 能挡住的是别的 GSI 工具抄了我们的端口、或者调试时随手 POST 过来的东西。
///
/// **没带 auth 段的放行**（只记一次 Warn）：升级到带 token 的版本时 ensure_cfg 会重写配置文件，
/// 但 Dota 只在启动时读 GSI 配置——游戏开着的时候升级，这一局 Dota 一直按旧配置发，
/// 不放行的话覆盖层整局一片空白。带了 auth 但 token 不对的才丢。
enum Auth { Ok, Missing, Wrong }

fn check_auth(v: &serde_json::Value) -> Auth {
    match v.get("auth") {
        None => Auth::Missing,
        Some(a) if a.get("token").and_then(|t| t.as_str()) == Some(crate::gsicfg::AUTH_TOKEN) => Auth::Ok,
        Some(_) => Auth::Wrong,
    }
}

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
        let (mut warned_missing, mut wrong) = (false, 0u32);
        for mut req in server.incoming_requests() {
            // 先看声明的长度，超了直接拒，一个字节都不读；读的时候再用 take 限一道——
            // 没声明长度（chunked）或者声明了小的却发了大的，都不会读超
            if req.body_length().is_some_and(|n| n > MAX_BODY) {
                logf!(Level::Warn, "[gsi] 丢弃一个 {} 字节的请求（上限 {MAX_BODY}）", req.body_length().unwrap_or(0));
                let _ = req.respond(tiny_http::Response::from_string("too large").with_status_code(413));
                continue;
            }
            let mut body = String::new();
            let _ = req.as_reader().take(MAX_BODY as u64 + 1).read_to_string(&mut body);
            let _ = req.respond(tiny_http::Response::from_string("ok"));
            if body.len() > MAX_BODY {
                logf!(Level::Warn, "[gsi] 丢弃一个超过 {MAX_BODY} 字节的请求");
                continue;
            }
            // 这里**不再**轮询录制开关。原先是 `n % 100 == 0` 时调一次 refresh，
            // 于是开关只在 Dota 推包时才生效——没开游戏就完全失灵。
            // 现在 set_settings 直接通知录制器，见 record.rs 顶部的注释。
            match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(mut v) => {
                    match check_auth(&v) {
                        Auth::Ok => {}
                        Auth::Missing => {
                            if !warned_missing {
                                warned_missing = true;
                                logf!(Level::Warn, "[gsi] 包里没有 auth 段：Dota 还在用旧的 GSI 配置，重启 Dota 后生效（先照收）");
                            }
                        }
                        Auth::Wrong => {
                            // 只记第 1 包和之后每 100 包一条：误发的东西往往是连着来的，别把日志刷满
                            if wrong % 100 == 0 {
                                logf!(Level::Warn, "[gsi] auth.token 不对，丢弃（第 {} 包）", wrong + 1);
                            }
                            wrong += 1;
                            continue;
                        }
                    }
                    // token 认完就拿掉：录制和前端都用不着它
                    if let Some(o) = v.as_object_mut() {
                        o.remove("auth");
                    }
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
