import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  extractOpenCodeAssistantTextParts,
  findCodexTranscriptForTerminal,
  findOpenCodeSessionForTerminal,
  findTranscriptBySessionId,
  startTerminalOpenCodeAssistantStream,
  startTerminalAssistantStream,
  startTerminalPtyAssistantStream,
  stopAllForTest,
  type AssistantTextDelta,
} from "./terminal-assistant-stream.js";

function buildLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

async function waitFor<T>(check: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const v = check();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("findTranscriptBySessionId", () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-asst-stream-"));
    projectsDir = path.join(tmpDir, "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    stopAllForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("locates the exact transcript file by session-id across project subdirs", () => {
    const subA = path.join(projectsDir, "C--Users-foo");
    const subB = path.join(projectsDir, "C--Users-bar");
    fs.mkdirSync(subA, { recursive: true });
    fs.mkdirSync(subB, { recursive: true });
    fs.writeFileSync(path.join(subA, "decoy.jsonl"), "");
    const target = path.join(subB, "abcd1234-5678-90ab-cdef-1234567890ab.jsonl");
    fs.writeFileSync(target, "");

    const found = findTranscriptBySessionId({
      sessionId: "abcd1234-5678-90ab-cdef-1234567890ab",
      projectsDir,
    });
    expect(found).toBe(target);
  });

  test("returns null when the file doesn't exist yet (caller will retry)", () => {
    const found = findTranscriptBySessionId({
      sessionId: "00000000-0000-0000-0000-000000000000",
      projectsDir,
    });
    expect(found).toBeNull();
  });

  test("disambiguates parallel sessions in the same cwd correctly", () => {
    // Two Claude Code sessions in the same project subdir — by-session-id
    // returns the matching file with no mtime ambiguity.
    const sub = path.join(projectsDir, "C--Users-shared-cwd");
    fs.mkdirSync(sub, { recursive: true });
    const a = path.join(sub, "11111111-1111-1111-1111-111111111111.jsonl");
    const b = path.join(sub, "22222222-2222-2222-2222-222222222222.jsonl");
    fs.writeFileSync(a, "");
    fs.writeFileSync(b, "");
    // Touch b later so the mtime-based heuristic would pick b. By session-id
    // we must still get a when we ask for a's id.
    const later = Date.now() + 5000;
    fs.utimesSync(b, new Date(later), new Date(later));

    expect(
      findTranscriptBySessionId({
        sessionId: "11111111-1111-1111-1111-111111111111",
        projectsDir,
      }),
    ).toBe(a);
    expect(
      findTranscriptBySessionId({
        sessionId: "22222222-2222-2222-2222-222222222222",
        projectsDir,
      }),
    ).toBe(b);
  });
});

describe("findCodexTranscriptForTerminal", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-codex-stream-"));
    sessionsDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    stopAllForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("locates the newest Codex session JSONL by cwd", () => {
    const day = path.join(sessionsDir, "2026", "05", "30");
    fs.mkdirSync(day, { recursive: true });
    const oldFile = path.join(day, "rollout-old.jsonl");
    const target = path.join(day, "rollout-new.jsonl");
    fs.writeFileSync(
      oldFile,
      buildLine({
        type: "session_meta",
        payload: { cwd: "/tmp/other", id: "old" },
      }),
    );
    fs.writeFileSync(
      target,
      buildLine({
        type: "session_meta",
        payload: { blob: "x".repeat(16_000), cwd: "/repo", id: "new" },
      }),
    );
    const now = Date.now();
    fs.utimesSync(oldFile, new Date(now - 10_000), new Date(now - 10_000));
    fs.utimesSync(target, new Date(now), new Date(now));

    expect(
      findCodexTranscriptForTerminal({
        cwd: "/repo",
        createdAtMs: now - 1_000,
        sessionsDir,
      }),
    ).toBe(target);
  });
});

describe("OpenCode assistant export", () => {
  afterEach(() => {
    stopAllForTest();
  });

  test("locates the newest OpenCode session by cwd", () => {
    const now = Date.now();
    const found = findOpenCodeSessionForTerminal({
      cwd: "/repo",
      createdAtMs: now - 1_000,
      runCommand: () =>
        JSON.stringify([
          {
            id: "other",
            directory: "/tmp/other",
            updated: now + 1_000,
            created: now + 1_000,
          },
          {
            id: "old",
            directory: "/repo",
            updated: now - 20_000,
            created: now - 20_000,
          },
          {
            id: "target",
            directory: "/repo",
            updated: now,
            created: now,
          },
        ]),
    });

    expect(found).toBe("target");
  });

  test("extracts only completed assistant text parts from OpenCode export", () => {
    const now = Date.now();
    const emittedPartIds = new Set<string>();
    const exportData = {
      messages: [
        {
          info: { id: "user-msg", role: "user", time: { created: now, completed: now } },
          parts: [{ id: "user-text", type: "text", text: "User input should stay silent." }],
        },
        {
          info: { id: "assistant-open", role: "assistant", time: { created: now } },
          parts: [{ id: "partial-text", type: "text", text: "Partial should wait." }],
        },
        {
          info: { id: "assistant-done", role: "assistant", time: { created: now, completed: now } },
          parts: [
            { id: "step-start", type: "step-start" },
            { id: "reasoning", type: "reasoning", text: "Thinking should stay silent." },
            { id: "answer", type: "text", text: "Only the OpenCode response is spoken." },
            { id: "tool", type: "tool", text: "Tool output should stay silent." },
            { id: "step-finish", type: "step-finish" },
          ],
        },
      ],
    };

    const first = extractOpenCodeAssistantTextParts({
      exportData,
      emittedPartIds,
      attachedAtMs: now,
      lookbackMs: 30_000,
    });
    const second = extractOpenCodeAssistantTextParts({
      exportData,
      emittedPartIds,
      attachedAtMs: now,
      lookbackMs: 30_000,
    });

    expect(first.map((p) => p.text)).toEqual(["Only the OpenCode response is spoken."]);
    expect(first.map((p) => p.id)).toEqual(["answer"]);
    expect(second).toEqual([]);
  });

  test("streams OpenCode export text without TUI/tool noise", async () => {
    const now = Date.now();
    let completed = false;
    const captured: AssistantTextDelta[] = [];

    startTerminalOpenCodeAssistantStream({
      terminalId: "term-opencode-export",
      sessionId: "ses_123",
      pollIntervalMs: 25,
      exportSession: () =>
        `Exporting session: ses_123\n${JSON.stringify({
          messages: [
            {
              info: {
                id: "assistant-1",
                role: "assistant",
                time: { created: now, ...(completed ? { completed: now + 50 } : {}) },
              },
              parts: [
                { id: "reasoning-1", type: "reasoning", text: "Do not read this." },
                { id: "text-1", type: "text", text: "This is the final OpenCode answer." },
              ],
            },
          ],
        })}`,
      emit: (d) => captured.push(d),
    });

    await new Promise((r) => setTimeout(r, 60));
    expect(captured).toEqual([]);

    completed = true;
    const got = await waitFor(() => (captured.length >= 1 ? captured : undefined));
    expect(got.map((d) => d.text)).toEqual(["This is the final OpenCode answer."]);
    await new Promise((r) => setTimeout(r, 80));
    expect(captured.map((d) => d.text)).toEqual(["This is the final OpenCode answer."]);
  });
});

describe("startTerminalAssistantStream", () => {
  let tmpDir: string;
  let projectsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infinibot-asst-stream-"));
    projectsDir = path.join(tmpDir, "projects");
    fs.mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    stopAllForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("emits one delta per assistant text block, drops thinking/tool blocks", async () => {
    const sub = path.join(projectsDir, "C--proj");
    fs.mkdirSync(sub, { recursive: true });
    const transcriptPath = path.join(sub, "deadbeef-cafe-babe-1234-567890abcdef.jsonl");
    fs.writeFileSync(transcriptPath, "");

    const captured: AssistantTextDelta[] = [];
    startTerminalAssistantStream({
      terminalId: "term-A",
      transcriptPath,
      emit: (d) => captured.push(d),
    });

    // Append the lines as separate writes so each one triggers a fresh
    // chokidar `change` event — single-file watches on Windows can coalesce
    // back-to-back writes inside one OS call into a single notification with
    // a partial-read race.
    fs.appendFileSync(
      transcriptPath,
      // Should be skipped — type !== "assistant"
      buildLine({ type: "user", message: { role: "user", content: "hi" }, uuid: "u-1" }),
    );
    await new Promise((r) => setTimeout(r, 120));
    // Drops the thinking + tool_use blocks, keeps the text
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "a-1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "Hello there." },
            { type: "tool_use", name: "Bash" },
          ],
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
    // Plain text-only assistant turn
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "a-2",
        message: { role: "assistant", content: [{ type: "text", text: "How can I help?" }] },
      }),
    );

    const got = await waitFor(() => (captured.length >= 2 ? captured : undefined));
    expect(got.map((d) => d.text)).toEqual(["Hello there.", "How can I help?"]);
    expect(got.map((d) => d.terminalId)).toEqual(["term-A", "term-A"]);
    expect(got[0].uuid).toBe("a-1");
    expect(got[1].uuid).toBe("a-2");
    expect(got[0].chunkIndex).toBe(1);
    expect(got[1].chunkIndex).toBe(2);
  });

  test("emits historical content within lookback window after attach", async () => {
    // Claude Code wrote its reply BEFORE the stream attached. Without the
    // lookback window the streamer would skip it (offset == file size at
    // attach), and the user would never hear that reply. With lookback the
    // recent assistant line plays.
    const sub = path.join(projectsDir, "C--proj-late");
    fs.mkdirSync(sub, { recursive: true });
    const transcriptPath = path.join(sub, "33333333-3333-3333-3333-333333333333.jsonl");
    const recentTs = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "recent-1",
        timestamp: recentTs,
        message: { role: "assistant", content: [{ type: "text", text: "Recent reply." }] },
      }),
    );

    const captured: AssistantTextDelta[] = [];
    startTerminalAssistantStream({
      terminalId: "term-late",
      transcriptPath,
      emit: (d) => captured.push(d),
    });

    // Trigger a flush by writing a fresh line — chokidar's `change` event
    // fires for that, the streamer reads from offset 0, and both lines hit
    // the lookback gate (recent enough → both emitted).
    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "live-1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Live follow-up." }] },
      }),
    );

    const got = await waitFor(() => (captured.length >= 2 ? captured : undefined));
    expect(got.map((d) => d.uuid)).toContain("recent-1");
    expect(got.map((d) => d.uuid)).toContain("live-1");
  });

  test("does not emit ancient history outside lookback window", async () => {
    const sub = path.join(projectsDir, "C--proj-old");
    fs.mkdirSync(sub, { recursive: true });
    const transcriptPath = path.join(sub, "44444444-4444-4444-4444-444444444444.jsonl");
    // 5 minutes ago — far outside the 30s default window.
    const ancient = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    fs.writeFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "ancient-1",
        timestamp: ancient,
        message: { role: "assistant", content: [{ type: "text", text: "Old reply." }] },
      }),
    );

    const captured: AssistantTextDelta[] = [];
    startTerminalAssistantStream({
      terminalId: "term-old",
      transcriptPath,
      emit: (d) => captured.push(d),
    });

    await new Promise((r) => setTimeout(r, 100));
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "fresh-1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "Fresh reply." }] },
      }),
    );

    const got = await waitFor(() => (captured.length >= 1 ? captured : undefined));
    expect(got.map((d) => d.uuid)).toEqual(["fresh-1"]);
    expect(got.map((d) => d.uuid)).not.toContain("ancient-1");
  });

  test("suppresses echoed user input from the PTY stream", async () => {
    const captured: AssistantTextDelta[] = [];
    const inputCallbacks: Array<(data: string) => void> = [];
    const outputCallbacks: Array<(data: string) => void> = [];

    startTerminalPtyAssistantStream({
      terminalId: "term-echo",
      cliType: "codex",
      subscribePtyInput: (_id, cb) => {
        inputCallbacks.push(cb);
        return () => undefined;
      },
      subscribePtyOutput: (_id, cb) => {
        outputCallbacks.push(cb);
        return () => undefined;
      },
      emit: (d) => captured.push(d),
    });

    inputCallbacks[0]?.("Hello from the user\n");
    outputCallbacks[0]?.("Hello from the user\n");
    outputCallbacks[0]?.("The answer is ready.\n");

    const got = await waitFor(() => (captured.length >= 1 ? captured : undefined));
    expect(got.map((d) => d.text)).toEqual(["The answer is ready."]);
  });

  test("emits Codex transcript agent messages without tool output", async () => {
    const sub = path.join(projectsDir, "codex");
    fs.mkdirSync(sub, { recursive: true });
    const transcriptPath = path.join(sub, "rollout.jsonl");
    fs.writeFileSync(transcriptPath, "");

    const captured: AssistantTextDelta[] = [];
    startTerminalAssistantStream({
      terminalId: "term-codex",
      transcriptPath,
      transcriptKind: "codex",
      emit: (d) => captured.push(d),
    });

    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "response_item",
        payload: { type: "function_call_output", output: "tool output should stay silent" },
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "event_msg",
        payload: { type: "agent_message", message: "Only the response is spoken." },
      }),
    );

    const got = await waitFor(() => (captured.length >= 1 ? captured : undefined));
    expect(got.map((d) => d.text)).toEqual(["Only the response is spoken."]);
  });

  test("handles OpenCode carriage-return redraws", () => {
    const captured: AssistantTextDelta[] = [];
    const outputCallbacks: Array<(data: string) => void> = [];

    startTerminalPtyAssistantStream({
      terminalId: "term-opencode",
      cliType: "opencode",
      subscribePtyOutput: (_id, cb) => {
        outputCallbacks.push(cb);
        return () => undefined;
      },
      emit: (d) => captured.push(d),
    });

    outputCallbacks[0]?.("thinking\r");
    outputCallbacks[0]?.("│ The OpenCode reply is ready. │\r");

    expect(captured.map((d) => d.text)).toEqual(["The OpenCode reply is ready."]);
  });

  test("flushes an idle OpenCode row without a trailing delimiter", async () => {
    const captured: AssistantTextDelta[] = [];
    const outputCallbacks: Array<(data: string) => void> = [];

    startTerminalPtyAssistantStream({
      terminalId: "term-opencode-idle",
      cliType: "opencode",
      subscribePtyOutput: (_id, cb) => {
        outputCallbacks.push(cb);
        return () => undefined;
      },
      emit: (d) => captured.push(d),
    });

    outputCallbacks[0]?.("│ The final OpenCode row has no newline. │");

    const got = await waitFor(() => (captured.length >= 1 ? captured : undefined));
    expect(got.map((d) => d.text)).toEqual(["The final OpenCode row has no newline."]);
  });

  test("de-duplicates by uuid across re-fires of the same line", async () => {
    const sub = path.join(projectsDir, "C--proj-dup");
    fs.mkdirSync(sub, { recursive: true });
    const transcriptPath = path.join(sub, "11111111-1111-1111-1111-111111111111.jsonl");
    fs.writeFileSync(transcriptPath, "");

    const captured: AssistantTextDelta[] = [];
    startTerminalAssistantStream({
      terminalId: "term-D",
      transcriptPath,
      emit: (d) => captured.push(d),
    });

    fs.appendFileSync(
      transcriptPath,
      buildLine({
        type: "assistant",
        uuid: "shared-uuid",
        message: { role: "assistant", content: [{ type: "text", text: "Once." }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    // Touch so chokidar fires a change event without new content.
    const now = new Date();
    fs.utimesSync(transcriptPath, now, now);
    await new Promise((r) => setTimeout(r, 250));
    expect(captured.length).toBe(1);
  });
});
