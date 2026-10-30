/**
 * <voice-world-connectors> — live in-world connector flows for the Voice
 * Terminal isometric mesh.
 *
 * Curved, iso-aware bézier links with streaming particles, colour-coded by
 * event type, drawn between:
 *   • the voice blob ↔ the active mesh tile,
 *   • a spawning agent → its node tile,
 *   • a tool call → the matching world sector surface,
 *   • each running agent ↔ the edge-HUD lane region.
 *
 * It shares ONE coordinate system with <agency-world-viz>: it mounts as a
 * sibling with identical geometry and anchors to the same `window.__agentFxState`
 * the iso map publishes each frame — so the lines sit on the ground plane, not on
 * a separate painted plane. Canvas-only, `pointer-events:none`, rAF off the Lit
 * render loop, auto-degrading under load and honouring prefers-reduced-motion.
 */

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import type { WorldEvent } from "../controllers/agency-data-bridge";
import {
  AnchorResolver,
  type EventKind,
  PerfGovernor,
  type Pt,
  reducedMotionQuery,
  resolvePalette,
} from "./voice-world-ambient/core.js";
import { FlowEngine } from "./voice-world-ambient/flow-engine.js";
import { subscribeWorld } from "./voice-world-ambient/shared-feed.js";
import { rafLoop, type SchedulerHandle } from "../perf/visibility-scheduler";

@customElement("voice-world-connectors")
export class VoiceWorldConnectors extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      /* Match <agency-world-viz>'s bleed so our canvas shares its exact box and
         the published screen coords map 1:1 (no re-projection). Kept in sync
         with .vc-world agency-world-viz in voice-chat.ts (-16% / 132%). */
      inset: -16%;
      width: 132%;
      height: 132%;
      pointer-events: none;
      z-index: 2; /* above the world canvas (z:1 host), below HUD chrome */
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  /** Live gateway client; drives the shared AgencyDataBridge feed. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private loopHandle: SchedulerHandle | null = null;
  private last = 0;
  private frameCounter = 0;
  private dpr = 1;
  private ro?: ResizeObserver;
  private mql?: MediaQueryList;

  private engine = new FlowEngine();
  private anchors = new AnchorResolver();
  private perf = new PerfGovernor(false);
  private palette!: Record<EventKind, string>;
  private unsubWorld?: () => void;
  private toolSeq = 0;
  private rectCache: DOMRect | null = null;

  private onReduced = (e: MediaQueryListEvent) => this.perf.setReducedMotion(e.matches);

  render() {
    return html`<canvas></canvas>`;
  }

  firstUpdated() {
    this.canvas = this.renderRoot.querySelector("canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");
    this.palette = resolvePalette(this);

    this.mql = reducedMotionQuery();
    this.perf = new PerfGovernor(this.mql.matches);
    this.mql.addEventListener("change", this.onReduced);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this);
    this.resize();

    this.subscribe();
    // Debug/verify hook: lets a headless harness drive synthetic events + seed
    // the agent feed without a live gateway. Harmless in production (never
    // called by app code).
    (window as unknown as { __voiceConn?: unknown }).__voiceConn = {
      inject: (events: WorldEvent[]) => this.onEvents(events),
    };
    this.last = performance.now() / 1000;
    this.loopHandle = rafLoop(this.loop);
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("client")) this.subscribe();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.loopHandle?.cancel();
    this.loopHandle = null;
    this.ro?.disconnect();
    this.mql?.removeEventListener("change", this.onReduced);
    this.unsubWorld?.();
  }

  // ── Feed wiring ───────────────────────────────────────────────────────────
  private subscribe(): void {
    this.unsubWorld?.();
    this.unsubWorld = undefined;
    if (!this.client) return;
    this.unsubWorld = subscribeWorld(this.client, (events) => this.onEvents(events));
  }

  /** Stable endpoint resolvers (re-evaluated each frame inside the engine). */
  private blobAnchor = (): Pt => this.anchors.blob(this.box());
  private agentAnchor = (sk: string) => (): Pt | null => {
    const a = this.anchors.agent(sk);
    return a ? { x: a.x, y: a.y } : null;
  };
  private edgeHudAnchor = (sk: string) => (): Pt | null => {
    const a = this.anchors.agent(sk);
    if (!a || !this.rectCache) return null;
    const hud = document.querySelector("voice-edge-hud");
    if (!hud) return null;
    const r = hud.getBoundingClientRect();
    if (r.width < 4) return null;
    const left = r.left - this.rectCache.left;
    const top = r.top - this.rectCache.top;
    const cx = Math.max(left, Math.min(a.x, left + r.width));
    const cy = Math.max(top, Math.min(a.y, top + r.height));
    return { x: cx, y: cy };
  };
  /** Map a tool kind to one of the iso map's published sector kinds. */
  private toolSectorKind(toolKind: string, isEdit: boolean): string {
    const k = (toolKind || "").toLowerCase();
    if (isEdit) return "terminals"; // engineering-bay — file work
    if (/fed|node|ssh|remote/.test(k)) return "federation";
    if (/search|web|fetch|research|analy/.test(k)) return "analytics";
    if (/message|channel|telegram|notify/.test(k)) return "channels";
    if (/canvas|draw|design/.test(k)) return "canvas";
    return "terminals";
  }

  private sectorAnchor = (sk: string, kind: string) => (): Pt | null => {
    const a = this.anchors.agent(sk);
    if (!a) return null;
    const sector = this.anchors.sectorByKind(kind, { x: a.x, y: a.y });
    return sector ?? this.anchors.blob(this.box());
  };

  private onEvents(events: WorldEvent[]): void {
    const now = performance.now() / 1000;
    for (const ev of events) {
      switch (ev.kind) {
        case "agent.spawn": {
          const sk = ev.agent.sessionKey;
          // Blob → new agent tile (gold), and tile ↔ edge-HUD lane.
          this.engine.add(
            {
              id: `spawn:${sk}`,
              kind: "spawn",
              pair: `blob:${sk}`,
              from: this.blobAnchor,
              to: this.agentAnchor(sk),
              holdDur: 1.6,
            },
            now,
          );
          this.engine.add(
            {
              id: `edge:${sk}`,
              kind: "tool",
              pair: `edge:${sk}`,
              from: this.agentAnchor(sk),
              to: this.edgeHudAnchor(sk),
              holdDur: 9999, // persistent while running; expired on complete
              outDur: 0.6,
            },
            now,
          );
          break;
        }
        case "agent.progress": {
          // Keep a living blob ↔ active tile link while the agent works.
          const sk = ev.sessionKey;
          this.engine.add(
            {
              id: `work:${sk}`,
              kind: "message",
              pair: `blob:${sk}`,
              from: this.blobAnchor,
              to: this.agentAnchor(sk),
              holdDur: 4,
            },
            now,
          );
          break;
        }
        case "agent.tool": {
          const sk = ev.sessionKey;
          const label = `${ev.tool.kind} ${ev.tool.label}`.toLowerCase();
          const isEdit = /edit|write|patch|apply|file/.test(label);
          this.engine.add(
            {
              id: `tool:${sk}:${this.toolSeq++}`,
              kind: isEdit ? "edit" : "tool",
              pair: `tool:${sk}`,
              from: this.agentAnchor(sk),
              // Route to a real world sector surface (published only in galactic
              // mode); falls back to the blob when sectors aren't available.
              to: this.sectorAnchor(sk, this.toolSectorKind(ev.tool.kind, isEdit)),
              holdDur: 1.4,
            },
            now,
          );
          break;
        }
        case "agent.message": {
          this.engine.add(
            {
              id: `msg:${ev.from}->${ev.to}:${this.toolSeq++}`,
              kind: "message",
              pair: `msg:${ev.from}:${ev.to}`,
              from: this.agentAnchor(ev.from),
              to: this.agentAnchor(ev.to),
              holdDur: 1.2,
            },
            now,
          );
          break;
        }
        case "fed.msg.send": {
          // Cross-node — anchor to matching sectors when published, else skip.
          const from = (): Pt | null =>
            this.anchors.sectorByKind("federation", this.anchors.blob(this.box()));
          this.engine.add(
            {
              id: `fed:${ev.msgId}`,
              kind: "federation",
              pair: `fed:${ev.fromNodeId}:${ev.toNodeId}`,
              from,
              to: this.blobAnchor,
              holdDur: 1.6,
            },
            now,
          );
          break;
        }
        case "agent.complete": {
          // Fade out everything tied to this run; a brief success arc home.
          this.engine.expire(`work:${ev.sessionKey}`);
          this.engine.expire(`edge:${ev.sessionKey}`);
          if (ev.success) {
            this.engine.add(
              {
                id: `done:${ev.sessionKey}:${this.toolSeq++}`,
                kind: "complete",
                pair: `blob:${ev.sessionKey}`,
                from: this.agentAnchor(ev.sessionKey),
                to: this.blobAnchor,
                holdDur: 0.6,
                outDur: 1,
              },
              now,
            );
          }
          break;
        }
      }
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  private box(): { w: number; h: number } {
    return { w: this.clientWidth || 1, h: this.clientHeight || 1 };
  }

  private resize(): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.clientWidth || 1;
    const h = this.clientHeight || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.rectCache = this.getBoundingClientRect();
  }

  private loop = (): void => {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const t0 = performance.now();
    const now = t0 / 1000;
    this.last = now;
    this.frameCounter++;

    // Refresh the DOM rect occasionally (cheap) for edge-HUD anchoring.
    if ((this.frameCounter & 31) === 0) this.rectCache = this.getBoundingClientRect();

    this.anchors.refresh();
    this.engine.update(now);

    ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    this.engine.draw(ctx, now, this.palette, this.perf.tier, this.anchors.zoom);

    this.perf.sample(performance.now() - t0, now);
    (window as unknown as { __voiceConnPerf?: unknown }).__voiceConnPerf = {
      avgMs: +this.perf.avgFrameMs.toFixed(2),
      tier: this.perf.tier,
      flows: this.engine.size,
    };
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-world-connectors": VoiceWorldConnectors;
  }
}
