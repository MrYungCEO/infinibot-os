/**
 * Gateway RPC handlers for the proactive WorkflowEngine.
 *
 * Method namespace: `workflow_engine.*`
 *
 *   workflow_engine.list           — list all org workflows
 *   workflow_engine.get            — get a single workflow by id
 *   workflow_engine.create         — create a custom workflow
 *   workflow_engine.update         — patch a workflow (name, intervalMs, enabled, …)
 *   workflow_engine.toggle         — shorthand enable/disable
 *   workflow_engine.run            — trigger a manual run immediately
 *   workflow_engine.run.get        — get a run record by runId
 *   workflow_engine.run.list       — list recent runs (optionally filtered by workflowId)
 */

import {
  getWorkflowEngine,
  type OrgWorkflow,
  type OrgWorkflowStepDef,
} from "../workflow-engine.js";
import type { GatewayRequestHandlers } from "./types.js";

export const workflowEngineHandlers: GatewayRequestHandlers = {
  "workflow_engine.list": async ({ respond }) => {
    const engine = getWorkflowEngine();
    respond(true, { workflows: engine.getWorkflows() });
  },

  "workflow_engine.get": async ({ params, respond }) => {
    const p = params as { id?: string };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const wf = getWorkflowEngine().getWorkflow(id);
    if (!wf) {
      respond(false, undefined, { code: "NOT_FOUND", message: `workflow not found: ${id}` });
      return;
    }
    respond(true, { workflow: wf });
  },

  "workflow_engine.create": async ({ params, respond }) => {
    const p = params as {
      name?: string;
      description?: string;
      intervalMs?: number;
      participants?: string[];
      trigger?: string;
      enabled?: boolean;
      steps?: Array<{ agentId?: string; prompt?: string; messageType?: string }>;
    };

    if (typeof p.name !== "string" || !p.name.trim()) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "name is required" });
      return;
    }
    if (!Array.isArray(p.steps) || p.steps.length === 0) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "steps array is required" });
      return;
    }

    const steps: OrgWorkflowStepDef[] = p.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      agentId: typeof s.agentId === "string" ? s.agentId.trim() : "main",
      prompt: typeof s.prompt === "string" ? s.prompt.trim() : "",
      messageType: s.messageType as OrgWorkflowStepDef["messageType"],
    }));

    const wf = getWorkflowEngine().createWorkflow({
      name: p.name.trim(),
      description: typeof p.description === "string" ? p.description.trim() : undefined,
      intervalMs: typeof p.intervalMs === "number" ? p.intervalMs : 0,
      participants: Array.isArray(p.participants)
        ? (p.participants as string[])
        : steps.map((s) => s.agentId),
      trigger: p.trigger === "event" ? "event" : "cron",
      enabled: p.enabled !== false,
      steps,
    });

    respond(true, { workflow: wf });
  },

  "workflow_engine.update": async ({ params, respond }) => {
    const p = params as { id?: string } & Partial<OrgWorkflow>;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const { id: _drop, ...patch } = p;
    const updated = getWorkflowEngine().updateWorkflow(id, patch as Partial<OrgWorkflow>);
    if (!updated) {
      respond(false, undefined, { code: "NOT_FOUND", message: `workflow not found: ${id}` });
      return;
    }
    respond(true, { workflow: updated });
  },

  "workflow_engine.toggle": async ({ params, respond }) => {
    const p = params as { id?: string; enabled?: boolean };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const enabled = p.enabled !== false;
    const updated = getWorkflowEngine().setEnabled(id, enabled);
    if (!updated) {
      respond(false, undefined, { code: "NOT_FOUND", message: `workflow not found: ${id}` });
      return;
    }
    respond(true, { workflow: updated, enabled });
  },

  "workflow_engine.run": async ({ params, respond }) => {
    const p = params as { id?: string };
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
      return;
    }
    const run = getWorkflowEngine().runNow(id);
    if (!run) {
      respond(false, undefined, { code: "NOT_FOUND", message: `workflow not found: ${id}` });
      return;
    }
    respond(true, { run });
  },

  "workflow_engine.run.get": async ({ params, respond }) => {
    const p = params as { runId?: string };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
      return;
    }
    const run = getWorkflowEngine().getRun(runId);
    if (!run) {
      respond(false, undefined, { code: "NOT_FOUND", message: `run not found: ${runId}` });
      return;
    }
    respond(true, { run });
  },

  "workflow_engine.run.list": async ({ params, respond }) => {
    const p = params as { workflowId?: string };
    const workflowId =
      typeof p.workflowId === "string" && p.workflowId.trim() ? p.workflowId.trim() : undefined;
    const runs = getWorkflowEngine().getRuns(workflowId);
    respond(true, { runs });
  },
};
