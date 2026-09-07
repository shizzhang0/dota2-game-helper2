# dota2-game-helper2

基于 Dota 2 官方 GSI（Game State Integration）接口的桌面覆盖层，
在游戏中按住 **Alt** 显示 Dota Plus 才有的那几个倒计时。

> **开发中，尚未发布。** 下面列出的功能都已实现，但仍在逐项进游戏核对，
> 版本号停在 `0.1.0`，还没有打过 tag。
>
> 已核对：快速模式各符刷新间隔与正常模式一致；净资产口径对照回放的官方"财产总和"
> 逐点验证（2026-09-07 取七个时间点全部吻合）；敌方塔防状态机 16/16 回归通过。
> **眼位小地图尚未在真实对局里验证过**，它是靠三局 dump 离线开发的。
>
> 设计文档按主题组织在 [docs/design/](docs/design/)：
> [倒计时](docs/design/timers.md) · [净资产](docs/design/networth.md) ·
> [眼位小地图](docs/design/wards.md) · [程序外壳](docs/design/overlay.md) ·
> [开发工具](docs/design/dev-tools.md)。
> 待验证事项见 [docs/verify-checklist.md](docs/verify-checklist.md)，
> 未完成事项见 [docs/backlog.md](docs/backlog.md)。

## 显示什么

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
显示项开关、面板缩放、整体透明度、眼位地图大小、恢复默认摆位、眼位地图图例、
日志级别、对局录制开关。
改动即时生效，不需重启。卡片自己也能拖，抓它顶部的标题栏。

设置和摆位放在同一个状态里是有原因的：面板平时藏着，
如果设置做成独立窗口，调缩放和透明度就成了盲调。

编辑态下覆盖层会接管整屏鼠标（否则拖不动块），所以退出留了三条路：
**卡片上的「完成」按钮 · ESC · 再按一次 `Ctrl+Alt+F10`**。

> ESC 是前端监听的，没有注册成全局热键——那样会劫持游戏内的菜单键。

配置文件都在 `%APPDATA%\dev.dota2helper2.app\`：

| | |
|---|---|
| `constants/` | 时间常数表 + 物品价格表 + 价格覆盖表，改 JSON 重启生效 |
| `settings.json` | 上述设置 |
| `layout.json` | 四个块各自的位置 |
| `logs/` | 运行日志 |
| `records/` | 对局录制（默认关闭） |

## 技术栈

- 壳：[Tauri 2](https://tauri.app/)（Rust），透明/无边框/置顶/鼠标穿透窗口
- 前端：vanilla JS + SVG，无框架
- 数据源：Dota 2 GSI（本地 HTTP 推送）
- 物品价格：本地常数表（快照取自 [OpenDota](https://docs.opendota.com/)）+ 覆盖表，**运行时不联网**

时间常数全部外置于 `constants/*.json`（正常/快速模式两套表），版本更新只改数据不改代码。

**物品价格也能自己改。** 价格表是本地常数（`constants/item_prices.json`，
跑 `python tools/fetch_prices.py` 随版本更新），程序运行时不发任何网络请求。
而 OpenDota 的价格会落后于游戏版本（实测龙心游戏收 5200、
它还写着 5100），所以 `constants/item_price_overrides.json` 可以按「物品名: 实际价格」
覆盖，重启生效。发现净资产差了某件装备的钱时，往这里加一行就行——
上游修好后删掉，程序会在日志里提示哪些覆盖已经多余。

## 使用前提

- Dota 2 启动项加 `-gamestateintegration`（首次运行会自动写入 GSI 配置文件）
- 游戏需使用**无边框窗口**模式（独占全屏下任何非注入类悬浮层都无法显示，这是系统级限制）

## 开发

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml   # 构建
python tools/replay.py                                       # 回放服务器
```

回放服务器起好后打开 <http://127.0.0.1:8000/dev.html>，用真实 dump 驱动前端，
不必反复进游戏。`?file=` 选文件、`?speed=` 调倍速；页面内 `v` 常显、`e` 编辑态、`b` 换背景。
录制出来的 `.jsonl.gz` 可以直接喂给它，被强杀而截断的文件也能读。

**前端是编译期嵌入二进制的**，改完 `ui/` 下的文件必须重新 `cargo build` 才会生效
（`build.rs` 会盯着 `ui/`，不需要额外操作）。

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
