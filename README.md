# dota2-game-helper2

基于 Dota 2 官方 GSI（Game State Integration）接口的桌面覆盖层，
在游戏中按住 **Alt** 显示 Dota Plus 才有的那几个倒计时。

> ✅ 功能已全部实现，并进游戏实测校准过：快速模式各符刷新间隔与正常模式一致；
> 净资产口径对照回放的官方"财产总和"逐条验证（开局 600、储藏处计入、
> 信使在途计入、中立物品不计）。
> v1 设计见 [docs/design-v1.md](docs/design-v1.md)、实施计划见 [docs/plan-v1.md](docs/plan-v1.md)；
> v2 设计见 [docs/design-v2.md](docs/design-v2.md)（眼位小地图、托盘与设置、日志与录制，尚未实施）。

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

交互只有一种：**按住 Alt 显示，松开隐藏**。平时屏幕上什么都没有。

## 为什么这是安全的

本项目是**纯接收器**：

- ❌ 不读游戏内存、不修改游戏文件、不注入进程、不 hook 图形 API、不模拟任何输入
- ✅ 只接收游戏通过 GSI **主动推送**的、**本来就对你可见**的数据

GSI 是 Valve 官方暴露的接口（罗技、雷蛇驱动用的同一套机制），
对局中只推送玩家本人的数据，设计上就无法用于获取隐藏信息。
Alt 检测采用被动轮询键盘状态，不注册热键、不拦截按键。

## 技术栈

- 壳：[Tauri 2](https://tauri.app/)（Rust），透明/无边框/置顶/鼠标穿透窗口
- 前端：vanilla JS + SVG，无框架
- 数据源：Dota 2 GSI（本地 HTTP 推送）
- 物品价格：[OpenDota constants API](https://docs.opendota.com/)，本地缓存

时间常数全部外置于 `constants/*.json`（正常/快速模式两套表），版本更新只改数据不改代码。

## 使用前提

- Dota 2 启动项加 `-gamestateintegration`（首次运行会自动写入 GSI 配置文件）
- 游戏需使用**无边框窗口**模式（独占全屏下任何非注入类悬浮层都无法显示，这是系统级限制）

## 开发

```bash
cargo build --manifest-path src-tauri/Cargo.toml   # 构建
python tools/replay.py                             # 回放服务器（用真实对局数据驱动前端）
```

回放服务器起好后打开 <http://127.0.0.1:8000/dev.html>，用真实 dump 调试前端，
不必反复进游戏。`?file=` 选 dump 文件、`?speed=` 调倍速；页面内 `v` 常显、`e` 编辑态、`b` 换背景。

装好之后常数表会落到 `%APPDATA%\dev.dota2helper2.app\constants\`，
**改 JSON 重启即可生效，不需要重新编译**。

## 参考

- [nocamles/dota2_amount_plugins](https://github.com/nocamles/dota2_amount_plugins) — GSI 缓存池与净资产计算思路
- 前作 [dota2-game-helper](https://github.com/shizzhang0/dota2-game-helper)（已归档）— 语音提示方案与常数硬编码的教训来源
