//! 一键更新（v1.4.0）。
//!
//! 「检查更新」（前端 `update.js`，查 GitHub 的 tag）照旧负责**发现**新版本；这里负责**装**：
//! Tauri 的 updater 插件读 Release 里的 `latest.json`，下载安装包、验签、静默安装，装完程序自己重启。
//!
//! **只对安装版生效。** 插件装的是 nsis 安装包，装到安装目录；用 zip 绿色版的人点了，
//! 结果是电脑上多一份安装版、手上那份 exe 还是旧的。所以先看 exe 旁边有没有 nsis 留下的
//! `uninstall.exe`：没有就当绿色版，前端只给「打开下载页」。
//!
//! 托盘的「有新版本」一项也在这里：前端查到新版本后把版本号告诉 Rust（`set_update_available`），
//! 托盘菜单重建时多一项，点了打开设置卡片——更新按钮在卡片的版本那一行。

use std::sync::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::log::Level;
use crate::logf;

/// 前端查到的新版本号。托盘菜单据此多一项
static AVAILABLE: Mutex<Option<String>> = Mutex::new(None);

pub fn available() -> Option<String> {
    AVAILABLE.lock().unwrap().clone()
}

/// 是不是 nsis 装出来的：安装目录里有 nsis 写的 `uninstall.exe`
#[tauri::command]
pub fn app_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe").is_file()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_update_available(app: AppHandle, version: Option<String>) {
    let changed = *AVAILABLE.lock().unwrap() != version;
    *AVAILABLE.lock().unwrap() = version;
    if changed {
        crate::tray::apply_lang(&app);   // 菜单整个重建，见 tray.rs
    }
}

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// 下载并安装。成功的话 Windows 上安装器一跑起来程序就退出了，这个函数不会正常返回；
/// 返回了就是失败或没有可装的更新，错误原样给前端显示。
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    if !app_installed() {
        return Err("portable".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| {
        logf!(Level::Warn, "[update] 读 latest.json 失败: {e}");
        e.to_string()
    })?;
    let Some(update) = update else {
        return Err("none".into());
    };
    logf!(Level::Info, "[update] 开始下载 {}", update.version);
    let mut downloaded: u64 = 0;
    let app2 = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app2.emit("update-progress", Progress { downloaded, total });
            },
            || logf!(Level::Info, "[update] 下载完成，开始安装"),
        )
        .await
        .map_err(|e| {
            logf!(Level::Error, "[update] 安装失败: {e}");
            e.to_string()
        })?;
    // Windows 上安装器启动时程序已经被结束；走到这里说明是别的平台，重启一下
    app.restart();
}
