import { beforeEach, describe, expect, it, vi } from "vitest";

import { runClaudeCliAgent, runCliAgent } from "./claude-cli-runner.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { FailoverError } from "./failover-error.js";
import { SecureModeBlockedError } from "../secure-mode/policy.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI runner records each turn in the session transcript.
const TEST_SESSION_FILE = join(mkdtempSync(join(tmpdir(), "ib-cli-runner-test-")), "session.jsonl");

type Call = {
  argv: string[];
  stdin?: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
};
type Script = {
  /** Which call this script answers (default: the next call). */
  match?: (call: Call) => boolean;
  lines?: string[];
  code?: number | null;
  stderr?: string;
  timedOut?: boolean;
  spawnError?: NodeJS.ErrnoException;
  gate?: Promise<void>;
};

const calls: Call[] = [];
let scripts: Script[] = [];

vi.mock("./cli-runner/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-runner/stream.js")>();
  return {
    ...actual,
    runCliProcess: async (params: Call & { timeoutMs: number }) => {
      calls.push(params);
      const idx = scripts.findIndex((s) => !s.match || s.match(params));
      const script = idx >= 0 ? scripts.splice(idx, 1)[0]! : {};
      if (script.gate) await script.gate;
      for (const line of script.lines ?? []) params.onLine(line);
      return {
        code: script.spawnError ? null : (script.code ?? 0),
        signal: null,
        stderr: script.stderr ?? "",
        stdoutTail: (script.lines ?? []).join("\n"),
        timedOut: script.timedOut ?? false,
        aborted: false,
        spawnError: script.spawnError,
      };
    },
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

const claudeTurn = (sessionId: string, deltas: string[]) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
  ...deltas.map((text) =>
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    }),
  ),
  JSON.stringify({ type: "stream_event", event: { type: "content_block_stop" } }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: deltas.join(""),
    usage: { input_tokens: 3, output_tokens: 2 },
  }),
];

const base = {
  sessionFile: TEST_SESSION_FILE,
  workspaceDir: "/tmp",
  model: "opus",
  timeoutMs: 1_000,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runClaudeCliAgent (streaming)", () => {
  beforeEach(() => {
    calls.length = 0;
    scripts = [];
  });

  it("starts a new session with --session-id, prompt on stdin, InfiniBot MCP tools", async () => {
    scripts.push({ lines: claudeTurn("sid-1", ["o", "k"]) });
    const result = await runClaudeCliAgent({ ...base, sessionId: "s", prompt: "hi", runId: "r1" });
    const argv = calls[0]!.argv;
    expect(argv[0]).toBe("claude");
    expect(argv).toContain("--session-id");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--include-partial-messages");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__infinibot");
    // Built-in tools off; no permission bypass needed.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("hi");
    expect(calls[0]!.stdin).toBe("hi");
    // Subscription login only: API keys are stripped from the CLI's env.
    expect(calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.payloads?.[0]?.text).toBe("ok");
    expect(result.meta.agentMeta?.sessionId).toBe("sid-1");
    expect(result.meta.agentMeta?.usage).toMatchObject({ input: 3, output: 2 });
  });

  it("uses --resume with the stored CLI session id (multi-turn context)", async () => {
    scripts.push({ lines: claudeTurn("c9d7", ["again"]) });
    await runClaudeCliAgent({
      ...base,
      sessionId: "s",
      prompt: "hi",
      runId: "r2",
      claudeSessionId: "c9d7",
    });
    const argv = calls[0]!.argv;
    expect(argv[argv.indexOf("--resume") + 1]).toBe("c9d7");
    expect(argv).not.toContain("--session-id");
    // System prompt only goes with a session's first turn.
    expect(argv).not.toContain("--append-system-prompt");
  });

  it("streams growing reply text as assistant events and partial replies", async () => {
    scripts.push({ lines: claudeTurn("sid-3", ["Hel", "lo", " there"]) });
    const seen: string[] = [];
    const deltas: string[] = [];
    const off = onAgentEvent((evt) => {
      if (evt.runId === "r3" && evt.stream === "assistant") deltas.push(String(evt.data.delta));
    });
    await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "r3",
      onPartialReply: ({ text }) => {
        seen.push(text);
      },
    });
    off();
    expect(seen).toEqual(["Hel", "Hello", "Hello there"]);
    expect(deltas).toEqual(["Hel", "lo", " there"]);
  });

  it("runs different chats concurrently but keeps one chat's turns in order", async () => {
    const gateA = deferred();
    scripts.push(
      { match: (c) => c.stdin === "a-1", lines: claudeTurn("a", ["A1"]), gate: gateA.promise },
      { match: (c) => c.stdin === "b-1", lines: claudeTurn("b", ["B1"]) },
      { match: (c) => c.stdin === "a-2", lines: claudeTurn("a", ["A2"]) },
    );
    const a1 = runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "A",
      sessionKey: "agent:main:a",
      prompt: "a-1",
      runId: "a1",
    });
    const b1 = runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "B",
      sessionKey: "agent:main:b",
      prompt: "b-1",
      runId: "b1",
    });
    const a2 = runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "A",
      sessionKey: "agent:main:a",
      prompt: "a-2",
      runId: "a2",
    });
    // Chat B finishes while chat A's first turn is still running.
    expect((await b1).payloads?.[0]?.text).toBe("B1");
    // a-2 waits behind a-1 (same chat); only a-1 and b-1 have started.
    expect(calls.map((c) => c.stdin).sort()).toEqual(["a-1", "b-1"]);
    gateA.resolve();
    expect((await a1).payloads?.[0]?.text).toBe("A1");
    expect((await a2).payloads?.[0]?.text).toBe("A2");
    expect(calls).toHaveLength(3);
  });

  it("turns a plan usage limit into a rate_limit failover error with a clear message", async () => {
    scripts.push({
      code: 1,
      lines: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "x" }),
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt: 1792171200, rateLimitType: "five_hour" },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "Claude AI usage limit reached",
        }),
      ],
    });
    const err = await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "r5",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FailoverError);
    expect((err as FailoverError).reason).toBe("rate_limit");
    expect((err as Error).message).toMatch(/Claude Code has hit your plan's usage limit/);
  });

  it("reports a signed-out CLI as an auth failure", async () => {
    scripts.push({ code: 1, stderr: "Invalid API key · Please run /login" });
    const err = await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "r6",
    }).catch((e) => e);
    expect((err as FailoverError).reason).toBe("auth");
    expect((err as Error).message).toMatch(/isn't signed in/);
  });

  it("reports a missing binary as not installed", async () => {
    const spawnError = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    scripts.push({ spawnError });
    const err = await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "r7",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FailoverError);
    expect((err as Error).message).toMatch(/isn't installed/);
  });

  it("reports a timeout", async () => {
    scripts.push({ timedOut: true, code: null });
    const err = await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "r8",
    }).catch((e) => e);
    expect((err as FailoverError).reason).toBe("timeout");
  });

  it("refuses Secure Mode sessions for cloud CLIs, naming who receives the data", async () => {
    const err = await runCliAgent({
      ...base,
      provider: "claude-cli",
      sessionId: "s",
      sessionKey: "agent:main:secure-abc",
      prompt: "hi",
      runId: "r9",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SecureModeBlockedError);
    expect((err as Error).message).toMatch(/Anthropic's servers, off this computer/);
    expect(calls).toHaveLength(0);
  });
});

describe("runCliAgent codex-cli", () => {
  beforeEach(() => {
    calls.length = 0;
    scripts = [];
  });

  it("streams codex JSONL, inlines the system prompt on the first turn and resumes by thread id", async () => {
    scripts.push({
      lines: [
        JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PLUM" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 1 } }),
      ],
    });
    const first = await runCliAgent({
      ...base,
      provider: "codex-cli",
      model: "default",
      sessionId: "s",
      prompt: "remember PLUM",
      runId: "c1",
    });
    const argv1 = calls[0]!.argv;
    expect(argv1.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(argv1).toContain("read-only");
    expect(argv1).not.toContain("--model");
    expect(argv1.some((a) => a.startsWith("mcp_servers.infinibot.command="))).toBe(true);
    expect(calls[0]!.stdin).toMatch(/---\n\nremember PLUM$/);
    expect(calls[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(first.payloads?.[0]?.text).toBe("PLUM");
    expect(first.meta.agentMeta?.sessionId).toBe("th-1");

    scripts.push({
      lines: [
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PLUM" } }),
      ],
    });
    await runCliAgent({
      ...base,
      provider: "codex-cli",
      model: "default",
      sessionId: "s",
      prompt: "what word?",
      runId: "c2",
      cliSessionId: "th-1",
    });
    const argv2 = calls[1]!.argv;
    expect(argv2.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(argv2[argv2.length - 1]).toBe("th-1");
    // MCP overrides sit before the positional session id.
    expect(argv2.findIndex((a) => a.startsWith("mcp_servers."))).toBeLessThan(
      argv2.indexOf("th-1"),
    );
    expect(calls[1]!.stdin).toBe("what word?");
  });

  it("maps codex turn.failed usage limits to rate_limit", async () => {
    scripts.push({
      code: 1,
      lines: [
        JSON.stringify({
          type: "turn.failed",
          error: { message: "You've hit your usage limit. Try again at 3:05 PM." },
        }),
      ],
    });
    const err = await runCliAgent({
      ...base,
      provider: "codex-cli",
      sessionId: "s",
      prompt: "hi",
      runId: "c3",
    }).catch((e) => e);
    expect((err as FailoverError).reason).toBe("rate_limit");
    expect((err as Error).message).toMatch(/Codex CLI has hit your plan's usage limit/);
  });
});
