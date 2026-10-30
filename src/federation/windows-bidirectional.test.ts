/**
 * Bidirectional spawn invariant — Windows scenario (in-process simulation).
 *
 * Simulates node A (Windows: outbound WS only, no inbound listen port) and
 * verifies that BOTH directions of federation spawn succeed via the hub's
 * multiplexed outbound WS:
 *
 *   OUTBOUND  A → B  satellite A tunnels to master, master forwards to peer B
 *   INBOUND   B → A  peer B tunnels to master, master uses A's existing WS
 *
 * Pure in-process test — no real OS, Windows, or network required.
 * Mock contracts are verified against hub-forward.satellite.test.ts patterns.
 *
 * Set INFINIBOT_SKIP_FEDERATION_INTEGRATION=1 to skip when running against a
 * live mesh where mock interference would be disruptive.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./hub.js", () => ({ getFederationHub: vi.fn(() => null) }));
vi.mock("./satellite.js", () => ({ getFederationSatellite: vi.fn(() => null) }));

import { getFederationHub } from "./hub.js";
import { getFederationSatellite } from "./satellite.js";
import { forwardGatewayCall } from "./hub-forward.js";

const maybeSkip = process.env.INFINIBOT_SKIP_FEDERATION_INTEGRATION === "1" ? it.skip : it;

// ─── Mock factories (contracts match hub-forward.satellite.test.ts) ───────────

/**
 * Satellite mock — represents node A (Windows, no inbound port).
 *   getState()          → "connected" | "reconnecting" | ...
 *   invokeOnMaster(method, params, ms)  → { success, data?, error?: { code, message } }
 */
function mockWindowsSatellite(opts: {
  id?: string;
  state?: string;
  invokeResult?: { success: boolean; data?: unknown; error?: { code?: string; message?: string } };
}) {
  const result = opts.invokeResult ?? { success: true, data: { ok: true } };
  return {
    getManifest: vi.fn(() => ({ id: opts.id ?? "windows-a" })),
    getState: vi.fn(() => opts.state ?? "connected"),
    invokeOnMaster: vi.fn(async () => result),
  };
}

/**
 * Hub mock — represents the master node.
 *   invokeOnNode(nodeId, cmd, params, ms) → { success, reply?: string, error?: string }
 * The hub uses the satellite's existing outbound WS connection; callers of
 * invokeOnNode("windows-a", ...) do NOT need a fresh inbound connection.
 */
function mockMasterHub(opts: {
  id?: string;
  invokeResult?: { success: boolean; reply?: string; error?: string };
}) {
  const result = opts.invokeResult ?? { success: true, reply: JSON.stringify({ ok: true }) };
  return {
    getLocalNodeId: vi.fn(() => opts.id ?? "master"),
    invokeOnNode: vi.fn(async () => result),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("windows bidirectional spawn invariant", () => {
  beforeEach(() => {
    vi.mocked(getFederationHub).mockReturnValue(null);
    vi.mocked(getFederationSatellite).mockReturnValue(null);
  });

  // ── OUTBOUND: A (Windows, no inbound) → B (non-Windows peer) ────────────────

  describe("OUTBOUND: Windows satellite spawns to non-Windows peer via master", () => {
    maybeSkip(
      "routes through satellite.invokeOnMaster — never attempts a direct connection to peer",
      async () => {
        const sat = mockWindowsSatellite({ id: "windows-a" });
        vi.mocked(getFederationSatellite).mockReturnValue(sat as never);

        const result = await forwardGatewayCall("peer-b", "sessions.list", {});

        expect(result.success).toBe(true);
        // Satellite must tunnel upward — it has no direct route to peer-b.
        expect(sat.invokeOnMaster).toHaveBeenCalledOnce();
        // The call must carry nodeId="peer-b" so master re-routes to the sibling.
        expect(sat.invokeOnMaster).toHaveBeenCalledWith(
          "sessions.list",
          expect.objectContaining({ nodeId: "peer-b" }),
          expect.any(Number),
        );
      },
    );

    maybeSkip("returns success payload from peer-b through the master relay", async () => {
      const peerPayload = { sessions: [], nodeId: "peer-b" };
      const sat = mockWindowsSatellite({
        invokeResult: { success: true, data: peerPayload },
      });
      vi.mocked(getFederationSatellite).mockReturnValue(sat as never);

      const result = await forwardGatewayCall<typeof peerPayload>("peer-b", "sessions.list", {});

      expect(result.success).toBe(true);
      expect(result.payload).toEqual(peerPayload);
    });

    maybeSkip("surfaces master error code when master rejects the sat→peer tunnel", async () => {
      const sat = mockWindowsSatellite({
        invokeResult: {
          success: false,
          error: { code: "INVOKE_FAILED", message: "peer-b not connected" },
        },
      });
      vi.mocked(getFederationSatellite).mockReturnValue(sat as never);

      const result = await forwardGatewayCall("peer-b", "sessions.list", {});

      expect(result.success).toBe(false);
      expect(result.code).toBe("INVOKE_FAILED");
      expect(result.error).toMatch(/peer-b not connected/);
    });

    maybeSkip(
      "returns MASTER_UNAVAILABLE fast when satellite is disconnected (no silent hang)",
      async () => {
        const sat = mockWindowsSatellite({ state: "reconnecting" });
        vi.mocked(getFederationSatellite).mockReturnValue(sat as never);

        const result = await forwardGatewayCall("peer-b", "sessions.list", {});

        expect(result.success).toBe(false);
        expect(result.code).toBe("MASTER_UNAVAILABLE");
        // Must not have attempted the invoke — fail fast without waiting
        expect(sat.invokeOnMaster).not.toHaveBeenCalled();
      },
    );
  });

  // ── INBOUND: B (non-Windows peer) → A (Windows, no inbound port) ─────────────

  describe("INBOUND: master hub reaches Windows satellite via multiplexed outbound WS", () => {
    maybeSkip(
      "hub.invokeOnNode targets the Windows satellite by nodeId (uses existing mux'd WS)",
      async () => {
        const hub = mockMasterHub({ id: "master" });
        vi.mocked(getFederationHub).mockReturnValue(hub as never);

        const result = await forwardGatewayCall("windows-a", "sessions.list", {});

        expect(result.success).toBe(true);
        // Hub must call invokeOnNode with the exact Windows nodeId.
        // The hub uses the satellite's existing outbound WS — no new inbound
        // connection to Windows is initiated, which is the whole hardening claim.
        expect(hub.invokeOnNode).toHaveBeenCalledWith(
          "windows-a",
          expect.any(String),
          expect.objectContaining({ method: "sessions.list" }),
          expect.any(Number),
        );
      },
    );

    maybeSkip(
      "hub.invokeOnNode receives the payload from windows-a and returns it to caller",
      async () => {
        const windowsPayload = { sessions: [], nodeId: "windows-a" };
        const hub = mockMasterHub({
          invokeResult: { success: true, reply: JSON.stringify(windowsPayload) },
        });
        vi.mocked(getFederationHub).mockReturnValue(hub as never);

        const result = await forwardGatewayCall<typeof windowsPayload>(
          "windows-a",
          "sessions.list",
          {},
        );

        expect(result.success).toBe(true);
        expect(result.payload).toEqual(windowsPayload);
      },
    );
  });

  // ── Full round-trip: A → B → A ───────────────────────────────────────────────

  describe("full round-trip", () => {
    maybeSkip("bidirectional spawn succeeds via multiplexed outbound WS", async () => {
      // Leg 1 — OUTBOUND: Windows satellite (A) calls peer B through master.
      const outboundPayload = { ok: true, leg: "A→B" };
      const sat = mockWindowsSatellite({
        id: "windows-a",
        invokeResult: { success: true, data: outboundPayload },
      });
      vi.mocked(getFederationHub).mockReturnValue(null);
      vi.mocked(getFederationSatellite).mockReturnValue(sat as never);

      const outbound = await forwardGatewayCall("peer-b", "sessions.list", {});
      expect(outbound.success).toBe(true);
      expect(outbound.payload).toEqual(outboundPayload);
      expect(sat.invokeOnMaster).toHaveBeenCalledOnce();

      // Leg 2 — INBOUND: master hub invokes on Windows satellite (A) on behalf of
      // peer B.  Simulates peer B having tunnelled the request through master.
      const inboundPayload = { ok: true, leg: "B→A" };
      const hub = mockMasterHub({
        id: "master",
        invokeResult: { success: true, reply: JSON.stringify(inboundPayload) },
      });
      vi.mocked(getFederationHub).mockReturnValue(hub as never);
      vi.mocked(getFederationSatellite).mockReturnValue(null);

      const inbound = await forwardGatewayCall("windows-a", "sessions.list", {});
      expect(inbound.success).toBe(true);
      expect(inbound.payload).toEqual(inboundPayload);
      expect(hub.invokeOnNode).toHaveBeenCalledWith(
        "windows-a",
        expect.any(String),
        expect.any(Object),
        expect.any(Number),
      );

      // Both legs completed: bidirectional invariant holds.
    });
  });
});
