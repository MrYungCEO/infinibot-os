import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkflowRun } from "../controllers/workflows";
import {
  ago,
  fmtDuration,
  parseSteps,
  previewStepCount,
  statusOf,
} from "./workflows-model";

const run = (p: Partial<WorkflowRun>): WorkflowRun => ({
  id: "r",
  workflowId: "wf",
  workflowName: "WF",
  status: "completed",
  inputs: {},
  agent: "main",
  startedAt: new Date().toISOString(),
  ...p,
});

describe("statusOf", () => {
  it("is idle with no runs and no daemon", () => {
    expect(statusOf({ recentRuns: [], liveDaemons: [] }, { id: "wf" })).toBe("idle");
  });

  it("follows the newest run", () => {
    const ws = { recentRuns: [run({ status: "failed" }), run({ status: "completed" })], liveDaemons: [] };
    expect(statusOf(ws, { id: "wf" })).toBe("failed");
    expect(statusOf({ ...ws, recentRuns: [run({ status: "timeout" })] }, { id: "wf" })).toBe("failed");
    expect(statusOf({ ...ws, recentRuns: [run({ status: "pending" })] }, { id: "wf" })).toBe("running");
    expect(statusOf({ ...ws, recentRuns: [run({ status: "completed" })] }, { id: "wf" })).toBe("ok");
  });

  it("prefers a live daemon over run history; ignores stopped daemons", () => {
    const d = { runId: "r", workflowId: "wf", paused: false, stopped: false, iterationCount: 3, errorStreak: 0 };
    const ws = { recentRuns: [run({ status: "failed" })], liveDaemons: [d] };
    expect(statusOf(ws, { id: "wf" })).toBe("running");
    expect(statusOf({ ...ws, liveDaemons: [{ ...d, paused: true }] }, { id: "wf" })).toBe("paused");
    expect(statusOf({ ...ws, liveDaemons: [{ ...d, stopped: true }] }, { id: "wf" })).toBe("failed");
  });

  it("only counts runs for the requested workflow", () => {
    const ws = { recentRuns: [run({ workflowId: "other", status: "failed" })], liveDaemons: [] };
    expect(statusOf(ws, { id: "wf" })).toBe("idle");
  });
});

describe("parseSteps", () => {
  it("prefers top-level numbered items and keeps the first sentence", () => {
    const body = "# T\n\n## Steps\n1. **Extend, don't reinvent.** Study the backend.\n   1. nested\n2. Catalog store `x`.\n";
    expect(parseSteps(body)).toEqual(["Extend, don't reinvent.", "Catalog store x."]);
  });

  it("falls back to H2/H3 headings, then bullets", () => {
    expect(parseSteps("# Title\n## Plan\n### Ship it\n")).toEqual(["Plan", "Ship it"]);
    expect(parseSteps("- one\n- [two](http://x)\n")).toEqual(["one", "two"]);
    expect(parseSteps("")).toEqual([]);
  });

  it("truncates very long steps", () => {
    const [s] = parseSteps(`1. ${"a".repeat(120)}`);
    expect(s.length).toBeLessThanOrEqual(71);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("previewStepCount", () => {
  it("counts numbered markers in the flattened preview", () => {
    expect(previewStepCount("# X ## Steps 1. a 2. b 3. c")).toEqual({ n: 3, more: false });
    expect(previewStepCount("no steps here").n).toBe(0);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(420)).toBe("420ms");
    expect(fmtDuration(4200)).toBe("4.2s");
    expect(fmtDuration(125_000)).toBe("2m 5s");
    expect(fmtDuration(3_900_000)).toBe("1h 5m");
  });

  it("formats relative times", () => {
    expect(ago(undefined)).toBe("—");
    expect(ago("nope")).toBe("—");
    expect(ago(new Date().toISOString())).toBe("just now");
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(ago(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h ago");
  });
});

describe("workflows-glass.css", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "workflows-glass.css"), "utf8");

  it("never hides content at rest (low-power / reduced-motion kill animations)", () => {
    // Strip keyframes; any remaining `opacity: 0` must be on a decorative pseudo-element.
    const noKeyframes = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const rules = noKeyframes.match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const hidden = rules.filter((r) => /opacity:\s*0\s*;/.test(r));
    for (const r of hidden) {
      const selector = r.slice(0, r.indexOf("{")).trim();
      expect(selector, selector).toMatch(/::after|::before/);
    }
  });

  it("covers light theme, reduced motion and reduced transparency", () => {
    expect(css).toContain(':root[data-theme="light"] .wfg');
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-reduced-transparency: reduce");
    expect(css).toContain(":root.glass-reduced .wfg");
  });
});
