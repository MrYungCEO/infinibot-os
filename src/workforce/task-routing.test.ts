import { describe, expect, it } from "vitest";

import {
  decideAutoStage,
  deriveTaskRequirements,
  planTaskRouting,
  taskRoutingSignature,
  workerPoolFingerprint,
  type RoutableProject,
  type RoutableTask,
  type TaskAutostageLimits,
  type TaskRoutingLimits,
} from "./task-routing.js";
import type { ProficiencyLevel, Worker, WorkerCapacity } from "./types.js";

const LIMITS: TaskRoutingLimits = {
  minScore: 55,
  minMatchStrength: 0.25,
  maxAssignmentsPerPass: 50,
  maxTasksPerWorkerPerPass: 10,
  capacityHeadroom: 0.2,
  defaultEstimatedHours: 2,
};

const AUTOSTAGE: TaskAutostageLimits = {
  mode: "auto",
  minConfidence: 0.6,
  minAutonomyLevel: 2,
  budget: 5,
  workerModes: {},
};

function worker(overrides: Partial<Worker> & Pick<Worker, "id" | "displayName">): Worker {
  return {
    agencyId: "a1",
    type: "ai",
    email: null,
    title: "Employee",
    departmentId: null,
    employmentStatus: "active",
    employmentType: "agent",
    timezone: "UTC",
    weeklyCapacityHours: 168,
    availabilityPercent: 100,
    costRate: 0,
    currency: "USD",
    agentId: null,
    modelBinding: "claude",
    persona: null,
    goals: [],
    kpis: [],
    autonomyLevel: 2,
    approvalThreshold: 500,
    communicationCadence: "",
    communicationProfile: null,
    executionProfile: null,
    sopPath: null,
    workspacePath: null,
    currentStatus: "available",
    lastHeartbeatAt: null,
    managerWorkerId: null,
    permissions: [],
    capabilities: [],
    metadata: {},
    skills: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const skill = (name: string, level: ProficiencyLevel) => ({
  skill: name,
  level,
  yearsExperience: 5,
  verifiedAt: null,
});

const FRONTEND = worker({
  id: "wren",
  displayName: "Wren",
  title: "Front End Developer",
  capabilities: ["frontend-implementation", "web-design", "accessibility"],
  skills: [skill("css", 5), skill("typescript", 4), skill("accessibility", 4)],
});

const BACKEND = worker({
  id: "dev",
  displayName: "Dev",
  title: "Back End Developer",
  capabilities: ["backend-implementation", "automation", "integrations"],
  skills: [skill("typescript", 5), skill("api-design", 4), skill("sql", 4)],
});

const MARKETER = worker({
  id: "mercury",
  displayName: "Mercury",
  title: "Chief Marketing Officer",
  capabilities: ["campaigns", "positioning", "copywriting"],
  skills: [skill("copywriting", 4), skill("positioning", 5)],
});

const BENCH = [FRONTEND, BACKEND, MARKETER];

function capacity(id: string, effective = 168, allocated = 0): WorkerCapacity {
  return {
    workerId: id,
    displayName: id,
    type: "ai",
    weeklyCapacityHours: 168,
    effectiveCapacityHours: effective,
    allocatedHours: allocated,
    loggedHours: 0,
    remainingHours: Math.max(0, effective - allocated),
    utilizationPercent: 0,
    overAllocated: false,
  };
}

const capacities = (workers: Worker[], effective = 168) =>
  new Map(workers.map((entry) => [entry.id, capacity(entry.id, effective)]));

function task(overrides: Partial<RoutableTask> & Pick<RoutableTask, "id" | "title">): RoutableTask {
  return {
    projectId: "p1",
    description: "",
    acceptanceCriteria: "",
    status: "backlog",
    priority: "normal",
    assigneeType: null,
    assigneeId: null,
    dueAt: null,
    ...overrides,
  };
}

const PROJECT: RoutableProject = { id: "p1", name: "Acme website", status: "active" };
const projects = new Map([[PROJECT.id, PROJECT]]);

function plan(
  tasks: RoutableTask[],
  overrides: Partial<Parameters<typeof planTaskRouting>[0]> = {},
) {
  return planTaskRouting({
    agencyId: "a1",
    tasks,
    projects,
    workers: BENCH,
    capacities: capacities(BENCH),
    routedHours: new Map(),
    unchangedSignatures: new Map(),
    pinnedTaskIds: new Set(),
    limits: LIMITS,
    autostage: AUTOSTAGE,
    ...overrides,
  });
}

describe("deriveTaskRequirements", () => {
  it("reads the task's own words and names the discipline it recognised", () => {
    const requirements = deriveTaskRequirements(
      task({
        id: "t1",
        title: "Rebuild the landing page",
        description: "Responsive CSS layout, must hit Core Web Vitals.",
      }),
      PROJECT,
    );
    expect(requirements.discipline).toBe("frontend");
    expect(requirements.requiredCapabilities).toEqual(["frontend-implementation"]);
    expect(requirements.matchStrength).toBeGreaterThanOrEqual(0.5);
    expect(requirements.matchedTerms).toContain("landing page");
  });

  it("does not fire a single word inside a longer one", () => {
    // "api" must not match inside "capital".
    const requirements = deriveTaskRequirements(
      task({ id: "t2", title: "Raise capital", description: "Talk to the bank." }),
      PROJECT,
    );
    expect(requirements.discipline).not.toBe("backend");
  });

  it("returns no discipline at all when the task says nothing recognisable", () => {
    const requirements = deriveTaskRequirements(
      task({ id: "t3", title: "Thing", description: "Do the needful." }),
      { id: "p1", name: "Misc", status: "active" },
    );
    expect(requirements.discipline).toBeNull();
    expect(requirements.matchStrength).toBe(0);
  });

  it("scales the reserved hours with declared priority", () => {
    const low = deriveTaskRequirements(
      task({ id: "a", title: "seo audit", priority: "low" }),
      PROJECT,
    );
    const urgent = deriveTaskRequirements(
      task({ id: "b", title: "seo audit", priority: "urgent" }),
      PROJECT,
    );
    expect(urgent.estimatedHours).toBeGreaterThan(low.estimatedHours);
  });
});

describe("planTaskRouting", () => {
  it("routes a skills-matched task to the plausible worker and explains why", () => {
    const result = plan([
      task({
        id: "t1",
        title: "Rebuild the landing page in responsive CSS",
        acceptanceCriteria: "Passes Core Web Vitals and WCAG AA.",
      }),
    ]);
    const [decision] = result.decisions;
    expect(decision.outcome).toBe("assigned");
    expect(decision.workerId).toBe("wren");
    expect(decision.rationale).toContain("Wren");
    expect(decision.rationale).toContain("suitability");
    expect(decision.matchedSkills).toContain("css");
    // Explainability includes the runner-up so an operator can correct it.
    expect(decision.runnerUp).not.toBeNull();
    expect(decision.runnerUp!.workerId).not.toBe("wren");
  });

  it("sends backend and marketing work to different employees", () => {
    const result = plan([
      task({ id: "t1", title: "Build the webhook endpoint", description: "REST api integration." }),
      task({ id: "t2", title: "Write the newsletter campaign copy" }),
    ]);
    expect(result.decisions.map((entry) => entry.workerId)).toEqual(["dev", "mercury"]);
  });

  it("leaves genuinely unmatched work unassigned and flags it for a human", () => {
    const result = plan([task({ id: "t1", title: "Thing", description: "Do the needful." })], {
      // Neutral project name: "Acme website" would legitimately have supplied
      // front-end evidence, which is exactly what project context is for.
      projects: new Map([["p1", { id: "p1", name: "Misc", status: "active" }]]),
    });
    const [decision] = result.decisions;
    expect(decision.outcome).toBe("unmatched");
    expect(decision.workerId).toBeNull();
    expect(decision.needsHuman).toBe(true);
    expect(decision.autoStaged).toBe(false);
    expect(decision.rationale).toMatch(/No recognisable discipline/);
  });

  it("never assigns when nobody has the required capability", () => {
    const result = plan(
      [task({ id: "t1", title: "Refactor the architecture and clear technical debt" })],
      { workers: [MARKETER], capacities: capacities([MARKETER]) },
    );
    expect(result.decisions[0].outcome).toBe("unmatched");
    expect(result.decisions[0].needsHuman).toBe(true);
  });

  it("respects capacity: one worker cannot absorb an unbounded backlog", () => {
    const tasks = Array.from({ length: 40 }, (_, index) =>
      task({ id: `t${index}`, title: "Fix the responsive CSS layout on the landing page" }),
    );
    // 10 usable hours, 2h per task → at most 5 assignments before it is full.
    const result = plan(tasks, {
      capacities: capacities(BENCH, 12.5),
      limits: { ...LIMITS, maxTasksPerWorkerPerPass: 100 },
    });
    const assigned = result.decisions.filter((entry) => entry.outcome === "assigned");
    expect(assigned.length).toBeLessThanOrEqual(5);
    expect(result.decisions.length).toBe(40);
    // Everything it could not place is honest about needing a human.
    expect(
      result.decisions.filter((entry) => entry.outcome === "unmatched").every((e) => e.needsHuman),
    ).toBe(true);
  });

  it("honours the per-worker per-pass cap even with capacity to spare", () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      task({ id: `t${index}`, title: "Fix the responsive CSS layout on the landing page" }),
    );
    const result = plan(tasks, { limits: { ...LIMITS, maxTasksPerWorkerPerPass: 3 } });
    const forWren = result.decisions.filter((entry) => entry.workerId === "wren");
    expect(forWren.length).toBe(3);
  });

  it("skips tasks whose signature is unchanged, without scoring them", () => {
    const routable = task({ id: "t1", title: "Rebuild the responsive landing page CSS" });
    const signature = taskRoutingSignature(routable, workerPoolFingerprint(BENCH), LIMITS);
    const result = plan([routable], { unchangedSignatures: new Map([["t1", signature]]) });
    expect(result.decisions).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("never revisits a task a human pinned", () => {
    const result = plan([task({ id: "t1", title: "Rebuild the responsive landing page CSS" })], {
      pinnedTaskIds: new Set(["t1"]),
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.pinned).toBe(1);
  });

  it("defers work past the per-pass assignment cap instead of writing it", () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task({ id: `t${index}`, title: "Fix the responsive CSS layout on the landing page" }),
    );
    const result = plan(tasks, { limits: { ...LIMITS, maxAssignmentsPerPass: 3 } });
    expect(result.decisions).toHaveLength(3);
    expect(result.deferred).toBe(5);
  });

  it("changing the workforce invalidates a cached signature", () => {
    const routable = task({ id: "t1", title: "Rebuild the responsive landing page CSS" });
    const before = taskRoutingSignature(routable, workerPoolFingerprint(BENCH), LIMITS);
    const after = taskRoutingSignature(
      routable,
      workerPoolFingerprint([...BENCH, worker({ id: "new", displayName: "New" })]),
      LIMITS,
    );
    expect(before).not.toBe(after);
  });
});

describe("autostage policy", () => {
  it("stages confident work by default so the agency actually moves", () => {
    const result = plan([
      task({
        id: "t1",
        title: "Rebuild the landing page in responsive CSS",
        acceptanceCriteria: "Passes Core Web Vitals and WCAG AA.",
      }),
    ]);
    expect(result.decisions[0].autoStaged).toBe(true);
    expect(result.decisions[0].stageReason).toMatch(/^staged:/);
  });

  it("mode 'off' routes but never stages", () => {
    const result = plan([task({ id: "t1", title: "Rebuild the responsive landing page CSS" })], {
      autostage: { ...AUTOSTAGE, mode: "off" },
    });
    expect(result.decisions[0].outcome).toBe("assigned");
    expect(result.decisions[0].autoStaged).toBe(false);
    expect(result.decisions[0].stageReason).toContain("autostage is off");
  });

  it("mode 'recommend' marks the card without starting it", () => {
    const result = plan([task({ id: "t1", title: "Rebuild the responsive landing page CSS" })], {
      autostage: { ...AUTOSTAGE, mode: "recommend" },
    });
    expect(result.decisions[0].autoStaged).toBe(false);
    expect(result.decisions[0].stageRecommended).toBe(true);
  });

  it("a per-worker override beats the agency mode", () => {
    const result = plan([task({ id: "t1", title: "Rebuild the responsive landing page CSS" })], {
      autostage: { ...AUTOSTAGE, workerModes: { wren: "off" } },
    });
    expect(result.decisions[0].workerId).toBe("wren");
    expect(result.decisions[0].autoStaged).toBe(false);
  });

  it("never stages an autonomy-0 employee's card", () => {
    const shadow = worker({
      id: "wren",
      displayName: "Wren",
      autonomyLevel: 0,
      capabilities: FRONTEND.capabilities,
      skills: FRONTEND.skills,
    });
    const result = plan([task({ id: "t1", title: "Rebuild the responsive landing page CSS" })], {
      workers: [shadow],
      capacities: capacities([shadow]),
    });
    expect(result.decisions[0].workerId).toBe("wren");
    expect(result.decisions[0].autoStaged).toBe(false);
    expect(result.decisions[0].stageReason).toContain("autonomy level 0");
  });

  it("stops staging when the pass/day budget runs out, but still routes", () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({ id: `t${index}`, title: "Fix the responsive CSS layout on the landing page" }),
    );
    const result = plan(tasks, { autostage: { ...AUTOSTAGE, budget: 2 } });
    expect(result.decisions.filter((entry) => entry.autoStaged)).toHaveLength(2);
    expect(result.decisions.filter((entry) => entry.outcome === "assigned").length).toBe(6);
    expect(result.decisions.filter((entry) => entry.stageRecommended).length).toBe(6);
  });

  it("refuses to stage what it could not explain confidently", () => {
    expect(
      decideAutoStage({
        mode: "auto",
        confidence: 0.4,
        minConfidence: 0.6,
        autonomyLevel: 3,
        minAutonomyLevel: 2,
        budgetLeft: 10,
        workerName: "Dev",
      }),
    ).toMatchObject({ autoStaged: false, recommended: false });
  });
});

describe("scale", () => {
  it("routes 2853 tasks across 11 workers well inside one operating-loop tick", () => {
    const workers = Array.from({ length: 11 }, (_, index) =>
      index % 3 === 0
        ? worker({ ...FRONTEND, id: `w${index}`, displayName: `W${index}` })
        : index % 3 === 1
          ? worker({ ...BACKEND, id: `w${index}`, displayName: `W${index}` })
          : worker({ ...MARKETER, id: `w${index}`, displayName: `W${index}` }),
    );
    const titles = [
      "Rebuild the responsive landing page CSS",
      "Build the webhook api integration endpoint",
      "Write the seo newsletter campaign copy",
      "Do the needful",
    ];
    const tasks = Array.from({ length: 2853 }, (_, index) =>
      task({ id: `t${index}`, title: titles[index % titles.length]!, description: "Details." }),
    );

    const startedAt = Date.now();
    const result = planTaskRouting({
      agencyId: "a1",
      tasks,
      projects,
      workers,
      capacities: capacities(workers),
      routedHours: new Map(),
      unchangedSignatures: new Map(),
      pinnedTaskIds: new Set(),
      limits: { ...LIMITS, maxAssignmentsPerPass: 3000, maxTasksPerWorkerPerPass: 1000 },
      autostage: AUTOSTAGE,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.decisions.length).toBe(2853);
    expect(result.decisions.filter((entry) => entry.outcome === "assigned").length).toBeGreaterThan(
      0,
    );
    // Generous ceiling: the measured cost is ~0.3s. The point is that it is
    // linear in tasks × workers and nowhere near blocking a 15-minute tick.
    expect(elapsed).toBeLessThan(15_000);
  });

  it("a second pass over unchanged work does no scoring at all", () => {
    const tasks = Array.from({ length: 2853 }, (_, index) =>
      task({ id: `t${index}`, title: "Rebuild the responsive landing page CSS" }),
    );
    const fingerprint = workerPoolFingerprint(BENCH);
    const signatures = new Map(
      tasks.map((entry) => [entry.id, taskRoutingSignature(entry, fingerprint, LIMITS)]),
    );
    const startedAt = Date.now();
    const result = plan(tasks, { unchangedSignatures: signatures });
    expect(result.decisions).toHaveLength(0);
    expect(result.skipped).toBe(2853);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
