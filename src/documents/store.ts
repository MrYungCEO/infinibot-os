/**
 * Document Store — per-user documents workspace (folders, docs, uploaded files).
 *
 * Storage layout (under `<resolveStateDir()>/documents/`):
 *   index.json                 node metadata for the whole tree (atomic writes)
 *   docs/<id>.md               markdown body of each doc
 *   files/<id>/original<ext>   uploaded original (never executed, served as attachment/inline)
 *   files/<id>/extracted.md    extracted text companion (search + agent reads)
 *   history/<id>/<rev>.json    body snapshots (version history)
 *   backups/                   pre-migration / pre-import backups
 *
 * The store is synchronous and single-writer (the gateway process). The index
 * is re-read when its mtime changes so a second process (CLI, tests) sees
 * fresh data.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type {
  DocCreateParams,
  DocFileInfo,
  DocNode,
  DocRevision,
  DocSearchHit,
  DocSource,
  DocUpdateParams,
} from "./types.js";

interface IndexFile {
  version: 1;
  migratedNotesAt?: string;
  nodes: Record<string, DocNode>;
}

const HISTORY_COALESCE_MS = 5 * 60_000;
const HISTORY_MAX = 100;
const PREVIEW_CHARS = 200;

/** URL prefix under which doc assets are served (see server-documents-http.ts). */
export const ASSET_URL_PREFIX = "/api/documents/assets/";

export function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}

function makePreview(body: string): string {
  return body
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/[#>*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}

function writeAtomic(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** `[[Target]]` / `[[Target|label]]` wiki links + `doc:<id>` markdown links. */
export function extractWikiTargets(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1]!.trim());
  const re2 = /\]\(<?doc:([a-zA-Z0-9_-]+)>?\)/g;
  while ((m = re2.exec(body))) out.add(`id:${m[1]}`);
  return [...out];
}

const DOC_REF_RE = /^doc:([a-zA-Z0-9_-]+)$/;

/**
 * Link targets of a node: its body links (see extractWikiTargets) plus links
 * held in its properties — `doc:<id>` values (imported Notion relations) and
 * `[[wikilinks]]` inside string values (Obsidian frontmatter links).
 */
export function extractLinkTargets(
  body: string,
  properties?: Record<string, unknown> | null,
): string[] {
  const out = new Set(extractWikiTargets(body));
  if (properties) {
    for (const v of Object.values(properties)) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (typeof item !== "string" || !item) continue;
        const ref = DOC_REF_RE.exec(item.trim());
        if (ref) {
          out.add(`id:${ref[1]}`);
          continue;
        }
        if (item.includes("[[") || item.includes("](doc:")) {
          for (const t of extractWikiTargets(item)) out.add(t);
        }
      }
    }
  }
  return [...out];
}

/** Lookup key for titles / link targets: NFC, trimmed, case-folded. */
function titleKey(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}

/** Deferred index writes while an import batch runs (see DocumentStore.batch). */
const BATCH_FLUSH_EVERY = 250;
const BATCH_FLUSH_MS = 2_000;
const batchContext = new AsyncLocalStorage<{ root: string }>();

const storeCache = new Map<string, DocumentStore>();

export class DocumentStore {
  readonly root: string;
  private index: IndexFile | null = null;
  private indexMtime = 0;
  private bodyCache = new Map<string, { mtimeMs: number; text: string }>();
  /** Bumped on every index change (writes and reloads); keys the derived caches. */
  private generation = 0;
  /** `${type}\u0000${sourceId}` → node id; maintained incrementally, verified on read. */
  private sourceIndex: Map<string, string> | null = null;
  private titleIndex: { gen: number; map: Map<string, DocNode> } | null = null;
  private incomingIndex: { gen: number; map: Map<string, Set<string>> } | null = null;
  private maxSortByParent: Map<string, number> | null = null;
  /** Batch bookkeeping: unflushed index changes. */
  private batchDepth = 0;
  private dirty = false;
  private pendingWrites = 0;
  private lastFlush = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string) {
    this.root = root;
    for (const sub of ["", "docs", "files", "history", "backups"]) {
      fs.mkdirSync(path.join(root, sub), { recursive: true });
    }
  }

  /** Store for the active user (request-scoped in SaaS, profile-scoped locally). */
  static forCurrentUser(): DocumentStore {
    return DocumentStore.at(path.join(resolveStateDir(), "documents"));
  }

  static at(root: string): DocumentStore {
    let s = storeCache.get(root);
    if (!s) {
      s = new DocumentStore(root);
      storeCache.set(root, s);
    }
    return s;
  }

  // ── Index ──────────────────────────────────────────────────

  private get indexPath(): string {
    return path.join(this.root, "index.json");
  }

  hasIndex(): boolean {
    return fs.existsSync(this.indexPath);
  }

  private load(): IndexFile {
    // Unflushed batch writes live only in memory: never trade them for disk.
    if (this.index && this.dirty) return this.index;
    let mtime = 0;
    try {
      mtime = fs.statSync(this.indexPath).mtimeMs;
    } catch {
      /* missing */
    }
    if (this.index && mtime === this.indexMtime) return this.index;
    if (!mtime) {
      this.index = { version: 1, nodes: {} };
      this.indexMtime = 0;
      return this.index;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf-8")) as IndexFile;
      this.index = {
        version: 1,
        nodes: parsed.nodes ?? {},
        migratedNotesAt: parsed.migratedNotesAt,
      };
    } catch {
      // Corrupt index: keep the broken file for inspection, start fresh from disk.
      const bad = `${this.indexPath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.indexPath, bad);
      } catch {
        /* ignore */
      }
      this.index = { version: 1, nodes: {} };
    }
    this.indexMtime = mtime;
    this.resetCaches();
    return this.index;
  }

  private resetCaches(): void {
    this.generation += 1;
    this.sourceIndex = null;
    this.titleIndex = null;
    this.incomingIndex = null;
    this.maxSortByParent = null;
  }

  /**
   * Persist the index. Inside `batch()` the write is deferred and flushed every
   * BATCH_FLUSH_EVERY writes / BATCH_FLUSH_MS (a crash loses at most that
   * much bookkeeping; importers are idempotent so a re-run converges). Writes
   * from outside the batch's async context flush immediately, as before.
   */
  private save(): void {
    this.load();
    this.generation += 1;
    if (this.batchDepth > 0 && batchContext.getStore()?.root === this.root) {
      this.dirty = true;
      this.pendingWrites += 1;
      if (
        this.pendingWrites >= BATCH_FLUSH_EVERY ||
        Date.now() - this.lastFlush >= BATCH_FLUSH_MS
      ) {
        this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          if (this.dirty) this.flush();
        }, BATCH_FLUSH_MS);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.flush();
  }

  /** Write the in-memory index to disk now. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.index) return;
    writeAtomic(this.indexPath, JSON.stringify(this.index, null, 1));
    this.indexMtime = fs.statSync(this.indexPath).mtimeMs;
    this.dirty = false;
    this.pendingWrites = 0;
    this.lastFlush = Date.now();
  }

  /**
   * Run `fn` with deferred index writes (bulk imports). Writes made inside
   * `fn`'s async context are kept in memory and flushed periodically and when
   * `fn` settles; reads always see them. Nested batches share one flush.
   */
  async batch<T>(fn: () => T | Promise<T>): Promise<T> {
    this.batchDepth += 1;
    if (this.batchDepth === 1) this.lastFlush = Date.now();
    try {
      return await batchContext.run({ root: this.root }, fn);
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) this.flush();
    }
  }

  /** True while a batch is open (tests / diagnostics). */
  get batching(): boolean {
    return this.batchDepth > 0;
  }

  getMeta(): { migratedNotesAt?: string } {
    return { migratedNotesAt: this.load().migratedNotesAt };
  }

  setMigratedNotesAt(iso: string): void {
    this.load().migratedNotesAt = iso;
    this.save();
  }

  // ── Reads ──────────────────────────────────────────────────

  all(): DocNode[] {
    return Object.values(this.load().nodes);
  }

  getNode(id: string): DocNode | null {
    return this.load().nodes[id] ?? null;
  }

  /** True when the node or any ancestor is soft-deleted. */
  isHidden(node: DocNode): boolean {
    const nodes = this.load().nodes;
    let cur: DocNode | undefined = node;
    let guard = 0;
    while (cur && guard++ < 256) {
      if (cur.deletedAt) return true;
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    return false;
  }

  /** Live (non-deleted) nodes, sorted folders-first then by sortOrder/title. */
  tree(opts: { includeDeleted?: boolean } = {}): DocNode[] {
    const nodes = this.all().filter((n) => opts.includeDeleted || !this.isHidden(n));
    return nodes.sort(compareNodes);
  }

  children(parentId: string | null): DocNode[] {
    return this.all()
      .filter((n) => (n.parentId ?? null) === parentId && !n.deletedAt)
      .sort(compareNodes);
  }

  /** Descendant ids (not including the node itself). */
  descendants(id: string): string[] {
    const byParent = new Map<string, DocNode[]>();
    for (const n of this.all()) {
      if (!n.parentId) continue;
      const arr = byParent.get(n.parentId) ?? [];
      arr.push(n);
      byParent.set(n.parentId, arr);
    }
    const out: string[] = [];
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of byParent.get(cur) ?? []) {
        out.push(c.id);
        stack.push(c.id);
      }
    }
    return out;
  }

  /** Breadcrumb from root to node (inclusive). */
  pathOf(id: string): DocNode[] {
    const nodes = this.load().nodes;
    const out: DocNode[] = [];
    let cur: DocNode | undefined = nodes[id];
    let guard = 0;
    while (cur && guard++ < 256) {
      out.unshift(cur);
      cur = cur.parentId ? nodes[cur.parentId] : undefined;
    }
    return out;
  }

  pathString(id: string): string {
    return this.pathOf(id)
      .map((n) => n.title)
      .join(" / ");
  }

  private bodyPath(id: string): string {
    return path.join(this.root, "docs", `${safeId(id)}.md`);
  }

  private readCached(file: string): string {
    try {
      const st = fs.statSync(file);
      const hit = this.bodyCache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
      const text = fs.readFileSync(file, "utf-8");
      this.bodyCache.set(file, { mtimeMs: st.mtimeMs, text });
      return text;
    } catch {
      return "";
    }
  }

  getBody(id: string): string {
    return this.readCached(this.bodyPath(id));
  }

  fileDir(id: string): string {
    return path.join(this.root, "files", safeId(id));
  }

  originalPath(id: string): string | null {
    const node = this.getNode(id);
    if (!node?.file) return null;
    const p = path.join(this.fileDir(id), `original${node.file.ext}`);
    return fs.existsSync(p) ? p : null;
  }

  getExtracted(id: string): string {
    return this.readCached(path.join(this.fileDir(id), "extracted.md"));
  }

  /** Readable text for any node: doc body, extracted file text, or folder listing. */
  readText(id: string): string {
    const node = this.getNode(id);
    if (!node) return "";
    if (node.kind === "doc") return this.getBody(id);
    if (node.kind === "file") return this.getExtracted(id);
    return this.children(id)
      .map((c) => `- ${c.kind === "folder" ? "📁 " : ""}${c.title} (${c.id})`)
      .join("\n");
  }

  // ── Writes ─────────────────────────────────────────────────

  private newId(title: string): string {
    const nodes = this.load().nodes;
    const base = slugifyTitle(title).slice(0, 40);
    for (let i = 0; i < 20; i++) {
      const id = `${base}-${randomBytes(3).toString("hex")}`;
      if (!nodes[id]) return id;
    }
    return `doc-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  }

  private assertParent(parentId: string | null | undefined): string | null {
    if (!parentId) return null;
    const p = this.getNode(parentId);
    if (!p) throw new Error(`Parent folder "${parentId}" not found`);
    if (p.kind !== "folder") throw new Error(`Parent "${parentId}" is not a folder`);
    return parentId;
  }

  private nextSortOrder(parentId: string | null): number {
    this.load();
    if (!this.maxSortByParent) {
      const map = new Map<string, number>();
      for (const n of this.all()) {
        if (typeof n.sortOrder !== "number") continue;
        const k = n.parentId ?? "";
        map.set(k, Math.max(map.get(k) ?? 0, n.sortOrder));
      }
      this.maxSortByParent = map;
    }
    const k = parentId ?? "";
    const next = (this.maxSortByParent.get(k) ?? 0) + 1;
    this.maxSortByParent.set(k, next);
    return next;
  }

  create(p: DocCreateParams): DocNode {
    const idx = this.load();
    const parentId = this.assertParent(p.parentId);
    const title = (p.title || "").trim() || (p.kind === "folder" ? "New folder" : "Untitled");
    const id = p.id && !idx.nodes[safeId(p.id)] ? safeId(p.id) : this.newId(title);
    const now = new Date().toISOString();
    const node: DocNode = {
      id,
      kind: p.kind,
      title,
      parentId,
      createdAt: now,
      updatedAt: now,
      author: p.author,
      type: p.kind === "folder" ? undefined : p.type?.trim() || undefined,
      category: p.kind === "folder" ? undefined : p.category?.trim() || undefined,
      tags: p.tags?.length ? p.tags : undefined,
      icon: p.icon,
      sortOrder: this.nextSortOrder(parentId),
      source: p.source,
      properties: p.properties && Object.keys(p.properties).length ? p.properties : undefined,
      schema: p.kind === "folder" ? p.schema : undefined,
      view: p.kind === "folder" ? p.view : undefined,
    };
    if (p.kind === "doc") {
      const body = p.body ?? "";
      writeAtomic(this.bodyPath(id), body);
      node.preview = makePreview(body);
      node.bodyLength = body.length;
    }
    idx.nodes[id] = node;
    this.indexSource(node);
    this.save();
    return node;
  }

  update(p: DocUpdateParams): DocNode | null {
    const idx = this.load();
    const node = idx.nodes[p.id];
    if (!node) return null;
    if (p.body !== undefined && node.kind === "doc") {
      const prev = this.getBody(node.id);
      if (prev !== p.body) {
        this.maybeSnapshot(node, prev, { force: p.snapshot === true, author: p.author });
        writeAtomic(this.bodyPath(node.id), p.body);
        node.preview = makePreview(p.body);
        node.bodyLength = p.body.length;
      }
    }
    if (p.title !== undefined && p.title.trim()) node.title = p.title.trim();
    if (p.type !== undefined && node.kind !== "folder") node.type = p.type.trim() || undefined;
    if (p.category !== undefined && node.kind !== "folder")
      node.category = p.category.trim() || undefined;
    if (p.tags !== undefined) node.tags = p.tags.length ? p.tags : undefined;
    if (p.icon !== undefined) node.icon = p.icon || undefined;
    if (p.favorite !== undefined) node.favorite = p.favorite || undefined;
    if (p.properties !== undefined) node.properties = p.properties;
    if (p.schema !== undefined && node.kind === "folder") node.schema = p.schema;
    if (p.view !== undefined && node.kind === "folder") node.view = p.view;
    if (p.source !== undefined) {
      node.source = p.source;
      this.indexSource(node);
    }
    if (p.author) node.author = node.author ?? p.author;
    node.updatedAt = new Date().toISOString();
    this.save();
    return node;
  }

  append(id: string, markdown: string, author?: string): DocNode | null {
    const node = this.getNode(id);
    if (!node || node.kind !== "doc") return null;
    const prev = this.getBody(id);
    const sep = prev && !prev.endsWith("\n\n") ? (prev.endsWith("\n") ? "\n" : "\n\n") : "";
    return this.update({ id, body: prev + sep + markdown, author });
  }

  move(id: string, parentId: string | null, index?: number): DocNode {
    const idx = this.load();
    const node = idx.nodes[id];
    if (!node) throw new Error(`Document "${id}" not found`);
    const target = this.assertParent(parentId);
    if (target === id || (target && this.descendants(id).includes(target))) {
      throw new Error("Cannot move a folder into itself");
    }
    node.parentId = target;
    // Re-number siblings so the node lands at `index` (end when omitted).
    const siblings = this.all()
      .filter((n) => (n.parentId ?? null) === target && n.id !== id && !n.deletedAt)
      .sort(compareNodes);
    const at =
      typeof index === "number" ? Math.max(0, Math.min(index, siblings.length)) : siblings.length;
    siblings.splice(at, 0, node);
    siblings.forEach((n, i) => {
      n.sortOrder = i + 1;
    });
    this.maxSortByParent = null;
    node.updatedAt = new Date().toISOString();
    this.save();
    return node;
  }

  softDelete(id: string): DocNode | null {
    const node = this.load().nodes[id];
    if (!node) return null;
    node.deletedAt = new Date().toISOString();
    this.save();
    return node;
  }

  restore(id: string): DocNode | null {
    const idx = this.load();
    const node = idx.nodes[id];
    if (!node) return null;
    delete node.deletedAt;
    // Restoring into a deleted/missing parent: lift to root so it's visible.
    if (node.parentId) {
      const parent = idx.nodes[node.parentId];
      if (!parent || this.isHidden(parent)) {
        node.parentId = null;
        this.maxSortByParent = null;
      }
    }
    node.updatedAt = new Date().toISOString();
    this.save();
    return node;
  }

  /** Nodes soft-deleted directly (the roots of deleted subtrees). */
  trash(): DocNode[] {
    return this.all()
      .filter((n) => n.deletedAt)
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  }

  /** Permanently remove a node and its subtree (only allowed from trash). */
  purge(id: string): number {
    const idx = this.load();
    const node = idx.nodes[id];
    if (!node) return 0;
    if (!this.isHidden(node)) throw new Error("Only trashed documents can be purged");
    const ids = [id, ...this.descendants(id)];
    for (const x of ids) {
      fs.rmSync(this.bodyPath(x), { force: true });
      fs.rmSync(this.fileDir(x), { recursive: true, force: true });
      fs.rmSync(path.join(this.root, "history", safeId(x)), { recursive: true, force: true });
      delete idx.nodes[x];
    }
    this.sourceIndex = null;
    this.save();
    return ids.length;
  }

  private static sourceKey(type: string, id: string): string {
    return `${type}\u0000${id}`;
  }

  /** Record a node's (type, id) source key; the first node keeps a contested key. */
  private indexSource(node: DocNode): void {
    if (!this.sourceIndex || !node.source?.id) return;
    const k = DocumentStore.sourceKey(node.source.type, node.source.id);
    const cur = this.sourceIndex.get(k);
    if (cur && cur !== node.id) {
      const other = this.load().nodes[cur];
      if (other?.source?.type === node.source.type && other.source.id === node.source.id) return;
    }
    this.sourceIndex.set(k, node.id);
  }

  private getSourceIndex(): Map<string, string> {
    const idx = this.load();
    if (!this.sourceIndex) {
      const map = new Map<string, string>();
      for (const n of Object.values(idx.nodes)) {
        if (!n.source?.id) continue;
        const k = DocumentStore.sourceKey(n.source.type, n.source.id);
        if (!map.has(k)) map.set(k, n.id);
      }
      this.sourceIndex = map;
    }
    return this.sourceIndex;
  }

  findBySource(type: DocSource["type"], sourceId: string): DocNode | null {
    const map = this.getSourceIndex();
    const k = DocumentStore.sourceKey(type, sourceId);
    const id = map.get(k);
    if (id === undefined) return null;
    const n = this.load().nodes[id];
    if (n && n.source?.type === type && n.source.id === sourceId) return n;
    // Stale entry (node purged or re-keyed): rebuild once and retry.
    this.sourceIndex = null;
    const fresh = this.getSourceIndex().get(k);
    return fresh ? (this.load().nodes[fresh] ?? null) : null;
  }

  /**
   * Idempotent create-or-update keyed by (source.type, source.id). Used by
   * the notes migration and Notion imports. Soft-deleted matches are left
   * alone (the user trashed them on purpose) and reported as `skipped`.
   */
  upsertBySource(
    source: DocSource & { id: string },
    p: Omit<DocCreateParams, "source">,
    opts: { reparent?: boolean } = {},
  ): { node: DocNode; status: "created" | "updated" | "unchanged" | "skipped" } {
    const existing = this.findBySource(source.type, source.id);
    if (!existing) {
      return { node: this.create({ ...p, source }), status: "created" };
    }
    if (existing.deletedAt) return { node: existing, status: "skipped" };
    const bodyChanged =
      p.kind === "doc" && p.body !== undefined && this.getBody(existing.id) !== p.body;
    const titleChanged = p.title && p.title !== existing.title;
    const propsChanged =
      p.properties !== undefined &&
      JSON.stringify(p.properties) !== JSON.stringify(existing.properties ?? {});
    const schemaChanged =
      p.schema !== undefined && JSON.stringify(p.schema) !== JSON.stringify(existing.schema ?? []);
    // Where the user filed an imported doc wins over the source layout unless
    // the caller explicitly asks to re-parent.
    const parentChanged =
      opts.reparent === true &&
      p.parentId !== undefined &&
      (p.parentId ?? null) !== (existing.parentId ?? null);
    if (parentChanged) this.move(existing.id, p.parentId ?? null);
    if (!bodyChanged && !titleChanged && !propsChanged && !schemaChanged) {
      // Record the sync without bumping updatedAt (keeps "Recent" meaningful).
      const node = this.load().nodes[existing.id]!;
      node.source = { ...existing.source, ...source };
      this.indexSource(node);
      if (p.icon !== undefined && p.icon !== node.icon) node.icon = p.icon || undefined;
      this.save();
      return { node: this.getNode(existing.id)!, status: parentChanged ? "updated" : "unchanged" };
    }
    const node = this.update({
      id: existing.id,
      title: p.title,
      body: p.kind === "doc" ? p.body : undefined,
      properties: p.properties,
      schema: p.schema,
      view: existing.view ?? p.view,
      source: { ...existing.source, ...source },
      tags: p.tags,
      icon: p.icon,
      snapshot: true,
    })!;
    return { node, status: "updated" };
  }

  // ── Files ──────────────────────────────────────────────────

  addFile(p: {
    parentId?: string | null;
    name: string;
    data: Buffer;
    mime: string;
    title?: string;
    author?: string;
    source?: DocSource;
    id?: string;
  }): DocNode {
    const idx = this.load();
    const parentId = this.assertParent(p.parentId);
    const ext = (path.extname(p.name) || "")
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "")
      .slice(0, 12);
    const title = p.title?.trim() || p.name;
    const id =
      p.id && !idx.nodes[safeId(p.id)] ? safeId(p.id) : this.newId(path.basename(p.name, ext));
    const dir = this.fileDir(id);
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, `original${ext}`), p.data);
    const now = new Date().toISOString();
    const file: DocFileInfo = {
      name: p.name,
      mime: p.mime,
      size: p.data.length,
      sha256: createHash("sha256").update(p.data).digest("hex"),
      ext,
      extractStatus: "pending",
    };
    const node: DocNode = {
      id,
      kind: "file",
      title,
      parentId,
      createdAt: now,
      updatedAt: now,
      author: p.author,
      sortOrder: this.nextSortOrder(parentId),
      source: p.source ?? { type: "upload" },
      file,
    };
    idx.nodes[id] = node;
    this.indexSource(node);
    this.save();
    return node;
  }

  setExtracted(
    id: string,
    markdown: string | null,
    status: DocFileInfo["extractStatus"],
    error?: string,
  ): DocNode | null {
    const idx = this.load();
    const node = idx.nodes[id];
    if (!node?.file) return null;
    const p = path.join(this.fileDir(id), "extracted.md");
    if (markdown != null) writeAtomic(p, markdown);
    node.file.extractStatus = status;
    node.file.extractError = error;
    node.file.extractedChars = markdown?.length ?? 0;
    node.preview = markdown ? makePreview(markdown) : undefined;
    node.updatedAt = new Date().toISOString();
    this.save();
    return node;
  }

  // ── Assets (images/files referenced from doc bodies) ───────

  /**
   * Store an embedded asset (imported image, pasted screenshot) content-addressed
   * under assets/ and return the URL to reference from markdown. The HTTP layer
   * serves `/api/documents/assets/<name>` for the active user.
   */
  addAsset(data: Buffer, ext: string): string {
    const clean = (ext.startsWith(".") ? ext : `.${ext}`)
      .toLowerCase()
      .replace(/[^.a-z0-9]/g, "")
      .slice(0, 10);
    const name = `${createHash("sha256").update(data).digest("hex").slice(0, 24)}${clean}`;
    const dir = path.join(this.root, "assets");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) writeAtomic(p, data);
    return `${ASSET_URL_PREFIX}${name}`;
  }

  assetPath(name: string): string | null {
    if (!/^[a-f0-9]{24}\.[a-z0-9]{1,9}$/.test(name)) return null;
    const p = path.join(this.root, "assets", name);
    return fs.existsSync(p) ? p : null;
  }

  // ── History ────────────────────────────────────────────────

  private historyDir(id: string): string {
    return path.join(this.root, "history", safeId(id));
  }

  private maybeSnapshot(
    node: DocNode,
    prevBody: string,
    o: { force: boolean; author?: string },
  ): void {
    if (!prevBody && !o.force) return;
    const dir = this.historyDir(node.id);
    fs.mkdirSync(dir, { recursive: true });
    const revs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const last = revs[revs.length - 1];
    if (!o.force && last) {
      const lastAt = Number(last.split("-")[0]);
      if (Date.now() - lastAt < HISTORY_COALESCE_MS) return;
    }
    // Monotonic names: two snapshots in the same millisecond must still sort in order.
    const lastMs = last ? Number(last.split("-")[0]) : 0;
    const at = Math.max(Date.now(), Number.isFinite(lastMs) ? lastMs + 1 : 0);
    const rev = `${at}-${randomBytes(2).toString("hex")}`;
    fs.writeFileSync(
      path.join(dir, `${rev}.json`),
      JSON.stringify({
        at: new Date().toISOString(),
        title: node.title,
        body: prevBody,
        author: o.author,
      }),
    );
    const all = [...revs, `${rev}.json`];
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_MAX))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
  }

  history(id: string): DocRevision[] {
    const dir = this.historyDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .map((f): DocRevision | null => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
          return {
            rev: f.replace(/\.json$/, ""),
            at: r.at,
            title: r.title,
            bodyLength: String(r.body ?? "").length,
            author: r.author,
          };
        } catch {
          return null;
        }
      })
      .filter((r): r is DocRevision => r !== null);
  }

  revision(id: string, rev: string): { title: string; body: string; at: string } | null {
    const f = path.join(this.historyDir(id), `${rev.replace(/[^a-z0-9-]/gi, "")}.json`);
    if (!fs.existsSync(f)) return null;
    const r = JSON.parse(fs.readFileSync(f, "utf-8"));
    return { title: r.title, body: String(r.body ?? ""), at: r.at };
  }

  restoreRevision(id: string, rev: string, author?: string): DocNode | null {
    const r = this.revision(id, rev);
    if (!r) return null;
    return this.update({ id, body: r.body, snapshot: true, author });
  }

  // ── Search + links ─────────────────────────────────────────

  search(query: string, opts: { limit?: number; parentId?: string | null } = {}): DocSearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scope = opts.parentId
      ? new Set([opts.parentId, ...this.descendants(opts.parentId)])
      : null;
    const hits: DocSearchHit[] = [];
    for (const n of this.tree()) {
      if (scope && !scope.has(n.id)) continue;
      const title = n.title.toLowerCase();
      const text = n.kind === "folder" ? "" : this.readText(n.id);
      const lower = text.toLowerCase();
      const props = n.properties ? JSON.stringify(n.properties).toLowerCase() : "";
      const tags = (n.tags ?? []).join(" ").toLowerCase();
      let score = 0;
      let all = true;
      for (const t of terms) {
        const inTitle = title.includes(t);
        const inBody = lower.includes(t);
        const inMeta = props.includes(t) || tags.includes(t);
        if (!inTitle && !inBody && !inMeta) {
          all = false;
          break;
        }
        score +=
          (inTitle ? 10 : 0) + (inMeta ? 3 : 0) + (inBody ? 1 + Math.min(5, countOf(lower, t)) : 0);
      }
      if (!all) continue;
      if (title === q) score += 20;
      hits.push({
        id: n.id,
        kind: n.kind,
        title: n.title,
        parentId: n.parentId,
        path: this.pathString(n.id),
        snippet: snippetFor(text, terms[0]!),
        score,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, opts.limit ?? 50);
  }

  /** Lower-cased NFC title → first live node in tree order (cached per index generation). */
  private titleMap(): Map<string, DocNode> {
    this.load();
    if (this.titleIndex?.gen !== this.generation) {
      const map = new Map<string, DocNode>();
      for (const n of this.tree()) {
        const k = titleKey(n.title);
        if (!map.has(k)) map.set(k, n);
      }
      this.titleIndex = { gen: this.generation, map };
    }
    return this.titleIndex.map;
  }

  /** Resolve a wiki-link target (`id:<id>`, an id, or a title) to a node. */
  resolveLink(target: string): DocNode | null {
    const t = target.trim();
    if (t.startsWith("id:")) return this.getNode(t.slice(3));
    const byId = this.getNode(t);
    if (byId && !this.isHidden(byId)) return byId;
    return this.titleMap().get(titleKey(t)) ?? null;
  }

  /** Link targets of a node (body + property links). */
  linkTargets(id: string): string[] {
    const node = this.getNode(id);
    if (!node) return [];
    return extractLinkTargets(node.kind === "doc" ? this.getBody(id) : "", node.properties);
  }

  outgoingLinks(id: string): Array<{ target: string; node: DocNode | null }> {
    return this.linkTargets(id).map((target) => ({
      target,
      node: this.resolveLink(target),
    }));
  }

  /** Target id → ids of live docs linking to it (built once per index generation). */
  private incoming(): Map<string, Set<string>> {
    this.load();
    if (this.incomingIndex?.gen !== this.generation) {
      const gen = this.generation;
      const map = new Map<string, Set<string>>();
      for (const n of this.tree()) {
        if (n.kind !== "doc") continue;
        for (const t of extractLinkTargets(this.getBody(n.id), n.properties)) {
          const hit = this.resolveLink(t);
          if (!hit || hit.id === n.id) continue;
          let set = map.get(hit.id);
          if (!set) map.set(hit.id, (set = new Set()));
          set.add(n.id);
        }
      }
      this.incomingIndex = { gen, map };
    }
    return this.incomingIndex.map;
  }

  backlinks(id: string): DocNode[] {
    const node = this.getNode(id);
    if (!node) return [];
    const from = this.incoming().get(id);
    if (!from) return [];
    const out: DocNode[] = [];
    for (const n of this.tree()) if (from.has(n.id)) out.push(n);
    return out;
  }

  recent(limit = 20): DocNode[] {
    return this.tree()
      .filter((n) => n.kind !== "folder")
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }

  /**
   * Set document types in one write without touching updatedAt (type
   * migration). Only nodes that exist and are not folders are changed.
   * Returns how many nodes were updated.
   */
  setTypes(entries: Array<{ id: string; type: string }>): number {
    const idx = this.load();
    let n = 0;
    for (const e of entries) {
      const node = idx.nodes[e.id];
      if (!node || node.kind === "folder" || !e.type) continue;
      if (node.type === e.type) continue;
      node.type = e.type;
      n += 1;
    }
    if (n) this.save();
    return n;
  }

  /** Copy index.json into backups/ verbatim and return the copy's path. */
  backupIndex(name: string): string | null {
    if (!this.hasIndex()) return null;
    if (this.dirty) this.flush();
    const file = path.join(
      this.root,
      "backups",
      `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    fs.copyFileSync(this.indexPath, file);
    return file;
  }

  /** Write a JSON backup blob into backups/ and return its path. */
  backup(name: string, data: unknown): string {
    const file = path.join(
      this.root,
      "backups",
      `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(data, null, 1));
    return file;
  }
}

function countOf(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < 50) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function snippetFor(text: string, term: string): string {
  const flat = text.replace(/\s+/g, " ");
  const i = flat.toLowerCase().indexOf(term);
  if (i < 0) return flat.slice(0, 160);
  const start = Math.max(0, i - 60);
  return (start > 0 ? "…" : "") + flat.slice(start, i + 100) + (i + 100 < flat.length ? "…" : "");
}

function compareNodes(a: DocNode, b: DocNode): number {
  if (a.kind === "folder" && b.kind !== "folder") return -1;
  if (b.kind === "folder" && a.kind !== "folder") return 1;
  const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  return a.title.localeCompare(b.title);
}
