import { describe, expect, it } from "vitest";

import {
  classifyVoiceCommand,
  CliOutputCleaner,
  detectApprovalPrompt,
  interruptKeysFor,
  speakableLine,
  stripAnsi,
  toolActivity,
} from "./voice-cli-output.js";

describe("stripAnsi", () => {
  it("drops CSI / OSC / charset escapes and keeps the words", () => {
    const raw = "\x1b[1;32mDone\x1b[0m \x1b]0;title\x07with \x1b(Bthe build\x1b[K";
    expect(stripAnsi(raw)).toBe("Done with the build");
  });
  it("keeps what a CR redraw wrote last", () => {
    expect(stripAnsi("⠋ working\r⠙ working\rAll tests passed\n")).toBe("All tests passed\n");
  });
  it("cursor-forward keeps words apart", () => {
    expect(stripAnsi("hello\x1b[1Cworld")).toBe("hello world");
  });
});

describe("speakableLine / chrome", () => {
  it("drops TUI chrome", () => {
    for (const l of [
      "╭────────────────╮",
      "│ >              │",
      "? for shortcuts",
      "✻ Pondering… (3s · esc to interrupt)",
      "⎿  Read 42 lines",
      "● Bash(npm test)",
      "src/foo.ts:42:5",
      "+const added = 1;",
      "❯ ",
      "  12 │ const x = 1;",
    ]) {
      expect(speakableLine(l, "claude"), l).toBeNull();
    }
  });
  it("keeps prose inside a box", () => {
    expect(speakableLine("│ The tests all pass now. │")).toBe("The tests all pass now.");
    expect(speakableLine("● I fixed the null check in parser.ts.")).toBe(
      "I fixed the null check in parser.ts.",
    );
  });
  it("names tool activity for milestones", () => {
    expect(toolActivity("● Bash(pnpm test)")).toBe("running a command");
    expect(toolActivity("⏺ Edit(src/a.ts)")).toBe("editing files");
    expect(toolActivity("plain prose")).toBeNull();
  });
});

describe("CliOutputCleaner", () => {
  it("line CLI: reply lines without the typed echo or the prompt", () => {
    const c = new CliOutputCleaner({ cliType: "shell", input: "what is two plus two" });
    c.push("user@host:~$ what is two plus two\r\n");
    c.push("\x1b[32mThe answer is four.\x1b[0m\r\n");
    c.push("$ ");
    expect(c.lines()).toEqual(["The answer is four."]);
  });
  it("keeps a tmux-painted answer that repeats the utterance at the end", () => {
    const c = new CliOutputCleaner({ cliType: "claude", input: "confirm the mock route" });
    c.push(
      "\x1b[2;3Hconfirm the mock route\r\n" +
        "\x1b[32m● Mock CLI answer: voice routing received confirm the mock route." +
        "\x1b[5;1H\x1b[39m❯ ",
    );
    expect(c.lines()).toEqual(["Mock CLI answer: voice routing received confirm the mock route."]);
  });
  it("Claude TUI: prose from ● bullets, tool calls and the input box skipped", () => {
    const c = new CliOutputCleaner({ cliType: "claude", input: "run the tests" });
    c.push("> run the tests\r\n");
    c.push("\x1b[2K● I'll run the test suite.\r\n\r\n");
    c.push("● Bash(pnpm test)\r\n  ⎿  42 passed\r\n\r\n");
    c.push("● All 42 tests pass.\r\n  Nothing else needed fixing.\r\n\r\n");
    c.push("╭──────────╮\r\n│ >        │\r\n╰──────────╯\r\n  ? for shortcuts\r\n");
    expect(c.lines()).toEqual([
      "I'll run the test suite.",
      "All 42 tests pass.",
      "Nothing else needed fixing.",
    ]);
    expect(c.activities()).toEqual(["running a command"]);
  });
  it("deduplicates repainted lines", () => {
    const c = new CliOutputCleaner({ cliType: "codex" });
    c.push("Working on it now.\n");
    c.push("\x1b[HWorking on it now.\nDone.\n");
    expect(c.lines()).toEqual(["Working on it now.", "Done."]);
  });
});

describe("detectApprovalPrompt", () => {
  it("numbered menu (Claude Code)", () => {
    const tail = [
      "● Bash(rm -rf build)",
      "╭─────────────────────────────╮",
      "│ Bash command                │",
      "│   rm -rf build              │",
      "│ Do you want to proceed?     │",
      "│ ❯ 1. Yes                    │",
      "│   2. Yes, and don't ask again│",
      "│   3. No, and tell Claude    │",
      "╰─────────────────────────────╯",
    ].join("\n");
    const p = detectApprovalPrompt(tail, "Claude Code");
    expect(p).not.toBeNull();
    expect(p!.question).toBe("Claude Code asks: Do you want to proceed? Say yes or no.");
    expect(p!.approveKeys).toBe("1");
    expect(p!.denyKeys).toBe("3");
  });
  it("y/n suffix", () => {
    const p = detectApprovalPrompt("Overwrite config.json? [y/N] ", "The terminal");
    expect(p?.question).toBe("The terminal asks: Overwrite config.json? Say yes or no.");
    expect(p?.approveKeys).toBe("y\r");
    expect(p?.denyKeys).toBe("n\r");
  });
  it("no prompt in normal output", () => {
    expect(detectApprovalPrompt("All tests pass.\n1. first point\n2. second point\n")).toBeNull();
  });
});

describe("classifyVoiceCommand", () => {
  it("approve / deny only while a prompt is open", () => {
    expect(classifyVoiceCommand("yes", { promptOpen: true })).toBe("approve");
    expect(classifyVoiceCommand("Yeah go ahead.", { promptOpen: true })).toBe("approve");
    expect(classifyVoiceCommand("approve", { promptOpen: true })).toBe("approve");
    expect(classifyVoiceCommand("No, deny it", { promptOpen: true })).toBe("deny");
    expect(classifyVoiceCommand("yes")).toBeNull();
  });
  it("interrupt and fallback at any time", () => {
    expect(classifyVoiceCommand("Stop!")).toBe("interrupt");
    expect(classifyVoiceCommand("cancel that please")).toBe("interrupt");
    expect(classifyVoiceCommand("switch back to the API")).toBe("fallback");
    expect(classifyVoiceCommand("stop the build when tests fail")).toBeNull();
  });
  it("interrupt keys per CLI", () => {
    expect(interruptKeysFor("claude")).toBe("\x1b");
    expect(interruptKeysFor("codex")).toBe("\x1b");
    expect(interruptKeysFor("shell")).toBe("\x03");
    expect(interruptKeysFor("aider")).toBe("\x03");
  });
});
