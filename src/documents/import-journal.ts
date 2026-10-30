/**
 * Import undo journal + external-id ledger.
 *
 * Every import batch (Notion API, Notion ZIP, Obsidian vault, database →
 * projects/tasks/clients mapping) records what it changed so the whole batch
 * can be undone:
 *
 *   - documents: `journalStore(store, journal)` wraps the DocumentStore in a
 *     Proxy that sees every create/update/addFile/move the importers make
 *     (internal `this.create` calls inside upsertBySource go through the proxy
 *     too). Created nodes are trashed on undo (restorable from Trash); updated
 *     nodes get their pre-import title/body/properties/tags/parent back.
 *   - kanban projects/tasks + clients: the mapper records created and updated
 *     entity ids (with the fields it overwrote).
 *
 * The ledger maps an external key (`notion:<id>`, `obsidian:<vault>:<path>#…`)
 * to the local entity it produced, per role, so re-imports update in place
 * instead of duplicating (kanban/client rows have no source field of their own).
 */

import fs from "node:fs";
import path from "node:path";
import type { DocumentStore } from "./store.js";
import type { DocNode, DocPropertyValue } from "./types.js";

export type EntityRole = "projects" | "tasks" | "clients";

export interface DocBefore {
  title: string;
  body?: string;
  properties?: Record<string, DocPropertyValue>;
  tags?: string[];
  parentId: string | null;
  icon?: string;
  source?: DocNode["source"];
  deletedAt?: string;
}

export interface ImportJournal {
  version: 1;
  /** Doc node ids created by the batch (in creation order). */
  docsCreated: string[];
  /** Pre-batch snapshot of each doc node the batch modified (first write wins). */
  docsUpdated: Record<string, DocBefore>;
  entitiesCreated: Array<{ role: EntityRole; id: string; key?: string }>;
  entitiesUpdated: Array<{ role: EntityRole; id: string; before: Record<string, unknown> }>;
  undoneAt?: string;
}

export function emptyJournal(): ImportJournal {
  return { version: 1, docsCreated: [], docsUpdated: {}, entitiesCreated: [], entitiesUpdated: [] };
}

export function journalSize(j: ImportJournal): number {
  return (
    j.docsCreated.length +
    Object.keys(j.docsUpdated).length +
    j.entitiesCreated.length +
    j.entitiesUpdated.length
  );
}

function snapshotDoc(store: DocumentStore, node: DocNode): DocBefore {
  return {
    title: node.title,
    body: node.kind === "doc" ? store.getBody(node.id) : undefined,
    properties: node.properties ? { ...node.properties } : undefined,
    tags: node.tags ? [...node.tags] : undefined,
    parentId: node.parentId ?? null,
    icon: node.icon,
    source: node.source ? { ...node.source } : undefined,
    deletedAt: node.deletedAt,
  };
}

/**
 * A DocumentStore view that records writes into `journal`. Reads pass through.
 */
export function journalStore(store: DocumentStore, journal: ImportJournal): DocumentStore {
  const created = new Set(journal.docsCreated);
  const remember = (id: string) => {
    if (created.has(id) || journal.docsUpdated[id]) return;
    const node = store.getNode(id);
    if (node) journal.docsUpdated[id] = snapshotDoc(store, node);
  };
  const proxy: DocumentStore = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      switch (prop) {
        case "create":
        case "addFile":
          return (...args: unknown[]) => {
            const node = fn.apply(proxy, args) as DocNode;
            if (node?.id && !created.has(node.id)) {
              created.add(node.id);
              journal.docsCreated.push(node.id);
            }
            return node;
          };
        case "update":
          return (...args: unknown[]) => {
            const p = args[0] as { id?: string } | undefined;
            if (p?.id) remember(p.id);
            return fn.apply(proxy, args);
          };
        case "move":
        case "softDelete":
        case "setExtracted":
          return (...args: unknown[]) => {
            if (typeof args[0] === "string") remember(args[0]);
            return fn.apply(proxy, args);
          };
        case "upsertBySource":
          // upsertBySource may touch node.source / icon directly on the index
          // (unchanged path) — snapshot the existing node first.
          return (...args: unknown[]) => {
            const src = args[0] as { type?: string; id?: string } | undefined;
            if (src?.type && src.id) {
              const existing = target.findBySource(src.type as never, src.id);
              if (existing) remember(existing.id);
            }
            return fn.apply(proxy, args);
          };
        default:
          return fn.bind(proxy);
      }
    },
  });
  return proxy;
}

export interface UndoEntityDeps {
  deleteEntity: (role: EntityRole, id: string) => Promise<void>;
  restoreEntity: (role: EntityRole, id: string, before: Record<string, unknown>) => Promise<void>;
}

export interface UndoResult {
  trashed: number;
  restored: number;
  entitiesDeleted: number;
  entitiesRestored: number;
  errors: string[];
}

/** Reverse a batch. Idempotent-ish: trashed/missing nodes are skipped. */
export async function undoJournal(
  store: DocumentStore,
  journal: ImportJournal,
  entities?: UndoEntityDeps,
): Promise<UndoResult> {
  const out: UndoResult = {
    trashed: 0,
    restored: 0,
    entitiesDeleted: 0,
    entitiesRestored: 0,
    errors: [],
  };
  // Entities first (tasks before projects so project deletes don't cascade twice).
  if (entities) {
    const order: EntityRole[] = ["tasks", "clients", "projects"];
    for (const role of order) {
      for (const e of journal.entitiesCreated.filter((x) => x.role === role)) {
        try {
          await entities.deleteEntity(role, e.id);
          out.entitiesDeleted += 1;
        } catch (err) {
          out.errors.push(`${role} ${e.id}: ${(err as Error).message}`);
        }
      }
    }
    for (const e of journal.entitiesUpdated) {
      try {
        await entities.restoreEntity(e.role, e.id, e.before);
        out.entitiesRestored += 1;
      } catch (err) {
        out.errors.push(`${e.role} ${e.id}: ${(err as Error).message}`);
      }
    }
  }
  // Restore updated docs (parents before children is not required: update doesn't move).
  for (const [id, before] of Object.entries(journal.docsUpdated)) {
    const node = store.getNode(id);
    if (!node) continue;
    try {
      if (node.deletedAt && !before.deletedAt) store.restore(id);
      store.update({
        id,
        title: before.title,
        body: node.kind === "doc" ? (before.body ?? "") : undefined,
        properties: before.properties ?? {},
        tags: before.tags ?? [],
        icon: before.icon ?? "",
        source: before.source,
        snapshot: true,
      });
      if ((node.parentId ?? null) !== before.parentId) {
        const parentOk = before.parentId === null || !!store.getNode(before.parentId);
        if (parentOk) store.move(id, before.parentId);
      }
      out.restored += 1;
    } catch (err) {
      out.errors.push(`doc ${id}: ${(err as Error).message}`);
    }
  }
  // Trash created docs — top-most first; trashing a folder hides its subtree.
  const createdSet = new Set(journal.docsCreated);
  for (const id of journal.docsCreated) {
    const node = store.getNode(id);
    if (!node || node.deletedAt) continue;
    if (node.parentId && createdSet.has(node.parentId)) {
      // Parent is trashed with it — still count it.
      out.trashed += 1;
      continue;
    }
    store.softDelete(id);
    out.trashed += 1;
  }
  journal.undoneAt = new Date().toISOString();
  return out;
}

// ── Ledger ────────────────────────────────────────────────────

interface LedgerFile {
  version: 1;
  entries: Record<string, { id: string; at: string }>;
}

/** External key → local entity id, per role (persisted next to the documents index). */
export class ImportLedger {
  private data: LedgerFile | null = null;

  constructor(private readonly file: string) {}

  static forStore(store: DocumentStore): ImportLedger {
    return new ImportLedger(path.join(store.root, "import-ledger.json"));
  }

  private load(): LedgerFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as LedgerFile;
      this.data = parsed?.entries ? parsed : { version: 1, entries: {} };
    } catch {
      this.data = { version: 1, entries: {} };
    }
    return this.data;
  }

  get(role: EntityRole, key: string): string | null {
    return this.load().entries[`${role}|${key}`]?.id ?? null;
  }

  set(role: EntityRole, key: string, id: string): void {
    this.load().entries[`${role}|${key}`] = { id, at: new Date().toISOString() };
  }

  deleteById(role: EntityRole, id: string): void {
    const d = this.load();
    for (const [k, v] of Object.entries(d.entries)) {
      if (k.startsWith(`${role}|`) && v.id === id) delete d.entries[k];
    }
  }

  save(): void {
    if (!this.data) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
