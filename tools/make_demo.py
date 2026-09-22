#!/usr/bin/env python3
"""把一份对局录制剪成 GitHub Pages 上那个 live demo 用的数据。

    python tools/make_demo.py <录制文件> --from 60 --to 300 [--out site/demo.jsonl]

**裁剪即脱敏。** 这里走的是白名单：只保留 `ui/js` 真正读的字段，别的一律丢。
比"逐个删掉 steamid / accountid / name"更安全——后者要求我们记全所有身份字段，
而且 Dota 以后在 GSI 里新增一个，它会悄悄混进 demo；白名单则是新字段默认不进。

顺带解决体积：实测原始录制每包约 25KB，1301 包就 32MB，**绝大部分是 minimap 里
几百个小兵**。而地图只画眼和塔。

白名单的每一条都对得上一个消费者，改 UI 时这张表要跟着改：

    map.matchid           match.js 切分对局（**会被替换成假值**，见下）
    map.clock_time        timers.js 全部倒计时的基准
    map.game_state        match.js 判 inMatch
    map.paused            match.js
    player.team_name      match.js 定我方阵营；也是"是不是观战"的判据；
                          networth.js 的 mySlot() 也要它（夜魇要加 5）
    player.team_slot      networth.js 的 mySlot()——**items[].purchaser 的全部意义在此**，
                          少了它 mySlot() 返回 null，notOwnedBy() 直接放行，
                          队友和敌方的东西会全算成自己的
    player.gold           networth.js
    player.gold_from_income  match.js 判普通局还是快速组队
    player.gpm / xpm      networth.js
    player.deaths         networth.js：TP 自购/白送的判据，以及支出账和眼架
                          两处"掉钱不等于花钱"的挡板。**比 hero.alive 早一包**
    hero.alive            networth.js 的死亡期挡板（阵亡那一包用 deaths，不用它）
    hero.aghanims_shard   networth.js 的魔晶（1400），走 flag 不走物品栏
    hero.permanent_buffs  networth.js 的吞噬类 buff（神杖、月之碎片…）
    hero.xpos / ypos      minimap.js 判"眼是不是插在自己脚下"
    items.name/charges/purchaser  networth.js（整段的其余字段——冷却、
                          可否施放、等级——一个都没人读）
    events                networth.js 与 events.js
    minimap               **只留眼、塔、泉水**，且按类型给不同字段，见 minimap_fields

整段丢掉的：provider / buildings / abilities / wearables。
它们在 cachepool.js 的 SECTIONS 里，但全项目没有任何消费者——2026-09-17 逐个 grep 过。
"""
import argparse, json, re, sys
from pathlib import Path

# Windows 控制台默认是 cp1252/cp936，脚本的输出全是中文，不改会在 print 那里
# UnicodeEncodeError 退出 1——而文件其实已经写出去了，最容易误判成"生成失败"。
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8")
    except Exception: pass

ROOT = Path(__file__).resolve().parent.parent

MAP_KEYS = ("matchid", "clock_time", "game_state", "paused")
PLAYER_KEYS = ("team_name", "team_slot", "gold", "gold_from_income", "gpm", "xpm", "deaths")
HERO_KEYS = ("alive", "aghanims_shard", "permanent_buffs", "xpos", "ypos")
# networth.js 只读这三个；purchaser 用来认"谁买的"
ITEM_KEYS = ("name", "charges", "purchaser")

WARD_UNITS = ("npc_dota_observer_wards", "npc_dota_sentry_wards")

# minimap 里**按类型给不同字段**，因为两种东西各走各的判据：
#   眼   minimap.js 的 WARD_UNITS[o.unitname] —— 要 unitname，不要 image
#   塔   String(o.image).startsWith("minimap_tower") —— 要 image，不要 unitname
#   泉水 也用 minimap_ward_obs 图标画，靠 unitname 被 parseWards 排掉。
#        留着它是为了 demo 真的会跑到那条过滤分支上（就两条，几乎不占地方）。
# **兵营（minimap_racks）整个丢掉**：deadTowers 和 events.js 都只认 minimap_tower，
# 没有任何代码读它，而它每包八条。
WARD_FIELDS = ("unitname", "team", "xpos", "ypos")
TOWER_FIELDS = ("image", "team", "xpos", "ypos")
FOUNTAIN_FIELDS = ("unitname", "xpos", "ypos")

# 假的对局号：match.js 只用它判"换局了没有"，具体值无所谓，
# 而真实 matchid 能反查到那一局和里面的人。
FAKE_MATCHID = "0000000000"


def minimap_fields(o):
    """这条 minimap 条目要留哪些字段？返回 None 表示整条丢掉。"""
    if not isinstance(o, dict):
        return None
    if o.get("unitname") in WARD_UNITS:
        return WARD_FIELDS
    if o.get("unitname") == "dota_fountain":
        return FOUNTAIN_FIELDS
    if str(o.get("image", "")).startswith("minimap_tower"):
        return TOWER_FIELDS
    return None


def pick(src, keys):
    if not isinstance(src, dict):
        return None
    out = {k: src[k] for k in keys if k in src}
    return out or None


def scrub(pkt):
    """一包原始 GSI -> 一包 demo 数据。返回 None 表示这包没什么可留的。"""
    out = {}
    m = pick(pkt.get("map"), MAP_KEYS)
    if m:
        if "matchid" in m:
            m["matchid"] = FAKE_MATCHID
        out["map"] = m
    for sec, keys in (("player", PLAYER_KEYS), ("hero", HERO_KEYS)):
        v = pick(pkt.get(sec), keys)
        if v:
            out[sec] = v
    items = pkt.get("items")
    if isinstance(items, dict) and items:
        kept = {k: pick(v, ITEM_KEYS) for k, v in items.items()}
        kept = {k: v for k, v in kept.items() if v}
        if kept:
            out["items"] = kept
    # **events 是数组不是对象**（cachepool.js 的注释写着"数组不适用：events 为空
    # 是有意义的'本包无事件'"）。最初这里写的是 isinstance(ev, dict)，把每一包的
    # 事件全丢了——对账脚本在 glyph 上逮到了 54 处不一致，否则不会有人发现。
    ev = pkt.get("events")
    if isinstance(ev, list) and ev:
        out["events"] = ev
    mm = pkt.get("minimap")
    if isinstance(mm, dict):
        kept = {}
        for k, v in mm.items():
            f = minimap_fields(v)
            if f:
                kept[k] = pick(v, f)
        kept = {k: v for k, v in kept.items() if v}
        if kept:
            out["minimap"] = kept
    return out or None


def packets(path):
    """原始 dump 是**连着写的多段 JSON**（Dota 推来的 body 带缩进，不是 JSONL），
    所以按流式解码而不是按行切。录制器写出来的紧凑 JSONL 同样能被它读。"""
    dec = json.JSONDecoder()
    buf = ""
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            buf += chunk
            i = 0
            while True:
                rest = buf[i:].lstrip()
                if not rest:
                    break
                try:
                    obj, end = dec.raw_decode(rest)
                except ValueError:
                    break
                i += len(buf[i:]) - len(rest) + end
                yield obj
            buf = buf[i:]


# 出门前再查一遍：白名单理论上已经挡掉了这些，但这条断言是给"以后有人放宽白名单"
# 准备的——它会在数据发到公网之前拦住。
FORBIDDEN = re.compile(r"steamid|accountid|activity|\bteamname\b", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--from", dest="start", type=int, default=0, help="起始 clock_time（秒）")
    ap.add_argument("--to", dest="end", type=int, default=10 ** 9, help="结束 clock_time（秒）")
    ap.add_argument("--out", default=str(ROOT / "site" / "demo.jsonl"))
    a = ap.parse_args()

    out_path = Path(a.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    total = kept = 0
    raw_bytes = 0
    with open(out_path, "w", encoding="utf-8", newline="\n") as g:
        for pkt in packets(a.source):
            total += 1
            c = (pkt.get("map") or {}).get("clock_time")
            if not isinstance(c, int) or not (a.start <= c <= a.end):
                continue
            s = scrub(pkt)
            if not s:
                continue
            line = json.dumps(s, separators=(",", ":"), ensure_ascii=False)
            g.write(line + "\n")
            kept += 1
            raw_bytes += len(json.dumps(pkt, separators=(",", ":"), ensure_ascii=False))

    text = out_path.read_text(encoding="utf-8")
    hit = FORBIDDEN.search(text)
    if hit:
        out_path.unlink()
        sys.exit(f"输出里出现了不该有的字段 {hit.group(0)!r}，已删除输出。白名单被放宽了？")

    size = out_path.stat().st_size
    print(f"读 {total} 包，留 {kept} 包（clock {a.start}..{a.end}）")
    print(f"裁剪前 {raw_bytes / 1e6:.1f} MB -> 裁剪后 {size / 1e6:.2f} MB"
          f"（{size / raw_bytes * 100:.1f}%）" if raw_bytes else "")
    print(f"写出 {out_path}")


if __name__ == "__main__":
    main()
