import { describe, expect, it } from "vitest";
import { requestAgentDrawer, rosterAgentIdOf, takeAgentDrawerIntent } from "./agents-drawer-intent";

describe("rosterAgentIdOf", () => {
  it("uses a plain agentId", () => {
    expect(rosterAgentIdOf({ agentId: "cmo", sessionKey: "agent:main:subagent:x" })).toBe("cmo");
  });
  it("falls back to the agent:<id>: session key", () => {
    expect(rosterAgentIdOf({ agentId: null, sessionKey: "agent:main:subagent:1234" })).toBe("main");
    expect(rosterAgentIdOf({ agentId: "agent:coder:main", sessionKey: "agent:coder:main" })).toBe("coder");
  });
  it("ignores run-id-looking agentIds", () => {
    expect(rosterAgentIdOf({ agentId: "0f8e2c1a-7b2d-4c7e-9a51-3d2f1e0b9c88", sessionKey: null })).toBeNull();
  });
  it("returns null without anything usable", () => {
    expect(rosterAgentIdOf(null)).toBeNull();
    expect(rosterAgentIdOf({ agentId: "", sessionKey: "webchat:abc" })).toBeNull();
  });
});

describe("requestAgentDrawer", () => {
  it("leaves a one-shot pending intent", () => {
    requestAgentDrawer("main", "voice");
    expect(takeAgentDrawerIntent()).toEqual({ agentId: "main", tab: "voice" });
    expect(takeAgentDrawerIntent()).toBeNull();
  });
});
