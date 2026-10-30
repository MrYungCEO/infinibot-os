import { describe, expect, it } from "vitest";

import { isMcpOrchestratorSession } from "../agents/subagent-announce.js";
import { toolCallTimeoutMs } from "./infinibot-adapter.js";
import { formatCompletionPush } from "./server.js";

describe("MCP completion delivery", () => {
  it("recognises MCP orchestrator sessions (announce would fail with unknown channel: mcp)", () => {
    expect(isMcpOrchestratorSession("agent:main:mcp-host-123-abc")).toBe(true);
    expect(isMcpOrchestratorSession("agent:main:main", "mcp")).toBe(true);
    expect(isMcpOrchestratorSession("agent:main:main")).toBe(false);
    expect(isMcpOrchestratorSession("agent:main:subagent:1")).toBe(false);
  });

  it("formats pushes that never present unverified work as done", () => {
    const ok = formatCompletionPush({
      runId: "r1",
      label: "fix",
      state: "verified",
      verdict: "VERIFIED",
      summary: "fixed",
    });
    expect(ok.content).toMatch(/VERIFIED/);
    expect(ok.content).toMatch(/may relay it as done/);
    expect(ok.meta).toEqual({ run_id: "r1", state: "verified", verdict: "VERIFIED" });
    const bad = formatCompletionPush({
      runId: "r2",
      label: "ui",
      state: "unverified",
      verdict: "UNVERIFIED",
      summary: "done!",
      reasons: ["visual files changed but no valid screenshots"],
    });
    expect(bad.content).toMatch(/Do not relay its claims as facts/);
    expect(bad.content).toMatch(/no valid screenshots/);
  });

  it("gives blocking tools a gateway timeout longer than their own wait", () => {
    expect(toolCallTimeoutMs("subagents_wait", { timeoutSec: 300 })).toBe(330_000);
    expect(toolCallTimeoutMs("subagents_wait", {})).toBe(80_000);
    expect(toolCallTimeoutMs("subagents_wait", { timeoutSec: 9999 })).toBe(630_000);
    expect(toolCallTimeoutMs("visual_verify", {})).toBe(660_000);
    expect(toolCallTimeoutMs("notes", {})).toBeUndefined();
  });
});
