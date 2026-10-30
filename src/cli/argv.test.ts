import { describe, expect, it } from "vitest";

import {
  buildParseArgv,
  getFlagValue,
  getCommandPath,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasHelpOrVersion,
  hasFlag,
  shouldMigrateState,
  shouldMigrateStateFromPath,
} from "./argv.js";

describe("argv helpers", () => {
  it("detects help/version flags", () => {
    expect(hasHelpOrVersion(["node", "infinibot", "--help"])).toBe(true);
    expect(hasHelpOrVersion(["node", "infinibot", "-V"])).toBe(true);
    expect(hasHelpOrVersion(["node", "infinibot", "status"])).toBe(false);
  });

  it("extracts command path ignoring flags and terminator", () => {
    expect(getCommandPath(["node", "infinibot", "status", "--json"], 2)).toEqual(["status"]);
    expect(getCommandPath(["node", "infinibot", "agents", "list"], 2)).toEqual(["agents", "list"]);
    expect(getCommandPath(["node", "infinibot", "status", "--", "ignored"], 2)).toEqual(["status"]);
  });

  it("returns primary command", () => {
    expect(getPrimaryCommand(["node", "infinibot", "agents", "list"])).toBe("agents");
    expect(getPrimaryCommand(["node", "infinibot"])).toBeNull();
  });

  it("parses boolean flags and ignores terminator", () => {
    expect(hasFlag(["node", "infinibot", "status", "--json"], "--json")).toBe(true);
    expect(hasFlag(["node", "infinibot", "--", "--json"], "--json")).toBe(false);
  });

  it("extracts flag values with equals and missing values", () => {
    expect(getFlagValue(["node", "infinibot", "status", "--timeout", "5000"], "--timeout")).toBe(
      "5000",
    );
    expect(getFlagValue(["node", "infinibot", "status", "--timeout=2500"], "--timeout")).toBe("2500");
    expect(getFlagValue(["node", "infinibot", "status", "--timeout"], "--timeout")).toBeNull();
    expect(getFlagValue(["node", "infinibot", "status", "--timeout", "--json"], "--timeout")).toBe(
      null,
    );
    expect(getFlagValue(["node", "infinibot", "--", "--timeout=99"], "--timeout")).toBeUndefined();
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "infinibot", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "infinibot", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "infinibot", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it("parses positive integer flag values", () => {
    expect(getPositiveIntFlagValue(["node", "infinibot", "status"], "--timeout")).toBeUndefined();
    expect(
      getPositiveIntFlagValue(["node", "infinibot", "status", "--timeout"], "--timeout"),
    ).toBeNull();
    expect(
      getPositiveIntFlagValue(["node", "infinibot", "status", "--timeout", "5000"], "--timeout"),
    ).toBe(5000);
    expect(
      getPositiveIntFlagValue(["node", "infinibot", "status", "--timeout", "nope"], "--timeout"),
    ).toBeUndefined();
  });

  it("builds parse argv from raw args", () => {
    const nodeArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node", "infinibot", "status"],
    });
    expect(nodeArgv).toEqual(["node", "infinibot", "status"]);

    const versionedNodeArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node-22", "infinibot", "status"],
    });
    expect(versionedNodeArgv).toEqual(["node-22", "infinibot", "status"]);

    const versionedNodeWindowsArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node-22.2.0.exe", "infinibot", "status"],
    });
    expect(versionedNodeWindowsArgv).toEqual(["node-22.2.0.exe", "infinibot", "status"]);

    const versionedNodePatchlessArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node-22.2", "infinibot", "status"],
    });
    expect(versionedNodePatchlessArgv).toEqual(["node-22.2", "infinibot", "status"]);

    const versionedNodeWindowsPatchlessArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node-22.2.exe", "infinibot", "status"],
    });
    expect(versionedNodeWindowsPatchlessArgv).toEqual(["node-22.2.exe", "infinibot", "status"]);

    const versionedNodeWithPathArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["/usr/bin/node-22.2.0", "infinibot", "status"],
    });
    expect(versionedNodeWithPathArgv).toEqual(["/usr/bin/node-22.2.0", "infinibot", "status"]);

    const nodejsArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["nodejs", "infinibot", "status"],
    });
    expect(nodejsArgv).toEqual(["nodejs", "infinibot", "status"]);

    const nonVersionedNodeArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["node-dev", "infinibot", "status"],
    });
    expect(nonVersionedNodeArgv).toEqual(["node", "infinibot", "node-dev", "infinibot", "status"]);

    const directArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["infinibot", "status"],
    });
    expect(directArgv).toEqual(["node", "infinibot", "status"]);

    const bunArgv = buildParseArgv({
      programName: "infinibot",
      rawArgs: ["bun", "src/entry.ts", "status"],
    });
    expect(bunArgv).toEqual(["bun", "src/entry.ts", "status"]);
  });

  it("builds parse argv from fallback args", () => {
    const fallbackArgv = buildParseArgv({
      programName: "infinibot",
      fallbackArgv: ["status"],
    });
    expect(fallbackArgv).toEqual(["node", "infinibot", "status"]);
  });

  it("decides when to migrate state", () => {
    expect(shouldMigrateState(["node", "infinibot", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "infinibot", "health"])).toBe(false);
    expect(shouldMigrateState(["node", "infinibot", "sessions"])).toBe(false);
    expect(shouldMigrateState(["node", "infinibot", "memory", "status"])).toBe(false);
    expect(shouldMigrateState(["node", "infinibot", "agent", "--message", "hi"])).toBe(false);
    expect(shouldMigrateState(["node", "infinibot", "agents", "list"])).toBe(true);
    expect(shouldMigrateState(["node", "infinibot", "message", "send"])).toBe(true);
  });

  it("reuses command path for migrate state decisions", () => {
    expect(shouldMigrateStateFromPath(["status"])).toBe(false);
    expect(shouldMigrateStateFromPath(["agents", "list"])).toBe(true);
  });
});
