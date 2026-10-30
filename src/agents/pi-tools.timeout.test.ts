import { describe, expect, it, vi } from "vitest";
import { raceAbort, wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  LONG_TOOL_TIMEOUT_MS,
  resolveToolTimeoutMs,
  wrapToolWithExecutionTimeout,
} from "./pi-tools.timeout.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function tool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return { name, label: name, description: name, parameters: {} as never, execute };
}

/** A tool whose promise never settles and which ignores its abort signal. */
const hangForever = (seen?: { signal?: AbortSignal }) =>
  tool("kanban", async (_id, _args, signal) => {
    if (seen) seen.signal = signal;
    return await new Promise<never>(() => {});
  });

const textOf = (r: unknown) =>
  JSON.parse(((r as { content: Array<{ text: string }> }).content[0] as { text: string }).text);

describe("wrapToolWithExecutionTimeout", () => {
  it("turns a hung tool into an error result instead of waiting forever", async () => {
    const seen: { signal?: AbortSignal } = {};
    const wrapped = wrapToolWithExecutionTimeout(hangForever(seen), { timeoutMs: 50 });
    const t0 = Date.now();
    const result = await wrapped.execute("call_1", { action: "list_projects" }, undefined);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const body = textOf(result);
    expect(body).toMatchObject({ status: "error", tool: "kanban", timedOut: true });
    expect(body.error).toMatch(/tool kanban timed out after 0s/);
    // The signal handed to the tool is aborted so cooperative I/O stops.
    expect(seen.signal?.aborted).toBe(true);
  });

  it("passes a fast result through untouched", async () => {
    const wrapped = wrapToolWithExecutionTimeout(
      tool("web_fetch", async () => ({ content: [{ type: "text", text: "hi" }], details: {} })),
      { timeoutMs: 1_000 },
    );
    await expect(wrapped.execute("c", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "hi" }],
      details: {},
    });
  });

  it("propagates tool errors (not swallowed as timeouts)", async () => {
    const wrapped = wrapToolWithExecutionTimeout(
      tool("x", async () => {
        throw new Error("boom");
      }),
      { timeoutMs: 1_000 },
    );
    await expect(wrapped.execute("c", {}, undefined)).rejects.toThrow("boom");
  });

  it("logs a 'still running' watchdog before timing out", async () => {
    const { log } = await import("./pi-embedded-runner/logger.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const wrapped = wrapToolWithExecutionTimeout(hangForever(), {
        timeoutMs: 120,
        watchdogMs: 20,
      });
      await wrapped.execute("call_w", {}, undefined);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /kanban still running after/.test(l))).toBe(true);
      expect(lines.some((l) => /kanban timed out after/.test(l))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("an abort of the run still rejects promptly (abort wins over the deadline)", async () => {
    const run = new AbortController();
    const wrapped = wrapToolWithExecutionTimeout(
      wrapToolWithAbortSignal(hangForever(), run.signal),
      {
        timeoutMs: 60_000,
      },
    );
    const pending = wrapped.execute("c", {}, undefined);
    setTimeout(() => run.abort(), 20);
    const t0 = Date.now();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("resolveToolTimeoutMs", () => {
  it("uses the default for ordinary tools and the long budget for slow ones", () => {
    expect(resolveToolTimeoutMs("kanban", {})).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(resolveToolTimeoutMs("exec", {})).toBe(LONG_TOOL_TIMEOUT_MS);
    expect(resolveToolTimeoutMs("claude_coder", {})).toBe(LONG_TOOL_TIMEOUT_MS);
  });

  it("honours a longer timeout the call asked for, plus grace", () => {
    expect(resolveToolTimeoutMs("exec", { timeout: 1800 })).toBe(1_800_000 + 30_000);
    expect(resolveToolTimeoutMs("subagents_wait", { timeoutSec: 1200 })).toBe(1_200_000 + 30_000);
    // A shorter own timeout never shrinks the budget.
    expect(resolveToolTimeoutMs("web_fetch", { timeoutSeconds: 5 })).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it("can be overridden by INFINIBOT_TOOL_TIMEOUT_MS", () => {
    vi.stubEnv("INFINIBOT_TOOL_TIMEOUT_MS", "1234");
    try {
      expect(resolveToolTimeoutMs("kanban", {})).toBe(1234);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("raceAbort / wrapToolWithAbortSignal", () => {
  it("rejects a tool that ignores its signal as soon as the run aborts", async () => {
    const run = new AbortController();
    const wrapped = wrapToolWithAbortSignal(hangForever(), run.signal);
    const pending = wrapped.execute("c", {}, undefined);
    run.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to start when already aborted", async () => {
    const run = new AbortController();
    run.abort();
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const wrapped = wrapToolWithAbortSignal(tool("t", execute), run.signal);
    await expect(wrapped.execute("c", {}, undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves normally without an abort", async () => {
    await expect(raceAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
  });
});
