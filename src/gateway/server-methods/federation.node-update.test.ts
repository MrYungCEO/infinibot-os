import { describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({
  getNode: vi.fn(),
  broadcastFleetUpdate: vi.fn(),
}));
vi.mock("../../federation/hub.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFederationHub: () => hub,
}));

import { federationHandlers } from "./federation.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

async function call(params: Record<string, unknown>) {
  let out: unknown;
  await federationHandlers["federation.node.update"]!({
    params,
    respond: (_ok: boolean, p?: unknown) => {
      out = p;
    },
  } as unknown as GatewayRequestHandlerOptions);
  return out as Record<string, unknown>;
}

describe("federation.node.update for a satellite", () => {
  it("really sends system.update to that one node (was a placeholder)", async () => {
    hub.getNode.mockReturnValue({
      id: "lap",
      state: "registered",
      manifest: { name: "CEO laptop" },
    });
    hub.broadcastFleetUpdate.mockResolvedValue({ sent: ["CEO laptop"], skipped: [], failed: [] });
    const res = await call({ nodeId: "lap", branch: "deploy/flypic-fixes-live" });
    expect(hub.broadcastFleetUpdate).toHaveBeenCalledWith({
      nodeIds: ["lap"],
      skipBuild: false,
      branch: "deploy/flypic-fixes-live",
    });
    expect(res).toMatchObject({ success: true, nodeId: "lap", branch: "deploy/flypic-fixes-live" });
  });

  it("reports failure when nothing was sent", async () => {
    hub.getNode.mockReturnValue({
      id: "lap",
      state: "registered",
      manifest: { name: "CEO laptop" },
    });
    hub.broadcastFleetUpdate.mockResolvedValue({ sent: [], skipped: [], failed: ["CEO laptop"] });
    const res = await call({ nodeId: "lap" });
    expect(res).toMatchObject({ success: false, branch: "main" });
  });

  it("refuses an offline node without sending", async () => {
    hub.broadcastFleetUpdate.mockClear();
    hub.getNode.mockReturnValue(undefined);
    const res = await call({ nodeId: "gone" });
    expect(res).toMatchObject({ success: false, error: "Node gone not connected" });
    expect(hub.broadcastFleetUpdate).not.toHaveBeenCalled();
  });
});
