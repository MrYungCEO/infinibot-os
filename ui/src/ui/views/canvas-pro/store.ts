/**
 * Canvas Pro store - persistent document state.
 *
 * Persistence path: localStorage under `canvas-pro:doc:<id>`. The host's
 * existing whiteboard save format (`{ elements, appState, files }`) is
 * still written by the underlying Excalidraw mount; this store holds the
 * page-level wrapper around it.
 *
 * Backwards-compat: if no pro doc exists for a given board id but a
 * legacy single-scene save is present, `migrateLegacyScene` returns a
 * one-page document that wraps it.
 */

import {
  type BrandKit,
  type CanvasPage,
  type CanvasProDocument,
  type LayerMeta,
  CANVAS_PRO_SCHEMA_VERSION,
} from "./types";

const DOC_KEY_PREFIX = "canvas-pro:doc:";
const DEFAULT_PAGE_W = 1080;
const DEFAULT_PAGE_H = 1080;

type Listener = (doc: CanvasProDocument) => void;

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function emptyPage(name: string, width = DEFAULT_PAGE_W, height = DEFAULT_PAGE_H): CanvasPage {
  return {
    id: uid("page"),
    name,
    width,
    height,
    background: "#ffffff",
    scene: { elements: [], appState: {}, files: {} },
    layers: {},
    layerOrder: [],
    bleed: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function emptyBrandKit(): BrandKit {
  return { logos: [], colors: [], fontPairs: [], templateIds: [] };
}

export function createEmptyDocument(name = "Untitled"): CanvasProDocument {
  const page = emptyPage("Page 1");
  return {
    schemaVersion: CANVAS_PRO_SCHEMA_VERSION,
    id: uid("doc"),
    name,
    pages: [page],
    activePageId: page.id,
    brandKit: emptyBrandKit(),
    updatedAt: Date.now(),
  };
}

/**
 * Wrap a legacy `{ elements, appState, files }` payload as a one-page
 * pro document. Legacy boards keep working — they just gain a single
 * implicit page with no layer overlay metadata.
 */
export function migrateLegacyScene(
  legacy: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> },
  name = "Imported board"
): CanvasProDocument {
  const doc = createEmptyDocument(name);
  const page = doc.pages[0];
  page.scene = {
    elements: legacy.elements ?? [],
    appState: legacy.appState ?? {},
    files: legacy.files ?? {},
  };
  // Seed layer metadata from element ids so the layers panel isn't empty
  // on first open. Names default to element type + short id.
  const order: string[] = [];
  for (const raw of page.scene.elements ?? []) {
    const el = raw as { id?: string; type?: string };
    if (!el?.id) continue;
    page.layers[el.id] = {
      id: el.id,
      name: `${el.type ?? "element"} ${el.id.slice(-4)}`,
      locked: false,
      hidden: false,
      groupId: null,
    };
    order.push(el.id);
  }
  page.layerOrder = order;
  return doc;
}

export class CanvasProStore {
  private doc: CanvasProDocument;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc?: CanvasProDocument) {
    this.doc = doc ?? createEmptyDocument();
  }

  static loadOrCreate(docId: string | null): CanvasProStore {
    if (docId) {
      try {
        const raw = localStorage.getItem(DOC_KEY_PREFIX + docId);
        if (raw) {
          const parsed = JSON.parse(raw) as CanvasProDocument;
          if (parsed?.schemaVersion === CANVAS_PRO_SCHEMA_VERSION) {
            return new CanvasProStore(parsed);
          }
        }
      } catch {
        /* fall through */
      }
    }
    return new CanvasProStore();
  }

  getDocument(): CanvasProDocument {
    return this.doc;
  }

  getActivePage(): CanvasPage {
    return this.doc.pages.find((p) => p.id === this.doc.activePageId) ?? this.doc.pages[0];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.doc = { ...this.doc, updatedAt: Date.now() };
    for (const fn of this.listeners) fn(this.doc);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(DOC_KEY_PREFIX + this.doc.id, JSON.stringify(this.doc));
      } catch {
        /* quota — ignore; surface in UI later */
      }
    }, 300);
  }

  // -- Pages -----------------------------------------------------------

  addPage(opts?: { width?: number; height?: number; afterId?: string }): CanvasPage {
    const page = emptyPage(`Page ${this.doc.pages.length + 1}`, opts?.width, opts?.height);
    const idx = opts?.afterId ? this.doc.pages.findIndex((p) => p.id === opts.afterId) : -1;
    if (idx >= 0) this.doc.pages.splice(idx + 1, 0, page);
    else this.doc.pages.push(page);
    this.doc.activePageId = page.id;
    this.emit();
    return page;
  }

  duplicatePage(id: string): CanvasPage | null {
    const src = this.doc.pages.find((p) => p.id === id);
    if (!src) return null;
    const clone: CanvasPage = JSON.parse(JSON.stringify(src));
    clone.id = uid("page");
    clone.name = `${src.name} copy`;
    const idx = this.doc.pages.findIndex((p) => p.id === id);
    this.doc.pages.splice(idx + 1, 0, clone);
    this.doc.activePageId = clone.id;
    this.emit();
    return clone;
  }

  deletePage(id: string): void {
    if (this.doc.pages.length <= 1) return; // always keep at least one page
    const idx = this.doc.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.doc.pages.splice(idx, 1);
    if (this.doc.activePageId === id) {
      this.doc.activePageId = this.doc.pages[Math.max(0, idx - 1)].id;
    }
    this.emit();
  }

  reorderPage(id: string, toIndex: number): void {
    const fromIdx = this.doc.pages.findIndex((p) => p.id === id);
    if (fromIdx < 0) return;
    const clamped = Math.max(0, Math.min(toIndex, this.doc.pages.length - 1));
    const [page] = this.doc.pages.splice(fromIdx, 1);
    this.doc.pages.splice(clamped, 0, page);
    this.emit();
  }

  setActivePage(id: string): void {
    if (!this.doc.pages.find((p) => p.id === id)) return;
    this.doc.activePageId = id;
    this.emit();
  }

  updateActivePage(patch: Partial<Omit<CanvasPage, "id">>): void {
    const page = this.getActivePage();
    Object.assign(page, patch);
    this.emit();
  }

  /**
   * Sync the active page's scene with the latest Excalidraw payload.
   * Called by the overlay on debounced onChange from the React canvas.
   * Layer metadata for new elements is auto-seeded; metadata for deleted
   * elements is reaped.
   */
  syncActiveScene(scene: { elements: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }): void {
    const page = this.getActivePage();
    page.scene = {
      elements: scene.elements,
      appState: scene.appState ?? page.scene.appState,
      files: scene.files ?? page.scene.files,
    };
    const seen = new Set<string>();
    for (const raw of scene.elements) {
      const el = raw as { id?: string; type?: string };
      if (!el?.id) continue;
      seen.add(el.id);
      if (!page.layers[el.id]) {
        page.layers[el.id] = {
          id: el.id,
          name: `${el.type ?? "element"} ${el.id.slice(-4)}`,
          locked: false,
          hidden: false,
          groupId: null,
        };
        page.layerOrder.push(el.id);
      }
    }
    // Reap stale layer metadata.
    for (const id of Object.keys(page.layers)) {
      if (!seen.has(id)) delete page.layers[id];
    }
    page.layerOrder = page.layerOrder.filter((id) => seen.has(id));
    this.emit();
  }

  // -- Layers ----------------------------------------------------------

  updateLayer(id: string, patch: Partial<LayerMeta>): void {
    const page = this.getActivePage();
    const layer = page.layers[id];
    if (!layer) return;
    Object.assign(layer, patch);
    this.emit();
  }

  reorderLayer(id: string, toIndex: number): void {
    const page = this.getActivePage();
    const from = page.layerOrder.indexOf(id);
    if (from < 0) return;
    const clamped = Math.max(0, Math.min(toIndex, page.layerOrder.length - 1));
    page.layerOrder.splice(from, 1);
    page.layerOrder.splice(clamped, 0, id);
    this.emit();
  }

  groupLayers(ids: string[]): string | null {
    if (ids.length < 2) return null;
    const page = this.getActivePage();
    const groupId = uid("grp");
    for (const id of ids) {
      const layer = page.layers[id];
      if (layer) layer.groupId = groupId;
    }
    this.emit();
    return groupId;
  }

  ungroupLayers(ids: string[]): void {
    const page = this.getActivePage();
    for (const id of ids) {
      const layer = page.layers[id];
      if (layer) layer.groupId = null;
    }
    this.emit();
  }

  // -- Brand kit -------------------------------------------------------

  updateBrandKit(patch: Partial<BrandKit>): void {
    this.doc.brandKit = { ...this.doc.brandKit, ...patch };
    this.emit();
  }

  // -- Doc-level ------------------------------------------------------

  rename(name: string): void {
    this.doc.name = name;
    this.emit();
  }
}
