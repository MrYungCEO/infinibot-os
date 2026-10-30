/**
 * Shared utilities for grid-panel renderers.
 *
 * A1 wraps each panel renderer with the outer chrome (header, drag-handle,
 * resize handles, minimize/maximize/close). This file gives panel BODIES
 * a consistent scrollable container, loading/empty/error treatments, and
 * the refresh + scroll event plumbing that the masonry-grid controller and
 * the ui_control bus (A4) rely on.
 *
 * Event contract:
 *   - `infinibot:grid-panel-refresh`   detail: { panelId, type }
 *   - `infinibot:grid-panel-scroll`    detail: { panelId, to }   to: number | "top" | "bottom"
 *
 * Scroll selector contract:
 *   The panel body's scroll container is the element carrying
 *   `data-grid-scroll="<panelId>"` — A4 uses this attribute to target
 *   `grid:scroll_panel` verbs.
 */

import { html, type TemplateResult } from "lit";
import { GRID_PANEL_REFRESH_EVENT, type GridPanelRefreshDetail } from "../../controllers/masonry-grid";

/** Scroll event name, mirrors the controller-side refresh event naming. */
export const GRID_PANEL_SCROLL_EVENT = "infinibot:grid-panel-scroll";

export interface GridPanelScrollDetail {
  panelId: string;
  to: number | "top" | "bottom";
}

/**
 * Wrap arbitrary panel content in a fixed-height scroll container that fills
 * the panel body. The `data-grid-scroll` attribute is what A4's `grid:scroll_panel`
 * verb looks for via `querySelector(\`[data-grid-scroll="\${panelId}"]\`)`.
 */
export function panelScrollContainer(
  panelId: string,
  content: TemplateResult,
): TemplateResult {
  return html`
    <div
      class="gp-scroll"
      data-grid-scroll=${panelId}
      style="
        position:relative;
        flex:1; min-height:0;
        width:100%; height:100%;
        overflow:auto;
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--g-primary) 30%, transparent) transparent;
      "
    >
      ${content}
    </div>
  `;
}

/** Centered empty-state stub for "no data yet". */
export function panelEmpty(message: string, hint?: string): TemplateResult {
  return html`
    <div style="
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      height:100%; min-height:120px; padding:24px 16px; gap:6px; text-align:center;
      color:#71717a; font-family:'JetBrains Mono','SF Mono',Consolas,monospace;
    ">
      <div style="font-size:11px; letter-spacing:0.12em; color:color-mix(in srgb, var(--g-primary) 70%, #888);">
        ${message}
      </div>
      ${hint
        ? html`<div style="font-size:10px; color:#52525b;">${hint}</div>`
        : null}
    </div>
  `;
}

/** Inline loading placeholder. */
export function panelLoading(label: string = "Loading…"): TemplateResult {
  return html`
    <div style="
      display:flex; align-items:center; justify-content:center; gap:10px;
      height:100%; min-height:120px; padding:24px;
      color:#a1a1aa; font-size:12px;
      font-family:'JetBrains Mono','SF Mono',Consolas,monospace;
    ">
      <div style="
        width:14px; height:14px;
        border:2px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-top-color: var(--g-primary);
        border-radius:50%;
        animation: gp-spin 0.7s linear infinite;
      "></div>
      <span>${label}</span>
      <style>@keyframes gp-spin { to { transform: rotate(360deg); } }</style>
    </div>
  `;
}

/** Error block with optional retry button. */
export function panelError(err: string, onRetry?: () => void): TemplateResult {
  return html`
    <div style="
      margin:12px; padding:12px 14px;
      background: rgba(239,68,68,0.08);
      border:1px solid rgba(239,68,68,0.3);
      border-radius:6px;
      color:#fca5a5; font-size:12px;
      font-family:'JetBrains Mono','SF Mono',Consolas,monospace;
      display:flex; align-items:center; gap:10px; justify-content:space-between;
      flex-wrap:wrap;
    ">
      <span style="flex:1; min-width:0; word-break:break-word;">${err}</span>
      ${onRetry
        ? html`
            <button
              @click=${onRetry}
              style="
                padding:4px 10px;
                background:transparent;
                border:1px solid rgba(239,68,68,0.45);
                color:#fca5a5;
                font-size:11px;
                font-family:inherit;
                cursor:pointer; border-radius:4px;
              "
            >↻ Retry</button>
          `
        : null}
    </div>
  `;
}

/**
 * Optional sub-header strip drawn inside the panel body (above content).
 * A1's outer chrome already has title/close/minimize — use this when the
 * panel wants its own filter chips, refresh button, or right-hand controls
 * INSIDE the scroll region (or sticky above it).
 */
export function panelHeaderStrip(opts: {
  title?: string;
  onRefresh?: () => void;
  onMaximize?: () => void;
  rightChrome?: TemplateResult;
  badge?: TemplateResult | string | null;
}): TemplateResult {
  return html`
    <div style="
      display:flex; align-items:center; gap:10px;
      padding:8px 12px;
      border-bottom:1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      background: color-mix(in srgb, var(--g-primary) 3%, transparent);
      flex-shrink:0;
      font-family:'JetBrains Mono','SF Mono',Consolas,monospace;
    ">
      ${opts.title
        ? html`
            <span style="
              font-size:10px; font-weight:700; letter-spacing:0.12em;
              color: color-mix(in srgb, var(--g-primary) 80%, #888);
              text-transform:uppercase;
            ">${opts.title}</span>
          `
        : null}
      ${opts.badge
        ? html`<span style="font-size:9px; color:#71717a;">${opts.badge}</span>`
        : null}
      <div style="flex:1; min-width:0;"></div>
      ${opts.rightChrome ?? null}
      ${opts.onRefresh
        ? html`
            <button
              title="Refresh"
              @click=${opts.onRefresh}
              style="
                padding:2px 8px; background:transparent;
                border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
                color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
                font-size:11px; cursor:pointer; border-radius:4px;
                font-family:inherit;
              "
            >↻</button>
          `
        : null}
      ${opts.onMaximize
        ? html`
            <button
              title="Open full page"
              @click=${opts.onMaximize}
              style="
                padding:2px 8px; background:transparent;
                border:1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
                color: color-mix(in srgb, var(--g-primary) 80%, #aaa);
                font-size:11px; cursor:pointer; border-radius:4px;
                font-family:inherit;
              "
            >↗</button>
          `
        : null}
    </div>
  `;
}

/**
 * Subscribe a panel renderer to the global refresh event. Returns a disposer
 * that removes the listener. Renderers are template-functions (not classes),
 * so callers stash the disposer on the wrapping LitElement / module-scope and
 * call it on disconnect.
 *
 * Multiple registrations for the same panelId are tracked under a Set so
 * re-rendering on every tick doesn't leak listeners — call sites use the
 * `attachRefreshListenerOnce` helper for that.
 */
export function attachRefreshListener(
  panelId: string,
  onRefresh: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<GridPanelRefreshDetail>).detail;
    if (detail?.panelId === panelId) onRefresh();
  };
  window.addEventListener(GRID_PANEL_REFRESH_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(GRID_PANEL_REFRESH_EVENT, handler as EventListener);
  };
}

/**
 * Subscribe to the scroll-panel event. `scrollEl` is a thunk so the listener
 * always sees the latest DOM node (renderers swap nodes on update).
 */
export function attachScrollListener(
  panelId: string,
  scrollEl: () => HTMLElement | null,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<GridPanelScrollDetail>).detail;
    if (!detail || detail.panelId !== panelId) return;
    const el = scrollEl();
    if (!el) return;
    if (detail.to === "top") {
      el.scrollTo({ top: 0, behavior: "smooth" });
    } else if (detail.to === "bottom") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else if (typeof detail.to === "number") {
      el.scrollTo({ top: detail.to, behavior: "smooth" });
    }
  };
  window.addEventListener(GRID_PANEL_SCROLL_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(GRID_PANEL_SCROLL_EVENT, handler as EventListener);
  };
}

// ─────────────────────────────────────────────────────────────
// Per-panel registry — tracks first-run init + listener disposers
// so module-scoped render functions don't double-wire events on
// every re-render.
// ─────────────────────────────────────────────────────────────

interface PanelRuntime {
  refreshDispose?: () => void;
  scrollDispose?: () => void;
  initDone: boolean;
  scrollElRef: { current: HTMLElement | null };
}

const _registry = new Map<string, PanelRuntime>();

export function getPanelRuntime(panelId: string): PanelRuntime {
  let rt = _registry.get(panelId);
  if (!rt) {
    rt = { initDone: false, scrollElRef: { current: null } };
    _registry.set(panelId, rt);
  }
  return rt;
}

/** Idempotent — only wires listeners on first call per panel id. */
export function ensurePanelWiring(
  panelId: string,
  opts: {
    onRefresh: () => void;
    /** Returns current scroll container element. */
    scrollEl: () => HTMLElement | null;
  },
): void {
  const rt = getPanelRuntime(panelId);
  if (!rt.refreshDispose) rt.refreshDispose = attachRefreshListener(panelId, opts.onRefresh);
  if (!rt.scrollDispose) rt.scrollDispose = attachScrollListener(panelId, opts.scrollEl);
}

/** Tear down all wiring for a panel — call when the panel is closed. */
export function disposePanelRuntime(panelId: string): void {
  const rt = _registry.get(panelId);
  if (!rt) return;
  rt.refreshDispose?.();
  rt.scrollDispose?.();
  _registry.delete(panelId);
}

/**
 * Capture the scroll container element on render. Pass this as a `ref`-style
 * callback on the root element returned by `panelScrollContainer`. Because
 * the scroll container is the element with `data-grid-scroll`, callers
 * usually use `findScrollElInPanel` after render via a microtask instead.
 */
export function findScrollElInPanel(panelId: string, root: ParentNode | null): HTMLElement | null {
  if (!root) return null;
  const el = root.querySelector?.(`[data-grid-scroll="${CSS.escape(panelId)}"]`);
  return (el as HTMLElement) ?? null;
}
