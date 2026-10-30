import { describe, expect, it } from "vitest";

import { stripPluginOnlyAllowlist, type PluginToolGroups } from "./tool-policy.js";

const pluginGroups: PluginToolGroups = {
  all: ["lobster", "workflow_tool"],
  byPlugin: new Map([["lobster", ["lobster", "workflow_tool"]]]),
};
const coreTools = new Set(["read", "write", "exec", "session_status"]);

describe("stripPluginOnlyAllowlist", () => {
  it("strips allowlist when it only targets plugin tools", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("strips allowlist when it only targets plugin groups", () => {
    const policy = stripPluginOnlyAllowlist({ allow: ["group:plugins"] }, pluginGroups, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("keeps allowlist when it mixes plugin and core entries", () => {
    const policy = stripPluginOnlyAllowlist(
      { allow: ["lobster", "read"] },
      pluginGroups,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["lobster", "read"]);
    expect(policy.unknownAllowlist).toEqual([]);
  });

  it("strips allowlist with unknown entries when no core tools match", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = stripPluginOnlyAllowlist({ allow: ["lobster"] }, emptyPlugins, coreTools);
    expect(policy.policy?.allow).toBeUndefined();
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it("keeps allowlist with core tools and reports unknown entries", () => {
    const emptyPlugins: PluginToolGroups = { all: [], byPlugin: new Map() };
    const policy = stripPluginOnlyAllowlist(
      { allow: ["read", "lobster"] },
      emptyPlugins,
      coreTools,
    );
    expect(policy.policy?.allow).toEqual(["read", "lobster"]);
    expect(policy.unknownAllowlist).toEqual(["lobster"]);
  });

  it('an alias whose tools come from a plugin (bare "memory") is not reported as unknown', () => {
    const withMemory: PluginToolGroups = {
      all: ["memory_search", "memory_get"],
      byPlugin: new Map([["memory-core", ["memory_search", "memory_get"]]]),
    };
    const policy = stripPluginOnlyAllowlist({ allow: ["read", "memory"] }, withMemory, coreTools);
    expect(policy.unknownAllowlist).toEqual([]);
    expect(policy.policy?.allow).toEqual(["read", "memory"]);
    // Without the memory plugin loaded it is still flagged (nothing provides it).
    const none = stripPluginOnlyAllowlist(
      { allow: ["read", "memory"] },
      { all: [], byPlugin: new Map() },
      coreTools,
    );
    expect(none.unknownAllowlist).toEqual(["memory"]);
  });
});
