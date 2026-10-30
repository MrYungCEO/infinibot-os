import { describe, expect, it, vi } from "vitest";
import { buildAgencyJoinUrl, createTailscaleCollaborationService } from "./tailscale-service.js";
import type { TailscaleCollaborationDependencies } from "./types.js";

function dependencies(
  overrides: Partial<TailscaleCollaborationDependencies> = {},
): TailscaleCollaborationDependencies {
  return {
    findBinary: vi.fn().mockResolvedValue("tailscale"),
    readStatus: vi.fn().mockResolvedValue({
      BackendState: "Running",
      Self: { DNSName: "studio.example.ts.net." },
    }),
    readServeStatus: vi.fn().mockResolvedValue({
      Web: {
        "studio.example.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:18789" } },
        },
      },
    }),
    enableServe: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Tailscale agency collaboration", () => {
  it("reports unavailable without attempting installation", async () => {
    const deps = dependencies({ findBinary: vi.fn().mockResolvedValue(null) });
    const service = createTailscaleCollaborationService(deps);

    await expect(service.getStatus(18789)).resolves.toMatchObject({
      state: "unavailable",
      installed: false,
      running: false,
    });
    expect(deps.readStatus).not.toHaveBeenCalled();
    expect(deps.enableServe).not.toHaveBeenCalled();
  });

  it("reports installed Tailscale that is not running", async () => {
    const deps = dependencies({
      readStatus: vi.fn().mockResolvedValue({ BackendState: "Stopped" }),
    });
    const service = createTailscaleCollaborationService(deps);

    await expect(service.getStatus(18789)).resolves.toMatchObject({
      state: "not_running",
      installed: true,
      running: false,
    });
    expect(deps.readServeStatus).not.toHaveBeenCalled();
  });

  it("reports a stable private HTTPS MagicDNS URL when ready", async () => {
    const service = createTailscaleCollaborationService(dependencies());

    await expect(service.getStatus(18789)).resolves.toMatchObject({
      state: "ready",
      installed: true,
      running: true,
      serveEnabled: true,
      magicDnsName: "studio.example.ts.net",
      collaborationUrl: "https://studio.example.ts.net",
    });
  });

  it("returns a useful error when enabling Serve fails and never invokes Funnel", async () => {
    const enableServe = vi.fn().mockRejectedValue(new Error("permission denied"));
    const deps = dependencies({
      readServeStatus: vi.fn().mockResolvedValue({}),
      enableServe,
    });
    const service = createTailscaleCollaborationService(deps);

    await expect(service.enable(18789)).resolves.toMatchObject({
      state: "error",
      serveEnabled: false,
      error: "permission denied",
    });
    expect(enableServe).toHaveBeenCalledWith(18789);
  });

  it("enables Serve and verifies readiness", async () => {
    const readServeStatus = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Web: {
          "studio.example.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:18789" } } },
        },
      });
    const deps = dependencies({ readServeStatus });
    const service = createTailscaleCollaborationService(deps);

    await expect(service.enable(18789)).resolves.toMatchObject({ state: "ready" });
    expect(deps.enableServe).toHaveBeenCalledWith(18789);
  });

  it("builds encoded join links without preserving unsafe URL components", () => {
    expect(
      buildAgencyJoinUrl({
        baseUrl: "https://studio.example.ts.net/old?admin=true#fragment",
        invitationToken: "signed token&agency=other",
      }),
    ).toBe("https://studio.example.ts.net/agency/join?token=signed+token%26agency%3Dother");
    expect(() =>
      buildAgencyJoinUrl({
        baseUrl: "http://studio.example.ts.net",
        invitationToken: "token",
      }),
    ).toThrow("HTTPS");
  });
});
