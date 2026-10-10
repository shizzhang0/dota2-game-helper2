# 开发工具：日志 · 对局录制 · 回放

## 日志：正式版原本等于没有

Rust 侧有 17 处 `println!`，但 `windows_subsystem = "windows"` 让正式构建**没有控制台**，
这些输出直接进虚空；前端一处 `console` 都没有，WebView2 的控制台在正式版也开不出来。
**出了问题只能靠猜。**

做法：写文件日志到配置目录 `logs/`。

- `logs/helper2.log` 当前，`logs/helper2.1.log` 上一份（超 5MB 轮转，只留一个备份）
- 一行一条：`<本地时间> [级别] <消息>`，例如 `2026-09-19 22:33:26 [INFO] [record] 开始录制 ...`

  > 2026-09-19 之前写的是 Unix 秒。机器友好，人不友好——查"那局录制怎么没了"的时候
  > 每一行都要手动换算，而这类排查恰恰全靠在时间线上对事件。
  > 用 `GetLocalTime` 直接取本地时间，不自己做时区换算（`windows` crate 已经是依赖，
  > 只多开一个 `Win32_System_SystemInformation` 特性）。
  > 轮转出去的 `helper2.1.log` 里可能还是旧格式，混着看不影响。
- 新建时写 UTF-8 BOM——日志是给人看的，中文 Windows 上有些工具不带 BOM 会认错编码
- **分级** `error` / `warn` / `info` / `debug`，级别写在 `settings.json` 里可改。
  默认 `info`（见 `settings.rs` 的 `defaults()`）。要看全量把它改成 `debug`
- **前端的错误要转发给 Rust 一起写**——否则正式版里前端一旦抛异常，面板直接空白且无声无息，
  这正是最难查的一类问题

日志的价值已经兑现过几次，比如"编辑态退不出去"那个 bug：日志里只有
`[edit] 编辑态 = true` 而没有配对的 `false`，一眼就知道退出压根没调到 Rust。

## 对局录制

设置里一个开关，开启后把每个 GSI 包落盘，用于事后回放调试。

**格式**：`records/raw_<时间戳>_m<对局号>.jsonl.gz`，每包一行紧凑 JSON，
与 `tools/gsi_dump.py` 同格式。

> 这一节原先写着"具体怎么用（自动清理、按对局分文件、导出等）等开发完再定，
> 目前只是最小实现"。那些**后来都做了**：按对局分文件（收尾时改名补上 `_m<对局号>`）、
> 设置里的统计与一键清空、断流看门狗、文件被外部删掉的检测。
> 完整的生命周期写在 [overlay.md 的「录制的生命周期」](overlay.md#录制的生命周期2026-09-16-重做)。
> **仍然不自动清理**——攒下来的录像是对账语料，程序不该替你决定哪份没用了。
>
> 收尾的几条路：回到主菜单、换局、**比赛结束 10 秒后**（2026-10-09）、断流 40 秒、程序退出、关开关。

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

### 回放倍速：日常 2 倍，抠细节 1 倍，别用 4 倍以上（2026-10-03 实测）

对账要靠看回放录（自己打时 GSI 只给自己、也不带官方净资产）。同一局 m9021653069 用 1/2/4/8/16 倍速
各录一遍做对照：

| 倍速 | 相邻两包（游戏秒） | 完全一致 | 平均\|差\| | 十人终值偏差 |
|---|---|---|---|---|
| 1 | 1~2 | **85.4%** | **15** | −50 |
| 2 | 2~3 | 82.7% | 20 | +384、−50 |
| 4 | 5 | 77.0% | 33 | +370、−100、−372 |
| 8 | 9~10 | 74.6% | 49 | −100、−1094 |
| 16 | 19~20 | 68.0% | 80 | −100、−200、−1600 |

**现在的游戏不论几倍速，都是约 1.2 秒真实时间推一包**（每真实秒 0.85 包），我们给 GSI 配的最短间隔
0.1 秒远没用满，所以这不是配置能改的。倍速越高，买、合成、信使送达、卖出越容易挤进同一包，
"前后两包对比"的判断就越容易错。2 倍速时多出来的那个 +384 是「稀疏录制下的反悔退款」，
见 networth.md 的「无解的部分」。

> 判断录制用的倍速，要用**文件名里的开始时间和文件的修改时间**算真实时长，再和游戏时钟比。
> 只看 GSI 时间戳会算错：它是整秒，2 倍速时一秒里有好几包同一个时间戳。
> 9 月中旬的老录制按这个算是 2 倍速、每真实秒却有 3.3 包——那时的游戏推得更勤，原因不明。

> 放回放时不用盯着：客户端里开 2 倍速、最小化去做别的事即可。录制按对局分文件，
> 播完 40 秒内自动封口；同一局要录多遍，每遍之间在开发页把「记录对局数据」关掉再打开，
> 否则会接进同一个文件。

## 回放服务器 `tools/replay.py`

静态服务 `ui/` 与 `constants/`，并通过 SSE 重放 dump。
打开 <http://127.0.0.1:8000/dev.html> 就能用真实对局数据驱动前端，不必反复进游戏。
`?file=` 选文件、`?speed=` 调倍速；页面内 `v` / `Ctrl+Alt+F11` 切换「按住 Alt 才显示」（和卡片上的勾是同一个值）、`e` / `Ctrl+Alt+F10` 编辑态、`b` 换背景——两个热键和正式版一致，`v` / `e` 是简写。

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

### 顺手改掉 README 的徽章

版本号只在 `constants/patch.json` 里定义，README 顶部那枚 `Dota 2 | 7.41e`
徽章是它的产物——脚本写完 patch.json 就按正则把两份 README 的那一行替换掉。

**不要改成 shields.io 的动态徽章**（去 raw.githubusercontent 读 patch.json）。
那样确实省掉这一步，但代价是首屏多挂两个外部服务，任一不通就是一枚破图；
而这里换来的只是省掉一次本来就要跑的脚本里的一行替换。

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

## 发版

v1.4.0 起每版发三样：**安装包**（`*-setup.exe`，一键更新只认它）、**绿色版 zip**（exe + 两份 README）、
**`latest.json`**（一键更新读的清单）。安装包和 zip 各**另传一份不带版本号的**
（`dota2-game-helper2-setup.exe`、`dota2-game-helper2-portable.zip`）：项目主页和 README 的下载链接写的是
`releases/latest/download/<这个名字>`，永远指向最新版，发版不用改链接（2026-10-10）。步骤都在 [`tools/release.py`](../../tools/release.py) 里，
**本地和 GitHub Actions 用的是同一个脚本**。

### 平时：推 tag，Actions 自动发

1. `python tools/release.py bump 1.4.0` 改三处版本号（`Cargo.toml`、`Cargo.lock`、`tauri.conf.json`），
   再跑一次 `python tools/make_shots.py`（README 里卡片截图上有版本号），照常提 PR、CI 过了合进 main
2. 在 main 上打**带注释的 tag**，注释就是 Release 正文（只写 Changelog，见下），推上去：

   ```bash
   git tag -a v1.4.0 -F notes.md
   ```

   ```bash
   git push origin v1.4.0
   ```

3. [`release.yml`](../../.github/workflows/release.yml) 接手：核对 tag 和代码里的版本号一致 →
   `release.py build` → `release.py publish`（建 Release、传五个文件）→ `release.py verify`（下载回来核对）

签名私钥在仓库 Secrets 的 `TAURI_SIGNING_PRIVATE_KEY`。没有它流水线直接失败，不会发出一个没签名的安装包。

### 兜底：本地发

Actions 坏了，或者要本地先试打一个包：

```bash
python tools/release.py build
```

```bash
python tools/release.py publish notes.md
```

```bash
python tools/release.py verify 1.4.0
```

`build` 本地会去读 `~/.tauri/dota2-game-helper2.key`。产物在 `dist/release/`。

### build 做了什么

- **`ui/` 里有没进仓库的文件就不打**（`git ls-files --others ui`）。`frontendDist` 是整个 `ui/`，
  gitignore 挡不住打包——2026-10-08 开发页的测试截图和录像切片就这样被嵌进 exe（6.7MB 涨到 9.2MB）。
  开发素材固定放仓库根的 **`devdata/`**（不进仓库），回放服务器把 `/dev/…` 指到那里；
  原先是放在 `ui/dev/`、打包时挪出去再挪回来，一次中途被打断就丢在了临时目录里
- 用 Tauri 命令行打包（`cargo build` 只出 exe，不出安装包和签名），版本跟着 `Cargo.lock` 里的 `tauri` 走
  （现在 2.11.5）。第一次跑会自己下 NSIS 工具链
- exe 应约 **7.5MB**（v1.3.x 是 6.7MB，多的是更新插件的 HTTP 下载依赖；更新插件的 HTTPS 换成了
  Windows 自带的 SChannel，用默认的 rustls 会到 8.6MB）。大很多说明 `ui/` 里混进了别的东西
- 生成 `latest.json`：安装包下载地址 + `.sig` 签名原文

### 几条规矩

- **Release 正文只写 Changelog**（新增 / 修复 / 改动，一条一句），原因和数据写进提交信息和设计文档
  （用户 2026-10-09 定；PR 描述同理）。标题就是 `vX.Y.Z`
- 「检查更新」只读 tag；一键更新读最新 Release 里的 `latest.json`——**漏传它，装了安装版的人就收不到这一版**，
  所以 `publish` 五个文件缺一样就不发（不带版本号的两份漏了，主页的下载按钮就 404）

> **签名私钥** `~/.tauri/dota2-game-helper2.key`（没设密码）**不进仓库，要备份**；Secrets 里那份
> 读不出来，不能当备份。公钥写在 `tauri.conf.json` 的 `plugins.updater.pubkey`，装好的程序靠它验安装包。
> **私钥丢了，已经装了安装版的人就再也收不到一键更新**——换一把新钥匙签出来的包，旧程序验不过，
> 只能让他们手动下载重装一次。

## 开发顺序（当初的路径，供参考）

1. 回放服务器 → 前端开发不用开游戏
2. 前端在浏览器里开发：缓存池 → 倒计时 → 事件解析/塔防状态机 → 面板 UI
   （拿真实游戏截图当背景调样式；Alt 在浏览器阶段用普通 keydown 模拟）
3. 并行装 Rust 工具链 + MSVC Build Tools
4. Tauri 壳：窗口/穿透/热键/GSI 监听/cfg 写入/价格表
5. 进游戏实测校准

**实机测试用 release 构建**：debug 版会带一个关不掉的控制台窗口
（`windows_subsystem = "windows"` 只在 release 生效）。

## 文档约定

**README 双语（2026-09-09 完成）**：`README.md` 英文当默认入口、
`README.zh-CN.md` 中文，顶部互相加切换链接。仓库是公开的，英文当默认入口对陌生人更友好。

> **中文那份是源头，英文是译文。** 要改先改 `README.zh-CN.md`，再同步 `README.md`。
>
> 理由不是"中文更重要"，是**只能有一份当源头**，而这个项目的源头显然是中文：
> 设计文档、提交信息、代码注释全是中文，想法也是用中文成形的。反过来做，
> 中文 README 就成了英文的回译，措辞会一点点失真。
>
> **代价**：GitHub 默认展示英文那份，所以译文一旦落后，落后的正好是陌生人第一眼
> 看到的东西。防这个只有一条纪律——**改中文的那次提交里就把英文一起改掉**，
> 别留"回头补"。

**`docs/design/` 与 `docs/plans/` 不翻译。** 它们是开发笔记不是产品文档，
双语维护的成本换不来收益。这条线要划清楚，否则文档量会失控。
README 顶部已写明这一点，免得英文读者点进去发现全是中文。

**使用文档不存在，而且现在不写。** README 已经覆盖安装、设置、卸载。
单独的使用文档等**真有人问不明白**了再写——没有那个信号就写，写出来的是猜的困惑点，
不是真的困惑点。写的时候两份一起写，别指望事后补。
