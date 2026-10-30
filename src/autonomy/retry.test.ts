/**
 * Unit tests for retryWithBackoff and isRetryableError.
 * // COORDINATION: orch-self-heal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  retryWithBackoff,
  isRetryableError,
  planIterationRetry,
  DEFAULT_ITERATION_RETRY_POLICY,
} from "./retry.js";

// ─── isRetryableError ─────────────────────────────────────────────────────────

describe("isRetryableError", () => {
  it("returns false for label validation error (64-char limit)", () => {
    expect(
      isRetryableError(
        new Error("invalid agent params: at /label: must NOT have more than 64 characters"),
      ),
    ).toBe(false);
  });

  it("returns false for must NOT errors", () => {
    expect(isRetryableError(new Error("must NOT have more than 64 characters"))).toBe(false);
  });

  it("returns false for INVALID_PARAMS", () => {
    expect(isRetryableError(new Error("INVALID_PARAMS: bad request"))).toBe(false);
  });

  it("returns false for NOT_FOUND", () => {
    expect(isRetryableError(new Error("agent NOT_FOUND"))).toBe(false);
  });

  it("returns false for billing / quota errors (hermes parity)", () => {
    expect(
      isRetryableError(new Error("Your credit balance is too low to access the Claude API")),
    ).toBe(false);
    expect(isRetryableError(new Error("insufficient_quota: please upgrade plan"))).toBe(false);
    expect(isRetryableError(new Error("billing_hard_limit_reached"))).toBe(false);
  });

  it("returns false for permanent auth errors (hermes parity)", () => {
    expect(isRetryableError(new Error("auth_permanent: refresh exhausted"))).toBe(false);
    expect(isRetryableError(new Error("invalid_api_key supplied"))).toBe(false);
    expect(isRetryableError(new Error("invalid x-api-key header"))).toBe(false);
  });

  it("returns false for model_not_found / provider_policy_blocked", () => {
    expect(isRetryableError(new Error("model_not_found: claude-pluto"))).toBe(false);
    expect(isRetryableError(new Error("provider_policy_blocked by aggregator"))).toBe(false);
  });

  it("returns false for context-length overflow (compress, do not retry)", () => {
    expect(isRetryableError(new Error("context_length_exceeded — 250000 tokens"))).toBe(false);
    expect(isRetryableError(new Error("prompt is too long for the requested model"))).toBe(false);
  });

  it("returns true for ECONNRESET", () => {
    expect(isRetryableError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    expect(isRetryableError(new Error("connect ETIMEDOUT"))).toBe(true);
  });

  it("returns true for rate limit errors", () => {
    expect(isRetryableError(new Error("rate limit exceeded, slow down"))).toBe(true);
    expect(isRetryableError(new Error("server overloaded"))).toBe(true);
  });

  it("returns true for fetch failures", () => {
    expect(isRetryableError(new Error("fetch failed: network error"))).toBe(true);
  });

  it("returns false for unknown errors (safe default)", () => {
    expect(isRetryableError(new Error("some unknown problem"))).toBe(false);
  });
});

// ─── retryWithBackoff ─────────────────────────────────────────────────────────

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await retryWithBackoff(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and returns on success", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      if (++calls < 3) throw new Error("read ECONNRESET");
      return "recovered";
    });

    const promise = retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on validation errors (non-retryable)", async () => {
    const err = new Error("invalid agent params: at /label: must NOT have more than 64 characters");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryWithBackoff(fn, { maxAttempts: 3 })).rejects.toThrow("invalid agent params");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts maxAttempts (3) and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("read ECONNRESET"));
    const promise = retryWithBackoff(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 });
    // Attach rejection handler BEFORE running timers to avoid unhandled-rejection window
    const assertion = expect(promise).rejects.toThrow("ECONNRESET");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("planIterationRetry: returns shouldRetry=true on first error with policy default delay", () => {
    const d = planIterationRetry({ reason: "error", priorAttempts: 0 });
    expect(d.shouldRetry).toBe(true);
    expect(d.attempt).toBe(1);
    expect(d.delayMs).toBe(DEFAULT_ITERATION_RETRY_POLICY.backoffMs[0]);
    expect(d.preamble).toMatch(/retry 1\/3/);
  });

  it("planIterationRetry: increasing delays per attempt", () => {
    const d1 = planIterationRetry({ reason: "test_fail", priorAttempts: 0 });
    const d2 = planIterationRetry({ reason: "test_fail", priorAttempts: 1 });
    const d3 = planIterationRetry({ reason: "test_fail", priorAttempts: 2 });
    expect(d1.delayMs).toBe(5_000);
    expect(d2.delayMs).toBe(15_000);
    expect(d3.delayMs).toBe(30_000);
  });

  it("planIterationRetry: stops after maxRetries", () => {
    const d = planIterationRetry({
      reason: "error",
      priorAttempts: DEFAULT_ITERATION_RETRY_POLICY.maxRetries,
    });
    expect(d.shouldRetry).toBe(false);
  });

  it("planIterationRetry: does not retry on non-retryable reasons", () => {
    const d = planIterationRetry({
      reason: "build_error",
      priorAttempts: 0,
      policy: { maxRetries: 3, backoffMs: [1_000], retryOn: ["error"] },
    });
    expect(d.shouldRetry).toBe(false);
  });

  it("planIterationRetry: preamble describes failure reason", () => {
    const blocked = planIterationRetry({ reason: "blocked", priorAttempts: 0 });
    expect(blocked.preamble).toMatch(/blocked/);
    const testFail = planIterationRetry({ reason: "test_fail", priorAttempts: 0 });
    expect(testFail.preamble).toMatch(/tester rejected/);
  });

  it("calls onRetry before each retry with correct attempt number", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("read ECONNRESET"));
    const promise = retryWithBackoff(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      onRetry,
    });
    // Attach rejection handler BEFORE running timers to avoid unhandled-rejection window
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    // Two retries before the third attempt throws and is not retried
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect(onRetry.mock.calls[1][0]).toBe(2);
  });
});
