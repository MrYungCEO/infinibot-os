/**
 * Tests for the bidirectional forwardGatewayCall path — specifically the
 * satellite side, which is the hub-and-spoke router for sat→master and
 * sat→sat. Master→satellite is covered by hub-forward.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./hub.js", () => ({
  getFederationHub: vi.fn(() => null),
}));
vi.mock("./satellite.js", () => ({
  getFederationSatellite: vi.fn(() => null),
}));

import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";
import { forwardGatewayCall } from "./hub-forward.js";

function mockSatellite(opts: {
  state?: string;
  invoke?: (...args: unknown[]) => Promise<unknown>;
}) {
  return {
    getState: vi.fn(() => opts.state ?? "connected"),
    invokeOnMaster: vi.fn(opts.invoke as never),
  };
}

beforeEach(() => {
  vi.mocked(getFederationHub).mockReturnValue(null);
  vi.mocked(getFederationSatellite).mockReturnValue(null);
});

describe("forwardGatewayCall (satellite path)", () => {
  it("returns NOT_FEDERATED when neither hub nor satellite exists", async () => {
    const res = await forwardGatewayCall("sat-2", "sessions.spawn", { task: "x" });
    expect(res.success).toBe(false);
    expect(res.code).toBe("NOT_FEDERATED");
  });

  it("returns MASTER_UNAVAILABLE when the satellite is not connected", async () => {
    const sat = mockSatellite({ state: "reconnecting" });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );
    const res = await forwardGatewayCall("sat-2", "sessions.spawn", { task: "x" });
    expect(res.success).toBe(false);
    expect(res.code).toBe("MASTER_UNAVAILABLE");
  });

  it("tunnels to master and RE-ATTACHES nodeId so master re-routes (sat→sat)", async () => {
    const sat = mockSatellite({
      invoke: async () => ({ success: true, data: { runId: "r1", childSessionKey: "k1" } }),
    });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const res = await forwardGatewayCall("sat-2", "sessions.spawn", { task: "x" }, 12_000);

    // The satellite forwards the SAME method up to master with nodeId attached
    // so the master's own router dispatches it to the sibling.
    expect(sat.invokeOnMaster).toHaveBeenCalledWith(
      "sessions.spawn",
      { task: "x", nodeId: "sat-2" },
      12_000,
    );
    expect(res.success).toBe(true);
    expect(res.payload).toEqual({ runId: "r1", childSessionKey: "k1" });
  });

  it("tunnels a master-targeted call up too (sat→master), nodeId preserved", async () => {
    const sat = mockSatellite({
      invoke: async () => ({ success: true, data: { ok: true } }),
    });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    await forwardGatewayCall("master", "sessions.send", { message: "hi" });
    expect(sat.invokeOnMaster).toHaveBeenCalledWith(
      "sessions.send",
      { message: "hi", nodeId: "master" },
      30_000,
    );
  });

  it("surfaces the master's error code on a routing failure", async () => {
    const sat = mockSatellite({
      invoke: async () => ({
        success: false,
        error: { code: "INVOKE_FAILED", message: "node not connected" },
      }),
    });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const res = await forwardGatewayCall("sat-2", "sessions.spawn", {});
    expect(res.success).toBe(false);
    expect(res.code).toBe("INVOKE_FAILED");
    expect(res.error).toBe("node not connected");
  });

  it("prefers the hub path when a hub IS present (master direction)", async () => {
    // When this process is the master, forwardGatewayCall must use the hub,
    // never the satellite tunnel.
    const hub = { invokeOnNode: vi.fn(async () => ({ success: true, reply: "{}" })) };
    vi.mocked(getFederationHub).mockReturnValue(
      hub as unknown as ReturnType<typeof getFederationHub>,
    );
    const sat = mockSatellite({ invoke: async () => ({ success: true, data: {} }) });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    await forwardGatewayCall("sat-2", "sessions.spawn", { task: "x" });
    expect(hub.invokeOnNode).toHaveBeenCalled();
    expect(sat.invokeOnMaster).not.toHaveBeenCalled();
  });
});
