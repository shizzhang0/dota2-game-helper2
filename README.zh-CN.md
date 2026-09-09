<h1><img src="src-tauri/icons/64x64.png" width="28" height="28" align="absmiddle" alt=""> dota2-game-helper2</h1>

[English](README.md) · **简体中文**

[![CI](https://github.com/shizzhang0/dota2-game-helper2/actions/workflows/ci.yml/badge.svg)](https://github.com/shizzhang0/dota2-game-helper2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey.svg)

基于 Dota 2 官方 GSI（Game State Integration）接口的桌面覆盖层，
在游戏中按住 **Alt** 显示游戏界面上没有画出来的那几个倒计时。

**为什么会有这个项目**：赏金符、莲花、智慧神符、敌方塔防和买活的计时，
客户端里哪儿都不显示，只能靠自己记。但这些信息**本来就在游戏推给你的数据里**，
只是没画在屏幕上——那就把它画出来。不读内存、不改文件、不模拟输入，
只接收游戏主动推送的、本来就对你可见的数据（[为什么这是安全的](#为什么这是安全的)）。

![覆盖层实拍](docs/images/overlay.png)

<sub>左上是净资产 / GPM / XPM，左下是眼位小地图（青=我方、紫=敌方、空心=真眼、
琥珀=60 秒内到期），右上是各类倒计时，右下是敌方塔防与买活。
背景是回放工具里的占位色，不是真实游戏画面。</sub>

## 快速开始

1. 在 [Releases](https://github.com/shizzhang0/dota2-game-helper2/releases) 下载
   压缩包，解压到任意目录（没有安装程序，就一个 exe）
2. 给 Dota 2 的启动项加上 `-gamestateintegration`
3. 游戏用**无边框窗口**模式（独占全屏下任何非注入类悬浮层都无法显示，系统级限制）
4. 双击 `dota2-game-helper2.exe`，它会常驻通知区。首次运行自动写入 GSI 配置文件
5. 进对局，**按住 Alt** 就能看到面板

想调位置、大小、显示哪几项：右键通知区图标 →「编辑面板」（或按 `Ctrl+Alt+F10`）。

> 首次运行后如果面板一直不出现，先确认第 2、3 步；再看
> `%APPDATA%\dev.dota2helper2.app\logs\` 里的日志。

## 功能

| 项目 | 说明 |
|---|---|
| 中路符时间线 | 0:00 赏金 → 2:00 / 4:00 圣水 → 6:00 起每 2 分钟强化符 |
| 赏金符 | 每 3 分钟 |
| 智慧神符 | 7:00 起每 7 分钟 |
| 莲花 | 3:00 起每 3 分钟 |
| 堆野窗口 | 野怪每整分钟刷新，倒数提醒 |
| 敌方塔防 | 冷却/就绪状态，含"丢首座 T1/T2/T3/近战兵营即刷新"的完整规则 |
| 敌方买活 | 各敌方玩家的买活冷却（480s），游戏只播报瞬间、这里保留状态 |
| 经济面板 | 自己的净资产（近似）/ GPM / XPM |
| 眼位小地图 | 我方眼的到期倒计时与被排提示；敌方眼只标位置 |

游戏中交互只有一种：**按住 Alt 显示，松开隐藏**。平时屏幕上什么都没有。

每项都能在设置里单独关掉。

### 关于敌方眼为什么不带倒计时

只有真眼照到的那十几秒里才看得见敌方的眼，**根本无从得知它是什么时候插的**——
可能刚插，也可能还剩十秒。一个可能虚高五分钟的倒计时会误导决策，
而"那里有眼"这一条信息本身就够用了（别从这走 / 去排掉它）。

## 为什么这是安全的

本项目是**纯接收器**：

- ❌ 不读游戏内存、不修改游戏文件、不注入进程、不 hook 图形 API、不模拟任何输入
- ✅ 只接收游戏通过 GSI **主动推送**的、**本来就对你可见**的数据

GSI 是 Valve 官方暴露的接口（罗技、雷蛇驱动用的同一套机制），
对局中只推送玩家本人的数据，设计上就无法用于获取隐藏信息。
Alt 检测采用被动轮询键盘状态，不注册热键、不拦截按键。

## 设置

程序常驻通知区（托盘），右键菜单只有两项：

```
编辑面板      ← 左键单击图标同样是这个
──────────
退出
```

**「编辑面板」进入编辑态**（快捷键 `Ctrl+Alt+F10`）：四个块——**倒计时 / 敌方 / 净资产 /
眼位地图**——强制常显、各自可以拖到想要的位置，同时浮出一张设置卡片：
显示项开关、语言、面板缩放、整体透明度、底板不透明度、眼位地图大小、重置、
眼位地图图例、日志级别、对局录制开关。
改动即时生效，不需重启。卡片自己也能拖，抓它顶部的标题栏。

设置和摆位放在同一个状态里是有原因的：面板平时藏着，
如果设置做成独立窗口，调缩放和透明度就成了盲调。

编辑态下覆盖层会接管整屏鼠标（否则拖不动块），所以退出留了三条路：
**卡片上的「完成」按钮 · ESC · 再按一次 `Ctrl+Alt+F10`**。

> ESC 是前端监听的，没有注册成全局热键——那样会劫持游戏内的菜单键。

配置文件都在 `%APPDATA%\dev.dota2helper2.app\`：

| | |
|---|---|
| `constants/` | 时间常数表 + 物品价格表 + 语言包，改 JSON 重启生效 |
| `settings.json` | 上述设置 |
| `layout.json` | 四个块各自的位置 |
| `logs/` | 运行日志 |
| `records/` | 对局录制（默认关闭） |

### 卸载

没有安装包，也就没有卸载程序——删三样东西即可：

1. `dota2-game-helper2.exe`
2. 配置目录 `%APPDATA%\dev.dota2helper2.app\`
3. Dota 的 `game\dota\cfg\gamestate_integration\` 里那个
   `gamestate_integration_helper2.cfg`

## 技术栈

- 壳：[Tauri 2](https://tauri.app/)（Rust），透明/无边框/置顶/鼠标穿透窗口
- 前端：vanilla JS + SVG，无框架
- 数据源：Dota 2 GSI（本地 HTTP 推送）
- 物品价格：本地常数表（快照取自游戏本体自己的数据文件），**运行时不联网、也不读游戏文件**

所有常数都外置于 `constants/*.json`——时间表（正常/快速模式两套）、物品价格、语言包。
版本更新只改数据不改代码，上一个项目正是死于把常数写死在代码里。

`constants/patch.json` 记着这份常数对齐到哪个 Dota 版本：

```json
{ "dota": "7.41e", "synced": "2026-09-09" }
```

**物品价格也能自己改。** 发现净资产差了某件装备的钱，直接改配置目录里的
`constants/item_prices.json`，重启生效——盘上的值盖过程序内置的那份。
（下次程序跟着 Dota 版本更新时，这张表会被整个换成新的，手改的值不保留：
价格随补丁变，留着旧值只会盖住对的。时间表不受影响。）

价格表由 `python tools/sync_constants.py` 从**游戏自己的文件**生成：价格取
`scripts/npc/items.txt` 的 `ItemCost`，物品 id 取 `npc_ability_ids.txt`。
这是开发机上的一步，发布出去的 exe 里没有这段解析，也不会去翻 Dota 的安装目录取价格——
用户拿到的是一份确定的常数，出了差额我们才能知道他用的是哪一版。

## 开发

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml   # 构建
python tools/replay.py                                       # 回放服务器
python tools/sync_constants.py                               # 跟随 Dota 版本更新常数
```

Dota 更新后跑一次 `sync_constants.py`：它从本机 Dota 的 VPK 里重新生成价格表、
更新 `constants/patch.json` 的版本号，并打印两样东西——价格相对上一版的差异，
以及这一版更新日志里命中符 / 肉山 / 塔防 / 买活 / 莲花 / 堆野等机制的条目。
价格是自动的；那些条目要人读一遍，据此决定要不要动 `normal.json` / `turbo.json` /
`towers.json`——符刷新间隔这类东西不在游戏的物品表里。

回放服务器起好后打开 <http://127.0.0.1:8000/dev.html>，用真实 dump 驱动前端，
不必反复进游戏。`?file=` 选文件、`?speed=` 调倍速；页面内 `v` 常显、`e` 编辑态、`b` 换背景。
录制出来的 `.jsonl.gz` 可以直接喂给它，被强杀而截断的文件也能读。

设计文档按主题组织在 [docs/design/](docs/design/)：
[倒计时](docs/design/timers.md) · [净资产](docs/design/networth.md) ·
[眼位小地图](docs/design/wards.md) · [程序外壳](docs/design/overlay.md) ·
[开发工具](docs/design/dev-tools.md)；未完成事项见
[docs/backlog.md](docs/backlog.md)，待验证事项见
[docs/verify-checklist.md](docs/verify-checklist.md)。这些是开发笔记，只有中文。

**前端是编译期嵌入二进制的**，改完 `ui/` 下的文件必须重新 `cargo build` 才会生效
（`build.rs` 会盯着 `ui/` 和 `icons/`，不需要额外操作）。

每次 push 与 PR 都会在 GitHub Actions 上跑一遍前端语法检查 + `cargo build --release`
（见 `.github/workflows/ci.yml`）——`ui/` 下写错一个字符只有真正编译时才暴露，
而日常开发看的是回放服务器，那条路不经过编译。

实机测试用 **release** 构建：debug 版会带一个关不掉的控制台窗口
（`windows_subsystem = "windows"` 只在 release 生效）。

出问题先看 `%APPDATA%\dev.dota2helper2.app\logs\`——正式版没有控制台，
也开不出 devtools，前端异常会转发给 Rust 一起写进日志。

## 许可

[MIT](LICENSE)

本项目与 Valve 无关联。Dota 2 是 Valve Corporation 的商标。

## 参考

- [nocamles/dota2_amount_plugins](https://github.com/nocamles/dota2_amount_plugins) — GSI 缓存池与净资产计算思路
- 前作 [dota2-game-helper](https://github.com/shizzhang0/dota2-game-helper)（已归档）— 语音提示方案与常数硬编码的教训来源
