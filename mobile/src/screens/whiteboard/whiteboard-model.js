/**
 * whiteboard-model — the native Whiteboard's scene model (pure JS, unit-tested).
 *
 * Mirrors the web Whiteboard plugin (extensions/mcp-excalidraw):
 *   · boards are Excalidraw files saved via whiteboard.boards.save {id, data}
 *   · board ids are slugs: lowercase, spaces → '-', other chars dropped
 *   · the live canvas is fed by gateway `canvas.update` (full scene, last
 *     wins), `canvas.clear` and `canvas.view` broadcasts — the agent tools
 *     and other surfaces push through the same events
 *   · built-in templates are the web controller's BUILTIN_TEMPLATES
 *
 * The colour values below are Excalidraw scene DATA (what gets written into
 * the .excalidraw file so the web canvas renders the same thing) — not UI
 * styling. Screen chrome always uses theme tokens.
 */

import { elementBounds, isLinear, measureText, lineHeightOf, resizeBounds, pointsOf } from './whiteboard-geometry';

// ── Excalidraw data constants ─────────────────────────────────────────────

/** Excalidraw's default (light) canvas background — the web forces it. */
export const PAPER_COLOR = '#ffffff';

/** Excalidraw's quick-pick stroke palette (top row of the web picker). */
export const STROKE_PALETTE = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#6741d9', '#0c8599', '#c2255c'];

/** Excalidraw's quick-pick background palette. */
export const FILL_PALETTE = ['transparent', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#d0bfff', '#99e9f2', '#fcc2d7'];

export const STROKE_WIDTHS = [1, 2, 4];
export const FILL_STYLES = ['solid', 'hachure', 'cross-hatch'];
export const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
export const ROUGHNESS_LEVELS = [0, 1, 2];
export const FONT_SIZES = [16, 20, 28, 36];

/** Canvas tools, in toolbar order (web Excalidraw order, minus image/laser). */
export const TOOLS = [
  { key: 'select', icon: 'navigate-outline', label: 'Select' },
  { key: 'hand', icon: 'hand-left-outline', label: 'Pan' },
  { key: 'rectangle', icon: 'square-outline', label: 'Rectangle' },
  { key: 'diamond', icon: 'diamond-outline', label: 'Diamond' },
  { key: 'ellipse', icon: 'ellipse-outline', label: 'Ellipse' },
  { key: 'arrow', icon: 'arrow-forward-outline', label: 'Arrow' },
  { key: 'line', icon: 'remove-outline', label: 'Line' },
  { key: 'freedraw', icon: 'brush-outline', label: 'Draw' },
  { key: 'text', icon: 'text-outline', label: 'Text' },
  { key: 'eraser', icon: 'backspace-outline', label: 'Eraser' },
];

export const DRAW_TOOLS = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']);

export const DEFAULT_STYLE = {
  strokeColor: STROKE_PALETTE[0],
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  fontSize: 20,
};

// ── ids / slugs ───────────────────────────────────────────────────────────

/** Same id rule as the web controller (createWhiteboard / saveMcpCanvasToBoard). */
export function slugifyBoardName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, 80);
}

/** Valid per the backend store's ID_RE. */
export function isValidBoardId(id) {
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(String(id ?? ''));
}

/** Display name the backend derives from an id ("my-drawing" → "My drawing"). */
export function boardDisplayName(id) {
  return String(id ?? '').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

let idCounter = 0;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export function newElementId(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 16; i++) s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
  idCounter = (idCounter + 1) % 1296;
  return s + idCounter.toString(36).padStart(2, '0');
}

const randInt = () => Math.floor(Math.random() * 2 ** 31);

// ── normalisation ─────────────────────────────────────────────────────────

/**
 * Fill the runtime fields Excalidraw reads (same defaults as the web's
 * prepareElementsForExcalidraw), drop deleted elements, keep every unknown
 * field so a round-trip through the phone never strips web-only data.
 */
export function normalizeElements(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  list.forEach((value, position) => {
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return;
    if (value.isDeleted) return;
    const el = { ...value };
    if (!el.id) el.id = `el-${position}-${newElementId()}`;
    el.x = typeof el.x === 'number' && Number.isFinite(el.x) ? el.x : 0;
    el.y = typeof el.y === 'number' && Number.isFinite(el.y) ? el.y : 0;
    if (typeof el.width !== 'number') el.width = 0;
    if (typeof el.height !== 'number') el.height = 0;
    if (isLinear(el) && !Array.isArray(el.points)) el.points = [[0, 0], [el.width, el.height]];
    if (el.type === 'arrow' && el.endArrowhead === undefined) el.endArrowhead = 'arrow';
    if (el.groupIds == null) el.groupIds = [];
    if (el.boundElements === undefined) el.boundElements = null;
    if (el.angle == null) el.angle = 0;
    if (el.opacity == null) el.opacity = 100;
    if (el.strokeWidth == null) el.strokeWidth = el.type === 'text' ? 1 : 2;
    if (el.fillStyle == null) el.fillStyle = 'solid';
    if (el.roughness == null) el.roughness = 0;
    if (el.strokeColor == null) el.strokeColor = STROKE_PALETTE[0];
    if (el.backgroundColor == null) el.backgroundColor = 'transparent';
    if (el.version == null) el.version = 1;
    if (el.seed == null) el.seed = 1000003 + position;
    // `label` skeleton (convertToExcalidrawElements input) → plain text prop.
    if (el.label && typeof el.label === 'object' && typeof el.label.text === 'string' && el.text == null) {
      el.text = el.label.text;
    }
    out.push(el);
  });
  return out;
}

/** Elements of a board file (`whiteboard.boards.get` → `{ data }`). */
export function sceneFromBoardData(data) {
  return normalizeElements(data && data.elements);
}

/** The .excalidraw file the web writes (saveMcpCanvasToBoard shape). */
export function boardDataFromScene(elements, prev) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'infinibot-mobile',
    elements: (elements || []).filter((e) => e && !e.isDeleted),
    appState: { viewBackgroundColor: PAPER_COLOR, theme: 'light', ...(prev && prev.appState ? { gridSize: prev.appState.gridSize ?? null } : {}) },
    files: (prev && prev.files) || {},
  };
}

/** A cheap identity for a scene — used to drop our own broadcast echoes. */
export function sceneSignature(elements) {
  return (elements || [])
    .map((e) => `${e.id}:${e.version ?? 0}:${Math.round(e.x ?? 0)}:${Math.round(e.y ?? 0)}:${Math.round(e.width ?? 0)}:${Math.round(e.height ?? 0)}`)
    .join('|');
}

/**
 * The web's overwrite guard: never auto-save an empty scene over a board
 * that loaded with content, unless the user explicitly cleared it.
 */
export function shouldAutosave({ boardId, elementCount, loadedCount, explicitClear }) {
  if (!boardId) return false;
  if (elementCount === 0 && loadedCount > 0 && !explicitClear) return false;
  return true;
}

// ── element factory ───────────────────────────────────────────────────────

function base(type, x, y, style) {
  const s = { ...DEFAULT_STYLE, ...(style || {}) };
  return {
    id: newElementId(),
    type,
    x,
    y,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: s.strokeColor,
    backgroundColor: s.backgroundColor,
    fillStyle: s.fillStyle,
    strokeWidth: s.strokeWidth,
    strokeStyle: s.strokeStyle,
    roughness: s.roughness,
    opacity: s.opacity,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: randInt(),
    version: 1,
    versionNonce: randInt(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

/** A new element of `type` at scene (x,y) with the current style. */
export function createElement(type, x, y, style) {
  const el = base(type, x, y, style);
  if (type === 'rectangle' || type === 'diamond') el.roundness = { type: 3 };
  if (type === 'ellipse') el.roundness = { type: 2 };
  if (type === 'arrow' || type === 'line') {
    el.points = [[0, 0], [0, 0]];
    el.lastCommittedPoint = null;
    el.startBinding = null;
    el.endBinding = null;
    el.startArrowhead = null;
    el.endArrowhead = type === 'arrow' ? 'arrow' : null;
    el.backgroundColor = 'transparent';
    if (type === 'arrow') el.roundness = { type: 2 };
  }
  if (type === 'freedraw') {
    el.points = [[0, 0]];
    el.pressures = [];
    el.simulatePressure = true;
    el.lastCommittedPoint = null;
    el.backgroundColor = 'transparent';
    el.roughness = 0;
  }
  if (type === 'text') {
    const s = { ...DEFAULT_STYLE, ...(style || {}) };
    el.text = '';
    el.originalText = '';
    el.fontSize = s.fontSize;
    el.fontFamily = 5;
    el.textAlign = 'left';
    el.verticalAlign = 'top';
    el.containerId = null;
    el.autoResize = true;
    el.lineHeight = 1.25;
    el.backgroundColor = 'transparent';
    el.strokeWidth = 1;
  }
  return el;
}

export function bump(el, patch) {
  return { ...el, ...patch, version: (el.version || 1) + 1, versionNonce: randInt(), updated: Date.now() };
}

/** Recompute width/height of a linear/freedraw element from its points. */
export function withPointExtents(el) {
  const pts = pointsOf(el);
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const [px, py] of pts) {
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { ...el, width: maxX - minX, height: maxY - minY };
}

/** Normalize a dragged box (negative width/height → positive with moved origin). */
export function boxFromDrag(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** Text element with its text + measured size. */
export function setText(el, text) {
  const t = String(text ?? '');
  if (el.type !== 'text') return bump(el, { text: t });
  const m = measureText(t, el.fontSize || 20, el.fontFamily, lineHeightOf(el));
  return bump(el, { text: t, originalText: t, width: m.width, height: m.height });
}

// ── scene operations (all return new arrays) ──────────────────────────────

/** Bound text elements of the given container ids. */
export function boundTextIds(elements, ids) {
  const set = new Set(ids);
  return elements.filter((e) => e.type === 'text' && e.containerId && set.has(e.containerId)).map((e) => e.id);
}

/** Expand a selection to whole groups (outermost group), like Excalidraw. */
export function expandToGroups(elements, ids) {
  const out = new Set(ids);
  for (const id of ids) {
    const el = elements.find((e) => e.id === id);
    const g = el && Array.isArray(el.groupIds) && el.groupIds.length ? el.groupIds[el.groupIds.length - 1] : null;
    if (!g) continue;
    for (const e of elements) if (Array.isArray(e.groupIds) && e.groupIds.includes(g)) out.add(e.id);
  }
  return [...out];
}

export function addElement(elements, el) {
  return [...elements, el];
}

export function replaceElement(elements, el) {
  return elements.map((e) => (e.id === el.id ? el : e));
}

/** Move elements (plus their bound text, and arrow ends bound to them). */
export function moveElements(elements, ids, dx, dy) {
  if (!dx && !dy) return elements;
  const moving = new Set([...ids, ...boundTextIds(elements, ids)]);
  return elements.map((e) => {
    if (moving.has(e.id)) return bump(e, { x: e.x + dx, y: e.y + dy });
    if (isLinear(e) && (e.startBinding || e.endBinding)) {
      const s = e.startBinding && moving.has(e.startBinding.elementId);
      const t = e.endBinding && moving.has(e.endBinding.elementId);
      if (!s && !t) return e;
      if (s && t) return bump(e, { x: e.x + dx, y: e.y + dy });
      const pts = pointsOf(e).map((p) => [p[0], p[1]]);
      if (t) {
        pts[pts.length - 1] = [pts[pts.length - 1][0] + dx, pts[pts.length - 1][1] + dy];
        return withPointExtents(bump(e, { points: pts }));
      }
      // start moved: shift origin, keep the other points fixed in scene space
      const shifted = pts.map((p, i) => (i === 0 ? [0, 0] : [p[0] - dx, p[1] - dy]));
      return withPointExtents(bump(e, { x: e.x + dx, y: e.y + dy, points: shifted }));
    }
    return e;
  });
}

/** Resize a single element by dragging corner handle `h` to scene (px,py). */
export function resizeElement(el, h, px, py) {
  const b = elementBounds(el);
  const keep = el.type === 'text';
  const nb = resizeBounds(b, h, px, py, 4, keep);
  const ow = b.maxX - b.minX || 1;
  const oh = b.maxY - b.minY || 1;
  const sx = (nb.maxX - nb.minX) / ow;
  const sy = (nb.maxY - nb.minY) / oh;
  if (isLinear(el) || el.type === 'freedraw') {
    // Scale every point in scene space, then re-anchor on the first point.
    const scene = pointsOf(el).map(([x, y]) => [nb.minX + (el.x + x - b.minX) * sx, nb.minY + (el.y + y - b.minY) * sy]);
    const [fx, fy] = scene[0];
    return withPointExtents(bump(el, { x: fx, y: fy, points: scene.map(([x, y]) => [x - fx, y - fy]) }));
  }
  if (el.type === 'text') {
    const fontSize = Math.max(6, Math.round((el.fontSize || 20) * sy * 10) / 10);
    const m = measureText(el.text, fontSize, el.fontFamily, lineHeightOf(el));
    return bump(el, { x: nb.minX, y: nb.minY, fontSize, width: m.width, height: m.height });
  }
  return bump(el, { x: nb.minX, y: nb.minY, width: nb.maxX - nb.minX, height: nb.maxY - nb.minY });
}

/** Delete elements, their bound text, and unbind arrows that pointed at them. */
export function deleteElements(elements, ids) {
  const gone = new Set([...ids, ...boundTextIds(elements, ids)]);
  return elements
    .filter((e) => !gone.has(e.id))
    .map((e) => {
      let next = e;
      if (isLinear(e)) {
        if (e.startBinding && gone.has(e.startBinding.elementId)) next = bump(next, { startBinding: null });
        if (e.endBinding && gone.has(e.endBinding.elementId)) next = bump(next, { endBinding: null });
      }
      if (Array.isArray(e.boundElements) && e.boundElements.some((b) => b && gone.has(b.id))) {
        next = bump(next, { boundElements: e.boundElements.filter((b) => b && !gone.has(b.id)) });
      }
      return next;
    });
}

/** Duplicate elements (+ bound text) offset by `offset`; returns { elements, ids }. */
export function duplicateElements(elements, ids, offset = 16) {
  const src = new Set([...ids, ...boundTextIds(elements, ids)]);
  const idMap = new Map();
  for (const id of src) idMap.set(id, newElementId());
  const copies = elements
    .filter((e) => src.has(e.id))
    .map((e) => ({
      ...e,
      id: idMap.get(e.id),
      x: e.x + offset,
      y: e.y + offset,
      seed: randInt(),
      version: 1,
      versionNonce: randInt(),
      updated: Date.now(),
      containerId: e.containerId && idMap.has(e.containerId) ? idMap.get(e.containerId) : e.containerId ?? undefined,
      boundElements: Array.isArray(e.boundElements)
        ? e.boundElements.filter((b) => b && idMap.has(b.id)).map((b) => ({ ...b, id: idMap.get(b.id) }))
        : e.boundElements,
      startBinding: null,
      endBinding: null,
    }))
    .map((e) => {
      const c = { ...e };
      if (c.containerId === undefined) delete c.containerId;
      if (!isLinear(c)) {
        delete c.startBinding;
        delete c.endBinding;
      }
      return c;
    });
  return { elements: [...elements, ...copies], ids: ids.map((id) => idMap.get(id)).filter(Boolean) };
}

/** Apply a style patch to the selection (+ bound text for colour/opacity). */
export function updateStyle(elements, ids, patch) {
  const target = new Set(ids);
  const textToo = new Set(boundTextIds(elements, ids));
  return elements.map((e) => {
    if (target.has(e.id)) {
      let p = { ...patch };
      if (e.type === 'text' && p.fontSize) {
        const m = measureText(e.text, p.fontSize, e.fontFamily, lineHeightOf(e));
        p = { ...p, width: m.width, height: m.height };
      }
      if (e.type !== 'text') delete p.fontSize;
      return bump(e, p);
    }
    if (textToo.has(e.id)) {
      const p = {};
      if (patch.strokeColor) p.strokeColor = patch.strokeColor;
      if (patch.opacity != null) p.opacity = patch.opacity;
      if (patch.fontSize) {
        const m = measureText(e.text, patch.fontSize, e.fontFamily, lineHeightOf(e));
        Object.assign(p, { fontSize: patch.fontSize, width: m.width, height: m.height });
      }
      return Object.keys(p).length ? bump(e, p) : e;
    }
    return e;
  });
}

/** Z-order moves (bring to front / send to back). */
export function reorder(elements, ids, where) {
  const set = new Set([...ids, ...boundTextIds(elements, ids)]);
  const picked = elements.filter((e) => set.has(e.id));
  const rest = elements.filter((e) => !set.has(e.id));
  return where === 'back' ? [...picked, ...rest] : [...rest, ...picked];
}

/** Text shown inside a container: bound text element, or the shape's own `text`. */
export function containerLabel(elements, container) {
  const bound = elements.find((e) => e.type === 'text' && e.containerId === container.id);
  if (bound) return { kind: 'bound', element: bound };
  if (typeof container.text === 'string' && container.text) return { kind: 'inline', text: container.text };
  return null;
}

/**
 * Set or create the label of a container (shape/arrow). Creates a bound text
 * element the web canvas understands (containerId + boundElements link).
 */
export function setContainerLabel(elements, containerId, text) {
  const container = elements.find((e) => e.id === containerId);
  if (!container) return elements;
  const bound = elements.find((e) => e.type === 'text' && e.containerId === containerId);
  const t = String(text ?? '');
  if (bound) {
    if (!t) return deleteElements(elements, [bound.id]).map((e) => (e.id === containerId ? bump(e, { boundElements: (e.boundElements || []).filter((b) => b.id !== bound.id) }) : e));
    return replaceElement(elements, setText(bound, t));
  }
  if (typeof container.text === 'string') return replaceElement(elements, bump(container, { text: t }));
  if (!t) return elements;
  const b = elementBounds(container);
  const label = setText(
    { ...createElement('text', b.minX, b.minY, { strokeColor: container.strokeColor, fontSize: 20 }), textAlign: 'center', verticalAlign: 'middle', containerId },
    t,
  );
  const placed = { ...label, x: (b.minX + b.maxX) / 2 - label.width / 2, y: (b.minY + b.maxY) / 2 - label.height / 2 };
  const linked = bump(container, { boundElements: [...(container.boundElements || []), { id: placed.id, type: 'text' }] });
  return [...replaceElement(elements, linked), placed];
}

// ── eraser ────────────────────────────────────────────────────────────────

/** Ids under the eraser at (x,y). */
export function eraseAt(elements, x, y, tol, hit) {
  const ids = [];
  for (const e of elements) if (hit(e, x, y, tol)) ids.push(e.type === 'text' && e.containerId ? e.containerId : e.id);
  return ids;
}

// ── history ───────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 100;

export function createHistory(initial = []) {
  return { past: [], present: initial, future: [] };
}

/** Record a new present (no-op when unchanged). */
export function pushHistory(h, next) {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undo(h) {
  if (!h.past.length) return h;
  const prev = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h) {
  if (!h.future.length) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}

export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;

// ── templates (web controller BUILTIN_TEMPLATES, verbatim data) ───────────

const T = (elements) => ({
  type: 'excalidraw',
  version: 2,
  source: 'infinibot-template',
  elements,
  appState: { viewBackgroundColor: '#121212', theme: 'dark' },
  files: {},
});

export const BUILTIN_TEMPLATES = [
  { id: 'blank', name: 'Blank Canvas', description: 'Start with a clean slate', category: 'Basic', icon: 'square-outline', data: T([]) },
  {
    id: 'flowchart',
    name: 'Flowchart',
    description: 'Basic flowchart structure',
    category: 'Diagrams',
    icon: 'git-network-outline',
    data: T([
      { type: 'rectangle', x: 200, y: 100, width: 150, height: 60, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'start', roughness: 0 },
      { type: 'text', x: 230, y: 120, text: 'Start', fontSize: 20, fontFamily: 1, id: 'start-text' },
      { type: 'arrow', x: 275, y: 160, width: 0, height: 60, strokeColor: '#6366f1', id: 'arrow1' },
      { type: 'rectangle', x: 200, y: 230, width: 150, height: 60, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'process', roughness: 0 },
      { type: 'text', x: 220, y: 250, text: 'Process', fontSize: 20, fontFamily: 1, id: 'process-text' },
      { type: 'arrow', x: 275, y: 290, width: 0, height: 60, strokeColor: '#6366f1', id: 'arrow2' },
      { type: 'diamond', x: 200, y: 360, width: 150, height: 80, strokeColor: '#f59e0b', backgroundColor: '#2a2a1e', fillStyle: 'solid', id: 'decision', roughness: 0 },
      { type: 'text', x: 230, y: 390, text: 'Decision', fontSize: 18, fontFamily: 1, id: 'decision-text' },
    ]),
  },
  {
    id: 'mindmap',
    name: 'Mind Map',
    description: 'Central idea with branches',
    category: 'Brainstorming',
    icon: 'git-merge-outline',
    data: T([
      { type: 'ellipse', x: 350, y: 250, width: 200, height: 100, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'center', roughness: 0 },
      { type: 'text', x: 400, y: 285, text: 'Main Idea', fontSize: 24, fontFamily: 1, id: 'center-text' },
      { type: 'line', x: 450, y: 250, width: -150, height: -100, strokeColor: '#6366f1', id: 'branch1' },
      { type: 'ellipse', x: 200, y: 100, width: 120, height: 60, strokeColor: '#10b981', backgroundColor: '#1a2e2a', fillStyle: 'solid', id: 'node1', roughness: 0 },
      { type: 'text', x: 225, y: 120, text: 'Topic 1', fontSize: 16, fontFamily: 1, id: 'node1-text' },
      { type: 'line', x: 450, y: 250, width: 150, height: -100, strokeColor: '#6366f1', id: 'branch2' },
      { type: 'ellipse', x: 530, y: 100, width: 120, height: 60, strokeColor: '#f59e0b', backgroundColor: '#2a2a1e', fillStyle: 'solid', id: 'node2', roughness: 0 },
      { type: 'text', x: 555, y: 120, text: 'Topic 2', fontSize: 16, fontFamily: 1, id: 'node2-text' },
      { type: 'line', x: 450, y: 350, width: -150, height: 100, strokeColor: '#6366f1', id: 'branch3' },
      { type: 'ellipse', x: 200, y: 400, width: 120, height: 60, strokeColor: '#ec4899', backgroundColor: '#2a1a2a', fillStyle: 'solid', id: 'node3', roughness: 0 },
      { type: 'text', x: 225, y: 420, text: 'Topic 3', fontSize: 16, fontFamily: 1, id: 'node3-text' },
      { type: 'line', x: 450, y: 350, width: 150, height: 100, strokeColor: '#6366f1', id: 'branch4' },
      { type: 'ellipse', x: 530, y: 400, width: 120, height: 60, strokeColor: '#3b82f6', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'node4', roughness: 0 },
      { type: 'text', x: 555, y: 420, text: 'Topic 4', fontSize: 16, fontFamily: 1, id: 'node4-text' },
    ]),
  },
  {
    id: 'wireframe',
    name: 'Wireframe',
    description: 'Basic UI wireframe layout',
    category: 'Design',
    icon: 'browsers-outline',
    data: T([
      { type: 'rectangle', x: 100, y: 50, width: 600, height: 500, strokeColor: '#6366f1', backgroundColor: 'transparent', fillStyle: 'solid', id: 'frame', roughness: 0 },
      { type: 'rectangle', x: 100, y: 50, width: 600, height: 60, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'header', roughness: 0 },
      { type: 'text', x: 120, y: 70, text: 'Header / Navigation', fontSize: 18, fontFamily: 1, id: 'header-text' },
      { type: 'rectangle', x: 100, y: 120, width: 150, height: 430, strokeColor: '#6366f1', backgroundColor: '#0f0f1a', fillStyle: 'solid', id: 'sidebar', roughness: 0 },
      { type: 'text', x: 130, y: 150, text: 'Sidebar', fontSize: 16, fontFamily: 1, id: 'sidebar-text' },
      { type: 'rectangle', x: 260, y: 120, width: 440, height: 350, strokeColor: '#6366f1', backgroundColor: 'transparent', fillStyle: 'solid', id: 'content', roughness: 0 },
      { type: 'text', x: 420, y: 280, text: 'Main Content', fontSize: 20, fontFamily: 1, id: 'content-text' },
      { type: 'rectangle', x: 260, y: 480, width: 440, height: 70, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'footer', roughness: 0 },
      { type: 'text', x: 430, y: 505, text: 'Footer', fontSize: 16, fontFamily: 1, id: 'footer-text' },
    ]),
  },
  {
    id: 'kanban',
    name: 'Kanban Board',
    description: 'Task board with columns',
    category: 'Project Management',
    icon: 'albums-outline',
    data: T([
      { type: 'rectangle', x: 50, y: 50, width: 200, height: 400, strokeColor: '#6366f1', backgroundColor: '#1a1a3e', fillStyle: 'solid', id: 'col1', roughness: 0 },
      { type: 'text', x: 110, y: 70, text: 'To Do', fontSize: 20, fontFamily: 1, id: 'col1-title' },
      { type: 'rectangle', x: 70, y: 110, width: 160, height: 50, strokeColor: '#3b82f6', backgroundColor: '#0f0f1a', fillStyle: 'solid', id: 'task1', roughness: 0 },
      { type: 'text', x: 90, y: 125, text: 'Task 1', fontSize: 14, fontFamily: 1, id: 'task1-text' },
      { type: 'rectangle', x: 70, y: 170, width: 160, height: 50, strokeColor: '#3b82f6', backgroundColor: '#0f0f1a', fillStyle: 'solid', id: 'task2', roughness: 0 },
      { type: 'text', x: 90, y: 185, text: 'Task 2', fontSize: 14, fontFamily: 1, id: 'task2-text' },
      { type: 'rectangle', x: 270, y: 50, width: 200, height: 400, strokeColor: '#f59e0b', backgroundColor: '#2a2a1e', fillStyle: 'solid', id: 'col2', roughness: 0 },
      { type: 'text', x: 310, y: 70, text: 'In Progress', fontSize: 20, fontFamily: 1, id: 'col2-title' },
      { type: 'rectangle', x: 290, y: 110, width: 160, height: 50, strokeColor: '#f59e0b', backgroundColor: '#0f0f1a', fillStyle: 'solid', id: 'task3', roughness: 0 },
      { type: 'text', x: 310, y: 125, text: 'Task 3', fontSize: 14, fontFamily: 1, id: 'task3-text' },
      { type: 'rectangle', x: 490, y: 50, width: 200, height: 400, strokeColor: '#10b981', backgroundColor: '#1a2e2a', fillStyle: 'solid', id: 'col3', roughness: 0 },
      { type: 'text', x: 555, y: 70, text: 'Done', fontSize: 20, fontFamily: 1, id: 'col3-title' },
      { type: 'rectangle', x: 510, y: 110, width: 160, height: 50, strokeColor: '#10b981', backgroundColor: '#0f0f1a', fillStyle: 'solid', id: 'task4', roughness: 0 },
      { type: 'text', x: 530, y: 125, text: 'Task 4', fontSize: 14, fontFamily: 1, id: 'task4-text' },
    ]),
  },
];

/** Group templates by category, preserving first-seen order. */
export function groupTemplates(templates) {
  const map = new Map();
  for (const t of templates || []) {
    const cat = t.category || 'Other';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(t);
  }
  return [...map.entries()].map(([category, items]) => ({ category, items }));
}

/**
 * The web's template → canvas element prep (loadTemplateToMcpCanvas): fill
 * fillStyle/roughness/opacity/strokeWidth defaults. `fresh` re-ids elements
 * like applyTemplate does when a template seeds a NEW board.
 */
export function templateElements(template, fresh = false) {
  const els = ((template && template.data && template.data.elements) || []).map((el) => ({
    ...el,
    fillStyle: el.fillStyle || 'solid',
    roughness: el.roughness ?? 0,
    opacity: el.opacity ?? 100,
    strokeWidth: el.strokeWidth ?? 2,
  }));
  const withIds = fresh
    ? els.map((el) => ({ ...el, id: `${el.id || 'el'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, seed: randInt(), version: 1, versionNonce: randInt() }))
    : els;
  return normalizeElements(withIds);
}

/** Merge custom templates (whiteboard.templates.list + get) after the built-ins. */
export function mergeTemplates(custom) {
  const extra = (custom || [])
    .filter((c) => c && c.id && c.data)
    .map((c) => ({ id: `custom-${c.id}`, name: c.name || boardDisplayName(c.id), description: 'Custom template', category: 'Custom', icon: 'bookmark-outline', data: c.data }));
  return [...BUILTIN_TEMPLATES, ...extra];
}

// ── boards list ───────────────────────────────────────────────────────────

/** Normalise `whiteboard.boards.list` rows and sort newest first. */
export function normalizeBoards(res) {
  const rows = Array.isArray(res && res.boards) ? res.boards : Array.isArray(res) ? res : [];
  return rows
    .filter((b) => b && b.id)
    .map((b) => ({ id: String(b.id), name: b.name || boardDisplayName(b.id), createdAt: Number(b.createdAt) || 0, updatedAt: Number(b.updatedAt) || 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / date. */
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** A free board id for a template-seeded board ("flowchart-2", "-3", …). */
export function uniqueBoardId(base, existing) {
  const ids = new Set((existing || []).map((b) => (typeof b === 'string' ? b : b.id)));
  const root = slugifyBoardName(base) || 'board';
  if (!ids.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const id = `${root}-${i}`.slice(0, 80);
    if (!ids.has(id)) return id;
  }
  return `${root}-${Date.now().toString(36)}`.slice(0, 80);
}

// ── canvas architect (sessions.spawn agentId canvas) ──────────────────────

export const ARCHITECT_HINTS = [
  'Draw a flowchart for user login',
  'Create an architecture diagram',
  'Add a database node connected to API',
];

export function architectSpawnParams(task) {
  return { agentId: 'canvas', task: String(task || '').trim(), label: 'Canvas Request', cleanup: 'keep', runTimeoutSeconds: 120 };
}

/** First assistant reply from a `sessions.transcript` result, or null. */
export function architectReply(res) {
  const turns = Array.isArray(res && res.turns) ? res.turns : [];
  const t = turns.find((x) => x && x.role === 'assistant' && typeof x.text === 'string' && x.text.trim());
  return t ? t.text.trim() : null;
}

// ── element summary (for the status strip / a11y) ─────────────────────────

export function sceneSummary(elements) {
  const counts = {};
  for (const e of elements || []) counts[e.type] = (counts[e.type] || 0) + 1;
  const n = (elements || []).length;
  return { count: n, counts, label: n === 1 ? '1 element' : `${n} elements` };
}

// ── rotation-aware resize, rotate, arrow binding ──────────────────────────

const OPPOSITE = { nw: 'se', ne: 'sw', se: 'nw', sw: 'ne' };

function cornerOf(b, h) {
  return [h.includes('w') ? b.minX : b.maxX, h.includes('n') ? b.minY : b.maxY];
}

function rot(px, py, cx, cy, a) {
  if (!a) return [px, py];
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c];
}

/**
 * Resize a (possibly rotated) element by dragging handle `h` to scene (px,py):
 * the drag point is taken into the element's local frame, the element is
 * resized there, then shifted so the opposite corner stays put on screen.
 */
export function resizeRotated(el, h, px, py) {
  const angle = el.angle || 0;
  if (!angle) return resizeElement(el, h, px, py);
  const b = elementBounds(el);
  const c = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const anchorLocal = cornerOf(b, OPPOSITE[h]);
  const anchorScene = rot(anchorLocal[0], anchorLocal[1], c[0], c[1], angle);
  const [lx, ly] = rot(px, py, c[0], c[1], -angle);
  const resized = resizeElement({ ...el, angle: 0 }, h, lx, ly);
  const nb = elementBounds(resized);
  const nc = [(nb.minX + nb.maxX) / 2, (nb.minY + nb.maxY) / 2];
  const newAnchorLocal = cornerOf(nb, OPPOSITE[h]);
  const newAnchorScene = rot(newAnchorLocal[0], newAnchorLocal[1], nc[0], nc[1], angle);
  return { ...resized, angle, x: resized.x + anchorScene[0] - newAnchorScene[0], y: resized.y + anchorScene[1] - newAnchorScene[1] };
}

export function rotateElements(elements, ids, angle) {
  const set = new Set([...ids, ...boundTextIds(elements, ids)]);
  return elements.map((e) => (set.has(e.id) && e.type !== 'arrow' && e.type !== 'line' ? bump(e, { angle }) : e));
}

/**
 * Bind a freshly drawn arrow's ends to the shapes under them (Excalidraw
 * startBinding/endBinding + the shape's boundElements back-link), so moving
 * the shape later drags the arrow end along.
 */
export function bindArrowEnds(elements, arrowId, hitFn) {
  const arrow = elements.find((e) => e.id === arrowId);
  if (!arrow || !isLinear(arrow)) return elements;
  const pts = pointsOf(arrow);
  const ends = [pts[0], pts[pts.length - 1]].map(([x, y]) => [arrow.x + x, arrow.y + y]);
  const targetAt = ([x, y]) => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const e = elements[i];
      if (e.id === arrowId || isLinear(e) || e.type === 'text' || e.type === 'freedraw') continue;
      if (hitFn(e, x, y, 6)) return e.id;
    }
    return null;
  };
  const startId = targetAt(ends[0]);
  const endId = targetAt(ends[1]);
  if (!startId && !endId) return elements;
  return elements.map((e) => {
    if (e.id === arrowId) {
      return bump(e, {
        startBinding: startId ? { elementId: startId, focus: 0, gap: 4 } : null,
        endBinding: endId && endId !== startId ? { elementId: endId, focus: 0, gap: 4 } : null,
      });
    }
    if (e.id === startId || e.id === endId) {
      const list = Array.isArray(e.boundElements) ? e.boundElements : [];
      if (list.some((b) => b && b.id === arrowId)) return e;
      return bump(e, { boundElements: [...list, { id: arrowId, type: 'arrow' }] });
    }
    return e;
  });
}

/**
 * Re-centre bound text inside its (moved/resized/rotated) container so the
 * saved file matches what the web canvas expects to find.
 */
export function syncBoundText(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  let changed = false;
  const out = elements.map((e) => {
    if (e.type !== 'text' || !e.containerId) return e;
    const c = byId.get(e.containerId);
    if (!c) return e;
    const b = elementBounds(c);
    const m = measureText(e.text, e.fontSize || 20, e.fontFamily, lineHeightOf(e));
    const w = Math.min(m.width, Math.max(10, b.maxX - b.minX - 10));
    const x = (b.minX + b.maxX) / 2 - w / 2;
    const y = (b.minY + b.maxY) / 2 - m.height / 2;
    const angle = isLinear(c) ? 0 : c.angle || 0;
    if (Math.abs(x - e.x) < 0.5 && Math.abs(y - e.y) < 0.5 && (e.angle || 0) === angle) return e;
    changed = true;
    return bump(e, { x, y, width: w, height: m.height, angle });
  });
  return changed ? out : elements;
}
