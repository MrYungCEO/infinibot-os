/**
 * Agent tool — typed-edge relations between business objects (`objrel`).
 *
 * This is the graph layer of the Phase 1 control layer: it lets an agent
 * connect and traverse the ten objects
 *
 *   client → opportunity → project → task → person
 *   + product, decision, risk, commitment, issue
 *
 * Handlers call the in-process `RelationsStore` directly — the same store the
 * gateway `objrel.*` RPCs wrap.
 *
 * NAMESPACE NOTE: this is the directional, typed-edge business-object graph
 * (`objrel.*`), NOT the older untyped/symmetric `relations.*` entity-link
 * system used by business.ts / kanban.ts. Keep them distinct.
 */

import { Type } from "@sinclair/typebox";

import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

import { getRelationsStore } from "../../relations/store.js";
import { OBJECT_TYPES, RELATION_EDGES } from "../../relations/types.js";
import {
  associationsForReport,
  linkReport,
  reportsForObject,
  unlinkReport,
  REPORT_TARGET_TYPES,
} from "../../reports/associations.js";

const ACTIONS = [
  "link",
  "unlink",
  "list",
  "links_from",
  "links_to",
  "links_around",
  "graph",
  "edge_types",
  // Report associations — a rendered report documents a client / opportunity /
  // project. Dedicated actions because the caller shouldn't have to know which
  // report_documents_* edge to pick, and because reports_for joins through to
  // the report rows rather than returning bare edges.
  "link_report",
  "unlink_report",
  "reports_for",
  "report_associations",
] as const;

const AGENT = "object-relations-tool";

const ObjectRelationsSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "link (create an edge) · unlink (delete by id or by from/edge/to match) · list (filtered query) · " +
      "links_from / links_to / links_around (edges for one object) · graph (connected neighbourhood) · " +
      "edge_types (list the valid object types and edges).",
  }),
  fromType: Type.Optional(
    stringEnum(OBJECT_TYPES, { description: "Subject object type of the edge." }),
  ),
  fromId: Type.Optional(Type.String({ description: "Subject object id." })),
  edge: Type.Optional(
    stringEnum(RELATION_EDGES, {
      description:
        "Typed edge. Direction is meaningful (from = subject, to = object of the verb). " +
        'Use "relates_to" for links with no dedicated edge.',
    }),
  ),
  toType: Type.Optional(
    stringEnum(OBJECT_TYPES, { description: "Target object type of the edge." }),
  ),
  toId: Type.Optional(Type.String({ description: "Target object id." })),
  type: Type.Optional(
    stringEnum(OBJECT_TYPES, {
      description: "Object type for links_from / links_to / links_around / graph.",
    }),
  ),
  id: Type.Optional(
    Type.String({
      description:
        "Object id for links_from / links_to / links_around / graph — or the relation row id for unlink.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "How many hops `graph` traverses outward from the root (default 3).",
    }),
  ),
  since: Type.Optional(
    Type.Number({ description: "Only edges created after this epoch-ms timestamp." }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max edges returned by list." })),
  createdBy: Type.Optional(
    Type.String({
      description: "Provenance stamped on a created edge. Defaults to the tool name.",
    }),
  ),
  meta: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Arbitrary JSON stored on the edge (e.g. {status} on a task→person assignment).",
    }),
  ),
  reportId: Type.Optional(
    Type.String({
      description:
        "Report id (rpt_…) for link_report / unlink_report / report_associations. Returned by the `report` tool.",
    }),
  ),
  targetType: Type.Optional(
    stringEnum(REPORT_TARGET_TYPES, {
      description: "Which business object the report documents (link_report / unlink_report).",
    }),
  ),
  targetId: Type.Optional(
    Type.String({ description: "Id of the client / opportunity / project the report documents." }),
  ),
});

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function createObjectRelationsTool(_options?: { agentId?: string }): AnyAgentTool {
  return {
    name: "object_relations",
    label: "Object Relations",
    description:
      "Connect and traverse the business-object graph — the typed edges linking clients, opportunities, projects, tasks, " +
      "products, decisions, risks, commitments, people and issues.\n" +
      '\n"link" (fromType/fromId/edge/toType/toId) creates an edge; it is idempotent, so re-linking the same triple returns ' +
      'the existing row. "unlink" removes one by relation `id`, or by whatever subset of from/edge/to you supply. ' +
      '"list" filters edges by any subset of from/edge/to plus since/limit. "links_from", "links_to" and "links_around" ' +
      'return the edges for a single object (`type` + `id`). "graph" walks outward from an object and returns the connected ' +
      'neighbourhood as nodes + edges — use it to answer "what does this touch?". "edge_types" lists the valid object types ' +
      "and edges if you are unsure which to use.\n" +
      "\nEdges are directional: client_has_opportunity, opportunity_becomes_project, project_has_task, project_delivers_product, " +
      "product_offered_in_opportunity, decision_guides_task, risk_impacts_task, commitment_funds_project, task_assigned_to_person, " +
      "issue_relates_task, and relates_to as a generic fallback.\n" +
      "\nReports: a rendered report can be associated with the client, opportunity or project it documents. " +
      '"link_report" (reportId + targetType + targetId) creates that association, "unlink_report" removes it, ' +
      '"reports_for" (type + id) lists every report for a business object, and "report_associations" (reportId) ' +
      "lists everything one report covers. After producing a PDF with the `report` tool, associate it — or pass " +
      "clientId / opportunityId / projectId to the `report` tool and it links automatically.\n" +
      "\nUse `business_objects` to read or write the records themselves.",
    parameters: ObjectRelationsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      const fromType = readStringParam(params, "fromType") ?? undefined;
      const fromId = readStringParam(params, "fromId") ?? undefined;
      const edge = readStringParam(params, "edge") ?? undefined;
      const toType = readStringParam(params, "toType") ?? undefined;
      const toId = readStringParam(params, "toId") ?? undefined;
      const type = readStringParam(params, "type") ?? undefined;
      const id = readStringParam(params, "id") ?? undefined;
      const createdBy = readStringParam(params, "createdBy") ?? AGENT;

      try {
        const store = getRelationsStore();

        switch (action) {
          case "edge_types":
            return jsonResult({ objectTypes: [...OBJECT_TYPES], edges: [...RELATION_EDGES] });

          case "link": {
            if (!fromType || !fromId || !edge || !toType || !toId) {
              return jsonResult({
                error: "fromType, fromId, edge, toType and toId are all required for link",
              });
            }
            const rel = store.create({
              fromType,
              fromId,
              edge,
              toType,
              toId,
              createdBy,
              meta: asRecord(params.meta),
            });
            return jsonResult({ linked: true, relation: rel });
          }

          case "unlink": {
            if (id) {
              const ok = store.delete(id);
              return jsonResult({ unlinked: ok, deleted: ok ? 1 : 0, id });
            }
            if (!fromType && !fromId && !edge && !toType && !toId) {
              return jsonResult({
                error:
                  "unlink needs either a relation `id` or at least one of fromType/fromId/edge/toType/toId (refusing to wipe the graph)",
              });
            }
            const deleted = store.deleteMatch({ fromType, fromId, edge, toType, toId });
            return jsonResult({ unlinked: deleted > 0, deleted });
          }

          case "list": {
            const relations = store.list({
              fromType,
              fromId,
              edge,
              toType,
              toId,
              since: typeof params.since === "number" ? params.since : undefined,
              limit: typeof params.limit === "number" ? params.limit : undefined,
            });
            return jsonResult({ relations, count: relations.length });
          }

          case "links_from":
          case "links_to":
          case "links_around": {
            const t = type ?? fromType;
            const objId = id ?? fromId;
            if (!t || !objId) {
              return jsonResult({ error: `type and id are required for ${action}` });
            }
            const relations =
              action === "links_from"
                ? store.linksFrom(t, objId)
                : action === "links_to"
                  ? store.linksTo(t, objId)
                  : store.linksAround(t, objId);
            return jsonResult({ relations, count: relations.length });
          }

          case "graph": {
            const t = type ?? fromType;
            const objId = id ?? fromId;
            if (!t || !objId) return jsonResult({ error: "type and id are required for graph" });
            const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : 3;
            const graph = store.graphFor(t, objId, maxDepth);
            return jsonResult({
              ...graph,
              nodeCount: graph.nodes.length,
              edgeCount: graph.edges.length,
            });
          }

          case "link_report": {
            const reportId = readStringParam(params, "reportId") ?? undefined;
            const targetType = readStringParam(params, "targetType") ?? toType;
            const targetId = readStringParam(params, "targetId") ?? toId;
            if (!reportId || !targetType || !targetId) {
              return jsonResult({
                error: `link_report needs reportId, targetType (${REPORT_TARGET_TYPES.join("|")}) and targetId`,
              });
            }
            const association = linkReport({ reportId, targetType, targetId, createdBy });
            return jsonResult({ linked: true, association });
          }

          case "unlink_report": {
            const reportId = readStringParam(params, "reportId") ?? undefined;
            if (!reportId && !id) {
              return jsonResult({ error: "unlink_report needs a reportId (or a relation `id`)" });
            }
            const deleted = unlinkReport({
              relationId: id,
              reportId,
              targetType: readStringParam(params, "targetType") ?? toType,
              targetId: readStringParam(params, "targetId") ?? toId,
            });
            return jsonResult({ unlinked: deleted > 0, deleted });
          }

          case "reports_for": {
            const t = readStringParam(params, "targetType") ?? type ?? toType;
            const objId = readStringParam(params, "targetId") ?? id ?? toId;
            if (!t || !objId) {
              return jsonResult({
                error: `reports_for needs type (${REPORT_TARGET_TYPES.join("|")}) and id`,
              });
            }
            const { reports, associations, missing } = reportsForObject(t, objId, {
              limit: typeof params.limit === "number" ? params.limit : undefined,
            });
            return jsonResult({ reports, associations, count: reports.length, missing });
          }

          case "report_associations": {
            const reportId = readStringParam(params, "reportId") ?? id;
            if (!reportId) return jsonResult({ error: "report_associations needs a reportId" });
            const associations = associationsForReport(reportId);
            return jsonResult({ associations, count: associations.length });
          }

          default:
            return jsonResult({ error: `Unknown action "${action}"` });
        }
      } catch (e) {
        return jsonResult({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
