import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectStartupPrompt, screenReplyText } from "./voice-cli-output.js";
import { openCliTranscript, transcriptLineEvents } from "./voice-cli-transcript.js";

const iso = (ms: number) => new Date(ms).toISOString();

describe("transcriptLineEvents", () => {
  it("claude: assistant text, tool use, end_turn, turn_duration, interruption", () => {
    expect(
      transcriptLineEvents({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "Looking at it." },
            { type: "tool_use", name: "Bash" },
          ],
        },
      }),
    ).toEqual([
      { kind: "text", text: "Looking at it." },
      { kind: "tool", name: "Bash" },
    ]);
    expect(
      transcriptLineEvents({
        type: "assistant",
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "PINEAPPLE" }] },
      }),
    ).toEqual([{ kind: "text", text: "PINEAPPLE" }, { kind: "end" }]);
    expect(transcriptLineEvents({ type: "system", subtype: "turn_duration" })).toEqual([
      { kind: "end" },
    ]);
    expect(
      transcriptLineEvents({
        type: "user",
        message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
      }),
    ).toEqual([{ kind: "end" }]);
    expect(transcriptLineEvents({ type: "user", message: { content: "hi" } })).toEqual([]);
    expect(transcriptLineEvents({ type: "attachment" })).toEqual([]);
  });

  it("codex: assistant message, tool calls, task_complete", () => {
    expect(
      transcriptLineEvents({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ).toEqual([{ kind: "text", text: "Done." }]);
    expect(
      transcriptLineEvents({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ text: "x" }] },
      }),
    ).toEqual([]);
    expect(
      transcriptLineEvents({
        type: "response_item",
        payload: { type: "function_call", name: "shell" },
      }),
    ).toEqual([{ kind: "tool", name: "shell" }]);
    expect(
      transcriptLineEvents({
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "All set." },
      }),
    ).toEqual([{ kind: "end", text: "All set." }]);
  });
});

describe("openCliTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cli-transcript-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  it("claude by --session-id: only what is written after the turn started", () => {
    const proj = path.join(dir, "-repo");
    fs.mkdirSync(proj);
    const file = path.join(proj, "sid-1.jsonl");
    const now = Date.now();
    fs.writeFileSync(
      file,
      line({
        type: "assistant",
        timestamp: iso(now - 60_000),
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "old answer" }] },
      }),
    );
    const t = openCliTranscript(
      { cliType: "claude", sessionId: "sid-1", claudeProjectsDir: dir },
      now,
    );
    expect(t?.file()).toBe(file);
    expect(t!.poll()).toEqual([]);
    fs.appendFileSync(
      file,
      line({ type: "user", timestamp: iso(now + 10), message: { content: "q" } }),
    );
    // A partial line is not read until it is complete.
    fs.appendFileSync(file, '{"type":"assistant","timest');
    expect(t!.poll()).toEqual([]);
    fs.appendFileSync(
      file,
      `amp":"${iso(now + 900)}","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"PINEAPPLE"}]}}\n`,
    );
    expect(t!.poll()).toEqual([{ kind: "text", text: "PINEAPPLE" }, { kind: "end" }]);
  });

  it("claude: a transcript created after the turn started is found and read from its start", () => {
    const now = Date.now();
    const t = openCliTranscript(
      { cliType: "claude", sessionId: "sid-2", claudeProjectsDir: dir },
      now,
    );
    expect(t!.file()).toBeNull();
    expect(t!.poll()).toEqual([]);
    const proj = path.join(dir, "-repo2");
    fs.mkdirSync(proj);
    fs.writeFileSync(
      path.join(proj, "sid-2.jsonl"),
      line({
        type: "assistant",
        timestamp: iso(now + 500),
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "51" }] },
      }),
    );
    expect(t!.poll()).toEqual([{ kind: "text", text: "51" }, { kind: "end" }]);
  });

  it("codex: matched by cwd; a repeated final message is spoken once", () => {
    const day = path.join(dir, "2026", "10", "11");
    fs.mkdirSync(day, { recursive: true });
    const file = path.join(day, "rollout-x.jsonl");
    const now = Date.now();
    fs.writeFileSync(file, line({ type: "session_meta", payload: { cwd: "/repo" } }));
    const t = openCliTranscript({ cliType: "codex", cwd: "/repo", codexSessionsDir: dir }, now);
    expect(t!.file()).toBe(file);
    fs.appendFileSync(
      file,
      line({
        type: "response_item",
        timestamp: iso(now + 100),
        payload: { type: "message", role: "assistant", content: [{ text: "Fixed it." }] },
      }) +
        line({
          type: "event_msg",
          timestamp: iso(now + 101),
          payload: { type: "agent_message", message: "Fixed it." },
        }) +
        line({
          type: "event_msg",
          timestamp: iso(now + 102),
          payload: { type: "task_complete", last_agent_message: "Fixed it." },
        }),
    );
    expect(t!.poll()).toEqual([
      { kind: "text", text: "Fixed it." },
      { kind: "end", text: "Fixed it." },
    ]);
  });

  it("CLIs without a readable transcript get none", () => {
    expect(openCliTranscript({ cliType: "gemini", cwd: "/repo" })).toBeNull();
    expect(openCliTranscript({ cliType: "shell" })).toBeNull();
  });
});

describe("startup prompts and the rendered screen", () => {
  it("Claude's trust-folder question: arrow down from 'No, exit' to 'Yes', then Enter", () => {
    // As captured from Claude Code 2.1 in a tmux pane (Voice page repro, 2026-10-11).
    const screen = [
      "────────────────────────",
      " Accessing workspace:",
      " /tmp/vcf-side/proj2",
      " Quick safety check: Is this a project you created or one you trust? (Like your",
      " Claude Code'll be able to read, edit, and execute files here.",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      " Enter to confirm · Esc to cancel",
    ].join("\n");
    const p = detectStartupPrompt(screen);
    expect(p?.kind).toBe("trust");
    expect(p?.keys).toBe("\x1b[B\r");
  });

  it("numbered bypass-permissions confirmation; Yes already highlighted = just Enter", () => {
    const screen = [
      "WARNING: Claude Code running in Bypass Permissions mode",
      "❯ 1. No, exit",
      "  2. Yes, I accept",
    ].join("\n");
    expect(detectStartupPrompt(screen)).toMatchObject({ kind: "bypass", keys: "\x1b[B\r" });
    expect(
      detectStartupPrompt(
        ["Do you trust the files in this folder?", "❯ 1. Yes, proceed", "  2. No, exit"].join("\n"),
      )?.keys,
    ).toBe("\r");
  });

  it("Codex: shared-daemon question → run without it; update → Skip (never the installer)", () => {
    const daemon = [
      "Background server has incompatible feature settings",
      "Restart may interrupt active or queued work.",
      "  1. Run without daemon this time",
      "  2. Restart with these settings",
      "› 3. Cancel",
    ].join("\n");
    expect(detectStartupPrompt(daemon)).toMatchObject({ kind: "daemon", keys: "\x1b[A\x1b[A\r" });
    const update = [
      "Update available · 0.160.0 → 0.160.1",
      "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh |",
      "     CODEX_NON_INTERACTIVE=1 sh'`)",
      "  2. Skip",
      "  3. Skip until next version",
      "  enter continue · esc skip",
    ].join("\n");
    expect(detectStartupPrompt(update)).toMatchObject({ kind: "update", keys: "\x1b[B\r" });
  });

  it("a ready CLI or a permission menu is not a startup prompt", () => {
    expect(
      detectStartupPrompt('❯ Try "edit <filepath> to..."\n⏵⏵ bypass permissions on'),
    ).toBeNull();
    expect(detectStartupPrompt("Do you want to run npm test?\n❯ 1. Yes\n  2. No")).toBeNull();
  });

  it("reads the reply after the echoed utterance, without spinner / footer chrome", () => {
    const screen = [
      " ▐▛███▛█   Claude Code v2.1.296",
      "❯ Reply with just the word PINEAPPLE and nothing else.",
      "● PINEAPPLE",
      "✻ Cooked for 1s · done 4:01 PM",
      "❯ What is 17 times 3? Answer in one short sentence.",
      "● 17 times 3 is 51.",
      "✻ Crunched for 1s · done 4:01 PM",
      "────────────────────────",
      "❯ ",
      "────────────────────────",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent",
    ].join("\n");
    expect(
      screenReplyText(screen, "What is 17 times 3? Answer in one short sentence.", "claude"),
    ).toBe("17 times 3 is 51.");
  });
});
