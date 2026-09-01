#!/usr/bin/env python3
"""从 OpenDota 抓物品价格表快照到 constants/item_prices.json。

只保留 cost 字段：原始响应 362KB 里绝大部分是 lore/notes/attrib 等用不到的内容，
而这份文件既要入库又要被 Rust 用 include_str! 嵌进二进制。
"""
import json, urllib.request
from pathlib import Path

URL = "https://api.opendota.com/api/constants/items"
out = Path(__file__).resolve().parent.parent / "constants" / "item_prices.json"

# 不带 UA 会被 403
req = urllib.request.Request(URL, headers={"User-Agent": "dota2-game-helper2/0.1"})
raw = json.load(urllib.request.urlopen(req))

slim = {k: {"cost": v["cost"]} for k, v in raw.items()
        if isinstance(v, dict) and isinstance(v.get("cost"), int)}
out.write_text(json.dumps(slim, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(slim)}/{len(raw)} items with cost -> {out} ({out.stat().st_size // 1024} KB)")
