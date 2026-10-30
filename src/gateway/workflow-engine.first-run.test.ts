import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowEngine } from "./workflow-engine.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "workflow-engine-first-run-"));
  vi.stubEnv("INFINIBOT_CONFIG_PATH", join(dir, "missing-config.json"));
  vi.stubEnv("INFINIBOT_AUTONOMY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkflowEngine built-ins and the autonomy opt-in", () => {
  it("fresh install (no persisted state): built-ins register disabled", () => {
    const engine = new WorkflowEngine(dir);
    const workflows = engine.getWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.filter((wf) => wf.enabled)).toEqual([]);
  });

  it("existing install: persisted workflows load exactly as saved", () => {
    const first = new WorkflowEngine(dir);
    const saved = first.getWorkflows().map((wf, i) => ({
      ...wf,
      enabled: i % 2 === 0,
      seededDisabled: undefined,
    }));
    writeFileSync(join(dir, "workflow-engine.json"), JSON.stringify({ workflows: saved }));
    const engine = new WorkflowEngine(dir);
    for (const wf of saved) {
      expect(engine.getWorkflows().find((w) => w.id === wf.id)?.enabled).toBe(wf.enabled);
    }
  });

  it("opting in enables gate-disabled built-ins but not operator-disabled ones", () => {
    const first = new WorkflowEngine(dir);
    const [a, b] = first.getWorkflows();
    first.setEnabled(b!.id, false); // operator choice, persisted
    const persisted = JSON.parse(readFileSync(join(dir, "workflow-engine.json"), "utf8"));
    expect(persisted.workflows.find((w: { id: string }) => w.id === a!.id).seededDisabled).toBe(
      true,
    );

    vi.stubEnv("INFINIBOT_AUTONOMY", "1");
    const engine = new WorkflowEngine(dir);
    expect(engine.getWorkflows().find((w) => w.id === a!.id)?.enabled).toBe(true);
    expect(engine.getWorkflows().find((w) => w.id === b!.id)?.enabled).toBe(false);
  });
});
