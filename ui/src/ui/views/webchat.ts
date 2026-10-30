/**
 * <webchat-view> — full-page, Open WebUI-style chat surface (/webchat).
 *
 * Deliberately has NO backend of its own. Everything rides the same gateway
 * plumbing the grid chat uses:
 *   - transcript:   controllers/chat.ts (loadChatHistory / sendChatMessage /
 *                   abortChatRun / handleChatEvent) against a local ChatState
 *   - tool stream:  app-tool-stream.ts handleAgentEvent ("agent" events)
 *   - sessions:     sessions.list / sessions.patch (label, pinned) /
 *                   sessions.delete — the gateway session store, so chats
 *                   survive reloads and gateway restarts
 *   - roster:       agents.list
 *
 * The selected session lives in the URL (/webchat/<sessionKey>); only the
 * sidebar-collapsed flag touches localStorage.
 *
 * Sidebar layout tiers (viewport width):
 *   wide   >= 1280  full list; width follows the main nav (narrower while the
 *                   main nav is expanded, roomier when it's collapsed)
 *   mid    800–1279 slim icon rail by default
 *   mobile < 800    off-canvas drawer with backdrop
 * A manual toggle overrides the default per tier and is persisted.
 */
import { loadSessionContextBinding } from "../features/group_chat/group-context-ui";
import type { GroupChatBinding } from "../../../../src/shared/group-chat/types.js";
import { sanitizeIdentityEmoji } from "../../../../src/shared/identity-emoji.js";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow, SessionsListResult } from "../types";
import type { ChatAttachment } from "../ui-types";
import {
  abortChatRun,
  handleChatEvent,
  handleChatNotice,
  loadChatHistory,
  sendChatMessage,
  type ChatEventPayload,
  type ChatState,
} from "../controllers/chat";
import { handleAgentEvent, resetToolStream, type AgentEventPayload, type ToolStreamEntry } from "../app-tool-stream";
import { extractText } from "../chat/message-extract";
import {
  GATEWAY_SESSIONS_CHANGED_EVENT,
  CHAT_SESSIONS_CHANGED_EVENT,
  agentIdFromKey,
  cleanUserText,
  deleteChatSession,
  fetchChatSessionsPage,
  isChatSessionKey,
  isSessionListEvent,
  newChatSessionKey,
  notifyChatSessionsChanged,
  relTime,
  sessionTitle,
  webchatPathForKey,
} from "../chat/chat-sessions";
import { toSanitizedMarkdownHtml } from "../markdown";
import { icons } from "../icons";
import { generateUUID } from "../uuid";
import "../components/webchat-model-picker";
import { announceSessionModel, onSessionModel } from "../session-model-sync";
import { renderBrandAvatar } from "../chat/brand-avatar";
import { extractPanelRef, renderChatPanelRef } from "../chat-panels";
import { formatAssistantTurnError } from "../chat-error-format";
import "../components/chat-call-button";
import "../chat/chat-view-controls";
import {
  applyZoomShortcut,
  chatViewStyleVars,
  loadChatViewPrefs,
  onChatViewPrefs,
  zoomShortcut,
  type ChatViewPrefs,
} from "../chat/chat-view-prefs";
import { isGroupChatKey } from "../../../../src/shared/group-chat/keys.js";
import "../features/group_chat/group-chat-view";
import "../features/group_chat/group-chat-dialog";
import {
  ensureSecureMode,
  getSecureState,
  isSecureSessionKey,
  LAST_NORMAL_SESSION_STORAGE_KEY,
  LAST_SECURE_SESSION_STORAGE_KEY,
  planSecureLaneSwitch,
  readStoredKey,
  SecureModeController,
  secureActive,
  setSecureChatSession,
  writeStoredKey,
} from "../secure-mode";
import type { GroupDialogValue } from "../features/group_chat/group-chat-dialog";
import { parseRuntimeStatusNotice, type RuntimeStatusNotice } from "../local-runtimes/store";
import {
  CHAT_ATTACHMENT_ACCEPT,
  isSupportedChatFile,
  normalizedFileMime,
  prepareChatAttachment,
  type AttachmentPreparationProgress,
} from "../chat/attachments";
import {
  handleSnippetCopy,
  markdownToPlainText,
  withSnippetCopyButtons,
} from "../chat/snippet-copy";
import "../components/chat-attachment-chip";
import "../components/response-actions";
import "../components/chat-subscription-card";
import { isSubscriptionCode, type CliRoutingStatus } from "../controllers/cli-routing";
import {
  AGENT_ROUTE,
  CLI_BACKENDS,
  CLI_LABELS,
  ROUTE_COMMAND_HINTS,
  adoptDraftRoute,
  backendInfoFromRouting,
  claudeBridgeNotice,
  folderName,
  messageRoute,
  parseRoute,
  parseRouteCommand,
  readLastCli,
  readRecentFolders,
  readRoute,
  rememberFolder,
  routeId,
  writeRoute,
  type ChatRoute,
  type CliBackendId,
  type CliBackendInfo,
  type RouteId,
} from "../chat/chat-route";
import { cliLogo } from "../chat/cli-logos";
import "../components/chat-mode-switcher";
import type { ChatModeSwitcher, SwitcherFolder } from "../components/chat-mode-switcher";
import {
  completeFirstChat,
  firstChatDemo,
  markFirstChatSent,
  readFirstChat,
  type FirstChatHandoff,
} from "../onboarding/first-chat";

const COLLAPSE_KEY = "infinibot.webchat.sidebarCollapsed";
/** Threads whose gateway `/claude` bridge we switched on, with its folder (CLI fallback path). */
const LEGACY_BRIDGE_PREFIX = "infinibot.chat.claudeBridge.";

function readLegacyBridge(key: string): string | null {
  try {
    return localStorage.getItem(LEGACY_BRIDGE_PREFIX + key);
  } catch {
    return null;
  }
}

function writeLegacyBridge(key: string, cwd: string | null) {
  try {
    if (cwd) localStorage.setItem(LEGACY_BRIDGE_PREFIX + key, cwd);
    else localStorage.removeItem(LEGACY_BRIDGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Subscription CLI provider → the account name beginners know it by. */
const CLI_ACCOUNT_NAMES: Record<string, string> = {
  "claude-cli": "Claude",
  "codex-cli": "ChatGPT",
  "gemini-cli": "Google account",
  "grok-cli": "Grok",
  "opencode-cli": "OpenCode",
};

function accountForModel(ref: string | null | undefined): string | null {
  const provider = ref?.split("/")[0]?.trim().toLowerCase();
  return (provider && CLI_ACCOUNT_NAMES[provider]) || null;
}
const COLLAPSE_KEY_MID = "infinibot.webchat.sidebarCollapsed.mid";
const MOBILE_BP = 800;
const WIDE_BP = 1280;

type Tier = "wide" | "mid" | "mobile";

function readPref(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

/** body `zoom` from styles/viewport-scale.css (0.7 on laptops); widths are compensated so they read true on screen. */
function bodyZoom(): number {
  const z = parseFloat(getComputedStyle(document.body).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

function currentTier(): Tier {
  const w = window.innerWidth;
  return w < MOBILE_BP ? "mobile" : w < WIDE_BP ? "mid" : "wide";
}

const SUGGESTIONS = [
  { title: "Summarize my day", prompt: "Summarize what's on my plate today across tasks, projects and inbox." },
  { title: "Plan a feature", prompt: "Help me plan a new feature: ask me the key questions first." },
  { title: "Review my agents", prompt: "Which agents are running right now and what are they working on?" },
  { title: "Draft a message", prompt: "Draft a short, friendly follow-up message to a client." },
];

type ToolBlock = {
  id: string;
  name: string;
  args?: unknown;
  result?: string;
  pending?: boolean;
  /** Live run only: start / end times for the elapsed label. */
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
};
type Block =
  | { kind: "text"; text: string; notice?: boolean }
  | { kind: "tool"; tool: ToolBlock }
  /** A CLI turn's tool calls, folded into one collapsed row. */
  | { kind: "cli-tools"; tools: ToolBlock[] };
type Turn =
  | { role: "user"; id: string; text: string; images: string[]; route?: RouteId }
  | {
      role: "assistant";
      id: string;
      blocks: Block[];
      streaming?: boolean;
      model?: string;
      /** Gateway "took too long" note (model "turn-timeout") → Continue button. */
      timeoutNotice?: boolean;
      /** "agent" or the coding CLI that wrote this reply. */
      route?: RouteId;
      /** CLI-mode working folder. */
      cwd?: string;
    }
  /** "Switched to Codex" divider between turns that went to different targets. */
  | { role: "divider"; id: string; to: RouteId };

/** One CLI tool call as the gateway reports it (src/gateway/cli-chat/runner.ts). */
type CliToolWire = { id?: string; name?: string; input?: string; status?: string; output?: string };

function cliToolsToBlocks(raw: unknown): ToolBlock[] {
  if (!Array.isArray(raw)) return [];
  return (raw as CliToolWire[])
    .filter((t) => t && typeof t.name === "string" && t.name)
    .map((t, i) => ({
      id: String(t.id || `cli-tool-${i}`),
      name: String(t.name),
      args: t.input || undefined,
      result: typeof t.output === "string" ? t.output : undefined,
      pending: t.status === "running",
      isError: t.status === "error",
    }));
}

/** Gateway-synthesized turn-timeout note (src/agents/pi-embedded-runner/turn-timeout.ts). */
const TURN_TIMEOUT_MODEL = "turn-timeout";
const CONTINUE_PROMPT =
  "Continue from where you stopped. Use the tool results already gathered above and don't repeat those calls.";

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

type ToolHost = {
  sessionKey: string;
  chatRunId: string | null;
  toolStreamById: Map<string, ToolStreamEntry>;
  toolStreamOrder: string[];
  chatToolMessages: Record<string, unknown>[];
  toolStreamSyncTimer: number | null;
};

// ── helpers ───────────────────────────────────────────────────────────────

function readKeyFromUrl(): string | null {
  const m = /\/webchat(?:\/([^/?#]+))?\/?$/.exec(window.location.pathname);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function urlForKey(key: string | null): string {
  const path = window.location.pathname;
  const idx = path.indexOf("/webchat");
  const base = idx >= 0 ? path.slice(0, idx) : "";
  const url = new URL(window.location.href);
  url.pathname = webchatPathForKey(key, base);
  url.searchParams.delete("session");
  return url.toString();
}

function contentArray(msg: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
}

function toolResultText(msg: Record<string, unknown>): string {
  const t = extractText(msg);
  if (t) return t;
  const parts = contentArray(msg)
    .map((c) => (typeof c.text === "string" ? c.text : null))
    .filter(Boolean);
  return parts.join("\n");
}

function isToolCallItem(item: Record<string, unknown>): boolean {
  const kind = String(item.type ?? "").toLowerCase();
  return ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind);
}

function isToolResultMsg(m: Record<string, unknown>): boolean {
  const role = String(m.role ?? "").toLowerCase();
  if (role === "toolresult" || role === "tool_result" || role === "tool") return true;
  return typeof m.toolCallId === "string" && role !== "assistant" && role !== "user";
}

function formatArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function dayBucket(ts: number | null | undefined, now = new Date()): string {
  if (!ts) return "Older";
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (ts >= startToday) return "Today";
  if (ts >= startToday - day) return "Yesterday";
  if (ts >= startToday - 7 * day) return "Previous 7 days";
  if (ts >= startToday - 30 * day) return "Previous 30 days";
  return "Older";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

/** Markdown → sanitized HTML with a copy button bolted onto every code block. */
function renderMarkdown(text: string): string {
  return withSnippetCopyButtons(toSanitizedMarkdownHtml(text));
}

const pinIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V6h6v4.76a2 2 0 0 0 1.11 1.79l1.78.9A2 2 0 0 1 19 15.24V17H5v-1.76a2 2 0 0 1 1.11-1.79l1.78-.9A2 2 0 0 0 9 10.76z"/><path d="M8 6h8"/></svg>`;
const sidebarIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>`;

// ── element ───────────────────────────────────────────────────────────────

@customElement("webchat-view")
export class WebchatView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  /** Main app nav collapsed state (settings.navCollapsed) — drives the chats sidebar width. */
  @property({ type: Boolean }) navCollapsed = false;

  @state() private agents: GatewayAgentRow[] = [];
  /** First chat after onboarding: welcome + starters while the chat is empty. */
  @state() private firstChat: FirstChatHandoff | null = null;
  private firstChatIsDemo = false;
  /** A turn routed through the user's own AI account failed: friendly card with one fix. */
  @state() private subError: { code: string; message: string; text: string } | null = null;
  private lastSentText = "";
  /** Local GPU runtime swap for the current run ("Starting vLLM…"), shown instead of the dots. */
  @state() private runtimeStatus: RuntimeStatusNotice | null = null;
  private runtimeTick: ReturnType<typeof setInterval> | null = null;
  private runtimeClear: ReturnType<typeof setTimeout> | null = null;
  @state() private defaultAgentId = "main";
  /** Composer Agent | CLI target for the open thread (chat/chat-route.ts). */
  @state() private route: ChatRoute = AGENT_ROUTE;
  @state() private cliBackends: CliBackendInfo[] = [];
  @state() private cliFolders: SwitcherFolder[] = [];
  /** Tool calls the running CLI turn has reported so far. */
  @state() private cliLiveTools: ToolBlock[] = [];
  /** Backend of the running CLI turn (null = agent run / none). */
  private cliRunBackend: CliBackendId | null = null;
  private cliBackendsLoadedAt = 0;
  /** Gateway `/claude` bridge control replies we're waiting for (fallback CLI path). */
  private controlWaiters = new Map<string, () => void>();
  @state() private draftAgentId: string | null = null;
  @state() private sessions: GatewaySessionRow[] = [];
  @state() private sessionsLoading = false;
  @state() private sessionsLoaded = false;
  @state() private activeKey: string | null = null;
  @state() private search = "";
  /** Manual collapse override per tier (null = follow the tier default). */
  @state() private prefWide: boolean | null = null;
  @state() private prefMid: boolean | null = null;
  @state() private tier: Tier = "wide";
  @state() private drawerOpen = false;
  @state() private listScrolled = false;
  @state() private agentMenuOpen = false;
  @state() private agentFilter = "";
  @state() private renamingKey: string | null = null;
  @state() private renameValue = "";
  @state() private editingId: string | null = null;
  @state() private editValue = "";
  @state() private draft = "";
  @state() private attachments: ChatAttachment[] = [];
  @state() private toast: string | null = null;
  @state() private copiedId: string | null = null;
  /** 1 s clock while a run is live (tool elapsed + "Thinking… 1m20s"). */
  @state() private nowTick = Date.now();
  private tickTimer: number | null = null;
  /** Model / thinking picked for a not-yet-created chat (null = agent default). */
  @state() private draftModel: string | null = null;
  @state() private draftThinking: string | null = null;
  /** Gateway-wide default model ref (sessions.list defaults) — fallback when agents.list lacks `model`. */
  @state() private globalModel: string | null = null;
  /** "New group chat" dialog. */
  @state() private groupDialogOpen = false;
  @state() private groupDialogDefaults: GroupChatBinding | null = null;
  @state() private groupDialogBusy = false;
  @state() private groupDialogError: string | null = null;
  /** "New group chat" dialog opened as a Secure Mode group. */
  @state() private groupDialogSecure = false;
  /** Secure lane switch in flight / its inline error (composer toggle). */
  @state() private secureBusy = false;
  @state() private secureError: string | null = null;
  private secureWasActive = secureActive(getSecureState());
  private secureMode = new SecureModeController(this, {
    onChange: (s) => {
      const active = secureActive(s);
      // Secure chats join / leave the list as Secure Mode turns on / off.
      if (active !== this.secureWasActive) {
        this.secureWasActive = active;
        this.scheduleSessionsRefresh(150);
        if (!active) this.sessions = this.sessions.filter((r) => !isSecureSessionKey(r.key) || r.key === this.activeKey);
      }
    },
  });

  @query(".wc-scroll") private scroller?: HTMLElement;
  @query("textarea.wc-input") private input?: HTMLTextAreaElement;
  @query("input.wc-file") private fileInput?: HTMLInputElement;

  /** Local ChatState the shared chat controller mutates. */
  private chat: ChatState & Record<string, unknown> = {
    client: null,
    connected: false,
    sessionKey: "",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    lastError: null,
    requestUpdate: () => this.requestUpdate(),
  };

  /** Host for the shared tool-stream reducer; mirrors the chat state. */
  private toolHost: ToolHost = (() => {
    const self = this;
    let msgs: Record<string, unknown>[] = [];
    return {
      get sessionKey() {
        return self.chat.sessionKey;
      },
      get chatRunId() {
        return self.chat.chatRunId;
      },
      toolStreamById: new Map(),
      toolStreamOrder: [],
      get chatToolMessages() {
        return msgs;
      },
      set chatToolMessages(v: Record<string, unknown>[]) {
        msgs = v;
        self.requestUpdate();
      },
      toolStreamSyncTimer: null,
    } as ToolHost;
  })();

  private unsub: (() => void) | null = null;
  private subscribedClient: GatewayBrowserClient | null = null;
  private bootstrapped = false;
  private stickToBottom = true;
  private sessionsRefreshTimer: number | null = null;
  private toastTimer: number | null = null;
  private mqs: MediaQueryList[] = [];
  private multiAgent = false;
  private touchX: number | null = null;
  private touchDx = 0;

  private onPopState = () => {
    const key = readKeyFromUrl();
    if (key !== this.activeKey) this.openSession(key, { pushUrl: false });
  };
  private onMq = () => {
    this.tier = currentTier();
    this.style.setProperty("--wc-zoom", String(bodyZoom()));
    if (this.tier !== "mobile") this.drawerOpen = false;
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.drawerOpen) this.drawerOpen = false;
  };
  private onSessionsChanged = (e: Event) => {
    if ((e as CustomEvent<{ source?: string }>).detail?.source === "webchat") return;
    this.scheduleSessionsRefresh(200);
  };
  private onDocClick = (e: MouseEvent) => {
    if (!this.agentMenuOpen) return;
    const path = e.composedPath();
    const menu = this.renderRoot.querySelector(".wc-agent");
    if (menu && !path.includes(menu)) this.agentMenuOpen = false;
  };

  private unsubModelSync: (() => void) | null = null;
  /** Transcript width + text zoom (shared with group chats, per viewer). */
  @state() private viewPrefs: ChatViewPrefs = loadChatViewPrefs();
  private unsubViewPrefs: (() => void) | null = null;
  /** Ctrl/Cmd +/−/0 while focus is inside the chat → text zoom (not browser zoom). */
  private onZoomKey = (e: KeyboardEvent) => {
    const action = zoomShortcut(e);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    this.viewPrefs = applyZoomShortcut(action);
  };

  connectedCallback(): void {
    super.connectedCallback();
    const demo = firstChatDemo();
    this.firstChatIsDemo = Boolean(demo);
    this.firstChat = demo ?? readFirstChat();
    this.viewPrefs = loadChatViewPrefs();
    this.unsubViewPrefs = onChatViewPrefs((p) => (this.viewPrefs = p));
    this.addEventListener("keydown", this.onZoomKey);
    this.addEventListener("keydown", this.onSwitchKey);
    this.prefWide = readPref(COLLAPSE_KEY);
    this.prefMid = readPref(COLLAPSE_KEY_MID);
    this.activeKey = readKeyFromUrl();
    this.chat.sessionKey = isGroupChatKey(this.activeKey) ? "" : (this.activeKey ?? "");
    this.route = readRoute(this.routeKey());
    this.mqs = [`(max-width: ${MOBILE_BP - 1}px)`, `(max-width: ${WIDE_BP - 1}px)`].map((q) => window.matchMedia(q));
    for (const mq of this.mqs) mq.addEventListener("change", this.onMq);
    this.tier = currentTier();
    this.style.setProperty("--wc-zoom", String(bodyZoom()));
    window.addEventListener("resize", this.onMq);
    window.addEventListener("popstate", this.onPopState);
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("click", this.onDocClick, true);
    // Another surface (e.g. the chat side panel) changed a session's model.
    this.unsubModelSync = onSessionModel(
      (c) => {
        if (!this.sessions.some((s) => s.key === c.sessionKey)) return;
        const fallback = this.agentModel(agentIdFromKey(c.sessionKey) ?? "");
        this.sessions = this.sessions.map((s) =>
          s.key === c.sessionKey
            ? { ...s, model: c.model ?? fallback ?? s.model, modelOverridden: Boolean(c.model) }
            : s,
        );
      },
      { ignoreSource: this },
    );
    window.addEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onSessionsChanged);
    window.addEventListener("ib:webchat-prefill", this.onPrefill);
    this.onPrefill();
  }

  /** "Ask an agent about this file" (Files viewer) drops a draft into the composer. */
  private onPrefill = () => {
    let text = "";
    try {
      const raw = sessionStorage.getItem("ib:webchat-prefill");
      if (!raw) return;
      sessionStorage.removeItem("ib:webchat-prefill");
      const p = JSON.parse(raw) as { text?: string; at?: number };
      if (!p.text || Date.now() - (p.at ?? 0) > 60_000) return;
      text = p.text;
    } catch {
      return;
    }
    this.draft = text;
    void this.updateComplete.then(() => {
      const el = this.input;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    });
  };

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.setRuntimeStatus(null);
    this.unsub?.();
    this.unsub = null;
    this.subscribedClient = null;
    for (const mq of this.mqs) mq.removeEventListener("change", this.onMq);
    this.mqs = [];
    window.removeEventListener("resize", this.onMq);
    window.removeEventListener("popstate", this.onPopState);
    window.removeEventListener("ib:webchat-prefill", this.onPrefill);
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("click", this.onDocClick, true);
    this.unsubModelSync?.();
    this.unsubModelSync = null;
    this.unsubViewPrefs?.();
    this.unsubViewPrefs = null;
    this.removeEventListener("keydown", this.onZoomKey);
    this.removeEventListener("keydown", this.onSwitchKey);
    window.removeEventListener(CHAT_SESSIONS_CHANGED_EVENT, this.onSessionsChanged);
    setSecureChatSession(null);
    if (this.sessionsRefreshTimer) window.clearTimeout(this.sessionsRefreshTimer);
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    if (this.tickTimer != null) window.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    // Tell the app shell which chat is on screen (top-bar "secure session" badge).
    if (changed.has("activeKey")) setSecureChatSession(this.activeKey);
    if (changed.has("client") || changed.has("connected")) {
      this.chat.client = this.client;
      this.chat.connected = this.connected;
      if (this.client !== this.subscribedClient) {
        this.unsub?.();
        this.unsub = null;
        this.subscribedClient = this.client;
        if (this.client && typeof this.client.subscribe === "function") {
          this.unsub = this.client.subscribe((evt) => this.onGatewayEvent(evt));
        }
      }
      if (this.client && this.connected) {
        if (!this.bootstrapped) {
          this.bootstrapped = true;
          void this.loadAgents();
          void this.loadSessions();
          if (this.activeKey && this.chat.sessionKey) void this.loadHistory(true);
          void this.loadCliBackends();
          void this.loadCliFolders();
          if (this.activeKey && this.chat.sessionKey) void this.syncCliState(this.activeKey);
        } else if (changed.has("connected")) {
          // Reconnected (e.g. after a gateway restart) — re-read the store.
          void this.loadSessions();
          if (this.activeKey && this.chat.sessionKey) void this.loadHistory(true);
        }
      }
    }
  }

  protected updated(): void {
    if (this.stickToBottom && this.scroller) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
    }
    this.syncTicker();
  }

  private syncTicker() {
    const live = Boolean(this.chat.chatRunId) && this.isConnected;
    if (live && this.tickTimer == null) {
      this.nowTick = Date.now();
      this.tickTimer = window.setInterval(() => (this.nowTick = Date.now()), 1000);
    } else if (!live && this.tickTimer != null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ── gateway ──────────────────────────────────────────────────────────

  private onGatewayEvent(evt: GatewayEventFrame) {
    // Chats started/renamed/deleted in the chat sidebar (or another device).
    if (isSessionListEvent(evt, (k) => this.sessions.some((s) => s.key === k))) this.scheduleSessionsRefresh();
    if (evt.event === GATEWAY_SESSIONS_CHANGED_EVENT) return;
    if (evt.event === "chat") {
      const payload = evt.payload as ChatEventPayload | undefined;
      // Replies to our own /claude bridge controls (fallback CLI path): resolve, don't render.
      if (payload?.runId && this.controlWaiters.has(payload.runId)) {
        if (payload.state !== "delta") this.controlWaiters.get(payload.runId)?.();
        return;
      }
      if (!payload || !this.chat.sessionKey || payload.sessionKey !== this.chat.sessionKey) return;
      // CLI-mode turns stream their tool calls on the delta message (chat.cli.send).
      if (payload.state === "delta" && payload.runId === this.chat.chatRunId) {
        const msg = payload.message as { cliTools?: unknown; cli?: { backend?: string } } | undefined;
        if (msg?.cliTools) this.cliLiveTools = cliToolsToBlocks(msg.cliTools);
        if (msg?.cli?.backend && !this.cliRunBackend) this.cliRunBackend = msg.cli.backend as CliBackendId;
      }
      const result = handleChatEvent(this.chat, payload);
      if ((result === "final" || result === "aborted" || result === "error") && !this.chat.chatRunId) {
        this.cliLiveTools = [];
        this.cliRunBackend = null;
      }
      if (result === "error" && isSubscriptionCode(payload.errorCode)) {
        this.subError = { code: payload.errorCode, message: (payload.errorMessage ?? "").trim(), text: this.lastSentText };
        this.chat.lastError = null;
      } else if (result === "final") {
        this.subError = null;
        // First reply after onboarding: the learning path starts now.
        if (this.firstChat?.sentAt && !this.firstChatIsDemo) {
          this.firstChat = null;
          void completeFirstChat();
        }
      }
      if (result === "final" || result === "aborted" || result === "error") this.setRuntimeStatus(null);
      this.requestUpdate();
      if (result === "final" || result === "aborted" || result === "error") {
        void this.loadHistory(true).then(() => {
          if (!this.chat.chatRunId) resetToolStream(this.toolHost);
        });
        this.scheduleSessionsRefresh();
      }
    } else if (evt.event === "agent") {
      const rs = parseRuntimeStatusNotice(evt.payload);
      if (rs) {
        if (rs.sessionKey && rs.sessionKey === this.chat.sessionKey) this.setRuntimeStatus(rs);
        return;
      }
      if (handleChatNotice(this.chat, evt.payload)) {
        this.requestUpdate();
        return;
      }
      handleAgentEvent(this.toolHost, evt.payload as AgentEventPayload | undefined);
    }
  }

  private setRuntimeStatus(next: RuntimeStatusNotice | null) {
    if (this.runtimeClear) clearTimeout(this.runtimeClear);
    this.runtimeClear = null;
    this.runtimeStatus = next;
    if (next && !this.runtimeTick) {
      this.runtimeTick = setInterval(() => this.requestUpdate(), 1000);
    } else if (!next && this.runtimeTick) {
      clearInterval(this.runtimeTick);
      this.runtimeTick = null;
    }
    // "Ready" lingers briefly, then the normal typing indicator takes over.
    if (next?.phase === "ready") this.runtimeClear = setTimeout(() => this.setRuntimeStatus(null), 1800);
  }

  private renderRuntimeStatus(rs: RuntimeStatusNotice) {
    const elapsed = Math.max(rs.elapsedSec, Math.round((Date.now() - rs.startedAtLocal) / 1000));
    const pct = rs.etaSec > 0 ? Math.min(96, Math.round((elapsed / rs.etaSec) * 100)) : 0;
    const failed = rs.phase === "failed";
    const ready = rs.phase === "ready";
    return html`<div
      class="wc-rt ${failed ? "wc-rt--fail" : ready ? "wc-rt--ready" : ""}"
      role="status"
      aria-live="polite"
      data-testid="wc-runtime-status"
    >
      <span class="wc-rt-ico" aria-hidden="true">
        ${failed
          ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>`
          : ready
            ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`
            : html`<svg class="wc-rt-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".2" stroke-width="2.2"/><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`}
      </span>
      <span class="wc-rt-body">
        <span class="wc-rt-msg">${rs.message}</span>
        ${!failed && !ready && rs.etaSec > 0
          ? html`<span class="wc-rt-bar"><span style="width:${pct}%"></span></span>`
          : nothing}
      </span>
      ${!failed && !ready ? html`<span class="wc-rt-time">${elapsed}s</span>` : nothing}
    </div>`;
  }

  private async loadAgents() {
    if (!this.client) return;
    try {
      const res = await this.client.request<AgentsListResult>("agents.list", {});
      this.agents = Array.isArray(res?.agents) ? res.agents : [];
      // Prefer `main` (what grid chat talks to); agents.list's defaultId falls
      // back to the first roster entry when no agent is flagged default.
      const ids = new Set(this.agents.map((a) => a.id));
      this.defaultAgentId = ids.has("main") ? "main" : res?.defaultId || this.defaultAgentId;
    } catch (err) {
      console.warn("[webchat] agents.list failed", err);
    }
  }

  private async loadSessions() {
    if (!this.client || !this.connected) return;
    this.sessionsLoading = true;
    try {
      // Same store + filter as the chat sidebar, so chats started there show here.
      const res = await fetchChatSessionsPage(this.client, { limit: 300, includeLastMessage: false });
      const d = res.defaults as { model?: string | null; modelProvider?: string | null } | undefined;
      if (d?.model) this.globalModel = d.modelProvider ? `${d.modelProvider}/${d.model}` : d.model;
      const fetched = res.sessions;
      // A chat opened by URL that isn't in the list (a non-chat session, or one
      // past the loaded page) — fetch its row so the model picker reflects
      // that session instead of a blank draft.
      const openKey = this.activeKey;
      if (openKey && !fetched.some((r) => r.key === openKey) && (!isChatSessionKey(openKey) || res.hasMore)) {
        try {
          const one = await this.client.request<SessionsListResult>("sessions.list", {
            search: openKey,
            includeDerivedTitles: true,
            limit: 20,
          });
          const hit = (Array.isArray(one?.sessions) ? one.sessions : []).find((r) => r.key === openKey);
          if (hit) fetched.unshift(hit);
        } catch {
          /* best-effort — the chat still opens as a draft */
        }
      }
      // Keep an optimistic row for the active chat until the store catches up.
      const active = this.sessions.find((s) => s.key === this.activeKey);
      if (active && !fetched.some((r) => r.key === active.key)) fetched.unshift(active);
      this.sessions = fetched;
    } catch (err) {
      console.warn("[webchat] sessions.list failed", err);
    } finally {
      this.sessionsLoading = false;
      this.sessionsLoaded = true;
    }
  }

  private scheduleSessionsRefresh(delay = 600) {
    if (this.sessionsRefreshTimer) window.clearTimeout(this.sessionsRefreshTimer);
    this.sessionsRefreshTimer = window.setTimeout(() => {
      this.sessionsRefreshTimer = null;
      void this.loadSessions();
    }, delay);
  }

  private async loadHistory(force = false) {
    if (!this.chat.sessionKey) return;
    await loadChatHistory(this.chat, { force });
    this.requestUpdate();
  }

  private showToast(msg: string) {
    this.toast = msg;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = null), 3500);
  }

  // ── session actions ─────────────────────────────────────────────────

  private openSession(key: string | null, opts: { pushUrl?: boolean } = {}) {
    if (opts.pushUrl !== false) {
      const next = urlForKey(key);
      if (next !== window.location.href) window.history.pushState({}, "", next);
    }
    this.activeKey = key;
    this.editingId = null;
    this.stickToBottom = true;
    const isGroup = isGroupChatKey(key);
    // Group chats render in <ib-group-chat> (own history + live events).
    this.chat.sessionKey = isGroup ? "" : (key ?? "");
    this.chat.chatMessages = [];
    this.chat.chatStream = null;
    this.chat.chatRunId = null;
    this.chat.chatStreamStartedAt = null;
    this.chat.lastError = null;
    this.chat.chatLoadedSessionKey = null;
    resetToolStream(this.toolHost);
    this.cliLiveTools = [];
    this.cliRunBackend = null;
    this.route = readRoute(isGroup ? null : key);
    if (this.tier === "mobile") this.drawerOpen = false;
    if (key && !isGroup) void this.loadHistory(true);
    if (key && !isGroup) void this.syncCliState(key);
    this.requestUpdate();
    void this.updateComplete.then(() => this.input?.focus());
  }

  private newChat() {
    // A new chat keeps the current target (still in Codex → the new chat is Codex too).
    writeRoute(null, this.effectiveRoute());
    this.draftAgentId = this.currentAgentId();
    this.draftModel = null;
    this.draftThinking = null;
    this.openSession(null);
  }

  private async patchSession(key: string, patch: Record<string, unknown>): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.request("sessions.patch", { key, ...patch });
      notifyChatSessionsChanged({ key, reason: "patch", source: "webchat" });
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if ("pinned" in patch && /pinned|additional/i.test(msg)) {
        this.showToast("Pinning needs a gateway restart to take effect.");
      } else {
        this.showToast(msg.replace(/^Error:\s*/, ""));
      }
      return false;
    }
  }

  private async togglePin(row: GatewaySessionRow) {
    const pinned = !row.pinned;
    const prev = this.sessions;
    this.sessions = this.sessions.map((s) => (s.key === row.key ? { ...s, pinned } : s));
    const ok = await this.patchSession(row.key, { pinned });
    if (!ok) this.sessions = prev;
  }

  private startRename(row: GatewaySessionRow) {
    this.renamingKey = row.key;
    this.renameValue = sessionTitle(row);
    void this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector<HTMLInputElement>(".wc-rename");
      el?.focus();
      el?.select();
    });
  }

  private async commitRename() {
    const key = this.renamingKey;
    if (!key) return;
    this.renamingKey = null;
    const label = this.renameValue.trim();
    const row = this.sessions.find((s) => s.key === key);
    if (!row || label === sessionTitle(row)) return;
    const prev = this.sessions;
    this.sessions = this.sessions.map((s) => (s.key === key ? { ...s, label: label || undefined } : s));
    const ok = await this.patchSession(key, { label: label || null });
    if (!ok) this.sessions = prev;
  }

  private async deleteSession(row: GatewaySessionRow) {
    if (!this.client) return;
    if (!window.confirm(`Delete "${sessionTitle(row)}"?\n\nThe transcript is archived by the gateway.`)) return;
    try {
      await deleteChatSession(this.client, row.key);
      this.sessions = this.sessions.filter((s) => s.key !== row.key);
      if (this.activeKey === row.key) this.newChat();
    } catch (err) {
      this.showToast(String((err as Error)?.message ?? err));
    }
  }

  // ── group chats ─────────────────────────────────────────────────────

  /** The gateway serves group chats (older gateways need a restart onto this build). */
  private groupsSupported(): boolean {
    return this.client?.supports?.("groupchat.create") ?? true;
  }

  private openGroupDialog(secure = false) {
    this.groupDialogSecure = secure;
    this.groupDialogError = null;
    this.groupDialogDefaults = this.defaultGroupBinding();
    this.groupDialogOpen = true;
  }

  /**
   * New groups start bound to the owner's current project + directory — the
   * session context (directory / project bar) of the chat they're in, else
   * the main chat's.
   */
  private defaultGroupBinding(): GroupChatBinding | null {
    const keys = [this.activeKey, "agent:main:main", "main"].filter(
      (k): k is string => Boolean(k) && !String(k).includes(":groupchat-"),
    );
    for (const key of keys) {
      const b = loadSessionContextBinding(key);
      if (b) return b;
    }
    return null;
  }

  private async createGroup(v: GroupDialogValue) {
    if (!this.client) return;
    this.groupDialogBusy = true;
    this.groupDialogError = null;
    try {
      const { binding, ...rest } = v;
      const res = await this.client.request<{ key: string; group?: { title?: string } }>("groupchat.create", {
        ...rest,
        ...(binding ? { binding } : {}),
      });
      this.groupDialogOpen = false;
      this.sessions = [
        { key: res.key, kind: "direct", label: res.group?.title ?? (v.title || "Group chat"), updatedAt: Date.now() },
        ...this.sessions.filter((s) => s.key !== res.key),
      ];
      notifyChatSessionsChanged({ key: res.key, reason: "create", source: "webchat" });
      this.openSession(res.key);
      this.scheduleSessionsRefresh(400);
    } catch (err) {
      this.groupDialogError = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
    } finally {
      this.groupDialogBusy = false;
    }
  }

  private onGroupRenamed(e: CustomEvent<{ key: string; title: string }>) {
    const { key, title } = e.detail;
    this.sessions = this.sessions.map((s) => (s.key === key ? { ...s, label: title } : s));
    notifyChatSessionsChanged({ key, reason: "patch", source: "webchat" });
  }

  // ── composer ────────────────────────────────────────────────────────

  private currentAgentId(): string {
    return agentIdFromKey(this.activeKey) ?? this.draftAgentId ?? this.defaultAgentId;
  }

  /**
   * Composer Secure Mode toggle. On: turn Secure Mode on if needed, then move
   * to the last secure chat (or a new one), remembering the normal chat. Off:
   * back to the remembered normal chat. Nothing crosses lanes: the draft and
   * attachments are cleared on every switch.
   */
  private async onSecureToggle(on: boolean) {
    if (this.secureBusy) return;
    this.secureError = null;
    if (on) {
      this.secureBusy = true;
      const ok = await ensureSecureMode();
      this.secureBusy = false;
      if (!ok) {
        this.secureError = getSecureState().error ?? "Secure Mode could not be turned on.";
        return;
      }
    }
    const plan = planSecureLaneSwitch({
      toSecure: on,
      currentKey: this.activeKey,
      lastSecureKey: readStoredKey(LAST_SECURE_SESSION_STORAGE_KEY),
      lastNormalKey: readStoredKey(LAST_NORMAL_SESSION_STORAGE_KEY),
      agentId: this.currentAgentId(),
    });
    writeStoredKey(LAST_SECURE_SESSION_STORAGE_KEY, plan.rememberSecure);
    writeStoredKey(LAST_NORMAL_SESSION_STORAGE_KEY, plan.rememberNormal);
    this.draft = "";
    this.attachments = [];
    if (this.input) this.input.style.height = "auto";
    if (plan.next && on && !this.sessions.some((r) => r.key === plan.next)) {
      this.sessions = [{ key: plan.next, kind: "direct", label: "Secure chat", updatedAt: Date.now() }, ...this.sessions];
    }
    this.openSession(plan.next);
  }

  // ── CLI mode (composer Agent | CLI switch) ─────────────────────────

  /** The gateway serves chat.cli.* (older gateways: Claude Code only, via the /claude bridge). */
  private cliServer(): boolean {
    return this.client?.serverMethods?.has("chat.cli.send") === true;
  }

  /** No CLI in Secure Mode chats (local models only) or agent group chats. */
  private cliAllowed(key = this.activeKey): boolean {
    return !isSecureSessionKey(key) && !isGroupChatKey(key);
  }

  /** Route that actually applies to the open thread. */
  private effectiveRoute(): ChatRoute {
    return this.cliAllowed() ? this.route : AGENT_ROUTE;
  }

  private async loadCliBackends(force = false) {
    if (!this.client || !this.connected) return;
    if (!force && this.cliBackends.length && Date.now() - this.cliBackendsLoadedAt < 60_000) return;
    this.cliBackendsLoadedAt = Date.now();
    const client = this.client;
    // Fast list first (installed + version), so the switcher never sits on "Checking…";
    // cliRouting.status (sign-in state, can take seconds) refines it when it lands.
    const quick = client
      .request<{ backends?: Array<{ id: string; install?: { installed: boolean; version?: string } }> }>(
        "coder.backends.list",
        {},
      )
      .then((res) =>
        (res?.backends ?? [])
          .map((b) => backendInfoFromRouting({ id: b.id, installed: Boolean(b.install?.installed), version: b.install?.version }))
          .filter((b): b is CliBackendInfo => Boolean(b)),
      )
      .catch(() => [] as CliBackendInfo[]);
    const full = client
      .request<CliRoutingStatus>("cliRouting.status", {}, { timeoutMs: 30_000 })
      .then((st) =>
        (st?.backends ?? []).map((b) => backendInfoFromRouting(b)).filter((b): b is CliBackendInfo => Boolean(b)),
      )
      .catch(() => null);
    let refined = false;
    void quick.then((rows) => {
      if (!refined && rows.length) this.applyCliBackends(rows);
    });
    const rows = await full;
    if (rows?.length) {
      refined = true;
      this.applyCliBackends(rows);
    } else if (!this.cliBackends.length) {
      this.applyCliBackends(await quick);
    }
  }

  private applyCliBackends(rows: CliBackendInfo[]) {
    const server = this.cliServer();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rank = (b: CliBackendInfo) => (b.needsUpdate ? 3 : b.status === "ready" ? 0 : b.status === "login" ? 1 : 2);
    this.cliBackends = CLI_BACKENDS.map((id): CliBackendInfo => {
      const info = byId.get(id) ?? { id, label: CLI_LABELS[id], status: "unavailable", detail: "Not installed" };
      // Without chat.cli on the gateway only Claude Code can chat (through the /claude bridge).
      return server || id === "claude-code" || info.status === "unavailable" ? info : { ...info, needsUpdate: true };
    }).sort((a, b) => rank(a) - rank(b));
  }

  private async loadCliFolders() {
    const repos: SwitcherFolder[] = [];
    if (this.client && this.connected) {
      try {
        const res = await this.client.request<{ repos?: Array<{ root?: string; name?: string }> }>(
          "projects.repo.repos.list",
          {},
        );
        for (const r of res?.repos ?? []) if (r.root) repos.push({ path: r.root, label: r.name, kind: "repo" });
      } catch {
        /* older gateway: recent folders only */
      }
    }
    this.cliFolders = this.withRecentFolders(repos.filter((f) => f.kind === "repo"));
  }

  private withRecentFolders(repos: SwitcherFolder[] = this.cliFolders.filter((f) => f.kind === "repo")): SwitcherFolder[] {
    const recent = readRecentFolders()
      .filter((p) => !repos.some((r) => r.path === p))
      .map((path): SwitcherFolder => ({ path, kind: "recent" }));
    return [...repos, ...recent];
  }

  /** Thread key the route is saved under (null = the not-yet-created chat). */
  private routeKey(): string | null {
    return this.activeKey && !isGroupChatKey(this.activeKey) ? this.activeKey : null;
  }

  private routeLabel(r: ChatRoute = this.effectiveRoute()): string {
    return r.mode === "cli" ? CLI_LABELS[r.backend] : this.agentLabel(this.currentAgentId());
  }

  private async setRoute(next: ChatRoute, opts: { announce?: boolean } = {}) {
    if (next.mode === "cli" && !this.cliAllowed()) {
      this.showToast("CLI mode isn't available in Secure Mode or group chats.");
      return;
    }
    const prev = this.route;
    const key = this.routeKey();
    this.route = next;
    writeRoute(key, next);
    if (next.mode === "cli" && next.cwd) {
      rememberFolder(next.cwd);
      this.cliFolders = this.withRecentFolders();
    }
    if (opts.announce !== false && routeId(prev) !== routeId(next)) this.showToast(`Switched to ${this.routeLabel(next)}`);
    if (!key || !this.client || !this.connected) return;
    if (this.cliServer()) {
      void this.client
        .request("chat.cli.mode", {
          sessionKey: key,
          mode: next.mode,
          ...(next.mode === "cli"
            ? { backend: next.backend, ...(next.cwd ? { cwd: next.cwd } : {}), ...(next.model ? { model: next.model } : {}) }
            : {}),
        })
        .catch(() => undefined);
    } else if (readLegacyBridge(key) && (next.mode !== "cli" || next.backend !== "claude-code")) {
      // Fallback path: hand the thread back from Claude Code to the agent.
      writeLegacyBridge(key, null);
      void this.bridgeControl(key, "/claude off");
    }
  }

  /** Pull the thread's saved mode (and a turn still running) from the gateway. */
  private async syncCliState(key: string) {
    if (!this.cliServer() || !this.client || !this.cliAllowed(key)) return;
    try {
      const res = await this.client.request<{
        state?: { mode?: string; backend?: string; cwd?: string; models?: Record<string, string> } | null;
        active?: { runId: string; backend: string; startedAt?: number } | null;
      }>("chat.cli.state", { sessionKey: key });
      if (this.activeKey !== key) return;
      const st = res?.state;
      const r = st ? parseRoute({ ...st, model: st.backend ? st.models?.[st.backend] : undefined }) : null;
      if (r && routeId(r) !== routeId(this.route)) {
        this.route = r;
        writeRoute(key, r);
      } else if (r?.mode === "cli" && this.route.mode === "cli" && (r.cwd !== this.route.cwd || r.model !== this.route.model)) {
        this.route = r;
        writeRoute(key, r);
      }
      if (res?.active && !this.chat.chatRunId) {
        // A CLI turn is still running (page reload / another device): follow it.
        this.chat.chatRunId = res.active.runId;
        this.chat.chatStream = "";
        this.chat.chatStreamStartedAt = res.active.startedAt ?? Date.now();
        this.cliRunBackend = (CLI_BACKENDS as readonly string[]).includes(res.active.backend)
          ? (res.active.backend as CliBackendId)
          : null;
        this.requestUpdate();
      }
    } catch {
      /* the local choice stands */
    }
  }

  /**
   * Send a gateway `/claude …` control message and wait for its reply (the
   * fallback CLI path on gateways without chat.cli). Resolves false on timeout.
   */
  private bridgeControl(key: string, text: string, timeoutMs = 60_000): Promise<boolean> {
    const client = this.client;
    if (!client) return Promise.resolve(false);
    const runId = generateUUID();
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        window.clearTimeout(timer);
        this.controlWaiters.delete(runId);
        resolve(ok);
      };
      const timer = window.setTimeout(() => done(false), timeoutMs);
      this.controlWaiters.set(runId, () => done(true));
      client
        .request("chat.send", { sessionKey: key, message: text, deliver: false, idempotencyKey: runId })
        .catch(() => done(false));
    });
  }

  /** `/cli codex [folder]`, `/agent [id]` typed in the composer. */
  private async runRouteCommand(cmd: NonNullable<ReturnType<typeof parseRouteCommand>>) {
    if (cmd.kind === "cli-unknown") {
      this.showToast(`Unknown CLI "${cmd.name}". Try claude, codex, opencode, gemini or grok.`);
      return;
    }
    if (cmd.kind === "agent") {
      await this.setRoute(AGENT_ROUTE);
      if (cmd.agentId) {
        const hit = this.agents.find((a) => a.id === cmd.agentId || (a.identity?.name ?? a.name ?? "").toLowerCase() === cmd.agentId!.toLowerCase());
        if (hit) this.pickAgent(hit.id);
        else this.showToast(`No agent "${cmd.agentId}".`);
      }
      return;
    }
    // Never block the switch on the (slow) status probe: use what's loaded, refresh in the background.
    void this.loadCliBackends();
    const last = readLastCli();
    const current = this.route.mode === "cli" ? this.route : null;
    const backend =
      cmd.backend ??
      current?.backend ??
      last?.backend ??
      this.cliBackends.find((b) => b.status === "ready" && !b.needsUpdate)?.id ??
      "claude-code";
    const info = this.cliBackends.find((b) => b.id === backend);
    if (info?.needsUpdate) {
      this.showToast(`${CLI_LABELS[backend]} chat needs the gateway update — Claude Code works now.`);
      return;
    }
    if (info?.status === "unavailable") {
      this.showToast(`${CLI_LABELS[backend]} isn't installed on this machine.`);
      return;
    }
    const cwd = cmd.cwd ?? (current?.cwd || (last?.backend === backend ? last.cwd : undefined) || last?.cwd);
    await this.setRoute({
      mode: "cli",
      backend,
      ...(cwd ? { cwd } : {}),
      ...(current?.backend === backend && current.model ? { model: current.model } : {}),
    });
  }

  /** Create the chat for the first message (shared by the agent and CLI paths). */
  private ensureThread(message: string): string {
    if (this.activeKey) {
      this.sessions = this.sessions.map((s) => (s.key === this.activeKey ? { ...s, updatedAt: Date.now() } : s));
      return this.activeKey;
    }
    const key = newChatSessionKey(this.currentAgentId());
    window.history.pushState({}, "", urlForKey(key));
    this.activeKey = key;
    this.chat.sessionKey = key;
    this.chat.chatLoadedSessionKey = key;
    adoptDraftRoute(key);
    this.sessions = [{ key, kind: "direct", derivedTitle: message.slice(0, 80) || "Image", updatedAt: Date.now() }, ...this.sessions];
    return key;
  }

  private async sendCli(message: string, route: Extract<ChatRoute, { mode: "cli" }>) {
    const info = this.cliBackends.find((b) => b.id === route.backend);
    if (info?.needsUpdate || (!this.cliServer() && route.backend !== "claude-code")) {
      this.showToast(`${CLI_LABELS[route.backend]} chat needs the gateway update — Claude Code works now.`);
      return;
    }
    if (this.attachments.length) {
      this.showToast("Attachments go to the agent — remove them or switch to Agent mode.");
      return;
    }
    const key = this.ensureThread(message);
    if (route.cwd) rememberFolder(route.cwd);
    this.draft = "";
    if (this.input) this.input.style.height = "";
    resetToolStream(this.toolHost);
    this.stickToBottom = true;
    this.cliLiveTools = [];
    this.cliRunBackend = route.backend;
    const userMeta = {
      cli: { backend: route.backend, ...(route.cwd ? { cwd: route.cwd } : {}), ...(route.model ? { model: route.model } : {}) },
    };
    if (this.cliServer()) {
      const pending = sendChatMessage(this.chat, message, {
        rpc: {
          method: "chat.cli.send",
          params: { backend: route.backend, ...(route.cwd ? { cwd: route.cwd } : {}), ...(route.model ? { model: route.model } : {}) },
        },
        userMeta,
      });
      this.requestUpdate();
      const ok = await pending;
      if (!ok) this.cliRunBackend = null;
    } else {
      // Fallback: the gateway's /claude bridge (interactive Claude Code in tmux).
      const want = route.cwd || "~";
      if (readLegacyBridge(key) !== want) {
        this.showToast(`Starting Claude Code in ${folderName(route.cwd)}…`);
        const ok = await this.bridgeControl(key, `/claude on ${want}`);
        if (!ok) {
          this.cliRunBackend = null;
          this.showToast("Claude Code didn't start — try again.");
          return;
        }
        writeLegacyBridge(key, want);
      }
      const pending = sendChatMessage(this.chat, message, { userMeta });
      this.requestUpdate();
      await pending;
    }
    this.requestUpdate();
    this.scheduleSessionsRefresh(1500);
  }

  /** Ctrl/Cmd+K inside the chat → the switcher palette (outside it, the nav search keeps Ctrl+K). */
  private onSwitchKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
    if (isGroupChatKey(this.activeKey)) return;
    const sw = this.renderRoot.querySelector<ChatModeSwitcher>("chat-mode-switcher");
    if (!sw) return;
    e.preventDefault();
    e.stopPropagation();
    void this.loadCliBackends();
    if (sw.isOpen) sw.close();
    else sw.openPalette();
  };

  /** Lock badge + toggle shown inside the composer. */
  private renderSecureComposerBits() {
    const key = this.activeKey;
    const secureSession = isSecureSessionKey(key);
    const active = this.secureMode.active;
    if (this.secureMode.state.supported === false) return nothing;
    return html`
      ${secureSession
        ? html`<span
            class="wc-secure-badge ${active ? "" : "wc-secure-badge--locked"}"
            data-secure-composer-badge
            title=${active ? "Secure session · local models only" : "Secure session locked — turn on Secure Mode to send"}
          >
            ${icons.lock}<span class="wc-secure-badge__text">${active ? "Secure session · local models only" : "Secure session locked — turn on Secure Mode to send"}</span>
          </span>`
        : nothing}
      <ib-secure-toggle
        compact
        mode="custom"
        class="wc-secure-toggle"
        data-secure-surface="chat"
        .on=${secureSession}
        .busy=${this.secureBusy}
        .error=${this.secureError}
        @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => void this.onSecureToggle(e.detail.on)}
      ></ib-secure-toggle>
    `;
  }

  private agentLabel(id: string): string {
    const a = this.agents.find((x) => x.id === id);
    return a?.identity?.name || a?.name || id;
  }

  private agentEmoji(id: string): string | null {
    return sanitizeIdentityEmoji(this.agents.find((x) => x.id === id)?.identity?.emoji) ?? null;
  }

  private agentModel(id: string): string | null {
    return this.agents.find((x) => x.id === id)?.model ?? this.globalModel;
  }

  private isOverridden(row: GatewaySessionRow): boolean {
    // Older gateways don't send modelOverridden; infer it from the model.
    return row.modelOverridden ?? Boolean(row.model && row.model !== this.agentModel(agentIdFromKey(row.key) ?? ""));
  }

  private async onModelSelect(model: string | null) {
    const key = this.activeKey;
    if (!key) {
      this.draftModel = model;
      return;
    }
    const prev = this.sessions;
    const fallback = this.agentModel(this.currentAgentId());
    this.sessions = this.sessions.map((s) =>
      s.key === key ? { ...s, model: model ?? fallback ?? s.model, modelOverridden: Boolean(model) } : s,
    );
    const ok = await this.patchSession(key, { model });
    if (!ok) this.sessions = prev;
    else announceSessionModel({ sessionKey: key, model, source: this });
    this.scheduleSessionsRefresh(300);
  }

  private async onThinkingSelect(level: string | null) {
    const key = this.activeKey;
    if (!key) {
      this.draftThinking = level;
      return;
    }
    const prev = this.sessions;
    this.sessions = this.sessions.map((s) => (s.key === key ? { ...s, thinkingLevel: level ?? undefined } : s));
    const ok = await this.patchSession(key, { thinkingLevel: level });
    if (!ok) this.sessions = prev;
  }

  private pickAgent(id: string) {
    this.agentMenuOpen = false;
    this.agentFilter = "";
    if (id === this.currentAgentId()) return;
    this.draftAgentId = id;
    this.draftModel = null;
    // The agent is baked into the session key, so switching agents opens a
    // fresh chat with the new one (unless we're already on an empty draft).
    if (this.activeKey) this.openSession(null);
  }

  private async send(text?: string) {
    // `/cli codex [folder]` / `/agent [id]`: switch the composer target, send nothing.
    const routeCmd = text === undefined && this.attachments.length === 0 ? parseRouteCommand(this.draft) : null;
    if (routeCmd) {
      this.draft = "";
      if (this.input) this.input.style.height = "";
      await this.runRouteCommand(routeCmd);
      return;
    }
    const message = (text ?? this.draft).trim();
    const atts = text === undefined ? this.attachments : [];
    if (atts.some((a) => ["reading", "uploading"].includes(a.extractionStatus ?? ""))) {
      this.showToast("Wait for attachments to finish uploading.");
      return;
    }
    if (atts.some((a) => a.extractionStatus === "failed")) {
      this.showToast("Retry or remove failed attachments before sending.");
      return;
    }
    if ((!message && atts.length === 0) || !this.client || !this.connected) return;
    if (this.chat.chatRunId) return;
    const route = this.effectiveRoute();
    if (route.mode === "cli") {
      if (!message) return;
      this.lastSentText = message;
      this.subError = null;
      await this.sendCli(message, route);
      return;
    }
    this.cliRunBackend = null;
    this.lastSentText = message;
    this.subError = null;
    if (this.firstChat && !this.firstChat.sentAt && !this.firstChatIsDemo) {
      markFirstChatSent();
      this.firstChat = { ...this.firstChat, sentAt: Date.now() };
    }

    if (!this.activeKey) {
      const agentId = this.currentAgentId();
      const key = newChatSessionKey(agentId);
      window.history.pushState({}, "", urlForKey(key));
      this.activeKey = key;
      this.chat.sessionKey = key;
      this.chat.chatLoadedSessionKey = key;
      const model = this.draftModel ?? this.agentModel(agentId);
      this.sessions = [
        {
          key,
          kind: "direct",
          derivedTitle: message.slice(0, 80) || "Image",
          updatedAt: Date.now(),
          model: model ?? undefined,
          modelOverridden: Boolean(this.draftModel),
          thinkingLevel: this.draftThinking ?? undefined,
        },
        ...this.sessions,
      ];
      // Pin the picked model/thinking on the new session before the first run.
      const patch: Record<string, unknown> = {};
      if (this.draftModel) patch.model = this.draftModel;
      if (this.draftThinking) patch.thinkingLevel = this.draftThinking;
      this.draftModel = null;
      this.draftThinking = null;
      if (Object.keys(patch).length) await this.patchSession(key, patch);
    } else {
      this.sessions = this.sessions.map((s) =>
        s.key === this.activeKey ? { ...s, updatedAt: Date.now() } : s,
      );
    }

    if (text === undefined) {
      this.draft = "";
      this.attachments = [];
      if (this.input) this.input.style.height = "";
    }
    resetToolStream(this.toolHost);
    this.stickToBottom = true;
    const pending = sendChatMessage(this.chat, message, atts.length ? { attachments: atts } : undefined);
    this.requestUpdate();
    await pending;
    this.requestUpdate();
    this.scheduleSessionsRefresh(1500);
  }

  private async stop() {
    if (this.cliRunBackend && this.cliServer() && this.client) {
      // The gateway kills the CLI and answers with a "Stopped." final.
      await this.client.request("chat.cli.abort", { sessionKey: this.chat.sessionKey }).catch(() => undefined);
      return;
    }
    if (this.cliRunBackend === "claude-code" && this.activeKey && readLegacyBridge(this.activeKey)) {
      // Fallback path: /stop presses Esc in the bridged Claude Code.
      void this.bridgeControl(this.activeKey, "/stop", 10_000);
    }
    await abortChatRun(this.chat);
    this.requestUpdate();
  }

  private onInputKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send();
    }
  }

  private onInput(e: Event) {
    const el = e.target as HTMLTextAreaElement;
    this.draft = el.value;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }

  private updateAttachment(id: string, patch: Partial<ChatAttachment>) {
    this.attachments = this.attachments.map((attachment) =>
      attachment.id === id ? { ...attachment, ...patch } : attachment,
    );
  }

  private async prepareFile(file: File, id = generateUUID()) {
    if (!this.client) return;
    if (!this.attachments.some((attachment) => attachment.id === id)) {
      this.attachments = [
        ...this.attachments,
        {
          id,
          dataUrl: "",
          mimeType: normalizedFileMime(file),
          fileName: file.name,
          size: file.size,
          sourceFile: file,
          extractionStatus: "reading",
          uploadProgress: 0,
        },
      ];
    } else {
      this.updateAttachment(id, {
        extractionStatus: "reading",
        uploadProgress: 0,
        error: undefined,
      });
    }
    const onProgress = (progress: AttachmentPreparationProgress) => {
      this.updateAttachment(id, {
        extractionStatus: progress.phase === "error" ? "failed" : progress.phase,
        uploadProgress: progress.total
          ? Math.round((progress.loaded / progress.total) * 100)
          : undefined,
        error: progress.message,
      });
    };
    try {
      const ready = await prepareChatAttachment({
        file,
        client: this.client,
        sessionKey: this.chat.sessionKey || this.activeKey || "",
        onProgress,
      });
      this.attachments = this.attachments.map((attachment) =>
        attachment.id === id ? { ...ready, id } : attachment,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateAttachment(id, { extractionStatus: "failed", error: message });
      this.showToast(message);
    }
  }

  private addFiles(files: FileList | File[] | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!isSupportedChatFile(file)) {
        this.showToast(
          `Unsupported file: ${file.name}. Use PDF, DOCX, XLSX, PPTX, TXT/MD, CSV, image, or video.`,
        );
        continue;
      }
      void this.prepareFile(file);
    }
  }

  private onPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter(isSupportedChatFile);
    if (files.length) {
      e.preventDefault();
      this.addFiles(files);
    }
  }

  private async copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    this.copiedId = id;
    window.setTimeout(() => {
      if (this.copiedId === id) this.copiedId = null;
    }, 1400);
  }

  private onThreadClick(e: MouseEvent) {
    handleSnippetCopy(e);
  }

  private onScroll() {
    const el = this.scroller;
    if (!el) return;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  /** Desktop: is the chats sidebar collapsed to the icon rail? */
  private isRail(): boolean {
    if (this.tier === "wide") return this.prefWide ?? false;
    if (this.tier === "mid") return this.prefMid ?? true;
    return false;
  }

  private setRail(rail: boolean) {
    const mid = this.tier === "mid";
    if (mid) this.prefMid = rail;
    else this.prefWide = rail;
    try {
      localStorage.setItem(mid ? COLLAPSE_KEY_MID : COLLAPSE_KEY, rail ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  private toggleSidebar() {
    if (this.tier === "mobile") {
      this.drawerOpen = !this.drawerOpen;
      return;
    }
    this.setRail(!this.isRail());
  }

  /** Rail search button: expand the sidebar and jump into the search box. */
  private openSearch() {
    if (this.tier === "mobile") this.drawerOpen = true;
    else this.setRail(false);
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>(".wc-search input")?.focus());
  }

  private onListScroll(e: Event) {
    const scrolled = (e.target as HTMLElement).scrollTop > 2;
    if (scrolled !== this.listScrolled) this.listScrolled = scrolled;
  }

  // Swipe-left to dismiss the mobile drawer.
  private onTouchStart(e: TouchEvent) {
    if (this.tier !== "mobile") return;
    this.touchX = e.touches[0]?.clientX ?? null;
    this.touchDx = 0;
  }

  private onTouchMove(e: TouchEvent) {
    if (this.touchX == null) return;
    this.touchDx = Math.min(0, (e.touches[0]?.clientX ?? this.touchX) - this.touchX);
    const side = this.renderRoot.querySelector<HTMLElement>(".wc-side");
    if (side) {
      side.style.transition = "none";
      side.style.transform = `translateX(${this.touchDx}px)`;
    }
  }

  private onTouchEnd() {
    if (this.touchX == null) return;
    const side = this.renderRoot.querySelector<HTMLElement>(".wc-side");
    if (side) {
      side.style.transition = "";
      side.style.transform = "";
    }
    if (this.touchDx < -60) this.drawerOpen = false;
    this.touchX = null;
    this.touchDx = 0;
  }

  // ── transcript model ────────────────────────────────────────────────

  private buildTurns(): Turn[] {
    const turns: Turn[] = [];
    const results = new Map<string, string>();
    const msgs = (this.chat.chatMessages ?? []) as Record<string, unknown>[];
    for (const m of msgs) {
      if (isToolResultMsg(m) && typeof m.toolCallId === "string") {
        results.set(m.toolCallId, toolResultText(m));
      }
    }
    const consumed = new Set<string>();
    // Agent | CLI routing: every turn knows who it went to; a change of target
    // gets a "Switched to …" divider. `legacyRoute` follows the gateway's
    // /claude bridge notices (the CLI fallback on older gateways).
    let prevRoute: RouteId = "agent";
    let legacyRoute: RouteId | null = null;
    const enterRoute = (r: RouteId, id: string) => {
      if (r === prevRoute) return;
      turns.push({ role: "divider", id: `div-${id}`, to: r });
      prevRoute = r;
    };
    const assistantTurn = (id: string, route: RouteId = prevRoute): Extract<Turn, { role: "assistant" }> => {
      const last = turns[turns.length - 1];
      if (last?.role === "assistant" && (last.route ?? "agent") === route) return last;
      enterRoute(route, id);
      const t: Turn = { role: "assistant", id, blocks: [], route };
      turns.push(t);
      return t;
    };

    msgs.forEach((m, i) => {
      const role = String(m.role ?? "").toLowerCase();
      const id = String(m.id ?? m.clientMsgId ?? m.runId ?? `${i}-${m.timestamp ?? ""}`);
      if (role === "assistant") {
        const notice = claudeBridgeNotice(extractText(m) ?? "");
        if (notice) {
          legacyRoute = notice === "on" ? "claude-code" : null;
          return;
        }
      }
      const msgRoute: RouteId = messageRoute(m) !== "agent" ? messageRoute(m) : (legacyRoute ?? "agent");
      if (role === "user") {
        const text = cleanUserText(extractText(m) ?? "");
        const images = contentArray(m)
          .filter((c) => c.type === "image")
          .map((c) => {
            const src = c.source as Record<string, unknown> | undefined;
            const data = typeof src?.data === "string" ? src.data : typeof c.data === "string" ? c.data : "";
            if (!data) return "";
            if (data.startsWith("data:")) return data;
            const mime = (src?.media_type as string) || (c.mimeType as string) || "image/png";
            return `data:${mime};base64,${data}`;
          })
          .filter(Boolean);
        if (!text.trim() && images.length === 0) return;
        enterRoute(msgRoute, id);
        turns.push({ role: "user", id, text, images, route: msgRoute });
        return;
      }
      if (isToolResultMsg(m)) {
        const callId = typeof m.toolCallId === "string" ? m.toolCallId : "";
        if (callId && consumed.has(callId)) return;
        const name = (m.toolName as string) || (m.tool_name as string) || "tool";
        assistantTurn(id).blocks.push({
          kind: "tool",
          tool: { id: callId || id, name, result: toolResultText(m) },
        });
        return;
      }
      if (role !== "assistant") return;
      const turn = assistantTurn(id, msgRoute);
      const cliMeta = m.cli as { cwd?: unknown } | undefined;
      if (typeof cliMeta?.cwd === "string") turn.cwd = cliMeta.cwd;
      const cliTools = cliToolsToBlocks(m.cliTools);
      if (cliTools.length) turn.blocks.push({ kind: "cli-tools", tools: cliTools });
      const isTimeoutNotice = m.provider === "infinibot" && m.model === TURN_TIMEOUT_MODEL;
      if (isTimeoutNotice) turn.timeoutNotice = true;
      // "infinibot/*" rows are gateway-synthesized (delivery mirrors), not a model.
      if (typeof m.model === "string" && m.model && m.provider !== "infinibot") {
        turn.model = typeof m.provider === "string" && m.provider ? `${m.provider}/${m.model}` : m.model;
      }
      const items = contentArray(m);
      if (items.length === 0) {
        const text = extractText(m);
        if (text?.trim()) turn.blocks.push({ kind: "text", text, notice: isTimeoutNotice });
        return;
      }
      let textBuf: string[] = [];
      const flush = () => {
        const joined = extractText({ role: "assistant", content: textBuf.join("\n") }) ?? "";
        if (joined.trim()) turn.blocks.push({ kind: "text", text: joined, notice: isTimeoutNotice });
        textBuf = [];
      };
      for (const item of items) {
        if (item.type === "text" && typeof item.text === "string") {
          textBuf.push(item.text);
        } else if (isToolCallItem(item)) {
          flush();
          const callId = String(item.id ?? item.toolCallId ?? "");
          if (callId) consumed.add(callId);
          turn.blocks.push({
            kind: "tool",
            tool: {
              id: callId || `${id}-${turn.blocks.length}`,
              name: String(item.name ?? "tool"),
              args: item.arguments ?? item.args ?? item.input,
              result: callId ? results.get(callId) : undefined,
            },
          });
        }
      }
      flush();
      if (turn.blocks.length === 0 && typeof m.errorMessage === "string") {
        turn.blocks.push({ kind: "text", text: formatAssistantTurnError(m) ?? "⚠️ Request failed." });
      }
    });

    // Live run: streamed tool calls + streaming text.
    if (this.chat.chatRunId) {
      const turn = assistantTurn(`live-${this.chat.chatRunId}`, this.cliRunBackend ?? "agent");
      turn.streaming = true;
      if (this.cliLiveTools.length) turn.blocks.push({ kind: "cli-tools", tools: this.cliLiveTools });
      for (const tm of this.toolHost.chatToolMessages) {
        const items = contentArray(tm);
        const call = items.find((c) => isToolCallItem(c));
        const res = items.find((c) => String(c.type).toLowerCase() === "toolresult");
        turn.blocks.push({
          kind: "tool",
          tool: {
            id: String(tm.toolCallId ?? generateUUID()),
            name: String(call?.name ?? "tool"),
            args: call?.arguments,
            result: typeof res?.text === "string" ? res.text : undefined,
            pending: !res,
            startedAt: typeof tm.startedAt === "number" ? tm.startedAt : undefined,
            endedAt: typeof tm.endedAt === "number" ? tm.endedAt : undefined,
            isError: tm.isError === true,
          },
        });
      }
      const stream = this.chat.chatStream;
      if (stream && stream.trim()) turn.blocks.push({ kind: "text", text: stream });
    }
    // Switched target but nothing sent yet: show the divider now.
    if (turns.length && !this.chat.chatRunId) enterRoute(routeId(this.effectiveRoute()), "pending");
    // Drop assistant turns that ended up with nothing renderable.
    return turns.filter((t) => t.role !== "assistant" || t.blocks.length > 0 || t.streaming);
  }

  // ── render ──────────────────────────────────────────────────────────

  render() {
    const mobile = this.tier === "mobile";
    const rail = this.isRail();
    const drawerClosed = mobile && !this.drawerOpen;
    const cls = [
      "wc",
      `wc--${this.tier}`,
      rail ? "wc--rail" : "",
      drawerClosed ? "wc--collapsed" : "",
      this.navCollapsed ? "wc--nav-collapsed" : "wc--nav-expanded",
      `wc--w-${this.viewPrefs.width}`,
    ].join(" ");
    const viewVars = Object.entries(chatViewStyleVars(this.viewPrefs))
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
    return html`
      <div class=${cls} style=${viewVars}>
        ${mobile
          ? html`<div
              class="wc-backdrop ${this.drawerOpen ? "wc-backdrop--on" : ""}"
              @click=${() => (this.drawerOpen = false)}
            ></div>`
          : nothing}
        ${rail ? this.renderRail() : this.renderSidebar(drawerClosed)}
        <section class="wc-main">
          ${isGroupChatKey(this.activeKey)
            ? html`<ib-group-chat
                class="wc-group"
                .client=${this.client}
                .connected=${this.connected}
                .sessionKey=${this.activeKey ?? ""}
                .agents=${this.agents}
                .showMenuButton=${drawerClosed}
                .viewControls=${mobile ? "compact" : "full"}
                @toggle-sidebar=${() => this.toggleSidebar()}
                @group-renamed=${(e: CustomEvent<{ key: string; title: string }>) => this.onGroupRenamed(e)}
                @group-activity=${() => this.scheduleSessionsRefresh(1500)}
                @secure-group-new=${() => this.openGroupDialog(true)}
              ></ib-group-chat>`
            : html`${this.renderTopbar(drawerClosed)} ${this.renderThread()}`}
        </section>
        ${this.groupDialogOpen
          ? html`<ib-group-chat-dialog
              .agents=${this.agents}
              .client=${this.client}
              .initial=${{ binding: this.groupDialogDefaults, secure: this.groupDialogSecure }}
              .connected=${this.connected}
              .busy=${this.groupDialogBusy}
              .error=${this.groupDialogError}
              @cancel=${() => (this.groupDialogOpen = false)}
              @submit=${(e: CustomEvent<GroupDialogValue>) => void this.createGroup(e.detail)}
            ></ib-group-chat-dialog>`
          : nothing}
        ${this.toast ? html`<div class="wc-toast" role="status">${this.toast}</div>` : nothing}
      </div>
    `;
  }

  private renderRail() {
    return html`
      <aside class="wc-side wc-side--rail" aria-label="Chats">
        <button class="wc-rail-btn" title="Expand chats" aria-label="Expand chats" @click=${() => this.toggleSidebar()}>
          ${sidebarIcon}
        </button>
        <button class="wc-rail-btn wc-rail-btn--new" title="New chat" aria-label="New chat" @click=${() => this.newChat()}>
          ${icons.plus}
        </button>
        ${this.groupsSupported()
          ? html`<button class="wc-rail-btn" title="New group chat" aria-label="New group chat" @click=${() => this.openGroupDialog()}>
              ${icons.users}
            </button>`
          : nothing}
        <button class="wc-rail-btn" title="Search chats" aria-label="Search chats" @click=${() => this.openSearch()}>
          ${icons.search}
        </button>
      </aside>
    `;
  }

  private renderSidebar(hidden: boolean) {
    const q = this.search.trim().toLowerCase();
    const rows = q
      ? this.sessions.filter((s) => sessionTitle(s).toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
      : this.sessions;
    const pinned = rows.filter((r) => r.pinned);
    const groups = new Map<string, GatewaySessionRow[]>();
    const now = new Date();
    this.multiAgent = new Set(this.sessions.map((s) => agentIdFromKey(s.key))).size > 1;
    for (const r of rows) {
      if (r.pinned) continue;
      const b = dayBucket(r.updatedAt, now);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b)!.push(r);
    }
    const mobile = this.tier === "mobile";
    return html`
      <aside
        class="wc-side"
        data-learn-id="chat-sessions"
        aria-label="Chats"
        aria-hidden=${hidden ? "true" : "false"}
        ?inert=${hidden}
        @touchstart=${(e: TouchEvent) => this.onTouchStart(e)}
        @touchmove=${(e: TouchEvent) => this.onTouchMove(e)}
        @touchend=${() => this.onTouchEnd()}
        @touchcancel=${() => this.onTouchEnd()}
      >
        <div class="wc-side-inner">
          <div class="wc-side-top ${this.listScrolled ? "wc-side-top--scrolled" : ""}">
            <div class="wc-side-head">
              <span class="wc-brand">Chats</span>
              ${this.sessionsLoaded && this.sessions.length
                ? html`<span class="wc-brand-count">${this.sessions.length}</span>`
                : nothing}
              <span class="wc-side-head-spacer"></span>
              <button
                class="wc-icon-btn"
                title=${mobile ? "Close" : "Collapse chats"}
                aria-label=${mobile ? "Close chats" : "Collapse chats"}
                @click=${() => this.toggleSidebar()}
              >
                ${mobile ? icons.x : sidebarIcon}
              </button>
            </div>
            <div class="wc-new-row">
              <button class="wc-new" data-learn-id="chat-new" @click=${() => this.newChat()}>
                <span class="wc-new-ico">${icons.plus}</span>
                <span>New chat</span>
              </button>
              ${this.groupsSupported()
                ? html`<button
                    class="wc-new wc-new--group"
                    data-learn-id="chat-new-group"
                    title="New group chat with several agents"
                    @click=${() => this.openGroupDialog()}
                  >
                    <span class="wc-new-ico">${icons.users}</span>
                    <span>Group</span>
                  </button>`
                : nothing}
            </div>
            <label class="wc-search">
              <span class="wc-search-ico">${icons.search}</span>
              <input
                type="search"
                data-learn-id="chat-search"
                placeholder="Search chats"
                aria-label="Search chats"
                .value=${this.search}
                @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Escape" && this.search) {
                    e.stopPropagation();
                    this.search = "";
                  }
                }}
              />
            </label>
          </div>
          <nav class="wc-list" @scroll=${(e: Event) => this.onListScroll(e)}>
            ${pinned.length ? this.renderGroup("Pinned", pinned, true) : nothing}
            ${BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => this.renderGroup(b, groups.get(b)!))}
            ${this.sessionsLoaded && rows.length === 0 ? this.renderListEmpty(q) : nothing}
            ${!this.sessionsLoaded
              ? html`<div class="wc-list-skel" aria-label="Loading chats">
                  ${[0, 1, 2, 3, 4].map(() => html`<div class="wc-list-skel-row"><i></i><i></i></div>`)}
                </div>`
              : nothing}
          </nav>
        </div>
      </aside>
    `;
  }

  private renderListEmpty(q: string) {
    if (q) {
      return html`<div class="wc-list-empty">
        <span class="wc-list-empty-ico">${icons.search}</span>
        <div class="wc-list-empty-title">No matches</div>
        <div class="wc-list-empty-sub">Nothing found for “${this.search.trim()}”.</div>
        <button class="wc-list-empty-btn" @click=${() => (this.search = "")}>Clear search</button>
      </div>`;
    }
    return html`<div class="wc-list-empty">
      <span class="wc-list-empty-ico">${icons.messageSquare}</span>
      <div class="wc-list-empty-title">No chats yet</div>
      <div class="wc-list-empty-sub">Your conversations will show up here.</div>
      <button class="wc-list-empty-btn" @click=${() => this.newChat()}>Start a chat</button>
    </div>`;
  }

  private renderGroup(label: string, rows: GatewaySessionRow[], isPinned = false) {
    return html`
      <section class="wc-group ${isPinned ? "wc-group--pinned" : ""}">
        <div class="wc-group-label">
          ${isPinned ? html`<span class="wc-group-ico">${pinIcon}</span>` : nothing}
          <span>${label}</span>
          <span class="wc-group-count">${rows.length}</span>
        </div>
        ${repeat(rows, (r) => r.key, (r) => this.renderSessionItem(r))}
      </section>
    `;
  }

  private renderSessionItem(r: GatewaySessionRow) {
    const active = r.key === this.activeKey;
    if (this.renamingKey === r.key) {
      return html`<div class="wc-item wc-item--active wc-item--renaming">
        <input
          class="wc-rename"
          .value=${this.renameValue}
          @input=${(e: Event) => (this.renameValue = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") void this.commitRename();
            if (e.key === "Escape") this.renamingKey = null;
          }}
          @blur=${() => void this.commitRename()}
        />
      </div>`;
    }
    const agentId = agentIdFromKey(r.key);
    const when = relTime(r.updatedAt);
    return html`
      <div
        class="wc-item ${active ? "wc-item--active" : ""}"
        role="button"
        tabindex="0"
        aria-current=${active ? "page" : "false"}
        title=${sessionTitle(r)}
        @click=${() => this.openSession(r.key)}
        @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.openSession(r.key)}
      >
        <div class="wc-item-main">
          <span class="wc-item-title">${isSecureSessionKey(r.key) ? html`<span class="wc-item-secure" title="Secure Mode session">${icons.lock}</span>` : nothing}${isGroupChatKey(r.key) ? html`<span class="wc-item-group" title="Group chat">${icons.users}</span>` : nothing}${sessionTitle(r)}</span>
          <span class="wc-item-meta">
            ${isGroupChatKey(r.key)
              ? html`<span class="wc-item-agent">Group chat</span>`
              : agentId && this.multiAgent
              ? html`<span class="wc-item-agent">${this.agentEmoji(agentId) ?? nothing} ${this.agentLabel(agentId)}</span>`
              : nothing}
            ${when ? html`<span class="wc-item-time">${when}</span>` : nothing}
          </span>
        </div>
        <span class="wc-item-actions" @click=${(e: Event) => e.stopPropagation()}>
          <button class="wc-mini" title="Rename" aria-label="Rename" @click=${() => this.startRename(r)}>${icons.edit}</button>
          <button
            class="wc-mini ${r.pinned ? "wc-mini--on" : ""}"
            title=${r.pinned ? "Unpin" : "Pin"}
            aria-label=${r.pinned ? "Unpin" : "Pin"}
            @click=${() => void this.togglePin(r)}
          >
            ${pinIcon}
          </button>
          <button class="wc-mini wc-mini--danger" title="Delete" aria-label="Delete" @click=${() => void this.deleteSession(r)}>
            ${icons.trash}
          </button>
        </span>
      </div>
    `;
  }

  private renderTopbar(drawerClosed: boolean) {
    const agentId = this.currentAgentId();
    const active = this.sessions.find((s) => s.key === this.activeKey);
    const title = active ? sessionTitle(active) : this.activeKey ? "Chat" : "New chat";
    const f = this.agentFilter.trim().toLowerCase();
    const list = this.agents.filter(
      (a) => !f || a.id.toLowerCase().includes(f) || (a.identity?.name ?? a.name ?? "").toLowerCase().includes(f),
    );
    return html`
      <header class="wc-top" data-learn-id="chat-topbar">
        ${drawerClosed
          ? html`<button class="wc-icon-btn" data-learn-id="chat-open-sessions" title="Open chats" @click=${() => this.toggleSidebar()}>${sidebarIcon}</button>
              <button class="wc-icon-btn" title="New chat" @click=${() => this.newChat()}>${icons.penLine}</button>`
          : nothing}
        <div class="wc-agent">
          <button
            class="wc-agent-btn"
            data-learn-id="chat-agent-picker"
            aria-haspopup="listbox"
            aria-expanded=${this.agentMenuOpen ? "true" : "false"}
            @click=${() => (this.agentMenuOpen = !this.agentMenuOpen)}
          >
            ${this.agentEmoji(agentId) ? html`<span class="wc-agent-emoji">${this.agentEmoji(agentId)}</span>` : nothing}
            <span class="wc-agent-name">${this.agentLabel(agentId)}</span>
            <span class="wc-chev">${icons.chevronDown}</span>
          </button>
          ${this.agentMenuOpen
            ? html`<div class="wc-agent-menu" role="listbox">
                <input
                  class="wc-agent-filter"
                  data-learn-id="chat-agent-filter"
                  placeholder="Search agents"
                  .value=${this.agentFilter}
                  @input=${(e: Event) => (this.agentFilter = (e.target as HTMLInputElement).value)}
                />
                <div class="wc-agent-list">
                  ${list.map(
                    (a) => html`<button
                      class="wc-agent-opt ${a.id === agentId ? "wc-agent-opt--on" : ""}"
                      role="option"
                      aria-selected=${a.id === agentId ? "true" : "false"}
                      @click=${() => this.pickAgent(a.id)}
                    >
                      <span class="wc-agent-emoji">${sanitizeIdentityEmoji(a.identity?.emoji) ?? "◆"}</span>
                      <span class="wc-agent-opt-name">${a.identity?.name || a.name || a.id}</span>
                      <span class="wc-agent-opt-id">${a.id}</span>
                      ${a.id === agentId ? html`<span class="wc-agent-check">${icons.check}</span>` : nothing}
                    </button>`,
                  )}
                  ${list.length === 0 ? html`<div class="wc-agent-none">No agents</div>` : nothing}
                </div>
              </div>`
            : nothing}
        </div>
        ${this.renderModeChip()}
        ${this.effectiveRoute().mode === "cli" ? nothing : html`<webchat-model-picker
          data-learn-id="chat-model-picker"
          .client=${this.client}
          .connected=${this.connected}
          .value=${active?.model ?? this.draftModel ?? this.agentModel(agentId)}
          .defaultModel=${this.agentModel(agentId)}
          .overridden=${active ? this.isOverridden(active) : Boolean(this.draftModel)}
          .thinkingLevel=${active ? active.thinkingLevel ?? null : this.draftThinking}
          .mobile=${this.tier === "mobile"}
          @model-select=${(e: CustomEvent<{ model: string | null }>) => void this.onModelSelect(e.detail.model)}
          @thinking-select=${(e: CustomEvent<{ level: string | null }>) => void this.onThinkingSelect(e.detail.level)}
        ></webchat-model-picker>`}
        <div class="wc-top-title" title=${title}>${title}</div>
        <ib-chat-view-controls ?compact=${this.tier === "mobile"} data-learn-id="chat-view-controls"></ib-chat-view-controls>
        ${!this.connected ? html`<span class="wc-offline">Offline</span>` : nothing}
      </header>
    `;
  }

  /** Thread header: who this chat talks to right now (click → the switcher). */
  private renderModeChip() {
    if (isGroupChatKey(this.activeKey)) return nothing;
    const r = this.effectiveRoute();
    const open = () => {
      void this.loadCliBackends();
      this.renderRoot.querySelector<ChatModeSwitcher>("chat-mode-switcher")?.openPalette();
    };
    return r.mode === "cli"
      ? html`<button class="wc-mode-chip wc-mode-chip--cli" data-mode-chip="cli" title=${`CLI mode · ${CLI_LABELS[r.backend]} in ${r.cwd ?? "your home folder"}${r.model ? ` · ${r.model}` : ""} (Ctrl+K to switch)`} @click=${open}>
          ${cliLogo(r.backend, 14)}<span class="wc-mode-chip-lbl">${CLI_LABELS[r.backend]}</span><span class="wc-mode-chip-sub">${folderName(r.cwd)}</span>
        </button>`
      : html`<button class="wc-mode-chip" data-mode-chip="agent" title="Agent mode · Ctrl+K to switch to a coding CLI" @click=${open}>
          ${icons.bot}<span class="wc-mode-chip-lbl">Agent</span>
        </button>`;
  }

  /** `/cli …` and `/agent` suggestions while typing a slash command. */
  private renderRouteHints() {
    const d = this.draft;
    if (!d.startsWith("/") || d.includes("\n") || isGroupChatKey(this.activeKey)) return nothing;
    const q = d.trim().toLowerCase();
    const hits = ROUTE_COMMAND_HINTS.filter((h) => h.command.startsWith(q) || (q.length > 1 && h.command.includes(q.slice(1))));
    if (!hits.length || hits.some((h) => h.command === q)) return nothing;
    return html`<div class="wc-route-hints" role="listbox" data-route-hints>
      ${hits.map(
        (h) => html`<button
          class="wc-route-hint"
          role="option"
          @mousedown=${(e: Event) => e.preventDefault()}
          @click=${() => {
            this.draft = `${h.command} `;
            void this.updateComplete.then(() => this.input?.focus());
          }}
        >
          <code>${h.command}</code><span>${h.description}</span>
        </button>`,
      )}
    </div>`;
  }

  private renderThread() {
    const turns = this.buildTurns();
    const loading = this.chat.chatLoading && turns.length === 0 && Boolean(this.activeKey);
    const empty = !loading && turns.length === 0;
    if (empty && this.firstChat && !this.firstChat.sentAt && !this.activeKey) return this.renderFirstChat(this.firstChat);
    if (empty) {
      const agentId = this.currentAgentId();
      const hour = new Date().getHours();
      const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      return html`
        <div class="wc-empty">
          <div class="wc-empty-inner">
            ${renderBrandAvatar("wc-empty-avatar", this.agentLabel(agentId))}
            <h1 class="wc-greet">${greet}</h1>
            <p class="wc-sub">Chatting with <strong>${this.agentLabel(agentId)}</strong>. How can I help?</p>
            ${this.renderComposer(true)}
            <div class="wc-chips" data-learn-id="chat-suggestions">
              ${SUGGESTIONS.map(
                (s) => html`<button class="wc-chip" @click=${() => void this.send(s.prompt)}>
                  <span class="wc-chip-title">${s.title}</span>
                  <span class="wc-chip-sub">${s.prompt}</span>
                </button>`,
              )}
            </div>
          </div>
        </div>
      `;
    }
    if (this.subError && !this.chat.chatRunId) {
      // The card says it in plain words; drop the trailing warning text turn.
      const last = turns[turns.length - 1];
      if (last?.role === "assistant" && last.blocks.every((b) => b.kind === "text" && /^\s*⚠️/.test(b.text))) turns.pop();
    }
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    return html`
      <div class="wc-scroll" @scroll=${() => this.onScroll()} @click=${(e: MouseEvent) => this.onThreadClick(e)}>
        <div class="wc-col">
          ${loading
            ? html`<div class="wc-skel"><div></div><div></div><div></div></div>`
            : repeat(turns, (t) => t.id, (t) =>
                t.role === "user"
                  ? this.renderUserTurn(t, turns)
                  : t.role === "divider"
                    ? this.renderDivider(t)
                    : this.renderAssistantTurn(t, t === lastAssistant, turns),
              )}
          ${this.chat.lastError && !this.chat.chatRunId && !this.subError
            ? html`<div class="wc-error">${this.chat.lastError}</div>`
            : nothing}
          ${this.subError && !this.chat.chatRunId
            ? html`<ib-chat-subscription-card
                .code=${this.subError.code}
                .message=${this.subError.message}
                .text=${this.subError.text}
                @resend=${(e: CustomEvent<{ text: string }>) => {
                  const text = e.detail.text;
                  this.subError = null;
                  if (text) void this.send(text);
                }}
                @dismiss=${() => (this.subError = null)}
              ></ib-chat-subscription-card>`
            : nothing}
        </div>
      </div>
      <div class="wc-dock">
        <div class="wc-col">
          ${isSecureSessionKey(this.activeKey)
            ? html`<ib-secure-research-card mode="session" .sessionKey=${this.activeKey}></ib-secure-research-card>`
            : nothing}
          ${this.renderComposer(false)}
        </div>
      </div>
    `;
  }

  /** Welcome after onboarding: one-tap starters from the user's goals and a pointer to the input. */
  private renderFirstChat(fc: FirstChatHandoff): TemplateResult {
    const agentId = this.currentAgentId();
    // Name the account the chat really runs on (the gateway's current default
    // model) so it can't drift from the handoff saved at onboarding time.
    const account = accountForModel(this.agentModel(agentId)) ?? fc.account;
    return html`
      <div class="wc-empty">
        <div class="wc-empty-inner wc-first" data-testid="chat-first-welcome">
          ${renderBrandAvatar("wc-empty-avatar", this.agentLabel(agentId))}
          <h1 class="wc-greet">Hi, I'm InfiniBot</h1>
          <p class="wc-sub">
            ${account ? html`I'm connected through your <strong>${/account$/i.test(account) ? account : `${account} account`}</strong>. ` : nothing}Tap one of these to start our first chat.
          </p>
          <div class="wc-chips wc-first-chips" data-learn-id="chat-first-starters">
            ${fc.starters.map(
              (st, n) => html`<button class="wc-chip wc-first-chip" data-testid=${`onb-first-chat-starter-${n}`} @click=${() => void this.send(st.prompt)}>
                <span class="wc-chip-title">${st.title}</span>
                <span class="wc-chip-sub">${st.prompt}</span>
              </button>`,
            )}
          </div>
          <p class="wc-first-hint" aria-hidden="true">${icons.arrowDown}<span>Or type anything you like here</span></p>
          ${this.renderComposer(true)}
        </div>
      </div>
    `;
  }

  private renderUserTurn(t: Extract<Turn, { role: "user" }>, _turns: Turn[]): TemplateResult {
    if (this.editingId === t.id) {
      return html`<div class="wc-user wc-user--edit">
        <textarea
          class="wc-edit"
          .value=${this.editValue}
          @input=${(e: Event) => (this.editValue = (e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              this.submitEdit();
            }
            if (e.key === "Escape") this.editingId = null;
          }}
        ></textarea>
        <div class="wc-edit-actions">
          <button class="wc-btn" @click=${() => (this.editingId = null)}>Cancel</button>
          <button class="wc-btn wc-btn--primary" @click=${() => this.submitEdit()}>Send</button>
        </div>
      </div>`;
    }
    return html`
      <div class="wc-user">
        ${t.images.length
          ? html`<div class="wc-user-imgs">${t.images.map(
              (src) => html`<span class="wc-img-wrap"><img src=${src} alt="attachment" /><button
                  type="button"
                  class="wc-img-ocr chat-attachment-ocr"
                  title="Extracted text and description (local OCR)"
                  aria-label="Show extracted text and description"
                  @click=${() =>
                    void import("../components/file-context-panel").then((m) =>
                      m.openAttachmentContext(src, "Chat attachment", this.chat.sessionKey),
                    )}
                >${icons.scrollText}<span>Text</span></button></span>`,
            )}</div>`
          : nothing}
        ${t.text.trim() ? html`<div class="wc-bubble">${t.text}</div>` : nothing}
        ${t.route && t.route !== "agent"
          ? html`<div class="wc-user-route"><span class="wc-route-badge" data-route-badge=${t.route} title=${`Sent to ${CLI_LABELS[t.route]}`}>${cliLogo(t.route, 11)}to ${CLI_LABELS[t.route]}</span></div>`
          : nothing}
        <div class="wc-actions wc-actions--user">
          <button class="wc-mini" title="Copy" @click=${() => void this.copy(t.text, t.id)}>
            ${this.copiedId === t.id ? icons.check : icons.copy}
          </button>
          <button
            class="wc-mini"
            title="Edit & resend"
            ?disabled=${Boolean(this.chat.chatRunId)}
            @click=${() => {
              this.editingId = t.id;
              this.editValue = t.text;
            }}
          >
            ${icons.edit}
          </button>
        </div>
      </div>
    `;
  }

  private submitEdit() {
    const text = this.editValue.trim();
    this.editingId = null;
    if (text) void this.send(text);
  }

  private renderDivider(t: Extract<Turn, { role: "divider" }>) {
    const label = t.to === "agent" ? this.agentLabel(this.currentAgentId()) : CLI_LABELS[t.to];
    return html`<div class="wc-divider" role="separator" data-route-divider=${t.to}>
      <span class="wc-divider-chip">
        ${t.to === "agent" ? icons.bot : cliLogo(t.to, 13)}
        Switched to ${label}
      </span>
    </div>`;
  }

  private renderCliTools(tools: ToolBlock[], streaming: boolean) {
    const running = tools.filter((x) => x.pending);
    const failed = tools.filter((x) => x.isError).length;
    const names = [...new Set(tools.map((x) => x.name))].slice(0, 4).join(", ");
    const now = running[running.length - 1];
    return html`<details class="wc-cli-tools ${running.length ? "wc-cli-tools--live" : ""}" data-cli-tools>
      <summary>
        <span class="wc-tool-ico">${running.length && streaming ? icons.loader : icons.wrench}</span>
        <span class="wc-tool-name">${tools.length} tool call${tools.length === 1 ? "" : "s"}</span>
        <span class="wc-tool-state">${now && streaming
          ? `${now.name}${typeof now.args === "string" ? `: ${now.args.slice(0, 60)}` : ""}`
          : `${names}${failed ? ` · ${failed} failed` : ""}`}</span>
        <span class="wc-chev">${icons.chevronRight}</span>
      </summary>
      <div class="wc-cli-tools-list">${tools.map((tool) => this.renderTool(tool))}</div>
    </details>`;
  }

  private renderAssistantTurn(t: Extract<Turn, { role: "assistant" }>, isLast: boolean, turns: Turn[]) {
    const agentId = this.currentAgentId();
    const cli = t.route && t.route !== "agent" ? t.route : null;
    const fullText = t.blocks
      .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
      .map((b) => b.text)
      .join("\n\n");
    const hasText = fullText.trim().length > 0;
    return html`
      <div class="wc-asst">
        <div class="wc-asst-head">
          ${cli
            ? html`<span class="wc-avatar wc-avatar--cli">${cliLogo(cli, 16)}</span>
                <span class="wc-asst-name">${CLI_LABELS[cli]}</span>
                <span class="wc-route-badge wc-route-badge--cli" data-route-badge=${cli} title=${t.cwd ? `CLI in ${t.cwd}` : "Coding CLI"}>CLI${t.cwd ? html` · ${folderName(t.cwd)}` : nothing}</span>`
            : html`${renderBrandAvatar("wc-avatar", this.agentLabel(agentId))}
                <span class="wc-asst-name">${this.agentLabel(agentId)}</span>
                <span class="wc-route-badge" data-route-badge="agent">Agent</span>`}
          ${t.model && !cli ? html`<span class="wc-asst-model" title=${t.model}>${t.model}</span>` : nothing}
        </div>
        <div class="wc-asst-body">
          ${t.blocks.map((b) =>
            b.kind === "text"
              ? html`<div class="wc-md ${b.notice ? "wc-md--timeout" : ""}">${unsafeHTML(renderMarkdown(b.text))}</div>`
              : b.kind === "cli-tools"
                ? this.renderCliTools(b.tools, Boolean(t.streaming))
                : this.renderTool(b.tool),
          )}
          ${t.streaming && !hasText && this.runtimeStatus
            ? this.renderRuntimeStatus(this.runtimeStatus)
            : nothing}
          ${t.streaming && !hasText && (!this.runtimeStatus || this.runtimeStatus.phase === "failed")
            ? this.renderThinking(t)
            : nothing}
          ${t.streaming && hasText ? html`<span class="wc-caret"></span>` : nothing}
          ${t.timeoutNotice && isLast && !t.streaming
            ? html`<div class="wc-timeout-actions">
                <button
                  class="wc-btn wc-btn--primary wc-continue"
                  title="Resume from the results gathered so far"
                  ?disabled=${Boolean(this.chat.chatRunId) || !this.connected}
                  @click=${() => void this.send(CONTINUE_PROMPT)}
                >
                  ${icons.arrowUp} Continue
                </button>
                <span class="wc-timeout-hint">Picks up from the gathered results.</span>
              </div>`
            : nothing}
        </div>
        ${
          !t.streaming && hasText
            ? html`<div class="wc-actions">
              <button
                class="wc-mini"
                title="Copy as plain text"
                aria-label="Copy as plain text"
                @click=${() =>
                  void this.copy(
                    markdownToPlainText(fullText, toSanitizedMarkdownHtml(fullText)),
                    t.id,
                  )}
              >
                ${this.copiedId === t.id ? icons.check : icons.copy}
              </button>
              <ib-response-actions
                .markdown=${fullText}
                .sessionKey=${this.chat.sessionKey}
                .secure=${isSecureSessionKey(this.chat.sessionKey)}
                .client=${this.client}
              ></ib-response-actions>
              ${
                isLast
                  ? html`<button
                    class="wc-mini"
                    title="Regenerate (resends your last message)"
                    ?disabled=${Boolean(this.chat.chatRunId)}
                    @click=${() => this.regenerate(turns)}
                  >
                    ${icons.refresh}
                  </button>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }

  /**
   * Live "Thinking… 1m20s" while the model generates: counted from the run
   * start or the last finished tool call. Hidden while a tool is running (its
   * card shows its own elapsed time).
   */
  private renderThinking(t: Extract<Turn, { role: "assistant" }>) {
    const tools = t.blocks.flatMap((b) => (b.kind === "tool" ? [b.tool] : []));
    if (tools.some((x) => x.pending)) return nothing;
    const lastEnd = Math.max(0, ...tools.map((x) => x.endedAt ?? 0));
    const since = Math.max(this.chat.chatStreamStartedAt ?? 0, lastEnd);
    return html`<div class="wc-thinking" aria-live="polite">
      <span class="wc-typing" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="wc-thinking-label">Thinking…${since ? html` <b>${formatElapsed(this.nowTick - since)}</b>` : nothing}</span>
    </div>`;
  }

  private regenerate(turns: Turn[]) {
    const lastUser = [...turns].reverse().find((t): t is Extract<Turn, { role: "user" }> => t.role === "user");
    if (lastUser?.text.trim()) void this.send(lastUser.text);
  }

  private renderTool(tool: ToolBlock) {
    // Secure research: approval card (editable outbound queries) → result card.
    if (tool.name === "secure_research") {
      return html`<ib-secure-research-card
        .sessionKey=${this.activeKey}
        .running=${Boolean(tool.pending)}
        .result=${tool.pending ? null : (tool.result ?? null)}
      ></ib-secure-research-card>`;
    }
    // Agent-invokable chat panel (show_panel) → live inline card.
    const panel = tool.pending ? null : extractPanelRef(tool.result);
    if (panel) return renderChatPanelRef(panel);
    const args = formatArgs(tool.args);
    return html`
      <details class="wc-tool ${tool.pending ? "wc-tool--pending" : ""}">
        <summary>
          <span class="wc-tool-ico">${tool.pending ? icons.loader : icons.wrench}</span>
          <span class="wc-tool-name">${tool.name}</span>
          <span class="wc-tool-state">${this.toolStateLabel(tool)}</span>
          <span class="wc-chev">${icons.chevronRight}</span>
        </summary>
        ${args ? html`<div class="wc-tool-sec"><div class="wc-tool-lbl">Input</div><pre>${args}</pre></div>` : nothing}
        ${tool.result != null && tool.result !== ""
          ? html`<div class="wc-tool-sec"><div class="wc-tool-lbl">Output</div><pre>${tool.result.length > 8000 ? `${tool.result.slice(0, 8000)}\n… (truncated)` : tool.result}</pre></div>`
          : nothing}
      </details>
    `;
  }

  private toolStateLabel(tool: ToolBlock): string {
    if (tool.pending) {
      return tool.startedAt ? `running… ${formatElapsed(this.nowTick - tool.startedAt)}` : "running…";
    }
    const took =
      tool.startedAt && tool.endedAt ? ` · ${formatElapsed(tool.endedAt - tool.startedAt)}` : "";
    if (tool.isError) return `failed${took}`;
    return tool.result != null ? `done${took}` : "";
  }

  private renderComposer(hero: boolean) {
    const running = Boolean(this.chat.chatRunId);
    const attachmentsReady = this.attachments.every(
      (attachment) =>
        !["reading", "uploading", "failed"].includes(attachment.extractionStatus ?? ""),
    );
    const canSend =
      (this.draft.trim().length > 0 || this.attachments.length > 0) &&
      this.connected &&
      attachmentsReady;
    return html`
      <div
        class="wc-composer ${hero ? "wc-composer--hero" : ""} ${isSecureSessionKey(this.activeKey) ? "wc-composer--secure" : ""}"
        data-learn-id="chat-composer"
        @dragover=${(e: DragEvent) => {
          if (e.dataTransfer?.types.includes("Files")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        @drop=${(e: DragEvent) => {
          if (e.dataTransfer?.files?.length) {
            e.preventDefault();
            this.addFiles(e.dataTransfer.files);
          }
        }}
      >
        ${
          this.attachments.length
            ? html`<div class="wc-atts">
              ${this.attachments.map(
                (a) => html`<ib-chat-attachment-chip
                  .attachment=${a}
                  .client=${this.client}
                  .sessionKey=${this.chat.sessionKey}
                  @attachment-remove=${() => (this.attachments = this.attachments.filter((x) => x.id !== a.id))}
                  @attachment-update=${(e: CustomEvent<ChatAttachment>) => this.updateAttachment(a.id, e.detail)}
                  @attachment-status=${(e: CustomEvent<ChatAttachment>) => this.updateAttachment(a.id, e.detail)}
                  @attachment-retry=${() => a.sourceFile && void this.prepareFile(a.sourceFile, a.id)}
                ></ib-chat-attachment-chip>`,
              )}
            </div>`
          : nothing}
        ${this.renderRouteHints()}
        <textarea
          class="wc-input"
          data-learn-id="chat-input"
          rows="1"
          placeholder=${!this.connected
            ? "Connecting to gateway…"
            : this.effectiveRoute().mode === "cli"
              ? `Message ${this.routeLabel()} in ${folderName((this.effectiveRoute() as { cwd?: string }).cwd)}…`
              : `Message ${this.agentLabel(this.currentAgentId())}…`}
          .value=${this.draft}
          @input=${(e: Event) => this.onInput(e)}
          @keydown=${(e: KeyboardEvent) => this.onInputKey(e)}
          @paste=${(e: ClipboardEvent) => this.onPaste(e)}
        ></textarea>
        <div class="wc-composer-row">
          <button class="wc-icon-btn" title="Attach document, image, or video" aria-label="Attach document, image, or video" @click=${() => this.fileInput?.click()}>${icons.paperclip}</button>
          <input
            class="wc-file"
            type="file"
            accept=${CHAT_ATTACHMENT_ACCEPT}
            multiple
            hidden
            @change=${(e: Event) => {
              const el = e.target as HTMLInputElement;
              this.addFiles(el.files);
              el.value = "";
            }}
          />
          ${this.chat.sessionKey
            ? html`<chat-call-button .sessionKey=${this.chat.sessionKey} source="webchat" show-label></chat-call-button>`
            : nothing}
          ${this.renderSecureComposerBits()}
          <span class="wc-hint">Enter to send · Shift+Enter for newline</span>
          ${isGroupChatKey(this.activeKey)
            ? nothing
            : html`<chat-mode-switcher
                data-learn-id="chat-mode-switcher"
                .route=${this.effectiveRoute()}
                .agents=${this.agents.map((a) => ({ id: a.id, name: a.identity?.name || a.name || a.id }))}
                .agentId=${this.currentAgentId()}
                .backends=${this.cliBackends}
                .folders=${this.cliFolders}
                ?compact=${this.tier === "mobile"}
                ?disabled=${running || !this.cliAllowed()}
                @switcher-toggle=${(e: CustomEvent<{ open: boolean }>) => {
                  if (e.detail.open) {
                    void this.loadCliBackends();
                    void this.loadCliFolders();
                  }
                }}
                @route-change=${(e: CustomEvent<{ route: ChatRoute }>) => void this.setRoute(e.detail.route)}
                @agent-change=${(e: CustomEvent<{ agentId: string }>) => this.pickAgent(e.detail.agentId)}
                @cli-requested=${async (e: Event) => {
                  const first = !readLastCli();
                  await this.runRouteCommand({ kind: "cli", backend: null });
                  // First time in CLI mode: show the list so the folder / other CLIs are visible.
                  if (first && this.route.mode === "cli") (e.target as ChatModeSwitcher).openPalette();
                }}
              ></chat-mode-switcher>`}
          ${running
            ? html`<button class="wc-send wc-send--stop" title="Stop" @click=${() => void this.stop()}>${icons.stop}</button>`
            : html`<button class="wc-send" data-learn-id="chat-send" title="Send" ?disabled=${!canSend} @click=${() => void this.send()}>${icons.arrowUp}</button>`}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
      color: var(--text);
      font-family: var(--font-body, inherit);
      --wc-surface: var(--g-surface, var(--card));
      --wc-surface-strong: var(--g-surface-strong, var(--bg-elevated));
      --wc-hover: var(--g-surface-hover, var(--bg-hover));
      --wc-border: var(--g-border, var(--border));
      --wc-border-strong: var(--g-border-strong, var(--border-strong));
      --wc-accent: var(--g-primary, var(--accent));
      --wc-accent-soft: var(--g-primary-muted, var(--accent-subtle));
      --wc-radius: var(--g-radius, 14px);
      --wc-radius-sm: var(--g-radius-sm, 10px);
    }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; color: inherit; }
    svg { width: 16px; height: 16px; flex: none; }

    .wc {
      /* Chats sidebar width follows the main app nav: narrower while the main
         nav is expanded (two stacked sidebars), roomier when it's collapsed. */
      --wc-side-w: calc(290px / var(--wc-zoom, 1));
      --wc-rail-w: calc(60px / var(--wc-zoom, 1));
      --wc-ease: var(--ease-out, cubic-bezier(0.22, 1, 0.36, 1));
      --wc-side-solid: var(--bg-elevated, var(--bg));
      --wc-side-bg: var(--wc-side-solid);
      --wc-row-hover: color-mix(in srgb, var(--text) 6%, transparent);
      position: relative;
      display: grid;
      grid-template-columns: var(--wc-side-w) minmax(0, 1fr);
      height: 100%;
      min-height: 0;
      overflow: hidden;
      transition: grid-template-columns 0.28s var(--wc-ease);
    }
    .wc--nav-expanded { --wc-side-w: calc(244px / var(--wc-zoom, 1)); }
    .wc--mid { --wc-side-w: calc(264px / var(--wc-zoom, 1)); }
    .wc--rail { grid-template-columns: var(--wc-rail-w) minmax(0, 1fr); }
    .wc--mobile { grid-template-columns: minmax(0, 1fr); }

    /* ── sidebar ── */
    .wc-side {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      background: var(--wc-side-bg);
      border-right: 1px solid var(--wc-border);
      backdrop-filter: var(--g-blur, none);
      -webkit-backdrop-filter: var(--g-blur, none);
    }
    /* Fixed-width inner column so the width animation clips instead of reflowing. */
    .wc-side-inner {
      display: flex;
      flex-direction: column;
      width: var(--wc-side-w);
      min-width: 100%;
      max-width: 100%;
      height: 100%;
      min-height: 0;
      animation: wc-fade-in 0.24s var(--wc-ease) both;
    }
    .wc--mobile .wc-side {
      position: absolute;
      inset: 0 auto 0 0;
      width: min(304px, 86vw);
      z-index: 30;
      background: var(--wc-side-solid);
      border-right-color: var(--wc-border-strong);
      box-shadow: 0 24px 64px color-mix(in srgb, #000 45%, transparent);
      transform: translateX(0);
      transition: transform 0.28s var(--wc-ease), box-shadow 0.28s var(--wc-ease);
    }
    .wc--mobile .wc-side-inner { width: 100%; }
    .wc--mobile.wc--collapsed .wc-side { transform: translateX(-104%); box-shadow: none; }
    .wc-backdrop {
      position: absolute;
      inset: 0;
      z-index: 20;
      background: color-mix(in srgb, var(--bg) 55%, transparent);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.24s var(--wc-ease);
    }
    .wc-backdrop--on { opacity: 1; pointer-events: auto; }

    /* rail */
    .wc-side--rail {
      align-items: center;
      gap: 6px;
      padding: 12px 0;
    }
    .wc-rail-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      animation: wc-fade-in 0.24s var(--wc-ease) both;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .wc-rail-btn svg { width: 18px; height: 18px; }
    .wc-rail-btn:hover { background: var(--wc-hover); color: var(--text-strong, var(--text)); }
    .wc-rail-btn--new {
      margin: 4px 0;
      color: var(--wc-accent);
      background: var(--wc-accent-soft);
      border-color: color-mix(in srgb, var(--wc-accent) 35%, transparent);
    }
    .wc-rail-btn--new:hover {
      color: var(--wc-accent);
      background: var(--wc-accent-soft);
      border-color: var(--wc-accent);
    }
    .wc-rail-btn:focus-visible, .wc-new:focus-visible, .wc-item:focus-visible, .wc-list-empty-btn:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--wc-accent) 70%, transparent);
      outline-offset: 1px;
    }

    /* sticky header: title + new chat + search */
    .wc-side-top {
      flex: none;
      padding: 12px 12px 10px;
      border-bottom: 1px solid transparent;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .wc-side-top--scrolled {
      border-bottom-color: color-mix(in srgb, var(--wc-border) 80%, transparent);
      box-shadow: 0 6px 14px -12px color-mix(in srgb, #000 60%, transparent);
    }
    .wc-side-head {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      margin-bottom: 10px;
      padding-left: 4px;
    }
    .wc-side-head-spacer { flex: 1; }
    .wc-brand {
      font-family: var(--font-display, inherit);
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0.01em;
      color: var(--text-strong, var(--text));
    }
    .wc-brand-count {
      min-width: 20px;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      color: var(--wc-accent);
      background: var(--wc-accent-soft);
    }
    .wc-new-row {
      display: flex;
      gap: 6px;
    }
    .wc-new-row .wc-new {
      flex: 1 1 auto;
      min-width: 0;
    }
    .wc-new-row .wc-new--group {
      flex: 0 0 auto;
      width: auto;
    }
    .wc-item-group {
      display: inline-flex;
      vertical-align: -2px;
      margin-right: 6px;
      color: var(--wc-accent);
    }
    .wc-item-group svg {
      width: 14px;
      height: 14px;
    }
    .wc-group {
      flex: 1;
      min-height: 0;
    }
    .wc-new {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      margin-bottom: 8px;
      padding: 9px 12px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid color-mix(in srgb, var(--wc-accent) 40%, transparent);
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--wc-accent) 16%, transparent),
        color-mix(in srgb, var(--wc-accent) 7%, transparent)
      );
      color: var(--text-strong, var(--text));
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      text-align: left;
      transition: border-color 0.15s, background 0.15s, transform 0.15s var(--wc-ease), box-shadow 0.15s;
    }
    .wc-new:hover {
      border-color: var(--wc-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wc-accent) 12%, transparent);
    }
    .wc-new:active { transform: translateY(1px); }
    .wc-new-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 7px;
      background: var(--wc-accent);
      color: var(--accent-foreground, #000);
    }
    .wc-new-ico svg { width: 14px; height: 14px; }
    .wc-search {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 10px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--wc-border);
      background: color-mix(in srgb, var(--bg) 40%, transparent);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .wc-search:focus-within {
      border-color: color-mix(in srgb, var(--wc-accent) 60%, transparent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wc-accent) 12%, transparent);
    }
    .wc-search-ico { display: inline-flex; color: var(--muted); }
    .wc-search-ico svg { width: 14px; height: 14px; }
    .wc-search input {
      flex: 1;
      min-width: 0;
      padding: 8px 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 13px;
    }
    .wc-search input::placeholder { color: var(--muted); }

    /* list */
    .wc-list {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 0 8px 16px;
      scrollbar-width: thin;
      scrollbar-color: transparent transparent;
      transition: scrollbar-color 0.2s;
    }
    .wc-list:hover { scrollbar-color: color-mix(in srgb, var(--muted) 40%, transparent) transparent; }
    .wc-list::-webkit-scrollbar { width: 8px; }
    .wc-list::-webkit-scrollbar-track { background: transparent; }
    .wc-list::-webkit-scrollbar-thumb {
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
      background-color: transparent;
    }
    .wc-list:hover::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 40%, transparent); }
    .wc-group { padding-bottom: 6px; }
    .wc-group-label {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 -8px 2px;
      padding: 12px 18px 6px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted-strong, var(--muted));
      background: linear-gradient(
        180deg,
        var(--wc-side-solid) 70%,
        color-mix(in srgb, var(--wc-side-solid) 0%, transparent)
      );
    }
    .wc-group-count {
      margin-left: auto;
      font-weight: 500;
      letter-spacing: 0;
      color: var(--muted);
      opacity: 0.7;
    }
    .wc-group-ico { display: inline-flex; color: var(--wc-accent); }
    .wc-group-ico svg { width: 12px; height: 12px; }
    .wc-group--pinned .wc-group-label { color: var(--wc-accent); }

    .wc-item {
      position: relative;
      display: flex;
      align-items: center;
      min-height: 48px;
      margin: 1px 0;
      padding: 7px 10px 7px 14px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid transparent;
      cursor: pointer;
      color: var(--text);
      outline: none;
      animation: wc-row-in 0.28s var(--wc-ease) both;
      transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .wc-item::before {
      content: "";
      position: absolute;
      left: 4px;
      top: 50%;
      width: 3px;
      height: 0;
      border-radius: 3px;
      background: var(--wc-accent);
      box-shadow: 0 0 10px color-mix(in srgb, var(--wc-accent) 60%, transparent);
      transform: translateY(-50%);
      transition: height 0.22s var(--wc-ease);
    }
    .wc-item:hover { background: var(--wc-row-hover); }
    .wc-item--active {
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--wc-accent) 16%, transparent),
        color-mix(in srgb, var(--wc-accent) 5%, transparent)
      );
      border-color: color-mix(in srgb, var(--wc-accent) 26%, transparent);
      color: var(--text-strong, var(--text));
    }
    .wc-item--active::before { height: 22px; }
    .wc-item--active:hover {
      background: linear-gradient(
        90deg,
        color-mix(in srgb, var(--wc-accent) 20%, transparent),
        color-mix(in srgb, var(--wc-accent) 8%, transparent)
      );
    }
    .wc-item-main {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .wc-item-title {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
    }
    .wc-item--active .wc-item-title { font-weight: 600; }
    .wc-item-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
      line-height: 1.3;
      color: var(--muted);
    }
    .wc-item-time { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .wc-item-agent {
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      padding: 0 6px;
      border-radius: 999px;
      border: 1px solid var(--wc-border);
      background: color-mix(in srgb, var(--bg) 30%, transparent);
    }
    .wc-item-agent + .wc-item-time::before { content: "·"; margin-right: 6px; opacity: 0.6; }
    .wc-item--active .wc-item-meta { color: var(--muted-strong, var(--muted)); }
    /* Actions float over the row's right edge; the text fades under them via
       a mask, so revealing them never shifts layout. */
    .wc-item-actions {
      position: absolute;
      right: 6px;
      top: 50%;
      display: inline-flex;
      align-items: center;
      gap: 1px;
      opacity: 0;
      pointer-events: none;
      transform: translate(4px, -50%);
      transition: opacity 0.15s, transform 0.18s var(--wc-ease);
    }
    .wc-item:hover .wc-item-actions,
    .wc-item:focus-visible .wc-item-actions,
    .wc-item:has(.wc-mini:focus-visible) .wc-item-actions,
    .wc--mobile .wc-item--active .wc-item-actions {
      opacity: 1;
      pointer-events: auto;
      transform: translate(0, -50%);
    }
    .wc-item:hover .wc-item-main,
    .wc-item:focus-visible .wc-item-main,
    .wc-item:has(.wc-mini:focus-visible) .wc-item-main,
    .wc--mobile .wc-item--active .wc-item-main {
      -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 96px), transparent calc(100% - 68px));
      mask-image: linear-gradient(90deg, #000 calc(100% - 96px), transparent calc(100% - 68px));
    }
    .wc-item-actions .wc-mini { width: 24px; height: 24px; border-radius: 7px; }
    .wc-item-actions .wc-mini svg { width: 13px; height: 13px; }
    .wc-rename {
      flex: 1;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid var(--wc-accent);
      background: var(--input, transparent);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      outline: none;
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--wc-accent) 14%, transparent);
    }

    /* empty / loading */
    .wc-list-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      margin: 28px 8px;
      padding: 20px 12px;
      text-align: center;
      border-radius: var(--wc-radius);
      border: 1px dashed var(--wc-border);
      color: var(--muted);
      font-size: 12px;
      animation: wc-fade-in 0.3s var(--wc-ease) both;
    }
    .wc-list-empty-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      margin-bottom: 4px;
      border-radius: 50%;
      color: var(--wc-accent);
      background: var(--wc-accent-soft);
    }
    .wc-list-empty-title { font-size: 13px; font-weight: 600; color: var(--text-strong, var(--text)); }
    .wc-list-empty-sub { max-width: 100%; overflow-wrap: anywhere; }
    .wc-list-empty-btn {
      margin-top: 6px;
      padding: 5px 12px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--wc-accent) 45%, transparent);
      background: transparent;
      color: var(--wc-accent);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }
    .wc-list-empty-btn:hover { background: var(--wc-accent-soft); }
    .wc-list-skel { padding: 12px 6px; }
    .wc-list-skel-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 8px; }
    .wc-list-skel-row i {
      display: block;
      height: 9px;
      width: 80%;
      border-radius: 6px;
      background: linear-gradient(90deg, var(--wc-hover), color-mix(in srgb, var(--wc-hover) 40%, transparent), var(--wc-hover));
      background-size: 200% 100%;
      animation: wc-shimmer 1.3s linear infinite;
    }
    .wc-list-skel-row i + i { width: 40%; height: 7px; }

    @keyframes wc-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes wc-row-in {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: none; }
    }
    @keyframes wc-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    @media (prefers-reduced-motion: reduce) {
      .wc, .wc-side, .wc-backdrop, .wc-item, .wc-item::before, .wc-item-actions, .wc-new, .wc-side-top {
        transition: none !important;
      }
      .wc-side-inner, .wc-rail-btn, .wc-item, .wc-list-empty, .wc-list-skel-row i { animation: none !important; }
    }

    /* ── buttons ── */
    .wc-icon-btn, .wc-mini {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      border-radius: 8px;
    }
    .wc-icon-btn { width: 34px; height: 34px; }
    .wc-icon-btn svg { width: 18px; height: 18px; }
    .wc-mini { width: 26px; height: 26px; }
    .wc-mini svg { width: 14px; height: 14px; }
    .wc-icon-btn:hover, .wc-mini:hover { background: var(--wc-hover); color: var(--text-strong, var(--text)); }
    .wc-mini--on { color: var(--wc-accent); }
    .wc-mini--danger:hover { color: var(--danger); background: var(--danger-subtle); }
    .wc-mini:disabled { opacity: 0.35; cursor: default; }
    .wc-btn {
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid var(--wc-border-strong);
      background: transparent;
      cursor: pointer;
      font-size: 13px;
    }
    .wc-btn--primary { background: var(--wc-accent); border-color: var(--wc-accent); color: var(--accent-foreground); }

    /* ── main ── */
    .wc-main {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .wc-top {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 52px;
      padding: 8px 14px;
      border-bottom: 1px solid color-mix(in srgb, var(--wc-border) 60%, transparent);
    }
    .wc-top-title {
      flex: 1;
      min-width: 0;
      text-align: center;
      font-size: 13px;
      color: var(--muted);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      padding-right: 8px;
    }
    .wc-offline {
      font-size: 11px;
      color: var(--warn);
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 1px 8px;
    }
    .wc-agent { position: relative; }
    .wc-agent-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 0;
      border-radius: var(--wc-radius-sm);
      background: transparent;
      cursor: pointer;
      font-size: 15px;
      font-weight: 600;
      color: var(--text-strong, var(--text));
    }
    .wc-agent-btn:hover { background: var(--wc-hover); }
    .wc-agent-name { max-width: 200px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .wc-chev { display: inline-flex; color: var(--muted); }
    .wc-chev svg { width: 14px; height: 14px; }
    .wc-agent-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 40;
      width: min(320px, 84vw);
      padding: 6px;
      border-radius: var(--wc-radius);
      border: 1px solid var(--wc-border-strong);
      background: var(--popover, var(--bg-elevated));
      box-shadow: var(--g-shadow, 0 12px 40px rgba(0, 0, 0, 0.4));
    }
    .wc-agent-filter {
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--wc-border);
      background: var(--input, transparent);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    .wc-agent-list { max-height: 320px; overflow-y: auto; }
    .wc-agent-opt {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      border: 0;
      border-radius: var(--wc-radius-sm);
      background: transparent;
      cursor: pointer;
      text-align: left;
      font-size: 13px;
    }
    .wc-agent-opt:hover { background: var(--wc-hover); }
    .wc-agent-opt--on { background: var(--wc-accent-soft); }
    .wc-agent-opt-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .wc-agent-opt-id { font-size: 11px; color: var(--muted); font-family: var(--mono); }
    .wc-agent-check { display: inline-flex; color: var(--wc-accent); }
    .wc-agent-emoji { width: 20px; text-align: center; }
    .wc-agent-none { padding: 12px 10px; color: var(--muted); font-size: 12px; }

    /* ── thread ── */
    .wc-scroll { flex: 1; min-height: 0; overflow-y: auto; scroll-behavior: auto; }
    .wc-col { width: 100%; max-width: 768px; margin: 0 auto; padding: 0 20px; }
    .wc-scroll .wc-col { padding-top: 24px; padding-bottom: 24px; display: flex; flex-direction: column; gap: 22px; }
    .wc-user { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
    .wc-bubble {
      max-width: min(85%, 620px);
      padding: 10px 16px;
      border-radius: 20px;
      background: var(--wc-surface-strong);
      border: 1px solid var(--wc-border);
      color: var(--text-strong, var(--text));
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.55;
    }
    .wc-user-imgs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .wc-img-wrap { position: relative; display: inline-flex; }
    .wc-img-ocr { position: absolute; right: 6px; bottom: 6px; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--wg-gold, #d9b45a) 45%, transparent); background: rgba(10, 11, 15, 0.72); color: var(--wg-gold, #d9b45a); font-size: 11px; font-weight: 600; cursor: pointer; }
    .wc-img-ocr svg { width: 12px; height: 12px; }
    .wc-img-ocr:focus-visible { outline: 2px solid var(--wg-gold, #d9b45a); outline-offset: 2px; }
    .wc-user-imgs img { max-width: 220px; max-height: 220px; border-radius: 12px; border: 1px solid var(--wc-border); object-fit: cover; }
    .wc-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
    .wc-user:hover .wc-actions, .wc-asst:hover .wc-actions, .wc-actions:focus-within { opacity: 1; }
    .wc--mobile .wc-actions { opacity: 1; }
    .wc-user--edit { align-items: stretch; }
    .wc-edit {
      width: 100%;
      min-height: 90px;
      padding: 12px 14px;
      border-radius: var(--wc-radius);
      border: 1px solid var(--wc-accent);
      background: var(--wc-surface-strong);
      color: var(--text);
      font: inherit;
      line-height: 1.5;
      resize: vertical;
      outline: none;
    }
    .wc-edit-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }

    .wc-asst { display: flex; flex-direction: column; gap: 6px; }
    .wc-asst-head { display: flex; align-items: center; gap: 8px; }
    .wc-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--wc-border-strong);
      background: var(--wc-accent-soft);
      color: var(--wc-accent);
      font-size: 14px;
    }
    /* Brand-logo avatars (img): fill the round frame, never distort. */
    .wc-avatar.chat-logo-avatar,
    .wc-empty-avatar.chat-logo-avatar {
      display: block;
      flex-shrink: 0;
      box-sizing: border-box;
      object-fit: contain;
      object-position: center;
      user-select: none;
    }
    .chat-logo-avatar--mark { object-view-box: inset(18% 21% 23% 20.5%); }
    .wc-asst-name { font-weight: 600; font-size: 13px; color: var(--text-strong, var(--text)); }
    .wc-asst-model { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 11px; color: var(--muted); font-family: var(--mono); }
    .wc-asst-body { padding-left: 36px; min-width: 0; }
    .wc-asst .wc-actions { padding-left: 32px; }

    .wc-md { line-height: 1.65; overflow-wrap: anywhere; }
    .wc-md > :first-child { margin-top: 0; }
    .wc-md > :last-child { margin-bottom: 0; }
    .wc-md p { margin: 0 0 0.8em; }
    .wc-md h1, .wc-md h2, .wc-md h3, .wc-md h4 { color: var(--text-strong, var(--text)); margin: 1.1em 0 0.5em; line-height: 1.3; }
    .wc-md h1 { font-size: 1.35em; } .wc-md h2 { font-size: 1.2em; } .wc-md h3 { font-size: 1.07em; }
    .wc-md a { color: var(--wc-accent); }
    .wc-md ul, .wc-md ol { padding-left: 1.4em; margin: 0 0 0.8em; }
    .wc-md li { margin: 0.2em 0; }
    .wc-md blockquote { margin: 0 0 0.8em; padding: 2px 14px; border-left: 3px solid var(--wc-accent); color: var(--muted); }
    .wc-md code { font-family: var(--mono); font-size: 0.88em; padding: 1px 5px; border-radius: 5px; background: var(--wc-surface-strong); }
    .wc-md table { border-collapse: collapse; display: block; overflow-x: auto; margin: 0 0 0.8em; }
    .wc-md th, .wc-md td { border: 1px solid var(--wc-border); padding: 6px 10px; }
    .wc-md th { background: var(--wc-surface); }
    .wc-md img { max-width: 100%; border-radius: 10px; }
    .wc-md hr { border: 0; border-top: 1px solid var(--wc-border); }
    .md-copyable--block {
      position: relative;
      display: block;
      margin: 0 0 0.9em;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--wc-border);
      background: var(--bg-accent, var(--bg));
      overflow: hidden;
    }
    .md-copyable--block pre { margin: 0; padding: 36px 14px 14px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; }
    .md-copyable--block pre code { padding: 0; background: transparent; font-size: inherit; }
    .md-copyable--inline { display: inline-flex; align-items: center; gap: 4px; }
    .md-copy-button {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 3px 10px;
      border-radius: 6px;
      border: 1px solid var(--wc-border);
      background: var(--wc-surface-strong);
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
    }
    .md-copy-button:hover, .md-copy-button:focus-visible, .md-copy-button[data-copied="1"] { color: var(--wc-accent); border-color: var(--wc-accent); outline: none; }
    .md-copy-button--inline { position: static; padding: 1px 5px; font-size: 9px; opacity: .15; }
    .md-copyable--inline:hover .md-copy-button--inline, .md-copy-button--inline:focus-visible, .md-copy-button--inline[data-copied="1"] { opacity: 1; }

    .wc-tool {
      margin: 0 0 0.8em;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--wc-border);
      background: var(--wc-surface);
      font-size: 12.5px;
    }
    .wc-tool summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      cursor: pointer;
      list-style: none;
      color: var(--muted);
    }
    .wc-tool summary::-webkit-details-marker { display: none; }
    .wc-tool-ico { display: inline-flex; color: var(--wc-accent); }
    .wc-tool-ico svg { width: 14px; height: 14px; }
    .wc-tool--pending .wc-tool-ico svg { animation: wc-spin 1s linear infinite; }
    .wc-tool-name { font-family: var(--mono); color: var(--text); }
    .wc-tool-state { flex: 1; font-size: 11px; }
    .wc-tool[open] .wc-chev { transform: rotate(90deg); }
    .wc-tool-sec { padding: 0 10px 10px; }
    .wc-tool-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 4px; }
    .wc-tool pre {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--bg-accent, var(--bg));
      font-family: var(--mono);
      font-size: 11.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .wc-typing { display: inline-flex; gap: 5px; padding: 8px 0; }
    .wc-rt {
      display: flex; align-items: center; gap: 11px; margin: 4px 0 6px; padding: 10px 14px;
      max-width: 520px; border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--wc-accent) 34%, transparent);
      background: color-mix(in srgb, var(--wc-accent) 8%, transparent);
    }
    .wc-rt--fail { border-color: rgba(255, 122, 122, 0.4); background: rgba(255, 122, 122, 0.08); }
    .wc-rt--ready { border-color: rgba(111, 208, 160, 0.4); background: rgba(111, 208, 160, 0.07); }
    .wc-rt-ico { display: inline-flex; width: 18px; height: 18px; flex: none; color: var(--wc-accent); }
    .wc-rt--fail .wc-rt-ico { color: #ff7a7a; }
    .wc-rt--ready .wc-rt-ico { color: #6fd0a0; }
    .wc-rt-ico svg { width: 100%; height: 100%; }
    .wc-rt-spin { animation: wc-rt-spin 0.9s linear infinite; }
    @keyframes wc-rt-spin { to { transform: rotate(360deg); } }
    .wc-rt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
    .wc-rt-msg { font-size: 13.5px; font-weight: 550; line-height: 1.35; }
    .wc-rt-bar { display: block; height: 3px; border-radius: 99px; background: rgba(127, 127, 127, 0.18); overflow: hidden; }
    .wc-rt-bar span { display: block; height: 100%; border-radius: inherit; background: var(--wc-accent); transition: width 1s linear; }
    .wc-rt-time { font-size: 11.5px; opacity: 0.6; font-variant-numeric: tabular-nums; }
    .wc-thinking { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12.5px; }
    .wc-thinking-label b { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text); }
    .wc-tool-state { font-variant-numeric: tabular-nums; }
    .wc-md--timeout {
      padding: 10px 14px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--warn-muted, rgba(234, 179, 8, 0.45));
      background: var(--warn-subtle, rgba(234, 179, 8, 0.08));
    }
    .wc-timeout-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
    .wc-continue { display: inline-flex; align-items: center; gap: 6px; }
    .wc-continue svg { width: 14px; height: 14px; }
    .wc-timeout-hint { font-size: 11.5px; color: var(--muted); }
    .wc-typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--wc-accent); animation: wc-bounce 1.2s infinite ease-in-out; }
    .wc-typing i:nth-child(2) { animation-delay: 0.15s; }
    .wc-typing i:nth-child(3) { animation-delay: 0.3s; }
    .wc-caret { display: inline-block; width: 8px; height: 16px; margin-left: 2px; background: var(--wc-accent); vertical-align: text-bottom; animation: wc-blink 1s steps(2) infinite; }
    .wc-error {
      padding: 10px 14px;
      border-radius: var(--wc-radius-sm);
      border: 1px solid var(--danger-muted, var(--danger));
      background: var(--danger-subtle);
      color: var(--danger);
      font-size: 13px;
    }
    .wc-skel { display: flex; flex-direction: column; gap: 14px; }
    .wc-skel div { height: 16px; border-radius: 8px; background: var(--wc-surface-strong); animation: wc-pulse 1.4s infinite; }
    .wc-skel div:nth-child(1) { width: 40%; align-self: flex-end; }
    .wc-skel div:nth-child(2) { width: 90%; }
    .wc-skel div:nth-child(3) { width: 70%; }

    /* ── composer ── */
    /* Bottom padding clears the app-wide floating <cmo-chat> launcher
       (fixed, bottom-centre) so it never sits on top of the composer. */
    .wc-dock { padding: 8px 0 100px; }
    .wc-composer {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 10px 8px 14px;
      border-radius: 24px;
      border: 1px solid var(--wc-border-strong);
      background: var(--wc-surface-strong);
      box-shadow: var(--g-shadow-sm, none);
      backdrop-filter: var(--g-blur, none);
      -webkit-backdrop-filter: var(--g-blur, none);
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .wc-composer:focus-within { border-color: var(--wc-accent); box-shadow: var(--g-glow-primary, var(--focus-glow, none)); }
    .wc-input {
      width: 100%;
      min-height: 26px;
      max-height: 240px;
      padding: 4px 2px;
      border: 0;
      outline: 0;
      resize: none;
      background: transparent;
      color: var(--text-strong, var(--text));
      font: inherit;
      font-size: 15px;
      line-height: 1.5;
    }
    .wc-input::placeholder { color: var(--muted); }
    .wc-composer-row { display: flex; align-items: center; gap: 6px; }
    /* ── Agent | CLI mode (chat-mode-switcher) ── */
    .wc-composer { position: relative; }
    .wc-mode-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      max-width: 260px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--wc-border);
      background: color-mix(in srgb, var(--text) 4%, transparent);
      color: var(--muted-strong, var(--muted));
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .wc-mode-chip svg { width: 14px; height: 14px; flex-shrink: 0; }
    .wc-mode-chip:hover { color: var(--text); border-color: var(--wc-border-strong); }
    .wc-mode-chip--cli {
      color: var(--text);
      border-color: color-mix(in srgb, var(--wc-accent) 55%, transparent);
      background: color-mix(in srgb, var(--wc-accent) 14%, transparent);
    }
    .wc-mode-chip-lbl { overflow: hidden; text-overflow: ellipsis; }
    .wc-mode-chip-sub {
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--mono);
      font-weight: 500;
      font-size: 11px;
      color: var(--muted);
    }
    .wc-route-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid var(--wc-border);
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--muted);
      white-space: nowrap;
    }
    .wc-route-badge svg { width: 11px; height: 11px; }
    .wc-route-badge--cli {
      color: var(--text);
      border-color: color-mix(in srgb, var(--wc-accent) 45%, transparent);
      background: color-mix(in srgb, var(--wc-accent) 10%, transparent);
    }
    .wc-user-route { display: flex; justify-content: flex-end; margin-top: 4px; }
    .wc-avatar.wc-avatar--cli {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--text) 6%, transparent);
    }
    .wc-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 6px 0;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 600;
    }
    .wc-divider::before, .wc-divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--wc-border-strong), transparent);
    }
    .wc-divider-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      border: 1px solid var(--wc-border);
      background: var(--wc-surface);
    }
    .wc-divider-chip svg { width: 13px; height: 13px; }
    .wc-cli-tools {
      border: 1px solid var(--wc-border);
      border-radius: var(--wc-radius-sm);
      background: color-mix(in srgb, var(--text) 2.5%, transparent);
      margin: 4px 0 8px;
    }
    .wc-cli-tools > summary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 11px;
      cursor: pointer;
      list-style: none;
      font-size: 12.5px;
      color: var(--muted-strong, var(--muted));
    }
    .wc-cli-tools > summary::-webkit-details-marker { display: none; }
    .wc-cli-tools > summary .wc-tool-state {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--mono);
      font-size: 11px;
    }
    .wc-cli-tools[open] > summary .wc-chev { transform: rotate(90deg); }
    .wc-cli-tools-list { display: grid; gap: 6px; padding: 0 8px 8px; }
    .wc-cli-tools--live > summary { color: var(--text); }
    .wc-route-hints {
      display: grid;
      gap: 2px;
      padding: 4px;
      margin: -2px -4px 4px;
      border-radius: 14px;
      border: 1px solid var(--wc-border);
      background: var(--wc-surface);
    }
    .wc-route-hint {
      display: flex;
      align-items: baseline;
      gap: 10px;
      padding: 6px 10px;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 12.5px;
      text-align: left;
      cursor: pointer;
    }
    .wc-route-hint:hover { background: var(--wc-hover); }
    .wc-route-hint code { font-family: var(--mono); color: var(--wc-accent); }
    .wc-route-hint span { color: var(--muted); }
    .wc-hint { flex: 1; font-size: 11px; color: var(--muted-strong, var(--muted)); }
    .wc-send {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 0;
      cursor: pointer;
      background: var(--wc-accent);
      color: var(--accent-foreground);
      transition: opacity 0.15s, transform 0.1s;
    }
    .wc-send:disabled { opacity: 0.3; cursor: default; }
    .wc-send:not(:disabled):active { transform: scale(0.94); }
    .wc-send--stop { background: var(--text-strong, var(--text)); color: var(--bg); }
    .wc-atts { display: flex; gap: 8px; flex-wrap: wrap; padding-bottom: 4px; }
    .wc-att { position: relative; }
    .wc-att img { width: 56px; height: 56px; object-fit: cover; border-radius: 10px; border: 1px solid var(--wc-border); }
    .wc-att--video {
      min-width: 240px; max-width: min(560px, 100%); border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--wg-gold, #d9b45a) 35%, var(--wc-border));
      background: color-mix(in srgb, var(--wg-gold, #d9b45a) 6%, transparent);
    }
    .wc-att-video { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 6px 8px; padding: 8px 30px 8px 8px; }
    .wc-att-video-ic { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: var(--wg-gold, #d9b45a); background: rgba(255, 255, 255, 0.05); }
    .wc-att-video-ic svg { width: 16px; height: 16px; }
    .wc-att-video-name { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wc-att-video ib-video-attach-picker { grid-column: 1 / -1; }
    .wc-att-x {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 20px;
      height: 20px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--wc-border-strong);
      background: var(--bg-elevated);
      cursor: pointer;
      padding: 0;
    }
    .wc-att-x svg { width: 11px; height: 11px; }

    /* ── empty state ── */
    .wc-empty { flex: 1; min-height: 0; overflow-y: auto; display: flex; align-items: center; justify-content: center; padding: 24px 20px; }
    .wc-empty-inner { width: 100%; max-width: 720px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .wc-empty-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      font-size: 26px;
      border: 1px solid var(--wc-border-strong);
      background: var(--wc-accent-soft);
      color: var(--wc-accent);
      box-shadow: var(--g-glow-primary, none);
    }
    .wc-empty-avatar svg { width: 26px; height: 26px; }
    .wc-greet { margin: 6px 0 0; font-size: clamp(24px, 4vw, 34px); font-weight: 600; color: var(--text-strong, var(--text)); letter-spacing: -0.01em; }
    .wc-sub { margin: 0 0 14px; color: var(--muted); text-align: center; }
    .wc-sub strong { color: var(--wc-accent); font-weight: 600; }
    .wc-composer--hero { width: 100%; }
    .wc-composer--secure, .wc-composer--secure:focus-within {
      border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
      box-shadow: var(--ib-secure-glow, 0 0 0 1px rgba(52, 211, 153, 0.35));
    }
    .wc-secure-badge {
      display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 2px 9px; border-radius: 999px;
      font-size: 11.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--ib-secure, #34d399); background: var(--ib-secure-soft, rgba(52, 211, 153, 0.13));
      border: 1px solid var(--ib-secure-ring, rgba(52, 211, 153, 0.5));
    }
    .wc-secure-badge svg { width: 12px; height: 12px; }
    @media (max-width: 640px) { .wc-secure-badge__text { display: none; } }
    .wc-secure-badge--locked { color: var(--muted); background: transparent; border-style: dashed; }
    .wc-secure-toggle { flex: none; }
    .wc-item-secure { display: inline-flex; color: var(--ib-secure, #34d399); margin-right: 4px; vertical-align: -2px; }
    .wc-item-secure svg { width: 12px; height: 12px; }
    .wc-chips { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; width: 100%; margin-top: 10px; }
    .wc-chip {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 14px;
      border-radius: var(--wc-radius);
      border: 1px solid var(--wc-border);
      background: var(--wc-surface);
      text-align: left;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .wc-chip:hover { border-color: var(--wc-accent); background: var(--wc-hover); }
    .wc-first-chips { margin: 6px 0 4px; }
    .wc-first-chip { text-align: left; min-height: 56px; cursor: pointer; font: inherit; color: inherit; }
    .wc-first-chip .wc-chip-sub { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .wc-first-hint {
      display: inline-flex; align-items: center; gap: 6px; margin: 6px 0 -2px; font-size: 12.5px; color: var(--wc-accent);
      animation: wc-first-nudge 1.8s ease-in-out infinite;
    }
    .wc-first-hint svg { width: 14px; height: 14px; }
    @keyframes wc-first-nudge { 0%, 100% { transform: translateY(0); opacity: 0.75; } 50% { transform: translateY(3px); opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .wc-first-hint { animation: none; } }
    .wc-chip-title { font-weight: 600; font-size: 13px; color: var(--text-strong, var(--text)); }
    .wc-chip-sub { font-size: 12px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

    .wc-toast {
      position: absolute;
      left: 50%;
      top: 64px;
      transform: translateX(-50%);
      z-index: 50;
      max-width: min(90%, 480px);
      padding: 9px 16px;
      border-radius: 999px;
      border: 1px solid var(--wc-border-strong);
      background: var(--popover, var(--bg-elevated));
      box-shadow: var(--g-shadow-sm, none);
      font-size: 13px;
    }

    @media (max-width: 820px) {
      .wc-col { padding: 0 12px; }
      .wc-chips { grid-template-columns: minmax(0, 1fr); }
      .wc-hint { display: none; }
      .wc-bubble { max-width: 88%; }
      .wc-asst-body { padding-left: 0; }
      .wc-asst .wc-actions { padding-left: 0; }
      .wc-agent-name { max-width: 140px; }
      .wc-top { padding: 8px 8px; }
    }

    /* ── Premium glass layer (styles/glass, docs/ui/GLASS.md) ─────────
       Reads the global --glass-* tokens (they pierce the shadow root), so
       theme, palette, reduced-transparency and reduced-motion all follow.
       Assistant = frosted glass bubble; user = solid gold-tint bubble. */
    :host {
      font-family: var(--glass-font, inherit);
      --wc-side-solid: var(--glass-solid, var(--bg-elevated));
    }
    .wc { --wc-side-bg: var(--glass-sheen), var(--glass-1, var(--wc-side-solid)); }
    .wc-side {
      backdrop-filter: var(--glass-blur, none);
      -webkit-backdrop-filter: var(--glass-blur, none);
      border-right: 1px solid var(--glass-stroke, var(--wc-border));
      box-shadow: inset -1px 0 0 rgba(255, 255, 255, 0.02);
    }
    .wc--mobile .wc-side { background: var(--glass-sheen), var(--glass-4, var(--wc-side-solid)); box-shadow: var(--glass-elev-4); }
    .wc-brand { font: 600 15px/1.2 var(--font-ui-display, inherit); letter-spacing: -0.015em; }
    .wc-new {
      border-radius: var(--glass-radius-sm, 10px);
      background: var(--glass-sheen), var(--glass-gold-tint);
      border: 1px solid color-mix(in srgb, var(--glass-gold) 40%, transparent);
      box-shadow: var(--glass-specular), 0 10px 26px -16px var(--glass-gold-a40);
      color: var(--glass-fg);
      font-weight: 600;
      transition: transform var(--glass-dur-fast) var(--glass-spring), box-shadow var(--glass-dur) var(--glass-ease), border-color var(--glass-dur-fast);
    }
    .wc-new:hover { transform: var(--glass-lift); border-color: color-mix(in srgb, var(--glass-gold) 70%, transparent); box-shadow: var(--glass-specular), 0 14px 30px -14px color-mix(in srgb, var(--glass-gold) 60%, transparent); }
    .wc-new:active { transform: scale(0.98); }
    .wc-new-ico { background: var(--glass-gold-fill); color: var(--glass-ink); box-shadow: 0 0 12px var(--glass-gold-a40); }
    .wc-search {
      border-radius: var(--glass-radius-sm, 10px);
      background: color-mix(in srgb, var(--glass-base) 45%, transparent);
      border-color: var(--glass-stroke);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.25);
    }
    .wc-search:focus-within { border-color: color-mix(in srgb, var(--glass-gold) 60%, transparent); box-shadow: var(--glass-focus-ring); }
    .wc-group-label { font-family: var(--glass-font); letter-spacing: var(--glass-tracking-caps); color: var(--glass-fg-4); }
    .wc-item { border-radius: var(--glass-radius-sm, 10px); transition: background-color var(--glass-dur-fast), border-color var(--glass-dur-fast), transform var(--glass-dur-fast) var(--glass-spring); }
    .wc-item:hover { background: var(--glass-hover); border-color: var(--glass-stroke); }
    .wc-item:active { transform: scale(0.99); }
    .wc-item--active,
    .wc-item--active:hover {
      background: linear-gradient(90deg, var(--glass-gold-a16), var(--glass-gold-a06) 60%, transparent), var(--glass-hover);
      border-color: color-mix(in srgb, var(--glass-gold) 26%, transparent);
      box-shadow: var(--glass-specular), 0 8px 22px -14px var(--glass-gold-a40);
    }
    .wc-item--active::before { background: var(--glass-gold-fill); }
    .wc-item-title { font-weight: 500; letter-spacing: -0.006em; }
    .wc-item-meta, .wc-item-time { font-variant-numeric: tabular-nums; color: var(--glass-fg-4); }

    .wc-top {
      background: var(--glass-sheen), color-mix(in srgb, var(--glass-2) 70%, transparent);
      backdrop-filter: var(--glass-blur-sm, none);
      -webkit-backdrop-filter: var(--glass-blur-sm, none);
      border-bottom: 1px solid var(--glass-stroke);
      position: relative;
      z-index: 2;
    }
    .wc-top-title { color: var(--glass-fg-3); font-weight: 500; }
    .wc-agent-btn { border-radius: var(--glass-radius-sm, 10px); }
    .wc-agent-btn:hover { background: var(--glass-hover); }
    .wc-agent-menu {
      background: var(--glass-sheen), var(--glass-4);
      backdrop-filter: var(--glass-blur-lg, none);
      -webkit-backdrop-filter: var(--glass-blur-lg, none);
      border: 1px solid var(--glass-stroke-strong);
      border-radius: var(--glass-radius, 14px);
      box-shadow: var(--glass-elev-4);
    }
    /* Transcript fades under the header/composer instead of hard-cutting. */
    .wc-scroll {
      -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 18px, #000 calc(100% - 22px), transparent 100%);
      mask-image: linear-gradient(180deg, transparent 0, #000 18px, #000 calc(100% - 22px), transparent 100%);
    }
    .wc-scroll .wc-col { gap: 26px; }

    .wc-bubble {
      padding: 11px 16px;
      border-radius: 20px 20px 6px 20px;
      background: var(--glass-gold-tint);
      border: 1px solid color-mix(in srgb, var(--glass-gold) 34%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 12px 30px -18px var(--glass-gold-a40);
      color: var(--glass-fg);
      font-size: 14.5px;
      letter-spacing: -0.004em;
      animation: wc-msg-in var(--glass-dur-slow) var(--glass-spring) both;
    }
    .wc-asst { animation: wc-msg-in var(--glass-dur-slow) var(--glass-spring) both; }
    .wc-avatar { border-color: color-mix(in srgb, var(--glass-gold) 40%, transparent); box-shadow: 0 0 0 3px var(--glass-gold-a06), 0 4px 14px -4px var(--glass-gold-a40); }
    .wc-asst-name { letter-spacing: -0.005em; }
    .wc-asst-model { color: var(--glass-fg-4); }
    .wc-asst-body {
      position: relative;
      margin-left: 36px;
      padding: 14px 18px;
      border-radius: 6px 20px 20px 20px;
      background: var(--glass-sheen), var(--glass-3);
      border: 1px solid var(--glass-stroke);
      border-top-color: var(--glass-stroke-strong);
      box-shadow: var(--glass-elev-1);
      color: var(--glass-fg);
      font-size: 14.5px;
      letter-spacing: -0.004em;
    }
    .wc-asst-body::before {
      content: "";
      position: absolute;
      left: 18px;
      right: 40%;
      top: -1px;
      height: 1px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--glass-gold) 55%, transparent), transparent);
      pointer-events: none;
    }
    .wc-md h1, .wc-md h2, .wc-md h3 { font-family: var(--font-ui-display, inherit); letter-spacing: -0.015em; }
    .wc-md code { font-family: var(--glass-font-mono); background: var(--glass-gold-a10); border: 1px solid var(--glass-stroke-gold); color: var(--glass-gold-hi); }
    :host-context([data-theme="light"]) .wc-md code { color: var(--glass-gold-deep); }
    .wc-md table {
      display: table;
      border-collapse: separate;
      border-spacing: 0;
      border: 1px solid var(--glass-stroke);
      border-radius: 12px;
      overflow: hidden;
      font-variant-numeric: tabular-nums;
      background: color-mix(in srgb, var(--glass-base) 30%, transparent);
    }
    .wc-md th, .wc-md td { border: 0; border-bottom: 1px solid var(--glass-stroke); padding: 8px 14px; }
    .wc-md tr:last-child td { border-bottom: 0; }
    .wc-md th { background: var(--glass-hover); color: var(--glass-fg-3); font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; text-align: left; }
    .wc-md td + td, .wc-md th + th { border-left: 1px solid var(--glass-stroke); }
    .wc-md pre, .md-copyable--block pre { border-radius: 12px; border: 1px solid var(--glass-stroke); background: color-mix(in srgb, var(--glass-base) 70%, transparent); }

    .wc-tool {
      border-radius: 12px;
      border: 1px solid var(--glass-stroke);
      background: var(--glass-sheen), var(--glass-2);
      box-shadow: var(--glass-specular);
      transition: border-color var(--glass-dur-fast), box-shadow var(--glass-dur);
      overflow: hidden;
    }
    .wc-tool:hover, .wc-tool[open] { border-color: var(--glass-stroke-gold); box-shadow: var(--glass-specular), var(--glass-glow-soft); }
    .wc-tool summary { padding: 8px 12px; gap: 10px; }
    .wc-tool-ico {
      width: 22px; height: 22px; justify-content: center; align-items: center;
      border-radius: 7px;
      background: var(--glass-gold-a10);
      box-shadow: inset 0 0 0 1px var(--glass-stroke-gold);
      color: var(--glass-gold);
    }
    .wc-tool-name { font-family: var(--glass-font-mono); font-size: 12px; font-weight: 500; color: var(--glass-fg); }
    .wc-tool-state { flex: 1; display: inline-flex; }
    .wc-tool-state:not(:empty) {
      flex: 0 0 auto;
      margin-right: auto;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 600;
      color: #6fe3a4;
      background: rgba(111, 227, 164, 0.1);
      border: 1px solid rgba(111, 227, 164, 0.28);
    }
    .wc-tool--pending .wc-tool-state {
      color: var(--glass-gold);
      background: var(--glass-gold-a10);
      border-color: var(--glass-stroke-gold);
    }
    .wc-tool--pending { border-color: var(--glass-stroke-gold); }
    .wc-tool pre { border-radius: 10px; background: color-mix(in srgb, var(--glass-base) 70%, transparent); border: 1px solid var(--glass-stroke); }
    .wc-typing i { background: var(--glass-gold); box-shadow: 0 0 8px var(--glass-gold-a40); }
    .wc-caret { width: 2px; border-radius: 2px; background: var(--glass-gold); box-shadow: 0 0 10px var(--glass-gold); }

    .wc-dock { position: relative; }
    .wc-composer {
      border-radius: 26px;
      border: 1px solid var(--glass-stroke-strong);
      background: var(--glass-sheen), var(--glass-2);
      backdrop-filter: var(--glass-blur, none);
      -webkit-backdrop-filter: var(--glass-blur, none);
      box-shadow: var(--glass-elev-3);
      transition: border-color var(--glass-dur) var(--glass-ease), box-shadow var(--glass-dur) var(--glass-ease);
    }
    .wc-composer:focus-within {
      border-color: color-mix(in srgb, var(--glass-gold) 60%, transparent);
      box-shadow: var(--glass-elev-3), var(--glass-focus-ring), 0 0 48px -14px var(--glass-gold-a40);
    }
    .wc-input { font-family: var(--glass-font); letter-spacing: -0.004em; color: var(--glass-fg); }
    .wc-input::placeholder { color: var(--glass-fg-4); }
    .wc-hint { color: var(--glass-fg-4); }
    .wc-send {
      background: var(--glass-gold-fill);
      color: var(--glass-ink);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45), 0 6px 18px -6px var(--glass-gold-a40);
      transition: transform var(--glass-dur-fast) var(--glass-spring), opacity var(--glass-dur-fast), box-shadow var(--glass-dur);
    }
    .wc-send:not(:disabled):hover { transform: translateY(-1px) scale(1.04); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 10px 24px -6px color-mix(in srgb, var(--glass-gold) 65%, transparent); }
    .wc-send:disabled { opacity: 0.35; box-shadow: none; }
    .wc-icon-btn { border-radius: var(--glass-radius-sm, 10px); transition: background-color var(--glass-dur-fast), color var(--glass-dur-fast), transform var(--glass-dur-fast) var(--glass-spring); }
    .wc-icon-btn:hover { background: var(--glass-hover); color: var(--glass-gold); }
    .wc-icon-btn:active { transform: scale(0.94); }
    .wc-chip {
      border-radius: var(--glass-radius, 14px);
      background: var(--glass-sheen), var(--glass-2);
      border-color: var(--glass-stroke);
      box-shadow: var(--glass-elev-1);
      transition: transform var(--glass-dur) var(--glass-spring), border-color var(--glass-dur-fast), box-shadow var(--glass-dur);
    }
    .wc-chip:hover { transform: var(--glass-lift); border-color: var(--glass-stroke-gold); box-shadow: var(--glass-elev-2), var(--glass-glow-soft); }
    .wc-greet { font-family: var(--font-ui-display, inherit); letter-spacing: -0.025em; }
    @media (max-width: 820px) {
      .wc-asst-body { margin-left: 0; padding: 12px 14px; }
      .wc-scroll .wc-col { gap: 20px; }
    }
    /* ── Transcript width + text zoom (chat/chat-view-prefs.ts) ────────
       --chat-col-max: "none" (Full width) or a zoom-scaled prose cap
       (Centered). --chat-tz scales transcript text via font-size only.
       Phones (wc--mobile) keep the original column + padding. */
    .wc:not(.wc--mobile) .wc-col {
      max-width: var(--chat-col-max, 768px);
      padding-left: clamp(20px, 2vw, 32px);
      padding-right: clamp(20px, 2vw, 32px);
    }
    .wc--w-full:not(.wc--mobile) .wc-bubble { max-width: min(78%, calc(960px * var(--chat-tz, 1))); }
    .wc--w-centered .wc-bubble { max-width: min(85%, calc(620px * var(--chat-tz, 1))); }
    .wc-bubble, .wc-asst-body, .wc-edit { font-size: calc(14.5px * var(--chat-tz, 1)); }
    .wc-asst-name { font-size: calc(13px * var(--chat-tz, 1)); }
    .wc-asst-model { font-size: calc(11px * var(--chat-tz, 1)); }
    .md-copyable--block pre { font-size: calc(12.5px * var(--chat-tz, 1)); }
    .md-copy-button { font-size: calc(11px * var(--chat-tz, 1)); }
    .wc-md th { font-size: calc(11px * var(--chat-tz, 1)); }
    .wc-tool { font-size: calc(12.5px * var(--chat-tz, 1)); }
    .wc-tool-name { font-size: calc(12px * var(--chat-tz, 1)); }
    .wc-tool-state:not(:empty) { font-size: calc(10.5px * var(--chat-tz, 1)); }
    .wc-tool-lbl { font-size: calc(10px * var(--chat-tz, 1)); }
    .wc-tool pre { font-size: calc(11.5px * var(--chat-tz, 1)); max-height: calc(280px * var(--chat-tz, 1)); }
    .wc-tool-ico svg { width: calc(14px * var(--chat-tz, 1)); height: calc(14px * var(--chat-tz, 1)); }
    .wc-error { font-size: calc(13px * var(--chat-tz, 1)); }
    .wc-input { font-size: calc(15px * var(--chat-tz, 1)); }
    .wc-top ib-chat-view-controls { margin-left: auto; }
    /* Phones: the squeezed session title collapses to a stray glyph — the zoom control takes its slot. */
    .wc--mobile .wc-top-title { display: none; }
    /* backdrop-filter makes the topbar the containing block for the model
       picker's position:fixed bottom sheet, which then hangs off the topbar
       (clipped under the nav) instead of the viewport. Phones: no topbar blur. */
    .wc--mobile .wc-top { backdrop-filter: none; -webkit-backdrop-filter: none; }

    @keyframes wc-msg-in { from { opacity: 0; transform: translateY(6px) scale(0.995); } to { opacity: 1; transform: none; } }

    @keyframes wc-bounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }
    @keyframes wc-blink { to { opacity: 0; } }
    @keyframes wc-spin { to { transform: rotate(360deg); } }
    @keyframes wc-pulse { 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) {
      .wc, .wc-side { transition: none; }
      .wc-rt-spin, .wc-typing i, .wc-caret, .wc-skel div, .wc-tool--pending .wc-tool-ico svg, .wc-bubble, .wc-asst { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "webchat-view": WebchatView;
  }
}
