import { mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { disciplineDataDir, migrateLegacyData } from "./data-dir.js";
import {
  DisciplineBlock,
  DisciplineCategory,
  DisciplineLog,
  DisciplineSettings,
  DEFAULT_DISCIPLINE_SETTINGS,
  DEFAULT_TELEGRAM_EVENT_TOGGLES,
  LogSource,
  DayScore,
  DISCIPLINE_CATEGORIES,
  RoutineCompletion,
  RoutineItem,
  BlockCompletion,
  BlockOverride,
  DisciplineTemplate,
  DisciplineTemplateBlock,
  DisciplineEvent,
  DisciplineEventCounts,
} from "./types.js";

type StoreLog = { info: (m: string) => void; warn: (m: string) => void };
let log: StoreLog = { info: () => {}, warn: () => {} };

/** Route store logs to the plugin logger (set once by the plugin entry). */
export function setDisciplineStoreLogger(next: StoreLog): void {
  log = next;
}

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseRoutineItems(raw: unknown): RoutineItem[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x: any) => x && typeof x.id === "string" && typeof x.label === "string")
      .map((x: any, i: number) => ({
        id: x.id,
        label: x.label,
        order: Number.isFinite(x.order) ? x.order : i,
      }))
      .sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

function rowToBlock(row: any): DisciplineBlock {
  return {
    id: row.id,
    label: row.label,
    category: row.category as DisciplineCategory,
    intent: row.intent ?? undefined,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    days: row.days ? JSON.parse(row.days) : [],
    oneOffDate: row.oneOffDate ?? undefined,
    hard: !!row.hard,
    enabled: !!row.enabled,
    color: row.color ?? undefined,
    projectId: row.projectId ?? undefined,
    taskId: row.taskId ?? undefined,
    nonNegotiable: !!row.nonNegotiable,
    routineItems: parseRoutineItems(row.routineItems),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToLog(row: any): DisciplineLog {
  return {
    id: row.id,
    blockId: row.blockId ?? undefined,
    label: row.label,
    category: row.category as DisciplineCategory,
    source: row.source as LogSource,
    startMs: row.startMs,
    endMs: row.endMs ?? undefined,
    reason: row.reason ?? undefined,
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

export class DisciplineStore {
  private db: Database.Database;

  /** `dataDir` is the plugin's data dir (`<stateDir>/plugin-data/discipline`). */
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "discipline.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.createTables();
    log.info(`discipline store loaded: ${dbPath}`);
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discipline_blocks (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        category TEXT NOT NULL,
        intent TEXT,
        startMinute INTEGER NOT NULL,
        endMinute INTEGER NOT NULL,
        days TEXT,
        oneOffDate TEXT,
        hard INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        color TEXT,
        projectId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discipline_blocks_enabled ON discipline_blocks(enabled);

      CREATE TABLE IF NOT EXISTS discipline_routine_completions (
        blockId TEXT NOT NULL,
        itemId TEXT NOT NULL,
        dateIso TEXT NOT NULL,
        completedAt INTEGER NOT NULL,
        PRIMARY KEY (blockId, itemId, dateIso)
      );
      CREATE INDEX IF NOT EXISTS idx_routine_comp_date ON discipline_routine_completions(dateIso);
      CREATE INDEX IF NOT EXISTS idx_routine_comp_block ON discipline_routine_completions(blockId);

      CREATE TABLE IF NOT EXISTS discipline_logs (
        id TEXT PRIMARY KEY,
        blockId TEXT,
        label TEXT NOT NULL,
        category TEXT NOT NULL,
        source TEXT NOT NULL,
        startMs INTEGER NOT NULL,
        endMs INTEGER,
        reason TEXT,
        note TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discipline_logs_start ON discipline_logs(startMs);
      CREATE INDEX IF NOT EXISTS idx_discipline_logs_block ON discipline_logs(blockId);

      CREATE TABLE IF NOT EXISTS discipline_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        militant INTEGER NOT NULL DEFAULT 0,
        probeIntervalMin INTEGER NOT NULL DEFAULT 30,
        dayStartHour INTEGER NOT NULL DEFAULT 6,
        dayEndHour INTEGER NOT NULL DEFAULT 23,
        updatedAt INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS discipline_block_completions (
        blockId TEXT NOT NULL,
        dateIso TEXT NOT NULL,
        completedMinute INTEGER NOT NULL,
        savedMinute INTEGER NOT NULL DEFAULT 0,
        completedAt INTEGER NOT NULL,
        PRIMARY KEY (blockId, dateIso)
      );
      CREATE INDEX IF NOT EXISTS idx_block_comp_date ON discipline_block_completions(dateIso);

      CREATE TABLE IF NOT EXISTS discipline_block_overrides (
        blockId TEXT NOT NULL,
        dateIso TEXT NOT NULL,
        startMinute INTEGER NOT NULL,
        PRIMARY KEY (blockId, dateIso)
      );
      CREATE INDEX IF NOT EXISTS idx_block_ovr_date ON discipline_block_overrides(dateIso);

      -- Saved discipline templates: a named snapshot of a block layout
      -- the operator (or agent) can apply later to overwrite the
      -- current schedule. blocks_json holds TemplateBlock[] — see
      -- ui/src/ui/controllers/discipline.ts for the shape. source
      -- distinguishes user-saved from preset-bundled from imported.
      CREATE TABLE IF NOT EXISTS discipline_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        blocks_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_templates_name ON discipline_templates(name);

      -- Auto-log events: one row per agent/voice/chat event, attributed to the
      -- discipline block active at event time (null = free-form / no active block).
      CREATE TABLE IF NOT EXISTS discipline_events (
        id TEXT PRIMARY KEY,
        blockId TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        attributedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_disc_events_block ON discipline_events(blockId);
      CREATE INDEX IF NOT EXISTS idx_disc_events_created ON discipline_events(createdAt);

      -- Day-start marker: one row per local date, written the first time the
      -- user does real work that day (task complete / agent message / page
      -- nav). Records when the discipline day auto-started so the UI flips
      -- from "not started" to "active" without a manual button press.
      CREATE TABLE IF NOT EXISTS discipline_day_start (
        dateIso TEXT PRIMARY KEY,
        startMinute INTEGER NOT NULL,
        startedAt INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'auto'
      );
    `);
    const row = this.db.prepare("SELECT id FROM discipline_settings WHERE id = 1").get();
    if (!row) {
      this.db
        .prepare(
          "INSERT INTO discipline_settings (id, militant, probeIntervalMin, dayStartHour, dayEndHour, updatedAt) VALUES (1, 0, 30, 6, 23, ?)",
        )
        .run(Date.now());
    }

    // Idempotent upgrade for installs that predate taskId/nonNegotiable/routineItems.
    const cols = this.db.prepare("PRAGMA table_info(discipline_blocks)").all() as any[];
    const has = (n: string) => cols.some((c) => c.name === n);
    if (!has("taskId")) this.db.exec("ALTER TABLE discipline_blocks ADD COLUMN taskId TEXT");
    if (!has("nonNegotiable"))
      this.db.exec(
        "ALTER TABLE discipline_blocks ADD COLUMN nonNegotiable INTEGER NOT NULL DEFAULT 0",
      );
    if (!has("routineItems"))
      this.db.exec("ALTER TABLE discipline_blocks ADD COLUMN routineItems TEXT");

    // Idempotent upgrade for extended settings (telegram, quiet hours, etc.).
    const sCols = this.db.prepare("PRAGMA table_info(discipline_settings)").all() as any[];
    const hasS = (n: string) => sCols.some((c: any) => c.name === n);
    if (!hasS("quietHoursStart"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN quietHoursStart INTEGER NOT NULL DEFAULT 22",
      );
    if (!hasS("quietHoursEnd"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN quietHoursEnd INTEGER NOT NULL DEFAULT 6",
      );
    if (!hasS("telegramEnabled"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN telegramEnabled INTEGER NOT NULL DEFAULT 0",
      );
    if (!hasS("telegramChatId"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN telegramChatId TEXT NOT NULL DEFAULT ''",
      );
    if (!hasS("telegramEventsJson"))
      this.db.exec("ALTER TABLE discipline_settings ADD COLUMN telegramEventsJson TEXT");
    if (!hasS("prioritySortEnabled"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN prioritySortEnabled INTEGER NOT NULL DEFAULT 0",
      );
    if (!hasS("priorityHighlight"))
      this.db.exec(
        "ALTER TABLE discipline_settings ADD COLUMN priorityHighlight INTEGER NOT NULL DEFAULT 1",
      );
  }

  // ── Blocks ──────────────────────────────────────────────
  getBlocks(): DisciplineBlock[] {
    const rows = this.db
      .prepare("SELECT * FROM discipline_blocks ORDER BY startMinute ASC")
      .all() as any[];
    return rows.map(rowToBlock);
  }

  createBlock(input: Omit<DisciplineBlock, "id" | "createdAt" | "updatedAt">): DisciplineBlock {
    const now = Date.now();
    const block: DisciplineBlock = { ...input, id: uid("blk"), createdAt: now, updatedAt: now };
    this.db
      .prepare(
        `INSERT INTO discipline_blocks
         (id, label, category, intent, startMinute, endMinute, days, oneOffDate, hard, enabled, color, projectId, taskId, nonNegotiable, routineItems, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        block.id,
        block.label,
        block.category,
        block.intent ?? null,
        block.startMinute,
        block.endMinute,
        JSON.stringify(block.days ?? []),
        block.oneOffDate ?? null,
        block.hard ? 1 : 0,
        block.enabled ? 1 : 0,
        block.color ?? null,
        block.projectId ?? null,
        block.taskId ?? null,
        block.nonNegotiable ? 1 : 0,
        JSON.stringify(block.routineItems ?? []),
        block.createdAt,
        block.updatedAt,
      );
    return block;
  }

  updateBlock(id: string, patch: Partial<DisciplineBlock>): DisciplineBlock | null {
    const existing = this.db.prepare("SELECT * FROM discipline_blocks WHERE id = ?").get(id) as any;
    if (!existing) return null;
    const next = { ...rowToBlock(existing), ...patch, id, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE discipline_blocks SET
           label=?, category=?, intent=?, startMinute=?, endMinute=?,
           days=?, oneOffDate=?, hard=?, enabled=?, color=?, projectId=?, taskId=?,
           nonNegotiable=?, routineItems=?, updatedAt=?
         WHERE id=?`,
      )
      .run(
        next.label,
        next.category,
        next.intent ?? null,
        next.startMinute,
        next.endMinute,
        JSON.stringify(next.days ?? []),
        next.oneOffDate ?? null,
        next.hard ? 1 : 0,
        next.enabled ? 1 : 0,
        next.color ?? null,
        next.projectId ?? null,
        next.taskId ?? null,
        next.nonNegotiable ? 1 : 0,
        JSON.stringify(next.routineItems ?? []),
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteBlock(id: string): boolean {
    const res = this.db.prepare("DELETE FROM discipline_blocks WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM discipline_routine_completions WHERE blockId = ?").run(id);
    return res.changes > 0;
  }

  // ── Routine completions ─────────────────────────────────
  getRoutineCompletions(dateIso: string): RoutineCompletion[] {
    const rows = this.db
      .prepare("SELECT * FROM discipline_routine_completions WHERE dateIso = ?")
      .all(dateIso) as any[];
    return rows.map((r) => ({
      blockId: r.blockId,
      itemId: r.itemId,
      dateIso: r.dateIso,
      completedAt: r.completedAt,
    }));
  }

  /** Flip the completion flag for an item on a date. Returns the new completed state. */
  toggleRoutineCompletion(blockId: string, itemId: string, dateIso: string): boolean {
    const existing = this.db
      .prepare(
        "SELECT 1 AS present FROM discipline_routine_completions WHERE blockId = ? AND itemId = ? AND dateIso = ?",
      )
      .get(blockId, itemId, dateIso) as any;
    if (existing) {
      this.db
        .prepare(
          "DELETE FROM discipline_routine_completions WHERE blockId = ? AND itemId = ? AND dateIso = ?",
        )
        .run(blockId, itemId, dateIso);
      return false;
    }
    this.db
      .prepare(
        "INSERT INTO discipline_routine_completions (blockId, itemId, dateIso, completedAt) VALUES (?, ?, ?, ?)",
      )
      .run(blockId, itemId, dateIso, Date.now());
    return true;
  }

  // ── Block completions ──────────────────────────────────
  getBlockCompletions(dateIso: string): BlockCompletion[] {
    const rows = this.db
      .prepare("SELECT * FROM discipline_block_completions WHERE dateIso = ?")
      .all(dateIso) as any[];
    return rows.map((r) => ({
      blockId: r.blockId,
      dateIso: r.dateIso,
      completedMinute: r.completedMinute,
      savedMinute: r.savedMinute,
      completedAt: r.completedAt,
    }));
  }

  getBlockOverrides(dateIso: string): BlockOverride[] {
    const rows = this.db
      .prepare("SELECT * FROM discipline_block_overrides WHERE dateIso = ?")
      .all(dateIso) as any[];
    return rows.map((r) => ({
      blockId: r.blockId,
      dateIso: r.dateIso,
      startMinute: r.startMinute,
    }));
  }

  /**
   * Marks a block complete for the given date. If completed early, the saved minutes
   * are recorded and the next scheduled block's start is shifted up to `nowMinute`.
   * Returns the completion record plus any new override that was written.
   */
  markBlockComplete(
    blockId: string,
    dateIso: string,
    nowMinute: number,
  ): { completion: BlockCompletion; override: BlockOverride | null } {
    const block = this.db
      .prepare("SELECT * FROM discipline_blocks WHERE id = ?")
      .get(blockId) as any;
    if (!block) throw new Error(`block not found: ${blockId}`);
    const existing = this.db
      .prepare("SELECT * FROM discipline_block_completions WHERE blockId = ? AND dateIso = ?")
      .get(blockId, dateIso) as any;
    if (existing) {
      return {
        completion: {
          blockId,
          dateIso,
          completedMinute: existing.completedMinute,
          savedMinute: existing.savedMinute,
          completedAt: existing.completedAt,
        },
        override: null,
      };
    }
    const b = rowToBlock(block);
    const clampedNow = Math.max(0, Math.min(1440, Math.round(nowMinute)));
    const savedMinute = Math.max(0, b.endMinute - clampedNow);
    const completedAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO discipline_block_completions (blockId, dateIso, completedMinute, savedMinute, completedAt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(blockId, dateIso, clampedNow, savedMinute, completedAt);

    let override: BlockOverride | null = null;
    if (savedMinute > 0) {
      const dow = new Date(`${dateIso}T00:00:00`).getDay();
      const allBlocks = this.getBlocks();
      const completedToday = new Set(this.getBlockCompletions(dateIso).map((c) => c.blockId));
      const next = allBlocks
        .filter((x) => {
          if (!x.enabled) return false;
          if (completedToday.has(x.id)) return false;
          if (x.id === blockId) return false;
          if (x.oneOffDate) return x.oneOffDate === dateIso;
          return (x.days ?? []).includes(dow);
        })
        .filter((x) => x.startMinute >= b.endMinute)
        .sort((a, c) => a.startMinute - c.startMinute)[0];
      if (next) {
        this.db
          .prepare(
            `INSERT INTO discipline_block_overrides (blockId, dateIso, startMinute)
             VALUES (?, ?, ?)
             ON CONFLICT(blockId, dateIso) DO UPDATE SET startMinute = excluded.startMinute`,
          )
          .run(next.id, dateIso, clampedNow);
        override = { blockId: next.id, dateIso, startMinute: clampedNow };
      }
    }

    return {
      completion: { blockId, dateIso, completedMinute: clampedNow, savedMinute, completedAt },
      override,
    };
  }

  /** Removes a block completion. Also clears any override rooted at this block's end. */
  unmarkBlockComplete(
    blockId: string,
    dateIso: string,
  ): { removedOverrideForBlockId: string | null } {
    const existing = this.db
      .prepare("SELECT * FROM discipline_block_completions WHERE blockId = ? AND dateIso = ?")
      .get(blockId, dateIso) as any;
    if (!existing) return { removedOverrideForBlockId: null };

    const block = this.db
      .prepare("SELECT * FROM discipline_blocks WHERE id = ?")
      .get(blockId) as any;

    this.db
      .prepare("DELETE FROM discipline_block_completions WHERE blockId = ? AND dateIso = ?")
      .run(blockId, dateIso);

    let removedFor: string | null = null;
    if (block) {
      const b = rowToBlock(block);
      const dow = new Date(`${dateIso}T00:00:00`).getDay();
      const next = this.getBlocks()
        .filter((x) => {
          if (!x.enabled) return false;
          if (x.oneOffDate) return x.oneOffDate === dateIso;
          return (x.days ?? []).includes(dow);
        })
        .filter((x) => x.startMinute >= b.endMinute)
        .sort((a, c) => a.startMinute - c.startMinute)[0];
      if (next) {
        const res = this.db
          .prepare("DELETE FROM discipline_block_overrides WHERE blockId = ? AND dateIso = ?")
          .run(next.id, dateIso);
        if (res.changes > 0) removedFor = next.id;
      }
    }
    return { removedOverrideForBlockId: removedFor };
  }

  resetBlockOverrides(dateIso: string): number {
    const res = this.db
      .prepare("DELETE FROM discipline_block_overrides WHERE dateIso = ?")
      .run(dateIso);
    return res.changes;
  }

  // ── Logs ────────────────────────────────────────────────
  getLogs(opts?: { sinceMs?: number; untilMs?: number; limit?: number }): DisciplineLog[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (opts?.sinceMs != null) {
      clauses.push("startMs >= ?");
      args.push(opts.sinceMs);
    }
    if (opts?.untilMs != null) {
      clauses.push("startMs <= ?");
      args.push(opts.untilMs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(1, opts?.limit ?? 1000), 5000);
    const rows = this.db
      .prepare(`SELECT * FROM discipline_logs ${where} ORDER BY startMs DESC LIMIT ?`)
      .all(...args, limit) as any[];
    return rows.map(rowToLog);
  }

  createLog(input: Omit<DisciplineLog, "id" | "createdAt">): DisciplineLog {
    const now = Date.now();
    const entry: DisciplineLog = { ...input, id: uid("log"), createdAt: now };
    this.db
      .prepare(
        `INSERT INTO discipline_logs
         (id, blockId, label, category, source, startMs, endMs, reason, note, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.blockId ?? null,
        entry.label,
        entry.category,
        entry.source,
        entry.startMs,
        entry.endMs ?? null,
        entry.reason ?? null,
        entry.note ?? null,
        entry.createdAt,
      );
    return entry;
  }

  updateLog(id: string, patch: Partial<DisciplineLog>): DisciplineLog | null {
    const existing = this.db.prepare("SELECT * FROM discipline_logs WHERE id = ?").get(id) as any;
    if (!existing) return null;
    const next = { ...rowToLog(existing), ...patch, id };
    this.db
      .prepare(
        `UPDATE discipline_logs SET
           blockId=?, label=?, category=?, source=?, startMs=?, endMs=?, reason=?, note=?
         WHERE id=?`,
      )
      .run(
        next.blockId ?? null,
        next.label,
        next.category,
        next.source,
        next.startMs,
        next.endMs ?? null,
        next.reason ?? null,
        next.note ?? null,
        id,
      );
    return next;
  }

  deleteLog(id: string): boolean {
    const res = this.db.prepare("DELETE FROM discipline_logs WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ── Settings ────────────────────────────────────────────
  getSettings(): DisciplineSettings {
    const row = this.db.prepare("SELECT * FROM discipline_settings WHERE id = 1").get() as any;
    if (!row) return { ...DEFAULT_DISCIPLINE_SETTINGS };
    let telegramEvents = { ...DEFAULT_TELEGRAM_EVENT_TOGGLES };
    if (row.telegramEventsJson) {
      try {
        telegramEvents = { ...telegramEvents, ...JSON.parse(row.telegramEventsJson) };
      } catch {
        /**/
      }
    }
    return {
      militant: !!row.militant,
      probeIntervalMin: row.probeIntervalMin,
      dayStartHour: row.dayStartHour,
      dayEndHour: row.dayEndHour,
      quietHoursStart: row.quietHoursStart ?? DEFAULT_DISCIPLINE_SETTINGS.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd ?? DEFAULT_DISCIPLINE_SETTINGS.quietHoursEnd,
      telegramEnabled: !!row.telegramEnabled,
      telegramChatId: row.telegramChatId ?? "",
      telegramEvents,
      prioritySortEnabled: !!row.prioritySortEnabled,
      priorityHighlight: row.priorityHighlight == null ? true : !!row.priorityHighlight,
      updatedAt: row.updatedAt,
    };
  }

  updateSettings(patch: Partial<DisciplineSettings>): DisciplineSettings {
    const current = this.getSettings();
    const next: DisciplineSettings = {
      ...current,
      ...patch,
      telegramEvents: patch.telegramEvents
        ? { ...current.telegramEvents, ...patch.telegramEvents }
        : current.telegramEvents,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE discipline_settings SET
           militant=?, probeIntervalMin=?, dayStartHour=?, dayEndHour=?,
           quietHoursStart=?, quietHoursEnd=?,
           telegramEnabled=?, telegramChatId=?, telegramEventsJson=?,
           prioritySortEnabled=?, priorityHighlight=?,
           updatedAt=?
         WHERE id=1`,
      )
      .run(
        next.militant ? 1 : 0,
        next.probeIntervalMin,
        next.dayStartHour,
        next.dayEndHour,
        next.quietHoursStart,
        next.quietHoursEnd,
        next.telegramEnabled ? 1 : 0,
        next.telegramChatId,
        JSON.stringify(next.telegramEvents),
        next.prioritySortEnabled ? 1 : 0,
        next.priorityHighlight ? 1 : 0,
        next.updatedAt,
      );
    return next;
  }

  // ── Derived: day score ──────────────────────────────────
  /**
   * Compute compliance score for a given local-date string (YYYY-MM-DD).
   * Compliance = percentage of planned minutes covered by actual logs within tolerance.
   */
  computeDayScore(dateIso: string): DayScore {
    const day = new Date(`${dateIso}T00:00:00`);
    const startMs = day.getTime();
    const endMs = startMs + 24 * 60 * 60 * 1000;
    const dow = day.getDay();

    const blocks = this.getBlocks().filter((b) => {
      if (!b.enabled) return false;
      if (b.oneOffDate) return b.oneOffDate === dateIso;
      return (b.days ?? []).includes(dow);
    });

    const logs = this.getLogs({ sinceMs: startMs, untilMs: endMs, limit: 5000 });

    const plannedMinutes = blocks.reduce(
      (sum, b) => sum + Math.max(0, b.endMinute - b.startMinute),
      0,
    );
    const actualMinutes = logs.reduce((sum, l) => {
      const start = Math.max(l.startMs, startMs);
      const end = Math.min(l.endMs ?? l.startMs, endMs);
      return sum + Math.max(0, Math.round((end - start) / 60000));
    }, 0);

    let hits = 0;
    let slippage = 0;
    let nnTotal = 0;
    let nnMissed = 0;
    const TOLERANCE_MS = 10 * 60 * 1000;
    for (const b of blocks) {
      const bStart = startMs + b.startMinute * 60000;
      const hit = logs.some(
        (l) => l.blockId === b.id && Math.abs(l.startMs - bStart) <= TOLERANCE_MS,
      );
      if (hit) hits += 1;
      else slippage += 1;
      if (b.nonNegotiable) {
        nnTotal += 1;
        if (!hit) nnMissed += 1;
      }
    }
    const compliance = blocks.length ? Math.round((hits / blocks.length) * 100) : 0;

    const categoryMinutes: Partial<Record<DisciplineCategory, number>> = {};
    for (const c of DISCIPLINE_CATEGORIES) categoryMinutes[c] = 0;
    for (const l of logs) {
      const start = Math.max(l.startMs, startMs);
      const end = Math.min(l.endMs ?? l.startMs, endMs);
      const mins = Math.max(0, Math.round((end - start) / 60000));
      categoryMinutes[l.category] = (categoryMinutes[l.category] ?? 0) + mins;
    }

    // Routine stats: count today's scheduled items vs completions.
    const completionsToday = this.getRoutineCompletions(dateIso);
    const completedKeys = new Set(completionsToday.map((c) => `${c.blockId}:${c.itemId}`));
    let routineTotal = 0;
    let routineCompleted = 0;
    for (const b of blocks) {
      for (const item of b.routineItems ?? []) {
        routineTotal += 1;
        if (completedKeys.has(`${b.id}:${item.id}`)) routineCompleted += 1;
      }
    }

    return {
      date: dateIso,
      plannedMinutes,
      actualMinutes,
      compliance,
      slippageCount: slippage,
      nonNegotiableMissed: nnMissed,
      nonNegotiableTotal: nnTotal,
      routineCompleted,
      routineTotal,
      categoryMinutes,
    };
  }

  // ── Templates ───────────────────────────────────────────
  // Saved block-layouts the operator (or agent) can apply later. Each
  // template is a snapshot of the blocks at save time. Apply replaces
  // the current set, swapping new ids for old, preserving routine items
  // structure so the UI re-renders cleanly.

  private rowToTemplate(row: any): DisciplineTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      blocks: safeJSON(row.blocks_json) as DisciplineTemplateBlock[],
      source: (row.source as "user" | "imported") ?? "user",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  listTemplates(): DisciplineTemplate[] {
    return (
      this.db.prepare("SELECT * FROM discipline_templates ORDER BY updatedAt DESC").all() as any[]
    ).map((r) => this.rowToTemplate(r));
  }

  getTemplate(id: string): DisciplineTemplate | null {
    const row = this.db.prepare("SELECT * FROM discipline_templates WHERE id = ?").get(id) as any;
    return row ? this.rowToTemplate(row) : null;
  }

  createTemplate(input: {
    name: string;
    description?: string;
    blocks: DisciplineTemplateBlock[];
    source?: "user" | "imported";
  }): DisciplineTemplate {
    const id = uid("dtpl");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO discipline_templates (id, name, description, blocks_json, source, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        JSON.stringify(input.blocks ?? []),
        input.source ?? "user",
        now,
        now,
      );
    return this.getTemplate(id)!;
  }

  updateTemplate(
    id: string,
    patch: Partial<{ name: string; description: string; blocks: DisciplineTemplateBlock[] }>,
  ): DisciplineTemplate | null {
    const existing = this.getTemplate(id);
    if (!existing) return null;
    const next = {
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description ?? null,
      blocks: patch.blocks ?? existing.blocks,
    };
    this.db
      .prepare(
        "UPDATE discipline_templates SET name = ?, description = ?, blocks_json = ?, updatedAt = ? WHERE id = ?",
      )
      .run(next.name, next.description, JSON.stringify(next.blocks), Date.now(), id);
    return this.getTemplate(id);
  }

  deleteTemplate(id: string): boolean {
    return this.db.prepare("DELETE FROM discipline_templates WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Swap the live block set for the contents of the named template.
   * Strategy: wipe all current blocks (transactional), then insert
   * fresh ones from the template payload. Logs + settings + completions
   * are untouched. Returns the new live block list so the caller can
   * render without an extra round-trip.
   */
  applyTemplate(id: string): { applied: boolean; blocks: DisciplineBlock[] } {
    const tpl = this.getTemplate(id);
    if (!tpl) return { applied: false, blocks: this.getBlocks() };
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM discipline_blocks");
      const insert = this.db.prepare(
        "INSERT INTO discipline_blocks (id, label, category, intent, startMinute, endMinute, days, oneOffDate, hard, enabled, color, projectId, taskId, nonNegotiable, routineItems, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const b of tpl.blocks) {
        const blockId = uid("blk");
        const routineItems = (b.routineItems ?? []).map((ri, i) => ({
          id: `ri_${i}_${Math.random().toString(36).slice(2, 8)}`,
          label: ri.label,
          order: typeof ri.order === "number" ? ri.order : i,
        }));
        insert.run(
          blockId,
          b.label,
          b.category,
          b.intent ?? null,
          b.startMinute,
          b.endMinute,
          JSON.stringify(b.days ?? []),
          null, // oneOffDate
          b.hard ? 1 : 0,
          b.enabled !== false ? 1 : 0,
          b.color ?? null,
          b.projectId ?? null,
          b.taskId ?? null,
          b.nonNegotiable ? 1 : 0,
          JSON.stringify(routineItems),
          now,
          now,
        );
      }
    });
    tx();
    return { applied: true, blocks: this.getBlocks() };
  }

  /** Snapshot the current live blocks into a new template. */
  snapshotAsTemplate(name: string, description?: string): DisciplineTemplate {
    const blocks: DisciplineTemplateBlock[] = this.getBlocks().map((b) => ({
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
      routineItems: b.routineItems.map((ri) => ({ label: ri.label, order: ri.order })),
    }));
    return this.createTemplate({ name, description, blocks, source: "user" });
  }

  // ── Discipline Events (auto-log) ────────────────────────
  createDisciplineEvent(input: {
    blockId: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }): DisciplineEvent {
    const now = Date.now();
    const entry: DisciplineEvent = {
      id: uid("devt"),
      blockId: input.blockId,
      kind: input.kind,
      payload: JSON.stringify(input.payload),
      createdAt: now,
      attributedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO discipline_events (id, blockId, kind, payload, createdAt, attributedAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.id,
        entry.blockId ?? null,
        entry.kind,
        entry.payload,
        entry.createdAt,
        entry.attributedAt,
      );
    return entry;
  }

  getDisciplineEvents(opts?: {
    sinceMs?: number;
    untilMs?: number;
    blockId?: string | null;
    limit?: number;
  }): DisciplineEvent[] {
    const clauses: string[] = [];
    const args: any[] = [];
    if (opts?.sinceMs != null) {
      clauses.push("createdAt >= ?");
      args.push(opts.sinceMs);
    }
    if (opts?.untilMs != null) {
      clauses.push("createdAt <= ?");
      args.push(opts.untilMs);
    }
    if (opts?.blockId !== undefined) {
      if (opts.blockId === null) {
        clauses.push("blockId IS NULL");
      } else {
        clauses.push("blockId = ?");
        args.push(opts.blockId);
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(1, opts?.limit ?? 500), 5000);
    const rows = this.db
      .prepare(`SELECT * FROM discipline_events ${where} ORDER BY createdAt DESC LIMIT ?`)
      .all(...args, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      blockId: r.blockId ?? null,
      kind: r.kind,
      payload: r.payload,
      createdAt: r.createdAt,
      attributedAt: r.attributedAt,
    }));
  }

  getDisciplineEventCounts(sinceMs: number, untilMs: number): DisciplineEventCounts[] {
    const rows = this.db
      .prepare(
        `SELECT blockId, kind, COUNT(*) as cnt
         FROM discipline_events
         WHERE createdAt >= ? AND createdAt <= ?
         GROUP BY blockId, kind`,
      )
      .all(sinceMs, untilMs) as any[];
    // Group into per-block summaries
    const map = new Map<string | null, DisciplineEventCounts>();
    for (const r of rows) {
      const key = r.blockId ?? null;
      const strKey = String(key);
      if (!map.has(strKey)) {
        map.set(strKey, { blockId: key, total: 0, byKind: {} });
      }
      const entry = map.get(strKey)!;
      entry.total += r.cnt;
      entry.byKind[r.kind] = (entry.byKind[r.kind] ?? 0) + r.cnt;
    }
    return Array.from(map.values());
  }

  // ── Day-start (auto-start) ──────────────────────────────────────────────

  /**
   * Idempotently record that the discipline day started. Returns whether this
   * call was the one that started the day (`started: true` on first write for
   * the date) plus the recorded start minute. Safe to call on every event —
   * subsequent calls for the same date are no-ops and return the original
   * start time.
   */
  markDayStarted(
    dateIso: string,
    startMinute: number,
    source: string = "auto",
  ): { started: boolean; startMinute: number; startedAt: number } {
    const existing = this.db
      .prepare("SELECT startMinute, startedAt FROM discipline_day_start WHERE dateIso = ?")
      .get(dateIso) as { startMinute: number; startedAt: number } | undefined;
    if (existing) {
      return { started: false, startMinute: existing.startMinute, startedAt: existing.startedAt };
    }
    const startedAt = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO discipline_day_start (dateIso, startMinute, startedAt, source) VALUES (?, ?, ?, ?)",
      )
      .run(dateIso, startMinute, startedAt, source);
    return { started: true, startMinute, startedAt };
  }

  /** Minute-of-day the discipline day started, or null if not started yet. */
  getDayStart(dateIso: string): { startMinute: number; startedAt: number; source: string } | null {
    const row = this.db
      .prepare("SELECT startMinute, startedAt, source FROM discipline_day_start WHERE dateIso = ?")
      .get(dateIso) as { startMinute: number; startedAt: number; source: string } | undefined;
    return row ?? null;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  purgeDisciplineEventsOlderThan(beforeMs: number): number {
    return this.db.prepare("DELETE FROM discipline_events WHERE createdAt < ?").run(beforeMs)
      .changes;
  }
}

function safeJSON(s: unknown): unknown {
  if (typeof s !== "string" || !s.trim()) return [];
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

/** One store per state dir (state dirs are tenant-namespaced in SaaS mode). */
const stores = new Map<string, DisciplineStore>();

/**
 * The store for a state dir. The first open per dir moves pre-plugin data
 * (`<stateDir>/discipline.db`, …) into the plugin data dir — see data-dir.ts.
 */
export function getDisciplineStore(stateDir: string): DisciplineStore {
  let store = stores.get(stateDir);
  if (!store) {
    migrateLegacyData(stateDir, log);
    store = new DisciplineStore(disciplineDataDir(stateDir));
    stores.set(stateDir, store);
  }
  return store;
}

/** Close every open store (plugin service stop). Data stays on disk. */
export function closeDisciplineStores(): void {
  for (const store of stores.values()) store.close();
  stores.clear();
}
