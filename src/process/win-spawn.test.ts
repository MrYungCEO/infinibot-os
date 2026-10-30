/**
 * Windows .cmd shim handling, simulated on any OS: process.platform is forced
 * to "win32" and real shim files (the exact shapes npm's cmd-shim writes for
 * codex / gemini / opencode, and Grok Build's exe launcher) are put in a temp
 * dir. Bare spawn() of a .cmd throws EINVAL on Node ≥18.20/20.12/22
 * (CVE-2024-27980), so nothing may ever reach child_process.spawn as a .cmd.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      return { pid: 1 } as unknown;
    },
  };
});

const {
  isWindowsBatchCommand,
  nodeExecutable,
  resolveCliInvocation,
  resolveCmdShimTarget,
  spawnCli,
} = await import("./win-spawn.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "win-spawn-test-"));
const realPlatform = process.platform;

function write(rel: string, content = ""): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

/** npm cmd-shim (npm ≥7) for a node script bin. */
const nodeShim = (script: string) =>
  [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`,
    "",
  ].join("\r\n");

const SHIMS = {
  codex: "node_modules\\@openai\\codex\\bin\\codex.js",
  gemini: "node_modules\\@google\\gemini-cli\\dist\\index.js",
  opencode: "node_modules\\opencode-ai\\bin\\opencode",
} as const;

beforeEach(() => {
  spawned.length = 0;
  Object.defineProperty(process, "platform", { value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("win32 CLI shims (EINVAL path)", () => {
  it("detects .cmd/.bat only on Windows", () => {
    expect(isWindowsBatchCommand("C:\\npm\\codex.cmd")).toBe(true);
    expect(isWindowsBatchCommand("C:\\npm\\codex.CMD")).toBe(true);
    expect(isWindowsBatchCommand("C:\\npm\\codex.exe")).toBe(false);
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(isWindowsBatchCommand("/x/codex.cmd")).toBe(false);
  });

  it("codex.cmd → node + codex.js (no shell, no EINVAL)", () => {
    const js = write(SHIMS.codex.replace(/\\/g, path.sep), "");
    const cmd = write("codex.cmd", nodeShim(SHIMS.codex));
    const t = resolveCmdShimTarget(cmd);
    expect(t).not.toBeNull();
    expect(t!.prefixArgs).toEqual([js]);
    expect(t!.command).toBe(nodeExecutable());
    spawnCli(cmd, ["exec", "--json", "-"], { stdio: "pipe" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).not.toMatch(/\.cmd$/i);
    expect(spawned[0].args).toEqual([js, "exec", "--json", "-"]);
    expect(spawned[0].options.windowsVerbatimArguments).toBeUndefined();
  });

  it("prefers the node.exe npm put next to the shim", () => {
    const dir = path.join(tmp, "with-node");
    fs.mkdirSync(path.join(dir, "node_modules", "@google", "gemini-cli", "dist"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(dir, "node_modules", "@google", "gemini-cli", "dist", "index.js"),
      "",
    );
    fs.writeFileSync(path.join(dir, "node.exe"), "");
    const cmd = path.join(dir, "gemini.cmd");
    fs.writeFileSync(cmd, nodeShim(SHIMS.gemini));
    const inv = resolveCliInvocation(cmd, ["-p", "hi"]);
    expect(inv.command).toBe(path.join(dir, "node.exe"));
    expect(inv.args.slice(1)).toEqual(["-p", "hi"]);
  });

  it("opencode.cmd (extensionless node bin) → node + bin/opencode", () => {
    const bin = write(SHIMS.opencode.replace(/\\/g, path.sep), "");
    const cmd = write("opencode.cmd", nodeShim(SHIMS.opencode));
    const inv = resolveCliInvocation(cmd, ["run", "--format", "json", "hi"]);
    expect(inv.command).toBe(nodeExecutable());
    expect(inv.args).toEqual([bin, "run", "--format", "json", "hi"]);
  });

  it("an unresolvable shim falls back to a quoted cmd.exe wrapper", () => {
    const cmd = write("weird.cmd", "@echo off\r\nfor %%i in (a) do call :x %*\r\n");
    const inv = resolveCliInvocation(cmd, ["run", 'say "hi" & exit']);
    expect(inv.command).toMatch(/cmd(\.exe)?$/i);
    expect(inv.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(inv.windowsVerbatimArguments).toBe(true);
    // The & is caret-escaped (twice for .cmd), so it can't chain a command.
    expect(inv.args[3]).toContain("^^^&");
    spawnCli(cmd, ["run", "hi"]);
    expect(spawned[0].command).toMatch(/cmd(\.exe)?$/i);
    expect(spawned[0].options.windowsVerbatimArguments).toBe(true);
  });

  it("exe launcher shim (grok.cmd → grok.exe) runs the exe directly", () => {
    const exe = write(path.join("grok-bin", "grok.exe"), "");
    const cmd = write("grok.cmd", '@echo off\r\n"%~dp0\\grok-bin\\grok.exe" %*\r\n');
    const inv = resolveCliInvocation(cmd, ["--output-format", "streaming-json", "-p", "hi"]);
    expect(inv).toEqual({ command: exe, args: ["--output-format", "streaming-json", "-p", "hi"] });
  });

  it("leaves real executables and non-Windows hosts alone", () => {
    expect(resolveCliInvocation("C:\\x\\codex.exe", ["a"])).toEqual({
      command: "C:\\x\\codex.exe",
      args: ["a"],
    });
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveCliInvocation("/usr/bin/codex", ["a"])).toEqual({
      command: "/usr/bin/codex",
      args: ["a"],
    });
  });

  it("uses this process's node when it is plain Node, else node from PATH", () => {
    expect(nodeExecutable("C:\\Program Files\\InfiniBot\\runtime\\node.exe")).toBe(
      "C:\\Program Files\\InfiniBot\\runtime\\node.exe",
    );
    expect(nodeExecutable("/usr/bin/node")).toBe("/usr/bin/node");
    expect(nodeExecutable("C:\\Program Files\\InfiniBot\\InfiniBot.exe")).toBe("node");
  });
});
