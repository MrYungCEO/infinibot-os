import { describe, expect, it } from "vitest";

import { parseClaudeCommand, resolveClaudeKey } from "./commands-claude.js";

describe("parseClaudeCommand", () => {
  it("toggles on a bare /claude and ignores other commands", () => {
    expect(parseClaudeCommand("/claude")).toEqual({ action: "toggle" });
    expect(parseClaudeCommand("/CLAUDE")).toEqual({ action: "toggle" });
    expect(parseClaudeCommand("/claudex")).toBeNull();
    expect(parseClaudeCommand("hello /claude")).toBeNull();
  });

  it("parses subcommands", () => {
    expect(parseClaudeCommand("/claude on")).toEqual({ action: "on", cwd: undefined });
    expect(parseClaudeCommand("/claude on ~/Projects/My Repo")).toEqual({
      action: "on",
      cwd: "~/Projects/My Repo",
    });
    expect(parseClaudeCommand("/claude off")).toEqual({ action: "off" });
    expect(parseClaudeCommand("/claude status")).toEqual({ action: "status" });
    expect(parseClaudeCommand("/claude new")).toEqual({ action: "new" });
    expect(parseClaudeCommand("/claude esc")).toEqual({ action: "esc" });
    expect(parseClaudeCommand("/claude screen")).toEqual({ action: "screen" });
    expect(parseClaudeCommand("/claude key enter")).toEqual({ action: "key", key: "enter" });
  });

  it("treats anything else as a one-shot message, keeping every line of the raw body", () => {
    expect(parseClaudeCommand("/claude /compact")).toEqual({ action: "send", text: "/compact" });
    expect(parseClaudeCommand("/claude refactor this", "/claude refactor this\nline two")).toEqual({
      action: "send",
      text: "refactor this\nline two",
    });
    // "key" with no key name is a message, not a keypress.
    expect(parseClaudeCommand("/claude key")).toEqual({ action: "send", text: "key" });
  });
});

describe("resolveClaudeKey", () => {
  it("maps names to terminal bytes", () => {
    expect(resolveClaudeKey("Enter")).toBe("\r");
    expect(resolveClaudeKey("esc")).toBe("\x1b");
    expect(resolveClaudeKey("shift-tab")).toBe("\x1b[Z");
    expect(resolveClaudeKey("2")).toBe("2");
    expect(resolveClaudeKey("f13")).toBeUndefined();
  });
});
