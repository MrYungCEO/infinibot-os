/**
 * ConstellationOrgChart — full-page hierarchical constellation renderer.
 *
 * The agents page centerpiece: a deep-space noir org chart where the main
 * orchestrator (INFINI) is the brightest center star, directors orbit on the
 * first ring connected by gold constellation hairlines, and specialists
 * cluster in arcs around their director. Live sessions make a star glow and
 * send light pulses travelling along its chain.
 *
 * Pure canvas 2D — no chart libs (house style). Deterministic radial layout
 * (no force sim) so labels never collide and the hierarchy always reads.
 *
 * Interaction: wheel zoom (to cursor), drag pan (6px slop preserves clicks),
 * hover tooltip, click select, keyboard (Tab focus → arrows cycle stars,
 * Enter selects, Esc clears, 0 resets view). RAF throttles when the tab is
 * hidden; prefers-reduced-motion drops twinkle/pulse travel.
 */

import { isPerformanceMode, PERF } from "./perf-mode";

export type OrgStatus = "active" | "default" | "idle" | "disabled";

export interface OrgChartNode {
  id: string;
  name: string;
  /** Short role title, e.g. "Engineering Lead". */
  role: string;
  model: string;
  status: OrgStatus;
  sessions: number;
  /** 0 = center star, 1 = director ring, 2 = specialist cluster. */
  tier: 0 | 1 | 2;
  /** Org parent (null for the center star). */
  parentId: string | null;
  /** True for agents that communicate directly with the operator/clients —
   *  rendered with a comms ring + badge so they're identifiable at a glance. */
  userFacing?: boolean;
  /** URL of the agent's portrait photo (defaults to /agent-avatars/<id>.webp). */
  avatarUrl?: string;
}

interface LayoutNode extends OrgChartNode {
  x: number;
  y: number;
  r: number;
  angle: number;
  appear: number;
  glow: number;
  pulse: number;
  delay: number;
  /** Department accent (null → pure gold, i.e. center star / unmapped). */
  dept: RGB | null;
}

interface Edge {
  from: LayoutNode;
  to: LayoutNode;
  draw: number;
  delay: number;
  phase: number;
}

interface BgStar {
  x: number;
  y: number;
  size: number;
  a: number;
  tw: number;
  depth: number;
}

export interface OrgChartOptions {
  onSelect?: (id: string | null) => void;
  onHover?: (node: OrgChartNode | null) => void;
}

/** A live org-wide workflow beam rendered as an animated arc between two nodes. */
export interface WorkflowArc {
  fromId: string;
  toId: string;
  /** Short label shown at the beam midpoint. */
  label: string;
  /** 0–1 progress; drives the glowing particle position. */
  progress: number;
  /** Color key: "gold" | "cyan" | "red" | "purple" — defaults to "gold". */
  color?: "gold" | "cyan" | "red" | "purple";
}

const WORKFLOW_COLORS: Record<string, RGB> = {
  gold:   [212, 160, 23],
  cyan:   [64,  220, 255],
  red:    [239, 68,  68],
  purple: [167, 139, 250],
};

const RING_1 = 300;
const RING_2 = 560;
const RING_2_STAGGER = 112;
/** Minimum angular gap between same-radius ring-2 siblings (world px at RING_2). */
const MIN_ARC_PX = 128;

type RGB = [number, number, number];

const GOLD_FALLBACK: RGB = [212, 160, 23];
const ACTIVE_TINT: RGB = [64, 235, 170];
const DISABLED_TINT: RGB = [150, 130, 120];

/**
 * Department accent palette — muted jewel tones that read as "one universe"
 * against the noir/gold theme. Directors claim a slot in layout order
 * (deterministic: same roster → same colors); their specialists inherit it.
 * The center star stays pure gold.
 */
const DEPT_PALETTE: RGB[] = [
  [96, 195, 255], // ice cyan
  [244, 114, 182], // rose
  [167, 139, 250], // violet
  [52, 211, 153], // emerald
  [245, 158, 11], // amber
  [125, 211, 252], // sky (overflow)
];

/** CSS color for director-sector `i` — same assignment rule as the engine,
 *  exported so views can render a matching department legend. */
export function deptAccentCss(i: number): string {
  const c = DEPT_PALETTE[i % DEPT_PALETTE.length];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function rgba([r, g, b]: RGB, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Deterministic pseudo-random from a seed — layout must be stable across renders. */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export class ConstellationOrgChart {
  readonly container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tooltip: HTMLDivElement;
  private live: HTMLDivElement;
  private dpr = 1;
  private width = 0;
  private height = 0;

  private nodes: LayoutNode[] = [];
  private edges: Edge[] = [];
  private bgStars: BgStar[] = [];

  private scale = 1;
  private tx = 0;
  private ty = 0;
  private targetScale = 1;
  private targetTx = 0;
  private targetTy = 0;
  private fitted = false;

  private raf = 0;
  private lastTs = 0;
  private hiddenAccum = 0;
  private destroyed = false;
  private elapsed = 0;
  private bornAt = 0;

  private hoverId: string | null = null;
  private selectedId: string | null = null;
  private focusId: string | null = null;
  private pointerX = -1e6;
  private pointerY = -1e6;
  private dragging = false;
  private dragMoved = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragTx = 0;
  private dragTy = 0;

  private gold: RGB = GOLD_FALLBACK;
  private reducedMotion = false;

  // Shooting star — a rare, quiet streak across the far background.
  private meteor: { born: number; x: number; y: number; vx: number; vy: number } | null = null;
  private nextMeteorAt = 9000;
  private perfMode = false;
  private ro?: ResizeObserver;
  private onVisibility = () => {};

  private avatarCache = new Map<string, HTMLImageElement>();
  private avatarTried = new Set<string>();

  private opts: OrgChartOptions;
  private activeWorkflows: WorkflowArc[] = [];

  constructor(container: HTMLElement, opts: OrgChartOptions = {}) {
    this.container = container;
    this.opts = opts;
    this.perfMode = isPerformanceMode();
    try {
      this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      this.reducedMotion = false;
    }

    container.style.position = container.style.position || "relative";
    container.tabIndex = 0;
    container.setAttribute("role", "application");
    container.setAttribute(
      "aria-label",
      "Agent constellation org chart. Use arrow keys to cycle agents, Enter to open, Escape to close."
    );
    container.style.outline = "none";

    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { alpha: true })!;

    this.tooltip = document.createElement("div");
    this.tooltip.className = "org-chart-tip";
    container.appendChild(this.tooltip);

    this.live = document.createElement("div");
    this.live.setAttribute("aria-live", "polite");
    this.live.style.cssText =
      "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;";
    container.appendChild(this.live);

    this.injectStyles();
    this.readGold();
    this.seedBackdrop();
    this.attachEvents();
    this.resize();
    this.bornAt = performance.now();
    this.lastTs = this.bornAt;
    this.raf = requestAnimationFrame(this.frame);
  }

  private getAvatar(url: string): HTMLImageElement | null {
    if (this.avatarCache.has(url)) return this.avatarCache.get(url)!;
    if (this.avatarTried.has(url)) return null;
    this.avatarTried.add(url);
    const img = new Image();
    img.onload = () => { this.avatarCache.set(url, img); };
    img.onerror = () => {};
    img.src = url;
    return null;
  }

  private readGold() {
    try {
      const v = getComputedStyle(this.container).getPropertyValue("--g-primary").trim();
      const m = v.match(/^#([0-9a-f]{6})$/i);
      if (m) {
        const n = parseInt(m[1], 16);
        this.gold = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        return;
      }
      const rgb = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (rgb) this.gold = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    } catch {
      this.gold = GOLD_FALLBACK;
    }
  }

  private injectStyles() {
    if (document.getElementById("org-chart-styles")) return;
    const s = document.createElement("style");
    s.id = "org-chart-styles";
    s.textContent = `
      .org-chart-tip{
        position:absolute;top:0;left:0;pointer-events:none;z-index:6;
        min-width:250px;max-width:330px;padding:0;border-radius:16px;overflow:hidden;
        font-family:'JetBrains Mono','SF Mono',monospace;
        background:linear-gradient(165deg,rgba(22,18,10,.88),rgba(8,7,4,.94));
        border:none;
        box-shadow:
          0 26px 70px rgba(0,0,0,.7),
          0 0 0 1px var(--tip-bd,rgba(212,160,23,.35)),
          0 0 40px var(--tip-glow,rgba(212,160,23,.26)),
          inset 0 1px 0 rgba(255,255,255,.07);
        backdrop-filter:blur(22px) saturate(175%);
        -webkit-backdrop-filter:blur(22px) saturate(175%);
        opacity:0;transform:translateY(8px) scale(.95);
        transition:opacity .16s ease,transform .22s cubic-bezier(.2,.9,.3,1.18);
        transform-origin:0 0;will-change:transform,opacity;
      }
      .org-chart-tip.show{opacity:1;transform:translateY(0) scale(1);}
      .org-chart-tip .t-accent{position:absolute;top:0;bottom:0;left:0;width:3px;
        background:linear-gradient(180deg,var(--tip-c,#d4a017),transparent 85%);
        box-shadow:0 0 12px var(--tip-c,#d4a017);}
      .org-chart-tip .t-head{display:flex;align-items:center;gap:11px;padding:14px 16px 11px 18px;
        background:linear-gradient(180deg,color-mix(in srgb,var(--tip-c,#d4a017) 10%,transparent),transparent);}
      .org-chart-tip .t-glyph{width:34px;height:34px;flex:none;border-radius:10px;
        display:flex;align-items:center;justify-content:center;font-size:16px;
        color:var(--tip-c,#d4a017);
        background:color-mix(in srgb,var(--tip-c,#d4a017) 12%,rgba(0,0,0,.5));
        box-shadow:0 0 16px -2px var(--tip-c,#d4a017),inset 0 0 8px color-mix(in srgb,var(--tip-c,#d4a017) 25%,transparent);
        text-shadow:0 0 8px var(--tip-c,#d4a017);}
      .org-chart-tip .t-id{min-width:0;flex:1;}
      .org-chart-tip .t-name{font-size:14px;font-weight:800;color:#f7f3e8;letter-spacing:.7px;text-transform:uppercase;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .org-chart-tip .t-role{font-size:8.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--tip-c,#d4a017);opacity:.92;margin-top:2px;}
      .org-chart-tip .t-tier{flex:none;font-size:7.5px;font-weight:700;letter-spacing:1.3px;text-transform:uppercase;
        padding:4px 8px;border-radius:999px;color:var(--tip-c,#d4a017);
        background:color-mix(in srgb,var(--tip-c,#d4a017) 10%,transparent);
        box-shadow:0 0 0 1px color-mix(in srgb,var(--tip-c,#d4a017) 35%,transparent);}
      .org-chart-tip .t-comms{margin:0 16px 8px 18px;padding:5px 9px;border-radius:8px;
        font-size:8px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;
        color:#0a0a0c;
        background:linear-gradient(120deg,var(--tip-c,#d4a017),color-mix(in srgb,var(--tip-c,#d4a017) 60%,#fff));
        box-shadow:0 0 16px -4px var(--tip-c,#d4a017);}
      .org-chart-tip .t-div{height:1px;margin:0 16px 0 18px;
        background:linear-gradient(90deg,var(--tip-bd,rgba(212,160,23,.4)),transparent);}
      .org-chart-tip .t-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px 14px;padding:12px 16px 12px 18px;}
      .org-chart-tip .t-cell{min-width:0;}
      .org-chart-tip .t-k{display:block;font-size:7.5px;letter-spacing:1.4px;text-transform:uppercase;color:rgba(235,228,210,.4);margin-bottom:3px;}
      .org-chart-tip .t-v{display:flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;color:#ece4d0;
        text-transform:uppercase;letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .org-chart-tip .t-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--tip-s,#d4a017);}
      .org-chart-tip .t-dot.live{animation:org-tip-ring 1.6s ease-out infinite;}
      @keyframes org-tip-ring{
        0%{box-shadow:0 0 6px var(--tip-s,#d4a017),0 0 0 0 color-mix(in srgb,var(--tip-s,#d4a017) 55%,transparent);}
        100%{box-shadow:0 0 6px var(--tip-s,#d4a017),0 0 0 8px transparent;}
      }
      .org-chart-tip .t-cta{display:flex;align-items:center;gap:7px;margin:0 16px 13px 18px;padding-top:10px;
        border-top:1px solid rgba(255,255,255,.05);
        font-size:8px;letter-spacing:1.8px;text-transform:uppercase;color:var(--tip-c,#d4a017);}
      .org-chart-tip .t-cta .t-arr{display:inline-block;animation:org-tip-arr 1.4s ease-in-out infinite;}
      @keyframes org-tip-arr{0%,100%{transform:translateX(0);opacity:.7;}50%{transform:translateX(4px);opacity:1;}}
      @media (prefers-reduced-motion: reduce){
        .org-chart-tip .t-dot.live,.org-chart-tip .t-cta .t-arr{animation:none;}
      }
    `;
    document.head.appendChild(s);
  }

  private seedBackdrop() {
    const rnd = seeded(0x51a7);
    const stars: BgStar[] = [];
    for (let i = 0; i < 220; i++) {
      stars.push({
        x: (rnd() - 0.5) * 2600,
        y: (rnd() - 0.5) * 1900,
        size: 0.4 + rnd() * 1.4,
        a: 0.08 + rnd() * 0.4,
        tw: rnd() * Math.PI * 2,
        depth: 0.25 + rnd() * 0.45,
      });
    }
    this.bgStars = stars;
  }

  // ── Layout ────────────────────────────────────────────────────────────

  sync(next: OrgChartNode[]) {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const center = next.find((n) => n.tier === 0) ?? next[0];
    if (!center) {
      this.nodes = [];
      this.edges = [];
      return;
    }
    const directors = next.filter((n) => n.tier === 1);
    const byParent = new Map<string, OrgChartNode[]>();
    for (const n of next) {
      if (n.tier === 2 && n.parentId) {
        const arr = byParent.get(n.parentId) ?? [];
        arr.push(n);
        byParent.set(n.parentId, arr);
      }
    }

    const out: LayoutNode[] = [];
    const place = (
      src: OrgChartNode,
      x: number,
      y: number,
      angle: number,
      r: number,
      delay: number,
      dept: RGB | null = null
    ) => {
      const old = prev.get(src.id);
      out.push({
        ...src,
        x,
        y,
        angle,
        r,
        appear: old ? old.appear : 0,
        glow: old ? old.glow : 0,
        pulse: old ? old.pulse : Math.random() * Math.PI * 2,
        delay,
        dept,
      });
    };

    place(center, 0, 0, 0, 34, 0, null);

    const dCount = Math.max(1, directors.length);
    const sector = (Math.PI * 2) / dCount;
    directors.forEach((d, i) => {
      const dept = DEPT_PALETTE[i % DEPT_PALETTE.length];
      const angle = -Math.PI / 2 + i * sector;
      place(d, Math.cos(angle) * RING_1, Math.sin(angle) * RING_1, angle, 20, 360 + i * 110, dept);
      const kids = byParent.get(d.id) ?? [];
      const usable = sector * 0.86;
      const minStep = MIN_ARC_PX / RING_2;
      const step = kids.length > 1 ? usable / (kids.length - 1) : 0;
      const stagger = step > 0 && step < minStep;
      kids.forEach((k, j) => {
        const a = kids.length > 1 ? angle - usable / 2 + j * step : angle;
        const rad = RING_2 + (stagger && j % 2 === 1 ? RING_2_STAGGER : 0);
        place(k, Math.cos(a) * rad, Math.sin(a) * rad, a, 13, 760 + i * 110 + j * 70, dept);
      });
    });

    // Agents parented straight to the center that aren't directors (custom /
    // unmapped agents) — inner support orbit between the rings.
    const orphans = next.filter(
      (n) => n.tier === 2 && (!n.parentId || n.parentId === center.id)
    );
    if (orphans.length) {
      const oStep = (Math.PI * 2) / orphans.length;
      orphans.forEach((o, i) => {
        const a = -Math.PI / 2 + sector / 2 + i * oStep;
        place(o, Math.cos(a) * RING_1 * 0.62, Math.sin(a) * RING_1 * 0.62, a, 11, 640 + i * 90);
      });
    }

    this.nodes = out;

    const byId = new Map(out.map((n) => [n.id, n]));
    const prevEdges = new Map(
      this.edges.map((e) => [`${e.from.id}→${e.to.id}`, e])
    );
    const edges: Edge[] = [];
    for (const n of out) {
      if (!n.parentId) continue;
      const p = byId.get(n.parentId) ?? byId.get(center.id);
      if (!p || p === n) continue;
      const key = `${p.id}→${n.id}`;
      const old = prevEdges.get(key);
      edges.push({
        from: p,
        to: n,
        draw: old ? old.draw : 0,
        delay: n.delay - 140,
        phase: Math.abs(hashCode(key)) % 1000 / 1000,
      });
    }
    this.edges = edges;

    if (this.hoverId && !byId.has(this.hoverId)) this.setHover(null);
    if (this.selectedId && !byId.has(this.selectedId)) this.selectedId = null;
    if (this.focusId && !byId.has(this.focusId)) this.focusId = null;

    if (!this.fitted && this.width > 4) this.fitToView();
  }

  setSelected(id: string | null) {
    this.selectedId = id;
  }

  /** Replace the set of live workflow beams drawn between nodes. */
  setActiveWorkflows(arcs: WorkflowArc[]) {
    this.activeWorkflows = arcs;
  }

  /** Smoothly pan/zoom so the node sits comfortably in view (left of any side panel). */
  focusNode(id: string, opts: { biasX?: number } = {}) {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) return;
    const s = Math.max(this.scale, 0.9);
    this.targetScale = s;
    this.targetTx = this.width * (opts.biasX ?? 0.5) - n.x * s;
    this.targetTy = this.height * 0.5 - n.y * s;
  }

  resetView() {
    this.fitToView();
  }

  private fitToView() {
    if (!this.nodes.length || this.width < 4) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    // Extra bottom headroom: name+role labels hang below stars, and the
    // legend/hint chips float over the lower corners of the stage.
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - 110);
      maxX = Math.max(maxX, n.x + 110);
      minY = Math.min(minY, n.y - 80);
      maxY = Math.max(maxY, n.y + 150);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const s = Math.min(this.width / w, this.height / h, 1.35);
    this.targetScale = s;
    this.targetTx = this.width / 2 - ((minX + maxX) / 2) * s;
    this.targetTy = this.height / 2 - ((minY + maxY) / 2) * s;
    // First fit snaps instantly so the entrance animation plays in place.
    if (!this.fitted) {
      this.scale = this.targetScale;
      this.tx = this.targetTx;
      this.ty = this.targetTy;
      this.fitted = true;
    }
  }

  // ── Events ────────────────────────────────────────────────────────────

  private attachEvents() {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.container.addEventListener("keydown", this.onKeyDown);
    this.container.addEventListener("blur", this.onBlur);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);

    this.onVisibility = () => {
      if (!document.hidden) this.lastTs = performance.now();
    };
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const prevW = this.width;
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.perfMode ? 1.25 : 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    if (!this.fitted || prevW < 4) this.fitToView();
  }

  private toWorld(px: number, py: number): [number, number] {
    return [(px - this.tx) / this.scale, (py - this.ty) / this.scale];
  }

  private pick(px: number, py: number): LayoutNode | null {
    const [wx, wy] = this.toWorld(px, py);
    let best: LayoutNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const dx = n.x - wx;
      const dy = n.y - wy;
      const d = dx * dx + dy * dy;
      const hitR = n.r + 22 / this.scale;
      if (d <= hitR * hitR && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private onPointerDown = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.dragging = true;
    this.dragMoved = false;
    this.dragStartX = e.clientX - rect.left;
    this.dragStartY = e.clientY - rect.top;
    this.dragTx = this.tx;
    this.dragTy = this.ty;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerX = e.clientX - rect.left;
    this.pointerY = e.clientY - rect.top;

    if (this.dragging) {
      const dx = this.pointerX - this.dragStartX;
      const dy = this.pointerY - this.dragStartY;
      if (!this.dragMoved && Math.hypot(dx, dy) > 6) {
        this.dragMoved = true;
        this.canvas.style.cursor = "grabbing";
        this.setHover(null);
      }
      if (this.dragMoved) {
        this.tx = this.targetTx = this.dragTx + dx;
        this.ty = this.targetTy = this.dragTy + dy;
      }
      return;
    }

    const hit = this.pick(this.pointerX, this.pointerY);
    this.setHover(hit ? hit.id : null, hit);
  };

  private onPointerUp = (e: PointerEvent) => {
    const wasDrag = this.dragMoved;
    this.dragging = false;
    this.dragMoved = false;
    this.canvas.style.cursor = this.hoverId ? "pointer" : "grab";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (wasDrag) return;
    const hit = this.pick(this.pointerX, this.pointerY);
    this.selectedId = hit ? hit.id : null;
    this.opts.onSelect?.(this.selectedId);
  };

  private onPointerLeave = () => {
    this.pointerX = -1e6;
    this.pointerY = -1e6;
    if (!this.dragging) this.setHover(null);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0016);
    const next = Math.min(2.8, Math.max(0.32, this.scale * factor));
    const k = next / this.scale;
    this.tx = this.targetTx = px - (px - this.tx) * k;
    this.ty = this.targetTy = py - (py - this.ty) * k;
    this.scale = this.targetScale = next;
  };

  private keyOrder(): LayoutNode[] {
    return [...this.nodes].sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier : a.angle - b.angle
    );
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const order = this.keyOrder();
    if (!order.length) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const i = order.findIndex((n) => n.id === this.focusId);
      const next = order[(i + 1) % order.length];
      this.setFocusNode(next);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = order.findIndex((n) => n.id === this.focusId);
      const next = order[(i - 1 + order.length) % order.length];
      this.setFocusNode(next);
    } else if (e.key === "Home") {
      e.preventDefault();
      this.setFocusNode(order[0]);
    } else if ((e.key === "Enter" || e.key === " ") && this.focusId) {
      e.preventDefault();
      this.selectedId = this.focusId;
      this.opts.onSelect?.(this.selectedId);
    } else if (e.key === "Escape") {
      this.setFocusNode(null);
      this.selectedId = null;
      this.opts.onSelect?.(null);
    } else if (e.key === "0") {
      this.resetView();
    }
  };

  private onBlur = () => {
    this.setFocusNode(null);
  };

  private setFocusNode(n: LayoutNode | null) {
    this.focusId = n ? n.id : null;
    if (n) {
      this.focusNode(n.id);
      this.live.textContent = `${n.name}, ${n.role}, ${n.status}${
        n.sessions ? `, ${n.sessions} active session${n.sessions === 1 ? "" : "s"}` : ""
      }`;
      this.showTooltip(n);
    } else {
      this.live.textContent = "";
      this.tooltip.classList.remove("show");
    }
  }

  private setHover(id: string | null, node?: LayoutNode | null) {
    if (id === this.hoverId) {
      if (id && node) this.showTooltip(node);
      return;
    }
    this.hoverId = id;
    this.canvas.style.cursor = id ? "pointer" : this.dragMoved ? "grabbing" : "grab";
    const n = id ? (node ?? this.nodes.find((x) => x.id === id) ?? null) : null;
    this.opts.onHover?.(n);
    if (n) this.showTooltip(n);
    else this.tooltip.classList.remove("show");
  }

  private showTooltip(n: LayoutNode) {
    // Card identity follows the department accent; the status is expressed by
    // the live dot + status value color, not the whole card.
    const ident: RGB = n.dept ? mix(this.gold, n.dept, 0.55) : this.gold;
    const statusTint: RGB =
      n.status === "active" ? ACTIVE_TINT : n.status === "disabled" ? DISABLED_TINT : this.gold;
    this.tooltip.style.setProperty("--tip-c", rgba(ident, 0.95));
    this.tooltip.style.setProperty("--tip-bd", rgba(ident, 0.4));
    this.tooltip.style.setProperty("--tip-glow", rgba(ident, 0.26));
    this.tooltip.style.setProperty("--tip-s", rgba(statusTint, 0.95));

    const tierLabel = n.tier === 0 ? "Orchestrator" : n.tier === 1 ? "Director" : "Specialist";
    const parent = n.parentId ? this.nodes.find((x) => x.id === n.parentId) : null;
    const division =
      n.tier === 0
        ? "Command"
        : n.tier === 1
          ? n.name
          : parent
            ? parent.name
            : "Unassigned";
    const glyph = n.tier === 0 ? "✦" : n.tier === 1 ? "✧" : "·✦·";
    this.tooltip.innerHTML = `
      <div class="t-accent"></div>
      <div class="t-head">
        <div class="t-glyph">${glyph}</div>
        <div class="t-id">
          <div class="t-name">${escapeHtml(n.name)}</div>
          <div class="t-role">${escapeHtml(n.role || "—")}</div>
        </div>
        <div class="t-tier">${tierLabel}</div>
      </div>
      ${
        n.userFacing
          ? `<div class="t-comms">@ USER-FACING · Talks to you & clients</div>`
          : ""
      }
      <div class="t-div"></div>
      <div class="t-grid">
        <div class="t-cell"><span class="t-k">Status</span>
          <span class="t-v" style="color:${rgba(statusTint, 0.95)}">
            <span class="t-dot ${n.status === "active" ? "live" : ""}"></span>${n.status}
          </span></div>
        <div class="t-cell"><span class="t-k">Sessions</span>
          <span class="t-v">${n.sessions > 0 ? `${n.sessions} live` : "—"}</span></div>
        <div class="t-cell"><span class="t-k">Model</span>
          <span class="t-v" title="${escapeHtml(n.model || "")}">${escapeHtml(n.model || "—")}</span></div>
        <div class="t-cell"><span class="t-k">Division</span>
          <span class="t-v">${escapeHtml(division)}</span></div>
        ${
          parent && n.tier === 2
            ? `<div class="t-cell" style="grid-column:1/-1"><span class="t-k">Reports to</span>
                 <span class="t-v">${escapeHtml(parent.name)}</span></div>`
            : ""
        }
      </div>
      <div class="t-cta"><span class="t-arr">▸</span> CLICK TO OPEN COMMS</div>
    `;
    const sx = n.x * this.scale + this.tx;
    const sy = n.y * this.scale + this.ty;
    const tipW = this.tooltip.offsetWidth || 210;
    const tipH = this.tooltip.offsetHeight || 120;
    let px = sx + (n.r + 18) * this.scale;
    let py = sy - 14;
    if (px + tipW > this.width - 10) px = sx - (n.r + 18) * this.scale - tipW;
    py = Math.max(10, Math.min(py, this.height - tipH - 10));
    this.tooltip.style.transform = `translate(${px}px, ${py}px)`;
    this.tooltip.classList.add("show");
  }

  // ── Frame loop ────────────────────────────────────────────────────────

  private frame = (ts: number) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    let dt = ts - this.lastTs;
    this.lastTs = ts;
    if (dt > 80) dt = 80;

    if (document.hidden) {
      this.hiddenAccum += dt;
      const interval = 1000 / PERF.hiddenFps();
      if (this.hiddenAccum < interval) return;
      this.hiddenAccum = 0;
    }

    this.elapsed += dt;

    // Ease camera toward target (focusNode / fit animations).
    const ease = Math.min(1, dt * 0.008);
    this.scale += (this.targetScale - this.scale) * ease;
    this.tx += (this.targetTx - this.tx) * ease;
    this.ty += (this.targetTy - this.ty) * ease;

    this.render(dt);
  };

  private render(dt: number) {
    const ctx = this.ctx;
    if (this.width < 4 || this.height < 4) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const gold = this.gold;
    const born = this.elapsed;

    this.drawBackdrop(ctx);

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const hover = this.hoverId ?? this.focusId;
    const hoverNode = hover ? this.nodes.find((n) => n.id === hover) ?? null : null;
    const chain = new Set<string>();
    if (hoverNode) {
      chain.add(hoverNode.id);
      let cur: LayoutNode | undefined = hoverNode;
      while (cur?.parentId) {
        chain.add(cur.parentId);
        cur = this.nodes.find((n) => n.id === cur!.parentId);
      }
      for (const n of this.nodes) if (n.parentId === hoverNode.id) chain.add(n.id);
    }

    // ── Cluster nebulas — one faint department-tinted breath per director
    //    sector, so groups read as distinct regions at a glance. ──
    if (!this.perfMode) {
      for (const d of this.nodes) {
        if (d.tier !== 1 || !d.dept || d.appear < 0.4) continue;
        const kids = this.nodes.filter((k) => k.parentId === d.id);
        let cx2 = d.x;
        let cy2 = d.y;
        let spread = 150;
        if (kids.length) {
          for (const k of kids) {
            cx2 += k.x;
            cy2 += k.y;
          }
          cx2 /= kids.length + 1;
          cy2 /= kids.length + 1;
          for (const k of kids) {
            spread = Math.max(spread, Math.hypot(k.x - cx2, k.y - cy2) + 130);
          }
        }
        const breath = this.reducedMotion
          ? 1
          : 0.82 + 0.18 * Math.sin(this.elapsed * 0.00028 + d.pulse * 2);
        const neb = ctx.createRadialGradient(cx2, cy2, spread * 0.15, cx2, cy2, spread);
        neb.addColorStop(0, rgba(d.dept, 0.052 * breath * d.appear));
        neb.addColorStop(0.6, rgba(d.dept, 0.024 * breath * d.appear));
        neb.addColorStop(1, rgba(d.dept, 0));
        ctx.fillStyle = neb;
        ctx.beginPath();
        ctx.arc(cx2, cy2, spread, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Constellation hairlines ──
    for (const e of this.edges) {
      if (this.reducedMotion) e.draw = 1;
      else if (born > e.delay) e.draw = Math.min(1, e.draw + dt * 0.0022);
      if (e.draw <= 0.01) continue;
      const inChain = chain.has(e.from.id) && chain.has(e.to.id);
      const liveEdge = e.to.status === "active" || e.from.status === "active";
      const tier2 = e.to.tier === 2;
      const baseA = (tier2 ? 0.16 : 0.3) + (inChain ? 0.4 : 0) + (liveEdge ? 0.1 : 0);
      // Edges take the child's department accent, blended back toward gold so
      // the whole constellation still reads as one gold universe.
      const ec: RGB = e.to.dept ? mix(gold, e.to.dept, 0.5) : gold;

      const mx = e.from.x + (e.to.x - e.from.x) * e.draw;
      const my = e.from.y + (e.to.y - e.from.y) * e.draw;
      const grad = ctx.createLinearGradient(e.from.x, e.from.y, mx, my);
      grad.addColorStop(0, rgba(gold, baseA * 0.75));
      grad.addColorStop(1, rgba(ec, baseA * 0.55));
      ctx.strokeStyle = grad;
      ctx.lineWidth = (inChain ? 1.6 : tier2 ? 0.7 : 1) / this.scale + (inChain ? 0.6 : 0);
      // Soft neon bloom on the lines that matter (skipped in perf mode —
      // canvas shadows are the most expensive thing we draw).
      if (!this.perfMode && (inChain || liveEdge || !tier2)) {
        ctx.shadowBlur = inChain ? 10 : liveEdge ? 8 : 5;
        ctx.shadowColor = rgba(ec, inChain ? 0.65 : 0.4);
      }
      ctx.beginPath();
      ctx.moveTo(e.from.x, e.from.y);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Flowing energy: comet streaks travelling along the line. Live edges
      // run two streaks in counter-phase (continuous flow); quiet edges get a
      // rare, dimmer pass (~every 20s per edge) so the map breathes.
      if (e.draw >= 1 && !this.reducedMotion) {
        const streaks: Array<[number, number]> = [];
        if (liveEdge) {
          streaks.push([((this.elapsed / 1600 + e.phase) % 1 + 1) % 1, 1]);
          streaks.push([((this.elapsed / 1600 + e.phase + 0.5) % 1 + 1) % 1, 0.55]);
        } else {
          const cyc = ((this.elapsed / 2400 + e.phase * 8.3) % 8.3 + 8.3) % 8.3;
          if (cyc < 1) streaks.push([cyc, 0.4]);
        }
        for (const [t, amp] of streaks) {
          const dx = e.to.x - e.from.x;
          const dy = e.to.y - e.from.y;
          const t0 = Math.max(0, t - 0.1);
          const hx = e.from.x + dx * t;
          const hy = e.from.y + dy * t;
          const tx2 = e.from.x + dx * t0;
          const ty2 = e.from.y + dy * t0;
          // Comet tail — gradient from transparent tail to bright head.
          const sg = ctx.createLinearGradient(tx2, ty2, hx, hy);
          sg.addColorStop(0, rgba(ec, 0));
          sg.addColorStop(0.75, rgba(ec, 0.45 * amp));
          sg.addColorStop(1, rgba(mix(ec, [255, 255, 255], 0.6), 0.95 * amp));
          ctx.strokeStyle = sg;
          ctx.lineWidth = 1.8 / Math.sqrt(this.scale);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(tx2, ty2);
          ctx.lineTo(hx, hy);
          ctx.stroke();
          ctx.lineCap = "butt";
          // Bright head glow.
          const lr = (liveEdge ? 6.5 : 5) / Math.sqrt(this.scale);
          const lg = ctx.createRadialGradient(hx, hy, 0, hx, hy, lr);
          lg.addColorStop(0, rgba(mix(ec, [255, 255, 255], 0.65), 0.95 * amp));
          lg.addColorStop(0.4, rgba(ec, 0.5 * amp));
          lg.addColorStop(1, rgba(ec, 0));
          ctx.fillStyle = lg;
          ctx.beginPath();
          ctx.arc(hx, hy, lr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // ── Workflow beams — animated arcs for live cross-agent workflows ──
    if (this.activeWorkflows.length > 0 && !this.reducedMotion) {
      const byId = new Map(this.nodes.map((n) => [n.id, n]));
      for (const arc of this.activeWorkflows) {
        const from = byId.get(arc.fromId);
        const to   = byId.get(arc.toId);
        if (!from || !to || from.appear < 0.3 || to.appear < 0.3) continue;

        const wc: RGB = WORKFLOW_COLORS[arc.color ?? "gold"] ?? WORKFLOW_COLORS.gold;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy) || 1;
        // Control point: bulge perpendicular to the edge so beams arc above hairlines.
        const bulge = Math.min(len * 0.32, 180);
        const nx = -dy / len;
        const ny =  dx / len;
        const cx = (from.x + to.x) / 2 + nx * bulge;
        const cy = (from.y + to.y) / 2 + ny * bulge;

        // 1. Wide glowing pulse beam (quadratic bezier).
        const beamA = 0.18 + 0.12 * Math.sin(this.elapsed * 0.0024 + hashCode(arc.fromId + arc.toId) * 0.001);
        const beamGrad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
        beamGrad.addColorStop(0,   rgba(wc, 0));
        beamGrad.addColorStop(0.3, rgba(wc, beamA));
        beamGrad.addColorStop(0.7, rgba(wc, beamA));
        beamGrad.addColorStop(1,   rgba(wc, 0));

        ctx.save();
        ctx.strokeStyle = beamGrad;
        ctx.lineWidth = 6 / Math.sqrt(this.scale);
        ctx.lineCap = "round";
        if (!this.perfMode) {
          ctx.shadowBlur = 18;
          ctx.shadowColor = rgba(wc, 0.55);
        }
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(cx, cy, to.x, to.y);
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 2. Thin bright centerline.
        ctx.strokeStyle = rgba(wc, 0.55);
        ctx.lineWidth = 1.5 / Math.sqrt(this.scale);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.quadraticCurveTo(cx, cy, to.x, to.y);
        ctx.stroke();
        ctx.restore();

        // 3. Glowing particle travelling along the bezier.
        const pt = (arc.progress + ((this.elapsed * 0.00055) % 1) + 1) % 1;
        const px = quadBez(from.x, cx, to.x, pt);
        const py = quadBez(from.y, cy, to.y, pt);
        const pr = 5 / Math.sqrt(this.scale);
        const pg = ctx.createRadialGradient(px, py, 0, px, py, pr * 3);
        pg.addColorStop(0,   rgba(mix(wc, [255, 255, 255], 0.7), 1));
        pg.addColorStop(0.4, rgba(wc, 0.7));
        pg.addColorStop(1,   rgba(wc, 0));
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(px, py, pr * 3, 0, Math.PI * 2);
        ctx.fill();

        // 4. Label at the bezier midpoint (t=0.5).
        if (!this.perfMode && arc.label && this.scale > 0.5) {
          const lx = quadBez(from.x, cx, to.x, 0.5);
          const ly = quadBez(from.y, cy, to.y, 0.5);
          const fs = Math.max(7, 8 / Math.sqrt(this.scale));
          ctx.font = `700 ${fs}px 'JetBrains Mono',monospace`;
          const tw2 = ctx.measureText(arc.label).width;
          const pad = 5;
          // Pill background.
          ctx.fillStyle = "rgba(6,5,2,0.78)";
          ctx.strokeStyle = rgba(wc, 0.7);
          ctx.lineWidth = 0.8 / this.scale;
          roundRect(ctx, lx - tw2 / 2 - pad, ly - fs / 2 - pad * 0.5, tw2 + pad * 2, fs + pad, fs / 2 + 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = rgba(wc, 0.95);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(arc.label, lx, ly + 0.5);
          ctx.textBaseline = "alphabetic";
        }
      }
    }

    // ── Stars ──
    for (const n of this.nodes) {
      if (this.reducedMotion) n.appear = 1;
      else if (born > n.delay) n.appear = Math.min(1, n.appear + dt * 0.0024);
      if (n.appear <= 0.01) continue;
      // Overshoot ease for a lively pop.
      const ap = n.appear >= 1 ? 1 : 1 - Math.pow(1 - n.appear, 3);

      n.pulse += dt * (this.reducedMotion ? 0 : 0.0028);
      const isHover = hover === n.id;
      const isSelected = this.selectedId === n.id;
      const inChain = chain.size > 0 && chain.has(n.id);
      const dimmed = chain.size > 0 && !inChain;
      const targetGlow = isHover ? 1 : isSelected ? 0.8 : inChain ? 0.45 : 0;
      n.glow += (targetGlow - n.glow) * Math.min(1, dt * 0.012);

      // Department accent, blended toward gold — directors carry more of their
      // hue than specialists so the ring reads as the "spine" of each group.
      const deptBase: RGB = n.dept ? mix(gold, n.dept, n.tier === 1 ? 0.5 : 0.42) : gold;
      const tint: RGB =
        n.status === "disabled"
          ? DISABLED_TINT
          : n.status === "active"
            ? mix(deptBase, ACTIVE_TINT, 0.25)
            : deptBase;
      // Subtle per-star twinkle keeps outer clusters alive (phase from pulse).
      const twinkle =
        n.tier === 2 && !this.reducedMotion
          ? 0.92 + 0.08 * Math.sin(this.elapsed * 0.0016 + n.pulse * 3.7)
          : 1;
      const bright =
        (n.status === "active" ? 1 : n.status === "disabled" ? 0.45 : 0.78) *
        (dimmed ? 0.45 : 1) *
        twinkle;
      const pulseAmt =
        n.tier === 0 || n.status === "active" ? 0.1 + Math.sin(n.pulse) * 0.1 : 0.04;
      const r = Math.max(0.5, n.r * ap * (isHover ? 1.28 : 1));

      // Avatar portrait — circular photo behind star glow; faint at rest, focused on hover.
      const avatarUrl = n.avatarUrl ?? `/agent-avatars/${n.id}.webp`;
      const avatarImg = this.getAvatar(avatarUrl);
      if (avatarImg) {
        const avatarR = r * (n.tier === 0 ? 4.2 : 3.4);
        const avatarAlpha = (0.13 + n.glow * 0.52) * ap;
        ctx.save();
        ctx.beginPath();
        ctx.arc(n.x, n.y, avatarR, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalAlpha = avatarAlpha;
        ctx.drawImage(avatarImg, n.x - avatarR, n.y - avatarR, avatarR * 2, avatarR * 2);
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // Halo — inner bright bloom + a wider, department-tinted outer bloom so
      // stars feel like true light sources rather than flat sprites.
      const haloR = r * (n.tier === 0 ? 5.6 : 4.0) * (1 + pulseAmt) + n.glow * 24;
      const halo = ctx.createRadialGradient(n.x, n.y, r * 0.3, n.x, n.y, haloR);
      halo.addColorStop(0, rgba(tint, (0.34 + n.glow * 0.34) * bright * ap));
      halo.addColorStop(0.45, rgba(tint, (0.12 + n.glow * 0.14) * bright * ap));
      halo.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(n.x, n.y, haloR, 0, Math.PI * 2);
      ctx.fill();
      if (!this.perfMode) {
        const outerR = haloR * 1.75;
        const outer = ctx.createRadialGradient(n.x, n.y, haloR * 0.55, n.x, n.y, outerR);
        outer.addColorStop(0, rgba(n.dept ?? tint, 0.07 * bright * ap * (1 + n.glow)));
        outer.addColorStop(1, rgba(n.dept ?? tint, 0));
        ctx.fillStyle = outer;
        ctx.beginPath();
        ctx.arc(n.x, n.y, outerR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Star flare spikes (4-point; 6-point for the center star).
      const spikes = n.tier === 0 ? 6 : 4;
      const spikeLen = r * (n.tier === 0 ? 3.1 : 2.4) * (1 + pulseAmt * 0.5);
      ctx.save();
      ctx.translate(n.x, n.y);
      if (n.tier === 0 && !this.reducedMotion) ctx.rotate(this.elapsed * 0.00004);
      for (let i = 0; i < spikes; i++) {
        const a = (i / spikes) * Math.PI * 2;
        const g2 = ctx.createLinearGradient(0, 0, Math.cos(a) * spikeLen, Math.sin(a) * spikeLen);
        g2.addColorStop(0, rgba(mix(tint, [255, 255, 255], 0.4), 0.55 * bright * ap));
        g2.addColorStop(1, rgba(tint, 0));
        ctx.strokeStyle = g2;
        ctx.lineWidth = 1.1 / Math.sqrt(this.scale);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(a) * spikeLen, Math.sin(a) * spikeLen);
        ctx.stroke();
      }
      ctx.restore();

      // Core
      if (!this.perfMode) {
        ctx.shadowBlur = 14 + n.glow * 22;
        ctx.shadowColor = rgba(tint, 0.85);
      }
      const core = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
      core.addColorStop(0, rgba([255, 252, 240], 0.98 * ap));
      core.addColorStop(0.4, rgba(mix(tint, [255, 255, 255], 0.25), (0.88 + pulseAmt) * bright * ap));
      core.addColorStop(1, rgba(tint, 0.15 * ap));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Selected / focused orbit ring.
      if ((isSelected || isHover || this.focusId === n.id) && n.glow > 0.05) {
        const orbitR = r + 9 + n.glow * 5;
        ctx.save();
        ctx.translate(n.x, n.y);
        if (!this.reducedMotion) ctx.rotate(this.elapsed * 0.0012);
        ctx.strokeStyle = rgba(tint, 0.75 * n.glow);
        ctx.lineWidth = 1.3 / this.scale;
        ctx.setLineDash([4 / this.scale, 7 / this.scale]);
        ctx.beginPath();
        ctx.arc(0, 0, orbitR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // User-facing comms ring — steady double halo ring + glyph badge marking
      // the agents the operator/clients talk to directly.
      if (n.userFacing && n.appear >= 0.9) {
        const ringR = r + 6.5 / Math.sqrt(this.scale);
        const breathe = this.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(this.elapsed * 0.0021 + n.pulse);
        ctx.strokeStyle = rgba(mix(tint, [255, 255, 255], 0.35), 0.55 * breathe * ap);
        ctx.lineWidth = 1.1 / this.scale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = rgba(tint, 0.3 * breathe * ap);
        ctx.beginPath();
        ctx.arc(n.x, n.y, ringR + 3.5 / Math.sqrt(this.scale), 0, Math.PI * 2);
        ctx.stroke();
        // Comms glyph badge (bottom-right of the star).
        const gx = n.x + (r + 7) * 0.8;
        const gy = n.y + (r + 7) * 0.8;
        const gr = 5.5 / Math.sqrt(this.scale);
        ctx.fillStyle = "rgba(8,7,4,0.9)";
        ctx.strokeStyle = rgba(mix(tint, [255, 255, 255], 0.3), 0.85 * ap);
        ctx.lineWidth = 1 / this.scale;
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = rgba(mix(tint, [255, 255, 255], 0.5), 0.95 * ap);
        ctx.font = `700 ${7 / Math.sqrt(this.scale)}px 'JetBrains Mono',monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("@", gx, gy + 0.5);
        ctx.textBaseline = "alphabetic";
      }

      // Orbiting spark — active agents get a tiny satellite circling the star.
      if (n.status === "active" && !this.reducedMotion && n.appear >= 1) {
        const oa = this.elapsed * 0.0016 + n.pulse * 2;
        const or = r + 9 / Math.sqrt(this.scale);
        const sx = n.x + Math.cos(oa) * or;
        const sy = n.y + Math.sin(oa) * or * 0.92;
        const sr = 2.4 / Math.sqrt(this.scale);
        const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 2.4);
        sg.addColorStop(0, rgba(mix(tint, [255, 255, 255], 0.7), 0.95));
        sg.addColorStop(0.5, rgba(tint, 0.5));
        sg.addColorStop(1, rgba(tint, 0));
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sx, sy, sr * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Activity badge — small live-session count chip.
      if (n.sessions > 0 && n.status === "active") {
        const bx = n.x + r * 0.95 + 5;
        const by = n.y - r * 0.95 - 5;
        const label = String(n.sessions);
        ctx.font = `700 ${9 / Math.sqrt(this.scale)}px 'JetBrains Mono',monospace`;
        const tw = ctx.measureText(label).width;
        const bw = tw + 10 / this.scale;
        const bh = 13 / Math.sqrt(this.scale);
        ctx.fillStyle = "rgba(6,10,7,0.85)";
        ctx.strokeStyle = rgba(ACTIVE_TINT, 0.7 * ap);
        ctx.lineWidth = 1 / this.scale;
        roundRect(ctx, bx, by - bh / 2, bw, bh, bh / 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = rgba(ACTIVE_TINT, 0.95 * ap);
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, bx + 5 / this.scale, by + 0.5);
        ctx.textBaseline = "alphabetic";
      }

      // ── Labels ──
      const labelA = (dimmed ? 0.35 : 1) * ap;
      const nameSize = n.tier === 0 ? 13 : n.tier === 1 ? 11 : 9.5;
      const fs = nameSize / Math.min(1, Math.max(this.scale, 0.72));
      ctx.font = `${n.tier === 0 ? 800 : 700} ${fs}px 'JetBrains Mono','SF Mono',monospace`;
      ctx.textAlign = "center";
      ctx.fillStyle = rgba(
        n.tier === 0 ? mix(gold, [255, 255, 255], 0.5) : [240, 236, 224],
        (n.tier === 2 ? 0.72 : 0.92) * labelA
      );
      ctx.shadowBlur = 6;
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      const ly = n.y + r + spikeLen * 0.35 + fs + 6;
      ctx.fillText(n.name.toUpperCase(), n.x, ly);
      ctx.shadowBlur = 0;

      // Role micro-label — shown when zoomed in or highlighted.
      if (this.scale > 0.72 || isHover || isSelected || inChain) {
        const rfs = 7.5 / Math.min(1, Math.max(this.scale, 0.72));
        ctx.font = `600 ${rfs}px 'JetBrains Mono',monospace`;
        ctx.fillStyle = rgba(mix(deptBase, [255, 255, 255], 0.15), 0.68 * labelA);
        ctx.fillText(n.role.toUpperCase(), n.x, ly + rfs + 4);
      }
    }

    ctx.restore();
  }

  private drawBackdrop(ctx: CanvasRenderingContext2D) {
    // Deep-space nebula — near-black with a faint warm gold breath at the
    // heart of the constellation and cold indigo at the far edges.
    const cx = this.tx + 0 * this.scale;
    const cy = this.ty + 0 * this.scale;
    const R = Math.max(this.width, this.height);

    const nebula = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
    nebula.addColorStop(0, "rgba(46,36,14,0.34)");
    nebula.addColorStop(0.35, "rgba(24,20,12,0.2)");
    nebula.addColorStop(0.7, "rgba(10,11,20,0.12)");
    nebula.addColorStop(1, "rgba(4,5,10,0)");
    ctx.fillStyle = nebula;
    ctx.fillRect(0, 0, this.width, this.height);

    // Shooting star — spawn every ~12-24s, live ~1.4s, far-background layer.
    if (!this.reducedMotion) {
      if (!this.meteor && this.elapsed >= this.nextMeteorAt) {
        const fromLeft = Math.random() < 0.5;
        this.meteor = {
          born: this.elapsed,
          x: fromLeft ? -40 : this.width * (0.3 + Math.random() * 0.7),
          y: this.height * Math.random() * 0.35,
          vx: (fromLeft ? 1 : 0.72) * (0.34 + Math.random() * 0.2),
          vy: 0.16 + Math.random() * 0.12,
        };
      }
      if (this.meteor) {
        const age = this.elapsed - this.meteor.born;
        if (age > 1400) {
          this.meteor = null;
          this.nextMeteorAt = this.elapsed + 12000 + Math.random() * 12000;
        } else {
          const m = this.meteor;
          const mx = m.x + m.vx * age;
          const my = m.y + m.vy * age;
          const fade = age < 250 ? age / 250 : age > 1050 ? (1400 - age) / 350 : 1;
          const tail = 90;
          const tg = ctx.createLinearGradient(mx - m.vx * tail, my - m.vy * tail, mx, my);
          tg.addColorStop(0, rgba(this.gold, 0));
          tg.addColorStop(1, rgba(mix(this.gold, [255, 255, 255], 0.6), 0.5 * fade));
          ctx.strokeStyle = tg;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(mx - m.vx * tail, my - m.vy * tail);
          ctx.lineTo(mx, my);
          ctx.stroke();
        }
      }
    }

    // Distant starfield with parallax depth.
    const tw = this.reducedMotion ? 0 : this.elapsed * 0.0011;
    for (const s of this.bgStars) {
      const px = s.x * this.scale * s.depth + this.tx * s.depth + this.width * (1 - s.depth) * 0.5;
      const py = s.y * this.scale * s.depth + this.ty * s.depth + this.height * (1 - s.depth) * 0.5;
      if (px < -4 || px > this.width + 4 || py < -4 || py > this.height + 4) continue;
      const a = s.a * (0.7 + 0.3 * Math.sin(tw + s.tw));
      ctx.fillStyle = `rgba(235,230,214,${a})`;
      ctx.beginPath();
      ctx.arc(px, py, s.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Vignette to seat the chart into the page.
    const vig = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      R * 0.45,
      this.width / 2,
      this.height / 2,
      R * 0.85
    );
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(2,2,5,0.5)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.container.removeEventListener("keydown", this.onKeyDown);
    this.container.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ro?.disconnect();
    this.canvas.remove();
    this.tooltip.remove();
    this.live.remove();
  }
}

function quadBez(p0: number, p1: number, p2: number, t: number): number {
  const it = 1 - t;
  return it * it * p0 + 2 * it * t * p1 + t * t * p2;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function escapeHtml(s: string): string {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] || c
  );
}
