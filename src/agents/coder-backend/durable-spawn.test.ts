/**
 * Durable (tmux-backed) coder spawn — unit tests.
 *
 * These cover the pure, host-independent pieces: session identity, the shell
 * quoting that carries an arbitrary task prompt into the tmux pane, and the
 * fallback contract of `spawnCoderProcess`. The live tmux round-trip is covered
 * by the integration harness (scripts/durable-subagents-check.mjs).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../process/win-spawn.js", () => ({
  spawnCli: vi.fn(() => ({ pid: 4242, __direct: true })),
}));

vi.mock("../../terminal/tmux-backend.js", () => ({
  isTmuxAvailable: vi.fn(() => false),
  hasLiveSessionSync: vi.fn(() => false),
  tmuxSessionName: (terminalId: string) => `infinibot_${terminalId.replace(/[^a-zA-Z0-9_]/g, "_")}`,
}));

import {
  buildDurableScript,
  durableTerminalId,
  durableTmuxSession,
  isDurableSpawnEnabled,
  shQuote,
  spawnCoderProcess,
} from "./durable-spawn.js";
import { spawnCli } from "../../process/win-spawn.js";
import { isTmuxAvailable } from "../../terminal/tmux-backend.js";

const RUN_ID = "8f2c1a10-0000-4000-8000-abcdef123456";

describe("durable spawn identity", () => {
  it("derives a spawn-prefixed terminal id so TerminalManager skips the pane", () => {
    // reconcileTmuxSessions() skips ids starting with spawn-/spawn_, which is
    // what keeps a second node-pty client off a registry-owned session.
    expect(durableTerminalId(RUN_ID)).toBe(`spawn-${RUN_ID}`);
    expect(durableTmuxSession(RUN_ID).startsWith("infinibot_spawn_")).toBe(true);
  });

  it("produces a tmux-legal session name (no dots or colons)", () => {
    expect(durableTmuxSession(RUN_ID)).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("is deterministic across processes — the recovery key survives a restart", () => {
    expect(durableTmuxSession(RUN_ID)).toBe(durableTmuxSession(RUN_ID));
  });
});

describe("shQuote", () => {
  it("wraps plain values", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });

  it("neutralises embedded single quotes", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("keeps shell metacharacters inert", () => {
    const quoted = shQuote("$(rm -rf /) `whoami` && echo pwned");
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // No unescaped quote can terminate the literal early.
    expect(quoted.slice(1, -1).includes("'")).toBe(false);
  });
});

describe("buildDurableScript", () => {
  const base = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    cwd: "/repo/my project",
    env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" },
    stdoutPath: "/tmp/run/stdout.log",
    stderrPath: "/tmp/run/stderr.log",
    exitPath: "/tmp/run/exit.code",
  };

  it("exports the caller's env explicitly", () => {
    // A pre-existing tmux SERVER does not inherit a new client's environment,
    // so the launcher script has to carry it.
    const script = buildDurableScript(base);
    expect(script).toContain("export PATH='/usr/bin'");
    expect(script).toContain("export ANTHROPIC_API_KEY='sk-test'");
  });

  it("unsets keys the caller removed (the tmux server keeps the gateway's env)", () => {
    const script = buildDurableScript({ ...base, unsetEnv: ["XAI_API_KEY", "ANTHROPIC_API_KEY"] });
    expect(script).toContain("unset XAI_API_KEY");
    // A key the caller re-supplied (e.g. saved for that CLI) is exported, not unset.
    expect(script).not.toContain("unset ANTHROPIC_API_KEY");
    expect(script.indexOf("unset XAI_API_KEY")).toBeLessThan(script.indexOf("export PATH"));
  });

  it("skips env names that are not legal shell identifiers", () => {
    const script = buildDurableScript({ ...base, env: { ...base.env, "not-an-ident": "x" } });
    expect(script).not.toContain("not-an-ident");
  });

  it("quotes a cwd containing spaces", () => {
    expect(buildDurableScript(base)).toContain("cd '/repo/my project'");
  });

  it("redirects both streams and records the exit status last", () => {
    const script = buildDurableScript(base);
    expect(script).toContain("> '/tmp/run/stdout.log' 2> '/tmp/run/stderr.log'");
    const lines = script.trim().split("\n");
    expect(script).toContain("code=$?");
    expect(script).toContain(`printf '%s' "$code" > '/tmp/run/exit.code'`);
    expect(lines[lines.length - 1]).toBe('exit "$code"');
  });

  it("records a useful exit code and stderr when the working directory is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "infinibot-durable-cwd-"));
    try {
      const scriptPath = path.join(root, "launch.sh");
      const stderrPath = path.join(root, "stderr.log");
      const exitPath = path.join(root, "exit.code");
      writeFileSync(
        scriptPath,
        buildDurableScript({
          ...base,
          cwd: path.join(root, "missing"),
          stdoutPath: path.join(root, "stdout.log"),
          stderrPath,
          exitPath,
        }),
      );
      const result = spawnSync("/bin/sh", [scriptPath], { encoding: "utf8" });
      expect(result.status).toBe(127);
      expect(readFileSync(exitPath, "utf8")).toBe("127");
      expect(readFileSync(stderrPath, "utf8")).toContain("Coder working directory is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives a task prompt full of quotes and metacharacters", () => {
    const nasty = `Fix the 'auth' bug; don't run $(rm -rf /) & report "done"`;
    const script = buildDurableScript({ ...base, args: ["-p", nasty] });
    // The prompt must appear inside a single-quoted literal, with its own
    // quotes escaped — never as live shell syntax.
    expect(script).toContain(shQuote(nasty));
    expect(script).not.toContain(`$(rm -rf /) &\n`);
  });
});

describe("spawnCoderProcess", () => {
  it("falls back to a direct child when no durableRunId is given", () => {
    const child = spawnCoderProcess("claude", ["-p"], { cwd: "/repo" });
    expect(vi.mocked(spawnCli)).toHaveBeenCalledWith("claude", ["-p"], { cwd: "/repo" });
    expect((child as unknown as { __direct: boolean }).__direct).toBe(true);
  });

  it("falls back to a direct child when tmux is unavailable", () => {
    vi.mocked(isTmuxAvailable).mockReturnValue(false);
    expect(isDurableSpawnEnabled()).toBe(false);
    const child = spawnCoderProcess("claude", ["-p"], { cwd: "/repo" }, RUN_ID);
    expect((child as unknown as { __direct: boolean }).__direct).toBe(true);
  });

  it("honours the INFINIBOT_DURABLE_SUBAGENTS=0 opt-out even with tmux present", () => {
    vi.mocked(isTmuxAvailable).mockReturnValue(true);
    const prev = process.env.INFINIBOT_DURABLE_SUBAGENTS;
    process.env.INFINIBOT_DURABLE_SUBAGENTS = "0";
    try {
      expect(isDurableSpawnEnabled()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.INFINIBOT_DURABLE_SUBAGENTS;
      else process.env.INFINIBOT_DURABLE_SUBAGENTS = prev;
    }
  });
});
