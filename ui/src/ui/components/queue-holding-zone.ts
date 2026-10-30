/**
 * Queue holding-zone overlay — iso-map companion to the persistent agent
 * queue (src/queue/*).
 *
 * Per `world_map_real_surface.md` the live world host is `<agency-world-viz>`,
 * so this lit element is meant to be mounted as a child of that host (or any
 * overlay band layered on top of it). It listens for `queue.*` WS events
 * dispatched onto `window` by app-gateway and renders dim gold sprites at an
 * atrium-style holding zone placed off to the side of the main concourse —
 * matching the spec call-out in agent_queue_orchestration_infra.md.
 *
 * Design language: strict black/gold glass per
 * `feedback_infinibot_os_design_language.md`. No cyan, no rainbow.
 *
 * The component is intentionally DOM-only — it doesn't reach into PIXI to
 * spawn sprites in the engine layer. A deeper PIXI integration can land in a
 * follow-up; the DOM overlay gets the holding zone visible and demoable
 * today without touching ActivityMap's already-heavy hot path.
 */

import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface QueuedSpriteView {
  id: string;
  shortId: string;
  position: number;
  totalPhases: number;
  currentPhaseIdx: number;
  status: "queued" | "running" | "blocked" | "done" | "failed" | "canceled";
  phaseName?: string;
  reason?: string;
  /** Animation hint: set briefly when an event arrives so a CSS pulse plays. */
  pulse?: "started" | "completed" | "blocked";
}

interface QueueEventDetail {
  event: string;
  payload?: {
    id: string;
    status?: string;
    phaseName?: string;
    phaseIdx?: number;
    totalPhases?: number;
    reason?: string;
  };
}

@customElement("queue-holding-zone")
export class QueueHoldingZone extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      /* The world viz sets this so the atrium stacks under the orbital map /
         theme picker (and under its HUD column on narrow screens). */
      top: var(--awv-right-stack-top, 24px);
      right: 24px;
      display: block;
      pointer-events: auto;
      z-index: 6;
      /* Gold/obsidian tokens — match the rest of the UI system. */
      --gold-strong: #d4af37;
      --gold-soft: rgba(212, 175, 55, 0.45);
      --gold-dim: rgba(212, 175, 55, 0.18);
      --obsidian: rgba(10, 8, 4, 0.78);
    }
    .atrium {
      min-width: 220px;
      max-width: 280px;
      padding: 12px 14px 10px;
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(20, 16, 8, 0.82), rgba(8, 6, 2, 0.88));
      border: 1px solid var(--gold-soft);
      box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.4),
        0 12px 30px rgba(0, 0, 0, 0.5),
        inset 0 0 22px rgba(212, 175, 55, 0.06);
      backdrop-filter: blur(8px) saturate(140%);
    }
    /* Docked in the world viz HUD column: full column width, compact, and the
       empty state collapses into the heading row. */
    :host([docked]) {
      position: relative;
      top: auto;
      right: auto;
      z-index: auto;
    }
    :host([docked]) .atrium {
      min-width: 0;
      max-width: none;
      padding: 7px 10px;
      border-radius: 8px;
      border-left: 3px solid var(--gold-strong);
    }
    :host([docked]) .heading {
      margin-bottom: 0;
      font-size: 9.5px;
    }
    :host([docked]) ul.sprites {
      margin-top: 6px;
      max-height: 168px;
    }
    :host([docked]) li.sprite {
      padding: 5px 7px;
    }
    .heading .clear {
      color: rgba(255, 240, 200, 0.45);
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: none;
      margin-left: auto;
      margin-right: 8px;
    }
    .heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 10.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--gold-strong);
      margin-bottom: 8px;
    }
    .heading .count {
      color: rgba(255, 240, 200, 0.75);
      font-weight: 600;
    }
    .empty {
      font-family: ui-monospace, monospace;
      color: rgba(255, 240, 200, 0.45);
      font-size: 11px;
      padding: 6px 0 2px;
    }
    ul.sprites {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 240px;
      overflow-y: auto;
    }
    li.sprite {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 9px;
      border-radius: 10px;
      background: rgba(212, 175, 55, 0.05);
      border: 1px solid var(--gold-dim);
      transition: background 200ms ease, transform 280ms ease, border-color 200ms ease;
    }
    li.sprite.status-queued {
      opacity: 0.7;
    }
    li.sprite.status-running {
      background: rgba(212, 175, 55, 0.14);
      border-color: var(--gold-soft);
    }
    li.sprite.status-blocked {
      border-color: rgba(220, 100, 80, 0.6);
      background: rgba(80, 30, 25, 0.25);
    }
    li.sprite.pulse-started {
      animation: shoot 600ms ease;
    }
    li.sprite.pulse-completed {
      animation: glow 700ms ease;
    }
    li.sprite.pulse-blocked {
      animation: shake 380ms ease;
    }
    @keyframes shoot {
      0% { transform: translateX(0); box-shadow: 0 0 0 rgba(212, 175, 55, 0); }
      40% { transform: translateX(-14px); box-shadow: 0 0 18px rgba(212, 175, 55, 0.6); }
      100% { transform: translateX(0); box-shadow: 0 0 0 rgba(212, 175, 55, 0); }
    }
    @keyframes glow {
      0% { box-shadow: 0 0 0 rgba(212, 175, 55, 0); }
      50% { box-shadow: 0 0 18px rgba(212, 175, 55, 0.55); }
      100% { box-shadow: 0 0 0 rgba(212, 175, 55, 0); }
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25% { transform: translateX(-3px); }
      75% { transform: translateX(3px); }
    }
    .badge {
      flex: 0 0 22px;
      height: 22px;
      width: 22px;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 25%, #f3d76b, #8a6a1c 70%, #4a360a 100%);
      display: grid;
      place-items: center;
      color: #1a1305;
      font: 700 10px/1 ui-monospace, monospace;
      box-shadow: inset 0 0 4px rgba(0, 0, 0, 0.4);
    }
    .body {
      flex: 1 1 auto;
      min-width: 0;
    }
    .label {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: rgba(255, 240, 200, 0.92);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .meta {
      font-family: ui-monospace, monospace;
      font-size: 9.5px;
      color: rgba(212, 175, 55, 0.7);
      letter-spacing: 0.05em;
    }
    .pips {
      display: inline-flex;
      gap: 3px;
      margin-left: 4px;
      vertical-align: -1px;
    }
    .pip {
      width: 5px;
      height: 5px;
      border-radius: 1px;
      background: rgba(212, 175, 55, 0.25);
    }
    .pip.done { background: var(--gold-strong); }
    .pip.current { background: rgba(212, 175, 55, 0.8); box-shadow: 0 0 6px var(--gold-soft); }
  `;

  @state() private sprites: Map<string, QueuedSpriteView> = new Map();

  /** Set by the world viz when the atrium is stacked in its HUD column. */
  @property({ type: Boolean, reflect: true }) docked = false;

  connectedCallback(): void {
    super.connectedCallback();
    // Per `realtime_change_broadcasts.md` app-gateway redispatches every ws
    // event onto `window` as a CustomEvent with the same name. We listen for
    // the specific queue.* kinds + the generic queue.changed fallback.
    this.boundHandler = this.handleEvent.bind(this);
    for (const e of [
      "queue.enqueued",
      "queue.phase_started",
      "queue.phase_completed",
      "queue.blocked",
      "queue.done",
      "queue.failed",
      "queue.canceled",
      "queue.changed",
    ]) {
      window.addEventListener(e, this.boundHandler as EventListener);
    }
    // Initial seed via the gateway RPC if available.
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.boundHandler) {
      for (const e of [
        "queue.enqueued",
        "queue.phase_started",
        "queue.phase_completed",
        "queue.blocked",
        "queue.done",
        "queue.failed",
        "queue.canceled",
        "queue.changed",
      ]) {
        window.removeEventListener(e, this.boundHandler as EventListener);
      }
    }
  }

  private boundHandler: ((e: Event) => void) | null = null;

  private handleEvent(e: Event): void {
    const ce = e as CustomEvent<QueueEventDetail | unknown>;
    // Two shapes are possible depending on the bridge: either the raw
    // payload or `{ event, payload }`. Normalize.
    const detail = ce.detail as QueueEventDetail | undefined;
    if (!detail) return;
    void this.refresh(); // canonical source of truth
    // Apply a transient pulse to the matching sprite for visual feedback.
    const id = (detail as any)?.payload?.id ?? (detail as any)?.id;
    if (!id) return;
    const pulse: QueuedSpriteView["pulse"] =
      e.type === "queue.phase_started"
        ? "started"
        : e.type === "queue.phase_completed" || e.type === "queue.done"
          ? "completed"
          : e.type === "queue.blocked" || e.type === "queue.failed"
            ? "blocked"
            : undefined;
    if (pulse) {
      const cur = this.sprites.get(id);
      if (cur) {
        this.sprites.set(id, { ...cur, pulse });
        this.requestUpdate();
        setTimeout(() => {
          const c2 = this.sprites.get(id);
          if (c2?.pulse === pulse) {
            this.sprites.set(id, { ...c2, pulse: undefined });
            this.requestUpdate();
          }
        }, 800);
      }
    }
  }

  private async refresh(): Promise<void> {
    // Resolve the gateway client via the global pointer app-render publishes
    // (see ui/src/ui/app-render.ts). Same indirection used by canvas-preview
    // and save-to-project — keeps this component free of a direct app dep.
    const client = (window as unknown as {
      __infinibotGatewayClient?: {
        request: (m: string, p?: unknown) => Promise<{ entries?: unknown[] } | null>;
      };
    }).__infinibotGatewayClient;
    if (!client?.request) return;
    try {
      const res = await client.request("queue.list", {});
      const entries = Array.isArray(res?.entries) ? res!.entries : [];
      const next = new Map<string, QueuedSpriteView>();
      let position = 1;
      for (const raw of entries) {
        const r = raw as {
          id?: string;
          status?: QueuedSpriteView["status"];
          phaseSpec?: Array<{ name?: string }>;
          currentPhaseIdx?: number;
          lastError?: string;
        };
        if (!r.id || !r.status) continue;
        // Holding zone shows queued + blocked + running (running flies out
        // via CSS animation). Terminal states (done/failed/canceled) are
        // hidden after a short tail; here we just drop them straight away.
        if (r.status === "done" || r.status === "canceled" || r.status === "failed") continue;
        next.set(r.id, {
          id: r.id,
          shortId: r.id.slice(0, 6),
          position: position++,
          totalPhases: r.phaseSpec?.length ?? 0,
          currentPhaseIdx: r.currentPhaseIdx ?? 0,
          status: r.status,
          phaseName: r.phaseSpec?.[r.currentPhaseIdx ?? 0]?.name,
          reason: r.status === "blocked" ? r.lastError ?? undefined : undefined,
          pulse: this.sprites.get(r.id)?.pulse,
        });
      }
      this.sprites = next;
    } catch {
      // Gateway call not available yet (e.g. pre-connect); harmless.
    }
  }

  private renderSprite(s: QueuedSpriteView): TemplateResult {
    const pips: TemplateResult[] = [];
    for (let i = 0; i < s.totalPhases; i++) {
      const cls = i < s.currentPhaseIdx ? "pip done" : i === s.currentPhaseIdx ? "pip current" : "pip";
      pips.push(html`<span class=${cls}></span>`);
    }
    const pulseClass = s.pulse ? `pulse-${s.pulse}` : "";
    return html`
      <li class="sprite status-${s.status} ${pulseClass}" title=${s.reason ?? ""}>
        <div class="badge">${s.position}</div>
        <div class="body">
          <div class="label">
            ${s.phaseName ?? "phase"}
            <span class="pips">${pips}</span>
          </div>
          <div class="meta">
            ${s.shortId} · ${s.status}${s.totalPhases ? ` · ${s.currentPhaseIdx + 1}/${s.totalPhases}` : ""}
          </div>
        </div>
      </li>
    `;
  }

  protected render(): TemplateResult {
    const list = Array.from(this.sprites.values());
    return html`
      <div class="atrium" part="atrium">
        <div class="heading">
          <span>Holding Zone</span>
          ${list.length === 0 && this.docked ? html`<span class="clear">queue is clear</span>` : null}
          <span class="count">${list.length}</span>
        </div>
        ${list.length === 0
          ? this.docked
            ? null
            : html`<div class="empty">queue is clear</div>`
          : html`<ul class="sprites">${list.map((s) => this.renderSprite(s))}</ul>`}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "queue-holding-zone": QueueHoldingZone;
  }
}
