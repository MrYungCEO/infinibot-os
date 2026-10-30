/**
 * Research agent tool — lets agents list, read, create, update, and delete
 * markdown-based research documents.
 */

import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { ResearchStore } from "../../research/store.js";

const RESEARCH_ACTIONS = [
  "list",
  "get",
  "create",
  "update",
  "delete",
  "search",
] as const;

const ResearchToolSchema = Type.Object({
  action: stringEnum(RESEARCH_ACTIONS),
  /** Research ID (for get/update/delete). */
  id: Type.Optional(Type.String()),
  /** Research name (for create). */
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
  /** Status: draft, active, review, archived (for create/update/search). */
  status: Type.Optional(Type.String()),
  /** Topic (for create/update/search). */
  topic: Type.Optional(Type.String()),
  /** Comma-separated source URLs (for create/update). */
  sources: Type.Optional(Type.String()),
  /** Max results to return. */
  limit: Type.Optional(Type.Number()),
});

function getStore(): ResearchStore {
  const stateDir = process.env.INFINIBOT_STATE_DIR ?? "state";
  return new ResearchStore(stateDir);
}

function parseTags(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseSources(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseStatus(raw?: string): "draft" | "active" | "review" | "archived" | undefined {
  if (!raw) return undefined;
  const valid = ["draft", "active", "review", "archived"];
  return valid.includes(raw) ? (raw as "draft" | "active" | "review" | "archived") : undefined;
}

export function createResearchTool(options?: { agentId?: string }): AnyAgentTool {
  const agentId = options?.agentId || "main";

  return {
    label: "Research",
    name: "research",
    description:
      `Manage markdown research documents. Actions: ` +
      `list (list all research), get (read research by id), ` +
      `create (create new research with name + body), ` +
      `update (update research fields by id), ` +
      `delete (remove research by id), ` +
      `search (find research by query/tags/topic/status). ` +
      `Research documents are for deep dives, study materials, papers, and reference documents.`,
    parameters: ResearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          case "list": {
            const query = readStringParam(params, "query");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const status = parseStatus(readStringParam(params, "status"));
            const topic = readStringParam(params, "topic");
            const limitRaw = params.limit;
            const limit = typeof limitRaw === "number" ? limitRaw : undefined;
            const items = getStore().list({ query, tags, category, status, topic, limit });
            return jsonResult({
              status: "ok",
              count: items.length,
              research: items.map((r) => ({
                id: r.id,
                name: r.name,
                description: r.description,
                tags: r.tags,
                author: r.author,
                category: r.category,
                researchStatus: r.status,
                topic: r.topic,
                sources: r.sources,
                preview: r.preview,
                bodyLength: r.bodyLength,
                updatedAt: r.updatedAt,
              })),
            });
          }

          case "get": {
            const id = readStringParam(params, "id", { required: true });
            const doc = getStore().get(id);
            if (!doc) return jsonResult({ status: "error", error: `Research "${id}" not found` });
            return jsonResult({ status: "ok", research: doc });
          }

          case "create": {
            const name = readStringParam(params, "name", { required: true });
            const body = readStringParam(params, "body", { required: true });
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const status = parseStatus(readStringParam(params, "status"));
            const topic = readStringParam(params, "topic");
            const sources = parseSources(readStringParam(params, "sources"));
            const id = readStringParam(params, "id");
            const doc = getStore().create({
              name,
              body,
              description: description || undefined,
              tags,
              category: category || undefined,
              status: status || "draft",
              topic: topic || undefined,
              sources,
              author: agentId,
              id: id || undefined,
            });
            return jsonResult({ status: "ok", message: `Research "${doc.name}" created`, research: doc });
          }

          case "update": {
            const id = readStringParam(params, "id", { required: true });
            const name = readStringParam(params, "name");
            const body = readStringParam(params, "body");
            const description = readStringParam(params, "description");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const status = parseStatus(readStringParam(params, "status"));
            const topic = readStringParam(params, "topic");
            const sources = parseSources(readStringParam(params, "sources"));
            const doc = getStore().update({
              id,
              name: name || undefined,
              body: body || undefined,
              description: description || undefined,
              tags,
              category: category || undefined,
              status,
              topic: topic || undefined,
              sources,
            });
            if (!doc) return jsonResult({ status: "error", error: `Research "${id}" not found` });
            return jsonResult({ status: "ok", message: `Research "${doc.name}" updated`, research: doc });
          }

          case "delete": {
            const id = readStringParam(params, "id", { required: true });
            const deleted = getStore().delete(id);
            if (!deleted) return jsonResult({ status: "error", error: `Research "${id}" not found` });
            return jsonResult({ status: "ok", message: `Research "${id}" deleted` });
          }

          case "search": {
            const query = readStringParam(params, "query");
            const tags = parseTags(readStringParam(params, "tags"));
            const category = readStringParam(params, "category");
            const status = parseStatus(readStringParam(params, "status"));
            const topic = readStringParam(params, "topic");
            const limitRaw = params.limit;
            const limit = typeof limitRaw === "number" ? limitRaw : undefined;
            const items = getStore().list({ query, tags, category, status, topic, limit });
            return jsonResult({
              status: "ok",
              count: items.length,
              research: items.map((r) => ({
                id: r.id,
                name: r.name,
                description: r.description,
                tags: r.tags,
                category: r.category,
                researchStatus: r.status,
                topic: r.topic,
                preview: r.preview,
                updatedAt: r.updatedAt,
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
