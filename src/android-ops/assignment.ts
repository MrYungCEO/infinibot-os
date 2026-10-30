/**
 * Android Social Ops — device assignment and stagger scheduling.
 *
 * Two rules from the plan drive everything here:
 *
 *  §2  "3 accounts per phone; 4-5 only after stability testing" — density is a
 *      policy knob, not a hardcoded constant, so V1.5 can raise it.
 *  §4  "Stagger uploads across phones" — four handsets on one Wi-Fi uplink
 *      publishing at the same instant is the easy way to make a reliable
 *      system look flaky, so schedules get spread deterministically.
 *
 * Pure functions, no I/O — the service layer supplies the rows.
 */

import type { PhoneDevice, PostJob, SocialAccount } from "./types.js";

/** V1 launch density. Raise only after the stability gate in §8. */
export const DEFAULT_MAX_ACCOUNTS_PER_DEVICE = 3;

/** Minimum spacing between two jobs on the *same* handset. */
export const DEFAULT_DEVICE_GAP_MS = 12 * 60_000;

/** Minimum spacing between any two jobs across the whole rack. */
export const DEFAULT_RACK_GAP_MS = 3 * 60_000;

export interface DeviceLoad {
  deviceId: string;
  label: string;
  slot: number;
  accounts: number;
  activeJobs: number;
  capacity: number;
  /** 0..1 — accounts against capacity. */
  utilization: number;
  eligible: boolean;
  reason: string | null;
}

export interface LoadOptions {
  maxAccountsPerDevice?: number;
  /** Allow assigning to devices currently in maintenance. Off by default. */
  includeMaintenance?: boolean;
  /** Allow the configured spare to take accounts (rack failover). */
  includeSpares?: boolean;
}

function eligibility(
  device: PhoneDevice,
  accounts: number,
  capacity: number,
  opts: LoadOptions,
): { eligible: boolean; reason: string | null } {
  if (device.isSpare && !opts.includeSpares)
    return { eligible: false, reason: "spare device held in reserve" };
  if (device.status === "maintenance" && !opts.includeMaintenance) {
    return { eligible: false, reason: "device is in maintenance" };
  }
  if (device.status === "offline") return { eligible: false, reason: "device is offline" };
  if (accounts >= capacity)
    return { eligible: false, reason: `at capacity (${accounts}/${capacity})` };
  if (device.storageFreeMb < 1024) return { eligible: false, reason: "insufficient free storage" };
  return { eligible: true, reason: null };
}

/** Per-device load table — powers both auto-assignment and the fleet UI. */
export function computeLoads(
  devices: PhoneDevice[],
  accounts: SocialAccount[],
  jobs: PostJob[] = [],
  opts: LoadOptions = {},
): DeviceLoad[] {
  const capacity = opts.maxAccountsPerDevice ?? DEFAULT_MAX_ACCOUNTS_PER_DEVICE;
  const activeStates = new Set(["SCHEDULED", "DISPATCHED", "PREPARED", "ACTION_REQUIRED"]);

  return devices
    .map((device) => {
      const assigned = accounts.filter(
        (a) => a.deviceId === device.id && a.lifecycle !== "retired",
      ).length;
      const activeJobs = jobs.filter(
        (j) => j.deviceId === device.id && activeStates.has(j.state),
      ).length;
      const { eligible, reason } = eligibility(device, assigned, capacity, opts);
      return {
        deviceId: device.id,
        label: device.label,
        slot: device.slot,
        accounts: assigned,
        activeJobs,
        capacity,
        utilization: capacity > 0 ? Math.min(1, assigned / capacity) : 1,
        eligible,
        reason,
      };
    })
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Least-loaded eligible handset, ties broken by fewest active jobs then by
 * rack slot so the result is deterministic (important: assignment is written
 * into an account record that should stay stable).
 */
export function pickLeastLoadedDevice(
  devices: PhoneDevice[],
  accounts: SocialAccount[],
  jobs: PostJob[] = [],
  opts: LoadOptions = {},
): { device: PhoneDevice | null; load: DeviceLoad | null; reason: string } {
  const loads = computeLoads(devices, accounts, jobs, opts);
  const eligible = loads.filter((l) => l.eligible);
  if (eligible.length === 0) {
    const capacity = opts.maxAccountsPerDevice ?? DEFAULT_MAX_ACCOUNTS_PER_DEVICE;
    return {
      device: null,
      load: null,
      reason:
        loads.length === 0
          ? "no devices registered"
          : `no eligible handset — every device is at capacity (${capacity}/phone), offline or reserved`,
    };
  }
  eligible.sort(
    (a, b) => a.accounts - b.accounts || a.activeJobs - b.activeJobs || a.slot - b.slot,
  );
  const winner = eligible[0];
  const device = devices.find((d) => d.id === winner.deviceId) ?? null;
  return {
    device,
    load: winner,
    reason: `${winner.label} — ${winner.accounts}/${winner.capacity} accounts, ${winner.activeJobs} active jobs`,
  };
}

export interface StaggerRequest {
  /** Stable key echoed back on the result (usually an accountId). */
  key: string;
  deviceId: string | null;
  preferredAt: number;
}

export interface StaggerResult extends StaggerRequest {
  scheduledFor: number;
  /** Milliseconds the request was pushed back, if any. */
  shiftedByMs: number;
}

export interface StaggerOptions {
  deviceGapMs?: number;
  rackGapMs?: number;
  /** Existing scheduled jobs to avoid colliding with. */
  existing?: Array<{ deviceId: string | null; scheduledFor: number }>;
}

/**
 * Push each request forward to the earliest slot that respects both the
 * per-device and rack-wide gaps. Order is preserved (stable sort on the
 * preferred time) so an operator's intended sequence survives.
 */
export function staggerSchedule(
  requests: StaggerRequest[],
  opts: StaggerOptions = {},
): StaggerResult[] {
  const deviceGap = opts.deviceGapMs ?? DEFAULT_DEVICE_GAP_MS;
  const rackGap = opts.rackGapMs ?? DEFAULT_RACK_GAP_MS;

  const perDevice = new Map<string, number[]>();
  const rack: number[] = [];
  for (const job of opts.existing ?? []) {
    const key = job.deviceId ?? "__unassigned__";
    if (!perDevice.has(key)) perDevice.set(key, []);
    perDevice.get(key)!.push(job.scheduledFor);
    rack.push(job.scheduledFor);
  }

  const ordered = requests
    .map((r, index) => ({ r, index }))
    .sort((a, b) => a.r.preferredAt - b.r.preferredAt || a.index - b.index);

  const results: StaggerResult[] = [];
  for (const { r } of ordered) {
    const key = r.deviceId ?? "__unassigned__";
    const deviceTimes = perDevice.get(key) ?? [];
    let at = r.preferredAt;

    // Walk forward until the slot clears both constraints. Bounded by the
    // number of already-placed jobs, so it always terminates.
    for (let guard = 0; guard <= deviceTimes.length + rack.length + 1; guard++) {
      const deviceClash = deviceTimes.find((t) => Math.abs(t - at) < deviceGap);
      if (deviceClash !== undefined) {
        at = deviceClash + deviceGap;
        continue;
      }
      const rackClash = rack.find((t) => Math.abs(t - at) < rackGap);
      if (rackClash !== undefined) {
        at = rackClash + rackGap;
        continue;
      }
      break;
    }

    deviceTimes.push(at);
    perDevice.set(key, deviceTimes);
    rack.push(at);
    results.push({ ...r, scheduledFor: at, shiftedByMs: at - r.preferredAt });
  }

  return results.sort((a, b) => a.scheduledFor - b.scheduledFor);
}

export interface WorkloadBucket {
  /** `YYYY-MM-DD` in the caller's locale-free UTC framing. */
  day: string;
  total: number;
  posted: number;
  failed: number;
  actionRequired: number;
  perDevice: Record<string, number>;
}

/** Daily posting workload — feeds the calendar's density strip. */
export function dailyWorkload(jobs: PostJob[], days = 7, from = Date.now()): WorkloadBucket[] {
  const start = startOfUtcDay(from);
  const buckets: WorkloadBucket[] = [];
  for (let i = 0; i < days; i++) {
    const dayStart = start + i * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const inDay = jobs.filter((j) => j.scheduledFor >= dayStart && j.scheduledFor < dayEnd);
    const perDevice: Record<string, number> = {};
    for (const job of inDay) {
      const key = job.deviceId ?? "unassigned";
      perDevice[key] = (perDevice[key] ?? 0) + 1;
    }
    buckets.push({
      day: new Date(dayStart).toISOString().slice(0, 10),
      total: inDay.length,
      posted: inDay.filter((j) => j.state === "POSTED").length,
      failed: inDay.filter((j) => j.state === "FAILED").length,
      actionRequired: inDay.filter((j) => j.state === "ACTION_REQUIRED").length,
      perDevice,
    });
  }
  return buckets;
}

export function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
