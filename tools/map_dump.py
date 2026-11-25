#!/usr/bin/env python3
"""导出当前地图的地面高度和树，给敌方眼位的视野模型做离线评估（见 docs/design/wards.md）。

游戏文件里树的位置能直接读（maps/dota.vpk 里的 dota.trm），地面高度读不出来（dota.vhcg 格式不明），
所以借 Dota 2 Workshop Tools：用正式地图跑一个自定义游戏，让游戏自己的 GetGroundHeight 逐格报高度。
Lua 那半在 tools/map_dump/addon/。

用法：
    python tools/map_dump.py install     # 把 addon 拷进 Dota 目录，打印接下来怎么跑
    （在 Workshop Tools 里跑完）
    python tools/map_dump.py parse       # 读 game/dota/console.log，写 devdata/map_dump.json 和一张预览图
"""
import argparse
import json
import shutil
import struct
import sys
import zlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from sync_constants import find_dota  # noqa: E402

ADDON = "map_dump"
OUT_DIR = ROOT.parent / "devdata"


def install(dota):
    game = dota.parent                                   # .../dota 2 beta/game
    dst = game / "dota_addons" / ADDON
    # 覆盖拷贝、不先删：工具开着时会在 addon 目录里放自己的缓存（tools_thumbnail_cache.sqlite3），删不掉
    shutil.copytree(ROOT / "map_dump" / "addon", dst, dirs_exist_ok=True)
    # 工具的启动器按 content/dota_addons 列 addon，空目录就够
    (game.parent / "content" / "dota_addons" / ADDON).mkdir(parents=True, exist_ok=True)
    print(f"已拷到 {dst}")
    print("接下来：")
    exe = game / "bin" / "win64" / "dota2.exe"
    print(f"  1. 带 -condebug 启动工具（控制台才会写进 game/dota/console.log）：")
    print(f'       & "{exe}" -tools -condebug')
    print("     在 addon 列表里选 map_dump，点 Launch Tools")
    print("  2. 进去后打开控制台（vconsole2 或游戏里的 ~），输入：")
    print(f"       dota_launch_custom_game {ADDON} dota")
    print("  3. 等地图加载完、控制台出现 MAPDUMP END（大约一两分钟），退出工具")
    print("  4. python tools/map_dump.py parse")


def write_png(path, w, h, pixel):
    raw = bytearray()
    for y in range(h - 1, -1, -1):                       # 游戏 y 向上，图片 y 向下
        raw += b"\0" + b"".join(bytes(pixel(x, y)) for x in range(w))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def parse(dota, log):
    log = Path(log) if log else dota / "console.log"
    if not log.is_file():
        sys.exit(f"找不到 {log}：工具是带 -condebug 启动的吗？自定义游戏跑完了吗？")
    head, rows, trees, end = None, {}, [], None
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        i = line.find("MAPDUMP ")
        if i < 0:
            continue
        f = line[i + 8:].split()
        if f[0] == "BEGIN":
            head = dict(zip(["cell", "x0", "y0", "w", "h"], map(int, f[1:6])))
            rows, trees = {}, []                         # 跑过几次就以最后一次为准
        elif f[0] == "H":
            r, c0 = int(f[1]), int(f[2])
            row = rows.setdefault(r, {})
            for k, v in enumerate(f[3:]):
                row[c0 + k] = int(v)
        elif f[0] == "T":
            trees.append([int(v) for v in f[1:5]])
        elif f[0] == "END":
            end = int(f[1])
    if not head or end is None:
        sys.exit("日志里没有完整的一次导出（缺 BEGIN 或 END）")
    w, h = head["w"], head["h"]
    missing = sum(1 for r in range(h) for c in range(w) if c not in rows.get(r, {}))
    if missing:
        sys.exit(f"缺 {missing} 格高度：控制台可能截断了行，或者导出被打断")
    heights = [rows[r][c] for r in range(h) for c in range(w)]
    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / "map_dump.json"
    out.write_text(json.dumps({**head, "heights": heights, "trees": trees}), encoding="utf-8")
    print(f"写了 {out}：{w}×{h} 格，树 {len(trees)} 棵（END 报 {end}）")

    # 高度分布：Dota 的地形是一层层台地，看看有几层
    hist = {}
    for z in heights:
        hist[z // 64 * 64] = hist.get(z // 64 * 64, 0) + 1
    print("高度分布（按 64 分档）：" + "，".join(f"{k}~{k + 63}: {n}" for k, n in sorted(hist.items())))

    lo, hi = min(heights), max(heights)
    tree_cells = {((x - head["x0"]) // head["cell"], (y - head["y0"]) // head["cell"]) for x, y, _, s in trees if s}
    def pixel(x, y):
        if (x, y) in tree_cells:
            return (40, 160, 40)
        v = int(255 * (heights[y * w + x] - lo) / max(1, hi - lo))
        return (v, v, v)
    png = OUT_DIR / "map_dump.png"
    write_png(png, w, h, pixel)
    print(f"预览图 {png}（亮 = 高，绿 = 树）")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["install", "parse"])
    ap.add_argument("--dota", help="Dota 2 安装目录（默认自动找）")
    ap.add_argument("--log", help="parse 用：日志文件（默认 game/dota/console.log）")
    a = ap.parse_args()
    dota = find_dota(a.dota)
    install(dota) if a.cmd == "install" else parse(dota, a.log)


if __name__ == "__main__":
    main()
