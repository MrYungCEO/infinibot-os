/**
 * Gateway RPCs for the Notion ↔ local conflict queue.
 *
 * Methods:
 *   - notion.conflicts.list   — pending conflicts for the queue UI
 *   - notion.conflicts.get    — one conflict's full per-field diff
 *   - notion.conflicts.count  — badge counter
 *   - notion.conflicts.resolve — operator picks "local" / "remote" / per-field merge
 *
 * Resolution semantics: this module owns the audit-trail bookkeeping
 * (mark resolved, record which side won) AND performs the actual write
 * for whichever side lost. For "local" the queued local row is pushed
 * back to Notion via the existing kanban→Notion push path; for "remote"
 * the queued Notion values overwrite the local row. For "merge" the
 * caller passes per-field selections.
 *
 * The resolve path lives here rather than in notion-conflicts.ts so the
 * conflict-state module stays pure I/O — no kanban store or Notion
 * client dependencies.
 */
import {
  getConflict,
  listConflicts,
  markResolved,
  pendingCount,
  type ConflictField,
} from "../../databases/notion-conflicts.js";
import { getBinding, getNotionApiKeyOrNull } from "../../databases/notion-config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("notion-conflicts-rpc");

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch(apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${NOTION_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Notion ${res.status}: ${(body as { message?: string }).message ?? JSON.stringify(body)}`,
    );
  }
  return body;
}

/**
 * Build the Notion property-value payload for one canonical field. Mirrors
 * the type-specific encoding used by `notion-import.ts:buildNotionPropertyValue`
 * but only handles the types our conflict diff tracks (title, rich_text,
 * status, select, date, checkbox).
 */
function notionPayloadFor(field: ConflictField, value: unknown): Record<string, unknown> | null {
  const propName = field.notionProperty;
  // The field "type" is the canonical Notion property type — both sides
  // record it identically when the conflict is enqueued, so either side
  // works as the source.
  const type = field.local.type ?? field.remote.type;
  switch (type) {
    case "title":
      return { [propName]: { title: [{ text: { content: String(value ?? "").slice(0, 2000) } }] } };
    case "rich_text":
      return {
        [propName]: { rich_text: [{ text: { content: String(value ?? "").slice(0, 2000) } }] },
      };
    case "status":
      return value
        ? { [propName]: { status: { name: String(value) } } }
        : { [propName]: { status: null } };
    case "select":
      return value
        ? { [propName]: { select: { name: String(value) } } }
        : { [propName]: { select: null } };
    case "date":
      return value
        ? { [propName]: { date: { start: String(value) } } }
        : { [propName]: { date: null } };
    case "checkbox":
      return { [propName]: { checkbox: Boolean(value) } };
    default:
      return null;
  }
}

/**
 * Push the chosen field values to Notion. Bundles all fields into one
 * PATCH call so a multi-field merge is atomic from Notion's perspective.
 */
async function writeRemoteFields(
  pageId: string,
  fields: Array<{ field: ConflictField; value: unknown }>,
): Promise<void> {
  const apiKey = getNotionApiKeyOrNull();
  if (!apiKey) throw new Error("Notion not configured");
  const properties: Record<string, unknown> = {};
  for (const { field, value } of fields) {
    const payload = notionPayloadFor(field, value);
    if (payload) Object.assign(properties, payload);
  }
  if (Object.keys(properties).length === 0) return;
  await notionFetch(apiKey, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/**
 * Apply chosen field values to the local kanban row. Maps the canonical
 * field name back onto the kanban store's column for projects/tasks.
 */
async function writeLocalFields(
  notionPageId: string,
  role: string,
  fields: Array<{ field: ConflictField; value: unknown }>,
): Promise<void> {
  const { getKanbanStore } = await import("../../tasks/store.js");
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  const store = getKanbanStore(stateDir);
  const table: "projects" | "tasks" | null =
    role === "projects" ? "projects" : role === "tasks" ? "tasks" : null;
  if (!table) return;
  const existing = store.getByNotionPageId ? store.getByNotionPageId(table, notionPageId) : null;
  if (!existing) return;

  const patch: Record<string, unknown> = {};
  for (const { field, value } of fields) {
    const localKey = canonicalToLocalKey(role, field.field);
    if (!localKey) continue;
    patch[localKey] = value ?? null;
  }
  if (Object.keys(patch).length === 0) return;
  if (table === "projects") {
    await store.updateProject(existing.id, patch as never);
  } else {
    await store.updateTask(existing.id, patch as never);
  }
}

function canonicalToLocalKey(role: string, canonical: string): string | null {
  if (role === "projects") {
    if (canonical === "Project") return "name";
    if (canonical === "Description") return "description";
    if (canonical === "Status") return "status";
    if (canonical === "Priority") return "priority";
    if (canonical === "Due Date") return "dueDate";
    return null;
  }
  if (role === "tasks") {
    if (canonical === "Task Name") return "title";
    if (canonical === "Description") return "description";
    if (canonical === "Status Update") return "status";
    if (canonical === "Priority Level") return "priority";
    if (canonical === "Due Date") return "dueDate";
    if (canonical === "Done") return "done";
    return null;
  }
  return null;
}

export const notionConflictsHandlers: GatewayRequestHandlers = {
  /** Pending conflicts for the queue UI. */
  "notion.conflicts.list": async ({ params, respond }) => {
    try {
      const status = typeof params?.status === "string" ? (params.status as never) : "pending";
      const dbId = typeof params?.notionDbId === "string" ? params.notionDbId : undefined;
      const limit = typeof params?.limit === "number" ? params.limit : 100;
      const conflicts = listConflicts({ status, notionDbId: dbId, limit });
      respond(true, { conflicts });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Single conflict — full field diff for the resolve UI. */
  "notion.conflicts.get": async ({ params, respond }) => {
    const id = typeof params?.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
      return;
    }
    const c = getConflict(id);
    if (!c) {
      respond(false, undefined, { code: "NOT_FOUND", message: "conflict not found" });
      return;
    }
    respond(true, { conflict: c });
  },

  /** Cheap badge counter. */
  "notion.conflicts.count": async ({ respond }) => {
    try {
      respond(true, { count: pendingCount() });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Resolve a conflict.
   *
   * params:
   *   id: string (required)
   *   resolution: "local" | "remote" | "merge" (required)
   *   selections?: { [field]: "local" | "remote" }  (only for "merge")
   */
  "notion.conflicts.resolve": async ({ params, respond }) => {
    const id = typeof params?.id === "string" ? params.id : "";
    const resolution = typeof params?.resolution === "string" ? params.resolution : "";
    if (!id || !["local", "remote", "merge"].includes(resolution)) {
      respond(false, undefined, {
        code: "BAD_REQUEST",
        message: "id and resolution (local|remote|merge) required",
      });
      return;
    }
    const conflict = getConflict(id);
    if (!conflict) {
      respond(false, undefined, { code: "NOT_FOUND", message: "conflict not found" });
      return;
    }
    if (conflict.status !== "pending") {
      respond(false, undefined, {
        code: "ALREADY_RESOLVED",
        message: `conflict already ${conflict.status}`,
      });
      return;
    }

    try {
      const remoteWrites: Array<{ field: ConflictField; value: unknown }> = [];
      const localWrites: Array<{ field: ConflictField; value: unknown }> = [];

      if (resolution === "local") {
        // Local wins: push local values to Notion, leave local untouched.
        for (const f of conflict.fields) {
          remoteWrites.push({ field: f, value: f.local.value });
        }
      } else if (resolution === "remote") {
        // Remote wins: copy Notion values into local, leave Notion untouched.
        for (const f of conflict.fields) {
          localWrites.push({ field: f, value: f.remote.value });
        }
      } else {
        // Merge: per-field selection. Default to remote for unspecified fields
        // so a half-completed merge defaults safely to "what Notion sees".
        const selections =
          (params?.selections as Record<string, "local" | "remote"> | undefined) ?? {};
        for (const f of conflict.fields) {
          const choice = selections[f.field] === "local" ? "local" : "remote";
          if (choice === "local") {
            remoteWrites.push({ field: f, value: f.local.value });
          } else {
            localWrites.push({ field: f, value: f.remote.value });
          }
        }
      }

      // Verify the binding still exists — if the user removed the DB
      // between detection and resolution, fail loudly so the operator
      // doesn't think their resolution stuck.
      const binding = getBinding(conflict.notionDbId);
      if (!binding) {
        respond(false, undefined, {
          code: "NO_BINDING",
          message: "binding for this DB is gone — re-import to resolve.",
        });
        return;
      }

      if (remoteWrites.length > 0) {
        await writeRemoteFields(conflict.notionPageId, remoteWrites);
      }
      if (localWrites.length > 0) {
        await writeLocalFields(conflict.notionPageId, conflict.role, localWrites);
      }

      const status =
        resolution === "local"
          ? "resolved-local"
          : resolution === "remote"
            ? "resolved-remote"
            : "resolved-merged";
      const updated = markResolved(id, status);
      log.info("conflict resolved", { id, resolution, fields: conflict.fields.length });
      respond(true, { conflict: updated });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
