/**
 * Unified Inbox — account-segmented, multi-view email hub.
 *
 * Replaces the separate /email (gmail-page) and /reply-inbox pages with a
 * single surface that keeps accounts as the primary dimension:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │  [All] [me@gmail.com 3] [work@imap.co 1]  [+ Connect]  │  ← account bar
 *   │  [All Mail]  [Replies]  [Insights]                       │  ← view toggle
 *   ├─────────────────────────────────────────────────────────┤
 *   │  <active sub-view>                                       │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Sub-views:
 *   All Mail  → inbox-all-mail.ts (label sidebar + message list + detail)
 *   Replies   → reply-inbox.ts   (AI-classified lead replies)
 *   Insights  → inline (stat cards + Telegram alert-rule configurator)
 *
 * Legacy URLs:
 *   /email, /emails   → inbox with view = "mail"    (handled in app-render.ts)
 *   /reply-inbox      → inbox with view = "replies" (handled in app-render.ts)
 */

import { html, nothing, type TemplateResult } from "lit";
import { gatewayCall } from "../gateway-client";
import { icons } from "../icons";
import type { GatewayBrowserClient } from "../gateway-client";
import type { AppViewState } from "../app-view-state";
import {
  type InboxMailState,
  createMailState,
  loadMailData,
  renderAllMail,
} from "./inbox-all-mail";
import {
  type ReplyInboxState,
  type ReplyClass,
  type ReplyUrgency,
  createReplyInboxState,
  renderReplyInbox,
} from "./reply-inbox";
import "./email-accounts";
import "../components/doc-agent-panel";
import { ensureCommunicationGlassStyles } from "./communication-glass";

// ── Types ─────────────────────────────────────────────────────────────────────

export type InboxView = "mail" | "replies" | "insights";

export interface GmailAccount {
  id: string;
  email?: string;
  isDefault: boolean;
  provider?: string;
}

interface GmailInsights {
  unread: number;
  today: number;
  last24h: number;
  totalScanned: number;
  topSenders: Array<{ sender: string; count: number }>;
}

interface GmailAlertRule {
  accountId?: string;
  enabled: boolean;
  telegramChatId?: string;
  senders: string[];
  keywords: string[];
  pollIntervalMinutes: number;
  doTelegramAlert?: boolean;
  aiAnalysisEnabled?: boolean;
  aiImportanceThreshold?: number;
}

const EMPTY_RULE: GmailAlertRule = {
  enabled: true,
  senders: [],
  keywords: [],
  pollIntervalMinutes: 5,
  doTelegramAlert: true,
};

interface InboxInsightsState {
  loading: boolean;
  data: GmailInsights | null;
  error: string | null;
  alertLoading: boolean;
  alertRule: GmailAlertRule;
  alertSaving: boolean;
  alertSaved: boolean;
  alertError: string | null;
  senderInput: string;
  keywordInput: string;
}

function createInsightsState(): InboxInsightsState {
  return {
    loading: false,
    data: null,
    error: null,
    alertLoading: false,
    alertRule: { ...EMPTY_RULE },
    alertSaving: false,
    alertSaved: false,
    alertError: null,
    senderInput: "",
    keywordInput: "",
  };
}

export interface InboxState {
  accountsLoading: boolean;
  /** True once the first account load has run, so an empty list doesn't re-trigger it every render. */
  accountsLoaded: boolean;
  accountsError: string | null;
  accounts: GmailAccount[];
  configured: boolean;
  /** null = All Accounts (aggregate) */
  activeAccountId: string | null;
  view: InboxView;
  mailState: InboxMailState;
  replyState: ReplyInboxState;
  insightsState: InboxInsightsState;
  /** Unread counts keyed by accountId, populated lazily from gmail.insights */
  unreadByAccount: Record<string, number>;
  showAccountsManager: boolean;
}

export function createInboxState(forceView?: InboxView): InboxState {
  return {
    accountsLoading: false,
    accountsLoaded: false,
    accountsError: null,
    accounts: [],
    configured: false,
    activeAccountId: null,
    view: forceView ?? "mail",
    mailState: createMailState(),
    replyState: createReplyInboxState(),
    insightsState: createInsightsState(),
    unreadByAccount: {},
    showAccountsManager: false,
  };
}

// ── Data loading ──────────────────────────────────────────────────────────────

export async function loadInboxAccounts(
  state: InboxState,
  onUpdate: () => void,
): Promise<void> {
  if (state.accountsLoading) return;
  state.accountsLoading = true;
  state.accountsError = null;
  onUpdate();
  try {
    const result = await gatewayCall<{ configured: boolean; accounts: GmailAccount[] }>(
      "gmail.status",
      {},
    );
    state.configured = !!result.configured;
    state.accounts = result.accounts ?? [];
    // If no account selected yet, default to "All Accounts" (null)
    // Keep whatever the user had selected if accounts didn't change drastically
  } catch (e) {
    state.accountsError = String(e);
  } finally {
    state.accountsLoading = false;
    state.accountsLoaded = true;
    onUpdate();
  }
  // Lazily load unread counts per account
  _loadUnreadCounts(state, onUpdate);
}

async function _loadUnreadCounts(state: InboxState, onUpdate: () => void): Promise<void> {
  for (const acc of state.accounts) {
    try {
      const ins = await gatewayCall<{ unread: number }>("gmail.insights", {
        accountId: acc.id,
        lookbackDays: 1,
      });
      state.unreadByAccount[acc.id] = ins.unread ?? 0;
      onUpdate();
    } catch {
      /* non-fatal */
    }
  }
}

async function _loadInsights(state: InboxState, onUpdate: () => void): Promise<void> {
  const is = state.insightsState;
  is.loading = true;
  is.error = null;
  onUpdate();
  try {
    const result = await gatewayCall<GmailInsights>("gmail.insights", {
      accountId: state.activeAccountId,
      lookbackDays: 7,
    });
    is.data = result;
  } catch (e) {
    is.error = String(e);
  } finally {
    is.loading = false;
    onUpdate();
  }
  // Also load alert rule
  is.alertLoading = true;
  onUpdate();
  try {
    const ruleResult = await gatewayCall<{ rule: GmailAlertRule }>("gmail.alerts.get", {
      accountId: state.activeAccountId,
    });
    is.alertRule = ruleResult.rule ?? { ...EMPTY_RULE };
  } catch {
    /* keep default */
  } finally {
    is.alertLoading = false;
    onUpdate();
  }
}

async function _saveAlertRule(state: InboxState, onUpdate: () => void): Promise<void> {
  const is = state.insightsState;
  is.alertSaving = true;
  is.alertError = null;
  is.alertSaved = false;
  onUpdate();
  try {
    await gatewayCall("gmail.alerts.set", {
      accountId: state.activeAccountId,
      rule: is.alertRule,
    });
    is.alertSaved = true;
    setTimeout(() => { is.alertSaved = false; onUpdate(); }, 3000);
  } catch (e) {
    is.alertError = String(e);
  } finally {
    is.alertSaving = false;
    onUpdate();
  }
}

// ── CSS (injected once) ───────────────────────────────────────────────────────

let _inboxStylesInjected = false;
function _ensureInboxStyles(): void {
  if (_inboxStylesInjected) return;
  _inboxStylesInjected = true;
  const el = document.createElement("style");
  el.id = "unified-inbox-styles";
  el.textContent = `
    .uib-host {
      display: flex; flex-direction: column; height: 100%; overflow: hidden;
      gap: 0;
    }
    /* ── Account segment bar ── */
    .uib-account-bar {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding: 10px 14px; border-bottom: 1px solid var(--glass-stroke);
      background: var(--glass-sheen), var(--glass-2); flex-shrink: 0;
    }
    .uib-account-pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 13px; border-radius: 999px;
      border: 1px solid var(--glass-stroke); background: var(--glass-hover);
      color: var(--glass-fg-2); font-size: 13px; cursor: pointer;
      transition: all 0.15s; white-space: nowrap;
    }
    .uib-account-pill:hover { background: var(--glass-hover); color: var(--glass-fg); }
    .uib-account-pill.active {
      background: var(--glass-gold-tint); color: var(--glass-gold-hi);
      border-color: var(--glass-stroke-gold); font-weight: 600;
    }
    .uib-account-unread {
      font-size: 10px; font-weight: 700;
      background: var(--glass-gold-fill); color: var(--glass-ink);
      border-radius: 999px; padding: 1px 6px; margin-left: 2px;
    }
    .uib-account-provider {
      font-size: 11px; opacity: 0.55;
    }
    .uib-account-bar-spacer { flex: 1; }
    .uib-connect-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 12px; border-radius: 999px;
      border: 1px dashed var(--glass-stroke-gold); background: var(--glass-hover);
      color: var(--glass-fg-2); font-size: 12px; cursor: pointer;
      transition: all 0.15s;
    }
    .uib-connect-btn:hover { border-color: var(--glass-stroke-gold); color: var(--glass-gold-hi); }
    /* ── View toggle ── */
    .uib-view-toggle {
      display: flex; align-items: center; gap: 2px;
      padding: 8px 14px; border-bottom: 1px solid var(--glass-stroke);
      flex-shrink: 0;
    }
    .uib-view-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 16px; border-radius: var(--g-radius-sm);
      border: none; background: transparent;
      color: var(--glass-fg-2); font-size: 13px; cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .uib-view-tab:hover { background: var(--glass-hover); color: var(--glass-fg); }
    .uib-view-tab.active {
      background: var(--glass-gold-tint); color: var(--glass-gold-hi); font-weight: 600;
    }
    .uib-tab-badge {
      font-size: 10px; font-weight: 700;
      background: rgba(239,68,68,1); color: #fff;
      border-radius: 999px; padding: 1px 6px;
    }
    /* ── Body ── */
    .uib-body {
      flex: 1; overflow: hidden; padding: 12px 14px;
      display: flex; flex-direction: column;
    }
    /* ── Insights view ── */
    .uib-insights { display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
    .uib-stat-row {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 10px;
    }
    .uib-stat-card {
      background: var(--glass-sheen), var(--glass-3); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius); padding: 14px 16px;
      display: flex; flex-direction: column; gap: 4px;
    }
    .uib-stat-value { font-size: 26px; font-weight: 700; color: var(--glass-gold); }
    .uib-stat-label { font-size: 12px; color: var(--glass-fg-2); }
    .uib-top-senders { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .uib-sender-pill {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 12px; background: var(--glass-hover);
      border: 1px solid var(--glass-stroke); border-radius: 999px;
      padding: 3px 10px; color: var(--glass-fg-2);
    }
    .uib-sender-count {
      font-size: 10px; font-weight: 700;
      background: var(--glass-gold-tint); color: var(--glass-gold-hi);
      border-radius: 999px; padding: 1px 5px;
    }
    /* Alert rule card */
    .uib-alert-card {
      background: var(--glass-sheen), var(--glass-2); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-lg); padding: 16px;
      display: flex; flex-direction: column; gap: 12px;
    }
    .uib-alert-title { font-size: 15px; font-weight: 600; color: var(--glass-fg); }
    .uib-alert-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .uib-alert-label { font-size: 13px; color: var(--g-fg-dim); min-width: 120px; }
    .uib-alert-input {
      flex: 1; min-width: 160px;
      background: color-mix(in srgb, var(--glass-base) 62%, transparent); border: 1px solid var(--glass-stroke);
      border-radius: var(--glass-radius-sm); padding: 6px 10px;
      color: var(--glass-fg); font-size: 13px; outline: none;
    }
    .uib-alert-input:focus { border-color: var(--g-primary-muted); }
    .uib-tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
    .uib-tag {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; background: var(--glass-gold-tint); color: var(--glass-gold-hi);
      border: 1px solid var(--glass-stroke-gold); border-radius: 999px; padding: 3px 10px;
    }
    .uib-tag-remove { cursor: pointer; opacity: 0.6; font-size: 11px; }
    .uib-tag-remove:hover { opacity: 1; }
    .uib-toggle {
      position: relative; display: inline-block; width: 36px; height: 20px;
    }
    .uib-toggle input { opacity: 0; width: 0; height: 0; }
    .uib-toggle-slider {
      position: absolute; inset: 0; cursor: pointer;
      background: var(--glass-stroke-strong); border-radius: 999px;
      transition: background 0.2s;
    }
    .uib-toggle input:checked + .uib-toggle-slider { background: var(--glass-gold-fill); }
    .uib-toggle-slider::before {
      content: ""; position: absolute;
      width: 14px; height: 14px; border-radius: 50%;
      background: var(--glass-fg); left: 3px; top: 3px; transition: transform 0.2s;
    }
    .uib-toggle input:checked + .uib-toggle-slider::before { transform: translateX(16px); }
    .uib-save-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 7px 18px; border-radius: var(--g-radius-sm);
      background: var(--glass-gold-fill); color: var(--glass-ink); border: none;
      font-size: 13px; cursor: pointer; transition: opacity 0.15s;
    }
    .uib-save-btn:hover { opacity: 0.85; }
    .uib-save-btn:disabled { opacity: 0.45; cursor: default; }
    /* ── Empty / loading states ── */
    .uib-empty {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 12px; padding: 60px 20px;
      color: var(--glass-fg-3); font-size: 14px; text-align: center;
    }
    .uib-spinner {
      width: 24px; height: 24px; border-radius: 50%;
      border: 2px solid var(--glass-stroke); border-top-color: var(--glass-gold);
      animation: uib-spin 0.8s linear infinite;
    }
    @keyframes uib-spin { to { transform: rotate(360deg); } }
    .uib-not-configured {
      display: flex; flex-direction: column; align-items: center;
      gap: 12px; padding: 60px 20px; text-align: center;
    }
    .uib-error {
      background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.3);
      border-radius: var(--g-radius-sm); padding: 8px 12px;
      font-size: 13px; color: #f87171;
    }
    .uib-success {
      background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.3);
      border-radius: var(--g-radius-sm); padding: 8px 12px;
      font-size: 13px; color: #10b981;
    }
    /* ── Accounts manager modal ── */
    .uib-modal-backdrop {
      position: fixed; inset: 0; z-index: 1000;
      background: color-mix(in srgb, var(--glass-base) 72%, transparent); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
    }
    .uib-modal {
      background: var(--glass-sheen), var(--glass-4); border: 1px solid var(--glass-stroke-gold);
      border-radius: var(--glass-radius-lg); box-shadow: var(--glass-elev-4);
      width: min(720px, 94vw); max-height: 80vh;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .uib-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid var(--glass-stroke);
      font-size: 15px; font-weight: 600; color: var(--glass-fg); flex-shrink: 0;
    }
    .uib-modal-close {
      background: none; border: none; color: var(--g-fg-faint);
      font-size: 20px; cursor: pointer; line-height: 1; padding: 0 4px;
    }
    .uib-modal-close:hover { color: var(--g-fg); }
    .uib-modal email-accounts-page {
      display: block; overflow-y: auto; flex: 1;
    }
    @media (max-width: 520px) {
      .uib-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .uib-alert-row { align-items: stretch; }
      .uib-alert-label { min-width: 100%; }
      .uib-alert-input { min-width: 0; width: 100%; }
      .uib-modal { width: calc(100vw - 16px); max-height: calc(100vh - 24px); }
    }
  `;
  document.head.appendChild(el);
}

// ── Main render ───────────────────────────────────────────────────────────────

export function renderInbox(
  state: InboxState,
  client: GatewayBrowserClient,
  _appState: AppViewState,
  onUpdate: () => void,
): TemplateResult {
  _ensureInboxStyles();
  ensureCommunicationGlassStyles();

  // Kick off account load if not done yet (idempotent)
  if (!state.accountsLoading && !state.accountsLoaded) {
    loadInboxAccounts(state, onUpdate).then(() => {
      // Once accounts are loaded, auto-load data for the initial view
      if (state.view === "mail" && state.mailState.messages.length === 0) {
        loadMailData(state.mailState, state.activeAccountId, onUpdate);
      } else if (state.view === "insights" && !state.insightsState.data) {
        _loadInsights(state, onUpdate);
      }
    });
  }

  const totalUnread = Object.values(state.unreadByAccount).reduce((s, n) => s + n, 0);
  const activeUnread =
    state.activeAccountId != null
      ? (state.unreadByAccount[state.activeAccountId] ?? 0)
      : totalUnread;

  const closeAccountsManager = () => {
    state.showAccountsManager = false;
    onUpdate();
    loadInboxAccounts(state, onUpdate);
  };

  // Resolve the open thread for the doc-agent panel — mail view uses
  // selectedMessage.threadId; replies view uses the selected reply's
  // threadId (or falls back to its messageId). Panel is absent when no
  // thread is open, matching the inventory in
  // docs/doc-agent-universal-plan.md (inbox_thread).
  let openThreadId: string | null = null;
  let openThreadTitle: string | null = null;
  let openThreadExtra: string | null = null;
  if (state.view === "mail" && state.mailState.selectedMessage) {
    const m = state.mailState.selectedMessage;
    openThreadId = m.threadId ?? m.id;
    openThreadTitle = m.subject || "(No subject)";
    openThreadExtra = `from=${m.from ?? "(unknown)"} account=${state.activeAccountId ?? "(all)"}`;
  } else if (state.view === "replies" && state.replyState.selectedReplyId) {
    const r = state.replyState.replies.find((x) => x.id === state.replyState.selectedReplyId);
    if (r) {
      openThreadId = r.threadId ?? r.messageId;
      openThreadTitle = r.subject || `Reply from ${r.leadName ?? r.leadEmail ?? "(unknown)"}`;
      openThreadExtra = `class=${r.class} urgency=${r.urgency} lead=${r.leadEmail ?? r.leadName ?? "(unknown)"}`;
    }
  }

  return html`
    <div class="uib-host">
      ${_renderAccountBar(state, onUpdate)}
      ${_renderViewToggle(state, activeUnread, (v) => {
        // Route through the host sub-view so ?view= (and Back) track the switch;
        // the app then calls switchInboxView. Standalone mounts switch directly.
        if (_appState?.setHostView && _appState.tab === "inbox") _appState.setHostView(v);
        else void switchInboxView(state, v, onUpdate);
      })}
      <div class="uib-body">
        ${_renderBody(state, client, _appState, onUpdate)}
      </div>
    </div>
    ${openThreadId
      ? html`<doc-agent-panel
          .client=${client as any}
          docType="inbox_thread"
          .documentId=${openThreadId}
          .title=${openThreadTitle ?? openThreadId}
          .extra=${openThreadExtra ?? ""}
        ></doc-agent-panel>`
      : nothing}
    ${state.showAccountsManager ? html`
      <div class="uib-modal-backdrop" @click=${(e: Event) => {
        if (e.target === e.currentTarget) closeAccountsManager();
      }}>
        <div class="uib-modal g-float">
          <div class="uib-modal-header">
            <span>Manage Email Accounts</span>
            <button class="uib-modal-close g-btn g-btn--ghost g-btn--icon" aria-label="Close account manager" @click=${closeAccountsManager}>${icons.x}</button>
          </div>
          <email-accounts-page></email-accounts-page>
        </div>
      </div>
    ` : nothing}
  `;
}

// ── Account segment bar ───────────────────────────────────────────────────────

function _renderAccountBar(state: InboxState, onUpdate: () => void): TemplateResult {
  const totalUnread = Object.values(state.unreadByAccount).reduce((s, n) => s + n, 0);

  return html`
    <div class="uib-account-bar g-glass">
      <!-- All Accounts pill -->
      <button
        class="uib-account-pill g-btn g-btn--sm ${state.activeAccountId === null ? "active" : ""}"
        @click=${() => _switchAccount(state, null, onUpdate)}
      >
        <span>All</span>
        ${totalUnread > 0 ? html`<span class="uib-account-unread">${totalUnread}</span>` : nothing}
      </button>

      <!-- One pill per connected account -->
      ${state.accounts.map((acc) => {
        const unread = state.unreadByAccount[acc.id] ?? 0;
        const label = acc.email ?? acc.id;
        const providerIcon = _providerIcon(acc);
        return html`
          <button
            class="uib-account-pill g-btn g-btn--sm ${state.activeAccountId === acc.id ? "active" : ""}"
            title=${label}
            @click=${() => _switchAccount(state, acc.id, onUpdate)}
          >
            <span class="uib-account-provider">${providerIcon}</span>
            <span>${label}</span>
            ${unread > 0 ? html`<span class="uib-account-unread">${unread}</span>` : nothing}
          </button>
        `;
      })}

      ${state.accountsLoading
        ? html`<span style="font-size:12px;color:var(--g-fg-faint)">Loading…</span>`
        : nothing}

      <span class="uib-account-bar-spacer"></span>

      <!-- Connect button — opens the inline accounts manager modal -->
      <button
        class="uib-connect-btn g-btn g-btn--sm"
        @click=${() => { state.showAccountsManager = true; onUpdate(); }}
        title="Add or manage email accounts"
      >${icons.plus} Manage accounts</button>
    </div>
  `;
}

function _providerIcon(acc: GmailAccount): string {
  const email = acc.email ?? "";
  if (acc.provider === "imap") return "IMAP";
  if (email.includes("gmail") || email.includes("google")) return "G";
  if (acc.provider === "gmail") return "G";
  return "@";
}

async function _switchAccount(
  state: InboxState,
  accountId: string | null,
  onUpdate: () => void,
): Promise<void> {
  if (state.activeAccountId === accountId) return;
  state.activeAccountId = accountId;
  // Reset sub-view data so it reloads for the new account
  state.mailState = createMailState();
  state.insightsState = createInsightsState();
  onUpdate();
  // Reload whichever view is active
  if (state.view === "mail") {
    await loadMailData(state.mailState, accountId, onUpdate);
  } else if (state.view === "insights") {
    await _loadInsights(state, onUpdate);
  }
}

// ── View toggle ───────────────────────────────────────────────────────────────

function _renderViewToggle(
  state: InboxState,
  activeUnread: number,
  onSelect: (view: InboxView) => void,
): TemplateResult {
  const urgentReplies = state.replyState.replies.filter(
    (r) => r.urgency === "high" && !r.handled,
  ).length;

  return html`
    <div class="uib-view-toggle g-glass">
      ${(["mail", "replies", "insights"] as InboxView[]).map((v) => html`
        <button
          class="uib-view-tab g-btn g-btn--sm ${state.view === v ? "active" : ""}"
          @click=${() => onSelect(v)}
        >
          ${v === "mail" ? "All Mail" : v === "replies" ? "Replies" : "Insights"}
          ${v === "mail" && activeUnread > 0
            ? html`<span class="uib-tab-badge">${activeUnread}</span>`
            : nothing}
          ${v === "replies" && urgentReplies > 0
            ? html`<span class="uib-tab-badge">${urgentReplies}</span>`
            : nothing}
        </button>
      `)}
    </div>
  `;
}

/** Switch the inbox sub-view (the app keeps it in sync with the route's ?view=). */
export async function switchInboxView(
  state: InboxState,
  view: InboxView,
  onUpdate: () => void,
): Promise<void> {
  if (state.view === view) return;
  state.view = view;
  onUpdate();
  // Lazy-load data for the newly selected view if empty
  if (view === "mail" && state.mailState.messages.length === 0 && !state.mailState.loading) {
    await loadMailData(state.mailState, state.activeAccountId, onUpdate);
  } else if (view === "insights" && !state.insightsState.data && !state.insightsState.loading) {
    await _loadInsights(state, onUpdate);
  }
}

// ── Body dispatcher ───────────────────────────────────────────────────────────

function _renderBody(
  state: InboxState,
  client: GatewayBrowserClient,
  appState: AppViewState,
  onUpdate: () => void,
): TemplateResult {
  if (!state.configured && state.accounts.length === 0 && !state.accountsLoading) {
    return _renderNotConfigured(state, onUpdate);
  }

  if (state.view === "mail") {
    return renderAllMail(state.mailState, state.activeAccountId, onUpdate);
  }

  if (state.view === "replies") {
    return renderReplyInbox(state.replyState, client, appState, {
      onLoad: () => {
        state.replyState.loading = true;
        onUpdate();
        // TODO(closed-loop): fetch classified replies from OutreachMessages DB scoped to activeAccountId
        setTimeout(() => { state.replyState.loading = false; onUpdate(); }, 600);
      },
      onMarkHandled: (replyId) => {
        const r = state.replyState.replies.find((x) => x.id === replyId);
        if (r) { r.handled = true; onUpdate(); }
      },
      onSelect: (id) => { state.replyState.selectedReplyId = id; onUpdate(); },
      onFilterClass: (cls: ReplyClass | null) => { state.replyState.filterClass = cls; onUpdate(); },
      onFilterUrgency: (u: ReplyUrgency | null) => { state.replyState.filterUrgency = u; onUpdate(); },
      onToggleShowHandled: () => { state.replyState.showHandled = !state.replyState.showHandled; onUpdate(); },
    });
  }

  // Insights view
  return _renderInsightsView(state, onUpdate);
}

function _renderNotConfigured(state: InboxState, onUpdate: () => void): TemplateResult {
  return html`
    <div class="uib-not-configured g-panel g-noise">
      <span style="font-size:40px">${icons.mail}</span>
      <div style="font-size:18px;color:var(--g-fg)">No email accounts connected</div>
      <div style="font-size:13px;color:var(--g-fg-dim);max-width:380px">
        Connect a Gmail account via OAuth or add a custom IMAP/SMTP account
        to start using the unified inbox.
      </div>
      <button
        class="uib-save-btn g-btn g-btn--primary"
        @click=${() => { state.showAccountsManager = true; onUpdate(); }}
      >${icons.plus} Connect an account</button>
    </div>
  `;
}

// ── Insights sub-view ─────────────────────────────────────────────────────────

function _renderInsightsView(state: InboxState, onUpdate: () => void): TemplateResult {
  const is = state.insightsState;

  if (is.loading) {
    return html`<div class="uib-empty"><div class="uib-spinner"></div><span>Loading insights…</span></div>`;
  }

  if (is.error) {
    return html`
      <div class="uib-insights">
        <div class="uib-error">${is.error}</div>
        <button class="uib-save-btn g-btn g-btn--primary" @click=${() => _loadInsights(state, onUpdate)}>Retry</button>
      </div>
    `;
  }

  if (!is.data) {
    // trigger load
    _loadInsights(state, onUpdate);
    return html`<div class="uib-empty"><div class="uib-spinner"></div><span>Loading insights…</span></div>`;
  }

  return html`
    <div class="uib-insights">
      <!-- Stat cards -->
      <div class="uib-stat-row">
        <div class="uib-stat-card g-card">
          <div class="uib-stat-value">${is.data.unread}</div>
          <div class="uib-stat-label">Unread (7d)</div>
        </div>
        <div class="uib-stat-card g-card">
          <div class="uib-stat-value">${is.data.today}</div>
          <div class="uib-stat-label">Today</div>
        </div>
        <div class="uib-stat-card g-card">
          <div class="uib-stat-value">${is.data.last24h}</div>
          <div class="uib-stat-label">Last 24h</div>
        </div>
        <div class="uib-stat-card g-card">
          <div class="uib-stat-value">${is.data.totalScanned}</div>
          <div class="uib-stat-label">Scanned</div>
        </div>
      </div>

      ${is.data.topSenders.length > 0 ? html`
        <div class="uib-stat-card g-card" style="grid-column:1 / -1">
          <div class="uib-stat-label" style="margin-bottom:6px">Top senders (7d)</div>
          <div class="uib-top-senders">
            ${is.data.topSenders.map((s) => html`
              <span class="uib-sender-pill">
                ${s.sender}
                <span class="uib-sender-count">${s.count}</span>
              </span>
            `)}
          </div>
        </div>
      ` : nothing}

      <!-- Telegram alert-rule configurator -->
      <div class="uib-alert-card g-panel">
        <div class="uib-alert-title">${icons.alert} Telegram Alert Rules</div>
        <div style="font-size:12px;color:var(--g-fg-dim)">
          Get a Telegram message when important emails arrive.
          ${state.activeAccountId == null ? html`
            <span style="color:var(--g-fg-faint)"> (Select a specific account to configure per-account rules.)</span>
          ` : nothing}
        </div>

        <!-- Enable toggle -->
        <div class="uib-alert-row">
          <span class="uib-alert-label">Enable alerts</span>
          <label class="uib-toggle">
            <input
              type="checkbox"
              ?checked=${is.alertRule.enabled}
              @change=${(e: Event) => {
                is.alertRule.enabled = (e.target as HTMLInputElement).checked;
                onUpdate();
              }}
            />
            <span class="uib-toggle-slider"></span>
          </label>
        </div>

        <!-- Poll interval -->
        <div class="uib-alert-row">
          <span class="uib-alert-label">Poll every (min)</span>
          <input
            class="uib-alert-input g-input"
            type="number"
            min="1" max="60"
            .value=${String(is.alertRule.pollIntervalMinutes)}
            @input=${(e: Event) => {
              is.alertRule.pollIntervalMinutes = Number((e.target as HTMLInputElement).value) || 5;
              onUpdate();
            }}
            style="max-width:80px"
          />
        </div>

        <!-- Telegram chat ID -->
        <div class="uib-alert-row">
          <span class="uib-alert-label">Telegram chat ID</span>
          <input
            class="uib-alert-input g-input"
            placeholder="-100xxxxxxxxx"
            .value=${is.alertRule.telegramChatId ?? ""}
            @input=${(e: Event) => {
              is.alertRule.telegramChatId = (e.target as HTMLInputElement).value;
              onUpdate();
            }}
          />
        </div>

        <!-- Sender filter -->
        <div class="uib-alert-row" style="align-items:flex-start;flex-direction:column">
          <span class="uib-alert-label">Alert from senders</span>
          <div class="uib-tag-list">
            ${is.alertRule.senders.map((s) => html`
              <span class="uib-tag">
                ${s}
                <span class="uib-tag-remove" @click=${() => {
                  is.alertRule.senders = is.alertRule.senders.filter((x) => x !== s);
                  onUpdate();
                }}>${icons.x}</span>
              </span>
            `)}
          </div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <input
              class="uib-alert-input g-input"
              placeholder="sender@example.com"
              .value=${is.senderInput}
              @input=${(e: Event) => { is.senderInput = (e.target as HTMLInputElement).value; onUpdate(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && is.senderInput.trim()) {
                  is.alertRule.senders = [...is.alertRule.senders, is.senderInput.trim()];
                  is.senderInput = "";
                  onUpdate();
                }
              }}
            />
            <button
              class="uib-save-btn g-btn g-btn--primary g-btn--sm"
              style="padding:6px 12px"
              @click=${() => {
                if (is.senderInput.trim()) {
                  is.alertRule.senders = [...is.alertRule.senders, is.senderInput.trim()];
                  is.senderInput = "";
                  onUpdate();
                }
              }}
            >Add</button>
          </div>
        </div>

        <!-- Keyword filter -->
        <div class="uib-alert-row" style="align-items:flex-start;flex-direction:column">
          <span class="uib-alert-label">Alert on keywords</span>
          <div class="uib-tag-list">
            ${is.alertRule.keywords.map((kw) => html`
              <span class="uib-tag">
                ${kw}
                <span class="uib-tag-remove" @click=${() => {
                  is.alertRule.keywords = is.alertRule.keywords.filter((x) => x !== kw);
                  onUpdate();
                }}>${icons.x}</span>
              </span>
            `)}
          </div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <input
              class="uib-alert-input g-input"
              placeholder="urgent, invoice, …"
              .value=${is.keywordInput}
              @input=${(e: Event) => { is.keywordInput = (e.target as HTMLInputElement).value; onUpdate(); }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter" && is.keywordInput.trim()) {
                  is.alertRule.keywords = [...is.alertRule.keywords, is.keywordInput.trim()];
                  is.keywordInput = "";
                  onUpdate();
                }
              }}
            />
            <button
              class="uib-save-btn g-btn g-btn--primary g-btn--sm"
              style="padding:6px 12px"
              @click=${() => {
                if (is.keywordInput.trim()) {
                  is.alertRule.keywords = [...is.alertRule.keywords, is.keywordInput.trim()];
                  is.keywordInput = "";
                  onUpdate();
                }
              }}
            >Add</button>
          </div>
        </div>

        <!-- Save -->
        <div style="display:flex;align-items:center;gap:10px">
          <button
            class="uib-save-btn g-btn g-btn--primary"
            ?disabled=${is.alertSaving}
            @click=${() => _saveAlertRule(state, onUpdate)}
          >
            ${is.alertSaving ? "Saving…" : "Save rule"}
          </button>
          ${is.alertSaved ? html`<span class="uib-success">${icons.check} Saved</span>` : nothing}
          ${is.alertError ? html`<span class="uib-error">${is.alertError}</span>` : nothing}
        </div>
      </div>
    </div>
  `;
}
