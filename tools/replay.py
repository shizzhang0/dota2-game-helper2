#!/usr/bin/env python3
"""回放服务器：静态服务 ui/ 与 constants/，SSE 重放 dump。用法：python tools/replay.py"""
import codecs, json, os, time, mimetypes, zlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT.parent / "dota2_gsi_dump" / "dump"
PORT = 8000


def _text_chunks(path):
    """产出解压后的文本块。

    .gz 走 zlib 增量解压而不是 gzip 模块：被强杀的录制没有结尾标记，
    gzip 模块会在收尾时抛 EOFError 并**连同已缓冲的整块一起丢掉**——
    小文件甚至一个字节都读不出来。zlib 遇到截断就停，已解出的照常给。
    """
    dec = codecs.getincrementaldecoder("utf-8")()
    if path.suffix != ".gz":
        with open(path, "rb") as fh:
            for raw in iter(lambda: fh.read(1 << 20), b""):
                yield dec.decode(raw)
        return
    z = zlib.decompressobj(31)          # 31 = 自动识别 gzip 头
    with open(path, "rb") as fh:
        for raw in iter(lambda: fh.read(1 << 20), b""):
            try:
                out = z.decompress(raw)
            except zlib.error:
                return                  # 数据坏了，前面的仍然有效
            if out:
                yield dec.decode(out)


def _packets(path):
    """逐个产出包。

    用流式 JSON 解码而不是按行切，因此**紧凑 JSONL 与 Dota 原样落盘的多行 JSON
    都能读**，不必判断格式（早期录制是后者，一包摊成几十行）。
    """
    d = json.JSONDecoder()
    buf = ""
    for chunk in _text_chunks(path):
        if not chunk:
            continue
        buf += chunk
        i = 0
        while True:
            while i < len(buf) and buf[i].isspace():
                i += 1
            if i >= len(buf):
                break
            try:
                obj, j = d.raw_decode(buf, i)
            except ValueError:
                break                   # 半个包，等下一块
            yield obj
            i = j
        buf = buf[i:]


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
            for obj in _packets(path):
                line = json.dumps(obj, ensure_ascii=False)
                ts = (obj.get("provider") or {}).get("timestamp")
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
