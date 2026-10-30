/**
 * Release-publisher continuous workflow.
 *
 * A daemon tick that watches in-flight coder agents and the git working tree,
 * then auto-commits + pushes finished work in logical scope buckets and updates
 * the open PR — entirely locally, no GitHub Actions.
 *
 * Each tick (default 60s) does, in order:
 *   1. Kill switch — bail if `<stateDir>/release-publisher.paused` exists.
 *   2. Quiet check — skip while any (optionally hint-matched) subagent is live.
 *   3. Dirty check — skip if the working tree is clean.
 *   4. Build — `<pm> run build`; never commit a broken build.
 *   5. Pack drift — verify files[] whitelist still covers every src/ subdir.
 *   6. Commit by scope — mobile/* , ui/*, src/gateway/*, src/*, docs/*, chore.
 *   7. Push to origin/<branch>.
 *   8. `gh pr comment <pr>` with a short summary.
 *
 * Honors RELEASE_PUBLISHER_DRY_RUN=1 (do everything except commit/push/comment).
 */

import {
  registerNativeContinuousTick,
  type NativeTickContext,
  type NativeTickResult,
} from "../workflows/continuous-runner.js";
import { WorkflowStore } from "../workflows/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import { listActiveSubagentRuns } from "../agents/subagent-registry.js";
import { callGateway } from "../gateway/call.js";

import {
  loadConfig,
  loadState,
  saveState,
  isPaused,
  isDryRun,
  pausedFlagPath,
  type ReleasePublisherConfig,
  type ReleasePublisherState,
} from "./config.js";
import {
  detectPackageManager,
  currentBranch,
  headSha,
  changedFiles,
  bucketByScope,
  commitMessageFor,
  runBuild,
  checkPackDrift,
  stageAndCommit,
  push as gitPush,
  prComment,
} from "./git-ops.js";

const log = createSubsystemLogger("release").child("publisher");

export const RELEASE_PUBLISHER_WORKFLOW_ID = "release-publisher-v1";

// ── Subagent gating ──────────────────────────────────────────────────

/**
 * Returns the labels of in-flight subagents that should block this tick. With
 * an empty hint list, ANY active subagent blocks. Otherwise only those whose
 * label/task/workdir matches a hint (case-insensitive substring).
 */
export function blockingSubagents(hints: string[]): string[] {
  const active = listActiveSubagentRuns();
  const lowered = hints.map((h) => h.toLowerCase()).filter(Boolean);
  const matches = active.filter((run) => {
    if (lowered.length === 0) return true;
    const hay = `${run.label ?? ""} ${run.task ?? ""} ${run.workdir ?? ""}`.toLowerCase();
    return lowered.some((h) => hay.includes(h));
  });
  return matches.map((r) => r.label ?? r.runId);
}

// ── The tick ─────────────────────────────────────────────────────────

export interface TickReport {
  skipped: boolean;
  reason?: string;
  scopes: string[];
  fileCount: number;
  commits: number;
  pushed: boolean;
  commented: boolean;
  dryRun: boolean;
  error?: string;
}

export async function runReleasePublisherTick(
  ctx: Pick<NativeTickContext, "log" | "signal" | "inputs">,
  stateDir = resolveStateDir(),
): Promise<TickReport> {
  const dryRun = isDryRun();
  const cfg = mergeInputs(loadConfig(stateDir), ctx.inputs);
  const report: TickReport = {
    skipped: true,
    scopes: [],
    fileCount: 0,
    commits: 0,
    pushed: false,
    commented: false,
    dryRun,
  };
  const { log: tlog, signal } = ctx;

  // 1. Kill switch.
  if (isPaused(stateDir)) {
    report.reason = `paused (kill switch at ${pausedFlagPath(stateDir)})`;
    tlog(report.reason);
    return report;
  }

  const repoDir = cfg.repoDir;
  const branch = cfg.branch ?? (await currentBranch(repoDir, signal));
  if (!branch) {
    report.reason = "could not resolve git branch";
    tlog(report.reason);
    return report;
  }

  // 2. Quiet check — don't commit while coder agents are still mutating the tree.
  const blockers = blockingSubagents(cfg.waitProjectHints);
  if (blockers.length > 0) {
    report.reason = `waiting on ${blockers.length} in-flight subagent(s): ${blockers
      .slice(0, 5)
      .join(", ")}`;
    tlog(report.reason);
    return report;
  }

  // 3. Dirty check.
  const changes = await changedFiles(repoDir, signal);
  if (changes.length === 0) {
    report.reason = "working tree clean";
    tlog(report.reason);
    return report;
  }
  report.fileCount = changes.length;
  tlog(`${changes.length} changed file(s) on ${branch}`);

  const pm = detectPackageManager(repoDir, cfg.packageManager);

  // 4. Build gate.
  if (cfg.runBuild) {
    tlog(`building with ${pm}…`);
    const build = await runBuild(repoDir, pm, cfg.buildTimeoutMs, signal);
    if (!build.ok) {
      const message = firstLines(build.stderr, 20);
      tlog(`build FAILED in ${build.durationMs}ms — skipping (not committing broken build)`);
      await recordError(stateDir, "build_failed", message);
      await maybePostBuildFailureTask(branch, message, dryRun, tlog);
      report.reason = "build failed";
      report.error = message;
      return report;
    }
    tlog(`build ok in ${build.durationMs}ms`);
  }

  // 5. Pack drift gate.
  if (cfg.checkPackDrift) {
    const drift = await checkPackDrift(repoDir, signal);
    if (!drift.ok && drift.missing.length > 0) {
      const message = `files[] whitelist drift — src/ subdir(s) not in published tarball: ${drift.missing.join(
        ", ",
      )}. Add dist/<subdir>/** to package.json files[] before publishing.`;
      tlog(message);
      await recordError(stateDir, "pack_drift", message);
      report.reason = "pack drift";
      report.error = message;
      return report;
    }
    if (!drift.ok) {
      tlog("pack drift check inconclusive (npm pack failed) — proceeding cautiously");
    }
  }

  // 6. Commit by scope.
  const buckets = bucketByScope(changes.map((c) => c.path));
  tlog(`committing ${buckets.length} scope bucket(s): ${buckets.map((b) => b.scope).join(", ")}`);
  const committed: string[] = [];
  for (const bucket of buckets) {
    if (signal.aborted) {
      report.reason = "aborted mid-commit";
      break;
    }
    const msg = commitMessageFor(bucket);
    if (dryRun) {
      tlog(`[dry-run] would commit ${bucket.files.length} file(s) as "${msg.split("\n")[0]}"`);
      committed.push(bucket.scope);
      continue;
    }
    const res = await stageAndCommit(repoDir, bucket.files, msg, signal);
    if (!res.ok) {
      tlog(`commit failed for scope ${bucket.scope}: ${res.error}`);
      report.error = res.error;
      continue;
    }
    tlog(`committed ${bucket.files.length} file(s) [${bucket.scope}]`);
    committed.push(bucket.scope);
    report.commits++;
  }
  report.scopes = committed;
  if (committed.length === 0) {
    report.reason = "nothing committed";
    return report;
  }
  report.skipped = false;

  // 7. Push.
  if (cfg.push) {
    if (dryRun) {
      tlog(`[dry-run] would push to ${cfg.remote}/${branch}`);
      report.pushed = true;
    } else {
      const res = await gitPush(repoDir, cfg.remote, branch, signal);
      if (res.ok) {
        report.pushed = true;
        tlog(`pushed to ${cfg.remote}/${branch}`);
      } else {
        tlog(`push failed: ${res.error}`);
        report.error = res.error;
      }
    }
  }

  // 8. PR comment.
  if (cfg.prNumber != null && report.pushed) {
    const body = renderPrComment(report, branch);
    if (dryRun) {
      tlog(`[dry-run] would comment on PR #${cfg.prNumber}`);
      report.commented = true;
    } else {
      const res = await prComment(repoDir, cfg.prNumber, body, signal);
      if (res.ok) {
        report.commented = true;
        tlog(`posted summary to PR #${cfg.prNumber}`);
      } else {
        tlog(`gh pr comment failed: ${res.error}`);
      }
    }
  }

  // Persist state.
  if (!dryRun && report.commits > 0) {
    const sha = await headSha(repoDir, signal);
    const prev = loadState(stateDir);
    const next: ReleasePublisherState = {
      ...prev,
      lastPublishedSha: sha ?? prev.lastPublishedSha,
      lastPublishedAt: new Date().toISOString(),
      lastScopes: report.scopes,
      totalCommits: (prev.totalCommits ?? 0) + report.commits,
      lastError: undefined,
    };
    saveState(next, stateDir);
  }

  return report;
}

// ── Helpers ──────────────────────────────────────────────────────────

function mergeInputs(
  cfg: ReleasePublisherConfig,
  inputs: Record<string, unknown>,
): ReleasePublisherConfig {
  const out = { ...cfg };
  if (typeof inputs.branch === "string" && inputs.branch.trim()) out.branch = inputs.branch.trim();
  if (typeof inputs.prNumber === "number") out.prNumber = inputs.prNumber;
  else if (typeof inputs.prNumber === "string" && inputs.prNumber.trim())
    out.prNumber = Number(inputs.prNumber) || out.prNumber;
  if (typeof inputs.repoDir === "string" && inputs.repoDir.trim())
    out.repoDir = inputs.repoDir.trim();
  if (typeof inputs.waitProjectHints === "string" && inputs.waitProjectHints.trim()) {
    out.waitProjectHints = inputs.waitProjectHints
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(inputs.waitProjectHints)) {
    out.waitProjectHints = inputs.waitProjectHints.map(String);
  }
  return out;
}

function firstLines(text: string, n: number): string {
  return text.split("\n").slice(0, n).join("\n").trim();
}

async function recordError(stateDir: string, kind: string, message: string): Promise<void> {
  const prev = loadState(stateDir);
  saveState({ ...prev, lastError: { kind, message, at: new Date().toISOString() } }, stateDir);
}

async function maybePostBuildFailureTask(
  branch: string,
  message: string,
  dryRun: boolean,
  tlog: (l: string) => void,
): Promise<void> {
  if (dryRun) {
    tlog("[dry-run] would post a kanban task for the build failure");
    return;
  }
  try {
    await callGateway({
      method: "kanban.tasks.create",
      params: {
        title: `release-publisher: build failed on ${branch}`,
        description: `The release-publisher daemon refused to commit because \`build\` failed:\n\n\`\`\`\n${firstLines(
          message,
          30,
        )}\n\`\`\``,
        status: "todo",
        priority: "high",
      },
      timeoutMs: 15_000,
    });
    tlog("filed a kanban task for the build failure");
  } catch (err) {
    tlog(
      `could not file kanban task (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function renderPrComment(report: TickReport, branch: string): string {
  const scopes = report.scopes.join(", ");
  return [
    `🤖 **release-publisher** auto-published to \`${branch}\``,
    "",
    `- **${report.commits}** commit(s) across scopes: ${scopes}`,
    `- **${report.fileCount}** file(s) total`,
    report.dryRun ? "- _(dry run)_" : "",
    "",
    "_Posted by the InfiniBot release-publisher continuous workflow._",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ── Workflow registration + native-tick wiring ───────────────────────

const WORKFLOW_BODY = `# Release Publisher (continuous)

Watches in-flight coder agents and the git working tree, then auto-commits +
pushes finished work in logical scope buckets and updates the open PR — no
GitHub Actions.

Each tick:
1. Bail if the kill switch \`~/.infinibot/release-publisher.paused\` exists.
2. Skip while any (optionally hint-matched) subagent is still running.
3. Skip if the working tree is clean.
4. Run \`build\`; never commit a broken build (files a kanban task instead).
5. Verify the npm files[] whitelist still covers every src/ subdir.
6. Commit by scope (mobile / ui / gateway / core / docs / chore).
7. Push to the configured branch.
8. Post a summary via \`gh pr comment\`.

Config: \`~/.infinibot/release-publisher.json\`. Dry run: \`RELEASE_PUBLISHER_DRY_RUN=1\`.
This workflow runs a native code tick (no agent spawn per iteration).`;

/** Register the workflow definition in the store (idempotent). */
export function ensureReleasePublisherWorkflow(stateDir = resolveStateDir()): void {
  try {
    const store = new WorkflowStore(stateDir);
    const existing = store.get(RELEASE_PUBLISHER_WORKFLOW_ID);
    if (existing) return;
    store.create({
      id: RELEASE_PUBLISHER_WORKFLOW_ID,
      name: "Release Publisher",
      description:
        "Auto-commit + push finished coder work to the open PR once agents are idle (no GitHub Actions).",
      tags: ["release", "ci", "continuous", "autonomy"],
      author: "release-publisher",
      kind: "continuous",
      body: WORKFLOW_BODY,
      continuous: {
        iterationIntervalSeconds: 60,
        maxIterations: null,
        iterationTimeoutSeconds: 900,
        errorStreakThreshold: 0, // never auto-stop; transient build fails are normal
        stopOn: ["manual"],
      },
      inputs: [
        {
          name: "branch",
          label: "Target branch",
          type: "string",
          description: "Branch to commit + push to. Blank = repo's current branch.",
          required: false,
        },
        {
          name: "prNumber",
          label: "PR number",
          type: "number",
          description: "PR to post summaries on. Blank = config default.",
          required: false,
        },
        {
          name: "waitProjectHints",
          label: "Wait-on project hints (comma-separated)",
          type: "string",
          description:
            "Only wait on subagents whose label/task/workdir matches one of these. Blank = wait on ANY in-flight subagent.",
          required: false,
        },
      ],
    });
    log.info(`registered continuous workflow ${RELEASE_PUBLISHER_WORKFLOW_ID}`);
  } catch (err) {
    log.warn(
      `ensureReleasePublisherWorkflow failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

let nativeTickRegistered = false;

/** Wire the native code tick into the continuous runner (idempotent). */
export function registerReleasePublisherTick(): void {
  if (nativeTickRegistered) return;
  nativeTickRegistered = true;
  registerNativeContinuousTick(
    RELEASE_PUBLISHER_WORKFLOW_ID,
    async (ctx: NativeTickContext): Promise<NativeTickResult> => {
      try {
        const report = await runReleasePublisherTick(ctx);
        if (report.error) {
          return { ok: false, error: report.error };
        }
        const summary = report.skipped
          ? `skipped: ${report.reason ?? "no-op"}`
          : `published ${report.commits} commit(s) [${report.scopes.join(", ")}]` +
            `${report.pushed ? " · pushed" : ""}${report.commented ? " · commented" : ""}` +
            `${report.dryRun ? " (dry-run)" : ""}`;
        return { ok: true, summary };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

/** Boot entry point: register the workflow + native tick. Call once at gateway start. */
export function initReleasePublisher(stateDir = resolveStateDir()): void {
  ensureReleasePublisherWorkflow(stateDir);
  registerReleasePublisherTick();
}
