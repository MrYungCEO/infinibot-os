import { describe, expect, it } from "vitest";
import { TerminalLineBuffer, isAtTail, isLive, nextFollow, shouldAutoScroll, splitIncompleteEscape, stripAnsi } from "./voice-terminal-stream-model";

describe("stripAnsi", () => {
  it("removes colours, cursor moves, OSC titles and control bytes", () => {
    expect(stripAnsi("\x1b[1;32mok\x1b[0m done")).toBe("ok done");
    expect(stripAnsi("\x1b]0;my title\x07hello")).toBe("hello");
    expect(stripAnsi("\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(stripAnsi("a\x07b\x08c")).toBe("abc");
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[?25lscreen")).toBe("screen");
    expect(stripAnsi("\x1b(Bplain\x1b=")).toBe("plain");
  });

  it("turns cursor-forward into spaces (how TUIs paint gaps)", () => {
    expect(stripAnsi("a\x1b[3Cb")).toBe("a   b");
    expect(stripAnsi("a\x1b[Cb")).toBe("a b");
  });

  it("keeps newlines, carriage returns and tabs", () => {
    expect(stripAnsi("a\tb\r\nc")).toBe("a\tb\r\nc");
  });
});

describe("splitIncompleteEscape", () => {
  it("carries a sequence cut at the chunk boundary", () => {
    expect(splitIncompleteEscape("text\x1b[3")).toEqual(["text", "\x1b[3"]);
    expect(splitIncompleteEscape("text\x1b")).toEqual(["text", "\x1b"]);
    expect(splitIncompleteEscape("text\x1b]0;tit")).toEqual(["text", "\x1b]0;tit"]);
  });
  it("leaves complete sequences alone", () => {
    expect(splitIncompleteEscape("a\x1b[0mb")).toEqual(["a\x1b[0mb", ""]);
    expect(splitIncompleteEscape("plain")).toEqual(["plain", ""]);
  });
});

describe("TerminalLineBuffer", () => {
  it("splits chunks into ANSI-free lines, joining partial lines across chunks", () => {
    const b = new TerminalLineBuffer();
    b.push("hel");
    b.push("lo\x1b[31m wor");
    b.push("ld\x1b[0m\r\nsecond");
    expect(b.lines).toEqual(["hello world", "second"]);
    expect(b.lastLine()).toBe("second");
  });

  it("completes an escape sequence split across chunks", () => {
    const b = new TerminalLineBuffer();
    b.push("red\x1b[3");
    b.push("1mtext\x1b[0m\n");
    expect(b.lines).toEqual(["redtext"]);
  });

  it("a carriage return redraws the line in place (spinners, progress)", () => {
    const b = new TerminalLineBuffer();
    b.push("Working 1/3\r");
    b.push("Working 2/3\rWorking 3/3\nnext\n");
    expect(b.lines).toEqual(["Working 3/3", "next"]);
  });

  it("is bounded: keeps the newest maxLines and counts the dropped ones", () => {
    const b = new TerminalLineBuffer(5);
    b.push(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(b.lines).toEqual(["line 7", "line 8", "line 9", "line 10", "line 11"]);
    expect(b.dropped).toBe(7);
  });

  it("default bound is ~2k lines", () => {
    const b = new TerminalLineBuffer();
    b.push("x\n".repeat(5000));
    expect(b.lines.length).toBe(2000);
  });

  it("lastLine skips trailing blank lines; reset replaces everything", () => {
    const b = new TerminalLineBuffer();
    b.push("build ok\n\n   \n");
    expect(b.lastLine()).toBe("build ok");
    const v = b.version;
    b.reset("\x1b[1mfresh\x1b[0m\nsnapshot");
    expect(b.lines).toEqual(["fresh", "snapshot"]);
    expect(b.dropped).toBe(0);
    expect(b.version).toBeGreaterThan(v);
  });
});

describe("autoscroll decision", () => {
  const m = (scrollTop: number, scrollHeight = 1000, clientHeight = 200) => ({ scrollTop, scrollHeight, clientHeight });

  it("at the tail (within the threshold) follows", () => {
    expect(isAtTail(m(800))).toBe(true);
    expect(isAtTail(m(780))).toBe(true);
    expect(isAtTail(m(700))).toBe(false);
  });

  it("scrolling up pauses following; returning to the tail resumes it", () => {
    let s = { follow: true, lastTop: 800 };
    s = nextFollow(s, m(500));
    expect(s.follow).toBe(false);
    s = nextFollow(s, m(600)); // scrolling down but not at the tail yet: still paused
    expect(s.follow).toBe(false);
    s = nextFollow(s, m(800));
    expect(s.follow).toBe(true);
  });

  it("content growing under a following view does not pause it", () => {
    // New output grew scrollHeight; the view hasn't moved up — still following.
    const s = nextFollow({ follow: true, lastTop: 800 }, m(800, 1400));
    expect(s.follow).toBe(true);
  });

  it("only auto-scrolls when following and expanded", () => {
    expect(shouldAutoScroll(true, true)).toBe(true);
    expect(shouldAutoScroll(false, true)).toBe(false);
    expect(shouldAutoScroll(true, false)).toBe(false);
  });

  it("live while output arrived recently", () => {
    expect(isLive(null, 10_000)).toBe(false);
    expect(isLive(9_000, 10_000)).toBe(true);
    expect(isLive(1_000, 10_000)).toBe(false);
  });
});
