import { isBusinessAgencyOn, isBusinessAgencyTab } from "./business-agency-gate.js";
import { loadConfig, loadConfigSchema } from "./controllers/config";
import { isCloudBuild } from "./cloud/cloud-env";
import { loadChannels } from "./controllers/channels";
import { loadDebug } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";
import { loadDevices } from "./controllers/devices";
import { loadNodes } from "./controllers/nodes";
import { loadExecApprovals } from "./controllers/exec-approvals";
import { loadPresence } from "./controllers/presence";
import { loadAgentsList } from "./controllers/agents-management";
import { contentTabOf, inferBasePathFromPathname, matchRoute, normalizeBasePath, normalizePath, pathForEntity, pathForTab, resolveSubView, resolveTabRedirect, subViewRouteForTab, subViewsForHost, tabFromPath, type Tab } from "./navigation";
import { resolveSlug, type EntityKind, type EntityRef } from "./lib/slugs";
import { saveSettings, type UiSettings } from "./storage";
import { setCurrentLocale } from "./i18n";
import { resolveTheme, type ResolvedTheme, type ThemeMode } from "./theme";
import { startThemeTransition, type ThemeTransitionContext } from "./theme-transition";
import { scheduleChatScroll, scheduleLogsScroll } from "./app-scroll";
import { startLogsPolling, stopLogsPolling, startDebugPolling, stopDebugPolling } from "./app-polling";
import { refreshChat } from "./app-chat";
import type { InfiniBotApp } from "./app";

type SettingsHost = {
  settings: UiSettings;
  password: string;
  theme: ThemeMode;
  themeResolved: ResolvedTheme;
  applySessionKey: string;
  sessionKey: string;
  tab: Tab;
  connected: boolean;
  chatHasAutoScrolled: boolean;
  logsAtBottom: boolean;
  eventLog: unknown[];
  eventLogBuffer: unknown[];
  basePath: string;
  themeMedia: MediaQueryList | null;
  themeMediaHandler: ((event: MediaQueryListEvent) => void) | null;
  deepLink?: { kind: EntityKind; slug: string; pending: boolean } | null;
  /** Active sub-view per merged host page (see navigation HOST_SUBVIEWS). */
  hostView?: Partial<Record<Tab, string>>;
  requestUpdate?: () => void;
};

export function applySettings(host: SettingsHost, next: UiSettings) {
  const normalized = {
    ...next,
    lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || "main",
  };
  host.settings = normalized;
  saveSettings(normalized);
  if (next.theme !== host.theme) {
    host.theme = next.theme;
    applyResolvedTheme(host, resolveTheme(next.theme));
  }
  if (next.locale) setCurrentLocale(next.locale);
  host.applySessionKey = host.settings.lastActiveSessionKey;
}

export function setLastActiveSessionKey(host: SettingsHost, next: string) {
  const trimmed = next.trim();
  if (!trimmed) return;
  if (host.settings.lastActiveSessionKey === trimmed) return;
  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
}

export function applySettingsFromUrl(host: SettingsHost) {
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  const tokenRaw = params.get("token");
  const passwordRaw = params.get("password");
  const sessionRaw = params.get("session");
  const gatewayUrlRaw = params.get("gatewayUrl");
  let shouldCleanUrl = false;

  if (tokenRaw != null) {
    const token = tokenRaw.trim();
    if (token && token !== host.settings.token) {
      applySettings(host, { ...host.settings, token });
    }
    params.delete("token");
    shouldCleanUrl = true;
  }

  if (passwordRaw != null) {
    const password = passwordRaw.trim();
    if (password) {
      (host as { password: string }).password = password;
    }
    params.delete("password");
    shouldCleanUrl = true;
  }

  if (sessionRaw != null) {
    const session = sessionRaw.trim();
    if (session) {
      host.sessionKey = session;
      applySettings(host, {
        ...host.settings,
        sessionKey: session,
        lastActiveSessionKey: session,
      });
    }
  }

  if (gatewayUrlRaw != null) {
    const gatewayUrl = gatewayUrlRaw.trim();
    // Cloud build: never repoint the workspace (and the Clerk token) via a link.
    if (gatewayUrl && gatewayUrl !== host.settings.gatewayUrl && !isCloudBuild()) {
      applySettings(host, { ...host.settings, gatewayUrl });
    }
    params.delete("gatewayUrl");
    shouldCleanUrl = true;
  }

  if (!shouldCleanUrl) return;
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState({}, "", url.toString());
}

export function setTab(host: SettingsHost, next: Tab) {
  // Retired/deprecated tabs (e.g. standalone /chat → grid) land on their host;
  // a merged retired tab (e.g. /oversight) lands on its host's sub-tab.
  const route = subViewRouteForTab(next);
  next = resolveTabRedirect(next);
  if (host.tab !== next) host.tab = next;
  applyHostView(host, next, route?.view);
  if (next === "chat") host.chatHasAutoScrolled = false;
  syncTabPolling(host);
  void refreshActiveTab(host);
  syncUrlWithTab(host, next, false);
}

/** The tab whose content is on screen: a merged host's active sub-view, or the tab. */
export function activeContentTab(host: { tab: Tab; hostView?: Partial<Record<Tab, string>> }): Tab {
  return contentTabOf(host);
}

/** Record a host's active sub-view (unknown/missing → its default sub-view). */
function applyHostView(host: SettingsHost, tab: Tab, view: string | null | undefined) {
  if (!subViewsForHost(tab).length) return;
  const id = resolveSubView(tab, view)?.id;
  if (id && host.hostView?.[tab] !== id) host.hostView = { ...(host.hostView ?? {}), [tab]: id };
}

/** Switch the sub-tab of the current merged host page (pushes a history entry). */
export function setHostView(host: SettingsHost, view: string) {
  const before = activeContentTab(host);
  applyHostView(host, host.tab, view);
  if (activeContentTab(host) !== before) {
    syncTabPolling(host);
    void refreshActiveTab(host);
  }
  syncUrlWithTab(host, host.tab, false);
}

/** Start the pollers the on-screen content needs and stop the rest. */
function syncTabPolling(host: SettingsHost) {
  const view = activeContentTab(host);
  if (view === "logs")
    startLogsPolling(host as unknown as Parameters<typeof startLogsPolling>[0]);
  else stopLogsPolling(host as unknown as Parameters<typeof stopLogsPolling>[0]);
  if (view === "debug")
    startDebugPolling(host as unknown as Parameters<typeof startDebugPolling>[0]);
  else stopDebugPolling(host as unknown as Parameters<typeof stopDebugPolling>[0]);
  if (view === "memory") {
    const appState = host as unknown as import("./app-view-state").AppViewState;
    import("./controllers/memory").then((m) => {
      m.startMemoryPolling(appState);
    });
  } else {
    import("./controllers/memory").then((m) => {
      m.stopMemoryPolling();
    });
  }
  if (view === "mcp") {
    const appState = host as unknown as import("./app-view-state").AppViewState;
    import("./controllers/mcp").then((m) => m.startMcpPolling(appState));
  } else {
    const appState = host as unknown as import("./app-view-state").AppViewState;
    import("./controllers/mcp").then((m) => m.stopMcpPolling(appState));
  }
  if (view === "terminals") {
    const appState = host as unknown as import("./app-view-state").AppViewState;
    import("./controllers/terminals").then((t) => t.startTerminalPolling(appState));
  } else {
    const appState = host as unknown as import("./app-view-state").AppViewState;
    import("./controllers/terminals").then((t) => t.stopTerminalPolling(appState));
  }
  if (view !== "files") {
    import("./controllers/files").then((f) => f.stopFilesPolling());
  }
}

export function setTheme(
  host: SettingsHost,
  next: ThemeMode,
  context?: ThemeTransitionContext,
) {
  const applyTheme = () => {
    host.theme = next;
    applySettings(host, { ...host.settings, theme: next });
    applyResolvedTheme(host, resolveTheme(next));
  };
  startThemeTransition({
    nextTheme: next,
    applyTheme,
    context,
    currentTheme: host.theme,
  });
}

export async function refreshActiveTab(host: SettingsHost) {
  // Merged host pages load the data of the sub-view that is on screen.
  const tab = activeContentTab(host);
  // Business & Agency pages load nothing while that plugin is off (they show
  // the "turned off" card and their RPCs don't exist).
  if (isBusinessAgencyTab(tab) && !isBusinessAgencyOn()) return;
  if (tab === "channels") await loadChannelsTab(host);
  if (tab === "instances") await loadPresence(host as unknown as InfiniBotApp);
  if (tab === "sessions") {
    const { loadSessions } = await import("./controllers/sessions");
    await loadSessions(host as unknown as Parameters<typeof loadSessions>[0]);
  }
  if (tab === "agents") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client && !state.agentsManagementState) {
      state.agentsManagementState = {
        agents: [],
        loading: true,
        error: null,
        selectedAgentId: null,
        editingAgent: null,
        showCreateDialog: false,
        isDirty: false,
      };
    }
    if (client) await loadAgentsList(state, client);
  }
  if (tab === "activity") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.agentActivityState) {
        const { createInitialActivityState } = await import("./controllers/agent-activity");
        state.agentActivityState = createInitialActivityState();
      }
      const { startActivityPolling } = await import("./controllers/agent-activity");
      startActivityPolling(state, client);
    }
  }
  if (tab === "autonomy") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.autonomyState) {
        const { createAutonomyState } = await import("./controllers/autonomy");
        state.autonomyState = createAutonomyState();
      }
      const { loadAutonomyStatus } = await import("./controllers/autonomy");
      const update = await loadAutonomyStatus(client);
      state.autonomyState = { ...state.autonomyState, ...update };
    }
  }
  if (tab === "workflows") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.workflowsState) {
        const { createInitialWorkflowsState } = await import("./controllers/workflows");
        state.workflowsState = createInitialWorkflowsState();
      }
      const { loadWorkflows } = await import("./controllers/workflows");
      await loadWorkflows(state, client);
    }
  }
  // tab === "notes": the Documents workspace element loads its own data.
  if (tab === "research") {
    // Research tab wiring is stale — old imports pointed at ./controllers/research
    // which was renamed to research-intel with different exports. Left as a
    // no-op until someone reconnects it; this block previously broke the
    // Vite build / dev-time import analysis for every other tab too.
  }
  if (tab === "mcp") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.mcpManagementState) {
        const { createInitialMcpState } = await import("./controllers/mcp");
        state.mcpManagementState = createInitialMcpState();
      }
      const { loadMcpPage, startMcpPolling } = await import("./controllers/mcp");
      await loadMcpPage(state);
      startMcpPolling(state);
    }
  }
  if (tab === "terminals") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.terminalsState) {
        const { createInitialTerminalsState } = await import("./controllers/terminals");
        state.terminalsState = createInitialTerminalsState();
      }
      const { loadTerminalsPage, startTerminalPolling } = await import("./controllers/terminals");
      await loadTerminalsPage(state);
      startTerminalPolling(state);

      // Power the lower-panel running/completed previews.
      if (!state.agentActivityState) {
        const { createInitialActivityState } = await import("./controllers/agent-activity");
        state.agentActivityState = createInitialActivityState();
      }
      const { loadAgentActivity, startActivityPolling } = await import("./controllers/agent-activity");
      const { loadRecentlyCompleted, subscribeRecentCompleted } = await import("./views/recently-completed-feed");
      void loadAgentActivity(state, client);
      startActivityPolling(state, client);
      void loadRecentlyCompleted(client, () => state.requestUpdate?.());
      subscribeRecentCompleted(client);
    }
  }
  if (tab === "business") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.businessState) {
        const { createInitialBusinessState } = await import("./controllers/business");
        state.businessState = createInitialBusinessState();
      }
      const { loadBusiness } = await import("./controllers/business");
      await loadBusiness(state, client);
    }
  }
  if (tab === "databases") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.notionDbState) {
        const { createInitialNotionDbState } = await import("./controllers/notion-databases");
        state.notionDbState = createInitialNotionDbState();
      }
      const { loadDatabases } = await import("./controllers/notion-databases");
      await loadDatabases(state, client);
      // Also seed businessState so the per-page business filter dropdown
      // and the per-row business chip have data to render. The Business
      // tab does this on its own activation; we mirror that here so users
      // don't have to visit /business first to see businesses listed
      // anywhere else.
      if (!state.businessState) {
        const { createInitialBusinessState } = await import("./controllers/business");
        state.businessState = createInitialBusinessState();
      }
      if ((state.businessState?.businesses?.length ?? 0) === 0 && isBusinessAgencyOn()) {
        const { loadBusiness } = await import("./controllers/business");
        void loadBusiness(state, client);
      }
    }
  }
  // The Projects / Kanban tab uses the same businesses list for its
  // toolbar filter, gallery card chips, and the project-page chip. Same
  // mirror-the-business-tab logic so the dropdown isn't empty out of the
  // gate.
  if (tab === "projects") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.businessState) {
        const { createInitialBusinessState } = await import("./controllers/business");
        state.businessState = createInitialBusinessState();
      }
      if ((state.businessState?.businesses?.length ?? 0) === 0 && isBusinessAgencyOn()) {
        const { loadBusiness } = await import("./controllers/business");
        void loadBusiness(state, client);
      }
    }
  }
  if (tab === "clients") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.businessState) {
        const { createInitialBusinessState } = await import("./controllers/business");
        state.businessState = createInitialBusinessState();
      }
      const { loadBusiness } = await import("./controllers/business");
      await loadBusiness(state, client);
      // Also initialize clients state
      const { createInitialClientsState, loadClients } = await import("./controllers/clients");
      if (!state.businessState._clientsState) {
        state.businessState._clientsState = createInitialClientsState();
      }
      await loadClients(state, client);
    }
  }
  if (tab === "files") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!(state as any).filesState) {
        const { createInitialFilesState } = await import("./controllers/files");
        (state as any).filesState = createInitialFilesState();
      }
      const { startFilesPolling } = await import("./controllers/files");
      startFilesPolling(state, client);
    }
  }
  // The qualifier / leads / funnels views all key off the active business
  // (per-business webhook config, CRM target, etc.). Mirror the projects /
  // clients pattern so the business switcher chip + picker modal aren't
  // empty when the user lands on the page without first visiting Business.
  if (tab === "qualifier" || tab === "leads" || tab === "funnels") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.businessState) {
        const { createInitialBusinessState } = await import("./controllers/business");
        state.businessState = createInitialBusinessState();
      }
      if ((state.businessState?.businesses?.length ?? 0) === 0 && isBusinessAgencyOn()) {
        const { loadBusiness } = await import("./controllers/business");
        void loadBusiness(state, client);
      }
    }
  }
  if (tab === "storyboard") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      const { initializeStoryboard } = await import("./views/storyboard");
      await initializeStoryboard(state, client);
    }
  }
  if (tab === "discipline") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    // Discipline is a plugin: no discipline.* calls while it's off.
    const { isTabAvailable } = await import("./plugin-host.js");
    if (client && isTabAvailable("discipline")) {
      if (!(state as any).disciplineState) {
        const { createDisciplineState } = await import("./controllers/discipline");
        (state as any).disciplineState = createDisciplineState();
      }
      const { loadDiscipline } = await import("./controllers/discipline");
      // The Day view reads Focus pins; pull the plugin's server copy first.
      const { hydrateFocusFromServer } = await import("./controllers/focus");
      await hydrateFocusFromServer(client);
      await loadDiscipline((state as any).disciplineState, client);
      state.requestUpdate?.();
    }
  }
  if (tab === "nodes") {
    await loadNodes(host as unknown as InfiniBotApp);
    await loadDevices(host as unknown as InfiniBotApp);
    await loadConfig(host as unknown as InfiniBotApp);
    await loadExecApprovals(host as unknown as InfiniBotApp);
  }
  if (tab === "chat") {
    await refreshChat(host as unknown as Parameters<typeof refreshChat>[0]);
    scheduleChatScroll(
      host as unknown as Parameters<typeof scheduleChatScroll>[0],
      !host.chatHasAutoScrolled,
    );
  }
  if (tab === "config") {
    await loadConfigSchema(host as unknown as InfiniBotApp);
    await loadConfig(host as unknown as InfiniBotApp);
  }
  if (tab === "apikeys") {
    const state = host as unknown as import("./app-view-state").AppViewState;
    const client = state.client;
    if (client) {
      if (!state.apiKeysState) {
        const { createInitialApiKeysState } = await import("./controllers/api-keys");
        state.apiKeysState = createInitialApiKeysState();
      }
      const { loadApiKeys } = await import("./controllers/api-keys");
      await loadApiKeys(state, client);
    }
  }
  if (tab === "debug") {
    await loadDebug(host as unknown as InfiniBotApp);
    host.eventLog = host.eventLogBuffer;
  }
  if (tab === "logs") {
    host.logsAtBottom = true;
    await loadLogs(host as unknown as InfiniBotApp, { reset: true });
    scheduleLogsScroll(
      host as unknown as Parameters<typeof scheduleLogsScroll>[0],
      true,
    );
  }
}

export function inferBasePath() {
  if (typeof window === "undefined") return "";
  const configured = window.__INFINIBOT_CONTROL_UI_BASE_PATH__;
  if (typeof configured === "string" && configured.trim()) {
    return normalizeBasePath(configured);
  }
  return inferBasePathFromPathname(window.location.pathname);
}

export function syncThemeWithSettings(host: SettingsHost) {
  host.theme = host.settings.theme ?? "system";
  applyResolvedTheme(host, resolveTheme(host.theme));
}

export function applyResolvedTheme(host: SettingsHost, resolved: ResolvedTheme) {
  host.themeResolved = resolved;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = host.theme ?? "system";
  // `colorScheme` only accepts light | dark | normal — collapse the hud theme
  // to dark so browser scrollbars / form controls still look right.
  root.style.colorScheme = resolved === "light" ? "light" : "dark";
}

export function attachThemeListener(host: SettingsHost) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  host.themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  host.themeMediaHandler = (event) => {
    if (host.theme !== "system") return;
    applyResolvedTheme(host, event.matches ? "dark" : ("light" as ResolvedTheme));
  };
  if (typeof host.themeMedia.addEventListener === "function") {
    host.themeMedia.addEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    addListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.addListener(host.themeMediaHandler);
}

export function detachThemeListener(host: SettingsHost) {
  if (!host.themeMedia || !host.themeMediaHandler) return;
  if (typeof host.themeMedia.removeEventListener === "function") {
    host.themeMedia.removeEventListener("change", host.themeMediaHandler);
    return;
  }
  const legacy = host.themeMedia as MediaQueryList & {
    removeListener: (cb: (event: MediaQueryListEvent) => void) => void;
  };
  legacy.removeListener(host.themeMediaHandler);
  host.themeMedia = null;
  host.themeMediaHandler = null;
}

export function syncTabWithLocation(host: SettingsHost, replace: boolean) {
  if (typeof window === "undefined") return;
  const match = matchRoute(window.location.pathname, host.basePath);
  applyDeepLink(host, match.detail);
  setTabFromRoute(host, match.tab, match.view ?? viewParam());
  // Preserve the detail path on initial load so a pasted /projects/:slug URL
  // is not rewritten back to /projects before the list page can consume it.
  if (match.detail && replace) {
    syncSessionParam(host, match.tab, replace);
  } else {
    syncUrlWithTab(host, match.tab, replace);
  }
}

export function onPopState(host: SettingsHost) {
  if (typeof window === "undefined") return;
  const match = matchRoute(window.location.pathname, host.basePath);

  const url = new URL(window.location.href);
  const session = url.searchParams.get("session")?.trim();
  if (session) {
    host.sessionKey = session;
    applySettings(host, {
      ...host.settings,
      sessionKey: session,
      lastActiveSessionKey: session,
    });
  }

  applyDeepLink(host, match.detail);
  setTabFromRoute(host, match.tab, match.view ?? viewParam());
}

/** Store (or clear) the pending deep-link descriptor for list pages to consume. */
function applyDeepLink(
  host: SettingsHost,
  detail: { kind: EntityKind; slug: string } | undefined,
) {
  if (detail) {
    host.deepLink = { kind: detail.kind, slug: detail.slug, pending: true };
  } else {
    host.deepLink = null;
  }
}

/**
 * Navigate to another tab AND open a specific record on it.
 *
 * This is the primitive a duplicate surface redirects through. A second view
 * of an entity (e.g. the Agency Operations client grid) should not maintain its
 * own profile overlay — it should hand the user to the canonical record page,
 * which is the only place the full profile, connections and activity thread
 * live. Pushes a real history entry so Back returns to the surface the user
 * clicked from.
 */
export function openEntityInTab(
  host: SettingsHost,
  kind: EntityKind,
  slug: string,
  tab: Tab,
): void {
  applyDeepLink(host, { kind, slug });
  pushEntityUrl(host, kind, slug, tab);
  setTabFromRoute(host, tab);
}

/** Update only the ?session query param without touching the (detail) pathname. */
function syncSessionParam(host: SettingsHost, tab: Tab, replace: boolean) {
  const url = new URL(window.location.href);
  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }
  if (replace) window.history.replaceState({}, "", url.toString());
  else window.history.pushState({}, "", url.toString());
}

/**
 * Push a slug deep-link URL for a selected entity (history entry so Back
 * returns to the list). Call from a list page's select handler.
 */
export function pushEntityUrl(
  host: SettingsHost,
  kind: EntityKind,
  slug: string,
  tab?: Tab,
) {
  if (typeof window === "undefined") return;
  const path = pathForEntity({ kind, slug, tab: tab ?? host.tab, basePath: host.basePath });
  const url = new URL(window.location.href);
  const target = new URL(path, window.location.origin);
  if (normalizePath(url.pathname) === normalizePath(target.pathname)) return;
  url.pathname = target.pathname;
  window.history.pushState({}, "", url.toString());
}

export function setTabFromRoute(host: SettingsHost, next: Tab, view?: string | null) {
  // Retired/deprecated tabs (e.g. standalone /chat → grid) land on their host.
  const route = subViewRouteForTab(next);
  next = resolveTabRedirect(next);
  if (host.tab !== next) host.tab = next;
  applyHostView(host, next, route?.view ?? view);
  if (next === "chat") host.chatHasAutoScrolled = false;
  syncTabPolling(host);
  if (host.connected) void refreshActiveTab(host);
}

/** `?view=` of the current URL (a merged host's sub-tab). */
function viewParam(): string | null {
  return new URL(window.location.href).searchParams.get("view");
}

export function syncUrlWithTab(host: SettingsHost, tab: Tab, replace: boolean) {
  if (typeof window === "undefined") return;
  const targetPath = normalizePath(pathForTab(tab, host.basePath));
  const currentPath = normalizePath(window.location.pathname);
  const url = new URL(window.location.href);

  if (tab === "chat" && host.sessionKey) {
    url.searchParams.set("session", host.sessionKey);
  } else {
    url.searchParams.delete("session");
  }

  if (currentPath !== targetPath) {
    url.pathname = targetPath;
  }

  // Merged host pages keep their sub-tab in ?view= (default sub-tab omits it).
  const views = subViewsForHost(tab);
  const view = host.hostView?.[tab];
  if (views.length && view && view !== views[0]!.id) url.searchParams.set("view", view);
  // A page without sub-views may own ?view= itself (Plugins: ?view=purchases);
  // keep it while staying on that page, drop it when navigating elsewhere.
  else if (views.length || currentPath !== targetPath) url.searchParams.delete("view");

  if (replace) {
    window.history.replaceState({}, "", url.toString());
  } else {
    window.history.pushState({}, "", url.toString());
  }
}

export function syncUrlWithSessionKey(
  host: SettingsHost,
  sessionKey: string,
  replace: boolean,
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("session", sessionKey);
  if (replace) window.history.replaceState({}, "", url.toString());
  else window.history.pushState({}, "", url.toString());
}

/**
 * Consume a pending deep-link for a given entity kind from a list page.
 * Resolves the URL slug against the loaded store (`candidates`) and returns the
 * matched entity (or `{ id }` recovered from the slug when the store hasn't
 * loaded yet). Marks the deep-link consumed so it fires exactly once, avoiding
 * re-open loops on subsequent reactive renders. Returns null when there is no
 * pending deep-link for this kind.
 */
export function consumeDeepLink(
  host: SettingsHost,
  kind: EntityKind,
  candidates: readonly EntityRef[],
): EntityRef | null {
  const dl = host.deepLink;
  if (!dl || !dl.pending || dl.kind !== kind) return null;
  const ref = resolveSlug(kind, dl.slug, candidates);
  host.deepLink = { ...dl, pending: false };
  return ref;
}

export async function loadChannelsTab(host: SettingsHost) {
  await Promise.all([
    loadChannels(host as unknown as InfiniBotApp, true),
    loadConfigSchema(host as unknown as InfiniBotApp),
    loadConfig(host as unknown as InfiniBotApp),
  ]);
}
