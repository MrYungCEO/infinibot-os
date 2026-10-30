/**
 * `secure_lane` — the agent tool for the encrypted Secure Mode lane (kanban,
 * documents, knowledge graph, and Secure Files organisation: rename, move to
 * a collection, tags, project, notes). Only secure sessions are given this
 * tool (see pi-tools.ts), so a normal-lane agent can never read secure data.
 *
 * File operations return the state re-read from the vault after the write
 * (`changed` counts only fields that really differ), never an echo of the
 * request — a reply can only truthfully claim what is in that result.
 */

import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../agents/tools/common.js";
import { jsonResult } from "../agents/tools/common.js";
import { getOcrService } from "../ocr/runtime.js";
import { SecureFilesOps, SecureOrganizeError } from "../ocr/secure-files-ops.js";
import { broadcastSecureLaneChanged } from "./events.js";
import { getSecureModeRuntime } from "./runtime.js";

const ACTIONS = [
  "list_tasks",
  "create_task",
  "update_task",
  "delete_task",
  "create_project",
  "list_docs",
  "get_doc",
  "create_doc",
  "update_doc",
  "add_node",
  "link_nodes",
  "graph",
  "list_files",
  "list_collections",
  "create_collection",
  "rename_collection",
  "delete_collection",
  "rename_file",
  "move_files",
  "tag_files",
  "untag_files",
  "set_project",
  "update_file",
  "bulk_update",
] as const;

/** Secure Files writes (the truth guard treats these as file-organise evidence). */
export const SECURE_FILE_WRITE_ACTIONS = new Set([
  "create_collection",
  "rename_collection",
  "delete_collection",
  "rename_file",
  "move_files",
  "tag_files",
  "untag_files",
  "set_project",
  "update_file",
  "bulk_update",
]);

const SecureLaneSchema = Type.Object({
  action: Type.Union(ACTIONS.map((a) => Type.Literal(a))),
  id: Type.Optional(Type.String({ description: "task / doc id for update, get, delete" })),
  title: Type.Optional(Type.String()),
  name: Type.Optional(Type.String({ description: "project name (create_project)" })),
  description: Type.Optional(Type.String()),
  status: Type.Optional(
    Type.String({ description: "todo | in_progress | review | done | blocked" }),
  ),
  priority: Type.Optional(Type.String({ description: "low | medium | high | urgent" })),
  projectId: Type.Optional(Type.String()),
  content: Type.Optional(Type.String({ description: "document markdown" })),
  label: Type.Optional(Type.String({ description: "graph node label (add_node)" })),
  kind: Type.Optional(Type.String({ description: "graph node kind, e.g. note, person, decision" })),
  source: Type.Optional(Type.String({ description: "graph node id (link_nodes)" })),
  target: Type.Optional(Type.String({ description: "graph node id (link_nodes)" })),
  rel: Type.Optional(Type.String({ description: "relationship label (link_nodes)" })),
  file: Type.Optional(
    Type.String({
      description: "secure file id (s_…) or its exact current name (rename_file, update_file)",
    }),
  ),
  files: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "secure file ids or exact names (move_files, tag_files, untag_files, set_project, bulk_update)",
    }),
  ),
  collection: Type.Optional(
    Type.String({
      description:
        'collection id, name or "Parent / Child" path; "root" = Unfiled (move_files, list_files, rename/delete_collection)',
    }),
  ),
  createCollection: Type.Optional(
    Type.Boolean({
      description: "move_files / bulk_update: create the collection if it does not exist",
    }),
  ),
  parent: Type.Optional(
    Type.String({ description: "create_collection: parent collection id/name (omit = top level)" }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "tag_files / untag_files / update_file (update_file replaces all tags)",
    }),
  ),
  addTags: Type.Optional(Type.Array(Type.String())),
  removeTags: Type.Optional(Type.Array(Type.String())),
  project: Type.Optional(
    Type.String({ description: 'set_project: secure project id or name; "" or "none" clears' }),
  ),
  notes: Type.Optional(Type.String({ description: "update_file: private notes" })),
  query: Type.Optional(Type.String({ description: "list_files: filter by name/notes" })),
  tag: Type.Optional(Type.String({ description: "list_files: only files with this tag" })),
  limit: Type.Optional(Type.Number()),
});

function strList(v: unknown): string[] {
  if (Array.isArray(v))
    return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  if (typeof v === "string" && v.trim()) return [v];
  return [];
}

function fileOps(): SecureFilesOps {
  return new SecureFilesOps(getSecureModeRuntime().requireVault(), getOcrService());
}

/** Secure Files organise actions → a JSON result with the real post-write state. */
function runFileAction(action: string, p: Record<string, unknown>) {
  const ops = fileOps();
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const files = () => {
    const list = [
      ...strList(p.files),
      ...strList(p.file),
      ...(action === "rename_file" || action === "update_file" ? strList(p.id) : []),
    ];
    if (!list.length) throw new SecureOrganizeError("files (ids or exact names) are required");
    return list;
  };
  const wrote = (res: unknown) => {
    broadcastSecureLaneChanged("files");
    return jsonResult({ ok: true, ...(res as object) });
  };
  switch (action) {
    case "list_files":
      return jsonResult({
        files: ops.listFiles({
          collection: s("collection"),
          tag: s("tag"),
          query: s("query"),
          limit: typeof p.limit === "number" ? p.limit : undefined,
        }),
      });
    case "list_collections":
      return jsonResult(ops.collections());
    case "create_collection": {
      const parent = s("parent");
      const c = ops.org.createCollection({
        name: s("name") ?? s("title") ?? s("collection"),
        parentId: parent ? ops.resolveCollection(parent) : null,
      });
      return wrote({ collection: c, collections: ops.collections().collections });
    }
    case "rename_collection": {
      const id = ops.resolveCollection(s("collection") ?? s("id") ?? "");
      const c = ops.org.updateCollection({ id, name: s("name") });
      return wrote({ collection: c });
    }
    case "delete_collection": {
      const id = ops.resolveCollection(s("collection") ?? s("id") ?? "");
      const res = ops.org.deleteCollection(id);
      return wrote({ ...res, note: "files moved to Unfiled; no file was deleted" });
    }
    case "rename_file": {
      const name = s("name");
      if (!name?.trim()) throw new SecureOrganizeError("name (the new display name) is required");
      return wrote(ops.update(files().slice(0, 1), { name }));
    }
    case "move_files":
      return wrote(
        ops.update(files(), {
          collection: s("collection") ?? "root",
          createCollection: p.createCollection === true,
        }),
      );
    case "tag_files":
      return wrote(ops.update(files(), { addTags: strList(p.tags ?? p.addTags) }));
    case "untag_files":
      return wrote(ops.update(files(), { removeTags: strList(p.tags ?? p.removeTags) }));
    case "set_project": {
      const ref = (s("project") ?? s("projectId") ?? "").trim();
      let projectId: string | null = null;
      if (ref && !/^none$/i.test(ref)) {
        const projects = getSecureModeRuntime().requireLane().listKanban().projects;
        const hit =
          projects.find((x) => x.id === ref) ??
          projects.find((x) => x.name.trim().toLowerCase() === ref.toLowerCase());
        if (!hit)
          throw new SecureOrganizeError(`no secure project "${ref}" (create_project first)`);
        projectId = hit.id;
      }
      return wrote(ops.update(files(), { projectId }));
    }
    case "update_file": {
      const patch: Record<string, unknown> = {};
      if (p.name !== undefined) patch.name = s("name") ?? null;
      if (p.collection !== undefined) patch.collection = s("collection") ?? null;
      if (p.tags !== undefined) patch.tags = strList(p.tags);
      if (p.projectId !== undefined) patch.projectId = s("projectId") || null;
      if (p.notes !== undefined) patch.notes = s("notes") ?? null;
      if (!Object.keys(patch).length)
        throw new SecureOrganizeError(
          "nothing to update (name, collection, tags, projectId, notes)",
        );
      return wrote(
        ops.update(files().slice(0, 1), {
          ...patch,
          createCollection: p.createCollection === true,
        }),
      );
    }
    case "bulk_update": {
      const patch: Record<string, unknown> = { createCollection: p.createCollection === true };
      if (p.collection !== undefined) patch.collection = s("collection") ?? null;
      if (p.addTags !== undefined || p.tags !== undefined)
        patch.addTags = strList(p.addTags ?? p.tags);
      if (p.removeTags !== undefined) patch.removeTags = strList(p.removeTags);
      if (p.projectId !== undefined) patch.projectId = s("projectId") || null;
      if (Object.keys(patch).length === 1)
        throw new SecureOrganizeError(
          "nothing to update (collection, addTags, removeTags, projectId)",
        );
      return wrote(ops.update(files(), patch));
    }
    default:
      return null;
  }
}

export function createSecureLaneTool(): AnyAgentTool {
  return {
    label: "Secure lane",
    name: "secure_lane",
    description:
      "Read and write the encrypted Secure Mode lane: kanban tasks/projects, documents, knowledge-graph nodes/edges, " +
      "and Secure Files organisation — list_files, list_collections, create/rename/delete_collection, rename_file (sets the display name), " +
      "move_files (into a collection; createCollection: true makes it), tag_files/untag_files, set_project, update_file, bulk_update. " +
      "File actions return the real state after the write; only report what that result shows (ok:false = nothing changed). " +
      "Data here is encrypted at rest, never synced to Notion or any cloud, and invisible to the normal lane.",
    parameters: SecureLaneSchema,
    execute: async (_toolCallId, args) => {
      const p = (args ?? {}) as Record<string, unknown>;
      const lane = getSecureModeRuntime().requireLane();
      const id = typeof p.id === "string" ? p.id : "";
      if (
        typeof p.action === "string" &&
        (p.action === "list_files" ||
          p.action === "list_collections" ||
          SECURE_FILE_WRITE_ACTIONS.has(p.action))
      ) {
        try {
          return runFileAction(p.action, p)!;
        } catch (err) {
          return jsonResult({
            ok: false,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            changed: 0,
          });
        }
      }
      switch (p.action) {
        case "list_tasks":
          return jsonResult(lane.listKanban());
        case "create_task": {
          const task = lane.createTask(p);
          broadcastSecureLaneChanged("kanban");
          return jsonResult({ ok: true, task });
        }
        case "update_task": {
          const { action: _a, id: _i, ...patch } = p;
          const task = lane.updateTask(id, patch);
          broadcastSecureLaneChanged("kanban");
          return jsonResult({ ok: true, task });
        }
        case "delete_task": {
          const ok = lane.deleteTask(id);
          broadcastSecureLaneChanged("kanban");
          return jsonResult({ ok });
        }
        case "create_project": {
          const project = lane.createProject({
            name: p.name ?? p.title,
            description: p.description,
          });
          broadcastSecureLaneChanged("kanban");
          return jsonResult({ ok: true, project });
        }
        case "list_docs":
          return jsonResult({ docs: lane.listDocs() });
        case "get_doc":
          return jsonResult(lane.getDoc(id) ?? { error: `no secure document ${id}` });
        case "create_doc": {
          const doc = lane.createDoc(p);
          broadcastSecureLaneChanged("docs");
          return jsonResult({ ok: true, id: doc.id, title: doc.title });
        }
        case "update_doc": {
          const doc = lane.updateDoc(id, p);
          broadcastSecureLaneChanged("docs");
          return jsonResult({ ok: true, id: doc.id, title: doc.title });
        }
        case "add_node": {
          const node = lane.createNode(p);
          broadcastSecureLaneChanged("graph");
          return jsonResult({ ok: true, node });
        }
        case "link_nodes": {
          const edge = lane.link(p);
          broadcastSecureLaneChanged("graph");
          return jsonResult({ ok: true, edge });
        }
        case "graph": {
          const snap = lane.snapshot();
          return jsonResult({
            nodes: snap.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
            edges: snap.edges,
          });
        }
        default:
          return jsonResult({
            error: `unknown action ${String(p.action)}; use one of ${ACTIONS.join(", ")}`,
          });
      }
    },
  };
}
