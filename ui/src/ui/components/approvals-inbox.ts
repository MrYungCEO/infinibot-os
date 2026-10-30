/**
 * <approvals-inbox> — topbar badge + panel for the unified approval registry.
 *
 * Every blocked-on-operator request (gated sub-agent check-ins, exec
 * approvals, request_approval from agents / MCP orchestrators, autopilot)
 * lands here AND on the operator's Telegram. Whichever surface answers first
 * wins; the other one updates itself (Telegram edits its card, this panel
 * drops the row on the `approval.resolved` event).
 *
 * Data:
 *   • approvals.list {status:"pending"} + {status:"all"} — initial + 15s poll
 *   • approval.requested / approval.resolved WS events — live
 *   • approvals.resolve {id, action, note} — decide
 *
 * The badge only renders while something is pending (or the panel is open),
 * so the topbar stays quiet the rest of the time. window.approvalsInbox.open()
 * opens it programmatically.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";

type Risk = "low" | "medium" | "high" | "critical";
type Status = "pending" | "approved" | "denied" | "redirected";
type Action = "approve" | "deny" | "redirect" | "approve-always";

export interface ApprovalRow {
  id: string;
  source: string;
  requester: { label?: string | null; agentId?: string | null; runId?: string | null };
  title: string;
  summary: string;
  details: string;
  risk: Risk;
  options: string[];
  createdAt: number;
  expiresAt: number;
  status: Status;
  action: Action | null;
  note: string | null;
  decidedAt: number | null;
  decidedBy: string | null;
  decidedVia: string | null;
  reason: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  "subagent-checkpoint": "Sub-agent check-in",
  exec: "Exec command",
  "tool-gate": "Tool gate",
  orchestrator: "Orchestrator",
  autopilot: "Autopilot",
  custom: "Request",
};

function req(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }).request(
    method,
    params,
  );
}

function fmtIn(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

@customElement("approvals-inbox")
export class ApprovalsInbox extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Render the panel open (visual verification / deep links). */
  @property({ type: Boolean, reflect: true }) open = false;

  @state() private pending: ApprovalRow[] = [];
  @state() private recent: ApprovalRow[] = [];
  @state() private error: string | null = null;
  @state() private busy = new Set<string>();
  @state() private noteOpen = new Set<string>();
  @state() private detailsOpen = new Set<string>();
  @state() private now = Date.now();
  @state() private flash = false;

  private notes = new Map<string, string>();
  private unsub: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private boundClient: GatewayBrowserClient | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.open) this.open = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    (window as unknown as { approvalsInbox?: unknown }).approvalsInbox = {
      open: () => {
        this.open = true;
      },
      close: () => {
        this.open = false;
      },
      refresh: () => this.load(),
    };
    this.tick = setInterval(() => {
      if (this.pending.length) this.now = Date.now();
    }, 15_000);
    window.addEventListener("keydown", this.onKey);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unbind();
    if (this.tick) clearInterval(this.tick);
    window.removeEventListener("keydown", this.onKey);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client !== this.boundClient) this.bind();
  }

  private bind(): void {
    this.unbind();
    this.boundClient = this.client;
    if (!this.client) return;
    void this.load();
    const sub = this.client as unknown as {
      subscribe?: (h: (e: GatewayEventFrame) => void) => () => void;
    };
    if (typeof sub.subscribe === "function") {
      // Call as a method (subscribe reads `this`).
      this.unsub = sub.subscribe((evt: GatewayEventFrame) => {
        if (evt.event !== "approval.requested" && evt.event !== "approval.resolved") return;
        const rec = (evt.payload as { record?: ApprovalRow } | null)?.record;
        if (!rec?.id) return;
        this.apply(rec);
        if (evt.event === "approval.requested") {
          this.flash = true;
          setTimeout(() => (this.flash = false), 2400);
        }
      });
    }
    this.poll = setInterval(() => void this.load(), 15_000);
  }

  private unbind(): void {
    try {
      this.unsub?.();
    } catch {
      /* ignore */
    }
    this.unsub = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.boundClient = null;
  }

  private async load(): Promise<void> {
    if (!this.client) return;
    try {
      const [p, all] = (await Promise.all([
        req(this.client, "approvals.list", { status: "pending", limit: 50 }),
        req(this.client, "approvals.list", { status: "all", limit: 30 }),
      ])) as Array<{ approvals?: ApprovalRow[] }>;
      this.pending = (p?.approvals ?? []).sort((a, b) => a.expiresAt - b.expiresAt);
      this.recent = (all?.approvals ?? []).filter((r) => r.status !== "pending").slice(0, 8);
      this.now = Date.now();
      this.error = null;
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    }
  }

  private apply(rec: ApprovalRow): void {
    if (rec.status === "pending") {
      if (!this.pending.some((r) => r.id === rec.id)) {
        this.pending = [...this.pending, rec].sort((a, b) => a.expiresAt - b.expiresAt);
      }
      return;
    }
    this.pending = this.pending.filter((r) => r.id !== rec.id);
    this.recent = [rec, ...this.recent.filter((r) => r.id !== rec.id)].slice(0, 8);
  }

  private async decide(row: ApprovalRow, action: Action, withNote = false): Promise<void> {
    if (!this.client || this.busy.has(row.id)) return;
    const note = withNote ? (this.notes.get(row.id) ?? "").trim() : "";
    if (action === "redirect" && !note) {
      this.noteOpen = new Set([...this.noteOpen, row.id]);
      this.error = "Write the replacement instructions first.";
      return;
    }
    this.busy = new Set([...this.busy, row.id]);
    try {
      const res = (await req(this.client, "approvals.resolve", {
        id: row.id,
        action,
        ...(note ? { note } : {}),
      })) as { ok?: boolean; error?: string; message?: string; record?: ApprovalRow | null };
      if (res?.record) this.apply(res.record);
      if (!res?.ok) {
        this.error =
          res?.error === "already_resolved"
            ? `Already ${res.record?.status} by ${res.record?.decidedBy ?? "someone"} via ${res.record?.decidedVia ?? "?"}`
            : res?.error === "not_authorized"
              ? (res.message ?? "You can't approve this request")
              : (res?.error ?? "Could not resolve");
      } else {
        this.error = null;
        this.notes.delete(row.id);
      }
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
    } finally {
      const next = new Set(this.busy);
      next.delete(row.id);
      this.busy = next;
    }
  }

  private toggle(set: "noteOpen" | "detailsOpen", id: string): void {
    const next = new Set(this[set]);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this[set] = next;
  }

  render() {
    const count = this.pending.length;
    if (!count && !this.open) return nothing;
    return html`
      <button
        class="badge-btn ${count ? "has-pending" : ""} ${this.flash ? "flash" : ""}"
        data-learn-id="approvals-inbox"
        data-ib-target="control:topbar/approvals"
        @click=${() => (this.open = !this.open)}
        title=${count ? `${count} approval${count === 1 ? "" : "s"} waiting for you` : "Approvals"}
        aria-label="Approvals"
        aria-expanded=${this.open ? "true" : "false"}
        aria-haspopup="dialog"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        ${count ? html`<span class="count">${count > 99 ? "99+" : count}</span>` : nothing}
      </button>
      ${this.open ? this.renderPanel() : nothing}
    `;
  }

  private renderPanel() {
    return html`
      <div class="scrim" @click=${() => (this.open = false)}></div>
      <section class="panel" role="dialog" aria-label="Pending approvals" data-learn-id="approvals-panel" data-ib-target="modal:approvals">
        <header>
          <div>
            <h2>Approvals</h2>
            <p class="sub">
              ${this.pending.length
                ? `${this.pending.length} waiting · also sent to your Telegram`
                : "Nothing waiting on you"}
            </p>
          </div>
          <button class="icon" @click=${() => (this.open = false)} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        <div class="list">
          ${this.pending.length
            ? this.pending.map((r) => this.renderPending(r))
            : html`<div class="empty">You're all caught up. New requests appear here and on Telegram.</div>`}
          ${this.recent.length
            ? html`<h3>Recently resolved</h3>
                ${this.recent.map((r) => this.renderResolved(r))}`
            : nothing}
        </div>
      </section>
    `;
  }

  private renderPending(r: ApprovalRow) {
    const busy = this.busy.has(r.id);
    const isCheckpoint = r.source === "subagent-checkpoint";
    const canRedirect = r.options.includes("redirect");
    const canAlways = r.options.includes("approve-always");
    const noteOpen = this.noteOpen.has(r.id);
    const left = r.expiresAt - this.now;
    return html`
      <article class="card risk-${r.risk}">
        <div class="meta">
          <span class="chip risk">${r.risk}</span>
          <span class="chip">${SOURCE_LABEL[r.source] ?? r.source}</span>
          <span class="expires ${left < 5 * 60_000 ? "soon" : ""}" title="Expiry = deny">
            expires in ${fmtIn(left)}
          </span>
        </div>
        <h4>${r.title}</h4>
        ${r.requester?.label ? html`<div class="who">${r.requester.label}</div>` : nothing}
        ${r.summary ? html`<p class="summary">${r.summary}</p>` : nothing}
        ${r.details
          ? html`<button class="link" @click=${() => this.toggle("detailsOpen", r.id)}>
                ${this.detailsOpen.has(r.id) ? "Hide details" : "Show details"}
              </button>
              ${this.detailsOpen.has(r.id) ? html`<pre>${r.details}</pre>` : nothing}`
          : nothing}
        ${noteOpen
          ? html`<textarea
              rows="3"
              placeholder=${canRedirect ? "Replacement instructions (redirect) or a note…" : "Note for the requester…"}
              .value=${this.notes.get(r.id) ?? ""}
              @input=${(e: Event) => this.notes.set(r.id, (e.target as HTMLTextAreaElement).value)}
            ></textarea>`
          : nothing}
        <div class="actions">
          <button class="btn ok" ?disabled=${busy} @click=${() => this.decide(r, "approve", noteOpen)}>
            ${noteOpen ? "Approve with note" : canAlways ? "Allow once" : "Approve"}
          </button>
          ${canAlways
            ? html`<button class="btn" ?disabled=${busy} @click=${() => this.decide(r, "approve-always")}>Always</button>`
            : nothing}
          <button class="btn danger" ?disabled=${busy} @click=${() => this.decide(r, "deny", noteOpen)}>
            ${isCheckpoint ? "Stop" : noteOpen ? "Deny with note" : "Deny"}
          </button>
          ${noteOpen && canRedirect
            ? html`<button class="btn" ?disabled=${busy} @click=${() => this.decide(r, "redirect", true)}>Redirect</button>`
            : nothing}
          <button class="btn ghost" @click=${() => this.toggle("noteOpen", r.id)}>
            ${noteOpen ? "Cancel note" : canRedirect ? "Redirect…" : "Add note…"}
          </button>
        </div>
      </article>
    `;
  }

  private renderResolved(r: ApprovalRow) {
    const expired = r.decidedVia === "system";
    const label = expired
      ? r.reason === "gateway_restart"
        ? "closed (restart)"
        : "expired → denied"
      : r.status;
    return html`
      <div class="resolved status-${expired ? "expired" : r.status}">
        <span class="dot"></span>
        <span class="t">${r.title}</span>
        <span class="by">
          ${label}${!expired && r.decidedBy ? html` · ${r.decidedBy}` : nothing}${!expired && r.decidedVia && r.decidedVia !== r.decidedBy
            ? html` · ${r.decidedVia === "ui" ? "web" : r.decidedVia}`
            : nothing}${r.decidedAt ? html` · ${fmtClock(r.decidedAt)}` : nothing}
        </span>
      </div>
    `;
  }

  static styles = css`
    :host {
      position: relative;
      display: inline-flex;
      font: inherit;
      color: var(--text, #e8e8e8);
    }
    .badge-btn {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px 8px;
      border-radius: 999px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      background: var(--panel, rgba(255, 255, 255, 0.04));
      color: var(--muted, #aaa);
      cursor: pointer;
    }
    .badge-btn.has-pending {
      color: var(--accent, #d4af37);
      border-color: color-mix(in srgb, var(--accent, #d4af37) 55%, transparent);
      box-shadow: 0 0 12px var(--accent-glow, rgba(212, 175, 55, 0.3));
    }
    .badge-btn.flash {
      animation: pulse 0.8s ease-in-out 3;
    }
    @keyframes pulse {
      50% {
        box-shadow: 0 0 22px var(--accent, #d4af37);
      }
    }
    .badge-btn:focus-visible,
    .btn:focus-visible,
    .icon:focus-visible,
    .link:focus-visible {
      outline: 2px solid var(--ring, #d4af37);
      outline-offset: 2px;
    }
    .count {
      position: absolute;
      top: -6px;
      right: -6px;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 999px;
      background: var(--accent, #d4af37);
      color: var(--accent-foreground, #000);
      font-size: 10.5px;
      font-weight: 700;
      line-height: 17px;
      text-align: center;
      box-sizing: border-box;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 9998;
      background: rgba(0, 0, 0, 0.25);
    }
    .panel {
      position: fixed;
      top: 58px;
      right: 16px;
      z-index: 9999;
      width: min(440px, calc(100vw - 24px));
      max-height: min(78vh, 760px);
      display: flex;
      flex-direction: column;
      border-radius: 16px;
      border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.16));
      background: var(--popover, rgba(14, 14, 16, 0.96));
      color: var(--popover-foreground, var(--text, #eee));
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(18px);
      overflow: hidden;
    }
    /* Scroll cue: fade the bottom edge so a clipped card reads as "more below". */
    .panel::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 28px;
      pointer-events: none;
      background: linear-gradient(to bottom, transparent, var(--popover, rgba(14, 14, 16, 0.96)));
      border-radius: 0 0 16px 16px;
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 16px 12px;
      border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    }
    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
    .sub {
      margin: 2px 0 0;
      font-size: 12px;
      color: var(--muted, #999);
    }
    .icon {
      border: none;
      background: transparent;
      color: var(--muted, #999);
      cursor: pointer;
      padding: 6px;
      border-radius: 8px;
    }
    .icon:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.06));
    }
    .error {
      margin: 10px 16px 0;
      padding: 8px 10px;
      border-radius: 8px;
      font-size: 12px;
      background: var(--danger-subtle, rgba(220, 60, 60, 0.12));
      color: var(--danger, #ff6b6b);
    }
    .list {
      overflow-y: auto;
      padding: 12px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .empty {
      padding: 22px 8px;
      text-align: center;
      font-size: 13px;
      color: var(--muted, #999);
    }
    .card {
      border-radius: 12px;
      padding: 12px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
      border-left: 3px solid var(--warn, #e0a82e);
      background: var(--card, rgba(255, 255, 255, 0.03));
    }
    .card.risk-low {
      border-left-color: var(--ok, #3fb950);
    }
    .card.risk-high {
      border-left-color: #f0883e;
    }
    .card.risk-critical {
      border-left-color: var(--danger, #f85149);
    }
    .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      font-size: 11px;
    }
    .chip {
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--bg-muted, rgba(255, 255, 255, 0.06));
      color: var(--muted-strong, #bbb);
    }
    .chip.risk {
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .risk-critical .chip.risk {
      background: var(--danger-subtle, rgba(248, 81, 73, 0.15));
      color: var(--danger, #f85149);
    }
    .risk-high .chip.risk {
      background: rgba(240, 136, 62, 0.15);
      color: #f0883e;
    }
    .expires {
      margin-left: auto;
      color: var(--muted, #999);
    }
    .expires.soon {
      color: var(--danger, #f85149);
    }
    h4 {
      margin: 8px 0 2px;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .who {
      font-size: 12px;
      color: var(--muted, #999);
    }
    .summary {
      margin: 6px 0 0;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text, #ddd);
      overflow-wrap: anywhere;
    }
    .link {
      margin-top: 6px;
      padding: 0;
      border: none;
      background: none;
      color: var(--accent, #d4af37);
      font-size: 12px;
      cursor: pointer;
    }
    pre {
      margin: 6px 0 0;
      max-height: 200px;
      overflow: auto;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--bg, #0b0b0c);
      border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
      font-size: 11.5px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--input, rgba(255, 255, 255, 0.14));
      background: var(--bg, #0b0b0c);
      color: var(--text, #eee);
      font: inherit;
      font-size: 13px;
      resize: vertical;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .btn {
      min-height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.16));
      background: var(--bg-elevated, rgba(255, 255, 255, 0.05));
      color: var(--text, #eee);
      font: inherit;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn:hover:not([disabled]) {
      background: var(--bg-hover, rgba(255, 255, 255, 0.1));
    }
    .btn[disabled] {
      opacity: 0.55;
      cursor: progress;
    }
    .btn.ok {
      background: var(--accent, #d4af37);
      border-color: var(--accent, #d4af37);
      color: var(--accent-foreground, #000);
    }
    .btn.ok:hover:not([disabled]) {
      background: var(--accent-hover, #fdb931);
    }
    .btn.danger {
      color: var(--danger, #f85149);
      border-color: color-mix(in srgb, var(--danger, #f85149) 45%, transparent);
    }
    .btn.ghost {
      border-color: transparent;
      background: transparent;
      color: var(--muted, #aaa);
    }
    h3 {
      margin: 8px 0 0;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted, #888);
    }
    .resolved {
      display: grid;
      grid-template-columns: 8px 1fr;
      column-gap: 8px;
      align-items: center;
      font-size: 12.5px;
    }
    .resolved .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted, #888);
    }
    .status-approved .dot {
      background: var(--ok, #3fb950);
    }
    .status-denied .dot {
      background: var(--danger, #f85149);
    }
    .status-redirected .dot {
      background: var(--accent, #d4af37);
    }
    .resolved .t {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .resolved .by {
      grid-column: 2;
      font-size: 11.5px;
      color: var(--muted, #999);
    }
    @media (max-width: 640px) {
      /* The phone topbar is already full — float the badge bottom-right
         (thumb reach) instead of squeezing it between topbar pills. */
      :host {
        width: 0;
        overflow: visible;
      }
      .badge-btn {
        position: fixed;
        right: 16px;
        bottom: calc(18px + env(safe-area-inset-bottom, 0px));
        z-index: 9997;
        width: 48px;
        height: 48px;
        padding: 0;
        background: var(--popover, rgba(14, 14, 16, 0.96));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 14px var(--accent-glow, rgba(212, 175, 55, 0.3));
      }
      .badge-btn svg {
        width: 20px;
        height: 20px;
      }
      .panel {
        top: auto;
        bottom: 0;
        right: 0;
        left: 0;
        width: 100%;
        max-height: 85vh;
        border-radius: 16px 16px 0 0;
      }
      .btn {
        min-height: 40px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .badge-btn.flash {
        animation: none;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "approvals-inbox": ApprovalsInbox;
  }
}
