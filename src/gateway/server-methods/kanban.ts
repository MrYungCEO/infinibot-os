/**
 * Kanban Gateway Handlers — Notion-backed with local SQLite for autonomous fields
 *
 * These handlers query Notion directly (same databases as the UI),
 * ensuring MCP tool calls and UI show identical data.
 *
 * Local-only fields (autonomous, autonomousStatus) are stored in SQLite.
 */

import {
  type HqProgressOrigin,
  parseHqProgressOrigin,
  recordHqProgress,
  unrecordHqProgress,
} from "../../hq-progress/store.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin, extname as pathExtname } from "node:path";
import { createHash } from "node:crypto";
import { GatewayRequestHandlers } from "./types.js";
import { sanitizeNotionPageWrite } from "../../databases/notion-option-map.js";
import {
  getConnectedSatellite,
  proxyMethodsToMaster,
  proxyToMaster,
} from "../../federation/satellite-context.js";
import { getKanbanStore, type ProjectMetaPatch, type GitHubSyncStatus } from "../../tasks/store.js";
import {
  broadcastKanbanChanged,
  broadcastKanbanTaskUpdated,
  getKanbanWriteLedger,
  noteKanbanTaskDeleted,
  noteKanbanTaskWrite,
  setKanbanCacheInvalidator,
} from "../../tasks/kanban-events.js";
import { createLedgerPusher } from "../../tasks/kanban-write-ledger.js";
import { resolveStateDir } from "../../config/paths.js";
import { type Block, blocksToMarkdown, markdownToBlocks } from "../../content/blocks-markdown.js";
import {
  getNotionApiKeyOrNull,
  getNotionConfig,
  resolveNotionDbId,
} from "../../databases/notion-config.js";
import {
  deleteProject as localDeleteProject,
  deleteTask as localDeleteTask,
  listProjects as localListProjects,
  listTasks as localListTasks,
  listNotionPendingProjects,
  listNotionPendingTasks,
  getNotionSyncHealth,
  retryNotionDeadLetters,
  resolveKanbanDatabase,
  resolveKanbanId,
  isNotionCircuitOpen,
  tripNotionCircuit,
  upsertProject as localUpsertProject,
  upsertTask as localUpsertTask,
} from "../../databases/kanban-store-ops.js";
import { fetchPageBodyAsMarkdown } from "../../databases/kanban-adapter.js";
import { ensureProjectDirectoryLink } from "../../databases/project-directory-link.js";
import { getAgencyOperationsStore } from "../../agency-operations/store.js";
import { DEFAULT_AGENCY_ID } from "../../agency-operations/types.js";
import { createListCache } from "./kanban-list-cache.js";

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_REQUEST_TIMEOUT_MS = 10_000;

// ── GitHub helpers ────────────────────────────────────────────────────────

/** Parse "https://github.com/owner/repo" or "owner/repo" → { owner, name }. */
function parseGitHubRepo(url: string): { owner: string; name: string } | null {
  if (!url) return null;
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, name: httpsMatch[2]! };
  }
  const slugMatch = url.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (slugMatch) {
    return { owner: slugMatch[1]!, name: slugMatch[2]! };
  }
  return null;
}

function buildGitHubUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}`;
}

/** Validate repo exists via `gh repo view`. Resolves true/false. */
function validateGitHubRepo(owner: string, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["repo", "view", `${owner}/${name}`, "--json", "name"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let ok = false;
    child.stdout.on("data", () => {
      ok = true;
    });
    child.on("close", (code) => resolve(code === 0 && ok));
    child.on("error", () => resolve(false));
  });
}

/** Build a ProjectMetaPatch for GitHub fields from an update patch. */
function extractGitHubMetaPatch(patch: Record<string, any>): ProjectMetaPatch {
  const meta: ProjectMetaPatch = {};
  const HAS = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);

  const nullOrVal = (v: string | null | undefined): string | null =>
    v == null || v === "" ? null : v;

  if (HAS("githubRepoUrl")) {
    const raw: string | null = nullOrVal(patch.githubRepoUrl);
    meta.githubRepoUrl = raw;
    if (raw) {
      const parsed = parseGitHubRepo(raw);
      meta.githubRepoOwner = parsed?.owner ?? null;
      meta.githubRepoName = parsed?.name ?? null;
    } else {
      meta.githubRepoOwner = null;
      meta.githubRepoName = null;
    }
  }
  if (HAS("githubDefaultBranch")) meta.githubDefaultBranch = nullOrVal(patch.githubDefaultBranch);
  if (HAS("githubLocalPath")) meta.githubLocalPath = nullOrVal(patch.githubLocalPath);
  if (HAS("githubLastSyncAt")) meta.githubLastSyncAt = patch.githubLastSyncAt ?? null;
  if (HAS("githubSyncStatus"))
    meta.githubSyncStatus = nullOrVal(patch.githubSyncStatus) as GitHubSyncStatus | null;
  return meta;
}

/** Attach GitHub meta fields to a project object (mutates). */
function attachGitHubMeta(
  project: any,
  meta:
    | {
        githubRepoUrl?: string;
        githubRepoOwner?: string;
        githubRepoName?: string;
        githubDefaultBranch?: string;
        githubLocalPath?: string;
        githubLastSyncAt?: number;
        githubSyncStatus?: string;
        linkedInvoiceIds?: string[];
      }
    | null
    | undefined,
): void {
  if (!meta) return;
  if (meta.githubRepoUrl) project.githubRepoUrl = meta.githubRepoUrl;
  if (meta.githubRepoOwner && meta.githubRepoName) {
    project.githubRepo = { owner: meta.githubRepoOwner, name: meta.githubRepoName };
  }
  if (meta.githubDefaultBranch) project.githubDefaultBranch = meta.githubDefaultBranch;
  if (meta.githubLocalPath) project.githubLocalPath = meta.githubLocalPath;
  if (meta.githubLastSyncAt) project.githubLastSyncAt = meta.githubLastSyncAt;
  if (meta.githubSyncStatus) project.githubSyncStatus = meta.githubSyncStatus;
  if (meta.linkedInvoiceIds?.length) project.linkedInvoiceIds = meta.linkedInvoiceIds;
}

// Get local store for autonomous fields. No explicit dir so the store resolves
// under the ACTIVE profile (getKanbanStore re-opens on profile switch).
function getStore() {
  return getKanbanStore();
}

/**
 * Resolve Notion database id to use for kanban writes. Reads the wizard-managed
 * config. When no database is configured, callers use the local store.
 */
function resolveNotionDb(source: "kanban-projects" | "kanban-tasks"): string | null {
  return resolveNotionDbId(source);
}

function getNotionApiKey(): string | null {
  return getNotionApiKeyOrNull();
}

/**
 * `archived` → the Notion "Archive" checkbox (the same column `mapProject`
 * reads back). Soft archive only — the page is never trashed, so the
 * knowledge graph's "consolidate sub-projects" can archive and un-archive.
 */
export function archivePatchToNotion(patch: Record<string, unknown>): Record<string, unknown> {
  if (typeof patch.archived !== "boolean") return {};
  return { Archive: { checkbox: patch.archived } };
}

function isNotionEnabled(): boolean {
  const cfg = getNotionConfig();
  return cfg.syncMode !== "off" && !!cfg.apiKey;
}

async function notionFetch(path: string, opts: RequestInit = {}): Promise<any> {
  try {
    return await notionFetchRaw(path, opts);
  } catch (err) {
    // Open the shared circuit: the next creates skip Notion and save
    // locally at once (the outbox mirrors them when Notion answers again).
    if (getNotionApiKey()) tripNotionCircuit(err);
    throw err;
  }
}

async function notionFetchRaw(path: string, opts: RequestInit = {}): Promise<any> {
  const apiKey = getNotionApiKey();
  if (!apiKey)
    throw new Error("Notion sync is off — connect Notion via /quickstart to enable this call");
  if (typeof opts.body === "string") {
    opts = {
      ...opts,
      body: await sanitizeNotionPageWrite(apiKey, path, opts.method, opts.body, [
        resolveNotionDbId("kanban-tasks"),
        resolveNotionDbId("kanban-projects"),
      ]),
    };
  }
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((opts.headers as Record<string, string>) || {}),
    },
    // Notion sits in the request path here, so keep the wait short: on a
    // timeout the create/update handlers fall back to the local store and
    // the outbox retries the mirror in the background.
    signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  if (raw.trimStart().startsWith("<")) {
    throw new Error(
      `Notion API returned HTML instead of JSON (status ${res.status}). ` +
        "Check that NOTION_API_KEY is set and the request isn't being intercepted.",
    );
  }
  const body = JSON.parse(raw);
  if (!res.ok)
    throw new Error(`Notion API ${res.status}: ${body?.message || JSON.stringify(body)}`);
  return body;
}

async function queryAllPages(databaseId: string, filter?: any): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch(`/databases/${databaseId}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    // Archived / trashed pages are deleted tasks — never list them.
    pages.push(...(res.results || []).filter((p: any) => !p?.archived && !p?.in_trash));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

// ── List response cache + in-flight dedupe ─────────────────
// Multiple UI surfaces (business home, business workspace, kanban view,
// command center, MCP tools) each call kanban.projects.list / kanban.tasks.list
// independently. Without a gateway-side cache, every UI render that misses its
// own TTL fans out to Notion and we trip the 60-req/min rate limit.
//
// Successful responses are cached briefly so back-to-back callers share one
// Notion round-trip. Failures are cached longer so a 429 doesn't immediately
// trigger another request on the next render.
// Stale-while-revalidate: see kanban-list-cache.ts. A full Notion read of a
// real board takes 10–40 s, so aged-out or write-invalidated entries keep
// serving the last good list while one background fetch refreshes it.
const listCache = createListCache({
  onBackgroundError: (key, err) =>
    console.warn(
      `[Kanban] background refresh of ${key} failed:`,
      err instanceof Error ? err.message : String(err),
    ),
});
const LIST_SUCCESS_TTL_MS = 30_000;
const LIST_FAILURE_TTL_MS = 60_000;

function getCachedList(key: string): any | null {
  return listCache.getFresh(key);
}

function setCachedList(key: string, data: any, ttlMs: number) {
  listCache.set(key, data, ttlMs);
}

function invalidateListCache(scope: "projects" | "tasks" | "all" = "all") {
  if (scope === "all") {
    listCache.invalidate();
    return;
  }
  listCache.invalidate(scope + ":");
  // The dashboard feed (resolveNotionBoard*) caches the same rows under its own key.
  listCache.invalidate(`feed:${scope}`);
}

/** Task row fields a list overlay may carry (see kanban-list-cache.ts#overlay). */
const TASK_OVERLAY_FIELDS = [
  "status",
  "done",
  "title",
  "description",
  "priority",
  "priorityLevel",
  "dueDate",
  "assignee",
  "projectId",
  "notionStatus",
  "autonomous",
  "autonomousStatus",
] as const;

/**
 * A confirmed task write must show in every cached task list right away and
 * survive refreshes that read Notion before the write landed — otherwise the
 * dashboard's post-write reload brings the old row (e.g. not-done) back.
 */
export function taskOverlayPatch(
  patch: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const keys = new Set(Object.keys(patch));
  // status and done are one fact; Notion's notionStatus follows them.
  if (keys.has("status") || keys.has("done")) {
    keys.add("status");
    keys.add("done");
    keys.add("notionStatus");
  }
  if (keys.has("priority")) keys.add("priorityLevel");
  const out: Record<string, unknown> = {};
  for (const k of TASK_OVERLAY_FIELDS) {
    if (!keys.has(k)) continue;
    const v = result[k] !== undefined ? result[k] : patch[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function overlayTaskWrite(id: string, patch: Record<string, unknown>, result: unknown): void {
  const row = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  listCache.overlay(["tasks:", "feed:tasks"], id, taskOverlayPatch(patch, row));
}

// ── Task write ledger: local source of truth + async Notion push ─────────
// A task write is applied to the local store and the versioned write ledger
// (src/tasks/kanban-write-ledger.ts) at once, answered immediately, announced
// as `kanban.task.updated`, and pushed to Notion in the background with retry.
// Every list read is merged through the ledger, so neither a stale cache entry
// nor an older Notion read can undo it.

/** Fields a task write carries through the ledger. */
const TASK_WRITE_FIELDS = [
  ...TASK_OVERLAY_FIELDS,
  "assignedAgent",
  "associatedDatabaseId",
  "associatedRowId",
  "associatedSlug",
  "associatedUrl",
] as const;

/**
 * The fields a task patch actually writes, with status ↔ done ↔ Notion status
 * made consistent (a status move away from Done clears the Done checkbox —
 * otherwise Notion keeps reading the task back as done).
 */
export function normalizeTaskWrite(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TASK_WRITE_FIELDS) if (patch[k] !== undefined) out[k] = patch[k];
  if (typeof out.status === "string") out.done = out.status === "done";
  else if (out.done === true) out.status = "done";
  else if (out.done === false) out.status = "todo";
  if (typeof out.status === "string") {
    const ns = KANBAN_TO_NOTION_TASK_STATUS[out.status];
    if (ns) out.notionStatus = ns;
    else delete out.notionStatus;
  }
  if (typeof out.priority === "string" && out.priorityLevel === undefined) {
    const np = LOCAL_PRIORITY_TO_NOTION[out.priority];
    if (np) out.priorityLevel = np;
  }
  return out;
}

/** Notion page properties for the Notion-backed subset of a task write. */
export function taskFieldsToNotionProperties(f: Record<string, unknown>): Record<string, any> {
  const properties: Record<string, any> = {};
  if (typeof f.title === "string" && f.title)
    properties["Task Name"] = { title: [{ text: { content: f.title } }] };
  if (typeof f.description === "string" && f.description)
    properties.Description = { rich_text: [{ text: { content: f.description } }] };
  if (typeof f.status === "string") {
    const ns = KANBAN_TO_NOTION_TASK_STATUS[f.status];
    if (ns) properties["Status Update"] = { status: { name: ns } };
    properties.Done = { checkbox: f.status === "done" };
  } else if (typeof f.done === "boolean") {
    properties.Done = { checkbox: f.done };
  }
  if (typeof f.priority === "string") {
    const np = LOCAL_PRIORITY_TO_NOTION[f.priority];
    if (np) properties["Priority Level"] = { select: { name: np } };
  }
  if (f.dueDate !== undefined)
    properties["Due Date"] =
      typeof f.dueDate === "string" && f.dueDate
        ? { date: { start: f.dueDate.slice(0, 10) } }
        : { date: null };
  if (f.projectId !== undefined) {
    const pid = typeof f.projectId === "string" && f.projectId.trim() ? f.projectId.trim() : null;
    if (!pid) properties.Project = { relation: [] };
    else {
      const ref = resolveKanbanId("project", pid);
      // A local-only project can't be related in Notion — kept locally only.
      if (ref.where === "notion") properties.Project = { relation: [{ id: ref.notionId }] };
    }
  }
  return properties;
}

/** Notion rejected the write itself (not a transient outage) — don't retry forever. */
const PERMANENT_NOTION_ERROR = /Notion API (400|403|404):/;

let taskPusher: ReturnType<typeof createLedgerPusher> | null = null;

function getTaskPusher() {
  if (!taskPusher) {
    taskPusher = createLedgerPusher(
      getKanbanWriteLedger(),
      async (entry) => {
        if (!isNotionEnabled()) return;
        const ref = resolveKanbanId("task", entry.id);
        if (ref.where === "local") return;
        const properties = taskFieldsToNotionProperties(entry.fields);
        if (Object.keys(properties).length === 0) return;
        try {
          await notionFetch(`/pages/${ref.notionId}`, {
            method: "PATCH",
            body: JSON.stringify({ properties }),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (PERMANENT_NOTION_ERROR.test(msg)) {
            console.warn(`[Kanban] task ${entry.id}: Notion refused the write, kept locally:`, msg);
            return;
          }
          throw err;
        }
      },
      {
        onPushed: (entry) =>
          broadcastKanbanTaskUpdated({
            id: entry.id,
            fields: entry.fields,
            version: entry.version,
            syncPending: false,
          }),
        onFailed: (entry, err) => {
          console.warn(`[Kanban] task ${entry.id}: Notion push failed (will retry):`, err);
          broadcastKanbanTaskUpdated({
            id: entry.id,
            fields: entry.fields,
            version: entry.version,
            syncPending: true,
            syncError: err,
          });
        },
      },
    );
  }
  return taskPusher;
}

/** Resume Notion pushes a previous gateway process left pending. */
export function resumeKanbanTaskPushes(): void {
  try {
    getTaskPusher().start();
  } catch {
    /* best-effort */
  }
}

/** Test hook: wait for in-flight Notion pushes. */
export async function kanbanTaskPushesIdle(): Promise<void> {
  await taskPusher?.idle();
}

/** Reset module singletons between tests. */
export function resetKanbanTaskPusherForTests(): void {
  taskPusher?.stop();
  taskPusher = null;
}

/**
 * Merge a task list through the write ledger. Source reads (`fromSource`) may
 * retire entries the source now agrees with, and surface rows edited remotely
 * after our write (announced so open tabs take the newer remote value, and
 * written through to the local store).
 */
function mergeTaskLedger<T>(rows: T[], fromSource: boolean): T[] {
  try {
    const ledger = getKanbanWriteLedger();
    const { rows: merged, remoteNewer } = ledger.apply(rows, { fromSource });
    for (const id of remoteNewer) {
      const row = (merged as any[]).find(
        (r) =>
          r &&
          (normalizeNotionId(r.id) === normalizeNotionId(id) ||
            normalizeNotionId(r.notionId) === normalizeNotionId(id)),
      );
      if (!row) continue;
      const fields: Record<string, unknown> = {};
      for (const k of TASK_OVERLAY_FIELDS) if (row[k] !== undefined) fields[k] = row[k];
      broadcastKanbanTaskUpdated({
        id: row.id,
        fields,
        version: ledger.nextVersion(),
        source: "notion",
        syncPending: false,
        projectId: row.projectId ?? null,
      });
      void writeTaskThroughLocal(row.id, fields, row).catch(() => undefined);
    }
    return merged;
  } catch (err) {
    console.warn("[Kanban] write-ledger merge skipped:", err);
    return rows;
  }
}

/**
 * Write-through of a task write to the local store (creating the local row
 * from the board's cached row — or Notion — when it isn't mirrored yet).
 */
async function writeTaskThroughLocal(
  id: string,
  fields: Record<string, unknown>,
  known?: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const store = getStore();
  const localTasks = await store.getTasks();
  const local = localTasks.find((t) => t.id === id || t.notionId === id);
  const update: Record<string, unknown> = {};
  for (const k of [
    "status",
    "done",
    "title",
    "description",
    "priority",
    "priorityLevel",
    "dueDate",
    "assignee",
    "assignedAgent",
    "autonomous",
    "autonomousStatus",
    "associatedDatabaseId",
    "associatedRowId",
    "associatedSlug",
    "associatedUrl",
  ]) {
    if (fields[k] !== undefined) update[k] = fields[k];
  }
  if (fields.projectId !== undefined) {
    const pid =
      typeof fields.projectId === "string" && fields.projectId.trim()
        ? fields.projectId.trim()
        : null;
    update.projectId = pid ?? "default";
  }
  if (local) {
    if (Object.keys(update).length > 0) await store.updateTask(local.id, update as any);
    return { ...local, ...update };
  }
  let base: Record<string, unknown> | null = known ?? findCachedTaskRow(id);
  if (!base) {
    try {
      base = mapTask(await notionFetch(`/pages/${id}`, { method: "GET" }));
    } catch {
      base = { id, projectId: "default", title: "Unknown Task", status: "todo" };
    }
  }
  const row = {
    ...base,
    ...update,
    id,
    notionId: (base.notionId as string) ?? id,
    projectId: (update.projectId as string) ?? ((base.projectId as string) || "default"),
    autonomous: (update.autonomous as boolean) ?? false,
  };
  await store.createTask(row as any);
  return row;
}

/** The board's cached copy of a task row (any cached task list), if any. */
function findCachedTaskRow(id: string): Record<string, unknown> | null {
  const want = normalizeNotionId(id);
  for (const key of ["tasks:all", "feed:tasks"]) {
    const rows = listCache.peek<any[]>(key);
    if (!Array.isArray(rows)) continue;
    const hit = rows.find(
      (r) => r && (normalizeNotionId(r.id) === want || normalizeNotionId(r.notionId) === want),
    );
    if (hit) return hit;
  }
  return null;
}

// Let the kanban-events bridge drop this module's list cache whenever ANY
// write happens — including writes that arrive through the agent MCP tool
// (src/agents/tools/kanban-tool.ts), which never touches this handler and so
// would otherwise leave `kanban.tasks.list` / `projects.list` serving stale
// rows to the live-reload the UI does in response to `kanban:changed`.
setKanbanCacheInvalidator((entity) =>
  invalidateListCache(entity === "project" ? "projects" : "tasks"),
);

// ── Recently-completed broadcast helper ──────────────────────
// Builds a lightweight feed entry and broadcasts `kanban:task:completed`
// so both the Projects gallery feed and the Activity panel feed update live.
function broadcastTaskCompleted(
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void,
  task: {
    id: string;
    title?: string;
    projectId?: string | null;
    assignee?: string;
    priority?: string;
    description?: string;
    createdAt?: number;
    updatedAt?: number;
  },
  progress: { origin?: HqProgressOrigin; connKey?: string } = {},
): void {
  // Business HQ progress log (done today / streak) — deduped per task per day.
  // `origin` bulk/automation (and bursts from one connection) are logged but
  // excluded from the progress figures — see src/hq-progress/store.ts.
  recordHqProgress({
    kind: "task.done",
    objectId: task.id,
    title: task.title ?? "Untitled",
    source: "kanban",
    ...(progress.origin ? { origin: progress.origin } : {}),
    ...(progress.connKey ? { connKey: progress.connKey } : {}),
  });
  try {
    const allProjects = localListProjects();
    const project = allProjects.find((p) => p.id === task.projectId);
    const entry = {
      taskId: task.id,
      projectId: task.projectId ?? null,
      projectName: project?.name ?? "Unknown",
      title: task.title ?? "Untitled",
      assignee: task.assignee,
      priority: task.priority,
      completedAt: task.updatedAt ?? Date.now(),
      durationMs: task.updatedAt && task.createdAt ? task.updatedAt - task.createdAt : 0,
      description: task.description ? task.description.slice(0, 240) : undefined,
    };
    broadcast("kanban:task:completed", entry, { dropIfSlow: true });
  } catch {
    // Best-effort — never let a broadcast failure surface to the caller.
  }
}

// ── Property extractors ──────────────────────────────────
function extractTitle(props: any): string {
  for (const key of ["Project", "Task Name", "Name", "Task", "Title"]) {
    const prop = props[key];
    if (prop?.title) return prop.title.map((t: any) => t.plain_text || "").join("") || "Untitled";
  }
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title" && props[key]?.title) {
      return props[key].title.map((t: any) => t.plain_text || "").join("") || "Untitled";
    }
  }
  return "Untitled";
}

function extractRichText(props: any, key: string): string {
  return (props[key]?.rich_text || []).map((t: any) => t.plain_text || "").join("");
}

function extractStatus(props: any, key: string): string {
  return props[key]?.status?.name || "";
}

function extractSelect(props: any, key: string): string {
  return props[key]?.select?.name || "";
}

function extractMultiSelect(props: any, key: string): string[] {
  return (props[key]?.multi_select || []).map((s: any) => s.name);
}

function extractDate(props: any, key: string): string | undefined {
  return props[key]?.date?.start || undefined;
}

function extractPeople(props: any, key: string): string | undefined {
  const people = props[key]?.people;
  if (!people?.length) return undefined;
  return people
    .map((p: any) => p.name || p.person?.email || "")
    .filter(Boolean)
    .join(", ");
}

function extractNumber(props: any, key: string): number | undefined {
  const prop = props[key];
  if (prop?.type === "number") return prop.number ?? undefined;
  if (prop?.type === "rollup" && prop.rollup?.type === "number") {
    return prop.rollup.number != null ? Math.round(prop.rollup.number * 100) : undefined;
  }
  return undefined;
}

// ── Status mappings ──────────────────────────────────────
const NOTION_TASK_STATUS_TO_KANBAN: Record<string, string> = {
  "Not started": "todo",
  "In progress": "in_progress",
  "Awaiting Response": "review",
  Revisit: "review",
  Done: "done",
};

const KANBAN_TO_NOTION_TASK_STATUS: Record<string, string> = {
  backlog: "Not started",
  todo: "Not started",
  in_progress: "In progress",
  review: "Awaiting Response",
  done: "Done",
};

const LOCAL_PRIORITY_TO_NOTION: Record<string, string> = {
  critical: "Immediate",
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ── CRM client relations (quick capture / agents) ────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Notion CRM page ids of agency clients (clients without one can't be related). */
async function clientNotionIds(ids: Array<string | null | undefined>): Promise<string[]> {
  const want = ids.filter((x): x is string => typeof x === "string" && !!x.trim());
  if (!want.length) return [];
  try {
    const { loadCaptureClients } = await import("../../ideas/client-source.js");
    const { clients } = await loadCaptureClients();
    const byId = new Map(clients.map((c) => [c.id, c.notionPageId]));
    return want.map((id) => byId.get(id)).filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/**
 * Point a Notion task's "Customer" / project's "Clients" relation at a CRM
 * client: add `clientId`'s page, drop `previous` clients' pages, keep any
 * other linked clients. Best-effort — the relation indexes are the source the
 * client page reads; this keeps Notion in line when it is the board.
 */
async function syncNotionClientRelation(
  pageId: string,
  prop: "Customer" | "Clients",
  clientId: string | null,
  previous: string[] = [],
): Promise<void> {
  try {
    const [add] = await clientNotionIds([clientId]);
    const drop = new Set((await clientNotionIds(previous)).map((x) => x.replace(/-/g, "")));
    if (!add && !drop.size) return;
    const page: any = await notionFetch(`/pages/${pageId}`, { method: "GET" });
    const cur: string[] = (page?.properties?.[prop]?.relation ?? []).map((r: any) => String(r.id));
    if (!page?.properties?.[prop]) return; // the database has no such relation
    const keep = cur.filter((x) => !drop.has(x.replace(/-/g, "")));
    const next =
      add && !keep.some((x) => x.replace(/-/g, "") === add.replace(/-/g, ""))
        ? [...keep, add]
        : keep;
    if (next.length === cur.length && next.every((x, i) => x === cur[i])) return;
    await notionFetch(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [prop]: { relation: next.map((id) => ({ id })) } } }),
    });
  } catch (err) {
    console.warn(
      `[Kanban] ${prop} relation not updated:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Client-relation keys a task / project patch may carry (not store fields). */
function splitClientPatch(patch: Record<string, any>): {
  rest: Record<string, any>;
  client?: { clientId: string | null; previous: string[] };
} {
  const { clientId, previousClientIds, dueTime: _dueTime, ...rest } = patch ?? {};
  if (clientId === undefined) return { rest };
  return {
    rest,
    client: {
      clientId: typeof clientId === "string" && clientId.trim() ? clientId.trim() : null,
      previous: Array.isArray(previousClientIds)
        ? previousClientIds.filter((x: unknown): x is string => typeof x === "string")
        : [],
    },
  };
}

// ── Mappers ──────────────────────────────────────────────
function mapProject(page: any) {
  const props = page.properties || {};
  return {
    id: page.id,
    notionId: page.id,
    name: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status: extractStatus(props, "Status") || "Not started",
    priority: extractSelect(props, "Priority") || undefined,
    type: extractMultiSelect(props, "Type"),
    progress: extractNumber(props, "Progress") ?? 0,
    taskCount: props.Tasks?.relation?.length || 0,
    dueDate: extractDate(props, "Due") || extractDate(props, "Due Date"),
    // Notion CRM page ids of the project's clients (quick capture infers the client from them).
    clientNotionIds: Array.isArray(props.Clients?.relation)
      ? props.Clients.relation.map((r: any) => String(r.id))
      : undefined,
    coverUrl: page.cover?.external?.url || page.cover?.file?.url || undefined,
    // Cash-flow tracking surfaced on the Business Command Center KPI strip.
    // "Pending Pay" = projected/invoiced. "Paid Amount" = actually received.
    // Dates are optional; when absent the amount counts toward "all time"
    // but not the current-month aggregate.
    pendingPay: extractNumber(props, "Pending Pay") ?? extractNumber(props, "PendingPay"),
    paidAmount: extractNumber(props, "Paid Amount") ?? extractNumber(props, "PaidAmount"),
    pendingPayDate:
      extractDate(props, "Pending Pay Date") || extractDate(props, "PendingPayDate") || undefined,
    paidAmountDate:
      extractDate(props, "Paid Amount Date") || extractDate(props, "PaidAmountDate") || undefined,
    // Monthly recurring revenue — feeds the Agency Operations MRR statistic.
    mrr: extractNumber(props, "MRR") ?? extractNumber(props, "Mrr"),
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
    // Parent-child hierarchy (self-referential Notion relation)
    parentProjectId: props["Parent Project"]?.relation?.[0]?.id ?? null,
    // Active Client Project checkbox
    active: props["Active Client Project"]?.checkbox === true || props["Active"]?.checkbox === true,
    // Archive checkbox — archived projects are hidden from the kanban UI list
    // (filtered in kanban.projects.list) but stay queryable via MCP/list APIs.
    archived: props["Archive"]?.checkbox === true || props["Archived"]?.checkbox === true,
  };
}

function mapTask(page: any) {
  const props = page.properties || {};
  const notionStatus =
    extractStatus(props, "Status Update") || extractStatus(props, "Status") || "Not started";
  let status = NOTION_TASK_STATUS_TO_KANBAN[notionStatus] || "todo";
  let done = props.Done?.checkbox === true;

  // ── Bidirectional sync: done checkbox ↔ status ──
  // Ensure done and status are consistent when reading from Notion
  if (done && status !== "done") {
    // Done checkbox is checked, so status should be "done"
    status = "done";
  } else if (status === "done" && !done) {
    // Status is Done but checkbox isn't checked - sync to match
    done = true;
  }

  return {
    id: page.id,
    notionId: page.id,
    projectId: props.Project?.relation?.[0]?.id || "",
    title: extractTitle(props),
    description: extractRichText(props, "Description") || extractRichText(props, "Notes") || "",
    status,
    notionStatus,
    assignee: extractPeople(props, "Assignee") || extractPeople(props, "Assign") || "",
    department: extractMultiSelect(props, "Department"),
    priorityLevel: extractSelect(props, "Priority Level") || undefined,
    priority: (() => {
      const pl = extractSelect(props, "Priority Level");
      if (pl === "Immediate") return "critical";
      if (pl === "High") return "high";
      if (pl === "Low") return "low";
      return "medium";
    })(),
    dueDate: extractDate(props, "Due Date") || extractDate(props, "Due"),
    // Notion CRM page ids of the task's "Customer" relation.
    customerNotionIds: Array.isArray(props.Customer?.relation)
      ? props.Customer.relation.map((r: any) => String(r.id))
      : undefined,
    done,
    createdAt: new Date(page.created_time).getTime(),
    updatedAt: new Date(page.last_edited_time).getTime(),
  };
}

function parseBranch(statusOutput: string): string {
  const m = statusOutput.match(/^# branch\.head (.+)$/m);
  return m?.[1] ?? "unknown";
}

function parseSyncStatus(statusOutput: string): GitHubSyncStatus {
  const abMatch = statusOutput.match(/^# branch\.ab \+(\d+) -(\d+)$/m);
  if (!abMatch) return "unknown";
  const ahead = parseInt(abMatch[1]!, 10);
  const behind = parseInt(abMatch[2]!, 10);
  if (ahead > 0 && behind > 0) return "diverged";
  if (behind > 0) return "behind";
  if (ahead > 0) return "ahead";
  return "clean";
}

// ── Unified board-source resolver (dashboard ↔ kanban parity) ─────
// The dashboard and the kanban board MUST read project/task data from the
// same database. kanban.projects.list / kanban.tasks.list read the bound
// Notion DB (cfg.projectsDbId / tasksDbId) when sync is enabled, but the
// dashboard's "recently completed" feed used to ALWAYS read the local
// store — so with Notion on, the dashboard could show one workspace's data
// while the board beside it showed another. These helpers resolve the
// Notion-enabled source exactly the way the list handlers do (and share
// the list cache), so the two surfaces stay in lock-step. The local-first
// path is intentionally left to each caller because the recently-completed
// feed reads kanban.db (real production tasks) while the board's local
// path reads the databases.db mirror — see kanban.listRecentlyCompleted.

function normalizeNotionId(id: string | null | undefined): string {
  return (id ?? "").replace(/-/g, "").toLowerCase();
}

async function resolveNotionBoardProjects(): Promise<any[]> {
  const cached = getCachedList("projects:");
  if (cached) return cached;
  // Stale-while-revalidate like the board lists (see kanban-list-cache.ts).
  return listCache.get("feed:projects", async () => {
    const dbId = resolveNotionDb("kanban-projects");
    if (!dbId) {
      try {
        return localListProjects();
      } catch {
        return [];
      }
    }
    try {
      const pages = await queryAllPages(dbId);
      const projects = pages.map(mapProject);
      setCachedList("feed:projects", projects, LIST_SUCCESS_TTL_MS);
      return projects;
    } catch {
      // Mirror the board's Notion-failure behavior: fall back to local.
      try {
        return localListProjects();
      } catch {
        return [];
      }
    }
  });
}

async function resolveNotionBoardTasks(): Promise<any[]> {
  const cached = getCachedList("tasks:all");
  if (cached) return mergeTaskLedger(cached, false);
  // Stale-while-revalidate like the board lists (see kanban-list-cache.ts).
  const tasks = await listCache.get("feed:tasks", async () => {
    const dbId = resolveNotionDb("kanban-tasks");
    if (!dbId) {
      try {
        return localListTasks();
      } catch {
        return [];
      }
    }
    try {
      const pages = await queryAllPages(dbId);
      const tasks = mergeTaskLedger(pages.map(mapTask), true);
      setCachedList("feed:tasks", tasks, LIST_SUCCESS_TTL_MS);
      return tasks;
    } catch {
      try {
        return localListTasks();
      } catch {
        return [];
      }
    }
  });
  return mergeTaskLedger(tasks, false);
}

// Runtime invariant: when Notion is on, the canonical Notion DB id read by
// the list handlers (cfg.projectsDbId) and the Notion id bound to the
// local "projects" system-role database should point at the SAME Notion
// database. If they diverge, the dashboard and the board can show data
// from two different Notion workspaces — exactly the bug this guards. Log
// once so the divergence is visible in the gateway log without spamming.
let _kanbanSourceDivergenceWarned = false;
function assertKanbanSourceConsistency(): void {
  try {
    if (!isNotionEnabled()) return;
    const cfgProjects = resolveNotionDbId("kanban-projects");
    if (!cfgProjects) return;
    let localNotionId: string | null = null;
    try {
      const { database } = resolveKanbanDatabase("projects");
      localNotionId = ((database as { notionId?: string | null }).notionId ?? null) || null;
    } catch {
      localNotionId = null;
    }
    if (localNotionId && normalizeNotionId(cfgProjects) !== normalizeNotionId(localNotionId)) {
      if (!_kanbanSourceDivergenceWarned) {
        console.warn(
          "[Kanban][invariant] dashboard/board source divergence: notion-config projectsDbId=%s but the local 'projects' system-role DB is bound to Notion id=%s. Dashboard and kanban may show data from different Notion databases. Re-run the Quickstart Notion step to re-bind.",
          cfgProjects,
          localNotionId,
        );
        _kanbanSourceDivergenceWarned = true;
      }
    }
  } catch {
    // An invariant check must never break the request it guards.
  }
}

/** Flag rows still owed to Notion so the board can show them as queued. */
function markSyncPending(list: any[], pending: Array<{ id: string }>): void {
  try {
    const ids = new Set(pending.map((p) => p.id));
    for (const row of list) if (ids.has(row?.id)) row.syncPending = true;
  } catch {
    /* cosmetic only */
  }
}

// ── Gateway Handlers ─────────────────────────────────────
const _rawKanbanHandlers: GatewayRequestHandlers = {
  /**
   * Quiet Notion-sync health for the board: "off" (not connected — normal),
   * "ok", or "paused" (writes saved locally and queued for Notion). Never an
   * error state; the UI shows at most a small chip.
   */
  "kanban.notionSync.status": async ({ respond }) => {
    try {
      respond(true, getNotionSyncHealth());
    } catch {
      respond(true, { state: "off", pending: 0 });
    }
  },

  /**
   * Re-queue rows Notion permanently rejected ("needs attention"), e.g. after
   * the operator added the missing option or set `notion.optionMap`.
   * Params: { ids?: string[] } — all dead-lettered rows when omitted.
   */
  "kanban.notionSync.retry": async ({ params, respond }) => {
    try {
      const ids = Array.isArray((params as { ids?: unknown })?.ids)
        ? ((params as { ids: unknown[] }).ids.filter((x) => typeof x === "string") as string[])
        : undefined;
      respond(true, { requeued: retryNotionDeadLetters(ids) });
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  /**
   * Merge duplicate Notion-linked kanban rows. Dry run unless { apply: true };
   * a real run backs up the touched databases first and returns the report.
   */
  "kanban.notionSync.dedupe": async ({ params, respond }) => {
    try {
      const { repairNotionDuplicates } = await import("../../tasks/notion-dedupe-repair.js");
      const apply = (params as { apply?: unknown })?.apply === true;
      respond(true, await repairNotionDuplicates({ stateDir: resolveStateDir(), dryRun: !apply }));
    } catch (err) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(err) });
    }
  },

  "kanban.projects.list": async ({ params, respond }) => {
    try {
      // Archived projects are hidden from the board by default. Pass
      // includeArchived:true to get the full set (the data is never
      // deleted — MCP list_projects and localListProjects still return
      // archived rows, so nothing becomes unqueryable).
      const includeArchived = (params as any)?.includeArchived === true;
      const dropArchived = (list: any[]): any[] =>
        includeArchived ? list : list.filter((p) => !(p as any)?.archived);
      // Local-first: when Notion is off (or unreachable), serve from
      // the SQLite store via the unified ops module. The local store
      // is the source of truth — Notion is only an optional mirror.
      if (!isNotionEnabled()) {
        const projects = localListProjects();
        // Merge project meta (businessId, mediaProjectId) — without
        // this, the local-first path returns bare projects with no
        // business link, which silently breaks the per-business
        // filter on the kanban gallery + workspace + tasks list.
        try {
          const allMeta = getStore().getAllProjectMeta();
          for (const project of projects) {
            const meta = allMeta[project.id];
            if (meta?.businessId) (project as any).businessId = meta.businessId;
            if (meta?.mediaProjectId) (project as any).mediaProjectId = meta.mediaProjectId;
            attachGitHubMeta(project, meta);
          }
        } catch (e) {
          console.warn("[Kanban] local-first meta merge failed:", e);
        }
        respond(true, dropArchived(projects));
        return;
      }

      const cacheKey = "projects:";
      const projects = await listCache.get(cacheKey, async () => {
        const dbId = resolveNotionDb("kanban-projects");
        let pages: any[] = [];
        // While Notion is known to be down, serve the local store at once.
        let notionFailed = !!dbId && isNotionCircuitOpen();
        if (dbId && !notionFailed) {
          try {
            pages = await queryAllPages(dbId);
          } catch (notionErr) {
            notionFailed = true;
            console.warn(
              "[Kanban] projects.list Notion query failed, falling back to local store:",
              notionErr instanceof Error ? notionErr.message : String(notionErr),
            );
          }
        }

        // On Notion failure, prefer local SQLite over an empty list
        // so the UI shows the last-known state instead of a blank
        // board. This is the cached fallback that survives 429s.
        let projectsList: any[];
        if (notionFailed || !dbId) {
          try {
            projectsList = localListProjects();
            if (dbId) markSyncPending(projectsList, listNotionPendingProjects());
            try {
              const allMeta = getStore().getAllProjectMeta();
              for (const project of projectsList) {
                const meta = allMeta[project.id];
                if (meta?.businessId) (project as any).businessId = meta.businessId;
                if (meta?.mediaProjectId) (project as any).mediaProjectId = meta.mediaProjectId;
                attachGitHubMeta(project, meta);
              }
            } catch {
              /* harmless */
            }
          } catch {
            projectsList = [];
          }
        } else {
          projectsList = pages.map(mapProject);
          // Projects created while Notion was unreachable live only in the
          // local store until the outbox mirrors them — show them anyway.
          try {
            const seen = new Set(projectsList.map((p: any) => normalizeNotionId(p.id)));
            for (const pending of listNotionPendingProjects()) {
              if (!seen.has(normalizeNotionId(pending.id))) {
                projectsList.push({ ...pending, syncPending: true });
              }
            }
          } catch (pendingErr) {
            console.warn("[Kanban] pending-project merge skipped:", pendingErr);
          }

          // ── Merge local fields from SQLite (including rank) ──
          try {
            const store = getStore();
            const localProjects = await store.getProjects();
            const localProjectMap = new Map<string, any>();
            for (const p of localProjects) {
              localProjectMap.set(p.id, p);
              if (p.notionId) localProjectMap.set(p.notionId, p);
            }

            const allMeta = store.getAllProjectMeta();

            const STYLE_KEYS = [
              "customIcon",
              "iconColor",
              "textColor",
              "bgColor",
              "borderColor",
              "borderWidth",
              "borderStyle",
            ] as const;
            for (const project of projectsList) {
              const localProject =
                localProjectMap.get(project.id) || localProjectMap.get(project.notionId);
              if (localProject) {
                (project as any).rank = localProject.rank;
                for (const key of STYLE_KEYS) {
                  const val = (localProject as any)[key];
                  if (val !== undefined && val !== null) {
                    (project as any)[key] = val;
                  }
                }
              }
              const meta = allMeta[project.id];
              if (meta?.businessId) {
                (project as any).businessId = meta.businessId;
              }
              if (meta?.mediaProjectId) {
                (project as any).mediaProjectId = meta.mediaProjectId;
              }
              attachGitHubMeta(project, meta);
            }
          } catch (localErr) {
            console.warn("[Kanban] Failed to merge local project fields:", localErr);
          }
        }

        projectsList.sort((a: any, b: any) => {
          const rankA = a.rank ?? 999999999;
          const rankB = b.rank ?? 999999999;
          if (rankA !== rankB) return rankA - rankB;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });

        setCachedList(
          cacheKey,
          projectsList,
          notionFailed ? LIST_FAILURE_TTL_MS : LIST_SUCCESS_TTL_MS,
        );
        return projectsList;
      });

      // Cache keeps the full set (see setCachedList above); we only drop
      // archived rows on the way out so the board hides them by default.
      respond(true, dropArchived(projects));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.create": async ({ params, respond }) => {
    try {
      invalidateListCache("projects");
      const { name, description, type } = params as any;
      // Target date (quick capture "launch it by end of month") and CRM client.
      const projectDue: string | undefined =
        typeof (params as any).dueDate === "string" && ISO_DAY.test((params as any).dueDate)
          ? (params as any).dueDate
          : undefined;
      const projectClientId: string | null =
        typeof (params as any).clientId === "string" && (params as any).clientId.trim()
          ? (params as any).clientId.trim()
          : null;
      const businessId =
        typeof (params as any).businessId === "string" && (params as any).businessId.trim()
          ? (params as any).businessId.trim()
          : null;
      const parentProjectId: string | null = (params as any).parentProjectId ?? null;
      // Accept either projectDirectory or directory alias on create.
      const incomingDirectory = (params as any).projectDirectory ?? (params as any).directory;
      // Local-first: write the row to SQLite via the unified ops
      // module. The mirror to Notion (if enabled) fires asynchronously.
      // Also the fallback when Notion is configured but unreachable — a
      // create must never fail or hang because Notion is down.
      const createLocally = (notionUnavailable: boolean) => {
        const project = localUpsertProject({
          name: name || "New Project",
          description: description ?? "",
          parentProjectId,
          ...(projectDue ? { dueDate: projectDue } : {}),
        });
        if (incomingDirectory) {
          ensureProjectDirectoryLink(project.id, String(incomingDirectory));
        }
        if (businessId) {
          getStore().setProjectMeta(project.id, { businessId });
          (project as any).businessId = businessId;
        }
        if (notionUnavailable) (project as any).syncPending = true;
        respond(true, project);
        broadcastKanbanChanged({
          entity: "project",
          op: "create",
          id: (project as any)?.id,
          title: (project as any)?.name ?? name,
        });
      };
      const dbId = resolveNotionDb("kanban-projects");
      if (!isNotionEnabled() || !dbId || isNotionCircuitOpen()) {
        createLocally(isNotionEnabled() && !!dbId);
        return;
      }
      const properties: Record<string, any> = {
        Project: { title: [{ text: { content: name || "New Project" } }] },
      };
      if (description) properties.Description = { rich_text: [{ text: { content: description } }] };
      if (type?.length) properties.Type = { multi_select: type.map((t: string) => ({ name: t })) };
      if (incomingDirectory) {
        properties["Project Directory"] = {
          rich_text: [{ text: { content: String(incomingDirectory) } }],
        };
      }
      if (parentProjectId) {
        properties["Parent Project"] = { relation: [{ id: parentProjectId }] };
      }
      if (projectDue) properties["Due Date"] = { date: { start: projectDue } };

      let page: any;
      try {
        page = await notionFetch("/pages", {
          method: "POST",
          body: JSON.stringify({ parent: { database_id: dbId }, properties }),
        });
      } catch (notionErr) {
        console.warn(
          "[Kanban] projects.create: Notion unavailable, saved locally (sync queued):",
          notionErr instanceof Error ? notionErr.message : String(notionErr),
        );
        createLocally(true);
        return;
      }
      const project = mapProject(page);
      if (projectClientId) await syncNotionClientRelation(project.id, "Clients", projectClientId);
      if (businessId) {
        getStore().setProjectMeta(project.id, { businessId });
        (project as any).businessId = businessId;
      }
      if (incomingDirectory) {
        ensureProjectDirectoryLink(project.id, String(incomingDirectory));
      }
      // Auto-register into the apps & sites registry so every new
      // project shows up on /apps without the operator copying it
      // there manually. Failures are non-fatal — the registry is a
      // catalog, not a source of truth.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        autoRegister(resolveStateDir(), {
          sourceKind: "kanban-project",
          sourceId: project.id,
          name: project.name ?? name ?? "New Project",
          description: description ?? "",
          type: "project",
        });
      } catch (regErr) {
        console.warn(
          "[apps.autoRegister] kanban project failed:",
          regErr instanceof Error ? regErr.message : String(regErr),
        );
      }
      respond(true, project);
      broadcastKanbanChanged({
        entity: "project",
        op: "create",
        id: (project as any)?.id,
        title: (project as any)?.name ?? name,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.update": async ({ params, respond }) => {
    try {
      invalidateListCache("projects");
      // Support both { id, patch: {...} } and { id, ...patch } formats
      const rawParams = params as any;
      const id = rawParams.id || rawParams.project_id;
      // `clientId` (+ previousClientIds) is a CRM relation, not a project field.
      const { rest: patch, client: clientChange } = splitClientPatch(
        rawParams.patch ||
          (({ id: _, project_id: __, patch: ___, ...rest }: any) => rest)(rawParams),
      );

      // ── Server-side cycle guard ─────────────────────────────────────────
      // Reparenting must never create a loop in the project hierarchy. The UI
      // already excludes self + descendants from the picker, but enforce it
      // authoritatively here too: walk up from the proposed parent and reject
      // if we reach the project being updated. A `seen` set also makes this
      // safe against any pre-existing cycle in the stored data.
      if (patch.parentProjectId) {
        const newParentId = String(patch.parentProjectId);
        if (newParentId === id) {
          respond(false, { error: "A project cannot be its own parent." });
          return;
        }
        const all = localListProjects();
        const parentById = new Map(all.map((p: any) => [p.id, p.parentProjectId ?? null]));
        const seen = new Set<string>();
        let cur: string | null | undefined = newParentId;
        while (cur) {
          if (cur === id) {
            respond(false, {
              error: "Cannot set parent: that would create a project hierarchy cycle.",
            });
            return;
          }
          if (seen.has(cur)) break;
          seen.add(cur);
          cur = parentById.get(cur) ?? null;
        }
      }

      // Local-first: update via the unified ops module when Notion sync
      // is off, or when the project only exists locally (created while
      // Notion was unreachable). The ops module owns the SQLite write +
      // (optional) mirror.
      if (!isNotionEnabled() || resolveKanbanId("project", id).where === "local") {
        // project_meta (businessId, mediaProjectId) lives in a
        // separate SQLite table from the row itself, so the
        // localUpsertProject path doesn't persist it. Extract those
        // before the row write and persist them through setProjectMeta
        // — without this the per-project business assignment silently
        // drops on save and "isn't persistent on refresh".
        const localMetaPatch: ProjectMetaPatch = {};
        if (Object.prototype.hasOwnProperty.call(patch, "businessId")) {
          localMetaPatch.businessId =
            patch.businessId === "" || patch.businessId === null ? null : patch.businessId;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "mediaProjectId")) {
          localMetaPatch.mediaProjectId =
            patch.mediaProjectId === "" || patch.mediaProjectId === null
              ? null
              : patch.mediaProjectId;
        }
        const ghPatch = extractGitHubMetaPatch(patch);
        Object.assign(localMetaPatch, ghPatch);
        if (Object.keys(localMetaPatch).length > 0) {
          try {
            getStore().setProjectMeta(id, localMetaPatch);
          } catch (metaErr) {
            console.warn("[Kanban] local-first meta persist failed:", metaErr);
          }
        }
        const updated = localUpsertProject({ id, ...patch });
        // Re-attach meta on the response so the UI sees the link
        // immediately without waiting for the next list-refresh.
        try {
          const meta = getStore().getProjectMeta(id);
          if (meta?.businessId) (updated as any).businessId = meta.businessId;
          if (meta?.mediaProjectId) (updated as any).mediaProjectId = meta.mediaProjectId;
          attachGitHubMeta(updated, meta);
        } catch {
          /* harmless */
        }
        respond(true, updated);
        broadcastKanbanChanged({ entity: "project", op: "update", id });
        return;
      }

      // ── Local-only fields (business link, media link, GitHub fields) ──
      // These never round-trip to Notion; persisted to project_meta keyed by the Notion page id.
      {
        const metaPatch: ProjectMetaPatch = {};
        if (Object.prototype.hasOwnProperty.call(patch, "businessId")) {
          metaPatch.businessId =
            patch.businessId === "" || patch.businessId === null ? null : patch.businessId;
        }
        if (Object.prototype.hasOwnProperty.call(patch, "mediaProjectId")) {
          metaPatch.mediaProjectId =
            patch.mediaProjectId === "" || patch.mediaProjectId === null
              ? null
              : patch.mediaProjectId;
        }
        Object.assign(metaPatch, extractGitHubMetaPatch(patch));
        if (Object.keys(metaPatch).length > 0) {
          try {
            getStore().setProjectMeta(id, metaPatch);
          } catch (metaErr) {
            console.warn("[Kanban] Failed to persist project meta:", metaErr);
          }
        }
      }

      // ── Style fields (Notion-agnostic) — write through to SQLite so they survive reloads ──
      const STYLE_FIELDS = [
        "customIcon",
        "iconColor",
        "textColor",
        "bgColor",
        "borderColor",
        "borderWidth",
        "borderStyle",
      ] as const;
      const stylePatch: Record<string, unknown> = {};
      for (const key of STYLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          stylePatch[key] = patch[key];
        }
      }
      if (Object.keys(stylePatch).length > 0) {
        try {
          getStore().setProjectStyle(id, stylePatch as any);
        } catch (styleErr) {
          console.warn("[Kanban] Failed to persist project style fields:", styleErr);
        }
      }

      const properties: Record<string, any> = {};
      if (patch.name) properties.Project = { title: [{ text: { content: patch.name } }] };
      if (patch.status) properties.Status = { status: { name: patch.status } };
      if (patch.priority) properties.Priority = { select: { name: patch.priority } };
      if (patch.description !== undefined)
        properties.Description = { rich_text: [{ text: { content: patch.description ?? "" } }] };
      // Accept either projectDirectory or directory as alias — keep the
      // Notion "Project Directory" field in lockstep with the file-link below.
      const incomingDirectory = (patch as any).projectDirectory ?? (patch as any).directory;
      if (incomingDirectory !== undefined) {
        properties["Project Directory"] = {
          rich_text: [{ text: { content: String(incomingDirectory ?? "") } }],
        };
      }
      if (patch.dueDate !== undefined)
        properties["Due Date"] = patch.dueDate
          ? { date: { start: patch.dueDate } }
          : { date: null };
      if (patch.productUrl !== undefined)
        properties["Product URL"] = { url: patch.productUrl || null };
      if (patch.coverUrl !== undefined) properties["Cover URL"] = { url: patch.coverUrl || null };
      if (Array.isArray(patch.type) && patch.type.length)
        properties.Type = { multi_select: patch.type.map((t: string) => ({ name: t })) };
      // Cash-flow fields — write USD numbers and optional dates back to Notion.
      // `null` patches clear the value so the user can remove a stale entry.
      if (patch.pendingPay !== undefined)
        properties["Pending Pay"] = {
          number:
            patch.pendingPay === null || patch.pendingPay === "" ? null : Number(patch.pendingPay),
        };
      if (patch.paidAmount !== undefined)
        properties["Paid Amount"] = {
          number:
            patch.paidAmount === null || patch.paidAmount === "" ? null : Number(patch.paidAmount),
        };
      if (patch.mrr !== undefined)
        properties["MRR"] = {
          number: patch.mrr === null || patch.mrr === "" ? null : Number(patch.mrr),
        };
      if (patch.pendingPayDate !== undefined)
        properties["Pending Pay Date"] = patch.pendingPayDate
          ? { date: { start: patch.pendingPayDate } }
          : { date: null };
      if (patch.paidAmountDate !== undefined)
        properties["Paid Amount Date"] = patch.paidAmountDate
          ? { date: { start: patch.paidAmountDate } }
          : { date: null };
      if (patch.parentProjectId !== undefined) {
        properties["Parent Project"] = patch.parentProjectId
          ? { relation: [{ id: patch.parentProjectId }] }
          : { relation: [] };
      }
      if (patch.active !== undefined) {
        properties["Active Client Project"] = { checkbox: Boolean(patch.active) };
      }
      Object.assign(properties, archivePatchToNotion(patch));

      // Mirror the directory to the clickable file-link before we touch
      // Notion — this way the UI gets the link even if Notion sync fails.
      if (incomingDirectory) {
        ensureProjectDirectoryLink(id, String(incomingDirectory));
      }

      if (clientChange)
        await syncNotionClientRelation(id, "Clients", clientChange.clientId, clientChange.previous);

      // If no valid Notion fields, still return success (might be local-only update)
      if (Object.keys(properties).length === 0) {
        respond(true, { id, ...patch, localOnly: true });
        broadcastKanbanChanged({ entity: "project", op: "update", id });
        return;
      }

      // Try Notion update, but don't fail completely if it errors
      try {
        await notionFetch(`/pages/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
        const page = await notionFetch(`/pages/${id}`, { method: "GET" });
        const mapped = mapProject(page);
        // Re-attach local-only fields so the response round-trips them to the UI.
        if (patch.businessId !== undefined)
          (mapped as any).businessId = patch.businessId || undefined;
        if (patch.mediaProjectId !== undefined)
          (mapped as any).mediaProjectId = patch.mediaProjectId || undefined;
        try {
          const freshMeta = getStore().getProjectMeta(id);
          attachGitHubMeta(mapped, freshMeta);
        } catch {
          /* harmless */
        }
        for (const key of STYLE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) {
            (mapped as any)[key] = patch[key];
          }
        }
        respond(true, mapped);
        broadcastKanbanChanged({
          entity: "project",
          op: "update",
          id,
          title: (mapped as any)?.name,
        });
      } catch (notionErr: any) {
        console.warn("[Kanban] Project Notion sync failed:", notionErr.message);
        // Return success with patch applied - Notion sync failed but we can track locally
        respond(true, { id, ...patch, notionSyncFailed: true });
        broadcastKanbanChanged({ entity: "project", op: "update", id });
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.delete": async ({ params, respond }) => {
    try {
      invalidateListCache("projects");
      const { id } = params as any;
      // Cascade-clean all entity_relations rows touching this project
      // (client ↔ project, note ↔ project, workflow ↔ project) so the
      // detail panels on the other side stop showing the dead link.
      // Runs whether we're in Notion mode or local — the row in the
      // relations store is local either way.
      try {
        const { purgeEntity } = await import("../../databases/relations-store.js");
        if (typeof id === "string" && id) {
          purgeEntity(resolveStateDir(), { type: "project", id });
        }
      } catch {
        /* relations cleanup is best-effort */
      }
      if (!isNotionEnabled() || resolveKanbanId("project", id).where === "local") {
        const ok = localDeleteProject(id);
        respond(true, { deleted: ok });
        broadcastKanbanChanged({ entity: "project", op: "delete", id });
        return;
      }
      await notionFetch(`/pages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      respond(true, { deleted: true });
      broadcastKanbanChanged({ entity: "project", op: "delete", id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.list": async ({ params, respond }) => {
    try {
      const projectId = typeof params?.projectId === "string" ? params.projectId : undefined;
      // Local-first: serve from SQLite when Notion is off.
      if (!isNotionEnabled()) {
        const tasks = localListTasks(projectId ? { projectId } : undefined);
        respond(true, tasks);
        return;
      }

      const cacheKey = `tasks:${projectId ?? "all"}`;
      const tasks = await listCache.get(cacheKey, async () => {
        let filter: any = undefined;
        if (projectId) {
          filter = { property: "Project", relation: { contains: projectId } };
        }
        const dbId = resolveNotionDb("kanban-tasks");
        let pages: any[] = [];
        // While Notion is known to be down, serve the local store at once.
        let notionFailed = !!dbId && isNotionCircuitOpen();
        if (dbId && !notionFailed) {
          try {
            pages = await queryAllPages(dbId, filter);
          } catch (notionErr) {
            notionFailed = true;
            console.warn(
              "[Kanban] tasks.list Notion query failed, falling back to local store:",
              notionErr instanceof Error ? notionErr.message : String(notionErr),
            );
          }
        }

        let tasksList: any[];
        if (notionFailed || !dbId) {
          try {
            tasksList = localListTasks(projectId ? { projectId } : undefined);
            if (dbId)
              markSyncPending(
                tasksList,
                listNotionPendingTasks(projectId ? { projectId } : undefined),
              );
          } catch {
            tasksList = [];
          }
        } else {
          tasksList = pages.map(mapTask);
          // Tasks created while Notion was unreachable (local only until the
          // outbox mirrors them).
          try {
            const seen = new Set(tasksList.map((t: any) => normalizeNotionId(t.id)));
            for (const pending of listNotionPendingTasks(projectId ? { projectId } : undefined)) {
              if (!seen.has(normalizeNotionId(pending.id))) {
                tasksList.push({ ...pending, syncPending: true });
              }
            }
          } catch (pendingErr) {
            console.warn("[Kanban] pending-task merge skipped:", pendingErr);
          }

          // ── Merge local fields from SQLite ──
          // autonomous fields, localStatus (backlog preservation), and rank
          try {
            const store = getStore();
            const localTasks = await store.getTasks();
            const localTaskMap = new Map<string, any>();
            for (const t of localTasks) {
              localTaskMap.set(t.id, t);
              if (t.notionId) localTaskMap.set(t.notionId, t);
            }

            for (const task of tasksList) {
              const localTask = localTaskMap.get(task.id) || localTaskMap.get(task.notionId);
              if (localTask) {
                (task as any).autonomous = localTask.autonomous ?? false;
                (task as any).autonomousStatus = localTask.autonomousStatus;
                (task as any).rank = localTask.rank;
                // Fields the board writes but Notion doesn't carry live locally.
                if ((localTask as any).assignedAgent)
                  (task as any).assignedAgent = (localTask as any).assignedAgent;
                if (!task.dueDate && (localTask as any).dueDate)
                  (task as any).dueDate = (localTask as any).dueDate;
                if (!task.assignee && (localTask as any).assignee)
                  (task as any).assignee = (localTask as any).assignee;

                if (
                  localTask.status === "backlog" ||
                  (localTask as any).localStatus === "backlog"
                ) {
                  (task as any).status = "backlog";
                }
              }
            }
          } catch (localErr) {
            console.warn("[Kanban] Failed to merge local fields:", localErr);
          }
        }

        // Local writes newer than this read win (version-guarded merge).
        tasksList = mergeTaskLedger(tasksList, !notionFailed && !!dbId);

        tasksList.sort((a: any, b: any) => {
          const rankA = a.rank ?? 999999999;
          const rankB = b.rank ?? 999999999;
          if (rankA !== rankB) return rankA - rankB;
          return (a.createdAt || 0) - (b.createdAt || 0);
        });

        setCachedList(
          cacheKey,
          tasksList,
          notionFailed ? LIST_FAILURE_TTL_MS : LIST_SUCCESS_TTL_MS,
        );
        return tasksList;
      });

      // Cached lists may predate a write: re-merge at serve time.
      respond(true, mergeTaskLedger(tasks, false));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.create": async ({ params, respond }) => {
    try {
      invalidateListCache("tasks");
      const {
        title,
        projectId,
        description,
        status,
        priority,
        associatedDatabaseId,
        associatedRowId,
        associatedSlug,
        associatedUrl,
        dueDate,
        clientId,
      } = params as any;
      // Local-first: when Notion sync is off, write directly to the
      // store (and skip the legacy local SQLite mirror table — the
      // unified ops layer handles persistence + diagnostics).
      const createLocally = (notionUnavailable: boolean) => {
        const created = localUpsertTask({
          title: title || "New Task",
          description: description ?? "",
          status: status ?? "todo",
          priority: priority ?? "medium",
          projectId: projectId ?? null,
          // YYYY-MM-DD (voice capture "…by Friday"); the store's Due column.
          ...(typeof dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)
            ? { dueDate }
            : {}),
        });
        if (notionUnavailable) (created as any).syncPending = true;
        respond(true, created);
        broadcastKanbanChanged({
          entity: "task",
          op: "create",
          id: (created as any)?.id,
          projectId: projectId ?? null,
          title: (created as any)?.title ?? title,
        });
      };
      const tasksDbId = resolveNotionDb("kanban-tasks");
      // A task under a local-only project can't carry a Notion relation yet
      // — keep it local too; the outbox mirrors both once Notion answers.
      const projectIsLocal =
        typeof projectId === "string" &&
        !!projectId &&
        resolveKanbanId("project", projectId).where === "local";
      if (!isNotionEnabled() || !tasksDbId || projectIsLocal || isNotionCircuitOpen()) {
        createLocally(isNotionEnabled() && !!tasksDbId);
        return;
      }
      const notionStatus = KANBAN_TO_NOTION_TASK_STATUS[status || "todo"] || "Not started";
      const notionPriority = LOCAL_PRIORITY_TO_NOTION[priority || "medium"];

      const properties: Record<string, any> = {
        "Task Name": { title: [{ text: { content: title || "New Task" } }] },
        "Status Update": { status: { name: notionStatus } },
      };
      if (description) properties.Description = { rich_text: [{ text: { content: description } }] };
      if (notionPriority) properties["Priority Level"] = { select: { name: notionPriority } };
      if (projectId) properties.Project = { relation: [{ id: projectId }] };
      if (typeof dueDate === "string" && ISO_DAY.test(dueDate))
        properties["Due Date"] = { date: { start: dueDate } };

      let page: any;
      try {
        page = await notionFetch("/pages", {
          method: "POST",
          body: JSON.stringify({ parent: { database_id: tasksDbId }, properties }),
        });
      } catch (notionErr) {
        console.warn(
          "[Kanban] tasks.create: Notion unavailable, saved locally (sync queued):",
          notionErr instanceof Error ? notionErr.message : String(notionErr),
        );
        createLocally(true);
        return;
      }
      const result = mapTask(page);
      if (typeof clientId === "string" && clientId.trim()) {
        await syncNotionClientRelation(result.id, "Customer", clientId.trim());
        (result as any).clientId = clientId.trim();
      }

      // Persist local-only association fields (databases & pages) — Notion has
      // no equivalent column for these. Best-effort; never fail the create
      // if the local mirror falls over.
      const hasAssoc = associatedDatabaseId || associatedRowId || associatedSlug || associatedUrl;
      if (hasAssoc) {
        try {
          const localStore = getStore();
          await localStore.createTask({
            ...result,
            id: result.id,
            projectId: result.projectId || projectId || "default",
            title: result.title || title || "New Task",
            status: result.status || status || "todo",
            associatedDatabaseId: associatedDatabaseId ?? undefined,
            associatedRowId: associatedRowId ?? undefined,
            associatedSlug: associatedSlug ?? undefined,
            associatedUrl: associatedUrl ?? undefined,
          } as any);
          Object.assign(result, {
            associatedDatabaseId,
            associatedRowId,
            associatedSlug,
            associatedUrl,
          });
        } catch (localErr) {
          console.warn("[Kanban] Failed to persist association fields locally:", localErr);
        }
      }

      respond(true, result);
      broadcastKanbanChanged({
        entity: "task",
        op: "create",
        id: (result as any)?.id,
        projectId: (result as any)?.projectId ?? projectId ?? null,
        title: (result as any)?.title ?? title,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Update a task: `{ id, patch: {...}, source? }` or `{ id, ...patch, source? }`.
   *
   * `source` (optional) says who made the change: "user" | "agent" | "bulk" |
   * "automation". It is not a task field. Completions with "bulk" or
   * "automation" are still written to the Business HQ progress log but marked
   * `bulk: true`, so they don't count toward done-today / streak / cleared
   * this week. Scripts that complete many tasks MUST pass `source: "bulk"`;
   * as a fallback, >20 completions from one connection (or one non-UI client
   * such as the CLI, see hqBurstKey) within 60s are marked
   * bulk automatically (src/hq-progress/store.ts). Omitted = a normal
   * completion; any other value is rejected with INVALID_PARAMS.
   */
  "kanban.tasks.update": async ({ params, respond, context, client }) => {
    try {
      const originParse = parseHqProgressOrigin((params as any)?.source);
      if (!originParse.ok) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: originParse.error });
        return;
      }
      const progress = {
        origin: originParse.origin,
        connKey: hqBurstKey(client),
      };
      // No list-cache invalidation here: every list read is merged through the
      // write ledger, so cached lists stay correct and fast (a dirty cache
      // made every post-write reload wait for a full Notion read).
      const { id, patch: patchFromClient } = params as any;
      // Support both { id, patch: {...} } and { id, ...patch } formats.
      // `source` is RPC metadata (progress origin), never a task field;
      // `clientId` (+ previousClientIds) is a CRM relation, not a task field.
      const { rest: patch, client: clientChange } = splitClientPatch(
        patchFromClient || (({ id: _, patch: __, source: ___, ...rest }: any) => rest)(params),
      );
      if (patch.dueDate !== undefined && patch.dueDate !== null && patch.dueDate !== "") {
        if (typeof patch.dueDate !== "string" || !ISO_DAY.test(patch.dueDate.slice(0, 10))) {
          respond(false, undefined, {
            code: "INVALID_PARAMS",
            message: 'dueDate must be YYYY-MM-DD (or null / "" to clear)',
          });
          return;
        }
        patch.dueDate = patch.dueDate.slice(0, 10);
      }

      // Local-first: update via the unified ops module when Notion sync
      // is off or the task only exists locally. The ops module owns the
      // SQLite write + (optional) mirror.
      if (!isNotionEnabled() || resolveKanbanId("task", id).where === "local") {
        if (clientChange && Object.keys(patch).length === 0) {
          // Only the client changed: that lives in the relation indexes.
          respond(true, { id, clientId: clientChange.clientId });
          broadcastKanbanChanged({ entity: "task", op: "update", id });
          return;
        }
        const updated = localUpsertTask({
          id,
          ...patch,
          ...(patch.dueDate === null ? { dueDate: "" } : {}),
        });
        overlayTaskWrite(id, patch, updated);
        const entry = noteKanbanTaskWrite(id, normalizeTaskWrite(patch), {
          source: originParse.origin ?? "ui",
          pushed: true, // the local store IS the source here
          projectId: (updated as any)?.projectId ?? (patch as any)?.projectId ?? null,
          title: (updated as any)?.title ?? (patch as any)?.title,
        });
        respond(true, entry ? { ...(updated as any), version: entry.version } : updated);
        if (patch.status === "done" || patch.done === true) {
          broadcastTaskCompleted(context.broadcast, updated as any, progress);
        } else if (
          (patch.status !== undefined && patch.status !== "done") ||
          patch.done === false
        ) {
          unrecordHqProgress("task.done", id);
        }
        return;
      }

      // ── Notion-backed task: local first, Notion in the background ──
      // The write lands in the local store and the versioned write ledger at
      // once and is answered right away; the Notion PATCH runs async with
      // retry (src/tasks/kanban-write-ledger.ts). Every list read is merged
      // through the ledger, so a stale cache or an older Notion read can't
      // bring the old status back, and a slow/failed Notion call can't either.
      const fields = normalizeTaskWrite(patch);
      if (clientChange)
        await syncNotionClientRelation(
          id,
          "Customer",
          clientChange.clientId,
          clientChange.previous,
        );
      if (Object.keys(fields).length === 0) {
        if (clientChange) {
          // Only the client changed: Notion's Customer relation + the relation indexes.
          respond(true, { id, clientId: clientChange.clientId });
          broadcastKanbanChanged({ entity: "task", op: "update", id });
          return;
        }
        respond(false, undefined, { code: "INVALID_PARAMS", message: "No valid fields to update" });
        return;
      }
      const cachedRow = findCachedTaskRow(id);
      let localRow: Record<string, unknown> | null = null;
      try {
        localRow = await writeTaskThroughLocal(id, fields, cachedRow);
      } catch (localErr) {
        console.warn("[Kanban] Failed to write task through to the local store:", localErr);
      }
      const base = cachedRow ?? localRow ?? {};
      const projectId =
        (fields.projectId as string | undefined) ?? (base.projectId as string | undefined) ?? null;
      const entry = noteKanbanTaskWrite(id, fields, {
        source: originParse.origin ?? "ui",
        projectId,
        title: (fields.title as string | undefined) ?? (base.title as string | undefined),
      });
      const result: Record<string, unknown> = {
        ...base,
        ...fields,
        id,
        ...(entry ? { version: entry.version } : {}),
        syncPending: true,
      };
      respond(true, result);
      void getTaskPusher().kick(id);
      if (fields.status === "done") {
        broadcastTaskCompleted(context.broadcast, result as any, progress);
      } else if (fields.status !== undefined) {
        unrecordHqProgress("task.done", id);
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.delete": async ({ params, respond }) => {
    try {
      const { id } = params as any;
      const projectId = (findCachedTaskRow(id)?.projectId as string | undefined) ?? null;
      if (!isNotionEnabled() || resolveKanbanId("task", id).where === "local") {
        const ok = localDeleteTask(id);
        respond(true, { deleted: ok });
        noteKanbanTaskDeleted(id, { projectId });
        return;
      }
      await notionFetch(`/pages/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: true }),
      });
      // Gone everywhere at once: every cached list and any Notion read still
      // lagging behind the archive drop it (write-ledger tombstone), and the
      // local mirror row goes too so a local fallback list can't bring it back.
      // (Before, the row stayed listed until a full Notion re-read that started
      // after the LAST delete of a burst finished — minutes on a big board.)
      noteKanbanTaskDeleted(id, { projectId });
      respond(true, { deleted: true });
      try {
        const store = getStore();
        const local = (await store.getTasks()).find((t) => t.id === id || t.notionId === id);
        if (local) await store.deleteTask(local.id);
      } catch (localErr) {
        console.warn("[Kanban] tasks.delete: local mirror row not removed:", localErr);
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Reordering handlers (stored in SQLite) ────────────────────────────

  /**
   * Reorder a task within its status column.
   * @param id - Task ID to move
   * @param beforeId - Task that will be AFTER this one (below)
   * @param afterId - Task that will be BEFORE this one (above)
   */
  "kanban.tasks.reorder": async ({ params, respond }) => {
    try {
      invalidateListCache("tasks");
      const { id, beforeId, afterId } = params as any;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Task id required" });
        return;
      }

      const store = getStore();

      // Ensure task exists locally (sync from Notion if needed)
      const localTasks = await store.getTasks();
      let task = localTasks.find((t) => t.id === id || t.notionId === id);

      if (!task) {
        // Try to fetch from Notion and create locally
        try {
          const page = await notionFetch(`/pages/${id}`, { method: "GET" });
          const taskData = mapTask(page);
          task = await store.createTask({
            ...taskData,
            id: id,
          } as any);
        } catch {
          respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
          return;
        }
      }

      const result = await store.reorderTask(task.id, beforeId || null, afterId || null);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Bulk reorder tasks - set ranks for all task IDs in order.
   * @param taskIds - Array of task IDs in desired order
   */
  "kanban.tasks.setRanks": async ({ params, respond }) => {
    try {
      invalidateListCache("tasks");
      const { taskIds } = params as any;
      if (!Array.isArray(taskIds)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskIds array required" });
        return;
      }

      const store = getStore();
      await store.setTaskRanks(taskIds);
      respond(true, { updated: taskIds.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Reorder a project in the project list.
   * @param id - Project ID to move
   * @param beforeId - Project that will be AFTER this one (below)
   * @param afterId - Project that will be BEFORE this one (above)
   */
  "kanban.projects.reorder": async ({ params, respond }) => {
    try {
      invalidateListCache("projects");
      const { id, beforeId, afterId } = params as any;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "Project id required" });
        return;
      }

      const store = getStore();
      const projects = await store.getProjects();
      let project = projects.find((p) => p.id === id || p.notionId === id);

      if (!project) {
        // Try to fetch from Notion and create locally
        try {
          const page = await notionFetch(`/pages/${id}`, { method: "GET" });
          const projectData = mapProject(page);
          project = await store.createProject({
            ...projectData,
            id: id,
          } as any);
        } catch {
          respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
          return;
        }
      }

      const result = await store.reorderProject(project.id, beforeId || null, afterId || null);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Bulk reorder projects - set ranks for all project IDs in order.
   * @param projectIds - Array of project IDs in desired order
   */
  "kanban.projects.setRanks": async ({ params, respond }) => {
    try {
      invalidateListCache("projects");
      const { projectIds } = params as any;
      if (!Array.isArray(projectIds)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectIds array required" });
        return;
      }

      const store = getStore();
      await store.setProjectRanks(projectIds);
      respond(true, { updated: projectIds.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get task ranks (from local SQLite storage).
   * Returns map of task ID -> rank.
   */
  "kanban.tasks.getRanks": async ({ params, respond }) => {
    try {
      const store = getStore();
      const projectId = typeof params?.projectId === "string" ? params.projectId : undefined;
      const tasks = await store.getTasks(projectId);
      const ranks: Record<string, number> = {};
      for (const t of tasks) {
        if (t.rank !== undefined) {
          ranks[t.id] = t.rank;
          if (t.notionId && t.notionId !== t.id) {
            ranks[t.notionId] = t.rank;
          }
        }
      }
      respond(true, ranks);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get project ranks (from local SQLite storage).
   */
  "kanban.projects.getRanks": async ({ respond }) => {
    try {
      const store = getStore();
      const projects = await store.getProjects();
      const ranks: Record<string, number> = {};
      for (const p of projects) {
        if (p.rank !== undefined) {
          ranks[p.id] = p.rank;
          if (p.notionId && p.notionId !== p.id) {
            ranks[p.notionId] = p.rank;
          }
        }
      }
      respond(true, ranks);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ══════════════════════════════════════════════════════════
  // Project Content: notes, attachments, badges (local SQLite)
  // ══════════════════════════════════════════════════════════

  "kanban.projects.content.get": async ({ params, respond }) => {
    try {
      const projectId =
        typeof (params as any)?.projectId === "string" ? (params as any).projectId : null;
      if (!projectId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "projectId required" });
        return;
      }
      const content = getStore().getProjectContent(projectId);

      // Notes and badges are master-owned rows, so on a satellite they must
      // come from master. Attachments are NOT master-owned: `uploadAttachment`
      // writes the bytes and the converted markdown into THIS node's state dir
      // (resolveStateDir()), `files.download` serves them from this node, and
      // the agent kanban tool reads them straight out of this node's store.
      // Proxying the whole call to master therefore returned master's (empty)
      // attachment list and made every uploaded file vanish on refresh, even
      // though the row and the file were both here. Take notes/badges from
      // master; always serve attachments locally.
      if (getConnectedSatellite()) {
        const remote = await proxyToMaster("kanban.projects.content.get", { projectId });
        if (remote.success) {
          const data = remote.data as { notes?: unknown[]; badges?: unknown[] } | undefined;
          respond(true, {
            notes: Array.isArray(data?.notes) ? data.notes : content.notes,
            badges: Array.isArray(data?.badges) ? data.badges : content.badges,
            attachments: content.attachments,
          });
          return;
        }
      }

      respond(true, content);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.createNote": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.projectId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "projectId required" });
        return;
      }
      const note = getStore().createProjectNote({
        projectId: p.projectId,
        title: p.title,
        content: p.content,
        pinned: p.pinned,
      });
      respond(true, note);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.updateNote": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.noteId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "noteId required" });
        return;
      }
      const note = getStore().updateProjectNote(p.noteId, {
        title: p.title,
        content: p.content,
        pinned: p.pinned,
      });
      if (!note) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Note not found" });
        return;
      }
      respond(true, note);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.deleteNote": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.noteId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "noteId required" });
        return;
      }
      const ok = getStore().deleteProjectNote(p.noteId);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.addAttachment": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.projectId || !p?.name || !p?.path) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "projectId, name and path required",
        });
        return;
      }
      const att = getStore().createProjectAttachment({
        projectId: p.projectId,
        name: p.name,
        path: p.path,
        size: typeof p.size === "number" ? p.size : 0,
        mimeType: p.mimeType,
        sha256: typeof p.sha256 === "string" ? p.sha256 : undefined,
        markdownPath: typeof p.markdownPath === "string" ? p.markdownPath : undefined,
      });
      console.log(
        `[project-files] attach projectId=${p.projectId} name=${p.name} sha256=${p.sha256 ?? "n/a"} size=${p.size ?? 0}`,
      );
      respond(true, att);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Atomic upload + register: accepts base64 file content, writes to a
   * stable SHA256-keyed path under ~/.infinibot/files/projects/<projectId>/,
   * deduplicates by sha256, and inserts into project_attachments in one call.
   *
   * Replaces the legacy two-step (files.upload → kanban.projects.content.addAttachment)
   * which left orphaned files when the second call failed.
   */
  "kanban.projects.content.uploadAttachment": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.projectId || !p?.name || !p?.content) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "projectId, name and content (base64) required",
        });
        return;
      }

      const projectId = String(p.projectId);
      const name = String(p.name);
      const mimeType: string | undefined = typeof p.mimeType === "string" ? p.mimeType : undefined;

      // Decode content
      const buffer = Buffer.from(String(p.content), "base64");
      const sizeBytes = buffer.length;

      // Size limit (default 50 MB, configurable via env)
      const maxBytes = parseInt(process.env.INFINIBOT_ATTACHMENT_MAX_BYTES ?? "52428800", 10);
      if (sizeBytes > maxBytes) {
        respond(false, undefined, {
          code: "PAYLOAD_TOO_LARGE",
          message: `File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit (got ${Math.round(sizeBytes / 1024 / 1024)} MB)`,
        });
        return;
      }

      // File type check
      const fileExt = pathExtname(name).toLowerCase();
      const { isAcceptedFile } = await import("../../files/convert.js");
      if (!isAcceptedFile(name, mimeType)) {
        respond(false, undefined, {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: `File type not accepted: ${fileExt || mimeType || "unknown"}. Accepted: PDF, images, text, markdown, docx, code, CSV.`,
        });
        return;
      }

      // SHA256 dedup
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const store = getStore();

      const existing = store.findAttachmentBySha256(projectId, sha256);
      if (existing) {
        console.log(
          `[project-files] dedup hit projectId=${projectId} sha256=${sha256.slice(0, 16)} name=${name}`,
        );
        respond(true, existing);
        return;
      }

      // Stable file path under the ACTIVE profile's state dir:
      //   <stateDir>/files/projects/<projectId>/<sha256><ext>
      // resolveStateDir() honors INFINIBOT_STATE_DIR and per-user namespacing.
      const stateDir = resolveStateDir();
      const projectFilesDir = pathJoin(stateDir, "files", "projects", projectId);
      mkdirSync(projectFilesDir, { recursive: true });
      const stableFilename = `${sha256}${fileExt}`;
      const absPath = pathJoin(projectFilesDir, stableFilename);
      writeFileSync(absPath, buffer);

      // Convert to markdown (async, best-effort)
      let markdownPath: string | undefined;
      try {
        const { convertToMarkdown } = await import("../../files/convert.js");
        const { markdown } = await convertToMarkdown(name, buffer, mimeType);
        if (markdown && markdown.trim().length > 0) {
          const mdFilename = `${sha256}.md`;
          const mdPath = pathJoin(projectFilesDir, mdFilename);
          writeFileSync(mdPath, markdown, "utf8");
          // Store relative path
          markdownPath = `projects/${projectId}/${mdFilename}`;
        }
      } catch (convErr) {
        console.warn(`[project-files] conversion failed for ${name}: ${String(convErr)}`);
      }

      // Relative path stored in DB (relative to state/files root)
      const relativePath = `projects/${projectId}/${stableFilename}`;

      const att = store.createProjectAttachment({
        projectId,
        name,
        path: relativePath,
        size: sizeBytes,
        mimeType,
        sha256,
        markdownPath,
      });

      console.log(
        `[project-files] uploaded projectId=${projectId} name=${name} sha256=${sha256.slice(0, 16)} size=${sizeBytes} mimeType=${mimeType ?? "n/a"} markdownPath=${markdownPath ?? "none"}`,
      );

      respond(true, att);
    } catch (e) {
      console.error("[project-files] uploadAttachment error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.removeAttachment": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.attachmentId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "attachmentId required" });
        return;
      }
      const ok = getStore().deleteProjectAttachment(p.attachmentId);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Return the EXTRACTED MARKDOWN for a project attachment (PDF/DOCX/CSV/text/
   * image/etc.). Reads the upload-time `.md` when present, otherwise lazily
   * re-converts from the original bytes and persists the fresh markdownPath.
   * When the attachment isn't in THIS node's store and we're a satellite, the
   * read is proxied to master (attachments are node-local, so the row may live
   * on whichever node uploaded it).
   */
  "kanban.files.getMarkdown": async ({ params, respond }) => {
    try {
      const p = params as any;
      const projectId = typeof p?.projectId === "string" ? p.projectId.trim() : "";
      const attachmentId = typeof p?.attachmentId === "string" ? p.attachmentId.trim() : "";
      if (!attachmentId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "attachmentId required" });
        return;
      }
      const att = getStore().getProjectAttachmentById(attachmentId);
      if (!att) {
        // Best-effort federation: on a satellite, the file may live on master.
        if (getConnectedSatellite()) {
          const remote = await proxyToMaster("kanban.files.getMarkdown", {
            projectId,
            attachmentId,
          });
          if (remote.success) {
            respond(true, remote.data);
            return;
          }
        }
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Attachment "${attachmentId}" not found`,
        });
        return;
      }
      const { readAttachmentMarkdown } = await import("../../files/attachment-markdown.js");
      const md = await readAttachmentMarkdown(att);
      respond(true, {
        projectId: att.projectId,
        attachmentId: att.id,
        name: md.name,
        mimeType: md.mimeType,
        markdown: md.markdown,
        charCount: md.charCount,
        truncated: md.truncated,
        source: md.source,
      });
    } catch (e) {
      console.error("[project-files] getMarkdown error:", e);
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.addBadge": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.projectId || !p?.label) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "projectId and label required" });
        return;
      }
      const badge = getStore().createProjectBadge({
        projectId: p.projectId,
        label: p.label,
        color: p.color,
        icon: p.icon,
      });
      respond(true, badge);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.removeBadge": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.badgeId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "badgeId required" });
        return;
      }
      const ok = getStore().deleteProjectBadge(p.badgeId);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.getBlocks": async ({ params, respond }) => {
    try {
      const projectId =
        typeof (params as any)?.projectId === "string" ? (params as any).projectId : null;
      if (!projectId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "projectId required" });
        return;
      }
      const store = getStore();
      const stored = store.getProjectContentBlocks(projectId);
      if (Array.isArray(stored.blocks) && stored.blocks.length > 0) {
        respond(true, stored);
        return;
      }
      // Local store is empty for this project. If the project is linked to a
      // Notion page and Notion sync is on, hydrate from Notion the first
      // time the Content tab is opened. Once cached locally the editor's
      // saves stay authoritative — subsequent edits won't be clobbered.
      const projects = await store.getProjects();
      const project = projects.find((p) => p.id === projectId);
      const notionId = project?.notionId;
      if (notionId && isNotionEnabled()) {
        try {
          const markdown = await fetchPageBodyAsMarkdown(notionId);
          if (markdown && markdown.trim().length > 0) {
            const blocks = markdownToBlocks(markdown);
            store.saveProjectContentBlocks(projectId, blocks);
            respond(true, store.getProjectContentBlocks(projectId));
            return;
          }
        } catch {
          // Fall through to empty local result so the editor still opens.
        }
      }
      respond(true, stored);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.projects.content.saveBlocks": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.projectId || !Array.isArray(p?.blocks)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "projectId and blocks array required",
        });
        return;
      }
      const result = getStore().saveProjectContentBlocks(p.projectId, p.blocks);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Read project content as markdown. Internally the store keeps the
   * canonical Block[] shape that the block editor renders directly; we
   * serialize on demand so agents, Notion sync, and any markdown-native
   * caller can deal in markdown without learning the block schema.
   */
  "kanban.projects.content.getMarkdown": async ({ params, respond }) => {
    try {
      const projectId =
        typeof (params as any)?.projectId === "string" ? (params as any).projectId : null;
      if (!projectId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "projectId required" });
        return;
      }
      const stored = getStore().getProjectContentBlocks(projectId);
      const blocks = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
      respond(true, {
        markdown: blocksToMarkdown(blocks),
        updatedAt: stored.updatedAt,
        blockCount: blocks.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Write project content from markdown. Parses with the same
   * markdownToBlocks the UI uses for database rows, so what the agent
   * writes shows up formatted in the projects content view (headings,
   * lists, code, callouts, images) instead of as a raw text wall.
   */
  "kanban.projects.content.setMarkdown": async ({ params, respond }) => {
    try {
      const p = params as any;
      const projectId = typeof p?.projectId === "string" ? p.projectId : null;
      const markdown = typeof p?.markdown === "string" ? p.markdown : null;
      if (!projectId || markdown === null) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "projectId and markdown required",
        });
        return;
      }
      const blocks = markdownToBlocks(markdown);
      const result = getStore().saveProjectContentBlocks(projectId, blocks);
      respond(true, {
        updatedAt: result.updatedAt,
        blockCount: blocks.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Append markdown to existing project content. Reads the current
   * Block[], appends the parsed new blocks, saves. Avoids the agent
   * having to round-trip a get → concat → set sequence and avoids
   * accidental overwrites.
   */
  "kanban.projects.content.appendMarkdown": async ({ params, respond }) => {
    try {
      const p = params as any;
      const projectId = typeof p?.projectId === "string" ? p.projectId : null;
      const markdown = typeof p?.markdown === "string" ? p.markdown : null;
      if (!projectId || markdown === null) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "projectId and markdown required",
        });
        return;
      }
      const stored = getStore().getProjectContentBlocks(projectId);
      const existing = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
      const appended = markdownToBlocks(markdown);
      const merged = [...existing, ...appended];
      const result = getStore().saveProjectContentBlocks(projectId, merged);
      respond(true, {
        updatedAt: result.updatedAt,
        blockCount: merged.length,
        appended: appended.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Task content: full rich-document page per task ───────────────────────
  // Mirrors kanban.projects.content.* so every task gets its own editable
  // document body backed by the same Block[] pipeline (markdown-compatible).
  "kanban.tasks.content.getBlocks": async ({ params, respond }) => {
    try {
      const taskId = typeof (params as any)?.taskId === "string" ? (params as any).taskId : null;
      if (!taskId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "taskId required" });
        return;
      }
      respond(true, getStore().getTaskContentBlocks(taskId));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.content.saveBlocks": async ({ params, respond }) => {
    try {
      const p = params as any;
      if (!p?.taskId || !Array.isArray(p?.blocks)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "taskId and blocks array required",
        });
        return;
      }
      respond(true, getStore().saveTaskContentBlocks(p.taskId, p.blocks));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.content.getMarkdown": async ({ params, respond }) => {
    try {
      const taskId = typeof (params as any)?.taskId === "string" ? (params as any).taskId : null;
      if (!taskId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "taskId required" });
        return;
      }
      const stored = getStore().getTaskContentBlocks(taskId);
      const blocks = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
      respond(true, {
        markdown: blocksToMarkdown(blocks),
        updatedAt: stored.updatedAt,
        blockCount: blocks.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.content.setMarkdown": async ({ params, respond }) => {
    try {
      const p = params as any;
      const taskId = typeof p?.taskId === "string" ? p.taskId : null;
      const markdown = typeof p?.markdown === "string" ? p.markdown : null;
      if (!taskId || markdown === null) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "taskId and markdown required" });
        return;
      }
      const blocks = markdownToBlocks(markdown);
      const result = getStore().saveTaskContentBlocks(taskId, blocks);
      respond(true, { updatedAt: result.updatedAt, blockCount: blocks.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.tasks.content.appendMarkdown": async ({ params, respond }) => {
    try {
      const p = params as any;
      const taskId = typeof p?.taskId === "string" ? p.taskId : null;
      const markdown = typeof p?.markdown === "string" ? p.markdown : null;
      if (!taskId || markdown === null) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "taskId and markdown required" });
        return;
      }
      const stored = getStore().getTaskContentBlocks(taskId);
      const existing = Array.isArray(stored.blocks) ? (stored.blocks as Block[]) : [];
      const appended = markdownToBlocks(markdown);
      const merged = [...existing, ...appended];
      const result = getStore().saveTaskContentBlocks(taskId, merged);
      respond(true, {
        updatedAt: result.updatedAt,
        blockCount: merged.length,
        appended: appended.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── GitHub integration ──────────────────────────────────────────────────

  "kanban.github.validate": async ({ params, respond }) => {
    try {
      const { repoUrl } = params as any;
      if (!repoUrl) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "repoUrl required" });
        return;
      }
      const parsed = parseGitHubRepo(repoUrl);
      if (!parsed) {
        respond(false, undefined, {
          code: "VALIDATION_ERROR",
          message: "Could not parse GitHub repo URL",
        });
        return;
      }
      const valid = await validateGitHubRepo(parsed.owner, parsed.name);
      respond(true, {
        valid,
        owner: parsed.owner,
        name: parsed.name,
        url: buildGitHubUrl(parsed.owner, parsed.name),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "kanban.github.sync": async ({ params, respond }) => {
    try {
      const { projectId, action } = params as any;
      if (!projectId) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "projectId required" });
        return;
      }
      const meta = getStore().getProjectMeta(projectId);
      if (!meta?.githubLocalPath) {
        respond(false, undefined, {
          code: "NO_LOCAL_PATH",
          message: "Project has no githubLocalPath configured",
        });
        return;
      }
      if (!existsSync(meta.githubLocalPath)) {
        respond(false, undefined, {
          code: "PATH_NOT_FOUND",
          message: `githubLocalPath does not exist: ${meta.githubLocalPath}`,
        });
        return;
      }

      const run = (
        cmd: string,
        args: string[],
      ): Promise<{ stdout: string; stderr: string; code: number }> =>
        new Promise((resolve) => {
          const child = spawn(cmd, args, {
            cwd: meta.githubLocalPath!,
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60_000,
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d: Buffer) => {
            stdout += d.toString();
          });
          child.stderr.on("data", (d: Buffer) => {
            stderr += d.toString();
          });
          child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
          child.on("error", (e) => resolve({ stdout: "", stderr: String(e), code: 1 }));
        });

      if (action === "status") {
        await run("git", ["fetch", "--quiet"]);
        const status = await run("git", ["status", "--porcelain=v2", "--branch"]);
        const syncStatus = parseSyncStatus(status.stdout);
        getStore().setProjectMeta(projectId, {
          githubLastSyncAt: Date.now(),
          githubSyncStatus: syncStatus,
        });
        const branch = parseBranch(status.stdout);
        respond(true, { syncStatus, branch, raw: status.stdout });
        return;
      }

      if (action === "pull") {
        await run("git", ["fetch", "--quiet"]);
        const pull = await run("git", ["pull", "--ff-only"]);
        const syncStatus: GitHubSyncStatus = pull.code === 0 ? "clean" : "conflict";
        getStore().setProjectMeta(projectId, {
          githubLastSyncAt: Date.now(),
          githubSyncStatus: syncStatus,
        });
        respond(true, { success: pull.code === 0, output: pull.stdout + pull.stderr, syncStatus });
        return;
      }

      if (action === "diff_against_remote") {
        const branch = meta.githubDefaultBranch || "main";
        await run("git", ["fetch", "--quiet"]);
        const diff = await run("git", ["diff", `origin/${branch}...HEAD`]);
        respond(true, { diff: diff.stdout, branch });
        return;
      }

      if (action === "list_open_prs") {
        if (!meta.githubRepoOwner || !meta.githubRepoName) {
          respond(false, undefined, {
            code: "NO_REPO",
            message: "Project has no GitHub repo configured",
          });
          return;
        }
        const prs = await run("gh", [
          "pr",
          "list",
          "--repo",
          `${meta.githubRepoOwner}/${meta.githubRepoName}`,
          "--json",
          "number,title,state,author,url,createdAt",
        ]);
        let data: unknown[] = [];
        try {
          data = JSON.parse(prs.stdout);
        } catch {
          /* leave empty */
        }
        respond(true, { prs: data });
        return;
      }

      respond(false, undefined, { code: "UNKNOWN_ACTION", message: `Unknown action: ${action}` });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * kanban.listRecentlyCompleted({ limit?, sinceTs? })
   *
   * Returns the N most recently completed kanban tasks sorted by completedAt
   * (= updatedAt when status flipped to done — the store has no dedicated
   * completedAt column, so updatedAt is the best available proxy).
   *
   * Each entry: { taskId, projectId, projectName, title, assignee?, priority?,
   *   completedAt, durationMs (created→done), description? (≤240 chars) }
   */
  "kanban.listRecentlyCompleted": async ({ params, respond }) => {
    try {
      const { limit = 25, sinceTs } = params as { limit?: number; sinceTs?: number };
      const cap = Math.max(1, Math.min(limit, 1000));

      // Surface a warning if the two DB-binding systems point at different
      // Notion databases (the root cause of dashboard ↔ board divergence).
      assertKanbanSourceConsistency();

      // ── Notion-enabled: read from the SAME bound Notion DB the kanban
      // board reads (kanban.projects.list / kanban.tasks.list). Before this
      // the feed always read the local store, so the dashboard could show a
      // different workspace's completed tasks than the board next to it.
      if (isNotionEnabled()) {
        const [boardProjects, boardTasks] = await Promise.all([
          resolveNotionBoardProjects(),
          resolveNotionBoardTasks(),
        ]);
        const projectName = new Map<string, string>(
          (boardProjects as any[]).map((p) => [p.id, p.name]),
        );
        let done = (boardTasks as any[]).filter((t) => t.status === "done" || t.done === true);
        if (sinceTs != null) {
          done = done.filter((t: any) => (t.completedAt ?? t.updatedAt ?? 0) > sinceTs);
        }
        done.sort((a: any, b: any) => {
          const aTs = a.completedAt ?? a.updatedAt ?? 0;
          const bTs = b.completedAt ?? b.updatedAt ?? 0;
          return bTs - aTs;
        });
        const entries = done.slice(0, cap).map((t: any) => {
          const completedAt = t.completedAt ?? t.updatedAt ?? Date.now();
          return {
            taskId: t.id,
            projectId: t.projectId ?? null,
            projectName: t.projectId ? (projectName.get(t.projectId) ?? "Unknown") : "No Project",
            title: t.title,
            assignee: t.assignee as string | undefined,
            priority: t.priority,
            completedAt,
            durationMs: completedAt && t.createdAt ? Math.max(0, completedAt - t.createdAt) : 0,
            description: t.description ? t.description.slice(0, 240) : undefined,
          };
        });
        respond(true, { entries });
        return;
      }

      // ── Local-first: read from kanban.db (getStore) — the source of truth
      // for tasks created via spawn, MCP tool, and autonomous runs. The old
      // localListTasks() path read from databases.db which holds only the seed
      // scaffold (23 rows) and never contains real production tasks, causing
      // the feed to always be empty.
      const store = getStore();
      const [storeProjects, storeTasks] = await Promise.all([
        store.getProjects(),
        store.getTasks(),
      ]);

      // Project name map: kanban.db is primary; merge in databases.db mirror
      // so projects created via the manual UI (which live in databases.db) also
      // show their names instead of "Unknown".
      const projectMap = new Map<string, string>(storeProjects.map((p) => [p.id, p.name]));
      try {
        for (const p of localListProjects()) {
          if (!projectMap.has(p.id)) projectMap.set(p.id, p.name);
        }
      } catch {
        /* best-effort: never block the feed on a mirror failure */
      }

      let doneTasks = (storeTasks as any[]).filter((t) => t.status === "done" || t.done === true);

      if (sinceTs != null) {
        doneTasks = doneTasks.filter((t: any) => (t.completedAt ?? t.updatedAt ?? 0) > sinceTs);
      }

      // Sort newest-first by completedAt (falls back to updatedAt when missing).
      doneTasks.sort((a: any, b: any) => {
        const aTs = a.completedAt ?? a.updatedAt ?? 0;
        const bTs = b.completedAt ?? b.updatedAt ?? 0;
        return bTs - aTs;
      });

      const entries = doneTasks.slice(0, Math.max(1, Math.min(limit, 1000))).map((t: any) => {
        const completedAt = t.completedAt ?? t.updatedAt ?? Date.now();
        return {
          taskId: t.id,
          projectId: t.projectId ?? null,
          projectName: t.projectId ? (projectMap.get(t.projectId) ?? "Unknown") : "No Project",
          title: t.title,
          assignee: t.assignee as string | undefined,
          priority: t.priority,
          completedAt,
          durationMs: completedAt && t.createdAt ? Math.max(0, completedAt - t.createdAt) : 0,
          description: t.description ? t.description.slice(0, 240) : undefined,
        };
      });

      respond(true, { entries });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── GitHub repo metadata ────────────────────────────────────────────────────

  /** Fetch rich repo metadata (description, defaultBranch, stars, visibility)
   *  using `gh repo view --json`. Returns null fields when not available. */
  "kanban.github.repoInfo": async ({ params, respond }) => {
    try {
      const { repoUrl } = params as any;
      if (!repoUrl) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "repoUrl required" });
        return;
      }
      const parsed = parseGitHubRepo(repoUrl);
      if (!parsed) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "Invalid GitHub URL" });
        return;
      }
      const info = await new Promise<{
        name: string;
        description: string | null;
        defaultBranchRef: { name: string } | null;
        stargazerCount: number;
        visibility: string;
      } | null>((resolve) => {
        const child = spawn(
          "gh",
          [
            "repo",
            "view",
            `${parsed.owner}/${parsed.name}`,
            "--json",
            "name,description,defaultBranchRef,stargazerCount,visibility",
          ],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
        );
        let stdout = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
        child.on("close", (code) => {
          if (code !== 0 || !stdout.trim()) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        });
        child.on("error", () => resolve(null));
      });
      if (!info) {
        respond(true, { found: false, owner: parsed.owner, name: parsed.name });
        return;
      }
      respond(true, {
        found: true,
        owner: parsed.owner,
        name: info.name,
        description: info.description ?? null,
        defaultBranch: info.defaultBranchRef?.name ?? null,
        stars: info.stargazerCount ?? 0,
        visibility: info.visibility ?? null,
        url: buildGitHubUrl(parsed.owner, info.name),
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Project ↔ Invoice linking ───────────────────────────────────────────────

  /** List invoices linked to a kanban project + compute paid/pending totals.
   *  Also returns all available invoices for the invoice picker. */
  "kanban.project.invoices.list": async ({ params, respond }) => {
    try {
      const { projectId } = params as any;
      if (!projectId) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "projectId required" });
        return;
      }
      const store = getStore();
      const meta = store.getProjectMeta(projectId);
      const linkedIds = new Set(meta?.linkedInvoiceIds ?? []);

      const opsStore = getAgencyOperationsStore(resolveStateDir());
      const allInvoices = opsStore.listInvoices(DEFAULT_AGENCY_ID);
      const clients = new Map(
        opsStore.listClients(DEFAULT_AGENCY_ID).map((c: any) => [c.id, c.name]),
      );

      const enrich = (inv: any) => ({
        id: inv.id,
        number: inv.number ?? inv.invoiceNumber ?? "",
        clientId: inv.clientId,
        clientName: clients.get(inv.clientId) ?? "Unknown",
        status: inv.status,
        totalCents: inv.totalCents ?? 0,
        amountPaidCents: inv.amountPaidCents ?? 0,
        balanceCents: inv.balanceCents ?? (inv.totalCents ?? 0) - (inv.amountPaidCents ?? 0),
        issuedAt: inv.issuedAt ?? null,
        dueAt: inv.dueAt ?? null,
      });

      const linked = allInvoices.filter((inv: any) => linkedIds.has(inv.id)).map(enrich);
      const available = allInvoices.filter((inv: any) => !linkedIds.has(inv.id)).map(enrich);

      // Compute aggregated totals from linked invoices.
      const paidTotalCents = linked.reduce((s, inv) => s + inv.amountPaidCents, 0);
      const pendingTotalCents = linked.reduce((s, inv) => s + inv.balanceCents, 0);

      respond(true, { linked, available, paidTotalCents, pendingTotalCents });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Set the full list of invoice IDs linked to a kanban project.
   *  Overwrites the existing link set. Recomputes paidAmount / pendingPay on
   *  the project record so display values stay in sync. */
  "kanban.project.invoices.set": async ({ params, respond }) => {
    try {
      const { projectId, invoiceIds } = params as any;
      if (!projectId) {
        respond(false, undefined, { code: "VALIDATION_ERROR", message: "projectId required" });
        return;
      }
      if (!Array.isArray(invoiceIds)) {
        respond(false, undefined, {
          code: "VALIDATION_ERROR",
          message: "invoiceIds must be an array",
        });
        return;
      }
      const store = getStore();
      store.setProjectMeta(projectId, {
        linkedInvoiceIds: invoiceIds.length > 0 ? invoiceIds : null,
      });

      // Compute new paidAmount / pendingPay from the linked invoices.
      const opsStore = getAgencyOperationsStore(resolveStateDir());
      const allInvoices = opsStore.listInvoices(DEFAULT_AGENCY_ID);
      const linked = allInvoices.filter((inv: any) => invoiceIds.includes(inv.id));
      const paidTotalCents = linked.reduce(
        (s: number, inv: any) => s + (inv.amountPaidCents ?? 0),
        0,
      );
      const pendingTotalCents = linked.reduce(
        (s: number, inv: any) =>
          s + Math.max(0, (inv.totalCents ?? 0) - (inv.amountPaidCents ?? 0)),
        0,
      );
      // Sync back to the projects table as USD floats (existing display contract).
      if (invoiceIds.length > 0) {
        void store.updateProject(projectId, {
          paidAmount: paidTotalCents / 100,
          pendingPay: pendingTotalCents / 100,
        });
      }

      respond(true, {
        projectId,
        linkedInvoiceIds: invoiceIds,
        paidTotalCents,
        pendingTotalCents,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

// In satellite mode, proxy kanban CRUD to master (data is master-owned).
// GitHub sync methods validate/sync run locally (git/gh spawn).
// The project-attachment methods (add/upload/removeAttachment) are deliberately
// ABSENT: an attachment is a file in this node's own state dir, so its row must
// stay on the node that holds the bytes. `content.get` is likewise not listed —
// it proxies notes/badges to master by hand and keeps attachments local.
/**
 * Warm the board list cache once after boot so the first Home / kanban load
 * doesn't wait out a full Notion read (tens of seconds on a large board).
 * No-op when Notion sync is off (the local store answers instantly).
 */
export function prewarmKanbanListCache(): void {
  if (!isNotionEnabled()) return;
  resumeKanbanTaskPushes();
  const noop = () => {};
  for (const method of ["kanban.projects.list", "kanban.tasks.list"] as const) {
    try {
      void Promise.resolve(
        _rawKanbanHandlers[method]?.({ params: {}, respond: noop } as any),
      ).catch(() => undefined);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Burst-heuristic key for HQ progress. Interactive clients (control UI,
 * webchat) are grouped per connection; scripts, CLIs and backends are grouped
 * by client identity, because they often open one connection per call (the
 * CLI does) and would otherwise never reach the burst threshold.
 */
export function hqBurstKey(
  client:
    | { connId?: string; connect?: { client?: { id?: string; mode?: string } } }
    | null
    | undefined,
): string {
  const info = client?.connect?.client;
  if (info?.mode && info.mode !== "ui" && info.mode !== "webchat")
    return `client:${info.id ?? "?"}:${info.mode}`;
  return client?.connId ? `conn:${client.connId}` : "internal";
}

export const kanbanHandlers: GatewayRequestHandlers = proxyMethodsToMaster(_rawKanbanHandlers, [
  "kanban.projects.list",
  "kanban.projects.create",
  "kanban.projects.update",
  "kanban.projects.delete",
  "kanban.tasks.list",
  "kanban.tasks.create",
  "kanban.tasks.update",
  "kanban.tasks.delete",
  "kanban.tasks.reorder",
  "kanban.tasks.setRanks",
  "kanban.projects.reorder",
  "kanban.projects.setRanks",
  "kanban.tasks.getRanks",
  "kanban.projects.getRanks",
  "kanban.projects.content.createNote",
  "kanban.projects.content.updateNote",
  "kanban.projects.content.deleteNote",
  "kanban.projects.content.addBadge",
  "kanban.projects.content.removeBadge",
  "kanban.projects.content.getBlocks",
  "kanban.projects.content.saveBlocks",
  "kanban.projects.content.getMarkdown",
  "kanban.projects.content.setMarkdown",
  "kanban.projects.content.appendMarkdown",
  "kanban.listRecentlyCompleted",
]);
