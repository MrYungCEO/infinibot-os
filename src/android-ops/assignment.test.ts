/**
 * Assignment + stagger scheduling. The rules under test are the two that keep
 * a four-phone rack stable: never exceed the per-handset account density, and
 * never let two handsets publish into the same instant.
 */

import { describe, it, expect } from "vitest";
import {
  computeLoads,
  dailyWorkload,
  DEFAULT_DEVICE_GAP_MS,
  DEFAULT_RACK_GAP_MS,
  pickLeastLoadedDevice,
  staggerSchedule,
} from "./assignment.js";
import type { PhoneDevice, PostJob, SocialAccount } from "./types.js";

const NOW = 1_800_000_000_000;

function device(over: Partial<PhoneDevice> & { id: string; slot: number }): PhoneDevice {
  return {
    label: `Phone 0${over.slot}`,
    model: "Pixel 4a",
    androidVersion: "13",
    serial: `S${over.slot}`,
    androidId: null,
    status: "online",
    batteryPct: 90,
    charging: true,
    storageFreeMb: 32_000,
    storageTotalMb: 64_000,
    wifiSsid: "OPS-5G",
    wifiSignalDbm: -45,
    tailscaleIp: "100.0.0.1",
    tailscaleUp: true,
    adbState: "device",
    scrcpyState: "ready",
    lastHeartbeatAt: NOW,
    isSpare: false,
    appVersion: "1.0.0",
    updateChannel: "stable",
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function account(id: string, deviceId: string | null): SocialAccount {
  return {
    id,
    handle: id,
    platform: "instagram",
    displayName: id,
    deviceId,
    lifecycle: "active",
    sessionHealth: "healthy",
    twoFactorEnabled: true,
    twoFactorMethod: "authenticator",
    recoveryEmail: `${id}@recovery.example-ops.com`,
    recoveryCodesVaulted: true,
    secretRef: `vault://x/${id}`,
    lastPostAt: null,
    recoveryNotes: null,
    provisionedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function job(over: Partial<PostJob> & { id: string }): PostJob {
  return {
    mediaId: "media-1",
    accountId: "acct-1",
    deviceId: "dev-01",
    platform: "instagram",
    state: "SCHEDULED",
    caption: "",
    scheduledFor: NOW,
    dispatchedAt: null,
    preparedAt: null,
    postedAt: null,
    failedAt: null,
    attempt: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    lastError: null,
    actionRequired: null,
    bundleRef: null,
    permalink: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const RACK = [
  device({ id: "dev-01", slot: 1 }),
  device({ id: "dev-02", slot: 2 }),
  device({ id: "dev-03", slot: 3 }),
  device({ id: "dev-04", slot: 4 }),
  device({ id: "dev-05", slot: 5, isSpare: true, status: "spare" }),
];

describe("device load", () => {
  it("counts assigned accounts and reports utilization against the V1 density", () => {
    const accounts = [account("a1", "dev-01"), account("a2", "dev-01"), account("a3", "dev-02")];
    const loads = computeLoads(RACK, accounts);
    const first = loads.find((l) => l.deviceId === "dev-01")!;
    expect(first.accounts).toBe(2);
    expect(first.capacity).toBe(3);
    expect(first.utilization).toBeCloseTo(2 / 3);
    expect(first.eligible).toBe(true);
  });

  it("excludes a handset at capacity, offline, in maintenance, or held as a spare", () => {
    const full = [account("a1", "dev-01"), account("a2", "dev-01"), account("a3", "dev-01")];
    const rack = [
      RACK[0],
      device({ id: "dev-02", slot: 2, status: "offline" }),
      device({ id: "dev-03", slot: 3, status: "maintenance" }),
      RACK[4],
    ];
    const loads = computeLoads(rack, full);
    expect(loads.find((l) => l.deviceId === "dev-01")!.reason).toMatch(/at capacity/);
    expect(loads.find((l) => l.deviceId === "dev-02")!.reason).toMatch(/offline/);
    expect(loads.find((l) => l.deviceId === "dev-03")!.reason).toMatch(/maintenance/);
    expect(loads.find((l) => l.deviceId === "dev-05")!.reason).toMatch(/spare/);
    expect(loads.every((l) => !l.eligible)).toBe(true);
  });

  it("excludes a handset with no room to cache media", () => {
    const rack = [device({ id: "dev-01", slot: 1, storageFreeMb: 400 })];
    expect(computeLoads(rack, [])[0].reason).toMatch(/storage/);
  });

  it("ignores retired accounts when counting density", () => {
    const accounts = [
      account("a1", "dev-01"),
      { ...account("a2", "dev-01"), lifecycle: "retired" as const },
    ];
    expect(computeLoads(RACK, accounts).find((l) => l.deviceId === "dev-01")!.accounts).toBe(1);
  });
});

describe("least-loaded assignment", () => {
  it("picks the emptiest eligible handset", () => {
    const accounts = [account("a1", "dev-01"), account("a2", "dev-01"), account("a3", "dev-02")];
    expect(pickLeastLoadedDevice(RACK, accounts).device?.id).toBe("dev-03");
  });

  it("breaks ties by active job count, then by rack slot — deterministically", () => {
    const jobs = [job({ id: "j1", deviceId: "dev-01" }), job({ id: "j2", deviceId: "dev-02" })];
    const pick = pickLeastLoadedDevice(RACK, [], jobs);
    expect(pick.device?.id).toBe("dev-03");
    // Same inputs, same answer — assignment must be stable across calls.
    expect(pickLeastLoadedDevice(RACK, [], jobs).device?.id).toBe("dev-03");
  });

  it("explains itself when the whole rack is full instead of assigning anyway", () => {
    const accounts = RACK.filter((d) => !d.isSpare).flatMap((d) => [
      account(`${d.id}-a`, d.id),
      account(`${d.id}-b`, d.id),
      account(`${d.id}-c`, d.id),
    ]);
    const pick = pickLeastLoadedDevice(RACK, accounts);
    expect(pick.device).toBeNull();
    expect(pick.reason).toMatch(/no eligible handset/);
  });

  it("can fall back to the spare when a rack failover is explicitly allowed", () => {
    const accounts = RACK.filter((d) => !d.isSpare).flatMap((d) => [
      account(`${d.id}-a`, d.id),
      account(`${d.id}-b`, d.id),
      account(`${d.id}-c`, d.id),
    ]);
    expect(pickLeastLoadedDevice(RACK, accounts, [], { includeSpares: true }).device?.id).toBe(
      "dev-05",
    );
  });

  it("honours a raised density for the V1.5 stage", () => {
    const accounts = [account("a1", "dev-01"), account("a2", "dev-01"), account("a3", "dev-01")];
    expect(pickLeastLoadedDevice([RACK[0]], accounts).device).toBeNull();
    expect(
      pickLeastLoadedDevice([RACK[0]], accounts, [], { maxAccountsPerDevice: 5 }).device?.id,
    ).toBe("dev-01");
  });
});

describe("stagger scheduling", () => {
  it("spreads simultaneous requests so no two land in the same rack window", () => {
    const results = staggerSchedule([
      { key: "a", deviceId: "dev-01", preferredAt: NOW },
      { key: "b", deviceId: "dev-02", preferredAt: NOW },
      { key: "c", deviceId: "dev-03", preferredAt: NOW },
      { key: "d", deviceId: "dev-04", preferredAt: NOW },
    ]);

    const times = results.map((r) => r.scheduledFor).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(DEFAULT_RACK_GAP_MS);
    }
    expect(results[0].shiftedByMs).toBe(0);
  });

  it("keeps a wider gap between two jobs on the same handset", () => {
    const results = staggerSchedule([
      { key: "a", deviceId: "dev-01", preferredAt: NOW },
      { key: "b", deviceId: "dev-01", preferredAt: NOW },
    ]);
    expect(results[1].scheduledFor - results[0].scheduledFor).toBeGreaterThanOrEqual(
      DEFAULT_DEVICE_GAP_MS,
    );
  });

  it("respects jobs that are already on the calendar", () => {
    const results = staggerSchedule([{ key: "a", deviceId: "dev-01", preferredAt: NOW }], {
      existing: [{ deviceId: "dev-01", scheduledFor: NOW }],
    });
    expect(results[0].scheduledFor).toBeGreaterThanOrEqual(NOW + DEFAULT_DEVICE_GAP_MS);
    expect(results[0].shiftedByMs).toBeGreaterThan(0);
  });

  it("preserves the operator's intended order", () => {
    const results = staggerSchedule([
      { key: "late", deviceId: "dev-01", preferredAt: NOW + 60_000 },
      { key: "early", deviceId: "dev-02", preferredAt: NOW },
    ]);
    expect(results.map((r) => r.key)).toEqual(["early", "late"]);
  });

  it("never moves a request earlier than requested", () => {
    const results = staggerSchedule(
      Array.from({ length: 8 }, (_, i) => ({
        key: `k${i}`,
        deviceId: `dev-0${(i % 4) + 1}`,
        preferredAt: NOW,
      })),
    );
    for (const r of results) expect(r.scheduledFor).toBeGreaterThanOrEqual(NOW);
  });
});

describe("daily workload", () => {
  it("buckets by UTC day and splits per handset and outcome", () => {
    const day = 86_400_000;
    const jobs = [
      job({ id: "j1", scheduledFor: NOW, deviceId: "dev-01", state: "POSTED" }),
      job({ id: "j2", scheduledFor: NOW + 1000, deviceId: "dev-02", state: "FAILED" }),
      job({ id: "j3", scheduledFor: NOW + day, deviceId: "dev-01", state: "ACTION_REQUIRED" }),
    ];
    const buckets = dailyWorkload(jobs, 3, NOW);
    expect(buckets).toHaveLength(3);
    expect(buckets[0].total).toBe(2);
    expect(buckets[0].posted).toBe(1);
    expect(buckets[0].failed).toBe(1);
    expect(buckets[0].perDevice["dev-01"]).toBe(1);
    expect(buckets[1].actionRequired).toBe(1);
    expect(buckets[2].total).toBe(0);
  });
});
