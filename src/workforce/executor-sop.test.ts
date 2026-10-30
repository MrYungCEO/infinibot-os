/**
 * The executor must prefer a STORED SOP over the worker's `sopPath` on disk,
 * and fall back to disk when the work item has no SOP link.
 *
 * Every spawn here is a stub. Nothing in this file may ever launch a real
 * coder CLI.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WorkItemExecutor,
  createWorkItemExecutorConfig,
  resolveStoredSopForItem,
  type CoderSpawnFn,
} from "./executor.js";
import { WorkforceOperatingStore } from "./operating-store.js";
import { attachSopSchedule, runSopOnce } from "./sop-service.js";
import { WorkforceSopStore } from "./sop-store.js";
import { WorkforceStore } from "./store.js";

const AGENCY = "agency-1";
const WORKER = "agency-1:ai:coder";
const DISK_SOP = "SOP FROM DISK: follow agents/coder.yaml.";

let tempDir: string;
let workforce: WorkforceStore;
let operating: WorkforceOperatingStore;
let sopStore: WorkforceSopStore;

/** Captures the prompt instead of running anything. */
function capturingSpawn(): { spawn: CoderSpawnFn; prompts: string[] } {
  const prompts: string[] = [];
  const spawn: CoderSpawnFn = vi.fn(async (request) => {
    prompts.push(request.prompt);
    return { output: "ok", exitCode: 0 };
  });
  return { spawn, prompts };
}

function makeExecutor(spawn: CoderSpawnFn, withSopStore = true) {
  return new WorkItemExecutor({
    operatingStore: operating,
    workerStore: workforce,
    sopStore: withSopStore ? sopStore : null,
    config: createWorkItemExecutorConfig({ executeWorkItems: true }),
    workspaceRoot: tempDir,
    spawn,
    readSop: () => DISK_SOP,
    directoryExists: () => false,
  });
}

function makeStoredSop() {
  return sopStore.createSop(AGENCY, {
    slug: "backend-automation-health-check",
    name: "Backend and automation health check",
    summary: "Verify the jobs the agency depends on actually ran.",
    ownerWorkerId: WORKER,
    steps: [
      {
        title: "Verify every scheduled job ran",
        instruction: "A silent job counts as FAILED, not as healthy.",
        expectedOutput: "Per-job status.",
      },
    ],
    acceptanceCriteria: ["Every enabled job has an explicit status"],
  });
}

/** Enqueue and stage a card, exactly as a human moving it would. */
function stage(extra: Record<string, unknown> = {}) {
  const item = operating.enqueueWorkItem(AGENCY, {
    workerId: WORKER,
    title: "Run the health check",
    instructions: "Do the sweep.",
    ...extra,
  });
  return operating.transitionWorkItem(AGENCY, item.id, "accepted");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "wf-exec-sop-"));
  const dbPath = join(tempDir, "agency.db");
  workforce = new WorkforceStore(dbPath);
  operating = new WorkforceOperatingStore(dbPath);
  sopStore = new WorkforceSopStore(dbPath);
  workforce.createWorker(
    {
      id: WORKER,
      agencyId: AGENCY,
      type: "ai",
      displayName: "Dev",
      title: "Back End Developer",
      employmentType: "agent",
      agentId: "coder",
      modelBinding: "codex",
      autonomyLevel: 3,
      sopPath: "agents/coder.yaml",
    },
    "tester",
  );
});

afterEach(() => {
  sopStore.close();
  operating.close();
  workforce.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveStoredSopForItem", () => {
  it("resolves by context.sopId", () => {
    const sop = makeStoredSop();
    const resolved = resolveStoredSopForItem(sopStore, AGENCY, {
      context: { sopId: sop.id },
      responsibilityId: null,
    });
    expect(resolved?.id).toBe(sop.id);
  });

  it("falls back to context.sopSlug", () => {
    const sop = makeStoredSop();
    const resolved = resolveStoredSopForItem(sopStore, AGENCY, {
      context: { sopId: "stale-id", sopSlug: sop.slug },
      responsibilityId: null,
    });
    expect(resolved?.id).toBe(sop.id);
  });

  it("follows the responsibility -> schedule -> SOP link", async () => {
    const sop = makeStoredSop();
    const attached = await attachSopSchedule(
      { sopStore, operatingStore: operating, cron: null, workerStore: workforce },
      AGENCY,
      { sopId: sop.id, workerId: WORKER, cadence: "daily", runAt: "06:00" },
    );
    const resolved = resolveStoredSopForItem(sopStore, AGENCY, {
      context: {},
      responsibilityId: attached.responsibility.id,
    });
    expect(resolved?.id).toBe(sop.id);
  });

  it("returns null when the item has no SOP link at all", () => {
    makeStoredSop();
    expect(
      resolveStoredSopForItem(sopStore, AGENCY, { context: {}, responsibilityId: null }),
    ).toBeNull();
  });
});

describe("WorkItemExecutor SOP resolution", () => {
  it("prefers the STORED SOP over the file on disk", async () => {
    const sop = makeStoredSop();
    const { spawn, prompts } = capturingSpawn();
    const item = stage({ context: { sopId: sop.id } });

    const result = await makeExecutor(spawn).executeOne(AGENCY, item);
    expect(result.outcome).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("## Standard operating procedure");
    expect(prompts[0]).toContain("Backend and automation health check (v1)");
    expect(prompts[0]).toContain("A silent job counts as FAILED");
    expect(prompts[0]).not.toContain(DISK_SOP);
  });

  it("uses the SOP a scheduled responsibility points at", async () => {
    const sop = makeStoredSop();
    const attached = await attachSopSchedule(
      { sopStore, operatingStore: operating, cron: null, workerStore: workforce },
      AGENCY,
      { sopId: sop.id, workerId: WORKER, cadence: "daily", runAt: "06:00" },
    );
    // Generated by the loop, then staged by a human. Context deliberately
    // stripped so only the responsibility link can resolve it.
    const generated = operating.enqueueWorkItem(AGENCY, {
      workerId: WORKER,
      responsibilityId: attached.responsibility.id,
      title: sop.name,
      context: {},
    });
    const staged = operating.transitionWorkItem(AGENCY, generated.id, "accepted");

    const { spawn, prompts } = capturingSpawn();
    await makeExecutor(spawn).executeOne(AGENCY, staged);
    expect(prompts[0]).toContain("Backend and automation health check (v1)");
    expect(prompts[0]).not.toContain(DISK_SOP);
  });

  it("picks up an edited SOP's new version on the next run", async () => {
    const sop = makeStoredSop();
    sopStore.updateSop(AGENCY, sop.id, {
      steps: [{ title: "Rewritten", instruction: "The operator rewrote this procedure entirely." }],
    });

    const { spawn, prompts } = capturingSpawn();
    await makeExecutor(spawn).executeOne(AGENCY, stage({ context: { sopId: sop.id } }));
    expect(prompts[0]).toContain("(v2)");
    expect(prompts[0]).toContain("The operator rewrote this procedure entirely.");
  });

  it("falls back to the disk SOP when the item links to no stored SOP", async () => {
    makeStoredSop();
    const { spawn, prompts } = capturingSpawn();
    await makeExecutor(spawn).executeOne(AGENCY, stage());
    expect(prompts[0]).toContain(DISK_SOP);
  });

  it("falls back to disk when no SOP store is wired in at all", async () => {
    const sop = makeStoredSop();
    const { spawn, prompts } = capturingSpawn();
    await makeExecutor(spawn, false).executeOne(AGENCY, stage({ context: { sopId: sop.id } }));
    expect(prompts[0]).toContain(DISK_SOP);
  });

  it("never executes a one-off SOP run until a human stages it", async () => {
    const sop = makeStoredSop();
    const { spawn } = capturingSpawn();
    const { workItem } = runSopOnce(
      { sopStore, operatingStore: operating, cron: null, workerStore: workforce },
      AGENCY,
      { sopId: sop.id },
    );
    expect(workItem.status).toBe("queued");

    const pass = await makeExecutor(spawn).executeStagedWorkItems(AGENCY);
    expect(pass.considered).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });
});
