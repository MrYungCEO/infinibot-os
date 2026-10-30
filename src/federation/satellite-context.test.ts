/**
 * Tests for the satellite context proxy
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ federation: { mode: "standalone" } })),
}));

vi.mock("./satellite.js", () => ({
  getFederationSatellite: vi.fn(() => null),
}));

import { loadConfig } from "../config/config.js";
import { getFederationSatellite } from "./satellite.js";
import {
  getConnectedSatellite,
  isSatelliteMode,
  applySatelliteProxy,
  proxyToMaster,
  proxyMethodsToMaster,
} from "./satellite-context.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSatellite(state: string, invokeResult: unknown) {
  return {
    getState: () => state,
    invokeOnMaster: vi.fn().mockResolvedValue(invokeResult),
  };
}

function makeHandlerOpts(params: Record<string, unknown> = {}): GatewayRequestHandlerOptions {
  const respond = vi.fn();
  return {
    req: {} as GatewayRequestHandlerOptions["req"],
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestHandlerOptions["context"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isSatelliteMode", () => {
  it("returns false in standalone mode", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "standalone" } } as ReturnType<
      typeof loadConfig
    >);
    expect(isSatelliteMode()).toBe(false);
  });

  it("returns true in satellite mode", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    expect(isSatelliteMode()).toBe(true);
  });

  it("returns false in master mode", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "master" } } as ReturnType<
      typeof loadConfig
    >);
    expect(isSatelliteMode()).toBe(false);
  });
});

describe("getConnectedSatellite", () => {
  it("returns null in standalone mode", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "standalone" } } as ReturnType<
      typeof loadConfig
    >);
    expect(getConnectedSatellite()).toBeNull();
  });

  it("returns null when satellite is not connected", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    vi.mocked(getFederationSatellite).mockReturnValue(
      makeMockSatellite("disconnected", {}) as unknown as ReturnType<typeof getFederationSatellite>,
    );
    expect(getConnectedSatellite()).toBeNull();
  });

  it("returns satellite when connected", () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", {});
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );
    expect(getConnectedSatellite()).toBe(sat);
  });
});

describe("applySatelliteProxy", () => {
  const localHandler = vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { source: "local" });
  });

  const rawHandlers = { "test.method": localHandler };

  beforeEach(() => {
    localHandler.mockClear();
  });

  it("runs local handler when not in satellite mode", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "standalone" } } as ReturnType<
      typeof loadConfig
    >);
    vi.mocked(getFederationSatellite).mockReturnValue(null);

    const wrapped = applySatelliteProxy(rawHandlers);
    const opts = makeHandlerOpts({ foo: "bar" });
    await wrapped["test.method"](opts);

    expect(localHandler).toHaveBeenCalledOnce();
    expect(opts.respond).not.toHaveBeenCalledWith(true, { source: "master" });
  });

  it("proxies to master when satellite is connected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", { success: true, data: { source: "master" } });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = applySatelliteProxy(rawHandlers);
    const opts = makeHandlerOpts({ foo: "bar" });
    await wrapped["test.method"](opts);

    expect(sat.invokeOnMaster).toHaveBeenCalledWith("test.method", { foo: "bar" });
    expect(opts.respond).toHaveBeenCalledWith(true, { source: "master" });
    expect(localHandler).not.toHaveBeenCalled();
  });

  it("falls back to local handler when satellite is disconnected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("disconnected", {});
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = applySatelliteProxy(rawHandlers);
    const opts = makeHandlerOpts({});
    await wrapped["test.method"](opts);

    expect(localHandler).toHaveBeenCalledOnce();
  });

  it("responds with proxy error when master invocation fails", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", {
      success: false,
      error: { code: "TIMEOUT", message: "timed out" },
    });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = applySatelliteProxy(rawHandlers);
    const opts = makeHandlerOpts({});
    await wrapped["test.method"](opts);

    expect(opts.respond).toHaveBeenCalledWith(false, undefined, {
      code: "TIMEOUT",
      message: "timed out",
    });
  });
});

describe("proxyMethodsToMaster", () => {
  const wrappedHandler = vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { source: "local-wrapped" });
  });
  const passThroughHandler = vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { source: "local-pass" });
  });

  const rawHandlers = {
    "shared.read": wrappedHandler,
    "shared.write": wrappedHandler,
    "local.only": passThroughHandler,
  };

  beforeEach(() => {
    wrappedHandler.mockClear();
    passThroughHandler.mockClear();
  });

  it("proxies named methods to master when satellite is connected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", { success: true, data: { source: "master" } });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = proxyMethodsToMaster(rawHandlers, ["shared.read", "shared.write"]);

    const readOpts = makeHandlerOpts({ id: 1 });
    await wrapped["shared.read"](readOpts);
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("shared.read", { id: 1 });
    expect(readOpts.respond).toHaveBeenCalledWith(true, { source: "master" });
    expect(wrappedHandler).not.toHaveBeenCalled();
  });

  it("leaves un-named methods running locally even on a connected satellite", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", { success: true, data: { source: "master" } });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = proxyMethodsToMaster(rawHandlers, ["shared.read"]);
    const localOpts = makeHandlerOpts({});
    await wrapped["local.only"](localOpts);

    expect(passThroughHandler).toHaveBeenCalledOnce();
    expect(sat.invokeOnMaster).not.toHaveBeenCalledWith("local.only", expect.anything());
    expect(localOpts.respond).toHaveBeenCalledWith(true, { source: "local-pass" });
  });

  it("falls back to local handler when satellite is disconnected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("disconnected", {});
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const wrapped = proxyMethodsToMaster(rawHandlers, ["shared.read"]);
    const opts = makeHandlerOpts({});
    await wrapped["shared.read"](opts);

    expect(wrappedHandler).toHaveBeenCalledOnce();
  });

  it("ignores unknown method names without throwing", () => {
    const wrapped = proxyMethodsToMaster(rawHandlers, ["does.not.exist"]);
    expect(Object.keys(wrapped).sort()).toEqual(["local.only", "shared.read", "shared.write"]);
  });
});

describe("proxyToMaster", () => {
  it("returns error when not in satellite mode", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "standalone" } } as ReturnType<
      typeof loadConfig
    >);
    vi.mocked(getFederationSatellite).mockReturnValue(null);

    const result = await proxyToMaster("test.method", {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOT_SATELLITE");
  });

  it("forwards call to master when connected", async () => {
    vi.mocked(loadConfig).mockReturnValue({ federation: { mode: "satellite" } } as ReturnType<
      typeof loadConfig
    >);
    const sat = makeMockSatellite("connected", { success: true, data: { ok: true } });
    vi.mocked(getFederationSatellite).mockReturnValue(
      sat as unknown as ReturnType<typeof getFederationSatellite>,
    );

    const result = await proxyToMaster("test.method", { key: "val" });
    expect(sat.invokeOnMaster).toHaveBeenCalledWith("test.method", { key: "val" });
    expect(result.success).toBe(true);
  });
});
