/**
 * All-Mail sub-view for the unified Inbox page.
 *
 * Renders: label sidebar · message list · message detail + AI summarize.
 * Account scoping is controlled by the `accountId` parameter passed from the
 * parent inbox.ts — this module has no account-switcher UI of its own.
 *
 * What is NOT here (lives in the legacy <gmail-page> or separate flows):
 *   - OAuth / IMAP connect wizard
 *   - Account add / remove / set-default
 *   - Archive / trash / star actions (rough edge — v2)
 *   - Full compose (dispatches `infinibot:open-email-composer` CustomEvent)
 *   - AI analysis modal (v2)
 */

import { html, nothing, type TemplateResult } from "lit";
import { gatewayCall } from "../gateway-client";
import { icons } from "../icons";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to?: string;
  snippet: string;
  date: string;
  labels: string[];
  isUnread: boolean;
  isStarred: boolean;
  body?: string;
  bodyHtml?: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesUnread?: number;
}

export interface InboxMailState {
  loading: boolean;
  messages: GmailMessage[];
  selectedMessage: GmailMessage | null;
  summaryBusy: boolean;
  summary: { summary: string; actions: string[]; provider?: string; model?: string } | null;
  selectedLabel: string;
  labels: GmailLabel[];
  searchQuery: string;
  error: string | null;
}

export function createMailState(): InboxMailState {
  return {
    loading: false,
    messages: [],
    selectedMessage: null,
    summaryBusy: false,
    summary: null,
    selectedLabel: "INBOX",
    labels: [],
    searchQuery: "",
    error: null,
  };
}

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadMailData(
  state: InboxMailState,
  accountId: string | null,
  onUpdate: () => void,
): Promise<void> {
  state.loading = true;
  state.error = null;
  onUpdate();
  try {
    const msgParams: Record<string, unknown> = { maxResults: 30, accountId };
    if (state.searchQuery) {
      msgParams.query = state.searchQuery;
    } else if (state.selectedLabel) {
      msgParams.labelIds = [state.selectedLabel];
    }
    const [msgResult, labelResult] = await Promise.all([
      gatewayCall<{ messages: GmailMessage[] }>("gmail.list", msgParams),
      gatewayCall<{ labels: GmailLabel[] }>("gmail.labels", { accountId }),
    ]);
    state.messages = msgResult.messages ?? [];
    state.labels = labelResult.labels ?? [];
  } catch (e) {
    state.error = String(e);
  } finally {
    state.loading = false;
    onUpdate();
  }
}

async function _selectMessage(
  state: InboxMailState,
  msg: GmailMessage,
  accountId: string | null,
  onUpdate: () => void,
): Promise<void> {
  if (state.selectedMessage?.id === msg.id) return;
  state.summary = null;
  state.selectedMessage = { ...msg }; // show immediately, then hydrate
  onUpdate();
  try {
    const result = await gatewayCall<{ message: GmailMessage }>("gmail.get", {
      accountId,
      messageId: msg.id,
    });
    state.selectedMessage = result.message;
    if (msg.isUnread) {
      await gatewayCall("gmail.markRead", { accountId, messageId: msg.id });
      const listed = state.messages.find((x) => x.id === msg.id);
      if (listed) listed.isUnread = false;
    }
  } catch (e) {
    console.error("[InboxAllMail] select failed:", e);
  } finally {
    onUpdate();
  }
}

async function _summarize(
  state: InboxMailState,
  accountId: string | null,
  onUpdate: () => void,
): Promise<void> {
  if (!state.selectedMessage) return;
  state.summaryBusy = true;
  state.summary = null;
  onUpdate();
  try {
    const result = await gatewayCall<{
      summary: string;
      actions: string[];
      provider?: string;
      model?: string;
    }>("gmail.summarize", { accountId, messageId: state.selectedMessage.id });
    state.summary = result;
  } catch (e) {
    console.error("[InboxAllMail] summarize failed:", e);
  } finally {
    state.summaryBusy = false;
    onUpdate();
  }
}

// ── CSS (injected once) ───────────────────────────────────────────────────────

let _mailStylesInjected = false;
export function injectMailStyles(): void {
  if (_mailStylesInjected) return;
  _mailStylesInjected = true;
  const el = document.createElement("style");
  el.id = "inbox-all-mail-styles";
  el.textContent = `
    .ibm-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; gap: 8px; }
    .ibm-search-bar { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
    .ibm-search-input {
      flex: 1; background: color-mix(in srgb, var(--glass-base) 62%, transparent); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-sm); padding: 7px 12px;
      color: var(--glass-fg); font-size: 13px; outline: none;
    }
    .ibm-search-input:focus { border-color: var(--g-primary-muted); }
    .ibm-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 14px; border-radius: var(--g-radius-sm);
      background: var(--glass-gold-fill); color: var(--glass-ink); border: none;
      font-size: 13px; cursor: pointer; white-space: nowrap;
      transition: opacity 0.15s;
    }
    .ibm-btn:hover { opacity: 0.85; }
    .ibm-btn:disabled { opacity: 0.45; cursor: default; }
    .ibm-btn-ghost {
      background: var(--glass-hover); color: var(--glass-fg-2);
      border: 1px solid var(--glass-stroke);
    }
    .ibm-btn-ghost:hover { background: var(--g-surface); color: var(--g-fg); }
    .ibm-btn-compose {
      width: 100%; justify-content: center;
      background: var(--glass-gold-fill); color: var(--glass-ink);
      border: 1px solid transparent;
    }
    .ibm-body {
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 8px;
      flex: 1;
      overflow: hidden;
    }
    .ibm-body--detail {
      grid-template-columns: 200px minmax(0, 340px) 1fr;
    }
    .ibm-sidebar {
      display: flex; flex-direction: column; gap: 2px; overflow-y: auto;
      background: var(--glass-sheen), var(--glass-2); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-lg); padding: 8px;
    }
    .ibm-label-btn {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-radius: var(--g-radius-sm);
      border: none; background: transparent; color: var(--glass-fg-2);
      cursor: pointer; font-size: 13px; text-align: left;
      transition: background 0.15s, color 0.15s;
    }
    .ibm-label-btn:hover { background: var(--glass-hover); color: var(--glass-fg); }
    .ibm-label-btn.active { background: var(--glass-gold-tint); color: var(--glass-gold-hi); }
    .ibm-label-group-title {
      font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
      color: var(--g-fg-faint); padding: 8px 10px 2px; margin-top: 4px;
    }
    .ibm-badge {
      margin-left: auto; font-size: 10px; font-weight: 700;
      background: var(--glass-gold-fill); color: var(--glass-ink);
      border-radius: 999px; padding: 1px 7px;
    }
    .ibm-list-panel {
      display: flex; flex-direction: column; overflow-y: auto;
      background: var(--glass-sheen), var(--glass-2); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-lg); gap: 2px; padding: 4px;
    }
    .ibm-msg-row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 9px 10px; border-radius: var(--g-radius-sm);
      cursor: pointer; transition: background 0.15s; border: 1px solid transparent;
    }
    .ibm-msg-row:hover { background: var(--glass-hover); }
    .ibm-msg-row.selected { background: var(--glass-gold-tint); border-color: var(--glass-stroke-gold); }
    .ibm-msg-row.unread .ibm-msg-subject { font-weight: 700; }
    .ibm-unread-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--glass-gold); box-shadow: var(--glass-glow-soft); flex-shrink: 0; margin-top: 5px;
    }
    .ibm-unread-dot--read { background: transparent; }
    .ibm-msg-info { flex: 1; min-width: 0; }
    .ibm-msg-top { display: flex; align-items: center; gap: 6px; }
    .ibm-msg-from {
      font-size: 13px; font-weight: 500; color: var(--g-fg);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    .ibm-msg-date { font-size: 11px; color: var(--g-fg-faint); flex-shrink: 0; }
    .ibm-star { font-size: 12px; }
    .ibm-msg-subject {
      font-size: 12px; color: var(--g-fg); margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ibm-msg-snippet {
      font-size: 11px; color: var(--g-fg-faint); margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ibm-detail-panel {
      display: flex; flex-direction: column; gap: 10px; overflow-y: auto;
      background: var(--glass-sheen), var(--glass-2); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-lg); padding: 14px;
    }
    .ibm-detail-subject { font-size: 16px; font-weight: 600; color: var(--g-fg); line-height: 1.3; }
    .ibm-detail-meta {
      display: flex; flex-direction: column; gap: 3px;
      font-size: 12px; color: var(--g-fg-dim);
      border-bottom: 1px solid var(--glass-stroke); padding-bottom: 10px;
    }
    .ibm-summary-box {
      background: var(--glass-gold-tint); border: 1px solid var(--glass-stroke-gold);
      border-radius: var(--glass-radius); padding: 12px; font-size: 13px;
    }
    .ibm-summary-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .ibm-action-chip {
      font-size: 11px; background: var(--glass-hover);
      border: 1px solid var(--glass-stroke); border-radius: 999px;
      padding: 3px 10px; color: var(--g-fg-dim);
    }
    .ibm-detail-body {
      font-size: 13px; color: var(--g-fg); line-height: 1.6;
      white-space: pre-wrap; word-break: break-word;
    }
    .ibm-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 10px; padding: 40px;
      color: var(--g-fg-faint); font-size: 14px;
    }
    .ibm-spinner {
      width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid var(--glass-stroke); border-top-color: var(--glass-gold);
      animation: ibm-spin 0.8s linear infinite;
    }
    @keyframes ibm-spin { to { transform: rotate(360deg); } }
    .ibm-error {
      background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3);
      border-radius: var(--g-radius-sm); padding: 8px 12px;
      font-size: 13px; color: #f87171; flex-shrink: 0;
    }
    @media (max-width: 640px) {
      .ibm-search-bar { flex-wrap: wrap; }
      .ibm-search-input { flex-basis: 100%; min-width: 0; }
      .ibm-body, .ibm-body--detail { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
      .ibm-sidebar { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }
      .ibm-sidebar > div[style] { margin-top: 0 !important; padding-top: 0 !important; }
      .ibm-list-panel { min-height: 300px; }
      .ibm-detail-panel { min-height: 360px; }
    }
  `;
  document.head.appendChild(el);
}

// ── Render ────────────────────────────────────────────────────────────────────

const LABEL_ICONS: Record<string, string> = {
  INBOX: "inbox", SENT: "send", DRAFTS: "draft", STARRED: "star",
  IMPORTANT: "tag", TRASH: "trash", SPAM: "alert", UNREAD: "mail",
};

export function renderAllMail(
  state: InboxMailState,
  accountId: string | null,
  onUpdate: () => void,
): TemplateResult {
  injectMailStyles();
  ensureCommunicationGlassStyles();

  const sysLabels = state.labels.filter((l) => l.type === "system");
  const userLabels = state.labels.filter((l) => l.type === "user");

  return html`
    <div class="ibm-root">
      <!-- Search bar -->
      <div class="ibm-search-bar g-glass">
        <input
          class="ibm-search-input g-input"
          placeholder="Search messages…"
          .value=${state.searchQuery}
          @input=${(e: Event) => { state.searchQuery = (e.target as HTMLInputElement).value; onUpdate(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") loadMailData(state, accountId, onUpdate); }}
        />
        <button class="ibm-btn g-btn g-btn--primary" @click=${() => loadMailData(state, accountId, onUpdate)}>Search</button>
        ${state.searchQuery ? html`
          <button class="ibm-btn ibm-btn-ghost g-btn g-btn--ghost" @click=${() => {
            state.searchQuery = "";
            loadMailData(state, accountId, onUpdate);
          }}>${icons.x} Clear</button>
        ` : nothing}
        <button class="ibm-btn ibm-btn-ghost g-btn g-btn--ghost g-btn--icon" title="Refresh"
          @click=${() => loadMailData(state, accountId, onUpdate)}>${icons.refresh}</button>
      </div>

      ${state.error ? html`<div class="ibm-error">${state.error}</div>` : nothing}

      <!-- Body: sidebar · list · detail -->
      <div class="ibm-body ${state.selectedMessage ? "ibm-body--detail" : ""}">

        <!-- Label sidebar -->
        <div class="ibm-sidebar g-panel">
          ${sysLabels.map((l) => html`
            <button
              class="ibm-label-btn ${state.selectedLabel === l.id ? "active" : ""}"
              @click=${() => {
                if (state.selectedLabel === l.id && !state.searchQuery) return;
                state.selectedLabel = l.id;
                state.searchQuery = "";
                state.selectedMessage = null;
                state.summary = null;
                loadMailData(state, accountId, onUpdate);
              }}
            >
              <span>${commIcon(LABEL_ICONS[l.id] ?? "folder", 15)}</span>
              <span style="flex:1">${l.name}</span>
              ${l.messagesUnread ? html`<span class="ibm-badge">${l.messagesUnread}</span>` : nothing}
            </button>
          `)}
          ${userLabels.length ? html`
            <div class="ibm-label-group-title">Labels</div>
            ${userLabels.map((l) => html`
              <button
                class="ibm-label-btn ${state.selectedLabel === l.id ? "active" : ""}"
                @click=${() => {
                  state.selectedLabel = l.id;
                  state.searchQuery = "";
                  state.selectedMessage = null;
                  state.summary = null;
                  loadMailData(state, accountId, onUpdate);
                }}
              >${commIcon("folder", 15)} ${l.name}</button>
            `)}
          ` : nothing}
          <div style="margin-top:auto;padding-top:10px">
            <button
              class="ibm-btn ibm-btn-compose g-btn g-btn--primary"
              @click=${() => document.dispatchEvent(new CustomEvent("infinibot:open-email-composer", {
                bubbles: true,
                detail: { accountId },
              }))}
            >${icons.penLine} Compose</button>
          </div>
        </div>

        <!-- Message list -->
        <div class="ibm-list-panel g-panel">
          ${state.loading && state.messages.length === 0
            ? html`<div class="ibm-empty"><div class="ibm-spinner"></div><span>Loading…</span></div>`
            : state.messages.length === 0
              ? html`<div class="ibm-empty">
                  <span style="font-size:32px">${icons.mail}</span>
                  <span>No messages</span>
                </div>`
              : state.messages.map((m) => html`
                <div
                  class="ibm-msg-row ${state.selectedMessage?.id === m.id ? "selected" : ""} ${m.isUnread ? "unread" : ""}"
                  @click=${() => _selectMessage(state, m, accountId, onUpdate)}
                >
                  <span class="ibm-unread-dot ${m.isUnread ? "" : "ibm-unread-dot--read"}"></span>
                  <div class="ibm-msg-info">
                    <div class="ibm-msg-top">
                      <span class="ibm-msg-from">${_cleanFrom(m.from)}</span>
                      <span class="ibm-msg-date">${_fmtDate(m.date)}</span>
                      ${m.isStarred ? html`<span class="ibm-star">${icons.starFilled}</span>` : nothing}
                    </div>
                    <div class="ibm-msg-subject">${m.subject || "(No subject)"}</div>
                    <div class="ibm-msg-snippet">${m.snippet}</div>
                  </div>
                </div>
              `)
          }
        </div>

        <!-- Detail panel -->
        ${state.selectedMessage ? html`
          <div class="ibm-detail-panel g-panel">
            <div>
              <button class="ibm-btn ibm-btn-ghost g-btn g-btn--ghost" @click=${() => {
                state.selectedMessage = null;
                state.summary = null;
                onUpdate();
              }}>${icons.arrowLeft} Back</button>
            </div>
            <div class="ibm-detail-subject">${state.selectedMessage.subject || "(No subject)"}</div>
            <div class="ibm-detail-meta">
              <span>From: ${state.selectedMessage.from}</span>
              ${state.selectedMessage.to ? html`<span>To: ${state.selectedMessage.to}</span>` : nothing}
              <span>${_fmtDateLong(state.selectedMessage.date)}</span>
            </div>

            ${state.summary
              ? html`
                <div class="ibm-summary-box">
                  <div style="font-weight:600;font-size:13px;margin-bottom:6px">${icons.sparkles} AI Summary</div>
                  <div style="font-size:13px;line-height:1.5">${state.summary.summary}</div>
                  ${state.summary.actions.length ? html`
                    <div class="ibm-summary-actions">
                      ${state.summary.actions.map((a) => html`<span class="ibm-action-chip">${a}</span>`)}
                    </div>
                  ` : nothing}
                  ${state.summary.provider ? html`
                    <div style="font-size:11px;color:var(--g-fg-faint);margin-top:6px">
                      ${state.summary.provider} · ${state.summary.model}
                    </div>
                  ` : nothing}
                </div>
              `
              : html`
                <div>
                  <button
                    class="ibm-btn g-btn g-btn--primary"
                    ?disabled=${state.summaryBusy}
                    @click=${() => _summarize(state, accountId, onUpdate)}
                  >
                    ${state.summaryBusy ? html`<span class="ibm-spinner" style="width:14px;height:14px;border-width:2px"></span> Summarizing…` : html`${icons.sparkles} AI Summarize`}
                  </button>
                </div>
              `}

            <div class="ibm-detail-body">
              ${state.selectedMessage.body
                ? state.selectedMessage.body
                : state.selectedMessage.snippet
                  ? html`<span style="color:var(--g-fg-dim);font-style:italic">Preview: </span>${state.selectedMessage.snippet}`
                  : html`<span style="color:var(--g-fg-faint)">No body content available.</span>`}
            </div>
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _cleanFrom(from: string): string {
  const m = from.match(/^"?([^"<]+)"?\s*<.*>$/);
  return m ? m[1].trim() : from;
}

function _fmtDate(date: string): string {
  try {
    const d = new Date(date);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return date;
  }
}

function _fmtDateLong(date: string): string {
  try {
    return new Date(date).toLocaleString([], {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return date;
  }
}
