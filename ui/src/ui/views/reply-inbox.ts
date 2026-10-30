/**
 * Reply Inbox — triage view for AI-classified lead replies sorted by urgency.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplyClass =
  | "interested"
  | "not_interested"
  | "unsubscribe"
  | "oof"
  | "question"
  | "unknown";

export type ReplyUrgency = "high" | "medium" | "low";

export interface LeadReply {
  id: string;
  leadId: string;
  leadName: string;
  leadEmail?: string;
  messageId: string;
  threadId?: string;
  subject: string;
  bodyPreview: string;
  receivedAt: string;
  class: ReplyClass;
  urgency: ReplyUrgency;
  suggestedAction: string;
  confidence: number;
  handled: boolean;
  campaignId?: string;
  campaignName?: string;
}

export interface ReplyInboxState {
  loading: boolean;
  replies: LeadReply[];
  error: string | null;
  filterClass: ReplyClass | null;
  filterUrgency: ReplyUrgency | null;
  showHandled: boolean;
  selectedReplyId: string | null;
}

export function createReplyInboxState(): ReplyInboxState {
  return {
    loading: false,
    replies: [],
    error: null,
    filterClass: null,
    filterUrgency: null,
    showHandled: false,
    selectedReplyId: null,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CLASS_CONFIG: Record<ReplyClass, { label: string; color: string; icon: string }> = {
  interested: { label: "Interested", color: "#10b981", icon: "bolt" },
  not_interested: { label: "Not Interested", color: "#f87171", icon: "close" },
  unsubscribe: { label: "Unsubscribe", color: "#6b7280", icon: "alert" },
  oof: { label: "Out of Office", color: "#f59e0b", icon: "mail" },
  question: { label: "Question", color: "#60a5fa", icon: "search" },
  unknown: { label: "Unknown", color: "#94a3b8", icon: "tag" },
};

const URGENCY_CONFIG: Record<ReplyUrgency, { label: string; color: string }> = {
  high: { label: "High", color: "#ef4444" },
  medium: { label: "Medium", color: "#f59e0b" },
  low: { label: "Low", color: "#94a3b8" },
};

// ── Render ────────────────────────────────────────────────────────────────────

export function renderReplyInbox(
  state: ReplyInboxState,
  _client: GatewayBrowserClient,
  _appState: AppViewState,
  handlers: {
    onLoad: () => void;
    onMarkHandled: (replyId: string) => void;
    onSelect: (replyId: string | null) => void;
    onFilterClass: (cls: ReplyClass | null) => void;
    onFilterUrgency: (urgency: ReplyUrgency | null) => void;
    onToggleShowHandled: () => void;
  },
) {
  ensureCommunicationGlassStyles();
  const filtered = _applyFilters(state);
  const unhandledCount = state.replies.filter((r) => !r.handled).length;
  const highCount = state.replies.filter((r) => r.urgency === "high" && !r.handled).length;

  return html`
    <div class="inbox-page">
      <div class="inbox-header g-panel g-noise">
        <div>
          <h1 class="g-title" style="color:var(--glass-fg)">Reply Inbox</h1>
          <p class="inbox-subtitle" style="color:var(--glass-fg-2)">
            ${unhandledCount} unhandled
            ${highCount > 0 ? html`· <span class="inbox-high-badge">${highCount} urgent</span>` : nothing}
          </p>
        </div>
        <div class="inbox-header-actions">
          <button class="lp-btn lp-btn-ghost g-btn g-btn--ghost" @click=${handlers.onLoad}>${commIcon("refresh", 15)} Refresh</button>
          <label class="inbox-toggle" style="color:var(--glass-fg-2)">
            <input
              type="checkbox"
              ?checked=${state.showHandled}
              @change=${handlers.onToggleShowHandled}
            />
            Show handled
          </label>
        </div>
      </div>

      <div class="inbox-filters g-glass" style="padding:10px 12px">
        ${_renderFilterChips(state, handlers)}
      </div>

      ${state.error ? html`<div class="lp-error">${state.error}</div>` : nothing}

      ${state.loading && state.replies.length === 0
        ? html`<div class="lp-loading"><span class="lp-spinner lg"></span><p>Loading replies…</p></div>`
        : html`
          <div class="inbox-list">
            ${filtered.length === 0
              ? html`<div class="inbox-empty g-panel">
                  <p>${commIcon("check", 22)} Inbox clear</p>
                  <p class="inbox-empty-sub">Replies from leads will appear here after classification.</p>
                </div>`
              : filtered.map((r) => _renderReplyRow(r, state, handlers))}
          </div>
        `}

      ${state.selectedReplyId
        ? _renderReplyDetail(
            state.replies.find((r) => r.id === state.selectedReplyId) ?? null,
            handlers,
          )
        : nothing}
      <style>
        @media (max-width: 640px) {
          .inbox-page { padding: 8px; overflow-y: auto; }
          .inbox-header { flex-direction: column; gap: 12px; }
          .inbox-header-actions { width: 100%; justify-content: space-between; }
          .inbox-filters { overflow-x: auto; }
          .filter-chips { flex-wrap: nowrap; width: max-content; }
          .inbox-list { overflow: visible; }
          .inbox-row-right { width: 100%; flex-wrap: wrap; padding-left: 30px; }
          .inbox-detail-row { padding-left: 16px; }
          .inbox-full-detail { flex-shrink: 0; }
        }
      </style>
    </div>
  `;
}

function _applyFilters(state: ReplyInboxState): LeadReply[] {
  let replies = state.replies;
  if (!state.showHandled) replies = replies.filter((r) => !r.handled);
  if (state.filterClass) replies = replies.filter((r) => r.class === state.filterClass);
  if (state.filterUrgency) replies = replies.filter((r) => r.urgency === state.filterUrgency);
  // Sort by urgency: high → medium → low, then by receivedAt desc
  const urgencyOrder: Record<ReplyUrgency, number> = { high: 0, medium: 1, low: 2 };
  return [...replies].sort((a, b) => {
    const uDiff = urgencyOrder[a.urgency] - urgencyOrder[b.urgency];
    if (uDiff !== 0) return uDiff;
    return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
  });
}

function _renderFilterChips(
  state: ReplyInboxState,
  handlers: Parameters<typeof renderReplyInbox>[3],
) {
  const classes: ReplyClass[] = ["interested", "question", "oof", "not_interested", "unsubscribe"];
  const urgencies: ReplyUrgency[] = ["high", "medium", "low"];

  return html`
    <div class="filter-chips">
      <span class="filter-label" style="color:var(--glass-fg-3)">Class:</span>
      <button
        class="filter-chip g-chip ${state.filterClass === null ? "filter-chip--active" : ""}"
        @click=${() => handlers.onFilterClass(null)}
      >All</button>
      ${classes.map(
        (cls) => html`
          <button
            class="filter-chip g-chip ${state.filterClass === cls ? "filter-chip--active" : ""}"
            style="--chip-color:${CLASS_CONFIG[cls].color}"
            @click=${() => handlers.onFilterClass(cls === state.filterClass ? null : cls)}
          >
            ${commIcon(CLASS_CONFIG[cls].icon, 14)} ${CLASS_CONFIG[cls].label}
          </button>
        `,
      )}
      <span class="filter-label" style="margin-left:8px;color:var(--glass-fg-3)">Urgency:</span>
      ${urgencies.map(
        (u) => html`
          <button
            class="filter-chip g-chip ${state.filterUrgency === u ? "filter-chip--active" : ""}"
            style="--chip-color:${URGENCY_CONFIG[u].color}"
            @click=${() => handlers.onFilterUrgency(u === state.filterUrgency ? null : u)}
          >
            ${URGENCY_CONFIG[u].label}
          </button>
        `,
      )}
    </div>
  `;
}

function _renderReplyRow(
  r: LeadReply,
  state: ReplyInboxState,
  handlers: Parameters<typeof renderReplyInbox>[3],
) {
  const cls = CLASS_CONFIG[r.class];
  const urg = URGENCY_CONFIG[r.urgency];

  return html`
    <div
      class="inbox-row g-card g-card--interactive ${r.handled ? "inbox-row--handled" : ""} ${state.selectedReplyId === r.id ? "inbox-row--selected" : ""}"
      @click=${() => handlers.onSelect(r.id === state.selectedReplyId ? null : r.id)}
    >
      <div class="inbox-row-left">
        <span class="inbox-class-icon" title="${cls.label}">${commIcon(cls.icon, 18)}</span>
        <div>
          <div class="inbox-lead-name" style="color:var(--glass-fg)">${r.leadName}</div>
          <div class="inbox-subject" style="color:var(--glass-fg-2)">${r.subject}</div>
          <div class="inbox-preview" style="color:var(--glass-fg-3)">${r.bodyPreview}</div>
        </div>
      </div>
      <div class="inbox-row-right">
        <span class="inbox-urgency-badge g-chip" style="background:${urg.color}22;color:${urg.color}">
          ${urg.label}
        </span>
        <span class="inbox-class-badge g-chip" style="background:${cls.color}22;color:${cls.color}">
          ${cls.label}
        </span>
        <span class="inbox-time" style="color:var(--glass-fg-3)">${_timeAgo(r.receivedAt)}</span>
        ${!r.handled
          ? html`<button
              class="lp-btn lp-btn-sm lp-btn-success g-btn g-btn--sm"
              @click=${(e: Event) => {
                e.stopPropagation();
                handlers.onMarkHandled(r.id);
              }}
            >
              ${commIcon("check", 14)} Handled
            </button>`
          : html`<span class="inbox-handled-badge">${commIcon("check", 14)}</span>`}
      </div>
    </div>

    ${state.selectedReplyId === r.id
      ? html`<div class="inbox-detail-row g-card">
          <div class="inbox-suggested" style="color:var(--glass-fg-2)">
            <strong>Suggested action:</strong> ${r.suggestedAction}
          </div>
          <div class="inbox-confidence" style="color:var(--glass-fg-3)">
            AI confidence: ${(r.confidence * 100).toFixed(0)}%
            ${r.confidence < 0.7
              ? html`<span class="inbox-low-confidence"> (low — human review recommended)</span>`
              : nothing}
          </div>
          ${r.campaignName ? html`<div class="inbox-campaign" style="color:var(--glass-fg-3)">Campaign: ${r.campaignName}</div>` : nothing}
        </div>`
      : nothing}
  `;
}

function _renderReplyDetail(
  reply: LeadReply | null,
  _handlers: Parameters<typeof renderReplyInbox>[3],
) {
  if (!reply) return nothing;
  return html`
    <div class="inbox-full-detail g-panel">
      <h3 style="color:var(--glass-fg)">${reply.leadName} — Reply</h3>
      <div class="inbox-detail-meta" style="color:var(--glass-fg-3)">
        <span>Received: ${_formatDate(reply.receivedAt)}</span>
        ${reply.leadEmail ? html`<span>From: ${reply.leadEmail}</span>` : nothing}
      </div>
      <div class="inbox-body" style="color:var(--glass-fg-2)">${reply.bodyPreview}</div>
    </div>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function _formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
