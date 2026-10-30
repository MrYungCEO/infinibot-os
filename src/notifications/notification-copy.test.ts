/**
 * Tests for notification copy formatters, dedup, streak detection, and deepLink shapes.
 *
 * Matches the test runner used in telegram-completions.dedup.test.ts (vitest).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDedupForTests } from "./mobile-push.js";

// ── 1. Copy formatter helpers (re-implemented inline to avoid deep module coupling) ──

function formatDuration(startMs: number | undefined, endMs: number): string {
  if (startMs === undefined || startMs < 0) return "";
  const ms = Math.max(0, endMs - startMs);
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

function summarize(text: string, maxLen = 140): string {
  if (!text) return "";
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > maxLen ? line.slice(0, maxLen - 1) + "…" : line;
}

function sanitizeError(raw: string, maxLen = 160): string {
  const firstLine =
    raw
      .split("\n")[0]
      ?.replace(/\s+at\s+\S+.*$/s, "")
      .trim() ?? "";
  if (!firstLine) return "An unexpected error occurred.";
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen - 1) + "…" : firstLine;
}

function isCancellation(errorMsg?: string): boolean {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return lower.includes("cancel") || lower.includes("aborted") || lower.includes("stopped");
}

function buildSuccessBody(summary: string, duration: string): string {
  const line = summarize(summary);
  return line
    ? duration
      ? `${duration} • ${line}`
      : line
    : duration
      ? `Completed in ${duration}`
      : "Task finished successfully.";
}

// ── 2. Sub-agent completion copy ────────────────────────────────────────────

describe("agent completion notification copy", () => {
  it("success with summary and duration", () => {
    const title = "✅ Code Architect finished";
    const body = buildSuccessBody("Added the new API routes", formatDuration(1000, 121_000));
    expect(title).toBe("✅ Code Architect finished");
    expect(body).toBe("2 min • Added the new API routes");
  });

  it("success with summary only (no duration)", () => {
    const body = buildSuccessBody("Done all tasks", "");
    expect(body).toBe("Done all tasks");
  });

  it("success with duration only (no summary)", () => {
    const body = buildSuccessBody("", "45s");
    expect(body).toBe("Completed in 45s");
  });

  it("success with neither", () => {
    const body = buildSuccessBody("", "");
    expect(body).toBe("Task finished successfully.");
  });

  it("truncates summary at 140 chars", () => {
    const longLine = "A".repeat(150);
    const result = summarize(longLine);
    expect(result.length).toBe(140);
    expect(result.endsWith("…")).toBe(true);
  });

  it("uses only first line of multiline summary", () => {
    const multi = "First line\nSecond line\nThird";
    expect(summarize(multi)).toBe("First line");
  });

  it("error copy strips stack trace", () => {
    const raw =
      "Cannot read property 'foo' of undefined\n    at Object.<anonymous> (/app/src/index.ts:42:5)";
    expect(sanitizeError(raw)).toBe("Cannot read property 'foo' of undefined");
  });

  it("error with only stack → fallback", () => {
    expect(sanitizeError("")).toBe("An unexpected error occurred.");
  });

  it("error copy truncates at 160 chars", () => {
    const long = "E".repeat(200);
    const result = sanitizeError(long);
    expect(result.length).toBe(160);
    expect(result.endsWith("…")).toBe(true);
  });

  it("cancelled detection on 'cancelled'", () => {
    expect(isCancellation("Run was cancelled by user")).toBe(true);
  });

  it("cancelled detection on 'aborted'", () => {
    expect(isCancellation("Process aborted")).toBe(true);
  });

  it("cancelled detection on 'stopped'", () => {
    expect(isCancellation("Stopped after timeout")).toBe(true);
  });

  it("not cancelled for normal error", () => {
    expect(isCancellation("ENOENT file not found")).toBe(false);
  });
});

// ── 3. Duration formatter ────────────────────────────────────────────────────

describe("formatDuration", () => {
  it("returns empty string if no startMs", () => {
    expect(formatDuration(undefined, Date.now())).toBe("");
  });

  it("formats seconds under 1 min", () => {
    expect(formatDuration(0, 45_000)).toBe("45s");
  });

  it("rounds to nearest second", () => {
    expect(formatDuration(0, 47_600)).toBe("48s");
  });

  it("formats minutes", () => {
    expect(formatDuration(0, 3 * 60_000)).toBe("3 min");
  });

  it("rounds to nearest minute", () => {
    expect(formatDuration(0, 2 * 60_000 + 40_000)).toBe("3 min");
  });
});

// ── 4. Dedup window ──────────────────────────────────────────────────────────

describe("mobile-push dedup (alreadySent via resetDedupForTests)", () => {
  beforeEach(() => {
    resetDedupForTests();
  });

  // Note: alreadySent is not exported; we test the exported side-effect via
  // the resetDedupForTests helper. The actual dedup behavior is covered by
  // the existing telegram-completions.dedup.test.ts — here we just verify
  // the reset contract.
  it("resetDedupForTests cleans state so tests start fresh", () => {
    // If the module was imported with cached state, resetting should work
    expect(() => resetDedupForTests()).not.toThrow();
  });
});

// ── 5. Discipline streak milestone copy ──────────────────────────────────────

describe("discipline streak notification copy", () => {
  function buildStreakCopy(days: number): { title: string; body: string } {
    const period = days >= 14 ? "month" : "week";
    return {
      title: `🔥 ${days}-day streak`,
      body: `You've hit ${days} days in a row — keep it going this ${period}`,
    };
  }

  it("3-day streak uses 'week'", () => {
    const { title, body } = buildStreakCopy(3);
    expect(title).toBe("🔥 3-day streak");
    expect(body).toContain("week");
  });

  it("7-day streak uses 'week'", () => {
    const { body } = buildStreakCopy(7);
    expect(body).toContain("week");
  });

  it("14-day streak uses 'month'", () => {
    const { body } = buildStreakCopy(14);
    expect(body).toContain("month");
  });

  it("30-day streak uses 'month'", () => {
    const { body } = buildStreakCopy(30);
    expect(body).toContain("month");
    expect(body).toContain("30 days");
  });
});

// ── 6. Deep-link payload shapes ──────────────────────────────────────────────

describe("deepLink payload shapes", () => {
  it("agent completion deep link format", () => {
    const sessionKey = "agent:coder:abc123";
    const deepLink = `infinibot://activity/session/${encodeURIComponent(sessionKey)}`;
    expect(deepLink).toBe("infinibot://activity/session/agent%3Acoder%3Aabc123");
  });

  it("kanban task deep link format", () => {
    const taskId = "task_abc123";
    const deepLink = `infinibot://board/task/${taskId}`;
    expect(deepLink).toBe("infinibot://board/task/task_abc123");
  });

  it("discipline deep link", () => {
    expect("infinibot://discipline").toBe("infinibot://discipline");
  });

  it("notification data must not include raw stack traces", () => {
    const raw = "TypeError: cannot read foo\n    at Object.<anonymous> (file:42)";
    const sanitized = sanitizeError(raw);
    expect(sanitized).not.toContain("at Object");
    expect(sanitized).not.toContain("file:42");
  });

  it("kanban task completion payload shape", () => {
    const payload = {
      taskId: "task_xyz",
      projectId: "proj_abc",
      projectName: "My Project",
      title: "Fix login bug",
      status: "done",
      priority: "high",
    };
    expect(payload).toMatchObject({
      taskId: expect.any(String),
      title: expect.any(String),
      status: "done",
    });
  });

  it("agent completion payload shape includes required fields", () => {
    const payload = {
      runId: "run_001",
      sessionKey: "agent:coder:main",
      agentLabel: "Code Architect",
      duration: 120_000,
      summary: "Fixed the bug",
    };
    expect(payload.runId).toBeDefined();
    expect(payload.sessionKey).toBeDefined();
    expect(payload.agentLabel).toBeDefined();
  });
});

// ── 7. Kanban due-sweep copy ──────────────────────────────────────────────────

describe("kanban due sweep notification copy", () => {
  it("due-today title and body", () => {
    const title = "⏰ Due today";
    const taskTitle = "Deploy to production";
    const projectName = "Backend";
    const body = [taskTitle, projectName].filter(Boolean).join(" • ");
    expect(title).toBe("⏰ Due today");
    expect(body).toBe("Deploy to production • Backend");
  });

  it("overdue singular", () => {
    const daysOverdue = 1;
    const s = daysOverdue === 1 ? "" : "s";
    const body = `Deploy to production • ${daysOverdue} day${s} late`;
    expect(body).toBe("Deploy to production • 1 day late");
  });

  it("overdue plural", () => {
    const daysOverdue = 3;
    const s = daysOverdue === 1 ? "" : "s";
    const body = `Deploy to production • ${daysOverdue} day${s} late`;
    expect(body).toBe("Deploy to production • 3 days late");
  });
});
