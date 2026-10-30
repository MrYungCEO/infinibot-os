/**
 * Gateway RPC handlers for the Risk Register (Object 7).
 *
 * Thin wrappers over the SQLite-backed `RiskStore` (src/risk/store.ts), mirroring
 * the shape of the `issues.*` handlers: each method validates params, calls the
 * store, and reports through `respond(ok, data, error?)`.
 *
 * Cross-object links go through the typed-edge relations layer (`src/relations`):
 *   • the risk's parent objects (client / opportunity / project / product /
 *     system issue / decision) are attached with the generic `relates_to` edge
 *     and kept in sync whenever the risk's relationship ids change;
 *   • the tasks a risk threatens are linked with the directional
 *     `risk_impacts_task` edge (risk → task) via `risk.impacts`.
 */

import { withHqObjectBroadcast } from "./hq-object-events.js";
import {
  isRiskResolvedStatus,
  recordHqProgress,
  unrecordHqProgress,
} from "../../hq-progress/store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { getRiskStore } from "../../risk/store.js";
import { getRelationsStore } from "../../relations/store.js";
import type {
  RiskCreateParams,
  RiskSearchParams,
  RiskUpdateParams,
  Risk,
} from "../../risk/types.js";

// Map a risk's denormalized relationship-id fields onto the object type they
// point at. Each is attached to the risk with a generic `relates_to` edge.
const RELATES_TO_FIELDS: Array<{ key: keyof Risk; toType: string }> = [
  { key: "clientId", toType: "client" },
  { key: "opportunityId", toType: "opportunity" },
  { key: "projectId", toType: "project" },
  { key: "productId", toType: "product" },
  { key: "issueId", toType: "issue" },
  { key: "decisionId", toType: "decision" },
];

/**
 * Reconcile the risk's `relates_to` edges with its current relationship ids:
 * for each parent slot, drop any prior edge of that target type and (re)create
 * one for the id the risk now carries. Idempotent and best-effort — a relations
 * failure never fails the risk write.
 */
function syncRiskRelatesTo(risk: Risk, createdBy = "risk-register"): void {
  try {
    const store = getRelationsStore();
    for (const { key, toType } of RELATES_TO_FIELDS) {
      const toId = String(risk[key] ?? "").trim();
      store.deleteMatch({ fromType: "risk", fromId: risk.id, edge: "relates_to", toType });
      if (toId) {
        store.create({
          fromType: "risk",
          fromId: risk.id,
          edge: "relates_to",
          toType,
          toId,
          createdBy,
        });
      }
    }
  } catch {
    /* relations are a secondary index; never block the primary write. */
  }
}

const rawRiskHandlers: GatewayRequestHandlers = {
  "risk.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as RiskSearchParams;
      const risks = getRiskStore().list(p);
      respond(true, { risks, count: risks.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "risk.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as RiskSearchParams;
      const risks = getRiskStore().list(p);
      respond(true, { risks, count: risks.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "risk.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const risk = getRiskStore().get(id);
      if (!risk) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Risk "${id}" not found` });
        return;
      }
      respond(true, risk);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Risks whose review is overdue (§29) — score-driven cadence + Next Review Date. */
  "risk.overdue": async ({ params, respond }) => {
    try {
      const { now } = (params ?? {}) as { now?: number };
      const risks = getRiskStore().overdueReviews(typeof now === "number" ? now : undefined);
      respond(true, { risks, count: risks.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "risk.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as RiskCreateParams;
      if (!p.title || typeof p.title !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
        return;
      }
      const risk = getRiskStore().create(p);
      syncRiskRelatesTo(risk);
      respond(true, risk);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "risk.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as RiskUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const risk = getRiskStore().update(p);
      if (!risk) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Risk "${p.id}" not found` });
        return;
      }
      syncRiskRelatesTo(risk);
      respond(true, risk);
      if (p.status !== undefined) {
        if (isRiskResolvedStatus(risk.status)) {
          recordHqProgress({
            kind: "risk.resolved",
            objectId: risk.id,
            title: risk.title,
            source: "risk",
          });
        } else {
          unrecordHqProgress("risk.resolved", risk.id);
        }
      }
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "risk.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getRiskStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Risk "${id}" not found` });
        return;
      }
      // Drop every edge touching this risk so the graph doesn't dangle.
      try {
        for (const rel of getRelationsStore().linksAround("risk", id)) {
          getRelationsStore().delete(rel.id);
        }
      } catch {
        /* non-fatal */
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Link a risk to a task it threatens (directional `risk_impacts_task`). */
  "risk.impacts": async ({ params, respond }) => {
    try {
      const { riskId, taskId, createdBy } = (params ?? {}) as {
        riskId?: string;
        taskId?: string;
        createdBy?: string;
      };
      if (!riskId || !taskId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "riskId and taskId are required",
        });
        return;
      }
      const rel = getRelationsStore().create({
        fromType: "risk",
        fromId: riskId,
        edge: "risk_impacts_task",
        toType: "task",
        toId: taskId,
        createdBy: createdBy || "risk-register",
      });
      respond(true, rel);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Remove a risk→task impact link. */
  "risk.unimpacts": async ({ params, respond }) => {
    try {
      const { riskId, taskId } = (params ?? {}) as { riskId?: string; taskId?: string };
      if (!riskId || !taskId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "riskId and taskId are required",
        });
        return;
      }
      const deleted = getRelationsStore().deleteMatch({
        fromType: "risk",
        fromId: riskId,
        edge: "risk_impacts_task",
        toType: "task",
        toId: taskId,
      });
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** All typed edges touching a risk (both directions). */
  "risk.links": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const relations = getRelationsStore().linksAround("risk", id);
      respond(true, { relations, count: relations.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export const riskHandlers: GatewayRequestHandlers = withHqObjectBroadcast("risk", rawRiskHandlers, [
  "risk.create",
  "risk.update",
  "risk.delete",
  "risk.impacts",
  "risk.unimpacts",
]);
