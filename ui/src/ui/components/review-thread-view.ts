/**
 * <review-thread-view> — the threaded worker ↔ Auditor review conversation
 * for one run. Shared by the mesh review panel and the run detail surfaces
 * (completion-verdict embeds a compact copy).
 *
 * Either pass `.thread` (mesh panel, already loaded by the ReviewFeed) or
 * `.runId` + `.client` and it loads `review.thread.get` itself. Renders nothing
 * in compact/self-loading mode when the run has no thread (older gateways).
 *
 * Events (bubbling, composed):
 *   review-replay      {runId}            Replay button
 *   review-open-shot   {runId, path}      screenshot thumbnail click
 */

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { icons } from "../icons";
import { screenshotFullUrl, screenshotThumbUrl } from "../lib/review-mesh/feed";
import {
  KIND_LABEL,
  TONE_CSS,
  agentDisplayName,
  clockTime,
  needsOwner,
  packetTone,
  verdictLabel,
  verdictTone,
  type StoredThread,
} from "../lib/review-mesh/model";
import type { ReviewMessage, ReviewThread } from "../lib/review-mesh/types";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown>; supports?: (m: string) => boolean };

export type ShotResolver = (path: string) => { thumb: string; full: string } | null;

const STATUS_TONE: Record<string, string> = {
  pass: TONE_CSS.green,
  fail: TONE_CSS.red,
  warn: TONE_CSS.amber,
  skipped: TONE_CSS.slate,
};

@customElement("review-thread-view")
export class ReviewThreadView extends LitElement {
  @property({ attribute: false }) thread: StoredThread | null = null;
  @property({ type: String }) runId = "";
  @property({ attribute: false }) client: Requester | null = null;
  @property({ type: Boolean }) compact = false;
  /** Show the Replay button (the mesh panel handles the event). */
  @property({ type: Boolean, attribute: "replayable" }) replayable = false;
  @property({ attribute: false }) resolveShot: ShotResolver | null = null;
  /** Message id to highlight (clicked packet). */
  @property({ type: String }) focusId = "";

  @state() private loaded: StoredThread | null = null;
  @state() private loading = false;
  @state() private expanded = false;
  private loadedFor = "";
  private pinnedDecision = "";

  static styles = css`
    :host {
      display: block;
      color: var(--g-fg, #e8e6e3);
      font: inherit;
      font-size: 12.5px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .head__title {
      font-weight: 600;
      font-size: 13px;
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .compact-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--g-fg-dim, #9aa2b1);
      margin-bottom: 8px;
      cursor: pointer;
      user-select: none;
    }
    .compact-head svg {
      width: 13px;
      height: 13px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .badge svg {
      width: 11px;
      height: 11px;
    }
    .meta {
      color: var(--g-fg-dim, #9aa2b1);
      font-size: 11px;
    }
    button.btn {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      color: var(--g-fg, #e8e6e3);
      font-size: 11.5px;
      min-height: 22px;
    }
    button.btn:hover,
    button.btn:focus-visible {
      border-color: var(--g-primary, #d4af37);
      color: var(--g-primary, #d4af37);
    }
    button.btn svg {
      width: 12px;
      height: 12px;
    }
    .msgs {
      display: grid;
      gap: 8px;
      position: relative;
    }
    .msg {
      position: relative;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.1));
      border-left: 3px solid var(--tone);
      border-radius: 10px;
      padding: 8px 10px;
      background: color-mix(in srgb, var(--tone) 6%, var(--g-surface, rgba(255, 255, 255, 0.03)));
      min-width: 0;
    }
    .msg.from-reviewer {
      margin-left: 18px;
    }
    .msg.from-worker {
      margin-right: 18px;
    }
    .msg.is-action {
      margin-left: 30px;
      padding: 6px 10px;
      border-style: dashed;
      border-left-style: solid;
    }
    .msg.is-focus {
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--tone) 60%, transparent);
    }
    .msg__head {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      font-size: 11px;
      color: var(--g-fg-dim, #9aa2b1);
    }
    .chip {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 1px 7px;
      border-radius: 999px;
      color: var(--tone);
      border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
      background: color-mix(in srgb, var(--tone) 12%, transparent);
    }
    .route {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .route b {
      color: var(--g-fg, #e8e6e3);
      font-weight: 600;
    }
    .ts {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }
    .msg__title {
      margin-top: 4px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .msg__text {
      margin-top: 3px;
      color: var(--g-fg-dim, #b9bfca);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.45;
    }
    ul.items {
      margin: 6px 0 0;
      padding-left: 18px;
      display: grid;
      gap: 2px;
      overflow-wrap: anywhere;
    }
    .rows {
      margin-top: 6px;
      display: grid;
      gap: 3px;
    }
    .row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: 11.5px;
      min-width: 0;
    }
    .row .k {
      color: var(--g-fg-dim, #9aa2b1);
      flex: none;
      min-width: 64px;
    }
    .row .ref {
      font-family: var(--g-mono-family, ui-monospace, "SF Mono", monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1 1 auto;
    }
    .row .cwd {
      color: var(--g-fg-faint, #71717a);
      font-size: 10.5px;
      flex: none;
    }
    .st {
      flex: none;
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0 6px;
      border-radius: 999px;
      border: 1px solid currentColor;
    }
    .shots {
      margin-top: 6px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .shot {
      all: unset;
      cursor: zoom-in;
      width: 96px;
      height: 60px;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.14));
      background: rgba(0, 0, 0, 0.3);
      display: grid;
      place-items: center;
      color: var(--g-fg-faint, #71717a);
    }
    .shot img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .shot:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
    }
    .escalation {
      margin-top: 8px;
      border: 1px solid color-mix(in srgb, #e879f9 60%, transparent);
      background: color-mix(in srgb, #e879f9 12%, transparent);
      border-radius: 8px;
      padding: 8px 10px;
    }
    .escalation__h {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      color: #e879f9;
      font-size: 11.5px;
    }
    .escalation__h svg {
      width: 13px;
      height: 13px;
    }
    .escalation__d {
      margin-top: 4px;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .escalation__r {
      margin-top: 2px;
      color: var(--g-fg-dim, #b9bfca);
      font-size: 11.5px;
    }
    .notes {
      margin-top: 6px;
      color: var(--g-fg-faint, #8a8f99);
      font-size: 11px;
      font-style: italic;
    }
    .empty {
      color: var(--g-fg-dim, #9aa2b1);
      font-size: 12px;
      padding: 6px 0;
    }
    .more {
      margin-top: 6px;
    }
  `;

  override updated(changed: Map<string, unknown>): void {
    if ((changed.has("runId") || changed.has("client")) && !this.thread && this.runId && this.client && this.loadedFor !== this.runId) {
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const c = this.client;
    const runId = this.runId;
    if (!c || !runId) return;
    if (typeof c.supports === "function" && !c.supports("review.thread.get")) return;
    this.loadedFor = runId;
    this.loading = true;
    try {
      const t = (await c.request("review.thread.get", { runId })) as ReviewThread | null;
      if (runId !== this.runId) return;
      this.loaded = t && t.summary ? { summary: t.summary, messages: t.messages ?? [], complete: true } : null;
    } catch {
      this.loaded = null;
    } finally {
      this.loading = false;
    }
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private shot(path: string): { thumb: string; full: string } {
    return this.resolveShot?.(path) ?? { thumb: screenshotThumbUrl(path), full: screenshotFullUrl(path) };
  }

  private renderMessage(m: ReviewMessage, label: string): TemplateResult {
    const tone = TONE_CSS[packetTone(m)];
    const from = m.from === "reviewer" ? "Auditor" : agentDisplayName(m.fromAgent, label);
    const to = m.kind === "action" ? "self" : m.to === "reviewer" ? "Auditor" : agentDisplayName(m.toAgent, label);
    const cls = `msg from-${m.from} ${m.kind === "action" ? "is-action" : ""} ${this.focusId === m.id ? "is-focus" : ""}`;
    return html`
      <article class=${cls} style="--tone:${tone}" data-msg-id=${m.id}>
        <div class="msg__head">
          <span class="chip">${m.kind === "verdict" && m.verdict ? verdictLabel(m.verdict) : KIND_LABEL[m.kind] ?? m.kind}</span>
          <span class="route"><b>${from}</b> → <b>${to}</b></span>
          <span class="meta">R${m.round}</span>
          <span class="ts" title=${new Date(m.ts).toLocaleString()}>${clockTime(m.ts)}</span>
        </div>
        <div class="msg__title">${m.title}</div>
        ${m.text && m.text !== m.title && !this.compact ? html`<div class="msg__text">${m.text}</div>` : nothing}
        ${m.items?.length ? html`<ul class="items">${m.items.map((i) => html`<li>${i}</li>`)}</ul>` : nothing}
        ${m.evidence?.length
          ? html`<div class="rows">
              ${m.evidence.map(
                (e) => html`<div class="row">
                  <span class="k">${e.kind}</span>
                  <span class="ref" title=${e.detail ? `${e.ref} — ${e.detail}` : e.ref}>${e.ref}${e.detail ? html` <span class="meta">${e.detail}</span>` : nothing}</span>
                  ${e.cwd ? html`<span class="cwd">cwd ${e.cwd}</span>` : nothing}
                  ${e.status ? html`<span class="st" style="color:${STATUS_TONE[e.status] ?? TONE_CSS.slate}">${e.status}</span>` : nothing}
                </div>`,
              )}
            </div>`
          : nothing}
        ${m.actions?.length
          ? html`<div class="rows">
              ${m.actions.map(
                (a) => html`<div class="row">
                  <span class="k">${a.kind}</span>
                  <span class="ref" title=${a.detail}>${a.detail}</span>
                  ${a.cwd ? html`<span class="cwd">cwd ${a.cwd}</span>` : nothing}
                  <span class="st" style="color:${STATUS_TONE[a.status] ?? TONE_CSS.slate}">${a.status}</span>
                </div>`,
              )}
            </div>`
          : nothing}
        ${m.screenshots?.length
          ? html`<div class="shots">
              ${m.screenshots.slice(0, this.compact ? 3 : 8).map((p) => {
                const s = this.shot(p);
                return html`<button
                  class="shot"
                  title="Open screenshot"
                  @click=${() => this.emit("review-open-shot", { runId: m.runId, path: p, full: s.full })}
                >
                  <img src=${s.thumb} alt="Screenshot" loading="lazy" decoding="async" />
                </button>`;
              })}
            </div>`
          : nothing}
        ${m.escalation && m.escalation.decision === this.pinnedDecision
          ? html`<div class="notes" style="font-style:normal;color:#e879f9">Owner decision pinned above.</div>`
          : m.escalation
          ? html`<div class="escalation" role="note">
              <div class="escalation__h">${icons.alert} Owner decision needed</div>
              <div class="escalation__d">${m.escalation.decision}</div>
              <div class="escalation__r">${m.escalation.category.replace(/_/g, " ")}: ${m.escalation.reason}</div>
            </div>`
          : nothing}
        ${m.notes?.length && !this.compact ? html`<div class="notes">${m.notes.join(" · ")}</div>` : nothing}
      </article>
    `;
  }

  override render() {
    const t = this.thread ?? this.loaded;
    if (!t) {
      if (this.compact) return this.loading ? html`<div class="empty">Loading review thread…</div>` : nothing;
      return html`<div class="empty">${this.loading ? "Loading review thread…" : "No review messages yet."}</div>`;
    }
    const s = t.summary;
    const vt = TONE_CSS[s.verdict ? verdictTone(s.verdict) : needsOwner(s) ? "magenta" : "slate"];
    const msgs = t.messages;
    // The owner's decision is the most important line in an escalated thread:
    // pin it above the conversation (the verdict message then just refers to it).
    let pinnedEsc = s.escalation ?? null;
    for (let i = msgs.length - 1; i >= 0 && !pinnedEsc; i--) pinnedEsc = msgs[i].escalation ?? null;
    this.pinnedDecision = pinnedEsc?.decision ?? "";
    const limit = this.compact && !this.expanded ? 4 : msgs.length;
    const shown = msgs.slice(Math.max(0, msgs.length - limit));
    if (this.compact && !msgs.length) return nothing;
    return html`
      ${this.compact
        ? html`<div class="compact-head">${icons.shield} Review thread · ${msgs.length} messages
            <span class="badge" style="color:${vt}">${s.verdict ? verdictLabel(s.verdict) : needsOwner(s) ? "Owner decision" : "In review"}</span>
          </div>`
        : html`<div class="head">
            <span class="head__title" title=${s.label}>${s.label || s.runId}</span>
            <span class="badge" style="color:${vt}">
              ${s.verdict === "VERIFIED" ? icons.check : nothing}
              ${s.verdict ? verdictLabel(s.verdict) : needsOwner(s) ? "Owner decision" : "In review"}
            </span>
            ${this.replayable && msgs.length
              ? html`<button class="btn" title="Replay this conversation on the map" @click=${() => this.emit("review-replay", { runId: s.runId })}>
                  ${icons.play} Replay
                </button>`
              : nothing}
          </div>
          <div class="meta" style="margin:-4px 0 10px">
            ${s.rounds} round${s.rounds === 1 ? "" : "s"} · ${msgs.length} messages · state ${s.state}${s.backend ? ` · ${s.backend}` : ""}
          </div>`}
      ${pinnedEsc
        ? html`<div class="escalation" role="note" style="margin:0 0 10px">
            <div class="escalation__h">${icons.alert} Owner decision needed</div>
            <div class="escalation__d">${pinnedEsc.decision}</div>
            <div class="escalation__r">${pinnedEsc.category.replace(/_/g, " ")}: ${pinnedEsc.reason}</div>
          </div>`
        : nothing}
      <div class="msgs">
        ${msgs.length === 0 ? html`<div class="empty">Loading messages…</div>` : nothing}
        ${shown.map((m) => this.renderMessage(m, s.label))}
      </div>
      ${this.compact && msgs.length > limit
        ? html`<div class="more"><button class="btn" @click=${() => (this.expanded = true)}>Show all ${msgs.length}</button></div>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "review-thread-view": ReviewThreadView;
  }
}
