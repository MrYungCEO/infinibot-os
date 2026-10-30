/**
 * xAI Grok Build ("GrokBot", provider grok-cli) through the CLI runner: argv
 * for a new turn / resume / long prompt, the model flag, no API key in the
 * env, streaming-json parsing and failure mapping. The CLI process is mocked
 * (no billed call, no real `grok` needed); the real-binary path is covered by
 * scripts/e2e/grok-cli-routing-side-gw.mjs with a fake `grok` on PATH.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCliAgent } from "./cli-runner.js";
import { FailoverError } from "./failover-error.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CLI runner records each turn in the session transcript.
const TEST_SESSION_FILE = join(mkdtempSync(join(tmpdir(), "ib-cli-runner-test-")), "session.jsonl");

type Call = { argv: string[]; stdin?: string; env: NodeJS.ProcessEnv; onLine: (l: string) => void };
type Script = { lines?: string[]; code?: number; stderr?: string };

const calls: Call[] = [];
let scripts: Script[] = [];

vi.mock("./cli-runner/stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-runner/stream.js")>();
  return {
    ...actual,
    runCliProcess: async (params: Call & { timeoutMs: number }) => {
      calls.push(params);
      const script = scripts.shift() ?? {};
      for (const line of script.lines ?? []) params.onLine(line);
      return {
        code: script.code ?? 0,
        signal: null,
        stderr: script.stderr ?? "",
        stdoutTail: (script.lines ?? []).join("\n"),
        timedOut: false,
        aborted: false,
      };
    },
  };
});

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: vi.fn(),
  runExec: vi.fn(async () => ({ stdout: "", stderr: "" })),
}));

const grokTurn = (sessionId: string, chunks: string[]) => [
  ...chunks.map((data) => JSON.stringify({ type: "text", data })),
  JSON.stringify({ type: "end", sessionId, usage: { input_tokens: 5, output_tokens: 2 } }),
];

const base = {
  sessionFile: TEST_SESSION_FILE,
  workspaceDir: "/tmp",
  timeoutMs: 1_000,
  provider: "grok-cli",
};

describe("grok-cli backend (xAI Grok Build)", () => {
  beforeEach(() => {
    calls.length = 0;
    scripts = [];
    process.env.XAI_API_KEY = "xai-should-not-leak";
  });

  it("is a built-in backend with the documented headless flags", () => {
    const cfg = resolveCliBackendConfig("grok-cli")?.config;
    expect(cfg).toMatchObject({
      command: "grok",
      args: ["--output-format", "streaming-json"],
      promptArg: "-p",
      modelArg: "-m",
      stream: "grok-streaming-json",
    });
    expect(cfg?.clearEnv).toContain("XAI_API_KEY");
  });

  it("new turn: grok --output-format streaming-json … -p <prompt>, no --resume, no key", async () => {
    scripts.push({ lines: grokTurn("g-1", ["Hel", "lo"]) });
    const res = await runCliAgent({
      ...base,
      model: "default",
      sessionId: "s1",
      prompt: "say hello",
      runId: "r1",
    });
    const argv = calls[0]!.argv;
    expect(argv[0]).toBe("grok");
    expect(argv.slice(1, 3)).toEqual(["--output-format", "streaming-json"]);
    expect(argv).not.toContain("--resume");
    // "default" = the CLI's own model: no -m flag.
    expect(argv).not.toContain("-m");
    const p = argv.indexOf("-p");
    expect(p).toBeGreaterThan(0);
    expect(argv[p + 1]).toMatch(/say hello$/);
    expect(calls[0]!.env.XAI_API_KEY).toBeUndefined();
    expect(res.payloads?.[0]?.text).toBe("Hello");
    expect(res.meta.agentMeta?.sessionId).toBe("g-1");
    // The turn lands in the InfiniBot transcript (chat history on every surface).
    const lines = readFileSync(TEST_SESSION_FILE, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const msgs = lines.filter((l) => l.type === "message").map((l) => l.message);
    expect(msgs.at(-2)).toMatchObject({ role: "user", content: [{ text: "say hello" }] });
    expect(msgs.at(-1)).toMatchObject({
      role: "assistant",
      provider: "grok-cli",
      content: [{ text: "Hello" }],
    });
  });

  it("explicit model → -m <model> on a new session; a stored session → --resume <id>", async () => {
    scripts.push({ lines: grokTurn("g-1", ["first"]) });
    await runCliAgent({
      ...base,
      model: "grok-code-fast-1",
      sessionId: "s1",
      prompt: "start",
      runId: "r2a",
    });
    const argv1 = calls[0]!.argv;
    expect(argv1[argv1.indexOf("-m") + 1]).toBe("grok-code-fast-1");

    scripts.push({ lines: grokTurn("g-1", ["again"]) });
    await runCliAgent({
      ...base,
      model: "grok-code-fast-1",
      sessionId: "s1",
      prompt: "and again",
      runId: "r2b",
      cliSessionId: "g-1",
    });
    const argv2 = calls[1]!.argv;
    expect(argv2[argv2.indexOf("--resume") + 1]).toBe("g-1");
    // Like every resumed CLI session, the session keeps the model it started on.
    expect(argv2).not.toContain("-m");
    expect(argv2[argv2.indexOf("-p") + 1]).toBe("and again");
  });

  it("a prompt past the argv limit goes through --prompt-file", async () => {
    scripts.push({ lines: grokTurn("g-2", ["ok"]) });
    await runCliAgent({
      ...base,
      model: "default",
      sessionId: "s2",
      prompt: "x".repeat(120_000),
      runId: "r3",
    });
    const argv = calls[0]!.argv;
    expect(argv).toContain("--prompt-file");
    expect(argv.some((a) => a.length > 100_000)).toBe(false);
  });

  it("signed out → auth failover error naming Grok Build", async () => {
    scripts.push({
      code: 1,
      lines: [
        JSON.stringify({
          type: "error",
          message:
            "Not signed in. To authenticate without a browser, run:\n  grok login --device-code",
        }),
      ],
    });
    const err = await runCliAgent({
      ...base,
      model: "default",
      sessionId: "s3",
      prompt: "hi",
      runId: "r4",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FailoverError);
    expect((err as FailoverError).reason).toBe("auth");
    expect(String((err as Error).message)).toMatch(/Grok Build/);
  });
});
