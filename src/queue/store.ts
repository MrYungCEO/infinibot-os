/**
 * Persistent queue store — SQLite at `<stateDir>/queue.db` (shared with the
 * goal-run tables, see src/autonomy/goals/store.ts).
 *
 * Every state transition is a CONDITIONAL update (`WHERE status=… AND
 * current_phase_idx=…`) so a double poll, two ticks or two gateways can never
 * claim, settle or advance the same thing twice. Multi-row transitions run in
 * a transaction. A lease row in `queue_meta` makes sure only one orchestrator
 * dispatches from a state dir at a time.
 *
 * Schema is versioned in `queue_meta.schema_version` (see {@link migrate}).
 *
 * Process-wide singleton via {@link getQueueStore}.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  EnqueueInput,
  QueueAttempt,
  QueueAttemptOutcome,
  QueueBlockedKind,
  QueueCliBackend,
  QueueEntry,
  QueueEventRow,
  QueueGateResult,
  QueueIsolation,
  QueuePhase,
  QueueStatus,
} from "./types.js";

const log = createSubsystemLogger("queue-store");

export const QUEUE_SCHEMA_VERSION = 2;
/** Events kept per entry (older ones are trimmed). */
const MAX_EVENTS_PER_ENTRY = 400;

interface QueueRow {
  id: string;
  title: string;
  brief_md: string;
  phase_spec: string;
  status: string;
  priority: number;
  depends_on: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  orchestrator_id: string | null;
  current_phase_idx: number;
  attempts: number;
  last_error: string | null;
  current_run_id: string | null;
  phase_attempts: number;
  last_gate: string | null;
  blocked_kind: string | null;
  fix_hint: string | null;
  next_attempt_at: number | null;
  waiting_reason: string | null;
  transient_failures: number;
  timeout_sec: number | null;
  workdir: string | null;
  isolation: string;
  worktrees: string;
  pause_requested: number;
  trusted: number;
  created_by: string | null;
  idempotency_key: string | null;
  pending_instruction: string | null;
  fresh_session: number;
}

interface AttemptRow {
  id: number;
  entry_id: string;
  phase_idx: number;
  n: number;
  run_id: string;
  agent: string;
  backend: string | null;
  model_requested: string | null;
  model: string | null;
  session_id: string | null;
  resumed_session: string | null;
  fallback_from: string | null;
  workdir: string | null;
  base_commit: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string;
  counted: number;
  exit_code: number | null;
  verdict: string | null;
  verdict_reasons: string | null;
  gate: string | null;
  error: string | null;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function parseJsonArray<T>(s: string, fallback: T[]): T[] {
  const v = parseJson<unknown>(s, fallback);
  return Array.isArray(v) ? (v as T[]) : fallback;
}

function rowToEntry(r: QueueRow): QueueEntry {
  return {
    id: r.id,
    title: r.title,
    briefMd: r.brief_md,
    phaseSpec: parseJsonArray<QueuePhase>(r.phase_spec, []),
    status: r.status as QueueStatus,
    priority: r.priority,
    dependsOn: parseJsonArray<string>(r.depends_on, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    orchestratorId: r.orchestrator_id,
    currentPhaseIdx: r.current_phase_idx,
    attempts: r.attempts,
    lastError: r.last_error,
    currentRunId: r.current_run_id,
    phaseAttempts: r.phase_attempts ?? 0,
    lastGate: parseJson<QueueGateResult | null>(r.last_gate, null),
    blockedKind: (r.blocked_kind as QueueBlockedKind | null) ?? null,
    fixHint: r.fix_hint,
    nextAttemptAt: r.next_attempt_at,
    waitingReason: r.waiting_reason,
    transientFailures: r.transient_failures ?? 0,
    timeoutSec: r.timeout_sec,
    workdir: r.workdir,
    isolation: (r.isolation as QueueIsolation) || "none",
    worktrees: parseJson(r.worktrees, {}),
    pauseRequested: r.pause_requested === 1,
    trusted: r.trusted !== 0,
    createdBy: r.created_by,
    idempotencyKey: r.idempotency_key,
    pendingInstruction: r.pending_instruction,
    freshSession: r.fresh_session === 1,
  };
}

function rowToAttempt(r: AttemptRow): QueueAttempt {
  return {
    id: r.id,
    entryId: r.entry_id,
    phaseIdx: r.phase_idx,
    n: r.n,
    runId: r.run_id,
    agent: r.agent,
    backend: (r.backend as QueueCliBackend | null) ?? null,
    modelRequested: r.model_requested,
    model: r.model,
    sessionId: r.session_id,
    resumedSession: r.resumed_session,
    fallbackFrom: r.fallback_from,
    workdir: r.workdir,
    baseCommit: r.base_commit ?? null,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome as QueueAttemptOutcome,
    counted: r.counted === 1,
    exitCode: r.exit_code,
    verdict: r.verdict,
    verdictReasons: parseJsonArray<string>(r.verdict_reasons ?? "[]", []),
    gate: parseJson<QueueGateResult | null>(r.gate, null),
    error: r.error,
  };
}

const ENTRY_COLUMNS_DDL = `
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  brief_md TEXT NOT NULL,
  phase_spec TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','paused','blocked','done','failed','canceled','dead')),
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  finished_at INTEGER,
  orchestrator_id TEXT,
  current_phase_idx INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  current_run_id TEXT,
  phase_attempts INTEGER NOT NULL DEFAULT 0,
  last_gate TEXT,
  blocked_kind TEXT,
  fix_hint TEXT,
  next_attempt_at INTEGER,
  waiting_reason TEXT,
  transient_failures INTEGER NOT NULL DEFAULT 0,
  timeout_sec INTEGER,
  workdir TEXT,
  isolation TEXT NOT NULL DEFAULT 'none',
  worktrees TEXT NOT NULL DEFAULT '{}',
  pause_requested INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  idempotency_key TEXT,
  pending_instruction TEXT,
  fresh_session INTEGER NOT NULL DEFAULT 0
`;

/** Columns that exist in every pre-v2 table (v1 + gate-enforcement additions). */
const LEGACY_COPY_COLUMNS = [
  "id",
  "brief_md",
  "phase_spec",
  "status",
  "priority",
  "depends_on",
  "created_at",
  "started_at",
  "finished_at",
  "orchestrator_id",
  "current_phase_idx",
  "attempts",
  "last_error",
  "current_run_id",
];

export class QueueStore {
  readonly db: Database.Database;
  readonly path: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "queue.db");
    this.db = new Database(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();

    const count = (
      this.db.prepare("SELECT COUNT(*) AS c FROM queue_entries").get() as { c: number }
    ).c;
    log.info("queue store loaded", { entries: count, schema: this.schemaVersion() });
  }

  // ── schema ────────────────────────────────────────────────────────────────

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM queue_meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  /**
   * Versioned migrations.
   *   v0 → no queue tables (fresh DB)
   *   v1 → legacy table (status CHECK without paused/dead, optional
   *        phase_attempts/last_gate columns added by the goals branch)
   *   v2 → rebuilt queue_entries (new states + columns), queue_attempts,
   *        queue_events, queue_meta.
   * Legacy `running` rows are kept `running`; boot recovery reconciles them.
   */
  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS queue_meta (key TEXT PRIMARY KEY, value TEXT)");
    const version = this.schemaVersion();
    if (version >= QUEUE_SCHEMA_VERSION) {
      this.ensureAuxTables();
      return;
    }
    const hasLegacy = Boolean(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='queue_entries'")
        .get(),
    );
    const tx = this.db.transaction(() => {
      if (hasLegacy) {
        const cols = new Set(
          (
            this.db.prepare("PRAGMA table_info(queue_entries)").all() as Array<{ name: string }>
          ).map((c) => c.name),
        );
        this.db.exec(`CREATE TABLE queue_entries_v2 (${ENTRY_COLUMNS_DDL})`);
        const copy = LEGACY_COPY_COLUMNS.filter((c) => cols.has(c));
        const extra: string[] = [];
        const extraSel: string[] = [];
        if (cols.has("phase_attempts")) {
          extra.push("phase_attempts");
          extraSel.push("COALESCE(phase_attempts, 0)");
        }
        if (cols.has("last_gate")) {
          extra.push("last_gate");
          extraSel.push("last_gate");
        }
        this.db.exec(
          `INSERT INTO queue_entries_v2 (${[...copy, ...extra, "updated_at"].join(",")})
           SELECT ${[...copy, ...extraSel, "COALESCE(finished_at, started_at, created_at)"].join(",")}
           FROM queue_entries`,
        );
        this.db.exec("DROP TABLE queue_entries");
        this.db.exec("ALTER TABLE queue_entries_v2 RENAME TO queue_entries");
      } else {
        this.db.exec(`CREATE TABLE queue_entries (${ENTRY_COLUMNS_DDL})`);
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_entries(status);
        CREATE INDEX IF NOT EXISTS idx_queue_priority ON queue_entries(priority DESC, created_at ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_idem ON queue_entries(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `);
      this.ensureAuxTables();
      this.db
        .prepare(
          "INSERT INTO queue_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(QUEUE_SCHEMA_VERSION));
    });
    tx();
    log.info("queue schema migrated", {
      from: hasLegacy ? version || 1 : 0,
      to: QUEUE_SCHEMA_VERSION,
    });
  }

  private ensureAuxTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        phase_idx INTEGER NOT NULL,
        n INTEGER NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        agent TEXT NOT NULL,
        backend TEXT,
        model_requested TEXT,
        model TEXT,
        session_id TEXT,
        resumed_session TEXT,
        fallback_from TEXT,
        workdir TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        outcome TEXT NOT NULL,
        counted INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        verdict TEXT,
        verdict_reasons TEXT,
        gate TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_attempts_entry ON queue_attempts(entry_id, phase_idx, n);
      CREATE TABLE IF NOT EXISTS queue_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        phase_idx INTEGER,
        message TEXT NOT NULL DEFAULT '',
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_queue_events_entry ON queue_events(entry_id, seq);
    `);
    // Additive (v2.1): per-phase evidence baseline on attempts.
    const attemptCols = new Set(
      (this.db.prepare("PRAGMA table_info(queue_attempts)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!attemptCols.has("base_commit")) {
      this.db.exec("ALTER TABLE queue_attempts ADD COLUMN base_commit TEXT");
    }
  }

  // ── lease (one dispatching orchestrator per state dir) ────────────────────

  /**
   * Acquire / renew the dispatch lease. Returns true when `owner` holds it.
   * A lease is stealable once expired, or immediately when its holder pid on
   * this host is dead.
   */
  acquireLease(owner: string, ttlMs: number, pid = process.pid, now = Date.now()): boolean {
    const tx = this.db.transaction((): boolean => {
      const get = (k: string) =>
        (
          this.db.prepare("SELECT value FROM queue_meta WHERE key=?").get(k) as
            | { value: string }
            | undefined
        )?.value;
      const holder = get("lease_owner");
      const expires = Number(get("lease_expires") ?? 0);
      const holderPid = Number(get("lease_pid") ?? 0);
      const holderDead = holderPid > 0 && holderPid !== pid && !isPidAlive(holderPid);
      if (holder && holder !== owner && expires > now && !holderDead) return false;
      const put = this.db.prepare(
        "INSERT INTO queue_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      );
      put.run("lease_owner", owner);
      put.run("lease_expires", String(now + ttlMs));
      put.run("lease_pid", String(pid));
      return true;
    });
    return tx.immediate();
  }

  releaseLease(owner: string): void {
    const holder = (
      this.db.prepare("SELECT value FROM queue_meta WHERE key='lease_owner'").get() as
        | { value: string }
        | undefined
    )?.value;
    if (holder === owner) {
      this.db
        .prepare("DELETE FROM queue_meta WHERE key IN ('lease_owner','lease_expires','lease_pid')")
        .run();
    }
  }

  getMeta(key: string): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM queue_meta WHERE key=?").get(key) as
          | { value: string }
          | undefined
      )?.value ?? null
    );
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM queue_meta WHERE key=?").run(key);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO queue_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }

  /** Global dispatch pause (queue.setPaused). */
  isDispatchPaused(): boolean {
    return this.getMeta("dispatch_paused") === "1";
  }

  setDispatchPaused(paused: boolean): void {
    this.setMeta("dispatch_paused", paused ? "1" : null);
  }

  // ── entries ───────────────────────────────────────────────────────────────

  /**
   * Validate + insert. Throws on: no phases, unknown dependency ids, a
   * dependency cycle. An existing idempotency key returns the original entry
   * (`deduped: true`).
   */
  enqueue(input: EnqueueInput): QueueEntry & { deduped?: boolean } {
    const phases = Array.isArray(input.phaseSpec) ? input.phaseSpec : [];
    if (phases.length === 0) throw new Error("phaseSpec must contain at least one phase");
    if (input.idempotencyKey) {
      const row = this.db
        .prepare("SELECT * FROM queue_entries WHERE idempotency_key=?")
        .get(input.idempotencyKey) as QueueRow | undefined;
      if (row) return { ...rowToEntry(row), deduped: true };
    }
    const deps = [...new Set(Array.isArray(input.dependsOn) ? input.dependsOn : [])];
    for (const d of deps) {
      if (!this.get(d)) throw new Error(`dependsOn: unknown queue entry ${d}`);
    }
    const id = randomUUID();
    if (deps.length && this.wouldCycle(id, deps)) {
      throw new Error("dependsOn would create a dependency cycle");
    }
    const now = Date.now();
    const title =
      input.title?.trim() ||
      input.briefMd
        ?.trim()
        .split("\n")[0]
        ?.replace(/^#+\s*/, "")
        .slice(0, 120) ||
      phases[0].name;
    this.db
      .prepare(
        `INSERT INTO queue_entries (
          id, title, brief_md, phase_spec, status, priority, depends_on,
          created_at, updated_at, workdir, isolation, timeout_sec, trusted, created_by,
          idempotency_key
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        title,
        input.briefMd ?? "",
        JSON.stringify(phases),
        input.paused ? "paused" : "queued",
        typeof input.priority === "number" ? Math.trunc(input.priority) : 0,
        JSON.stringify(deps),
        now,
        now,
        input.workdir ?? null,
        input.isolation ?? "none",
        input.timeoutSec ?? null,
        input.trusted === false ? 0 : 1,
        input.createdBy ?? null,
        input.idempotencyKey ?? null,
      );
    return this.get(id)!;
  }

  /** True when adding `newId → deps` closes a cycle (DFS over depends_on). */
  private wouldCycle(newId: string, deps: string[]): boolean {
    const seen = new Set<string>();
    const stack = [...deps];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === newId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const e = this.get(cur);
      if (e) stack.push(...e.dependsOn);
    }
    return false;
  }

  get(id: string): QueueEntry | null {
    const row = this.db.prepare("SELECT * FROM queue_entries WHERE id = ?").get(id) as
      | QueueRow
      | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Resolve a full id from a unique prefix (CLI convenience). */
  resolveId(idOrPrefix: string): string | null {
    if (this.get(idOrPrefix)) return idOrPrefix;
    if (idOrPrefix.length < 4) return null;
    const rows = this.db
      .prepare("SELECT id FROM queue_entries WHERE id LIKE ? LIMIT 2")
      .all(`${idOrPrefix}%`) as Array<{ id: string }>;
    return rows.length === 1 ? rows[0].id : null;
  }

  list(filter?: { status?: QueueStatus | QueueStatus[]; limit?: number }): QueueEntry[] {
    const statuses = filter?.status
      ? Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
      : null;
    const limit = Math.max(1, Math.min(filter?.limit ?? 500, 5000));
    const rows = statuses?.length
      ? (this.db
          .prepare(
            `SELECT * FROM queue_entries WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY priority DESC, created_at ASC LIMIT ?`,
          )
          .all(...statuses, limit) as QueueRow[])
      : (this.db
          .prepare("SELECT * FROM queue_entries ORDER BY priority DESC, created_at ASC LIMIT ?")
          .all(limit) as QueueRow[]);
    return rows.map(rowToEntry);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM queue_entries GROUP BY status")
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  /** Legacy helper: first queued entry whose deps are all done (no backoff/claim). */
  claimNext(): QueueEntry | null {
    return this.eligible()[0] ?? null;
  }

  /**
   * Queued entries whose dependencies are all `done` and whose backoff has
   * elapsed, in dispatch order. Read-only — dispatch uses {@link claim}.
   */
  eligible(now = Date.now()): QueueEntry[] {
    const queued = this.list({ status: "queued", limit: 5000 });
    if (!queued.length) return [];
    const doneIds = new Set(
      (
        this.db.prepare("SELECT id FROM queue_entries WHERE status='done'").all() as Array<{
          id: string;
        }>
      ).map((r) => r.id),
    );
    return queued.filter(
      (e) => e.dependsOn.every((d) => doneIds.has(d)) && (e.nextAttemptAt ?? 0) <= now,
    );
  }

  private touch(sql: string, ...args: unknown[]): number {
    return this.db.prepare(sql).run(...args).changes;
  }

  /**
   * Atomically claim a queued entry for one attempt of its current phase. The
   * attempt row (with the run id) is written BEFORE anything is spawned, so a
   * crash between claim and spawn is recoverable without a double spawn.
   * Returns null when someone else changed the entry first.
   */
  claim(params: {
    id: string;
    phaseIdx: number;
    orchestratorId: string;
    runId: string;
    agent: string;
    backend: QueueCliBackend | null;
    modelRequested: string | null;
    model: string | null;
    resumedSession: string | null;
    fallbackFrom: string | null;
    workdir: string | null;
    baseCommit?: string | null;
  }): QueueAttempt | null {
    const now = Date.now();
    const tx = this.db.transaction((): QueueAttempt | null => {
      const changed = this.touch(
        `UPDATE queue_entries SET status='running', orchestrator_id=?, current_run_id=?,
           started_at=COALESCE(started_at, ?), attempts=attempts+1, waiting_reason=NULL,
           blocked_kind=NULL, fix_hint=NULL, updated_at=?
         WHERE id=? AND status='queued' AND current_phase_idx=?`,
        params.orchestratorId,
        params.runId,
        now,
        now,
        params.id,
        params.phaseIdx,
      );
      if (changed !== 1) return null;
      const n =
        ((
          this.db
            .prepare("SELECT MAX(n) AS n FROM queue_attempts WHERE entry_id=? AND phase_idx=?")
            .get(params.id, params.phaseIdx) as { n: number | null }
        ).n ?? 0) + 1;
      const info = this.db
        .prepare(
          `INSERT INTO queue_attempts (entry_id, phase_idx, n, run_id, agent, backend,
             model_requested, model, resumed_session, session_id, fallback_from, workdir,
             base_commit, started_at, outcome, counted)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'starting', 0)`,
        )
        .run(
          params.id,
          params.phaseIdx,
          n,
          params.runId,
          params.agent,
          params.backend,
          params.modelRequested,
          params.model,
          params.resumedSession,
          params.resumedSession,
          params.fallbackFrom,
          params.workdir,
          params.baseCommit ?? null,
          now,
        );
      return this.getAttempt(Number(info.lastInsertRowid));
    });
    return tx.immediate();
  }

  /** Mark a claimed attempt as actually running (spawn returned). */
  attemptStarted(
    attemptId: number,
    patch: { sessionId?: string | null; workdir?: string | null },
  ): void {
    this.touch(
      `UPDATE queue_attempts SET outcome='running', session_id=COALESCE(?, session_id),
         workdir=COALESCE(?, workdir) WHERE id=? AND outcome='starting'`,
      patch.sessionId ?? null,
      patch.workdir ?? null,
      attemptId,
    );
  }

  setAttemptSession(attemptId: number, sessionId: string): void {
    this.touch("UPDATE queue_attempts SET session_id=? WHERE id=?", sessionId, attemptId);
  }

  /**
   * Settle an attempt exactly once. Returns false when it was already settled
   * (another tick / the cancel path got there first).
   */
  settleAttempt(
    attemptId: number,
    patch: {
      outcome: Exclude<QueueAttemptOutcome, "starting" | "running">;
      counted: boolean;
      exitCode?: number | null;
      verdict?: string | null;
      verdictReasons?: string[];
      gate?: QueueGateResult | null;
      error?: string | null;
      sessionId?: string | null;
    },
  ): boolean {
    return (
      this.touch(
        `UPDATE queue_attempts SET outcome=?, counted=?, ended_at=?, exit_code=?, verdict=?,
           verdict_reasons=?, gate=?, error=?, session_id=COALESCE(?, session_id)
         WHERE id=? AND outcome IN ('starting','running')`,
        patch.outcome,
        patch.counted ? 1 : 0,
        Date.now(),
        patch.exitCode ?? null,
        patch.verdict ?? null,
        JSON.stringify(patch.verdictReasons ?? []),
        patch.gate ? JSON.stringify(patch.gate) : null,
        patch.error ?? null,
        patch.sessionId ?? null,
        attemptId,
      ) === 1
    );
  }

  /** Patch gate/verdict on an attempt that is already settled (re-evaluation). */
  annotateAttempt(
    attemptId: number,
    patch: {
      outcome?: QueueAttemptOutcome;
      verdict?: string | null;
      gate?: QueueGateResult | null;
    },
  ): void {
    if (patch.outcome)
      this.touch("UPDATE queue_attempts SET outcome=? WHERE id=?", patch.outcome, attemptId);
    if (patch.verdict !== undefined)
      this.touch("UPDATE queue_attempts SET verdict=? WHERE id=?", patch.verdict, attemptId);
    if (patch.gate !== undefined)
      this.touch(
        "UPDATE queue_attempts SET gate=? WHERE id=?",
        patch.gate ? JSON.stringify(patch.gate) : null,
        attemptId,
      );
  }

  getAttempt(id: number): QueueAttempt | null {
    const r = this.db.prepare("SELECT * FROM queue_attempts WHERE id=?").get(id) as
      | AttemptRow
      | undefined;
    return r ? rowToAttempt(r) : null;
  }

  getAttemptByRunId(runId: string): QueueAttempt | null {
    const r = this.db.prepare("SELECT * FROM queue_attempts WHERE run_id=?").get(runId) as
      | AttemptRow
      | undefined;
    return r ? rowToAttempt(r) : null;
  }

  listAttempts(entryId: string): QueueAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM queue_attempts WHERE entry_id=? ORDER BY phase_idx ASC, n ASC")
        .all(entryId) as AttemptRow[]
    ).map(rowToAttempt);
  }

  latestAttempt(entryId: string, phaseIdx?: number): QueueAttempt | null {
    const r = (
      phaseIdx === undefined
        ? this.db
            .prepare("SELECT * FROM queue_attempts WHERE entry_id=? ORDER BY id DESC LIMIT 1")
            .get(entryId)
        : this.db
            .prepare(
              "SELECT * FROM queue_attempts WHERE entry_id=? AND phase_idx=? ORDER BY id DESC LIMIT 1",
            )
            .get(entryId, phaseIdx)
    ) as AttemptRow | undefined;
    return r ? rowToAttempt(r) : null;
  }

  /** Attempts still starting/running (restart recovery + reconcile loop). */
  openAttempts(): QueueAttempt[] {
    return (
      this.db
        .prepare("SELECT * FROM queue_attempts WHERE outcome IN ('starting','running') ORDER BY id")
        .all() as AttemptRow[]
    ).map(rowToAttempt);
  }

  /** Persist the latest gate verification for the current phase. */
  setGate(id: string, gate: QueueGateResult): void {
    this.touch(
      "UPDATE queue_entries SET last_gate=?, updated_at=? WHERE id=?",
      JSON.stringify(gate),
      Date.now(),
      id,
    );
  }

  /**
   * Phase passed: advance exactly once (conditional on the phase index + the
   * entry still being `running`). Returns the new entry, or null when the
   * transition already happened / the entry moved on.
   */
  completePhase(id: string, phaseIdx: number, from: QueueStatus = "running"): QueueEntry | null {
    const tx = this.db.transaction((): QueueEntry | null => {
      const e = this.get(id);
      if (!e || e.status !== from || e.currentPhaseIdx !== phaseIdx) return null;
      const now = Date.now();
      const nextIdx = phaseIdx + 1;
      if (nextIdx >= e.phaseSpec.length) {
        this.touch(
          `UPDATE queue_entries SET status='done', finished_at=?, updated_at=?, current_run_id=NULL,
             last_error=NULL, blocked_kind=NULL, fix_hint=NULL, next_attempt_at=NULL,
             transient_failures=0, pending_instruction=NULL, pause_requested=0
           WHERE id=?`,
          now,
          now,
          id,
        );
      } else {
        this.touch(
          `UPDATE queue_entries SET current_phase_idx=?, status=?, current_run_id=NULL,
             phase_attempts=0, last_error=NULL, last_gate=NULL, blocked_kind=NULL, fix_hint=NULL,
             next_attempt_at=NULL, transient_failures=0, pending_instruction=NULL,
             fresh_session=0, pause_requested=0, updated_at=?
           WHERE id=?`,
          nextIdx,
          e.pauseRequested ? "paused" : "queued",
          now,
          id,
        );
      }
      return this.get(id);
    });
    return tx.immediate();
  }

  /**
   * Put the SAME phase back in the queue after a settled attempt (retry). Only
   * from `running` at that phase. `counted` consumes a phase attempt;
   * `transient` bumps the dead-letter counter (reset otherwise).
   */
  requeuePhase(
    id: string,
    phaseIdx: number,
    opts: {
      feedback: string | null;
      nextAttemptAt?: number | null;
      counted: boolean;
      transient?: boolean;
      waitingReason?: string | null;
    },
  ): QueueEntry | null {
    const e = this.get(id);
    const changed = this.touch(
      `UPDATE queue_entries SET status=CASE WHEN pause_requested=1 THEN 'paused' ELSE 'queued' END,
         pause_requested=0, current_run_id=NULL, last_error=?, next_attempt_at=?,
         phase_attempts=phase_attempts+?, transient_failures=?, waiting_reason=?, updated_at=?
       WHERE id=? AND status='running' AND current_phase_idx=?`,
      opts.feedback,
      opts.nextAttemptAt ?? null,
      opts.counted ? 1 : 0,
      opts.transient ? (e?.transientFailures ?? 0) + 1 : 0,
      opts.waitingReason ?? null,
      Date.now(),
      id,
      phaseIdx,
    );
    return changed === 1 ? this.get(id) : null;
  }

  /** Count a settled attempt without changing status (used before block/dead). */
  bumpPhaseAttempts(id: string, by = 1): void {
    this.touch("UPDATE queue_entries SET phase_attempts=phase_attempts+? WHERE id=?", by, id);
  }

  /**
   * Block an entry with a kind + human fix. `from` restricts the source
   * statuses (default: any non-terminal).
   */
  markBlocked(
    id: string,
    reason: string,
    kind: QueueBlockedKind = "operator",
    fixHint: string | null = null,
    from: QueueStatus[] = ["queued", "running", "paused", "blocked"],
  ): boolean {
    return (
      this.touch(
        `UPDATE queue_entries SET status='blocked', last_error=?, blocked_kind=?, fix_hint=?,
           current_run_id=NULL, pause_requested=0, updated_at=?
         WHERE id=? AND status IN (${from.map(() => "?").join(",")})`,
        reason,
        kind,
        fixHint,
        Date.now(),
        id,
        ...from,
      ) === 1
    );
  }

  /** Dead-letter a poisoned entry. */
  markDead(id: string, reason: string, fixHint: string | null): boolean {
    const now = Date.now();
    return (
      this.touch(
        `UPDATE queue_entries SET status='dead', last_error=?, blocked_kind='spawn_failed', fix_hint=?,
           current_run_id=NULL, finished_at=?, updated_at=?
         WHERE id=? AND status IN ('queued','running','paused','blocked')`,
        reason,
        fixHint,
        now,
        now,
        id,
      ) === 1
    );
  }

  markCanceled(id: string, reason = "operator cancel"): boolean {
    const now = Date.now();
    return (
      this.touch(
        `UPDATE queue_entries SET status='canceled', finished_at=?, updated_at=?, current_run_id=NULL,
           last_error=COALESCE(?, last_error), pause_requested=0
         WHERE id=? AND status NOT IN ('done','canceled')`,
        now,
        now,
        reason,
        id,
      ) === 1
    );
  }

  markFailed(id: string, reason: string, kind: QueueBlockedKind | null = null): boolean {
    const now = Date.now();
    return (
      this.touch(
        `UPDATE queue_entries SET status='failed', last_error=?, blocked_kind=?, finished_at=?,
           updated_at=?, current_run_id=NULL
         WHERE id=? AND status NOT IN ('done','canceled','failed')`,
        reason,
        kind,
        now,
        now,
        id,
      ) === 1
    );
  }

  /** Legacy helper kept for callers/tests: mark done unconditionally. */
  markDone(id: string): void {
    const now = Date.now();
    this.touch(
      "UPDATE queue_entries SET status='done', finished_at=?, updated_at=?, current_run_id=NULL WHERE id=?",
      now,
      now,
      id,
    );
  }

  /** Graceful pause of a running entry: park after the current attempt settles. */
  requestPause(id: string): boolean {
    return (
      this.touch(
        "UPDATE queue_entries SET pause_requested=1, updated_at=? WHERE id=? AND status='running'",
        Date.now(),
        id,
      ) === 1
    );
  }

  /** Immediate pause (queued / blocked → paused; running only via the orchestrator's force path). */
  markPaused(id: string, from: QueueStatus[] = ["queued", "running"]): boolean {
    return (
      this.touch(
        `UPDATE queue_entries SET status='paused', pause_requested=0, current_run_id=NULL, updated_at=?
         WHERE id=? AND status IN (${from.map(() => "?").join(",")})`,
        Date.now(),
        id,
        ...from,
      ) === 1
    );
  }

  resume(id: string): boolean {
    const now = Date.now();
    const a = this.touch(
      `UPDATE queue_entries SET status='queued', next_attempt_at=NULL, waiting_reason=NULL, updated_at=?
       WHERE id=? AND status='paused'`,
      now,
      id,
    );
    // Cancel a pending graceful pause.
    const b = this.touch(
      "UPDATE queue_entries SET pause_requested=0, updated_at=? WHERE id=? AND status='running' AND pause_requested=1",
      now,
      id,
    );
    return a + b > 0;
  }

  /**
   * Reopen a blocked / failed / dead / canceled / paused entry with a fresh
   * phase budget. Optional `fromPhase` rewinds.
   */
  retry(
    id: string,
    opts: {
      fromPhase?: number;
      instruction?: string | null;
      freshSession?: boolean;
      agent?: string;
      model?: string;
    } = {},
  ): boolean {
    const e = this.get(id);
    if (!e) return false;
    const idx =
      typeof opts.fromPhase === "number"
        ? Math.max(0, Math.min(opts.fromPhase, e.phaseSpec.length - 1))
        : e.status === "done"
          ? e.phaseSpec.length - 1
          : e.currentPhaseIdx;
    const spec = e.phaseSpec.map((ph, i) =>
      i === idx && (opts.agent || opts.model !== undefined)
        ? {
            ...ph,
            ...(opts.agent ? { agent: opts.agent } : {}),
            ...(opts.model !== undefined ? { model: opts.model || undefined } : {}),
          }
        : ph,
    );
    return (
      this.touch(
        `UPDATE queue_entries SET status='queued', current_phase_idx=?, phase_attempts=0, phase_spec=?,
           transient_failures=0, next_attempt_at=NULL, blocked_kind=NULL, fix_hint=NULL,
           waiting_reason=NULL, finished_at=NULL, current_run_id=NULL, pause_requested=0,
           pending_instruction=?, fresh_session=?, last_gate=CASE WHEN ?=current_phase_idx THEN last_gate ELSE NULL END,
           updated_at=?
         WHERE id=? AND status IN ('blocked','failed','dead','canceled','paused','done')`,
        idx,
        JSON.stringify(spec),
        opts.instruction ?? null,
        opts.freshSession ? 1 : 0,
        idx,
        Date.now(),
        id,
      ) === 1
    );
  }

  /**
   * Operator skip of the current phase. Only for non-terminal entries that are
   * not running (the orchestrator stops a running attempt first).
   */
  advancePhase(id: string): QueueEntry | null {
    const tx = this.db.transaction((): QueueEntry | null => {
      const e = this.get(id);
      if (!e || !["queued", "paused", "blocked", "running"].includes(e.status)) return null;
      const now = Date.now();
      const nextIdx = e.currentPhaseIdx + 1;
      if (nextIdx >= e.phaseSpec.length) {
        this.touch(
          `UPDATE queue_entries SET status='done', finished_at=?, updated_at=?, current_run_id=NULL,
             blocked_kind=NULL, fix_hint=NULL WHERE id=?`,
          now,
          now,
          id,
        );
      } else {
        this.touch(
          `UPDATE queue_entries SET current_phase_idx=?, status='queued', current_run_id=NULL,
             phase_attempts=0, last_error=NULL, last_gate=NULL, blocked_kind=NULL, fix_hint=NULL,
             next_attempt_at=NULL, transient_failures=0, pending_instruction=NULL,
             fresh_session=0, pause_requested=0, updated_at=?
           WHERE id=?`,
          nextIdx,
          now,
          id,
        );
      }
      return this.get(id);
    });
    return tx.immediate();
  }

  consumeInstruction(id: string): void {
    this.touch("UPDATE queue_entries SET pending_instruction=NULL, fresh_session=0 WHERE id=?", id);
  }

  setPriority(id: string, priority: number): void {
    this.touch(
      "UPDATE queue_entries SET priority=?, updated_at=? WHERE id=?",
      Math.trunc(priority),
      Date.now(),
      id,
    );
  }

  /** Persist why a queued entry isn't dispatching (writes only on change). */
  setWaiting(id: string, reason: string | null): boolean {
    return (
      this.touch(
        "UPDATE queue_entries SET waiting_reason=? WHERE id=? AND COALESCE(waiting_reason,'') <> COALESCE(?, '')",
        reason,
        id,
        reason,
      ) === 1
    );
  }

  setWorktree(id: string, key: string, wt: { path: string; branch: string; repo: string }): void {
    const e = this.get(id);
    if (!e) return;
    this.touch(
      "UPDATE queue_entries SET worktrees=? WHERE id=?",
      JSON.stringify({ ...e.worktrees, [key]: wt }),
      id,
    );
  }

  // ── events ────────────────────────────────────────────────────────────────

  addEvent(
    entryId: string,
    kind: string,
    message: string,
    phaseIdx: number | null = null,
    data: Record<string, unknown> | null = null,
  ): number {
    const info = this.db
      .prepare(
        "INSERT INTO queue_events (entry_id, ts, kind, phase_idx, message, data) VALUES (?,?,?,?,?,?)",
      )
      .run(
        entryId,
        Date.now(),
        kind,
        phaseIdx,
        message.slice(0, 4000),
        data ? JSON.stringify(data) : null,
      );
    const seq = Number(info.lastInsertRowid);
    if (seq % 50 === 0) this.trimEvents(entryId);
    return seq;
  }

  private trimEvents(entryId: string): void {
    this.touch(
      `DELETE FROM queue_events WHERE entry_id=? AND seq NOT IN
         (SELECT seq FROM queue_events WHERE entry_id=? ORDER BY seq DESC LIMIT ?)`,
      entryId,
      entryId,
      MAX_EVENTS_PER_ENTRY,
    );
  }

  listEvents(entryId: string, limit = 200): QueueEventRow[] {
    const rows = this.db
      .prepare("SELECT * FROM queue_events WHERE entry_id=? ORDER BY seq DESC LIMIT ?")
      .all(entryId, Math.max(1, Math.min(limit, 2000))) as Array<{
      seq: number;
      entry_id: string;
      ts: number;
      kind: string;
      phase_idx: number | null;
      message: string;
      data: string | null;
    }>;
    return rows.reverse().map((r) => ({
      seq: r.seq,
      entryId: r.entry_id,
      ts: r.ts,
      kind: r.kind,
      phaseIdx: r.phase_idx,
      message: r.message,
      data: parseJson<Record<string, unknown> | null>(r.data, null),
    }));
  }

  // ── metrics ───────────────────────────────────────────────────────────────

  metrics(sinceMs = 0): {
    byAgent: Array<{
      agent: string;
      attempts: number;
      passed: number;
      failed: number;
      successRate: number;
      avgDurationMs: number;
      p50Ms: number;
      p90Ms: number;
    }>;
    byStatus: Record<string, number>;
    phases: { completed: number; avgDurationMs: number };
  } {
    const rows = this.db
      .prepare(
        `SELECT agent, outcome, started_at, ended_at FROM queue_attempts
         WHERE started_at >= ? AND outcome NOT IN ('starting','running','interrupted','canceled')`,
      )
      .all(sinceMs) as Array<{
      agent: string;
      outcome: string;
      started_at: number;
      ended_at: number | null;
    }>;
    const groups = new Map<string, { passed: number; failed: number; durations: number[] }>();
    for (const r of rows) {
      const g = groups.get(r.agent) ?? { passed: 0, failed: 0, durations: [] };
      if (r.outcome === "passed") g.passed++;
      else g.failed++;
      if (r.ended_at) g.durations.push(r.ended_at - r.started_at);
      groups.set(r.agent, g);
    }
    const pct = (arr: number[], p: number) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const byAgent = [...groups.entries()].map(([agent, g]) => {
      const attempts = g.passed + g.failed;
      return {
        agent,
        attempts,
        passed: g.passed,
        failed: g.failed,
        successRate: attempts ? g.passed / attempts : 0,
        avgDurationMs: g.durations.length
          ? Math.round(g.durations.reduce((a, b) => a + b, 0) / g.durations.length)
          : 0,
        p50Ms: pct(g.durations, 50),
        p90Ms: pct(g.durations, 90),
      };
    });
    const passed = rows.filter((r) => r.outcome === "passed" && r.ended_at);
    return {
      byAgent,
      byStatus: this.countByStatus(),
      phases: {
        completed: passed.length,
        avgDurationMs: passed.length
          ? Math.round(passed.reduce((a, r) => a + (r.ended_at! - r.started_at), 0) / passed.length)
          : 0,
      },
    };
  }

  /**
   * Legacy restart sweep (pre-runner behaviour). Kept for callers/tests that
   * still use it; the orchestrator now reconciles running entries instead of
   * blocking them (see QueueOrchestrator.recover).
   */
  sweepRunningOnBoot(reason = "orchestrator restart - session lost"): QueueEntry[] {
    const rows = this.list({ status: "running", limit: 5000 });
    for (const r of rows) this.markBlocked(r.id, reason, "restart");
    return rows;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let _instance: QueueStore | null = null;

export function getQueueStore(stateDir: string = resolveStateDir()): QueueStore {
  if (!_instance) _instance = new QueueStore(stateDir);
  return _instance;
}

/** Test-only: drop the singleton (so a fresh stateDir can be wired up). */
export function resetQueueStoreForTests(): void {
  _instance?.close();
  _instance = null;
}
