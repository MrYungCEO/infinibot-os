/**
 * Persistent store for AI current-state project summaries.
 *
 * The summary is intentionally kept OUT of the project content-blocks store:
 * that body is operator-authored and we must never clobber it. Instead each
 * project's AI summary + revision log live in a single JSON file under the
 * active profile's state dir, keyed by project id.
 *
 * Shape is deliberately small and self-contained so this module has no
 * dependency on the kanban store internals — the generator reads project data
 * through the normal `kanban-store-ops` read API and hands us the result.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("project-summary");

export interface ProjectSummaryRevision {
  /** Unix ms. */
  at: number;
  /** "text" (typed dump) or "voice" (spoken dump reconciled by the PM agent). */
  source: "text" | "voice" | "system";
  /** The raw operator input that drove this revision. */
  input: string;
}

export interface ProjectSummaryRecord {
  projectId: string;
  /** Markdown body of the current-state summary. */
  markdown: string;
  /** Unix ms of last generation/revision. */
  generatedAt: number;
  /** Which model produced it (provider:model). */
  model: string;
  /** How it was last produced. */
  source: "cron" | "manual" | "revision";
  /**
   * Stable hash of the gathered-context signature at generation time (task
   * count/statuses, body md hash, notes hash, attachment sha list, cash-flow).
   * The staleness check recomputes this cheaply and compares — a mismatch means
   * the underlying data changed since this summary was written. Optional so
   * pre-existing records (written before this field) load cleanly.
   */
  inputHash?: string;
  /** Rolling log of operator dumps folded into the summary (most recent last). */
  revisions: ProjectSummaryRevision[];
}

type SummaryFile = Record<string, ProjectSummaryRecord>;

function storePath(): string {
  return path.join(resolveStateDir(), "project-summaries.json");
}

let cache: SummaryFile | null = null;
let cachePath: string | null = null;

async function readAll(): Promise<SummaryFile> {
  const p = storePath();
  // Invalidate the cache on profile switch (state dir changes).
  if (cache && cachePath === p) return cache;
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as SummaryFile;
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    cache = {};
  }
  cachePath = p;
  return cache;
}

async function writeAll(data: SummaryFile): Promise<void> {
  const p = storePath();
  cache = data;
  cachePath = p;
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    log.warn(`failed to persist project summaries: ${String(err)}`);
  }
}

export async function getProjectSummary(projectId: string): Promise<ProjectSummaryRecord | null> {
  const all = await readAll();
  return all[projectId] ?? null;
}

export async function saveProjectSummary(record: ProjectSummaryRecord): Promise<ProjectSummaryRecord> {
  const all = await readAll();
  // Cap the revision log so the file can't grow without bound.
  const revisions = record.revisions.slice(-25);
  const next: ProjectSummaryRecord = { ...record, revisions };
  all[record.projectId] = next;
  await writeAll(all);
  return next;
}
