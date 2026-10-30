import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { createGatewayPluginRequestHandler } from "./plugins-http.js";
import { createTestRegistry } from "./__tests__/test-utils.js";

const makeResponse = (): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} => {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
};

describe("createGatewayPluginRequestHandler", () => {
  it("returns false when no handlers are registered", async () => {
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry(),
      log,
    });
    const { res } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(false);
  });

  it("continues until a handler reports it handled the request", async () => {
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          { pluginId: "first", handler: first, source: "first" },
          { pluginId: "second", handler: second, source: "second" },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });

    const { res } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("handles registered http routes before generic handlers", async () => {
    const routeHandler = vi.fn(async (_req, res: ServerResponse) => {
      res.statusCode = 200;
    });
    const fallback = vi.fn(async () => true);
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "route",
            path: "/demo",
            handler: routeHandler,
            source: "route",
          },
        ],
        httpHandlers: [{ pluginId: "fallback", handler: fallback, source: "fallback" }],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });

    const { res } = makeResponse();
    const handled = await handler({ url: "/demo" } as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(routeHandler).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("only exposes declared public assets to GET and HEAD pre-auth dispatch", () => {
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "studio",
            path: "/plugins/studio/ui.js",
            handler: vi.fn(),
            source: "studio",
            publicAsset: true,
          },
          {
            pluginId: "studio",
            path: "/plugins/studio/data",
            handler: vi.fn(),
            source: "studio",
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });

    expect(handler.isPublicAsset("/plugins/studio/ui.js", "GET")).toBe(true);
    expect(handler.isPublicAsset("/plugins/studio/ui.js", "HEAD")).toBe(true);
    expect(handler.isPublicAsset("/plugins/studio/ui.js", "POST")).toBe(false);
    expect(handler.isPublicAsset("/plugins/studio/data", "GET")).toBe(false);
  });

  it("logs and responds with 500 when a handler throws", async () => {
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpHandlers: [
          {
            pluginId: "boom",
            handler: async () => {
              throw new Error("boom");
            },
            source: "boom",
          },
        ],
      }),
      log,
    });

    const { res, setHeader, end } = makeResponse();
    const handled = await handler({} as IncomingMessage, res);
    expect(handled).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(res.statusCode).toBe(500);
    expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(end).toHaveBeenCalledWith("Internal Server Error");
  });

  it("reports only manifest-declared self-auth routes as pre-gate", () => {
    const log = { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"];
    const handler = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          { pluginId: "demo", path: "/plugins/demo/hook", handler: vi.fn(), selfAuth: true },
          { pluginId: "demo", path: "/plugins/demo/ui", handler: vi.fn() },
        ],
      }),
      log,
    });
    expect(handler.isSelfAuthRoute?.("/plugins/demo/hook")).toBe(true);
    expect(handler.isSelfAuthRoute?.("/plugins/demo/ui")).toBe(false);
    expect(handler.isSelfAuthRoute?.("/plugins/demo/other")).toBe(false);
  });
});
