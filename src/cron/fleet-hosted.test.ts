import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nextScheduledWakeMs,
  platformSeededJobNames,
  removePlatformSeededJobs,
  ScheduleReporter,
  watchForResume,
} from "./fleet-hosted.js";
import { CronService } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { toText } from "../utils/to-text.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cron-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function service(over: Partial<CronServiceDeps> = {}) {
  const ran: string[] = [];
  const cron = new CronService({
    storePath: path.join(dir, "jobs.json"),
    cronEnabled: true,
    log: quietLog,
    enqueueSystemEvent: () => {},
    requestHeartbeatNow: () => {},
    runIsolatedAgentJob: async ({ job }) => {
      ran.push(job.name);
      return { status: "ok" };
    },
    ...over,
  });
  return { cron, ran };
}

describe("platform-seeded jobs on a tenant Machine", () => {
  it("covers the proactive / oversight / report / loop seeds", () => {
    const names = platformSeededJobNames();
    for (const n of [
      "heartbeat-proactive",
      "autonomy-queue-poll",
      "proactive-daily-brief",
      "oversight-pulse",
      "ceo-hourly-insights",
      "agency-operating-loop",
      "project-summary-daily",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("removes them and keeps every tenant-created job", async () => {
    const { cron } = service();
    await cron.start();
    await cron.add({
      name: "heartbeat-proactive",
      enabled: true,
      schedule: { kind: "every", everyMs: 15 * 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "x" },
    });
    await cron.add({
      name: "my weekly report",
      enabled: true,
      schedule: { kind: "every", everyMs: 7 * 24 * 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "write it" },
    });
    expect(await removePlatformSeededJobs(cron)).toEqual(["heartbeat-proactive"]);
    expect((await cron.list({ includeDisabled: true })).map((j) => j.name)).toEqual([
      "my weekly report",
    ]);
    cron.stop();
  });
});

describe("cron catch-up (wake-mode Machine booted at its job's due time)", () => {
  async function seedMissed(now: number, missedBy: number) {
    const { cron } = service({ nowMs: () => now - 3_600_000 + 1_234_567 }); // slots never land on `now`
    await cron.start();
    await cron.add({
      name: "hourly",
      enabled: true,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "go" },
    });
    cron.stop();
    // Persist a next run that the (suspended) Machine missed by `missedBy`, as a
    // fresh file: the cron store is cached per path within a process.
    const store = JSON.parse(fs.readFileSync(path.join(dir, "jobs.json"), "utf8"));
    store.jobs[0].state = { nextRunAtMs: now - missedBy };
    fs.writeFileSync(path.join(dir, "booted.json"), JSON.stringify(store));
  }
  const booted = () => path.join(dir, "booted.json");

  it("runs a slot missed while booting when catch-up is on", async () => {
    const now = Date.parse("2026-10-01T09:00:40Z");
    await seedMissed(now, 40_000);
    const { cron, ran } = service({
      storePath: booted(),
      nowMs: () => now,
      catchUpMissedMs: 6 * 3_600_000,
    });
    await cron.start();
    await vi.waitFor(() => expect(ran).toEqual(["hourly"]));
    cron.stop();
  });

  it("skips it without catch-up (the local behaviour is unchanged)", async () => {
    const now = Date.parse("2026-10-01T09:00:40Z");
    await seedMissed(now, 40_000);
    const { cron, ran } = service({ storePath: booted(), nowMs: () => now });
    await cron.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
    expect((await cron.status()).nextWakeAtMs).toBeGreaterThan(now);
    cron.stop();
  });

  it("never replays a slot older than the window", async () => {
    const now = Date.parse("2026-10-01T09:00:40Z");
    await seedMissed(now, 7 * 3_600_000);
    const { cron, ran } = service({
      storePath: booted(),
      nowMs: () => now,
      catchUpMissedMs: 6 * 3_600_000,
    });
    await cron.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toEqual([]);
    cron.stop();
  });
});

describe("ScheduleReporter", () => {
  it("reports the next due job with the tenant token, only when it changes, retrying failures", async () => {
    let next: number | null = 1_700_000_000_000;
    const bodies: unknown[] = [];
    let fail = true;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://orch.example.com/fleet/schedule");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (fail) {
        fail = false;
        return new Response("", { status: 503 });
      }
      bodies.push(JSON.parse(toText(init.body)));
      return new Response("{}", { status: 200 });
    });
    const r = new ScheduleReporter({
      nextWakeAtMs: async () => next,
      orchestratorUrl: "https://orch.example.com",
      token: "tok",
      tenantId: "tenant-1",
      fetch,
      retryMs: 1,
    });
    await r.flush(); // 503 → retry scheduled
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ tenantId: "tenant-1", nextWakeAtMs: next });
    await r.flush(); // unchanged → no request
    expect(bodies).toHaveLength(1);
    next = null; // last job removed
    await r.flush();
    expect(bodies[1]).toEqual({ tenantId: "tenant-1", nextWakeAtMs: null });
    r.stop();
  });
});

describe("nextScheduledWakeMs", () => {
  it("takes the earliest of cron jobs and enabled scheduled agent tasks", async () => {
    const cron = {
      status: async () => ({ enabled: true, storePath: "", jobs: 1, nextWakeAtMs: 5_000 }),
    };
    const tasks = async () => [
      { enabled: true, nextRunAt: 3_000 },
      { enabled: false, nextRunAt: 1_000 },
      { enabled: true, nextRunAt: null },
    ];
    expect(await nextScheduledWakeMs(cron, tasks, [])).toBe(3_000);
    const none = {
      status: async () => ({ enabled: true, storePath: "", jobs: 0, nextWakeAtMs: null }),
    };
    expect(await nextScheduledWakeMs(none, async () => [], [])).toBeNull();
    expect(
      await nextScheduledWakeMs(cron, async () => {
        throw new Error("no store");
      }, []),
    ).toBe(5_000);
  });

  it("counts extra sources (Lead Autopilot) and ignores a failing one", async () => {
    const none = {
      status: async () => ({ enabled: true, storePath: "", jobs: 0, nextWakeAtMs: null }),
    };
    const autopilot = async () => 2_000;
    const broken = async () => {
      throw new Error("hub db locked");
    };
    expect(await nextScheduledWakeMs(none, async () => [], [autopilot, broken])).toBe(2_000);
    expect(await nextScheduledWakeMs(none, async () => [], [async () => null])).toBeNull();
  });

  it("autopilot wakes nothing while the Business & Agency plugin is not loaded", async () => {
    const { autopilotNextWakeMs } = await import("./fleet-hosted.js");
    expect(await autopilotNextWakeMs()).toBeNull();
  });
});

describe("watchForResume", () => {
  it("fires when wall time jumps past monotonic time (VM resumed from suspend)", () => {
    vi.useFakeTimers();
    let wall = 0;
    let mono = 0;
    const resumed: number[] = [];
    const stop = watchForResume((gap) => resumed.push(gap), {
      tickMs: 1_000,
      wall: () => wall,
      mono: () => mono,
    });
    wall += 1_000;
    mono += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(resumed).toEqual([]);
    wall += 3_600_000 + 1_000; // an hour frozen: monotonic barely moved
    mono += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(resumed).toEqual([3_600_000]);
    stop();
  });
});
