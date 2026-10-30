/**
 * Gateway RPC handlers for the append-only Audit Log (spec §33).
 *
 * Thin wrappers over the SQLite-backed `AuditStore`
 * (src/business-objects/audit.ts). The log is append-only by design: there is
 * a write (`audit.log`) and reads (`audit.list` / `audit.get`), but no update
 * or delete method.
 *
 *   audit.log  (write) — append one significant-action entry
 *   audit.list (read)  — read the ledger newest-first, optional filter
 *   audit.get  (read)  — fetch one entry by id
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getAuditStore } from "../../business-objects/audit.js";
import type { AuditLogParams, AuditQuery } from "../../business-objects/audit.js";

export const auditHandlers: GatewayRequestHandlers = {
  "audit.log": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as AuditLogParams;
      if (!p.what || typeof p.what !== "string") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "what is required (a short description of the action)",
        });
        return;
      }
      const entry = getAuditStore().log(p);
      respond(true, entry);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "audit.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as AuditQuery;
      const entries = getAuditStore().list(p);
      respond(true, { entries, count: entries.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "audit.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const entry = getAuditStore().get(id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Audit entry "${id}" not found` });
        return;
      }
      respond(true, entry);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
