/**
 * Windows command-line budget proof: every CLI backend, on every spawn path
 * (brain route, chat CLI route, coder spawns), with a 60 KB system prompt on a
 * simulated win32 host, builds a command line under budget and moves the big
 * text to a file flag or stdin. ARGV_PROOF_OUT=<file> writes the measurements.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveCliBackendConfig } from "../agents/cli-backends.js";
import { planCliArgv } from "../agents/cli-runner/argv-plan.js";
import { classifyCliFailure, describeCliFailure } from "../agents/cli-runner/stream.js";
import { buildClaudeArgsForTest } from "../agents/claude-code/launcher.js";
import { buildCodexLaunch } from "../agents/coder-backend/codex.js";
import { buildGeminiLaunch } from "../agents/coder-backend/gemini.js";
import { buildGrokLaunch } from "../agents/coder-backend/grok.js";
import { buildOcLaunch } from "../agents/coder-backend/opencode.js";
import type { CLIAgentConfig } from "../agents/types/agent-types.js";
import { buildCliChatLaunch } from "../gateway/cli-chat/runner.js";
import {
  checkCommandLine,
  quoteWindowsArg,
  WIN_COMMAND_LINE_MAX,
  WIN_SHELL_COMMAND_LINE_MAX,
  windowsCommandLineLength,
  windowsSpawnUsesShell,
} from "./argv-budget.js";

const SYSTEM_PROMPT_60K = `# InfiniBot system prompt\n${"You are InfiniBot. Follow the rules. ".repeat(1700)}`;
const USER_MESSAGE = 'Hi Grok, "quick" question about C:\\path\\ & stuff';
// npm shim we can't resolve on this (Linux) host → sized as cmd.exe, the worst case.
const SHIM = (bin: string) => `C:\\Users\\owner\\AppData\\Roaming\\npm\\${bin}.cmd`;
const EXE = (bin: string) => `C:\\Users\\owner\\.grok\\bin\\${bin}.exe`;

const proof: Array<Record<string, unknown>> = [];
afterAll(() => {
  const out = process.env.ARGV_PROOF_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(proof, null, 2));
});

const scratchDirs: string[] = [];
const writeScratch = async (name: string, body: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argv-proof-"));
  scratchDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
};
afterAll(() => {
  for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true });
});

expect(SYSTEM_PROMPT_60K.length).toBeGreaterThan(60_000);

describe("argv-budget primitives", () => {
  it("quotes like libuv/CommandLineToArgvW", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });

  it("detects cmd.exe spawns and sizes their budget at 8k", () => {
    expect(windowsSpawnUsesShell(SHIM("grok"), { platform: "win32" })).toBe(true);
    expect(windowsSpawnUsesShell(EXE("grok"), { platform: "win32" })).toBe(false);
    expect(windowsSpawnUsesShell("grok", { platform: "win32" })).toBe(true);
    expect(windowsSpawnUsesShell(SHIM("grok"), { platform: "linux" })).toBe(false);
    expect(checkCommandLine({ command: SHIM("x"), args: [], platform: "win32" }).budget).toBe(
      WIN_SHELL_COMMAND_LINE_MAX,
    );
    expect(checkCommandLine({ command: EXE("x"), args: [], platform: "win32" }).budget).toBe(
      WIN_COMMAND_LINE_MAX,
    );
  });

  it("reproduces the bug: the old inline grok argv overflows Windows, fits Linux", () => {
    const args = ["--output-format", "streaming-json", "-p", `${SYSTEM_PROMPT_60K}\n\n---\n\nhi`];
    const win = checkCommandLine({ command: EXE("grok"), args, platform: "win32" });
    expect(win.fits).toBe(false);
    expect(win.length).toBeGreaterThan(32_767);
    expect(checkCommandLine({ command: "grok", args, platform: "linux" }).fits).toBe(true);
  });
});

// ── Brain route (cli-runner) ────────────────────────────────────────────────

const BRAIN_BACKENDS = ["claude-cli", "codex-cli", "gemini-cli", "grok-cli", "opencode-cli"];
const BIN: Record<string, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
  "gemini-cli": "gemini",
  "grok-cli": "grok",
  "opencode-cli": "opencode",
};

describe("brain route on simulated win32 with a 60 KB system prompt", () => {
  for (const id of BRAIN_BACKENDS) {
    for (const [kind, command] of [
      ["cmd-shim", SHIM(BIN[id])],
      ["exe", EXE(BIN[id])],
    ] as const) {
      it(`${id} (${kind}) fits the command line and uses a file/stdin`, async () => {
        const backend = resolveCliBackendConfig(id)!.config;
        // Exactly what runCliAgent does: a CLI without a system-prompt flag
        // gets the system prompt folded into the first turn's prompt.
        const hasSysFlag = Boolean(backend.systemPromptArg);
        const prompt = hasSysFlag ? USER_MESSAGE : `${SYSTEM_PROMPT_60K}\n\n---\n\n${USER_MESSAGE}`;
        const baseArgs = [...(backend.args ?? [])];
        if (id === "claude-cli") {
          // prepareCliMcp's Claude args (config is a file path, never inline JSON).
          baseArgs.push(
            "--mcp-config",
            "C:\\Users\\owner\\AppData\\Local\\Temp\\infinibot-cli-mcp-x\\mcp.json",
            "--strict-mcp-config",
            "--allowedTools",
            "mcp__infinibot",
          );
        }
        const plan = await planCliArgv({
          backend,
          command,
          baseArgs,
          modelId: "",
          sessionId: hasSysFlag ? "11111111-2222-3333-4444-555555555555" : undefined,
          useResume: false,
          prompt,
          systemPrompt: hasSysFlag ? SYSTEM_PROMPT_60K : null,
          platform: "win32",
          writeScratch,
        });
        const viaShell = kind === "cmd-shim";
        const length = windowsCommandLineLength(command, plan.args, viaShell);
        const budget = viaShell ? WIN_SHELL_COMMAND_LINE_MAX : WIN_COMMAND_LINE_MAX;
        expect(plan.check.fits).toBe(true);
        expect(plan.check.length).toBe(length);
        expect(length).toBeLessThan(budget);
        expect(plan.args.join(" ")).not.toContain("You are InfiniBot. Follow the rules.");

        // The full text still reaches the CLI — via file or stdin.
        const fileArg = (flag?: string) => {
          const i = flag ? plan.args.indexOf(flag) : -1;
          return i >= 0 ? fs.readFileSync(plan.args[i + 1]!, "utf8") : undefined;
        };
        let transport: string;
        if (id === "claude-cli") {
          expect(plan.args).toContain("--append-system-prompt-file");
          expect(plan.args).not.toContain("--append-system-prompt");
          expect(fileArg("--append-system-prompt-file")).toBe(SYSTEM_PROMPT_60K);
          expect(plan.args).toContain("--mcp-config");
          expect(plan.stdin).toBe(USER_MESSAGE);
          transport = "system prompt → --append-system-prompt-file; message → stdin";
        } else if (id === "grok-cli") {
          expect(plan.args).not.toContain("-p");
          expect(fileArg("--prompt-file")).toBe(prompt);
          expect(plan.stdin).toBe("");
          transport = "prompt (system+message) → --prompt-file";
        } else {
          expect(plan.stdin).toBe(prompt);
          transport = "prompt (system+message) → stdin";
        }
        proof.push({
          route: "brain (cli-runner)",
          backend: id,
          spawn: kind,
          length,
          budget,
          transport,
        });
      });
    }
  }

  it("Linux keeps short prompts inline and the 64 KiB system-prompt rule", async () => {
    const backend = resolveCliBackendConfig("claude-cli")!.config;
    const small = await planCliArgv({
      backend,
      command: "claude",
      baseArgs: [...(backend.args ?? [])],
      modelId: "",
      useResume: false,
      prompt: "hi",
      systemPrompt: "short system prompt",
      platform: "linux",
      writeScratch,
    });
    expect(small.args).toContain("--append-system-prompt");
    expect(small.systemPromptFile).toBeUndefined();
    const grok = resolveCliBackendConfig("grok-cli")!.config;
    const g = await planCliArgv({
      backend: grok,
      command: "grok",
      baseArgs: [...(grok.args ?? [])],
      modelId: "",
      useResume: false,
      prompt: `${SYSTEM_PROMPT_60K}\n\nhi`,
      systemPrompt: null,
      platform: "linux",
      writeScratch,
    });
    expect(g.args).toContain("-p");
    expect(g.promptFile).toBeUndefined();
  });
});

// ── Chat CLI route (cli-chat/runner) ────────────────────────────────────────

describe("chat CLI route on simulated win32 with a 60 KB prompt", () => {
  const files: string[] = [];
  const writePromptFile = (body: string) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chat-proof-")), "prompt.txt");
    fs.writeFileSync(f, body);
    files.push(f);
    return f;
  };
  afterAll(() => {
    for (const f of files) fs.rmSync(path.dirname(f), { recursive: true, force: true });
  });
  const CHAT = ["claude-code", "codex", "gemini", "opencode", "grok"] as const;
  const prompt = `${SYSTEM_PROMPT_60K}\n\n${USER_MESSAGE}`;
  for (const backend of CHAT) {
    it(`${backend} fits via cmd-shim and never refuses the message`, () => {
      const command = SHIM(backend === "claude-code" ? "claude" : backend);
      const launch = buildCliChatLaunch({
        backend,
        prompt,
        model: "m",
        resumeId: "s1",
        command,
        platform: "win32",
        writePromptFile,
      });
      const length = windowsCommandLineLength(command, launch.args, true);
      expect(length).toBeLessThan(WIN_SHELL_COMMAND_LINE_MAX);
      let transport: string;
      if (backend === "grok") {
        const i = launch.args.indexOf("--prompt-file");
        expect(i).toBeGreaterThan(-1);
        expect(launch.args).not.toContain("-p");
        expect(fs.readFileSync(launch.args[i + 1]!, "utf8")).toBe(prompt);
        transport = "--prompt-file";
      } else {
        expect(launch.stdin).toBe(prompt);
        if (backend === "gemini") expect(launch.args).not.toContain("-p");
        transport = "stdin";
      }
      proof.push({
        route: "chat CLI (cli-chat/runner)",
        backend,
        spawn: "cmd-shim",
        length,
        budget: WIN_SHELL_COMMAND_LINE_MAX,
        transport,
      });
    });
  }

  it("short messages still ride in argv on win32", () => {
    const l = buildCliChatLaunch({
      backend: "grok",
      prompt: "hi",
      command: EXE("grok"),
      platform: "win32",
    });
    expect(l.args.slice(-2)).toEqual(["-p", "hi"]);
  });
});

// ── Coder spawns (durable-spawn builders) ───────────────────────────────────

describe("coder spawns on simulated win32 with a 60 KB preamble", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const asWin32 = () => Object.defineProperty(process, "platform", { value: "win32" });
  afterEach(() => Object.defineProperty(process, "platform", realPlatform));
  const cfg = (bin: string): CLIAgentConfig =>
    ({
      id: `${bin}-proof`,
      name: bin,
      type: "cli",
      cliCommand: bin,
      autoApprove: true,
      timeoutMinutes: 1,
    }) as unknown as CLIAgentConfig;
  // Coder tasks carry the skills/memory preamble: 60 KB + the task, but under
  // the old 32 KiB per-value cutoff for the 20 KB case.
  const tasks = { "20KB": SYSTEM_PROMPT_60K.slice(0, 20_000), "60KB": SYSTEM_PROMPT_60K };
  const runId = () => `argv-proof-${process.pid}-${Math.random().toString(36).slice(2)}`;

  for (const [size, task] of Object.entries(tasks)) {
    it(`grok/codex/gemini/opencode/claude move a ${size} task off argv`, () => {
      asWin32();
      const launches = {
        grok: buildGrokLaunch(cfg("grok"), task, {}, runId()),
        codex: buildCodexLaunch(cfg("codex"), task, {}, runId()),
        gemini: buildGeminiLaunch(cfg("gemini"), task, {}, runId()),
        opencode: buildOcLaunch(cfg("opencode"), task, {}, runId()),
        claude: buildClaudeArgsForTest(
          cfg("claude"),
          task,
          { systemPrompt: SYSTEM_PROMPT_60K },
          runId(),
        ),
      } as Record<string, { args: string[]; stdinPath?: string }>;
      for (const [bin, l] of Object.entries(launches)) {
        const length = windowsCommandLineLength(bin, l.args, true);
        expect(length, bin).toBeLessThan(WIN_SHELL_COMMAND_LINE_MAX);
        expect(l.args.join(" "), bin).not.toContain("You are InfiniBot. Follow the rules.");
        if (bin === "grok") expect(l.args).toContain("--prompt-file");
        else expect(l.stdinPath, bin).toBeTruthy();
        if (bin === "claude") expect(l.args).toContain("--append-system-prompt-file");
        proof.push({
          route: "coder spawn",
          backend: bin,
          spawn: "bare name (sized as cmd-shim)",
          task: size,
          length,
          budget: WIN_SHELL_COMMAND_LINE_MAX,
          transport: bin === "grok" ? "--prompt-file" : "stdin file",
        });
      }
    });
  }
});

// ── Plain-English failure text ──────────────────────────────────────────────

describe("ENAMETOOLONG / E2BIG never surface raw", () => {
  for (const raw of [
    "spawn ENAMETOOLONG",
    "Error: spawn E2BIG",
    "/bin/sh: 1: grok: Argument list too long",
    "The command line is too long.",
  ]) {
    it(raw, () => {
      expect(classifyCliFailure(raw)).toBe("command_too_long");
      const text = describeCliFailure({
        kind: "command_too_long",
        label: "Grok Build",
        command: "grok",
      });
      expect(text).not.toMatch(/ENAMETOOLONG|E2BIG/);
      expect(text).toMatch(/too long/);
    });
  }
});
