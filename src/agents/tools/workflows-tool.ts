/**
 * Workflows agent tool — lets agents list, read, create, update, and delete
 * markdown-based instruction workflows.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { WorkflowStore } from "../../workflows/store.js";

const WORKFLOW_ACTIONS = ["list", "get", "create", "update", "delete", "search"] as const;

const WorkflowsToolSchema = Type.Object({
  action: stringEnum(WORKFLOW_ACTIONS),
  /** Workflow ID (for get/update/delete). */
  id: Type.Optional(Type.String()),
  /** Workflow name (for create). */
  name: Type.Optional(Type.String()),
  /** Short description (for create/update). */
  description: Type.Optional(Type.String()),
  /** Markdown body content (for create/update). */
  body: Type.Optional(Type.String()),
  /** Comma-separated tags (for create/update/search). */
  tags: Type.Optional(Type.String()),
  /** Search query string (for search/list). */
  query: Type.Optional(Type.String()),
  /** Max results to return. */
  limit: Type.Optional(Type.Number()),
});

function getStore(): WorkflowStore {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  return new WorkflowStore(stateDir);
}

function parseTags(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function createWorkflowsTool(options?: { agentId?: string }): AnyAgentTool {
  const agentId = options?.agentId || "main";

  return {
    label: "Workflows",
    name: "workflows",
    description:
      `Manage markdown instruction workflows. Actions: ` +
      `list (list all workflows), get (read a workflow by id), ` +
      `create (create new workflow with name + body), ` +
      `update (update workflow fields by id), ` +
      `delete (remove a workflow by id), ` +
      `search (find workflows by query/tags). ` +
      `Workflows are reusable instruction documents that define step-by-step processes. ` +
      `Workflows are saved locally. Notion sync is optional: only sync to Notion if the user has connected it, and never treat a missing Notion connection as an error.`,
    parameters: WorkflowsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          case "list": {
            const query = readStringParam(params, "query");
            const tags = parseTags(readStringParam(params, "tags"));
            const limitRaw = params.limit;
            const limit = typeof limitRaw === "number" ? limitRaw : undefined;
            const items = getStore().list({ query, tags, limit });
            return jsonResult({
              status: "ok",
              count: items.length,
              workflows: items.map((w) => ({
                id: w.id,
                name: w.name,
                description: w.description,
                tags: w.tags,
                author: w.author,
                preview: w.preview,
                bodyLength: w.bodyLength,
                updatedAt: w.updatedAt,
              })),
            });
          }

          case "get": {
            const id = readStringParam(params, "id", { required: true });
            const wf = getStore().get(id);
            if (!wf) return jsonResult({ status: "error", error: `Workflow "${id}" not found` });
            return jsonResult({ status: "ok", workflow: wf });
          }

          case "create": {
            const name = readStringParam(params, "name", { required: true });
            const body = readStringParam(params, "body", { required: true });
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const id = readStringParam(params, "id");
            const wf = getStore().create({
              name,
              body,
              description: description || undefined,
              tags,
              author: agentId,
              id: id || undefined,
            });
            return jsonResult({
              status: "ok",
              message: `Workflow "${wf.name}" created`,
              workflow: wf,
            });
          }

          case "update": {
            const id = readStringParam(params, "id", { required: true });
            const name = readStringParam(params, "name");
            const body = readStringParam(params, "body");
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const wf = getStore().update({
              id,
              name: name || undefined,
              body: body || undefined,
              description: description || undefined,
              tags,
            });
            if (!wf) return jsonResult({ status: "error", error: `Workflow "${id}" not found` });
            return jsonResult({
              status: "ok",
              message: `Workflow "${wf.name}" updated`,
              workflow: wf,
            });
          }

          case "delete": {
            const id = readStringParam(params, "id", { required: true });
            const deleted = getStore().delete(id);
            if (!deleted)
              return jsonResult({ status: "error", error: `Workflow "${id}" not found` });
            return jsonResult({ status: "ok", message: `Workflow "${id}" deleted` });
          }

          case "search": {
            const query = readStringParam(params, "query");
            const tags = parseTags(readStringParam(params, "tags"));
            const limitRaw = params.limit;
            const limit = typeof limitRaw === "number" ? limitRaw : undefined;
            const items = getStore().list({ query, tags, limit });
            return jsonResult({
              status: "ok",
              count: items.length,
              workflows: items.map((w) => ({
                id: w.id,
                name: w.name,
                description: w.description,
                tags: w.tags,
                preview: w.preview,
                updatedAt: w.updatedAt,
              })),
            });
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
