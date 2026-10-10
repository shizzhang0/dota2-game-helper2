#!/usr/bin/env python3
"""生成 README 里设置卡片的截图。**确定性的**——同样的输入永远出同样的图。

    python tools/make_shots.py            # 中英两张都重新生成到 docs/images/
    python tools/make_shots.py card-zh    # 只重做其中一张

做法：把 `ui/` + `constants/` + 一段 demo 数据组装成 Pages 那样的目录，起一个本地
静态服务，用 headless Edge/Chrome 截。**跑的是真程序**——同一份 `ui/js`、同一张卡片。

**v1.4.0 起只截卡片。** 覆盖层的其余部分贴着 Dota 自己的界面画（顶栏、小地图、计时牌），
离了游戏画面截出来就是几个飘在空中的圆，看不出它贴在哪儿。那几张图用的是真实的游戏截图
（docs/images/overlay.png 等），来历见 design/overlay.md「截图」。

卡片的大小**每次实测**：先开一个大视口让页面把卡片的宽高报回来，再按这个尺寸截。
卡片高度随语言、随内容变（v1.3.x 写死过 329×316，改一次卡片就得重量一次）。
"""
import argparse, http.server, json, os, shutil, socketserver, subprocess, sys, threading, time, urllib.parse
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

MARGIN = 16
CLOCK = 120          # 数据切到第几秒。卡片不看数据，只要覆盖层正常跑起来

# **卡片是界面上唯一有文字的地方**，所以出两套：
# `card.png` 英文给 README.md（GitHub 的默认入口，所以用不带后缀的名字），
# `card-zh.png` 中文给 README.zh-CN.md。
SHOTS = {"card": "en", "card-zh": "zh-CN"}

SHOT_HTML = """<!doctype html>
<meta charset="utf-8"><title>shot</title>
<link rel="stylesheet" href="ui/css/overlay.css">
<style>
  /* 卡片是半透明的深色玻璃，背后给一块暗色，和游戏里看到的接近 */
  body { margin:0; min-height:100vh; background:linear-gradient(135deg,#0b1410,#132018 60%,#0a0f0c); }
  /* main.js 会往 #hud 里写 clock，截图时要藏起来 */
  #hud { position:fixed; left:-9999px; }
</style>
<body class="dev">
<div id="panel"></div><div id="editor" hidden></div><div id="hud"></div>
<script>
  const qs = new URLSearchParams(location.search);
  // 只指定语言，其余全按默认值——截出来就是新装好打开时的样子
  localStorage.setItem("settings", JSON.stringify({ lang: qs.get("lang") || "en" }));
  window.HELPER2_DEMO = "demo.jsonl";
  window.HELPER2_FREEZE = true;
</script>
<script type="module" src="ui/js/main.js"></script>
<script>
  addEventListener("load", () => setTimeout(() => {
    // 走开发页的 e 键进编辑态——和真人按热键是同一条路
    dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
    setTimeout(() => {
      document.getElementById("panel").style.display = "none";
      const card = document.querySelector(".editor");
      card.style.cssText = "left:16px; top:16px; transform:none;";
      // 浏览器里没有程序版本、也读不到 Dota 的设置，这两处会写成 "dev" 和"没读到"。
      // 换成正式版里的样子：版本号取自 tauri.conf.json，小地图按最常见的左下 · 普通
      card.querySelector("#edAppVer").textContent = qs.get("ver");
      card.querySelector("#edMmSrc").textContent = qs.get("mm");
      card.querySelector("#edUpd").disabled = false;     // 浏览器里没有更新可查，按钮是灰的
      if (qs.get("measure"))
        fetch("/report", { method: "POST", body: card.offsetWidth + "," + card.offsetHeight });
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
        # Edge 的启动器可能先返回（见 shoot），等页面把视口报回来再关服务器
        for _ in range(40):
            if "viewport" in REPORT:
                break
            time.sleep(0.25)
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
    # **Edge 154 的启动器会立刻返回**（实测 0.1 秒），截图由后台进程过一两秒才写出来。
    # 原先返回就查文件，于是一张都截不到、还把旧图删了。等它出现且大小不再变。
    last = -1
    for _ in range(120):
        size = dest.stat().st_size if dest.exists() else -1
        if size > 0 and size == last:
            break
        last = size
        time.sleep(0.5)
    if dest.exists():
        crop(dest, w, h)
    return dest.exists()


def measure(browser, url, dx, dy):
    """开一个足够大的视口，让页面把卡片的宽高报回来"""
    REPORT.pop("viewport", None)
    subprocess.run([browser, "--headless=new", "--disable-gpu", f"--window-size={800 + dx},{1000 + dy}",
                    "--virtual-time-budget=20000", url + "&measure=1"],
                   capture_output=True, timeout=180)
    for _ in range(80):
        if "viewport" in REPORT:
            break
        time.sleep(0.25)
    try:
        return tuple(int(x) for x in REPORT["viewport"].split(","))
    except Exception:
        return None


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
    n = build_site(work, CLOCK)
    ver = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))["version"]
    ok = 0
    httpd = serve(work)
    try:
        for name in names:
            lang = SHOTS[name]
            t = json.loads((ROOT / "constants" / f"lang.{lang}.json").read_text(encoding="utf-8"))
            q = urllib.parse.urlencode({"lang": lang, "ver": ver,
                                        "mm": f"{t['card.mmPosLeft']} · {t['card.mmSizeNormal']}"})
            url = f"http://127.0.0.1:{PORT}/shot.html?{q}&speed=10000&loop=0"
            size = measure(browser, url, dx, dy)
            if not size:
                print(f"失败 {name:8} 量不出卡片尺寸")
                continue
            w, h = size[0] + MARGIN * 2, size[1] + MARGIN * 2
            dest = OUT / f"{name}.png"
            got = shoot(browser, url, dest, w, h, dx, dy)
            print(f"{'OK ' if got else '失败'} {name:8} {w}x{h}  切片 {n} 包  "
                  f"{dest.stat().st_size if got else 0} 字节")
            ok += bool(got)
    finally:
        httpd.shutdown()
        httpd.server_close()
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{ok}/{len(names)} 张，输出在 {OUT}")


if __name__ == "__main__":
    main()
