#!/usr/bin/env python3
"""发版脚本。本地和 GitHub Actions（.github/workflows/release.yml）用的是同一个，
步骤只写一份。流程见 docs/design/dev-tools.md「发版」。

    python tools/release.py bump 1.4.0      # 改三处版本号（之后照常提 PR 合进 main）
    python tools/release.py build           # 打包：安装包、zip、latest.json（文件名都不带版本号）→ dist/release/
    python tools/release.py publish NOTES   # 用 build 的产物建**草稿** Release、传文件，NOTES 是正文文件
    python tools/release.py verify 1.4.0    # 把 Release 上的文件下载回来核对 SHA256，全对才把草稿转正

build 要签名私钥：环境变量 TAURI_SIGNING_PRIVATE_KEY（私钥内容）。没设的话本地会去读
~/.tauri/dota2-game-helper2.key。私钥没设密码。
"""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI = ROOT / "src-tauri"
OUT = ROOT / "dist" / "release"
REPO = "shizzhang0/dota2-game-helper2"
# Tauri 命令行版本跟着 Cargo.lock 里的 tauri 走
TAURI_CLI = "@tauri-apps/cli@2.11.5"
KEY_FILE = Path.home() / ".tauri" / "dota2-game-helper2.key"
# **文件名不带版本号**，项目主页和 README 的下载按钮链到 `releases/latest/download/<这个名字>`，
# 永远是最新版，不用每次发版去改链接（2026-10-10）。是哪一版看 Release 的标题。
# 2026-10-10 ~ v1.4.1 还另传一份带版本号的（同一个文件两个名字），Release 页上一眼看去重复、
# 不知道下哪个；看了一圈别的项目没有这么做的，固定链接的（Zed）就只发不带版本号的。
# 2026-10-20 起只发这一份，latest.json 也指向它（带 tag 的地址，不是 latest，指得到确切那一版）
STABLE_SETUP = "dota2-game-helper2-setup.exe"
STABLE_ZIP = "dota2-game-helper2-portable.zip"

# Windows 上（包括 GitHub 的 windows runner）stdout 默认是 cp1252/GBK，打印中文会直接抛错
#（sys.exit 的报错走 stderr，两个都要改）
for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")


def version():
    return json.loads((TAURI / "tauri.conf.json").read_text(encoding="utf-8"))["version"]


def run(cmd, **kw):
    print("+", " ".join(cmd) if isinstance(cmd, list) else cmd, flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT, **kw)


def sha256(p):
    return hashlib.sha256(p.read_bytes()).hexdigest().upper()


def sub_one(path, pattern, repl):
    """只替换一处，替换不到就报错——宁可停下来，不要发出一个版本号没改全的包"""
    text = path.read_text(encoding="utf-8")
    new, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    if n != 1:
        sys.exit(f"{path.name} 里没找到版本号")
    path.write_text(new, encoding="utf-8", newline="")


def bump(v):
    if not re.fullmatch(r"\d+\.\d+\.\d+", v):
        sys.exit(f"版本号要写成 1.4.0 这样：{v}")
    sub_one(TAURI / "Cargo.toml", r'^version = "[^"]+"', f'version = "{v}"')
    sub_one(TAURI / "tauri.conf.json", r'^  "version": "[^"]+"', f'  "version": "{v}"')
    sub_one(TAURI / "Cargo.lock", r'(name = "dota2-game-helper2"\r?\nversion = )"[^"]+"', rf'\g<1>"{v}"')
    print(f"三处版本号已改成 {v}")


def build():
    v = version()
    env = dict(os.environ)
    if not env.get("TAURI_SIGNING_PRIVATE_KEY"):
        if not KEY_FILE.is_file():
            sys.exit(f"没有签名私钥：设 TAURI_SIGNING_PRIVATE_KEY，或者放在 {KEY_FILE}")
        env["TAURI_SIGNING_PRIVATE_KEY"] = KEY_FILE.read_text(encoding="utf-8")
    env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")

    # frontendDist 是整个 ui/，gitignore 挡不住打包：ui/ 里任何没进仓库的文件都会被嵌进 exe
    # （2026-10-08 开发页的测试截图和录像切片就这样把 exe 从 6.7MB 撑到 9.2MB）。
    # 开发素材现在固定放仓库根的 devdata/，这里再查一道：ui/ 里有没进仓库的文件就不打
    stray = subprocess.run(["git", "ls-files", "--others", "ui"], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.split()
    if stray:
        sys.exit("ui/ 里有没进仓库的文件，会被打进 exe，先挪走：\n  " + "\n  ".join(stray))
    npx = "npx.cmd" if os.name == "nt" else "npx"
    # `--` 后面的参数传给 cargo。--locked：发出去的包必须用 Cargo.lock 锁住的那套依赖编，
    # 锁文件和 Cargo.toml 对不上就停（CI 那边同样加了，见 ci.yml）
    run([npx, "-y", TAURI_CLI, "build", "--", "--locked"], env=env)

    rel = TAURI / "target" / "release"
    nsis = rel / "bundle" / "nsis"
    setup = nsis / f"dota2-game-helper2_{v}_x64-setup.exe"
    sig = Path(str(setup) + ".sig")
    exe = rel / "dota2-game-helper2.exe"
    for p in (exe, setup, sig):
        if not p.is_file():
            sys.exit(f"打包产物缺了：{p}")

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    shutil.copy2(setup, OUT / STABLE_SETUP)

    # 绿色版：exe + 两份 README
    zp = OUT / STABLE_ZIP
    with zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(exe, "dota2-game-helper2.exe")
        for readme in ("README.md", "README.zh-CN.md"):
            z.write(ROOT / readme, readme)

    # 一键更新读的清单：安装包地址 + 签名
    import datetime
    latest = {
        "version": v,
        "notes": f"v{v}",
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {"windows-x86_64": {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/{REPO}/releases/download/v{v}/{STABLE_SETUP}",
        }},
    }
    (OUT / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    size_mb = exe.stat().st_size / 1048576
    print(f"\nexe {size_mb:.1f} MB（应约 7.5MB，大很多说明 ui/ 里混进了别的东西）")
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name:52} {sha256(p) if p.suffix in ('.exe', '.zip') else ''}")


def release_files(v):
    """Release 上应有的三个文件。漏传 latest.json，装了安装版的人就收不到这一版；
    漏传安装包或 zip，主页的下载按钮就 404——所以 publish 缺一样就不发，verify 少一样就不转正"""
    return [OUT / STABLE_ZIP, OUT / STABLE_SETUP, OUT / "latest.json"]


def release_state(tag):
    """None = 还没有这个 Release；否则返回它是不是草稿"""
    r = subprocess.run(["gh", "release", "view", tag, "--json", "isDraft", "-q", ".isDraft"],
                       cwd=ROOT, capture_output=True, text=True)
    return None if r.returncode != 0 else r.stdout.strip() == "true"


def publish(notes):
    v = version()
    tag = f"v{v}"
    files = release_files(v)
    for p in files:
        if not p.is_file():
            sys.exit(f"先 build：缺 {p.name}")
    # **先建草稿，传完、verify 核对通过才转正**（2026-10-15 改）。原先是直接建公开 Release 再逐个传文件：
    # 传的那几十秒里它已经是 latest，装了安装版的人点更新会拿到 404；中途失败还留下半份 Release，
    # 重跑又因为"已存在"再失败。草稿对外不可见、也不算 latest，失败了重跑就接着用这份草稿
    state = release_state(tag)
    if state is None:
        # --verify-tag：远端没有这个 tag 就不建（否则 gh 会替你在默认分支上新打一个）
        run(["gh", "release", "create", tag, "--draft", "--verify-tag",
             "--title", tag, "--notes-file", notes])
    elif state:
        print(f"{tag} 的草稿已存在（上次中途失败？），接着用它")
        run(["gh", "release", "edit", tag, "--notes-file", notes])
    else:
        sys.exit(f"{tag} 已经正式发布了，不再改它的文件")
    run(["gh", "release", "upload", tag, "--clobber", *map(str, files)])


def verify(v):
    tag = f"v{v}"
    tmp = Path(tempfile.mkdtemp())
    run(["gh", "release", "download", tag, "-D", str(tmp)])
    want = {p.name: p for p in release_files(v)}
    got = {p.name: p for p in tmp.iterdir()}
    bad = []
    for name in sorted(want.keys() | got.keys()):
        local, remote = want.get(name), got.get(name)
        if remote is None:
            mark = "**Release 上没有**"
        elif local is None:
            mark = "**Release 上多出来的**"
        elif not local.is_file():
            mark = "**本地没有，没法核对**"
        elif sha256(local) != sha256(remote):
            mark = "**不一致**"
        else:
            mark = "一致"
        print(f"  {name:52} {sha256(remote) if remote else '':64} {mark}")
        if mark != "一致":
            bad.append(name)
    if bad:
        sys.exit(f"核对没通过：{', '.join(bad)}" +
                 ("（Release 还是草稿，没有对外公开）" if release_state(tag) else ""))
    if release_state(tag):
        run(["gh", "release", "edit", tag, "--draft=false"])
        print(f"{tag} 已转正")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "bump" and len(a) == 2:
        bump(a[1])
    elif cmd == "build":
        build()
    elif cmd == "publish" and len(a) == 2:
        publish(a[1])
    elif cmd == "verify" and len(a) == 2:
        verify(a[1])
    else:
        sys.exit(__doc__)
