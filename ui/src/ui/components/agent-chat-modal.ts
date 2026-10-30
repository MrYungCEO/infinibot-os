/**
 * <agent-chat-modal> — universal agent chat, docked as a right-hand sidebar.
 *
 * A black/gold glassmorphism panel that talks to ANY gateway agent. It is
 * NON-blocking: no scrim, the page underneath stays usable. The dock is
 * drag-resizable from its left edge (width remembered in localStorage),
 * collapsible to a rail, closes on Esc, and is a full-width sheet ≤600px
 * (see ./chat-sidebar-dock.ts). With the Robovoice plugin linked it also reads
 * replies aloud and has a talk button (./chat-speech.ts), billed per request.
 *
 * The header carries a searchable, keyboard-navigable agent switcher fed by
 * agents.list (the same source as the webchat agent picker). Below it, the
 * session bar (<chat-session-switcher>) lists every chat for that agent — or
 * all agents — from the same gateway session store as the full-page Chat, so
 * chats started here show there and vice versa. Picking one loads its latest
 * history page; scrolling up pages older messages in (chat.history
 * `beforeIndex`). The last chat per agent is remembered in localStorage.
 * Threads are kept per session key, so switching away and back restores the
 * conversation. Streams via chat.send + gateway `chat`/`agent` events and
 * surfaces live tool activity.
 *
 * The locked/integrated embeds (<cmo-chat>) keep one `agent:<id>:<suffix>`
 * session and no session bar.
 *
 * Mounted once in app-render (opened from the topbar Chat button). The tag
 * name is kept for compatibility (learn tours, ui targets, <cmo-chat>). Open it via
 * Cmd/Ctrl+Shift+M, window.agentChat.open({ agentId }), or an
 * "infinibot:agent-chat" CustomEvent with optional detail.agentId. Legacy
 * entry points (window.cmoChat, "infinibot:cmo-chat") open it on the CMO.
 *
 * @prop agentId — initial agent (default: last used → main).
 * @prop lockedAgent — hide the switcher and stay on `agentId`.
 * @prop integrated — render inline (no dock / global hotkeys).
 * @prop sessionSuffix — session key suffix (default "quick-chat").
 *
 * <cmo-chat> (./cmo-chat.ts) is a thin CMO-locked wrapper around this.
 */

import {
  formatChatErrorText,
  formatModelFallbackNotice,
  parseModelFallbackNotice,
} from "../chat-error-format";
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { AgentsListResult, GatewayAgentRow, SessionsListResult } from "../types";
import { announceSessionModel, onSessionModel } from "../session-model-sync";
import "./webchat-model-picker";
import {
  CHAT_SESSIONS_CHANGED_EVENT,
  GATEWAY_SESSIONS_CHANGED_EVENT,
  HISTORY_PAGE_SIZE,
  agentIdFromKey,
  cleanUserText,
  fetchChatSessionsPage,
  fetchHistoryPage,
  isChatSessionKey,
  loadRememberedSession,
  newChatSessionKey,
  notifyChatSessionsChanged,
  rememberSession,
  webchatPathForKey,
} from "../chat/chat-sessions";
import { inferBasePathFromPathname } from "../navigation";
import "./chat-session-switcher";
import type { ChatSessionSwitcher } from "./chat-session-switcher";
import { toSanitizedMarkdownHtml } from "../markdown/render";
import { extractText } from "../chat/message-extract";
import { renderBrandAvatar } from "../chat/brand-avatar";
import { isChatPanelModalOpen, renderChatPanelRef } from "../chat-panels";
import { sanitizeIdentityEmoji } from "../../../../src/shared/identity-emoji.js";
import {
  CHAT_DOCK_MIN_WIDTH,
  CHAT_DOCK_RAIL_WIDTH,
  CHAT_DOCK_SHEET_BREAKPOINT,
  clampDockWidth,
  loadDockState,
  saveDockState,
  widthFromPointer,
} from "./chat-sidebar-dock";
import { ChatSpeechController, chatSpeechStyles } from "./chat-speech";
import "./chat-call-button";
import {
  AGENT_CHAT_EVENT,
  CMO_AGENT_ID,
  CMO_CHAT_EVENT,
  OLDER_CHUNK,
  QUICK_CHAT_SUFFIX,
  ThreadStore,
  agentDisplayName,
  agentIdFromSessionKey,
  filterAgents,
  historyToItems,
  loadLastAgent,
  normalizeAgentId,
  resolveChatEvent,
  resolveInitialAgent,
  saveLastAgent,
  sessionKeyFor,
  splitHistoryWindow,
  suggestionsFor,
  takeOlderChunk,
  threadHasOlder,
  type ChatItem,
  type ChatOpenRequest,
  finishToolItem,
  hasRunningTool,
  insertPanelsAfterTool,
  insertPanelsBeforeReply,
  panelItemsFromToolResult,
  panelsForLastTurn,
  settleRunningTools,
  startToolItem,
} from "./agent-chat-state";
import { describeToolActivity, formatElapsed, toolProgress } from "../chat/tool-activity";
import "../secure-mode/secure-toggle";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { isGroupChatKey } from "../../../../src/shared/group-chat/keys.js";
import { SecureSurfaceLane, renderSecureSurfaceBadge, secureSurfaceStyles } from "../secure-mode/chat-surface";

const AGENTS_TTL_MS = 60_000;

type AgentChatApi = {
  open: (opts?: { agentId?: string; sessionKey?: string }) => void;
  close: () => void;
  toggle: (opts?: { agentId?: string }) => void;
};

declare global {
  interface Window {
    agentChat?: AgentChatApi;
    cmoChat?: { open: () => void; close: () => void; toggle: () => void };
  }
}

type PanelSessionModel = { model: string | null; overridden: boolean; thinkingLevel: string | null };

@customElement("agent-chat-modal")
export class AgentChatModal extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** When true, renders inline (no dock). */
  @property({ type: Boolean, reflect: true }) integrated = false;
  /** Agent to open on. Empty = last used → main. */
  @property({ attribute: "agent-id" }) agentId = "";
  /** Pin the chat to `agentId` (no switcher). */
  @property({ type: Boolean, attribute: "locked-agent" }) lockedAgent = false;
  @property({ attribute: "session-suffix" }) sessionSuffix = QUICK_CHAT_SUFFIX;

  @state() private open = false;
  @state() private currentAgent = "";
  /** Selected chat session (session-bar mode); "" until resolved for the agent. */
  @state() private currentKey = "";
  @state() private draft = "";
  @state() private agents: GatewayAgentRow[] = [];
  @state() private switcherOpen = false;
  @state() private switcherQuery = "";
  @state() private switcherIndex = 0;
  /** Bumped on every thread mutation so Lit re-renders. */
  @state() private rev = 0;
  /** Dock width (px) and collapsed-to-rail state, persisted. */
  // Loaded unclamped by the current window (a phone visit must not shrink the
  // desktop width); clamped to the viewport when applied.
  @state() private dockWidth = loadDockState(globalThis.localStorage, Number.POSITIVE_INFINITY).width;
  @state() private dockCollapsed = loadDockState(globalThis.localStorage, Number.POSITIVE_INFINITY).collapsed;
  @state() private resizing = false;
  /** Per-session model/thinking overrides for this panel's sessions, by session key. */
  @state() private sessionModels = new Map<string, PanelSessionModel>();
  /** Gateway-wide default model ref — fallback when agents.list lacks `model`. */
  @state() private globalModel: string | null = null;
  @state() private isPhone = false;
  /**
   * Secure lane key for the locked / integrated embeds (one fixed
   * `agent:<id>:<suffix>` session otherwise). The app-wide dock switches
   * `currentKey` instead.
   */
  @state() private laneKey = "";

  /** Composer Secure Mode toggle (shared store; per-surface session memory). */
  private readonly secureLane = new SecureSurfaceLane(this);

  /** Robovoice read-aloud + talk (hidden unless the plugin is on and linked). */
  private readonly speech = new ChatSpeechController(this);
  /** Stable keys for message-level speech controls. */
  private itemKeys = new WeakMap<ChatItem, string>();
  private itemSeq = 0;

  private threads = new ThreadStore();
  private agentsLoadedAt = 0;
  private defaultAgentId: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private unsub: (() => void) | null = null;
  private unsubModelSync: (() => void) | null = null;
  private phoneMq: MediaQueryList | null = null;
  private onPhoneMq = (): void => {
    this.isPhone = Boolean(this.phoneMq?.matches);
  };

  /** Only the app-wide overlay instance owns hotkeys + window APIs. */
  private get ownsGlobals(): boolean {
    return !this.integrated && !this.lockedAgent;
  }

  private get agent(): string {
    return this.currentAgent || resolveInitialAgent({ requested: this.agentId });
  }

  /** The app-wide dock gets the session bar; locked/integrated embeds keep one session. */
  private get sessionsEnabled(): boolean {
    return !this.lockedAgent && !this.integrated;
  }

  private get sessionKey(): string {
    if (this.sessionsEnabled && this.currentKey && agentIdFromKey(this.currentKey) === this.agent) {
      return this.currentKey;
    }
    if (!this.sessionsEnabled && this.laneKey && agentIdFromKey(this.laneKey) === this.agent) return this.laneKey;
    return sessionKeyFor(this.agent, this.sessionSuffix);
  }

  private get thread() {
    void this.rev;
    return this.threads.get(this.sessionKey);
  }

  private get isCmo(): boolean {
    return this.agent === CMO_AGENT_ID;
  }

  private agentRow(id = this.agent): GatewayAgentRow | undefined {
    return this.agents.find((a) => a.id === id);
  }

  private onKey = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      this.apply({ action: "toggle" });
      return;
    }
    if (!this.open || e.key !== "Escape" || e.defaultPrevented) return;
    // An expanded chat panel sits above us and owns Escape until closed.
    if (isChatPanelModalOpen()) return;
    // Non-blocking dock: Esc closes it when focus is in the dock or nowhere in
    // particular — never out from under something else the user is typing in.
    const inside = e.composedPath().includes(this);
    const active = document.activeElement;
    if (!inside && active && active !== document.body) return;
    e.preventDefault();
    if (this.sessionSwitcher?.closeList(true)) return;
    if (this.switcherOpen) this.closeSwitcher(true);
    else if (this.speech.talk === "recording") this.speech.cancelRecording();
    else this.close();
  };

  private readonly agentChatApi: AgentChatApi = {
    open: (o) => {
      const req = resolveChatEvent(AGENT_CHAT_EVENT, { action: "open", agentId: o?.agentId, sessionKey: o?.sessionKey });
      if (req) this.apply(req);
    },
    close: () => this.close(),
    toggle: (o) => this.apply({ action: "toggle", agentId: o?.agentId }),
  };

  private readonly cmoChatApi = {
    open: () => this.apply({ action: "open", agentId: CMO_AGENT_ID }),
    close: () => this.close(),
    toggle: () => this.apply({ action: "toggle", agentId: CMO_AGENT_ID }),
  };

  private onChatEvent = (e: Event): void => {
    const req = resolveChatEvent(e.type, (e as CustomEvent).detail);
    if (req) this.apply(req);
  };

  connectedCallback(): void {
    super.connectedCallback();
    if (this.ownsGlobals) {
      window.addEventListener("keydown", this.onKey);
      window.addEventListener(AGENT_CHAT_EVENT, this.onChatEvent);
      window.addEventListener(CMO_CHAT_EVENT, this.onChatEvent);
      window.agentChat = this.agentChatApi;
      window.cmoChat = this.cmoChatApi;
    }
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onSessionsChanged);
    this.subscribe();
    // Another surface changed this session's model — mirror it here.
    this.unsubModelSync = onSessionModel(
      (c) => {
        if (!this.ownsSessionKey(c.sessionKey)) return;
        this.setSessionModel(c.sessionKey, { model: c.model, overridden: Boolean(c.model) });
      },
      { ignoreSource: this },
    );
    this.phoneMq = window.matchMedia("(max-width: 600px)");
    this.phoneMq.addEventListener("change", this.onPhoneMq);
    this.onPhoneMq();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.ownsGlobals) {
      document.documentElement.style.removeProperty("--ib-chat-dock-reserve");
      document.documentElement.toggleAttribute("data-chat-dock-open", false);
    }
    this.stopToolTicker();
    this.unsubModelSync?.();
    this.unsubModelSync = null;
    this.phoneMq?.removeEventListener("change", this.onPhoneMq);
    this.phoneMq = null;
    if (this.ownsGlobals) {
      window.removeEventListener("keydown", this.onKey);
      window.removeEventListener(AGENT_CHAT_EVENT, this.onChatEvent);
      window.removeEventListener(CMO_CHAT_EVENT, this.onChatEvent);
      // Only drop our own handles — a re-mounted instance may already own them.
      if (window.agentChat === this.agentChatApi) delete window.agentChat;
      if (window.cmoChat === this.cmoChatApi) delete window.cmoChat;
    }
    window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onSessionsChanged);
    this.unsub?.();
  }

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("agentId") && (this.lockedAgent || !this.currentAgent) && this.agentId) {
      this.currentAgent = normalizeAgentId(this.agentId);
    }
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client")) {
      this.subscribe();
      if (this.integrated) void this.activate();
      void this.speech.refresh();
    }
    if (changed.has("open") && !this.integrated) {
      this.toggleAttribute("data-open", this.open);
      if (!this.open) {
        this.speech.stop();
        this.speech.cancelRecording();
      }
    }
    if (changed.has("open") && this.open) {
      const quiet = this.quietOpen;
      this.updateComplete.then(() => {
        if (!quiet) this.focusComposer();
        this.scrollToBottom();
      });
    }
    this.quietOpen = false;
    if (!this.integrated && (changed.has("dockWidth") || changed.has("dockCollapsed"))) {
      this.style.setProperty(
        "--acs-width",
        `${this.dockCollapsed ? CHAT_DOCK_RAIL_WIDTH : clampDockWidth(this.dockWidth, this.viewportCss())}px`,
      );
      this.toggleAttribute("data-collapsed", this.dockCollapsed);
    }
    if (changed.has("open") || changed.has("dockWidth") || changed.has("dockCollapsed") || changed.has("isPhone")) {
      this.syncPageReserve();
    }
    // Thread switches, reloads and tool events all land here: keep the
    // 1 s ticker running exactly while the open thread has a running tool.
    this.syncToolTicker();
  }

  /**
   * Desktop: the open dock reserves its width so the page reflows beside it
   * instead of sliding under it (styles/layout.css reads
   * `--ib-chat-dock-reserve` on <html>). Phones keep the full-width sheet.
   */
  private syncPageReserve(): void {
    if (!this.ownsGlobals || typeof document === "undefined") return;
    const root = document.documentElement;
    if (this.open && !this.isPhone) {
      const w = this.dockCollapsed ? CHAT_DOCK_RAIL_WIDTH : clampDockWidth(this.dockWidth, this.viewportCss());
      root.style.setProperty("--ib-chat-dock-reserve", `${w}px`);
      root.toggleAttribute("data-chat-dock-open", true);
    } else {
      root.style.removeProperty("--ib-chat-dock-reserve");
      root.toggleAttribute("data-chat-dock-open", false);
    }
  }

  firstUpdated(): void {
    if (this.integrated) void this.activate();
  }

  /* ── Dock: resize / collapse ────────────────────────────────────────── */

  private persistDock(): void {
    saveDockState(globalThis.localStorage, { width: this.dockWidth, collapsed: this.dockCollapsed });
  }

  /**
   * Rendered px per CSS px. The shell zooms <body> on mid-size desktops
   * (styles/viewport-scale.css, e.g. 0.7) while pointer clientX / innerWidth
   * are unzoomed viewport px — divide them out so dragging tracks the pointer.
   */
  private dockZoom(): number {
    const z = parseFloat(getComputedStyle(document.body).zoom || "1");
    return z > 0.25 && z < 4 ? z : 1;
  }

  /** Viewport width in the dock's CSS px. */
  private viewportCss(): number {
    return window.innerWidth / this.dockZoom();
  }

  private dragZoom = 1;
  private onResizeDown = (e: PointerEvent): void => {
    if (e.button !== 0 || window.innerWidth <= CHAT_DOCK_SHEET_BREAKPOINT) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this.dragZoom = this.dockZoom();
    this.resizing = true;
  };

  private resizeRaf = 0;
  private onResizeMove = (e: PointerEvent): void => {
    if (!this.resizing) return;
    const x = e.clientX;
    cancelAnimationFrame(this.resizeRaf);
    this.resizeRaf = requestAnimationFrame(() => {
      const z = this.dragZoom;
      const next = widthFromPointer(x / z, window.innerWidth / z);
      this.dockCollapsed = next.collapse;
      if (!next.collapse) this.dockWidth = next.width;
    });
  };

  private onResizeUp = (e: PointerEvent): void => {
    if (!this.resizing) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    this.resizing = false;
    this.persistDock();
  };

  private onResizeKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      this.dockCollapsed = false;
      this.dockWidth = clampDockWidth(this.dockWidth + (e.key === "ArrowLeft" ? step : -step), this.viewportCss());
      this.persistDock();
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.toggleCollapsed();
    }
  };

  private resetDockWidth = (): void => {
    this.dockCollapsed = false;
    this.dockWidth = clampDockWidth(NaN, this.viewportCss());
    this.persistDock();
  };

  toggleCollapsed(): void {
    this.dockCollapsed = !this.dockCollapsed;
    this.persistDock();
    if (!this.dockCollapsed) this.updateComplete.then(() => this.focusComposer());
  }

  /** Talk button → composer (ChatSpeechController host contract). */
  applyTranscript(text: string, autoSend: boolean): void {
    const next = this.draft.trim() ? `${this.draft.trimEnd()} ${text}` : text;
    if (autoSend) {
      void this.send(next);
      return;
    }
    this.draft = next;
    this.updateComplete.then(() => this.focusComposer());
  }

  private keyOf(it: ChatItem): string {
    let k = this.itemKeys.get(it);
    if (!k) {
      k = `m${++this.itemSeq}`;
      this.itemKeys.set(it, k);
    }
    return k;
  }

  /** A reply just landed in session `key`: read it aloud when that is on. */
  private announceReply(key: string): void {
    if (key !== this.sessionKey || (!this.open && !this.integrated) || this.dockCollapsed) return;
    const last = this.threads.get(key).items.at(-1);
    if (last?.role === "assistant") this.speech.onAssistantReply(this.keyOf(last), last.text);
  }

  /** Public API: open on a specific agent (or the current/last-used one). */
  openOn(agentId?: string): void {
    this.apply({ action: "open", agentId });
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.switcherOpen = false;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back?.isConnected) back.focus();
  }

  /** The session the dock shows (read by chat-follow-nav for links clicked in here). */
  get currentSessionKey(): string {
    return this.sessionKey;
  }

  /** Is the dock open (and expanded) on `key`? */
  isShowing(key: string): boolean {
    return this.open && !this.dockCollapsed && this.sessionKey === key;
  }

  /** Next open came from "chat follows navigation" — don't move focus off the page. */
  private quietOpen = false;

  private apply(req: ChatOpenRequest): void {
    if (req.sessionKey && this.sessionsEnabled) {
      this.openOnSession(req.sessionKey, Boolean(req.follow));
      return;
    }
    if (req.action === "close" || (req.action === "toggle" && this.open && !req.agentId)) {
      this.close();
      return;
    }
    if (req.action === "toggle" && this.open && req.agentId && req.agentId === this.agent) {
      this.close();
      return;
    }
    if (req.agentId && !this.lockedAgent) this.selectAgent(req.agentId);
    if (!this.open) {
      const active = document.activeElement as HTMLElement | null;
      this.returnFocus = active && active !== document.body ? active : null;
      this.open = true;
    }
    // Opening a collapsed dock expands it.
    if (this.dockCollapsed) {
      this.dockCollapsed = false;
      this.persistDock();
    }
    void this.activate();
    void this.speech.refresh();
  }

  /**
   * Open (or keep open) on an exact session — "chat follows navigation".
   * Already showing it: nothing changes (scroll position, stream, draft all
   * stay). Otherwise switch to it; the thread hydrates from history and live
   * `chat` deltas keep streaming into it.
   */
  private openOnSession(key: string, follow: boolean): void {
    const agentId = agentIdFromKey(key);
    if (!agentId) return;
    if (this.isShowing(key)) return;
    if (!this.open) {
      const active = document.activeElement as HTMLElement | null;
      this.returnFocus = active && active !== document.body ? active : null;
      this.quietOpen = follow;
      this.open = true;
    }
    if (this.dockCollapsed) {
      this.dockCollapsed = false;
      this.persistDock();
    }
    if (this.sessionKey !== key) this.selectSession(key, { focus: !follow });
    void this.loadAgents();
    void this.speech.refresh();
  }

  /** Resolve the agent (once agents are known), load roster + thread history. */
  private async activate(): Promise<void> {
    await this.loadAgents();
    if (!this.currentAgent) {
      this.currentAgent = this.lockedAgent
        ? normalizeAgentId(this.agentId) || CMO_AGENT_ID
        : resolveInitialAgent({
            requested: this.agentId,
            lastUsed: loadLastAgent(),
            agents: this.agents,
            defaultId: this.defaultAgentId,
          });
    }
    await this.resolveSession(this.agent);
    void this.hydrate(this.sessionKey);
    void this.loadSessionModel();
  }

  /* ── Per-session model (same override the main chat page sets) ─────── */

  private agentDefaultModel(id = this.agent): string | null {
    return this.agentRow(id)?.model ?? this.globalModel;
  }

  private setSessionModel(key: string, patch: Partial<PanelSessionModel>): void {
    const next = new Map(this.sessionModels);
    next.set(key, { model: null, overridden: false, thinkingLevel: null, ...next.get(key), ...patch });
    this.sessionModels = next;
  }

  /** Is `key` one of this surface's sessions (a chat thread, or this embed's fixed one)? */
  private ownsSessionKey(key: string): boolean {
    return isChatSessionKey(key) || agentIdFromSessionKey(key, this.sessionSuffix) !== null || (Boolean(this.laneKey) && key === this.laneKey);
  }

  /**
   * Read the model/thinking override of the selected session (default: the
   * current one). A chat that hasn't been sent to yet has no row — it shows
   * the agent default until the user picks a model.
   */
  private async loadSessionModel(key = this.sessionKey): Promise<void> {
    if (!this.client || !key) return;
    try {
      const res = await this.client.request<SessionsListResult>("sessions.list", { search: key, limit: 20 });
      const d = res?.defaults as { model?: string | null; modelProvider?: string | null } | undefined;
      if (d?.model) this.globalModel = d.modelProvider ? `${d.modelProvider}/${d.model}` : d.model;
      const row = (Array.isArray(res?.sessions) ? res.sessions : []).find((r) => r.key === key);
      if (!row) return;
      this.setSessionModel(key, {
        model: row.model ?? null,
        overridden: Boolean(row.modelOverridden),
        thinkingLevel: row.thinkingLevel ?? null,
      });
    } catch (err) {
      console.warn("[agent-chat] sessions.list failed", err);
    }
  }

  private async onModelSelect(model: string | null): Promise<void> {
    if (!this.client) return;
    const key = this.sessionKey;
    const prev = this.sessionModels;
    this.setSessionModel(key, { model, overridden: Boolean(model) });
    try {
      await this.client.request("sessions.patch", { key, model });
      announceSessionModel({ sessionKey: key, model, source: this });
    } catch (e) {
      this.sessionModels = prev;
      this.threads.patch(key, { error: e instanceof Error ? e.message : String(e) });
      this.bump();
    }
  }

  private async onThinkingSelect(level: string | null): Promise<void> {
    if (!this.client) return;
    const key = this.sessionKey;
    const prev = this.sessionModels;
    this.setSessionModel(key, { thinkingLevel: level });
    try {
      await this.client.request("sessions.patch", { key, thinkingLevel: level });
    } catch (e) {
      this.sessionModels = prev;
      this.threads.patch(key, { error: e instanceof Error ? e.message : String(e) });
      this.bump();
    }
  }

  private renderModelPicker() {
    const s = this.sessionModels.get(this.sessionKey);
    const fallback = this.agentDefaultModel();
    const overridden = Boolean(s?.overridden && s.model);
    return html`<webchat-model-picker
      compact
      class="model-picker"
      data-learn-id="quick-chat-model-picker"
      data-ib-target="control:chat/model-picker"
      .client=${this.client}
      .connected=${Boolean(this.client)}
      .value=${overridden ? s!.model : fallback}
      .defaultModel=${fallback}
      .overridden=${overridden}
      .thinkingLevel=${s?.thinkingLevel ?? null}
      .mobile=${this.isPhone && !this.integrated}
      @model-select=${(e: CustomEvent<{ model: string | null }>) => void this.onModelSelect(e.detail.model)}
      @thinking-select=${(e: CustomEvent<{ level: string | null }>) => void this.onThinkingSelect(e.detail.level)}
    ></webchat-model-picker>`;
  }

  private agentsInFlight: Promise<void> | null = null;

  private loadAgents(): Promise<void> {
    if (!this.client || this.lockedAgent) return Promise.resolve();
    if (Date.now() - this.agentsLoadedAt < AGENTS_TTL_MS && this.agents.length) return Promise.resolve();
    this.agentsInFlight ??= this.client
      .request<AgentsListResult>("agents.list", {})
      .then((res) => {
        this.agents = Array.isArray(res?.agents) ? res.agents : [];
        this.defaultAgentId = res?.defaultId ?? null;
        this.agentsLoadedAt = Date.now();
      })
      .catch((err) => console.warn("[agent-chat] agents.list failed", err))
      .finally(() => (this.agentsInFlight = null));
    return this.agentsInFlight;
  }

  /**
   * Pick the session for `agentId` when none is selected for it: the one
   * remembered for this agent → its most recent chat → a fresh new chat.
   */
  private async resolveSession(agentId: string): Promise<void> {
    if (!this.sessionsEnabled) return;
    if (this.currentKey && agentIdFromKey(this.currentKey) === agentId) return;
    let key = loadRememberedSession(agentId);
    if (!key && this.client) {
      try {
        const page = await fetchChatSessionsPage(this.client, { agentId, limit: 1, includeLastMessage: false });
        key = page.sessions[0]?.key ?? null;
      } catch {
        /* list unavailable — start a new chat */
      }
    }
    // The agent may have changed while we were looking.
    if (agentId !== this.agent || (this.currentKey && agentIdFromKey(this.currentKey) === agentId)) return;
    this.currentKey = key ?? this.freshKey(agentId);
  }

  /** A new, empty chat for `agentId` (created on the gateway by its first message). */
  private freshKey(agentId: string): string {
    const key = newChatSessionKey(agentId);
    this.threads.patch(key, { hydrated: true });
    return key;
  }

  /** Load the newest page of `key`'s history (once; retried after a failure). */
  private async hydrate(key: string): Promise<void> {
    const t = this.threads.get(key);
    if (!this.client || t.hydrated || t.loading) return;
    this.threads.patch(key, { loading: true, loadError: null });
    this.bump();
    try {
      const page = await fetchHistoryPage(this.client, key, { limit: HISTORY_PAGE_SIZE });
      const { visible, older } = splitHistoryWindow(historyToItems(page.messages, extractText));
      this.threads.hydrate(key, visible);
      this.threads.patch(key, {
        loading: false,
        olderBuffer: older,
        cursor: page.startIndex,
        hasMoreRemote: page.hasMore,
      });
      this.bump();
      if (key === this.sessionKey) this.scrollToBottom();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      // A session that doesn't exist yet simply has no history.
      if (/not found|no session|unknown session/i.test(msg)) this.threads.patch(key, { hydrated: true, loading: false });
      else this.threads.patch(key, { loading: false, loadError: msg.replace(/^Error:\s*/, "") });
      this.bump();
    }
  }

  /** Scroll-back: reveal buffered older items, else fetch the page before the cursor. */
  private async loadOlder(key = this.sessionKey): Promise<void> {
    const t = this.threads.get(key);
    if (!this.client || t.loadingOlder || t.loading || !threadHasOlder(t)) return;
    let older: ChatItem[] = [];
    if (t.olderBuffer.length) {
      const { chunk, rest } = takeOlderChunk(t.olderBuffer, OLDER_CHUNK);
      older = chunk;
      this.threads.patch(key, { olderBuffer: rest });
    } else {
      this.threads.patch(key, { loadingOlder: true });
      this.bump();
      try {
        const page = await fetchHistoryPage(this.client, key, { beforeIndex: t.cursor, limit: HISTORY_PAGE_SIZE });
        older = historyToItems(page.messages, extractText);
        this.threads.patch(key, { cursor: page.startIndex, hasMoreRemote: page.hasMore && page.messages.length > 0 });
      } catch (err) {
        this.threads.patch(key, { loadingOlder: false, error: `Couldn't load earlier messages: ${String((err as Error)?.message ?? err)}` });
        this.bump();
        return;
      }
      this.threads.patch(key, { loadingOlder: false });
    }
    // Keep the viewport on the same message while content grows above it.
    const log = key === this.sessionKey ? this.renderRoot.querySelector<HTMLElement>(".log") : null;
    const fromBottom = log ? log.scrollHeight - log.scrollTop : 0;
    this.threads.prepend(key, older);
    this.bump();
    if (log) {
      await this.updateComplete;
      log.scrollTop = log.scrollHeight - fromBottom;
    }
  }

  private onLogScroll = (e: Event): void => {
    const log = e.currentTarget as HTMLElement;
    if (log.scrollTop < 160) void this.loadOlder();
  };

  /** Re-read a session from the top (a turn finished that this dock didn't send). */
  private reloadThread(key: string): void {
    const keepError = this.threads.get(key).error;
    this.threads.drop(key);
    if (keepError) this.threads.patch(key, { error: keepError });
    void this.hydrate(key);
  }

  private selectAgent(id: string): void {
    const next = normalizeAgentId(id);
    if (!next || this.lockedAgent) return;
    this.currentAgent = next;
    saveLastAgent(next);
    if (this.sessionsEnabled && agentIdFromKey(this.currentKey) !== next) {
      this.currentKey = "";
      void this.resolveSession(next).then(() => {
        void this.hydrate(this.sessionKey);
        void this.loadSessionModel();
      });
    } else {
      void this.hydrate(this.sessionKey);
      void this.loadSessionModel();
    }
    this.scrollToBottom();
  }

  /** Switch to an existing chat (possibly another agent's). */
  selectSession(key: string, opts: { focus?: boolean } = {}): void {
    const agentId = agentIdFromKey(key);
    if (!agentId || !this.sessionsEnabled) return;
    if (agentId !== this.currentAgent) {
      this.currentAgent = agentId;
      saveLastAgent(agentId);
    }
    this.currentKey = key;
    rememberSession(key);
    const t = this.threads.get(key);
    // A thread that errored on load gets another go when re-picked.
    if (t.loadError) this.threads.patch(key, { loadError: null });
    // A group chat renders <ib-group-chat>, which loads its own transcript.
    if (!isGroupChatKey(key)) void this.hydrate(key);
    void this.loadSessionModel(key);
    this.scrollToBottom();
    if (opts.focus !== false) this.updateComplete.then(() => this.focusComposer());
  }

  /** Start a new, empty chat with the current agent. */
  newChat(): void {
    if (!this.sessionsEnabled) return;
    this.currentKey = this.freshKey(this.agent);
    this.draft = "";
    this.bump();
    this.updateComplete.then(() => this.focusComposer());
  }

  /**
   * Composer Secure Mode toggle. On: Secure Mode on (if needed) + this dock's
   * last secure chat for the agent, or a new one (`secure.session.new`). Off:
   * back to the chat it came from. The draft never crosses lanes.
   */
  private async onSecureToggle(on: boolean): Promise<void> {
    const agentId = this.agent;
    const from = this.sessionKey;
    const surface = this.sessionsEnabled ? "sidebar" : `embed-${this.sessionSuffix}`;
    const next = await this.secureLane.switch({
      on,
      surface,
      agentId,
      currentKey: from,
      fallbackNormalKey: this.sessionsEnabled ? null : sessionKeyFor(agentId, this.sessionSuffix),
    });
    if (next === undefined || agentId !== this.agent || from !== this.sessionKey) return;
    this.draft = "";
    if (!this.sessionsEnabled) {
      this.laneKey = next && isSecureSessionKey(next) ? next : "";
      void this.hydrate(this.sessionKey);
      void this.loadSessionModel();
      this.scrollToBottom();
      return;
    }
    if (next) this.selectSession(next);
    else this.newChat();
  }

  /** Lock badge + compact toggle above the composer. */
  private renderSecureRow() {
    if (!this.secureLane.supported) return nothing;
    const key = this.sessionKey;
    const on = isSecureSessionKey(key);
    return html`<div class="ibss-row acm-sec-row ${on ? "acm-sec-row--on" : ""}" data-secure-row="sidebar">
      ${renderSecureSurfaceBadge(key, { surface: "sidebar", short: this.dockWidth < 380 })}
      <span class="ibss-row__spacer"></span>
      <ib-secure-toggle
        compact
        mode="custom"
        class="acm-sec-toggle"
        data-secure-surface=${this.sessionsEnabled ? "sidebar" : "chat-embed"}
        .on=${on}
        .busy=${this.secureLane.busy}
        .error=${this.secureLane.error}
        ?disabled=${!this.client}
        @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => void this.onSecureToggle(e.detail.on)}
      ></ib-secure-toggle>
    </div>`;
  }

  /** Open a chat (or a fresh one) in the full-page Chat, then close the dock. */
  private openInFullChat(key: string | null): void {
    const path = webchatPathForKey(key, inferBasePathFromPathname(window.location.pathname));
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    this.close();
  }

  private onSessionDeleted(key: string): void {
    this.threads.drop(key);
    if (key === this.currentKey) this.newChat();
  }

  private onSessionsChanged = (e: Event): void => {
    const d = (e as CustomEvent<{ key?: string; reason?: string }>).detail;
    if (d?.reason === "delete" && d.key) this.onSessionDeleted(d.key);
  };

  private get sessionSwitcher(): ChatSessionSwitcher | null {
    return this.renderRoot?.querySelector?.("chat-session-switcher") ?? null;
  }

  /**
   * Bar title until the session's row is known: "New chat" when empty, its
   * first message once the start of the conversation is loaded, else "Chat".
   */
  private get fallbackSessionTitle(): string {
    const t = this.thread;
    // A secure chat opened by key (e.g. chat follows navigation) isn't in the
    // list while Secure Mode is off — say what it is rather than "New chat".
    if (!t.items.length) return t.loading ? "Loading…" : isSecureSessionKey(this.sessionKey) ? "Secure chat" : "New chat";
    if (threadHasOlder(t)) return "Chat";
    const first = t.items.find((it) => it.role === "user");
    const text = first && "text" in first ? cleanUserText(first.text) : "";
    return text ? text.slice(0, 80) : "Chat";
  }

  private bump(): void {
    this.rev++;
  }

  private subscribe(): void {
    this.unsub?.();
    if (!this.client) return;
    this.unsub = this.client.subscribe((evt) => this.onEvent(evt));
  }

  private onEvent(evt: GatewayEventFrame): void {
    if (evt.event === GATEWAY_SESSIONS_CHANGED_EVENT) {
      const p = evt.payload as { key?: string; reason?: string } | undefined;
      if (p?.reason === "delete" && p.key) this.onSessionDeleted(p.key);
      // Model/thinking changed from another device — re-read the open session.
      else if (p?.key && p.key === this.sessionKey) void this.loadSessionModel(p.key);
      return;
    }
    if (evt.event === "chat") {
      const p = evt.payload as
        | {
            sessionKey?: string;
            state?: string;
            message?: unknown;
            errorMessage?: string;
            errorCode?: string;
            errorHint?: string;
          }
        | undefined;
      const id = p?.sessionKey;
      if (!p || !id || !this.threads.has(id)) return;
      if (p.state === "delta") {
        // Same contract as webchat's handleChatEvent: deltas carry the full
        // text so far; extractText joins text blocks and skips thinking.
        const chunk = extractText(p.message);
        if (chunk && chunk.length >= (this.threads.get(id).streamText?.length ?? 0)) {
          this.threads.patch(id, { streamText: chunk });
        }
      } else if (p.state === "final" || p.state === "aborted") {
        // Prefer the final message — the last delta can lag behind it. With no
        // message on a final frame, recover it from history (stream = fallback).
        const finalText = extractText(p.message);
        const { streamText: streamed, sending: ownTurn, items: before } = this.threads.get(id);
        this.threads.patch(id, { sending: false, streamText: null, items: settleRunningTools(before, Date.now()) });
        if (!ownTurn && p.state === "final") {
          // A turn sent from another surface (webchat, another device) into this
          // session: re-read it so its user message shows too.
          this.reloadThread(id);
        } else if (finalText) {
          this.threads.append(id, { role: "assistant", text: finalText });
          if (p.state === "final") this.announceReply(id);
        } else if (p.state === "final") void this.fetchFinalFromHistory(id, streamed);
        else if (streamed) this.threads.append(id, { role: "assistant", text: streamed });
        // Tool events only stream for verbose sessions, so show_panel results
        // are picked up from the turn's transcript (as webchat/Grid do).
        if (p.state === "final") void this.syncTurnPanels(id);
      } else if (p.state === "error") {
        this.threads.patch(id, {
          sending: false,
          streamText: null,
          error: formatChatErrorText(p),
          items: settleRunningTools(this.threads.get(id).items, Date.now()),
        });
      }
      this.bump();
      if (id === this.sessionKey) this.scrollToBottom();
      return;
    }
    if (evt.event === "agent") {
      const notice = parseModelFallbackNotice(evt.payload);
      if (notice) {
        const noticeKey = notice.sessionKey;
        if (noticeKey && this.threads.has(noticeKey)) {
          this.threads.append(noticeKey, {
            role: "assistant",
            text: formatModelFallbackNotice(notice),
          });
          this.bump();
        }
        return;
      }
      const p = evt.payload as
        | { sessionKey?: string; stream?: string; data?: Record<string, unknown> }
        | undefined;
      const id = p?.sessionKey;
      // "tool" = full events (verbose sessions); "tool_status" = the
      // gateway's name-only ping for every other session. Both drive the
      // in-flight loading card.
      if (!p || (p.stream !== "tool" && p.stream !== "tool_status") || !id || !this.threads.has(id)) return;
      const data = p.data ?? {};
      const phase = (data.phase as string) ?? "start";
      const name = (data.name as string) ?? "tool";
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      const items = this.threads.get(id).items;
      if (phase === "start") {
        const args = data.args ?? data.arguments;
        let detail: string | undefined;
        if (args !== undefined) {
          try {
            detail = JSON.stringify(args).slice(0, 160);
          } catch {
            detail = String(args).slice(0, 160);
          }
        }
        this.threads.patch(id, { items: startToolItem(items, { name, detail, callId, now: Date.now() }) });
      } else if (phase === "end" && data.error) {
        const settled = finishToolItem(items, { name, callId, isError: true, now: Date.now() });
        this.threads.patch(id, { items: [...settled, { role: "error", text: `${name}: ${String(data.error)}` }] });
      } else if (phase === "result") {
        let next = finishToolItem(items, { name, callId, isError: data.isError === true, now: Date.now() });
        // show_panel / flypic.* → inline panel card where the loading card was
        // (same shared detector/renderer as webchat, Grid, classic chat and voice).
        if (!data.isError) next = insertPanelsAfterTool(next, callId, panelItemsFromToolResult(data.result));
        if (next === items) return;
        this.threads.patch(id, { items: next });
      } else {
        return;
      }
      this.syncToolTicker();
      this.bump();
      if (id === this.sessionKey) this.scrollToBottom();
    }
  }

  /** Pull the finished turn's panel refs (show_panel results) from chat.history. */
  private async syncTurnPanels(key: string): Promise<void> {
    if (!this.client) return;
    try {
      const res = (await this.client.request("chat.history", {
        sessionKey: key,
        limit: 30,
      })) as { messages?: Array<{ role?: string }> };
      const panels = panelsForLastTurn(res?.messages);
      if (!panels.length) return;
      const items = this.threads.get(key).items;
      const next = insertPanelsBeforeReply(items, panels);
      if (next === items) return;
      this.threads.patch(key, { items: next });
      this.bump();
      if (key === this.sessionKey) this.scrollToBottom();
    } catch {
      /* history unavailable — the reply text still stands */
    }
  }

  /** The final frame carried no text — recover the reply from chat.history. */
  private async fetchFinalFromHistory(key: string, fallback?: string | null): Promise<void> {
    const useFallback = () => {
      if (!fallback) return;
      this.threads.append(key, { role: "assistant", text: fallback });
      this.bump();
      this.announceReply(key);
    };
    if (!this.client) return useFallback();
    try {
      const res = (await this.client.request("chat.history", {
        sessionKey: key,
        limit: 20,
      })) as { messages?: Array<{ role?: string }> };
      const last = historyToItems(res?.messages, extractText).at(-1);
      if (last?.role !== "assistant") return useFallback();
      this.threads.append(key, last);
      this.bump();
      this.announceReply(key);
      if (key === this.sessionKey) this.scrollToBottom();
    } catch {
      useFallback();
    }
  }

  private scrollToBottom(): void {
    this.updateComplete.then(() => {
      const log = this.renderRoot.querySelector<HTMLElement>(".log");
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  private focusComposer(): void {
    this.renderRoot.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }

  private async send(text?: string): Promise<void> {
    const msg = (text ?? this.draft).trim();
    const key = this.sessionKey;
    if (!msg || this.thread.sending || !this.client) return;
    const isNew = this.sessionsEnabled && this.threads.get(key).items.length === 0;
    this.draft = "";
    this.threads.append(key, { role: "user", text: msg });
    this.threads.patch(key, { sending: true, streamText: "", error: null });
    this.bump();
    this.scrollToBottom();
    if (this.sessionsEnabled) {
      rememberSession(key);
      // Show a just-started chat in the list before the store catches up.
      this.sessionSwitcher?.upsertOptimistic({
        key,
        kind: "direct",
        derivedTitle: isNew ? msg.slice(0, 80) : undefined,
        lastMessagePreview: msg.slice(0, 160),
        updatedAt: Date.now(),
      });
    }
    try {
      const idempotencyKey = `${this.agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.client.request("chat.send", {
        sessionKey: key,
        message: msg,
        deliver: false,
        idempotencyKey,
      });
      if (isNew) notifyChatSessionsChanged({ key, reason: "create", source: "sidebar" });
    } catch (e) {
      this.threads.patch(key, {
        sending: false,
        streamText: null,
        error: e instanceof Error ? e.message : String(e),
      });
      this.bump();
    }
  }

  private onComposerKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  /* ── Agent switcher ─────────────────────────────────────────────────── */

  private get switcherResults(): GatewayAgentRow[] {
    return filterAgents(this.agents, this.switcherQuery);
  }

  private toggleSwitcher(): void {
    if (this.switcherOpen) {
      this.closeSwitcher(true);
      return;
    }
    this.switcherQuery = "";
    this.switcherOpen = true;
    this.syncSwitcherIndex();
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>(".sw-search")?.focus());
    // The roster may still be loading on first open — re-sync once it lands.
    void this.loadAgents().then(() => this.syncSwitcherIndex());
  }

  /** Highlight the current agent (when not searching) and scroll it into view. */
  private syncSwitcherIndex(): void {
    if (!this.switcherOpen || this.switcherQuery) return;
    const idx = this.agents.findIndex((a) => a.id === this.agent);
    this.switcherIndex = idx >= 0 ? idx : 0;
    this.updateComplete.then(() =>
      this.renderRoot.querySelector(".sw-opt.active")?.scrollIntoView({ block: "nearest" }),
    );
  }

  private closeSwitcher(refocus = false): void {
    this.switcherOpen = false;
    if (refocus)
      this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>(".sw-trigger")?.focus());
  }

  private pick(id: string): void {
    this.selectAgent(id);
    this.closeSwitcher();
    this.updateComplete.then(() => this.focusComposer());
  }

  private onSwitcherKey(e: KeyboardEvent): void {
    const list = this.switcherResults;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!list.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.switcherIndex = (this.switcherIndex + step + list.length) % list.length;
      this.updateComplete.then(() =>
        this.renderRoot.querySelector(".sw-opt.active")?.scrollIntoView({ block: "nearest" }),
      );
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      this.switcherIndex = e.key === "Home" ? 0 : Math.max(0, list.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = list[this.switcherIndex];
      if (hit) this.pick(hit.id);
    }
  }

  /* ── Render ─────────────────────────────────────────────────────────── */

  render() {
    if (this.integrated) {
      // Integrated / inline mode — always-visible panel, no overlay
      return html`<div class="dialog integrated" role="region" aria-label="${this.agentTitle} chat">
        ${this.renderDialogInner()}
      </div>`;
    }
    if (!this.open) return nothing;
    if (this.dockCollapsed) {
      return html`<aside class="dock-rail" role="complementary" aria-label="Chat with ${this.agentTitle} (collapsed)"
        data-learn-id="quick-chat">
        <button class="rail-expand" title="Expand chat" aria-label="Expand chat" aria-expanded="false"
          data-learn-id="quick-chat-expand" @click=${() => this.toggleCollapsed()}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" /></svg>
        </button>
        <span class="rail-label">${this.agentTitle}</span>
        ${this.thread.sending ? html`<span class="rail-dot" title="Replying…"></span>` : nothing}
      </aside>`;
    }
    return html`
      <aside
        class="dialog dock ${this.resizing ? "resizing" : ""}"
        role="complementary"
        aria-label="Chat with ${this.agentTitle}"
        data-learn-id="quick-chat"
        data-ib-target="modal:chat"
      >
        <div
          class="dock-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat (arrow keys, Enter collapses, double-click resets)"
          aria-valuemin=${CHAT_DOCK_MIN_WIDTH}
          aria-valuenow=${this.dockWidth}
          tabindex="0"
          title="Drag to resize · double-click to reset"
          @pointerdown=${this.onResizeDown}
          @pointermove=${this.onResizeMove}
          @pointerup=${this.onResizeUp}
          @pointercancel=${this.onResizeUp}
          @dblclick=${this.resetDockWidth}
          @keydown=${this.onResizeKey}
        ></div>
        ${this.resizing ? html`<span class="dock-width-chip" aria-hidden="true">${this.dockWidth}px</span>` : nothing}
        ${this.renderDialogInner()}
      </aside>
    `;
  }

  /** Header title for the current agent. */
  get agentTitle(): string {
    if (this.isCmo && this.lockedAgent) return "Chief Marketing Officer";
    return agentDisplayName(this.agentRow(), this.agent);
  }

  private renderAgentGlyph(agent: GatewayAgentRow | undefined) {
    const emoji = sanitizeIdentityEmoji(agent?.identity?.emoji);
    return emoji
      ? html`<span class="glyph" aria-hidden="true">${emoji}</span>`
      : html`<span class="glyph glyph-logo" aria-hidden="true"
          >${renderBrandAvatar("logo-badge", "")}</span
        >`;
  }

  private renderDialogInner() {
    const locked = this.lockedAgent || this.integrated;
    return html`
      <div class="dialog-aurora" aria-hidden="true"></div>

      <header class="head">
        <div class="ident">
          <div class="badge">${renderBrandAvatar("logo-badge", "InfiniBot")}</div>
          ${locked ? this.renderLockedWho() : this.renderSwitcher()}
          ${this.renderModelPicker()}
        </div>
        ${this.integrated
          ? nothing
          : html`<div class="head-actions">
            <button class="close collapse" data-learn-id="quick-chat-collapse" title="Collapse to the edge"
              aria-label="Collapse chat" aria-expanded="true" @click=${() => this.toggleCollapsed()}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>
            </button>
            <button class="close" data-learn-id="quick-chat-close" title="Close (Esc)" aria-label="Close chat" @click=${() => this.close()}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              >
                <path d="M1 1l10 10M11 1L1 11" />
              </svg>
            </button>
          </div>`}
      </header>

      ${this.sessionsEnabled
        ? html`<chat-session-switcher
            .client=${this.client}
            .agents=${this.agents}
            .agentId=${this.agent}
            .currentKey=${this.sessionKey}
            .fallbackTitle=${this.fallbackSessionTitle}
            @chat-session-select=${(e: CustomEvent<{ key: string }>) => this.selectSession(e.detail.key)}
            @chat-session-new=${() => this.newChat()}
            @chat-session-open-full=${(e: CustomEvent<{ key: string | null }>) => this.openInFullChat(e.detail.key)}
            @chat-session-deleted=${(e: CustomEvent<{ key: string }>) => this.onSessionDeleted(e.detail.key)}
          ></chat-session-switcher>`
        : nothing}

      ${isGroupChatKey(this.sessionKey) ? this.renderGroupBody() : this.renderThreadBody()}
    `;
  }

  /** A group chat in the dock: the same group view the Chat page and Grid use. */
  private renderGroupBody() {
    if (!customElements.get("ib-group-chat")) {
      void import("../features/group_chat/group-chat-view").then(() => this.bump());
      return html`<div class="log"><div class="log-state" role="status">
        <span class="send-spinner log-spinner" aria-hidden="true"></span> Loading group chat…
      </div></div>`;
    }
    return html`<ib-group-chat
      class="dock-group"
      compact
      data-chat-follow="group"
      .client=${this.client}
      .connected=${Boolean(this.client)}
      .sessionKey=${this.sessionKey}
      .agents=${this.agents}
    ></ib-group-chat>`;
  }

  private renderThreadBody() {
    return html`
      ${this.speech.renderStrip()}

      <div class="log" aria-live="polite" @scroll=${this.onLogScroll}>
        ${this.renderLogTop()}
        ${this.thread.items.length === 0 && !this.thread.streamText && !this.thread.loading && !this.thread.loadError
          ? this.renderEmpty()
          : nothing}
        ${this.thread.items.map((it) => this.renderItem(it))}
        ${this.thread.streamText !== null ? this.renderStreaming() : nothing}
        ${this.thread.error ? html`<div class="bubble err">${this.thread.error}</div>` : nothing}
      </div>

      ${this.speech.renderTalkStatus()}
      ${this.renderSecureRow()}
      <div class="composer ${isSecureSessionKey(this.sessionKey) ? "composer--secure" : ""}">
        ${this.speech.renderTalkButton()}
        <chat-call-button .sessionKey=${this.sessionKey} ?disabled=${!this.client} source="chat-sidebar"></chat-call-button>
        <textarea
          rows="1"
          data-learn-id="quick-chat-input"
          data-ib-target="control:chat/input"
          aria-label="Message ${this.agentTitle}"
          placeholder=${this.isCmo
            ? "Ask your CMO about growth, hooks, or a new script…"
            : `Message ${this.agentTitle}…`}
          .value=${this.draft}
          ?disabled=${!this.client}
          @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => this.onComposerKey(e)}
        ></textarea>
        <button
          class="send"
          ?disabled=${this.thread.sending || !this.draft.trim() || !this.client}
          @click=${() => this.send()}
          title="Send (Enter)"
          aria-label="Send"
        >
          ${this.thread.sending
            ? html`<span class="send-spinner"></span>`
            : html`<svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M14 2L2 7.5l5 1.5L9 14l5-12Z" />
              </svg>`}
        </button>
      </div>
    `;
  }

  /** Top of the log: scroll-back loader / "load earlier" / start marker, first-page loading + error. */
  private renderLogTop() {
    const t = this.thread;
    if (t.loading && !t.items.length) {
      return html`<div class="log-state" role="status">
        <span class="send-spinner log-spinner" aria-hidden="true"></span> Loading conversation…
      </div>`;
    }
    if (t.loadError && !t.items.length) {
      return html`<div class="log-state err" role="alert">
        Couldn't load this chat — ${t.loadError}
        <button class="log-retry" @click=${() => {
          this.threads.patch(this.sessionKey, { loadError: null });
          void this.hydrate(this.sessionKey);
        }}>Retry</button>
      </div>`;
    }
    if (t.loadingOlder) {
      return html`<div class="log-state" role="status">
        <span class="send-spinner log-spinner" aria-hidden="true"></span> Loading earlier messages…
      </div>`;
    }
    if (threadHasOlder(t)) {
      return html`<button class="log-older" data-ib-target="control:chat/load-older" @click=${() => this.loadOlder()}>
        Load earlier messages
      </button>`;
    }
    if (this.sessionsEnabled && t.items.length > 0 && t.hydrated) {
      return html`<div class="log-start" aria-hidden="true">Start of conversation</div>`;
    }
    return nothing;
  }

  private renderLockedWho() {
    return html`<div class="who">
      <strong>${this.agentTitle}</strong>
      <small>${this.isCmo ? "grounded in your live reel data" : this.agentRow()?.model ?? this.agent}</small>
    </div>`;
  }

  private renderSwitcher() {
    const row = this.agentRow();
    const results = this.switcherResults;
    return html`
      <div class="switcher">
        <button
          class="sw-trigger"
          data-learn-id="quick-chat-switcher"
          data-ib-target="control:chat/agent-switcher"
          aria-haspopup="listbox"
          aria-expanded=${this.switcherOpen ? "true" : "false"}
          title="Switch agent"
          @click=${() => this.toggleSwitcher()}
        >
          ${this.renderAgentGlyph(row)}
          <span class="who">
            <strong>${this.agentTitle}</strong>
            <small>${row?.model ?? (this.agent === "main" ? "main agent" : this.agent)}</small>
          </span>
          <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
            stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>
        ${this.switcherOpen
          ? html`
              <div class="sw-pop" @keydown=${(e: KeyboardEvent) => this.onSwitcherKey(e)}>
                <input
                  class="sw-search"
                  type="text"
                  placeholder="Search agents…"
                  aria-label="Search agents"
                  aria-controls="sw-list"
                  aria-activedescendant=${results[this.switcherIndex]
                    ? `sw-${results[this.switcherIndex].id}`
                    : ""}
                  .value=${this.switcherQuery}
                  @input=${(e: Event) => {
                    this.switcherQuery = (e.target as HTMLInputElement).value;
                    this.switcherIndex = 0;
                  }}
                />
                <ul class="sw-list" id="sw-list" role="listbox" aria-label="Agents">
                  ${results.length === 0
                    ? html`<li class="sw-empty">${this.agents.length ? "No matching agents" : "Loading agents…"}</li>`
                    : results.map(
                        (a, i) => html`<li
                          id="sw-${a.id}"
                          role="option"
                          aria-selected=${a.id === this.agent ? "true" : "false"}
                          class="sw-opt ${i === this.switcherIndex ? "active" : ""} ${a.id === this.agent
                            ? "current"
                            : ""}"
                          @mouseenter=${() => (this.switcherIndex = i)}
                          @mousedown=${(e: Event) => e.preventDefault()}
                          @click=${() => this.pick(a.id)}
                        >
                          ${this.renderAgentGlyph(a)}
                          <span class="sw-name">${agentDisplayName(a, a.id)}</span>
                          ${a.model ? html`<span class="sw-model">${a.model}</span>` : nothing}
                        </li>`,
                      )}
                </ul>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderEmpty() {
    const cmo = this.isCmo;
    return html`
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">${renderBrandAvatar("logo-badge empty-logo", "")}</div>
        <div class="empty-title">${cmo ? "Your CMO is on the clock." : `Chat with ${this.agentTitle}`}</div>
        <div class="empty-sub">
          ${cmo
            ? "A senior growth operator that reads your real reel performance before it advises."
            : "A quick side conversation — kept per agent, so switching back picks up where you left off."}
        </div>
        <div class="chips">
          ${suggestionsFor(this.agent, this.agentRow()).map(
            (s) => html`<button class="chip" @click=${() => this.send(s)}>${s}</button>`,
          )}
        </div>
      </div>
    `;
  }

  private renderItem(it: ChatItem) {
    if (it.role === "user") return html`<div class="bubble user">${it.text}</div>`;
    if (it.role === "assistant")
      return html`${this.renderAssistant(it.text)}${this.speech.renderMessageActions(this.keyOf(it), it.text)}`;
    if (it.role === "error") return html`<div class="bubble err">${it.text}</div>`;
    if (it.role === "panel") return html`<div class="panel-item">${renderChatPanelRef(it.ref)}</div>`;
    if (it.role === "tool" && it.status) return this.renderToolActivity(it);
    if (it.role === "tool")
      return html`<div class="tool">
        <span class="tspark" aria-hidden="true"></span>
        ${this.toolLabel(it.name)}${it.detail
          ? html`<code>${it.detail}</code>`
          : nothing}
      </div>`;
    return html`<div class="tool result">
      <span class="tool-check" aria-hidden="true">✓</span> ${this.toolLabel(it.name)} returned
    </div>`;
  }

  private renderAssistant(text: string): TemplateResult {
    const parts = this.parseRichContent(text);
    return html`<div class="bubble cmo md-body" @click=${this.onBubbleClick}>${parts}</div>`;
  }

  private onBubbleClick = (e: Event): void => {
    const target = e.target as HTMLElement;
    const reelLink = target.closest<HTMLElement>("[data-reel-shortcode]");
    if (!reelLink) return;
    e.preventDefault();
    const shortcode = reelLink.dataset.reelShortcode;
    if (shortcode) {
      window.dispatchEvent(
        new CustomEvent("infinibot:content-intel-open-reel", { detail: { shortcode } }),
      );
    }
  };

  /** Post-process sanitized markdown HTML to make reel references clickable. */
  private enrichMarkdown(htmlStr: string): string {
    let out = htmlStr;
    const shortcodeLinkRe = /<a[^>]*href="(https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)[^"]*)"[^>]*>(.*?)<\/a>/g;
    out = out.replace(shortcodeLinkRe, (_full, href, shortcode, label) => {
      return `<a href="${href}" data-reel-shortcode="${shortcode}" class="reel-link">${label}</a>`;
    });
    const bareShortcodeRe = /(?<![="\/\w])([A-Za-z0-9_-]{10,11})(?![="\/\w])/g;
    return out;
  }

  private parseRichContent(text: string): TemplateResult[] {
    const parts: TemplateResult[] = [];
    const scriptRe = /```script\n([\s\S]*?)```/g;
    const videoRe = /(?:^|\n)\s*(?:Video:\s*)?(https?:\/\/(?:www\.youtube\.com\/watch\?v=|youtu\.be\/)[\w\-]{6,})/gm;
    const matches: { type: "script" | "video"; start: number; end: number; content: string; }[] = [];
    let m: RegExpExecArray | null;
    while ((m = scriptRe.exec(text)) !== null) {
      matches.push({ type: "script", start: m.index, end: m.index + m[0].length, content: m[1] });
    }
    while ((m = videoRe.exec(text)) !== null) {
      const url = m[0].trim().replace(/^Video:\s*/i, "");
      matches.push({ type: "video", start: m.index, end: m.index + m[0].length, content: url });
    }
    matches.sort((a, b) => a.start - b.start);
    let lastEnd = 0;
    for (const match of matches) {
      if (match.start > lastEnd) {
        const chunk = text.slice(lastEnd, match.start);
        if (chunk.trim()) parts.push(html`${unsafeHTML(this.enrichMarkdown(toSanitizedMarkdownHtml(chunk)))}`);
      }
      if (match.type === "script") {
        parts.push(this.renderScriptCard(match.content));
      } else {
        parts.push(this.renderVideoPill(match.content));
      }
      lastEnd = match.end;
    }
    if (lastEnd < text.length) {
      const chunk = text.slice(lastEnd);
      if (chunk.trim()) parts.push(html`${unsafeHTML(this.enrichMarkdown(toSanitizedMarkdownHtml(chunk)))}`);
    }
    return parts;
  }

  private renderScriptCard(script: string): TemplateResult {
    const trimmed = script.trim();
    return html`<div class="script-card">
      <div class="script-card-head">
        <span class="script-card-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
            <path d="M3 1.5h6L11 3.5V12a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 3 12V1.5Z" />
            <path d="M9 1.5V3.5h2M5 6h4M5 8h4M5 10h2.5" />
          </svg>
        </span>
        <span class="script-card-label">Script</span>
        <button class="script-copy" title="Copy script" @click=${() => this.copyScript(trimmed)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">
            <rect x="3" y="3" width="6" height="6" rx="1" />
            <path d="M5.5 1.5h3a1 1 0 0 1 1 1v3" />
          </svg>
        </button>
      </div>
      <pre class="script-card-body"><code>${trimmed}</code></pre>
    </div>`;
  }

  private renderVideoPill(url: string): TemplateResult {
    const cleanUrl = url.trim();
    return html`<a class="video-pill" href=${cleanUrl} target="_blank" rel="noopener noreferrer">
      <span class="video-pill-play" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 2l7 4-7 4V2z" />
        </svg>
      </span>
      <span class="video-pill-label">Watch video</span>
      <span class="video-pill-url">${cleanUrl.replace(/^https?:\/\//, "")}</span>
    </a>`;
  }

  private copyScript(text: string): void {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  private renderStreaming() {
    const text = this.thread.streamText;
    if (text)
      return html`<div class="bubble cmo stream">${text}<span class="caret" aria-hidden="true"></span></div>`;
    return html`<div class="typing" aria-label="${this.agentTitle} is typing">
      <span></span><span></span><span></span>
    </div>`;
  }

  /**
   * In-flight tool card: shimmering card with a spinner, friendly name,
   * elapsed time and (for tools with a typical duration) an easing progress
   * bar; media tools add a skeleton of the image/video being made. Once the
   * call settles it collapses into a small done/error pill, and any result
   * panel (e.g. the flypic.generation card) fades in right below it.
   */
  private renderToolActivity(it: Extract<ChatItem, { role: "tool" }>): TemplateResult {
    const activity = describeToolActivity(it.name);
    const label = activity.label;
    if (it.status !== "running") {
      const failed = it.status === "error";
      const took = it.startedAt && it.endedAt ? formatElapsed(it.endedAt - it.startedAt) : "";
      return html`<div class="tool-done ${failed ? "tool-done--error" : ""}" title=${it.name}>
        <span class="tool-done__mark" aria-hidden="true">${failed ? "!" : "✓"}</span>
        <span>${failed ? `${label} failed` : activity.doneLabel}</span>
        ${took ? html`<span class="tool-done__time">${took}</span>` : nothing}
      </div>`;
    }
    const elapsed = Date.now() - (it.startedAt ?? Date.now());
    const pct = activity.typicalSeconds ? toolProgress(elapsed, activity.typicalSeconds) : null;
    return html`<div
      class="tool-run ${activity.media ? `tool-run--media tool-run--${activity.media}` : ""}"
      role="status"
      aria-label="${label}${activity.provider ? ` with ${activity.provider}` : ""}, ${formatElapsed(elapsed)} elapsed"
      title=${it.name}
    >
      <div class="tool-run__head">
        <span class="tool-run__spinner" aria-hidden="true"></span>
        <span class="tool-run__label">${label}<span class="tool-run__dots" aria-hidden="true"></span></span>
        ${activity.provider ? html`<span class="tool-run__tag">${activity.provider}</span>` : nothing}
        <span class="tool-run__time">${formatElapsed(elapsed)}</span>
      </div>
      ${activity.media
        ? html`<div class="tool-run__canvas" aria-hidden="true">
            <span class="tool-run__glyph">${activity.media === "video" ? "▶" : "✦"}</span>
          </div>`
        : nothing}
      <div class="tool-run__bar ${pct === null ? "tool-run__bar--indeterminate" : ""}" aria-hidden="true">
        <span style=${pct === null ? "" : `width:${Math.max(4, pct)}%`}></span>
      </div>
      ${activity.typicalSeconds && elapsed > activity.typicalSeconds * 1500
        ? html`<div class="tool-run__hint">Taking longer than usual — still working.</div>`
        : nothing}
    </div>`;
  }

  /** Re-render once a second while the open thread has a running tool card (elapsed + progress). */
  private toolTicker: number | null = null;

  private syncToolTicker(): void {
    const running = hasRunningTool(this.thread.items);
    if (running && this.toolTicker === null) {
      this.toolTicker = window.setInterval(() => {
        if (!hasRunningTool(this.thread.items)) this.stopToolTicker();
        this.bump();
      }, 1000);
    } else if (!running) {
      this.stopToolTicker();
    }
  }

  private stopToolTicker(): void {
    if (this.toolTicker !== null) window.clearInterval(this.toolTicker);
    this.toolTicker = null;
  }

  private toolLabel(name: string): string {
    if (name === "content_intel") return "Reading your reel library";
    if (name === "script") return "Generating script";
    if (name === "research" || name === "web") return "Researching";
    return name;
  }

  static styles = [css`
    /* Right-hand dock: fixed under the topbar, no scrim — the page stays
       usable. Above the Live Action voice sidebar (9000) and page chrome,
       below the topbar (99999) and true modals. Closed = display:none. */
    :host {
      position: fixed;
      top: var(--shell-topbar-height, 60px);
      right: 0;
      bottom: 0;
      width: var(--acs-width, 420px);
      max-width: 100vw;
      z-index: 9500;
      display: none;
      font-family: var(--g-font, "Inter", system-ui, sans-serif);
      color: var(--g-fg, #f5f5f4);
    }
    :host([data-open]) {
      display: block;
    }
    /* Integrated host overrides */
    :host([integrated]) {
      position: relative;
      inset: auto;
      width: auto;
      max-width: none;
      z-index: auto;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    button {
      font: inherit;
      cursor: pointer;
      color: inherit;
      border: none;
      background: none;
    }

    @keyframes dot-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.78); }
    }

    /* ── Dialog ───────────────────────────────────────────────────────── */
    .dialog {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      /* Rich glass surface — NO hard border */
      background:
        linear-gradient(
          160deg,
          color-mix(in srgb, var(--g-primary, #fbbf24) 6%, rgba(14, 13, 18, 0.0)) 0%,
          rgba(9, 8, 13, 0.0) 55%
        ),
        rgb(9, 8, 13);
      border: none;
      border-radius: 18px 0 0 0;
      backdrop-filter: blur(28px) saturate(200%) brightness(1.04);
      -webkit-backdrop-filter: blur(28px) saturate(200%) brightness(1.04);
      /* Neon perimeter glow instead of border */
      box-shadow:
        /* Outer ambient gold glow */
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent),
        0 0 32px -6px color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent),
        0 0 80px -16px color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent),
        /* Depth shadow */
        0 32px 90px -20px rgba(0, 0, 0, 0.75),
        0 0 0 0.5px rgba(0, 0, 0, 0.8),
        /* Top-edge highlight */
        inset 0 1px 0 color-mix(in srgb, #fff 9%, transparent),
        /* Bottom-edge depth */
        inset 0 -1px 0 rgba(0, 0, 0, 0.4);
      overflow: hidden;
      animation: dock-in 0.24s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .dialog.resizing {
      user-select: none;
    }

    /* Drag handle on the dock's left edge (same model as the Live Action sidebar). */
    .dock-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 8px;
      z-index: 6;
      cursor: col-resize;
      touch-action: none;
    }
    .dock-resize::after {
      content: "";
      position: absolute;
      top: 50%;
      left: 2px;
      width: 3px;
      height: 44px;
      transform: translateY(-50%);
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent);
      opacity: 0.55;
      transition: opacity 0.15s, height 0.15s;
    }
    .dock-resize:hover::after,
    .dock-resize:focus-visible::after,
    .dialog.resizing .dock-resize::after {
      opacity: 1;
      height: 88px;
      background: var(--g-primary, #fbbf24);
    }
    .dock-resize:focus-visible {
      outline: none;
    }
    .dock-width-chip {
      position: absolute;
      top: 10px;
      left: 14px;
      z-index: 7;
      padding: 2px 8px;
      border-radius: 999px;
      font: 600 10.5px "JetBrains Mono", "Fira Code", monospace;
      color: #0a0a0e;
      background: var(--g-primary, #fbbf24);
    }

    /* Collapsed rail */
    .dock-rail {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding-top: 10px;
      background: rgba(9, 8, 13, 0.92);
      box-shadow: -1px 0 0 color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
      border-radius: 12px 0 0 0;
    }
    .rail-expand {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      color: var(--g-primary, #fbbf24);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
    }
    .rail-label {
      writing-mode: vertical-rl;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 65%, transparent);
      max-height: 60vh;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rail-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--g-primary, #fbbf24);
      animation: dot-pulse 1.2s ease-in-out infinite;
    }
    .dock .head {
      gap: 8px;
      padding: 12px 12px 10px 16px;
    }
    .dock .ident {
      flex: 1;
      min-width: 0;
      gap: 9px;
    }
    .dock .badge {
      width: 32px;
      height: 32px;
    }
    .dock .sw-trigger {
      max-width: 100%;
    }
    .dock .sw-pop {
      width: min(360px, calc(var(--acs-width, 420px) - 32px));
    }
    .model-picker {
      flex: 0 1 auto;
      min-width: 0;
      --mp-radius-sm: 10px;
    }
    .dock .sw-trigger .who small {
      display: none;
    }
    .head-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .dialog.integrated {
      position: relative;
      top: auto;
      left: auto;
      transform: none;
      width: 100%;
      height: 100%;
      min-height: 420px;
      border-radius: 18px;
      animation: none;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #fbbf24) 4%, rgba(9, 8, 13, 0.0)) 0%, transparent 8%),
        linear-gradient(160deg, color-mix(in srgb, var(--g-primary, #fbbf24) 5%, rgba(14, 13, 18, 0.0)) 0%, rgba(9, 8, 13, 0.0) 55%),
        rgba(9, 8, 13, 0.72);
      backdrop-filter: blur(24px) saturate(180%) brightness(1.03);
      -webkit-backdrop-filter: blur(24px) saturate(180%) brightness(1.03);
      box-shadow: none;
    }
    .dialog.integrated .dialog-aurora {
      display: none;
    }
    .dialog.integrated::before {
      content: "";
      position: absolute;
      top: 0;
      left: 10%;
      right: 10%;
      height: 1px;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent), transparent);
      opacity: 0.6;
      pointer-events: none;
    }

    @keyframes dock-in {
      from {
        opacity: 0;
        transform: translateX(24px);
      }
    }

    /* Aurora edge light — animated conic sweep */
    .dialog-aurora {
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      z-index: 0;
      background: conic-gradient(
        from var(--aurora-angle, 0deg) at 50% 50%,
        color-mix(in srgb, var(--g-primary, #fbbf24) 0%, transparent) 0deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent) 60deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 0%, transparent) 120deg,
        transparent 180deg,
        transparent 360deg
      );
      mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      -webkit-mask-composite: destination-out;
      padding: 1px;
      opacity: 0.7;
      animation: aurora-spin 8s linear infinite;
      pointer-events: none;
    }

    @keyframes aurora-spin {
      from { --aurora-angle: 0deg; }
      to   { --aurora-angle: 360deg; }
    }

    /* ── Header ───────────────────────────────────────────────────────── */
    .head {
      position: relative;
      /* Above .log so the agent switcher popover isn't painted over. */
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 18px 14px;
      /* Seamless gradient into glass — no visible divider */
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--g-primary, #fbbf24) 9%, transparent) 0%,
        transparent 100%
      );
    }

    /* Subtle hairline separator baked via a pseudo-element so it can glow */
    .head::after {
      content: "";
      position: absolute;
      bottom: 0;
      left: 14px;
      right: 14px;
      height: 1px;
      background: linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent) 40%,
        color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent) 60%,
        transparent
      );
    }

    .ident {
      display: flex;
      align-items: center;
      gap: 13px;
    }

    .badge {
      display: grid;
      place-items: center;
      width: 40px;
      height: 40px;
      border-radius: 13px;
      background: transparent;
      box-shadow: none;
      flex-shrink: 0;
      overflow: hidden;
    }

    .logo-badge {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .empty-logo {
      width: 52px;
      height: 52px;
      filter: drop-shadow(0 0 14px color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent));
    }

    .who strong {
      display: block;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }

    .who small {
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 50%, transparent);
      font-size: 11px;
    }

    .close {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 6%, transparent);
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 60%, transparent);
      transition: background 0.15s, color 0.15s, box-shadow 0.15s;
    }

    .close:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      color: var(--g-primary, #fbbf24);
      box-shadow: 0 0 12px -4px var(--g-primary, #fbbf24);
    }

    /* ── Log ──────────────────────────────────────────────────────────── */
    .log {
      position: relative;
      z-index: 1;
      flex: 1;
      overflow-y: auto;
      padding: 20px 18px;
      display: flex;
      flex-direction: column;
      gap: 13px;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent) transparent;
    }

    .log::-webkit-scrollbar {
      width: 5px;
    }

    .log::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent);
      border-radius: 999px;
    }

    /* ── Bubbles ──────────────────────────────────────────────────────── */
    .bubble {
      max-width: 86%;
      padding: 12px 15px;
      border-radius: 16px;
      font-size: 13.5px;
      line-height: 1.58;
      white-space: pre-wrap;
      word-break: break-word;
      animation: bubble-in 0.2s ease both;
    }

    @keyframes bubble-in {
      from { opacity: 0; transform: translateY(6px); }
    }

    .bubble.user {
      align-self: flex-end;
      background: linear-gradient(
        135deg,
        var(--g-primary, #fbbf24) 0%,
        #f59e0b 100%
      );
      color: #0a0a0e;
      font-weight: 500;
      border-bottom-right-radius: 5px;
      box-shadow:
        0 6px 20px -8px var(--g-primary, #fbbf24),
        0 0 28px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }

    .bubble.cmo {
      align-self: flex-start;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, rgba(10, 10, 14, 0.6));
      border: none;
      border-radius: 16px;
      border-bottom-left-radius: 5px;
      /* Subtle gold edge via box-shadow */
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent),
        inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
    }

    .bubble.stream {
      /* Slightly brighter glow while streaming */
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent),
        0 0 16px -6px color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent),
        inset 0 1px 0 color-mix(in srgb, #fff 5%, transparent);
    }

    .bubble.err {
      align-self: flex-start;
      background: rgba(239, 68, 68, 0.1);
      box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.35);
      color: #fca5a5;
      font-size: 12.5px;
    }

    /* ── Agent-invokable panels (shared <chat-panel-card>) ─────────────── */
    .panel-item {
      align-self: stretch;
      min-width: 0;
      max-width: 100%;
    }

    /* ── Tool pills ───────────────────────────────────────────────────── */
    .tool {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 86%;
      padding: 6px 12px;
      font-size: 11.5px;
      letter-spacing: 0.03em;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 90%, #fff);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, rgba(10, 10, 14, 0.5));
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent),
        0 0 10px -4px color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
      border-radius: 999px;
      animation: bubble-in 0.18s ease both;
    }

    .tool.result {
      opacity: 0.65;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
      background: transparent;
      box-shadow: none;
    }

    .tool-check {
      font-size: 10px;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent);
    }

    .tool code {
      font-size: 10px;
      opacity: 0.65;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: "JetBrains Mono", "Fira Code", monospace;
    }

    .tspark {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--g-primary, #fbbf24);
      box-shadow:
        0 0 8px var(--g-primary, #fbbf24),
        0 0 14px color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
      animation: dot-pulse 1.1s ease-in-out infinite;
    }

    /* ── In-flight tool cards (loading → done pill / result panel) ──── */
    .tool-run {
      position: relative;
      flex-shrink: 0;
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: 9px;
      max-width: 100%;
      padding: 11px 13px 12px;
      overflow: hidden;
      border-radius: 14px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 92%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 6%, rgba(10, 10, 14, 0.55));
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent),
        0 6px 22px -14px color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
      animation: tool-run-in 0.28s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    /* Shimmer sweep across the whole card. */
    .tool-run::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(
        100deg,
        transparent 30%,
        color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent) 50%,
        transparent 70%
      );
      background-size: 220% 100%;
      animation: tool-shimmer 1.8s linear infinite;
    }
    .tool-run__head {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      font-size: 12.5px;
    }
    .tool-run__spinner {
      flex-shrink: 0;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--g-primary, #fbbf24) 22%, transparent);
      border-top-color: var(--g-primary, #fbbf24);
      box-shadow: 0 0 10px -2px color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent);
      animation: spin 0.8s linear infinite;
    }
    .tool-run__label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .tool-run__dots::after {
      content: "…";
      display: inline-block;
      width: 1.2em;
      text-align: left;
      animation: tool-dots 1.2s steps(4, end) infinite;
      overflow: hidden;
      vertical-align: bottom;
    }
    .tool-run__tag {
      flex-shrink: 0;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--g-primary, #fbbf24);
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }
    .tool-run__time {
      flex-shrink: 0;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
    }
    /* Skeleton of the image / video being generated. */
    .tool-run__canvas {
      position: relative;
      flex-shrink: 0;
      display: grid;
      place-items: center;
      width: min(100%, 260px);
      aspect-ratio: 4 / 5;
      border-radius: 11px;
      overflow: hidden;
      background:
        radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent), transparent 60%),
        radial-gradient(circle at 75% 80%, color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent), transparent 55%),
        color-mix(in srgb, var(--g-fg, #f5f5f4) 4%, rgba(10, 10, 14, 0.6));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      animation: tool-breathe 2.4s ease-in-out infinite;
    }
    .tool-run--video .tool-run__canvas {
      width: 100%;
      aspect-ratio: 16 / 9;
    }
    .tool-run__glyph {
      font-size: 22px;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 75%, transparent);
      text-shadow: 0 0 16px var(--g-primary, #fbbf24);
      animation: tool-glyph 2.4s ease-in-out infinite;
    }
    .tool-run__bar {
      position: relative;
      height: 3px;
      border-radius: 999px;
      overflow: hidden;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
    }
    .tool-run__bar > span {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: inherit;
      background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent), var(--g-primary, #fbbf24));
      box-shadow: 0 0 8px var(--g-primary, #fbbf24);
      transition: width 0.9s ease;
    }
    .tool-run__bar--indeterminate > span {
      width: 38%;
      animation: tool-indeterminate 1.3s ease-in-out infinite;
    }
    .tool-run__hint {
      font-size: 11px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
    }
    .tool-done {
      flex-shrink: 0;
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 5px 11px;
      font-size: 11.5px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 62%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 4%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      animation: tool-settle 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    .tool-done__mark {
      display: grid;
      place-items: center;
      width: 15px;
      height: 15px;
      font-size: 9px;
      font-weight: 700;
      border-radius: 50%;
      color: #0a0a0e;
      background: var(--g-primary, #fbbf24);
    }
    .tool-done--error .tool-done__mark {
      background: #f87171;
    }
    .tool-done--error {
      color: #fca5a5;
    }
    .tool-done__time {
      font-size: 10.5px;
      font-variant-numeric: tabular-nums;
      opacity: 0.7;
    }
    /* Result cards fade up into place under the settled pill. */
    .panel-item {
      animation: tool-result-in 0.36s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    }
    @keyframes tool-run-in {
      from { opacity: 0; transform: translateY(6px) scale(0.98); }
    }
    @keyframes tool-shimmer {
      from { background-position: 120% 0; }
      to { background-position: -120% 0; }
    }
    @keyframes tool-dots {
      from { width: 0; }
      to { width: 1.2em; }
    }
    @keyframes tool-breathe {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.18); }
    }
    @keyframes tool-glyph {
      0%, 100% { transform: scale(1); opacity: 0.75; }
      50% { transform: scale(1.12); opacity: 1; }
    }
    @keyframes tool-indeterminate {
      from { left: -40%; }
      to { left: 100%; }
    }
    @keyframes tool-settle {
      from { opacity: 0; transform: scale(0.94); }
    }
    @keyframes tool-result-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
    }

    /* ── Streaming / typing indicators ───────────────────────────────── */
    .caret {
      display: inline-block;
      width: 2px;
      height: 15px;
      margin-left: 3px;
      vertical-align: text-bottom;
      background: var(--g-primary, #fbbf24);
      border-radius: 1px;
      box-shadow: 0 0 8px var(--g-primary, #fbbf24);
      animation: caret-blink 0.9s steps(2) infinite;
    }

    @keyframes caret-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0; }
    }

    .typing {
      align-self: flex-start;
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding: 13px 16px;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, rgba(10, 10, 14, 0.5));
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 14%, transparent);
      border-radius: 16px;
      border-bottom-left-radius: 5px;
    }

    .typing span {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--g-primary, #fbbf24);
      box-shadow: 0 0 6px var(--g-primary, #fbbf24);
      opacity: 0.4;
      animation: bounce 1.3s ease infinite;
    }

    .typing span:nth-child(2) { animation-delay: 0.16s; }
    .typing span:nth-child(3) { animation-delay: 0.32s; }

    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.35; }
      30% { transform: translateY(-5px); opacity: 1; }
    }

    /* ── Empty state ──────────────────────────────────────────────────── */
    .empty {
      margin: auto;
      text-align: center;
      max-width: 440px;
      padding: 24px 16px;
    }

    .empty-icon {
      display: flex;
      justify-content: center;
      margin-bottom: 16px;
      filter: drop-shadow(0 0 12px color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent));
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-6px); }
    }

    .empty-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--g-primary, #fbbf24);
      text-shadow: 0 0 20px color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent);
    }

    .empty-sub {
      margin-top: 7px;
      font-size: 13px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
      line-height: 1.6;
    }

    .chips {
      margin-top: 20px;
      display: flex;
      flex-wrap: wrap;
      gap: 9px;
      justify-content: center;
    }

    .chip {
      padding: 8px 14px;
      font-size: 12px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 80%, transparent);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 4%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
      border-radius: 999px;
      transition:
        background 0.16s ease,
        box-shadow 0.16s ease,
        color 0.16s ease,
        transform 0.16s ease;
    }

    .chip:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 38%, transparent),
        0 0 16px -4px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
      color: var(--g-primary, #fbbf24);
      transform: translateY(-1px);
    }

    .chip::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent), transparent 50%, color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent));
      mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      -webkit-mask-composite: destination-out;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }

    .chip:hover::before {
      opacity: 1;
    }

    .chip {
      position: relative;
    }

    /* ── Markdown body styling inside CMO bubbles ─────────────────────── */
    .md-body {
      /* Rendered markdown owns its line breaks — pre-wrap would add blank lines. */
      white-space: normal;
      font-size: 13.5px;
      line-height: 1.62;
    }
    .md-body p { margin: 0 0 10px; }
    .md-body p:last-child { margin-bottom: 0; }
    .md-body strong { color: var(--g-primary, #fbbf24); font-weight: 700; }
    .md-body em { font-style: italic; opacity: 0.85; }
    .md-body h1, .md-body h2, .md-body h3, .md-body h4 {
      color: var(--g-primary, #fbbf24);
      font-weight: 700;
      margin: 14px 0 8px;
      line-height: 1.3;
    }
    .md-body h1 { font-size: 16px; }
    .md-body h2 { font-size: 15px; }
    .md-body h3 { font-size: 14px; }
    .md-body h4 { font-size: 13px; opacity: 0.9; }
    .md-body ul, .md-body ol { margin: 8px 0; padding-left: 20px; }
    .md-body li { margin: 4px 0; }
    .md-body ul li::marker { color: color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent); }
    .md-body ol li::marker { color: color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent); }
    .md-body code {
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
      color: var(--g-primary, #fbbf24);
    }
    .md-body pre {
      margin: 10px 0;
      padding: 12px 14px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.35);
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .md-body pre code {
      background: none;
      padding: 0;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 85%, transparent);
      font-size: 12px;
      line-height: 1.5;
    }
    .md-body blockquote {
      margin: 10px 0;
      padding: 8px 14px;
      border-left: 2px solid color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 5%, transparent);
      border-radius: 0 8px 8px 0;
      opacity: 0.9;
    }
    .md-body a {
      color: var(--g-primary, #fbbf24);
      text-decoration: none;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
      transition: border-color 0.15s;
    }
    .md-body a:hover { border-bottom-color: var(--g-primary, #fbbf24); }

    .md-body a.reel-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 8px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .md-body a.reel-link:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 15%, transparent);
      border-color: var(--g-primary, #fbbf24);
      box-shadow: 0 0 10px -4px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
    }
    .md-body a.reel-link::before {
      content: "▶";
      font-size: 8px;
      opacity: 0.7;
    }
    .md-body td a.reel-link, .md-body th a.reel-link {
      font-size: 11px;
    }
    .md-body hr {
      border: none;
      height: 1px;
      background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent), transparent);
      margin: 14px 0;
    }
    .md-body table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12px; }
    .md-body th, .md-body td { padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--g-fg, #f5f5f4) 12%, transparent); text-align: left; }
    .md-body th { color: var(--g-primary, #fbbf24); font-weight: 600; }

    /* ── Script card ────────────────────────────────────────────────── */
    .script-card {
      margin: 12px 0;
      border-radius: 14px;
      background: linear-gradient(160deg, rgba(14, 13, 18, 0.9), rgba(9, 8, 13, 0.92));
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      overflow: hidden;
      position: relative;
      animation: bubble-in 0.22s ease both;
    }
    .script-card::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(135deg, var(--g-primary, #fbbf24), transparent 40%, transparent 60%, color-mix(in srgb, var(--g-primary, #fbbf24) 50%, transparent));
      mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      -webkit-mask-composite: destination-out;
      pointer-events: none;
    }
    .script-card::after {
      content: "";
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      box-shadow: 0 0 24px -8px color-mix(in srgb, var(--g-primary, #fbbf24) 35%, transparent);
      pointer-events: none;
    }
    .script-card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent), transparent);
      position: relative;
      z-index: 1;
    }
    .script-card-icon {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: linear-gradient(135deg, var(--g-primary, #fbbf24), #f59e0b);
      color: #0a0a0e;
      flex-shrink: 0;
    }
    .script-card-label {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--g-primary, #fbbf24);
    }
    .script-copy {
      margin-left: auto;
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 7px;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, transparent);
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 60%, transparent);
      border: none;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .script-copy:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 15%, transparent);
      color: var(--g-primary, #fbbf24);
    }
    .script-card-body {
      margin: 0;
      padding: 12px 14px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 12px;
      line-height: 1.6;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 88%, transparent);
      background: rgba(0, 0, 0, 0.3);
      overflow-x: auto;
      position: relative;
      z-index: 1;
      scrollbar-width: thin;
    }
    .script-card-body::-webkit-scrollbar { width: 4px; height: 4px; }
    .script-card-body::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
      border-radius: 999px;
    }
    .script-card-body code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: inherit;
    }

    /* ── Video pill ─────────────────────────────────────────────────── */
    .video-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      margin: 8px 0;
      padding: 8px 14px 8px 10px;
      border-radius: 999px;
      text-decoration: none;
      background: linear-gradient(160deg, rgba(14, 13, 18, 0.85), rgba(9, 8, 13, 0.88));
      position: relative;
      animation: bubble-in 0.2s ease both;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .video-pill::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      padding: 1px;
      background: linear-gradient(135deg, var(--g-primary, #fbbf24), transparent 50%, color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent));
      mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      mask-composite: exclude;
      -webkit-mask: linear-gradient(#000, #000) content-box, linear-gradient(#000, #000);
      -webkit-mask-composite: destination-out;
      pointer-events: none;
    }
    .video-pill:hover {
      transform: translateY(-1px);
      box-shadow: 0 0 20px -6px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent);
    }
    .video-pill-play {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--g-primary, #fbbf24), #f59e0b);
      color: #0a0a0e;
      flex-shrink: 0;
    }
    .video-pill-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--g-primary, #fbbf24);
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .video-pill-url {
      font-size: 11px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Composer ─────────────────────────────────────────────────────── */
    .composer {
      position: relative;
      z-index: 1;
      display: flex;
      gap: 10px;
      align-items: flex-end;
      padding: 12px 16px 14px;
      /* No hard border — soft gradient top edge */
      background: linear-gradient(
        180deg,
        transparent 0%,
        color-mix(in srgb, #000 28%, transparent) 100%
      );
    }

    /* Glow hairline separator above composer */
    .composer::before {
      content: "";
      position: absolute;
      top: 0;
      left: 14px;
      right: 14px;
      height: 1px;
      background: linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent) 40%,
        color-mix(in srgb, var(--g-primary, #fbbf24) 20%, transparent) 60%,
        transparent
      );
    }

    .composer textarea {
      flex: 1;
      resize: none;
      max-height: 140px;
      padding: 12px 14px;
      font: inherit;
      font-size: 13.5px;
      color: var(--g-fg, #f5f5f4);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, rgba(10, 10, 14, 0.4));
      border: none;
      border-radius: 14px;
      outline: none;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-fg, #f5f5f4) 10%, transparent);
      transition: box-shadow 0.2s ease;
      line-height: 1.5;
    }

    .composer textarea::placeholder {
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 35%, transparent);
    }

    .composer textarea:focus {
      box-shadow:
        0 0 0 1.5px color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent),
        0 0 20px -6px color-mix(in srgb, var(--g-primary, #fbbf24) 38%, transparent);
    }

    .send {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 13px;
      color: #0a0a0e;
      background: linear-gradient(135deg, var(--g-primary, #fbbf24), #f59e0b);
      box-shadow:
        0 0 14px -4px var(--g-primary, #fbbf24),
        0 0 30px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
      transition:
        opacity 0.15s ease,
        transform 0.15s ease,
        box-shadow 0.15s ease;
      flex-shrink: 0;
    }

    .send:not(:disabled):hover {
      transform: translateY(-1px) scale(1.05);
      box-shadow:
        0 0 22px -4px var(--g-primary, #fbbf24),
        0 0 44px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }

    .send:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .send-spinner {
      display: block;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid rgba(10, 10, 14, 0.3);
      border-top-color: #0a0a0e;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* ── Brand logo (stock logo: crop transparent margins, as grouped.css) ── */
    img.chat-logo-avatar {
      object-fit: contain;
      user-select: none;
    }
    img.chat-logo-avatar--mark {
      object-view-box: inset(18% 21% 23% 20.5%);
    }

    /* ── Log top: scroll-back + load states ───────────────────────────── */
    .log-state,
    .log-start {
      align-self: center;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      justify-content: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 11.5px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
      text-align: center;
    }
    .log-state.err {
      color: #fca5a5;
    }
    .log-start {
      font-size: 10.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
    }
    .send-spinner.log-spinner {
      width: 12px;
      height: 12px;
      border-color: color-mix(in srgb, var(--g-primary, #fbbf24) 25%, transparent);
      border-top-color: var(--g-primary, #fbbf24);
    }
    .log-older,
    .log-retry {
      align-self: center;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--g-primary, #fbbf24);
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 8%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 24%, transparent);
    }
    .log-older:hover,
    .log-retry:hover {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
    }

    /* ── Agent switcher ───────────────────────────────────────────────── */
    .switcher {
      position: relative;
      min-width: 0;
    }
    .sw-trigger {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
      max-width: min(420px, 60vw);
      padding: 6px 12px 6px 6px;
      border-radius: 14px;
      text-align: left;
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 4%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 16%, transparent);
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .sw-trigger:hover,
    .sw-trigger[aria-expanded="true"] {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, transparent);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 36%, transparent),
        0 0 16px -6px color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
    }
    .sw-trigger:focus-visible,
    .close:focus-visible,
    .chip:focus-visible,
    .send:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--g-primary, #fbbf24) 70%, transparent);
      outline-offset: 2px;
    }
    .sw-trigger .who {
      min-width: 0;
    }
    .sw-trigger .who strong,
    .sw-trigger .who small {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chev {
      flex-shrink: 0;
      color: var(--g-primary, #fbbf24);
      transition: transform 0.15s ease;
    }
    .sw-trigger[aria-expanded="true"] .chev {
      transform: rotate(180deg);
    }
    .glyph {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      flex-shrink: 0;
      border-radius: 9px;
      font-size: 17px;
      line-height: 1;
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 10%, rgba(10, 10, 14, 0.6));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 18%, transparent);
      overflow: hidden;
    }
    .glyph-logo {
      padding: 3px;
    }
    .sw-pop {
      box-sizing: border-box;
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 5;
      width: min(360px, calc(100vw - 48px));
      display: flex;
      flex-direction: column;
      padding: 8px;
      border-radius: 16px;
      background: rgba(12, 11, 16, 0.97);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--g-primary, #fbbf24) 24%, transparent),
        0 0 30px -10px color-mix(in srgb, var(--g-primary, #fbbf24) 40%, transparent),
        0 24px 60px -16px rgba(0, 0, 0, 0.85);
      animation: bubble-in 0.16s ease both;
    }
    .sw-search {
      padding: 9px 12px;
      margin-bottom: 6px;
      font: inherit;
      font-size: 13px;
      color: var(--g-fg, #f5f5f4);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, rgba(10, 10, 14, 0.4));
      border: none;
      border-radius: 10px;
      outline: none;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-fg, #f5f5f4) 10%, transparent);
    }
    .sw-search:focus {
      box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--g-primary, #fbbf24) 55%, transparent);
    }
    .sw-list {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: min(340px, 50vh);
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--g-primary, #fbbf24) 28%, transparent) transparent;
    }
    .sw-opt {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 8px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 13px;
    }
    .sw-opt.active {
      background: color-mix(in srgb, var(--g-primary, #fbbf24) 12%, transparent);
    }
    .sw-opt.current .sw-name {
      color: var(--g-primary, #fbbf24);
      font-weight: 700;
    }
    .sw-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sw-model {
      max-width: 45%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10.5px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 45%, transparent);
    }
    .sw-empty {
      padding: 12px 8px;
      font-size: 12px;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 50%, transparent);
    }

    /* ── Mobile: full-width sheet (no resize; collapse still works) ─────── */
    @media (max-width: 600px) {
      :host(:not([integrated])) {
        left: 0;
        width: 100vw;
      }
      :host([data-collapsed]:not([integrated])) {
        left: auto;
        width: var(--acs-width, 28px);
      }
      .dialog:not(.integrated) {
        border-radius: 0;
        padding-bottom: env(safe-area-inset-bottom, 0px);
        animation-name: sheet-in;
      }
      .dock-resize {
        display: none;
      }
      .sw-trigger {
        max-width: calc(100vw - 150px);
      }
      .head {
        padding: 12px 12px 10px;
      }
      .ident {
        gap: 9px;
        min-width: 0;
      }
      .badge {
        width: 32px;
        height: 32px;
      }
      .sw-pop {
        left: -41px;
        width: calc(100vw - 24px);
      }
      /* The agent glyph already carries the brand mark; the room goes to the model picker. */
      .dock .badge {
        display: none;
      }
      .dock .sw-pop {
        left: 0;
      }
      .dock .switcher {
        flex: 0 1 auto;
      }
      .model-picker {
        flex: 0 0 auto;
      }
    }
    @keyframes sheet-in {
      from {
        opacity: 0;
        transform: translateY(24px);
      }
    }

    /* ── Premium glass layer (styles/glass, docs/ui/GLASS.md) ───────────
       Reads the global --glass-* tokens (they pierce the shadow root) so the
       dock follows theme, palette, reduced-transparency and reduced-motion.
       The dock is now real frosted glass (translucent fill + one blur), the
       assistant bubble is glass and the user bubble is a solid gold tint —
       the same recipe as /webchat and the grid panels. */
    :host { font-family: var(--glass-font, inherit); }
    .dialog {
      background:
        var(--glass-sheen),
        linear-gradient(160deg, var(--glass-gold-a06) 0%, transparent 45%),
        var(--glass-4, rgb(9, 8, 13));
      backdrop-filter: var(--glass-blur-lg, blur(28px) saturate(200%));
      -webkit-backdrop-filter: var(--glass-blur-lg, blur(28px) saturate(200%));
      box-shadow:
        0 0 0 1px var(--glass-stroke-gold),
        0 0 48px -14px var(--glass-gold-a40),
        var(--glass-elev-4);
      color: var(--glass-fg);
    }
    .dialog-aurora { opacity: 0.45; }
    .who strong { font-family: var(--font-ui-display, inherit); letter-spacing: -0.01em; color: var(--glass-fg); }
    .who small { color: var(--glass-fg-3); }
    .bubble {
      font-size: 13.5px;
      letter-spacing: -0.003em;
      border-radius: 18px;
      animation: bubble-in var(--glass-dur-slow, 0.3s) var(--glass-spring, ease) both;
    }
    .bubble.user {
      background: var(--glass-gold-tint);
      color: var(--glass-fg);
      font-weight: 450;
      border-bottom-right-radius: 6px;
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--glass-gold) 36%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 12px 28px -16px var(--glass-gold-a40);
    }
    .bubble.cmo {
      background: var(--glass-sheen), var(--glass-3);
      border-bottom-left-radius: 6px;
      color: var(--glass-fg);
      box-shadow:
        0 0 0 1px var(--glass-stroke),
        var(--glass-elev-1);
    }
    .bubble.stream {
      box-shadow:
        0 0 0 1px var(--glass-stroke-gold),
        0 0 22px -8px var(--glass-gold-a40),
        var(--glass-specular);
    }
    .md-body strong { color: var(--glass-gold); }
    :host-context([data-theme="light"]) .md-body strong { color: var(--glass-gold-deep); }
    .md-body code { font-family: var(--glass-font-mono); background: var(--glass-gold-a10); border: 1px solid var(--glass-stroke-gold); color: var(--glass-gold-hi); border-radius: 6px; }
    :host-context([data-theme="light"]) .md-body code { color: var(--glass-gold-deep); }
    .md-body table { border-collapse: separate; border-spacing: 0; border: 1px solid var(--glass-stroke); border-radius: 10px; overflow: hidden; font-variant-numeric: tabular-nums; }
    .md-body th, .md-body td { border: 0; border-bottom: 1px solid var(--glass-stroke); }
    .md-body tr:last-child td { border-bottom: 0; }
    .md-body th { background: var(--glass-hover); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; }
    .tool {
      color: var(--glass-fg-2);
      background: var(--glass-sheen), var(--glass-2);
      box-shadow: 0 0 0 1px var(--glass-stroke-gold), var(--glass-specular), 0 0 14px -6px var(--glass-gold-a40);
      font-family: var(--glass-font-mono);
      letter-spacing: 0;
    }
    .tool.result { color: var(--glass-fg-3); }
    .tool-done { font-family: var(--glass-font); }
    .composer {
      background: linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--glass-base) 30%, transparent) 100%);
    }
    .composer textarea {
      font-family: var(--glass-font);
      color: var(--glass-fg);
      background: var(--glass-sheen), var(--glass-2);
      border-radius: 16px;
      box-shadow: 0 0 0 1px var(--glass-stroke-strong), var(--glass-elev-1);
      transition: box-shadow var(--glass-dur, 0.2s) var(--glass-ease, ease);
    }
    .composer textarea::placeholder { color: var(--glass-fg-4); }
    .composer textarea:focus {
      box-shadow: var(--glass-focus-ring), 0 0 36px -12px var(--glass-gold-a40), var(--glass-elev-1);
    }
    .send {
      background: var(--glass-gold-fill);
      color: var(--glass-ink);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 8px 20px -8px var(--glass-gold-a40);
      transition: transform var(--glass-dur-fast, 0.14s) var(--glass-spring, ease), box-shadow var(--glass-dur, 0.2s);
    }
    .send:not(:disabled):hover { transform: translateY(-1px) scale(1.04); }
    .send:not(:disabled):active { transform: scale(0.95); }
    .sw-pop {
      background: var(--glass-sheen), var(--glass-4);
      backdrop-filter: var(--glass-blur-lg, none);
      -webkit-backdrop-filter: var(--glass-blur-lg, none);
      border: 1px solid var(--glass-stroke-strong);
      box-shadow: var(--glass-elev-4);
    }
    .sw-trigger { border-radius: var(--glass-radius-sm, 10px); }
    .chip {
      background: var(--glass-sheen), var(--glass-2);
      box-shadow: 0 0 0 1px var(--glass-stroke), var(--glass-elev-1);
      transition: transform var(--glass-dur, 0.2s) var(--glass-spring, ease), box-shadow var(--glass-dur, 0.2s);
    }
    .chip:hover { transform: var(--glass-lift, translateY(-1px)); box-shadow: 0 0 0 1px var(--glass-stroke-gold), var(--glass-elev-2), var(--glass-glow-soft); }

    /* ── Reduced-motion overrides ─────────────────────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      .tspark,
      .dialog,
      .rail-dot,
      .dialog-aurora,
      .empty-icon,
      .typing span,
      .caret,
      .send-spinner,
      .tool-run,
      .tool-run::after,
      .tool-run__spinner,
      .tool-run__dots::after,
      .tool-run__canvas,
      .tool-run__glyph,
      .tool-run__bar > span,
      .tool-done,
      .panel-item {
        animation: none !important;
        transition: none !important;
      }
    }
    /* ── Group chat in the dock (chat follows navigation) ─────────────── */
    .dock-group {
      flex: 1 1 auto;
      min-height: 0;
      display: block;
      position: relative;
      z-index: 1;
    }

    /* ── Secure Mode row + composer ring ──────────────────────────────── */
    .acm-sec-row {
      position: relative;
      z-index: 2;
      padding: 6px 16px 0;
    }
    .composer.composer--secure textarea {
      box-shadow: 0 0 0 1px var(--ib-secure-ring, rgba(52, 211, 153, 0.5)), var(--ib-secure-glow, none);
    }
    .composer.composer--secure::before {
      background: linear-gradient(90deg, transparent, var(--ib-secure-ring, rgba(52, 211, 153, 0.5)), transparent);
    }
  `, chatSpeechStyles, secureSurfaceStyles];
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-chat-modal": AgentChatModal;
  }
}
