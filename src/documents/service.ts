/**
 * Documents service — the one set of operations behind the documents.* RPCs,
 * the HTTP upload/serve routes and the agent `notes` tool's document actions.
 * Every mutation broadcasts `notes:changed` (flagged `documents: true`) so
 * open UI tabs refresh live, and migrated notes are written back to their note.
 */

import fs from "node:fs";
import path from "node:path";
import { getScopedUserId } from "../config/paths.js";
import { broadcastDocumentsChanged } from "../notes/notes-events.js";
import { enqueueUploadedPath, getOcrService } from "../ocr/runtime.js";
import { isSaasMode as isSaasModeSync } from "../saas/config.js";
import {
  extractText,
  validateUpload,
  DOCUMENTS_MAX_UPLOAD_BYTES,
  EXTRACT_MAX_CHARS,
} from "./extract.js";
import { assertDocumentsQuota } from "./tenant-limits.js";
import { ensureNotesMigrated, installNotesMirror, writeBackToNote } from "./notes-bridge.js";
import { DocumentStore } from "./store.js";
import type { DocCreateParams, DocNode, DocSource, DocUpdateParams } from "./types.js";
import {
  DocTypeValidationError,
  docTypeStoreAt,
  effectiveDocType,
  renderTemplate,
  type DocTypeDef,
  type DocTypeStore,
} from "./doc-types.js";
import {
  buildLibrary,
  type LibraryFilter,
  type LibraryIdeaLike,
  type LibraryReportLike,
  type LibraryResearchLike,
  type LibraryResult,
} from "./library.js";

/** The active user's store, with first-open notes migration + live notes mirror. */
export function documentsStore(): DocumentStore {
  const store = DocumentStore.forCurrentUser();
  installNotesMirror(
    () => DocumentStore.forCurrentUser(),
    (c) => broadcastDocumentsChanged({ op: c.op, id: c.id, name: c.name }),
  );
  ensureNotesMigrated(store);
  return store;
}

function changed(
  op: Parameters<typeof broadcastDocumentsChanged>[0]["op"],
  node: DocNode | null,
): void {
  if (!node) return;
  broadcastDocumentsChanged({ op, id: node.id, name: node.title, parentId: node.parentId });
}

/** The active user's document-type registry (documents/types.json). */
export function docTypes(store: DocumentStore = documentsStore()): DocTypeStore {
  return docTypeStoreAt(store.root);
}

/** Lightweight node shape for lists (no bodies). */
export function summarize(store: DocumentStore, n: DocNode) {
  const eff = effectiveDocType(n, docTypes(store).list());
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    parentId: n.parentId,
    type: eff.type ?? undefined,
    typeInferred: eff.inferred || undefined,
    category: n.category,
    icon: n.icon,
    favorite: n.favorite,
    tags: n.tags,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    sortOrder: n.sortOrder,
    source: n.source,
    preview: n.preview,
    bodyLength: n.bodyLength,
    properties: n.properties,
    schema: n.schema,
    view: n.view,
    file: n.file,
    deletedAt: n.deletedAt,
    path: store.pathString(n.id),
  };
}

/**
 * Validate a requested type for a document. Unknown / archived types and the
 * listing-only types (idea → ideas store, report → Reports) are rejected so a
 * typo never silently files a doc under a type nobody can see.
 */
export function assertAssignableType(store: DocumentStore, type: string | undefined): void {
  if (type === undefined || type === "") return;
  const t = docTypes(store).get(type);
  if (!t) throw new DocTypeValidationError(`Unknown document type "${type}"`);
  if (t.archived) throw new DocTypeValidationError(`Document type "${t.label}" is archived`);
  if (t.backing === "ideas")
    throw new DocTypeValidationError(
      `"${t.label}" items live in the Ideas store — create them with ideas.create`,
    );
  if (t.backing === "reports")
    throw new DocTypeValidationError(`"${t.label}" is a read-only listing of rendered reports`);
}

export function createDoc(p: DocCreateParams): DocNode {
  const store = documentsStore();
  let params = p;
  if (p.kind === "doc" && p.type) {
    assertAssignableType(store, p.type);
    // A typed doc with no body starts from its type's template.
    if (p.body === undefined || p.body === "") {
      const tpl = docTypes(store).get(p.type)?.template;
      if (tpl) params = { ...p, body: renderTemplate(tpl) };
    }
  }
  const node = store.create(params);
  changed("create", node);
  return node;
}

export function updateDoc(p: DocUpdateParams): DocNode | null {
  const store = documentsStore();
  if (p.type) assertAssignableType(store, p.type);
  const node = store.update(p);
  if (node && (p.body !== undefined || p.title !== undefined)) writeBackToNote(store, node);
  changed("update", node);
  return node;
}

export function appendDoc(id: string, markdown: string, author?: string): DocNode | null {
  const store = documentsStore();
  const node = store.append(id, markdown, author);
  if (node) writeBackToNote(store, node);
  changed("update", node);
  return node;
}

export function moveDoc(id: string, parentId: string | null, index?: number): DocNode {
  const node = documentsStore().move(id, parentId, index);
  changed("move", node);
  return node;
}

export function deleteDoc(id: string): DocNode | null {
  const node = documentsStore().softDelete(id);
  changed("delete", node);
  return node;
}

export function restoreDoc(id: string): DocNode | null {
  const node = documentsStore().restore(id);
  changed("restore", node);
  return node;
}

export function purgeDoc(id: string): number {
  const store = documentsStore();
  const node = store.getNode(id);
  const n = store.purge(id);
  if (node) changed("delete", node);
  return n;
}

export function restoreRevision(id: string, rev: string, author?: string): DocNode | null {
  const store = documentsStore();
  const node = store.restoreRevision(id, rev, author);
  if (node) writeBackToNote(store, node);
  changed("update", node);
  return node;
}

// ── Uploads ──────────────────────────────────────────────────

export interface UploadInput {
  parentId?: string | null;
  name: string;
  data: Buffer;
  mime?: string;
  author?: string;
  source?: DocSource;
  /** Markdown/text uploads become editable docs unless this is set. */
  keepAsFile?: boolean;
}

/**
 * Validate, store and extract an upload. `.md`/`.markdown`/`.txt` become docs
 * (editable); everything else becomes a file node with an extracted-text companion.
 */
export async function uploadFile(input: UploadInput): Promise<DocNode> {
  const v = await validateUpload(input.name, input.data, input.mime);
  const store = documentsStore();
  assertDocumentsQuota(store.root, input.data.length);
  if (!input.keepAsFile && [".md", ".markdown", ".txt"].includes(v.ext)) {
    const body = input.data.toString("utf8");
    const node = store.create({
      kind: "doc",
      title: path.basename(v.name, v.ext),
      parentId: input.parentId ?? null,
      body,
      author: input.author,
      source: input.source ?? { type: "upload" },
    });
    changed("create", node);
    return node;
  }
  const node = store.addFile({
    parentId: input.parentId ?? null,
    name: v.name,
    data: input.data,
    mime: v.mime,
    author: input.author,
    source: input.source,
  });
  changed("create", node);
  const r = await extractText(v, input.data);
  const ocrQueued = queueDocumentOcr(store, node.id);
  // Images / scanned PDFs with no text yet show "pending" until local OCR lands.
  const status = ocrQueued && r.status !== "ok" ? "pending" : r.status;
  const done = store.setExtracted(node.id, r.markdown, status, r.error) ?? node;
  changed("update", done);
  return done;
}

/** Queue a stored original for the local auto-OCR pipeline (never blocks). */
function queueDocumentOcr(store: DocumentStore, id: string): boolean {
  if (isSaasModeSync() || getScopedUserId()) return false;
  const orig = store.originalPath(id);
  if (!orig) return false;
  try {
    const entry = enqueueUploadedPath(orig, { kind: "documents", docId: id });
    return Boolean(entry && entry.status !== "done");
  } catch {
    return false;
  }
}

/**
 * Local OCR finished for a document's original: adopt its text when the
 * inline extraction found none (images, scanned PDFs) or found less.
 */
export function applyOcrToDocument(id: string, markdown: string): DocNode | null {
  const store = documentsStore();
  const node = store.getNode(id);
  if (!node?.file) return null;
  const current = node.file.extractStatus === "ok" ? (node.file.extractedChars ?? 0) : 0;
  const text = markdown.trim();
  if (!text) {
    if (node.file.extractStatus === "pending") {
      const done = store.setExtracted(id, null, "none");
      changed("update", done);
      return done;
    }
    return node;
  }
  if (current >= text.length) return node;
  const done = store.setExtracted(id, text.slice(0, EXTRACT_MAX_CHARS), "ok");
  changed("update", done);
  return done;
}

export async function uploadFromUrl(p: {
  url: string;
  parentId?: string | null;
  name?: string;
  author?: string;
}): Promise<DocNode> {
  const { fetchWithGuard } = await import("../media/input-files.js");
  const res = await fetchWithGuard({
    url: p.url,
    maxBytes: DOCUMENTS_MAX_UPLOAD_BYTES,
    timeoutMs: 60_000,
    maxRedirects: 5,
  });
  let name = p.name?.trim();
  if (!name) {
    try {
      name = decodeURIComponent(path.basename(new URL(p.url).pathname)) || "download";
    } catch {
      name = "download";
    }
  }
  return uploadFile({
    parentId: p.parentId,
    name,
    data: res.buffer,
    mime: res.mimeType,
    author: p.author,
    source: { type: "url", url: p.url },
    keepAsFile: false,
  });
}

/**
 * Upload a file from the gateway host's filesystem (agents on a local install).
 * Disabled for SaaS tenants — a tenant must never read the host disk.
 */
export async function uploadFromPath(p: {
  path: string;
  parentId?: string | null;
  name?: string;
  author?: string;
}): Promise<DocNode> {
  const { isSaasMode } = await import("../saas/config.js");
  if (isSaasMode() || getScopedUserId()) {
    throw new Error("upload from a local path is not available in hosted mode; use a URL");
  }
  const abs = path.resolve(p.path);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
  if (st.size > DOCUMENTS_MAX_UPLOAD_BYTES) throw new Error(`File too large: ${st.size} bytes`);
  return uploadFile({
    parentId: p.parentId,
    name: p.name?.trim() || path.basename(abs),
    data: fs.readFileSync(abs),
    author: p.author,
    source: { type: "path", url: abs },
  });
}

/** Re-run text extraction for a stored file (e.g. after OCR became available). */
export async function reextractFile(id: string): Promise<DocNode | null> {
  const store = documentsStore();
  const node = store.getNode(id);
  const orig = store.originalPath(id);
  if (!node?.file || !orig) return null;
  const data = fs.readFileSync(orig);
  const v = await validateUpload(node.file.name, data, node.file.mime);
  const r = await extractText(v, data);
  try {
    getOcrService().rerun("normal", { path: orig });
  } catch {
    /* not registered yet */
  }
  const ocrQueued = queueDocumentOcr(store, id);
  const status = ocrQueued && r.status !== "ok" ? "pending" : r.status;
  const done = store.setExtracted(id, r.markdown, status, r.error);
  changed("update", done);
  return done;
}

// ── Library (typed list across documents, ideas, reports, research) ──────────

export interface LibrarySources {
  ideas?: () => LibraryIdeaLike[] | Promise<LibraryIdeaLike[]>;
  reports?: () => LibraryReportLike[] | Promise<LibraryReportLike[]>;
  research?: () => LibraryResearchLike[] | Promise<LibraryResearchLike[]>;
}

async function safeList<T>(
  fn: (() => T[] | Promise<T[]>) | undefined,
  errors: string[],
  label: string,
): Promise<T[]> {
  if (!fn) return [];
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${String((err as Error)?.message ?? err)}`);
    return [];
  }
}

const LIBRARY_HIDDEN_REPORT_KINDS = new Set([
  "oversight_event",
  "gateway_recovery",
  "credit_burn_alert",
  "incident",
]);

/** Default sources: the ideas store, the reports store and the research-docs store. */
export function defaultLibrarySources(): LibrarySources {
  return {
    ideas: async () => {
      const { getIdeaStore } = await import("../ideas/store.js");
      return getIdeaStore().list({ limit: 5000 });
    },
    reports: async () => {
      const { getReportsStore } = await import("../reports/store.js");
      // System-event records (oversight pings, gateway recoveries, alerts) are
      // telemetry, not documents — the Reports page hides them by default too.
      const rows = getReportsStore().listReports({
        excludeKind: "oversight_event",
        limit: 800,
      }).reports;
      return rows.filter((r) => !LIBRARY_HIDDEN_REPORT_KINDS.has(r.kind)).slice(0, 400);
    },
    research: async () => {
      const { ResearchStore } = await import("../research/store.js");
      const { resolveStateDir } = await import("../config/paths.js");
      const dir = path.join(resolveStateDir(), "research-docs");
      if (!fs.existsSync(dir)) return [];
      return new ResearchStore(resolveStateDir()).list({ limit: 1000 });
    },
  };
}

export async function listLibrary(
  filter: LibraryFilter & { include?: Array<"ideas" | "reports" | "research"> } = {},
  sources: LibrarySources = defaultLibrarySources(),
): Promise<LibraryResult & { types: DocTypeDef[]; errors: string[] }> {
  const store = documentsStore();
  const types = docTypes(store).list();
  const errors: string[] = [];
  const want = new Set(filter.include ?? ["ideas", "reports", "research"]);
  const [ideas, reports, research] = await Promise.all([
    want.has("ideas") ? safeList(sources.ideas, errors, "ideas") : [],
    want.has("reports") ? safeList(sources.reports, errors, "reports") : [],
    want.has("research") ? safeList(sources.research, errors, "research") : [],
  ]);
  const docs = store
    .tree()
    .filter((n) => n.kind !== "folder")
    .map((node) => ({ node, path: store.pathString(node.id) }));
  const res = buildLibrary({ docs, ideas, reports, research, types }, filter);
  return { ...res, types, errors };
}

// ── Notion ───────────────────────────────────────────────────

export function importChanged(rootIds: string[]): void {
  broadcastDocumentsChanged({ op: "import", id: rootIds[0] });
}
