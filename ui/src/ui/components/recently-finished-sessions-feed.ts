/**
 * RecentlyFinishedSessionsFeed — recently finished sessions & agents.
 *
 * Combines sessions.list (filtered to inactive) + subagents.list (completed)
 * into a unified collapsible list. Transcripts load lazily on first expand,
 * cached per session-key so re-expanding is instant.
 *
 * Collapse state is persisted to localStorage so it survives page reload.
 * Polls every 30 s; also reacts to subagent:completed / session.completed events.
 */

import { LitElement, html, nothing, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import {
  getCoderBackendIcon,
  getCoderBackendIconLabel,
} from "../lib/coder-backend-brand";
import { managedInterval, type SchedulerHandle } from "../perf/visibility-scheduler";

// ── Types ──────────────────────────────────────────────────────

type Outcome = "ok" | "error" | "cancelled";

interface FinishedEntry {
  id: string;
  kind: "session" | "subagent";
  label: string;
  finishedAt: number;
  durationMs?: number;
  outcome?: Outcome;
  sessionKey: string;
  totalTokens?: number;
  model?: string;
  /** CLI backend that produced this subagent run, when known. */
  coderBackend?: string;
}

interface TranscriptMsg {
  role?: string;
  type?: string;
  content?: unknown;
}

type TranscriptState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; messages: TranscriptMsg[]; truncated: boolean };

// ── Constants ──────────────────────────────────────────────────

const STORAGE_KEY        = "ib.rfsf.collapsed";
const TRANSCRIPT_LIMIT   = 500;
const POLL_MS            = 30_000;
const FINISH_HEURISTIC   = 5 * 60_000; // >5 min inactive = "finished"
const PAGE_SIZE          = 25;

// ── Helpers ────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000)       return "just now";
  if (d < 60_000)      return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000)   return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000)  return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtDur(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  const s = Math.floor(ms / 1_000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

function fmtTok(n: number | undefined): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function msgText(m: TranscriptMsg): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as { type?: string; text?: string }[])
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

function buildMarkdown(label: string, msgs: TranscriptMsg[]): string {
  const lines = msgs.map((m) => {
    const role = m.role ?? "assistant";
    const text = msgText(m);
    return `**${role}**\n\n${text}`;
  });
  return `# Session: ${label}\n\n${lines.join("\n\n---\n\n")}`;
}

// ── SVG icons (no emoji) ───────────────────────────────────────

const ICO_SESSION = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const ICO_AGENT   = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/></svg>`;
const ICO_CHEVRON = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICO_COPY    = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICO_OPEN    = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
const ICO_RETRY   = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
const ICO_HISTORY = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
const ICO_ALERT   = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const ICO_TOOL    = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`;

// ── Component ──────────────────────────────────────────────────

@customElement("recently-finished-sessions-feed")
export class RecentlyFinishedSessionsFeed extends LitElement {
  // ── Properties ───────────────────────────────────────────────
  @property({ attribute: false }) gateway!: GatewayBrowserClient;
  @property({ attribute: false }) onOpenSession?: (sessionKey: string) => void;

  // ── Internal state ───────────────────────────────────────────
  @state() private _entries: FinishedEntry[]                    = [];
  @state() private _loading                                     = false;
  @state() private _error: string | null                        = null;
  @state() private _collapsed                                   = this._readCollapsed();
  @state() private _expandedId: string | null                   = null;
  @state() private _transcripts = new Map<string, TranscriptState>();
  @state() private _toolOpen    = new Set<string>();
  @state() private _showAll                                     = false;

  private _pollTimer:  SchedulerHandle | null                   = null;
  private _tickTimer:  SchedulerHandle | null                   = null;
  private _wsUnsub:   (() => void) | null                       = null;

  // ── Lifecycle ─────────────────────────────────────────────────
  override connectedCallback() {
    super.connectedCallback();
    void this._load();
    this._pollTimer = managedInterval(() => void this._load(), POLL_MS, { hiddenMs: 60_000 });
    this._tickTimer = managedInterval(() => this.requestUpdate(), 30_000, { hiddenMs: 120_000 });
    this._subscribeWs();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollTimer !== null) { this._pollTimer.cancel(); this._pollTimer = null; }
    if (this._tickTimer !== null) { this._tickTimer.cancel(); this._tickTimer = null; }
    this._wsUnsub?.(); this._wsUnsub = null;
  }

  // ── WebSocket subscription ────────────────────────────────────
  private _subscribeWs() {
    if (!this.gateway || this._wsUnsub) return;
    this._wsUnsub = this.gateway.subscribe((evt) => {
      if (
        evt.event === "subagent:completed" ||
        evt.event === "session:completed"  ||
        evt.event === "session.completed"
      ) {
        void this._load();
      }
    });
  }

  // ── Collapse ──────────────────────────────────────────────────
  private _readCollapsed(): boolean {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s === null ? false : s === "1";
    } catch { return false; }
  }

  private _setCollapsed(v: boolean) {
    this._collapsed = v;
    try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch { /* best-effort */ }
  }

  // ── Data load ─────────────────────────────────────────────────
  private async _load() {
    if (!this.gateway || this._loading) return;
    this._loading = true;
    this._error   = null;
    this.requestUpdate();

    try {
      const [sessRes, subRes] = await Promise.allSettled([
        this.gateway.request("sessions.list", {
          activeMinutes: 1440,
          limit: 50,
        }),
        this.gateway.request("subagents.list", {
          includeCompleted: true,
          limit: 50,
          compact: true,
        }),
      ]);

      const now = Date.now();
      const raw: FinishedEntry[] = [];

      // Sessions
      if (sessRes.status === "fulfilled") {
        const sessions = ((sessRes.value as Record<string, unknown>)?.sessions ?? []) as Record<string, unknown>[];
        for (const s of sessions) {
          const updatedAt = typeof s.updatedAt === "number" ? s.updatedAt : 0;
          // Skip sessions still active (updated within heuristic window)
          if (updatedAt > 0 && now - updatedAt < FINISH_HEURISTIC) continue;
          raw.push({
            id:          String(s.key ?? ""),
            kind:        "session",
            label:       String(s.displayName || s.label || s.key || ""),
            finishedAt:  updatedAt,
            totalTokens: typeof s.totalTokens === "number" ? s.totalTokens : undefined,
            model:       typeof s.model === "string" ? s.model : undefined,
            sessionKey:  String(s.key ?? ""),
          });
        }
      }

      // Subagents
      if (subRes.status === "fulfilled") {
        const subs = ((subRes.value as Record<string, unknown>)?.subagents ?? []) as Record<string, unknown>[];
        for (const sub of subs) {
          const st = String(sub.status ?? "");
          if (st !== "completed" && st !== "complete" && !sub.outcome) continue;
          const endedAt    = typeof sub.endedAt    === "number" ? sub.endedAt    : 0;
          const startedAt  = typeof sub.startedAt  === "number" ? sub.startedAt  : 0;
          const updatedAt  = typeof sub.lastUpdateAt === "number" ? sub.lastUpdateAt : 0;
          const finishedAt = endedAt || updatedAt;
          const durationMs = startedAt && endedAt ? endedAt - startedAt : undefined;
          const rawOut     = (sub.outcome as Record<string, unknown> | undefined)?.status;
          const outcome: Outcome | undefined =
            rawOut === "ok" ? "ok" : rawOut === "error" ? "error" : rawOut === "cancelled" ? "cancelled" : undefined;
          raw.push({
            id:          String(sub.runId ?? ""),
            kind:        "subagent",
            label:       String(sub.label || sub.task || sub.runId || ""),
            finishedAt,
            durationMs,
            outcome,
            sessionKey:  String(sub.sessionKey ?? ""),
            coderBackend: typeof sub.coderBackend === "string" ? sub.coderBackend : undefined,
          });
        }
      }

      // Deduplicate + sort newest first, cap to 50
      const seen = new Set<string>();
      this._entries = raw
        .filter((e) => { if (!e.id || seen.has(e.id)) return false; seen.add(e.id); return true; })
        .sort((a, b) => b.finishedAt - a.finishedAt)
        .slice(0, 50);
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
      this.requestUpdate();
    }
  }

  // ── Transcript fetch ──────────────────────────────────────────
  private async _fetchTranscript(entry: FinishedEntry) {
    const existing = this._transcripts.get(entry.id);
    if (existing && existing.status !== "error") return; // already loading/loaded

    this._transcripts = new Map(this._transcripts).set(entry.id, { status: "loading" });
    this.requestUpdate();

    try {
      const res = await this.gateway.request("chat.history", {
        sessionKey: entry.sessionKey,
        limit: TRANSCRIPT_LIMIT,
      }) as { messages?: TranscriptMsg[] };

      const msgs = Array.isArray(res?.messages) ? res.messages : [];
      if (msgs.length === 0 && !Array.isArray(res?.messages)) {
        throw new Error("Gateway returned no transcript data");
      }
      this._transcripts = new Map(this._transcripts).set(entry.id, {
        status:    "loaded",
        messages:  msgs,
        truncated: msgs.length >= TRANSCRIPT_LIMIT,
      });
    } catch (err) {
      this._transcripts = new Map(this._transcripts).set(entry.id, {
        status: "error",
        error:  err instanceof Error ? err.message : String(err),
      });
    }
    this.requestUpdate();
  }

  private _retryTranscript(entry: FinishedEntry) {
    const m = new Map(this._transcripts);
    m.delete(entry.id);
    this._transcripts = m;
    void this._fetchTranscript(entry);
  }

  // ── Row expand ────────────────────────────────────────────────
  private _toggle(entry: FinishedEntry) {
    if (this._expandedId === entry.id) {
      this._expandedId = null;
    } else {
      this._expandedId = entry.id;
      void this._fetchTranscript(entry);
    }
    this.requestUpdate();
  }

  // ── Open in chat ──────────────────────────────────────────────
  private _openChat(entry: FinishedEntry, e: Event) {
    e.stopPropagation();
    if (this.onOpenSession) {
      this.onOpenSession(entry.sessionKey);
    } else {
      this.dispatchEvent(new CustomEvent("open-session", {
        detail: { sessionKey: entry.sessionKey },
        bubbles: true,
        composed: true,
      }));
    }
  }

  // ── Copy transcript ───────────────────────────────────────────
  private _copyTranscript(entry: FinishedEntry, e: Event) {
    e.stopPropagation();
    const ts = this._transcripts.get(entry.id);
    if (ts?.status !== "loaded") return;
    navigator.clipboard
      .writeText(buildMarkdown(entry.label, ts.messages))
      .catch(() => { /* best-effort */ });
  }

  // ── Tool-call expand ──────────────────────────────────────────
  private _toggleTool(key: string, e: Event) {
    e.stopPropagation();
    const s = new Set(this._toolOpen);
    if (s.has(key)) s.delete(key); else s.add(key);
    this._toolOpen = s;
  }

  // ── Render ────────────────────────────────────────────────────
  override render() {
    return html`
      ${this._renderHeader()}
      ${this._collapsed ? nothing : this._renderBody()}
    `;
  }

  private _renderHeader() {
    return html`
      <div
        class="rfsf-header"
        role="button"
        tabindex="0"
        aria-expanded="${!this._collapsed}"
        @click=${() => this._setCollapsed(!this._collapsed)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this._setCollapsed(!this._collapsed);
          }
        }}
      >
        <span class="rfsf-header-icon">${ICO_HISTORY}</span>
        <span class="rfsf-header-title">Recently Finished Sessions &amp; Agents</span>
        ${this._entries.length > 0
          ? html`<span class="rfsf-count">${this._entries.length}</span>`
          : nothing}
        ${this._loading
          ? html`<span class="rfsf-spinner" aria-label="Loading"></span>`
          : nothing}
        <span class="rfsf-header-chevron" style="transform:rotate(${this._collapsed ? "0deg" : "180deg"})">
          ${ICO_CHEVRON}
        </span>
      </div>
    `;
  }

  private _renderBody() {
    if (this._loading && this._entries.length === 0) return this._renderSkeleton();
    if (this._error)                                 return this._renderFeedError();
    if (this._entries.length === 0)                  return this._renderEmpty();

    const shown = this._showAll ? this._entries : this._entries.slice(0, PAGE_SIZE);
    return html`
      <div class="rfsf-body">
        <div class="rfsf-list">
          ${shown.map((e) => this._renderRow(e))}
        </div>
        ${!this._showAll && this._entries.length > PAGE_SIZE ? html`
          <button class="rfsf-more-btn" @click=${() => { this._showAll = true; }}>
            Show ${this._entries.length - PAGE_SIZE} more
          </button>
        ` : nothing}
      </div>
    `;
  }

  private _renderBackendChip(backend: string | undefined) {
    const icon = getCoderBackendIcon(backend);
    if (!icon) return nothing;
    const label = getCoderBackendIconLabel(backend);
    return html`
      <span class="rfsf-backend-chip" title=${label} aria-label=${label}>
        ${icon}
      </span>
    `;
  }

  private _renderRow(entry: FinishedEntry) {
    const expanded   = this._expandedId === entry.id;
    const dur        = fmtDur(entry.durationMs);
    const ago        = timeAgo(entry.finishedAt);
    const oc         = entry.outcome;
    const ocColor    = oc === "ok" ? "#22c55e" : oc === "error" ? "#ef4444" : "var(--g-fg-faint,#52525b)";
    const ocLabel    = oc === "ok" ? "OK" : oc === "error" ? "ERROR" : oc === "cancelled" ? "CANCEL" : "";

    return html`
      <div class="rfsf-row-wrap">
        <div
          class="rfsf-row${expanded ? " rfsf-row--open" : ""}"
          role="button"
          tabindex="0"
          aria-expanded="${expanded}"
          @click=${() => this._toggle(entry)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._toggle(entry); }
          }}
        >
          <span class="rfsf-kind-icon" title="${entry.kind === "session" ? "Session" : "Sub-agent"}">
            ${entry.kind === "session" ? ICO_SESSION : ICO_AGENT}
          </span>
          ${this._renderBackendChip(entry.coderBackend)}
          <span class="rfsf-row-label">${entry.label}</span>
          <span class="rfsf-row-time" title="${new Date(entry.finishedAt).toLocaleString()}">finished ${ago}</span>
          ${dur  ? html`<span class="rfsf-pill rfsf-pill--dur">${dur}</span>` : nothing}
          ${ocLabel ? html`
            <span class="rfsf-pill rfsf-pill--oc"
              style="color:${ocColor};border-color:${ocColor}55;background:${ocColor}11;"
            >${ocLabel}</span>
          ` : nothing}
          <span class="rfsf-row-chevron" style="transform:rotate(${expanded ? "180deg" : "0deg"})">
            ${ICO_CHEVRON}
          </span>
        </div>
        ${expanded ? this._renderExpanded(entry) : nothing}
      </div>
    `;
  }

  private _renderExpanded(entry: FinishedEntry) {
    const ts = this._transcripts.get(entry.id) ?? { status: "idle" as const };
    return html`
      <div class="rfsf-expanded">
        <!-- Meta strip -->
        <div class="rfsf-meta">
          <span class="rfsf-meta-item">
            <span class="rfsf-meta-lbl">Key</span>
            <code class="rfsf-mono" title="${entry.sessionKey}">${entry.sessionKey}</code>
          </span>
          ${entry.model ? html`
            <span class="rfsf-meta-item">
              <span class="rfsf-meta-lbl">Model</span>
              <span class="rfsf-mono">${entry.model}</span>
            </span>
          ` : nothing}
          ${entry.totalTokens ? html`
            <span class="rfsf-meta-item">
              <span class="rfsf-meta-lbl">Tokens</span>
              <span>${fmtTok(entry.totalTokens)}</span>
            </span>
          ` : nothing}
        </div>
        <!-- Actions -->
        <div class="rfsf-actions">
          <button class="rfsf-act-btn" @click=${(e: Event) => this._openChat(entry, e)}>
            ${ICO_OPEN}<span>Open in chat</span>
          </button>
          ${ts.status === "loaded" ? html`
            <button class="rfsf-act-btn" @click=${(e: Event) => this._copyTranscript(entry, e)}>
              ${ICO_COPY}<span>Copy transcript</span>
            </button>
          ` : nothing}
        </div>
        <!-- Transcript -->
        <div class="rfsf-transcript-wrap">
          ${this._renderTranscript(entry, ts)}
        </div>
      </div>
    `;
  }

  private _renderTranscript(entry: FinishedEntry, ts: TranscriptState) {
    if (ts.status === "idle" || ts.status === "loading") {
      return html`
        <div class="rfsf-ts-loading">
          <span class="rfsf-spinner"></span>
          <span>Loading transcript…</span>
        </div>
      `;
    }

    if (ts.status === "error") {
      return html`
        <div class="rfsf-ts-error">
          ${ICO_ALERT}
          <span class="rfsf-ts-err-msg">${ts.error}</span>
          <button class="rfsf-retry-btn" @click=${(e: Event) => {
            e.stopPropagation();
            this._retryTranscript(entry);
          }}>
            ${ICO_RETRY} Retry
          </button>
        </div>
      `;
    }

    // status === "loaded"
    const msgs = ts.messages;
    if (msgs.length === 0) {
      return html`<p class="rfsf-ts-empty">No messages in transcript.</p>`;
    }

    return html`
      ${ts.truncated ? html`
        <div class="rfsf-ts-cap">Showing last ${TRANSCRIPT_LIMIT} messages — open in chat for full history</div>
      ` : nothing}
      <div class="rfsf-messages">
        ${msgs.map((m, i) => this._renderMsg(m, i))}
      </div>
    `;
  }

  private _renderMsg(m: TranscriptMsg, idx: number) {
    const role = String(m.role ?? "assistant");

    if (role === "tool" || m.type === "tool_result") {
      const text = msgText(m);
      if (!text) return nothing;
      return html`
        <div class="rfsf-msg rfsf-msg--tool">
          <span class="rfsf-msg-role">${ICO_TOOL} tool result</span>
          <pre class="rfsf-tool-txt">${text.length > 500 ? text.slice(0, 500) + "…" : text}</pre>
        </div>
      `;
    }

    if (Array.isArray(m.content)) {
      const parts = m.content as { type?: string; text?: string; name?: string; input?: unknown; arguments?: unknown }[];
      return html`
        <div class="rfsf-msg rfsf-msg--${role}">
          <span class="rfsf-msg-role">${role}</span>
          ${parts.map((part, pi) => {
            if (part?.type === "text") {
              return html`<p class="rfsf-msg-text">${part.text}</p>`;
            }
            if (part?.type === "tool_use") {
              const key      = `${idx}:${pi}`;
              const open     = this._toolOpen.has(key);
              const argsStr  = JSON.stringify(part.input ?? part.arguments ?? {}, null, 2);
              const preview  = argsStr.slice(0, 120);
              return html`
                <div class="rfsf-tool-call">
                  <button class="rfsf-tool-hdr" @click=${(e: Event) => this._toggleTool(key, e)}>
                    ${ICO_TOOL}
                    <span class="rfsf-tool-name">${part.name}</span>
                    <span class="rfsf-tool-chev" style="transform:rotate(${open ? "180deg" : "0deg"})">${ICO_CHEVRON}</span>
                  </button>
                  ${open
                    ? html`<pre class="rfsf-tool-args">${argsStr}</pre>`
                    : html`<span class="rfsf-tool-preview">${preview}${argsStr.length > 120 ? "…" : ""}</span>`
                  }
                </div>
              `;
            }
            return nothing;
          })}
        </div>
      `;
    }

    const text = msgText(m);
    if (!text) return nothing;
    return html`
      <div class="rfsf-msg rfsf-msg--${role}">
        <span class="rfsf-msg-role">${role}</span>
        <p class="rfsf-msg-text">${text}</p>
      </div>
    `;
  }

  private _renderSkeleton() {
    return html`
      <div class="rfsf-body">
        ${[0, 1, 2].map((i) => html`
          <div class="rfsf-skel" style="animation-delay:${i * 0.08}s"></div>
        `)}
      </div>
    `;
  }

  private _renderFeedError() {
    return html`
      <div class="rfsf-body">
        <div class="rfsf-feed-err">
          ${ICO_ALERT}
          <span>${this._error}</span>
          <button class="rfsf-retry-btn" @click=${() => void this._load()}>
            ${ICO_RETRY} Retry
          </button>
        </div>
      </div>
    `;
  }

  private _renderEmpty() {
    return html`
      <div class="rfsf-body">
        <div class="rfsf-empty">No recently finished sessions or agents.</div>
      </div>
    `;
  }

  // ── Styles ────────────────────────────────────────────────────
  static override styles = css`
    :host {
      display: block;
      font-family: var(--g-mono, "JetBrains Mono", monospace);
      font-size: 12px;
    }

    /* ── Header ──────────────────────────────────────── */
    .rfsf-header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; cursor: pointer; user-select: none;
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      border-bottom: none;
      background: var(--g-surface, rgba(255,255,255,0.04));
      color: var(--g-primary, #d4af37);
    }
    .rfsf-header:hover { background: var(--g-surface-hover, rgba(255,255,255,0.08)); }
    .rfsf-header-icon { display: flex; align-items: center; }
    .rfsf-header-title {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase;
    }
    .rfsf-count {
      font-size: 10px; padding: 1px 7px;
      border: 1px solid var(--g-primary-muted, rgba(212,175,55,0.3));
      color: var(--g-primary, #d4af37);
    }
    .rfsf-header-chevron {
      display: flex; align-items: center; margin-left: auto;
      color: var(--g-fg-dim, #71717a); transition: transform 0.2s ease;
    }

    /* ── Spinner ─────────────────────────────────────── */
    .rfsf-spinner {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--g-primary, #d4af37);
      animation: rfsf-pulse 1.2s ease-in-out infinite;
    }

    /* ── Body ────────────────────────────────────────── */
    .rfsf-body {
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--g-primary, #d4af37) 4%, rgba(0,0,0,0.35)),
          var(--g-bg-deep, rgba(0,0,0,0.5)));
    }
    .rfsf-list {
      display: flex; flex-direction: column;
      gap: 8px;
      padding: 10px;
    }

    /* ── Rows / cards ───────────────────────────────── */
    .rfsf-row-wrap {
      border-radius: 10px;
      overflow: hidden;
      background:
        linear-gradient(135deg,
          color-mix(in srgb, var(--g-primary, #d4af37) 5%, rgba(20,16,30,0.45)),
          color-mix(in srgb, var(--g-bg-deep, #000) 70%, transparent));
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.05),
        inset 0 -1px 0 rgba(0,0,0,0.35),
        0 4px 14px rgba(0,0,0,0.25);
      transition: transform 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .rfsf-row-wrap:hover {
      transform: translateY(-1px);
      border-color: var(--g-primary-muted, rgba(212,175,55,0.35));
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.07),
        inset 0 -1px 0 rgba(0,0,0,0.35),
        0 8px 22px rgba(0,0,0,0.35);
    }

    .rfsf-row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px; cursor: pointer; user-select: none;
      color: var(--g-fg, #e4e4e7);
    }
    .rfsf-row--open {
      background: color-mix(in srgb, var(--g-primary, #d4af37) 4%, transparent);
      border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.08));
    }

    .rfsf-kind-icon {
      display: flex; align-items: center; flex-shrink: 0;
      color: var(--g-primary, #d4af37);
      width: 20px; height: 20px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent);
      justify-content: center;
    }
    .rfsf-backend-chip {
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0; width: 22px; height: 22px;
      color: var(--g-fg, #e4e4e7);
      border-radius: 5px;
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--g-border, rgba(255,255,255,0.1));
    }
    .rfsf-backend-chip svg { display: block; width: 14px; height: 14px; }
    .rfsf-row-label {
      flex: 1; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-weight: 600; font-size: 12px;
    }
    .rfsf-row-time  {
      flex-shrink: 0; font-size: 10.5px;
      color: var(--g-fg-dim, #71717a);
      letter-spacing: 0.03em;
    }

    .rfsf-pill {
      flex-shrink: 0; font-size: 9.5px; padding: 2px 7px;
      border: 1px solid; letter-spacing: 0.08em;
      border-radius: 999px;
      text-transform: uppercase; font-weight: 700;
    }
    .rfsf-pill--dur {
      color: var(--g-fg-dim, #71717a);
      border-color: var(--g-border-strong, rgba(255,255,255,0.18));
      background: rgba(255,255,255,0.03);
    }

    .rfsf-row-chevron {
      display: flex; align-items: center; flex-shrink: 0;
      color: var(--g-fg-dim, #71717a); transition: transform 0.2s ease;
    }

    /* ── Expanded panel ──────────────────────────────── */
    .rfsf-expanded {
      padding: 12px;
      background: var(--g-bg-deep, rgba(0,0,0,0.35));
      border-top: 1px solid var(--g-border, rgba(255,255,255,0.06));
      animation: rfsf-expand 0.15s ease;
    }

    /* ── Meta strip ──────────────────────────────────── */
    .rfsf-meta {
      display: flex; flex-wrap: wrap; gap: 10px;
      margin-bottom: 10px; padding-bottom: 8px;
      border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.06));
    }
    .rfsf-meta-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--g-fg-dim, #71717a); }
    .rfsf-meta-lbl  { font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--g-fg-faint, #52525b); }
    .rfsf-mono {
      font-family: inherit; max-width: 280px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--g-fg, #e4e4e7);
    }

    /* ── Actions ─────────────────────────────────────── */
    .rfsf-actions { display: flex; gap: 8px; margin-bottom: 10px; }
    .rfsf-act-btn {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 10px; font-size: 11px; font-family: inherit;
      background: transparent; cursor: pointer;
      border: 1px solid var(--g-border-strong, rgba(255,255,255,0.12));
      color: var(--g-fg-dim, #71717a); letter-spacing: 0.05em;
      transition: border-color 0.1s, color 0.1s;
    }
    .rfsf-act-btn:hover { border-color: var(--g-primary-muted, rgba(212,175,55,0.4)); color: var(--g-primary, #d4af37); }

    /* ── Transcript ──────────────────────────────────── */
    .rfsf-transcript-wrap { max-height: 480px; overflow-y: auto; }
    .rfsf-ts-cap {
      font-size: 10px; color: var(--g-fg-faint, #52525b);
      padding: 4px 0 8px; margin-bottom: 8px;
      border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.06));
      letter-spacing: 0.04em;
    }
    .rfsf-ts-loading {
      display: flex; align-items: center; gap: 8px;
      padding: 12px; color: var(--g-fg-dim, #71717a);
    }
    .rfsf-ts-error {
      display: flex; align-items: center; gap: 8px;
      padding: 10px; color: #ef4444; font-size: 12px;
      border: 1px solid rgba(239,68,68,0.2);
      background: rgba(239,68,68,0.05);
    }
    .rfsf-ts-err-msg { flex: 1; }
    .rfsf-ts-empty { padding: 8px 0; color: var(--g-fg-dim, #71717a); font-size: 12px; margin: 0; }

    .rfsf-retry-btn {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 8px; background: transparent;
      border: 1px solid rgba(239,68,68,0.3); color: #ef4444;
      cursor: pointer; font-family: inherit; font-size: 11px; margin-left: auto;
    }
    .rfsf-retry-btn:hover { background: rgba(239,68,68,0.1); }

    /* ── Messages ────────────────────────────────────── */
    .rfsf-messages { display: flex; flex-direction: column; gap: 6px; }

    .rfsf-msg { padding: 6px 8px; }
    .rfsf-msg--user      { background: color-mix(in srgb, var(--g-primary, #d4af37) 5%, transparent); border-left: 2px solid var(--g-primary, #d4af37); }
    .rfsf-msg--assistant { background: var(--g-surface, rgba(255,255,255,0.03)); border-left: 2px solid var(--g-fg-dim, #71717a); }
    .rfsf-msg--tool      { background: rgba(34,197,94,0.05); border-left: 2px solid #22c55e; }

    .rfsf-msg-role {
      display: flex; align-items: center; gap: 4px;
      font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--g-fg-faint, #52525b); margin-bottom: 4px;
    }
    .rfsf-msg-text {
      margin: 0; white-space: pre-wrap; word-break: break-word;
      color: var(--g-fg, #e4e4e7); font-size: 12px; font-family: inherit;
    }
    .rfsf-tool-txt {
      margin: 0; padding: 6px 8px; font-family: inherit; font-size: 11px;
      color: var(--g-fg-dim, #71717a); white-space: pre-wrap; word-break: break-all;
      border-top: 1px solid var(--g-border, rgba(255,255,255,0.06));
      max-height: 200px; overflow-y: auto;
    }

    /* ── Tool call ───────────────────────────────────── */
    .rfsf-tool-call {
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      background: var(--g-bg-deep, rgba(0,0,0,0.3));
      margin-top: 4px;
    }
    .rfsf-tool-hdr {
      display: flex; align-items: center; gap: 6px; padding: 5px 8px; width: 100%;
      background: transparent; border: none; cursor: pointer;
      font-family: inherit; font-size: 11px; color: var(--g-fg-dim, #71717a);
    }
    .rfsf-tool-hdr:hover { background: var(--g-surface, rgba(255,255,255,0.04)); }
    .rfsf-tool-name  { color: var(--g-primary, #d4af37); font-weight: 600; }
    .rfsf-tool-chev  { display: flex; align-items: center; margin-left: auto; transition: transform 0.15s; }
    .rfsf-tool-args  {
      margin: 0; padding: 6px 8px; font-family: inherit; font-size: 11px;
      color: var(--g-fg-dim, #71717a); white-space: pre-wrap; word-break: break-all;
      max-height: 300px; overflow-y: auto;
      border-top: 1px solid var(--g-border, rgba(255,255,255,0.06));
    }
    .rfsf-tool-preview {
      display: block; padding: 3px 8px; font-size: 10px;
      color: var(--g-fg-faint, #52525b); font-family: inherit;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* ── Feed-level error ────────────────────────────── */
    .rfsf-feed-err {
      display: flex; align-items: center; gap: 8px;
      padding: 12px; color: #ef4444; font-size: 12px;
    }

    /* ── Empty / skeleton ────────────────────────────── */
    .rfsf-empty { padding: 16px; text-align: center; color: var(--g-fg-faint, #52525b); }
    .rfsf-skel {
      height: 34px; margin: 4px 8px;
      background: linear-gradient(90deg,
        var(--g-surface, rgba(255,255,255,0.04)) 25%,
        var(--g-surface-hover, rgba(255,255,255,0.07)) 50%,
        var(--g-surface, rgba(255,255,255,0.04)) 75%);
      background-size: 400% 100%;
      animation: rfsf-shimmer 1.5s infinite linear;
    }

    /* ── Show more ───────────────────────────────────── */
    .rfsf-more-btn {
      display: block; width: 100%; padding: 8px;
      background: transparent; border: none;
      border-top: 1px solid var(--g-border, rgba(255,255,255,0.08));
      color: var(--g-fg-dim, #71717a); cursor: pointer;
      font-family: inherit; font-size: 11px; letter-spacing: 0.05em;
      transition: color 0.12s;
    }
    .rfsf-more-btn:hover { color: var(--g-primary, #d4af37); }

    /* ── Animations ──────────────────────────────────── */
    @keyframes rfsf-pulse  { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes rfsf-expand { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes rfsf-shimmer {
      0%   { background-position: -400% 0; }
      100% { background-position:  400% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .rfsf-expanded       { animation: none; }
      .rfsf-skel           { animation: none; }
      .rfsf-row-chevron,
      .rfsf-header-chevron { transition: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "recently-finished-sessions-feed": RecentlyFinishedSessionsFeed;
  }
}
