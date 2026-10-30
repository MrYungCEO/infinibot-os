import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkforceStore } from "./store.js";
import { planHybridTeam, scoreWorkerSuitability } from "./suitability.js";

describe("WorkforceStore", () => {
  let directory: string;
  let store: WorkforceStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "infinibot-workforce-"));
    store = new WorkforceStore(join(directory, "agency.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("isolates every workforce record by agency", () => {
    store.createWorker({
      id: "designer",
      agencyId: "agency-a",
      type: "human",
      displayName: "Alex A",
      agentId: "base-designer",
    });
    store.createWorker({
      id: "designer",
      agencyId: "agency-b",
      type: "ai",
      displayName: "Alex B",
      agentId: "base-designer",
      persona: "Direct, conversion-focused designer for Agency B",
    });

    expect(store.getWorker("agency-a", "designer")?.displayName).toBe("Alex A");
    expect(store.getWorker("agency-b", "designer")?.persona).toContain("Agency B");
    expect(store.listWorkers("agency-a")).toHaveLength(1);
    expect(store.listWorkers("agency-b")).toHaveLength(1);
    expect(store.listAuditEntries("agency-a")).toHaveLength(1);
    expect(() => store.listWorkers("")).toThrow("agencyId required");
  });

  it("persists human-like AI operating profiles and heartbeat state", () => {
    const department = store.createDepartment("agency-a", { name: "Delivery" });
    const worker = store.createWorker({
      agencyId: "agency-a",
      type: "ai",
      displayName: "Nova",
      title: "Senior Web Designer",
      departmentId: department.id,
      agentId: "web-builder",
      persona: "Owns client outcomes and communicates risks early.",
      goals: ["Ship accessible sites on schedule"],
      kpis: ["first-pass approval rate", "Lighthouse score"],
      autonomyLevel: 2,
      approvalThreshold: 500,
      communicationCadence: "daily standup and exception alerts",
      sopPath: "agents/web-builder/SOP.md",
      workspacePath: "workspaces/nova",
      capabilities: ["design", "code", "browser"],
      skills: [{ skill: "web design", level: 5, yearsExperience: 8, verifiedAt: null }],
    });
    store.heartbeat("agency-a", worker.id, "working", 12345);

    const reloaded = store.getWorker("agency-a", worker.id)!;
    expect(reloaded.autonomyLevel).toBe(2);
    expect(reloaded.kpis).toContain("Lighthouse score");
    expect(reloaded.skills[0]?.level).toBe(5);
    expect(reloaded.currentStatus).toBe("working");
    expect(reloaded.lastHeartbeatAt).toBe(12345);
  });

  it("tracks assignments, capacity, time, and department load", () => {
    const department = store.createDepartment("agency-a", { name: "Creative" });
    const worker = store.createWorker({
      agencyId: "agency-a",
      id: "human-1",
      type: "human",
      displayName: "Sam",
      departmentId: department.id,
      weeklyCapacityHours: 40,
      availabilityPercent: 75,
      costRate: 80,
    });
    const assignment = store.createAssignment({
      agencyId: "agency-a",
      title: "Homepage",
      estimatedHours: 24,
      status: "active",
      members: [{ workerId: worker.id, role: "owner", allocatedHours: 24 }],
    });
    store.addTimeEntry("agency-a", {
      workerId: worker.id,
      assignmentId: assignment.id,
      hours: 6,
      billable: true,
      note: "Wireframes",
      occurredOn: "2026-07-20",
    });

    const capacity = store.getWorkerCapacity("agency-a", worker.id, "2026-07-20")!;
    expect(capacity.effectiveCapacityHours).toBe(30);
    expect(capacity.allocatedHours).toBe(24);
    expect(capacity.loggedHours).toBe(6);
    expect(capacity.remainingHours).toBe(6);
    expect(store.getDepartmentCapacity("agency-a")[0]).toMatchObject({
      headcount: 1,
      allocatedHours: 24,
      remainingHours: 6,
    });
    expect(store.getDailyRoster("agency-a")[0]?.activeAssignments).toBe(1);
  });

  it("builds performance scorecards from reviews, outcomes, hours, and delivery", () => {
    const worker = store.createWorker({
      agencyId: "agency-a",
      id: "ai-1",
      type: "ai",
      displayName: "Nova",
    });
    const assignment = store.createAssignment({
      agencyId: "agency-a",
      title: "Landing page",
      status: "active",
      members: [{ workerId: worker.id, role: "owner", allocatedHours: 4 }],
    });
    store.addTimeEntry("agency-a", {
      workerId: worker.id,
      assignmentId: assignment.id,
      hours: 4,
      billable: true,
      note: "Build",
      occurredOn: "2026-07-20",
    });
    store.addPerformanceReview("agency-a", {
      workerId: worker.id,
      reviewerWorkerId: null,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      qualityScore: 90,
      reliabilityScore: 80,
      collaborationScore: 85,
      goals: ["Improve QA"],
      feedback: "Strong delivery",
    });
    store.addOutcomeMetric("agency-a", {
      workerId: worker.id,
      assignmentId: assignment.id,
      metric: "conversion_score",
      value: 9,
      target: 10,
      unit: "score",
      recordedAt: Date.now(),
    });
    store.setAssignmentStatus("agency-a", assignment.id, "completed");

    expect(store.getPerformanceScorecards("agency-a")[0]).toMatchObject({
      qualityScore: 90,
      reliabilityScore: 80,
      collaborationScore: 85,
      outcomeAttainmentPercent: 90,
      loggedHours: 4,
      completedAssignments: 1,
    });
  });
});

describe("workforce suitability and hybrid planning", () => {
  const human = {
    id: "human",
    agencyId: "agency-a",
    type: "human" as const,
    displayName: "Maya",
    email: null,
    title: "Creative Director",
    departmentId: null,
    employmentStatus: "active" as const,
    employmentType: "employee" as const,
    timezone: "UTC",
    weeklyCapacityHours: 40,
    availabilityPercent: 100,
    costRate: 100,
    currency: "USD",
    agentId: null,
    persona: null,
    goals: [],
    kpis: [],
    autonomyLevel: 0 as const,
    approvalThreshold: 0,
    communicationCadence: "daily",
    sopPath: null,
    workspacePath: null,
    currentStatus: "available",
    lastHeartbeatAt: null,
    managerWorkerId: null,
    permissions: ["approve"],
    capabilities: ["review"],
    metadata: {},
    skills: [{ skill: "design", level: 5 as const, yearsExperience: 10, verifiedAt: null }],
    createdAt: 1,
    updatedAt: 1,
  };
  const ai = {
    ...human,
    id: "ai",
    type: "ai" as const,
    displayName: "Pixel",
    costRate: 10,
    employmentType: "agent" as const,
    agentId: "designer",
    autonomyLevel: 2 as const,
    capabilities: ["review", "code"],
    skills: [
      { skill: "design", level: 4 as const, yearsExperience: 5, verifiedAt: null },
      { skill: "code", level: 5 as const, yearsExperience: 5, verifiedAt: null },
    ],
  };
  const capacity = (worker: typeof human | typeof ai) => ({
    workerId: worker.id,
    displayName: worker.displayName,
    type: worker.type,
    weeklyCapacityHours: 40,
    effectiveCapacityHours: 40,
    allocatedHours: 0,
    loggedHours: 0,
    remainingHours: 40,
    utilizationPercent: 0,
    overAllocated: false,
  });

  it("rejects workers that miss a hard requirement", () => {
    const result = scoreWorkerSuitability(human, capacity(human), {
      requiredSkills: [{ skill: "code", minimumLevel: 3 }],
      requiredCapabilities: ["code"],
      estimatedHours: 8,
    });
    expect(result.eligible).toBe(false);
    expect(result.missingSkills).toEqual(["code"]);
    expect(result.missingCapabilities).toEqual(["code"]);
  });

  it("forms a human/AI team with complementary skills and cost", () => {
    const capacities = new Map([
      [human.id, capacity(human)],
      [ai.id, capacity(ai)],
    ]);
    const plan = planHybridTeam([human, ai], capacities, {
      requiredSkills: [
        { skill: "design", minimumLevel: 4 },
        { skill: "code", minimumLevel: 4 },
      ],
      requiredCapabilities: ["review"],
      estimatedHours: 20,
      requireHuman: true,
      requireAi: true,
    });
    expect(plan.members.map((entry) => entry.worker.type).sort()).toEqual(["ai", "human"]);
    expect(plan.skillCoverage).toBe(1);
    expect(plan.estimatedCost).toBe(1100);
    expect(plan.warnings).toEqual([]);
  });
});
