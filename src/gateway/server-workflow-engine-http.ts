/**
 * HTTP handler for the WorkflowEngine REST API.
 *
 *   GET    /api/workflow-engine             — list all org workflows
 *   POST   /api/workflow-engine             — create a custom workflow
 *   PATCH  /api/workflow-engine/:id         — update / toggle a workflow
 *   POST   /api/workflow-engine/:id/run     — trigger manual run
 *   GET    /api/workflow-engine/:id/stream  — SSE stream (runId query param)
 *
 * Auth: gateway credential via the central HTTP gate (http-auth.ts). No loopback trust.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getWorkflowEngine } from "./workflow-engine.js";
import { sendJson, sendMethodNotAllowed, readJsonBodyOrError } from "./http-common.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeHandlerRequest } from "./http-auth.js";

const BASE_PATH = "/api/workflow-engine";

type WorkflowEngineAuthOpts = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  preAuthorized?: boolean;
};

async function authorize(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkflowEngineAuthOpts,
): Promise<boolean> {
  return authorizeHandlerRequest(req, res, opts);
}

export async function handleWorkflowEngineRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WorkflowEngineAuthOpts,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  if (!pathname.startsWith(BASE_PATH)) return false;

  const subPath = pathname.slice(BASE_PATH.length);
  const engine = getWorkflowEngine();

  // GET / POST /api/workflow-engine
  if (subPath === "" || subPath === "/") {
    if (req.method === "GET") {
      if (!(await authorize(req, res, opts))) return true;
      sendJson(res, 200, { workflows: engine.getWorkflows() });
      return true;
    }
    if (req.method === "POST") {
      if (!(await authorize(req, res, opts))) return true;
      const body = await readJsonBodyOrError(req, res, 256 * 1024);
      if (body === undefined) return true;
      const p = (body ?? {}) as Record<string, unknown>;
      if (typeof p.name !== "string" || !p.name.trim()) {
        sendJson(res, 400, { error: "name is required" });
        return true;
      }
      if (!Array.isArray(p.steps) || (p.steps as unknown[]).length === 0) {
        sendJson(res, 400, { error: "steps array is required" });
        return true;
      }
      const wf = engine.createWorkflow({
        name: p.name.trim(),
        description: typeof p.description === "string" ? p.description : undefined,
        intervalMs: typeof p.intervalMs === "number" ? p.intervalMs : 0,
        participants: Array.isArray(p.participants) ? (p.participants as string[]) : [],
        trigger: p.trigger === "event" ? "event" : "cron",
        enabled: p.enabled !== false,
        steps: (p.steps as Array<Record<string, unknown>>).map((s, i) => ({
          id: typeof s.id === "string" ? s.id : `step-${i + 1}`,
          agentId: typeof s.agentId === "string" ? s.agentId : "main",
          prompt: typeof s.prompt === "string" ? s.prompt : "",
        })),
      });
      sendJson(res, 201, { workflow: wf });
      return true;
    }
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }

  // /api/workflow-engine/<id>[/action]
  const parts = subPath.replace(/^\//, "").split("/");
  const id = parts[0] ?? "";
  const action = parts[1] ?? "";

  if (!id) {
    sendJson(res, 404, { error: "Not Found" });
    return true;
  }

  // GET /api/workflow-engine/:id/stream?runId=...
  if (action === "stream") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    if (!(await authorize(req, res, opts))) return true;
    const runId = url.searchParams.get("runId") ?? "";
    if (!runId) {
      sendJson(res, 400, { error: "runId query param is required" });
      return true;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.statusCode = 200;
    res.write(`: connected run=${runId}\n\n`);
    const unsub = engine.subscribeRunEvents(runId, (line) => {
      if (!res.writableEnded) res.write(line);
    });
    req.once("close", () => unsub());
    return true;
  }

  // POST /api/workflow-engine/:id/run
  if (action === "run") {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    if (!(await authorize(req, res, opts))) return true;
    const run = engine.runNow(id);
    if (!run) {
      sendJson(res, 404, { error: `workflow not found: ${id}` });
      return true;
    }
    sendJson(res, 202, { run });
    return true;
  }

  // GET or PATCH /api/workflow-engine/:id
  if (action === "") {
    if (req.method === "GET") {
      if (!(await authorize(req, res, opts))) return true;
      const wf = engine.getWorkflow(id);
      if (!wf) {
        sendJson(res, 404, { error: `workflow not found: ${id}` });
        return true;
      }
      sendJson(res, 200, { workflow: wf });
      return true;
    }
    if (req.method === "PATCH") {
      if (!(await authorize(req, res, opts))) return true;
      const body = await readJsonBodyOrError(req, res, 256 * 1024);
      if (body === undefined) return true;
      const patch = (body ?? {}) as Record<string, unknown>;
      const updated = engine.updateWorkflow(id, patch);
      if (!updated) {
        sendJson(res, 404, { error: `workflow not found: ${id}` });
        return true;
      }
      sendJson(res, 200, { workflow: updated });
      return true;
    }
    sendMethodNotAllowed(res, "GET, PATCH");
    return true;
  }

  sendJson(res, 404, { error: "Not Found" });
  return true;
}
