import type { GatewayBrowserClient } from "../gateway";
import {
  getFocusProjectIds,
  addProjectToFocus,
  removeProjectFromFocus,
} from "./focus";
// Imported lazily inside helpers to avoid circular module evaluation —
// discipline-notify imports back from this file for blockPriority/etc.

// ── Workload tracking types (mirrored from src/workload/types.ts) ─────────

export type WorkEventKind =
  | "subagent_started"
  | "subagent_completed"
  | "subagent_failed"
  | "kanban_task_completed"
  | "workflow_run_completed"
  | "gateway_tool_invocation"
  | "voice_session_ended"
  | "edit_session"
  | "manual";

export type WorkEventSource =
  | "subagent_registry"
  | "kanban"
  | "workflow"
  | "voice"
  | "editor"
  | "manual"
  | "gateway";

export interface WorkEvent {
  ts: number;
  kind: WorkEventKind;
  source: WorkEventSource;
  durationMs?: number;
  label: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkloadSummary {
  date: string;
  totalMs: number;
  byKind: Partial<Record<WorkEventKind, number>>;
  bySource: Partial<Record<WorkEventSource, number>>;
  byProject: Array<{ projectId: string; label: string; totalMs: number }>;
  eventCount: number;
}

export interface WorkloadWeekDay {
  date: string;
  totalMs: number;
  eventCount: number;
}

export type DisciplineCategory =
  | "deep-work"
  | "meetings"
  | "ops"
  | "body"
  | "admin"
  | "break"
  | "personal";

export const DISCIPLINE_CATEGORIES: DisciplineCategory[] = [
  "deep-work",
  "meetings",
  "ops",
  "body",
  "admin",
  "break",
  "personal",
];

export const CATEGORY_COLORS: Record<DisciplineCategory, string> = {
  "deep-work": "var(--g-primary)",
  meetings: "#8B5CF6",
  ops: "#3B82F6",
  body: "#10B981",
  admin: "#6B7280",
  break: "#F59E0B",
  personal: "#EC4899",
};

export type LogSource = "planned" | "probe" | "manual" | "abort";

export interface RoutineItem {
  id: string;
  label: string;
  order: number;
}

export interface DisciplineBlock {
  id: string;
  label: string;
  category: DisciplineCategory;
  intent?: string;
  startMinute: number;
  endMinute: number;
  days: number[];
  oneOffDate?: string;
  hard: boolean;
  enabled: boolean;
  color?: string;
  projectId?: string;
  taskId?: string;
  nonNegotiable: boolean;
  routineItems: RoutineItem[];
  createdAt: number;
  updatedAt: number;
}

export interface RoutineCompletion {
  blockId: string;
  itemId: string;
  dateIso: string;
  completedAt: number;
}

export interface KanbanProjectLite {
  id: string;
  name: string;
  color?: string;
  /** Kanban project lifecycle status (e.g. "In progress", "Completed"). */
  status?: string;
}
export interface KanbanTaskLite {
  id: string;
  projectId: string;
  title: string;
  status?: string;
}

export interface DisciplineLog {
  id: string;
  blockId?: string;
  label: string;
  category: DisciplineCategory;
  source: LogSource;
  startMs: number;
  endMs?: number;
  reason?: string;
  note?: string;
  createdAt: number;
}

/** Which lifecycle moments should fan out to telegram. */
export interface TelegramEventToggles {
  blockStart: boolean;
  blockEnd: boolean;
  blockComplete: boolean;
  abort: boolean;
  slip: boolean;
  dailyReview: boolean;
}

/** AI assistant lane preferences. */
export interface AiAssistSettings {
  enabled: boolean;
  /** Optional per-discipline session key — defaults to `agent:main:discipline`. */
  sessionKey?: string;
  /** Auto-suggest tomorrow's plan after the day-end review. */
  autoPlanNextDay: boolean;
  /** Auto-run a daily review at end of day. */
  autoDailyReview: boolean;
}

export interface DisciplineSettings {
  militant: boolean;
  probeIntervalMin: number;
  dayStartHour: number;
  dayEndHour: number;
  /** Mute telegram + audio nudges between these hours (24h). End < start wraps midnight. */
  quietHoursStart: number;
  quietHoursEnd: number;
  /** Telegram setup. chatId optional — empty falls back to gateway-default chat. */
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramEvents: TelegramEventToggles;
  /** Sort/filter the Blocks view by priority of linked kanban task. */
  prioritySortEnabled: boolean;
  /** Highlight blocks linked to critical-priority tasks in the timeline. */
  priorityHighlight: boolean;
  ai: AiAssistSettings;
  updatedAt: number;
}

export interface DayScore {
  date: string;
  plannedMinutes: number;
  actualMinutes: number;
  compliance: number;
  slippageCount: number;
  nonNegotiableMissed: number;
  nonNegotiableTotal: number;
  routineCompleted: number;
  routineTotal: number;
  categoryMinutes: Partial<Record<DisciplineCategory, number>>;
}

export type AnalyticsWindow = 7 | 30 | 90 | 365;

export interface BlockStats {
  blockId: string;
  label: string;
  category: DisciplineCategory;
  scheduledCount: number;
  completedCount: number;
  abortedCount: number;
  /** Total minutes logged against this block over the range. */
  loggedMin: number;
  /** completedCount / max(1, scheduledCount). */
  completionRate: number;
}

export interface AbortReasonSummary {
  reason: string;
  count: number;
  lastAt: number;
}

export interface AnalyticsRange {
  days: AnalyticsWindow;
  /** True once the gateway request resolved (success or fallback). */
  loaded: boolean;
  loading: boolean;
  /** Source of truth: "gateway" if discipline.score.range succeeded, otherwise "logs" — derived locally. */
  source: "gateway" | "logs" | null;
  /** Sorted ascending by date. May contain gaps if a date had no logged activity. */
  scores: DayScore[];
  // ── Derived rollups, recomputed every load:
  avgCompliance: number;
  bestCompliance: number;
  worstCompliance: number;
  totalLoggedMin: number;
  totalPlannedMin: number;
  totalSlips: number;
  /** Best streak of ≥80%-compliance days inside the range. */
  bestStreak: number;
  /** Current streak (counting back from the most recent day). */
  currentStreak: number;
  /** Sum of saved minutes across the range from completed blocks. */
  cumulativeSavedMin: number;
  /** Sun=0..Sat=6 — slip count per day-of-week. */
  slipsByDow: number[];
  /** Category × day matrix for the stacked bar chart. */
  categoryMatrix: Partial<Record<DisciplineCategory, number[]>>;
  blockStats: BlockStats[];
  abortReasons: AbortReasonSummary[];
}

export type DisciplineSubView = "timeline" | "blocks" | "score" | "settings";

// ── Auto-log event counts ──────────────────────────────────────────────────
export interface DisciplineEventCountSummary {
  blockId: string | null;
  total: number;
  byKind: Partial<Record<string, number>>;
}

// ── Templates ──────────────────────────────────────────────────────────────

/**
 * A reusable layout snapshot — captures only the parts of a block that
 * describe a schedule (no per-day completion, ids, or timestamps), so a
 * template can be applied multiple times without leaking yesterday's state.
 */
export interface TemplateBlock {
  label: string;
  category: DisciplineCategory;
  intent?: string;
  startMinute: number;
  endMinute: number;
  days: number[];
  hard: boolean;
  enabled: boolean;
  nonNegotiable: boolean;
  color?: string;
  projectId?: string;
  taskId?: string;
  routineItems: Array<{ label: string; order: number }>;
}

export interface DisciplineTemplate {
  id: string;
  name: string;
  description?: string;
  blocks: TemplateBlock[];
  createdAt: number;
  updatedAt: number;
  /** Optional source flag — "user" for user-saved, "preset" for the bundled DISCIPLINE_PRESETS, "imported" for shared exports. */
  source?: "user" | "preset" | "imported";
}

export type ModalState =
  | null
  | {
      kind: "confirm";
      title: string;
      body: string;
      confirmLabel?: string;
      dangerous?: boolean;
      onConfirm: () => void | Promise<void>;
    }
  | {
      kind: "prompt";
      title: string;
      body: string;
      placeholder?: string;
      value: string;
      onSubmit: (value: string) => void | Promise<void>;
    };

export interface BlockDraft {
  id?: string;
  label: string;
  category: DisciplineCategory;
  intent: string;
  startMinute: number;
  endMinute: number;
  days: number[];
  hard: boolean;
  enabled: boolean;
  nonNegotiable: boolean;
  projectId?: string;
  taskId?: string;
  routineItems: RoutineItem[];
}

export interface DisciplineState {
  loading: boolean;
  error: string | null;
  blocks: DisciplineBlock[];
  logs: DisciplineLog[];
  settings: DisciplineSettings;
  today: DayScore | null;
  week: DayScore[];
  /** Map of `${blockId}:${itemId}` → true for items completed today. */
  routineDone: Record<string, boolean>;
  /** Cached kanban projects + tasks for the block linker. */
  kanbanProjects: KanbanProjectLite[];
  kanbanTasks: KanbanTaskLite[];
  kanbanLoaded: boolean;
  subView: DisciplineSubView;
  /** Timeline preview override — when true, the timeline ignores the per-block
   *  day-of-week filter and shows every enabled block. Useful on days where
   *  nothing is scheduled (weekends, holidays) or to preview a normal weekday. */
  timelinePreviewAllDays?: boolean;
  /** Timeline zoom mode.
   *  - "standard" (default): 24h vertical strip at 48px/hour, full overview.
   *  - "2hr": zooms in to a 2-hour window centered on now, ~240px/hour, so
   *    blocks fill the screen and are easy to read/edit. */
  timelineZoom?: "standard" | "2hr";
  /** Tasks-modal state. When non-null, the discipline view renders a
   *  full-screen modal showing every project's tasks. The view mode controls
   *  how they're laid out:
   *    - "board"   = kanban columns by status (default)
   *    - "list"    = flat table-style rows
   *    - "gallery" = card grid, project color stripes */
  taskModal?: {
    open: boolean;
    projectFilter: string | "all";
    viewMode: "board" | "list" | "gallery";
    /** Optimistic in-flight updates keyed by task id, so the checkbox
     *  reflects the user's last click even before the gateway responds. */
    updating: Record<string, boolean>;
  };
  editingBlockId: string | null;
  creatingBlock: boolean;
  blockDraft: BlockDraft | null;
  activeProbe: {
    id: string | null;
    startedAt: number | null;
    draftLabel: string;
    draftCategory: DisciplineCategory;
  };
  modal: ModalState;
  tickerId: number | null;
  lastTickMs: number;
  /** Blocks the user has marked complete today. Key = blockId. */
  blockDone: Record<string, { completedMin: number; savedMin: number }>;
  /** Sum of minutes saved today by finishing blocks early. */
  timeSavedMin: number;
  /** Per-block start override (minutes from midnight) — auto-advance carries this over. */
  blockStartOverride: Record<string, number>;
  /** The date (YYYY-MM-DD) the above daily maps apply to. */
  dailyStateDate: string;
  /** Last currentBlock id we observed — used by the auto-notify dispatcher to fire transitions. */
  lastObservedBlockId: string | null;
  /** Idempotency keys for events fired today, e.g. "blockStart:abc123". Cleared on day rollover. */
  firedNotifications: Record<string, true>;
  /** Most recent AI-assist message (advice / plan / review) so we can render in the panel. */
  aiLastResponse: { kind: "plan" | "review" | "advice" | "error"; text: string; ts: number } | null;
  aiBusy: boolean;
  /** Cached "test" result to surface in the settings panel. */
  telegramTestResult: { ok: boolean; message: string; ts: number } | null;
  /** Historic analytics window — recomputed when the user changes range. */
  analytics: AnalyticsRange;
  /** Auto-logged work events for today (from workload tracking). */
  workEvents: WorkEvent[];
  workloadSummary: WorkloadSummary | null;
  workloadWeekly: WorkloadWeekDay[];
  workloadLoading: boolean;
  /** User-saved + built-in layout templates available for save/load. */
  templates: DisciplineTemplate[];
  /** ID of the template the current block layout was last loaded from. */
  activeTemplateId: string | null;
  /** Snapshot of the template's blocks captured at load time so we can detect dirt. */
  activeTemplateSnapshot: TemplateBlock[] | null;
  templatesLoaded: boolean;
  /** Inline template editor / picker state. */
  templateModal: TemplateModalState;
  /** Auto-log event counts per block for today — loaded async after discipline.state. */
  autoLogCounts: DisciplineEventCountSummary[];
  /** Kanban task / agent run completions that fell inside a block today. */
  blockCompletionItems: BlockCompletionItem[];
  /** Proactive per-block insights from discipline.insights, keyed by blockId. */
  insights: Record<string, DisciplineInsight>;
  /** Rollup of the business signals behind the insights (for the day header). */
  insightSummary: DisciplineInsightSummary | null;
  /** When the discipline day auto-started today (null until first activity). */
  dayStart: DayStartInfo | null;
  blockFilters: DisciplineFilterState;
  notionSync: {
    status: "disconnected" | "connected" | "syncing" | "error";
    lastSyncAt: number | null;
    error: string | null;
  };
}

export type TemplateModalState =
  | null
  | { kind: "saveAs"; name: string; description: string }
  | { kind: "load"; query: string }
  | { kind: "manage" }
  | { kind: "rename"; templateId: string; name: string };

export interface DisciplineFilterState {
  categories: DisciplineCategory[];
  status: Array<"incomplete" | "in-progress" | "completed" | "overdue">;
  source: Array<"manual" | "auto" | "agent">;
}

/** A single completed task or agent run attributed to a discipline block. */
export interface BlockCompletionItem {
  id: string;
  blockId: string | null;
  kind: "kanban:task_done" | "agent:completed";
  title: string;
  sourceId: string;
  completedAt: number;
}

/** Proactive per-block insight — mirrors src/discipline/insights.ts (server). */
export type InsightTone = "info" | "warn" | "urgent" | "success";
export interface InsightRef {
  kind: "task" | "project" | "client" | "deadline";
  label: string;
  id?: string;
}
export interface DisciplineInsight {
  blockId: string;
  headline: string;
  suggestedAction: string;
  tone: InsightTone;
  references: InsightRef[];
}
export interface DisciplineInsightSummary {
  openTasks: number;
  p0Tasks: number;
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
  activeProjects: number;
  awaitingClient: number;
  staleClients: number;
}
/** When the discipline day auto-started today (minutes-from-midnight) or null. */
export interface DayStartInfo {
  startMinute: number;
  startedAt: number;
  source: string;
}

export function createEmptyAnalytics(days: AnalyticsWindow = 30): AnalyticsRange {
  return {
    days,
    loaded: false,
    loading: false,
    source: null,
    scores: [],
    avgCompliance: 0,
    bestCompliance: 0,
    worstCompliance: 0,
    totalLoggedMin: 0,
    totalPlannedMin: 0,
    totalSlips: 0,
    bestStreak: 0,
    currentStreak: 0,
    cumulativeSavedMin: 0,
    slipsByDow: [0, 0, 0, 0, 0, 0, 0],
    categoryMatrix: {},
    blockStats: [],
    abortReasons: [],
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function defaultDisciplineSettings(): DisciplineSettings {
  return {
    militant: false,
    probeIntervalMin: 30,
    dayStartHour: 6,
    dayEndHour: 23,
    quietHoursStart: 22,
    quietHoursEnd: 6,
    telegramEnabled: false,
    telegramChatId: "",
    telegramEvents: {
      blockStart: true,
      blockEnd: true,
      blockComplete: false,
      abort: true,
      slip: true,
      dailyReview: true,
    },
    prioritySortEnabled: false,
    priorityHighlight: true,
    ai: {
      enabled: false,
      sessionKey: undefined,
      autoPlanNextDay: false,
      autoDailyReview: false,
    },
    updatedAt: 0,
  };
}

/** Coerce a possibly-incomplete settings payload from the gateway into the new shape. */
export function normalizeSettings(input: Partial<DisciplineSettings> | undefined): DisciplineSettings {
  const d = defaultDisciplineSettings();
  if (!input) return d;
  return {
    ...d,
    ...input,
    telegramEvents: { ...d.telegramEvents, ...(input.telegramEvents ?? {}) },
    ai: { ...d.ai, ...(input.ai ?? {}) },
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

/** True when the current local time is inside the user's quiet-hours window. */
export function isQuietHoursNow(s: DisciplineSettings, now: Date = new Date()): boolean {
  const start = s.quietHoursStart;
  const end = s.quietHoursEnd;
  if (start === end) return false;
  const h = now.getHours() + now.getMinutes() / 60;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

export function createDisciplineState(): DisciplineState {
  return {
    loading: false,
    error: null,
    blocks: [],
    logs: [],
    settings: defaultDisciplineSettings(),
    today: null,
    week: [],
    routineDone: {},
    kanbanProjects: [],
    kanbanTasks: [],
    kanbanLoaded: false,
    subView: "timeline",
    editingBlockId: null,
    creatingBlock: false,
    blockDraft: null,
    activeProbe: {
      id: null,
      startedAt: null,
      draftLabel: "",
      draftCategory: "deep-work",
    },
    modal: null,
    tickerId: null,
    lastTickMs: Date.now(),
    blockDone: {},
    timeSavedMin: 0,
    blockStartOverride: {},
    dailyStateDate: todayIso(),
    lastObservedBlockId: null,
    firedNotifications: {},
    aiLastResponse: null,
    aiBusy: false,
    telegramTestResult: null,
    analytics: createEmptyAnalytics(30),
    templates: [],
    activeTemplateId: null,
    activeTemplateSnapshot: null,
    templatesLoaded: false,
    templateModal: null,
    autoLogCounts: [],
    blockCompletionItems: [],
    insights: {},
    insightSummary: null,
    dayStart: null,
    blockFilters: { categories: [], status: [], source: [] },
    notionSync: { status: "disconnected", lastSyncAt: null, error: null },
    workEvents: [],
    workloadSummary: null,
    workloadWeekly: [],
    workloadLoading: false,
  };
}

interface ServerBlockCompletion {
  blockId: string;
  dateIso: string;
  completedMinute: number;
  savedMinute: number;
  completedAt: number;
}
interface ServerBlockOverride {
  blockId: string;
  dateIso: string;
  startMinute: number;
}

function applyDailyStatePayload(
  state: DisciplineState,
  completions: ServerBlockCompletion[],
  overrides: ServerBlockOverride[],
): void {
  state.dailyStateDate = todayIso();
  const done: Record<string, { completedMin: number; savedMin: number }> = {};
  let saved = 0;
  for (const c of completions ?? []) {
    done[c.blockId] = { completedMin: c.completedMinute, savedMin: c.savedMinute };
    saved += c.savedMinute;
  }
  state.blockDone = done;
  state.timeSavedMin = saved;
  const ovr: Record<string, number> = {};
  for (const o of overrides ?? []) ovr[o.blockId] = o.startMinute;
  state.blockStartOverride = ovr;
}

export function startDisciplineTicker(
  state: DisciplineState,
  requestUpdate: () => void,
  client?: GatewayBrowserClient,
): void {
  if (state.tickerId != null) return;
  let tickCount = 0;
  state.tickerId = window.setInterval(() => {
    state.lastTickMs = Date.now();
    if (client) {
      try {
        // Lazy import to avoid the circular module load order — see top-of-file note.
        void import("./discipline-notify").then((m) => m.tickAutoNotifications(state, client));
      } catch {
        /* ignore */
      }
      // Refresh proactive insights every 6th tick (~2 min). The server caches
      // for 60s so this is cheap, and it keeps headlines current as the
      // underlying business data (tasks/projects/deadlines) changes.
      tickCount += 1;
      if (tickCount % 6 === 0) void loadInsights(state, client);
    }
    requestUpdate();
  }, 20_000);
}

export function stopDisciplineTicker(state: DisciplineState): void {
  if (state.tickerId != null) {
    window.clearInterval(state.tickerId);
    state.tickerId = null;
  }
}

export function beginCreate(state: DisciplineState, seed?: Partial<BlockDraft>): void {
  state.creatingBlock = true;
  state.editingBlockId = null;
  state.blockDraft = {
    label: seed?.label ?? "",
    category: seed?.category ?? "deep-work",
    intent: seed?.intent ?? "",
    startMinute: seed?.startMinute ?? 9 * 60,
    endMinute: seed?.endMinute ?? 10 * 60,
    // Default to every day so newly-created blocks show up immediately on the
    // timeline regardless of which day of the week the user is on. They can
    // narrow to weekdays in the editor if that's what they want.
    days: seed?.days ?? [0, 1, 2, 3, 4, 5, 6],
    hard: seed?.hard ?? false,
    enabled: seed?.enabled !== false,
    nonNegotiable: seed?.nonNegotiable ?? false,
    projectId: seed?.projectId,
    taskId: seed?.taskId,
    routineItems: seed?.routineItems ?? [],
  };
}

export function beginEdit(state: DisciplineState, id: string): void {
  const b = state.blocks.find((x) => x.id === id);
  if (!b) return;
  state.editingBlockId = id;
  state.creatingBlock = false;
  state.blockDraft = {
    id: b.id,
    label: b.label,
    category: b.category,
    intent: b.intent ?? "",
    startMinute: b.startMinute,
    endMinute: b.endMinute,
    days: [...(b.days ?? [])],
    hard: b.hard,
    enabled: b.enabled,
    nonNegotiable: b.nonNegotiable,
    projectId: b.projectId,
    taskId: b.taskId,
    routineItems: (b.routineItems ?? []).map((r) => ({ ...r })),
  };
}

let routineSeq = 0;
export function newRoutineItemId(): string {
  routineSeq += 1;
  return `ri_${Date.now().toString(36)}_${routineSeq}`;
}

export function cancelBlockEditor(state: DisciplineState): void {
  state.creatingBlock = false;
  state.editingBlockId = null;
  state.blockDraft = null;
}

/** Preset day templates — used on first-run or from the empty state. */
export type PresetBlockSeed = Omit<BlockDraft, "enabled" | "nonNegotiable" | "routineItems"> & {
  nonNegotiable?: boolean;
  routineItems?: Array<{ label: string }>;
};

export interface DisciplinePreset {
  id: string;
  name: string;
  tagline: string;
  blocks: PresetBlockSeed[];
}

export const DISCIPLINE_PRESETS: DisciplinePreset[] = [
  {
    id: "deep-focus",
    name: "Deep Focus Day",
    tagline: "3×90m deep work · 2 breaks · admin cap",
    blocks: [
      {
        label: "Morning deep work", category: "deep-work", intent: "ship the hardest thing first",
        startMinute: 8 * 60, endMinute: 9 * 60 + 30, days: [1, 2, 3, 4, 5], hard: true, nonNegotiable: true,
        routineItems: [
          { label: "Phone on silent, out of reach" },
          { label: "Write down today's one priority" },
          { label: "Close Slack + email" },
        ],
      },
      { label: "Break", category: "break", intent: "walk, no phone", startMinute: 9 * 60 + 30, endMinute: 9 * 60 + 45, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Deep work 2", category: "deep-work", intent: "", startMinute: 10 * 60, endMinute: 11 * 60 + 30, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Lunch", category: "break", intent: "", startMinute: 12 * 60, endMinute: 13 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Admin", category: "admin", intent: "inbox + slack, 60m cap", startMinute: 13 * 60, endMinute: 14 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Deep work 3", category: "deep-work", intent: "", startMinute: 14 * 60 + 30, endMinute: 16 * 60, days: [1, 2, 3, 4, 5], hard: true },
      {
        label: "Body", category: "body", intent: "gym / run",
        startMinute: 17 * 60, endMinute: 18 * 60, days: [1, 2, 3, 4, 5], hard: false, nonNegotiable: true,
        routineItems: [
          { label: "Warm-up 5 min" },
          { label: "Main session" },
          { label: "Cooldown + water" },
        ],
      },
    ],
  },
  {
    id: "balanced",
    name: "Balanced Day",
    tagline: "morning build · midday meet · afternoon ops",
    blocks: [
      { label: "Planning", category: "admin", intent: "pick the one thing", startMinute: 8 * 60, endMinute: 8 * 60 + 30, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Build block", category: "deep-work", intent: "", startMinute: 8 * 60 + 30, endMinute: 11 * 60, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Lunch + walk", category: "break", intent: "", startMinute: 12 * 60, endMinute: 13 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Meetings", category: "meetings", intent: "batched calls", startMinute: 13 * 60, endMinute: 15 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Ops & review", category: "ops", intent: "", startMinute: 15 * 60 + 30, endMinute: 17 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Personal", category: "personal", intent: "", startMinute: 18 * 60, endMinute: 20 * 60, days: [1, 2, 3, 4, 5], hard: false },
    ],
  },
  {
    id: "sprint",
    name: "Shipping Sprint",
    tagline: "pomodoro stack · 50/10 for 5 cycles",
    blocks: [
      { label: "Sprint 1", category: "deep-work", intent: "", startMinute: 9 * 60, endMinute: 9 * 60 + 50, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Break", category: "break", intent: "", startMinute: 9 * 60 + 50, endMinute: 10 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Sprint 2", category: "deep-work", intent: "", startMinute: 10 * 60, endMinute: 10 * 60 + 50, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Break", category: "break", intent: "", startMinute: 10 * 60 + 50, endMinute: 11 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Sprint 3", category: "deep-work", intent: "", startMinute: 11 * 60, endMinute: 11 * 60 + 50, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Lunch", category: "break", intent: "", startMinute: 12 * 60, endMinute: 13 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Sprint 4", category: "deep-work", intent: "", startMinute: 13 * 60, endMinute: 13 * 60 + 50, days: [1, 2, 3, 4, 5], hard: true },
      { label: "Break", category: "break", intent: "", startMinute: 13 * 60 + 50, endMinute: 14 * 60, days: [1, 2, 3, 4, 5], hard: false },
      { label: "Sprint 5", category: "deep-work", intent: "", startMinute: 14 * 60, endMinute: 14 * 60 + 50, days: [1, 2, 3, 4, 5], hard: true },
    ],
  },
  {
    id: "recovery",
    name: "Recovery Day",
    tagline: "body first · light ops · long break",
    blocks: [
      { label: "Body", category: "body", intent: "mobility + walk", startMinute: 8 * 60, endMinute: 9 * 60, days: [0, 6], hard: false },
      { label: "Slow admin", category: "admin", intent: "", startMinute: 10 * 60, endMinute: 11 * 60, days: [0, 6], hard: false },
      { label: "Personal", category: "personal", intent: "read, journal, no screens", startMinute: 15 * 60, endMinute: 17 * 60, days: [0, 6], hard: false },
    ],
  },
];

export async function applyPreset(
  state: DisciplineState,
  client: GatewayBrowserClient,
  presetId: string,
): Promise<void> {
  const preset = DISCIPLINE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  for (const b of preset.blocks) {
    const routineItems: RoutineItem[] = (b.routineItems ?? []).map((r, i) => ({
      id: newRoutineItemId(),
      label: r.label,
      order: i,
    }));
    await createBlock(state, client, {
      label: b.label,
      category: b.category,
      intent: b.intent,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
      days: b.days,
      hard: b.hard,
      enabled: true,
      nonNegotiable: !!b.nonNegotiable,
      routineItems,
    });
  }
}

export interface BlockProgress {
  block: DisciplineBlock | null;
  elapsedMin: number;
  totalMin: number;
  remainingMin: number;
  percent: number;
}

export function blockProgress(state: DisciplineState): BlockProgress {
  const block = currentBlock(state);
  if (!block) return { block: null, elapsedMin: 0, totalMin: 0, remainingMin: 0, percent: 0 };
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const start = effectiveStart(state, block);
  const total = Math.max(1, block.endMinute - start);
  const elapsed = Math.max(0, Math.min(total, nowMin - start));
  const percent = Math.round((elapsed / total) * 100);
  return { block, elapsedMin: elapsed, totalMin: total, remainingMin: total - elapsed, percent };
}

export function minutesUntilNext(state: DisciplineState): number | null {
  const next = nextBlock(state);
  if (!next) return null;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  return Math.max(0, effectiveStart(state, next) - nowMin);
}

function rebuildRoutineDoneIndex(completions: RoutineCompletion[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const c of completions ?? []) map[`${c.blockId}:${c.itemId}`] = true;
  return map;
}

export async function loadDiscipline(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  state.loading = true;
  state.error = null;
  try {
    const full = (await client.request("discipline.state", {})) as {
      blocks: DisciplineBlock[];
      logs: DisciplineLog[];
      settings: DisciplineSettings;
      routineCompletions?: RoutineCompletion[];
      blockCompletions?: ServerBlockCompletion[];
      blockOverrides?: ServerBlockOverride[];
      dayStart?: DayStartInfo | null;
    };
    state.blocks = (full.blocks ?? []).map(normalizeBlockShape);
    state.logs = full.logs ?? [];
    state.settings = normalizeSettings(full.settings);
    state.routineDone = rebuildRoutineDoneIndex(full.routineCompletions ?? []);
    applyDailyStatePayload(state, full.blockCompletions ?? [], full.blockOverrides ?? []);
    state.dayStart = full.dayStart ?? null;
    state.today = (await client.request("discipline.score.day", { date: todayIso() })) as DayScore;
    state.week = (await client.request("discipline.score.week", {})) as DayScore[];
    if (!state.kanbanLoaded) void loadKanbanLinks(state, client);
    if (!state.templatesLoaded) void loadTemplates(state, client);
    // Load auto-log counts + proactive insights for today (non-blocking)
    void loadAutoLogCounts(state, client);
    void loadInsights(state, client);
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  } finally {
    state.loading = false;
  }
}

export async function loadAutoLogCounts(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const res = (await client.request("discipline.events.list", { limit: 2000 })) as {
      counts: DisciplineEventCountSummary[];
      events: Array<{ id: string; blockId: string | null; kind: string; payload: string; createdAt: number }>;
    };
    state.autoLogCounts = res.counts ?? [];
    state.blockCompletionItems = (res.events ?? [])
      .filter((e) => e.kind === "kanban:task_done" || e.kind === "agent:completed")
      .map((e) => {
        let payload: { sourceId?: string; title?: string; completedAt?: number } = {};
        try { payload = JSON.parse(e.payload); } catch { /* ignore */ }
        return {
          id: e.id,
          blockId: e.blockId,
          kind: e.kind as "kanban:task_done" | "agent:completed",
          title: payload.title ?? (e.kind === "kanban:task_done" ? "Kanban task" : "Agent run"),
          sourceId: payload.sourceId ?? e.id,
          completedAt: payload.completedAt ?? e.createdAt,
        };
      });
  } catch {
    // Non-critical — silently swallow if the gateway doesn't have this handler yet
  }
}

/**
 * Load proactive per-block insights from the shared server engine. Best-effort
 * and non-blocking — folds the result into `state.insights` keyed by blockId so
 * each block card can render its headline + action chip without re-querying.
 */
export async function loadInsights(
  state: DisciplineState,
  client: GatewayBrowserClient,
  force = false,
): Promise<void> {
  try {
    const res = (await client.request("discipline.insights", force ? { force: true } : {})) as {
      insights: DisciplineInsight[];
      summary: DisciplineInsightSummary;
    };
    const byId: Record<string, DisciplineInsight> = {};
    for (const ins of res.insights ?? []) byId[ins.blockId] = ins;
    state.insights = byId;
    state.insightSummary = res.summary ?? null;
  } catch {
    // Non-critical — gateway may predate this handler.
  }
}

export async function shiftBlocksFromNow(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<{ shiftedCount: number }> {
  const res = (await client.request("discipline.shift_from_now", {})) as {
    shiftedCount: number;
    blocks: DisciplineBlock[];
    nowMin: number;
  };
  if (res.shiftedCount > 0) {
    const shiftedMap = new Map(res.blocks.map((b) => [b.id, b]));
    state.blocks = state.blocks.map((b) => shiftedMap.get(b.id) ?? b);
  }
  return { shiftedCount: res.shiftedCount };
}

/** Load today's work events and summary from the workload gateway methods. */
export async function loadWorkEvents(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  if (state.workloadLoading) return;
  state.workloadLoading = true;
  try {
    const today = todayIso();
    const result = (await client.request("workload.summary", { date: today })) as {
      summary: WorkloadSummary;
      weekly: WorkloadWeekDay[];
    };
    state.workloadSummary = result.summary ?? null;
    state.workloadWeekly = result.weekly ?? [];
    const listResult = (await client.request("workload.list", { startDate: today, endDate: today, limit: 200 })) as {
      events: WorkEvent[];
    };
    state.workEvents = listResult.events ?? [];
  } catch {
    /* non-critical — fail silently */
  } finally {
    state.workloadLoading = false;
  }
}

/** Older rows may be missing the new fields; ensure defaults so UI never crashes. */
function normalizeBlockShape(b: Partial<DisciplineBlock>): DisciplineBlock {
  return {
    id: b.id!,
    label: b.label ?? "",
    category: (b.category as DisciplineCategory) ?? "deep-work",
    intent: b.intent,
    startMinute: b.startMinute ?? 0,
    endMinute: b.endMinute ?? 0,
    days: b.days ?? [],
    oneOffDate: b.oneOffDate,
    hard: !!b.hard,
    enabled: b.enabled !== false,
    color: b.color,
    projectId: b.projectId,
    taskId: b.taskId,
    nonNegotiable: !!b.nonNegotiable,
    routineItems: Array.isArray(b.routineItems) ? b.routineItems : [],
    createdAt: b.createdAt ?? 0,
    updatedAt: b.updatedAt ?? 0,
  };
}

/** Toggle a kanban task between done and todo via the gateway, with an
 *  optimistic local update so the checkbox flips instantly. Falls back to
 *  the previous value if the gateway rejects. */
export async function toggleKanbanTaskDone(
  state: DisciplineState,
  client: GatewayBrowserClient,
  taskId: string,
): Promise<void> {
  const idx = state.kanbanTasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return;
  const current = state.kanbanTasks[idx]!;
  const wasDone = (current.status ?? "").toLowerCase() === "done";
  const nextStatus = wasDone ? "todo" : "done";

  // Mark in-flight and apply optimistic flip.
  if (!state.taskModal) {
    state.taskModal = { open: false, projectFilter: "all", viewMode: "board", updating: {} };
  }
  state.taskModal.updating[taskId] = true;
  state.kanbanTasks = state.kanbanTasks.map((t) =>
    t.id === taskId ? { ...t, status: nextStatus } : t,
  );

  try {
    await client.request("kanban.tasks.update", {
      id: taskId,
      patch: { status: nextStatus },
    });
  } catch (e) {
    // Roll back on failure.
    state.kanbanTasks = state.kanbanTasks.map((t) =>
      t.id === taskId ? { ...t, status: current.status } : t,
    );
    state.error = `Task update failed: ${(e as Error)?.message ?? e}`;
  } finally {
    if (state.taskModal) delete state.taskModal.updating[taskId];
  }
}

/** Move a task to a specific kanban status (todo/in_progress/review/done).
 *  Used by the "move to column" actions inside the task modal. */
export async function setKanbanTaskStatus(
  state: DisciplineState,
  client: GatewayBrowserClient,
  taskId: string,
  status: string,
): Promise<void> {
  const idx = state.kanbanTasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return;
  const previous = state.kanbanTasks[idx]!.status;
  if ((previous ?? "").toLowerCase() === status.toLowerCase()) return;
  if (!state.taskModal) {
    state.taskModal = { open: false, projectFilter: "all", viewMode: "board", updating: {} };
  }
  state.taskModal.updating[taskId] = true;
  state.kanbanTasks = state.kanbanTasks.map((t) =>
    t.id === taskId ? { ...t, status } : t,
  );
  try {
    await client.request("kanban.tasks.update", {
      id: taskId,
      patch: { status },
    });
  } catch (e) {
    state.kanbanTasks = state.kanbanTasks.map((t) =>
      t.id === taskId ? { ...t, status: previous } : t,
    );
    state.error = `Task move failed: ${(e as Error)?.message ?? e}`;
  } finally {
    if (state.taskModal) delete state.taskModal.updating[taskId];
  }
}

export function openTaskModal(state: DisciplineState): void {
  // Always reassign so the host's reactivity picks up the change even when
  // taskModal already exists. Lit's `requestUpdate` re-renders regardless,
  // but mutating then reassigning is a belt-and-braces guard.
  state.taskModal = {
    open: true,
    projectFilter: state.taskModal?.projectFilter ?? "all",
    viewMode: state.taskModal?.viewMode ?? "board",
    updating: state.taskModal?.updating ?? {},
  };
}

export function setTaskModalViewMode(
  state: DisciplineState,
  mode: "board" | "list" | "gallery",
): void {
  if (!state.taskModal) {
    state.taskModal = { open: true, projectFilter: "all", viewMode: mode, updating: {} };
  } else {
    state.taskModal.viewMode = mode;
  }
}

export function closeTaskModal(state: DisciplineState): void {
  if (state.taskModal) state.taskModal.open = false;
}

export function setTaskModalProjectFilter(
  state: DisciplineState,
  projectId: string | "all",
): void {
  if (!state.taskModal) {
    state.taskModal = { open: true, projectFilter: projectId, viewMode: "board", updating: {} };
  } else {
    state.taskModal.projectFilter = projectId;
  }
}

export async function loadKanbanLinks(state: DisciplineState, client: GatewayBrowserClient): Promise<void> {
  try {
    const [projects, tasks] = await Promise.all([
      client.request("kanban.projects.list", {}).catch(() => []),
      client.request("kanban.tasks.list", {}).catch(() => []),
    ]);
    state.kanbanProjects = (projects as any[]).map((p) => ({ id: p.id, name: p.name, color: p.color, status: p.status }));
    state.kanbanTasks = (tasks as any[]).map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
    }));
    state.kanbanLoaded = true;
  } catch (e) {
    console.warn("[discipline] failed to load kanban links", e);
  }
}

export async function toggleRoutineItem(
  state: DisciplineState,
  client: GatewayBrowserClient,
  blockId: string,
  itemId: string,
): Promise<void> {
  const key = `${blockId}:${itemId}`;
  const wasDone = !!state.routineDone[key];
  state.routineDone = { ...state.routineDone, [key]: !wasDone };
  try {
    const res = (await client.request("discipline.routine.toggle", {
      blockId,
      itemId,
      date: todayIso(),
    })) as { completed: boolean };
    state.routineDone = { ...state.routineDone, [key]: !!res.completed };
    void refreshScore(state, client);
  } catch (e) {
    state.routineDone = { ...state.routineDone, [key]: wasDone };
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function refreshScore(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    state.today = (await client.request("discipline.score.day", { date: todayIso() })) as DayScore;
    state.week = (await client.request("discipline.score.week", {})) as DayScore[];
  } catch (e) {
    console.warn("[discipline] refreshScore failed", e);
  }
}

export async function createBlock(
  state: DisciplineState,
  client: GatewayBrowserClient,
  input: Partial<DisciplineBlock> & { label: string },
): Promise<DisciplineBlock | null> {
  try {
    const created = (await client.request("discipline.blocks.create", {
      label: input.label,
      category: input.category ?? "deep-work",
      intent: input.intent,
      startMinute: input.startMinute ?? 9 * 60,
      endMinute: input.endMinute ?? 10 * 60,
      days: input.days ?? [1, 2, 3, 4, 5],
      oneOffDate: input.oneOffDate,
      hard: input.hard ?? false,
      enabled: input.enabled !== false,
      color: input.color,
      projectId: input.projectId,
      taskId: input.taskId,
      nonNegotiable: !!input.nonNegotiable,
      routineItems: input.routineItems ?? [],
    })) as DisciplineBlock;
    state.blocks = [...state.blocks, created].sort((a, b) => a.startMinute - b.startMinute);
    void refreshScore(state, client);
    return created;
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
    return null;
  }
}

export async function updateBlock(
  state: DisciplineState,
  client: GatewayBrowserClient,
  id: string,
  patch: Partial<DisciplineBlock>,
): Promise<DisciplineBlock | null> {
  try {
    const updated = (await client.request("discipline.blocks.update", { id, ...patch })) as DisciplineBlock;
    state.blocks = state.blocks
      .map((b) => (b.id === id ? updated : b))
      .sort((a, b) => a.startMinute - b.startMinute);
    void refreshScore(state, client);
    return updated;
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
    return null;
  }
}

export async function deleteBlock(
  state: DisciplineState,
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  try {
    await client.request("discipline.blocks.delete", { id });
    state.blocks = state.blocks.filter((b) => b.id !== id);
    if (state.editingBlockId === id) state.editingBlockId = null;
    void refreshScore(state, client);
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  }
}

/** Starts a log entry and records its id on state.activeProbe so we can close it. */
export async function startLog(
  state: DisciplineState,
  client: GatewayBrowserClient,
  input: { label: string; category: DisciplineCategory; blockId?: string; source?: LogSource },
): Promise<DisciplineLog | null> {
  try {
    const now = Date.now();
    const entry = (await client.request("discipline.logs.create", {
      label: input.label,
      category: input.category,
      blockId: input.blockId,
      source: input.source ?? "manual",
      startMs: now,
    })) as DisciplineLog;
    state.logs = [entry, ...state.logs];
    state.activeProbe.id = entry.id;
    state.activeProbe.startedAt = now;
    return entry;
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
    return null;
  }
}

export async function stopLog(
  state: DisciplineState,
  client: GatewayBrowserClient,
  id: string,
  note?: string,
): Promise<void> {
  try {
    const endMs = Date.now();
    const updated = (await client.request("discipline.logs.update", {
      id,
      endMs,
      note,
    })) as DisciplineLog;
    state.logs = state.logs.map((l) => (l.id === id ? updated : l));
    if (state.activeProbe.id === id) {
      state.activeProbe.id = null;
      state.activeProbe.startedAt = null;
    }
    void refreshScore(state, client);
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function quickLog(
  state: DisciplineState,
  client: GatewayBrowserClient,
  input: { label: string; category: DisciplineCategory; blockId?: string },
): Promise<void> {
  try {
    const now = Date.now();
    const created = (await client.request("discipline.logs.create", {
      label: input.label,
      category: input.category,
      blockId: input.blockId,
      source: "probe",
      startMs: now - 5 * 60 * 1000,
      endMs: now,
    })) as DisciplineLog;
    state.logs = [created, ...state.logs];
    void refreshScore(state, client);
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function abortBlock(
  state: DisciplineState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  reason: string,
): Promise<void> {
  try {
    const now = Date.now();
    await client.request("discipline.logs.create", {
      blockId: block.id,
      label: `ABORT: ${block.label}`,
      category: block.category,
      source: "abort",
      startMs: now,
      endMs: now,
      reason,
    });
    try {
      const m = await import("./discipline-notify");
      m.notifyBlockAborted(state, client, block, reason);
    } catch {
      /* ignore */
    }
    void loadDiscipline(state, client);
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function updateSettings(
  state: DisciplineState,
  client: GatewayBrowserClient,
  patch: Partial<DisciplineSettings>,
): Promise<void> {
  // Optimistic merge so the UI stays responsive even if the server doesn't yet
  // know about new fields (telegram/AI/quietHours) — the gateway round-trip
  // returns whatever subset it persisted, which we then re-merge through the
  // normalizer so we never drop client-only fields.
  const optimistic = { ...state.settings, ...patch };
  if (patch.telegramEvents) {
    optimistic.telegramEvents = { ...state.settings.telegramEvents, ...patch.telegramEvents };
  }
  if (patch.ai) {
    optimistic.ai = { ...state.settings.ai, ...patch.ai };
  }
  state.settings = optimistic;
  try {
    const persisted = (await client.request(
      "discipline.settings.update",
      patch as any,
    )) as Partial<DisciplineSettings>;
    state.settings = normalizeSettings({ ...optimistic, ...persisted });
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
  }
}

// ── Priority context (kanban → discipline) ─────────────────────────────────

export type DisciplinePriority = "critical" | "high" | "normal" | "low";

const PRIORITY_RANK: Record<DisciplinePriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Resolve the priority context for a block by walking from the linked kanban
 * task → its parent project. Tasks beat projects when both are present, since
 * the user's actual focus item is the leaf. Falls back to "normal" so blocks
 * without any link sort below blocks that have explicit priority.
 */
export function blockPriority(state: DisciplineState, block: DisciplineBlock): DisciplinePriority {
  if (block.taskId) {
    const t = state.kanbanTasks.find((x) => x.id === block.taskId);
    const raw = (t as any)?.priority as DisciplinePriority | undefined;
    if (raw && raw in PRIORITY_RANK) return raw;
  }
  if (block.projectId) {
    const p = state.kanbanProjects.find((x) => x.id === block.projectId);
    const raw = (p as any)?.priority as string | undefined;
    if (raw) {
      const norm = raw.toLowerCase();
      if (norm.includes("immediate") || norm.includes("critical")) return "critical";
      if (norm.includes("high")) return "high";
      if (norm.includes("low")) return "low";
    }
  }
  return "normal";
}

export function priorityRank(p: DisciplinePriority): number {
  return PRIORITY_RANK[p];
}

/** Sort blocks by priority desc, then by start time asc — used by Blocks view. */
export function sortByPriority(state: DisciplineState, blocks: DisciplineBlock[]): DisciplineBlock[] {
  return [...blocks].sort((a, b) => {
    const dr = priorityRank(blockPriority(state, b)) - priorityRank(blockPriority(state, a));
    if (dr !== 0) return dr;
    return a.startMinute - b.startMinute;
  });
}

/** Resolved task title + project name for surfacing in block cards / timeline. */
export interface BlockLinkContext {
  taskTitle?: string;
  projectName?: string;
  projectColor?: string;
  priority: DisciplinePriority;
  taskStatus?: string;
}

export function blockLinkContext(state: DisciplineState, block: DisciplineBlock): BlockLinkContext {
  const task = block.taskId ? state.kanbanTasks.find((t) => t.id === block.taskId) : undefined;
  const project = block.projectId ? state.kanbanProjects.find((p) => p.id === block.projectId) : undefined;
  return {
    taskTitle: task?.title,
    taskStatus: task?.status,
    projectName: project?.name,
    projectColor: project?.color,
    priority: blockPriority(state, block),
  };
}

// ── Focus ↔ Discipline project sync ─────────────────────────────────────────
// Focus (controllers/focus.ts) is the single source of truth for which
// projects are "active". Discipline reads that set and toggles membership
// through Focus's storage-backed helpers — no separate persistence channel.

interface FocusHost {
  focusState?: { items?: Array<{ projectId?: string | null }> };
}

/** The active project set for /discipline — the projects pinned to Focus.
 *  Reads a live FocusState when the host carries one, else falls back to
 *  Focus's persisted storage (the same source). */
export function getDisciplineFocusProjects(host?: FocusHost): string[] {
  const fromState = host?.focusState?.items
    ?.map((i) => i.projectId)
    .filter((id): id is string => !!id);
  if (fromState && fromState.length) return fromState;
  return getFocusProjectIds();
}

/** True when a project is currently in the Focus/active set. */
export function isProjectFocused(projectId: string, host?: FocusHost): boolean {
  return getDisciplineFocusProjects(host).includes(projectId);
}

/** Activate/deactivate a project from /discipline — routes through Focus so the
 *  change shows up on the Focus board (and fires FOCUS_CHANGED_EVENT). Returns
 *  true if the project is now active. */
export function setProjectActiveFromDiscipline(
  state: DisciplineState,
  projectId: string,
  active: boolean,
): boolean {
  if (!projectId) return false;
  if (active) {
    const name = state.kanbanProjects.find((p) => p.id === projectId)?.name;
    addProjectToFocus(projectId, name);
    return true;
  }
  removeProjectFromFocus(projectId);
  return false;
}

export function toggleProjectActiveFromDiscipline(
  state: DisciplineState,
  projectId: string,
): boolean {
  const next = !isProjectFocused(projectId);
  return setProjectActiveFromDiscipline(state, projectId, next);
}

/** The effective start minute for a block today, respecting the auto-advance override. */
export function effectiveStart(state: DisciplineState, block: DisciplineBlock): number {
  const ovr = state.blockStartOverride[block.id];
  return typeof ovr === "number" ? ovr : block.startMinute;
}

export function isBlockDoneToday(state: DisciplineState, blockId: string): boolean {
  return !!state.blockDone[blockId];
}

export function currentBlock(state: DisciplineState): DisciplineBlock | null {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  const iso = todayIso();
  const today = state.blocks.filter((b) => {
    if (!b.enabled) return false;
    if (b.oneOffDate) return b.oneOffDate === iso;
    return (b.days ?? []).includes(dow);
  });
  return (
    today.find((b) => {
      if (isBlockDoneToday(state, b.id)) return false;
      const start = effectiveStart(state, b);
      return mins >= start && mins < b.endMinute;
    }) ?? null
  );
}

export function nextBlock(state: DisciplineState): DisciplineBlock | null {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  const iso = todayIso();
  const upcoming = state.blocks
    .filter((b) => {
      if (!b.enabled) return false;
      if (isBlockDoneToday(state, b.id)) return false;
      if (b.oneOffDate) return b.oneOffDate === iso;
      return (b.days ?? []).includes(dow);
    })
    .filter((b) => effectiveStart(state, b) > mins)
    .sort((a, b) => effectiveStart(state, a) - effectiveStart(state, b));
  return upcoming[0] ?? null;
}

/** Mark a block completed for today. Banks any time saved and auto-advances the next block. */
export async function markBlockDone(
  state: DisciplineState,
  client: GatewayBrowserClient,
  blockId: string,
): Promise<void> {
  if (state.blockDone[blockId]) return;
  const b = state.blocks.find((x) => x.id === blockId);
  if (!b) return;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const optimisticSaved = Math.max(0, b.endMinute - nowMin);
  state.blockDone = {
    ...state.blockDone,
    [blockId]: { completedMin: nowMin, savedMin: optimisticSaved },
  };
  state.timeSavedMin = state.timeSavedMin + optimisticSaved;
  try {
    const result = (await client.request("discipline.blocks.complete", {
      id: blockId,
      date: todayIso(),
      nowMinute: nowMin,
    })) as {
      completion: ServerBlockCompletion;
      override: ServerBlockOverride | null;
    };
    state.blockDone = {
      ...state.blockDone,
      [blockId]: {
        completedMin: result.completion.completedMinute,
        savedMin: result.completion.savedMinute,
      },
    };
    state.timeSavedMin =
      state.timeSavedMin - optimisticSaved + result.completion.savedMinute;
    if (result.override) {
      state.blockStartOverride = {
        ...state.blockStartOverride,
        [result.override.blockId]: result.override.startMinute,
      };
    }
    // Notify (telegram + browser) on successful completion. Lazy-imported to
    // keep the controller free of a hard dep on the notify module's optional
    // network calls.
    try {
      const m = await import("./discipline-notify");
      m.notifyBlockCompleted(state, client, b, result.completion.savedMinute);
    } catch {
      /* ignore */
    }
  } catch (e) {
    const rollback = { ...state.blockDone };
    delete rollback[blockId];
    state.blockDone = rollback;
    state.timeSavedMin = Math.max(0, state.timeSavedMin - optimisticSaved);
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function unmarkBlockDone(
  state: DisciplineState,
  client: GatewayBrowserClient,
  blockId: string,
): Promise<void> {
  const existing = state.blockDone[blockId];
  if (!existing) return;
  const priorSaved = existing.savedMin;
  const rest = { ...state.blockDone };
  delete rest[blockId];
  state.blockDone = rest;
  state.timeSavedMin = Math.max(0, state.timeSavedMin - priorSaved);
  try {
    const result = (await client.request("discipline.blocks.uncomplete", {
      id: blockId,
      date: todayIso(),
    })) as { removedOverrideForBlockId: string | null };
    if (result.removedOverrideForBlockId) {
      const ovr = { ...state.blockStartOverride };
      delete ovr[result.removedOverrideForBlockId];
      state.blockStartOverride = ovr;
    }
  } catch (e) {
    state.blockDone = { ...state.blockDone, [blockId]: existing };
    state.timeSavedMin = state.timeSavedMin + priorSaved;
    state.error = String((e as Error)?.message ?? e);
  }
}

export async function resetBlockOverrides(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  const prev = state.blockStartOverride;
  state.blockStartOverride = {};
  try {
    await client.request("discipline.blocks.overrides.reset", { date: todayIso() });
  } catch (e) {
    state.blockStartOverride = prev;
    state.error = String((e as Error)?.message ?? e);
  }
}

export function streakDays(week: DayScore[]): number {
  let streak = 0;
  for (let i = week.length - 1; i >= 0; i--) {
    if ((week[i]?.compliance ?? 0) >= 80) streak += 1;
    else break;
  }
  return streak;
}

// ── Templates ──────────────────────────────────────────────────────────────

const TEMPLATE_STORAGE_KEY = "infinibot.discipline.templates.v1";
const TEMPLATE_ACTIVE_KEY = "infinibot.discipline.activeTemplate.v1";

let templateSeq = 0;
function newTemplateId(): string {
  templateSeq += 1;
  return `tpl_${Date.now().toString(36)}_${templateSeq}`;
}

/** Convert a runtime block to its persistable template form (no ids, no daily state). */
export function blockToTemplate(b: DisciplineBlock): TemplateBlock {
  return {
    label: b.label,
    category: b.category,
    intent: b.intent,
    startMinute: b.startMinute,
    endMinute: b.endMinute,
    days: [...(b.days ?? [])],
    hard: b.hard,
    enabled: b.enabled,
    nonNegotiable: b.nonNegotiable,
    color: b.color,
    projectId: b.projectId,
    taskId: b.taskId,
    routineItems: (b.routineItems ?? []).map((r, i) => ({ label: r.label, order: r.order ?? i })),
  };
}

/** Stable signature for two TemplateBlock arrays — used for dirty detection. */
function templateBlocksSignature(blocks: TemplateBlock[]): string {
  const norm = blocks
    .map((b) => ({
      label: b.label,
      category: b.category,
      intent: b.intent ?? "",
      startMinute: b.startMinute,
      endMinute: b.endMinute,
      days: [...(b.days ?? [])].sort((a, b) => a - b),
      hard: !!b.hard,
      enabled: !!b.enabled,
      nonNegotiable: !!b.nonNegotiable,
      projectId: b.projectId ?? "",
      taskId: b.taskId ?? "",
      routineItems: (b.routineItems ?? []).map((r) => r.label),
    }))
    .sort((a, b) =>
      a.startMinute !== b.startMinute
        ? a.startMinute - b.startMinute
        : a.label.localeCompare(b.label),
    );
  return JSON.stringify(norm);
}

/** True when the current block layout differs from the active template's snapshot. */
export function isTemplateDirty(state: DisciplineState): boolean {
  if (!state.activeTemplateId || !state.activeTemplateSnapshot) return false;
  const current = state.blocks.map(blockToTemplate);
  return templateBlocksSignature(current) !== templateBlocksSignature(state.activeTemplateSnapshot);
}

/** Currently-loaded template name, or null if the layout is custom / unsaved. */
export function activeTemplateName(state: DisciplineState): string | null {
  if (!state.activeTemplateId) return null;
  const t = state.templates.find((x) => x.id === state.activeTemplateId);
  return t?.name ?? null;
}

function readLocalTemplates(): DisciplineTemplate[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DisciplineTemplate[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalTemplates(templates: DisciplineTemplate[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    // Don't persist the bundled presets — they're computed each load.
    const userOnly = templates.filter((t) => t.source !== "preset");
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(userOnly));
  } catch {
    /* ignore quota / serialization */
  }
}

function readActiveTemplate(): { id: string; snapshot: TemplateBlock[] } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(TEMPLATE_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.id === "string" && Array.isArray(parsed.snapshot)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeActiveTemplate(id: string | null, snapshot: TemplateBlock[] | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!id || !snapshot) {
      localStorage.removeItem(TEMPLATE_ACTIVE_KEY);
      return;
    }
    localStorage.setItem(TEMPLATE_ACTIVE_KEY, JSON.stringify({ id, snapshot }));
  } catch {
    /* ignore */
  }
}

/** Convert the bundled DISCIPLINE_PRESETS into DisciplineTemplate shape so the picker can list them alongside user templates. */
function presetsAsTemplates(): DisciplineTemplate[] {
  const now = Date.now();
  return DISCIPLINE_PRESETS.map((p) => ({
    id: `preset:${p.id}`,
    name: p.name,
    description: p.tagline,
    source: "preset" as const,
    createdAt: now,
    updatedAt: now,
    blocks: p.blocks.map((b, i) => ({
      label: b.label,
      category: b.category,
      intent: b.intent,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
      days: [...b.days],
      hard: b.hard,
      enabled: true,
      nonNegotiable: !!b.nonNegotiable,
      routineItems: (b.routineItems ?? []).map((r, j) => ({ label: r.label, order: j })),
    })),
  }));
}

/**
 * Load templates from the gateway, fall back to localStorage. Always merges
 * the bundled presets so they're available alongside user templates.
 */
export async function loadTemplates(
  state: DisciplineState,
  client: GatewayBrowserClient,
): Promise<void> {
  let userTemplates: DisciplineTemplate[] = [];
  try {
    const remote = (await client.request("discipline.templates.list", {})) as DisciplineTemplate[];
    if (Array.isArray(remote)) userTemplates = remote;
  } catch {
    userTemplates = readLocalTemplates();
  }
  state.templates = [...userTemplates, ...presetsAsTemplates()];
  state.templatesLoaded = true;

  // Restore active template from localStorage if we had one.
  const active = readActiveTemplate();
  if (active && state.templates.find((t) => t.id === active.id)) {
    state.activeTemplateId = active.id;
    state.activeTemplateSnapshot = active.snapshot;
  }
}

/**
 * Save the current block layout as a new template. Server-first, falls back
 * to local-only when offline. Sets the new template as active so the user
 * can iteratively modify + re-save without re-naming.
 */
export async function saveAsTemplate(
  state: DisciplineState,
  client: GatewayBrowserClient,
  name: string,
  description?: string,
): Promise<DisciplineTemplate | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const blocks = state.blocks.map(blockToTemplate);
  const tpl: DisciplineTemplate = {
    id: newTemplateId(),
    name: trimmed,
    description: description?.trim() || undefined,
    blocks,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: "user",
  };
  // Optimistic insert; reconcile id with server response if the server returns one.
  state.templates = [tpl, ...state.templates];
  state.activeTemplateId = tpl.id;
  state.activeTemplateSnapshot = blocks;
  try {
    const persisted = (await client.request("discipline.templates.create", {
      name: tpl.name,
      description: tpl.description,
      blocks: tpl.blocks,
    })) as DisciplineTemplate;
    if (persisted?.id && persisted.id !== tpl.id) {
      // Server canonical id — swap.
      state.templates = state.templates.map((t) => (t.id === tpl.id ? { ...persisted, source: "user" } : t));
      state.activeTemplateId = persisted.id;
    }
  } catch {
    // Keep optimistic + persist locally.
    writeLocalTemplates(state.templates);
  }
  writeActiveTemplate(state.activeTemplateId, state.activeTemplateSnapshot);
  return tpl;
}

/**
 * Update an existing template with the current layout. Useful for "Save changes"
 * after editing blocks while a template is active.
 */
export async function overwriteTemplate(
  state: DisciplineState,
  client: GatewayBrowserClient,
  templateId: string,
): Promise<void> {
  const target = state.templates.find((t) => t.id === templateId);
  if (!target || target.source === "preset") return;
  const blocks = state.blocks.map(blockToTemplate);
  const updated: DisciplineTemplate = { ...target, blocks, updatedAt: Date.now() };
  state.templates = state.templates.map((t) => (t.id === templateId ? updated : t));
  state.activeTemplateSnapshot = blocks;
  try {
    await client.request("discipline.templates.update", {
      id: templateId,
      name: updated.name,
      description: updated.description,
      blocks: updated.blocks,
    });
  } catch {
    writeLocalTemplates(state.templates);
  }
  writeActiveTemplate(state.activeTemplateId, state.activeTemplateSnapshot);
}

export async function renameTemplate(
  state: DisciplineState,
  client: GatewayBrowserClient,
  templateId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = state.templates.find((t) => t.id === templateId);
  if (!target || target.source === "preset") return;
  state.templates = state.templates.map((t) =>
    t.id === templateId ? { ...t, name: trimmed, updatedAt: Date.now() } : t,
  );
  try {
    await client.request("discipline.templates.update", { id: templateId, name: trimmed });
  } catch {
    writeLocalTemplates(state.templates);
  }
}

export async function deleteTemplate(
  state: DisciplineState,
  client: GatewayBrowserClient,
  templateId: string,
): Promise<void> {
  const target = state.templates.find((t) => t.id === templateId);
  if (!target || target.source === "preset") return;
  state.templates = state.templates.filter((t) => t.id !== templateId);
  if (state.activeTemplateId === templateId) {
    state.activeTemplateId = null;
    state.activeTemplateSnapshot = null;
    writeActiveTemplate(null, null);
  }
  try {
    await client.request("discipline.templates.delete", { id: templateId });
  } catch {
    writeLocalTemplates(state.templates);
  }
}

/**
 * Apply a template's blocks to the current layout. `mode` chooses replace
 * (delete current blocks, then create from template) or append (additive,
 * matches the existing applyPreset behavior).
 */
export async function applyTemplate(
  state: DisciplineState,
  client: GatewayBrowserClient,
  templateId: string,
  mode: "replace" | "append" = "replace",
): Promise<void> {
  const tpl = state.templates.find((t) => t.id === templateId);
  if (!tpl) return;
  if (mode === "replace") {
    // Delete every existing block, then create the template's. We do this
    // sequentially so the gateway sees a clean slate before the new ones land
    // — otherwise a slow connection could leave both sets co-existing for a
    // moment which is confusing in the UI.
    const existing = [...state.blocks];
    for (const b of existing) {
      try { await deleteBlock(state, client, b.id); } catch { /* tolerate per-block failures */ }
    }
  }
  for (const b of tpl.blocks) {
    const routineItems: RoutineItem[] = (b.routineItems ?? []).map((r, i) => ({
      id: newRoutineItemId(),
      label: r.label,
      order: i,
    }));
    await createBlock(state, client, {
      label: b.label,
      category: b.category,
      intent: b.intent,
      startMinute: b.startMinute,
      endMinute: b.endMinute,
      days: b.days,
      hard: b.hard,
      enabled: b.enabled,
      nonNegotiable: b.nonNegotiable,
      color: b.color,
      projectId: b.projectId,
      taskId: b.taskId,
      routineItems,
    });
  }
  // Mark this template as the active one + snapshot the layout so dirty
  // tracking starts from the just-loaded blocks.
  state.activeTemplateId = templateId;
  state.activeTemplateSnapshot = tpl.blocks;
  writeActiveTemplate(state.activeTemplateId, state.activeTemplateSnapshot);

  // Reset any explicit "today only" pin the user set previously so they
  // immediately see the freshly-loaded blocks. The timeline defaults to
  // showing every enabled block; the user can opt back into the day filter
  // via the strip on the timeline header.
  state.timelinePreviewAllDays = true;
}

/** Drop the active-template association without touching the blocks. */
export function clearActiveTemplate(state: DisciplineState): void {
  state.activeTemplateId = null;
  state.activeTemplateSnapshot = null;
  writeActiveTemplate(null, null);
}

// ── Historic analytics ─────────────────────────────────────────────────────

function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fillMissingDays(scores: DayScore[], days: number): DayScore[] {
  // Walk the [start..today] window and fill any missing entries with a zeroed
  // score so chart axes stay continuous (no gaps that mislead the eye).
  const byDate = new Map(scores.map((s) => [s.date, s]));
  const out: DayScore[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    out.push(
      byDate.get(iso) ?? {
        date: iso,
        plannedMinutes: 0,
        actualMinutes: 0,
        compliance: 0,
        slippageCount: 0,
        nonNegotiableMissed: 0,
        nonNegotiableTotal: 0,
        routineCompleted: 0,
        routineTotal: 0,
        categoryMinutes: {},
      },
    );
  }
  return out;
}

/**
 * Best streak of consecutive ≥80%-compliance days anywhere in the window.
 * Treats the array as already day-by-day ascending.
 */
function bestStreak(scores: DayScore[]): number {
  let best = 0;
  let run = 0;
  for (const s of scores) {
    if (s.compliance >= 80) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Counts slips bucketed by day-of-week (0=Sun..6=Sat). Useful for spotting
 * weekly drift patterns ("I slip every Wednesday").
 */
function bucketSlipsByDow(scores: DayScore[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const s of scores) {
    const d = new Date(`${s.date}T00:00:00`).getDay();
    out[d] += s.slippageCount;
  }
  return out;
}

/**
 * Category × day matrix: for every category, an array of N minute-totals
 * indexed by the day position in the (filled, contiguous) range. Used to
 * draw the stacked-bar / area chart of where time went over the range.
 */
function buildCategoryMatrix(scores: DayScore[]): Partial<Record<DisciplineCategory, number[]>> {
  const out: Partial<Record<DisciplineCategory, number[]>> = {};
  for (const cat of DISCIPLINE_CATEGORIES) out[cat] = new Array(scores.length).fill(0);
  scores.forEach((s, i) => {
    for (const cat of DISCIPLINE_CATEGORIES) {
      const v = s.categoryMinutes?.[cat] ?? 0;
      out[cat]![i] = v;
    }
  });
  return out;
}

/**
 * Per-block historical performance: how often each block actually ran (logs)
 * vs how often it was scheduled (block.days × number of matching dates).
 */
function buildBlockStats(state: DisciplineState, sinceMs: number, untilMs: number): BlockStats[] {
  const stats: Record<string, BlockStats> = {};
  for (const b of state.blocks) {
    stats[b.id] = {
      blockId: b.id,
      label: b.label,
      category: b.category,
      scheduledCount: 0,
      completedCount: 0,
      abortedCount: 0,
      loggedMin: 0,
      completionRate: 0,
    };
    // Scheduled count: walk every day in [sinceMs, untilMs) and count matches.
    if (b.enabled) {
      for (let t = sinceMs; t < untilMs; t += 24 * 60 * 60 * 1000) {
        const d = new Date(t);
        const dow = d.getDay();
        const iso = d.toISOString().slice(0, 10);
        if (b.oneOffDate ? b.oneOffDate === iso : (b.days ?? []).includes(dow)) {
          stats[b.id]!.scheduledCount += 1;
        }
      }
    }
  }
  // Completion + abort counts come from logs that referenced a blockId.
  for (const log of state.logs) {
    if (log.startMs < sinceMs || log.startMs >= untilMs) continue;
    if (!log.blockId || !stats[log.blockId]) continue;
    const s = stats[log.blockId]!;
    if (log.source === "abort") s.abortedCount += 1;
    else s.completedCount += 1;
    if (log.endMs && log.endMs > log.startMs) {
      s.loggedMin += Math.round((log.endMs - log.startMs) / 60000);
    }
  }
  for (const id of Object.keys(stats)) {
    const s = stats[id]!;
    s.completionRate = s.scheduledCount > 0 ? s.completedCount / s.scheduledCount : 0;
  }
  return Object.values(stats);
}

/**
 * Group abort logs by reason — surfaces the common "why did I bail?" answers
 * so the user can see drift patterns at a glance.
 */
function buildAbortReasons(logs: DisciplineLog[], sinceMs: number, untilMs: number): AbortReasonSummary[] {
  const map = new Map<string, AbortReasonSummary>();
  for (const log of logs) {
    if (log.source !== "abort") continue;
    if (log.startMs < sinceMs || log.startMs >= untilMs) continue;
    const key = (log.reason || log.note || "(no reason)").trim().toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (log.startMs > existing.lastAt) existing.lastAt = log.startMs;
    } else {
      map.set(key, { reason: log.reason || log.note || "(no reason)", count: 1, lastAt: log.startMs });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * Derive a DayScore[] from the local logs cache when the gateway doesn't
 * expose a range endpoint. Approximate: actualMinutes = sum of logged
 * minutes per day; planned/compliance/non-negotiable counts read 0 since we
 * can't reconstruct the day's schedule history without the server. Better
 * than nothing — gives the user category trends + slip counts even offline.
 */
function deriveScoresFromLogs(state: DisciplineState, days: number): DayScore[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const since = today.getTime() - (days - 1) * 24 * 60 * 60 * 1000;
  const buckets = new Map<string, DayScore>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    buckets.set(iso, {
      date: iso,
      plannedMinutes: 0,
      actualMinutes: 0,
      compliance: 0,
      slippageCount: 0,
      nonNegotiableMissed: 0,
      nonNegotiableTotal: 0,
      routineCompleted: 0,
      routineTotal: 0,
      categoryMinutes: {},
    });
  }
  for (const log of state.logs) {
    if (log.startMs < since) continue;
    const iso = new Date(log.startMs).toISOString().slice(0, 10);
    const bucket = buckets.get(iso);
    if (!bucket) continue;
    if (log.source === "abort") {
      bucket.slippageCount += 1;
    } else if (log.endMs && log.endMs > log.startMs) {
      const m = Math.round((log.endMs - log.startMs) / 60000);
      bucket.actualMinutes += m;
      bucket.categoryMinutes[log.category] = (bucket.categoryMinutes[log.category] ?? 0) + m;
    }
  }
  // Derive a rough compliance from actual ratio relative to typical day's
  // planned (use 8h as a reasonable upper bound when we have no server data).
  const plannedFloor = 8 * 60;
  for (const b of buckets.values()) {
    b.plannedMinutes = plannedFloor;
    b.compliance = Math.min(100, Math.round((b.actualMinutes / plannedFloor) * 100));
  }
  return [...buckets.values()];
}

export async function loadAnalyticsRange(
  state: DisciplineState,
  client: GatewayBrowserClient,
  days: AnalyticsWindow,
): Promise<void> {
  state.analytics.loading = true;
  state.analytics.days = days;
  try {
    let raw: DayScore[] = [];
    let source: "gateway" | "logs" = "gateway";
    try {
      raw = (await client.request("discipline.score.range", {
        from: isoNDaysAgo(days - 1),
        to: todayIso(),
      })) as DayScore[];
      if (!Array.isArray(raw)) raw = [];
    } catch {
      // Gateway endpoint not available — derive from local logs cache.
      raw = deriveScoresFromLogs(state, days);
      source = "logs";
    }

    const scores = fillMissingDays(raw, days);
    const sinceMs = new Date(`${scores[0]!.date}T00:00:00`).getTime();
    const untilMs = Date.now();
    const compls = scores.map((s) => s.compliance);
    const totalLoggedMin = scores.reduce((a, s) => a + s.actualMinutes, 0);
    const totalPlannedMin = scores.reduce((a, s) => a + s.plannedMinutes, 0);
    const totalSlips = scores.reduce((a, s) => a + s.slippageCount, 0);
    const cumulativeSavedMin = state.timeSavedMin;

    state.analytics = {
      days,
      loaded: true,
      loading: false,
      source,
      scores,
      avgCompliance: compls.length > 0 ? Math.round(compls.reduce((a, b) => a + b, 0) / compls.length) : 0,
      bestCompliance: compls.length > 0 ? Math.max(...compls) : 0,
      worstCompliance: compls.length > 0 ? Math.min(...compls) : 0,
      totalLoggedMin,
      totalPlannedMin,
      totalSlips,
      bestStreak: bestStreak(scores),
      currentStreak: streakDays(scores),
      cumulativeSavedMin,
      slipsByDow: bucketSlipsByDow(scores),
      categoryMatrix: buildCategoryMatrix(scores),
      blockStats: buildBlockStats(state, sinceMs, untilMs),
      abortReasons: buildAbortReasons(state.logs, sinceMs, untilMs),
    };
  } catch (e) {
    state.analytics.loading = false;
    state.analytics.loaded = true;
    state.error = String((e as Error)?.message ?? e);
  }
}
