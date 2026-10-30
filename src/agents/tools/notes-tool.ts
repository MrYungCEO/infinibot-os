/**
 * Notes agent tool — lets agents list, read, create, update, and delete notes.
 *
 * Routes through the same system-role bridge as the gateway notes.* handlers so
 * MCP-tool writes land in the same store the UI reads from (database_rows when a
 * database is mapped to the "notes" role; file-based NoteStore otherwise).
 */

import { Type } from "@sinclair/typebox";

import {
  resolveClientParam,
  resolveDateParam,
  syncItemClient,
  whenString,
} from "../../ideas/agent-params.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { NoteStore } from "../../notes/store.js";
import { broadcastNotesChanged } from "../../notes/notes-events.js";
import {
  getRoleMode,
  listRowsForRole,
  getRowForRole,
  upsertRowForRole,
  deleteRowForRole,
} from "../../databases/system-role-bridge.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  DOCUMENT_ACTIONS,
  DocumentActionParams,
  applyTypeToNote,
  createIdeaFromTool,
  runDocumentAction,
  validateDocType,
} from "./documents-actions.js";

const NOTE_ACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "search",
  "verify",
  // Documents workspace (folders, docs, uploaded files — see documents-actions.ts)
  ...DOCUMENT_ACTIONS,
] as const;

const NotesToolSchema = Type.Object({
  action: stringEnum(NOTE_ACTIONS),
  /** Note ID (for get/update/delete/verify). */
  id: Type.Optional(Type.String()),
  /** Note name (for create). */
  name: Type.Optional(Type.String()),
  /** Short description (for create/update). */
  description: Type.Optional(Type.String()),
  /** Markdown body content (for create/update). */
  body: Type.Optional(Type.String()),
  /** Comma-separated tags (for create/update/search). */
  tags: Type.Optional(Type.String()),
  /** Search query string (for search/list). */
  query: Type.Optional(Type.String()),
  /** Category (for create/update/search). */
  category: Type.Optional(Type.String()),
  /** Whether note is pinned (for create/update). */
  pinned: Type.Optional(Type.Boolean()),
  /** Comma-separated linked note IDs (for create/update). */
  linkedTo: Type.Optional(Type.String()),
  /** Kanban project ID to link this note to (for create/update/list). */
  projectId: Type.Optional(Type.String()),
  /**
   * CRM client this note is for (create/update/list): a client id, or an exact /
   * unambiguous client name. "" or "none" clears it on update.
   */
  clientId: Type.Optional(Type.String()),
  /**
   * Review / follow-up date (create/update): "YYYY-MM-DD", "YYYY-MM-DDTHH:mm", or
   * words in the owner's timezone ("next Friday at 3", "in two weeks"). "" clears.
   */
  reviewOn: Type.Optional(Type.String()),
  /** Max results to return. */
  limit: Type.Optional(Type.Number()),
  /** Only return notes updated after this Unix-ms timestamp (incremental sync). */
  since: Type.Optional(Type.Number()),
  /**
   * Optional caller-generated idempotency key. If supplied on create, a second
   * call with the same id will skip the insert and return the existing note.
   */
  clientRequestId: Type.Optional(Type.String()),
  ...DocumentActionParams,
});

function getLegacyStore(): NoteStore {
  return new NoteStore(STATE_DIR);
}

function parseTags(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseLinkedTo(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Convert a database_rows view record to the public Note shape. */
function rowToNote(row: {
  id: string;
  title: string;
  body: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}) {
  const v = row.values ?? {};
  return {
    id: row.id,
    name: row.title || "(untitled)",
    description: typeof v.description === "string" ? v.description : undefined,
    tags: Array.isArray(v.tags)
      ? (v.tags as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined,
    body: row.body ?? "",
    category: typeof v.category === "string" ? v.category : undefined,
    pinned: v.pinned === true,
    projectId: typeof v.projectId === "string" ? v.projectId : undefined,
    clientId: typeof v.clientId === "string" && v.clientId ? v.clientId : undefined,
    reviewOn: typeof v.reviewOn === "string" && v.reviewOn ? v.reviewOn : undefined,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export function createNotesTool(options?: { agentId?: string }): AnyAgentTool {
  const agentId = options?.agentId || "main";

  return {
    label: "Notes",
    name: "notes",
    description:
      `Manage markdown notes. Actions: ` +
      `list (list all notes, supports since/limit), ` +
      `get (read a note by id), ` +
      `create (create new note with name + body), ` +
      `update (update note fields by id), ` +
      `delete (remove a note by id), ` +
      `search (find notes by query/tags/category), ` +
      `verify (confirm a note id still exists and matches expected content). ` +
      `projectId links a note to a kanban project; clientId (id or exact client name) links it to a CRM client so it shows on that client's page; ` +
      `reviewOn sets a review / follow-up date ("YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or words like "next Friday at 3"). ` +
      `DOCUMENT TYPES: pass type on create/create_doc/update_doc to file it as note, document, meeting, research, sop, spec, brief, journal, plan, template, snippet, idea (goes to the Ideas store) or a custom type (doc_types lists them); ` +
      `list/search/library with type (and optional category) list every item of that type across documents, ideas, reports and research. Don't default everything to a note — pick the type that fits. ` +
      `DOCUMENTS WORKSPACE (the Documents page: nested folders, markdown docs, uploaded PDFs/DOCX/XLSX/PPTX/images/media, Notion imports): ` +
      `tree (folder tree with ids; folderId limits to a subtree), ` +
      `read (id → a doc's markdown, a file's extracted text, or a folder's listing + database properties), ` +
      `doc_search (query across titles, doc bodies and extracted file text; optional folderId), ` +
      `create_doc (title + body markdown, optional parentId folder), update_doc (id + title/body/properties JSON), ` +
      `append_doc (id + body appended), create_folder (title, optional parentId), move_doc (id + parentId, empty = root), ` +
      `delete_doc (id → trash, restorable), restore_doc (id), doc_history (id → revisions), ` +
      `upload_url (url → stored + text extracted), upload_path (local file path, self-hosted only), ` +
      `import_notion (notionIds comma-separated page/database ids or URLs; databases become folders with a property table; runs as a background job — returns the report when it finishes within ~45s, else status "running" + jobId: call again with the same notionIds to check progress; idempotent re-sync, force=true refetches), ` +
      `import_notion_zip (path to a Notion "Markdown & CSV" export zip; background job like import_notion), ` +
      `import_obsidian (Obsidian vault: path = vault folder or .zip, or url = public https git repo; wikilinks/embeds become doc links, frontmatter → properties, #tags → tags, attachments imported; createTasks=true also turns "- [ ]" tasks into kanban tasks; re-running re-syncs changed notes only), ` +
      `import_status (jobId → progress/report; no jobId → recent import jobs), import_undo (jobId → reverses that whole import or mapping batch), ` +
      `import_collections (imported database/vault folders that can be mapped), import_map_preview (folderId + optional role → suggested role, field map and sample rows), ` +
      `import_map (folderId + role projects|tasks|clients + optional fieldMap JSON → writes kanban projects/tasks or CRM clients, relations preserved, deduped on re-run, undoable). ` +
      `Docs use markdown with [[Wiki Links]] to other docs by title.`,
    parameters: NotesToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const mode = getRoleMode("notes");
      const useDb = mode.mode === "database";

      const docType = readStringParam(params, "type");
      // Typed listing goes through the library (documents + ideas + reports + research).
      if ((action === "list" || action === "search") && docType) {
        try {
          return jsonResult(await runDocumentAction("library", params, agentId));
        } catch (e) {
          return jsonResult({ status: "error", error: String((e as Error)?.message ?? e) });
        }
      }
      if (action === "create" && docType) {
        try {
          if (docType === "idea") {
            const title =
              readStringParam(params, "name") ??
              readStringParam(params, "title") ??
              "Untitled idea";
            return jsonResult(await createIdeaFromTool(params, title, agentId));
          }
          validateDocType(docType);
        } catch (e) {
          return jsonResult({ status: "error", error: String((e as Error)?.message ?? e) });
        }
      }
      /** After a legacy note create: give its workspace document the requested type. */
      const typed = (noteId: string) => {
        if (!docType) return {};
        try {
          const node = applyTypeToNote(noteId, docType, readStringParam(params, "category"));
          return node ? { document: { id: node.id, type: node.type } } : {};
        } catch (e) {
          return { typeWarning: String((e as Error)?.message ?? e) };
        }
      };

      if ((DOCUMENT_ACTIONS as readonly string[]).includes(action)) {
        try {
          return jsonResult(await runDocumentAction(action, params, agentId));
        } catch (e) {
          return jsonResult({ status: "error", error: String((e as Error)?.message ?? e) });
        }
      }

      try {
        switch (action) {
          case "list":
          case "search": {
            const query = readStringParam(params, "query");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const projectId = readStringParam(params, "projectId");
            const listClientId = readStringParam(params, "clientId");
            const since = typeof params.since === "number" ? params.since : undefined;
            const limitRaw = params.limit;
            const limit = typeof limitRaw === "number" ? limitRaw : undefined;

            if (useDb) {
              let notes = listRowsForRole("notes").map(rowToNote);
              if (query) {
                const q = query.toLowerCase();
                notes = notes.filter(
                  (n) =>
                    n.name.toLowerCase().includes(q) ||
                    n.body.toLowerCase().includes(q) ||
                    (n.description ?? "").toLowerCase().includes(q),
                );
              }
              if (tags?.length) {
                notes = notes.filter((n) => tags.every((t) => (n.tags ?? []).includes(t)));
              }
              if (category) notes = notes.filter((n) => n.category === category);
              if (projectId) notes = notes.filter((n) => n.projectId === projectId);
              if (listClientId) notes = notes.filter((n) => n.clientId === listClientId);
              if (since != null) {
                notes = notes.filter((n) => new Date(n.updatedAt).getTime() > since);
              }
              if (limit) notes = notes.slice(0, limit);
              return jsonResult({ status: "ok", count: notes.length, notes, mode: "database" });
            }

            const items = getLegacyStore().list({
              query,
              tags,
              category,
              projectId,
              clientId: listClientId,
              limit,
            });
            const filtered =
              since != null
                ? items.filter((n) => {
                    const ts =
                      typeof n.updatedAt === "string"
                        ? new Date(n.updatedAt).getTime()
                        : Number(n.updatedAt);
                    return ts > since;
                  })
                : items;
            return jsonResult({
              status: "ok",
              count: filtered.length,
              notes: filtered.map((n) => ({
                id: n.id,
                name: n.name,
                description: n.description,
                tags: n.tags,
                author: n.author,
                category: n.category,
                pinned: n.pinned,
                projectId: n.projectId,
                clientId: n.clientId,
                reviewOn: n.reviewOn,
                preview: n.preview,
                bodyLength: n.bodyLength,
                updatedAt: n.updatedAt,
              })),
              mode: "legacy",
            });
          }

          case "get": {
            const id = readStringParam(params, "id", { required: true });
            const { linkedPeopleFields } = await import("../../network/links.js");
            if (useDb) {
              const row = getRowForRole("notes", id);
              if (!row) return jsonResult({ status: "error", error: `Note "${id}" not found` });
              return jsonResult({
                status: "ok",
                note: rowToNote(row),
                ...(await linkedPeopleFields("note", id)),
              });
            }
            const note = getLegacyStore().get(id);
            if (!note) return jsonResult({ status: "error", error: `Note "${id}" not found` });
            return jsonResult({ status: "ok", note, ...(await linkedPeopleFields("note", id)) });
          }

          case "create": {
            const name = readStringParam(params, "name", { required: true });
            const body = readStringParam(params, "body", { required: true });
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const pinned = params.pinned as boolean | undefined;
            const linkedTo = parseLinkedTo(readStringParam(params, "linkedTo"));
            const projectId = readStringParam(params, "projectId");
            const client = await resolveClientParam(params.clientId);
            if (client && "error" in client) return jsonResult({ status: "error", ...client });
            const review = resolveDateParam(params.reviewOn);
            if (review && "error" in review) return jsonResult({ status: "error", ...review });
            const clientId = client && "clientId" in client ? client.clientId : undefined;
            const reviewOn = review && "date" in review ? whenString(review) : undefined;
            // Support caller-provided id for idempotency
            const explicitId =
              readStringParam(params, "clientRequestId") || readStringParam(params, "id");

            if (useDb) {
              // Idempotency: if caller provided an id and the row already exists, return it.
              if (explicitId) {
                const existing = getRowForRole("notes", explicitId);
                if (existing) {
                  return jsonResult({
                    status: "ok",
                    message: `Note "${existing.title}" already exists (idempotent)`,
                    note: rowToNote(existing),
                  });
                }
              }
              const row = upsertRowForRole("notes", {
                id: explicitId || undefined,
                title: name,
                body,
                values: {
                  description,
                  tags,
                  category,
                  pinned,
                  projectId,
                  clientId,
                  reviewOn,
                } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
              });
              if (!row)
                return jsonResult({ status: "error", error: "upsertRowForRole returned null" });
              if (clientId) await syncItemClient("note", row.id, [], [clientId], agentId);
              broadcastNotesChanged({ op: "create", id: row.id, name: row.title });
              return jsonResult({
                status: "ok",
                message: `Note "${row.title}" created`,
                note: rowToNote(row),
                ...typed(row.id),
              });
            }

            const note = getLegacyStore().create({
              id: explicitId || undefined,
              name,
              body,
              description: description || undefined,
              tags,
              category: category || undefined,
              pinned,
              linkedTo,
              projectId: projectId || undefined,
              clientId,
              reviewOn,
              author: agentId,
            });
            if (clientId) await syncItemClient("note", note.id, [], [clientId], agentId);
            broadcastNotesChanged({ op: "create", id: note.id, name: note.name });
            return jsonResult({
              status: "ok",
              message: `Note "${note.name}" created`,
              note,
              ...typed(note.id),
            });
          }

          case "update": {
            const id = readStringParam(params, "id", { required: true });
            const name = readStringParam(params, "name");
            const body = readStringParam(params, "body");
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const pinned = params.pinned as boolean | undefined;
            const linkedTo = parseLinkedTo(readStringParam(params, "linkedTo"));
            const projectId = readStringParam(params, "projectId");
            const client = await resolveClientParam(params.clientId);
            if (client && "error" in client) return jsonResult({ status: "error", ...client });
            const review = resolveDateParam(params.reviewOn);
            if (review && "error" in review) return jsonResult({ status: "error", ...review });
            // undefined = unchanged, "" = clear.
            const clientId = client ? ("clientId" in client ? client.clientId : "") : undefined;
            const reviewOn = review ? ("date" in review ? whenString(review) : "") : undefined;

            if (useDb) {
              const existing = getRowForRole("notes", id);
              if (!existing)
                return jsonResult({ status: "error", error: `Note "${id}" not found` });
              const row = upsertRowForRole("notes", {
                id,
                title: name ?? existing.title,
                body: typeof body === "string" ? body : undefined,
                values: {
                  ...existing.values,
                  description: description ?? existing.values?.description,
                  tags: tags ?? existing.values?.tags,
                  category: category ?? existing.values?.category,
                  pinned: pinned ?? existing.values?.pinned,
                  projectId: projectId ?? existing.values?.projectId,
                  clientId: clientId ?? existing.values?.clientId,
                  reviewOn: reviewOn ?? existing.values?.reviewOn,
                } as unknown as Record<string, import("../../databases/types.js").PropertyValue>,
              });
              if (!row)
                return jsonResult({ status: "error", error: "upsertRowForRole returned null" });
              if (clientId !== undefined)
                await syncItemClient(
                  "note",
                  id,
                  [typeof existing.values?.clientId === "string" ? existing.values.clientId : null],
                  [clientId],
                  agentId,
                );
              broadcastNotesChanged({ op: "update", id: row.id, name: row.title });
              return jsonResult({
                status: "ok",
                message: `Note "${row.title}" updated`,
                note: rowToNote(row),
              });
            }

            const prevClientId = getLegacyStore().get(id)?.clientId;
            const note = getLegacyStore().update({
              id,
              clientId,
              reviewOn,
              name: name || undefined,
              body: body || undefined,
              description: description || undefined,
              tags,
              category: category || undefined,
              pinned,
              linkedTo,
              projectId: projectId || undefined,
            });
            if (!note) return jsonResult({ status: "error", error: `Note "${id}" not found` });
            if (clientId !== undefined)
              await syncItemClient("note", id, [prevClientId], [clientId], agentId);
            broadcastNotesChanged({ op: "update", id, name: note.name });
            return jsonResult({ status: "ok", message: `Note "${note.name}" updated`, note });
          }

          case "delete": {
            const id = readStringParam(params, "id", { required: true });
            if (useDb) {
              const ok = deleteRowForRole("notes", id);
              if (!ok) return jsonResult({ status: "error", error: `Note "${id}" not found` });
              broadcastNotesChanged({ op: "delete", id });
              return jsonResult({ status: "ok", message: `Note "${id}" deleted` });
            }
            const deleted = getLegacyStore().delete(id);
            if (!deleted) return jsonResult({ status: "error", error: `Note "${id}" not found` });
            broadcastNotesChanged({ op: "delete", id });
            return jsonResult({ status: "ok", message: `Note "${id}" deleted` });
          }

          case "verify": {
            const id = readStringParam(params, "id", { required: true });
            if (useDb) {
              const row = getRowForRole("notes", id);
              if (!row) return jsonResult({ status: "not_found", id, exists: false });
              const note = rowToNote(row);
              return jsonResult({ status: "ok", id, exists: true, note });
            }
            const note = getLegacyStore().get(id);
            if (!note) return jsonResult({ status: "not_found", id, exists: false });
            return jsonResult({ status: "ok", id, exists: true, note });
          }

          default:
            return jsonResult({ status: "error", error: `Unknown action: ${action}` });
        }
      } catch (e) {
        return jsonResult({ status: "error", error: String(e) });
      }
    },
  };
}
