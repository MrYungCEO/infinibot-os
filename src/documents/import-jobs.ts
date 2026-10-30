/**
 * Background import jobs for the Documents workspace (Notion API + Notion
 * export ZIP).
 *
 * A full Notion import walks hundreds–thousands of pages at Notion's ~3 req/s
 * limit, which takes minutes — far longer than one request/response RPC can
 * stay open (the control UI gives up after 60s). So `documents.notion.import`
 * only creates a job and returns its id; the job runs here, server-side:
 *
 *   - persisted as JSON under <shared state>/documents-import-jobs/<id>.json
 *     (shared dir so boot can find every tenant's jobs; each record carries
 *     its tenant scope and store root),
 *   - resumed after a gateway restart — the importers are idempotent by
 *     Notion id and the API importer skips pages this job already wrote
 *     (`source.syncRun === job.id`), so a resume redoes almost nothing,
 *   - paced by the Notion client (adaptive spacing + Retry-After backoff),
 *   - cancellable (partial results are kept),
 *   - reported live over the `documents.import.progress` event, plus the
 *     usual `notes:changed` (documents) event so the tree refreshes as pages land.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getScopedUserId,
  resolveSharedDir,
  resolveStateDir,
  runWithUserId,
} from "../config/paths.js";
import type { NotionClient, NotionClientOptions, NotionSyncMode } from "./notion/api-import.js";
import {
  emptyReport,
  errorMessage,
  isCancelled,
  type NotionImportProgress,
  type NotionImportReport,
} from "./notion/shared.js";
import {
  emptyJournal,
  ImportLedger,
  journalSize,
  journalStore,
  undoJournal,
  type ImportJournal,
  type UndoResult,
} from "./import-journal.js";
import type { FieldMap, MappingDeps, MappingReport, MappingRole } from "./import-mapping.js";
import type { ObsidianImportReport } from "./obsidian/import.js";
import { DocumentStore } from "./store.js";
import { vaultKeyFor } from "./obsidian/import.js";
import { documentsLimits, documentsQuotaRemaining, isSaasDocuments } from "./tenant-limits.js";

export type ImportJobKind = "notion" | "notion-zip" | "obsidian" | "map";

export interface ObsidianJobSpec {
  source: "folder" | "zip" | "git";
  /** Folder path / git URL / zip file name (the folder path and URL are never shown to other tenants). */
  origin: string;
  vaultKey: string;
  vaultName: string;
  /** Turn `- [ ]` tasks into kanban tasks (in project `tasksProject`). */
  createTasks: boolean;
  tasksProject?: string;
}

export interface MapJobSpec {
  folderId: string;
  role: MappingRole;
  fieldMap?: FieldMap;
  defaultProjectId?: string;
}
export type ImportJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface ImportJobProgress {
  phase: string;
  done: number;
  total: number;
  current: string | null;
  /** Set while the Notion client is backing off after a 429. */
  rateLimitedUntil: string | null;
  requests: number;
  rateLimited: number;
}

export interface ImportJobRecord {
  id: string;
  kind: ImportJobKind;
  status: ImportJobStatus;
  mode: NotionSyncMode;
  force: boolean;
  ids: string[];
  parentId: string | null;
  /** Human label (picked titles / zip name). */
  label: string;
  tokenSource: "saved" | "inline";
  /** Tenant namespace the job was started in (null = local / ambient). */
  scope: string | null;
  /** Documents store root captured at creation (per user). */
  storeRoot: string;
  zipFile?: string;
  zipBytes?: number;
  obsidian?: ObsidianJobSpec;
  map?: MapJobSpec;
  /** Obsidian extras (notes/links/tasks counts) and mapping results. */
  details?: Record<string, unknown>;
  /** Number of journaled changes this batch can undo (0 = nothing to undo). */
  undoable?: number;
  undoneAt?: string;
  undoReport?: UndoResult;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Times this job has been started (1 = first run; >1 = resumed after a restart). */
  attempts: number;
  cancelRequested?: boolean;
  owner?: { pid: number; heartbeatAt: string };
  progress: ImportJobProgress;
  report: NotionImportReport;
  errorCount: number;
  error?: string;
}

/** What RPC callers / the UI see (no store paths or owner bookkeeping). */
export type ImportJobView = Omit<ImportJobRecord, "storeRoot" | "zipFile" | "owner" | "scope">;

export const IMPORT_PROGRESS_EVENT = "documents.import.progress";
const TERMINAL: ReadonlySet<ImportJobStatus> = new Set(["done", "failed", "cancelled"]);
const MAX_ATTEMPTS = 6;
const MAX_ERRORS_KEPT = 500;
const HEARTBEAT_MS = 15_000;
const STALE_OWNER_MS = 90_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_FINISHED_KEPT = 50;
const MAX_RUNNING_GLOBAL = 2;

export interface StartNotionJobParams {
  ids: string[];
  parentId: string | null;
  mode?: NotionSyncMode;
  force?: boolean;
  /** Inline integration token: kept in memory only (never written to disk). */
  token?: string;
  label?: string;
}

export interface ImportJobDeps {
  dir: string;
  resolveApiKey: () => string | null | Promise<string | null>;
  createClient: (opts: NotionClientOptions) => NotionClient;
  broadcast: (event: string, payload: unknown) => void;
  /** Tree refresh for open Documents tabs. */
  documentsChanged: (rootIds: string[]) => void;
  storeAt?: (root: string) => DocumentStore;
  /** Client options for tests (fake fetch, no pacing). */
  clientOptions?: Partial<NotionClientOptions>;
  /** Kanban/clients adapters for mapping + vault tasks (stateDir = the job's state dir). */
  mappingDeps?: (stateDir: string) => Promise<MappingDeps>;
  /** git clone override (tests). */
  gitClone?: import("./obsidian/vault-source.js").GitCloneFn;
  /** Attachment text extraction (tests pass null to skip). */
  extractAttachment?:
    | import("./obsidian/import.js").ObsidianImportOptions["extractAttachment"]
    | null;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
  progressThrottleMs?: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyProgress(): ImportJobProgress {
  return {
    phase: "queued",
    done: 0,
    total: 0,
    current: null,
    rateLimitedUntil: null,
    requests: 0,
    rateLimited: 0,
  };
}

export function toJobView(rec: ImportJobRecord): ImportJobView {
  const { storeRoot: _storeRoot, zipFile: _zipFile, owner: _owner, scope: _scope, ...view } = rec;
  return {
    ...view,
    // Local folder paths stay server-side; the vault name is enough for the UI.
    ...(rec.obsidian
      ? {
          obsidian: {
            ...rec.obsidian,
            origin: rec.obsidian.source === "folder" ? rec.obsidian.vaultName : rec.obsidian.origin,
          },
        }
      : {}),
    progress: { ...rec.progress },
    report: { ...rec.report, errors: rec.report.errors.slice(-MAX_ERRORS_KEPT) },
  };
}

export class ImportJobManager {
  private readonly jobs = new Map<string, ImportJobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly inlineTokens = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly finished = new Map<string, Array<() => void>>();
  private loaded = false;
  private readonly pid: number;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(private readonly deps: ImportJobDeps) {
    this.pid = deps.pid ?? process.pid;
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  }

  // ── Persistence ────────────────────────────────────────────

  private file(id: string): string {
    return path.join(this.deps.dir, `${id}.json`);
  }

  private persist(rec: ImportJobRecord): void {
    rec.updatedAt = nowIso();
    rec.errorCount = rec.report.errors.length;
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const out: ImportJobRecord = {
      ...rec,
      report: { ...rec.report, errors: rec.report.errors.slice(-MAX_ERRORS_KEPT) },
    };
    const tmp = `${this.file(rec.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file(rec.id));
  }

  /** Load job records from disk (once). */
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.deps.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.deps.dir, name), "utf-8"),
        ) as ImportJobRecord;
        if (rec?.id && !this.jobs.has(rec.id)) {
          rec.report ??= emptyReport();
          rec.progress ??= emptyProgress();
          this.jobs.set(rec.id, rec);
        }
      } catch {
        /* corrupt record — ignore */
      }
    }
  }

  /**
   * Pick up records written by other processes (onboarding CLI, standalone
   * setup page) since the first load, and refresh unfinished ones this
   * process isn't running.
   */
  private rescan(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.deps.dir).filter((n) => /^imp_[a-z0-9_]+\.json$/i.test(n));
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.slice(0, -5);
      const known = this.jobs.get(id);
      if (known && (TERMINAL.has(known.status) || this.running.has(id))) continue;
      try {
        const rec = JSON.parse(
          fs.readFileSync(path.join(this.deps.dir, name), "utf-8"),
        ) as ImportJobRecord;
        if (!rec?.id) continue;
        rec.report ??= emptyReport();
        rec.progress ??= emptyProgress();
        this.jobs.set(rec.id, rec);
      } catch {
        /* partially written / corrupt — next sweep */
      }
    }
  }

  private scopeOf(): string | null {
    return getScopedUserId() ?? null;
  }

  private visible(rec: ImportJobRecord, scope: string | null): boolean {
    return (rec.scope ?? null) === scope;
  }

  // ── Public API ─────────────────────────────────────────────

  /** Start (or reattach to an identical active) Notion API import job. */
  startNotion(p: StartNotionJobParams): { job: ImportJobView; reattached: boolean } {
    this.load();
    const scope = this.scopeOf();
    const ids = [...new Set(p.ids)];
    const mode: NotionSyncMode = p.mode ?? "full";
    const key = JSON.stringify([[...ids].sort(), p.parentId, mode, p.force === true]);
    for (const rec of this.jobs.values()) {
      if (
        rec.kind === "notion" &&
        !TERMINAL.has(rec.status) &&
        !rec.cancelRequested &&
        this.visible(rec, scope) &&
        JSON.stringify([[...rec.ids].sort(), rec.parentId, rec.mode, rec.force]) === key
      ) {
        if (p.token) this.inlineTokens.set(rec.id, p.token);
        return { job: toJobView(rec), reattached: true };
      }
    }
    const rec = this.newRecord({
      kind: "notion",
      mode,
      force: p.force === true,
      ids,
      parentId: p.parentId,
      label: p.label?.trim() || `${ids.length} Notion item${ids.length === 1 ? "" : "s"}`,
      tokenSource: p.token ? "inline" : "saved",
      scope,
    });
    if (p.token) this.inlineTokens.set(rec.id, p.token);
    this.persist(rec);
    this.emit(rec, true);
    this.pump();
    return { job: toJobView(rec), reattached: false };
  }

  /** Start a Notion export ZIP import job (the archive is kept until the job finishes). */
  startZip(p: { data: Buffer; name: string; parentId: string | null }): ImportJobView {
    this.load();
    const rec = this.newRecord({
      kind: "notion-zip",
      mode: "full",
      force: false,
      ids: [],
      parentId: p.parentId,
      label: p.name || "Notion export.zip",
      tokenSource: "saved",
      scope: this.scopeOf(),
    });
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    rec.zipFile = path.join(this.deps.dir, `${rec.id}.zip`);
    rec.zipBytes = p.data.length;
    fs.writeFileSync(rec.zipFile, p.data, { mode: 0o600 });
    this.persist(rec);
    this.emit(rec, true);
    this.pump();
    return toJobView(rec);
  }

  /** Start an Obsidian vault import (folder path, uploaded ZIP, or git URL). */
  startObsidian(p: {
    source: "folder" | "zip" | "git";
    origin: string;
    data?: Buffer;
    vaultName?: string;
    parentId: string | null;
    createTasks?: boolean;
    tasksProject?: string;
    force?: boolean;
  }): { job: ImportJobView; reattached: boolean } {
    this.load();
    const scope = this.scopeOf();
    const origin = p.origin.trim();
    const vaultName =
      p.vaultName?.trim() ||
      (p.source === "git"
        ? (origin
            .replace(/\.git$/i, "")
            .split("/")
            .pop() ?? "Obsidian vault")
        : path.basename(origin).replace(/\.zip$/i, "") || "Obsidian vault");
    // Folder/git vaults are keyed by origin; a ZIP by the vault name (re-uploading
    // a newer export of the same vault re-syncs instead of duplicating).
    const vaultKey = vaultKeyFor(p.source === "zip" ? `zip:${vaultName}` : `${p.source}:${origin}`);
    if (p.source !== "zip") {
      for (const rec of this.jobs.values()) {
        if (
          rec.kind === "obsidian" &&
          !TERMINAL.has(rec.status) &&
          !rec.cancelRequested &&
          this.visible(rec, scope) &&
          rec.obsidian?.vaultKey === vaultKey
        ) {
          return { job: toJobView(rec), reattached: true };
        }
      }
    }
    const rec = this.newRecord({
      kind: "obsidian",
      mode: "full",
      force: p.force === true,
      ids: [],
      parentId: p.parentId,
      label: vaultName,
      tokenSource: "saved",
      scope,
    });
    rec.obsidian = {
      source: p.source,
      origin: p.source === "zip" ? vaultName : origin,
      vaultKey,
      vaultName,
      createTasks: p.createTasks === true,
      tasksProject: p.tasksProject?.trim() || `${vaultName} tasks`,
    };
    if (p.source === "zip") {
      if (!p.data) throw new Error("ZIP data required");
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      rec.zipFile = path.join(this.deps.dir, `${rec.id}.zip`);
      rec.zipBytes = p.data.length;
      fs.writeFileSync(rec.zipFile, p.data, { mode: 0o600 });
    }
    this.persist(rec);
    this.emit(rec, true);
    this.pump();
    return { job: toJobView(rec), reattached: false };
  }

  /**
   * Map an imported collection (Notion database / Obsidian folder) onto
   * projects, tasks or clients. Runs inline (local writes only) and is
   * recorded as a "map" job so it shows in the import history and can be undone.
   */
  async runMapping(spec: MapJobSpec): Promise<ImportJobView> {
    this.load();
    const rec = this.newRecord({
      kind: "map",
      mode: "full",
      force: false,
      ids: [],
      parentId: spec.folderId,
      label: `Map → ${spec.role}`,
      tokenSource: "saved",
      scope: this.scopeOf(),
    });
    rec.map = spec;
    rec.status = "running";
    rec.attempts = 1;
    rec.startedAt = nowIso();
    rec.progress = { ...emptyProgress(), phase: "map" };
    this.persist(rec);
    const journal = emptyJournal();
    try {
      const store = this.storeFor(rec);
      const folder = store.getNode(spec.folderId);
      if (folder) rec.label = `${folder.title} → ${spec.role}`;
      const { applyMapping } = await import("./import-mapping.js");
      const deps = await this.mappingDepsFor(rec);
      const report: MappingReport = await applyMapping(
        store,
        spec,
        deps,
        journal,
        ImportLedger.forStore(store),
      );
      rec.details = { mapping: report };
      rec.report = {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        skipped: 0,
        errors: report.errors,
        rootNodeIds: [],
      };
      rec.progress.done = rec.progress.total = report.created + report.updated + report.unchanged;
      this.finish(rec, "done");
    } catch (err) {
      rec.error = errorMessage(err);
      this.finish(rec, "failed");
    } finally {
      this.saveJournal(rec, journal);
      this.persist(rec);
      this.emit(rec, true);
    }
    return toJobView(rec);
  }

  /** Reverse everything a finished import/mapping batch wrote. */
  async undo(id: string): Promise<ImportJobView | null> {
    this.load();
    const rec = this.jobs.get(id);
    if (!rec || !this.visible(rec, this.scopeOf())) return null;
    if (!TERMINAL.has(rec.status)) throw new Error("Cancel the import before undoing it");
    if (rec.undoneAt) throw new Error("This import was already undone");
    const journal = this.readJournal(rec.id);
    if (!journal || !journalSize(journal)) throw new Error("Nothing to undo for this import");
    const store = this.storeFor(rec);
    const deps =
      journal.entitiesCreated.length || journal.entitiesUpdated.length
        ? await this.mappingDepsFor(rec)
        : null;
    const { undoDepsFor } = await import("./import-mapping.js");
    const result = await undoJournal(store, journal, deps ? undoDepsFor(deps) : undefined);
    if (deps) {
      const ledger = ImportLedger.forStore(store);
      for (const e of journal.entitiesCreated) ledger.deleteById(e.role, e.id);
      ledger.save();
    }
    rec.undoneAt = journal.undoneAt ?? nowIso();
    rec.undoReport = result;
    rec.undoable = 0;
    this.writeJournal(rec.id, journal);
    this.persist(rec);
    this.emit(rec, true);
    this.deps.documentsChanged(rec.report.rootNodeIds.length ? rec.report.rootNodeIds : []);
    return toJobView(rec);
  }

  get(id: string): ImportJobView | null {
    this.load();
    const rec = this.jobs.get(id);
    return rec && this.visible(rec, this.scopeOf()) ? toJobView(rec) : null;
  }

  list(opts: { active?: boolean; limit?: number } = {}): ImportJobView[] {
    this.load();
    this.rescan();
    const scope = this.scopeOf();
    return [...this.jobs.values()]
      .filter((r) => this.visible(r, scope) && (!opts.active || !TERMINAL.has(r.status)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(opts.limit ?? 20, 100)))
      .map(toJobView);
  }

  cancel(id: string): ImportJobView | null {
    this.load();
    const rec = this.jobs.get(id);
    if (!rec || !this.visible(rec, this.scopeOf())) return null;
    if (TERMINAL.has(rec.status)) return toJobView(rec);
    rec.cancelRequested = true;
    const ctl = this.controllers.get(id);
    if (ctl) {
      ctl.abort();
    } else {
      // Queued (or orphaned) — nothing is running it here, finish it now.
      this.finish(rec, "cancelled");
    }
    this.persist(rec);
    this.emit(rec, true);
    return toJobView(rec);
  }

  /** Resolves when the job reaches a terminal state (or after `timeoutMs`). */
  async wait(id: string, timeoutMs: number): Promise<ImportJobView | null> {
    const rec = this.jobs.get(id);
    if (!rec) return null;
    if (!TERMINAL.has(rec.status) && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        const list = this.finished.get(id) ?? [];
        list.push(() => {
          clearTimeout(t);
          resolve();
        });
        this.finished.set(id, list);
      });
    }
    return toJobView(rec);
  }

  /**
   * Boot: pick up jobs that were queued/running when the previous gateway
   * process stopped, and prune old finished jobs.
   */
  resumeAll(): { resumed: string[]; failed: string[] } {
    this.load();
    this.rescan();
    const resumed: string[] = [];
    const failed: string[] = [];
    for (const rec of this.jobs.values()) {
      if (TERMINAL.has(rec.status) || this.running.has(rec.id)) continue;
      if (rec.owner && rec.owner.pid !== this.pid && this.isPidAlive(rec.owner.pid)) {
        const beat = Date.parse(rec.owner.heartbeatAt);
        if (Number.isFinite(beat) && Date.now() - beat < STALE_OWNER_MS) continue; // another live gateway owns it
      }
      if (rec.cancelRequested) {
        this.finish(rec, "cancelled");
        this.persist(rec);
        continue;
      }
      if (rec.attempts >= MAX_ATTEMPTS) {
        rec.error = `Gave up after ${rec.attempts} interrupted attempts`;
        this.finish(rec, "failed");
        this.persist(rec);
        failed.push(rec.id);
        continue;
      }
      rec.status = "queued";
      rec.owner = undefined;
      rec.progress = { ...rec.progress, phase: "queued", rateLimitedUntil: null };
      this.persist(rec);
      resumed.push(rec.id);
    }
    this.prune();
    this.pump();
    return { resumed, failed };
  }

  // ── Internals ──────────────────────────────────────────────

  private journalFile(id: string): string {
    return path.join(this.deps.dir, `${id}.journal.json`);
  }

  private readJournal(id: string): ImportJournal | null {
    try {
      return JSON.parse(fs.readFileSync(this.journalFile(id), "utf-8")) as ImportJournal;
    } catch {
      return null;
    }
  }

  private writeJournal(id: string, journal: ImportJournal): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.journalFile(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(journal), { mode: 0o600 });
    fs.renameSync(tmp, this.journalFile(id));
  }

  private saveJournal(rec: ImportJobRecord, journal: ImportJournal): void {
    rec.undoable = journalSize(journal);
    if (rec.undoable) this.writeJournal(rec.id, journal);
  }

  private storeFor(rec: ImportJobRecord): DocumentStore {
    return this.deps.storeAt ? this.deps.storeAt(rec.storeRoot) : DocumentStore.at(rec.storeRoot);
  }

  private async mappingDepsFor(rec: ImportJobRecord): Promise<MappingDeps> {
    const stateDir = path.dirname(rec.storeRoot);
    if (this.deps.mappingDeps) return this.deps.mappingDeps(stateDir);
    const { defaultMappingDeps } = await import("./import-mapping.js");
    return defaultMappingDeps(stateDir);
  }

  private newRecord(
    p: Pick<
      ImportJobRecord,
      "kind" | "mode" | "force" | "ids" | "parentId" | "label" | "tokenSource" | "scope"
    >,
  ): ImportJobRecord {
    const at = nowIso();
    const rec: ImportJobRecord = {
      ...p,
      id: `imp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      status: "queued",
      storeRoot: path.join(resolveStateDir(), "documents"),
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      progress: emptyProgress(),
      report: emptyReport(),
      errorCount: 0,
    };
    this.jobs.set(rec.id, rec);
    return rec;
  }

  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((r) => TERMINAL.has(r.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    finished.forEach((r, i) => {
      const old = Date.now() - Date.parse(r.finishedAt ?? r.updatedAt) > RETENTION_MS;
      if (!old && i < MAX_FINISHED_KEPT) return;
      this.jobs.delete(r.id);
      fs.rmSync(this.file(r.id), { force: true });
      fs.rmSync(this.journalFile(r.id), { force: true });
      if (r.zipFile) fs.rmSync(r.zipFile, { force: true });
    });
  }

  private pump(): void {
    const queue = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const rec of queue) {
      if (this.running.size >= MAX_RUNNING_GLOBAL) return;
      if (rec.status !== "queued" || this.running.has(rec.id)) continue;
      // One job at a time per tenant: they share the integration's rate limit.
      const busy = [...this.running].some(
        (id) => (this.jobs.get(id)?.scope ?? null) === (rec.scope ?? null),
      );
      if (busy) continue;
      this.running.add(rec.id);
      void runWithUserId(rec.scope ?? undefined, () => this.run(rec)).finally(() => {
        this.running.delete(rec.id);
        this.pump();
      });
    }
  }

  private finish(rec: ImportJobRecord, status: ImportJobStatus): void {
    rec.status = status;
    rec.finishedAt = nowIso();
    rec.owner = undefined;
    rec.progress = { ...rec.progress, phase: status, current: null, rateLimitedUntil: null };
    this.inlineTokens.delete(rec.id);
    if (rec.zipFile) {
      fs.rmSync(rec.zipFile, { force: true });
      rec.zipFile = undefined;
    }
    for (const fn of this.finished.get(rec.id) ?? []) fn();
    this.finished.delete(rec.id);
  }

  private async runObsidian(
    rec: ImportJobRecord,
    store: DocumentStore,
    journal: ImportJournal,
    signal: AbortSignal,
    onProgress: (p: NotionImportProgress) => void,
    onWrite: (id: string) => void,
  ): Promise<void> {
    const spec = rec.obsidian;
    if (!spec) throw new Error("Obsidian job has no source");
    const src = await import("./obsidian/vault-source.js");
    const remaining = documentsQuotaRemaining(store.root);
    const limits = Number.isFinite(remaining)
      ? { maxTotalBytes: Math.min(500 * 1024 * 1024, remaining) }
      : {};
    let cleanup: (() => void) | null = null;
    try {
      let files;
      if (spec.source === "zip") {
        if (!rec.zipFile || !fs.existsSync(rec.zipFile)) {
          throw new Error("The uploaded ZIP is no longer available — upload it again");
        }
        files = await src.listZipVault(fs.readFileSync(rec.zipFile), limits);
      } else if (spec.source === "folder") {
        if (isSaasDocuments())
          throw new Error(
            "Importing a local folder isn't available on hosted plans — upload a ZIP",
          );
        files = src.listFolderVault(spec.origin, limits);
      } else {
        if (isSaasDocuments())
          throw new Error("Importing from git isn't available on hosted plans — upload a ZIP");
        onProgress({ phase: "discover", done: 0, title: "Cloning…" });
        const cloned = await src.cloneGitVault(spec.origin, { signal, clone: this.deps.gitClone });
        cleanup = cloned.cleanup;
        files = src.listFolderVault(cloned.dir, limits);
      }
      const { importObsidianVault } = await import("./obsidian/import.js");
      const report: ObsidianImportReport = await importObsidianVault(store, files, {
        vaultKey: spec.vaultKey,
        vaultName: spec.vaultName,
        parentId: rec.parentId,
        force: rec.force,
        signal,
        syncRun: rec.id,
        extractAttachment:
          this.deps.extractAttachment === null
            ? undefined
            : (this.deps.extractAttachment ?? extractAttachmentText),
        onProgress: (p) =>
          onProgress({
            phase: p.phase === "discover" ? "discover" : "write",
            done: p.done,
            total: p.total,
            title: p.title,
          }),
        onWrite,
      });
      const { tasks, ...rest } = report;
      rec.report = {
        created: report.created,
        updated: report.updated,
        unchanged: report.unchanged,
        skipped: report.skipped,
        errors: report.errors,
        rootNodeIds: report.rootNodeIds,
        links: report.links,
        summary: report.summary,
      };
      const details: Record<string, unknown> = {
        notes: rest.notes,
        folders: rest.folders,
        attachments: rest.attachments,
        assets: rest.assets,
        links: rest.links,
        dailyNotes: rest.dailyNotes,
        missing: rest.missing,
        tasksFound: tasks.length,
      };
      if (spec.createTasks && tasks.length) {
        rec.progress.phase = "tasks";
        // Notes are already in; a kanban failure is reported, not fatal.
        try {
          const { applyVaultTasks } = await import("./import-mapping.js");
          const deps = await this.mappingDepsFor(rec);
          details.tasks = await applyVaultTasks(
            tasks,
            spec.tasksProject || `${spec.vaultName} tasks`,
            deps,
            journal,
            ImportLedger.forStore(store),
          );
        } catch (err) {
          details.tasksError = errorMessage(err);
          rec.report.errors.push({ id: "tasks", title: "Kanban tasks", error: errorMessage(err) });
        }
      }
      rec.details = details;
    } finally {
      cleanup?.();
    }
  }

  private lastEmit = new Map<string, number>();

  private emit(rec: ImportJobRecord, force = false): void {
    const now = Date.now();
    const last = this.lastEmit.get(rec.id) ?? 0;
    if (!force && now - last < (this.deps.progressThrottleMs ?? 300)) return;
    this.lastEmit.set(rec.id, now);
    rec.errorCount = rec.report.errors.length;
    try {
      this.deps.broadcast(IMPORT_PROGRESS_EVENT, { job: toJobView(rec) });
    } catch {
      /* best-effort UI telemetry */
    }
  }

  private async run(rec: ImportJobRecord): Promise<void> {
    const ctl = new AbortController();
    this.controllers.set(rec.id, ctl);
    rec.status = "running";
    rec.attempts += 1;
    rec.startedAt ??= nowIso();
    rec.error = undefined;
    rec.owner = { pid: this.pid, heartbeatAt: nowIso() };
    rec.progress = { ...emptyProgress(), phase: "starting" };
    this.persist(rec);
    this.emit(rec, true);

    // Resumed jobs keep appending to the journal they started.
    const journal = this.readJournal(rec.id) ?? emptyJournal();
    let lastPersist = Date.now();
    let lastJournal = Date.now();
    let lastTreeRefresh = 0;
    const touched = new Set<string>();
    const heartbeat = setInterval(() => {
      rec.owner = { pid: this.pid, heartbeatAt: nowIso() };
      this.persist(rec);
      this.emit(rec, true);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const checkpoint = () => {
      this.emit(rec);
      if (Date.now() - lastPersist > 2_000) {
        lastPersist = Date.now();
        rec.owner = { pid: this.pid, heartbeatAt: nowIso() };
        this.persist(rec);
      }
      // Keep the undo journal on disk too, so a killed run's writes stay undoable.
      if (Date.now() - lastJournal > 10_000) {
        lastJournal = Date.now();
        try {
          this.saveJournal(rec, journal);
        } catch {
          /* best effort; the final save retries */
        }
      }
    };
    // Hosted tenants: an API import stops after `notionMaxPages` pages (pages
    // already written are kept, like a cancel). Self-hosted: no cap.
    const maxPages = rec.kind === "notion" ? documentsLimits().notionMaxPages : null;
    let overCap: string | undefined;
    const onProgress = (p: NotionImportProgress) => {
      if (maxPages !== null && !overCap && p.phase === "import" && p.done > maxPages) {
        overCap = `Stopped after ${maxPages} pages — the hosted plan limit for one import. Import a smaller page or database (pages already imported are kept).`;
        ctl.abort();
      }
      rec.progress.phase = p.phase;
      rec.progress.done = p.done;
      rec.progress.total = Math.max(p.total ?? 0, p.done);
      rec.progress.current = p.title ?? null;
      if (rec.progress.rateLimitedUntil && Date.parse(rec.progress.rateLimitedUntil) < Date.now()) {
        rec.progress.rateLimitedUntil = null;
      }
      checkpoint();
    };
    const onWrite = (nodeId: string) => {
      touched.add(nodeId);
      if (Date.now() - lastTreeRefresh > 1_500) {
        lastTreeRefresh = Date.now();
        this.deps.documentsChanged([nodeId]);
      }
    };

    try {
      const store = journalStore(this.storeFor(rec), journal);
      if (rec.parentId) {
        const parent = store.getNode(rec.parentId);
        if (!parent || parent.kind !== "folder" || parent.deletedAt) {
          throw new Error(`Target folder no longer exists`);
        }
      }
      if (rec.kind === "notion") {
        const apiKey =
          this.inlineTokens.get(rec.id) ??
          (rec.tokenSource === "saved" ? await this.deps.resolveApiKey() : null);
        if (!apiKey) {
          throw new Error(
            rec.tokenSource === "inline"
              ? "The pasted Notion token isn't stored, so this import can't resume after a restart — start it again (pages already imported are skipped)"
              : "Notion is not connected — add an integration token (Settings → Notion)",
          );
        }
        const { importNotion } = await import("./notion/api-import.js");
        const client: NotionClient = this.deps.createClient({
          apiKey,
          maxRetries: 8,
          ...this.deps.clientOptions,
          signal: ctl.signal,
          onRetry: ({ status, delayMs }) => {
            if (status === 429) {
              rec.progress.rateLimitedUntil = new Date(Date.now() + delayMs).toISOString();
              const s = client.stats?.();
              if (s) {
                rec.progress.requests = s.requests;
                rec.progress.rateLimited = s.rateLimited;
              }
              this.emit(rec, true);
            }
          },
        });
        const statsTimer = setInterval(() => {
          const s = client.stats?.();
          if (s) {
            rec.progress.requests = s.requests;
            rec.progress.rateLimited = s.rateLimited;
          }
        }, 1_000);
        statsTimer.unref?.();
        try {
          await importNotion(store, client, {
            ids: rec.ids,
            parentId: rec.parentId,
            mode: rec.mode,
            force: rec.force,
            syncRun: rec.id,
            report: rec.report,
            signal: ctl.signal,
            onProgress,
            onWrite,
          });
        } finally {
          clearInterval(statsTimer);
          const s = client.stats?.();
          if (s) {
            rec.progress.requests = s.requests;
            rec.progress.rateLimited = s.rateLimited;
          }
        }
      } else if (rec.kind === "obsidian") {
        await this.runObsidian(rec, store, journal, ctl.signal, onProgress, onWrite);
      } else {
        if (!rec.zipFile || !fs.existsSync(rec.zipFile)) {
          throw new Error("The uploaded ZIP is no longer available — upload it again");
        }
        const { importNotionZip } = await import("./notion/zip-import.js");
        // SaaS: the export may inflate to at most the workspace's remaining quota.
        const remaining = documentsQuotaRemaining(store.root);
        const report = await importNotionZip(store, fs.readFileSync(rec.zipFile), {
          parentId: rec.parentId,
          ...(Number.isFinite(remaining)
            ? { maxTotalBytes: Math.min(500 * 1024 * 1024, remaining) }
            : {}),
          signal: ctl.signal,
          onProgress,
          onWrite,
        });
        rec.report = report;
      }
      this.finish(rec, "done");
    } catch (err) {
      if (overCap) {
        rec.error = overCap;
        this.finish(rec, "failed");
      } else if (isCancelled(err) || ctl.signal.aborted) {
        this.finish(rec, "cancelled");
      } else {
        rec.error = errorMessage(err);
        this.finish(rec, "failed");
      }
    } finally {
      clearInterval(heartbeat);
      this.controllers.delete(rec.id);
      this.saveJournal(rec, journal);
      this.persist(rec);
      this.emit(rec, true);
      if (touched.size || rec.report.rootNodeIds.length) {
        this.deps.documentsChanged(
          rec.report.rootNodeIds.length ? rec.report.rootNodeIds : [...touched],
        );
      }
    }
  }
}

// ── Obsidian runner ──────────────────────────────────────────

export async function extractAttachmentText(
  name: string,
  data: Buffer,
): Promise<{
  mime: string;
  markdown: string | null;
  status: "ok" | "none" | "error";
  error?: string;
} | null> {
  try {
    const { validateUpload, extractText } = await import("./extract.js");
    const v = await validateUpload(name, data);
    const r = await extractText(v, data);
    return { mime: v.mime, markdown: r.markdown, status: r.status, error: r.error };
  } catch {
    return null;
  }
}

// ── Process singleton ────────────────────────────────────────

let manager: ImportJobManager | null = null;

/** The gateway's import job manager (lazily wired to the real Notion client + broadcaster). */
export async function importJobs(): Promise<ImportJobManager> {
  if (manager) return manager;
  const [{ createNotionClient }, { getNotionApiKeyForImport }, events] = await Promise.all([
    import("./notion/api-import.js"),
    import("../databases/notion-config.js"),
    import("../notes/notes-events.js"),
  ]);
  manager ??= new ImportJobManager({
    dir: path.join(resolveSharedDir(), "documents-import-jobs"),
    // SaaS: only the tenant's own token — never an operator NOTION_API_KEY env.
    resolveApiKey: () => {
      const key = getNotionApiKeyForImport();
      return isSaasDocuments() && key && key === process.env.NOTION_API_KEY?.trim() ? null : key;
    },
    createClient: createNotionClient,
    broadcast: (event, payload) => events.broadcastDocumentsEvent(event, payload),
    documentsChanged: (rootIds) =>
      events.broadcastDocumentsChanged({ op: "import", id: rootIds[0] }),
  });
  return manager;
}

/** Gateway boot hook: resume jobs interrupted by the previous process. */
export async function resumeImportJobs(): Promise<{ resumed: string[]; failed: string[] }> {
  const m = await importJobs();
  // Jobs can also be started by another process (`infinibot onboard`, the
  // standalone setup page) that exits before they finish. Re-check for
  // orphaned jobs (dead or silent owner) every couple of minutes.
  orphanSweep ??= setInterval(() => {
    try {
      m.resumeAll();
    } catch {
      /* best effort */
    }
  }, 120_000);
  orphanSweep.unref?.();
  return m.resumeAll();
}

let orphanSweep: ReturnType<typeof setInterval> | null = null;

/** Test hook. */
export function setImportJobManagerForTest(m: ImportJobManager | null): void {
  manager = m;
}
