/**
 * Android Social Ops — dashboard derivations.
 *
 * Pure functions over the store's rows. Kept separate from `service.ts` so the
 * numbers on the operator's first screen — which is where trust in the whole
 * system is won or lost — can be unit-tested without a database or a rack.
 */

import { computeLoads, dailyWorkload, type DeviceLoad, type WorkloadBucket } from "./assignment.js";
import { nextOperatorAction } from "./provisioning.js";
import type {
  InboxItem,
  OpsAlert,
  PhoneDevice,
  PostJob,
  ProvisioningRun,
  SocialAccount,
} from "./types.js";

/** A handset counts as offline once it misses this much of the heartbeat window. */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

export interface DeviceRollup {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  maintenance: number;
  spares: number;
  /** Handsets whose last heartbeat is older than the stale window. */
  stale: number;
  lowBattery: number;
  lowStorage: number;
}

export interface AccountRollup {
  total: number;
  active: number;
  actionRequired: number;
  paused: number;
  recovery: number;
  provisioning: number;
  sessionHealthy: number;
  sessionStale: number;
  loggedOut: number;
  twoFactorGaps: number;
  unvaultedRecoveryCodes: number;
  unassigned: number;
}

export interface JobRollup {
  draft: number;
  scheduled: number;
  dispatched: number;
  prepared: number;
  actionRequired: number;
  posted: number;
  failed: number;
  /** Scheduled and already past due. */
  overdue: number;
  dueNextHour: number;
  postedToday: number;
  retryPending: number;
}

/** One row in the ACTION REQUIRED list — the thing an operator opens first. */
export interface UrgentItem {
  id: string;
  kind: "job" | "account" | "device" | "provisioning" | "alert";
  severity: "critical" | "warning";
  title: string;
  detail: string;
  subjectId: string;
  at: number;
  /** Which UI section resolves it. */
  section: "jobs" | "accounts" | "fleet" | "provisioning" | "ops";
}

export interface DashboardSummary {
  generatedAt: number;
  devices: DeviceRollup;
  accounts: AccountRollup;
  jobs: JobRollup;
  loads: DeviceLoad[];
  workload: WorkloadBucket[];
  urgent: UrgentItem[];
  openAlerts: number;
  inboxNew: number;
  /** Posted ÷ (posted + failed) over the last 7 days, or null with no history. */
  successRate7d: number | null;
}

export function rollupDevices(devices: PhoneDevice[], now: number): DeviceRollup {
  const active = devices.filter((d) => !d.isSpare);
  return {
    total: active.length,
    online: active.filter((d) => d.status === "online").length,
    degraded: active.filter((d) => d.status === "degraded").length,
    offline: active.filter((d) => d.status === "offline").length,
    maintenance: active.filter((d) => d.status === "maintenance").length,
    spares: devices.filter((d) => d.isSpare).length,
    stale: active.filter((d) => !d.lastHeartbeatAt || now - d.lastHeartbeatAt > HEARTBEAT_STALE_MS)
      .length,
    lowBattery: active.filter((d) => d.batteryPct < 25 && !d.charging).length,
    lowStorage: active.filter((d) => d.storageFreeMb < 4096).length,
  };
}

export function rollupAccounts(accounts: SocialAccount[]): AccountRollup {
  const live = accounts.filter((a) => a.lifecycle !== "retired");
  return {
    total: live.length,
    active: live.filter((a) => a.lifecycle === "active").length,
    actionRequired: live.filter((a) => a.lifecycle === "action_required").length,
    paused: live.filter((a) => a.lifecycle === "paused").length,
    recovery: live.filter((a) => a.lifecycle === "recovery").length,
    provisioning: live.filter((a) => a.lifecycle === "provisioning").length,
    sessionHealthy: live.filter((a) => a.sessionHealth === "healthy").length,
    sessionStale: live.filter((a) => a.sessionHealth === "stale").length,
    loggedOut: live.filter((a) => a.sessionHealth === "logged_out").length,
    twoFactorGaps: live.filter((a) => !a.twoFactorEnabled || a.twoFactorMethod === "sms").length,
    unvaultedRecoveryCodes: live.filter((a) => a.twoFactorEnabled && !a.recoveryCodesVaulted)
      .length,
    unassigned: live.filter((a) => !a.deviceId).length,
  };
}

export function rollupJobs(jobs: PostJob[], now: number): JobRollup {
  const dayStart = now - 24 * 3_600_000;
  const by = (state: PostJob["state"]) => jobs.filter((j) => j.state === state).length;
  return {
    draft: by("DRAFT"),
    scheduled: by("SCHEDULED"),
    dispatched: by("DISPATCHED"),
    prepared: by("PREPARED"),
    actionRequired: by("ACTION_REQUIRED"),
    posted: by("POSTED"),
    failed: by("FAILED"),
    overdue: jobs.filter((j) => j.state === "SCHEDULED" && j.scheduledFor < now).length,
    dueNextHour: jobs.filter(
      (j) => j.state === "SCHEDULED" && j.scheduledFor >= now && j.scheduledFor < now + 3_600_000,
    ).length,
    postedToday: jobs.filter((j) => j.state === "POSTED" && (j.postedAt ?? 0) >= dayStart).length,
    retryPending: jobs.filter((j) => j.state === "FAILED" && j.nextRetryAt !== null).length,
  };
}

/**
 * The urgent queue. Ordered by severity then recency, because an operator
 * glancing at this screen should be able to work strictly top-down.
 */
export function collectUrgent(
  jobs: PostJob[],
  accounts: SocialAccount[],
  devices: PhoneDevice[],
  provisioning: ProvisioningRun[],
  alerts: OpsAlert[],
  now: number,
): UrgentItem[] {
  const items: UrgentItem[] = [];
  const accountLabel = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `@${a.handle} · ${a.platform}` : id;
  };

  for (const job of jobs) {
    if (job.state === "ACTION_REQUIRED" && job.actionRequired) {
      items.push({
        id: `job:${job.id}`,
        kind: "job",
        severity: "critical",
        title: `${accountLabel(job.accountId)} — ${job.actionRequired.kind.replace(/_/g, " ")}`,
        detail: job.actionRequired.message,
        subjectId: job.id,
        at: job.actionRequired.raisedAt,
        section: "jobs",
      });
    } else if (job.state === "FAILED" && job.attempt >= job.maxAttempts) {
      items.push({
        id: `job:${job.id}`,
        kind: "job",
        severity: "critical",
        title: `${accountLabel(job.accountId)} — retries exhausted`,
        detail: job.lastError ?? "Job failed and has no retry budget left.",
        subjectId: job.id,
        at: job.failedAt ?? job.updatedAt,
        section: "jobs",
      });
    } else if (job.state === "SCHEDULED" && job.scheduledFor < now - 15 * 60_000) {
      items.push({
        id: `job:${job.id}`,
        kind: "job",
        severity: "warning",
        title: `${accountLabel(job.accountId)} — overdue`,
        detail: `Scheduled ${Math.round((now - job.scheduledFor) / 60_000)} minutes ago and still not dispatched.`,
        subjectId: job.id,
        at: job.scheduledFor,
        section: "jobs",
      });
    }
  }

  for (const account of accounts) {
    if (account.sessionHealth === "logged_out") {
      items.push({
        id: `account:${account.id}`,
        kind: "account",
        severity: "critical",
        title: `@${account.handle} signed out`,
        detail:
          "The app session ended. An operator must sign in on the assigned handset and re-trust the device.",
        subjectId: account.id,
        at: account.updatedAt,
        section: "accounts",
      });
    } else if (account.twoFactorEnabled && !account.recoveryCodesVaulted) {
      items.push({
        id: `account:${account.id}:codes`,
        kind: "account",
        severity: "warning",
        title: `@${account.handle} — recovery codes not vaulted`,
        detail: "2FA is on but the recovery codes were never stored. Account ownership is at risk.",
        subjectId: account.id,
        at: account.updatedAt,
        section: "accounts",
      });
    } else if (!account.deviceId && account.lifecycle !== "retired") {
      items.push({
        id: `account:${account.id}:device`,
        kind: "account",
        severity: "warning",
        title: `@${account.handle} — no assigned handset`,
        detail: "Every account needs a stable device assignment before it can be scheduled.",
        subjectId: account.id,
        at: account.updatedAt,
        section: "accounts",
      });
    }
  }

  for (const device of devices) {
    if (device.isSpare) continue;
    if (
      device.status === "offline" ||
      (device.lastHeartbeatAt && now - device.lastHeartbeatAt > HEARTBEAT_STALE_MS)
    ) {
      items.push({
        id: `device:${device.id}`,
        kind: "device",
        severity: device.status === "offline" ? "critical" : "warning",
        title: `${device.label} is not reporting`,
        detail: device.lastHeartbeatAt
          ? `Last heartbeat ${Math.round((now - device.lastHeartbeatAt) / 60_000)} minutes ago.`
          : "No heartbeat has ever been received from this handset.",
        subjectId: device.id,
        at: device.lastHeartbeatAt ?? device.updatedAt,
        section: "fleet",
      });
    } else if (device.storageFreeMb < 4096) {
      items.push({
        id: `device:${device.id}:storage`,
        kind: "device",
        severity: "warning",
        title: `${device.label} is low on storage`,
        detail: `${(device.storageFreeMb / 1024).toFixed(1)} GB free — media cache cleanup is overdue.`,
        subjectId: device.id,
        at: device.updatedAt,
        section: "fleet",
      });
    }
  }

  for (const run of provisioning) {
    const step = nextOperatorAction(run);
    if (!step) continue;
    items.push({
      id: `prov:${run.id}`,
      kind: "provisioning",
      severity: "warning",
      title: `Provisioning @${run.handle} — ${step.label}`,
      detail: step.note ?? "Waiting on an operator to complete this step on the device.",
      subjectId: run.id,
      at: run.startedAt,
      section: "provisioning",
    });
  }

  for (const alert of alerts) {
    if (alert.acknowledgedAt) continue;
    if (alert.severity === "info") continue;
    items.push({
      id: `alert:${alert.id}`,
      kind: "alert",
      severity: alert.severity === "critical" ? "critical" : "warning",
      title: alert.message,
      detail: `${alert.kind} · ${alert.subjectType} ${alert.subjectId}`,
      subjectId: alert.id,
      at: alert.at,
      section: "ops",
    });
  }

  const weight = (s: UrgentItem["severity"]) => (s === "critical" ? 0 : 1);
  return items.sort((a, b) => weight(a.severity) - weight(b.severity) || b.at - a.at).slice(0, 40);
}

export function buildDashboard(input: {
  devices: PhoneDevice[];
  accounts: SocialAccount[];
  jobs: PostJob[];
  provisioning: ProvisioningRun[];
  alerts: OpsAlert[];
  inbox: InboxItem[];
  now: number;
}): DashboardSummary {
  const { devices, accounts, jobs, provisioning, alerts, inbox, now } = input;
  const weekAgo = now - 7 * 86_400_000;
  const recent = jobs.filter((j) => (j.postedAt ?? j.failedAt ?? 0) >= weekAgo);
  const posted = recent.filter((j) => j.state === "POSTED").length;
  const failed = recent.filter((j) => j.state === "FAILED").length;

  return {
    generatedAt: now,
    devices: rollupDevices(devices, now),
    accounts: rollupAccounts(accounts),
    jobs: rollupJobs(jobs, now),
    loads: computeLoads(devices, accounts, jobs),
    workload: dailyWorkload(jobs, 7, now),
    urgent: collectUrgent(jobs, accounts, devices, provisioning, alerts, now),
    openAlerts: alerts.filter((a) => !a.acknowledgedAt).length,
    inboxNew: inbox.filter((i) => i.status === "new").length,
    successRate7d: posted + failed > 0 ? posted / (posted + failed) : null,
  };
}
