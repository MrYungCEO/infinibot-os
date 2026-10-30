import { LitElement, html, nothing } from "lit";
import { SECURE_MODE_EVENT, ensureSecureGlobalStyles } from "./secure-mode";
import { customElement, state } from "lit/decorators.js";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import { resolveInjectedAssistantIdentity } from "./assistant-identity";
import { pickupAuthFromHash } from "./auth-hash";
import { isSaasMode } from "./saas-clerk";
import { loadSettings, type UiSettings } from "./storage";
import { setCurrentLocale } from "./i18n";
import { renderApp } from "./app-render";
import { matchRoute, tabFromPath, type Tab } from "./navigation";
import { deepLinkToWebRoute, withBasePath } from "./deep-link-route.js";
import { installChatFollow, onAppTabChanged as onChatFollowTabChanged } from "./chat/chat-follow-nav";
import type { ResolvedTheme, ThemeMode } from "./theme";
import type {
  AgentsListResult,
  ConfigSnapshot,
  ConfigUiHints,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,

  NostrProfile,
} from "./types";
import type { SkillMessage } from "./controllers/skills";
import type { AgentsManagerState } from "./controllers/agents";
import { createAgentsManagerState } from "./controllers/agents";
import { type ChatAttachment, type ChatQueueItem } from "./ui-types";
import type { EventLogEntry } from "./app-events";
import { DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "./controllers/exec-approvals";
import type { DevicePairingList } from "./controllers/devices";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
} from "./app-tool-stream";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
} from "./app-scroll";
import { connectGateway as connectGatewayInternal } from "./app-gateway";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle";
import { loadNavSidebarState } from "./controllers/nav-sidebar";
import { loadInstanceProjectAssignments } from "./controllers/instance-projects";
import { loadClockState, updateTimerRemaining, checkAlarms, isAlarmSounding, stopAlarmSound, type ClockState } from "./components/terminal-clock";
import {
  applySettings as applySettingsInternal,
  setTab as setTabInternal,
  setHostView as setHostViewInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
} from "./app-chat";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity";
import { applyConfig, loadConfig, updateConfigFormValue } from "./controllers/config";
import { injectGlassTheme } from "./theme-glass";
import { applyCachedBranding } from "./controllers/app-branding";
import { createAutopilotState, type AutopilotState } from "./controllers/autopilot";
import { installAutopilotSubscribers } from "./controllers/autopilot-subscribers";
import { normalizeModelsList } from "./model-filter";

declare global {
  interface Window {
    __INFINIBOT_CONTROL_UI_BASE_PATH__?: string;
  }
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) return false;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

@customElement("infinibot-app")
export class InfiniBotApp extends LitElement {
  @state() settings: UiSettings = (() => {
    const loaded = loadSettings();
    setCurrentLocale(loaded.locale);
    return loaded;
  })();
  @state() password = "";
  @state() tab: Tab = "dashboard";
  /** Active sub-tab per merged host page (navigation HOST_SUBVIEWS). */
  @state() hostView: Partial<Record<Tab, string>> = {};
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() reconnecting = false;
  @state() reconnectAttempt = 0;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  /**
   * Session key whose history is currently in `chatMessages`. When the user
   * switches threads we clear messages and bump this to null until the new
   * session's history finishes loading — that's how the grid chat panel
   * avoids the "old messages flash + empty placeholder" UX. The chat thread
   * checks this to know whether to show the empty-state card or a skeleton.
   */
  @state() chatLoadedSessionKey: string | null = null;
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatThinkingStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() compactionStatus: import("./app-tool-stream").CompactionStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() videoModeEnabled = false;
  @state() threadsSidebarOpen = false;
  @state() sidebarCategoriesState: import("./controllers/sidebar-categories").SidebarState | null = null;
  @state() navSidebarState: import("./controllers/nav-sidebar").NavSidebarState | null = null;
  // Terminal clock
  @state() clockState: ClockState | null = null;
  @state() clockTime: Date = new Date();
  private clockInterval: number | null = null;
  @state() activityPanelOpen = false;
  // Agent chat sidebar (page-by-page autopilot)
  @state() autopilotState: AutopilotState = createAutopilotState();
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown | null = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() whatsappLoginMode: "pairing" | "qr" = "pairing";
  @state() whatsappPhoneNumber = "";
  @state() whatsappPairingCode: string | null = null;
  // Deep-link detail descriptor parsed from the URL (see navigation.matchRoute).
  @state() deepLink:
    | { kind: import("./lib/slugs").EntityKind; slug: string; pending: boolean }
    | null = null;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() instanceProjectsAssignments: Record<string, string[]> = {};
  @state() instanceProjectsContextMenu: import("./views/instances").InstanceContextMenu = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() learnedSkills: import("./controllers/skills").LearnedSkill[] = [];
  @state() learnedLoading = false;
  @state() learnedError: string | null = null;
  @state() learnedSelfImproveRunning = false;
  @state() learnedSelfImproveSummary: string | null = null;
  @state() learnedSkillsEnabled = true;
  @state() skillDrafts: import("./types").SkillDraftUi[] = [];
  @state() skillDraftsLoading = false;
  @state() skillDraftsError: string | null = null;
  @state() skillHealingProposals: import("./types").HealingProposalUi[] = [];
  @state() skillHealingLoading = false;
  @state() skillHealingError: string | null = null;
  @state() skillActivity: import("./types").SkillActivityEntry[] = [];
  @state() skillActivityLoading = false;
  @state() skillSystemConfig: import("./types").SkillSystemConfig | null = null;
  @state() skillConfigLoading = false;
  @state() skillConfigSaving = false;
  @state() skillQueueStats: import("./types").SkillQueueStats | null = null;
  @state() skillQueueStatsLoading = false;
  @state() agentsManagerState: AgentsManagerState = createAgentsManagerState() as any;
  @state() agentsManagementState: import("./controllers/agents-management").AgentsManagementState | null = null;
  @state() usersManagementState: import("./controllers/users-management").UsersManagementState | null = null;
  @state() mcpManagementState: import("./controllers/mcp").McpManagementState | null = null;
  @state() autonomyState: import("./controllers/autonomy").AutonomyDashboardState | null = null;
  @state() notesState: import("./controllers/notes").NotesState | null = null;
  @state() researchState: unknown | null = null;
  @state() terminalsState: import("./controllers/terminals").TerminalsState | null = null;
  @state() businessState: import("./controllers/business").BusinessState | null = null;
  @state() agencyOperationsState: import("./controllers/agency-operations").AgencyOperationsState | null = null;
  @state() disciplineState: import("./controllers/discipline").DisciplineState | null = null;
  @state() brandState: import("./controllers/brand").BrandState | null = null;
  @state() appBrandingState: import("./controllers/app-branding").AppBrandingState | null = null;
  @state() notionDbState: import("./controllers/notion-databases").NotionDbManagerState | null = null;
  @state() masonryGridState: import("./controllers/masonry-grid").MasonryGridState | null = null;
  @state() onboardingState: import("./controllers/onboarding").OnboardingState | null = null;
  @state() agentIdentityState: import("./controllers/agent-identity").AgentIdentityState | null = null;
  @state() emailMarketingState: import("./controllers/email-marketing").EmailMarketingState | null = null;

  // Kanban / Projects
  @state() kanbanProjects: import("./types").KanbanProject[] = [];
  @state() kanbanTasks: import("./types").KanbanTask[] = [];
  @state() kanbanLoading = false;
  @state() kanbanError: string | null = null;
  @state() kanbanGalleryView = true;
  @state() kanbanSelectedProjectId: string | null = null;
  // Gallery toolbar — drives the Tasks / AI Projects / All / Active / Completed
  // / Paused tabs above the kanban grid. Persisted in app state so a tab click
  // survives lit's reactive re-render (otherwise the pill flashes back to "all"
  // every paint).
  @state() kanbanGalleryFilter: string = "all";
  @state() kanbanGallerySearch: string = "";
  @state() kanbanGallerySort: string = "recent";
  // Lead qualifier — initialised lazily when the user opens the tab.
  @state() leadQualifierState: import("./controllers/lead-qualifier").LeadQualifierState | undefined = undefined;
  // Lead-qualifier form builder — lazy slot, populated when /qualifier opens.
  @state() leadQualifierFormsState: import("./controllers/lead-qualifier-forms").LeadQualifierFormsState | undefined = undefined;
  // Cron jobs / workflow scheduling — initialised lazily when /schedule loads.
  @state() cronState: import("./controllers/cron").CronState | undefined = undefined;
  @state() scheduleTab: "calendar" | "cron" | "workflows" = "calendar";

  // Notifications
  @state() notifications: import("./controllers/notifications").AppNotification[] = [];
  @state() notificationHistory: import("./controllers/notifications").AppNotification[] = [];
  @state() notificationHistoryOpen = false;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown | null = null;

  // Available models for the model selector dropdown
  @state() availableModels: Array<{ id: string; name: string; provider?: string; contextWindow?: number; reasoning?: boolean; vision?: boolean; unconfigured?: boolean }> = [];
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  basePath = "";
  private popStateHandler = () => {
    const prevTab = this.tab;
    onPopStateInternal(
      this as unknown as Parameters<typeof onPopStateInternal>[0],
    );
    this.afterTabChange(prevTab, this.lastRoutePath);
  };
  /** Path at the last tab change — popstate fires after the URL already moved. */
  private lastRoutePath: string | null = null;
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  // Reload the model catalog when a surface (e.g. the chat model dropdown's
  // inline provider-setup modal) saves a new provider key, so the now-configured
  // provider's models appear without a full page reload.
  private _onModelsRefresh = () => { void this.loadAvailableModels(); };

  connectedCallback() {
    super.connectedCallback();

    window.addEventListener("models:refresh", this._onModelsRefresh);
    // Secure Mode toggled anywhere (this tab, another tab, the agent) → the
    // top-bar badge, shell frame and lane-aware pages re-render.
    window.addEventListener(SECURE_MODE_EVENT, this._onSecureModeChange);
    ensureSecureGlobalStyles();
    // Links in chat replies navigate in-app and carry the chat along.
    installChatFollow({ navigate: (route) => this.navigateToRoute(route) });

    // Glass theme tokens (safe if called multiple times; guards internally).
    injectGlassTheme();
    // Apply cached branding before any surface renders so the gate + shell
    // show the user's customization before we've reconnected to the gateway.
    applyCachedBranding();

    // Initialize nav sidebar state from localStorage on mount (instant)
    // This ensures drag-drop state is preserved across renders
    // Gateway sync happens in app-gateway.ts onHello callback
    if (!this.navSidebarState) {
      this.navSidebarState = loadNavSidebarState();
    }

    // Mirror the global biz-filter into businessState.activeBusinessId so
    // any legacy controller (clients, leads, income, summary) that already
    // reads activeBusinessId scopes alongside the unified filter. Also
    // reloads the active CRM/Databases pages so the rows/cards repaint
    // immediately when the user picks a different business in any
    // dropdown.
    void import("./lib/biz-filter").then(({ getBizFilter, subscribeBizFilter }) => {
      const initial = getBizFilter();
      if (initial && this.businessState) {
        this.businessState.activeBusinessId = initial;
      }
      const unsub = subscribeBizFilter(() => {
        const v = getBizFilter();
        const bs = this.businessState;
        if (bs && bs.activeBusinessId !== v) {
          bs.activeBusinessId = v;
        }
        // Page-specific re-loads so the visible page reflects the new scope
        // without the user having to refresh.
        if (this.client) {
          if (this.tab === "clients" && bs?._clientsState) {
            void import("./controllers/clients").then(({ loadClients }) =>
              loadClients(this as unknown as import("./app-view-state").AppViewState, this.client!),
            );
          }
          if (this.tab === "business") {
            void import("./controllers/business").then(({ loadIncomeStats, loadBusinessSummary }) => {
              void loadIncomeStats(this as unknown as import("./app-view-state").AppViewState, this.client!, { force: true });
              void loadBusinessSummary(this as unknown as import("./app-view-state").AppViewState, this.client!);
            });
          }
        }
        this.requestUpdate();
      });
      // Guard against double-subscribe across reconnects.
      (this as { _bizFilterUnsub?: () => void })._bizFilterUnsub = unsub;
    });
    
    // Initialize instance-project assignments
    if (Object.keys(this.instanceProjectsAssignments).length === 0) {
      this.instanceProjectsAssignments = loadInstanceProjectAssignments();
    }
    
    // Initialize terminal clock
    if (!this.clockState) {
      this.clockState = loadClockState();
    }

    // Hydrate persisted notification (alert) history so the activity page
    // can show alerts that arrived in previous sessions.
    if (this.notificationHistory.length === 0) {
      // Lazy import to avoid circulars; this file is small.
      import("./controllers/notifications").then(({ loadNotificationHistory }) => {
        const persisted = loadNotificationHistory();
        if (persisted.length > 0) {
          this.notificationHistory = persisted;
          this.requestUpdate();
        }
      }).catch(() => { /* ignore — non-critical */ });
    }
    // Clock/timer tick. The visible clock and timer countdowns are only
    // second-granular, so we poll at a modest cadence but ONLY mutate the
    // reactive @state (clockTime/clockState) when the displayed second
    // actually changes. This keeps the whole-app re-render driven by the
    // clock at ~1Hz instead of 10Hz — a universal FPS win on every page.
    let lastAlarmCheck = 0;
    let lastRenderedSecond = -1;
    this.clockInterval = window.setInterval(() => {
      const nowDate = new Date();
      const sec = Math.floor(nowDate.getTime() / 1000);
      if (sec === lastRenderedSecond) return; // nothing visible changed yet
      lastRenderedSecond = sec;
      this.clockTime = nowDate;
      // Update running timers
      if (this.clockState && this.clockState.timers.some(t => t.running)) {
        this.clockState = updateTimerRemaining(
          this.clockState,
          this.client, // Pass gateway client for Telegram
          (timer) => {
            console.log('[App] Timer completed:', timer.label);
          }
        );
      }
      // Check alarms every second (not every 100ms)
      const now = nowDate.getTime();
      if (now - lastAlarmCheck >= 1000 && this.clockState) {
        lastAlarmCheck = now;
        const firedAlarms = checkAlarms(
          this.clockState,
          this.client, // Pass gateway client for Telegram
          (alarm) => {
            // Show in-app toast notification
            console.log('[App] Alarm fired:', alarm.label);
            // Trigger a UI notification if we have a notification system
            if ((this as any).showToast) {
              (this as any).showToast(`⏰ Alarm: ${alarm.label}`, 'warning');
            }
          }
        );
        if (firedAlarms.length > 0) {
          this.requestUpdate();
        }
      }
    }, 250);
    
    // Pick up credentials from the URL hash before falling back to other
    // sources. Launchers (`infinibot ui open`, the Mac app, deep links)
    // ship a fresh `#token=...` or `#password=...` so the user doesn't
    // have to paste anything into the settings panel. The helper persists
    // to localStorage and scrubs the hash; we re-read settings here so the
    // in-memory copy reflects the new token.
    // SaaS mode: Clerk is the ONLY auth. Never pick up or reuse a gateway
    // password (URL hash, electron, or persisted) — a stale gateway password
    // would let a new Clerk identity reconnect as the previous user, which is a
    // cross-tenant data leak. The Clerk session token is supplied at WS connect.
    if (!isSaasMode()) {
      const picked = pickupAuthFromHash();
      if (picked.token || picked.password) {
        this.settings = loadSettings();
        if (picked.password) this.password = picked.password;
        console.log('[App] Picked up credentials from URL hash');
      }

      // Check for electron-injected password for auto-auth
      const electronPassword = (window as any).__INFINIBOT_GATEWAY_PASSWORD__
        || sessionStorage.getItem('infinibot-electron-password');
      if (electronPassword && !this.password) {
        console.log('[App] Using electron-injected password for auth');
        this.password = electronPassword;
      }

      // Load persisted password from settings for auto-reconnect
      if (!this.password && this.settings.password) {
        console.log('[App] Using persisted password from settings');
        this.password = this.settings.password;
      }
    }
    
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
    // Wire autopilot bus → controller actions. Cleanup is handled on
    // disconnectedCallback via _autopilotUnsub.
    this._autopilotUnsub = installAutopilotSubscribers(
      this as unknown as Parameters<typeof installAutopilotSubscribers>[0],
    );
  }

  private _autopilotUnsub: (() => void) | null = null;

  private _onSecureModeChange = () => { this.requestUpdate(); };

  disconnectedCallback() {
    window.removeEventListener("models:refresh", this._onModelsRefresh);
    window.removeEventListener(SECURE_MODE_EVENT, this._onSecureModeChange);
    // Cleanup clock interval
    if (this.clockInterval) {
      clearInterval(this.clockInterval);
      this.clockInterval = null;
    }
    // Cleanup autopilot subscribers
    this._autopilotUnsub?.();
    this._autopilotUnsub = null;
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(
      this as unknown as Parameters<typeof handleUpdated>[0],
      changed,
    );
  }

  connect() {
    connectGatewayInternal(
      this as unknown as Parameters<typeof connectGatewayInternal>[0],
    );
  }

  setPassword(next: string) {
    this.password = next;
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(
      this as unknown as Parameters<typeof resetToolStreamInternal>[0],
    );
  }

  resetChatScroll() {
    resetChatScrollInternal(
      this as unknown as Parameters<typeof resetChatScrollInternal>[0],
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(
      this as unknown as Parameters<typeof applySettingsInternal>[0],
      next,
    );
  }

  setTab(next: Tab) {
    const prevTab = this.tab;
    const prevPath = typeof window !== "undefined" ? window.location.pathname : null;
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
    this.afterTabChange(prevTab, prevPath);
  }

  /** Chat follows navigation (./chat/chat-follow-nav.ts): open the chat dock / phone pill. */
  private afterTabChange(prevTab: Tab, prevPath: string | null) {
    this.lastRoutePath = typeof window !== "undefined" ? window.location.pathname : null;
    try {
      onChatFollowTabChanged({ prevTab, nextTab: this.tab, prevPath });
    } catch (err) {
      console.warn("[chat-follow] tab change hook failed", err);
    }
  }

  /**
   * In-app navigation to a route (link in a chat reply). Returns false when
   * the route isn't an app page, so the caller can open it in a new tab.
   */
  navigateToRoute(route: string): boolean {
    let target = route;
    if (/^infinibot:\/\//i.test(target)) {
      const resolved = deepLinkToWebRoute(target);
      if (!resolved) return false;
      target = withBasePath(resolved, this.basePath);
    }
    const pathOnly = target.split(/[?#]/)[0] ?? target;
    const match = matchRoute(pathOnly, this.basePath);
    const known = tabFromPath(pathOnly, this.basePath) !== null || Boolean(match.detail) || match.tab !== "dashboard";
    if (!known) return false;
    const prevTab = this.tab;
    const prevPath = window.location.pathname;
    window.history.pushState({}, "", target);
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
    this.afterTabChange(prevTab, prevPath);
    return true;
  }

  setHostView(view: string) {
    setHostViewInternal(this as unknown as Parameters<typeof setHostViewInternal>[0], view);
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(
      this as unknown as Parameters<typeof setThemeInternal>[0],
      next,
      context,
    );
  }

  async handleAbortChat() {
    await handleAbortChatInternal(
      this as unknown as Parameters<typeof handleAbortChatInternal>[0],
    );
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) return;
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  async loadAvailableModels() {
    if (!this.client || !this.connected) return;
    try {
      console.log("[models] Loading available models...");
      const res = await this.client.request("models.list", {}) as { models?: Array<{ id?: string; name?: string; provider?: string; contextWindow?: number; reasoning?: boolean; vision?: boolean; unconfigured?: boolean }> } | undefined;
      console.log("[models] Raw response:", res);
      if (res?.models && Array.isArray(res.models)) {
        this.availableModels = normalizeModelsList(res);
        console.log("[models] Processed models:", this.availableModels.length, this.availableModels);
        // Trigger re-render to update model selectors
        this.requestUpdate();
      } else {
        console.warn("[models] No models in response or invalid format");
      }
    } catch (err) {
      console.warn("[models] Failed to load available models:", err);
    }
  }

  async patchSessionModel(sessionKey: string, model: string) {
    if (!this.client || !this.connected) return;
    try {
      await this.client.request("sessions.patch", { key: sessionKey, model });
      // Reload sessions to reflect the change
      const loadSessionsModule = await import("./controllers/sessions");
      await loadSessionsModule.loadSessions(this as unknown as Parameters<typeof loadSessionsModule.loadSessions>[0]);
    } catch (err) {
      console.error("[sessions] Failed to patch session model:", err);
      this.lastError = `Failed to change model: ${String(err)}`;
    }
  }

  patchConfigValue(path: Array<string | number>, value: unknown) {
    updateConfigFormValue(this, path, value);
  }

  async saveAndApplyConfig() {
    // Make sure we have the latest config first
    if (!this.configForm && !this.configSnapshot?.config) {
      await loadConfig(this);
    }
    await applyConfig(this);
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) return;
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  handleMcpSetup(_open: boolean) {
    // no-op after kanban removal
  }

  // Notion sync status (used by workflows view for external links)
  @state() notionSyncStatus: { syncing: boolean; lastSync: number | null; error: string | null; projectsDbId?: string | null; tasksDbId?: string | null; parentPageId?: string | null } | null = null;

  render() {
    return renderApp(this as unknown as import("./app-view-state").AppViewState);
  }
}
