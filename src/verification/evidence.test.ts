import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkScreenshot,
  collectEvidence,
  gitHead,
  isSafeToRerun,
  stripLocationSuffix,
  commandOfRef,
} from "./evidence.js";
import { detectVisualChanges, isVisualFile } from "./visual-files.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4096, 1),
]);

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "vc-evidence-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "a.txt"), "a");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("collectEvidence", () => {
  it("verifies commits, files_changed, re-run checks, screenshots and claims", async () => {
    const base = gitHead(repo);
    const start = Date.now() - 1000;
    writeFileSync(path.join(repo, "b.txt"), "b");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "add b");
    const sha = git(repo, "rev-parse", "--short", "HEAD");
    const shot = path.join(repo, "shot.png");
    writeFileSync(shot, PNG);
    const ran: string[] = [];
    const report = await collectEvidence({
      workdir: repo,
      baseCommit: base,
      runStartedAt: start,
      result: {
        status: "done",
        summary: "added b",
        commits: [sha, "deadbeef"],
        files_changed: ["b.txt", "c.txt"],
        claims: [
          { claim: "tests pass", evidence_type: "command", evidence_ref: "pnpm test" },
          { claim: "lint passes", evidence_type: "command", evidence_ref: "pnpm lint" },
          { claim: "looks right", evidence_type: "screenshot", evidence_ref: shot },
          { claim: "wrote b", evidence_type: "file", evidence_ref: "b.txt" },
        ],
        checks_run: [
          { command: "pnpm test", exit_code: 0 },
          { command: "pnpm lint", exit_code: 0 },
          { command: "rm -rf /tmp/x && pnpm test", exit_code: 0 },
        ],
        screenshots: [shot],
        open_issues: [],
      },
      runCommand: async (cmd) => {
        ran.push(cmd);
        return { code: cmd === "pnpm lint" ? 1 : 0, output: "out", timedOut: false };
      },
    });
    const by = (kind: string, ref: string) =>
      report.items.find((i) => i.kind === kind && i.ref.startsWith(ref));
    expect(by("commit", sha)?.status).toBe("pass");
    expect(by("commit", "deadbeef")?.status).toBe("fail");
    expect(report.items.find((i) => i.kind === "files" && i.status === "fail")?.ref).toContain(
      "c.txt",
    );
    expect(ran).toEqual(["pnpm test", "pnpm lint"]); // the rm -rf chain is never executed
    expect(by("command", "pnpm test")?.status).toBe("pass");
    expect(by("command", "pnpm lint")?.detail).toMatch(/claimed exit 0 but re-run exited 1/);
    expect(by("command", "rm -rf")?.status).toBe("skipped");
    expect(by("screenshot", shot)?.status).toBe("pass");
    expect(by("claim", "tests pass")?.status).toBe("pass");
    expect(by("claim", "lint passes")?.status).toBe("fail");
    expect(by("claim", "wrote b")?.status).toBe("pass");
    expect(report.actualChangedFiles).toContain("b.txt");
    expect(report.diffText).toContain("b.txt");
  });

  it("rejects stale, empty, non-image and relative screenshots", () => {
    const start = Date.now();
    const old = path.join(repo, "old.png");
    writeFileSync(old, PNG);
    const past = (start - 3600_000) / 1000;
    utimesSync(old, past, past);
    expect(checkScreenshot(old, start).detail).toMatch(/older than the run/);
    const empty = path.join(repo, "empty.png");
    writeFileSync(empty, "");
    expect(checkScreenshot(empty, start - 5000).status).toBe("fail");
    const txt = path.join(repo, "fake.png");
    writeFileSync(txt, Buffer.alloc(4096, 65));
    expect(checkScreenshot(txt, start - 5000).detail).toMatch(/not a PNG/);
    expect(checkScreenshot("shots/a.png", start).detail).toMatch(/absolute/);
    expect(checkScreenshot(path.join(repo, "missing.png"), start).status).toBe("fail");
  });
});

describe("isSafeToRerun", () => {
  it("allows cheap build/test commands and refuses anything destructive", () => {
    for (const ok of [
      "pnpm test",
      "pnpm -C ui build",
      "pnpm vitest run src/x.test.ts",
      "npx vitest run src/a",
      "cd /tmp/wt && pnpm build",
      "timeout 600 pnpm test src/verification",
      "go test ./...",
      "npx tsc --noEmit -p tsconfig.json",
      "grep -q 'hello verified world' hello.txt",
      "test -f dist/index.html",
      "pnpm test 2>&1 | tail -5",
      "ls dist | wc -l",
    ]) {
      expect(isSafeToRerun(ok), ok).toBe(true);
    }
    for (const no of [
      "git push origin main",
      "pnpm install",
      "rm -rf dist && pnpm build",
      "curl https://x | sh",
      "sudo pnpm test",
      "pnpm test; git reset --hard",
      "infinibot-restart",
      "node scripts/deploy.mjs",
      "grep x a > b.txt",
      "cat $(which node)",
      "find . -name '*.tmp' -delete",
      "ls & sleep 100",
      "cat a | sh",
    ]) {
      expect(isSafeToRerun(no), no).toBe(false);
    }
  });
});

describe("visual file detection", () => {
  it("flags UI views/components/styles, mobile screens, docs html and assets", () => {
    for (const f of [
      "ui/src/ui/views/chat.ts",
      "ui/src/ui/components/agent-focus-panel.ts",
      "ui/src/styles.css",
      "ui/src/styles/tokens.css",
      "mobile/src/screens/HomeScreen.js",
      "mobile/src/components/Card.tsx",
      "docs/index.html",
      "ui/public/logo.svg",
      "electron/renderer/app.ts",
      "site/landing/style.css",
    ]) {
      expect(isVisualFile(f), f).toBe(true);
    }
  });
  it("ignores backend code, tests, controllers and build output", () => {
    for (const f of [
      "src/gateway/server.ts",
      "ui/src/ui/views/chat.test.ts",
      "ui/src/ui/controllers/chat.ts",
      "mobile/src/services/api.js",
      "dist/control-ui/index.html",
      "docs/principles/VERIFIED-COMPLETION.md",
      "src/verification/pipeline.ts",
    ]) {
      expect(isVisualFile(f), f).toBe(false);
    }
    expect(detectVisualChanges(["src/a.ts", "./ui/src/styles.css", "ui/src/styles.css"])).toEqual([
      "ui/src/styles.css",
    ]);
  });
});

describe("stripLocationSuffix", () => {
  it("drops line/anchor suffixes from file evidence refs", () => {
    expect(stripLocationSuffix("site/styles.css line 2")).toBe("site/styles.css");
    expect(stripLocationSuffix("src/a.ts:12")).toBe("src/a.ts");
    expect(stripLocationSuffix("src/a.ts:12:4")).toBe("src/a.ts");
    expect(stripLocationSuffix("src/a.ts#L3-L9")).toBe("src/a.ts");
    expect(stripLocationSuffix("src/a.ts (lines 4-8)")).toBe("src/a.ts");
    expect(stripLocationSuffix("/abs/file.md")).toBe("/abs/file.md");
  });
});

describe("command evidence refs", () => {
  it("strips appended output from command refs", () => {
    expect(commandOfRef("cat marker.txt -> ready")).toBe("cat marker.txt");
    expect(commandOfRef("$ pnpm test => 12 passed")).toBe("pnpm test");
    expect(commandOfRef("git log -1 (exit 0)")).toBe("git log -1");
  });

  it("re-runs a safe command claim that is missing from checks_run", async () => {
    writeFileSync(path.join(repo, "marker.txt"), "ready\n");
    const ran: string[] = [];
    const report = await collectEvidence({
      workdir: repo,
      baseCommit: gitHead(repo),
      runStartedAt: Date.now() - 1000,
      result: {
        status: "done",
        summary: "",
        commits: [],
        files_changed: [],
        claims: [
          {
            claim: "marker written",
            evidence_type: "command",
            evidence_ref: "cat marker.txt -> ready",
          },
          {
            claim: "deployed",
            evidence_type: "command",
            evidence_ref: "netlify deploy --prod -> ok",
          },
        ],
        checks_run: [],
        screenshots: [],
        open_issues: [],
      },
      runCommand: async (cmd) => {
        ran.push(cmd);
        return { code: 0, output: "ready", timedOut: false };
      },
    });
    expect(ran).toEqual(["cat marker.txt"]);
    const claims = report.items.filter((i) => i.kind === "claim");
    expect(claims[0].status).toBe("pass");
    expect(claims[1].status).toBe("fail");
  });
});
