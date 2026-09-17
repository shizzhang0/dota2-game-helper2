export function isTauri() { return !!window.__TAURI__; }

/** 浏览器分支读 `constants/` 下的文件。

    **相对路径，不能加前导斜杠。** 绝对的 `/constants/…` 在
    `https://<user>.github.io/dota2-game-helper2/` 这种子路径下会 404，
    而相对路径按页面所在目录解析，开发服务器和 Pages 两边都对，
    不需要任何可配的 base。见 design/overlay.md 的「数据源的第三个分支」。

    只收浏览器这一半：五个调用点的 Tauri 那一半各不相同（三处走 `get_constants`，
    价格表走 `get_item_prices`，版本走 `get_versions`），硬凑到一起反而难读。 */
export function fetchConstant(file) {
  return fetch(`constants/${file}`).then(r => r.json());
}

/** GSI 数据源。三条路：

    | 分支 | 用在哪 |
    |---|---|
    | Tauri 事件 | 正式版 |
    | SSE | 开发时的回放服务器（`tools/replay.py`） |
    | 静态回放 | GitHub Pages 的 live demo、截图流水线 |

    静态回放怎么触发：`?demo=<url>` 查询参数，或页面在加载 `main.js` **之前**
    设 `window.HELPER2_DEMO`。都不给就走 SSE——开发页一个字都不用改。 */
export function connectSource(onPacket) {
  if (isTauri()) {
    window.__TAURI__.event.listen("gsi", (e) => onPacket(e.payload));
    return;
  }
  const qs = new URLSearchParams(location.search);
  const demo = qs.get("demo") || window.HELPER2_DEMO;
  const speed = Number(qs.get("speed")) || 1;
  if (demo) {
    replayFile(demo, onPacket, speed, qs.get("loop") !== "0");
    return;
  }
  const file = qs.get("file");
  // SSE 这条也用相对路径，理由同 fetchConstant
  const url = `stream?speed=${qs.get("speed") || "8"}` + (file ? `&file=${file}` : "");
  const es = new EventSource(url);
  es.onmessage = (m) => onPacket(JSON.parse(m.data));
}

/** 录制里没有可用的 clock 时，退回这个间隔（真实 GSI 约 10 包/秒）。 */
const TICK_MS = 100;

/** 按录制里的 `map.clock_time` 还原播放速度。

    **不能用固定间隔。** 实测那份 demo 是 586 包覆盖 400 秒游戏时间，
    也就是约 0.68 秒一包；按 100ms 喂会快 7 倍，倒计时肉眼可见地飞。

    取的是全程平均而不是逐包 delta：clock 只有整秒精度、一秒里常有好几包，
    按 delta 走会一顿一顿的，而平均值既对得上真实时长又平滑。 */
function tickFromClocks(packets) {
  const clocks = packets.map(p => p?.map?.clock_time).filter(c => typeof c === "number");
  if (clocks.length < 2) return TICK_MS;
  const span = clocks[clocks.length - 1] - clocks[0];
  return span > 0 ? (span * 1000) / (packets.length - 1) : TICK_MS;
}

/** 把一份 JSONL 逐行按节奏喂给管线。

    **整份先读进内存再放**，不做流式解析：demo 数据是剪过的两三分钟，
    体积在几 MB 量级，而流式解析要自己处理半行、要处理循环时的重连，
    换来的只是省下一次性的那点内存。

    **循环播放**（`?loop=0` 关掉）。循环回到开头时净资产会一下子跳回低位——
    这是回放而不是直播，如实呈现比假装连续好。 */
async function replayFile(url, onPacket, speed, loop) {
  let packets;
  try {
    const text = await (await fetch(url)).text();
    packets = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (e) {
    console.error("[source] 静态回放读不出来:", url, e);
    return;
  }
  if (!packets.length) return;
  const step = tickFromClocks(packets) / speed;
  let i = 0;
  const tick = () => {
    onPacket(packets[i++]);
    if (i >= packets.length) {
      if (!loop) return;
      i = 0;
    }
    setTimeout(tick, step);
  };
  tick();
}

export function onAltChange(cb) {
  if (isTauri()) {
    window.__TAURI__.event.listen("alt", (e) => cb(e.payload === true));
    return;
  }
  addEventListener("keydown", (e) => { if (e.key === "Alt") { e.preventDefault(); cb(true); } });
  addEventListener("keyup",   (e) => { if (e.key === "Alt") { e.preventDefault(); cb(false); } });
  addEventListener("blur", () => cb(false));
}
