/**
 * <voice-world-graph> — lightweight ambient knowledge-graph feed for the Voice
 * Terminal, anchored in the iso world-space (NOT the heavy
 * <infinibot-knowledge-graph>).
 *
 * A small recency graph of recent mesh events — spawns, tool calls, edits,
 * federation messages, utterances — wired by causal links (an agent's activity
 * links back to its spawn). Hard-capped at 40 nodes (oldest evicted), canvas
 * rendered with a cheap spring/orbit layout. The cluster is anchored to a
 * world-tracked point (parallaxes with the agent centroid) so it reads as part
 * of the same scene, sitting in the lower-left quadrant clear of the blob.
 *
 * Same perf contract as the connectors: rAF off the Lit loop, auto-degrade past
 * a 16ms/1s budget breach, prefers-reduced-motion freezes layout.
 */

import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import type { WorldEvent } from "../controllers/agency-data-bridge";
import {
  AnchorResolver,
  type EventKind,
  PerfGovernor,
  reducedMotionQuery,
  resolvePalette,
} from "./voice-world-ambient/core.js";
import { GraphEngine } from "./voice-world-ambient/graph-engine.js";
import { subscribeUtterances, subscribeWorld } from "./voice-world-ambient/shared-feed.js";

@customElement("voice-world-graph")
export class VoiceWorldGraph extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      /* Mirror <agency-world-viz>'s box (-16% / 132%, see voice-chat.ts) so the
         graph overlay shares its exact pixel space and maps 1:1 to the mesh. */
      inset: -16%;
      width: 132%;
      height: 132%;
      pointer-events: none;
      z-index: 2;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
  `;

  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  private canvas?: HTMLCanvasElement;
  private ctx?: CanvasRenderingContext2D | null;
  private raf = 0;
  private last = 0;
  private dpr = 1;
  private ro?: ResizeObserver;
  private mql?: MediaQueryList;

  private engine = new GraphEngine();
  private anchors = new AnchorResolver();
  private perf = new PerfGovernor(false);
  private palette!: Record<EventKind, string>;
  private unsubWorld?: () => void;
  private unsubUtter?: () => void;
  private seq = 0;
  private lastToolAt = new Map<string, number>();

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
    this.unsubUtter = subscribeUtterances((text) => this.pushUtterance(text));
    // Debug/verify hook (see voice-world-connectors). Harmless in production.
    (window as unknown as { __voiceGraph?: unknown }).__voiceGraph = {
      inject: (events: WorldEvent[]) => this.onEvents(events),
      utterance: (text: string) => this.pushUtterance(text),
    };
    this.last = performance.now() / 1000;
    this.loop();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("client")) this.subscribe();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.mql?.removeEventListener("change", this.onReduced);
    this.unsubWorld?.();
    this.unsubUtter?.();
  }

  private subscribe(): void {
    this.unsubWorld?.();
    this.unsubWorld = undefined;
    if (!this.client) return;
    this.unsubWorld = subscribeWorld(this.client, (events) => this.onEvents(events));
  }

  private seedAngle(): number {
    // Golden-angle distribution — even spread without Math.random.
    return (this.seq++ * 2.399963) % (Math.PI * 2);
  }

  private pushUtterance(text: string): void {
    const now = performance.now() / 1000;
    this.engine.push({
      id: `utt:${now.toFixed(2)}:${this.seq}`,
      kind: "utterance",
      label: text,
      now,
      seedAngle: this.seedAngle(),
    });
  }

  private onEvents(events: WorldEvent[]): void {
    const now = performance.now() / 1000;
    for (const ev of events) {
      switch (ev.kind) {
        case "agent.spawn":
          this.engine.push({
            id: `n:spawn:${ev.agent.sessionKey}`,
            kind: "spawn",
            label: ev.agent.label || ev.agent.agentId || "agent",
            group: ev.agent.sessionKey,
            now,
            seedAngle: this.seedAngle(),
          });
          break;
        case "agent.tool": {
          // Throttle per session so a tool-heavy run can't blow the 40-cap in
          // seconds — one node per ~1.6s per agent.
          const lastT = this.lastToolAt.get(ev.sessionKey) ?? 0;
          if (now - lastT < 1.6) break;
          this.lastToolAt.set(ev.sessionKey, now);
          const label = `${ev.tool.kind} ${ev.tool.label}`.toLowerCase();
          this.engine.push({
            id: `n:tool:${ev.sessionKey}:${this.seq}`,
            kind: /edit|write|patch|file/.test(label) ? "edit" : "tool",
            label: ev.tool.label || ev.tool.kind,
            group: ev.sessionKey,
            now,
            seedAngle: this.seedAngle(),
          });
          break;
        }
        case "agent.message":
          this.engine.push({
            id: `n:msg:${this.seq}`,
            kind: "message",
            label: `${ev.type}`,
            group: ev.from,
            now,
            seedAngle: this.seedAngle(),
          });
          break;
        case "fed.msg.send":
          this.engine.push({
            id: `n:fed:${ev.msgId}`,
            kind: "federation",
            label: ev.messageType || "federation",
            group: ev.fromNodeId,
            now,
            seedAngle: this.seedAngle(),
          });
          break;
      }
    }
  }

  private resize(): void {
    if (!this.canvas || !this.ctx) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.clientWidth || 1;
    const h = this.clientHeight || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** World-anchored cluster centre: lower-left quadrant, parallaxed by the
   *  agent centroid so it drifts with the map rather than the screen. */
  private clusterCenter(): { x: number; y: number } {
    const w = this.clientWidth || 1;
    const h = this.clientHeight || 1;
    const base = { x: w * 0.2, y: h * 0.72 };
    const centroid = this.anchors.activeCentroid({ w, h });
    return {
      x: base.x + (centroid.x - w / 2) * 0.28,
      y: base.y + (centroid.y - h / 2) * 0.28,
    };
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;

    const t0 = performance.now();
    const now = t0 / 1000;
    let dt = now - this.last;
    this.last = now;
    if (dt > 0.1) dt = 0.1;

    this.anchors.refresh();
    const c = this.clusterCenter();
    this.engine.step(c.x, c.y, dt, this.perf.isMinimal);

    ctx.clearRect(0, 0, this.canvas.width / this.dpr, this.canvas.height / this.dpr);
    this.engine.draw(ctx, c.x, c.y, now, this.palette, this.perf.tier, this.anchors.zoom);

    this.perf.sample(performance.now() - t0, now);
    (window as unknown as { __voiceGraphPerf?: unknown }).__voiceGraphPerf = {
      avgMs: +this.perf.avgFrameMs.toFixed(2),
      tier: this.perf.tier,
      nodes: this.engine.nodeCount,
    };
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-world-graph": VoiceWorldGraph;
  }
}
