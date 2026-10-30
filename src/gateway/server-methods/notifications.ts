import { getNotificationHistoryStore } from "../../notifications/history-store.js";
import { emitNotification } from "../../notifications/emit.js";
import { STATE_DIR } from "../../config/paths.js";
import type { GatewayRequestHandlers } from "./types.js";
import type {
  NotificationCategory,
  NotificationSeverity,
} from "../../notifications/history-store.js";

const getStore = () => getNotificationHistoryStore(STATE_DIR);

export const notificationHandlers: GatewayRequestHandlers = {
  // ── History ──────────────────────────────────────────────────────────────

  "notifications.history.list": async ({ params, respond }) => {
    try {
      const limit = typeof params.limit === "number" ? Math.min(params.limit, 200) : 50;
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const rawFilters = params.filters as Record<string, unknown> | undefined;

      const result = getStore().list({
        limit,
        cursor,
        filters: rawFilters
          ? {
              categories: Array.isArray(rawFilters.categories)
                ? (rawFilters.categories as NotificationCategory[])
                : undefined,
              severities: Array.isArray(rawFilters.severities)
                ? (rawFilters.severities as NotificationSeverity[])
                : undefined,
              sources: Array.isArray(rawFilters.sources)
                ? (rawFilters.sources as string[])
                : undefined,
              unreadOnly:
                typeof rawFilters.unreadOnly === "boolean" ? rawFilters.unreadOnly : undefined,
              text: typeof rawFilters.text === "string" ? rawFilters.text : undefined,
              fromTs: typeof rawFilters.fromTs === "number" ? rawFilters.fromTs : undefined,
              toTs: typeof rawFilters.toTs === "number" ? rawFilters.toTs : undefined,
              token: typeof rawFilters.token === "string" ? rawFilters.token : undefined,
            }
          : undefined,
      });

      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.get": async ({ params, respond }) => {
    try {
      const id = typeof params.id === "string" ? params.id : "";
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const entry = getStore().get(id);
      if (!entry) {
        respond(false, undefined, { code: "NOT_FOUND", message: "notification not found" });
        return;
      }
      respond(true, entry);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.markRead": async ({ params, respond }) => {
    try {
      const token = typeof params.token === "string" ? params.token : "_default_";
      const store = getStore();
      if (params.all === true) {
        const changed = store.markAllRead(token);
        respond(true, { ok: true, changed });
        return;
      }
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      store.markRead(ids, token);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.markUnread": async ({ params, respond }) => {
    try {
      const token = typeof params.token === "string" ? params.token : "_default_";
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      getStore().markUnread(ids, token);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.dismiss": async ({ params, respond }) => {
    try {
      const token = typeof params.token === "string" ? params.token : "_default_";
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      getStore().dismiss(ids, token);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.ack": async ({ params, respond }) => {
    try {
      const token = typeof params.token === "string" ? params.token : "_default_";
      const ids = Array.isArray(params.ids) ? (params.ids as string[]) : [];
      getStore().ack(ids, token);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.snooze": async ({ params, respond }) => {
    try {
      const id = typeof params.id === "string" ? params.id : "";
      const until = typeof params.until === "number" ? params.until : 0;
      if (!id || !until) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id and until required" });
        return;
      }
      getStore().snooze(id, until);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.unreadCount": async ({ params, respond }) => {
    try {
      const token = typeof params.token === "string" ? params.token : "_default_";
      const count = getStore().unreadCount(token);
      respond(true, { count });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.byCategorySummary": async ({ params, respond }) => {
    try {
      const period = (params.period as "day" | "week" | "month") ?? "day";
      const token = typeof params.token === "string" ? params.token : undefined;
      const summary = getStore().byCategorySummary(period, token);
      respond(true, { summary });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.history.related": async ({ params, respond }) => {
    try {
      const sourceId = typeof params.sourceId === "string" ? params.sourceId : "";
      if (!sourceId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "sourceId required" });
        return;
      }
      const items = getStore().findBySourceId(sourceId);
      respond(true, { items });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Preferences ──────────────────────────────────────────────────────────

  "notifications.preferences.get": async ({ respond }) => {
    try {
      const prefs = getStore().getPreferences();
      respond(true, prefs);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "notifications.preferences.set": async ({ params, respond }) => {
    try {
      const prefs =
        params.prefs as import("../../notifications/history-store.js").NotificationPreferences;
      if (!prefs || typeof prefs !== "object") {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "prefs object required" });
        return;
      }
      getStore().setPreferences(prefs as any);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Test (admin) ─────────────────────────────────────────────────────────

  "notifications.test": async ({ params, respond }) => {
    try {
      const category = (
        typeof params.category === "string" ? params.category : "manual"
      ) as NotificationCategory;
      const severity = (
        typeof params.severity === "string" ? params.severity : "info"
      ) as NotificationSeverity;
      const id = await emitNotification({
        category,
        severity,
        title: `Test: ${category}`,
        body: `This is a test ${severity} notification for category "${category}".`,
        source: "system",
        data: { test: true, ts: Date.now() },
      });
      respond(true, { ok: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
