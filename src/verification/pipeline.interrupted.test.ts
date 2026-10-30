import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RESULT_CLOSE, RESULT_OPEN, type RunResult } from "./contract.js";
import { gitHead } from "./evidence.js";
import { markGatewayStopping, resetGatewayLifecycleForTests } from "./lifecycle.js";
import {
  reReviewRecord,
  recheckInterruptedRuns,
  superviseRunExit,
  type PipelineDeps,
} from "./pipeline.js";
import { runLlmReview, type JudgeFn } from "./reviewer.js";
import {
  createRecord,
  getRecord,
  isTerminal,
  listEvents,
  resetVerificationStoreForTests,
} from "./store.js";

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
  return `Done.\n${RESULT_OPEN}\n${JSON.stringify({ status: "done", summary: "fixed it", ...r })}\n${RESULT_CLOSE}`;
}

const SUPPORTED = '{"verdict":"supported","unsupported_claims":[],"notes":"ok"}';
const UNSUPPORTED =
  '{"verdict":"unsupported","unsupported_claims":[{"claim":"builds pass","why":"no log"}],"notes":""}';

let stateDir: string;
let repo: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function deps(judge: JudgeFn, delivered: string[] = []): PipelineDeps {
  return {
    judge,
    rerunCommands: false,
    mirrorReview: () => {},
    deliver: (rec) => {
      delivered.push(`${rec.runId}:${rec.state}`);
    },
  };
}

function open(runId: string) {
  return createRecord({
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:mcp-host-1-a",
    label: runId,
    task: "do the thing",
    backend: "claude-code",
    workdir: repo,
    baseCommit: gitHead(repo),
    startedAt: Date.now() - 1000,
  });
}

const CLAIMED = resultText({
  claims: [{ claim: "builds pass", evidence_type: "url", evidence_ref: "http://ci" }],
});

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "vc-int-state-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  resetVerificationStoreForTests();
  resetGatewayLifecycleForTests();
  repo = mkdtempSync(path.join(tmpdir(), "vc-int-repo-"));
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
  resetGatewayLifecycleForTests();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("restart-interrupted attempts", () => {
  it("f9fk: a continuation that cannot start (dist being rebuilt) parks the run as interrupted, then boot recheck settles it", async () => {
    open("f9fk");
    const delivered: string[] = [];
    let reviews = 0;
    const rec = await superviseRunExit({
      runId: "f9fk",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: async () => {
        throw new Error(
          "Cannot find module '/x/dist/agents/coder-backend/registry.js' imported from /x/dist/verification/coder-integration.js",
        );
      },
      deps: deps(async () => (reviews++ === 0 ? UNSUPPORTED : SUPPORTED), delivered),
    });
    expect(rec?.state).toBe("interrupted");
    expect(isTerminal(rec)).toBe(false);
    expect(rec?.attempts.at(-1)?.kind).toBe("interrupted");
    expect(rec?.attempts.at(-1)?.reasons[0]).toContain("continuation could not start");
    expect(delivered).toEqual([]);
    expect(listEvents({ runIds: ["f9fk"], types: ["run.terminal"] }).events).toHaveLength(0);

    const out = await recheckInterruptedRuns({
      bootedAt: Date.now() + 1,
      deps: deps(async () => SUPPORTED, delivered),
    });
    expect(out).toEqual([{ runId: "f9fk", before: "interrupted", after: "verified" }]);
    expect(getRecord("f9fk")?.state).toBe("verified");
    expect(delivered).toEqual(["f9fk:verified"]);
  });

  it("a continuation killed (137) while the gateway is stopping is interrupted, not FAILED", async () => {
    open("restart");
    let reviews = 0;
    const rec = await superviseRunExit({
      runId: "restart",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: async () => {
        markGatewayStopping();
        return { exitCode: 137, killed: true, rawOutput: "" };
      },
      deps: deps(async () => (reviews++ === 0 ? UNSUPPORTED : SUPPORTED)),
    });
    expect(rec?.state).toBe("interrupted");
    expect(rec?.review?.verdict).not.toBe("FAILED");
  });

  it("recheck skips runs a live durable process still owns", async () => {
    open("live");
    await superviseRunExit({
      runId: "live",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: async () => ({
        exitCode: null,
        killed: true,
        interrupted: true,
        rawOutput: "",
      }),
      deps: deps(async () => UNSUPPORTED),
    });
    const out = await recheckInterruptedRuns({
      isRunLive: () => true,
      deps: deps(async () => SUPPORTED),
    });
    expect(out).toEqual([]);
    expect(getRecord("live")?.state).toBe("interrupted");
  });

  it("interrupted before any RESULT → stalled on recheck (owner can Continue), never FAILED", async () => {
    open("nores");
    await superviseRunExit({
      runId: "nores",
      outcome: { exitCode: null, killed: true, interrupted: true, rawOutput: "" },
      spawnContinuation: null,
      deps: deps(async () => SUPPORTED),
    });
    expect(getRecord("nores")?.state).toBe("interrupted");
    const out = await recheckInterruptedRuns({ deps: deps(async () => SUPPORTED) });
    expect(out[0]).toMatchObject({ runId: "nores", after: "stalled" });
  });
});

describe("killed continuation after a complete attempt", () => {
  it("reviews the last complete RESULT instead of failing the run", async () => {
    open("killed");
    let reviews = 0;
    let spawned = 0;
    const rec = await superviseRunExit({
      runId: "killed",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: async () => {
        spawned++;
        return { exitCode: null, killed: true, rawOutput: "" };
      },
      deps: deps(async () => (reviews++ === 0 ? UNSUPPORTED : SUPPORTED)),
    });
    expect(spawned).toBe(1);
    expect(rec?.state).toBe("verified");
    expect(rec?.attempts.at(-1)?.reasons[0]).toContain("reviewed the last complete RESULT");
  });
});

describe("re-review (verification.review)", () => {
  it("settles a terminal UNVERIFIED record whose original review had no judge", async () => {
    open("rr");
    await superviseRunExit({
      runId: "rr",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: null,
      deps: deps(async () => ({
        text: "",
        judge: null,
        failures: [{ judge: "anthropic/claude-haiku-4-5", error: "No API key" }],
      })),
    });
    const before = getRecord("rr")!;
    expect(before.state).toBe("unverified");
    expect(before.review?.reasons.join(" ")).toContain("anthropic/claude-haiku-4-5: No API key");

    const res = await reReviewRecord("rr", {
      settle: true,
      deps: deps(async () => ({
        text: SUPPORTED,
        judge: "ollama-cloud/gpt-oss:120b",
        failures: [],
      })),
    });
    expect(res).toMatchObject({ before: "unverified", after: "verified" });
    const after = getRecord("rr")!;
    expect(after.review?.llm?.judge).toBe("ollama-cloud/gpt-oss:120b");
    expect(listEvents({ runIds: ["rr"], types: ["run.terminal"] }).events).toHaveLength(2);
  });

  it("without settle only the review changes", async () => {
    open("rr2");
    await superviseRunExit({
      runId: "rr2",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: null,
      deps: deps(async () => ""),
    });
    const res = await reReviewRecord("rr2", { deps: deps(async () => SUPPORTED) });
    expect(res?.outcome.verdict).toBe("VERIFIED");
    expect(getRecord("rr2")?.state).toBe("unverified");
  });
});

describe("runLlmReview", () => {
  it("records the judge and why other judges failed; passes an accept() parser", async () => {
    let accepted: ((t: string) => boolean) | undefined;
    const review = await runLlmReview({
      task: "t",
      result: null,
      evidence: {
        items: [],
        actualChangedFiles: [],
        actualCommits: [],
        diffText: "",
        failures: 0,
        warnings: 0,
        environmentSkips: 0,
        workspace: { top: null, branch: null, source: "none", isSeparateWorktree: false } as never,
      },
      finalText: "",
      judge: async (input) => {
        accepted = input.accept;
        return {
          text: SUPPORTED,
          judge: "openrouter/deepseek/deepseek-v4-flash",
          failures: [{ judge: "anthropic/claude-haiku-4-5", error: "No API key" }],
        };
      },
    });
    expect(review.available).toBe(true);
    expect(review.judge).toBe("openrouter/deepseek/deepseek-v4-flash");
    expect(review.judgeFailures).toHaveLength(1);
    expect(accepted?.("not json")).toBe(false);
    expect(accepted?.(SUPPORTED)).toBe(true);
  });
});

describe("re-review keeps specific states", () => {
  it("a stalled run that is still unverified stays stalled", async () => {
    open("st");
    await superviseRunExit({
      runId: "st",
      outcome: { exitCode: 0, rawOutput: stream(CLAIMED) },
      spawnContinuation: null,
      deps: deps(async () => UNSUPPORTED),
    });
    const { resettleRecord } = await import("./store.js");
    resettleRecord("st", "stalled");
    const res = await reReviewRecord("st", { settle: true, deps: deps(async () => UNSUPPORTED) });
    expect(res).toMatchObject({ before: "stalled", after: "stalled" });
  });
});
