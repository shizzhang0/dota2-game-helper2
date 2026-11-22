"""挑几场本地录像，让 d2hr 在游戏里从头 2 倍速放完，放完自动退出游戏。

对账要同一局两份录制（docs/design/dev-tools.md「准确性对账」）：自己打的那份 + 回放那份。
回放那份原来要手动在客户端里看完，这里交给另一个项目 dota2-highlight-recorder 的命令行 `d2hr watch`
（带控制台端口启动 Dota、playdemo、demo_timescale，比赛结束后再放 15 秒、回主菜单，换下一场）。
覆盖层开着「记录对局数据」就会把回放录下来。

    python tools/watch_replays.py                     列出本地录像，选要看的
    python tools/watch_replays.py 9099623530 9099671882   直接看这几场
    选项：--speed 2（倍速）、--keep-open（放完不退出游戏）

录像要先在游戏里下载好（观战 → 比赛记录 → 下载）。
d2hr 从 PATH 里找：在 dota2-highlight-recorder 里 `cargo install --path crates/d2hr` 装一次
（装进 ~/.cargo/bin；那边改了 d2hr 要再装一次）。要用别处的 d2hr.exe，设环境变量 D2HR 指过去。
"""

import argparse
import gzip
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path

APPDIR = Path(os.environ.get("APPDATA", "")) / "dev.dota2helper2.app"
RECORDS = APPDIR / "records"
HELPER_EXE = "dota2-game-helper2.exe"


def d2hr_path():
    """环境变量 D2HR 优先，否则在 PATH 里找；都没有是 None"""
    env = os.environ.get("D2HR")
    if env:
        return Path(env)
    found = shutil.which("d2hr")
    return Path(found) if found else None


def is_spectate(player) -> bool:
    """同 verify_common.mjs 的 isSpectate：回放视角的 player 是 { team2: { player0: ... } } 全员结构"""
    return isinstance(player, dict) and "team_name" not in player and any(re.fullmatch(r"team\d+", k) for k in player)


def kind_of(path: Path):
    """这份录制是 'self'（自己打）还是 'spectate'（回放）；读不出来是 None"""
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if i > 2000:
                    break
                try:
                    p = json.loads(line).get("player")
                except (json.JSONDecodeError, AttributeError):
                    continue
                if p:
                    return "spectate" if is_spectate(p) else "self"
    except (OSError, EOFError):
        pass
    return None


def recordings():
    """比赛 ID → {'self': 份数, 'spectate': 份数}"""
    out = {}
    if not RECORDS.is_dir():
        return out
    for f in RECORDS.glob("raw_*_m*.jsonl.gz"):
        m = re.search(r"_m(\d+)\.jsonl\.gz$", f.name)
        k = m and kind_of(f)
        if k:
            out.setdefault(int(m.group(1)), {"self": 0, "spectate": 0})[k] += 1
    return out


def local_replays(d2hr: Path):
    """d2hr list 的结果：[(比赛 ID, 那一行剩下的部分)]"""
    r = subprocess.run([str(d2hr), "list"], capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"d2hr list 出错：\n{r.stdout}{r.stderr}")
    rows = []
    for line in r.stdout.splitlines():
        m = re.match(r"^(\d{6,})\s+(.*)$", line)
        if m:
            rows.append((int(m.group(1)), m.group(2).rstrip()))
    return rows


def start_times():
    """正在运行的覆盖层和 Dota 的启动时间（unix 秒）：{'helper': t, 'dota': t}，没在运行的不给"""
    ps = (
        "Get-Process dota2-game-helper2,dota2 -ErrorAction SilentlyContinue | "
        "ForEach-Object { $_.ProcessName + ' ' + ([DateTimeOffset]$_.StartTime).ToUnixTimeSeconds() }"
    )
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, errors="replace")
    out = {}
    for line in r.stdout.splitlines():
        name, _, t = line.strip().rpartition(" ")
        if t.isdigit():
            key = "helper" if name.lower() == "dota2-game-helper2" else "dota"
            out[key] = min(int(t), out.get(key, int(t)))
    return out


def recording_on() -> bool:
    try:
        return bool(json.loads((APPDIR / "settings.json").read_text(encoding="utf-8")).get("recordMatches"))
    except (OSError, json.JSONDecodeError):
        return False


def choose(rows, recs):
    """列出本地录像让用户选；默认选「有自己打的、没回放」的"""
    default = [mid for mid, _ in rows if recs.get(mid, {}).get("self") and not recs.get(mid, {}).get("spectate")]
    print("\n本地录像（★ = 有自己打的录制、还没有回放录制，回车就看这些）：\n")
    print(f"{'':>3}    {'比赛 ID':<12} {'下载于':<10} {'大小':>7} {'时长':>6}  我的英雄            自己打 回放")
    for i, (mid, rest) in enumerate(rows, 1):
        r = recs.get(mid, {})
        star = "★" if mid in default else " "
        mark = lambda n: f"{n} 份" if n else "—"
        print(f"{i:>3} {star}  {mid:<12} {rest:<48} {mark(r.get('self', 0)):>5} {mark(r.get('spectate', 0)):>5}")
    print()
    while True:
        s = input("要看哪几场？序号或比赛 ID，空格隔开；a = 全部；回车 = 带 ★ 的；q = 退出：").strip()
        if s.lower() == "q":
            return []
        if not s:
            if not default:
                print("没有带 ★ 的，请自己选")
                continue
            return default
        if s.lower() == "a":
            return [mid for mid, _ in rows]
        picked, bad = [], []
        ids = {mid for mid, _ in rows}
        for tok in re.split(r"[\s,，]+", s):
            if not tok.isdigit():
                bad.append(tok)
            elif 1 <= int(tok) <= len(rows):
                picked.append(rows[int(tok) - 1][0])
            elif int(tok) in ids:
                picked.append(int(tok))
            else:
                bad.append(tok)
        if bad:
            print(f"认不出：{' '.join(bad)}")
            continue
        return list(dict.fromkeys(picked))


def main():
    ap = argparse.ArgumentParser(description="让 d2hr 在游戏里从头放完几场录像，给覆盖层录回放")
    ap.add_argument("matches", nargs="*", type=int, help="比赛 ID；不给就列出本地录像来选")
    ap.add_argument("--speed", type=float, default=2.0, help="倍速，默认 2")
    ap.add_argument("--keep-open", action="store_true", help="放完不退出游戏")
    a = ap.parse_args()

    d2hr = d2hr_path()
    if d2hr is None:
        sys.exit("PATH 里没有 d2hr。在 dota2-highlight-recorder 里运行 cargo install --path crates/d2hr 装一次，或者用环境变量 D2HR 指定。")
    if not d2hr.is_file():
        sys.exit(f"环境变量 D2HR 指的文件不存在：{d2hr}")

    # 覆盖层启动时写 GSI 配置，Dota 只在启动时读配置：覆盖层没开、或者 Dota 比它先启动，回放都录不下来
    procs = start_times()
    problem = None
    if "helper" not in procs:
        problem = f"{HELPER_EXE} 没在运行，回放不会被录下来。先打开覆盖层（要在 Dota 启动前开着）。"
    elif not recording_on():
        problem = "覆盖层设置里「记录对局数据」没开，回放不会被录下来。"
    elif "dota" in procs and procs["dota"] < procs["helper"]:
        problem = "Dota 比覆盖层先启动，没读到覆盖层的 GSI 配置，回放不会被录下来。先退出 Dota 再跑。"
    if problem:
        print(f"警告：{problem}")
        if input("还是继续？[y/N] ").strip().lower() != "y":
            return

    recs = recordings()
    if a.matches:
        picked = list(dict.fromkeys(a.matches))
    else:
        rows = local_replays(d2hr)
        if not rows:
            sys.exit("本地没有录像。在游戏的「观战 → 比赛记录」里点「下载」后再来。")
        picked = choose(rows, recs)
    if not picked:
        return

    cmd = [str(d2hr), "watch", *map(str, picked), "--speed", str(a.speed)]
    if a.keep_open:
        cmd.append("--keep-open")
    print("\n" + " ".join(cmd) + "\n")
    before = set(RECORDS.glob("raw_*.jsonl.gz"))
    # Ctrl+C 交给 d2hr 处理（它会恢复游戏设置、让游戏退出），这边不跟着中断，等它收完尾再报结果
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    code = subprocess.call(cmd)
    signal.signal(signal.SIGINT, signal.default_int_handler)

    # 中途停下、某场没放完时，覆盖层会留下半截的回放录制；对账脚本会把同一局的回放按时间连起来，半截的要删掉
    new = sorted(set(RECORDS.glob("raw_*.jsonl.gz")) - before)
    print("\n这次新增的回放录制：")
    for mid in picked:
        files = [f for f in new if f.name.endswith(f"_m{mid}.jsonl.gz") and kind_of(f) == "spectate"]
        if not files:
            print(f"  {mid}：没有")
        for f in files:
            state = "完整（录到了比赛结束）" if reached_post_game(f) else "半截（没录到比赛结束，对账前删掉）"
            print(f"  {mid}：{f.name}  {state}")
    sys.exit(code)


def reached_post_game(path: Path) -> bool:
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return any("DOTA_GAMERULES_STATE_POST_GAME" in line for line in f)
    except (OSError, EOFError):
        return False


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(130)
