/**
 * Gateway RPC handlers for People / Resources (K.I.S. Object 9).
 *
 * Thin wrappers over the SQLite-backed `PersonStore` (src/person/store.ts).
 * Mirrors the issues handlers: each method validates params, calls the store,
 * and reports through `respond(ok, data, error?)`.
 *
 * Cross-object links go through the typed-edge relations store; `person.workload`
 * derives capacity from those edges (workload is DERIVED, not stored). Significant
 * actions (create / assign) are written to the append-only audit log (§33).
 *
 * NOTE: this is the *business* People/Resources object — the humans who do the
 * work — NOT the AI agent roster. Keep them distinct.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getPersonStore } from "../../person/store.js";
import { getAuditStore } from "../../business-objects/audit.js";
import type {
  PersonCreateParams,
  PersonSearchParams,
  PersonUpdateParams,
} from "../../person/types.js";

export const personHandlers: GatewayRequestHandlers = {
  "person.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as PersonSearchParams;
      const people = getPersonStore().list(p);
      respond(true, { people, count: people.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "person.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as PersonSearchParams;
      const people = getPersonStore().list(p);
      respond(true, { people, count: people.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "person.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const person = getPersonStore().get(id);
      if (!person) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Person "${id}" not found` });
        return;
      }
      respond(true, person);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "person.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as PersonCreateParams;
      if (!p.name || typeof p.name !== "string" || !p.name.trim()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "name is required" });
        return;
      }
      const store = getPersonStore();
      // §4 create-once dedup: reuse the existing record for a known name.
      const existing = store.findByName(p.name);
      if (existing) {
        respond(true, existing);
        return;
      }
      const person = store.create(p);
      try {
        getAuditStore().log({
          what: `Created person/resource "${person.name}" (${person.relationshipType})`,
          trigger: "person.create",
          agent: p.owner || "person-agent",
          objectType: "person",
          objectId: person.id,
          action: "create",
          outcome: "created",
          meta: { dataQuality: person.dataQuality },
        });
      } catch {
        /* audit is best-effort — never fail the write on a log error */
      }
      respond(true, person);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "person.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as PersonUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const person = getPersonStore().update(p);
      if (!person) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Person "${p.id}" not found` });
        return;
      }
      respond(true, person);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "person.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getPersonStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Person "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Derived capacity for a person — counts of linked Tasks / Projects /
   * Decisions / Risks / System Issues from the relations store, plus the active
   * task subset. This is the foundation for later capacity planning.
   */
  "person.workload": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const store = getPersonStore();
      if (!store.get(id)) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Person "${id}" not found` });
        return;
      }
      respond(true, store.workloadFor(id));
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Assign a task to a person — creates the task_assigned_to_person edge. */
  "person.assignTask": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        personId?: string;
        taskId?: string;
        status?: string;
        createdBy?: string;
      };
      if (!p.personId || !p.taskId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "personId and taskId are required",
        });
        return;
      }
      const store = getPersonStore();
      const person = store.get(p.personId);
      if (!person) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Person "${p.personId}" not found` });
        return;
      }
      const rel = store.assignTask(p.personId, p.taskId, {
        createdBy: p.createdBy,
        status: p.status,
      });
      try {
        getAuditStore().log({
          what: `Assigned task ${p.taskId} to ${person.name}`,
          trigger: "person.assignTask",
          agent: p.createdBy || "person-agent",
          objectType: "person",
          objectId: p.personId,
          action: "assign_task",
          outcome: "linked",
          meta: { taskId: p.taskId },
        });
      } catch {
        /* best-effort */
      }
      respond(true, rel);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Unassign a task from a person — removes the task_assigned_to_person edge. */
  "person.unassignTask": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { personId?: string; taskId?: string };
      if (!p.personId || !p.taskId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "personId and taskId are required",
        });
        return;
      }
      const deleted = getPersonStore().unassignTask(p.personId, p.taskId);
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
