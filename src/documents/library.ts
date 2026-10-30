/**
 * Documents library — one typed list across every kind of knowledge item:
 *
 *   documents   docs + uploaded files from the documents store (typed)
 *   ideas       the ideas store (type "idea")
 *   reports     rendered reports (type "report", read-only)
 *   research    Research workspace records (type "research", opened in Research)
 *
 * Pure: callers pass the raw records in (documents.library RPC, the agent
 * tool, tests). Counts are computed after the text query and before the
 * type/category filter so the sidebar shows what each filter would return.
 */

import type { DocTypeDef } from "./doc-types-shared.js";
import { effectiveDocType } from "./doc-types-shared.js";
import type { DocNode } from "./types.js";

export type LibrarySource = "doc" | "idea" | "report" | "research";

export interface LibraryItem {
  id: string;
  source: LibrarySource;
  /** doc/file for documents; undefined for ideas/reports/research. */
  kind?: "doc" | "file";
  type: string;
  /** True when `type` was inferred (the document has no stored type yet). */
  inferred?: boolean;
  category?: string;
  title: string;
  preview?: string;
  tags?: string[];
  updatedAt: string;
  createdAt?: string;
  parentId?: string | null;
  path?: string;
  /** Idea / report / research status. */
  status?: string;
  readOnly?: boolean;
  favorite?: boolean;
  /** Ideas: what it was promoted into. */
  promotedTo?: { kind: string; id: string };
}

export interface LibraryIdeaLike {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  promotedTo?: { kind: string; id: string };
}

export interface LibraryReportLike {
  id: string;
  kind?: string;
  title: string;
  status?: string;
  category?: string | null;
  summaryText?: string | null;
  createdAt: number;
  renderedAt?: number | null;
}

export interface LibraryResearchLike {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  category?: string;
  status?: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
}

export interface LibraryFilter {
  type?: string;
  category?: string;
  query?: string;
  limit?: number;
}

export interface LibraryResult {
  items: LibraryItem[];
  total: number;
  counts: {
    all: number;
    byType: Record<string, number>;
    byCategory: Record<string, number>;
  };
}

function iso(ms: number | null | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function excerpt(text: string, max = 160): string {
  const flat = text
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function docToLibraryItem(
  n: DocNode,
  types: Array<Pick<DocTypeDef, "id" | "label">>,
  path?: string,
): LibraryItem | null {
  if (n.kind === "folder") return null;
  const eff = effectiveDocType(n, types);
  return {
    id: n.id,
    source: "doc",
    kind: n.kind,
    type: eff.type ?? "note",
    inferred: eff.inferred || undefined,
    category: n.category,
    title: n.title,
    preview:
      n.preview ?? (n.file ? `${n.file.ext.replace(".", "").toUpperCase()} file` : undefined),
    tags: n.tags,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    parentId: n.parentId,
    path,
    favorite: n.favorite,
  };
}

export function ideaToLibraryItem(i: LibraryIdeaLike): LibraryItem {
  return {
    id: i.id,
    source: "idea",
    type: "idea",
    title: i.title,
    preview: excerpt(i.body ?? ""),
    tags: i.tags,
    status: i.status,
    updatedAt: i.updatedAt,
    createdAt: i.createdAt,
    promotedTo: i.promotedTo ? { kind: i.promotedTo.kind, id: i.promotedTo.id } : undefined,
  };
}

export function reportToLibraryItem(r: LibraryReportLike): LibraryItem {
  return {
    id: r.id,
    source: "report",
    type: "report",
    // Report categories are the Reports page's own taxonomy; the library's
    // category facet stays for documents.
    title: r.title || r.id,
    preview: r.summaryText
      ? excerpt(r.summaryText)
      : [r.kind, r.category].filter(Boolean).join(" · "),
    status: r.status,
    updatedAt: iso(r.renderedAt ?? r.createdAt),
    createdAt: iso(r.createdAt),
    readOnly: true,
  };
}

export function researchToLibraryItem(r: LibraryResearchLike): LibraryItem {
  return {
    id: r.id,
    source: "research",
    type: "research",
    category: r.category,
    title: r.name || r.id,
    preview: r.description || (r.preview ? excerpt(r.preview) : undefined),
    tags: r.tags,
    status: r.status,
    updatedAt: iso(r.updatedAt),
    createdAt: iso(r.createdAt),
    readOnly: true,
  };
}

function matches(item: LibraryItem, q: string): boolean {
  if (!q) return true;
  const hay =
    `${item.title}\n${item.preview ?? ""}\n${(item.tags ?? []).join(" ")}\n${item.category ?? ""}`.toLowerCase();
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

export function buildLibrary(
  input: {
    docs: Array<{ node: DocNode; path?: string }>;
    ideas?: LibraryIdeaLike[];
    reports?: LibraryReportLike[];
    research?: LibraryResearchLike[];
    types: Array<Pick<DocTypeDef, "id" | "label">>;
  },
  filter: LibraryFilter = {},
): LibraryResult {
  const all: LibraryItem[] = [];
  for (const d of input.docs) {
    const it = docToLibraryItem(d.node, input.types, d.path);
    if (it) all.push(it);
  }
  for (const i of input.ideas ?? []) all.push(ideaToLibraryItem(i));
  for (const r of input.reports ?? []) all.push(reportToLibraryItem(r));
  for (const r of input.research ?? []) all.push(researchToLibraryItem(r));

  const q = (filter.query ?? "").trim().toLowerCase();
  const searched = q ? all.filter((i) => matches(i, q)) : all;

  const byType: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const it of searched) {
    byType[it.type] = (byType[it.type] ?? 0) + 1;
    if (it.category) byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
  }

  let items = searched;
  if (filter.type) items = items.filter((i) => i.type === filter.type);
  if (filter.category) items = items.filter((i) => i.category === filter.category);
  items = [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const total = items.length;
  const limit =
    typeof filter.limit === "number" && filter.limit > 0 ? Math.floor(filter.limit) : 500;
  return {
    items: items.slice(0, limit),
    total,
    counts: { all: searched.length, byType, byCategory },
  };
}
