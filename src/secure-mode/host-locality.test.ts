import { describe, expect, it } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { HostLocalityChecker } from "./host-locality.js";

const IFACES = {
  lo: [
    { address: "127.0.0.1", family: "IPv4" },
    { address: "::1", family: "IPv6" },
  ],
  docker0: [{ address: "172.17.0.1", family: "IPv4" }],
  "br-1d7d1863d2b7": [{ address: "172.22.0.1", family: "IPv4" }],
  tailscale0: [{ address: "100.64.0.1", family: "IPv4" }],
  wlo1: [
    { address: "192.168.1.13", family: "IPv4" },
    { address: "fe80::1c2b:3cff:fe4d:5e6f", family: "IPv6" },
  ],
} as never;

function checker(
  dns: Record<string, string[]> = {},
  opts: { now?: () => number; ifaces?: never } = {},
) {
  return new HostLocalityChecker({
    interfaces: () => opts.ifaces ?? IFACES,
    hostname: () => "my-host",
    lookup: async (h) => {
      const hit = dns[h];
      if (!hit) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" });
      return hit;
    },
    now: opts.now,
    ttlMs: 30_000,
    quarantineMs: 600_000,
  });
}

describe("host locality: addresses on this machine", () => {
  it("172.17.0.1 is local when docker0 has that address", async () => {
    const v = await checker().check("172.17.0.1");
    expect(v.local).toBe(true);
    expect(v.via).toBe("interface");
    expect(v.detail).toMatch(/docker0/);
    expect(checker().checkSync("172.17.0.1").local).toBe(true);
  });

  it("172.17.0.1 is NOT local when no interface has it (docker not installed)", async () => {
    const noDocker = { lo: [{ address: "127.0.0.1", family: "IPv4" }] } as never;
    const v = await checker({}, { ifaces: noDocker }).check("172.17.0.1");
    expect(v.local).toBe(false);
    expect(v.via).toBe("remote");
  });

  it.each(["127.0.0.1", "127.0.1.1", "::1", "[::1]", "localhost", "0.0.0.0"])(
    "%s is loopback",
    async (h) => {
      expect((await checker().check(h)).local).toBe(true);
    },
  );

  it.each([
    "172.22.0.1",
    "100.64.0.1",
    "192.168.1.13",
    "::ffff:172.17.0.1",
    "fe80::1c2b:3cff:fe4d:5e6f%wlo1",
  ])("%s (bound to a local interface) is local", async (h) => {
    expect((await checker().check(h)).local).toBe(true);
  });

  it.each(["10.0.0.5", "10.8.1.20", "100.101.102.103", "192.168.1.50", "172.17.0.2", "8.8.8.8"])(
    "unknown remote %s is blocked",
    async (h) => {
      const v = await checker().check(h);
      expect(v.local).toBe(false);
      expect(v.via).toBe("remote");
    },
  );

  it("another tailnet machine is allowed only when the owner allowlists it", async () => {
    const c = checker({ "gpu-box.tail1234.ts.net": ["100.70.1.2"] });
    expect((await c.check("100.70.1.2")).local).toBe(false);
    expect((await c.check("gpu-box.tail1234.ts.net")).local).toBe(false);
    const cfg = { secureMode: { allowedModelHosts: ["100.70.1.2"] } } as InfinibotConfig;
    expect((await c.check("100.70.1.2", cfg)).via).toBe("allowlist");
    // A name that resolves to an allowlisted IP is accepted too.
    expect((await c.check("gpu-box.tail1234.ts.net", cfg)).local).toBe(true);
    const byName = {
      secureMode: { allowedModelHosts: ["gpu-box.tail1234.ts.net"] },
    } as InfinibotConfig;
    expect((await c.check("GPU-BOX.tail1234.ts.net", byName)).local).toBe(true);
  });
});

describe("host locality: DNS names", () => {
  it("a name resolving to remote is blocked", async () => {
    const v = await checker({ "models.example.com": ["93.184.216.34"] }).check(
      "models.example.com",
    );
    expect(v.local).toBe(false);
    expect(v.detail).toMatch(/resolves to 93\.184\.216\.34/);
  });

  it("a name is local only when EVERY resolved address is local", async () => {
    const c = checker({ mixed: ["127.0.0.1", "93.184.216.34"], both: ["127.0.0.1", "172.17.0.1"] });
    expect((await c.check("mixed")).local).toBe(false);
    expect((await c.check("both")).local).toBe(true);
  });

  it("the host's own hostname is local (resolving or not)", async () => {
    expect((await checker().check("my-host")).local).toBe(true);
    expect((await checker({ "my-host": ["127.0.1.1"] }).check("my-host")).local).toBe(
      true,
    );
    // ... but not if DNS points it somewhere else.
    expect(
      (await checker({ "my-host": ["203.0.113.9"] }).check("my-host")).local,
    ).toBe(false);
  });

  it("host.docker.internal maps to docker0 when it has no DNS entry", async () => {
    const v = await checker().check("host.docker.internal");
    expect(v.local).toBe(true);
    expect(v.addresses).toEqual(["172.17.0.1"]);
    const remote = await checker({ "host.docker.internal": ["192.0.2.10"] }).check(
      "host.docker.internal",
    );
    expect(remote.local).toBe(false);
  });

  it("an unresolvable name fails closed", async () => {
    const v = await checker().check("nowhere.invalid");
    expect(v.local).toBe(false);
    expect(v.via).toBe("unresolved");
  });

  it("sync checks fail closed for names not resolved yet, then use the cache", async () => {
    const c = checker({ "vllm.lan": ["172.17.0.1"] });
    expect(c.checkSync("vllm.lan").local).toBe(false);
    await c.check("vllm.lan");
    expect(c.checkSync("vllm.lan").local).toBe(true);
  });

  it("DNS rebinding (local -> remote) is blocked and quarantined even if it flips back", async () => {
    let t = 1_000;
    const dns: Record<string, string[]> = { "llm.example": ["127.0.0.1"] };
    const c = checker(dns, { now: () => t });
    expect((await c.check("llm.example")).local).toBe(true);
    // Attacker flips the record to a remote address.
    dns["llm.example"] = ["203.0.113.66"];
    t += 31_000; // past the TTL -> re-resolved
    const flipped = await c.check("llm.example");
    expect(flipped.local).toBe(false);
    expect(flipped.via).toBe("rebinding");
    // Flips back to loopback: still blocked during the quarantine.
    dns["llm.example"] = ["127.0.0.1"];
    t += 31_000;
    const back = await c.check("llm.example");
    expect(back.local).toBe(false);
    expect(back.via).toBe("rebinding");
    expect(c.checkSync("llm.example").local).toBe(false);
    // After the quarantine it is judged on its (local) answer again.
    t += 600_000;
    expect((await c.check("llm.example")).local).toBe(true);
  });

  it("the periodic re-check catches a rebinding between runs", async () => {
    let t = 0;
    const dns: Record<string, string[]> = { "llm.example": ["172.17.0.1"] };
    const c = checker(dns, { now: () => t });
    expect((await c.check("llm.example")).local).toBe(true);
    dns["llm.example"] = ["198.51.100.7"];
    await c.recheckAll();
    // Within the TTL, the sync path now sees the quarantine.
    expect(c.checkSync("llm.example").local).toBe(false);
    c.dispose();
  });

  it("losing DNS resolution fails closed", async () => {
    let t = 0;
    const dns: Record<string, string[]> = { "llm.example": ["127.0.0.1"] };
    const c = checker(dns, { now: () => t });
    expect((await c.check("llm.example")).local).toBe(true);
    delete dns["llm.example"];
    t += 31_000;
    expect((await c.check("llm.example")).local).toBe(false);
    c.dispose();
  });
});
