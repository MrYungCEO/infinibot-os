/**
 * Live smoke test for the work-review emitter.
 *
 * Simulates a completed coder run: builds a contract-shaped artifacts dir
 * (report.md + steps.json + verification.md + 2 real screenshots), then invokes
 * `runWorkReviewPipeline` directly against the REAL state dir. Verifies:
 *   1. the canvas scene landed in canvas-library (queryable by id),
 *   2. the report row landed in the reports store (ready, PDF on disk),
 *   3. the markitdown parity copy attached (markdownPath + body).
 *
 * Usage: node --import tsx scripts/smoke-work-review.mts [--shots <dir>]
 * Exits 0 on full pass; 1 with a failure list otherwise.
 */

import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureRunArtifactsDir } from "../src/agents/artifacts/contract.js";
import { runWorkReviewPipeline } from "../src/agents/work-review.js";
import { getCanvasLibraryStore } from "../src/canvas-library/store.js";
import { getReportsStore } from "../src/reports/store.js";

const shotsArg = process.argv.indexOf("--shots");
const shotsSrc = shotsArg > -1 ? process.argv[shotsArg + 1] : "/tmp/smoke-shots";

const runId = `coder-smoke-workreview-${Date.now().toString(36)}`;
const dir = ensureRunArtifactsDir(runId);
if (!dir) {
  console.error("FAIL: could not create artifacts dir");
  process.exit(1);
}
console.log(`[smoke] artifacts dir: ${dir}`);

// ── 1. Fake a completed run per the contract ─────────────────────────────────
writeFileSync(
  join(dir, "report.md"),
  [
    "# Smoke run summary",
    "",
    "Simulated coder run for the work-review pipeline smoke test.",
    "Captured the live dashboard at both contract viewports via scripts/visual-verify.mjs.",
  ].join("\n"),
);
writeFileSync(
  join(dir, "steps.json"),
  JSON.stringify(
    [
      { id: "01-dashboard", title: "Capture dashboard at contract viewports", status: "done" },
      { id: "02-report", title: "Write run report", status: "done" },
      { id: "03-cleanup", title: "Optional cleanup", status: "skipped", note: "not needed" },
    ],
    null,
    2,
  ),
);
writeFileSync(
  join(dir, "verification.md"),
  [
    "# Verification",
    "",
    "| Claim | Result | Evidence |",
    "| --- | --- | --- |",
    "| Both contract viewports captured | PASS | shots/01-dashboard-{mobile,desktop}.png |",
    "| steps.json is ordered and valid | PASS | parsed 3 steps |",
    "",
    "Overall: SHIP",
  ].join("\n"),
);
const pngs = readdirSync(shotsSrc).filter((f) => f.endsWith(".png"));
if (pngs.length < 2) {
  console.error(`FAIL: expected 2+ shots in ${shotsSrc}, found ${pngs.length}`);
  process.exit(1);
}
for (const f of pngs) copyFileSync(join(shotsSrc, f), join(dir, "shots", f));
console.log(`[smoke] seeded ${pngs.length} screenshots`);

// ── 2. Invoke the emitter with production defaults ───────────────────────────
const started = Date.now() - 4 * 60_000;
const res = await runWorkReviewPipeline({
  runId,
  label: "Smoke: work-review pipeline",
  task: "Simulated run.\nAcceptance: dashboard captured at both contract viewports.",
  backendId: "claude-code",
  workdir: process.cwd(),
  kanbanTaskId: undefined, // no Notion writes from the smoke test
  startedAt: started,
  endedAt: Date.now(),
  artifactsDir: dir,
  verifyEnabled: false, // verification.md pre-seeded; do not spawn a real verifier
  succeeded: true,
});
console.log("[smoke] pipeline result:", JSON.stringify(res, null, 2));

const failures: string[] = [];
if (!res.ok) failures.push(`pipeline not ok: ${res.error}`);
if (res.verdict !== "PASS") failures.push(`expected PASS verdict, got ${res.verdict}`);

// ── 3. Canvas landed? ────────────────────────────────────────────────────────
if (!res.canvasId) {
  failures.push("no canvasId returned");
} else {
  const entry = getCanvasLibraryStore().get(res.canvasId);
  if (!entry) failures.push(`canvas ${res.canvasId} not found in canvas-library`);
  else {
    const imgs = entry.payload.nodes.filter((n) => n.kind === "image").length;
    console.log(
      `[smoke] canvas OK: "${entry.title}" — ${entry.payload.nodes.length} nodes (${imgs} images), ${entry.payload.scenes.length} scenes, tags=${entry.tags.join(",")}`,
    );
    console.log(`[smoke] canvas share URL: http://localhost:18789/canvas/${res.canvasId}`);
    if (imgs < 2) failures.push(`expected 2 image nodes in canvas, got ${imgs}`);
  }
}

// ── 4. Report landed (+ parity)? ─────────────────────────────────────────────
if (!res.reportId) {
  failures.push("no reportId returned");
} else {
  const store = getReportsStore();
  let report = store.getReport(res.reportId);
  if (!report) failures.push(`report ${res.reportId} not found`);
  else {
    if (report.status !== "ready" && report.status !== "sent")
      failures.push(`report status ${report.status}, expected ready`);
    if (!report.filePath || !existsSync(report.filePath))
      failures.push(`report PDF missing at ${report.filePath}`);
    else console.log(`[smoke] report OK: ${report.filePath} (${report.fileSize} bytes), kind=${report.kind}, category=${report.category}`);
    // Parity runs in the background — poll up to 60s for the markdown copy.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(report?.markdownPath && existsSync(report.markdownPath))) {
      await new Promise((r) => setTimeout(r, 2_000));
      report = store.getReport(res.reportId);
    }
    if (report?.markdownPath && existsSync(report.markdownPath)) {
      console.log(`[smoke] parity OK: ${report.markdownPath} (${report.markdownBody?.length ?? 0} chars)`);
    } else {
      failures.push("markitdown parity copy did not attach within 60s");
    }
  }
}

if (failures.length) {
  console.error(`\nSMOKE FAIL:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nSMOKE PASS — runId=${runId} canvasId=${res.canvasId} reportId=${res.reportId}`);
