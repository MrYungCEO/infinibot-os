/**
 * Agent tool — Phase 1 business objects (KIS control layer).
 *
 * One tool with an `object` + `action` switch giving agents full CRUD plus the
 * object-specific operations over the six SQLite-backed Phase 1 stores:
 *
 *   opportunity · product · decision · risk · commitment · person
 *
 * Handlers call the in-process stores directly (the same stores the gateway
 * `opportunity.* / product.* / decision.* / risk.* / commitment.* / person.*`
 * RPCs wrap), so a native roster agent and an MCP client both get identical
 * semantics — including the Phase 1 ground rules the stores enforce on write
 * (§26 priority, §27 one accountable owner, §33 audit, §35 data quality).
 *
 * Clients, projects, tasks and issues intentionally stay on their existing
 * dedicated tools (`kanban`, `issues`, `client_contacts`); this tool covers the
 * six objects that had no agent surface at all. Use `object_relations` to
 * connect any of them into the typed-edge graph.
 */

import { Type } from "@sinclair/typebox";

import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

import { getOpportunityStore } from "../../opportunity/store.js";
import { getProductStore } from "../../product/store.js";
import { getDecisionStore } from "../../decision/store.js";
import { getRiskStore } from "../../risk/store.js";
import { getCommitmentStore } from "../../commitment/store.js";
import { getPersonStore } from "../../person/store.js";
import { getRelationsStore } from "../../relations/store.js";
import { getAuditStore } from "../../business-objects/audit.js";
import { createSlotTool } from "../../plugins/core-tool-slots.js";

const OBJECTS = ["opportunity", "product", "decision", "risk", "commitment", "person"] as const;
type ObjectKind = (typeof OBJECTS)[number];

const ACTIONS = [
  // Shared CRUD
  "list",
  "get",
  "search",
  "create",
  "update",
  "delete",
  // opportunity
  "convert",
  // product
  "graph",
  // decision
  "ceo_queue",
  "guide_task",
  // risk
  "overdue",
  "links",
  "impacts",
  "unimpacts",
  // commitment
  "aggregates",
  // person
  "workload",
  "assign_task",
  "unassign_task",
] as const;

/** Default provenance recorded on writes made through this tool. */
const AGENT = "business-objects-tool";

const BusinessObjectsSchema = Type.Object({
  object: stringEnum(OBJECTS, {
    description:
      "Which Phase 1 business object to operate on. Required for every action except decision `ceo_queue` (which implies decision).",
  }),
  action: stringEnum(ACTIONS, {
    description:
      "What to do. Shared: list, get, search, create, update, delete. " +
      "opportunity: convert. product: graph. decision: ceo_queue, guide_task. " +
      "risk: overdue, links, impacts, unimpacts. commitment: aggregates. " +
      "person: workload, assign_task, unassign_task.",
  }),
  id: Type.Optional(
    Type.String({
      description:
        "Record id — required for get / update / delete and most object-specific actions.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Free-text search over the record's main fields (used by `search`, also honoured by `list`).",
    }),
  ),
  filters: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Field filters passed straight to the store's list(). Examples — opportunity: {stage,status,priority,owner,clientId,productId}; " +
        "product: {productType,status,validationStage,revenueModel,priority,owner,parentProductId}; " +
        "decision: {decisionType,status,priority,owner,clientId,opportunityId,projectId,productId,issueId}; " +
        "risk: {category,status,owner,clientId,projectId,minScore,criticalOnly}; " +
        "commitment: {commitmentType,direction,status,owner,clientId,projectId,overdueOnly}; " +
        "person: {relationshipType,status,accessLevel,owner}. All accept {since,limit}.",
    }),
  ),
  data: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Field payload for create / update. Create requires `name` (opportunity, product, commitment, person) or `title` (decision, risk); " +
        "product also requires `owner`. Every other field from that object's schema is optional — e.g. owner, priority (P0-P3), status, " +
        "stage, validationStage, clientId, projectId, productId, opportunityId, amount, dueDate, probability, impact, dataQuality, authorityLevel. " +
        "For update the `id` param identifies the record; unknown keys are ignored by the store.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max rows returned by list / search." })),
  taskId: Type.Optional(
    Type.String({
      description:
        "Task id — for decision guide_task, risk impacts/unimpacts, person assign_task/unassign_task.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({
      description:
        "Project id — required by opportunity `convert` (project creation is human-gated, §24).",
    }),
  ),
  approvedBy: Type.Optional(
    Type.String({
      description: "Who approved an opportunity `convert`, recorded in the audit log.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        "Task status recorded on the edge meta for person `assign_task` (drives workload classification).",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({ description: "Graph traversal depth for product `graph` (default 2)." }),
  ),
  createdBy: Type.Optional(
    Type.String({
      description: "Provenance recorded on link-creating actions. Defaults to the tool name.",
    }),
  ),
});

/** The subset of store surface this tool needs, structurally shared by all six. */
interface CrudStore {
  list(params: Record<string, unknown>): unknown[];
  get(id: string): unknown;
  create(params: Record<string, unknown>): unknown;
  update(params: Record<string, unknown>): unknown;
  delete(id: string): boolean;
}

function storeFor(object: ObjectKind): CrudStore {
  switch (object) {
    case "opportunity":
      return getOpportunityStore() as unknown as CrudStore;
    case "product":
      return getProductStore() as unknown as CrudStore;
    case "decision":
      return getDecisionStore() as unknown as CrudStore;
    case "risk":
      return getRiskStore() as unknown as CrudStore;
    case "commitment":
      return getCommitmentStore() as unknown as CrudStore;
    case "person":
      return getPersonStore() as unknown as CrudStore;
  }
}

/** Plural key used in the JSON envelope, matching the gateway RPC shapes. */
function pluralKey(object: ObjectKind): string {
  return object === "person" ? "people" : `${object}s`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * `business_objects` is a Business & Agency plugin tool: core keeps the name as a slot
 * (src/plugins/core-tool-slots.ts) that the plugin fills while it is enabled.
 * With the plugin off the slot is empty and agents never see the tool.
 */
export function createBusinessObjectsTool(_options?: { agentId?: string }): AnyAgentTool {
  return createSlotTool("business_objects", "Business & Agency");
}

/** The real tool; the business-agency plugin fills the slot with it. */
export function createBusinessObjectsToolImpl(_options?: { agentId?: string }): AnyAgentTool {
  return {
    name: "business_objects",
    label: "Business Objects",
    description:
      "Read and write the Phase 1 business control layer: opportunities, products, decisions, risks, financial commitments and people. " +
      "Pick an `object` and an `action`.\n" +
      '\nShared actions: "list" (with `filters` + `limit`), "search" (`query`), "get" (`id`), ' +
      '"create" (`data`), "update" (`id` + `data`), "delete" (`id`).\n' +
      '\nObject-specific: opportunity "convert" (`id` + `projectId` — links a Won opportunity to its project, §24 human-gated); ' +
      'product "graph" (`id`, `maxDepth`) for the connected neighbourhood; ' +
      'decision "ceo_queue" (what needs the CEO now, priority-sorted) and "guide_task" (`id` + `taskId`); ' +
      'risk "overdue" (reviews past due), "links" (`id`), "impacts"/"unimpacts" (`id` + `taskId`); ' +
      'commitment "aggregates" (money in/out, overdue, deposits outstanding); ' +
      'person "workload" (`id`), "assign_task"/"unassign_task" (`id` + `taskId`).\n' +
      "\nWrites go through the same stores as the UI, so ground rules are enforced: one accountable owner per record, " +
      "priority P0-P3, and significant changes land in the audit log. Use `object_relations` to connect these objects " +
      "to clients, projects, tasks and issues.",
    parameters: BusinessObjectsSchema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const params = args as Record<string, unknown>;
      const object = readStringParam(params, "object", { required: true }) as ObjectKind;
      const action = readStringParam(params, "action", { required: true });

      if (!(OBJECTS as readonly string[]).includes(object)) {
        return jsonResult({
          error: `Unknown object "${object}". Expected one of: ${OBJECTS.join(", ")}`,
        });
      }

      const id = readStringParam(params, "id") ?? undefined;
      const taskId = readStringParam(params, "taskId") ?? undefined;
      const createdBy = readStringParam(params, "createdBy") ?? AGENT;
      const data = asRecord(params.data);
      const filters = asRecord(params.filters);
      const limit = typeof params.limit === "number" ? params.limit : undefined;

      const needId = (): string | null => (id && id.trim() ? id.trim() : null);

      try {
        const s = storeFor(object);

        switch (action) {
          // ── Shared CRUD ────────────────────────────────────────────
          case "list":
          case "search": {
            const q = readStringParam(params, "query") ?? undefined;
            const listParams: Record<string, unknown> = { ...filters };
            if (q) listParams.query = q;
            if (limit != null) listParams.limit = limit;
            const rows = s.list(listParams);
            return jsonResult({ [pluralKey(object)]: rows, count: rows.length });
          }

          case "get": {
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for get" });
            const row = s.get(rid);
            if (!row) return jsonResult({ found: false, error: `${object} "${rid}" not found` });
            return jsonResult({ found: true, [object]: row });
          }

          case "create": {
            const created = s.create({ ...data, createdBy: data.createdBy ?? createdBy });
            return jsonResult({ created: true, [object]: created });
          }

          case "update": {
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for update" });
            const updated = s.update({ ...data, id: rid });
            if (!updated) return jsonResult({ error: `${object} "${rid}" not found` });
            return jsonResult({ updated: true, [object]: updated });
          }

          case "delete": {
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for delete" });
            const ok = s.delete(rid);
            return jsonResult({ deleted: ok, id: rid });
          }

          // ── opportunity ────────────────────────────────────────────
          case "convert": {
            if (object !== "opportunity") {
              return jsonResult({ error: `"convert" is only valid for object "opportunity"` });
            }
            const rid = needId();
            const projectId = readStringParam(params, "projectId") ?? undefined;
            if (!rid || !projectId) {
              return jsonResult({
                error: "id and projectId are required (project creation is human-gated, §24)",
              });
            }
            const store = getOpportunityStore();
            const opp = store.get(rid);
            if (!opp) return jsonResult({ error: `Opportunity "${rid}" not found` });
            const approvedBy = readStringParam(params, "approvedBy") ?? "";
            const edge = getRelationsStore().create({
              fromType: "opportunity",
              fromId: opp.id,
              edge: "opportunity_becomes_project",
              toType: "project",
              toId: projectId,
              createdBy,
              meta: { approvedBy },
            });
            store.update({ id: opp.id, projectId });
            getAuditStore().log({
              what: `Opportunity "${opp.name}" converted to project ${projectId}`,
              trigger: "business_objects tool (opportunity.convert)",
              agent: createdBy,
              recommendation: "Create Project? (from Won opportunity)",
              approval: approvedBy ? `Approved by ${approvedBy}` : "Approved by operator",
              action: `linked opportunity_becomes_project → ${projectId}`,
              outcome: "project link created",
              objectType: "opportunity",
              objectId: opp.id,
              meta: { projectId },
            });
            return jsonResult({ converted: true, edge, opportunityId: opp.id, projectId });
          }

          // ── product ────────────────────────────────────────────────
          case "graph": {
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for graph" });
            const maxDepth = typeof params.maxDepth === "number" ? params.maxDepth : 2;
            return jsonResult(getRelationsStore().graphFor(object, rid, maxDepth));
          }

          // ── decision ───────────────────────────────────────────────
          case "ceo_queue": {
            const queue = getDecisionStore().ceoQueue();
            return jsonResult({ decisions: queue, count: queue.length });
          }

          case "guide_task": {
            if (object !== "decision") {
              return jsonResult({ error: `"guide_task" is only valid for object "decision"` });
            }
            const rid = needId();
            if (!rid || !taskId)
              return jsonResult({ error: "id and taskId are required for guide_task" });
            const relId = getDecisionStore().guideTask(rid, taskId, createdBy);
            return jsonResult({ linked: true, relationId: relId, decisionId: rid, taskId });
          }

          // ── risk ───────────────────────────────────────────────────
          case "overdue": {
            if (object !== "risk") {
              return jsonResult({
                error: `"overdue" is only valid for object "risk" (use commitment filters {overdueOnly:true})`,
              });
            }
            const rows = getRiskStore().overdueReviews();
            return jsonResult({ risks: rows, count: rows.length });
          }

          case "links": {
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for links" });
            const relations = getRelationsStore().linksAround(object, rid);
            return jsonResult({ relations, count: relations.length });
          }

          case "impacts":
          case "unimpacts": {
            if (object !== "risk") {
              return jsonResult({ error: `"${action}" is only valid for object "risk"` });
            }
            const rid = needId();
            if (!rid || !taskId)
              return jsonResult({ error: `id and taskId are required for ${action}` });
            if (action === "impacts") {
              const rel = getRelationsStore().create({
                fromType: "risk",
                fromId: rid,
                edge: "risk_impacts_task",
                toType: "task",
                toId: taskId,
                createdBy,
              });
              return jsonResult({ linked: true, relation: rel });
            }
            const deleted = getRelationsStore().deleteMatch({
              fromType: "risk",
              fromId: rid,
              edge: "risk_impacts_task",
              toType: "task",
              toId: taskId,
            });
            return jsonResult({ unlinked: deleted > 0, deleted });
          }

          // ── commitment ─────────────────────────────────────────────
          case "aggregates": {
            if (object !== "commitment") {
              return jsonResult({ error: `"aggregates" is only valid for object "commitment"` });
            }
            const listParams: Record<string, unknown> = { ...filters };
            if (limit != null) listParams.limit = limit;
            return jsonResult(getCommitmentStore().computeAggregates(listParams));
          }

          // ── person ─────────────────────────────────────────────────
          case "workload": {
            if (object !== "person") {
              return jsonResult({ error: `"workload" is only valid for object "person"` });
            }
            const rid = needId();
            if (!rid) return jsonResult({ error: "id is required for workload" });
            const store = getPersonStore();
            if (!store.get(rid)) return jsonResult({ error: `Person "${rid}" not found` });
            return jsonResult(store.workloadFor(rid));
          }

          case "assign_task":
          case "unassign_task": {
            if (object !== "person") {
              return jsonResult({ error: `"${action}" is only valid for object "person"` });
            }
            const rid = needId();
            if (!rid || !taskId)
              return jsonResult({ error: `id and taskId are required for ${action}` });
            const store = getPersonStore();
            if (action === "assign_task") {
              const rel = store.assignTask(rid, taskId, {
                createdBy,
                status: readStringParam(params, "status") ?? undefined,
              });
              return jsonResult({ assigned: true, relation: rel });
            }
            const removed = store.unassignTask(rid, taskId);
            return jsonResult({ unassigned: removed > 0, deleted: removed });
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
