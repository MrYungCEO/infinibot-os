/**
 * Tests for `formatMasterUrl` — the master-URL normalization used by
 * `runSatelliteMode` (gateway-cli satellite path).
 *
 * Regression: a `federation.masterUrl` of `https://host` (e.g. a Tailscale
 * HTTPS URL) used to get `ws://` blindly prepended → `ws://https://host`,
 * whose hostname parses as literally "https" → `getaddrinfo ENOTFOUND https`.
 * https:// must map to wss:// instead.
 */

import { describe, it, expect } from "vitest";

import { formatMasterUrl } from "./satellite.js";

describe("formatMasterUrl", () => {
  it("maps https:// to wss:// (the ENOTFOUND-https regression)", () => {
    expect(formatMasterUrl("https://my-host-01.tail1234.ts.net")).toBe(
      "wss://my-host-01.tail1234.ts.net/federation",
    );
  });

  it("maps http:// to ws://", () => {
    expect(formatMasterUrl("http://192.168.1.10:47913")).toBe("ws://192.168.1.10:47913/federation");
  });

  it("leaves an existing ws:// scheme intact", () => {
    expect(formatMasterUrl("ws://192.168.1.10:47913")).toBe("ws://192.168.1.10:47913/federation");
  });

  it("leaves an existing wss:// scheme intact", () => {
    expect(formatMasterUrl("wss://host.example.com")).toBe("wss://host.example.com/federation");
  });

  it("prepends ws:// for a bare host:port", () => {
    expect(formatMasterUrl("192.168.1.10:47913")).toBe("ws://192.168.1.10:47913/federation");
  });

  it("preserves an explicit /federation path without doubling it", () => {
    expect(formatMasterUrl("wss://host.example.com/federation")).toBe(
      "wss://host.example.com/federation",
    );
  });

  it("does not clobber a non-root custom path", () => {
    expect(formatMasterUrl("wss://host.example.com/custom")).toBe("wss://host.example.com/custom");
  });

  it("throws a clear error on an unparseable URL", () => {
    expect(() => formatMasterUrl("ws://")).toThrow(/Invalid master URL/);
  });
});
