# 开发工具：日志 · 对局录制 · 回放

## 日志：正式版原本等于没有

Rust 侧有 17 处 `println!`，但 `windows_subsystem = "windows"` 让正式构建**没有控制台**，
这些输出直接进虚空；前端一处 `console` 都没有，WebView2 的控制台在正式版也开不出来。
**出了问题只能靠猜。**

做法：写文件日志到配置目录 `logs/`。

- `logs/helper2.log` 当前，`logs/helper2.1.log` 上一份（超 5MB 轮转，只留一个备份）
- 一行一条：`<Unix秒> [级别] <消息>`
- 新建时写 UTF-8 BOM——日志是给人看的，中文 Windows 上有些工具不带 BOM 会认错编码
- **分级** `error` / `warn` / `info` / `debug`，级别写在 `settings.json` 里可改。
  现阶段默认 `debug`（全量），功能稳定后再调高
- **前端的错误要转发给 Rust 一起写**——否则正式版里前端一旦抛异常，面板直接空白且无声无息，
  这正是最难查的一类问题

日志的价值已经兑现过几次，比如"编辑态退不出去"那个 bug：日志里只有
`[edit] 编辑态 = true` 而没有配对的 `false`，一眼就知道退出压根没调到 Rust。

## 对局录制

设置里一个开关，开启后把每个 GSI 包落盘，用于事后回放调试。
**具体怎么用（自动清理、按对局分文件、导出等）等开发完再定**，目前只是最小实现。
录制**不会自动清理**，需要自己删。

**格式**：`records/raw_<时间戳>.jsonl.gz`，每包一行紧凑 JSON，与 `tools/gsi_dump.py` 同格式。

> **必须重新序列化，不能原样写 body。** Dota 推过来的 HTTP body 是**带制表符缩进的多行 JSON**，
> 一包摊成几十行；原样落盘就不是 JSONL 了，`replay.py` 按行读会**一条都解析不出来**。
> `gsi_dump.py` 用的是 `json.dumps(data) + "\n"`（紧凑序列化），
> Rust 侧对应 `serde_json::Value::to_string()`。
>
> 这条最初写错过：`gsi.rs` 里写着"写原始文本，保证与 gsi_dump.py 完全同格式"，
> 实际两者根本不同格式，直到第一次真去读录制文件才发现。

**每 50 包 flush 一次**：gzip 把数据缓存在内存里，只有 finish/flush 才落盘，
而进程被杀（包括托盘退出走的 `app.exit`）时析构不会执行，不定期 flush 就整段全丢。
真实 GSI 约 10 包/秒，50 包 ≈ 5 秒，最坏只丢这么多。

**全量保真，不裁字段。** 实测体积（11 分钟正常局）：

| | |
|---|---|
| 原始 | 29 KB/包 × 1301 包 = **37 MB**（40 分钟局约 130 MB） |
| gzip 后 | 约 **4 MB** |

其中 `minimap` 占 65%、`previously` 占 11%。曾考虑丢掉 `previously`
（那是 Valve 内建的 diff——装着本包中发生变化的字段的上一个值，例如金钱 600→95 时
`previously.player.gold = 600`；我们的缓存池自己维护状态、自己算差值，从不读它），
但 gzip 之后丢它只再省 400 KB，而录制的价值正在于事后能查任何东西，因此**保留全部字段**。

## 回放服务器 `tools/replay.py`

静态服务 `ui/` 与 `constants/`，并通过 SSE 重放 dump。
打开 <http://127.0.0.1:8000/dev.html> 就能用真实对局数据驱动前端，不必反复进游戏。
`?file=` 选文件、`?speed=` 调倍速；页面内 `v` 常显、`e` 编辑态、`b` 换背景。

两处实现上必须注意：

- **读取用流式 JSON 解码，不按行切**（`JSONDecoder.raw_decode` 增量扫描）。
  这样紧凑 JSONL 与历史遗留的多行格式都能读，不必判断格式。
- **解压用 `zlib.decompressobj(31)`，不用 `gzip` 模块**。被强杀的录制没有结尾标记，
  `gzip` 会在收尾时抛 `EOFError` 并**连同已缓冲的整块一起丢掉**——按 1MB 分块时大文件丢尾块，
  小文件一个字节都读不出来（实测 14KB 的录制读出 0 包）。
  `zlib` 遇到截断就停，已解出的照常给。

## 离线复算

排查净资产这类数值问题时，用 Node 直接 import **真实的**前端模块复算整局：

```js
import { CachePool } from ".../ui/js/cachepool.js";
import { EconTracker } from ".../ui/js/networth.js";
```

`ui/js/source.js` 顶层没有副作用，所以在 Node 里 import 是安全的。
**不要另写一份计算逻辑**，否则测的是复制品不是产品。

## 开发顺序（当初的路径，供参考）

1. 回放服务器 → 前端开发不用开游戏
2. 前端在浏览器里开发：缓存池 → 倒计时 → 事件解析/塔防状态机 → 面板 UI
   （拿真实游戏截图当背景调样式；Alt 在浏览器阶段用普通 keydown 模拟）
3. 并行装 Rust 工具链 + MSVC Build Tools
4. Tauri 壳：窗口/穿透/热键/GSI 监听/cfg 写入/价格表
5. 进游戏实测校准

**实机测试用 release 构建**：debug 版会带一个关不掉的控制台窗口
（`windows_subsystem = "windows"` 只在 release 生效）。
