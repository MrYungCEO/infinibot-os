/**
 * Activity-feed strip for queue.* events.
 *
 * Sibling to <queue-holding-zone>: same data plane (src/queue/*), different
 * surface — the activity feed (`agent-activity.ts`) instead of the iso-map.
 * Renders the most recent queue lifecycle events as a gold accent strip per
 * `feedback_infinibot_os_design_language.md` — no rainbow.
 *
 * Listens for queue.* CustomEvents on `window` (re-dispatched by
 * ui/src/ui/app-gateway.ts) so it requires no direct gateway dep.
 */

import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

interface QueueRow {
  ts: number;
  event: string;
  id: string;
  phaseName?: string;
  reason?: string;
  phaseIdx?: number;
  totalPhases?: number;
}

const KIND_LABEL: Record<string, { text: string; tone: "neutral" | "active" | "good" | "bad" }> = {
  "queue.enqueued": { text: "queued", tone: "neutral" },
  "queue.phase_started": { text: "phase started", tone: "active" },
  "queue.phase_completed": { text: "phase complete", tone: "good" },
  "queue.done": { text: "done", tone: "good" },
  "queue.blocked": { text: "blocked", tone: "bad" },
  "queue.failed": { text: "failed", tone: "bad" },
  "queue.canceled": { text: "canceled", tone: "bad" },
};

@customElement("queue-activity-strip")
export class QueueActivityStrip extends LitElement {
  static styles = css`
    :host {
      display: block;
      --gold-strong: #d4af37;
      --gold-soft: rgba(212, 175, 55, 0.45);
      --gold-dim: rgba(212, 175, 55, 0.18);
    }
    .wrap {
      border: 1px solid var(--gold-soft);
      border-left: 3px solid var(--gold-strong);
      border-radius: 8px;
      background: linear-gradient(180deg, rgba(20, 16, 8, 0.6), rgba(10, 8, 4, 0.6));
      padding: 8px 12px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--gold-strong);
    }
    .empty {
      font-size: 11px;
      color: rgba(255, 240, 200, 0.4);
      padding: 2px 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 130px;
      overflow-y: auto;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: rgba(255, 240, 200, 0.85);
      padding: 2px 4px;
    }
    li .ts {
      color: rgba(212, 175, 55, 0.55);
      font-size: 9.5px;
      min-width: 56px;
    }
    li .kind {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 9.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    li .kind.neutral { background: var(--gold-dim); color: var(--gold-strong); }
    li .kind.active  { background: rgba(212, 175, 55, 0.32); color: #1a1305; }
    li .kind.good    { background: rgba(120, 180, 100, 0.22); color: #b6e5a3; }
    li .kind.bad     { background: rgba(220, 100, 80, 0.22); color: #ffb09a; }
    li .id {
      color: rgba(212, 175, 55, 0.55);
      font-size: 10px;
    }
    li .what {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;

  /** Cap on retained rows so the strip never grows unbounded. */
  private static MAX_ROWS = 30;

  @state() private rows: QueueRow[] = [];

  private boundHandler: ((e: Event) => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.boundHandler = this.onEvent.bind(this);
    for (const k of Object.keys(KIND_LABEL)) {
      window.addEventListener(k, this.boundHandler as EventListener);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.boundHandler) {
      for (const k of Object.keys(KIND_LABEL)) {
        window.removeEventListener(k, this.boundHandler as EventListener);
      }
    }
  }

  private onEvent(e: Event): void {
    const ce = e as CustomEvent<{ payload?: Record<string, unknown> }>;
    const payload = ce.detail?.payload ?? {};
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return;
    const row: QueueRow = {
      ts: Date.now(),
      event: e.type,
      id,
      phaseName: typeof payload.phaseName === "string" ? payload.phaseName : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      phaseIdx: typeof payload.phaseIdx === "number" ? payload.phaseIdx : undefined,
      totalPhases: typeof payload.totalPhases === "number" ? payload.totalPhases : undefined,
    };
    this.rows = [row, ...this.rows].slice(0, QueueActivityStrip.MAX_ROWS);
  }

  private fmtTime(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  protected render(): TemplateResult {
    return html`
      <div class="wrap">
        <div class="header">
          <span>Queue</span>
          <span style="color: rgba(255,240,200,0.5); letter-spacing:0;">live lifecycle</span>
        </div>
        ${this.rows.length === 0
          ? html`<div class="empty">no queue events yet</div>`
          : html`
              <ul>
                ${this.rows.map((r) => {
                  const meta = KIND_LABEL[r.event] ?? { text: r.event, tone: "neutral" as const };
                  const phaseBit = r.phaseName
                    ? `${r.phaseName}${
                        typeof r.phaseIdx === "number" && typeof r.totalPhases === "number"
                          ? ` (${r.phaseIdx + 1}/${r.totalPhases})`
                          : ""
                      }`
                    : "";
                  const tail = r.reason ? ` — ${r.reason}` : "";
                  return html`
                    <li>
                      <span class="ts">${this.fmtTime(r.ts)}</span>
                      <span class="kind ${meta.tone}">${meta.text}</span>
                      <span class="id">${r.id.slice(0, 6)}</span>
                      <span class="what">${phaseBit}${tail}</span>
                    </li>
                  `;
                })}
              </ul>
            `}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "queue-activity-strip": QueueActivityStrip;
  }
}
