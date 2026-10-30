import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEntry } from "../../config/sessions/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-cli-test-"));
const storePath = path.join(tmp, "sessions.json");
let store: Record<string, SessionEntry> = {};

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: (key: string) => ({
    storePath,
    entry: store[key],
    canonicalKey: key,
    cfg: {},
    store,
  }),
}));
vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: async (_p: string, fn: (s: Record<string, SessionEntry>) => void) =>
    fn(store),
}));

type Turn = { opts: Record<string, unknown>; resolve: (r: unknown) => void; aborted: boolean };
const turns: Turn[] = [];
vi.mock("../cli-chat/runner.js", async (orig) => {
  const real = await orig<typeof import("../cli-chat/runner.js")>();
  return {
    ...real,
    runCliChatTurn: (opts: Record<string, unknown>) => {
      let resolve!: (r: unknown) => void;
      const result = new Promise((r) => (resolve = r));
      const t: Turn = { opts, resolve, aborted: false };
      turns.push(t);
      return {
        result,
        abort: () => {
          t.aborted = true;
          resolve({
            text: "partial",
            tools: [],
            sessionId: null,
            error: null,
            aborted: true,
            exitCode: null,
            restarted: false,
          });
        },
      };
    },
  };
});

// The built-in-model fallback calls chat.send; tests decide whether it accepts.
const chatSendCalls: Array<Record<string, unknown>> = [];
let chatSendAccepts = false;
vi.mock("./chat.js", () => ({
  chatHandlers: {
    "chat.send": async (opts: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown) => void;
    }) => {
      chatSendCalls.push(opts.params);
      opts.respond(chatSendAccepts, chatSendAccepts ? { status: "started" } : undefined);
    },
  },
}));
const agentEvents: Array<Record<string, unknown>> = [];
vi.mock("../../infra/agent-events.js", () => ({
  emitAgentEvent: (evt: Record<string, unknown>) => agentEvents.push(evt),
}));

const {
  chatCliHandlers,
  __activeCliTurnsForTest,
  resetCliFallbackNoticesForTest,
  shouldFallBackToAgent,
} = await import("./chat-cli.js");

function ctx() {
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    context: {
      broadcast: (event: string, payload: Record<string, unknown>) =>
        events.push({ event, payload }),
      nodeSendToSession: () => undefined,
      agentRunSeq: new Map<string, number>(),
      logGateway: { warn: () => undefined },
    },
  };
}

async function call(method: string, params: Record<string, unknown>, c = ctx()) {
  let out: { ok: boolean; payload?: unknown; error?: { message?: string } } | null = null;
  await (chatCliHandlers[method] as (a: unknown) => Promise<void> | void)({
    params,
    respond: (ok: boolean, payload?: unknown, error?: { message?: string }) =>
      (out = { ok, payload, error }),
    context: c.context,
  });
  return { res: out!, ...c };
}

const flush = () => new Promise((r) => setTimeout(r, 30));
const KEY = "agent:main:webchat-test";

beforeEach(() => {
  store = {};
  turns.length = 0;
  chatSendCalls.length = 0;
  chatSendAccepts = false;
  agentEvents.length = 0;
  resetCliFallbackNoticesForTest();
  __activeCliTurnsForTest().clear();
});
afterEach(() => vi.useRealTimers());

describe("chat.cli.send", () => {
  it("creates the thread, logs both turns, streams a final and saves the CLI session id", async () => {
    const c = ctx();
    const { res } = await call(
      "chat.cli.send",
      {
        sessionKey: KEY,
        idempotencyKey: "run-1",
        message: "pwd please",
        backend: "codex",
        cwd: tmp,
      },
      c,
    );
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      runId: "run-1",
      backend: "codex",
      cwd: tmp,
      resumed: false,
    });
    expect(store[KEY].cliChat).toMatchObject({ mode: "cli", backend: "codex", cwd: tmp });
    expect(turns[0].opts).toMatchObject({
      backend: "codex",
      prompt: "pwd please",
      cwd: tmp,
      resumeId: null,
    });

    turns[0].resolve({
      text: "The folder is x.",
      tools: [{ id: "i1", name: "shell", input: "pwd", status: "done", output: "/x" }],
      sessionId: "thread-9",
      error: null,
      aborted: false,
      exitCode: 0,
      restarted: false,
    });
    await flush();

    expect(store[KEY].cliChat?.sessions?.codex).toBe("thread-9");
    const final = c.events.find((e) => e.payload.state === "final");
    expect(final?.event).toBe("chat");
    expect(final?.payload).toMatchObject({ runId: "run-1", sessionKey: KEY });
    const msg = final?.payload.message as Record<string, unknown>;
    expect(msg.cli).toEqual({ backend: "codex", cwd: tmp });
    expect(msg.cliTools).toHaveLength(1);

    const transcript = fs
      .readFileSync(path.join(tmp, `${store[KEY].sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(transcript[0].type).toBe("session");
    expect(transcript[1].message).toMatchObject({ role: "user", cli: { backend: "codex" } });
    expect(transcript[2].message).toMatchObject({ role: "assistant", stopReason: "stop" });
    expect(__activeCliTurnsForTest().size).toBe(0);
  });

  it("resumes the backend's saved session on the next turn", async () => {
    store[KEY] = {
      sessionId: "s1",
      updatedAt: 1,
      cliChat: {
        mode: "cli",
        backend: "claude-code",
        sessions: { "claude-code": "cc-1", codex: "cx-1" },
        updatedAt: 1,
      },
    };
    await call("chat.cli.send", { sessionKey: KEY, message: "hi", backend: "claude", cwd: tmp });
    expect(turns[0].opts.resumeId).toBe("cc-1");
  });

  it("rejects a second turn while one runs, bad folders and unknown CLIs", async () => {
    await call("chat.cli.send", { sessionKey: KEY, message: "one", backend: "codex", cwd: tmp });
    const busy = await call("chat.cli.send", {
      sessionKey: KEY,
      message: "two",
      backend: "codex",
      cwd: tmp,
    });
    expect(busy.res.ok).toBe(false);
    expect(busy.res.error?.message).toMatch(/still answering/);
    const bad = await call("chat.cli.send", {
      sessionKey: "k2",
      message: "x",
      backend: "codex",
      cwd: "/no/such/dir",
    });
    expect(bad.res.error?.message).toMatch(/Folder not found/);
    const unk = await call("chat.cli.send", { sessionKey: "k3", message: "x", backend: "cursor" });
    expect(unk.res.error?.message).toMatch(/Unknown CLI/);
  });

  it("chat.cli.abort stops the run and the final says so", async () => {
    const c = ctx();
    await call(
      "chat.cli.send",
      { sessionKey: KEY, idempotencyKey: "r2", message: "long job", backend: "gemini", cwd: tmp },
      c,
    );
    const ab = await call("chat.cli.abort", { sessionKey: KEY });
    expect(ab.res.payload).toMatchObject({ aborted: true, runId: "r2" });
    await flush();
    const final = c.events.find((e) => e.payload.state === "final");
    const text = (final?.payload.message as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("partial");
    expect(text).toContain("Stopped");
  });

  it("surfaces a CLI error in the reply", async () => {
    const c = ctx();
    await call(
      "chat.cli.send",
      { sessionKey: KEY, idempotencyKey: "r3", message: "hi", backend: "opencode", cwd: tmp },
      c,
    );
    turns[0].resolve({
      text: "",
      tools: [],
      sessionId: null,
      error: "payment required",
      aborted: false,
      exitCode: 1,
      restarted: false,
    });
    await flush();
    const msg = c.events.find((e) => e.payload.state === "final")?.payload.message as Record<
      string,
      unknown
    >;
    // The built-in model was tried first (it refused here), then the error shows.
    expect(chatSendCalls).toHaveLength(1);
    expect(JSON.stringify(msg.content)).toContain("⚠️ payment required");
    expect(msg.cli).toMatchObject({ backend: "opencode", error: true });
    // The user turn is still in the transcript exactly once.
    const file = fs
      .readdirSync(tmp)
      .find((f) => f.endsWith(".jsonl") && f.startsWith(store[KEY].sessionId))!;
    const users = fs
      .readFileSync(path.join(tmp, file), "utf-8")
      .split("\n")
      .filter((l) => l.includes('"role":"user"'));
    expect(users).toHaveLength(1);
  });

  it("falls back to the built-in model when the CLI fails, telling the user once", async () => {
    chatSendAccepts = true;
    const failTurn = async (runId: string) => {
      const c = ctx();
      await call(
        "chat.cli.send",
        {
          sessionKey: KEY,
          idempotencyKey: runId,
          message: "go to my agent mesh",
          backend: "codex",
          cwd: tmp,
        },
        c,
      );
      turns.at(-1)!.resolve({
        text: "",
        tools: [],
        sessionId: null,
        error:
          "Codex couldn't be started on this computer. Reinstall it from Setup › Coders (or update InfiniBot), then try again.",
        errorKind: "spawn_failed",
        aborted: false,
        exitCode: null,
        restarted: false,
      });
      await flush();
      return c;
    };
    const c = await failTurn("fb1");
    // Same runId, so the waiting UI keeps streaming the agent's answer.
    expect(chatSendCalls[0]).toMatchObject({
      sessionKey: KEY,
      message: "go to my agent mesh",
      idempotencyKey: "fb1",
      deliver: false,
    });
    // No CLI "final" (the agent run sends its own) and no raw error text.
    expect(c.events.some((e) => e.payload.state === "final")).toBe(false);
    const notices = agentEvents.filter((e) => e.stream === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ runId: "fb1", sessionKey: KEY });
    const data = notices[0].data as Record<string, unknown>;
    expect(data.kind).toBe("cli_fallback");
    expect(String(data.message)).toContain("couldn't be started");
    expect(String(data.message)).toContain("built-in model");
    expect(String(data.message)).not.toMatch(/EINVAL|spawn /);
    // chat.send writes the user turn, so ours was removed (no duplicate).
    const file = fs
      .readdirSync(tmp)
      .find((f) => f.endsWith(".jsonl") && f.startsWith(store[KEY].sessionId))!;
    const raw = fs.existsSync(path.join(tmp, file))
      ? fs.readFileSync(path.join(tmp, file), "utf-8")
      : "";
    expect(raw).not.toContain("go to my agent mesh");
    // Second failure of the same kind: still falls back, but silently.
    await failTurn("fb2");
    expect(chatSendCalls).toHaveLength(2);
    expect(agentEvents.filter((e) => e.stream === "notice")).toHaveLength(1);
  });

  it("only falls back when nothing was answered", () => {
    const base = { text: "", error: "x failed", aborted: false };
    expect(shouldFallBackToAgent(base)).toBe(true);
    expect(shouldFallBackToAgent({ ...base, text: "partial answer" })).toBe(false);
    expect(shouldFallBackToAgent({ ...base, aborted: true })).toBe(false);
    expect(shouldFallBackToAgent({ ...base, error: null })).toBe(false);
    expect(
      shouldFallBackToAgent({ ...base, error: "Message is too long for Grok Build (100 KB max)." }),
    ).toBe(false);
  });
});

describe("chat.cli.mode / chat.cli.state", () => {
  it("remembers the thread's choice and reports it back", async () => {
    const set = await call("chat.cli.mode", {
      sessionKey: KEY,
      mode: "cli",
      backend: "codex",
      cwd: tmp,
      model: "gpt-x",
    });
    expect(set.res.ok).toBe(true);
    expect(store[KEY].cliChat).toMatchObject({
      mode: "cli",
      backend: "codex",
      cwd: tmp,
      models: { codex: "gpt-x" },
    });
    await call("chat.cli.mode", { sessionKey: KEY, mode: "agent" });
    const st = await call("chat.cli.state", { sessionKey: KEY });
    expect(st.res.payload).toMatchObject({
      state: { mode: "agent", backend: "codex" },
      active: null,
    });
  });

  it("validates mode and backend", async () => {
    expect((await call("chat.cli.mode", { sessionKey: KEY, mode: "x" })).res.ok).toBe(false);
    expect(
      (await call("chat.cli.mode", { sessionKey: KEY, mode: "cli", backend: "nope" })).res.ok,
    ).toBe(false);
  });
});
