/**
 * <agent-emotes-layer> — self-contained emote/reaction overlay for the Agency
 * World map.
 *
 * Pops small, premium visual reactions above agents on lifecycle events:
 *   success ✓ (gold burst) · fail ✗ (red shake + crack) · blocked ⚠ (amber
 *   pulse) · shipping 🚀 (gold trail upward) · spawn ✨ (radial sparkle) ·
 *   level-up ⬆ (rising chevrons) · thinking 💭 (animated dots).
 *
 * It NEVER touches <agency-world-viz> (or any world internals). It only reads
 * agent screen positions from the established `window.__agentFxState` contract
 * that <agent-fx-layer> already consumes — `{ id, x, y }[]` in CSS px relative
 * to the shared world box. Emotes follow their agent every frame; if the agent
 * isn't in that array, the emote is pinned to its spawn position (or explicit
 * opts.x/opts.y for demos/tests).
 *
 * ── TRIGGER CONTRACT ──────────────────────────────────────────────────────
 * Anywhere in the app:
 *   window.dispatchEvent(new CustomEvent('agent:emote', {
 *     detail: { id: '<agentId>', type: 'success', opts?: {...} }
 *   }));
 * or the convenience global:
 *   window.agentEmote('<agentId>', 'shipping');
 * or directly on the element:
 *   layer.emit('<agentId>', 'levelup', { scale: 1.2 });
 *
 * ── MOUNT ─────────────────────────────────────────────────────────────────
 * Mount as a sibling *after* the viz inside the world-map band, sharing the
 * same positioned box:
 *   <agency-world-viz></agency-world-viz>
 *   <agent-fx-layer></agent-fx-layer>
 *   <agent-emotes-layer></agent-emotes-layer>
 *
 * ── PUBLIC API ────────────────────────────────────────────────────────────
 *   emit(agentId, type, opts?)   — fire one emote
 *   setEnabled(on: boolean)      — master on/off (also clears active emotes off)
 *   isEnabled(): boolean
 *   clear()                      — remove all active emotes
 *   activeCount (getter)         — live emote count (debug/perf)
 */

import { LitElement, css, html } from "lit";
import { customElement } from "lit/decorators.js";
import { play } from "./agent-emotes-layer/emote-animations.js";
import { EMOTE_SIZE, emoteSvg } from "./agent-emotes-layer/emote-svgs.js";
import type { EmoteAgentPos, EmoteOptions, EmoteType } from "./agent-emotes-layer/types.js";

declare global {
  interface Window {
    __agentFxState?: Array<{ id: string; x: number; y: number }>;
    agentEmote?: (id: string, type: EmoteType, opts?: EmoteOptions) => void;
  }
}

/** Hard cap on simultaneously-rendered emotes; oldest dropped past this. */
const MAX_EMOTES = 30;

interface ActiveEmote {
  el: HTMLDivElement;
  agentId: string;
  /** Last known / pinned position (CSS px, layer-relative). */
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  /** When true, follow live agent position; else stay pinned. */
  follow: boolean;
  expires: number;
  timer: number;
}

@customElement("agent-emotes-layer")
export class AgentEmotesLayer extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      pointer-events: none;
      overflow: visible;
      z-index: 3; /* above particle FX (z:2), below interactive HUD chrome */
    }
    .stage {
      position: absolute;
      inset: 0;
      overflow: visible;
    }
    .emote {
      position: absolute;
      top: 0;
      left: 0;
      width: ${EMOTE_SIZE}px;
      height: ${EMOTE_SIZE}px;
      will-change: transform;
      contain: layout style;
    }
    .emote .fx {
      width: 100%;
      height: 100%;
      transform-origin: center bottom;
    }
    .emote svg {
      width: 100%;
      height: 100%;
      display: block;
      overflow: visible;
    }
  `;

  private enabled = true;
  private reduced = false;
  private active: ActiveEmote[] = [];
  private stage?: HTMLDivElement;
  private raf = 0;
  /** Set by the host map while another view of the world is on screen. */
  paused = false;
  private mql?: MediaQueryList;

  private onReducedChange = (e: MediaQueryListEvent) => {
    this.reduced = e.matches;
  };
  private onEmoteEvent = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { id?: string; type?: EmoteType; opts?: EmoteOptions }
      | undefined;
    if (d?.id && d?.type) this.emit(d.id, d.type, d.opts);
  };

  render() {
    return html`<div class="stage"></div>`;
  }

  firstUpdated() {
    this.stage = this.renderRoot.querySelector(".stage") as HTMLDivElement;

    this.mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reduced = this.mql.matches;
    this.mql.addEventListener("change", this.onReducedChange);

    window.addEventListener("agent:emote", this.onEmoteEvent as EventListener);
    // Convenience global so any code path can fire an emote without a ref.
    window.agentEmote = (id, type, opts) => this.emit(id, type, opts);

    this.loop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.raf);
    this.mql?.removeEventListener("change", this.onReducedChange);
    window.removeEventListener("agent:emote", this.onEmoteEvent as EventListener);
    if (window.agentEmote) delete window.agentEmote;
    this.clear();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Fire one emote for an agent. No-op when disabled. */
  emit(agentId: string, type: EmoteType, opts: EmoteOptions = {}): void {
    if (!this.enabled || !this.stage) return;

    const offsetX = opts.offsetX ?? 0;
    const offsetY = opts.offsetY ?? -34;
    const scale = opts.scale ?? 1;

    // Resolve a starting position: explicit opts → live agent → screen centre.
    const pos = this.resolvePos(agentId);
    const follow = opts.x == null && opts.y == null;
    const x = opts.x ?? pos?.x ?? this.clientWidth / 2;
    const y = opts.y ?? pos?.y ?? this.clientHeight / 2;

    const el = document.createElement("div");
    el.className = "emote";
    if (scale !== 1) el.style.setProperty("--emote-scale", String(scale));

    const fx = document.createElement("div");
    fx.className = "fx";
    if (scale !== 1) fx.style.transform = `scale(${scale})`;
    fx.innerHTML = emoteSvg(type);
    el.appendChild(fx);
    this.stage.appendChild(el);

    const svg = fx.querySelector("svg") as SVGElement;
    const lifetime = play(type, { fx, svg, reduced: this.reduced });

    const now = performance.now();
    const rec: ActiveEmote = {
      el,
      agentId,
      x,
      y,
      offsetX,
      offsetY: offsetY * scale,
      follow,
      expires: now + lifetime,
      timer: window.setTimeout(() => this.expire(rec), lifetime),
    };
    this.position(rec); // place before first paint to avoid a (0,0) flash
    this.active.push(rec);

    // Enforce global cap — drop the oldest beyond the limit.
    while (this.active.length > MAX_EMOTES) {
      const oldest = this.active.shift();
      if (oldest) this.dispose(oldest);
    }
  }

  /** Master switch. Disabling immediately clears any active emotes. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Remove every active emote immediately. */
  clear(): void {
    for (const rec of this.active.splice(0)) this.dispose(rec);
  }

  get activeCount(): number {
    return this.active.length;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private replayAgents(): EmoteAgentPos[] | undefined {
    const r = (window as Window & {
      __worldReplayFrame?: { agents?: EmoteAgentPos[] } | null;
    }).__worldReplayFrame;
    return r && Array.isArray(r.agents) ? r.agents : undefined;
  }

  private resolvePos(agentId: string): EmoteAgentPos | undefined {
    const state = this.replayAgents() ?? window.__agentFxState;
    if (!state) return undefined;
    return state.find((a) => a.id === agentId);
  }

  private expire(rec: ActiveEmote): void {
    const i = this.active.indexOf(rec);
    if (i >= 0) this.active.splice(i, 1);
    this.dispose(rec);
  }

  private dispose(rec: ActiveEmote): void {
    clearTimeout(rec.timer);
    rec.el.remove();
  }

  private position(rec: ActiveEmote): void {
    const px = rec.x + rec.offsetX - EMOTE_SIZE / 2;
    const py = rec.y + rec.offsetY - EMOTE_SIZE / 2;
    rec.el.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.paused || !this.active.length) return;
    const state = window.__agentFxState;
    for (const rec of this.active) {
      if (rec.follow && state) {
        const a = state.find((s) => s.id === rec.agentId);
        if (a) {
          rec.x = a.x;
          rec.y = a.y;
        }
      }
      this.position(rec);
    }
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-emotes-layer": AgentEmotesLayer;
  }
}
