/**
 * Report System gateway methods — handles all `reports.*` RPC calls.
 *
 * The gateway only ever reads/writes the SQLite store and enqueues `queued`
 * rows; the separate worker process renders them (see src/reports/worker). This
 * keeps the gateway off the puppeteer path entirely.
 *
 * RPC contract (the CEO-insights agent and UI build against this — do not
 * deviate):
 *   reports.list      ({ kind?, status?, limit?, offset? }) -> { reports[], total }
 *   reports.get       ({ id })                              -> full record
 *   reports.preview   ({ id, base64? })                     -> { filePath, mimeType, base64? }
 *   reports.generate  ({ kind, theme?, config?, sinks? })   -> { id, status }
 *   reports.render    ({ payload, register?, base64? })     -> { filePath, bytes, id?, base64? }
 *   reports.sendToTelegram ({ payload, caption?, chatId?, kind? }) -> { ok, messageId, filePath, id? }
 *   reports.resend    ({ id, sinks })                       -> { ok, results }
 *   reports.delete    ({ id })                              -> { ok }
 *   reports.context   ({ category?, sourceAgent?, since?, limit?, maxChars? })
 *                                                           -> { context, reports[], omitted, totalChars }
 *   reports.schedules.{list,upsert,delete}
 *   reports.triggers.{list,upsert,delete}
 *   reports.insights.list ({ since?, kind?, limit? })       -> read-only
 *
 * Associations (report <-> client / opportunity / project, stored as typed
 * edges in the objrel layer — see src/reports/associations.ts):
 *   reports.link         ({ reportId, targetType, targetId })  -> { association }
 *   reports.unlink       ({ relationId } | { reportId, targetType?, targetId? })
 *                                                              -> { deleted }
 *   reports.forObject    ({ type, id, limit? })                -> { reports[], associations[] }
 *   reports.associations ({ reportId })                        -> { associations[] }
 *
 * `reports.render`, `reports.sendToTelegram` and `reports.generate` also accept
 * optional `{ clientId?, opportunityId?, projectId? }` and auto-link the report
 * they create, so an agent associates in the same call that produces the PDF.
 */

import { readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { getReportsStore } from "../../reports/store.js";
import { enqueueReport } from "../../reports/trigger.js";
import { fanOut } from "../../reports/sinks/index.js";
import { listKinds } from "../../reports/kinds/index.js";
import { listThemes } from "../../reports/themes/index.js";
import { renderReport, sendReportToTelegram } from "../../reports/render.js";
import { ingestExternalPdf } from "../../reports/helpers/external-pdf.js";
import { getReportContext } from "../../reports/helpers/report-context.js";
import { toReportWire } from "../../reports/helpers/wire.js";
import {
  associationsForReport,
  autoLinkReport,
  linkReport,
  readAssociationTargets,
  reportsForObject,
  unlinkReport,
  REPORT_TARGET_TYPES,
} from "../../reports/associations.js";
import { REPORT_CATEGORIES } from "../../reports/helpers/categorize.js";
import { emitMediaArtifact, artifactHash } from "../../proactive/media-artifacts.js";
import type { ReportPayload, ReportSink, ReportStatus } from "../../reports/types.js";

/** Shape a record for the wire (the contract's list/get fields). */
function toWire(r: ReturnType<ReturnType<typeof getReportsStore>["getReport"]>) {
  // Delegates to the shared mapper so `reports.list` / `reports.get` and the
  // association reads (`reports.forObject`) return byte-identical report shapes.
  return toReportWire(r);
}

function err(respond: (ok: boolean, p?: unknown, e?: { code: string; message: string }) => void) {
  return (code: string, message: string) => respond(false, undefined, { code, message });
}

export const reportsHandlers: GatewayRequestHandlers = {
  "reports.list": ({ respond, params }) => {
    try {
      const store = getReportsStore();
      const { reports, total } = store.listReports({
        kind: params?.kind as string | undefined,
        status: params?.status as ReportStatus | undefined,
        category: params?.category as string | undefined,
        limit: params?.limit as number | undefined,
        offset: params?.offset as number | undefined,
      });
      respond(true, { reports: reports.map(toWire), total });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.get": ({ respond, params }) => {
    try {
      const id = params?.id as string;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      const rec = getReportsStore().getReport(id);
      if (!rec) return err(respond)("NOT_FOUND", `report ${id} not found`);
      // Full record including config_json (the get contract).
      respond(true, { report: rec });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.preview": ({ respond, params }) => {
    try {
      const id = params?.id as string;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      const rec = getReportsStore().getReport(id);
      if (!rec) return err(respond)("NOT_FOUND", `report ${id} not found`);
      if (!rec.filePath) return err(respond)("NOT_READY", `report ${id} has no rendered file`);
      try {
        statSync(rec.filePath);
      } catch {
        return err(respond)("FILE_MISSING", `rendered file missing at ${rec.filePath}`);
      }
      const out: Record<string, unknown> = {
        filePath: rec.filePath,
        mimeType: "application/pdf",
      };
      if (params?.base64 === true) {
        out.base64 = readFileSync(rec.filePath).toString("base64");
      }
      respond(true, out);
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.generate": ({ respond, params }) => {
    try {
      const kind = params?.kind as string;
      if (!kind) return err(respond)("INVALID_PARAMS", "Missing kind");
      if (!listKinds().includes(kind)) {
        return err(respond)("UNKNOWN_KIND", `unknown report kind: ${kind}`);
      }
      const rec = enqueueReport({
        kind,
        theme: params?.theme as string | undefined,
        trigger: "manual",
        sinks: params?.sinks as ReportSink[] | undefined,
        config: (params?.config as Record<string, unknown>) ?? {},
      });
      // Associate up-front: the row exists as soon as it is queued, so the
      // link is in place before the worker finishes rendering the PDF.
      const { linked, errors } = autoLinkReport(
        rec.id,
        readAssociationTargets(params as Record<string, unknown>),
        "reports",
      );
      respond(true, {
        id: rec.id,
        status: rec.status,
        ...(linked.length ? { associations: linked } : {}),
        ...(errors.length ? { associationErrors: errors } : {}),
      });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── generic structured render (the canonical PDF path) ──────────────
  // Builds a PDF from a ReportPayload via the black-gold template. Unlike
  // `reports.generate` (kind-based, async via the worker) this renders inline
  // and synchronously returns the bytes. puppeteer-core is lazily imported by
  // the renderer and the browser is always closed in a finally, so a render
  // crash stays contained in a child Chrome process, never the gateway.
  "reports.render": async ({ respond, params }) => {
    try {
      const payload = params?.payload as ReportPayload | undefined;
      if (!payload || typeof payload.title !== "string" || !Array.isArray(payload.sections)) {
        return err(respond)("INVALID_PARAMS", "payload {title, sections[]} required");
      }
      const scratch = join(tmpdir(), `reports-render-${process.pid}-${Date.now()}.pdf`);
      const buf = await renderReport(payload, { savePath: scratch });

      const out: Record<string, unknown> = { filePath: scratch, bytes: buf.length };

      // Register as a first-class report row by default so it shows in /reports.
      if (params?.register !== false) {
        try {
          const rec = ingestExternalPdf({
            path: scratch,
            kind: (params?.kind as string) ?? "manual_render",
            title: payload.title,
            theme: payload.theme ?? "black-gold",
            summaryText: payload.subtitle ?? undefined,
            category: (params?.category as string | undefined) ?? null,
            sourceAgent: (params?.sourceAgent as string | undefined) ?? null,
            sourceSession: (params?.sourceSession as string | undefined) ?? null,
            payload,
          });
          out.id = rec.id;
          out.filePath = rec.filePath ?? scratch;
        } catch {
          /* ingestion is best-effort; the rendered file still returns */
        }
      }

      // Auto-associate with the client / opportunity / project this report is
      // about, when the caller named one. Best-effort: the PDF is already
      // rendered, so a link failure is reported, never thrown.
      if (out.id) {
        const { linked, errors } = autoLinkReport(
          out.id as string,
          readAssociationTargets(params as Record<string, unknown>),
          (params?.sourceAgent as string | undefined) || "reports",
        );
        if (linked.length) out.associations = linked;
        if (errors.length) out.associationErrors = errors;
      }

      if (params?.base64 === true) out.base64 = buf.toString("base64");

      // Mandatory media visualization: the rendered PDF MUST appear on screen.
      emitMediaArtifact({
        agentId: (params?.sourceAgent as string | undefined) || "reports",
        agentName: "Reports",
        title: payload.title,
        body: payload.subtitle ?? "Report rendered",
        dedupKey: `pdf:render:${out.id ?? artifactHash(String(out.filePath))}`,
        media: {
          kind: "pdf",
          payload: {
            title: payload.title,
            reportId: out.id as string | undefined,
            filePath: out.filePath as string | undefined,
            bytes: out.bytes as number | undefined,
          },
        },
      });

      respond(true, out);
    } catch (e) {
      err(respond)("RENDER_FAILED", String(e));
    }
  },

  "reports.sendToTelegram": async ({ respond, params }) => {
    try {
      const payload = params?.payload as ReportPayload | undefined;
      if (!payload || typeof payload.title !== "string" || !Array.isArray(payload.sections)) {
        return err(respond)("INVALID_PARAMS", "payload {title, sections[]} required");
      }
      // A report about a run carries that run's verification screenshots.
      const evidence = await import("../../verification/telegram-evidence.js");
      const runId = evidence.resolveEvidenceRunId(params?.runId as string | undefined);
      const sourceSession = params?.sourceSession as string | undefined;
      const plan = runId ? await evidence.planVerificationEvidence(runId, [sourceSession]) : null;
      const baseCaption = (params?.caption as string | undefined) ?? payload.title;
      const result = await sendReportToTelegram(payload, {
        caption: plan ? `${baseCaption}\n${evidence.evidenceSummaryLine(plan)}` : baseCaption,
        chatId: params?.chatId as string | undefined,
      });

      const out: Record<string, unknown> = {
        ok: result.ok,
        messageId: result.messageId,
        chatId: result.chatId,
        filePath: result.filePath,
        bytes: result.bytes,
        error: result.error,
      };
      if (runId && plan?.picked.length && result.ok) {
        out.evidence = await evidence.attachVerificationEvidence(runId, result.messageId, {
          chatId: result.chatId ?? (params?.chatId as string | undefined),
          selection: plan,
          sessionKeys: [sourceSession],
        });
      }

      // Register + link the telegram message id so it lands in /reports.
      if (params?.register !== false && result.filePath) {
        try {
          const rec = ingestExternalPdf({
            path: result.filePath,
            kind: (params?.kind as string) ?? "manual_render",
            title: payload.title,
            theme: payload.theme ?? "black-gold",
            summaryText: payload.subtitle ?? undefined,
            status: result.ok ? "sent" : "ready",
            category: (params?.category as string | undefined) ?? null,
            sourceAgent: (params?.sourceAgent as string | undefined) ?? null,
            sourceSession: (params?.sourceSession as string | undefined) ?? null,
            association: result.messageId ? { telegramMessageId: result.messageId } : undefined,
          });
          out.id = rec.id;
        } catch {
          /* best-effort */
        }
      }

      // Auto-associate with the client / opportunity / project this report is
      // about, when the caller named one. Best-effort: the PDF is already
      // rendered, so a link failure is reported, never thrown.
      if (out.id) {
        const { linked, errors } = autoLinkReport(
          out.id as string,
          readAssociationTargets(params as Record<string, unknown>),
          (params?.sourceAgent as string | undefined) || "reports",
        );
        if (linked.length) out.associations = linked;
        if (errors.length) out.associationErrors = errors;
      }

      // Mandatory media visualization: even when delivered to Telegram, show the
      // PDF on screen so the user sees the artifact appear locally.
      if (result.filePath) {
        emitMediaArtifact({
          agentId: (params?.sourceAgent as string | undefined) || "reports",
          agentName: "Reports",
          title: payload.title,
          body: result.ok ? "Report sent to Telegram" : "Report rendered (Telegram failed)",
          dedupKey: `pdf:send:${(out.id as string | undefined) ?? artifactHash(String(result.filePath))}`,
          media: {
            kind: "pdf",
            payload: {
              title: payload.title,
              reportId: out.id as string | undefined,
              filePath: result.filePath,
              bytes: result.bytes,
            },
          },
        });
      }

      respond(true, out);
    } catch (e) {
      err(respond)("RENDER_FAILED", String(e));
    }
  },

  "reports.resend": async ({ respond, params }) => {
    try {
      const id = params?.id as string;
      const sinks = params?.sinks as ReportSink[] | undefined;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      if (!Array.isArray(sinks) || !sinks.length) {
        return err(respond)("INVALID_PARAMS", "Missing sinks");
      }
      const rec = getReportsStore().getReport(id);
      if (!rec) return err(respond)("NOT_FOUND", `report ${id} not found`);
      if (!rec.filePath) return err(respond)("NOT_READY", `report ${id} not rendered yet`);
      const results = await fanOut(rec, sinks);
      const ok = results.some((r) => r.ok);
      respond(true, { ok, results });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.delete": ({ respond, params }) => {
    try {
      const id = params?.id as string;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      const rec = getReportsStore().getReport(id);
      if (rec?.filePath) {
        try {
          unlinkSync(rec.filePath);
        } catch {
          /* file may already be gone */
        }
      }
      const ok = getReportsStore().deleteReport(id);
      respond(true, { ok });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── meta (kinds + themes) — handy for the UI generate form ─────────
  "reports.meta": ({ respond }) => {
    try {
      respond(true, { kinds: listKinds(), themes: listThemes(), categories: REPORT_CATEGORIES });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── parity context — markdown corpus for sub-agents ─────────────────
  // Returns the assembled markdown copy of prior reports so an agent shares
  // context with the rest of the mesh. Filter by category / sourceAgent / since.
  //   reports.context ({ category?, sourceAgent?, since?, limit?, maxChars? })
  //     -> { context, reports[], omitted, totalChars }
  "reports.context": ({ respond, params }) => {
    try {
      const result = getReportContext({
        category: params?.category as string | undefined,
        sourceAgent: params?.sourceAgent as string | undefined,
        since: params?.since as number | undefined,
        limit: params?.limit as number | undefined,
        maxChars: params?.maxChars as number | undefined,
        perReportChars: params?.perReportChars as number | undefined,
      });
      respond(true, result);
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── schedules ──────────────────────────────────────────────────────
  "reports.schedules.list": ({ respond }) => {
    try {
      respond(true, { schedules: getReportsStore().listSchedules() });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.schedules.upsert": ({ respond, params }) => {
    try {
      const kind = params?.kind as string;
      const cron = params?.cron as string;
      if (!kind || !cron) return err(respond)("INVALID_PARAMS", "kind and cron required");
      const schedule = getReportsStore().upsertSchedule({
        id: params?.id as string | undefined,
        kind,
        cron,
        theme: params?.theme as string | undefined,
        enabled: params?.enabled as boolean | undefined,
        sinks: params?.sinks as ReportSink[] | undefined,
        config: params?.config as Record<string, unknown> | undefined,
      });
      respond(true, { schedule });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.schedules.delete": ({ respond, params }) => {
    try {
      const id = params?.id as string;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      respond(true, { ok: getReportsStore().deleteSchedule(id) });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── triggers ───────────────────────────────────────────────────────
  "reports.triggers.list": ({ respond, params }) => {
    try {
      respond(true, {
        triggers: getReportsStore().listTriggers(params?.eventType as string | undefined),
      });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.triggers.upsert": ({ respond, params }) => {
    try {
      const kind = params?.kind as string;
      const eventType = params?.eventType as string;
      if (!kind || !eventType) return err(respond)("INVALID_PARAMS", "kind and eventType required");
      const trigger = getReportsStore().upsertTrigger({
        id: params?.id as string | undefined,
        kind,
        eventType,
        theme: params?.theme as string | undefined,
        enabled: params?.enabled as boolean | undefined,
        sinks: params?.sinks as ReportSink[] | undefined,
        config: params?.config as Record<string, unknown> | undefined,
      });
      respond(true, { trigger });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  "reports.triggers.delete": ({ respond, params }) => {
    try {
      const id = params?.id as string;
      if (!id) return err(respond)("INVALID_PARAMS", "Missing id");
      respond(true, { ok: getReportsStore().deleteTrigger(id) });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },

  // ── insights (read-only) ───────────────────────────────────────────
  "reports.insights.list": ({ respond, params }) => {
    try {
      const insights = getReportsStore().listInsights({
        since: params?.since as number | undefined,
        kind: params?.kind as string | undefined,
        limit: params?.limit as number | undefined,
      });
      respond(true, { insights });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },
  // ── Associations ────────────────────────────────────────────────────────
  // Bind a report to the client / opportunity / project it documents. Stored
  // as typed edges in the objrel graph (src/reports/associations.ts), so a
  // report shows up in `objrel.graph` next to the rest of the business objects.

  "reports.link": ({ respond, params }) => {
    try {
      const reportId = params?.reportId as string;
      const targetType = params?.targetType as string;
      const targetId = params?.targetId as string;
      if (!reportId) return err(respond)("INVALID_PARAMS", "Missing reportId");
      if (!targetType || !targetId) {
        return err(respond)(
          "INVALID_PARAMS",
          `targetType (${REPORT_TARGET_TYPES.join("|")}) and targetId are required`,
        );
      }
      const association = linkReport({
        reportId,
        targetType,
        targetId,
        createdBy: (params?.createdBy as string | undefined) || "user",
        meta: (params?.meta as Record<string, unknown> | undefined) ?? {},
      });
      respond(true, { ok: true, association });
    } catch (e) {
      const msg = String(e);
      // A bad target type / unknown report is caller error, not a server fault.
      const code = /not found/i.test(msg)
        ? "NOT_FOUND"
        : /required|must be one of/i.test(msg)
          ? "INVALID_PARAMS"
          : "INTERNAL_ERROR";
      err(respond)(code, msg);
    }
  },

  "reports.unlink": ({ respond, params }) => {
    try {
      const relationId = params?.relationId as string | undefined;
      const reportId = params?.reportId as string | undefined;
      if (!relationId && !reportId) {
        return err(respond)(
          "INVALID_PARAMS",
          "Provide relationId, or reportId (+ optional target)",
        );
      }
      const deleted = unlinkReport({
        relationId,
        reportId,
        targetType: params?.targetType as string | undefined,
        targetId: params?.targetId as string | undefined,
      });
      respond(true, { ok: true, deleted });
    } catch (e) {
      const msg = String(e);
      err(respond)(/must be one of|provide /i.test(msg) ? "INVALID_PARAMS" : "INTERNAL_ERROR", msg);
    }
  },

  "reports.forObject": ({ respond, params }) => {
    try {
      const type = params?.type as string;
      const id = params?.id as string;
      if (!type || !id) {
        return err(respond)(
          "INVALID_PARAMS",
          `type (${REPORT_TARGET_TYPES.join("|")}) and id are required`,
        );
      }
      const { reports, associations, missing } = reportsForObject(type, id, {
        limit: params?.limit as number | undefined,
      });
      respond(true, {
        reports,
        associations,
        total: reports.length,
        ...(missing.length ? { missing } : {}),
      });
    } catch (e) {
      const msg = String(e);
      err(respond)(/must be one of|required/i.test(msg) ? "INVALID_PARAMS" : "INTERNAL_ERROR", msg);
    }
  },

  "reports.associations": ({ respond, params }) => {
    try {
      const reportId = params?.reportId as string;
      if (!reportId) return err(respond)("INVALID_PARAMS", "Missing reportId");
      const associations = associationsForReport(reportId);
      respond(true, { associations, total: associations.length });
    } catch (e) {
      err(respond)("INTERNAL_ERROR", String(e));
    }
  },
};
