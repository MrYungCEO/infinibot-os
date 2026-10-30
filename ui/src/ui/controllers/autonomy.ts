/**
 * Autonomy Dashboard Controller
 * State and API calls for the autonomy UI
 */

import { GatewayBrowserClient } from '../../gateway/client.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * UI-side mirror of `AutonomyBackend` from src/autonomy/types.ts. Sent to
 * the gateway as the `backend` param on `autonomy:queue.add`. Server
 * re-parses + validates via parseBackendParam — unknown shapes fall back
 * to the configured default, then to claude.
 */
export type AutonomyBackendOpt =
  | { kind: 'claude'; profileId?: string }
  | { kind: 'opencode' }
  | { kind: 'codex' }
  | { kind: 'grok' }
  | { kind: 'gateway-agent'; agentId: string };

export interface AutonomyPauseState {
  isPaused: boolean;
  pausedAt?: number;
  pausedBy?: 'user' | 'system' | 'cage_detection';
  reason?: string;
  resumeAt?: number;
}

export interface SystemActivityState {
  lastCheck: number;
  isUserActive: boolean;
  idleTimeMs: number;
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  gpuMemoryUsedMb?: number;
  gpuMemoryTotalMb?: number;
  processesRunning: string[];
}

export type TaskPhase =
  | 'awaiting_prefire'
  | 'awaiting_approval'
  | 'building'
  | 'testing'
  | 'assessing'
  | 'done'
  | 'failed';

export interface TaskIterationSummary {
  number: number;
  startedAt: number;
  endedAt?: number;
  buildAgentId?: string;
  buildSessionKey?: string;
  buildRunId?: string;
  buildOutcome?: 'ok' | 'error' | 'timeout';
  buildSummary?: string;
  testerSessionKey?: string;
  testerRunId?: string;
  testerVerdict?: {
    pass: boolean;
    summary: string;
    reasons?: string[];
    evidence?: string[];
    fixHints?: string[];
  };
  fixHints?: string[];
  notes?: string;
}

export interface QueuedTask {
  id: string;
  createdAt: number;
  priority: 'critical' | 'high' | 'normal' | 'low';
  status: 'pending' | 'approved' | 'running' | 'completed' | 'failed' | 'cancelled';
  title: string;
  description: string;
  projectId?: string;
  projectName?: string;
  hardwareIntensive: boolean;
  requiresApproval: boolean;
  executedAt?: number;
  completedAt?: number;
  outcome?: string;
  error?: string;
  // Closed-loop orchestrator state (populated by the server)
  currentPhase?: TaskPhase;
  iterations?: TaskIterationSummary[];
}

export type ActivityKind =
  | 'queued'
  | 'approved'
  | 'cancelled'
  | 'started'
  | 'completed'
  | 'failed'
  | 'iteration_start'
  | 'iteration_build_start'
  | 'iteration_build_done'
  | 'iteration_test_start'
  | 'iteration_test_done'
  | 'iteration_assess'
  | 'iteration_max_reached'
  | 'prefire_blocked'
  | 'prefire_completed'
  | 'audit'
  | 'notification';

export interface ActivityEntry {
  id: string;
  timestamp: number;
  kind: ActivityKind;
  phase?: string;
  title: string;
  detail?: string;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  iteration?: number;
  outcome?: 'success' | 'failure' | 'pending' | 'blocked';
  meta?: Record<string, unknown>;
}

export interface TaskActivity {
  taskId: string;
  title?: string;
  status?: string;
  currentPhase?: string | null;
  iterationsTotal?: number;
  lastActivity?: number;
  entries: ActivityEntry[];
  loadedAt: number;
  loading?: boolean;
  error?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  isoTime: string;
  actionType: string;
  category: string;
  description: string;
  target?: string;
  outcome: string;
  details?: Record<string, unknown>;
}

export interface ApiUsageStats {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
  autonomousCalls: number;
  autonomousPercent: number;
}

export interface AutonomyDashboardState {
  loading: boolean;
  error?: string;
  
  // State
  enabled: boolean;
  pauseState: AutonomyPauseState;
  activityState?: SystemActivityState;
  canWork: boolean;
  canWorkReason?: string;
  
  // Queue
  pendingTasks: QueuedTask[];
  runningTask?: QueuedTask;
  recentCompleted: QueuedTask[];
  queueStats: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  
  // Audit
  recentAudit: AuditEntry[];
  auditStats: {
    totalEntries: number;
    cageInterferences: number;
  };
  chainValid: boolean;
  
  // API Usage
  apiUsageToday: ApiUsageStats;
  
  // UI state
  selectedTab: 'goals' | 'phases' | 'scheduled' | 'overview' | 'projects' | 'audit' | 'api' | 'settings';
  /** Cached default-backend value read from config.autonomy.defaultBackend.
   *  Populated lazily by the settings tab on first open; updates flow back
   *  via setDefaultAutonomyBackend → config.patch → reload. */
  defaultBackend?: AutonomyBackendOpt;
  autoRefresh: boolean;
  selectedTaskId?: string;
  showCreateDialog?: boolean;
  createDraft?: {
    title: string;
    description: string;
    priority: 'critical' | 'high' | 'normal' | 'low';
    requiresApproval: boolean;
    /**
     * How the orchestrator should spawn the build/test agent for this task.
     * "gateway" (default) routes through sessions.spawn for a native agent;
     * "terminal" spins up a long-lived PTY running the chosen CLI so the
     * detail panel can re-attach to the live Claude Code TUI later.
     */
    executionMode?: 'gateway' | 'terminal';
    /** CLI to launch when executionMode === 'terminal'. */
    cli?: 'claude' | 'opencode' | 'gemini' | 'grok';
    /** Working directory for terminal-mode spawns. */
    cwd?: string;
    /** When true, submit as a goal-mode task (orchestrator + sub-agents)
     *  instead of the legacy build/test loop. */
    isGoal?: boolean;
    /** Goal statement (required when isGoal === true). */
    goalText?: string;
    /** Per-goal autonomy backend override. Falls onto config.autonomy.defaultBackend
     *  when omitted, then onto claude. Only meaningful for goal-mode tasks. */
    backend?: AutonomyBackendOpt;
  };
  chainVerifyResult?: { valid: boolean; brokenAt?: string } | null;
  auditSearch?: string;
  // Per-task activity feed (keyed by task id) so the detail panel can render
  // an in-depth log without re-fetching on every state diff.
  taskActivity?: Record<string, TaskActivity>;
  // Last time we successfully pulled status — surfaces a freshness pill.
  statusLoadedAt?: number;
}

// =============================================================================
// STATE
// =============================================================================

/**
 * `/autonomy?view=goals|phases|scheduled|…` opens that section — the web
 * fallback for alert deep links (docs/mobile/DEEP-LINKS.md) and the mobile
 * app's WebSurfaces.
 */
function initialAutonomyTab(): AutonomyDashboardState['selectedTab'] {
  const allowed = ['goals', 'phases', 'scheduled', 'overview', 'projects', 'audit', 'api', 'settings'] as const;
  try {
    const v = new URLSearchParams(globalThis.location?.search ?? '').get('view');
    return (allowed as readonly string[]).includes(v ?? '') ? (v as AutonomyDashboardState['selectedTab']) : 'goals';
  } catch {
    return 'goals';
  }
}

export function createAutonomyState(): AutonomyDashboardState {
  return {
    loading: true,
    enabled: true,
    pauseState: { isPaused: false },
    canWork: false,
    pendingTasks: [],
    recentCompleted: [],
    queueStats: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
    recentAudit: [],
    auditStats: { totalEntries: 0, cageInterferences: 0 },
    chainValid: true,
    apiUsageToday: { totalCalls: 0, totalTokens: 0, totalCost: 0, autonomousCalls: 0, autonomousPercent: 0 },
    selectedTab: initialAutonomyTab(),
    autoRefresh: true,
    showCreateDialog: false,
    createDraft: { title: '', description: '', priority: 'normal', requiresApproval: false, executionMode: 'gateway', cli: 'claude', cwd: '' },
    chainVerifyResult: null,
    auditSearch: '',
    taskActivity: {},
  };
}

// =============================================================================
// API CALLS
// =============================================================================

export async function loadAutonomyStatus(client: GatewayBrowserClient): Promise<Partial<AutonomyDashboardState>> {
  // If the gateway is not connected yet (initial mount or mid-reconnect),
  // stay in loading state and let refreshActiveTab retry once onHello fires.
  if (!client.connected) return { loading: true };
  try {
    const result = await client.request('autonomy:status', {});

    if (!result) {
      return { loading: false, error: 'No response from server' };
    }
    
    const { state, queue, audit, apiUsage } = result as any;

    // Best-effort Telegram status for the header chip (non-fatal if it fails).
    const telegramStatus = await getTelegramStatus(client).catch(() => null);

    return {
      loading: false,
      ...(telegramStatus ? { telegramStatus } : {}),
      enabled: state?.enabled ?? true,
      pauseState: state?.pauseState ?? { isPaused: false },
      activityState: state?.activityState,
      canWork: !state?.pauseState?.isPaused,
      pendingTasks: queue?.pending ?? [],
      runningTask: queue?.running,
      recentCompleted: queue?.recentCompleted ?? [],
      queueStats: {
        total: queue?.stats?.total ?? ((queue?.pending?.length ?? 0) + (queue?.recentCompleted?.length ?? 0)),
        pending: queue?.stats?.pending ?? (queue?.pending?.length ?? 0),
        running: queue?.stats?.running ?? (queue?.running ? 1 : 0),
        completed: queue?.stats?.completed ?? (queue?.recentCompleted?.length ?? 0),
        failed: queue?.stats?.failed ?? 0,
      },
      recentAudit: audit?.recentEntries ?? [],
      auditStats: audit?.stats ?? { totalEntries: 0, cageInterferences: 0 },
      chainValid: audit?.chainValid ?? true,
      apiUsageToday: apiUsage?.today ?? { totalCalls: 0, totalTokens: 0, totalCost: 0, autonomousCalls: 0, autonomousPercent: 0 },
      statusLoadedAt: Date.now(),
    };
  } catch (e) {
    const msg = String(e);
    // Reconnect-window errors aren't actionable — stay in loading state quietly.
    if (msg.includes('gateway not connected') || msg.includes('gateway client stopped')) {
      return { loading: true };
    }
    console.error('[Autonomy] Failed to load status:', e);
    return { loading: false, error: msg };
  }
}

export async function pauseAutonomy(client: GatewayBrowserClient, reason?: string): Promise<boolean> {
  try {
    await client.request('autonomy:pause', { reason });
    return true;
  } catch (e) {
    console.error('[Autonomy] Failed to pause:', e);
    return false;
  }
}

export async function resumeAutonomy(client: GatewayBrowserClient): Promise<boolean> {
  try {
    await client.request('autonomy:resume', {});
    return true;
  } catch (e) {
    console.error('[Autonomy] Failed to resume:', e);
    return false;
  }
}

export async function approveTask(client: GatewayBrowserClient, taskId: string): Promise<boolean> {
  try {
    await client.request('autonomy:queue.approve', { taskId });
    return true;
  } catch (e) {
    console.error('[Autonomy] Failed to approve task:', e);
    return false;
  }
}

export async function cancelTask(client: GatewayBrowserClient, taskId: string, reason?: string): Promise<boolean> {
  try {
    await client.request('autonomy:queue.cancel', { taskId, error: reason });
    return true;
  } catch (e) {
    console.error('[Autonomy] Failed to cancel task:', e);
    return false;
  }
}

export async function queueTask(
  client: GatewayBrowserClient,
  title: string,
  description: string,
  options?: {
    priority?: 'critical' | 'high' | 'normal' | 'low';
    hardwareIntensive?: boolean;
    requiresApproval?: boolean;
    /** Spawn mode override. Falls onto task.context.prefire so the
     *  orchestrator picks it up at run start (pre-fire still required). */
    executionMode?: 'gateway' | 'terminal';
    cli?: 'claude' | 'opencode' | 'gemini' | 'grok';
    cwd?: string;
    /** Submit as a goal (kind: "goal") instead of a build task. */
    isGoal?: boolean;
    goalText?: string;
    /** Per-goal backend override. Only sent when set. */
    backend?: AutonomyBackendOpt;
  }
): Promise<QueuedTask | null> {
  try {
    const { executionMode, cli, cwd, isGoal, goalText, backend, ...rest } = options ?? {};
    // Stage executionMode/cli/cwd onto the prefire context so the orchestrator
    // reads them at runLoop start. Pre-fire questionnaire fields are still
    // required separately — these only carry the spawn mode preference.
    const context =
      executionMode || cli || (cwd && cwd.trim())
        ? {
            prefire: {
              executionMode,
              cli,
              cwd: cwd && cwd.trim() ? cwd : undefined,
              completed: false,
            },
          }
        : undefined;
    const result = await client.request('autonomy:queue.add', {
      title,
      description,
      ...rest,
      ...(context ? { context } : {}),
      ...(isGoal ? { kind: 'goal', goalText: goalText || description } : {}),
      ...(backend ? { backend } : {}),
    });
    return (result as any)?.task ?? null;
  } catch (e) {
    console.error('[Autonomy] Failed to queue task:', e);
    return null;
  }
}

/**
 * Read the configured default autonomy backend. Returns `{kind:"claude"}`
 * when unset so the UI always has a concrete value to render.
 */
export async function getDefaultAutonomyBackend(
  client: GatewayBrowserClient,
): Promise<AutonomyBackendOpt> {
  try {
    const res = (await client.request("config.get", {})) as any;
    const cfg = res?.config ?? res ?? {};
    const v = cfg?.autonomy?.defaultBackend;
    if (v && typeof v === "object" && typeof v.kind === "string") return v as AutonomyBackendOpt;
    return { kind: "claude" };
  } catch (e) {
    console.error("[Autonomy] Failed to read default backend:", e);
    return { kind: "claude" };
  }
}

/**
 * Persist the default autonomy backend via gateway config patch. Returns
 * true on success. Caller should reload the displayed value afterward.
 */
export async function setDefaultAutonomyBackend(
  client: GatewayBrowserClient,
  backend: AutonomyBackendOpt,
): Promise<boolean> {
  try {
    const patch = { autonomy: { defaultBackend: backend } };
    const res = await client.request("config.patch", { raw: JSON.stringify(patch) });
    return (res as any)?.ok !== false;
  } catch (e) {
    console.error("[Autonomy] Failed to write default backend:", e);
    return false;
  }
}

export async function checkHardware(client: GatewayBrowserClient): Promise<{
  state: SystemActivityState;
  canRunIntensive: boolean;
  reason?: string;
} | null> {
  try {
    const result = await client.request('autonomy:hardware.check', {});
    return result as any;
  } catch (e) {
    console.error('[Autonomy] Failed to check hardware:', e);
    return null;
  }
}

export async function getAuditLog(client: GatewayBrowserClient, limit?: number): Promise<AuditEntry[]> {
  try {
    const result = await client.request('autonomy:audit.recent', { limit: limit ?? 50 });
    return (result as any)?.entries ?? [];
  } catch (e) {
    console.error('[Autonomy] Failed to get audit log:', e);
    return [];
  }
}

export async function importKanbanTaskToAutonomy(
  client: GatewayBrowserClient,
  params: {
    kanbanTaskId: string;
    kanbanProjectId?: string;
    title: string;
    description?: string;
    notes?: string;
    instructions?: string;
    requiresApproval?: boolean;
  }
): Promise<QueuedTask | null> {
  try {
    const result = await client.request('autonomy:queue.importKanban', params);
    return (result as any)?.task ?? null;
  } catch (e) {
    console.error('[Autonomy] importKanban failed:', e);
    return null;
  }
}

export async function syncTaskToKanban(client: GatewayBrowserClient, taskId?: string): Promise<{ ok: boolean; synced?: number; total?: number } | null> {
  try {
    const result = await client.request('autonomy:kanban.sync', taskId ? { taskId } : {});
    return result as any;
  } catch (e) {
    console.error('[Autonomy] kanban.sync failed:', e);
    return null;
  }
}

export async function linkTaskToKanban(client: GatewayBrowserClient, taskId: string, kanbanTaskId?: string): Promise<boolean> {
  try {
    await client.request('autonomy:kanban.link', { taskId, kanbanTaskId });
    return true;
  } catch (e) {
    console.error('[Autonomy] kanban.link failed:', e);
    return false;
  }
}

/** Ask the agent to draft a custom pre-fire questionnaire for this task. */
export async function generatePrefireForm(
  client: GatewayBrowserClient,
  taskId: string,
): Promise<{ ok: boolean; form?: any; error?: string }> {
  try {
    const res = await client.request('autonomy:queue.generatePrefireForm', { taskId });
    return { ok: true, form: (res as any)?.form };
  } catch (e: any) {
    console.error('[Autonomy] generatePrefireForm failed:', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Persist dynamic-form answers and re-run the agent's readiness check. */
export async function savePrefireFormAnswers(
  client: GatewayBrowserClient,
  taskId: string,
  answers: Record<string, unknown>,
  opts?: { evaluate?: boolean },
): Promise<{ ok: boolean; form?: any; error?: string }> {
  try {
    const res = await client.request('autonomy:queue.answerPrefireForm', {
      taskId,
      answers,
      evaluate: opts?.evaluate !== false,
    });
    return { ok: true, form: (res as any)?.form };
  } catch (e: any) {
    console.error('[Autonomy] answerPrefireForm failed:', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** Manual override — operator declares the form ready without the LLM verdict. */
export async function markPrefireReady(
  client: GatewayBrowserClient,
  taskId: string,
): Promise<boolean> {
  try {
    await client.request('autonomy:queue.markPrefireReady', { taskId });
    return true;
  } catch (e) {
    console.error('[Autonomy] markPrefireReady failed:', e);
    return false;
  }
}

export async function setPrefireRequired(
  client: GatewayBrowserClient,
  taskId: string,
  required: boolean,
): Promise<boolean> {
  try {
    await client.request('autonomy:queue.setPrefireRequired', { taskId, required });
    return true;
  } catch (e) {
    console.error('[Autonomy] setPrefireRequired failed:', e);
    return false;
  }
}

export async function savePrefireQuestions(
  client: GatewayBrowserClient,
  taskId: string,
  prefire: {
    successCriteria: string;
    testTargets: Array<{ description: string; url?: string; selector?: string; expect?: string }>;
    maxIterations: number;
    testerEnabled: boolean;
    builderAgentId?: string;
    testerAgentId?: string;
    notes?: string;
    completed: boolean;
  },
): Promise<boolean> {
  try {
    await client.request('autonomy:queue.setPrefire', { taskId, prefire });
    return true;
  } catch (e) {
    console.error('[Autonomy] setPrefire failed:', e);
    return false;
  }
}

export async function startClosedLoop(
  client: GatewayBrowserClient,
  taskId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.request('autonomy:queue.start', { taskId });
    return { ok: true };
  } catch (e: any) {
    console.error('[Autonomy] queue.start failed:', e);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function fetchTaskActivity(
  client: GatewayBrowserClient,
  taskId: string,
  limit = 200,
): Promise<TaskActivity | null> {
  if (!client.connected) return null;
  try {
    const result = (await client.request('autonomy:queue.activity', { taskId, limit })) as any;
    if (!result) return null;
    return {
      taskId,
      title: result.title,
      status: result.status,
      currentPhase: result.currentPhase ?? null,
      iterationsTotal: result.iterationsTotal ?? 0,
      lastActivity: result.lastActivity,
      entries: Array.isArray(result.entries) ? result.entries : [],
      loadedAt: Date.now(),
    };
  } catch (e) {
    const msg = String(e);
    if (msg.includes('gateway not connected') || msg.includes('gateway client stopped')) {
      return null;
    }
    console.error('[Autonomy] Failed to fetch task activity:', e);
    return {
      taskId,
      entries: [],
      loadedAt: Date.now(),
      error: msg,
    };
  }
}

export async function fetchTaskIterations(
  client: GatewayBrowserClient,
  taskId: string,
): Promise<{ iterations: any[]; currentPhase: string | null } | null> {
  try {
    const result = await client.request('autonomy:queue.iterations', { taskId });
    return result as any;
  } catch (e) {
    console.error('[Autonomy] iterations fetch failed:', e);
    return null;
  }
}

export async function verifyAuditChain(client: GatewayBrowserClient): Promise<{ valid: boolean; brokenAt?: string } | null> {
  try {
    const result = await client.request('autonomy:audit.verify', {});
    return result as any;
  } catch (e) {
    console.error('[Autonomy] audit.verify failed:', e);
    return null;
  }
}

export async function getApiSummary(client: GatewayBrowserClient, period: 'hour' | 'day' | 'week' = 'day'): Promise<any | null> {
  try {
    return await client.request('autonomy:api.summary', { period });
  } catch (e) {
    console.error('[Autonomy] api.summary failed:', e);
    return null;
  }
}

export async function getPendingNotifications(client: GatewayBrowserClient): Promise<any[] | null> {
  try {
    const result = await client.request('autonomy:notify.pending', {});
    return (result as any)?.pending ?? (result as any)?.entries ?? [];
  } catch (e) {
    return null;
  }
}

export async function retryFailedNotifications(client: GatewayBrowserClient): Promise<boolean> {
  try {
    await client.request('autonomy:notify.retry', {});
    return true;
  } catch (e) {
    return false;
  }
}

export async function sendTestNotification(client: GatewayBrowserClient): Promise<boolean> {
  try {
    await client.request('autonomy:notify.send', {
      level: 'info',
      title: '🧪 Test Notification',
      message: 'This is a test notification from the Autonomy dashboard.',
    });
    return true;
  } catch (e) {
    console.error('[Autonomy] Failed to send test notification:', e);
    return false;
  }
}

// ── Telegram connectivity (status / test / reconnect) ──────────────────────

export interface TelegramStatus {
  configured: boolean;
  hasBotToken: boolean;
  hasChatId: boolean;
  chatIdMasked: string | null;
}

export async function getTelegramStatus(
  client: GatewayBrowserClient,
): Promise<TelegramStatus | null> {
  try {
    return (await client.request('autonomy:telegram.status', {})) as TelegramStatus;
  } catch (e) {
    console.error('[Autonomy] telegram.status failed:', e);
    return null;
  }
}

export async function testTelegram(
  client: GatewayBrowserClient,
): Promise<{ ok: boolean; error?: string; description?: string }> {
  try {
    return (await client.request('autonomy:telegram.test', {})) as {
      ok: boolean;
      error?: string;
      description?: string;
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function reconnectTelegram(
  client: GatewayBrowserClient,
): Promise<{ ok: boolean; error?: string; description?: string; reapplied?: boolean }> {
  try {
    return (await client.request('autonomy:telegram.reconnect', {})) as {
      ok: boolean;
      error?: string;
      description?: string;
      reapplied?: boolean;
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

export function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatTimestampPrecise(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

export function describePhase(phase?: string | null): { label: string; tone: 'gold' | 'green' | 'red' | 'muted' } {
  switch (phase) {
    case 'building':   return { label: 'BUILDING',   tone: 'gold' };
    case 'testing':    return { label: 'TESTING',    tone: 'gold' };
    case 'assessing':  return { label: 'ASSESSING',  tone: 'gold' };
    case 'done':       return { label: 'DONE',       tone: 'green' };
    case 'failed':     return { label: 'FAILED',     tone: 'red' };
    case 'awaiting_approval': return { label: 'AWAITING APPROVAL', tone: 'muted' };
    case 'awaiting_prefire':  return { label: 'AWAITING PRE-FIRE',  tone: 'muted' };
    default: return { label: phase ? phase.toUpperCase() : '—', tone: 'muted' };
  }
}

export function getPriorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return '#ef4444';
    case 'high': return '#f97316';
    case 'normal': return '#3b82f6';
    case 'low': return '#6b7280';
    default: return '#9ca3af';
  }
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'pending': return '#f59e0b';
    case 'approved': return '#10b981';
    case 'running': return '#3b82f6';
    case 'completed': return '#22c55e';
    case 'failed': return '#ef4444';
    case 'cancelled': return '#6b7280';
    default: return '#9ca3af';
  }
}

export function getOutcomeColor(outcome: string): string {
  switch (outcome) {
    case 'success': return '#22c55e';
    case 'failure': return '#ef4444';
    case 'pending': return '#f59e0b';
    case 'blocked': return '#f97316';
    default: return '#9ca3af';
  }
}
