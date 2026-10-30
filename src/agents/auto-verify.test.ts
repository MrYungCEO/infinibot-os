import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAutoVerifyForTests,
  buildVerifierPrompt,
  maybeSpawnAutoVerifier,
  shouldAutoVerify,
  type VerifierSpawnFn,
} from "./auto-verify.js";

const tmpDirs: string[] = [];
function tmpArtifactsDir(): string {
  const d = mkdtempSync(join(tmpdir(), "auto-verify-"));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => __resetAutoVerifyForTests());
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function fakeSpawn(): { spawn: VerifierSpawnFn; calls: number[] } {
  const calls: number[] = [];
  const spawn: VerifierSpawnFn = () => {
    calls.push(Date.now());
    return { finalPromise: Promise.resolve(), pid: 12345 };
  };
  return { spawn, calls };
}

describe("shouldAutoVerify", () => {
  it("auto-enables when the task text contains Acceptance:", () => {
    expect(shouldAutoVerify({ task: "Do X.\nAcceptance: build green" })).toBe(true);
    expect(shouldAutoVerify({ task: "do x, acceptance:   tests pass" })).toBe(true);
  });

  it("stays off for plain tasks", () => {
    expect(shouldAutoVerify({ task: "Fix the login bug" })).toBe(false);
  });

  it("explicit verify param wins in both directions", () => {
    expect(shouldAutoVerify({ verifyParam: true, task: "no criteria here" })).toBe(true);
    // Even a task containing "Acceptance:" is NOT auto-verified when the
    // caller explicitly opted out — this is the knob the recursion guard
    // relies on if a verifier prompt were ever routed through the tool.
    expect(shouldAutoVerify({ verifyParam: false, task: "Acceptance: everything" })).toBe(false);
  });
});

describe("maybeSpawnAutoVerifier — recursion + single-flight guard", () => {
  const base = {
    task: "Build it.\nAcceptance: it builds",
    backendId: "claude-code" as const,
    workdir: "/tmp",
  };

  it("spawns exactly one verifier per run, even on duplicate finalize", async () => {
    const dir = tmpArtifactsDir();
    const { spawn, calls } = fakeSpawn();

    const first = await maybeSpawnAutoVerifier(
      { ...base, runId: "run-1", artifactsDir: dir, verifyEnabled: true },
      { spawn },
    );
    expect(first.spawned).toBe(true);
    expect(first.completed).toBe(true);

    const second = await maybeSpawnAutoVerifier(
      { ...base, runId: "run-1", artifactsDir: dir, verifyEnabled: true },
      { spawn },
    );
    expect(second.spawned).toBe(false);
    expect(second.reason).toMatch(/already spawned/);
    expect(calls).toHaveLength(1);
  });

  it("the on-disk marker blocks a re-spawn even after in-memory state resets (restart)", async () => {
    const dir = tmpArtifactsDir();
    const { spawn, calls } = fakeSpawn();
    await maybeSpawnAutoVerifier(
      { ...base, runId: "run-2", artifactsDir: dir, verifyEnabled: true },
      { spawn },
    );
    __resetAutoVerifyForTests(); // simulate a gateway restart losing memory
    const again = await maybeSpawnAutoVerifier(
      { ...base, runId: "run-2", artifactsDir: dir, verifyEnabled: true },
      { spawn },
    );
    expect(again.spawned).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never spawns when verify is not enabled — a verifier run (spawned directly via the backend, verifyEnabled always false) can therefore never recurse", async () => {
    const dir = tmpArtifactsDir();
    const { spawn, calls } = fakeSpawn();
    // The verifier's own prompt CONTAINS the original task text (including
    // "Acceptance:") — prove that text alone cannot re-trigger verification.
    const verifierPrompt = buildVerifierPrompt({ task: base.task, artifactsDir: dir });
    expect(verifierPrompt).toContain("Acceptance:");
    const res = await maybeSpawnAutoVerifier(
      { ...base, task: verifierPrompt, runId: "run-3", artifactsDir: dir, verifyEnabled: false },
      { spawn },
    );
    expect(res.spawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("kills + reports a verifier that exceeds the timeout", async () => {
    const dir = tmpArtifactsDir();
    const kill = vi.fn();
    const spawn: VerifierSpawnFn = () => ({
      finalPromise: new Promise(() => {}), // never resolves
      kill,
    });
    const res = await maybeSpawnAutoVerifier(
      { ...base, runId: "run-4", artifactsDir: dir, verifyEnabled: true },
      { spawn, timeoutMs: 20 },
    );
    expect(res.spawned).toBe(true);
    expect(res.completed).toBe(false);
    expect(res.reason).toMatch(/timeout/);
    expect(kill).toHaveBeenCalled();
  });

  it("a throwing spawner is contained (never throws into finalize)", async () => {
    const dir = tmpArtifactsDir();
    const spawn: VerifierSpawnFn = () => {
      throw new Error("binary missing");
    };
    const res = await maybeSpawnAutoVerifier(
      { ...base, runId: "run-5", artifactsDir: dir, verifyEnabled: true },
      { spawn },
    );
    expect(res.spawned).toBe(false);
    expect(res.reason).toMatch(/binary missing/);
  });
});
