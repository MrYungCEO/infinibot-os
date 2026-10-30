/**
 * Work-review emitter — turns a finalized coder run into an operator-visible
 * review across three surfaces:
 *
 *   1. A HoloCanvas-style scene (header / checkpoint timeline / step checklist /
 *      screenshot gallery / verdict badge) saved to the core saved-canvas store and
 *      viewable at /canvas/:id.
 *   2. A "Work Review" chip on the run's kanban task card (via the run record —
 *      the kanban UI's subagents.list poller renders it) plus a permanent task
 *      note with the canvas link.
 *   3. A categorized report (black-gold PDF + markitdown parity copy) registered
 *      in the reports system and linked back to the run/task.
 *
 * When the run was spawned with verify enabled, the emitter first awaits the
 * auto-verify stage (see auto-verify.ts) so verification.md exists before the
 * review is built.
 *
 * FAULT ISOLATION IS THE PRIME DIRECTIVE HERE: this runs off the back of run
 * finalization. Every sub-step catches its own errors, and the whole pipeline
 * catches at the top — a review failure logs loudly but can never break
 * finalize. `runWorkReviewPipeline` never rejects.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getSavedCanvasStore } from "../canvas-host/saved-canvases.js";
import { markdownToPayload } from "../reports/helpers/markdown-to-payload.js";
import { renderReport } from "../reports/render.js";
import { ingestExternalPdf } from "../reports/helpers/external-pdf.js";
import { fireEventTriggers } from "../reports/trigger.js";
import { emitWorkEvent } from "../workload/emitter.js";
import { readRunArtifacts, type RunArtifacts } from "./artifacts/contract.js";
import { maybeSpawnAutoVerifier, type AutoVerifyResult } from "./auto-verify.js";
import { listCheckpoints } from "./subagent-progress.js";
import { mcpAppendTaskNote } from "./tools/kanban-tool.js";
import { updateSubagentRunWorkReview } from "./subagent-registry.js";
import {
  buildWorkReviewCanvasPayload,
  resolveVerdict,
  formatDuration,
  type WorkReviewData,
  type WorkReviewShot,
  type WorkReviewVerdict,
} from "./work-review-canvas.js";
import type { CoderBackendId } from "./coder-backend/types.js";

const log = createSubsystemLogger("agents/work-review");

/** Screenshots larger than this are listed but not inlined into the canvas. */
const MAX_INLINE_SHOT_BYTES = 1_500_000;
const MAX_INLINE_SHOTS = 12;

export interface WorkReviewRunInput {
  runId: string;
  label: string;
  task: string;
  backendId: CoderBackendId | string;
  workdir: string;
  kanbanTaskId?: string;
  startedAt: number;
  endedAt: number;
  /** Null when the artifacts dir could not be created at spawn time. */
  artifactsDir: string | null;
  verifyEnabled: boolean;
  succeeded: boolean;
}

/** Injectable seams so the pipeline is unit-testable without real stores. */
export interface WorkReviewDeps {
  autoVerify?: typeof maybeSpawnAutoVerifier;
  readArtifacts?: (dir: string) => RunArtifacts;
  saveCanvas?: (opts: {
    title: string;
    payload: ReturnType<typeof buildWorkReviewCanvasPayload>;
    tags: string[];
  }) => { id: string };
  saveReport?: (args: {
    markdown: string;
    title: string;
    input: WorkReviewRunInput;
    verdict: WorkReviewVerdict;
  }) => Promise<string | null>;
  appendTaskNote?: (taskId: string, note: string) => Promise<boolean>;
  updateRunRecord?: typeof updateSubagentRunWorkReview;
  emitActivity?: typeof emitWorkEvent;
  listRunCheckpoints?: typeof listCheckpoints;
  getDiffstat?: (workdir: string) => Promise<string | null>;
}

export interface WorkReviewResult {
  ok: boolean;
  canvasId?: string;
  reportId?: string;
  verdict?: WorkReviewVerdict;
  autoVerify?: AutoVerifyResult;
  warnings: string[];
  error?: string;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort `git diff --shortstat` for the run's workdir. */
async function defaultGetDiffstat(workdir: string): Promise<string | null> {
  const git = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["-C", workdir, ...args],
        { timeout: 5_000, maxBuffer: 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  try {
    const inside = (await git(["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return null;
    const stat = (await git(["diff", "--shortstat", "HEAD"])).trim();
    return stat || "no uncommitted changes";
  } catch {
    return null;
  }
}

/** Load contract shots as bounded data-URIs for the gallery grid. */
function loadShotDataUrls(artifacts: RunArtifacts): WorkReviewShot[] {
  return artifacts.shots.slice(0, MAX_INLINE_SHOTS).map((s) => {
    const shot: WorkReviewShot = { file: s.file, step: s.step, viewport: s.viewport };
    try {
      if (statSync(s.path).size <= MAX_INLINE_SHOT_BYTES) {
        shot.dataUrl = `data:image/png;base64,${readFileSync(s.path).toString("base64")}`;
      }
    } catch {
      /* unreadable shot → listed without preview */
    }
    return shot;
  });
}

/** Compose the markdown body for the categorized report copy. */
export function buildWorkReviewMarkdown(
  input: WorkReviewRunInput,
  data: WorkReviewData,
  verdict: WorkReviewVerdict,
): string {
  const lines: string[] = [];
  lines.push(`# Work Review — ${input.label}`);
  lines.push("");
  lines.push(`_Automated review of coder run \`${input.runId}\`._`);
  lines.push("");
  lines.push("## Run summary");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Verdict | ${verdict} |`);
  lines.push(`| Backend | ${input.backendId} |`);
  lines.push(`| Duration | ${formatDuration(input.endedAt - input.startedAt)} |`);
  lines.push(`| Exit | ${input.succeeded ? "clean" : "with issues"} |`);
  lines.push(`| Workdir | ${input.workdir} |`);
  if (data.diffstat) lines.push(`| Diffstat | ${data.diffstat} |`);
  if (input.kanbanTaskId) lines.push(`| Kanban task | ${input.kanbanTaskId} |`);
  lines.push("");

  if (data.steps.length) {
    lines.push("## Steps");
    lines.push("");
    lines.push("| Step | Status | Note |");
    lines.push("| --- | --- | --- |");
    for (const s of data.steps) {
      lines.push(`| ${s.title} | ${s.status} | ${s.note ?? ""} |`);
    }
    lines.push("");
  }

  if (data.verification.claims.length || data.verification.verdict) {
    lines.push("## Verification");
    lines.push("");
    if (data.verification.claims.length) {
      lines.push("| Claim | Result |");
      lines.push("| --- | --- |");
      for (const c of data.verification.claims) lines.push(`| ${c.claim} | ${c.status} |`);
      lines.push("");
    }
    lines.push(`Overall: ${data.verification.verdict ?? "no verdict recorded"}`);
    lines.push("");
  }

  if (data.checkpoints.length) {
    lines.push("## Check-in timeline");
    lines.push("");
    for (const cp of data.checkpoints) {
      const at = formatDuration(cp.ts - input.startedAt);
      lines.push(
        `- +${at} — ${cp.summary}${cp.deviations.length ? ` (⚠ ${cp.deviations.join("; ")})` : ""}`,
      );
    }
    lines.push("");
  }

  if (data.shots.length) {
    lines.push("## Screenshots");
    lines.push("");
    for (const s of data.shots) lines.push(`- ${s.file}`);
    lines.push("");
  }

  if (data.reportMd.trim()) {
    lines.push("## Agent's own report");
    lines.push("");
    lines.push(data.reportMd.trim().slice(0, 6000));
    lines.push("");
  }
  return lines.join("\n");
}

/** Default report step: render the black-gold PDF and register it with parity. */
async function defaultSaveReport(args: {
  markdown: string;
  title: string;
  input: WorkReviewRunInput;
  verdict: WorkReviewVerdict;
}): Promise<string | null> {
  const payload = markdownToPayload(args.markdown, {
    title: args.title,
    eyebrow: "InfiniBot · Work Review",
    footer: `run ${args.input.runId} · ${args.verdict}`,
  });
  const savePath = join(tmpdir(), `work-review-${args.input.runId}.pdf`);
  await renderReport(payload, { savePath });
  const record = ingestExternalPdf({
    path: savePath,
    kind: "work_review",
    title: args.title,
    summaryText: `${args.verdict} · ${args.input.backendId} · ${formatDuration(
      args.input.endedAt - args.input.startedAt,
    )}`,
    trigger: "event",
    association: {
      runId: args.input.runId,
      kanbanTaskId: args.input.kanbanTaskId ?? null,
    },
    sourceAgent: String(args.input.backendId),
  });
  return record.id;
}

/**
 * Run the full post-finalize review pipeline for a coder run.
 * NEVER throws / rejects — see module doc.
 */
export async function runWorkReviewPipeline(
  input: WorkReviewRunInput,
  deps: WorkReviewDeps = {},
): Promise<WorkReviewResult> {
  const warnings: string[] = [];
  try {
    // 1. Auto-verify (blocking, bounded) so verification.md exists before we read.
    let autoVerify: AutoVerifyResult | undefined;
    if (input.verifyEnabled && input.artifactsDir) {
      try {
        autoVerify = await (deps.autoVerify ?? maybeSpawnAutoVerifier)({
          runId: input.runId,
          task: input.task,
          backendId: (input.backendId as CoderBackendId) ?? "claude-code",
          workdir: input.workdir,
          artifactsDir: input.artifactsDir,
          verifyEnabled: true,
        });
        if (autoVerify.reason) warnings.push(`auto-verify: ${autoVerify.reason}`);
      } catch (err) {
        warnings.push(`auto-verify threw: ${msg(err)}`);
      }
    }

    // 2. Gather review inputs (all best-effort). A run with no artifacts dir
    // (pre-contract, or mkdir failed at spawn) reviews as contract-empty.
    const artifacts: RunArtifacts = input.artifactsDir
      ? (deps.readArtifacts ?? readRunArtifacts)(input.artifactsDir)
      : {
          dir: "",
          reportMd: "",
          steps: [],
          stepsErrors: [],
          shots: [],
          verificationMd: "",
          verification: { verdict: null, claims: [] },
        };
    if (artifacts.stepsErrors.length) {
      warnings.push(`steps.json issues: ${artifacts.stepsErrors.join("; ")}`);
    }
    let diffstat: string | null = null;
    try {
      diffstat = await (deps.getDiffstat ?? defaultGetDiffstat)(input.workdir);
    } catch (err) {
      warnings.push(`diffstat failed: ${msg(err)}`);
    }
    let checkpoints: WorkReviewData["checkpoints"] = [];
    try {
      checkpoints = (deps.listRunCheckpoints ?? listCheckpoints)(input.runId).map((cp) => ({
        ts: cp.ts,
        summary: cp.summary,
        next: cp.next,
        deviations: cp.deviations,
      }));
    } catch (err) {
      warnings.push(`checkpoints unavailable: ${msg(err)}`);
    }

    const data: WorkReviewData = {
      runId: input.runId,
      label: input.label,
      task: input.task,
      backend: String(input.backendId),
      startedAt: input.startedAt,
      durationMs: input.endedAt - input.startedAt,
      diffstat,
      steps: artifacts.steps,
      shots: loadShotDataUrls(artifacts),
      checkpoints,
      verification: artifacts.verification,
      verifyEnabled: input.verifyEnabled,
      reportMd: artifacts.reportMd,
      succeeded: input.succeeded,
    };
    const verdict = resolveVerdict(data);

    // 3. Canvas scene → saved-canvas store (core; /canvas/:id works without the library plugin).
    let canvasId: string | undefined;
    try {
      const payload = buildWorkReviewCanvasPayload(data);
      const save =
        deps.saveCanvas ??
        ((opts: { title: string; payload: typeof payload; tags: string[] }) =>
          getSavedCanvasStore().save(opts));
      canvasId = save({
        title: payload.title ?? `Work Review — ${input.label}`,
        payload,
        tags: ["work-review", verdict.toLowerCase()],
      }).id;
    } catch (err) {
      warnings.push(`canvas save failed: ${msg(err)}`);
      log.error("work-review: canvas save failed", { runId: input.runId, error: msg(err) });
    }

    // 4. Run record → powers the kanban card chip via subagents.list.
    try {
      (deps.updateRunRecord ?? updateSubagentRunWorkReview)(input.runId, {
        canvasId,
        verdict,
        emittedAt: Date.now(),
      });
    } catch (err) {
      warnings.push(`run-record update failed: ${msg(err)}`);
    }

    // 5. Permanent kanban note with the canvas link.
    if (input.kanbanTaskId && canvasId) {
      try {
        await (deps.appendTaskNote ?? mcpAppendTaskNote)(
          input.kanbanTaskId,
          [
            `📋 Work Review ready — verdict: ${verdict}`,
            `Canvas: /canvas/${canvasId}`,
            `<!-- work-review runId:${input.runId} canvasId:${canvasId} verdict:${verdict} -->`,
          ].join("\n"),
        );
      } catch (err) {
        warnings.push(`kanban note failed: ${msg(err)}`);
      }
    }

    // 6. Activity feed entry.
    try {
      (deps.emitActivity ?? emitWorkEvent)({
        kind: "work_review_emitted",
        source: "subagent_registry",
        label: `Work review: ${input.label} — ${verdict}`,
        runId: input.runId,
        taskId: input.kanbanTaskId,
        durationMs: input.endedAt - input.startedAt,
        metadata: { canvasId, verdict, shots: data.shots.length, steps: data.steps.length },
      });
    } catch (err) {
      warnings.push(`activity emit failed: ${msg(err)}`);
    }

    // 7. Categorized report with parity copy + any configured event triggers.
    let reportId: string | undefined;
    try {
      const title = `Work Review — ${input.label}`;
      const markdown = buildWorkReviewMarkdown(input, data, verdict);
      reportId =
        (await (deps.saveReport ?? defaultSaveReport)({
          markdown,
          title,
          input,
          verdict,
        })) ?? undefined;
    } catch (err) {
      warnings.push(`report save failed: ${msg(err)}`);
      log.error("work-review: report save failed", { runId: input.runId, error: msg(err) });
    }
    try {
      fireEventTriggers("work_review", { runId: input.runId, canvasId, verdict });
    } catch {
      /* best-effort */
    }

    if (warnings.length) {
      log.warn("work-review emitted with warnings", { runId: input.runId, warnings });
    } else {
      log.info("work-review emitted", { runId: input.runId, canvasId, reportId, verdict });
    }
    return { ok: true, canvasId, reportId, verdict, autoVerify, warnings };
  } catch (err) {
    // The loud-but-contained failure path: finalization must never notice.
    log.error("WORK-REVIEW EMITTER FAILED (run finalization unaffected)", {
      runId: input.runId,
      error: msg(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return { ok: false, warnings, error: msg(err) };
  }
}
