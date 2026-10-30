/**
 * Subagent Detail Modal — full pop-up overlay shown when a sub-agent card
 * is clicked anywhere in the app (top-section panel, dashboard "Running
 * Agents" grid, chat sidebar panel).
 *
 * Tabs:
 *   Overview     — task, kanban links, files touched, metadata (always)
 *   Live Session — streaming transcript + composer + controls (running agents)
 *   Tool Calls   — filtered view of tool_use + tool_result turns
 *   Output       — last stdout/stderr chunks from tool results
 *   History      — read-only transcript replay
 *
 * Driven by:
 *  - openSubagentDetailModal({ client, requestUpdate, runId? sessionKey? })
 *  - CustomEvent("infinibot:subagent-open-detail", { detail: { runId|sessionKey } })
 *    dispatched from inside subagent-activity-panel cards. The bridge lives
 *    in mountSubagentDetailListener() which is idempotent — the host view
 *    calls it once with client + requestUpdate.
 *
 * State is module-scope (single modal at a time, matches dashboard pattern).
 */

import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { getReviewByRunId } from "../views/oversight/index";
import {
  mountCheckins,
  unmountCheckins,
  renderCheckinsTab,
  checkinsUnseenCount,
  checkinsHasPending,
  markCheckinsSeen,
} from "./subagent-checkins";
// === spec-vs-result tab (sibling module — additive) ===
import {
  renderSpecTab,
  loadSpecAnalysis,
  type SpecAnalysisData,
} from "./subagent-spec-tab";
// === in-depth agent-run review (shared with the Reviews page + proactive modal) ===
import {
  renderAgentRunReview,
  getReview,
  type AgentRunReview,
} from "./agent-run-review";
// Worker <-> Auditor review thread (Review tab).
import "./review-thread-view";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SubagentFileTouched {
  path: string;
  action: string;
  at: number;
}

export interface SubagentDetailRun {
  runId: string;
  task: string;
  label?: string;
  workdir?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status: string; error?: string };
  childPid?: number;
  claudeSessionId?: string;
  /** The sub-agent's own session key — used to resolve ITS transcript (not the parent's). */
  childSessionKey?: string;
  requesterSessionKey: string;
  kanbanTaskId?: string;
  filesTouched?: SubagentFileTouched[];
  filesTouchedCount?: number;
  filesTouchedSample?: string[];
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** Absolute JSONL transcript path; enables direct transcript reads for archived runs. */
  transcriptPath?: string;
}

export interface SubagentDetailTask {
  id: string;
  title: string;
  status: string;
  priority?: string;
  projectId?: string;
  projectName?: string;
  href: string;
}

export interface SubagentDetailPage {
  id: string;
  name: string;
  surface: string;
  status: string;
  updatedAt: number;
  handle?: string;
  url?: string;
  href: string;
}

export interface SubagentDetailData {
  run: SubagentDetailRun;
  project?: { id: string; name: string; href: string };
  task?: { id: string; title: string; status: string; href: string };
  tasks?: SubagentDetailTask[];
  contentPages?: SubagentDetailPage[];
  source?: "live" | "archive";
}

interface ModalLookup {
  runId?: string;
  sessionKey?: string;
  kanbanTaskId?: string;
}

// ── Live session types ───────────────────────────────────────────────────────

type TabId = "overview" | "review" | "checkins" | "completion" | "spec" | "live" | "tools" | "output" | "history";

/**
 * Closeout summary surfaced on the Completion tab when a run finishes.
 * Built by `_buildCompletionSummary` from the final transcript + run record.
 * Cheap heuristic extraction — no LLM call required.
 */
interface CompletionSummary {
  /** One-line agent-generated outcome (last assistant message, first sentence). */
  headline: string;
  /** Explicit "done"/accomplished bullets. */
  done: string[];
  /** Explicit "deferred"/"TODO"/"couldn't"/"blocked" bullets. */
  deferred: string[];
  /** "next step"/"recommend"/"follow-up" bullets. */
  nextSteps: string[];
  /** URLs (PR comments, releases) + /tmp/ outputs referenced in the transcript. */
  artifacts: { urls: string[]; tmpPaths: string[] };
  /** True when there was no transcript to parse (still renders status + files). */
  thin: boolean;
}

interface TranscriptTurn {
  role: "user" | "assistant" | "system" | "tool_use" | "tool_result" | "other";
  text: string;
  toolName?: string;
  toolCallId?: string;
  /** Whether the tool args/result block is expanded in the UI. */
  expanded?: boolean;
  ts?: number;
}

interface LiveSessionState {
  transcript: TranscriptTurn[];
  /** Streaming delta accumulates here for the last assistant turn. */
  streamingText: string;
  composeText: string;
  busy: boolean;
  paused: boolean;
  sessionState: "running" | "paused" | "awaiting-input" | "finished" | "error" | "unknown";
  stickToBottom: boolean;
  showJumpToLive: boolean;
  supports: { pause: boolean; send: boolean; edit: boolean; fork: boolean };
  editingLastAssistant: boolean;
  editDraft: string;
  toolCallCount: number;
  lastActivityAt: number;
  unsubscribeEvents: (() => void) | null;
  transcriptLoaded: boolean;
}

interface ModalState {
  lookup: ModalLookup;
  loading: boolean;
  data: SubagentDetailData | null;
  error: string | null;
  showAllFiles: boolean;
  onEsc: ((e: KeyboardEvent) => void) | null;
  activeTab: TabId;
  live: LiveSessionState | null;
  respawning: boolean;
  /** Closeout summary, lazily computed when the Completion tab is opened. */
  completion: CompletionSummary | null;
  completionLoading: boolean;
  /** Token/cost rollup pulled from the credit ledger (best-effort, may stay null). */
  completionCost: { costUsd: number; tokensIn: number; tokensOut: number; requests: number } | null;
  // === spec-vs-result tab state (additive) ===
  /** Cached spec-vs-result drift analysis, lazily loaded when the Spec tab opens. */
  spec: SpecAnalysisData | null;
  specLoading: boolean;
  specError: string | null;
  /** True when the backend skipped the LLM grade (short run, not forced). */
  specGated: boolean;
  specAccepting: boolean;
  // === history tab (completed runs) ===
  /** Transcript loaded from sessions.transcript for completed runs (not live stream). */
  historyTranscript: TranscriptTurn[] | null;
  historyTranscriptLoading: boolean;
  historySearchQuery: string;
  historyExpandedTools: Set<string>;
  // === inline artifact viewer ===
  /** Loaded artifact contents keyed by file path. Null = load failed. */
  completionArtifacts: Map<string, string | null> | null;
  // === in-depth review tab (agents.reviews.* overlay) ===
  /** The full agent-run review, lazily fetched when the Review tab opens. */
  review: AgentRunReview | null;
  reviewLoading: boolean;
  /** True once a fetch has resolved (so "no review yet" vs "still loading"). */
  reviewFetched: boolean;
}

let _modal: ModalState | null = null;
let _listenerMounted = false;
let _client: GatewayBrowserClient | null = null;
let _requestUpdate: (() => void) | null = null;
const noop = () => {};

// ── File-inspection drawer ───────────────────────────────────────────────────
// A slide-in drawer layered above the modal that shows the actual diff for a
// touched file plus revert / accept / open / copy-patch actions. Driven by
// `files.diff` / `files.revert` / `files.accept` / `files.openInEditor` RPCs.

interface FileDiffData {
  path: string;
  absPath?: string;
  status: "created" | "modified" | "deleted" | "renamed" | "unchanged";
  binary?: boolean;
  added: number;
  removed: number;
  before: string | null;
  after: string | null;
  patch: string;
  truncated?: boolean;
}

interface FileDrawerState {
  runId: string;
  path: string;
  action: string;
  loading: boolean;
  error: string | null;
  data: FileDiffData | null;
  busy: boolean;
  notice: string | null;
}

let _fileDrawer: FileDrawerState | null = null;

// ── Proposed-commit card ─────────────────────────────────────────────────────
// Shown on the Completion tab when a finished sub-agent has left uncommitted work
// in its working tree. Replaces the old "time + Commit" surface with a proactive
// Finish / Reject / Schedule action row. All git work goes through the existing
// live RPCs (git.status / git.diff / git.add / git.commit / git.stash) so it
// needs no gateway restart.
interface CommitProposalSummary {
  branch: string;
  fileCount: number;
  insertions: number;
  deletions: number;
  hasChanges: boolean;
}
interface CommitProposalState {
  runId: string;
  workdir: string;
  loading: boolean;
  error: string | null;
  summary: CommitProposalSummary | null;
  /** Editable commit message; what Finish uses. */
  message: string;
  /** True once the user has typed — stops auto-suggest from clobbering edits. */
  messageEdited: boolean;
  busy: null | "finish" | "reject";
  notice: string | null;
  /** Set once Finish/Reject resolves so the card collapses to a result line. */
  done: null | { kind: "committed" | "rejected" | "empty"; detail: string };
  /** Inline "View diff" expander state. */
  showDiff: boolean;
  diff: string | null;
  diffLoading: boolean;
}
let _commitProposal: CommitProposalState | null = null;

/** Risk hint — amber dot when a touched file smells security/dependency-sensitive. */
const RISK_RE =
  /(secret|api[_-]?key|password|token|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16})/i;
function fileLooksRisky(pathStr: string, patch?: string | null): boolean {
  const p = pathStr.toLowerCase();
  if (/package(-lock)?\.json$|\.env|requirements\.txt$|pnpm-lock|yarn\.lock|cargo\.toml$/.test(p))
    return true;
  if (/(\.test\.|\.spec\.|__tests__|\/tests?\/)/.test(p) && patch && /^-/m.test(patch))
    return true; // removed lines in a test file
  if (patch && RISK_RE.test(patch)) return true;
  return false;
}

function openFileDrawer(
  runId: string,
  file: { path: string; action: string },
  requestUpdate: () => void,
): void {
  _fileDrawer = {
    runId,
    path: file.path,
    action: file.action,
    loading: true,
    error: null,
    data: null,
    busy: false,
    notice: null,
  };
  requestUpdate();
  if (!_client) return;
  const target = _fileDrawer;
  req(_client, "files.diff", { path: file.path, runId })
    .then((r: unknown) => {
      if (_fileDrawer !== target) return;
      const resp = r as { ok?: boolean; error?: string } & Partial<FileDiffData>;
      if (resp?.ok) {
        _fileDrawer.data = {
          path: resp.path ?? file.path,
          absPath: resp.absPath,
          status: (resp.status as FileDiffData["status"]) ?? "modified",
          binary: resp.binary,
          added: resp.added ?? 0,
          removed: resp.removed ?? 0,
          before: resp.before ?? null,
          after: resp.after ?? null,
          patch: resp.patch ?? "",
          truncated: resp.truncated,
        };
      } else {
        _fileDrawer.error = resp?.error ?? "Failed to load diff";
      }
      _fileDrawer.loading = false;
      requestUpdate();
    })
    .catch((e: unknown) => {
      if (_fileDrawer !== target) return;
      _fileDrawer.error = e instanceof Error ? e.message : String(e);
      _fileDrawer.loading = false;
      requestUpdate();
    });
}

function closeFileDrawer(requestUpdate: () => void): void {
  if (!_fileDrawer) return;
  _fileDrawer = null;
  requestUpdate();
}

// ── Proposed-commit helpers ──────────────────────────────────────────────────

/** Parse the `N insertions(+), M deletions(-)` tail of `git diff --stat`. */
function parseDiffStat(stat: string | null | undefined): { ins: number; del: number } {
  if (!stat) return { ins: 0, del: 0 };
  const ins = /(\d+) insertion/.exec(stat);
  const del = /(\d+) deletion/.exec(stat);
  return { ins: ins ? parseInt(ins[1], 10) : 0, del: del ? parseInt(del[1], 10) : 0 };
}

/**
 * Lazily probe the run's working tree for an uncommittable diff. Composes the
 * already-served git RPCs; never mutates anything. Counts both staged and
 * unstaged hunks so the +/- line totals reflect everything Finish would commit.
 */
function loadCommitProposal(
  run: SubagentDetailRun,
  suggestedMessage: string,
  requestUpdate: () => void,
): void {
  const workdir = run.workdir;
  if (!workdir || !_client) return;
  // Already loaded / loading for this run — don't refetch.
  if (_commitProposal && _commitProposal.runId === run.runId) return;
  _commitProposal = {
    runId: run.runId,
    workdir,
    loading: true,
    error: null,
    summary: null,
    message: suggestedMessage,
    messageEdited: false,
    busy: null,
    notice: null,
    done: null,
    showDiff: false,
    diff: null,
    diffLoading: false,
  };
  // NB: no synchronous requestUpdate() here — loadCommitProposal is invoked from
  // within render(), which already reads the freshly-set state on this same pass.
  const target = _commitProposal;
  Promise.all([
    req(_client, "git.status", { cwd: workdir }) as Promise<any>,
    req(_client, "git.diff", { cwd: workdir }) as Promise<any>,
    req(_client, "git.diff", { cwd: workdir, staged: true }) as Promise<any>,
  ])
    .then(([status, unstaged, staged]) => {
      if (_commitProposal !== target) return;
      const u = parseDiffStat(unstaged?.stat);
      const s = parseDiffStat(staged?.stat);
      const fileCount = Array.isArray(status?.files) ? status.files.length : 0;
      target.summary = {
        branch: status?.branch ?? "(unknown)",
        fileCount,
        insertions: u.ins + s.ins,
        deletions: u.del + s.del,
        hasChanges: status ? status.clean === false : fileCount > 0,
      };
      target.loading = false;
      requestUpdate();
    })
    .catch((e: unknown) => {
      if (_commitProposal !== target) return;
      target.error = e instanceof Error ? e.message : String(e);
      target.loading = false;
      requestUpdate();
    });
}

function toggleCommitDiff(requestUpdate: () => void): void {
  const d = _commitProposal;
  if (!d || !_client) return;
  d.showDiff = !d.showDiff;
  if (d.showDiff && d.diff === null && !d.diffLoading) {
    d.diffLoading = true;
    requestUpdate();
    const target = d;
    req(_client, "git.diff", { cwd: d.workdir, patch: true })
      .then((r: any) => {
        if (_commitProposal !== target) return;
        target.diff = (r?.patch as string) || (r?.stat as string) || "(no diff)";
        target.diffLoading = false;
        requestUpdate();
      })
      .catch((e: unknown) => {
        if (_commitProposal !== target) return;
        target.diff = `diff failed: ${e instanceof Error ? e.message : String(e)}`;
        target.diffLoading = false;
        requestUpdate();
      });
  } else {
    requestUpdate();
  }
}

/** Mark the linked kanban task done (best-effort — not all runs have one). */
async function markRunTaskDone(run: SubagentDetailRun): Promise<void> {
  const taskId = run.kanbanTaskId;
  if (!taskId || !_client) return;
  try {
    await req(_client, "kanban.tasks.update", { id: taskId, patch: { status: "done" } });
  } catch {
    /* best-effort; the git action already succeeded */
  }
}

/**
 * Finish → stage everything + commit immediately with the (possibly edited)
 * message, then mark the task done.
 */
async function commitProposalFinish(run: SubagentDetailRun, requestUpdate: () => void): Promise<void> {
  const d = _commitProposal;
  if (!d || !_client || d.busy) return;
  const message = d.message.trim();
  if (!message) {
    d.notice = "Enter a commit message first.";
    requestUpdate();
    return;
  }
  d.busy = "finish";
  d.notice = null;
  requestUpdate();
  try {
    await req(_client, "git.add", { cwd: d.workdir, files: ["-A"] });
    const r = (await req(_client, "git.commit", { cwd: d.workdir, message })) as
      | { hash?: string; message?: string; error?: string }
      | undefined;
    const hash = r?.hash;
    await markRunTaskDone(run);
    d.busy = null;
    d.done = { kind: "committed", detail: hash ? `Committed ${hash}` : "Committed." };
    requestUpdate();
  } catch (e) {
    d.busy = null;
    d.notice = `Commit failed: ${e instanceof Error ? e.message : String(e)}`;
    requestUpdate();
  }
}

/**
 * Reject → recoverably stash everything (staged + untracked) under a labelled
 * ref so nothing is destroyed, then mark the task done. We stage with `add -A`
 * first so `git stash` also captures brand-new files (avoids needing `-u`,
 * which the live git.stash RPC doesn't expose).
 */
async function commitProposalReject(run: SubagentDetailRun, requestUpdate: () => void): Promise<void> {
  const d = _commitProposal;
  if (!d || !_client || d.busy) return;
  if (!confirm(
    "Reject this commit?\n\nYour changes will be stashed (recoverable via `git stash list` / `git stash pop`), not deleted.",
  )) return;
  d.busy = "reject";
  d.notice = null;
  requestUpdate();
  const label = `infinibot-reject-${run.kanbanTaskId || run.runId}`;
  try {
    // Stage everything (incl. untracked) so stash captures new files too.
    await req(_client, "git.add", { cwd: d.workdir, files: ["-A"] });
    await req(_client, "git.stash", { cwd: d.workdir, op: "push", message: label });
    let stashRef = "stash@{0}";
    try {
      const list = (await req(_client, "git.stash", { cwd: d.workdir, op: "list" })) as
        | { result?: string }
        | undefined;
      const first = (list?.result || "").split("\n").find(Boolean);
      const m = first && /^(stash@\{\d+\})/.exec(first);
      if (m) stashRef = m[1];
    } catch { /* keep default ref */ }
    await markRunTaskDone(run);
    d.busy = null;
    d.done = { kind: "rejected", detail: `Stashed as ${stashRef} — \`git stash pop\` to restore.` };
    requestUpdate();
  } catch (e) {
    d.busy = null;
    d.notice = `Reject failed: ${e instanceof Error ? e.message : String(e)}`;
    requestUpdate();
  }
}

/** Dismiss an empty (no-changes) proposal — just marks the task done. */
async function commitProposalDismiss(run: SubagentDetailRun, requestUpdate: () => void): Promise<void> {
  const d = _commitProposal;
  if (!d || d.busy) return;
  d.busy = "finish";
  requestUpdate();
  await markRunTaskDone(run);
  d.busy = null;
  d.done = { kind: "empty", detail: "Dismissed — no changes." };
  requestUpdate();
}

async function fileDrawerAction(
  kind: "revert" | "accept" | "open",
  requestUpdate: () => void,
): Promise<void> {
  if (!_fileDrawer || !_client || _fileDrawer.busy) return;
  const d = _fileDrawer;
  const data = d.data;

  if (kind === "revert") {
    const created = data?.status === "created";
    const verb = created ? "Delete" : "Revert";
    if (
      !confirm(
        `${verb} ${d.path}?\n\nThis discards the agent's change to this file in the working tree and cannot be undone.`,
      )
    )
      return;
    d.busy = true;
    requestUpdate();
    try {
      const r = (await req(_client, "files.revert", {
        path: d.path,
        runId: d.runId,
        mode: created ? "delete" : "auto",
      })) as { ok?: boolean; error?: string; action?: string };
      d.busy = false;
      if (r?.ok) {
        d.notice = r.action === "deleted" ? "File deleted." : "File reverted to HEAD.";
        // Refresh the diff to reflect the reverted state.
        openFileDrawer(d.runId, { path: d.path, action: d.action }, requestUpdate);
      } else {
        d.notice = `Revert failed: ${r?.error ?? "unknown"}`;
      }
      requestUpdate();
    } catch (e) {
      d.busy = false;
      d.notice = `Revert failed: ${e instanceof Error ? e.message : String(e)}`;
      requestUpdate();
    }
    return;
  }

  if (kind === "accept") {
    const msg = prompt(
      "Commit message for this single-file accept:",
      `Accept agent change: ${d.path}`,
    );
    if (msg === null) return;
    d.busy = true;
    requestUpdate();
    try {
      const r = (await req(_client, "files.accept", {
        path: d.path,
        runId: d.runId,
        message: msg,
      })) as { ok?: boolean; error?: string; hash?: string };
      d.busy = false;
      d.notice = r?.ok
        ? `Committed${r.hash ? ` (${r.hash})` : ""}.`
        : `Accept failed: ${r?.error ?? "unknown"}`;
      if (r?.ok) openFileDrawer(d.runId, { path: d.path, action: d.action }, requestUpdate);
      requestUpdate();
    } catch (e) {
      d.busy = false;
      d.notice = `Accept failed: ${e instanceof Error ? e.message : String(e)}`;
      requestUpdate();
    }
    return;
  }

  if (kind === "open") {
    d.busy = true;
    requestUpdate();
    try {
      const r = (await req(_client, "files.openInEditor", {
        path: d.path,
        runId: d.runId,
      })) as { ok?: boolean; error?: string; launcher?: string };
      d.busy = false;
      d.notice = r?.ok
        ? `Opened in ${r.launcher ?? "editor"}.`
        : `Open failed: ${r?.error ?? "no launcher"}`;
      requestUpdate();
    } catch (e) {
      d.busy = false;
      d.notice = `Open failed: ${e instanceof Error ? e.message : String(e)}`;
      requestUpdate();
    }
  }
}

function copyFilePatch(): void {
  const patch = _fileDrawer?.data?.patch;
  if (patch) void navigator.clipboard.writeText(patch);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function req(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> })
    .request(method, params);
}

async function respawnRun(
  client: GatewayBrowserClient,
  runId: string,
  requestUpdate: () => void,
): Promise<void> {
  if (!_modal || _modal.respawning) return;
  if (!confirm(
    "Respawn this agent with the original task and a preamble describing the prior progress. " +
    "The new run will resume from where this one failed.\n\nProceed?"
  )) return;
  _modal.respawning = true;
  requestUpdate();
  try {
    const res = (await req(client, "subagents.respawn", { runId })) as
      | { ok?: boolean; newRunId?: string; error?: string }
      | undefined;
    if (res?.ok) {
      const newIdShort = res.newRunId ? String(res.newRunId).slice(0, 16) : "";
      alert(newIdShort
        ? `Respawn started\nNew runId: ${newIdShort}…`
        : "Respawn started — check the Active list.");
      closeSubagentDetailModal(requestUpdate);
    } else {
      alert(`Respawn failed: ${res?.error ?? "Unknown error"}`);
    }
  } catch (e) {
    alert(`Respawn failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (_modal) _modal.respawning = false;
    requestUpdate();
  }
}

/**
 * Dispatch a kanban deep-link event so any host that mounts the kanban view
 * can switch tabs, open the specific project, and (optionally) highlight a
 * specific task card. The receiver (see kanban.ts `mountKanbanDeepLinkListener`)
 * is responsible for routing — the modal only knows what it links to.
 */
function dispatchKanbanDeepLink(projectId?: string, taskId?: string): void {
  if (!projectId && !taskId) return;
  window.dispatchEvent(
    new CustomEvent("infinibot:kanban-open-task", {
      detail: { projectId, taskId },
    }),
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isSubagentDetailOpen(): boolean {
  return _modal !== null;
}

export function openSubagentDetailModal(opts: {
  client: GatewayBrowserClient;
  requestUpdate: () => void;
  runId?: string;
  sessionKey?: string;
  /**
   * Kanban task id — the recently-completed feed in the grid activity panel
   * only has the task id, not the run that produced it. The gateway handler
   * resolves task → run in the live registry first, then the archive.
   */
  kanbanTaskId?: string;
  tab?: TabId;
}): void {
  const { client, requestUpdate } = opts;
  _client = client;
  _requestUpdate = requestUpdate;

  const lookup: ModalLookup = {
    runId: opts.runId,
    sessionKey: opts.sessionKey,
    kanbanTaskId: opts.kanbanTaskId,
  };
  if (!lookup.runId && !lookup.sessionKey && !lookup.kanbanTaskId) return;

  closeSubagentDetailModal(noop);
  _modal = {
    lookup,
    loading: true,
    data: null,
    error: null,
    showAllFiles: false,
    onEsc: null,
    activeTab: opts.tab ?? "overview",
    live: null,
    respawning: false,
    completion: null,
    completionLoading: false,
    completionCost: null,
    spec: null,
    specLoading: false,
    specError: null,
    specGated: false,
    specAccepting: false,
    historyTranscript: null,
    historyTranscriptLoading: false,
    historySearchQuery: "",
    historyExpandedTools: new Set(),
    completionArtifacts: null,
    review: null,
    reviewLoading: false,
    reviewFetched: false,
  };
  document.body.style.overflow = "hidden";

  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // Close the file-diff drawer first if it's open; otherwise the modal.
    if (_fileDrawer) closeFileDrawer(requestUpdate);
    else closeSubagentDetailModal(requestUpdate);
  };
  document.addEventListener("keydown", onEsc);
  _modal.onEsc = onEsc;

  requestUpdate();

  const reqParams: Record<string, string> = {};
  if (lookup.runId) reqParams.runId = lookup.runId;
  if (lookup.sessionKey) reqParams.sessionKey = lookup.sessionKey;
  if (lookup.kanbanTaskId) reqParams.kanbanTaskId = lookup.kanbanTaskId;

  req(client, "subagents.detail", reqParams)
    .then((resp: unknown) => {
      if (!_modal || !sameLookup(_modal.lookup, lookup)) return;
      const r = resp as {
        ok?: boolean;
        run?: SubagentDetailRun;
        project?: SubagentDetailData["project"];
        task?: SubagentDetailData["task"];
        tasks?: SubagentDetailTask[];
        contentPages?: SubagentDetailPage[];
        source?: "live" | "archive";
        error?: string;
      };
      if (r?.ok && r.run) {
        _modal.data = {
          run: r.run,
          project: r.project,
          task: r.task,
          tasks: r.tasks ?? (r.task
            ? [{
                id: r.task.id,
                title: r.task.title,
                status: r.task.status,
                projectId: r.project?.id,
                projectName: r.project?.name,
                href: r.task.href,
              }]
            : []),
          contentPages: r.contentPages ?? [],
          source: r.source ?? "live",
        };
        const isRunning = !r.run.endedAt && (r.source ?? "live") !== "archive";
        // Mid-run check-ins feed: subscribe + initial load (poll only while live).
        mountCheckins(client, r.run.runId, requestUpdate, { running: isRunning });
        if (_modal.activeTab === "checkins") markCheckinsSeen(r.run.runId);
        if (isRunning) {
          _initLiveSession(client, requestUpdate, r.run);
        } else if (_modal.activeTab === "completion") {
          // Direct-open onto the Completion tab — kick off the lazy load now
          // since setActiveTab() won't fire for the initial tab.
          _loadCompletion(client, requestUpdate);
        } else if (_modal.activeTab === "spec") {
          // Direct-open onto the Spec tab — same lazy-load kick.
          loadSpecAnalysis(client, _modal, requestUpdate);
        } else if (_modal.activeTab === "review") {
          // Direct-open onto the Review tab — kick the review fetch now.
          _loadReview(client, requestUpdate);
        }
      } else {
        _modal.error = r?.error ?? "Failed to load details";
      }
      _modal.loading = false;
      requestUpdate();
    })
    .catch((err: unknown) => {
      if (!_modal || !sameLookup(_modal.lookup, lookup)) return;
      _modal.error = err instanceof Error ? err.message : String(err);
      _modal.loading = false;
      requestUpdate();
    });
}

function _initLiveSession(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
  run: SubagentDetailRun,
): void {
  if (!_modal) return;

  // Default supports — refined once capabilities RPC returns.
  const defaultSupports = { pause: false, send: false, edit: false, fork: false };

  const live: LiveSessionState = {
    transcript: [],
    streamingText: "",
    composeText: "",
    busy: false,
    paused: false,
    sessionState: "running",
    stickToBottom: true,
    showJumpToLive: false,
    supports: defaultSupports,
    editingLastAssistant: false,
    editDraft: "",
    toolCallCount: 0,
    lastActivityAt: Date.now(),
    unsubscribeEvents: null,
    transcriptLoaded: false,
  };
  _modal.live = live;

  // 1. Load capabilities
  void req(client, "sessions.capabilities", {
    runId: run.runId,
    sessionKey: run.requesterSessionKey,
  }).then((r: unknown) => {
    if (!_modal?.live) return;
    const cap = r as { ok?: boolean; supports?: typeof defaultSupports; paused?: boolean };
    if (cap?.ok && cap.supports) {
      _modal.live.supports = cap.supports;
      _modal.live.paused = !!cap.paused;
      if (cap.paused) _modal.live.sessionState = "paused";
    }
    requestUpdate();
  }).catch(() => { /* non-fatal */ });

  // 2. Load existing transcript
  void req(client, "sessions.transcript", {
    runId: run.runId,
    sessionKey: run.requesterSessionKey,
    limit: 100,
    maxChars: 3000,
  }).then((r: unknown) => {
    if (!_modal?.live) return;
    const tr = r as { ok?: boolean; turns?: Array<{ role: string; text: string }> };
    if (tr?.ok && Array.isArray(tr.turns)) {
      _modal.live.transcript = tr.turns.map((t) => ({
        role: _normalizeRole(t.role),
        text: t.text,
        toolName: _extractToolName(t.text),
        toolCallId: _extractToolCallId(t.text),
      }));
    }
    _modal.live.transcriptLoaded = true;
    requestUpdate();
    _scrollToBottom();
  }).catch(() => {
    if (_modal?.live) {
      _modal.live.transcriptLoaded = true;
      requestUpdate();
    }
  });

  // 3. Subscribe to real-time agent events
  const unsub = (client as unknown as {
    subscribe: (h: (e: GatewayEventFrame) => void) => () => void;
  }).subscribe((evt: GatewayEventFrame) => {
    if (!_modal?.live) return;
    if (evt.event !== "agent") return;

    const payload = evt.payload as {
      runId?: string;
      sessionKey?: string;
      source?: string;
      stream?: string;
      ts?: number;
      coderBackend?: string;
      data?: {
        toolCallId?: string;
        name?: string;
        phase?: "start" | "end";
        arguments?: unknown;
        result?: unknown;
        error?: string;
        durationMs?: number;
        deltaText?: string;
      };
    };

    if (payload.runId !== run.runId) return;

    const live = _modal.live;
    const data = payload.data ?? {};

    if (payload.stream === "tool") {
      const phase = data.phase;
      if (phase === "start") {
        live.toolCallCount++;
        live.lastActivityAt = payload.ts ?? Date.now();
        const toolName = String(data.name ?? "tool");
        live.transcript.push({
          role: "tool_use",
          text: `${toolName}(${_abbrevArgs(data.arguments)})`,
          toolName,
          toolCallId: data.toolCallId ?? String(live.toolCallCount),
          expanded: false,
          ts: payload.ts,
        });
      } else if (phase === "end") {
        const resultText = data.error
          ? `ERROR: ${data.error}`
          : _abbrevResult(data.result);
        live.transcript.push({
          role: "tool_result",
          text: resultText,
          toolCallId: data.toolCallId ?? "",
          expanded: false,
          ts: payload.ts,
        });
      }
      _conditionalScrollToBottom();
      requestUpdate();
    } else if (payload.stream === "text" && data.deltaText) {
      // Streaming text delta — append to last assistant bubble.
      const last = live.transcript[live.transcript.length - 1];
      if (last && last.role === "assistant") {
        last.text += data.deltaText;
      } else {
        live.transcript.push({ role: "assistant", text: data.deltaText, ts: payload.ts });
      }
      _conditionalScrollToBottom();
      requestUpdate();
    } else if (payload.stream === "state") {
      // State changes (paused, finished, etc.)
      const state = (payload.data as { state?: string })?.state;
      if (state === "paused") live.sessionState = "paused";
      else if (state === "running") live.sessionState = "running";
      else if (state === "finished") live.sessionState = "finished";
      else if (state === "error") live.sessionState = "error";
      requestUpdate();
    }
  });

  live.unsubscribeEvents = unsub;
}

function _normalizeRole(role: string): TranscriptTurn["role"] {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  if (role === "tool" || role === "tool_use") return "tool_use";
  if (role === "tool_result") return "tool_result";
  return "other";
}

function _extractToolName(text: string): string | undefined {
  const m = text.match(/^(\w+)\(/);
  return m?.[1];
}

function _extractToolCallId(text: string): string | undefined {
  return undefined;
}

function _abbrevArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return "";
  }
}

function _abbrevResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "";
  }
}

let _transcriptEl: HTMLElement | null = null;

function _conditionalScrollToBottom(): void {
  if (!_modal?.live?.stickToBottom) return;
  _scrollToBottom();
}

function _scrollToBottom(): void {
  requestAnimationFrame(() => {
    if (_transcriptEl) {
      _transcriptEl.scrollTop = _transcriptEl.scrollHeight;
    }
  });
}

export function closeSubagentDetailModal(requestUpdate: () => void): void {
  if (!_modal) return;
  if (_modal.onEsc) document.removeEventListener("keydown", _modal.onEsc);
  if (_modal.live?.unsubscribeEvents) _modal.live.unsubscribeEvents();
  unmountCheckins();
  _modal = null;
  _fileDrawer = null;
  _commitProposal = null;
  _transcriptEl = null;
  document.body.style.overflow = "";
  requestUpdate();
}

export function mountSubagentDetailListener(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): void {
  if (_listenerMounted) return;
  _listenerMounted = true;
  window.addEventListener("infinibot:subagent-open-detail", (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { runId?: string; sessionKey?: string; tab?: TabId }
      | undefined;
    if (!detail) return;
    openSubagentDetailModal({
      client,
      requestUpdate,
      runId: detail.runId,
      sessionKey: detail.sessionKey,
      tab: detail.tab,
    });
  });
}

function retrySubagentDetail(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): void {
  if (!_modal) return;
  const lookup = _modal.lookup;
  openSubagentDetailModal({
    client,
    requestUpdate,
    runId: lookup.runId,
    sessionKey: lookup.sessionKey,
  });
}

function sameLookup(a: ModalLookup, b: ModalLookup): boolean {
  return (
    a.runId === b.runId &&
    a.sessionKey === b.sessionKey &&
    a.kanbanTaskId === b.kanbanTaskId
  );
}

function toggleShowAllFiles(requestUpdate: () => void): void {
  if (!_modal) return;
  _modal.showAllFiles = !_modal.showAllFiles;
  requestUpdate();
}

function _loadHistoryTranscript(client: GatewayBrowserClient, requestUpdate: () => void): void {
  if (!_modal || !_modal.data) return;
  if (_modal.historyTranscript || _modal.historyTranscriptLoading) return;
  const run = _modal.data.run;
  const isRunning = _modal.data.source !== "archive" && !run.endedAt;
  if (isRunning) return; // live session handled by the "live" tab

  _modal.historyTranscriptLoading = true;
  requestUpdate();

  req(client, "sessions.transcript", {
    runId: run.runId,
    ...(run.transcriptPath ? { transcriptPath: run.transcriptPath } : {}),
    ...(run.childSessionKey ? { sessionKey: run.childSessionKey } : {}),
    limit: 200,
    maxChars: 12000,
  })
    .then((r: unknown) => {
      if (!_modal) return;
      const tr = r as { turns?: Array<{ role: string; text: string }> };
      _modal.historyTranscript = Array.isArray(tr?.turns)
        ? tr.turns.map((t) => ({ role: _normalizeRole(t.role), text: t.text, ts: undefined }))
        : [];
    })
    .catch(() => {
      if (_modal) _modal.historyTranscript = [];
    })
    .finally(() => {
      if (_modal) _modal.historyTranscriptLoading = false;
      requestUpdate();
    });
}

function setActiveTab(tab: TabId, requestUpdate: () => void): void {
  if (!_modal) return;
  _modal.activeTab = tab;
  requestUpdate();
  if (tab === "live" || tab === "history") {
    requestAnimationFrame(() => _scrollToBottom());
  }
  if (tab === "history" && _client) {
    _loadHistoryTranscript(_client, requestUpdate);
  }
  if (tab === "completion" && _client) {
    _loadCompletion(_client, requestUpdate);
  }
  if (tab === "spec" && _client) {
    loadSpecAnalysis(_client, _modal, requestUpdate);
  }
  if (tab === "review" && _client) {
    _loadReview(_client, requestUpdate);
  }
  if (tab === "checkins") {
    const runId = _modal.data?.run.runId;
    if (runId) markCheckinsSeen(runId);
  }
}

// ── In-depth review loader ───────────────────────────────────────────────────

/**
 * Lazily fetch the full agent-run review (agents.reviews.get) for this run.
 * Best-effort: leaves review null if the backend method isn't registered yet,
 * so the tab shows a graceful "no review yet" state rather than erroring.
 */
function _loadReview(client: GatewayBrowserClient, requestUpdate: () => void): void {
  if (!_modal) return;
  if (_modal.reviewLoading || _modal.reviewFetched) return;
  const runId = _modal.data?.run.runId ?? _modal.lookup.runId;
  if (!runId) return;
  _modal.reviewLoading = true;
  requestUpdate();
  void getReview(client, { runId })
    .then((r) => {
      if (!_modal) return;
      _modal.review = r;
    })
    .finally(() => {
      if (!_modal) return;
      _modal.reviewLoading = false;
      _modal.reviewFetched = true;
      requestUpdate();
    });
}

// ── Inline artifact loader ───────────────────────────────────────────────────

/**
 * Load a file artifact's content via the gateway files.read RPC so the modal
 * can render it inline (e.g. markdown rendered with the gold-glass style).
 * Best-effort: sets null on error so the UI can show a load-failed state.
 */
function _loadArtifactContent(
  filePath: string,
  run: SubagentDetailRun,
  requestUpdate: () => void,
): void {
  if (!_modal || !_client) return;
  if (!_modal.completionArtifacts) _modal.completionArtifacts = new Map();
  if (_modal.completionArtifacts.has(filePath)) return; // already loaded or loading

  // Mark as loading (undefined = pending, null = failed, string = content).
  _modal.completionArtifacts.set(filePath, undefined as unknown as string);
  requestUpdate();

  req(_client, "files.read", { path: filePath })
    .then((r: unknown) => {
      if (!_modal?.completionArtifacts) return;
      const res = r as { content?: string; size?: number };
      // Trim to 32KB for inline display.
      const content = typeof res?.content === "string" ? res.content.slice(0, 32768) : null;
      _modal.completionArtifacts.set(filePath, content);
    })
    .catch(() => {
      if (_modal?.completionArtifacts) _modal.completionArtifacts.set(filePath, null);
    })
    .finally(() => requestUpdate());
}

// ── Completion summary ─────────────────────────────────────────────────────────

/**
 * Lazily load + build the closeout summary for a finished run. Reuses the live
 * transcript when present, otherwise pulls the persisted transcript. Best-effort
 * token/cost rollup from the credit ledger (keyed by taskId = runId). Caches the
 * result on the modal so re-opening the tab renders instantly.
 */
function _loadCompletion(client: GatewayBrowserClient, requestUpdate: () => void): void {
  if (!_modal || !_modal.data) return;
  if (_modal.completion || _modal.completionLoading) return;
  const run = _modal.data.run;
  const isRunning = _modal.data.source !== "archive" && !run.endedAt;
  if (isRunning) return; // placeholder is rendered directly by the tab

  _modal.completionLoading = true;
  requestUpdate();

  const live = _modal.live;
  const haveLive = !!(live?.transcriptLoaded && live.transcript.length);
  const transcriptP: Promise<TranscriptTurn[]> = haveLive
    ? Promise.resolve(live!.transcript)
    : req(client, "sessions.transcript", {
        runId: run.runId,
        // Prefer direct transcript path (survives live-registry sweep for archived runs).
        ...(run.transcriptPath ? { transcriptPath: run.transcriptPath } : {}),
        // Read the SUB-AGENT's own transcript, not the shared parent's (sibling
        // subagents share requesterSessionKey). When childSessionKey is known we
        // pass it; otherwise we send only runId and let the RPC resolve the
        // child key from the live registry (passing the parent key would surface
        // the wrong transcript).
        ...(run.childSessionKey ? { sessionKey: run.childSessionKey } : {}),
        limit: 80,
        maxChars: 6000,
      })
        .then((r: unknown) => {
          const tr = r as { turns?: Array<{ role: string; text: string }> };
          return Array.isArray(tr?.turns)
            ? tr.turns.map((t) => ({ role: _normalizeRole(t.role), text: t.text }))
            : [];
        })
        .catch(() => [] as TranscriptTurn[]);

  // Roll up cost/tokens for this run. The CLI credit hook keys entries by
  // taskId = runId, so a taskId-filtered "all" summary is this run's total.
  // Guard: older gateways don't honour the taskId filter and return the global
  // ledger total. Detect that by comparing against the unfiltered total and
  // suppress the bogus number rather than show a wildly inflated cost.
  const rollup = (r: unknown) => {
    const a = r as {
      totalCostUsd?: number;
      totalTokensIn?: number;
      totalTokensOut?: number;
      totalRequests?: number;
    } | null;
    if (!a || typeof a !== "object") return null;
    return {
      costUsd: Number(a.totalCostUsd) || 0,
      tokensIn: Number(a.totalTokensIn) || 0,
      tokensOut: Number(a.totalTokensOut) || 0,
      requests: Number(a.totalRequests) || 0,
    };
  };
  const costP = Promise.all([
    req(client, "credits.summary", { period: "all", filters: { taskId: run.runId } })
      .then(rollup)
      .catch(() => null),
    req(client, "credits.summary", { period: "all" }).then(rollup).catch(() => null),
  ]).then(([scoped, global]) => {
    if (!scoped) return null;
    // Identical to the global total → filter was ignored (unsupported gateway).
    if (
      global &&
      scoped.requests === global.requests &&
      scoped.costUsd === global.costUsd &&
      scoped.requests > 0
    ) {
      return null;
    }
    return scoped;
  });

  // Progress updates are the most reliable per-run textual feed for coder
  // sub-agents — their stdout transcript isn't in the gateway session store,
  // but the checkpoint/finishing messages they report are. Best-effort: only
  // present while the run is still in the live progress store (~10 min grace).
  const progressP: Promise<string[]> = req(client, "subagents.status", { runId: run.runId })
    .then((r: unknown) => {
      const s = r as {
        ok?: boolean;
        subagent?: { updates?: Array<{ message?: string; status?: string }> };
      };
      const updates = s?.subagent?.updates;
      if (!Array.isArray(updates)) return [];
      // Drop the fine-grained "working" activity echoes (e.g. "Bash: cd …",
      // "Edit: src/foo.ts") — keep the substantive checkpoint/finishing reports
      // the agent wrote about what it accomplished.
      return updates
        .filter((u) => u?.status !== "working")
        .map((u) => String(u?.message ?? ""))
        .filter(Boolean);
    })
    .catch(() => [] as string[]);

  void Promise.all([transcriptP, costP, progressP]).then(([turns, cost, progressMsgs]) => {
    if (!_modal) return;
    _modal.completion = _buildCompletionSummary(turns, progressMsgs, run);
    _modal.completionCost = cost && (cost.requests > 0 || cost.costUsd > 0) ? cost : null;
    _modal.completionLoading = false;
    requestUpdate();
  });
}

/** Strip light markdown so headline/bullet text reads cleanly. */
function _stripMd(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

const DEFERRED_RE =
  /\b(deferred?|to-?do|couldn'?t|could not|was unable|unable to|not able to|blocked|not implemented|not yet|skipped?|left out|out of scope|didn'?t|did not|won'?t)\b/i;
const NEXT_RE =
  /\b(next step|next up|follow.?up|would recommend|i recommend|recommend|suggest|you (should|could|may want|might want)|consider|to do next|remaining)\b/i;

/**
 * Heuristic closeout extraction. Sources, in priority order:
 *  1. progressMsgs — checkpoint/finishing messages the sub-agent reported
 *     (the reliable per-run feed; coder stdout isn't in the session store).
 *  2. assistant transcript turns — when the session store does carry them.
 * Plus the run record (status, error). No LLM call — cheap heuristics.
 */
function _buildCompletionSummary(
  turns: TranscriptTurn[],
  progressMsgs: string[],
  run: SubagentDetailRun,
): CompletionSummary {
  const assistantTurns = turns.filter((t) => t.role === "assistant" && t.text.trim());
  // Progress messages first (most recent last), then any assistant prose.
  const progressText = progressMsgs.join("\n");
  const lastAssist =
    assistantTurns[assistantTurns.length - 1]?.text ?? progressMsgs[progressMsgs.length - 1] ?? "";
  const allText = [progressText, assistantTurns.map((t) => t.text).join("\n")]
    .filter(Boolean)
    .join("\n");

  // Clean a line of tool-call cosmetics (leading status emoji + tool token,
  // trailing "(123ms)" duration) so the meaningful prose remains.
  const cleanLine = (l: string) =>
    _stripMd(l)
      .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}️]+\s*/u, "")
      .replace(/^(claude_coder|tool|call|running|result)\s+/i, "")
      .replace(/\s*\(\d+\s*ms\)\s*$/, "")
      .trim();

  // Headline: prefer an explicit summary line; otherwise the last substantive
  // prose line across the assistant turns (closing remark). We scan all
  // assistant text — the very last turn is often just a tool-call echo.
  let headline = "";
  {
    const lines = (lastAssist ? allText : "")
      .split(/\r?\n/)
      .map(cleanLine)
      .filter((l) => l.length > 3 && !/^\w+\([^)]*\)$/.test(l));
    const summaryLine = [...lines]
      .reverse()
      .find((l) => /^(summary|done|completed?|result|outcome|in summary)\b/i.test(l));
    const substantive = [...lines].reverse().find((l) => l.length > 24);
    const pick = summaryLine ?? substantive ?? lines[lines.length - 1] ?? "";
    headline = pick.replace(/^(summary|outcome|result|in summary)\s*[:：]\s*/i, "");
    const sentence = headline.match(/^.*?[.!?](\s|$)/);
    if (sentence && sentence[0].length > 24) headline = sentence[0].trim();
    if (headline.length > 220) headline = headline.slice(0, 217) + "…";
  }

  // Bullet / line classification across all assistant text.
  const done: string[] = [];
  const deferred: string[] = [];
  const nextSteps: string[] = [];
  const seen = new Set<string>();
  for (const raw of allText.split(/\r?\n/)) {
    const isBullet = /^\s*([-*+]|\d+[.)])\s+/.test(raw);
    const line = _stripMd(raw);
    if (line.length < 6 || line.length > 240) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    if (NEXT_RE.test(line)) {
      if (nextSteps.length < 6) { nextSteps.push(line); seen.add(key); }
    } else if (DEFERRED_RE.test(line)) {
      if (deferred.length < 6) { deferred.push(line); seen.add(key); }
    } else if (isBullet && /\b(added|created|fixed|implemented|wired|updated|built|ported|removed|migrated|done|complete)\b/i.test(line)) {
      if (done.length < 8) { done.push(line); seen.add(key); }
    }
  }

  // Artifacts: URLs + /tmp paths referenced anywhere in the run's text.
  const corpus = [progressText, turns.map((t) => t.text).join("\n")].filter(Boolean).join("\n");
  const urls = Array.from(
    new Set((corpus.match(/\bhttps?:\/\/[^\s)<>"']+/g) ?? []).map((u) => u.replace(/[.,)]+$/, ""))),
  ).slice(0, 8);
  const tmpPaths = Array.from(
    new Set((corpus.match(/\/tmp\/[^\s)<>"':]+/g) ?? [])),
  ).slice(0, 8);

  return {
    headline,
    done,
    deferred,
    nextSteps,
    artifacts: { urls, tmpPaths },
    thin: assistantTurns.length === 0 && progressMsgs.length === 0,
  };
}

function _fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Render ───────────────────────────────────────────────────────────────────

export function renderSubagentDetailModal(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  if (!_modal) return nothing;
  const requestUpdate = () => state.requestUpdate?.();
  return html`${renderModalBody(_modal, state, client)}${renderFileDrawer(requestUpdate)}`;
}

function renderModalBody(
  modal: ModalState,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const requestUpdate = () => state.requestUpdate?.();
  const close = () => closeSubagentDetailModal(requestUpdate);

  const navigateToTab = (tab: string) => {
    close();
    state.setTab?.(tab as never);
  };

  if (modal.loading) {
    return html`
      ${modalStyles()}
      <div class="sadm-backdrop" @click=${close}>
        <div class="sadm-box" @click=${(e: Event) => e.stopPropagation()}>
          <div class="sadm-loading">
            <div class="sadm-skel sadm-skel-title"></div>
            <div class="sadm-skel sadm-skel-row"></div>
            <div class="sadm-skel sadm-skel-row" style="width:70%"></div>
            <div class="sadm-skel sadm-skel-row" style="width:85%"></div>
            <div class="sadm-skel sadm-skel-row" style="width:60%"></div>
          </div>
        </div>
      </div>
    `;
  }

  if (modal.error || !modal.data) {
    return html`
      ${modalStyles()}
      <div class="sadm-backdrop" @click=${close}>
        <div class="sadm-box" @click=${(e: Event) => e.stopPropagation()}>
          <div class="sadm-error">
            <div class="sadm-error-title">Couldn't load sub-agent</div>
            <div class="sadm-error-msg">${modal.error ?? "No data"}</div>
            <div class="sadm-error-actions">
              <button
                class="sadm-btn sadm-btn-primary"
                @click=${() => retrySubagentDetail(client, requestUpdate)}
              >Retry</button>
              <button class="sadm-btn" @click=${close}>Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const data = modal.data;
  const { run, project, task: linkedTask, tasks = [], contentPages = [], source = "live" } = data;
  const isArchived = source === "archive";
  const primaryTaskId = linkedTask?.id ?? tasks[0]?.id;

  const openInKanban = (taskId?: string) => {
    close();
    dispatchKanbanDeepLink(project?.id, taskId);
    if (project?.id) state.setTab?.("projects" as never);
  };

  const startMs = run.startedAt ?? run.createdAt;
  const endMs = run.endedAt ?? Date.now();
  const durStr = fmtDuration(endMs - startMs);
  const ageStr = run.endedAt
    ? `${timeAgo(run.endedAt)} · ran ${durStr}`
    : `Active · ${durStr}`;
  const outcomeStatus = run.outcome?.status ?? (run.endedAt ? "ok" : "running");
  const outcomeColor =
    outcomeStatus === "ok" ? "#22c55e"
    : outcomeStatus === "error" ? "#ef4444"
    : outcomeStatus === "running" ? "#f59e0b"
    : "var(--g-fg-dim,rgba(245,245,244,0.65))";

  const isRunning = !isArchived && !run.endedAt;
  const hasLive = modal.live !== null;

  // Tab visibility
  const showLiveTab = isRunning && hasLive;
  const tabs: Array<{ id: TabId; label: string; show: boolean }> = [
    { id: "overview", label: "Overview", show: true },
    { id: "review", label: "Review", show: true },
    { id: "checkins", label: "Check-ins", show: true },
    { id: "completion", label: "Summary", show: true },
    { id: "spec", label: "Spec vs Result", show: !isRunning },
    { id: "live", label: "Live Session", show: showLiveTab },
    { id: "tools", label: "Tool Calls", show: showLiveTab },
    { id: "output", label: "Output", show: showLiveTab },
    { id: "history", label: "History", show: true },
  ];
  const visibleTabs = tabs.filter((t) => t.show);
  // Ensure active tab is valid
  const activeTab = visibleTabs.some((t) => t.id === modal.activeTab)
    ? modal.activeTab
    : "overview";

  return html`
    ${modalStyles()}
    <div class="sadm-backdrop" @click=${close} role="dialog" aria-modal="true">
      <div class="sadm-box" @click=${(e: Event) => e.stopPropagation()}>

        <!-- ── Sticky header ──────────────────────────────────── -->
        <div class="sadm-header">
          <div class="sadm-header-left">
            <div class="sadm-title">${run.label ?? run.task.slice(0, 72)}</div>
            <div class="sadm-meta">
              <code class="sadm-runid">${run.runId.slice(0, 18)}</code>
              <span class="sadm-age">${ageStr}</span>
              <span
                class="sadm-status-chip"
                style="color:${outcomeColor};border-color:${outcomeColor}44;"
              >${outcomeStatus.toUpperCase()}</span>
              ${isArchived ? html`
                <span class="sadm-status-chip sadm-archived-chip" title="Loaded from 30-day history — live progress unavailable.">ARCHIVED</span>
              ` : nothing}
            </div>
          </div>
          <button class="sadm-x" @click=${close} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        <!-- ── Tab strip ─────────────────────────────────────── -->
        ${visibleTabs.length > 1 ? html`
          <div class="sadm-tabs" role="tablist">
            ${visibleTabs.map((t) => html`
              <button
                role="tab"
                aria-selected="${activeTab === t.id}"
                class="sadm-tab${activeTab === t.id ? " sadm-tab-active" : ""}"
                @click=${() => setActiveTab(t.id, requestUpdate)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") setActiveTab(t.id, requestUpdate);
                }}
              >${t.label}${t.id === "live" && modal.live?.sessionState === "paused"
                ? html`<span class="sadm-tab-badge sadm-tab-badge-pause">PAUSED</span>`
                : nothing
              }${t.id === "live" && modal.live?.sessionState === "running"
                ? html`<span class="sadm-live-dot"></span>`
                : nothing
              }${t.id === "checkins" && checkinsHasPending(run.runId)
                ? html`<span class="sadm-tab-badge sadm-tab-badge-pause">NEEDS YOU</span>`
                : t.id === "checkins" && activeTab !== "checkins" && checkinsUnseenCount(run.runId) > 0
                ? html`<span class="sadm-tab-badge sadm-tab-badge-checkin" title="New check-in">🔔 ${checkinsUnseenCount(run.runId)}</span>`
                : nothing
              }</button>
            `)}
          </div>
        ` : nothing}

        <!-- ── Scrollable body ───────────────────────────────── -->
        <div class="sadm-body${activeTab === "live" ? " sadm-body-live" : ""}">

          ${activeTab === "overview" ? renderOverviewTab({
            isArchived, run, project, tasks, contentPages, modal, navigateToTab, openInKanban, requestUpdate
          }) : nothing}

          ${activeTab === "review"
            ? html`<review-thread-view
                  compact
                  style="margin-bottom:14px"
                  .runId=${run.runId}
                  .client=${client}
                ></review-thread-view>
                ${renderReviewTab(modal, run, client, requestUpdate)}`
            : nothing}

          ${activeTab === "checkins" ? renderCheckinsTab(run.runId) : nothing}

          ${activeTab === "completion" ? renderCompletionTab(modal, run, isRunning, requestUpdate) : nothing}

          ${activeTab === "spec" ? renderSpecTab(modal, run, client, requestUpdate) : nothing}

          ${activeTab === "live" && modal.live ? renderLiveSessionTab(
            modal.live, run, client, requestUpdate
          ) : nothing}

          ${activeTab === "tools" && modal.live ? renderToolCallsTab(modal.live) : nothing}

          ${activeTab === "output" && modal.live ? renderOutputTab(modal.live) : nothing}

          ${activeTab === "history" ? renderHistoryTab(modal, run) : nothing}

        </div>

        <!-- ── Sticky footer ─────────────────────────────────── -->
        <div class="sadm-footer">
          ${project ? html`
            <button
              class="sadm-btn"
              title=${`Open ${project.name} in Kanban${primaryTaskId ? " (highlights the linked task)" : ""}`}
              @click=${() => openInKanban(primaryTaskId)}
            >Open in Kanban</button>
          ` : nothing}
          ${isRunning && activeTab !== "live" ? html`
            <button
              class="sadm-btn sadm-btn-danger"
              @click=${async () => {
                if (!confirm("Stop this agent? This will cancel the current run.")) return;
                try {
                  await req(client, "subagents.stop", { runId: run.runId }).catch(() => {});
                  if (modal.live) modal.live.sessionState = "finished";
                  requestUpdate();
                } catch { /* non-fatal */ }
              }}
            >Stop</button>
          ` : nothing}
          ${outcomeStatus !== "ok" && outcomeStatus !== "running" ? html`
            <button
              class="sadm-btn sadm-btn-respawn"
              ?disabled=${modal.respawning}
              title="Spawn a new run with the original task and a preamble of prior progress"
              @click=${() => respawnRun(client, run.runId, requestUpdate)}
            >${modal.respawning ? "Respawning…" : "Respawn Agent"}</button>
          ` : nothing}
          <span style="flex:1;"></span>
          <button class="sadm-btn" @click=${close}>Close</button>
        </div>

      </div>
    </div>
  `;
}

// ── Tab: Overview ────────────────────────────────────────────────────────────

function renderOverviewTab(opts: {
  isArchived: boolean;
  run: SubagentDetailRun;
  project?: { id: string; name: string; href: string };
  tasks: SubagentDetailTask[];
  contentPages: SubagentDetailPage[];
  modal: ModalState;
  navigateToTab: (tab: string) => void;
  openInKanban: (taskId?: string) => void;
  requestUpdate: () => void;
}): TemplateResult {
  const { isArchived, run, project, tasks, contentPages, modal, navigateToTab, openInKanban, requestUpdate } = opts;

  const files: SubagentFileTouched[] = run.filesTouched
    ? run.filesTouched
    : (run.filesTouchedSample ?? []).map((p) => ({
        path: p,
        action: "edited",
        at: run.endedAt ?? 0,
      }));
  const archivedTotalFiles = run.filesTouchedCount ?? 0;
  const FILE_VISIBLE = 50;
  const showAll = modal.showAllFiles;
  const visibleFiles = showAll ? files : files.slice(0, FILE_VISIBLE);
  const actionGroups: Record<string, number> = {};
  for (const f of files) actionGroups[f.action] = (actionGroups[f.action] ?? 0) + 1;
  const actionOrder = ["created", "edited", "deleted", "read"];
  const actionLabel: Record<string, string> = {
    created: "Created", edited: "Edited", deleted: "Deleted", read: "Read",
  };
  const actionColor: Record<string, string> = {
    created: "#22c55e", edited: "#f59e0b", deleted: "#ef4444",
    read: "var(--g-fg-dim,rgba(245,245,244,0.55))",
  };

  return html`
    ${isArchived ? html`
      <div class="sadm-archived-banner" role="note">
        Completed run — live progress no longer available. Showing the
        archived summary from the 30-day history.
      </div>
    ` : nothing}

    <div class="sadm-section">
      <div class="sadm-section-label">TASK</div>
      <div class="sadm-task-block sadm-task-markdown">${unsafeHTML(toSanitizedMarkdownHtml(run.task ?? ""))}</div>
    </div>

    ${project ? html`
      <div class="sadm-section">
        <div class="sadm-section-label">LINKED PROJECT</div>
        <button
          class="sadm-row sadm-row-project"
          title="Open this project in the Kanban view"
          @click=${() => openInKanban(tasks[0]?.id)}
        >
          <span class="sadm-row-icon">📁</span>
          <span class="sadm-row-main">
            <span class="sadm-row-title">${project.name}</span>
            <span class="sadm-row-sub">
              <span class="sadm-row-tag">Project</span>
              <code style="opacity:0.6;font-size:11px;">${project.id.slice(0, 12)}</code>
            </span>
          </span>
          <span class="sadm-row-chev">›</span>
        </button>
      </div>
    ` : nothing}

    <div class="sadm-section">
      <div class="sadm-section-label">
        KANBAN TASKS
        ${tasks.length ? html`<span class="sadm-count">${tasks.length}</span>` : nothing}
      </div>
      ${tasks.length === 0 ? html`
        <div class="sadm-empty">No linked tasks.</div>
      ` : html`
        <div class="sadm-row-list">
          ${tasks.map(t => renderTaskRow(t, () => openInKanban(t.id)))}
        </div>
      `}
    </div>

    <div class="sadm-section">
      <div class="sadm-section-label">
        CONTENT PAGES
        ${contentPages.length ? html`<span class="sadm-count">${contentPages.length}</span>` : nothing}
      </div>
      ${contentPages.length === 0 ? html`
        <div class="sadm-empty">No content pages linked to this agent.</div>
      ` : html`
        <div class="sadm-row-list">
          ${contentPages.map(p => renderPageRow(p, () => navigateToTab("content-pages")))}
        </div>
      `}
    </div>

    <div class="sadm-section">
      <div class="sadm-section-label">
        FILES TOUCHED
        ${isArchived && archivedTotalFiles > 0 ? html`
          <span class="sadm-action-badge sadm-archived-chip">${archivedTotalFiles} TOTAL</span>
        ` : nothing}
        ${actionOrder
          .filter(a => actionGroups[a])
          .map(a => html`<span
            class="sadm-action-badge"
            style="color:${actionColor[a]};border-color:${actionColor[a]}44;"
          >${actionLabel[a]} ${actionGroups[a]}</span>`)}
      </div>
      ${files.length === 0 ? html`
        <div class="sadm-empty">${isArchived && archivedTotalFiles > 0
          ? "Per-file detail isn't archived. Only the total file count is preserved."
          : "No file activity recorded."}</div>
      ` : html`
        <div class="sadm-files">
          ${visibleFiles.map(f => renderFileRow(f, actionColor, run.runId, requestUpdate))}
        </div>
        ${!showAll && files.length > FILE_VISIBLE ? html`
          <button
            class="sadm-btn sadm-btn-link"
            @click=${() => toggleShowAllFiles(requestUpdate)}
          >Show all (${files.length})</button>
        ` : nothing}
        ${showAll && files.length > FILE_VISIBLE ? html`
          <button
            class="sadm-btn sadm-btn-link"
            @click=${() => toggleShowAllFiles(requestUpdate)}
          >Collapse</button>
        ` : nothing}
      `}
    </div>

    <div class="sadm-section">
      <div class="sadm-section-label">METADATA</div>
      <div class="sadm-meta-grid">
        ${run.workdir ? html`<div><span class="sadm-mk">WORKDIR</span> ${run.workdir}</div>` : nothing}
        ${run.childPid ? html`<div><span class="sadm-mk">PID</span> ${run.childPid}</div>` : nothing}
        ${run.claudeSessionId ? html`<div><span class="sadm-mk">SESSION</span> ${run.claudeSessionId.slice(0, 16)}…</div>` : nothing}
        <div><span class="sadm-mk">REQUESTER</span> ${run.requesterSessionKey}</div>
        ${run.coderBackend ? html`<div><span class="sadm-mk">BACKEND</span> ${run.coderBackend}</div>` : nothing}
      </div>
    </div>

    ${_renderModalReviewSection(run)}
  `;
}


// ── Inline Review Section ────────────────────────────────────────────────────

function _reviewStatusColor(s: string): string {
  switch (s) {
    case "completed": return "#22c55e";
    case "partial":   return "#f59e0b";
    case "errored":   return "#ef4444";
    default:          return "#71717a";
  }
}

function _renderModalReviewSection(run: SubagentDetailRun): TemplateResult {
  const isActive = !run.endedAt;
  if (isActive) {
    return html`
      <div class="sadm-section sadm-review-section">
        <div class="sadm-section-label">REVIEW</div>
        <div class="sadm-review-pending">
          <span style="color:var(--g-fg-dim,rgba(245,245,244,0.45));font-size:0.78rem;">
            Review will be available once the run completes.
          </span>
        </div>
      </div>
    `;
  }

  const review = getReviewByRunId(run.runId);
  if (!review) {
    return html`
      <div class="sadm-section sadm-review-section">
        <div class="sadm-section-label">REVIEW</div>
        <div class="sadm-review-pending">
          <span style="color:var(--g-fg-dim,rgba(245,245,244,0.45));font-size:0.78rem;">
            No review yet — run the <a style="color:#818cf8;cursor:pointer;" @click=${() => {
              history.pushState({}, '', '/oversight');
              window.dispatchEvent(new PopStateEvent('popstate'));
            }}>Oversight</a> page to generate one.
          </span>
        </div>
      </div>
    `;
  }

  const color = _reviewStatusColor(review.status);
  const conf  = review.confidence;

  return html`
    <div class="sadm-section sadm-review-section">
      <div class="sadm-section-label" style="display:flex;align-items:center;gap:8px;">
        REVIEW
        <span style="font-size:0.68rem;padding:2px 6px;border-radius:3px;border:1px solid ${color}44;color:${color};background:${color}12;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;">${review.status}</span>
        <span style="margin-left:auto;font-size:0.72rem;color:var(--g-fg-dim,rgba(245,245,244,0.5));">Conf ${Math.round(conf * 100)}%</span>
      </div>

      ${review.summary ? html`
        <p class="sadm-review-summary">${review.summary}</p>
      ` : nothing}

      ${review.blockers.length ? html`
        <div class="sadm-review-blockers">
          ${review.blockers.map(b => html`
            <div class="sadm-review-blocker">
              <span style="color:#ef4444;font-weight:700;margin-right:6px;">!</span>${b}
            </div>
          `)}
        </div>
      ` : nothing}

      ${review.nextSteps.length ? html`
        <div class="sadm-review-steps">
          ${review.nextSteps.slice(0, 3).map((step, i) => html`
            <div class="sadm-review-step">
              <span style="color:var(--g-fg-dim,rgba(245,245,244,0.4));margin-right:6px;font-size:0.75rem;">${i + 1}.</span>
              ${step}
            </div>
          `)}
          ${review.nextSteps.length > 3 ? html`
            <div style="font-size:0.72rem;color:var(--g-fg-dim,rgba(245,245,244,0.4));margin-top:4px;">
              +${review.nextSteps.length - 3} more
            </div>
          ` : nothing}
        </div>
      ` : nothing}

      <div class="sadm-review-foot">
        <button class="sadm-review-open-btn" @click=${() => {
          history.pushState({}, '', `/oversight#review-${review.runId}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }}>Open full review →</button>
      </div>
    </div>
  `;
}

// ── Tab: Completion / Summary ──────────────────────────────────────────────────

/**
 * Proactive proposed-commit card. Renders only when the run has a working dir
 * (i.e. real coding work happened). Shows branch / file count / +/- lines, an
 * editable commit message, and a Finish / Reject / Schedule action row. When the
 * tree is clean it collapses to a one-click "No changes — dismiss".
 */
function renderCommitProposalCard(
  modal: ModalState,
  run: SubagentDetailRun,
  requestUpdate: () => void,
): TemplateResult | typeof nothing {
  if (!run.workdir) return nothing;

  // Best commit-message suggestion available right now.
  const suggested =
    (modal.completion?.headline?.trim()) ||
    (run.task ? run.task.split("\n")[0].slice(0, 100).trim() : "") ||
    "Agent changes";

  // Kick off the lazy probe (idempotent — guarded inside).
  loadCommitProposal(run, suggested, requestUpdate);

  const d = _commitProposal;
  if (!d || d.runId !== run.runId) return nothing;

  // Keep the suggestion fresh until the user edits the field.
  if (!d.messageEdited && d.message !== suggested && modal.completion?.headline) {
    d.message = suggested;
  }

  // ── Resolved (committed / rejected / dismissed) ──
  if (d.done) {
    const icon = d.done.kind === "committed" ? "✓" : d.done.kind === "rejected" ? "↩" : "—";
    const color = d.done.kind === "committed" ? "#22c55e" : "#f59e0b";
    return html`
      <div class="sadm-section sadm-commit">
        <div class="sadm-section-label">PROPOSED COMMIT</div>
        <div class="sadm-commit-done" style="color:${color};">
          <span class="sadm-commit-done-icon">${icon}</span>${d.done.detail}
        </div>
      </div>
    `;
  }

  if (d.loading) {
    return html`
      <div class="sadm-section sadm-commit">
        <div class="sadm-section-label">PROPOSED COMMIT</div>
        <div class="sadm-completion-skel"></div>
      </div>
    `;
  }

  if (d.error) {
    return html`
      <div class="sadm-section sadm-commit">
        <div class="sadm-section-label">PROPOSED COMMIT</div>
        <div class="sadm-empty">Couldn't read the working tree: ${d.error}</div>
      </div>
    `;
  }

  const s = d.summary;
  if (!s) return nothing;

  // ── Proactive: no changes → just dismiss ──
  if (!s.hasChanges) {
    return html`
      <div class="sadm-section sadm-commit">
        <div class="sadm-section-label">PROPOSED COMMIT</div>
        <div class="sadm-commit-empty">
          <span>No changes to commit on <strong>${s.branch}</strong>.</span>
          <button
            class="sadm-btn"
            ?disabled=${d.busy != null}
            @click=${() => commitProposalDismiss(run, requestUpdate)}
          >Dismiss</button>
        </div>
      </div>
    `;
  }

  const busy = d.busy != null;
  return html`
    <div class="sadm-section sadm-commit">
      <div class="sadm-section-label">PROPOSED COMMIT</div>

      <div class="sadm-commit-meta">
        <span class="sadm-commit-branch" title="Target branch">⎇ ${s.branch}</span>
        <span class="sadm-commit-stat">${s.fileCount} file${s.fileCount === 1 ? "" : "s"}</span>
        <span class="sadm-commit-stat sadm-fd-add-c">+${s.insertions}</span>
        <span class="sadm-commit-stat sadm-fd-del-c">−${s.deletions}</span>
        <button class="sadm-commit-difflink" @click=${() => toggleCommitDiff(requestUpdate)}>
          ${d.showDiff ? "Hide diff" : "View diff"}
        </button>
      </div>

      ${d.showDiff ? html`
        <div class="sadm-commit-diff">${d.diffLoading ? "Loading diff…" : (d.diff ?? "")}</div>
      ` : nothing}

      <textarea
        class="sadm-commit-msg"
        rows="2"
        placeholder="Commit message…"
        ?disabled=${busy}
        .value=${d.message}
        @input=${(e: Event) => {
          d.message = (e.target as HTMLTextAreaElement).value;
          d.messageEdited = true;
        }}
      ></textarea>

      ${d.notice ? html`<div class="sadm-fd-notice">${d.notice}</div>` : nothing}

      <div class="sadm-commit-actions">
        <button
          class="sadm-btn sadm-btn-primary sadm-commit-finish"
          ?disabled=${busy}
          @click=${() => commitProposalFinish(run, requestUpdate)}
        >${d.busy === "finish" ? "Committing…" : "Finish & commit"}</button>
        <button
          class="sadm-btn sadm-commit-reject"
          ?disabled=${busy}
          @click=${() => commitProposalReject(run, requestUpdate)}
        >${d.busy === "reject" ? "Stashing…" : "Reject"}</button>
        <button
          class="sadm-commit-schedule"
          ?disabled=${busy}
          title="Scheduling commits for later isn't wired yet — Finish or Reject for now."
          @click=${() => { d.notice = "Scheduling isn't available yet — use Finish or Reject."; requestUpdate(); }}
        >Schedule…</button>
      </div>
    </div>
  `;
}

/**
 * Review tab — the full in-depth agent-run review, rendered by the SHARED
 * `renderAgentRunReview` component (identical to the Reviews page + proactive
 * modal). Fetched lazily from `agents.reviews.get`; graceful loading / empty.
 */
function renderReviewTab(
  modal: ModalState,
  run: SubagentDetailRun,
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): TemplateResult {
  if (modal.reviewLoading && !modal.review) {
    return html`<div class="sadm-completion-running">
      <span class="sadm-pulse"></span> Loading review…
    </div>`;
  }
  if (modal.review) {
    return html`
      <div class="sadm-review-tab">
        ${renderAgentRunReview(modal.review, {
          client,
          requestUpdate,
          onRegenerated: (updated) => {
            modal.review = updated;
            requestUpdate();
          },
        })}
      </div>
    `;
  }
  // Fetched, but no review record exists yet (backend not landed, or run has
  // no generated review). Offer a graceful state + a manual fetch retry.
  return html`
    <div class="sadm-empty" style="padding:24px 0;display:flex;flex-direction:column;gap:8px;align-items:flex-start;">
      <p>No in-depth review has been generated for this run yet.</p>
      <p class="sadm-empty-sub">
        Reviews are produced by the <code>agents.reviews.*</code> backend once a run
        finishes. Check the <strong>Summary</strong> tab for the closeout heuristics.
      </p>
      <button
        class="sadm-btn"
        @click=${() => {
          modal.reviewFetched = false;
          _loadReview(client, requestUpdate);
        }}
      >
        Fetch review
      </button>
    </div>
  `;
}

function renderCompletionTab(
  modal: ModalState,
  run: SubagentDetailRun,
  isRunning: boolean,
  requestUpdate: () => void,
): TemplateResult {
  if (isRunning) {
    return html`
      <div class="sadm-completion-running">
        <span class="sadm-pulse"></span>
        Still running — the final summary will appear here on completion.
      </div>
    `;
  }

  // ── Final status ──
  const rawStatus = run.outcome?.status ?? "ok";
  const statusKey =
    rawStatus === "ok" || rawStatus === "complete" || rawStatus === "completed"
      ? "success"
      : rawStatus === "timeout"
        ? "timeout"
        : rawStatus === "killed" || rawStatus === "aborted" || rawStatus === "cancelled"
          ? "killed"
          : "failed";
  const statusMeta: Record<string, { label: string; color: string }> = {
    success: { label: "Success", color: "#22c55e" },
    failed: { label: "Failed", color: "#ef4444" },
    killed: { label: "Killed", color: "#f59e0b" },
    timeout: { label: "Timed out", color: "#f59e0b" },
  };
  const sm = statusMeta[statusKey];

  // ── What changed: files grouped by directory ──
  const files: SubagentFileTouched[] = run.filesTouched
    ? run.filesTouched
    : (run.filesTouchedSample ?? []).map((p) => ({
        path: p,
        action: "edited",
        at: run.endedAt ?? 0,
      }));
  const actionColor: Record<string, string> = {
    created: "#22c55e", edited: "#f59e0b", deleted: "#ef4444",
    read: "var(--g-fg-dim,rgba(245,245,244,0.55))",
  };
  const byDir = new Map<string, SubagentFileTouched[]>();
  for (const f of files) {
    const norm = f.path.replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    const dir = idx > 0 ? norm.slice(0, idx) : "·";
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }
  const dirGroups = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 30);
  const archivedTotalFiles = run.filesTouchedCount ?? 0;

  // ── Duration / tokens / cost ──
  const startMs = run.startedAt ?? run.createdAt;
  const endMs = run.endedAt ?? Date.now();
  const durStr = fmtDuration(endMs - startMs);
  const cost = modal.completionCost;

  const c = modal.completion;
  const loading = modal.completionLoading;

  return html`
    <!-- Final status -->
    <div class="sadm-section">
      <div class="sadm-section-label">FINAL STATUS</div>
      <div class="sadm-completion-status">
        <span
          class="sadm-status-chip"
          style="color:${sm.color};border-color:${sm.color}44;background:${sm.color}12;font-size:11px;"
        >${sm.label.toUpperCase()}</span>
        ${run.coderBackend ? html`<span class="sadm-stat sadm-backend-badge">${run.coderBackend}</span>` : nothing}
        ${run.outcome?.error ? html`<span class="sadm-completion-err" title="${run.outcome.error}">${run.outcome.error.slice(0, 120)}</span>` : nothing}
      </div>
    </div>

    <!-- Proposed commit (proactive Finish / Reject / Schedule) -->
    ${renderCommitProposalCard(modal, run, requestUpdate)}

    <!-- Headline outcome -->
    <div class="sadm-section">
      <div class="sadm-section-label">OUTCOME</div>
      ${loading && !c ? html`<div class="sadm-completion-skel"></div>` : nothing}
      ${c && c.headline ? html`<div class="sadm-completion-headline">${c.headline}</div>` : nothing}
      ${c && !c.headline ? html`<div class="sadm-empty">${c.thin ? "No transcript was captured for this run." : "No summary line found in the agent's final message."}</div>` : nothing}
    </div>

    <!-- What changed -->
    <div class="sadm-section">
      <div class="sadm-section-label">
        WHAT CHANGED
        ${files.length ? html`<span class="sadm-count">${files.length}</span>` : nothing}
        ${archivedTotalFiles > 0 && files.length === 0 ? html`<span class="sadm-action-badge sadm-archived-chip">${archivedTotalFiles} TOTAL</span>` : nothing}
      </div>
      ${dirGroups.length === 0 ? html`
        <div class="sadm-empty">${archivedTotalFiles > 0
          ? "Per-file detail isn't archived — only the total count is preserved."
          : "No file changes recorded."}</div>
      ` : html`
        <div class="sadm-completion-dirs">
          ${dirGroups.map(([dir, fs]) => html`
            <div class="sadm-completion-dirgroup">
              <div class="sadm-completion-dir">
                <span class="sadm-file-dir">${dir === "·" ? "(root)" : dir + "/"}</span>
                <span class="sadm-count">${fs.length}</span>
              </div>
              ${fs.slice(0, 12).map((f) => {
                const norm = f.path.replace(/\\/g, "/");
                const base = norm.slice(norm.lastIndexOf("/") + 1);
                return html`<div class="sadm-completion-file">
                  <span class="sadm-file-act" style="color:${actionColor[f.action] ?? "var(--g-fg-dim)"};">${(f.action[0] ?? "?").toUpperCase()}</span>
                  <span class="sadm-completion-fname">${base}</span>
                </div>`;
              })}
              ${fs.length > 12 ? html`<div class="sadm-empty" style="padding:2px 0 0;">+${fs.length - 12} more</div>` : nothing}
            </div>
          `)}
        </div>
      `}
    </div>

    <!-- Done vs deferred -->
    <div class="sadm-section">
      <div class="sadm-section-label">DONE &amp; DEFERRED</div>
      ${loading && !c ? html`<div class="sadm-completion-skel"></div>` : nothing}
      ${c && c.done.length ? html`
        <div class="sadm-completion-bullets">
          ${c.done.map((b) => html`<div class="sadm-completion-bullet"><span style="color:#22c55e;">✓</span>${b}</div>`)}
        </div>
      ` : nothing}
      ${c && c.deferred.length ? html`
        <div class="sadm-completion-bullets sadm-completion-deferred">
          ${c.deferred.map((b) => html`<div class="sadm-completion-bullet"><span style="color:#f59e0b;">⟳</span>${b}</div>`)}
        </div>
      ` : nothing}
      ${c && !c.done.length && !c.deferred.length ? html`<div class="sadm-empty">Nothing explicitly flagged as done or deferred.</div>` : nothing}
    </div>

    <!-- Key artifacts -->
    ${c && (c.artifacts.urls.length || c.artifacts.tmpPaths.length) ? html`
      <div class="sadm-section">
        <div class="sadm-section-label">KEY ARTIFACTS</div>
        <div class="sadm-completion-artifacts">
          ${c.artifacts.urls.map((u) => {
            const isPR = /github\.com.*\/pull\/\d+/.test(u);
            return html`
              <a class="sadm-completion-link" href="${u}" target="_blank" rel="noopener" title="${u}">
                ${isPR ? "🔀" : "🔗"} ${u.replace(/^https?:\/\//, "").slice(0, 80)}
              </a>
            `;
          })}
          ${c.artifacts.tmpPaths.map((p) => {
            const lp = p.toLowerCase();
            const isMd = lp.endsWith(".md") || lp.endsWith(".markdown");
            const isPdf = lp.endsWith(".pdf");
            const isImg = /\.(png|jpe?g|gif|webp|svg)$/.test(lp);
            const isHtml = lp.endsWith(".html") || lp.endsWith(".htm");
            if (isMd) return html`
              <div class="sadm-artifact-md">
                <div class="sadm-artifact-md-header">
                  <span>📝 ${p.split("/").pop()}</span>
                  <span style="opacity:0.5;font-size:10px;">${p.slice(0, 48)}</span>
                  <button @click=${() => void navigator.clipboard.writeText(p)}
                    style="background:none;border:none;color:var(--g-gold,#b59a4f);cursor:pointer;font-size:11px;">copy path</button>
                </div>
                <div class="sadm-artifact-md-body">
                  ${_modal?.completionArtifacts?.get(p) !== undefined
                    ? unsafeHTML(toSanitizedMarkdownHtml(_modal!.completionArtifacts!.get(p)!))
                    : html`<button class="sadm-artifact-load-btn" @click=${() => _loadArtifactContent(p, run, requestUpdate)}>▶ Load inline preview</button>`}
                </div>
              </div>
            `;
            if (isImg) return html`
              <div class="sadm-artifact-img">
                <div style="font-size:11px;opacity:0.6;margin-bottom:4px;">🖼 ${p.split("/").pop()}</div>
                <img src="data:text/plain," alt="${p}" style="max-width:100%;border-radius:6px;opacity:0.8;"
                  @error=${(e: Event) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <button class="sadm-completion-link" @click=${() => void navigator.clipboard.writeText(p)}>copy path</button>
              </div>
            `;
            if (isPdf) return html`
              <div class="sadm-artifact-pdf">
                <span>📕 ${p.split("/").pop()}</span>
                <button class="sadm-completion-link" @click=${() => void navigator.clipboard.writeText(p)}>copy path</button>
              </div>
            `;
            if (isHtml) return html`
              <a class="sadm-completion-link" href="file://${p}" target="_blank" rel="noopener">🌐 ${p.slice(0, 64)}</a>
            `;
            return html`
              <button class="sadm-completion-link" title="Copy ${p}" @click=${() => void navigator.clipboard.writeText(p)}>📄 ${p.slice(0, 64)}</button>
            `;
          })}
        </div>
      </div>
    ` : nothing}

    <!-- Duration / tokens / cost -->
    <div class="sadm-section">
      <div class="sadm-section-label">RUN METRICS</div>
      <div class="sadm-completion-metrics">
        <div class="sadm-metric"><span class="sadm-metric-k">DURATION</span><span class="sadm-metric-v">${durStr}</span></div>
        ${cost ? html`
          <div class="sadm-metric"><span class="sadm-metric-k">TOKENS</span><span class="sadm-metric-v">${_fmtTokens(cost.tokensIn + cost.tokensOut)}</span></div>
          <div class="sadm-metric"><span class="sadm-metric-k">COST</span><span class="sadm-metric-v">$${cost.costUsd.toFixed(cost.costUsd < 1 ? 4 : 2)}</span></div>
          ${cost.requests ? html`<div class="sadm-metric"><span class="sadm-metric-k">REQUESTS</span><span class="sadm-metric-v">${cost.requests}</span></div>` : nothing}
        ` : html`
          <div class="sadm-metric"><span class="sadm-metric-k">TOKENS / COST</span><span class="sadm-metric-v" style="opacity:0.55;">not recorded</span></div>
        `}
      </div>
    </div>

    <!-- Next-step suggestions -->
    ${c && c.nextSteps.length ? html`
      <div class="sadm-section">
        <div class="sadm-section-label">SUGGESTED NEXT STEPS</div>
        <div class="sadm-completion-bullets">
          ${c.nextSteps.map((b, i) => html`<div class="sadm-completion-bullet"><span style="color:var(--g-fg-dim,rgba(245,245,244,0.45));">${i + 1}.</span>${b}</div>`)}
        </div>
      </div>
    ` : nothing}
  `;
}

// ── Tab: Live Session ────────────────────────────────────────────────────────

function renderLiveSessionTab(
  live: LiveSessionState,
  run: SubagentDetailRun,
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): TemplateResult {
  const isRunning = live.sessionState === "running";
  const isPaused = live.sessionState === "paused";

  const onSend = async () => {
    const msg = live.composeText.trim();
    if (!msg || live.busy || !live.supports.send) return;
    live.busy = true;
    live.composeText = "";
    live.transcript.push({ role: "user", text: msg, ts: Date.now() });
    _scrollToBottom();
    requestUpdate();
    try {
      await req(client, "sessions.send", {
        runId: run.runId,
        sessionKey: run.requesterSessionKey,
        message: msg,
      });
    } catch {
      live.transcript.push({
        role: "system",
        text: "⚠ Failed to send message — check gateway connection.",
        ts: Date.now(),
      });
    }
    live.busy = false;
    requestUpdate();
  };

  const onPause = async () => {
    if (!live.supports.pause) return;
    live.sessionState = "paused";
    requestUpdate();
    try {
      await req(client, "sessions.pause", { runId: run.runId });
    } catch { /* non-fatal */ }
  };

  const onResume = async () => {
    if (!live.supports.pause) return;
    live.sessionState = "running";
    requestUpdate();
    try {
      await req(client, "sessions.resume", { runId: run.runId });
    } catch { /* non-fatal */ }
  };

  const onStop = async () => {
    if (!confirm("Stop this agent? This will cancel the current run.")) return;
    try {
      // Use existing cancel path (registry has no direct cancelRun — best-effort)
      await req(client, "subagents.stop", { runId: run.runId }).catch(() => {});
      live.sessionState = "finished";
      requestUpdate();
    } catch { /* non-fatal */ }
  };

  const onCompact = async () => {
    try {
      await req(client, "sessions.compact", { key: run.requesterSessionKey });
    } catch { /* non-fatal */ }
  };

  const onEditToggle = () => {
    if (!live.supports.edit) return;
    const lastAssist = [...live.transcript].reverse().find((t) => t.role === "assistant");
    if (!lastAssist) return;
    live.editingLastAssistant = !live.editingLastAssistant;
    live.editDraft = live.editingLastAssistant ? lastAssist.text : "";
    requestUpdate();
  };

  const onEditSave = async () => {
    if (!live.editDraft.trim()) return;
    const corrected = live.editDraft.trim();
    live.editingLastAssistant = false;
    live.transcript.push({
      role: "system",
      text: `[User edited previous assistant response to]: ${corrected.slice(0, 120)}${corrected.length > 120 ? "…" : ""}`,
      ts: Date.now(),
    });
    requestUpdate();
    try {
      await req(client, "sessions.edit", {
        runId: run.runId,
        correctedText: corrected,
      });
    } catch { /* non-fatal */ }
  };

  return html`
    <!-- Transcript area -->
    <div
      class="sadm-transcript"
      @scroll=${(e: Event) => {
        const el = e.target as HTMLElement;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        if (live.stickToBottom !== atBottom) {
          live.stickToBottom = atBottom;
          live.showJumpToLive = !atBottom;
          requestUpdate();
        }
      }}
      ${(el: Element | null) => { if (el) _transcriptEl = el as HTMLElement; }}
    >
      ${!live.transcriptLoaded ? html`
        <div class="sadm-thinking">
          <span class="sadm-pulse"></span> Loading transcript…
        </div>
      ` : nothing}

      ${live.transcript.length === 0 && live.transcriptLoaded ? html`
        <div class="sadm-empty sadm-transcript-empty">
          No transcript yet — agent is starting…
        </div>
      ` : nothing}

      ${live.transcript.map((turn, idx) => renderTranscriptTurn(turn, idx, live, requestUpdate))}

      ${isRunning && live.transcript.length > 0 ? html`
        <div class="sadm-thinking">
          <span class="sadm-pulse"></span>
          <span class="sadm-thinking-label">thinking…</span>
        </div>
      ` : nothing}
    </div>

    <!-- Jump to live button -->
    ${live.showJumpToLive ? html`
      <button
        class="sadm-jump-live"
        @click=${() => {
          live.stickToBottom = true;
          live.showJumpToLive = false;
          _scrollToBottom();
          requestUpdate();
        }}
      >↓ Jump to live</button>
    ` : nothing}

    <!-- Edit draft area -->
    ${live.editingLastAssistant ? html`
      <div class="sadm-edit-area">
        <div class="sadm-edit-label">EDITING LAST ASSISTANT RESPONSE</div>
        <textarea
          class="sadm-composer-input"
          rows="4"
          .value=${live.editDraft}
          @input=${(e: Event) => {
            live.editDraft = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="sadm-edit-actions">
          <button class="sadm-btn sadm-btn-primary" @click=${onEditSave}>Save correction</button>
          <button class="sadm-btn" @click=${() => { live.editingLastAssistant = false; requestUpdate(); }}>Cancel</button>
        </div>
      </div>
    ` : nothing}

    <!-- Status footer -->
    <div class="sadm-session-status">
      <span
        class="sadm-state-badge sadm-state-${live.sessionState}"
      >${live.sessionState.toUpperCase()}</span>
      ${live.toolCallCount > 0 ? html`
        <span class="sadm-stat">${live.toolCallCount} tool calls</span>
      ` : nothing}
      ${live.lastActivityAt > 0 ? html`
        <span class="sadm-stat">${timeAgo(live.lastActivityAt)}</span>
      ` : nothing}
      ${run.coderBackend ? html`
        <span class="sadm-stat sadm-backend-badge">${run.coderBackend}</span>
      ` : nothing}
    </div>

    <!-- Controls row -->
    <div class="sadm-controls">
      ${live.supports.pause && isRunning ? html`
        <button class="sadm-ctrl-btn" @click=${onPause} title="Pause at next checkpoint">⏸ Pause</button>
      ` : nothing}
      ${live.supports.pause && isPaused ? html`
        <button class="sadm-ctrl-btn sadm-ctrl-btn-primary" @click=${onResume} title="Resume">▶ Resume</button>
      ` : nothing}
      <button
        class="sadm-ctrl-btn sadm-ctrl-btn-danger"
        @click=${onStop}
        title="Stop agent (confirm required)"
      >■ Stop</button>
      <button class="sadm-ctrl-btn" @click=${onCompact} title="Compact context">⊡ Compact</button>
      ${live.supports.edit ? html`
        <button
          class="sadm-ctrl-btn${live.editingLastAssistant ? " sadm-ctrl-btn-active" : ""}"
          @click=${onEditToggle}
          title="Edit last assistant response (appends correction)"
        >✎ Edit</button>
      ` : nothing}
      <!-- Fork: hidden until sessions.fork is implemented -->
    </div>

    <!-- Composer -->
    ${live.supports.send ? html`
      <div class="sadm-composer">
        <textarea
          class="sadm-composer-input"
          placeholder="Send a message to the agent…  (Cmd+Enter to send)"
          rows="2"
          ?disabled=${live.busy || !isRunning}
          .value=${live.composeText}
          @input=${(e: Event) => {
            live.composeText = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void onSend();
            }
            if (e.key === "Escape") {
              live.composeText = "";
              requestUpdate();
            }
          }}
        ></textarea>
        <button
          class="sadm-btn sadm-btn-primary sadm-send-btn"
          ?disabled=${live.busy || !live.composeText.trim() || !isRunning}
          @click=${() => void onSend()}
        >${live.busy ? "Sending…" : "Send"}</button>
      </div>
    ` : html`
      <div class="sadm-composer sadm-composer-disabled">
        <span class="sadm-empty">
          ${run.coderBackend === "opencode" ||
          run.coderBackend === "codex" ||
          run.coderBackend === "gemini" ||
          run.coderBackend === "grok"
            ? `${run.coderBackend} does not support live message injection.`
            : "Message injection not available for this agent."}
        </span>
      </div>
    `}
  `;
}

function renderTranscriptTurn(
  turn: TranscriptTurn,
  idx: number,
  live: LiveSessionState,
  requestUpdate: () => void,
): TemplateResult {
  const roleColor: Record<string, string> = {
    user: "#f59e0b",
    assistant: "var(--g-fg,rgba(245,245,244,0.95))",
    system: "#94a3b8",
    tool_use: "#06b6d4",
    tool_result: "rgba(245,245,244,0.55)",
    other: "rgba(245,245,244,0.40)",
  };
  const roleLabel: Record<string, string> = {
    user: "YOU",
    assistant: "AGENT",
    system: "SYS",
    tool_use: "TOOL",
    tool_result: "RESULT",
    other: "—",
  };

  const isTool = turn.role === "tool_use" || turn.role === "tool_result";

  if (isTool) {
    const expanded = turn.expanded ?? false;
    return html`
      <div class="sadm-bubble sadm-bubble-tool" key=${idx}>
        <button
          class="sadm-tool-header"
          @click=${() => {
            turn.expanded = !turn.expanded;
            requestUpdate();
          }}
        >
          <span class="sadm-tool-chevron">${expanded ? "▾" : "▸"}</span>
          <span class="sadm-role-pill" style="color:${roleColor[turn.role]};">${roleLabel[turn.role]}</span>
          <span class="sadm-tool-name">${turn.toolName ?? turn.text.slice(0, 48)}</span>
        </button>
        ${expanded ? html`
          <pre class="sadm-tool-body">${turn.text}</pre>
        ` : nothing}
      </div>
    `;
  }

  return html`
    <div class="sadm-bubble sadm-bubble-${turn.role}" key=${idx}>
      <div class="sadm-bubble-role" style="color:${roleColor[turn.role] ?? "#666"};">
        ${roleLabel[turn.role] ?? turn.role}
      </div>
      <div class="sadm-bubble-text">${turn.text}</div>
    </div>
  `;
}

// ── Tab: Tool Calls ──────────────────────────────────────────────────────────

function renderToolCallsTab(live: LiveSessionState): TemplateResult {
  const toolTurns = live.transcript.filter(
    (t) => t.role === "tool_use" || t.role === "tool_result",
  );

  if (toolTurns.length === 0) {
    return html`<div class="sadm-empty" style="padding:24px 0;">No tool calls recorded yet.</div>`;
  }

  return html`
    <div class="sadm-tool-list">
      ${toolTurns.map((t, i) => html`
        <div class="sadm-tool-row">
          <span
            class="sadm-role-pill"
            style="color:${t.role === "tool_use" ? "#06b6d4" : "rgba(245,245,244,0.55)"};"
          >${t.role === "tool_use" ? "CALL" : "RESULT"}</span>
          <pre class="sadm-tool-row-text">${t.text.slice(0, 300)}${t.text.length > 300 ? "…" : ""}</pre>
        </div>
      `)}
    </div>
  `;
}

// ── Tab: Output ──────────────────────────────────────────────────────────────

function renderOutputTab(live: LiveSessionState): TemplateResult {
  const resultTurns = live.transcript
    .filter((t) => t.role === "tool_result")
    .slice(-20);

  if (resultTurns.length === 0) {
    return html`<div class="sadm-empty" style="padding:24px 0;">No output captured yet.</div>`;
  }

  return html`
    <div class="sadm-output-list">
      ${resultTurns.map((t) => html`
        <pre class="sadm-output-block">${t.text}</pre>
      `)}
    </div>
  `;
}

// ── Tab: History ─────────────────────────────────────────────────────────────

function _isErrorTurn(t: TranscriptTurn): boolean {
  const txt = t.text.toLowerCase();
  return t.role === "tool_result" && (txt.includes("error") || txt.includes("failed") || txt.includes("exception"));
}

function renderHistoryTab(modal: ModalState, run: SubagentDetailRun): TemplateResult {
  const isRunning = modal.data?.source !== "archive" && !run.endedAt;
  // For active sessions show the live stream; for completed runs use the loaded history.
  const turns: TranscriptTurn[] = isRunning
    ? (modal.live?.transcript ?? [])
    : (modal.historyTranscript ?? []);

  if (modal.historyTranscriptLoading) {
    return html`<div class="sadm-empty" style="padding:24px 0;">Loading transcript…</div>`;
  }

  if (turns.length === 0) {
    return html`
      <div class="sadm-empty" style="padding:24px 0;">
        ${isRunning
          ? "No history yet — agent may still be starting."
          : "No transcript found for this run."}
      </div>
    `;
  }

  const q = modal.historySearchQuery.toLowerCase().trim();
  const filtered = q ? turns.filter((t) => t.text.toLowerCase().includes(q)) : turns;

  const errorIndices = turns
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => _isErrorTurn(t))
    .map(({ i }) => i);

  const jumpToError = errorIndices.length > 0
    ? () => {
        const el = document.querySelector(`.sadm-hturn-${errorIndices[0]}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    : null;

  return html`
    <!-- search + controls -->
    <div style="display:flex;gap:8px;align-items:center;padding:8px 0 6px;border-bottom:1px solid rgba(255,255,255,0.06);flex-shrink:0;">
      <input
        type="search"
        placeholder="Search transcript…"
        .value=${modal.historySearchQuery}
        @input=${(e: Event) => {
          if (!_modal) return;
          _modal.historySearchQuery = (e.target as HTMLInputElement).value;
          _requestUpdate?.();
        }}
        style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:5px 10px;color:inherit;font-size:12px;"
      />
      ${jumpToError ? html`
        <button
          @click=${jumpToError}
          style="background:#ef444420;border:1px solid #ef4444;border-radius:6px;padding:4px 10px;font-size:11px;color:#ef4444;cursor:pointer;white-space:nowrap;"
          title="${errorIndices.length} error turn${errorIndices.length !== 1 ? "s" : ""}"
        >⚠ Jump to error</button>
      ` : nothing}
      <span style="font-size:11px;opacity:0.45;white-space:nowrap;">${turns.length} turns</span>
    </div>
    <!-- transcript turns -->
    <div class="sadm-history-list" style="overflow-y:auto;flex:1;padding-top:4px;">
      ${filtered.map((t, idx) => {
        const origIdx = q ? turns.indexOf(t) : idx;
        const isError = _isErrorTurn(t);
        const isTool = t.role === "tool_use" || t.role === "tool_result";
        const isExpanded = modal.historyExpandedTools.has(String(origIdx));
        const truncLimit = isExpanded ? 99999 : 600;
        const roleColor =
          t.role === "assistant" ? "var(--g-gold,#b59a4f)"
          : t.role === "user" ? "rgba(245,245,244,0.55)"
          : isError ? "#ef4444"
          : isTool ? "#06b6d4"
          : "rgba(245,245,244,0.35)";
        return html`
          <div class="sadm-history-row sadm-hturn-${origIdx}" style="${isError ? "background:rgba(239,68,68,0.06);border-left:2px solid #ef4444;padding-left:8px;" : ""}">
            <span class="sadm-history-role" style="color:${roleColor};">${t.role}${t.toolName ? html` <span style="opacity:0.65;font-size:10px;">${t.toolName}</span>` : nothing}</span>
            <span class="sadm-history-text">${t.text.slice(0, truncLimit)}${t.text.length > truncLimit ? html`<button @click=${() => {
              if (!_modal) return;
              if (isExpanded) _modal.historyExpandedTools.delete(String(origIdx));
              else _modal.historyExpandedTools.add(String(origIdx));
              _requestUpdate?.();
            }} style="background:none;border:none;color:var(--g-gold,#b59a4f);cursor:pointer;font-size:11px;padding:0 4px;">…${isExpanded ? "less" : "more"}</button>` : nothing}</span>
          </div>
        `;
      })}
    </div>
  `;
}

// ── Row renderers ─────────────────────────────────────────────────────────────

function renderTaskRow(
  t: SubagentDetailTask,
  onOpen: () => void,
): TemplateResult {
  const statusColor =
    t.status === "done" || t.status === "completed" ? "#22c55e"
    : t.status === "in_progress" ? "#f59e0b"
    : t.status === "review" ? "#06b6d4"
    : "var(--g-fg-dim,rgba(245,245,244,0.65))";
  const pri = t.priority?.toUpperCase();
  const priColor =
    pri === "HIGH" || pri === "URGENT" ? "#ef4444"
    : pri === "MEDIUM" ? "#f59e0b"
    : "var(--g-fg-faint,rgba(245,245,244,0.45))";
  return html`
    <button class="sadm-row" @click=${onOpen} title="Open in kanban">
      <span class="sadm-row-icon">📋</span>
      <span class="sadm-row-main">
        <span class="sadm-row-title">${t.title}</span>
        <span class="sadm-row-sub">
          ${t.projectName ? html`<span class="sadm-row-tag">${t.projectName}</span>` : nothing}
          ${pri ? html`<span style="color:${priColor};">${pri}</span>` : nothing}
          <span style="color:${statusColor};">${t.status.replace("_", " ")}</span>
        </span>
      </span>
      <span class="sadm-row-chev">›</span>
    </button>
  `;
}

function renderPageRow(
  p: SubagentDetailPage,
  onOpen: () => void,
): TemplateResult {
  const surface = p.surface.toUpperCase();
  return html`
    <button class="sadm-row" @click=${onOpen} title="Open in content pages">
      <span class="sadm-row-icon">📄</span>
      <span class="sadm-row-main">
        <span class="sadm-row-title">${p.name}</span>
        <span class="sadm-row-sub">
          <span class="sadm-row-tag">${surface}</span>
          ${p.handle ? html`<span>@${p.handle}</span>` : nothing}
          <span>updated ${timeAgo(p.updatedAt)}</span>
        </span>
      </span>
      <span class="sadm-row-chev">›</span>
    </button>
  `;
}

// ── File-diff drawer rendering ───────────────────────────────────────────────

/** Parse a unified-diff `patch` string into rows the drawer can render. */
function parsePatchLines(
  patch: string,
): Array<{ kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo?: number; newNo?: number }> {
  const out: Array<{ kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo?: number; newNo?: number }> = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (
      raw.startsWith("diff ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("similarity ") ||
      raw.startsWith("rename ")
    ) {
      out.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else {
      out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

function renderDiffBody(data: FileDiffData): TemplateResult {
  if (data.binary) {
    return html`<div class="sadm-fd-empty">Binary file — diff not shown.</div>`;
  }
  const hasPatch = !!data.patch.trim();
  if (!hasPatch && data.status === "created" && data.after) {
    return html`<div class="sadm-fd-diff">${data.after.split("\n").map(
      (l, i) => html`<div class="sadm-fd-line sadm-fd-add"><span class="sadm-fd-gut">${i + 1}</span><span class="sadm-fd-mark">+</span><span class="sadm-fd-code">${l || " "}</span></div>`,
    )}</div>`;
  }
  if (!hasPatch && data.status === "deleted" && data.before) {
    return html`<div class="sadm-fd-diff">${data.before.split("\n").map(
      (l, i) => html`<div class="sadm-fd-line sadm-fd-del"><span class="sadm-fd-gut">${i + 1}</span><span class="sadm-fd-mark">-</span><span class="sadm-fd-code">${l || " "}</span></div>`,
    )}</div>`;
  }
  if (!hasPatch) {
    return html`<div class="sadm-fd-empty">No textual changes against HEAD.</div>`;
  }
  const rows = parsePatchLines(data.patch);
  return html`<div class="sadm-fd-diff">
    ${rows.map((r) => {
      if (r.kind === "meta") return nothing;
      if (r.kind === "hunk")
        return html`<div class="sadm-fd-line sadm-fd-hunk"><span class="sadm-fd-gut"></span><span class="sadm-fd-mark"></span><span class="sadm-fd-code">${r.text}</span></div>`;
      const cls = r.kind === "add" ? "sadm-fd-add" : r.kind === "del" ? "sadm-fd-del" : "sadm-fd-ctx";
      const mark = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
      const gut = r.kind === "add" ? r.newNo : r.kind === "del" ? r.oldNo : r.newNo;
      return html`<div class="sadm-fd-line ${cls}"><span class="sadm-fd-gut">${gut ?? ""}</span><span class="sadm-fd-mark">${mark}</span><span class="sadm-fd-code">${r.text || " "}</span></div>`;
    })}
  </div>`;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  created: { label: "Created", color: "#22c55e" },
  modified: { label: "Modified", color: "#f59e0b" },
  deleted: { label: "Deleted", color: "#ef4444" },
  renamed: { label: "Renamed", color: "#818cf8" },
  unchanged: { label: "Unchanged", color: "var(--g-fg-dim,rgba(245,245,244,0.55))" },
};

export function renderFileDrawer(requestUpdate: () => void): TemplateResult | typeof nothing {
  if (!_fileDrawer) return nothing;
  const d = _fileDrawer;
  const data = d.data;
  const parts = d.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? d.path;
  const close = () => closeFileDrawer(requestUpdate);
  const sm = STATUS_META[data?.status ?? "modified"] ?? STATUS_META.modified;
  const created = data?.status === "created";

  return html`
    ${fileDrawerStyles()}
    <div class="sadm-fd-scrim" @click=${close}></div>
    <div class="sadm-fd" role="dialog" aria-label="File diff">
      <div class="sadm-fd-handle" @click=${close}></div>

      <div class="sadm-fd-head">
        <div class="sadm-fd-crumb">
          ${parts.slice(0, -1).map((p) => html`<span class="sadm-fd-crumb-seg">${p}</span><span class="sadm-fd-crumb-sep">/</span>`)}
          <strong>${base}</strong>
        </div>
        <button class="sadm-fd-x" @click=${close} title="Close" aria-label="Close">✕</button>
      </div>

      <div class="sadm-fd-sub">
        <span class="sadm-fd-badge" style="color:${sm.color};border-color:${sm.color}44;background:${sm.color}12;">${sm.label}</span>
        ${data && !data.binary ? html`
          <span class="sadm-fd-stat sadm-fd-add-c">+${data.added}</span>
          <span class="sadm-fd-stat sadm-fd-del-c">−${data.removed}</span>
        ` : nothing}
        ${data && fileLooksRisky(d.path, data.patch) ? html`<span class="sadm-fd-risk" title="Touches secrets, dependencies, or removed tests — review carefully.">●</span>` : nothing}
        ${data?.truncated ? html`<span class="sadm-fd-stat" style="opacity:.7;">large file — summary only</span>` : nothing}
      </div>

      ${d.notice ? html`<div class="sadm-fd-notice">${d.notice}</div>` : nothing}

      <div class="sadm-fd-body">
        ${d.loading ? html`<div class="sadm-fd-empty">Loading diff…</div>` : nothing}
        ${d.error ? html`<div class="sadm-fd-empty" style="color:#ef4444;">${d.error}</div>` : nothing}
        ${data ? renderDiffBody(data) : nothing}
      </div>

      <div class="sadm-fd-actions">
        <button class="sadm-btn sadm-btn-danger" ?disabled=${d.busy || !data} @click=${() => fileDrawerAction("revert", requestUpdate)}>
          ${created ? "Delete" : data?.status === "deleted" ? "Restore" : "Revert"}
        </button>
        <button class="sadm-btn sadm-btn-primary" ?disabled=${d.busy || !data} @click=${() => fileDrawerAction("accept", requestUpdate)} title="Stage & commit just this file">
          Accept
        </button>
        <button class="sadm-btn" ?disabled=${d.busy} @click=${() => fileDrawerAction("open", requestUpdate)} title="Open in OS editor">Open</button>
        <button class="sadm-btn" ?disabled=${!data?.patch} @click=${copyFilePatch} title="Copy unified patch">Copy patch</button>
        <span style="flex:1;"></span>
        <a class="sadm-btn" href="vscode://file/${data?.absPath ?? d.path}" title="Open in VS Code">VS Code ↗</a>
      </div>
    </div>
  `;
}

function renderFileRow(
  f: SubagentFileTouched,
  actionColor: Record<string, string>,
  runId: string,
  requestUpdate: () => void,
): TemplateResult {
  const parts = f.path.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? f.path;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const vsUrl = `vscode://file/${f.path}`;
  const risky = fileLooksRisky(f.path);
  return html`
    <div
      class="sadm-file-row sadm-file-row-click"
      title="${f.path} — click to inspect diff"
      role="button"
      tabindex="0"
      @click=${() => openFileDrawer(runId, f, requestUpdate)}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") openFileDrawer(runId, f, requestUpdate); }}
    >
      <span
        class="sadm-file-act"
        style="color:${actionColor[f.action] ?? "var(--g-fg-dim)"};"
      >${(f.action[0] ?? "?").toUpperCase()}</span>
      <span class="sadm-file-name">
        ${dir ? html`<span class="sadm-file-dir">${dir}/</span>` : nothing}<strong>${base}</strong>
      </span>
      ${risky ? html`<span class="sadm-fd-risk" title="Touches secrets, dependencies, or tests — review carefully.">●</span>` : nothing}
      <span class="sadm-file-btns">
        <button
          class="sadm-file-btn"
          title="Copy path"
          @click=${(e: Event) => { e.stopPropagation(); void navigator.clipboard.writeText(f.path); }}
        >⎘</button>
        <a
          class="sadm-file-btn"
          href="${vsUrl}"
          title="Open in VS Code"
          @click=${(e: Event) => e.stopPropagation()}
        >↗</a>
      </span>
    </div>
  `;
}

// ── Styles ───────────────────────────────────────────────────────────────────

function fileDrawerStyles(): TemplateResult {
  return html`
    <style>
      .sadm-fd-scrim {
        position: fixed; inset: 0; z-index: 10010;
        background: rgba(0,0,0,0.45);
        animation: sadm-fade-in 120ms ease-out;
      }
      .sadm-fd {
        position: fixed; top: 0; right: 0; bottom: 0; z-index: 10011;
        width: min(720px, 96vw);
        display: flex; flex-direction: column;
        background:
          linear-gradient(155deg, rgba(20,22,30,0.98) 0%, rgba(12,13,18,0.99) 100%);
        border-left: 1px solid var(--g-border, rgba(255,255,255,0.12));
        box-shadow: -24px 0 64px rgba(0,0,0,0.5);
        animation: sadm-fd-slide 180ms cubic-bezier(0.16,1,0.3,1);
      }
      @keyframes sadm-fd-slide { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
      .sadm-fd-handle { display: none; }
      .sadm-fd-head {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 14px; flex-shrink: 0;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.08));
      }
      .sadm-fd-crumb {
        flex: 1; min-width: 0; font-size: 12px;
        white-space: nowrap; overflow-x: auto; scrollbar-width: none;
        color: var(--g-fg, rgba(245,245,244,0.92));
      }
      .sadm-fd-crumb::-webkit-scrollbar { display: none; }
      .sadm-fd-crumb-seg { color: var(--g-fg-faint, rgba(245,245,244,0.40)); }
      .sadm-fd-crumb-sep { color: var(--g-fg-faint, rgba(245,245,244,0.30)); margin: 0 2px; }
      .sadm-fd-x {
        background: none; border: none; color: var(--g-fg-dim, rgba(245,245,244,0.6));
        font-size: 16px; cursor: pointer; flex-shrink: 0; padding: 2px 6px;
      }
      .sadm-fd-x:hover { color: var(--g-fg, #fff); }
      .sadm-fd-sub {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 8px 14px; flex-shrink: 0;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.06));
      }
      .sadm-fd-badge {
        font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
        padding: 2px 8px; border-radius: 4px; border: 1px solid;
        text-transform: uppercase;
      }
      .sadm-fd-stat { font-size: 11px; font-variant-numeric: tabular-nums; }
      .sadm-fd-add-c { color: #22c55e; }
      .sadm-fd-del-c { color: #ef4444; }
      .sadm-fd-risk { color: #f59e0b; font-size: 12px; }
      .sadm-fd-notice {
        margin: 8px 14px 0; padding: 6px 10px; border-radius: 6px;
        font-size: 11px; color: var(--g-fg, rgba(245,245,244,0.9));
        background: rgba(129,140,248,0.12); border: 1px solid rgba(129,140,248,0.3);
      }
      .sadm-fd-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 0; }
      .sadm-fd-empty {
        padding: 24px 14px; text-align: center; font-size: 12px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
      }
      .sadm-fd-diff {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px; line-height: 1.5;
      }
      .sadm-fd-line { display: flex; white-space: pre; }
      .sadm-fd-gut {
        flex-shrink: 0; width: 44px; text-align: right; padding-right: 10px;
        color: var(--g-fg-faint, rgba(245,245,244,0.30));
        user-select: none; font-variant-numeric: tabular-nums;
      }
      .sadm-fd-mark { flex-shrink: 0; width: 14px; text-align: center; user-select: none; }
      .sadm-fd-code { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
      .sadm-fd-add { background: rgba(34,197,94,0.10); }
      .sadm-fd-add .sadm-fd-mark, .sadm-fd-add .sadm-fd-code { color: #86efac; }
      .sadm-fd-del { background: rgba(239,68,68,0.10); }
      .sadm-fd-del .sadm-fd-mark, .sadm-fd-del .sadm-fd-code { color: #fca5a5; }
      .sadm-fd-ctx .sadm-fd-code { color: var(--g-fg-dim, rgba(245,245,244,0.7)); }
      .sadm-fd-hunk { background: rgba(129,140,248,0.10); }
      .sadm-fd-hunk .sadm-fd-code { color: #a5b4fc; }
      .sadm-fd-actions {
        display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
        padding: 10px 14px; flex-shrink: 0;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.08));
        background: rgba(0,0,0,0.2);
      }
      @media (max-width: 640px) {
        .sadm-fd {
          width: 100vw; top: auto; height: 92vh;
          border-left: none; border-top-left-radius: 16px; border-top-right-radius: 16px;
          animation: sadm-fd-slide-up 200ms cubic-bezier(0.16,1,0.3,1);
        }
        @keyframes sadm-fd-slide-up { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
        .sadm-fd-handle {
          display: block; width: 40px; height: 4px; border-radius: 2px;
          background: var(--g-border, rgba(255,255,255,0.25));
          margin: 8px auto 0; cursor: pointer;
        }
      }
    </style>
  `;
}

function modalStyles(): TemplateResult {
  return html`
    <style>
      .sadm-file-row-click { cursor: pointer; transition: background 120ms; }
      .sadm-file-row-click:hover { background: rgba(129,140,248,0.08); }
      .sadm-backdrop {
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        animation: sadm-fade-in 140ms ease-out;
      }
      @keyframes sadm-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      .sadm-box {
        width: min(960px, 100%);
        max-height: 90vh;
        display: flex; flex-direction: column;
        background:
          linear-gradient(155deg,
            rgba(20,22,30,0.95) 0%,
            rgba(9,11,18,0.92) 100%);
        backdrop-filter: blur(28px) saturate(160%);
        -webkit-backdrop-filter: blur(28px) saturate(160%);
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        border-radius: 14px;
        box-shadow:
          0 24px 96px rgba(0,0,0,0.55),
          0 2px 6px rgba(0,0,0,0.35),
          inset 0 1px 0 rgba(255,255,255,0.10);
        font-family: var(--g-mono-family, 'JetBrains Mono','SF Mono',monospace);
        color: var(--g-fg, rgba(245,245,244,0.95));
        animation: sadm-pop-in 140ms cubic-bezier(0.22,1,0.36,1);
        overflow: hidden;
      }
      @keyframes sadm-pop-in {
        from { transform: translateY(8px) scale(0.985); opacity: 0; }
        to   { transform: translateY(0) scale(1); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sadm-backdrop, .sadm-box { animation: none; }
      }

      /* Header */
      .sadm-header {
        flex-shrink: 0;
        display: flex; align-items: flex-start; gap: 12px;
        padding: 16px 20px 12px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.10));
        background: rgba(255,255,255,0.03);
      }
      .sadm-header-left { flex: 1; min-width: 0; }
      .sadm-title {
        font-size: 14px; font-weight: 700;
        color: var(--g-primary, #fbbf24);
        letter-spacing: 0.02em;
        line-height: 1.3;
        overflow: hidden; text-overflow: ellipsis;
      }
      .sadm-meta {
        display: flex; gap: 10px; align-items: center;
        margin-top: 6px; flex-wrap: wrap;
        font-size: 10px;
      }
      .sadm-runid {
        font-family: inherit;
        background: rgba(255,255,255,0.06);
        padding: 1px 6px; border-radius: 3px;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        letter-spacing: 0.04em;
      }
      .sadm-age { color: var(--g-fg-dim, rgba(245,245,244,0.65)); }
      .sadm-status-chip {
        font-size: 9px; font-weight: 700;
        letter-spacing: 0.12em;
        padding: 2px 8px;
        border: 1px solid;
        border-radius: 3px;
      }
      .sadm-archived-chip {
        color: #94a3b8;
        border-color: rgba(148, 163, 184, 0.45);
        background: rgba(148, 163, 184, 0.06);
      }
      .sadm-review-section { gap: 6px; }
    .sadm-review-pending { padding: 8px 0; }
    .sadm-review-summary { margin: 6px 0; font-size: 0.82rem; color: var(--g-fg, #f5f5f4); line-height: 1.5; }
    .sadm-review-blockers { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
    .sadm-review-blocker { font-size: 0.78rem; padding: 5px 8px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 4px; color: #fca5a5; }
    .sadm-review-steps { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
    .sadm-review-step { font-size: 0.78rem; display: flex; padding: 3px 0; color: var(--g-fg, #f5f5f4); }
    .sadm-review-foot { display: flex; justify-content: flex-end; margin-top: 8px; }
    .sadm-review-open-btn { font-size: 0.75rem; padding: 4px 12px; border-radius: 4px; border: 1px solid rgba(129,140,248,0.4); color: #818cf8; background: rgba(129,140,248,0.08); cursor: pointer; transition: background 120ms; }
    .sadm-review-open-btn:hover { background: rgba(129,140,248,0.18); }

    /* Completion / Summary tab */
    .sadm-completion-running {
      display: flex; align-items: center; gap: 10px;
      padding: 28px 16px; justify-content: center;
      font-size: 12px; line-height: 1.5;
      color: var(--g-fg-dim, rgba(245,245,244,0.6));
      text-align: center;
    }
    .sadm-completion-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .sadm-completion-err {
      font-size: 11px; color: #fca5a5;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
    }
    .sadm-completion-headline {
      font-size: 13px; line-height: 1.55;
      color: var(--g-fg, rgba(245,245,244,0.95));
      padding: 8px 10px; border-radius: 6px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--g-border, rgba(255,255,255,0.10));
    }
    .sadm-completion-skel {
      height: 14px; border-radius: 4px; width: 75%;
      background: linear-gradient(90deg, rgba(255,255,255,0.05), rgba(255,255,255,0.12), rgba(255,255,255,0.05));
      background-size: 200% 100%;
      animation: sadm-shimmer 1.2s ease-in-out infinite;
    }
    @keyframes sadm-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    /* ── Proposed-commit card ── */
    .sadm-commit {
      border: 1px solid rgba(34,197,94,0.28);
      border-radius: 8px; padding: 10px 11px;
      background: linear-gradient(160deg, rgba(34,197,94,0.07), rgba(0,0,0,0.18));
    }
    .sadm-commit-meta {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      font-size: 11px; font-variant-numeric: tabular-nums; margin-bottom: 8px;
    }
    .sadm-commit-branch {
      font-weight: 600; color: var(--g-fg, rgba(245,245,244,0.92));
      background: rgba(255,255,255,0.06); padding: 2px 7px; border-radius: 4px;
    }
    .sadm-commit-stat { color: var(--g-fg-dim, rgba(245,245,244,0.65)); }
    .sadm-commit-difflink {
      margin-left: auto; background: none; border: none; cursor: pointer;
      font-size: 11px; color: #818cf8; padding: 0;
    }
    .sadm-commit-difflink:hover { text-decoration: underline; }
    .sadm-commit-diff {
      max-height: 220px; overflow: auto; margin-bottom: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px; line-height: 1.45; white-space: pre;
      padding: 8px; border-radius: 6px; background: rgba(0,0,0,0.35);
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
    }
    .sadm-commit-msg {
      width: 100%; box-sizing: border-box; resize: vertical;
      font-family: inherit; font-size: 12px; line-height: 1.4;
      color: var(--g-fg, rgba(245,245,244,0.92));
      background: rgba(0,0,0,0.30);
      border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      border-radius: 6px; padding: 7px 9px; margin-bottom: 8px;
    }
    .sadm-commit-msg:focus { outline: none; border-color: rgba(129,140,248,0.6); }
    .sadm-commit-actions { display: flex; align-items: center; gap: 8px; }
    .sadm-commit-finish { background: #16a34a; border-color: #16a34a; color: #fff; }
    .sadm-commit-finish:hover:not(:disabled) { background: #22c55e; }
    .sadm-commit-reject {
      color: #fca5a5; border-color: rgba(239,68,68,0.4);
      background: rgba(239,68,68,0.10);
    }
    .sadm-commit-reject:hover:not(:disabled) { background: rgba(239,68,68,0.18); }
    .sadm-commit-schedule {
      margin-left: auto; background: none; border: none; cursor: pointer;
      font-size: 11px; color: var(--g-fg-dim, rgba(245,245,244,0.55)); padding: 0;
    }
    .sadm-commit-schedule:hover:not(:disabled) { color: var(--g-fg, #fff); text-decoration: underline; }
    .sadm-commit-schedule:disabled { opacity: 0.4; cursor: default; }
    .sadm-commit-empty {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      font-size: 12px; color: var(--g-fg-dim, rgba(245,245,244,0.65));
    }
    .sadm-commit-done { display: flex; align-items: center; gap: 7px; font-size: 12px; }
    .sadm-commit-done-icon { font-weight: 700; }
    .sadm-completion-dirs { display: flex; flex-direction: column; gap: 10px; }
    .sadm-completion-dirgroup {
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      border-radius: 6px; padding: 7px 9px; background: rgba(0,0,0,0.18);
    }
    .sadm-completion-dir {
      display: flex; align-items: center; gap: 6px;
      font-size: 10px; margin-bottom: 5px;
      color: var(--g-fg-dim, rgba(245,245,244,0.6));
    }
    .sadm-completion-file {
      display: flex; align-items: center; gap: 7px;
      font-size: 11px; padding: 1px 0;
      color: var(--g-fg, rgba(245,245,244,0.88));
    }
    .sadm-completion-fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sadm-completion-bullets { display: flex; flex-direction: column; gap: 5px; }
    .sadm-completion-bullets + .sadm-completion-bullets { margin-top: 6px; }
    .sadm-completion-bullet {
      display: flex; gap: 8px; align-items: flex-start;
      font-size: 12px; line-height: 1.5;
      color: var(--g-fg, rgba(245,245,244,0.9));
    }
    .sadm-completion-bullet > span:first-child { flex-shrink: 0; }
    .sadm-completion-artifacts { display: flex; flex-direction: column; gap: 5px; }
    .sadm-completion-link {
      appearance: none; text-align: left; cursor: pointer;
      font-family: inherit; font-size: 11px;
      padding: 5px 9px; border-radius: 5px;
      border: 1px solid rgba(129,140,248,0.3);
      background: rgba(129,140,248,0.08);
      color: #a5b4fc; text-decoration: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sadm-completion-link:hover { background: rgba(129,140,248,0.18); }
    .sadm-completion-metrics { display: flex; flex-wrap: wrap; gap: 10px; }
    .sadm-metric {
      display: flex; flex-direction: column; gap: 2px;
      padding: 6px 12px; border-radius: 6px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--g-border, rgba(255,255,255,0.10));
      min-width: 78px;
    }
    .sadm-metric-k { font-size: 8px; letter-spacing: 0.12em; color: var(--g-fg-dim, rgba(245,245,244,0.5)); }
    .sadm-metric-v { font-size: 14px; font-weight: 700; color: var(--g-primary, #fbbf24); }

    .sadm-archived-banner {
        font-size: 10px; line-height: 1.5;
        color: var(--g-fg-dim, rgba(245,245,244,0.70));
        background: rgba(148, 163, 184, 0.08);
        border: 1px solid rgba(148, 163, 184, 0.30);
        border-radius: 6px;
        padding: 8px 10px;
        margin-bottom: 14px;
      }
      .sadm-x {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        font-size: 14px;
        width: 28px; height: 28px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        border-radius: 6px;
        flex-shrink: 0;
        font-family: inherit;
        transition: color 120ms, border-color 120ms, background 120ms;
      }
      .sadm-x:hover {
        color: var(--g-fg, rgba(245,245,244,0.95));
        border-color: var(--g-border-strong, rgba(255,255,255,0.30));
        background: rgba(255,255,255,0.04);
      }

      /* Tab strip */
      .sadm-tabs {
        flex-shrink: 0;
        display: flex; gap: 0;
        padding: 0 20px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.10));
        background: rgba(255,255,255,0.02);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .sadm-tabs::-webkit-scrollbar { display: none; }
      .sadm-tab {
        background: none; border: none;
        font-family: inherit;
        font-size: 9px; font-weight: 700;
        letter-spacing: 0.12em;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        padding: 10px 14px 8px;
        cursor: pointer;
        border-bottom: 2px solid transparent;
        transition: color 120ms, border-color 120ms;
        display: flex; align-items: center; gap: 6px;
        white-space: nowrap;
        position: relative;
      }
      .sadm-tab:hover {
        color: var(--g-fg, rgba(245,245,244,0.85));
      }
      .sadm-tab-active {
        color: var(--g-primary, #fbbf24);
        border-bottom-color: var(--g-primary, #fbbf24);
      }
      .sadm-tab-badge {
        font-size: 7px; font-weight: 800;
        padding: 1px 4px;
        border-radius: 2px;
        letter-spacing: 0.08em;
      }
      .sadm-tab-badge-pause {
        background: rgba(245,158,11,0.18);
        color: #f59e0b;
        border: 1px solid rgba(245,158,11,0.40);
      }
      .sadm-tab-badge-checkin {
        font-size: 8px;
        background: rgba(96,165,250,0.18);
        color: #60a5fa;
        border: 1px solid rgba(96,165,250,0.40);
      }
      .sadm-live-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 6px rgba(34,197,94,0.7);
        animation: sadm-pulse 1.4s ease-in-out infinite;
      }
      @keyframes sadm-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      /* Body */
      .sadm-body {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px 8px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.10) transparent;
      }
      .sadm-body-live {
        overflow-y: hidden;
        padding: 0;
        display: flex;
        flex-direction: column;
      }

      /* Transcript */
      .sadm-transcript {
        flex: 1;
        overflow-y: auto;
        padding: 12px 20px 8px;
        display: flex; flex-direction: column; gap: 8px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.08) transparent;
        min-height: 0;
      }
      .sadm-transcript-empty {
        padding: 24px 0;
        text-align: center;
      }
      .sadm-bubble {
        display: flex; flex-direction: column; gap: 3px;
        max-width: 100%;
      }
      .sadm-bubble-role {
        font-size: 8px; font-weight: 800;
        letter-spacing: 0.14em;
        margin-bottom: 1px;
      }
      .sadm-bubble-text {
        font-size: 11px; line-height: 1.5;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--g-border, rgba(255,255,255,0.09));
        border-radius: 6px;
        padding: 7px 10px;
        white-space: pre-wrap; word-break: break-word;
      }
      .sadm-bubble-user .sadm-bubble-text {
        background: rgba(251,191,36,0.07);
        border-color: rgba(251,191,36,0.22);
      }
      .sadm-bubble-system .sadm-bubble-text {
        background: rgba(148,163,184,0.06);
        border-color: rgba(148,163,184,0.22);
        font-style: italic;
        font-size: 10px;
        color: #94a3b8;
      }
      .sadm-bubble-tool {
        flex-direction: column;
      }
      .sadm-tool-header {
        background: none; border: none; cursor: pointer;
        display: flex; align-items: center; gap: 6px;
        font-family: inherit; font-size: 10px;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        padding: 5px 8px;
        border-radius: 5px;
        border: 1px solid var(--g-border, rgba(255,255,255,0.09));
        transition: background 120ms, border-color 120ms;
        width: 100%;
        text-align: left;
      }
      .sadm-tool-header:hover {
        background: rgba(6,182,212,0.06);
        border-color: rgba(6,182,212,0.30);
      }
      .sadm-tool-chevron { color: var(--g-fg-faint); font-size: 9px; }
      .sadm-tool-name {
        font-size: 10px; font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        flex: 1;
      }
      .sadm-tool-body {
        font-family: inherit; font-size: 9px; line-height: 1.45;
        background: rgba(6,182,212,0.05);
        border: 1px solid rgba(6,182,212,0.20);
        border-radius: 0 0 5px 5px;
        border-top: none;
        padding: 6px 10px;
        margin: 0;
        white-space: pre-wrap; word-break: break-word;
        max-height: 200px; overflow-y: auto;
        color: rgba(245,245,244,0.75);
      }
      .sadm-role-pill {
        font-size: 8px; font-weight: 800;
        letter-spacing: 0.12em;
      }
      .sadm-thinking {
        display: flex; align-items: center; gap: 8px;
        font-size: 10px; font-style: italic;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        padding: 4px 0;
      }
      .sadm-thinking-label { }
      .sadm-pulse {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--g-primary, #fbbf24);
        animation: sadm-pulse 1s ease-in-out infinite;
        flex-shrink: 0;
      }

      /* Jump to live */
      .sadm-jump-live {
        position: sticky; bottom: 4px;
        align-self: center;
        background: rgba(34,197,94,0.15);
        border: 1px solid rgba(34,197,94,0.45);
        color: #22c55e;
        font-family: inherit; font-size: 9px; font-weight: 700;
        letter-spacing: 0.1em;
        padding: 5px 14px;
        border-radius: 20px;
        cursor: pointer;
        transition: background 120ms;
        margin: 4px auto;
      }
      .sadm-jump-live:hover { background: rgba(34,197,94,0.22); }

      /* Status footer */
      .sadm-session-status {
        flex-shrink: 0;
        display: flex; align-items: center; gap: 10px;
        padding: 6px 20px;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.07));
        background: rgba(255,255,255,0.02);
        font-size: 9px;
      }
      .sadm-state-badge {
        font-size: 8px; font-weight: 800;
        letter-spacing: 0.14em;
        padding: 2px 8px;
        border-radius: 3px;
      }
      .sadm-state-running  { color: #22c55e; background: rgba(34,197,94,0.10); border: 1px solid rgba(34,197,94,0.30); }
      .sadm-state-paused   { color: #f59e0b; background: rgba(245,158,11,0.10); border: 1px solid rgba(245,158,11,0.30); }
      .sadm-state-finished { color: #94a3b8; background: rgba(148,163,184,0.08); border: 1px solid rgba(148,163,184,0.25); }
      .sadm-state-error    { color: #ef4444; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25); }
      .sadm-state-awaiting-input { color: #06b6d4; background: rgba(6,182,212,0.08); border: 1px solid rgba(6,182,212,0.25); }
      .sadm-state-unknown  { color: rgba(245,245,244,0.45); background: transparent; border: 1px solid rgba(255,255,255,0.12); }
      .sadm-stat {
        color: var(--g-fg-dim, rgba(245,245,244,0.50));
        font-size: 9px;
      }
      .sadm-backend-badge {
        background: rgba(251,191,36,0.08);
        border: 1px solid rgba(251,191,36,0.22);
        color: rgba(251,191,36,0.80);
        padding: 1px 6px;
        border-radius: 3px;
        font-weight: 700;
        letter-spacing: 0.08em;
      }

      /* Controls */
      .sadm-controls {
        flex-shrink: 0;
        display: flex; gap: 6px; flex-wrap: wrap;
        padding: 8px 20px;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.07));
      }
      .sadm-ctrl-btn {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.75));
        font-family: inherit; font-size: 9px; font-weight: 700;
        letter-spacing: 0.08em;
        padding: 5px 12px;
        border-radius: 5px;
        cursor: pointer;
        transition: color 120ms, border-color 120ms, background 120ms;
      }
      .sadm-ctrl-btn:hover {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-primary, #fbbf24);
        background: rgba(251,191,36,0.05);
      }
      .sadm-ctrl-btn-primary {
        color: #22c55e;
        border-color: rgba(34,197,94,0.45);
      }
      .sadm-ctrl-btn-primary:hover {
        color: #22c55e;
        border-color: #22c55e;
        background: rgba(34,197,94,0.06);
      }
      .sadm-ctrl-btn-danger {
        color: #ef4444;
        border-color: rgba(239,68,68,0.40);
      }
      .sadm-ctrl-btn-danger:hover {
        color: #ef4444;
        border-color: #ef4444;
        background: rgba(239,68,68,0.07);
      }
      .sadm-ctrl-btn-active {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-primary, #fbbf24);
        background: rgba(251,191,36,0.07);
      }

      /* Edit area */
      .sadm-edit-area {
        flex-shrink: 0;
        padding: 8px 20px;
        border-top: 1px solid rgba(251,191,36,0.25);
        background: rgba(251,191,36,0.04);
        display: flex; flex-direction: column; gap: 6px;
      }
      .sadm-edit-label {
        font-size: 8px; font-weight: 800;
        letter-spacing: 0.14em;
        color: var(--g-primary, #fbbf24);
      }
      .sadm-edit-actions {
        display: flex; gap: 6px;
      }

      /* Composer */
      .sadm-composer {
        flex-shrink: 0;
        display: flex; gap: 8px; align-items: flex-end;
        padding: 10px 20px 12px;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.10));
        background: rgba(255,255,255,0.02);
      }
      .sadm-composer-disabled {
        align-items: center;
        min-height: 44px;
      }
      .sadm-composer-input {
        flex: 1;
        background: rgba(255,255,255,0.05);
        border: 1px solid var(--g-border, rgba(255,255,255,0.15));
        border-radius: 6px;
        color: var(--g-fg, rgba(245,245,244,0.95));
        font-family: inherit; font-size: 11px;
        padding: 8px 10px;
        resize: none;
        transition: border-color 120ms;
        outline: none;
        width: 100%;
      }
      .sadm-composer-input:focus {
        border-color: var(--g-primary, #fbbf24);
      }
      .sadm-composer-input:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .sadm-send-btn {
        flex-shrink: 0;
        padding: 8px 18px;
        font-size: 11px;
      }
      .sadm-send-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Tool/Output tabs */
      .sadm-tool-list,
      .sadm-output-list,
      .sadm-history-list {
        display: flex; flex-direction: column; gap: 6px;
      }
      .sadm-tool-row {
        display: flex; gap: 8px; align-items: flex-start;
        padding: 6px 8px;
        border: 1px solid var(--g-border, rgba(255,255,255,0.09));
        border-radius: 6px;
      }
      .sadm-tool-row-text {
        flex: 1; margin: 0;
        font-family: inherit; font-size: 9px; line-height: 1.4;
        white-space: pre-wrap; word-break: break-word;
        color: rgba(245,245,244,0.75);
      }
      .sadm-output-block {
        background: rgba(0,0,0,0.25);
        border: 1px solid var(--g-border, rgba(255,255,255,0.09));
        border-radius: 6px;
        padding: 8px 10px;
        margin: 0;
        font-family: inherit; font-size: 9px; line-height: 1.4;
        white-space: pre-wrap; word-break: break-word;
        color: rgba(245,245,244,0.75);
        max-height: 140px; overflow-y: auto;
      }
      .sadm-history-row {
        display: flex; gap: 10px;
        padding: 5px 0;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.06));
        font-size: 10px;
      }
      .sadm-history-role {
        flex-shrink: 0;
        width: 70px;
        font-size: 8px; font-weight: 700;
        letter-spacing: 0.1em;
        color: var(--g-fg-faint, rgba(245,245,244,0.40));
        text-transform: uppercase;
        padding-top: 1px;
      }
      .sadm-history-text {
        flex: 1;
        color: var(--g-fg-dim, rgba(245,245,244,0.75));
        line-height: 1.45;
        word-break: break-word;
      }

      /* Inline artifact viewer */
      .sadm-artifact-md {
        border: 1px solid rgba(181,154,79,0.25);
        border-radius: 8px;
        overflow: hidden;
        margin-bottom: 6px;
        background: rgba(181,154,79,0.04);
      }
      .sadm-artifact-md-header {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        background: rgba(181,154,79,0.08);
        border-bottom: 1px solid rgba(181,154,79,0.15);
        font-size: 11px; font-weight: 600;
        color: var(--g-gold,#b59a4f);
      }
      .sadm-artifact-md-body {
        padding: 12px 14px;
        font-size: 12px; line-height: 1.6;
        color: rgba(245,245,244,0.85);
        max-height: 400px; overflow-y: auto;
      }
      .sadm-artifact-md-body h1,.sadm-artifact-md-body h2,.sadm-artifact-md-body h3 {
        color: var(--g-gold,#b59a4f); margin: 0.5em 0 0.25em;
      }
      .sadm-artifact-md-body code {
        background: rgba(0,0,0,0.3); border-radius: 3px;
        padding: 1px 4px; font-size: 11px;
      }
      .sadm-artifact-md-body pre {
        background: rgba(0,0,0,0.3); border-radius: 6px;
        padding: 10px 12px; overflow-x: auto;
      }
      .sadm-artifact-load-btn {
        background: rgba(181,154,79,0.1);
        border: 1px solid rgba(181,154,79,0.3);
        border-radius: 6px; padding: 6px 14px;
        color: var(--g-gold,#b59a4f); cursor: pointer;
        font-size: 12px;
      }
      .sadm-artifact-load-btn:hover { background: rgba(181,154,79,0.18); }
      .sadm-artifact-img { margin-bottom: 6px; }
      .sadm-artifact-pdf {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 6px; font-size: 12px; margin-bottom: 4px;
      }

      /* Overview tab content */
      .sadm-section { margin-bottom: 18px; }
      .sadm-section-label {
        display: flex; gap: 8px; align-items: center;
        font-size: 9px; font-weight: 700;
        letter-spacing: 0.14em;
        color: var(--g-primary, #fbbf24);
        text-transform: uppercase;
        margin-bottom: 8px;
      }
      .sadm-count {
        font-size: 9px;
        padding: 1px 7px;
        border: 1px solid var(--g-border, rgba(255,255,255,0.18));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        border-radius: 3px;
      }
      .sadm-empty {
        font-size: 10px; font-style: italic;
        color: var(--g-fg-faint, rgba(245,245,244,0.45));
        padding: 6px 0;
      }
      .sadm-task-block {
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 11px;
        font-family: inherit;
        color: var(--g-fg-dim, rgba(245,245,244,0.80));
        white-space: pre-wrap; word-break: break-word;
        margin: 0;
        line-height: 1.45;
      }
      .sadm-task-markdown {
        white-space: normal;
        font-size: 12px;
        line-height: 1.55;
        color: var(--g-fg, rgba(245,245,244,0.92));
      }
      .sadm-task-markdown > :first-child { margin-top: 0; }
      .sadm-task-markdown > :last-child { margin-bottom: 0; }
      .sadm-task-markdown h1,
      .sadm-task-markdown h2,
      .sadm-task-markdown h3,
      .sadm-task-markdown h4 {
        margin: 14px 0 6px;
        font-weight: 700;
        color: var(--g-primary, #FFD700);
        letter-spacing: 0.2px;
      }
      .sadm-task-markdown h1 { font-size: 15px; }
      .sadm-task-markdown h2 { font-size: 13px; }
      .sadm-task-markdown h3,
      .sadm-task-markdown h4 { font-size: 12px; text-transform: uppercase; opacity: 0.85; }
      .sadm-task-markdown p { margin: 6px 0; }
      .sadm-task-markdown ul,
      .sadm-task-markdown ol { margin: 6px 0; padding-left: 18px; }
      .sadm-task-markdown li { margin: 2px 0; }
      .sadm-task-markdown li > p { margin: 0; }
      .sadm-task-markdown code {
        background: rgba(255,255,255,0.06);
        border: 1px solid var(--g-border, rgba(255,255,255,0.08));
        border-radius: 4px;
        padding: 1px 5px;
        font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
        font-size: 11px;
      }
      .sadm-task-markdown pre {
        background: rgba(0,0,0,0.35);
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        border-radius: 6px;
        padding: 8px 10px;
        margin: 8px 0;
        overflow-x: auto;
        font-size: 11px;
        line-height: 1.45;
      }
      .sadm-task-markdown pre code {
        background: transparent;
        border: 0;
        padding: 0;
      }
      .sadm-task-markdown blockquote {
        margin: 8px 0;
        padding: 4px 10px;
        border-left: 2px solid color-mix(in srgb, var(--g-primary, #FFD700) 60%, transparent);
        color: var(--g-fg-dim, rgba(245,245,244,0.80));
      }
      .sadm-task-markdown a {
        color: var(--g-primary, #FFD700);
        text-decoration: none;
        border-bottom: 1px dashed color-mix(in srgb, var(--g-primary, #FFD700) 50%, transparent);
      }
      .sadm-task-markdown a:hover { border-bottom-style: solid; }
      .sadm-task-markdown hr {
        margin: 12px 0;
        border: 0;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.10));
      }
      .sadm-task-markdown strong { color: var(--g-fg, rgba(245,245,244,0.95)); }
      .sadm-task-markdown table {
        border-collapse: collapse;
        margin: 8px 0;
        font-size: 11px;
      }
      .sadm-task-markdown th,
      .sadm-task-markdown td {
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        padding: 4px 8px;
        text-align: left;
      }
      .sadm-task-markdown th { background: rgba(255,255,255,0.04); font-weight: 600; }
      .sadm-row-list { display: flex; flex-direction: column; gap: 6px; }
      .sadm-row {
        display: flex; align-items: center; gap: 10px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.03);
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        border-radius: 8px;
        cursor: pointer;
        text-align: left;
        font-family: inherit;
        color: inherit;
        transition: background 120ms, border-color 120ms, transform 120ms;
        width: 100%;
      }
      .sadm-row:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--g-border-strong, rgba(255,255,255,0.22));
        transform: translateX(2px);
      }
      .sadm-row-icon { font-size: 14px; flex-shrink: 0; }
      .sadm-row-main { flex: 1; min-width: 0; }
      .sadm-row-title {
        display: block;
        font-size: 11px; font-weight: 600;
        color: var(--g-fg, rgba(245,245,244,0.95));
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .sadm-row-sub {
        display: flex; gap: 8px; align-items: center;
        margin-top: 3px;
        font-size: 9px;
        color: var(--g-fg-dim, rgba(245,245,244,0.55));
        letter-spacing: 0.04em;
      }
      .sadm-row-tag { color: var(--g-primary, #fbbf24); font-weight: 600; }
      .sadm-row-chev {
        color: var(--g-fg-faint, rgba(245,245,244,0.40));
        font-size: 16px; flex-shrink: 0;
      }
      .sadm-action-badge {
        font-size: 8px; font-weight: 700;
        padding: 1px 6px;
        border: 1px solid;
        border-radius: 3px;
        letter-spacing: 0.06em;
        margin-left: 4px;
      }
      .sadm-files {
        display: flex; flex-direction: column;
        max-height: 280px; overflow-y: auto;
        border: 1px solid var(--g-border, rgba(255,255,255,0.10));
        border-radius: 8px;
      }
      .sadm-file-row {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        font-size: 10px;
        border-bottom: 1px solid var(--g-border, rgba(255,255,255,0.06));
      }
      .sadm-file-row:last-child { border-bottom: none; }
      .sadm-file-act {
        width: 16px; font-weight: 700; flex-shrink: 0; text-align: center;
      }
      .sadm-file-name {
        flex: 1; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--g-fg, rgba(245,245,244,0.92));
      }
      .sadm-file-dir { color: var(--g-fg-faint, rgba(245,245,244,0.40)); }
      .sadm-file-btns { display: flex; gap: 4px; flex-shrink: 0; }
      .sadm-file-btn {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.12));
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
        width: 22px; height: 22px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        font-size: 11px;
        border-radius: 4px;
        text-decoration: none;
        font-family: inherit;
        transition: color 120ms, border-color 120ms;
      }
      .sadm-file-btn:hover {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-primary, #fbbf24);
      }
      .sadm-meta-grid {
        display: flex; flex-direction: column; gap: 4px;
        font-size: 10px;
        color: var(--g-fg-dim, rgba(245,245,244,0.65));
      }
      .sadm-mk {
        display: inline-block; min-width: 80px;
        font-size: 9px; font-weight: 700;
        color: var(--g-fg-faint, rgba(245,245,244,0.45));
        letter-spacing: 0.1em;
      }

      /* Footer */
      .sadm-footer {
        flex-shrink: 0;
        display: flex; align-items: center; gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--g-border, rgba(255,255,255,0.10));
        background: rgba(255,255,255,0.03);
      }
      .sadm-btn {
        background: none;
        border: 1px solid var(--g-border, rgba(255,255,255,0.22));
        color: var(--g-fg-dim, rgba(245,245,244,0.80));
        font-family: inherit;
        font-size: 10px; font-weight: 600;
        letter-spacing: 0.08em;
        padding: 7px 14px;
        border-radius: 6px;
        cursor: pointer;
        transition: color 120ms, border-color 120ms, background 120ms;
      }
      .sadm-btn:hover {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-primary, #fbbf24);
        background: rgba(251,191,36,0.05);
      }
      .sadm-btn-primary {
        color: var(--g-primary, #fbbf24);
        border-color: var(--g-primary, #fbbf24);
      }
      .sadm-btn-danger {
        color: #ef4444;
        border-color: rgba(239,68,68,0.45);
      }
      .sadm-btn-danger:hover {
        color: #ef4444;
        border-color: #ef4444;
        background: rgba(239,68,68,0.07);
      }
      .sadm-btn-respawn {
        color: #fbbf24;
        border-color: rgba(251,191,36,0.55);
        background: rgba(251,191,36,0.08);
      }
      .sadm-btn-respawn:hover:not(:disabled) {
        color: #fcd34d;
        border-color: #fbbf24;
        background: rgba(251,191,36,0.14);
      }
      .sadm-btn-respawn:disabled {
        opacity: 0.6;
        cursor: progress;
      }
      .sadm-btn-link {
        border: none; padding: 6px 4px;
        color: var(--g-primary, #fbbf24);
        font-size: 9px;
        text-decoration: underline dotted;
      }
      .sadm-btn:disabled, .sadm-btn-primary:disabled {
        opacity: 0.4; cursor: not-allowed;
      }

      /* Loading skeleton */
      .sadm-loading { padding: 24px; display: flex; flex-direction: column; gap: 10px; }
      .sadm-skel {
        height: 12px;
        background: linear-gradient(90deg,
          rgba(255,255,255,0.06) 0%,
          rgba(255,255,255,0.12) 50%,
          rgba(255,255,255,0.06) 100%);
        background-size: 200% 100%;
        border-radius: 3px;
        animation: sadm-skel-shimmer 1.5s ease-in-out infinite;
      }
      .sadm-skel-title { width: 60%; height: 16px; margin-bottom: 4px; }
      .sadm-skel-row   { width: 100%; }
      @keyframes sadm-skel-shimmer {
        0%   { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      /* Error */
      .sadm-error { padding: 24px; display: flex; flex-direction: column; gap: 10px; }
      .sadm-error-title {
        font-size: 12px; font-weight: 700;
        color: #ef4444;
        letter-spacing: 0.05em;
      }
      .sadm-error-msg {
        font-size: 10px;
        color: var(--g-fg-dim, rgba(245,245,244,0.70));
        line-height: 1.5;
        background: rgba(239,68,68,0.06);
        border: 1px solid rgba(239,68,68,0.25);
        border-radius: 6px;
        padding: 8px 10px;
      }
      .sadm-error-actions { display: flex; gap: 8px; margin-top: 6px; }
    </style>
  `;
}
