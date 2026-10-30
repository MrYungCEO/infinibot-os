/**
 * Workflows Controller — state management and API calls for workflow CRUD + Notion sync.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ────────────────────────────────────────────────────

export interface WorkflowItem {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  author?: string;
  preview: string;
  bodyLength: number;
  updatedAt: string;
  createdAt: string;
  notionPageId?: string;
  notionSyncedAt?: string;
  kind?: "static" | "continuous";
}

export interface WorkflowInputDef {
  name: string;
  label?: string;
  description?: string;
  type: string;
  required?: boolean;
  default?: unknown;
  options?: Array<{ value: string; label?: string }>;
  pattern?: string;
  placeholder?: string;
  min?: number;
  max?: number;
}

export interface WorkflowRequirement {
  kind: "tool" | "mcp" | "env" | "channel" | "node" | "model";
  name: string;
  reason?: string;
  optional?: boolean;
}

export type WorkflowKind = "static" | "continuous";

export type ContinuousStopReason =
  | "manual"
  | "iteration_limit"
  | "error_streak"
  | "predicate";

export interface ContinuousConfig {
  iterationIntervalSeconds: number;
  maxIterations: number | null;
  iterationTimeoutSeconds?: number;
  errorStreakThreshold: number;
  stopOn: ContinuousStopReason[];
}

export interface WorkflowFull extends WorkflowItem {
  body: string;
  inputs?: WorkflowInputDef[];
  requires?: WorkflowRequirement[];
  agent?: string;
  model?: string;
  timeoutSeconds?: number;
  kind?: WorkflowKind;
  continuous?: ContinuousConfig;
}

export interface WorkflowIteration {
  number: number;
  startedAt: string;
  finishedAt?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "timeout";
  sessionKey?: string;
  result?: string;
  error?: string;
  durationMs?: number;
}

export interface ContinuousDaemonStatus {
  runId: string;
  workflowId: string;
  paused: boolean;
  stopped: boolean;
  stopReason?: ContinuousStopReason;
  stopRequestedBy?: string;
  iterationCount: number;
  errorStreak: number;
}

export interface WorkflowPreflightIssue {
  severity: "error" | "warning";
  requirement: WorkflowRequirement;
  detail: string;
}

export interface WorkflowPreflightResult {
  ok: boolean;
  issues: WorkflowPreflightIssue[];
  resolvedInputs: Record<string, unknown>;
  interpolatedBody?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled" | "timeout";
  kind?: WorkflowKind;
  inputs: Record<string, unknown>;
  sessionKey?: string;
  /** PTY id when this run launched the workflow's agent inside a terminal. */
  terminalId?: string;
  /** Spawn mode mirrored from the runner so UI can render the right CTA. */
  executionMode?: "gateway" | "terminal";
  /** CLI launched when executionMode === "terminal". */
  cli?: "claude" | "opencode" | "gemini" | "codex" | "grok";
  agent: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: string;
  iterations?: WorkflowIteration[];
  iterationCount?: number;
  errorStreak?: number;
  stopReason?: ContinuousStopReason;
  stopRequestedBy?: string;
}

export interface WorkflowRunDialogState {
  open: boolean;
  workflow: WorkflowFull | null;
  inputs: Record<string, unknown>;
  preflight: WorkflowPreflightResult | null;
  preflightInFlight: boolean;
  starting: boolean;
  error: string | null;
  /** Spawn the workflow agent natively ("gateway", default) or inside a
   *  long-lived PTY running the chosen CLI ("terminal"). */
  executionMode: "gateway" | "terminal";
  /** CLI to launch when executionMode === "terminal". */
  cli: "claude" | "opencode" | "gemini" | "codex" | "grok";
  /** Working directory for the terminal PTY. */
  cwd: string;
}

export interface WorkflowsState {
  workflows: WorkflowItem[];
  loading: boolean;
  error: string | null;
  /** Currently selected workflow (full content loaded). */
  selected: WorkflowFull | null;
  /** Editor draft body. */
  editorBody: string;
  /** Editor draft name. */
  editorName: string;
  /** Editor draft description. */
  editorDescription: string;
  /** Editor draft tags (comma-separated). */
  editorTags: string;
  /** Show the rendered-markdown preview (false) or the raw editor (true). Mirrors NotesState.editing. */
  editing: boolean;
  /** Is editor in "create new" mode? */
  isCreating: boolean;
  /** Is currently saving? */
  saving: boolean;
  /** Has unsaved changes? */
  dirty: boolean;
  /** Search/filter query. */
  searchQuery: string;
  /** Notion sync in progress. */
  notionSyncing: boolean;
  /** Success message (auto-dismiss). */
  successMessage: string | null;
  /** Run dialog state (typed input form + preflight outcome). */
  runDialog: WorkflowRunDialogState;
  /** Recent runs across all workflows (newest first). */
  recentRuns: WorkflowRun[];
  /** Live continuous daemons (autonomous-control workflows currently running). */
  liveDaemons: ContinuousDaemonStatus[];
}

export function createInitialWorkflowsState(): WorkflowsState {
  return {
    workflows: [],
    loading: false,
    error: null,
    selected: null,
    editorBody: "",
    editorName: "",
    editorDescription: "",
    editorTags: "",
    editing: true,
    isCreating: false,
    saving: false,
    dirty: false,
    searchQuery: "",
    notionSyncing: false,
    successMessage: null,
    runDialog: {
      open: false,
      workflow: null,
      inputs: {},
      preflight: null,
      preflightInFlight: false,
      starting: false,
      error: null,
      executionMode: "gateway",
      cli: "claude",
      cwd: "",
    },
    recentRuns: [],
    liveDaemons: [],
  };
}

// ── Run controller helpers ──────────────────────────────────

function applyDefaults(workflow: WorkflowFull): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of workflow.inputs ?? []) {
    if (def.default !== undefined) out[def.name] = def.default;
  }
  return out;
}

export async function openRunDialog(
  state: AppViewState,
  client: GatewayBrowserClient,
  workflowId: string,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws) return;
  ws.runDialog = {
    open: true,
    workflow: null,
    inputs: {},
    preflight: null,
    preflightInFlight: true,
    starting: false,
    error: null,
    executionMode: "gateway",
    cli: "claude",
    cwd: "",
  };
  state.requestUpdate?.();
  try {
    const wf = (await client.request("workflows.get", { id: workflowId })) as WorkflowFull;
    ws.runDialog.workflow = wf;
    ws.runDialog.inputs = applyDefaults(wf);
    await runPreflight(state, client);
  } catch (e) {
    ws.runDialog.error = e instanceof Error ? e.message : String(e);
    ws.runDialog.preflightInFlight = false;
    state.requestUpdate?.();
  }
}

export function closeRunDialog(state: AppViewState): void {
  const ws = state.workflowsState;
  if (!ws) return;
  ws.runDialog.open = false;
  ws.runDialog.workflow = null;
  ws.runDialog.preflight = null;
  ws.runDialog.error = null;
  state.requestUpdate?.();
}

export function setRunInput(state: AppViewState, name: string, value: unknown): void {
  const ws = state.workflowsState;
  if (!ws || !ws.runDialog.open) return;
  ws.runDialog.inputs = { ...ws.runDialog.inputs, [name]: value };
  state.requestUpdate?.();
}

export async function runPreflight(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws || !ws.runDialog.workflow) return;
  ws.runDialog.preflightInFlight = true;
  state.requestUpdate?.();
  try {
    const res = (await client.request("workflows.run.preflight", {
      id: ws.runDialog.workflow.id,
      inputs: ws.runDialog.inputs,
    })) as WorkflowPreflightResult;
    ws.runDialog.preflight = res;
    ws.runDialog.error = null;
  } catch (e) {
    ws.runDialog.error = e instanceof Error ? e.message : String(e);
  } finally {
    ws.runDialog.preflightInFlight = false;
    state.requestUpdate?.();
  }
}

export async function startRun(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws || !ws.runDialog.workflow) return;
  ws.runDialog.starting = true;
  ws.runDialog.error = null;
  state.requestUpdate?.();
  try {
    // Continuous workflows go to the daemon control plane; static workflows
    // use the legacy one-shot run pipeline.
    const isContinuous = ws.runDialog.workflow.kind === "continuous";
    const method = isContinuous ? "workflows.continuous.start" : "workflows.run.start";
    const mode = ws.runDialog.executionMode;
    const res = (await client.request(method, {
      id: ws.runDialog.workflow.id,
      inputs: ws.runDialog.inputs,
      executionMode: mode,
      // Only forward CLI/cwd when terminal mode is selected; the gateway
      // handler ignores them otherwise but the smaller payload is clearer.
      ...(mode === "terminal"
        ? { cli: ws.runDialog.cli, cwd: ws.runDialog.cwd.trim() || undefined }
        : {}),
    })) as { run: WorkflowRun; preflight?: WorkflowPreflightResult };
    if (res?.run?.status === "failed") {
      ws.runDialog.error = res.run.error ?? "Run failed";
      ws.runDialog.preflight = res.preflight ?? null;
    } else {
      const label = isContinuous ? "🔁 Continuous run started" : "▶ Run started";
      ws.successMessage = `${label} · ${res.run.workflowName}`;
      closeRunDialog(state);
      await loadRecentRuns(state, client);
      if (isContinuous) await loadLiveDaemons(state, client);
    }
  } catch (e) {
    ws.runDialog.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (ws.runDialog) ws.runDialog.starting = false;
    state.requestUpdate?.();
  }
}

export async function loadLiveDaemons(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws) return;
  try {
    const res = (await client.request("workflows.continuous.list", {})) as {
      daemons: ContinuousDaemonStatus[];
    };
    ws.liveDaemons = res?.daemons ?? [];
    state.requestUpdate?.();
  } catch {
    /* best-effort */
  }
}

export async function stopContinuous(
  state: AppViewState,
  client: GatewayBrowserClient,
  runId: string,
): Promise<void> {
  try {
    await client.request("workflows.continuous.stop", { runId });
    await loadLiveDaemons(state, client);
    await loadRecentRuns(state, client);
  } catch (e) {
    const ws = state.workflowsState;
    if (ws) ws.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function pauseContinuous(
  state: AppViewState,
  client: GatewayBrowserClient,
  runId: string,
): Promise<void> {
  try {
    await client.request("workflows.continuous.pause", { runId });
    await loadLiveDaemons(state, client);
  } catch (e) {
    const ws = state.workflowsState;
    if (ws) ws.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function resumeContinuous(
  state: AppViewState,
  client: GatewayBrowserClient,
  runId: string,
): Promise<void> {
  try {
    await client.request("workflows.continuous.resume", { runId });
    await loadLiveDaemons(state, client);
  } catch (e) {
    const ws = state.workflowsState;
    if (ws) ws.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function loadRecentRuns(
  state: AppViewState,
  client: GatewayBrowserClient,
  workflowId?: string,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws) return;
  try {
    const res = (await client.request("workflows.run.list", {
      workflowId,
      limit: 30,
    })) as { runs: WorkflowRun[] };
    ws.recentRuns = res?.runs ?? [];
    state.requestUpdate?.();
  } catch {
    /* best-effort — keeps existing list on failure */
  }
}

export async function cancelRun(
  state: AppViewState,
  client: GatewayBrowserClient,
  runId: string,
): Promise<void> {
  try {
    await client.request("workflows.run.cancel", { runId });
    await loadRecentRuns(state, client);
  } catch (e) {
    const ws = state.workflowsState;
    if (ws) ws.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── API Functions ────────────────────────────────────────────

export async function loadWorkflows(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws) return;

  ws.loading = true;
  ws.error = null;

  try {
    const res = (await client.request("workflows.list", {
      query: ws.searchQuery || undefined,
    })) as any;
    ws.workflows = res?.workflows ?? [];
    ws.loading = false;
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
    ws.loading = false;
  }
}

export async function loadWorkflow(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<void> {
  const ws = state.workflowsState;
  if (!ws) return;

  ws.loading = true;
  try {
    const res = (await client.request("workflows.get", { id })) as any;
    if (res) {
      const wf = res as WorkflowFull;
      ws.selected = wf;
      ws.editorBody = wf.body;
      ws.editorName = wf.name;
      ws.editorDescription = wf.description || "";
      ws.editorTags = wf.tags?.join(", ") || "";
      ws.isCreating = false;
      ws.dirty = false;
    }
    ws.loading = false;
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
    ws.loading = false;
  }
}

export async function createWorkflow(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const ws = state.workflowsState;
  if (!ws) return false;

  if (!ws.editorName.trim()) {
    ws.error = "Workflow name is required";
    return false;
  }

  ws.saving = true;
  ws.error = null;
  try {
    const tags = ws.editorTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = (await client.request("workflows.create", {
      name: ws.editorName.trim(),
      description: ws.editorDescription.trim() || undefined,
      body: ws.editorBody,
      tags: tags.length ? tags : undefined,
    })) as any;

    ws.saving = false;
    ws.isCreating = false;
    ws.dirty = false;
    ws.successMessage = `Workflow "${res.name}" created`;
    setTimeout(() => { if (ws.successMessage) ws.successMessage = null; }, 3000);

    // Reload list and select the new one
    await loadWorkflows(state, client);
    if (res?.id) await loadWorkflow(state, client, res.id);
    return true;
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
    ws.saving = false;
    return false;
  }
}

export async function updateWorkflow(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const ws = state.workflowsState;
  if (!ws || !ws.selected) return false;

  ws.saving = true;
  ws.error = null;
  try {
    const tags = ws.editorTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = (await client.request("workflows.update", {
      id: ws.selected.id,
      name: ws.editorName.trim() || undefined,
      description: ws.editorDescription.trim() || undefined,
      body: ws.editorBody,
      tags: tags.length ? tags : undefined,
    })) as any;

    ws.saving = false;
    ws.dirty = false;
    ws.successMessage = `Workflow "${res?.name || ws.selected.name}" saved`;
    setTimeout(() => { if (ws.successMessage) ws.successMessage = null; }, 3000);

    await loadWorkflows(state, client);
    if (ws.selected?.id) await loadWorkflow(state, client, ws.selected.id);
    return true;
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
    ws.saving = false;
    return false;
  }
}

export async function deleteWorkflow(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<boolean> {
  const ws = state.workflowsState;
  if (!ws) return false;

  try {
    await client.request("workflows.delete", { id });
    ws.selected = null;
    ws.editorBody = "";
    ws.editorName = "";
    ws.editorDescription = "";
    ws.editorTags = "";
    ws.dirty = false;
    ws.successMessage = "Workflow deleted";
    setTimeout(() => { if (ws.successMessage) ws.successMessage = null; }, 3000);
    await loadWorkflows(state, client);
    return true;
  } catch (e) {
    ws.error = e instanceof Error ? e.message : String(e);
    return false;
  }
}

export async function syncWorkflowToNotion(
  state: AppViewState,
  client: GatewayBrowserClient,
  id: string,
): Promise<boolean> {
  const ws = state.workflowsState;
  if (!ws) return false;

  ws.notionSyncing = true;
  ws.error = null;
  try {
    // Use the notion skill's API to create/update a page
    const wf = ws.selected || ws.workflows.find((w) => w.id === id);
    if (!wf) {
      ws.error = "Workflow not found";
      ws.notionSyncing = false;
      return false;
    }

    // Get the full workflow body if we only have a list item
    let body = "";
    if ("body" in wf) {
      body = (wf as WorkflowFull).body;
    } else {
      const full = (await client.request("workflows.get", { id })) as any;
      body = full?.body ?? "";
    }

    // Call notion sync through a system event that the agent handles
    // For now, use direct notion API via the skill endpoint
    const res = (await client.request("notion.sync.workflow", {
      workflowId: id,
      name: wf.name,
      description: wf.description || "",
      tags: wf.tags || [],
      body,
      notionPageId: wf.notionPageId || undefined,
    })) as any;

    // Update workflow with notion page ID if returned
    if (res?.notionPageId) {
      await client.request("workflows.update", {
        id,
        notionPageId: res.notionPageId,
        notionSyncedAt: new Date().toISOString(),
      });
    }

    ws.notionSyncing = false;
    ws.successMessage = "Synced to Notion";
    setTimeout(() => { if (ws.successMessage) ws.successMessage = null; }, 3000);
    if (ws.selected?.id === id) await loadWorkflow(state, client, id);
    return true;
  } catch (e) {
    ws.error = `Notion sync failed: ${e instanceof Error ? e.message : String(e)}`;
    ws.notionSyncing = false;
    return false;
  }
}

/** Start creating a new workflow (enter create mode). */
export function startCreateWorkflow(state: AppViewState): void {
  const ws = state.workflowsState;
  if (!ws) return;
  ws.selected = null;
  ws.isCreating = true;
  ws.editorBody = "# New Workflow\n\n## Steps\n\n1. \n2. \n3. \n";
  ws.editorName = "";
  ws.editorDescription = "";
  ws.editorTags = "";
  ws.dirty = true;
}
