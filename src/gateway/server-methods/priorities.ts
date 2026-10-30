/**
 * Today's Priorities gateway handlers.
 *
 * A prominent dashboard surface (web `<todays-priorities>` + mobile
 * `TodaysPriorities`) backed by ONE shared store (`src/priorities/store.ts`)
 * so both frontends stay in sync via the `priorities:changed` WS broadcast.
 *
 * The priorities list is per-user, per-day, hierarchical and orderable. Items
 * can be freestanding OR linked to the REAL task/project system: the kanban
 * store (`src/databases/kanban-store-ops.ts`) is the source of truth for tasks
 * and projects. We only reuse its read/create APIs — we never restructure it.
 *
 * Project association is MANDATORY on task creation: `priorities.createTaskAndAdd`
 * refuses to create an orphan task; the caller must pass a valid `projectId`.
 *
 * NOTE: new gateway methods require a gateway restart to be exposed to clients.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { getPrioritiesStore } from "../../priorities/store.js";
import { broadcastPrioritiesChanged } from "../../priorities/priorities-events.js";
import {
  listProjects,
  listTasks,
  getProject,
  getTask,
  upsertTask,
} from "../../databases/kanban-store-ops.js";

function userIdOf(client: { authUser?: string } | null): string {
  return client?.authUser ?? "default";
}

function todayISO(): string {
  // Local calendar day (YYYY-MM-DD). Frontends normally pass an explicit date.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const _rawPrioritiesHandlers: GatewayRequestHandlers = {
  /** All priority items for a given day (flat, ordered; frontend nests). */
  "priorities.listByDate": async ({ params, respond, client }) => {
    try {
      const { date } = (params ?? {}) as { date?: string };
      const userId = userIdOf(client);
      const d = date || todayISO();
      const items = getPrioritiesStore().listByDate(userId, d);
      respond(true, { date: d, items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Days that have priorities (for the date paginator + history nav). */
  "priorities.listDates": async ({ respond, client }) => {
    try {
      const dates = getPrioritiesStore().listDates(userIdOf(client));
      respond(true, { dates });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Add a freestanding priority item (no task link). */
  "priorities.add": async ({ params, respond, client }) => {
    try {
      const { date, title, parentId, note } = (params ?? {}) as {
        date?: string;
        title?: string;
        parentId?: string | null;
        note?: string | null;
      };
      if (!title || !title.trim()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
        return;
      }
      const userId = userIdOf(client);
      const d = date || todayISO();
      const item = getPrioritiesStore().create({
        userId,
        date: d,
        title: title.trim(),
        parentId: parentId ?? null,
        note: note ?? null,
      });
      broadcastPrioritiesChanged({ op: "create", id: item.id, date: d });
      respond(true, { item });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Add an EXISTING kanban task to today's priorities, preserving its link to
   * its task + project. Title + project are pulled from the live task.
   */
  "priorities.addExistingTask": async ({ params, respond, client }) => {
    try {
      const { date, taskId, parentId } = (params ?? {}) as {
        date?: string;
        taskId?: string;
        parentId?: string | null;
      };
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId is required" });
        return;
      }
      const task = getTask(taskId);
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Task "${taskId}" not found` });
        return;
      }
      const userId = userIdOf(client);
      const d = date || todayISO();
      const projectName = task.projectId ? (getProject(task.projectId)?.name ?? null) : null;
      const item = getPrioritiesStore().create({
        userId,
        date: d,
        title: task.title,
        parentId: parentId ?? null,
        taskId: task.id,
        projectId: task.projectId,
        projectName,
      });
      broadcastPrioritiesChanged({ op: "create", id: item.id, date: d });
      respond(true, { item, task });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Create a BRAND-NEW kanban task (project association MANDATORY) and add it
   * to today's priorities, linked. Refuses to create an orphan task.
   */
  "priorities.createTaskAndAdd": async ({ params, respond, client }) => {
    try {
      const { date, title, projectId, description, priority, parentId } = (params ?? {}) as {
        date?: string;
        title?: string;
        projectId?: string;
        description?: string;
        priority?: string;
        parentId?: string | null;
      };
      if (!title || !title.trim()) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
        return;
      }
      // Project association is MANDATORY — no orphan tasks.
      if (!projectId || !projectId.trim()) {
        respond(false, undefined, {
          code: "PROJECT_REQUIRED",
          message: "A projectId is required to create a task from priorities (no orphan tasks).",
        });
        return;
      }
      const project = getProject(projectId);
      if (!project) {
        respond(false, undefined, {
          code: "PROJECT_NOT_FOUND",
          message: `Project "${projectId}" not found`,
        });
        return;
      }
      // Create the real kanban task, correctly associated to the project.
      const task = upsertTask({
        title: title.trim(),
        projectId,
        status: "todo",
        description: description?.trim() || undefined,
        priority: priority || undefined,
      });
      const userId = userIdOf(client);
      const d = date || todayISO();
      const item = getPrioritiesStore().create({
        userId,
        date: d,
        title: task.title,
        parentId: parentId ?? null,
        taskId: task.id,
        projectId: task.projectId,
        projectName: project.name,
      });
      broadcastPrioritiesChanged({ op: "create", id: item.id, date: d });
      respond(true, { item, task, project: { id: project.id, name: project.name } });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Toggle a priority item's completed state. A plain check does NOT force the
   * linked task to "done" (non-destructive by default). Flipping the linked
   * task is a separate explicit action (`priorities.completeLinkedTask`).
   */
  "priorities.toggle": async ({ params, respond, client }) => {
    try {
      const { id, completed } = (params ?? {}) as { id?: string; completed?: boolean };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const item = getPrioritiesStore().toggle(userIdOf(client), id, completed);
      if (!item) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Item "${id}" not found` });
        return;
      }
      broadcastPrioritiesChanged({ op: "toggle", id: item.id, date: item.date });
      respond(true, { item });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Rename / edit note on a priority item. */
  "priorities.update": async ({ params, respond, client }) => {
    try {
      const { id, title, note } = (params ?? {}) as {
        id?: string;
        title?: string;
        note?: string;
      };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const item = getPrioritiesStore().update(userIdOf(client), id, { title, note });
      if (!item) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Item "${id}" not found` });
        return;
      }
      broadcastPrioritiesChanged({ op: "update", id: item.id, date: item.date });
      respond(true, { item });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Apply a full ordered hierarchy for a day (drag reorder + nesting). */
  "priorities.reorder": async ({ params, respond, client }) => {
    try {
      const { date, order } = (params ?? {}) as {
        date?: string;
        order?: Array<{ id: string; parentId?: string | null; ordinal: number }>;
      };
      if (!date || !Array.isArray(order)) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "date and order[] are required",
        });
        return;
      }
      const normalized = order.map((e) => ({
        id: e.id,
        parentId: e.parentId ?? null,
        ordinal: e.ordinal,
      }));
      const items = getPrioritiesStore().reorder(userIdOf(client), date, normalized);
      broadcastPrioritiesChanged({ op: "reorder", date });
      respond(true, { date, items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Remove an item (and its descendants). */
  "priorities.remove": async ({ params, respond, client }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const store = getPrioritiesStore();
      const userId = userIdOf(client);
      const existing = store.getById(userId, id);
      const deletedIds = store.remove(userId, id);
      if (deletedIds.length === 0) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Item "${id}" not found` });
        return;
      }
      broadcastPrioritiesChanged({ op: "delete", id, date: existing?.date });
      respond(true, { deletedIds });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Search history across all days (title + note), optional date range. */
  "priorities.search": async ({ params, respond, client }) => {
    try {
      const { query, from, to, limit } = (params ?? {}) as {
        query?: string;
        from?: string;
        to?: string;
        limit?: number;
      };
      if (!query || !query.trim()) {
        respond(true, { items: [] });
        return;
      }
      const items = getPrioritiesStore().search(
        userIdOf(client),
        query.trim(),
        { from, to },
        typeof limit === "number" ? limit : 100,
      );
      respond(true, { items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Convenience picker data for BOTH frontends: the active project list and a
   * filtered task list (for "add existing task" + "create task under project").
   * Optional { projectId, query } narrow the task list.
   */
  "priorities.pickerData": async ({ params, respond }) => {
    try {
      const { projectId, query } = (params ?? {}) as { projectId?: string; query?: string };
      const projects = listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        active: (p as { active?: boolean }).active ?? false,
      }));
      let tasks = listTasks(projectId ? { projectId } : undefined);
      if (query && query.trim()) {
        const q = query.trim().toLowerCase();
        tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
      }
      const slim = tasks.slice(0, 200).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        projectId: t.projectId,
        projectName: t.projectId ? (getProject(t.projectId)?.name ?? null) : null,
      }));
      respond(true, { projects, tasks: slim });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export const prioritiesHandlers: GatewayRequestHandlers = _rawPrioritiesHandlers;
