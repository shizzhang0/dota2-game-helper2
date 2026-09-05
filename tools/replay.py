#!/usr/bin/env python3
"""回放服务器：静态服务 ui/ 与 constants/，SSE 重放 dump。用法：python tools/replay.py"""
import gzip, json, os, time, mimetypes
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT.parent / "dota2_gsi_dump" / "dump"
PORT = 8000


def _tolerant(fh):
    """逐行读取，遇到 gzip 截断就正常收尾而不是抛异常。"""
    while True:
        try:
            line = fh.readline()
        except (EOFError, OSError):
            return
        if not line:
            return
        yield line


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/stream":
            return self.stream(parse_qs(u.query))
        rel = u.path.lstrip("/") or "index.html"
        base = ROOT / ("constants" if rel.startswith("constants/") else "ui")
        f = (ROOT / rel) if rel.startswith("constants/") else (base / rel)
        f = f.resolve()
        if not (str(f).startswith(str(ROOT)) and f.is_file()):
            self.send_error(404); return
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")   # 开发用：改完刷新即生效，不被浏览器缓存坑
        self.end_headers()
        self.wfile.write(f.read_bytes())

    def stream(self, q):
        name = q.get("file", ["raw_20260831_215612.jsonl"])[0]
        speed = float(q.get("speed", ["8"])[0])
        path = DUMP / name
        if not path.is_file():
            # 也在程序自己录的目录里找
            alt = Path(os.environ.get("APPDATA", "")) / "dev.dota2helper2.app" / "records" / name
            if alt.is_file():
                path = alt
            else:
                self.send_error(404, f"no dump {name}"); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        prev_ts = None
        try:
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as fh:
                # 被强杀的录制文件没有 gzip 结尾标记，读到末尾会抛 EOFError，
                # 但此前 flush 过的内容都是好的，照读不误
                for line in _tolerant(fh):
                    line = line.strip()
                    if not line: continue
                    ts = None
                    try: ts = json.loads(line).get("provider", {}).get("timestamp")
                    except Exception: pass
                    delay = 0.3 if (ts is None or prev_ts is None) else max(0.0, min(ts - prev_ts, 2.0))
                    prev_ts = ts if ts is not None else prev_ts
                    time.sleep(delay / speed)
                    self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass


if __name__ == "__main__":
    print(f"http://127.0.0.1:{PORT}  (stream: /stream?file=...&speed=8)")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
