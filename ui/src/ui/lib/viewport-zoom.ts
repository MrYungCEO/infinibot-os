const LS_KEY = "infinibot.viewport.zoom";

export type ViewportZoomSetting = "auto" | "0.65" | "0.7" | "0.75" | "0.8" | "0.85" | "0.9" | "0.95" | "1";

export function getViewportZoom(): ViewportZoomSetting {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    if (v && v !== "auto") return v as ViewportZoomSetting;
  } catch { /* ignore */ }
  return "auto";
}

export function applyViewportZoom(setting?: ViewportZoomSetting): void {
  const s = setting ?? getViewportZoom();
  const root = document.documentElement;
  if (s === "auto") {
    root.style.removeProperty("--ui-viewport-zoom");
    root.removeAttribute("data-viewport-scale");
  } else {
    root.style.setProperty("--ui-viewport-zoom", s);
    root.setAttribute("data-viewport-scale", "forced");
  }
}

export function setViewportZoom(setting: ViewportZoomSetting): void {
  try {
    if (setting === "auto") {
      window.localStorage.removeItem(LS_KEY);
    } else {
      window.localStorage.setItem(LS_KEY, setting);
    }
  } catch { /* ignore */ }
  applyViewportZoom(setting);
}
