/**
 * Secure Mode: is a model endpoint's host on THIS machine?
 *
 * A host is local when every address it resolves to is
 *   - loopback (127/8, ::1), or
 *   - bound to one of this machine's network interfaces (docker0 / br-*,
 *     tailscale0, the LAN NIC…) — a vLLM container published on the Docker
 *     bridge gateway (172.17.0.1) is still this machine.
 * The machine's own hostname and `host.docker.internal` resolve like any other
 * name; when they do not resolve at all they fall back to this machine's own
 * addresses (loopback / the docker0 gateway).
 *
 * Hostnames are resolved with DNS and EVERY resolved address must be local.
 * Results are cached for a short TTL and re-resolved periodically. When a
 * name that was local starts resolving to a non-local address (DNS
 * rebinding), the host is quarantined: it stays blocked for a cool-down even
 * if it flips back, so a flip-flopping resolver cannot win a race.
 *
 * Anything else (another tailnet machine, a LAN box, a cloud API) is remote
 * unless the owner lists it in `secureMode.allowedModelHosts` (or the older
 * `secureMode.localHosts`).
 */

import dns from "node:dns/promises";
import net from "node:net";
import os from "node:os";

import type { InfinibotConfig } from "../config/config.js";
import { coerceString } from "../shared/text/coerce.js";

export type HostLocalityVia =
  | "loopback"
  | "interface"
  | "allowlist"
  | "remote"
  | "unresolved"
  | "rebinding";

export interface HostVerdict {
  local: boolean;
  host: string;
  addresses: string[];
  via: HostLocalityVia;
  /** Human-readable detail for errors / the UI. */
  detail: string;
}

export interface HostLocalityDeps {
  /** Resolve a hostname to every address (A + AAAA). */
  lookup?: (host: string) => Promise<string[]>;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  hostname?: () => string;
  now?: () => number;
  /** How long a DNS answer is trusted before it is re-resolved (ms). */
  ttlMs?: number;
  /** How long a host stays blocked after its DNS answer changed to remote (ms). */
  quarantineMs?: number;
}

const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const DOCKER_HOST_NAMES = new Set(["host.docker.internal", "gateway.docker.internal"]);

export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".") && h.length > 1) h = h.slice(0, -1);
  return h;
}

/** Strip IPv6 zone ids and unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4). */
export function normalizeAddress(addr: string): string {
  let a = normalizeHost(addr);
  const pct = a.indexOf("%");
  if (pct >= 0) a = a.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1] as string;
  return a;
}

export function isLoopbackAddress(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (net.isIPv4(a)) return a.startsWith("127.") || a === "0.0.0.0";
  if (net.isIPv6(a)) return a === "::1" || a === "::";
  return false;
}

function defaultLookup(host: string): Promise<string[]> {
  return dns.lookup(host, { all: true, verbatim: true }).then((rows) => rows.map((r) => r.address));
}

type CacheEntry = { addresses: string[]; at: number };

export class HostLocalityChecker {
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private readonly hostname: () => string;
  private readonly now: () => number;
  readonly ttlMs: number;
  readonly quarantineMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly quarantine = new Map<string, { until: number; detail: string }>();
  private readonly inflight = new Map<string, Promise<string[] | null>>();
  private recheckTimer: NodeJS.Timeout | null = null;

  constructor(deps: HostLocalityDeps = {}) {
    this.lookup = deps.lookup ?? defaultLookup;
    this.interfaces = deps.interfaces ?? os.networkInterfaces;
    this.hostname = deps.hostname ?? os.hostname;
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 30_000;
    this.quarantineMs = deps.quarantineMs ?? 10 * 60_000;
  }

  /** Every address bound to a local interface, plus the interface it is on. */
  localAddresses(): Map<string, string> {
    const out = new Map<string, string>();
    let ifs: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
    try {
      ifs = this.interfaces() ?? {};
    } catch {
      ifs = {};
    }
    for (const [name, rows] of Object.entries(ifs)) {
      for (const row of rows ?? []) {
        if (row?.address) out.set(normalizeAddress(row.address), name);
      }
    }
    return out;
  }

  private allowlist(cfg?: InfinibotConfig): Set<string> {
    const sm = cfg?.secureMode as
      | { allowedModelHosts?: unknown[]; localHosts?: unknown[] }
      | undefined;
    const out = new Set<string>();
    for (const h of [...(sm?.allowedModelHosts ?? []), ...(sm?.localHosts ?? [])]) {
      const n = normalizeHost(coerceString(h));
      if (n) out.add(n);
    }
    return out;
  }

  /** Classify a set of concrete addresses (no DNS). */
  private classifyAddresses(host: string, addresses: string[], allow: Set<string>): HostVerdict {
    if (addresses.length === 0) {
      return {
        local: false,
        host,
        addresses,
        via: "unresolved",
        detail: `${host} did not resolve`,
      };
    }
    const ifs = this.localAddresses();
    let via: HostLocalityVia = "loopback";
    for (const raw of addresses) {
      const a = normalizeAddress(raw);
      if (isLoopbackAddress(a)) continue;
      if (ifs.has(a)) {
        if (via === "loopback") via = "interface";
        continue;
      }
      if (allow.has(a)) {
        via = "allowlist";
        continue;
      }
      return {
        local: false,
        host,
        addresses,
        via: "remote",
        detail:
          a === host
            ? `${host} is not an address of this machine`
            : `${host} resolves to ${a}, which is not an address of this machine`,
      };
    }
    const onIf = addresses.map(normalizeAddress).find((a) => ifs.has(a));
    const ifName = via === "interface" && onIf ? ifs.get(onIf) : undefined;
    return {
      local: true,
      host,
      addresses,
      via,
      detail:
        via === "loopback"
          ? `${host} is loopback`
          : via === "interface"
            ? `${host} is bound to this machine${ifName ? ` (${ifName})` : ""}`
            : `${host} is allowlisted in secureMode.allowedModelHosts`,
    };
  }

  /** Addresses this machine answers on when a "self" name does not resolve. */
  private selfFallback(host: string): string[] | null {
    if (LOOPBACK_NAMES.has(host) || host.endsWith(".localhost")) return ["127.0.0.1"];
    if (host === normalizeHost(this.hostname())) return ["127.0.0.1"];
    if (DOCKER_HOST_NAMES.has(host)) {
      // On the host itself the name usually has no DNS entry; inside Docker it
      // maps to the bridge gateway, which is docker0 on this machine.
      const docker = (this.interfaces() ?? {}).docker0?.find((r) => r.family === "IPv4");
      return docker ? [docker.address] : null;
    }
    return null;
  }

  /** Synchronous verdict: IP literals and fresh cache only; unknown names fail closed. */
  checkSync(rawHost: string, cfg?: InfinibotConfig): HostVerdict {
    const host = normalizeHost(rawHost);
    const allow = this.allowlist(cfg);
    if (allow.has(host)) return this.allowVerdict(host);
    if (net.isIP(normalizeAddress(host))) return this.classifyAddresses(host, [host], allow);
    const q = this.quarantined(host);
    if (q) return q;
    const hit = this.cache.get(host);
    if (hit && this.now() - hit.at <= this.ttlMs) {
      return this.classifyAddresses(host, hit.addresses, allow);
    }
    const self = this.selfFallback(host);
    if (self && LOOPBACK_NAMES.has(host)) return this.classifyAddresses(host, self, allow);
    return {
      local: false,
      host,
      addresses: [],
      via: "unresolved",
      detail: `${host} has not been verified yet`,
    };
  }

  /** Resolve (with cache) and classify. Never throws. */
  async check(rawHost: string, cfg?: InfinibotConfig): Promise<HostVerdict> {
    const host = normalizeHost(rawHost);
    const allow = this.allowlist(cfg);
    if (allow.has(host)) return this.allowVerdict(host);
    if (net.isIP(normalizeAddress(host))) return this.classifyAddresses(host, [host], allow);
    const hit = this.cache.get(host);
    const fresh = hit && this.now() - hit.at <= this.ttlMs;
    if (!fresh) await this.resolve(host);
    const q = this.quarantined(host);
    if (q) return q;
    const entry = this.cache.get(host);
    if (!entry) {
      return {
        local: false,
        host,
        addresses: [],
        via: "unresolved",
        detail: `${host} did not resolve`,
      };
    }
    this.ensureRecheckTimer();
    return this.classifyAddresses(host, entry.addresses, allow);
  }

  private allowVerdict(host: string): HostVerdict {
    return {
      local: true,
      host,
      addresses: [],
      via: "allowlist",
      detail: `${host} is allowlisted in secureMode.allowedModelHosts`,
    };
  }

  private quarantined(host: string): HostVerdict | null {
    const q = this.quarantine.get(host);
    if (!q) return null;
    if (this.now() >= q.until) {
      this.quarantine.delete(host);
      return null;
    }
    return {
      local: false,
      host,
      addresses: this.cache.get(host)?.addresses ?? [],
      via: "rebinding",
      detail: q.detail,
    };
  }

  /**
   * Re-resolve a hostname and update the cache. A local → non-local change
   * quarantines the host (fail closed).
   */
  async resolve(host: string): Promise<string[] | null> {
    const pending = this.inflight.get(host);
    if (pending) return pending;
    const run = (async () => {
      let addresses: string[] | null = null;
      try {
        addresses = (await this.lookup(host)).map(normalizeAddress).filter(Boolean);
        if (addresses.length === 0) addresses = null;
      } catch {
        addresses = null;
      }
      if (!addresses) addresses = this.selfFallback(host);
      const prev = this.cache.get(host);
      if (!addresses) {
        // Lost resolution: forget the old answer so the host fails closed.
        this.cache.delete(host);
        return null;
      }
      if (prev && !sameSet(prev.addresses, addresses)) {
        const allow = new Set<string>();
        const before = this.classifyAddresses(host, prev.addresses, allow);
        const after = this.classifyAddresses(host, addresses, allow);
        if (before.local && !after.local) {
          this.quarantine.set(host, {
            until: this.now() + this.quarantineMs,
            detail: `${host} changed from ${prev.addresses.join(", ")} to ${addresses.join(
              ", ",
            )} (possible DNS rebinding); Secure Mode blocks it for ${Math.round(
              this.quarantineMs / 60_000,
            )} min`,
          });
        }
      }
      this.cache.set(host, { addresses, at: this.now() });
      return addresses;
    })();
    this.inflight.set(host, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(host);
    }
  }

  /** Re-resolve every cached hostname (the periodic re-check). */
  async recheckAll(): Promise<void> {
    await Promise.all([...this.cache.keys()].map((h) => this.resolve(h)));
  }

  private ensureRecheckTimer(): void {
    if (this.recheckTimer || this.ttlMs <= 0) return;
    this.recheckTimer = setInterval(() => {
      void this.recheckAll().catch(() => {});
    }, this.ttlMs);
    this.recheckTimer.unref?.();
  }

  dispose(): void {
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    this.recheckTimer = null;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

let shared: HostLocalityChecker | null = null;

export function getHostLocalityChecker(): HostLocalityChecker {
  if (!shared) shared = new HostLocalityChecker();
  return shared;
}

/** Tests only. */
export function setHostLocalityCheckerForTests(checker: HostLocalityChecker | null): void {
  shared?.dispose();
  shared = checker;
}
