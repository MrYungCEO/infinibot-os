import { describe, it, expect, beforeEach } from "vitest";
import {
  registerWorkflow,
  getWorkflow,
  listWorkflows,
  clearWorkflows,
  type BuildCtx,
  type CanvasWorkflow,
} from "./registry.js";
import { validatePopupMedia } from "../proactive/popup-types.js";
import { buildSystemsOverview, systemsOverviewWorkflow } from "./templates/systems-overview.js";
import { buildProjectOps, projectOpsWorkflow } from "./templates/project-ops.js";

// ── Stub BuildCtx ────────────────────────────────────────────────────────────

function makeStubCtx(overrides: Partial<BuildCtx> = {}): BuildCtx {
  const base: BuildCtx = {
    federation: {
      async list() {
        return {
          role: "master",
          nodes: [
            {
              id: "local",
              name: "master-node",
              status: "online",
              role: "master",
              isLocal: true,
              platform: "linux",
              capabilities: { version: "1.0.0", gpu: "RTX 4090", cpu: "Ryzen 9", ram: "64GB" },
            },
            {
              id: "sat-1",
              name: "robo-laptop",
              status: "online",
              role: "satellite",
              platform: "darwin",
              capabilities: { version: "1.0.0", gpu: "M2 Pro", ram: "32GB" },
            },
            {
              id: "sat-2",
              name: "pi-cluster",
              status: "offline",
              role: "satellite",
              platform: "linux",
              capabilities: { version: "0.9.0" },
            },
          ],
        };
      },
    },
    kanban: {
      async snapshot() {
        return {
          projects: [
            {
              id: "p1",
              name: "InfiniBot UI",
              status: "In progress",
              priority: "High",
              progress: 42,
              taskCount: 10,
              node: "master",
            },
            {
              id: "p2",
              name: "Mobile App",
              status: "Reviewing",
              priority: "Medium",
              progress: 80,
              taskCount: 5,
            },
            {
              id: "p3",
              name: "Old Project",
              status: "Completed",
              priority: "Low",
            },
          ],
          tasks: [
            { id: "t1", projectId: "p1", title: "Fix nav", status: "in_progress" },
            {
              id: "t2",
              projectId: "p1",
              title: "Add theme",
              status: "done",
              completedAt: Date.now(),
            },
            { id: "t3", projectId: "p2", title: "QA pass", status: "review" },
            { id: "t4", projectId: "p2", title: "Ship", status: "backlog" },
          ],
        };
      },
    },
    insights: {
      async summary() {
        return {
          insights: [
            {
              id: "insight-1",
              type: "warning",
              title: 'Value "Speed" has no linked priorities',
              severity: "medium",
              createdAt: Date.now(),
            },
          ],
        };
      },
    },
    credits: {
      async timeseries() {
        return { points: [{ bucket: "hour", cost: 0.42 }] };
      },
    },
    agents: {
      async list() {
        return {
          agents: [
            { id: "main", name: "Orchestrator" },
            { id: "coder", name: "Coder" },
          ],
        };
      },
    },
  };
  return { ...base, ...overrides };
}

// ── Registry API ─────────────────────────────────────────────────────────────

describe("canvas-workflow registry API", () => {
  beforeEach(() => {
    clearWorkflows();
  });

  it("registers, gets, and lists workflows", () => {
    const wf: CanvasWorkflow = {
      id: "test-wf",
      title: "Test",
      description: "A test workflow",
      build: async () => ({ nodes: [], scenes: [] }),
    };
    registerWorkflow(wf);
    expect(getWorkflow("test-wf")).toBe(wf);
    expect(listWorkflows()).toHaveLength(1);
    expect(listWorkflows()[0].id).toBe("test-wf");
  });

  it("throws on duplicate registration", () => {
    registerWorkflow({
      id: "dup",
      title: "Dup",
      description: "",
      build: async () => ({ nodes: [], scenes: [] }),
    });
    expect(() =>
      registerWorkflow({
        id: "dup",
        title: "Dup2",
        description: "",
        build: async () => ({ nodes: [], scenes: [] }),
      }),
    ).toThrow(/already registered/);
  });

  it("returns undefined for unknown id", () => {
    expect(getWorkflow("nope")).toBeUndefined();
  });
});

// ── Shipped templates are registered ─────────────────────────────────────────

describe("shipped template registration", () => {
  beforeEach(() => {
    clearWorkflows();
    registerWorkflow(systemsOverviewWorkflow);
    registerWorkflow(projectOpsWorkflow);
  });

  it("registers exactly 2 workflows", () => {
    expect(listWorkflows()).toHaveLength(2);
  });

  it("registers systems-overview and project-ops", () => {
    const ids = listWorkflows()
      .map((w) => w.id)
      .sort();
    expect(ids).toEqual(["project-ops", "systems-overview"]);
  });
});

// ── systems-overview template build ──────────────────────────────────────────

describe("systems-overview build", () => {
  it("produces a valid infinite-canvas payload with ttsText scenes", async () => {
    const payload = await buildSystemsOverview(makeStubCtx());
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.scenes.length).toBeGreaterThan(0);
    // title + stats + hub + one per fed node (3) = 6
    expect(payload.nodes).toHaveLength(6);
    // title scene + stats scene + 3 node scenes = 5
    expect(payload.scenes).toHaveLength(5);
    // Every scene has a ttsText narration
    for (const scene of payload.scenes) {
      expect(scene.narration?.ttsText).toBeTruthy();
      expect(typeof scene.narration?.ttsText).toBe("string");
    }
    // voiceSuppress set
    expect(payload.voiceSuppress).toBe(true);
    // Node schema uses direct fields (h1/h2/body/stats), NOT content
    const title = payload.nodes.find((n) => n.kind === "title");
    expect(title?.h1).toBe("Federation Fleet Overview");
    expect(title).not.toHaveProperty("content");
    const stats = payload.nodes.find((n) => n.kind === "stats");
    expect(stats?.stats).toBeDefined();
    expect(stats?.stats?.length).toBeGreaterThan(0);
    // Validates against the locked overlay schema
    const { error } = validatePopupMedia({ kind: "infinite-canvas-walkthrough", payload });
    expect(error).toBeUndefined();
  });

  it("degrades gracefully on empty federation", async () => {
    const ctx = makeStubCtx({
      federation: {
        async list() {
          return { role: "standalone", nodes: [] };
        },
      },
    });
    const payload = await buildSystemsOverview(ctx);
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.scenes.length).toBeGreaterThan(0);
    const { error } = validatePopupMedia({ kind: "infinite-canvas-walkthrough", payload });
    expect(error).toBeUndefined();
  });
});

// ── project-ops template build ───────────────────────────────────────────────

describe("project-ops build", () => {
  it("produces a valid payload with ttsText scenes and filters to active", async () => {
    const payload = await buildProjectOps(makeStubCtx());
    expect(payload.nodes.length).toBeGreaterThan(0);
    expect(payload.scenes.length).toBeGreaterThan(0);
    // title + stats + 2 active projects (Completed excluded) = 4
    expect(payload.nodes).toHaveLength(4);
    // title + stats + 2 project scenes = 4
    expect(payload.scenes).toHaveLength(4);
    for (const scene of payload.scenes) {
      expect(scene.narration?.ttsText).toBeTruthy();
    }
    expect(payload.voiceSuppress).toBe(true);
    // Node schema uses direct fields
    const title = payload.nodes.find((n) => n.kind === "title");
    expect(title?.h1).toBe("Project Operations");
    expect(title).not.toHaveProperty("content");
    const stats = payload.nodes.find((n) => n.kind === "stats");
    expect(stats?.stats).toBeDefined();
    const { error } = validatePopupMedia({ kind: "infinite-canvas-walkthrough", payload });
    expect(error).toBeUndefined();
  });

  it("degrades gracefully on empty board", async () => {
    const ctx = makeStubCtx({
      kanban: {
        async snapshot() {
          return { projects: [], tasks: [] };
        },
      },
    });
    const payload = await buildProjectOps(ctx);
    expect(payload.nodes.length).toBeGreaterThan(0);
    const { error } = validatePopupMedia({ kind: "infinite-canvas-walkthrough", payload });
    expect(error).toBeUndefined();
  });
});
