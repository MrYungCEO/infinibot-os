/**
 * User-controlled organisation of Secure Files: collections (a tree of
 * folders), user tags, project, display name and notes.
 *
 * Everything lives in ONE sealed vault document (`files-organize.ibsec`), so
 * collection names, tag names and notes are encrypted at rest exactly like the
 * file bytes and OCR registry. Nothing here touches the normal lane, Notion,
 * the agent index or any broadcast payload (lane events carry only the kind).
 *
 * Deleting a collection never deletes files: its files move to the root and
 * its sub-collections move up to its parent.
 */
import { randomUUID } from "node:crypto";
import type { SecureVault } from "../secure-mode/vault.js";

export const SECURE_ORGANIZE_STORE = "files-organize";

export interface SecureCollection {
  id: string;
  name: string;
  /** null = top level. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SecureFileMeta {
  /** null = root ("Unfiled"). */
  collectionId: string | null;
  tags: string[];
  /** undefined = fall back to the upload source; null = explicitly none. */
  projectId?: string | null;
  displayName?: string;
  notes?: string;
  updatedAt: number;
}

interface OrganizeDoc {
  version: 1;
  collections: SecureCollection[];
  files: Record<string, SecureFileMeta>;
}

export interface SecureFilePatch {
  name?: string | null;
  collectionId?: string | null;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  projectId?: string | null;
  notes?: string | null;
}

/** Public, per-file organise fields merged into files.secure.list entries. */
export interface SecureOrganizeFields {
  collectionId: string | null;
  collectionPath: string;
  tags: string[];
  projectId: string | null;
  displayName: string | null;
  notes: string;
}

export class SecureOrganizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureOrganizeError";
  }
}

const MAX_TAGS = 24;
const MAX_TAG_LEN = 40;
const MAX_NAME_LEN = 120;
const MAX_COLLECTION_LEN = 80;
const MAX_NOTES_LEN = 4000;
const MAX_DEPTH = 8;

// Intentional: user-supplied tag/collection/file names must not carry C0 control characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_AND_SLASHES = /[\u0000-\u001f/\\]/g;

export function normalizeTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#+\s*/, "")
    .slice(0, MAX_TAG_LEN)
    .trim();
}

export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of list) {
    const tag = normalizeTag(t);
    const k = tag.toLowerCase();
    if (!tag || seen.has(k)) continue;
    seen.add(k);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanCollectionName(raw: unknown): string {
  const name =
    typeof raw === "string"
      ? raw.replace(CONTROL_CHARS_AND_SLASHES, " ").replace(/\s+/g, " ").trim()
      : "";
  if (!name) throw new SecureOrganizeError("collection name is required");
  if (name.length > MAX_COLLECTION_LEN)
    throw new SecureOrganizeError(
      `collection name is longer than ${MAX_COLLECTION_LEN} characters`,
    );
  return name;
}

function cleanDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
  return name || undefined;
}

function cleanNotes(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const notes = raw.replace(/\r\n/g, "\n").trim().slice(0, MAX_NOTES_LEN);
  return notes || undefined;
}

function defaultMeta(now: number): SecureFileMeta {
  return { collectionId: null, tags: [], updatedAt: now };
}

export class SecureFilesOrganizer {
  constructor(
    private readonly vault: SecureVault,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): OrganizeDoc {
    const d = this.vault.readJson<Partial<OrganizeDoc>>(SECURE_ORGANIZE_STORE, {});
    return {
      version: 1,
      collections: Array.isArray(d.collections) ? d.collections : [],
      files: d.files && typeof d.files === "object" ? d.files : {},
    };
  }

  private write(d: OrganizeDoc) {
    this.vault.writeJson(SECURE_ORGANIZE_STORE, d);
  }

  /**
   * Bring every known secure file into the organise doc (default: root, no
   * tags) and drop rows for files that no longer exist. Idempotent; writes
   * only when something changed.
   */
  migrate(fileIds: string[]): { added: number; pruned: number } {
    const d = this.read();
    const fresh = !this.vault.has(SECURE_ORGANIZE_STORE);
    const now = this.now();
    const live = new Set(fileIds);
    let added = 0;
    let pruned = 0;
    for (const id of fileIds) {
      if (!d.files[id]) {
        d.files[id] = defaultMeta(now);
        added++;
      }
    }
    for (const id of Object.keys(d.files)) {
      if (!live.has(id)) {
        delete d.files[id];
        pruned++;
      }
    }
    if (fresh || added || pruned) this.write(d);
    return { added, pruned };
  }

  // ── collections ──────────────────────────────────────────────────────

  listCollections(fileIds?: string[]): {
    collections: Array<SecureCollection & { path: string; count: number; depth: number }>;
    rootCount: number;
    tags: Array<{ tag: string; count: number }>;
  } {
    const d = this.read();
    const live = fileIds ? new Set(fileIds) : null;
    const counts = new Map<string | null, number>();
    const tagCounts = new Map<string, { tag: string; count: number }>();
    const valid = new Set(d.collections.map((c) => c.id));
    for (const [id, m] of Object.entries(d.files)) {
      if (live && !live.has(id)) continue;
      const cid = m.collectionId && valid.has(m.collectionId) ? m.collectionId : null;
      counts.set(cid, (counts.get(cid) ?? 0) + 1);
      for (const t of m.tags ?? []) {
        const k = t.toLowerCase();
        const cur = tagCounts.get(k);
        if (cur) cur.count++;
        else tagCounts.set(k, { tag: t, count: 1 });
      }
    }
    if (live) {
      // Files not migrated yet count as root.
      let known = 0;
      for (const id of live) if (d.files[id]) known++;
      counts.set(null, (counts.get(null) ?? 0) + (live.size - known));
    }
    const byId = new Map(d.collections.map((c) => [c.id, c]));
    return {
      collections: d.collections.map((c) => ({
        ...c,
        path: this.pathOf(byId, c.id),
        depth: this.depthOf(byId, c.id),
        count: counts.get(c.id) ?? 0,
      })),
      rootCount: counts.get(null) ?? 0,
      tags: [...tagCounts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    };
  }

  private pathOf(byId: Map<string, SecureCollection>, id: string | null): string {
    const parts: string[] = [];
    let cur = id ? byId.get(id) : undefined;
    for (let i = 0; cur && i < MAX_DEPTH + 2; i++) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(" / ");
  }

  private depthOf(byId: Map<string, SecureCollection>, id: string): number {
    let depth = 0;
    let cur = byId.get(id);
    while (cur?.parentId && depth <= MAX_DEPTH) {
      depth++;
      cur = byId.get(cur.parentId);
    }
    return depth;
  }

  private assertSiblingFree(
    d: OrganizeDoc,
    name: string,
    parentId: string | null,
    exceptId?: string,
  ) {
    const k = name.toLowerCase();
    if (
      d.collections.some(
        (c) => c.id !== exceptId && (c.parentId ?? null) === parentId && c.name.toLowerCase() === k,
      )
    ) {
      throw new SecureOrganizeError(`a collection named "${name}" already exists here`);
    }
  }

  createCollection(params: { name: unknown; parentId?: unknown }): SecureCollection {
    const d = this.read();
    const name = cleanCollectionName(params.name);
    const parentId =
      typeof params.parentId === "string" && params.parentId ? params.parentId : null;
    const byId = new Map(d.collections.map((c) => [c.id, c]));
    if (parentId && !byId.has(parentId))
      throw new SecureOrganizeError("parent collection not found");
    if (parentId && this.depthOf(byId, parentId) + 1 > MAX_DEPTH)
      throw new SecureOrganizeError("collections nest at most 8 levels deep");
    this.assertSiblingFree(d, name, parentId);
    const now = this.now();
    const c: SecureCollection = {
      id: `c_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name,
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    d.collections.push(c);
    this.write(d);
    return c;
  }

  /** Rename and/or re-parent (parentId: null = top level). */
  updateCollection(params: { id: unknown; name?: unknown; parentId?: unknown }): SecureCollection {
    const d = this.read();
    const c = d.collections.find((x) => x.id === params.id);
    if (!c) throw new SecureOrganizeError("collection not found");
    const name = params.name === undefined ? c.name : cleanCollectionName(params.name);
    let parentId = c.parentId ?? null;
    if (params.parentId !== undefined) {
      parentId = typeof params.parentId === "string" && params.parentId ? params.parentId : null;
      const byId = new Map(d.collections.map((x) => [x.id, x]));
      if (parentId && !byId.has(parentId))
        throw new SecureOrganizeError("parent collection not found");
      for (let cur = parentId; cur; cur = byId.get(cur)?.parentId ?? null) {
        if (cur === c.id) throw new SecureOrganizeError("a collection cannot move inside itself");
      }
    }
    this.assertSiblingFree(d, name, parentId, c.id);
    c.name = name;
    c.parentId = parentId;
    c.updatedAt = this.now();
    this.write(d);
    return c;
  }

  /** Remove a collection. Files move to the root; sub-collections move up. Never deletes files. */
  deleteCollection(id: unknown): { ok: boolean; movedFiles: number; movedCollections: number } {
    const d = this.read();
    const c = d.collections.find((x) => x.id === id);
    if (!c) return { ok: false, movedFiles: 0, movedCollections: 0 };
    const now = this.now();
    let movedFiles = 0;
    const moved: SecureCollection[] = [];
    for (const m of Object.values(d.files)) {
      if (m.collectionId === c.id) {
        m.collectionId = null;
        m.updatedAt = now;
        movedFiles++;
      }
    }
    for (const x of d.collections) {
      if (x.parentId === c.id) {
        x.parentId = c.parentId ?? null;
        x.updatedAt = now;
        moved.push(x);
      }
    }
    d.collections = d.collections.filter((x) => x.id !== c.id);
    // Re-parented children may now clash with a sibling name: suffix them.
    for (const x of moved) {
      let n = 2;
      const base = x.name;
      while (
        d.collections.some(
          (y) =>
            y !== x &&
            (y.parentId ?? null) === (x.parentId ?? null) &&
            y.name.toLowerCase() === x.name.toLowerCase(),
        )
      ) {
        x.name = `${base} (${n++})`;
      }
    }
    this.write(d);
    return { ok: true, movedFiles, movedCollections: moved.length };
  }

  // ── files ────────────────────────────────────────────────────────────

  get(id: string): SecureFileMeta | null {
    return this.read().files[id] ?? null;
  }

  private applyPatch(
    d: OrganizeDoc,
    id: string,
    patch: SecureFilePatch,
    now: number,
  ): SecureFileMeta {
    const m = d.files[id] ?? defaultMeta(now);
    if (patch.collectionId !== undefined) {
      const cid = patch.collectionId || null;
      if (cid && !d.collections.some((c) => c.id === cid))
        throw new SecureOrganizeError("collection not found");
      m.collectionId = cid;
    }
    if (patch.tags !== undefined) m.tags = normalizeTags(patch.tags);
    if (patch.addTags?.length) m.tags = normalizeTags([...(m.tags ?? []), ...patch.addTags]);
    if (patch.removeTags?.length) {
      const drop = new Set(normalizeTags(patch.removeTags).map((t) => t.toLowerCase()));
      m.tags = (m.tags ?? []).filter((t) => !drop.has(t.toLowerCase()));
    }
    if (patch.projectId !== undefined)
      m.projectId =
        typeof patch.projectId === "string" && patch.projectId.trim()
          ? patch.projectId.trim().slice(0, 120)
          : null;
    if (patch.name !== undefined) {
      const n = cleanDisplayName(patch.name);
      if (n) m.displayName = n;
      else delete m.displayName;
    }
    if (patch.notes !== undefined) {
      const n = cleanNotes(patch.notes);
      if (n) m.notes = n;
      else delete m.notes;
    }
    m.tags ??= [];
    m.updatedAt = now;
    d.files[id] = m;
    return m;
  }

  update(id: string, patch: SecureFilePatch): SecureFileMeta {
    const d = this.read();
    const m = this.applyPatch(d, id, patch, this.now());
    this.write(d);
    return m;
  }

  /** One sealed write for many files; validates first so a bad id changes nothing. */
  bulkUpdate(ids: string[], patch: SecureFilePatch): Record<string, SecureFileMeta> {
    const d = this.read();
    const now = this.now();
    const out: Record<string, SecureFileMeta> = {};
    for (const id of ids) out[id] = this.applyPatch(d, id, patch, now);
    this.write(d);
    return out;
  }

  forget(id: string): void {
    const d = this.read();
    if (!d.files[id]) return;
    delete d.files[id];
    this.write(d);
  }

  /** The public organise fields for list rows (one vault read for all of them). */
  fieldsFor(
    entries: Array<{ id: string; source?: { projectId?: string } }>,
  ): Map<string, SecureOrganizeFields> {
    const d = this.read();
    const byId = new Map(d.collections.map((c) => [c.id, c]));
    const out = new Map<string, SecureOrganizeFields>();
    for (const e of entries) {
      const m = d.files[e.id];
      const cid = m?.collectionId && byId.has(m.collectionId) ? m.collectionId : null;
      out.set(e.id, {
        collectionId: cid,
        collectionPath: cid ? this.pathOf(byId, cid) : "",
        tags: m?.tags ?? [],
        projectId:
          m?.projectId !== undefined ? (m.projectId ?? null) : (e.source?.projectId ?? null),
        displayName: m?.displayName ?? null,
        notes: m?.notes ?? "",
      });
    }
    return out;
  }
}
