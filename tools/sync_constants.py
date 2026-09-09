#!/usr/bin/env python3
"""跟随 Dota 版本更新常数表。数据源是**游戏本体自己的文件**，不联网。

做四件事：
1. 找到 Dota 安装目录，从 `pak01_dir.vpk` 里取出几份明文 KV
2. 重新生成 `constants/item_prices.json`，并打印它相对上一版的差异
3. 更新 `constants/patch.json` 的版本号
4. 筛出这一版更新日志里与我们建模的机制有关的条目，供人工判断要不要动计时表

为什么不用 OpenDota、为什么只在开发机上做：见 docs/design/networth.md 的「价格源」。
VPK 格式与踩过的坑：见 docs/design/dev-tools.md 的「常数同步」。

用法：
    python tools/sync_constants.py [--dota <安装目录>] [--dry-run]
"""
import argparse
import json
import os
import re
import struct
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONSTANTS = ROOT / "constants"

# VPK 里要取的几份文件
ITEMS = "scripts/npc/items.txt"
ABILITY_IDS = "scripts/npc/npc_ability_ids.txt"
PATCHNOTES = "resource/localization/patchnotes/patchnotes_english.txt"

# 更新日志里值得人工过一眼的关键词——**只覆盖我们真正建模的机制**。
# 命中了不一定要改，没命中基本就不用翻这一版日志了。
MECHANICS = re.compile(
    r"rune|roshan|aegis|cheese|tower|glyph|buyback|barracks|lotus|wisdom|bounty"
    r"|neutral|camp|courier|tormentor|outpost|shrine|respawn|ward",
    # 刻意不收 "stack"：技能层数、圣剑不叠加这类全会命中，而堆野相关的条目
    # 一定会提到 neutral 或 camp。噪声条目会让人下次懒得读这份清单。
    re.I,
)


def die(msg):
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------- 找 Dota

def steam_libraries():
    """Steam 的库目录。默认位置 + libraryfolders.vdf 里登记的其他盘。"""
    roots = [
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Steam",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Steam",
        Path.home() / ".steam" / "steam",
        Path.home() / ".local" / "share" / "Steam",
    ]
    out = []
    for r in roots:
        if r.is_dir():
            out.append(r)
        vdf = r / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            text = vdf.read_text(encoding="utf-8", errors="replace")
            out += [Path(p) for p in re.findall(r'"path"\s+"([^"]+)"', text)]
    return out


def find_dota(explicit=None):
    """返回 `game/dota` 目录（VPK 和 steam.inf 都在这里面）。"""
    cands = []
    if explicit:
        cands.append(Path(explicit))
    if os.environ.get("DOTA2_PATH"):
        cands.append(Path(os.environ["DOTA2_PATH"]))
    cands += [lib / "steamapps" / "common" / "dota 2 beta" for lib in steam_libraries()]

    for c in cands:
        for d in (c / "game" / "dota", c):          # 传进来的可能已经是 game/dota
            if (d / "pak01_dir.vpk").is_file():
                return d
    die("找不到 Dota 2 安装目录。用 --dota 指定，或设环境变量 DOTA2_PATH。\n"
        "      找过：" + "\n      ".join(str(c) for c in cands))


# ---------------------------------------------------------------- VPK

def vpk_read(dota_dir, wanted):
    """从 VPK 里取出 `wanted` 里的几个文件，返回 {路径: bytes}。"""
    dirpak = dota_dir / "pak01_dir.vpk"
    f = dirpak.open("rb")
    sig, ver = struct.unpack("<II", f.read(8))
    if sig != 0x55AA1234:
        die(f"{dirpak} 不是 VPK（magic {sig:#x}）")
    (tree_size,) = struct.unpack("<I", f.read(4))
    if ver == 2:
        f.read(16)          # v2 头部后面还有 16 字节，用不到
    elif ver != 1:
        die(f"不认识的 VPK 版本 {ver}")

    def cstr():
        buf = bytearray()
        while True:
            c = f.read(1)
            if c in (b"\0", b""):
                return buf.decode("utf-8", "replace")
            buf += c

    found = {}
    while True:
        ext = cstr()
        if not ext:
            break
        while True:
            path = cstr()
            if not path:
                break
            while True:
                name = cstr()
                if not name:
                    break
                _crc, preload, archive, off, length, _term = struct.unpack("<IHHIIH", f.read(18))
                # preload 不为 0 时紧跟着内嵌数据，**必须读掉**，否则整棵树从这里错位
                if preload:
                    f.read(preload)
                full = f"{path}/{name}.{ext}"
                if full in wanted:
                    found[full] = (archive, off, length)
    f.close()

    missing = set(wanted) - set(found)
    if missing:
        die("VPK 里找不到：" + "、".join(sorted(missing)) +
            "\n      Valve 可能改了数据格式。**不要退回网上的价格源**，先看 dota2 是不是把它编译了。")

    out = {}
    for full, (archive, off, length) in found.items():
        pak = dota_dir / f"pak01_{archive:03d}.vpk"
        with pak.open("rb") as a:
            a.seek(off)
            out[full] = a.read(length)
    return out


def text(raw):
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    return raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- 价格表

def build_prices(items_txt, ids_txt):
    idmap = {k: int(v) for k, v in re.findall(r'"(item_[a-z0-9_]+)"\s+"(\d+)"', ids_txt)}
    # 物品是一级缩进的块：\t"item_xxx"\n\t{ ... \n\t}
    blocks = re.findall(r'\n\t"(item_[a-z0-9_]+)"\s*\r?\n\t\{(.*?)\r?\n\t\}', items_txt, re.S)
    if len(blocks) < 400:
        die(f"items.txt 只解析出 {len(blocks)} 个物品，格式多半变了，先去看看再说")

    prices = {}
    for name, body in blocks:
        def field(k):
            m = re.search(r'"%s"\s+"([^"]*)"' % k, body)
            return m.group(1) if m else None

        cost = field("ItemCost")
        if cost is None:
            continue
        e = {"cost": int(cost)}
        if name in idmap:
            e["id"] = idmap[name]
        # 判据是 ItemQuality，不是"有没有充能"——瓶子有充能但不是消耗品，空瓶仍值全价
        if field("ItemQuality") == "consumable":
            e["consumable"] = True
        charges = field("ItemInitialCharges")
        if charges and int(charges) > 0:
            e["charges"] = int(charges)
        prices[name[len("item_"):]] = e
    return prices


def dump_prices(prices):
    """一行一个物品：既能看 git diff，也方便用户手改配置目录里那份。"""
    lines = [f'  {json.dumps(k)}: {json.dumps(v, separators=(", ", ": "))}'
             for k, v in sorted(prices.items())]
    return "{\n" + ",\n".join(lines) + "\n}\n"


def report_prices(old, new):
    changed = [(k, old[k]["cost"], new[k]["cost"])
               for k in set(old) & set(new) if old[k]["cost"] != new[k]["cost"]]
    added, gone = sorted(set(new) - set(old)), sorted(set(old) - set(new))

    print(f"\n价格表：{len(old)} -> {len(new)} 项")
    if not (changed or added or gone):
        print("  没有变化")
        return
    if changed:
        print(f"  改价 {len(changed)} 项：")
        for k, a, b in sorted(changed, key=lambda x: -abs(x[1] - x[2])):
            print(f"    {k:32} {a:6} -> {b:6}  ({b - a:+})")
    if added:
        print(f"  新增 {len(added)} 项：{'、'.join(added[:12])}"
              + (f" …… 等 {len(added)} 项" if len(added) > 12 else ""))
    if gone:
        print(f"  消失 {len(gone)} 项：{'、'.join(gone)}")
        print("    （消失的物品若还可能出现在别人的包里，净资产会少算——确认是真被移除了）")


# ---------------------------------------------------------------- 版本号

def patch_version(notes_txt):
    """从更新日志的键里推当前版本：DOTA_Patch_7_41e_item_heart -> 7.41e"""
    toks = set(re.findall(r'"DOTA_Patch_(\d+)_(\d+)([a-z]?)_', notes_txt))
    if not toks:
        die("更新日志里认不出版本号，patchnotes 的键名格式可能变了")
    # 按 (主, 次, 字母) 比，不按字符串——现在次版本号都两位补零，但别指望它一直是
    major, minor, letter = max(toks, key=lambda t: (int(t[0]), int(t[1]), t[2]))
    return f"{major}.{minor}{letter}"


def report_notes(notes_txt, version):
    key = "DOTA_Patch_" + version.replace(".", "_") + "_"
    rows = re.findall(r'"(%s[^"]*)"\s+"([^"]*)"' % re.escape(key), notes_txt)
    hits = [(k, v) for k, v in rows if MECHANICS.search(k) or MECHANICS.search(v)]

    print(f"\n{version} 更新日志共 {len(rows)} 条，命中我们建模的机制 {len(hits)} 条：")
    if not hits:
        print("  无 —— 这一版不必动 normal.json / turbo.json / towers.json")
        return
    for k, v in hits:
        print(f"  · {k[len(key):]}\n      {v}")
    print("\n  以上要人读一遍，决定符 / 肉山 / 塔防 / 买活这些计时常数要不要跟着改。")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="从游戏本体的数据文件更新常数表")
    ap.add_argument("--dota", help="Dota 2 安装目录（默认自动找）")
    ap.add_argument("--dry-run", action="store_true", help="只报告差异，不写文件")
    args = ap.parse_args()

    dota = find_dota(args.dota)
    print(f"Dota 2：{dota}")

    raw = vpk_read(dota, {ITEMS, ABILITY_IDS, PATCHNOTES})
    notes_txt = text(raw[PATCHNOTES])
    version = patch_version(notes_txt)

    prices = build_prices(text(raw[ITEMS]), text(raw[ABILITY_IDS]))
    price_file = CONSTANTS / "item_prices.json"
    old = json.loads(price_file.read_text(encoding="utf-8")) if price_file.exists() else {}

    patch_file = CONSTANTS / "patch.json"
    was = json.loads(patch_file.read_text(encoding="utf-8")).get("dota") if patch_file.exists() else None
    print(f"版本：{was or '(无)'} -> {version}")

    report_prices(old, prices)
    report_notes(notes_txt, version)

    if args.dry_run:
        print("\n--dry-run，没有写文件")
        return
    price_file.write_text(dump_prices(prices), encoding="utf-8")
    patch_file.write_text(
        json.dumps({"dota": version, "synced": date.today().isoformat()},
                   ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n已写入 {price_file.name}（{len(prices)} 项）和 {patch_file.name}")
    print("接下来：看一遍上面的差异 -> 需要就改计时表 -> 提交 -> 重新构建")


if __name__ == "__main__":
    main()
