/**
 * Canvas conversion — turn a report, markdown or a stylized walkthrough into
 * an infinite-canvas-walkthrough payload (core canvas runtime, B34).
 *
 * One entry point over the three existing converters:
 *   - report      → reports/to-canvas.ts (via the stored ReportPayload, or the
 *                   report's markdown parity copy run through markdownToPayload)
 *   - markdown    → proactive/canvas-from-markdown.ts
 *   - walkthrough → stylized-walkthrough/to-canvas.ts
 *
 * Used by the core `canvas.convert` RPC and, through the `canvasRuntime` seam,
 * by the HoloCanvas library plugin. Works with the plugin off.
 */

import { readFileSync } from "node:fs";
import type { InfiniteCanvasWalkthroughMedia } from "../proactive/popup-types.js";
import { canvasFromMarkdown } from "../proactive/canvas-from-markdown.js";
import { markdownToPayload } from "../reports/helpers/markdown-to-payload.js";
import { getReportsStore } from "../reports/store.js";
import { reportToCanvasPayload } from "../reports/to-canvas.js";
import type { ReportPayload, ReportRecord } from "../reports/types.js";
import {
  stylizedWalkthroughToCanvasPayload,
  type WalkthroughChapter,
} from "../stylized-walkthrough/to-canvas.js";

export type CanvasSource =
  | { source: "report"; reportId: string; title?: string }
  | { source: "markdown"; markdown: string; title?: string }
  | { source: "walkthrough"; chapters: WalkthroughChapter[]; title?: string };

/** Proactive media kind the converted payload is emitted as. */
export type ConvertedCanvasKind =
  | "report-walkthrough"
  | "stylized-walkthrough"
  | "infinite-canvas-walkthrough";

export interface ConvertedCanvas {
  title: string;
  payload: InfiniteCanvasWalkthroughMedia;
  mediaKind: ConvertedCanvasKind;
  /** Source tag, also stored as a canvas tag when saved. */
  source: CanvasSource["source"];
}

export interface CanvasConvertDeps {
  getReport?: (id: string) => ReportRecord | null;
}

export class CanvasConvertError extends Error {
  constructor(
    readonly code: "INVALID_PARAMS" | "NOT_FOUND" | "NO_CONTENT",
    message: string,
  ) {
    super(message);
  }
}

function isReportPayload(v: unknown): v is ReportPayload {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { title?: unknown }).title === "string" &&
    Array.isArray((v as { sections?: unknown }).sections)
  );
}

function reportMarkdown(rec: ReportRecord): string | null {
  if (rec.markdownBody?.trim()) return rec.markdownBody;
  if (rec.markdownPath) {
    try {
      const md = readFileSync(rec.markdownPath, "utf-8");
      if (md.trim()) return md;
    } catch {
      /* parity copy missing */
    }
  }
  return null;
}

/** Validate loose RPC/tool params into a CanvasSource. Throws CanvasConvertError. */
export function parseCanvasSource(raw: unknown): CanvasSource {
  const p = (raw ?? {}) as Record<string, unknown>;
  const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : undefined;
  switch (p.source) {
    case "report": {
      const reportId = typeof p.reportId === "string" ? p.reportId.trim() : "";
      if (!reportId) throw new CanvasConvertError("INVALID_PARAMS", "reportId is required");
      return { source: "report", reportId, title };
    }
    case "markdown": {
      const markdown = typeof p.markdown === "string" ? p.markdown : "";
      if (!markdown.trim()) throw new CanvasConvertError("INVALID_PARAMS", "markdown is required");
      return { source: "markdown", markdown, title };
    }
    case "walkthrough": {
      const chapters = Array.isArray(p.chapters)
        ? (p.chapters as unknown[])
            .filter(
              (c): c is WalkthroughChapter =>
                !!c &&
                typeof (c as WalkthroughChapter).title === "string" &&
                typeof (c as WalkthroughChapter).body === "string",
            )
            .map((c) => ({ title: c.title, body: c.body }))
        : [];
      if (chapters.length === 0) {
        throw new CanvasConvertError("INVALID_PARAMS", "chapters[] ({title, body}) is required");
      }
      return { source: "walkthrough", chapters, title };
    }
    default:
      throw new CanvasConvertError(
        "INVALID_PARAMS",
        'source must be "report", "markdown" or "walkthrough"',
      );
  }
}

export function convertToCanvas(src: CanvasSource, deps: CanvasConvertDeps = {}): ConvertedCanvas {
  if (src.source === "report") {
    const rec = (deps.getReport ?? ((id: string) => getReportsStore().getReport(id)))(src.reportId);
    if (!rec) throw new CanvasConvertError("NOT_FOUND", `report ${src.reportId} not found`);
    const stored = (rec.config as { payload?: unknown } | undefined)?.payload;
    let report: ReportPayload;
    if (isReportPayload(stored)) {
      report = stored;
    } else {
      const md = reportMarkdown(rec);
      if (!md) {
        throw new CanvasConvertError(
          "NO_CONTENT",
          `report ${src.reportId} has no content to convert`,
        );
      }
      report = markdownToPayload(md, { title: rec.title });
    }
    const title = src.title ?? report.title ?? rec.title;
    const payload = reportToCanvasPayload({ ...report, title });
    return {
      title,
      payload: { ...payload, title },
      mediaKind: "report-walkthrough",
      source: "report",
    };
  }
  if (src.source === "walkthrough") {
    const payload = stylizedWalkthroughToCanvasPayload(src.chapters, src.title);
    const title = src.title ?? payload.title ?? src.chapters[0]!.title;
    return {
      title,
      payload: { ...payload, title },
      mediaKind: "stylized-walkthrough",
      source: "walkthrough",
    };
  }
  const payload = canvasFromMarkdown(src.markdown);
  const title =
    src.title ?? payload.title ?? /^#\s+(.+)$/m.exec(src.markdown)?.[1]?.trim() ?? "Canvas";
  return {
    title,
    payload: { ...payload, title },
    mediaKind: "infinite-canvas-walkthrough",
    source: "markdown",
  };
}
