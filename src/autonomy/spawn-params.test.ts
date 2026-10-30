/**
 * Unit tests for the shared spawn-parameter validator and the tool-result
 * sanitizer. Pins every constraint that the gateway would otherwise reject
 * with "invalid agent params" — guarantees the 64-char label regression
 * stays patched and keeps the framing-escape guard from regressing.
 *
 * See docs/hermes-reliability-audit.md → Phase 2 / Change 1.
 */

import { describe, it, expect } from "vitest";
import {
  validateSpawnParams,
  sanitizeToolResult,
  SpawnParamsError,
  SPAWN_LABEL_MAX,
  SPAWN_TASK_MAX,
  SPAWN_TIMEOUT_MIN_SEC,
  SPAWN_TIMEOUT_MAX_SEC,
  SPAWN_TIMEOUT_DEFAULT_SEC,
  TOOL_RESULT_SANITIZE_MAX,
} from "./spawn-params.js";

const baseInput = {
  agentId: "coder",
  label: "Build iter 1",
  task: "Do the thing.",
};

describe("validateSpawnParams: agentId", () => {
  it("rejects empty agentId", () => {
    expect(() => validateSpawnParams({ ...baseInput, agentId: "" })).toThrow(SpawnParamsError);
  });
  it("rejects whitespace-only agentId", () => {
    expect(() => validateSpawnParams({ ...baseInput, agentId: "   " })).toThrow(SpawnParamsError);
  });
  it("trims agentId", () => {
    expect(validateSpawnParams({ ...baseInput, agentId: "  coder  " }).agentId).toBe("coder");
  });
  it("error message uses gateway-compatible 'invalid agent params: at /agentId' shape", () => {
    try {
      validateSpawnParams({ ...baseInput, agentId: "" });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/^invalid agent params: at \/agentId:/);
    }
  });
});

describe("validateSpawnParams: label", () => {
  it("rejects empty label", () => {
    expect(() => validateSpawnParams({ ...baseInput, label: "" })).toThrow(SpawnParamsError);
  });
  it("rejects whitespace-only label", () => {
    expect(() => validateSpawnParams({ ...baseInput, label: "   " })).toThrow(SpawnParamsError);
  });
  it("returns short labels unchanged", () => {
    expect(validateSpawnParams({ ...baseInput, label: "short" }).label).toBe("short");
  });
  it("truncates a 200-char label with ellipsis to <= SPAWN_LABEL_MAX", () => {
    const long = "a".repeat(200);
    const v = validateSpawnParams({ ...baseInput, label: long });
    expect(v.label.length).toBeLessThanOrEqual(SPAWN_LABEL_MAX);
    expect(v.label.endsWith("…")).toBe(true);
  });
  it("returns 63-char label unchanged (boundary)", () => {
    const exactly = "x".repeat(SPAWN_LABEL_MAX);
    expect(validateSpawnParams({ ...baseInput, label: exactly }).label).toBe(exactly);
  });
  it("64-char regression: every label produced is <= SPAWN_LABEL_MAX", () => {
    // The exact title shape that produced the original failure.
    const title = "Consolodated Infinibot Projects and Sub Project Association";
    const v1 = validateSpawnParams({ ...baseInput, label: `Build iter 1 · ${title}` });
    const v2 = validateSpawnParams({ ...baseInput, label: `Test iter 1 · ${title}` });
    expect(v1.label.length).toBeLessThanOrEqual(SPAWN_LABEL_MAX);
    expect(v2.label.length).toBeLessThanOrEqual(SPAWN_LABEL_MAX);
  });
});

describe("validateSpawnParams: task", () => {
  it("rejects empty task", () => {
    expect(() => validateSpawnParams({ ...baseInput, task: "" })).toThrow(SpawnParamsError);
  });
  it("rejects whitespace-only task", () => {
    expect(() => validateSpawnParams({ ...baseInput, task: "   " })).toThrow(SpawnParamsError);
  });
  it("trims task", () => {
    expect(validateSpawnParams({ ...baseInput, task: "  hi  " }).task).toBe("hi");
  });
  it("rejects task longer than SPAWN_TASK_MAX (does not truncate silently)", () => {
    const huge = "x".repeat(SPAWN_TASK_MAX + 1);
    expect(() => validateSpawnParams({ ...baseInput, task: huge })).toThrow(/exceeds max/);
  });
  it("accepts task at exactly SPAWN_TASK_MAX", () => {
    const ok = "y".repeat(SPAWN_TASK_MAX);
    expect(validateSpawnParams({ ...baseInput, task: ok }).task.length).toBe(SPAWN_TASK_MAX);
  });
});

describe("validateSpawnParams: runTimeoutSeconds", () => {
  it("defaults missing timeout to SPAWN_TIMEOUT_DEFAULT_SEC", () => {
    expect(validateSpawnParams(baseInput).runTimeoutSeconds).toBe(SPAWN_TIMEOUT_DEFAULT_SEC);
  });
  it("defaults NaN to SPAWN_TIMEOUT_DEFAULT_SEC", () => {
    expect(
      validateSpawnParams({ ...baseInput, runTimeoutSeconds: Number.NaN }).runTimeoutSeconds,
    ).toBe(SPAWN_TIMEOUT_DEFAULT_SEC);
  });
  it("clamps below min", () => {
    expect(validateSpawnParams({ ...baseInput, runTimeoutSeconds: 1 }).runTimeoutSeconds).toBe(
      SPAWN_TIMEOUT_MIN_SEC,
    );
  });
  it("clamps above max", () => {
    expect(
      validateSpawnParams({ ...baseInput, runTimeoutSeconds: 999_999 }).runTimeoutSeconds,
    ).toBe(SPAWN_TIMEOUT_MAX_SEC);
  });
  it("passes through valid values", () => {
    expect(validateSpawnParams({ ...baseInput, runTimeoutSeconds: 600 }).runTimeoutSeconds).toBe(
      600,
    );
  });
});

describe("validateSpawnParams: error shape", () => {
  it("SpawnParamsError carries field name", () => {
    try {
      validateSpawnParams({ ...baseInput, label: "" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SpawnParamsError);
      expect((e as SpawnParamsError).field).toBe("label");
    }
  });
  it("error message matches retry classifier's non-retryable substring", async () => {
    // If this assertion fails, retry.ts NON_RETRYABLE_SUBSTRINGS no longer
    // matches what SpawnParamsError produces — a retried bad-params spawn
    // would burn cycles instead of failing fast.
    const { isRetryableError } = await import("./retry.js");
    try {
      validateSpawnParams({ ...baseInput, label: "" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(isRetryableError(e)).toBe(false);
    }
  });
});

describe("sanitizeToolResult", () => {
  it("strips opening + closing XML/HTML tags", () => {
    expect(sanitizeToolResult("<thinking>hi</thinking>")).toBe("hi");
  });
  it("strips markdown code fences", () => {
    expect(sanitizeToolResult("```json\nfoo\n```")).toBe("json\nfoo\n");
  });
  it("strips CDATA framing", () => {
    expect(sanitizeToolResult("<![CDATA[secret]]>")).toBe("secret");
  });
  it("caps to TOOL_RESULT_SANITIZE_MAX chars", () => {
    const huge = "x".repeat(TOOL_RESULT_SANITIZE_MAX + 50);
    expect(sanitizeToolResult(huge).length).toBe(TOOL_RESULT_SANITIZE_MAX);
  });
  it("returns empty string for non-string input", () => {
    expect(sanitizeToolResult(null as unknown as string)).toBe("");
    expect(sanitizeToolResult(undefined as unknown as string)).toBe("");
  });
  it("does not corrupt benign JSON output", () => {
    expect(sanitizeToolResult('{"runId":"abc","status":"ok"}')).toBe(
      '{"runId":"abc","status":"ok"}',
    );
  });
});
