/**
 * floating-panel.ts — reusable drag + collapse + persistence + spatial-awareness
 * helper for any overlay card on the Voice Terminal HUD.
 *
 * The Voice HUD packs a lot of fixed chrome around the centre blob: the app nav
 * sidebar (`.nav`, light DOM), the right rail (`voice-edge-hud .rail.right`), the
 * top capsule row (`voice-floating-hud .capsule`, ~top:9%), and the central
 * blob/mesh (`.vc-world`). Proactive overlays (insight cards, proactive popups)
 * used to live in hard-coded corners and got buried behind that chrome. This
 * helper makes any element:
 *
 *   • DRAGGABLE   — pointer-capture drag via an injected 6-dot grab handle.
 *   • COLLAPSIBLE — a chevron collapses the card to a slim 32px pill; expands back.
 *   • PERSISTENT  — position + collapsed flag saved to localStorage per panel key.
 *   • SPATIAL     — on mount + resize, auto-places the card in the nearest free
 *                   cell of a 6×4 grid that does NOT overlap any no-go chrome
 *                   zone. A user-dragged position wins, but is clamped into view.
 *
 * Reusable across overlays — wire it from a component's `updated()` lifecycle via
 * the returned controller's `apply()` (idempotent: re-asserts handle + layout
 * after each Lit re-render without stacking listeners).
 *
 * Chrome zones are detected HERE (one source of truth), not inside each component.
 */

export type FloatingZone = 'tl' | 'tr' | 'ml' | 'mr' | 'bl' | 'br' | 'cl' | 'cr';

export interface FloatingPanelOpts {
  /** Preferred quadrant — used as the seed for greedy bin-fit placement. */
  zone?: FloatingZone;
  /** Short headline shown in the collapsed pill (icon + 1 line). */
  collapsedLabel?: string;
  /** Glyph/emoji shown in the collapsed pill + on the grab handle. */
  icon?: string;
  /** Start collapsed on first ever mount (before any persisted state). */
  defaultCollapsed?: boolean;
  /** Called after the user drags/collapses (host can persist extra state). */
  onChange?: () => void;
  /** prefers-reduced-motion — skip the slide transition. */
  reducedMotion?: boolean;
}

interface SavedPos { x: number; y: number; }

interface Rect { left: number; top: number; right: number; bottom: number; }

// ── localStorage ───────────────────────────────────────────────────────────

function posKey(key: string) { return `${key}:pos`; }
function colKey(key: string) { return `${key}:collapsed`; }

function loadPos(key: string): SavedPos | null {
  try {
    const raw = localStorage.getItem(posKey(key));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') return p;
  } catch { /* ignore */ }
  return null;
}
function savePos(key: string, p: SavedPos) {
  try { localStorage.setItem(posKey(key), JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) })); } catch { /* ignore */ }
}
function loadCollapsed(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(colKey(key));
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return null;
}
function saveCollapsed(key: string, v: boolean) {
  try { localStorage.setItem(colKey(key), v ? '1' : '0'); } catch { /* ignore */ }
}

// ── Chrome zone detection (single source of truth) ──────────────────────────

/** querySelector that descends through every open shadow root. */
function deepQuery(sel: string): HTMLElement | null {
  const visit = (root: Document | ShadowRoot | Element): HTMLElement | null => {
    const direct = (root as Element).querySelector?.(sel) as HTMLElement | null;
    if (direct) return direct;
    const all = (root as Element).querySelectorAll?.('*') ?? [];
    for (const el of Array.from(all)) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) { const found = visit(sr); if (found) return found; }
    }
    return null;
  };
  try { return visit(document); } catch { return null; }
}

function rectOf(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/**
 * Measure every piece of fixed HUD chrome that an overlay must stay clear of.
 * Mirrors how <voice-edge-hud> measures `.nav` (`_measureChrome`).
 */
export function detectNoGoZones(): Rect[] {
  const W = window.innerWidth, H = window.innerHeight;
  const zones: Rect[] = [];

  // App nav sidebar (light DOM) — same probe voice-edge-hud uses.
  const nav = rectOf(document.querySelector('.nav') as HTMLElement | null);
  if (nav && nav.left < 40 && nav.right > 0) {
    zones.push({ left: 0, top: 0, right: nav.right + 12, bottom: H });
  }

  // Right rail (running/completed agent lanes) inside voice-edge-hud.
  const rail = rectOf(deepQuery('voice-edge-hud')?.shadowRoot?.querySelector('.rail.right') as HTMLElement | null);
  if (rail) zones.push({ left: rail.left - 12, top: rail.top - 12, right: W, bottom: rail.bottom + 12 });
  else {
    // Fallback: reserve the right rail strip the edge-hud occupies (~right:14px).
    zones.push({ left: W - 320, top: 0, right: W, bottom: H });
  }

  // Top capsule row (voice-floating-hud .capsule, anchored ~top:9%).
  zones.push({ left: 0, top: 0, right: W, bottom: Math.max(150, H * 0.16) });

  // Bottom controls dock (sticky bottom-centre pill) — keep cards above it.
  zones.push({ left: W * 0.28, top: H - 96, right: W * 0.72, bottom: H });

  // Central blob / mesh — a circle of ~min(62vmin) at viewport centre. Kept a
  // touch tighter than the full 62vmin radius so cards can hug the left/right
  // strips between the blob and the side chrome.
  const blobR = Math.min(W, H) * 0.30;
  zones.push({
    left: W / 2 - blobR, top: H / 2 - blobR,
    right: W / 2 + blobR, bottom: H / 2 + blobR,
  });

  return zones;
}

function overlaps(a: Rect, b: Rect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

// ── Greedy 6×4 bin-fit placement ────────────────────────────────────────────

const COLS = 6, ROWS = 4;

/** Anchor cell (col,row) for each preferred zone seed. */
function zoneSeed(zone: FloatingZone): { col: number; row: number } {
  switch (zone) {
    case 'tl': return { col: 0, row: 0 };
    case 'tr': return { col: COLS - 1, row: 0 };
    case 'ml': return { col: 0, row: 1 };
    case 'mr': return { col: COLS - 1, row: 1 };
    case 'cl': return { col: 0, row: 2 };
    case 'cr': return { col: COLS - 1, row: 2 };
    case 'bl': return { col: 0, row: ROWS - 1 };
    case 'br': return { col: COLS - 1, row: ROWS - 1 };
    default:   return { col: 0, row: 1 };
  }
}

/**
 * Place a panel of (w×h) in the nearest free grid cell to its preferred zone,
 * avoiding every no-go zone AND any sibling overlay rects already placed.
 * Returns viewport px (top-left).
 */
function binFitPlace(
  w: number, h: number, zone: FloatingZone, noGo: Rect[], taken: Rect[],
): SavedPos {
  const W = window.innerWidth, H = window.innerHeight;
  const cellW = W / COLS, cellH = H / ROWS;
  const seed = zoneSeed(zone);
  const margin = 14;

  let best: SavedPos | null = null;
  let bestDist = Infinity;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      // Candidate top-left, snapped near the cell but clamped into view.
      let x = col * cellW + 8;
      let y = row * cellH + 8;
      x = Math.min(Math.max(margin, x), W - w - margin);
      y = Math.min(Math.max(margin, y), H - h - margin);
      const cand: Rect = { left: x, top: y, right: x + w, bottom: y + h };

      if (noGo.some((z) => overlaps(cand, z))) continue;
      if (taken.some((z) => overlaps(cand, z))) continue;

      const dist = Math.abs(col - seed.col) + Math.abs(row - seed.row);
      if (dist < bestDist) { bestDist = dist; best = { x, y }; }
    }
  }

  if (best) return best;

  // The coarse grid found nothing — the centre blob + side chrome leave only
  // thin vertical strips (nav↔blob on the left, blob↔rail on the right). Do a
  // fine pixel-scan to slide the card into the first free spot nearest the seed.
  const seedX = seed.col >= COLS / 2 ? W - w - margin : margin;
  const seedY = (seed.row / (ROWS - 1)) * (H - h);
  const STEP = 16;
  let fineBest: SavedPos | null = null;
  let fineDist = Infinity;
  for (let y = margin; y <= H - h - margin; y += STEP) {
    for (let x = margin; x <= W - w - margin; x += STEP) {
      const cand: Rect = { left: x, top: y, right: x + w, bottom: y + h };
      if (noGo.some((z) => overlaps(cand, z))) continue;
      if (taken.some((z) => overlaps(cand, z))) continue;
      const d = Math.abs(x - seedX) + Math.abs(y - seedY);
      if (d < fineDist) { fineDist = d; fineBest = { x, y }; }
    }
  }
  if (fineBest) return fineBest;

  // Truly no clear space (overlays outnumber free strips) — corner fallback that
  // still respects the side chrome: hug just inside the nav (left) / rail (right).
  let leftBound = margin, rightBound = W - w - margin;
  for (const z of noGo) {
    if (z.left <= 2 && z.right < W * 0.5) leftBound = Math.max(leftBound, z.right + 8);   // nav
    if (z.right >= W - 2 && z.left > W * 0.5) rightBound = Math.min(rightBound, z.left - w - 8); // rail
  }
  const fx = seed.col >= COLS / 2 ? Math.max(leftBound, rightBound) : leftBound;
  const fy = seed.row >= ROWS / 2 ? H - h - margin : Math.max(margin, H * 0.18);
  return { x: Math.min(Math.max(margin, fx), W - w - margin), y: fy };
}

/** Clamp a saved position back into view (used when a drag lands off-screen). */
function clampIntoView(p: SavedPos, w: number, h: number): SavedPos {
  const W = window.innerWidth, H = window.innerHeight;
  const margin = 8;
  return {
    x: Math.min(Math.max(margin, p.x), Math.max(margin, W - w - margin)),
    y: Math.min(Math.max(margin, p.y), Math.max(margin, H - h - margin)),
  };
}

// ── Controller ──────────────────────────────────────────────────────────────

export interface FloatingPanelController {
  /** Idempotently (re)assert handle + listeners + layout. Call from updated(). */
  apply(): void;
  /** Whether the panel is currently collapsed. */
  isCollapsed(): boolean;
  /** Programmatically set collapse state. */
  setCollapsed(v: boolean): void;
  /** Tear down listeners (call from disconnectedCallback). */
  destroy(): void;
}

/**
 * Wire drag + collapse + persistence + spatial-awareness onto `el`.
 *
 * `el` is an absolutely-positioned card inside a fullscreen (inset:0) overlay
 * host. The helper owns `el.style.left/top` — callers MUST NOT also bind those
 * in their Lit template (they'd fight each render).
 *
 * Sibling overlays sharing the same overlay host should pass the same elements
 * through `siblingsSelector` so collisions are avoided greedily.
 */
export function makeFloatingPanel(
  host: HTMLElement,
  key: string,
  el: HTMLElement,
  opts: FloatingPanelOpts = {},
): FloatingPanelController {
  const reduced = opts.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let collapsed = loadCollapsed(key) ?? opts.defaultCollapsed ?? false;
  let pos: SavedPos | null = loadPos(key);
  let placedOnce = false;

  // Drag bookkeeping.
  let dragging = false;
  let start: { px: number; py: number; ox: number; oy: number } | null = null;

  el.classList.add('fp-card');
  if (reduced) el.classList.add('fp-reduced');

  // ── Handle + chevron injection (idempotent) ──
  function ensureHandle(): HTMLElement {
    let handle = el.querySelector<HTMLElement>(':scope > .fp-handle');
    if (handle && (handle as any).__fpBound) return handle;
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'fp-handle';
      handle.innerHTML =
        `<span class="fp-grip" aria-hidden="true">⠿</span>` +
        `<span class="fp-mini">${opts.icon ?? '◆'} <em>${opts.collapsedLabel ?? ''}</em></span>` +
        `<button class="fp-chevron" type="button" aria-label="Collapse panel">▾</button>`;
      el.insertBefore(handle, el.firstChild);
    }
    const chevron = handle.querySelector<HTMLElement>('.fp-chevron')!;
    handle.addEventListener('pointerdown', onDown);
    chevron.addEventListener('pointerdown', (e) => e.stopPropagation());
    chevron.addEventListener('click', (e) => { e.stopPropagation(); setCollapsed(!collapsed); });
    (handle as any).__fpBound = true;
    return handle;
  }

  function onDown(e: PointerEvent) {
    if ((e.target as HTMLElement)?.closest('.fp-chevron')) return;
    dragging = true;
    el.classList.add('fp-dragging');
    const r = el.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, ox: r.left, oy: r.top };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    e.preventDefault();
  }
  function onMove(e: PointerEvent) {
    if (!dragging || !start) return;
    const nx = start.ox + (e.clientX - start.px);
    const ny = start.oy + (e.clientY - start.py);
    pos = clampIntoView({ x: nx, y: ny }, el.offsetWidth, el.offsetHeight);
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('fp-dragging');
    window.removeEventListener('pointermove', onMove);
    if (pos) savePos(key, pos);
    opts.onChange?.();
  }

  function setCollapsed(v: boolean) {
    collapsed = v;
    el.classList.toggle('fp-collapsed', v);
    saveCollapsed(key, v);
    opts.onChange?.();
  }

  // ── Layout ──
  function applyLayout() {
    ensureHandle();
    el.classList.toggle('fp-collapsed', collapsed);

    const w = el.offsetWidth || 200;
    const h = collapsed ? 32 : (el.offsetHeight || 120);

    if (pos) {
      // User-dragged (or previously placed) — clamp back into view on mount.
      pos = clampIntoView(pos, w, h);
    } else if (!placedOnce) {
      // First mount with no saved position — greedy bin-fit away from chrome.
      const noGo = detectNoGoZones();
      const siblings = gatherSiblings(host, el);
      pos = binFitPlace(w, h, opts.zone ?? 'mr', noGo, siblings);
    }
    placedOnce = true;
    if (pos) {
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    }
  }

  function onResize() {
    // Re-clamp persisted, or re-place auto cards, on viewport change.
    applyLayout();
  }
  window.addEventListener('resize', onResize);

  // First assert.
  applyLayout();

  return {
    apply: applyLayout,
    isCollapsed: () => collapsed,
    setCollapsed,
    destroy() {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
    },
  };
}

/** Collect bounding rects of other already-placed fp-cards in the same host. */
function gatherSiblings(host: HTMLElement, self: HTMLElement): Rect[] {
  const root = (host as any).shadowRoot ?? host;
  const cards = Array.from(root.querySelectorAll('.fp-card')) as HTMLElement[];
  const out: Rect[] = [];
  for (const c of cards) {
    if (c === self) continue;
    const r = rectOf(c);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Shared CSS for floating-panel chrome. Import + spread into a component's
 * `static styles` so the injected handle + collapsed pill match the HUD's
 * glassmorphism pill language. Uses ONLY dynamic theme tokens.
 */
export const floatingPanelStyles = `
  .fp-card {
    /* Helper owns left/top in px — kill any zone-class translate so the saved
       position is absolute, not offset by a half-height transform. */
    transform: none !important;
    transition: left 220ms cubic-bezier(.2,.8,.2,1), top 220ms cubic-bezier(.2,.8,.2,1),
                box-shadow 180ms ease, border-color 180ms ease;
    pointer-events: auto;
  }
  .fp-card.fp-reduced { transition: none; }
  .fp-card.fp-dragging {
    transition: none;
    cursor: grabbing;
    border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, var(--g-border, rgba(255,255,255,0.12)));
    box-shadow: 0 10px 34px -8px color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
    z-index: 40;
  }
  .fp-handle {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 18px;
    margin: -2px -2px 6px;
    padding: 0 2px;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .fp-handle:active { cursor: grabbing; }
  .fp-grip {
    font-size: 11px;
    line-height: 1;
    letter-spacing: -1px;
    color: color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
    text-shadow: 0 0 6px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
  }
  .fp-mini {
    display: none;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 5px;
    font-size: 9px;
    letter-spacing: 0.12em;
    color: var(--g-fg-dim, rgba(245,245,244,0.7));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fp-mini em { font-style: normal; color: var(--g-fg, #e8ddc4); }
  .fp-chevron {
    margin-left: auto;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--g-fg-dim, rgba(245,245,244,0.6));
    font-size: 11px;
    cursor: pointer;
    transition: background 140ms ease, color 140ms ease, transform 180ms ease;
  }
  .fp-chevron:hover {
    background: color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
    color: var(--g-fg, #e8ddc4);
  }
  /* Collapsed → slim 32px pill: hide everything but the handle, show the mini line. */
  .fp-card.fp-collapsed {
    height: 32px !important;
    min-height: 0 !important;
    overflow: hidden;
    padding-top: 7px !important;
    padding-bottom: 7px !important;
  }
  .fp-card.fp-collapsed > *:not(.fp-handle) { display: none !important; }
  .fp-card.fp-collapsed .fp-handle { margin-bottom: 0; height: 18px; }
  .fp-card.fp-collapsed .fp-mini { display: flex; }
  .fp-card.fp-collapsed .fp-chevron { transform: rotate(-90deg); }
`;
