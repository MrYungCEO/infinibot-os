import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { maybeGenerateSkillForTask, sanitizeSkillBody } from "./auto-skill.js";
import type { KanbanTask } from "./types.js";

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  const now = Date.now();
  return {
    id: "task-1",
    projectId: "default",
    title: "Wire the new payment webhook",
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("sanitizeSkillBody", () => {
  it("redacts common secret patterns", () => {
    const input = [
      "Authorization: Bearer abc123token",
      "access_token=supersecret",
      "api_key = magic-key",
      "Use sk-abc1234567890123456789 for tests",
    ].join("\n");
    const out = sanitizeSkillBody(input);
    expect(out).not.toContain("abc123token");
    expect(out).not.toContain("supersecret");
    expect(out).not.toContain("magic-key");
    expect(out).not.toMatch(/sk-abc1234567890123456789/);
    expect(out).toContain("[REDACTED]");
  });
});

describe("maybeGenerateSkillForTask", () => {
  it("skips non-robust tasks", async () => {
    const ref = await maybeGenerateSkillForTask(
      makeTask({ complexity: "standard", content: "## What\nx\n## Where\ny" }),
    );
    expect(ref).toBeNull();
  });

  it("skips tasks with insufficient signal even if marked robust", async () => {
    const ref = await maybeGenerateSkillForTask(
      makeTask({
        complexity: "robust",
        content: "Just a one-liner with no structure.",
      }),
    );
    expect(ref).toBeNull();
  });

  it("writes a SKILL.md file when signal is sufficient", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-skill-test-"));
    const ref = await maybeGenerateSkillForTask(
      makeTask({
        complexity: "robust",
        content: [
          "# Wire the new payment webhook",
          "",
          "## What",
          "Implemented Stripe webhook handler with replay protection.",
          "",
          "## Where",
          "src/webhooks/stripe.ts and src/webhooks/dedupe.ts",
          "",
          "## Details",
          "Verified signature, persisted event ids in sqlite, added retry shim.",
        ].join("\n"),
      }),
      { targetDir: dir },
    );
    expect(ref).not.toBeNull();
    expect(ref!.path).toContain(dir);
    expect(ref!.name).toMatch(/^skill-/);
    const written = readFileSync(ref!.path, "utf-8");
    expect(written).toMatch(/^---\n/);
    expect(written).toContain("source: auto-task");
    expect(written).toContain("taskId: 'task-1'");
    expect(written).toContain("## Captured task content");
    expect(written).toContain("Stripe webhook handler");
  });
});
