import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSubagentsEventsTool,
  createSubagentsWaitTool,
} from "../agents/tools/verification-tools.js";
import { RESULT_CLOSE, RESULT_OPEN, type RunResult } from "./contract.js";
import { gitHead } from "./evidence.js";
import {
  applyDecision,
  superviseRunExit,
  type ContinuationRequest,
  type PipelineDeps,
} from "./pipeline.js";
import {
  createRecord,
  getRecord,
  listEvents,
  resetVerificationStoreForTests,
  waitForRuns,
} from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const W5 = readFileSync(path.join(here, "__fixtures__", "w5-premature-exit.stdout.log"), "utf8");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096, 7)]);

function stream(finalText: string, session = "sess-A"): string {
  return [
    { type: "system", subtype: "init", session_id: session },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: finalText }] },
      session_id: session,
    },
    { type: "result", subtype: "success", is_error: false, result: finalText, session_id: session },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
}

function resultText(r: Partial<RunResult>): string {
  return `Done.\n${RESULT_OPEN}\n${JSON.stringify({ status: "done", summary: "ok", ...r })}\n${RESULT_CLOSE}`;
}

let stateDir: string;
let repo: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps & { delivered: string[] } {
  const delivered: string[] = [];
  return {
    judge: async () => '{"verdict":"supported","unsupported_claims":[],"notes":"ok"}',
    rerunCommands: false,
    mirrorReview: () => {},
    deliver: (rec) => {
      delivered.push(`${rec.runId}:${rec.state}`);
    },
    ...over,
    delivered,
  };
}

function open(runId: string, requester = "agent:main:mcp-host-1-a") {
  return createRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: requester,
    label: runId,
    task: "do the thing",
    backend: "claude-code",
    workdir: repo,
    baseCommit: gitHead(repo),
    startedAt: Date.now() - 1000,
  });
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "vc-state-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  resetVerificationStoreForTests();
  repo = mkdtempSync(path.join(tmpdir(), "vc-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "README.md"), "x");
  git("add", ".");
  git("commit", "-qm", "base");
});

afterEach(() => {
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  resetVerificationStoreForTests();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("superviseRunExit", () => {
  it("W5: premature exit is resumed on the SAME session, then completes VERIFIED", async () => {
    open("w5");
    const d = deps();
    const calls: ContinuationRequest[] = [];
    const rec = await superviseRunExit({
      runId: "w5",
      outcome: { exitCode: 0, rawOutput: W5 },
      spawnContinuation: async (req) => {
        calls.push(req);
        writeFileSync(path.join(repo, "fix.ts"), "export {}");
        return {
          exitCode: 0,
          rawOutput: stream(resultText({ files_changed: ["fix.ts"] }), req.sessionId),
        };
      },
      deps: d,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("2b44e53c-57f8-41da-84c5-08766ec03e55");
    expect(calls[0].prompt).toMatch(/^Continue: you exited before finishing/);
    expect(calls[0].prompt).toMatch(/background task/);
    expect(calls[0].durableKey).toBe("w5-c2");
    expect(rec?.state).toBe("verified");
    expect(rec?.attempts.map((a) => a.kind)).toEqual(["premature", "complete"]);
    expect(d.delivered).toEqual(["w5:verified"]);
  });

  it("bounded: keeps exiting early → stalled after maxContinuations, delivered once", async () => {
    open("loop");
    const d = deps();
    let n = 0;
    const rec = await superviseRunExit({
      runId: "loop",
      outcome: { exitCode: 0, rawOutput: stream("I'll wait for the build to finish.") },
      spawnContinuation: async () => {
        n++;
        return { exitCode: 0, rawOutput: stream("Let me check the tests next.") };
      },
      deps: d,
    });
    expect(n).toBe(3);
    expect(rec?.state).toBe("stalled");
    expect(rec?.review?.verdict).toBe("UNVERIFIED");
    expect(d.delivered).toEqual(["loop:stalled"]);
    const terminal = listEvents({ types: ["run.terminal"] }).events;
    expect(terminal).toHaveLength(1);
  });

  it("visual change without screenshots → UNVERIFIED → continued with visual_verify → VERIFIED", async () => {
    open("css");
    const d = deps();
    writeFileSync(path.join(repo, "styles.css"), "body{color:red}");
    const prompts: string[] = [];
    const rec = await superviseRunExit({
      runId: "css",
      outcome: { exitCode: 0, rawOutput: stream(resultText({ files_changed: ["styles.css"] })) },
      spawnContinuation: async (req) => {
        prompts.push(req.prompt);
        const shot = path.join(stateDir, "shot.png");
        writeFileSync(shot, PNG);
        return {
          exitCode: 0,
          rawOutput: stream(
            resultText({
              files_changed: ["styles.css"],
              screenshots: [shot],
              claims: [
                { claim: "red text renders", evidence_type: "screenshot", evidence_ref: shot },
              ],
            }),
          ),
        };
      },
      deps: d,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/visual_verify/);
    expect(rec?.state).toBe("verified");
    expect(rec?.review?.visualFiles).toEqual(["styles.css"]);
    expect(rec?.review?.screenshots).toHaveLength(1);
  });

  it("never VERIFIED when the reviewer flags unsupported claims; FAILED when a re-run contradicts", async () => {
    open("claims");
    const r1 = await superviseRunExit({
      runId: "claims",
      outcome: {
        exitCode: 0,
        rawOutput: stream(
          resultText({
            claims: [{ claim: "no regressions", evidence_type: "url", evidence_ref: "http://x" }],
          }),
        ),
      },
      spawnContinuation: null,
      deps: deps({
        judge: async () =>
          '{"verdict":"unsupported","unsupported_claims":[{"claim":"no regressions","why":"no test run"}],"notes":""}',
      }),
    });
    expect(r1?.state).toBe("unverified");
    expect(r1?.review?.reasons.join(" ")).toMatch(/no regressions/);

    open("rerun");
    const r2 = await superviseRunExit({
      runId: "rerun",
      outcome: {
        exitCode: 0,
        rawOutput: stream(resultText({ checks_run: [{ command: "pnpm test", exit_code: 0 }] })),
      },
      spawnContinuation: null,
      deps: deps({
        rerunCommands: true,
        runCommand: async () => ({ code: 1, output: "1 failed", timedOut: false }),
      }),
    });
    expect(r2?.state).toBe("failed");
    expect(r2?.review?.verdict).toBe("FAILED");
  });

  it("identical reviewer reasons on consecutive attempts → needs_owner, no further looping", async () => {
    open("same");
    const judge = async () =>
      '{"verdict":"unsupported","unsupported_claims":[{"claim":"no regressions","why":"no test run"}],"notes":""}';
    const text = resultText({
      claims: [{ claim: "no regressions", evidence_type: "url", evidence_ref: "http://x" }],
    });
    let n = 0;
    const rec = await superviseRunExit({
      runId: "same",
      outcome: { exitCode: 0, rawOutput: stream(text) },
      spawnContinuation: async () => {
        n++;
        return { exitCode: 0, rawOutput: stream(text) };
      },
      deps: deps({ judge }),
    });
    expect(n).toBe(1);
    expect(rec?.state).toBe("needs_owner");
    expect(rec?.attempts).toHaveLength(2);
    expect(rec?.review?.reasons.join(" ")).toMatch(/no regressions/);
    const terminal = listEvents({ types: ["run.terminal"] }).events;
    expect(terminal.map((e) => e.state)).toEqual(["needs_owner"]);
  });

  it("environment-only re-run failures never FAIL or auto-continue the run", async () => {
    open("env");
    const spawn = vi.fn();
    const rec = await superviseRunExit({
      runId: "env",
      outcome: {
        exitCode: 0,
        rawOutput: stream(
          resultText({
            checks_run: [
              { command: "vitest run src/a.test.ts", exit_code: 0 },
              { command: "pnpm build", exit_code: 0 },
            ],
            claims: [
              {
                claim: "tests pass",
                evidence_type: "test",
                evidence_ref: "vitest run src/a.test.ts",
              },
              { claim: "build passes", evidence_type: "command", evidence_ref: "pnpm build" },
            ],
          }),
        ),
      },
      spawnContinuation: spawn,
      deps: deps({
        rerunCommands: true,
        runCommand: async (cmd) =>
          cmd.startsWith("vitest")
            ? { code: 127, output: "bash: line 1: vitest: command not found", timedOut: false }
            : {
                code: 1,
                output: "Expected version: >=22.12.0\nGot: v20.19.6\nengines.node field",
                timedOut: false,
              },
        judge: async () =>
          '{"verdict":"unsupported","unsupported_claims":[{"claim":"tests pass","why":"re-run exited 127"},{"claim":"build passes","why":"gateway re-run failed the engines check"}],"notes":""}',
      }),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(rec?.review?.verdict).not.toBe("FAILED");
    expect(rec?.state).toBe("verified");
    expect(rec?.review?.warnings?.length).toBeGreaterThan(0);
  });

  it("blocked RESULT is not auto-continued", async () => {
    open("blk");
    const spawn = vi.fn();
    const rec = await superviseRunExit({
      runId: "blk",
      outcome: {
        exitCode: 0,
        rawOutput: stream(
          `${RESULT_OPEN}{"status":"blocked","summary":"need creds","open_issues":["STRIPE_KEY"]}${RESULT_CLOSE}`,
        ),
      },
      spawnContinuation: spawn,
      deps: deps(),
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(rec?.state).toBe("blocked");
  });

  it("operator decisions: accept settles, continue reopens a new round", async () => {
    open("dec");
    await superviseRunExit({
      runId: "dec",
      outcome: { exitCode: 0, rawOutput: stream("Implemented it.") },
      spawnContinuation: null,
      deps: deps(),
    });
    expect(getRecord("dec")?.state).toBe("unverified");
    const spawned: ContinuationRequest[] = [];
    const res = await applyDecision({
      runId: "dec",
      action: "continue",
      by: "tester",
      spawnContinuation: async (req) => {
        spawned.push(req);
        return { exitCode: 0, rawOutput: stream(resultText({})) };
      },
      deps: deps(),
    });
    expect(res.ok).toBe(true);
    const done = await waitForRuns({ runIds: ["dec"], timeoutMs: 5000 });
    expect(done.done[0]?.state).toBe("verified");
    expect(done.done[0]?.round).toBe(2);
    expect(spawned[0].sessionId).toBe("sess-A");
    const acc = await applyDecision({ runId: "dec", action: "reject", by: "tester", deps: deps() });
    expect(acc.record?.state).toBe("rejected");
  });
});

describe("completion inbox + tools", () => {
  it("subagents_wait blocks until the run is terminal; subagents_events is cursor-based and session-scoped", async () => {
    open("w1", "agent:main:mcp-a");
    open("other", "agent:main:mcp-b");
    const wait = createSubagentsWaitTool();
    const pending = wait.execute("t1", { runIds: ["w1"], timeoutSec: 10 });
    await new Promise((r) => setTimeout(r, 50));
    void superviseRunExit({
      runId: "w1",
      outcome: { exitCode: 0, rawOutput: stream(resultText({})) },
      spawnContinuation: null,
      deps: deps(),
    });
    const res = (await pending) as {
      details: {
        done: Array<{ runId: string; verdict: string; verified: boolean }>;
        timedOut: boolean;
      };
    };
    expect(res.details.timedOut).toBe(false);
    expect(res.details.done[0]).toMatchObject({ runId: "w1", verdict: "VERIFIED", verified: true });

    const events = createSubagentsEventsTool({ agentSessionKey: "agent:main:mcp-a" });
    const first = (await events.execute("t2", { terminalOnly: true })) as {
      details: { events: Array<{ runId: string; run?: { verdict: string } }>; cursor: number };
    };
    expect(first.details.events.map((e) => e.runId)).toEqual(["w1"]);
    expect(first.details.events[0].run?.verdict).toBe("VERIFIED");
    const again = (await events.execute("t3", {
      cursor: first.details.cursor,
      terminalOnly: true,
    })) as {
      details: { events: unknown[] };
    };
    expect(again.details.events).toHaveLength(0);

    // Long-poll wakes up on the next terminal event for this session only.
    const lp = events.execute("t4", { cursor: first.details.cursor, waitSec: 5 });
    void superviseRunExit({
      runId: "other",
      outcome: { exitCode: 0, rawOutput: stream("x") },
      spawnContinuation: null,
      deps: deps(),
    });
    open("w2", "agent:main:mcp-a");
    void superviseRunExit({
      runId: "w2",
      outcome: { exitCode: 1, rawOutput: stream("crash") },
      spawnContinuation: null,
      deps: deps(),
    });
    const woke = (await lp) as { details: { events: Array<{ runId: string }> } };
    expect(woke.details.events.map((e) => e.runId)).toContain("w2");
    expect(woke.details.events.map((e) => e.runId)).not.toContain("other");
  });

  it("inbox survives a restart (events.jsonl + records.json reload)", async () => {
    open("persist");
    await superviseRunExit({
      runId: "persist",
      outcome: { exitCode: 0, rawOutput: stream(resultText({})) },
      spawnContinuation: null,
      deps: deps(),
    });
    resetVerificationStoreForTests();
    expect(getRecord("persist")?.state).toBe("verified");
    expect(listEvents({ runIds: ["persist"], types: ["run.terminal"] }).events).toHaveLength(1);
  });

  it("unknown runIds never hang subagents_wait", async () => {
    const res = await waitForRuns({ runIds: ["nope"], timeoutMs: 10_000 });
    expect(res.unknown).toEqual(["nope"]);
    expect(res.timedOut).toBe(false);
  });
});
