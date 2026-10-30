import { describe, expect, it } from "vitest";

import { parseGroupCommand, parseModeArg, suggestGroupCommands } from "./commands.js";
import {
  applySettingsPatch,
  effectiveSettings,
  normalizeSettingsPatch,
  pruneMemberSettings,
} from "./settings.js";

const members = [
  { id: "main", name: "Infini" },
  { id: "coder", name: "Head of Dev" },
];

describe("group run settings", () => {
  it("normalizes patches: aliases, default → clear, rejects junk", () => {
    expect(normalizeSettingsPatch({ model: " openai/gpt-5 ", thinking: "max" })).toEqual({
      model: "openai/gpt-5",
      thinkingLevel: "high",
    });
    expect(normalizeSettingsPatch({ model: "default", thinkingLevel: null })).toEqual({
      model: null,
      thinkingLevel: null,
    });
    expect(() => normalizeSettingsPatch({ thinkingLevel: "ultra" })).toThrow(/thinkingLevel/);
    expect(() => normalizeSettingsPatch({ model: "has space/x y" })).toThrow(/invalid model/);
    expect(() => normalizeSettingsPatch([])).toThrow();
  });

  it("member override > group > agent default, field by field", () => {
    const meta = {
      settings: { model: "a/one", thinkingLevel: "low" },
      memberSettings: { coder: { model: "b/two" } },
    };
    expect(effectiveSettings(meta, "coder")).toEqual({
      model: "b/two",
      thinkingLevel: "low",
      source: { model: "member", thinkingLevel: "group" },
    });
    expect(effectiveSettings({}, "main")).toEqual({
      source: { model: "agent", thinkingLevel: "agent" },
    });
  });

  it("patch application and pruning", () => {
    expect(applySettingsPatch({ model: "a/b" }, { model: null })).toBeUndefined();
    expect(applySettingsPatch(undefined, { thinkingLevel: "high" })).toEqual({
      thinkingLevel: "high",
    });
    expect(
      pruneMemberSettings({ gone: { model: "x/y" }, main: { model: "x/y" } }, ["main"]),
    ).toEqual({
      main: { model: "x/y" },
    });
  });
});

describe("group slash commands", () => {
  it("parses commands, aliases and an @member target", () => {
    expect(parseGroupCommand("/model openai/gpt-5", members)).toEqual({
      name: "model",
      arg: "openai/gpt-5",
    });
    expect(parseGroupCommand("/think @head-of-dev high", members)).toEqual({
      name: "think",
      arg: "high",
      agentId: "coder",
    });
    expect(parseGroupCommand("/effort medium", members)?.name).toBe("think");
    expect(parseGroupCommand("/abort", members)?.name).toBe("stop");
    expect(parseGroupCommand("/home/me/x.txt", members)).toBeNull();
    expect(parseGroupCommand("hello /model x", members)).toBeNull();
    expect(parseModeArg("round robin")).toBe("round-robin");
    expect(parseModeArg("rr")).toBe("round-robin");
    expect(parseModeArg("nope")).toBeNull();
    expect(suggestGroupCommands("/th").map((c) => c.name)).toEqual(["think"]);
  });
});
