import { SHOW_KEYS, DEFAULTS, loadSettings, saveSettings, onSettingsChange } from "./settings.js";
import { isTauri, fetchConstant } from "./source.js";
import { checkUpdate, lastUpdate, onUpdate, openReleasePage } from "./update.js";
import { icon, CELL_ICON } from "./icons.js";
import { t, loadLang, LANGS } from "./i18n.js";
import { minimapOpts, onDotaHud, MINIMAP_MODES } from "./dotahud.js";
import { wardIcon, crossIcon } from "./wardmap.js";

// 编辑态的设置卡片。与 .block 平级而非其子节点——块按屏高缩放（--panel-scale），
// 卡片跟着缩到 2× 或 0.8× 都没法用。
//
// 卡片自己也能拖，但**只能靠顶部标题栏**：拖拽要 setPointerCapture，
// 而它会把 pointerup 改派到捕获元素，click 便落不到内部的按钮上。
// 整块可拖会打死「完成」按钮、复选框和下拉框——
// 「完成」失效等于编辑态出不去。见 design/overlay.md 的第 3 号坑。
let card = null, doneCb = null;

/** 重拉录制统计。由 `initRecords` 装上，打开卡片和拨录制开关时调用——见那里的注释。 */
let recRefresh = null;

/** 刷新小地图那一行括号里"读到了什么"。Dota 的设置是异步读回来的（启动、每局开始），
    读到时卡片可能已经建好了，要能事后改。每次 build 换成新的那一份。 */
let mmRefresh = null;
onDotaHud(() => mmRefresh?.());

/** 显示项那九行前面的图标——卡片因此同时是设置和图例，一份数据两用。
    每行一个图标，眼位也不例外：曾经放过"眼 + 塔"两个（想表达那块地图画了哪两类
    东西），但九行里只有它是两个，反而不齐。塔图标仍留在 icons.js 里，
    将来眼位图例那一节要用。 */
function showIcon(k) {
  if (k === "mid") return icon("bounty", 13);   // 中路符取它的首个阶段
  if (k === "wardmap") return icon("eye", 13);
  return icon(CELL_ICON[k], 13);
}

// 眼位图例，挂在显示项「眼位」那一行下面。刻意复用地图自己的画法（wardIcon 和 crossIcon）——
// 另写一套形状颜色迟早会和地图对不上。只剩这三样：塔和我方眼原生小地图就画着，我们不画。
const LEGEND = [
  [wardIcon("observer", 5, 5, 1.9), "enemyObs"],
  [wardIcon("sentry", 5, 5, 1.9),   "enemySentry"],
  // 被排的是叉不是点——图例必须跟着地图的形状走，否则这张卡片就骗人了
  [crossIcon(5, 5, 2.8),            "killed"],
];
const legendHTML = () => LEGEND.map(([shape, key]) =>
  `<span><svg viewBox="0 0 10 10" aria-hidden="true">${shape}</svg>${t("legend." + key)}</span>`).join("");

/** 开发区那两行版本号。只读，用户报"数字不对"时直接念给我们听——
    价格表旧了的症状是净资产看起来正常但偏低，没有任何报错。

    整个进程只取一次：切语言会重建整张卡片，而版本号在运行期不会变。
    取不到就留着破折号，这是排查信息，**不该因为它取不到而让卡片建不出来**。 */
let verOnce = null;
function versions() {
  if (!verOnce) {
    verOnce = (isTauri()
      ? window.__TAURI__.core.invoke("get_versions")
      // 浏览器开发时没有 Tauri，也就没有"程序版本"这个东西；价格表版本还是照读
      : fetchConstant("patch.json").then(v => ({ app: "dev", dota: v.dota }))
    ).catch(() => ({}));
  }
  return verOnce;
}

const MB = 1024 * 1024;
/** 体积按 MB 给一位小数；不到 0.1MB 的显示 <0.1，别写成 0.0 让人以为是空的。 */
function mb(bytes) {
  const v = bytes / MB;
  return (v > 0 && v < 0.05 ? "<0.1" : v.toFixed(1)) + " MB";
}

/** 开发区的录制那一组：一行统计 + 一个清空按钮。

    **清空要点两下。** 第一下把按钮文字换成"确定删除？"，第二下才动手，
    5 秒无操作自动退回。录像不可再生——打过的对局回不来——所以这一下值得。
    不用 `confirm()`：它会弹一个抢焦点的系统框，而编辑态本来就在跟焦点较劲。 */
function initRecords(stat, btn) {
  if (!isTauri()) { stat.textContent = "—"; btn.disabled = true; return; }
  const inv = (cmd) => window.__TAURI__.core.invoke(cmd);
  const label = btn.textContent;
  let armed = 0, timer = 0;

  const show = (s) => {
    // 单位跟着语言走。**别在 JS 里写死"个"**——英文那份会变成 "3 个 · 12.0 MB"。
    stat.textContent = s && s.count ? `${s.count}${t("card.recUnit")} · ${mb(s.bytes)}` : "—";
    btn.disabled = !(s && s.count);
  };
  const disarm = () => { armed = 0; clearTimeout(timer); btn.textContent = label; };
  const refresh = () => inv("records_stat").then(show).catch(() => show(null));
  // 装出去给 setEditorOpen 和录制开关用。
  //
  // **这个数字原先只在程序启动那一刻拉过一次。** 打开/关闭卡片走的是
  // `card.hidden`，不重建也不重拉，于是开着程序打了三局再去看，显示的还是
  // 启动时的数字——而那恰恰是最想看它的时候（想确认刚才那局录下来没有）。
  //
  // 不做轮询：这个数字只有卡片开着时有人看，开的那一刻拉一次就够，
  // 代价是一次 readdir。
  recRefresh = refresh;

  btn.addEventListener("click", async () => {
    if (!armed) {
      armed = 1;
      btn.textContent = t("card.clearRecConfirm");
      timer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    // 留下的那个是正在录的——不提示反而像没删干净，所以把它说出来
    const r = await inv("clear_records").catch(() => null);
    if (r && r.kept) stat.textContent = t("card.recKept");
    else await refresh();
    if (r && r.kept) setTimeout(refresh, 2500);
  });
  refresh();
}

/** 开发区的检查更新：版本号旁边的 NEW、两个按钮、一行状态。设计见 design/overlay.md「检查更新」。

    启动那次由 main.js 发起，这里只负责显示——**卡片可能在结果回来之前或之后建**，
    切语言还会整卡重建，所以建的时候先套用 `lastUpdate()`，再订阅之后的变化。
    订阅在模块级只留一份：重建时先退掉旧的，不然每切一次语言多挂一个监听。 */
let offUpdate = null;
function initUpdate(badge, msg, checkBtn, relBtn) {
  if (!isTauri()) { checkBtn.disabled = true; return; }
  const text = { checking: "card.updChecking", latest: "card.updLatest",
                 new: "card.updNew", fail: "card.updFail" };
  const show = (r) => {
    if (!r) return;
    msg.textContent = text[r.state] ? t(text[r.state]) : "";
    checkBtn.disabled = r.state === "checking";
    if (r.state === "new") {
      badge.hidden = false;
      badge.textContent = `NEW ${r.version}`;
    } else if (r.state === "latest") {
      badge.hidden = true;
    }
    // 失败时 NEW 不动：之前查到过的新版不会因为这次没连上就不存在了。
    // 「打开下载页」只在有新版本时出现，顶替「检查更新」的位置——平时它用不上，摆着只占地方
    relBtn.hidden = badge.hidden;
    checkBtn.hidden = !badge.hidden;
    // 一切正常（已是最新）就不再多写一行"已是最新"，版本号旁边没有 NEW 已经说明了
    if (r.state === "latest" || r.state === "new") msg.textContent = "";
  };
  offUpdate?.();
  offUpdate = onUpdate(show);
  show(lastUpdate());
  checkBtn.addEventListener("click", () => checkUpdate());
  // 先退出编辑态：编辑态下覆盖层置顶且不穿透鼠标，打开的浏览器被压在下面点不到
  relBtn.addEventListener("click", () => { doneCb?.(); openReleasePage(); });
}

export async function initEditor(cardEl, onDone) {
  card = cardEl; doneCb = onDone;
  await build(await loadSettings());
  // **「始终显示」还能从卡片外面改**（Ctrl+Alt+F11、托盘、网页里的 v 键），勾要跟着变。
  // 不跟的话卡片攥着旧值，进编辑态随便动一下别的，collect() 就把旧值存回去，
  // 刚切的状态被悄悄改回。**只同步这一个**：其余控件只有卡片自己改，而改控件时
  // settings 事件是异步回来的，套回去控件会往回跳。按 id 现查，切语言会整卡重建。
  onSettingsChange((v) => {
    const el = card.querySelector("#edAlways");
    if (el && typeof v?.alwaysShow === "boolean") el.checked = v.alwaysShow;
  });
}

/** 建卡片和绑事件必须是同一个函数：切语言要整个 innerHTML 重建，
    而重建会换掉所有节点——包括 .ed-bar 那个拖拽把手。只重建不重绑就把卡片钉死了。 */
async function build(s) {
  await loadLang(s.lang ?? DEFAULTS.lang);
  card.className = "editor";
  // **一页，不分页签**（2026-10-09）。原先分四页（显示项 / 面板 / 图例 / 开发）是因为
  // 内容多，堆成一条要 475~754px；删掉四个滑块、图例只剩三条之后，常用的一页放得下。
  // 下半部分是一张两列的表：左边标签、右边控件，控件左对齐、下拉框一样宽。
  // 日志级别和「打开数据目录」放一行——用户报问题时就是"调高日志级别、打开目录把日志发过来"。
  // 版本单独一行放在最后，有新版本时在那儿出 NEW 和下载按钮。
  // 「开发」（录制）只在 settings.json 里有 `devTools: true` 时才建，没有就整节不出现；
  // 不在卡片里放 devTools 的开关——录制刻意不让普通用户看到，见 design/overlay.md「开发区」。
  card.innerHTML = `
    <div class="ed-bar">${t("card.title")}</div>
    <div class="ed-sec">${t("card.show")}</div>
    <div class="ed-grid">${SHOW_KEYS.map(k =>
      `<label class="ed-chk"><input type="checkbox" data-show="${k}"${
        s.show?.[k] !== false ? " checked" : ""
      }><span class="ed-ico">${showIcon(k)}</span>${t("show." + k)}</label>`).join("")}</div>
    <div class="ed-legend">${legendHTML()}</div>
    <div class="ed-sep"></div>
    <div class="ed-sec">${t("card.general")}</div>
    <div class="ed-form">
      <span>${t("card.alwaysShow")}</span>
      <label class="ed-chk" title="${t("card.alwaysShowHint")}">
        <input id="edAlways" type="checkbox"${s.alwaysShow ? " checked" : ""}>
        <span class="ed-note">${t("card.alwaysShowHint")}</span></label>
      <span>${t("card.lang")}</span>
      <select id="edLang">${LANGS.map(([v, name]) =>
        `<option value="${v}">${name}</option>`).join("")}</select>
      <span>${t("card.minimap")}</span>
      <div class="ed-chk"><select id="edMm">${MINIMAP_MODES.map(m =>
        `<option value="${m}">${t("card.mm." + m)}</option>`).join("")}</select>
        <span class="ed-note" id="edMmSrc"></span></div>
      <span>${t("card.logLevel")}</span>
      <div class="ed-chk"><select id="edLog">
          <option value="error">error</option><option value="warn">warn</option>
          <option value="info">info</option><option value="debug">${t("card.logDebug")}</option>
        </select>
        <button id="edDir" type="button">${t("card.openDir")}</button></div>
    </div>
    <div class="ed-sep"></div>
    <div class="ed-row ed-verline">
      <span class="ed-vertext">${t("card.version")} <b id="edAppVer">—</b> · Dota <b id="edDotaVer">—</b></span>
      <span class="ed-new" id="edNew" hidden></span>
      <button id="edUpd" type="button" class="ed-right">${t("card.checkUpdate")}</button>
      <button id="edRel" type="button" class="ed-right" hidden>${t("card.openRelease")}</button>
    </div>
    <div class="ed-upd-msg" id="edUpdMsg"></div>
    ${s.devTools ? `
    <div class="ed-sep"></div>
    <div class="ed-sec">${t("card.dev")}</div>
    <label class="ed-row"><input id="edRecord" type="checkbox">${t("card.record")}</label>
    <div class="ed-row ed-ver">${t("card.recFiles")}<b id="edRecStat">—</b>
      <button id="edClear" type="button">${t("card.clearRec")}</button></div>` : ""}
    <div class="ed-foot">
      <button id="edReset" type="button">${t("card.reset")}</button>
      <span class="ed-hint">${t("card.hint")}</span>
      <button id="edDone" type="button">${t("card.done")}</button>
    </div>`;

  const $ = (id) => card.querySelector("#" + id);
  const         log = $("edLog"), record = $("edRecord"), lang = $("edLang"),
        always = $("edAlways"), mm = $("edMm");
  log.value = s.logLevel ?? DEFAULTS.logLevel;
  // 录制那几行只在 devTools 为真时才建（见 design/overlay.md「开发区」），不建就是 null
  if (record) record.checked = !!s.recordMatches;
  always.checked = !!s.alwaysShow;
  lang.value = s.lang ?? DEFAULTS.lang;
  mm.value = MINIMAP_MODES.includes(s.minimap) ? s.minimap : "auto";
  // 「自动」时在后面写出读到的是什么（左下 · 普通），读不到也说一声——
  // 用户一眼就知道是不是读对了；读错了就手动选。手动选了就不写，选的就是答案。
  mmRefresh = () => {
    const o = minimapOpts({ minimap: mm.value });
    $("edMmSrc").textContent = !o.auto ? ""
      : o.fromDota ? `${t(o.right ? "card.mmPosRight" : "card.mmPosLeft")} · ${
          t(o.large ? "card.mmSizeLarge" : "card.mmSizeNormal")}`
      : t("card.mmUnread");
  };
  mmRefresh();

  const collect = () => ({
    show: Object.fromEntries([...card.querySelectorAll("[data-show]")]
      .map(el => [el.dataset.show, el.checked])),
    alwaysShow: always.checked,
    minimap: mm.value,
    logLevel: log.value,
    recordMatches: record ? record.checked : !!s.recordMatches,
    lang: lang.value,
  });

  // 建完再填：切语言会重建这两个节点，所以要等到这一刻才去拿它们
  versions().then(v => {
    const put = (id, val) => { const el = card.querySelector("#" + id); if (el && val) el.textContent = val; };
    put("edAppVer", v.app);
    put("edDotaVer", v.dota);
  });
  for (const el of card.querySelectorAll("input, select")) {
    el.addEventListener("input", () => saveSettings(collect()));
  }
  mm.addEventListener("input", () => mmRefresh());
  // 拨录制开关会新建或收尾一个文件，数字跟着变。**延后一点再拉**：
  // saveSettings 在 Tauri 下是异步 invoke，Rust 那边要先 refresh() 完才有结果。
  record?.addEventListener("input", () => setTimeout(() => recRefresh?.(), 300));
  // 语言换了整卡重建。用手上这份设置重建，不重新 loadSettings()——
  // 上面那次保存在 Tauri 下是异步的 invoke，读回来可能还是旧的 lang。
  lang.addEventListener("change", async () => {
    const next = collect();
    await saveSettings(next);
    // 重建要带上卡片不收的键（devTools）：只用 collect() 的话，录制那几行切完语言就没了
    await build({ ...s, ...next });
    if (!card.hidden) place();   // 中英文卡片不一样高
  });

  // 「重置」把这张卡片管的外观一次还原：九个勾 + 始终显示 + 小地图回到「自动」。
  // （块的位置 2026-10-08 起跟着 Dota 的界面走、不能拖，也就没有摆位要还原了。）
  // **「始终显示」也还原成关**：它是外观行为、和显示项同类，而"按住 Alt 才显示"
  // 是产品的默认形态；还原它不会造成任何数据损失。
  // 开发区那两项不动——悄悄关掉正在录的对局，用户不会知道自己丢了数据。
  // **语言也不动**：重置回中文会让看不懂中文的用户无法退出这个状态，
  // 用户得先猜出哪一行是语言、再猜哪个选项是英文。可恢复性是重置的前提。
  $("edReset").addEventListener("click", () => {
    for (const el of card.querySelectorAll("[data-show]")) el.checked = DEFAULTS.show[el.dataset.show];
    always.checked = DEFAULTS.alwaysShow;
    mm.value = DEFAULTS.minimap;
    mmRefresh();
    saveSettings(collect());
  });
  // 先退出编辑态再开：编辑态下覆盖层置顶且不穿透鼠标，资源管理器被压在下面点不到
  $("edDir").addEventListener("click", () => {
    doneCb?.();
    if (isTauri()) window.__TAURI__.core.invoke("open_data_dir");
  });
  if (record) initRecords($("edRecStat"), $("edClear"));
  else recRefresh = null;
  initUpdate($("edNew"), $("edUpdMsg"), $("edUpd"), $("edRel"));
  $("edDone").addEventListener("click", doneCb);

  const bar = card.querySelector(".ed-bar");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  bar.addEventListener("pointerdown", (ev) => {
    dragging = true; bar.setPointerCapture(ev.pointerId);
    sx = ev.clientX; sy = ev.clientY;
    ox = parseFloat(card.style.left) || 0; oy = parseFloat(card.style.top) || 0;
  });
  bar.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    card.style.left = `${ox + ev.clientX - sx}px`;
    card.style.top  = `${oy + ev.clientY - sy}px`;
  });
  bar.addEventListener("pointerup", (ev) => {
    if (!dragging) return;
    dragging = false; bar.releasePointerCapture(ev.pointerId);
  });
}

/** 每次进编辑态回到屏幕中央偏下。位置不存盘——拆块之后没有"面板"这个唯一锚点，
    与其猜一个，不如每次给个确定的起点，要挪自己拖。 */
function place() {
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = `${Math.round(Math.max(8, (innerWidth - w) / 2))}px`;
  card.style.top  = `${Math.round(Math.max(8, Math.min(innerHeight * 0.6, innerHeight - h - 8)))}px`;
}

export function setEditorOpen(on) {
  if (!card) return;
  card.hidden = !on;          // 必须先取消隐藏再量尺寸，hidden 时 offsetWidth 为 0
  if (on) { place(); recRefresh?.(); }
}
