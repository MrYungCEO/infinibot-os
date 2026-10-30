/**
 * Notion ↔ local conflict queue.
 *
 * The bidirectional poller consults each binding's `conflictPolicy`. When
 * it's `"queue"`, simultaneous edits on both sides are NOT silently
 * resolved by last-write-wins — instead a conflict record lands here and
 * the operator picks a winner field-by-field via the conflict UI.
 *
 * Why JSON rather than SQLite: the volume is low (hundreds, not millions),
 * the records are short-lived (resolve and remove), and we want this
 * module loadable from contexts that don't have the kanban DB available
 * (e.g. the standalone setup-ui server).
 *
 * Stable ids let the UI reference a conflict across browser reloads:
 *   id = `${notionDbId}:${notionPageId}:${localUpdatedAt}-${remoteUpdatedAt}`
 *
 * Resolution writes the chosen value through to whichever side lost so
 * the next poll cycle sees both sides aligned and skips re-queueing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("notion-conflicts");

/** One side of a per-field disagreement. */
export interface ConflictFieldSide {
  /** The value as it appears on this side (always serialized JSON-friendly). */
  value: unknown;
  /** Notion property type / canonical type — used by the UI to render. */
  type: string;
  /** ISO timestamp of when this side last changed. */
  updatedAt: string;
}

export interface ConflictField {
  /** Canonical InfiniBot field name (e.g. "Status", "Priority Level"). */
  field: string;
  /** Notion property name on the binding (so the UI can show "in Notion as X"). */
  notionProperty: string;
  local: ConflictFieldSide;
  remote: ConflictFieldSide;
}

export interface NotionConflict {
  id: string;
  notionDbId: string;
  notionPageId: string;
  /** Role of the binding the conflict came from (projects, tasks, custom, …). */
  role: string;
  /** Display title at conflict-detection time, for UI listing. */
  title: string;
  /** When the poller noticed the conflict. */
  detectedAt: number;
  fields: ConflictField[];
  /** Set when an operator picks a side or merges. Pending = still in queue. */
  status: "pending" | "resolved-local" | "resolved-remote" | "resolved-merged";
  /** When status flipped from pending → resolved. */
  resolvedAt: number | null;
}

interface ConflictsFile {
  conflicts: NotionConflict[];
}

function getStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? "state";
}

function getStatePath(): string {
  return join(getStateDir(), "notion-conflicts.json");
}

function loadFile(): ConflictsFile {
  const p = getStatePath();
  if (!existsSync(p)) return { conflicts: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ConflictsFile>;
    return { conflicts: Array.isArray(raw.conflicts) ? raw.conflicts : [] };
  } catch (err) {
    log.warn("conflict file unreadable, starting empty", { err: String(err) });
    return { conflicts: [] };
  }
}

function saveFile(file: ConflictsFile): void {
  const p = getStatePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2));
}

/**
 * Add or replace a conflict for the given (db, page) pair. If a pending
 * conflict already exists for that pair, its fields are merged — the
 * newer value on each side wins so the UI always sees the latest state.
 * Already-resolved conflicts for the same pair are left alone (they're
 * an audit trail).
 */
export function enqueueConflict(input: {
  notionDbId: string;
  notionPageId: string;
  role: string;
  title: string;
  fields: ConflictField[];
}): NotionConflict {
  const file = loadFile();
  const now = Date.now();
  const existing = file.conflicts.find(
    (c) =>
      c.status === "pending" &&
      c.notionPageId === input.notionPageId &&
      c.notionDbId === input.notionDbId,
  );
  if (existing) {
    const byField = new Map(existing.fields.map((f) => [f.field, f]));
    for (const f of input.fields) byField.set(f.field, f);
    existing.fields = Array.from(byField.values());
    existing.title = input.title || existing.title;
    saveFile(file);
    return existing;
  }
  const conflict: NotionConflict = {
    id: `${input.notionDbId}:${input.notionPageId}:${now}`,
    notionDbId: input.notionDbId,
    notionPageId: input.notionPageId,
    role: input.role,
    title: input.title,
    detectedAt: now,
    fields: input.fields,
    status: "pending",
    resolvedAt: null,
  };
  file.conflicts.push(conflict);
  saveFile(file);
  log.info("conflict queued", { id: conflict.id, fields: conflict.fields.length });
  return conflict;
}

export interface ListOptions {
  status?: NotionConflict["status"] | "any";
  notionDbId?: string;
  limit?: number;
}

export function listConflicts(opts: ListOptions = {}): NotionConflict[] {
  const file = loadFile();
  let out = file.conflicts;
  const status = opts.status ?? "pending";
  if (status !== "any") out = out.filter((c) => c.status === status);
  if (opts.notionDbId) out = out.filter((c) => c.notionDbId === opts.notionDbId);
  out = [...out].sort((a, b) => b.detectedAt - a.detectedAt);
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

export function getConflict(id: string): NotionConflict | null {
  const file = loadFile();
  return file.conflicts.find((c) => c.id === id) ?? null;
}

/**
 * Mark a conflict resolved. The actual local/remote write the operator
 * chose has already happened in the caller (so this module never has to
 * import the kanban store or the Notion HTTP layer); this just records the
 * resolution for the audit trail and removes the record from the
 * pending list.
 */
export function markResolved(
  id: string,
  status: Exclude<NotionConflict["status"], "pending">,
): NotionConflict | null {
  const file = loadFile();
  const c = file.conflicts.find((c) => c.id === id);
  if (!c) return null;
  c.status = status;
  c.resolvedAt = Date.now();
  saveFile(file);
  return c;
}

/** Drop resolved conflicts older than `olderThanMs`. Cheap audit-trail GC. */
export function purgeResolved(olderThanMs: number): number {
  const file = loadFile();
  const cutoff = Date.now() - olderThanMs;
  const before = file.conflicts.length;
  file.conflicts = file.conflicts.filter(
    (c) => c.status === "pending" || (c.resolvedAt ?? 0) > cutoff,
  );
  const removed = before - file.conflicts.length;
  if (removed > 0) {
    saveFile(file);
    log.info("conflict purge", { removed });
  }
  return removed;
}

/** Convenience: count pending conflicts for the UI badge. */
export function pendingCount(): number {
  return loadFile().conflicts.filter((c) => c.status === "pending").length;
}
