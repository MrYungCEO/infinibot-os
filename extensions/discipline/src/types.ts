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

export type LogSource = "planned" | "probe" | "manual" | "abort";

export interface RoutineItem {
  id: string;
  label: string;
  order: number;
}

/**
 * A scheduled time-block. Recurring when `days` is non-empty; one-off when `oneOffDate` is set.
 * `startMinute`/`endMinute` are minutes-from-midnight in the user's local zone (0..1440).
 */
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
  /** Linked kanban project (Notion page id). */
  projectId?: string;
  /** Linked kanban task (Notion page id). */
  taskId?: string;
  /** If true, missing this block counts as a critical slip (red in score). */
  nonNegotiable: boolean;
  /** Per-day checklist items that appear inside the block each day it fires. */
  routineItems: RoutineItem[];
  createdAt: number;
  updatedAt: number;
}

/**
 * A reusable snapshot of a block layout. Stored server-side so a saved
 * template survives reloads and is reachable by both the UI and the
 * agent tool. Apply replaces the live block set with these.
 */
export interface DisciplineTemplateBlock {
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
  blocks: DisciplineTemplateBlock[];
  /** "user" = saved by an operator, "imported" = brought in from JSON. */
  source: "user" | "imported";
  createdAt: number;
  updatedAt: number;
}

/** One completion record for a routine item on a given local date. */
export interface RoutineCompletion {
  blockId: string;
  itemId: string;
  dateIso: string;
  completedAt: number;
}

/** One block-level completion for a given date. */
export interface BlockCompletion {
  blockId: string;
  dateIso: string;
  completedMinute: number;
  savedMinute: number;
  completedAt: number;
}

/** A per-day start-minute override for a block (set when an earlier block finishes early). */
export interface BlockOverride {
  blockId: string;
  dateIso: string;
  startMinute: number;
}

/** Actual observed activity — planned block start/end, drift probe, or manual entry. */
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

export const DEFAULT_TELEGRAM_EVENT_TOGGLES: TelegramEventToggles = {
  blockStart: true,
  blockEnd: true,
  blockComplete: false,
  abort: true,
  slip: true,
  dailyReview: true,
};

export interface DisciplineSettings {
  militant: boolean;
  probeIntervalMin: number;
  dayStartHour: number;
  dayEndHour: number;
  /** Mute notifications between these hours (24h, wraps midnight when end < start). */
  quietHoursStart: number;
  quietHoursEnd: number;
  telegramEnabled: boolean;
  telegramChatId: string;
  telegramEvents: TelegramEventToggles;
  /** Sort/filter blocks view by linked kanban task priority. */
  prioritySortEnabled: boolean;
  priorityHighlight: boolean;
  updatedAt: number;
}

export const DEFAULT_DISCIPLINE_SETTINGS: DisciplineSettings = {
  militant: false,
  probeIntervalMin: 30,
  dayStartHour: 6,
  dayEndHour: 23,
  quietHoursStart: 22,
  quietHoursEnd: 6,
  telegramEnabled: false,
  telegramChatId: "",
  telegramEvents: { ...DEFAULT_TELEGRAM_EVENT_TOGGLES },
  prioritySortEnabled: false,
  priorityHighlight: true,
  updatedAt: 0,
};

// ── Auto-log events ──────────────────────────────────────────

export type DisciplineEventKind =
  | "agent:lifecycle"
  | "agent:tool"
  | "agent:assistant"
  | "agent:error"
  | "voice:transcript"
  | "chat:message"
  | "kanban:task_change";

export interface DisciplineEvent {
  id: string;
  /** Discipline block active when the event was captured (null = free-form). */
  blockId: string | null;
  kind: DisciplineEventKind | string;
  /** JSON-serialised payload (runId, sessionKey, tool name, etc.). */
  payload: string;
  createdAt: number;
  /** When the block attribution was resolved (may differ from createdAt). */
  attributedAt: number;
}

export interface DisciplineEventCounts {
  blockId: string | null;
  total: number;
  byKind: Partial<Record<string, number>>;
}

export interface DayScore {
  date: string;
  plannedMinutes: number;
  actualMinutes: number;
  compliance: number;
  slippageCount: number;
  /** Number of non-negotiable blocks that were missed (no planned-source log hit). */
  nonNegotiableMissed: number;
  /** Total non-negotiable blocks scheduled that day. */
  nonNegotiableTotal: number;
  /** Number of routine items completed today. */
  routineCompleted: number;
  /** Total routine items scheduled today. */
  routineTotal: number;
  categoryMinutes: Partial<Record<DisciplineCategory, number>>;
}

export interface DisciplineState {
  blocks: DisciplineBlock[];
  logs: DisciplineLog[];
  settings: DisciplineSettings;
}
