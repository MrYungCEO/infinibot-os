/**
 * Autonomy Self-Heal — registry of healers for broken tools + infra.
 * // COORDINATION: orch-self-heal
 *
 * The orchestrator hits the same handful of recoverable tool/infra failures
 * over and over (missing search key, embeddings auth not propagated to a
 * spawned agent's auth store, the browser-relay service being down). Rather
 * than terminally failing a task on these, we CLASSIFY the failure:
 *
 *   - infra/tool error  → attempt a registered healer, then RETRY the same
 *                          phase (the iteration is NOT consumed). If the heal
 *                          budget is exhausted the task is PARKED ("blocked"),
 *                          not failed — the heartbeat resumes it later and
 *                          after a restart.
 *   - genuine task error → the orchestrator's existing terminal path runs.
 *
 * Each healer carries a per-task attempt budget. Attempts + outcomes are
 * persisted onto the task (TaskHealState) so we survive a restart and never
 * infinite-loop on the same unhealable error.
 */

import { existsSync, copyFileSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { logAudit } from "./audit.js";
import { isRetryableError } from "./retry.js";
import type { HealAttemptRecord, QueuedTask, TaskHealState } from "./types.js";

// ─── Healer contract ───────────────────────────────────────────────────────

export interface HealContext {
  /** The raw error/throwable that triggered classification. */
  error: unknown;
  /** Pre-computed error text (error.message or String(error)). */
  errorText: string;
  /** The task being driven, if available — heal state is recorded on it. */
  task?: QueuedTask;
  /** Which phase failed ("build" | "test" | other). */
  phase?: string;
}

export interface HealOutcome {
  /** True when the healer believes the underlying problem is now resolved. */
  healed: boolean;
  /** Short description of what the healer did (or attempted). */
  action: string;
  /** Whether the caller should retry the failed phase after this heal. */
  retryable: boolean;
  /** True when the heal applied a degraded fallback rather than a real fix. */
  degraded?: boolean;
}

export interface Healer {
  id: string;
  description: string;
  /** Max heal attempts per task before the failure is declared unhealable. */
  maxAttempts?: number;
  /** Pure predicate — does this healer handle the given failure? */
  detect: (ctx: HealContext) => boolean;
  /** Attempt the fix. Should be best-effort and never throw on its own. */
  heal: (ctx: HealContext) => Promise<HealOutcome>;
}

/** Default per-healer attempt budget when a healer doesn't set its own. */
export const DEFAULT_HEAL_BUDGET = 3;

// ─── Concrete healers for the failures we actually hit ──────────────────────

/**
 * (a) brave-search-key — `missing_brave_api_key`.
 * Heal by sourcing a stored Brave key from config/env and applying it to the
 * process env; if none exists, flag a degraded fallback so the search path can
 * route around Brave instead of hard-failing the task.
 */
const braveSearchKeyHealer: Healer = {
  id: "brave-search-key",
  description: "Supply a missing Brave Search API key or route to a fallback search provider.",
  detect: (ctx) => /missing_brave_api_key|brave.{0,20}api.?key/i.test(ctx.errorText),
  heal: async () => {
    // Already in env from a prior heal / operator config.
    const existing =
      process.env.BRAVE_API_KEY || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_SEARCH_KEY;
    if (existing && existing.trim()) {
      process.env.BRAVE_API_KEY = existing.trim();
      return {
        healed: true,
        action: "Applied stored BRAVE_API_KEY from environment.",
        retryable: true,
      };
    }
    // Try the persisted gateway config (web-search provider settings).
    try {
      const { loadConfig } = await import("../config/config.js");
      const cfg = loadConfig() as unknown as Record<string, any>;
      const key =
        cfg?.tools?.webSearch?.braveApiKey ||
        cfg?.webSearch?.braveApiKey ||
        cfg?.providers?.brave?.apiKey;
      if (typeof key === "string" && key.trim()) {
        process.env.BRAVE_API_KEY = key.trim();
        return {
          healed: true,
          action: "Applied Brave API key from gateway config.",
          retryable: true,
        };
      }
    } catch {
      /* best-effort */
    }
    // No key anywhere — degrade to a fallback provider so we keep going.
    process.env.AUTONOMY_SEARCH_FALLBACK = "1";
    return {
      healed: true,
      action: "No Brave key found — routed search to fallback provider (degraded).",
      retryable: true,
      degraded: true,
    };
  },
};

/**
 * (b) embeddings-auth — `No API key found for provider "openai"/"google"` from
 * memory_search / embeddings. The error literally prescribes the fix: copy
 * `auth-profiles.json` from the main agentDir into the failing agent's auth
 * store. We parse the two paths straight out of the error text.
 */
const embeddingsAuthHealer: Healer = {
  id: "embeddings-auth",
  description:
    'Copy auth-profiles.json from the main agentDir into a spawned agent\'s auth store when embeddings report "No API key found".',
  detect: (ctx) =>
    /No API key found for provider/i.test(ctx.errorText) &&
    /auth-profiles\.json|auth store|agentDir/i.test(ctx.errorText),
  heal: async (ctx) => {
    const text = ctx.errorText;
    // The error reads: 'Auth store: <dst> (agentDir: <dir>). ... copy
    // auth-profiles.json from the main agentDir.'
    const dstMatch = text.match(/Auth store:\s*([^\s)]+auth-profiles\.json)/i);
    const dst = dstMatch?.[1];
    if (!dst) {
      return {
        healed: false,
        action: "Could not parse the failing auth-store path from the error text.",
        retryable: false,
      };
    }
    // Candidate sources for the main agent's auth profile.
    const candidates: string[] = [];
    if (process.env.INFINIBOT_MAIN_AGENT_DIR) {
      candidates.push(resolve(process.env.INFINIBOT_MAIN_AGENT_DIR, "auth-profiles.json"));
    }
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      candidates.push(
        resolve(home, ".infinibot/agents/main/agent/auth-profiles.json"),
        resolve(home, ".clawd/auth-profiles.json"),
      );
    }
    const src = candidates.find((p) => p !== dst && existsSync(p));
    if (!src) {
      return {
        healed: false,
        action: `No source auth-profiles.json found (checked: ${candidates.join(", ") || "none"}).`,
        retryable: false,
      };
    }
    try {
      // Don't clobber a valid destination that already carries keys.
      if (existsSync(dst)) {
        try {
          const cur = JSON.parse(readFileSync(dst, "utf-8"));
          if (cur && typeof cur === "object" && Object.keys(cur).length > 0) {
            return {
              healed: true,
              action: `Destination auth store already populated (${dst}); no copy needed.`,
              retryable: true,
            };
          }
        } catch {
          /* fall through to copy */
        }
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return {
        healed: true,
        action: `Copied auth-profiles.json from ${src} → ${dst}.`,
        retryable: true,
      };
    } catch (e) {
      return {
        healed: false,
        action: `Copy failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
      };
    }
  },
};

/**
 * (c) browser-relay-clawd-down — "Can't reach the clawd browser control
 * service" / HTTP 404 / "tab not found". Heal by re-initializing the gateway
 * browser-relay service and re-attaching.
 */
const browserRelayHealer: Healer = {
  id: "browser-relay-clawd-down",
  description: "Restart / re-attach the clawd browser-relay service when it is unreachable.",
  detect: (ctx) =>
    /can'?t reach the clawd|clawd browser control|browser.?relay|tab not found|HTTP\s*404/i.test(
      ctx.errorText,
    ),
  heal: async () => {
    try {
      const { callGateway } = await import("../gateway/call.js");
      // Best-effort re-init of the relay. The method is tolerant of being
      // called when the relay is already up (it re-attaches).
      await callGateway({
        method: "browser.relay.restart",
        params: {},
        timeoutMs: 20_000,
      });
      return {
        healed: true,
        action: "Requested browser-relay restart + re-attach via gateway.",
        retryable: true,
      };
    } catch (e) {
      return {
        healed: false,
        action: `Browser-relay restart failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true, // service may recover on its own — worth a later retry
      };
    }
  },
};

const DEFAULT_HEALERS: Healer[] = [braveSearchKeyHealer, embeddingsAuthHealer, browserRelayHealer];

// Test seam: inject a custom registry without touching the default healers.
let testHealersOverride: Healer[] | null = null;
/** @internal test-only — replace the active healer registry (null = restore). */
export function __setHealersForTest(healers: Healer[] | null): void {
  testHealersOverride = healers;
}

export function getHealers(): Healer[] {
  return testHealersOverride ?? DEFAULT_HEALERS;
}

function safeDetect(h: Healer, ctx: HealContext): boolean {
  try {
    return h.detect(ctx);
  } catch {
    return false;
  }
}

// ─── Classification ─────────────────────────────────────────────────────────

export interface FailureClassification {
  /** "infra" → heal + retry (don't consume the iteration); "task" → genuine. */
  kind: "infra" | "task";
  /** The healer that matched, if any. */
  healer?: Healer;
  /** True when the error is a transient network/infra error with no specific
   *  healer (e.g. ECONNRESET) — still infra, recover by plain retry. */
  transient: boolean;
}

/**
 * Decide whether a failure is a recoverable infra/tool problem (heal + retry)
 * or a genuine task failure (existing terminal path). A failure is "infra"
 * when a registered healer claims it OR it's a transient network error.
 */
export function classifyFailure(ctx: HealContext, healers?: Healer[]): FailureClassification {
  const registry = healers ?? getHealers();
  const healer = registry.find((h) => safeDetect(h, ctx));
  if (healer) return { kind: "infra", healer, transient: false };
  if (isRetryableError(ctx.error)) return { kind: "infra", transient: true };
  return { kind: "task", transient: false };
}

// ─── Heal attempt (with persisted per-task budget) ──────────────────────────

export interface HealAttemptResult {
  /** True when a specific healer matched the failure. */
  matched: boolean;
  /** True when the heal believes the problem is resolved. */
  healed: boolean;
  /** True when the budget is exhausted / heal can't help — caller should park. */
  unhealable: boolean;
  /** Whether the caller should retry the phase (healed or transient). */
  retryable: boolean;
  /** Healer id, when matched. */
  healerId?: string;
  /** Human description of the outcome. */
  action: string;
  /** True when a degraded fallback was applied. */
  degraded?: boolean;
}

function ensureHealState(task: QueuedTask): TaskHealState {
  if (!task.healState) {
    task.healState = { attempts: [], budgetUsed: {} };
  }
  if (!task.healState.budgetUsed) task.healState.budgetUsed = {};
  if (!Array.isArray(task.healState.attempts)) task.healState.attempts = [];
  return task.healState;
}

function recordAttempt(task: QueuedTask | undefined, rec: HealAttemptRecord): void {
  if (!task) return;
  const hs = ensureHealState(task);
  hs.attempts.push(rec);
  // Keep the log bounded — only the last 50 attempts matter for auditing.
  if (hs.attempts.length > 50) hs.attempts = hs.attempts.slice(-50);
  hs.lastBlocker = rec.errorExcerpt;
  hs.lastUnhealable = rec.outcome === "unhealable";
}

const EXCERPT_MAX = 500;
function excerpt(text: string): string {
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;
}

/**
 * Attempt to heal a classified-infra failure, enforcing a persisted per-healer
 * budget. Mutates `ctx.task.healState` (caller is responsible for persisting
 * the queue afterwards). Never throws.
 */
export async function attemptHeal(
  ctx: HealContext,
  healers?: Healer[],
): Promise<HealAttemptResult> {
  const registry = healers ?? getHealers();
  const healer = registry.find((h) => safeDetect(h, ctx));
  const exc = excerpt(ctx.errorText);

  if (!healer) {
    // No specific healer — transient infra errors are retryable, everything
    // else is unhealable (the caller will park or fail per classification).
    const transient = isRetryableError(ctx.error);
    recordAttempt(ctx.task, {
      healerId: "(none)",
      at: Date.now(),
      outcome: transient ? "failed" : "unhealable",
      action: transient
        ? "Transient infra error; no specific healer — will retry."
        : "No healer matched this failure.",
      retryable: transient,
      errorExcerpt: exc,
      phase: ctx.phase,
    });
    return {
      matched: false,
      healed: false,
      unhealable: !transient,
      retryable: transient,
      action: transient ? "transient infra; will retry" : "no healer matched",
    };
  }

  const max = healer.maxAttempts ?? DEFAULT_HEAL_BUDGET;
  const used = ctx.task ? (ensureHealState(ctx.task).budgetUsed[healer.id] ?? 0) : 0;
  if (used >= max) {
    recordAttempt(ctx.task, {
      healerId: healer.id,
      at: Date.now(),
      outcome: "unhealable",
      action: `Heal budget exhausted (${used}/${max}).`,
      retryable: false,
      errorExcerpt: exc,
      phase: ctx.phase,
    });
    return {
      matched: true,
      healed: false,
      unhealable: true,
      retryable: false,
      healerId: healer.id,
      action: `heal budget exhausted (${used}/${max})`,
    };
  }

  let outcome: HealOutcome;
  try {
    outcome = await healer.heal(ctx);
  } catch (e) {
    outcome = {
      healed: false,
      action: `healer threw: ${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    };
  }

  if (ctx.task) {
    const hs = ensureHealState(ctx.task);
    hs.budgetUsed[healer.id] = used + 1;
  }
  const nowUsed = used + 1;
  const unhealable = !outcome.healed && nowUsed >= max;
  recordAttempt(ctx.task, {
    healerId: healer.id,
    at: Date.now(),
    outcome: outcome.healed ? "healed" : unhealable ? "unhealable" : "failed",
    action: outcome.action,
    retryable: outcome.retryable,
    errorExcerpt: exc,
    phase: ctx.phase,
  });

  try {
    logAudit("heal_attempt", `Heal ${healer.id}: ${outcome.healed ? "healed" : "failed"}`, {
      category: "system",
      target: ctx.task?.id,
      outcome: outcome.healed ? "success" : unhealable ? "blocked" : "failure",
      details: {
        healer: healer.id,
        action: outcome.action,
        attempt: nowUsed,
        max,
        degraded: outcome.degraded ?? false,
        phase: ctx.phase,
      },
    });
  } catch {
    /* best-effort */
  }

  return {
    matched: true,
    healed: outcome.healed,
    unhealable,
    retryable: outcome.healed || outcome.retryable,
    healerId: healer.id,
    action: outcome.action,
    degraded: outcome.degraded,
  };
}
