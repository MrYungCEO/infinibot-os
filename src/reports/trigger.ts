/**
 * Report enqueue helpers — the single entry point both the RPC layer
 * (`reports.generate`) and system hooks (self-heal gateway recovery, cron) use
 * to queue a report. Writing a `queued` row is all that happens here; the
 * worker process picks it up and renders. The gateway never renders inline, so
 * enqueueing is cheap and crash-safe.
 *
 * Sinks are stored inside `config.sinks` (the `reports` table has no sinks
 * column) and read back by the worker during fan-out.
 */

import { getReportsStore } from "./store.js";
import type { ReportKind, ReportRecord, ReportSink, ReportTrigger } from "./types.js";

export interface EnqueueReportInput {
  kind: ReportKind;
  theme?: string;
  trigger?: ReportTrigger;
  sinks?: ReportSink[];
  sourceRecordId?: string | null;
  config?: Record<string, unknown>;
  title?: string;
}

export function enqueueReport(input: EnqueueReportInput): ReportRecord {
  const store = getReportsStore();
  const sinks = input.sinks ?? ["ui", "telegram"];
  return store.createReport({
    kind: input.kind,
    title: input.title,
    theme: input.theme ?? "black-gold",
    trigger: input.trigger ?? "manual",
    sourceRecordId: input.sourceRecordId ?? null,
    config: { ...input.config, sinks },
  });
}

/**
 * Fire any enabled `report_triggers` rows registered for `eventType`. Returns
 * the ids of reports enqueued. Best-effort: a malformed trigger never throws
 * into the caller (used from the self-heal boot path).
 */
export function fireEventTriggers(
  eventType: string,
  config: Record<string, unknown> = {},
): string[] {
  const ids: string[] = [];
  try {
    const store = getReportsStore();
    const triggers = store.listTriggers(eventType).filter((t) => t.enabled);
    for (const t of triggers) {
      try {
        const rec = enqueueReport({
          kind: t.kind,
          theme: t.theme,
          trigger: "event",
          sinks: t.sinks,
          config: { ...t.config, ...config },
        });
        ids.push(rec.id);
      } catch {
        // skip a bad trigger; keep firing the rest
      }
    }
  } catch {
    // store unavailable — nothing to fire
  }
  return ids;
}
