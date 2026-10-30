import { html, nothing } from "lit";
import {
  ensureSecureMode,
  getSecureState,
  isSecureSessionKey,
  LAST_NORMAL_SESSION_STORAGE_KEY,
  LAST_SECURE_SESSION_STORAGE_KEY,
  planSecureLaneSwitch,
  readStoredKey,
  secureActive,
  writeStoredKey,
} from "./secure-mode";
import { isTabAvailable, isPluginHostSynced, pluginOwnerOfTab, pluginPageOfTab, pluginScopeOfTab } from "./plugin-host.js";
import { gatewayHttpBase, setGatewayHttpCredentials } from "./gateway-http-auth";

import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway";
import type { AppViewState } from "./app-view-state";
import { syncAuthRouteFlag } from "./lib/route-guards";
import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import {
  TAB_GROUPS,
  iconForTab,
  pathForTab,
  titleForTab,
  subtitleForTab,
  navLabelForTab,
  subViewsForHost,
  resolveSubView,
  type Tab,
} from "./navigation";
import { openAgentIdentityFile } from "./controllers/memory-agents";
import { isCloudVoiceActive, refreshVoiceProvidersState, VOICE_PROVIDER_EVENT } from "./controllers/voice-provider";
import { consumeDeepLink, pushEntityUrl } from "./app-settings";
import { renderTabLensLinks } from "./views/tab-lens";
import { renderHostSubtabs } from "./views/host-subtabs";
import { activeContentTab } from "./app-settings";
import { slugify, idFromSlug } from "./lib/slugs";
// Shared dedicated project-detail surface for /projects/:slug and
// /agency-operations/projects/:slug deep-links (side-effect: registers the
// <project-detail-page> custom element). Owned by a parallel workstream; the
// router only routes to it.
import "./projects/project-detail-page.js";
import { icons } from "./icons";
import type { UiSettings } from "./storage";
import type { ThemeMode } from "./theme";
import type { ThemeTransitionContext } from "./theme-transition";
import type {
  ConfigSnapshot,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
} from "./types";
import type { ChatQueueItem, CronFormState } from "./ui-types";
import { refreshChatAvatar } from "./app-chat";
import { renderChat } from "./views/chat";
import { loadSessionContext, saveSessionContext, type SessionContextSettings, type SessionContextProject } from "./views/chat-sessions";
import { renderEnhancedThreadsSidebar, initializeSidebarState } from "./views/threads-sidebar-enhanced";
import { loadSidebarState } from "./controllers/sidebar-categories";
import { renderEnhancedNavSidebar, initializeNavSidebarState } from "./views/nav-sidebar-enhanced";
import { renderSetupBanner } from "./components/setup-banner.js";
import { renderLaunchpad } from "./views/launchpad";
import { loadNavSidebarState, saveNavSidebarState } from "./controllers/nav-sidebar";
import { renderTerminalClock, loadClockState, isAlarmSounding } from "./components/terminal-clock";
// control-bar-clock: plugin clock sections + priority layout of the topbar.
import { renderClockSections } from "./components/clock-sections";
import { scheduleControlBarLayout } from "./components/control-bar";
import { pluginClockSections } from "./plugin-host.js";
import "./components/plan-badge";
import "./components/learn-missions-panel";
import "./components/learn-topbar-button";
import "./components/rv-call-dock";
import "./components/agent-overlay-layer";
import { markTouched as markLearnTouched } from "./controllers/learn-missions";
import {
  type DisciplineAlertState,
  initDisciplineAlerts,
  renderDisciplineAlerts,
} from "./components/discipline-alert";
import { renderSaveToProjectModal, setSaveModalUpdateCallback } from "./chat/save-to-project";
import { renderConfig } from "./views/config";
import { renderApiKeys } from "./views/api-keys";
import { renderChannels } from "./views/channels";
import { renderDebug } from "./views/debug";
import { renderInstances, type InstanceContextMenu } from "./views/instances";
import { renderDocs } from "./views/docs";
import {
  assignInstanceToProject,
  unassignInstanceFromProject,
} from "./controllers/instance-projects";
import { renderLogs } from "./views/logs";
import { renderNodes } from "./views/nodes";
import { renderSessions } from "./views/sessions";
// Every "hey X" wake word and voice button goes through enableLiveActionMode →
// a local voice call (default) or a Robovoice call (cloud voice) — docs/voice/LOCAL-DEFAULT.md.
import { renderExecApprovalPrompt } from "./views/exec-approval";
// Side-effect import: registers the <change-notion-db-host> custom element
// so the markup tag below mounts the global modal listener exactly once.
import "./views/change-notion-db-host";
// Same pattern: unified email composer modal listening for the
// `infinibot:open-email-composer` CustomEvent from any view.
import "./views/email-composer-host";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  renameDevice,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices";
import { renderSkills, renderSkillsBrowseModalGlobal } from "./views/skills";
import {
  mountSubagentDetailListener,
  renderSubagentDetailModal,
  isSubagentDetailOpen,
} from "./components/subagent-detail-modal";
import { mountAgentFocusModal } from "./components/agent-focus-modal";
import { renderAutonomyDashboard, autonomyStyles, injectAutonomyStyles, clearPrefireDraft } from "./views/autonomy";
import {
  lazyRenderStoryboard,
  lazyRenderAgentActivity,
  lazyRenderDiscipline,
  lazyAgencyDaily,
  lazyAgencyOperations,
  lazyAgencyTopology,
  lazyAgentsManagement,
  lazyAndroidOps,
  lazyApps,
  lazyBusiness,
  lazyBusinessHq,
  lazyCommandCeo,
  lazyCommandOps,
  lazyCanvasLibrary,
  lazyClients,
  lazyCommsHub,
  lazyDatabases,
  lazyDesign,
  lazyResearch,
  lazyDirectories,
  lazyFiles,
  lazyRepos,
  lazyFunnels,
  lazyBusinessHub,
  lazyInbox,
  lazyKanban,
  lazyKnowledgeGraph,
  lazyLeadDashboard,
  lazyLearn,
  lazyDailyReview,
  lazyLaunchPanel,
  lazyMcp,
  lazyMemory,
  lazyNotes,
  lazyIssues,
  lazyOpportunities,
  lazyDecisions,
  lazyRisks,
  lazyCommitments,
  lazyPeople,
  lazyPeopleNetwork,
  lazyNotionDatabases,
  lazyOversight,
  lazyProducts,
  lazyProductPortfolio,
  lazyProfilesManager,
  lazyPromptTemplates,
  lazyReports,
  lazyReviews,
  lazySchedule,
  lazyFocus,
  lazySetupView,
  lazyVaultDashboard,
  lazySites,
  lazyTerminals,
  lazyUsers,
  lazyAccessAdmin,
  loadWhiteboardPlugin,
  loadMonsoonStudioPlugin,
  lazyWorkflows,
  lazyWorkspace,
  loadContentIntel,
  loadMemoryAgents,
  loadWebchat,
  loadContentPages,
  loadCommunity,
  loadHardwareAnalysis,
  loadInficode,
  loadRobovoice,
  loadVoiceConsole,
  loadOmniclinic,
  loadInfinitrade,
  loadSolatrix,
  loadSolatrixIntel,
  loadPluginEntryPage,
  loadPartScan,
  loadOllamaMonitor,
  loadPluginsView,
  loadAgentMesh,
  mountLazyKanbanDeepLink,
} from "./lazy-views";
import { mountAgentsDrawerIntent } from "./lib/agents-drawer-intent";
// Plugin topbar controls (the Business & Agency plugin's agency selector, …).
import { renderTopbarSlots } from "./components/topbar-slots";
import { isBusinessAgencyTab } from "./business-agency-gate";
import { renderCoreHome } from "./views/core-home";
import { renderCredits } from "./views/credits";
import { renderAppearance } from "./views/appearance";
import {
  BRAND_DEFAULT_SUBTITLE,
  BRAND_DEFAULT_TITLE,
  openBrandingModal,
  renderBrandingModal,
} from "./views/branding-modal";
import { readCachedBranding, resolveBrandLogoUrl } from "./controllers/app-branding";
// Unified modal + card system (project / client / task / portfolio). One
// facade service (initModalService) hands the modals the live gateway client +
// re-render; the render functions are mounted once at the app root below.
import { initModalService } from "./components/modals/modal-service";
import { renderProjectDetailModal } from "./components/modals/project-detail-modal";
import { renderClientDetailModal } from "./components/modals/client-card-modal";
import { renderTaskDetailModal } from "./components/modals/task-detail-modal";
import { renderPortfolioModal } from "./components/modals/portfolio-view-modal";
import { t } from "./i18n";
import { renderMobile } from "./views/mobile";
import { renderVaultOnboarding, injectVaultOnboardingStyles } from "./views/vault-onboarding";
import type { InboxState, InboxView } from "./views/inbox";
import {
  renderReplyInbox,
  createReplyInboxState,
  type ReplyInboxState,
} from "./views/reply-inbox";
import {
  renderTemplateEditor,
  createTemplateEditorState,
  type TemplateEditorState,
} from "./views/template-editor";
import { renderFederationTab, initializeFederationState, loadFederation, applyPendingTerminalNode, type FederationViewState } from "./views/federation-integration";
import { createFederationState, loadFederationState } from "./controllers/federation";
import { renderFederationFileTransfer } from "./views/federation-file-transfer";
import {
  createFileTransferState,
  loadFileTransferData,
  sendFile as ftSendFile,
  pauseTransfer as ftPause,
  resumeTransfer as ftResume,
  cancelTransfer as ftCancel,
  togglePeerSelection as ftTogglePeer,
  setDragOver as ftSetDragOver,
  type FileTransferState,
} from "./controllers/file-transfer";
import { renderChartButton, renderSolanaChartOverlay, createSolanaChartState, type SolanaChartState } from "./views/solana-chart";
import { renderCanvasButton, renderCanvasOverlay, createCanvasOverlayState, type CanvasOverlayState } from "./views/canvas-overlay";
import "./components/terminal-background"; // WebGL matrix terminal background
import { renderTaskSidebar } from "./views/task-sidebar";
import { startWorkspacePolling } from "./controllers/workspace";
import { renderOnboarding, _expandedPlanFiles, type OnboardingHandlers } from "./views/onboarding";
import {
  createInitialOnboardingState,
  advancePhase,
  saveOnboardingFiles,
  saveOnboardingProgress,
  clearOnboardingProgress,
  type OnboardingState,
} from "./controllers/onboarding";
// masonry-grid (and its transitive pixi.js dependency) is deferred until the
// first /grid visit — wall windows that only show /activity, /dashboard, etc.
// never trigger this import, so pixi-vendor.js stays out of their heap.
// (No static import here; see the lazy trigger inside the grid render block.)
import "./components/agent-chat-sidebar";
import { renderAgentSidebarButton } from "./components/agent-chat-sidebar";
import { createMasonryGridState, addPanel, loadSessionsIntoPanels } from "./controllers/masonry-grid";
import type { KanbanViewProps } from "./views/kanban";
import {
  loadKanban,
  createProject as kanbanCreateProject,
  updateProject as kanbanUpdateProject,
  deleteProject as kanbanDeleteProject,
  createTask as kanbanCreateTask,
  updateTask as kanbanUpdateTask,
  deleteTask as kanbanDeleteTask,
} from "./controllers/kanban";
import * as focusCtl from "./controllers/focus";
import type { FocusState } from "./controllers/focus";
import { renderBrowserSetup } from "./views/browser";
import { renderSystemDatabasesCard } from "./views/system-databases-card";
import { loadSystemRoles } from "./controllers/databases";

let configSystemRolesLoaded = false;

import { renderAuthScreen, type AuthViewState } from "./views/auth";
import {
  clearSaasConnectIssue,
  getSaasConnectIssue,
  isSaasMode,
  onSaasConnectIssue,
  saasEverConnected,
  saasReauthenticate,
} from "./saas-clerk";
import { isCloudBuild } from "./cloud/cloud-env";
import { renderSelfHostOnly } from "./views/self-host-only";
import { renderSaasAccountMenu, renderSaasConnectScreen } from "./saas-auth-views";
import { renderSaasOnboardingGate } from "./saas-onboarding-gate";
import { getAccountsProbe, probeUserAccounts } from "./controllers/login-accounts";
import {
  accessEnabled,
  accessLogin,
  accessLogoutHttp,
  accessPageFilter,
  accessPreviewToken,
  allowedTabsForMe,
  clearSignupFromUrl,
  endAccessPreview,
  ensureAccessMe,
  getAccessMe,
  probeAccessStatus,
  resetAccessMe,
  signupTokenFromUrl,
} from "./access/access-session";
import { renderAccessSignup, renderAccessUserBar } from "./access/access-auth-view";
import { isUserSessionToken } from "./gateway";
import {
  evaluateFirstRun,
  getFirstRunStatus,
  isFirstRunActive,
  isFirstRunEvaluating,
} from "./controllers/first-run";
import { renderFirstRunChecklist, type FirstRunHost } from "./views/first-run-checklist";
import { markOnboardingAutoOpened, shouldAutoOpenOnboarding } from "./onboarding/profile";
import { renderProfileGate } from "./views/profile-gate";
import { isGateEnabled, isGatePassed, markGatePassed, setLastPicked } from "./profiles";
import {
  loadAutonomyStatus,
  pauseAutonomy,
  resumeAutonomy,
  approveTask,
  cancelTask,
  sendTestNotification,
  createAutonomyState,
  queueTask as queueAutonomyTask,
  importKanbanTaskToAutonomy,
  syncTaskToKanban,
  linkTaskToKanban,
  verifyAuditChain,
  savePrefireQuestions,
  startClosedLoop,
  generatePrefireForm,
  savePrefireFormAnswers,
  markPrefireReady,
  fetchTaskActivity,
  setPrefireRequired,
  getTelegramStatus,
  testTelegram,
  reconnectTelegram,
} from "./controllers/autonomy";
import { loadApiKeys, upsertApiKey, deleteApiKey, testApiKey, createInitialApiKeysState } from "./controllers/api-keys";
import { renderActivityPanel, renderActivityPanelButton } from "./views/activity-panel";
import { renderNotificationOverlay, renderNotificationBell, injectNotificationStyles } from "./views/notifications";
// Side-effect import: registers the <live-action-toast> custom element so
// the global mount near the end of renderApp() can use it. Cheap; the
// component is idle until UIControlBus emits action lifecycle events.
import "./components/live-action-toast";
// Side-effect import: registers <plan-limit-modal> (hosted plan-cap upgrade
// dialog). Idle until a `plan.limit` gateway event arrives.
import "./components/plan-limit-modal";
import { appAssetUrl } from "./app-base";
// Side-effect import: registers <approvals-inbox> — topbar badge + panel for
// the unified approval registry (same requests the operator gets on Telegram).
import "./components/approvals-inbox";
// Side-effect import: registers <proactive-overlay-host>, which in turn
// pulls in <proactive-presenter>, <walkthrough-overlay>, and the infinite
// canvas walkthrough. Without this, the host tag silently renders nothing
// and proactive media falls back to the legacy toast.
import "./components/proactive-overlay-host";
// Side-effect import: registers <chat-panel-host>, the global host for
// agent-invokable chat panel modals (show_panel tool → chat.panel.show).
import "./chat-panels/chat-panel-host";
// Side-effect import: registers <kv-connect-approval>, the global "KinglyVault
// wants to connect" prompt (kinglyvault-relay plugin, one-click pairing).
import "./components/kv-connect-approval";
// Side-effect import: registers <agent-chat-modal>, the universal agent chat
// modal. Mounted globally so it's reachable from any route.
import "./components/agent-chat-modal";
// Phone "Back to chat" pill for chat-follows-navigation (./chat/chat-follow-nav.ts).
import "./components/chat-follow-pill";
import { renderCoderBackendPill } from "./components/coder-backend-pill.js";
import { renderDevicesButton, renderFederationTabPills } from "./components/federation-tab-pills.js";
import { renderChatControls, renderTab, renderLanguageToggle, renderRestartButton, renderNewWindowButton } from "./app-render.helpers";
import { loadChannels } from "./controllers/channels";
import { loadPresence } from "./controllers/presence";
import { deleteSession, loadSessions, patchSession } from "./controllers/sessions";
import {
  deleteLearnedSkill,
  installSkill,
  authorSkill,
  deleteSkill,
  loadLearnedSkills,
  loadSkills,
  runLearnedSelfImprove,
  saveSkillApiKey,
  updateSkillEdit,
  updateSkillEnabled,
  loadSkillDrafts,
  acceptSkillDraft,
  rejectSkillDraft,
  loadSkillHealingProposals,
  applySkillHealing,
  rejectSkillHealing,
  loadSkillActivity,
  loadSkillSystemConfig,
  saveSkillSystemConfig,
  loadSkillQueueStats,
  getHealingProposalContent,
  getDraftFullContent,
  type SkillMessage,
} from "./controllers/skills";
import { loadNodes } from "./controllers/nodes";
import { loadChatHistory, sendVideoFrame, switchChatSession } from "./controllers/chat";
import {
  applyConfig,
  loadConfig,
  runUpdate,
  saveConfig,
  updateConfigFormValue,
  removeConfigFormValue,
} from "./controllers/config";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals";
import { loadDebug, callDebugMethod } from "./controllers/debug";
import { loadLogs } from "./controllers/logs";

const AVATAR_DATA_RE = /^data:/i;
const AVATAR_HTTP_RE = /^https?:\/\//i;

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId =
    parsed?.agentId ??
    state.agentsList?.defaultId ??
    "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) return undefined;
  if (AVATAR_DATA_RE.test(candidate) || AVATAR_HTTP_RE.test(candidate)) return candidate;
  return identity?.avatarUrl;
}

let _wakeInited = false;
let _notesFsListenerInited = false;
// Auth state for login screen
let _authPassword = "";
let _authShowPassword = false;
let _authShowAdvanced = false;
let _authConnecting = false;
let _authError: string | null = null;
// Login mode (username + password) is only the default when the gateway
// reports user accounts (GET /api/users/login → accountsExist). A fresh
// single-user install sees just the gateway-password field.
let _authLoginMode = false;
// True once the user flips the mode by hand — the probe stops overriding it.
let _authLoginModeUserSet = false;
let _authUsername = "";
// Workspace-user login (auth.multiUser): a 2FA code is asked for only after
// the gateway answers totp_required.
let _authCodeRequired = false;
let _authCode = "";
// Pending profile id after a successful /api/users/login — auto-switched on connect.
let _pendingLoginProfileId: string | null = null;
let _pendingLoginUsername: string | null = null;

// Solana chart state
let _solanaChartState: SolanaChartState = createSolanaChartState();

// Canvas overlay state
let _canvasOverlayState: CanvasOverlayState = createCanvasOverlayState();

// Onboarding state (module-level for persistence across renders)
let _onboardingState: OnboardingState | null = null;
// Plan-approval transient state (the user just clicked Approve & we're
// writing files; or the last write failed and the error must be shown).
let _onboardingPlanSaving = false;
let _onboardingPlanSaveError: string | null = null;

function getOnboardingHandlers(state: AppViewState): OnboardingHandlers {
  const updateAndSave = (updates: Partial<OnboardingState>) => {
    if (!_onboardingState) return;
    _onboardingState = { ..._onboardingState, ...updates };
    saveOnboardingProgress(_onboardingState);
    state.requestUpdate?.();
  };

  return {
    onBegin: () => {
      updateAndSave({ phase: "question" });
    },
    onSelectBelief: (belief: string) => {
      updateAndSave({ belief: belief as any, phase: "first-words" });
    },
    onContinue: () => {
      if (!_onboardingState) return;
      _onboardingState = advancePhase(_onboardingState);
      saveOnboardingProgress(_onboardingState);
      state.requestUpdate?.();
    },
    onUpdateField: (field: string, value: string) => {
      updateAndSave({ [field]: value });
    },
    onSubmitIntro: () => {
      updateAndSave({ phase: "naming" });
    },
    onUpdateName: (name: string) => {
      updateAndSave({ agentName: name });
    },
    onSubmitName: () => {
      updateAndSave({ phase: "acknowledgment" });
    },
    onAcceptBoundaries: () => {
      updateAndSave({ boundariesAccepted: true, phase: "first-memory" });
    },
    onBoundaryQuestions: () => {
      // Could open a dialog or skip to continue
      updateAndSave({ boundariesAccepted: true, phase: "first-memory" });
    },
    onSaveMemory: async () => {
      updateAndSave({ phase: "technical" });
    },
    onSelectChannel: (channel: string) => {
      updateAndSave({ selectedChannel: channel });
    },
    onApiKeyChange: (key: string) => {
      updateAndSave({ apiKey: key });
    },
    onTechnicalContinue: () => {
      // Move to the visible plan step instead of jumping straight to
      // "complete". The user explicitly approves the workspace plan
      // before any files are written to disk.
      updateAndSave({ phase: "plan" });
    },
    onApprovePlan: async () => {
      if (!_onboardingState) return;
      _onboardingPlanSaving = true;
      _onboardingPlanSaveError = null;
      state.requestUpdate?.();

      const workspacePath = state.hello?.config?.workspace ||
        (state.hello as any)?.agentWorkspace ||
        "~/infinibot";

      const result = await saveOnboardingFiles(_onboardingState, workspacePath, state.client);
      _onboardingPlanSaving = false;
      if (result.success) {
        _onboardingPlanSaveError = null;
        updateAndSave({
          planApproved: true,
          planWrittenAt: new Date().toISOString(),
          phase: "complete",
        });
      } else {
        _onboardingPlanSaveError = result.error ?? "Unknown error while writing files.";
        state.requestUpdate?.();
      }
    },
    onEditPlan: () => {
      // Send the user back to the technical step so they can adjust
      // channel / API key. They can keep clicking back through earlier
      // phases via the standard nav.
      _onboardingPlanSaveError = null;
      updateAndSave({ phase: "technical" });
    },
    onTogglePlanFile: (path: string) => {
      if (_expandedPlanFiles.has(path)) _expandedPlanFiles.delete(path);
      else _expandedPlanFiles.add(path);
      state.requestUpdate?.();
    },
    get planSaving() {
      return _onboardingPlanSaving;
    },
    get planSaveError() {
      return _onboardingPlanSaveError;
    },
    onStart: () => {
      // The plan-approve step already wrote the files. `Start` is now
      // purely the dismiss-to-app transition.
      clearOnboardingProgress();
      _onboardingState = null;
      const url = new URL(window.location.href);
      url.searchParams.delete("onboarding");
      window.history.replaceState({}, "", url.toString());
      window.location.reload();
    },
  };
}

/**
 * Every voice trigger — wake words ("hey infinibot", "hey <agent>", "hey
 * <tab>", compound, window, assistant name), the project "Quick voice call"
 * and the topbar Voice pill — lands here:
 *
 *   local voice (default)  start a local voice call (Voice page shows it
 *                          live); "hey <tab>" (stay) keeps you on that tab
 *   cloud voice, linked    start a Robovoice call, same rules
 *   cloud voice, unlinked  open the Voice page, which is the Connect state
 *   topbar                 just open the Voice page
 */
function enableLiveActionMode(
  state: AppViewState,
  source: string,
  opts: { agentId?: string; sessionKey?: string; stay?: boolean } = {},
): void {
  if (source !== "topbar") playWakeChime();
  void routeVoiceToRobovoice(state, source, opts);
}
async function routeVoiceToRobovoice(
  state: AppViewState,
  source: string,
  opts: { agentId?: string; sessionKey?: string; stay?: boolean },
): Promise<void> {
  if (source === "topbar") {
    state.setTab("voice");
    return;
  }
  const { requestVoiceCall, VOICE_INTENT_EVENT } = await import("./views/voice-robovoice/console-state.js");
  const { startRobovoiceCallFromIntent, voiceCallEngine } = await import("./views/voice-robovoice/call-store.js");
  if (opts.stay && (voiceCallEngine() === "local" || isTabAvailable("robovoice"))) {
    // A chat surface's call is bound to THAT chat session (turns + transcript land there).
    const r = await startRobovoiceCallFromIntent(opts.agentId, opts.sessionKey);
    if (r === "calling" || r === "in-call") {
      state.requestUpdate?.();
      return;
    }
  }
  requestVoiceCall({ agentId: opts.agentId, sessionKey: opts.sessionKey, source });
  if (state.tab !== "voice") state.setTab("voice");
  try {
    window.dispatchEvent(new CustomEvent(VOICE_INTENT_EVENT));
  } catch { /* noop */ }
}
function toggleLiveActionMode(state: AppViewState): void {
  enableLiveActionMode(state, "topbar");
}

/** Load the voice engine choice (local default / cloud Robovoice) once; re-render when it changes. */
let _voiceProviderListener = false;
function ensureVoiceProviderState(state: AppViewState): void {
  if (state.client) void refreshVoiceProvidersState(state.client);
  if (_voiceProviderListener || typeof window === "undefined") return;
  _voiceProviderListener = true;
  window.addEventListener(VOICE_PROVIDER_EVENT, () => state.requestUpdate?.());
}

/** Voice call phase (local or Robovoice) for the topbar pill + the "call live" return pill. */
let _rvCallPhase = "idle";
let _rvCallListener: ((e: Event) => void) | null = null;
function ensureRobovoiceCallListener(state: AppViewState): void {
  if (_rvCallListener || typeof window === "undefined") return;
  _rvCallListener = (e: Event) => {
    const phase = (e as CustomEvent<{ phase?: string }>).detail?.phase ?? "idle";
    if (phase !== _rvCallPhase) {
      _rvCallPhase = phase;
      state.requestUpdate?.();
    }
  };
  window.addEventListener("infinibot:robovoice-call", _rvCallListener);
}
function robovoiceCallLive(): boolean {
  return _rvCallPhase === "starting" || _rvCallPhase === "connecting" || _rvCallPhase === "active" || _rvCallPhase === "ending";
}

/**
 * Audible "I heard you" cue when a wake word starts a Robovoice call, so
 * the user gets immediate feedback while the call is being set up.
 *
 * Caches the Audio element across triggers (cheap; the file is ~10kB).
 * Silently no-ops when the browser blocks autoplay before the first user
 * gesture — wake-word detection itself is gated by an explicit mic-grant
 * gesture, so by the time this fires we're past that.
 */
let _wakeChimeAudio: HTMLAudioElement | null = null;
function playWakeChime(): void {
  if (typeof Audio === "undefined") return;
  try {
    if (!_wakeChimeAudio) {
      _wakeChimeAudio = new Audio(appAssetUrl("./sfx-start.wav"));
      _wakeChimeAudio.volume = 0.6;
      // Tag so the AI-speech ducking sweep doesn't lower our own
      // wake-confirmation chime. Lazy-imported to keep audio-ducking
      // off the initial bundle's eager path.
      void import("./audio-ducking.js").then(({ markAsAIAudio }) => {
        if (_wakeChimeAudio) markAsAIAudio(_wakeChimeAudio, "wake-chime");
      });
    }
    // Reset to start so rapid re-triggers don't get swallowed by an
    // already-playing audio element.
    _wakeChimeAudio.currentTime = 0;
    void _wakeChimeAudio.play().catch(() => { /* autoplay blocked — ignore */ });
  } catch { /* noop */ }
}

let _liveActionStylesInjected = false;
function injectLiveActionStyles(): void {
  if (_liveActionStylesInjected || typeof document === "undefined") return;
  _liveActionStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
/* Live Action toast (action-fired feedback). Stays out of the sidebar's
   way by sitting on the LEFT edge of the viewport while the sidebar
   itself is on the right. */
.live-action-toast {
  position: fixed;
  left: 20px;
  top: 20px;
  z-index: 9100;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--g-primary, #caa45a) 14%, rgba(0,0,0,0.7));
  border: 1px solid var(--g-primary, #caa45a);
  color: var(--g-fg, #f5f5f4);
  font: 600 11px/1.2 'JetBrains Mono', 'Fira Code', monospace;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  max-width: 60vw;
  box-shadow: 0 12px 32px rgba(0,0,0,0.4);
  animation: live-action-toast-in 220ms ease-out both;
}
.live-action-toast .lat-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--g-primary, #caa45a);
  box-shadow: 0 0 8px currentColor;
  animation: live-action-toast-pulse 1.2s ease-in-out infinite;
}
.live-action-toast .lat-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50ch;
  text-transform: none;
  letter-spacing: 0.02em;
}
.live-action-toast.is-error {
  background: color-mix(in srgb, #ff4444 18%, rgba(0,0,0,0.75));
  border-color: #ff4444;
}
.live-action-toast.is-success .lat-dot { background: #00ff88; }
.live-action-toast.is-paused {
  background: color-mix(in srgb, #fbbf24 18%, rgba(0,0,0,0.78));
  border-color: #fbbf24;
  color: #fef3c7;
}
.live-action-toast.is-paused .lat-dot {
  background: #fbbf24;
  animation: none;
  box-shadow: 0 0 10px rgba(251, 191, 36, 0.6);
}
.live-action-toast .lat-pause-btn {
  flex-shrink: 0;
  margin-left: 8px;
  padding: 3px 10px;
  font: inherit;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: inherit;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid currentColor;
  border-radius: 99px;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.1s ease;
}
.live-action-toast .lat-pause-btn:hover {
  background: rgba(0, 0, 0, 0.55);
  transform: translateY(-1px);
}
.live-action-toast .lat-pause-btn:active { transform: translateY(0); }
.live-action-toast.is-paused .lat-pause-btn {
  background: #fbbf24;
  color: #2a1a02;
  border-color: #fbbf24;
}
@keyframes live-action-toast-in {
  from { transform: translateY(-8px); opacity: 0; }
  to   { transform: translateY(0);     opacity: 1; }
}
@keyframes live-action-toast-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.55; transform: scale(0.85); }
}
`;
  document.head.appendChild(style);
}

function renderDashboardOrFirstRun(state: AppViewState) {
  const rerender = () => state.requestUpdate?.();
  if (!getFirstRunStatus()) void evaluateFirstRun(state.client!, rerender);
  if (isFirstRunActive()) {
    // A brand-new install (web or desktop first run) opens guided onboarding
    // once; the checklist stays as the home screen afterwards.
    if (shouldAutoOpenOnboarding()) {
      markOnboardingAutoOpened();
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("infinibot:setup-section", { detail: { section: "wizard" } }));
        state.setTab?.("setup" as never);
      }, 0);
    }
    // Pass the app state itself: the Welcome CTA opens a track on state.learn.
    return renderFirstRunChecklist(state as unknown as FirstRunHost);
  }
  // One-time check still running (first load only): don't flash Business HQ.
  if (!getFirstRunStatus() && isFirstRunEvaluating()) return nothing;
  // Business HQ belongs to the Business & Agency plugin; with it off (or not
  // yet synced) home is the generic core overview — no business content.
  if (!isTabAvailable("business-hq")) return renderCoreHome(state);
  return baScope(lazyBusinessHq((m) => m.renderBusinessHQ(state, state.client!), rerender));
}

/** Business & Agency plugin pages render inside the plugin's scope container. */
function baScope(page: unknown) {
  return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("business-hq") ?? "business-agency"}>${page}</div>`;
}

export function renderApp(state: AppViewState) {
  // Inject notification CSS (once)
  injectNotificationStyles();

  // Inject autonomy dashboard CSS (once)
  injectAutonomyStyles();

  // Robovoice call phase (topbar pill + "call · return") and the live-action
  // toast styles. Idempotent.
  ensureRobovoiceCallListener(state);
  ensureVoiceProviderState(state);
  injectLiveActionStyles();

  // Route-aware popup suppression: flag <body> when on an auth surface
  // (onboarding / auth screen / unpassed profile gate) so the guard stylesheet
  // hides every other overlay and imperative openers can early-return.
  syncAuthRouteFlag(state);

  // ─────────────────────────────────────────────────────────────
  // SOVEREIGN ONBOARDING
  // If in onboarding mode, render the first meeting flow
  // ─────────────────────────────────────────────────────────────
  if (state.onboarding) {
    // Initialize onboarding state if not exists
    if (!_onboardingState) {
      _onboardingState = createInitialOnboardingState();
    }
    
    const handlers = getOnboardingHandlers(state);
    return renderOnboarding(_onboardingState, handlers);
  }

  // Build auth state for potential auth screen
  const needsAuth = !state.connected && !state.onboarding;
  
  // Pre-populate auth password from saved settings (for auto-reconnect)
  if (needsAuth && !_authPassword && state.settings.password) {
    _authPassword = state.settings.password;
    // Auto-connect if we have a saved password and not already connecting
    if (!_authConnecting && state.connect && state.setPassword) {
      _authConnecting = true;
      state.setPassword(_authPassword);
      setTimeout(() => {
        // The first connect (handleConnected) may already have completed the
        // handshake by now — on a local gateway hello lands in <100ms and the
        // connected render resets these guards. Reconnecting then would tear
        // down the live client and loop forever (connect → hello → stale
        // timer → connect …), which is what broke headless verification.
        if (state.connected) return;
        state.connect?.();
        setTimeout(() => {
          _authConnecting = false;
          state.requestUpdate?.();
        }, 3000);
      }, 100);
    }
  }
  
  if (needsAuth && !isSaasMode()) {
    probeUserAccounts(state.settings.gatewayUrl || "", () => {
      if (!_authLoginModeUserSet) _authLoginMode = getAccountsProbe() === "exist";
      state.requestUpdate?.();
    });
    probeAccessStatus(state.settings.gatewayUrl || "", () => state.requestUpdate?.());
  }
  // Workspace accounts on → the "Sign in as a user account" mode is always offered.
  const accountsProbe = accessEnabled() ? "exist" : getAccountsProbe();

  // Multi-user signup link (?signup=ibinv_…): the invitee creates their account
  // here, before any gateway connection exists.
  const signupToken = isSaasMode() ? null : signupTokenFromUrl();
  if (signupToken) {
    return renderAccessSignup(signupToken, {
      gatewayUrl: state.settings.gatewayUrl || "",
      requestUpdate: () => state.requestUpdate?.(),
      onSignedUp: (token) => {
        state.applySettings({ ...state.settings, token, password: "" });
        state.setPassword?.("");
        resetAccessMe();
        state.requestUpdate?.();
        setTimeout(() => state.connect?.(), 50);
      },
      onCancel: () => {
        clearSignupFromUrl();
        _authLoginMode = true;
        _authLoginModeUserSet = true;
        state.requestUpdate?.();
      },
    });
  }

  const authState: AuthViewState = {
    settings: state.settings,
    password: _authPassword,
    showPassword: _authShowPassword,
    showAdvanced: _authShowAdvanced,
    isConnecting: _authConnecting,
    isReconnecting: state.reconnecting ?? false,
    reconnectAttempt: state.reconnectAttempt ?? 0,
    error: (state.reconnecting ? null : _authError) || state.lastError || null,
    applySettings: (s) => state.applySettings(s),
    onConnect: async () => {
      if (!_authPassword.trim()) {
        _authError = _authLoginMode ? "Password required" : "Gateway password required";
        state.requestUpdate?.();
        return;
      }
      if (_authLoginMode && !_authUsername.trim()) {
        _authError = "Username required";
        state.requestUpdate?.();
        return;
      }

      _authConnecting = true;
      _authError = null;
      state.requestUpdate?.();

      let passwordToUse = _authPassword.trim();

      // ── Workspace-user login (auth.multiUser): username + password (+ 2FA)
      // ── → an `ibus_` session token used as the connect token. Never the
      // ── gateway password, never the owner's device token.
      if (_authLoginMode && accessEnabled()) {
        const r = await accessLogin(
          state.settings.gatewayUrl || "",
          _authUsername.trim(),
          _authPassword,
          _authCodeRequired ? _authCode.trim() : undefined,
        );
        _authConnecting = false;
        if (!r.ok) {
          _authError = r.error;
          if (r.needsCode) _authCodeRequired = true;
          state.requestUpdate?.();
          return;
        }
        _authCodeRequired = false;
        _authCode = "";
        state.applySettings({ ...state.settings, token: r.token, password: "" });
        state.setPassword?.("");
        resetAccessMe();
        state.requestUpdate?.();
        setTimeout(() => state.connect?.(), 50);
        return;
      }

      // ── User-account login: translate username + user-password into
      // ── the gateway password via the public /api/users/login endpoint.
      if (_authLoginMode) {
        try {
          // Relative when the page is served by the gateway it logs into.
          setGatewayHttpCredentials({ gatewayUrl: state.settings.gatewayUrl || undefined });
          const base = gatewayHttpBase();
          const res = await fetch(`${base}/api/users/login`, {
            credentials: "include",
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              login: _authUsername.trim(),
              password: _authPassword,
            }),
          });
          if (!res.ok) {
            _authError =
              res.status === 401
                ? "Invalid username or password"
                : res.status === 429
                  ? "Too many attempts — try again in a few minutes"
                  : `Login failed (${res.status})`;
            _authConnecting = false;
            state.requestUpdate?.();
            return;
          }
          const data = (await res.json()) as { gatewayPassword?: string; profileId?: string; username?: string };
          // The gateway no longer echoes its password back: a successful login
          // means the password the user typed IS the gateway password. (Older
          // gateways still send gatewayPassword — accept it if present.)
          passwordToUse = data.gatewayPassword || _authPassword;
          // Store profile id so we auto-switch after WS connect.
          if (data.profileId) {
            _pendingLoginProfileId = data.profileId;
            _pendingLoginUsername = data.username ?? _authUsername.trim();
          }
        } catch (err) {
          _authError = err instanceof Error ? err.message : String(err);
          _authConnecting = false;
          state.requestUpdate?.();
          return;
        }
      }

      // Persist the secret as BOTH token and password.
      //
      // This used to write only `token`, which worked while the gateway ran in
      // token mode but locked the operator out the moment `gateway.auth.mode`
      // was switched to `password`: the connect frame carried the secret as a
      // token and an empty password, and the gateway rejected it with
      // `password_missing`. (Line ~922 already read `settings.password` to
      // pre-fill this form on reconnect — a value nothing ever wrote.)
      //
      // The client cannot know the server's auth mode before connecting, and
      // `sendConnect` already sends `{ token, password }` together, letting the
      // gateway pick whichever its mode requires. So storing the typed secret
      // in both fields is what actually makes one login box work against
      // either mode.
      state.applySettings({
        ...state.settings,
        token: passwordToUse,
        password: passwordToUse,
      });
      // Also set the runtime password state (used by gateway client)
      state.setPassword?.(passwordToUse);

      // Wait a tick for settings to save, then connect
      setTimeout(() => {
        state.connect?.();
        // Reset connecting state after a delay (connection will update state.connected)
        setTimeout(() => {
          _authConnecting = false;
          if (!state.connected) {
            _authError = state.lastError || "Connection failed";
          }
          state.requestUpdate?.();
        }, 3000);
      }, 100);
    },
    onPasswordChange: (password) => {
      _authPassword = password;
      _authError = null;
      state.requestUpdate?.();
    },
    onTogglePassword: () => {
      _authShowPassword = !_authShowPassword;
      state.requestUpdate?.();
    },
    onToggleAdvanced: () => {
      _authShowAdvanced = !_authShowAdvanced;
      state.requestUpdate?.();
    },
    onGatewayUrlChange: (url) => {
      state.applySettings({
        ...state.settings,
        gatewayUrl: url,
      });
    },
    loginMode: _authLoginMode && accountsProbe !== "none",
    username: _authUsername,
    // No user accounts → gateway password only; hide the mode toggle.
    onToggleLoginMode: accountsProbe === "none" ? undefined : () => {
      _authLoginModeUserSet = true;
      _authLoginMode = !_authLoginMode;
      _authError = null;
      // Clear the password when switching modes — gateway password and
      // user password aren't interchangeable, so leaving the previous
      // value sitting in the field would cause a confusing 401.
      _authPassword = "";
      state.requestUpdate?.();
    },
    onUsernameChange: (username) => {
      _authUsername = username;
      _authError = null;
      state.requestUpdate?.();
    },
    codeRequired: _authCodeRequired,
    code: _authCode,
    onCodeChange: (code) => {
      _authCode = code.replace(/\D/g, "").slice(0, 6);
      _authError = null;
      state.requestUpdate?.();
    },
  };

  // If not connected and not onboarding, show auth screen.
  if (needsAuth) {
    // SaaS mode: Clerk is the ONLY gate (already enforced before the app
    // mounted). Never render the local username/password login. Auto-connect
    // once using the Clerk session token, and wipe any stale gateway
    // password/token so a new Clerk identity can never reconnect as a previous
    // user (that was the cross-tenant data leak).
    if (isSaasMode()) {
      const s = state as unknown as { _saasConnectTriggered?: boolean };
      if (!s._saasConnectTriggered) {
        s._saasConnectTriggered = true;
        try {
          const sett = state.settings as { password?: string; token?: string };
          if (sett.password || sett.token) {
            state.applySettings?.({ ...state.settings, password: "", token: "" } as typeof state.settings);
          }
        } catch {
          /* ignore */
        }
        queueMicrotask(() => state.connect?.());
        onSaasConnectIssue(() => state.requestUpdate?.());
      }
      // A session refused twice in a row (the second try already used a
      // freshly minted token) won't fix itself: stop retrying and say so,
      // instead of spinning on "Connecting…" forever.
      const issue = getSaasConnectIssue();
      const refused = Boolean(issue && issue.count >= 2);
      const halt = s as { _saasHaltedClient?: unknown };
      if (refused && state.client && halt._saasHaltedClient !== state.client) {
        halt._saasHaltedClient = state.client;
        state.client.stop();
      }
      // Hosted cloud: a drop after the app has been usable keeps the shell on
      // screen. The workspace loader (cloud/workspace-loader.ts) reports the
      // reconnect in a compact bar, and takes the full screen if it lasts.
      const keepShell = isCloudBuild() && !refused && saasEverConnected();
      if (!keepShell) return renderSaasConnectScreen({
        phase: refused
          ? issue!.kind === "no-session"
            ? "no-session"
            : "rejected"
          : state.reconnectAttempt > 0
            ? "reconnecting"
            : "connecting",
        attempt: state.reconnectAttempt,
        detail: refused ? issue!.message : state.lastError,
        onRetry: () => {
          clearSaasConnectIssue();
          halt._saasHaltedClient = undefined;
          state.connect?.();
        },
        onReauth: () => void saasReauthenticate(),
      });
    }
    if (!isSaasMode()) return renderAuthScreen(authState);
  }

  // Multi-user workspaces: learn who this connection is (owner vs workspace
  // user) and keep workspace users on pages their access allows.
  if (state.client) {
    ensureAccessMe(state.client, () => state.requestUpdate?.());
    const allowedTabs = allowedTabsForMe();
    if (allowedTabs && !allowedTabs.has(state.tab)) {
      const next = (["projects", "notes", "reports", "chat", "access"] as const).find((t) => allowedTabs.has(t)) ?? "access";
      queueMicrotask(() => state.setTab(next));
    }
  }

  // Reset auth state when connected
  _authPassword = "";
  _authError = null;
  _authConnecting = false;

  // Auto-switch to the profile from a user-account login, then reload so
  // every store re-resolves under the correct per-user data namespace.
  if (_pendingLoginProfileId && state.client) {
    const profileId = _pendingLoginProfileId;
    const username = _pendingLoginUsername;
    _pendingLoginProfileId = null;
    _pendingLoginUsername = null;
    void state.client
      .call("profiles.switch", { id: profileId })
      .then(() => {
        markGatePassed();
        setLastPicked(profileId);
        // Store the logged-in username so the logout button can show it.
        try { sessionStorage.setItem("infinibot.login.username", username ?? ""); } catch { /* ignore */ }
        location.reload();
      })
      .catch(() => {
        // If switch fails (e.g. profile not on server yet), skip to gate.
        state.requestUpdate?.();
      });
    return html`<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#07090f;color:#a0a8c0;font:600 14px/1 system-ui">Loading workspace…</div>`;
  }

  // Profile gate: shown at app start when the multi-user feature is
  // enabled (opt-in; off by default → existing single-profile installs
  // see no change) and the user hasn't picked a profile this session.
  // Picking re-points the data layer and reloads; "Continue" dismisses.
  // Workspace users (auth.multiUser) never pick an owner profile.
  const workspaceUserSession =
    isUserSessionToken(state.settings.token) || accessPreviewToken() !== null;
  if (isGateEnabled() && !isGatePassed() && !workspaceUserSession) {
    return renderProfileGate({
      client: state.client,
      requestUpdate: () => state.requestUpdate?.(),
    });
  }

  // SaaS: a new member's workspace is unconfigured until they finish the
  // quickstart (BYOK keys, assistant identity, optional voice). No-op locally.
  const saasOnboarding = renderSaasOnboardingGate(state);
  if (saasOnboarding) {
    // A member mid-quickstart can still see who they are and sign out.
    return html`${saasOnboarding}${renderSaasAccountMenu({
      client: state.client,
      requestUpdate: () => state.requestUpdate?.(),
      variant: "floating",
    })}`;
  }

  // Expose gateway client for save-to-project modal and set re-render callback
  if (state.client) (window as any).__infinibotGatewayClient = state.client;
  setSaveModalUpdateCallback(() => state.requestUpdate?.());

  // Initialize wake-word dispatchers (once per session). Every "hey X"
  // path now routes into Live Action Mode — the old slide-out voice
  // panel was removed when we unified to a single voice surface.
  if (!_wakeInited) {
    _wakeInited = true;

    // Register the notes-fullscreen-change listener once (one-shot
    // module-level guard so re-renders don't accumulate listeners).
    if (!_notesFsListenerInited) {
      _notesFsListenerInited = true;
      window.addEventListener("notes-fullscreen-change", (e: Event) => {
        const { fullscreen } = (e as CustomEvent).detail;
        (state as any).notesFullscreen = fullscreen;
        state.requestUpdate?.();
      });
    }

    // Register the agent-wake dispatcher: "hey <agent name>" starts a
    // Robovoice call with that agent (or opens Connect Robovoice).
    void import("./controllers/agent-wake.js").then(({ setAgentWakeOpenHandler }) => {
      setAgentWakeOpenHandler((agent) => {
        console.log(`[agent-wake] "hey ${agent?.name ?? agent?.id ?? "?"}" → live action`);
        enableLiveActionMode(state, "agent-wake", { agentId: agent?.id });
      });
    });

    // Register the tab-wake dispatcher: "hey <tab title>" navigates to
    // that tab and starts a Robovoice call that keeps running there.
    void import("./controllers/tab-wake.js").then(({ setTabWakeSwitchHandler, syncTabWakeWords }) => {
      setTabWakeSwitchHandler((tab) => {
        try {
          state.setTab(tab);
        } catch (err) {
          console.error("[tab-wake] setTab failed:", err);
        }
        enableLiveActionMode(state, "tab-wake", { stay: true });
      });
      syncTabWakeWords();
    });

    // Compound wake-words: user-defined phrases combining a target
    // (window codename / assistant name / agent id) with an action
    // (switch_tab / open_voice / ui_dispatch). The "open voice" action
    // now engages Live Action Mode instead of the removed voice panel.
    void import("./controllers/compound-wake.js").then(({ bindCompoundWakeHandlers, syncCompoundWake }) => {
      bindCompoundWakeHandlers({
        switchTab: (tab: string) => {
          try { state.setTab(tab as Parameters<typeof state.setTab>[0]); } catch (err) { console.error("[compound-wake] setTab failed:", err); }
        },
        openVoice: () => {
          enableLiveActionMode(state, "compound-wake");
        },
        uiDispatch: (view, op, args) => {
          // Dispatch via the in-browser UIControlBus so the action lands
          // in the same view-controller path that ui_control uses.
          void import("./control-bus.js").then(({ UIControlBus }) => {
            void UIControlBus.dispatchTo(view, { type: op, ...(args ?? {}) } as never);
          });
        },
        getAssistantName: () => state.assistantName ?? null,
      });
      syncCompoundWake();
    });

    // Window-name wake — "hey <self-codename>" enters Live Action Mode
    // on THIS window. The wake-coordinator routes codenamed phrases
    // across tabs via BroadcastChannel; this handler flips local state.
    void import("./controllers/window-wake.js").then(({ bindWindowWakeHandler }) => {
      bindWindowWakeHandler((codename) => {
        console.log(`[window-wake] "hey ${codename}" → live action`);
        enableLiveActionMode(state, "window-wake");
      });
    });

    // Live-action wake — FIXED always-on phrases ("live action", "hey
    // infinibot") that enter Live Action Mode directly, independent of
    // tab/agent/codename. Without this the only triggers were data-derived
    // ("hey <tab>" / "hey <agent>"), so the phrase a user naturally says to
    // go live matched nothing and "nothing happened". Reuses the exact same
    // enableLiveActionMode action as the manual Live button.
    void import("./controllers/live-action-wake.js").then(({ bindLiveActionWakeHandler }) => {
      bindLiveActionWakeHandler(() => {
        enableLiveActionMode(state, "live-action-wake");
      });
    });

    // Assistant-name wake — "hey <assistant name>" (e.g. "hey Tab") enters
    // Live Action Mode. This was the missing trigger: tab/agent/codename
    // all had wake controllers, but the bare assistant name — the single
    // most natural thing a user says to go live — matched nothing. Bind the
    // SAME action as the manual Live button; the name is fed in below via
    // the memoized assistant-name reconcile so it tracks identity changes.
    void import("./controllers/assistant-wake.js").then(
      ({ bindAssistantWakeHandler, setAssistantWakeName }) => {
        bindAssistantWakeHandler(() => {
          enableLiveActionMode(state, "assistant-wake");
        });
        setAssistantWakeName(state.assistantName);
      },
    );

    // Project quick-voice-call — the project page's "🎙 Quick voice call"
    // button dispatches infinibot:project-voice-call{projectId,projectName}.
    // We scope the session to that project (via session context) and start
    // a Robovoice call, so the operator can voice-dump real-world changes
    // and the agent reconciles them against the project.
    // Voice buttons elsewhere (Grid mic, a Grid panel's phone button, the
    // Grid voice panel) → Robovoice call, or Connect Robovoice when unlinked.
    window.addEventListener("infinibot:voice-call", (ev: Event) => {
      const d = (ev as CustomEvent<{ agentId?: string; sessionKey?: string; source?: string; stay?: boolean }>).detail ?? {};
      enableLiveActionMode(state, d.source ?? "voice-button", { agentId: d.agentId, sessionKey: d.sessionKey, stay: d.stay });
    });

    window.addEventListener("infinibot:project-voice-call", (ev: Event) => {
      const detail = (ev as CustomEvent<{ projectId?: string; projectName?: string }>).detail;
      const projectId = detail?.projectId ?? null;
      if (projectId) {
        try {
          const ctx = loadSessionContext(state.sessionKey);
          saveSessionContext(state.sessionKey, {
            ...ctx,
            projectId,
            projectName: detail?.projectName ?? ctx.projectName ?? projectId,
          });
        } catch { /* noop */ }
      }
      // The project context was saved on the current chat session: bind the call to it.
      enableLiveActionMode(state, "project-voice", { sessionKey: state.sessionKey || undefined });
    });

    // Wake-word coordinator — leader election across all open tabs so
    // only one window holds the mic. The leader also routes codenamed
    // phrases ("hey delta projects") to the correct peer via
    // BroadcastChannel. Must initialize AFTER tab-wake / compound-wake
    // have registered their phrases so the very first heartbeat
    // already carries the full phrase set.
    void import("./controllers/wake-coordinator.js").then(({ initWakeCoordinator }) => {
      initWakeCoordinator();
    });
  }

  // Reconcile per-agent wake words ONLY when the agent list actually
  // changes. The previous "diff inside syncAgentWakeWords" approach still
  // walked every agent and round-tripped localStorage per render — the
  // dominant cost in profile captures. We memoize the list signature here
  // so the import + sync only fires on real changes.
  const _agents = (state as any).agentsMgmtList as Array<{ id: string; name?: string }> | undefined;
  if (Array.isArray(_agents)) {
    const sig = _agents.map((a) => `${a.id}:${a.name ?? ""}`).join("|");
    if (sig !== (globalThis as any).__lastAgentWakeSig) {
      (globalThis as any).__lastAgentWakeSig = sig;
      void import("./controllers/agent-wake.js").then((m) => {
        m.syncAgentWakeWords(_agents);
      });
    }
  }

  // Reconcile the assistant-name wake phrase ("hey <assistant name>") when
  // the identity actually changes. The name usually arrives AFTER the boot
  // block above (agent.identity.get resolves async), so the initial
  // setAssistantWakeName(state.assistantName) sees the default "Assistant";
  // this memoized pass re-points it to the real name (e.g. "Tab") once it
  // loads, and again on any rename.
  {
    const _name = state.assistantName ?? "";
    if (_name !== (globalThis as any).__lastAssistantWakeName) {
      (globalThis as any).__lastAssistantWakeName = _name;
      void import("./controllers/assistant-wake.js").then((m) => {
        m.setAssistantWakeName(_name);
      });
    }
  }

  const chatDisabledReason = state.connected ? null : "Disconnected from gateway.";
  const isChat = state.tab === "chat";
  // Merged host pages (navigation HOST_SUBVIEWS): the tab whose content is on
  // screen — the host itself or the retired view shown in its active sub-tab.
  const _contentTab = activeContentTab(state);
  // Business & Agency pages render only while that plugin is loaded; otherwise
  // the "turned off — enable in Plugins" card replaces them (one place, below).
  // Any page of a paid / desktop-only plugin that isn't unlocked here gets the
  // same card, which then shows the in-context upsell (renderPluginDisabledPage).
  const lockedPluginTab =
    !isTabAvailable(_contentTab) && pluginOwnerOfTab(_contentTab)?.access?.loadable === false;
  const businessOffTab =
    (isBusinessAgencyTab(_contentTab) || lockedPluginTab) && !isTabAvailable(_contentTab) ? _contentTab : null;
  const view = businessOffTab ? ("plugin-off" as Tab) : _contentTab;
  // The voice chat covers <main> only on the Voice page's own (Chat) sub-tab.
  const voiceTabShown = view === "voice";
  const chatFocus = isChat && (state.settings.chatFocusMode || state.onboarding);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAvatarUrl = state.chatAvatarUrl ?? assistantAvatarUrl ?? null;

  const gridFullscreen = (state as any).gridFullscreen ?? false;
  const notesFullscreen = (state as any).notesFullscreen ?? false;

  const _cfgInst = (
    state.configForm?.instance ??
    (state.configSnapshot?.config as Record<string, unknown> | null | undefined)?.instance
  ) as Record<string, unknown> | null | undefined;
  const _instanceName: string | null = (_cfgInst?.name as string | null | undefined) ?? null;

  // ── Satellite status pill ────────────────────────────────────────────────────
  // Lazily load federation config once so the satellite pill appears even when
  // the user hasn't visited the Federation tab yet.
  if (
    state.client &&
    !(state as Record<string, unknown>)._satConfigLoaded &&
    !(state as Record<string, unknown>)._satConfigPending
  ) {
    (state as Record<string, unknown>)._satConfigPending = true;
    state.client
      .request<{ config?: { mode?: string; nodeName?: string; masterUrl?: string } }>(
        "federation.config.get",
        {},
      )
      .then((res) => {
        (state as Record<string, unknown>)._satConfig = res?.config ?? null;
        (state as Record<string, unknown>)._satConfigLoaded = true;
        (state as Record<string, unknown>)._satConfigPending = false;
        state.requestUpdate?.();
      })
      .catch(() => {
        (state as Record<string, unknown>)._satConfigLoaded = true;
        (state as Record<string, unknown>)._satConfigPending = false;
      });
  }
  const _satCfg = (state as Record<string, unknown>)._satConfig as
    | { mode?: string; nodeName?: string; masterUrl?: string }
    | null
    | undefined;
  const _isSatellite = _satCfg?.mode === "satellite";
  const _satNodeName = _satCfg?.nodeName ?? "";
  const _satConnected = state.federationState?.connectionStatus === "connected";
  const _satMasterName =
    state.federationState?.nodes?.find((n) => n.role === "master")?.name ?? "";

  // Secure Mode: global frame + top-bar badge. A secure chat on screen shows
  // the locked frame/badge even while Secure Mode is off.
  const _secState = getSecureState();
  const _secActive = secureActive(_secState);
  const _secChatKey =
    state.tab === "chat" ? state.sessionKey : state.tab === "webchat" ? _secState.chatSessionKey : null;
  const _secSessionLocked = !_secActive && isSecureSessionKey(_secChatKey);
  const _secShellClass = _secActive ? "shell--secure" : _secSessionLocked ? "shell--secure-locked" : "";

  // Chat (/chat) session switch — also the Secure Mode composer lane switch.
  const _switchChatSession = (next: string) => {
    // switchChatSession clears stale messages, sets chatLoadedSessionKey
    // to null, and kicks off loadChatHistory synchronously — so the
    // very next paint shows the loading skeleton instead of an empty
    // placeholder. Same lifecycle as the grid chat panel.
    (state as any)._secureChatError = null;
    state.chatMessage = "";
    state.chatAttachments = [];
    (state as any).chatThinkingStartedAt = null;
    state.chatQueue = [];
    state.resetToolStream();
    state.resetChatScroll();
    switchChatSession(state, next);
    state.applySettings({
      ...state.settings,
      sessionKey: next,
      lastActiveSessionKey: next,
    });
    void state.loadAssistantIdentity();
    void refreshChatAvatar(state);
  };

  scheduleControlBarLayout();
  return html`
    <div class="shell ${_secShellClass} ${isChat ? "shell--chat" : ""} ${chatFocus ? "shell--chat-focus" : ""} ${state.settings.navCollapsed ? "shell--nav-collapsed" : ""} ${state.onboarding ? "shell--onboarding" : ""} ${gridFullscreen ? "shell--grid-fullscreen" : ""} ${notesFullscreen ? "shell--grid-fullscreen" : ""}">
      <header class="topbar" data-cb>
        <div class="topbar-left">
          <button
            class="nav-collapse-toggle"
            data-ib-target="control:sidebar/collapse"
            @click=${() =>
      state.applySettings({
        ...state.settings,
        navCollapsed: !state.settings.navCollapsed,
      })}
            title="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            aria-label="${state.settings.navCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
          >
            <span class="nav-collapse-toggle__icon">${icons.menu}</span>
          </button>
          ${(() => {
            const _brand =
              state.appBrandingState?.payload?.branding ??
              readCachedBranding()?.branding ??
              null;
            const _brandTitle = (_brand?.appName ?? "").trim() || BRAND_DEFAULT_TITLE;
            const _brandSub = (_brand?.tagline ?? "").trim() || BRAND_DEFAULT_SUBTITLE;
            const _brandLogo = resolveBrandLogoUrl(_brand);
            return html`
          <button
            type="button"
            class="brand brand--button"
            data-cb-item="brand"
            title="${t("branding.modal.open", undefined, "Customize branding")}"
            aria-label="${t("branding.modal.open", undefined, "Customize branding")}"
            @click=${() => openBrandingModal(state, () => state.requestUpdate?.())}
          >
            <div class="brand-logo">
              <img src="${_brandLogo}" alt="${_brandTitle}" />
            </div>
            <div class="brand-text">
              <div class="brand-title">${_brandTitle}</div>
              <div class="brand-sub">${_brandSub}</div>
            </div>
          </button>`;
          })()}
          ${/* InfiniBar top-nav context: a "back to top tab" pill + the current
                tab's title/subtitle. Slim, single-line, hidden on narrow widths.
                Voice/MCP nav RPC surface is untouched — this only reads state. */
          ""}
          <div class="topbar-tabctx" data-tab-ctx data-cb-item="tabctx">
            ${state.tab !== "dashboard"
            ? html`<a
                  class="topbar-tabctx__home"
                  href="${pathForTab("dashboard", state.basePath ?? "")}"
                  title="Back to Dashboard"
                  aria-label="Back to Dashboard"
                  @click=${(e: MouseEvent) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              state.setTab("dashboard" as Tab);
            }}
                  >${icons.house}</a
                >`
            : nothing}
            <span
              class="topbar-tabctx__text"
              title=${`${subViewsForHost(state.tab).length ? navLabelForTab(state.tab) : titleForTab(state.tab)} — ${subtitleForTab(view) || subtitleForTab(state.tab)}`}
            >
              <span class="topbar-tabctx__title">${
                // A merged host is named by its umbrella label ("Keys & Usage").
                subViewsForHost(state.tab).length ? navLabelForTab(state.tab) : titleForTab(state.tab)
              }</span>
              <span class="topbar-tabctx__sub">${subtitleForTab(view) || subtitleForTab(state.tab)}</span>
            </span>
            ${renderTabLensLinks({
              tab: state.tab,
              basePath: state.basePath ?? "",
              onSelect: (tab) => state.setTab(tab),
            })}
          </div>
          <div class="pill topbar-health-pill" data-cb-item="health" title="${state.connected ? "Connected" : "Offline"}">
            <span class="statusDot ${state.connected ? "ok" : ""}"></span>
            <span>Health</span>
            <span class="mono">${state.connected ? "OK" : "Offline"}</span>
          </div>
          <ib-secure-badge class="topbar-secure-badge" .sessionKey=${_secChatKey ?? ""}></ib-secure-badge>
          <span class="cb-slot" data-cb-item="agency">${renderTopbarSlots(state)}</span>
          ${_instanceName ? html`
          <div class="pill topbar-instance-pill" data-cb-item="instance" title="Instance: ${_instanceName}">
            <span class="statusDot instance-dot"></span>
            <svg class="instance-icon" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="6" cy="2.5" r="1.5"/>
              <circle cx="2" cy="9.5" r="1.5"/>
              <circle cx="10" cy="9.5" r="1.5"/>
              <line x1="6" y1="4" x2="2.8" y2="8.2"/>
              <line x1="6" y1="4" x2="9.2" y2="8.2"/>
            </svg>
            <span class="instance-name">${_instanceName}</span>
          </div>` : nothing}
          ${_isSatellite ? html`
          <div
            data-cb-item="satellite"
            class="pill topbar-satellite-pill ${_satConnected ? "topbar-satellite-pill--connected" : "topbar-satellite-pill--offline"}"
            title="${_satConnected
              ? `Satellite: ${_satNodeName || "this device"} → ${_satMasterName || "master"}`
              : `Satellite: ${_satNodeName || "this device"} — disconnected from ${_satMasterName || "master"}`}"
            @click=${() => {
              // Navigate to federation settings tab on click
              window.history.pushState({}, "", pathForTab("federation", state.basePath ?? ""));
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          >
            <span class="statusDot ${_satConnected ? "ok" : "warn"}"></span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="6" cy="6" r="2"/>
              <path d="M2 6a4 4 0 0 1 4-4"/>
              <path d="M10 6a4 4 0 0 1-4 4"/>
              <path d="M.5 6a5.5 5.5 0 0 1 5.5-5.5"/>
              <path d="M11.5 6a5.5 5.5 0 0 1-5.5 5.5"/>
            </svg>
            <span class="topbar-satellite-label">Satellite: ${_satNodeName || "this device"}${_satMasterName ? html` → ${_satMasterName}` : nothing}</span>
          </div>` : nothing}
          <span class="topbar-coder-cluster" data-cb-item="coder" style="display:inline-flex;align-items:center;gap:6px;">
            ${renderCoderBackendPill(state)}
            ${isSaasMode() ? html`<plan-badge prominent></plan-badge>` : nothing}
          </span>
          <span class="cb-slot" data-cb-item="federation">${renderFederationTabPills(state)}</span>
          <span class="cb-slot" data-cb-item="devices">${renderDevicesButton()}</span>
        </div>
        <div class="topbar-center">
          ${renderTerminalClock({
            state: state.clockState || (state.clockState = loadClockState()),
            currentTime: state.clockTime || new Date(),
            onStateChange: (newState) => {
              state.clockState = newState;
              state.requestUpdate?.();
            },
            // Plugin clock sections (e.g. Infinitrade trading sessions).
            renderSections: () =>
              renderClockSections({
                sections: pluginClockSections(),
                userKey: String((state as any).users?.me?.user?.id ?? "default"),
                ctx: {
                  now: state.clockTime || new Date(),
                  client: state.client ?? null,
                  requestUpdate: () => state.requestUpdate?.(),
                },
              }),
          }, isAlarmSounding())}
        </div>
        ${(() => {
          // Discipline plugin's block-alert toasts: only while it's on.
          if (!isTabAvailable("discipline")) return nothing;
          if (!(state as any)._discAlertState) {
            (state as any)._discAlertState = { alerts: [] } as DisciplineAlertState;
            initDisciplineAlerts(
              (state as any)._discAlertState,
              () => state.requestUpdate?.(),
            );
          }
          return renderDisciplineAlerts(
            (state as any)._discAlertState,
            () => state.requestUpdate?.(),
          );
        })()}
        <div class="topbar-status">
          <button
            data-cb-item="live"
            class="pill ${robovoiceCallLive() ? "active" : ""}"
            style="cursor:pointer; border:none; ${robovoiceCallLive() ? "background: var(--c-accent, var(--g-primary)); color: #000;" : ""}"
            @click=${() => toggleLiveActionMode(state)}
            title="${robovoiceCallLive() ? "Voice call in progress — open Voice" : isCloudVoiceActive() ? "Voice (cloud: Robovoice)" : "Voice (local)"}"
            aria-pressed="${robovoiceCallLive() ? "true" : "false"}"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
              <rect x="9" y="2" width="6" height="12" rx="3"/>
              <path d="M5 10a7 7 0 0 0 14 0"/>
              <line x1="12" y1="17" x2="12" y2="22"/>
            </svg>
            <span class="cb-label">${robovoiceCallLive() ? "On call" : "Voice"}</span>
          </button>
          ${/* Learn — missions. Compact graduation-cap trigger for
                <learn-missions-panel>; replaces the old floating sticky pill. */ ""}
          <learn-topbar-button data-cb-item="learn" .tab=${state.tab}></learn-topbar-button>
          ${/* Chat — toggles the <agent-chat-modal> right-hand sidebar (universal agent switcher). Replaces the
                old CMO-only button; ⌘⇧M, window.agentChat / window.cmoChat and the
                "infinibot:agent-chat" / "infinibot:cmo-chat" events also open it. */ ""}
          <button
            class="topbar-glass-btn"
            data-cb-item="chat"
            @click=${() => window.dispatchEvent(new CustomEvent("infinibot:agent-chat"))}
            title="Chat with an agent (⌘⇧M)"
            aria-label="Chat with an agent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Chat</span>
          </button>
          ${/* Single-Chat toggle removed — the standalone /chat page is deprecated; the grid IS the chat surface. */ ""}
          <span class="cb-slot" data-cb-item="chart">${renderChartButton(_solanaChartState, () => {
            _solanaChartState = { ..._solanaChartState, isOpen: !_solanaChartState.isOpen };
            state.requestUpdate?.();
          })}</span>
          ${isTabAvailable("whiteboard") ? html`<span class="cb-slot" data-cb-item="canvas">${renderCanvasButton(_canvasOverlayState, () => {
            _canvasOverlayState = { ..._canvasOverlayState, isOpen: !_canvasOverlayState.isOpen, isLoading: true };
            state.requestUpdate?.();
          })}</span>` : nothing}
          <span class="cb-slot" data-cb-item="agent">${state.autopilotState
            ? renderAgentSidebarButton({
                autopilot: state.autopilotState,
                onToggle: () => {
                  if (!state.autopilotState) return;
                  state.autopilotState.sidebarOpen = !state.autopilotState.sidebarOpen;
                  state.requestUpdate?.();
                },
              })
            : nothing}</span>
          <span class="cb-slot" data-cb-item="activity">${renderActivityPanelButton(state)}</span>
          <span class="cb-slot" data-cb-item="plugin-right">${renderTopbarSlots(state, "right")}</span>
          <span class="cb-slot" data-cb-item="approvals"><approvals-inbox .client=${state.client}></approvals-inbox></span>
          <div style="position:relative;">${renderNotificationBell(state)}</div>
          <span class="cb-slot" data-cb-item="restart">${renderRestartButton(state)}</span>
          <span class="cb-slot" data-cb-item="language">${renderLanguageToggle(state)}</span>
          <span class="cb-slot" data-cb-item="newwindow">${renderNewWindowButton()}</span>
          <div class="cb-more" data-cb-more></div>
          ${isSaasMode()
            ? renderSaasAccountMenu({ client: state.client, requestUpdate: () => state.requestUpdate?.() })
            : nothing}
        </div>
      </header>
      ${renderSolanaChartOverlay(
        _solanaChartState,
        () => {
          _solanaChartState = { ..._solanaChartState, isOpen: false };
          state.requestUpdate?.();
        },
        (updates) => {
          _solanaChartState = { ..._solanaChartState, ...updates };
          state.requestUpdate?.();
        },
        { client: state.client ?? null, requestUpdate: () => state.requestUpdate?.() }
      )}
      ${isTabAvailable("whiteboard") ? renderCanvasOverlay(
        _canvasOverlayState,
        () => {
          _canvasOverlayState = { ..._canvasOverlayState, isOpen: false };
          state.requestUpdate?.();
        },
        (updates) => {
          _canvasOverlayState = { ..._canvasOverlayState, ...updates };
          state.requestUpdate?.();
        }
      ) : nothing}
      ${renderEnhancedNavSidebar({
        currentTab: state.tab,
        basePath: state.basePath,
        collapsed: state.settings.navCollapsed,
        client: state.client,
        // Bound: state.requestUpdate is the app element's Lit method.
        requestUpdate: () => state.requestUpdate?.(),
        // Use initialized state, with defensive fallback that also assigns to state
        navState: state.navSidebarState || (state.navSidebarState = initializeNavSidebarState()),
        onNavStateChange: (newState) => {
          state.navSidebarState = newState;
          saveNavSidebarState(newState);
        },
        onTabSelect: (tab) => {
          state.setTab(tab);
        },
        // Multi-user gating: when the logged-in user has a non-empty
        // allowedPages list, hide every tab outside it. Admins, the
        // implicit-admin pre-onboarding state, and users with an empty
        // allowedPages list see everything.
        isPageAllowed: (() => {
          // Workspace users (auth.multiUser): only the pages their access allows.
          const accessFilter = accessPageFilter();
          if (accessFilter) return accessFilter;
          const me = (state as any).users?.me;
          if (!me || me.implicitAdmin) return undefined;
          const u = me.user;
          if (!u || u.role === "admin" || u.allowedPages.length === 0) return undefined;
          const allow = new Set<string>(u.allowedPages);
          // The /users page always stays accessible so a non-admin can
          // still reach their profile.
          allow.add("users");
          return (tab: string) => allow.has(tab);
        })(),
      })}
      ${renderLaunchpad({
        basePath: state.basePath,
        currentTab: state.tab,
        navState: state.navSidebarState || (state.navSidebarState = initializeNavSidebarState()),
        onNavStateChange: (newState) => {
          state.navSidebarState = newState;
          saveNavSidebarState(newState);
          state.requestUpdate?.();
        },
        requestUpdate: () => state.requestUpdate?.(),
        onTabSelect: (tab) => state.setTab(tab),
        isPageAllowed: (() => {
          const accessFilter = accessPageFilter();
          if (accessFilter) return accessFilter;
          const me = (state as any).users?.me;
          if (!me || me.implicitAdmin) return undefined;
          const u = me.user;
          if (!u || u.role === "admin" || u.allowedPages.length === 0) return undefined;
          const allow = new Set<string>(u.allowedPages);
          allow.add("users");
          return (tab: string) => allow.has(tab as string);
        })(),
      })}
      <main class="content ${isChat ? "content--chat" : state.tab === "grid" ? "content--grid" : state.tab === "autonomy" ? "content--autonomy" : state.tab === "research" ? "content--research" : view === "knowledge-graph" ? "content--knowledge-graph" : view === "terminals" ? "content--terminals" : view === "mesh" ? "content--mesh" : state.tab === "webchat" ? "content--webchat" : view.startsWith("solatrix") && view !== "solatrix-map" && isTabAvailable(view) ? "content--solatrix" : view === "droid-swarm" && isTabAvailable("droid-swarm") ? "content--plugin-bleed" : ""}">
        ${renderAccessUserBar(getAccessMe(), {
          onSignOut: () => {
            const token = state.settings.token;
            if (isUserSessionToken(token)) void accessLogoutHttp(state.settings.gatewayUrl || "", token);
            state.applySettings({ ...state.settings, token: "", password: "" });
            resetAccessMe();
            location.reload();
          },
          onEndPreview: () => {
            endAccessPreview();
            resetAccessMe();
            window.close();
            location.reload();
          },
          onSelectWorkspace: (id) => {
            void state.client
              ?.request("access.workspace.select", { workspaceId: id })
              .then(() => {
                ensureAccessMe(state.client, () => state.requestUpdate?.(), true);
                state.setTab(state.tab);
              });
          },
        })}
        ${(state.lastError || isChat) && state.tab !== "autonomy" && state.tab !== "research" && state.tab !== "grid" ? html`
        <section class="content-header content-header--compact">
          ${state.lastError
            ? html`<div class="pill danger" style="margin-right:auto">${state.lastError}</div>`
            : nothing}
          ${isChat ? renderChatControls(state) : nothing}
        </section>
        ` : nothing}

        ${voiceTabShown || isChat || !isTabAvailable(state.tab) ? nothing : renderSetupBanner({
          tab: state.tab,
          view: state.hostView?.[state.tab],
          basePath: state.basePath ?? "",
          onNavigate: (tab, view) => {
            state.setTab(tab);
            if (view) state.setHostView(view);
          },
          requestUpdate: () => state.requestUpdate?.(),
        })}

        ${voiceTabShown || !isTabAvailable(state.tab) /* plugin-gated host that's off */ ? nothing : renderHostSubtabs({
          host: state.tab,
          view: state.hostView?.[state.tab],
          basePath: state.basePath ?? "",
          onSelect: (v) => state.setHostView(v),
          isPageAllowed: (tab) => isTabAvailable(tab),
        })}

        ${/* Voice page = the Robovoice console. The call itself lives in a
              module-level store (views/voice-robovoice/call-store.ts), so
              navigating away mid-call keeps the LiveKit room up. */
          voiceTabShown
            ? (loadVoiceConsole(),
              html`<div class="plugin-scope" data-plugin-scope="robovoice">
                <voice-robovoice-console .client=${state.client}
                  @voice-navigate=${() => state.setTab("robovoice")}></voice-robovoice-console>
              </div>`)
            : nothing}

        ${view === "channels"
      ? renderChannels({
        connected: state.connected,
        loading: state.channelsLoading,
        snapshot: state.channelsSnapshot,
        lastError: state.channelsError,
        lastSuccessAt: state.channelsLastSuccess,
        whatsappMessage: state.whatsappLoginMessage,
        whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
        whatsappConnected: state.whatsappLoginConnected,
        whatsappBusy: state.whatsappBusy,
        configSchema: state.configSchema,
        configSchemaLoading: state.configSchemaLoading,
        configForm: state.configForm,
        configUiHints: state.configUiHints,
        configSaving: state.configSaving,
        configFormDirty: state.configFormDirty,
        nostrProfileFormState: state.nostrProfileFormState,
        nostrProfileAccountId: state.nostrProfileAccountId,
        onRefresh: (probe) => loadChannels(state, probe),
        onWhatsAppStart: (force) => state.handleWhatsAppStart(force),
        onWhatsAppWait: () => state.handleWhatsAppWait(),
        onWhatsAppLogout: () => state.handleWhatsAppLogout(),
        onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
        onConfigSave: () => state.handleChannelConfigSave(),
        onConfigReload: () => state.handleChannelConfigReload(),
        onNostrProfileEdit: (accountId, profile) =>
          state.handleNostrProfileEdit(accountId, profile),
        onNostrProfileCancel: () => state.handleNostrProfileCancel(),
        onNostrProfileFieldChange: (field, value) =>
          state.handleNostrProfileFieldChange(field, value),
        onNostrProfileSave: () => state.handleNostrProfileSave(),
        onNostrProfileImport: () => state.handleNostrProfileImport(),
        onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
      })
      : nothing}

        ${state.tab === "instances"
      ? renderInstances({
        loading: state.presenceLoading,
        entries: state.presenceEntries,
        lastError: state.presenceError,
        statusMessage: state.presenceStatus,
        onRefresh: () => loadPresence(state),
        // Instance-project assignment props
        projects: [],
        contextMenu: state.instanceProjectsContextMenu,
        instanceProjects: state.instanceProjectsAssignments,
        onContextMenu: (menu: InstanceContextMenu) => {
          state.instanceProjectsContextMenu = menu;
        },
        onAssignToProject: (instanceId: string, projectId: string) => {
          state.instanceProjectsAssignments = assignInstanceToProject(
            state.instanceProjectsAssignments,
            instanceId,
            projectId,
            undefined
          );
        },
        onUnassignFromProject: (instanceId: string, projectId: string) => {
          state.instanceProjectsAssignments = unassignInstanceFromProject(
            state.instanceProjectsAssignments,
            instanceId,
            projectId,
            undefined
          );
        },
      })
      : nothing}

        ${state.tab === "activity" && state.client
      ? lazyRenderAgentActivity(state, state.client, () => state.requestUpdate?.())
      : nothing}

        ${view === "oversight" && state.client
      ? lazyOversight((m) => m.renderOversightView(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "reports" && state.client
      ? lazyReports((m) => m.renderReportsView(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "reviews" && state.client
      ? lazyReviews((m) => m.renderReviewsView(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "canvas" && state.client
      ? /* HoloCanvas library plugin (extensions/canvas-library): gated. */
        isTabAvailable("canvas")
        ? html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("canvas") ?? "canvas-library"}>
            ${lazyCanvasLibrary((m) => m.renderCanvasLibraryView(state, state.client!, () => state.requestUpdate?.()), () => state.requestUpdate?.())}
          </div>`
        : renderPluginDisabledPage(state, "canvas")
      : nothing}

        ${state.tab === "schedule" && state.client
      ? lazySchedule((m) => m.renderSchedule(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "sites" && state.client
      ? lazySites((m) => m.renderSites(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "autonomy" && state.client
      ? (() => {
          // Lazy-init the autonomy view: load both autonomy status and the
          // kanban projects/tasks (Notion-backed) so the Projects tab has data.
          if (!state.autonomyState) state.autonomyState = createAutonomyState();
          if (state.client && !autonomyInitialized) {
            autonomyInitialized = true;
            void loadAutonomyStatus(state.client).then((u) => {
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...u };
              state.requestUpdate?.();
              const runningId = state.autonomyState?.runningTask?.id;
              if (runningId) void loadAutonomyActivity(state, runningId, { force: true });
            });
          }
          // Keep activity + status fresh while the user is on this tab.
          startAutonomyPolling(state);
          // Eager-load activity for whichever task the operator just picked.
          if (state.client) {
            const selectedId = state.autonomyState.selectedTaskId;
            if (selectedId) void loadAutonomyActivity(state, selectedId);
            const runningId = state.autonomyState.runningTask?.id;
            if (runningId && runningId !== selectedId) void loadAutonomyActivity(state, runningId);
          }
          // Always refetch kanban when entering autonomy with empty data —
          // the initial load can race the gateway hello, and the projects
          // sub-tab is useless without it. kanbanInitialized still guards
          // the projects tab to avoid double-fetches there.
          if (state.client && !state.kanbanLoading && (state.kanbanProjects?.length ?? 0) === 0) {
            kanbanInitialized = true;
            void loadKanban(state).then(() => state.requestUpdate?.());
          }
          // Hydrate kanban into the autonomy state each render so the view sees
          // the latest projects/tasks without a separate fetch path.
          (state.autonomyState as any).kanbanProjects = state.kanbanProjects;
          (state.autonomyState as any).kanbanTasks = state.kanbanTasks;
          // Mirror continuous workflow daemons from workflowsState — the
          // workflows view's polling loop keeps liveDaemons fresh, so the
          // autonomy page can show them without its own polling.
          {
            const wsDaemons = (state as any).workflowsState?.liveDaemons ?? [];
            const workflowsList = (state as any).workflowsState?.workflows ?? [];
            (state.autonomyState as any).liveDaemons = wsDaemons.map((d: any) => ({
              runId: d.runId,
              workflowId: d.workflowId,
              workflowName: workflowsList.find((w: any) => w.id === d.workflowId)?.name,
              paused: d.paused,
              iterationCount: d.iterationCount,
              errorStreak: d.errorStreak,
              stopReason: d.stopReason,
            }));
          }
          return renderAutonomyDashboard(
        state.autonomyState,
        {
          client: state.client,
          onPause: async () => {
            if (state.client) {
              await pauseAutonomy(state.client);
              const update = await loadAutonomyStatus(state.client);
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
              state.requestUpdate?.();
            }
          },
          onResume: async () => {
            if (state.client) {
              await resumeAutonomy(state.client);
              const update = await loadAutonomyStatus(state.client);
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
              state.requestUpdate?.();
            }
          },
          onApprove: async (taskId: string) => {
            if (state.client) {
              await approveTask(state.client, taskId);
              const update = await loadAutonomyStatus(state.client);
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
              state.requestUpdate?.();
            }
          },
          onCancel: async (taskId: string) => {
            if (state.client) {
              await cancelTask(state.client, taskId);
              const update = await loadAutonomyStatus(state.client);
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
              state.requestUpdate?.();
            }
          },
          onRefresh: async () => {
            if (state.client) {
              const update = await loadAutonomyStatus(state.client);
              state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
              state.requestUpdate?.();
            }
          },
          onTabChange: (tab) => {
            if (state.autonomyState) {
              state.autonomyState.selectedTab = tab;
              state.requestUpdate?.();
            }
          },
          onStopContinuous: async (runId: string) => {
            if (state.client) {
              await state.client.request("workflows.continuous.stop", { runId });
              state.requestUpdate?.();
            }
          },
          onPauseContinuous: async (runId: string) => {
            if (state.client) {
              await state.client.request("workflows.continuous.pause", { runId });
              state.requestUpdate?.();
            }
          },
          onResumeContinuous: async (runId: string) => {
            if (state.client) {
              await state.client.request("workflows.continuous.resume", { runId });
              state.requestUpdate?.();
            }
          },
          onTestNotification: async () => {
            if (state.client) {
              await sendTestNotification(state.client);
            }
          },
          onTestTelegram: async () => {
            if (!state.client) return;
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            const result = await testTelegram(state.client);
            (state.autonomyState as any).telegramTestResult = result;
            (state.autonomyState as any).telegramStatus = await getTelegramStatus(state.client);
            state.requestUpdate?.();
          },
          onReconnectTelegram: async () => {
            if (!state.client) return;
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            const result = await reconnectTelegram(state.client);
            (state.autonomyState as any).telegramTestResult = result;
            (state.autonomyState as any).telegramStatus = await getTelegramStatus(state.client);
            state.requestUpdate?.();
          },
          onSelectTask: (taskId: string | null) => {
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            (state.autonomyState as any).selectedTaskId = taskId ?? undefined;
            state.requestUpdate?.();
            if (taskId) void loadAutonomyActivity(state, taskId, { force: true });
          },
          onOpenCreateDialog: () => {
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            state.autonomyState!.showCreateDialog = true;
            state.autonomyState!.createDraft = { title: "", description: "", priority: "normal", requiresApproval: false, executionMode: "gateway", cli: "claude", cwd: "" };
            state.requestUpdate?.();
          },
          onCloseCreateDialog: () => {
            if (state.autonomyState) {
              state.autonomyState.showCreateDialog = false;
              state.requestUpdate?.();
            }
          },
          onCreateDraftChange: (patch) => {
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            state.autonomyState!.createDraft = { ...(state.autonomyState!.createDraft ?? { title: "", description: "", priority: "normal", requiresApproval: false, executionMode: "gateway", cli: "claude", cwd: "" }), ...patch };
            state.requestUpdate?.();
          },
          onSubmitCreate: async () => {
            if (!state.client || !state.autonomyState) return;
            const d = state.autonomyState.createDraft;
            if (!d || !d.title.trim()) return;
            await queueAutonomyTask(state.client, d.title.trim(), d.description.trim(), {
              priority: d.priority,
              requiresApproval: d.requiresApproval,
              executionMode: d.executionMode,
              cli: d.executionMode === 'terminal' ? d.cli : undefined,
              cwd: d.executionMode === 'terminal' ? d.cwd : undefined,
              // Goal-mode + backend: only sent when the user picked
              // goal-mode in the dialog. Otherwise the legacy build/test
              // path runs and backend is irrelevant.
              isGoal: d.isGoal,
              goalText: d.isGoal ? (d.goalText || d.description.trim()) : undefined,
              backend: d.isGoal ? d.backend : undefined,
            });
            state.autonomyState.showCreateDialog = false;
            state.autonomyState.createDraft = { title: "", description: "", priority: "normal", requiresApproval: false, executionMode: "gateway", cli: "claude", cwd: "" };
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...state.autonomyState, ...update };
            state.requestUpdate?.();
          },
          onQueueKanbanTask: async (task, project) => {
            if (!state.client) return;
            await importKanbanTaskToAutonomy(state.client, {
              kanbanTaskId: task.id,
              kanbanProjectId: project?.id,
              title: task.title,
              description: task.description ?? "",
              requiresApproval: true,
            });
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onSyncToKanban: async (taskId: string) => {
            if (!state.client) return;
            await syncTaskToKanban(state.client, taskId);
            // Refresh both autonomy + kanban so the linked task reflects new state
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            await loadKanban(state);
            state.requestUpdate?.();
          },
          onLinkToKanban: async (taskId: string, kanbanTaskId: string) => {
            if (!state.client) return;
            await linkTaskToKanban(state.client, taskId, kanbanTaskId || undefined);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            await loadKanban(state);
            state.requestUpdate?.();
          },
          onOpenKanban: () => {
            state.tab = "projects" as any;
            state.requestUpdate?.();
          },
          onOpenTerminal: (terminalId: string) => {
            // Switch to the Terminals tab and focus the spawned PTY. The
            // xterm directive in terminals.ts replays the gateway-side
            // scrollback on mount, so the operator sees the full live TUI.
            try { state.setTab("terminals" as any); } catch { state.tab = "terminals" as any; }
            void import("./controllers/terminals").then(({ setActiveSession }) => {
              try { setActiveSession(state, terminalId); } catch (err) { console.warn("[autonomy] setActiveSession failed:", err); }
            });
            state.requestUpdate?.();
          },
          onOpenSession: (sessionKey: string) => {
            // Switch the chat view to the iteration's gateway session so
            // the operator can read the live transcript.
            try { state.setTab("chat" as any); } catch { state.tab = "chat" as any; }
            try { switchChatSession(state, sessionKey); } catch (err) { console.warn("[autonomy] switchChatSession failed:", err); }
            state.requestUpdate?.();
          },
          onRefreshKanban: async () => {
            await loadKanban(state);
            state.requestUpdate?.();
          },
          onSavePrefire: async (taskId: string, prefire: any) => {
            if (!state.client) return;
            await savePrefireQuestions(state.client, taskId, prefire);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onStartLoop: async (taskId: string) => {
            if (!state.client) return;
            const result = await startClosedLoop(state.client, taskId);
            if (!result.ok && result.error) {
              alert(`Cannot start loop: ${result.error}`);
            }
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onGeneratePrefireForm: async (taskId: string) => {
            if (!state.client) return;
            const result = await generatePrefireForm(state.client, taskId);
            if (!result.ok) {
              alert(`Could not generate form: ${result.error}`);
            }
            // Clear the generating flag and the map-based draft so the new form's defaults load.
            (state.autonomyState as any)?.pendingTasks?.forEach((t: any) => { delete t._prefireGenerating; });
            clearPrefireDraft(taskId);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onSavePrefireForm: async (taskId: string, answers: Record<string, unknown>) => {
            if (!state.client) return;
            await savePrefireFormAnswers(state.client, taskId, answers);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onMarkPrefireReady: async (taskId: string) => {
            if (!state.client) return;
            await markPrefireReady(state.client, taskId);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onSetPrefireRequired: async (taskId: string, required: boolean) => {
            if (!state.client) return;
            await setPrefireRequired(state.client, taskId, required);
            const update = await loadAutonomyStatus(state.client);
            state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
            state.requestUpdate?.();
          },
          onVerifyChain: async () => {
            if (!state.client || !state.autonomyState) return;
            const result = await verifyAuditChain(state.client);
            state.autonomyState.chainVerifyResult = result;
            if (result) state.autonomyState.chainValid = result.valid;
            state.requestUpdate?.();
          },
          onAuditSearchChange: (q: string) => {
            if (!state.autonomyState) state.autonomyState = createAutonomyState();
            state.autonomyState.auditSearch = q;
            state.requestUpdate?.();
          },
          onConfigureChannels: () => {
            state.tab = "channels" as any;
            state.requestUpdate?.();
          },
          onRetryNotifications: async () => {
            if (!state.client) return;
            try { await state.client.request("autonomy:notify.retry", {}); } catch {}
          },
          onRefreshActivity: async (taskId: string) => {
            await loadAutonomyActivity(state, taskId, { force: true });
            state.requestUpdate?.();
          },
          onLoadDefaultBackend: async () => {
            if (!state.client || !state.autonomyState) return;
            const { getDefaultAutonomyBackend } = await import("./controllers/autonomy.js");
            const b = await getDefaultAutonomyBackend(state.client);
            state.autonomyState.defaultBackend = b;
            state.requestUpdate?.();
          },
          onSaveDefaultBackend: async (backend: any) => {
            if (!state.client || !state.autonomyState) return;
            const { setDefaultAutonomyBackend, getDefaultAutonomyBackend } = await import(
              "./controllers/autonomy.js"
            );
            const ok = await setDefaultAutonomyBackend(state.client, backend);
            if (ok) {
              state.autonomyState.defaultBackend = await getDefaultAutonomyBackend(state.client);
              state.requestUpdate?.();
            }
          },
        }
      );
        })()
      : nothing}

        ${view === "memory" && state.client && resolveSubView("memory", state.hostView?.memory)?.id === "agents"
      ? (loadMemoryAgents(),
        html`<memory-agents-view
          .basePath=${state.basePath ?? ""}
          .onNavigate=${(tab: string) => state.setTab(tab as Tab)}
          .onOpenIdentity=${(agentId: string, filename: string) => void openAgentIdentityFile(state, agentId, filename)}
        ></memory-agents-view>`)
      : view === "memory" && state.client
      ? lazyMemory((m) => m.renderMemory(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "workflows" && state.client
      ? lazyWorkflows((m) => m.renderWorkflows(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "launch-panel" && state.client
      ? lazyLaunchPanel((m) => m.renderLaunchPanel(state, state.client!, () => state.requestUpdate?.()), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "notes" && state.client
      ? lazyNotes((m) => m.renderNotes(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "issues" && state.client
      ? lazyIssues((m) => m.renderIssues(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "prompt-templates" && state.client
      ? lazyPromptTemplates((m) => m.renderPromptTemplates(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "products" && state.client
      ? isTabAvailable("products")
        ? html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("products") ?? "products"}>
            ${lazyProducts((m) => m.renderProducts(state as never), () => state.requestUpdate?.())}
          </div>`
        : renderPluginDisabledPage(state, "products")
      : nothing}

        ${view === "opportunities" && state.client
      ? baScope(
        lazyOpportunities((m) => m.renderOpportunity(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "decisions" && state.client
      ? baScope(
        lazyDecisions((m) => m.renderDecision(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "risks" && state.client
      ? baScope(
        lazyRisks((m) => m.renderRisk(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "commitments" && state.client
      ? baScope(
        lazyCommitments((m) => m.renderCommitment(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "people" && state.client
      ? baScope(
        lazyPeople((m) => m.renderPerson(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "people-network" && state.client
      ? baScope(
        lazyPeopleNetwork((m) => m.renderPeopleNetwork(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "product-portfolio" && state.client
      ? isTabAvailable("product-portfolio")
        ? html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("product-portfolio") ?? "products"}>
            ${lazyProductPortfolio((m) => m.renderProduct(state, state.client!), () => state.requestUpdate?.())}
          </div>`
        : renderPluginDisabledPage(state, "product-portfolio")
      : nothing}

        ${state.tab === "design" && state.client
      ? lazyDesign((m) => m.renderDesign(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "research" && state.client
      ? lazyResearch((m) => m.renderResearchWorkspace(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "agents" && state.client
      ? lazyAgentsManagement(
        (m) => m.renderAgentsManagement({ state, client: state.client! }),
        () => state.requestUpdate?.(),
      )
      : nothing}

        ${state.tab === "sessions"
      ? renderSessions({
        loading: state.sessionsLoading,
        result: state.sessionsResult,
        error: state.sessionsError,
        activeMinutes: state.sessionsFilterActive,
        limit: state.sessionsFilterLimit,
        includeGlobal: state.sessionsIncludeGlobal,
        includeUnknown: state.sessionsIncludeUnknown,
        basePath: state.basePath,
        onFiltersChange: (next) => {
          state.sessionsFilterActive = next.activeMinutes;
          state.sessionsFilterLimit = next.limit;
          state.sessionsIncludeGlobal = next.includeGlobal;
          state.sessionsIncludeUnknown = next.includeUnknown;
        },
        onRefresh: () => void loadSessions(state),
        onPatch: (key, patch) => void patchSession(state, key, patch),
        onDelete: (key) => void deleteSession(state, key),
      })
      : nothing}

        ${state.tab === "skills"
      ? renderSkills({
        loading: state.skillsLoading,
        report: state.skillsReport,
        error: state.skillsError,
        filter: state.skillsFilter,
        edits: state.skillEdits,
        messages: state.skillMessages,
        busyKey: state.skillsBusyKey,
        onFilterChange: (next) => (state.skillsFilter = next),
        onRefresh: () => {
          void loadSkills(state, { clearMessages: true });
          void loadLearnedSkills(state);
          void loadSkillQueueStats(state);
        },
        onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
        onEdit: (key, value) => updateSkillEdit(state, key, value),
        onSaveKey: (key) => saveSkillApiKey(state, key),
        onInstall: (skillKey, name, installId) =>
          installSkill(state, skillKey, name, installId),
        onAuthorSkill: (input) => void authorSkill(state, input),
        importClient: state.client,
        onImported: () => void loadSkills(state, { clearMessages: true }),
        onDeleteSkill: (skillKey, filePath) => void deleteSkill(state, skillKey, filePath),
        learnedSkills: state.learnedSkills,
        learnedLoading: state.learnedLoading,
        learnedError: state.learnedError,
        learnedEnabled: state.learnedSkillsEnabled,
        learnedSelfImproveRunning: state.learnedSelfImproveRunning,
        learnedSelfImproveSummary: state.learnedSelfImproveSummary,
        onLearnedRefresh: () => loadLearnedSkills(state),
        onLearnedDelete: (key) => deleteLearnedSkill(state, key),
        onLearnedSelfImprove: () => runLearnedSelfImprove(state),
        // Queue management
        drafts: state.skillDrafts,
        draftsLoading: state.skillDraftsLoading,
        draftsError: state.skillDraftsError,
        healingProposals: state.skillHealingProposals,
        healingLoading: state.skillHealingLoading,
        healingError: state.skillHealingError,
        activity: state.skillActivity,
        activityLoading: state.skillActivityLoading,
        skillConfig: state.skillSystemConfig,
        skillConfigLoading: state.skillConfigLoading,
        skillConfigSaving: state.skillConfigSaving,
        queueStats: state.skillQueueStats,
        onDraftsRefresh: () => loadSkillDrafts(state),
        onDraftAccept: (id, scope, editedMd) => void acceptSkillDraft(state, id, { targetScope: scope, editedMd }),
        onDraftReject: (id, reason) => void rejectSkillDraft(state, id, reason),
        onDraftGetContent: (id) => getDraftFullContent(state, id),
        onHealingRefresh: () => loadSkillHealingProposals(state),
        onHealingApply: (id, editedMd) => void applySkillHealing(state, id, editedMd),
        onHealingReject: (id, reason) => void rejectSkillHealing(state, id, reason),
        onHealingGetContent: (id) => getHealingProposalContent(state, id),
        onActivityRefresh: () => loadSkillActivity(state),
        onSaveConfig: (patch) => void saveSkillSystemConfig(state, patch),
      })
      : nothing}

        ${state.tab === "nodes"
      ? renderNodes({
        loading: state.nodesLoading,
        nodes: state.nodes,
        devicesLoading: state.devicesLoading,
        devicesError: state.devicesError,
        devicesList: state.devicesList,
        configForm: state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null),
        configLoading: state.configLoading,
        configSaving: state.configSaving,
        configDirty: state.configFormDirty,
        configFormMode: state.configFormMode,
        execApprovalsLoading: state.execApprovalsLoading,
        execApprovalsSaving: state.execApprovalsSaving,
        execApprovalsDirty: state.execApprovalsDirty,
        execApprovalsSnapshot: state.execApprovalsSnapshot,
        execApprovalsForm: state.execApprovalsForm,
        execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
        execApprovalsTarget: state.execApprovalsTarget,
        execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
        onRefresh: () => loadNodes(state),
        onDevicesRefresh: () => loadDevices(state),
        onDeviceApprove: (requestId) => approveDevicePairing(state, requestId),
        onDeviceReject: (requestId) => rejectDevicePairing(state, requestId),
        onDeviceRotate: (deviceId, role, scopes) =>
          rotateDeviceToken(state, { deviceId, role, scopes }),
        onDeviceRevoke: (deviceId, role) =>
          revokeDeviceToken(state, { deviceId, role }),
        onDeviceRename: (deviceId, displayName) =>
          renameDevice(state, deviceId, displayName),
        onRequestUpdate: () => state.requestUpdate?.(),
        onLoadConfig: () => loadConfig(state),
        onLoadExecApprovals: () => {
          const target =
            state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
              ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
              : { kind: "gateway" as const };
          return loadExecApprovals(state, target);
        },
        onBindDefault: (nodeId) => {
          if (nodeId) {
            updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
          } else {
            removeConfigFormValue(state, ["tools", "exec", "node"]);
          }
        },
        onBindAgent: (agentIndex, nodeId) => {
          const basePath = ["agents", "list", agentIndex, "tools", "exec", "node"];
          if (nodeId) {
            updateConfigFormValue(state, basePath, nodeId);
          } else {
            removeConfigFormValue(state, basePath);
          }
        },
        onSaveBindings: () => saveConfig(state),
        onExecApprovalsTargetChange: (kind, nodeId) => {
          state.execApprovalsTarget = kind;
          state.execApprovalsTargetNodeId = nodeId;
          state.execApprovalsSnapshot = null;
          state.execApprovalsForm = null;
          state.execApprovalsDirty = false;
          state.execApprovalsSelectedAgent = null;
        },
        onExecApprovalsSelectAgent: (agentId) => {
          state.execApprovalsSelectedAgent = agentId;
        },
        onExecApprovalsPatch: (path, value) =>
          updateExecApprovalsFormValue(state, path, value),
        onExecApprovalsRemove: (path) =>
          removeExecApprovalsFormValue(state, path),
        onSaveExecApprovals: () => {
          const target =
            state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
              ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
              : { kind: "gateway" as const };
          return saveExecApprovals(state, target);
        },
      })
      : nothing}

        ${state.tab === "mcp" && state.client
      ? lazyMcp((m) => m.renderMcp(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "terminals" && state.client
      ? lazyTerminals((m) => {
          // "Open terminal on this device" from Fleet › Control device.
          applyPendingTerminalNode(state);
          return m.renderTerminals(state, state.client!);
        }, () => state.requestUpdate?.())
      : nothing}

        ${view === "business" && state.client
      ? baScope(
        lazyBusiness((m) => m.renderBusiness(state, state.client!), () => state.requestUpdate?.()))
      : nothing}


        ${view === "agency-operations" && state.client
      ? baScope(
        state.deepLink?.kind === "project"
        ? html`<project-detail-page
            .slug=${state.deepLink.slug}
            .projectId=${idFromSlug(state.deepLink.slug) ?? ""}
          ></project-detail-page>`
        : lazyAgencyOperations((m) => m.renderAgencyOperations(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "agency-topology" && state.client
      ? baScope(
        lazyAgencyTopology((m) => m.renderAgencyTopology(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "agency-daily" && state.client
      ? baScope(
        lazyAgencyDaily((m) => m.renderAgencyDaily(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "credits" && state.client
      ? renderCredits(state, state.client)
      : nothing}

        ${view === "discipline" && state.client
      ? renderDisciplinePluginPage(state, "discipline")
      : nothing}

        ${state.tab === "appearance" && state.client
      ? renderAppearance(state, state.client)
      : nothing}

        ${state.tab === "access" && state.client
      ? lazyAccessAdmin((m) => m.renderAccessAdmin(state, state.client!), () => state.requestUpdate?.())
      : nothing}
        ${state.tab === "users" && state.client
      ? lazyUsers((m) => m.renderUsers(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "profiles" && state.client
      ? lazyProfilesManager((m) => m.renderProfilesManager(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "mobile" && state.client
      ? renderMobile(state, state.client)
      : nothing}

        ${view === "knowledge-graph"
      ? lazyKnowledgeGraph((m) => m.renderKnowledgeGraphView(state.client), () => state.requestUpdate?.())
      : nothing}

        ${/* /dashboard: Business HQ while the Business & Agency plugin is on,
             otherwise the generic OS home. A brand-new install gets the
             getting-started checklist here first, until it's finished or
             dismissed (controllers/first-run.ts). */
      state.tab === "dashboard" && state.client
      ? renderDashboardOrFirstRun(state)
      : nothing}

        ${/* /business-hq — the plugin section's own HQ entry. */
      view === "business-hq" && state.client
      ? baScope(lazyBusinessHq((m) => m.renderBusinessHQ(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${businessOffTab ? renderPluginDisabledPage(state, businessOffTab) : nothing}

        ${/* /ceo — Executive Command Center (§15/§16/§17): exceptions, priorities, decisions. */
      view === "command-ceo" && state.client
      ? baScope(
        lazyCommandCeo((m) => m.renderCommandCeo(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${/* /ops — Operations Command Center (§18): full-visibility operating view. */
      view === "command-ops" && state.client
      ? baScope(
        lazyCommandOps((m) => m.renderCommandOps(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${/* /android-ops — 4-phone Android Social Ops command center. */
      state.tab === "android-ops" && state.client
      ? lazyAndroidOps((m) => m.renderAndroidOps(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "learn" && state.client
      ? lazyLearn((m) => m.renderLearn(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "daily-review" && state.client
      ? lazyDailyReview((m) => m.renderDailyReview(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "apps" && state.client
      ? lazyApps((m) => m.renderApps(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${/* Unified Inbox — canonical mount for /inbox and legacy /email /emails /reply-inbox */
        view === "inbox" && state.client
          ? lazyInbox((m) => {
              // The inbox's All Mail / Replies / Insights switch is the host
              // sub-view (?view=; /email and /reply-inbox redirect onto it).
              const want = (state.hostView?.inbox ?? "mail") as InboxView;
              if (!(state as any).inboxState) {
                (state as any).inboxState = m.createInboxState(want);
              }
              const is: InboxState = (state as any).inboxState;
              if (is.view !== want) void m.switchInboxView(is, want, () => state.requestUpdate?.());
              return m.renderInbox(is, state.client!, state, () => state.requestUpdate?.());
            }, () => state.requestUpdate?.())
          : nothing}

        ${state.tab === "docs"
      ? renderDocs()
      : nothing}

        ${state.tab === "storyboard" && state.client
      ? lazyRenderStoryboard(state, state.client, () => state.requestUpdate?.())
      : nothing}

        ${view === "clients" && state.client
      ? baScope(
        lazyClients((m) => m.renderClients(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "comms" && state.client
      ? lazyCommsHub((m) => m.renderCommsHub(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${(view === "leads" || view === "qualifier" || view === "pipeline") && state.client
      ? baScope(
        lazyLeadDashboard(
          (m) =>
            m.renderLeadDashboard({
              appState: state,
              client: state.client!,
              forceSection: m.sectionForLegacyTab(
                view as "leads" | "qualifier" | "pipeline",
              ),
              onUpdate: () => (state as any).requestUpdate?.(),
            }),
          () => state.requestUpdate?.(),
        ))
      : nothing}

        ${view === "hub" && state.client
      ? baScope(lazyBusinessHub((m) => m.renderBusinessHub(state, state.client!), () => state.requestUpdate?.()))
      : nothing}

        ${view === "funnels" && state.client
      ? baScope(
        lazyFunnels(
          (m) =>
            m.renderFunnels({
              requestUpdate: () => (state as any).requestUpdate?.(),
              client: state.client!,
            }),
          () => state.requestUpdate?.(),
        ))
      : nothing}

        ${/* /campaigns lands on the Business Hub's Campaigns section (navigation HOST_SUBVIEWS). */nothing}

        ${/* reply-inbox tab now handled by the unified inbox block above */nothing}

        ${view === "databases" && state.client
      ? lazyDatabases((m) => m.renderDatabases(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "repos" && state.client
      ? lazyRepos((m) => m.renderRepos(), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "browser" && state.client
      ? renderBrowserSetup(state, state.client)
      : nothing}

        ${view === "hardware"
      ? (loadHardwareAnalysis(), html`<hardware-analysis></hardware-analysis>`)
      : nothing}

        ${view === "content-pages" || view === "content-intel"
      ? renderContentStudioPage(state, view)
      : nothing}

        ${view === "community"
      ? renderCommunityPage(state)
      : nothing}

        ${state.tab === "webchat"
      ? (loadWebchat(), html`<webchat-view .client=${state.client} .connected=${state.connected} .navCollapsed=${Boolean(state.settings.navCollapsed)}></webchat-view>`)
      : nothing}

        ${view === "inficode"
      ? isTabAvailable("inficode")
        ? (loadInficode(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("inficode") ?? "infinicode"}>
            <inficode-view .state=${state} .client=${state.client}></inficode-view>
          </div>`)
        : renderPluginDisabledPage(state, "inficode")
      : nothing}

        ${view === "robovoice"
      ? isTabAvailable("robovoice")
        ? (loadRobovoice(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("robovoice") ?? "robovoice"}>
            <robovoice-view .state=${state} .client=${state.client}></robovoice-view>
          </div>`)
        : renderPluginDisabledPage(state, "robovoice")
      : nothing}

        ${view === "omniclinic" || view === "oc-research" || view === "oc-databases"
      ? renderOmniclinicPage(state, view)
      : nothing}

        ${view === "infinitrade" || view === "infinitrade-knowledge" || view === "infinitrade-calendar" || view === "infinitrade-scanner" || view === "infinitrade-signals" || view === "infinitrade-journal" || view === "infinitrade-accounts" || view === "infinitrade-toolkit" || view === "infinitrade-indicators" || view === "infinitrade-personal" || view === "infinitrade-research" || view === "infinitrade-settings"
      ? isTabAvailable(view)
        ? (loadInfinitrade(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(view) ?? "infinitrade"}>
            <infinitrade-view .state=${state} .client=${state.client} .page=${view}></infinitrade-view>
          </div>`)
        : renderPluginDisabledPage(state, view)
      : nothing}

        ${view === "solatrix-bubblemap" || view === "solatrix-convergence" || view === "solatrix-alerts"
      ? isTabAvailable(view)
        ? (loadSolatrixIntel(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(view) ?? "solatrix"}>
            <solatrix-intel-page .client=${state.client} .page=${view}></solatrix-intel-page>
          </div>`)
        : renderPluginDisabledPage(state, view)
      : nothing}

        ${view === "solatrix" || view === "solatrix-portfolio" || view === "solatrix-wallets" || view === "solatrix-discovery" || view === "solatrix-copy" || view === "solatrix-launcher" || view === "solatrix-map" || view === "solatrix-queue" || view === "solatrix-settings"
      ? isTabAvailable(view)
        ? (loadSolatrix(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(view) ?? "solatrix"}>
            <solatrix-page .state=${state} .client=${state.client} .page=${view}></solatrix-page>
          </div>`)
        : renderPluginDisabledPage(state, view)
      : nothing}

        ${view === "flypic"
      ? isTabAvailable("flypic") && pluginPageOfTab("flypic")?.entry
        ? (loadPluginEntryPage(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("flypic") ?? "flypic"}>
            <plugin-entry-page
              bleed
              plugin-id=${pluginScopeOfTab("flypic") ?? "flypic"}
              entry=${pluginPageOfTab("flypic")?.entry ?? ""}
              .client=${state.client}
            ></plugin-entry-page>
          </div>`)
        : renderPluginDisabledPage(state, "flypic")
      : nothing}

        ${view === "droid-swarm"
      ? isTabAvailable("droid-swarm") && pluginPageOfTab("droid-swarm")?.entry
        ? (loadPluginEntryPage(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("droid-swarm") ?? "droid-swarm"}>
            <plugin-entry-page
              bleed
              plugin-id=${pluginScopeOfTab("droid-swarm") ?? "droid-swarm"}
              entry=${pluginPageOfTab("droid-swarm")?.entry ?? ""}
              .client=${state.client}
            ></plugin-entry-page>
          </div>`)
        : renderPluginDisabledPage(state, "droid-swarm")
      : nothing}

        ${view === "part-scan"
      ? isTabAvailable("part-scan")
        ? (loadPartScan(),
          html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("part-scan") ?? "part-scan"}>
            <part-scan-page .state=${state} .client=${state.client}></part-scan-page>
          </div>`)
        : renderPluginDisabledPage(state, "part-scan")
      : nothing}

        ${view === "plugins"
      ? (loadPluginsView(), html`<plugins-view .state=${state} .client=${state.client}></plugins-view>`)
      : nothing}

        ${view === "mesh"
      ? (loadAgentMesh(), html`<agent-mesh-page .state=${state} .client=${state.client}></agent-mesh-page>`)
      : nothing}




        ${state.tab === "vault" && state.client
      ? lazyVaultDashboard(
        (m) => m.renderVaultDashboard(state, state.client!),
        () => state.requestUpdate?.(),
      )
      : nothing}

        ${view === "ollama"
      ? (loadOllamaMonitor(),
        html`<ollama-command-center .client=${state.client}></ollama-command-center>`)
      : nothing}

        ${view === "focus" && state.client
      ? renderDisciplinePluginPage(state, "focus")
      : nothing}

        ${view === "files" && state.client
      ? lazyFiles((m) => m.renderFiles(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${state.tab === "workspace" && state.client && (isSaasMode() || isCloudBuild())
      ? renderSelfHostOnly({
        title: "Workspace runs on self-hosted InfiniBot",
        lead: "The Workspace studio starts dev servers and live previews from project folders, which needs to run programs on the machine. InfiniBot Cloud doesn't run those for workspaces yet.",
        points: [
          "Documents, Kanban, agents and chat work here as usual.",
          "Your coding agents can still work in your cloud workspace from Setup › Coders.",
          "Install InfiniBot on your own computer or server to use Workspace with live previews.",
        ],
        docsHref: "https://infinibotos.com/download",
      })
      : state.tab === "workspace" && state.client
      ? (() => {
        startWorkspacePolling(state, state.client);
        return lazyWorkspace((m) => m.renderWorkspace(state, state.client!), () => state.requestUpdate?.());
      })()
      : nothing}

        ${view === "directories" && state.client
      ? lazyDirectories((m) => m.renderDirectories(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "whiteboard" && state.client
      ? isTabAvailable("whiteboard")
        ? (() => { loadWhiteboardPlugin(); return html`<whiteboard-plugin-view .client=${state.client}></whiteboard-plugin-view>`; })()
        : renderPluginDisabledPage(state, "whiteboard")
      : nothing}
        ${view === "monsoon-studio"
      ? isTabAvailable("monsoon-studio")
        ? (() => { loadMonsoonStudioPlugin(); return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("monsoon-studio") ?? "monsoon-studio"}><monsoon-studio-view .client=${state.client}></monsoon-studio-view></div>`; })()
        : renderPluginDisabledPage(state, "monsoon-studio")
      : nothing}

        ${view === "projects" && state.client
      ? renderProjectsTab(state)
      : nothing}

        ${state.tab === "chat"
      ? renderChat({
        sessionKey: state.sessionKey,
        loadedSessionKey: (state as any).chatLoadedSessionKey ?? null,
        onSessionKeyChange: (next) => _switchChatSession(next),
        // Secure Mode composer switch: lane change = session-key change (the
        // draft is cleared by onSessionKeyChange; nothing is copied across).
        secureBusy: Boolean((state as any)._secureChatBusy),
        secureError: ((state as any)._secureChatError as string | null) ?? null,
        onSecureToggle: (on: boolean) => {
          void (async () => {
            const host = state as any;
            if (host._secureChatBusy) return;
            host._secureChatError = null;
            if (on) {
              host._secureChatBusy = true;
              state.requestUpdate?.();
              const ok = await ensureSecureMode();
              host._secureChatBusy = false;
              if (!ok) {
                host._secureChatError = getSecureState().error ?? "Secure Mode could not be turned on.";
                state.requestUpdate?.();
                return;
              }
            }
            const plan = planSecureLaneSwitch({
              toSecure: on,
              currentKey: state.sessionKey,
              lastSecureKey: readStoredKey(LAST_SECURE_SESSION_STORAGE_KEY),
              lastNormalKey: readStoredKey(LAST_NORMAL_SESSION_STORAGE_KEY),
              agentId: /^agent:([^:]+):/.exec(state.sessionKey ?? "")?.[1] ?? "main",
            });
            writeStoredKey(LAST_SECURE_SESSION_STORAGE_KEY, plan.rememberSecure);
            writeStoredKey(LAST_NORMAL_SESSION_STORAGE_KEY, plan.rememberNormal);
            _switchChatSession(plan.next ?? `agent:main:webchat-${Date.now().toString(36)}`);
          })();
        },
        thinkingLevel: state.chatThinkingLevel,
        showThinking,
        loading: state.chatLoading,
        sending: state.chatSending,
        compactionStatus: state.compactionStatus,
        assistantAvatarUrl: chatAvatarUrl,
        messages: state.chatMessages,
        toolMessages: state.chatToolMessages,
        stream: state.chatStream,
        streamStartedAt: state.chatStreamStartedAt,
        thinkingStartedAt: (state as any).chatThinkingStartedAt,
        draft: state.chatMessage,
        queue: state.chatQueue,
        connected: state.connected,
        canSend: state.connected,
        disabledReason: chatDisabledReason,
        error: state.lastError,
        sessions: state.sessionsResult,
        focusMode: chatFocus,
        onRefresh: () => {
          state.resetToolStream();
          return Promise.all([loadChatHistory(state), refreshChatAvatar(state)]);
        },
        onToggleFocusMode: () => {
          if (state.onboarding) return;
          state.applySettings({
            ...state.settings,
            chatFocusMode: !state.settings.chatFocusMode,
          });
        },
        onChatScroll: (event) => state.handleChatScroll(event),
        onDraftChange: (next) => (state.chatMessage = next),
        attachments: state.chatAttachments,
        onAttachmentsChange: (next) => (state.chatAttachments = next),
        onSend: () => state.handleSendChat(),
        canAbort: Boolean(state.chatRunId),
        onAbort: () => void state.handleAbortChat(),
        onQueueRemove: (id) => state.removeQueuedMessage(id),
        onNewSession: () => {
          // Create a new session in a new tab without destroying the current one
          const newKey = `agent:main:webchat-${Date.now().toString(36)}`;
          state.sessionKey = newKey;
          state.chatMessage = "";
          state.chatAttachments = [];
          state.chatStream = null;
          state.chatStreamStartedAt = null;
          (state as any).chatThinkingStartedAt = null;
          state.chatRunId = null;
          state.chatQueue = [];
          state.chatMessages = [];
          state.chatToolMessages = [];
          // Brand-new session — there's no history to fetch, so stamp the
          // loaded-key immediately and let the empty-state card render right
          // away instead of showing a skeleton during the (no-op) round-trip.
          (state as any).chatLoadedSessionKey = newKey;
          state.resetToolStream();
          state.resetChatScroll();
          state.applySettings({
            ...state.settings,
            sessionKey: newKey,
            lastActiveSessionKey: newKey,
          });
          void state.loadAssistantIdentity();
          void loadChatHistory(state);
          void refreshChatAvatar(state);
        },
        // Quick layout templates: create multiple blank sessions
        onCreateMultipleSessions: async (count: number) => {
          const created: string[] = [];
          for (let i = 0; i < count; i++) {
            const suffix = ["alpha", "beta", "gamma", "delta"][i] || String(i + 1);
            const newKey = `agent:main:webchat-${Date.now().toString(36)}-${suffix}`;
            created.push(newKey);
            // Optionally register the session with a label
            try {
              if (state.client && state.connected) {
                await state.client.request("sessions.patch", { 
                  key: newKey, 
                  label: `Session ${i + 1}`,
                  create: true
                });
              }
            } catch (e) {
              // Session will be created on first message anyway
            }
          }
          // Switch to the first created session
          if (created.length > 0) {
            state.sessionKey = created[0];
            state.chatMessage = "";
            state.chatAttachments = [];
            state.chatStream = null;
            state.chatStreamStartedAt = null;
            (state as any).chatThinkingStartedAt = null;
            state.chatRunId = null;
            state.chatQueue = [];
            state.chatMessages = [];
            state.chatToolMessages = [];
            state.resetToolStream();
            state.resetChatScroll();
            state.applySettings({
              ...state.settings,
              sessionKey: created[0],
              lastActiveSessionKey: created[0],
            });
            // Refresh sessions list to show new tabs
            await loadSessions(state as any);
            state.requestUpdate?.();
          }
        },
        // Session rename handler
        onSessionRename: async (key: string, newLabel: string) => {
          if (!state.client || !state.connected) return;
          try {
            await state.client.request("sessions.patch", { key, label: newLabel });
            // Refresh sessions list to show updated name
            await loadSessions(state as any);
          } catch (err) {
            console.error("Failed to rename session:", err);
          }
        },
        onRequestUpdate: () => state.requestUpdate?.(),
        // Session context (directory & project)
        sessionContext: loadSessionContext(state.sessionKey),
        sessionProjects: [] as SessionContextProject[],
        sessionProjectsLoading: false,
        onSessionContextChange: (ctx: SessionContextSettings) => {
          // Save and trigger re-render
          saveSessionContext(state.sessionKey, ctx);
          state.requestUpdate?.();
        },
        onBrowseDirectory: undefined, // TODO: could open file picker dialog if available
        // Sidebar props for tool output viewing
        sidebarOpen: state.sidebarOpen,
        sidebarContent: state.sidebarContent,
        sidebarError: state.sidebarError,
        splitRatio: state.splitRatio,
        onOpenSidebar: (content: string) => state.handleOpenSidebar(content),
        onCloseSidebar: () => state.handleCloseSidebar(),
        onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
        onMcpSetup: () => state.handleMcpSetup?.(true),
        assistantName: state.assistantName,
        assistantAvatar: state.assistantAvatar,
        onToggleThreadsSidebar: () => {
          state.threadsSidebarOpen = !state.threadsSidebarOpen;
        },
        // AI IDE Panel props
        aiIdeEnabled: state.settings.aiIdeEnabled !== false,
        aiIdeCollapsed: state.settings.aiIdeCollapsed ?? false,
        onAiIdeToggle: () => {
          state.applySettings({
            ...state.settings,
            aiIdeEnabled: !state.settings.aiIdeEnabled,
          });
        },
        onAiIdeCollapsedChange: (collapsed: boolean) => {
          state.applySettings({
            ...state.settings,
            aiIdeCollapsed: collapsed,
          });
        },
        // Video Mode props
        videoModeEnabled: state.videoModeEnabled,
        onToggleVideoMode: () => {
          state.videoModeEnabled = !state.videoModeEnabled;
        },
        onVideoFrame: (base64: string, mimeType: string) => {
          // Send video frame to session context (passive - no response)
          if (state.client && state.connected) {
            sendVideoFrame(state as any, base64, mimeType);
          }
        },
        // Gateway for subagent monitoring
        gateway: state.client,
        // Model selector props
        availableModels: (state as any).availableModels ?? [],
        onModelChange: async (sessionKey: string, modelId: string) => {
          if ((state as any).patchSessionModel) {
            await (state as any).patchSessionModel(sessionKey, modelId);
            state.requestUpdate?.();
          }
        },
      })
      : nothing}

        ${state.tab === "chat" ? renderEnhancedThreadsSidebar({
          sessions: state.sessionsResult,
          currentSessionKey: state.sessionKey,
          visible: state.threadsSidebarOpen,
          sidebarState: state.sidebarCategoriesState || initializeSidebarState(state.sessionsResult),
          onSidebarStateChange: (newState) => {
            state.sidebarCategoriesState = newState;
          },
          onSwitchSession: (key) => {
            state.chatMessage = "";
            state.chatAttachments = [];
            (state as any).chatThinkingStartedAt = null;
            state.chatQueue = [];
            state.resetToolStream();
            state.resetChatScroll();
            state.threadsSidebarOpen = false;
            switchChatSession(state, key);
            state.applySettings({
              ...state.settings,
              sessionKey: key,
              lastActiveSessionKey: key,
            });
            void state.loadAssistantIdentity();
            void refreshChatAvatar(state);
          },
          onNewSession: () => {
            const newKey = `agent:main:webchat-${Date.now().toString(36)}`;
            state.sessionKey = newKey;
            state.chatMessage = "";
            state.chatAttachments = [];
            state.chatStream = null;
            state.chatStreamStartedAt = null;
            (state as any).chatThinkingStartedAt = null;
            state.chatRunId = null;
            state.chatQueue = [];
            state.chatMessages = [];
            state.chatToolMessages = [];
            (state as any).chatLoadedSessionKey = newKey;
            state.resetToolStream();
            state.resetChatScroll();
            state.threadsSidebarOpen = false;
            state.applySettings({
              ...state.settings,
              sessionKey: newKey,
              lastActiveSessionKey: newKey,
            });
            void state.loadAssistantIdentity();
            void loadChatHistory(state);
            void refreshChatAvatar(state);
          },
          onCreateMultipleSessions: async (count: number) => {
            const created: string[] = [];
            for (let i = 0; i < count; i++) {
              const suffix = ["alpha", "beta", "gamma", "delta"][i] || String(i + 1);
              const newKey = `agent:main:webchat-${Date.now().toString(36)}-${suffix}`;
              created.push(newKey);
            }
            if (created.length > 0) {
              state.sessionKey = created[0];
              state.chatMessage = "";
              state.chatAttachments = [];
              state.chatStream = null;
              state.chatStreamStartedAt = null;
              (state as any).chatThinkingStartedAt = null;
              state.chatRunId = null;
              state.chatQueue = [];
              state.chatMessages = [];
              state.chatToolMessages = [];
              state.resetToolStream();
              state.resetChatScroll();
              state.threadsSidebarOpen = false;
              state.applySettings({
                ...state.settings,
                sessionKey: created[0],
                lastActiveSessionKey: created[0],
              });
              await loadSessions(state as any);
              state.requestUpdate?.();
            }
          },
          onDeleteSession: async (key) => {
            try {
              await state.client?.request("sessions.delete", { key, deleteTranscript: true });
              await loadSessions(state);
            } catch (err) {
              console.error("Failed to delete session:", err);
            }
          },
          onClose: () => {
            state.threadsSidebarOpen = false;
          },
          onRefresh: () => {
            void loadSessions(state);
          },
        }) : nothing}

        ${state.tab === "grid" && state.client
      ? (() => {
        // Lazy-load masonry-grid (and its Pixi/Three transitive deps) on first visit.
        // For wall windows that never open /grid this import never fires, so
        // pixi-vendor.js stays out of their heap entirely.
        if (!(globalThis as any).__masonryGridLoaded) {
          (globalThis as any).__masonryGridLoaded = true;
          void import("./views/masonry-grid.js").then(() => state.requestUpdate?.());
        }
        // Initialize masonry grid state if needed
        if (!state.masonryGridState) {
          state.masonryGridState = createMasonryGridState();
        }

        return html`
          <masonry-grid
            .gridState=${state.masonryGridState}
            .client=${state.client}
            .sessions=${state.sessionsResult}
            .availableModels=${(state as any).availableModels ?? []}
            .appState=${state}
            @grid-state-change=${(e: CustomEvent) => {
              state.masonryGridState = e.detail;
              state.requestUpdate?.();
            }}
            @add-panel-request=${() => {
              // Show session picker or create new session
              const newKey = "agent:main:webchat-" + Date.now().toString(36);
              state.masonryGridState = addPanel(
                state.masonryGridState!,
                newKey,
                "New Chat"
              );
              state.requestUpdate?.();
            }}
            @refresh-sessions=${() => {
              void loadSessions(state);
            }}
            @session-message=${async (e: CustomEvent) => {
              const { sessionKey, message } = e.detail;
              try {
                await state.client?.request("session.send", {
                  sessionKey,
                  message,
                });
              } catch (err) {
                console.error("Failed to send message:", err);
              }
            }}
            @fullscreen-change=${(e: CustomEvent) => {
              const { fullscreen } = e.detail;
              (state as any).gridFullscreen = fullscreen;
              state.requestUpdate?.();
            }}
            @request-app-update=${() => {
              // Bubbled from chat panels when they trigger an app-level
              // modal (e.g. /skill picker). Just nudges the host to repaint
              // so the global modal mount picks up its new open flag.
              state.requestUpdate?.();
            }}
          ></masonry-grid>
        `;
      })()
      : nothing}

        ${view === "setup" && state.client
      ? lazySetupView((m) => m.renderSetup(state, state.client!), () => state.requestUpdate?.())
      : nothing}

        ${view === "federation" && state.client
      ? (() => {
          // Initialize federation state if not present
          if (!state.federationState) {
            state.federationState = createFederationState();
            // Load federation data
            void loadFederationState(state.client, state.federationState, () => state.requestUpdate?.());
          }
          return renderFederationTab(state as AppViewState & FederationViewState);
        })()
      : nothing}

        ${(state.tab as string) === "file-transfer" && state.client
      ? (() => {
          const ftState = (state as AppViewState & { fileTransferState?: FileTransferState });
          if (!ftState.fileTransferState) {
            ftState.fileTransferState = createFileTransferState();
            void loadFileTransferData(state.client, ftState.fileTransferState, () => state.requestUpdate?.());
          }
          const s = ftState.fileTransferState;
          const client = state.client;
          return renderFederationFileTransfer({
            state: s,
            client,
            onRefresh: () => {
              void loadFileTransferData(client, s, () => state.requestUpdate?.());
            },
            onSendFile: (filePath, toNodes) => {
              void ftSendFile(client, s, filePath, toNodes, () => state.requestUpdate?.());
            },
            onPause: (id) => void ftPause(client, s, id, () => state.requestUpdate?.()),
            onResume: (id) => void ftResume(client, s, id, () => state.requestUpdate?.()),
            onCancel: (id) => void ftCancel(client, s, id, () => state.requestUpdate?.()),
            onTogglePeer: (peerId) => { ftTogglePeer(s, peerId); state.requestUpdate?.(); },
            onDragOver: (val) => { ftSetDragOver(s, val); state.requestUpdate?.(); },
            onFileDrop: (filePath) => {
              s.pendingFile = { name: filePath.split("/").pop() ?? filePath, path: filePath, size: 0 };
              state.requestUpdate?.();
            },
            onFileChoose: () => {},
            onTabChange: (tab) => { s.activeTab = tab; state.requestUpdate?.(); },
            requestUpdate: () => state.requestUpdate?.(),
          });
        })()
      : nothing}

        ${view === "config"
      ? (() => {
        // Lazy-load system roles the first time Config opens so the card
        // doesn't show empty dropdowns until Databases is visited.
        if (state.client && !configSystemRolesLoaded) {
          configSystemRolesLoaded = true;
          void loadSystemRoles(state, state.client);
        }
        return html`
          <div class="config-with-system-card">
            ${state.client ? html`
              <div class="system-db-slot">
                ${renderSystemDatabasesCard(state, state.client, { mode: "full" })}
              </div>
            ` : nothing}
            ${renderConfig({
              raw: state.configRaw,
              originalRaw: state.configRawOriginal,
              valid: state.configValid,
              issues: state.configIssues,
              loading: state.configLoading,
              saving: state.configSaving,
              applying: state.configApplying,
              updating: state.updateRunning,
              connected: state.connected,
              schema: state.configSchema,
              schemaLoading: state.configSchemaLoading,
              uiHints: state.configUiHints,
              formMode: state.configFormMode,
              formValue: state.configForm,
              originalValue: state.configFormOriginal,
              searchQuery: state.configSearchQuery,
              activeSection: state.configActiveSection,
              activeSubsection: state.configActiveSubsection,
              onRawChange: (next) => {
                state.configRaw = next;
              },
              onFormModeChange: (mode) => (state.configFormMode = mode),
              onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
              onSearchChange: (query) => (state.configSearchQuery = query),
              onSectionChange: (section) => {
                state.configActiveSection = section;
                state.configActiveSubsection = null;
              },
              onSubsectionChange: (section) => (state.configActiveSubsection = section),
              onReload: () => loadConfig(state),
              onSave: () => saveConfig(state),
              onApply: () => applyConfig(state),
              onUpdate: () => runUpdate(state),
            })}
          </div>
        `;
      })()
      : nothing}

        ${view === "apikeys"
      ? (() => {
          if (!state.apiKeysState) {
            state.apiKeysState = createInitialApiKeysState();
          }
          return renderApiKeys({
            state: state.apiKeysState,
            onRefresh: () => {
              if (state.client) {
                loadApiKeys(state, state.client);
              }
            },
            onFilterChange: (filter) => {
              if (state.apiKeysState) {
                state.apiKeysState.filter = filter;
                state.requestUpdate?.();
              }
            },
            onShowAddDialog: () => {
              if (state.apiKeysState) {
                state.apiKeysState.showAddDialog = true;
                state.requestUpdate?.();
              }
            },
            onHideAddDialog: () => {
              if (state.apiKeysState) {
                state.apiKeysState.showAddDialog = false;
                state.apiKeysState.addForm = { provider: "", profileName: "default", key: "", email: "" };
                state.requestUpdate?.();
              }
            },
            onFormChange: (field, value) => {
              if (state.apiKeysState) {
                (state.apiKeysState.addForm as Record<string, string>)[field] = value;
                state.requestUpdate?.();
              }
            },
            onSaveKey: () => {
              if (state.client && state.apiKeysState) {
                const form = state.apiKeysState.addForm;
                upsertApiKey(state, state.client, {
                  provider: form.provider,
                  profileName: form.profileName,
                  key: form.key,
                  email: form.email || undefined,
                });
              }
            },
            onDeleteKey: (profileId) => {
              if (state.client) {
                deleteApiKey(state, state.client, profileId);
              }
            },
            onTestKey: (profileId) => {
              if (state.client) {
                testApiKey(state, state.client, profileId);
              }
            },
            onSelectProfile: (profileId) => {
              if (state.apiKeysState) {
                state.apiKeysState.selectedProfileId = profileId;
                state.requestUpdate?.();
              }
            },
          });
        })()
      : nothing}


        ${view === "debug"
      ? renderDebug({
        loading: state.debugLoading,
        status: state.debugStatus,
        health: state.debugHealth,
        models: state.debugModels,
        heartbeat: state.debugHeartbeat,
        eventLog: state.eventLog,
        callMethod: state.debugCallMethod,
        callParams: state.debugCallParams,
        callResult: state.debugCallResult,
        callError: state.debugCallError,
        onCallMethodChange: (next) => (state.debugCallMethod = next),
        onCallParamsChange: (next) => (state.debugCallParams = next),
        onRefresh: () => loadDebug(state),
        onCall: () => callDebugMethod(state),
      })
      : nothing}

        ${view === "logs"
      ? renderLogs({
        loading: state.logsLoading,
        error: state.logsError,
        file: state.logsFile,
        entries: state.logsEntries,
        filterText: state.logsFilterText,
        levelFilters: state.logsLevelFilters,
        autoFollow: state.logsAutoFollow,
        truncated: state.logsTruncated,
        onFilterTextChange: (next) => (state.logsFilterText = next),
        onLevelToggle: (level, enabled) => {
          state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
        },
        onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
        onRefresh: () => loadLogs(state, { reset: true }),
        onExport: (lines, label) => state.exportLogs(lines, label),
        onScroll: (event) => state.handleLogsScroll(event),
      })
      : nothing}
      </main>
      ${/* Robovoice call running while you're on another page: one tap back. */
        robovoiceCallLive() && !voiceTabShown
          ? html`<rv-call-dock .client=${state.client} @call-return=${() => state.setTab("voice")}></rv-call-dock>`
          : nothing}
      ${/* Task sidebar disabled - was causing visibility issues on grid
      renderTaskSidebar(state, state.client)
      */ nothing}
      ${renderExecApprovalPrompt(state)}
      <change-notion-db-host></change-notion-db-host>
      <email-composer-host></email-composer-host>
      <!-- Live Action Toast: top-left pill that narrates every agent
           UI-control action. Always mounted; the component itself decides
           whether to render based on the lifecycle events it receives
           from UIControlBus. Side-effect free when idle. -->
      <live-action-toast></live-action-toast>
      <!-- Plan-limit upgrade dialog (hosted tenants): opens on the gateway's
           plan.limit event, e.g. a spawn refused at the agent cap. -->
      <plan-limit-modal></plan-limit-modal>
      <!-- App-wide Proactive Overlay: one global host so pop-ups surface on
           every route (grid / chat / agents / voice / …), not just dashboard. -->
      <proactive-overlay-host .client=${state.client}></proactive-overlay-host>
      <!-- App-wide agent chat panels: show_panel(display:"modal") and inline
           card "Expand" open live panel modals from any surface. -->
      <chat-panel-host .client=${state.client}></chat-panel-host>
      <kv-connect-approval .client=${state.client}></kv-connect-approval>
      <!-- Universal agent chat modal (topbar Chat button), reachable on every
           route (⌘⇧M / window.agentChat.open({ agentId })). -->
      <agent-chat-modal .client=${state.client}></agent-chat-modal>
      <!-- Phones: the agent moved you off the chat → floating "Back to chat". -->
      <chat-follow-pill .client=${state.client}></chat-follow-pill>
      ${renderActivityPanel(state, state.client)}
      ${renderNotificationOverlay(state)}
      ${renderSaveToProjectModal()}
      ${state.client ? renderBrandingModal(state, state.client) : nothing}
      <!-- Unified modal + card system. initModalService is idempotent — safe
           to call every render pass; it keeps the facade's gateway client +
           re-render callback current so agents / devtools / views can call
           openProjectModal(id) etc. All four render funcs are template-gated
           by their own module-level _open flag, so they cost nothing when
           closed. -->
      ${state.client
        ? (initModalService(state.client, () => state.requestUpdate?.()), nothing)
        : nothing}
      ${renderProjectDetailModal(state)}
      ${renderClientDetailModal(state)}
      ${renderTaskDetailModal(state)}
      ${renderPortfolioModal(state)}
      ${(() => {
        // Subagent detail modal: globally mounted so clicks on subagent
        // cards from any view (Activity page top section, Activity dashboard
        // grid, Chat page sub-agent strip) all surface here. The bridge
        // listener that turns "infinibot:subagent-open-detail" CustomEvents
        // into open-modal calls is idempotent.
        if (state.client) {
          mountSubagentDetailListener(state.client, () => state.requestUpdate?.());
          // Robust gamified mesh-click inspector. Registers window.openAgentFocus
          // + the "infinibot:open-agent-focus" bridge + dev hotkey (Ctrl+Shift+A).
          // Once agency-world-viz is updated it should call window.openAgentFocus(agent).
          mountAgentFocusModal(state.client, () => state.requestUpdate?.());
          // "Agent profile" in the inspector → Agents page drawer (lib/agents-drawer-intent).
          mountAgentsDrawerIntent(() => {
            state.setTab?.("agents" as never);
            state.requestUpdate?.();
          });
          // Wire kanban deep-link: clicking "Open in Kanban" / a task row in the
          // sub-agent modal switches to the projects tab + opens the project.
          mountLazyKanbanDeepLink((projectId) => {
            if (projectId) {
              state.kanbanSelectedProjectId = projectId;
              state.kanbanGalleryView = false;
            }
            state.setTab?.("projects" as never);
            state.requestUpdate?.();
          });
        }
        return isSubagentDetailOpen() && state.client
          ? renderSubagentDetailModal(state, state.client)
          : nothing;
      })()}
      ${(() => {
        // Global Browse Skills modal — mounted here so /grid chat panels
        // (and any other tab) can call `openSkillsBrowseModal()` and have
        // the modal pop over the current view without each tab owning the
        // data plumbing. Hands the same handler set the /skills page uses,
        // so install / toggle / save-key all work identically.
        return renderSkillsBrowseModalGlobal({
          loading: state.skillsLoading,
          report: state.skillsReport,
          error: state.skillsError,
          filter: state.skillsFilter,
          edits: state.skillEdits,
          messages: state.skillMessages,
          busyKey: state.skillsBusyKey,
          onFilterChange: (next) => (state.skillsFilter = next),
          onRefresh: () => loadSkills(state, { clearMessages: true }),
          onToggle: (key, enabled) => updateSkillEnabled(state, key, enabled),
          onEdit: (key, value) => updateSkillEdit(state, key, value),
          onSaveKey: (key) => saveSkillApiKey(state, key),
          onInstall: (skillKey, name, installId) =>
            installSkill(state, skillKey, name, installId),
          learnedSkills: state.learnedSkills,
          learnedLoading: state.learnedLoading,
          learnedError: state.learnedError,
          learnedEnabled: state.learnedSkillsEnabled,
          learnedSelfImproveRunning: state.learnedSelfImproveRunning,
          learnedSelfImproveSummary: state.learnedSelfImproveSummary,
          onLearnedRefresh: () => loadLearnedSkills(state),
          onLearnedDelete: (key) => deleteLearnedSkill(state, key),
          onLearnedSelfImprove: () => runLearnedSelfImprove(state),
          rerender: () => state.requestUpdate?.(),
        });
      })()}
      ${state.client && state.autopilotState
        ? html`
            <agent-chat-sidebar
              .autopilot=${state.autopilotState}
              .client=${state.client}
              .tab=${state.tab}
              .sessionKey=${state.sessionKey}
              @autopilot-change=${() => state.requestUpdate?.()}
            ></agent-chat-sidebar>
          `
        : nothing}
      ${/* Learn missions panel — self-contained (localStorage-backed) and
            closed by default; its trigger is the graduation-cap button in the
            topbar (<learn-topbar-button>). Records the touched tab so the
            missions controller can recommend the right "next" walkthrough. */ (() => {
        try {
          markLearnTouched(state.tab);
        } catch {
          /* non-fatal */
        }
        return html`<learn-missions-panel></learn-missions-panel>`;
      })()}
      <agent-overlay-layer .gateway=${state.client}></agent-overlay-layer>
    </div>
  `;
}

// ============================================
// PROJECTS / KANBAN / DATABASES TAB
// ============================================

let kanbanInitialized = false;
let autonomyInitialized = false;
let autonomyPollTimer: number | null = null;
const autonomyActivityInFlight = new Set<string>();

async function loadAutonomyActivity(
  state: AppViewState,
  taskId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!state.client || !taskId) return;
  if (autonomyActivityInFlight.has(taskId)) return;
  const auto = state.autonomyState;
  if (!auto) return;
  const existing = auto.taskActivity?.[taskId];
  // Throttle: don't re-fetch the same task more than once every 1.5s unless
  // the caller forces it. Keeps the 3s poll cheap when several callers fire.
  if (!opts.force && existing && Date.now() - (existing.loadedAt ?? 0) < 1500) return;
  autonomyActivityInFlight.add(taskId);
  try {
    if (!auto.taskActivity) auto.taskActivity = {};
    auto.taskActivity[taskId] = {
      ...(existing ?? { taskId, entries: [], loadedAt: Date.now() }),
      loading: true,
    };
    const result = await fetchTaskActivity(state.client, taskId);
    if (result) {
      auto.taskActivity[taskId] = { ...result, loading: false };
      state.requestUpdate?.();
    } else if (existing) {
      // Gateway hiccup — keep prior entries, just clear loading.
      auto.taskActivity[taskId] = { ...existing, loading: false };
    }
  } finally {
    autonomyActivityInFlight.delete(taskId);
  }
}

function startAutonomyPolling(state: AppViewState): void {
  if (autonomyPollTimer != null) return;
  autonomyPollTimer = window.setInterval(async () => {
    if (state.tab !== 'autonomy' || !state.client) {
      stopAutonomyPolling();
      return;
    }
    try {
      const update = await loadAutonomyStatus(state.client);
      state.autonomyState = { ...(state.autonomyState || createAutonomyState()), ...update };
      const runningId = state.autonomyState.runningTask?.id;
      const selectedId = state.autonomyState.selectedTaskId;
      const ids = [runningId, selectedId].filter((x): x is string => !!x);
      for (const id of ids) void loadAutonomyActivity(state, id);
      state.requestUpdate?.();
    } catch {
      /* swallow — next tick retries */
    }
  }, 3000);
}

function stopAutonomyPolling(): void {
  if (autonomyPollTimer != null) {
    window.clearInterval(autonomyPollTimer);
    autonomyPollTimer = null;
  }
}

/*
 * /focus — the full-screen priority board.
 *
 * The Focus *controller* was already live (views/dashboard-kanban-card.ts reads
 * getFocusProjectIds()), only the board itself was unmounted. It shares the
 * same kanban source as /projects, so it reuses `kanbanInitialized` and the
 * loadKanban() fetch rather than pulling the board twice.
 *
 * The controller is pure/immutable — every mutator returns a fresh FocusState —
 * so each handler reassigns the slot on `state` and asks for a repaint.
 */
let focusHydrated = false;

function renderFocusTab(state: AppViewState) {
  const anyState = state as unknown as { focusState?: FocusState };
  if (!anyState.focusState) anyState.focusState = focusCtl.createFocusState();

  if (!kanbanInitialized && state.client) {
    kanbanInitialized = true;
    void loadKanban(state).then(() => state.requestUpdate?.());
  }
  // Discipline plugin keeps the board server-side too (discipline.focus.*).
  if (!focusHydrated && state.client) {
    focusHydrated = true;
    void focusCtl.hydrateFocusFromServer(state.client).then((items) => {
      if (!items || !anyState.focusState) return;
      anyState.focusState = { ...anyState.focusState, items };
      state.requestUpdate?.();
    });
  }

  const update = (next: FocusState) => {
    anyState.focusState = next;
    state.requestUpdate?.();
  };
  const focusState = anyState.focusState;

  return lazyFocus(
    (m) =>
      m.renderFocus({
        state: focusState,
        tasks: state.kanbanTasks,
        projects: state.kanbanProjects,
        loading: state.kanbanLoading,
        error: state.kanbanError,
        onAddToFocus: (item, type) =>
          update(focusCtl.addToFocus(focusState, item, type, state.kanbanProjects)),
        onRemoveFromFocus: (itemId) => update(focusCtl.removeFromFocus(focusState, itemId)),
        onReorder: (from, to) => update(focusCtl.reorderFocus(focusState, from, to)),
        onDragStart: (item) => update(focusCtl.setDraggedItem(focusState, item)),
        onDragEnd: () => update(focusCtl.setDraggedItem(focusState, null)),
        onDragOver: (index) => update(focusCtl.setDragOverIndex(focusState, index)),
        onToggleSource: () => update(focusCtl.toggleSourceCollapsed(focusState)),
        onSourceFilter: (filter) => update(focusCtl.setSourceFilter(focusState, filter)),
        onSourceSearch: (search) => update(focusCtl.setSourceSearch(focusState, search)),
        onSourceViewChange: (view) => update(focusCtl.setSourceView(focusState, view)),
        onSourceKanbanProjectChange: (projectId) =>
          update(focusCtl.setSourceKanbanProject(focusState, projectId)),
        onClearFocus: () => update(focusCtl.clearFocus(focusState)),
        onRefresh: () => {
          void loadKanban(state).then(() => {
            update(focusCtl.syncFocusWithKanban(focusState, state.kanbanTasks, state.kanbanProjects));
          });
        },
        onOpenTask: (taskId) => {
          window.dispatchEvent(
            new CustomEvent("infinibot:kanban-open-task", { detail: { taskId } }),
          );
        },
      }),
    () => state.requestUpdate?.(),
  );
}

function renderProjectsTab(state: AppViewState) {
  const client = state.client!;

  if (!kanbanInitialized && state.client) {
    kanbanInitialized = true;
    void loadKanban(state).then(() => state.requestUpdate?.());
  }

  // Deep-link: a pasted /projects/:slug (or /tasks/:slug) URL auto-opens the
  // addressed entity once the store is available. resolveSlug recovers the id
  // from the embedded slug even before the store loads.
  const dlHost = state as unknown as Parameters<typeof consumeDeepLink>[0];
  const projectRef = consumeDeepLink(
    dlHost,
    "project",
    state.kanbanProjects.map((p) => ({ id: p.id, name: p.name })),
  );
  if (projectRef?.id) {
    state.kanbanSelectedProjectId = projectRef.id;
    state.kanbanGalleryView = false;
    // A project deep-link supersedes any pinned task page.
    state.kanbanOpenTaskId = null;
  } else {
    const taskRef = consumeDeepLink(
      dlHost,
      "task",
      state.kanbanTasks.map((tk) => ({ id: tk.id, name: tk.title ?? tk.id })),
    );
    if (taskRef?.id) {
      // Open the full-page task view. Also select the parent project so the
      // page's "back" affordance returns to the right board.
      state.kanbanOpenTaskId = taskRef.id;
      const parent = state.kanbanTasks.find((tk) => tk.id === taskRef.id)?.projectId;
      if (parent) {
        state.kanbanSelectedProjectId = parent;
        state.kanbanGalleryView = false;
      }
    }
  }

  const projectSlug = (id: string): string => {
    const p = state.kanbanProjects.find((pr) => pr.id === id);
    return slugify(p?.name ?? "", id);
  };
  const taskSlug = (id: string): string => {
    const t = state.kanbanTasks.find((tk) => tk.id === id);
    return slugify(t?.title ?? "", id);
  };

  const props: KanbanViewProps = {
    loading: state.kanbanLoading,
    refreshing: state.kanbanRefreshing ?? false,
    projects: state.kanbanProjects,
    tasks: state.kanbanTasks,
    error: state.kanbanError,
    selectedProjectId: state.kanbanSelectedProjectId,
    galleryView: state.kanbanGalleryView,
    openTaskId: state.kanbanOpenTaskId,
    // Read the live values from state so the Tasks / AI Projects toggle and
    // the search/sort dropdowns retain their selection across re-renders.
    galleryFilter: state.kanbanGalleryFilter ?? "all",
    gallerySearch: state.kanbanGallerySearch ?? "",
    gallerySort: state.kanbanGallerySort ?? "recent",
    selectedTaskId: null,
    onCreateTask: (task) => {
      void kanbanCreateTask(state, task).then(() => state.requestUpdate?.());
    },
    onCreateProject: (project) => {
      void kanbanCreateProject(state, project).then(() => state.requestUpdate?.());
    },
    onUpdateTask: (id, patch) => {
      void kanbanUpdateTask(state, id, patch).then(() => state.requestUpdate?.());
    },
    onDeleteTask: (id) => {
      void kanbanDeleteTask(state, id).then(() => state.requestUpdate?.());
    },
    onDeleteProject: (id) => {
      void kanbanDeleteProject(state, id).then(() => state.requestUpdate?.());
    },
    onRefresh: () => {
      void loadKanban(state).then(() => state.requestUpdate?.());
    },
    onSelectProject: (id) => {
      state.kanbanSelectedProjectId = id;
      state.kanbanGalleryView = false;
      state.kanbanOpenTaskId = null;
      pushEntityUrl(dlHost, "project", projectSlug(id), "projects");
      state.requestUpdate?.();
    },
    onOpenTaskPage: (id) => {
      state.kanbanOpenTaskId = id;
      // Pin the parent project so the task page's back button and the
      // background board context resolve correctly.
      const parent = state.kanbanTasks.find((tk) => tk.id === id)?.projectId;
      if (parent) {
        state.kanbanSelectedProjectId = parent;
        state.kanbanGalleryView = false;
      }
      pushEntityUrl(dlHost, "task", taskSlug(id), "projects");
      state.requestUpdate?.();
    },
    onCloseTaskPage: () => {
      const parent = state.kanbanOpenTaskId
        ? state.kanbanTasks.find((tk) => tk.id === state.kanbanOpenTaskId)?.projectId
        : null;
      state.kanbanOpenTaskId = null;
      if (parent) {
        state.kanbanSelectedProjectId = parent;
        state.kanbanGalleryView = false;
        pushEntityUrl(dlHost, "project", projectSlug(parent), "projects");
      } else {
        state.kanbanGalleryView = true;
        state.kanbanSelectedProjectId = null;
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.pathname = pathForTab("projects", state.basePath);
          window.history.pushState({}, "", url.toString());
        }
      }
      state.requestUpdate?.();
    },
    onUpdateProject: (id, patch) => {
      void kanbanUpdateProject(state, id, patch).then(() => state.requestUpdate?.());
    },
    onSelectTask: () => {
      // task-detail panel is managed internally by the view
      state.requestUpdate?.();
    },
    onEnterProject: (id) => {
      state.kanbanSelectedProjectId = id;
      state.kanbanGalleryView = false;
      state.kanbanOpenTaskId = null;
      pushEntityUrl(dlHost, "project", projectSlug(id), "projects");
      state.requestUpdate?.();
    },
    onBackToGallery: () => {
      state.kanbanGalleryView = true;
      state.kanbanSelectedProjectId = null;
      state.kanbanOpenTaskId = null;
      // Return the URL to the plain /projects list so Back/Forward stays sane.
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.pathname = pathForTab("projects", state.basePath);
        window.history.pushState({}, "", url.toString());
      }
      state.requestUpdate?.();
    },
    // The kanban view fires these with the new value as the only argument,
    // but the previous handlers ignored it, so the pill clicks (Tasks /
    // AI Projects / Active / Completed / Paused) and the search + sort
    // selects appeared to do nothing. Persist the value into state so it
    // survives the next render pass.
    onGalleryFilterChange: (filter: string) => {
      state.kanbanGalleryFilter = filter ?? "all";
      state.requestUpdate?.();
    },
    onGallerySearchChange: (search: string) => {
      state.kanbanGallerySearch = search ?? "";
      state.requestUpdate?.();
    },
    onGallerySortChange: (sort: string) => {
      state.kanbanGallerySort = sort ?? "recent";
      state.requestUpdate?.();
    },
    onRequestUpdate: () => state.requestUpdate?.(),
    client: state.client,
    // Surface the loaded businesses so the project edit dialog can offer a
    // "Linked business" picker. We map to a tiny shape so the kanban view
    // doesn't have to import the full BusinessProfile type.
    businesses: (state.businessState?.businesses ?? []).map((b) => ({
      id: b.id,
      name: b.name,
    })),
    // Pass the selected agency ID so the invoice picker and linked-client
    // picker can scope their CRM queries. Fall back to the active business so
    // the scope is present even when the agency-ops view was never opened
    // (otherwise the client picker queries the empty "default" agency).
    agencyId:
      (state as any).agencyOperationsState?.selectedAgencyId ??
      state.businessState?.activeBusinessId ??
      undefined,
  };

  // Secure Mode: the header toggle swaps the whole board for the encrypted
  // secure board (secure.kanban.*); off → the normal board, untouched.
  const secureOn = secureActive(getSecureState());
  return html`
    <div style="display:flex;flex-direction:column;height:100%;">
      <div class="ib-secure-strip" data-secure-strip="kanban">
        ${secureOn ? html`<span class="ib-secure-strip__title">${icons.lock}<span>Secure board</span></span>` : nothing}
        <ib-secure-toggle data-secure-surface="kanban"></ib-secure-toggle>
      </div>
      ${secureOn
        ? html`<ib-secure-board style="flex:1;min-height:0;"></ib-secure-board>`
        : lazyKanban((m) => m.renderKanban(props), () => state.requestUpdate?.())}
    </div>
  `;
}

/**
 * A plugin-gated page whose plugin isn't loaded: say which plugin owns it and
 * link to Setup › Plugins instead of rendering a view whose RPCs don't exist.
 */
function renderPluginDisabledPage(state: AppViewState, tab: string) {
  const owner = pluginOwnerOfTab(tab);
  const synced = isPluginHostSynced();
  const name = owner?.pluginName ?? tab;
  // Paid plugin without its entitlement: an upsell, not "turn it on".
  const access = owner?.access;
  if (owner && access && !access.loadable) {
    const openDetail = () => {
      state.setTab("plugins" as Tab);
      setTimeout(() => window.dispatchEvent(new CustomEvent("infinibot:plugins-open", { detail: { plugin: owner.pluginId } })), 60);
    };
    return html`
      <section class="card plugin-disabled-page plugin-locked-page" data-plugin-locked=${owner.pluginId} style="box-sizing:border-box;width:calc(100% - 24px);max-width:600px;margin:48px auto;padding:30px clamp(18px,4vw,28px);text-align:center;border:1px solid color-mix(in srgb, var(--accent, #fbbf24) 45%, transparent);background:radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, var(--accent, #fbbf24) 14%, transparent), transparent 60%), var(--card, #0b0b0b);">
        <div aria-hidden="true" style="width:48px;height:48px;margin:0 auto 14px;border-radius:14px;display:grid;place-items:center;color:#0a0a0a;background:linear-gradient(135deg,#fde68a,#fbbf24 55%,#d97706);">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        </div>
        <div class="card-title" style="margin-bottom:8px;">Unlock ${name}</div>
        <div class="card-sub" style="margin-bottom:18px;">${access.reason ?? ""}</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
          <button class="btn primary" data-locked-buy=${owner.pluginId} @click=${openDetail}>${access.price ? `Buy · ${access.price.label}` : "Buy"}</button>
          <button class="btn" @click=${openDetail}>See what ${name} adds</button>
        </div>
      </section>
    `;
  }
  return html`
    <section class="card plugin-disabled-page" data-plugin-disabled=${tab} style="max-width:560px;margin:48px auto;padding:28px;text-align:center;">
      <div class="card-title" style="margin-bottom:8px;">
        ${synced ? (owner ? `${name} is turned off` : `${name} isn't installed`) : "Checking plugins…"}
      </div>
      <div class="card-sub" style="margin-bottom:18px;">
        ${owner
          ? html`This page comes from the <strong>${name}</strong> plugin. Turn it on in Plugins to use it.`
          : html`This page comes from a plugin that isn't installed on this gateway.`}
      </div>
      <button class="btn primary" @click=${() => state.setTab("plugins" as Tab)}>Open Plugins</button>
    </section>
  `;
}

/**
 * Discipline plugin pages (Day + Focus board; extensions/discipline). The
 * views stay compiled into the control UI, but render only while the plugin
 * is loaded — otherwise the "turned off" card. Legacy /discipline and /focus
 * URLs keep working either way.
 */
function renderDisciplinePluginPage(state: AppViewState, tab: "discipline" | "focus") {
  if (!isTabAvailable(tab)) return renderPluginDisabledPage(state, tab);
  const page =
    tab === "focus"
      ? renderFocusTab(state)
      : lazyRenderDiscipline(state, state.client!, () => state.requestUpdate?.());
  return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(tab) ?? "discipline"}>${page}</div>`;
}

/**
 * Content Studio plugin pages (extensions/content-studio): the studio shell
 * (pipeline board, Ideas, Channels = the content-pages hub) and Content ›
 * Intelligence. Plugin-gated: off → the "turned off" card.
 */
function renderContentStudioPage(state: AppViewState, tab: "content-pages" | "content-intel") {
  if (!isTabAvailable(tab)) return renderPluginDisabledPage(state, tab);
  const page =
    tab === "content-intel"
      ? (loadContentIntel(), html`<content-intel-view></content-intel-view>`)
      : state.client
        ? (loadContentPages(), html`<content-studio-shell .client=${state.client}></content-studio-shell>`)
        : nothing;
  return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(tab) ?? "content-studio"}>${page}</div>`;
}

/**
 * Community Manager plugin page (extensions/community-manager): dashboard,
 * with the setup wizard at /community?step=<n>. Plugin-gated: off → the
 * "turned off" card.
 */
function renderCommunityPage(state: AppViewState) {
  if (!isTabAvailable("community")) return renderPluginDisabledPage(state, "community");
  const page = state.client
    ? (loadCommunity(), html`<community-manager-shell .client=${state.client}></community-manager-shell>`)
    : nothing;
  return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab("community") ?? "community-manager"}>${page}</div>`;
}

/**
 * OmniClinic plugin pages (extensions/omniclinic/ui). Plugin-gated like
 * InfiniCode: a disabled plugin gets the "turned off" card, not its view.
 */
function renderOmniclinicPage(state: AppViewState, tab: "omniclinic" | "oc-research" | "oc-databases") {
  if (!isTabAvailable(tab)) return renderPluginDisabledPage(state, tab);
  loadOmniclinic();
  // Scope container: the plugin's appearance (Setup › Plugins › Appearance)
  // applies inside it only, never to core UI.
  const page =
    tab === "oc-research"
      ? html`<omniclinic-research .state=${state} .client=${state.client}></omniclinic-research>`
      : tab === "oc-databases"
        ? html`<omniclinic-databases .state=${state} .client=${state.client}></omniclinic-databases>`
        : html`<omniclinic-home .state=${state} .client=${state.client}></omniclinic-home>`;
  return html`<div class="plugin-scope" data-plugin-scope=${pluginScopeOfTab(tab) ?? "omniclinic"}>${page}</div>`;
}
