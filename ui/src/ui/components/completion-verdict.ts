/**
 * <completion-verdict> — verified-completion verdict for one sub-agent run.
 *
 * Shows VERIFIED / UNVERIFIED / FAILED (+ stalled / blocked / needs input),
 * the reasons, deterministic evidence, visual_verify screenshots, and the
 * operator actions Continue / Retry / Accept / Reject (`verification.decide`).
 * Used by the Oversight/Reviews detail page and the agent focus modal.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { gatewayHttpBase } from "../gateway-http-auth";
// Worker <-> Auditor review conversation for this run (renders nothing when the run has none).
import "./review-thread-view";

export type CompletionVerdictData = {
  verdict: "VERIFIED" | "UNVERIFIED" | "FAILED";
  state: string;
  reasons: string[];
  attempts: number;
  screenshots: string[];
  visualFiles: string[];
  evidence: Array<{ kind: string; ref: string; status: string; detail: string }>;
  resultSummary?: string;
  reviewedAt: number;
};

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

const STATE_LABEL: Record<string, string> = {
  verified: "Verified",
  unverified: "Unverified",
  failed: "Failed",
  stalled: "Stalled",
  blocked: "Blocked",
  needs_input: "Needs input",
  needs_owner: "Needs owner",
  accepted: "Accepted",
  rejected: "Rejected",
};

export function verdictTone(stateOrVerdict: string | undefined): "ok" | "warn" | "bad" | "muted" {
  switch ((stateOrVerdict ?? "").toLowerCase()) {
    case "verified":
    case "accepted":
      return "ok";
    case "failed":
    case "rejected":
      return "bad";
    case "unverified":
    case "stalled":
    case "blocked":
    case "needs_input":
    case "needs_owner":
      return "warn";
    default:
      return "muted";
  }
}

export function verdictFileUrl(p: string): string {
  return `${gatewayHttpBase()}/api/verification/file?path=${encodeURIComponent(p)}`;
}

@customElement("completion-verdict")
export class CompletionVerdict extends LitElement {
  @property({ attribute: false }) completion: CompletionVerdictData | null = null;
  @property({ type: String }) runId = "";
  @property({ attribute: false }) client: Requester | null = null;
  @property({ type: Boolean }) compact = false;
  @state() private busy: string | null = null;
  @state() private error: string | null = null;
  @state() private open = false;

  static styles = css`
    :host {
      display: block;
      font: inherit;
      color: var(--text, #e8e6e3);
    }
    .card {
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      border-radius: 12px;
      padding: 12px 14px;
      background: var(--card, rgba(255, 255, 255, 0.03));
      display: grid;
      gap: 10px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid currentColor;
    }
    .tone-ok {
      color: var(--ok, #4ade80);
    }
    .tone-warn {
      color: var(--warn, #fbbf24);
    }
    .tone-bad {
      color: var(--danger, #f87171);
    }
    .tone-muted {
      color: var(--muted, #9aa2b1);
    }
    .meta {
      font-size: 12px;
      color: var(--muted, #9aa2b1);
    }
    .title {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted, #9aa2b1);
    }
    ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 4px;
      font-size: 13px;
      line-height: 1.45;
    }
    .ev {
      display: grid;
      gap: 4px;
      font-size: 12px;
    }
    .ev-row {
      display: grid;
      grid-template-columns: 16px 76px 1fr;
      gap: 6px;
      align-items: baseline;
    }
    .ev-row code {
      font-family: var(--mono, ui-monospace, monospace);
      word-break: break-all;
    }
    .ev-detail {
      grid-column: 3;
      color: var(--muted, #9aa2b1);
    }
    .shots {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 8px;
    }
    .shots a {
      display: block;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      aspect-ratio: 16 / 10;
      background: #000;
    }
    .shots img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top;
      display: block;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    button {
      font: inherit;
      font-size: 12px;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
      background: transparent;
      color: inherit;
      cursor: pointer;
      min-height: 32px;
    }
    button:hover:not([disabled]) {
      border-color: var(--accent, #d4af37);
    }
    button[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .toggle {
      border: 0;
      padding: 0;
      min-height: 0;
      color: var(--muted, #9aa2b1);
      text-decoration: underline;
    }
    .err {
      font-size: 12px;
      color: var(--danger, #f87171);
    }
  `;

  private async decide(action: "continue" | "retry" | "accept" | "reject") {
    if (!this.client || !this.runId || this.busy) return;
    this.busy = action;
    this.error = null;
    try {
      await this.client.request("verification.decide", { runId: this.runId, action });
      this.dispatchEvent(
        new CustomEvent("verdict-decided", { detail: { runId: this.runId, action }, bubbles: true, composed: true }),
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = null;
    }
  }

  render() {
    const c = this.completion;
    if (!c) return nothing;
    const tone = verdictTone(c.state || c.verdict);
    const label = STATE_LABEL[c.state] ?? c.verdict;
    const settled = c.state === "verified" || c.state === "accepted" || c.state === "rejected";
    const evidence = c.evidence.filter((e) => e.status !== "skipped");
    const icon = (s: string) => (s === "pass" ? "✓" : s === "fail" ? "✗" : s === "warn" ? "!" : "·");
    return html`
      <section class="card" aria-label="Verification verdict">
        <div class="head">
          <span class="badge tone-${verdictTone(c.verdict === "VERIFIED" ? "verified" : c.verdict === "FAILED" ? "failed" : "unverified")}">${c.verdict}</span>
          ${label.toUpperCase() !== c.verdict ? html`<span class="badge tone-${tone}">${label}</span>` : nothing}
          <span class="meta">${c.attempts} attempt${c.attempts === 1 ? "" : "s"}${c.visualFiles.length ? ` · ${c.visualFiles.length} visual file(s)` : ""}</span>
        </div>
        ${c.reasons.length
          ? html`<div>
              <div class="title">Why not verified</div>
              <ul>
                ${c.reasons.slice(0, this.compact ? 3 : 10).map((r) => html`<li>${r}</li>`)}
              </ul>
            </div>`
          : nothing}
        ${c.screenshots.length
          ? html`<div>
              <div class="title">Screenshots</div>
              <div class="shots">
                ${c.screenshots.slice(0, this.compact ? 2 : 8).map(
                  (s) => html`<a href=${verdictFileUrl(s)} target="_blank" rel="noopener" title=${s}
                    ><img src=${verdictFileUrl(s)} alt=${s.split("/").pop() ?? "screenshot"} loading="lazy"
                  /></a>`,
                )}
              </div>
            </div>`
          : nothing}
        ${evidence.length && !this.compact
          ? html`<div>
              <button class="toggle" @click=${() => (this.open = !this.open)}>
                ${this.open ? "Hide" : "Show"} evidence (${evidence.length})
              </button>
              ${this.open
                ? html`<div class="ev">
                    ${evidence.map(
                      (e) => html`<div class="ev-row">
                        <span class="tone-${e.status === "pass" ? "ok" : e.status === "fail" ? "bad" : "warn"}">${icon(e.status)}</span>
                        <span class="meta">${e.kind}</span>
                        <code>${e.ref}</code>
                        <span class="ev-detail">${e.detail}</span>
                      </div>`,
                    )}
                  </div>`
                : nothing}
            </div>`
          : nothing}
        ${this.runId && this.client
          ? html`<review-thread-view
              class="thread"
              compact
              .runId=${this.runId}
              .client=${this.client}
            ></review-thread-view>`
          : nothing}
        ${!settled && this.client && this.runId
          ? html`<div class="actions">
              <button ?disabled=${!!this.busy} @click=${() => this.decide("continue")} title="Resume the same session and close the gaps">
                ${this.busy === "continue" ? "Continuing…" : "Continue"}
              </button>
              <button ?disabled=${!!this.busy} @click=${() => this.decide("retry")} title="Start again with the review as feedback">
                ${this.busy === "retry" ? "Retrying…" : "Retry"}
              </button>
              <button ?disabled=${!!this.busy} @click=${() => this.decide("accept")} title="Accept as-is (operator override)">
                Accept
              </button>
              <button ?disabled=${!!this.busy} @click=${() => this.decide("reject")}>Reject</button>
            </div>`
          : nothing}
        ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "completion-verdict": CompletionVerdict;
  }
}
