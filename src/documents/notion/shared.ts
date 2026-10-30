/**
 * Shared helpers for the Notion importers (API + ZIP export).
 *
 * Both importers key idempotency on `{ type: "notion", id: <32-hex> }` where
 * the id is the Notion page/database id normalized to lowercase hex without
 * hyphens, so importing the same page via the API and via a ZIP export
 * converges on the same node. Folders created for pages that have child
 * pages use `folder:<id>`.
 */

import { slugifyTitle, type DocumentStore } from "../store.js";
import type { DocNode, DocSource } from "../types.js";

/** Link resolution stats for the links an import rendered (bodies + relation properties). */
export interface ImportLinkStats {
  resolved: number;
  unresolved: number;
  /** resolved / (resolved + unresolved); null when no links were rendered. */
  rate?: number | null;
  /** First few unresolved links (capped at UNRESOLVED_SAMPLE_MAX). */
  unresolvedSample?: Array<{ from: string; target: string }>;
}

/** One-glance outcome of an import run (also derivable from the raw counts). */
export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  links: { total: number; resolved: number; unresolved: number; rate: number | null };
}

/** Import result shared by the API and ZIP importers (counts are per store node). */
export interface NotionImportReport {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: Array<{ id: string; error: string; title?: string }>;
  /** Top-level node ids produced by this import (one per requested root). */
  rootNodeIds: string[];
  links?: ImportLinkStats;
  /** Filled by finalizeReport() when the importer finishes. */
  summary?: ImportSummary;
}

export const UNRESOLVED_SAMPLE_MAX = 50;

export function emptyLinkStats(): Required<ImportLinkStats> {
  return { resolved: 0, unresolved: 0, rate: null, unresolvedSample: [] };
}

function linkStatsOf(report: NotionImportReport): ImportLinkStats {
  report.links ??= emptyLinkStats();
  return report.links;
}

export function noteResolvedLink(report: NotionImportReport, n = 1): void {
  linkStatsOf(report).resolved += n;
}

export function noteUnresolvedLink(report: NotionImportReport, from: string, target: string): void {
  const links = linkStatsOf(report);
  links.unresolved += 1;
  const sample = (links.unresolvedSample ??= []);
  if (sample.length < UNRESOLVED_SAMPLE_MAX) sample.push({ from, target: target.slice(0, 300) });
}

/** Compute `links.rate` and `summary` (call once when an import finishes or stops). */
export function finalizeReport<T extends NotionImportReport>(report: T): T {
  const links = report.links;
  const total = links ? links.resolved + links.unresolved : 0;
  const rate = links && total ? Math.round((links.resolved / total) * 10_000) / 10_000 : null;
  if (links) links.rate = rate;
  report.summary = {
    created: report.created,
    updated: report.updated,
    unchanged: report.unchanged,
    skipped: report.skipped,
    failed: report.errors.length,
    links: {
      total,
      resolved: links?.resolved ?? 0,
      unresolved: links?.unresolved ?? 0,
      rate,
    },
  };
  return report;
}

export interface NotionImportProgress {
  /** discover/write: two-pass ZIP importer; import/scan: streaming API importer. */
  phase: "discover" | "write" | "import" | "scan";
  done: number;
  total?: number;
  title?: string;
}

/** Thrown (and rethrown past per-page error collection) when an import is cancelled. */
export class ImportCancelledError extends Error {
  constructor(message = "Import cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export function isCancelled(err: unknown): boolean {
  return (
    err instanceof ImportCancelledError ||
    (err instanceof Error && err.name === "AbortError" && !/timeout/i.test(err.message))
  );
}

/** Throw ImportCancelledError when `signal` has been aborted. */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportCancelledError();
}

export type UpsertStatus = "created" | "updated" | "unchanged" | "skipped";

const HEX32_RE = /([0-9a-f]{32})(?![0-9a-f])/i;
const UUID_RE = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/i;

/**
 * Normalize a Notion id / URL / hyphenated UUID to 32 lowercase hex chars.
 * Returns null when no id can be found.
 */
export function normalizeNotionId(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  const uuid = UUID_RE.exec(s);
  if (uuid) return uuid.slice(1).join("").toLowerCase();
  // URLs end with `Title-<32hex>` optionally followed by `?query` / `#block`.
  const pathPart = s.split(/[?#]/)[0] ?? s;
  const all = pathPart.match(/[0-9a-f]{32}/gi);
  if (all?.length) return all[all.length - 1]!.toLowerCase();
  const m = HEX32_RE.exec(s);
  return m ? m[1]!.toLowerCase() : null;
}

/** Canonical notion.so URL for a normalized id (fallback link target). */
export function notionUrlFor(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

export function emptyReport(): NotionImportReport {
  return { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], rootNodeIds: [] };
}

export function tally(report: NotionImportReport, status: UpsertStatus): void {
  report[status] += 1;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pre-assigns stable, readable node ids so bodies written in the second pass
 * can link to nodes (`doc:<id>`) that may not exist yet. Existing nodes keep
 * their id; new ones get `<slug>-<first 6 of source id>` (collision-checked).
 */
export class IdAllocator {
  private readonly reserved = new Set<string>();

  constructor(private readonly store: DocumentStore) {}

  allocate(
    source: { type: DocSource["type"]; id: string },
    title: string,
  ): {
    id: string;
    existing: DocNode | null;
  } {
    const existing = this.store.findBySource(source.type, source.id);
    if (existing) return { id: existing.id, existing };
    const tail =
      source.id
        .replace(/[^a-z0-9]/gi, "")
        .slice(-6)
        .toLowerCase() || "n";
    const base = `${slugifyTitle(title).slice(0, 40)}-${tail}`;
    let id = base;
    for (let i = 2; this.store.getNode(id) || this.reserved.has(id); i++) id = `${base}-${i}`;
    this.reserved.add(id);
    return { id, existing: null };
  }
}

/**
 * Decide the `parentId` + `reparent` flag to pass to `upsertBySource`.
 *
 * `upsertBySource` leaves existing nodes wherever the user filed them unless
 * asked to re-parent. We only ask when the import's own structure changed:
 * the expected parent folder was created during this run (e.g. a page gained
 * child pages and became a folder), or the node's current parent is gone.
 * Import roots are never moved on re-import (the user's filing wins).
 */
export function decideParent(
  store: DocumentStore,
  existing: DocNode | null,
  expected: string | null,
  createdThisRun: Set<string>,
): { parentId: string | null; reparent: boolean } {
  if (!existing || (existing.parentId ?? null) === expected) {
    return { parentId: expected, reparent: false };
  }
  const structural = expected !== null && createdThisRun.has(expected);
  const orphaned = !!existing.parentId && !store.getNode(existing.parentId);
  return { parentId: expected, reparent: structural || orphaned };
}

/** File extension (with dot) from a file name or URL path, sanitized; "" when none. */
export function extFromName(name: string): string {
  const clean = (name.split(/[?#]/)[0] ?? name).split("/").pop() ?? "";
  const m = /\.([a-z0-9]{1,8})$/i.exec(clean);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "audio/mpeg": ".mp3",
  "text/plain": ".txt",
};

export function extFromMime(mime: string | undefined): string {
  if (!mime) return "";
  return MIME_EXT[mime.split(";")[0]!.trim().toLowerCase()] ?? "";
}

/** Last path segment of a URL (decoded, no query), used as a file name hint. */
export function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return (url.split(/[?#]/)[0] ?? url).split("/").pop() ?? url;
  }
}
