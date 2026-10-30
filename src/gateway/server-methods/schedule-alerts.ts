import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  cancelAlert,
  cancelAlertsForEvent,
  listAlerts,
  scheduleAlert,
  type AlertChannel,
} from "../../calendar/alerts.js";
import type { GatewayRequestHandlers } from "./types.js";

const ALLOWED_CHANNELS = new Set<AlertChannel>(["telegram", "discord", "email", "notification"]);

export const scheduleAlertsHandlers: GatewayRequestHandlers = {
  "schedule.scheduleAlert": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const eventId = typeof p.eventId === "string" ? p.eventId : "";
    const eventTitle = typeof p.eventTitle === "string" ? p.eventTitle : eventId;
    const fireAtMs = typeof p.fireAtMs === "number" ? p.fireAtMs : 0;
    const channel = typeof p.channel === "string" ? p.channel as AlertChannel : "telegram";
    const target = typeof p.target === "string" ? p.target : undefined;
    const message = typeof p.message === "string" ? p.message : eventTitle;
    if (!eventId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "eventId required"));
      return;
    }
    if (!Number.isFinite(fireAtMs) || fireAtMs < Date.now() - 60_000) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "fireAtMs must be a future timestamp"));
      return;
    }
    if (!ALLOWED_CHANNELS.has(channel)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`));
      return;
    }
    try {
      const alert = await scheduleAlert({ eventId, eventTitle, fireAtMs, channel, target, message });
      respond(true, { alert });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "schedule.cancelAlert": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const alertId = typeof p.alertId === "string" ? p.alertId : "";
    const eventId = typeof p.eventId === "string" ? p.eventId : "";
    try {
      if (alertId) {
        const ok = await cancelAlert(alertId);
        respond(true, { cancelled: ok ? 1 : 0 });
        return;
      }
      if (eventId) {
        const count = await cancelAlertsForEvent(eventId);
        respond(true, { cancelled: count });
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "alertId or eventId required"));
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "schedule.listAlerts": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const eventId = typeof p.eventId === "string" ? p.eventId : undefined;
    const pending = p.pending === true;
    try {
      const items = await listAlerts({ eventId, pending });
      respond(true, { alerts: items });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },
};
