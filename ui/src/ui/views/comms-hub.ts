/**
 * Comms Hub — unified multi-platform client inbox, rendered as the "Inbox"
 * sub-tab of Channels (/channels?view=inbox; /comms redirects there).
 *
 * Three panes: thread list (filterable by channel + assignment) · conversation ·
 * composer + pending-approval queue. Backed by the comms.* RPCs. Channel setup
 * is the Channels sub-tab itself (its own per-channel cards + WhatsApp QR).
 *
 * NEW view — does not touch the off-limits clients view/controller.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";
import {
  type CommsChannel,
  type CommsMessage,
  type CommsState,
  type CommsThread,
  createCommsState,
  loadCommsChannels,
  loadCommsThreads,
  openThread,
  sendReply,
  approveDraft,
  rejectDraft,
  subscribeComms,
} from "../controllers/comms-hub";

const CHANNEL_META: Record<CommsChannel, { label: string; icon: string; color: string }> = {
  telegram: { label: "Telegram", icon: "send", color: "#2aabee" },
  email: { label: "Email", icon: "mail", color: "#d4af37" },
  whatsapp: { label: "WhatsApp", icon: "phone", color: "#25d366" },
  discord: { label: "Discord", icon: "game", color: "#5865f2" },
  instagram: { label: "Instagram", icon: "image", color: "#e1306c" },
};

const ALL_CHANNELS = Object.keys(CHANNEL_META) as CommsChannel[];

function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const now = Date.now();
  if (now - ts < 86_400_000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function channelBadge(channel: CommsChannel): TemplateResult {
  const m = CHANNEL_META[channel];
  return html`<span
    title=${m.label}
    style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;font-size:12px;background:${m.color}22;color:${m.color};border:1px solid ${m.color}55;"
    >${commIcon(m.icon, 13, m.label)}</span
  >`;
}

function getState(state: AppViewState): CommsState {
  const s = state as unknown as { commsState?: CommsState };
  if (!s.commsState) s.commsState = createCommsState();
  return s.commsState;
}

export function renderCommsHub(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  ensureCommunicationGlassStyles();
  const cs = getState(state);

  // First-render bootstrap (guarded by the `subscribed` flag so it runs once).
  if (!cs.subscribed) {
    subscribeComms(cs, client, state);
    void loadCommsChannels(cs, client, state);
    void loadCommsThreads(cs, client, state);
  }

  // Rendered as the "Inbox" sub-tab of Channels: channel setup lives on the
  // Channels sub-tab itself, so this is the cross-channel inbox only.
  return html`
    <div class="comms-hub" data-learn-id="comms-hub"
      style="display:flex;flex-direction:column;gap:12px;height:calc(100vh - 150px);min-height:420px;padding:0 0 12px;box-sizing:border-box;">
      ${renderHubHeader(cs)}
      ${renderInbox(cs, client, state)}
      ${renderToast(cs)}
    </div>
  `;
}

function renderHubHeader(cs: CommsState): TemplateResult | typeof nothing {
  if (cs.pendingApprovals <= 0) return nothing;
  return html`<div style="display:flex;align-items:center;gap:12px;padding:0 2px;">
    <span class="g-chip g-chip--gold">${cs.pendingApprovals} to approve</span>
  </div>`;
}

function renderInbox(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
): TemplateResult {
  const filtered = cs.threads;
  const selected = cs.threads.find((t) => t.threadKey === cs.selectedThreadKey) ?? null;
  return html`
    <div class="comms-layout">
      ${renderThreadList(cs, client, state, filtered)}
      ${renderConversation(cs, client, state, selected)}
    </div>
  `;
}

function renderChannelStatusBar(cs: CommsState): TemplateResult {
  if (!cs.channels.length) return html`${nothing}`;
  return html`<div data-learn-id="comms-channel-status" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
    ${cs.channels.map((c) => {
      const m = CHANNEL_META[c.channel];
      const ok = c.configured && c.enabled;
      return html`<span
        title=${c.setupNotes ?? `${m.label} ready`}
        class="g-chip"
        style="--channel-color:${m.color};border-color:${ok ? m.color + "66" : "var(--glass-stroke)"};background:${ok ? m.color + "18" : "var(--glass-1)"};color:${ok ? m.color : "var(--glass-fg-3)"};"
      >
        ${commIcon(m.icon, 12)} ${m.label} ${ok ? "" : "· setup"}
      </span>`;
    })}
  </div>`;
}

function renderThreadList(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  threads: CommsThread[],
): TemplateResult {
  return html`
    <div class="comms-pane comms-thread-pane" data-learn-id="comms-threads">
      <div class="comms-pane-head">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong style="font-size:13px;color:var(--glass-fg-3);text-transform:uppercase;letter-spacing:var(--glass-tracking-caps,.08em);">Threads</strong>
          ${cs.pendingApprovals > 0
            ? html`<span class="g-chip g-chip--gold">${cs.pendingApprovals} to approve</span>`
            : nothing}
        </div>
        ${renderChannelStatusBar(cs)}
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <select
            .value=${cs.assignmentFilter}
            @change=${(e: Event) => {
              cs.assignmentFilter = (e.target as HTMLSelectElement).value;
              void loadCommsThreads(cs, client, state);
            }}
            class="comms-select" style="flex:1;padding:7px;font-size:12px;"
          >
            <option value="all">All assignments</option>
            <option value="unassigned">Unassigned</option>
            <option value="me">Assigned to me</option>
          </select>
          <select
            data-learn-id="comms-channel-filter"
            .value=${cs.channelFilter}
            @change=${(e: Event) => {
              cs.channelFilter = (e.target as HTMLSelectElement).value as CommsChannel | "all";
              void loadCommsThreads(cs, client, state);
            }}
            class="comms-select" style="flex:1;padding:7px;font-size:12px;"
          >
            <option value="all">All channels</option>
            ${ALL_CHANNELS.map((c) => html`<option value=${c}>${CHANNEL_META[c].label}</option>`)}
          </select>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;">
        ${cs.loading && !threads.length
          ? html`<div style="padding:16px;opacity:0.5;font-size:13px;">Loading threads…</div>`
          : threads.length === 0
            ? html`<div class="comms-empty" style="padding:24px;margin:10px;font-size:13px;">
                No conversations yet. Inbound client messages will appear here once a channel is
                wired.
              </div>`
            : threads.map((t) => renderThreadRow(cs, client, state, t))}
      </div>
    </div>
  `;
}

function renderThreadRow(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  t: CommsThread,
): TemplateResult {
  const active = t.threadKey === cs.selectedThreadKey;
  const title = t.clientName ?? t.peerDisplayName ?? t.peerHandle;
  return html`
    <button
      @click=${() => void openThread(cs, client, state, t.threadKey)}
      class="comms-thread ${active ? "is-active" : ""}"
    >
      <div style="display:flex;align-items:center;gap:8px;">
        ${channelBadge(t.channel)}
        <span style="font-weight:600;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          >${title}</span
        >
        ${t.unreadCount > 0
          ? html`<span class="g-chip g-chip--gold"
              style="font-size:10px;background:var(--glass-gold-fill);color:var(--glass-ink);padding:1px 6px;font-weight:700;"
              >${t.unreadCount}</span
            >`
          : nothing}
        <span style="font-size:11px;opacity:0.5;">${fmtTime(t.lastMessageAt)}</span>
      </div>
      <div style="font-size:12px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        ${t.lastDirection === "outbound" ? commIcon("send", 11) : nothing}${t.lastMessagePreview || "—"}
      </div>
      ${t.assignedAgentId
        ? html`<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--glass-fg-2);">${commIcon("user", 11)} ${t.assignedAgentId}</span>`
        : nothing}
    </button>
  `;
}

function renderConversation(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  thread: CommsThread | null,
): TemplateResult {
  if (!thread) {
    return html`<div class="comms-pane comms-empty" data-learn-id="comms-conversation"
      style="display:flex;align-items:center;justify-content:center;font-size:14px;">
      Select a conversation
    </div>`;
  }
  const title = thread.clientName ?? thread.peerDisplayName ?? thread.peerHandle;
  const channelConfigured = cs.channels.find((c) => c.channel === thread.channel)?.configured ?? false;

  return html`
    <div class="comms-pane comms-conversation-pane">
      <div
        style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--glass-stroke);"
      >
        ${channelBadge(thread.channel)}
        <div style="flex:1;">
          <div style="font-weight:600;">${title}</div>
          <div style="font-size:11px;opacity:0.5;">
            ${CHANNEL_META[thread.channel].label} · ${thread.peerHandle}
          </div>
        </div>
        ${thread.assignedAgentId
          ? html`<span class="g-chip" style="font-size:11px;">${commIcon("user", 12)} Assigned: ${thread.assignedAgentId}</span>`
          : nothing}
      </div>

      <div class="comms-messages">
        ${cs.messages.length === 0
          ? html`<div style="opacity:0.4;font-size:13px;">No messages in this thread yet.</div>`
          : cs.messages.map((m) => renderMessage(cs, client, state, m))}
      </div>

      ${renderComposer(cs, client, state, thread, channelConfigured)}
    </div>
  `;
}

function renderMessage(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  m: CommsMessage,
): TemplateResult {
  const outbound = m.direction === "outbound";
  const pending = m.status === "pending_approval";
  const failed = m.status === "failed";
  return html`
    <div style="display:flex;flex-direction:column;align-items:${outbound ? "flex-end" : "flex-start"};">
      <div class="comms-message ${outbound ? "outbound" : "inbound"} ${pending ? "pending" : ""} ${failed ? "failed" : ""}">
        ${m.text}
        ${failed && m.error
          ? html`<div style="font-size:11px;color:var(--c-danger,#e5484d);margin-top:4px;">${commIcon("alert", 12)} ${m.error}</div>`
          : nothing}
      </div>
      <div style="font-size:10px;opacity:0.45;margin-top:2px;display:flex;gap:6px;align-items:center;">
        <span>${fmtTime(m.createdAt)}</span>
        ${m.sentByAgentId ? html`<span style="display:inline-flex;align-items:center;gap:3px;color:var(--glass-fg-2);">${commIcon("user", 10)} ${m.sentByAgentId}</span>` : nothing}
        ${pending ? html`<span class="g-text-gold">pending approval</span>` : nothing}
        ${m.status === "sent" ? html`<span>${commIcon("check", 10)} sent</span>` : nothing}
      </div>
      ${pending
        ? html`<div style="display:flex;gap:6px;margin-top:4px;">
            <button
              @click=${() => void approveDraft(cs, client, state, m.id)}
              class="g-btn g-btn--primary g-btn--sm"
              style="font-size:11px;padding:3px 10px;cursor:pointer;"
            >
              Approve &amp; send
            </button>
            <button
              @click=${() => void rejectDraft(cs, client, state, m.id)}
              class="g-btn g-btn--danger g-btn--sm"
              style="font-size:11px;padding:3px 10px;cursor:pointer;"
            >
              Reject
            </button>
          </div>`
        : nothing}
    </div>
  `;
}

function renderComposer(
  cs: CommsState,
  client: GatewayBrowserClient,
  state: AppViewState,
  thread: CommsThread,
  channelConfigured: boolean,
): TemplateResult {
  return html`
    <div class="comms-composer">
      ${cs.error
        ? html`<div style="font-size:12px;color:var(--c-danger,#e5484d);margin-bottom:8px;">${cs.error}</div>`
        : nothing}
      ${!channelConfigured
        ? html`<div class="g-text-gold" style="font-size:12px;margin-bottom:8px;">
            ${CHANNEL_META[thread.channel].label} is not configured — replies will fail until setup.
          </div>`
        : nothing}
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <select
          .value=${cs.composeChannel ?? thread.channel}
          @change=${(e: Event) => {
            cs.composeChannel = (e.target as HTMLSelectElement).value as CommsChannel;
            state.requestUpdate?.();
          }}
          class="comms-select" style="padding:8px;font-size:12px;"
        >
          ${ALL_CHANNELS.map(
            (c) => html`<option value=${c} ?selected=${(cs.composeChannel ?? thread.channel) === c}>${CHANNEL_META[c].label}</option>`,
          )}
        </select>
        <textarea
          .value=${cs.composeText}
          @input=${(e: Event) => {
            cs.composeText = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void sendReply(cs, client, state);
            }
          }}
          placeholder="Reply to ${thread.clientName ?? thread.peerHandle}…  (⌘/Ctrl+Enter to send)"
          rows="2"
          class="comms-input" style="flex:1 1 220px;min-width:0;resize:vertical;padding:9px;font-size:13px;"
        ></textarea>
        <button
          ?disabled=${cs.sending || !cs.composeText.trim()}
          @click=${() => void sendReply(cs, client, state)}
          class="comms-btn comms-btn-primary" style="padding:9px 16px;cursor:pointer;opacity:${cs.sending || !cs.composeText.trim() ? 0.5 : 1};"
        >
          ${cs.sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  `;
}

function renderToast(cs: CommsState): TemplateResult {
  if (!cs.toast) return html`${nothing}`;
  const ok = cs.toast.kind === "ok";
  const color = ok ? "#25d366" : "#e5484d";
  return html`<div class="toast g-float"
    style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1300;display:flex;align-items:center;gap:8px;padding:11px 18px;color:${color};font-size:13px;font-weight:600;"
  >
    <span>${commIcon(ok ? "check" : "alert", 15)}</span>${cs.toast.message}
  </div>`;
}
