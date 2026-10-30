/**
 * Review mesh layer — makes verification visible on the agent mesh map.
 *
 * The Reviewer ("Auditor") stands on the Executive Suite island. Every review
 * message travels as a colour-coded packet between the worker's sprite and the
 * Auditor (submission gold, challenge amber/red, response cyan, verdict
 * green/red/magenta); reviewer self-actions pulse on the Auditor. VERIFIED
 * lands a gold/green burst + check ring on the worker; escalations leave a
 * persistent attention marker until the thread is opened. Recent UI
 * screenshots orbit the island as framed thumbnails.
 *
 * Rendering split:
 *   Pixi (engine overlay layer): beams, trails, packet heads, Auditor avatar,
 *     pulses, flourishes, attention rings, ghost worker pads.
 *   DOM (absolute children of the engine host): every click target — the
 *     Auditor tag, the Screenshots button, packet hit-dots, attention chips,
 *     ghost worker chips, orbit thumbnails, the speech bubble. Pixi pointer
 *     taps are dead on /mesh, and DOM children of the host share the canvas's
 *     zoomed coordinate space, so body `zoom` needs no correction.
 *
 * Perf: packet / burst / ring graphics are pooled; the per-frame path writes
 * into preallocated objects; it runs inside the engine tick (paused when the
 * tab is hidden or the map offscreen); concurrency and thumbnails follow
 * lodCaps() (zoom, low-power, mobile, reduced motion).
 */

import * as PIXI from "pixi.js";
import { render, html, type TemplateResult } from "lit";

import { icons } from "../../icons";
import { isLowPower } from "../../perf";
import type { ActivityMap } from "./activity-map";
import { gatewayUrl, type FeedEvent, type ReviewFeed } from "../../lib/review-mesh/feed";
import {
  PacketScheduler,
  TONE_HEX,
  TONE_CSS,
  arcLift,
  arcPoint,
  easeInOut,
  isPacketMessage,
  lodCaps,
  needsOwner,
  orbitSlots,
  packetTone,
  recentThreads,
  scheduleReplay,
  travelsToReviewer,
  truncate,
  workerOf,
  MAX_PACKETS,
  MAX_THUMBS,
  type LodCaps,
  type MutablePoint,
  type PacketTone,
  type StoredThread,
} from "../../lib/review-mesh/model";
import type { ReviewMessage, ScreenshotEntry } from "../../lib/review-mesh/types";
import { VERDICT_TONE, completedVerdictOf, haloAlpha, isTerminalState } from "../../lib/review-mesh/completed";

export interface ReviewMeshLayerOptions {
  engine: ActivityMap;
  host: HTMLElement;
  feed: ReviewFeed;
  onOpenThread: (runId: string | null, focusMessageId?: string) => void;
  onOpenGallery: (shotId?: string) => void;
}

/** Auditor stand offset from the Executive Suite centre (world px). */
const AUDITOR_OFFSET = { x: 118, y: 28 };
const PACKET_MIN_MS = 1500;
const PACKET_MAX_MS = 2400;
const FLOURISH_MS = 1700;
const PULSE_MS = 1100;
const GHOST_MAX = 6;
const QUEUE_SLOTS = 12;
const GHOST_WINDOW_MS = 15 * 60_000;

interface Packet {
  active: boolean;
  msg: ReviewMessage | null;
  tone: PacketTone;
  toReviewer: boolean;
  runId: string;
  workerKey: string;
  t0: number;
  dur: number;
  /** World endpoints (refreshed every few frames: agents walk). */
  wx: number;
  wy: number;
  head: PIXI.Graphics;
  hit: HTMLButtonElement;
  hitX: number;
  hitY: number;
  /** Current world position of the head. */
  pos: MutablePoint;
}

interface Burst {
  active: boolean;
  t0: number;
  dur: number;
  x: number;
  y: number;
  check: boolean;
  root: PIXI.Container;
  ring: PIXI.Graphics;
  sparks: PIXI.Graphics;
  checkG: PIXI.Graphics;
  /** Follow this worker key while playing (null = fixed point). */
  follow: string | null;
  runId: string;
}

interface Pulse {
  active: boolean;
  t0: number;
  g: PIXI.Graphics;
}

interface Marker {
  runId: string;
  ring: PIXI.Graphics;
  chip: HTMLButtonElement;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
}

interface Ghost {
  runId: string;
  pad: PIXI.Graphics;
  chip: HTMLButtonElement;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
}

interface Halo {
  runId: string;
  key: string;
  g: PIXI.Graphics;
  finishedAt: number;
  x: number;
  y: number;
}

interface Thumb {
  el: HTMLButtonElement;
  img: HTMLImageElement;
  tag: HTMLSpanElement;
  shotId: string;
  lastX: number;
  lastY: number;
  lastS: number;
}

type ScheduledItem = { msg: ReviewMessage; replay: boolean };

function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

/** NaN-safe "position changed" test (fresh elements start at NaN). */
function moved(a: number, b: number, eps: number): boolean {
  return !(Math.abs(a - b) <= eps);
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function isMobileLike(): boolean {
  try {
    return window.innerWidth < 600 || window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

const LAYER_CSS = `
.rm-root { position: absolute; inset: 0; pointer-events: none; z-index: 18; overflow: hidden; contain: layout style; }
.rm-root * { box-sizing: border-box; }
.rm-abs { position: absolute; left: 0; top: 0; will-change: transform; }
.rm-tag {
  pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px 4px 6px; border-radius: 999px; white-space: nowrap;
  font: 600 11px/1.2 var(--g-font-family, ui-sans-serif, system-ui, sans-serif); letter-spacing: 0.04em;
  color: #fde68a; border: 1px solid rgba(245,197,66,0.55);
  background: linear-gradient(180deg, rgba(30,24,8,0.86), rgba(10,10,16,0.86));
  box-shadow: 0 0 14px rgba(245,197,66,0.28), inset 0 1px 0 rgba(255,255,255,0.08);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  transform-origin: 50% 100%;
}
.rm-tag:hover, .rm-tag:focus-visible { border-color: #f5c542; color: #fff7d6; outline: none; box-shadow: 0 0 18px rgba(245,197,66,0.5); }
.rm-tag__icon { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: rgba(245,197,66,0.18); color: #f5c542; }
.rm-tag__icon svg { width: 13px; height: 13px; }
.rm-tag__sub { color: rgba(253,230,138,0.7); font-weight: 500; }
.rm-tag__badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: #e879f9; color: #1a0420; font-size: 10px; font-weight: 800; display: none; place-items: center; }
.rm-tag__badge.on { display: inline-grid; }
.rm-shots-btn {
  pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: 999px; white-space: nowrap;
  font: 600 10.5px/1.2 var(--g-font-family, ui-sans-serif, system-ui, sans-serif); letter-spacing: 0.04em;
  color: #e8e6e3; border: 1px solid rgba(148,163,184,0.45); background: rgba(10,12,20,0.82);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.rm-shots-btn svg { width: 12px; height: 12px; }
.rm-shots-btn:hover, .rm-shots-btn:focus-visible { border-color: #f5c542; color: #fde68a; outline: none; }
.rm-hit {
  pointer-events: auto; cursor: pointer; width: 26px; height: 26px; margin: -13px 0 0 -13px; padding: 0;
  border: 0; border-radius: 50%; background: transparent; display: none;
}
.rm-hit.on { display: block; }
.rm-hit:focus-visible { outline: 2px solid #f5c542; }
.rm-tag, .rm-shots-btn { z-index: 3; }
.rm-bubble {
  z-index: 2;
  pointer-events: none; max-width: 240px; padding: 5px 9px; border-radius: 9px;
  font: 500 11px/1.35 var(--g-font-family, ui-sans-serif, system-ui, sans-serif);
  color: #f4f4f5; background: rgba(9,10,16,0.9); border: 1px solid var(--rm-tone, #f5c542);
  box-shadow: 0 4px 16px rgba(0,0,0,0.45), 0 0 10px color-mix(in srgb, var(--rm-tone, #f5c542) 35%, transparent);
  opacity: 0; transition: opacity 160ms ease; white-space: normal; transform-origin: 50% 100%;
}
.rm-bubble.on { opacity: 1; }
.rm-bubble__k { display: block; font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--rm-tone, #f5c542); margin-bottom: 1px; }
.rm-chip {
  pointer-events: auto; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px 2px 5px; border-radius: 999px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis;
  font: 600 10px/1.3 var(--g-font-family, ui-sans-serif, system-ui, sans-serif);
  color: #f5d0fe; border: 1px solid rgba(232,121,249,0.7); background: rgba(40,6,48,0.86);
  box-shadow: 0 0 12px rgba(232,121,249,0.45);
  transform-origin: 50% 100%;
}
.rm-chip svg { width: 12px; height: 12px; flex: none; }
.rm-ghost {
  pointer-events: auto; cursor: pointer; width: 30px; height: 26px; padding: 0; border: 0; border-radius: 50%;
  background: transparent;
}
.rm-ghost:hover, .rm-ghost:focus-visible { outline: 2px solid rgba(245,197,66,0.8); outline-offset: -2px; }
.rm-chip--ghost { color: #cbd5e1; border-color: rgba(148,163,184,0.5); background: rgba(12,14,22,0.82); box-shadow: none; font-weight: 500; }
.rm-chip:focus-visible { outline: 2px solid #f5c542; }
.rm-thumb {
  pointer-events: auto; cursor: zoom-in; padding: 0; margin: 0; display: block; position: absolute; left: 0; top: 0;
  width: 92px; border-radius: 7px; overflow: hidden; background: rgba(8,9,14,0.92);
  border: 2px solid var(--rm-border, #94a3b8);
  box-shadow: 0 6px 18px rgba(0,0,0,0.5), 0 0 12px color-mix(in srgb, var(--rm-border, #94a3b8) 40%, transparent);
  transform-origin: 50% 50%; transition: opacity 200ms ease;
}
.rm-thumb img { display: block; width: 100%; height: 54px; object-fit: cover; background: #0b0d14; }
.rm-thumb__tag { display: block; padding: 2px 5px 3px; font: 500 8.5px/1.25 var(--g-mono-family, ui-monospace, monospace); color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
.rm-thumb__tag b { color: #f4f4f5; font-weight: 600; }
.rm-thumb:hover, .rm-thumb:focus-visible { outline: none; box-shadow: 0 0 0 2px #f5c542, 0 8px 22px rgba(0,0,0,0.6); z-index: 2; }
:root[data-theme-mode="light"] .rm-tag, .rm-root[data-light] .rm-tag { color: #5b4500; background: rgba(255,251,235,0.92); }
@media (prefers-reduced-motion: reduce) { .rm-bubble { transition: none; } }
`;

export class ReviewMeshLayer {
  private readonly engine: ActivityMap;
  private readonly host: HTMLElement;
  private readonly feed: ReviewFeed;
  private readonly opts: ReviewMeshLayerOptions;

  private layer: PIXI.Container;
  private beamG = new PIXI.Graphics();
  private headLayer = new PIXI.Container();
  private fxLayer = new PIXI.Container();
  private auditor = new PIXI.Container();
  private auditorAura = new PIXI.Graphics();
  private auditorBody = new PIXI.Graphics();

  private root: HTMLDivElement;
  private style: HTMLStyleElement;
  private tagEl: HTMLButtonElement;
  private tagBadge: HTMLSpanElement;
  private shotsBtn: HTMLButtonElement;
  private shotsCount: HTMLSpanElement;
  private bubble: HTMLDivElement;
  private bubbleKind: HTMLSpanElement;
  private bubbleText: HTMLSpanElement;

  private packets: Packet[] = [];
  private bursts: Burst[] = [];
  private pulses: Pulse[] = [];
  private markers = new Map<string, Marker>();
  private halos = new Map<string, Halo>();
  private halosDirty = true;
  private ghosts = new Map<string, Ghost>();
  private thumbs: Thumb[] = [];
  /** Unit orbit (inner ring radius 1); scaled to screen px each frame so thumbnails never overlap. */
  private thumbSlots: MutablePoint[] = orbitSlots(MAX_THUMBS, { innerRadius: 1, outerRadius: 1, squash: 1 });

  private scheduler = new PacketScheduler<ScheduledItem>(28);
  private dueBuf: ScheduledItem[] = [];
  private lod: LodCaps = lodCaps({ zoom: 1, lowPower: false });
  private lowPower = false;
  private reducedMotion = false;
  private mobile = false;
  private frame = 0;
  private now = 0;
  private auditorWorld: MutablePoint = { x: 0, y: 0 };
  private scratch: MutablePoint = { x: 0, y: 0 };
  private hoverPacket: Packet | null = null;
  private bubbleUntil = 0;
  private bubbleFollow: Packet | null = null;
  private bubbleAtAuditor = false;
  private lastTag = { x: NaN, y: NaN, s: NaN };
  private unsubs: Array<() => void> = [];
  private destroyed = false;
  private thumbsDirty = true;
  private queueSlots = new Map<string, number>();
  private visibleThumbs = 0;
  private bubbleW = 0;
  private lodZoom = -1;
  private markersDirty = true;
  private warmed = false;

  constructor(opts: ReviewMeshLayerOptions) {
    this.opts = opts;
    this.engine = opts.engine;
    this.host = opts.host;
    this.feed = opts.feed;
    this.lowPower = isLowPower();
    this.reducedMotion = prefersReducedMotion();
    this.mobile = isMobileLike();

    // ── Pixi ──
    this.layer = this.engine.createOverlayLayer();
    this.layer.addChild(this.beamG, this.fxLayer, this.auditor, this.headLayer);
    this.buildAuditor();
    for (let i = 0; i < 4; i++) this.pulses.push(this.makePulse());
    for (let i = 0; i < 4; i++) this.bursts.push(this.makeBurst());

    // ── DOM ──
    this.style = document.createElement("style");
    this.style.textContent = LAYER_CSS;
    this.root = document.createElement("div");
    this.root.className = "rm-root";
    this.root.setAttribute("data-ib-target", "control:mesh/review-layer");
    this.host.appendChild(this.style);
    this.host.appendChild(this.root);

    this.tagEl = document.createElement("button");
    this.tagEl.type = "button";
    this.tagEl.className = "rm-tag rm-abs";
    this.tagEl.title = "Auditor — the verification reviewer. Open review threads";
    this.tagEl.setAttribute("aria-label", "Open review threads (Auditor, verification reviewer)");
    this.tagEl.setAttribute("data-review-auditor", "");
    const iconWrap = document.createElement("span");
    iconWrap.className = "rm-tag__icon";
    render(icons.shield as TemplateResult, iconWrap);
    const name = document.createElement("span");
    name.innerHTML = `Auditor <span class="rm-tag__sub">· Reviewer</span>`;
    this.tagBadge = document.createElement("span");
    this.tagBadge.className = "rm-tag__badge";
    this.tagEl.append(iconWrap, name, this.tagBadge);
    this.tagEl.addEventListener("click", () => this.opts.onOpenThread(null));
    this.tagEl.addEventListener("pointerenter", () => this.showAuditorBubble());
    this.tagEl.addEventListener("pointerleave", () => this.hideBubbleSoon());
    this.root.appendChild(this.tagEl);

    this.shotsBtn = document.createElement("button");
    this.shotsBtn.type = "button";
    this.shotsBtn.className = "rm-shots-btn rm-abs";
    this.shotsBtn.title = "Open the screenshot gallery";
    this.shotsBtn.setAttribute("data-review-screenshots", "");
    const camWrap = document.createElement("span");
    camWrap.style.display = "inline-flex";
    render(icons.camera as TemplateResult, camWrap);
    this.shotsCount = document.createElement("span");
    this.shotsCount.textContent = "Screenshots";
    this.shotsBtn.append(camWrap, this.shotsCount);
    this.shotsBtn.addEventListener("click", () => this.opts.onOpenGallery());
    this.root.appendChild(this.shotsBtn);

    this.bubble = document.createElement("div");
    this.bubble.className = "rm-bubble rm-abs";
    this.bubbleKind = document.createElement("span");
    this.bubbleKind.className = "rm-bubble__k";
    this.bubbleText = document.createElement("span");
    this.bubble.append(this.bubbleKind, this.bubbleText);
    this.root.appendChild(this.bubble);

    for (let i = 0; i < MAX_PACKETS; i++) this.packets.push(this.makePacket());

    // ── Wiring ──
    this.unsubs.push(this.engine.onFrame((ms) => this.tick(ms)));
    this.unsubs.push(this.feed.on((ev) => this.onFeed(ev)));
    const onResize = () => {
      this.mobile = isMobileLike();
    };
    window.addEventListener("resize", onResize, { passive: true });
    this.unsubs.push(() => window.removeEventListener("resize", onResize));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.scheduler.clear();
    try {
      this.engine.removeOverlayLayer(this.layer);
    } catch {
      /* engine already destroyed */
    }
    this.root.remove();
    this.style.remove();
  }

  // ── Public ─────────────────────────────────────────────────────────────

  /** Re-animate a thread's packets in order (compressed timing). */
  replayThread(thread: StoredThread, lastN?: number, startDelayMs = 200): void {
    const runId = thread.summary.runId;
    this.scheduler.remove((it) => it.replay && it.msg.runId === runId);
    const steps = scheduleReplay(thread.messages, { lastN, startDelayMs, minGapMs: 1100, maxGapMs: 2000 });
    const t = performance.now();
    for (const s of steps) this.scheduler.enqueue({ msg: s.message, replay: true }, t + s.delayMs);
  }

  /** Mount warm-up: replay the last few messages of threads active in the last ~10 min. */
  async warmUp(): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;
    const recent = recentThreads(this.feed.store.list(), Date.now(), 10 * 60_000, 3);
    let offset = 300;
    for (const t of recent) {
      const full = await this.feed.loadThread(t.summary.runId);
      if (this.destroyed) return;
      if (full?.messages.length) {
        this.replayThread(full, 3, offset);
        offset += 1600;
      }
    }
    this.markersDirty = true;
  }

  /**
   * Fly the camera to the Executive Suite. With `panel` (desktop side panel
   * open over the right edge), frame the Auditor left of centre so it and the
   * incoming packets stay visible beside the panel.
   */
  focusAuditor(opts: { panel?: boolean } = {}): void {
    const c = this.engine.getExecutiveCenter();
    if (opts.panel && !this.mobile) {
      this.engine.cameraFlyTo(c.x + 150, c.y + 90, 0.8, 700);
      return;
    }
    if (this.mobile) {
      // Phones: the HUD column covers the top half, so frame the Auditor in
      // the lower half (camera centre above it) at a tighter zoom.
      this.engine.cameraFlyTo(c.x + AUDITOR_OFFSET.x - 20, c.y - 150, 0.62, 700);
      return;
    }
    // Lean toward the HQ so incoming packets from the worker side stay in frame.
    this.engine.cameraFlyTo(c.x - 170, c.y + 110, 0.8, 700);
  }

  /** Debug snapshot (window.__reviewMesh.stats()). */
  stats(): Record<string, unknown> {
    const anchor = { x: 0, y: 0 };
    const first = this.feed.store.list()[0];
    if (first) this.workerWorld(first.summary.runId, first.summary.workerAgent, anchor);
    return {
      packets: this.activeCount(),
      queued: this.scheduler.length,
      lod: this.lod,
      auditor: { ...this.auditorWorld },
      exec: this.engine.getExecutiveCenter(),
      aq: this.engine.getSectorCenter("agent-quarters"),
      firstAnchor: anchor,
      zoom: this.engine.getZoom(),
      threads: this.feed.store.size,
      markers: this.markers.size,
      ghosts: this.ghosts.size,
      thumbs: this.thumbs.filter((t) => t.shotId).length,
    };
  }

  // ── Feed ───────────────────────────────────────────────────────────────

  private onFeed(ev: FeedEvent): void {
    if (ev.type === "message") {
      if (ev.fresh && ev.live) this.scheduler.enqueue({ msg: ev.message, replay: false }, performance.now());
      this.markersDirty = true;
    } else if (ev.type === "screenshots") {
      this.thumbsDirty = true;
    } else if (ev.type === "completed" || ev.type === "completion") {
      this.halosDirty = true;
      this.markersDirty = true;
    } else {
      this.markersDirty = true;
    }
  }

  // ── Builders ───────────────────────────────────────────────────────────

  private buildAuditor(): void {
    const aura = this.auditorAura;
    aura.lineStyle(2, 0xf5c542, 0.75);
    aura.drawEllipse(0, 0, 30, 14);
    aura.lineStyle(1, 0xf5c542, 0.35);
    aura.drawEllipse(0, 0, 40, 19);
    aura.beginFill(0xf5c542, 0.12);
    aura.lineStyle(0);
    aura.drawEllipse(0, 0, 30, 14);
    aura.endFill();

    const b = this.auditorBody;
    // Light column under the shield.
    b.beginFill(0xf5c542, 0.12);
    b.drawPolygon([-10, 0, 10, 0, 6, -44, -6, -44]);
    b.endFill();
    // Shield (floating), dark glass body with gold rim.
    const shield = [0, -76, 17, -70, 17, -55, 14, -45, 0, -34, -14, -45, -17, -55, -17, -70];
    b.beginFill(0x0c0f1c, 0.95);
    b.lineStyle(2.5, 0xf5c542, 1);
    b.drawPolygon(shield);
    b.endFill();
    b.lineStyle(1.25, 0xfde68a, 0.8);
    b.drawPolygon([0, -70, 11, -66, 11, -56, 9, -49, 0, -41, -9, -49, -11, -56, -11, -66]);
    // Check glyph.
    b.lineStyle(2.5, 0x22c55e, 1);
    b.moveTo(-6, -56);
    b.lineTo(-1.5, -51);
    b.lineTo(7, -61);
    b.lineStyle(0);
    this.auditor.addChild(aura, b);
  }

  private makePacket(): Packet {
    const head = new PIXI.Graphics();
    head.beginFill(0xffffff, 0.22);
    head.drawCircle(0, 0, 11);
    head.endFill();
    head.beginFill(0xffffff, 0.5);
    head.drawCircle(0, 0, 6.5);
    head.endFill();
    head.beginFill(0xffffff, 1);
    head.drawCircle(0, 0, 3.6);
    head.endFill();
    head.visible = false;
    this.headLayer.addChild(head);
    const hit = document.createElement("button");
    hit.type = "button";
    hit.className = "rm-hit rm-abs";
    hit.setAttribute("aria-label", "Review message");
    this.root.appendChild(hit);
    const p: Packet = {
      active: false,
      msg: null,
      tone: "gold",
      toReviewer: true,
      runId: "",
      workerKey: "",
      t0: 0,
      dur: PACKET_MIN_MS,
      wx: 0,
      wy: 0,
      head,
      hit,
      hitX: NaN,
      hitY: NaN,
      pos: { x: 0, y: 0 },
    };
    hit.addEventListener("pointerenter", () => {
      this.hoverPacket = p;
      this.showPacketBubble(p, 1e9);
    });
    hit.addEventListener("pointerleave", () => {
      if (this.hoverPacket === p) this.hoverPacket = null;
      this.hideBubbleSoon();
    });
    hit.addEventListener("click", () => {
      if (p.msg) this.opts.onOpenThread(p.msg.runId, p.msg.id);
    });
    return p;
  }

  private makePulse(): Pulse {
    const g = new PIXI.Graphics();
    g.lineStyle(2, 0xffffff, 1);
    g.drawEllipse(0, 0, 30, 14);
    g.visible = false;
    this.fxLayer.addChild(g);
    return { active: false, t0: 0, g };
  }

  private makeBurst(): Burst {
    const root = new PIXI.Container();
    const ring = new PIXI.Graphics();
    ring.lineStyle(3, 0xffffff, 1);
    ring.drawEllipse(0, 0, 26, 13);
    const sparks = new PIXI.Graphics();
    sparks.lineStyle(2.5, 0xffffff, 1);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      sparks.moveTo(Math.cos(a) * 14, Math.sin(a) * 7 - 18);
      sparks.lineTo(Math.cos(a) * 26, Math.sin(a) * 13 - 18);
    }
    const checkG = new PIXI.Graphics();
    checkG.beginFill(0x07130b, 0.85);
    checkG.lineStyle(2.5, 0xffffff, 1);
    checkG.drawCircle(0, -40, 13);
    checkG.endFill();
    checkG.lineStyle(3, 0xffffff, 1);
    checkG.moveTo(-6, -40);
    checkG.lineTo(-1.5, -35);
    checkG.lineTo(6.5, -45);
    root.addChild(ring, sparks, checkG);
    root.visible = false;
    this.fxLayer.addChild(root);
    return { active: false, t0: 0, dur: FLOURISH_MS, x: 0, y: 0, check: false, root, ring, sparks, checkG, follow: null, runId: "" };
  }

  // ── Positions ─────────────────────────────────────────────────────────

  private updateAuditorWorld(): void {
    const c = this.engine.getExecutiveCenter();
    this.auditorWorld.x = c.x + AUDITOR_OFFSET.x;
    this.auditorWorld.y = c.y + AUDITOR_OFFSET.y;
  }

  /** Worker world position: its sprite, else the parent agent, else a pad in Agent Quarters. */
  private workerWorld(runId: string, workerKey: string, out: MutablePoint): { onMap: boolean } {
    const e = this.engine;
    let key: string | null = workerKey && e.hasAgent(workerKey) ? workerKey : null;
    if (!key) key = e.findAgentKeyByRunId(runId);
    if (key) {
      const p = e.agentWorldPos(key);
      if (p) {
        out.x = p.x;
        out.y = p.y;
        return { onMap: true };
      }
    }
    this.fallbackAnchor(runId, out);
    return { onMap: false };
  }

  /**
   * Where a worker that is not (or no longer) on the map stands: a slot in the
   * "review queue" along the bridge from the HQ to the Executive Suite. Slots
   * are assigned per run on first use (LRU, 12 slots) so pads never stack.
   */
  private fallbackAnchor(runId: string, out: MutablePoint): void {
    let slot = this.queueSlots.get(runId);
    if (slot === undefined) {
      const used = new Set(this.queueSlots.values());
      slot = 0;
      while (used.has(slot) && slot < QUEUE_SLOTS) slot++;
      if (slot >= QUEUE_SLOTS) {
        const oldest = this.queueSlots.keys().next().value as string;
        slot = this.queueSlots.get(oldest) ?? 0;
        this.queueSlots.delete(oldest);
      }
      this.queueSlots.set(runId, slot);
    }
    const e = this.engine.getExecutiveCenter();
    // HQ hub sits at (-640, +330) from the Executive Suite (sector-layout.ts).
    const dx = -640;
    const dy = 330;
    const len = Math.hypot(dx, dy);
    const px = dy / len;
    const py = -dx / len;
    const row = Math.floor(slot / 2);
    const side = slot % 2 === 0 ? 1 : -1;
    const t = 0.3 + row * 0.1;
    out.x = e.x + dx * t + px * 62 * side;
    out.y = e.y + dy * t + py * 62 * side * 0.55;
  }

  // ── Frame ─────────────────────────────────────────────────────────────

  private tick(deltaMS: number): void {
    if (this.destroyed) return;
    this.frame++;
    this.now = performance.now();
    const vp = this.engine.getViewport();
    if (!vp || !vp.transform) return;
    const zoom = vp.scale.x;
    const ox = vp.x;
    const oy = vp.y;

    if (this.frame % 15 === 1 || Math.abs(zoom - this.lodZoom) > 0.04) {
      this.lodZoom = zoom;
      this.lod = lodCaps({ zoom, lowPower: this.lowPower, mobile: this.mobile, reducedMotion: this.reducedMotion });
      this.updateAuditorWorld();
    }

    // Launch due packets / actions.
    const due = this.scheduler.take(this.now, this.activeCount(), this.lod.maxPackets, this.dueBuf);
    for (let i = 0; i < due.length; i++) this.launch(due[i]);

    // Auditor idle breath + bob.
    const aw = this.auditorWorld;
    this.auditor.position.set(aw.x, aw.y);
    const breath = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.now / 700);
    this.auditorAura.alpha = 0.55 + 0.45 * breath;
    this.auditorAura.scale.set(0.95 + 0.1 * breath);
    this.auditorBody.y = this.reducedMotion ? 0 : Math.sin(this.now / 900) * 2.5;

    this.updatePackets(zoom, ox, oy, deltaMS);
    this.updatePulses();
    this.updateBursts();

    if (this.markersDirty || this.frame % 45 === 0) {
      this.markersDirty = false;
      this.syncMarkers();
    }
    this.positionMarkers(zoom, ox, oy);
    if (this.halosDirty || this.frame % 60 === 0) {
      this.halosDirty = false;
      this.syncHalos();
    }
    this.updateHalos();

    if (this.thumbsDirty || this.frame % 30 === 0) {
      this.syncThumbs();
      this.thumbsDirty = false;
    }
    this.positionThumbs(zoom, ox, oy);
    this.positionChrome(zoom, ox, oy);
    this.updateBubble(zoom, ox, oy);
    if (this.frame % 6 === 0) this.clipToView();
  }

  /**
   * World-anchored DOM chrome (Auditor tag, bubble, verdict chips, screenshot
   * thumbs) is hidden while it would be cut by the map edge or sit under the
   * host HUD column, instead of being drawn half-clipped.
   */
  private clipToView(): void {
    const host = this.host.getBoundingClientRect();
    if (!host.width || !host.height) return;
    const chrome = this.engine.getChromeRects?.() ?? [];
    const els: HTMLElement[] = [this.tagEl, this.shotsBtn, this.bubble];
    for (const m of this.markers.values()) els.push(m.chip);
    for (const g of this.ghosts.values()) els.push(g.chip);
    for (const el of els) {
      if (!el || el.style.display === "none") continue;
      el.style.visibility = "";
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const x = r.left - host.left;
      const y = r.top - host.top;
      const cut = y < 0 || x < 0 || y + r.height > host.height || x + r.width > host.width;
      const under = chrome.some((c) => x < c.x + c.width && x + r.width > c.x && y < c.y + c.height && y + r.height > c.y);
      el.style.visibility = cut || under ? "hidden" : "";
    }
  }

  private activeCount(): number {
    let n = 0;
    for (const p of this.packets) if (p.active) n++;
    return n;
  }

  private launch(item: ScheduledItem): void {
    const msg = item.msg;
    if (!isPacketMessage(msg)) {
      this.firePulse(TONE_HEX.violet);
      if (!this.hoverPacket) this.showActionBubble(msg);
      return;
    }
    const p = this.packets.find((x) => !x.active);
    if (!p) return;
    p.active = true;
    p.msg = msg;
    p.tone = packetTone(msg);
    p.toReviewer = travelsToReviewer(msg);
    p.runId = msg.runId;
    p.workerKey = workerOf(msg);
    p.t0 = this.now;
    this.workerWorld(p.runId, p.workerKey, this.scratch);
    p.wx = this.scratch.x;
    p.wy = this.scratch.y;
    const d = Math.hypot(p.wx - this.auditorWorld.x, p.wy - this.auditorWorld.y);
    p.dur = Math.min(PACKET_MAX_MS, Math.max(PACKET_MIN_MS, d * 2.2));
    p.head.tint = TONE_HEX[p.tone];
    p.head.visible = true;
    p.hit.setAttribute("aria-label", `${msg.kind}: ${msg.title}`);
    p.hit.title = msg.title;
    this.markersDirty = true;
    if (!this.hoverPacket) this.showPacketBubble(p, p.dur);
  }

  private updatePackets(zoom: number, ox: number, oy: number, _dt: number): void {
    const g = this.beamG;
    g.clear();
    const aw = this.auditorWorld;
    const trail = this.lod.trailDots;
    const targets = this.lod.packetTargets;
    for (const p of this.packets) {
      if (!p.active) continue;
      if (this.frame % 6 === 0) {
        this.workerWorld(p.runId, p.workerKey, this.scratch);
        p.wx = this.scratch.x;
        p.wy = this.scratch.y;
      }
      const raw = (this.now - p.t0) / p.dur;
      if (raw >= 1) {
        this.arrive(p);
        continue;
      }
      const ax = p.toReviewer ? p.wx : aw.x;
      const ay = p.toReviewer ? p.wy - 14 : aw.y - 50;
      const bx = p.toReviewer ? aw.x : p.wx;
      const by = p.toReviewer ? aw.y - 50 : p.wy - 14;
      const lift = arcLift(ax, ay, bx, by);
      const color = TONE_HEX[p.tone];
      // Faint beam along the whole route (fades in, then out near arrival).
      const beamA = Math.min(1, raw * 4) * Math.min(1, (1 - raw) * 3) * 0.55;
      g.lineStyle(2.2 / Math.max(0.35, zoom), color, beamA);
      arcPoint(ax, ay, bx, by, lift, 0, this.scratch);
      g.moveTo(this.scratch.x, this.scratch.y);
      for (let i = 1; i <= 18; i++) {
        arcPoint(ax, ay, bx, by, lift, i / 18, this.scratch);
        g.lineTo(this.scratch.x, this.scratch.y);
      }
      g.lineStyle(0);
      const t = this.reducedMotion ? raw : easeInOut(raw);
      // Fading trail.
      for (let i = trail; i >= 1; i--) {
        const tt = t - i * 0.028;
        if (tt <= 0) continue;
        arcPoint(ax, ay, bx, by, lift, tt, this.scratch);
        g.beginFill(color, 0.7 * (1 - i / (trail + 1)));
        g.drawCircle(this.scratch.x, this.scratch.y, (5.2 - i * 0.55) / Math.max(0.5, zoom * 0.9));
        g.endFill();
      }
      arcPoint(ax, ay, bx, by, lift, t, p.pos);
      p.head.position.set(p.pos.x, p.pos.y);
      p.head.scale.set(1.5 / Math.max(0.5, Math.min(1.4, zoom)));
      // DOM hit target follows the head.
      if (targets) {
        const sx = ox + p.pos.x * zoom;
        const sy = oy + p.pos.y * zoom;
        if (moved(sx, p.hitX, 0.5) || moved(sy, p.hitY, 0.5)) {
          p.hitX = sx;
          p.hitY = sy;
          p.hit.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px)`;
        }
        if (!p.hit.classList.contains("on")) p.hit.classList.add("on");
      } else if (p.hit.classList.contains("on")) {
        p.hit.classList.remove("on");
      }
    }
  }

  private arrive(p: Packet): void {
    const msg = p.msg;
    p.active = false;
    p.head.visible = false;
    p.hit.classList.remove("on");
    p.hitX = NaN;
    if (this.hoverPacket === p) this.hoverPacket = null;
    if (this.bubbleFollow === p) {
      this.bubbleFollow = null;
      this.bubbleUntil = this.now + 1400;
    }
    if (!msg) return;
    if (p.toReviewer) {
      this.firePulse(TONE_HEX[p.tone]);
      return;
    }
    if (msg.kind === "verdict" && msg.verdict === "VERIFIED") {
      this.fireBurst(p, TONE_HEX.gold, TONE_HEX.green, true);
    } else if (msg.kind === "verdict" && (msg.verdict === "FAILED" || msg.verdict === "changes_needed")) {
      this.fireBurst(p, TONE_HEX.red, TONE_HEX.red, false);
    } else if (msg.kind === "verdict" && msg.verdict === "escalate") {
      this.fireBurst(p, TONE_HEX.magenta, TONE_HEX.magenta, false);
      this.markersDirty = true;
    } else {
      this.fireBurst(p, TONE_HEX[p.tone], TONE_HEX[p.tone], false, 900);
    }
  }

  private firePulse(color: number): void {
    const pulse = this.pulses.find((x) => !x.active) ?? this.pulses[0];
    pulse.active = true;
    pulse.t0 = this.now;
    pulse.g.tint = color;
    pulse.g.visible = true;
    pulse.g.position.set(this.auditorWorld.x, this.auditorWorld.y);
  }

  private updatePulses(): void {
    for (const p of this.pulses) {
      if (!p.active) continue;
      const k = (this.now - p.t0) / PULSE_MS;
      if (k >= 1) {
        p.active = false;
        p.g.visible = false;
        continue;
      }
      p.g.scale.set(1 + k * 1.6);
      p.g.alpha = 1 - k;
    }
  }

  private fireBurst(p: Packet, sparkColor: number, ringColor: number, check: boolean, dur = FLOURISH_MS): void {
    const b = this.bursts.find((x) => !x.active) ?? this.bursts[0];
    b.active = true;
    b.t0 = this.now;
    b.dur = this.reducedMotion ? Math.min(dur, 900) : dur;
    b.x = p.wx;
    b.y = p.wy;
    b.check = check;
    b.follow = p.workerKey;
    b.runId = p.runId;
    b.sparks.tint = sparkColor;
    b.ring.tint = ringColor;
    b.checkG.tint = TONE_HEX.green;
    b.checkG.visible = check;
    b.sparks.visible = !this.reducedMotion && (check || dur >= FLOURISH_MS);
    b.root.visible = true;
    b.root.position.set(b.x, b.y);
  }

  private updateBursts(): void {
    for (const b of this.bursts) {
      if (!b.active) continue;
      const k = (this.now - b.t0) / b.dur;
      if (k >= 1) {
        b.active = false;
        b.root.visible = false;
        continue;
      }
      if (b.follow && this.frame % 4 === 0) {
        this.workerWorld(b.runId, b.follow, this.scratch);
        b.x = this.scratch.x;
        b.y = this.scratch.y;
        b.root.position.set(b.x, b.y);
      }
      const ringK = Math.min(1, k * 1.6);
      b.ring.scale.set(0.6 + ringK * 1.8);
      b.ring.alpha = 1 - ringK;
      b.sparks.scale.set(0.7 + k * 1.2);
      b.sparks.alpha = k < 0.5 ? 1 : 1 - (k - 0.5) * 2;
      if (b.check) {
        const ck = k < 0.15 ? k / 0.15 : k > 0.8 ? (1 - k) / 0.2 : 1;
        b.checkG.alpha = ck;
        b.checkG.scale.set(0.8 + 0.2 * Math.min(1, k / 0.15));
      }
    }
  }

  // ── Markers (escalations) + ghost workers ─────────────────────────────

  private syncMarkers(): void {
    const pending = this.feed.pendingAttention();
    const want = new Set(pending.map((t) => t.summary.runId));
    for (const [runId, m] of this.markers) {
      if (!want.has(runId)) {
        m.ring.destroy();
        m.chip.remove();
        this.markers.delete(runId);
      }
    }
    for (const t of pending.slice(0, 8)) {
      const runId = t.summary.runId;
      if (this.markers.has(runId)) continue;
      const ring = new PIXI.Graphics();
      ring.lineStyle(2.5, TONE_HEX.magenta, 1);
      ring.drawEllipse(0, 0, 22, 11);
      ring.lineStyle(1.5, TONE_HEX.magenta, 0.55);
      ring.drawEllipse(0, 0, 32, 16);
      this.fxLayer.addChild(ring);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rm-chip rm-abs";
      chip.setAttribute("data-review-attention", runId);
      chip.title = t.summary.escalation?.decision ?? "Owner decision needed";
      render(html`${icons.alert}<span>Owner decision</span>`, chip);
      chip.addEventListener("click", () => this.opts.onOpenThread(runId));
      this.root.appendChild(chip);
      this.markers.set(runId, { runId, ring, chip, x: 0, y: 0, lastX: NaN, lastY: NaN });
    }
    // Ghost pads for recently active workers that are not on the map.
    const now = Date.now();
    const wantGhost = new Set<string>();
    for (const t of this.feed.store.list()) {
      if (wantGhost.size >= GHOST_MAX) break;
      if (now - t.summary.lastTs > GHOST_WINDOW_MS && !this.markers.has(t.summary.runId)) continue;
      const worker = t.summary.workerAgent || t.summary.childSessionKey;
      const on = (worker && this.engine.hasAgent(worker)) || this.engine.findAgentKeyByRunId(t.summary.runId);
      if (on) continue;
      wantGhost.add(t.summary.runId);
    }
    for (const [runId, g] of this.ghosts) {
      if (!wantGhost.has(runId)) {
        g.pad.destroy();
        g.chip.remove();
        this.ghosts.delete(runId);
      }
    }
    for (const runId of wantGhost) {
      if (this.ghosts.has(runId)) continue;
      const t = this.feed.store.get(runId);
      const pad = new PIXI.Graphics();
      pad.beginFill(0x0f172a, 0.75);
      pad.lineStyle(1.5, 0x94a3b8, 0.8);
      pad.drawPolygon([0, -9, 18, 0, 0, 9, -18, 0]);
      pad.endFill();
      pad.beginFill(0x94a3b8, 0.9);
      pad.lineStyle(0);
      pad.drawCircle(0, -14, 4);
      pad.drawRoundedRect(-5, -10, 10, 9, 3);
      pad.endFill();
      this.fxLayer.addChildAt(pad, 0);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rm-ghost rm-abs";
      chip.title = `${t?.summary.label ?? runId}: worker waiting on the review queue. Open the review`;
      chip.setAttribute("aria-label", `Open review: ${truncate(t?.summary.label || runId, 60)}`);
      chip.addEventListener("click", () => this.opts.onOpenThread(runId));
      this.root.appendChild(chip);
      this.ghosts.set(runId, { runId, pad, chip, x: 0, y: 0, lastX: NaN, lastY: NaN });
    }
    const pend = pending.length;
    this.tagBadge.textContent = pend ? String(pend) : "";
    this.tagBadge.classList.toggle("on", pend > 0);
  }

  private positionMarkers(zoom: number, ox: number, oy: number): void {
    const showChips = zoom >= 0.3;
    const chipScale = Math.min(1.1, Math.max(0.75, zoom * 1.2));
    if (this.frame % 5 === 0) {
      for (const m of this.markers.values()) {
        const t = this.feed.store.get(m.runId);
        this.workerWorld(m.runId, t?.summary.workerAgent ?? "", this.scratch);
        m.x = this.scratch.x;
        m.y = this.scratch.y;
      }
      for (const g of this.ghosts.values()) {
        this.fallbackAnchor(g.runId, this.scratch);
        g.x = this.scratch.x;
        g.y = this.scratch.y;
      }
    }
    const pulse = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.now / 380);
    for (const m of this.markers.values()) {
      m.ring.position.set(m.x, m.y);
      m.ring.scale.set(0.9 + pulse * 0.25);
      m.ring.alpha = 0.55 + pulse * 0.45;
      // Clamp so the chip (~110px wide) stays inside the map edges.
      const sx = Math.min(Math.max(ox + m.x * zoom, 62), this.host.clientWidth - 62);
      const sy = oy + (m.y - 46) * zoom;
      m.chip.style.display = showChips ? "" : "none";
      if (showChips && (moved(sx, m.lastX, 0.5) || moved(sy, m.lastY, 0.5))) {
        m.lastX = sx;
        m.lastY = sy;
        m.chip.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%) scale(${chipScale.toFixed(2)})`;
      }
    }
    for (const g of this.ghosts.values()) {
      g.pad.position.set(g.x, g.y);
      const sx = ox + g.x * zoom;
      const sy = oy + (g.y - 6) * zoom;
      const show = showChips;
      g.chip.style.display = show ? "" : "none";
      if (show && (moved(sx, g.lastX, 0.5) || moved(sy, g.lastY, 0.5))) {
        g.lastX = sx;
        g.lastY = sy;
        g.chip.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-50%)`;
      }
    }
  }

  // ── Completion halos (recently finished agents linger, colour = verdict) ──

  private syncHalos(): void {
    const now = Date.now();
    const want = new Map<string, { key: string; finishedAt: number; tone: number }>();
    for (const r of this.feed.completed) {
      if (want.size >= 16) break;
      if (!r?.runId || !isTerminalState(r.state)) continue;
      const finishedAt = Number(r.terminalAt || r.updatedAt || 0);
      if (!finishedAt || haloAlpha(finishedAt, now) <= 0) continue;
      const key = r.childSessionKey || "";
      const onMap = (key && this.engine.hasAgent(key)) || this.engine.findAgentKeyByRunId(r.runId);
      if (!onMap && !this.ghosts.has(r.runId)) continue;
      want.set(r.runId, { key, finishedAt, tone: TONE_HEX[VERDICT_TONE[completedVerdictOf(r)]] });
    }
    for (const [runId, h] of this.halos) {
      if (!want.has(runId)) {
        h.g.destroy();
        this.halos.delete(runId);
      }
    }
    for (const [runId, w] of want) {
      let h = this.halos.get(runId);
      if (!h) {
        const g = new PIXI.Graphics();
        g.beginFill(0xffffff, 0.16);
        g.drawEllipse(0, 0, 30, 15);
        g.endFill();
        g.lineStyle(2.5, 0xffffff, 0.9);
        g.drawEllipse(0, 0, 30, 15);
        g.lineStyle(1, 0xffffff, 0.45);
        g.drawEllipse(0, 0, 40, 20);
        this.fxLayer.addChildAt(g, 0);
        h = { runId, key: w.key, g, finishedAt: w.finishedAt, x: 0, y: 0 };
        this.halos.set(runId, h);
      }
      h.g.tint = w.tone;
      h.finishedAt = w.finishedAt;
    }
  }

  private updateHalos(): void {
    if (!this.halos.size) return;
    const now = Date.now();
    const breathe = this.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.now / 900);
    for (const h of this.halos.values()) {
      if (this.frame % 5 === 0 || (h.x === 0 && h.y === 0)) {
        this.workerWorld(h.runId, h.key, this.scratch);
        h.x = this.scratch.x;
        h.y = this.scratch.y;
      }
      const a = haloAlpha(h.finishedAt, now);
      h.g.position.set(h.x, h.y + 4);
      h.g.alpha = a * (0.55 + 0.45 * breathe);
      h.g.scale.set(1 + 0.08 * breathe);
    }
  }

  /** Fly the camera to a run's worker (sprite, else its review-queue pad). */
  flyToRun(runId: string, sessionKey?: string): void {
    this.workerWorld(runId, sessionKey ?? "", this.scratch);
    this.engine.cameraFlyTo(this.scratch.x, this.scratch.y, Math.max(0.9, this.engine.getZoom()), 700);
  }

  // ── Screenshot orbit ──────────────────────────────────────────────────

  private syncThumbs(): void {
    const shots = this.feed.screenshots;
    let n = Math.min(this.lod.maxThumbs, shots.length);
    if (this.mobile) {
      const w = 92 * Math.min(1.15, Math.max(0.55, this.engine.getZoom() * 1.25)) + 8;
      n = Math.min(n, Math.max(1, Math.floor((this.host.clientWidth - 16) / w)));
    }
    this.visibleThumbs = n;
    this.shotsCount.textContent = shots.length ? `Screenshots · ${this.feed.screenshotsTotal || shots.length}` : "Screenshots";
    while (this.thumbs.length < n) this.thumbs.push(this.makeThumb());
    for (let i = 0; i < this.thumbs.length; i++) {
      const th = this.thumbs[i];
      const shot: ScreenshotEntry | undefined = i < n ? shots[i] : undefined;
      if (!shot) {
        th.el.style.display = "none";
        th.shotId = "";
        continue;
      }
      th.el.style.display = "";
      if (th.shotId !== shot.id) {
        th.shotId = shot.id;
        const src = gatewayUrl(shot.thumbUrl);
        if (th.img.getAttribute("src") !== src) th.img.src = src;
        const border = shot.verdict === "pass" ? TONE_CSS.green : shot.verdict === "fail" ? TONE_CSS.red : TONE_CSS.slate;
        th.el.style.setProperty("--rm-border", border);
        const bits = [shot.route, shot.viewport, shot.theme].filter(Boolean).join(" · ");
        th.tag.innerHTML = "";
        const b = document.createElement("b");
        b.textContent = truncate(shot.label || shot.runId, 18);
        th.tag.append(b, document.createTextNode(bits ? ` ${bits}` : ""));
        th.el.title = `${shot.label} — ${bits}${shot.verdict !== "unknown" ? ` — ${shot.verdict}` : ""}`;
        th.el.setAttribute("aria-label", `Screenshot: ${shot.label} ${bits} ${shot.verdict}`);
        th.lastX = NaN;
      }
    }
  }

  private makeThumb(): Thumb {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "rm-thumb";
    el.setAttribute("data-review-thumb", "");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    const tag = document.createElement("span");
    tag.className = "rm-thumb__tag";
    el.append(img, tag);
    const th: Thumb = { el, img, tag, shotId: "", lastX: NaN, lastY: NaN, lastS: NaN };
    el.addEventListener("click", () => this.opts.onOpenGallery(th.shotId || undefined));
    this.root.appendChild(el);
    return th;
  }

  private positionThumbs(zoom: number, ox: number, oy: number): void {
    const c = this.engine.getExecutiveCenter();
    const s = Math.min(1.15, Math.max(0.55, zoom * 1.25));
    // Thumbnail box in screen px (92 x ~70 at scale 1). The ring radius is the
    // larger of the island-relative orbit and the spacing that keeps
    // neighbours apart (step = pi*0.96/7 rad between slots on a ring).
    const w = 92 * s;
    const h = 70 * s;
    const squash = 0.62;
    const radius = Math.max(260 * zoom, (w + 12) / 0.42, (h + 10) / (0.43 * squash));
    // Outer ring clears the inner one vertically (top) and horizontally (sides).
    const outer = radius + Math.max(w + 16, (h + 14) / squash);
    // Desktop: centre above the island's EXECUTIVE SUITE sign so the arc never
    // covers it. Phones: the HUD owns the top, so a row hangs below the island,
    // centred on screen so all of it fits the width.
    const below = this.mobile;
    const cx = below ? this.host.clientWidth / 2 : ox + c.x * zoom;
    // Phones: start below the Screenshots button (auditor.y + 26 world, ~24px tall).
    const cy = below ? oy + (c.y + AUDITOR_OFFSET.y + 26) * zoom + 30 : oy + (c.y - 118) * zoom - 18;
    const drift = this.reducedMotion ? 0 : this.now / 2600;
    for (let i = 0; i < this.thumbs.length; i++) {
      const th = this.thumbs[i];
      if (!th.shotId) continue;
      const slot = this.thumbSlots[i];
      if (!slot) continue;
      const bob = this.reducedMotion ? 0 : Math.sin(drift + i * 1.3) * 4;
      let sx: number;
      let sy: number;
      if (below) {
        // Phones: one straight row under the island (fits the width, clears the toolbar).
        const n = this.visibleThumbs;
        sx = cx + (i - (n - 1) / 2) * (w + 8);
        sy = cy + h / 2 + bob;
      } else {
        const r = i < 6 ? radius : outer;
        sx = cx + slot.x * r;
        sy = cy + slot.y * r * squash + bob;
      }
      if (moved(sx, th.lastX, 0.4) || moved(sy, th.lastY, 0.4) || s !== th.lastS) {
        th.lastX = sx;
        th.lastY = sy;
        th.lastS = s;
        th.el.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-50%) scale(${s.toFixed(3)})`;
      }
    }
  }

  // ── Auditor tag + Screenshots button ──────────────────────────────────

  private positionChrome(zoom: number, ox: number, oy: number): void {
    const aw = this.auditorWorld;
    const sx = ox + aw.x * zoom;
    const sy = oy + (aw.y - 84) * zoom;
    const s = Math.min(1.1, Math.max(0.8, zoom * 1.3));
    if (Math.abs(sx - this.lastTag.x) < 0.4 && Math.abs(sy - this.lastTag.y) < 0.4 && s === this.lastTag.s) return;
    this.lastTag.x = sx;
    this.lastTag.y = sy;
    this.lastTag.s = s;
    this.tagEl.style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(-50%,-100%) scale(${s.toFixed(3)})`;
    const by = oy + (aw.y + 26) * zoom;
    this.shotsBtn.style.transform = `translate(${sx.toFixed(1)}px,${by.toFixed(1)}px) translate(-50%,0) scale(${s.toFixed(3)})`;
  }

  // ── Speech bubble ─────────────────────────────────────────────────────

  private setBubble(kind: string, text: string, tone: PacketTone): void {
    this.bubbleKind.textContent = kind;
    this.bubbleText.textContent = truncate(text, 110);
    this.bubble.style.setProperty("--rm-tone", TONE_CSS[tone]);
    this.bubble.classList.add("on");
    this.bubbleW = 0; // re-measured on the next frame
  }

  private showPacketBubble(p: Packet, ms: number): void {
    if (!p.msg) return;
    const kind = p.msg.kind === "verdict" && p.msg.verdict ? `Verdict · ${p.msg.verdict === "VERIFIED" ? "Verified" : p.msg.verdict.replace("_", " ")}` : p.msg.kind;
    this.setBubble(kind, p.msg.title, p.tone);
    this.bubbleFollow = p;
    this.bubbleAtAuditor = false;
    this.bubbleUntil = this.now + ms;
  }

  private showActionBubble(msg: ReviewMessage): void {
    this.setBubble("Auditor action", msg.title, "violet");
    this.bubbleFollow = null;
    this.bubbleAtAuditor = true;
    this.bubbleUntil = this.now + 2200;
  }

  private showAuditorBubble(): void {
    const latest = this.feed.store.list()[0];
    const last = latest?.messages[latest.messages.length - 1];
    if (last) this.setBubble(`Latest · ${latest.summary.label}`, last.title, packetTone(last));
    else this.setBubble("Auditor", "Verification reviewer. Workers submit results here; I challenge, re-check and give the verdict.", "gold");
    this.bubbleFollow = null;
    this.bubbleAtAuditor = true;
    this.bubbleUntil = this.now + 1e9;
  }

  private hideBubbleSoon(): void {
    this.bubbleUntil = Math.min(this.bubbleUntil, this.now + 250);
  }

  private updateBubble(zoom: number, ox: number, oy: number): void {
    if (!this.bubble.classList.contains("on")) return;
    if (this.now > this.bubbleUntil) {
      this.bubble.classList.remove("on");
      this.bubbleFollow = null;
      return;
    }
    let wx: number;
    let wy: number;
    let lift = 0;
    const f = this.hoverPacket ?? this.bubbleFollow;
    if (f && f.active) {
      wx = f.pos.x;
      wy = f.pos.y - 16;
    } else if (this.bubbleAtAuditor || !f) {
      // Beside the Auditor (right of the shield) so it never hides the island sign.
      wx = this.auditorWorld.x + 26;
      wy = this.auditorWorld.y - 40;
      lift = -1;
    } else {
      return;
    }
    let sx = ox + wx * zoom;
    const sy = oy + wy * zoom;
    // Keep the bubble inside the map horizontally.
    if (!this.bubbleW) this.bubbleW = this.bubble.offsetWidth || 200;
    const hw = this.host.clientWidth;
    if (lift < 0) sx = Math.min(sx, hw - this.bubbleW - 8);
    else sx = Math.min(Math.max(sx, this.bubbleW / 2 + 8), hw - this.bubbleW / 2 - 8);
    // lift < 0: side-anchored (left edge at the point, vertically centred).
    this.bubble.style.transform =
      lift < 0
        ? `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) translate(0,-50%)`
        : `translate(${sx.toFixed(1)}px,${(sy - lift).toFixed(1)}px) translate(-50%,-100%)`;
  }
}
