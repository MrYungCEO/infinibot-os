import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeKanbanState,
  listProjects,
  listTasks,
  upsertProject,
  upsertTask,
  deleteProject,
  deleteTask,
} from "./kanban-store-ops.js";
import { setNotionRuntimeOverride } from "./notion-config.js";

describe("kanban-store-ops (local-first)", () => {
  let tempDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "infinibot-kanban-ops-"));
    process.env.MOLTBOT_STATE_DIR = tempDir;
    process.env.INFINIBOT_STATE_DIR = tempDir;
    delete process.env.NOTION_API_KEY;
    setNotionRuntimeOverride({ syncMode: "off", apiKey: null });
  });

  afterEach(() => {
    setNotionRuntimeOverride(null);
    process.env = { ...originalEnv };
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("works without any Notion configuration", () => {
    const state = describeKanbanState();
    expect(state.notionConfigured).toBe(false);
    expect(state.syncMode).toBe("off");
  });

  it("creates and lists a project locally", () => {
    const project = upsertProject({ name: "Local Project", description: "no notion needed" });
    expect(project.id).toBeDefined();
    expect(project.name).toBe("Local Project");

    const list = listProjects();
    const ours = list.find((p) => p.id === project.id);
    expect(ours).toBeDefined();
    expect(ours?.name).toBe("Local Project");
  });

  it("round-trips projectDirectory (repo binding) without a schema property", () => {
    const proj = upsertProject({ name: "Repo project" });
    const bound = upsertProject({ id: proj.id, projectDirectory: "/home/me/code/app" });
    expect(bound.projectDirectory).toBe("/home/me/code/app");
    expect(listProjects().find((p) => p.id === proj.id)?.projectDirectory).toBe(
      "/home/me/code/app",
    );
    const cleared = upsertProject({ id: proj.id, projectDirectory: "" });
    expect(cleared.projectDirectory).toBeUndefined();
  });

  it("creates and lists a task linked to a project", () => {
    const proj = upsertProject({ name: "Parent" });
    const task = upsertTask({
      title: "First task",
      projectId: proj.id,
      status: "todo",
    });
    expect(task.id).toBeDefined();
    expect(task.title).toBe("First task");

    const filtered = listTasks({ projectId: proj.id });
    expect(filtered.find((t) => t.id === task.id)).toBeDefined();
  });

  it("returns task status as the canonical option id, not the display label", () => {
    // Regression: the kanban /projects board filters tasks by lowercase
    // TaskStatus ids ("todo", "in_progress", "review", "done"). Earlier
    // taskFromRow returned the option *name* ("To Do") so the filter
    // rejected every task and the board looked empty.
    const proj = upsertProject({ name: "Parent" });
    for (const status of ["todo", "in_progress", "review", "done"] as const) {
      const t = upsertTask({ title: `task-${status}`, projectId: proj.id, status });
      expect(t.status, `${status} should round-trip as id`).toBe(status);
    }
    const all = listTasks({ projectId: proj.id });
    const byStatus = (s: string) => all.filter((t) => t.status === s).length;
    expect(byStatus("todo")).toBe(1);
    expect(byStatus("in_progress")).toBe(1);
    expect(byStatus("review")).toBe(1);
    expect(byStatus("done")).toBe(1);
  });

  it("returns task priority as the canonical option id", () => {
    const proj = upsertProject({ name: "Parent" });
    const t = upsertTask({ title: "p", projectId: proj.id, priority: "high" });
    expect(t.priority).toBe("high");
  });

  it("maps the API's critical/normal priorities onto the local option ids", () => {
    const proj = upsertProject({ name: "P" });
    const t = upsertTask({ title: "Hot", projectId: proj.id, priority: "critical" });
    expect(t.priority).toBe("immediate");
    expect(upsertTask({ id: t.id, priority: "normal" }).priority).toBe("medium");
  });

  it("persists agent hand-off state (autonomousStatus / assignedAgent) across updates", () => {
    const proj = upsertProject({ name: "P" });
    const t = upsertTask({
      title: "Agent work",
      projectId: proj.id,
      autonomous: true,
      autonomousStatus: "blocked",
    });
    expect(t.autonomousStatus).toBe("blocked");
    // An unrelated update keeps it; a later patch changes it.
    expect(upsertTask({ id: t.id, dueDate: "2026-10-01" }).autonomousStatus).toBe("blocked");
    const handed = upsertTask({ id: t.id, autonomousStatus: "in_progress", assignedAgent: "main" });
    expect(handed).toMatchObject({
      autonomous: true,
      autonomousStatus: "in_progress",
      assignedAgent: "main",
    });
    expect(listTasks().find((x) => x.id === t.id)?.assignedAgent).toBe("main");
  });

  it("updates a task in place", () => {
    const task = upsertTask({ title: "Original" });
    const updated = upsertTask({ id: task.id, title: "Renamed" });
    expect(updated.id).toBe(task.id);
    expect(updated.title).toBe("Renamed");
  });

  it("deletes a project and a task", () => {
    const proj = upsertProject({ name: "To delete" });
    const task = upsertTask({ title: "To delete", projectId: proj.id });

    expect(deleteTask(task.id)).toBe(true);
    expect(listTasks().find((t) => t.id === task.id)).toBeUndefined();

    expect(deleteProject(proj.id)).toBe(true);
    expect(listProjects().find((p) => p.id === proj.id)).toBeUndefined();
  });

  // ── Timestamp population ───────────────────────────────────────────────

  it("(a) creating a task populates createdAt and updatedAt", () => {
    const before = Date.now();
    const task = upsertTask({ title: "Timestamp test", status: "todo" });
    const after = Date.now();

    expect(task.createdAt).toBeGreaterThanOrEqual(before);
    expect(task.createdAt).toBeLessThanOrEqual(after);
    expect(task.updatedAt).toBeGreaterThanOrEqual(before);
    expect(task.updatedAt).toBeLessThanOrEqual(after);
  });

  it("(b) marking a task done populates completedAt", () => {
    const proj = upsertProject({ name: "Done test" });
    // Create in non-done state first
    const task = upsertTask({ title: "Will be done", projectId: proj.id, status: "todo" });
    expect(task.completedAt).toBeUndefined();

    // Transition to done
    const before = Date.now();
    const done = upsertTask({ id: task.id, status: "done" });
    const after = Date.now();

    expect(done.completedAt).toBeDefined();
    expect(done.completedAt!).toBeGreaterThanOrEqual(before);
    expect(done.completedAt!).toBeLessThanOrEqual(after);
  });

  it("(b) creating a task directly as done sets completedAt immediately", () => {
    const before = Date.now();
    const task = upsertTask({ title: "Born done", status: "done" });
    const after = Date.now();

    expect(task.completedAt).toBeDefined();
    expect(task.completedAt!).toBeGreaterThanOrEqual(before);
    expect(task.completedAt!).toBeLessThanOrEqual(after);
  });

  it("(c) recently-completed query returns the just-completed task with its real title", () => {
    const proj = upsertProject({ name: "RC Project" });
    upsertTask({ title: "Other todo", projectId: proj.id, status: "todo" });
    const done1 = upsertTask({ title: "Completed Task Alpha", projectId: proj.id, status: "done" });
    const done2 = upsertTask({ title: "Completed Task Beta", projectId: proj.id, status: "done" });

    const doneTasks = listTasks({ status: "done" }).filter(
      (t) => t.id === done1.id || t.id === done2.id,
    );

    expect(doneTasks).toHaveLength(2);

    const titles = doneTasks.map((t) => t.title);
    expect(titles).toContain("Completed Task Alpha");
    expect(titles).toContain("Completed Task Beta");

    // Each completed task must carry a completedAt timestamp
    for (const t of doneTasks) {
      expect(t.completedAt, `completedAt missing on task "${t.title}"`).toBeDefined();
    }

    // Non-done task must NOT appear in the done list
    const todoPresent = listTasks({ status: "done" }).some((t) => t.title === "Other todo");
    expect(todoPresent).toBe(false);
  });
});
