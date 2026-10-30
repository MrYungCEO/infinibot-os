/**
 * Per-plan concurrent-agent gate for hosted (SaaS / fleet) tenants.
 *
 * Called at the top of every agent-spawning tool (claude_coder / codex_coder /
 * opencode_coder / sessions_spawn) BEFORE any side effect. When the tenant is
 * already running as many agents as its plan allows — or, for a CLI coder
 * spawn, as many coders — the spawn is refused with a structured `AGENT_LIMIT`
 * error (`kind` "agents" or "coders") and a `plan.limit` WS event is broadcast so
 * the control UI pops the upgrade modal (ui/src/ui/components/upgrade-modal.ts).
 *
 * Scope rules — local behaviour must never change:
 *   - Not SaaS mode (isSaasMode() false)       → never gated.
 *   - SaaS mode, but the gateway can't attribute
 *     itself to one tenant (no FLEET_TENANT_ID
 *     and no FLEET_TENANT_PLAN)                 → never gated (shared/owner gateway).
 *   - Owner plans ("ceo", "owner", …)           → never gated.
 *   - Fleet gateway (one Machine per tenant)    → every live run in this process
 *     belongs to that tenant, so "used" = active runs in the subagent registry.
 *
 * Plan source: FLEET_TENANT_PLAN env (explicit override) → `tenants.plan` in
 * Neon for FLEET_TENANT_ID (cached PLAN_CACHE_MS; last good value survives a
 * Neon blip; never fetched + lookup fails → the default plan, limit 1).
 */

import { getCommandLaneConcurrency, setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { isSaasMode } from "../saas/config.js";
import { getGatewayBroadcaster } from "./coder-runtime/subagent-broadcast.js";
import { ensureBuildQueueInstalled } from "./build-queue.js";
import { nextPlan, resolvePlanLimits, type PlanLimits } from "./plan-limits.js";
import { listAllSubagentRuns, type SubagentRunRecord } from "./subagent-registry.js";

export const AGENT_LIMIT_CODE = "AGENT_LIMIT";
export const PLAN_LIMIT_EVENT = "plan.limit";
export const UPGRADE_URL = "/pricing";

/** What is being spawned: a CLI coder (claude_coder & co) or a native sub-agent. */
export type SpawnKind = "coder" | "agent";

export type AgentLimitError = {
  code: typeof AGENT_LIMIT_CODE;
  kind: "agents" | "coders";
  limit: number;
  plan: string;
  used: number;
  nextPlan: string | null;
  upgradeUrl: string;
  message: string;
};

export type SpawnDecision = { allowed: true } | { allowed: false; error: AgentLimitError };

function limitError(
  kind: AgentLimitError["kind"],
  limits: PlanLimits,
  limit: number,
  used: number,
): AgentLimitError {
  const upgrade = nextPlan(limits.plan);
  const coders = kind === "coders";
  const noun = coders ? (limit === 1 ? "coder" : "coders") : limit === 1 ? "agent" : "agents";
  return {
    code: AGENT_LIMIT_CODE,
    kind,
    limit,
    plan: limits.plan,
    used,
    nextPlan: upgrade,
    upgradeUrl: UPGRADE_URL,
    message:
      `${coders ? "Coder" : "Agent"} limit reached: ${used}/${limit} ${noun} running on the ${limits.plan} plan. ` +
      (upgrade
        ? `Wait for one to finish, or upgrade to ${upgrade} at ${UPGRADE_URL} for more parallel ${coders ? "coders" : "agents"}.`
        : "Wait for one to finish before starting another."),
  };
}

/**
 * Pure decision: may one more agent start? `used` counts every running agent;
 * for a coder spawn (`kind: "coder"`) `codersUsed` is also checked against the
 * plan's coder cap. The total cap is checked first.
 */
export function evaluateAgentSpawn(params: {
  saas: boolean;
  limits: PlanLimits | null;
  used: number;
  kind?: SpawnKind;
  codersUsed?: number;
}): SpawnDecision {
  const { saas, limits, used } = params;
  if (!saas || !limits) return { allowed: true };
  if (limits.agents !== null && used >= limits.agents) {
    return { allowed: false, error: limitError("agents", limits, limits.agents, used) };
  }
  const codersUsed = params.codersUsed ?? 0;
  if (params.kind === "coder" && limits.coders !== null && codersUsed >= limits.coders) {
    return { allowed: false, error: limitError("coders", limits, limits.coders, codersUsed) };
  }
  return { allowed: true };
}

/** A run counts toward the limit until it ends, fails or is interrupted. */
export function isRunOccupyingSlot(run: SubagentRunRecord): boolean {
  return run.endedAt == null && run.outcome == null && run.interruptedAt == null;
}

/** A CLI coder run (claude_coder / codex_coder / opencode_coder), as opposed to a native sub-agent. */
export function isCoderRun(run: SubagentRunRecord): boolean {
  return run.coderBackend != null || run.durableSpawn === "tmux-coder";
}

// ── plan lookup ────────────────────────────────────────────────────────────

const PLAN_CACHE_MS = 60_000;
let planCache: { tenantId: string; plan: string; at: number } | null = null;

export type PlanLookup = (tenantId: string) => Promise<string | null>;

async function neonPlanLookup(tenantId: string): Promise<string | null> {
  const { neon, neonConfigured } = await import("../saas/neon.js");
  if (!neonConfigured()) return null;
  const rows = await neon()`select plan from tenants where id = ${tenantId} limit 1`;
  const plan = rows[0]?.plan;
  return typeof plan === "string" ? plan : null;
}

/**
 * The raw plan id for the tenant this gateway serves, or null when the gateway
 * isn't attributable to a single tenant (→ caller must not gate).
 */
export async function resolveTenantPlan(
  env: NodeJS.ProcessEnv = process.env,
  lookup: PlanLookup = neonPlanLookup,
  now: number = Date.now(),
): Promise<string | null> {
  const override = env.FLEET_TENANT_PLAN?.trim();
  if (override) return override;
  const tenantId = env.FLEET_TENANT_ID?.trim();
  if (!tenantId) return null;
  if (planCache && planCache.tenantId === tenantId && now - planCache.at < PLAN_CACHE_MS) {
    return planCache.plan;
  }
  try {
    const plan = (await lookup(tenantId)) ?? "";
    planCache = { tenantId, plan, at: now };
    return plan;
  } catch {
    // Neon blip: keep the last known plan; with none, fall back to the default
    // (normalizePlan("") → starter). Not cached, so the next spawn retries.
    return planCache?.tenantId === tenantId ? planCache.plan : "";
  }
}

/**
 * Native sub-agents (sessions_spawn) take turns through the Subagent command
 * lane, which defaults to 8 concurrent turns (src/config/agent-limits.ts). A
 * plan that sells more agents than that would silently queue the extras, so
 * widen the lane to the plan's agent cap. Never narrows it; a config reload
 * resets the lane and the next spawn widens it again.
 */
export function fitSubagentLane(agents: number | null): void {
  if (agents === null) return;
  try {
    if (getCommandLaneConcurrency(CommandLane.Subagent) < agents) {
      setCommandLaneConcurrency(CommandLane.Subagent, agents);
    }
  } catch {
    /* lane sizing is best-effort; never a reason to refuse a spawn */
  }
}

// ── spawn reservations (closes the check-then-spawn race) ──────────────────
//
// Two spawns issued in the same tick would both see `used` below the limit.
// Each allowed spawn leaves a short-lived reservation; a reservation is
// "consumed" once a run registered after it shows up, and expires on its own
// if the spawn failed before registering.

const RESERVATION_TTL_MS = 30_000;
let reservations: Array<{ at: number; kind: SpawnKind }> = [];

function withPending(active: SubagentRunRecord[], pending: number[]): number {
  if (pending.length === 0) return active.length;
  const oldest = Math.min(...pending);
  const registeredSince = active.filter((r) => r.createdAt >= oldest).length;
  return active.length + Math.max(0, pending.length - registeredSince);
}

function countUsed(runs: SubagentRunRecord[], now: number): { used: number; codersUsed: number } {
  reservations = reservations.filter((r) => now - r.at < RESERVATION_TTL_MS);
  const active = runs.filter(isRunOccupyingSlot);
  return {
    used: withPending(
      active,
      reservations.map((r) => r.at),
    ),
    codersUsed: withPending(
      active.filter(isCoderRun),
      reservations.filter((r) => r.kind === "coder").map((r) => r.at),
    ),
  };
}

export type GateDeps = {
  saas?: boolean;
  env?: NodeJS.ProcessEnv;
  lookup?: PlanLookup;
  runs?: () => SubagentRunRecord[];
  broadcast?: ((event: string, payload: unknown) => void) | null;
  now?: number;
  /** Skip installing the build-queue shims (tests). */
  skipBuildQueue?: boolean;
  /** Leave the sub-agent command lane alone (tests). */
  skipLaneFit?: boolean;
  /** What is being spawned (default "agent"); coders also check the coder cap. */
  kind?: SpawnKind;
};

/**
 * Gate one agent spawn. Returns null when the spawn may proceed (and reserves
 * a slot), or the AGENT_LIMIT error after broadcasting `plan.limit`.
 */
export async function gateAgentSpawn(deps: GateDeps = {}): Promise<AgentLimitError | null> {
  const saas = deps.saas ?? isSaasMode();
  if (!saas) return null;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const rawPlan = await resolveTenantPlan(env, deps.lookup, now);
  if (rawPlan === null) return null;
  const limits = resolvePlanLimits(rawPlan);
  if (!deps.skipBuildQueue) {
    try {
      ensureBuildQueueInstalled({ maxConcurrent: limits.builds, env });
    } catch {
      // the build queue is an OOM guard, never a reason to refuse a spawn
    }
  }
  if (!deps.skipLaneFit) fitSubagentLane(limits.agents);
  const kind = deps.kind ?? "agent";
  const { used, codersUsed } = countUsed((deps.runs ?? listAllSubagentRuns)(), now);
  const decision = evaluateAgentSpawn({ saas, limits, used, kind, codersUsed });
  if (decision.allowed) {
    if (limits.agents !== null || limits.coders !== null) reservations.push({ at: now, kind });
    return null;
  }
  const broadcast = deps.broadcast === undefined ? getGatewayBroadcaster() : deps.broadcast;
  try {
    broadcast?.(PLAN_LIMIT_EVENT, decision.error);
  } catch {
    /* the error result still reaches the caller */
  }
  return decision.error;
}

export function resetAgentConcurrencyGateForTests(): void {
  planCache = null;
  reservations = [];
}
