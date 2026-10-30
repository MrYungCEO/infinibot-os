import { Type } from "@sinclair/typebox";
import { compactDay, compactRange } from "../../daily-review/compact.js";
import { getDay, getRange } from "../../daily-review/service.js";
import { isDayKey } from "../../daily-review/util.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const RANGES = ["day", "week", "month", "quarter", "year", "all"] as const;

/** Hard cap on what this tool returns (voice runs in a 128k window). */
const MAX_CHARS = 6000;

export function createDailyReviewTool(): AnyAgentTool {
  return {
    label: "Daily Review",
    name: "daily_review",
    description: `Answer "what did we do today / this week?" from the Daily Review rollups.

Returns a compact plain-text summary (always under ${MAX_CHARS} characters): the productivity score with its baseline,
tasks verified/unverified/failed, where the agent time went (project, type, backend), commits, deploys, kanban
completions, what shipped, what needs the owner, and the saved end-of-day summary when there is one.

- date: YYYY-MM-DD (default today, refreshed if stale)
- range: "week" | "month" | "quarter" | "year" | "all" for a multi-day overview with per-day lines.
Open the full charts at /daily-review in the control UI.`,
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD; defaults to today" })),
      range: Type.Optional(stringEnum(RANGES)),
    }),
    execute: async (_toolCallId, args) => {
      const p = (args ?? {}) as { date?: string; range?: string };
      if (p.range && p.range !== "day") {
        return jsonResult({
          text: compactRange(
            getRange(p.range, undefined, isDayKey(p.date) ? p.date : undefined),
            MAX_CHARS,
          ),
        });
      }
      const day = await getDay(p.date);
      return jsonResult({
        text: day ? compactDay(day, MAX_CHARS) : "No daily review data for that day yet.",
        link: "/daily-review",
      });
    },
  };
}
