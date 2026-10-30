/**
 * Agent-facing Secure Files organisation (the `secure_lane` and `file_context`
 * tools). Same sealed store and validation as the files.secure.* RPCs, plus
 * what an agent needs: resolve files and collections by id OR by name, and
 * return the REAL resulting state (re-read from the vault after every write)
 * so a reply can only claim what actually changed.
 */
import type { SecureVault } from "../secure-mode/vault.js";
import type { OcrService } from "./service.js";
import {
  SecureFilesOrganizer,
  SecureOrganizeError,
  type SecureFilePatch,
} from "./secure-organize.js";
import type { OcrEntry } from "./types.js";

export interface SecureFileRow {
  id: string;
  name: string;
  displayName: string | null;
  collectionId: string | null;
  collection: string;
  tags: string[];
  projectId: string | null;
  notes: string;
  status: string;
  size: number;
  createdAt: string;
}

const MAX_FILES = 2000;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export class SecureFilesOps {
  readonly org: SecureFilesOrganizer;

  constructor(
    vault: SecureVault,
    private readonly svc: Pick<OcrService, "list">,
  ) {
    this.org = new SecureFilesOrganizer(vault);
  }

  private entries(): OcrEntry[] {
    const list = this.svc.list("secure", { limit: MAX_FILES });
    this.org.migrate(list.map((e) => e.id));
    return list;
  }

  rows(entries = this.entries()): SecureFileRow[] {
    const fields = this.org.fieldsFor(entries);
    return entries.map((e) => {
      const f = fields.get(e.id)!;
      return {
        id: e.id,
        name: e.name,
        displayName: f.displayName,
        collectionId: f.collectionId,
        collection: f.collectionPath || "Unfiled",
        tags: f.tags,
        projectId: f.projectId,
        notes: f.notes,
        status: e.status,
        size: e.size,
        createdAt: new Date(e.createdAt).toISOString(),
      };
    });
  }

  listFiles(opts: { collection?: string; tag?: string; query?: string; limit?: number } = {}) {
    let rows = this.rows();
    if (opts.collection !== undefined) {
      const cid =
        opts.collection === "" || /^(root|unfiled)$/i.test(opts.collection)
          ? null
          : this.resolveCollection(opts.collection);
      rows = rows.filter((r) => r.collectionId === cid);
    }
    if (opts.tag) {
      const t = norm(opts.tag.replace(/^#/, ""));
      rows = rows.filter((r) => r.tags.some((x) => norm(x) === t));
    }
    if (opts.query) {
      const q = norm(opts.query);
      rows = rows.filter((r) => norm(`${r.name} ${r.displayName ?? ""} ${r.notes}`).includes(q));
    }
    return rows.slice(0, Math.max(1, Math.min(opts.limit ?? 200, MAX_FILES)));
  }

  /** A file by id, or by exact (case-insensitive) original or display name. */
  resolveFile(ref: string, rows = this.rows()): SecureFileRow {
    const r = ref.trim();
    if (!r) throw new SecureOrganizeError("file id or name is required");
    const byId = rows.find((x) => x.id === r);
    if (byId) return byId;
    const k = norm(r);
    const hits = rows.filter(
      (x) => norm(x.name) === k || (x.displayName && norm(x.displayName) === k),
    );
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new SecureOrganizeError(
        `"${ref}" matches ${hits.length} secure files (${hits.map((h) => h.id).join(", ")}); pass the id`,
      );
    }
    throw new SecureOrganizeError(`no secure file "${ref}" (use list_files for ids)`);
  }

  /** A collection by id, "A / B" path or unique name; optionally create a top-level one. */
  resolveCollection(ref: string, opts: { create?: boolean } = {}): string {
    const r = ref.trim();
    if (!r) throw new SecureOrganizeError("collection is required");
    const { collections } = this.org.listCollections();
    const byId = collections.find((c) => c.id === r);
    if (byId) return byId.id;
    const k = norm(r.replace(/\s*\/\s*/g, " / "));
    const byPath = collections.filter((c) => norm(c.path) === k);
    if (byPath.length === 1) return byPath[0].id;
    const byName = collections.filter((c) => norm(c.name) === k);
    if (byName.length === 1) return byName[0].id;
    if (byName.length > 1) {
      throw new SecureOrganizeError(
        `"${ref}" matches ${byName.length} collections (${byName.map((c) => `${c.path} = ${c.id}`).join("; ")}); pass the id or full path`,
      );
    }
    if (opts.create) return this.org.createCollection({ name: r }).id;
    throw new SecureOrganizeError(
      `no collection "${ref}" (create_collection first, or pass createCollection: true)`,
    );
  }

  collections() {
    const ids = this.entries().map((e) => e.id);
    const res = this.org.listCollections(ids);
    return {
      collections: res.collections.map((c) => ({
        id: c.id,
        name: c.name,
        path: c.path,
        parentId: c.parentId,
        files: c.count,
      })),
      unfiled: res.rootCount,
      total: ids.length,
      tags: res.tags,
    };
  }

  /**
   * Apply one patch to many files (ids or names). All refs resolve first, so
   * a bad ref changes nothing. Returns the rows re-read after the write and
   * the fields that really differ from before.
   */
  update(
    refs: string[],
    patch: SecureFilePatch & { collection?: string | null; createCollection?: boolean },
  ): { changed: number; unchanged: number; files: SecureFileRow[] } {
    if (!refs.length) throw new SecureOrganizeError("no files given");
    const before = this.rows();
    const ids = [...new Set(refs.map((r) => this.resolveFile(r, before).id))];
    if (patch.name !== undefined && ids.length > 1)
      throw new SecureOrganizeError("rename one file at a time (names are per file)");
    const { collection, createCollection, ...rest } = patch;
    const p: SecureFilePatch = { ...rest };
    if (collection !== undefined) {
      p.collectionId =
        collection === null || collection === "" || /^(root|unfiled)$/i.test(collection)
          ? null
          : this.resolveCollection(collection, { create: createCollection });
    }
    this.org.bulkUpdate(ids, p);
    const after = this.rows();
    const prev = new Map(before.map((r) => [r.id, JSON.stringify(r)]));
    const files = after.filter((r) => ids.includes(r.id));
    const changed = files.filter((r) => prev.get(r.id) !== JSON.stringify(r)).length;
    return { changed, unchanged: files.length - changed, files };
  }
}

export { SecureOrganizeError };
