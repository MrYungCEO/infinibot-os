/**
 * <proactive-popups> — Proactive Pop-Up System INLINE feed (web).
 *
 * History/log surface only: renders the Signals feed with filter chips +
 * per-row actions. The floating toast/modal orchestration, signal production,
 * and the global keyboard model now live in the single app-shell mount,
 * <proactive-overlay-host> — this component is purely the inline list embedded
 * in <proactive-panel> (dashboard / discipline). It keeps its own read-only
 * subscription so the feed updates live.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import {
  TIER_META,
  agentColor,
  whyChipTitle,
  type PopupAction,
  type PopupEvent,
  type PopupState,
} from "./proactive-popup-shared.js";

type Filter = "all" | "pending" | "acted" | "snoozed" | "dismissed";
const FILTERS: Filter[] = ["all", "pending", "acted", "snoozed", "dismissed"];

@customElement("proactive-popups")
export class ProactivePopups extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private events: PopupEvent[] = [];
  @state() private filter: Filter = "all";
  @state() private error: string | null = null;
  @state() private expanded = new Set<string>();
  @state() private replyFor: string | null = null;
  private replyText = "";

  private unsub: (() => void) | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadFeed();
    if (this.client) this.unsub = this.client.subscribe((e) => this.onEvent(e));
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
  }
  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client) {
      this.unsub?.();
      this.unsub = this.client.subscribe((e) => this.onEvent(e));
      void this.loadFeed();
    }
  }

  private async loadFeed(): Promise<void> {
    if (!this.client) return;
    try {
      const res = (await this.client.request("proactive.subscribe", { limit: 100 })) as {
        events?: PopupEvent[];
      };
      if (Array.isArray(res?.events)) this.events = res.events;
    } catch (e) {
      console.error("[proactive-popups] feed load failed:", e);
    }
  }

  private onEvent(frame: GatewayEventFrame): void {
    if (frame.event !== "proactive.event" && frame.event !== "proactive.updated") return;
    const ev = (frame.payload as { event?: PopupEvent })?.event;
    if (!ev?.id) return;
    this.mergeEvent(ev);
  }

  private mergeEvent(ev: PopupEvent): void {
    const idx = this.events.findIndex((e) => e.id === ev.id);
    if (idx >= 0) {
      const next = this.events.slice();
      next[idx] = ev;
      this.events = next;
    } else {
      this.events = [ev, ...this.events];
    }
  }

  // ── action handling (optimistic + revert) ─────────────────────────────────

  private async handleAction(ev: PopupEvent, action: PopupAction): Promise<void> {
    if (action.kind === "readmore") {
      this.toggleExpand(ev.id);
      return;
    }
    if (action.kind === "reply") {
      this.replyFor = this.replyFor === ev.id ? null : ev.id;
      this.replyText = "";
      return;
    }
    const prev = this.events.find((e) => e.id === ev.id);
    const optimisticState: PopupState =
      action.kind === "snooze" ? "snoozed" : action.kind === "dismiss" ? "dismissed" : "acted";
    this.mergeEvent({ ...ev, state: optimisticState, ackAction: action.id });
    this.error = null;

    try {
      await this.runAction(ev, action);
    } catch (e) {
      if (prev) this.mergeEvent(prev); // revert
      this.error = `${action.label} failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async runAction(ev: PopupEvent, action: PopupAction): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("not connected");
    const p = action.payload ?? {};

    switch (action.kind) {
      case "snooze": {
        const duration = (p.duration as string) || "1h";
        await client.request("proactive.snooze", { id: ev.id, duration });
        return;
      }
      case "dismiss": {
        const reason =
          (p.reason as string) ||
          window.prompt("Dismiss reason (logged for oversight):", "") ||
          "dismissed";
        await client.request("proactive.dismiss", { id: ev.id, reason });
        return;
      }
      case "complete": {
        const cardId = (p.cardId as string) || ev.attribution.cardId;
        if (cardId) {
          // Verifier gate is enforced server-side by the kanban update path.
          await client.request("kanban.tasks.update", {
            id: cardId,
            patch: { status: "done", done: true },
          });
        }
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      case "spawn": {
        const task = (p.task as string) || ev.body || ev.title;
        await client.request("sessions.spawn", {
          task,
          agentId: (p.agentId as string) || "coder",
          label: ev.title.slice(0, 60),
        });
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      case "open": {
        const target = (p.target as string) || (p.href as string);
        if (target) window.location.hash = target.startsWith("#") ? target : `#/${target}`;
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      default: {
        await client.request("proactive.ack", { id: ev.id, action: action.id });
      }
    }
  }

  private async sendReply(ev: PopupEvent): Promise<void> {
    const text = this.replyText.trim();
    if (!text) return;
    this.replyFor = null;
    try {
      await this.client?.request("proactive.ack", {
        id: ev.id,
        action: "reply",
        reasonOpt: text,
      });
      this.mergeEvent({ ...ev, state: "acted", ackAction: "reply" });
    } catch (e) {
      this.error = `Reply failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private toggleExpand(id: string): void {
    const next = new Set(this.expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    this.expanded = next;
  }

  private showWhy(ev: PopupEvent): void {
    // Reasoning log lives in the attribution chip tooltip; surface it explicitly.
    window.alert(whyChipTitle(ev));
  }

  // ── render ──────────────────────────────────────────────────────────────────

  private filtered(): PopupEvent[] {
    const all = [...this.events].sort((a, b) => b.createdAt - a.createdAt);
    if (this.filter === "all") return all;
    if (this.filter === "pending") return all.filter((e) => e.state === "pending");
    return all.filter((e) => e.state === this.filter);
  }

  render() {
    return html`
      <div class="px-root">
        ${this.error ? html`<div class="px-err">${this.error}</div>` : nothing}
        <div class="px-head">
          <span class="px-title">Signals</span>
          <div class="px-chips">
            ${FILTERS.map(
              (f) => html`<button
                class="px-chip ${this.filter === f ? "active" : ""}"
                @click=${() => (this.filter = f)}
              >
                ${f}${f === "all" ? ` (${this.events.length})` : nothing}
              </button>`,
            )}
          </div>
        </div>
        ${this.renderFeed()}
      </div>
    `;
  }

  private renderFeed() {
    const rows = this.filtered();
    if (rows.length === 0)
      return html`<div class="px-empty">No signals${this.filter !== "all" ? ` (${this.filter})` : ""}.</div>`;
    return html`<div class="px-feed">${rows.map((ev) => this.renderRow(ev))}</div>`;
  }

  private renderRow(ev: PopupEvent) {
    const meta = TIER_META[ev.appliedTier];
    const color = agentColor(ev.attribution.agentId);
    const isOpen = this.expanded.has(ev.id);
    const long = ev.body.length > 140;
    return html`
      <div class="px-row" style="--tier:${meta.color}">
        <span class="px-glyph" title=${meta.label}>${meta.glyph}</span>
        <div class="px-main">
          <div class="px-row-title">
            ${ev.title}
            <span class="px-state px-state-${ev.state}">${ev.state}</span>
          </div>
          ${ev.body
            ? html`<div class="px-body ${isOpen ? "open" : ""}">${ev.body}</div>`
            : nothing}
          <div class="px-meta">
            <span class="px-chipattr" style="--ac:${color}" title=${whyChipTitle(ev)}>
              <span class="px-dot"></span>${ev.attribution.agentName || ev.attribution.agentId}
            </span>
            ${ev.requestedTier !== ev.appliedTier
              ? html`<span class="px-dg" title="downgraded by routing"
                  >${ev.requestedTier}→${ev.appliedTier}</span
                >`
              : nothing}
            <button class="px-why" @click=${() => this.showWhy(ev)}>Why?</button>
          </div>
          ${this.replyFor === ev.id ? this.renderReply(ev) : nothing}
          <div class="px-actions">
            ${(ev.actions ?? []).map(
              (a) => html`<button
                class="px-btn ${a.primary ? "px-btn-primary" : ""}"
                ?disabled=${ev.state !== "pending" && a.kind !== "open" && a.kind !== "readmore"}
                @click=${() => this.handleAction(ev, a)}
              >
                ${a.label}
              </button>`,
            )}
            ${long
              ? html`<button class="px-btn px-btn-ghost" @click=${() => this.toggleExpand(ev.id)}>
                  ${isOpen ? "Read less" : "Read more"}
                </button>`
              : nothing}
          </div>
        </div>
      </div>
    `;
  }

  private renderReply(ev: PopupEvent) {
    return html`
      <div class="px-reply">
        <textarea
          class="px-ta"
          placeholder="Draft a reply…"
          @input=${(e: Event) => (this.replyText = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <button class="px-btn px-btn-primary" @click=${() => this.sendReply(ev)}>Send</button>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    .px-root {
      border: 1px solid var(--g-border, rgba(212, 175, 55, 0.18));
      border-radius: 14px;
      background: var(--g-surface, rgba(18, 20, 30, 0.55));
      backdrop-filter: blur(8px);
      padding: 14px 16px;
    }
    .px-err {
      background: rgba(239, 68, 68, 0.14);
      color: #f87171;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 0.78rem;
      margin-bottom: 10px;
    }
    .px-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .px-title {
      font-size: 0.8rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--g-accent, #d4af37);
    }
    .px-chips {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
    }
    .px-chip {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      border-radius: 999px;
      padding: 3px 11px;
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: capitalize;
      cursor: pointer;
    }
    .px-chip.active {
      background: var(--g-accent, #d4af37);
      color: #000;
      border-color: var(--g-accent, #d4af37);
    }
    .px-empty {
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.5));
      font-size: 0.8rem;
      padding: 8px 2px;
    }
    .px-feed {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .px-row {
      display: flex;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-left: 3px solid var(--tier, #94a3b8);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.02);
    }
    .px-glyph {
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .px-main {
      flex: 1;
      min-width: 0;
    }
    .px-row-title {
      font-weight: 700;
      color: var(--g-fg, #f5eacd);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .px-state {
      font-size: 0.58rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 1px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.08);
      color: rgba(245, 234, 205, 0.6);
    }
    .px-state-pending {
      background: rgba(96, 165, 250, 0.18);
      color: #60a5fa;
    }
    .px-state-acted {
      background: rgba(52, 211, 153, 0.18);
      color: #34d399;
    }
    .px-state-snoozed {
      background: rgba(251, 191, 36, 0.18);
      color: #fbbf24;
    }
    .px-state-dismissed {
      background: rgba(148, 163, 184, 0.16);
      color: #94a3b8;
    }
    .px-body {
      font-size: 0.78rem;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.7));
      margin-top: 3px;
      max-height: 2.6em;
      overflow: hidden;
    }
    .px-body.open {
      max-height: none;
      white-space: pre-wrap;
    }
    .px-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      flex-wrap: wrap;
    }
    .px-chipattr {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.66rem;
      font-weight: 700;
      color: var(--ac, #d4af37);
      background: color-mix(in srgb, var(--ac, #d4af37) 16%, transparent);
      border-radius: 6px;
      padding: 1px 7px;
      cursor: help;
    }
    .px-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ac, #d4af37);
    }
    .px-dg {
      font-size: 0.64rem;
      color: rgba(245, 234, 205, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 0 5px;
    }
    .px-why {
      background: none;
      border: none;
      color: rgba(245, 234, 205, 0.5);
      font-size: 0.66rem;
      cursor: pointer;
      text-decoration: underline dotted;
    }
    .px-why:hover {
      color: #f5eacd;
    }
    .px-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 9px;
    }
    .px-btn {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #f5eacd;
      border-radius: 7px;
      padding: 5px 11px;
      font-size: 0.74rem;
      font-weight: 700;
      cursor: pointer;
    }
    .px-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.13);
    }
    .px-btn:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .px-btn-primary {
      background: var(--g-accent, #d4af37);
      color: #000;
      border-color: var(--g-accent, #d4af37);
    }
    .px-btn-ghost {
      background: none;
    }
    .px-reply {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      align-items: flex-end;
    }
    .px-ta {
      flex: 1;
      min-height: 52px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: #f5eacd;
      border-radius: 8px;
      padding: 7px 10px;
      font-size: 0.8rem;
      resize: vertical;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-popups": ProactivePopups;
  }
}
