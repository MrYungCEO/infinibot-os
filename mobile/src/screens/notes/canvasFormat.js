// canvasFormat — serialize a GoodNotes-style handwriting doc into a note body.
//
// The gateway notes model only has a single `body` string (see
// src/gateway/server-methods/notes.ts). To persist a multi-page drawing
// through the existing `notes.create` / `notes.update` / `notes.get` RPCs
// WITHOUT changing the gateway schema, we store the human-readable OCR
// markdown as the visible body and append the canvas document as an HTML
// comment. `react-native-markdown-display` (mobile) and the desktop markdown
// renderer both ignore HTML comments, so the drawing payload stays invisible
// while still round-tripping as plain text.
//
// The payload is URL-encoded JSON — encodeURIComponent escapes `>` to %3E so
// the closing `-->` sequence can never appear inside it, and it needs no
// Buffer/btoa polyfill (which React Native lacks).

const CANVAS_OPEN = '<!--INFINIBOT_CANVAS_V1:';
const CANVAS_CLOSE = '-->';
// Matches the whole appended block (with any leading whitespace) so we can
// strip it back out for the visible markdown.
const CANVAS_RE = /\n*<!--INFINIBOT_CANVAS_V1:([^]*?)-->\s*$/;

export const CANVAS_CATEGORY = 'handwriting';

/** A fresh empty single-page document. */
export function emptyCanvasDoc() {
  return {
    version: 1,
    pageSize: { width: 1240, height: 1754 }, // ~A4 @ 150dpi, portrait
    pages: [emptyPage('p1')],
  };
}

export function emptyPage(id) {
  return { id, strokes: [], shapes: [] };
}

let _idc = 0;
/** Monotonic id — avoids Date.now()/Math.random collisions in tight loops. */
export function makeId(prefix = 'el') {
  _idc = (_idc + 1) % 1e9;
  return `${prefix}_${Date.now().toString(36)}_${_idc.toString(36)}`;
}

/** True if a note carries an embedded handwriting canvas. */
export function isCanvasNote(note) {
  if (!note) return false;
  if (note.category === CANVAS_CATEGORY) return true;
  const body = typeof note.body === 'string' ? note.body : '';
  return body.includes(CANVAS_OPEN);
}

/** Pull the canvas doc + visible markdown back out of a stored note body. */
export function decodeNoteBody(body) {
  const raw = typeof body === 'string' ? body : '';
  const m = raw.match(CANVAS_RE);
  if (!m) return { markdown: raw, doc: null };
  const markdown = raw.replace(CANVAS_RE, '').trim();
  let doc = null;
  try {
    doc = JSON.parse(decodeURIComponent(m[1]));
  } catch {
    doc = null;
  }
  return { markdown, doc: normalizeDoc(doc) };
}

/** Compose the visible OCR markdown + the hidden canvas payload into a body. */
export function encodeNoteBody(markdown, doc) {
  const visible = (typeof markdown === 'string' ? markdown : '').trim();
  const safeDoc = normalizeDoc(doc) || emptyCanvasDoc();
  let payload = '';
  try {
    payload = encodeURIComponent(JSON.stringify(safeDoc));
  } catch {
    payload = encodeURIComponent(JSON.stringify(emptyCanvasDoc()));
  }
  const block = `${CANVAS_OPEN}${payload}${CANVAS_CLOSE}`;
  return visible ? `${visible}\n\n${block}` : block;
}

/** Defensive shape-check so a corrupt payload never crashes the editor. */
export function normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const pages = Array.isArray(doc.pages) && doc.pages.length ? doc.pages : [emptyPage('p1')];
  return {
    version: 1,
    pageSize:
      doc.pageSize && typeof doc.pageSize.width === 'number'
        ? doc.pageSize
        : { width: 1240, height: 1754 },
    pages: pages.map((p, i) => ({
      id: p?.id || `p${i + 1}`,
      strokes: Array.isArray(p?.strokes) ? p.strokes : [],
      shapes: Array.isArray(p?.shapes) ? p.shapes : [],
    })),
  };
}

/** Rough emptiness check used to decide whether OCR is worth running. */
export function docHasInk(doc) {
  const d = normalizeDoc(doc);
  if (!d) return false;
  return d.pages.some((p) => (p.strokes && p.strokes.length) || (p.shapes && p.shapes.length));
}
