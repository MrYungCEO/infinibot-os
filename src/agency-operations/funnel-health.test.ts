import { describe, expect, it, vi } from "vitest";

import { AgencyFunnelHealthService } from "./funnel-health.js";
import type { AgencyFunnelConnection } from "./funnel-types.js";

function connection(patch?: Partial<AgencyFunnelConnection>): AgencyFunnelConnection {
  return {
    id: "connection-1",
    agencyId: "agency-1",
    funnelId: "funnel-1",
    nodeId: null,
    provider: "CRM",
    connectionKey: "crm.primary",
    status: "connected",
    config: {},
    lastCheckedAt: null,
    lastHealthyAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("AgencyFunnelHealthService", () => {
  it("probes configured HTTP endpoints without returning paths, query strings, or secrets", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const service = new AgencyFunnelHealthService({ fetchImpl, timeoutMs: 1000 });
    const result = await service.check(
      connection({
        config: {
          healthUrl: "https://api.example.test/private/health?token=super-secret",
          apiKey: "also-secret",
        },
      }),
    );
    expect(result).toMatchObject({
      status: "healthy",
      details: { source: "http_endpoint", endpointOrigin: "https://api.example.test" },
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain("also-secret");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses declared state when no active endpoint is configured", async () => {
    const service = new AgencyFunnelHealthService();
    await expect(service.check(connection({ status: "degraded" }))).resolves.toMatchObject({
      status: "degraded",
      details: { source: "declared_state" },
    });
  });

  it("bounds slow probes with an abort timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<{ ok: boolean; status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const service = new AgencyFunnelHealthService({ fetchImpl, timeoutMs: 250 });
    await expect(
      service.check(connection({ config: { healthUrl: "https://slow.example.test/health" } })),
    ).resolves.toMatchObject({ status: "unhealthy", details: { errorKind: "timeout" } });
  });
});
