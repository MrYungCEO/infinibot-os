/**
 * Execution settings for the agency workforce operating loop.
 *
 * SAFETY: `executeWorkItems` is the master switch that lets AI employees
 * actually spawn their bound coder CLI against queued work items. It defaults
 * to **false** — the loop keeps generating and escalating work items, but
 * nothing is spawned and no money is spent until the operator opts in.
 */
export type AgencyOperatingLoopConfig = {
  /** Opt-in: execute eligible queued work items via the coder backends. */
  executeWorkItems?: boolean;
  /** Max coder CLIs alive at once per pass. Default 2, clamped 1…8. */
  maxConcurrency?: number;
  /** Hard cap on work items executed per pass. Default 5, clamped 1…50. */
  maxItemsPerPass?: number;
  /** Per-item wall-clock budget. Default 20, clamped 1…240. */
  timeoutMinutes?: number;
  /** Backend to retry with when the worker's bound backend fails to launch. */
  fallbackBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** Backend for workers with no (or an unknown) `modelBinding`. */
  defaultBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
};

export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /**
   * Opt-in for the self-driven jobs the gateway seeds (proactive nudges,
   * autonomy queue poll, CEO/oversight reports, agency loop, SOP schedules).
   * Unset on a fresh install → they are created disabled. `true` enables the
   * ones that were seeded disabled; `false` keeps new ones off. Existing jobs
   * are never disabled. Env `INFINIBOT_AUTONOMY=1|0` overrides.
   */
  autonomy?: boolean;
  /**
   * Cadence (ms) for the agency workforce operating loop. Only used to seed the
   * `agency-operating-loop` cron job the first time; afterwards the job's own
   * schedule (editable in Settings) wins. Clamped to 1 minute … 24 hours.
   */
  agencyOperatingLoopMs?: number;
  /** Work-item execution settings. Disabled by default. */
  agencyOperatingLoop?: AgencyOperatingLoopConfig;
};
