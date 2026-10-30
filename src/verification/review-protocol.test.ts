import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExitClassification } from "./classifier.js";
import {
  countRealConsoleErrors,
  isBenignConsoleMessage,
  partitionConsoleMessages,
} from "./console-noise.js";
import { RESULT_CLOSE, RESULT_OPEN, type RunResult } from "./contract.js";
import { collectEvidence, type RunCommandFn } from "./evidence.js";
import { expandBraces } from "./evidence-files.js";
import { superviseRunExit, type ContinuationRequest, type PipelineDeps } from "./pipeline.js";
import { pathArgs, resolveReplayCwd, resetReplayCwdCacheForTests } from "./replay-cwd.js";
import { decideEscalation, verdictKindFor } from "./review-dialogue.js";
import {
  REVIEW_ROUND_CAP,
  getReviewThread,
  listReviewThreads,
  readReviewThread,
  resetReviewThreadCacheForTests,
} from "./review-thread.js";
import { composeVerdict, type ReviewOutcome } from "./reviewer.js";
import { resolveRunWorkspace } from "./run-env.js";
import { resolveScreenshotRef } from "./screenshot-resolve.js";
import {
  createRecord,
  getRecord,
  resetVerificationStoreForTests,
  verificationRunDir,
} from "./store.js";
import { cdTargets, digestTranscript } from "./transcript.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4096, 7)]);

let stateDir: string;
let repo: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "package.json"), '{"name":"root"}');
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  mkdirSync(path.join(dir, "ui", "src", "ui", "views"), { recursive: true });
  writeFileSync(path.join(dir, "ui", "package.json"), '{"name":"ui"}');
  writeFileSync(path.join(dir, "ui", "src", "x.test.ts"), "test");
  writeFileSync(path.join(dir, "ui", "src", "ui", "views", "page.ts"), "export const a = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "rp-state-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  resetVerificationStoreForTests();
  resetReviewThreadCacheForTests();
  resetReplayCwdCacheForTests();
  repo = makeRepo();
});

afterEach(() => {
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  resetVerificationStoreForTests();
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// ── (c) benign headless warnings ────────────────────────────────────────────

describe("benign console classification", () => {
  it("treats headless GL driver chatter as benign and keeps real errors", () => {
    const msgs = [
      "[.WebGL-0x2b2c00a4f00]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels",
      "Automatic fallback to software WebGL has been deprecated. Please use the --enable-unsafe-swiftshader flag",
      "[GroupMarkerNotSet(crbug.com/242999)!:A0C0230054280000]Automatic fallback to software WebGL",
      "Failed to load resource: net::ERR_NETWORK_CHANGED https://fonts.googleapis.com/css2?family=Inter",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    ];
    const p = partitionConsoleMessages(msgs);
    expect(p.benign).toHaveLength(4);
    expect(p.errors).toEqual([msgs[4], msgs[5]]);
    expect(isBenignConsoleMessage("WebGL: INVALID_OPERATION: drawArrays: no buffer")).toBe(false);
    expect(
      isBenignConsoleMessage(
        "Failed to load resource: net::ERR_NETWORK_CHANGED (https://fonts.googleapis.com/css2?family=Inter)",
      ),
    ).toBe(true);
    expect(
      countRealConsoleErrors([
        { consoleErrors: msgs.slice(0, 3), pageErrors: [] },
        { consoleErrors: [msgs[4]], pageErrors: ["boom"] },
      ]),
    ).toEqual({ errors: 2, benign: 3 });
  });
});

// ── (a) cwd-aware replay ───────────────────────────────────────────────────

describe("replay cwd", () => {
  it("uses the declared cwd when the agent recorded one", () => {
    const r = resolveReplayCwd({
      command: "npx vitest run src/x.test.ts",
      declaredCwd: path.join(repo, "ui"),
      top: repo,
      fallbackCwd: repo,
    });
    expect(r).toEqual({ cwd: path.join(repo, "ui"), source: "declared" });
    const rel = resolveReplayCwd({
      command: "pnpm test",
      declaredCwd: "ui",
      top: repo,
      fallbackCwd: repo,
    });
    expect(rel?.cwd).toBe(path.join(repo, "ui"));
  });

  it("infers ui/ for a UI vitest run whose file args only exist there", () => {
    const r = resolveReplayCwd({
      command: "npx vitest run src/x.test.ts",
      top: repo,
      fallbackCwd: "/home/nowhere/clawd-main",
    });
    expect(r).toEqual({ cwd: path.join(repo, "ui"), source: "path-args" });
  });

  it("takes the cwd from a claim ref with a leading cd for the same command", () => {
    const r = resolveReplayCwd({
      command: "npx vitest run src/whatever.test.ts",
      top: repo,
      fallbackCwd: repo,
      claimRefs: ["cd ui && npx vitest run src/whatever.test.ts"],
    });
    expect(r).toEqual({ cwd: path.join(repo, "ui"), source: "claim-cd" });
  });

  it("resolves a relative `git -C sibling` against the tree's parent", () => {
    const sibling = path.join(path.dirname(repo), `${path.basename(repo)}-sib`);
    mkdirSync(sibling, { recursive: true });
    try {
      const r = resolveReplayCwd({
        command: `git -C ${path.basename(sibling)} status --short`,
        top: repo,
        fallbackCwd: repo,
      });
      expect(r?.cwd).toBe(path.dirname(repo));
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("extracts path-like args but not flags, programs or env", () => {
    expect(
      pathArgs(
        "PATH=/x:$PATH npx vitest run --config vitest.config.ts src/a.test.ts --reporter verbose",
      ),
    ).toEqual({
      files: ["vitest.config.ts", "src/a.test.ts"],
      dirs: [],
    });
    expect(pathArgs("git -C ../other status")).toEqual({ files: [], dirs: ["../other"] });
  });

  it("collectEvidence replays checks_run in the recorded / inferred cwd", async () => {
    const seen: string[] = [];
    const runCommand: RunCommandFn = async (cmd, cwd) => {
      seen.push(`${cmd} @ ${cwd}`);
      return {
        code: cwd.endsWith("/ui") ? 0 : 1,
        output: cwd.endsWith("/ui") ? "1 passed" : "No test files found, exiting with code 1",
        timedOut: false,
      };
    };
    const result: RunResult = {
      status: "done",
      summary: "ok",
      commits: [],
      files_changed: [],
      claims: [
        {
          claim: "ui tests pass",
          evidence_type: "test",
          evidence_ref: "npx vitest run src/x.test.ts",
        },
      ],
      checks_run: [
        { command: "npx vitest run src/x.test.ts", exit_code: 0 },
        {
          command: "npx vitest run src/x.test.ts --reporter dot",
          cwd: path.join(repo, "ui"),
          exit_code: 0,
        },
      ],
      screenshots: [],
      open_issues: [],
    };
    const ev = await collectEvidence({
      workdir: "/home/nowhere/clawd-main",
      agentDirs: [repo],
      baseCommit: null,
      runStartedAt: 0,
      result,
      runCommand,
    });
    const cmds = ev.items.filter((i) => i.kind === "command");
    expect(cmds.map((c) => c.status)).toEqual(["pass", "pass"]);
    expect(cmds.every((c) => c.cwd === path.join(repo, "ui"))).toBe(true);
    expect(ev.items.find((i) => i.kind === "claim")?.status).toBe("pass");
    expect(seen.every((s) => s.endsWith("/ui"))).toBe(true);
  });

  it("a failure that also fails at the base commit is pre-existing, not a contradiction", async () => {
    git(repo, "checkout", "-qb", "work");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "ui", "src", "y.ts"), "x");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "work");
    const runCommand: RunCommandFn = async () => ({ code: 1, output: "1 failed", timedOut: false });
    const ev = await collectEvidence({
      workdir: repo,
      baseCommit: base,
      runStartedAt: 0,
      runCommand,
      baselineRun: async () => ({ code: 1, output: "1 failed" }),
      result: {
        status: "done",
        summary: "ok",
        commits: [],
        files_changed: ["ui/src/y.ts"],
        claims: [],
        checks_run: [{ command: "pnpm test", exit_code: 0 }],
        screenshots: [],
        open_issues: [],
      },
    });
    const cmd = ev.items.find((i) => i.kind === "command")!;
    expect(cmd.status).toBe("warn");
    expect(cmd.baseline).toBe(true);
    expect(cmd.detail).toMatch(/pre-existing failure/);
  });
});

// ── workspace from the agent's transcript dirs ─────────────────────────────

describe("run workspace from agent dirs", () => {
  it("picks the tree whose working changes match files_changed, not the spawn dir", () => {
    const spawn = mkdtempSync(path.join(tmpdir(), "rp-spawn-"));
    git(spawn, "init", "-q");
    writeFileSync(path.join(repo, "ui", "src", "ui", "views", "page.ts"), "export const a = 2;\n");
    const ws = resolveRunWorkspace({
      workdir: spawn,
      agentDirs: [path.join(repo, "ui", "src")],
      result: {
        status: "done",
        summary: "",
        commits: [],
        files_changed: ["ui/src/ui/views/page.ts"],
        claims: [],
        checks_run: [],
        screenshots: [],
        open_issues: [],
      },
    });
    expect(ws.top).toBe(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim(),
    );
    expect(ws.source).toBe("agent-dirs");
    rmSync(spawn, { recursive: true, force: true });
  });

  it("transcripts yield the agent's working dirs and visual_verify capture dirs", () => {
    const raw = [
      { type: "system", subtype: "init", cwd: "/home/u/clawd-main", session_id: "s" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "cd /home/u/wt && pnpm test" } },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "/home/u/wt/src/a.ts" } },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "cd /home/u/wt && pnpm build" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: '{"outDir":"/home/u/.infinibot/verification/run-1/visual-mv6abcde"}',
            },
          ],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const d = digestTranscript(raw);
    expect(d.workdirs[0]).toBe("/home/u/wt");
    expect(d.workdirs).toContain("/home/u/clawd-main");
    expect(d.visualDirs).toEqual(["/home/u/.infinibot/verification/run-1/visual-mv6abcde"]);
    expect(cdTargets("echo x; cd '/a b' && ls")).toEqual(["/a b"]);
    // Codex: bash -lc wrapped commands + file_change items.
    const codex = [
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "/bin/bash -lc 'cd /home/u/live && pnpm typecheck'",
        },
      },
      {
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "/home/u/live/src/a.ts" }, { path: "/home/u/live/src/b.ts" }],
        },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    const cd = digestTranscript(codex);
    expect(cd.workdirs).toEqual(["/home/u/live", "/home/u/live/src"]);
  });
});

// ── (b) evidence resolution ────────────────────────────────────────────────

describe("screenshot evidence resolution", () => {
  it("resolves bare visual_verify ids by run id, dirs, braces and names next to a dir", () => {
    const runId = "coder-shots-1";
    const cap = path.join(verificationRunDir(runId), "visual-muk599y8");
    mkdirSync(cap, { recursive: true });
    writeFileSync(path.join(cap, "mesh__desktop__dark.png"), PNG);
    writeFileSync(path.join(cap, "mesh__mobile__dark.png"), PNG);
    const r1 = resolveScreenshotRef("visual_verify runs visual-muk599y8, visual-nope123", {
      runId,
    });
    expect(r1.files.map((f) => path.basename(f))).toEqual([
      "mesh__desktop__dark.png",
      "mesh__mobile__dark.png",
    ]);
    expect(r1.unresolved).toEqual(["visual-nope123"]);

    const shots = mkdtempSync(path.join(tmpdir(), "rp-shots-"));
    mkdirSync(path.join(shots, "new-a"));
    mkdirSync(path.join(shots, "new-b"));
    writeFileSync(path.join(shots, "new-a", "s.png"), PNG);
    writeFileSync(path.join(shots, "new-b", "s.png"), PNG);
    writeFileSync(path.join(shots, "01-off.png"), PNG);
    writeFileSync(path.join(shots, "02-on.png"), PNG);
    expect(resolveScreenshotRef(`${shots}/new-{a,b}/s.png`).files).toHaveLength(2);
    expect(resolveScreenshotRef(`${cap}/`).files).toHaveLength(2);
    expect(
      resolveScreenshotRef(`${shots}/01-off.png, 02-on.png`).files.map((f) => path.basename(f)),
    ).toEqual(["01-off.png", "02-on.png"]);
    expect(resolveScreenshotRef(`${path.dirname(cap)}/visual-*`).files).toHaveLength(2);
    expect(expandBraces("/x/{a,b}/{1,2}.png")).toEqual([
      "/x/a/1.png",
      "/x/a/2.png",
      "/x/b/1.png",
      "/x/b/2.png",
    ]);
    rmSync(shots, { recursive: true, force: true });
  });

  it("visual_verify captures of the run count even when RESULT.screenshots is empty", async () => {
    const runId = "coder-shots-2";
    const cap = path.join(verificationRunDir(runId), "visual-abc12345");
    mkdirSync(cap, { recursive: true });
    writeFileSync(path.join(cap, "page__desktop__dark.png"), PNG);
    writeFileSync(
      path.join(cap, "result.json"),
      JSON.stringify({
        assessment: { available: true, pass: true, summary: "renders" },
        consoleErrors: 3,
        failedRpcs: 0,
        shots: [
          {
            consoleErrors: [
              "[.WebGL-0x1]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels",
            ],
            pageErrors: [],
          },
        ],
      }),
    );
    const ev = await collectEvidence({
      workdir: repo,
      runId,
      baseCommit: null,
      runStartedAt: Date.now() - 60_000,
      rerunCommands: false,
      result: {
        status: "done",
        summary: "",
        commits: [],
        files_changed: [],
        claims: [
          { claim: "page renders", evidence_type: "screenshot", evidence_ref: "visual-abc12345" },
        ],
        checks_run: [],
        screenshots: [],
        open_issues: [],
      },
    });
    expect(ev.items.find((i) => i.kind === "screenshot")?.status).toBe("pass");
    expect(ev.items.find((i) => i.kind === "claim")?.status).toBe("pass");
    const visual = ev.items.find((i) => i.kind === "visual")!;
    expect(visual.status).toBe("pass");
    expect(visual.detail).toMatch(/0 console error\(s\) \(\+1 benign/);
  });
});

describe("superseded vision assessments", () => {
  it("a newer passing capture of the same route+viewport supersedes an older failure", async () => {
    const runId = "coder-shots-3";
    const mk = async (id: string, names: string[], pass: boolean, at: number) => {
      const dir = path.join(verificationRunDir(runId), id);
      mkdirSync(dir, { recursive: true });
      for (const n of names) writeFileSync(path.join(dir, n), PNG);
      writeFileSync(
        path.join(dir, "result.json"),
        JSON.stringify({ assessment: { available: true, pass, summary: pass ? "ok" : "broken" } }),
      );
      utimesSync(path.join(dir, "result.json"), new Date(at), new Date(at));
    };
    const now = Date.now();
    await mk(
      "visual-old11111",
      ["wb__desktop__dark.png", "wb__mobile__dark.png"],
      false,
      now - 5000,
    );
    await mk("visual-new22222", ["wb__desktop__dark.png"], true, now - 1000);
    const run = () =>
      collectEvidence({
        workdir: repo,
        runId,
        baseCommit: null,
        runStartedAt: now - 60_000,
        rerunCommands: false,
        result: {
          status: "done",
          summary: "",
          commits: [],
          files_changed: [],
          claims: [],
          checks_run: [],
          screenshots: [],
          open_issues: [],
        },
      });
    // Mobile was never re-checked → the old failure still stands.
    expect(
      (await run()).items
        .filter((i) => i.kind === "visual")
        .map((i) => i.status)
        .sort(),
    ).toEqual(["fail", "pass"]);
    await mk("visual-new33333", ["wb__mobile__dark.png"], true, now - 500);
    const v = (await run()).items.filter((i) => i.kind === "visual");
    expect(v.map((i) => i.status).sort()).toEqual(["pass", "pass", "warn"]);
    expect(v.find((i) => i.status === "warn")?.detail).toMatch(
      /superseded by newer passing capture/,
    );
  });
});

// ── (d) scope + escalation + round cap ─────────────────────────────────────

function classification(result: Partial<RunResult> | null): ExitClassification {
  return {
    kind: result ? "complete" : "no_result",
    reasons: [],
    result: result
      ? {
          status: "done",
          summary: "s",
          commits: [],
          files_changed: [],
          claims: [],
          checks_run: [],
          screenshots: [],
          open_issues: [],
          ...result,
        }
      : null,
  };
}

const emptyEvidence = {
  items: [],
  actualChangedFiles: [],
  actualCommits: [],
  diffText: "",
  failures: 0,
  warnings: 0,
  environmentSkips: 0,
  workspace: { top: null, source: "none" as const, branch: null, isSeparateWorktree: false },
};

describe("reviewer scope", () => {
  it("incidental unsupported claims become notes, not blocking demands", () => {
    const out = composeVerdict({
      classification: classification({}),
      evidence: {
        ...emptyEvidence,
        items: [
          {
            kind: "claim",
            ref: "Live checkout has foreign uncommitted changes ← git -C IB-live-release status",
            status: "fail",
            detail: "exit 128",
          },
        ],
      },
      visualFiles: [],
      llm: {
        available: true,
        verdict: "unsupported",
        unsupportedClaims: [
          {
            claim: "Live checkout has foreign uncommitted changes",
            why: "no evidence",
            critical: false,
          },
        ],
        incidentalClaims: ["Live checkout has foreign uncommitted changes"],
        notes: "",
      },
    });
    expect(out.verdict).toBe("VERIFIED");
    expect(out.fixable).toEqual([]);
    expect(out.warnings.join("\n")).toMatch(/incidental claim/);
  });
});

describe("challenge items", () => {
  it("asks once per missing artefact, with exact re-run instructions for contradicted checks", async () => {
    const { challengeItems } = await import("./review-dialogue.js");
    const shot = "/tmp/w/evidence/demo.png";
    const items = challengeItems(
      {
        verdict: "UNVERIFIED",
        reasons: [],
        fixable: [
          `screenshot evidence failed: ${shot} — file does not exist`,
          `claim evidence failed: demo captured ← ${shot} — screenshot: file does not exist`,
          `back this claim with evidence or drop it: "demo captured" (no file at ${shot}. Run make-shot.mjs from /tmp/w, then resubmit.)`,
          "`pnpm test` fails when re-run — fix it and re-run it",
        ],
        warnings: [],
        visualFiles: [],
        visualSatisfied: true,
        llm: null,
      },
      [
        {
          kind: "command",
          ref: "pnpm test",
          status: "fail",
          detail: "claimed exit 0 but re-run exited 1 in /w/ui: 2 failed",
          cwd: "/w/ui",
        },
      ],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatch(/fails when I re-run it in \/w\/ui/);
    expect(items[1]).toMatch(/screenshot evidence failed/);
  });

  it("a dependency-free package needs no node_modules to re-run node --test", async () => {
    const { preflightProblem } = await import("./run-env.js");
    const dir = mkdtempSync(path.join(tmpdir(), "rp-nodeps-"));
    writeFileSync(path.join(dir, "package.json"), '{"name":"x","type":"module"}');
    expect(preflightProblem("node --test a.test.mjs", dir, dir)).toBeNull();
    writeFileSync(path.join(dir, "package.json"), '{"name":"x","devDependencies":{"vitest":"1"}}');
    expect(preflightProblem("npx vitest run", dir, dir)).toMatch(/node_modules missing/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("escalation policy", () => {
  const unverified: ReviewOutcome = {
    verdict: "UNVERIFIED",
    reasons: ["visual files changed but no valid screenshots"],
    fixable: ["call visual_verify"],
    warnings: [],
    visualFiles: [],
    visualSatisfied: false,
    llm: null,
  };

  it("ordinary gaps are not escalated", () => {
    expect(
      decideEscalation({
        classification: classification({}),
        outcome: unverified,
        repeated: false,
        items: [],
      }),
    ).toBeNull();
  });

  it("blocked runs escalate with the exact decision, by category", () => {
    const creds = decideEscalation({
      classification: classification({
        status: "blocked",
        open_issues: ["OPENAI_API_KEY is not set on this host"],
      }),
      outcome: unverified,
      repeated: false,
      items: [],
    });
    expect(creds?.category).toBe("credentials");
    expect(creds?.decision).toMatch(/OPENAI_API_KEY/);
    const destr = decideEscalation({
      classification: classification({
        status: "blocked",
        open_issues: [
          "deploy to the live checkout stopped: it has another agent's uncommitted work",
        ],
      }),
      outcome: unverified,
      repeated: false,
      items: [],
    });
    expect(destr?.category).toBe("destructive");
    const q = decideEscalation({
      classification: classification({
        status: "needs_input",
        open_issues: ["Should I keep the old pricing table or replace it?"],
      }),
      outcome: unverified,
      repeated: false,
      items: [],
    });
    expect(q?.category).toBe("product_decision");
  });

  it("a repeated contradiction after a cwd-correct re-run escalates as a contradiction", () => {
    const e = decideEscalation({
      classification: classification({}),
      outcome: { ...unverified, verdict: "FAILED" },
      repeated: true,
      items: [
        {
          kind: "command",
          ref: "pnpm test",
          status: "fail",
          detail: "claimed exit 0 but re-run exited 1 in /w",
          cwd: "/w",
        },
      ],
    });
    expect(e?.category).toBe("contradiction");
    expect(e?.decision).toMatch(/Accept the run as-is, or Reject it/);
    expect(verdictKindFor("needs_owner", e)).toBe("escalate");
    expect(verdictKindFor("unverified", null)).toBe("changes_needed");
  });
});

// ── protocol end to end through the pipeline ───────────────────────────────

function stream(finalText: string, session = "sess-A"): string {
  return [
    { type: "system", subtype: "init", session_id: session, cwd: repo },
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

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps & { challenges: string[] } {
  const challenges: string[] = [];
  return {
    judge: async () => '{"verdict":"supported","unsupported_claims":[],"notes":"ok"}',
    rerunCommands: false,
    baselineRun: null,
    mirrorReview: () => {},
    deliver: () => {},
    deliverChallenge: (_rec, _msg, text) => {
      challenges.push(text);
    },
    ...over,
    challenges,
  };
}

describe("review conversation protocol", () => {
  it("submission → challenge → response → VERIFIED, persisted and listable", async () => {
    const runId = "coder-protocol-1";
    const startedAt = Date.now() - 1000;
    createRecord({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      requesterSessionKey: "agent:main:main",
      label: "Protocol run",
      task: "restyle the page",
      backend: "claude-code",
      workdir: repo,
      baseCommit: git(repo, "rev-parse", "HEAD"),
      startedAt,
      maxContinuations: 3,
    });
    writeFileSync(path.join(repo, "ui", "src", "ui", "views", "page.ts"), "export const a = 3;\n");
    const shot = path.join(stateDir, "shot.png");
    const prompts: ContinuationRequest[] = [];
    const d = deps();
    const rec = await superviseRunExit({
      runId,
      outcome: {
        exitCode: 0,
        rawOutput: stream(resultText({ files_changed: ["ui/src/ui/views/page.ts"] })),
      },
      spawnContinuation: async (req) => {
        prompts.push(req);
        writeFileSync(shot, PNG);
        utimesSync(shot, new Date(), new Date());
        return {
          exitCode: 0,
          sessionId: "sess-A",
          rawOutput: stream(
            resultText({ files_changed: ["ui/src/ui/views/page.ts"], screenshots: [shot] }),
          ),
        };
      },
      deps: d,
    });
    expect(rec?.state).toBe("verified");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].prompt).toMatch(/^\[REVIEW CHALLENGE from Auditor/);
    expect(prompts[0].prompt).toMatch(/visual_verify/);
    expect(d.challenges).toEqual([prompts[0].prompt]);

    const thread = readReviewThread(runId);
    expect(thread.map((m) => m.kind)).toEqual(["submission", "challenge", "response", "verdict"]);
    expect(thread.map((m) => `${m.fromAgent}>${m.toAgent}`)).toEqual([
      `agent:main:subagent:${runId}>auditor`,
      `auditor>agent:main:subagent:${runId}`,
      `agent:main:subagent:${runId}>auditor`,
      `auditor>agent:main:subagent:${runId}`,
    ]);
    expect(thread.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(thread[3].verdict).toBe("VERIFIED");
    // Shots outside the verification dir are copied in so the UI can serve them.
    expect(thread[3].screenshots).toHaveLength(1);
    expect(
      thread[3].screenshots![0].startsWith(path.join(verificationRunDir(runId), "result-shots")),
    ).toBe(true);
    expect(thread.map((m) => m.round)).toEqual([1, 1, 2, 2]);

    const got = getReviewThread(runId)!;
    expect(got.reviewer.name).toBe("Auditor");
    expect(got.summary).toMatchObject({
      verdict: "VERIFIED",
      rounds: 2,
      messageCount: 4,
      escalated: false,
      state: "verified",
    });
    expect(listReviewThreads({ limit: 5 }).map((t) => t.runId)).toEqual([runId]);
    expect(getRecord(runId)?.agentWorkdirs).toContain(repo);
  });

  it("caps review rounds and ends as changes_needed — no owner escalation for ordinary gaps", async () => {
    const runId = "coder-protocol-cap";
    createRecord({
      runId,
      childSessionKey: "agent:main:subagent:cap",
      requesterSessionKey: "agent:main:main",
      label: "Cap run",
      task: "restyle",
      backend: "claude-code",
      workdir: repo,
      baseCommit: git(repo, "rev-parse", "HEAD"),
      maxContinuations: 10,
    });
    writeFileSync(path.join(repo, "ui", "src", "ui", "views", "page.ts"), "export const a = 4;\n");
    let n = 0;
    const rec = await superviseRunExit({
      runId,
      outcome: {
        exitCode: 0,
        rawOutput: stream(
          resultText({ files_changed: ["ui/src/ui/views/page.ts"], screenshots: ["/nope/0.png"] }),
        ),
      },
      // Every answer is different (so it is not a "repeated" loop) but never valid.
      spawnContinuation: async () => ({
        exitCode: 0,
        sessionId: "sess-A",
        rawOutput: stream(
          resultText({
            files_changed: ["ui/src/ui/views/page.ts"],
            screenshots: [`/nope/${++n}-${"x".repeat(n)}.png`],
          }),
        ),
      }),
      deps: deps(),
    });
    const thread = readReviewThread(runId);
    const evaluations = thread.filter(
      (m) => m.kind === "submission" || m.kind === "response",
    ).length;
    expect(evaluations).toBe(REVIEW_ROUND_CAP);
    expect(thread.filter((m) => m.kind === "challenge")).toHaveLength(REVIEW_ROUND_CAP - 1);
    expect(rec?.state).not.toBe("needs_owner");
    expect(thread[thread.length - 1]).toMatchObject({ kind: "verdict", verdict: "changes_needed" });
  });

  it("escalates a blocked worker with the decision the owner must make", async () => {
    const runId = "coder-protocol-blocked";
    createRecord({
      runId,
      childSessionKey: "agent:main:subagent:b",
      requesterSessionKey: "agent:main:main",
      label: "Blocked run",
      task: "deploy",
      backend: "claude-code",
      workdir: repo,
      baseCommit: null,
    });
    const rec = await superviseRunExit({
      runId,
      outcome: {
        exitCode: 0,
        rawOutput: stream(
          resultText({
            status: "blocked",
            summary: "needs key",
            open_issues: ["FLYPIC_API_KEY is missing — please provide the credential"],
          } as Partial<RunResult>),
        ),
      },
      spawnContinuation: async () => {
        throw new Error("must not continue a blocked run");
      },
      deps: deps(),
    });
    expect(rec?.state).toBe("blocked");
    const verdict = readReviewThread(runId).at(-1)!;
    expect(verdict).toMatchObject({ kind: "verdict", verdict: "escalate" });
    expect(verdict.escalation?.category).toBe("credentials");
    expect(verdict.escalation?.decision).toMatch(/FLYPIC_API_KEY/);
    expect(getReviewThread(runId)?.summary.escalated).toBe(true);
  });
});
