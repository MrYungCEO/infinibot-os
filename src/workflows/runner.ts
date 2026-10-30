/**
 * Workflow runner — preflight + spawn agent + run store.
 *
 * Responsibilities:
 *   1. **Validate inputs** against the workflow's `inputs[]` schema.
 *      Required fields, types, enums, regex, numeric bounds — all enforced
 *      here before the agent ever sees the task.
 *   2. **Preflight requirements** declared in `requires[]` — verify the
 *      tools/MCP servers/env vars/channels/federation nodes the workflow
 *      needs are actually available right now. Returns a structured list
 *      of issues so the UI can show "tool X is missing" instead of
 *      surfacing a cryptic agent error mid-run.
 *   3. **Interpolate** the validated inputs into the body using `{{name}}`
 *      placeholders, plus a `<inputs>` JSON block prefix so even agents
 *      that don't render templates can still see the values verbatim.
 *   4. **Spawn the agent session** via the existing `sessions.spawn`
 *      gateway handler, returning a runId the UI can poll / subscribe to.
 *   5. **Track runs** in a JSON file alongside the workflow store.
 *
 * Design choice: runs are persisted to disk so they survive a gateway
 * restart and the UI can show "what ran today". The store is small
 * (capped at 500 rows) — for serious history we'd switch to SQLite.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

import type {
  Workflow,
  WorkflowCliKind,
  WorkflowExecutionMode,
  WorkflowInputDef,
  WorkflowPreflightIssue,
  WorkflowPreflightResult,
  WorkflowRequirement,
  WorkflowRun,
  WorkflowRunStatus,
} from "./types.js";
import { WorkflowStore } from "./store.js";

const log = createSubsystemLogger("workflow").child("runner");

const RUN_HISTORY_LIMIT = 500;

// ── Run store ────────────────────────────────────────────────────────

export class WorkflowRunStore {
  private readonly file: string;
  private cache: WorkflowRun[] | null = null;

  constructor(stateDir: string) {
    const dir = path.join(stateDir, "workflows");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "runs.json");
  }

  private load(): WorkflowRun[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.file)) {
      this.cache = [];
      return this.cache;
    }
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw);
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.cache = [];
    }
    return this.cache;
  }

  private save(): void {
    if (!this.cache) return;
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), "utf-8");
  }

  list(opts?: { workflowId?: string; limit?: number }): WorkflowRun[] {
    let runs = [...this.load()];
    if (opts?.workflowId) {
      runs = runs.filter((r) => r.workflowId === opts.workflowId);
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (opts?.limit && opts.limit > 0) runs = runs.slice(0, opts.limit);
    return runs;
  }

  get(runId: string): WorkflowRun | null {
    return this.load().find((r) => r.id === runId) ?? null;
  }

  insert(run: WorkflowRun): void {
    const runs = this.load();
    runs.unshift(run);
    if (runs.length > RUN_HISTORY_LIMIT) runs.length = RUN_HISTORY_LIMIT;
    this.save();
  }

  update(runId: string, patch: Partial<WorkflowRun>): WorkflowRun | null {
    const runs = this.load();
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx < 0) return null;
    runs[idx] = { ...runs[idx], ...patch };
    this.save();
    return runs[idx];
  }
}

// ── Input validation ─────────────────────────────────────────────────

function isAllowedSelectValue(def: WorkflowInputDef, value: unknown): boolean {
  if (!Array.isArray(def.options) || def.options.length === 0) return true;
  return def.options.some((opt) => opt.value === value);
}

function coerceInputValue(
  def: WorkflowInputDef,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  // Defaults — applied when raw is undefined/null/empty string.
  const isEmpty =
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0);
  if (isEmpty) {
    if (def.default !== undefined) return { ok: true, value: def.default };
    if (def.required) return { ok: false, error: `'${def.name}' is required` };
    return { ok: true, value: undefined };
  }
  switch (def.type) {
    case "string":
    case "text":
    case "url":
    case "email": {
      if (typeof raw !== "string") {
        return { ok: false, error: `'${def.name}' must be a string` };
      }
      if (def.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(def.pattern);
        } catch {
          return { ok: false, error: `'${def.name}': invalid regex in pattern` };
        }
        if (!re.test(raw)) {
          return {
            ok: false,
            error: `'${def.name}' does not match pattern ${def.pattern}`,
          };
        }
      }
      if (def.type === "email" && !/^\S+@\S+\.\S+$/.test(raw)) {
        return { ok: false, error: `'${def.name}' must be a valid email address` };
      }
      if (def.type === "url") {
        try {
          new URL(raw);
        } catch {
          return { ok: false, error: `'${def.name}' must be a valid URL` };
        }
      }
      return { ok: true, value: raw };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `'${def.name}' must be a number` };
      }
      if (typeof def.min === "number" && n < def.min) {
        return { ok: false, error: `'${def.name}' must be >= ${def.min}` };
      }
      if (typeof def.max === "number" && n > def.max) {
        return { ok: false, error: `'${def.name}' must be <= ${def.max}` };
      }
      return { ok: true, value: n };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "string") {
        if (/^(true|yes|1)$/i.test(raw)) return { ok: true, value: true };
        if (/^(false|no|0)$/i.test(raw)) return { ok: true, value: false };
      }
      return { ok: false, error: `'${def.name}' must be true or false` };
    }
    case "select": {
      if (typeof raw !== "string") {
        return { ok: false, error: `'${def.name}' must be a string` };
      }
      if (!isAllowedSelectValue(def, raw)) {
        return { ok: false, error: `'${def.name}' must be one of the configured options` };
      }
      return { ok: true, value: raw };
    }
    case "multiSelect": {
      if (!Array.isArray(raw)) {
        return { ok: false, error: `'${def.name}' must be an array` };
      }
      for (const v of raw) {
        if (typeof v !== "string" || !isAllowedSelectValue(def, v)) {
          return {
            ok: false,
            error: `'${def.name}' contains a value outside the configured options`,
          };
        }
      }
      return { ok: true, value: raw };
    }
    case "date": {
      if (typeof raw !== "string") {
        return { ok: false, error: `'${def.name}' must be an ISO date string` };
      }
      if (Number.isNaN(Date.parse(raw))) {
        return { ok: false, error: `'${def.name}' is not a parseable date` };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: `'${def.name}': unsupported input type ${def.type}` };
  }
}

export function validateInputs(
  inputs: WorkflowInputDef[] | undefined,
  raw: Record<string, unknown> | undefined,
): { ok: true; values: Record<string, unknown> } | { ok: false; errors: string[] } {
  const out: Record<string, unknown> = {};
  const errs: string[] = [];
  const defs = inputs ?? [];
  for (const def of defs) {
    const r = coerceInputValue(def, raw?.[def.name]);
    if (!r.ok) {
      errs.push(r.error);
      continue;
    }
    if (r.value !== undefined) out[def.name] = r.value;
  }
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, values: out };
}

// ── Requirement preflight ────────────────────────────────────────────

async function checkRequirement(req: WorkflowRequirement): Promise<WorkflowPreflightIssue | null> {
  const severity: WorkflowPreflightIssue["severity"] = req.optional ? "warning" : "error";
  switch (req.kind) {
    case "env": {
      const v = process.env[req.name];
      if (typeof v !== "string" || v.length === 0) {
        return {
          severity,
          requirement: req,
          detail: `env var ${req.name} is not set`,
        };
      }
      return null;
    }
    case "tool": {
      // The agent.tools.list handler returns `{ name, description,
      // inputSchema }` — NOT `{ id }`. Reading `t.id` made every
      // tool show up as undefined here and every preflight failed
      // with "tool 'X' not registered" even when the tool was
      // registered. Match against both fields for forward-compat
      // with future shape changes.
      try {
        const res = (await callGateway({
          method: "agent.tools.list",
          params: {},
          timeoutMs: 5_000,
        })) as { tools?: Array<{ id?: string; name?: string }> };
        const known = (res?.tools ?? [])
          .map((t) => t.name ?? t.id)
          .filter((n): n is string => typeof n === "string" && n.length > 0);
        if (!known.includes(req.name)) {
          return {
            severity,
            requirement: req,
            detail: `tool '${req.name}' not registered`,
          };
        }
        return null;
      } catch (e) {
        return {
          severity: "warning",
          requirement: req,
          detail: `could not query agent.tools.list: ${String(e)}`,
        };
      }
    }
    case "mcp": {
      try {
        const res = (await callGateway({
          method: "mcp.list",
          params: {},
          timeoutMs: 5_000,
        })) as { servers?: Array<{ id?: string; name?: string; status?: string }> };
        const found = (res?.servers ?? []).find((s) => s.id === req.name || s.name === req.name);
        if (!found) {
          return {
            severity,
            requirement: req,
            detail: `MCP server '${req.name}' not registered`,
          };
        }
        if (found.status && found.status !== "connected" && found.status !== "ready") {
          return {
            severity,
            requirement: req,
            detail: `MCP server '${req.name}' status=${found.status}`,
          };
        }
        return null;
      } catch (e) {
        return {
          severity: "warning",
          requirement: req,
          detail: `could not query mcp.list: ${String(e)}`,
        };
      }
    }
    case "channel": {
      try {
        const res = (await callGateway({
          method: "channels.capabilities",
          params: {},
          timeoutMs: 5_000,
        })) as { channels?: Array<{ id?: string; enabled?: boolean }> };
        const ch = (res?.channels ?? []).find((c) => c.id === req.name);
        if (!ch) {
          return {
            severity,
            requirement: req,
            detail: `channel '${req.name}' not configured`,
          };
        }
        if (ch.enabled === false) {
          return {
            severity,
            requirement: req,
            detail: `channel '${req.name}' is disabled`,
          };
        }
        return null;
      } catch (e) {
        return {
          severity: "warning",
          requirement: req,
          detail: `could not query channels.capabilities: ${String(e)}`,
        };
      }
    }
    case "node": {
      try {
        const res = (await callGateway({
          method: "federation.nodes.list",
          params: {},
          timeoutMs: 5_000,
        })) as { nodes?: Array<{ id?: string; name?: string; status?: string }> };
        const node = (res?.nodes ?? []).find((n) => n.id === req.name || n.name === req.name);
        if (!node) {
          return {
            severity,
            requirement: req,
            detail: `federation node '${req.name}' not connected`,
          };
        }
        if (node.status && node.status === "offline") {
          return {
            severity,
            requirement: req,
            detail: `federation node '${req.name}' is offline`,
          };
        }
        return null;
      } catch (e) {
        return {
          severity: "warning",
          requirement: req,
          detail: `could not query federation.nodes.list: ${String(e)}`,
        };
      }
    }
    case "model": {
      try {
        const res = (await callGateway({
          method: "models.list",
          params: {},
          timeoutMs: 5_000,
        })) as { models?: Array<{ id: string }> };
        const ids = (res?.models ?? []).map((m) => m.id);
        if (!ids.includes(req.name)) {
          return {
            severity,
            requirement: req,
            detail: `model '${req.name}' not in catalog`,
          };
        }
        return null;
      } catch (e) {
        return {
          severity: "warning",
          requirement: req,
          detail: `could not query models.list: ${String(e)}`,
        };
      }
    }
    default:
      return {
        severity: "warning",
        requirement: req,
        detail: `unknown requirement kind '${(req as WorkflowRequirement).kind}'`,
      };
  }
}

export async function checkRequirements(
  reqs: WorkflowRequirement[] | undefined,
): Promise<WorkflowPreflightIssue[]> {
  if (!reqs || reqs.length === 0) return [];
  const results = await Promise.all(reqs.map((r) => checkRequirement(r)));
  return results.filter((r): r is WorkflowPreflightIssue => r !== null);
}

// ── Interpolation ────────────────────────────────────────────────────

/**
 * Replace `{{name}}` placeholders in the body with input values. Unknown
 * placeholders are left in place (no surprise empty strings) so the agent
 * can flag them. We also prepend a `<inputs>` JSON block so models that
 * don't understand templating still see the values.
 */
function interpolateBody(body: string, values: Record<string, unknown>): string {
  const inputsBlock = [
    "<inputs>",
    JSON.stringify(values, null, 2),
    "</inputs>",
    "",
    "Use the values inside `<inputs>` above when executing the workflow.",
    "",
  ].join("\n");
  const replaced = body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      const v = values[name];
      if (v === null || v === undefined) return "";
      return Array.isArray(v) ? v.join(", ") : String(v);
    }
    return `{{${name}}}`;
  });
  return `${inputsBlock}${replaced}`;
}

// ── Public API ───────────────────────────────────────────────────────

export interface PreflightOpts {
  inputs?: Record<string, unknown>;
}

export async function preflightWorkflow(
  workflow: Workflow,
  opts: PreflightOpts = {},
): Promise<WorkflowPreflightResult> {
  const issues: WorkflowPreflightIssue[] = [];
  const v = validateInputs(workflow.inputs, opts.inputs);
  let resolved: Record<string, unknown> = {};
  if (!v.ok) {
    for (const err of v.errors) {
      issues.push({
        severity: "error",
        requirement: { kind: "tool", name: "input-validation" },
        detail: err,
      });
    }
  } else {
    resolved = v.values;
  }
  const reqIssues = await checkRequirements(workflow.requires);
  issues.push(...reqIssues);
  const ok = issues.every((i) => i.severity !== "error");
  return {
    ok,
    issues,
    resolvedInputs: resolved,
    interpolatedBody: ok ? interpolateBody(workflow.body, resolved) : undefined,
  };
}

export interface RunWorkflowOpts {
  inputs?: Record<string, unknown>;
  /** Override the workflow's declared agent. */
  agentId?: string;
  /** Override the workflow's declared model. */
  model?: string;
  /** Override the workflow's declared timeout. */
  timeoutSeconds?: number;
  /**
   * How the spawned agent runs. "gateway" (default) goes through sessions.spawn.
   * "terminal" launches a CLI (cli below) inside a long-lived PTY via
   * terminal.spawnAgent so the workflow card can re-attach to the live TUI.
   */
  executionMode?: WorkflowExecutionMode;
  /** CLI to launch when executionMode === "terminal". Defaults to "claude". */
  cli?: WorkflowCliKind;
  /** Working directory for terminal-mode spawns. Defaults to "." */
  cwd?: string;
}

export async function runWorkflow(params: {
  stateDir: string;
  workflowId: string;
  opts?: RunWorkflowOpts;
}): Promise<{ run: WorkflowRun; preflight: WorkflowPreflightResult }> {
  const { stateDir, workflowId } = params;
  const opts = params.opts ?? {};
  const store = new WorkflowStore(stateDir);
  const runStore = new WorkflowRunStore(stateDir);
  const wf = store.get(workflowId);
  if (!wf) {
    throw new Error(`workflow '${workflowId}' not found`);
  }
  const preflight = await preflightWorkflow(wf, { inputs: opts.inputs });
  const runId = `wfr_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const agent = opts.agentId ?? wf.agent ?? "main";

  if (!preflight.ok) {
    const summary = preflight.issues
      .filter((i) => i.severity === "error")
      .map((i) => i.detail)
      .join("; ");
    const failed: WorkflowRun = {
      id: runId,
      workflowId: wf.id,
      workflowName: wf.name,
      status: "failed",
      inputs: preflight.resolvedInputs,
      agent,
      startedAt,
      finishedAt: startedAt,
      error: `preflight failed: ${summary}`,
      preflight,
    };
    runStore.insert(failed);
    return { run: failed, preflight };
  }

  // Spawn the agent session. By default we use the `sessions.spawn` handler
  // for a native gateway subagent — that gives us session tracking, run-id
  // correlation, and the existing UI surfaces for free. When the caller
  // chose terminal mode, we route through terminal.spawnAgent instead so the
  // workflow card can attach back to the live Claude Code TUI on click.
  const label = `workflow:${wf.id}`;
  const task = preflight.interpolatedBody ?? wf.body;
  const timeoutSeconds = opts.timeoutSeconds ?? wf.timeoutSeconds ?? 600;
  const model = opts.model ?? wf.model;
  const executionMode: WorkflowExecutionMode = opts.executionMode ?? "gateway";
  const cli: WorkflowCliKind = opts.cli ?? "claude";
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : ".";

  const pendingRun: WorkflowRun = {
    id: runId,
    workflowId: wf.id,
    workflowName: wf.name,
    status: "pending",
    inputs: preflight.resolvedInputs,
    agent,
    startedAt,
    preflight,
    executionMode,
    cli: executionMode === "terminal" ? cli : undefined,
  };
  runStore.insert(pendingRun);

  try {
    if (executionMode === "terminal") {
      // Mint sessionKey + reuse runId so terminal.spawnAgent's PTY is
      // findable in the spawn registry under the same id we store on the run.
      const sessionKey = `workflow:${wf.id}:${runId}`;
      const termRes = (await callGateway({
        method: "terminal.spawnAgent",
        params: {
          cli,
          cwd,
          task,
          label,
          runId,
          sessionKey,
          agentId: agent,
          // Keep the PTY alive after completion so the operator can re-open
          // the workflow card and read the full scrollback.
          autoClose: false,
        },
        timeoutMs: 30_000,
      })) as { success?: boolean; terminalId?: string; error?: string };
      if (!termRes?.success || !termRes.terminalId) {
        throw new Error(`terminal.spawnAgent failed: ${termRes?.error ?? "unknown error"}`);
      }
      const updated = runStore.update(runId, {
        status: "running",
        sessionKey,
        spawnRunId: runId,
        terminalId: termRes.terminalId,
      });
      log.info(`workflow run ${runId} spawned ${cli} terminal ${termRes.terminalId}`);
      return { run: updated ?? pendingRun, preflight };
    }

    const spawnRes = (await callGateway({
      method: "sessions.spawn",
      params: {
        task,
        agentId: agent,
        label,
        model,
        runTimeoutSeconds: timeoutSeconds,
      },
      timeoutMs: Math.min(timeoutSeconds * 1000, 30 * 60_000),
    })) as
      | {
          childSessionKey?: string;
          sessionKey?: string;
          runId?: string;
          status?: string;
          error?: string;
        }
      | undefined;
    const sessionKey = spawnRes?.childSessionKey ?? spawnRes?.sessionKey;
    if (spawnRes?.status === "error") {
      throw new Error(spawnRes.error ?? "sessions.spawn returned error");
    }
    const updated = runStore.update(runId, {
      status: "running",
      sessionKey,
      spawnRunId: spawnRes?.runId,
    });
    log.info(`workflow run ${runId} spawned session ${sessionKey ?? "(no key)"}`);
    return { run: updated ?? pendingRun, preflight };
  } catch (err) {
    const failedRun = runStore.update(runId, {
      status: "failed" as WorkflowRunStatus,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    return { run: failedRun ?? pendingRun, preflight };
  }
}

export function cancelRun(stateDir: string, runId: string): WorkflowRun | null {
  const runStore = new WorkflowRunStore(stateDir);
  const r = runStore.get(runId);
  if (!r) return null;
  if (r.status === "completed" || r.status === "failed" || r.status === "cancelled") {
    return r;
  }
  return runStore.update(runId, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    error: r.error ?? "cancelled by user",
  });
}

export function markRunCompleted(
  stateDir: string,
  runId: string,
  payload: { result?: string; error?: string; status?: WorkflowRunStatus },
): WorkflowRun | null {
  const runStore = new WorkflowRunStore(stateDir);
  return runStore.update(runId, {
    status: payload.status ?? (payload.error ? "failed" : "completed"),
    result: payload.result,
    error: payload.error,
    finishedAt: new Date().toISOString(),
  });
}
