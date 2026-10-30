/**
 * Documents workspace RPCs (documents.*). Thin wrappers over
 * src/documents/service.ts, which also backs the agent `notes` tool's document
 * actions — one store, one change broadcast (`notes:changed`, documents:true).
 */

import { getScopedUserId } from "../../config/paths.js";
import {
  appendDoc,
  createDoc,
  deleteDoc,
  docTypes,
  documentsStore,
  importChanged,
  listLibrary,
  moveDoc,
  purgeDoc,
  reextractFile,
  restoreDoc,
  restoreRevision,
  summarize,
  updateDoc,
  uploadFromUrl,
} from "../../documents/service.js";
import { migrateNotesIntoDocuments } from "../../documents/notes-bridge.js";
import { applyTypeMigration, planTypeMigration } from "../../documents/type-migration.js";
import { broadcastDocumentsChanged } from "../../notes/notes-events.js";
import { documentsLimits, isSaasDocuments } from "../../documents/tenant-limits.js";
import type { DocFolderView, DocPropertyColumn, DocPropertyValue } from "../../documents/types.js";
import { mintDocumentsTicket } from "../server-documents-http.js";
import type { GatewayRequestHandlers } from "./types.js";

const EXTRACT_RESPONSE_CAP = 400_000;

type P = Record<string, unknown>;

function str(p: P, k: string): string | undefined {
  const v = p[k];
  return typeof v === "string" ? v : undefined;
}

function req(p: P, k: string): string {
  const v = str(p, k)?.trim();
  if (!v) throw new Error(`${k} is required`);
  return v;
}

function parentOf(p: P): string | null {
  const v = p.parentId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function wrap(fn: (p: P) => unknown | Promise<unknown>): GatewayRequestHandlers[string] {
  return async ({ params, respond }) => {
    try {
      respond(true, await fn((params ?? {}) as P));
    } catch (err) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: String((err as Error)?.message ?? err),
      });
    }
  };
}

async function notionApiKey(p: P): Promise<string> {
  const explicit = str(p, "token")?.trim();
  if (explicit) return explicit;
  const { getNotionApiKeyForImport } = await import("../../databases/notion-config.js");
  // SaaS: only the tenant's own token (config written by the tenant, or the
  // one passed in) — never an operator NOTION_API_KEY from the process env.
  let key = getNotionApiKeyForImport();
  if (isSaasDocuments() && key && key === process.env.NOTION_API_KEY?.trim()) key = null;
  if (!key)
    throw new Error(
      "Notion is not connected — add an integration token (Settings → Notion) or pass token",
    );
  return key;
}

export const documentsHandlers: GatewayRequestHandlers = {
  "documents.tree": wrap((p) => {
    const store = documentsStore();
    const nodes = store
      .tree({ includeDeleted: p.includeDeleted === true })
      .map((n) => summarize(store, n));
    return { nodes, count: nodes.length, migratedNotesAt: store.getMeta().migratedNotesAt };
  }),

  "documents.get": wrap((p) => {
    const store = documentsStore();
    const id = req(p, "id");
    const node = store.getNode(id) ?? store.findBySource("note", id);
    if (!node) throw new Error(`Document "${id}" not found`);
    const extracted = node.kind === "file" ? store.getExtracted(node.id) : undefined;
    return {
      node: summarize(store, node),
      body: node.kind === "doc" ? store.getBody(node.id) : undefined,
      extracted: extracted?.slice(0, EXTRACT_RESPONSE_CAP),
      extractedTruncated: extracted ? extracted.length > EXTRACT_RESPONSE_CAP : undefined,
      breadcrumbs: store.pathOf(node.id).map((n) => ({ id: n.id, title: n.title, kind: n.kind })),
      children:
        node.kind === "folder"
          ? store.children(node.id).map((n) => summarize(store, n))
          : undefined,
      backlinks:
        node.kind === "doc"
          ? store.backlinks(node.id).map((n) => ({ id: n.id, title: n.title }))
          : [],
      outgoing:
        node.kind === "doc"
          ? store.outgoingLinks(node.id).map((l) => ({
              target: l.target,
              id: l.node?.id ?? null,
              title: l.node?.title ?? null,
            }))
          : [],
    };
  }),

  "documents.search": wrap((p) => {
    const store = documentsStore();
    const hits = store.search(str(p, "query") ?? "", {
      limit: typeof p.limit === "number" ? p.limit : 50,
      parentId: str(p, "folderId") ?? null,
    });
    return { hits, count: hits.length };
  }),

  "documents.recent": wrap((p) => {
    const store = documentsStore();
    return {
      nodes: store
        .recent(typeof p.limit === "number" ? p.limit : 20)
        .map((n) => summarize(store, n)),
    };
  }),

  "documents.trash": wrap(() => {
    const store = documentsStore();
    return { nodes: store.trash().map((n) => summarize(store, n)) };
  }),

  "documents.history": wrap((p) => ({ revisions: documentsStore().history(req(p, "id")) })),

  "documents.revision": wrap((p) => {
    const r = documentsStore().revision(req(p, "id"), req(p, "rev"));
    if (!r) throw new Error("Revision not found");
    return r;
  }),

  "documents.backlinks": wrap((p) => ({
    nodes: documentsStore()
      .backlinks(req(p, "id"))
      .map((n) => ({ id: n.id, title: n.title })),
  })),

  /** Short-lived ticket for HTTP upload/file/asset routes (carries the tenant scope). */
  "documents.ticket": wrap(() => ({ ticket: mintDocumentsTicket(getScopedUserId()) })),

  "documents.create": wrap((p) => {
    const kind = p.kind === "folder" ? "folder" : "doc";
    const node = createDoc({
      kind,
      title: str(p, "title") ?? "",
      parentId: parentOf(p),
      body: str(p, "body"),
      icon: str(p, "icon"),
      type: kind === "doc" ? str(p, "type") : undefined,
      category: kind === "doc" ? str(p, "category") : undefined,
      tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
      properties: p.properties as Record<string, DocPropertyValue> | undefined,
      schema: p.schema as DocPropertyColumn[] | undefined,
      view: p.view as DocFolderView | undefined,
      author: "user",
    });
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.update": wrap((p) => {
    const node = updateDoc({
      id: req(p, "id"),
      title: str(p, "title"),
      body: str(p, "body"),
      icon: str(p, "icon"),
      type: str(p, "type"),
      category: str(p, "category"),
      favorite: typeof p.favorite === "boolean" ? p.favorite : undefined,
      tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
      properties: p.properties as Record<string, DocPropertyValue> | undefined,
      schema: p.schema as DocPropertyColumn[] | undefined,
      view: p.view as DocFolderView | undefined,
      snapshot: p.snapshot === true,
      author: "user",
    });
    if (!node) throw new Error("Document not found");
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.append": wrap((p) => {
    const node = appendDoc(req(p, "id"), req(p, "markdown"), "user");
    if (!node) throw new Error("Document not found (or not a doc)");
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.move": wrap((p) => {
    const node = moveDoc(
      req(p, "id"),
      parentOf(p),
      typeof p.index === "number" ? p.index : undefined,
    );
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.delete": wrap((p) => {
    const node = deleteDoc(req(p, "id"));
    if (!node) throw new Error("Document not found");
    return { ok: true, id: node.id };
  }),

  "documents.restore": wrap((p) => {
    const node = restoreDoc(req(p, "id"));
    if (!node) throw new Error("Document not found");
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.purge": wrap((p) => ({ removed: purgeDoc(req(p, "id")) })),

  "documents.restoreRevision": wrap((p) => {
    const node = restoreRevision(req(p, "id"), req(p, "rev"), "user");
    if (!node) throw new Error("Revision not found");
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.uploadUrl": wrap(async (p) => {
    const node = await uploadFromUrl({
      url: req(p, "url"),
      parentId: parentOf(p),
      name: str(p, "name"),
      author: "user",
    });
    return { node: summarize(documentsStore(), node) };
  }),

  "documents.reextract": wrap(async (p) => {
    const node = await reextractFile(req(p, "id"));
    if (!node) throw new Error("File not found");
    return { node: summarize(documentsStore(), node) };
  }),

  // ── Types / categories + typed library ─────────────────────
  "documents.types.list": wrap(() => ({ types: docTypes().list() })),

  "documents.types.create": wrap((p) => {
    const type = docTypes().create({
      label: p.label,
      icon: p.icon,
      color: p.color,
      template: p.template,
      description: p.description,
    });
    broadcastDocumentsChanged({ op: "update", id: `type:${type.id}`, name: type.label });
    return { type, types: docTypes().list() };
  }),

  "documents.types.update": wrap((p) => {
    const id = req(p, "id");
    const patch: Record<string, unknown> = {};
    for (const k of ["label", "icon", "color", "template", "description", "hidden", "archived"]) {
      if (p[k] !== undefined) patch[k] = p[k];
    }
    const type = docTypes().update(id, patch);
    broadcastDocumentsChanged({ op: "update", id: `type:${type.id}`, name: type.label });
    return { type, types: docTypes().list() };
  }),

  "documents.types.reorder": wrap((p) => {
    const types = docTypes().reorder(p.ids);
    broadcastDocumentsChanged({ op: "update", id: "type:order" });
    return { types };
  }),

  "documents.types.archive": wrap((p) => {
    const type = docTypes().archive(req(p, "id"), p.archived !== false);
    broadcastDocumentsChanged({ op: "update", id: `type:${type.id}`, name: type.label });
    return { type, types: docTypes().list() };
  }),

  /** Dry run by default; `apply: true` backs up index.json and writes the inferred types. */
  "documents.types.migrate": wrap((p) => {
    const store = documentsStore();
    const custom = docTypes(store).list();
    const report =
      p.apply === true ? applyTypeMigration(store, custom) : planTypeMigration(store, custom);
    if (!report.dryRun && report.applied) broadcastDocumentsChanged({ op: "import", id: "types" });
    return {
      report: {
        ...report,
        changes: report.changes.slice(0, typeof p.limit === "number" ? p.limit : 500),
      },
    };
  }),

  /** Typed list across documents + ideas + reports + research (sidebar counts included). */
  "documents.library": wrap(async (p) => {
    const include = Array.isArray(p.include)
      ? (p.include.filter((x) => x === "ideas" || x === "reports" || x === "research") as Array<
          "ideas" | "reports" | "research"
        >)
      : undefined;
    return await listLibrary({
      type: str(p, "type")?.trim() || undefined,
      category: str(p, "category")?.trim() || undefined,
      query: str(p, "query"),
      limit: typeof p.limit === "number" ? p.limit : undefined,
      include,
    });
  }),

  "documents.migrateNotes": wrap(() => {
    const report = migrateNotesIntoDocuments(documentsStore());
    importChanged(report.folderId ? [report.folderId] : []);
    return report;
  }),

  "documents.notion.status": wrap(async () => {
    const connected = await notionApiKey({}).then(
      () => true,
      () => false,
    );
    const limits = isSaasDocuments() ? documentsLimits() : null;
    // Every import runs as a background job (import-jobs.ts).
    return { connected, background: true, limits };
  }),

  "documents.notion.search": wrap(async (p) => {
    const { createNotionClient, searchNotion } =
      await import("../../documents/notion/api-import.js");
    const client = createNotionClient({ apiKey: await notionApiKey(p) });
    return { results: await searchNotion(client, str(p, "query") ?? "") };
  }),

  /**
   * Start a background Notion import job and return at once with `{ jobId }`
   * (a full workspace import runs for minutes at Notion's rate limit — far
   * past any request timeout). Progress arrives as `documents.import.progress`
   * events; poll with documents.notion.jobs.get. An identical active job is
   * reattached instead of started twice. `waitMs` (≤ 50s) optionally waits for
   * small imports to finish and returns the final job inline.
   */
  "documents.notion.import": wrap(async (p) => {
    const v = validateNotionImportParams(p);
    const token = str(p, "token")?.trim();
    if (!token) await notionApiKey(p); // fail fast when Notion isn't connected
    const { importJobs } = await import("../../documents/import-jobs.js");
    const jobs = await importJobs();
    const { job, reattached } = jobs.startNotion({ ...v, token: token || undefined });
    const final = v.waitMs ? await jobs.wait(job.id, v.waitMs) : null;
    return { jobId: job.id, reattached, job: final ?? job };
  }),

  "documents.notion.jobs.get": wrap(async (p) => {
    const { importJobs } = await import("../../documents/import-jobs.js");
    const job = (await importJobs()).get(jobIdParam(p));
    if (!job) throw new Error("Import job not found");
    return { job };
  }),

  "documents.notion.jobs.list": wrap(async (p) => {
    if (p.active !== undefined && typeof p.active !== "boolean") {
      throw new Error("active must be a boolean");
    }
    if (p.limit !== undefined && (typeof p.limit !== "number" || !Number.isFinite(p.limit))) {
      throw new Error("limit must be a number");
    }
    const { importJobs } = await import("../../documents/import-jobs.js");
    return {
      jobs: (await importJobs()).list({
        active: p.active === true,
        limit: typeof p.limit === "number" ? p.limit : undefined,
      }),
    };
  }),

  "documents.notion.jobs.cancel": wrap(async (p) => {
    const { importJobs } = await import("../../documents/import-jobs.js");
    const job = (await importJobs()).cancel(jobIdParam(p));
    if (!job) throw new Error("Import job not found");
    return { job };
  }),

  /**
   * Start a background Obsidian vault import from a local folder or a public
   * https git URL (self-hosted only; hosted plans upload a ZIP to
   * /api/documents/upload?mode=obsidian-zip). Jobs share the Notion job
   * plumbing: poll documents.notion.jobs.get, progress via documents.import.progress.
   */
  "documents.obsidian.import": wrap(async (p) => {
    const v = validateObsidianImportParams(p);
    if (isSaasDocuments()) {
      throw new Error("Hosted plans import Obsidian vaults as a ZIP upload");
    }
    if (v.source === "folder") {
      const fs = await import("node:fs");
      let ok = false;
      try {
        ok = fs.statSync(v.origin).isDirectory();
      } catch {
        ok = false;
      }
      if (!ok) throw new Error(`Folder not found: ${v.origin}`);
    }
    const { importJobs } = await import("../../documents/import-jobs.js");
    const jobs = await importJobs();
    const { job, reattached } = jobs.startObsidian(v);
    const final = v.waitMs ? await jobs.wait(job.id, v.waitMs) : null;
    return { jobId: job.id, reattached, job: final ?? job };
  }),

  /** Undo a finished import or mapping batch (created docs → Trash, edits reverted, mapped rows removed). */
  "documents.import.undo": wrap(async (p) => {
    const { importJobs } = await import("../../documents/import-jobs.js");
    const job = await (await importJobs()).undo(jobIdParam(p));
    if (!job) throw new Error("Import job not found");
    importChanged([]);
    return { job };
  }),

  /** Imported collections (database folders / vault folders with notes) that can be mapped. */
  "documents.import.collections": wrap(async () => {
    const { collectionColumns, rowsOf, suggestRole } =
      await import("../../documents/import-mapping.js");
    const store = documentsStore();
    const out = [];
    for (const n of store.tree()) {
      if (n.kind !== "folder") continue;
      const imported =
        n.source?.type === "notion" ||
        n.source?.type === "notion-zip" ||
        n.source?.type === "obsidian";
      if (!n.schema?.length && !imported) continue;
      const rows = rowsOf(store, n.id);
      if (!rows.length) continue;
      const columns = collectionColumns(store, n);
      out.push({
        id: n.id,
        title: n.title,
        path: store.pathString(n.id),
        source: n.source?.type ?? null,
        rows: rows.length,
        columns: columns.length,
        suggestedRole: suggestRole(n, columns),
      });
    }
    return { collections: out.slice(0, 500) };
  }),

  /** Dry run: how a collection would map onto projects / tasks / clients. */
  "documents.import.mapping.preview": wrap(async (p) => {
    const { buildPreview } = await import("../../documents/import-mapping.js");
    const { ImportLedger } = await import("../../documents/import-journal.js");
    const store = documentsStore();
    const role = p.role === undefined || p.role === null ? null : mappingRoleParam(p);
    return {
      preview: buildPreview(
        store,
        req(p, "folderId"),
        role,
        fieldMapParam(p),
        ImportLedger.forStore(store),
      ),
    };
  }),

  /** Write a collection into projects / tasks / clients (recorded as an undoable "map" job). */
  "documents.import.mapping.apply": wrap(async (p) => {
    const { importJobs } = await import("../../documents/import-jobs.js");
    const job = await (
      await importJobs()
    ).runMapping({
      folderId: req(p, "folderId"),
      role: mappingRoleParam(p),
      fieldMap: fieldMapParam(p),
      defaultProjectId: str(p, "defaultProjectId")?.trim() || undefined,
    });
    return { jobId: job.id, job };
  }),
};

const MAPPING_ROLE_SET = new Set(["projects", "tasks", "clients"]);

function mappingRoleParam(p: P): "projects" | "tasks" | "clients" {
  const r = str(p, "role");
  if (!r || !MAPPING_ROLE_SET.has(r))
    throw new Error('role must be "projects", "tasks" or "clients"');
  return r as "projects" | "tasks" | "clients";
}

function fieldMapParam(p: P): Record<string, string> | undefined {
  if (p.fieldMap === undefined || p.fieldMap === null) return undefined;
  if (typeof p.fieldMap !== "object" || Array.isArray(p.fieldMap))
    throw new Error("fieldMap must be an object");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.fieldMap as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length > 300)
      throw new Error("fieldMap values must be column keys");
    out[k] = v;
  }
  return out;
}

/** Schema check for documents.obsidian.import params. */
export function validateObsidianImportParams(p: P): {
  source: "folder" | "git";
  origin: string;
  parentId: string | null;
  vaultName?: string;
  createTasks: boolean;
  tasksProject?: string;
  force: boolean;
  waitMs: number;
} {
  const source = str(p, "source") ?? (str(p, "url") ? "git" : "folder");
  if (source !== "folder" && source !== "git") throw new Error('source must be "folder" or "git"');
  const origin = (source === "git" ? str(p, "url") : str(p, "path"))?.trim();
  if (!origin) throw new Error(source === "git" ? "url is required" : "path is required");
  if (origin.length > 2000) throw new Error("path/url is too long");
  if (source === "git") {
    if (!/^https:\/\//i.test(origin)) throw new Error("Only https:// git URLs are supported");
  }
  for (const k of ["vaultName", "tasksProject"]) {
    if (p[k] !== undefined && (typeof p[k] !== "string" || (p[k] as string).length > 200)) {
      throw new Error(`${k} must be a string`);
    }
  }
  if (p.createTasks !== undefined && typeof p.createTasks !== "boolean")
    throw new Error("createTasks must be a boolean");
  if (p.force !== undefined && typeof p.force !== "boolean")
    throw new Error("force must be a boolean");
  return {
    source,
    origin: source === "folder" ? expandHome(origin) : origin,
    parentId: parentOf(p),
    vaultName: str(p, "vaultName")?.trim() || undefined,
    createTasks: p.createTasks === true,
    tasksProject: str(p, "tasksProject")?.trim() || undefined,
    force: p.force === true,
    waitMs: Math.max(0, Math.min(typeof p.waitMs === "number" ? p.waitMs : 0, 50_000)),
  };
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return `${process.env.HOME ?? ""}${p.slice(1)}`;
  }
  return p;
}

const NOTION_MODES = new Set(["full", "changes"]);
const MAX_IMPORT_IDS = 100;

function jobIdParam(p: P): string {
  const id = req(p, "jobId");
  if (!/^imp_[a-z0-9_]{4,64}$/i.test(id)) throw new Error("jobId is not a valid import job id");
  return id;
}

/** Schema check for documents.notion.import params (rejects malformed input with a clear message). */
export function validateNotionImportParams(p: P): {
  ids: string[];
  parentId: string | null;
  mode: "full" | "changes";
  force: boolean;
  label?: string;
  waitMs: number;
} {
  if (!Array.isArray(p.ids) || !p.ids.length) {
    throw new Error("ids (Notion page/database ids) required");
  }
  if (p.ids.length > MAX_IMPORT_IDS) throw new Error(`at most ${MAX_IMPORT_IDS} ids per import`);
  const ids = p.ids.map((x) => {
    if (typeof x !== "string" || !x.trim() || x.length > 500) {
      throw new Error("ids must be non-empty strings (Notion ids or URLs)");
    }
    return x.trim();
  });
  if (p.parentId !== undefined && p.parentId !== null && typeof p.parentId !== "string") {
    throw new Error("parentId must be a string or null");
  }
  if (p.mode !== undefined && (typeof p.mode !== "string" || !NOTION_MODES.has(p.mode))) {
    throw new Error('mode must be "full" or "changes"');
  }
  if (p.force !== undefined && typeof p.force !== "boolean")
    throw new Error("force must be a boolean");
  if (p.token !== undefined && (typeof p.token !== "string" || p.token.length > 500)) {
    throw new Error("token must be a string");
  }
  if (p.label !== undefined && (typeof p.label !== "string" || p.label.length > 300)) {
    throw new Error("label must be a string");
  }
  if (p.waitMs !== undefined && (typeof p.waitMs !== "number" || !Number.isFinite(p.waitMs))) {
    throw new Error("waitMs must be a number");
  }
  return {
    ids,
    parentId: parentOf(p),
    mode: (p.mode as "full" | "changes" | undefined) ?? "full",
    force: p.force === true,
    label: str(p, "label"),
    waitMs: Math.max(0, Math.min(typeof p.waitMs === "number" ? p.waitMs : 0, 50_000)),
  };
}

export const DOCUMENTS_READ_METHODS = [
  "documents.tree",
  "documents.get",
  "documents.search",
  "documents.recent",
  "documents.trash",
  "documents.history",
  "documents.revision",
  "documents.backlinks",
  "documents.ticket",
  "documents.notion.status",
  "documents.notion.search",
  "documents.notion.jobs.get",
  "documents.notion.jobs.list",
  "documents.import.collections",
  "documents.import.mapping.preview",
  "documents.types.list",
  "documents.library",
];

export const DOCUMENTS_WRITE_METHODS = [
  "documents.create",
  "documents.update",
  "documents.append",
  "documents.move",
  "documents.delete",
  "documents.restore",
  "documents.purge",
  "documents.restoreRevision",
  "documents.uploadUrl",
  "documents.reextract",
  "documents.migrateNotes",
  "documents.notion.import",
  "documents.notion.jobs.cancel",
  "documents.obsidian.import",
  "documents.import.undo",
  "documents.import.mapping.apply",
  "documents.types.create",
  "documents.types.update",
  "documents.types.reorder",
  "documents.types.archive",
  "documents.types.migrate",
];
