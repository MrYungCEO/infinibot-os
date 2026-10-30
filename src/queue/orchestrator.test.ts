import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { QueueStore } from "./store.js";
import { QueueOrchestrator, type OrchestratorOptions } from "./orchestrator.js";
import { FakeRunner, fakeAvailability, tickUntil } from "./test-helpers.js";
import type { EnqueueInput, QueuePhase } from "./types.js";

const FAST: OrchestratorOptions = {
  tickMs: 999_999,
  maxConcurrent: 4,
  retryBackoffMs: { base: 0, max: 0 },
  transientBackoffMs: { base: 0, max: 0 },
};

function setup(
  opts: OrchestratorOptions = {},
  unavailable: Parameters<typeof fakeAvailability>[0] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "queue-orch-"));
  const store = new QueueStore(dir);
  const runner = new FakeRunner();
  const availability = fakeAvailability(unavailable);
  const orch = new QueueOrchestrator(
    store,
    { runner, availability, contractPrompt: "CONTRACT" },
    { ...FAST, scratchRoot: join(dir, "work"), ...opts },
  );
  const add = (phases: QueuePhase[], extra: Partial<EnqueueInput> = {}) =>
    store.enqueue({ briefMd: "# Build the thing", phaseSpec: phases, workdir: dir, ...extra });
  return { dir, store, runner, availability, orch, add };
}

describe("queue orchestrator — CLI-universal phases", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("runs each phase on its own backend and advances only on a VERIFIED verdict", async () => {
    const e = t.add([
      { name: "design", brief: "d", agent: "claude", model: "anthropic/claude-sonnet-4-6" },
      { name: "build", brief: "b", agent: "codex", model: "gpt-5-codex" },
      { name: "review", brief: "r", agent: "opencode", model: "claude-sonnet-4-6" },
      { name: "docs", brief: "x", agent: "gemini-cli" },
      { name: "ship", brief: "s", agent: "main" },
    ]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const agents = t.runner.starts.map((s) => s.target.label);
    expect(agents).toEqual(["claude-code", "codex", "opencode", "gemini", "agent:main"]);
    // Per-backend model mapping.
    expect(t.runner.starts.map((s) => s.model)).toEqual([
      "claude-sonnet-4-6",
      "gpt-5-codex",
      "anthropic/claude-sonnet-4-6",
      undefined,
      undefined,
    ]);
    // Completion contract + queue context injected; later phases see earlier ones.
    expect(t.runner.starts[0].systemPrompt).toContain("CONTRACT");
    expect(t.runner.starts[2].prompt).toContain("Earlier phases");
    const attempts = t.store.listAttempts(e.id);
    expect(attempts.map((a) => [a.agent, a.outcome, a.verdict])).toEqual([
      ["claude-code", "passed", "verified"],
      ["codex", "passed", "verified"],
      ["opencode", "passed", "verified"],
      ["gemini", "passed", "verified"],
      ["agent:main", "passed", "verified"],
    ]);
    expect(attempts.every((a) => a.sessionId)).toBe(true);
  });

  it("an UNVERIFIED run never advances (exit 0 is not success) and retries on the SAME session", async () => {
    t.runner.script(
      "codex",
      { kind: "unverified", reasons: ["tests were never run"] },
      { kind: "verified" },
    );
    const e = t.add([{ name: "build", brief: "b", agent: "codex" }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const [a1, a2] = t.store.listAttempts(e.id);
    expect(a1.outcome).toBe("unverified");
    expect(a1.verdictReasons).toEqual(["tests were never run"]);
    expect(t.runner.starts[1].resumeSessionId).toBe(a1.sessionId);
    expect(a2.resumedSession).toBe(a1.sessionId);
    expect(t.runner.starts[1].prompt).toContain("tests were never run");
    expect(t.runner.starts[1].prompt).toMatch(/^Continue phase 1\/1/);
  });

  it("all attempts of a phase share the phase's evidence baseline (first attempt's HEAD)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "q-base-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const head0 = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    t.runner.script(
      "codex",
      {
        kind: "custom",
        verdict: "unverified",
        onSettle: () =>
          execFileSync("git", [
            "-C",
            repo,
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "work",
          ]),
      },
      { kind: "verified" },
    );
    const e = t.add([{ name: "p", brief: "", agent: "codex" }], { workdir: repo });
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.runner.starts.map((s) => s.baseCommit)).toEqual([head0, head0]);
    expect(t.store.listAttempts(e.id).map((a) => a.baseCommit)).toEqual([head0, head0]);
  });

  it("blocks with kind + fix after maxAttempts unverified attempts", async () => {
    t.runner.script("claude-code", { kind: "unverified" }, { kind: "unverified" });
    const e = t.add([{ name: "p", brief: "", agent: "claude-code", maxAttempts: 2 }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    const entry = t.store.get(e.id)!;
    expect(entry.blockedKind).toBe("unverified");
    expect(entry.fixHint).toMatch(/verification\.decide|queue retry/);
    expect(t.store.listAttempts(e.id)).toHaveLength(2);
  });

  it("gate is enforced after the verdict: failing gate retries with the output, passing gate advances", async () => {
    const marker = join(t.dir, "built.txt");
    t.runner.script(
      "opencode",
      { kind: "verified" },
      { kind: "custom", onSettle: () => writeFileSync(marker, "ok") },
    );
    const e = t.add([
      {
        name: "build",
        brief: "",
        agent: "opencode",
        gateCriteria: [
          {
            id: "c1",
            type: "shell",
            command: `test -f ${marker} && echo present || (echo missing-marker; exit 1)`,
          },
        ],
      },
    ]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const [a1, a2] = t.store.listAttempts(e.id);
    expect(a1.outcome).toBe("gate_failed");
    expect(a1.gate?.results[0].output).toContain("missing-marker");
    expect(t.runner.starts[1].prompt).toContain("missing-marker");
    expect(a2.outcome).toBe("passed");
    expect(a2.gate?.pass).toBe(true);
  });

  it("agent RESULT needs_input → blocked (not retried) with the open issues", async () => {
    t.runner.script("claude-code", { kind: "needs_input", issues: ["which DB to use?"] });
    const e = t.add([{ name: "p", brief: "" }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    const entry = t.store.get(e.id)!;
    expect(entry.blockedKind).toBe("needs_input");
    expect(entry.lastError).toContain("which DB to use?");
    expect(t.runner.starts).toHaveLength(1);
  });

  it("hung attempt: per-attempt timeout kills the process tree and retries", async () => {
    t.runner.script("codex", { kind: "hang" }, { kind: "verified" });
    const e = t.add([{ name: "p", brief: "", agent: "codex", timeoutSec: 0.05 }]);
    await t.orch.tick(); // dispatch
    await new Promise((r) => setTimeout(r, 80));
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.runner.kills[0].reason).toBe("phase attempt timeout");
    expect(t.store.listAttempts(e.id).map((a) => a.outcome)).toEqual(["timeout", "passed"]);
  });

  it("entry wall-clock budget blocks the entry", async () => {
    t.runner.script("codex", { kind: "hang" });
    const e = t.add([{ name: "p", brief: "", agent: "codex" }], { timeoutSec: 0.05 });
    await t.orch.tick();
    await new Promise((r) => setTimeout(r, 80));
    await t.orch.tick();
    expect(t.store.get(e.id)!.status).toBe("blocked");
    expect(t.store.get(e.id)!.blockedKind).toBe("timeout");
    expect(t.runner.kills).toHaveLength(1);
  });

  it("crash is transient: retried uncounted, dead-lettered after N in a row", async () => {
    const tt = setup({ maxTransientFailures: 3 });
    tt.runner.script("claude-code", { kind: "crash" }, { kind: "verified" });
    const ok = tt.add([{ name: "p", brief: "", maxAttempts: 1 }]);
    await tickUntil(
      () => tt.orch.tick(),
      () => tt.store.get(ok.id)!.status === "done",
    );
    expect(tt.store.listAttempts(ok.id).map((a) => [a.outcome, a.counted])).toEqual([
      ["crashed", false],
      ["passed", true],
    ]);

    tt.runner.script(
      "codex",
      { kind: "spawn_error" },
      { kind: "spawn_error" },
      { kind: "spawn_error" },
    );
    const bad = tt.add([{ name: "p", brief: "", agent: "codex" }]);
    await tickUntil(
      () => tt.orch.tick(),
      () => tt.store.get(bad.id)!.status === "dead",
    );
    const dead = tt.store.get(bad.id)!;
    expect(dead.lastError).toMatch(/dead-lettered after 3/);
    expect(dead.fixHint).toMatch(/queue logs/);
  });

  it("missing / unauthenticated CLI: clear block with fix, or the fallback agent runs", async () => {
    const tt = setup({}, { gemini: "not-installed", codex: "auth-required" });
    const noFb = tt.add([{ name: "p", brief: "", agent: "gemini" }]);
    const withFb = tt.add([{ name: "p", brief: "", agent: "codex", fallbackAgent: "claude-code" }]);
    await tickUntil(
      () => tt.orch.tick(),
      () => tt.store.get(withFb.id)!.status === "done",
    );
    const blocked = tt.store.get(noFb.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedKind).toBe("backend_unavailable");
    expect(blocked.lastError).toContain("not installed");
    expect(blocked.fixHint).toContain("install/login gemini");
    const [a] = tt.store.listAttempts(withFb.id);
    expect(a.agent).toBe("claude-code");
    expect(a.fallbackFrom).toBe("codex");
    expect(tt.runner.starts.some((s) => s.target.label === "gemini")).toBe(false);
  });

  it("a CLI auth failure blocks immediately with a login fix (no retries burned)", async () => {
    t.runner.script("codex", { kind: "auth_error" });
    const e = t.add([{ name: "p", brief: "", agent: "codex", maxAttempts: 3 }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    const entry = t.store.get(e.id)!;
    expect(entry.blockedKind).toBe("backend_unavailable");
    expect(entry.lastError).toContain("failed to authenticate");
    expect(entry.fixHint).toContain("codex login");
    expect(t.store.listAttempts(e.id).map((a) => [a.outcome, a.counted])).toEqual([
      ["unavailable", false],
    ]);
    expect(entry.phaseAttempts).toBe(0);
  });

  it("a retired/unavailable model blocks model_unavailable; retry --model switches it (recorded)", async () => {
    t.runner.script("opencode", { kind: "model_error" }, { kind: "verified" });
    const e = t.add([{ name: "p", brief: "", agent: "opencode", model: "ollama-cloud/glm-5.1" }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    const b = t.store.get(e.id)!;
    expect(b.blockedKind).toBe("model_unavailable");
    expect(b.fixHint).toContain("--model");
    await t.orch.retry(e.id, { model: "ollama/qwen3" });
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const attempts = t.store.listAttempts(e.id);
    expect(attempts.map((a) => [a.outcome, a.model, a.counted])).toEqual([
      ["unavailable", "ollama-cloud/glm-5.1", false],
      ["passed", "ollama/qwen3", true],
    ]);
    expect(t.store.get(e.id)!.phaseSpec[0].model).toBe("ollama/qwen3");
  });

  it("retry --agent moves the phase to another backend with a fresh session", async () => {
    t.runner.script("codex", { kind: "unverified" });
    const e = t.add([{ name: "p", brief: "", agent: "codex", maxAttempts: 1 }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    await t.orch.retry(e.id, { agent: "claude-code" });
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const last = t.runner.starts[t.runner.starts.length - 1];
    expect([last.target.label, last.resumeSessionId]).toEqual(["claude-code", null]);
  });

  it("cancel stops the running attempt (kill) and is terminal", async () => {
    t.runner.script("claude-code", { kind: "hang" });
    const e = t.add([{ name: "p", brief: "" }]);
    await t.orch.tick();
    expect(t.store.get(e.id)!.status).toBe("running");
    const after = await t.orch.cancel(e.id, "no longer needed");
    expect(after.status).toBe("canceled");
    expect(t.runner.kills.map((k) => k.reason)).toEqual(["no longer needed"]);
    expect(t.store.listAttempts(e.id)[0].outcome).toBe("canceled");
    await t.orch.tick();
    expect(t.runner.starts).toHaveLength(1);
    await expect(t.orch.cancel(e.id)).rejects.toThrow(/already canceled/);
  });

  it("pause: graceful parks after the attempt; force stops now (uncounted); resume continues the session", async () => {
    t.runner.script(
      "codex",
      { kind: "verified", polls: 2 },
      { kind: "hang" },
      { kind: "verified" },
    );
    const e = t.add([
      { name: "a", brief: "", agent: "codex" },
      { name: "b", brief: "", agent: "codex" },
    ]);
    await t.orch.tick(); // dispatch phase 1
    await t.orch.pause(e.id); // graceful
    expect(t.store.get(e.id)!.pauseRequested).toBe(true);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "paused",
    );
    expect(t.store.get(e.id)!.currentPhaseIdx).toBe(1);
    await t.orch.tick();
    expect(t.runner.starts).toHaveLength(1); // parked, nothing dispatched

    await t.orch.resume(e.id);
    await t.orch.tick(); // phase 2 starts (hang)
    await t.orch.pause(e.id, true); // force
    expect(t.store.get(e.id)!.status).toBe("paused");
    const a2 = t.store.listAttempts(e.id)[1];
    expect([a2.outcome, a2.counted]).toEqual(["interrupted", false]);
    await t.orch.resume(e.id);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.store.get(e.id)!.phaseAttempts).toBe(0);
  });

  it("retry reopens a blocked entry with an instruction (same session) or a fresh session", async () => {
    t.runner.script(
      "claude-code",
      { kind: "unverified" },
      { kind: "verified" },
      { kind: "verified" },
    );
    const e = t.add([{ name: "p", brief: "", maxAttempts: 1 }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    await expect(t.orch.retry(e.id, { fromPhase: 3 })).rejects.toThrow(/out of range/);
    await t.orch.retry(e.id, { instruction: "use sqlite" });
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.runner.starts[1].prompt).toContain("use sqlite");
    expect(t.runner.starts[1].resumeSessionId).toBe(t.store.listAttempts(e.id)[0].sessionId);
    expect(t.store.get(e.id)!.pendingInstruction).toBeNull();

    await t.orch.retry(e.id, { fromPhase: 0, freshSession: true });
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.runner.starts[2].resumeSessionId).toBeNull();
  });

  it("advance skips a running phase (killing it) and refuses terminal entries", async () => {
    t.runner.script("claude-code", { kind: "hang" });
    const e = t.add([
      { name: "a", brief: "" },
      { name: "b", brief: "" },
    ]);
    await t.orch.tick();
    const after = await t.orch.advance(e.id, "done by hand");
    expect(after.currentPhaseIdx).toBe(1);
    expect(t.runner.kills).toHaveLength(1);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    await expect(t.orch.advance(e.id)).rejects.toThrow(/cannot advance/);
  });

  it("operator ACCEPT of an unverified run unblocks the phase", async () => {
    t.runner.script("claude-code", { kind: "unverified" });
    const e = t.add([{ name: "p", brief: "", maxAttempts: 1 }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "blocked",
    );
    const a = t.store.listAttempts(e.id)[0];
    // Simulate verification.decide accept: the runner now reports "accepted".
    t.runner.runs.get(a.runId)!.behavior = { kind: "custom", verdict: "accepted" };
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.store.listAttempts(e.id)[0].verdict).toBe("accepted");
  });

  it("requireVerified:false lets the gate alone decide (verification unavailable)", async () => {
    t.runner.script("agent:ops", { kind: "exit", code: 1 });
    const e = t.add([
      { name: "p", brief: "", agent: "ops", requireVerified: false, gateCriteria: "$ true" },
    ]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
  });

  it("legacy verification-off exit-code path: exit≠0 is a counted failure", async () => {
    t.runner.script("claude-code", { kind: "exit", code: 2 }, { kind: "exit", code: 0 });
    const e = t.add([{ name: "p", brief: "" }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    expect(t.store.listAttempts(e.id).map((a) => a.outcome)).toEqual(["failed", "passed"]);
  });

  it("events + metrics are recorded", async () => {
    t.runner.script("codex", { kind: "unverified" }, { kind: "verified" });
    const e = t.add([{ name: "p", brief: "", agent: "codex" }]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const kinds = t.store.listEvents(e.id).map((ev) => ev.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "queue.entry.started",
        "queue.phase.started",
        "queue.phase.retrying",
        "queue.phase.completed",
        "queue.entry.done",
      ]),
    );
    const m = t.store.metrics();
    const codex = m.byAgent.find((x) => x.agent === "codex")!;
    expect([codex.attempts, codex.passed, codex.successRate]).toEqual([2, 1, 0.5]);
    expect(m.byStatus.done).toBe(1);
  });
});

describe("queue orchestrator — concurrency", () => {
  it("honours maxConcurrent and does not head-of-line block on a waiting entry", async () => {
    const t = setup({ maxConcurrent: 2 });
    t.runner.defaultBehavior = { kind: "hang" };
    const dep = t.add([{ name: "p", brief: "" }], { workdir: mkdtempSync(join(tmpdir(), "q-a-")) });
    const waiting = t.add([{ name: "p", brief: "" }], { dependsOn: [dep.id], priority: 10 });
    const b = t.add([{ name: "p", brief: "" }], { workdir: mkdtempSync(join(tmpdir(), "q-b-")) });
    const c = t.add([{ name: "p", brief: "" }], { workdir: mkdtempSync(join(tmpdir(), "q-c-")) });
    await t.orch.tick();
    const running = t.store.list({ status: "running" }).map((e) => e.id);
    expect(running).toHaveLength(2);
    expect(running).toEqual(expect.arrayContaining([dep.id, b.id]));
    expect(t.store.get(waiting.id)!.waitingReason).toMatch(/waiting for/);
    expect(t.store.get(c.id)!.status).toBe("queued");
  });

  it("two entries on the same repo without isolation run one at a time; isolation 'entry' runs them in parallel worktrees", async () => {
    const repo = mkdtempSync(join(tmpdir(), "q-repo-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const t = setup({ maxConcurrent: 4 });
    t.runner.defaultBehavior = { kind: "hang" };
    const a = t.add([{ name: "p", brief: "" }], { workdir: repo });
    const b = t.add([{ name: "p", brief: "" }], { workdir: repo });
    await t.orch.tick();
    expect(t.store.get(a.id)!.status).toBe("running");
    expect(t.store.get(b.id)!.status).toBe("queued");
    expect(t.store.get(b.id)!.waitingReason).toMatch(/repo busy/);

    const c = t.add([{ name: "p", brief: "" }], { workdir: repo, isolation: "entry" });
    const d = t.add([{ name: "p", brief: "" }], { workdir: repo, isolation: "entry" });
    await t.orch.tick();
    const wc = t.store.get(c.id)!;
    const wd = t.store.get(d.id)!;
    expect([wc.status, wd.status]).toEqual(["running", "running"]);
    expect(wc.worktrees.entry.path).not.toBe(wd.worktrees.entry.path);
    expect(existsSync(join(wc.worktrees.entry.path, ".git"))).toBe(true);
    expect(t.store.getAttemptByRunId(wc.currentRunId!)!.workdir).toBe(wc.worktrees.entry.path);
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "queue/*"], {
      encoding: "utf8",
    });
    expect(branches).toContain(`queue/${c.id.replace(/-/g, "").slice(0, 8)}`);
  });

  it("per-phase isolation branches each phase from the previous phase's branch", async () => {
    const repo = mkdtempSync(join(tmpdir(), "q-repo-p-"));
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const t = setup();
    t.runner.script("claude-code", {
      kind: "custom",
      onSettle: (p) => {
        writeFileSync(join(p.workdir, "p1.txt"), "x");
        execFileSync("git", ["-C", p.workdir, "add", "."]);
        execFileSync("git", [
          "-C",
          p.workdir,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "-m",
          "p1",
        ]);
      },
    });
    const e = t.add(
      [
        { name: "a", brief: "" },
        { name: "b", brief: "", gateCriteria: [{ type: "file", path: "p1.txt" }] },
      ],
      { workdir: repo, isolation: "phase" },
    );
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const wts = t.store.get(e.id)!.worktrees;
    expect(Object.keys(wts).sort()).toEqual(["p0", "p1"]);
    expect(existsSync(join(wts.p1.path, "p1.txt"))).toBe(true);
  });

  it("only the lease holder dispatches; the lease moves when its holder is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-lease-"));
    const s1 = new QueueStore(dir);
    const s2 = new QueueStore(dir);
    const r1 = new FakeRunner();
    const r2 = new FakeRunner();
    r1.defaultBehavior = r2.defaultBehavior = { kind: "hang" };
    const o1 = new QueueOrchestrator(s1, { runner: r1 }, { ...FAST, orchestratorId: "gw-1" });
    const o2 = new QueueOrchestrator(
      s2,
      { runner: r2 },
      { ...FAST, orchestratorId: "gw-2", leaseTtlMs: 30_000 },
    );
    s1.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], workdir: dir });
    await Promise.all([o1.tick(), o2.tick(), o1.tick(), o2.tick()]);
    expect(r1.starts.length + r2.starts.length).toBe(1);
    expect(o1.isLeader() !== o2.isLeader()).toBe(true);
    const [leader, standby] = o1.isLeader() ? [o1, o2] : [o2, o1];
    leader.stop(); // graceful shutdown releases the lease
    await standby.tick();
    expect(standby.isLeader()).toBe(true);
  });

  it("exactly-once: concurrent settles/advances of the same attempt apply once", async () => {
    const t = setup();
    const e = t.add([
      { name: "a", brief: "" },
      { name: "b", brief: "" },
    ]);
    // Two orchestrator objects over the SAME store racing the same entry.
    const other = new QueueOrchestrator(
      t.store,
      { runner: t.runner },
      { ...FAST, orchestratorId: t.orch.id },
    );
    await t.orch.tick();
    await Promise.all([t.orch.tick(), other.tick(), t.orch.tick()]);
    await tickUntil(
      () => t.orch.tick(),
      () => t.store.get(e.id)!.status === "done",
    );
    const passed = t.store.listAttempts(e.id).filter((a) => a.outcome === "passed");
    expect(passed.map((a) => a.phaseIdx)).toEqual([0, 1]);
    expect(
      t.store.listEvents(e.id).filter((ev) => ev.kind === "queue.phase.completed"),
    ).toHaveLength(2);
  });
});

describe("queue orchestrator — restart recovery", () => {
  it("a restart mid-phase re-attaches (still running) instead of blocking, and settles later — no double spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-restart-"));
    const store1 = new QueueStore(dir);
    const runner = new FakeRunner(); // durable runs outlive the gateway: same fake
    runner.script("codex", { kind: "verified", polls: 3 });
    const o1 = new QueueOrchestrator(store1, { runner }, { ...FAST, orchestratorId: "gw-before" });
    const e = store1.enqueue({
      briefMd: "",
      phaseSpec: [{ name: "p", brief: "", agent: "codex" }],
      workdir: dir,
    });
    await o1.tick();
    expect(runner.starts).toHaveLength(1);
    // Gateway dies without a clean stop (lease not released, pid still "alive" = ours).
    store1.close();
    const store2 = new QueueStore(dir);
    const o2 = new QueueOrchestrator(
      store2,
      { runner },
      { ...FAST, orchestratorId: "gw-after", leaseTtlMs: 30_000 },
    );
    // Same pid → lease holder check: stale holder is ours but a different owner id;
    // simulate an expired lease (dead process) by forcing expiry.
    store2.setMeta("lease_expires", "0");
    await tickUntil(
      () => o2.tick(),
      () => store2.get(e.id)!.status === "done",
    );
    expect(runner.starts).toHaveLength(1); // re-attached, not re-spawned
    expect(store2.listAttempts(e.id).map((a) => a.outcome)).toEqual(["passed"]);
  });

  it("an attempt whose process was lost across the restart is re-queued (uncounted) and resumes its session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-restart2-"));
    const store = new QueueStore(dir);
    const runner = new FakeRunner();
    runner.script("opencode", { kind: "hang" }, { kind: "verified" });
    const o1 = new QueueOrchestrator(store, { runner }, { ...FAST, orchestratorId: "gw-a" });
    const e = store.enqueue({
      briefMd: "",
      phaseSpec: [{ name: "p", brief: "", agent: "opencode", maxAttempts: 1 }],
      workdir: dir,
    });
    await o1.tick();
    const first = store.listAttempts(e.id)[0];
    runner.forget(first.runId); // the process died with the gateway
    o1.stop();
    const o2 = new QueueOrchestrator(store, { runner }, { ...FAST, orchestratorId: "gw-b" });
    await tickUntil(
      () => o2.tick(),
      () => store.get(e.id)!.status === "done",
    );
    const attempts = store.listAttempts(e.id);
    expect(attempts.map((a) => [a.outcome, a.counted])).toEqual([
      ["crashed", false],
      ["passed", true],
    ]);
    expect(runner.starts[1].resumeSessionId).toBe(first.sessionId);
  });

  it("an attempt claimed but never spawned (crash between claim and spawn) is recovered, not orphaned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-restart3-"));
    const store = new QueueStore(dir);
    const e = store.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], workdir: dir });
    store.claim({
      id: e.id,
      phaseIdx: 0,
      orchestratorId: "dead-gw",
      runId: "q-never-spawned",
      agent: "claude-code",
      backend: "claude-code",
      modelRequested: null,
      model: null,
      resumedSession: null,
      fallbackFrom: null,
      workdir: dir,
    });
    const runner = new FakeRunner();
    const o = new QueueOrchestrator(store, { runner }, FAST);
    await tickUntil(
      () => o.tick(),
      () => store.get(e.id)!.status === "done",
    );
    expect(store.listAttempts(e.id).map((a) => a.outcome)).toEqual(["crashed", "passed"]);
  });

  it("legacy (pre-upgrade) running rows without an attempt are blocked with a fix, not silently lost", async () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-legacy-"));
    const store = new QueueStore(dir);
    const e = store.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], workdir: dir });
    store.db
      .prepare("UPDATE queue_entries SET status='running', current_run_id='old-run' WHERE id=?")
      .run(e.id);
    const o = new QueueOrchestrator(store, { runner: new FakeRunner() }, FAST);
    await o.tick();
    const after = store.get(e.id)!;
    expect(after.status).toBe("blocked");
    expect(after.blockedKind).toBe("restart");
    expect(after.fixHint).toMatch(/queue retry/);
  });
});

describe("queue orchestrator — dependencies", () => {
  it("dependents of a canceled/dead entry are blocked with dependency_failed", async () => {
    const t = setup();
    t.runner.defaultBehavior = { kind: "hang" };
    const a = t.add([{ name: "p", brief: "" }]);
    const b = t.add([{ name: "p", brief: "" }], { dependsOn: [a.id] });
    await t.orch.tick();
    await t.orch.cancel(a.id);
    await t.orch.tick();
    const blocked = t.store.get(b.id)!;
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedKind).toBe("dependency_failed");
    expect(blocked.fixHint).toContain(a.id.slice(0, 8));
  });
});
