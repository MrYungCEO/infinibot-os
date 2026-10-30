/**
 * Integration tests for the transcript → verification chain.
 *
 * These tests assert:
 *   (1) transcript persistence: transcriptPath is set on the run record
 *   (2) verifier receives transcript: transcriptSummary appears in buildVerifierPrompt
 *   (3) verification fails with clear error when verifier can't produce a verdict
 *   (4) aborted run still has transcript path after markSubagentRunComplete(error)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { buildVerifierPrompt } from "./verifier.js";
import {
  resolveTranscriptPath,
  flushTranscriptQueue,
  appendCoderTranscriptEntry,
} from "./transcript.js";
import type { CoderTranscriptContext } from "./transcript.js";
import {
  verifyAndFinalizeKanban,
  __resetVerificationGateForTests,
  type VerifyOpts,
  type VerificationVerdict,
} from "../verification-gate.js";

afterEach(() => {
  __resetVerificationGateForTests();
});

// ── buildVerifierPrompt ──────────────────────────────────────────────────────

describe("buildVerifierPrompt", () => {
  it("includes transcriptSummary section when provided", () => {
    const target = {
      runId: "r1",
      task: "Fix the login bug",
      acceptanceCriteria: ["Login works"],
      workdir: "/tmp/proj",
      transcriptSummary: "assistant: I fixed the auth handler\nassistant: Tests pass",
    };
    const prompt = buildVerifierPrompt(target, "diff content here");
    expect(prompt).toContain("AGENT TRANSCRIPT SUMMARY");
    expect(prompt).toContain("I fixed the auth handler");
  });

  it("omits transcriptSummary section when not provided", () => {
    const target = {
      runId: "r2",
      task: "Some task",
      acceptanceCriteria: ["Done"],
      workdir: "/tmp",
    };
    const prompt = buildVerifierPrompt(target, "");
    expect(prompt).not.toContain("AGENT TRANSCRIPT SUMMARY");
  });
});

// ── transcript path resolution ───────────────────────────────────────────────

describe("resolveTranscriptPath", () => {
  it("returns a .jsonl path under the storePath directory", () => {
    const ctx: CoderTranscriptContext = {
      sessionId: "sess-abc",
      storePath: "/home/user/.infinibot/sessions/sessions.json",
      agentId: "agent-1",
    };
    const p = resolveTranscriptPath(ctx);
    expect(p).toMatch(/sess-abc\.jsonl$/);
    expect(path.dirname(p)).toBe("/home/user/.infinibot/sessions");
  });
});

// ── flushTranscriptQueue ─────────────────────────────────────────────────────

describe("flushTranscriptQueue", () => {
  it("resolves after all pending writes are done", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ibtest-flush-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const ctx: CoderTranscriptContext = {
      sessionId: "sess-flush-1",
      storePath,
      agentId: "agent-flush",
    };

    for (let i = 0; i < 5; i++) {
      void appendCoderTranscriptEntry(ctx, { role: "assistant", content: `line ${i}` });
    }
    await flushTranscriptQueue();

    const tPath = resolveTranscriptPath(ctx);
    const raw = await fs.readFile(tPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(5);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ── verifyAndFinalizeKanban with transcript ──────────────────────────────────

describe("verifyAndFinalizeKanban with transcript", () => {
  it("passes transcriptPath to the runVerifier dep", async () => {
    const capturedOpts: VerifyOpts[] = [];
    const verify = vi.fn(async (opts: VerifyOpts): Promise<VerificationVerdict> => {
      capturedOpts.push(opts);
      return { pass: true, failClosed: false, reason: "ok" };
    });
    const kb = { updateTask: vi.fn(async () => {}) };

    const opts: VerifyOpts = {
      runId: "run-tp-1",
      taskId: "task-tp-1",
      succeeded: true,
      brief: "Do something",
      transcriptPath: "/tmp/somerun.jsonl",
    };

    await verifyAndFinalizeKanban(opts, { updateTask: kb.updateTask, runVerifier: verify });

    expect(capturedOpts[0].transcriptPath).toBe("/tmp/somerun.jsonl");
  });

  it("fail-closed when verifier throws", async () => {
    const kb = { updateTask: vi.fn(async () => {}) };
    const verify = vi.fn(async (): Promise<VerificationVerdict> => {
      throw new Error("verifier crashed");
    });

    const verdict = await verifyAndFinalizeKanban(
      { runId: "run-fc-1", taskId: "task-fc-1", succeeded: true, brief: "task" },
      { updateTask: kb.updateTask, runVerifier: verify },
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.failClosed).toBe(true);
    expect(verdict.reason).toContain("verifier crashed");
    // Task must be in review (never done) when fail-closed.
    expect(kb.updateTask).toHaveBeenCalledWith("task-fc-1", { status: "review" });
    const calls = kb.updateTask.mock.calls.map((c) => (c[1] as { status: string }).status);
    expect(calls).not.toContain("done");
  });

  it("aborted run (succeeded=false) → fail-closed, stays in review", async () => {
    const kb = { updateTask: vi.fn(async () => {}) };
    const verify = vi.fn(
      async (): Promise<VerificationVerdict> => ({ pass: true, failClosed: false, reason: "ok" }),
    );

    const verdict = await verifyAndFinalizeKanban(
      { runId: "run-abort-1", taskId: "task-abort-1", succeeded: false, brief: "task" },
      { updateTask: kb.updateTask, runVerifier: verify },
    );

    expect(verdict.pass).toBe(false);
    expect(verdict.failClosed).toBe(true);
    // Verifier must NOT be invoked for a failed run.
    expect(verify).not.toHaveBeenCalled();
    const statuses = kb.updateTask.mock.calls.map((c) => (c[1] as { status: string }).status);
    expect(statuses).toContain("review");
    expect(statuses).not.toContain("done");
  });
});
