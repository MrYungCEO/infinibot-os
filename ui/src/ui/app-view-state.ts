import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { Tab } from "./navigation";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  AgentsListResult,
  ChannelsStatusSnapshot,
  ConfigSnapshot,
  ConfigUiHints,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  NostrProfile,
  PresenceEntry,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatAttachment, ChatQueueItem } from "./ui-types";
import type { InstanceContextMenu } from "./views/instances";
import type { EventLogEntry } from "./app-events";
import type { SkillMessage } from "./controllers/skills";
import type {
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
} from "./controllers/exec-approvals";
import type { DevicePairingList } from "./controllers/devices";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form";
import type { AgentsManagerState } from "./controllers/agents";
import type { AgentsManagementState } from "./controllers/agents-management";
import type { WorkflowsState } from "./controllers/workflows";
import type { NotesState } from "./controllers/notes";
import type { AgentActivityState } from "./controllers/agent-activity";
import type { AutonomyDashboardState } from "./controllers/autonomy";
import type { McpManagementState } from "./controllers/mcp";
import type { TerminalsState } from "./controllers/terminals";
import type { BusinessState } from "./controllers/business";
import type { AgencyOperationsState } from "./controllers/agency-operations";
import type { AgencyTopologyState } from "./controllers/agency-topology";
import type { AgencyDailyState } from "./controllers/agency-daily";
import type { AgencyAutonomyState } from "./controllers/agency-autonomy-board";
import type { NotionDbManagerState } from "./controllers/notion-databases";
import type { FilesState } from "./controllers/files";
import type { AppNotification } from "./controllers/notifications";
import type { UsersManagementState } from "./controllers/users-management";
import type { KanbanProject, KanbanTask } from "./types";
import type { SetupState } from "./controllers/setup";
import type { NetworkState } from "./controllers/network";
import type { SidebarState } from "./controllers/sidebar-categories";
import type { NavSidebarState } from "./controllers/nav-sidebar";
import type { ClockState } from "./components/terminal-clock";
import type { OnboardingState } from "./controllers/onboarding";
import type { FederationState } from "./controllers/federation";
import type { ServiceWithInstance, ServiceDefinition } from "./controllers/services";
import type { PresetBuilderState } from "./controllers/preset-builder";
import type { BrandState } from "./controllers/brand";
import type { AutopilotState } from "./controllers/autopilot";

export type AppViewState = {
  settings: UiSettings;
  password: string;
  tab: Tab;
  onboarding: boolean;
  onboardingState: OnboardingState | null;
  basePath: string;
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempt: number;
  theme: ThemeMode;
  themeResolved: "light" | "dark";
  hello: GatewayHelloOk | null;
  lastError: string | null;
  eventLog: EventLogEntry[];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  chatLoading: boolean;
  chatSending: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatMessages: unknown[];
  chatToolMessages: unknown[];
  chatStream: string | null;
  chatStreamStartedAt: number | null;
  chatRunId: string | null;
  compactionStatus: import("./app-tool-stream").CompactionStatus | null;
  chatAvatarUrl: string | null;
  chatThinkingLevel: string | null;
  chatQueue: ChatQueueItem[];
  threadsSidebarOpen: boolean;
  sidebarCategoriesState: SidebarState | null;
  navSidebarState: NavSidebarState | null;
  clockState: ClockState | null;
  clockTime: Date;
  nodesLoading: boolean;
  nodes: Array<Record<string, unknown>>;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalBusy: boolean;
  execApprovalError: string | null;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configSnapshot: ConfigSnapshot | null;
  configSchema: unknown | null;
  configSchemaLoading: boolean;
  configSchemaVersion: string | null;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  applySessionKey: string;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  whatsappLoginMode: "pairing" | "qr";
  whatsappPhoneNumber: string;
  whatsappPairingCode: string | null;
  /** Live oversight board on the Agency Operations "Work allocation" tab. */
  agencyOversightState?: import("./controllers/agency-oversight").AgencyOversightState | null;
  /**
   * Pending deep-link detail descriptor parsed from the URL (e.g.
   * /projects/:slug, /notes/:slug). List pages consume this on mount to
   * auto-open the addressed entity, then clear it. Null when the URL points at
   * a plain tab. See navigation.ts `matchRoute` + lib/slugs.ts.
   */
  deepLink?: {
    kind: import("./lib/slugs").EntityKind;
    slug: string;
    /** True until a list page has consumed it (prevents re-opening loops). */
    pending: boolean;
  } | null;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  configFormDirty: boolean;
  presenceLoading: boolean;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: string | null;
  instanceProjectsAssignments: Record<string, string[]>;
  instanceProjectsContextMenu: InstanceContextMenu;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillEdits: Record<string, string>;
  skillMessages: Record<string, SkillMessage>;
  skillsBusyKey: string | null;
  learnedSkills: import("./controllers/skills").LearnedSkill[];
  learnedLoading: boolean;
  learnedError: string | null;
  learnedSelfImproveRunning: boolean;
  learnedSelfImproveSummary: string | null;
  learnedSkillsEnabled: boolean;
  // Skill auto-generation queues
  skillDrafts: import("./types").SkillDraftUi[];
  skillDraftsLoading: boolean;
  skillDraftsError: string | null;
  skillHealingProposals: import("./types").HealingProposalUi[];
  skillHealingLoading: boolean;
  skillHealingError: string | null;
  skillActivity: import("./types").SkillActivityEntry[];
  skillActivityLoading: boolean;
  skillSystemConfig: import("./types").SkillSystemConfig | null;
  skillConfigLoading: boolean;
  skillConfigSaving: boolean;
  skillQueueStats: import("./types").SkillQueueStats | null;
  skillQueueStatsLoading: boolean;
  // Agent management state
  agentsManagerState: AgentsManagerState;
  agentsManagementState: AgentsManagementState | null;
  usersManagementState: UsersManagementState | null;
  workflowsState: WorkflowsState | null;
  notesState: NotesState | null;
  researchState: unknown | null;
  agentActivityState: AgentActivityState | null;
  autonomyState: AutonomyDashboardState | null;
  mcpManagementState: McpManagementState | null;
  terminalsState: TerminalsState | null;
  businessState: BusinessState | null;
  agencyOperationsState: AgencyOperationsState | null;
  /**
   * Agency Topology / Daily Operations own their state lazily — the view
   * creates it on first render, so these stay optional and the app shell does
   * not have to seed them.
   */
  agencyTopologyState?: AgencyTopologyState | null;
  agencyDailyState?: AgencyDailyState | null;
  /** Delivery ⇄ autonomy split board, hosted on the Daily Operations surface. */
  agencyAutonomyState?: AgencyAutonomyState | null;
  disciplineState: import("./controllers/discipline").DisciplineState | null;
  brandState: BrandState | null;
  appBrandingState: import("./controllers/app-branding").AppBrandingState | null;
  notionDbState: NotionDbManagerState | null;
  filesState: FilesState | null;
  setupState: SetupState | null;
  networkState: NetworkState | null;
  // Vault (Kingly Vault community management)
  vaultState: unknown | null;
  // Federation state
  federationState: FederationState | null;
  // Services state (federation API servers)
  services: ServiceWithInstance[];
  servicesLoading: boolean;
  servicesError: string | null;
  servicesSelectedServiceId: string | null;
  servicesActionInProgress: string | null;
  servicesRegisterFormVisible: boolean;
  servicesRegisterForm: Partial<ServiceDefinition>;
  gatewayClient: import("./gateway").GatewayBrowserClient | null;
  // Kanban / Projects
  kanbanProjects: KanbanProject[];
  kanbanTasks: KanbanTask[];
  kanbanLoading: boolean;
  kanbanError: string | null;
  /** Session key whose history is currently materialized in chatMessages. Null if cleared during a switch. */
  chatLoadedSessionKey?: string | null;
  /** Lead qualifier — per-business webhook + criteria + action stack configs. */
  leadQualifierState?: import("./controllers/lead-qualifier").LeadQualifierState;
  /** Lead-qualifier form builder — public branded forms feeding the qualifier. */
  leadQualifierFormsState?: import("./controllers/lead-qualifier-forms").LeadQualifierFormsState;
  /** Cron jobs / scheduled workflows on the Schedule view. */
  cronState?: import("./controllers/cron").CronState;
  /** Sub-tab selected on /schedule (calendar | cron | workflows). */
  scheduleTab?: "calendar" | "cron" | "workflows";
  kanbanGalleryView: boolean;
  kanbanSelectedProjectId: string | null;
  /** Background revalidation in progress — cached data is already displayed. */
  kanbanRefreshing?: boolean;
  /** Gallery filter pill — drives the Tasks / AI Projects / All / Active / Completed / Paused tabs above the kanban grid. */
  kanbanGalleryFilter: string;
  kanbanGallerySearch: string;
  kanbanGallerySort: string;
  // Effect Preset Builder
  presetBuilder: PresetBuilderState | null;
  debugLoading: boolean;
  debugStatus: StatusSummary | null;
  debugHealth: HealthSnapshot | null;
  debugModels: unknown[];
  debugHeartbeat: unknown | null;
  debugCallMethod: string;
  debugCallParams: string;
  debugCallResult: string | null;
  debugCallError: string | null;
  logsLoading: boolean;
  logsError: string | null;
  logsFile: string | null;
  logsEntries: LogEntry[];
  logsFilterText: string;
  logsLevelFilters: Record<LogLevel, boolean>;
  logsAutoFollow: boolean;
  logsTruncated: boolean;
  logsCursor: number | null;
  logsLastFetchAt: number | null;
  logsLimit: number;
  logsMaxBytes: number;
  logsAtBottom: boolean;
  sidebarOpen: boolean;
  sidebarContent: string | null;
  sidebarError: string | null;
  splitRatio: number;
  // Notion sync status (used by workflows view)
  notionSyncStatus: { syncing: boolean; lastSync: number | null; error: string | null; projectsDbId?: string | null; tasksDbId?: string | null; parentPageId?: string | null } | null;
  // Notifications
  notifications: AppNotification[];
  notificationHistory: AppNotification[];
  notificationHistoryOpen: boolean;

  // Agent Identity Files state — manages per-agent SOUL.md / MEMORY.md / etc.
  agentIdentityState: import("./controllers/agent-identity").AgentIdentityState | null;

  // Unified Inbox state (replaces separate email + reply-inbox states)
  inboxState: import("./views/inbox").InboxState | null;

  // Email Marketing (Loops.so) state
  emailMarketingState: import("./controllers/email-marketing").EmailMarketingState | null;

  // Sovereign Memory state
  memoryLoading: boolean;
  memoryError: string | null;
  memoryConnected: boolean;
  memoryIdentity: import("./controllers/memory").Identity | null;
  memoryBeliefs: import("./controllers/memory").CoreBelief[];
  memoryValues: import("./controllers/memory").CoreValue[];
  memoryRelationships: import("./controllers/memory").Relationship[];
  memoryMemories: import("./controllers/memory").Memory[];
  memoryLessons: import("./controllers/memory").Lesson[];
  memoryStats: import("./controllers/memory").MemoryStats | null;
  memorySearchQuery: string;
  memorySearchResults: import("./controllers/memory").Memory[];
  memorySearching: boolean;
  memoryIngesting: boolean;
  memoryIngestResult: { conversationsProcessed: number; memoriesCreated: number } | null;
  memoryExporting: boolean;
  memoryExportResult: { pairs: number; path: string } | null;
  memoryNewBeliefText: string;
  memoryNewBeliefDomain: string;
  memoryNewBeliefCertainty: number;
  memoryNewMemoryContent: string;
  memoryNewMemoryType: string;
  memoryNewMemoryDomains: string;
  memoryNewMemoryImportance: number;

  // Docker container management state

  // API Keys state
  apiKeysState: import("./controllers/api-keys").ApiKeysState | null;

  activityPanelOpen: boolean;
  /** Page-by-page agentic chat sidebar state (autopilot mode). */
  autopilotState: AutopilotState | null;
  /** Masonry grid (multi-panel chat) state — used by autopilot grid commands. */
  masonryGridState?: import("./controllers/masonry-grid").MasonryGridState | null;
  client: GatewayBrowserClient | null;
  connect: () => void;
  setTab: (tab: Tab) => void;
  /** Active sub-tab per merged host page (navigation HOST_SUBVIEWS). */
  hostView: Partial<Record<Tab, string>>;
  setHostView: (view: string) => void;
  setTheme: (theme: ThemeMode, context?: ThemeTransitionContext) => void;
  applySettings: (next: UiSettings) => void;
  loadAssistantIdentity: () => Promise<void>;
  handleWhatsAppStart: (force: boolean) => Promise<void>;
  handleWhatsAppWait: () => Promise<void>;
  handleWhatsAppLogout: () => Promise<void>;
  handleChannelConfigSave: () => Promise<void>;
  handleChannelConfigReload: () => Promise<void>;
  handleNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  handleNostrProfileCancel: () => void;
  handleNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  handleNostrProfileSave: () => Promise<void>;
  handleNostrProfileImport: () => Promise<void>;
  handleNostrProfileToggleAdvanced: () => void;
  handleExecApprovalDecision: (decision: "allow-once" | "allow-always" | "deny") => Promise<void>;
  handleConfigLoad: () => Promise<void>;
  handleConfigSave: () => Promise<void>;
  handleConfigApply: () => Promise<void>;
  handleConfigFormUpdate: (path: string, value: unknown) => void;
  handleConfigFormModeChange: (mode: "form" | "raw") => void;
  handleConfigRawChange: (raw: string) => void;
  handleInstallSkill: (key: string) => Promise<void>;
  handleUpdateSkill: (key: string) => Promise<void>;
  handleToggleSkillEnabled: (key: string, enabled: boolean) => Promise<void>;
  handleUpdateSkillEdit: (key: string, value: string) => void;
  handleSaveSkillApiKey: (key: string, apiKey: string) => Promise<void>;
  handleSessionsLoad: () => Promise<void>;
  handleSessionsPatch: (key: string, patch: unknown) => Promise<void>;
  handleLoadNodes: () => Promise<void>;
  handleLoadPresence: () => Promise<void>;
  handleLoadSkills: () => Promise<void>;
  handleLoadDebug: () => Promise<void>;
  handleLoadLogs: () => Promise<void>;
  handleLoadMemory: () => Promise<void>;
  handleMcpSetup: (open: boolean) => void;
  handleDebugCall: () => Promise<void>;
  handleRunUpdate: () => Promise<void>;
  setPassword: (next: string) => void;
  setSessionKey: (next: string) => void;
  setChatMessage: (next: string) => void;
  handleChatSend: () => Promise<void>;
  handleChatAbort: () => Promise<void>;
  handleChatSelectQueueItem: (id: string) => void;
  handleChatDropQueueItem: (id: string) => void;
  handleChatClearQueue: () => void;
  handleLogsFilterChange: (next: string) => void;
  handleLogsLevelFilterToggle: (level: LogLevel) => void;
  handleLogsAutoFollowToggle: (next: boolean) => void;

  resetToolStream: () => void;
  resetChatScroll: () => void;
  handleChatScroll: (event: Event) => void;
  handleSendChat: (messageOverride?: string, opts?: unknown) => Promise<void>;
  handleAbortChat: () => Promise<void>;
  removeQueuedMessage: (id: string) => void;
  handleOpenSidebar: (content: string) => void;
  handleCloseSidebar: () => void;
  handleSplitRatioChange: (ratio: number) => void;
  exportLogs: (lines: string[], label: string) => void;
  handleLogsScroll: (event: Event) => void;
  handleCallDebugMethod: (method: string, params: string) => Promise<void>;
  patchSessionModel?: (sessionKey: string, model: string) => Promise<void>;
  patchConfigValue?: (path: Array<string | number>, value: unknown) => void;
  saveAndApplyConfig?: () => Promise<void>;
  requestUpdate?: () => void;
  availableModels?: Array<{ id: string; name: string; provider?: string }>;
  loadAvailableModels?: () => Promise<void>;
};
