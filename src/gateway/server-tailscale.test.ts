import { describe, expect, it, vi } from "vitest";
import { InfinibotSchema } from "../config/zod-schema.js";
import {
  startGatewayTailscaleExposure,
  startGatewayTailscaleExposureDetached,
  type TailscaleExposureDeps,
} from "./server-tailscale.js";
import { resolveTailscaleExposurePlan, resolveTailscaleMode } from "./tailscale-config.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function makeDeps(overrides: Partial<TailscaleExposureDeps> = {}): TailscaleExposureDeps {
  return {
    findBinary: vi.fn(async () => "/usr/bin/tailscale"),
    readServeStatus: vi.fn(async () => ({})),
    enableServe: vi.fn(async () => {}),
    enableFunnel: vi.fn(async () => {}),
    disableServe: vi.fn(async () => {}),
    disableFunnel: vi.fn(async () => {}),
    tailnetHostname: vi.fn(async () => "box.tail1234.ts.net"),
    ...overrides,
  } as TailscaleExposureDeps;
}

/** A serve-status payload shaped like the real one, proxying to `port`. */
function servedStatus(port: number) {
  return {
    Web: {
      "box.tail1234.ts.net:443": {
        Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } },
      },
    },
  };
}

describe("gateway.tailscale config schema", () => {
  // Guard: the gateway config object is .strict(), so a key that exists in the
  // TS types but not here is silently unsettable via `infinibot config set`.
  it("accepts the auto-serve keys", () => {
    const parsed = InfinibotSchema.parse({
      gateway: {
        tailscale: {
          mode: "serve",
          autoServe: true,
          funnel: false,
          port: 18789,
          exposeExpo: false,
          expoPort: 8081,
          resetOnExit: false,
        },
      },
    });
    expect(parsed.gateway?.tailscale).toMatchObject({
      autoServe: true,
      funnel: false,
      port: 18789,
      exposeExpo: false,
      expoPort: 8081,
    });
  });

  it("still rejects an unknown key under gateway.tailscale", () => {
    expect(() => InfinibotSchema.parse({ gateway: { tailscale: { autoServ: true } } })).toThrow();
  });

  it("rejects a non-port number", () => {
    expect(() => InfinibotSchema.parse({ gateway: { tailscale: { port: 70_000 } } })).toThrow();
  });
});

describe("resolveTailscaleMode", () => {
  it("defaults to off", () => {
    expect(resolveTailscaleMode(undefined)).toBe("off");
    expect(resolveTailscaleMode({})).toBe("off");
    expect(resolveTailscaleMode({ autoServe: false })).toBe("off");
  });

  it("maps autoServe to serve, never to funnel", () => {
    expect(resolveTailscaleMode({ autoServe: true })).toBe("serve");
    expect(resolveTailscaleMode({ autoServe: true, funnel: false })).toBe("serve");
  });

  it("requires funnel to be spelled out", () => {
    expect(resolveTailscaleMode({ funnel: true })).toBe("funnel");
  });

  it("lets an explicit mode win over the shorthands", () => {
    expect(resolveTailscaleMode({ mode: "off", autoServe: true })).toBe("off");
    expect(resolveTailscaleMode({ mode: "serve", funnel: true })).toBe("serve");
  });
});

describe("resolveTailscaleExposurePlan", () => {
  it("is fully off by default — including expo", () => {
    expect(resolveTailscaleExposurePlan({ cfg: undefined, gatewayPort: 18789 })).toEqual({
      mode: "off",
      port: 18789,
      expoPort: null,
      resetOnExit: false,
      publicExposure: false,
    });
  });

  it("defaults the exposed port to the gateway port and honours an override", () => {
    expect(
      resolveTailscaleExposurePlan({ cfg: { autoServe: true }, gatewayPort: 18789 }).port,
    ).toBe(18789);
    expect(
      resolveTailscaleExposurePlan({ cfg: { autoServe: true, port: 9000 }, gatewayPort: 18789 })
        .port,
    ).toBe(9000);
  });

  it("leaves expo off unless explicitly asked for", () => {
    // Regression: this used to run unconditionally at boot, and because serve
    // mounts one port at the tailnet root it took the root away from the
    // control UI — the tailnet URL served Metro instead of InfiniBot.
    expect(
      resolveTailscaleExposurePlan({ cfg: { autoServe: true }, gatewayPort: 1 }).expoPort,
    ).toBeNull();
    expect(
      resolveTailscaleExposurePlan({ cfg: { exposeExpo: true }, gatewayPort: 1 }).expoPort,
    ).toBe(8081);
    expect(
      resolveTailscaleExposurePlan({ cfg: { exposeExpo: true, expoPort: 9999 }, gatewayPort: 1 })
        .expoPort,
    ).toBe(9999);
  });
});

describe("startGatewayTailscaleExposure", () => {
  it("is a complete no-op when disabled (the default)", async () => {
    const deps = makeDeps();
    const logTailscale = makeLog();
    const cleanup = await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({ cfg: undefined, gatewayPort: 18789 }),
      logTailscale,
      deps,
    });
    expect(cleanup).toBeNull();
    expect(deps.findBinary).not.toHaveBeenCalled();
    expect(deps.enableServe).not.toHaveBeenCalled();
    expect(logTailscale.info).not.toHaveBeenCalled();
    expect(logTailscale.warn).not.toHaveBeenCalled();
  });

  it("does not throw and does not boot-block when the tailscale binary is absent", async () => {
    const deps = makeDeps({ findBinary: vi.fn(async () => null) });
    const logTailscale = makeLog();
    await expect(
      startGatewayTailscaleExposure({
        plan: resolveTailscaleExposurePlan({ cfg: { autoServe: true }, gatewayPort: 18789 }),
        logTailscale,
        deps,
      }),
    ).resolves.toBeNull();
    expect(deps.enableServe).not.toHaveBeenCalled();
    expect(logTailscale.warn).toHaveBeenCalledTimes(1);
    expect(logTailscale.warn.mock.calls[0][0]).toContain("tailscale CLI was not found");
  });

  it("does not throw when the daemon is down / not logged in", async () => {
    const deps = makeDeps({
      readServeStatus: vi.fn(async () => {
        throw new Error("failed to connect to local tailscaled");
      }),
      enableServe: vi.fn(async () => {
        throw new Error("Logged out.");
      }),
    });
    const logTailscale = makeLog();
    await expect(
      startGatewayTailscaleExposure({
        plan: resolveTailscaleExposurePlan({
          cfg: { autoServe: true, exposeExpo: false },
          gatewayPort: 18789,
        }),
        logTailscale,
        deps,
      }),
    ).resolves.toBeNull();
    expect(logTailscale.warn.mock.calls[0][0]).toContain("serve failed: Logged out.");
  });

  it("enables serve and logs the tailnet URL once", async () => {
    const deps = makeDeps();
    const logTailscale = makeLog();
    await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({
        cfg: { autoServe: true, exposeExpo: false },
        gatewayPort: 18789,
      }),
      logTailscale,
      deps,
    });
    expect(deps.enableServe).toHaveBeenCalledWith(18789);
    expect(logTailscale.info).toHaveBeenCalledTimes(1);
    expect(logTailscale.info.mock.calls[0][0]).toContain("https://box.tail1234.ts.net/");
  });

  it("is idempotent: an already-served port is left alone", async () => {
    const deps = makeDeps({ readServeStatus: vi.fn(async () => servedStatus(18789)) });
    const logTailscale = makeLog();
    await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({
        cfg: { autoServe: true, exposeExpo: false },
        gatewayPort: 18789,
      }),
      logTailscale,
      deps,
    });
    expect(deps.enableServe).not.toHaveBeenCalled();
    expect(logTailscale.info.mock.calls[0][0]).toContain("serve already configured");
    expect(logTailscale.info.mock.calls[0][0]).toContain("https://box.tail1234.ts.net/");
  });

  it("warns loudly and distinctly when funnel exposes the gateway publicly", async () => {
    const deps = makeDeps();
    const logTailscale = makeLog();
    await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({
        cfg: { funnel: true, exposeExpo: false },
        gatewayPort: 18789,
      }),
      logTailscale,
      deps,
    });
    expect(deps.enableFunnel).toHaveBeenCalledWith(18789);
    expect(deps.enableServe).not.toHaveBeenCalled();
    expect(logTailscale.warn.mock.calls[0][0]).toContain("PUBLIC INTERNET");
  });

  it("gives the control UI the tailnet root when expo is also exposed", async () => {
    const order: number[] = [];
    const deps = makeDeps({
      enableServe: vi.fn(async (port: number) => {
        order.push(port);
      }),
    });
    const logTailscale = makeLog();
    await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({
        cfg: { autoServe: true, exposeExpo: true },
        gatewayPort: 18789,
      }),
      logTailscale,
      deps,
    });
    // Last writer wins the root path, so the gateway must go last.
    expect(order).toEqual([8081, 18789]);
    expect(logTailscale.warn.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "share one tailnet root path",
    );
  });

  it("returns a cleanup handle only when resetOnExit is set", async () => {
    const withReset = makeDeps();
    const cleanup = await startGatewayTailscaleExposure({
      plan: resolveTailscaleExposurePlan({
        cfg: { autoServe: true, resetOnExit: true, exposeExpo: false },
        gatewayPort: 1,
      }),
      logTailscale: makeLog(),
      deps: withReset,
    });
    expect(cleanup).toBeTypeOf("function");
    await cleanup?.();
    expect(withReset.disableServe).toHaveBeenCalled();
  });
});

describe("startGatewayTailscaleExposureDetached", () => {
  it("returns synchronously without awaiting the tailscale CLI", async () => {
    let released: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const deps = makeDeps({
      enableServe: vi.fn(async () => {
        await gate;
      }),
    });
    const logTailscale = makeLog();
    const cleanup = startGatewayTailscaleExposureDetached({
      plan: resolveTailscaleExposurePlan({
        cfg: { autoServe: true, resetOnExit: true, exposeExpo: false },
        gatewayPort: 18789,
      }),
      logTailscale,
      deps,
    });
    // Startup continues while `enableServe` is still hanging.
    expect(cleanup).toBeTypeOf("function");
    expect(logTailscale.info).not.toHaveBeenCalled();
    released();
    await cleanup();
    expect(deps.disableServe).toHaveBeenCalled();
  });
});
