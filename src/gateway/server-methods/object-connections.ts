/**
 * Gateway RPCs for the resolved relation graph — the read side that makes a
 * focus page's Connections panel possible.
 *
 * `objrel.graph` / `objrel.list` return bare `{ type, id }` nodes. Rendering a
 * navigable card per connection needs names, statuses and enough properties to
 * show a preview, which means reading whichever store owns each neighbor type.
 * That resolution lives in `src/relations/resolve.ts`; these handlers are thin
 * wrappers over it.
 *
 *   objrel.connections (read) — the resolved depth-1 neighborhood, grouped by
 *                               neighbor type. Powers the Connections panel.
 *   objrel.object      (read) — one resolved object by (type, id). Powers the
 *                               generic focus page a user drills into.
 *
 * Both are additive and read-only; nothing here mutates the relation store.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { connectionsFor, resolveObject, resolveObjects } from "../../relations/resolve.js";

export const objectConnectionHandlers: GatewayRequestHandlers = {
  "objrel.connections": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { type?: string; id?: string; inferOrigins?: boolean };
      if (!p.type || !p.id) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "type and id are required",
        });
        return;
      }
      // Origin inference is on by default: a client profile is exactly where
      // "where did this come from?" needs answering, and the caller shouldn't
      // have to know the lead stores keep their link implicitly.
      const result = await connectionsFor(p.type, p.id, {
        inferOrigins: p.inferOrigins !== false,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "objrel.object": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        type?: string;
        id?: string;
        refs?: Array<{ type: string; id: string }>;
      };
      // Batch form: resolve many refs in one round-trip (breadcrumb labels).
      if (Array.isArray(p.refs)) {
        const objects = await resolveObjects(p.refs.slice(0, 200));
        respond(true, { objects });
        return;
      }
      if (!p.type || !p.id) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "type and id (or refs[]) are required",
        });
        return;
      }
      respond(true, { object: await resolveObject(p.type, p.id) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
