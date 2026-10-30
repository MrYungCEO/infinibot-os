import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExitClassification } from "./classifier.js";
import type { RunResult } from "./contract.js";
import { collectEvidence, gitHead, isSafeToRerun } from "./evidence.js";
import { composeVerdict } from "./reviewer.js";
import {
  buildRerunEnv,
  environmentProblem,
  resolveNodeBinDir,
  resolveRunWorkspace,
  scrubSecrets,
  stripEnvPrefix,
  versionSatisfies,
} from "./run-env.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function result(r: Partial<RunResult>): RunResult {
  return {
    status: "done",
    summary: "ok",
    commits: [],
    files_changed: [],
    claims: [],
    checks_run: [],
    screenshots: [],
    open_issues: [],
    ...r,
  };
}

const complete = (r: RunResult): ExitClassification => ({
  kind: "complete",
  reasons: [],
  result: r,
});

let root: string;
let owner: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "vc-runenv-")));
  owner = path.join(root, "owner");
  mkdirSync(owner);
  git(owner, "init", "-q", "-b", "main");
  git(owner, "config", "user.email", "t@t");
  git(owner, "config", "user.name", "t");
  writeFileSync(path.join(owner, "a.txt"), "a");
  git(owner, "add", ".");
  git(owner, "commit", "-qm", "base");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Agent-style worktree branch off the owner's HEAD with one commit. */
function agentWorktree(name = "wt"): { wt: string; sha: string } {
  const wt = path.join(root, name);
  git(owner, "worktree", "add", "-q", "-b", `feat/${name}`, wt);
  writeFileSync(path.join(wt, "feature.ts"), "export const x = 1;\n");
  git(wt, "add", ".");
  git(wt, "commit", "-qm", "feature");
  return { wt, sha: git(wt, "rev-parse", "--short", "HEAD") };
}

describe("command re-run environment", () => {
  it("command-not-found (exit 127) → environment warning, not a failed claim or verdict", async () => {
    const r = result({
      checks_run: [{ command: "vitest run src/x.test.ts", exit_code: 0 }],
      claims: [
        { claim: "tests pass", evidence_type: "test", evidence_ref: "vitest run src/x.test.ts" },
      ],
    });
    const report = await collectEvidence({
      workdir: owner,
      baseCommit: gitHead(owner),
      runStartedAt: Date.now() - 1000,
      result: r,
      runCommand: async () => ({
        code: 127,
        output: "bash: line 1: vitest: command not found",
        timedOut: false,
      }),
    });
    const cmd = report.items.find((i) => i.kind === "command")!;
    expect(cmd.status).toBe("warn");
    expect(cmd.environment).toBe(true);
    expect(cmd.detail).toMatch(/could not re-run \(environment\)/);
    const claim = report.items.find((i) => i.kind === "claim")!;
    expect(claim.status).toBe("warn");
    expect(claim.environment).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.environmentSkips).toBe(2);

    // The LLM reviewer objecting only because the re-run could not execute is
    // downgraded to a warning: no FAILED, no fixable gap, no continuation.
    const outcome = composeVerdict({
      classification: complete(r),
      evidence: report,
      visualFiles: [],
      llm: {
        available: true,
        verdict: "unsupported",
        unsupportedClaims: [
          { claim: "tests pass", why: "the gateway re-run exited 127: vitest: command not found" },
        ],
        notes: "",
      },
    });
    expect(outcome.verdict).toBe("VERIFIED");
    expect(outcome.fixable).toEqual([]);
    expect(outcome.warnings.join("\n")).toMatch(/could not re-run \(environment\)/);
  });

  it("missing worktree / node_modules → environment warning without running anything", async () => {
    writeFileSync(path.join(owner, "package.json"), '{"name":"x","devDependencies":{"vitest":"^3"}}');
    let ran = 0;
    const report = await collectEvidence({
      workdir: owner,
      baseCommit: gitHead(owner),
      runStartedAt: Date.now() - 1000,
      result: result({ checks_run: [{ command: "pnpm build", exit_code: 0 }] }),
      runCommand: async () => {
        ran++;
        return { code: 0, output: "", timedOut: false };
      },
    });
    expect(ran).toBe(0);
    const cmd = report.items.find((i) => i.kind === "command")!;
    expect(cmd).toMatchObject({ status: "warn", environment: true });
    expect(cmd.detail).toMatch(/node_modules missing/);
  });

  it("real failing test on re-run → FAILED", async () => {
    const r = result({ checks_run: [{ command: "pnpm test", exit_code: 0 }] });
    const report = await collectEvidence({
      workdir: owner,
      baseCommit: gitHead(owner),
      runStartedAt: Date.now() - 1000,
      result: r,
      runCommand: async () => ({
        code: 1,
        output:
          " FAIL  src/x.test.ts > adds\nAssertionError: expected 2 to be 3\n Tests  1 failed | 4 passed",
        timedOut: false,
      }),
    });
    const cmd = report.items.find((i) => i.kind === "command")!;
    expect(cmd.status).toBe("fail");
    expect(cmd.environment).toBeUndefined();
    const outcome = composeVerdict({
      classification: complete(r),
      evidence: report,
      visualFiles: [],
      llm: null,
    });
    expect(outcome.verdict).toBe("FAILED");
    expect(outcome.fixable.length).toBeGreaterThan(0);
  });

  it("classifies environment failures vs real ones", () => {
    expect(environmentProblem({ code: 127, output: "" })).toMatch(/not found/);
    expect(
      environmentProblem({
        code: 1,
        output:
          " ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)\nExpected version: >=22.12.0\nGot: v20.19.6",
      }),
    ).toMatch(/engines/);
    expect(
      environmentProblem({ code: 1, output: "src/a.ts(3,1): error TS2304: Cannot find name 'x'." }),
    ).toBeNull();
    expect(environmentProblem({ code: 1, output: "Tests  2 failed | 10 passed" })).toBeNull();
    expect(environmentProblem({ code: 0, output: "command not found" })).toBeNull();
    expect(
      environmentProblem({
        code: 1,
        output: "Error: ENOSPC: no space left on device, write\n Tests  8 failed",
      }),
    ).toMatch(/disk is full/);
    expect(
      environmentProblem({
        code: 1,
        output:
          " Tests  62 passed (62)\nclose timed out after 10000ms\nTests closed successfully but something prevents Vite server from exiting",
      }),
    ).toMatch(/did not exit/);
    expect(
      environmentProblem({
        code: 1,
        output:
          " Tests  2 failed | 60 passed (62)\nTests closed successfully but something prevents Vite server from exiting",
      }),
    ).toBeNull();
  });
});

describe("Node selection", () => {
  it("engines >=22.12.0 picks the highest satisfying install, never Node 20", () => {
    writeFileSync(path.join(owner, "package.json"), '{"engines":{"node":">=22.12.0"}}');
    const pick = resolveNodeBinDir(owner, [
      { binDir: "/usr/bin", version: "20.19.6" },
      { binDir: "/nvm/v22.11.0/bin", version: "22.11.0" },
      { binDir: "/nvm/v22.23.1/bin", version: "22.23.1" },
      { binDir: "/nvm/v22.22.2/bin", version: "22.22.2" },
    ]);
    expect(pick?.binDir).toBe("/nvm/v22.23.1/bin");
    writeFileSync(path.join(owner, ".nvmrc"), "22.22\n");
    expect(
      resolveNodeBinDir(owner, [
        { binDir: "/a", version: "22.23.1" },
        { binDir: "/b", version: "22.22.2" },
      ])?.binDir,
    ).toBe("/b");
  });

  it("semver subset", () => {
    expect(versionSatisfies("22.23.1", ">=22.12.0")).toBe(true);
    expect(versionSatisfies("20.19.6", ">=22.12.0")).toBe(false);
    expect(versionSatisfies("22.1.0", "^22")).toBe(true);
    expect(versionSatisfies("23.0.0", "^22")).toBe(false);
    expect(versionSatisfies("18.2.0", "18 || >=22")).toBe(true);
    expect(versionSatisfies("20.0.0", ">=18 <21")).toBe(true);
  });

  it("engines mismatch is resolved: the re-run PATH puts Node 22 ahead of the daemon's Node 20", async () => {
    // Fake daemon Node 20 that fails the engines check exactly like pnpm does.
    const node20 = path.join(root, "node20", "bin");
    mkdirSync(node20, { recursive: true });
    writeFileSync(
      path.join(node20, "node"),
      '#!/bin/sh\necho "Expected version: >=22.12.0"; echo "Got: v20.19.6"; exit 1\n',
    );
    chmodSync(path.join(node20, "node"), 0o755);
    writeFileSync(path.join(owner, "package.json"), '{"engines":{"node":">=22.12.0"}}');
    mkdirSync(path.join(owner, "node_modules"));
    writeFileSync(
      path.join(owner, "t.test.mjs"),
      'import test from "node:test";\ntest("ok", () => {});\n',
    );
    const node22 = { binDir: path.dirname(process.execPath), version: process.versions.node };
    expect(versionSatisfies(node22.version, ">=22.12.0")).toBe(true);
    const r = result({ checks_run: [{ command: "node --test t.test.mjs", exit_code: 0 }] });
    const run = (candidates: Array<{ binDir: string; version: string }>, daemonPath: string) => {
      const prev = process.env.PATH;
      process.env.PATH = daemonPath;
      return collectEvidence({
        workdir: owner,
        baseCommit: gitHead(owner),
        runStartedAt: Date.now() - 1000,
        result: r,
        nodeCandidates: candidates,
      }).finally(() => {
        process.env.PATH = prev;
      });
    };
    // Only Node 20 available → environment warning (not a failure).
    const bad = await run([{ binDir: node20, version: "20.19.6" }], `${node20}:/usr/bin:/bin`);
    expect(bad.items.find((i) => i.kind === "command")).toMatchObject({
      status: "warn",
      environment: true,
    });
    // Node 22 installed (nvm) → selected ahead of the daemon's Node 20 → passes.
    const good = await run(
      [{ binDir: node20, version: "20.19.6" }, node22],
      `${node20}:/usr/bin:/bin`,
    );
    expect(good.items.find((i) => i.kind === "command")).toMatchObject({ status: "pass" });
  });

  it("re-run env: local bins first (cd ui → ui bins), HOME kept, secrets scrubbed", () => {
    const env = buildRerunEnv({
      command: "cd ui && vitest run",
      cwd: "/w",
      top: "/w",
      node: { binDir: "/nvm/v22/bin", version: "22.23.1" },
      baseEnv: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-x",
        TELEGRAM_BOT_TOKEN: "t",
        DATABASE_URL: "postgres://",
        LANG: "C",
      },
    });
    expect(env.PATH.split(":").slice(0, 4)).toEqual([
      "/w/ui/node_modules/.bin",
      "/w/node_modules/.bin",
      "/nvm/v22/bin",
      "/usr/bin",
    ]);
    expect(env.HOME).toBe("/home/u");
    expect(env.LANG).toBe("C");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(scrubSecrets({ SSH_AUTH_SOCK: "/s", GITHUB_TOKEN: "g" })).toEqual({
      SSH_AUTH_SOCK: "/s",
    });
  });

  it("agent commands with a PATH=… prefix become re-runnable", () => {
    const c =
      "cd /tmp/plugin-platform && PATH=$HOME/.nvm/versions/node/v22.23.1/bin:$PATH pnpm build";
    expect(isSafeToRerun(c)).toBe(false);
    expect(stripEnvPrefix(c)).toBe("cd /tmp/plugin-platform && pnpm build");
    expect(isSafeToRerun(stripEnvPrefix(c))).toBe(true);
    expect(isSafeToRerun("git -C /tmp/x log --oneline e94dfcd5..HEAD")).toBe(true);
    expect(isSafeToRerun("git -C /tmp/x push")).toBe(false);
    expect(isSafeToRerun("git branch --contains e85da070 && git status --short | wc -l")).toBe(
      true,
    );
    expect(isSafeToRerun("git branch evil")).toBe(false);
  });
});

describe("commits + files against the run's own branch", () => {
  it("commit on the run's worktree branch but not the owner's branch → pass", async () => {
    const base = gitHead(owner);
    const { wt, sha } = agentWorktree();
    // Owner has unrelated dirty work that must not be attributed to the run.
    writeFileSync(path.join(owner, "owner-dirty.txt"), "wip");
    const report = await collectEvidence({
      workdir: owner,
      baseCommit: base,
      runStartedAt: Date.now() - 1000,
      result: result({ commits: [sha], files_changed: ["feature.ts"] }),
      rerunCommands: false,
    });
    expect(report.workspace.top).toBe(wt);
    expect(report.workspace.source).toBe("commits");
    expect(report.items.find((i) => i.kind === "commit")?.status).toBe("pass");
    expect(report.items.find((i) => i.kind === "files")).toMatchObject({ status: "pass" });
    expect(report.actualChangedFiles).toEqual(["feature.ts"]);
    expect(report.failures).toBe(0);
  });

  it("worktree named only by `cd` in checks_run is found (no commits claimed)", () => {
    const { wt } = agentWorktree("wt2");
    const ws = resolveRunWorkspace({
      workdir: owner,
      result: result({ checks_run: [{ command: `cd ${wt} && pnpm build`, exit_code: 0 }] }),
    });
    expect(ws).toMatchObject({ top: wt, source: "result-paths", isSeparateWorktree: true });
    expect(ws.branch).toBe("feat/wt2");
  });

  it("missing commit → real failure; commit on another branch only → warning", async () => {
    const base = gitHead(owner);
    const { sha } = agentWorktree("wt3");
    git(owner, "branch", "side", "main");
    const report = await collectEvidence({
      workdir: owner,
      baseCommit: base,
      runStartedAt: Date.now() - 1000,
      result: result({ commits: ["deadbeefcafe"] }),
      rerunCommands: false,
    });
    expect(report.items.find((i) => i.kind === "commit")).toMatchObject({
      status: "fail",
      detail: "commit does not exist",
    });
    // Two claimed commits that live on different branches: no tree has both,
    // so the review falls back to the owner's checkout — not a hard failure.
    git(owner, "checkout", "-q", "side");
    writeFileSync(path.join(owner, "s.txt"), "s");
    git(owner, "add", ".");
    git(owner, "commit", "-qm", "side");
    const sideSha = git(owner, "rev-parse", "--short", "HEAD");
    const r2 = await collectEvidence({
      workdir: owner,
      baseCommit: base,
      runStartedAt: Date.now() - 1000,
      result: result({ commits: [sha, sideSha] }),
      rerunCommands: false,
    });
    const agentCommit = r2.items.find((i) => i.kind === "commit" && i.ref === sha)!;
    expect(agentCommit.status).toBe("warn");
    expect(agentCommit.detail).toMatch(/feat\/wt3/);
  });
});
