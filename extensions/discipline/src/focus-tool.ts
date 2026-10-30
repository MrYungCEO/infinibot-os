/**
 * Focus Agent Tool
 *
 * Provides MCP control over the Focus priority board. Registered by the
 * Discipline plugin into core's `focus` tool slot.
 * Agents can use this to manage their focus queue programmatically.
 */

import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam, stringEnum } from "infinibot/plugin-sdk";
import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import {
  fetchProjectById,
  fetchTaskById,
  loadFocusStore,
  MAX_FOCUS_ITEMS,
  notionConfigured,
  saveFocusStore,
  type FocusItem,
} from "./focus-store.js";

type ToolLog = { info: (m: string) => void; error: (m: string, e?: unknown) => void };
let log: ToolLog = { info: () => {}, error: () => {} };

// ── Tool Schema ──────────────────────────────────
const FocusToolSchema = Type.Object({
  action: stringEnum([
    "list",
    "status",
    "add_task",
    "add_project",
    "remove",
    "reorder",
    "move_up",
    "move_down",
    "clear",
    "sync",
    "get",
    "contains",
  ]),
  taskId: Type.Optional(Type.String({ description: "Notion task page ID (for add_task)" })),
  projectId: Type.Optional(
    Type.String({ description: "Notion project page ID (for add_project)" }),
  ),
  itemId: Type.Optional(Type.String({ description: "Focus item ID to operate on" })),
  position: Type.Optional(Type.Number({ description: "New position (1-5) for reorder" })),
});

export function createFocusTool(logger?: {
  info: (m: string) => void;
  warn: (m: string) => void;
}): AnyAgentTool {
  if (logger) log = { info: logger.info, error: (m, e) => logger.warn(`${m} ${String(e ?? "")}`) };
  return {
    label: "Focus",
    name: "focus",
    description: `Manage the Focus priority board — a list of up to 5 high-priority tasks or projects for laser-focused execution.

**Actions:**
- **list**: List all items currently in focus (shows priority order, titles, statuses)
- **status**: Get focus status summary (count, available slots, is full/empty)
- **add_task**: Add a task to focus by its Notion ID (taskId parameter)
- **add_project**: Add a project to focus by its Notion ID (projectId parameter)
- **remove**: Remove an item from focus (itemId parameter)
- **reorder**: Move an item to a new position 1-5 (itemId + position parameters)
- **move_up**: Move an item up one position (itemId parameter)
- **move_down**: Move an item down one position (itemId parameter)
- **clear**: Clear all focus items
- **sync**: Refresh focus items from Notion (updates titles, statuses)
- **get**: Get a specific focus item by ID (itemId parameter)
- **contains**: Check if an item is in focus (itemId parameter)

**Use this to:**
- Track your top priorities during autonomous work
- Set focus before starting a work session
- Clear focus when switching contexts
- Check what's currently prioritized`,

    parameters: FocusToolSchema,

    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      try {
        switch (action) {
          case "list": {
            const store = loadFocusStore();
            return jsonResult({
              items: store.items,
              count: store.items.length,
              maxItems: MAX_FOCUS_ITEMS,
              availableSlots: MAX_FOCUS_ITEMS - store.items.length,
            });
          }

          case "status": {
            const store = loadFocusStore();
            return jsonResult({
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
            });
          }

          case "add_task": {
            const taskId = readStringParam(params, "taskId");
            if (!taskId) return jsonResult({ error: "taskId is required for add_task" });

            const store = loadFocusStore();
            if (store.items.some((i) => i.id === taskId)) {
              return jsonResult({ error: "Task is already in focus" });
            }
            if (store.items.length >= MAX_FOCUS_ITEMS) {
              return jsonResult({ error: `Focus is full (max ${MAX_FOCUS_ITEMS} items)` });
            }

            // Local-first lookup; if Notion is unreachable, still add it.
            const task = await fetchTaskById(taskId).catch(() => ({
              title: readStringParam(params, "title") || "Untitled task",
              description: "",
              status: "",
              projectId: undefined as string | undefined,
            }));
            if (!task) return jsonResult({ error: "Task not found" });

            const projectName = task.projectId
              ? (await fetchProjectById(task.projectId).catch(() => null))?.name
              : undefined;
            const position = readNumberParam(params, "position", { integer: true });

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

            log.info(`Added task ${taskId} to focus at position ${newItem.priority}`);
            return jsonResult({
              success: true,
              item: newItem,
              count: store.items.length,
              availableSlots: MAX_FOCUS_ITEMS - store.items.length,
            });
          }

          case "add_project": {
            const projectId = readStringParam(params, "projectId");
            if (!projectId) return jsonResult({ error: "projectId is required for add_project" });

            const store = loadFocusStore();
            if (store.items.some((i) => i.id === projectId)) {
              return jsonResult({ error: "Project is already in focus" });
            }
            if (store.items.length >= MAX_FOCUS_ITEMS) {
              return jsonResult({ error: `Focus is full (max ${MAX_FOCUS_ITEMS} items)` });
            }

            const project = await fetchProjectById(projectId).catch(() => ({
              name: readStringParam(params, "title") || "Untitled project",
              description: "",
              status: "",
            }));
            if (!project) return jsonResult({ error: "Project not found" });

            const position = readNumberParam(params, "position", { integer: true });

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

            log.info(`Added project ${projectId} to focus at position ${newItem.priority}`);
            return jsonResult({
              success: true,
              item: newItem,
              count: store.items.length,
              availableSlots: MAX_FOCUS_ITEMS - store.items.length,
            });
          }

          case "remove": {
            const itemId = readStringParam(params, "itemId");
            if (!itemId) return jsonResult({ error: "itemId is required for remove" });

            const store = loadFocusStore();
            const index = store.items.findIndex((i) => i.id === itemId);
            if (index === -1) return jsonResult({ error: "Item not found in focus" });

            const removed = store.items.splice(index, 1)[0];
            store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
            saveFocusStore(store);

            log.info(`Removed item ${itemId} from focus`);
            return jsonResult({
              success: true,
              removed,
              count: store.items.length,
              availableSlots: MAX_FOCUS_ITEMS - store.items.length,
            });
          }

          case "reorder": {
            const itemId = readStringParam(params, "itemId");
            const position = readNumberParam(params, "position", { integer: true });
            if (!itemId) return jsonResult({ error: "itemId is required for reorder" });
            if (!position) return jsonResult({ error: "position is required for reorder" });

            const store = loadFocusStore();
            const currentIndex = store.items.findIndex((i) => i.id === itemId);
            if (currentIndex === -1) return jsonResult({ error: "Item not found in focus" });

            const newIndex = Math.min(position - 1, store.items.length - 1);
            if (currentIndex === newIndex) {
              return jsonResult({ success: true, items: store.items, message: "No change needed" });
            }

            const [item] = store.items.splice(currentIndex, 1);
            store.items.splice(newIndex, 0, item);
            store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
            saveFocusStore(store);

            log.info(`Reordered item ${itemId} to position ${position}`);
            return jsonResult({
              success: true,
              items: store.items,
              movedItem: store.items[newIndex],
            });
          }

          case "move_up": {
            const itemId = readStringParam(params, "itemId");
            if (!itemId) return jsonResult({ error: "itemId is required for move_up" });

            const store = loadFocusStore();
            const currentIndex = store.items.findIndex((i) => i.id === itemId);
            if (currentIndex === -1) return jsonResult({ error: "Item not found in focus" });
            if (currentIndex === 0)
              return jsonResult({ success: true, items: store.items, message: "Already at top" });

            [store.items[currentIndex - 1], store.items[currentIndex]] = [
              store.items[currentIndex],
              store.items[currentIndex - 1],
            ];
            store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
            saveFocusStore(store);

            log.info(`Moved item ${itemId} up`);
            return jsonResult({ success: true, items: store.items });
          }

          case "move_down": {
            const itemId = readStringParam(params, "itemId");
            if (!itemId) return jsonResult({ error: "itemId is required for move_down" });

            const store = loadFocusStore();
            const currentIndex = store.items.findIndex((i) => i.id === itemId);
            if (currentIndex === -1) return jsonResult({ error: "Item not found in focus" });
            if (currentIndex === store.items.length - 1) {
              return jsonResult({
                success: true,
                items: store.items,
                message: "Already at bottom",
              });
            }

            [store.items[currentIndex], store.items[currentIndex + 1]] = [
              store.items[currentIndex + 1],
              store.items[currentIndex],
            ];
            store.items = store.items.map((item, idx) => ({ ...item, priority: idx + 1 }));
            saveFocusStore(store);

            log.info(`Moved item ${itemId} down`);
            return jsonResult({ success: true, items: store.items });
          }

          case "clear": {
            const store = loadFocusStore();
            const clearedCount = store.items.length;
            store.items = [];
            saveFocusStore(store);

            log.info(`Cleared ${clearedCount} items from focus`);
            return jsonResult({
              success: true,
              clearedCount,
              message: `Cleared ${clearedCount} item(s) from focus`,
            });
          }

          case "sync": {
            const store = loadFocusStore();
            if (!notionConfigured()) {
              return jsonResult({
                success: true,
                updated: 0,
                removed: 0,
                items: store.items,
                skipped: "notion-not-configured",
              });
            }
            let updated = 0;
            let removed = 0;
            const updatedItems: FocusItem[] = [];

            for (const item of store.items) {
              // A lookup that throws means "unknown" (Notion down) — keep the
              // item untouched. Only a definite "not found" removes it.
              let task: Awaited<ReturnType<typeof fetchTaskById>> = null;
              let project: Awaited<ReturnType<typeof fetchProjectById>> = null;
              try {
                if (item.type === "task") task = await fetchTaskById(item.id);
                else project = await fetchProjectById(item.id);
              } catch {
                updatedItems.push(item);
                continue;
              }
              if (item.type === "task") {
                if (task) {
                  const projectName = task.projectId
                    ? (await fetchProjectById(task.projectId).catch(() => null))?.name
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
            }

            store.items = updatedItems.map((item, idx) => ({ ...item, priority: idx + 1 }));
            saveFocusStore(store);

            log.info(`Synced focus: ${updated} updated, ${removed} removed`);
            return jsonResult({ success: true, updated, removed, items: store.items });
          }

          case "get": {
            const itemId = readStringParam(params, "itemId");
            if (!itemId) return jsonResult({ error: "itemId is required for get" });

            const store = loadFocusStore();
            const item = store.items.find((i) => i.id === itemId);
            return jsonResult({ found: !!item, item: item || null });
          }

          case "contains": {
            const itemId = readStringParam(params, "itemId");
            if (!itemId) return jsonResult({ error: "itemId is required for contains" });

            const store = loadFocusStore();
            const item = store.items.find((i) => i.id === itemId);
            return jsonResult({ inFocus: !!item, position: item?.priority || null });
          }

          default:
            return jsonResult({ error: `Unknown action: ${action}` });
        }
      } catch (err: any) {
        log.error(`Focus tool error (${action}):`, err);
        return jsonResult({ error: err.message || String(err), action });
      }
    },
  };
}
