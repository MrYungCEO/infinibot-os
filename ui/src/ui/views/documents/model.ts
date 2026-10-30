/**
 * Documents workspace — client-side types + pure tree helpers (no DOM, unit-tested).
 */

export type DocKind = "folder" | "doc" | "file";
export type DocPropertyValue = string | number | boolean | string[] | null;

export interface DocColumn {
  key: string;
  name: string;
  type: string;
}

export interface DocFileInfo {
  name: string;
  mime: string;
  size: number;
  ext: string;
  extractStatus: "ok" | "none" | "error" | "pending";
  extractError?: string;
  extractedChars?: number;
}

export interface DocSummary {
  id: string;
  kind: DocKind;
  title: string;
  parentId: string | null;
  /** Document type id (stored, or inferred when `typeInferred`). Folders have none. */
  type?: string;
  typeInferred?: boolean;
  category?: string;
  icon?: string;
  favorite?: boolean;
  tags?: string[];
  updatedAt: string;
  createdAt: string;
  sortOrder?: number;
  source?: { type: string; id?: string; url?: string; syncedAt?: string };
  preview?: string;
  bodyLength?: number;
  properties?: Record<string, DocPropertyValue>;
  schema?: DocColumn[];
  view?: { mode: "list" | "table" | "grid"; sortBy?: string; sortDir?: "asc" | "desc" };
  file?: DocFileInfo;
  deletedAt?: string;
  path?: string;
}

export interface DocDetail {
  node: DocSummary;
  body?: string;
  extracted?: string;
  extractedTruncated?: boolean;
  breadcrumbs: Array<{ id: string; title: string; kind: DocKind }>;
  children?: DocSummary[];
  backlinks: Array<{ id: string; title: string }>;
  outgoing: Array<{ target: string; id: string | null; title: string | null }>;
}

export type TreeSort = "manual" | "name" | "updated";

export interface TreeIndex {
  byId: Map<string, DocSummary>;
  children: Map<string | null, DocSummary[]>;
}

export function buildTreeIndex(nodes: DocSummary[], sort: TreeSort = "manual"): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, DocSummary[]>();
  for (const n of nodes) {
    // Orphans (parent missing/trashed) surface at the root instead of vanishing.
    const key = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    const arr = children.get(key) ?? [];
    arr.push(n);
    children.set(key, arr);
  }
  for (const arr of children.values()) arr.sort(comparator(sort));
  return { byId, children };
}

export function comparator(sort: TreeSort): (a: DocSummary, b: DocSummary) => number {
  return (a, b) => {
    if (a.kind === "folder" && b.kind !== "folder") return -1;
    if (b.kind === "folder" && a.kind !== "folder") return 1;
    if (sort === "name") return a.title.localeCompare(b.title, undefined, { numeric: true });
    if (sort === "updated") return String(b.updatedAt).localeCompare(String(a.updatedAt));
    const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return sa !== sb ? sa - sb : a.title.localeCompare(b.title);
  };
}

/** Ancestor ids (root first) — used to auto-expand the tree to a selection. */
export function ancestorsOf(index: TreeIndex, id: string): string[] {
  const out: string[] = [];
  let cur = index.byId.get(id);
  let guard = 0;
  while (cur?.parentId && guard++ < 256) {
    out.unshift(cur.parentId);
    cur = index.byId.get(cur.parentId);
  }
  return out;
}

/** True when `target` is `id` or inside it (drop target validity for folders). */
export function isInside(index: TreeIndex, id: string, target: string | null): boolean {
  let cur: string | null = target;
  let guard = 0;
  while (cur && guard++ < 256) {
    if (cur === id) return true;
    cur = index.byId.get(cur)?.parentId ?? null;
  }
  return false;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export type PreviewKind = "pdf" | "image" | "video" | "audio" | "text" | "none";

export function previewKind(file: DocFileInfo | undefined): PreviewKind {
  if (!file) return "none";
  const m = file.mime;
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (file.extractStatus === "ok") return "text";
  return "none";
}

export function fileIcon(n: DocSummary): string {
  if (n.icon) return n.icon;
  if (n.kind === "folder") return n.schema?.length ? "🗃️" : "📁";
  if (n.kind === "doc") return "📄";
  const k = previewKind(n.file);
  return k === "pdf" ? "📕" : k === "image" ? "🖼️" : k === "video" ? "🎬" : k === "audio" ? "🎧" : "📎";
}

/** Render a property value for table cells. */
/** `doc:<id>` — an imported relation/link pointing at another document. */
export const DOC_REF_RE = /^doc:([a-zA-Z0-9_-]+)$/;

/** Doc ids referenced by a property value (relations imported from Notion/Obsidian). */
export function docRefIds(v: DocPropertyValue | undefined): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  const out: string[] = [];
  for (const x of list) {
    const m = typeof x === "string" ? DOC_REF_RE.exec(x.trim()) : null;
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Display text for a property value. Pass `titleOf` to show `doc:<id>`
 * relation refs as the target document's title instead of the raw ref.
 */
export function formatProp(
  v: DocPropertyValue | undefined,
  titleOf?: (id: string) => string | undefined,
): string {
  if (v == null) return "";
  const show = (x: unknown): string => {
    const m = typeof x === "string" ? DOC_REF_RE.exec(x.trim()) : null;
    return m && titleOf ? (titleOf(m[1]!) ?? String(x)) : String(x);
  };
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (typeof v === "boolean") return v ? "✓" : "";
  return show(v);
}

/** Columns for a folder table view: schema first, else union of child property keys. */
export function tableColumns(folder: DocSummary | undefined, rows: DocSummary[]): DocColumn[] {
  if (folder?.schema?.length) return folder.schema.filter((c) => c.type !== "title");
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.properties ?? {})) keys.add(k);
  return [...keys].map((k) => ({ key: k, name: k, type: "text" }));
}

export function sortRows(rows: DocSummary[], by: string | undefined, dir: "asc" | "desc" = "asc"): DocSummary[] {
  if (!by) return rows;
  const sign = dir === "desc" ? -1 : 1;
  const val = (r: DocSummary) =>
    by === "__title" ? r.title : by === "__updated" ? r.updatedAt : formatProp(r.properties?.[by]);
  return [...rows].sort((a, b) => sign * val(a).localeCompare(val(b), undefined, { numeric: true }));
}
