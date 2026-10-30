import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetApprovalRegistry,
  getApprovalRequest,
  listApprovalRequests,
  resolveApprovalRequest,
} from "../../autonomy/approval-registry.js";
import { toolCallTimeoutMs } from "../../mcp/infinibot-adapter.js";
import { createRequestApprovalTool, createWaitApprovalTool } from "./approval-tools.js";

type Details = Record<string, unknown>;
const run = async (p: unknown) => ((await p) as { details: Details }).details;

beforeEach(() => _resetApprovalRegistry());
afterEach(() => {
  vi.useRealTimers();
  _resetApprovalRegistry();
});

describe("request_approval", () => {
  it("BLOCKS until the operator decides, then returns decision + note", async () => {
    const tool = createRequestApprovalTool({ agentSessionKey: "agent:main:mcp-claude-code-123" });
    const pending = tool.execute("c1", {
      title: "fly deploy infinibot-gateway",
      summary: "billable",
      details: "fly deploy",
      risk: "high",
      waitSec: 30,
    });
    await new Promise((r) => setTimeout(r, 5));
    const [rec] = listApprovalRequests();
    expect(rec).toMatchObject({
      source: "orchestrator",
      risk: "high",
      requester: { label: "MCP orchestrator", agentId: "main" },
    });
    resolveApprovalRequest(rec.id, {
      action: "approve",
      note: "after 6pm only",
      by: "@boss",
      via: "telegram",
    });
    expect(await run(pending)).toMatchObject({
      status: "approved",
      decision: "approve",
      note: "after 6pm only",
      approvalId: rec.id,
      decidedVia: "telegram",
    });
  });

  it("returns pending + id when waitSec elapses, then wait_approval picks up the decision", async () => {
    const tool = createRequestApprovalTool({});
    const first = await run(tool.execute("c1", { title: "restart gateway", waitSec: 0.01 }));
    expect(first).toMatchObject({ status: "pending" });
    const id = first.approvalId as string;
    expect(getApprovalRequest(id)!.status).toBe("pending");

    const waitTool = createWaitApprovalTool();
    const again = await run(waitTool.execute("c2", { approvalId: id, waitSec: 0.01 }));
    expect(again.status).toBe("pending");

    const waiting = waitTool.execute("c3", { approvalId: id, waitSec: 30 });
    resolveApprovalRequest(id, { action: "deny", note: "not today", via: "ui" });
    expect(await run(waiting)).toMatchObject({
      status: "denied",
      decision: "deny",
      note: "not today",
    });
  });

  it("expiry → timed_out (treated as deny)", async () => {
    vi.useFakeTimers();
    const tool = createRequestApprovalTool({});
    const p = tool.execute("c1", { title: "delete prod table", timeoutSec: 10, waitSec: 600 });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await run(p)).toMatchObject({ status: "timed_out", decision: "deny" });
  });

  it("allowRedirect adds the redirect option", async () => {
    const tool = createRequestApprovalTool({});
    const res = await run(tool.execute("c1", { title: "x", waitSec: 0, allowRedirect: true }));
    expect(getApprovalRequest(res.approvalId as string)!.options).toContain("redirect");
  });

  it("wait_approval on an unknown id is an error, not a hang", async () => {
    const res = await run(createWaitApprovalTool().execute("c1", { approvalId: "nope" }));
    expect(res).toMatchObject({ status: "error" });
  });

  it("MCP call timeout is sized from waitSec so blocking never trips the 60s default", () => {
    expect(toolCallTimeoutMs("request_approval", {})).toBe(330_000);
    expect(toolCallTimeoutMs("request_approval", { waitSec: 900 })).toBe(630_000);
    expect(toolCallTimeoutMs("wait_approval", { waitSec: 60 })).toBe(90_000);
  });
});
