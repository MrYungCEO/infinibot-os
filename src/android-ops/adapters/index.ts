/**
 * Adapter selection.
 *
 * The rule from §7: real tooling when it's present, an honest null adapter
 * when it isn't. Selection happens once at service construction and can be
 * re-run from the Ops surface ("Re-probe adapters") after plugging in a rack.
 */

import { join } from "node:path";
import { AdbDeviceAdapter } from "./adb.js";
import { NullDeviceAdapter, NullStreamAdapter } from "./null-device.js";
import { ScrcpyStreamAdapter } from "./scrcpy.js";
import { createStorageAdapter } from "./storage.js";
import type { AdapterSet, AdapterStatus } from "./types.js";
import { enrichedPathEnv, resolveBin } from "../../agents/coder-backend/bin-detect.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export * from "./types.js";
export { AdbDeviceAdapter } from "./adb.js";
export { NullDeviceAdapter, NullStreamAdapter } from "./null-device.js";
export { ScrcpyStreamAdapter } from "./scrcpy.js";
export { LocalStorageAdapter, S3StorageAdapter, createStorageAdapter } from "./storage.js";

export async function createAdapterSet(stateDir: string): Promise<AdapterSet> {
  const bundleDir = join(stateDir, "android-ops", "bundles");

  const adb = new AdbDeviceAdapter(bundleDir);
  const adbProbe = await adb.probe();
  const device = adbProbe.available ? adb : new NullDeviceAdapter(adbProbe.reason ?? undefined);

  const scrcpy = new ScrcpyStreamAdapter();
  const scrcpyProbe = await scrcpy.probe();
  const stream = scrcpyProbe.available
    ? scrcpy
    : new NullStreamAdapter(scrcpyProbe.reason ?? undefined);

  return { device, stream, storage: createStorageAdapter(stateDir) };
}

/**
 * Tailscale is the management network in §6 — not something we drive, but the
 * operator needs to know whether the private path is up before blaming a
 * handset for being unreachable.
 */
export async function probeTailscale() {
  const now = Date.now();
  const bin = resolveBin("tailscale");
  if (!bin) {
    return {
      available: false,
      version: null,
      binPath: null,
      reason:
        "tailscale not found on PATH — devices must be reachable on the local network instead",
      checkedAt: now,
    };
  }
  try {
    const { stdout } = await execFileAsync(bin, ["status", "--json"], {
      env: enrichedPathEnv(),
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { BackendState?: string; Self?: { HostName?: string } };
    const up = parsed.BackendState === "Running";
    return {
      available: up,
      version: parsed.Self?.HostName ? `tailnet as ${parsed.Self.HostName}` : "tailscale",
      binPath: bin,
      reason: up ? null : `backend state is ${parsed.BackendState ?? "unknown"}`,
      checkedAt: now,
    };
  } catch (e) {
    return { available: false, version: null, binPath: bin, reason: String(e), checkedAt: now };
  }
}

/** One machine on the tailnet, as far as the fleet reconciler cares. */
export interface TailscaleNode {
  hostname: string;
  dnsName: string | null;
  ip: string | null;
  os: string | null;
  online: boolean;
  self: boolean;
}

interface RawTailscaleNode {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  OS?: string;
  Online?: boolean;
}

/**
 * Enumerate the tailnet so a registered handset can be matched to its private
 * address, and so an Android node nobody has registered yet can be *offered*
 * to the operator. Discovery only — nothing here changes the tailnet.
 */
export async function listTailscaleNodes(): Promise<{
  ok: boolean;
  reason: string | null;
  nodes: TailscaleNode[];
}> {
  const bin = resolveBin("tailscale");
  if (!bin) return { ok: false, reason: "tailscale not found on PATH", nodes: [] };
  try {
    const { stdout } = await execFileAsync(bin, ["status", "--json"], {
      env: enrichedPathEnv(),
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as {
      Self?: RawTailscaleNode;
      Peer?: Record<string, RawTailscaleNode>;
    };
    const map = (raw: RawTailscaleNode | undefined, self: boolean): TailscaleNode | null => {
      if (!raw?.HostName) return null;
      return {
        hostname: raw.HostName,
        dnsName: raw.DNSName?.replace(/\.$/, "") ?? null,
        ip: raw.TailscaleIPs?.find((a) => a.includes(".")) ?? null,
        os: raw.OS ?? null,
        online: self ? true : Boolean(raw.Online),
        self,
      };
    };
    const nodes = [
      map(parsed.Self, true),
      ...Object.values(parsed.Peer ?? {}).map((p) => map(p, false)),
    ].filter((n): n is TailscaleNode => n !== null);
    return { ok: true, reason: null, nodes };
  } catch (e) {
    return { ok: false, reason: String(e instanceof Error ? e.message : e), nodes: [] };
  }
}

export async function describeAdapters(set: AdapterSet): Promise<AdapterStatus> {
  const [device, stream, storage, tailscale] = await Promise.all([
    set.device.probe(),
    set.stream.probe(),
    set.storage.probe(),
    probeTailscale(),
  ]);
  return {
    device: { ...device, kind: set.device.kind },
    stream: { ...stream, kind: set.stream.kind },
    storage: { ...storage, backend: set.storage.backend },
    tailscale,
  };
}
