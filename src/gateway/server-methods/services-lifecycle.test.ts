/**
 * Tests for the ServiceManager-backed `services.*` lifecycle handlers.
 * These previously had no gateway handler at all, so every start/stop/
 * restart/health/unregister button returned `unknown method`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const manager = {
  ready: vi.fn(async () => {}),
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  restart: vi.fn(),
  checkServiceHealth: vi.fn(),
  getStatus: vi.fn(),
  getAllStatus: vi.fn(() => []),
};

const registry = {
  getService: vi.fn(),
  unregisterService: vi.fn(() => true),
  getCapabilitiesForNode: vi.fn(() => ({})),
};

vi.mock("../../services/index.js", () => ({
  getServiceManager: () => manager,
  getServiceRegistry: () => registry,
}));

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/state",
}));

const { servicesLifecycleHandlers } = await import("./services-lifecycle.js");

type Reply = { ok: boolean; payload?: any; error?: any };

async function call(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
  const handler = servicesLifecycleHandlers[method];
  if (!handler) throw new Error(`no handler for ${method}`);
  let reply: Reply | undefined;
  await handler({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  if (!reply) throw new Error(`${method} never responded`);
  return reply;
}

beforeEach(() => {
  vi.clearAllMocks();
  manager.ready.mockResolvedValue(undefined);
  manager.stop.mockResolvedValue(undefined);
  manager.getAllStatus.mockReturnValue([]);
  registry.unregisterService.mockReturnValue(true);
  registry.getCapabilitiesForNode.mockReturnValue({});
});

describe("services.start", () => {
  it("starts a service and returns its instance", async () => {
    manager.start.mockResolvedValue({ serviceId: "image-api", status: "running" });

    const res = await call("services.start", {
      serviceId: "image-api",
      waitForHealthy: true,
      timeoutMs: 60000,
    });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ success: true });
    expect(manager.start).toHaveBeenCalledWith("image-api", {
      waitForHealthy: true,
      timeoutMs: 60000,
    });
  });

  it("requires a serviceId", async () => {
    const res = await call("services.start", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(manager.start).not.toHaveBeenCalled();
  });

  it("surfaces a start failure as an error reply", async () => {
    manager.start.mockRejectedValue(new Error("Service not found: bogus"));

    const res = await call("services.start", { serviceId: "bogus" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({
      code: "SERVICE_START_FAILED",
      message: "Service not found: bogus",
    });
  });
});

describe("services.stop", () => {
  it("stops a service and is safe to call twice", async () => {
    manager.getStatus.mockReturnValue({ serviceId: "stt-server", status: "stopped" });

    const first = await call("services.stop", { serviceId: "stt-server" });
    const second = await call("services.stop", { serviceId: "stt-server" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.stop).toHaveBeenCalledTimes(2);
  });

  it("passes force through", async () => {
    await call("services.stop", { serviceId: "s", force: true });
    expect(manager.stop).toHaveBeenCalledWith("s", { force: true });
  });
});

describe("services.restart", () => {
  it("delegates to the manager", async () => {
    manager.restart.mockResolvedValue({ serviceId: "s", status: "running" });
    const res = await call("services.restart", { serviceId: "s" });
    expect(res.ok).toBe(true);
    expect(manager.restart).toHaveBeenCalledWith("s");
  });
});

describe("services.health", () => {
  it("returns the probe result inline", async () => {
    manager.checkServiceHealth.mockResolvedValue({ healthy: true, latencyMs: 12 });

    const res = await call("services.health", { serviceId: "image-api" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ serviceId: "image-api", healthy: true, latencyMs: 12 });
  });

  it("reports an unknown service as unhealthy rather than erroring", async () => {
    manager.checkServiceHealth.mockResolvedValue({
      healthy: false,
      latencyMs: 0,
      error: "Service not found",
    });

    const res = await call("services.health", { serviceId: "nope" });

    expect(res.ok).toBe(true);
    expect(res.payload.healthy).toBe(false);
  });
});

describe("services.unregister", () => {
  it("stops the service before removing it so no child process is orphaned", async () => {
    const order: string[] = [];
    manager.stop.mockImplementation(async () => {
      order.push("stop");
    });
    registry.unregisterService.mockImplementation(() => {
      order.push("unregister");
      return true;
    });

    const res = await call("services.unregister", { serviceId: "s" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ removed: true, serviceId: "s" });
    expect(order).toEqual(["stop", "unregister"]);
  });

  it("reports removed:false for an unknown service", async () => {
    registry.unregisterService.mockReturnValue(false);
    const res = await call("services.unregister", { serviceId: "ghost" });
    expect(res.ok).toBe(true);
    expect(res.payload.removed).toBe(false);
  });
});

describe("services.get", () => {
  it("404s for an unknown service", async () => {
    registry.getService.mockReturnValue(undefined);
    const res = await call("services.get", { serviceId: "ghost" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns the definition plus the live instance", async () => {
    registry.getService.mockReturnValue({ id: "image-api", name: "Image Generation API" });
    manager.getStatus.mockReturnValue({ serviceId: "image-api", status: "running" });

    const res = await call("services.get", { serviceId: "image-api" });

    expect(res.ok).toBe(true);
    expect(res.payload.service).toMatchObject({ id: "image-api" });
    expect(res.payload.instance).toMatchObject({ status: "running" });
  });
});
