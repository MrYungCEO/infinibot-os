/**
 * Generic entity-relations RPC handlers.
 *
 * Wire format:
 *   relations.list   { type, id, peerType? }            → { relations: [{ type, id, createdAt }] }
 *   relations.link   { left:{type,id}, right:{type,id} } → { ok: true }
 *   relations.unlink { left:{type,id}, right:{type,id} } → { ok: true }
 *   relations.replace{ ref:{type,id}, peerType, peerIds } → { ok: true }
 *
 * Supported types are open-ended strings — current callers use
 *   "client" | "project" | "note" | "workflow".
 */

import type { GatewayRequestHandlers } from "./types.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  linkEntities,
  listRelations,
  purgeEntity,
  replaceRelations,
  unlinkEntities,
  type EntityRef,
} from "../../databases/relations-store.js";

function isRef(v: unknown): v is EntityRef {
  if (!v || typeof v !== "object") return false;
  const r = v as any;
  return (
    typeof r.type === "string" &&
    r.type.trim() !== "" &&
    typeof r.id === "string" &&
    r.id.trim() !== ""
  );
}

export const relationsHandlers: GatewayRequestHandlers = {
  "relations.list": async ({ params, respond }) => {
    try {
      const ref = isRef(params) ? params : { type: (params as any)?.type, id: (params as any)?.id };
      if (!isRef(ref)) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "type and id are required" });
        return;
      }
      const peerType =
        typeof (params as any)?.peerType === "string" ? (params as any).peerType : undefined;
      const relations = listRelations(STATE_DIR, ref, peerType);
      respond(true, { relations });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "relations.link": async ({ params, respond }) => {
    try {
      const left = (params as any)?.left;
      const right = (params as any)?.right;
      if (!isRef(left) || !isRef(right)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "left and right entity refs required",
        });
        return;
      }
      linkEntities(STATE_DIR, left, right);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "relations.unlink": async ({ params, respond }) => {
    try {
      const left = (params as any)?.left;
      const right = (params as any)?.right;
      if (!isRef(left) || !isRef(right)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "left and right entity refs required",
        });
        return;
      }
      unlinkEntities(STATE_DIR, left, right);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "relations.replace": async ({ params, respond }) => {
    try {
      const ref = (params as any)?.ref;
      const peerType = (params as any)?.peerType;
      const peerIds = (params as any)?.peerIds;
      if (!isRef(ref) || typeof peerType !== "string" || !Array.isArray(peerIds)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "ref:{type,id}, peerType:string, peerIds:string[] required",
        });
        return;
      }
      const ids = peerIds.filter(
        (x: unknown): x is string => typeof x === "string" && x.trim() !== "",
      );
      replaceRelations(STATE_DIR, ref, peerType, ids);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "relations.purge": async ({ params, respond }) => {
    try {
      const ref = isRef(params) ? params : { type: (params as any)?.type, id: (params as any)?.id };
      if (!isRef(ref)) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "type and id are required" });
        return;
      }
      purgeEntity(STATE_DIR, ref);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
