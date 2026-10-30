/**
 * Plugin appearance — browser-side SDK helper for plugin UIs.
 *
 * The control UI puts every plugin surface (page, sub-view, widget, panel)
 * inside a scope container `[data-plugin-scope="<id>"]` that carries the
 * plugin's resolved appearance as CSS custom properties for the active theme:
 *
 *   --plugin-accent, --plugin-tint, --plugin-surface, --plugin-space,
 *   --plugin-density-scale, --plugin-font-scale,
 *   --plugin-<id>-accent | -tint | -density | -font-scale | -layout-<opt>,
 *   the plugin's own declared --plugin-<id>-* variables,
 *   and (only when the owner changed the accent) scoped --g-primary & co.
 *
 * Styling with those variables is enough for most plugins. This module lets
 * plugin code read them as values, follow live changes, and — for sandboxed
 * iframe pages — receive them over the postMessage bridge.
 *
 * Pure DOM, no imports: safe to bundle into any plugin UI module.
 */

export const PLUGIN_APPEARANCE_EVENT = "infinibot-plugin-appearance";
export const PLUGIN_APPEARANCE_MESSAGE = "infinibot:plugin-appearance";

export type PluginAppearanceSnapshot = {
  pluginId: string | null;
  theme: "dark" | "light";
  accent: string;
  tint: string;
  density: "compact" | "comfortable";
  densityScale: number;
  space: string;
  fontScale: number;
  layout: Record<string, string>;
  vars: Record<string, string>;
};

export type PluginAppearanceBridgeMessage = {
  type: typeof PLUGIN_APPEARANCE_MESSAGE;
  pluginId: string;
  theme: "dark" | "light";
  vars: Record<string, string>;
};

/** Nearest plugin scope container, crossing shadow-root boundaries. */
export function findPluginScope(el: Element | null): HTMLElement | null {
  let node: Node | null = el;
  while (node) {
    if (node instanceof HTMLElement && node.hasAttribute("data-plugin-scope")) return node;
    const parent: Node | null = (node as Element).parentElement ?? null;
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode?.();
    node = root && root !== node && "host" in root ? (root as ShadowRoot).host : null;
  }
  return null;
}

function currentTheme(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light"
    ? "light"
    : "dark";
}

/**
 * Read the resolved appearance for the plugin surface containing `el`.
 * `layoutOptions` lists the layout option ids the plugin declared.
 */
export function readPluginAppearance(
  el: Element,
  opts: { layoutOptions?: string[]; variables?: string[] } = {},
): PluginAppearanceSnapshot {
  const scope = findPluginScope(el);
  const pluginId = scope?.getAttribute("data-plugin-scope") ?? null;
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  const layout: Record<string, string> = {};
  for (const id of opts.layoutOptions ?? []) {
    if (pluginId) layout[id] = get(`--plugin-${pluginId}-layout-${id}`);
  }
  const vars: Record<string, string> = {};
  for (const name of opts.variables ?? []) vars[name] = get(name);
  const densityScale = Number.parseFloat(get("--plugin-density-scale")) || 1;
  return {
    pluginId,
    theme: currentTheme(),
    accent: get("--plugin-accent") || get("--g-primary"),
    tint: get("--plugin-tint"),
    density: densityScale < 1 ? "compact" : "comfortable",
    densityScale,
    space: get("--plugin-space") || "12px",
    fontScale: Number.parseFloat(get("--plugin-font-scale")) || 1,
    layout,
    vars,
  };
}

/** Call `cb` whenever the owner changes the appearance or the theme flips. */
export function onPluginAppearanceChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb();
  window.addEventListener(PLUGIN_APPEARANCE_EVENT, handler);
  const mo = new MutationObserver(handler);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    window.removeEventListener(PLUGIN_APPEARANCE_EVENT, handler);
    mo.disconnect();
  };
}

/** Host side: the message a sandboxed iframe page receives. */
export function appearanceBridgeMessage(
  pluginId: string,
  theme: "dark" | "light",
  vars: Record<string, string>,
): PluginAppearanceBridgeMessage {
  return { type: PLUGIN_APPEARANCE_MESSAGE, pluginId, theme, vars };
}

/**
 * Iframe side: apply the host's appearance to this document and keep it in
 * sync. Only messages from the parent window are accepted.
 */
export function listenPluginAppearanceBridge(
  cb?: (msg: PluginAppearanceBridgeMessage) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const data = e.data as Partial<PluginAppearanceBridgeMessage> | null;
    if (!data || data.type !== PLUGIN_APPEARANCE_MESSAGE || !data.vars) return;
    const root = document.documentElement;
    root.dataset.theme = data.theme === "light" ? "light" : "dark";
    for (const [k, v] of Object.entries(data.vars)) {
      if (/^--[a-z0-9-]+$/i.test(k)) root.style.setProperty(k, String(v));
    }
    cb?.(data as PluginAppearanceBridgeMessage);
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}
