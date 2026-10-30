/**
 * Per-plan runtime limits for hosted (SaaS / fleet) tenants.
 *
 * Three levers, all keyed by `tenants.plan` (docs/saas/CLOUD_SITE_SPEC.md):
 *   - agents: how many sub-agents (native + CLI coders) may run at once. This is
 *     the paywall lever: "more parallel agents = higher tier".
 *   - coders: how many of those may be CLI coders (Claude Code / Codex /
 *     OpenCode / Gemini processes) at once. A coder costs ~10x a native agent in
 *     RAM (CLI + MCP bridge + its tool subprocesses), so it gets its own, lower
 *     cap sized by the plan's Machine RAM (bench/README.md has the measurements).
 *   - builds: how many RAM-spiking build / headless-verify ops may run at once.
 *     Sized by the plan's Machine RAM so a tenant at its agent cap still can't
 *     OOM the Machine (see src/agents/build-queue.ts, docs/saas/BUILD_QUEUE.md).
 *   - browsers: how many browser sessions (open tabs in the tenant's headless
 *     Chromium) may exist at once (src/browser/hosted.ts enforces it).
 *
 * `null` means unlimited. Only SaaS/hosted mode ever consults this map; local
 * and self-hosted installs are never gated (see agent-concurrency-gate.ts).
 */

export type PlanTier = "free" | "starter" | "pro" | "business" | "scale";

export type PlanLimits = {
  /** Normalized plan id ("unlimited" for owner plans). */
  plan: PlanTier | "unlimited";
  /** Max concurrently running agents (native + coders), or null for unlimited. */
  agents: number | null;
  /** Max concurrently running CLI coder agents (a subset of `agents`), or null. */
  coders: number | null;
  /** Max concurrent heavy build/verify ops, or null for unlimited. */
  builds: number | null;
  /** Max concurrent browser sessions (open tabs), or null for unlimited. */
  browsers: number | null;
};

// Measured on the tenant image under each tier's cgroup limits (bench/README.md,
// bench/results/summary.json). A native agent costs ~10 MB and is bounded by the
// gateway's event loop (p95 <= 1.5x baseline up to 16 busy agents on 1 vCPU, 24 on
// 2+); a CLI coder costs ~205 MB fresh and ~270 MB after 10-15 min. Each tier was
// re-run AT these caps with its builds looping: peak memory stayed <= 75% of RAM
// (room left for a browser session). 7-8 coders OOM-killed the whole 2 GB gateway,
// and 6 coders on 4 GB peaked at 87%, so coder caps are deliberately below that.
// A browser session (headless Chromium + its first tab) costs ~210 MB PSS on a
// heavy page, each further tab ~80 MB (bench/results/hosted-caps-*.browser.txt).
// Every tier was re-run at its agent + coder + build caps WITH these browser
// sessions open and peaked <= 77% of RAM (bench/README.md, "hosted features").
export const PLAN_LIMITS: Readonly<
  Record<PlanTier, { agents: number; coders: number; builds: number; browsers: number }>
> = {
  // Hosted Free (docs/saas/FREE_PLAN.md): 1 shared vCPU, 2 GB, wake, 1 h/day.
  // Below Starter's measured caps on the same RAM, on half the CPU.
  free: { agents: 2, coders: 1, builds: 1, browsers: 1 },
  starter: { agents: 4, coders: 1, builds: 1, browsers: 1 }, // 2 GB, wake
  pro: { agents: 8, coders: 2, builds: 1, browsers: 1 }, // 2 GB
  business: { agents: 16, coders: 4, builds: 2, browsers: 4 }, // 4 GB
  scale: { agents: 24, coders: 12, builds: 3, browsers: 8 }, // 8 GB
};

/**
 * How a hosted tier's Machine runs, and so which always-on features it can offer.
 *   - wake: suspends when idle (Starter). Telegram (webhook) and scheduled jobs
 *     wake it; socket-based channels only run while it is awake; no WhatsApp,
 *     whose linked-device socket needs a Machine that never sleeps.
 *   - always-on: never suspended (Pro and up). Every channel and every schedule
 *     runs 24/7.
 */
export type HostedRunMode = "wake" | "always-on";

export const PLAN_RUN_MODE: Readonly<Record<PlanTier, HostedRunMode>> = {
  free: "wake",
  starter: "wake",
  pro: "always-on",
  business: "always-on",
  scale: "always-on",
};

/** WhatsApp (a long-lived linked-device socket) needs an always-on Machine. */
export function runModeAllowsWhatsApp(mode: HostedRunMode): boolean {
  return mode === "always-on";
}

/** Upgrade order of the PAID tiers; the modal offers the next tier up (Free → Starter). */
export const PLAN_ORDER: readonly PlanTier[] = ["starter", "pro", "business", "scale"];

/** Plans that are never gated (the operator's own workspace). */
const UNLIMITED_PLANS = new Set(["ceo", "owner", "operator", "internal", "unlimited"]);

/** The operator's own plan ids (`ceo`, …): never gated, and hosted voice is operator-funded. */
export function isOperatorPlan(raw: string | null | undefined): boolean {
  return UNLIMITED_PLANS.has((raw ?? "").trim().toLowerCase());
}

/**
 * Legacy / alias plan ids from earlier plan seeds. The retired `team` plan runs
 * on its DB row's 2 GB always-on Machine (the orchestrator only fixes shapes for
 * the four hosted tiers), i.e. Pro's shape — so it gets Pro's caps, not Scale's.
 */
const PLAN_ALIASES: Record<string, PlanTier> = {
  team: "pro",
};

/** Normalize a raw `tenants.plan` value. Unknown / empty → "starter". */
export function normalizePlan(raw: string | null | undefined): PlanTier | "unlimited" {
  const p = (raw ?? "").trim().toLowerCase();
  if (UNLIMITED_PLANS.has(p)) return "unlimited";
  if (p in PLAN_LIMITS) return p as PlanTier;
  if (p in PLAN_ALIASES) return PLAN_ALIASES[p];
  return "starter";
}

export function resolvePlanLimits(raw: string | null | undefined): PlanLimits {
  const plan = normalizePlan(raw);
  if (plan === "unlimited")
    return { plan, agents: null, coders: null, builds: null, browsers: null };
  return { plan, ...PLAN_LIMITS[plan] };
}

/** The next tier up, or null when already on the top tier / unlimited. */
export function nextPlan(raw: string | null | undefined): PlanTier | null {
  const plan = normalizePlan(raw);
  if (plan === "unlimited") return null;
  const i = PLAN_ORDER.indexOf(plan);
  return PLAN_ORDER[i + 1] ?? null;
}
