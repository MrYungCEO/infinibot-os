import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".infinibot"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", INFINIBOT_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".infinibot-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", INFINIBOT_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".infinibot"));
  });

  it("uses INFINIBOT_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", INFINIBOT_STATE_DIR: "/var/lib/infinibot" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/infinibot"));
  });

  it("expands ~ in INFINIBOT_STATE_DIR", () => {
    const env = { HOME: "/Users/test", INFINIBOT_STATE_DIR: "~/infinibot-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/infinibot-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { INFINIBOT_STATE_DIR: "C:\\State\\infinibot" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\infinibot");
  });
});
