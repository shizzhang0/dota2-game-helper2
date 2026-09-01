use std::fs;
use std::path::PathBuf;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

const CFG_NAME: &str = "gamestate_integration_helper2.cfg";
const CFG: &str = r#""dota2-game-helper2"
{
  "uri" "http://127.0.0.1:53000/"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.1"
  "heartbeat" "30.0"
  "data"
  {
    "provider" "1"
    "map" "1"
    "player" "1"
    "hero" "1"
    "abilities" "1"
    "items" "1"
    "events" "1"
    "minimap" "1"
  }
}
"#;

fn steam_path() -> Option<PathBuf> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .ok()?;
    let p: String = key.get_value("SteamPath").ok()?;
    Some(PathBuf::from(p.replace('/', "\\")))
}

/// Steam 可能装多个库，Dota 不一定在主库里，逐个找。
fn libraries(steam: &PathBuf) -> Vec<PathBuf> {
    let mut out = vec![steam.clone()];
    let vdf = steam.join("steamapps").join("libraryfolders.vdf");
    if let Ok(s) = fs::read_to_string(&vdf) {
        for line in s.lines() {
            let t = line.trim();
            if t.starts_with("\"path\"") {
                if let Some(v) = t.split('"').nth(3) {
                    out.push(PathBuf::from(v.replace("\\\\", "\\")));
                }
            }
        }
    }
    out
}

/// 首次运行把 GSI 配置写进 Dota 的 cfg 目录。找不到就只提示，不当作错误
/// （用户可以手动放，程序其余部分照常工作）。
pub fn ensure_cfg() {
    let Some(steam) = steam_path() else {
        eprintln!("[gsicfg] 注册表里没找到 Steam，请手动放置 {CFG_NAME}");
        return;
    };
    for lib in libraries(&steam) {
        let cfg_dir = lib
            .join("steamapps")
            .join("common")
            .join("dota 2 beta")
            .join("game")
            .join("dota")
            .join("cfg");
        if !cfg_dir.is_dir() {
            continue;
        }
        let dir = cfg_dir.join("gamestate_integration");
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("[gsicfg] 建目录失败: {e}");
            return;
        }
        let file = dir.join(CFG_NAME);
        if fs::read_to_string(&file).map(|s| s == CFG).unwrap_or(false) {
            println!("[gsicfg] 配置已是最新: {}", file.display());
            return;
        }
        match fs::write(&file, CFG) {
            Ok(()) => println!("[gsicfg] 已写入 {}", file.display()),
            Err(e) => eprintln!("[gsicfg] 写入失败: {e}"),
        }
        return;
    }
    eprintln!("[gsicfg] 未找到 Dota 2 安装目录，请手动放置 {CFG_NAME}");
}
