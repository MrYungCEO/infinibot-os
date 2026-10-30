/**
 * <chat-session-switcher> — the chat sidebar's session bar + session list.
 *
 * Bar: current session title (opens the list), New chat, Open in full Chat.
 * List: every chat session for the selected agent, or for all agents, from the
 * same gateway store the full-page Chat uses (../chat/chat-sessions.ts). It is
 * searchable (server-side), paged (infinite scroll + "Load more"), and each row
 * shows title, last-message preview, time and agent, with rename, delete
 * (the gateway archives the transcript) and open-in-Chat actions.
 *
 * It keeps its first page fresh from `sessions.changed` / `chat` gateway events
 * and the same-page CHAT_SESSIONS_CHANGED_EVENT, so chats started or renamed in
 * webchat show up here live.
 *
 * Owns no chat state: selection is reported with events the host acts on —
 *   chat-session-select {key}, chat-session-new, chat-session-open-full {key},
 *   chat-session-deleted {key}.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { GatewayAgentRow, GatewaySessionRow } from "../types";
import { sanitizeIdentityEmoji } from "../../../../src/shared/identity-emoji.js";
import { renderBrandAvatar } from "../chat/brand-avatar";
import {
  CHAT_SESSIONS_CHANGED_EVENT,
  GATEWAY_SESSIONS_CHANGED_EVENT,
  SESSIONS_PAGE_SIZE,
  agentIdFromKey,
  deleteChatSession,
  fetchChatSessionsPage,
  isSessionListEvent,
  mergeSessionRows,
  relTime,
  renameChatSession,
  sessionPreview,
  sessionTitle,
} from "../chat/chat-sessions";
import { agentDisplayName } from "./agent-chat-state";

export type SessionScope = "agent" | "all";

const SEARCH_DEBOUNCE_MS = 250;
const REFRESH_DEBOUNCE_MS = 500;

@customElement("chat-session-switcher")
export class ChatSessionSwitcher extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  /** Agent the sidebar is on (the "This agent" scope). */
  @property({ attribute: false }) agentId = "";
  /** Selected session (may be a not-yet-sent new chat). */
  @property({ attribute: false }) currentKey = "";
  /** Title to show when the current session isn't in the list yet. */
  @property({ attribute: false }) fallbackTitle = "New chat";

  @state() private open = false;
  @state() private scope: SessionScope = "agent";
  @state() private query = "";
  @state() private rows: GatewaySessionRow[] = [];
  @state() private loading = false;
  @state() private loadingMore = false;
  @state() private error: string | null = null;
  @state() private hasMore = false;
  @state() private loaded = false;
  @state() private activeIndex = -1;
  @state() private renamingKey: string | null = null;
  @state() private renameValue = "";
  @state() private busyKey: string | null = null;

  /** Latest known row per key (survives scope/search changes) — for the bar title. */
  private known = new Map<string, GatewaySessionRow>();
  private seq = 0;
  /** Keys already looked up for the bar title (don't re-ask for a not-yet-stored new chat). */
  private lookedUp = new Set<string>();
  private unsub: (() => void) | null = null;
  private subscribed: GatewayBrowserClient | null = null;
  private searchTimer: number | null = null;
  private refreshTimer: number | null = null;

  get isOpen(): boolean {
    return this.open;
  }

  /** Close the list; returns whether it was open (for the host's Esc handling). */
  closeList(refocus = false): boolean {
    if (!this.open) return false;
    if (this.renamingKey) {
      this.renamingKey = null;
      return true;
    }
    this.open = false;
    if (refocus) this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".sb-trigger")?.focus());
    return true;
  }

  private onWindowChanged = (e: Event) => {
    const d = (e as CustomEvent<{ key?: string; reason?: string }>).detail;
    this.onChanged(d?.key, d?.reason);
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onWindowChanged);
    this.subscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onWindowChanged);
    this.unsub?.();
    this.unsub = null;
    this.subscribed = null;
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client")) {
      this.subscribe();
      if (this.client) void this.reload();
    }
    if (changed.has("agentId") && changed.get("agentId") !== undefined && this.scope === "agent") void this.reload();
    if (changed.has("currentKey") || changed.has("client")) void this.lookupCurrent();
  }

  /** The bar needs the current chat's row even when it isn't on a loaded page. */
  private async lookupCurrent(): Promise<void> {
    const key = this.currentKey;
    if (!this.client || !key || this.known.has(key) || this.lookedUp.has(key)) return;
    this.lookedUp.add(key);
    try {
      const page = await fetchChatSessionsPage(this.client, {
        agentId: agentIdFromKey(key),
        search: key.replace(/^agent:[^:]+:/, ""),
        limit: 5,
        includeLastMessage: false,
      });
      const row = page.sessions.find((r) => r.key === key);
      if (row && !this.known.has(key)) {
        this.known.set(key, row);
        this.requestUpdate();
      }
    } catch {
      this.lookedUp.delete(key);
    }
  }

  private subscribe(): void {
    if (this.client === this.subscribed) return;
    this.unsub?.();
    this.unsub = null;
    this.subscribed = this.client;
    if (this.client && typeof this.client.subscribe === "function") {
      this.unsub = this.client.subscribe((evt) => this.onGatewayEvent(evt));
    }
  }

  private onGatewayEvent(evt: GatewayEventFrame): void {
    if (!isSessionListEvent(evt, (k) => this.known.has(k))) return;
    const p = evt.payload as { key?: string; reason?: string } | undefined;
    this.onChanged(evt.event === GATEWAY_SESSIONS_CHANGED_EVENT ? p?.key : undefined, p?.reason);
  }

  private onChanged(key?: string, reason?: string): void {
    if (reason === "delete" && key) {
      this.known.delete(key);
      this.rows = this.rows.filter((r) => r.key !== key);
    }
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.reload({ keepCount: true });
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Add/refresh a row the host knows about before the store does (a just-sent new chat). */
  upsertOptimistic(row: GatewaySessionRow): void {
    if (this.known.has(row.key) && this.rows.some((r) => r.key === row.key)) return;
    this.known.set(row.key, row);
    const inScope = this.scope === "all" || agentIdFromKey(row.key) === this.agentId;
    if (inScope && !this.query) this.rows = mergeSessionRows(this.rows, [row]);
    this.requestUpdate();
  }

  /** Re-read the first page (or as many rows as are loaded, to keep scroll position). */
  async reload(opts: { keepCount?: boolean } = {}): Promise<void> {
    if (!this.client) return;
    const seq = ++this.seq;
    const limit = opts.keepCount ? Math.max(SESSIONS_PAGE_SIZE, this.rows.length) : SESSIONS_PAGE_SIZE;
    this.loading = !opts.keepCount || !this.loaded;
    this.error = null;
    try {
      const page = await fetchChatSessionsPage(this.client, {
        agentId: this.scope === "agent" ? this.agentId : null,
        search: this.query,
        offset: 0,
        limit,
      });
      if (seq !== this.seq) return;
      for (const r of page.sessions) this.known.set(r.key, r);
      this.rows = page.sessions;
      this.hasMore = page.hasMore;
      this.loaded = true;
      if (this.activeIndex >= this.rows.length) this.activeIndex = this.rows.length - 1;
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      if (seq === this.seq) this.loading = false;
    }
  }

  private async loadMore(): Promise<void> {
    if (!this.client || this.loading || this.loadingMore || !this.hasMore) return;
    const seq = this.seq;
    this.loadingMore = true;
    try {
      const page = await fetchChatSessionsPage(this.client, {
        agentId: this.scope === "agent" ? this.agentId : null,
        search: this.query,
        offset: this.rows.length,
        limit: SESSIONS_PAGE_SIZE,
      });
      if (seq !== this.seq) return;
      for (const r of page.sessions) this.known.set(r.key, r);
      this.rows = mergeSessionRows(this.rows, page.sessions);
      this.hasMore = page.hasMore && page.sessions.length > 0;
    } catch (err) {
      if (seq === this.seq) this.error = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.loadingMore = false;
    }
  }

  private toggle(): void {
    if (this.open) {
      this.closeList(true);
      return;
    }
    this.open = true;
    this.activeIndex = -1;
    void this.reload({ keepCount: this.loaded });
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>(".sl-search")?.focus());
  }

  private setScope(scope: SessionScope): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.activeIndex = -1;
    this.rows = [];
    this.loaded = false;
    void this.reload();
  }

  private onSearch(e: Event): void {
    this.query = (e.target as HTMLInputElement).value;
    this.activeIndex = -1;
    if (this.searchTimer) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = null;
      void this.reload();
    }, SEARCH_DEBOUNCE_MS);
  }

  private onListScroll(e: Event): void {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) void this.loadMore();
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private select(row: GatewaySessionRow): void {
    this.open = false;
    this.emit("chat-session-select", { key: row.key });
  }

  private newChat(): void {
    this.open = false;
    this.emit("chat-session-new");
  }

  private openFull(key: string | null): void {
    this.open = false;
    this.emit("chat-session-open-full", { key });
  }

  private startRename(row: GatewaySessionRow): void {
    this.renamingKey = row.key;
    this.renameValue = sessionTitle(row);
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLInputElement>(".sl-rename");
      el?.focus();
      el?.select();
    });
  }

  private async commitRename(): Promise<void> {
    const key = this.renamingKey;
    if (!key || !this.client) return;
    this.renamingKey = null;
    const row = this.rows.find((r) => r.key === key);
    const label = this.renameValue.trim();
    if (!row || label === sessionTitle(row)) return;
    const prev = this.rows;
    const next = { ...row, label: label || undefined };
    this.rows = this.rows.map((r) => (r.key === key ? next : r));
    this.known.set(key, next);
    this.busyKey = key;
    try {
      await renameChatSession(this.client, key, label || null);
    } catch (err) {
      this.rows = prev;
      this.known.set(key, row);
      this.error = `Rename failed: ${String((err as Error)?.message ?? err).replace(/^Error:\s*/, "")}`;
    } finally {
      this.busyKey = null;
    }
  }

  private async removeSession(row: GatewaySessionRow): Promise<void> {
    if (!this.client) return;
    if (!window.confirm(`Delete "${sessionTitle(row)}"?\n\nThe transcript is archived by the gateway.`)) return;
    this.busyKey = row.key;
    try {
      await deleteChatSession(this.client, row.key);
      this.rows = this.rows.filter((r) => r.key !== row.key);
      this.known.delete(row.key);
      this.emit("chat-session-deleted", { key: row.key });
    } catch (err) {
      this.error = `Delete failed: ${String((err as Error)?.message ?? err).replace(/^Error:\s*/, "")}`;
    } finally {
      this.busyKey = null;
    }
  }

  private onListKey(e: KeyboardEvent): void {
    if (this.renamingKey) return;
    const n = this.rows.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.activeIndex = this.activeIndex < 0 ? (step > 0 ? 0 : n - 1) : (this.activeIndex + step + n) % n;
      if (this.activeIndex >= n - 3) void this.loadMore();
      this.updateComplete.then(() =>
        this.renderRoot.querySelector(".sl-row.active")?.scrollIntoView({ block: "nearest" }),
      );
    } else if (e.key === "Enter" && (e.target as HTMLElement).classList.contains("sl-search")) {
      const row = this.rows[this.activeIndex] ?? (this.activeIndex < 0 && n ? this.rows[0] : undefined);
      if (row) {
        e.preventDefault();
        this.select(row);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.closeList(true);
    }
  }

  // ── render ──────────────────────────────────────────────────────────

  private get currentTitle(): string {
    const row = this.known.get(this.currentKey);
    return row ? sessionTitle(row) : this.fallbackTitle || "New chat";
  }

  private agentGlyph(id: string) {
    const agent = this.agents.find((a) => a.id === id);
    const emoji = sanitizeIdentityEmoji(agent?.identity?.emoji);
    return emoji
      ? html`<span class="sl-glyph" aria-hidden="true">${emoji}</span>`
      : html`<span class="sl-glyph sl-glyph-logo" aria-hidden="true">${renderBrandAvatar("logo-badge", "")}</span>`;
  }

  render() {
    const persisted = this.known.has(this.currentKey);
    return html`
      <div class="sb">
        <button
          class="sb-trigger"
          data-learn-id="quick-chat-sessions"
          data-ib-target="control:chat/sessions"
          aria-haspopup="listbox"
          aria-expanded=${this.open ? "true" : "false"}
          title="Chats — switch, search, rename"
          @click=${() => this.toggle()}
        >
          <svg class="sb-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span class="sb-title">${this.currentTitle}</span>
          <svg class="sb-chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
        <button class="sb-btn" data-learn-id="quick-chat-new" data-ib-target="control:chat/new-session"
          title="New chat" aria-label="New chat" @click=${() => this.newChat()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
            stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button class="sb-btn" data-learn-id="quick-chat-open-full" data-ib-target="control:chat/open-full"
          title="Open in full Chat" aria-label="Open this chat in the full Chat page"
          @click=${() => this.openFull(persisted ? this.currentKey : null)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
          </svg>
        </button>
      </div>
      ${this.open ? this.renderList() : nothing}
    `;
  }

  private renderList() {
    return html`
      <div class="sl" role="dialog" aria-label="Chats" @keydown=${(e: KeyboardEvent) => this.onListKey(e)}>
        <div class="sl-top">
          <input
            class="sl-search"
            type="search"
            placeholder="Search chats…"
            aria-label="Search chats"
            aria-controls="sl-list"
            .value=${this.query}
            @input=${(e: Event) => this.onSearch(e)}
          />
          <div class="sl-scope" role="tablist" aria-label="Which chats">
            <button role="tab" aria-selected=${this.scope === "agent" ? "true" : "false"}
              class=${this.scope === "agent" ? "on" : ""} @click=${() => this.setScope("agent")}
              title="Chats with ${agentDisplayName(this.agents.find((a) => a.id === this.agentId), this.agentId)}">
              This agent
            </button>
            <button role="tab" aria-selected=${this.scope === "all" ? "true" : "false"}
              class=${this.scope === "all" ? "on" : ""} @click=${() => this.setScope("all")}>All agents</button>
          </div>
        </div>
        <ul class="sl-list" id="sl-list" role="listbox" aria-label="Chats" aria-busy=${this.loading ? "true" : "false"}
          @scroll=${(e: Event) => this.onListScroll(e)}>
          <li class="sl-new-row">
            <button class="sl-new" @click=${() => this.newChat()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"
                stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              New chat
            </button>
          </li>
          ${this.renderRows()}
        </ul>
      </div>
    `;
  }

  private renderRows() {
    if (this.error && !this.rows.length) {
      return html`<li class="sl-state err" role="alert">
        Couldn't load chats — ${this.error}
        <button class="sl-retry" @click=${() => this.reload()}>Retry</button>
      </li>`;
    }
    if (this.loading && !this.rows.length) {
      return html`${[0, 1, 2, 3].map(() => html`<li class="sl-skel" aria-hidden="true"><span></span><span></span></li>`)}
        <li class="sl-state">Loading chats…</li>`;
    }
    if (!this.rows.length) {
      return html`<li class="sl-state">
        ${this.query
          ? html`No chats match “${this.query}”.`
          : this.scope === "agent"
            ? "No chats with this agent yet — start one below."
            : "No chats yet."}
      </li>`;
    }
    return html`
      ${this.rows.map((r, i) => this.renderRow(r, i))}
      ${this.error ? html`<li class="sl-state err" role="alert">${this.error}</li>` : nothing}
      ${this.hasMore
        ? html`<li class="sl-more-row">
            <button class="sl-more" ?disabled=${this.loadingMore} @click=${() => this.loadMore()}>
              ${this.loadingMore ? "Loading…" : "Load more"}
            </button>
          </li>`
        : this.rows.length > SESSIONS_PAGE_SIZE
          ? html`<li class="sl-state end">That's every chat.</li>`
          : nothing}
    `;
  }

  private renderRow(row: GatewaySessionRow, i: number) {
    const agentId = agentIdFromKey(row.key) ?? "";
    const agentName = agentDisplayName(this.agents.find((a) => a.id === agentId), agentId);
    const preview = sessionPreview(row);
    const current = row.key === this.currentKey;
    const renaming = this.renamingKey === row.key;
    return html`<li
      class="sl-row ${current ? "current" : ""} ${i === this.activeIndex ? "active" : ""}"
      role="option"
      aria-selected=${current ? "true" : "false"}
      data-key=${row.key}
      @mouseenter=${() => (this.activeIndex = i)}
    >
      ${renaming
        ? html`<input
            class="sl-rename"
            aria-label="Rename chat"
            .value=${this.renameValue}
            @input=${(e: Event) => (this.renameValue = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void this.commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.renamingKey = null;
              }
            }}
            @blur=${() => void this.commitRename()}
          />`
        : html`<button class="sl-main" @click=${() => this.select(row)} title=${sessionTitle(row)}>
            <span class="sl-line">
              <span class="sl-title">${sessionTitle(row)}</span>
              <span class="sl-time">${relTime(row.updatedAt)}</span>
            </span>
            ${preview ? html`<span class="sl-preview">${preview}</span>` : nothing}
            <span class="sl-agent">${this.agentGlyph(agentId)}<span>${agentName}</span></span>
          </button>`}
      <span class="sl-actions">
        <button class="sl-act" title="Rename" aria-label="Rename ${sessionTitle(row)}" ?disabled=${this.busyKey === row.key}
          @click=${() => this.startRename(row)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        </button>
        <button class="sl-act" title="Open in full Chat" aria-label="Open ${sessionTitle(row)} in full Chat"
          @click=${() => this.openFull(row.key)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>
        </button>
        <button class="sl-act danger" title="Delete (archives the transcript)" aria-label="Delete ${sessionTitle(row)}"
          ?disabled=${this.busyKey === row.key} @click=${() => this.removeSession(row)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></svg>
        </button>
      </span>
    </li>`;
  }

  static styles = css`
    :host {
      position: relative;
      z-index: 4;
      display: block;
      padding: 0 12px 8px 16px;
      font-family: var(--g-font, "Inter", system-ui, sans-serif);
      color: var(--g-fg, #f5f5f4);
      --sl-gold: var(--g-primary, #fbbf24);
      --sl-muted: color-mix(in srgb, var(--g-fg, #f5f5f4) 52%, transparent);
    }
    button {
      font: inherit;
      color: inherit;
      border: none;
      background: none;
      cursor: pointer;
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--sl-gold) 70%, transparent);
      outline-offset: 2px;
    }
    .sb {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .sb-trigger {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 32px;
      padding: 0 10px;
      border-radius: 10px;
      font-size: 12.5px;
      text-align: left;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 4%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--sl-gold) 14%, transparent);
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .sb-trigger:hover,
    .sb-trigger[aria-expanded="true"] {
      background: color-mix(in srgb, var(--sl-gold) 10%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--sl-gold) 34%, transparent);
    }
    .sb-ico {
      flex-shrink: 0;
      color: var(--sl-gold);
    }
    .sb-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .sb-chev {
      flex-shrink: 0;
      color: var(--sl-gold);
      transition: transform 0.15s ease;
    }
    .sb-trigger[aria-expanded="true"] .sb-chev {
      transform: rotate(180deg);
    }
    .sb-btn {
      flex-shrink: 0;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 10px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 70%, transparent);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, transparent);
      transition: background 0.15s, color 0.15s;
    }
    .sb-btn:hover {
      color: var(--sl-gold);
      background: color-mix(in srgb, var(--sl-gold) 14%, transparent);
    }

    /* ── List popover: fills the dock below the bar ─────────────────────── */
    .sl {
      box-sizing: border-box;
      position: absolute;
      top: calc(100% - 2px);
      left: 10px;
      right: 10px;
      display: flex;
      flex-direction: column;
      height: var(--sl-height, min(560px, calc(100dvh - var(--shell-topbar-height, 60px) - 190px)));
      min-height: 220px;
      padding: 8px;
      border-radius: 14px;
      /* Opaque — the chat log must not ghost through the list. */
      background: rgb(12, 11, 16);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--sl-gold) 24%, transparent),
        0 0 30px -10px color-mix(in srgb, var(--sl-gold) 40%, transparent),
        0 24px 60px -16px rgba(0, 0, 0, 0.85);
      animation: sl-in 0.16s ease both;
    }
    @keyframes sl-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
    }
    .sl-top {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 6px;
    }
    .sl-search {
      box-sizing: border-box;
      width: 100%;
      padding: 8px 11px;
      font: inherit;
      font-size: 13px;
      color: var(--g-fg, #f5f5f4);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, rgba(10, 10, 14, 0.4));
      border: none;
      border-radius: 9px;
      outline: none;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-fg, #f5f5f4) 10%, transparent);
    }
    .sl-search:focus {
      box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--sl-gold) 55%, transparent);
    }
    .sl-scope {
      display: flex;
      gap: 2px;
      padding: 2px;
      border-radius: 9px;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, transparent);
    }
    .sl-scope button {
      flex: 1;
      padding: 5px 8px;
      border-radius: 7px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--sl-muted);
    }
    .sl-scope button.on {
      color: #0c0b10;
      background: var(--sl-gold);
    }
    .sl-list {
      flex: 1;
      min-height: 0;
      list-style: none;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--sl-gold) 28%, transparent) transparent;
    }
    .sl-new-row,
    .sl-more-row {
      padding: 2px 0 4px;
    }
    .sl-new,
    .sl-more,
    .sl-retry {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 7px 10px;
      border-radius: 9px;
      font-size: 12px;
      font-weight: 600;
      color: var(--sl-gold);
      background: color-mix(in srgb, var(--sl-gold) 8%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sl-gold) 22%, transparent);
    }
    .sl-new:hover,
    .sl-more:hover:not([disabled]),
    .sl-retry:hover {
      background: color-mix(in srgb, var(--sl-gold) 16%, transparent);
    }
    .sl-more[disabled] {
      opacity: 0.6;
      cursor: progress;
    }
    .sl-retry {
      width: auto;
      margin-top: 8px;
      display: inline-flex;
    }
    .sl-row {
      position: relative;
      display: flex;
      align-items: stretch;
      gap: 2px;
      border-radius: 10px;
    }
    .sl-row.active,
    .sl-row:focus-within {
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 6%, transparent);
    }
    .sl-row.current {
      background: color-mix(in srgb, var(--sl-gold) 11%, transparent);
      box-shadow: inset 2px 0 0 var(--sl-gold);
    }
    .sl-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 7px 4px 7px 10px;
      text-align: left;
      border-radius: 10px;
    }
    .sl-line {
      display: flex;
      align-items: baseline;
      gap: 8px;
      min-width: 0;
    }
    .sl-title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
    }
    .sl-row.current .sl-title {
      color: var(--sl-gold);
    }
    .sl-time {
      flex-shrink: 0;
      font-size: 10.5px;
      color: var(--sl-muted);
      font-variant-numeric: tabular-nums;
    }
    .sl-preview {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11.5px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 62%, transparent);
    }
    .sl-agent {
      display: flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      font-size: 10.5px;
      color: var(--sl-muted);
    }
    .sl-agent > span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sl-glyph {
      display: grid;
      place-items: center;
      width: 15px;
      height: 15px;
      flex-shrink: 0;
      border-radius: 4px;
      font-size: 10px;
      overflow: hidden;
      background: color-mix(in srgb, var(--sl-gold) 10%, rgba(10, 10, 14, 0.6));
    }
    .sl-glyph-logo {
      padding: 1px;
    }
    .logo-badge {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .sl-actions {
      display: flex;
      align-items: center;
      gap: 1px;
      padding-right: 4px;
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .sl-row:hover .sl-actions,
    .sl-row:focus-within .sl-actions,
    .sl-row.current .sl-actions {
      opacity: 1;
    }
    .sl-act {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 7px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 70%, transparent);
    }
    .sl-act:hover:not([disabled]) {
      color: var(--sl-gold);
      background: color-mix(in srgb, var(--sl-gold) 14%, transparent);
    }
    .sl-act.danger:hover:not([disabled]) {
      color: #f87171;
      background: rgba(248, 113, 113, 0.14);
    }
    .sl-act[disabled] {
      opacity: 0.4;
      cursor: progress;
    }
    .sl-rename {
      flex: 1;
      min-width: 0;
      margin: 5px 4px 5px 6px;
      padding: 7px 9px;
      font: inherit;
      font-size: 13px;
      color: var(--g-fg, #f5f5f4);
      background: rgba(10, 10, 14, 0.7);
      border: none;
      border-radius: 8px;
      outline: none;
      box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--sl-gold) 55%, transparent);
    }
    .sl-state {
      padding: 14px 10px;
      font-size: 12px;
      line-height: 1.45;
      color: var(--sl-muted);
      text-align: center;
    }
    .sl-state.err {
      color: #fca5a5;
    }
    .sl-state.end {
      padding: 10px;
      font-size: 11px;
    }
    .sl-skel {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px;
    }
    .sl-skel span {
      height: 10px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 8%, transparent);
      animation: sl-pulse 1.2s ease-in-out infinite;
    }
    .sl-skel span:last-child {
      width: 60%;
    }
    @keyframes sl-pulse {
      50% {
        opacity: 0.45;
      }
    }
    @media (max-width: 600px) {
      :host {
        padding: 0 12px 8px;
      }
      .sl {
        left: 6px;
        right: 6px;
      }
      .sl-actions {
        opacity: 1;
      }
      .sl-act {
        width: 32px;
        height: 32px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .sl,
      .sl-skel span {
        animation: none !important;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-session-switcher": ChatSessionSwitcher;
  }
}
