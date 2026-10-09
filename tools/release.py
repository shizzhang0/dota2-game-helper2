#!/usr/bin/env python3
"""发版脚本。本地和 GitHub Actions（.github/workflows/release.yml）用的是同一个，
步骤只写一份。流程见 docs/design/dev-tools.md「发版」。

    python tools/release.py bump 1.4.0      # 改三处版本号（之后照常提 PR 合进 main）
    python tools/release.py build           # 打包：exe、安装包 + 签名、zip、latest.json → dist/release/
    python tools/release.py publish NOTES   # 用 build 的产物建 GitHub Release，NOTES 是正文文件
    python tools/release.py verify 1.4.0    # 把 Release 上的文件下载回来核对 SHA256

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

# Windows 上（包括 GitHub 的 windows runner）stdout 默认是 cp1252/GBK，打印中文会直接抛错
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


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

    # frontendDist 是整个 ui/，gitignore 挡不住打包：开发页的测试截图和录像切片会被嵌进 exe。
    # 打包期间挪到 ui/ 外面，打完不管成败都挪回来
    dev = ROOT / "ui" / "dev"
    parked = Path(tempfile.mkdtemp()) / "dev" if dev.exists() else None
    if parked:
        shutil.move(str(dev), str(parked))
    try:
        npx = "npx.cmd" if os.name == "nt" else "npx"
        run([npx, "-y", TAURI_CLI, "build"], env=env)
    finally:
        if parked:
            shutil.move(str(parked), str(dev))

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
    shutil.copy2(setup, OUT / setup.name)
    shutil.copy2(sig, OUT / sig.name)

    # 绿色版：exe + 两份 README
    zp = OUT / f"dota2-game-helper2-v{v}-windows-x64.zip"
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
            "url": f"https://github.com/{REPO}/releases/download/v{v}/{setup.name}",
        }},
    }
    (OUT / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    size_mb = exe.stat().st_size / 1048576
    print(f"\nexe {size_mb:.1f} MB（应约 7.5MB，大很多说明 ui/ 里混进了别的东西）")
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name:52} {sha256(p) if p.suffix in ('.exe', '.zip') else ''}")


def publish(notes):
    v = version()
    files = [OUT / f"dota2-game-helper2-v{v}-windows-x64.zip",
             OUT / f"dota2-game-helper2_{v}_x64-setup.exe",
             OUT / "latest.json"]
    for p in files:
        if not p.is_file():
            sys.exit(f"先 build：缺 {p.name}")
    # 漏传 latest.json，装了安装版的人就收不到这一版——所以三样一起传，缺一样就不发
    run(["gh", "release", "create", f"v{v}", "--title", f"v{v}", "--notes-file", notes,
         *map(str, files)])


def verify(v):
    tmp = Path(tempfile.mkdtemp())
    run(["gh", "release", "download", f"v{v}", "-D", str(tmp)])
    for p in sorted(tmp.iterdir()):
        local = OUT / p.name
        ok = "" if not local.is_file() else ("一致" if sha256(local) == sha256(p) else "**不一致**")
        print(f"  {p.name:52} {sha256(p)} {ok}")


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
