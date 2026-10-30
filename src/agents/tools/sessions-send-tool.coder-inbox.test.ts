/**
 * Regression (2026-09-28): sessions_send to a claude_coder child key started an
 * unrelated gateway-LLM turn and reported "ok" — the running CLI never saw the
 * message. Coder child keys must route to the run inbox, never the `agent` RPC.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({ session: { scope: "per-sender", mainKey: "main" } }) as never,
  };
});
const routeMock = vi.fn();
vi.mock("../subagent-inbox/service.js", () => ({
  routeSessionsSendToCoder: (p: unknown) => routeMock(p),
}));

import { createSessionsSendTool } from "./sessions-send-tool.js";

const CHILD = "agent:main:subagent:4f6c1e0a";

describe("sessions_send → in-flight coder sub-agent", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    routeMock.mockReset();
  });

  it("delivers into the coder run inbox and reports the inbox status, not ok", async () => {
    routeMock.mockResolvedValue({
      ok: true,
      status: "queued",
      messageId: "im_0123456789",
      runId: "run-1",
      childSessionKey: CHILD,
      backend: "claude-code",
      deliveryMode: "claude-hook",
      expectedDelivery: "mid-turn",
    });
    const tool = createSessionsSendTool({ agentSessionKey: "agent:main:mcp-x" });
    const result = await tool.execute("c1", { sessionKey: CHILD, message: "also add tests" });

    expect(routeMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: CHILD, message: "also add tests" }),
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "queued",
      messageId: "im_0123456789",
      runId: "run-1",
      delivery: { mode: "coder-inbox", via: "claude-hook" },
    });
    expect((result.details as { status: string }).status).not.toBe("ok");
  });

  it("surfaces not_running honestly", async () => {
    routeMock.mockResolvedValue({ ok: false, status: "not_running", error: "ended" });
    const tool = createSessionsSendTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("c2", { sessionKey: CHILD, message: "hi" });
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ status: "not_running", error: "ended" });
  });

  it("non-coder sessions keep the normal agent path", async () => {
    routeMock.mockResolvedValue(null);
    callGatewayMock.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") return { runId: "r" };
      return {};
    });
    const tool = createSessionsSendTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("c3", {
      sessionKey: "agent:main:subagent:embedded",
      message: "hi",
      timeoutSeconds: 0,
    });
    expect(
      callGatewayMock.mock.calls.some(([o]) => (o as { method: string }).method === "agent"),
    ).toBe(true);
    expect(result.details).toMatchObject({ status: "accepted" });
  });
});
