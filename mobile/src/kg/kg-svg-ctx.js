/**
 * A CanvasRenderingContext2D-shaped recorder that turns the web graph's 2D
 * map drawing (ui/src/ui/components/knowledge-graph-map2d.ts, bundled in
 * ./generated/kg-core.js) into a flat display list react-native-svg renders.
 *
 * It covers exactly what the map uses: save/restore, setTransform /
 * translate / scale (uniform), paths (moveTo, lineTo, arc, bezierCurveTo,
 * closePath, fillRect), fill / stroke with colours or linear / radial
 * gradients, globalAlpha, line width / cap / join / dash / dash offset,
 * shadowBlur glow (drawn as a soft radial halo under the shape — the SVG
 * equivalent of the canvas shadow), fillText / strokeText with
 * textAlign / textBaseline, and measureText (Inter advance widths).
 *
 * Coordinates are baked into stage px, so the list renders in one <Svg>
 * with no nested transforms. Pure JS (no React) — unit-tested in jest.
 */

// Inter advance widths (per 1000 em) for ASCII 32..126, then "…" and "·",
// measured from the bundled Inter TTFs (@expo-google-fonts/inter).
const INTER_WIDTHS = {
  500: [267,304,494,639,646,993,653,313,369,369,521,667,303,462,303,370,646,415,616,627,656,603,630,571,629,630,303,315,667,667,667,527,982,709,657,733,722,603,589,748,745,272,575,688,565,913,756,767,642,769,648,646,653,740,709,1003,701,696,641,369,370,369,477,463,337,568,618,577,618,587,379,620,602,252,252,559,252,888,602,604,618,618,387,539,340,602,575,829,557,575,559,440,346,440,667,910,303],
  600: [252,321,523,644,650,1004,663,326,373,373,540,673,319,465,319,379,660,423,623,636,666,612,640,576,640,640,319,329,673,673,673,543,999,728,659,737,722,605,588,749,746,277,580,703,565,922,759,769,645,773,652,650,660,736,728,1020,720,713,652,373,379,373,481,469,351,574,624,583,624,591,389,625,612,262,262,569,262,900,612,609,624,624,397,549,353,612,587,839,569,588,566,455,359,455,673,956,319],
  700: [237,338,552,649,655,1016,672,339,377,377,559,679,334,468,334,388,674,431,630,646,676,622,649,582,651,649,334,343,679,679,679,560,1016,747,662,740,722,607,587,750,747,281,584,719,565,932,762,771,648,777,657,655,667,732,747,1038,738,731,664,377,388,377,487,476,365,581,630,588,630,596,398,632,623,271,271,580,271,913,623,613,630,630,407,560,366,623,600,850,580,602,573,469,372,469,679,1002,334],
};

/** The app's loaded Inter faces (src/hooks/useFonts) by canvas weight. */
export const INTER_FAMILY = { 400: 'Inter-Regular', 500: 'Inter-Medium', 600: 'Inter-SemiBold', 700: 'Inter-Bold', 800: 'Inter-ExtraBold' };

/** "600 11px Inter, …" → { weight, size }. */
export function parseFont(font) {
  const m = /(?:(\d{3}|bold|normal)\s+)?(\d+(?:\.\d+)?)px/.exec(String(font || ''));
  if (!m) return { weight: 400, size: 10 };
  const w = m[1] === 'bold' ? 700 : m[1] === 'normal' || !m[1] ? 400 : Number(m[1]);
  return { weight: w, size: Number(m[2]) };
}

export function measureInter(text, font) {
  const { weight, size } = parseFont(font);
  const table = INTER_WIDTHS[weight >= 650 ? 700 : weight >= 550 ? 600 : 500];
  let w = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c < 127) w += table[c - 32];
    else if (ch === '…') w += table[95];
    else if (ch === '·') w += table[96];
    else w += c > 0x2e80 ? 1000 : 600; // CJK ≈ 1 em, other glyphs ≈ average
  }
  return (w / 1000) * size;
}

const TAU = Math.PI * 2;
const r2 = (v) => Math.round(v * 100) / 100;

class Gradient {
  constructor(kind, coords) {
    this.kind = kind;
    this.coords = coords;
    this.stops = [];
  }
  addColorStop(offset, color) {
    this.stops.push({ offset, color });
  }
}

function initialState() {
  return {
    m: [1, 0, 0, 1, 0, 0],
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    lineDash: [],
    lineDashOffset: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowBlur: 0,
    shadowColor: 'transparent',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
}

const STATE_KEYS = Object.keys(initialState());

/** True for colours that draw nothing (shadowColor "transparent", rgba(…,0)). */
function invisible(c) {
  if (!c || c === 'transparent') return true;
  const m = /rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(c);
  return !!m && Number(m[1]) === 0;
}

/** rgba(r,g,b,a) / #rrggbb / rgb() with alpha scaled by k. */
export function scaleAlpha(c, k) {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return `rgba(${p[0]},${p[1]},${p[2]},${r2((p[3] ?? 1) * k)})`;
  }
  const h = /^#([0-9a-f]{6})$/i.exec(c);
  if (h) {
    const v = parseInt(h[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${r2(k)})`;
  }
  return c;
}

export class SvgCtx {
  constructor({ measure = measureInter } = {}) {
    this.items = [];
    this.defs = [];
    this._defKeys = new Map();
    this._id = 0;
    this._stack = [];
    this._path = [];
    this._bbox = null;
    this._cur = null;
    this._measure = measure;
    Object.assign(this, initialState());
  }

  // ── State ──
  save() {
    const s = {};
    for (const k of STATE_KEYS) s[k] = k === 'm' ? [...this.m] : k === 'lineDash' ? [...this.lineDash] : this[k];
    this._stack.push(s);
  }
  restore() {
    const s = this._stack.pop();
    if (s) Object.assign(this, s);
  }
  setTransform(a, b, c, d, e, f) {
    this.m = [a, b, c, d, e, f];
  }
  translate(x, y) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
  }
  scale(sx, sy) {
    const [a, b, c, d, e, f] = this.m;
    this.m = [a * sx, b * sx, c * sy, d * sy, e, f];
  }
  setLineDash(arr) {
    this.lineDash = Array.isArray(arr) ? [...arr] : [];
  }
  getLineDash() {
    return [...this.lineDash];
  }
  clearRect() {
    // The display list starts empty; the stage background shows through.
  }

  _pt(x, y) {
    const [a, b, c, d, e, f] = this.m;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  /** Uniform scale of the current transform. */
  get _s() {
    const [a, b] = this.m;
    return Math.hypot(a, b) || 1;
  }

  // ── Paths ──
  beginPath() {
    this._path = [];
    this._bbox = null;
    this._cur = null;
  }
  _grow(x, y, pad = 0) {
    const bb = this._bbox || (this._bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    bb.x0 = Math.min(bb.x0, x - pad);
    bb.y0 = Math.min(bb.y0, y - pad);
    bb.x1 = Math.max(bb.x1, x + pad);
    bb.y1 = Math.max(bb.y1, y + pad);
  }
  moveTo(x, y) {
    const [px, py] = this._pt(x, y);
    this._path.push(`M${r2(px)} ${r2(py)}`);
    this._cur = [px, py];
    this._start = [px, py];
    this._grow(px, py);
  }
  lineTo(x, y) {
    const [px, py] = this._pt(x, y);
    this._path.push(`${this._cur ? 'L' : 'M'}${r2(px)} ${r2(py)}`);
    if (!this._cur) this._start = [px, py];
    this._cur = [px, py];
    this._grow(px, py);
  }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) {
    if (!this._cur) this.moveTo(c1x, c1y);
    const a = this._pt(c1x, c1y);
    const b = this._pt(c2x, c2y);
    const e = this._pt(x, y);
    this._path.push(`C${r2(a[0])} ${r2(a[1])} ${r2(b[0])} ${r2(b[1])} ${r2(e[0])} ${r2(e[1])}`);
    this._cur = e;
    this._grow(e[0], e[1]);
    this._grow(a[0], a[1]);
    this._grow(b[0], b[1]);
  }
  closePath() {
    if (!this._path.length) return;
    this._path.push('Z');
    if (this._start) this._cur = [...this._start];
  }
  arc(x, y, r, a0, a1, ccw = false) {
    const [cx, cy] = this._pt(x, y);
    const R = Math.max(0, r * this._s);
    let sweep = a1 - a0;
    if (!ccw && sweep < 0) sweep = (sweep % TAU) + TAU;
    if (ccw && sweep > 0) sweep = (sweep % TAU) - TAU;
    const full = Math.abs(sweep) >= TAU - 1e-6;
    const sx = cx + R * Math.cos(a0);
    const sy = cy + R * Math.sin(a0);
    // Canvas: a line joins the current point to the arc's start.
    if (this._cur && (Math.abs(this._cur[0] - sx) > 0.01 || Math.abs(this._cur[1] - sy) > 0.01)) this._path.push(`L${r2(sx)} ${r2(sy)}`);
    else if (!this._cur) {
      this._path.push(`M${r2(sx)} ${r2(sy)}`);
      this._start = [sx, sy];
    }
    const fs = ccw ? 0 : 1;
    if (full) {
      const mx = cx - R * Math.cos(a0);
      const my = cy - R * Math.sin(a0);
      this._path.push(`A${r2(R)} ${r2(R)} 0 1 ${fs} ${r2(mx)} ${r2(my)}A${r2(R)} ${r2(R)} 0 1 ${fs} ${r2(sx)} ${r2(sy)}`);
      this._cur = [sx, sy];
    } else {
      const ex = cx + R * Math.cos(a0 + sweep);
      const ey = cy + R * Math.sin(a0 + sweep);
      const large = Math.abs(sweep) > Math.PI ? 1 : 0;
      this._path.push(`A${r2(R)} ${r2(R)} 0 ${large} ${fs} ${r2(ex)} ${r2(ey)}`);
      this._cur = [ex, ey];
    }
    this._grow(cx, cy, R);
  }
  rect(x, y, w, h) {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  fillRect(x, y, w, h) {
    const saved = { p: this._path, b: this._bbox, c: this._cur, s: this._start };
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
    this._path = saved.p;
    this._bbox = saved.b;
    this._cur = saved.c;
    this._start = saved.s;
  }

  // ── Paint ──
  createLinearGradient(x0, y0, x1, y1) {
    return new Gradient('linear', [x0, y0, x1, y1]);
  }
  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    return new Gradient('radial', [x0, y0, r0, x1, y1, r1]);
  }

  /**
   * Register a gradient def; identical defs share one id. Defs in
   * objectBoundingBox units (relative to the painted shape) repeat across
   * shapes of the same colour, so a frame needs a handful, not one per shape.
   */
  _def(def) {
    const key = JSON.stringify(def);
    let id = this._defKeys.get(key);
    if (!id) {
      id = `g${this._id++}`;
      this._defKeys.set(key, id);
      this.defs.push({ ...def, id });
    }
    return `url(#${id})`;
  }

  /** A paint → an SVG paint string (gradients become defs, bbox-relative when the shape allows). */
  _paint(p) {
    if (!(p instanceof Gradient)) return String(p);
    const bb = this._bbox;
    const bw = bb ? bb.x1 - bb.x0 : 0;
    const bh = bb ? bb.y1 - bb.y0 : 0;
    const rel = bw > 0.5 && bh > 0.5;
    const nx = (x) => (x - bb.x0) / bw;
    const ny = (y) => (y - bb.y0) / bh;
    const q = (v, step) => Math.round(v / step) * step;
    const stops = (list) => list.map((st) => ({ offset: r2(st.offset), color: st.color }));
    if (p.kind === 'linear') {
      const [x0, y0, x1, y1] = p.coords;
      const a = this._pt(x0, y0);
      const b = this._pt(x1, y1);
      if (rel) {
        // Edge gradients run end to end of the curve: snap to the box's quarter grid.
        return this._def({ type: 'linear', units: 'bbox', x1: q(nx(a[0]), 0.25), y1: q(ny(a[1]), 0.25), x2: q(nx(b[0]), 0.25), y2: q(ny(b[1]), 0.25), stops: stops(p.stops) });
      }
      return this._def({ type: 'linear', x1: r2(a[0]), y1: r2(a[1]), x2: r2(b[0]), y2: r2(b[1]), stops: stops(p.stops) });
    }
    const [x0, y0, r0, x1, y1, r1] = p.coords;
    const f = this._pt(x0, y0);
    const c = this._pt(x1, y1);
    const R = Math.max(0.01, r1 * this._s);
    // Canvas two-circle gradients start at r0: shift the stops onto 0..r1.
    const k0 = Math.max(0, Math.min(1, r0 / r1));
    const st = p.stops.map((x) => ({ offset: k0 + x.offset * (1 - k0), color: x.color }));
    if (k0 > 0 && st.length) st.unshift({ offset: 0, color: st[0].color });
    if (rel) {
      const s2 = (v) => r2(q(v, 0.01));
      // Focal points sit off-centre (the orb's bright crown): a coarser grid keeps
      // float noise from splitting one colour into two defs.
      const f3 = (v) => r2(q(v, 0.03));
      return this._def({ type: 'radial', units: 'bbox', cx: s2(nx(c[0])), cy: s2(ny(c[1])), rx: s2(R / bw), ry: s2(R / bh), fx: f3(nx(f[0])), fy: f3(ny(f[1])), stops: stops(st) });
    }
    return this._def({ type: 'radial', cx: r2(c[0]), cy: r2(c[1]), r: r2(R), fx: r2(f[0]), fy: r2(f[1]), stops: stops(st) });
  }

  fill() {
    if (!this._path.length) return;
    const d = this._path.join('');
    if (this.shadowBlur > 0 && !invisible(this.shadowColor) && this._bbox) this._glow();
    this.items.push({ t: 'path', d, fill: this._paint(this.fillStyle), o: r2(this.globalAlpha) });
  }

  /** Canvas shadowBlur glow → a soft halo (radial gradient) under the shape. */
  _glow() {
    const bb = this._bbox;
    const cx = (bb.x0 + bb.x1) / 2;
    const cy = (bb.y0 + bb.y1) / 2;
    const r = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) / 2;
    const R = r + this.shadowBlur; // shadowBlur ignores the transform (canvas spec)
    const inner = R > 0 ? Math.round((r / R) * 20) / 20 : 0;
    const fill = this._def({
      type: 'radial',
      units: 'bbox',
      cx: 0.5,
      cy: 0.5,
      rx: 0.5,
      ry: 0.5,
      fx: 0.5,
      fy: 0.5,
      stops: [
        { offset: 0, color: this.shadowColor },
        { offset: r2(inner * 0.9), color: this.shadowColor },
        { offset: r2(Math.min(1, inner + (1 - inner) * 0.35)), color: scaleAlpha(this.shadowColor, 0.35) },
        { offset: 1, color: scaleAlpha(this.shadowColor, 0) },
      ],
    });
    this.items.push({ t: 'circle', cx: r2(cx), cy: r2(cy), r: r2(R), fill, o: r2(this.globalAlpha) });
  }

  stroke() {
    if (!this._path.length) return;
    const s = this._s;
    const item = {
      t: 'path',
      d: this._path.join(''),
      stroke: this._paint(this.strokeStyle),
      sw: r2(this.lineWidth * s),
      o: r2(this.globalAlpha),
    };
    if (this.lineCap !== 'butt') item.cap = this.lineCap;
    if (this.lineJoin !== 'miter') item.join = this.lineJoin;
    if (this.lineDash.length) {
      item.dash = this.lineDash.map((v) => r2(v * s));
      if (this.lineDashOffset) item.dashOff = r2(this.lineDashOffset * s);
    }
    this.items.push(item);
  }

  // ── Text ──
  measureText(text) {
    return { width: this._measure(text, this.font) };
  }
  _text(text, x, y, mode) {
    const [px, py] = this._pt(x, y);
    const { weight, size } = parseFont(this.font);
    const fs = size * this._s;
    // Baselines: "middle" centres the x-height block; SVG text sits on the alphabetic baseline.
    const dy = this.textBaseline === 'middle' ? fs * 0.36 : this.textBaseline === 'top' ? fs * 0.8 : 0;
    const anchor = this.textAlign === 'center' ? 'middle' : this.textAlign === 'right' || this.textAlign === 'end' ? 'end' : 'start';
    const item = { t: 'text', x: r2(px), y: r2(py + dy), text: String(text), fs: r2(fs), w: weight, anchor, o: r2(this.globalAlpha) };
    if (mode === 'fill') item.fill = this._paint(this.fillStyle);
    else {
      item.fill = 'none';
      item.stroke = this._paint(this.strokeStyle);
      item.sw = r2(this.lineWidth * this._s);
      item.join = this.lineJoin;
    }
    this.items.push(item);
  }
  fillText(text, x, y) {
    this._text(text, x, y, 'fill');
  }
  strokeText(text, x, y) {
    this._text(text, x, y, 'stroke');
  }

  /** The recorded frame. */
  list() {
    return { items: this.items, defs: this.defs };
  }
}
