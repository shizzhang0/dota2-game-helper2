use std::path::Path;

/// 逐个文件声明，不能直接写 `cargo:rerun-if-changed=../ui`。
/// 实测那样写会让**每次** build 都重编整个 crate（一次 3 分半），
/// 比它要解决的问题更糟——目录形式 cargo 认不出来，只好当作永远是脏的。
fn watch(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            watch(&p);
        } else {
            println!("cargo:rerun-if-changed={}", p.display());
        }
    }
}

fn main() {
    // 前端是编译期嵌进二进制的（tauri.conf.json 的 frontendDist = "../ui"），
    // 但 cargo 默认不把那个目录当依赖：只改 ui/ 下的 JS/CSS 而不碰 Rust 时，
    // cargo 认为 crate 是新鲜的、直接跳过，跑出来的还是旧前端。
    // 声明之后改动即触发重编，不用再靠"先 touch 一下 main.rs"这种土办法。
    watch(Path::new("../ui"));
    tauri_build::build()
}
