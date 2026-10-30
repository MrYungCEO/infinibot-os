/**
 * Kanban reconciliation for verified completion.
 *
 * Every coder / sub-agent run is tracked as a kanban task (kanbanTaskId at
 * spawn). When the verification pipeline settles a run, the board must say so
 * — otherwise tasks sit in "In progress" forever after their run ended. This
 * module is the single owner of that board update:
 *
 *   verified / accepted                         → Done   (+ completion note + evidence)
 *   unverified                                  → Review (+ what is missing)
 *   failed / stalled / blocked / needs_input /
 *   needs_owner / rejected                      → Review + Blocked flag (+ reason + follow-up)
 *   operator Continue / Retry, respawn          → back to In progress
 *
 * Tasks the run referenced explicitly (task ids in its brief or RESULT, or
 * RESULT.tasks_completed) on the SAME project board get the same treatment.
 * Title-only (fuzzy) matches are only suggested in a note, never moved.
 *
 * Writes go through the gateway's own `kanban.tasks.update` handler (Notion
 * PATCH + list-cache overlay + kanban:changed broadcast), so the board, the
 * dashboard and Notion agree. A ledger makes every write idempotent: the same
 * run / round / task is never written twice, and a task someone moved after
 * our write is left alone (no flapping).
 *
 * A periodic sweep covers runs the event hook never saw (crashes, timeouts,
 * old runs): run-linked tasks still To do / In progress whose run ended more
 * than N minutes ago are reconciled from the run's verification record.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { CompletionRecord, CompletionState } from "./store.js";
import { coerceString } from "../shared/text/coerce.js";

const log = createSubsystemLogger("verification/kanban");

// ── Types ─────────────────────────────────────────────────────────────────────

export type KanbanStatus = "backlog" | "todo" | "in_progress" | "review" | "done";

export interface BoardTask {
  id: string;
  title: string;
  status: string;
  projectId?: string | null;
  autonomousStatus?: string | null;
}

/** What the board should say for a run in a given completion state. */
export interface KanbanPlan {
  status: KanbanStatus;
  /** Sets the board's "blocked" flag (autonomousStatus) — surfaces in Needs you / HQ. */
  blocked: boolean;
  /** Short label for logs / the run review ("Done", "Review", "Blocked", "In progress"). */
  label: string;
}

/** Run facts the reconciler needs; resolved from the registry / history / run review. */
export interface RunLink {
  runId: string;
  kanbanTaskId?: string;
  respawnOfRunId?: string;
  label?: string;
  task?: string;
  endedAt?: number;
  /** Registry outcome when the run ended (ok | error | timeout …). */
  outcomeStatus?: string;
  /** True while the run's process is still alive. */
  live?: boolean;
}

export interface KanbanUpdate {
  runId: string;
  taskId: string;
  title?: string;
  /** Why this task was touched. */
  relation: "primary" | "referenced" | "respawn-original" | "suggested";
  from?: string;
  to?: KanbanStatus;
  blocked?: boolean;
  /** applied | dry-run | skipped (with reason) | failed. */
  outcome: "applied" | "dry-run" | "skipped" | "failed";
  reason?: string;
  state: CompletionState | "reopened";
  at: number;
}

export interface ReconcileDeps {
  /** Whole board (all projects). Null when the board cannot be read. */
  listTasks: () => Promise<BoardTask[] | null>;
  updateTask: (taskId: string, patch: Record<string, unknown>) => Promise<boolean>;
  appendNote: (taskId: string, note: string) => Promise<boolean>;
  resolveRun: (runId: string) => RunLink | null | Promise<RunLink | null>;
  /** Verification record for a run (defaults to the verification store). */
  getRecord?: (runId: string) => CompletionRecord | undefined;
  /** Persist the updates on the run review (activity feed). */
  recordUpdates?: (runId: string, updates: KanbanUpdate[]) => void;
  now?: () => number;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

const BLOCKING_STATES: ReadonlySet<string> = new Set([
  "failed",
  "stalled",
  "blocked",
  "needs_input",
  "needs_owner",
  "rejected",
]);

/** Verdict / terminal state → board status. Null for states that never move the board. */
export function planForState(state: CompletionState | "reopened"): KanbanPlan | null {
  if (state === "verified" || state === "accepted")
    return { status: "done", blocked: false, label: "Done" };
  if (state === "unverified") return { status: "review", blocked: false, label: "Review" };
  if (BLOCKING_STATES.has(state)) return { status: "review", blocked: true, label: "Blocked" };
  if (state === "reopened" || state === "continuing")
    return { status: "in_progress", blocked: false, label: "In progress" };
  return null;
}

const UUID_DASHED = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const UUID_COMPACT = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;

/** Canonical dashed lower-case form of a task id (Notion ids come in both shapes). */
export function normalizeTaskId(id: string): string {
  const hex = id.toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.trim().toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Every task-id-shaped token in a text (dashed UUIDs and 32-hex Notion ids), normalized. */
export function extractTaskIdTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(UUID_DASHED)) out.add(normalizeTaskId(m[0]));
  for (const m of text.matchAll(UUID_COMPACT)) out.add(normalizeTaskId(m[0]));
  return [...out];
}

export interface ReferencedTasks {
  /** Explicit references on the same project board — same treatment as the run's own task. */
  explicit: BoardTask[];
  /** Title-only matches — suggested in a note, never moved. */
  suggested: BoardTask[];
}

/**
 * Tasks the run referenced explicitly: task ids in the brief / RESULT text,
 * plus RESULT.tasks_completed. Only tasks on the primary task's project board
 * count (never unrelated boards); the primary itself is excluded. Title
 * matches (≥ 12 chars, quoted in the RESULT summary) are only suggestions.
 */
export function findReferencedTasks(params: {
  primary: BoardTask | null;
  board: BoardTask[];
  texts: Array<string | null | undefined>;
  tasksCompleted?: string[];
  summary?: string | null;
}): ReferencedTasks {
  const projectId = params.primary?.projectId || "";
  const primaryId = params.primary ? normalizeTaskId(params.primary.id) : "";
  if (!projectId) return { explicit: [], suggested: [] };
  const sameBoard = params.board.filter(
    (t) => (t.projectId || "") === projectId && normalizeTaskId(t.id) !== primaryId,
  );
  const byId = new Map(sameBoard.map((t) => [normalizeTaskId(t.id), t]));
  const ids = new Set<string>();
  for (const t of params.texts) for (const id of extractTaskIdTokens(t)) ids.add(id);
  for (const raw of params.tasksCompleted ?? []) ids.add(normalizeTaskId(raw));
  const explicit = [...ids].map((id) => byId.get(id)).filter((t): t is BoardTask => Boolean(t));

  const explicitIds = new Set(explicit.map((t) => normalizeTaskId(t.id)));
  const summary = (params.summary ?? "").toLowerCase();
  const suggested = summary
    ? sameBoard.filter((t) => {
        if (explicitIds.has(normalizeTaskId(t.id))) return false;
        if (t.status === "done") return false;
        const title = (t.title ?? "").trim().toLowerCase();
        return title.length >= 12 && summary.includes(title);
      })
    : [];
  return { explicit, suggested: suggested.slice(0, 5) };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Note appended to a task when the reconciler moves it. */
export function buildNote(params: {
  state: CompletionState | "reopened";
  runId: string;
  rec?: CompletionRecord;
  relation: KanbanUpdate["relation"];
  primaryTaskId?: string;
  newRunId?: string;
}): string {
  const { state, runId, rec } = params;
  const reasons = (rec?.review?.reasons ?? []).filter(Boolean).slice(0, 5);
  const summary = rec?.result?.summary?.trim();
  const via =
    params.relation === "referenced"
      ? ` (referenced by run ${runId}${params.primaryTaskId ? `, task ${params.primaryTaskId}` : ""})`
      : params.relation === "respawn-original"
        ? ` (original task; run ${runId} continued this work)`
        : "";
  const lines: string[] = [];
  if (state === "reopened") {
    lines.push(
      `↻ Back in progress${via} — ${params.newRunId ? `respawned as run ${params.newRunId}` : `run ${runId} was reopened (Continue / Retry)`}.`,
    );
    return lines.join("\n");
  }
  if (state === "verified" || state === "accepted") {
    lines.push(
      `✅ ${state === "accepted" ? "ACCEPTED by owner" : "VERIFIED"} → Done${via} — run ${runId}`,
    );
    if (summary) lines.push(clip(summary, 600));
    const commits = rec?.review?.commits?.length
      ? rec.review.commits
      : (rec?.result?.commits ?? []);
    if (commits.length) lines.push(`Commits: ${commits.slice(0, 8).join(", ")}`);
    const shots = rec?.review?.screenshots ?? [];
    if (shots.length) lines.push(`Screenshots: ${shots.slice(0, 6).join(", ")}`);
    const passed = (rec?.review?.evidence ?? []).filter((e) => e.status === "pass").length;
    if (passed) lines.push(`Evidence: ${passed} check(s) passed`);
    return lines.join("\n");
  }
  if (state === "unverified") {
    lines.push(`🔶 UNVERIFIED → Review${via} — run ${runId}`);
    if (summary) lines.push(`Claimed: ${clip(summary, 400)}`);
    lines.push(
      reasons.length
        ? `Missing:\n- ${reasons.map((r) => clip(r, 240)).join("\n- ")}`
        : "Missing: no verifiable evidence was recorded.",
    );
    lines.push(`Next: review the run, or respawn it (claude_coder respawnOfRunId=${runId}).`);
    return lines.join("\n");
  }
  const word = state.replace(/_/g, " ").toUpperCase();
  lines.push(`⛔ ${word} → Review (blocked)${via} — run ${runId}`);
  const open = rec?.result?.open_issues ?? [];
  const why = [...reasons, ...open].filter(Boolean).slice(0, 6);
  lines.push(
    why.length
      ? `Reason:\n- ${why.map((r) => clip(r, 240)).join("\n- ")}`
      : "Reason: the run ended without a verified result.",
  );
  lines.push(
    state === "needs_input" || state === "needs_owner"
      ? `Follow-up: answer / decide in Reviews (Accept, Reject or Continue run ${runId}).`
      : `Follow-up: respawn with claude_coder respawnOfRunId=${runId}, or Continue / Retry it from Reviews.`,
  );
  return lines.join("\n");
}

// ── Ledger (idempotency) ──────────────────────────────────────────────────────

export interface LedgerEntry {
  runId: string;
  taskId: string;
  title?: string;
  relation?: KanbanUpdate["relation"];
  from?: string;
  round: number;
  state: string;
  status: KanbanStatus;
  blocked: boolean;
  at: number;
}

let ledger: Map<string, LedgerEntry> | null = null;
let ledgerDir: string | null = null;
const LEDGER_CAP = 5000;

async function stateDir(): Promise<string> {
  const { resolveStateDir } = await import("../config/paths.js");
  return path.join(resolveStateDir(), "verification");
}

function ledgerFile(dir: string): string {
  return path.join(dir, "kanban-reconcile.json");
}

async function loadLedger(): Promise<Map<string, LedgerEntry>> {
  const dir = await stateDir();
  if (ledger && ledgerDir === dir) return ledger;
  ledger = new Map();
  ledgerDir = dir;
  try {
    const raw = JSON.parse(readFileSync(ledgerFile(dir), "utf8")) as { entries?: LedgerEntry[] };
    for (const e of raw.entries ?? []) if (e?.runId && e.taskId) ledger.set(ledgerKey(e), e);
  } catch {
    /* fresh */
  }
  return ledger;
}

function saveLedger(): void {
  if (!ledger || !ledgerDir) return;
  try {
    if (!existsSync(ledgerDir)) mkdirSync(ledgerDir, { recursive: true });
    const entries = [...ledger.values()].sort((a, b) => a.at - b.at).slice(-LEDGER_CAP);
    const file = ledgerFile(ledgerDir);
    writeFileSync(`${file}.tmp`, JSON.stringify({ entries }, null, 0));
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    log.warn("kanban reconcile ledger save failed", { err: String(err) });
  }
}

function ledgerKey(e: { runId: string; taskId: string; round: number }): string {
  return `${e.runId}#${e.round}#${normalizeTaskId(e.taskId)}`;
}

/** Ledger entries for a run (newest round first) — used by run-review capture. */
export async function getLedgerUpdatesForRun(runId: string): Promise<LedgerEntry[]> {
  const l = await loadLedger();
  return [...l.values()].filter((e) => e.runId === runId).sort((a, b) => b.at - a.at);
}

/** Most recent ledger entry for a task (any run). */
async function lastLedgerForTask(taskId: string): Promise<LedgerEntry | undefined> {
  const l = await loadLedger();
  const id = normalizeTaskId(taskId);
  let best: LedgerEntry | undefined;
  for (const e of l.values())
    if (normalizeTaskId(e.taskId) === id && (!best || e.at > best.at)) best = e;
  return best;
}

export function __resetKanbanReconcileForTests(): void {
  ledger = null;
  ledgerDir = null;
  boardCache = null;
}

// ── Core ──────────────────────────────────────────────────────────────────────

async function applyOne(params: {
  deps: ReconcileDeps;
  task: BoardTask;
  plan: KanbanPlan;
  state: CompletionState | "reopened";
  runId: string;
  round: number;
  relation: KanbanUpdate["relation"];
  note: string;
  dryRun: boolean;
  /** Re-open even when the task is Done (operator Continue / respawn). */
  allowFromDone?: boolean;
}): Promise<KanbanUpdate> {
  const { deps, task, plan, state, runId, round, relation, dryRun } = params;
  const at = (deps.now ?? Date.now)();
  const base: KanbanUpdate = {
    runId,
    taskId: task.id,
    title: task.title,
    relation,
    from: String(task.status),
    to: plan.status,
    blocked: plan.blocked,
    outcome: "skipped",
    state,
    at,
  };
  const l = await loadLedger();
  const key = ledgerKey({ runId, taskId: task.id, round });
  const prior = l.get(key);
  // Owner (or a later run) moved the task after our last write for this run:
  // leave it alone instead of flapping it back.
  if (prior && task.status !== prior.status)
    return { ...base, reason: `task was moved to ${task.status} after reconciliation` };
  if (
    prior &&
    prior.status === plan.status &&
    prior.blocked === plan.blocked &&
    prior.state === state
  )
    return { ...base, reason: "already reconciled for this run" };
  // Never pull a finished task back to Review — note it instead.
  if (task.status === "done" && plan.status !== "done" && !params.allowFromDone)
    return { ...base, reason: "task is already Done" };
  const alreadyThere =
    task.status === plan.status && (task.autonomousStatus === "blocked") === plan.blocked;
  if (dryRun)
    return {
      ...base,
      outcome: "dry-run",
      reason: alreadyThere ? "already in target status" : undefined,
    };

  if (!alreadyThere) {
    const patch: Record<string, unknown> = { status: plan.status };
    if (plan.blocked) patch.autonomousStatus = "blocked";
    else if (task.autonomousStatus === "blocked")
      patch.autonomousStatus = plan.status === "done" ? "complete" : "in_progress";
    let ok = false;
    try {
      ok = await deps.updateTask(task.id, patch);
    } catch (err) {
      return { ...base, outcome: "failed", reason: String(err) };
    }
    if (!ok) return { ...base, outcome: "failed", reason: "kanban update was not saved" };
  }
  // Note is best-effort and written once per (run, round, task, state).
  await deps.appendNote(task.id, params.note).catch(() => false);
  l.set(key, {
    runId,
    taskId: task.id,
    title: task.title,
    relation,
    from: String(task.status),
    round,
    state,
    status: plan.status,
    blocked: plan.blocked,
    at,
  });
  saveLedger();
  return {
    ...base,
    outcome: "applied",
    reason: alreadyThere ? "already in target status (note added)" : undefined,
  };
}

function findTask(board: BoardTask[], id: string | undefined): BoardTask | null {
  if (!id) return null;
  const want = normalizeTaskId(id);
  return board.find((t) => normalizeTaskId(t.id) === want) ?? null;
}

/**
 * Reconcile the board for one run after its verification state settled.
 * `state` defaults to the record's state. Never throws.
 */
export async function reconcileRunKanban(
  runId: string,
  deps: ReconcileDeps,
  opts: {
    state?: CompletionState | "reopened";
    dryRun?: boolean;
    newRunId?: string;
    board?: BoardTask[];
  } = {},
): Promise<KanbanUpdate[]> {
  const updates: KanbanUpdate[] = [];
  try {
    const rec = (deps.getRecord ?? (await defaultGetRecord()))(runId);
    const state = opts.state ?? rec?.state;
    if (!state) return updates;
    const plan = planForState(state);
    if (!plan) return updates;
    const link = await deps.resolveRun(runId);
    if (!link?.kanbanTaskId) return updates;
    const board = opts.board ?? (await deps.listTasks());
    if (!board) {
      log.warn("kanban reconcile: board unavailable", { runId });
      return updates;
    }
    const round = rec?.round ?? 1;
    const dryRun = Boolean(opts.dryRun);
    const primary = findTask(board, link.kanbanTaskId);
    const allowFromDone = state === "reopened";
    if (primary) {
      updates.push(
        await applyOne({
          deps,
          task: primary,
          plan,
          state,
          runId,
          round,
          relation: "primary",
          note: buildNote({ state, runId, rec, relation: "primary", newRunId: opts.newRunId }),
          dryRun,
          allowFromDone,
        }),
      );
    } else {
      updates.push({
        runId,
        taskId: link.kanbanTaskId,
        relation: "primary",
        outcome: "skipped",
        reason: "task not found on the board",
        state,
        at: (deps.now ?? Date.now)(),
      });
    }

    // Respawn: the original run's task (when it is a different card) follows.
    if (link.respawnOfRunId && state !== "reopened") {
      const orig = await deps.resolveRun(link.respawnOfRunId);
      const origTask = findTask(board, orig?.kanbanTaskId);
      if (origTask && (!primary || normalizeTaskId(origTask.id) !== normalizeTaskId(primary.id))) {
        updates.push(
          await applyOne({
            deps,
            task: origTask,
            plan,
            state,
            runId,
            round,
            relation: "respawn-original",
            note: buildNote({ state, runId, rec, relation: "respawn-original" }),
            dryRun,
          }),
        );
      }
    }

    // Explicitly referenced tasks on the same project board.
    if (state !== "reopened" && primary) {
      const refs = findReferencedTasks({
        primary,
        board,
        texts: [link.task, rec?.task, rec?.result?.summary, ...(rec?.result?.open_issues ?? [])],
        tasksCompleted: rec?.result?.tasks_completed,
        summary: rec?.result?.summary,
      });
      for (const t of refs.explicit) {
        updates.push(
          await applyOne({
            deps,
            task: t,
            plan,
            state,
            runId,
            round,
            relation: "referenced",
            note: buildNote({
              state,
              runId,
              rec,
              relation: "referenced",
              primaryTaskId: primary.id,
            }),
            dryRun,
          }),
        );
      }
      if (refs.suggested.length) {
        const at = (deps.now ?? Date.now)();
        for (const t of refs.suggested)
          updates.push({
            runId,
            taskId: t.id,
            title: t.title,
            relation: "suggested",
            from: String(t.status),
            outcome: "skipped",
            reason: "title match only — suggested, not moved",
            state,
            at,
          });
        const l = await loadLedger();
        const key = ledgerKey({ runId, taskId: `suggest-${primary.id}`, round });
        if (!dryRun && !l.has(key)) {
          await deps
            .appendNote(
              primary.id,
              `💡 Run ${runId} may also cover these tasks on this board (title match — not moved):\n- ${refs.suggested
                .map((t) => `${t.title} (${t.id}, ${t.status})`)
                .join("\n- ")}`,
            )
            .catch(() => false);
          l.set(key, {
            runId,
            taskId: `suggest-${primary.id}`,
            round,
            state,
            status: plan.status,
            blocked: false,
            at,
          });
          saveLedger();
        }
      }
    }

    const changed = updates.filter((u) => u.outcome === "applied");
    if (changed.length && !dryRun) {
      log.info("kanban reconciled", {
        runId,
        state,
        tasks: changed.map((u) => `${u.taskId}:${u.from}→${u.to}${u.blocked ? "(blocked)" : ""}`),
      });
      try {
        deps.recordUpdates?.(
          runId,
          updates.filter((u) => u.outcome !== "skipped" || u.relation === "suggested"),
        );
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    log.warn("kanban reconcile failed", { runId, err: String(err) });
  }
  return updates;
}

/** A respawn (or operator Continue) moves the original task back to In progress. */
export async function reopenRunKanban(
  runId: string,
  deps: ReconcileDeps,
  opts: { newRunId?: string } = {},
): Promise<KanbanUpdate[]> {
  return reconcileRunKanban(runId, deps, { state: "reopened", newRunId: opts.newRunId });
}

/**
 * A respawn continues the ORIGINAL task instead of creating a duplicate card:
 * returns the original run's kanban task id (moved back to In progress, the
 * blocked flag cleared, a link note added), or undefined when there is none.
 */
export async function claimRespawnTask(
  respawnOfRunId: string,
  newRunId: string,
  deps: Pick<
    ReconcileDeps,
    "listTasks" | "updateTask" | "appendNote" | "resolveRun"
  > = gatewayReconcileDeps(),
): Promise<string | undefined> {
  try {
    const orig = await deps.resolveRun(respawnOfRunId);
    if (!orig?.kanbanTaskId) return undefined;
    const board = await deps.listTasks();
    const task = board ? findTask(board, orig.kanbanTaskId) : null;
    // Unknown board (Notion down) — still reuse the id; the update path queues it.
    const patch: Record<string, unknown> = { status: "in_progress" };
    if (task?.autonomousStatus === "blocked") patch.autonomousStatus = "in_progress";
    if (!task || task.status !== "in_progress" || patch.autonomousStatus)
      await deps.updateTask(orig.kanbanTaskId, patch).catch(() => false);
    await deps
      .appendNote(
        orig.kanbanTaskId,
        buildNote({ state: "reopened", runId: respawnOfRunId, relation: "primary", newRunId }),
      )
      .catch(() => false);
    return orig.kanbanTaskId;
  } catch (err) {
    log.warn("kanban respawn claim failed", { respawnOfRunId, err: String(err) });
    return undefined;
  }
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

export interface SweepCandidate {
  runId: string;
  taskId: string;
  title?: string;
  taskStatus: string;
  endedAt?: number;
  state: CompletionState;
  stateSource: "record" | "record-stuck" | "outcome";
  plan: KanbanPlan;
}

export interface SweepReport {
  at: number;
  dryRun: boolean;
  olderThanMs: number;
  scannedRuns: number;
  candidates: SweepCandidate[];
  skipped: Array<{ runId: string; taskId?: string; reason: string }>;
  updates: KanbanUpdate[];
}

/** Sweep state for a run that ended without the event hook settling its task. */
export function sweepStateFor(
  link: RunLink,
  rec: CompletionRecord | undefined,
): { state: CompletionState; source: SweepCandidate["stateSource"] } {
  if (rec && rec.terminalAt && planForState(rec.state))
    return { state: rec.state, source: "record" };
  if (rec) return { state: "stalled", source: "record-stuck" };
  const o = (link.outcomeStatus ?? "").toLowerCase();
  if (o === "error" || o === "failed" || o === "killed")
    return { state: "failed", source: "outcome" };
  if (o === "timeout") return { state: "stalled", source: "outcome" };
  return { state: "unverified", source: "outcome" };
}

/**
 * Reconcile run-linked tasks still To do / In progress whose run ended more
 * than `olderThanMs` ago. Uses the latest run per task; skips tasks that have
 * a live run. Dry-run reports without writing.
 */
export async function sweepStalledRunTasks(params: {
  deps: ReconcileDeps;
  runs: RunLink[];
  olderThanMs?: number;
  dryRun?: boolean;
}): Promise<SweepReport> {
  const { deps } = params;
  const now = (deps.now ?? Date.now)();
  const olderThanMs = params.olderThanMs ?? 30 * 60_000;
  const dryRun = Boolean(params.dryRun);
  const report: SweepReport = {
    at: now,
    dryRun,
    olderThanMs,
    scannedRuns: params.runs.length,
    candidates: [],
    skipped: [],
    updates: [],
  };
  const board = await deps.listTasks();
  if (!board) {
    report.skipped.push({ runId: "*", reason: "board unavailable" });
    return report;
  }
  const getRecord = deps.getRecord ?? (await defaultGetRecord());

  // Latest run per task; a live run on the task blocks the sweep for it.
  const byTask = new Map<string, RunLink[]>();
  for (const r of params.runs) {
    if (!r.kanbanTaskId) continue;
    const k = normalizeTaskId(r.kanbanTaskId);
    byTask.set(k, [...(byTask.get(k) ?? []), r]);
  }
  for (const [taskKey, runs] of byTask) {
    const task = findTask(board, taskKey);
    if (!task) continue;
    if (task.status !== "in_progress" && task.status !== "todo") continue;
    if (runs.some((r) => r.live || !r.endedAt)) {
      report.skipped.push({
        runId: runs[0].runId,
        taskId: task.id,
        reason: "a run on this task is still live",
      });
      continue;
    }
    const latest = [...runs].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    if (now - (latest.endedAt ?? now) < olderThanMs) {
      report.skipped.push({ runId: latest.runId, taskId: task.id, reason: "run ended recently" });
      continue;
    }
    const last = await lastLedgerForTask(task.id);
    if (last && last.status !== task.status && last.at >= (latest.endedAt ?? 0)) {
      report.skipped.push({
        runId: latest.runId,
        taskId: task.id,
        reason: `moved to ${task.status} after reconciliation — left alone`,
      });
      continue;
    }
    const rec = getRecord(latest.runId);
    const { state, source } = sweepStateFor(latest, rec);
    const plan = planForState(state)!;
    report.candidates.push({
      runId: latest.runId,
      taskId: task.id,
      title: task.title,
      taskStatus: String(task.status),
      endedAt: latest.endedAt,
      state,
      stateSource: source,
      plan,
    });
    const ups = await reconcileRunKanban(
      latest.runId,
      {
        ...deps,
        getRecord,
        resolveRun: async (id) => (id === latest.runId ? latest : deps.resolveRun(id)),
      },
      {
        state,
        dryRun,
        board,
      },
    );
    report.updates.push(...ups);
  }
  return report;
}

// ── Production wiring ─────────────────────────────────────────────────────────

export function isKanbanReconcileEnabled(): boolean {
  return process.env.INFINIBOT_KANBAN_RECONCILE !== "0";
}

async function defaultGetRecord(): Promise<(runId: string) => CompletionRecord | undefined> {
  const { getRecord } = await import("./store.js");
  return getRecord;
}

type HandlerResult = { ok: boolean; payload?: unknown; error?: { message?: string } };

/** Call a kanban RPC handler in-process (same path as the UI: Notion + cache overlay + broadcast). */
async function callKanbanRpc(
  method: string,
  params: Record<string, unknown>,
): Promise<HandlerResult> {
  const { kanbanHandlers } = await import("../gateway/server-methods/kanban.js");
  const { getGatewayBroadcaster } = await import("../agents/coder-runtime/subagent-broadcast.js");
  const handler = kanbanHandlers[method];
  if (!handler) return { ok: false, error: { message: `no handler ${method}` } };
  const broadcast = getGatewayBroadcaster() ?? (() => {});
  return await new Promise<HandlerResult>((resolve) => {
    const respond = (ok: boolean, payload?: unknown, error?: { message?: string }) =>
      resolve({ ok, payload, error });
    Promise.resolve(
      handler({
        req: { type: "req", id: `kanban-reconcile-${Date.now()}`, method, params } as never,
        params,
        client: null,
        isWebchatConnect: () => false,
        respond: respond as never,
        context: { broadcast } as never,
      }),
    ).catch((err) => resolve({ ok: false, error: { message: String(err) } }));
  });
}

let boardCache: { at: number; tasks: BoardTask[] } | null = null;

async function gatewayListTasks(): Promise<BoardTask[] | null> {
  if (boardCache && Date.now() - boardCache.at < 15_000) return boardCache.tasks;
  const res = await callKanbanRpc("kanban.tasks.list", {});
  if (!res.ok || !Array.isArray(res.payload)) return null;
  const tasks = (res.payload as Array<Record<string, unknown>>).map((t) => ({
    id: coerceString(t.id),
    title: coerceString(t.title),
    status: coerceString(t.status),
    projectId: typeof t.projectId === "string" ? t.projectId : null,
    autonomousStatus: typeof t.autonomousStatus === "string" ? t.autonomousStatus : null,
  }));
  boardCache = { at: Date.now(), tasks };
  return tasks;
}

async function gatewayUpdateTask(taskId: string, patch: Record<string, unknown>): Promise<boolean> {
  const res = await callKanbanRpc("kanban.tasks.update", {
    id: taskId,
    patch,
    source: "automation",
  });
  if (!res.ok) log.warn("kanban reconcile: update failed", { taskId, err: res.error?.message });
  boardCache = null;
  return res.ok;
}

async function gatewayAppendNote(taskId: string, note: string): Promise<boolean> {
  const { mcpAppendTaskNote } = await import("../agents/tools/kanban-tool.js");
  return mcpAppendTaskNote(taskId, note);
}

/** Resolve the kanban link of a run from the registry, history or run review. */
export async function resolveRunLinkDefault(runId: string): Promise<RunLink | null> {
  try {
    const reg = await import("../agents/subagent-registry.js");
    const live = reg.getSubagentRun(runId);
    if (live) {
      return {
        runId,
        kanbanTaskId: live.kanbanTaskId,
        respawnOfRunId: live.respawnOfRunId,
        label: live.label,
        task: live.task,
        endedAt: live.endedAt,
        outcomeStatus: live.outcome?.status,
        live: live.endedAt == null,
      };
    }
    const hist = await import("../agents/subagent-history.js");
    const arc = hist.getSubagentHistoryEntryByRunId(runId);
    if (arc) {
      return {
        runId,
        kanbanTaskId: arc.kanbanTaskId,
        respawnOfRunId: arc.respawnOfRunId,
        label: arc.label,
        task: arc.task,
        endedAt: arc.endedAt,
        outcomeStatus: arc.outcome?.status ?? (arc.status === "complete" ? "ok" : arc.status),
        live: false,
      };
    }
    const rr = await import("../agents/run-reviews/query.js");
    const review = rr.getRunReviewByRunId(runId);
    if (review?.kanbanTaskId) {
      return {
        runId,
        kanbanTaskId: review.kanbanTaskId,
        label: review.title,
        endedAt: review.finishedAt,
        live: false,
      };
    }
  } catch (err) {
    log.debug("kanban reconcile: run link lookup failed", { runId, err: String(err) });
  }
  return null;
}

/** Store the updates on the run review (actions timeline + kanbanUpdates). */
export function recordUpdatesOnRunReview(runId: string, updates: KanbanUpdate[]): void {
  void import("../agents/run-reviews/index.js")
    .then(({ getRunReviewByRunId, patchRunReview }) => {
      const existing = getRunReviewByRunId(runId);
      if (!existing) return; // capture folds the ledger in when it runs later
      patchRunReview(runId, mergeKanbanUpdatesIntoReview(existing, updates));
    })
    .catch(() => {});
}

/** Merge kanban updates into a run review's actions + kanbanUpdates (deduped). */
/** KanbanUpdate as stored on a run review (schema-compatible, runId implied). */
export type ReviewKanbanEntry = Omit<KanbanUpdate, "runId" | "state" | "to"> & {
  to?: string;
  runId?: string;
  state: string;
};

export function mergeKanbanUpdatesIntoReview(
  review: {
    actions: Array<{ ts: number; kind: string; detail: string }>;
    kanbanUpdates?: ReviewKanbanEntry[];
  },
  updates: ReviewKanbanEntry[],
): {
  actions: Array<{ ts: number; kind: string; detail: string }>;
  kanbanUpdates: ReviewKanbanEntry[];
} {
  const seen = new Set(
    (review.kanbanUpdates ?? []).map((u) => `${u.taskId}#${u.state}#${u.to}#${u.relation}`),
  );
  const fresh = updates.filter((u) => !seen.has(`${u.taskId}#${u.state}#${u.to}#${u.relation}`));
  const actions = [
    ...review.actions,
    ...fresh.map((u) => ({
      ts: u.at,
      kind: "kanban",
      detail:
        u.relation === "suggested"
          ? `Kanban: suggested "${u.title ?? u.taskId}" (title match, not moved)`
          : `Kanban: "${u.title ?? u.taskId}" ${u.from ?? "?"} → ${u.to}${u.blocked ? " (blocked)" : ""}${u.relation !== "primary" ? ` [${u.relation}]` : ""}${u.outcome !== "applied" ? ` — ${u.outcome}${u.reason ? `: ${u.reason}` : ""}` : ""}`,
    })),
  ];
  return { actions, kanbanUpdates: [...(review.kanbanUpdates ?? []), ...fresh].slice(-50) };
}

export function gatewayReconcileDeps(): ReconcileDeps {
  return {
    listTasks: gatewayListTasks,
    updateTask: gatewayUpdateTask,
    appendNote: gatewayAppendNote,
    resolveRun: resolveRunLinkDefault,
    recordUpdates: recordUpdatesOnRunReview,
  };
}

/** Run link from a run review (kept far longer than the registry history). */
export function runLinkFromRunReview(r: {
  runId: string;
  kanbanTaskId?: string;
  title?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
}): RunLink | null {
  if (!r.kanbanTaskId || r.status === "in_progress") return null;
  return {
    runId: r.runId,
    kanbanTaskId: r.kanbanTaskId,
    label: r.title,
    endedAt: r.finishedAt ?? r.startedAt,
    outcomeStatus: r.status === "failed" ? "error" : "ok",
    live: false,
  };
}

/** Every run the registry, history and run reviews know about that is linked to a kanban task. */
export async function collectRunLinks(): Promise<RunLink[]> {
  const out = new Map<string, RunLink>();
  try {
    const reg = await import("../agents/subagent-registry.js");
    for (const e of reg.listAllSubagentRuns()) {
      if (!e.kanbanTaskId) continue;
      out.set(e.runId, {
        runId: e.runId,
        kanbanTaskId: e.kanbanTaskId,
        respawnOfRunId: e.respawnOfRunId,
        label: e.label,
        task: e.task,
        endedAt: e.endedAt,
        outcomeStatus: e.outcome?.status,
        live: e.endedAt == null,
      });
    }
  } catch (err) {
    log.debug("collectRunLinks: registry unavailable", { err: String(err) });
  }
  try {
    const hist = await import("../agents/subagent-history.js");
    for (const a of hist.listSubagentHistory({ limit: 500 }).entries) {
      if (!a.kanbanTaskId || out.has(a.runId)) continue;
      out.set(a.runId, {
        runId: a.runId,
        kanbanTaskId: a.kanbanTaskId,
        respawnOfRunId: a.respawnOfRunId,
        label: a.label,
        task: a.task,
        endedAt: a.endedAt,
        outcomeStatus: a.outcome?.status ?? (a.status === "complete" ? "ok" : a.status),
        live: false,
      });
    }
  } catch (err) {
    log.debug("collectRunLinks: history unavailable", { err: String(err) });
  }
  try {
    const rr = await import("../agents/run-reviews/query.js");
    for (const r of rr.listRunReviews({ limit: 500 }).reviews) {
      if (out.has(r.runId)) continue;
      const link = runLinkFromRunReview(r);
      if (link) out.set(r.runId, link);
    }
  } catch (err) {
    log.debug("collectRunLinks: run reviews unavailable", { err: String(err) });
  }
  return [...out.values()];
}

let installed = false;

/**
 * Gateway boot: reconcile on every terminal / decision event, and sweep
 * stalled run tasks periodically. Off with INFINIBOT_KANBAN_RECONCILE=0.
 */
export function installKanbanReconciler(
  opts: { sweepEveryMs?: number; olderThanMs?: number } = {},
): () => void {
  if (installed || !isKanbanReconcileEnabled()) return () => {};
  installed = true;
  const deps = gatewayReconcileDeps();
  let unsubscribe: () => void = () => {};
  void import("./store.js").then(({ onCompletionEvent }) => {
    unsubscribe = onCompletionEvent((ev) => {
      if (
        ev.type === "run.terminal" ||
        (ev.type === "run.decision" && (ev.state === "accepted" || ev.state === "rejected"))
      ) {
        void reconcileRunKanban(ev.runId, deps);
      } else if (ev.type === "run.decision" && ev.state === "continuing") {
        void reopenRunKanban(ev.runId, deps);
      }
    });
  });
  const envMin = Number(process.env.INFINIBOT_KANBAN_SWEEP_MIN);
  const olderThanMs =
    opts.olderThanMs ?? (Number.isFinite(envMin) && envMin > 0 ? envMin * 60_000 : 30 * 60_000);
  const every = opts.sweepEveryMs ?? 15 * 60_000;
  const sweep = async () => {
    try {
      const runs = await collectRunLinks();
      const report = await sweepStalledRunTasks({ deps, runs, olderThanMs });
      const applied = report.updates.filter((u) => u.outcome === "applied");
      if (applied.length)
        log.info("kanban sweep reconciled stalled run tasks", { count: applied.length });
    } catch (err) {
      log.warn("kanban sweep failed", { err: String(err) });
    }
  };
  const first = setTimeout(() => void sweep(), 3 * 60_000);
  const timer = setInterval(() => void sweep(), every);
  first.unref?.();
  timer.unref?.();
  return () => {
    installed = false;
    unsubscribe();
    clearTimeout(first);
    clearInterval(timer);
  };
}
