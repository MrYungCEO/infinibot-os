/**
 * Shared wire-shaping for report records.
 *
 * `reports.list` / `reports.get` and the association RPCs (`reports.forObject`)
 * must return the SAME report shape, or the UI ends up with two subtly
 * different "report" objects depending on which surface loaded it. This is the
 * single mapper both go through.
 */

import type { ReportRecord } from "../types.js";

/** The fields the wire contract exposes for a report row. */
export interface ReportWire {
  id: string;
  kind: string;
  title: string;
  theme: string;
  status: string;
  trigger: string;
  sourceRecordId: string | null;
  createdAt: number;
  renderedAt: number | null;
  filePath: string | null;
  fileSize: number | null;
  summaryText: string | null;
  category: string | null;
  sourceAgent: string | null;
  sourceSession: string | null;
  originalFormat: string | null;
  markdownPath: string | null;
  hasMarkdown: boolean;
}

/** Shape a stored record for the wire. Returns null for a missing record. */
export function toReportWire(r: ReportRecord | null | undefined): ReportWire | null {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    theme: r.theme,
    status: r.status,
    trigger: r.trigger,
    sourceRecordId: r.sourceRecordId,
    createdAt: r.createdAt,
    renderedAt: r.renderedAt,
    filePath: r.filePath,
    fileSize: r.fileSize,
    summaryText: r.summaryText,
    category: r.category,
    sourceAgent: r.sourceAgent,
    sourceSession: r.sourceSession,
    originalFormat: r.originalFormat,
    markdownPath: r.markdownPath,
    hasMarkdown: !!r.markdownBody,
  } as ReportWire;
}
