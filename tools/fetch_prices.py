#!/usr/bin/env python3
"""从 OpenDota 抓物品价格表快照到 constants/item_prices.json。

只保留 cost / qual / charges 三个字段：原始响应 362KB 里绝大部分是 lore/notes/attrib
等用不到的内容，而这份文件既要入库又要被 Rust 用 include_str! 嵌进二进制。
qual 和 charges 用于消耗品按剩余次数折价（半瓶纯净水不该算全价）。
"""
import json, urllib.request
from pathlib import Path

URL = "https://api.opendota.com/api/constants/items"
out = Path(__file__).resolve().parent.parent / "constants" / "item_prices.json"

# 不带 UA 会被 403
req = urllib.request.Request(URL, headers={"User-Agent": "dota2-game-helper2/0.1"})
raw = json.load(urllib.request.urlopen(req))

def entry(v):
    e = {"cost": v["cost"]}
    if v.get("qual") == "consumable":
        e["consumable"] = True
    ch = v.get("charges")
    if isinstance(ch, (int, float)) and ch and int(ch) > 0:
        e["charges"] = int(ch)
    return e


slim = {k: entry(v) for k, v in raw.items()
        if isinstance(v, dict) and isinstance(v.get("cost"), int)}
out.write_text(json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(slim)}/{len(raw)} items with cost -> {out} ({out.stat().st_size // 1024} KB)")
