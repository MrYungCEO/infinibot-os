import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FederationHub } from "../federation/hub.js";
import { encodeInvite } from "../federation/invite.js";
import {
  DEFAULT_PERMISSIONS,
  getFederationSecurity,
  type SatelliteToken,
} from "../federation/security.js";
import {
  buildSatelliteConfig,
  normalizeMasterUrl,
  parsePairingInvite,
  probeFirstReachable,
  probeMaster,
} from "./satellite.js";

const TOKEN: SatelliteToken = {
  satelliteId: "sat-abc",
  permissions: DEFAULT_PERMISSIONS.full,
  issuedAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  signature: "deadbeef",
};

function webInvite(over: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      hubUrl: "ws://192.168.1.20:18789/federation",
      hubUrls: ["ws://192.168.1.20:18789/federation", "ws://100.64.0.7:18789/federation"],
      hubName: "Studio",
      satelliteName: "Laptop",
      token: TOKEN,
      expiresAt: 4_000_000_000_000,
      generatedAt: 1_700_000_000_000,
      ...over,
    }),
  ).toString("base64");
}

describe("normalizeMasterUrl", () => {
  it("accepts host:port, http(s) and ws(s), and lands on /federation", () => {
    expect(normalizeMasterUrl("10.0.0.5:18789")).toBe("ws://10.0.0.5:18789/federation");
    expect(normalizeMasterUrl("http://studio.local:18789")).toBe(
      "ws://studio.local:18789/federation",
    );
    expect(normalizeMasterUrl("https://hub.example.com")).toBe("wss://hub.example.com/federation");
    expect(normalizeMasterUrl("ws://h:1/federation")).toBe("ws://h:1/federation");
    expect(() => normalizeMasterUrl("")).toThrow(/address/);
    expect(() => normalizeMasterUrl("ftp://x")).toThrow(/scheme/);
  });
});

describe("parsePairingInvite", () => {
  it("reads the master's web invite (federation.generateInvite) with every URL candidate", () => {
    const inv = parsePairingInvite(webInvite(), 1_800_000_000_000);
    expect(inv).toMatchObject({
      format: "web",
      masterUrls: ["ws://192.168.1.20:18789/federation", "ws://100.64.0.7:18789/federation"],
      hubName: "Studio",
      satelliteName: "Laptop",
    });
    expect(inv.token).toEqual(TOKEN);
  });

  it("reads the CLI invite (infinibot federation invite)", () => {
    const cli = encodeInvite({
      v: 1,
      masterUrl: "ws://studio:18789/federation",
      satelliteToken: TOKEN,
      label: "Studio",
      expiresAt: 4_000_000_000_000,
      iss: "studio",
    });
    const inv = parsePairingInvite(cli, 1_800_000_000_000);
    expect(inv.format).toBe("cli");
    expect(inv.masterUrls).toEqual(["ws://studio:18789/federation"]);
    expect(inv.token.satelliteId).toBe("sat-abc");
  });

  it("explains expired, empty and garbage invites", () => {
    expect(() => parsePairingInvite(webInvite({ expiresAt: 1 }), 2)).toThrow(/expired/);
    expect(() => parsePairingInvite("   ")).toThrow(/Paste the invite/);
    expect(() => parsePairingInvite("hello world")).toThrow(
      /doesn't look like an InfiniBot invite/,
    );
    expect(() => parsePairingInvite(webInvite({ token: { nope: true } }), 2)).toThrow(
      /no usable token/,
    );
  });
});

describe("buildSatelliteConfig: the exact federation block a satellite runs with", () => {
  it("writes mode, master, token, name, share and label", () => {
    expect(
      buildSatelliteConfig({
        masterUrl: "192.168.1.20:18789",
        token: TOKEN,
        nodeName: "  Laptop  ",
        share: { terminals: true, coders: true, agents: false, compute: false, bogus: true },
        label: "Studio",
      }),
    ).toEqual({
      enabled: true,
      mode: "satellite",
      masterUrl: "ws://192.168.1.20:18789/federation",
      nodeName: "Laptop",
      share: { terminals: true, coders: true, agents: false, compute: false },
      authToken: TOKEN,
      label: "Studio",
    });
  });

  it("omits authToken and label when pairing an open master by address", () => {
    const cfg = buildSatelliteConfig({
      masterUrl: "ws://m:1",
      token: null,
      nodeName: "n",
      share: {},
    });
    expect(cfg).toEqual({
      enabled: true,
      mode: "satellite",
      masterUrl: "ws://m:1/federation",
      nodeName: "n",
      share: {},
    });
  });
});

describe("probeMaster against a real federation hub", () => {
  let server: http.Server;
  let hub: FederationHub;
  let url: string;

  beforeAll(async () => {
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    hub = new FederationHub({ httpServer: server, wsPath: "/federation", enableDiscovery: false });
    await hub.start();
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/federation`;
  });

  afterAll(async () => {
    await hub.stop().catch(() => undefined);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("succeeds with a token the hub signed, and the probe node is gone afterwards", async () => {
    const token = getFederationSecurity().createSatelliteToken(
      "sat-ok",
      DEFAULT_PERMISSIONS.full,
      1,
    );
    const res = await probeMaster(url, token, { timeoutMs: 5000 });
    expect(res).toMatchObject({ ok: true, masterUrl: url, permission: "full" });
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.getConnectedNodes().filter((n) => n.id.startsWith("setup-probe-"))).toEqual([]);
  });

  it("reports UNAUTHORIZED for a forged token", async () => {
    const res = await probeMaster(url, { ...TOKEN, signature: "forged" }, { timeoutMs: 5000 });
    expect(res).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });

  it("reports TOKEN_REQUIRED when no invite is given to a default (invite-only) master", async () => {
    const res = await probeMaster(url, null, { timeoutMs: 5000 });
    expect(res).toMatchObject({ ok: false, code: "TOKEN_REQUIRED" });
  });

  it("skips unreachable candidates and stops at the first master that answers", async () => {
    const token = getFederationSecurity().createSatelliteToken(
      "sat-ok2",
      DEFAULT_PERMISSIONS.full,
      1,
    );
    const res = await probeFirstReachable(["ws://127.0.0.1:1/federation", url], token, {
      timeoutMs: 3000,
    });
    expect(res.ok).toBe(true);
    expect(res.tried).toEqual(["ws://127.0.0.1:1/federation", url]);
  });
});
