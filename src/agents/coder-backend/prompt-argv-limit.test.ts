/**
 * Regression: coder spawns died at exec with "Argument list too long" (E2BIG,
 * exit 126) once the skill preamble + task crossed Linux's 128 KiB
 * per-argv-string cap (MAX_ARG_STRLEN). Large prompts must reach the CLI via
 * a file (stdin / `*-file` flag), never as one argv element.
 *
 * The launch-script test runs the generated `/bin/sh` launcher for real with a
 * fake CLI that records every argv element's size and the stdin it received.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./bin-detect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bin-detect.js")>()),
  // Keep opencode's model probe from shelling out to a real CLI.
  resolveBin: () => "/nonexistent/infinibot-test-bin",
}));

import type { CLIAgentConfig } from "../types/agent-types.js";
import { buildClaudeArgsForTest } from "../claude-code/launcher.js";
import { buildCodexLaunch } from "./codex.js";
import { buildDurableScript, MAX_INLINE_ARG_BYTES } from "./durable-spawn.js";
import { buildGeminiLaunch } from "./gemini.js";
import { buildOcLaunch } from "./opencode.js";

const ARGV_CEILING = 100 * 1024;
const BIG_PROMPT = `## InfiniBot Skill + Memory Runtime\n${"x".repeat(250 * 1024)}\nTASK: it's "quoted" $HOME \`tick\` END`;

const config = {
  id: "argv-test",
  cliCommand: "codex",
  timeoutMinutes: 5,
  autoApprove: true,
} as unknown as CLIAgentConfig;

let stateDir: string;
const prevStateDir = process.env.INFINIBOT_STATE_DIR;

beforeAll(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "ib-argv-limit-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

function maxArgBytes(args: readonly string[]): number {
  return Math.max(0, ...args.map((a) => Buffer.byteLength(a, "utf8")));
}

describe("large coder prompts never ride in argv", () => {
  it("codex: >200 KB prompt → launch script whose argv stays under 100 KB and feeds stdin", () => {
    const runId = "argv-codex-run";
    const { args, stdinPath } = buildCodexLaunch(config, BIG_PROMPT, {}, runId);
    expect(stdinPath).toBeTruthy();
    expect(args.at(-1)).toBe("-"); // codex exec reads the prompt from stdin
    expect(maxArgBytes(args)).toBeLessThan(ARGV_CEILING);
    expect(readFileSync(stdinPath!, "utf8")).toBe(BIG_PROMPT);

    // Generate the real durable launcher and run it against a fake CLI that
    // reports what it actually received.
    const dir = mkdtempSync(path.join(tmpdir(), "ib-argv-launch-"));
    try {
      const fakeCli = path.join(dir, "fake-codex");
      writeFileSync(
        fakeCli,
        [
          `#!${process.execPath}`,
          "const fs = require('node:fs');",
          "const stdin = fs.readFileSync(0, 'utf8');",
          "const lens = process.argv.slice(2).map((a) => Buffer.byteLength(a));",
          "process.stdout.write(JSON.stringify({ lens, args: process.argv.slice(2), stdinLen: Buffer.byteLength(stdin), stdinTail: stdin.slice(-40) }));",
        ].join("\n"),
      );
      chmodSync(fakeCli, 0o755);
      const stdoutPath = path.join(dir, "stdout.log");
      const exitPath = path.join(dir, "exit.code");
      const script = buildDurableScript({
        command: fakeCli,
        args,
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdoutPath,
        stderrPath: path.join(dir, "stderr.log"),
        exitPath,
        stdinPath,
      });
      // The script FILE may be big (sh reads it fine); no single line of it is
      // an exec'd argument anymore.
      expect(script).toContain(`< '${stdinPath}'`);
      expect(script).not.toContain("x".repeat(1024));
      const scriptPath = path.join(dir, "launch.sh");
      writeFileSync(scriptPath, script, { mode: 0o700 });

      const run = spawnSync("/bin/sh", [scriptPath], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(readFileSync(exitPath, "utf8")).toBe("0");
      const seen = JSON.parse(readFileSync(stdoutPath, "utf8")) as {
        lens: number[];
        args: string[];
        stdinLen: number;
        stdinTail: string;
      };
      expect(Math.max(...seen.lens)).toBeLessThan(ARGV_CEILING);
      expect(seen.args).toEqual(args);
      expect(seen.stdinLen).toBe(Buffer.byteLength(BIG_PROMPT));
      expect(seen.stdinTail).toBe(BIG_PROMPT.slice(-40));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("codex: small prompts stay inline (unchanged behaviour)", () => {
    const { args, stdinPath } = buildCodexLaunch(config, "fix the bug", {}, "argv-small");
    expect(stdinPath).toBeUndefined();
    expect(args.at(-1)).toBe("fix the bug");
  });

  it("opencode: big task → stdin, no positional message", () => {
    const { args, stdinPath } = buildOcLaunch(config, BIG_PROMPT, { model: "x/y" }, "argv-oc");
    expect(stdinPath).toBeTruthy();
    expect(maxArgBytes(args)).toBeLessThan(ARGV_CEILING);
    expect(args.at(-1)).not.toBe("");
    expect(readFileSync(stdinPath!, "utf8")).toBe(BIG_PROMPT);
  });

  it("gemini: big task → stdin with a short positional", () => {
    const { args, stdinPath } = buildGeminiLaunch(config, BIG_PROMPT, {}, "argv-gemini");
    expect(stdinPath).toBeTruthy();
    expect(maxArgBytes(args)).toBeLessThan(ARGV_CEILING);
    expect(readFileSync(stdinPath!, "utf8")).toBe(BIG_PROMPT);
  });

  it("claude: big system prompt → --append-system-prompt-file, big task → stdin", () => {
    const { args, stdinPath } = buildClaudeArgsForTest(
      { ...config, cliCommand: "claude" } as CLIAgentConfig,
      BIG_PROMPT,
      { systemPrompt: BIG_PROMPT },
      "argv-claude",
    );
    expect(maxArgBytes(args)).toBeLessThan(ARGV_CEILING);
    expect(args).not.toContain("--append-system-prompt");
    const fileIdx = args.indexOf("--append-system-prompt-file");
    expect(fileIdx).toBeGreaterThan(-1);
    expect(readFileSync(args[fileIdx + 1]!, "utf8")).toBe(BIG_PROMPT);
    expect(readFileSync(stdinPath!, "utf8")).toBe(BIG_PROMPT);
  });

  it("inline threshold is well under the kernel's 128 KiB per-string cap", () => {
    expect(MAX_INLINE_ARG_BYTES).toBeLessThan(ARGV_CEILING);
  });
});
