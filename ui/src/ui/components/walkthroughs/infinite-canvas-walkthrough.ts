/**
 * <infinite-canvas-walkthrough-overlay> — pan/zoom Holo-Canvas presenter.
 *
 * Recreates the InfiniBot Holo-Canvas experience (see
 * skills/infinite-canvas-walkthrough) inside the proactive overlay system:
 *
 *   • 4-layer void background (radial · grid · stars · vignette) — NOT flattened
 *   • a large pan/zoom "world" (default 9600×6400) of glass nodes wired by
 *     glowing animated SVG connectors
 *   • a timeline of `scenes` that fly the camera to a focused node and play that
 *     scene's OWN baked narration audio (scene-owned, separate from the voice
 *     orchestrator reply path) while a beat-locked animation track reveals /
 *     highlights nodes in sync with the audio clock
 *   • full pan (drag) · zoom (wheel / pinch) · click-a-node-to-jump-to-its-scene
 *   • responsive: below 720px the world collapses to a single-column scene-card
 *     reader (same narration + controls); reduced-motion guard skips tweens
 *
 * Mounted by <proactive-overlay-host> as its OWN full-viewport surface (like the
 * narrated <walkthrough-overlay>), so it owns the screen rather than living
 * inside the draggable <proactive-presenter> card.
 *
 * Design language: strict black/gold glassmorphism. Gold on borders / accents
 * only, never as a fill.
 */

import { LitElement, html, css, svg, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  InfiniteCanvasWalkthroughMedia,
  CanvasNode,
  CanvasLink,
  CanvasScene,
  CanvasBeat,
  CanvasBgLayer,
  PopupInteract,
} from "../proactive-popup-shared.js";
import {
  registerOverlay,
  unregisterOverlay,
  type InteractiveOverlay,
} from "../proactive-media/interactive-registry.js";
import { prefersReducedMotion, slideGlow, pulse } from "../proactive-media/animations.js";

const DEFAULT_WORLD = { w: 9600, h: 6400 };
const MIN_SCALE = 0.12;
const MAX_SCALE = 2.4;
const FLY_MS = 900;
const DEFAULT_FOCUS_ZOOM = 0.72;
const DEFAULT_SCENE_MS = 6000;
const MOBILE_BREAKPOINT = 720;
const ALL_BG_LAYERS: CanvasBgLayer[] = ["radial", "grid", "stars", "vignette"];

interface Camera {
  x: number;
  y: number;
  s: number;
}

@customElement("infinite-canvas-walkthrough-overlay")
export class InfiniteCanvasWalkthroughOverlay
  extends LitElement
  implements InteractiveOverlay
{
  @property({ attribute: false }) payload: InfiniteCanvasWalkthroughMedia | null = null;
  @property({ type: String }) eventId = "";

  @state() private index = 0;
  @state() private paused = false;
  @state() private zoomLabel = 100;
  @state() private caption = "";
  @state() private isMobile = false;

  private cam: Camera = { x: 0, y: 0, s: 1 };
  private audio: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private rafTween: number | null = null;
  private beatRaf: number | null = null;
  private beatCursor = 0;
  private firedReveal = new Set<string>();

  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private resizeHandler = () => this.onResize();
  private visibilityHandler = () => this.onVisibilityChange();
  private reduced = false;

  // cached user TTS voice settings (so we don't re-fetch every scene)

  // live-doc debounce timer
  private _liveDocSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // pan / pinch bookkeeping
  private dragging = false;
  private moved = 0;
  private lastX = 0;
  private lastY = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchPrev: number | null = null;

  // ── lifecycle ──────────────────────────────────────────────────────────────
  connectedCallback(): void {
    super.connectedCallback();
    this.reduced = prefersReducedMotion();
    if (this.eventId) registerOverlay(this);
    window.addEventListener("keydown", this.keyHandler);
    window.addEventListener("resize", this.resizeHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.onResize();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.eventId) unregisterOverlay(this);
    window.removeEventListener("keydown", this.keyHandler);
    window.removeEventListener("resize", this.resizeHandler);
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.stopAudio();
    this.clearHoldTimer();
    this.stopTween();
    this.stopBeatLoop();
  }

  protected firstUpdated(): void {
    // Initial camera: frame the first scene's focus, then start playback.
    requestAnimationFrame(() => {
      this.drawLinks();
      this.enterScene(this.index, /*instant*/ true);
    });
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("index")) this.enterScene(this.index, false);
  }

  private onResize(): void {
    const mobile = window.innerWidth < MOBILE_BREAKPOINT;
    if (mobile !== this.isMobile) this.isMobile = mobile;
  }

  /** True when this tab is backgrounded/hidden — used to avoid overlapping audio across tabs. */
  private get tabHidden(): boolean {
    return document.hidden || document.visibilityState === "hidden";
  }

  /** Pause narration when the tab is hidden so only the focused/visible tab plays audio. */
  private onVisibilityChange(): void {
    if (this.tabHidden) {
      if (this.audio) {
        try {
          this.audio.pause();
        } catch {
          /* ignore */
        }
      }
    } else if (!this.paused && this.audio) {
      void this.audio.play().catch(() => undefined);
    }
  }

  // ── data helpers ─────────────────────────────────────────────────────────
  private get world() {
    return this.payload?.world ?? DEFAULT_WORLD;
  }
  private get nodes(): CanvasNode[] {
    return this.payload?.nodes ?? [];
  }
  private get links(): Array<[string, string]> {
    return (this.payload?.links ?? []).map((l): [string, string] =>
      Array.isArray(l) ? [l[0], l[1]] : [l.from, l.to],
    );
  }
  private get scenes(): CanvasScene[] {
    return this.payload?.scenes ?? [];
  }
  private get current(): CanvasScene | null {
    return this.scenes[this.index] ?? null;
  }
  private get bgLayers(): CanvasBgLayer[] {
    return this.payload?.bgLayers ?? ALL_BG_LAYERS;
  }

  private nodeEl(id: string): HTMLElement | null {
    return this.renderRoot.querySelector<HTMLElement>(`#n-${cssId(id)}`);
  }

  // ── scene entry: camera + narration + beats ────────────────────────────────
  private enterScene(i: number, instant: boolean): void {
    const scene = this.scenes[i];
    if (!scene) return;
    this.caption = "";
    this.firedReveal.clear();
    this.stopBeatLoop();
    this.clearFocusGlow();

    // 1) camera move
    if (!this.isMobile) this.flyToScene(scene, instant);

    // 2) spotlight the focused node
    const focusId = scene.focusNodeId;
    if (focusId) {
      const el = this.nodeEl(focusId);
      if (el) {
        el.classList.add("focus-glow");
        if (!this.reduced) slideGlow(el, { durationMs: 460 });
      }
    }

    // 3) If this scene's focus node is a live-doc, suppress narration TTS (captions only).
    const focusNode = focusId ? this.nodes.find((n) => n.id === focusId) : null;
    if (focusNode?.kind === "live-doc") {
      const nar = scene.narration;
      if (nar?.captionMd) this.caption = nar.captionMd;
      if (focusNode.liveDocActive !== false) {
        requestAnimationFrame(() => {
          const ta = this.renderRoot.querySelector<HTMLTextAreaElement>(".icw-livedoc-editor");
          ta?.focus();
        });
      }
      return; // skip playNarration
    }

    // 4) narration + beats (beats lock to the audio clock)
    void this.playNarration(scene);
  }

  private flyToScene(scene: CanvasScene, instant: boolean): void {
    if (scene.cameraTarget) {
      this.flyTo(
        scene.cameraTarget.x,
        scene.cameraTarget.y,
        scene.cameraTarget.zoom ?? DEFAULT_FOCUS_ZOOM,
        instant,
      );
      return;
    }
    if (scene.focusNodeId) {
      const c = this.nodeCenter(scene.focusNodeId);
      if (c) {
        this.flyTo(c.x, c.y, DEFAULT_FOCUS_ZOOM, instant);
        return;
      }
    }
    // No focus → fit everything.
    this.fitAll(instant);
  }

  // ── narration playback ──────────────────────────────────────────────────────
  private async playNarration(scene: CanvasScene): Promise<void> {
    this.stopAudio();
    this.clearHoldTimer();
    const nar = scene.narration;
    if (nar?.captionMd) this.caption = nar.captionMd;

    const autoAdvance = this.payload?.autoAdvance !== false;

    // No baked narration audio → captions only: hold for durationMs then
    // advance. (Voice runs on Robovoice; there is no local text-to-speech to
    // live-synthesize `ttsText`.)
    if (!nar || !nar.audioUrl) {
      this.startBeatLoop(scene, null);
      if (autoAdvance && !this.paused)
        this.scheduleHoldAdvance(scene.durationMs ?? DEFAULT_SCENE_MS);
      return;
    }

    if (this.paused) return;

    // Only the focused/visible tab should play narration audio — otherwise every
    // tab with the proactive overlay host echoes the same scene. Still run the
    // beat track + auto-advance so hidden tabs stay in sync visually.
    if (this.tabHidden) {
      this.startBeatLoop(scene, null);
      if (autoAdvance && !this.paused)
        this.scheduleHoldAdvance(scene.durationMs ?? DEFAULT_SCENE_MS);
      return;
    }

    try {
      const src = nar.audioUrl ?? null;
      if (!src) throw new Error("no audio source");

      const audio = new Audio(src);
      this.audio = audio;
      audio.addEventListener("play", () => this.startBeatLoop(scene, audio));
      audio.addEventListener("ended", () => {
        this.cleanupAudioUrl();
        if (this.audio === audio) this.audio = null;
        this.stopBeatLoop();
        window.dispatchEvent(new CustomEvent("infinibot:voice-duck-end", {
          detail: { sourceId: this.eventId, eventId: this.eventId },
        }));
        if (autoAdvance && !this.paused)
          this.scheduleHoldAdvance(scene.durationMs ? 200 : 400);
      });
      audio.addEventListener("error", () => {
        this.cleanupAudioUrl();
        if (this.audio === audio) this.audio = null;
        window.dispatchEvent(new CustomEvent("infinibot:voice-duck-end", {
          detail: { sourceId: this.eventId, eventId: this.eventId },
        }));
        // Audio failed to decode → still run beats on a wall-clock and advance.
        this.startBeatLoop(scene, null);
        if (autoAdvance && !this.paused)
          this.scheduleHoldAdvance(scene.durationMs ?? DEFAULT_SCENE_MS);
      });
      await audio.play().catch(() => {
        // Autoplay blocked — keep overlay up; user can press play / next.
        this.startBeatLoop(scene, null);
      });
      // Duck voice input while narration is playing.
      window.dispatchEvent(new CustomEvent("infinibot:voice-duck-start", {
        detail: { sourceId: this.eventId, eventId: this.eventId },
      }));
    } catch {
      // TTS unavailable — run beats on wall-clock and flow on a timed hold.
      this.startBeatLoop(scene, null);
      if (autoAdvance && !this.paused)
        this.scheduleHoldAdvance(scene.durationMs ?? DEFAULT_SCENE_MS);
    }
  }

  private stopAudio(): void {
    if (this.audio) {
      try {
        this.audio.pause();
      } catch {
        /* ignore */
      }
      this.audio = null;
      window.dispatchEvent(new CustomEvent("infinibot:voice-duck-end", {
        detail: { sourceId: this.eventId, eventId: this.eventId },
      }));
    }
    this.cleanupAudioUrl();
  }
  private cleanupAudioUrl(): void {
    if (this.audioObjectUrl) {
      try {
        URL.revokeObjectURL(this.audioObjectUrl);
      } catch {
        /* ignore */
      }
      this.audioObjectUrl = null;
    }
  }

  // ── beat track (locked to audio.currentTime when present) ────────────────────
  private startBeatLoop(scene: CanvasScene, audio: HTMLAudioElement | null): void {
    this.stopBeatLoop();
    const beats = (scene.beats ?? []).slice().sort((a, b) => a.atMs - b.atMs);
    if (beats.length === 0) return;
    this.beatCursor = 0;
    const startWall = performance.now();
    const tick = () => {
      const tMs = audio && !audio.paused ? audio.currentTime * 1000 : performance.now() - startWall;
      while (this.beatCursor < beats.length && beats[this.beatCursor].atMs <= tMs) {
        this.fireBeat(beats[this.beatCursor]);
        this.beatCursor++;
      }
      if (this.beatCursor < beats.length) this.beatRaf = requestAnimationFrame(tick);
      else this.beatRaf = null;
    };
    this.beatRaf = requestAnimationFrame(tick);
  }
  private stopBeatLoop(): void {
    if (this.beatRaf != null) {
      cancelAnimationFrame(this.beatRaf);
      this.beatRaf = null;
    }
  }

  private fireBeat(beat: CanvasBeat): void {
    const el = beat.target ? this.nodeEl(beat.target) : null;
    switch (beat.op) {
      case "highlight":
        if (el) {
          this.clearFocusGlow();
          el.classList.add("focus-glow");
          if (!this.reduced) pulse(el, { count: 2 });
        }
        break;
      case "reveal":
        if (el && beat.target && !this.firedReveal.has(beat.target)) {
          this.firedReveal.add(beat.target);
          el.classList.add("revealed");
          if (!this.reduced) slideGlow(el, { durationMs: 520 });
        }
        break;
      case "animate":
        if (el && !this.reduced) pulse(el, { count: 1 });
        break;
      case "pan":
        if (beat.target) {
          const c = this.nodeCenter(beat.target);
          if (c) this.flyTo(c.x, c.y, this.cam.s, false);
        }
        break;
      case "zoom": {
        const z = typeof beat.params?.zoom === "number" ? (beat.params.zoom as number) : this.cam.s;
        const center = this.screenCenterWorld();
        this.flyTo(center.x, center.y, z, false);
        break;
      }
    }
  }

  // ── camera engine ────────────────────────────────────────────────────────────
  private applyCam(): void {
    const world = this.renderRoot.querySelector<HTMLElement>(".icw-world");
    if (world) world.style.transform = `translate(${this.cam.x}px, ${this.cam.y}px) scale(${this.cam.s})`;
    this.zoomLabel = Math.round(this.cam.s * 100);
  }
  private clampScale(s: number): number {
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
  }
  private viewportSize(): { w: number; h: number } {
    const vp = this.renderRoot.querySelector<HTMLElement>(".icw-viewport");
    return { w: vp?.clientWidth || window.innerWidth, h: vp?.clientHeight || window.innerHeight };
  }
  private screenCenterWorld(): { x: number; y: number } {
    const { w, h } = this.viewportSize();
    return { x: (w / 2 - this.cam.x) / this.cam.s, y: (h / 2 - this.cam.y) / this.cam.s };
  }
  private nodeCenter(id: string): { x: number; y: number } | null {
    const el = this.nodeEl(id);
    if (el)
      return {
        x: el.offsetLeft + el.offsetWidth / 2,
        y: el.offsetTop + el.offsetHeight / 2,
      };
    // Fall back to declared geometry if the element isn't measured yet.
    const n = this.nodes.find((x) => x.id === id);
    if (n) return { x: n.x + n.w / 2, y: n.y + 120 };
    return null;
  }

  private flyTo(wx: number, wy: number, s: number, instant = false): void {
    this.stopTween();
    s = this.clampScale(s);
    const { w, h } = this.viewportSize();
    const tx = w / 2 - wx * s;
    const ty = h / 2 - wy * s;
    if (instant || this.reduced) {
      this.cam = { x: tx, y: ty, s };
      this.applyCam();
      return;
    }
    const sx = this.cam.x;
    const sy = this.cam.y;
    const ss = this.cam.s;
    let t0: number | null = null;
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (ts: number) => {
      if (t0 === null) t0 = ts;
      const k = Math.min(1, (ts - t0) / FLY_MS);
      const e = ease(k);
      this.cam = { x: sx + (tx - sx) * e, y: sy + (ty - sy) * e, s: ss + (s - ss) * e };
      this.applyCam();
      if (k < 1) this.rafTween = requestAnimationFrame(step);
      else this.rafTween = null;
    };
    this.rafTween = requestAnimationFrame(step);
  }
  private stopTween(): void {
    if (this.rafTween != null) {
      cancelAnimationFrame(this.rafTween);
      this.rafTween = null;
    }
  }
  private fitAll(instant = false): void {
    const nodes = this.nodes;
    if (nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const el = this.nodeEl(n.id);
      const l = el?.offsetLeft ?? n.x;
      const t = el?.offsetTop ?? n.y;
      const w = el?.offsetWidth ?? n.w;
      const hgt = el?.offsetHeight ?? 240;
      minX = Math.min(minX, l);
      minY = Math.min(minY, t);
      maxX = Math.max(maxX, l + w);
      maxY = Math.max(maxY, t + hgt);
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    const { w, h } = this.viewportSize();
    const s = this.clampScale(Math.min(w / (bw + 320), h / (bh + 320)));
    this.flyTo((minX + maxX) / 2, (minY + maxY) / 2, s, instant);
  }

  // ── pan / zoom input ───────────────────────────────────────────────────────
  private onPointerDown = (e: PointerEvent): void => {
    const target = e.target as HTMLElement;
    if (target.closest(".icw-hud")) return;
    this.stopTween();
    this.dragging = true;
    this.moved = 0;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  private onPointerMove = (e: PointerEvent): void => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size >= 2) {
      this.pinch();
      return;
    }
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.cam = { ...this.cam, x: this.cam.x + dx, y: this.cam.y + dy };
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.applyCam();
  };
  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchPrev = null;
    this.dragging = false;
  };
  private pinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const cx = (pts[0].x + pts[1].x) / 2;
    const cy = (pts[0].y + pts[1].y) / 2;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (this.pinchPrev) {
      const vp = this.renderRoot.querySelector<HTMLElement>(".icw-viewport");
      const rect = vp?.getBoundingClientRect();
      const px = cx - (rect?.left ?? 0);
      const py = cy - (rect?.top ?? 0);
      const wx = (px - this.cam.x) / this.cam.s;
      const wy = (py - this.cam.y) / this.cam.s;
      const ns = this.clampScale(this.cam.s * (dist / this.pinchPrev));
      this.cam = { x: px - wx * ns, y: py - wy * ns, s: ns };
      this.applyCam();
    }
    this.pinchPrev = dist;
  }
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.stopTween();
    const vp = this.renderRoot.querySelector<HTMLElement>(".icw-viewport");
    const rect = vp?.getBoundingClientRect();
    const px = e.clientX - (rect?.left ?? 0);
    const py = e.clientY - (rect?.top ?? 0);
    const wx = (px - this.cam.x) / this.cam.s;
    const wy = (py - this.cam.y) / this.cam.s;
    const factor = Math.exp(-e.deltaY * 0.0014);
    const ns = this.clampScale(this.cam.s * factor);
    this.cam = { x: px - wx * ns, y: py - wy * ns, s: ns };
    this.applyCam();
  };
  private zoomBy(mult: number): void {
    const c = this.screenCenterWorld();
    this.flyTo(c.x, c.y, this.cam.s * mult, false);
  }

  private onNodeClick(node: CanvasNode): void {
    if (this.moved > 6) return; // it was a drag, not a tap
    const sceneIdx = this.scenes.findIndex((s) => s.focusNodeId === node.id);
    if (sceneIdx >= 0 && sceneIdx !== this.index) this.index = sceneIdx;
    else {
      const c = this.nodeCenter(node.id);
      if (c) this.flyTo(c.x, c.y, Math.max(this.cam.s, DEFAULT_FOCUS_ZOOM), false);
    }
  }

  // ── interactive-registry contract (agent live control) ──────────────────────
  applyInteract(interact: PopupInteract): boolean {
    switch (interact.op) {
      case "next":
      case "scene.next":
        this.next();
        return true;
      case "prev":
      case "scene.prev":
        this.prev();
        return true;
      case "scene.goto": {
        const i = interact.index ?? 0;
        if (i < 0 || i >= this.scenes.length) return false;
        this.index = i;
        return true;
      }
      case "revealAll":
        this.fitAll(false);
        return true;
      case "timeline.pause":
        if (!this.paused) this.togglePause();
        return true;
      case "timeline.play":
        if (this.paused) this.togglePause();
        return true;
      case "element.cue":
      case "highlight": {
        const el = interact.elementId ? this.nodeEl(interact.elementId) : null;
        if (el) {
          this.clearFocusGlow();
          el.classList.add("focus-glow");
          if (!this.reduced) pulse(el, { count: 2 });
          const c = this.nodeCenter(interact.elementId!);
          if (c) this.flyTo(c.x, c.y, Math.max(this.cam.s, DEFAULT_FOCUS_ZOOM), false);
        }
        return !!el;
      }
      case "dismiss":
        this.dispatchDismiss();
        return true;
      default:
        return false;
    }
  }

  // ── navigation ───────────────────────────────────────────────────────────────
  private next(): void {
    if (this.index >= this.scenes.length - 1) {
      this.dispatchDismiss();
      return;
    }
    this.index = this.index + 1;
  }
  private prev(): void {
    if (this.index <= 0) return;
    this.index = this.index - 1;
  }
  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      if (this.audio) {
        try {
          this.audio.pause();
        } catch {
          /* ignore */
        }
      }
      this.clearHoldTimer();
      this.stopBeatLoop();
    } else {
      const scene = this.current;
      if (this.audio) {
        void this.audio.play().catch(() => undefined);
        if (scene) this.startBeatLoop(scene, this.audio);
      } else if (scene) {
        void this.playNarration(scene);
      }
    }
  }

  private scheduleHoldAdvance(ms: number): void {
    this.clearHoldTimer();
    if (this.paused) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.next();
    }, Math.max(0, ms));
  }
  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  private clearFocusGlow(): void {
    this.renderRoot
      .querySelectorAll(".icw-node.focus-glow")
      .forEach((e) => e.classList.remove("focus-glow"));
  }

  private dispatchDismiss(): void {
    // Ensure duck is released when the overlay is closed.
    window.dispatchEvent(new CustomEvent("infinibot:voice-duck-end", {
      detail: { sourceId: this.eventId, eventId: this.eventId },
    }));
    this.dispatchEvent(
      new CustomEvent("pmedia-dismiss", {
        bubbles: true,
        composed: true,
        detail: { eventId: this.eventId },
      }),
    );
  }
  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.prev();
    } else if (e.key === " ") {
      e.preventDefault();
      this.togglePause();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.dispatchDismiss();
    }
  }

  // ── SVG link layer ───────────────────────────────────────────────────────────
  /** Build curved connector paths between node centers (measured post-paint). */
  private drawLinks(): void {
    const g = this.renderRoot.querySelector<SVGGElement>("#icw-link-paths");
    if (!g) return;
    while (g.firstChild) g.removeChild(g.firstChild);
    const NS = "http://www.w3.org/2000/svg";
    for (const [a, b] of this.links) {
      const A = this.nodeCenter(a);
      const B = this.nodeCenter(b);
      if (!A || !B) continue;
      const mx = (A.x + B.x) / 2;
      const my = (A.y + B.y) / 2;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = Math.min(140, len * 0.18);
      const cx = mx - (dy / len) * off;
      const cy = my + (dx / len) * off;
      const d = `M ${A.x} ${A.y} Q ${cx} ${cy} ${B.x} ${B.y}`;

      const base = document.createElementNS(NS, "path");
      base.setAttribute("d", d);
      base.setAttribute("fill", "none");
      base.setAttribute("stroke", "url(#icw-lg)");
      base.setAttribute("stroke-width", "2");
      base.setAttribute("stroke-linecap", "round");
      base.setAttribute("opacity", "0.85");
      g.appendChild(base);

      if (!this.reduced) {
        const flow = document.createElementNS(NS, "path");
        flow.setAttribute("d", d);
        flow.setAttribute("fill", "none");
        flow.setAttribute("stroke", "#f4d77a");
        flow.setAttribute("stroke-width", "1");
        flow.setAttribute("stroke-dasharray", "2 14");
        flow.setAttribute("opacity", "0.5");
        const an = document.createElementNS(NS, "animate");
        an.setAttribute("attributeName", "stroke-dashoffset");
        an.setAttribute("from", "0");
        an.setAttribute("to", "-160");
        an.setAttribute("dur", "4s");
        an.setAttribute("repeatCount", "indefinite");
        flow.appendChild(an);
        g.appendChild(flow);
      }
    }
  }

  // ── render ───────────────────────────────────────────────────────────────────
  render() {
    if (!this.payload || this.nodes.length === 0) return nothing;
    if (this.isMobile) return this.renderMobile();

    const world = this.world;
    const title = this.payload.title || "Holo-Canvas Walkthrough";
    const total = this.scenes.length;
    return html`
      <div class="icw-backdrop" role="dialog" aria-modal="true" aria-label=${title}>
        ${this.renderBg()}
        <div
          class="icw-viewport"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
          @wheel=${this.onWheel}
        >
          <div class="icw-world" style=${`width:${world.w}px;height:${world.h}px`}>
            <svg
              class="icw-links"
              viewBox=${`0 0 ${world.w} ${world.h}`}
              preserveAspectRatio="none"
            >
              ${svg`<defs>
                <linearGradient id="icw-lg" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#d4af37" stop-opacity="0.2"></stop>
                  <stop offset="0.5" stop-color="#f4d77a" stop-opacity="0.9"></stop>
                  <stop offset="1" stop-color="#d4af37" stop-opacity="0.2"></stop>
                </linearGradient>
              </defs>`}
              <g id="icw-link-paths"></g>
            </svg>
            ${this.nodes.map((n) => this.renderNode(n))}
          </div>
        </div>

        ${this.renderHud(title, total)}
      </div>
    `;
  }

  private renderBg() {
    const layers = new Set(this.bgLayers);
    return html`
      <div class="icw-bg" aria-hidden="true">
        ${layers.has("radial") ? html`<div class="icw-bg-radial"></div>` : nothing}
        ${layers.has("grid") ? html`<div class="icw-bg-grid"></div>` : nothing}
        ${layers.has("stars") ? html`<div class="icw-bg-stars"></div>` : nothing}
        ${layers.has("vignette") ? html`<div class="icw-bg-vignette"></div>` : nothing}
      </div>
    `;
  }

  private renderHud(title: string, total: number) {
    const idx = this.index;
    return html`
      <div class="icw-hud icw-topbar">
        <span class="icw-brand">${title}</span>
        <span class="icw-zoom">${this.zoomLabel}%</span>
        <button class="icw-icon" aria-label="Fit all" title="Fit all" @click=${() => this.fitAll(false)}>⤢</button>
        <button class="icw-icon" aria-label="Zoom in" @click=${() => this.zoomBy(1.35)}>+</button>
        <button class="icw-icon" aria-label="Zoom out" @click=${() => this.zoomBy(1 / 1.35)}>−</button>
        <button class="icw-icon icw-close" aria-label="Close" @click=${() => this.dispatchDismiss()}>✕</button>
      </div>

      ${this.caption
        ? html`<div class="icw-caption" aria-live="polite">${this.caption}</div>`
        : nothing}

      <div class="icw-hud icw-controls">
        <button class="icw-nav" aria-label="Previous" ?disabled=${idx === 0} @click=${() => this.prev()}>←</button>
        <div class="icw-dots" role="tablist" aria-label="Scene progress">
          ${this.scenes.map(
            (_, i) =>
              html`<button
                class="icw-dot ${i === idx ? "active" : i < idx ? "past" : ""}"
                aria-current=${i === idx ? "true" : "false"}
                aria-label=${`Scene ${i + 1}`}
                @click=${() => (this.index = i)}
              ></button>`,
          )}
        </div>
        <button class="icw-nav" aria-label=${this.paused ? "Play" : "Pause"} @click=${() => this.togglePause()}>
          ${this.paused ? "▶" : "❚❚"}
        </button>
        <button class="icw-nav primary" aria-label="Next" @click=${() => this.next()}>
          ${idx >= total - 1 ? "Done" : "→"}
        </button>
        <span class="icw-counter">${idx + 1} / ${total}</span>
      </div>
    `;
  }

  /** Below 720px: single-column scene-card reader (no pannable world). */
  private renderMobile() {
    const scene = this.current;
    const focus = scene?.focusNodeId ? this.nodes.find((n) => n.id === scene.focusNodeId) : null;
    const node = focus ?? this.nodes[0];
    const title = this.payload?.title || "Holo-Canvas Walkthrough";
    const total = this.scenes.length;
    return html`
      <div class="icw-backdrop icw-mobile" role="dialog" aria-modal="true" aria-label=${title}>
        ${this.renderBg()}
        <div class="icw-hud icw-topbar">
          <span class="icw-brand">${title}</span>
          <button class="icw-icon icw-close" aria-label="Close" @click=${() => this.dispatchDismiss()}>✕</button>
        </div>
        <div class="icw-mobile-stage">
          ${node ? html`<div class="icw-mobile-card">${this.renderNode(node, true)}</div>` : nothing}
          ${this.caption ? html`<div class="icw-caption icw-caption-inline">${this.caption}</div>` : nothing}
        </div>
        <div class="icw-hud icw-controls">
          <button class="icw-nav" aria-label="Previous" ?disabled=${this.index === 0} @click=${() => this.prev()}>←</button>
          <button class="icw-nav" aria-label=${this.paused ? "Play" : "Pause"} @click=${() => this.togglePause()}>
            ${this.paused ? "▶" : "❚❚"}
          </button>
          <button class="icw-nav primary" aria-label="Next" @click=${() => this.next()}>
            ${this.index >= total - 1 ? "Done" : "→"}
          </button>
          <span class="icw-counter">${this.index + 1} / ${total}</span>
        </div>
      </div>
    `;
  }

  private renderNode(n: CanvasNode, plain = false) {
    const accent = colorFor(n.cl);
    const cls = `icw-node icw-kind-${n.kind}${plain ? " plain" : ""}`;
    return html`
      <div
        id=${`n-${cssId(n.id)}`}
        class=${cls}
        style=${plain ? `--cl:${accent}` : `--cl:${accent};left:${n.x}px;top:${n.y}px;width:${n.w}px`}
        @click=${() => (plain ? undefined : this.onNodeClick(n))}
      >
        ${n.part ? html`<div class="icw-part">${n.part}</div>` : nothing}
        ${this.renderNodeBody(n)}
      </div>
    `;
  }

  private renderNodeBody(n: CanvasNode) {
    switch (n.kind) {
      case "title":
        return html`
          ${n.brand ? html`<div class="icw-eyebrow">${n.brand}</div>` : nothing}
          ${n.h1 ? html`<div class="icw-h1">${n.h1}</div>` : nothing}
          ${n.sub ? html`<div class="icw-sub">${n.sub}</div>` : nothing}
          ${n.body ? html`<div class="icw-body">${mdInline(n.body)}</div>` : nothing}
        `;
      case "callout":
        return html`
          <div class="icw-callout-row">
            ${n.icon ? html`<span class="icw-callout-icon">${n.icon}</span>` : nothing}
            <div>
              ${n.title ? html`<div class="icw-h2">${n.title}</div>` : nothing}
              ${n.body ? html`<div class="icw-body">${mdInline(n.body)}</div>` : nothing}
            </div>
          </div>
        `;
      case "stats":
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          <div class="icw-stats">
            ${(n.stats ?? []).map(
              (s) => html`<div class="icw-stat">
                <div class="icw-stat-n">${s.n}</div>
                <div class="icw-stat-l">${s.l}</div>
              </div>`,
            )}
          </div>
        `;
      case "image":
        return html`
          ${n.imageUrl ? html`<img class="icw-img" src=${n.imageUrl} alt=${n.alt ?? ""} />` : nothing}
          ${n.title ? html`<div class="icw-caption-node">${n.title}</div>` : nothing}
        `;
      case "code":
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          <pre class="icw-code"><code>${n.code ?? ""}</code></pre>
        `;
      case "quote":
        return html`<blockquote class="icw-quote">${mdInline(n.body ?? "")}</blockquote>`;
      case "diagram":
        return html`
          <div class="icw-diagram-label">DIAGRAM</div>
          <pre class="icw-diagram"><code>${n.body ?? n.code ?? ""}</code></pre>
        `;
      case "text":
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          ${n.h2 ? html`<div class="icw-h2">${n.h2}</div>` : nothing}
          ${n.body ? html`<div class="icw-body">${mdInline(n.body)}</div>` : nothing}
        `;
      case "chart":
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          ${n.h2 ? html`<div class="icw-h2">${n.h2}</div>` : nothing}
          <div class="icw-chart">${renderChart(n)}</div>
        `;
      case "reveal-list": {
        const olCls = n.pacing === "auto" ? "icw-reveal-list reveal-list-auto" : "icw-reveal-list";
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          ${n.h2 ? html`<div class="icw-h2">${n.h2}</div>` : nothing}
          <ol class=${olCls}>
            ${(n.items ?? []).map(
              (item, idx) =>
                html`<li data-index=${idx} style="opacity:0">${mdInline(item.md)}</li>`,
            )}
          </ol>
        `;
      }
      case "timeline": {
        const evts = n.events ?? [];
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          ${n.h2 ? html`<div class="icw-h2">${n.h2}</div>` : nothing}
          <div class="icw-timeline-wrap">
            <div class="icw-timeline-rail"></div>
            ${evts.map(
              (ev, i) => html`
                <div class="icw-timeline-evt ${i % 2 === 0 ? "above" : "below"}">
                  ${ev.kicker ? html`<div class="icw-tl-kicker">${ev.kicker}</div>` : nothing}
                  <div class="icw-tl-label">${ev.label}</div>
                  <div class="icw-tl-dot"></div>
                  <div class="icw-tl-at">${ev.at}</div>
                </div>
              `,
            )}
          </div>
        `;
      }
      case "comparison": {
        const left = n.left ?? { title: "Them", items: [] };
        const right = n.right ?? { title: "Us", items: [] };
        const renderItem = (item: { text: string; positive?: boolean }) => {
          const icon = item.positive === true ? "✓" : item.positive === false ? "✗" : "•";
          const cls =
            item.positive === true
              ? "icw-cmp-item positive"
              : item.positive === false
                ? "icw-cmp-item negative"
                : "icw-cmp-item neutral";
          return html`<div class=${cls}><span class="icw-cmp-icon">${icon}</span>${item.text}</div>`;
        };
        return html`
          <div class="icw-comparison">
            <div class="icw-cmp-col them">
              <div class="icw-cmp-header">${left.title}</div>
              ${left.items.map(renderItem)}
            </div>
            <div class="icw-cmp-col us">
              <div class="icw-cmp-header">${right.title}</div>
              ${right.items.map(renderItem)}
            </div>
          </div>
        `;
      }
      case "pricing":
        return html`
          <div class="icw-pricing">
            ${n.badge ? html`<div class="icw-pricing-badge">${n.badge}</div>` : nothing}
            ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
            ${n.title ? html`<div class="icw-h2">${n.title}</div>` : nothing}
            ${n.price ? html`<div class="icw-price">${n.price}</div>` : nothing}
            ${n.pricePer ? html`<div class="icw-price-per">${n.pricePer}</div>` : nothing}
            ${
              n.priceFeatures && n.priceFeatures.length > 0
                ? html`<ul class="icw-price-features">
                    ${n.priceFeatures.map((f) => html`<li>✓ ${f}</li>`)}
                  </ul>`
                : nothing
            }
          </div>
        `;
      case "live-doc":
        return this.renderLiveDoc(n);
      case "cta":
        return html`
          <div class="icw-cta">
            ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
            ${n.title ? html`<div class="icw-h2">${n.title}</div>` : nothing}
            ${n.body ? html`<div class="icw-body">${mdInline(n.body)}</div>` : nothing}
            <button
              class="icw-cta-btn"
              @click=${(e: Event) => {
                e.stopPropagation();
                (e.currentTarget as HTMLElement).dispatchEvent(
                  new CustomEvent("icw-cta-click", {
                    bubbles: true,
                    composed: true,
                    detail: { href: n.ctaHref },
                  }),
                );
              }}
            >
              ${n.ctaLabel ?? "Learn More"}
            </button>
          </div>
        `;
      default:
        return html`
          ${n.kicker ? html`<div class="icw-eyebrow">${n.kicker}</div>` : nothing}
          ${n.h2 ? html`<div class="icw-h2">${n.h2}</div>` : nothing}
          ${n.body ? html`<div class="icw-body">${mdInline(n.body)}</div>` : nothing}
        `;
    }
  }

  private renderLiveDoc(n: CanvasNode) {
    const kind = n.liveDocKind ?? "note";
    const id = n.liveDocId ?? "";
    const docKey = `${kind}:${id}`;

    return html`
      <div class="icw-livedoc">
        <div class="icw-livedoc-header">
          <span class="icw-eyebrow">${kind.toUpperCase()}</span>
          <span class="icw-livedoc-status" data-doc=${docKey}>
            ${id ? html`<span class="icw-livedoc-id">${id.slice(0, 8)}…</span>` : nothing}
          </span>
        </div>
        <textarea
          class="icw-livedoc-editor"
          placeholder="Start typing… voice commands apply here"
          data-doc-kind=${kind}
          data-doc-id=${id}
          @input=${(e: Event) => this.onLiveDocInput(e, kind, id)}
          @focus=${() => this.onLiveDocFocus(n)}
          @blur=${() => this.onLiveDocBlur(n)}
        ></textarea>
        <div class="icw-livedoc-hint">
          Voice commands route here while focused. Say "save", "clear", or "done".
        </div>
      </div>
    `;
  }

  private onLiveDocInput(e: Event, kind: string, id: string): void {
    const ta = e.target as HTMLTextAreaElement;
    if (this._liveDocSaveTimer != null) clearTimeout(this._liveDocSaveTimer);
    this._liveDocSaveTimer = setTimeout(() => {
      void this.saveLiveDoc(kind, id, ta.value);
    }, 800);
  }

  private onLiveDocFocus(n: CanvasNode): void {
    if (!n.liveDocId || !n.liveDocKind) return;
    window.dispatchEvent(new CustomEvent("infinibot:focus.live-doc:start", {
      bubbles: true,
      composed: true,
      detail: { id: n.liveDocId, kind: n.liveDocKind },
    }));
    // While live-doc is focused, narration becomes captions-only (duck-start to prevent TTS)
    window.dispatchEvent(new CustomEvent("infinibot:voice-duck-start", {
      detail: { sourceId: "live-doc", eventId: n.id },
    }));
  }

  private onLiveDocBlur(n: CanvasNode): void {
    window.dispatchEvent(new CustomEvent("infinibot:focus.live-doc:end", {
      bubbles: true,
      composed: true,
      detail: { id: n.liveDocId ?? "", kind: n.liveDocKind ?? "note" },
    }));
    // Un-duck when focus leaves the live-doc
    window.dispatchEvent(new CustomEvent("infinibot:voice-duck-end", {
      detail: { sourceId: "live-doc", eventId: n.id },
    }));
  }

  private async saveLiveDoc(kind: string, id: string, content: string): Promise<void> {
    if (!id) return;
    try {
      const rpc =
        kind === "note"
          ? "notes.update"
          : kind === "project"
            ? "projects.update"
            : "workflows.update";
      await fetch(`/api/rpc/${rpc}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content }),
      }).catch(() => { /* best-effort */ });
    } catch { /* don't throw */ }
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9994;
      pointer-events: auto;
      --gold-1: #d4af37;
      --gold-2: #f4d77a;
      --void-0: #05060b;
    }
    .icw-backdrop {
      position: fixed;
      inset: 0;
      overflow: hidden;
      background: var(--void-0, #05060b);
      animation: icw-fade 240ms ease-out;
    }
    @keyframes icw-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    /* ── 4-layer void background ── */
    .icw-bg {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .icw-bg-radial {
      position: absolute;
      inset: -20%;
      background:
        radial-gradient(circle at 30% 20%, rgba(212, 175, 55, 0.1), transparent 45%),
        radial-gradient(circle at 75% 75%, rgba(120, 90, 30, 0.12), transparent 50%),
        radial-gradient(ellipse at center, #0a0b12 0%, #05060b 70%);
    }
    .icw-bg-grid {
      position: absolute;
      inset: 0;
      background-image:
        linear-gradient(rgba(212, 175, 55, 0.05) 1px, transparent 1px),
        linear-gradient(90deg, rgba(212, 175, 55, 0.05) 1px, transparent 1px);
      background-size: 56px 56px;
      mask-image: radial-gradient(ellipse at center, #000 35%, transparent 78%);
      -webkit-mask-image: radial-gradient(ellipse at center, #000 35%, transparent 78%);
    }
    .icw-bg-stars {
      position: absolute;
      inset: 0;
      background-image:
        radial-gradient(1px 1px at 20% 30%, rgba(244, 215, 122, 0.7), transparent),
        radial-gradient(1px 1px at 60% 70%, rgba(255, 255, 255, 0.5), transparent),
        radial-gradient(1px 1px at 80% 20%, rgba(244, 215, 122, 0.6), transparent),
        radial-gradient(1px 1px at 35% 85%, rgba(255, 255, 255, 0.4), transparent),
        radial-gradient(1px 1px at 90% 55%, rgba(244, 215, 122, 0.5), transparent);
      opacity: 0.6;
    }
    .icw-bg-vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(ellipse at center, transparent 50%, rgba(0, 0, 0, 0.7) 100%);
    }

    /* ── pan/zoom world ── */
    .icw-viewport {
      position: absolute;
      inset: 0;
      cursor: grab;
      touch-action: none;
      overflow: hidden;
    }
    .icw-viewport:active {
      cursor: grabbing;
    }
    .icw-world {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: 0 0;
      will-change: transform;
    }
    .icw-links {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: visible;
    }

    /* ── glass nodes ── */
    .icw-node {
      position: absolute;
      box-sizing: border-box;
      padding: 22px 24px;
      border-radius: 18px;
      background: linear-gradient(
        150deg,
        rgba(22, 19, 10, 0.82) 0%,
        rgba(12, 11, 8, 0.88) 70%,
        rgba(8, 7, 5, 0.92) 100%
      );
      color: var(--g-fg, #f5eacd);
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      box-shadow:
        0 18px 60px -22px rgba(0, 0, 0, 0.85),
        inset 0 0 0 1px rgba(255, 255, 255, 0.03);
      transition:
        box-shadow 240ms ease,
        transform 240ms ease;
    }
    /* gold gradient border via mask */
    .icw-node::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(
        140deg,
        color-mix(in srgb, var(--cl, #d4af37) 70%, transparent),
        transparent 45%,
        color-mix(in srgb, var(--cl, #d4af37) 30%, transparent)
      );
      -webkit-mask:
        linear-gradient(#000 0 0) content-box,
        linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }
    .icw-node:hover {
      transform: translateY(-2px);
      box-shadow:
        0 24px 70px -22px rgba(0, 0, 0, 0.9),
        0 0 40px -16px color-mix(in srgb, var(--cl, #d4af37) 60%, transparent);
    }
    .icw-node.focus-glow {
      box-shadow:
        0 24px 80px -20px rgba(0, 0, 0, 0.9),
        0 0 0 1px color-mix(in srgb, var(--cl, #d4af37) 60%, transparent),
        0 0 60px -10px color-mix(in srgb, var(--cl, #d4af37) 75%, transparent);
    }
    .icw-part {
      position: absolute;
      top: -11px;
      left: 18px;
      font-size: 0.6rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--cl, #d4af37);
      background: rgba(8, 7, 5, 0.96);
      border: 1px solid color-mix(in srgb, var(--cl, #d4af37) 40%, transparent);
      border-radius: 5px;
      padding: 2px 8px;
    }
    .icw-eyebrow {
      font-size: 0.62rem;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--cl, #d4af37);
      margin-bottom: 8px;
    }
    .icw-h1 {
      font-size: 2rem;
      font-weight: 800;
      line-height: 1.1;
      color: var(--g-fg, #f5eacd);
      margin-bottom: 8px;
    }
    .icw-h2 {
      font-size: 1.3rem;
      font-weight: 700;
      color: var(--gold-2, #f4d77a);
      margin-bottom: 8px;
    }
    .icw-sub {
      font-size: 0.95rem;
      line-height: 1.5;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.78));
      margin-bottom: 6px;
    }
    .icw-body {
      font-size: 0.9rem;
      line-height: 1.55;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.82));
    }
    .icw-body strong {
      color: var(--gold-2, #f4d77a);
    }
    .icw-body code {
      background: rgba(255, 255, 255, 0.08);
      padding: 1px 5px;
      border-radius: 5px;
      font-size: 0.9em;
    }
    .icw-callout-row {
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .icw-callout-icon {
      font-size: 1.6rem;
      line-height: 1;
      color: var(--cl, #d4af37);
    }
    .icw-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
    }
    .icw-stat {
      min-width: 120px;
    }
    .icw-stat-n {
      font-size: 1.5rem;
      font-weight: 800;
      color: var(--gold-2, #f4d77a);
    }
    .icw-stat-l {
      font-size: 0.74rem;
      line-height: 1.35;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
    }
    .icw-img {
      width: 100%;
      border-radius: 12px;
      display: block;
      border: 1px solid rgba(212, 175, 55, 0.22);
    }
    .icw-caption-node {
      margin-top: 8px;
      font-size: 0.78rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.65));
    }
    .icw-code,
    .icw-diagram {
      margin: 0;
      padding: 14px 16px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 10px;
      overflow: auto;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.82rem;
      line-height: 1.5;
      color: #f5eacd;
      white-space: pre-wrap;
    }
    .icw-diagram-label {
      font-size: 0.6rem;
      letter-spacing: 0.14em;
      font-weight: 800;
      color: var(--cl, #d4af37);
      margin-bottom: 6px;
    }
    .icw-quote {
      margin: 0;
      padding-left: 14px;
      border-left: 3px solid var(--cl, #d4af37);
      font-size: 1.05rem;
      font-style: italic;
      color: var(--g-fg, #f5eacd);
    }

    /* ── HUD ── */
    .icw-hud {
      position: fixed;
      pointer-events: auto;
      z-index: 5;
    }
    .icw-topbar {
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: rgba(10, 9, 6, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.26);
      border-radius: 12px;
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
    }
    .icw-brand {
      font-size: 0.7rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
    }
    .icw-zoom {
      font-size: 0.66rem;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.55));
      min-width: 38px;
      text-align: right;
    }
    .icw-icon {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(212, 175, 55, 0.24);
      color: var(--g-fg, #f5eacd);
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .icw-icon:hover {
      border-color: var(--gold-1, #d4af37);
    }
    .icw-close:hover {
      color: #fca5a5;
      border-color: #ef4444;
    }
    .icw-caption {
      position: fixed;
      bottom: 86px;
      left: 50%;
      transform: translateX(-50%);
      max-width: min(720px, 88vw);
      text-align: center;
      font-size: 1rem;
      line-height: 1.5;
      color: var(--g-fg, #f5eacd);
      background: rgba(8, 7, 5, 0.72);
      border: 1px solid rgba(212, 175, 55, 0.2);
      border-radius: 12px;
      padding: 12px 18px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      pointer-events: none;
      z-index: 5;
    }
    .icw-controls {
      bottom: 18px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: rgba(10, 9, 6, 0.78);
      border: 1px solid rgba(212, 175, 55, 0.26);
      border-radius: 14px;
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
    }
    .icw-nav {
      min-width: 42px;
      height: 38px;
      padding: 0 12px;
      border-radius: 9px;
      background: rgba(20, 16, 8, 0.6);
      border: 1px solid rgba(212, 175, 55, 0.28);
      color: var(--g-fg, #f5eacd);
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
    }
    .icw-nav:hover:not(:disabled) {
      border-color: var(--gold-1, #d4af37);
    }
    .icw-nav:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .icw-nav.primary {
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      color: #1a1206;
      border-color: var(--gold-1, #d4af37);
    }
    .icw-dots {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .icw-dot {
      width: 8px;
      height: 8px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: rgba(212, 175, 55, 0.22);
      cursor: pointer;
      transition: all 200ms ease;
    }
    .icw-dot.past {
      background: rgba(212, 175, 55, 0.55);
    }
    .icw-dot.active {
      width: 22px;
      border-radius: 4px;
      background: var(--gold-1, #d4af37);
      box-shadow: 0 0 8px rgba(212, 175, 55, 0.6);
    }
    .icw-counter {
      font-size: 0.66rem;
      letter-spacing: 0.08em;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
      margin-left: 4px;
    }

    /* ── mobile single-column reader ── */
    .icw-mobile-stage {
      position: absolute;
      inset: 64px 16px 90px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      overflow-y: auto;
    }
    .icw-mobile-card .icw-node.plain {
      position: relative;
      left: auto;
      top: auto;
      width: 100%;
    }
    .icw-caption-inline {
      position: static;
      transform: none;
      max-width: none;
      pointer-events: auto;
    }

    @media (prefers-reduced-motion: reduce) {
      .icw-backdrop,
      .icw-node {
        animation: none !important;
        transition: none !important;
      }
    }

    /* ── chart node ── */
    .icw-chart {
      width: 100%;
      overflow: hidden;
    }
    .icw-chart svg {
      display: block;
      width: 100%;
    }
    .icw-chart-label {
      font-size: 0.62rem;
      fill: rgba(245, 234, 205, 0.65);
    }
    .icw-chart-val {
      font-size: 0.68rem;
      font-weight: 700;
      fill: var(--gold-2, #f4d77a);
    }
    .icw-metric-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .icw-metric-label {
      font-size: 0.72rem;
      color: rgba(245, 234, 205, 0.7);
      min-width: 90px;
      flex-shrink: 0;
    }
    .icw-metric-val {
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--gold-2, #f4d77a);
      min-width: 40px;
      text-align: right;
      flex-shrink: 0;
    }
    .icw-metric-bar-wrap {
      flex: 1;
      height: 6px;
      background: rgba(255, 255, 255, 0.07);
      border-radius: 3px;
      overflow: hidden;
    }
    .icw-metric-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--gold-1, #d4af37), var(--gold-2, #f4d77a));
      border-radius: 3px;
    }

    /* ── reveal-list node ── */
    .icw-reveal-list {
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      counter-reset: rl;
    }
    .icw-reveal-list li {
      counter-increment: rl;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 0.88rem;
      line-height: 1.5;
      color: rgba(245, 234, 205, 0.85);
      transition: opacity 320ms ease;
    }
    .icw-reveal-list li::before {
      content: counter(rl, decimal-leading-zero);
      font-size: 0.62rem;
      font-weight: 800;
      color: var(--gold-1, #d4af37);
      min-width: 22px;
      margin-top: 2px;
      flex-shrink: 0;
    }

    /* ── timeline node ── */
    .icw-timeline-wrap {
      position: relative;
      display: flex;
      gap: 0;
      align-items: center;
      min-height: 90px;
      overflow-x: auto;
      padding: 30px 0 30px;
    }
    .icw-timeline-rail {
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--gold-1, #d4af37), transparent);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .icw-timeline-evt {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
      min-width: 80px;
    }
    .icw-timeline-evt.above .icw-tl-kicker,
    .icw-timeline-evt.above .icw-tl-label {
      order: -2;
      margin-bottom: 6px;
    }
    .icw-timeline-evt.below .icw-tl-kicker,
    .icw-timeline-evt.below .icw-tl-label {
      order: 2;
      margin-top: 6px;
    }
    .icw-tl-kicker {
      font-size: 0.56rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--gold-1, #d4af37);
    }
    .icw-tl-label {
      font-size: 0.72rem;
      font-weight: 600;
      color: rgba(245, 234, 205, 0.88);
      text-align: center;
      max-width: 90px;
    }
    .icw-tl-dot {
      order: 0;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--gold-1, #d4af37);
      box-shadow: 0 0 8px rgba(212, 175, 55, 0.7);
      flex-shrink: 0;
    }
    .icw-tl-at {
      order: 1;
      font-size: 0.6rem;
      color: rgba(245, 234, 205, 0.45);
      margin-top: 2px;
    }

    /* ── comparison node ── */
    .icw-comparison {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .icw-cmp-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .icw-cmp-header {
      font-size: 0.68rem;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding-bottom: 6px;
      border-bottom: 1px solid;
      margin-bottom: 4px;
    }
    .icw-cmp-col.them .icw-cmp-header {
      color: rgba(245, 120, 100, 0.8);
      border-color: rgba(245, 120, 100, 0.3);
    }
    .icw-cmp-col.us .icw-cmp-header {
      color: var(--gold-1, #d4af37);
      border-color: rgba(212, 175, 55, 0.3);
    }
    .icw-cmp-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .icw-cmp-icon {
      flex-shrink: 0;
      font-size: 0.78rem;
      margin-top: 1px;
    }
    .icw-cmp-item.positive .icw-cmp-icon {
      color: var(--gold-1, #d4af37);
    }
    .icw-cmp-item.negative .icw-cmp-icon {
      color: rgba(245, 100, 100, 0.8);
    }
    .icw-cmp-item.neutral .icw-cmp-icon {
      color: rgba(245, 234, 205, 0.4);
    }
    .icw-cmp-item.positive {
      color: rgba(245, 234, 205, 0.88);
    }
    .icw-cmp-item.negative {
      color: rgba(245, 234, 205, 0.5);
    }
    .icw-cmp-item.neutral {
      color: rgba(245, 234, 205, 0.65);
    }

    /* ── pricing node ── */
    .icw-pricing {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .icw-pricing-badge {
      position: absolute;
      top: -8px;
      right: -8px;
      font-size: 0.58rem;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      background: var(--gold-1, #d4af37);
      color: #1a1206;
      border-radius: 20px;
      padding: 3px 10px;
    }
    .icw-price {
      font-size: 2.4rem;
      font-weight: 800;
      color: var(--gold-2, #f4d77a);
      line-height: 1;
    }
    .icw-price-per {
      font-size: 0.75rem;
      color: rgba(245, 234, 205, 0.5);
      margin-top: -4px;
    }
    .icw-price-features {
      margin: 4px 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .icw-price-features li {
      font-size: 0.8rem;
      color: rgba(245, 234, 205, 0.8);
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }

    /* ── cta node ── */
    .icw-cta {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: stretch;
    }
    .icw-cta-btn {
      width: 100%;
      padding: 14px 24px;
      border-radius: 10px;
      background: linear-gradient(135deg, var(--gold-1, #d4af37), #b8902f);
      color: #1a1206;
      font-size: 1rem;
      font-weight: 800;
      letter-spacing: 0.04em;
      border: none;
      cursor: pointer;
      transition: filter 180ms ease;
    }
    .icw-cta-btn:hover {
      filter: brightness(1.12);
    }

    /* ── live-doc node ── */
    .icw-livedoc {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .icw-livedoc-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icw-livedoc-id {
      font-size: 0.65rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
      font-family: ui-monospace, monospace;
    }
    .icw-livedoc-editor {
      width: 100%;
      min-height: 120px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(212, 175, 55, 0.25);
      border-radius: 10px;
      color: var(--g-fg, #f5eacd);
      font-size: 0.88rem;
      line-height: 1.55;
      padding: 10px 12px;
      resize: vertical;
      box-sizing: border-box;
      font-family: ui-monospace, SFMono-Regular, monospace;
    }
    .icw-livedoc-editor:focus {
      outline: none;
      border-color: var(--gold-1, #d4af37);
      box-shadow: 0 0 0 2px rgba(212, 175, 55, 0.18);
    }
    .icw-livedoc-hint {
      font-size: 0.68rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.42));
      font-style: italic;
    }
    .icw-livedoc-status {
      margin-left: auto;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "infinite-canvas-walkthrough-overlay": InfiniteCanvasWalkthroughOverlay;
  }
}

// ── chart renderer ─────────────────────────────────────────────────────────────
function renderChart(n: CanvasNode) {
  const series = n.series ?? [];
  const max = Math.max(...series.map((s) => s.value), 1);

  switch (n.chartKind) {
    case "bar": {
      const bw = series.length > 0 ? Math.floor(260 / series.length) - 6 : 40;
      const bars = series.map((s, i) => {
        const bh = Math.round((s.value / max) * 120);
        const bx = 10 + i * (bw + 6);
        const by = 140 - bh;
        return html`
          <rect x=${bx} y=${by} width=${bw} height=${bh} fill="url(#cg-bar)" rx="2"></rect>
          <text class="icw-chart-val" x=${bx + bw / 2} y=${by - 4} text-anchor="middle">${s.value}${n.unit ?? ""}</text>
          <text class="icw-chart-label" x=${bx + bw / 2} y="158" text-anchor="middle">${s.label}</text>
        `;
      });
      return html`<svg viewBox="0 0 280 165" height="165">
        <defs>
          <linearGradient id="cg-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#d4af37"></stop>
            <stop offset="1" stop-color="#8b6914"></stop>
          </linearGradient>
        </defs>
        ${bars}
      </svg>`;
    }
    case "line": {
      if (series.length === 0) return html``;
      const bw = Math.floor(260 / series.length);
      const pts = series
        .map((s, i) => {
          const px = 10 + i * bw + bw / 2;
          const py = 140 - Math.round((s.value / max) * 120);
          return `${px},${py}`;
        })
        .join(" ");
      const labels = series.map((s, i) => {
        const px = 10 + i * bw + bw / 2;
        return html`<text class="icw-chart-label" x=${px} y="158" text-anchor="middle">${s.label}</text>`;
      });
      return html`<svg viewBox="0 0 280 165" height="165">
        <polyline points=${pts} fill="none" stroke="#d4af37" stroke-width="2" stroke-linejoin="round"></polyline>
        ${labels}
      </svg>`;
    }
    case "donut": {
      const total = series.reduce((a, s) => a + s.value, 0) || 1;
      const R = 55;
      const r = 35;
      const cx = 80;
      const cy = 80;
      let angle = -Math.PI / 2;
      const segments = series.map((s, i) => {
        const sweep = (s.value / total) * 2 * Math.PI;
        const x1 = cx + R * Math.cos(angle);
        const y1 = cy + R * Math.sin(angle);
        angle += sweep;
        const x2 = cx + R * Math.cos(angle);
        const y2 = cy + R * Math.sin(angle);
        const xi1 = cx + r * Math.cos(angle);
        const yi1 = cy + r * Math.sin(angle);
        const xi2 = cx + r * Math.cos(angle - sweep);
        const yi2 = cy + r * Math.sin(angle - sweep);
        const large = sweep > Math.PI ? 1 : 0;
        const op = i === 0 ? 1 : Math.max(0.25, 1 - i * 0.18);
        const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi2} ${yi2} Z`;
        return html`<path d=${d} fill="#d4af37" opacity=${op}></path>`;
      });
      const legend = series.map((s, i) => {
        const pct = Math.round((s.value / total) * 100);
        return html`<text
          class="icw-chart-label"
          x="150"
          y=${20 + i * 18}
          dominant-baseline="middle"
        >${s.label} ${pct}%</text>`;
      });
      return html`<svg viewBox="0 0 260 160" height="160">
        ${segments} ${legend}
      </svg>`;
    }
    case "sparkline": {
      if (series.length === 0) return html``;
      const pts = series
        .map((s, i) => {
          const px = Math.round((i / (series.length - 1 || 1)) * 76) + 2;
          const py = 38 - Math.round((s.value / max) * 34);
          return `${px},${py}`;
        })
        .join(" ");
      return html`<svg viewBox="0 0 80 40" height="40">
        <polyline points=${pts} fill="none" stroke="#d4af37" stroke-width="1.5" stroke-linejoin="round"></polyline>
      </svg>`;
    }
    case "metric-bars":
    default: {
      return html`<div>
        ${series.map(
          (s) => html`
            <div class="icw-metric-row">
              <div class="icw-metric-label">${s.label}</div>
              <div class="icw-metric-bar-wrap">
                <div class="icw-metric-bar" style="width:${Math.round((s.value / max) * 100)}%"></div>
              </div>
              <div class="icw-metric-val">${s.value}${n.unit ?? ""}</div>
            </div>
          `,
        )}
      </div>`;
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Map an accent token ("gold"|"red"|...) or CSS color to a concrete color. */
function colorFor(cl?: string): string {
  if (!cl) return "#d4af37";
  switch (cl) {
    case "gold":
      return "#d4af37";
    case "red":
      return "#ef6b6b";
    case "green":
      return "#4ade80";
    case "cyan":
      return "#5eead4";
    case "blue":
      return "#60a5fa";
    case "purple":
      return "#c4b5fd";
    default:
      return cl; // assume a CSS color
  }
}

/** Sanitize a node id for use as a DOM id selector fragment. */
function cssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Minimal inline markdown (bold / italic / code) → a safe DocumentFragment. */
function mdInline(src: string) {
  const escaped = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const htmlStr = escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
  const tpl = document.createElement("template");
  tpl.innerHTML = htmlStr;
  return tpl.content.cloneNode(true);
}
