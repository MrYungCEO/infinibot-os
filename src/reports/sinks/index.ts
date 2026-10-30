/**
 * Sink fan-out. `ui` is implicit (the file is always written to file_path by
 * the worker); this module handles the external sinks (telegram, email).
 */

import type { ReportRecord, ReportSink } from "../types.js";
import { sendDocumentTelegram, type TelegramSinkResult } from "./telegram.js";

export interface SinkResult {
  sink: ReportSink;
  ok: boolean;
  detail?: string;
}

/**
 * Deliver a ready report to the requested sinks. Never throws — each sink's
 * outcome is captured independently so one failure doesn't block the rest.
 */
export async function fanOut(report: ReportRecord, sinks: ReportSink[]): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  for (const sink of sinks) {
    if (sink === "ui") {
      results.push({ sink, ok: true, detail: report.filePath ?? undefined });
      continue;
    }
    if (sink === "telegram") {
      if (!report.filePath) {
        results.push({ sink, ok: false, detail: "no file to send" });
        continue;
      }
      const r: TelegramSinkResult = await sendDocumentTelegram(report.filePath, {
        caption: `📊 ${report.title}\n${report.summaryText ?? ""}`.trim(),
      });
      results.push({
        sink,
        ok: r.ok,
        detail: r.ok ? `chat ${r.chatId} msg ${r.messageId}` : r.error,
      });
      continue;
    }
    if (sink === "email") {
      // Email sink lands in a later phase (Phase 4 per the plan).
      results.push({ sink, ok: false, detail: "email sink not implemented yet" });
      continue;
    }
  }
  return results;
}
