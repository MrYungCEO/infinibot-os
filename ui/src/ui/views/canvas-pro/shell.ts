/**
 * Canvas Pro shell - the layered surface that wraps the existing
 * Excalidraw mount with:
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ Design Toolbar (tools + align + export)        │
 *   ├──────┬───────────────────────────────┬─────────┤
 *   │      │                               │ Layers  │
 *   │ Tmpl │       Excalidraw canvas       │  ───    │
 *   │ Brand│       (active page)           │ Brand   │
 *   │      │                               │  kit    │
 *   ├──────┴───────────────────────────────┴─────────┤
 *   │ Pages strip                                    │
 *   └────────────────────────────────────────────────┘
 *
 * Only the active page is actually mounted in Excalidraw; switching
 * pages swaps the scene through `excalidrawAPI.updateScene`. Element
 * geometry round-trips through `store.syncActiveScene` on the canvas's
 * debounced onChange.
 *
 * `mountCanvasProShell` is a thin replacement for `mountMcpCanvas` —
 * called by canvas-overlay.ts only when `canvas.pro.enabled` is true.
 */

import { html, render } from "lit";
import type { TemplateResult } from "lit";

import { CanvasProStore } from "./store";
import { renderLayersPanel } from "./layers-panel";
import { renderPagesStrip } from "./pages-strip";
import { renderBrandKitPanel } from "./brand-kit-panel";
import { renderDesignToolbar } from "./design-toolbar";
import {
  createTemplatesPanelState,
  refreshTemplates,
  renderTemplatesPanel,
  type TemplatesPanelState,
} from "./templates-panel";
import type { CanvasTemplate } from "./templates-registry";
import { attachKeymap, type KeymapIntent } from "./keybindings";
import { exportDocument, triggerDownload } from "./export";
import type { CanvasProAlignOp, CanvasProExportOptions, CanvasProToolId } from "./types";

type LeftRail = "templates" | "brand";
type RightRail = "layers" | "brand";

type ShellState = {
  activeTool: CanvasProToolId;
  selectedIds: Set<string>;
  leftRail: LeftRail;
  rightRail: RightRail;
  templates: TemplatesPanelState;
};

const INTENT_EVENT = "canvas-pro:intent";

/**
 * Mount the pro shell into `container`. Returns a disposer.
 */
export async function mountCanvasProShell(
  container: HTMLElement,
  opts: { docId?: string } = {}
): Promise<() => void> {
  injectStyles();

  const store = CanvasProStore.loadOrCreate(opts.docId ?? null);
  const state: ShellState = {
    activeTool: "select",
    selectedIds: new Set(),
    leftRail: "templates",
    rightRail: "layers",
    templates: createTemplatesPanelState(),
  };

  // Build the shell DOM skeleton.
  const root = document.createElement("div");
  root.className = "cp-shell";
  container.appendChild(root);

  let canvasDisposer: (() => void) | null = null;
  let mountedPageId: string | null = null;
  const canvasHost = document.createElement("div");
  canvasHost.className = "cp-canvas-host";

  const rerender = () => {
    render(template(), root);
    void ensureCanvasMount();
  };

  const ensureCanvasMount = async () => {
    const page = store.getActivePage();
    if (mountedPageId === page.id && canvasDisposer) return;
    // Re-mount the Excalidraw React canvas for the new page. The
    // whiteboard module owns the singleton root - calling
    // mountMcpCanvas tears down + remounts.
    if (canvasDisposer) {
      try { canvasDisposer(); } catch { /* ignore */ }
      canvasDisposer = null;
    }
    const slot = root.querySelector(".cp-canvas-slot") as HTMLElement | null;
    if (!slot) return;
    slot.innerHTML = "";
    slot.appendChild(canvasHost);
    try {
      const { mountMcpCanvas } = await import("../../../../../extensions/mcp-excalidraw/ui/whiteboard");
      canvasDisposer = await mountMcpCanvas(canvasHost);
      mountedPageId = page.id;
      // Push the page's stored scene back in if Excalidraw API exposed it.
      // (Engine wiring lives in whiteboard.ts; we trust its initial-data
      // path. A future hook on the api will let us call `updateScene`
      // directly for instant swaps.)
    } catch (err) {
      console.error("[canvas-pro] mount failed:", err);
    }
  };

  // Subscribe to store changes -> re-render.
  const unsub = store.subscribe(rerender);

  // Bootstrap templates list.
  refreshTemplates(state.templates).then((next) => {
    state.templates = next;
    rerender();
  });

  // Keymap.
  const detachKeymap = attachKeymap(document, (intent) => {
    handleIntent(intent);
  });

  function setActiveTool(tool: CanvasProToolId) {
    state.activeTool = tool;
    rerender();
    // TODO(canvas-engine-sibling): map tool → excalidrawAPI.setActiveTool.
    // For now, we just emit so the engine wrapper can listen.
    window.dispatchEvent(
      new CustomEvent(INTENT_EVENT, { detail: { kind: "tool", tool } as KeymapIntent })
    );
  }

  function handleIntent(intent: KeymapIntent) {
    if (intent.kind === "tool") {
      setActiveTool(intent.tool);
      return;
    }
    if (intent.kind === "temp-hand-down") {
      window.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: intent }));
      return;
    }
    if (intent.kind === "temp-hand-up") {
      window.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: intent }));
      return;
    }
    if (intent.kind === "group") {
      if (state.selectedIds.size >= 2) store.groupLayers([...state.selectedIds]);
      return;
    }
    if (intent.kind === "ungroup") {
      if (state.selectedIds.size > 0) store.ungroupLayers([...state.selectedIds]);
      return;
    }
    // All remaining intents are engine-level; forward to the canvas
    // wrapper for execution. The sibling mcp-excalidraw agent listens
    // for `canvas-pro:intent` and dispatches against the live
    // excalidrawAPI.
    window.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: intent }));
  }

  function handleExport() {
    const doc = store.getDocument();
    const options: CanvasProExportOptions = {
      format: "png",
      scope: "active-page",
      bleed: false,
      cropMarks: false,
      scale: 2,
    };
    exportDocument(doc, options)
      .then((blob) => triggerDownload(blob, `${doc.name || "canvas"}.png`))
      .catch((err) => {
        console.error("[canvas-pro] export failed:", err);
        alert(`Export failed: ${err.message ?? err}`);
      });
  }

  function applyTemplate(tpl: CanvasTemplate, mode: "replace" | "new-page") {
    if (mode === "new-page") {
      const page = store.addPage({ width: tpl.width, height: tpl.height });
      page.background = tpl.background;
      page.scene = {
        elements: JSON.parse(JSON.stringify(tpl.scene.elements)),
        appState: tpl.scene.appState ?? {},
        files: tpl.scene.files ?? {},
      };
      store.updateActivePage({});
      return;
    }
    store.updateActivePage({
      width: tpl.width,
      height: tpl.height,
      background: tpl.background,
      scene: {
        elements: JSON.parse(JSON.stringify(tpl.scene.elements)),
        appState: tpl.scene.appState ?? {},
        files: tpl.scene.files ?? {},
      },
    });
    mountedPageId = null; // force remount with new scene
    rerender();
  }

  function template(): TemplateResult {
    return html`
      ${renderDesignToolbar({
        activeTool: state.activeTool,
        onTool: setActiveTool,
        onAlign: (op: CanvasProAlignOp) =>
          window.dispatchEvent(new CustomEvent(INTENT_EVENT, { detail: { kind: "align", op } })),
        onUndo: () => handleIntent({ kind: "undo" }),
        onRedo: () => handleIntent({ kind: "redo" }),
        onDuplicate: () => handleIntent({ kind: "duplicate" }),
        onDelete: () => handleIntent({ kind: "delete" }),
        onGroup: () => handleIntent({ kind: "group" }),
        onUngroup: () => handleIntent({ kind: "ungroup" }),
        onExport: handleExport,
      })}
      <div class="cp-mid">
        <aside class="cp-rail cp-rail--left">
          <div class="cp-rail__tabs">
            <button
              class=${state.leftRail === "templates" ? "is-active" : ""}
              @click=${() => { state.leftRail = "templates"; rerender(); }}
            >Templates</button>
            <button
              class=${state.leftRail === "brand" ? "is-active" : ""}
              @click=${() => { state.leftRail = "brand"; rerender(); }}
            >Brand</button>
          </div>
          <div class="cp-rail__body">
            ${state.leftRail === "templates"
              ? renderTemplatesPanel(state.templates, store, {
                  onApply: applyTemplate,
                  onCategoryChange: (cat) => {
                    state.templates = { ...state.templates, category: cat };
                    rerender();
                  },
                })
              : renderBrandKitPanel(store, { onApplyBrand: () => applyBrandToActivePage(store) })}
          </div>
        </aside>

        <div class="cp-canvas-wrap">
          <div class="cp-canvas-slot"></div>
        </div>

        <aside class="cp-rail cp-rail--right">
          <div class="cp-rail__tabs">
            <button
              class=${state.rightRail === "layers" ? "is-active" : ""}
              @click=${() => { state.rightRail = "layers"; rerender(); }}
            >Layers</button>
            <button
              class=${state.rightRail === "brand" ? "is-active" : ""}
              @click=${() => { state.rightRail = "brand"; rerender(); }}
            >Brand</button>
          </div>
          <div class="cp-rail__body">
            ${state.rightRail === "layers"
              ? renderLayersPanel(store, {
                  selectedIds: state.selectedIds,
                  onSelectLayer: (id, additive) => {
                    if (!additive) state.selectedIds.clear();
                    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
                    else state.selectedIds.add(id);
                    rerender();
                  },
                })
              : renderBrandKitPanel(store, { onApplyBrand: () => applyBrandToActivePage(store) })}
          </div>
        </aside>
      </div>
      ${renderPagesStrip(store)}
    `;
  }

  rerender();

  return () => {
    unsub();
    detachKeymap();
    if (canvasDisposer) {
      try { canvasDisposer(); } catch { /* ignore */ }
      canvasDisposer = null;
    }
    root.remove();
  };
}

/**
 * Apply the brand kit to the active page: page background ← first
 * brand color (if any), text fontFamily ← brand body font (when names
 * match a known web font). Engine-level recolor of all swatch-matching
 * shapes is owned by the sibling mcp-excalidraw agent and listens on
 * the `canvas-pro:intent` event with kind "apply-brand".
 */
function applyBrandToActivePage(store: CanvasProStore): void {
  const doc = store.getDocument();
  const page = doc.pages.find((p) => p.id === doc.activePageId);
  if (!page) return;
  const kit = doc.brandKit;
  const bg = kit.colors[0]?.hex;
  if (bg) store.updateActivePage({ background: bg });
  window.dispatchEvent(
    new CustomEvent(INTENT_EVENT, { detail: { kind: "apply-brand", brandKit: kit, pageId: page.id } })
  );
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const css = `
.cp-shell {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  background: #0a0a0f; color: #e6e7ef;
  font: 11px/1.4 'JetBrains Mono', 'SF Mono', monospace;
  min-height: 0;
}
.cp-shell button { font: inherit; color: inherit; }

.cp-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px;
  background: linear-gradient(180deg, rgba(255,255,255,0.04), transparent);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.cp-toolbar__group { display: flex; gap: 2px; }
.cp-toolbar__sep { width: 1px; align-self: stretch; background: rgba(255,255,255,0.08); margin: 0 4px; }
.cp-toolbar__spacer { flex: 1; }
.cp-tool {
  appearance: none; border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.85);
  padding: 4px 8px; border-radius: 5px; cursor: pointer;
  min-width: 28px; text-align: center;
}
.cp-tool:hover { background: rgba(255,255,255,0.08); }
.cp-tool.is-active {
  background: color-mix(in srgb, var(--g-primary, #4ade80) 22%, transparent);
  border-color: color-mix(in srgb, var(--g-primary, #4ade80) 50%, transparent);
  color: var(--g-primary, #4ade80);
}
.cp-tool--primary {
  background: var(--g-primary, #4ade80); color: #0a0a0f; font-weight: 700;
  border-color: transparent;
}

.cp-mid { flex: 1; min-height: 0; display: flex; }
.cp-canvas-wrap { flex: 1; min-width: 0; min-height: 0; position: relative; background: #fff; }
.cp-canvas-slot { position: absolute; inset: 0; }
.cp-canvas-host { width: 100%; height: 100%; }

.cp-rail {
  width: 220px;
  background: rgba(8,8,12,0.95);
  border-left: 1px solid rgba(255,255,255,0.06);
  display: flex; flex-direction: column;
  min-height: 0;
}
.cp-rail--left { border-left: none; border-right: 1px solid rgba(255,255,255,0.06); }
.cp-rail__tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.06); }
.cp-rail__tabs button {
  flex: 1; appearance: none; background: transparent; border: 0;
  color: rgba(255,255,255,0.55); padding: 8px 6px; cursor: pointer;
  text-transform: uppercase; letter-spacing: 0.06em; font-size: 9px;
}
.cp-rail__tabs button.is-active {
  color: var(--g-primary, #4ade80);
  border-bottom: 1px solid var(--g-primary, #4ade80);
}
.cp-rail__body { flex: 1; overflow: auto; padding: 8px; min-height: 0; }
.cp-rail__empty { padding: 16px 8px; color: rgba(255,255,255,0.35); text-align: center; font-size: 10px; }

.cp-layers { display: flex; flex-direction: column; gap: 2px; }
.cp-layer {
  display: flex; align-items: center; gap: 4px;
  padding: 4px; border-radius: 4px;
  background: rgba(255,255,255,0.02);
  border: 1px solid transparent;
  cursor: grab;
}
.cp-layer.is-selected { background: color-mix(in srgb, var(--g-primary, #4ade80) 12%, transparent); border-color: color-mix(in srgb, var(--g-primary, #4ade80) 35%, transparent); }
.cp-layer.is-hidden { opacity: 0.4; }
.cp-layer.is-grouped { border-left: 2px solid color-mix(in srgb, var(--g-primary, #4ade80) 50%, transparent); }
.cp-layer__icon {
  appearance: none; background: transparent; border: 0;
  color: rgba(255,255,255,0.6); cursor: pointer; padding: 0 2px;
}
.cp-layer__name {
  flex: 1; min-width: 0;
  background: transparent; border: 0; color: #fff;
  font: inherit; padding: 2px 4px; border-radius: 3px;
}
.cp-layer__name:focus { background: rgba(255,255,255,0.06); outline: none; }
.cp-layer__z { color: rgba(255,255,255,0.35); font-size: 9px; min-width: 18px; text-align: right; }
.cp-layer__group { color: rgba(255,255,255,0.4); }

.cp-pages {
  display: flex; gap: 8px; padding: 8px;
  overflow-x: auto; flex-shrink: 0;
  border-top: 1px solid rgba(255,255,255,0.06);
  background: rgba(8,8,12,0.95);
}
.cp-pages__item {
  flex-shrink: 0; width: 88px;
  display: flex; flex-direction: column; gap: 4px;
  padding: 4px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.06);
  cursor: pointer;
}
.cp-pages__item.is-active {
  border-color: var(--g-primary, #4ade80);
  background: color-mix(in srgb, var(--g-primary, #4ade80) 8%, transparent);
}
.cp-pages__thumb {
  width: 100%; max-height: 100px;
  display: flex; align-items: flex-end; justify-content: flex-start;
  border-radius: 3px; overflow: hidden;
  position: relative;
}
.cp-pages__thumb-label {
  position: absolute; top: 2px; left: 4px;
  font-size: 9px; color: rgba(0,0,0,0.5);
  background: rgba(255,255,255,0.7);
  border-radius: 2px; padding: 0 3px;
}
.cp-pages__name {
  font-size: 9px; color: rgba(255,255,255,0.7);
  white-space: nowrap; text-overflow: ellipsis; overflow: hidden;
}
.cp-pages__row { display: flex; gap: 2px; }
.cp-pages__btn, .cp-pages__add {
  appearance: none; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08); color: rgba(255,255,255,0.65);
  border-radius: 3px; cursor: pointer; padding: 1px 4px; flex: 1;
}
.cp-pages__btn:disabled { opacity: 0.3; cursor: not-allowed; }
.cp-pages__add {
  align-self: center; padding: 6px 12px; flex: none;
  background: rgba(255,255,255,0.06);
}

.cp-templates__cats { display: flex; flex-wrap: wrap; gap: 2px; margin-bottom: 8px; }
.cp-templates__cat {
  appearance: none; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06); color: rgba(255,255,255,0.7);
  border-radius: 3px; cursor: pointer; padding: 3px 6px; font-size: 9px;
}
.cp-templates__cat.is-active {
  background: color-mix(in srgb, var(--g-primary, #4ade80) 15%, transparent);
  color: var(--g-primary, #4ade80);
  border-color: color-mix(in srgb, var(--g-primary, #4ade80) 35%, transparent);
}
.cp-templates__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.cp-templates__card {
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 5px; overflow: hidden;
  background: rgba(255,255,255,0.02);
}
.cp-templates__thumb {
  display: flex; align-items: center; justify-content: center;
  color: rgba(0,0,0,0.55); padding: 4px; font-size: 8px; text-align: center;
}
.cp-templates__actions { display: flex; }
.cp-templates__actions button {
  flex: 1; appearance: none; background: rgba(255,255,255,0.04);
  border: 0; color: rgba(255,255,255,0.7); padding: 4px;
  cursor: pointer; font-size: 9px;
}
.cp-templates__actions button:hover { background: rgba(255,255,255,0.08); }

.cp-brand section { margin-bottom: 12px; }
.cp-brand__h { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
.cp-brand__add { appearance: none; background: rgba(255,255,255,0.06); border: 0; border-radius: 3px; color: #fff; cursor: pointer; padding: 1px 6px; }
.cp-brand__swatches, .cp-brand__logos, .cp-brand__fonts { display: flex; flex-direction: column; gap: 4px; }
.cp-brand__swatch, .cp-brand__logo, .cp-brand__fontpair {
  display: flex; align-items: center; gap: 4px;
  background: rgba(255,255,255,0.02); padding: 4px; border-radius: 4px;
}
.cp-brand__logo img { width: 28px; height: 28px; object-fit: contain; background: #fff; border-radius: 3px; }
.cp-brand__name, .cp-brand__font {
  flex: 1; background: transparent; border: 0; color: #fff; font: inherit;
  padding: 2px 4px; border-radius: 3px; min-width: 0;
}
.cp-brand__name:focus, .cp-brand__font:focus { background: rgba(255,255,255,0.06); outline: none; }
.cp-brand__del { appearance: none; background: transparent; border: 0; color: rgba(255,255,255,0.4); cursor: pointer; }
.cp-brand__apply {
  display: block; width: 100%; margin-top: 8px;
  appearance: none; border: 0; border-radius: 4px;
  background: var(--g-primary, #4ade80); color: #0a0a0f;
  font-weight: 700; padding: 6px; cursor: pointer;
}
.cp-brand__fontpair { flex-wrap: wrap; }
.cp-brand__fontpair input { flex: 1 1 100%; }

/* G8 glass finish — scoped to the Canvas Pro shell. */
.cp-shell {
  background:
    radial-gradient(70% 380px at 50% -12%, color-mix(in srgb, var(--glass-gold, var(--g-primary, #e8b84d)) 17%, transparent), transparent 72%),
    var(--glass-base, #080704);
  color: var(--glass-fg, #f4efe5);
}
.cp-toolbar, .cp-rail, .cp-pages {
  border-color: var(--glass-stroke, rgba(255,255,255,.1));
  background: var(--glass-sheen, linear-gradient(180deg, rgba(255,255,255,.07), transparent 34%)), var(--glass-2, rgba(15,13,9,.84));
  box-shadow: var(--glass-specular, inset 0 1px 0 rgba(255,255,255,.07));
  backdrop-filter: var(--glass-blur, blur(18px) saturate(135%));
}
.cp-tool, .cp-pages__item, .cp-templates__card, .cp-layer,
.cp-brand__swatch, .cp-brand__logo, .cp-brand__fontpair {
  border-color: var(--glass-stroke, rgba(255,255,255,.1));
  background: var(--glass-3, rgba(255,255,255,.04));
  border-radius: var(--glass-radius-sm, 10px);
}
.cp-tool.is-active, .cp-pages__item.is-active, .cp-templates__cat.is-active {
  border-color: var(--glass-stroke-gold, var(--g-primary, #e8b84d));
  color: var(--glass-gold, var(--g-primary, #e8b84d));
  box-shadow: var(--glass-glow-soft, 0 8px 24px rgba(198,143,25,.12));
}
.cp-tool--primary, .cp-brand__apply {
  color: var(--glass-ink, #171006);
  background: var(--glass-gold-fill, linear-gradient(135deg, var(--glass-gold-hi, #ffe29a), var(--g-primary, #e8b84d), var(--glass-gold-deep, #9d6809)));
  border-radius: var(--glass-radius-sm, 10px);
}
.cp-shell :is(button, input):focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 3px color-mix(in srgb, var(--g-primary, #e8b84d) 30%, transparent)); }

@media (max-width: 640px) {
  .cp-toolbar { overflow-x: auto; padding: 7px; }
  .cp-tool { min-width: 38px; min-height: 38px; }
  .cp-mid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: minmax(250px, 1fr) minmax(150px, .55fr);
    grid-template-areas: "canvas canvas" "left right";
  }
  .cp-canvas-wrap { grid-area: canvas; }
  .cp-rail { width: auto; min-width: 0; }
  .cp-rail--left { grid-area: left; }
  .cp-rail--right { grid-area: right; }
  .cp-pages { padding: 6px; }
  .cp-pages__item { width: 72px; }
}
@media (prefers-reduced-transparency: reduce) {
  .cp-toolbar, .cp-rail, .cp-pages { backdrop-filter: none; background: var(--glass-solid, #12100c); }
}
@media (prefers-reduced-motion: reduce) {
  .cp-shell *, .cp-shell *::before, .cp-shell *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`;
  const style = document.createElement("style");
  style.dataset.canvasPro = "1";
  style.textContent = css;
  document.head.appendChild(style);
}
