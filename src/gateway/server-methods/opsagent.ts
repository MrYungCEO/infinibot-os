/**
 * Gateway RPC handlers for the KIS Phase 1 **operations agents** (§19–§21).
 *
 * Thin, read-only wrappers over the pure agent cores in src/agents/ops-agents.
 * Each returns structured JSON the §15/§18 command-center dashboards render;
 * pass `{ render: true }` to also produce a black-gold PDF via the canonical
 * report system (optionally persisted to `savePath`).
 *
 *   opsagent.ceoBriefing    §19 Daily CEO Briefing
 *   opsagent.monitor        §20 Operations Monitor (exception report)
 *   opsagent.projectHealth  §21 Project Health (Green/Yellow/Red + why)
 *
 * Authority L1 — observe & recommend only; never mutate a store (§24, §32).
 */

import type { GatewayRequestHandlers } from "./types.js";
import {
  runCeoBriefing,
  runOperationsMonitor,
  runProjectHealth,
  ceoBriefingReport,
  exceptionReportPdf,
  projectHealthReport,
} from "../../agents/ops-agents/index.js";
import { renderReport } from "../../reports/render.js";
import type { ReportPayload } from "../../reports/types.js";

interface OpsAgentParams {
  /** Also render a black-gold PDF and return its size/path. */
  render?: boolean;
  /** Absolute path to persist the PDF (kept after return). */
  savePath?: string;
  /** Optional evaluation clock override (Unix ms) — mainly for testing. */
  now?: number;
}

/** Render `payload` to a PDF and attach { pdf: { filePath?, bytes } } to data. */
async function withPdf(
  data: Record<string, unknown>,
  payload: ReportPayload,
  p: OpsAgentParams,
): Promise<Record<string, unknown>> {
  if (!p.render) return data;
  const buf = await renderReport(payload, p.savePath ? { savePath: p.savePath } : {});
  return { ...data, pdf: { filePath: p.savePath, bytes: buf.length } };
}

export const opsAgentHandlers: GatewayRequestHandlers = {
  "opsagent.ceoBriefing": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as OpsAgentParams;
      const briefing = await runCeoBriefing({ now: p.now });
      const data = await withPdf({ briefing }, ceoBriefingReport(briefing), p);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opsagent.monitor": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as OpsAgentParams;
      const report = await runOperationsMonitor({ now: p.now });
      const data = await withPdf({ report }, exceptionReportPdf(report), p);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "opsagent.projectHealth": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as OpsAgentParams;
      const report = await runProjectHealth({ now: p.now });
      const data = await withPdf({ report }, projectHealthReport(report), p);
      respond(true, data);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default opsAgentHandlers;
