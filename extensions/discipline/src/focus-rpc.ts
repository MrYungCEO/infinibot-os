/**
 * Focus board gateway handlers (discipline.focus.*) — Discipline plugin.
 * Written under their legacy focus.* names and re-keyed below; the gateway
 * forwards focus.* to them while the plugin is on (plugin-method-aliases.ts).
 *
 * Provides programmatic control over the Focus system:
 * - List focus items
 * - Add tasks/projects to focus
 * - Remove items from focus
 * - Reorder focus items
 * - Clear all focus items
 * - Get focus status
 */

import type { GatewayRequestHandlers } from "../../../src/gateway/server-methods/types.js";
import {
  fetchProjectById,
  fetchProjectName,
  fetchTaskById,
  loadFocusStore,
  MAX_FOCUS_ITEMS,
  notionConfigured,
  saveFocusStore,
  type FocusItem,
  type FocusStore,
} from "./focus-store.js";

// ── Handlers ──────────────────────────────────
/** Served as discipline.focus.*; core aliases the legacy focus.* names. */
const legacyFocusHandlers: GatewayRequestHandlers = {
  /**
   * List all focus items
   */
  "focus.list": async ({ respond }) => {
    try {
      const store = loadFocusStore();
      respond(true, {
        items: store.items,
        count: store.items.length,
        maxItems: MAX_FOCUS_ITEMS,
        availableSlots: MAX_FOCUS_ITEMS - store.items.length,
        updatedAt: store.updatedAt,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get focus status summary
   */
  "focus.status": async ({ respond }) => {
    try {
      const store = loadFocusStore();
      respond(true, {
        count: store.items.length,
        maxItems: MAX_FOCUS_ITEMS,
        availableSlots: MAX_FOCUS_ITEMS - store.items.length,
        isFull: store.items.length >= MAX_FOCUS_ITEMS,
        isEmpty: store.items.length === 0,
        items: store.items.map((i) => ({
          id: i.id,
          type: i.type,
          title: i.title,
          priority: i.priority,
        })),
        updatedAt: store.updatedAt,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Add a task to focus
   */
  "focus.add.task": async ({ params, respond }) => {
    try {
      const { taskId, position, title: givenTitle } = params as {
        taskId: string;
        position?: number;
        title?: string;
      };
      if (!taskId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "taskId is required" });
        return;
      }

      const store = loadFocusStore();

      if (store.items.some((i) => i.id === taskId)) {
        respond(false, undefined, { code: "ALREADY_EXISTS", message: "Task is already in focus" });
        return;
      }

      if (store.items.length >= MAX_FOCUS_ITEMS) {
        respond(false, undefined, {
          code: "LIMIT_REACHED",
          message: `Focus is full (max ${MAX_FOCUS_ITEMS} items)`,
        });
        return;
      }

      // Lookup is local-first; if Notion is unreachable we still add the
      // item (with whatever title we were given) and let focus.sync fill in
      // details later — Notion being down must never block focus.
      let task: Awaited<ReturnType<typeof fetchTaskById>>;
      try {
        task = await fetchTaskById(taskId);
      } catch {
        task = { title: givenTitle?.trim() || "Untitled task", description: "", status: "" };
      }
      if (!task) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Task not found" });
        return;
      }

      const projectName = task.projectId ? await fetchProjectName(task.projectId) : undefined;

      const newItem: FocusItem = {
        id: taskId,
        type: "task",
        title: task.title,
        description: task.description,
        status: task.status,
        priority: store.items.length + 1,
        projectName,
        projectId: task.projectId,
        addedAt: Date.now(),
      };

      if (position && position >= 1 && position <= store.items.length + 1) {
        store.items.splice(position - 1, 0, newItem);
        store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      } else {
        store.items.push(newItem);
      }

      saveFocusStore(store);

      respond(true, {
        success: true,
        item: newItem,
        count: store.items.length,
        availableSlots: MAX_FOCUS_ITEMS - store.items.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Add a project to focus
   */
  "focus.add.project": async ({ params, respond }) => {
    try {
      const { projectId, position, title: givenTitle } = params as {
        projectId: string;
        position?: number;
        title?: string;
      };
      if (!projectId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "projectId is required" });
        return;
      }

      const store = loadFocusStore();

      if (store.items.some((i) => i.id === projectId)) {
        respond(false, undefined, {
          code: "ALREADY_EXISTS",
          message: "Project is already in focus",
        });
        return;
      }

      if (store.items.length >= MAX_FOCUS_ITEMS) {
        respond(false, undefined, {
          code: "LIMIT_REACHED",
          message: `Focus is full (max ${MAX_FOCUS_ITEMS} items)`,
        });
        return;
      }

      let project: Awaited<ReturnType<typeof fetchProjectById>>;
      try {
        project = await fetchProjectById(projectId);
      } catch {
        project = { name: givenTitle?.trim() || "Untitled project", description: "", status: "" };
      }
      if (!project) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Project not found" });
        return;
      }

      const newItem: FocusItem = {
        id: projectId,
        type: "project",
        title: project.name,
        description: project.description,
        status: project.status,
        priority: store.items.length + 1,
        addedAt: Date.now(),
      };

      if (position && position >= 1 && position <= store.items.length + 1) {
        store.items.splice(position - 1, 0, newItem);
        store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      } else {
        store.items.push(newItem);
      }

      saveFocusStore(store);

      respond(true, {
        success: true,
        item: newItem,
        count: store.items.length,
        availableSlots: MAX_FOCUS_ITEMS - store.items.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Remove an item from focus
   */
  "focus.remove": async ({ params, respond }) => {
    try {
      const { itemId } = params as { itemId: string };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }

      const store = loadFocusStore();
      const index = store.items.findIndex((i) => i.id === itemId);

      if (index === -1) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Item not found in focus" });
        return;
      }

      const removed = store.items.splice(index, 1)[0];
      store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      saveFocusStore(store);

      respond(true, {
        success: true,
        removed,
        count: store.items.length,
        availableSlots: MAX_FOCUS_ITEMS - store.items.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Reorder focus items
   */
  "focus.reorder": async ({ params, respond }) => {
    try {
      const { itemId, newPosition } = params as { itemId: string; newPosition: number };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }
      if (!newPosition || newPosition < 1 || newPosition > MAX_FOCUS_ITEMS) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: `newPosition must be between 1 and ${MAX_FOCUS_ITEMS}`,
        });
        return;
      }

      const store = loadFocusStore();
      const currentIndex = store.items.findIndex((i) => i.id === itemId);

      if (currentIndex === -1) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Item not found in focus" });
        return;
      }

      const newIndex = Math.min(newPosition - 1, store.items.length - 1);

      if (currentIndex === newIndex) {
        respond(true, { success: true, items: store.items, message: "No change needed" });
        return;
      }

      const [item] = store.items.splice(currentIndex, 1);
      store.items.splice(newIndex, 0, item);
      store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      saveFocusStore(store);

      respond(true, {
        success: true,
        items: store.items,
        movedItem: store.items[newIndex],
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Move item up in focus
   */
  "focus.moveUp": async ({ params, respond }) => {
    try {
      const { itemId } = params as { itemId: string };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }

      const store = loadFocusStore();
      const currentIndex = store.items.findIndex((i) => i.id === itemId);

      if (currentIndex === -1) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Item not found in focus" });
        return;
      }
      if (currentIndex === 0) {
        respond(true, { success: true, items: store.items, message: "Already at top" });
        return;
      }

      [store.items[currentIndex - 1], store.items[currentIndex]] = [
        store.items[currentIndex],
        store.items[currentIndex - 1],
      ];
      store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      saveFocusStore(store);

      respond(true, { success: true, items: store.items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Move item down in focus
   */
  "focus.moveDown": async ({ params, respond }) => {
    try {
      const { itemId } = params as { itemId: string };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }

      const store = loadFocusStore();
      const currentIndex = store.items.findIndex((i) => i.id === itemId);

      if (currentIndex === -1) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Item not found in focus" });
        return;
      }
      if (currentIndex === store.items.length - 1) {
        respond(true, { success: true, items: store.items, message: "Already at bottom" });
        return;
      }

      [store.items[currentIndex], store.items[currentIndex + 1]] = [
        store.items[currentIndex + 1],
        store.items[currentIndex],
      ];
      store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
      saveFocusStore(store);

      respond(true, { success: true, items: store.items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Clear all focus items
   */
  "focus.clear": async ({ respond }) => {
    try {
      const store = loadFocusStore();
      const clearedCount = store.items.length;
      store.items = [];
      saveFocusStore(store);

      respond(true, {
        success: true,
        clearedCount,
        message: `Cleared ${clearedCount} item(s) from focus`,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Sync focus items with Notion
   */
  "focus.sync": async ({ respond }) => {
    try {
      const store = loadFocusStore();
      if (!notionConfigured()) {
        respond(true, {
          success: true,
          updated: 0,
          removed: 0,
          items: store.items,
          skipped: "notion-not-configured",
        });
        return;
      }
      let updated = 0;
      let removed = 0;

      const updatedItems: FocusItem[] = [];

      for (const item of store.items) {
        try {
          if (item.type === "task") {
            const task = await fetchTaskById(item.id);
            if (task) {
              const projectName = task.projectId
                ? await fetchProjectName(task.projectId)
                : undefined;
              updatedItems.push({
                ...item,
                title: task.title,
                description: task.description,
                status: task.status,
                projectName,
                projectId: task.projectId,
              });
              updated++;
            } else {
              removed++;
            }
          } else {
            const project = await fetchProjectById(item.id);
            if (project) {
              updatedItems.push({
                ...item,
                title: project.name,
                description: project.description,
                status: project.status,
              });
              updated++;
            } else {
              removed++;
            }
          }
        } catch (e) {
          updatedItems.push(item);
        }
      }

      store.items = updatedItems.map((item, idx) => ({ ...item, priority: idx + 1 }));
      saveFocusStore(store);

      respond(true, {
        success: true,
        updated,
        removed,
        items: store.items,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Get a specific focus item
   */
  "focus.get": async ({ params, respond }) => {
    try {
      const { itemId } = params as { itemId: string };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }

      const store = loadFocusStore();
      const item = store.items.find((i) => i.id === itemId);

      respond(true, { found: !!item, item: item || null });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Check if an item is in focus
   */
  "focus.contains": async ({ params, respond }) => {
    try {
      const { itemId } = params as { itemId: string };
      if (!itemId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "itemId is required" });
        return;
      }

      const store = loadFocusStore();
      const item = store.items.find((i) => i.id === itemId);

      respond(true, {
        inFocus: !!item,
        position: item?.priority || null,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Set focus items directly (replace all)
   */
  "focus.set": async ({ params, respond }) => {
    try {
      const { items } = params as {
        items: Array<{
          id: string;
          type: "task" | "project";
          title?: string;
          description?: string;
          status?: string;
          projectName?: string;
          projectId?: string;
          addedAt?: number;
        }>;
      };
      if (!Array.isArray(items)) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "items must be an array" });
        return;
      }
      if (items.length > MAX_FOCUS_ITEMS) {
        respond(false, undefined, {
          code: "LIMIT_REACHED",
          message: `Maximum ${MAX_FOCUS_ITEMS} items allowed`,
        });
        return;
      }

      const store: FocusStore = { items: [], updatedAt: Date.now() };

      for (let i = 0; i < items.length; i++) {
        const { id, type } = items[i];
        if (!id || (type !== "task" && type !== "project")) continue;

        // Items that arrive with a title (the control UI mirrors its board)
        // are stored as given; bare ids are resolved from Notion.
        const given = items[i];
        if (typeof given.title === "string" && given.title.trim()) {
          store.items.push({
            id,
            type,
            title: given.title.slice(0, 500),
            description: given.description?.slice(0, 2000),
            status: given.status,
            priority: i + 1,
            projectName: given.projectName,
            projectId: given.projectId,
            addedAt: typeof given.addedAt === "number" ? given.addedAt : Date.now(),
          });
          continue;
        }

        try {
          if (type === "task") {
            const task = await fetchTaskById(id);
            if (task) {
              const projectName = task.projectId
                ? await fetchProjectName(task.projectId)
                : undefined;
              store.items.push({
                id,
                type: "task",
                title: task.title,
                description: task.description,
                status: task.status,
                priority: i + 1,
                projectName,
                projectId: task.projectId,
                addedAt: Date.now(),
              });
            }
          } else {
            const project = await fetchProjectById(id);
            if (project) {
              store.items.push({
                id,
                type: "project",
                title: project.name,
                description: project.description,
                status: project.status,
                priority: i + 1,
                addedAt: Date.now(),
              });
            }
          }
        } catch (e) {
          // Lookup unavailable (Notion down) — keep the item as a
          // placeholder rather than silently dropping it.
          console.warn(`[Focus] Lookup unavailable for ${id}, keeping placeholder:`, e);
          store.items.push({
            id,
            type: type === "project" ? "project" : "task",
            title: type === "project" ? "Untitled project" : "Untitled task",
            description: "",
            status: "",
            priority: i + 1,
            addedAt: Date.now(),
          });
        }
      }

      saveFocusStore(store);

      respond(true, {
        success: true,
        items: store.items,
        count: store.items.length,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export function createFocusHandlers(): GatewayRequestHandlers {
  return Object.fromEntries(
    Object.entries(legacyFocusHandlers).map(([method, handler]) => [
      method.replace(/^focus\./, "discipline.focus."),
      handler,
    ]),
  );
}
