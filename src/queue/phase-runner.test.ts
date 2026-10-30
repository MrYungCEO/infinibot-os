/**
 * Integration: the REAL phase runner + the REAL coder-backend layer + the
 * REAL verified-completion pipeline, driving fake `claude` / `codex` /
 * `opencode` / `gemini` binaries (src/queue/__fixtures__/fake-cli.mjs) on PATH.
 * Only the LLM judge and notification delivery are stubbed.
 *
 * Covers per backend: launch, completion contract injection, model flags,
 * session capture, premature exit → same-session continuation, crash / exit≠0
 * → retry resuming the session, hang → timeout kills the process tree,
 * missing binary → clear block or fallback, and the durable (tmux) path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { QueueStore } from "./store.js";
import { QueueOrchestrator } from "./orchestrator.js";
import { createPhaseRunner, detectAuthError, detectModelError } from "./phase-runner.js";
import { createAvailabilityCache } from "./backends.js";
import { COMPLETION_CONTRACT_PROMPT } from "../verification/contract.js";
import type { EnqueueInput } from "./types.js";

const FAKE = join(__dirname, "__fixtures__", "fake-cli.mjs");
const BINS = ["claude", "codex", "opencode", "gemini"];
let binDir = "";
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "fake-cli-bin-"));
  for (const b of BINS) symlinkSync(FAKE, join(binDir, b));
  setEnv("PATH", `${binDir}:${process.env.PATH}`);
  setEnv("INFINIBOT_DURABLE_SUBAGENTS", "0");
  // Auth for the availability probe (credential caches don't exist in the sandbox HOME).
  setEnv("ANTHROPIC_API_KEY", "test-key");
  setEnv("OPENAI_API_KEY", "test-key");
  setEnv("GEMINI_API_KEY", "test-key");
  setEnv("INFINIBOT_VERIFY_TELEGRAM", "off");
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(binDir, { recursive: true, force: true });
});

function repo(cfg: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "queue-it-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ".fake-cli*\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  writeFileSync(join(dir, ".fake-cli.json"), JSON.stringify(cfg));
  return dir;
}

function calls(dir: string): Array<{
  backend: string;
  resume: string | null;
  model: string | null;
  session: string;
  argv: string[];
  mode: string;
}> {
  const f = join(dir, ".fake-cli-calls.jsonl");
  // Ignore side spawns of the launcher's skill "heal" post-mortem (it runs `claude -p` on failures).
  return existsSync(f)
    ? readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter(
          (c) => !String(c.argv?.[c.argv.length - 1] ?? "").startsWith("A Claude Code task failed"),
        )
    : [];
}

const judge = async () => '{"verdict":"supported","unsupported_claims":[],"notes":"stub judge"}';

function makeQueue() {
  const store = new QueueStore(mkdtempSync(join(tmpdir(), "queue-it-state-")));
  const runner = createPhaseRunner({
    pipelineDeps: { judge, deliver: () => {}, mirrorReview: () => {}, rerunCommands: false },
  });
  const orch = new QueueOrchestrator(
    store,
    {
      runner,
      availability: createAvailabilityCache(),
      contractPrompt: COMPLETION_CONTRACT_PROMPT,
      autoApprove: () => true,
    },
    {
      tickMs: 999_999,
      maxConcurrent: 4,
      retryBackoffMs: { base: 0, max: 0 },
      transientBackoffMs: { base: 0, max: 0 },
    },
  );
  const add = (input: Omit<EnqueueInput, "briefMd"> & { briefMd?: string }) =>
    store.enqueue({ briefMd: "# Integration test entry", ...input });
  return { store, orch, runner, add };
}

async function drive(
  orch: QueueOrchestrator,
  done: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await orch.tick();
    if (done()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("queue did not settle in time");
}

describe("detectAuthError", () => {
  it("recognises real CLI auth failures and ignores normal output", () => {
    expect(
      detectAuthError(
        "x\nunexpected status 401 Unauthorized: Missing bearer or basic authentication in header\ny",
      ),
    ).toMatch(/Missing bearer/);
    expect(
      detectAuthError("Claude Code installed but not logged in. Please run `claude login`"),
    ).toBeTruthy();
    expect(detectAuthError("Error: Invalid API key · Please run /login")).toBeTruthy();
    expect(detectAuthError("all 12 tests passed; wrote auth middleware")).toBeNull();
    expect(
      detectModelError('{"message":"glm-5.1 was retired at 2026-09-25 00:00:00 -0700 PDT"}'),
    ).toMatch(/retired/);
    expect(
      detectModelError("usage credits auto reload payment failed, update your payment method"),
    ).toBeTruthy();
    expect(detectModelError("Implemented the model loader; tests pass")).toBeNull();
  });
});

describe("phase runner × real coder backends (fake CLIs)", () => {
  it("runs one entry across claude-code → codex → opencode → gemini with per-backend flags, contract and verified completion", async () => {
    const dir = repo({ codex: "premature", touch: "made-{backend}.txt" });
    const q = makeQueue();
    const e = q.add({
      workdir: dir,
      phaseSpec: [
        {
          name: "scaffold",
          brief: "p1",
          agent: "claude-code",
          model: "anthropic/claude-sonnet-4-6",
          gateCriteria: [{ type: "shell", command: "test -f made-claude-code.txt" }],
        },
        {
          name: "implement",
          brief: "p2",
          agent: "codex",
          model: "gpt-5-codex",
          gateCriteria: [{ type: "shell", command: "test -f made-codex.txt" }],
        },
        {
          name: "review",
          brief: "p3",
          agent: "opencode",
          model: "claude-sonnet-4-6",
          gateCriteria: [{ type: "shell", command: "test -f made-opencode.txt" }],
        },
        {
          name: "docs",
          brief: "p4",
          agent: "gemini",
          gateCriteria: [{ type: "shell", command: "test -f made-gemini.txt" }],
        },
      ],
    });
    await drive(q.orch, () =>
      ["done", "blocked", "dead", "failed"].includes(q.store.get(e.id)!.status),
    );
    const entry = q.store.get(e.id)!;
    expect(entry.status, entry.lastError ?? "").toBe("done");

    const c = calls(dir);
    const by = (b: string) => c.filter((x) => x.backend === b);
    // claude: contract via --append-system-prompt, model flag, stream-json print mode
    const cl = by("claude-code")[0];
    expect(cl.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--model",
        "claude-sonnet-4-6",
      ]),
    );
    expect(cl.argv[cl.argv.indexOf("--append-system-prompt") + 1]).toContain("Verified completion");
    // codex: premature exit → the verification pipeline resumed the SAME session (exec resume)
    const cx = by("codex");
    expect(cx).toHaveLength(2);
    expect(cx[0].model).toBe("gpt-5-codex");
    expect(cx[1].resume).toBe(cx[0].session);
    expect(cx[1].argv).toEqual(expect.arrayContaining(["exec", "resume", cx[0].session]));
    // opencode: provider-prefixed model
    expect(by("opencode")[0].argv).toEqual(expect.arrayContaining(["run", "--model"]));
    expect(by("opencode")[0].model).toBe("anthropic/claude-sonnet-4-6");
    // gemini: json output mode
    expect(by("gemini")[0].argv).toEqual(expect.arrayContaining(["-o", "json"]));

    const attempts = q.store.listAttempts(e.id);
    expect(attempts.map((a) => [a.agent, a.outcome, a.verdict])).toEqual([
      ["claude-code", "passed", "verified"],
      ["codex", "passed", "verified"],
      ["opencode", "passed", "verified"],
      ["gemini", "passed", "verified"],
    ]);
    // Session recorded per attempt = the backend's own session id.
    expect(attempts[0].sessionId).toBe(cl.session);
    expect(attempts[1].sessionId).toBe(cx[0].session);
    expect(attempts.every((a) => a.gate?.pass)).toBe(true);
  });

  it("exit≠0 and crash are retried on the SAME session per backend", async () => {
    const dir = repo({ opencode: ["fail", "success"], "claude-code": ["crash", "success"] });
    const q = makeQueue();
    const e = q.add({
      workdir: dir,
      phaseSpec: [
        { name: "a", brief: "", agent: "claude-code" },
        { name: "b", brief: "", agent: "opencode" },
      ],
    });
    await drive(q.orch, () => ["done", "blocked", "dead"].includes(q.store.get(e.id)!.status));
    expect(q.store.get(e.id)!.status, q.store.get(e.id)!.lastError ?? "").toBe("done");
    const cl = calls(dir).filter((x) => x.backend === "claude-code");
    // crash attempt printed its session before dying → retry resumes it
    expect(cl.length).toBeGreaterThanOrEqual(2);
    expect(cl[cl.length - 1].resume).toBe(cl[0].session);
    const attempts = q.store.listAttempts(e.id);
    // The crash (no RESULT) is continued INSIDE the verification pipeline on the
    // same session → one queue attempt; exit 1 fails verification → a counted
    // queue retry that resumes the session.
    expect(attempts.filter((a) => a.phaseIdx === 0).map((a) => a.outcome)).toEqual(["passed"]);
    expect(attempts.filter((a) => a.phaseIdx === 1).map((a) => a.outcome)).toEqual([
      "unverified",
      "passed",
    ]);
    const oc = calls(dir).filter((x) => x.backend === "opencode");
    expect(oc[1].resume).toBe(oc[0].session);
    // A queue retry that resumes the session still carries the completion contract
    // (opencode instructions / claude --append-system-prompt are per-invocation).
    expect([oc[0].contract, oc[1].contract]).toEqual([true, true]);
    expect(attempts[2].resumedSession).toBe(oc[0].session);
  });

  it("hang → per-attempt timeout kills the CLI and its grandchildren", async () => {
    const dir = repo({ codex: "hang" });
    const q = makeQueue();
    const e = q.add({
      workdir: dir,
      phaseSpec: [{ name: "a", brief: "", agent: "codex", timeoutSec: 2, maxAttempts: 1 }],
    });
    await drive(q.orch, () => q.store.get(e.id)!.status === "blocked", 30_000);
    expect(q.store.get(e.id)!.blockedKind).toBe("timeout");
    const cliPid = calls(dir)[0] as unknown as { pid: number };
    const grand = readFileSync(join(dir, ".fake-cli-grandchildren"), "utf8")
      .trim()
      .split("\n")
      .map(Number);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(cliPid.pid)).toBe(false);
    expect(grand.filter(alive)).toEqual([]);
  });

  it("missing binary: blocked with an install fix; with fallbackAgent the phase runs on the fallback", async () => {
    rmSync(join(binDir, "gemini"));
    try {
      const dir = repo({});
      const q = makeQueue();
      const blocked = q.add({
        workdir: dir,
        phaseSpec: [{ name: "a", brief: "", agent: "gemini" }],
      });
      await drive(q.orch, () => q.store.get(blocked.id)!.status === "blocked", 20_000);
      const b = q.store.get(blocked.id)!;
      expect(b.blockedKind).toBe("backend_unavailable");
      expect(b.lastError).toMatch(/gemini CLI is not installed/);
      expect(b.fixHint).toMatch(/npm i -g @google\/gemini-cli/);

      const dir2 = repo({});
      const fb = q.add({
        workdir: dir2,
        phaseSpec: [{ name: "a", brief: "", agent: "gemini", fallbackAgent: "codex" }],
      });
      await drive(q.orch, () => q.store.get(fb.id)!.status === "done", 30_000);
      const [a] = q.store.listAttempts(fb.id);
      expect([a.agent, a.fallbackFrom]).toEqual(["codex", "gemini"]);
    } finally {
      symlinkSync(FAKE, join(binDir, "gemini"));
    }
  });

  it("an unauthenticated CLI (401) blocks the phase with a login fix instead of retrying", async () => {
    const dir = repo({ codex: "unauth" });
    const q = makeQueue();
    const e = q.add({
      workdir: dir,
      phaseSpec: [{ name: "a", brief: "", agent: "codex", maxAttempts: 3 }],
    });
    await drive(q.orch, () => q.store.get(e.id)!.status === "blocked", 30_000);
    const b = q.store.get(e.id)!;
    expect(b.blockedKind).toBe("backend_unavailable");
    expect(b.fixHint).toContain("codex login");
    expect(q.store.listAttempts(e.id).map((a) => a.outcome)).toEqual(["unavailable"]);
  });

  it("cancel stops a running CLI immediately", async () => {
    const dir = repo({ "claude-code": "hang" });
    const q = makeQueue();
    const e = q.add({ workdir: dir, phaseSpec: [{ name: "a", brief: "" }] });
    await drive(
      q.orch,
      () => calls(dir).length > 0 && q.store.get(e.id)!.status === "running",
      20_000,
    );
    await new Promise((r) => setTimeout(r, 300));
    await q.orch.cancel(e.id, "test cancel");
    const pid = (calls(dir)[0] as unknown as { pid: number }).pid;
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
    expect(q.store.get(e.id)!.status).toBe("canceled");
  });
});

const hasTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)("phase runner — durable (tmux) path", () => {
  it("runs a CLI phase in a durable tmux session, then a fresh runner (simulated restart) settles it from disk", async () => {
    setEnv("INFINIBOT_DURABLE_SUBAGENTS", "1");
    try {
      const dir = repo({ codex: "slow", slowMs: 2500 });
      const stateDir = mkdtempSync(join(tmpdir(), "queue-it-durable-"));
      mkdirSync(stateDir, { recursive: true });
      const store = new QueueStore(stateDir);
      const mk = (id: string) =>
        new QueueOrchestrator(
          store,
          {
            runner: createPhaseRunner({
              pipelineDeps: {
                judge,
                deliver: () => {},
                mirrorReview: () => {},
                rerunCommands: false,
              },
            }),
            contractPrompt: COMPLETION_CONTRACT_PROMPT,
          },
          { tickMs: 999_999, orchestratorId: id },
        );
      const o1 = mk("before-restart");
      const e = store.enqueue({
        briefMd: "",
        workdir: dir,
        phaseSpec: [{ name: "a", brief: "", agent: "codex" }],
      });
      await o1.tick();
      const attempt = store.listAttempts(e.id)[0];
      const { durableRunDir, isDurableRunAlive } =
        await import("../agents/coder-backend/durable-spawn.js");
      expect(existsSync(durableRunDir(attempt.runId))).toBe(true);
      expect(isDurableRunAlive(attempt.runId)).toBe(true);
      o1.stop();
      // "Restart": a new orchestrator + a new runner with no in-memory state.
      const o2 = mk("after-restart");
      await drive(o2, () => store.get(e.id)!.status === "done", 90_000);
      expect(calls(dir)).toHaveLength(1); // re-attached, never re-spawned
      expect(store.listAttempts(e.id)[0].outcome).toBe("passed");
    } finally {
      setEnv("INFINIBOT_DURABLE_SUBAGENTS", "0");
    }
  });
});
