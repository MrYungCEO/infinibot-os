/**
 * Cross-backend parity tests for the coder stream parsers.
 *
 * The acceptance bar (see task brief): "Spawning with backend opencode and
 * backend claude-code produces matching event streams (modulo backend badge +
 * content)." These tests assert that, given an EQUIVALENT task expressed in
 * each backend's native JSON event stream, the shared normalizer produces the
 * same sequence of high-level events: a captured resume session id, one
 * normalized Read tool-use (name "Read", arg file_path), its paired tool-end,
 * an assistant text turn, and a terminal/done signal.
 *
 * Where the OpenCode CLI itself isn't available in CI we feed canned stdout
 * matching the real `--format json` stream — exactly the integration boundary
 * the brief calls out.
 *
 * COORDINATION: opencode-parity
 */

import { describe, expect, it } from "vitest";
import {
  formatClaudeStreamEvent,
  formatOpenCodeStreamEvent,
  formatCodexStreamEvent,
  getStreamParser,
  type StreamEventFormatted,
  type StreamParser,
} from "./stream-parsers.js";

// ── Canned streams: the SAME logical task in each backend's native schema ────
// Task: session boots → reads /repo/src/foo.ts → says "Done reading." → finish.

const CLAUDE_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-1" }),
  JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/repo/src/foo.ts" } },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "export const foo = 1;" }],
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Done reading." }] },
  }),
  JSON.stringify({ type: "result", subtype: "success", result: "All good" }),
];

const OPENCODE_STREAM = [
  JSON.stringify({ type: "step_start", sessionID: "oc-sess-1" }),
  JSON.stringify({
    type: "tool_use",
    sessionID: "oc-sess-1",
    part: {
      tool: "read", // lowercase — must normalize to "Read"
      callID: "call-1",
      title: "Read foo.ts",
      state: {
        status: "completed",
        input: { filePath: "/repo/src/foo.ts" }, // filePath — must normalize to file_path
        output: "export const foo = 1;",
      },
    },
  }),
  JSON.stringify({ type: "text", sessionID: "oc-sess-1", part: { text: "Done reading." } }),
  JSON.stringify({ type: "step_finish", sessionID: "oc-sess-1" }),
];

const CODEX_STREAM = [
  JSON.stringify({ type: "session", id: "codex-sess-1" }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Done reading." }],
  }),
  JSON.stringify({ type: "result", output: "All good" }),
];

// ── Normalizer: run a parser over a stream, collapse to a comparable summary ──

interface NormalizedRun {
  /** First resume session id surfaced (claude --resume / opencode --session). */
  sessionId: string | undefined;
  /** Normalized tool-use starts: backend-independent name + touched file. */
  toolStarts: Array<{ name: string; file: string | undefined }>;
  /** Tool-end call ids that paired with a start. */
  toolEndIds: string[];
  /** Assistant text turns, in order. */
  assistantTexts: string[];
  /** True once a terminal/finish activity is seen. */
  done: boolean;
}

function runParser(parser: StreamParser, lines: string[]): NormalizedRun {
  const out: NormalizedRun = {
    sessionId: undefined,
    toolStarts: [],
    toolEndIds: [],
    assistantTexts: [],
    done: false,
  };
  for (const line of lines) {
    const ev: StreamEventFormatted | null = parser(line);
    if (!ev) continue;
    if (ev.claudeSessionId && !out.sessionId) out.sessionId = ev.claudeSessionId;
    for (const t of ev.toolStarts ?? []) {
      const args = (t.arguments ?? {}) as Record<string, unknown>;
      out.toolStarts.push({
        name: t.name,
        file: typeof args.file_path === "string" ? args.file_path : undefined,
      });
    }
    for (const t of ev.toolEnds ?? []) out.toolEndIds.push(t.toolCallId);
    if (ev.activity?.kind === "assistant" && ev.summary) out.assistantTexts.push(ev.summary);
    if (ev.activity?.kind === "done") out.done = true;
  }
  return out;
}

// ── Parity: claude-code vs opencode produce the same normalized run ──────────

describe("stream-parser parity: opencode matches claude-code", () => {
  const claude = runParser(formatClaudeStreamEvent, CLAUDE_STREAM);
  const opencode = runParser(formatOpenCodeStreamEvent, OPENCODE_STREAM);

  it("both surface a resume session id (item 5: stop/respawn parity)", () => {
    expect(claude.sessionId).toBe("claude-sess-1");
    expect(opencode.sessionId).toBe("oc-sess-1");
    // The point is parity of CAPTURE, not the value: both are non-empty.
    expect(claude.sessionId).toBeTruthy();
    expect(opencode.sessionId).toBeTruthy();
  });

  it("both normalize the read into one tool_use with name 'Read' + file_path (item 3)", () => {
    expect(claude.toolStarts).toEqual([{ name: "Read", file: "/repo/src/foo.ts" }]);
    expect(opencode.toolStarts).toEqual([{ name: "Read", file: "/repo/src/foo.ts" }]);
    expect(opencode.toolStarts).toEqual(claude.toolStarts);
  });

  it("both pair a tool-end against the same call id", () => {
    expect(claude.toolEndIds).toEqual(["call-1"]);
    expect(opencode.toolEndIds).toEqual(["call-1"]);
  });

  it("both emit the assistant text turn", () => {
    expect(claude.assistantTexts).toContain("Done reading.");
    expect(opencode.assistantTexts).toContain("Done reading.");
  });

  it("the comparable shape (tools + texts) is identical across backends", () => {
    expect({ toolStarts: opencode.toolStarts, texts: opencode.assistantTexts }).toEqual({
      toolStarts: claude.toolStarts,
      texts: claude.assistantTexts,
    });
  });
});

// ── Codex parity for the events it supports (session + text) ─────────────────

describe("stream-parser parity: codex shares the session + text contract", () => {
  const codex = runParser(formatCodexStreamEvent, CODEX_STREAM);

  it("captures a resume session id like the other backends", () => {
    expect(codex.sessionId).toBe("codex-sess-1");
  });

  it("emits the assistant text turn", () => {
    expect(codex.assistantTexts).toContain("Done reading.");
  });

  it("reaches a done signal", () => {
    expect(codex.done).toBe(true);
  });
});

// ── Regression: the OpenCode resume-sessionId fix ────────────────────────────

describe("formatOpenCodeStreamEvent surfaces the resume session id (parity fix)", () => {
  it("captures sessionID from the very first step_start, before any tool runs", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({ type: "step_start", sessionID: "oc-early" }),
    );
    expect(ev?.claudeSessionId).toBe("oc-early");
  });

  it("captures sessionID on tool_use, text, and error events too", () => {
    const onTool = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "oc-1",
        part: { tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "" } },
      }),
    );
    const onText = formatOpenCodeStreamEvent(
      JSON.stringify({ type: "text", sessionID: "oc-1", part: { text: "hi" } }),
    );
    const onErr = formatOpenCodeStreamEvent(
      JSON.stringify({ type: "error", sessionID: "oc-1", error: { name: "Boom" } }),
    );
    expect(onTool?.claudeSessionId).toBe("oc-1");
    expect(onText?.claudeSessionId).toBe("oc-1");
    expect(onErr?.claudeSessionId).toBe("oc-1");
  });

  it("also accepts snake_case session_id", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({ type: "text", session_id: "snake-1", part: { text: "hi" } }),
    );
    expect(ev?.claudeSessionId).toBe("snake-1");
  });
});

// ── OpenCode tool-name + arg normalization (the cross-backend glue) ───────────

describe("formatOpenCodeStreamEvent normalizes tool names + arg keys to Claude shape", () => {
  it("maps lowercase tool names and filePath → file_path", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: {
          tool: "edit",
          callID: "c9",
          state: { status: "completed", input: { filePath: "/a/b.ts" }, output: "ok" },
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.name).toBe("Edit");
    const args = ev?.toolStarts?.[0]?.arguments as Record<string, unknown>;
    expect(args.file_path).toBe("/a/b.ts");
    expect(ev?.toolEnds?.[0]?.toolCallId).toBe("c9");
  });

  it("flags a failed tool state as a tool error end", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: {
          tool: "bash",
          callID: "c10",
          state: { status: "error", input: {}, output: "boom" },
        },
      }),
    );
    expect(ev?.toolEnds?.[0]?.error).toBeTruthy();
    expect(ev?.activity?.kind).toBe("tool_error");
  });
});

// ── Codex NEW schema: thread/turn/item lifecycle (codex-cli ≥ 0.4x) ──────────
// Fixtures are real lines captured from `codex exec --json` on codex-cli 0.137.0.

describe("formatCodexStreamEvent handles the new thread/item lifecycle", () => {
  it("thread.started surfaces the resume id (thread_id)", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({ type: "thread.started", thread_id: "thr-1" }),
    );
    expect(ev?.claudeSessionId).toBe("thr-1");
    expect(ev?.transcript).toContain("session started");
  });

  it("command_execution item.started → Bash toolStart, no toolEnd", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "/bin/bash -lc 'ls package.json'",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      }),
    );
    expect(ev?.toolStarts?.[0]).toMatchObject({ toolCallId: "item_0", name: "Bash" });
    expect((ev?.toolStarts?.[0]?.arguments as Record<string, unknown>).command).toContain(
      "ls package.json",
    );
    expect(ev?.toolEnds).toBeUndefined();
  });

  it("command_execution item.completed → toolEnd paired on item id, no toolStart", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "/bin/bash -lc 'ls package.json'",
          aggregated_output: "package.json\n",
          exit_code: 0,
          status: "completed",
        },
      }),
    );
    expect(ev?.toolStarts).toBeUndefined();
    expect(ev?.toolEnds?.[0]?.toolCallId).toBe("item_0");
    expect(ev?.toolEnds?.[0]?.result).toContain("package.json");
    expect(ev?.toolEnds?.[0]?.error).toBeUndefined();
  });

  it("command_execution with non-zero exit → tool error end", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_2",
          type: "command_execution",
          command: "/bin/bash -lc 'false'",
          aggregated_output: "boom",
          exit_code: 1,
          status: "completed",
        },
      }),
    );
    expect(ev?.toolEnds?.[0]?.error).toBeTruthy();
    expect(ev?.activity?.kind).toBe("tool_error");
  });

  it("file_change (all add) → Write toolStart with file_path", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "file_change",
          changes: [{ path: "/tmp/codextest/hello.txt", kind: "add" }],
          status: "in_progress",
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.name).toBe("Write");
    expect((ev?.toolStarts?.[0]?.arguments as Record<string, unknown>).file_path).toBe(
      "/tmp/codextest/hello.txt",
    );
  });

  it("file_change (modify) → Edit", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.started",
        item: {
          id: "item_3",
          type: "file_change",
          changes: [{ path: "/a/b.ts", kind: "modify" }],
          status: "in_progress",
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.name).toBe("Edit");
  });

  it("agent_message item.completed → assistant transcript, NO tool events", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_9", type: "agent_message", text: "Found package.json in the repo root." },
      }),
    );
    expect(ev?.toolStarts).toBeUndefined();
    expect(ev?.toolEnds).toBeUndefined();
    expect(ev?.activity?.kind).toBe("assistant");
    expect(ev?.transcript).toContain("Found package.json");
  });

  it("reasoning item → transcript + reasoning activity, NO tool events", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_r", type: "reasoning", text: "Let me think about the filename." },
      }),
    );
    expect(ev?.toolStarts).toBeUndefined();
    expect(ev?.toolEnds).toBeUndefined();
    expect(ev?.activity?.kind).toBe("reasoning");
    expect(ev?.transcript).toContain("💭");
  });

  it("turn.completed → done signal", () => {
    const ev = formatCodexStreamEvent(
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 67 } }),
    );
    expect(ev?.activity?.kind).toBe("done");
  });

  it("a full new-schema run normalizes start-before-end with a paired id", () => {
    const stream = [
      JSON.stringify({ type: "thread.started", thread_id: "thr-2" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.started",
        item: { id: "item_0", type: "command_execution", command: "ls", status: "in_progress" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "ls",
          aggregated_output: "package.json\n",
          exit_code: 0,
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Done." },
      }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ];
    const run = runParser(formatCodexStreamEvent, stream);
    expect(run.sessionId).toBe("thr-2");
    expect(run.toolStarts).toEqual([{ name: "Bash", file: undefined }]);
    expect(run.toolEndIds).toEqual(["item_0"]);
    expect(run.assistantTexts).toContain("Done.");
    expect(run.done).toBe(true);
  });
});

// ── OpenCode lifecycle split by state.status ─────────────────────────────────

describe("formatOpenCodeStreamEvent splits the tool lifecycle by state.status", () => {
  it("status 'running' → toolStarts only (no end)", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: {
          tool: "bash",
          callID: "c1",
          state: { status: "running", input: { command: "ls" } },
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.toolCallId).toBe("c1");
    expect(ev?.toolEnds).toBeUndefined();
  });

  it("status 'pending' → toolStarts only (no end)", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: { tool: "read", callID: "c2", state: { status: "pending", input: {} } },
      }),
    );
    expect(ev?.toolStarts?.[0]?.toolCallId).toBe("c2");
    expect(ev?.toolEnds).toBeUndefined();
  });

  it("status 'completed' → paired start+end with REAL duration from state.time", () => {
    // Real captured shape from opencode 1.16.2 `run --format json`: a single
    // already-completed tool_use event carrying state.time.{start,end}.
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_1",
        part: {
          tool: "bash",
          callID: "call_00_x",
          title: "List package.json file",
          state: {
            status: "completed",
            input: { command: "ls package.json" },
            output: "package.json\n",
            time: { start: 1781280920281, end: 1781280920785 },
          },
        },
      }),
    );
    // start carries the name + args so the bubble renders even with no prior
    // "running" event (this version never emits one).
    expect(ev?.toolStarts?.[0]).toMatchObject({ toolCallId: "call_00_x", name: "Bash" });
    expect(ev?.toolEnds?.[0]?.toolCallId).toBe("call_00_x");
    // duration must be the real 504ms, NOT the bug-old 0.
    expect(ev?.toolEnds?.[0]?.durationMs).toBe(504);
  });

  it("status 'failed' → tool error end (+ paired start)", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: {
          tool: "bash",
          callID: "c3",
          state: { status: "failed", input: {}, output: "boom" },
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.toolCallId).toBe("c3");
    expect(ev?.toolEnds?.[0]?.error).toBeTruthy();
    expect(ev?.activity?.kind).toBe("tool_error");
  });

  it("legacy empty status WITH input+output → both at once (regression guard)", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: {
          tool: "read",
          callID: "c4",
          state: { status: "", input: { filePath: "/a/b.ts" }, output: "contents" },
        },
      }),
    );
    expect(ev?.toolStarts?.[0]?.toolCallId).toBe("c4");
    expect(ev?.toolEnds?.[0]?.toolCallId).toBe("c4");
  });

  it("legacy empty status WITHOUT output → skipped (no fake bubble)", () => {
    const ev = formatOpenCodeStreamEvent(
      JSON.stringify({
        type: "tool_use",
        sessionID: "s",
        part: { tool: "read", callID: "c5", state: { status: "", input: {}, output: "" } },
      }),
    );
    expect(ev?.toolStarts).toBeUndefined();
    expect(ev?.toolEnds).toBeUndefined();
  });
});

// ── Dispatcher routes to the right parser ────────────────────────────────────

describe("getStreamParser dispatches by backend id", () => {
  it("opencode → formatOpenCodeStreamEvent", () => {
    expect(getStreamParser("opencode")).toBe(formatOpenCodeStreamEvent);
  });
  it("codex → formatCodexStreamEvent", () => {
    expect(getStreamParser("codex")).toBe(formatCodexStreamEvent);
  });
  it("claude-code → formatClaudeStreamEvent", () => {
    expect(getStreamParser("claude-code")).toBe(formatClaudeStreamEvent);
  });
});
