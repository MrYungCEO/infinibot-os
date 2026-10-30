/**
 * Workflow gateway handlers — CRUD + run + preflight for markdown workflows.
 *
 * Beyond plain CRUD, this exposes the run pipeline:
 *   workflows.run.preflight  — validate inputs + check requirements (no spawn)
 *   workflows.run.start      — preflight + spawn agent session
 *   workflows.run.list       — recent runs (optionally filtered by workflow)
 *   workflows.run.get        — full record for a single runId
 *   workflows.run.cancel     — cancel a pending/running run
 */

import { WorkflowStore } from "../../workflows/store.js";
import {
  WorkflowRunStore,
  cancelRun,
  preflightWorkflow,
  runWorkflow,
} from "../../workflows/runner.js";
import {
  startContinuousWorkflow,
  stopContinuousRun,
  pauseContinuousRun,
  resumeContinuousRun,
  listDaemons,
  reconcileStaleContinuousRuns,
} from "../../workflows/continuous-runner.js";
import type {
  ContinuousConfig,
  WorkflowCreateParams,
  WorkflowSearchParams,
  WorkflowUpdateParams,
} from "../../workflows/types.js";
import { initReleasePublisher } from "../../release/publisher.js";
import { ensureVisualQaWorkflow } from "../../workflows/visual-qa/visual-qa.js";
import {
  parseWorkflowUpload,
  slugifyWorkflowName,
  WorkflowImportError,
  WORKFLOW_UPLOAD_MAX_BYTES,
} from "../../workflows/import.js";
import type { GatewayRequestHandlers } from "./types.js";

const getStateDir = () => process.env.INFINIBOT_STATE_DIR ?? "state";
const getStore = () => new WorkflowStore(getStateDir());
const getRunStore = () => new WorkflowRunStore(getStateDir());

// Flip any continuous runs that were left "running" or "paused" in the run
// store when the previous gateway process exited, and register built-in
// continuous workflows (e.g. release-publisher) + their native ticks. Runs
// once per process. Registering the native tick here guarantees it's wired
// before any `workflows.continuous.start` can spawn an iteration.
let reconcileDone = false;
function reconcileOnce(): void {
  if (reconcileDone) return;
  reconcileDone = true;
  try {
    reconcileStaleContinuousRuns(getStateDir());
  } catch {
    /* best-effort — don't block the handler */
  }
  try {
    initReleasePublisher(getStateDir());
  } catch {
    /* best-effort — built-in workflow registration must never block handlers */
  }
  try {
    ensureVisualQaWorkflow(getStateDir());
  } catch {
    /* best-effort — built-in workflow registration must never block handlers */
  }
}

export const workflowHandlers: GatewayRequestHandlers = {
  "workflows.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Partial<WorkflowSearchParams>;
      const items = getStore().list(p);
      respond(true, { workflows: items, count: items.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.get": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const wf = getStore().get(id);
      if (!wf) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Workflow "${id}" not found` });
        return;
      }
      respond(true, wf);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkflowCreateParams;
      if (!p.name || typeof p.body !== "string") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and body are required",
        });
        return;
      }
      const wf = getStore().create(p);
      respond(true, wf);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.import": async ({ params, respond }) => {
    const fail = (message: string) =>
      respond(false, undefined, { code: "INVALID_REQUEST", message });
    try {
      const p = (params ?? {}) as {
        fileName?: string;
        dataBase64?: string;
        onConflict?: "ask" | "replace" | "keep-both";
      };
      if (typeof p.dataBase64 !== "string" || !p.dataBase64) return fail("No file was received.");
      if (p.dataBase64.length > Math.ceil((WORKFLOW_UPLOAD_MAX_BYTES * 4) / 3) + 8) {
        return fail(
          `That file is over the ${Math.round(WORKFLOW_UPLOAD_MAX_BYTES / 1024 / 1024)} MB workflow upload limit.`,
        );
      }
      const parsed = parseWorkflowUpload(
        String(p.fileName ?? "workflow").slice(0, 200),
        Buffer.from(p.dataBase64, "base64"),
      );
      const store = getStore();
      const baseId = parsed.params.id || slugifyWorkflowName(parsed.params.name);
      if (!baseId)
        return fail("That workflow's name has no letters or numbers, so it can't be saved.");
      const existing = store.get(baseId);
      const mode = p.onConflict ?? "ask";
      if (existing && mode === "ask") {
        respond(true, {
          ok: false,
          status: "conflict",
          conflict: { id: baseId, name: existing.name },
          message: `You already have a workflow named "${existing.name}". Replace it or keep both?`,
        });
        return;
      }
      let wf;
      let replaced = false;
      if (existing && mode === "replace") {
        wf = store.update({
          id: baseId,
          name: parsed.params.name,
          description: parsed.params.description ?? "",
          tags: parsed.params.tags,
          body: parsed.params.body,
          kind: parsed.params.kind,
          inputs: parsed.params.inputs,
          requires: parsed.params.requires,
          agent: parsed.params.agent,
          model: parsed.params.model,
          timeoutSeconds: parsed.params.timeoutSeconds,
        });
        replaced = true;
      } else {
        let id = baseId;
        let name = parsed.params.name;
        if (existing) {
          for (let i = 2; i < 1000; i++) {
            if (!store.get(`${baseId}-${i}`)) {
              id = `${baseId}-${i}`;
              name = `${parsed.params.name} (${i})`;
              break;
            }
          }
        }
        wf = store.create({ ...parsed.params, id, name });
      }
      respond(true, {
        ok: true,
        status: "imported",
        format: parsed.format,
        replaced,
        workflow: wf,
      });
    } catch (e) {
      if (e instanceof WorkflowImportError) return fail(e.message);
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: "Something went wrong saving that workflow. Nothing was changed.",
      });
    }
  },

  "workflows.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as WorkflowUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const wf = getStore().update(p);
      if (!wf) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Workflow "${p.id}" not found` });
        return;
      }
      respond(true, wf);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.delete": async ({ params, respond }) => {
    try {
      const { id } = params as { id: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const deleted = getStore().delete(id);
      if (!deleted) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Workflow "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Run pipeline ──────────────────────────────────────────

  "workflows.run.preflight": async ({ params, respond }) => {
    try {
      const p = params as { id?: string; inputs?: Record<string, unknown> };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const wf = getStore().get(p.id);
      if (!wf) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Workflow "${p.id}" not found`,
        });
        return;
      }
      const result = await preflightWorkflow(wf, { inputs: p.inputs });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.run.start": async ({ params, respond }) => {
    try {
      const p = params as {
        id?: string;
        inputs?: Record<string, unknown>;
        agentId?: string;
        model?: string;
        timeoutSeconds?: number;
        executionMode?: "gateway" | "terminal";
        cli?: "claude" | "opencode" | "gemini" | "codex" | "grok";
        cwd?: string;
      };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const result = await runWorkflow({
        stateDir: getStateDir(),
        workflowId: p.id,
        opts: {
          inputs: p.inputs,
          agentId: p.agentId,
          model: p.model,
          timeoutSeconds: p.timeoutSeconds,
          executionMode: p.executionMode,
          cli: p.cli,
          cwd: p.cwd,
        },
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.run.list": async ({ params, respond }) => {
    reconcileOnce();
    try {
      const p = (params ?? {}) as { workflowId?: string; limit?: number };
      const runs = getRunStore().list({
        workflowId: p.workflowId,
        limit: typeof p.limit === "number" ? p.limit : 50,
      });
      respond(true, { runs, count: runs.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.run.get": async ({ params, respond }) => {
    try {
      const { runId } = params as { runId: string };
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      const run = getRunStore().get(runId);
      if (!run) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Run "${runId}" not found` });
        return;
      }
      respond(true, run);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.run.cancel": async ({ params, respond }) => {
    try {
      const { runId } = params as { runId: string };
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      // For continuous runs, route the cancel to the daemon stop. Static
      // runs use the legacy cancelRun path.
      const stopped = stopContinuousRun(runId, "user", "manual");
      if (stopped) {
        const run = getRunStore().get(runId);
        respond(true, run);
        return;
      }
      const run = cancelRun(getStateDir(), runId);
      if (!run) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Run "${runId}" not found` });
        return;
      }
      respond(true, run);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Continuous / autonomous-control runs ──────────────────

  "workflows.continuous.start": async ({ params, respond }) => {
    try {
      const p = params as {
        id?: string;
        inputs?: Record<string, unknown>;
        agentId?: string;
        model?: string;
        continuous?: Partial<ContinuousConfig>;
        executionMode?: "gateway" | "terminal";
        cli?: "claude" | "opencode" | "gemini" | "codex" | "grok";
        cwd?: string;
      };
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const result = await startContinuousWorkflow({
        stateDir: getStateDir(),
        workflowId: p.id,
        opts: {
          inputs: p.inputs,
          agentId: p.agentId,
          model: p.model,
          continuous: p.continuous,
          executionMode: p.executionMode,
          cli: p.cli,
          cwd: p.cwd,
        },
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.continuous.stop": async ({ params, respond }) => {
    try {
      const { runId, requestedBy } = params as { runId?: string; requestedBy?: string };
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      const ok = stopContinuousRun(runId, requestedBy ?? "user", "manual");
      const run = getRunStore().get(runId);
      respond(true, { stopped: ok, run });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.continuous.pause": async ({ params, respond }) => {
    try {
      const { runId, requestedBy } = params as { runId?: string; requestedBy?: string };
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      const ok = pauseContinuousRun(runId, requestedBy ?? "user");
      respond(true, { paused: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.continuous.resume": async ({ params, respond }) => {
    try {
      const { runId, requestedBy } = params as { runId?: string; requestedBy?: string };
      if (!runId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "runId is required" });
        return;
      }
      const ok = resumeContinuousRun(runId, requestedBy ?? "user");
      respond(true, { resumed: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "workflows.continuous.list": async ({ respond }) => {
    reconcileOnce();
    try {
      const daemons = listDaemons();
      respond(true, { daemons, count: daemons.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};
