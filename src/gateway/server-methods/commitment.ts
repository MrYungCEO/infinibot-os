/**
 * Gateway RPC handlers for Financial Commitments (K.I.S. Object 8).
 *
 * Thin wrappers over the SQLite-backed `CommitmentStore`
 * (src/commitment/store.ts). Mirrors the shape of the issues handlers: each
 * method validates params, calls the store, and reports through
 * `respond(ok, data, error?)`. The store owns the §27 owner assertion, the
 * objrel typed-link reconciliation, and the §33 audit trail — the handlers stay
 * dumb transport.
 */

import { withHqObjectBroadcast } from "./hq-object-events.js";
import {
  isCommitmentSettledStatus,
  recordHqProgress,
  unrecordHqProgress,
} from "../../hq-progress/store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { getCommitmentStore } from "../../commitment/store.js";
import type {
  CommitmentCreateParams,
  CommitmentSearchParams,
  CommitmentUpdateParams,
} from "../../commitment/types.js";

const rawCommitmentHandlers: GatewayRequestHandlers = {
  "commitment.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as CommitmentSearchParams;
      const commitments = getCommitmentStore().list(p);
      respond(true, { commitments, count: commitments.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "commitment.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as CommitmentSearchParams;
      const commitments = getCommitmentStore().list(p);
      respond(true, { commitments, count: commitments.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "commitment.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const commitment = getCommitmentStore().get(id);
      if (!commitment) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Commitment "${id}" not found` });
        return;
      }
      respond(true, commitment);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * §8 money surfaces — moneyExpected, moneyOwed, moneyOverdue,
   * depositsNotReceived, workProceedingWithoutPayment. Accepts the same
   * narrowing params as list() (e.g. `{ clientId }` or `{ projectId }`).
   */
  "commitment.aggregates": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as CommitmentSearchParams;
      const aggregates = getCommitmentStore().computeAggregates(p);
      respond(true, aggregates);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "commitment.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as CommitmentCreateParams;
      if (!p.name || typeof p.name !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "name is required" });
        return;
      }
      const commitment = getCommitmentStore().create(p);
      respond(true, commitment);
    } catch (e) {
      // §27 owner assertion throws a human-actionable message; surface as 400.
      const msg = String(e);
      const code = msg.includes("§27") ? "INVALID_REQUEST" : "INTERNAL_ERROR";
      respond(false, undefined, { code, message: msg });
    }
  },

  "commitment.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as CommitmentUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const commitment = getCommitmentStore().update(p);
      if (!commitment) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Commitment "${p.id}" not found` });
        return;
      }
      respond(true, commitment);
      if (p.status !== undefined) {
        if (isCommitmentSettledStatus(commitment.status)) {
          recordHqProgress({
            kind: "commitment.settled",
            objectId: commitment.id,
            title: commitment.name,
            source: "commitment",
          });
        } else {
          unrecordHqProgress("commitment.settled", commitment.id);
        }
      }
    } catch (e) {
      const msg = String(e);
      const code = msg.includes("§27") ? "INVALID_REQUEST" : "INTERNAL_ERROR";
      respond(false, undefined, { code, message: msg });
    }
  },

  "commitment.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getCommitmentStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Commitment "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export const commitmentHandlers: GatewayRequestHandlers = withHqObjectBroadcast(
  "commitment",
  rawCommitmentHandlers,
  ["commitment.create", "commitment.update", "commitment.delete"],
);
