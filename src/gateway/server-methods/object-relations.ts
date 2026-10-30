/**
 * Gateway RPC handlers for the typed-edge business-object relations layer
 * (spec §4/§14). Thin wrappers over the SQLite-backed `RelationsStore`
 * (src/relations/store.ts).
 *
 * NAMESPACE NOTE: these are exposed under `objrel.*`, NOT `relations.*`. A
 * distinct, pre-existing generic entity-link system already owns the
 * `relations.*` namespace (src/gateway/server-methods/relations.ts +
 * src/databases/relations-store.ts) with different, untyped/symmetric
 * semantics and live callers (business.ts, kanban.ts). This layer is the
 * directional, typed-edge graph the ten Phase 1 objects connect through, so it
 * gets its own namespace to keep both contracts stable.
 *
 *   objrel.link   (write) — create a directed typed edge between two objects
 *   objrel.unlink (write) — remove an edge by id or by (from,edge,to) match
 *   objrel.list   (read)  — list edges (by endpoint or generic filter)
 *   objrel.graph  (read)  — the connected neighborhood around an object
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getRelationsStore } from "../../relations/store.js";
import type {
  RelationCreateParams,
  RelationMatch,
  RelationQuery,
} from "../../relations/types.js";

export const objectRelationHandlers: GatewayRequestHandlers = {
  "objrel.link": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as RelationCreateParams;
      if (!p.fromType || !p.fromId || !p.toType || !p.toId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "fromType, fromId, toType and toId are required",
        });
        return;
      }
      const rel = getRelationsStore().create(p);
      respond(true, rel);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "objrel.unlink": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { id?: string } & RelationMatch;
      if (p.id) {
        const ok = getRelationsStore().delete(p.id);
        if (!ok) {
          respond(false, undefined, {
            code: "NOT_FOUND",
            message: `Relation "${p.id}" not found`,
          });
          return;
        }
        respond(true, { deleted: 1, id: p.id });
        return;
      }
      const match: RelationMatch = {
        fromType: p.fromType,
        fromId: p.fromId,
        edge: p.edge,
        toType: p.toType,
        toId: p.toId,
      };
      const hasAny = Object.values(match).some((v) => v != null && v !== "");
      if (!hasAny) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "provide an id, or at least one of fromType/fromId/edge/toType/toId",
        });
        return;
      }
      const deleted = getRelationsStore().deleteMatch(match);
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "objrel.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as RelationQuery & {
        type?: string;
        id?: string;
        direction?: string;
      };
      const store = getRelationsStore();
      // Endpoint shorthand: {type, id, direction?} lists links around one object.
      if (p.type && p.id && !p.fromType && !p.toType) {
        const dir = String(p.direction ?? "both");
        const relations =
          dir === "from"
            ? store.linksFrom(p.type, p.id)
            : dir === "to"
              ? store.linksTo(p.type, p.id)
              : store.linksAround(p.type, p.id);
        respond(true, { relations, count: relations.length });
        return;
      }
      const relations = store.list(p);
      respond(true, { relations, count: relations.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "objrel.graph": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { type?: string; id?: string; maxDepth?: number };
      if (!p.type || !p.id) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "type and id are required",
        });
        return;
      }
      const maxDepth =
        typeof p.maxDepth === "number" && p.maxDepth > 0 ? Math.min(p.maxDepth, 12) : 3;
      const graph = getRelationsStore().graphFor(p.type, p.id, maxDepth);
      respond(true, graph);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
