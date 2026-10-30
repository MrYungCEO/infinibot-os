/**
 * Directory Registry Gateway Handlers
 *
 * Maps local directories to projects, Notion databases, agents.
 * Provides context injection for agent system prompts.
 */

import { GatewayRequestHandlers } from "./types.js";
import { getDirectoryStore } from "../../directories/store.js";
import { resolveStateDir } from "../../config/paths.js";

function store() {
  // Resolve via the shared state-dir helper so directories.db sits next to
  // the rest of the gateway state (~/.infinibot, or ~/.infinibot-<profile>
  // when --dev/--profile is in effect). The previous fallback resolved
  // "state" against process.cwd() and that produced different DB files
  // depending on where the gateway happened to be launched from — so saves
  // looked like they "didn't persist" between runs.
  return getDirectoryStore(resolveStateDir());
}

export const directoryHandlers: GatewayRequestHandlers = {
  "directories.list": async ({ params, respond }) => {
    try {
      const entries = store().list({
        active: params.active as boolean | undefined,
        agentId: params.agentId as string | undefined,
        projectId: params.projectId as string | undefined,
        peerId: params.peerId as string | undefined,
      });
      respond(true, entries);
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_LIST_ERROR", message: err.message });
    }
  },

  "directories.get": async ({ params, respond }) => {
    const id = params.id as string;
    if (!id) return respond(false, undefined, { code: "MISSING_ID", message: "id required" });
    try {
      const entry = store().get(id);
      if (!entry)
        return respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Directory ${id} not found`,
        });
      respond(true, entry);
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_GET_ERROR", message: err.message });
    }
  },

  "directories.resolve": async ({ params, respond }) => {
    const path = params.path as string;
    if (!path) return respond(false, undefined, { code: "MISSING_PATH", message: "path required" });
    try {
      const entry = store().resolve(path, params.peerId as string | undefined);
      respond(true, entry ?? null);
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_RESOLVE_ERROR", message: err.message });
    }
  },

  "directories.create": async ({ params, respond }) => {
    const p = params.path as string;
    const name = params.name as string;
    if (!p || !name)
      return respond(false, undefined, {
        code: "MISSING_FIELDS",
        message: "path and name required",
      });
    try {
      const entry = store().create({
        path: p,
        name,
        peerId: params.peerId as string | undefined,
        peerLabel: params.peerLabel as string | undefined,
        description: params.description as string | undefined,
        notionDatabaseId: params.notionDatabaseId as string | undefined,
        notionPageId: params.notionPageId as string | undefined,
        projectId: params.projectId as string | undefined,
        agentId: params.agentId as string | undefined,
        tags: params.tags as string[] | undefined,
        icon: params.icon as string | undefined,
        gitRemote: params.gitRemote as string | undefined,
        active: params.active !== false,
      });
      // Auto-register into /apps. Linked-business inference is left
      // to a future hook; for now the entry surfaces under the
      // directory's id so the operator can attach a business via
      // the /apps edit dialog.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        const { resolveStateDir } = await import("../../config/paths.js");
        autoRegister(resolveStateDir(), {
          sourceKind: "directory",
          sourceId: entry.id,
          name: entry.name,
          description: entry.description ?? "",
          type: "directory",
          directoryId: entry.id,
          peerId: entry.peerId ?? null,
          // Fallback URL; autoRegister upgrades this to an infinibot://peer/…
          // URL when a peerId is present.
          url: entry.path ? `file://${entry.path}` : null,
          meta: { path: entry.path, gitRemote: entry.gitRemote ?? null },
        });
      } catch {
        /* swallow */
      }
      respond(true, entry);
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_CREATE_ERROR", message: err.message });
    }
  },

  "directories.update": async ({ params, respond }) => {
    const id = params.id as string;
    if (!id) return respond(false, undefined, { code: "MISSING_ID", message: "id required" });
    try {
      const patch: Record<string, any> = {};
      for (const key of [
        "path",
        "name",
        "peerId",
        "peerLabel",
        "description",
        "notionDatabaseId",
        "notionPageId",
        "projectId",
        "agentId",
        "tags",
        "icon",
        "gitRemote",
        "active",
      ]) {
        if (key in params) patch[key] = params[key];
      }
      const entry = store().update(id, patch);
      if (!entry)
        return respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Directory ${id} not found`,
        });
      respond(true, entry);
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_UPDATE_ERROR", message: err.message });
    }
  },

  "directories.delete": async ({ params, respond }) => {
    const id = params.id as string;
    if (!id) return respond(false, undefined, { code: "MISSING_ID", message: "id required" });
    try {
      const ok = store().delete(id);
      if (!ok)
        return respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Directory ${id} not found`,
        });
      respond(true, { deleted: true });
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_DELETE_ERROR", message: err.message });
    }
  },

  "directories.context": async ({ params, respond }) => {
    try {
      if (params.agentId) {
        const ctx = store().getAgentContext(params.agentId as string);
        return respond(true, { context: ctx });
      }
      if (params.path) {
        const ctx = store().getDirectoryContext(params.path as string);
        return respond(true, { context: ctx });
      }
      respond(false, undefined, { code: "MISSING_PARAMS", message: "agentId or path required" });
    } catch (err: any) {
      respond(false, undefined, { code: "DIRECTORY_CONTEXT_ERROR", message: err.message });
    }
  },
};
