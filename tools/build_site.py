#!/usr/bin/env python3
"""把 GitHub Pages 要发的东西组装到 dist/。

    python tools/build_site.py            # 组装
    python tools/build_site.py --serve    # 组装完顺便起个本地服务看看

**CI 和本地跑的是同一个脚本**，所以本地看到的就是线上会发的。
把这段逻辑写进 workflow 的 YAML 里就没法本地验了。

布局（页面在根，`ui/` 与 `constants/` 与它平级）：

    dist/
      index.html      site/ 来的落地页
      demo.html       site/ 来的 iframe 内容（真覆盖层）
      demo.jsonl      site/ 来的回放数据（已脱敏裁剪，见 make_demo.py）
      icon.png        src-tauri/icons/ 来的
      ui/             **原样拷贝，不改一个字**
      constants/      同上
      docs/images/    首页那几张截图

> **`ui/` 是拷贝而不是另写一份。** demo 全部的意义就在于跑的是真程序；
> 站点目录里放一份"给网页用的 ui" 迟早会和正式版脱节。
>
> 反过来也成立：**demo 数据不能放进 `ui/`**——`tauri.conf.json` 的 frontendDist
> 指着 `../ui`，整个目录会编译期嵌进 exe，每个用户都会背着这几 MB。
"""
import argparse, http.server, shutil, socketserver, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
PORT = 8077

# 首页引用到的截图。只拷用得上的，不把整个 docs/ 发出去——
# docs/design/ 是中文开发笔记，不是给访客看的。
SITE_IMAGES = ["block-timers.png", "block-enemy.png", "block-wardmap.png"]


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    DIST.mkdir(parents=True)

    for name in ("index.html", "demo.html", "demo.jsonl"):
        src = ROOT / "site" / name
        if not src.is_file():
            sys.exit(f"缺 {src}——demo.jsonl 由 tools/make_demo.py 生成")
        shutil.copy2(src, DIST / name)

    shutil.copytree(ROOT / "ui", DIST / "ui")
    shutil.copytree(ROOT / "constants", DIST / "constants")
    shutil.copy2(ROOT / "src-tauri" / "icons" / "icon.png", DIST / "icon.png")

    imgs = DIST / "docs" / "images"
    imgs.mkdir(parents=True)
    for n in SITE_IMAGES:
        shutil.copy2(ROOT / "docs" / "images" / n, imgs / n)

    total = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file())
    n = sum(1 for f in DIST.rglob("*") if f.is_file())
    print(f"dist/  {n} 个文件  {total / 1e6:.2f} MB")
    for f in sorted(DIST.rglob("*")):
        if f.is_file() and f.stat().st_size > 200_000:
            print(f"  大文件 {f.relative_to(DIST).as_posix():28} {f.stat().st_size / 1e6:.2f} MB")
    return DIST


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true", help="组装完起个本地服务")
    a = ap.parse_args()
    build()
    if not a.serve:
        return

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=str(DIST), **kw)

        def log_message(self, *a):
            pass

    print(f"http://127.0.0.1:{PORT}/  （Ctrl+C 停）")
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H) as httpd:
        httpd.serve_forever()


if __name__ == "__main__":
    main()
