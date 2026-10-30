import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  beginConnect,
  calendlyToCalendarEvent,
  completeOAuth,
  disconnect,
  getCalendlyStatus,
  listScheduledEvents,
} from "../../calendar/calendly.js";
import type { GatewayRequestHandlers } from "./types.js";

export const calendlyHandlers: GatewayRequestHandlers = {
  "calendly.status": async ({ respond }) => {
    try {
      const s = await getCalendlyStatus();
      respond(true, s);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "calendly.connect": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const redirectUri = typeof p.redirectUri === "string" ? p.redirectUri : undefined;
    try {
      const res = await beginConnect({ redirectUri });
      respond(true, res);
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "calendly.completeOAuth": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const code = typeof p.code === "string" ? p.code : "";
    const redirectUri = typeof p.redirectUri === "string" ? p.redirectUri : "";
    if (!code || !redirectUri) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "code + redirectUri required"));
      return;
    }
    try {
      await completeOAuth(code, redirectUri);
      respond(true, { connected: true });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "calendly.disconnect": async ({ respond }) => {
    try {
      await disconnect();
      respond(true, { connected: false });
    } catch (e) {
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
    }
  },

  "calendly.events.list": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const minTime = typeof p.minTime === "string" ? p.minTime : new Date().toISOString();
    const maxTime = typeof p.maxTime === "string" ? p.maxTime : new Date(Date.now() + 60 * 86400_000).toISOString();
    try {
      const items = await listScheduledEvents({ minTimeIso: minTime, maxTimeIso: maxTime });
      const events = items.map(calendlyToCalendarEvent);
      respond(true, { events });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Don't 500 if simply not connected — return empty list.
      if (msg.toLowerCase().includes("not connected")) {
        respond(true, { events: [] });
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.INTERNAL_ERROR, msg));
    }
  },
};
