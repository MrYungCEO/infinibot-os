import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkReviewPipeline, type WorkReviewDeps, type WorkReviewRunInput } from "./work-review.js";
import { buildWorkReviewCanvasPayload, resolveVerdict } from "./work-review-canvas.js";

const tmpDirs: string[] = [];
function makeArtifactsDir(opts: { verdict?: "SHIP" | "DO-NOT-SHIP" | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "work-review-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "shots"), { recursive: true });
  writeFileSync(join(dir, "report.md"), "# Summary\nDid the thing.");
  writeFileSync(
    join(dir, "steps.json"),
    JSON.stringify([
      { id: "01-a", title: "Step A", status: "done" },
      { id: "02-b", title: "Step B", status: "failed", note: "flaky" },
    ]),
  );
  // Tiny valid-enough PNG bytes (content is never decoded server-side).
  writeFileSync(join(dir, "shots", "01-a-desktop.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "shots", "01-a-mobile.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (opts.verdict) {
    writeFileSync(
      join(dir, "verification.md"),
      `| Claim | Result |\n| --- | --- |\n| builds | PASS |\n\n${opts.verdict}`,
    );
  }
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function baseInput(artifactsDir: string | null): WorkReviewRunInput {
  return {
    runId: "coder-test-review",
    label: "Test run",
    task: "Do the thing.\nAcceptance: it works",
    backendId: "claude-code",
    workdir: "/tmp",
    kanbanTaskId: "task-1",
    startedAt: 1_000,
    endedAt: 61_000,
    artifactsDir,
    verifyEnabled: false,
    succeeded: true,
  };
}

function happyDeps() {
  const saveCanvas = vi.fn(() => ({ id: "canvas-123" }));
  const saveReport = vi.fn(async () => "report-456");
  const appendTaskNote = vi.fn(async () => true);
  const updateRunRecord = vi.fn(() => true);
  const emitActivity = vi.fn();
  const deps: WorkReviewDeps = {
    saveCanvas,
    saveReport,
    appendTaskNote,
    updateRunRecord,
    emitActivity,
    listRunCheckpoints: () => [],
    getDiffstat: async () => "2 files changed, 10 insertions(+)",
  };
  return { deps, saveCanvas, saveReport, appendTaskNote, updateRunRecord, emitActivity };
}

describe("runWorkReviewPipeline — happy path", () => {
  it("emits canvas + chip + note + activity + report from a contract artifacts dir", async () => {
    const dir = makeArtifactsDir({ verdict: "SHIP" });
    const h = happyDeps();
    const res = await runWorkReviewPipeline(baseInput(dir), h.deps);

    expect(res.ok).toBe(true);
    expect(res.canvasId).toBe("canvas-123");
    expect(res.reportId).toBe("report-456");
    expect(res.verdict).toBe("PASS");

    const payload = h.saveCanvas.mock.calls[0][0].payload;
    expect(payload.nodes.find((n: { id: string }) => n.id === "verdict")).toBeTruthy();
    expect(payload.nodes.filter((n: { kind: string }) => n.kind === "image")).toHaveLength(2);
    expect(h.appendTaskNote).toHaveBeenCalledWith("task-1", expect.stringContaining("canvas-123"));
    expect(h.updateRunRecord).toHaveBeenCalledWith(
      "coder-test-review",
      expect.objectContaining({ canvasId: "canvas-123", verdict: "PASS" }),
    );
    expect(h.emitActivity).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "work_review_emitted", runId: "coder-test-review" }),
    );
  });

  it("maps DO-NOT-SHIP to FAIL and missing verification to UNVERIFIED", async () => {
    const h1 = happyDeps();
    const res1 = await runWorkReviewPipeline(
      baseInput(makeArtifactsDir({ verdict: "DO-NOT-SHIP" })),
      h1.deps,
    );
    expect(res1.verdict).toBe("FAIL");

    const h2 = happyDeps();
    const res2 = await runWorkReviewPipeline(baseInput(makeArtifactsDir()), h2.deps);
    expect(res2.verdict).toBe("UNVERIFIED");
  });

  it("still emits a review for a run that ignored the contract (empty dir)", async () => {
    const h = happyDeps();
    const res = await runWorkReviewPipeline(baseInput(null), h.deps);
    expect(res.ok).toBe(true);
    expect(h.saveCanvas).toHaveBeenCalled(); // header + verdict nodes still render
    expect(res.verdict).toBe("UNVERIFIED");
  });
});

describe("runWorkReviewPipeline — fault isolation", () => {
  it("a failing canvas save degrades to a warning, everything else still runs", async () => {
    const h = happyDeps();
    h.deps.saveCanvas = () => {
      throw new Error("sqlite locked");
    };
    const res = await runWorkReviewPipeline(baseInput(makeArtifactsDir()), h.deps);
    expect(res.ok).toBe(true);
    expect(res.canvasId).toBeUndefined();
    expect(res.warnings.join()).toMatch(/canvas save failed/);
    expect(res.reportId).toBe("report-456"); // report step still ran
    expect(h.emitActivity).toHaveBeenCalled();
  });

  it("EVERY dependency throwing still never rejects (finalize protection)", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const deps: WorkReviewDeps = {
      readArtifacts: boom as never,
      saveCanvas: boom as never,
      saveReport: async () => {
        throw new Error("boom");
      },
      appendTaskNote: async () => {
        throw new Error("boom");
      },
      updateRunRecord: boom as never,
      emitActivity: boom as never,
      listRunCheckpoints: boom as never,
      getDiffstat: async () => {
        throw new Error("boom");
      },
    };
    // readArtifacts throwing hits the top-level catch: ok:false, but resolved.
    await expect(runWorkReviewPipeline(baseInput(makeArtifactsDir()), deps)).resolves.toMatchObject(
      { ok: false },
    );
  });

  it("auto-verify throwing is contained and the review still emits", async () => {
    const h = happyDeps();
    h.deps.autoVerify = async () => {
      throw new Error("verifier exploded");
    };
    const input = { ...baseInput(makeArtifactsDir()), verifyEnabled: true };
    const res = await runWorkReviewPipeline(input, h.deps);
    expect(res.ok).toBe(true);
    expect(res.warnings.join()).toMatch(/auto-verify threw/);
    expect(res.canvasId).toBe("canvas-123");
  });
});

describe("buildWorkReviewCanvasPayload", () => {
  it("renders viewport badges on gallery nodes and a scene per section", () => {
    const payload = buildWorkReviewCanvasPayload({
      runId: "r",
      label: "L",
      task: "t",
      backend: "claude-code",
      startedAt: 0,
      durationMs: 90_000,
      diffstat: "1 file changed",
      steps: [{ id: "01", title: "A", status: "done" }],
      shots: [
        { file: "01-a-mobile.png", step: "01-a", viewport: "mobile", dataUrl: "data:image/png;base64,AA==" },
        { file: "01-a-desktop.png", step: "01-a", viewport: "desktop", dataUrl: "data:image/png;base64,AA==" },
      ],
      checkpoints: [{ ts: 30_000, summary: "half way", next: "finish", deviations: [] }],
      verification: { verdict: "SHIP", claims: [{ claim: "c", status: "PASS" }] },
      verifyEnabled: true,
      reportMd: "",
      succeeded: true,
    });
    const kickers = payload.nodes.filter((n) => n.kind === "image").map((n) => n.kicker);
    expect(kickers).toContain("MOBILE · 375×812");
    expect(kickers).toContain("DESKTOP · 1440×900");
    expect(payload.scenes.map((s) => s.id)).toEqual(
      expect.arrayContaining(["s-header", "s-verdict", "s-steps", "s-timeline", "s-shots"]),
    );
    expect(resolveVerdict({ verification: { verdict: "SHIP", claims: [] }, verifyEnabled: true })).toBe(
      "PASS",
    );
  });
});
