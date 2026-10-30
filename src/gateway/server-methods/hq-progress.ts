/**
 * Business HQ progress + dashboard settings RPCs (src/hq-progress/store.ts).
 *
 * Read:  hq.progress.get
 * Write: hq.progress.snapshot, hq.settings.set, hq.snooze
 *
 * Completions themselves are NOT writable from here — they are recorded by the
 * kanban / decision / risk / commitment update handlers when an object really
 * changes state, so the dashboard's progress numbers can't be inflated by a
 * client.
 */
import type { GatewayRequestHandlers } from "./types.js";
import { getHqProgressStore } from "../../hq-progress/store.js";

export const HQ_READ_METHODS = ["hq.progress.get"] as const;
export const HQ_WRITE_METHODS = ["hq.progress.snapshot", "hq.settings.set", "hq.snooze"] as const;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function bad(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"], msg: string) {
  respond(false, undefined, { code: "INVALID_REQUEST", message: msg });
}

export const hqProgressHandlers: GatewayRequestHandlers = {
  "hq.progress.get": ({ params, respond }) => {
    const p = (params ?? {}) as { sinceMs?: number };
    const since =
      typeof p.sinceMs === "number" && Number.isFinite(p.sinceMs) ? p.sinceMs : undefined;
    respond(true, getHqProgressStore().get(since));
  },

  "hq.progress.snapshot": ({ params, respond }) => {
    const p = (params ?? {}) as { day?: string; metrics?: Record<string, number> };
    if (!p.day || !DAY_KEY.test(p.day)) return bad(respond, "day must be YYYY-MM-DD");
    if (!p.metrics || typeof p.metrics !== "object") return bad(respond, "metrics required");
    respond(true, getHqProgressStore().snapshot(p.day, p.metrics));
  },

  "hq.settings.set": ({ params, respond }) => {
    const p = (params ?? {}) as { dailyTarget?: number; parentProjectId?: string | null };
    try {
      const settings = getHqProgressStore().setSettings({
        ...(p.dailyTarget !== undefined ? { dailyTarget: p.dailyTarget } : {}),
        ...(p.parentProjectId !== undefined ? { parentProjectId: p.parentProjectId } : {}),
      });
      respond(true, { settings });
    } catch (err) {
      bad(respond, err instanceof Error ? err.message : String(err));
    }
  },

  "hq.snooze": ({ params, respond }) => {
    const p = (params ?? {}) as { objectId?: string; until?: number | null };
    if (!p.objectId) return bad(respond, "objectId required");
    const until = typeof p.until === "number" && Number.isFinite(p.until) ? p.until : null;
    respond(true, { settings: getHqProgressStore().snooze(String(p.objectId), until) });
  },
};
