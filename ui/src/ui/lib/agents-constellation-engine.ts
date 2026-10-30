/**
 * Agents constellation — canvas 2D renderer for the Agents page.
 *
 * - Deterministic layout: agents are packed into clusters (plugin pack /
 *   team / rail group), most active agents at each cluster's centre, so the
 *   map doesn't reshuffle on every poll. Position changes ease in.
 * - Nodes are sized by activity and glow by live state; edges show observed
 *   delegation (solid, brighter when recent) and configured delegation rights
 *   (dashed). Messages/spawns travel along edges as pulses.
 * - Zoom (wheel / pinch / keys), pan (drag / arrows), click to focus,
 *   hover cards, a minimap, and a reduced-motion path (no ambient motion,
 *   camera snaps, redraw only when something changes).
 * - Colours come from the theme tokens (--g-*), resolved through a probe
 *   element so light/dark and appearance-accent changes are picked up.
 *
 * Glows are pre-rendered sprites (no shadowBlur), which keeps 50–200 nodes
 * comfortably at 60fps.
 */

import { isPerformanceMode } from "./perf-mode";
import { fillConstellationTip, placeConstellationTip } from "./constellation-tip";

export type CxState = "working" | "blocked" | "error" | "idle" | "disabled";

export interface CxNode {
  id: string;
  name: string;
  monogram: string;
  cluster: string;
  clusterLabel: string;
  state: CxState;
  /** 0..1 activity → radius. */
  size: number;
  virtual?: boolean;
  /** Portrait for the 3D billboard (monogram when empty). */
  avatarUrl?: string;
  /** Sub-agent runs in flight → satellites orbiting the node (3D). */
  running?: number;
  hover: {
    role: string;
    model: string;
    backend: string;
    task: string;
    verdict: string;
    verdictTone: "ok" | "warn" | "bad" | "live" | "muted";
    runsToday: string;
    successRate: string;
    lastActive: string;
  };
}

export interface CxEdge {
  from: string;
  to: string;
  kind: "delegation" | "can-delegate";
  weight: number;
  recent: boolean;
}

export interface CxOptions {
  onSelect?: (id: string) => void;
  onHover?: (id: string | null) => void;
  /** 3D engine only: the GPU context was lost / unavailable; the host swaps renderers. */
  onFallback?: (reason: string) => void;
}

/** What the Agents page drives — implemented by the 2D canvas engine and the 3D (three.js) engine. */
export interface ConstellationEngine {
  readonly host: HTMLElement;
  setOptions(opts: CxOptions): void;
  setData(nodes: CxNode[], edges: CxEdge[]): void;
  setSelected(id: string | null): void;
  setDimmed(keep: Set<string> | null): void;
  focus(id: string): void;
  fit(animate?: boolean): void;
  resetView(): void;
  zoomBy(f: number): void;
  pulse(from: string | null, to: string, kind?: "message" | "spawn" | "complete"): void;
  stats(): Record<string, unknown>;
  invalidate(): void;
  destroy(): void;
}

/** True when a WebGL context can be created (the 3D engine needs one). */
export function supportsWebGL(): boolean {
  try {
    if (typeof document === "undefined") return false;
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    const ext = gl.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return true;
  } catch {
    return false;
  }
}

type RGB = [number, number, number];

interface NodeRt extends CxNode {
  x: number;
  y: number;
  tx: number;
  ty: number;
  r: number;
  tr: number;
  phase: number;
  appear: number;
  ping: number;
}

interface ClusterRt {
  key: string;
  label: string;
  x: number;
  y: number;
  r: number;
  count: number;
}

interface Pulse {
  from: string;
  to: string;
  t: number;
  speed: number;
  color: RGB;
}

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const NODE_SPACING = 58;
const MIN_K = 0.25;
const MAX_K = 3.2;

function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

function rgba(c: RGB, a: number) {
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

export class AgentsConstellation implements ConstellationEngine {
  readonly host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Cached static scene (clusters, edges, nodes, labels); re-rendered only on change. */
  private layer: HTMLCanvasElement;
  private lctx: CanvasRenderingContext2D;
  private staticDirty = true;
  private mini: HTMLCanvasElement;
  private mctx: CanvasRenderingContext2D;
  private tip: HTMLDivElement;
  private probe: HTMLSpanElement;
  private opts: CxOptions;

  private w = 0;
  private h = 0;
  private dpr = 1;
  /** Visual px per CSS px (the app shell may apply CSS `zoom`). */
  private z = 1;
  private nodes = new Map<string, NodeRt>();
  private order: NodeRt[] = [];
  private edges: CxEdge[] = [];
  private clusters: ClusterRt[] = [];
  private pulses: Pulse[] = [];
  private bounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

  private cam = { x: 0, y: 0, k: 1 };
  private camT = { x: 0, y: 0, k: 1 };
  private userMoved = false;

  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private dimSet: Set<string> | null = null;

  private colors = {
    primary: [251, 191, 36] as RGB,
    accent: [245, 158, 11] as RGB,
    ok: [34, 197, 94] as RGB,
    warn: [245, 158, 11] as RGB,
    bad: [239, 68, 68] as RGB,
    info: [56, 189, 248] as RGB,
    neutral: [148, 163, 184] as RGB,
    fg: [245, 245, 244] as RGB,
    bg: [10, 10, 14] as RGB,
    light: false,
  };
  private sprites = new Map<string, HTMLCanvasElement>();
  private font = "Inter, system-ui, sans-serif";

  private raf = 0;
  private lastTs = 0;
  private elapsed = 0;
  private ambientAcc = 0;
  private dirty = true;
  private visible = true;
  private destroyed = false;
  private reduced = false;
  private frameMs: number[] = [];
  /** Raw token signature; palettes can change without an observable attribute mutation. */
  private tokenSig = "";
  private tokenCheckAt = 0;
  private drawMs: number[] = [];

  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; camX: number; camY: number } | null = null;
  private moved = false;
  private pinchStart: { d: number; k: number } | null = null;

  private ro: ResizeObserver;
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver;
  private mql: MediaQueryList | null = null;
  private cleanup: Array<() => void> = [];

  constructor(host: HTMLElement, opts: CxOptions = {}) {
    this.host = host;
    this.opts = opts;
    host.classList.add("agp-cx");
    host.tabIndex = 0;
    host.setAttribute("role", "application");
    host.setAttribute(
      "aria-label",
      "Agent constellation. Drag to pan, scroll or +/- to zoom, 0 to fit. Use the card grid for a list view.",
    );

    this.canvas = document.createElement("canvas");
    this.canvas.className = "agp-cx-canvas";
    this.ctx = this.canvas.getContext("2d", { alpha: true })!;
    this.layer = document.createElement("canvas");
    this.lctx = this.layer.getContext("2d", { alpha: true })!;
    this.mini = document.createElement("canvas");
    this.mini.className = "agp-cx-mini";
    this.mini.setAttribute("aria-hidden", "true");
    this.mctx = this.mini.getContext("2d")!;
    this.tip = document.createElement("div");
    this.tip.className = "agp-cx-tip";
    this.tip.setAttribute("role", "tooltip");
    this.probe = document.createElement("span");
    this.probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    host.append(this.canvas, this.mini, this.tip, this.probe);

    this.readColors();
    this.bind();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries.some((e) => e.isIntersecting);
        if (this.visible) this.kick();
      });
      this.io.observe(host);
    }
    this.mo = new MutationObserver(() => {
      this.readColors();
      this.invalidate();
    });
    this.mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    try {
      this.mql = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onMq = () => {
        this.reduced = !!this.mql?.matches || isPerformanceMode();
        this.invalidate();
      };
      onMq();
      this.mql.addEventListener("change", onMq);
      this.cleanup.push(() => this.mql?.removeEventListener("change", onMq));
    } catch {
      this.reduced = isPerformanceMode();
    }
    const onVis = () => {
      if (!document.hidden) this.kick();
    };
    document.addEventListener("visibilitychange", onVis);
    this.cleanup.push(() => document.removeEventListener("visibilitychange", onVis));

    // Diagnostics for headless verification (fps, node hit targets).
    (host as unknown as { __cxStats?: () => unknown }).__cxStats = () => this.stats();
    (host as unknown as { __cxNodes?: () => unknown }).__cxNodes = () => this.screenNodes();
    this.resize();
  }

  // ─── Public API ────────────────────────────────────────────────────────

  setOptions(opts: CxOptions) {
    this.opts = opts;
  }

  setData(nodes: CxNode[], edges: CxEdge[]) {
    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.id);
      const prev = this.nodes.get(n.id);
      if (prev) {
        Object.assign(prev, n);
      } else {
        this.nodes.set(n.id, {
          ...n,
          x: 0,
          y: 0,
          tx: 0,
          ty: 0,
          r: 0,
          tr: 0,
          phase: hash01(n.id) * TAU,
          appear: this.order.length === 0 ? 1 : 0,
          ping: 0,
        });
      }
    }
    for (const id of [...this.nodes.keys()]) if (!seen.has(id)) this.nodes.delete(id);
    this.edges = edges.filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to));
    this.layout();
    if (!this.userMoved) this.fit(false);
    this.invalidate();
  }

  setSelected(id: string | null) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.invalidate();
  }

  /** Nodes outside the set render dimmed (rail filters / search). null = none dimmed. */
  setDimmed(keep: Set<string> | null) {
    this.dimSet = keep;
    this.invalidate();
  }

  focus(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.userMoved = true;
    this.camT = { x: n.tx, y: n.ty, k: clamp(Math.max(this.camT.k, 1.35), MIN_K, MAX_K) };
    if (this.reduced) this.cam = { ...this.camT };
    this.invalidate();
  }

  fit(animate = true) {
    const b = this.bounds;
    const bw = b.maxX - b.minX + 120;
    const bh = b.maxY - b.minY + 140;
    const k = clamp(Math.min(this.w / bw, this.h / bh), MIN_K, 1.6);
    this.camT = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, k: Number.isFinite(k) && k > 0 ? k : 1 };
    if (!animate || this.reduced) this.cam = { ...this.camT };
    this.invalidate();
  }

  resetView() {
    this.userMoved = false;
    this.fit(true);
  }

  zoomBy(f: number, sx = this.w / 2, sy = this.h / 2) {
    this.userMoved = true;
    const k = clamp(this.camT.k * f, MIN_K, MAX_K);
    const wx = (sx - this.w / 2) / this.camT.k + this.camT.x;
    const wy = (sy - this.h / 2) / this.camT.k + this.camT.y;
    this.camT = { k, x: wx - (sx - this.w / 2) / k, y: wy - (sy - this.h / 2) / k };
    if (this.reduced) this.cam = { ...this.camT };
    this.invalidate();
  }

  /** Something happened on `to` (from `from` when known): travelling pulse + ping. */
  pulse(from: string | null, to: string, kind: "message" | "spawn" | "complete" = "message") {
    const target = this.nodes.get(to);
    if (!target) return;
    target.ping = 1;
    const color = kind === "spawn" ? this.colors.primary : kind === "complete" ? this.colors.ok : this.colors.info;
    if (from && from !== to && this.nodes.has(from) && !this.reduced) {
      this.pulses.push({ from, to, t: 0, speed: 0.9, color });
    }
    this.dirty = true;
    this.kick();
  }

  stats() {
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const interval = avg(this.frameMs);
    return {
      nodes: this.nodes.size,
      edges: this.edges.length,
      clusters: this.clusters.length,
      fps: interval > 0 ? Math.round(1000 / interval) : 0,
      avgFrameMs: +interval.toFixed(2),
      avgDrawMs: +avg(this.drawMs).toFixed(2),
      reducedMotion: this.reduced,
      camera: { ...this.cam },
    };
  }

  /** Current on-screen position/radius per node (for diagnostics / tests). */
  screenNodes() {
    return [...this.nodes.values()].map((n) => {
      const [x, y] = this.toScreen(n.x, n.y);
      // Visual px (what pointer events see), relative to the host's top-left.
      return { id: n.id, x: Math.round(x * this.z), y: Math.round(y * this.z), r: Math.round(n.r * this.cam.k * this.z), state: n.state, cluster: n.cluster };
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.io?.disconnect();
    this.mo.disconnect();
    for (const fn of this.cleanup) fn();
    this.canvas.remove();
    this.mini.remove();
    this.tip.remove();
    this.probe.remove();
  }

  // ─── Layout ────────────────────────────────────────────────────────────

  private layout() {
    const byCluster = new Map<string, NodeRt[]>();
    for (const n of this.nodes.values()) {
      const arr = byCluster.get(n.cluster) ?? [];
      arr.push(n);
      byCluster.set(n.cluster, arr);
    }
    const groups = [...byCluster.entries()]
      .map(([key, list]) => ({
        key,
        label: list[0].clusterLabel,
        list: list.sort((a, b) => b.size - a.size || a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => b.list.length - a.list.length || a.key.localeCompare(b.key));

    const placed: ClusterRt[] = [];
    for (const g of groups) {
      const n = g.list.length;
      const r = Math.max(64, NODE_SPACING * Math.sqrt(n) + 44);
      let x = 0;
      let y = 0;
      if (placed.length > 0) {
        // Spiral search for the first non-overlapping spot (deterministic).
        let found = false;
        for (let step = 0; step < 4000 && !found; step++) {
          const a = step * 0.35;
          const d = 18 + step * 3.2;
          x = Math.cos(a) * d * 1.25;
          y = Math.sin(a) * d * 0.8;
          found = placed.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + r + 56);
        }
      }
      placed.push({ key: g.key, label: g.label, x, y, r, count: n });
      g.list.forEach((node, i) => {
        const rad = n === 1 ? 0 : NODE_SPACING * 0.92 * Math.sqrt(i + 0.35);
        const ang = i * GOLDEN + hash01(g.key) * TAU;
        node.tx = x + Math.cos(ang) * rad;
        node.ty = y + Math.sin(ang) * rad;
        node.tr = 14 + node.size * 17;
        if (node.appear === 1 && node.x === 0 && node.y === 0 && node.r === 0) {
          node.x = node.tx;
          node.y = node.ty;
          node.r = node.tr;
        } else if (node.r === 0) {
          node.x = x;
          node.y = y;
        }
      });
    }
    this.clusters = placed;
    this.order = [...this.nodes.values()].sort((a, b) => a.size - b.size);
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const c of placed) {
      b.minX = Math.min(b.minX, c.x - c.r);
      b.maxX = Math.max(b.maxX, c.x + c.r);
      b.minY = Math.min(b.minY, c.y - c.r - 26);
      b.maxY = Math.max(b.maxY, c.y + c.r);
    }
    this.bounds = Number.isFinite(b.minX) ? b : { minX: -200, minY: -200, maxX: 200, maxY: 200 };
  }

  // ─── Colours ───────────────────────────────────────────────────────────

  private resolve(token: string, fallback: RGB): RGB {
    this.probe.style.color = "";
    this.probe.style.color = `var(${token})`;
    const c = getComputedStyle(this.probe).color;
    const m = c.match(/[\d.]+/g);
    if (!m || m.length < 3 || !this.probe.style.color) return fallback;
    return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])];
  }

  private readColors() {
    const c = this.colors;
    c.primary = this.resolve("--g-primary", c.primary);
    c.accent = this.resolve("--g-accent", c.accent);
    c.ok = this.resolve("--g-success", c.ok);
    c.warn = this.resolve("--g-warning", c.warn);
    c.bad = this.resolve("--g-danger", c.bad);
    c.info = this.resolve("--g-info", c.info);
    c.neutral = this.resolve("--g-neutral", c.neutral);
    c.fg = this.resolve("--g-fg", c.fg);
    c.bg = this.resolve("--g-bg", c.bg);
    c.light = c.bg[0] + c.bg[1] + c.bg[2] > 380;
    this.font = getComputedStyle(this.host).fontFamily || this.font;
    this.sprites.clear();
  }

  private stateColor(s: CxState): RGB {
    switch (s) {
      case "working":
        return this.colors.ok;
      case "blocked":
        return this.colors.warn;
      case "error":
        return this.colors.bad;
      case "disabled":
        return this.colors.neutral;
      default:
        return this.colors.primary;
    }
  }

  private sprite(c: RGB): HTMLCanvasElement {
    const key = c.join(",");
    let s = this.sprites.get(key);
    if (s) return s;
    s = document.createElement("canvas");
    s.width = s.height = 128;
    const g = s.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    const a = this.colors.light ? 0.55 : 0.9;
    grad.addColorStop(0, rgba(c, a));
    grad.addColorStop(0.25, rgba(c, a * 0.45));
    grad.addColorStop(0.6, rgba(c, a * 0.1));
    grad.addColorStop(1, rgba(c, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.sprites.set(key, s);
    return s;
  }

  // ─── Loop ──────────────────────────────────────────────────────────────

  private resize() {
    const rect = this.host.getBoundingClientRect();
    // Work in CSS px; rect is in visual px when an ancestor sets `zoom`.
    this.w = Math.max(1, this.host.clientWidth || rect.width);
    this.h = Math.max(1, this.host.clientHeight || rect.height);
    this.z = rect.width > 0 && this.host.clientWidth > 0 ? rect.width / this.host.clientWidth : 1;
    this.dpr = Math.min(3, (window.devicePixelRatio || 1) * this.z);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
    const mw = this.w < 520 ? 120 : 176;
    const mh = Math.round(mw * 0.62);
    this.mini.width = Math.round(mw * this.dpr);
    this.mini.height = Math.round(mh * this.dpr);
    this.mini.style.width = `${mw}px`;
    this.mini.style.height = `${mh}px`;
    if (!this.userMoved) this.fit(false);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    this.staticDirty = true;
    this.kick();
  }

  private kick() {
    if (this.destroyed || this.raf) return;
    this.lastTs = 0;
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(ts: number) {
    this.raf = 0;
    if (this.destroyed) return;
    const dt = this.lastTs ? Math.min(0.1, (ts - this.lastTs) / 1000) : 0.016;
    if (this.lastTs) {
      this.frameMs.push(ts - this.lastTs);
      if (this.frameMs.length > 120) this.frameMs.shift();
    }
    this.lastTs = ts;
    this.elapsed += dt;

    if (ts - this.tokenCheckAt > 1000) {
      this.tokenCheckAt = ts;
      const cs = getComputedStyle(this.host);
      const sig = ["--g-bg", "--g-fg", "--g-primary", "--g-success"].map((t) => cs.getPropertyValue(t)).join("|");
      if (sig !== this.tokenSig) {
        this.tokenSig = sig;
        this.readColors();
        this.staticDirty = true;
        this.dirty = true;
      }
    }
    const animating = this.step(dt);
    if (!this.visible || document.hidden) return; // resumes via observers
    if (this.dirty || animating || !this.reduced) {
      const t0 = performance.now();
      if (this.staticDirty) {
        const main = this.ctx;
        this.ctx = this.lctx;
        this.draw();
        this.ctx = main;
        this.drawMini();
        this.staticDirty = false;
      }
      this.composite();
      this.drawMs.push(performance.now() - t0);
      if (this.drawMs.length > 120) this.drawMs.shift();
      this.dirty = false;
    }
    if (animating || !this.reduced) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** Advance easing/pulses; returns true while something is still moving. */
  private step(dt: number): boolean {
    let moving = false;
    const ease = this.reduced ? 1 : 1 - Math.pow(0.001, dt * 1.6);
    for (const n of this.nodes.values()) {
      const dx = n.tx - n.x;
      const dy = n.ty - n.y;
      const dr = n.tr - n.r;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dr) > 0.05) {
        n.x += dx * ease;
        n.y += dy * ease;
        n.r += dr * ease;
        moving = true;
        this.staticDirty = true;
      }
      if (n.appear < 1) {
        n.appear = this.reduced ? 1 : Math.min(1, n.appear + dt * 1.8);
        moving = true;
        this.staticDirty = true;
      }
      if (n.ping > 0) {
        n.ping = Math.max(0, n.ping - dt * (this.reduced ? 1.6 : 0.9));
        moving = true;
      }
    }
    const ck = this.camT.k - this.cam.k;
    const cx = this.camT.x - this.cam.x;
    const cy = this.camT.y - this.cam.y;
    if (Math.abs(ck) > 0.0005 || Math.abs(cx) + Math.abs(cy) > 0.05) {
      const e = this.reduced ? 1 : 1 - Math.pow(0.0005, dt * 1.4);
      this.cam.k += ck * e;
      this.cam.x += cx * e;
      this.cam.y += cy * e;
      moving = true;
      this.staticDirty = true;
    }
    if (this.pulses.length) {
      for (const p of this.pulses) p.t += dt * p.speed;
      this.pulses = this.pulses.filter((p) => p.t < 1);
      moving = true;
    }
    if (!this.reduced) {
      this.ambientAcc += dt;
      if (this.ambientAcc > 1.6) {
        this.ambientAcc = 0;
        const recent = this.edges.filter((e) => e.kind === "delegation" && e.recent);
        if (recent.length && this.pulses.length < 40) {
          const e = recent[Math.floor((this.elapsed * 7) % recent.length)];
          this.pulses.push({ from: e.from, to: e.to, t: 0, speed: 0.55, color: this.colors.primary });
        }
      }
    }
    return moving;
  }

  // ─── Drawing ───────────────────────────────────────────────────────────

  private toScreen(x: number, y: number): [number, number] {
    return [(x - this.cam.x) * this.cam.k + this.w / 2, (y - this.cam.y) * this.cam.k + this.h / 2];
  }

  private nodePos(n: NodeRt): [number, number] {
    return [n.x, n.y];
  }

  private isDim(id: string) {
    return !!this.dimSet && !this.dimSet.has(id);
  }

  private focusSet(): Set<string> | null {
    const f = this.hoverId ?? this.selectedId;
    if (!f) return null;
    const s = new Set<string>([f]);
    for (const e of this.edges) {
      if (e.from === f) s.add(e.to);
      if (e.to === f) s.add(e.from);
    }
    return s;
  }

  private draw() {
    const { ctx, colors } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const k = this.cam.k;
    const focus = this.focusSet();

    // Clusters (labels placed greedily, biggest cluster first, so they never collide)
    const clusterLabels: Array<{ c: ClusterRt; sx: number; y: number; text: string; fs: number }> = [];
    for (const c of this.clusters) {
      const [sx, sy] = this.toScreen(c.x, c.y);
      const sr = c.r * k;
      if (sx + sr < -40 || sx - sr > this.w + 40 || sy + sr < -60 || sy - sr > this.h + 40) continue;
      const g = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr);
      g.addColorStop(0, rgba(colors.primary, colors.light ? 0.05 : 0.055));
      g.addColorStop(1, rgba(colors.primary, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, TAU);
      ctx.fill();
      ctx.setLineDash([2, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(colors.primary, colors.light ? 0.28 : 0.2);
      ctx.stroke();
      ctx.setLineDash([]);
      const fs = clamp(13 * Math.sqrt(k), 11, 15);
      clusterLabels.push({ c, sx, y: sy - sr - 6, text: `${c.label.toUpperCase()}  ·  ${c.count}`, fs });
    }
    {
      const taken: Array<[number, number, number, number]> = [];
      clusterLabels.sort((a, b) => b.c.count - a.c.count);
      ctx.textBaseline = "bottom";
      for (const l of clusterLabels) {
        ctx.font = `600 ${l.fs}px ${this.font}`;
        const tw = ctx.measureText(l.text).width + l.text.length * 1.6;
        const box: [number, number, number, number] = [l.sx - tw / 2 - 4, l.y - l.fs - 2, l.sx + tw / 2 + 4, l.y + 2];
        if (taken.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
        taken.push(box);
        ctx.fillStyle = rgba(colors.fg, 0.62);
        this.spacedText(l.text, l.sx, l.y, 1.6);
      }
    }

    // Edges
    for (const e of this.edges) {
      const a = this.nodes.get(e.from)!;
      const b = this.nodes.get(e.to)!;
      const [ax, ay] = this.toScreen(...this.nodePos(a));
      const [bx, by] = this.toScreen(...this.nodePos(b));
      const hot = !!focus && focus.has(e.from) && focus.has(e.to) && (e.from === (this.hoverId ?? this.selectedId) || e.to === (this.hoverId ?? this.selectedId));
      const dim = (!!focus && !hot) || this.isDim(e.from) || this.isDim(e.to);
      const [qx, qy] = this.ctrl(ax, ay, bx, by);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(qx, qy, bx, by);
      // Quiet by default (older traffic recedes, recent traffic glows);
      // hover/selection lights up the focused agent's full neighbourhood.
      if (e.kind === "can-delegate") {
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(colors.fg, hot ? 0.5 : dim ? 0.03 : 0.08);
      } else {
        ctx.setLineDash([]);
        ctx.lineWidth = Math.min(3.2, 0.8 + Math.log2(1 + e.weight) * 0.45) * (hot ? 1.5 : 1);
        const base = e.recent ? 0.34 : 0.07;
        ctx.strokeStyle = rgba(colors.primary, hot ? 0.9 : dim ? 0.04 : base);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (e.kind === "delegation" && !dim && (hot || e.recent)) this.arrow(qx, qy, bx, by, b.r * k, hot);
    }

    // Nodes
    const showLabels = k >= 0.5;
    const labels: Array<{ n: NodeRt; sx: number; sy: number; r: number; pri: number; isSel: boolean; isHover: boolean; alpha: number }> = [];
    for (const n of this.order) {
      const [wx, wy] = this.nodePos(n);
      const [sx, sy] = this.toScreen(wx, wy);
      const r = Math.max(7, n.r * k) * (0.4 + 0.6 * n.appear);
      if (sx + r * 3 < 0 || sx - r * 3 > this.w || sy + r * 3 < 0 || sy - r * 3 > this.h) continue;
      const dim = this.isDim(n.id) || (!!focus && !focus.has(n.id));
      const col = this.stateColor(n.state);
      const isSel = n.id === this.selectedId;
      const isHover = n.id === this.hoverId;
      ctx.globalAlpha = (dim ? 0.2 : 1) * n.appear;

      // Glow
      let glow = n.state === "idle" ? 1.7 : n.state === "disabled" ? 1.2 : 2.5;
      if (isSel || isHover) glow *= 1.2;
      const gs = r * glow;
      ctx.drawImage(this.sprite(col), sx - gs, sy - gs, gs * 2, gs * 2);

      // Body
      const body = ctx.createRadialGradient(sx - r * 0.35, sy - r * 0.4, r * 0.1, sx, sy, r);
      if (colors.light) {
        body.addColorStop(0, "rgba(255,255,255,1)");
        body.addColorStop(1, rgba(colors.bg, 1));
      } else {
        body.addColorStop(0, rgba(mix(colors.bg, col, 0.28), 1));
        body.addColorStop(1, rgba(colors.bg, 1));
      }
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, TAU);
      ctx.fillStyle = body;
      ctx.fill();
      ctx.lineWidth = isSel ? 2.4 : 1.5;
      if (n.virtual) ctx.setLineDash([3, 3]);
      ctx.strokeStyle = rgba(col, n.state === "idle" ? 0.75 : 1);
      ctx.stroke();
      ctx.setLineDash([]);

      // Monogram
      if (r >= 8) {
        ctx.fillStyle = rgba(colors.fg, 0.92);
        ctx.font = `700 ${Math.round(r * 0.72)}px ${this.font}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.monogram, sx, sy + 0.5);
      }

      if ((showLabels && !dim) || isSel || isHover) {
        const pri = isSel || isHover ? 3 : n.state === "working" ? 2 : n.state === "idle" ? n.size : 1.5;
        labels.push({ n, sx, sy, r, pri, isSel, isHover, alpha: ctx.globalAlpha });
      }
      ctx.globalAlpha = 1;
    }

    // Name labels, greedily placed by priority so they never overlap each
    // other or a node body; skipped labels still show on hover.
    ctx.font = `600 12.5px ${this.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const placed: Array<[number, number, number, number]> = [];
    const bodies = this.order.map((n) => {
      const [sx, sy] = this.toScreen(...this.nodePos(n));
      const r = Math.max(4, n.r * k);
      return [sx - r, sy - r, sx + r, sy + r] as [number, number, number, number];
    });
    const hits = (b: [number, number, number, number], list: Array<[number, number, number, number]>) =>
      list.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
    labels.sort((a, b) => b.pri - a.pri);
    for (const l of labels) {
      const text = l.n.name.length > 18 ? `${l.n.name.slice(0, 17)}…` : l.n.name;
      const tw = ctx.measureText(text).width;
      const box: [number, number, number, number] = [l.sx - tw / 2 - 5, l.sy + l.r + 5, l.sx + tw / 2 + 5, l.sy + l.r + 23];
      const own = bodies.filter((b) => !(Math.abs((b[0] + b[2]) / 2 - l.sx) < 0.5 && Math.abs((b[1] + b[3]) / 2 - l.sy) < 0.5));
      if (!(l.isSel || l.isHover) && (hits(box, placed) || hits(box, own))) continue;
      placed.push(box);
      ctx.globalAlpha = l.alpha;
      ctx.fillStyle = rgba(colors.bg, colors.light ? 0.82 : 0.66);
      roundRect(ctx, box[0], box[1], tw + 10, 18, 5);
      ctx.fill();
      ctx.fillStyle = rgba(l.isSel ? colors.primary : colors.fg, l.isSel || l.isHover ? 1 : 0.84);
      ctx.fillText(text, l.sx, l.sy + l.r + 7);
    }
    ctx.globalAlpha = 1;
  }

  /** Per-frame: blit the cached scene, then draw the animated overlay. */
  private composite() {
    const { ctx, colors } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const k = this.cam.k;
    const focus = this.focusSet();

    // Sonar rings on working agents (ambient; off in reduced motion).
    if (!this.reduced) {
      for (const n of this.order) {
        if (n.state !== "working" || this.isDim(n.id) || (focus && !focus.has(n.id))) continue;
        const [sx, sy] = this.toScreen(n.x, n.y);
        const r = Math.max(7, n.r * k);
        const t = (this.elapsed * 0.55 + n.phase / TAU) % 1;
        ctx.beginPath();
        ctx.arc(sx, sy, r * (1.05 + t * 1.3), 0, TAU);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(colors.ok, (1 - t) * 0.55);
        ctx.stroke();
      }
    }

    // Ping rings (message / spawn / completion events).
    for (const n of this.order) {
      if (n.ping <= 0) continue;
      const [sx, sy] = this.toScreen(n.x, n.y);
      const r = Math.max(7, n.r * k);
      ctx.beginPath();
      ctx.arc(sx, sy, r * (1.2 + (1 - n.ping) * 1.8), 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgba(this.stateColor(n.state), n.ping * 0.8);
      ctx.stroke();
    }

    // Travelling pulses along edges.
    for (const p of this.pulses) {
      const a = this.nodes.get(p.from);
      const b = this.nodes.get(p.to);
      if (!a || !b) continue;
      const [ax, ay] = this.toScreen(a.x, a.y);
      const [bx, by] = this.toScreen(b.x, b.y);
      const [qx, qy] = this.ctrl(ax, ay, bx, by);
      const t = p.t;
      const x = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * qx + t * t * bx;
      const y = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * qy + t * t * by;
      const s = 18;
      ctx.globalAlpha = Math.sin(Math.PI * t);
      ctx.drawImage(this.sprite(p.color), x - s, y - s, s * 2, s * 2);
      ctx.globalAlpha = 1;
    }

    // Selection ring (rotates unless reduced motion).
    const sel = this.selectedId ? this.nodes.get(this.selectedId) : undefined;
    if (sel) {
      const [sx, sy] = this.toScreen(sel.x, sel.y);
      const r = Math.max(7, sel.r * k);
      ctx.beginPath();
      ctx.setLineDash([4, 5]);
      ctx.lineDashOffset = this.reduced ? 0 : -this.elapsed * 8;
      ctx.arc(sx, sy, r + 6, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(colors.primary, 0.9);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
  }

  private spacedText(text: string, x: number, y: number, spacing: number) {
    const { ctx } = this;
    const widths = [...text].map((ch) => ctx.measureText(ch).width + spacing);
    const total = widths.reduce((a, b) => a + b, 0) - spacing;
    let cx = x - total / 2;
    ctx.textAlign = "left";
    [...text].forEach((ch, i) => {
      ctx.fillText(ch, cx, y);
      cx += widths[i];
    });
    ctx.textAlign = "center";
  }

  private ctrl(ax: number, ay: number, bx: number, by: number): [number, number] {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const dx = bx - ax;
    const dy = by - ay;
    return [mx - dy * 0.16, my + dx * 0.16];
  }

  private arrow(qx: number, qy: number, bx: number, by: number, rTarget: number, hot: boolean) {
    const { ctx } = this;
    const ang = Math.atan2(by - qy, bx - qx);
    const tipX = bx - Math.cos(ang) * (rTarget + 3);
    const tipY = by - Math.sin(ang) * (rTarget + 3);
    const s = hot ? 7 : 5;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - Math.cos(ang - 0.45) * s, tipY - Math.sin(ang - 0.45) * s);
    ctx.lineTo(tipX - Math.cos(ang + 0.45) * s, tipY - Math.sin(ang + 0.45) * s);
    ctx.closePath();
    ctx.fillStyle = rgba(this.colors.primary, hot ? 0.95 : 0.55);
    ctx.fill();
  }

  private miniTransform() {
    const mw = this.mini.width / this.dpr;
    const mh = this.mini.height / this.dpr;
    const b = this.bounds;
    const pad = 12;
    const s = Math.min((mw - pad * 2) / (b.maxX - b.minX || 1), (mh - pad * 2) / (b.maxY - b.minY || 1));
    const ox = pad + (mw - pad * 2 - (b.maxX - b.minX) * s) / 2 - b.minX * s;
    const oy = pad + (mh - pad * 2 - (b.maxY - b.minY) * s) / 2 - b.minY * s;
    return { s, ox, oy, mw, mh };
  }

  private drawMini() {
    const { mctx: ctx, colors } = this;
    const { s, ox, oy, mw, mh } = this.miniTransform();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, mw, mh);
    for (const c of this.clusters) {
      ctx.beginPath();
      ctx.arc(ox + c.x * s, oy + c.y * s, c.r * s, 0, TAU);
      ctx.strokeStyle = rgba(colors.primary, 0.25);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (const n of this.nodes.values()) {
      ctx.beginPath();
      ctx.arc(ox + n.x * s, oy + n.y * s, Math.max(1.5, n.r * s * 0.9), 0, TAU);
      ctx.fillStyle = rgba(this.stateColor(n.state), this.isDim(n.id) ? 0.25 : 0.95);
      ctx.fill();
    }
    const vw = this.w / this.cam.k;
    const vh = this.h / this.cam.k;
    ctx.strokeStyle = rgba(colors.primary, 0.95);
    ctx.lineWidth = 1.25;
    ctx.strokeRect(ox + (this.cam.x - vw / 2) * s, oy + (this.cam.y - vh / 2) * s, vw * s, vh * s);
  }

  // ─── Interaction ───────────────────────────────────────────────────────

  private local(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.z, y: (e.clientY - r.top) / this.z };
  }

  private hit(sx: number, sy: number): NodeRt | null {
    const wx = (sx - this.w / 2) / this.cam.k + this.cam.x;
    const wy = (sy - this.h / 2) / this.cam.k + this.cam.y;
    let best: NodeRt | null = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - wx, n.y - wy);
      const reach = n.r + 6 / this.cam.k;
      if (d <= reach && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private setHover(n: NodeRt | null, sx = 0, sy = 0) {
    const id = n?.id ?? null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.opts.onHover?.(id);
      this.canvas.style.cursor = id ? "pointer" : "grab";
      this.invalidate();
    }
    if (!n) {
      this.tip.classList.remove("is-on");
      return;
    }
    this.fillTip(n);
    placeConstellationTip(this.tip, sx, sy, this.w, this.h);
    this.tip.classList.add("is-on");
  }

  private tipFor = "";
  private fillTip(n: NodeRt) {
    const sig = JSON.stringify([n.id, n.state, n.hover]);
    if (sig === this.tipFor) return;
    this.tipFor = sig;
    fillConstellationTip(this.tip, n);
  }

  private bind() {
    const c = this.canvas;
    c.style.cursor = "grab";
    c.style.touchAction = "none";

    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), k: this.camT.k };
        this.dragStart = null;
      } else {
        this.dragStart = { x: p.x, y: p.y, camX: this.camT.x, camY: this.camT.y };
        this.moved = false;
      }
    };
    const move = (e: PointerEvent) => {
      const p = this.local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      if (this.pinchStart && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const k = clamp(this.pinchStart.k * (d / (this.pinchStart.d || 1)), MIN_K, MAX_K);
        this.zoomBy(k / this.camT.k, (a.x + b.x) / 2, (a.y + b.y) / 2);
        this.moved = true;
        return;
      }
      if (this.dragStart) {
        const dx = p.x - this.dragStart.x;
        const dy = p.y - this.dragStart.y;
        if (!this.moved && Math.hypot(dx, dy) > 4) {
          this.moved = true;
          c.style.cursor = "grabbing";
          this.setHover(null);
        }
        if (this.moved) {
          this.userMoved = true;
          this.camT.x = this.dragStart.camX - dx / this.camT.k;
          this.camT.y = this.dragStart.camY - dy / this.camT.k;
          this.cam.x = this.camT.x;
          this.cam.y = this.camT.y;
          this.invalidate();
        }
        return;
      }
      this.setHover(this.hit(p.x, p.y), p.x, p.y);
    };
    const up = (e: PointerEvent) => {
      const p = this.local(e);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchStart = null;
      if (this.dragStart && !this.moved) {
        const n = this.hit(p.x, p.y);
        if (n) {
          this.selectedId = n.id;
          this.setHover(null);
          this.opts.onSelect?.(n.id);
          this.focus(n.id);
        }
      }
      this.dragStart = null;
      this.moved = false;
      c.style.cursor = this.hoverId ? "pointer" : "grab";
    };
    const leave = () => {
      if (!this.dragStart) this.setHover(null);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = this.local(e);
      this.zoomBy(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
    };
    const dbl = (e: MouseEvent) => {
      const p = this.local(e);
      if (!this.hit(p.x, p.y)) this.resetView();
    };
    const key = (e: KeyboardEvent) => {
      const step = 60 / this.camT.k;
      let handled = true;
      if (e.key === "+" || e.key === "=") this.zoomBy(1.2);
      else if (e.key === "-" || e.key === "_") this.zoomBy(1 / 1.2);
      else if (e.key === "0") this.resetView();
      else if (e.key === "ArrowLeft") this.camT.x -= step;
      else if (e.key === "ArrowRight") this.camT.x += step;
      else if (e.key === "ArrowUp") this.camT.y -= step;
      else if (e.key === "ArrowDown") this.camT.y += step;
      else handled = false;
      if (handled) {
        this.userMoved = true;
        if (this.reduced) this.cam = { ...this.camT };
        e.preventDefault();
        this.invalidate();
      }
    };
    const miniNav = (e: PointerEvent) => {
      if (e.type === "pointermove" && !(e.buttons & 1)) return;
      e.stopPropagation();
      const r = this.mini.getBoundingClientRect();
      const { s, ox, oy } = this.miniTransform();
      this.userMoved = true;
      this.camT.x = ((e.clientX - r.left) / this.z - ox) / s;
      this.camT.y = ((e.clientY - r.top) / this.z - oy) / s;
      if (this.reduced || e.type === "pointermove") this.cam = { ...this.camT };
      this.invalidate();
    };

    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    this.host.addEventListener("keydown", key);
    this.mini.addEventListener("pointerdown", miniNav);
    this.mini.addEventListener("pointermove", miniNav);
    this.cleanup.push(() => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
      this.host.removeEventListener("keydown", key);
      this.mini.removeEventListener("pointerdown", miniNav);
      this.mini.removeEventListener("pointermove", miniNav);
    });
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
