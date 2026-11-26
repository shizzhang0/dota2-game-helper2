#!/usr/bin/env python3
"""导出当前地图的地面高度和树，给敌方眼位的视野模型做离线评估（见 docs/design/wards.md）。

游戏文件里树的位置能直接读（maps/dota.vpk 里的 dota.trm），地面高度读不出来（dota.vhcg 格式不明），
所以借 Dota 2 Workshop Tools：用正式地图跑一个自定义游戏，让游戏自己的 GetGroundHeight 逐格报高度。
Lua 那半在 tools/map_dump/addon/。

导出的结果打成 ui/data/map.bin 随程序发（"照到了没出现就删"要用，见 ui/js/wardvision.js）。
文件头里记着导出时本机 maps/dota.vpk 里 dota.trm（树）和 dota.gnv（可走的格子）的 CRC32：
程序启动时拿本机的比，对不上 = 地图改过了，这条规则自动关掉，等重新导出。

用法：
    python tools/map_dump.py install     # 把 addon 拷进 Dota 目录，打印接下来怎么跑
    （在 Workshop Tools 里跑完）
    python tools/map_dump.py parse       # 读 game/dota/console.log，写 devdata/map_dump.json、预览图和 ui/data/map.bin
    python tools/map_dump.py pack        # 只把 devdata/map_dump.json 重新打成 ui/data/map.bin
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
MAP_BIN = ROOT.parent / "ui" / "data" / "map.bin"
# 地图包里拿来认"地图改没改"的两份文件。树和可走的格子：改地形几乎总会改到这两样。
# dota.vhcg（格式不明，像是碰撞 / 高度）没用上：它和光照、装饰这些一起重编时会不会变说不准，不想白白关掉规则
MAP_FILES = ("trm", "gnv")


def map_crcs(dota):
    """maps/dota.vpk 目录里 dota.trm、dota.gnv 的 CRC32（VPK 目录里自带，不用读文件内容）。
    和 src-tauri/src/mapcheck.rs 读的是同一处，改了这里要同步那边"""
    p = dota / "maps" / "dota.vpk"
    with p.open("rb") as f:
        sig, ver, tree_size = struct.unpack("<III", f.read(12))
        if sig != 0x55AA1234 or ver not in (1, 2):
            sys.exit(f"{p} 不是认得的 VPK（magic {sig:#x}，版本 {ver}）")
        if ver == 2:
            f.read(16)
        tree = f.read(tree_size)
    out, i = {}, 0
    def cstr():
        nonlocal i
        j = tree.index(b"\0", i)
        v = tree[i:j].decode("utf-8", "replace")
        i = j + 1
        return v
    while (ext := cstr()):
        while (path := cstr()):
            while (name := cstr()):
                crc, preload = struct.unpack_from("<IH", tree, i)
                i += 18 + preload
                if path == "maps" and name == "dota" and ext in MAP_FILES:
                    out[ext] = crc
    missing = [e for e in MAP_FILES if e not in out]
    if missing:
        sys.exit(f"{p} 里找不到 maps/dota.{'、'.join(missing)}")
    return out


def pack(dota):
    """devdata/map_dump.json -> ui/data/map.bin。格式（小端）：
         0  "DMAP"   4  u16 版本 1   6  u16 格子边长
         8  i32 x0  12  i32 y0      16  u16 宽   18  u16 高
        20  u32 dota.trm 的 CRC32   24  u32 dota.gnv 的 CRC32   28  u32 树的棵数
        32  i16 高度 × 宽×高（逐行，y 从下往上）   然后 i16 x, y × 树的棵数
       读的一侧是 ui/js/wardvision.js 的 parseMap"""
    src = OUT_DIR / "map_dump.json"
    if not src.is_file():
        sys.exit(f"没有 {src}：先跑 install / parse")
    m = json.loads(src.read_text(encoding="utf-8"))
    crc = map_crcs(dota)
    trees = [(x, y) for x, y, _z, standing in m["trees"] if standing]
    buf = struct.pack("<4sHHiiHHIII", b"DMAP", 1, m["cell"], m["x0"], m["y0"], m["w"], m["h"],
                      crc["trm"], crc["gnv"], len(trees))
    buf += struct.pack(f"<{len(m['heights'])}h", *m["heights"])
    buf += struct.pack(f"<{2 * len(trees)}h", *(v for t in trees for v in t))
    MAP_BIN.parent.mkdir(exist_ok=True)
    MAP_BIN.write_bytes(buf)
    print(f"写了 {MAP_BIN}：{len(buf)} 字节，树 {len(trees)} 棵，dota.trm {crc['trm']:#010x}、dota.gnv {crc['gnv']:#010x}")


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
    pack(dota)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["install", "parse", "pack"])
    ap.add_argument("--dota", help="Dota 2 安装目录（默认自动找）")
    ap.add_argument("--log", help="parse 用：日志文件（默认 game/dota/console.log）")
    a = ap.parse_args()
    dota = find_dota(a.dota)
    if a.cmd == "install":
        install(dota)
    elif a.cmd == "parse":
        parse(dota, a.log)
    else:
        pack(dota)


if __name__ == "__main__":
    main()
