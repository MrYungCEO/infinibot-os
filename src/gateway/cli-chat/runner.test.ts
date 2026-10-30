import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  buildCliChatLaunch,
  createCliStreamParser,
  CliTurnAccumulator,
  humanizeCliChatError,
  isMissingSessionError,
  normalizeCliChatBackend,
  runCliChatTurn,
  stderrReason,
  type CliChatBackend,
} from "./runner.js";

function fold(backend: CliChatBackend, lines: unknown[]): CliTurnAccumulator {
  const parser = createCliStreamParser(backend);
  const acc = new CliTurnAccumulator();
  for (const l of lines)
    for (const ev of parser.feed(typeof l === "string" ? l : JSON.stringify(l))) acc.apply(ev);
  return acc;
}

const se = (event: unknown) => ({ type: "stream_event", event });

describe("normalizeCliChatBackend", () => {
  it("accepts the UI, PTY and cliRouting vocabularies", () => {
    expect(normalizeCliChatBackend("claude")).toBe("claude-code");
    expect(normalizeCliChatBackend("claude-cli")).toBe("claude-code");
    expect(normalizeCliChatBackend("Codex")).toBe("codex");
    expect(normalizeCliChatBackend("codex-cli")).toBe("codex");
    expect(normalizeCliChatBackend("oc")).toBe("opencode");
    expect(normalizeCliChatBackend("gemini-cli")).toBe("gemini");
    expect(normalizeCliChatBackend("cursor")).toBeNull();
    expect(normalizeCliChatBackend(42)).toBeNull();
  });
});

describe("buildCliChatLaunch", () => {
  it("claude: stream-json with partial messages, prompt on stdin, resume + model", () => {
    const l = buildCliChatLaunch({
      backend: "claude-code",
      prompt: "hi",
      model: "opus",
      resumeId: "abc",
    });
    expect(l.bin).toBe("claude");
    expect(l.args).toEqual(
      expect.arrayContaining(["-p", "stream-json", "--include-partial-messages"]),
    );
    expect(l.args.slice(-4)).toEqual(["--model", "opus", "--resume", "abc"]);
    expect(l.stdin).toBe("hi");
  });
  it("codex: model is a global flag, resume comes before the stdin marker", () => {
    const l = buildCliChatLaunch({
      backend: "codex",
      prompt: "hi",
      model: "gpt-5",
      resumeId: "t1",
    });
    expect(l.args.slice(0, 3)).toEqual(["--model", "gpt-5", "exec"]);
    expect(l.args.slice(-3)).toEqual(["resume", "t1", "-"]);
    expect(l.stdin).toBe("hi");
  });
  it("opencode + gemini carry the prompt in argv and resume their session", () => {
    expect(
      buildCliChatLaunch({ backend: "opencode", prompt: "hi", resumeId: "ses_1" }).args,
    ).toEqual(["run", "--format", "json", "--session", "ses_1", "hi"]);
    const g = buildCliChatLaunch({ backend: "gemini", prompt: "hi", model: "gemini-2.5-pro" });
    expect(g.args).toEqual([
      "-o",
      "stream-json",
      "--approval-mode",
      "yolo",
      "-m",
      "gemini-2.5-pro",
      "-p",
      "hi",
    ]);
  });
  it("a fresh session has no resume flag", () => {
    expect(buildCliChatLaunch({ backend: "claude-code", prompt: "x" }).args).not.toContain(
      "--resume",
    );
  });
});

describe("claude stream-json parser", () => {
  const lines = [
    { type: "system", subtype: "hook_started" },
    { type: "system", subtype: "init", session_id: "s-1", cwd: "/tmp" },
    se({ type: "message_start", message: { id: "m1" } }),
    se({ type: "content_block_start", content_block: { type: "thinking" } }),
    se({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }),
    se({ type: "content_block_stop" }),
    se({ type: "content_block_start", content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", delta: { type: "text_delta", text: "p" } }),
    se({ type: "content_block_delta", delta: { type: "text_delta", text: "ong" } }),
    { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "pong" }] } },
    se({ type: "content_block_stop" }),
    {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "pwd", description: "Print dir" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "/tmp/clichat-probe",
            is_error: false,
          },
        ],
      },
    },
    se({ type: "message_start", message: { id: "m2" } }),
    se({ type: "content_block_start", content_block: { type: "text", text: "" } }),
    se({ type: "content_block_delta", delta: { type: "text_delta", text: "The folder is " } }),
    se({ type: "content_block_delta", delta: { type: "text_delta", text: "`clichat-probe`." } }),
    {
      type: "assistant",
      message: { id: "m2", content: [{ type: "text", text: "The folder is `clichat-probe`." }] },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s-1",
      result: "The folder is `clichat-probe`.",
    },
  ];

  it("streams text without duplicating the assistant snapshot, separates blocks, folds the tool", () => {
    const acc = fold("claude-code", lines);
    expect(acc.reply).toBe("pong\n\nThe folder is `clichat-probe`.");
    expect(acc.sessionId).toBe("s-1");
    expect(acc.done).toBe(true);
    expect(acc.errors).toEqual([]);
    expect(acc.tools).toEqual([
      { id: "t1", name: "Bash", input: "pwd", status: "done", output: "/tmp/clichat-probe" },
    ]);
  });

  it("falls back to the assistant snapshot when partial messages are off", () => {
    const acc = fold("claude-code", [
      { type: "assistant", message: { id: "m9", content: [{ type: "text", text: "hello" }] } },
      { type: "result", is_error: false },
    ]);
    expect(acc.reply).toBe("hello");
  });

  it("reports an is_error result", () => {
    const acc = fold("claude-code", [
      { type: "result", is_error: true, result: "No conversation found with session ID: x" },
    ]);
    expect(acc.errors).toEqual(["No conversation found with session ID: x"]);
  });

  it("ignores non-JSON noise", () => {
    expect(fold("claude-code", ["not json", "", "{broken"]).reply).toBe("");
  });
});

describe("codex exec --json parser", () => {
  it("keeps agent messages as blocks and folds command executions", () => {
    const acc = fold("codex", [
      { type: "thread.started", thread_id: "th-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "pong." } },
      {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/bash -lc pwd",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "/bin/bash -lc pwd",
          aggregated_output: "/tmp/x\n",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } },
      { type: "turn.completed", usage: { input_tokens: 1 } },
    ]);
    expect(acc.sessionId).toBe("th-1");
    expect(acc.reply).toBe("pong.\n\nDone.");
    expect(acc.tools).toEqual([
      { id: "item_1", name: "shell", input: "/bin/bash -lc pwd", status: "done", output: "/tmp/x" },
    ]);
    expect(acc.done).toBe(true);
  });

  it("marks failed commands and turn failures", () => {
    const acc = fold("codex", [
      {
        type: "item.completed",
        item: {
          id: "c",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
        },
      },
      { type: "turn.failed", error: { message: "usage limit reached" } },
    ]);
    expect(acc.tools[0].status).toBe("error");
    expect(acc.errors).toEqual(["usage limit reached"]);
  });
});

describe("opencode + gemini parsers", () => {
  it("opencode: session id, text parts, tool states, API errors", () => {
    const acc = fold("opencode", [
      { type: "step_start", sessionID: "ses_1", part: {} },
      {
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          callID: "c1",
          tool: "bash",
          state: { status: "completed", input: { command: "ls" }, output: "a\nb" },
        },
      },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "Two files." } },
      {
        type: "error",
        sessionID: "ses_1",
        error: { name: "APIError", data: { message: "payment required" } },
      },
    ]);
    expect(acc.sessionId).toBe("ses_1");
    expect(acc.reply).toBe("Two files.");
    expect(acc.tools).toEqual([
      { id: "c1", name: "bash", input: "ls", status: "done", output: "a\nb" },
    ]);
    expect(acc.errors).toEqual(["payment required"]);
  });

  it("gemini: init session, streamed deltas, tool use/result, error result", () => {
    const acc = fold("gemini", [
      { type: "init", session_id: "g-1", model: "gemini-2.5-pro" },
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", content: "Hel", delta: true },
      { type: "message", role: "assistant", content: "lo", delta: true },
      {
        type: "tool_use",
        tool_name: "run_shell_command",
        tool_id: "x1",
        parameters: { command: "pwd" },
      },
      { type: "tool_result", tool_id: "x1", status: "success", output: "/home" },
      { type: "message", role: "assistant", content: "Folder: home", delta: true },
      { type: "result", status: "success" },
    ]);
    expect(acc.sessionId).toBe("g-1");
    expect(acc.reply).toBe("Hello\n\nFolder: home");
    expect(acc.tools).toEqual([
      { id: "x1", name: "run_shell_command", input: "pwd", status: "done", output: "/home" },
    ]);
    expect(acc.done).toBe(true);
  });
});

describe("failure helpers", () => {
  it("stderrReason drops banner noise", () => {
    expect(
      stderrReason(
        "YOLO mode is enabled. All tool calls will be automatically approved.\nLoaded cached credentials.\nThis account requires setting the GOOGLE_CLOUD_PROJECT env var.\n",
      ),
    ).toMatch(/^This Google account needs a Google Cloud project to use Gemini CLI\./);
  });
  it("recognises a vanished CLI session", () => {
    expect(isMissingSessionError("No conversation found with session ID: 123")).toBe(true);
    expect(isMissingSessionError("Error: session ses_9 not found")).toBe(true);
    expect(isMissingSessionError("rate limited")).toBe(false);
  });
});

/** Minimal ChildProcess stand-in that replays stdout lines then exits. */
function fakeSpawn(
  scripts: Array<{ lines: unknown[]; code: number; stderr?: string }>,
  calls: string[][],
) {
  return ((_cmd: string, args: string[]) => {
    calls.push(args);
    const script = scripts.shift() ?? { lines: [], code: 0 };
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = new PassThrough();
    child.pid = undefined;
    child.kill = () => true;
    setImmediate(() => {
      for (const l of script.lines) stdout.write(`${JSON.stringify(l)}\n`);
      if (script.stderr) stderr.write(script.stderr);
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", script.code));
    });
    return child;
  }) as never;
}

describe("runCliChatTurn", () => {
  it("streams progress and returns the reply + session id", async () => {
    const calls: string[][] = [];
    const seen: string[] = [];
    const handle = runCliChatTurn({
      backend: "codex",
      prompt: "hi",
      cwd: process.cwd(),
      spawnImpl: fakeSpawn(
        [
          {
            lines: [
              { type: "thread.started", thread_id: "th" },
              { type: "item.completed", item: { id: "a", type: "agent_message", text: "hello" } },
              { type: "turn.completed" },
            ],
            code: 0,
          },
        ],
        calls,
      ),
      onProgress: (acc) => seen.push(acc.reply),
    });
    const res = await handle.result;
    expect(res).toMatchObject({
      text: "hello",
      sessionId: "th",
      error: null,
      aborted: false,
      restarted: false,
    });
    expect(seen).toContain("hello");
  });

  it("retries as a fresh session when the stored one is gone", async () => {
    const calls: string[][] = [];
    const handle = runCliChatTurn({
      backend: "claude-code",
      prompt: "hi",
      cwd: process.cwd(),
      resumeId: "old",
      spawnImpl: fakeSpawn(
        [
          {
            lines: [
              {
                type: "result",
                is_error: true,
                result: "No conversation found with session ID: old",
              },
            ],
            code: 1,
          },
          {
            lines: [
              { type: "system", subtype: "init", session_id: "new" },
              { type: "assistant", message: { id: "m", content: [{ type: "text", text: "ok" }] } },
              { type: "result", is_error: false, session_id: "new" },
            ],
            code: 0,
          },
        ],
        calls,
      ),
    });
    const res = await handle.result;
    expect(calls[0]).toContain("--resume");
    expect(calls[1]).not.toContain("--resume");
    expect(res).toMatchObject({ text: "ok", sessionId: "new", restarted: true, error: null });
  });

  it("surfaces stderr when the CLI dies without output", async () => {
    const res = await runCliChatTurn({
      backend: "gemini",
      prompt: "hi",
      cwd: process.cwd(),
      spawnImpl: fakeSpawn(
        [
          {
            lines: [],
            code: 41,
            stderr:
              "Loaded cached credentials.\nThis account requires setting the GOOGLE_CLOUD_PROJECT env var.\n",
          },
        ],
        [],
      ),
    }).result;
    expect(res.error).toMatch(
      /^This Google account needs a Google Cloud project to use Gemini CLI\./,
    );
  });
});

/** A spawn that fails the way Node does on Windows for a bare .cmd shim. */
function failingSpawn(code: string, message: string, calls: string[] = []) {
  return ((cmd: string) => {
    calls.push(cmd);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = undefined;
    child.kill = () => true;
    setImmediate(() => child.emit("error", Object.assign(new Error(message), { code })));
    return child;
  }) as never;
}

describe("Grok Build in chat CLI mode", () => {
  it("is a chat backend with its own vocabulary", () => {
    expect(normalizeCliChatBackend("grok")).toBe("grok");
    expect(normalizeCliChatBackend("grok-cli")).toBe("grok");
    expect(normalizeCliChatBackend("Grok-Build")).toBe("grok");
  });

  it("builds a headless streaming-json launch with the prompt in -p", () => {
    const l = buildCliChatLaunch({
      backend: "grok",
      prompt: "hi",
      model: "grok-4.6",
      resumeId: "s1",
    });
    expect(l.bin).toBe("grok");
    expect(l.stdin).toBeUndefined();
    expect(l.args).toEqual([
      "--output-format",
      "streaming-json",
      "--always-approve",
      "-m",
      "grok-4.6",
      "--resume",
      "s1",
      "-p",
      "hi",
    ]);
    // Too long for argv: never refused — it goes through --prompt-file.
    const big = buildCliChatLaunch({
      backend: "grok",
      prompt: "x".repeat(200_000),
      writePromptFile: () => "/tmp/p.txt",
    });
    expect(big.args.slice(-2)).toEqual(["--prompt-file", "/tmp/p.txt"]);
    expect(big.args).not.toContain("-p");
    expect(big.tempFiles).toEqual(["/tmp/p.txt"]);
  });

  it("folds text deltas, tool calls and the session id", () => {
    const acc = fold("grok", [
      { type: "text", data: "Hel" },
      { type: "text", data: "lo" },
      { type: "tool_call", toolCallId: "t1", toolName: "bash", rawInput: { command: "ls" } },
      { type: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "a.txt" },
      { type: "text", data: "Done." },
      { type: "end", sessionId: "grok-sess", usage: {} },
    ]);
    expect(acc.reply).toBe("Hello\n\nDone.");
    expect(acc.sessionId).toBe("grok-sess");
    expect(acc.tools).toEqual([
      { id: "t1", name: "bash", input: "ls", status: "done", output: "a.txt" },
    ]);
    expect(acc.done).toBe(true);
  });

  it("reports in-band errors", () => {
    const acc = fold("grok", [{ type: "error", message: "Not logged in. Run grok login" }]);
    expect(acc.errors).toEqual(["Not logged in. Run grok login"]);
  });
});

describe("humanizeCliChatError", () => {
  it("never shows a raw spawn error", () => {
    for (const raw of ["spawn EINVAL", "spawn C:\\npm\\codex.cmd EINVAL", "spawn EACCES"]) {
      const h = humanizeCliChatError("codex", raw);
      expect(h.kind).toBe("spawn_failed");
      expect(h.message).toBe(
        "Codex couldn't be started on this computer. Reinstall it from Setup › Coders (or update InfiniBot), then try again.",
      );
    }
  });

  it("maps not installed / signed out / limits / plan to a next step", () => {
    expect(humanizeCliChatError("grok", "spawn grok ENOENT").message).toMatch(
      /^Grok Build isn't installed on this computer .*Setup › Coders/,
    );
    expect(
      humanizeCliChatError("codex", "Error: Not logged in. Please run `codex login`").message,
    ).toMatch(/^Codex isn't signed in\. Sign in from Setup › Coders/);
    expect(
      humanizeCliChatError("claude-code", "Claude AI usage limit reached|1761700000").kind,
    ).toBe("rate_limit");
    // Real OpenCode + Ollama Cloud failure seen on the owner's box (2026-10-28).
    const oc = humanizeCliChatError(
      "opencode",
      "usage credits auto reload payment failed, update your payment method or add usage credits at https://ollama.com/settings",
    );
    expect(oc.kind).toBe("rate_limit");
    expect(oc.message).toMatch(/^OpenCode has hit your plan's usage limit\./);
    expect(
      humanizeCliChatError(
        "claude-code",
        "Your organization does not have access to Claude Code. Upgrade your plan.",
      ).message,
    ).toMatch(/^Claude Code is signed in, but your plan doesn't include this\./);
  });

  it("never returns a lone bracket", () => {
    const h = humanizeCliChatError("gemini", "}");
    expect(h.message).toBe("Gemini CLI couldn't answer.");
    const h2 = humanizeCliChatError("gemini", "{\n  code: 500,\n  message: 'Internal error'\n}");
    expect(h2.message).toBe("Gemini CLI couldn't answer: Internal error");
  });

  it("keeps Gemini's free-account explanation (from the Gemini fix)", () => {
    const h = humanizeCliChatError(
      "gemini",
      "IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals",
    );
    expect(h.kind).toBe("unsupported_account");
    expect(h.message).toMatch(/free Google accounts/);
  });
});

describe("runCliChatTurn spawn failures", () => {
  it("turns spawn EINVAL into a plain sentence (owner's Windows Codex bug)", async () => {
    const res = await runCliChatTurn({
      backend: "codex",
      prompt: "go to my agent mesh",
      cwd: process.cwd(),
      spawnImpl: failingSpawn("EINVAL", "spawn EINVAL"),
    }).result;
    expect(res.errorKind).toBe("spawn_failed");
    expect(res.error).not.toMatch(/EINVAL/);
    expect(res.error).toMatch(/^Codex couldn't be started on this computer\./);
  });

  it("says not installed for ENOENT", async () => {
    const res = await runCliChatTurn({
      backend: "opencode",
      prompt: "hi",
      cwd: process.cwd(),
      spawnImpl: failingSpawn("ENOENT", "spawn opencode ENOENT"),
    }).result;
    expect(res.errorKind).toBe("not_installed");
    expect(res.error).toMatch(/^OpenCode isn't installed on this computer/);
  });
});
