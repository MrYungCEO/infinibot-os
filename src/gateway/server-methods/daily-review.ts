/**
 * daily_review.* — Daily Review / workload analytics.
 *
 *   daily_review.get      { date?, refresh? }        → full DayRollup (today refreshed when stale)
 *   daily_review.range    { range?|from?,to? }       → compact per-day index entries
 *   daily_review.compact  { date?, range? }          → capped plain text (agents / voice)
 *   daily_review.config.get / daily_review.config.set { telegram?: { enabled?, time? }, summary?: { autoTime? } }
 *   daily_review.summarize { date?, send? }          → (re)write the AI end-of-day summary
 *   daily_review.rebuild  { from? }                  → backfill history in a child process
 *
 * Rollups are computed out of process (src/daily-review/cli.ts); the gateway
 * only reads the per-day JSON files.
 */
import { compactDay, compactRange } from "../../daily-review/compact.js";
import { getDay, getRange, refreshInChild } from "../../daily-review/service.js";
import { isDayKey, loadConfig, saveConfig, today } from "../../daily-review/util.js";
import type { GatewayRequestHandlers } from "./types.js";

export const DAILY_REVIEW_READ_METHODS = [
  "daily_review.get",
  "daily_review.range",
  "daily_review.compact",
  "daily_review.config.get",
] as const;

export const DAILY_REVIEW_WRITE_METHODS = [
  "daily_review.config.set",
  "daily_review.summarize",
  "daily_review.rebuild",
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const dailyReviewHandlers: GatewayRequestHandlers = {
  "daily_review.get": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { date?: string; refresh?: boolean };
      const day = await getDay(p.date, { force: p.refresh === true });
      if (!day) {
        respond(true, { date: isDayKey(p.date) ? p.date : today(), empty: true });
        return;
      }
      respond(true, day);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "daily_review.range": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { range?: string; from?: string; to?: string };
      respond(true, { days: getRange(p.range, p.from, p.to) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "daily_review.compact": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { date?: string; range?: string };
      if (p.range) {
        respond(true, { text: compactRange(getRange(p.range)) });
        return;
      }
      const day = await getDay(p.date);
      respond(true, { text: day ? compactDay(day) : "No daily review data yet." });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "daily_review.config.get": async ({ respond }) => {
    respond(true, loadConfig());
  },

  "daily_review.config.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        telegram?: { enabled?: boolean; time?: string };
        summary?: { autoTime?: string };
      };
      const cfg = loadConfig();
      if (typeof p.telegram?.enabled === "boolean") cfg.telegram.enabled = p.telegram.enabled;
      if (typeof p.telegram?.time === "string" && HHMM.test(p.telegram.time))
        cfg.telegram.time = p.telegram.time;
      if (typeof p.summary?.autoTime === "string" && HHMM.test(p.summary.autoTime))
        cfg.summary.autoTime = p.summary.autoTime;
      saveConfig(cfg);
      respond(true, cfg);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "daily_review.summarize": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { date?: string; send?: boolean };
      const date = isDayKey(p.date) ? p.date : today();
      await refreshInChild(["summary", date, ...(p.send ? ["--send"] : [])], 240_000);
      const day = await getDay(date, { maxAgeMs: Number.POSITIVE_INFINITY });
      respond(true, { date, summary: day?.summary ?? null });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "daily_review.rebuild": async ({ params, respond }) => {
    const p = (params ?? {}) as { from?: string };
    // Fire and forget: a full backfill can take a few minutes on first run.
    void refreshInChild(["backfill", ...(isDayKey(p.from) ? ["--from", p.from] : [])], 30 * 60_000);
    respond(true, { started: true });
  },
};
