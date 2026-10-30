import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tmux-backend.js", () => ({
  isTmuxAvailable: () => true,
  hasLiveSession: async () => true,
  getPaneCurrentCommand: async () => "2.1.268",
  capturePane: async () => "\x1b[32m> hello\x1b[0m\n  ⏵⏵ bypass permissions on\n\n",
  killSession: async () => {},
  tmuxSessionName: (id: string) => `infinibot_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
}));

const {
  ClaudeTranscriptTurnReader,
  claudeBridgeTerminalId,
  classifyClaudeStartupScreen,
  encodeClaudePrompt,
  sendToClaudeBridge,
  stripAnsi,
} = await import("./claude-chat-bridge.js");

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", uuid, message: { role: "user", content }, ...extra });
const assistant = (uuid: string, text: string, stopReason: string) =>
  line({
    type: "assistant",
    uuid,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
const turnEnd = (uuid: string) =>
  line({ type: "system", subtype: "turn_duration", uuid, durationMs: 1234 });

describe("ClaudeTranscriptTurnReader", () => {
  it("ignores the previous turn until our prompt lands, then ends on turn_duration", () => {
    const reader = new ClaudeTranscriptTurnReader();
    const events = reader.feed(
      assistant("old-a", "old reply", "end_turn") +
        turnEnd("old-end") +
        user("u1", "fix the bug") +
        line({
          type: "assistant",
          uuid: "t1",
          message: { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "…" }] },
        }) +
        assistant("a1", "Looking at the file.", "tool_use") +
        user("r1", [{ type: "tool_result", content: "ok" }]) +
        assistant("a2", "Fixed it.", "end_turn") +
        turnEnd("end"),
    );
    expect(events).toEqual([
      { kind: "accepted" },
      { kind: "text", text: "Looking at the file.", stopReason: "tool_use" },
      { kind: "text", text: "Fixed it.", stopReason: "end_turn" },
      { kind: "end", reason: "turn_duration" },
    ]);
    expect(reader.ended).toBe(true);
  });

  it("reassembles lines split across reads and skips sidechain + duplicate entries", () => {
    const reader = new ClaudeTranscriptTurnReader();
    const full =
      user("u1", [{ type: "text", text: "hi" }]) +
      line({ ...JSON.parse(assistant("s1", "subagent", "end_turn")), isSidechain: true }) +
      assistant("a1", "hello", "end_turn") +
      assistant("a1", "hello", "end_turn");
    const cut = full.length - 20;
    const events = [...reader.feed(full.slice(0, cut)), ...reader.feed(full.slice(cut))];
    expect(events).toEqual([
      { kind: "accepted" },
      { kind: "text", text: "hello", stopReason: "end_turn" },
    ]);
  });

  it("ends on an interrupt and on API errors", () => {
    const interrupted = new ClaudeTranscriptTurnReader();
    expect(
      interrupted.feed(
        user("u1", "go") + user("u2", [{ type: "text", text: "[Request interrupted by user]" }]),
      ),
    ).toContainEqual({ kind: "end", reason: "interrupted" });

    const errored = new ClaudeTranscriptTurnReader();
    const apiError = line({
      type: "assistant",
      uuid: "e1",
      isApiErrorMessage: true,
      message: {
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: "API Error: 529" }],
      },
    });
    expect(errored.feed(user("u1", "go") + apiError)).toEqual([
      { kind: "accepted" },
      { kind: "text", text: "API Error: 529", stopReason: "stop_sequence" },
      { kind: "end", reason: "api-error" },
    ]);
  });

  it("reports a queued prompt before it is accepted", () => {
    const reader = new ClaudeTranscriptTurnReader();
    expect(reader.feed(line({ type: "queue-operation", operation: "enqueue" }))).toEqual([
      { kind: "queued" },
    ]);
  });
});

describe("prompt + screen helpers", () => {
  it("types single-line prompts and bracket-pastes multi-line ones", () => {
    expect(encodeClaudePrompt("  hello  ")).toEqual(["hello", "\r"]);
    expect(encodeClaudePrompt("a\r\nb")).toEqual(["\x1b[200~a\nb\x1b[201~", "\r"]);
    expect(encodeClaudePrompt("   ")).toEqual([]);
  });

  it("classifies Claude's startup screen", () => {
    expect(classifyClaudeStartupScreen("⏵⏵ bypass permissions on (shift+tab to cycle)")).toEqual({
      ready: true,
    });
    expect(classifyClaudeStartupScreen("Do you trust the files in this folder?").blocker).toMatch(
      /trust/,
    );
    expect(classifyClaudeStartupScreen("Welcome to Claude Code")).toEqual({ ready: false });
  });

  it("builds tmux-safe terminal ids and strips ANSI", () => {
    const id = claudeBridgeTerminalId("agent:main:telegram:dm:42", 1_700_000_000_000);
    expect(id).toMatch(/^chatclaude_[0-9a-f]{10}_[0-9a-z]+$/);
    expect(stripAnsi("\x1b[1;32mok\x1b[0m\x1b]0;title\x07")).toBe("ok");
  });
});

describe("sendToClaudeBridge", () => {
  let projectsDir: string;
  const sessionId = "11111111-2222-3333-4444-555555555555";

  beforeEach(() => {
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-bridge-"));
    fs.mkdirSync(path.join(projectsDir, "-repo"));
  });
  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  /** A terminal whose "Claude" appends a transcript turn once Enter is pressed. */
  function fakeManager(turn: string[]) {
    const writes: string[] = [];
    const transcript = path.join(projectsDir, "-repo", `${sessionId}.jsonl`);
    const manager = {
      getTerminal: () => ({ id: "t1" }),
      write: (_id: string, data: string) => {
        writes.push(data);
        if (data !== "\r") return;
        let delay = 0;
        for (const chunk of turn) {
          delay += 20;
          setTimeout(() => fs.appendFileSync(transcript, chunk), delay);
        }
      },
    };
    return { manager, writes, transcript };
  }

  const state = {
    enabled: true,
    terminalId: "t1",
    claudeSessionId: sessionId,
    cwd: "/repo",
    startedAt: 0,
  };

  it("submits the prompt, streams narration as progress, returns the closing reply", async () => {
    const { manager, writes, transcript } = fakeManager([
      user("u1", "fix it"),
      assistant("a1", "Checking.", "tool_use"),
      user("r1", [{ type: "tool_result", content: "" }]),
      assistant("a2", "Done — fixed.", "end_turn"),
      turnEnd("end"),
    ]);
    // A previous turn already on disk must not leak into this one.
    fs.writeFileSync(
      transcript,
      user("u0", "earlier") + assistant("a0", "old", "end_turn") + turnEnd("e0"),
    );

    const progress: string[] = [];
    const result = await sendToClaudeBridge({
      manager: manager as never,
      state,
      text: "fix it",
      onProgress: (text) => {
        progress.push(text);
      },
      pollMs: 10,
      projectsDir,
    });

    expect(writes).toEqual(["fix it", "\r"]);
    expect(progress).toEqual(["Checking."]);
    expect(result).toEqual({ status: "done", text: "Done — fixed." });
  });

  it("finds a transcript created after the prompt (first message of a session)", async () => {
    const { manager } = fakeManager([
      user("u1", "hi"),
      assistant("a1", "Hello!", "end_turn"),
      turnEnd("e"),
    ]);
    const result = await sendToClaudeBridge({
      manager: manager as never,
      state,
      text: "hi",
      pollMs: 10,
      projectsDir,
    });
    expect(result).toEqual({ status: "done", text: "Hello!" });
  });

  it("falls back to end_turn + quiet file when no turn_duration marker arrives", async () => {
    const { manager } = fakeManager([user("u1", "hi"), assistant("a1", "Hey.", "end_turn")]);
    const result = await sendToClaudeBridge({
      manager: manager as never,
      state,
      text: "hi",
      pollMs: 10,
      idleEndMs: 100,
      projectsDir,
    });
    expect(result).toEqual({ status: "done", text: "Hey." });
  });

  it("reports the screen when Claude never picks the prompt up", async () => {
    const { manager } = fakeManager([]);
    const result = await sendToClaudeBridge({
      manager: manager as never,
      state,
      text: "hi",
      pollMs: 10,
      acceptTimeoutMs: 80,
      projectsDir,
    });
    expect(result.status).toBe("not-accepted");
    expect(result.screen).toBe("> hello\n  ⏵⏵ bypass permissions on");
  });
});
