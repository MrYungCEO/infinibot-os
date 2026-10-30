import { describe, expect, it } from "vitest";

import { rewriteUpdateFlagArgv, shouldExitAfterCommand } from "./run-main.js";

describe("rewriteUpdateFlagArgv", () => {
  it("leaves argv unchanged when --update is absent", () => {
    const argv = ["node", "entry.js", "status"];
    expect(rewriteUpdateFlagArgv(argv)).toBe(argv);
  });

  it("rewrites --update into the update command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update"])).toEqual([
      "node",
      "entry.js",
      "update",
    ]);
  });

  it("preserves global flags that appear before --update", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--profile", "p", "--update"])).toEqual([
      "node",
      "entry.js",
      "--profile",
      "p",
      "update",
    ]);
  });

  it("keeps update options after the rewritten command", () => {
    expect(rewriteUpdateFlagArgv(["node", "entry.js", "--update", "--json"])).toEqual([
      "node",
      "entry.js",
      "update",
      "--json",
    ]);
  });
});

describe("shouldExitAfterCommand", () => {
  it("exits after one-shot commands so leftover timers can't hang them", () => {
    expect(shouldExitAfterCommand(["node", "entry.js", "onboard", "--non-interactive"])).toBe(true);
    expect(shouldExitAfterCommand(["node", "entry.js", "robovoice", "call", "main"])).toBe(true);
    expect(shouldExitAfterCommand(["node", "entry.js", "doctor"])).toBe(true);
    expect(shouldExitAfterCommand(["node", "entry.js", "status"])).toBe(true);
    expect(
      shouldExitAfterCommand(["node", "entry.js", "gateway", "call", "license.state", "--json"]),
    ).toBe(true);
  });

  it("never exits long-running commands", () => {
    expect(shouldExitAfterCommand(["node", "entry.js", "gateway", "--port", "1"])).toBe(false);
    expect(shouldExitAfterCommand(["node", "entry.js", "gateway", "run"])).toBe(false);
    expect(shouldExitAfterCommand(["node", "entry.js", "tui"])).toBe(false);
    expect(shouldExitAfterCommand(["node", "entry.js", "logs", "--follow"])).toBe(false);
    expect(shouldExitAfterCommand(["node", "entry.js"])).toBe(false);
  });
});
