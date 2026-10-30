/**
 * Notes gateway handlers — CRUD for markdown notes.
 *
 * Storage routing:
 *   - If the user has mapped a database to the "notes" system role,
 *     every CRUD operation goes through the system-role bridge into
 *     `database_rows`. This is the single source of truth that the
 *     /databases tab, the agent tool, and Notion sync all see.
 *   - If no role is mapped, fall back to the legacy file-based
 *     NoteStore at `{stateDir}/notes/*.md`. This preserves the
 *     out-of-the-box behavior for users who don't use databases.
 *
 * The migration handler (`notes.migrate_to_database`) is idempotent —
 * re-running it after a partial import just skips already-imported
 * legacy ids.
 */

import { NoteStore } from "../../notes/store.js";
import { broadcastNotesChanged } from "../../notes/notes-events.js";
import type {
  Note,
  NoteCreateParams,
  NoteSearchParams,
  NoteUpdateParams,
} from "../../notes/types.js";
import {
  describeRoleBridge,
  getRoleMode,
  importLegacyRecordsToRole,
  listRowsForRole,
  getRowForRole,
  upsertRowForRole,
  deleteRowForRole,
} from "../../databases/system-role-bridge.js";
import { applySatelliteProxy } from "../../federation/satellite-context.js";
import {
  annotateFamilies,
  collapseFamilies,
  sortVersionsDesc,
  currentOf,
  nextVersion,
  familySlug,
} from "../../notes/versioning.js";
import type { GatewayRequestHandlers } from "./types.js";
import { emitMediaArtifact } from "../../proactive/media-artifacts.js";

const getStore = () => {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  return new NoteStore(stateDir);
};

/**
 * Mandatory media visualization for markdown notes: a created/updated note with
 * a substantive markdown body surfaces as a stylized-markdown timeline overlay.
 * dedupKey is the note id so repeated saves of the same note collapse (the
 * router absorbs re-emits inside the FYI cooldown). Best-effort, never throws.
 */
function emitNoteMedia(id: string, name: string, body: unknown): void {
  if (typeof body !== "string" || body.trim().length < 40) return;
  emitMediaArtifact({
    agentId: "notes",
    agentName: "Notes",
    title: name || "Note",
    body: "",
    dedupKey: `md:note:${id}`,
    media: {
      kind: "stylized-markdown",
      payload: { markdown: body, title: name || "Note", sequential: true },
    },
  });
}

/**
 * Keep the project ↔ note pair in relations.db (the web project page's
 * Related › Notes list) in line with the note's projectId. Best-effort.
 */
async function syncNoteProject(
  id: string,
  before: string | undefined | null,
  after: string | undefined | null,
): Promise<void> {
  if ((before || "") === (after || "")) return;
  try {
    const { defaultEntityLinker, syncProjectLinks } = await import("../../ideas/project-links.js");
    syncProjectLinks(
      { kind: "note", id, before: [before], after: [after] },
      { entity: await defaultEntityLinker() },
    );
  } catch {
    /* index only */
  }
}

/** Same for the note's CRM client (client page + knowledge graph). */
async function syncNoteClient(
  id: string,
  before: string | undefined | null,
  after: string | undefined | null,
): Promise<void> {
  if ((before || "") === (after || "")) return;
  try {
    const [{ defaultEntityLinker, syncClientLinks }, { defaultRelationWriter }] = await Promise.all(
      [import("../../ideas/project-links.js"), import("../../ideas/service.js")],
    );
    syncClientLinks(
      { kind: "note", id, before: [before], after: [after] },
      {
        entity: await defaultEntityLinker(),
        objrel: await defaultRelationWriter().catch(() => null),
      },
    );
  } catch {
    /* index only */
  }
}

/* ─── Row ↔ Note shape adapters ────────────────────────────────── */

function rowToNote(row: {
  id: string;
  title: string;
  body: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}): Note {
  const values = row.values ?? {};
  return {
    id: row.id,
    name: row.title || "(untitled)",
    description:
      typeof values.description === "string" ? (values.description as string) : undefined,
    tags: Array.isArray(values.tags)
      ? (values.tags as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined,
    body: row.body ?? "",
    category: typeof values.category === "string" ? (values.category as string) : undefined,
    pinned: values.pinned === true,
    projectId: typeof values.projectId === "string" ? (values.projectId as string) : undefined,
    clientId:
      typeof values.clientId === "string" && values.clientId
        ? (values.clientId as string)
        : undefined,
    reviewOn:
      typeof values.reviewOn === "string" && values.reviewOn
        ? (values.reviewOn as string)
        : undefined,
    documentFamilyId:
      typeof values.documentFamilyId === "string" ? (values.documentFamilyId as string) : undefined,
    version:
      typeof values.version === "number"
        ? (values.version as number)
        : typeof values.version === "string" && values.version.trim() !== ""
          ? Number(values.version)
          : undefined,
    versionLabel:
      typeof values.versionLabel === "string" ? (values.versionLabel as string) : undefined,
    supersededBy:
      typeof values.supersededBy === "string" ? (values.supersededBy as string) : undefined,
    supersedes: typeof values.supersedes === "string" ? (values.supersedes as string) : undefined,
    isCurrent: values.isCurrent === true,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** Build the `values` object persisted on a database row from a note shape. */
function versionValues(n: {
  documentFamilyId?: string;
  version?: number;
  versionLabel?: string;
  supersededBy?: string;
  supersedes?: string;
  isCurrent?: boolean;
}): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (n.documentFamilyId != null) v.documentFamilyId = n.documentFamilyId;
  if (n.version != null) v.version = n.version;
  if (n.versionLabel != null) v.versionLabel = n.versionLabel;
  if (n.supersededBy != null) v.supersededBy = n.supersededBy;
  if (n.supersedes != null) v.supersedes = n.supersedes;
  if (n.isCurrent != null) v.isCurrent = n.isCurrent;
  return v;
}

/* ─── Mode-agnostic note access (for the family/versioning RPCs) ── */

const isDbMode = () => getRoleMode("notes").mode === "database";

/** Load every note (with body) regardless of storage mode. */
function loadAllNotes(): Note[] {
  if (isDbMode()) return listRowsForRole("notes").map(rowToNote);
  return getStore()
    .list({})
    .map((li) => getStore().get(li.id))
    .filter((n): n is Note => Boolean(n));
}

function loadNote(id: string): Note | null {
  if (isDbMode()) {
    const row = getRowForRole("notes", id);
    return row ? rowToNote(row) : null;
  }
  return getStore().get(id);
}

/** Patch versioning (and optionally name/body) fields on a note in either mode. */
function patchNote(
  id: string,
  patch: Partial<
    Pick<
      Note,
      | "name"
      | "body"
      | "documentFamilyId"
      | "version"
      | "versionLabel"
      | "supersededBy"
      | "supersedes"
      | "isCurrent"
    >
  >,
): Note | null {
  if (isDbMode()) {
    const existing = getRowForRole("notes", id);
    if (!existing) return null;
    const row = upsertRowForRole("notes", {
      id,
      title: patch.name,
      body: typeof patch.body === "string" ? patch.body : undefined,
      values: {
        ...existing.values,
        ...versionValues(patch),
      } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
    });
    return row ? rowToNote(row) : null;
  }
  return getStore().update({ id, ...patch });
}

/** Create a note in either mode (used by notes.newVersion). */
function createNoteAnyMode(p: NoteCreateParams): Note | null {
  if (isDbMode()) {
    const row = upsertRowForRole("notes", {
      title: p.name,
      body: p.body,
      values: {
        description: p.description,
        tags: p.tags,
        category: p.category,
        pinned: p.pinned,
        projectId: p.projectId,
        ...versionValues(p),
      } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
    });
    return row ? rowToNote(row) : null;
  }
  return getStore().create(p);
}

/**
 * Recompute denormalized `isCurrent` / `supersededBy` / `supersedes` for every
 * member of a family and return the members newest-first. Safe to call after
 * any family mutation. (notes.list also recomputes these on read, so this is a
 * convenience for the graceful-degradation path.)
 */
function recomputeFamily(familyId: string): Note[] {
  const members = loadAllNotes().filter((n) => n.documentFamilyId === familyId);
  const sorted = sortVersionsDesc(members);
  sorted.forEach((m, i) => {
    const newer = i > 0 ? sorted[i - 1] : undefined;
    const older = i < sorted.length - 1 ? sorted[i + 1] : undefined;
    patchNote(m.id, {
      isCurrent: i === 0,
      supersededBy: newer?.id,
      supersedes: older?.id,
    });
  });
  return sortVersionsDesc(loadAllNotes().filter((n) => n.documentFamilyId === familyId));
}

/** Strip body from a note for list responses. */
function toFamilyItem(n: Note) {
  const { body, ...rest } = n;
  return {
    ...rest,
    preview: (body ?? "").slice(0, 200).replace(/\n/g, " ").trim(),
    bodyLength: (body ?? "").length,
  };
}

/* ─── Handlers ─────────────────────────────────────────────────── */

const _rawNoteHandlers: GatewayRequestHandlers = {
  "notes.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Partial<NoteSearchParams> & {
        since?: number;
        includeArchived?: boolean;
      };
      const collapseVersions = <T extends Note | import("../../notes/types.js").NoteListItem>(
        notes: T[],
      ): T[] => {
        const annotated = annotateFamilies(notes);
        const result = p.documentFamilyId
          ? annotated.filter((n) => n.documentFamilyId === p.documentFamilyId)
          : annotated;
        return (p.includeAllVersions ? result : collapseFamilies(result)) as unknown as T[];
      };
      const role = getRoleMode("notes");
      if (role.mode === "database") {
        const rows = listRowsForRole("notes");
        let notes = rows.map(rowToNote);
        if (p.query) {
          const q = p.query.toLowerCase();
          notes = notes.filter(
            (n) =>
              n.name.toLowerCase().includes(q) ||
              n.body.toLowerCase().includes(q) ||
              (n.description ?? "").toLowerCase().includes(q),
          );
        }
        if (p.tags?.length) {
          notes = notes.filter((n) => (p.tags ?? []).every((t) => (n.tags ?? []).includes(t)));
        }
        if (p.category) {
          notes = notes.filter((n) => n.category === p.category);
        }
        if (typeof p.pinned === "boolean") {
          notes = notes.filter((n) => Boolean(n.pinned) === p.pinned);
        }
        if (p.projectId) {
          notes = notes.filter((n) => n.projectId === p.projectId);
        }
        if (p.clientId) {
          notes = notes.filter((n) => n.clientId === p.clientId);
        }
        if (p.since != null) {
          notes = notes.filter((n) => new Date(n.updatedAt).getTime() > p.since!);
        }
        notes = collapseVersions(notes);
        if (p.limit) notes = notes.slice(0, p.limit);
        respond(true, {
          notes,
          count: notes.length,
          mode: "database",
          databaseId: role.databaseId,
        });
        return;
      }
      const items = getStore().list(p);
      const filtered =
        p.since != null
          ? items.filter((n) => {
              const ts =
                typeof n.updatedAt === "string"
                  ? new Date(n.updatedAt).getTime()
                  : Number(n.updatedAt);
              return ts > p.since!;
            })
          : items;
      const collapsed = collapseVersions(filtered);
      respond(true, { notes: collapsed, count: collapsed.length, mode: "legacy" });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notes.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      if (getRoleMode("notes").mode === "database") {
        const row = getRowForRole("notes", id);
        if (!row) {
          respond(false, undefined, { code: "NOT_FOUND", message: `Note "${id}" not found` });
          return;
        }
        respond(true, rowToNote(row));
        return;
      }
      const note = getStore().get(id);
      if (!note) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Note "${id}" not found` });
        return;
      }
      respond(true, note);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notes.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as NoteCreateParams;
      if (!p.name || typeof p.body !== "string") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and body are required",
        });
        return;
      }
      if (getRoleMode("notes").mode === "database") {
        const row = upsertRowForRole("notes", {
          title: p.name,
          body: p.body,
          values: {
            description: p.description,
            tags: p.tags,
            category: p.category,
            pinned: p.pinned,
            projectId: p.projectId,
            clientId: p.clientId,
            reviewOn: p.reviewOn,
            ...versionValues(p),
          } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
        });
        if (!row) {
          respond(false, undefined, {
            code: "INTERNAL_ERROR",
            message: "upsertRowForRole returned null",
          });
          return;
        }
        broadcastNotesChanged({ op: "create", id: row.id, name: row.title });
        emitNoteMedia(row.id, row.title, row.body);
        await syncNoteProject(row.id, null, p.projectId);
        await syncNoteClient(row.id, null, p.clientId);
        respond(true, rowToNote(row));
        return;
      }
      const note = getStore().create(p);
      await syncNoteProject(note.id, null, p.projectId);
      await syncNoteClient(note.id, null, p.clientId);
      broadcastNotesChanged({ op: "create", id: note.id, name: note.name });
      emitNoteMedia(note.id, note.name, p.body);
      respond(true, note);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notes.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as NoteUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      if (getRoleMode("notes").mode === "database") {
        const existing = getRowForRole("notes", p.id);
        if (!existing) {
          respond(false, undefined, { code: "NOT_FOUND", message: `Note "${p.id}" not found` });
          return;
        }
        const row = upsertRowForRole("notes", {
          id: p.id,
          title: p.name,
          body: typeof p.body === "string" ? p.body : undefined,
          values: {
            ...existing.values,
            description: p.description ?? existing.values?.description,
            tags: p.tags ?? existing.values?.tags,
            category: p.category ?? existing.values?.category,
            pinned: p.pinned ?? existing.values?.pinned,
            projectId: p.projectId ?? existing.values?.projectId,
            clientId: p.clientId ?? existing.values?.clientId,
            reviewOn: p.reviewOn ?? existing.values?.reviewOn,
            documentFamilyId: p.documentFamilyId ?? existing.values?.documentFamilyId,
            version: p.version ?? existing.values?.version,
            versionLabel: p.versionLabel ?? existing.values?.versionLabel,
            supersededBy: p.supersededBy ?? existing.values?.supersededBy,
            supersedes: p.supersedes ?? existing.values?.supersedes,
            isCurrent: p.isCurrent ?? existing.values?.isCurrent,
          } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
        });
        if (!row) {
          respond(false, undefined, {
            code: "INTERNAL_ERROR",
            message: "upsertRowForRole returned null",
          });
          return;
        }
        broadcastNotesChanged({ op: "update", id: row.id, name: row.title });
        if (typeof p.body === "string") emitNoteMedia(row.id, row.title, row.body);
        if (p.projectId !== undefined)
          await syncNoteProject(
            row.id,
            typeof existing.values?.projectId === "string" ? existing.values.projectId : null,
            p.projectId,
          );
        if (p.clientId !== undefined)
          await syncNoteClient(
            row.id,
            typeof existing.values?.clientId === "string" ? existing.values.clientId : null,
            p.clientId,
          );
        respond(true, rowToNote(row));
        return;
      }
      const prevNote =
        p.projectId !== undefined || p.clientId !== undefined ? getStore().get(p.id) : null;
      const prevProjectId = prevNote?.projectId;
      const note = getStore().update(p);
      if (!note) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Note "${p.id}" not found` });
        return;
      }
      broadcastNotesChanged({ op: "update", id: note.id, name: note.name });
      if (typeof p.body === "string") emitNoteMedia(note.id, note.name, p.body);
      if (p.projectId !== undefined) await syncNoteProject(note.id, prevProjectId, p.projectId);
      if (p.clientId !== undefined) await syncNoteClient(note.id, prevNote?.clientId, p.clientId);
      respond(true, note);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notes.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      if (getRoleMode("notes").mode === "database") {
        const ok = deleteRowForRole("notes", id);
        if (!ok) {
          respond(false, undefined, { code: "NOT_FOUND", message: `Note "${id}" not found` });
          return;
        }
        broadcastNotesChanged({ op: "delete", id });
        respond(true, { deleted: true, id });
        return;
      }
      const deleted = getStore().delete(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Note "${id}" not found` });
        return;
      }
      broadcastNotesChanged({ op: "delete", id });
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * List every version in a document family, newest-first.
   * Each item carries version / versionLabel / isCurrent / dates (+ preview).
   */
  "notes.familyList": async ({ params, respond }) => {
    try {
      const { familyId } = (params ?? {}) as { familyId?: string };
      if (!familyId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "familyId is required" });
        return;
      }
      const members = loadAllNotes().filter((n) => n.documentFamilyId === familyId);
      const sorted = sortVersionsDesc(members).map((n, i) => ({
        ...toFamilyItem(n),
        isCurrent: i === 0,
      }));
      respond(true, { familyId, versions: sorted, count: sorted.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** The single current (highest-version) note of a family, with body. */
  "notes.familyCurrent": async ({ params, respond }) => {
    try {
      const { familyId } = (params ?? {}) as { familyId?: string };
      if (!familyId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "familyId is required" });
        return;
      }
      const members = loadAllNotes().filter((n) => n.documentFamilyId === familyId);
      const current = currentOf(members);
      if (!current) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Family "${familyId}" is empty` });
        return;
      }
      respond(true, current);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Promote an existing note into a family at a given version. If `version`
   * is omitted, append as the next version. Recomputes the family afterward.
   */
  "notes.linkAsVersion": async ({ params, respond }) => {
    try {
      const { noteId, familyId, version, versionLabel } = (params ?? {}) as {
        noteId?: string;
        familyId?: string;
        version?: number;
        versionLabel?: string;
      };
      if (!noteId || !familyId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "noteId and familyId are required",
        });
        return;
      }
      const note = loadNote(noteId);
      if (!note) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Note "${noteId}" not found` });
        return;
      }
      const existing = loadAllNotes().filter(
        (n) => n.documentFamilyId === familyId && n.id !== noteId,
      );
      const v = typeof version === "number" ? version : nextVersion(existing);
      patchNote(noteId, { documentFamilyId: familyId, version: v, versionLabel });
      const versions = recomputeFamily(familyId);
      respond(true, { familyId, noteId, version: v, count: versions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Create the next version of a note. Auto-increments the version, marks the
   * new note current, and demotes the previous current. If the source note is
   * not yet in a family, one is created (slug of its name) and the source
   * becomes v1.
   */
  "notes.newVersion": async ({ params, respond }) => {
    try {
      const { fromNoteId, body, versionLabel, name } = (params ?? {}) as {
        fromNoteId?: string;
        body?: string;
        versionLabel?: string;
        name?: string;
      };
      if (!fromNoteId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "fromNoteId is required" });
        return;
      }
      const from = loadNote(fromNoteId);
      if (!from) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Note "${fromNoteId}" not found`,
        });
        return;
      }
      let familyId = from.documentFamilyId;
      if (!familyId) {
        familyId = familySlug(from.name);
        // Backfill the source as v1 of the new family.
        patchNote(fromNoteId, { documentFamilyId: familyId, version: from.version ?? 1 });
      }
      const members = loadAllNotes().filter((n) => n.documentFamilyId === familyId);
      const v = nextVersion(members);
      const created = createNoteAnyMode({
        name: name ?? from.name,
        body: typeof body === "string" ? body : from.body,
        description: from.description,
        tags: from.tags,
        category: from.category,
        author: from.author,
        documentFamilyId: familyId,
        version: v,
        versionLabel,
      });
      if (!created) {
        respond(false, undefined, {
          code: "INTERNAL_ERROR",
          message: "Failed to create new version",
        });
        return;
      }
      const versions = recomputeFamily(familyId);
      respond(true, { familyId, note: created, version: v, count: versions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * One-shot idempotent backfill: fold the three June-2026 competitor reports
   * into the `infinibot-competitor-analysis` family (v1/v2/v3, v3 current).
   * Safe to re-run — already-correct notes are skipped. Accepts an optional
   * custom { familyId, members:[{noteId,version,versionLabel}] } payload.
   */
  "notes.backfillVersionFamilies": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        familyId?: string;
        members?: Array<{ noteId: string; version: number; versionLabel?: string }>;
      };
      const familyId = p.familyId ?? "infinibot-competitor-analysis";
      const members = p.members ?? [
        {
          noteId: "row_a0be3614-c959-43e4-b807-5398ee96f49e",
          version: 1,
          versionLabel: "Competitive Landscape",
        },
        {
          noteId: "row_45d9c496-81bd-455b-86c1-38b2b01bf0fc",
          version: 2,
          versionLabel: "Business OS reframe",
        },
        {
          noteId: "row_4781b361-bd72-4567-b129-84db49f99dc9",
          version: 3,
          versionLabel: "Mobile + local stack expansion",
        },
      ];
      const applied: string[] = [];
      const skipped: string[] = [];
      const missing: string[] = [];
      for (const m of members) {
        const note = loadNote(m.noteId);
        if (!note) {
          missing.push(m.noteId);
          continue;
        }
        if (note.documentFamilyId === familyId && note.version === m.version) {
          skipped.push(m.noteId);
          continue;
        }
        patchNote(m.noteId, {
          documentFamilyId: familyId,
          version: m.version,
          versionLabel: m.versionLabel,
        });
        applied.push(m.noteId);
      }
      const versions = recomputeFamily(familyId);
      respond(true, {
        familyId,
        applied,
        skipped,
        missing,
        currentId: versions[0]?.id ?? null,
        count: versions.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * One-shot migrate file-store notes into the role-mapped database.
   * Returns a count of imported/skipped/errors. Idempotent — already-
   * imported legacy ids are detected via the `_infinibot_legacy_notes`
   * marker stored on each row.
   */
  "notes.migrate_to_database": async ({ respond }) => {
    try {
      const role = getRoleMode("notes");
      if (role.mode !== "database" || !role.databaseId) {
        respond(false, undefined, {
          code: "NO_ROLE_MAPPED",
          message:
            "Map a database to the 'notes' system role first (Settings → Databases → assign), then run migrate again.",
        });
        return;
      }
      const legacy = getStore().list({});
      const records = legacy.map((n) => {
        const full = getStore().get(n.id);
        return {
          legacyId: n.id,
          title: n.name,
          body: full?.body ?? "",
          values: {
            description: n.description,
            tags: n.tags,
            category: n.category,
            pinned: n.pinned,
            projectId: (n as any).projectId,
          } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
        };
      });
      const result = importLegacyRecordsToRole("notes", records);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Confirm a note still exists and optionally validate its body hash.
   * Returns { exists: true, note } or { exists: false }.
   * Optionally accepts expectedHash (SHA-256 of body) for content verification.
   */
  "notes.verify": async ({ params, respond }) => {
    try {
      const { id, expectedHash } = (params ?? {}) as { id?: string; expectedHash?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      let note: import("../../notes/types.js").Note | null = null;
      if (getRoleMode("notes").mode === "database") {
        const row = getRowForRole("notes", id);
        if (row) note = rowToNote(row);
      } else {
        note = getStore().get(id);
      }
      if (!note) {
        respond(true, { id, exists: false });
        return;
      }
      if (expectedHash) {
        const { createHash } = await import("node:crypto");
        const actualHash = createHash("sha256")
          .update(note.body ?? "")
          .digest("hex");
        respond(true, { id, exists: true, hashMatch: actualHash === expectedHash, note });
        return;
      }
      respond(true, { id, exists: true, note });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Quick status snapshot: where notes live right now (database vs file),
   * counts on each side, and the drift state. Used by the /notes view's
   * banner and the /databases system-roles panel.
   */
  "notes.bridge_status": async ({ respond }) => {
    try {
      const legacyCount = getStore().list({}).length;
      respond(true, describeRoleBridge("notes", legacyCount));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * OCR a rendered handwriting/diagram page into markdown.
   *
   * Used by the mobile GoodNotes-style handwriting canvas: it captures each
   * page as a PNG and sends it here for transcription. We route to Claude
   * Vision (best quality for messy handwriting + diagrams) with an OCR→markdown
   * prompt, and fall back to a local Ollama vision model when no Anthropic key
   * is configured. Diagrams are asked to come back as mermaid / tables / lists.
   *
   * params: { imageBase64 | imageDataUrl, prompt?, backend?: "auto"|"claude"|"local", label? }
   * returns: { markdown, backend, latencyMs }
   */
  "notes.ocr": async ({ params, respond }) => {
    const startedAt = Date.now();
    try {
      const p = (params ?? {}) as {
        imageBase64?: string;
        imageDataUrl?: string;
        prompt?: string;
        backend?: "auto" | "claude" | "local";
        label?: string;
      };

      // Accept either a raw base64 string or a full data URL.
      let base64 = "";
      let mime = "image/png";
      const dataUrl = typeof p.imageDataUrl === "string" ? p.imageDataUrl : "";
      if (dataUrl) {
        const m = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
        if (!m) {
          respond(false, undefined, {
            code: "INVALID_IMAGE",
            message: "imageDataUrl must be a base64 image data URL",
          });
          return;
        }
        mime = m[1];
        base64 = m[2];
      } else if (typeof p.imageBase64 === "string" && p.imageBase64.length > 0) {
        base64 = p.imageBase64.replace(/^data:[^,]+,/, "");
      } else {
        respond(false, undefined, {
          code: "NO_IMAGE",
          message: "Provide imageDataUrl or imageBase64",
        });
        return;
      }

      const ocrPrompt =
        typeof p.prompt === "string" && p.prompt.trim()
          ? p.prompt
          : [
              "You are an OCR + diagram transcription engine.",
              "The image is a page from a handwritten notebook that may contain",
              "cursive/print handwriting, sketches, flowcharts, arrows, boxes,",
              "tables and drawings.",
              "",
              "Transcribe EVERYTHING into clean GitHub-Flavored Markdown:",
              "- Handwritten prose → paragraphs; preserve headings (#, ##).",
              "- Bulleted / numbered lists → markdown lists.",
              "- Tabular data → markdown tables.",
              "- Flowcharts / node-and-arrow diagrams / mind maps → a ```mermaid``` code block",
              "  (flowchart TD / graph LR as appropriate), labelling nodes with the",
              "  written text and edges with any arrow labels.",
              "- Standalone shapes with a label → a list item describing them.",
              "",
              "Do not add commentary, do not wrap the whole answer in a code fence,",
              "and do not invent content that is not visibly present. If the page is",
              "blank, return an empty string.",
            ].join("\n");

      const backend = p.backend === "claude" || p.backend === "local" ? p.backend : "auto";
      const apiKey = process.env.ANTHROPIC_API_KEY;

      async function viaClaude(): Promise<string> {
        if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
        const model = process.env.NOTES_OCR_MODEL || "claude-sonnet-4-20250514";
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 2048,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: { type: "base64", media_type: mime, data: base64 },
                  },
                  { type: "text", text: ocrPrompt },
                ],
              },
            ],
          }),
        });
        if (!resp.ok) {
          throw new Error(`Claude API error: ${resp.status} - ${await resp.text()}`);
        }
        const json = (await resp.json()) as any;
        return String(json?.content?.[0]?.text ?? "").trim();
      }

      async function viaLocal(): Promise<string> {
        const ollamaUrl = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
        const model = process.env.LOCAL_VISION_MODEL || "llava:7b";
        const resp = await fetch(`${ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: ocrPrompt, images: [base64] }],
            stream: false,
            options: { temperature: 0.2, num_predict: 1200 },
          }),
        });
        if (!resp.ok) throw new Error(`Ollama error: ${resp.status}`);
        const json = (await resp.json()) as any;
        return String(json?.message?.content ?? json?.response ?? "").trim();
      }

      let markdown = "";
      let used: "claude" | "local" = "claude";
      if (backend === "local") {
        markdown = await viaLocal();
        used = "local";
      } else if (backend === "claude") {
        markdown = await viaClaude();
        used = "claude";
      } else {
        // auto: prefer Claude, gracefully fall back to local.
        try {
          markdown = await viaClaude();
          used = "claude";
        } catch (claudeErr) {
          try {
            markdown = await viaLocal();
            used = "local";
          } catch (localErr) {
            respond(false, undefined, {
              code: "OCR_UNAVAILABLE",
              message:
                "No vision backend available. Set ANTHROPIC_API_KEY for cloud OCR, " +
                "or run Ollama with a vision model (e.g. `ollama pull llava:7b`). " +
                `claude: ${String(claudeErr)}; local: ${String(localErr)}`,
            });
            return;
          }
        }
      }

      respond(true, { markdown, backend: used, latencyMs: Date.now() - startedAt });
    } catch (e) {
      respond(false, undefined, { code: "OCR_ERROR", message: String(e) });
    }
  },
};

// In satellite mode, every notes.* call proxies to master so the user sees a
// single shared notes registry across every device. Falls back to the local
// store when the satellite is disconnected.
export const noteHandlers: GatewayRequestHandlers = applySatelliteProxy(_rawNoteHandlers);
