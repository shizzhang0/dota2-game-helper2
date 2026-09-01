export function isTauri() { return !!window.__TAURI__; }

export function connectSource(onPacket) {
  if (isTauri()) {
    window.__TAURI__.event.listen("gsi", (e) => onPacket(e.payload));
    return;
  }
  const qs = new URLSearchParams(location.search);
  const file = qs.get("file"), speed = qs.get("speed") || "8";
  const url = `/stream?speed=${speed}` + (file ? `&file=${file}` : "");
  const es = new EventSource(url);
  es.onmessage = (m) => onPacket(JSON.parse(m.data));
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
