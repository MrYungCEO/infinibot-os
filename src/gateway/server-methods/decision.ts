/**
 * Gateway RPC handlers for Decisions — the CEO-queue backbone (Object 6).
 *
 * Thin wrappers over the SQLite-backed `DecisionStore` (src/decision/store.ts),
 * mirroring the shape of the issues handlers: each method validates params,
 * calls the store, and reports through `respond(ok, data, error?)`.
 *
 * Read methods:  decision.list, decision.get, decision.search, decision.ceoQueue
 * Write methods: decision.create, decision.update, decision.delete, decision.guideTask
 */

import { withHqObjectBroadcast } from "./hq-object-events.js";
import {
  isDecisionDecidedStatus,
  recordHqProgress,
  unrecordHqProgress,
} from "../../hq-progress/store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { getDecisionStore } from "../../decision/store.js";
import type {
  DecisionCreateParams,
  DecisionSearchParams,
  DecisionUpdateParams,
} from "../../decision/types.js";

const rawDecisionHandlers: GatewayRequestHandlers = {
  "decision.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as DecisionSearchParams;
      const decisions = getDecisionStore().list(p);
      respond(true, { decisions, count: decisions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "decision.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as DecisionSearchParams;
      const decisions = getDecisionStore().list(p);
      respond(true, { decisions, count: decisions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * The CEO Queue: decisions Ready for Decision / in CEO Review, most-urgent-first.
   * Pass `{ triggerFiltered: true }` to apply the §16 CEO Decision Trigger gate —
   * only decisions where at least one trigger fires are returned, each enriched
   * with its inferred `ceoTriggers`.
   */
  "decision.ceoQueue": async ({ params, respond }) => {
    try {
      const { triggerFiltered } = (params ?? {}) as { triggerFiltered?: boolean };
      const store = getDecisionStore();
      const decisions = triggerFiltered ? store.ceoQueueFiltered() : store.ceoQueue();
      respond(true, { decisions, count: decisions.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "decision.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const decision = getDecisionStore().get(id);
      if (!decision) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Decision "${id}" not found` });
        return;
      }
      respond(true, decision);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "decision.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as DecisionCreateParams;
      if (!p.title || typeof p.title !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
        return;
      }
      const decision = getDecisionStore().create(p);
      respond(true, decision);
    } catch (e) {
      // §27 ownership violations surface as an actionable validation error.
      respond(false, undefined, { code: "INVALID_REQUEST", message: String(e) });
    }
  },

  "decision.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as DecisionUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const decision = getDecisionStore().update(p);
      if (!decision) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Decision "${p.id}" not found` });
        return;
      }
      respond(true, decision);
      // Business HQ progress log: a decision made is progress; reopening undoes it.
      if (p.status !== undefined) {
        if (isDecisionDecidedStatus(decision.status)) {
          recordHqProgress({
            kind: "decision.decided",
            objectId: decision.id,
            title: decision.title,
            source: "decision",
          });
        } else {
          unrecordHqProgress("decision.decided", decision.id);
        }
      }
    } catch (e) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: String(e) });
    }
  },

  "decision.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getDecisionStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Decision "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Link a decision to a task it guides (`decision_guides_task` typed edge). */
  "decision.guideTask": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { decisionId?: string; taskId?: string; createdBy?: string };
      if (!p.decisionId || !p.taskId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "decisionId and taskId are required",
        });
        return;
      }
      const store = getDecisionStore();
      if (!store.get(p.decisionId)) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Decision "${p.decisionId}" not found`,
        });
        return;
      }
      const relationId = store.guideTask(p.decisionId, p.taskId, p.createdBy);
      respond(true, { relationId, decisionId: p.decisionId, taskId: p.taskId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export const decisionHandlers: GatewayRequestHandlers = withHqObjectBroadcast(
  "decision",
  rawDecisionHandlers,
  ["decision.create", "decision.update", "decision.delete", "decision.guideTask"],
);
