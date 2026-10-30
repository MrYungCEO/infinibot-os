/**
 * Dashboard controller — state, data loading, and synthesis for the
 * /dashboard operational view. Two roles:
 *   1. Learning hub (kept for KinglyVault parity — vault courses + tracks).
 *   2. Operational command center: agent pulse, priorities, AI insights, KPIs,
 *      synthesized CEO-style briefing.
 *
 * All ops data comes from existing gateway methods:
 *   - subagents.list           → live agent pulse + KPIs
 *   - kanban.tasks.list        → priority queue, blocker count
 *   - kanban.listRecentlyCompleted → today's wins + completion trend
 *   - systems.insights.list    → AI recommendations
 *
 * The "Daily Briefing" hero is synthesized client-side from the loaded data
 * (counts, deltas, blockers) so the dashboard has a real proactive surface
 * without round-tripping the planner. When a deeper CEO-agent briefing
 * endpoint exists, swap `synthesizeBriefing` for the gateway call.
 */

import type { GatewayBrowserClient } from "../gateway";
import { isTabAvailable } from "../plugin-host.js";
import type { TrackSummary } from "./learn";
import { getClientName, type DynamicClientRecord, type NotionDbSchema } from "./clients";
import {
  createInitialBusinessState,
  loadBusinessSummary,
  type BusinessProfile,
  type BusinessSummary,
} from "./business";
import { loadAutonomyStatus } from "./autonomy";
import { getDefaultGroupBy, getGroupOptions, loadClientsGroupByPref } from "./clients";
import { getBizFilter } from "../lib/biz-filter";

// ── Dashboard Types ──────────────────────────────────────────

export interface EnrolledCourse {
  id: string;
  title: string;
  description: string;
  coverImage?: string;
  progress: number;
  lastAccessed?: number;
  totalLessons: number;
  completedLessons: number;
  tier: string;
}

export interface QuickStat {
  label: string;
  value: string | number;
  icon: string;
  trend?: "up" | "down" | "neutral";
  /** Optional delta vs prior period, used for the trend caption. */
  deltaLabel?: string;
  /** Optional accent — "primary" | "ok" | "warn" | "danger" — drives the icon color. */
  tone?: "primary" | "ok" | "warn" | "danger";
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  earned: boolean;
  earnedAt?: number;
}

export interface RecommendedCourse {
  id: string;
  title: string;
  description: string;
  tier: string;
  duration: string;
  matchReason: string;
}

// ── Operational types ────────────────────────────────────────

export interface DashInsight {
  id: string;
  type: "warning" | "alignment" | "info" | "opportunity";
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "info";
  actionable?: boolean;
  action?: string;
  /** Tab / route the action should open. */
  actionTab?: string;
  createdAt: number;
  /**
   * Deterministic action classification consumed by the dashboard's
   * suggestion action buttons. When omitted, the view classifies the
   * suggestion from its text (see classifyInsightKind in the view).
   * "create-project" suggestions are routed to the Suggested Projects card,
   * not rendered inline.
   */
  suggestionKind?: "coder" | "schedule" | "open" | "create-project" | "generic";
  /** For suggestionKind === "coder": the brief to spawn the coder with. */
  coderTask?: string;
  /** For suggestionKind === "create-project": draft to seed createProject with. */
  projectDraft?: { name: string; description?: string };
}

/**
 * A forward-moving "create a project" suggestion surfaced on the dashboard.
 * Sourced from real, already-loaded signals (clients in progress without a
 * project, plus any backend insight flagged suggestionKind="create-project").
 * Never fabricated — when there are no real signals the card shows an empty
 * state rather than a placeholder card.
 */
export interface DashSuggestedProject {
  id: string;
  name: string;
  description: string;
  /** Short human rationale shown under the title. */
  rationale: string;
  /** Optional client linkage so "Open details" can deep-link the CRM. */
  clientId?: string;
  source: "client" | "insight";
}

export interface DashRunningAgent {
  runId: string;
  sessionKey: string;
  label: string;
  status: string;
  task: string;
  startedAt: number;
  durationMs: number;
  progress?: number;
}

export interface DashCompletedEntry {
  taskId: string;
  title: string;
  projectName: string;
  completedAt: number;
  durationMs: number;
  status?: "success" | "error";
}

export interface DashPriorityTask {
  id: string;
  projectId?: string;
  title: string;
  projectName: string;
  status: string;
  priority: string;
  updatedAt: number;
  blocked?: boolean;
}

/**
 * A named subagent run that recently finished — the concrete "what was I just
 * doing" signal (e.g. "coder-fix-dashboard-freeze-blocking-clicks"). Powers the
 * grounded recent-activity lines in the briefing.
 */
export interface DashRecentRun {
  runId: string;
  label: string;
  status: "complete" | "error" | "timeout";
  endedAt: number;
}

export interface DashBriefingLine {
  /** Optional icon name from ../icons. */
  icon?: string;
  /** Tone for the colored dot prefix. */
  tone: "primary" | "ok" | "warn" | "danger" | "info";
  text: string;
  /**
   * Optional forward action. When set, the briefing line renders as a clickable
   * row that navigates to this tab — making the "Where am I" summary actionable
   * (jump straight to the run / task / activity it names).
   */
  actionTab?: string;
}

export interface DashBriefing {
  /** One-sentence headline (e.g. "5 agents working, 2 blockers to clear"). */
  headline: string;
  /** 3–5 prioritized lines surfaced as the CEO-style briefing. */
  lines: DashBriefingLine[];
  /** Last refresh time. */
  generatedAt: number;
}

// ── Expanded mini-app types ──────────────────────────────────

export interface DashAgentRoster {
  id: string;
  name: string;
  backend: string;
  /** Number of runs in the recently-completed window (last 30). */
  runsRecent: number;
  successPct: number;
  active: boolean;
}

export interface DashWorkflow {
  id: string;
  name: string;
  status: "running" | "idle" | "error" | "paused" | "unknown";
  kind?: string;
  /** Last run time (ms) if available. */
  lastRunAt?: number;
}

export interface DashCronJob {
  id: string;
  label: string;
  schedule: string;
  nextRunAt?: number;
  lastRunAt?: number;
  intervalMs?: number;
  status?: string;
  enabled: boolean;
}

export interface DashNote {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
}

export interface DashNode {
  id: string;
  name: string;
  online: boolean;
  isLocal: boolean;
  kind?: string;
  role?: string;
  lastSeenAt?: number;
}

export interface DashProjectVelocity {
  projectName: string;
  count: number;
  color: string;
}

export interface DashSystemHealth {
  cpu: number;
  memory: number;
  /** Active subagent slots used / total cap, 0–100. */
  agentLoad: number;
  /** Online connected nodes (including local). */
  nodesOnline: number;
  nodesTotal: number;
}

export interface DashRevenue {
  today: number;
  week: number;
  month: number;
  year: number;
  /** All-time revenue (sums every logged income entry across every source —
   *  Whop, Stripe, Square, manual logs). */
  allTime: number;
  /** 7-day percentage delta vs the previous 7 days. */
  trend7d: number;
  /** Last 30 daily totals oldest → newest, for the sparkline + bar chart. */
  daily30: number[];
  /** Currency symbol — best-effort, defaults to "$". */
  currency: string;
  /** Top 3 income streams (label + amount). */
  topStreams: Array<{ label: string; amount: number }>;
}

export interface DashDisciplineBlock {
  id: string;
  label: string;
  /** Minute-of-day start (0-1439). */
  startMinute: number;
  /** Minute-of-day end (0-1439). */
  endMinute: number;
  done: boolean;
  /** True if `nowMinute` is currently inside the block window. */
  active: boolean;
}

export interface DashDiscipline {
  /** Today's blocks (ordered by start time). */
  blocks: DashDisciplineBlock[];
  /** Today's completion ratio 0–1. */
  todayCompletionPct: number;
  /** Today's score 0–100 (from computeDayScore). */
  todayScore: number;
  /** Last 7 day scores oldest → newest. */
  weekScores: number[];
  /** Active block title right now ("Deep work · 9:00-11:00"). */
  currentBlockLabel: string | null;
  /** Minute-of-day now, for the timeline cursor. */
  nowMinute: number;
}

export interface DashPipelineClient {
  id: string;
  name: string;
  stage: string;
  /** Numerical priority (high/mid/low → 0/1/2). */
  hot: number;
}

export interface DashPipeline {
  total: number;
  /** Stage → count grouping for the donut. */
  stages: Array<{ stage: string; count: number; color: string }>;
  /** Top 5 active clients (hot/recent). */
  topClients: DashPipelineClient[];
}

export interface DashFocusPriority {
  id: string;
  title: string;
  description?: string;
  quarter: string;
  progress: number;
  status: "active" | "completed" | "paused";
  /** True when this priority is the user's #1 focus (rank 1). */
  isFocus: boolean;
  /** Open outcomes / next step under this priority. */
  nextStep?: string;
}

export interface DashFocus {
  total: number;
  activeCount: number;
  /** Average progress across active priorities, 0–100. */
  avgProgress: number;
  /** Top 4 active priorities by rank. */
  priorities: DashFocusPriority[];
  /** Current #1 focus title, or null. */
  focusTitle: string | null;
}

export interface DashKanbanLanes {
  /** Total task counts per lane. */
  counts: { todo: number; inProgress: number; blocked: number; doneToday: number };
  /** Up to 3 top tasks per lane (title, project). */
  lanes: {
    todo: Array<{ id: string; projectId?: string; title: string; project: string }>;
    inProgress: Array<{ id: string; projectId?: string; title: string; project: string }>;
    blocked: Array<{ id: string; projectId?: string; title: string; project: string }>;
    doneToday: Array<{ id: string; projectId?: string; title: string; project: string }>;
  };
}

export interface DashProjectProgress {
  id: string;
  name: string;
  total: number;
  inProgress: number;
  done: number;
  blocked: number;
  /** Percent done (0–100). */
  progress: number;
}

export interface DashContentSurface {
  surface: string;
  count: number;
  published: number;
  color: string;
}

export interface DashContent {
  total: number;
  surfaces: DashContentSurface[];
  recent: Array<{
    id: string;
    name: string;
    surface: string;
    status: string;
    updatedAt: number;
  }>;
}

export interface DashFederationOverview {
  totalNodes: number;
  onlineNodes: number;
  /** Node kind → count (gateway / sat / device / agent / unknown). */
  byKind: Array<{ kind: string; count: number; color: string }>;
  /** True when at least one remote (non-local) node is online. */
  hasRemoteLink: boolean;
}

export interface DashClientInProgress {
  id: string;
  name: string;
  businessId: string | null;
  businessName: string;
  businessColor: string;
  status: string;
  activeProjectTitle: string;
  activeProjectId: string | null;
  activeProjectStatus: string | null;
  progress: number;
  daysInProgress: number;
  lastActivityAt: number | null;
  agentAssigned: string;
  record: DynamicClientRecord;
}

export interface DashBusinessFederationSummary {
  id: string;
  name: string;
  logo: string | null;
  brandColor: string;
  revenue7d: number;
  activeClients: number;
  projectsInProgress: number;
  blockedTasks: number;
  activityScore24h: number;
  revenueSpark7d: number[];
  status: "green" | "amber" | "red";
}

export interface DashCeoInsight {
  id: string;
  severity: "critical" | "warn" | "success" | "info";
  title: string;
  rationale: string;
  actionLabel: string;
  actionTab: string;
  clientId?: string;
  businessId?: string;
}

export interface DashAutonomyDecision {
  id: string;
  timestamp: number;
  summary: string;
  ok: boolean;
}

export interface DashAutonomyMini {
  status: "running" | "paused" | "blocked" | "idle" | "loading" | "error";
  statusLabel: string;
  lastUpdatedAt: number | null;
  decisions: DashAutonomyDecision[];
  openPrefireDrafts: number;
  blockedSince: number | null;
  error: string | null;
}

export interface DashAgencyAction {
  id: string;
  label: string;
  detail: string;
  tone: "primary" | "warn" | "danger";
  tab: string;
}

export interface DashAgencyExecutive {
  available: boolean;
  agencyId: string | null;
  agencyName: string;
  agencyRole: string | null;
  agencyCount: number;
  kpis: Array<{ id: string; label: string; value: string; context?: string; tone?: string }>;
  pendingApprovals: number;
  highRiskApprovals: number;
  activeEngagements: number;
  atRiskEngagements: number;
  employees: number;
  humanEmployees: number;
  aiEmployees: number;
  blockedEmployees: number;
  averageUtilization: number;
  overdueReceivables: number;
  grossMarginPercent: number;
  collaborationState: string;
  collaborationMessage: string;
  migrationPending: boolean;
  migrationBusinesses: number;
  gaps: string[];
  nextActions: DashAgencyAction[];
  loadedAt: number | null;
}

export interface DashboardState {
  loading: boolean;
  error: string | null;
  userName: string;
  isEmpty: boolean;

  // ── Operational
  briefing: DashBriefing | null;
  kpis: QuickStat[];
  insights: DashInsight[];
  ceoInsights: DashCeoInsight[];
  dismissedInsights: Set<string>;
  /** Suggestion id → epoch ms until which the suggestion stays hidden (snooze). */
  snoozedInsights: Map<string, number>;
  /** Forward-moving "create a project" suggestions (Suggested Projects card). */
  suggestedProjects: DashSuggestedProject[];
  clientsInProgress: DashClientInProgress[];
  businessSummaries: DashBusinessFederationSummary[];
  autonomyMini: DashAutonomyMini;
  agencyExecutive: DashAgencyExecutive;
  runningAgents: DashRunningAgent[];
  recentDone: DashCompletedEntry[];
  /** Named subagent runs that recently finished (the "where am I" signal). */
  recentRuns: DashRecentRun[];
  /** Branch/repo the operator is currently working in (from git.status). */
  gitBranch: string | null;
  gitRepo: string | null;
  priorityTasks: DashPriorityTask[];
  blockedCount: number;
  /** Completions in the last 24h for the trend caption. */
  completions24h: number;

  // ── Sparkline series (24 hourly buckets, oldest → newest)
  completionsByHour: number[];
  runningByHour: number[];
  /** Short trend used inside KPI tiles (last 12 hourly buckets of completions). */
  completionsSpark: number[];
  /** Short trend used inside KPI tiles (last 12 hourly buckets of active runs). */
  activeSpark: number[];

  // ── Expanded panels
  agentRoster: DashAgentRoster[];
  workflows: DashWorkflow[];
  cronJobs: DashCronJob[];
  notes: DashNote[];
  nodes: DashNode[];
  projectVelocity: DashProjectVelocity[];
  systemHealth: DashSystemHealth;

  // ── Business + discipline + pipeline
  revenue: DashRevenue;
  discipline: DashDiscipline;
  pipeline: DashPipeline;

  // ── Focus & priorities + kanban + content + federation
  focus: DashFocus;
  kanbanLanes: DashKanbanLanes;
  projectsInProgress: DashProjectProgress[];
  content: DashContent;
  federationOverview: DashFederationOverview;

  // ── Learning hub (kept)
  learningPath: TrackSummary[];
  currentTrack: TrackSummary | null;
  currentStepTitle: string;
  enrolledCourses: EnrolledCourse[];
  quickStats: QuickStat[];
  achievements: Achievement[];
  recommendedCourses: RecommendedCourse[];
}

function createEmptyAgencyExecutive(): DashAgencyExecutive {
  return {
    available: false,
    agencyId: null,
    agencyName: "Agency workspace",
    agencyRole: null,
    agencyCount: 0,
    kpis: [],
    pendingApprovals: 0,
    highRiskApprovals: 0,
    activeEngagements: 0,
    atRiskEngagements: 0,
    employees: 0,
    humanEmployees: 0,
    aiEmployees: 0,
    blockedEmployees: 0,
    averageUtilization: 0,
    overdueReceivables: 0,
    grossMarginPercent: 0,
    collaborationState: "unknown",
    collaborationMessage: "Private collaboration status unavailable",
    migrationPending: false,
    migrationBusinesses: 0,
    gaps: [],
    nextActions: [],
    loadedAt: null,
  };
}

export function createInitialDashboardState(): DashboardState {
  return {
    loading: false,
    error: null,
    userName: "Operator",
    isEmpty: true,

    briefing: null,
    kpis: [],
    insights: [],
    ceoInsights: [],
    dismissedInsights: new Set<string>(),
    snoozedInsights: new Map<string, number>(),
    suggestedProjects: [],
    clientsInProgress: [],
    businessSummaries: [],
    autonomyMini: {
      status: "loading",
      statusLabel: "Loading autonomy",
      lastUpdatedAt: null,
      decisions: [],
      openPrefireDrafts: 0,
      blockedSince: null,
      error: null,
    },
    agencyExecutive: createEmptyAgencyExecutive(),
    runningAgents: [],
    recentDone: [],
    recentRuns: [],
    gitBranch: null,
    gitRepo: null,
    priorityTasks: [],
    blockedCount: 0,
    completions24h: 0,

    completionsByHour: new Array(24).fill(0),
    runningByHour: new Array(24).fill(0),
    completionsSpark: new Array(12).fill(0),
    activeSpark: new Array(12).fill(0),

    agentRoster: [],
    workflows: [],
    cronJobs: [],
    notes: [],
    nodes: [],
    projectVelocity: [],
    systemHealth: { cpu: 0, memory: 0, agentLoad: 0, nodesOnline: 0, nodesTotal: 0 },

    revenue: {
      today: 0,
      week: 0,
      month: 0,
      year: 0,
      allTime: 0,
      trend7d: 0,
      daily30: new Array(30).fill(0),
      currency: "$",
      topStreams: [],
    },
    discipline: {
      blocks: [],
      todayCompletionPct: 0,
      todayScore: 0,
      weekScores: new Array(7).fill(0),
      currentBlockLabel: null,
      nowMinute: 0,
    },
    pipeline: { total: 0, stages: [], topClients: [] },

    focus: {
      total: 0,
      activeCount: 0,
      avgProgress: 0,
      priorities: [],
      focusTitle: null,
    },
    kanbanLanes: {
      counts: { todo: 0, inProgress: 0, blocked: 0, doneToday: 0 },
      lanes: { todo: [], inProgress: [], blocked: [], doneToday: [] },
    },
    projectsInProgress: [],
    content: { total: 0, surfaces: [], recent: [] },
    federationOverview: {
      totalNodes: 0,
      onlineNodes: 0,
      byKind: [],
      hasRemoteLink: false,
    },

    learningPath: [],
    currentTrack: null,
    currentStepTitle: "",
    enrolledCourses: [],
    quickStats: [],
    achievements: [],
    recommendedCourses: [],
  };
}

// ── Data loading ─────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function formatBlockTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

/** Compact relative time ("just now", "12m ago", "3h ago", "2d ago"). */
function timeAgoShort(ts: number): string {
  if (!ts) return "recently";
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Accept either a bare array or an object that wraps the array under one of a
 * few known keys, return the array. Defensive against gateway shape drift —
 * several kanban handlers return bare arrays today (`respond(true, projects)`)
 * but others return `{projects: [...]}`. Both work now.
 */
function unwrapArray(res: unknown, keys: readonly string[]): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  if (res && typeof res === "object") {
    for (const k of keys) {
      const v = (res as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function resolveCronIntervalMs(job: Record<string, unknown>): number | undefined {
  const direct = Number(job.intervalMs ?? job.interval ?? job.periodMs ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const schedule = String(job.schedule ?? job.cron ?? job.spec ?? "").trim();
  const minuteEvery = schedule.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (minuteEvery) return Number(minuteEvery[1]) * 60_000;
  const hourlyEvery = schedule.match(/^\d+\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (hourlyEvery) return Number(hourlyEvery[1]) * 3_600_000;
  if (/^\d+\s+\*\s+\*\s+\*\s+\*$/.test(schedule)) return 3_600_000;
  if (/^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(schedule)) return DAY_MS;
  return undefined;
}

function businessColorForId(id: string): string {
  const palette = [
    "var(--g-primary)",
    "var(--dash-info)",
    "var(--dash-ok)",
    "var(--dash-warn)",
    "color-mix(in srgb, var(--dash-info) 55%, var(--dash-gold))",
    "color-mix(in srgb, var(--dash-danger) 65%, var(--dash-gold))",
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length] ?? "var(--g-primary)";
}

function dataValue(record: Record<string, unknown>, candidates: readonly string[]): unknown {
  const data = normalizeRecord(record.data);
  for (const key of candidates) {
    if (record[key] != null && record[key] !== "") return record[key];
    if (data[key] != null && data[key] !== "") return data[key];
    const found = Object.entries(data).find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (found && found[1] != null && found[1] !== "") return found[1];
  }
  return undefined;
}

function numericDataValue(
  record: Record<string, unknown>,
  candidates: readonly string[],
): number | null {
  const raw = dataValue(record, candidates);
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/[,%]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stringDataValue(
  record: Record<string, unknown>,
  candidates: readonly string[],
): string | null {
  const raw = dataValue(record, candidates);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function dateDataValue(
  record: Record<string, unknown>,
  candidates: readonly string[],
): number | null {
  const raw = dataValue(record, candidates);
  return normalizeTimestamp(raw) ?? null;
}

function clientStatus(record: Record<string, unknown>): string {
  return normalizeStatus(dataValue(record, ["status", "Status", "stage", "Stage"]));
}

function isClientInProgress(
  record: Record<string, unknown>,
  linkedProjectStatus: string | null,
): boolean {
  const activeStatuses = new Set(["in_progress", "active", "engaged"]);
  return activeStatuses.has(clientStatus(record)) || linkedProjectStatus === "in_progress";
}

function shapeClientsInProgress(
  clients: DynamicClientRecord[],
  schema: NotionDbSchema | null,
  businessById: Map<string, BusinessProfile>,
  projectsById: Map<string, Record<string, unknown>>,
  tasks: Array<Record<string, unknown>> = [],
  // Project ids linked to each client via the generic relations store
  // (relations.list peerType:"project"). The Notion client row often has NO
  // direct project column — the link lives here instead. Keyed by client.id.
  relationsByClient: Map<string, string[]> = new Map(),
): DashClientInProgress[] {
  const now = Date.now();
  // Pre-bucket tasks by projectId once so per-client progress lookup is O(1).
  const tasksByProject = new Map<string, Array<Record<string, unknown>>>();
  for (const t of tasks) {
    const pid =
      String((t as Record<string, unknown>).projectId ?? "") ||
      String((t as Record<string, unknown>).project_id ?? "");
    if (!pid) continue;
    let arr = tasksByProject.get(pid);
    if (!arr) {
      arr = [];
      tasksByProject.set(pid, arr);
    }
    arr.push(t);
  }
  const isTaskDone = (t: Record<string, unknown>): boolean => {
    const s = String(t.status ?? "").toLowerCase();
    return s === "done" || s === "completed" || t.done === true;
  };
  // Aggregate progress across the UNION of related projects: total done tasks
  // over total tasks across every linked project. Weighting matches the
  // single-project case (each task counts equally) so nothing else changes.
  const taskProgress = (pids: Array<string | null | undefined>): number | null => {
    let total = 0;
    let done = 0;
    for (const pid of pids) {
      if (!pid) continue;
      const arr = tasksByProject.get(pid);
      if (!arr || arr.length === 0) continue;
      total += arr.length;
      done += arr.filter(isTaskDone).length;
    }
    if (total === 0) return null;
    return Math.round((done / total) * 100);
  };
  return clients
    .map((client) => {
      const record = client as unknown as Record<string, unknown>;
      const businessId =
        stringDataValue(record, ["businessId", "Business ID", "business_id"]) ?? null;
      let projectId = stringDataValue(record, [
        "projectId",
        "Project ID",
        "activeProjectId",
        "Active Project ID",
      ]);
      // Fallback: if the Notion client row doesn't carry a project link, infer
      // one from kanban tasks that reference this client. Pick the project
      // with the most matching tasks (best signal of "active").
      if (!projectId) {
        const counts = new Map<string, number>();
        for (const t of tasks) {
          const tr = t as Record<string, unknown>;
          const tClientId = String(tr.clientId ?? tr.client_id ?? "");
          if (tClientId !== client.id) continue;
          const pid = String(tr.projectId ?? tr.project_id ?? "");
          if (!pid) continue;
          counts.set(pid, (counts.get(pid) ?? 0) + 1);
        }
        if (counts.size > 0) {
          projectId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
      }
      // Walk the relations store too: a client is often linked to
      // its project (RoboPark) only via a relation, with no direct column and
      // no client-tagged tasks. Build the full set of related project ids and
      // aggregate progress across all of them. The direct/inferred id stays the
      // representative for display (name + deep-link).
      const relatedProjectIds: string[] = [];
      const seenPid = new Set<string>();
      const pushPid = (pid: string | null | undefined) => {
        if (!pid || seenPid.has(pid)) return;
        seenPid.add(pid);
        relatedProjectIds.push(pid);
      };
      pushPid(projectId);
      for (const pid of relationsByClient.get(client.id) ?? []) pushPid(pid);
      // No direct/inferred project but a relation exists → use it for display.
      if (!projectId && relatedProjectIds.length > 0) projectId = relatedProjectIds[0];

      const project = projectId ? projectsById.get(projectId) : undefined;
      // In-progress if the client itself is active, OR any related project is
      // in progress (so relation-only clients still surface with live status).
      const relatedInProgress = relatedProjectIds.some(
        (pid) => normalizeStatus(projectsById.get(pid)?.status) === "in_progress",
      );
      const projectStatus = project
        ? normalizeStatus(project.status)
        : relatedInProgress
          ? "in_progress"
          : normalizeStatus(dataValue(record, ["projectStatus", "Project Status"]));
      if (!isClientInProgress(record, projectStatus || null)) return null;

      const business = businessId ? businessById.get(businessId) : undefined;
      const startedAt =
        dateDataValue(record, [
          "startedAt",
          "Started At",
          "startDate",
          "Start Date",
          "created_at",
        ]) ??
        normalizeTimestamp(client.created_at) ??
        now;
      const lastActivityAt =
        dateDataValue(record, ["lastActivityAt", "Last Activity", "lastActivity", "updated_at"]) ??
        normalizeTimestamp(client.updated_at) ??
        null;
      // Progress precedence: live computed (kanban done/total for the linked
      // project) → notion record field → project record field → 0. Live wins so
      // a client whose project has zero `progress` set in Notion still gets a
      // real %, derived from the InfiniBot kanban task ledger.
      const liveProgress = taskProgress(relatedProjectIds);
      const recordedProgress =
        numericDataValue(record, ["progress", "Progress", "percentComplete", "% Complete"]) ??
        Number(project?.progress ?? project?.percentComplete ?? 0);
      const progress = Math.max(
        0,
        Math.min(100, Math.round(liveProgress != null ? liveProgress : recordedProgress)),
      );
      return {
        id: client.id,
        name: getClientName(client, schema),
        businessId,
        businessName:
          business?.name ?? stringDataValue(record, ["businessName", "Business"]) ?? "Business",
        businessColor: business?.id ? businessColorForId(business.id) : "var(--g-primary)",
        status: stringDataValue(record, ["status", "Status", "stage", "Stage"]) ?? "In progress",
        activeProjectTitle:
          stringDataValue(record, [
            "activeProjectTitle",
            "Active Project",
            "projectName",
            "Project",
          ]) ?? String(project?.name ?? project?.title ?? "Active project"),
        activeProjectId: projectId,
        activeProjectStatus: projectStatus || null,
        progress,
        daysInProgress: Math.max(0, Math.floor((now - startedAt) / DAY_MS)),
        lastActivityAt,
        agentAssigned:
          stringDataValue(record, ["agentAssigned", "Agent", "assignee", "Assignee"]) ??
          "Unassigned",
        record: client,
      } satisfies DashClientInProgress;
    })
    .filter((client): client is DashClientInProgress => client !== null)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
    .slice(0, 8);
}

async function loadSummaryViaBusinessController(
  client: GatewayBrowserClient,
  business: BusinessProfile,
): Promise<BusinessSummary | null> {
  const tempState = {
    businessState: {
      ...createInitialBusinessState(),
      businesses: [business],
      activeBusinessId: business.id,
    },
    requestUpdate: () => {},
  } as Parameters<typeof loadBusinessSummary>[0];
  await loadBusinessSummary(tempState, client, { force: true });
  const summary = tempState.businessState?.summary;
  return summary?.businessId === business.id ? summary : null;
}

function scoreBusinessActivity(summary: BusinessSummary | null): number {
  if (!summary) return 0;
  const since = Date.now() - DAY_MS;
  const recentLeads = summary.leads.recent.filter((lead) => lead.receivedAtMs >= since).length;
  const recentPages = summary.pages.recent.filter((page) => {
    const ts = normalizeTimestamp(page.updatedAt) ?? 0;
    return ts >= since;
  }).length;
  const weighted =
    recentLeads * 28 + recentPages * 12 + summary.kpi.formSubmits * 3 + summary.kpi.ctaClicks;
  return Math.max(0, Math.min(100, Math.round(weighted)));
}

function resolveBusinessStatus(
  activeClients: number,
  projectsInProgress: number,
  blockedTasks: number,
  activityScore24h: number,
): DashBusinessFederationSummary["status"] {
  if (blockedTasks > 3 || (activeClients > 0 && activityScore24h === 0)) return "red";
  if (blockedTasks > 0 || projectsInProgress === 0) return "amber";
  return "green";
}

async function loadBusinessFederationSummaries(
  client: GatewayBrowserClient,
  businesses: BusinessProfile[],
  clientsByBusiness: Map<string, DynamicClientRecord[]>,
  projectsRaw: Array<Record<string, unknown>>,
  tasksRaw: Array<Record<string, unknown>>,
): Promise<DashBusinessFederationSummary[]> {
  const summaries = await Promise.all(
    businesses.map(async (business) => {
      const [summary, income] = await Promise.all([
        loadSummaryViaBusinessController(client, business).catch(() => null),
        client
          .request("business.income.stats", { businessId: business.id })
          .catch(() => ({}) as Record<string, unknown>) as Promise<Record<string, unknown>>,
      ]);
      const dailyRaw = (income.dailyData as Array<{ amount?: number }> | undefined) ?? [];
      const revenueSpark7d = new Array(7).fill(0).map((_, index) => {
        const row = dailyRaw[dailyRaw.length - 7 + index];
        return Number(row?.amount ?? 0);
      });
      const revenue7d = revenueSpark7d.reduce((sum, value) => sum + value, 0);
      const clients = clientsByBusiness.get(business.id) ?? [];
      const activeClients = clients.filter((c) =>
        new Set(["in_progress", "active", "engaged"]).has(
          clientStatus(c as unknown as Record<string, unknown>),
        ),
      ).length;
      const scopedProjectIds = new Set(
        projectsRaw
          .filter((project) => String(project.businessId ?? "") === business.id)
          .map((project) => String(project.id ?? "")),
      );
      const projectsInProgress = projectsRaw.filter((project) => {
        const projectBusinessId = String(project.businessId ?? "");
        if (projectBusinessId && projectBusinessId !== business.id) return false;
        const status = normalizeStatus(project.status);
        return (
          status === "in_progress" ||
          status === "updating" ||
          status === "reviewing" ||
          project.active === true
        );
      }).length;
      const blockedTasks = tasksRaw.filter((task) => {
        const status = normalizeStatus(task.status);
        if (status !== "blocked" && task.blocked !== true) return false;
        const taskBusinessId = String(task.businessId ?? "");
        if (taskBusinessId) return taskBusinessId === business.id;
        const projectId = String(task.projectId ?? "");
        return projectId ? scopedProjectIds.has(projectId) : false;
      }).length;
      const activityScore24h = scoreBusinessActivity(summary);
      const brandColor = summary?.brand.primaryColor ?? businessColorForId(business.id);
      return {
        id: business.id,
        name: business.name,
        logo: summary?.business?.logo ?? null,
        brandColor,
        revenue7d,
        activeClients,
        projectsInProgress,
        blockedTasks,
        activityScore24h,
        revenueSpark7d,
        status: resolveBusinessStatus(
          activeClients,
          projectsInProgress,
          blockedTasks,
          activityScore24h,
        ),
      } satisfies DashBusinessFederationSummary;
    }),
  );
  return summaries.sort((a, b) => b.activityScore24h - a.activityScore24h);
}

async function loadClientsByBusiness(
  client: GatewayBrowserClient,
  businesses: BusinessProfile[],
  fallbackClients: DynamicClientRecord[],
): Promise<Map<string, DynamicClientRecord[]>> {
  const out = new Map<string, DynamicClientRecord[]>();
  if (businesses.length === 0) return out;
  await Promise.all(
    businesses.map(async (business) => {
      try {
        const res = (await client.request("business.clients.list", {
          businessId: business.id,
        })) as { clients?: DynamicClientRecord[] };
        out.set(business.id, Array.isArray(res.clients) ? res.clients : []);
      } catch {
        out.set(
          business.id,
          fallbackClients.filter((clientRecord) => {
            const record = clientRecord as unknown as Record<string, unknown>;
            return (
              stringDataValue(record, ["businessId", "Business ID", "business_id"]) === business.id
            );
          }),
        );
      }
    }),
  );
  return out;
}

function shapeAutonomyMini(
  res: Partial<{
    loading: boolean;
    error?: string;
    pauseState: { isPaused?: boolean; pausedAt?: number; reason?: string };
    canWork: boolean;
    pendingTasks: Array<Record<string, unknown>>;
    runningTask?: Record<string, unknown>;
    recentCompleted: Array<Record<string, unknown>>;
    recentAudit: Array<Record<string, unknown>>;
    statusLoadedAt?: number;
  }>,
): DashAutonomyMini {
  if (res.loading) {
    return {
      status: "loading",
      statusLabel: "Loading autonomy",
      lastUpdatedAt: null,
      decisions: [],
      openPrefireDrafts: 0,
      blockedSince: null,
      error: null,
    };
  }
  if (res.error) {
    return {
      status: "error",
      statusLabel: "Autonomy unavailable",
      lastUpdatedAt: Date.now(),
      decisions: [],
      openPrefireDrafts: 0,
      blockedSince: null,
      error: res.error,
    };
  }
  const pendingTasks = res.pendingTasks ?? [];
  const openPrefireDrafts = pendingTasks.filter((task) => {
    const phase = normalizeStatus(task.currentPhase);
    const context = normalizeRecord(task.context);
    return phase === "awaiting_prefire" || context.prefireRequired === true;
  }).length;
  const decisions = (res.recentAudit ?? [])
    .filter((entry) => {
      const category = normalizeStatus(entry.category);
      const actionType = normalizeStatus(entry.actionType);
      return (
        category.includes("autonomy") ||
        actionType.includes("approval") ||
        actionType.includes("prefire")
      );
    })
    .slice(0, 3)
    .map((entry) => {
      const outcome = normalizeStatus(entry.outcome);
      return {
        id: String(entry.id ?? `${entry.timestamp ?? Date.now()}`),
        timestamp: normalizeTimestamp(entry.timestamp) ?? Date.now(),
        summary: String(entry.description ?? entry.actionType ?? "Autonomy decision").slice(0, 88),
        ok: outcome === "success" || outcome === "approved" || outcome === "completed",
      } satisfies DashAutonomyDecision;
    });
  const pausedAt = res.pauseState?.isPaused ? (res.pauseState.pausedAt ?? null) : null;
  const runningTask = res.runningTask;
  const blockedTask = pendingTasks.find(
    (task) => normalizeStatus(task.currentPhase) === "awaiting_prefire",
  );
  const blockedSince = blockedTask ? (normalizeTimestamp(blockedTask.createdAt) ?? null) : pausedAt;
  const status: DashAutonomyMini["status"] = res.pauseState?.isPaused
    ? "paused"
    : blockedTask
      ? "blocked"
      : runningTask
        ? "running"
        : "idle";
  const statusLabel =
    status === "paused"
      ? `Paused${res.pauseState?.reason ? ` · ${res.pauseState.reason}` : ""}`
      : status === "blocked"
        ? "Blocked on prefire"
        : status === "running"
          ? `Running ${String(runningTask?.title ?? "task")}`
          : "Idle";
  return {
    status,
    statusLabel,
    lastUpdatedAt: res.statusLoadedAt ?? Date.now(),
    decisions,
    openPrefireDrafts,
    blockedSince,
    error: null,
  };
}

async function loadAgencyExecutive(client: GatewayBrowserClient): Promise<DashAgencyExecutive> {
  const fallback = createEmptyAgencyExecutive();
  const safeRequest = async <T>(method: string, params: Record<string, unknown>, value: T) => {
    try {
      return (await client.request(method, params)) as T;
    } catch {
      return value;
    }
  };
  const list = await safeRequest<{
    agencies?: Array<{ id: string; name: string; role: string }>;
    migration?: { sourceExists?: boolean; businessesFound?: number; completedAt?: number | null };
  }>("agency.ops.agencies.list", {}, {});
  const agencies = list.agencies ?? [];
  const requestedAgencyId = getBizFilter();
  const agency =
    agencies.find((item) => item.id === requestedAgencyId) ??
    agencies.find((item) => item.role === "owner") ??
    agencies[0];
  if (!agency) return { ...fallback, loadedAt: Date.now() };

  const [
    dashboardResult,
    approvalsResult,
    engagementsResult,
    employeesResult,
    financeResult,
    collaboration,
    migrationResult,
  ] = await Promise.all([
    safeRequest<{ dashboard?: { kpis?: DashAgencyExecutive["kpis"] } }>(
      "agency.ops.dashboard",
      { agencyId: agency.id },
      {},
    ),
    safeRequest<{ approvals?: Array<{ risk?: string }> }>(
      "agency.ops.approvals.list",
      { agencyId: agency.id, status: "pending" },
      {},
    ),
    safeRequest<{ engagements?: Array<{ health?: string }> }>(
      "agency.ops.engagements.list",
      { agencyId: agency.id, status: "active" },
      {},
    ),
    safeRequest<{
      employees?: Array<{ kind?: string; availability?: string; utilizationPercent?: number }>;
    }>("agency.ops.employees.list", { agencyId: agency.id, status: "active" }, {}),
    safeRequest<{ finance?: { overdueReceivables?: number; grossMarginPercent?: number } }>(
      "agency.ops.finance.summary",
      { agencyId: agency.id, period: "month" },
      {},
    ),
    safeRequest<{ state?: string; message?: string }>("agency.ops.collaboration.status", {}, {}),
    safeRequest<{ sourceExists?: boolean; businessesFound?: number; completedAt?: number | null }>(
      "agency.ops.migration.preview",
      {},
      list.migration ?? {},
    ),
  ]);

  const approvals = approvalsResult.approvals ?? [];
  const engagements = engagementsResult.engagements ?? [];
  const employees = employeesResult.employees ?? [];
  const finance = financeResult.finance ?? {};
  const pendingApprovals = approvals.length;
  const highRiskApprovals = approvals.filter((item) => item.risk === "high").length;
  const atRiskEngagements = engagements.filter((item) =>
    ["at_risk", "off_track"].includes(item.health ?? ""),
  ).length;
  const blockedEmployees = employees.filter((item) => item.availability === "blocked").length;
  const utilizationValues = employees
    .map((item) => item.utilizationPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const averageUtilization = utilizationValues.length
    ? Math.round(
        utilizationValues.reduce((sum, value) => sum + value, 0) / utilizationValues.length,
      )
    : 0;
  const overdueReceivables = Number(finance.overdueReceivables ?? 0);
  const migrationPending =
    migrationResult.sourceExists === true && migrationResult.completedAt == null;
  const collaborationState = collaboration.state ?? "unknown";
  const gaps: string[] = [];
  if (highRiskApprovals)
    gaps.push(
      `${highRiskApprovals} high-risk decision${highRiskApprovals === 1 ? "" : "s"} waiting`,
    );
  if (atRiskEngagements)
    gaps.push(
      `${atRiskEngagements} client engagement${atRiskEngagements === 1 ? "" : "s"} at risk`,
    );
  if (blockedEmployees)
    gaps.push(`${blockedEmployees} employee${blockedEmployees === 1 ? "" : "s"} blocked`);
  if (overdueReceivables > 0) gaps.push("Overdue receivables need collection");
  if (collaborationState !== "ready") gaps.push("Private team collaboration is not ready");
  if (migrationPending) gaps.push("Legacy business data is waiting to migrate");

  const nextActions: DashAgencyAction[] = [];
  if (highRiskApprovals || pendingApprovals) {
    nextActions.push({
      id: "approvals",
      label: "Clear approval queue",
      detail: `${pendingApprovals} pending · ${highRiskApprovals} high risk`,
      tone: highRiskApprovals ? "danger" : "warn",
      tab: "agency-operations",
    });
  }
  if (atRiskEngagements) {
    nextActions.push({
      id: "delivery",
      label: "Recover at-risk delivery",
      detail: `${atRiskEngagements} active engagement${atRiskEngagements === 1 ? "" : "s"} need intervention`,
      tone: "warn",
      tab: "agency-operations",
    });
  }
  if (collaborationState !== "ready" || migrationPending) {
    nextActions.push({
      id: "readiness",
      label: "Finish agency readiness",
      detail: migrationPending
        ? `${migrationResult.businessesFound ?? 0} legacy workspace(s) detected`
        : (collaboration.message ?? "Enable private collaboration"),
      tone: "primary",
      tab: "agency-operations",
    });
  }
  if (!nextActions.length) {
    nextActions.push({
      id: "operate",
      label: "Review the operating plan",
      detail: "Agency is healthy; confirm this week's priorities and capacity",
      tone: "primary",
      tab: "agency-operations",
    });
  }

  return {
    available: true,
    agencyId: agency.id,
    agencyName: agency.name,
    agencyRole: agency.role,
    agencyCount: agencies.length,
    kpis: dashboardResult.dashboard?.kpis ?? [],
    pendingApprovals,
    highRiskApprovals,
    activeEngagements: engagements.length,
    atRiskEngagements,
    employees: employees.length,
    humanEmployees: employees.filter((item) => item.kind === "human").length,
    aiEmployees: employees.filter((item) => item.kind === "ai").length,
    blockedEmployees,
    averageUtilization,
    overdueReceivables,
    grossMarginPercent: Number(finance.grossMarginPercent ?? 0),
    collaborationState,
    collaborationMessage: collaboration.message ?? "Private collaboration status unavailable",
    migrationPending,
    migrationBusinesses: migrationResult.businessesFound ?? 0,
    gaps,
    nextActions: nextActions.slice(0, 3),
    loadedAt: Date.now(),
  };
}

export async function loadDashboardData(
  state: { dashboard?: DashboardState; learn?: { tracks: TrackSummary[] } } & Record<
    string,
    unknown
  >,
  client: GatewayBrowserClient,
): Promise<void> {
  const ds = (state.dashboard ??= createInitialDashboardState());
  ds.loading = true;
  ds.error = null;
  ds.currentStepTitle = "";

  // Fire everything in parallel. Each request is wrapped so a single failure
  // doesn't black-hole the whole dashboard — the surface degrades to whatever
  // signal we DID get, which matches the operational "always show something"
  // principle of a real ops dashboard.
  const safe = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

  const [
    tracksRes,
    enrolledRes,
    subagentsRes,
    completedRes,
    tasksRes,
    insightsRes,
    workflowsRes,
    workflowRunsRes,
    cronRes,
    notesRes,
    nodesRes,
    agentsRes,
    revenueRes,
    clientsRes,
    businessesRes,
    disciplineRes,
    weekScoresRes,
    prioritiesRes,
    projectsRes,
    contentPagesRes,
    autonomyRes,
    historyRes,
    gitRes,
    agencyExecutiveRes,
  ] = await Promise.all([
    safe(client.request("learn.tracks.list", {}) as Promise<{ tracks: TrackSummary[] }>, {
      tracks: [],
    }),
    safe(client.request("vault.courses.enrolled", {}) as Promise<{ courses: EnrolledCourse[] }>, {
      courses: [],
    }),
    safe(
      client.request("subagents.list", {
        includeCompleted: false,
        compact: true,
        limit: 12,
      }) as Promise<{ subagents?: Array<Record<string, unknown>> }>,
      { subagents: [] },
    ),
    safe(
      client.request("kanban.listRecentlyCompleted", {
        limit: 500,
        sinceTs: Date.now() - DAY_MS,
      }) as Promise<{
        entries: Array<Record<string, unknown>>;
      }>,
      { entries: [] },
    ),
    safe(
      // kanban.tasks.list returns a BARE array, not `{tasks}`. Cast as unknown
      // so the downstream code can normalise either shape — earlier we read
      // `tasksRes.tasks` and silently got undefined → empty kanban lanes.
      client.request("kanban.tasks.list", {}) as Promise<unknown>,
      [] as unknown,
    ),
    safe(
      client.request("systems.insights.list", {}) as Promise<
        DashInsight[] | { insights?: DashInsight[] }
      >,
      [] as DashInsight[],
    ),
    safe(
      client.request("workflows.list", {}) as Promise<{
        workflows?: Array<Record<string, unknown>>;
      }>,
      { workflows: [] },
    ),
    safe(
      client.request("workflows.run.list", { limit: 20 }) as Promise<{
        runs?: Array<Record<string, unknown>>;
      }>,
      { runs: [] },
    ),
    safe(client.request("cron.list", {}) as Promise<{ jobs?: Array<Record<string, unknown>> }>, {
      jobs: [],
    }),
    safe(
      client.request("notes.list", { limit: 5 }) as Promise<{
        notes?: Array<Record<string, unknown>>;
      }>,
      { notes: [] },
    ),
    safe(client.request("node.list", {}) as Promise<{ nodes?: Array<Record<string, unknown>> }>, {
      nodes: [],
    }),
    safe(
      client.request("agents.list", {}) as Promise<{ agents?: Array<Record<string, unknown>> }>,
      { agents: [] },
    ),
    safe(
      client.request("business.income.stats", {}) as Promise<Record<string, unknown>>,
      {} as Record<string, unknown>,
    ),
    safe(
      client.request("business.clients.list", {}) as Promise<{
        clients?: Array<Record<string, unknown>>;
        schema?: unknown;
      }>,
      { clients: [] },
    ),
    safe(
      client.request("business.list", {}) as Promise<{
        businesses?: BusinessProfile[];
        activeId?: string | null;
      }>,
      { businesses: [], activeId: null },
    ),
    // Discipline plugin: skip the calls entirely while it's off.
    safe(
      (isTabAvailable("discipline")
        ? client.request("discipline.state", {})
        : Promise.resolve({})) as Promise<Record<string, unknown>>,
      {} as Record<string, unknown>,
    ),
    safe(
      (isTabAvailable("discipline")
        ? client.request("discipline.score.week", {})
        : Promise.resolve([])) as Promise<Array<Record<string, unknown>>>,
      [] as Array<Record<string, unknown>>,
    ),
    safe(
      client.request("systems.priorities.list", {}) as Promise<Array<Record<string, unknown>>>,
      [] as Array<Record<string, unknown>>,
    ),
    safe(
      // kanban.projects.list also returns a BARE array — same defensive
      // unwrap as kanban.tasks.list below.
      client.request("kanban.projects.list", {}) as Promise<unknown>,
      [] as unknown,
    ),
    safe(
      client.request("content.pages.list", { includeArchived: false }) as Promise<{
        pages?: Array<Record<string, unknown>>;
      }>,
      { pages: [] },
    ),
    safe(loadAutonomyStatus(client), {
      loading: false,
      error: "Autonomy unavailable",
    }),
    // ── "Where am I" grounding: named recently-finished subagent runs +
    //    the repo branch the operator is actually working on. These power
    //    the Daily Briefing's recent-activity lines (see synthesizeBriefing).
    safe(
      client.request("subagents.history", {
        limit: 12,
        since: Date.now() - DAY_MS,
      }) as Promise<{ history?: Array<Record<string, unknown>> }>,
      { history: [] },
    ),
    safe(
      client.request("git.status", {}) as Promise<{ branch?: string; remote?: string | null }>,
      {} as { branch?: string; remote?: string | null },
    ),
    safe(loadAgencyExecutive(client), createEmptyAgencyExecutive()),
  ]);

  ds.agencyExecutive = agencyExecutiveRes;

  // ── Learning
  ds.learningPath = tracksRes.tracks ?? [];
  ds.enrolledCourses = enrolledRes.courses ?? [];

  const inProgress = ds.learningPath.filter((t) => t.progress && !t.progress.completedAt);
  const activeTrack = inProgress[0] ?? ds.learningPath[0] ?? null;
  ds.currentTrack = activeTrack;
  if (activeTrack?.progress?.currentStepId && activeTrack.steps) {
    const step = activeTrack.steps.find((s) => s.id === activeTrack.progress!.currentStepId);
    ds.currentStepTitle = step?.title ?? activeTrack.title;
  }

  // ── Running agents
  const subRaw = subagentsRes?.subagents ?? [];
  ds.runningAgents = subRaw
    .filter((s) => {
      const status = String(s.status ?? "").toLowerCase();
      return status === "running" || status === "pending";
    })
    .slice(0, 6)
    .map((s) => {
      const startedAt = Number(s.startedAt ?? s.createdAt ?? Date.now());
      return {
        runId: String(s.runId ?? ""),
        sessionKey: String(s.sessionKey ?? s.childSessionKey ?? ""),
        label: String(s.label ?? "(unlabelled)"),
        status: String(s.status ?? "running"),
        task: String(s.task ?? "").slice(0, 160),
        startedAt,
        durationMs: Math.max(0, Date.now() - startedAt),
        progress:
          typeof s.progress === "number" && Number.isFinite(s.progress)
            ? (s.progress as number)
            : undefined,
      };
    });

  // ── Recently done + completions trend
  const completedRaw = completedRes?.entries ?? [];
  ds.recentDone = completedRaw.slice(0, 6).map((e) => ({
    taskId: String(e.taskId ?? ""),
    title: String((e as any).title ?? ""),
    projectName: String((e as any).projectName ?? "—"),
    completedAt: Number((e as any).completedAt ?? 0),
    durationMs: Number((e as any).durationMs ?? 0),
    status: ((e as any).status as "success" | "error" | undefined) ?? "success",
  }));
  const last24 = Date.now() - DAY_MS;
  ds.completions24h = completedRaw.filter(
    (e) => Number((e as any).completedAt ?? 0) >= last24,
  ).length;

  // ── "Where am I" grounding: named subagent runs that recently finished +
  //    the branch/repo currently in play. The briefing reads these to surface
  //    concrete, recent activity instead of generic counts.
  const historyRaw = (historyRes as { history?: Array<Record<string, unknown>> })?.history ?? [];
  ds.recentRuns = historyRaw
    .filter((h) => Number((h as any).endedAt ?? 0) > 0)
    .sort((a, b) => Number((b as any).endedAt ?? 0) - Number((a as any).endedAt ?? 0))
    .slice(0, 3)
    .map((h) => {
      const rawStatus = String((h as any).status ?? "complete");
      const status: DashRecentRun["status"] =
        rawStatus === "error" ? "error" : rawStatus === "timeout" ? "timeout" : "complete";
      const label =
        String((h as any).label ?? "").trim() ||
        String((h as any).task ?? "")
          .trim()
          .slice(0, 60) ||
        "agent run";
      return {
        runId: String((h as any).runId ?? ""),
        label,
        status,
        endedAt: Number((h as any).endedAt ?? 0),
      } satisfies DashRecentRun;
    });
  const gitInfo = (gitRes as { branch?: string; remote?: string | null }) ?? {};
  ds.gitBranch =
    typeof gitInfo.branch === "string" && gitInfo.branch && gitInfo.branch !== "(detached)"
      ? gitInfo.branch
      : null;
  ds.gitRepo =
    typeof gitInfo.remote === "string" && gitInfo.remote
      ? gitInfo.remote.replace(/^.*[/:]/, "").replace(/\.git$/, "")
      : null;

  // ── Activity timeline buckets (last 24h hourly) ──────────────
  const nowMs = Date.now();
  const hourBuckets = new Array(24).fill(0);
  for (const entry of completedRaw) {
    const ts = Number((entry as any).completedAt ?? 0);
    if (!ts) continue;
    const hoursAgo = Math.floor((nowMs - ts) / 3_600_000);
    if (hoursAgo < 0 || hoursAgo > 23) continue;
    // Position 23 = now, position 0 = 23h ago. Older buckets fill from the left.
    hourBuckets[23 - hoursAgo] += 1;
  }
  ds.completionsByHour = hourBuckets;
  // Running-agent overlay: synthesize a smoothed line of "agents likely
  // running per hour" from the live count (we don't have history yet, so use a
  // single-point sample replicated across the most recent 3h to show "now").
  ds.runningByHour = hourBuckets.map((_v, i) => (i >= 21 ? ds.runningAgents.length : 0));
  ds.completionsSpark = hourBuckets.slice(-12);
  ds.activeSpark = ds.runningByHour.slice(-12);

  // ── Project velocity (top 5 projects by completions, last window) ─
  const projectCounts = new Map<string, number>();
  for (const e of completedRaw) {
    const name = String((e as any).projectName ?? "—");
    projectCounts.set(name, (projectCounts.get(name) ?? 0) + 1);
  }
  const palette = ["#ffd700", "#22c55e", "#38bdf8", "#a855f7", "#f59e0b", "#ef4444"];
  ds.projectVelocity = [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([projectName, count], i) => ({
      projectName,
      count,
      color: palette[i % palette.length],
    }));

  // ── Priority + blocked tasks
  const tasksRaw = unwrapArray(tasksRes, ["tasks"]);
  const inProgressTasks = tasksRaw.filter((t) => {
    const status = String((t as any).status ?? "");
    return status === "in_progress" || status === "in-progress" || status === "doing";
  });
  const blockedTasks = tasksRaw.filter((t) => {
    const status = String((t as any).status ?? "").toLowerCase();
    return status === "blocked" || (t as any).blocked === true;
  });
  ds.blockedCount = blockedTasks.length;

  // Sort by priority (high > med > low) then updatedAt desc
  const priorityRank = (p: string): number =>
    p === "high" || p === "urgent" ? 0 : p === "medium" || p === "med" ? 1 : 2;
  const allPriority = [...blockedTasks, ...inProgressTasks]
    .sort((a, b) => {
      const pa = priorityRank(String((a as any).priority ?? "low"));
      const pb = priorityRank(String((b as any).priority ?? "low"));
      if (pa !== pb) return pa - pb;
      return Number((b as any).updatedAt ?? 0) - Number((a as any).updatedAt ?? 0);
    })
    .slice(0, 5)
    .map((t) => ({
      id: String((t as any).id ?? ""),
      projectId: typeof (t as any).projectId === "string" ? (t as any).projectId : undefined,
      title: String((t as any).title ?? "Untitled task"),
      projectName: String((t as any).projectName ?? "—"),
      status: String((t as any).status ?? ""),
      priority: String((t as any).priority ?? "low"),
      updatedAt: Number((t as any).updatedAt ?? 0),
      blocked:
        String((t as any).status ?? "").toLowerCase() === "blocked" || (t as any).blocked === true,
    }));
  ds.priorityTasks = allPriority;

  // ── Agent roster (registered agents + per-agent recent activity) ─
  const agentsRaw = (agentsRes?.agents ?? []) as Array<Record<string, unknown>>;
  // Count subagent runs per requester/agent label in the recently-completed
  // window so each agent gets a "runs today" + success-rate read.
  const perAgentRuns = new Map<string, { runs: number; success: number }>();
  for (const s of subRaw) {
    const key = String(s.agentId ?? s.label ?? "").toLowerCase();
    if (!key) continue;
    const cur = perAgentRuns.get(key) ?? { runs: 0, success: 0 };
    cur.runs += 1;
    if (String(s.status ?? "").toLowerCase() !== "error") cur.success += 1;
    perAgentRuns.set(key, cur);
  }
  ds.agentRoster = agentsRaw.slice(0, 6).map((a) => {
    const id = String(a.id ?? a.agentId ?? "");
    const key = id.toLowerCase();
    const counts = perAgentRuns.get(key) ?? { runs: 0, success: 0 };
    const successPct = counts.runs > 0 ? Math.round((counts.success / counts.runs) * 100) : 100;
    return {
      id,
      name: String(a.name ?? a.displayName ?? id ?? "Agent"),
      backend: String(a.backend ?? a.coderBackend ?? a.provider ?? "claude"),
      runsRecent: counts.runs,
      successPct,
      active: counts.runs > 0,
    };
  });

  // ── Workflows
  const wfRaw = (workflowsRes?.workflows ?? []) as Array<Record<string, unknown>>;
  const wfRunsRaw = (workflowRunsRes?.runs ?? []) as Array<Record<string, unknown>>;
  const runByWorkflow = new Map<string, { status: string; ts: number }>();
  for (const r of wfRunsRaw) {
    const wfId = String(r.workflowId ?? r.id ?? "");
    if (!wfId) continue;
    const ts = Number(r.startedAt ?? r.createdAt ?? r.endedAt ?? 0);
    const existing = runByWorkflow.get(wfId);
    if (!existing || ts > existing.ts) {
      runByWorkflow.set(wfId, { status: String(r.status ?? "unknown"), ts });
    }
  }
  ds.workflows = wfRaw.slice(0, 6).map((w) => {
    const id = String(w.id ?? "");
    const last = runByWorkflow.get(id);
    const rawStatus = last?.status ?? String(w.status ?? "idle");
    const status: DashWorkflow["status"] =
      rawStatus === "running"
        ? "running"
        : rawStatus === "paused"
          ? "paused"
          : rawStatus === "error" || rawStatus === "failed"
            ? "error"
            : rawStatus === "idle" || rawStatus === "stopped" || rawStatus === "completed"
              ? "idle"
              : "unknown";
    return {
      id,
      name: String(w.name ?? w.title ?? id ?? "Workflow"),
      status,
      kind: String(w.kind ?? "manual"),
      lastRunAt: last?.ts,
    };
  });

  // ── Cron jobs
  const cronRaw = (cronRes?.jobs ?? []) as Array<Record<string, unknown>>;
  ds.cronJobs = cronRaw.slice(0, 6).map((j) => ({
    id: String(j.id ?? ""),
    label: String(j.label ?? j.name ?? j.command ?? "Job"),
    schedule: String(j.schedule ?? j.cron ?? j.spec ?? ""),
    nextRunAt: Number(j.nextRunAt ?? j.nextRun ?? 0) || undefined,
    lastRunAt: Number(j.lastRunAt ?? j.lastRun ?? 0) || undefined,
    intervalMs: resolveCronIntervalMs(j),
    status: typeof j.status === "string" ? j.status : undefined,
    enabled: j.enabled !== false,
  }));

  // ── Notes (recent captures)
  const notesRaw = (notesRes?.notes ?? []) as Array<Record<string, unknown>>;
  ds.notes = notesRaw.slice(0, 5).map((n) => ({
    id: String(n.id ?? ""),
    title: String(n.title ?? n.heading ?? "Note"),
    preview: String(n.preview ?? n.body ?? n.content ?? "").slice(0, 140),
    updatedAt: Number(n.updatedAt ?? n.createdAt ?? 0),
  }));

  // ── Nodes (federation roster)
  const nodesRaw = (nodesRes?.nodes ?? []) as Array<Record<string, unknown>>;
  ds.nodes = nodesRaw.slice(0, 8).map((n) => ({
    id: String(n.id ?? n.nodeId ?? ""),
    name: String(n.name ?? n.label ?? n.id ?? "Node"),
    online: n.online !== false,
    isLocal: Boolean(n.isLocal ?? n.local ?? false),
    kind: String(n.kind ?? n.type ?? ""),
    role:
      typeof n.role === "string"
        ? n.role
        : typeof n.federationRole === "string"
          ? n.federationRole
          : undefined,
    lastSeenAt: normalizeTimestamp(n.lastSeenAt ?? n.lastSeen ?? n.updatedAt ?? n.heartbeatAt),
  }));

  // ── System health (no hardware endpoint surfaced — synthesize a
  // sensible read from agent load + node availability so the gauges
  // always have something to show).
  const onlineNodes = ds.nodes.filter((n) => n.online).length;
  const totalNodes = Math.max(1, ds.nodes.length);
  // Agent load = running / cap. Cap derived from MAX_PARALLEL env (default 4).
  const agentCap = 4;
  const agentLoad = Math.min(100, Math.round((ds.runningAgents.length / agentCap) * 100));
  // CPU/memory: best-effort estimate (replace when a hardware.sample method
  // exists). Heuristic: load proxied from active agents + workflow runs.
  const activeWf = ds.workflows.filter((w) => w.status === "running").length;
  const cpuEst = Math.min(95, agentLoad / 1.5 + activeWf * 5);
  const memEst = Math.min(90, 25 + ds.runningAgents.length * 6 + activeWf * 4);
  ds.systemHealth = {
    cpu: Math.round(cpuEst),
    memory: Math.round(memEst),
    agentLoad,
    nodesOnline: onlineNodes,
    nodesTotal: ds.nodes.length || 1,
  };

  // ── Revenue (business.income.stats) ──────────────────────────
  const rev = revenueRes as Record<string, unknown>;
  const dailyRaw = (rev.dailyData as Array<{ amount?: number }>) ?? [];
  // Pad/trim to exactly 30 buckets, newest-last (server already returns 30
  // oldest→newest; tolerate other lengths defensively).
  const daily30 = new Array(30).fill(0);
  for (let i = 0; i < Math.min(dailyRaw.length, 30); i++) {
    const fromEnd = dailyRaw.length - 1 - i;
    daily30[29 - i] = Number(dailyRaw[fromEnd]?.amount ?? 0);
  }
  const streamsRaw = (rev.incomeStreams as Array<Record<string, unknown>>) ?? [];
  const streamTotals = new Map<string, number>();
  for (const t of (rev.recentTransactions as Array<Record<string, unknown>>) ?? []) {
    const streamId = String(t.streamId ?? "other");
    streamTotals.set(streamId, (streamTotals.get(streamId) ?? 0) + Number(t.amount ?? 0));
  }
  const streamLabel = (id: string): string => {
    const s = streamsRaw.find((x) => String(x.id ?? "") === id);
    return String(s?.name ?? s?.label ?? id);
  };
  const last7 = daily30.slice(-7).reduce((sum, value) => sum + value, 0);
  const prev7 = daily30.slice(-14, -7).reduce((sum, value) => sum + value, 0);
  ds.revenue = {
    today: Number(rev.today ?? 0),
    week: Number(rev.week ?? 0),
    month: Number(rev.month ?? 0),
    year: Number(rev.year ?? 0),
    allTime: Number(rev.allTime ?? 0),
    trend7d: prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0,
    daily30,
    currency: String(rev.currency ?? "$"),
    topStreams: [...streamTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, amount]) => ({ label: streamLabel(id), amount })),
  };

  // ── Discipline (today's blocks + week-long score trend) ──────
  const disc = disciplineRes as Record<string, unknown>;
  const blocksRaw = (disc.blocks as Array<Record<string, unknown>>) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const blockCompletions = (disc.blockCompletions as Array<Record<string, unknown>>) ?? [];
  const doneIds = new Set(
    blockCompletions
      .filter((c) => String(c.date ?? "") === today)
      .map((c) => String(c.blockId ?? c.id ?? "")),
  );
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const blocks: DashDisciplineBlock[] = blocksRaw.map((b) => {
    const startMinute = Number(b.startMinute ?? b.startMin ?? 0);
    const endMinute = Number(b.endMinute ?? b.endMin ?? startMinute + 60);
    const id = String(b.id ?? "");
    return {
      id,
      label: String(b.label ?? b.title ?? "Block"),
      startMinute,
      endMinute,
      done: doneIds.has(id),
      active: nowMin >= startMinute && nowMin < endMinute,
    };
  });
  blocks.sort((a, b) => a.startMinute - b.startMinute);
  const doneCount = blocks.filter((b) => b.done).length;
  const todayCompletionPct = blocks.length > 0 ? doneCount / blocks.length : 0;
  // Week scores: backend returns Array<{ score, ratio, ... }>; pull `score`.
  const weekArr = (weekScoresRes as Array<Record<string, unknown>>) ?? [];
  const weekScores = new Array(7).fill(0);
  for (let i = 0; i < Math.min(weekArr.length, 7); i++) {
    weekScores[i] = Math.round(Number(weekArr[i]?.score ?? 0));
  }
  const currentBlock = blocks.find((b) => b.active);
  const todayScore =
    weekArr.length > 0
      ? Math.round(Number(weekArr[weekArr.length - 1]?.score ?? 0))
      : Math.round(todayCompletionPct * 100);
  ds.discipline = {
    blocks,
    todayCompletionPct,
    todayScore,
    weekScores,
    currentBlockLabel: currentBlock
      ? `${currentBlock.label} · ${formatBlockTime(currentBlock.startMinute)}–${formatBlockTime(currentBlock.endMinute)}`
      : null,
    nowMinute: nowMin,
  };

  // ── Client pipeline (CRM stage breakdown) ────────────────────
  // Mirror the /clients kanban grouping exactly: resolve the same group-by
  // property (persisted pref → schema default), read each client's value from
  // `c.data[groupProp]` first (the dynamic Notion-backed shape used by the
  // clients page), then fall back to the legacy flat status/stage fields so
  // older rows still bucket somewhere. Wedge order/colours follow the schema's
  // declared options when present, with the 6-colour palette as the fallback.
  const clientsRaw = (clientsRes?.clients as Array<Record<string, unknown>>) ?? [];
  const clientsSchema = (clientsRes?.schema as NotionDbSchema | null) ?? null;
  const stagePalette = ["#38bdf8", "#22c55e", "#f59e0b", "#a855f7", "#ef4444", "#ffd700"];
  const groupProp = (() => {
    const pref = loadClientsGroupByPref();
    if (pref && clientsSchema?.properties?.[pref]) return pref;
    return getDefaultGroupBy(clientsSchema);
  })();
  const isMultiSelect = groupProp
    ? clientsSchema?.properties?.[groupProp]?.type === "multi_select"
    : false;

  const clientStageValue = (c: Record<string, unknown>): string => {
    const data = (c.data as Record<string, unknown> | undefined) ?? undefined;
    const raw = groupProp ? data?.[groupProp] : undefined;
    if (Array.isArray(raw)) return raw.length ? String(raw[0]) : "—";
    if (typeof raw === "string" && raw) return raw;
    // Legacy fallback for rows predating the dynamic schema.
    const legacy = c.status ?? c.stage ?? c.pipeline;
    return legacy ? String(legacy) : "—";
  };

  const stageCounts = new Map<string, number>();
  for (const c of clientsRaw) {
    if (isMultiSelect && groupProp) {
      const data = (c.data as Record<string, unknown> | undefined) ?? undefined;
      const raw = data?.[groupProp];
      const vals = Array.isArray(raw) && raw.length ? raw.map((v) => String(v)) : ["—"];
      for (const v of vals) stageCounts.set(v, (stageCounts.get(v) ?? 0) + 1);
    } else {
      const stage = clientStageValue(c);
      stageCounts.set(stage, (stageCounts.get(stage) ?? 0) + 1);
    }
  }

  // Respect the schema's declared option order/colours when available.
  const schemaOptions = groupProp ? getGroupOptions(clientsSchema, groupProp) : [];
  const optionOrder = new Map(schemaOptions.map((o, i) => [o.name, i] as const));
  const stages = [...stageCounts.entries()]
    .sort((a, b) => {
      const oa = optionOrder.get(a[0]);
      const ob = optionOrder.get(b[0]);
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return b[1] - a[1];
    })
    .map(([stage, count], i) => ({
      stage,
      count,
      color: stagePalette[i % stagePalette.length],
    }));
  const hotnessRank = (v: unknown): number => {
    const s = String(v ?? "").toLowerCase();
    if (s === "hot" || s === "high" || s === "urgent") return 0;
    if (s === "warm" || s === "medium") return 1;
    return 2;
  };
  const topClients = clientsRaw
    .slice()
    .sort((a, b) => {
      const ha = hotnessRank(a.temperature ?? a.priority);
      const hb = hotnessRank(b.temperature ?? b.priority);
      if (ha !== hb) return ha - hb;
      return Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0);
    })
    .slice(0, 5)
    .map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? c.company ?? c.email ?? "Client"),
      stage: String(c.status ?? c.stage ?? "lead"),
      hot: hotnessRank(c.temperature ?? c.priority),
    }));
  ds.pipeline = { total: clientsRaw.length, stages, topClients };

  // ── Focus & Priorities (from systems.priorities.list) ────────
  const priorRaw = (prioritiesRes as Array<Record<string, unknown>>) ?? [];
  const activePriorities = priorRaw.filter(
    (p) => String(p.status ?? "active").toLowerCase() === "active",
  );
  // Rank 1 = focus. Sort by rank (asc).
  activePriorities.sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99));
  const focusList: DashFocusPriority[] = activePriorities.slice(0, 4).map((p) => {
    const outcomes = (p.outcomes as Array<{ description?: string; completed?: boolean }>) ?? [];
    const next = outcomes.find((o) => !o.completed)?.description;
    return {
      id: String(p.id ?? ""),
      title: String(p.title ?? "Priority"),
      description: typeof p.description === "string" ? p.description : undefined,
      quarter: String(p.quarter ?? ""),
      progress: Math.max(0, Math.min(100, Math.round(Number(p.progress ?? 0)))),
      status: String(p.status ?? "active").toLowerCase() as "active" | "completed" | "paused",
      isFocus: Number(p.rank ?? 99) === 1,
      nextStep: next,
    };
  });
  const avgProg =
    focusList.length > 0
      ? Math.round(focusList.reduce((s, p) => s + p.progress, 0) / focusList.length)
      : 0;
  ds.focus = {
    total: priorRaw.length,
    activeCount: activePriorities.length,
    avgProgress: avgProg,
    priorities: focusList,
    focusTitle: focusList.find((p) => p.isFocus)?.title ?? focusList[0]?.title ?? null,
  };

  // ── Kanban lanes (Todo / In Progress / Blocked / Done today) ─
  const projectsRaw = unwrapArray(projectsRes, ["projects"]);
  const projectNameById = new Map<string, string>();
  const projectById = new Map<string, Record<string, unknown>>();
  for (const p of projectsRaw) {
    const projectId = String(p.id ?? "");
    projectNameById.set(projectId, String(p.name ?? "Project"));
    if (projectId) projectById.set(projectId, p);
  }
  const businesses = Array.isArray(businessesRes?.businesses) ? businessesRes.businesses : [];
  const businessById = new Map(businesses.map((business) => [business.id, business] as const));
  const clientRecords = clientsRaw as unknown as DynamicClientRecord[];
  const clientsByBusiness = await loadClientsByBusiness(client, businesses, clientRecords);
  const commandClients =
    businesses.length > 0 ? [...clientsByBusiness.values()].flat() : clientRecords;
  // Resolve client→project links from the generic relations store. The Notion
  // client row usually has no project column, so the client→project link
  // lives here. No batch RPC exists, so fan out one relations.list per client
  // in parallel (degrades to empty on any failure — never blocks the card).
  //
  // The CRM can hold hundreds of clients, but the card only ever renders ones
  // that are in progress — so only fan out over those candidates (clients whose
  // own status is active, OR that already have an in-progress direct project).
  // That keeps the relation lookups bounded without dropping any rendered row.
  const activeClientStatuses = new Set(["in_progress", "active", "engaged"]);
  const relationCandidates = commandClients.filter((c) => {
    const record = c as unknown as Record<string, unknown>;
    if (activeClientStatuses.has(clientStatus(record))) return true;
    const directPid = stringDataValue(record, [
      "projectId",
      "Project ID",
      "activeProjectId",
      "Active Project ID",
    ]);
    if (directPid && normalizeStatus(projectById.get(directPid)?.status) === "in_progress")
      return true;
    return false;
  });
  const relationsByClient = new Map<string, string[]>();
  await Promise.all(
    relationCandidates.slice(0, 400).map(async (c) => {
      try {
        const res = (await client.request("relations.list", {
          type: "client",
          id: c.id,
          peerType: "project",
        })) as { relations?: Array<{ id?: unknown }> };
        const ids = (res?.relations ?? [])
          .map((r) => String(r?.id ?? ""))
          .filter((id) => id !== "");
        if (ids.length > 0) relationsByClient.set(c.id, ids);
      } catch {
        /* no relations for this client / RPC unavailable — skip */
      }
    }),
  );
  ds.clientsInProgress = shapeClientsInProgress(
    commandClients,
    clientsSchema,
    businessById,
    projectById,
    tasksRaw as Array<Record<string, unknown>>,
    relationsByClient,
  );
  ds.businessSummaries =
    businesses.length > 0
      ? await loadBusinessFederationSummaries(
          client,
          businesses,
          clientsByBusiness,
          projectsRaw,
          tasksRaw,
        ).catch(() => [])
      : [];
  ds.autonomyMini = shapeAutonomyMini(autonomyRes);

  const laneTodo: Array<Record<string, unknown>> = [];
  const laneIp: Array<Record<string, unknown>> = [];
  const laneBlocked: Array<Record<string, unknown>> = [];
  for (const t of tasksRaw) {
    const status = String((t as any).status ?? "").toLowerCase();
    if (status === "blocked") laneBlocked.push(t);
    else if (status === "in_progress" || status === "in-progress" || status === "doing")
      laneIp.push(t);
    else if (status === "todo" || status === "open" || status === "" || status === "backlog")
      laneTodo.push(t);
  }
  const taskRowMap = (rows: Array<Record<string, unknown>>) =>
    rows
      .sort((a, b) => Number((b as any).updatedAt ?? 0) - Number((a as any).updatedAt ?? 0))
      .slice(0, 3)
      .map((r) => ({
        id: String((r as any).id ?? ""),
        projectId: typeof (r as any).projectId === "string" ? (r as any).projectId : undefined,
        title: String((r as any).title ?? "Untitled"),
        project:
          projectNameById.get(String((r as any).projectId ?? "")) ??
          String((r as any).projectName ?? "—"),
      }));
  const doneTodayRows = completedRaw.filter((e) => Number((e as any).completedAt ?? 0) >= last24);
  ds.kanbanLanes = {
    counts: {
      todo: laneTodo.length,
      inProgress: laneIp.length,
      blocked: laneBlocked.length,
      doneToday: doneTodayRows.length,
    },
    lanes: {
      todo: taskRowMap(laneTodo),
      inProgress: taskRowMap(laneIp),
      blocked: taskRowMap(laneBlocked),
      doneToday: doneTodayRows.slice(0, 3).map((r) => ({
        id: String((r as any).taskId ?? ""),
        projectId: typeof (r as any).projectId === "string" ? (r as any).projectId : undefined,
        title: String((r as any).title ?? ""),
        project: String((r as any).projectName ?? "—"),
      })),
    },
  };

  // ── In-progress projects with stage breakdown ────────────────
  const projectStats = new Map<
    string,
    { total: number; ip: number; done: number; blocked: number }
  >();
  for (const t of tasksRaw) {
    const pid = String((t as any).projectId ?? "");
    if (!pid) continue;
    const s = projectStats.get(pid) ?? { total: 0, ip: 0, done: 0, blocked: 0 };
    s.total += 1;
    const status = String((t as any).status ?? "").toLowerCase();
    if (status === "in_progress" || status === "in-progress" || status === "doing") s.ip += 1;
    else if (status === "done" || status === "completed") s.done += 1;
    else if (status === "blocked") s.blocked += 1;
    projectStats.set(pid, s);
  }
  ds.projectsInProgress = [...projectStats.entries()]
    .filter(([, s]) => s.ip > 0 || s.blocked > 0 || s.total > s.done)
    .map(([id, s]) => ({
      id,
      name: projectNameById.get(id) ?? "Project",
      total: s.total,
      inProgress: s.ip,
      done: s.done,
      blocked: s.blocked,
      progress: s.total > 0 ? Math.round((s.done / s.total) * 100) : 0,
    }))
    .sort((a, b) => b.inProgress + b.blocked - (a.inProgress + a.blocked))
    .slice(0, 5);

  // ── Content surfaces ─────────────────────────────────────────
  const pagesRaw = (contentPagesRes?.pages as Array<Record<string, unknown>>) ?? [];
  const surfaceColors: Record<string, string> = {
    instagram: "#e1306c",
    youtube: "#ff0000",
    tiktok: "#22d3ee",
    twitter: "#1d9bf0",
    x: "#1d9bf0",
    blog: "#a855f7",
    podcast: "#f59e0b",
    newsletter: "#22c55e",
    website: "#ffd700",
  };
  const fallbackColors = ["#ffd700", "#22c55e", "#38bdf8", "#a855f7", "#f59e0b", "#ef4444"];
  const surfaceCounts = new Map<string, { count: number; published: number }>();
  for (const p of pagesRaw) {
    const surface = String((p as any).surface ?? "page").toLowerCase();
    const status = String((p as any).status ?? "").toLowerCase();
    const cur = surfaceCounts.get(surface) ?? { count: 0, published: 0 };
    cur.count += 1;
    if (status === "published" || status === "live") cur.published += 1;
    surfaceCounts.set(surface, cur);
  }
  const surfacesShaped: DashContentSurface[] = [...surfaceCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([surface, v], i) => ({
      surface,
      count: v.count,
      published: v.published,
      color: surfaceColors[surface] ?? fallbackColors[i % fallbackColors.length],
    }));
  ds.content = {
    total: pagesRaw.length,
    surfaces: surfacesShaped,
    recent: pagesRaw
      .slice()
      .sort((a, b) => Number((b as any).updatedAt ?? 0) - Number((a as any).updatedAt ?? 0))
      .slice(0, 4)
      .map((p) => ({
        id: String((p as any).id ?? ""),
        name: String((p as any).name ?? "Page"),
        surface: String((p as any).surface ?? "page"),
        status: String((p as any).status ?? "draft"),
        updatedAt: Number((p as any).updatedAt ?? 0),
      })),
  };

  // ── Federation overview (kind breakdown) ─────────────────────
  const kindCounts = new Map<string, number>();
  for (const n of ds.nodes) {
    const kind = (n.kind || (n.isLocal ? "local" : "node")).toLowerCase();
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const fedColors: Record<string, string> = {
    local: "#ffd700",
    satellite: "#22d3ee",
    sat: "#22d3ee",
    device: "#a855f7",
    agent: "#22c55e",
    gateway: "#f59e0b",
    node: "#38bdf8",
  };
  const byKind = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count], i) => ({
      kind,
      count,
      color: fedColors[kind] ?? fallbackColors[i % fallbackColors.length],
    }));
  ds.federationOverview = {
    totalNodes: ds.nodes.length,
    onlineNodes: ds.nodes.filter((n) => n.online).length,
    byKind,
    hasRemoteLink: ds.nodes.some((n) => !n.isLocal && n.online),
  };

  // ── Insights (from systems-intelligence). Normalise shape: handler returns
  // a bare array but defensive against `{ insights: [...] }` future shape.
  const rawInsights = Array.isArray(insightsRes)
    ? insightsRes
    : ((insightsRes as { insights?: DashInsight[] })?.insights ?? []);
  const backendInsights = rawInsights.filter(
    (i): i is DashInsight => !!i && typeof i === "object" && typeof i.title === "string",
  );
  // Always synthesize client-side insights from the data we just loaded so
  // the AI Recommendations card has signal even when the systems-intelligence
  // backend is empty (the prior behaviour — the card was blank for any user
  // who hadn't seeded Values + Priorities). Merge backend + synthesized,
  // backend wins on the same id, severity-sort.
  const synthesized = synthesizeProactiveInsights(ds, tasksRaw);
  const seenIds = new Set(backendInsights.map((i) => i.id));
  const merged = [...backendInsights, ...synthesized.filter((i) => !seenIds.has(i.id))];
  const severityRank = (s: string) =>
    s === "high" ? 0 : s === "medium" ? 1 : s === "info" ? 2 : 3;
  merged.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  // Drop anything the operator has dismissed or is currently snoozing. The
  // sets persist on `ds`, so dismissals survive the 30s auto-refresh.
  const nowForSnooze = Date.now();
  const visible = merged.filter(
    (i) => !ds.dismissedInsights.has(i.id) && !((ds.snoozedInsights.get(i.id) ?? 0) > nowForSnooze),
  );

  // Split project-creation suggestions out of the recommendations list — they
  // get richer "Create project" controls in the Suggested Projects card.
  const projectInsights = visible.filter((i) => i.suggestionKind === "create-project");
  ds.insights = visible.filter((i) => i.suggestionKind !== "create-project").slice(0, 8);
  ds.suggestedProjects = buildSuggestedProjects(ds, projectInsights);
  ds.ceoInsights = computeInsights(ds);

  // ── KPIs (ops-first, replaces learning-only quickStats)
  ds.kpis = deriveKpis(ds);
  ds.quickStats = deriveLearningQuickStats(ds); // kept for the learning slice

  // ── Briefing — the CEO synthesis. Done last so it reads everything above.
  ds.briefing = synthesizeBriefing(ds);

  // Treat empty as "no operational signal AND no learning data" — otherwise
  // the ops dashboard is the primary surface and we render it.
  ds.isEmpty =
    ds.runningAgents.length === 0 &&
    ds.recentDone.length === 0 &&
    ds.priorityTasks.length === 0 &&
    ds.learningPath.length === 0 &&
    ds.enrolledCourses.length === 0;

  if (ds.isEmpty) {
    ds.recommendedCourses = getPlaceholderRecommendations();
    ds.achievements = getPlaceholderAchievements();
  } else {
    ds.recommendedCourses = [];
    ds.achievements = [];
  }

  ds.loading = false;
}

export function setDashboardUserName(state: { dashboard?: DashboardState }, name: string): void {
  if (state.dashboard) state.dashboard.userName = name;
}

// ── KPI derivation (operational) ─────────────────────────────

function deriveKpis(ds: DashboardState): QuickStat[] {
  const running = ds.runningAgents.length;
  const doneToday = ds.completions24h;
  const blocked = ds.blockedCount;
  const inProgress = ds.priorityTasks.filter((t) => !t.blocked).length;
  // Completion rate: of the last 30 recently-completed, how many succeeded?
  const successCount = ds.recentDone.filter((e) => e.status !== "error").length;
  const successRate = ds.recentDone.length
    ? Math.round((successCount / ds.recentDone.length) * 100)
    : 100;
  // Velocity proxy: completions per active agent (capped 999).
  const velocity = running > 0 ? Math.min(999, Math.round(doneToday / running)) : doneToday;

  return [
    {
      label: "Active Agents",
      value: running,
      icon: "bot",
      tone: running > 0 ? "primary" : ("neutral" as any),
      trend: running > 0 ? "up" : "neutral",
      deltaLabel: running > 0 ? "running now" : "idle",
    },
    {
      label: "Done Today",
      value: doneToday,
      icon: "checkCircle",
      tone: "ok",
      trend: doneToday > 0 ? "up" : "neutral",
      deltaLabel: doneToday > 0 ? "tasks shipped" : "no completions yet",
    },
    {
      label: "In Progress",
      value: inProgress,
      icon: "play",
      tone: "primary",
      trend: inProgress > 0 ? "up" : "neutral",
      deltaLabel: inProgress > 0 ? "moving" : "queue clear",
    },
    {
      label: "Blocked",
      value: blocked,
      icon: "alertCircle",
      tone: blocked > 0 ? "danger" : "ok",
      trend: blocked > 0 ? "down" : "neutral",
      deltaLabel: blocked > 0 ? "needs attention" : "no blockers",
    },
    {
      label: "Success Rate",
      value: successRate + "%",
      icon: "barChart",
      tone: successRate >= 80 ? "ok" : successRate >= 50 ? "warn" : "danger",
      trend: successRate >= 80 ? "up" : "down",
      deltaLabel: "last " + ds.recentDone.length + " runs",
    },
    {
      label: "Throughput",
      value: velocity,
      icon: "zap",
      tone: "primary",
      trend: velocity > 0 ? "up" : "neutral",
      deltaLabel: "per agent / 24h",
    },
  ];
}

// ── Learning-only stats (kept for compatibility with the learning section) ──

function deriveLearningQuickStats(ds: DashboardState): QuickStat[] {
  const completedTracks = ds.learningPath.filter((t) => t.progress?.completedAt).length;
  const completedSteps = ds.learningPath.reduce(
    (sum, t) => sum + (t.progress?.completedSteps?.length ?? 0),
    0,
  );
  const totalSteps = ds.learningPath.reduce((sum, t) => sum + t.steps.length, 0);
  return [
    {
      label: "Tracks Done",
      value: completedTracks,
      icon: "checkCircle",
      trend: completedTracks > 0 ? "up" : "neutral",
    },
    {
      label: "Lessons",
      value: completedSteps,
      icon: "book",
      trend: completedSteps > 0 ? "up" : "neutral",
    },
    {
      label: "Enrolled",
      value: ds.enrolledCourses.length,
      icon: "layout",
      trend: ds.enrolledCourses.length > 0 ? "up" : "neutral",
    },
    {
      label: "Progress",
      value: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) + "%" : "0%",
      icon: "barChart",
      trend: completedSteps > 0 ? "up" : "neutral",
    },
  ];
}

// ── Insight synthesis (client-side, from data we already have) ─

/**
 * Generate proactive AI-style insights from the loaded dashboard data. Runs
 * client-side so the operator always sees signal even before
 * systems-intelligence Values/Priorities are configured.
 *
 * Each insight gets a stable id (so backend insights with the same id are
 * preserved), a severity, an action label, and an `actionTab` that the
 * "Act" button in the dashboard jumps to.
 */
/**
 * Derive "create a project" suggestions from real, already-loaded signals.
 * Two sources, both grounded in live data (never fabricated):
 *   1. Backend / synthesized insights explicitly flagged create-project.
 *   2. Clients in progress that have no active project linked — a concrete
 *      "kick off delivery" suggestion the operator can act on in one click.
 * Dismissed suggestions (tracked on ds.dismissedInsights) are filtered out so
 * they don't reappear on the 30s auto-refresh.
 */
function buildSuggestedProjects(
  ds: DashboardState,
  projectInsights: DashInsight[],
): DashSuggestedProject[] {
  const out: DashSuggestedProject[] = [];
  const seen = new Set<string>();

  for (const insight of projectInsights) {
    const draft = insight.projectDraft;
    if (!draft?.name) continue;
    const id = `sugproj-insight-${insight.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: draft.name,
      description: draft.description ?? insight.description ?? "",
      rationale: insight.title,
      source: "insight",
    });
  }

  for (const client of ds.clientsInProgress) {
    if (client.activeProjectId) continue;
    const id = `sugproj-client-${client.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: `${client.name} — delivery`,
      description: `Project workspace to track delivery for ${client.name}${
        client.businessName ? ` (${client.businessName})` : ""
      }.`,
      rationale: `${client.name} is in progress with no project yet`,
      clientId: client.id,
      source: "client",
    });
  }

  return out.filter((sp) => !ds.dismissedInsights.has(sp.id)).slice(0, 6);
}

function synthesizeProactiveInsights(
  ds: DashboardState,
  tasksRaw: Array<Record<string, unknown>>,
): DashInsight[] {
  const out: DashInsight[] = [];
  const nowMs = Date.now();
  const week = 7 * DAY_MS;
  const day = DAY_MS;

  // ── Blocked work
  if (ds.blockedCount > 0) {
    out.push({
      id: "synth-blocked-tasks",
      type: "warning",
      title: `${ds.blockedCount} task${ds.blockedCount === 1 ? "" : "s"} blocked`,
      description: "Clear blockers first — downstream work is stalled until you act.",
      severity: ds.blockedCount >= 3 ? "high" : "medium",
      actionable: true,
      action: "Unblock",
      actionTab: "projects",
      createdAt: nowMs,
    });
  }
  // ── Aged urgent work
  const agedUrgent = tasksRaw.filter((t) => {
    const status = String(t.status ?? "").toLowerCase();
    const pri = String(t.priority ?? "").toLowerCase();
    return (
      (pri === "urgent" || pri === "high") &&
      status !== "done" &&
      status !== "completed" &&
      Number(t.createdAt ?? 0) < nowMs - 14 * day
    );
  });
  if (agedUrgent.length > 0) {
    out.push({
      id: "synth-aged-urgent",
      type: "warning",
      title: `${agedUrgent.length} urgent task${agedUrgent.length === 1 ? "" : "s"} aging > 2 weeks`,
      description: "Urgent work shouldn't sit. Re-scope, delegate, or kill.",
      severity: "high",
      actionable: true,
      action: "Review",
      actionTab: "projects",
      createdAt: nowMs,
    });
  }
  // ── Completion drought
  if (ds.completions24h === 0 && ds.recentDone.length > 0) {
    const lastDone = Math.max(...ds.recentDone.map((e) => e.completedAt));
    const hoursSince = (nowMs - lastDone) / 3_600_000;
    if (hoursSince > 24) {
      out.push({
        id: "synth-completion-drought",
        type: "warning",
        title: `No completions in ${Math.floor(hoursSince)}h`,
        description: "Momentum is slipping. Ship one small task to break the seal.",
        severity: hoursSince > 72 ? "high" : "medium",
        actionable: true,
        action: "Pick one",
        actionTab: "projects",
        createdAt: nowMs,
      });
    }
  }
  // ── WIP ceiling breach
  const inProgressTotal = ds.kanbanLanes.counts.inProgress;
  if (inProgressTotal > 12) {
    out.push({
      id: "synth-wip-overflow",
      type: "warning",
      title: `${inProgressTotal} tasks in progress`,
      description: "Too many open threads. Finish or park half of them.",
      severity: "medium",
      actionable: true,
      action: "Prune WIP",
      actionTab: "projects",
      createdAt: nowMs,
    });
  }
  // ── Ungrouped work → suggest a project to corral it (real create-project
  // suggestion, surfaced in the Suggested Projects card). Orphan = an open task
  // with no project assigned. Three+ of them is a real "make a home for this"
  // signal, not a fabricated card.
  const orphanTasks = tasksRaw.filter((t) => {
    const status = String(t.status ?? "").toLowerCase();
    const hasProject = typeof t.projectId === "string" && t.projectId.length > 0;
    return !hasProject && status !== "done" && status !== "completed";
  });
  if (orphanTasks.length >= 3) {
    out.push({
      id: "synth-orphan-tasks-project",
      type: "opportunity",
      title: `${orphanTasks.length} tasks have no project`,
      description: "Group these loose tasks under a project to track them together.",
      severity: "low",
      actionable: true,
      action: "Create project",
      actionTab: "projects",
      suggestionKind: "create-project",
      projectDraft: {
        name: "Unsorted work",
        description: `Home for ${orphanTasks.length} task${
          orphanTasks.length === 1 ? "" : "s"
        } that currently have no project.`,
      },
      createdAt: nowMs,
    });
  }
  // ── Stalled agent failures
  const failedRuns = ds.recentDone.filter((e) => e.status === "error").length;
  if (failedRuns >= 3) {
    out.push({
      id: "synth-agent-failures",
      type: "warning",
      title: `${failedRuns} agent runs failed in the last batch`,
      description: "Check the failure mode — same agent twice usually means a broken brief.",
      severity: "high",
      actionable: true,
      action: "Open Activity",
      actionTab: "activity",
      createdAt: nowMs,
    });
  }
  // ── Long-running agents
  const longRunners = ds.runningAgents.filter((r) => r.durationMs > 6 * 3_600_000);
  if (longRunners.length > 0) {
    out.push({
      id: "synth-long-running-agents",
      type: "warning",
      title: `${longRunners.length} agent${longRunners.length === 1 ? "" : "s"} running > 6h`,
      description: "Hanging agents waste budget. Inspect, then cancel or respawn.",
      severity: "medium",
      actionable: true,
      action: "Inspect",
      actionTab: "activity",
      createdAt: nowMs,
    });
  }
  // ── Revenue stall
  if (ds.revenue.year > 0 && ds.revenue.week === 0) {
    out.push({
      id: "synth-revenue-stall",
      type: "warning",
      title: "No revenue logged this week",
      description: "Either a sync failed or a stream is dry. Open business to check.",
      severity: "high",
      actionable: true,
      action: "Open Business",
      actionTab: "business",
      createdAt: nowMs,
    });
  }
  // ── Revenue momentum
  const dailyAvg30 =
    ds.revenue.daily30.reduce((s, v) => s + v, 0) / Math.max(1, ds.revenue.daily30.length);
  if (ds.revenue.today > dailyAvg30 * 1.5 && ds.revenue.today > 0) {
    out.push({
      id: "synth-revenue-spike",
      type: "alignment",
      title: `Today's revenue is ${Math.round(ds.revenue.today / Math.max(1, dailyAvg30))}× the 30-day average`,
      description: "Capture the lesson — what drove the spike? Document it.",
      severity: "info",
      actionable: true,
      action: "Open Business",
      actionTab: "business",
      createdAt: nowMs,
    });
  }
  // ── Discipline routine collapse
  if (ds.discipline.blocks.length >= 3 && ds.discipline.todayCompletionPct < 0.34) {
    out.push({
      id: "synth-discipline-collapse",
      type: "warning",
      title: `Discipline routine slipping — ${Math.round(ds.discipline.todayCompletionPct * 100)}% blocks done`,
      description: "Less than a third of the day's blocks are complete. Reset now.",
      severity: "medium",
      actionable: true,
      action: "Open Discipline",
      actionTab: "discipline",
      createdAt: nowMs,
    });
  }
  // ── Week score trending down
  const ws = ds.discipline.weekScores;
  if (ws.length >= 4) {
    const recent = ws.slice(-2).reduce((s, v) => s + v, 0) / 2;
    const prior = ws.slice(0, -2).reduce((s, v) => s + v, 0) / Math.max(1, ws.length - 2);
    if (prior > 0 && recent < prior * 0.7) {
      out.push({
        id: "synth-discipline-down",
        type: "warning",
        title: "Discipline score trending down",
        description: `Recent days ${Math.round(recent)} vs ${Math.round(prior)} prior. Recalibrate the week.`,
        severity: "medium",
        actionable: true,
        action: "Open Discipline",
        actionTab: "discipline",
        createdAt: nowMs,
      });
    }
  }
  // ── Workflow hanging
  const hangingWf = ds.workflows.filter(
    (w) => w.status === "running" && w.lastRunAt && nowMs - w.lastRunAt > 6 * 3_600_000,
  );
  if (hangingWf.length > 0) {
    out.push({
      id: "synth-wf-hanging",
      type: "warning",
      title: `${hangingWf.length} workflow${hangingWf.length === 1 ? "" : "s"} stuck running`,
      description: "A workflow has been live for > 6h. Probably hung — check and restart.",
      severity: "high",
      actionable: true,
      action: "Open Workflows",
      actionTab: "workflows",
      createdAt: nowMs,
    });
  }
  // ── Workflow error
  const erroredWf = ds.workflows.filter((w) => w.status === "error").length;
  if (erroredWf > 0) {
    out.push({
      id: "synth-wf-error",
      type: "warning",
      title: `${erroredWf} workflow${erroredWf === 1 ? "" : "s"} in error state`,
      description: "Run the failing workflow manually or disable it until fixed.",
      severity: "medium",
      actionable: true,
      action: "Open Workflows",
      actionTab: "workflows",
      createdAt: nowMs,
    });
  }
  // ── Stalled focus priority
  const stalledFocus = ds.focus.priorities.filter((p) => p.progress < 20);
  if (stalledFocus.length > 0 && ds.focus.priorities.length > 0) {
    out.push({
      id: "synth-focus-stalled",
      type: "warning",
      title: `${stalledFocus.length} priorit${stalledFocus.length === 1 ? "y" : "ies"} stalled`,
      description: `"${stalledFocus[0].title}" is at ${stalledFocus[0].progress}% — push or drop it.`,
      severity: "medium",
      actionable: true,
      action: "Open Focus",
      actionTab: "autonomy",
      createdAt: nowMs,
    });
  }
  // ── Hot client follow-up
  const hotClients = ds.pipeline.topClients.filter((c) => c.hot === 0);
  if (hotClients.length > 0) {
    out.push({
      id: "synth-hot-clients",
      type: "opportunity",
      title: `${hotClients.length} hot client${hotClients.length === 1 ? "" : "s"} waiting`,
      description: `Top: ${hotClients[0].name}. Cold leads die at 48h — reply now.`,
      severity: "high",
      actionable: true,
      action: "Open CRM",
      actionTab: "clients",
      createdAt: nowMs,
    });
  }
  // ── Stale content surface
  if (ds.content.total > 0) {
    const staleSurfaces = ds.content.recent.filter(
      (r) => r.updatedAt > 0 && nowMs - r.updatedAt > week * 4,
    );
    if (staleSurfaces.length > 0) {
      out.push({
        id: "synth-content-stale",
        type: "warning",
        title: `${staleSurfaces.length} content surface${staleSurfaces.length === 1 ? "" : "s"} stale > 4 weeks`,
        description: "Either ship or archive — dormant surfaces hurt brand consistency.",
        severity: "low" as any,
        actionable: true,
        action: "Open Content",
        actionTab: "content-pages",
        createdAt: nowMs,
      });
    }
  }
  // ── Federation offline
  if (
    ds.federationOverview.totalNodes > 1 &&
    ds.federationOverview.onlineNodes < ds.federationOverview.totalNodes
  ) {
    const off = ds.federationOverview.totalNodes - ds.federationOverview.onlineNodes;
    out.push({
      id: "synth-fed-offline",
      type: "warning",
      title: `${off} federation node${off === 1 ? "" : "s"} offline`,
      description: "Remote satellites are unreachable. Check the federation tab.",
      severity: "medium",
      actionable: true,
      action: "Federation",
      actionTab: "federation",
      createdAt: nowMs,
    });
  }
  // ── Cron next-run alert
  const overdueCron = ds.cronJobs.filter(
    (j) => j.enabled && j.nextRunAt && j.nextRunAt < nowMs - 60_000,
  );
  if (overdueCron.length > 0) {
    out.push({
      id: "synth-cron-overdue",
      type: "warning",
      title: `${overdueCron.length} cron job${overdueCron.length === 1 ? "" : "s"} overdue`,
      description: "A scheduled job missed its slot. Scheduler may be stuck.",
      severity: "medium",
      actionable: true,
      action: "Open Cron",
      actionTab: "schedule",
      createdAt: nowMs,
    });
  }
  // ── Idle fleet during work hours
  const hour = new Date().getHours();
  if (ds.runningAgents.length === 0 && ds.completions24h < 3 && hour >= 9 && hour < 18) {
    out.push({
      id: "synth-idle-workday",
      type: "info" as any,
      title: "Quiet workday — fleet idle",
      description: "No agents running and few completions yet. Set a goal to get moving.",
      severity: "info",
      actionable: true,
      action: "Set a Goal",
      actionTab: "autonomy",
      createdAt: nowMs,
    });
  }
  // ── Strong momentum (positive reinforcement)
  if (ds.completions24h >= 8 && ds.blockedCount === 0 && ds.runningAgents.length > 0) {
    out.push({
      id: "synth-strong-momentum",
      type: "alignment",
      title: `Strong day — ${ds.completions24h} tasks shipped, ${ds.runningAgents.length} agents live`,
      description: "Momentum is real. Capture the playbook in your notes.",
      severity: "info",
      actionable: true,
      action: "Add Note",
      actionTab: "notes",
      createdAt: nowMs,
    });
  }
  return out;
}

export function computeInsights(ds: DashboardState): DashCeoInsight[] {
  const out: DashCeoInsight[] = [];
  const now = Date.now();
  const add = (insight: DashCeoInsight): void => {
    if (!ds.dismissedInsights.has(insight.id)) out.push(insight);
  };

  if (ds.revenue.trend7d < -10) {
    add({
      id: "ceo-revenue-dip",
      severity: "warn",
      title: `Revenue down ${Math.abs(Math.round(ds.revenue.trend7d))}% week-over-week`,
      rationale: "The last 7 days are trailing the previous 7-day window.",
      actionLabel: "Review pipeline",
      actionTab: "pipeline",
    });
  }

  const agedBlocked = ds.priorityTasks.filter(
    (task) => task.blocked && task.updatedAt > 0 && now - task.updatedAt > 48 * 3_600_000,
  );
  if (agedBlocked.length > 3) {
    add({
      id: "ceo-blocked-priorities",
      severity: "critical",
      title: `${agedBlocked.length} blocked priorities over 48h`,
      rationale: "Priority work has been blocked long enough to threaten delivery.",
      actionLabel: "Clear blockers",
      actionTab: "projects",
    });
  }

  const idleClient = ds.clientsInProgress.find(
    (client) => client.lastActivityAt != null && now - client.lastActivityAt > 7 * DAY_MS,
  );
  if (idleClient) {
    add({
      id: `ceo-idle-client-${idleClient.id}`,
      severity: "warn",
      title: `${idleClient.name} has been idle ${Math.floor((now - (idleClient.lastActivityAt ?? now)) / DAY_MS)}d`,
      rationale: "An in-progress client has no recent activity and may need follow-up.",
      actionLabel: "Open client",
      actionTab: "clients",
      clientId: idleClient.id,
      businessId: idleClient.businessId ?? undefined,
    });
  }

  const autonomyBlockedFor =
    ds.autonomyMini.blockedSince != null ? now - ds.autonomyMini.blockedSince : 0;
  if (
    (ds.autonomyMini.status === "blocked" || ds.autonomyMini.status === "paused") &&
    autonomyBlockedFor > DAY_MS
  ) {
    add({
      id: "ceo-autonomy-blocked",
      severity: "warn",
      title: `Autonomy ${ds.autonomyMini.status} for ${Math.floor(autonomyBlockedFor / 3_600_000)}h`,
      rationale: "The autonomous work loop has not been able to advance for more than a day.",
      actionLabel: "Review autonomy",
      actionTab: "autonomy",
    });
  }

  const lateCron = ds.cronJobs.find((job) => {
    const status = normalizeStatus(job.status);
    if (status === "failed" || status === "error") return true;
    if (!job.enabled || !job.intervalMs || !job.lastRunAt) return false;
    return now - job.lastRunAt > job.intervalMs * 2;
  });
  if (lateCron) {
    add({
      id: `ceo-cron-${lateCron.id || lateCron.label}`,
      severity: "warn",
      title: `${lateCron.label} needs attention`,
      rationale: lateCron.status
        ? `Cron status is ${lateCron.status}.`
        : "Cron is more than two intervals late.",
      actionLabel: "Open cron",
      actionTab: "schedule",
    });
  }

  const staleNode = ds.nodes.find((node) => {
    if (!node.lastSeenAt) return false;
    return now - node.lastSeenAt > 5 * 60_000;
  });
  if (staleNode) {
    const isMaster = normalizeStatus(staleNode.role ?? staleNode.kind) === "master";
    add({
      id: `ceo-node-stale-${staleNode.id}`,
      severity: isMaster ? "critical" : "warn",
      title: `${staleNode.name} last seen ${Math.floor((now - (staleNode.lastSeenAt ?? now)) / 60_000)}m ago`,
      rationale: isMaster
        ? "The master federation node appears stale."
        : "A federation node has missed its heartbeat window.",
      actionLabel: "Inspect federation",
      actionTab: "federation",
    });
  }

  for (const business of ds.businessSummaries) {
    const firstHalf = business.revenueSpark7d.slice(0, 3).reduce((sum, value) => sum + value, 0);
    const secondHalf = business.revenueSpark7d.slice(3).reduce((sum, value) => sum + value, 0);
    const growth = firstHalf > 0 ? ((secondHalf - firstHalf) / firstHalf) * 100 : 0;
    if (growth > 20) {
      add({
        id: `ceo-business-growth-${business.id}`,
        severity: "success",
        title: `${business.name} up ${Math.round(growth)}% - replicate playbook?`,
        rationale: "This business is outperforming its early-week baseline.",
        actionLabel: "Open business",
        actionTab: "business",
        businessId: business.id,
      });
      break;
    }
  }

  const rank: Record<DashCeoInsight["severity"], number> = {
    critical: 0,
    warn: 1,
    success: 2,
    info: 3,
  };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
}

// ── Briefing synthesis (CEO-style proactive summary) ─────────

function synthesizeBriefing(ds: DashboardState): DashBriefing {
  const lines: DashBriefingLine[] = [];

  // 1. Pulse line — running agents + completions today.
  if (ds.runningAgents.length > 0) {
    lines.push({
      tone: "primary",
      icon: "bot",
      text: `${ds.runningAgents.length} agent${ds.runningAgents.length === 1 ? "" : "s"} actively working — ${ds.completions24h} task${ds.completions24h === 1 ? "" : "s"} shipped in the last 24h.`,
    });
  } else if (ds.completions24h > 0) {
    lines.push({
      tone: "ok",
      icon: "checkCircle",
      text: `${ds.completions24h} task${ds.completions24h === 1 ? "" : "s"} shipped in the last 24h. No agents currently running — fleet is idle.`,
    });
  } else {
    lines.push({
      tone: "info",
      icon: "info",
      text: "Fleet is idle. Spin up a goal or kick off a workflow to put your agents to work.",
    });
  }

  // 1b. "Where am I" grounding — name the concrete recent work so the operator
  //     re-orients instantly: which agents just finished, what task subject
  //     landed, and which branch they're on. Real signals, not generic counts.
  if (ds.gitBranch) {
    lines.push({
      tone: "info",
      icon: "gitBranch",
      text: ds.gitRepo
        ? `You're on branch ${ds.gitBranch} in ${ds.gitRepo}.`
        : `You're on branch ${ds.gitBranch}.`,
      actionTab: "activity",
    });
  }
  for (const run of ds.recentRuns) {
    const ok = run.status === "complete";
    const verb = ok ? "finished" : run.status === "timeout" ? "timed out" : "failed";
    lines.push({
      tone: ok ? "ok" : "warn",
      icon: ok ? "checkCircle" : "alertCircle",
      text: `Agent ${run.label} ${verb} ${timeAgoShort(run.endedAt)}.`,
      actionTab: "agents",
    });
  }
  // Most recent completed kanban task subject — what actually shipped.
  const lastDoneTask = [...ds.recentDone].sort((a, b) => b.completedAt - a.completedAt)[0];
  if (lastDoneTask && lastDoneTask.title) {
    lines.push({
      tone: lastDoneTask.status === "error" ? "warn" : "ok",
      icon: "checkSquare",
      text: `Last task: "${lastDoneTask.title}"${lastDoneTask.projectName && lastDoneTask.projectName !== "—" ? ` in ${lastDoneTask.projectName}` : ""}.`,
      actionTab: "projects",
    });
  }

  // 2. Blocker line — the most urgent operational issue.
  if (ds.blockedCount > 0) {
    lines.push({
      tone: "danger",
      icon: "alertCircle",
      text: `${ds.blockedCount} task${ds.blockedCount === 1 ? "" : "s"} blocked — clear blockers first to unblock downstream work.`,
    });
  }

  // 3. Top insight passthrough — surface the most actionable system insight.
  const topInsight =
    ds.insights.find((i) => i.actionable && i.severity === "high") ??
    ds.insights.find((i) => i.actionable) ??
    ds.insights[0];
  if (topInsight) {
    lines.push({
      tone: topInsight.severity === "high" ? "warn" : "info",
      icon: "zap",
      text: topInsight.title,
    });
  }

  // 4. Priority task callout — if there's a high-priority unblocked item.
  const topUnblocked = ds.priorityTasks.find(
    (t) => !t.blocked && (t.priority === "high" || t.priority === "urgent"),
  );
  if (topUnblocked) {
    lines.push({
      tone: "primary",
      icon: "target",
      text: `Top priority: "${topUnblocked.title}" in ${topUnblocked.projectName}.`,
    });
  }

  // 5. Money line — revenue beats every other distraction.
  if (ds.revenue.today > 0) {
    lines.push({
      tone: "ok",
      icon: "zap",
      text: `${ds.revenue.currency}${formatMoney(ds.revenue.today)} earned today · ${ds.revenue.currency}${formatMoney(ds.revenue.week)} this week.`,
    });
  }

  // 6. Discipline line — accountability beats motivation.
  if (ds.discipline.blocks.length > 0) {
    if (ds.discipline.currentBlockLabel) {
      lines.push({
        tone: "primary",
        icon: "target",
        text: `Now in: ${ds.discipline.currentBlockLabel}.`,
      });
    } else if (ds.discipline.todayCompletionPct < 0.5) {
      const remaining = ds.discipline.blocks.filter((b) => !b.done).length;
      lines.push({
        tone: "warn",
        icon: "target",
        text: `${remaining} block${remaining === 1 ? "" : "s"} left today — discipline score sitting at ${ds.discipline.todayScore}.`,
      });
    }
  }

  // 7. Pipeline pulse — keep the funnel top-of-mind.
  if (ds.pipeline.total > 0) {
    const hot = ds.pipeline.topClients.filter((c) => c.hot === 0).length;
    if (hot > 0) {
      lines.push({
        tone: "warn",
        icon: "target",
        text: `${hot} hot client${hot === 1 ? "" : "s"} in the pipeline — follow up before they cool.`,
      });
    }
  }

  // 7b. Focus line — the #1 priority should be visible every day.
  if (ds.focus.focusTitle && ds.focus.priorities.length > 0) {
    const fp = ds.focus.priorities.find((p) => p.isFocus) ?? ds.focus.priorities[0];
    lines.push({
      tone: fp.progress >= 70 ? "ok" : "primary",
      icon: "target",
      text: `Focus: "${fp.title}" — ${fp.progress}% done${fp.nextStep ? ` · next: ${fp.nextStep}` : ""}.`,
    });
  }

  // 7c. Federation pulse — surface remote-node availability.
  if (ds.federationOverview.totalNodes > 1) {
    if (ds.federationOverview.hasRemoteLink) {
      lines.push({
        tone: "info",
        icon: "activity",
        text: `${ds.federationOverview.onlineNodes}/${ds.federationOverview.totalNodes} nodes online — fleet is healthy.`,
      });
    } else {
      lines.push({
        tone: "warn",
        icon: "activity",
        text: `${ds.federationOverview.onlineNodes}/${ds.federationOverview.totalNodes} nodes online — remote satellites offline.`,
      });
    }
  }

  // 8. Encouragement / coaching when things look good.
  if (ds.blockedCount === 0 && ds.runningAgents.length > 0 && ds.completions24h >= 5) {
    lines.push({
      tone: "ok",
      icon: "trendingUp",
      text: "Strong day. Velocity is up and nothing is blocked — momentum is yours.",
    });
  }

  // ── Headline (the one-line above the bullets)
  let headline: string;
  if (ds.blockedCount > 0) {
    headline = `${ds.blockedCount} blocker${ds.blockedCount === 1 ? "" : "s"} need${ds.blockedCount === 1 ? "s" : ""} your attention — InfiniBot is on the rest.`;
  } else if (ds.runningAgents.length > 0) {
    headline = `InfiniBot is on it — ${ds.runningAgents.length} agent${ds.runningAgents.length === 1 ? "" : "s"} working, ${ds.completions24h} shipped today.`;
  } else if (ds.completions24h > 0) {
    headline = `${ds.completions24h} task${ds.completions24h === 1 ? "" : "s"} shipped today. Queue what's next.`;
  } else {
    headline = "Quiet day. Set a goal or spawn an agent to get moving.";
  }

  return { headline, lines, generatedAt: Date.now() };
}

// ── Placeholder helpers (for empty / fresh-user states) ──────

function getPlaceholderRecommendations(): RecommendedCourse[] {
  return [
    {
      id: "quickstart",
      title: "Quickstart Guide",
      description:
        "Get up and running with InfiniBot in under 10 minutes. Set up your first agent and send a message.",
      tier: "free",
      duration: "10 min",
      matchReason: "Perfect starting point",
    },
    {
      id: "channels-setup",
      title: "Connect Your Channels",
      description:
        "Link Telegram, Discord, Slack, and more. Learn how to manage multi-channel conversations.",
      tier: "free",
      duration: "15 min",
      matchReason: "Essential next step",
    },
    {
      id: "agent-customization",
      title: "Customize Your Agent",
      description: "Personality, memory, skills — tailor your AI to match your workflow and style.",
      tier: "free",
      duration: "20 min",
      matchReason: "Popular with new users",
    },
  ];
}

function getPlaceholderAchievements(): Achievement[] {
  return [
    {
      id: "first-steps",
      title: "First Steps",
      description: "Complete your first learning track",
      icon: "star",
      earned: false,
    },
    {
      id: "course-finisher",
      title: "Course Finisher",
      description: "Complete any course from start to finish",
      icon: "checkCircle",
      earned: false,
    },
    {
      id: "streak-7",
      title: "Week Warrior",
      description: "Maintain a 7-day learning streak",
      icon: "flame",
      earned: false,
    },
    {
      id: "explorer",
      title: "Explorer",
      description: "Try 3 different courses or tracks",
      icon: "globe",
      earned: false,
    },
  ];
}
