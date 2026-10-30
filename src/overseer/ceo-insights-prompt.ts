/**
 * CEO / Overseer — hourly insights system prompt.
 *
 * This is the *strict* prompt module for the `ceo_hourly_insights` report kind.
 * It is deliberately hard-edged: it biases toward ACTION and against narration,
 * and it explicitly rejects "agent X completed task Y" status fluff. The CEO
 * agent receives ONE HOUR of pre-collected activity (see
 * `src/reports/kinds/ceo-hourly.ts` collector) and must return strict JSON.
 *
 * Keep the system prompt single-sourced here so every spawn point (cron worker,
 * manual `reports.generate`, future schedule UI) uses the exact same wording —
 * mirrors the single-source convention in `src/agents/voice-orchestrator-prompt.ts`.
 */

/** Allowed insight kinds. Mirrors the plan / report_insights semantics. */
export const CEO_INSIGHT_KINDS = ["alert", "opportunity", "risk", "win"] as const;
export type CeoInsightKind = (typeof CEO_INSIGHT_KINDS)[number];

/** Allowed severities. Matches `InsightSeverity` in src/reports/types.ts (minus "info"). */
export const CEO_INSIGHT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type CeoInsightSeverity = (typeof CEO_INSIGHT_SEVERITIES)[number];

export const CEO_INSIGHTS_MIN = 3;
export const CEO_INSIGHTS_MAX = 7;

/**
 * The strict system prompt. Do NOT soften this. The whole value of the hourly
 * report is that it surfaces drift/risk/opportunity, not a timeline of events.
 */
export const CEO_INSIGHTS_SYSTEM_PROMPT = `You are the CEO of an autonomous engineering org. You have ONE HOUR of activity data. Produce ${CEO_INSIGHTS_MIN}-${CEO_INSIGHTS_MAX} ACTIONABLE insights, NOT a status report. Each insight MUST include:
- title (≤80 chars, punchy)
- kind (alert | opportunity | risk | win)
- severity (low | medium | high | critical)
- body (2-4 sentences — what is happening, why it matters)
- action (1-2 sentences — concrete next step the human or an agent should take)
- evidence (cite specific kanban id, agent id, log line, metric)

REJECT generic status updates ("X agent completed Y task"). Look for:
- Drift (work stalled, repeated failures on same file, agent churning)
- Opportunities (capacity to attack a backlog item, completed work that unblocks others)
- Risks (credit burn outpacing budget, mounting errors, agents stuck >30 min, federation degradation)
- Wins worth amplifying (clean shipments, big surface fixes)

Output strict JSON: { "insights": [...] }

Hard rules:
- Output ONLY the JSON object. No prose before or after, no markdown fences.
- Every insight needs concrete evidence — cite the actual id/metric from the data, never invent one.
- If the data is genuinely quiet, it is correct to return exactly ${CEO_INSIGHTS_MIN} insights about the lull itself (e.g. idle capacity = an opportunity), but NEVER pad with restated events.
- "kind" must be one of: ${CEO_INSIGHT_KINDS.join(" | ")}. "severity" must be one of: ${CEO_INSIGHT_SEVERITIES.join(" | ")}.`;

/**
 * Build the user-message payload that injects the collected hour of activity.
 * The snapshot is rendered as compact, labelled sections so the model can cite
 * specific ids/metrics back as evidence.
 */
export function buildCeoInsightsUserPrompt(snapshotText: string): string {
  return [
    "Here is the last hour of activity across the org. Analyze it and return strict JSON per your instructions.",
    "",
    "=== ACTIVITY SNAPSHOT (last 60 minutes) ===",
    snapshotText.trim(),
    "=== END SNAPSHOT ===",
    "",
    `Return { "insights": [...] } with ${CEO_INSIGHTS_MIN}-${CEO_INSIGHTS_MAX} entries. JSON only.`,
  ].join("\n");
}

/** JSON-schema-ish hint, useful for spawners that support structured output. */
export const CEO_INSIGHTS_JSON_SHAPE = {
  type: "object",
  required: ["insights"],
  properties: {
    insights: {
      type: "array",
      minItems: CEO_INSIGHTS_MIN,
      maxItems: CEO_INSIGHTS_MAX,
      items: {
        type: "object",
        required: ["title", "kind", "severity", "body", "action", "evidence"],
        properties: {
          title: { type: "string", maxLength: 80 },
          kind: { enum: [...CEO_INSIGHT_KINDS] },
          severity: { enum: [...CEO_INSIGHT_SEVERITIES] },
          body: { type: "string" },
          action: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
} as const;
