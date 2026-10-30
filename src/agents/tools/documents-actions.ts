/**
 * Documents-workspace actions for the agent `notes` tool.
 *
 * Kept in its own module so the notes tool only gains a dispatch line; all
 * logic goes through src/documents/service.ts (the same code path as the
 * documents.* RPCs), so agent writes stream into open Documents tabs live.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  appendDoc,
  assertAssignableType,
  createDoc,
  deleteDoc,
  docTypes,
  documentsStore,
  listLibrary,
  moveDoc,
  restoreDoc,
  summarize,
  updateDoc,
  uploadFromPath,
  uploadFromUrl,
} from "../../documents/service.js";
import type { ImportJobView } from "../../documents/import-jobs.js";
import { getNote, syncNoteIntoDocuments } from "../../documents/notes-bridge.js";
import type { DocNode, DocPropertyValue } from "../../documents/types.js";

export const DOCUMENT_ACTIONS = [
  "tree",
  "library",
  "doc_types",
  "read",
  "doc_search",
  "create_doc",
  "update_doc",
  "append_doc",
  "create_folder",
  "move_doc",
  "delete_doc",
  "restore_doc",
  "doc_history",
  "upload_url",
  "upload_path",
  "import_notion",
  "import_notion_zip",
  "import_obsidian",
  "import_status",
  "import_undo",
  "import_collections",
  "import_map_preview",
  "import_map",
] as const;

export const DocumentActionParams = {
  /**
   * Document type id: note, document, meeting, research, sop, spec, brief,
   * journal, plan, template, snippet, idea (→ Ideas store), or a custom type
   * id from doc_types. create/create_doc/update_doc set it; list/search/library
   * filter by it.
   */
  type: Type.Optional(Type.String()),
  /** Documents: target folder id for create/move/upload/import (empty = root). */
  parentId: Type.Optional(Type.String()),
  /** Documents: limit tree/doc_search to this folder's subtree. */
  folderId: Type.Optional(Type.String()),
  /** Documents: document title (create_doc/create_folder/update_doc). */
  title: Type.Optional(Type.String()),
  /** Documents: JSON object of row properties for update_doc/create_doc. */
  properties: Type.Optional(Type.String()),
  /** Documents: local file path (upload_path, import_notion_zip). */
  path: Type.Optional(Type.String()),
  /** Documents: http(s) URL (upload_url). */
  url: Type.Optional(Type.String()),
  /** Documents: comma-separated Notion page/database ids or URLs (import_notion). */
  notionIds: Type.Optional(Type.String()),
  /** Documents: force a full Notion refetch even if unchanged. */
  force: Type.Optional(Type.Boolean()),
  /** Documents imports: background job id (import_status / import_undo). */
  jobId: Type.Optional(Type.String()),
  /** import_obsidian: also turn "- [ ]" tasks into kanban tasks. */
  createTasks: Type.Optional(Type.Boolean()),
  /** import_map / import_map_preview: target store — projects, tasks or clients. */
  role: Type.Optional(Type.String()),
  /** import_map: JSON object of target field → column key (from import_map_preview). */
  fieldMap: Type.Optional(Type.String()),
};

const READ_CAP = 120_000;
const AGENT_IMPORT_WAIT_MS = 45_000;

function importJobResult(job: ImportJobView | null) {
  if (!job) return { status: "error", error: "import job vanished" };
  if (job.status === "done") return { status: "ok", jobId: job.id, report: job.report };
  if (job.status === "failed" || job.status === "cancelled") {
    return {
      status: "error",
      jobId: job.id,
      error: job.error ?? `import ${job.status}`,
      report: job.report,
    };
  }
  return {
    status: "running",
    jobId: job.id,
    message:
      `Import still running in the background (${job.progress.done}/${job.progress.total} pages so far). ` +
      "It continues on its own and shows live progress in the Documents import dialog; " +
      "call import_notion again with the same notionIds to check on it.",
    progress: job.progress,
    report: job.report,
  };
}

function s(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function need(params: Record<string, unknown>, key: string): string {
  const v = s(params, key);
  if (!v) throw new Error(`${key} is required`);
  return v;
}

function parseProps(raw: string | undefined): Record<string, DocPropertyValue> | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("properties must be a JSON object");
  return parsed as Record<string, DocPropertyValue>;
}

function compact(n: DocNode) {
  return {
    id: n.id,
    kind: n.kind,
    ...(n.type ? { type: n.type } : {}),
    ...(n.category ? { category: n.category } : {}),
    title: n.title,
    parentId: n.parentId,
    updatedAt: n.updatedAt,
    ...(n.file
      ? {
          file: {
            name: n.file.name,
            mime: n.file.mime,
            size: n.file.size,
            text: n.file.extractStatus,
          },
        }
      : {}),
  };
}

/** type=idea → the Ideas store (same path as ideas.create). */
export async function createIdeaFromTool(
  params: Record<string, unknown>,
  title: string,
  agentId: string,
): Promise<Record<string, unknown>> {
  const { createIdea } = await import("../../ideas/service.js");
  const rawTags = params.tags;
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((t): t is string => typeof t === "string")
    : typeof rawTags === "string"
      ? rawTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
  const { idea, created } = await createIdea({
    title,
    body: typeof params.body === "string" ? params.body : "",
    tags,
    source: "agent",
    createdBy: agentId,
    clientRequestId: s(params, "clientRequestId"),
  });
  return {
    status: "ok",
    message: created
      ? `Idea "${idea.title}" captured`
      : `Idea "${idea.title}" already exists (idempotent)`,
    type: "idea",
    idea: { id: idea.id, title: idea.title, status: idea.status, tags: idea.tags },
  };
}

/** Validate a type before a write (throws with a readable message). */
export function validateDocType(type: string | undefined): void {
  if (!type || type === "idea") return;
  assertAssignableType(documentsStore(), type);
}

/**
 * Give a legacy note's mirrored document a type (and category). The note is
 * synced into the workspace first so this works right after notes `create`.
 */
export function applyTypeToNote(noteId: string, type: string, category?: string): DocNode | null {
  const store = documentsStore();
  const note = getNote(noteId);
  if (!note) return null;
  const { node } = syncNoteIntoDocuments(store, note);
  return updateDoc({ id: node.id, type, ...(category ? { category } : {}) });
}

/** Parse Notion ids out of raw ids or notion.so URLs. */
export function parseNotionIds(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const m =
      /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?:[?#].*)?$/i.exec(part);
    if (m) out.push(m[1]!.replace(/-/g, "").toLowerCase());
  }
  return [...new Set(out)];
}

export async function runDocumentAction(
  action: string,
  params: Record<string, unknown>,
  agentId: string,
): Promise<Record<string, unknown>> {
  const store = documentsStore();
  const parentId = s(params, "parentId") ?? null;
  switch (action) {
    case "tree": {
      const folderId = s(params, "folderId");
      const nodes = store.tree();
      const scope = folderId ? new Set(store.descendants(folderId)) : null;
      const list = nodes.filter((n) => !scope || scope.has(n.id));
      // Render an indented outline — cheap for the model to scan.
      const byParent = new Map<string | null, DocNode[]>();
      for (const n of list) {
        const key = scope && n.parentId === folderId ? folderId! : n.parentId;
        const arr = byParent.get(key ?? null) ?? [];
        arr.push(n);
        byParent.set(key ?? null, arr);
      }
      const lines: string[] = [];
      const walk = (pid: string | null, depth: number) => {
        for (const n of byParent.get(pid) ?? []) {
          const tag = n.kind === "folder" ? "📁" : n.kind === "file" ? "📎" : "📄";
          lines.push(`${"  ".repeat(depth)}${tag} ${n.title}  [${n.id}]`);
          if (n.kind === "folder" && depth < 12) walk(n.id, depth + 1);
        }
      };
      walk(folderId ?? null, 0);
      return { status: "ok", count: list.length, outline: lines.join("\n") || "(empty)" };
    }
    case "library": {
      const res = await listLibrary({
        type: s(params, "type"),
        category: s(params, "category"),
        query: s(params, "query"),
        limit: typeof params.limit === "number" ? params.limit : 100,
      });
      return {
        status: "ok",
        total: res.total,
        counts: res.counts,
        items: res.items.map((i) => ({
          id: i.id,
          source: i.source,
          type: i.type,
          ...(i.category ? { category: i.category } : {}),
          title: i.title,
          ...(i.status ? { status: i.status } : {}),
          ...(i.path ? { path: i.path } : {}),
          updatedAt: i.updatedAt,
        })),
        ...(res.errors.length ? { warnings: res.errors } : {}),
      };
    }
    case "doc_types": {
      return {
        status: "ok",
        types: docTypes(store)
          .list()
          .map((t) => ({
            id: t.id,
            label: t.label,
            builtin: t.builtin,
            creatable: t.creatable,
            ...(t.hidden ? { hidden: true } : {}),
            ...(t.archived ? { archived: true } : {}),
          })),
      };
    }
    case "read": {
      const id = need(params, "id");
      const node = store.getNode(id) ?? store.findBySource("note", id);
      if (!node) return { status: "error", error: `Document "${id}" not found` };
      const text = store.readText(node.id);
      const base = {
        status: "ok",
        node: summarize(store, node),
        path: store.pathString(node.id),
      };
      if (node.kind === "folder") {
        const rows = store
          .children(node.id)
          .map((c) => ({ ...compact(c), properties: c.properties }));
        return { ...base, schema: node.schema, children: rows };
      }
      return {
        ...base,
        markdown: text.slice(0, READ_CAP),
        truncated: text.length > READ_CAP,
        charCount: text.length,
        backlinks:
          node.kind === "doc"
            ? store.backlinks(node.id).map((b) => ({ id: b.id, title: b.title }))
            : undefined,
      };
    }
    case "doc_search": {
      const hits = store.search(need(params, "query"), {
        limit: typeof params.limit === "number" ? params.limit : 20,
        parentId: s(params, "folderId") ?? null,
      });
      return { status: "ok", count: hits.length, hits };
    }
    case "create_doc": {
      const type = s(params, "type");
      const title = s(params, "title") ?? s(params, "name") ?? "Untitled";
      if (type === "idea") return await createIdeaFromTool(params, title, agentId);
      const node = createDoc({
        kind: "doc",
        title,
        body: typeof params.body === "string" ? params.body : "",
        parentId,
        author: agentId,
        type,
        category: s(params, "category"),
        properties: parseProps(s(params, "properties")),
      });
      return {
        status: "ok",
        message: `Document "${node.title}" created${node.type ? ` as ${node.type}` : ""}`,
        node: compact(node),
        path: store.pathString(node.id),
      };
    }
    case "create_folder": {
      const node = createDoc({
        kind: "folder",
        title: s(params, "title") ?? s(params, "name") ?? "New folder",
        parentId,
        author: agentId,
      });
      return { status: "ok", message: `Folder "${node.title}" created`, node: compact(node) };
    }
    case "update_doc": {
      const node = updateDoc({
        id: need(params, "id"),
        title: s(params, "title") ?? s(params, "name"),
        body: typeof params.body === "string" ? params.body : undefined,
        properties: parseProps(s(params, "properties")),
        type: s(params, "type"),
        category: typeof params.category === "string" ? params.category : undefined,
        author: agentId,
        snapshot: true,
      });
      if (!node) return { status: "error", error: "Document not found" };
      return { status: "ok", message: `Document "${node.title}" updated`, node: compact(node) };
    }
    case "append_doc": {
      const body = typeof params.body === "string" ? params.body : "";
      if (!body) throw new Error("body is required");
      const node = appendDoc(need(params, "id"), body, agentId);
      if (!node) return { status: "error", error: "Document not found (or not a doc)" };
      return { status: "ok", message: `Appended to "${node.title}"`, node: compact(node) };
    }
    case "move_doc": {
      const node = moveDoc(need(params, "id"), parentId);
      return { status: "ok", message: `Moved "${node.title}"`, path: store.pathString(node.id) };
    }
    case "delete_doc": {
      const node = deleteDoc(need(params, "id"));
      if (!node) return { status: "error", error: "Document not found" };
      return { status: "ok", message: `"${node.title}" moved to trash (restore_doc to undo)` };
    }
    case "restore_doc": {
      const node = restoreDoc(need(params, "id"));
      if (!node) return { status: "error", error: "Document not found" };
      return { status: "ok", message: `"${node.title}" restored`, path: store.pathString(node.id) };
    }
    case "doc_history":
      return { status: "ok", revisions: store.history(need(params, "id")) };
    case "upload_url": {
      const node = await uploadFromUrl({
        url: need(params, "url"),
        parentId,
        name: s(params, "name"),
        author: agentId,
      });
      return {
        status: "ok",
        message: `Stored "${node.title}"`,
        node: compact(node),
        extracted: node.file?.extractStatus,
      };
    }
    case "upload_path": {
      const node = await uploadFromPath({
        path: need(params, "path"),
        parentId,
        name: s(params, "name"),
        author: agentId,
      });
      return {
        status: "ok",
        message: `Stored "${node.title}"`,
        node: compact(node),
        extracted: node.file?.extractStatus,
      };
    }
    case "import_notion": {
      // Runs as a background import job (a big workspace takes minutes at
      // Notion's rate limit). Wait briefly so small imports return a report;
      // otherwise hand back the job — calling again with the same notionIds
      // reattaches to it and reports progress.
      const ids = parseNotionIds(need(params, "notionIds"));
      if (!ids.length) throw new Error("no Notion ids found in notionIds");
      const { getNotionApiKeyForImport } = await import("../../databases/notion-config.js");
      if (!getNotionApiKeyForImport()) {
        throw new Error("Notion is not connected (no integration token configured)");
      }
      const { importJobs } = await import("../../documents/import-jobs.js");
      const jobs = await importJobs();
      const { job } = jobs.startNotion({ ids, parentId, force: params.force === true });
      return importJobResult(await jobs.wait(job.id, AGENT_IMPORT_WAIT_MS));
    }
    case "import_notion_zip": {
      const { isSaasMode } = await import("../../saas/config.js");
      if (isSaasMode()) throw new Error("import from a local path is not available in hosted mode");
      const file = need(params, "path");
      const data = fs.readFileSync(file);
      const { importJobs } = await import("../../documents/import-jobs.js");
      const jobs = await importJobs();
      const job = jobs.startZip({ data, name: path.basename(file), parentId });
      return importJobResult(await jobs.wait(job.id, AGENT_IMPORT_WAIT_MS));
    }
    case "import_obsidian": {
      // Vault from a local folder (path) or a public https git URL (url);
      // hosted plans upload a ZIP in the Documents import dialog instead.
      const { isSaasMode } = await import("../../saas/config.js");
      if (isSaasMode()) {
        throw new Error(
          "Hosted plans import Obsidian vaults as a ZIP from the Documents import dialog",
        );
      }
      const url = s(params, "url");
      const file = s(params, "path");
      if (!url && !file)
        throw new Error("path (vault folder or .zip) or url (https git) is required");
      const { importJobs } = await import("../../documents/import-jobs.js");
      const jobs = await importJobs();
      let job: ImportJobView;
      if (url) {
        job = jobs.startObsidian({
          source: "git",
          origin: url,
          parentId,
          createTasks: params.createTasks === true,
          force: params.force === true,
        }).job;
      } else if (/\.zip$/i.test(file!)) {
        job = jobs.startObsidian({
          source: "zip",
          origin: path.basename(file!),
          data: fs.readFileSync(file!),
          parentId,
          createTasks: params.createTasks === true,
        }).job;
      } else {
        const dir = file!.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!fs.statSync(dir).isDirectory()) throw new Error(`not a folder: ${file}`);
        job = jobs.startObsidian({
          source: "folder",
          origin: dir,
          parentId,
          createTasks: params.createTasks === true,
          force: params.force === true,
        }).job;
      }
      return {
        ...importJobResult(await jobs.wait(job.id, AGENT_IMPORT_WAIT_MS)),
        details: job.details,
      };
    }
    case "import_status": {
      const { importJobs } = await import("../../documents/import-jobs.js");
      const jobs = await importJobs();
      const id = s(params, "jobId");
      if (!id)
        return {
          status: "ok",
          jobs: jobs.list({ limit: 10 }).map((j) => ({
            id: j.id,
            kind: j.kind,
            label: j.label,
            status: j.status,
            progress: j.progress,
            undoable: j.undoable ?? 0,
            undoneAt: j.undoneAt,
          })),
        };
      const job = jobs.get(id);
      if (!job) throw new Error("import job not found");
      return {
        ...importJobResult(job),
        kind: job.kind,
        details: job.details,
        undoable: job.undoable ?? 0,
      };
    }
    case "import_undo": {
      const { importJobs } = await import("../../documents/import-jobs.js");
      const job = await (await importJobs()).undo(need(params, "jobId"));
      if (!job) throw new Error("import job not found");
      return { status: "ok", jobId: job.id, undone: job.undoReport };
    }
    case "import_collections": {
      const { collectionColumns, rowsOf, suggestRole } =
        await import("../../documents/import-mapping.js");
      const collections = store
        .tree()
        .filter(
          (n) =>
            n.kind === "folder" &&
            (n.schema?.length ||
              n.source?.type === "notion" ||
              n.source?.type === "notion-zip" ||
              n.source?.type === "obsidian"),
        )
        .map((n) => ({ n, rows: rowsOf(store, n.id).length }))
        .filter((x) => x.rows > 0)
        .slice(0, 100)
        .map(({ n, rows }) => ({
          id: n.id,
          title: n.title,
          path: store.pathString(n.id),
          rows,
          suggestedRole: suggestRole(n, collectionColumns(store, n)),
        }));
      return { status: "ok", collections };
    }
    case "import_map_preview":
    case "import_map": {
      const folderId = need(params, "folderId");
      const role = s(params, "role");
      if (role && !["projects", "tasks", "clients"].includes(role))
        throw new Error("role must be projects, tasks or clients");
      const raw = s(params, "fieldMap");
      const fieldMap = raw ? (JSON.parse(raw) as Record<string, string>) : undefined;
      if (action === "import_map_preview") {
        const { buildPreview } = await import("../../documents/import-mapping.js");
        const { ImportLedger } = await import("../../documents/import-journal.js");
        return {
          status: "ok",
          preview: buildPreview(
            store,
            folderId,
            (role as never) ?? null,
            fieldMap,
            ImportLedger.forStore(store),
          ),
        };
      }
      if (!role) throw new Error("role is required (projects, tasks or clients)");
      const { importJobs } = await import("../../documents/import-jobs.js");
      const job = await (
        await importJobs()
      ).runMapping({ folderId, role: role as never, fieldMap });
      return {
        status: job.status === "done" ? "ok" : "error",
        jobId: job.id,
        report: job.details?.mapping,
        error: job.error,
        undo: "import_undo with this jobId reverses it",
      };
    }
    default:
      return { status: "error", error: `Unknown documents action: ${action}` };
  }
}
