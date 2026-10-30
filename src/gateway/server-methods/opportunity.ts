/**
 * Gateway RPC handlers for Opportunities (Business Control Layer — Object 2).
 *
 * Thin wrappers over the SQLite-backed `OpportunityStore` (src/opportunity),
 * mirroring the shape of the issues handlers. In addition to plain CRUD, these
 * handlers own the cross-object wiring that the foundation contract assigns to
 * the object agent:
 *
 *   • On create/update, keep the typed-edge relations in sync (`objrel`):
 *       client   --client_has_opportunity-->        opportunity
 *       product  --product_offered_in_opportunity--> opportunity
 *   • On stage → Won, DO NOT silently create a project (§24 human-gated). We
 *     append an audit-log "Create Project?" recommendation and only create the
 *     `opportunity_becomes_project` edge when a projectId is explicitly supplied
 *     (via `opportunity.convert`).
 */

import { withHqObjectBroadcast } from "./hq-object-events.js";
import type { GatewayRequestHandlers } from "./types.js";
import { getOpportunityStore } from "../../opportunity/store.js";
import { getRelationsStore } from "../../relations/store.js";
import { getAuditStore } from "../../business-objects/audit.js";
import type {
  Opportunity,
  OpportunityCreateParams,
  OpportunitySearchParams,
  OpportunityUpdateParams,
} from "../../opportunity/types.js";

const AGENT = "opportunity-agent";

/** Keep the client → opportunity and product → opportunity typed edges aligned
 *  with the record's current clientId / productId. Idempotent; removes a stale
 *  edge when the id changes or is cleared. */
function syncRelations(opp: Opportunity): void {
  const store = getRelationsStore();
  // client_has_opportunity (client → opportunity)
  const existingClient = store
    .linksTo("opportunity", opp.id)
    .filter((r) => r.edge === "client_has_opportunity");
  for (const r of existingClient) {
    if (r.fromId !== opp.clientId) store.delete(r.id);
  }
  if (opp.clientId) {
    store.create({
      fromType: "client",
      fromId: opp.clientId,
      edge: "client_has_opportunity",
      toType: "opportunity",
      toId: opp.id,
      createdBy: AGENT,
    });
  }
  // product_offered_in_opportunity (product → opportunity)
  const existingProduct = store
    .linksTo("opportunity", opp.id)
    .filter((r) => r.edge === "product_offered_in_opportunity");
  for (const r of existingProduct) {
    if (r.fromId !== opp.productId) store.delete(r.id);
  }
  if (opp.productId) {
    store.create({
      fromType: "product",
      fromId: opp.productId,
      edge: "product_offered_in_opportunity",
      toType: "opportunity",
      toId: opp.id,
      createdBy: AGENT,
    });
  }
}

const rawOpportunityHandlers: GatewayRequestHandlers = {
  "opportunity.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as OpportunitySearchParams;
      const opportunities = getOpportunityStore().list(p);
      respond(true, { opportunities, count: opportunities.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opportunity.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as OpportunitySearchParams;
      const opportunities = getOpportunityStore().list(p);
      respond(true, { opportunities, count: opportunities.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opportunity.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const opp = getOpportunityStore().get(id);
      if (!opp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Opportunity "${id}" not found` });
        return;
      }
      respond(true, opp);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opportunity.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as OpportunityCreateParams;
      if (!p.name || typeof p.name !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "name is required" });
        return;
      }
      let opp: Opportunity;
      try {
        opp = getOpportunityStore().create(p);
      } catch (ruleErr) {
        // §27 ownership rule throws a human-actionable message.
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: String(ruleErr instanceof Error ? ruleErr.message : ruleErr),
        });
        return;
      }
      syncRelations(opp);
      getAuditStore().log({
        what: `Opportunity created: ${opp.name}`,
        trigger: "opportunity.create",
        agent: AGENT,
        action: "created opportunity record",
        objectType: "opportunity",
        objectId: opp.id,
        meta: { stage: opp.stage, clientId: opp.clientId, estimatedValue: opp.estimatedValue },
      });
      // §24 — a create straight into Won still requires the human project gate.
      if (String(opp.stage) === "Won") maybeRecommendProject(opp, undefined);
      respond(true, opp);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opportunity.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as OpportunityUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const before = getOpportunityStore().get(p.id);
      if (!before) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Opportunity "${p.id}" not found`,
        });
        return;
      }
      let opp: Opportunity | null;
      try {
        opp = getOpportunityStore().update(p);
      } catch (ruleErr) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: String(ruleErr instanceof Error ? ruleErr.message : ruleErr),
        });
        return;
      }
      if (!opp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Opportunity "${p.id}" not found`,
        });
        return;
      }
      syncRelations(opp);
      // Stage history: the network panel and AI context show how a deal moved.
      if (String(before.stage) !== String(opp.stage)) {
        getAuditStore().log({
          what: `Opportunity "${opp.name}" stage ${before.stage} → ${opp.stage}`,
          trigger: "opportunity.update",
          agent: AGENT,
          action: "stage change",
          objectType: "opportunity",
          objectId: opp.id,
          meta: { field: "stage", from: before.stage, to: opp.stage },
        });
      }
      // §24 — detect the transition INTO Won and surface a human-gated project
      // recommendation. We never auto-create the project here.
      if (String(before.stage) !== "Won" && String(opp.stage) === "Won") {
        maybeRecommendProject(opp, undefined);
      }
      respond(true, opp);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opportunity.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getOpportunityStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Opportunity "${id}" not found` });
        return;
      }
      // Tear down this opportunity's edges so the graph doesn't dangle.
      const rel = getRelationsStore();
      for (const r of rel.linksAround("opportunity", id)) rel.delete(r.id);
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * §24 human-gated conversion. The ONLY path that creates the
   * `opportunity_becomes_project` edge — and only when the operator supplies the
   * projectId they approved. Records the executed action in the audit log with
   * the approver noted.
   */
  "opportunity.convert": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { id?: string; projectId?: string; approvedBy?: string };
      if (!p.id || !p.projectId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "id and projectId are required (project creation is human-gated, §24)",
        });
        return;
      }
      const store = getOpportunityStore();
      const opp = store.get(p.id);
      if (!opp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Opportunity "${p.id}" not found`,
        });
        return;
      }
      const edge = getRelationsStore().create({
        fromType: "opportunity",
        fromId: opp.id,
        edge: "opportunity_becomes_project",
        toType: "project",
        toId: p.projectId,
        createdBy: AGENT,
        meta: { approvedBy: p.approvedBy ?? "" },
      });
      // Carry the project id forward onto the record too (Automation 2 §23).
      store.update({ id: opp.id, projectId: p.projectId });
      getAuditStore().log({
        what: `Opportunity "${opp.name}" converted to project ${p.projectId}`,
        trigger: "opportunity.convert (operator approved)",
        agent: AGENT,
        recommendation: "Create Project? (from Won opportunity)",
        approval: p.approvedBy ? `Approved by ${p.approvedBy}` : "Approved by operator",
        action: `linked opportunity_becomes_project → ${p.projectId}`,
        outcome: "project link created",
        objectType: "opportunity",
        objectId: opp.id,
        meta: { projectId: p.projectId },
      });
      respond(true, { edge, opportunityId: opp.id, projectId: p.projectId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

/**
 * §24: an opportunity reaching Won should PROMPT "Create Project?" — never
 * silently become a project. We record the recommendation in the audit log
 * (approval pending) so the Operations queue can surface it. The actual project
 * link is deferred to `opportunity.convert` once a human supplies the projectId.
 */
function maybeRecommendProject(opp: Opportunity, projectId: string | undefined): void {
  if (projectId) return; // already handled via convert
  getAuditStore().log({
    what: `Opportunity won: ${opp.name}`,
    trigger: "stage → Won",
    agent: AGENT,
    recommendation: "Create Project? Carry client, opportunity, scope and value forward.",
    approval: "PENDING — human approval required (§24; do not auto-create)",
    action: "none (awaiting operator approval)",
    outcome: "recommendation queued",
    objectType: "opportunity",
    objectId: opp.id,
    meta: {
      clientId: opp.clientId,
      estimatedValue: opp.estimatedValue,
      revenueType: opp.revenueType,
    },
  });
}

export const opportunityHandlers: GatewayRequestHandlers = withHqObjectBroadcast(
  "opportunity",
  rawOpportunityHandlers,
  ["opportunity.create", "opportunity.update", "opportunity.delete", "opportunity.convert"],
);
