/**
 * Documents › types — client model (pure, unit-tested).
 *
 * The type registry and the library merge are shared with the gateway
 * (src/documents/doc-types-shared.ts + library.ts) so the sidebar counts, the
 * inference for untyped docs and the ideas merge are identical on both sides.
 * When the gateway predates documents.types.* / documents.library (restart
 * pending), the workspace falls back to the built-ins and merges
 * documents.tree + ideas.list here.
 */

import {
  BUILTIN_DOC_TYPES,
  effectiveDocType,
  renderTemplate,
  type DocTypeDef,
} from "../../../../../src/documents/doc-types-shared.js";
import {
  buildLibrary,
  type LibraryFilter,
  type LibraryIdeaLike,
  type LibraryItem,
  type LibraryResult,
} from "../../../../../src/documents/library.js";
import type { DocNode } from "../../../../../src/documents/types.js";
import type { DocSummary } from "./model";

export type { DocTypeDef, LibraryItem, LibraryResult };
export { renderTemplate };

/** The built-in registry in display order (used until documents.types.list answers). */
export function fallbackTypes(): DocTypeDef[] {
  return BUILTIN_DOC_TYPES.map((t, order) => ({ ...t, order }));
}

/** Types shown in the sidebar / pickers (not hidden, not archived). */
export function visibleTypes(types: readonly DocTypeDef[]): DocTypeDef[] {
  return types.filter((t) => !t.hidden && !t.archived);
}

/** Types a new item can be created as (the New menu). */
export function creatableTypes(types: readonly DocTypeDef[]): DocTypeDef[] {
  return visibleTypes(types).filter((t) => t.creatable);
}

/** Types a document can be switched to (the editor chip): documents-backed only. */
export function assignableTypes(types: readonly DocTypeDef[]): DocTypeDef[] {
  return visibleTypes(types).filter((t) => t.backing === "documents");
}

const UNKNOWN: Omit<DocTypeDef, "id" | "label"> = {
  icon: "fileText",
  color: "#8a8478",
  builtin: false,
  backing: "documents",
  creatable: false,
  order: 9999,
};

export function typeMeta(types: readonly DocTypeDef[], id: string | null | undefined): DocTypeDef {
  const hit = id ? types.find((t) => t.id === id) : undefined;
  return hit ?? { ...UNKNOWN, id: id ?? "note", label: id ? id.replace(/^c-/, "").replace(/-/g, " ") : "Note" };
}

/** Sidebar rows: every visible type with its count, plus hidden/archived types that still hold items. */
export function sidebarTypeRows(
  types: readonly DocTypeDef[],
  counts: Record<string, number>,
): Array<{ type: DocTypeDef; count: number }> {
  return types
    .filter((t) => (!t.hidden && !t.archived) || (counts[t.id] ?? 0) > 0)
    .map((type) => ({ type, count: counts[type.id] ?? 0 }));
}

/** Category rows, most used first. */
export function categoryRows(counts: Record<string, number>): Array<{ category: string; count: number }> {
  return Object.entries(counts)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/**
 * Fallback library (gateway without documents.library): documents.tree
 * nodes + ideas.list, typed with the shared inference.
 */
export function clientLibrary(
  nodes: readonly DocSummary[],
  ideas: readonly LibraryIdeaLike[],
  types: readonly DocTypeDef[],
  filter: LibraryFilter = {},
): LibraryResult {
  const docs = nodes
    .filter((n) => n.kind !== "folder" && !n.deletedAt)
    .map((n) => ({ node: n as unknown as DocNode, path: n.path }));
  return buildLibrary({ docs, ideas: [...ideas], types: [...types] }, filter);
}

/** Default title for a new item of a type. */
export function newTitleFor(t: DocTypeDef, now = new Date()): string {
  if (t.id === "journal") return `Journal · ${now.toISOString().slice(0, 10)}`;
  if (t.id === "meeting") return `Meeting · ${now.toISOString().slice(0, 10)}`;
  if (t.id === "idea") return "New idea";
  return `Untitled ${t.label.split(" /")[0]!.toLowerCase()}`;
}

/** Icon names offered when creating / re-iconing a type (all exist in ui/src/ui/icons.ts). */
export const TYPE_ICON_CHOICES = [
  "fileText",
  "penLine",
  "lightbulb",
  "users",
  "book",
  "barChart",
  "clipboard",
  "fileCode",
  "briefcase",
  "calendar",
  "target",
  "layers",
  "terminal",
  "tag",
  "star",
  "flame",
  "rocket",
  "crown",
  "globe",
  "mail",
  "dollarSign",
  "shield",
  "database",
  "image",
  "video",
  "mic",
  "brain",
  "sparkles",
  "house",
  "wrench",
] as const;

export const TYPE_COLOR_CHOICES = [
  "#d9b45f",
  "#f3c623",
  "#e08a5f",
  "#e06a6a",
  "#c98fb8",
  "#9f8cf0",
  "#5fb3d9",
  "#4fc1c9",
  "#7cc68d",
  "#a3c95f",
  "#c9c3b6",
  "#8fa3b8",
] as const;

/** Move `id` one step up/down in an ordered id list (manage-types reorder). */
export function moveInOrder(ids: readonly string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** A node's type id: stored, else inferred with the shared rules (older gateways send no `type`). */
export function docTypeOf(n: DocSummary, types: readonly DocTypeDef[]): string | null {
  if (n.kind === "folder") return null;
  if (n.type) return n.type;
  return effectiveDocType(n as unknown as DocNode, [...types]).type;
}

/** Client-side cross-type match (title / preview / tags / category), all words must hit. */
export function matchesQuery(item: LibraryItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${item.title}\n${item.preview ?? ""}\n${(item.tags ?? []).join(" ")}\n${item.category ?? ""}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
