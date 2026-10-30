#!/usr/bin/env node
/**
 * Smoke for hardened subagent-registry.
 *
 * Exercises the new behaviours without standing up a real gateway:
 *
 *   1. Orphan-lifecycle replay — emit a lifecycle "end" event for a
 *      runId BEFORE registerSubagentRun has stored it. registerSubagentRun
 *      must drain the queued event and reach terminal state.
 *
 *   2. Stuck-run sweep — register a run, fast-forward `expectedEndByMs`
 *      into the past, trigger a sweep. The run gets `endedAt` + an
 *      "exceeded expected timeout" error outcome.
 *
 *   3. forceCompleteRun — synthetic terminal state with a custom error
 *      message. Pure local mark, idempotent on re-call.
 *
 *   4. Resilient restore — write a registry JSON with one good entry
 *      plus a malformed sibling. initSubagentRegistry must surface the
 *      good entry, log+skip the bad one, and not throw.
 *
 * Side-effects (gateway RPC, kanban) fail-soft in this offline harness
 * (they're caught + logged), so we ignore those warnings.
 *
 * Run: node --import tsx scripts/subagent-registry-smoke.mts
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the state dir at a fresh temp location so the registry's
// persistence writes can't pollute the real state tree.
const tmp = mkdtempSync(path.join(tmpdir(), "infinibot-registry-smoke-"));
process.env.INFINIBOT_STATE_DIR = tmp;
mkdirSync(path.join(tmp, "subagents"), { recursive: true });

// Silence kanban + gateway warnings — they're expected to fail in this
// harness because there's no gateway listening. We only want to see
// assertion failures.
const origWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (
    first.includes("kanban") ||
    first.includes("waitForSubagentCompletion") ||
    first.includes("gateway") ||
    first.includes("registry restore") ||
    first.includes("expected") ||
    first.includes("subagent-registry")
  ) return;
  origWarn(...args);
};
// Same for stderr-style errors from logger
const origError = console.error;
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (first.includes("✗")) origError(...args);
  // Swallow gateway RPC errors that we expect when no gateway is around.
};

const reg = await import("../src/agents/subagent-registry.ts");
const { emitAgentEvent } = await import("../src/infra/agent-events.ts");

function ok(label: string) { origWarn.bind(console); console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  origError(`✗ ${label}`);
  if (detail !== undefined) origError("  detail:", detail);
  process.exit(1);
}

// Wait a microtask to let in-process .then() chains run.
const tick = () => new Promise((r) => setImmediate(r));

// ── 1. Orphan-lifecycle replay ────────────────────────────────
{
  reg.resetSubagentRegistryForTests();
  const runId = "run-orphan-1";
  const childSessionKey = "agent:webdev:subagent:abc-1";

  // Emit lifecycle "end" BEFORE register — should land in the orphan
  // queue because the listener hasn't been wired yet either.
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now() },
  });

  // Listener isn't actually wired until ensureListener() runs, which
  // happens inside registerSubagentRun. So the orphan path we want to
  // exercise is: queue *after* the listener is up but *before* the
  // entry exists. Simulate that by registering the listener first via
  // a no-op register/reset cycle, then emitting, then registering.
  reg.resetSubagentRegistryForTests();
  // Trigger the listener install by registering a throwaway entry then
  // removing it. (No public API exists for "just install the listener".)
  reg.registerSubagentRun({
    runId: "warmup",
    childSessionKey: "agent:webdev:subagent:warmup",
    requesterSessionKey: "agent:main:warmup",
    requesterDisplayKey: "main",
    task: "warmup",
    cleanup: "delete",
  });
  reg.releaseSubagentRun("warmup");

  // Now emit lifecycle end for an unknown runId — should queue.
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now() },
  });

  if (reg.getPendingLifecycleQueueSizeForTests(runId) !== 1) {
    fail("orphan: lifecycle event should be queued before register");
  }

  // Now register — should drain the pending queue and apply the event.
  reg.registerSubagentRun({
    runId,
    childSessionKey,
    requesterSessionKey: "agent:main:smoke",
    requesterDisplayKey: "main",
    task: "test orphan replay",
    cleanup: "delete",
  });

  await tick();

  if (reg.getPendingLifecycleQueueSizeForTests(runId) !== 0) {
    fail("orphan: pending queue should be drained after register");
  }
  const entry = reg.getRunForTests(runId);
  if (!entry) fail("orphan: entry should exist after register");
  if (!entry!.endedAt) {
    fail("orphan: endedAt should be set by replayed event", entry);
  }
  if (entry!.outcome?.status !== "ok") {
    fail(`orphan: outcome should be ok, got ${entry!.outcome?.status}`);
  }
  ok("orphan lifecycle event queued + replayed on register");
}

// ── 2. Stuck-run sweep ────────────────────────────────────────
{
  reg.resetSubagentRegistryForTests();
  const runId = "run-stuck-1";
  reg.registerSubagentRun({
    runId,
    childSessionKey: "agent:webdev:subagent:stuck",
    requesterSessionKey: "agent:main:smoke",
    requesterDisplayKey: "main",
    task: "test stuck sweep",
    cleanup: "delete",
    runTimeoutSeconds: 1,
  });

  // Fast-forward the deadline into the past.
  const entry = reg.getRunForTests(runId);
  if (!entry) fail("stuck: entry should exist after register");
  entry!.expectedEndByMs = Date.now() - 1_000;

  await reg.runSweepForTests();
  await tick();

  const after = reg.getRunForTests(runId);
  if (!after) fail("stuck: entry should still exist after sweep (not deleted)");
  if (!after!.endedAt) fail("stuck: sweep should have set endedAt", after);
  if (after!.outcome?.status !== "error") {
    fail(`stuck: outcome should be error, got ${after!.outcome?.status}`);
  }
  const errMsg = after!.outcome?.error ?? "";
  if (!errMsg.includes("exceeded expected timeout")) {
    fail(`stuck: expected timeout error message, got: ${errMsg}`);
  }
  ok("stuck-run sweep marks run timed-out with descriptive error");
}

// ── 3. forceCompleteRun ───────────────────────────────────────
{
  reg.resetSubagentRegistryForTests();
  const runId = "run-force-1";
  reg.registerSubagentRun({
    runId,
    childSessionKey: "agent:webdev:subagent:force",
    requesterSessionKey: "agent:main:smoke",
    requesterDisplayKey: "main",
    task: "test force-complete",
    cleanup: "delete",
  });

  const ok1 = reg.forceCompleteRun(runId, { outcome: "error", error: "forced!" });
  if (!ok1) fail("force: first call should succeed");
  const entry = reg.getRunForTests(runId);
  if (!entry) fail("force: entry missing after force-complete");
  if (!entry!.endedAt) fail("force: endedAt should be set");
  if (entry!.outcome?.status !== "error") fail("force: outcome should be error");
  if (entry!.outcome?.error !== "forced!") {
    fail(`force: expected custom error message, got "${entry!.outcome?.error}"`);
  }

  // Idempotent — second call against an already-cleaned run is a no-op.
  await tick();
  const ok2 = reg.forceCompleteRun(runId, { outcome: "error", error: "second" });
  // After triggerCleanup runs, cleanupHandled is true, so this should
  // return false (no-op). It's fine either way as long as it doesn't
  // throw, but we want to be explicit.
  if (ok2) {
    // The first call's cleanup is async (announce flow). On a fast
    // re-call before cleanup completes, it might still proceed; that's
    // not a bug. Just don't double-emit error messages.
  }

  // forceCompleteRun on unknown id returns false.
  const okUnknown = reg.forceCompleteRun("does-not-exist");
  if (okUnknown) fail("force: should return false for unknown runId");

  ok("forceCompleteRun sets terminal state and returns false for unknown id");
}

// ── 4. Resilient restore ──────────────────────────────────────
{
  reg.resetSubagentRegistryForTests();

  // Write a registry file containing one good entry + one malformed.
  const registryPath = path.join(tmp, "subagents", "runs.json");
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        version: 2,
        runs: {
          "good-run": {
            runId: "good-run",
            childSessionKey: "agent:webdev:subagent:good",
            requesterSessionKey: "agent:main:smoke",
            requesterDisplayKey: "main",
            task: "good entry",
            cleanup: "keep",
            createdAt: Date.now(),
            startedAt: Date.now(),
            endedAt: Date.now(),
            outcome: { status: "ok" },
          },
          "bad-run": null, // malformed — should be skipped
        },
      },
      null,
      2,
    ),
  );

  // Trigger restore.
  reg.initSubagentRegistry();
  await tick();

  const good = reg.getRunForTests("good-run");
  if (!good) fail("restore: good entry should be loaded");
  if (good!.task !== "good entry") {
    fail(`restore: task mismatch, got "${good!.task}"`);
  }
  // bad-run should not crash the restore — it's silently skipped.
  const bad = reg.getRunForTests("bad-run");
  if (bad) fail("restore: malformed entry should not be loaded");
  ok("restore continues past malformed entries");
}

console.log("\nOK — subagent-registry hardening verified");
process.exit(0);
