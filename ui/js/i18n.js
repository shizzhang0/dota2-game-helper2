import { isTauri } from "./source.js";

// 界面语言。词条走"常数外置"那套，和其他常数表同一个目录、同一套播种与补齐逻辑。
// 只覆盖这张设置卡片——覆盖层上一个字都没有，托盘那两条在 Rust 侧自己读。
const FALLBACK = "zh-CN";
const cache = {};
let dict = {}, fb = {};

function load(lang) {
  if (!cache[lang]) {
    cache[lang] = isTauri()
      ? window.__TAURI__.core.invoke("get_constants", { name: `lang.${lang}` })
      : fetch(`/constants/lang.${lang}.json`).then(r => r.json());
  }
  return cache[lang];
}

export async function loadLang(lang) {
  fb = await load(FALLBACK).catch(() => ({}));
  dict = lang === FALLBACK ? fb : await load(lang).catch(() => ({}));
}

/** 缺键回退中文，再缺才退成键名——漏翻的地方显示中文至少还是句人话。 */
export function t(key) {
  return dict[key] ?? fb[key] ?? key;
}

// 语言名用它自己的语言写：不需要翻译，也不会出现"英文界面上写着『英文』"这种事。
export const LANGS = [["zh-CN", "简体中文"], ["en", "English"]];
