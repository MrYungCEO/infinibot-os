/**
 * The communication profile, channel bindings and execution profile must reach
 * the running employee — otherwise they are inert metadata. These tests assert
 * they show up in the composed prompt and in the spawn call.
 *
 * The coder backend is always a `vi.fn` stub; nothing here launches a CLI.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkItemExecutor,
  composeWorkItemPrompt,
  createWorkItemExecutorConfig,
  type CoderSpawnFn,
  type WorkItemExecutorConfig,
} from "./executor.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { WorkforceStore } from "./store.js";
import type { EmployeeWorkItem, Worker } from "./types.js";

const AGENCY = "agency-1";
// 2026-07-06 is a Monday.
const MONDAY_10_00_UTC = Date.UTC(2026, 6, 6, 10, 0);
const MONDAY_03_00_UTC = Date.UTC(2026, 6, 6, 3, 0);

let tempDir: string;
let workforce: WorkforceStore;
let operating: WorkforceOperatingStore;

function makeWorker(overrides: Partial<Worker> & { id: string }): Worker {
  return workforce.createWorker(
    {
      id: overrides.id,
      agencyId: AGENCY,
      type: "ai",
      displayName: overrides.displayName ?? "Mercury",
      title: overrides.title ?? "CMO",
      employmentStatus: "active",
      employmentType: "agent",
      agentId: overrides.id,
      modelBinding: overrides.modelBinding ?? "codex",
      persona: "Runs demand generation.",
      goals: ["Grow qualified pipeline"],
      kpis: ["MQL volume"],
      autonomyLevel: overrides.autonomyLevel ?? 3,
      approvalThreshold: 500,
      communicationCadence: overrides.communicationCadence ?? "Daily async update",
      capabilities: ["campaign-ops"],
    },
    "tester",
  );
}

function stageWorkItem(workerId: string, extra: Record<string, unknown> = {}): EmployeeWorkItem {
  const item = operating.enqueueWorkItem(AGENCY, {
    workerId,
    title: "Draft the launch note",
    instructions: "Write the announcement.",
    ...extra,
  });
  return operating.transitionWorkItem(AGENCY, item.id, "accepted");
}

function enabledConfig(overrides: Partial<WorkItemExecutorConfig> = {}): WorkItemExecutorConfig {
  return { ...createWorkItemExecutorConfig({ executeWorkItems: true }), ...overrides };
}

const okSpawn = (): CoderSpawnFn => vi.fn(async () => ({ output: "done", exitCode: 0 }));

function makeExecutor(config: WorkItemExecutorConfig, spawn: CoderSpawnFn, extra = {}) {
  return new WorkItemExecutor({
    operatingStore: operating,
    workerStore: workforce,
    config,
    workspaceRoot: tempDir,
    spawn,
    readSop: () => null,
    directoryExists: () => false,
    now: () => MONDAY_10_00_UTC,
    ...extra,
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wf-exec-comms-"));
  const dbPath = join(tempDir, "agency.db");
  workforce = new WorkforceStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
});

afterEach(() => {
  operating.close();
  workforce.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("composeWorkItemPrompt — communication profile", () => {
  it("includes the profile migrated from the legacy cadence when none is stored", () => {
    const worker = makeWorker({ id: "mercury", communicationCadence: "Weekly board memo 08:30" });
    const item = stageWorkItem("mercury");
    const prompt = composeWorkItemPrompt({
      worker,
      item,
      terminalStatus: "completed",
      now: MONDAY_10_00_UTC,
    });
    expect(prompt).toContain("## How you communicate");
    expect(prompt).toContain("Standing report: weekly at 08:30");
    // The operator's own words reach the employee.
    expect(prompt).toContain("Weekly board memo 08:30");
  });

  it("reflects a stored profile's tone and verbosity", () => {
    makeWorker({ id: "mercury" });
    workforce.setCommunicationProfile(AGENCY, "mercury", {
      tone: "blunt",
      verbosity: "terse",
      signOff: "— M",
    });
    const worker = workforce.getWorker(AGENCY, "mercury")!;
    const prompt = composeWorkItemPrompt({
      worker,
      item: stageWorkItem("mercury"),
      terminalStatus: "completed",
      now: MONDAY_10_00_UTC,
    });
    expect(prompt).toContain("Tone: blunt");
    expect(prompt).toContain("Verbosity: terse");
    expect(prompt).toContain("— M");
  });

  it("renders per-channel overrides alongside the bound channels", () => {
    makeWorker({ id: "mercury" });
    workforce.setCommunicationProfile(AGENCY, "mercury", {
      channelOverrides: [{ channelId: "slack", verbosity: "terse", maxMessageChars: 300 }],
    });
    const binding = workforce.upsertChannelBinding(AGENCY, {
      workerId: "mercury",
      channelId: "slack",
      target: "C0123",
      handle: "@mercury",
    });
    const prompt = composeWorkItemPrompt({
      worker: workforce.getWorker(AGENCY, "mercury")!,
      item: stageWorkItem("mercury"),
      terminalStatus: "completed",
      channelBindings: [binding],
      now: MONDAY_10_00_UTC,
    });
    expect(prompt).toContain("## Where you are reachable");
    expect(prompt).toContain("- slack (C0123) as @mercury — both");
    expect(prompt).toContain("On slack:");
    expect(prompt).toContain("max 300 chars");
  });

  it("omits disabled bindings from the reachability section", () => {
    const worker = makeWorker({ id: "mercury" });
    const binding = workforce.upsertChannelBinding(AGENCY, {
      workerId: "mercury",
      channelId: "telegram",
      enabled: false,
    });
    const prompt = composeWorkItemPrompt({
      worker,
      item: stageWorkItem("mercury"),
      terminalStatus: "completed",
      channelBindings: [binding],
      now: MONDAY_10_00_UTC,
    });
    expect(prompt).not.toContain("## Where you are reachable");
  });

  it("states the shift position, on and off the clock", () => {
    makeWorker({ id: "mercury" });
    const schedule = operating.createSchedule(AGENCY, {
      workerId: "mercury",
      timezone: "UTC",
      weekdays: [1, 2, 3, 4, 5],
      shiftStart: "09:00",
      shiftEnd: "17:00",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      enabled: true,
    });
    const worker = workforce.getWorker(AGENCY, "mercury")!;
    const item = stageWorkItem("mercury");

    const onShift = composeWorkItemPrompt({
      worker,
      item,
      terminalStatus: "completed",
      schedules: [schedule],
      now: MONDAY_10_00_UTC,
    });
    expect(onShift).toContain("You are on shift right now.");

    const offShift = composeWorkItemPrompt({
      worker,
      item,
      terminalStatus: "completed",
      schedules: [schedule],
      now: MONDAY_03_00_UTC,
    });
    expect(offShift).toContain("OUTSIDE your rostered working hours");
    expect(offShift).toContain("hold non-urgent outbound messages");
  });

  it("lets an urgent card bypass the out-of-hours hold", () => {
    makeWorker({ id: "mercury" });
    const schedule = operating.createSchedule(AGENCY, {
      workerId: "mercury",
      timezone: "UTC",
      weekdays: [1, 2, 3, 4, 5],
      shiftStart: "09:00",
      shiftEnd: "17:00",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      enabled: true,
    });
    const prompt = composeWorkItemPrompt({
      worker: workforce.getWorker(AGENCY, "mercury")!,
      item: stageWorkItem("mercury", { priority: "urgent" }),
      terminalStatus: "completed",
      schedules: [schedule],
      now: MONDAY_03_00_UTC,
    });
    expect(prompt).toContain("latency and working-hours policy bypassed");
    expect(prompt).not.toContain("hold non-urgent outbound messages");
  });

  it("states the tool boundary only when one is configured", () => {
    makeWorker({ id: "mercury" });
    const item = stageWorkItem("mercury");
    expect(
      composeWorkItemPrompt({
        worker: workforce.getWorker(AGENCY, "mercury")!,
        item,
        terminalStatus: "completed",
        now: MONDAY_10_00_UTC,
      }),
    ).not.toContain("## Tool policy");

    workforce.setExecutionProfile(AGENCY, "mercury", {
      toolAllowlist: ["Read", "Write"],
      toolDenylist: ["Bash"],
    });
    const restricted = composeWorkItemPrompt({
      worker: workforce.getWorker(AGENCY, "mercury")!,
      item,
      terminalStatus: "completed",
      now: MONDAY_10_00_UTC,
    });
    expect(restricted).toContain("## Tool policy");
    expect(restricted).toContain("only use these tools/capabilities: Read, Write");
    expect(restricted).toContain("must NOT use: Bash");
  });
});

describe("WorkItemExecutor — profile-driven execution", () => {
  it("feeds the profile and bindings into the real spawn prompt", async () => {
    makeWorker({ id: "mercury", modelBinding: "claude" });
    workforce.setCommunicationProfile(AGENCY, "mercury", { tone: "friendly", verbosity: "terse" });
    workforce.upsertChannelBinding(AGENCY, {
      workerId: "mercury",
      channelId: "slack",
      target: "C0123",
    });
    const item = stageWorkItem("mercury");
    const spawn = okSpawn();

    await makeExecutor(enabledConfig(), spawn).executeOne(AGENCY, item);

    expect(spawn).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(spawn).mock.calls[0]![0].prompt;
    expect(prompt).toContain("Tone: friendly");
    expect(prompt).toContain("- slack (C0123)");
    expect(prompt).toContain("## Timing");
  });

  it("uses the per-worker timeout instead of the global one", async () => {
    makeWorker({ id: "mercury", modelBinding: "claude" });
    workforce.setExecutionProfile(AGENCY, "mercury", { timeoutMinutes: 42 });
    const item = stageWorkItem("mercury");
    const spawn = okSpawn();

    await makeExecutor(enabledConfig({ timeoutMinutes: 20 }), spawn).executeOne(AGENCY, item);
    expect(vi.mocked(spawn).mock.calls[0]![0].timeoutMinutes).toBe(42);
  });

  it("inherits the global timeout when the worker sets none", async () => {
    makeWorker({ id: "mercury", modelBinding: "claude" });
    const item = stageWorkItem("mercury");
    const spawn = okSpawn();

    await makeExecutor(enabledConfig({ timeoutMinutes: 17 }), spawn).executeOne(AGENCY, item);
    expect(vi.mocked(spawn).mock.calls[0]![0].timeoutMinutes).toBe(17);
  });

  it("retries on the worker's own fallback backend when the bound one fails", async () => {
    // Exactly the live problem: a worker pinned to `codex`, which exits 1.
    makeWorker({ id: "dev", modelBinding: "codex" });
    workforce.setExecutionProfile(AGENCY, "dev", { fallbackModelBinding: "claude" });
    const item = stageWorkItem("dev");

    const spawn: CoderSpawnFn = vi.fn(async (request) =>
      request.backend === "codex"
        ? { output: "usage limit", exitCode: 1 }
        : { output: "recovered", exitCode: 0 },
    );

    const result = await makeExecutor(
      // No fleet-wide fallback: the retry must come from the worker's profile.
      enabledConfig({ fallbackBackend: undefined }),
      spawn,
    ).executeOne(AGENCY, item);

    expect(vi.mocked(spawn).mock.calls.map((call) => call[0].backend)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(result.outcome).toBe("completed");
    expect(result.backend).toBe("claude-code");
  });

  it("escalates rather than looping when the fallback resolves to the primary", async () => {
    makeWorker({ id: "dev", modelBinding: "codex" });
    workforce.setExecutionProfile(AGENCY, "dev", { fallbackModelBinding: "codex" });
    const item = stageWorkItem("dev");
    const spawn: CoderSpawnFn = vi.fn(async () => ({ output: "boom", exitCode: 1 }));

    const result = await makeExecutor(
      enabledConfig({ fallbackBackend: undefined }),
      spawn,
    ).executeOne(AGENCY, item);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("escalated");
  });

  it("prefers the worker's fallback over the fleet-wide one", async () => {
    makeWorker({ id: "dev", modelBinding: "codex" });
    workforce.setExecutionProfile(AGENCY, "dev", { fallbackModelBinding: "gemini" });
    const item = stageWorkItem("dev");
    const spawn: CoderSpawnFn = vi.fn(async (request) =>
      request.backend === "codex" ? { output: "nope", exitCode: 1 } : { output: "ok", exitCode: 0 },
    );

    await makeExecutor(enabledConfig({ fallbackBackend: "claude-code" }), spawn).executeOne(
      AGENCY,
      item,
    );
    expect(vi.mocked(spawn).mock.calls[1]![0].backend).toBe("gemini");
  });

  it("still uses the fleet fallback when the worker declares none", async () => {
    makeWorker({ id: "dev", modelBinding: "codex" });
    const item = stageWorkItem("dev");
    const spawn: CoderSpawnFn = vi.fn(async (request) =>
      request.backend === "codex" ? { output: "nope", exitCode: 1 } : { output: "ok", exitCode: 0 },
    );

    await makeExecutor(enabledConfig({ fallbackBackend: "claude-code" }), spawn).executeOne(
      AGENCY,
      item,
    );
    expect(vi.mocked(spawn).mock.calls[1]![0].backend).toBe("claude-code");
  });
});
