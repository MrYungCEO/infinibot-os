/**
 * REST endpoints for the Report System.
 *
 * GET  /api/reports?department=xxx&excludeKind=gateway_recovery&kind=xxx&status=xxx&limit=50&offset=0
 *   → { reports[], total }
 *
 * POST /api/reports/proactive
 *   Body: ProactiveReportInput JSON
 *   → { reportId, filePath }
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getReportsStore } from "../reports/store.js";
import { buildProactiveReport } from "../reports/proactive-builder.js";
import type { ReportStatus } from "../reports/types.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function toWire(r: ReturnType<ReturnType<typeof getReportsStore>["getReport"]>) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    theme: r.theme,
    status: r.status,
    trigger: r.trigger,
    createdAt: r.createdAt,
    renderedAt: r.renderedAt,
    filePath: r.filePath,
    fileSize: r.fileSize,
    summaryText: r.summaryText,
    category: r.category,
    sourceAgent: r.sourceAgent,
    department: r.department ?? null,
    tags: r.tags ?? [],
  };
}

/** Read the full body as UTF-8 text, resolving once complete. */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function handleReportsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── POST /api/reports/proactive ──────────────────────────────────────────────
  if (url.pathname === "/api/reports/proactive") {
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return true;
    }
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw);
      if (!input?.kind || !input?.title || !input?.agentId || !Array.isArray(input?.sections)) {
        sendJson(res, 400, { error: "Missing required fields: kind, title, agentId, sections" });
        return true;
      }
      const result = await buildProactiveReport(input);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: String(e) });
    }
    return true;
  }

  // ── GET /api/reports ─────────────────────────────────────────────────────────
  if (url.pathname !== "/api/reports") return false;
  if (req.method !== "GET" && req.method !== "OPTIONS") return false;

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.end();
    return true;
  }

  try {
    const p = url.searchParams;
    const { reports, total } = getReportsStore().listReports({
      kind: p.get("kind") ?? undefined,
      status: (p.get("status") as ReportStatus) ?? undefined,
      category: p.get("category") ?? undefined,
      department: p.get("department") ?? undefined,
      excludeKind: p.get("excludeKind") ?? undefined,
      limit: p.has("limit") ? Number(p.get("limit")) : 100,
      offset: p.has("offset") ? Number(p.get("offset")) : 0,
    });
    sendJson(res, 200, { reports: reports.map(toWire), total });
  } catch (e) {
    sendJson(res, 500, { error: String(e) });
  }
  return true;
}
