/**
 * Regression tests for the satellite-side `gateway:proxy:request` listener
 * wiring.
 *
 * Bug history: in CLI satellite mode (`infinibot gateway --satellite`),
 * runSatelliteMode installs the FederationSatellite singleton BEFORE
 * startGatewayServer runs, so the runtime-state init's
 * `if (federationSatelliteMode && !skipRuntimeSatellite)` branch is
 * skipped. The original listener wiring lived inside that branch, so the
 * CLI path silently shipped without a handler — master would send
 * `gateway.proxy.invoke` for `terminal.create` from mobile, the satellite
 * would emit `gateway:proxy:request`, no one listened, master timed out
 * after 30s, and mobile rendered a blank terminal forever.
 *
 * The listener now hangs off the RESOLVED satellite (singleton OR local)
 * and these tests pin that contract.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
  attachGatewayProxyRequestListener,
  type CallGatewayFn,
} from "./satellite-proxy-listener.js";
import type { FederationSatellite } from "./satellite.js";

// Minimal stand-in for FederationSatellite — we only need the bits the
// listener touches: EventEmitter behaviour + sendGatewayProxyResult.
function makeFakeSatellite() {
  const ee = new EventEmitter();
  const sendGatewayProxyResult = vi.fn();
  // Cast through unknown since we only stub the slice of the API the
  // listener actually uses.
  const satellite = Object.assign(ee, { sendGatewayProxyResult }) as unknown as FederationSatellite;
  return { satellite, sendGatewayProxyResult, ee };
}

describe("attachGatewayProxyRequestListener", () => {
  it("dispatches gateway.proxy.invoke to callGateway and replies with payload", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    const callGateway: CallGatewayFn = vi.fn(async ({ method }) =>
      method === "terminal.create" ? { success: true, terminalId: "term-abc" } : null,
    );

    attachGatewayProxyRequestListener(satellite, { callGateway });
    ee.emit("gateway:proxy:request", {
      correlationId: "req-1",
      method: "terminal.create",
      params: { id: "term-abc", cwd: "." },
    });

    // Allow the async handler to run.
    await new Promise((r) => setImmediate(r));

    expect(callGateway).toHaveBeenCalledWith({
      method: "terminal.create",
      params: { id: "term-abc", cwd: "." },
      timeoutMs: 30_000,
    });
    expect(sendGatewayProxyResult).toHaveBeenCalledWith("req-1", {
      success: true,
      payload: { success: true, terminalId: "term-abc" },
    });
  });

  it("reports thrown callGateway errors as success:false", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    const callGateway: CallGatewayFn = vi.fn(async () => {
      throw new Error("boom");
    });

    attachGatewayProxyRequestListener(satellite, { callGateway });
    ee.emit("gateway:proxy:request", {
      correlationId: "req-2",
      method: "terminal.write",
      params: { id: "x", data: "ls\r" },
    });

    await new Promise((r) => setImmediate(r));

    expect(sendGatewayProxyResult).toHaveBeenCalledWith("req-2", {
      success: false,
      error: "boom",
    });
  });

  it("rejects requests without a method", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    const callGateway: CallGatewayFn = vi.fn();

    attachGatewayProxyRequestListener(satellite, { callGateway });
    ee.emit("gateway:proxy:request", { correlationId: "req-3" });

    await new Promise((r) => setImmediate(r));

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendGatewayProxyResult).toHaveBeenCalledWith("req-3", {
      success: false,
      error: "method is required",
    });
  });

  it("drops requests without a correlationId (nothing to reply to)", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    const callGateway: CallGatewayFn = vi.fn();

    attachGatewayProxyRequestListener(satellite, { callGateway });
    ee.emit("gateway:proxy:request", { method: "terminal.create", params: {} });

    await new Promise((r) => setImmediate(r));

    expect(callGateway).not.toHaveBeenCalled();
    expect(sendGatewayProxyResult).not.toHaveBeenCalled();
  });

  it("is idempotent — second call does not double-wire (the bug guard)", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    const callGateway: CallGatewayFn = vi.fn(async () => ({ ok: true }));

    const first = attachGatewayProxyRequestListener(satellite, { callGateway });
    const second = attachGatewayProxyRequestListener(satellite, { callGateway });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(satellite.listenerCount("gateway:proxy:request")).toBe(1);

    ee.emit("gateway:proxy:request", {
      correlationId: "req-4",
      method: "terminal.list",
      params: {},
    });
    await new Promise((r) => setImmediate(r));

    // Only one reply, not two — proves we only have one listener.
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(sendGatewayProxyResult).toHaveBeenCalledTimes(1);
  });
});

describe("attachGatewayProxyRequestListener: federation.share", () => {
  it("refuses methods in a category the owner doesn't share, without calling the gateway", async () => {
    const { satellite, sendGatewayProxyResult, ee } = makeFakeSatellite();
    Object.assign(satellite, { getSharePolicy: () => ({ terminals: false, coders: true }) });
    const callGateway: CallGatewayFn = vi.fn(async () => ({ ok: true }));
    attachGatewayProxyRequestListener(satellite, { callGateway });

    ee.emit("gateway:proxy:request", {
      correlationId: "deny-1",
      method: "terminal.create",
      params: {},
    });
    ee.emit("gateway:proxy:request", {
      correlationId: "allow-1",
      method: "terminal.spawnAgent",
      params: {},
    });
    await new Promise((r) => setImmediate(r));

    expect(sendGatewayProxyResult).toHaveBeenCalledWith("deny-1", {
      success: false,
      error: expect.stringContaining("federation.share.terminals"),
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith({
      method: "terminal.spawnAgent",
      params: {},
      timeoutMs: 30_000,
    });
  });
});
