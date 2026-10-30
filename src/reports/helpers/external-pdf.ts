/**
 * Ingest an externally-rendered PDF into the Report System in one call.
 *
 * Historically, ad-hoc PDFs (plans, proposals, incident summaries) were rendered
 * by throwaway puppeteer scripts and pushed straight to Telegram, never landing
 * in the `reports` table or the `/reports` UI. This helper is the canonical
 * bridge for any code that *already has a rendered PDF on disk* and wants it to
 * become a first-class report row: it creates the row, copies the file to the
 * canonical `~/.infinibot/reports/<id>.pdf` location, links it to its
 * originating project / kanban task / spawn run (and any Telegram message it was
 * already sent to), and flips it to `ready`.
 *
 * For NEW reports that have not been rendered yet, prefer the normal
 * `reports.generate` → worker path (the worker renders + fans out to Telegram
 * automatically). Use this helper only when the PDF already exists and you are
 * registering it after the fact. See
 * `docs/plans/report-system-pdf-ingestion.md`.
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { getReportsStore } from "../store.js";
import {
  ensureReportAssociationColumns,
  REPORT_ASSOCIATION_COLUMNS,
} from "../migrations/0001-report-associations.js";
import { categorizeReport } from "./categorize.js";
import { attachMarkdownParity } from "./parity.js";
import { originalFormatOf } from "./markitdown.js";
import { autoLinkReport, type ReportAssociationTargets } from "../associations.js";
import type { ReportKind, ReportRecord, ReportStatus, ReportTrigger } from "../types.js";

/** Links a report back to the work / message that produced it. */
export interface ReportAssociation {
  /** Originating project id (kanban project), if resolvable. */
  projectId?: string | null;
  /** Human-readable project name (captured even when projectId is unknown). */
  projectName?: string | null;
  /** Originating kanban task id. */
  kanbanTaskId?: string | null;
  /** Originating spawn run id (e.g. `coder-...`). */
  runId?: string | null;
  /**
   * Telegram message id(s) the PDF was already delivered to, if it was pushed
   * out-of-band before being registered. Accepts a single id or a list.
   */
  telegramMessageId?: string | number | Array<string | number> | null;
}

export interface IngestExternalPdfInput {
  /** Absolute path to the already-rendered PDF on disk. */
  path: string;
  kind: ReportKind;
  /** Clean human title (defaults to `<kind> report`). */
  title?: string;
  theme?: string;
  /** 1-2 line summary shown in the list / preview. */
  summaryText?: string;
  /** Association links (project / task / run / telegram). */
  association?: ReportAssociation;
  /**
   * Business objects this document is *about* — the client / opportunity /
   * project it documents. Written as typed edges in the objrel graph (see
   * ../associations.ts), which is what `reports.forObject` reads, so every
   * producer that registers a PDF can associate it in the same call.
   *
   * Distinct from `association.projectId` above: that records the kanban
   * project the *work* came from, this records what the report *covers*.
   */
  businessObjects?: ReportAssociationTargets;
  /** Report row timestamp; defaults to the source file's mtime. */
  createdAt?: number;
  /** Final status; defaults to `ready` (file is already rendered). */
  status?: ReportStatus;
  /** What enqueued it; defaults to `manual`. */
  trigger?: ReportTrigger;
  /**
   * Explicit category override. When omitted it is inferred from kind/title/
   * source agent (see helpers/categorize.ts).
   */
  category?: string | null;
  /** Agent id/name that produced this document, if a sub-agent did. */
  sourceAgent?: string | null;
  /** Gateway session key the document originated from. */
  sourceSession?: string | null;
  /** Source format (pdf/docx/html/...). Defaults to the file's extension. */
  originalFormat?: string | null;
  /**
   * Skip the markitdown markdown-parity conversion (default false). Conversion
   * runs in the background and never blocks the returned record.
   */
  skipMarkdown?: boolean;
  /**
   * The structured ReportPayload the PDF was rendered from, when known. Kept in
   * `config.payload` so the canvas runtime can rebuild the report as a
   * walkthrough section by section (src/canvas-host/canvas-convert.ts).
   */
  payload?: unknown;
  /**
   * Override the canonical state dir (tests / explicit installs). Defaults to
   * the resolved InfiniBot state dir used by the store.
   */
  stateDir?: string;
}

/** Normalize a telegram message id input into a comma-joined string (or null). */
function normalizeTelegramId(v: ReportAssociation["telegramMessageId"]): string | null {
  if (v == null) return null;
  const arr = Array.isArray(v) ? v : [v];
  const cleaned = arr.map((x) => String(x).trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(",") : null;
}

/**
 * Write the normalized association columns onto an existing report row.
 *
 * Split out of {@link ingestExternalPdf} because the enqueue path needs the
 * same thing: a queued `agency_invoice` / `agency_proposal` report has to point
 * at the client's project the moment it is created, not only once it renders.
 * Uses a direct connection because the foundation store's `updateReport`
 * contract does not map these columns (see the migration's note), and ensures
 * the columns exist first so it is safe whichever process created the table.
 */
export function setReportAssociations(
  reportId: string,
  association: ReportAssociation,
  options: { stateDir?: string; createdAt?: number } = {},
): void {
  const stateDir = options.stateDir ?? getReportsStore(options.stateDir).stateDir;
  const raw = new Database(resolve(stateDir, "databases.db"));
  try {
    raw.pragma("journal_mode = WAL");
    ensureReportAssociationColumns(raw);
    const sets = [
      "source_project_id = ?",
      "source_kanban_task_id = ?",
      "source_run_id = ?",
      "source_telegram_message_id = ?",
    ];
    const args: unknown[] = [
      association.projectId ?? null,
      association.kanbanTaskId ?? null,
      association.runId ?? null,
      normalizeTelegramId(association.telegramMessageId),
    ];
    if (options.createdAt !== undefined) {
      sets.push("created_at = ?");
      args.push(options.createdAt);
    }
    args.push(reportId);
    raw.prepare(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  } finally {
    raw.close();
  }
}

/**
 * Register an already-rendered PDF as a `ready` report row, linked to its
 * source. Returns the persisted record (including the new canonical `filePath`).
 *
 * Throws if the source file does not exist — callers backfilling a batch should
 * catch per-item and skip rather than aborting the whole run.
 */
export function ingestExternalPdf(input: IngestExternalPdfInput): ReportRecord {
  const srcPath = resolve(input.path);
  if (!existsSync(srcPath)) {
    throw new Error(`ingestExternalPdf: source PDF not found at ${srcPath}`);
  }

  const store = getReportsStore(input.stateDir);
  const stateDir = store.stateDir;
  const assoc = input.association ?? {};
  const telegramId = normalizeTelegramId(assoc.telegramMessageId);

  // Mirror associations into config so `reports.get` (which returns the full
  // record including config) can render them without foundation changes.
  const associationConfig: Record<string, unknown> = {
    association: {
      projectId: assoc.projectId ?? null,
      projectName: assoc.projectName ?? null,
      kanbanTaskId: assoc.kanbanTaskId ?? null,
      runId: assoc.runId ?? null,
      telegramMessageId: telegramId,
    },
    ingestedFrom: srcPath,
    ...(input.payload ? { payload: input.payload } : {}),
  };

  const originalFormat = input.originalFormat ?? originalFormatOf(srcPath);
  const category = categorizeReport({
    kind: input.kind,
    title: input.title,
    sourceAgent: input.sourceAgent,
    explicit: input.category,
  });

  // 1. Create the queued row (gets us an id for the canonical file name).
  const created = store.createReport({
    kind: input.kind,
    title: input.title ?? `${input.kind} report`,
    theme: input.theme ?? "black-gold",
    trigger: input.trigger ?? "manual",
    // The generic FK points at the most specific source we have (the run).
    sourceRecordId: assoc.runId ?? assoc.kanbanTaskId ?? null,
    config: associationConfig,
    category,
    sourceAgent: input.sourceAgent ?? null,
    sourceSession: input.sourceSession ?? null,
    originalFormat,
  });

  // 2. Copy (not move) the file into the canonical reports dir, preserving the
  //    source extension so markitdown reads the artifact in its real format.
  const reportsDir = join(stateDir, "reports");
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
  const ext = (extname(srcPath) || ".pdf").toLowerCase();
  const destPath = join(reportsDir, `${created.id}${ext}`);
  copyFileSync(srcPath, destPath);
  const fileSize = statSync(destPath).size;
  const createdAt = input.createdAt ?? statSync(srcPath).mtimeMs;

  // 3. Flip to ready + record the rendered file via the store contract.
  store.updateReport(created.id, {
    status: input.status ?? "ready",
    filePath: destPath,
    fileSize,
    renderedAt: createdAt,
    summaryText: input.summaryText ?? null,
  });

  // 4. Write the dedicated, normalized association columns + backdated
  //    created_at.
  setReportAssociations(created.id, assoc, { stateDir, createdAt });

  // 5. Generate the markdown parity copy in the background (markitdown is a
  //    subprocess; we don't block the caller on it). The row is updated with
  //    markdown_body / markdown_path when conversion finishes. Best-effort.
  if (!input.skipMarkdown) {
    void attachMarkdownParity({
      store,
      reportId: created.id,
      filePath: destPath,
      originalFormat,
    }).catch(() => {
      /* conversion failures are non-fatal — the report keeps its artifact */
    });
  }

  // 6. Bind the report to the business objects it documents. Best-effort: a
  //    failed edge must never lose an already-ingested PDF.
  if (input.businessObjects) {
    autoLinkReport(created.id, input.businessObjects, input.sourceAgent || "reports");
  }

  const final = store.getReport(created.id);
  if (!final) throw new Error(`ingestExternalPdf: row ${created.id} vanished post-write`);
  return final;
}

/** Column names this helper writes — exported for callers/tests. */
export { REPORT_ASSOCIATION_COLUMNS };
