/**
 * Retry with exponential backoff + jitter for transient failures.
 * // COORDINATION: orch-self-heal
 *
 * Two layers live here:
 *   - retryWithBackoff() — generic per-call retry wrapper used by spawn calls.
 *   - IterationRetryPolicy + planIterationRetry() — orchestrator-level policy
 *     for retrying a failed iteration before giving up on the task.
 */

export interface RetryOpts {
  /** Maximum number of attempts (first call + retries). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms for the first backoff interval. Default: 2000 */
  baseDelayMs?: number;
  /** Upper cap on any single delay. Default: 30_000 */
  maxDelayMs?: number;
  /** Return true if the error warrants a retry. Default: isRetryableError */
  isRetryable?: (err: unknown) => boolean;
  /** Called before each retry with attempt number, error, and computed delay. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

// Patterns that signal a hard validation / protocol / quota error — never
// retryable. Categories mirror the non-retryable bucket in Hermes's
// error_classifier.py (auth_permanent, billing, model_not_found,
// provider_policy_blocked, format_error). See docs/hermes-reliability-audit.md
// → Change 2.
const NON_RETRYABLE_SUBSTRINGS = [
  // format_error / payload validation
  "invalid agent params",
  "must NOT",
  "INVALID_PARAMS",
  "NOT_FOUND",
  // billing (no point retrying — only credit refill / key rotation fixes it)
  "credit balance is too low",
  "insufficient_quota",
  "billing_hard_limit_reached",
  // auth_permanent (a transient auth blip would be "401" without the
  // permanent marker; we keep that bucket retryable via the 5xx/network paths)
  "auth_permanent",
  "invalid_api_key",
  "invalid x-api-key",
  // model_not_found / provider_policy_blocked
  "model_not_found",
  "provider_policy_blocked",
  // context-length overflow — recoverable by compressing the prompt, not by
  // retrying the same payload
  "context_length_exceeded",
  "prompt is too long",
];

/**
 * Default retryability classifier.
 * Returns true for transient network / infra / rate-limit failures.
 * Returns false for validation errors and other permanent failures.
 */
export function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  for (const sub of NON_RETRYABLE_SUBSTRINGS) {
    if (msg.includes(sub)) return false;
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return true;
  if (/rate.?limit|overloaded/i.test(msg)) return true;
  if (/fetch.?fail|network.?error/i.test(msg)) return true;
  if (/\b5\d\d\b/.test(msg)) return true; // HTTP 5xx in message
  return false;
}

/**
 * Retry `fn` with exponential backoff and jitter.
 *
 * delay = min(maxDelayMs, baseDelayMs * 2^(attempt-1)) + random(0..baseDelayMs)
 *
 * Throws the last error when attempts are exhausted or the error is
 * classified as non-retryable by `isRetryable`.
 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, opts?: RetryOpts): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 2_000;
  const maxDelayMs = opts?.maxDelayMs ?? 30_000;
  const isRetryable = opts?.isRetryable ?? isRetryableError;
  const onRetry = opts?.onRetry;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const expDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.random() * baseDelayMs;
      const delayMs = Math.floor(Math.min(maxDelayMs, expDelay + jitter));
      onRetry?.(attempt, err, delayMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ─── Iteration retry policy ──────────────────────────────────────────────
// Used by the orchestrator to decide whether a *failed iteration* (build
// error, tester FAIL, executor blocked) gets a fresh attempt before the
// outer iteration counter advances.

/** Reasons that warrant an iteration-level retry. */
export type IterationFailureReason = "error" | "blocked" | "test_fail" | "build_error";

export interface IterationRetryPolicy {
  /** Maximum retry attempts per iteration (not counting the original attempt). */
  maxRetries: number;
  /**
   * Backoff delay in ms per attempt. Indexed by attempt number minus 1
   * (so [5000, 15000, 30000] means: 5s before attempt 1's retry, 15s before
   * attempt 2's, etc). Last value applies to all remaining attempts.
   */
  backoffMs: number[];
  /** Failure reasons that trigger a retry; other reasons fail the task immediately. */
  retryOn: IterationFailureReason[];
}

export const DEFAULT_ITERATION_RETRY_POLICY: IterationRetryPolicy = {
  maxRetries: 3,
  backoffMs: [5_000, 15_000, 30_000],
  retryOn: ["error", "blocked", "test_fail"],
};

export interface IterationRetryRecord {
  /** 1-based outer iteration number this retry attempt belongs to. */
  iter: number;
  /** 1-based retry attempt within the iteration. */
  attempt: number;
  /** Why the prior attempt failed. */
  reason: IterationFailureReason;
  /** Timestamp the retry was decided. */
  at: number;
  /** Optional human-readable rationale (e.g. tester verdict summary). */
  rationale?: string;
}

export interface PlanIterationRetryInput {
  reason: IterationFailureReason;
  /** Number of retries already attempted on this iteration (0 = none yet). */
  priorAttempts: number;
  policy?: IterationRetryPolicy;
}

export interface PlanIterationRetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  attempt: number;
  /** Prompt preamble to feed back into the next attempt. */
  preamble: string;
}

/**
 * Decide whether to retry a failed iteration and how long to wait before doing so.
 * Returns shouldRetry=false when the retry budget is exhausted or the reason
 * is non-retryable per policy.
 */
export function planIterationRetry(input: PlanIterationRetryInput): PlanIterationRetryDecision {
  const policy = input.policy ?? DEFAULT_ITERATION_RETRY_POLICY;
  const attempt = input.priorAttempts + 1;

  if (!policy.retryOn.includes(input.reason)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      attempt,
      preamble: "",
    };
  }
  if (input.priorAttempts >= policy.maxRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      attempt,
      preamble: "",
    };
  }
  const idx = Math.min(input.priorAttempts, policy.backoffMs.length - 1);
  const delayMs = policy.backoffMs[idx] ?? policy.backoffMs[policy.backoffMs.length - 1] ?? 5_000;
  const reasonText =
    input.reason === "blocked"
      ? "the previous attempt was blocked"
      : input.reason === "test_fail"
        ? "the tester rejected the previous attempt"
        : input.reason === "build_error"
          ? "the builder errored on the previous attempt"
          : "the previous attempt errored";
  const preamble = `[retry ${attempt}/${policy.maxRetries}] ${reasonText} — try again with an adjusted approach.`;
  return { shouldRetry: true, delayMs, attempt, preamble };
}
