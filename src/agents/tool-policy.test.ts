import { describe, expect, it } from "vitest";
import { expandToolGroups, resolveToolProfilePolicy, TOOL_GROUPS } from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("expands the bare roster entries web and memory to real tools", () => {
    const set = new Set(expandToolGroups(["web", "memory"]));
    expect(set.has("web_search")).toBe(true);
    expect(set.has("web_fetch")).toBe(true);
    expect(set.has("memory_search")).toBe(true);
    expect(set.has("memory_get")).toBe(true);
    expect(set.has("web")).toBe(false);
    expect(set.has("memory")).toBe(false);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("group:fs");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:infinibot", () => {
    const group = TOOL_GROUPS["group:infinibot"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("session_status");
  });
});
