/**
 * Worker engine — renders a single claimed report end-to-end.
 *
 * Pulled out of the daemon loop so it can be unit-tested and reused. Pure with
 * respect to scheduling: the caller claims a `rendering` row and hands it here;
 * this function collects source data, renders the PDF, persists the result, and
 * fans out to sinks. It never throws — failures flip the row to `failed` and are
 * returned in the result so the daemon can log them.
 */

import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReportsStore } from "../store.js";
import type { ReportRecord, ReportSink } from "../types.js";
import { getKind } from "../kinds/index.js";
import { getTheme } from "../themes/index.js";
import { renderHtmlToPdf } from "../renderer.js";
import { fanOut, type SinkResult } from "../sinks/index.js";
import { categorizeReport } from "../helpers/categorize.js";
import { attachMarkdownParity } from "../helpers/parity.js";

export interface ProcessResult {
  id: string;
  status: ReportRecord["status"];
  filePath?: string;
  error?: string;
  sinks?: SinkResult[];
}

export function reportsDir(stateDir: string): string {
  const dir = join(stateDir, "reports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function processReport(
  store: ReportsStore,
  report: ReportRecord,
): Promise<ProcessResult> {
  const kindModule = getKind(report.kind);
  if (!kindModule) {
    store.updateReport(report.id, {
      status: "failed",
      summaryText: `unknown report kind: ${report.kind}`,
    });
    return { id: report.id, status: "failed", error: `unknown kind ${report.kind}` };
  }

  const theme = getTheme(report.theme);
  const outPath = join(reportsDir(store.stateDir), `${report.id}.pdf`);

  try {
    const collected = await kindModule.collect({
      theme,
      config: report.config,
      stateDir: store.stateDir,
    });

    await renderHtmlToPdf(collected.html, outPath);

    let fileSize: number | null = null;
    try {
      fileSize = statSync(outPath).size;
    } catch {
      /* size best-effort */
    }

    store.updateReport(report.id, {
      status: "ready",
      title: collected.title || report.title,
      summaryText: collected.summaryText,
      filePath: outPath,
      fileSize,
      renderedAt: Date.now(),
      sourceRecordId: collected.sourceRecordId ?? report.sourceRecordId,
      category:
        report.category ??
        categorizeReport({ kind: report.kind, title: collected.title || report.title }),
      originalFormat: report.originalFormat ?? "pdf",
    });

    // Markdown parity copy (markitdown). Best-effort; awaited here since the
    // worker is a dedicated process and not on the gateway's hot path.
    await attachMarkdownParity({
      store,
      reportId: report.id,
      filePath: outPath,
      originalFormat: "pdf",
    }).catch(() => {
      /* conversion failures are non-fatal */
    });

    // Persist any insight rows the collector produced.
    for (const ins of collected.insights ?? []) {
      try {
        store.insertInsight({ ...ins, reportId: report.id });
      } catch {
        /* one bad insight shouldn't fail the report */
      }
    }

    // Fan out. Sinks are stored in config by the enqueue helper.
    const sinks = (
      Array.isArray(report.config.sinks) ? (report.config.sinks as ReportSink[]) : ["ui"]
    ) as ReportSink[];
    const updated = store.getReport(report.id)!;
    const sinkResults = await fanOut(updated, sinks);

    // If any external sink succeeded, mark sent (UI-only stays "ready").
    const externalSent = sinkResults.some((r) => r.sink !== "ui" && r.ok);
    if (externalSent) store.updateReport(report.id, { status: "sent" });

    const final = store.getReport(report.id)!;
    return { id: report.id, status: final.status, filePath: outPath, sinks: sinkResults };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.updateReport(report.id, {
      status: "failed",
      summaryText: `render failed: ${message}`.slice(0, 500),
    });
    return { id: report.id, status: "failed", error: message };
  }
}
