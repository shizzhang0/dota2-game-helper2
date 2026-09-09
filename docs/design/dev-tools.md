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

## 常数同步 `tools/sync_constants.py`

Dota 更新后跑一次。四件事：找到 Dota 安装目录 → 从 VPK 里取出几份明文 KV →
重新生成 `constants/item_prices.json` 并打印差异 → 更新 `constants/patch.json`，
顺带筛出这一版更新日志里与我们建模的机制相关的条目。

为什么值得自己写 VPK 解析、而不是接着用 OpenDota：见
[networth.md 的「价格源」](networth.md#价格源)。为什么只在开发机上做、
发布的 exe 里没有这段：同一节。

### VPK v2 目录格式

`pak01_dir.vpk` 只有目录树，真正的数据在 `pak01_NNN.vpk` 里。

头部：magic `0x55aa1234` + version + treeSize，v2 后面还有 20 字节（用不到，跳过）。
树是三层 NUL 结尾字符串的嵌套，每层以空字符串收尾：

```
扩展名\0 { 路径\0 { 文件名\0 <18 字节元数据> } }
```

元数据 = `crc(4) preloadBytes(2) archiveIndex(2) offset(4) length(4) 0xffff(2)`。
取文件：打开 `pak01_{archiveIndex:03d}.vpk`，seek 到 `offset` 读 `length`。

> **`preloadBytes` 不为 0 时，紧跟着就有那么多字节的内嵌数据，必须读掉再往下解析。**
> 漏掉它不会报错，只会从那一条起整棵树错位成乱码——扫描全表时这是唯一一个
> 静默失败的地方。实测 384004 个条目、整棵树 21MB，全扫一遍不到一秒，
> 所以不必做索引，每次重扫就行。

### 取哪几份

| 文件 | 拿什么 |
|---|---|
| `scripts/npc/items.txt` | `ItemCost` / `ItemQuality` / `ItemInitialCharges` |
| `scripts/npc/npc_ability_ids.txt` | 物品名 → id（GSI 的购买事件只给 id） |
| `resource/localization/patchnotes/patchnotes_english.txt` | 版本号 + 这一版的条目 |

都是明文 KV，正则扫一遍就够，不必写完整的 KV 解析器。`items.txt` 里物品是
`\t"item_xxx"\n\t{ ... \n\t}` 这种一级缩进的块，按缩进切块最省事。

### 版本号从更新日志里推

patchnotes 的键长这样：`DOTA_Patch_7_41e_item_heart`。把里面的 `7_41e` 这类
token 全捞出来取最大的，就是当前版本。

**不能用 `steam.inf`**：那里只有 `ClientVersion=6924` 和 `VersionDate=Sep 04 2026`，
人读不出"7.41e"，而这个版本号的全部用处就是给人看的。

> 排序按 `(主, 次, 字母)` 解析后比，不按字符串。现在的次版本号都是两位补零
> （`7_06d`），字符串比恰好也对，但 `7_9` 和 `7_10` 字符串比会反，别指望补零一直保持。

### 输出什么

价格差异是自动结论，直接看：改了几项、新增几项、消失几项。
更新日志那部分是**给人读的清单**——脚本按符 / 肉山 / 塔 / 战鼓 / 买活 / 莲花 /
智慧 / 赏金 / 野怪 / 信使 / 折磨兽这些关键词筛，命中的条目打出来，
人读完决定要不要动 `normal.json` / `turbo.json` / `towers.json`。
符刷新间隔这类东西不在物品表里，只能这么办。

实测 7.41e 共 161 条，命中的只有一条（折磨兽弹道）——**"这一版不用动计时表"
本身就是脚本该给出的结论**，免得每次补丁都从头翻一遍日志。

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
