//! 本机 Dota 地图的指纹：`maps/dota.vpk` 里 `dota.trm`（树）和 `dota.gnv`（可走的格子）的 CRC32。
//!
//! 敌方眼的"照到了没出现就删"（ui/js/wardvision.js）按随程序发的地形高度和树判断看不看得见。
//! Valve 一改地图，旧数据就会把新树、新台阶挡住的地方当成看得见，删掉还活着的眼。
//! 前端拿这里给的 CRC 和 ui/data/map.bin 文件头里导出时记下的比，对不上就关掉那条规则。
//!
//! CRC 是 VPK 目录里每个文件自带的，**只读目录（几十 KB），不读文件内容**。
//! 和 tools/map_dump.py 的 map_crcs 读的是同一处，改了这里要同步那边。
//! 只读不写。读不到（没装在常见位置、Valve 换了格式）返回 null，前端当作对不上。

use std::fs::File;
use std::io::Read;
use std::path::Path;
use serde_json::{json, Value};
use crate::log::Level;
use crate::logf;

fn crcs(vpk: &Path) -> Result<(u32, u32), String> {
    let mut f = File::open(vpk).map_err(|e| e.to_string())?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    let u32_at = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let (sig, ver, tree_size) = (u32_at(&head, 0), u32_at(&head, 4), u32_at(&head, 8) as usize);
    if sig != 0x55AA_1234 || !(ver == 1 || ver == 2) {
        return Err(format!("不是认得的 VPK（magic {sig:#x}，版本 {ver}）"));
    }
    if ver == 2 {
        let mut skip = [0u8; 16];
        f.read_exact(&mut skip).map_err(|e| e.to_string())?;
    }
    // 目录不会大到哪去（现在 54 KB），给个上限防着读到坏文件
    if tree_size > 16 << 20 {
        return Err(format!("目录大小不对（{tree_size}）"));
    }
    let mut tree = vec![0u8; tree_size];
    f.read_exact(&mut tree).map_err(|e| e.to_string())?;

    let mut i = 0usize;
    let cstr = |i: &mut usize| -> Result<String, String> {
        let end = tree[*i..].iter().position(|&c| c == 0).ok_or("目录被截断")? + *i;
        let s = String::from_utf8_lossy(&tree[*i..end]).into_owned();
        *i = end + 1;
        Ok(s)
    };
    let (mut trm, mut gnv) = (None, None);
    // 目录是三层：扩展名 -> 路径 -> 文件名，每层以空串结束；每个文件后面 18 字节：
    // CRC32、preload 长度（u16）、archive（u16）、offset、length、0xFFFF，然后是 preload 数据
    loop {
        let ext = cstr(&mut i)?;
        if ext.is_empty() { break; }
        loop {
            let path = cstr(&mut i)?;
            if path.is_empty() { break; }
            loop {
                let name = cstr(&mut i)?;
                if name.is_empty() { break; }
                if i + 18 > tree.len() { return Err("目录被截断".into()); }
                let crc = u32_at(&tree, i);
                let preload = u16::from_le_bytes([tree[i + 4], tree[i + 5]]) as usize;
                i += 18 + preload;
                if path == "maps" && name == "dota" {
                    match ext.as_str() { "trm" => trm = Some(crc), "gnv" => gnv = Some(crc), _ => {} }
                }
            }
        }
    }
    match (trm, gnv) {
        (Some(a), Some(b)) => Ok((a, b)),
        _ => Err("目录里找不到 maps/dota.trm 或 maps/dota.gnv".into()),
    }
}

#[tauri::command]
pub fn map_crc() -> Value {
    let mut tried = Vec::new();
    for dir in crate::gsicfg::dota_dirs() {
        let vpk = dir.join("maps").join("dota.vpk");
        if !vpk.is_file() { tried.push(vpk.display().to_string()); continue; }
        return match crcs(&vpk) {
            Ok((trm, gnv)) => {
                logf!(Level::Info, "[mapcheck] {}：dota.trm {trm:#010x}，dota.gnv {gnv:#010x}", vpk.display());
                json!({ "trm": trm, "gnv": gnv })
            }
            Err(e) => {
                logf!(Level::Warn, "[mapcheck] 读 {} 失败：{e}", vpk.display());
                Value::Null
            }
        };
    }
    logf!(Level::Warn, "[mapcheck] 找不到 maps/dota.vpk，找过：{}", tried.join("；"));
    Value::Null
}
