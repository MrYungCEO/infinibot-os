/**
 * Deterministic assembly of a run review from a run's context — everything
 * except the agent-written summaryMarkdown (which derive() does not call the
 * model for, so it stays unit-testable without network).
 *
 * Sources:
 *   1. filesTouched — tracked by the registry during the run
 *   2. git diff --numstat — per-file line counts when in a git repo
 *   3. progress updates — condensed into the actions timeline
 *   4. progress + transcript text — scanned for build/typecheck evidence
 */

import { spawnSync } from "node:child_process";

import type {
  AgentKind,
  RunReviewAction,
  RunReviewFile,
  RunReviewForwardAction,
  RunReviewIssue,
  RunReviewStatus,
} from "./schema.js";

/** Raw context handed to derive() — assembled from the run record + progress. */
export type RunReviewInput = {
  runId: string;
  title: string;
  task: string;
  agentKind: AgentKind;
  backend?: string;
  model?: string;
  taskId?: string;
  kanbanTaskId?: string;
  projectId?: string;
  outcomeStatus?: "ok" | "error" | string;
  errorMessage?: string;
  startedAt: number;
  finishedAt?: number;
  workdir?: string;
  filesTouched?: Array<{ path: string; action: "created" | "edited" | "deleted" | "read" }>;
  /** Progress update messages, oldest → newest, with a coarse kind + ts. */
  progress?: Array<{ ts: number; kind: string; message: string }>;
};

/** The assembled deterministic parts, plus fields the summary prompt needs. */
export type RunReviewDraft = {
  runId: string;
  title: string;
  task: string;
  agentKind: AgentKind;
  backend?: string;
  model?: string;
  taskId?: string;
  kanbanTaskId?: string;
  projectId?: string;
  status: RunReviewStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  errorMessage?: string;
  filesTouched: RunReviewFile[];
  actions: RunReviewAction[];
  issues: RunReviewIssue[];
  built: boolean;
  buildEvidence?: string;
  forwardActions: RunReviewForwardAction[];
};

function mapChangeKind(action: string): RunReviewFile["changeKind"] {
  if (action === "created") return "added";
  if (action === "deleted") return "deleted";
  return "modified";
}

function getLineCountsFromGit(
  workdir: string,
  filePath: string,
): { added: number; removed: number } {
  try {
    const result = spawnSync("git", ["diff", "--numstat", "HEAD", "--", filePath], {
      cwd: workdir,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0 || !result.stdout?.trim()) return { added: 0, removed: 0 };
    const parts = (result.stdout.trim().split("\n")[0] ?? "").split(/\s+/);
    const added = parseInt(parts[0] ?? "0", 10);
    const removed = parseInt(parts[1] ?? "0", 10);
    return {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0,
    };
  } catch {
    return { added: 0, removed: 0 };
  }
}

function buildFiles(input: RunReviewInput): RunReviewFile[] {
  if (!input.filesTouched?.length) return [];
  // Dedupe by path, keep last non-read action.
  const seen = new Map<string, string>();
  for (const f of input.filesTouched) {
    if (f.action === "read") continue;
    seen.set(f.path, f.action);
  }
  const out: RunReviewFile[] = [];
  for (const [filePath, action] of seen) {
    const file: RunReviewFile = { path: filePath, changeKind: mapChangeKind(action) };
    if (input.workdir) {
      const counts = getLineCountsFromGit(input.workdir, filePath);
      if (counts.added || counts.removed) {
        file.linesAdded = counts.added;
        file.linesRemoved = counts.removed;
      }
    }
    out.push(file);
  }
  return out;
}

function buildActions(input: RunReviewInput): RunReviewAction[] {
  const updates = input.progress ?? [];
  // Cap at the most recent 40 meaningful steps.
  return updates
    .filter((u) => typeof u.message === "string" && u.message.trim().length > 0)
    .slice(-40)
    .map((u) => ({ ts: u.ts, kind: u.kind || "step", detail: u.message.slice(0, 400) }));
}

/** Regexes for build/typecheck evidence. Negative signals win over positive. */
const BUILD_POSITIVE =
  /(build (?:succeeded|passed|complete|successful))|(compiled successfully)|(tsc[^\n]*?(?:0 errors|no errors|clean))|(✓[^\n]*built)|(vite build[^\n]*(?:done|✓))|(pnpm[^\n]*build[^\n]*(?:done|success|✓))|(type ?check[^\n]*(?:passed|clean|ok))/i;
const BUILD_NEGATIVE =
  /(build failed)|(compilation failed)|(error TS\d{2,})|(\d+ error(?:s)?\s*\.?$)|(type ?error)|(cannot find module)|(tsc[^\n]*failed)/im;

function detectBuild(text: string): { built: boolean; evidence?: string } {
  if (!text) return { built: false };
  const neg = text.match(BUILD_NEGATIVE);
  if (neg) return { built: false, evidence: neg[0].slice(0, 200) };
  const pos = text.match(BUILD_POSITIVE);
  if (pos) return { built: true, evidence: pos[0].slice(0, 200) };
  return { built: false };
}

function deriveStatus(
  input: RunReviewInput,
  fileCount: number,
  built: boolean,
): RunReviewStatus {
  if (!input.finishedAt && !input.outcomeStatus) return "in_progress";
  if (input.outcomeStatus === "error") {
    return fileCount > 0 ? "partial" : "failed";
  }
  // Completed OK.
  return built ? "built" : "not_built";
}

function buildIssues(
  input: RunReviewInput,
  status: RunReviewStatus,
  build: { built: boolean; evidence?: string },
  buildText: string,
): RunReviewIssue[] {
  const issues: RunReviewIssue[] = [];
  if (input.outcomeStatus === "error" && input.errorMessage) {
    issues.push({ severity: "error", text: input.errorMessage.slice(0, 300) });
  }
  if (!build.built && build.evidence) {
    issues.push({ severity: "error", text: `Build/typecheck problem: ${build.evidence}` });
  }
  if (status === "not_built") {
    issues.push({
      severity: "warning",
      text: "Run completed but no successful build/typecheck was observed.",
    });
  }
  if (status === "built" && input.filesTouched && input.filesTouched.length === 0) {
    issues.push({
      severity: "warning",
      text: "No file changes were recorded — verify the task actually did work.",
    });
  }
  // Surface any progress line that looks like a blocker.
  for (const u of input.progress ?? []) {
    if (/blocked|blocker|cannot|couldn't|unable to|missing/i.test(u.message)) {
      issues.push({ severity: "warning", text: u.message.slice(0, 200) });
      if (issues.length >= 12) break;
    }
  }
  void buildText;
  return issues.slice(0, 12);
}

function buildForwardActions(
  input: RunReviewInput,
  status: RunReviewStatus,
  issues: RunReviewIssue[],
): RunReviewForwardAction[] {
  const actions: RunReviewForwardAction[] = [];
  if (status === "failed" || status === "partial") {
    actions.push({ label: "Respawn this run", kind: "respawn", payload: { runId: input.runId } });
  }
  if (status === "built") {
    actions.push({ label: "Verify the result", kind: "verify", payload: { runId: input.runId } });
  }
  if (status === "not_built") {
    actions.push({
      label: "Run build / typecheck to confirm",
      kind: "verify",
      payload: { runId: input.runId },
    });
  }
  // One follow-up per distinct error/warning issue, capped.
  for (const i of issues) {
    if (i.severity === "info") continue;
    actions.push({
      label: `Follow up: ${i.text.slice(0, 80)}`,
      kind: "followup",
      payload: { severity: i.severity, text: i.text },
    });
    if (actions.length >= 6) break;
  }
  return actions;
}

/** Assemble the deterministic draft (no LLM). */
export function derive(input: RunReviewInput): RunReviewDraft {
  const filesTouched = buildFiles(input);
  const actions = buildActions(input);

  // Concatenate all text we have build evidence in: progress + error.
  const buildText = [
    ...(input.progress ?? []).map((u) => u.message),
    input.errorMessage ?? "",
  ].join("\n");
  const build = detectBuild(buildText);

  const status = deriveStatus(input, filesTouched.length, build.built);
  const issues = buildIssues(input, status, build, buildText);
  const forwardActions = buildForwardActions(input, status, issues);
  const finishedAt = input.finishedAt;
  const durationMs =
    finishedAt !== undefined ? Math.max(0, finishedAt - input.startedAt) : undefined;

  return {
    runId: input.runId,
    title: input.title,
    task: input.task,
    agentKind: input.agentKind,
    backend: input.backend,
    model: input.model,
    taskId: input.taskId,
    kanbanTaskId: input.kanbanTaskId,
    projectId: input.projectId,
    status,
    startedAt: input.startedAt,
    finishedAt,
    durationMs,
    errorMessage: input.errorMessage,
    filesTouched,
    actions,
    issues,
    built: build.built,
    buildEvidence: build.evidence,
    forwardActions,
  };
}
