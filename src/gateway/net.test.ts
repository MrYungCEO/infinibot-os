import { describe, expect, it } from "vitest";

import { resolveGatewayListenHosts } from "./net.js";

describe("resolveGatewayListenHosts", () => {
  it("returns the input host when not loopback", async () => {
    const hosts = await resolveGatewayListenHosts("0.0.0.0", {
      canBindToHost: async () => {
        throw new Error("should not be called");
      },
    });
    expect(hosts).toEqual(["0.0.0.0"]);
  });

  it("adds ::1 when IPv6 loopback is available", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => true,
    });
    expect(hosts).toEqual(["127.0.0.1", "::1"]);
  });

  it("keeps only IPv4 loopback when IPv6 is unavailable", async () => {
    const hosts = await resolveGatewayListenHosts("127.0.0.1", {
      canBindToHost: async () => false,
    });
    expect(hosts).toEqual(["127.0.0.1"]);
  });

  it("does not probe loopback for a wildcard bind (already covered)", async () => {
    const hosts = await resolveGatewayListenHosts("::", {
      canBindToHost: async () => {
        throw new Error("should not be called");
      },
    });
    expect(hosts).toEqual(["::"]);
  });

  it("adds loopback aliases for a specific non-loopback host (secure local UI)", async () => {
    // A tailnet IP bind must also listen on loopback so the local browser can
    // reach the Control UI at http://localhost (a secure context).
    const hosts = await resolveGatewayListenHosts("100.64.10.6", {
      canBindToHost: async () => true,
    });
    expect(hosts).toEqual(["100.64.10.6", "127.0.0.1", "::1"]);
  });

  it("keeps the specific host first and skips loopback aliases that can't bind", async () => {
    const hosts = await resolveGatewayListenHosts("100.64.10.6", {
      canBindToHost: async (h) => h === "127.0.0.1",
    });
    expect(hosts).toEqual(["100.64.10.6", "127.0.0.1"]);
  });
});
