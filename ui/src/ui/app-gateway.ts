import { accessPreviewToken, ensureAccessMe } from "./access/access-session";
import { loadChatHistory } from "./controllers/chat";
import { OCR_CHANGED_EVENT, OCR_WINDOW_EVENT } from "./file-ocr";
import { attachSecureClient, handleSecureGatewayEvent } from "./secure-mode/store";
import { attachLocalRuntimesClient, handleLocalRuntimesEvent } from "./local-runtimes/store";
import { LOCAL_VOICE_PROGRESS_EVENT, LOCAL_VOICE_WINDOW_EVENT } from "./onboarding/local-voice-model";
import {
  isKanbanTaskUpdatedPayload,
  KANBAN_TASK_UPDATED_EVENT,
  recentlyAppliedTaskUpdate,
} from "./controllers/kanban-live";
import { openedAtRoot, pluginLanding, syncPluginHost } from "./plugin-host.js";
import { navigateToDeepLink } from "./deep-link-route.js";
import { noteGatewayEvent as noteChatFollowEvent } from "./chat/chat-follow-nav";

/** A plugin landing page is applied at most once per page load. */
let pluginLandingApplied = false;
import { loadDevices } from "./controllers/devices";
import { loadNodes } from "./controllers/nodes";
import { loadAgentsMgmt as loadAgents } from "./controllers/agents";
import { initFederationSync, disposeFederationSync, getFederationSync } from "./controllers/federation-sync";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway";
import { GatewayBrowserClient, isUserSessionToken } from "./gateway";
import {
  ensureGatewaySession,
  getGatewayHttpCredentials,
  setGatewayHttpCredentials,
} from "./gateway-http-auth";
import { loadDeviceAuthToken } from "./device-auth";
import { loadOrCreateDeviceIdentity } from "./device-identity";
import type { EventLogEntry } from "./app-events";
import type { AgentsListResult, PresenceEntry, HealthSnapshot, StatusSummary } from "./types";
import { contentTabOf, type Tab } from "./navigation";
import { saveSettings, type UiSettings } from "./storage";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream";
import { flushChatQueueForEvent } from "./app-chat";
import {
  applySettings,
  refreshActiveTab,
  setLastActiveSessionKey,
} from "./app-settings";
import { handleChatEvent, handleChatNotice, type ChatEventPayload } from "./controllers/chat";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval";
import type { InfiniBotApp } from "./app";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import { loadAssistantIdentity } from "./controllers/assistant-identity";
import { addNotification, type NotificationsState } from "./controllers/notifications";
import { writeToXterm, getXtermInstance } from "./controllers/terminals";
import { onSetupGatewayHello } from "./controllers/nav-setup-status";

const TAB_INSTANCE_ID_KEY = "infinibot.tabInstanceId";

/**
 * Stable id for THIS browser tab (or Electron window). MUST use
 * sessionStorage rather than localStorage — localStorage is shared across
 * every tab of the same origin so all 5 tabs of InfiniBot would end up with
 * the same id, defeating the whole point. sessionStorage is per-tab and
 * persists across reloads of THAT tab, which is exactly what we want for
 * multi-monitor routing.
 *
 * Falls back to a per-load uuid if sessionStorage isn't available (SSR,
 * sandboxed iframe, private-mode quirk).
 */
function resolveTabInstanceId(): string {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      const existing = window.sessionStorage.getItem(TAB_INSTANCE_ID_KEY);
      if (existing && existing.length > 0) return existing;
      const fresh = crypto.randomUUID();
      window.sessionStorage.setItem(TAB_INSTANCE_ID_KEY, fresh);
      return fresh;
    }
  } catch {
    /* sandboxed / SSR / private mode — fall through */
  }
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Force a tab tag onto document.title even before branding has loaded.
 *
 * Two forms:
 *   - [Alpha] InfiniBot — Master Terminal       (after gateway assigns a codename)
 *   - [infinibot:abc123] InfiniBot — …          (early fallback before connect)
 *
 * The codename is the voice-friendly handle — users say "open notes on
 * Alpha". The branding controller re-applies on every branding update
 * (see app-branding.ts:applyBrandingToDom) and preserves whichever form is
 * current. The strip regex below matches both shapes so reloads and
 * codename upgrades don't accumulate prefixes.
 */
export function applyTabTag(label: string): void {
  if (typeof document === "undefined") return;
  const current = document.title || "InfiniBot";
  const stripped = current.replace(/^\[(?:infinibot:[0-9a-f]+|[A-Za-z][A-Za-z\d-]*)\]\s*/i, "");
  const next = `[${label}] ${stripped}`;
  if (document.title !== next) document.title = next;
}
function ensureTitleTag(instanceId: string): void {
  applyTabTag(`infinibot:${instanceId.replace(/-/g, "").slice(0, 6)}`);
}

/**
 * After connect, ask the gateway for our codename and upgrade the title
 * from the fallback hex tag to the human-readable form ([Alpha], [Bravo]
 * etc).
 *
 * Uses the dedicated `ui.my_codename` method rather than scanning
 * `ui.list_clients` because two tabs that share an instanceId (browser tab
 * duplication copies sessionStorage) would otherwise both find the FIRST
 * matching entry and end up with the same codename. ui.my_codename is
 * resolved server-side by connId, which is always unique per WebSocket
 * regardless of what instanceId the client claims.
 */
async function refreshCodenameFromGateway(host: GatewayHost): Promise<void> {
  if (!host.client) return;
  try {
    const res = (await host.client.request("ui.my_codename", {})) as
      | { codename?: string | null; connId?: string }
      | undefined;
    if (res?.codename) {
      applyTabTag(res.codename);
      // Push codename into the wake-coordinator so it can register
      // "hey <codename> *" routing variants for this peer.
      void import("./controllers/wake-coordinator.js").then(({ setWakeCoordSelfCodename }) => {
        setWakeCoordSelfCodename(res.codename!);
      }).catch(() => { /* coordinator not yet bundled — non-fatal */ });
      // Register "hey <codename>" as a local wake on this tab — fires the
      // live-action + side-panel handler bound by app-render.
      void import("./controllers/window-wake.js").then(({ setWindowWakeCodename }) => {
        setWindowWakeCodename(res.codename!);
      }).catch(() => { /* window-wake not yet bundled — non-fatal */ });
    }
    // Critical for multi-tab routing: tell the UIControlBus its own WS
    // connId so handleRequest() can filter dispatches that target a
    // specific tab. Without this, two tabs that share a sessionStorage
    // instanceId would both execute any dispatch targeted at "one of them"
    // — that's the "open notes on Alpha moves Oscar too" bug.
    if (res?.connId) {
      const { UIControlBus } = await import("./control-bus");
      UIControlBus.setOwnConnId(res.connId);
    }
  } catch {
    /* gateway too old to know about ui.my_codename, or temporarily down —
     * keep the fallback [infinibot:hex] tag. */
  }
}

type GatewayHost = {
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  chatRunId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) return raw;
  if (!raw) return mainSessionKey;
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` ||
        raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) return;
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

/** Extract a one-time invite token from the URL search params.
 *  Scrubs it from the address bar so it doesn't persist in history.
 */
function pickupInviteToken(): string | undefined {
  try {
    if (typeof window === "undefined" || !window.location) return undefined;
    const qs = new URLSearchParams(window.location.search);
    const token = qs.get("invite")?.trim() || undefined;
    if (!token) return undefined;
    // Remove the ?invite= from the URL bar (keep other params)
    qs.delete("invite");
    const newSearch = qs.toString();
    const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", newUrl);
    return token;
  } catch {
    return undefined;
  }
}

async function refreshHttpSessionAfterHello(hello: GatewayHelloOk): Promise<void> {
  try {
    const current = getGatewayHttpCredentials();
    if (!current.token && !current.password && typeof crypto !== "undefined" && crypto.subtle) {
      const identity = await loadOrCreateDeviceIdentity();
      const stored = loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" });
      const deviceToken =
        (hello as { auth?: { deviceToken?: string } })?.auth?.deviceToken ?? stored?.token;
      if (deviceToken) {
        setGatewayHttpCredentials({ deviceId: identity.deviceId, deviceToken });
      }
    }
  } catch {
    // no device identity — fall back to whatever credential we already have
  }
  await ensureGatewaySession();
}

export function connectGateway(host: GatewayHost) {
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.reconnecting = false;
  host.reconnectAttempt = 0;
  host.execApprovalQueue = [];
  host.execApprovalError = null;

  host.client?.stop();
  // Stable per-tab instanceId. Each browser tab (or Electron window) keeps
  // its own id across reloads (sessionStorage) so the agent can target a
  // specific tab in multi-monitor setups via ui_control { routing:"active" }
  // or { instanceId }. The id is also surfaced on document.title so Hyprland
  // window listing can map window → instanceId — see ensureTitleTag().
  const tabInstanceId = resolveTabInstanceId();
  ensureTitleTag(tabInstanceId);
  // Pick up a one-time invite token from ?invite=TOKEN in the URL.
  // This lets a new device authenticate without knowing the password.
  const inviteToken = pickupInviteToken();
  if (inviteToken) {
    console.log("[Gateway] Found invite token in URL — attempting invite-token auth");
  }
  // HTTP routes use the same credential as the WebSocket (see gateway-http-auth.ts).
  // Multi-user: an admin "preview as user" tab connects with a one-off
  // session token held in sessionStorage (never persisted to settings).
  const previewToken = accessPreviewToken();
  const connectToken = previewToken ?? host.settings.token.trim();
  const connectPassword = previewToken || isUserSessionToken(connectToken) ? "" : host.password.trim();
  setGatewayHttpCredentials({
    gatewayUrl: host.settings.gatewayUrl,
    token: connectToken || undefined,
    password: connectPassword || undefined,
  });
  void ensureGatewaySession({ requireCredential: true });
  host.client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: connectToken ? connectToken : undefined,
    password: connectPassword ? connectPassword : undefined,
    inviteToken: inviteToken || undefined,
    clientName: "infinibot-control-ui",
    mode: "webchat",
    instanceId: tabInstanceId,
    onHello: (hello) => {
      // Capture the pre-update connection state so we can tell a genuine
      // disconnect→connect recovery (worth a toast) from a redundant hello
      // (initial page load, dev HMR re-hello, or the second hello the server
      // sends right after the snapshot). Without this guard the "Connected"
      // toast fires on every hello and they stack faster than the 1s auto-
      // dismiss can clear them — the user sees a persistent column of
      // "Gateway connection established" toasts that won't go away.
      const wasReconnecting = host.reconnecting === true;
      host.connected = true;
      host.reconnecting = false;
      host.reconnectAttempt = 0;
      host.lastError = null;
      host.hello = hello;
      applySnapshot(host, hello);
      // Board events sent while the socket was down are lost: refetch the
      // board once on every (re)connect if it was already showing.
      refetchKanbanAfterReconnect(host);
      ensureKanbanFallbackPoll(host);
      // Sidebar "needs setup" glows: (re)load after every (re)connect — a
      // plugin toggle or config save restarts the gateway.
      onSetupGatewayHello(host.client);
      // Secure Mode: (re)load the toggle state on every (re)connect — the
      // gateway may have restarted with the lane locked or unlocked.
      attachSecureClient(host.client);
      // GPU runtime widget + chat swap status (local-runtimes/store.ts).
      attachLocalRuntimesClient(host.client);
      // Upgrade the title from [infinibot:hex] → [Alpha] now that the
      // gateway can tell us our voice-friendly codename. Fire-and-forget;
      // worst case the fallback hex tag stays. Using .catch() rather than
      // `void` so the bundler can't treeshake the call as side-effect-free.
      refreshCodenameFromGateway(host).catch(() => {});
      // Plugin host: which manifest-v2 plugins are loaded decides which
      // plugin nav entries/pages exist. Re-synced on every hello, so a
      // plugin toggle (which restarts the gateway) is picked up on reconnect.
      syncPluginHost(host.client)
        .then(() => {
          // First data after hello: the hosted cloud loader (cloud/workspace-loader.ts) waits for it.
          window.dispatchEvent(new CustomEvent("infinibot:workspace-signal", { detail: { type: "data-ready" } }));
          const h = host as unknown as {
            requestUpdate?: () => void;
            setTab?: (tab: Tab) => void;
            basePath?: string;
          };
          // Plugin landing page ("clinic mode"): only when the UI was opened
          // at its root and is still on the default dashboard.
          const landing = pluginLanding();
          if (
            landing &&
            !pluginLandingApplied &&
            host.tab === "dashboard" &&
            openedAtRoot(h.basePath ?? "")
          ) {
            pluginLandingApplied = true;
            h.setTab?.(landing.tab as Tab);
          }
          h.requestUpdate?.();
        })
        .catch(() => {});
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      // Notification: connected. Only fired on a real reconnect (user saw the
      // disconnect banner first). The initial hello on page load doesn't toast
      // — the user just opened the app, "Connected" is the expected state and
      // a 1s flash on every cold start was just noise. Deduped via stable id
      // so any duplicate hellos within the same recovery window collapse onto
      // the same toast instead of stacking.
      if (wasReconnecting) {
        try {
          const nState = host as unknown as NotificationsState;
          if (nState.notifications != null) {
            addNotification(nState, {
              id: "gateway-connected",
              type: "success",
              title: "Connected",
              message: "Gateway connection established",
              duration: 1500,
            });
          }
        } catch (_) {}
      }

      // Persist password for auto-reconnect on page refresh
      if (host.password && host.password !== host.settings.password) {
        const updatedSettings = { ...host.settings, password: host.password };
        saveSettings(updatedSettings);
        host.settings = updatedSettings;
        console.log('[Gateway] Password persisted for auto-reconnect');
      }

      // Refresh the HTTP session cookie now that the handshake settled. Paired
      // devices without the shared secret use their device token for HTTP too.
      void refreshHttpSessionAfterHello(hello);

      // Expose gateway client on window for nav-sidebar sync
      (window as any).__infinibotGatewayClient = host.client;

      // Hand the gateway client to the change-notion-db modal host so
      // any view (Projects/Tasks/CRM) can dispatch the open event and
      // have the modal talk to the gateway.
      void import("./views/change-notion-db-host").then(({ setChangeNotionDbHostClient }) => {
        setChangeNotionDbHostClient(host.client ?? null);
      });
      // Same wiring for the email-composer modal host.
      void import("./views/email-composer-host").then(({ setEmailComposerHostClient }) => {
        setEmailComposerHostClient(host.client ?? null);
      });
      
      // Initialize federation sync controller for real-time UI updates
      if (host.client) {
        initFederationSync(host.client);
        console.log("[federation-sync] Initialized");
      }

      // Wire the UI Control Bus so the agent (server-side) can drive any
      // registered view in real time via tool calls.
      if (host.client) {
        void import("./control-bus").then(({ UIControlBus }) => {
          UIControlBus.attach(host.client!);
          console.log("[ui-control-bus] Attached to gateway");
          // Register app-level view controllers (chat, kanban, databases,
          // workflows, notes, agents, federation, business, settings, etc.)
          // Per-component lit elements (e.g. voice-chat) self-register in
          // their own connectedCallback.
          void import("./control-bus-app-views").then(({ registerAppViewControllers }) => {
            registerAppViewControllers(host as unknown as import("./app-view-state").AppViewState);
            console.log("[ui-control-bus] App-view controllers registered");
          });
          // Universal navigation + live highlighting (ui_control navigate /
          // highlight / guide) and per-tab presence for agent targeting.
          void import("./guide/index").then(({ installGuide, reportGuideActivityNow }) => {
            installGuide(host as unknown as Parameters<typeof installGuide>[0]);
            reportGuideActivityNow(host as unknown as Parameters<typeof installGuide>[0]);
          });
        });
      }
      
      // Load nav sidebar state from gateway (synced across browsers)
      import("./controllers/nav-sidebar").then(({ loadNavSidebarStateAsync }) => {
        console.log('[nav-sidebar] Loading state from gateway...');
        loadNavSidebarStateAsync().then((state) => {
          const app = host as unknown as InfiniBotApp;
          console.log('[nav-sidebar] Setting app.navSidebarState, categories:', state.categories?.length);
          app.navSidebarState = state;
          app.requestUpdate(); // Force re-render
        }).catch((e) => {
          console.warn('[nav-sidebar] Failed to load from gateway on connect:', e);
        });
      });
      
      console.log(`[Gateway] onHello: Loading chat history for session "${host.sessionKey}"...`);
      const app = host as unknown as InfiniBotApp;
      // On reconnects to the same session, leave the rendered messages
      // alone — loadChatHistory will atomically swap them in once the
      // round-trip completes. Wiping unconditionally caused a 50–500 ms
      // flash where the skeleton replaced the live thread on every
      // gateway blip, sleep/wake, or service restart.
      const loadedSessionKey = (app as { chatLoadedSessionKey?: string | null }).chatLoadedSessionKey;
      const sessionUnchanged =
        loadedSessionKey != null && loadedSessionKey === host.sessionKey;
      if (!sessionUnchanged) {
        app.chatMessages = [];
        app.chatToolMessages = [];
      }
      app.chatLoading = !sessionUnchanged;
      
      void loadAssistantIdentity(app);
      void loadAgents(app);
      void loadNodes(app, { quiet: true });
      void loadDevices(app, { quiet: true });
      // Load branding/theme early so every subsequent render uses user tokens.
      void import("./controllers/app-branding.js").then((m) => {
        const client = app.client;
        if (client) return m.loadAppBranding(app, client);
      });
      
      // Always load chat history first, then refresh the active tab
      // This ensures messages are loaded regardless of current tab
      // Mark that we're loading chat to prevent double-load from refreshActiveTab
      (app as any)._chatLoadedOnConnect = true;
      void loadChatHistory(app).then(() => {
        console.log(`[Gateway] onHello: loadChatHistory completed, chatMessages.length = ${app.chatMessages?.length ?? 0}`);
        app.chatLoading = false; // Ensure loading is false
        app.requestUpdate();
        // Now refresh the active tab for tab-specific data (but chat is already loaded)
        return refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
      }).then(() => {
        console.log(`[Gateway] onHello: refreshActiveTab completed`);
        (app as any)._chatLoadedOnConnect = false; // Reset flag
        app.requestUpdate();
      });
      // Load available models for the model selector dropdown
      if (typeof app.loadAvailableModels === "function") {
        void app.loadAvailableModels();
      }
    },
    onClose: ({ code, reason, sleeping }) => {
      host.connected = false;
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      // A hosted workspace going to sleep is not an error either (cloud/gateway-sleep.ts).
      if (sleeping) {
        host.lastError = null;
        host.reconnecting = false;
      } else if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
      // Clean up federation sync on disconnect
      disposeFederationSync();
    },
    onReconnecting: ({ attempt, delayMs }) => {
      host.reconnecting = true;
      host.reconnectAttempt = attempt;
      // Clear the error while reconnecting to show "Reconnecting..." state
      // Keep the error if we've been trying for too long (>30s / attempt 8+)
      if (attempt <= 8) {
        host.lastError = null;
      }
      (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
      console.log(`[Gateway] Reconnecting... attempt ${attempt} in ${delayMs}ms`);
    },
    onEvent: (evt) => handleGatewayEvent(host, evt),
    onGap: ({ expected, received }) => {
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
    },
  });
  host.client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  // Chat follows navigation: which session's run is driving the UI.
  if (evt.event === "agent" || evt.event === "chat") {
    try {
      noteChatFollowEvent(evt);
    } catch {
      /* non-critical */
    }
  }
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  // Multi-user: an admin changed people/permissions — refresh who-am-I.
  if (evt.event === "access.changed") {
    ensureAccessMe(host.client, () => (host as { requestUpdate?: () => void }).requestUpdate?.(), true);
    return;
  }
  // Live browser frames/state go straight to the panel: they are large and
  // frequent, so they must not land in the debug event log below.
  if (evt.event === "browser.viewer.frame" || evt.event === "browser.viewer.state") {
    window.dispatchEvent(
      new CustomEvent("infinibot:browser-viewer", {
        detail: { event: evt.event, payload: evt.payload },
      }),
    );
    return;
  }

  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (contentTabOf(host as never) === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) return;
    if (handleChatNotice(host as unknown as InfiniBotApp, evt.payload)) {
      (host as { requestUpdate?: () => void }).requestUpdate?.();
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  // Excalidraw MCP bridge — the canvas MCP server (extensions/mcp-excalidraw)
  // pushes scene mutations through the gateway as `canvas.*` events. The
  // whiteboard React canvas in views/whiteboard.ts already listens for the
  // `excalidraw-update` DOM event; we just translate.
  if (evt.event === "canvas.update") {
    const payload = (evt.payload ?? {}) as { elements?: unknown };
    if (Array.isArray(payload.elements)) {
      // Cache element count on window for the chat canvas-preview card.
      (window as unknown as { __infinibotCanvasElementCount?: number }).__infinibotCanvasElementCount =
        payload.elements.length;
      window.dispatchEvent(
        new CustomEvent("excalidraw-update", {
          detail: { elements: payload.elements, files: {} },
        }),
      );
    }
    return;
  }
  if (evt.event === "canvas.clear") {
    (window as unknown as { __infinibotCanvasElementCount?: number }).__infinibotCanvasElementCount = 0;
    window.dispatchEvent(
      new CustomEvent("excalidraw-update", { detail: { elements: [], files: {} } }),
    );
    return;
  }
  if (evt.event === "canvas.view") {
    // The whiteboard view doesn't have a built-in handler for this yet;
    // dispatch under a separate name so a future controller can subscribe
    // without colliding with the scene-update event.
    window.dispatchEvent(new CustomEvent("excalidraw-view", { detail: evt.payload ?? {} }));
    return;
  }

  // ── Kanban live updates ──────────────────────────────────────────────
  // The gateway broadcasts `kanban:changed` whenever ANY surface (the
  // RPC handlers, the agent MCP tool, the voice orchestrator) mutates a
  // task or project. The 15s board poll only reloads tasks when the
  // PROJECT LIST changed, so an agent editing a task title used to be
  // invisible until manual refresh. Refresh the open board immediately.
  if (evt.event === "kanban:changed") {
    handleKanbanChanged(host, evt.payload as KanbanChangedPayload | undefined);
    return;
  }
  // HQ object stores (decision/risk/commitment/opportunity) changed anywhere.
  if (evt.event === "hq.object.changed") {
    handleHqObjectChanged(host);
    // Opportunity stage/value moves change the My Network graph too.
    handleNetworkChanged(host);
    return;
  }
  // My Network (network.*) changed in another tab / device or by an agent.
  if (evt.event === "network.changed") {
    handleNetworkChanged(host);
    return;
  }
  // Versioned per-task update (any source, any tab/device): patch in place.
  if (evt.event === "kanban.task.updated") {
    handleKanbanTaskUpdated(host, evt.payload);
    return;
  }

  // Secure Mode toggle + lane changes → window events (secure-mode/store.ts).
  if (evt.event === OCR_CHANGED_EVENT) {
    window.dispatchEvent(new CustomEvent(OCR_WINDOW_EVENT, { detail: evt.payload }));
    return;
  }
  if (handleLocalRuntimesEvent(evt.event, evt.payload)) return;
  // One-click local voice setup progress → <ib-local-voice-setup> (onboarding / Setup › Voice).
  if (evt.event === LOCAL_VOICE_PROGRESS_EVENT) {
    window.dispatchEvent(new CustomEvent(LOCAL_VOICE_WINDOW_EVENT, { detail: evt.payload }));
    return;
  }
  if (handleSecureGatewayEvent(evt.event, evt.payload)) {
    (host as { requestUpdate?: () => void }).requestUpdate?.();
    return;
  }

  // Hosted plan cap hit (src/agents/agent-concurrency-gate.ts) → the global
  // <plan-limit-modal> (mounted in app-render.ts) listens for this window event.
  if (evt.event === "plan.limit") {
    window.dispatchEvent(new CustomEvent("infinibot:plan-limit", { detail: evt.payload }));
    return;
  }

  // ── Notes live updates ───────────────────────────────────────────────
  // `notes:changed` fires for create/update/delete from both the RPC path
  // and the agent MCP tool (same role-resolved store). Reload the list if
  // the user is looking at it.
  if (evt.event === "ideas.changed") {
    // Documents › Ideas (and anything else showing ideas) refreshes live.
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("ideas:changed", { detail: evt.payload ?? {} }));
    return;
  }
  if (evt.event === "notes:changed") {
    void handleNotesChanged(host, evt.payload);
    return;
  }

  // Background Documents imports (Notion API / export ZIP): the Documents
  // workspace reattaches to the running job and renders live progress.
  if (evt.event === "documents.import.progress") {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("documents:import-progress", { detail: evt.payload ?? {} }));
    }
    return;
  }

  // ── Clients live updates ─────────────────────────────────────────────
  if (evt.event === "clients:updated") {
    const cs = (host as { businessState?: { _clientsState?: unknown } }).businessState?._clientsState;
    if (cs) {
      void import("./controllers/clients").then(({ loadClients }) =>
        loadClients(host as unknown as import("./app-view-state").AppViewState, host.client!),
      );
    }
    return;
  }

  // ── Persistent queue events (src/queue/*) ────────────────────────────
  // Re-dispatch every queue.* event as a CustomEvent on `window` so the
  // holding-zone overlay (<queue-holding-zone>) + the activity feed picker
  // can subscribe without taking a direct dep on the ws client. The event
  // type is preserved verbatim (e.g. "queue.phase_started") and the entire
  // payload is forwarded under .detail.payload so listeners can pull id /
  // status / phaseName without re-shape.
  if (typeof evt.event === "string" && evt.event.startsWith("queue.")) {
    try {
      window.dispatchEvent(
        new CustomEvent(evt.event, { detail: { event: evt.event, payload: evt.payload } }),
      );
    } catch {
      /* ignore */
    }
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    // Research-workspace runs stream on their own `agent:main:research-*`
    // sessions; they must not become the chat page's "last active" session.
    if (payload?.sessionKey && !payload.sessionKey.startsWith("agent:main:research-")) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    // Capture ownership BEFORE handleChatEvent — it clears chatRunId on own-run
    // finals, so afterwards we can't tell whether the final was ours.
    // Without this check the destructive resets below fire for ANY chat:final
    // (sub-agent announces, pre-compaction memory-flush sub-runs, sibling
    // sessions), wiping the live tool stream of the still-running main run and
    // leaving chatRunId set — which is exactly the "messages stack, no
    // animations, no responses" symptom after compaction.
    const wasOwnRun =
      !payload?.runId || !host.chatRunId || payload.runId === host.chatRunId;
    const state = handleChatEvent(host as unknown as InfiniBotApp, payload);
    if (
      wasOwnRun &&
      (state === "final" || state === "error" || state === "aborted")
    ) {
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void flushChatQueueForEvent(
        host as unknown as Parameters<typeof flushChatQueueForEvent>[0],
      );
    }
    // Force the reload: after the first load chatLoadedSessionKey === sessionKey,
    // so a non-forced reload here no-ops and the just-finished reply is never
    // fetched from the store (the "final never commits" bug). handleChatEvent
    // has already optimistically committed the streamed text, so this forced
    // read only reconciles against the authoritative transcript.
    if (state === "final")
      void loadChatHistory(host as unknown as InfiniBotApp, { force: true });

    // Update agent activity feed when a session completes — no timeout guessing.
    // The gateway broadcasts chat events with state "final"/"error" for ALL sessions
    // including sub-agents. We use this as the definitive completion signal.
    if ((state === "final" || state === "error") && payload?.sessionKey) {
      const as = (host as any).agentActivityState;
      if (as?.sessions) {
        const session = as.sessions.find((s: any) => s.key === payload.sessionKey);
        if (session) {
          session.active = false;
          session.completedViaEvent = true;
          session.completionState = state === "final" ? "done" : "error";
          session.updatedAt = Date.now();
          (host as any).requestUpdate?.();
        }
      }

      // Toast notification for session completion/error
      try {
        const nState = host as unknown as NotificationsState;
        if (nState.notifications != null) {
          const sk = payload.sessionKey as string;
          const parts = sk.split(":");
          const agentId = parts.length >= 2 ? parts[1] : sk;
          const isFinal = state === "final";
          const isSubAgent = sk.includes("subagent");

          // Build friendly task name from available metadata
          const rawTitle = (payload as any).title || (payload as any).derivedTitle || "";
          const label = (payload as any).label || "";

          // Prefer label (spawn label like "🏗️ Build API Router"), then derivedTitle, then agent name
          let taskName = "";
          if (label && typeof label === "string") {
            taskName = label;
          } else if (rawTitle && typeof rawTitle === "string" && !rawTitle.startsWith("agent:")) {
            taskName = rawTitle;
          } else {
            // Generate from agent ID
            const agentNames: Record<string, string> = {
              main: "Infini", coder: "Atlas", opus: "Oracle",
              webdev: "Architect", qa: "Sentry",
              "coder-claude": "Claude Code", "coder-codex": "Codex", "coder-opencode": "OpenCode",
            };
            taskName = agentNames[agentId] || agentId.charAt(0).toUpperCase() + agentId.slice(1);
          }

          // Truncate long names
          const displayName = taskName.length > 50 ? taskName.slice(0, 47) + "…" : taskName;

          // Build title: "✅ Task Completed" or "❌ Task Failed" for sub-agents
          // "✅ Infini completed" for main agent
          const notifTitle = isSubAgent
            ? (isFinal ? "✅ Task Completed" : "❌ Task Failed")
            : `${isFinal ? "✅" : "❌"} ${displayName} ${isFinal ? "finished" : "failed"}`;

          // Message: the task/project name for sub-agents, or a summary
          const notifMessage = isSubAgent
            ? displayName
            : (rawTitle && typeof rawTitle === "string" ? rawTitle : sk);

          addNotification(nState, {
            type: isFinal ? "completion" : "error",
            title: notifTitle,
            message: notifMessage,
            sessionKey: sk,
            agentId,
            duration: isFinal ? 8000 : 10000,
            action: {
              label: "View",
              callback: () => {
                const app = host as unknown as { tab: string; requestUpdate?: () => void; setTab?: (tab: string) => void };
                if (typeof app.setTab === "function") {
                  app.setTab("activity" as any);
                } else {
                  app.tab = "activity";
                }
                app.requestUpdate?.();
              },
            },
          });
        }
      } catch (e) {
        // Non-critical — don't break event handling
        console.warn("[notifications] Failed to add completion notification:", e);
      }
    }
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as InfiniBotApp, { quiet: true });

    // Notification for device pairing
    try {
      const nState = host as unknown as NotificationsState;
      if (nState.notifications != null) {
        const isRequested = evt.event === "device.pair.requested";
        addNotification(nState, {
          type: isRequested ? "info" : "success",
          title: isRequested ? "Device Pairing Request" : "Device Paired",
          message: isRequested ? "A new device is requesting to pair" : "Device pairing resolved",
          duration: isRequested ? 8000 : 5000,
        });
      }
    } catch (_) {}
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);

      // Notification for exec approval
      try {
        const nState = host as unknown as NotificationsState;
        if (nState.notifications != null) {
          addNotification(nState, {
            type: "warning",
            title: "Exec Approval Required",
            message: entry.command || "A command needs your approval",
            duration: 0, // sticky — needs action
          });
        }
      } catch (_) {}
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }

  // Terminal events for xterm.js integration
  if (evt.event === "terminal.output") {
    const payload = evt.payload as { id?: string; terminalId?: string; data?: string } | undefined;
    const termId = payload?.terminalId || payload?.id;
    if (termId && payload?.data) {
      writeToXterm(termId, payload.data);
    }
    return;
  }

  if (evt.event === "terminal.exit") {
    const payload = evt.payload as { id?: string; terminalId?: string; exitCode?: number } | undefined;
    const termId = payload?.terminalId || payload?.id;
    if (termId && typeof payload?.exitCode === "number") {
      const app = host as unknown as import("./app-view-state").AppViewState;
      const ts = app.terminalsState;
      if (ts) {
        const session = ts.sessions.find(s => s.id === termId);
        if (session) {
          session.status = "exited";
          const xt = getXtermInstance(termId);
          if (xt) {
            xt.writeln(`\r\n\x1b[90mProcess exited with code ${payload.exitCode}\x1b[0m`);
          }
          app.requestUpdate?.();
        }
      }
    }
    return;
  }

  // Multi-tab sync: a terminal was created in another browser window. Mirror
  // it into our local list so it shows up immediately. The originating tab
  // already added it locally, so we skip duplicates.
  if (evt.event === "terminal.created") {
    const payload = evt.payload as {
      id?: string; terminalId?: string; title?: string; cwd?: string;
      cliType?: string | null; createdAt?: string;
      projectPath?: string | null; sessionKey?: string | null;
      isClaudeMode?: boolean;
    } | undefined;
    const termId = payload?.terminalId || payload?.id;
    if (termId) {
      const app = host as unknown as import("./app-view-state").AppViewState;
      const ts = app.terminalsState;
      if (ts && !ts.sessions.find((s) => s.id === termId)) {
        const cli: "claude" | "opencode" | "gemini" | "codex" | "grok" | "shell" =
          payload?.isClaudeMode || payload?.cliType === "claude" ? "claude" :
          payload?.cliType === "opencode" ? "opencode" :
          payload?.cliType === "gemini" ? "gemini" :
          payload?.cliType === "codex" ? "codex" :
          payload?.cliType === "grok" ? "grok" : "shell";
        ts.sessions = [
          ...ts.sessions,
          {
            id: termId,
            title: payload?.title || `Terminal ${ts.sessions.length + 1}`,
            cli,
            status: "running",
            cwd: payload?.cwd || ".",
            createdAt: payload?.createdAt || new Date().toISOString(),
            expandedView: false,
            projectId: payload?.projectPath || undefined,
            sessionKey: payload?.sessionKey || undefined,
          },
        ];
        if (!ts.activeSessionId) ts.activeSessionId = termId;
        app.requestUpdate?.();
      }
    }
    return;
  }

  if (evt.event === "terminal.destroyed") {
    const payload = evt.payload as { id?: string; terminalId?: string } | undefined;
    const termId = payload?.terminalId || payload?.id;
    if (termId) {
      const app = host as unknown as import("./app-view-state").AppViewState;
      const ts = app.terminalsState;
      if (ts) {
        const wasPresent = ts.sessions.some((s) => s.id === termId);
        if (wasPresent) {
          ts.sessions = ts.sessions.filter((s) => s.id !== termId);
          if (ts.activeSessionId === termId) {
            ts.activeSessionId = ts.sessions.length > 0
              ? ts.sessions[ts.sessions.length - 1].id
              : null;
          }
          app.requestUpdate?.();
        }
      }
    }
    return;
  }

  // Terminal-first sub-agent: auto-create tab when a spawn terminal is created
  if (evt.event === "terminal.spawned") {
    const payload = evt.payload as {
      terminalId?: string; runId?: string; sessionKey?: string;
      agentId?: string; label?: string; title?: string;
      cli?: string; cwd?: string; isSubagent?: boolean;
    } | undefined;
    if (payload?.terminalId && payload?.isSubagent) {
      const app = host as unknown as import("./app-view-state").AppViewState;
      const ts = app.terminalsState;
      if (ts) {
        // Don't duplicate if already exists
        if (!ts.sessions.find(s => s.id === payload.terminalId)) {
          const cli = (payload.cli as "claude" | "opencode" | "gemini" | "codex" | "grok" | "shell") || "shell";
          ts.sessions.push({
            id: payload.terminalId!,
            title: payload.title || payload.label || `🏗️ ${payload.agentId || "agent"} task`,
            cli,
            status: "running",
            cwd: payload.cwd || ".",
            createdAt: new Date().toISOString(),
            expandedView: false,
            sessionKey: payload.sessionKey,
            // Custom flags for sub-agent terminals
            ...(payload.isSubagent ? { isSubagent: true, runId: payload.runId, agentId: payload.agentId } as any : {}),
          });
          // Auto-switch to the new spawn terminal
          ts.activeSessionId = payload.terminalId!;
          app.requestUpdate?.();
        }
      }
    }
    return;
  }

  // Unified notification.created — fires for all server-emitted push notifications.
  // Maps severity → toast type/duration, dedupes identical title+body within 30s.
  // Skips agent.completed / agent.error since the "chat" handler already toasts those.
  if (evt.event === "notification.created") {
    const p = evt.payload as {
      id?: string;
      ts?: number;
      category?: string;
      severity?: string;
      title?: string;
      body?: string;
      deepLink?: string | null;
      data?: Record<string, unknown>;
    } | undefined;

    if (p?.title && p?.body) {
      // Skip categories already toasted by the chat event handler
      const skipCats = new Set(["agent.completed", "agent.error"]);
      if (!skipCats.has(p.category ?? "")) {
        try {
          const nState = host as unknown as NotificationsState;
          if (nState.notifications != null) {
            const sev = p.severity ?? "info";
            const sevToType: Record<string, "info" | "success" | "warning" | "error"> = {
              info: "info", success: "success", warn: "warning", error: "error", critical: "error",
            };
            const sevToDuration: Record<string, number> = {
              info: 4000, success: 4000, warn: 8000, error: 0, critical: 0,
            };
            const notifType = sevToType[sev] ?? "info";
            const duration = sevToDuration[sev] ?? 4000;

            // 30-second dedup: skip if same title+body was recently shown
            const dedupMap: Map<string, number> = (
              (window as unknown as { __infinibotNotifDedup?: Map<string, number> }).__infinibotNotifDedup ??
              (((window as unknown as { __infinibotNotifDedup?: Map<string, number> }).__infinibotNotifDedup = new Map<string, number>()))
            );
            const dedupKey = `${p.title}::${p.body}`;
            const now = Date.now();
            if (!dedupMap.has(dedupKey) || now - (dedupMap.get(dedupKey) ?? 0) > 30_000) {
              dedupMap.set(dedupKey, now);

              const deepLink = p.deepLink ?? null;
              addNotification(nState, {
                type: notifType,
                title: p.title,
                message: p.body,
                duration,
                id: p.id,
                timestamp: p.ts,
                action: deepLink
                  ? {
                      label: "View",
                      callback: () => {
                        // infinibot://<path> → web route (docs/mobile/DEEP-LINKS.md table).
                        const app = host as unknown as { basePath?: string; requestUpdate?: () => void };
                        navigateToDeepLink(deepLink, app.basePath ?? "");
                        app.requestUpdate?.();
                      },
                    }
                  : undefined,
              });
            }
          }
        } catch (e) {
          console.warn("[notification.created] handler error:", e);
        }
      }
    }
    return;
  }

  // Terminal-first sub-agent: completion notification
  if (evt.event === "terminal.spawnComplete") {
    const payload = evt.payload as {
      terminalId?: string; runId?: string; exitCode?: number;
      label?: string; autoClose?: boolean; autoCloseDelayMs?: number;
    } | undefined;
    if (payload?.terminalId) {
      const app = host as unknown as import("./app-view-state").AppViewState;
      const ts = app.terminalsState;
      if (ts) {
        const session = ts.sessions.find(s => s.id === payload.terminalId);
        if (session) {
          session.status = "exited";
          const xt = getXtermInstance(payload.terminalId!);
          if (xt) {
            const icon = payload.exitCode === 0 ? "✅" : "❌";
            xt.writeln(`\r\n\x1b[33m${icon} Task ${payload.exitCode === 0 ? "completed" : "failed"} (exit code ${payload.exitCode})\x1b[0m`);
            if (payload.autoClose) {
              const delaySec = Math.round((payload.autoCloseDelayMs || 5000) / 1000);
              xt.writeln(`\x1b[90mTerminal will close in ${delaySec}s...\x1b[0m`);
            }
          }
          app.requestUpdate?.();
        }
      }
    }
    return;
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
      presence?: PresenceEntry[];
      health?: HealthSnapshot;
      sessionDefaults?: SessionDefaultsSnapshot;
    }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}

// ── Kanban / Notes live-update helpers ─────────────────────────────────
// Both are driven by the gateway `kanban:changed` / `notes:changed` events
// (see src/tasks/kanban-events.ts, src/notes/notes-events.ts). The handlers
// debounce so a burst of agent writes coalesces into a single reload, and
// they only touch the network when the relevant view is actually open.

interface KanbanChangedPayload {
  entity?: "task" | "project";
  op?: "create" | "update" | "delete";
  id?: string;
  projectId?: string | null;
  title?: string;
}

let kanbanChangeTimer: ReturnType<typeof setTimeout> | null = null;
let kanbanChangeNeedsProjects = false;

function handleKanbanTaskUpdated(host: GatewayHost, payload: unknown) {
  if (!isKanbanTaskUpdatedPayload(payload)) return;
  const app = host as unknown as import("./app-view-state").AppViewState;
  // Other surfaces with their own task lists (drift overlay, agency ops).
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(KANBAN_TASK_UPDATED_EVENT, { detail: payload }));
  }
  if (!Array.isArray(app.kanbanTasks) || app.kanbanTasks.length === 0) return;
  void import("./controllers/kanban")
    .then((ctrl) => ctrl.applyTaskUpdateEvent(app, payload))
    .catch((err) => console.warn("[gateway] kanban.task.updated apply failed:", err));
}

let hqObjectsTimer: ReturnType<typeof setTimeout> | null = null;
let networkTimer: ReturnType<typeof setTimeout> | null = null;

function handleNetworkChanged(host: GatewayHost) {
  const app = host as unknown as import("./app-view-state").AppViewState;
  if (app.tab !== "people-network" || !host.client) return;
  if (networkTimer) clearTimeout(networkTimer);
  networkTimer = setTimeout(() => {
    networkTimer = null;
    void import("./controllers/people-network")
      .then((m) => (m.networkState.loaded && !m.networkState.saving ? m.loadNetwork(app, host.client as never) : undefined))
      .catch((err) => console.warn("[gateway] network.changed reload failed:", err));
  }, 400);
}

function handleHqObjectChanged(host: GatewayHost) {
  const app = host as unknown as import("./app-view-state").AppViewState;
  if (app.tab !== "dashboard" && app.tab !== "business-hq") return;
  if (!host.client) return;
  if (hqObjectsTimer) clearTimeout(hqObjectsTimer);
  hqObjectsTimer = setTimeout(() => {
    hqObjectsTimer = null;
    void import("./controllers/business-hq-objects")
      .then((m) => m.loadHqObjects(app, host.client as never))
      .then(() => app.requestUpdate?.())
      .catch((err) => console.warn("[gateway] hq.object.changed reload failed:", err));
  }, 250);
}

export function refetchKanbanAfterReconnect(host: GatewayHost) {
  const app = host as unknown as import("./app-view-state").AppViewState;
  if (!Array.isArray(app.kanbanTasks) || app.kanbanTasks.length === 0) return;
  void import("./controllers/kanban")
    .then((ctrl) => ctrl.loadKanban(app))
    .catch((err) => console.warn("[gateway] kanban refetch after reconnect failed:", err));
}

/**
 * Slow safety net only — live updates come from `kanban.task.updated` /
 * `kanban:changed`. Reloads a visible board every 2 min.
 */
const KANBAN_FALLBACK_POLL_MS = 120_000;
let kanbanFallbackTimer: ReturnType<typeof setInterval> | null = null;

function ensureKanbanFallbackPoll(host: GatewayHost) {
  if (kanbanFallbackTimer || typeof window === "undefined") return;
  kanbanFallbackTimer = setInterval(() => {
    const app = host as unknown as import("./app-view-state").AppViewState;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (!host.connected || app.kanbanLoading) return;
    if (!["dashboard", "business-hq", "projects"].includes(String(app.tab))) return;
    refetchKanbanAfterReconnect(host);
  }, KANBAN_FALLBACK_POLL_MS);
}

function handleKanbanChanged(host: GatewayHost, payload: KanbanChangedPayload | undefined) {
  const app = host as unknown as import("./app-view-state").AppViewState;

  // A task update already applied in place from its versioned
  // `kanban.task.updated` event needs no full-board reload.
  if (payload?.entity === "task" && payload.op === "update" && recentlyAppliedTaskUpdate(payload.id)) {
    return;
  }

  // Business HQ derives every section from the live board (kanbanProjects /
  // kanbanTasks). Any task/project mutation should refresh it immediately.
  // The HQ now lives at /dashboard (the old /business-hq route redirects to it).
  if (app.tab === "dashboard" || app.tab === "business-hq") {
    if (kanbanChangeTimer) clearTimeout(kanbanChangeTimer);
    kanbanChangeTimer = setTimeout(() => {
      kanbanChangeTimer = null;
      void import("./controllers/kanban")
        .then((ctrl) => ctrl.loadKanban(app))
        .then(() => app.requestUpdate?.())
        .catch((err) => console.warn("[gateway] kanban:changed (dashboard HQ) reload failed:", err));
    }, 250);
    return;
  }

  if (app.tab !== "projects") return; // not looking at the board — next open reloads anyway

  // Optimistic patch: the event already carries the new title/id, so reflect a
  // task rename/move in the reactive board state instantly instead of waiting
  // for the debounced reload — that reload refetches from Notion and can take
  // a couple of seconds, well past the "feels live" budget.
  if (
    payload?.entity === "task" &&
    payload.op === "update" &&
    payload.id &&
    Array.isArray(app.kanbanTasks)
  ) {
    let patched = false;
    app.kanbanTasks = app.kanbanTasks.map((t) => {
      if (t && (t as { id?: string }).id === payload.id) {
        patched = true;
        return { ...t, ...(payload.title != null ? { title: payload.title } : {}) };
      }
      return t;
    });
    if (patched) app.requestUpdate?.();
  }

  if (payload?.entity === "project") kanbanChangeNeedsProjects = true;
  if (kanbanChangeTimer) clearTimeout(kanbanChangeTimer);
  kanbanChangeTimer = setTimeout(() => {
    kanbanChangeTimer = null;
    const needsProjects = kanbanChangeNeedsProjects;
    kanbanChangeNeedsProjects = false;
    void (async () => {
      try {
        const ctrl = await import("./controllers/kanban");
        if (needsProjects) {
          // Project added/removed/renamed — refresh the gallery.
          await ctrl.loadKanban(app);
        } else if (app.kanbanSelectedProjectId) {
          // Task change on the open board — reload just its tasks.
          await ctrl.loadProjectTasks(app, app.kanbanSelectedProjectId);
        }
        app.requestUpdate?.();
      } catch (err) {
        console.warn("[gateway] kanban:changed reload failed:", err);
      }
    })();
  }, 250);
}

let notesChangeTimer: ReturnType<typeof setTimeout> | null = null;

function handleNotesChanged(host: GatewayHost, payload?: unknown) {
  // The Documents workspace (Notes tab) listens for this and refreshes live —
  // including edits made by agents through the notes tool.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("documents:changed", { detail: payload ?? {} }));
  }
  const app = host as unknown as import("./app-view-state").AppViewState;
  if (app.tab !== "notes") return;
  if (!app.notesState || !app.client) return;
  if (notesChangeTimer) clearTimeout(notesChangeTimer);
  notesChangeTimer = setTimeout(() => {
    notesChangeTimer = null;
    void (async () => {
      try {
        const { loadNotes } = await import("./controllers/notes");
        await loadNotes(app, app.client!);
        app.requestUpdate?.();
      } catch (err) {
        console.warn("[gateway] notes:changed reload failed:", err);
      }
    })();
  }, 250);
}
