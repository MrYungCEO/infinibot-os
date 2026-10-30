/**
 * <agent-fx-layer> — self-contained canvas FX overlay for the Agency World map.
 *
 * Renders three premium effects *on top of* the world viz without ever touching
 * it: backend-coloured particle trails behind moving agents, status-coloured
 * pulsating glow rings, and radial bursts on status transitions. All drawing is
 * batched onto a single canvas (absolute inset:0, pointer-events:none) so the
 * layer never intercepts clicks meant for the map or surrounding UI.
 *
 * ── DATA CONTRACT ─────────────────────────────────────────────────────────
 * The layer needs one thing from the world: each agent's *screen* position
 * (CSS px, relative to this element's box) plus status + backend. It reads, in
 * priority order:
 *   1. a source set via `layer.setSource(fn)` (preferred for app wiring),
 *   2. `window.__agentFxState` — an `FxAgent[]` the viz refreshes each frame.
 * Optional `window.__agentFxZoom` (number, default 1) drives level-of-detail.
 *
 * ── VIZ INTEGRATION ONE-LINER ─────────────────────────────────────────────
 * <agency-world-viz> owns the PixiJS sprites; their live screen coords aren't
 * publicly exposed today. Add this at the end of ActivityMap.animate() (the
 * viz, not this file), publishing positions the layer can consume:
 *
 *   window.__agentFxState = [...this.rooms].map(([id, r]) => {
 *     const p = r.container.getGlobalPosition();
 *     return { id, x: p.x, y: p.y, status: r.data.status, backend: r.data.coderBackend };
 *   });
 *   window.__agentFxZoom = this.viewport.scale.x;
 *
 * (`this.rooms` is the AgentRoom map; getGlobalPosition() returns canvas/CSS px,
 * which align with this overlay since both fill the same .host element.)
 *
 * Mount as a sibling *after* the viz inside the world-map band:
 *   <agency-world-viz></agency-world-viz>
 *   <agent-fx-layer></agent-fx-layer>
 *
 * ── PUBLIC API ────────────────────────────────────────────────────────────
 *   setSource(fn: FxSource | null)            — override the agent feed
 *   setEffectsEnabled(name, on: boolean)      — toggle 'trails'|'glow'|'bursts'
 *   isEffectEnabled(name): boolean
 *   particleCount: number  (getter)           — live particle count (debug/perf)
 */

import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";
import { FxEngine, type FxFlags } from "./agent-fx-layer/fx-engine.js";
import type { FxAgent, FxEffect, FxSource } from "./agent-fx-layer/types.js";

declare global {
  interface Window {
    __agentFxState?: FxAgent[];
    __agentFxZoom?: number;
  }
}

@customElement("agent-fx-layer")
export class AgentFxLayer extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 2; /* above the world canvas, below interactive HUD chrome */
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  private engine = new FxEngine();
  private flags: FxFlags = FxEngine.defaultFlags(false);
  private source: FxSource | null = null;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private raf = 0;
  /** Set by the host map while another view of the world is on screen. */
  paused = false;
  private last = 0;
  private dpr = 1;
  private ro?: ResizeObserver;
  private mql?: MediaQueryList;
  private onReducedChange = (e: MediaQueryListEvent) => {
    this.flags = { ...this.flags, reducedMotion: e.matches };
    if (e.matches) this.engine.reset();
  };

  render() {
    return html`<canvas></canvas>`;
  }

  firstUpdated() {
    this.canvas = this.renderRoot.querySelector("canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");

    this.mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.flags = { ...this.flags, reducedMotion: this.mql.matches };
    this.mql.addEventListener("change", this.onReducedChange);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this.resize();

    this.last = performance.now() / 1000;
    this.loop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.mql?.removeEventListener("change", this.onReducedChange);
    this.engine.reset();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Replace the agent feed. Pass null to fall back to window.__agentFxState. */
  setSource(fn: FxSource | null): void {
    this.source = fn;
  }

  /** Enable/disable an effect family independently. */
  setEffectsEnabled(name: FxEffect, on: boolean): void {
    this.flags = FxEngine.applyToggle(this.flags, name, on);
  }

  isEffectEnabled(name: FxEffect): boolean {
    return this.flags[name];
  }

  get particleCount(): number {
    return this.engine.particleCount;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private resize(): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR for perf
    const w = this.clientWidth || 1;
    const h = this.clientHeight || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private readAgents(): FxAgent[] {
    if (this.source) {
      try {
        return this.source() ?? [];
      } catch {
        return [];
      }
    }
    // Replay override: when <world-timeline-scrubber> is scrubbed back in time
    // it publishes a reconstructed frame on window.__worldReplayFrame. Prefer
    // that over the live feed so the FX layer animates the past, not the now.
    const replay = (
      window as Window & { __worldReplayFrame?: { agents?: FxAgent[] } | null }
    ).__worldReplayFrame;
    if (replay && Array.isArray(replay.agents)) return replay.agents;
    return window.__agentFxState ?? [];
  }

  private lod(): number {
    // Zoomed out → smaller LOD → fewer/smaller effects. Clamp to a sane band.
    const z = window.__agentFxZoom ?? 1;
    return Math.max(0.45, Math.min(1, z));
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused) return;
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const now = performance.now() / 1000;
    let dt = now - this.last;
    this.last = now;
    if (dt > 0.1) dt = 0.1; // clamp after tab-switch / GC stalls

    const agents = this.readAgents();
    const lod = this.lod();
    this.engine.update(agents, now, dt, this.flags, lod);

    // Clear in CSS px (transform already scales by dpr).
    ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    this.engine.draw(ctx, now, this.flags, lod);
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-fx-layer": AgentFxLayer;
  }
}
