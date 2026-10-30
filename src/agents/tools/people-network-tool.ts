/**
 * Agent tool — People Network ("My Network").
 *
 * Gives agents the owner's relationship graph as decision context: who they
 * know, how strongly, what each connection is worth, which opportunities ride
 * on which people, and the warm-intro path to anyone. Reads and writes go
 * through the same store/service as the gateway `network.*` RPCs (src/network),
 * so status changes made here are tracked in the same history and audit log.
 *
 * `people_network` is a Business & Agency plugin tool: core keeps the name as
 * a slot (src/plugins/core-tool-slots.ts) the plugin fills while enabled.
 */

import { Type } from "@sinclair/typebox";

import { getAuditStore } from "../../business-objects/audit.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";
import {
  dropNetworkEdges,
  getNetworkGraph,
  hydrateContact,
  linkOpportunity,
  networkContext,
  promoteClient,
  searchClients,
  unlinkOpportunity,
  warmPath,
} from "../../network/service.js";
import {
  LINKABLE_TYPES,
  linkObject,
  linksForNetworkObject,
  peopleForObject,
  searchLinkables,
  unlinkObject,
} from "../../network/links.js";
import { getNetworkStore } from "../../network/store.js";
import {
  CONNECTION_STATUSES,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  ME_ID,
  RELATIONSHIP_TYPES,
  VALUE_TYPES,
} from "../../network/types.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const ACTIONS = [
  "overview",
  "search",
  "get",
  "path",
  "context",
  "history",
  "add_contact",
  "update_contact",
  "connect",
  "update_connection",
  "link_opportunity",
  "unlink_opportunity",
  "add_client",
  "find_clients",
  "remove_contact",
  "remove_connection",
  "link",
  "unlink",
  "linked",
  "find_linkable",
] as const;

const TOOL_ACTOR = "agent:people_network";

const objectTypeParam = Type.Optional(
  stringEnum(LINKABLE_TYPES, { description: "Type of the object to link / look up." }),
);

const PeopleNetworkSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "overview (whole-network summary for decisions) · search (`query`, optional `filters` {contactType,tag,status,minWarm,maxWarm,band: inner|active|warmable|dormant,trend: warming|cooling,sort: warm|warm_asc}) · " +
      "get (`id` contact: value, connections, open opportunities, warm path, history) · path (`id` = target contact, optional `fromId`) · " +
      "context (`id` contact OR `opportunityId`: decision-ready text) · history (`id`) · " +
      "add_contact (`data`) · update_contact (`id` + `data`, e.g. status / nextAction) · connect (`data` {fromId,toId,relationshipType,strength,values}) · " +
      "update_connection (`id` + `data`) · link_opportunity / unlink_opportunity (`kind` contact|connection, `id`, `opportunityId`, `role`) · " +
      "find_clients (`query` over CRM clients) · add_client (`clientId` — brings a CRM client into the network without copying it) · " +
      "remove_contact / remove_connection (`id`) · " +
      "link (`kind` contact|connection + `id` + `objectType` + `objectId`, optional `role`) ties a person/relationship to a project, note, task, file, … · " +
      "unlink (`relationId`, or the same fields as link) · " +
      "linked (`objectType` + `objectId` → the people linked to that object with value + open opportunities; or `kind` + `id` → everything that person/connection is linked to) · " +
      "find_linkable (`query`, optional `objectType`) → ids to pass to link.",
  }),
  objectType: objectTypeParam,
  objectId: Type.Optional(
    Type.String({
      description:
        "Id of the linked object: project/task/note/document/idea/goal/report/client/opportunity id; file = path relative to the files root; event = <source>:<eventId>.",
    }),
  ),
  relationId: Type.Optional(Type.String({ description: "Link row id (unlink)." })),
  id: Type.Optional(Type.String({ description: 'Contact or connection id. The owner is "me".' })),
  fromId: Type.Optional(Type.String({ description: 'Path start (default "me").' })),
  opportunityId: Type.Optional(
    Type.String({ description: "Opportunity id (context / link / unlink)." }),
  ),
  clientId: Type.Optional(Type.String({ description: "CRM client id for add_client." })),
  kind: Type.Optional(
    stringEnum(["contact", "connection"] as const, {
      description: "What link_opportunity attaches.",
    }),
  ),
  role: Type.Optional(
    Type.String({
      description: "Role of the person in the deal, e.g. decision-maker, introducer.",
    }),
  ),
  query: Type.Optional(Type.String({ description: "Free-text search." })),
  filters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  data: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        `Contact fields: name, org, role, contactType (${CONTACT_TYPES.join("|")}), tags[], channels {email,phone,linkedin,x,instagram,telegram,whatsapp,website}, ` +
        `notes, status (${CONTACT_STATUSES.join("|")}), nextAction, nextActionDate (YYYY-MM-DD), lastTouchDate, clientId, connectToMe (bool), ` +
        `warmOverride (0-100 pins the warm score; null clears it). ` +
        `Connection fields: fromId, toId ("me" for the owner), relationshipType (${RELATIONSHIP_TYPES.join("|")}), strength 1-5, direction (mutual|forward|backward), ` +
        `values [{valueType (${VALUE_TYPES.join("|")}), estimatedValue ($, optional), description}], lastTouchDate, status (${CONNECTION_STATUSES.join("|")}), notes.`,
    }),
  ),
  limit: Type.Optional(Type.Number()),
});

export function createPeopleNetworkTool(): AnyAgentTool {
  return createSlotTool("people_network", "Business & Agency");
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function createPeopleNetworkToolImpl(): AnyAgentTool {
  return {
    name: "people_network",
    label: "My Network",
    description:
      "The owner's people network (My Network): contacts (including CRM clients), the connections between them with strength 1-5 and " +
      "structured value (intro access, revenue, expertise, capital…), and the opportunities that ride on each person or connection. " +
      'Use "context" before a decision about a person or deal — it returns who is involved, what each relationship is worth, open ' +
      "opportunities with their pipeline stage, the warm-intro path from the owner, the warm score (0-100: recency, strength, frequency, " +
      "open deals, reciprocity, linked objects; rings Inner circle ≥70 / Active ≥45 / Warm-able ≥20 / Dormant) with its trend, and recent status changes. Status/strength changes " +
      "you make are tracked in history and the audit log. Opportunities themselves live in business_objects (object opportunity). " +
      "People can be linked to projects, notes, documents, files, ideas, tasks, goals, reports, clients, events and other objects " +
      '("link"); "linked" answers who is on a project/note/task and what each person is worth.',
    parameters: PeopleNetworkSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const action = readStringParam(args, "action", { required: true });
      const id = (readStringParam(args, "id") ?? "").trim();
      const data = asRecord(args.data);
      const store = getNetworkStore();
      const audit = (
        what: string,
        objectType: string,
        objectId: string,
        meta: Record<string, unknown> = {},
      ) =>
        getAuditStore().log({
          what,
          trigger: `people_network.${action}`,
          agent: TOOL_ACTOR,
          objectType,
          objectId,
          meta,
        });
      try {
        switch (action) {
          case "overview":
            return jsonResult(await networkContext({}));
          case "search": {
            const f = asRecord(args.filters);
            const rows = store.listContacts({
              query: readStringParam(args, "query") ?? undefined,
              contactType: typeof f.contactType === "string" ? f.contactType : undefined,
              tag: typeof f.tag === "string" ? f.tag : undefined,
              status: typeof f.status === "string" ? f.status : undefined,
            });
            const graph = await getNetworkGraph();
            const byId = new Map(graph.nodes.map((n) => [n.id, n]));
            const limit = typeof args.limit === "number" ? args.limit : 25;
            let hits = rows.map((c) => byId.get(c.id)).filter((n) => n !== undefined);
            const minWarm = Number(f.minWarm);
            const maxWarm = Number(f.maxWarm);
            if (Number.isFinite(minWarm)) hits = hits.filter((n) => n.warmScore >= minWarm);
            if (Number.isFinite(maxWarm)) hits = hits.filter((n) => n.warmScore <= maxWarm);
            if (typeof f.band === "string") hits = hits.filter((n) => n.warmBand === f.band);
            if (typeof f.trend === "string") hits = hits.filter((n) => n.warmTrend === f.trend);
            if (f.sort === "warm" || f.sort === "warm_asc")
              hits.sort((a, b) =>
                f.sort === "warm_asc" ? a.warmScore - b.warmScore : b.warmScore - a.warmScore,
              );
            return jsonResult({ contacts: hits.slice(0, limit), count: hits.length });
          }
          case "get":
          case "context": {
            const opportunityId = (readStringParam(args, "opportunityId") ?? "").trim();
            if (action === "context" && opportunityId)
              return jsonResult(await networkContext({ opportunityId }));
            if (!id) return jsonResult({ error: `id is required for ${action}` });
            return jsonResult(await networkContext({ contactId: id }));
          }
          case "path": {
            if (!id) return jsonResult({ error: "id (target contact) is required" });
            return jsonResult(
              await warmPath(id, (readStringParam(args, "fromId") ?? ME_ID).trim() || ME_ID),
            );
          }
          case "history": {
            const ids = id ? [id, ...store.connectionsOf(id).map((c) => c.id)] : undefined;
            return jsonResult({
              history: store.history({
                objectIds: ids,
                limit: typeof args.limit === "number" ? args.limit : 50,
              }),
            });
          }
          case "add_contact": {
            const c = store.createContact(data, TOOL_ACTOR);
            let connectionId: string | null = null;
            if (data.connectToMe)
              connectionId = store.createConnection(
                {
                  fromId: ME_ID,
                  toId: c.id,
                  relationshipType: c.contactType === "client" ? "client-of" : "other",
                },
                TOOL_ACTOR,
              ).id;
            audit(`Network contact added: ${c.name}`, "contact", c.id, { connectionId });
            return jsonResult({ created: true, contact: await hydrateContact(c), connectionId });
          }
          case "update_contact": {
            if (!id) return jsonResult({ error: "id is required" });
            const before = store.getContact(id);
            const c = store.updateContact({ ...data, id }, TOOL_ACTOR);
            if (!c || !before) return jsonResult({ error: `contact "${id}" not found` });
            if (before.status !== c.status)
              audit(`Contact status ${before.status} → ${c.status}`, "contact", id);
            return jsonResult({ updated: true, contact: await hydrateContact(c) });
          }
          case "connect": {
            const cx = store.createConnection(
              {
                fromId: String(data.fromId ?? ""),
                toId: String(data.toId ?? ""),
                relationshipType: data.relationshipType as string | undefined,
                strength: data.strength as number | undefined,
                direction: data.direction as string | undefined,
                values: data.values as never,
                lastTouchDate: data.lastTouchDate as string | undefined,
                status: data.status as string | undefined,
                notes: data.notes as string | undefined,
              },
              TOOL_ACTOR,
            );
            audit(`Connected ${cx.fromId} ↔ ${cx.toId}`, "connection", cx.id);
            return jsonResult({ created: true, connection: cx });
          }
          case "update_connection": {
            if (!id) return jsonResult({ error: "id is required" });
            const cx = store.updateConnection({ ...(data as object), id }, TOOL_ACTOR);
            if (!cx) return jsonResult({ error: `connection "${id}" not found` });
            audit(`Connection updated ${cx.id}`, "connection", id, {
              status: cx.status,
              strength: cx.strength,
            });
            return jsonResult({ updated: true, connection: cx });
          }
          case "link_opportunity":
          case "unlink_opportunity": {
            const kind = (readStringParam(args, "kind") ?? "contact") as "contact" | "connection";
            const opportunityId = (readStringParam(args, "opportunityId") ?? "").trim();
            if (!id || !opportunityId)
              return jsonResult({ error: "id and opportunityId are required" });
            if (action === "link_opportunity")
              return jsonResult(
                linkOpportunity({
                  kind,
                  id,
                  opportunityId,
                  role: readStringParam(args, "role") ?? undefined,
                  actor: TOOL_ACTOR,
                }),
              );
            return jsonResult({
              removed: unlinkOpportunity({ kind, id, opportunityId, actor: TOOL_ACTOR }),
            });
          }
          case "find_clients":
            return jsonResult({
              clients: await searchClients(readStringParam(args, "query") ?? "", {
                limit: typeof args.limit === "number" ? args.limit : 15,
              }),
            });
          case "add_client": {
            const clientId = (readStringParam(args, "clientId") ?? id).trim();
            if (!clientId) return jsonResult({ error: "clientId is required" });
            return jsonResult(await promoteClient({ clientId, actor: TOOL_ACTOR }));
          }
          case "remove_contact": {
            if (!id) return jsonResult({ error: "id is required" });
            const { deleted, connectionIds } = store.deleteContact(id, TOOL_ACTOR);
            if (deleted) {
              dropNetworkEdges("contact", id);
              for (const cid of connectionIds) dropNetworkEdges("connection", cid);
              audit(`Network contact removed ${id}`, "contact", id);
            }
            return jsonResult({ deleted, id, connectionIds });
          }
          case "remove_connection": {
            if (!id) return jsonResult({ error: "id is required" });
            const deleted = store.deleteConnection(id, TOOL_ACTOR);
            if (deleted) {
              dropNetworkEdges("connection", id);
              audit(`Connection removed ${id}`, "connection", id);
            }
            return jsonResult({ deleted, id });
          }
          case "link": {
            const kind = (readStringParam(args, "kind") ?? "contact") as "contact" | "connection";
            return jsonResult(
              await linkObject({
                kind,
                id,
                objectType: (readStringParam(args, "objectType") ?? "").trim(),
                objectId: (readStringParam(args, "objectId") ?? "").trim(),
                role: readStringParam(args, "role") ?? undefined,
                actor: TOOL_ACTOR,
              }),
            );
          }
          case "unlink":
            return jsonResult({
              removed: unlinkObject({
                relationId: readStringParam(args, "relationId") ?? undefined,
                kind: readStringParam(args, "kind") ?? "contact",
                id,
                objectType: readStringParam(args, "objectType") ?? undefined,
                objectId: readStringParam(args, "objectId") ?? undefined,
                actor: TOOL_ACTOR,
              }),
            });
          case "linked": {
            const objectType = (readStringParam(args, "objectType") ?? "").trim();
            const objectId = (readStringParam(args, "objectId") ?? "").trim();
            if (objectType && objectId)
              return jsonResult(await peopleForObject(objectType, objectId));
            const kind = (readStringParam(args, "kind") ?? "contact") as "contact" | "connection";
            if (!id)
              return jsonResult({ error: "objectType + objectId, or kind + id, is required" });
            return jsonResult(await linksForNetworkObject(kind, id));
          }
          case "find_linkable": {
            const objectType = (readStringParam(args, "objectType") ?? "").trim();
            return jsonResult(
              await searchLinkables(readStringParam(args, "query") ?? "", {
                types: objectType ? [objectType] : undefined,
                limit: typeof args.limit === "number" ? args.limit : 8,
              }),
            );
          }
          default:
            return jsonResult({
              error: `Unknown action "${action}". Expected one of: ${ACTIONS.join(", ")}`,
            });
        }
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
