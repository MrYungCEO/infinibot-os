import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkforceStore } from "../workforce/store.js";
import { seedAgencyAiWorkforce } from "./seed-workforce.js";

describe("seedAgencyAiWorkforce", () => {
  let directory: string;
  let store: WorkforceStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agency-ai-workforce-"));
    store = new WorkforceStore(join(directory, "agency.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("provisions the six production roles and safely reconciles them again", () => {
    const first = seedAgencyAiWorkforce(store, "agency-a", "owner-a");
    const second = seedAgencyAiWorkforce(store, "agency-a", "owner-a");
    const workers = store.listWorkers("agency-a", { type: "ai" });

    expect(first).toEqual({ created: 6, existing: 0, adopted: 0 });
    expect(second).toEqual({ created: 0, existing: 6, adopted: 0 });
    expect(workers).toHaveLength(6);
    expect(workers.map((worker) => worker.agentId).sort()).toEqual([
      "ceo",
      "coder",
      "development-head",
      "marketing-studio",
      "pm",
      "web-builder",
    ]);
  });

  it("gives every role a model binding, persona, goals, KPIs and capabilities", () => {
    seedAgencyAiWorkforce(store, "agency-a", "owner-a");
    for (const worker of store.listWorkers("agency-a", { type: "ai" })) {
      expect(worker.modelBinding).toBeTruthy();
      expect(worker.persona).toBeTruthy();
      expect(worker.goals.length).toBeGreaterThan(0);
      expect(worker.kpis.length).toBeGreaterThan(0);
      expect(worker.capabilities.length).toBeGreaterThan(0);
      expect(worker.skills.length).toBeGreaterThan(0);
      expect(worker.sopPath).toBeTruthy();
      expect(worker.workspacePath).toBeTruthy();
      expect(worker.communicationCadence).toBeTruthy();
    }
  });

  it("wires the manager hierarchy: CEO on top, devs under the development head", () => {
    seedAgencyAiWorkforce(store, "agency-a", "owner-a");
    const byAgent = new Map(
      store.listWorkers("agency-a", { type: "ai" }).map((worker) => [worker.agentId, worker]),
    );
    const ceo = byAgent.get("ceo")!;
    const head = byAgent.get("development-head")!;

    expect(ceo.managerWorkerId).toBeNull();
    expect(head.managerWorkerId).toBe(ceo.id);
    expect(byAgent.get("pm")!.managerWorkerId).toBe(ceo.id);
    expect(byAgent.get("marketing-studio")!.managerWorkerId).toBe(ceo.id);
    expect(byAgent.get("web-builder")!.managerWorkerId).toBe(head.id);
    expect(byAgent.get("coder")!.managerWorkerId).toBe(head.id);
  });

  it("adopts legacy v1 workers in place without duplicating or orphaning them", () => {
    // Simulate a pre-existing install carrying the original ten-role team.
    const legacyAgentIds = [
      "ceo",
      "pm",
      "account-manager",
      "sdr",
      "marketing-studio",
      "web-builder",
      "designer",
      "coder",
      "qa",
      "finance",
    ];
    for (const agentId of legacyAgentIds) {
      store.createWorker(
        {
          id: `agency-b:ai:${agentId}`,
          agencyId: "agency-b",
          type: "ai",
          displayName: `Legacy ${agentId}`,
          title: "Legacy title",
          agentId,
        },
        "owner-b",
      );
    }

    const result = seedAgencyAiWorkforce(store, "agency-b", "owner-b");
    // Only development-head is new; the five mapped legacy workers are adopted.
    expect(result).toEqual({ created: 1, existing: 0, adopted: 5 });

    const workers = store.listWorkers("agency-b", { type: "ai" });
    // 10 legacy + 1 new, nothing duplicated.
    expect(workers).toHaveLength(11);
    expect(new Set(workers.map((w) => w.agentId)).size).toBe(11);

    // Adopted in place: same primary key, new role definition.
    const coder = workers.find((w) => w.agentId === "coder")!;
    expect(coder.id).toBe("agency-b:ai:coder");
    expect(coder.title).toBe("Back End Developer / Automation Specialist");
    expect(coder.modelBinding).toBe("codex");

    // Legacy-only roles are left untouched and still active.
    const qa = workers.find((w) => w.agentId === "qa")!;
    expect(qa.title).toBe("Legacy title");
    expect(qa.employmentStatus).toBe("active");

    // Adoption happens exactly once — a second pass is a pure no-op.
    expect(seedAgencyAiWorkforce(store, "agency-b", "owner-b")).toEqual({
      created: 0,
      existing: 6,
      adopted: 0,
    });
  });
});
