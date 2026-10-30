/**
 * `ideas` agent tool — capture and work with the owner's Ideas (src/ideas):
 * the same store the web Documents › Ideas tab and the phone's InfiniBot face
 * (voice quick capture) use. Promotion goes through the existing board / notes
 * RPCs, so a promoted idea becomes a real task, project or Documents page.
 */

import { Type } from "@sinclair/typebox";

import {
  resolveClientParam,
  resolveDateParam,
  syncItemClient,
  whenString,
} from "../../ideas/agent-params.js";
import { createIdea, linkIdea, promoteIdea } from "../../ideas/service.js";
import { broadcastIdeasChanged } from "../../ideas/events.js";
import { getIdeaStore, isIdeaStatus } from "../../ideas/store.js";
import { IDEA_PROMOTE_TARGETS, IDEA_STATUSES, type IdeaPromoteTarget } from "../../ideas/types.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const ACTIONS = ["capture", "list", "get", "update", "promote", "link", "delete"] as const;

const IdeasToolSchema = Type.Object({
  action: stringEnum(ACTIONS),
  /** Idea id (get / update / promote / link / delete). */
  id: Type.Optional(Type.String()),
  /** capture / update: short title. */
  title: Type.Optional(Type.String()),
  /** capture / update: the idea in full (markdown). */
  body: Type.Optional(Type.String()),
  /** capture / update / list: comma-separated tags (list: one tag to filter by). */
  tags: Type.Optional(Type.String()),
  /** list / update: new | exploring | parked | promoted. */
  status: Type.Optional(Type.String()),
  /** list: search title, body and tags. */
  query: Type.Optional(Type.String()),
  /** capture / promote: board project id the idea is about (task promotions land in it). */
  projectId: Type.Optional(Type.String()),
  /**
   * capture / update / list: CRM client the idea is for — a client id or an exact /
   * unambiguous client name ("" or "none" clears on update).
   */
  clientId: Type.Optional(Type.String()),
  /**
   * capture / update: date to revisit the idea — "YYYY-MM-DD", "YYYY-MM-DDTHH:mm",
   * or words in the owner's timezone ("next Friday", "in two weeks at 3"). "" clears.
   */
  reviewOn: Type.Optional(Type.String()),
  /** promote: task | project | document. */
  to: Type.Optional(Type.String()),
  /** link: project | task | doc, plus targetId. */
  linkKind: Type.Optional(Type.String()),
  targetId: Type.Optional(Type.String()),
  /** link: true removes the link. */
  unlink: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number()),
});

function tagList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function createIdeasTool(options?: { agentId?: string }): AnyAgentTool {
  const agentId = options?.agentId || "main";
  return {
    name: "ideas",
    label: "Ideas",
    description:
      "The owner's Ideas — things worth keeping that aren't work yet (shown in Documents › Ideas on the web and the phone app). " +
      'Actions: "capture" (title + body, optional tags/projectId/clientId/reviewOn) saves a new idea; "list" (optional query, status, tags = one tag, clientId, limit); ' +
      '"get" (id); "update" (id + title/body/tags/status/clientId/reviewOn); "promote" (id + to = task | project | document, optional projectId) turns it into a ' +
      'board task, a board project or a Documents page and marks it promoted; "link" (id + linkKind = project | task | doc + targetId, unlink=true to remove); ' +
      `"delete" (id). Statuses: ${IDEA_STATUSES.join(", ")}. Capture an idea when the user says "idea:", "what if…", "remember this idea"; ` +
      "promote only when they ask to act on it. clientId (CRM client id or exact name) makes the idea show on that client's page; " +
      'reviewOn ("YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or words like "next Friday") sets when to revisit it.',
    parameters: IdeasToolSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const action = readStringParam(args, "action", { required: true });
      const id = readStringParam(args, "id") ?? undefined;
      try {
        const store = getIdeaStore();
        switch (action) {
          case "capture": {
            const title = readStringParam(args, "title");
            if (!title) return jsonResult({ error: "title is required" });
            const projectId = readStringParam(args, "projectId") ?? undefined;
            const client = await resolveClientParam(args.clientId);
            if (client && "error" in client) return jsonResult(client);
            const review = resolveDateParam(args.reviewOn);
            if (review && "error" in review) return jsonResult(review);
            const res = await createIdea({
              title,
              body: readStringParam(args, "body") ?? "",
              tags: tagList(readStringParam(args, "tags") ?? undefined),
              source: "agent",
              projectIds: projectId ? [projectId] : [],
              clientIds: client && "clientId" in client ? [client.clientId] : [],
              ...(review && "date" in review ? { reviewOn: whenString(review) } : {}),
              createdBy: agentId,
            });
            return jsonResult({ captured: true, idea: res.idea });
          }
          case "list": {
            const status = readStringParam(args, "status") ?? undefined;
            const ideas = store.list({
              query: readStringParam(args, "query") ?? undefined,
              status: status && isIdeaStatus(status) ? status : undefined,
              tag: readStringParam(args, "tags") ?? undefined,
              clientId: readStringParam(args, "clientId") ?? undefined,
              limit: typeof args.limit === "number" ? args.limit : 50,
            });
            return jsonResult({ count: ideas.length, counts: store.counts(), ideas });
          }
          case "get": {
            if (!id) return jsonResult({ error: "id is required" });
            const idea = store.get(id);
            return jsonResult(idea ? { idea } : { error: `idea ${id} not found` });
          }
          case "update": {
            if (!id) return jsonResult({ error: "id is required" });
            const rawStatus = readStringParam(args, "status") ?? undefined;
            const status = rawStatus && isIdeaStatus(rawStatus) ? rawStatus : undefined;
            if (rawStatus && !status)
              return jsonResult({ error: `status must be one of ${IDEA_STATUSES.join(", ")}` });
            const client = await resolveClientParam(args.clientId);
            if (client && "error" in client) return jsonResult(client);
            const review = resolveDateParam(args.reviewOn);
            if (review && "error" in review) return jsonResult(review);
            const before = store.get(id)?.clientIds ?? [];
            const idea = store.update(id, {
              ...(client ? { clientIds: "clientId" in client ? [client.clientId] : [] } : {}),
              ...(review ? { reviewOn: "date" in review ? whenString(review) : null } : {}),
              ...(readStringParam(args, "title") ? { title: readStringParam(args, "title")! } : {}),
              ...(typeof args.body === "string" ? { body: args.body } : {}),
              ...(typeof args.tags === "string" ? { tags: tagList(args.tags) } : {}),
              ...(status ? { status } : {}),
            });
            if (!idea) return jsonResult({ error: `idea ${id} not found` });
            if (client) await syncItemClient("idea", id, before, idea.clientIds ?? [], agentId);
            broadcastIdeasChanged({ op: "update", id, title: idea.title });
            return jsonResult({ updated: true, idea });
          }
          case "promote": {
            if (!id) return jsonResult({ error: "id is required" });
            const to = readStringParam(args, "to") as IdeaPromoteTarget | undefined;
            if (!to || !(IDEA_PROMOTE_TARGETS as readonly string[]).includes(to)) {
              return jsonResult({ error: `to must be one of ${IDEA_PROMOTE_TARGETS.join(", ")}` });
            }
            const res = await promoteIdea(id, to, {
              projectId: readStringParam(args, "projectId") ?? undefined,
              createdBy: agentId,
            });
            return jsonResult({
              promoted: true,
              idea: res.idea,
              target: { kind: res.target.kind, id: res.target.id, title: res.target.title },
            });
          }
          case "link": {
            const kind = readStringParam(args, "linkKind");
            const targetId = readStringParam(args, "targetId");
            if (!id || !targetId) return jsonResult({ error: "id and targetId are required" });
            if (kind !== "project" && kind !== "task" && kind !== "doc")
              return jsonResult({ error: "linkKind must be project | task | doc" });
            const idea = await linkIdea(id, kind, targetId, { unlink: args.unlink === true });
            return jsonResult({ linked: args.unlink !== true, idea });
          }
          case "delete": {
            if (!id) return jsonResult({ error: "id is required" });
            const ok = store.delete(id);
            if (ok) broadcastIdeasChanged({ op: "delete", id });
            return jsonResult(ok ? { deleted: true, id } : { error: `idea ${id} not found` });
          }
          default:
            return jsonResult({ error: `unknown action ${action}` });
        }
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
