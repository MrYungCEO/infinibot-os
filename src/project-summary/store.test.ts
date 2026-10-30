import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Point the state dir at a throwaway temp dir BEFORE importing the store so
// resolveStateDir() resolves there and we never touch the real profile.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ib-summary-"));
  process.env.INFINIBOT_STATE_DIR = dir;
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

describe("project-summary store", () => {
  it("round-trips a summary record and caps the revision log", async () => {
    const { getProjectSummary, saveProjectSummary } = await import("./store.js");

    expect(await getProjectSummary("proj-1")).toBeNull();

    const revisions = Array.from({ length: 40 }, (_, i) => ({
      at: i,
      source: "text" as const,
      input: `dump ${i}`,
    }));
    const saved = await saveProjectSummary({
      projectId: "proj-1",
      markdown: "# Current state\nAll good.",
      generatedAt: 123,
      model: "anthropic:claude-haiku",
      source: "manual",
      revisions,
    });

    // Revision log capped to the most recent 25 entries.
    expect(saved.revisions).toHaveLength(25);
    expect(saved.revisions[saved.revisions.length - 1]?.input).toBe("dump 39");

    const loaded = await getProjectSummary("proj-1");
    expect(loaded?.markdown).toContain("All good.");
    expect(loaded?.model).toBe("anthropic:claude-haiku");
    expect(loaded?.revisions).toHaveLength(25);
  });
});
