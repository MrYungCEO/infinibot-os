/**
 * Documents workspace — gateway RPC + HTTP helpers.
 *
 * Metadata and markdown travel over the WS RPC (documents.*). Binary traffic
 * (uploads, original files, embedded assets) goes over HTTP; each HTTP call
 * carries a short-lived `t` ticket minted by documents.ticket so the gateway
 * resolves the right per-user workspace (mandatory in hosted/SaaS mode).
 */

import { ensureGatewaySession, gatewayHttpBase } from "../../gateway-http-auth";
import type { DocTypeDef, LibraryResult } from "./doc-types";
import type { LibraryIdeaLike } from "../../../../../src/documents/library.js";
import type { DocDetail, DocSummary } from "./model";

export interface RpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface NotionSearchResult {
  id: string;
  type: "page" | "database";
  title: string;
  icon?: string | null;
  url?: string;
  lastEditedTime?: string;
  parentType?: string;
}

export interface ImportReport {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ id?: string; error: string; title?: string }>;
  rootNodeIds?: string[];
}

export type ImportJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Server-side background import job (documents.notion.jobs.* / documents.import.progress). */
export interface ImportJob {
  id: string;
  kind: "notion" | "notion-zip" | "obsidian" | "map";
  status: ImportJobStatus;
  mode: "full" | "changes";
  force: boolean;
  ids: string[];
  parentId: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  cancelRequested?: boolean;
  progress: {
    phase: string;
    done: number;
    total: number;
    current: string | null;
    rateLimitedUntil: string | null;
    requests: number;
    rateLimited: number;
  };
  report: ImportReport;
  errorCount: number;
  error?: string;
  obsidian?: { source: "folder" | "zip" | "git"; origin: string; vaultName: string; createTasks: boolean; tasksProject?: string };
  map?: { folderId: string; role: MappingRole };
  /** Obsidian counts ({notes, links, attachments, tasks…}) / mapping report. */
  details?: Record<string, unknown>;
  /** Journaled changes this batch can undo (0/undefined = nothing). */
  undoable?: number;
  undoneAt?: string;
  undoReport?: { trashed: number; restored: number; entitiesDeleted: number; entitiesRestored: number; errors: string[] };
}

export type MappingRole = "projects" | "tasks" | "clients";

export interface ImportCollection {
  id: string;
  title: string;
  path: string;
  source: string | null;
  rows: number;
  columns: number;
  suggestedRole: MappingRole | null;
}

export interface MappingPreview {
  folderId: string;
  folderTitle: string;
  role: MappingRole;
  suggestedRole: MappingRole | null;
  columns: Array<{ key: string; name: string; type: string }>;
  fields: Array<{ key: string; label: string; required?: boolean }>;
  fieldMap: Record<string, string>;
  total: number;
  create: number;
  update: number;
  sample: Array<{ title: string; values: Record<string, unknown>; action: "create" | "update" }>;
}

export function isJobActive(job: ImportJob | null | undefined): boolean {
  return !!job && (job.status === "queued" || job.status === "running");
}

const TICKET_REFRESH_MS = 60 * 60_000;

export class DocumentsApi {
  private ticket: { value: string; at: number } | null = null;
  private sessionReady: Promise<boolean> | null = null;

  constructor(private readonly client: RpcClient) {}

  tree() {
    return this.client.request<{ nodes: DocSummary[]; migratedNotesAt?: string }>("documents.tree", {});
  }
  get(id: string) {
    return this.client.request<DocDetail>("documents.get", { id });
  }
  search(query: string, folderId?: string | null) {
    return this.client.request<{ hits: Array<{ id: string; kind: DocSummary["kind"]; title: string; path: string; snippet: string }> }>(
      "documents.search",
      { query, folderId: folderId ?? undefined, limit: 60 },
    );
  }
  trash() {
    return this.client.request<{ nodes: DocSummary[] }>("documents.trash", {});
  }
  create(p: { kind: "doc" | "folder"; title: string; parentId: string | null; body?: string; type?: string; category?: string }) {
    return this.client.request<{ node: DocSummary }>("documents.create", p);
  }
  // ── types / library ──
  types() {
    return this.client.request<{ types: DocTypeDef[] }>("documents.types.list", {});
  }
  library(p: { type?: string; category?: string; query?: string; limit?: number } = {}) {
    return this.client.request<LibraryResult & { types: DocTypeDef[]; errors?: string[] }>("documents.library", p);
  }
  createType(p: { label: string; icon?: string; color?: string; template?: string; description?: string }) {
    return this.client.request<{ type: DocTypeDef; types: DocTypeDef[] }>("documents.types.create", p);
  }
  updateType(p: { id: string; label?: string; icon?: string; color?: string; template?: string; hidden?: boolean; archived?: boolean }) {
    return this.client.request<{ type: DocTypeDef; types: DocTypeDef[] }>("documents.types.update", p);
  }
  reorderTypes(ids: string[]) {
    return this.client.request<{ types: DocTypeDef[] }>("documents.types.reorder", { ids });
  }
  ideas() {
    return this.client.request<{ ideas: LibraryIdeaLike[] }>("ideas.list", { limit: 1000 });
  }
  createIdea(p: { title: string; body?: string; tags?: string[] }) {
    return this.client.request<{ idea: { id: string; title: string } }>("ideas.create", { ...p, source: "web" });
  }
  update(p: {
    id: string;
    title?: string;
    body?: string;
    type?: string;
    category?: string;
    favorite?: boolean;
    icon?: string;
    properties?: Record<string, unknown>;
    view?: DocSummary["view"];
    snapshot?: boolean;
  }) {
    return this.client.request<{ node: DocSummary }>("documents.update", p);
  }
  move(id: string, parentId: string | null, index?: number) {
    return this.client.request<{ node: DocSummary }>("documents.move", { id, parentId, index });
  }
  remove(id: string) {
    return this.client.request("documents.delete", { id });
  }
  restore(id: string) {
    return this.client.request<{ node: DocSummary }>("documents.restore", { id });
  }
  purge(id: string) {
    return this.client.request("documents.purge", { id });
  }
  history(id: string) {
    return this.client.request<{ revisions: Array<{ rev: string; at: string; title: string; bodyLength: number; author?: string }> }>(
      "documents.history",
      { id },
    );
  }
  revision(id: string, rev: string) {
    return this.client.request<{ title: string; body: string; at: string }>("documents.revision", { id, rev });
  }
  restoreRevision(id: string, rev: string) {
    return this.client.request<{ node: DocSummary }>("documents.restoreRevision", { id, rev });
  }
  reextract(id: string) {
    return this.client.request<{ node: DocSummary }>("documents.reextract", { id });
  }
  uploadUrl(url: string, parentId: string | null) {
    return this.client.request<{ node: DocSummary }>("documents.uploadUrl", { url, parentId });
  }
  notionStatus() {
    return this.client.request<{ connected: boolean }>("documents.notion.status", {});
  }
  notionSearch(query: string, token?: string) {
    return this.client.request<{ results: NotionSearchResult[] }>("documents.notion.search", { query, token: token || undefined });
  }
  /** Starts a background job and returns at once (progress: documents.import.progress). */
  notionImport(
    ids: string[],
    parentId: string | null,
    opts: { mode?: "full" | "changes"; force?: boolean; token?: string; label?: string } = {},
  ) {
    return this.client.request<{ jobId: string; reattached: boolean; job: ImportJob }>("documents.notion.import", {
      ids,
      parentId,
      mode: opts.mode ?? "full",
      force: opts.force || undefined,
      token: opts.token || undefined,
      label: opts.label || undefined,
    });
  }
  importJob(jobId: string) {
    return this.client.request<{ job: ImportJob }>("documents.notion.jobs.get", { jobId });
  }
  importJobs(opts: { active?: boolean; limit?: number } = {}) {
    return this.client.request<{ jobs: ImportJob[] }>("documents.notion.jobs.list", opts);
  }
  cancelImportJob(jobId: string) {
    return this.client.request<{ job: ImportJob }>("documents.notion.jobs.cancel", { jobId });
  }
  /** Obsidian vault from a local folder or https git URL (background job). */
  obsidianImport(p: { source: "folder" | "git"; path?: string; url?: string; parentId: string | null; createTasks?: boolean; vaultName?: string; force?: boolean }) {
    return this.client.request<{ jobId: string; reattached: boolean; job: ImportJob }>("documents.obsidian.import", p);
  }
  undoImport(jobId: string) {
    return this.client.request<{ job: ImportJob }>("documents.import.undo", { jobId });
  }
  importCollections() {
    return this.client.request<{ collections: ImportCollection[] }>("documents.import.collections", {});
  }
  mappingPreview(folderId: string, role: MappingRole | null, fieldMap?: Record<string, string>) {
    return this.client.request<{ preview: MappingPreview }>("documents.import.mapping.preview", { folderId, role, fieldMap });
  }
  mappingApply(folderId: string, role: MappingRole, fieldMap?: Record<string, string>) {
    return this.client.request<{ jobId: string; job: ImportJob }>("documents.import.mapping.apply", { folderId, role, fieldMap });
  }


  // ── HTTP (binary) ──────────────────────────────────────────

  private uploadLimit: Promise<number | null> | null = null;

  /** Per-file upload cap on hosted workspaces (null = none / unknown). */
  maxUploadBytes(): Promise<number | null> {
    this.uploadLimit ??= this.client
      .request<{ limits?: { maxUploadBytes?: number } | null }>("documents.notion.status", {})
      .then((r) => (typeof r.limits?.maxUploadBytes === "number" ? r.limits.maxUploadBytes : null))
      .catch(() => {
        this.uploadLimit = null; // retry next time
        return null;
      });
    return this.uploadLimit;
  }

  async getTicket(): Promise<string> {
    if (this.ticket && Date.now() - this.ticket.at < TICKET_REFRESH_MS) return this.ticket.value;
    const r = await this.client.request<{ ticket: string }>("documents.ticket", {});
    this.ticket = { value: r.ticket, at: Date.now() };
    return r.ticket;
  }

  /** Make sure <iframe>/<img>/<video> requests carry the gateway session cookie. */
  ensureSession(): Promise<boolean> {
    if (!this.sessionReady) this.sessionReady = ensureGatewaySession().catch(() => false);
    return this.sessionReady;
  }

  fileUrl(id: string, ticket: string, download = false): string {
    const q = new URLSearchParams({ t: ticket });
    if (download) q.set("download", "1");
    return `${gatewayHttpBase()}/api/documents/file/${encodeURIComponent(id)}?${q}`;
  }

  /** Upload raw bytes. mode: default (file/doc node), "asset" (editor image), "notion-zip". */
  async upload<T = { ok: boolean; node?: DocSummary; url?: string; jobId?: string; job?: ImportJob; error?: string }>(
    file: File | Blob,
    opts: {
      parentId: string | null;
      name: string;
      mode?: "asset" | "notion-zip" | "obsidian-zip";
      extra?: Record<string, string>;
      onProgress?: (pct: number) => void;
    },
  ): Promise<T> {
    // Hosted workspaces cap uploads: refuse locally with a clear message
    // instead of streaming a file the gateway will reject.
    const max = await this.maxUploadBytes();
    if (max !== null && file.size > max) {
      throw new Error(`File too large (limit ${Math.round(max / (1024 * 1024))} MB)`);
    }
    const ticket = await this.getTicket();
    const q = new URLSearchParams({ name: opts.name, t: ticket });
    if (opts.parentId) q.set("parentId", opts.parentId);
    if (opts.mode) q.set("mode", opts.mode);
    for (const [k, v] of Object.entries(opts.extra ?? {})) q.set(k, v);
    const res = await fetch(`${gatewayHttpBase()}/api/documents/upload?${q}`, {
      method: "POST",
      body: file,
      headers: { "Content-Type": (file as File).type || "application/octet-stream" },
      // No explicit credentials: the gateway fetch wrapper adds the Bearer and
      // decides on cookies (never for the hosted cloud's cross-site gateway).
    });
    const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T & { ok?: boolean; error?: string };
    if (!res.ok || json.ok === false) throw new Error(json.error || `Upload failed (HTTP ${res.status})`);
    opts.onProgress?.(100);
    return json;
  }
}
