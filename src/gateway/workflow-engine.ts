/**
 * WorkflowEngine — org-wide recurring proactive workflow scheduler.
 *
 * Manages a registry of multi-agent workflows that run on a cron schedule
 * or in response to events. Each step routes a prompt to a named agent via
 * the AgentBus. Steps that return "[NEEDS_REVIEW]" are routed back to the
 * previous step's agent before advancing.
 *
 * State is persisted to ~/.infinibot/workflow-engine.json so the registry
 * survives gateway restarts. Run history is kept in memory only.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { resolveExplicitAutonomy } from "../cron/autonomy-optin.js";
import { getAgentBus, type AgentMessageType } from "./agent-bus.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type WorkflowTrigger = "cron" | "event";

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "awaiting_agent"
  | "needs_review"
  | "completed"
  | "failed";

export type OrgWorkflowStepDef = {
  id: string;
  agentId: string;
  prompt: string;
  /** Message type forwarded to the AgentBus on execution */
  messageType?: AgentMessageType;
};

export type OrgWorkflow = {
  id: string;
  name: string;
  /** Milliseconds between automatic runs (0 = manual-only) */
  intervalMs: number;
  /** Agent ids that participate as steps in order */
  participants: string[];
  trigger: WorkflowTrigger;
  lastRun?: number;
  nextRun?: number;
  enabled: boolean;
  steps: OrgWorkflowStepDef[];
  /** Human-readable description */
  description?: string;
  /** Set when the autonomy opt-in registered this built-in disabled. */
  seededDisabled?: boolean;
};

export type OrgWorkflowStepRun = {
  stepId: string;
  agentId: string;
  status: WorkflowStepStatus;
  prompt: string;
  result?: string;
  startedAt?: number;
  completedAt?: number;
};

export type OrgWorkflowRun = {
  runId: string;
  workflowId: string;
  startedAt: number;
  steps: OrgWorkflowStepRun[];
  status: "running" | "completed" | "failed";
  completedAt?: number;
};

// ── Built-in workflow definitions ──────────────────────────────────────────

const DAILY_BRIEF_MS = 24 * 60 * 60 * 1000; // 24 h
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;

const BUILT_IN_WORKFLOWS: OrgWorkflow[] = [
  {
    id: "daily-brief",
    name: "Daily Brief",
    description:
      "Morning digest: each agent reads recent activity and produces a summary bullet. " +
      "Ends with main posting the digest to Telegram.",
    intervalMs: DAILY_BRIEF_MS,
    participants: ["main", "cmo", "content-director", "client-director"],
    trigger: "cron",
    enabled: true,
    steps: [
      {
        id: "daily-brief-1",
        agentId: "cmo",
        messageType: "task",
        prompt:
          "Morning brief: review your last 24 hours of content and campaign activity. " +
          "Produce 3 bullet points of key progress or blockers. Reply with just the bullets.",
      },
      {
        id: "daily-brief-2",
        agentId: "content-director",
        messageType: "task",
        prompt:
          "Morning brief: review active content briefs and publishing queue. " +
          "Produce 3 bullet points. Reply with just the bullets.",
      },
      {
        id: "daily-brief-3",
        agentId: "client-director",
        messageType: "task",
        prompt:
          "Morning brief: review open client relationships and pipeline. " +
          "Produce 3 bullet points. Reply with just the bullets.",
      },
      {
        id: "daily-brief-4",
        agentId: "main",
        messageType: "task",
        prompt:
          "Synthesize the daily brief from your team's reports and post a clean digest " +
          "to Telegram using the telegram tool. Keep it under 300 words.",
      },
    ],
  },
  {
    id: "weekly-pipeline-review",
    name: "Weekly Pipeline Review",
    description:
      "Monday review: client pipeline + open leads + revenue delta → Go/No-go decisions.",
    intervalMs: WEEKLY_MS,
    participants: ["client-director", "outreach", "ledger", "main"],
    trigger: "cron",
    enabled: true,
    steps: [
      {
        id: "wpr-1",
        agentId: "client-director",
        messageType: "task",
        prompt:
          "Weekly pipeline review: list all active clients with current status and next action. " +
          "Flag any at risk with [AT_RISK].",
      },
      {
        id: "wpr-2",
        agentId: "outreach",
        messageType: "task",
        prompt:
          "Weekly pipeline review: summarize open leads — count, average age, top 3 warmest. " +
          "Flag any stale > 14 days with [STALE].",
      },
      {
        id: "wpr-3",
        agentId: "ledger",
        messageType: "task",
        prompt:
          "Weekly pipeline review: report revenue delta vs last week in dollars and percent. " +
          "Include top 3 revenue sources.",
      },
      {
        id: "wpr-4",
        agentId: "main",
        messageType: "task",
        prompt:
          "Synthesize the weekly pipeline review into Go/No-go decisions for each active opportunity. " +
          "Post a concise report to Telegram. Flag items needing owner action with [ACTION_NEEDED].",
      },
    ],
  },
  {
    id: "hourly-health-pulse",
    name: "Hourly Health Pulse",
    description:
      "Monitor agent checks all active sessions, flags stalled runs, posts anomalies to main.",
    intervalMs: HOURLY_MS,
    participants: ["monitor", "main"],
    trigger: "cron",
    enabled: true,
    steps: [
      {
        id: "hhp-1",
        agentId: "monitor",
        messageType: "query",
        prompt:
          "Health pulse: check all active agent sessions via infinibot tools. " +
          "Report any sessions stalled > 30 minutes with [STALLED:<agentId>]. " +
          "Report total active sessions and any errors. Reply with a structured status block.",
      },
      {
        id: "hhp-2",
        agentId: "main",
        messageType: "alert",
        prompt:
          "Process the health pulse report. If any [STALLED] agents are found, " +
          "post an alert to Telegram. Otherwise, log the pulse silently.",
      },
    ],
  },
  {
    id: "new-content-trigger",
    name: "New Content Brief Chain",
    description:
      "Triggered when content-director signals a new brief. Routes cmo → scriptwriter → brand-designer.",
    intervalMs: 0,
    participants: ["cmo", "scriptwriter", "brand-designer"],
    trigger: "event",
    enabled: true,
    steps: [
      {
        id: "nct-1",
        agentId: "cmo",
        messageType: "task",
        prompt:
          "A new content brief has been signaled. Review the brief context provided and produce " +
          "a campaign strategy with target audience, key message, and 3 content angles.",
      },
      {
        id: "nct-2",
        agentId: "scriptwriter",
        messageType: "task",
        prompt:
          "Using the campaign strategy from the CMO, write a full-length script for the primary content piece. " +
          "Include hook, body, and CTA. Format as: HOOK: / BODY: / CTA:",
      },
      {
        id: "nct-3",
        agentId: "brand-designer",
        messageType: "task",
        prompt:
          "Using the script and strategy, produce a visual brief for the brand design team. " +
          "Include: color palette guidance, image style, text overlay suggestions, and format specs.",
      },
    ],
  },
];

// ── Engine ─────────────────────────────────────────────────────────────────

type EngineState = {
  workflows: OrgWorkflow[];
};

export class WorkflowEngine {
  private stateFile: string;
  private workflows: Map<string, OrgWorkflow> = new Map();
  private runs: Map<string, OrgWorkflowRun> = new Map();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // SSE listeners keyed by runId
  private sseListeners: Map<string, Set<(event: string) => void>> = new Map();

  constructor(stateDir: string = STATE_DIR) {
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch {
      // already exists
    }
    this.stateFile = join(stateDir, "workflow-engine.json");
    this._loadState();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  start(tickIntervalMs = 60_000): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this._tick(), tickIntervalMs);
    // Unref so the timer won't keep the process alive alone
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  getWorkflows(): OrgWorkflow[] {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id: string): OrgWorkflow | undefined {
    return this.workflows.get(id);
  }

  register(workflow: OrgWorkflow): void {
    // Built-in workflows are not overwritten if they already exist
    if (!this.workflows.has(workflow.id)) {
      this.workflows.set(workflow.id, { ...workflow });
      this._saveState();
    }
  }

  createWorkflow(params: Omit<OrgWorkflow, "id" | "lastRun" | "nextRun">): OrgWorkflow {
    const wf: OrgWorkflow = {
      ...params,
      id: randomUUID(),
    };
    this.workflows.set(wf.id, wf);
    this._saveState();
    return wf;
  }

  updateWorkflow(id: string, patch: Partial<OrgWorkflow>): OrgWorkflow | null {
    const existing = this.workflows.get(id);
    if (!existing) return null;
    const updated: OrgWorkflow = { ...existing, ...patch, id };
    this.workflows.set(id, updated);
    this._saveState();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): OrgWorkflow | null {
    return this.updateWorkflow(id, { enabled, seededDisabled: undefined });
  }

  getRun(runId: string): OrgWorkflowRun | undefined {
    return this.runs.get(runId);
  }

  getRuns(workflowId?: string): OrgWorkflowRun[] {
    const all = Array.from(this.runs.values());
    if (!workflowId) return all;
    return all.filter((r) => r.workflowId === workflowId);
  }

  /**
   * Trigger a workflow run immediately (bypasses the schedule).
   * Returns the new run record.
   */
  runNow(workflowId: string): OrgWorkflowRun | null {
    const wf = this.workflows.get(workflowId);
    if (!wf) return null;
    return this._executeWorkflow(wf);
  }

  /**
   * Subscribe to SSE-style events for a specific run.
   * Returns an unsubscribe function.
   */
  subscribeRunEvents(runId: string, listener: (event: string) => void): () => void {
    let set = this.sseListeners.get(runId);
    if (!set) {
      set = new Set();
      this.sseListeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const s = this.sseListeners.get(runId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.sseListeners.delete(runId);
      }
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _tick(): void {
    const now = Date.now();
    for (const wf of this.workflows.values()) {
      if (!wf.enabled || wf.trigger !== "cron" || wf.intervalMs <= 0) continue;
      const due = (wf.lastRun ?? 0) + wf.intervalMs;
      if (now >= due) {
        this._executeWorkflow(wf);
      }
    }
  }

  private _executeWorkflow(wf: OrgWorkflow): OrgWorkflowRun {
    const run: OrgWorkflowRun = {
      runId: randomUUID(),
      workflowId: wf.id,
      startedAt: Date.now(),
      status: "running",
      steps: wf.steps.map((s) => ({
        stepId: s.id,
        agentId: s.agentId,
        prompt: s.prompt,
        status: "pending",
      })),
    };
    this.runs.set(run.runId, run);
    this._emitRunEvent(run.runId, { type: "run:started", runId: run.runId, workflowId: wf.id });

    // Update workflow lastRun + nextRun
    const updated: OrgWorkflow = {
      ...wf,
      lastRun: run.startedAt,
      nextRun: wf.intervalMs > 0 ? run.startedAt + wf.intervalMs : undefined,
    };
    this.workflows.set(wf.id, updated);
    this._saveState();

    // Execute steps sequentially via AgentBus
    this._runNextStep(run.runId, 0);

    return run;
  }

  private _runNextStep(runId: string, stepIndex: number): void {
    const run = this.runs.get(runId);
    if (!run) return;

    if (stepIndex >= run.steps.length) {
      run.status = "completed";
      run.completedAt = Date.now();
      this._emitRunEvent(runId, { type: "run:completed", runId });
      return;
    }

    const step = run.steps[stepIndex];
    if (!step) return;

    step.status = "running";
    step.startedAt = Date.now();
    this._emitRunEvent(runId, { type: "step:started", runId, stepId: step.stepId });

    const bus = getAgentBus();
    const wf = this.workflows.get(run.workflowId);

    // Find the previous agent for review routing
    const fromAgentId = stepIndex > 0 ? (run.steps[stepIndex - 1]?.agentId ?? "main") : "main";
    const stepDef = wf?.steps[stepIndex];
    const messageType = stepDef?.messageType ?? "task";

    bus.send(fromAgentId, step.agentId, step.prompt, {
      type: messageType,
      correlationId: runId,
      workflowId: run.workflowId,
      stepId: step.stepId,
    });

    step.status = "awaiting_agent";
    this._emitRunEvent(runId, {
      type: "step:awaiting_agent",
      runId,
      stepId: step.stepId,
      agentId: step.agentId,
    });

    // Subscribe to responses from this agent so we can advance the chain
    const unsub = bus.subscribe(fromAgentId, (msg) => {
      if (msg.correlationId !== runId) return;
      unsub();
      const result = msg.payload;
      step.result = result;
      step.completedAt = Date.now();

      // Recursive review: if the result contains [NEEDS_REVIEW], route back
      if (result.includes("[NEEDS_REVIEW]") && stepIndex > 0) {
        step.status = "needs_review";
        this._emitRunEvent(runId, { type: "step:needs_review", runId, stepId: step.stepId });
        this._runNextStep(runId, stepIndex - 1);
      } else {
        step.status = "completed";
        this._emitRunEvent(runId, { type: "step:completed", runId, stepId: step.stepId, result });
        this._runNextStep(runId, stepIndex + 1);
      }
    });

    // Advance automatically after a timeout to keep the chain moving
    // even if the target agent is not currently active (60 s)
    setTimeout(() => {
      if (step.status === "awaiting_agent") {
        unsub();
        step.status = "completed";
        step.completedAt = Date.now();
        step.result = "(timeout — agent not active)";
        this._emitRunEvent(runId, {
          type: "step:completed",
          runId,
          stepId: step.stepId,
          result: step.result,
        });
        this._runNextStep(runId, stepIndex + 1);
      }
    }, 60_000);
  }

  private _emitRunEvent(runId: string, payload: Record<string, unknown>): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    const listeners = this.sseListeners.get(runId);
    if (listeners) {
      for (const fn of listeners) {
        try {
          fn(line);
        } catch {
          // ignore broken SSE connections
        }
      }
    }
  }

  private _loadState(): void {
    // Built-in workflows are multi-agent model runs on a timer, so they follow
    // the autonomy opt-in (src/cron/autonomy-optin.ts): on a fresh install
    // (no persisted state yet) they register disabled until the operator opts
    // in. An install with persisted state keeps its workflows exactly as saved.
    const optIn = resolveExplicitAutonomy();
    const seedEnabled = optIn ?? existsSync(this.stateFile);
    // Register all built-ins first (skipped if already in persisted state)
    for (const wf of BUILT_IN_WORKFLOWS) {
      const gated = wf.enabled && !seedEnabled;
      this.workflows.set(wf.id, {
        ...wf,
        enabled: wf.enabled && seedEnabled,
        ...(gated ? { seededDisabled: true } : {}),
      });
    }

    try {
      const raw = readFileSync(this.stateFile, "utf8");
      const state = JSON.parse(raw) as EngineState;
      if (Array.isArray(state.workflows)) {
        for (const wf of state.workflows) {
          if (typeof wf.id === "string") {
            const loaded = wf as OrgWorkflow;
            // Opting in later enables only what the gate turned off.
            if (optIn === true && loaded.seededDisabled) {
              loaded.enabled = true;
              delete loaded.seededDisabled;
            }
            this.workflows.set(wf.id, loaded);
          }
        }
      }
    } catch {
      // File may not exist on first run — that's fine
    }
  }

  private _saveState(): void {
    try {
      const state: EngineState = {
        workflows: Array.from(this.workflows.values()),
      };
      writeFileSync(this.stateFile, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // best-effort
    }
  }
}

// Process-scoped singleton
let _engineInstance: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!_engineInstance) {
    _engineInstance = new WorkflowEngine();
  }
  return _engineInstance;
}

export function startWorkflowEngine(): WorkflowEngine {
  const engine = getWorkflowEngine();
  engine.start();
  return engine;
}
