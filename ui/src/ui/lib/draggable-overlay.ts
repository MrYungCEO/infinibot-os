/**
 * draggable-overlay.ts — minimal, dependency-free "make this overlay draggable"
 * helper for the Voice HUD (and any other fixed/absolute overlay element).
 *
 * Unlike the richer `utils/floating-panel.ts` (which also does spatial bin-fit
 * placement + collapse chrome for the insight ring), this is the small, generic
 * primitive the rest of the HUD elements use:
 *
 *   • DRAG     — pointer-capture drag, initiated ONLY from a header strip (so
 *                inner buttons / inputs keep working).
 *   • CLAMP    — the element is always kept fully inside the viewport.
 *   • SNAP     — drop position snaps to an 8px grid (configurable).
 *   • PERSIST  — x / y (and optionally w / h) saved to localStorage per key.
 *   • RESTORE  — saved geometry re-applied on mount (clamped back into view).
 *   • CURSOR   — the handle shows `grab`, and `grabbing` while dragging.
 *
 * The default DEFAULT POSITION is whatever the element's own CSS already lays
 * out: until the user drags (or a saved position exists) the helper does NOT
 * touch left/top, so existing layouts stay intact. A drag overrides via inline
 * styles persisted in localStorage.
 *
 * Usage (from a Lit component's firstUpdated):
 *   this._drag = makeDraggableOverlay(
 *     this.renderRoot.querySelector('.hud-container')!,
 *     'video-feed-hud',
 *     { handle: this.renderRoot.querySelector('.hud-header') },
 *   );
 *   // …and in disconnectedCallback: this._drag?.destroy();
 */

export interface DraggableOverlayOptions {
  /** Header strip the drag must start on. Defaults to the element itself. */
  handle?: HTMLElement | null;
  /** Snap grid in px applied on drop. Default 8. Pass 0 to disable. */
  snap?: number;
  /** Also persist + restore width/height (default false → only x/y). */
  persistSize?: boolean;
  /** Called after a drag ends (host may persist extra state). */
  onChange?: () => void;
  /** prefers-reduced-motion — skip any transition the host applies. */
  reducedMotion?: boolean;
}

export interface DraggableOverlayHandle {
  /** Re-assert the handle binding + re-clamp the saved position into view. */
  refresh(): void;
  /** Clear the saved position and snap the element back to its CSS default. */
  reset(): void;
  /** Tear down all listeners. Call from disconnectedCallback. */
  destroy(): void;
}

interface SavedGeom { x: number; y: number; w?: number; h?: number; }

const PREFIX = 'infinibot:drag:';

function storeKey(key: string): string { return `${PREFIX}${key}`; }

function loadGeom(key: string): SavedGeom | null {
  try {
    const raw = localStorage.getItem(storeKey(key));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (typeof g?.x === 'number' && typeof g?.y === 'number') return g as SavedGeom;
  } catch { /* ignore */ }
  return null;
}

function saveGeom(key: string, g: SavedGeom) {
  try {
    const out: SavedGeom = { x: Math.round(g.x), y: Math.round(g.y) };
    if (typeof g.w === 'number') out.w = Math.round(g.w);
    if (typeof g.h === 'number') out.h = Math.round(g.h);
    localStorage.setItem(storeKey(key), JSON.stringify(out));
  } catch { /* ignore */ }
}

function snapTo(v: number, grid: number): number {
  return grid > 0 ? Math.round(v / grid) * grid : v;
}

/** Keep an (x, y, w, h) box fully inside the viewport (8px margin). */
function clampIntoView(x: number, y: number, w: number, h: number): { x: number; y: number } {
  const W = window.innerWidth, H = window.innerHeight;
  const m = 8;
  return {
    x: Math.min(Math.max(m, x), Math.max(m, W - w - m)),
    y: Math.min(Math.max(m, y), Math.max(m, H - h - m)),
  };
}

// Interactive descendants that must keep their own click/drag behaviour — a
// drag never starts when the pointer lands on one of these.
const INTERACTIVE_SEL = 'button, a, input, select, textarea, [role="button"], [contenteditable="true"]';

/**
 * Wire drag + clamp + snap + persistence onto `element`, dragged by `handle`
 * (a header strip). The element should be `position: fixed` or `absolute`; if
 * it is `static` it is promoted to `fixed`.
 */
export function makeDraggableOverlay(
  element: HTMLElement,
  key: string,
  opts: DraggableOverlayOptions = {},
): DraggableOverlayHandle {
  const snap = opts.snap ?? 8;
  const reduced = opts.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let handle: HTMLElement = opts.handle ?? element;

  let geom: SavedGeom | null = loadGeom(key);
  let dragging = false;
  let start: { px: number; py: number; ox: number; oy: number } | null = null;

  element.classList.add('drag-overlay');

  // Ensure the element can be positioned via left/top.
  const computedPos = getComputedStyle(element).position;
  if (computedPos === 'static') element.style.position = 'fixed';

  /** Apply a saved/dragged position as inline left/top (overrides CSS default). */
  function place(g: SavedGeom) {
    const w = (opts.persistSize && g.w) || element.offsetWidth || 200;
    const h = (opts.persistSize && g.h) || element.offsetHeight || 120;
    const c = clampIntoView(g.x, g.y, w, h);
    element.style.left = `${c.x}px`;
    element.style.top = `${c.y}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    // Kill any centering transform the element's CSS used for its default spot.
    element.style.transform = 'none';
    if (opts.persistSize) {
      if (g.w) element.style.width = `${g.w}px`;
      if (g.h) element.style.height = `${g.h}px`;
    }
  }

  function onDown(e: PointerEvent) {
    // Never hijack a click meant for an inner control.
    if ((e.target as HTMLElement)?.closest(INTERACTIVE_SEL)) return;
    if (e.button !== 0) return;
    dragging = true;
    element.classList.add('drag-overlay-dragging');
    handle.style.cursor = 'grabbing';
    const r = element.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, ox: r.left, oy: r.top };
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    e.preventDefault();
  }

  function onMove(e: PointerEvent) {
    if (!dragging || !start) return;
    const nx = start.ox + (e.clientX - start.px);
    const ny = start.oy + (e.clientY - start.py);
    const c = clampIntoView(nx, ny, element.offsetWidth, element.offsetHeight);
    element.style.left = `${c.x}px`;
    element.style.top = `${c.y}px`;
    element.style.right = 'auto';
    element.style.bottom = 'auto';
    element.style.transform = 'none';
    geom = { ...(geom ?? {}), x: c.x, y: c.y };
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('drag-overlay-dragging');
    handle.style.cursor = 'grab';
    window.removeEventListener('pointermove', onMove);
    if (geom) {
      // Snap-to-grid on drop, re-clamp, persist.
      const w = element.offsetWidth, h = element.offsetHeight;
      const snapped = clampIntoView(snapTo(geom.x, snap), snapTo(geom.y, snap), w, h);
      geom = opts.persistSize ? { ...snapped, w, h } : snapped;
      place(geom);
      saveGeom(key, geom);
    }
    opts.onChange?.();
  }

  function bindHandle(h: HTMLElement) {
    if ((h as unknown as { __dragBound?: boolean }).__dragBound) return;
    h.classList.add('drag-overlay-handle');
    h.style.cursor = 'grab';
    h.style.touchAction = 'none';
    h.addEventListener('pointerdown', onDown);
    (h as unknown as { __dragBound?: boolean }).__dragBound = true;
  }

  function onResize() { if (geom) place(geom); }

  // ── Init ──
  bindHandle(handle);
  if (reduced) element.classList.add('drag-overlay-reduced');
  if (geom) place(geom);                 // restore on mount (clamped into view)
  window.addEventListener('resize', onResize);

  return {
    refresh() {
      // Re-resolve the handle (Lit may have recreated the header strip) + re-clamp.
      if (opts.handle && opts.handle !== handle && opts.handle.isConnected) {
        handle = opts.handle;
      }
      bindHandle(handle);
      if (geom) place(geom);
    },
    reset() {
      geom = null;
      try { localStorage.removeItem(storeKey(key)); } catch { /* ignore */ }
      element.style.removeProperty('left');
      element.style.removeProperty('top');
      element.style.removeProperty('right');
      element.style.removeProperty('bottom');
      element.style.removeProperty('transform');
      if (opts.persistSize) {
        element.style.removeProperty('width');
        element.style.removeProperty('height');
      }
    },
    destroy() {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerdown', onDown);
      (handle as unknown as { __dragBound?: boolean }).__dragBound = false;
    },
  };
}

/**
 * Shared CSS for the draggable-overlay handle states. Import + spread into a
 * Lit component's `static styles` (via unsafeCSS) so the grab/grabbing cursor +
 * drag elevation are consistent across HUD elements. Uses only theme tokens.
 */
export const draggableOverlayStyles = `
  .drag-overlay-handle { cursor: grab; touch-action: none; user-select: none; }
  .drag-overlay-handle:active { cursor: grabbing; }
  .drag-overlay-dragging {
    transition: none !important;
    z-index: 60;
    box-shadow: 0 14px 40px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent),
                0 6px 30px rgba(0,0,0,0.55);
  }
  .drag-overlay-reduced { transition: none !important; }
`;
