/**
 * Notes ↔ Documents bridge.
 *
 * Existing notes (database-role rows when a DB is mapped to the "notes" role,
 * the file-based NoteStore otherwise) are migrated into the documents
 * workspace, non-destructively:
 *   - a JSON backup of every note is written to documents/backups/ first;
 *   - notes are never modified or deleted by the migration;
 *   - each note becomes a doc keyed by source {type:"note", id:<noteId>}, so
 *     re-running is idempotent.
 *
 * After migration the two stay in step:
 *   - note → doc: legacy writers (notes.* RPCs, the notes tool's note actions,
 *     Notion page sync, scripts) call broadcastNotesChanged → mirrorNoteChange.
 *   - doc → note: editing a migrated doc in the workspace writes the new
 *     title/body back to its note (writeBackToNote), so features that still
 *     read notes see the edit.
 */

import { NoteStore } from "../notes/store.js";
import { onNotesChanged, type NotesChange } from "../notes/notes-events.js";
import {
  getRoleMode,
  getRowForRole,
  listRowsForRole,
  upsertRowForRole,
} from "../databases/system-role-bridge.js";
import type { DocumentStore } from "./store.js";
import type { DocNode, DocPropertyValue } from "./types.js";

export interface BridgedNote {
  id: string;
  name: string;
  body: string;
  description?: string;
  tags?: string[];
  category?: string;
  pinned?: boolean;
  projectId?: string;
  documentFamilyId?: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
}

const NOTES_FOLDER_SOURCE = "__notes_folder__";

function legacyStore(): NoteStore {
  // Same resolution as the notes.* RPC handlers so both see the same files.
  return new NoteStore(process.env.INFINIBOT_STATE_DIR ?? "state");
}

function rowToBridged(row: {
  id: string;
  title: string;
  body: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}): BridgedNote {
  const v = row.values ?? {};
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return {
    id: row.id,
    name: row.title || "(untitled)",
    body: row.body ?? "",
    description: str(v.description),
    tags: Array.isArray(v.tags)
      ? (v.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : undefined,
    category: str(v.category),
    pinned: v.pinned === true,
    projectId: str(v.projectId),
    documentFamilyId: str(v.documentFamilyId),
    version: typeof v.version === "number" ? v.version : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function isDbMode(): boolean {
  return getRoleMode("notes").mode === "database";
}

export function listAllNotes(): BridgedNote[] {
  if (isDbMode()) return listRowsForRole("notes").map(rowToBridged);
  const store = legacyStore();
  return store
    .list({})
    .map((li) => store.get(li.id))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => ({ ...n, body: n.body ?? "" }));
}

export function getNote(id: string): BridgedNote | null {
  if (isDbMode()) {
    const row = getRowForRole("notes", id);
    return row ? rowToBridged(row) : null;
  }
  const n = legacyStore().get(id);
  return n ? { ...n, body: n.body ?? "" } : null;
}

function noteProperties(n: BridgedNote): Record<string, DocPropertyValue> {
  const p: Record<string, DocPropertyValue> = {};
  if (n.description) p.Description = n.description;
  if (n.category) p.Category = n.category;
  if (n.projectId) p.Project = n.projectId;
  if (n.pinned) p.Pinned = true;
  if (n.documentFamilyId) p["Version family"] = n.documentFamilyId;
  if (n.version != null) p.Version = n.version;
  return p;
}

function ensureNotesFolder(store: DocumentStore): DocNode {
  const existing = store.findBySource("note", NOTES_FOLDER_SOURCE);
  if (existing) return existing;
  return store.create({
    kind: "folder",
    title: "Notes",
    icon: "📝",
    parentId: null,
    source: { type: "note", id: NOTES_FOLDER_SOURCE },
  });
}

/** Upsert one note into the workspace. Returns the doc and what happened. */
export function syncNoteIntoDocuments(
  store: DocumentStore,
  note: BridgedNote,
): { node: DocNode; status: "created" | "updated" | "unchanged" | "skipped" } {
  const existing = store.findBySource("note", note.id);
  // Unchanged upstream since the last sync → don't clobber workspace edits.
  if (existing && existing.source?.remoteEditedAt === note.updatedAt) {
    return { node: existing, status: "unchanged" };
  }
  const parent = existing ? existing.parentId : ensureNotesFolder(store).id;
  return store.upsertBySource(
    {
      type: "note",
      id: note.id,
      remoteEditedAt: note.updatedAt,
      syncedAt: new Date().toISOString(),
    },
    {
      kind: "doc",
      id: existing ? undefined : note.id,
      title: note.name,
      body: note.body,
      parentId: parent,
      tags: note.tags,
      author: undefined,
      properties: noteProperties(note),
    },
  );
}

export interface NotesMigrationReport {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  backupPath: string | null;
  mode: "database" | "legacy";
  folderId: string | null;
}

/**
 * Import every note into the workspace. Idempotent; writes a backup of all
 * notes before touching anything. Notes themselves are left untouched.
 */
export function migrateNotesIntoDocuments(store: DocumentStore): NotesMigrationReport {
  const mode = isDbMode() ? "database" : "legacy";
  const notes = listAllNotes();
  const report: NotesMigrationReport = {
    total: notes.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    backupPath: null,
    mode,
    folderId: null,
  };
  if (notes.length > 0) {
    report.backupPath = store.backup("notes-premigration", { mode, notes });
    report.folderId = ensureNotesFolder(store).id;
  }
  for (const n of notes) {
    const r = syncNoteIntoDocuments(store, n);
    report[r.status] += 1;
  }
  store.setMigratedNotesAt(new Date().toISOString());
  return report;
}

/** Run the first-time migration if this user's workspace has never had one. */
export function ensureNotesMigrated(store: DocumentStore): NotesMigrationReport | null {
  if (store.getMeta().migratedNotesAt) return null;
  try {
    return migrateNotesIntoDocuments(store);
  } catch {
    return null;
  }
}

/**
 * Write a workspace edit of a migrated doc back to its note. Returns true when
 * the note was updated. Records the note's new updatedAt on the doc so the
 * mirror doesn't treat our own write as an upstream change.
 */
export function writeBackToNote(store: DocumentStore, node: DocNode): boolean {
  if (node.source?.type !== "note" || !node.source.id || node.kind !== "doc") return false;
  const noteId = node.source.id;
  const body = store.getBody(node.id);
  let updatedAt: string | null = null;
  try {
    if (isDbMode()) {
      const existing = getRowForRole("notes", noteId);
      if (!existing) return false;
      const row = upsertRowForRole("notes", { id: noteId, title: node.title, body });
      updatedAt = row ? new Date(row.updatedAt).toISOString() : null;
    } else {
      const n = legacyStore().update({ id: noteId, name: node.title, body });
      updatedAt = n?.updatedAt ?? null;
    }
  } catch {
    return false;
  }
  if (!updatedAt) return false;
  store.update({ id: node.id, source: { ...node.source, remoteEditedAt: updatedAt } });
  return true;
}

/** Apply one legacy note change to the workspace (mirror direction note → doc). */
export function mirrorNoteChange(store: DocumentStore, change: NotesChange): void {
  if (change.documents || !change.id) return;
  if (!store.getMeta().migratedNotesAt) return; // first open of the workspace migrates everything
  if (change.op === "delete") {
    const doc = store.findBySource("note", change.id);
    if (doc && !doc.deletedAt) store.softDelete(doc.id);
    return;
  }
  const note = getNote(change.id);
  if (note) syncNoteIntoDocuments(store, note);
}

let installed = false;

/** Subscribe the mirror to legacy note writes (idempotent). */
export function installNotesMirror(
  resolveStore: () => DocumentStore,
  onMirrored?: (c: NotesChange) => void,
): void {
  if (installed) return;
  installed = true;
  onNotesChanged((change) => {
    if (change.documents) return;
    try {
      mirrorNoteChange(resolveStore(), change);
      onMirrored?.(change);
    } catch {
      /* mirror is best-effort */
    }
  });
}
