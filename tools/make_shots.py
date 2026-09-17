#!/usr/bin/env python3
"""生成 README / 站点用的截图。**确定性的**——同样的输入永远出同样的图。

    python tools/make_shots.py            # 全部重新生成到 docs/images/
    python tools/make_shots.py wardmap    # 只重做其中一张

做法：把 `ui/` + `constants/` + 一段 demo 数据组装成 Pages 那样的目录，起一个本地
静态服务，用 headless Edge/Chrome 逐张截。**跑的是真程序**——同一份 `ui/js`、
同一条渲染管线、真实录制的数据，不是摆拍也不是设计稿。

为什么不靠"跑到某一刻再冻结"：headless 的虚拟时间和真实网络对不齐，实测会截到
空白。改成**每张图配一段截止到那一刻的数据切片**，用极高倍速播完（`loop=0`），
页面自然停在最后一包上——没有时序，也就没有不确定性。

历史上编辑态那张一直截不出来（卡片比可用窗口高，`PrintWindow` 只渲染屏上部分）。
这条路绕开了那个坑：headless 不走 PrintWindow，而且页签把卡片压到了 316px。
"""
import argparse, http.server, json, os, shutil, socketserver, subprocess, sys, threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "images"
PORT = 8033

BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# 每张图：文件名 -> (只显示哪个块, 截到第几秒, 视口宽, 视口高, 卡片停在第几页)
# `panel` = 四个块都要；`card` = 编辑态卡片。
#
# **clock 挑的是"那一块真的有东西可看"的时刻。** 地图那两张必须挑有敌方眼的——
# 自视角下敌方眼只在真视罩到时才看得见，这份录制里只有 53 秒有，451 是最后一个
# 且那时净资产已经上来了。
#
# 视口按内容裁：块的尺寸见 design/overlay.md 的「四个可独立摆位的块」，
# 四周各留 16px。
MARGIN = 16
CARD_W, CARD_H = 329, 316          # 实测，见 design/overlay.md「四页页签」
BLOCK = {"timers": (350, 85), "enemy": (196, 85), "econ": (142, 70), "wardmap": (214, 213)}


def _block_shot(name, clock):
    w, h = BLOCK[name]
    return dict(block=name, clock=clock, w=w + MARGIN * 2, h=h + MARGIN * 2)


def _card_shot(tab, lang, clock=120):
    # 英文卡片比中文略矮（实测 310 vs 316），统一按中文那档给，多出来的是背景
    return dict(block="card", clock=clock, w=CARD_W + MARGIN * 2, h=CARD_H + MARGIN * 2,
                tab=tab, lang=lang)


# **卡片是界面上唯一有文字的地方**，所以只有它需要出两套：
# `card-*.png` 英文给 README.md，`card-*-zh.png` 中文给 README.zh-CN.md。
# 另外五张（整体 + 四个块）一个字都没有，与语言无关，不必重复。
#
# 英文那套用不带后缀的名字，因为 README.md 是 GitHub 的默认入口。
CARD_TABS = ["show", "panel", "legend", "dev"]

SHOTS = {
    "overlay":       dict(block="panel", clock=451, w=620, h=330),
    "block-timers":  _block_shot("timers", 451),
    "block-enemy":   _block_shot("enemy", 451),
    "block-econ":    _block_shot("econ", 451),
    "block-wardmap": _block_shot("wardmap", 451),
}
for _tab in CARD_TABS:
    SHOTS[f"card-{_tab}"] = _card_shot(_tab, "en")
    SHOTS[f"card-{_tab}-zh"] = _card_shot(_tab, "zh-CN")

SHOT_HTML = """<!doctype html>
<meta charset="utf-8"><title>shot</title>
<link rel="stylesheet" href="ui/css/overlay.css">
<style>
  /* 和 README 主图同一种占位色（dev.html 里第 5 种：夜间野区近似） */
  body { margin:0; min-height:100vh; background:linear-gradient(135deg,#0b1410,#132018 60%,#0a0f0c); }
  /* main.js 会往 #hud 里写 clock，截图时要藏起来 */
  #hud { position:fixed; left:-9999px; }
</style>
<body class="dev">
<div id="panel"></div><div id="editor" hidden></div><div id="hud"></div>
<script>
  // **必须在 main.js 之前写好 localStorage。** 块的位置每帧由 render() 重新套用，
  // 事后改 inline style 会被立刻覆盖；而浏览器分支的摆位与设置本来就从这里读。
  const qs = new URLSearchParams(location.search);
  const want = qs.get("block") || "panel";

  // 整体图**明确摆位**，不用默认摆位：默认是按真实屏幕比例算的（y = 屏高 × 7.5%
  // 之类），塞进截图尺寸的小视口里四个块会互相压住——实测净资产块正好盖住地图
  // 左上角，而敌方眼就在那儿。摆法仍是设计里那一套：左列 净资产 / 眼位，
  // 右列 倒计时 / 敌方。单块特写则一律摆到左上角。
  const PANEL_AT = { econ: [16, 16], wardmap: [16, 96], timers: [250, 16], enemy: [250, 111] };
  const at = (id) => (want === "panel" ? PANEL_AT[id] : [16, 16]);
  const layout = {};
  for (const id of ["timers", "enemy", "econ", "wardmap"]) {
    const [x, y] = at(id);
    layout[id] = { x, y };
  }
  localStorage.setItem("layout", JSON.stringify(layout));
  // 设置也钉死，免得图随环境变
  localStorage.setItem("settings", JSON.stringify({
    scale: 1, opacity: 1, panelBg: 0.72, wardSize: 180,
    lang: qs.get("lang") || "en",
  }));
  window.HELPER2_DEMO = "demo.jsonl";
</script>
<script type="module" src="ui/js/main.js"></script>
<script>
  const tab = qs.get("tab");
  addEventListener("load", () => setTimeout(() => {
    dispatchEvent(new KeyboardEvent("keydown", { key: "v" }));   // 常显
    setTimeout(() => {
      if (want === "card") {
        document.getElementById("panel").style.display = "none";
        const card = document.querySelector(".editor");
        card.hidden = false;
        card.style.cssText = "left:16px; top:16px; transform:none;";
        if (tab) card.querySelector(`.ed-tab[data-tab="${tab}"]`)?.click();
        return;
      }
      // 单块特写：其余三块整个藏掉。位置已经由 localStorage 定好了。
      if (want === "panel") return;
      for (const b of document.querySelectorAll(".block"))
        if (b.dataset.block !== want) b.style.display = "none";
    }, 400);
  }, 200));
</script>
"""


def find_browser():
    for p in BROWSERS:
        if Path(p).is_file():
            return p
    sys.exit("找不到 Edge 或 Chrome，headless 截图需要其中之一")


def build_site(work, clock):
    """按 Pages 的布局组装：页面在根目录，ui/ 与 constants/ 与它平级。"""
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    shutil.copytree(ROOT / "ui", work / "ui")
    shutil.copytree(ROOT / "constants", work / "constants")
    (work / "shot.html").write_text(SHOT_HTML, encoding="utf-8")
    # 每张图配一段"截止到那一刻"的切片：播完即停，页面自然停在最后一包上
    src = ROOT / "site" / "demo.jsonl"
    out = work / "demo.jsonl"
    n = 0
    with open(src, encoding="utf-8") as f, open(out, "w", encoding="utf-8", newline="\n") as g:
        for line in f:
            if not line.strip():
                continue
            if (json.loads(line).get("map") or {}).get("clock_time", 0) > clock:
                break
            g.write(line)
            n += 1
    return n


REPORT = {}

PROBE_HTML = """<!doctype html><meta charset="utf-8"><body>
<script>
  fetch("/report", { method: "POST", body: innerWidth + "," + innerHeight });
</script>
"""


def serve(work):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(work), **k)

        def do_POST(self):
            n = int(self.headers.get("Content-Length", 0))
            REPORT["viewport"] = self.rfile.read(n).decode()
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def chrome_offset(browser, work):
    """`--window-size` 给的是**窗口**尺寸，页面拿到的视口比它小一圈
    （实测 Edge headless=new 是 30×95，但这数字会随浏览器和版本变）。

    块的摆位会被 `clamp()` 钳进视口，视口比预期矮就会把下面那块往上顶——
    实测地图被顶到净资产块底下去了。所以这里**实测一次偏移**，而不是写死魔数。 """
    (work / "probe.html").write_text(PROBE_HTML, encoding="utf-8")
    REPORT.pop("viewport", None)
    httpd = serve(work)
    try:
        subprocess.run([browser, "--headless=new", "--disable-gpu", "--window-size=800,600",
                        "--virtual-time-budget=4000", f"http://127.0.0.1:{PORT}/probe.html"],
                       capture_output=True, timeout=60)
    finally:
        httpd.shutdown()
        httpd.server_close()
    try:
        w, h = (int(x) for x in REPORT["viewport"].split(","))
    except Exception:
        print("量不出视口偏移，按 0 处理（图可能被钳歪）")
        return 0, 0
    return 800 - w, 600 - h


CROP_PS = """
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('{path}')
$w = [Math]::Min({w}, $src.Width); $h = [Math]::Min({h}, $src.Height)
$dst = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,$w,$h),
             (New-Object System.Drawing.Rectangle 0,0,$w,$h), 'Pixel')
$g.Dispose(); $src.Dispose()
$dst.Save('{path}', [System.Drawing.Imaging.ImageFormat]::Png); $dst.Dispose()
"""


def crop(path, w, h):
    """把图裁到左上角 w×h。

    **截图出来永远是窗口尺寸，而页面视口比它小一圈**（实测 30×95）。
    想让视口是 w×h 就得把窗口开到 w+30 × h+95，于是图上多出一圈背景色的边。
    这里裁掉——内容本来就锚在左上角。"""
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    CROP_PS.format(path=str(path).replace("\\", "\\\\"), w=w, h=h)],
                   capture_output=True, timeout=60)


def shoot(browser, url, dest, w, h, dx, dy):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    subprocess.run(
        [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--screenshot={dest}", f"--window-size={w + dx},{h + dy}",
         "--virtual-time-budget=20000", url],
        capture_output=True, timeout=180)
    if dest.exists():
        crop(dest, w, h)
    return dest.exists()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("only", nargs="*", help="只做这几张（默认全部）")
    a = ap.parse_args()
    names = a.only or list(SHOTS)
    bad = [n for n in names if n not in SHOTS]
    if bad:
        sys.exit(f"没有这几张图: {bad}；可选: {list(SHOTS)}")

    browser = find_browser()
    work = Path(os.environ.get("TEMP", "/tmp")) / "helper2-shots"
    build_site(work, 0)                       # 先搭个壳，量视口偏移要用
    dx, dy = chrome_offset(browser, work)
    print(f"headless 窗口比视口大 {dx}x{dy}，下面的尺寸都按视口给")
    print()
    ok = 0
    for name in names:
        spec = SHOTS[name]
        n = build_site(work, spec["clock"])
        httpd = serve(work)
        try:
            q = f"?block={spec['block']}" + (f"&tab={spec['tab']}" if spec.get("tab") else "")
            q += f"&lang={spec['lang']}" if spec.get("lang") else ""
            # 极高倍速 + 不循环：几百毫秒内播完，页面停在最后一包
            q += "&speed=10000&loop=0"
            dest = OUT / f"{name}.png"
            got = shoot(browser, f"http://127.0.0.1:{PORT}/shot.html{q}", dest,
                        spec["w"], spec["h"], dx, dy)
            size = dest.stat().st_size if got else 0
            print(f"{'OK ' if got else '失败'} {name:15} {spec['w']}x{spec['h']}  "
                  f"切片 {n} 包 到 clock {spec['clock']}  {size} 字节")
            ok += bool(got)
        finally:
            httpd.shutdown()
            httpd.server_close()
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{ok}/{len(names)} 张，输出在 {OUT}")


if __name__ == "__main__":
    main()
