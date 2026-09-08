#!/usr/bin/env python3
"""从图标的几何定义生成整套图标（PNG + ICO + ICNS）。

本机没有 Pillow / cairosvg / ImageMagick，所以这里自带一个极小的光栅化器：
形状全是可解析判定的（多边形、圆角矩形、带缺口的圆环），4×4 超采样抗锯齿，
PNG 用 zlib 手写。装了图形库反而要多一层依赖，而这套形状简单到不值当。

改图标就改下面的常量，然后 `python tools/make_icons.py`。
"""
import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

# ── 几何（都在 24×24 的设计画布里，与设计稿的 viewBox 一致）──
# 粗边方块。挖空处直接透明，托盘里露出的就是任务栏本身。
# 比 Dota 那个锈红提了两档亮度：去掉底板之后，原来的 #A6392A 贴在深色任务栏上
# 明显发闷（16px 尤其），而浅色任务栏上本来就够。同一个色相，只动明度。
RUST = (0xC2, 0x4A, 0x34)

# 粗边方块的顶点。毛边是一次性生成后**定死**的：每次重新随机，
# 图标就会在每次构建时悄悄变样，而图标必须是稳定的身份。
SQUARE = [(2,2.165),(6,1.659),(10,2.072),(14,2.828),(18,2.293),(22.05,2),
          (22.629,6),(22.706,10),(21.277,14),(22.846,18),(22,21.506),
          (18,21.479),(14,22.838),(10,21.25),(6,21.803),(1.201,22),
          (1.272,18),(2.295,14),(2.721,10),(2.526,6)]

# 挖空的开口环：圆心 (12,12)，外径 6.8 内径 3.8，右下留 60° 缺口。
# 角度按屏幕坐标 atan2(y-cy, x-cx)：上 = -90°，右 = 0°，下 = 90°。
# 缺口正对 45°，中轴线因此就是左上—右下那根对角线，和 Dota 那个标里
# 那道白色斜刃同向。之前中心落在 67.5°，偏下了 22.5°，轴线是歪的。
# 宽度 60°：再窄，16px 下那道缝会被抗锯齿抹平，环退化成一个实心甜甜圈。
RING = dict(cx=12.0, cy=12.0, r_out=6.8, r_in=3.8, gap=(15.0, 75.0))

SS = 4                          # 每像素 4×4 超采样


def in_poly(x, y, pts):
    inside = False
    n = len(pts)
    for i in range(n):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            if x < x1 + (y - y1) / (y2 - y1) * (x2 - x1):
                inside = not inside
    return inside


def in_ring(x, y):
    dx, dy = x - RING["cx"], y - RING["cy"]
    d = math.hypot(dx, dy)
    if not (RING["r_in"] <= d <= RING["r_out"]):
        return False
    a = math.degrees(math.atan2(dy, dx))
    lo, hi = RING["gap"]
    return not (lo <= a <= hi)          # 缺口那一段不算环上


def render(size):
    """返回 RGBA 字节。只有方块本身不透明，环挖穿到底。"""
    scale = 24.0 / size
    px = bytearray()
    for py in range(size):
        for pxi in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    # 采样点取子像素中心
                    ux = (pxi + (sx + 0.5) / SS) * scale
                    uy = (py + (sy + 0.5) / SS) * scale
                    if not in_poly(ux, uy, SQUARE) or in_ring(ux, uy):
                        continue
                    r += RUST[0]; g += RUST[1]; b += RUST[2]; a += 255.0
            n = SS * SS
            if a == 0:
                px += b"\x00\x00\x00\x00"
            else:
                # 颜色按覆盖到的子样本平均，透明度按覆盖率——不这么分开算，
                # 边缘会被背景色（黑）拉暗，出现一圈脏边
                k = a / 255.0
                px += bytes((round(r / k), round(g / k), round(b / k), round(a / n)))
    return bytes(px)


def png(size, rgba):
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def dib(size, rgba):
    """ICO 里的传统位图条目：BITMAPINFOHEADER + 自下而上的 BGRA + AND 掩码。

    **256 以下必须用它，不能用 PNG。** PNG 压缩的图标条目微软只保证 256×256
    这一档；更小的尺寸，资源管理器在有些路径上认不出来，于是回退到别的条目或
    干脆用缓存里的旧图——表现就是"exe 图标换不掉"，看着像缓存问题。
    """
    hdr = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytearray()
    for y in range(size - 1, -1, -1):                 # 位图自下而上存
        for x in range(size):
            r, g, b, a = rgba[(y * size + x) * 4:(y * size + x) * 4 + 4]
            xor += bytes((b, g, r, a))                # BGRA，非预乘
    # AND 掩码：32 位图靠 alpha 决定透明，掩码全 0 即可，但**必须在**，
    # 且每行按 4 字节对齐，否则整张图会错位
    stride = ((size + 31) // 32) * 4
    return bytes(hdr) + bytes(xor) + bytes(stride * size)


def ico(entries):
    """entries: [(size, data)]，data 已经是该条目在 ICO 里的原始字节。"""
    head = struct.pack("<HHH", 0, 1, len(entries))
    off = len(head) + 16 * len(entries)
    table, blobs = b"", b""
    for size, data in entries:
        table += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), off)
        blobs += data
        off += len(data)
    return head + table + blobs


def icns(entries):
    body = b"".join(t + struct.pack(">I", 8 + len(d)) + d for t, d in entries)
    return b"icns" + struct.pack(">I", 8 + len(body)) + body


NAMED = {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128,
    "128x128@2x.png": 256, "icon.png": 512, "StoreLogo.png": 50,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
ICNS = [(b"ic11", 32), (b"ic12", 64), (b"ic07", 128), (b"ic13", 256), (b"ic14", 512)]

if __name__ == "__main__":
    raw, cache = {}, {}
    def pixels(s):
        if s not in raw:
            raw[s] = render(s)
        return raw[s]
    def get(s):
        if s not in cache:
            cache[s] = png(s, pixels(s))
        return cache[s]

    for name, s in sorted(NAMED.items(), key=lambda kv: kv[1]):
        open(os.path.join(OUT, name), "wb").write(get(s))
        print(f"{name:<24} {s}px")
    # 256 用 PNG（那一档就是为它设计的，也省体积），其余全用 DIB
    entries = [(s, get(s) if s >= 256 else dib(s, pixels(s))) for s in ICO_SIZES]
    open(os.path.join(OUT, "icon.ico"), "wb").write(ico(entries))
    print(f"{'icon.ico':<24} {ICO_SIZES}  (<256 用 DIB，256 用 PNG)")
    open(os.path.join(OUT, "icon.icns"), "wb").write(icns([(t, get(s)) for t, s in ICNS]))
    print(f"{'icon.icns':<24} {[s for _, s in ICNS]}")
