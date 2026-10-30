/**
 * Documents workspace types.
 *
 * A document workspace is a per-user tree of nodes:
 *   - folder: groups children; a folder imported from a Notion database also
 *     carries a `schema` (property columns) and a `view` (table/list/grid).
 *   - doc:    a markdown document (body stored as `docs/<id>.md`).
 *   - file:   an uploaded original (`files/<id>/original<ext>`) plus an
 *             extracted-text companion (`files/<id>/extracted.md`) so agents
 *             and search can read it.
 */

export type DocNodeKind = "folder" | "doc" | "file";

/** Simple JSON property value (Notion DB rows, frontmatter-style metadata). */
export type DocPropertyValue = string | number | boolean | string[] | null;

export type DocPropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "person"
  | "files"
  | "relation"
  | "createdAt"
  | "updatedAt";

export interface DocPropertyColumn {
  key: string;
  name: string;
  type: DocPropertyType;
}

export interface DocFolderView {
  mode: "list" | "table" | "grid";
  /** Column keys shown in table view (defaults to schema order). */
  visibleColumns?: string[];
  sortBy?: string;
  sortDir?: "asc" | "desc";
}

export interface DocSource {
  /** Where this node came from. Import idempotency is keyed on (type, id). */
  type: "note" | "notion" | "notion-zip" | "obsidian" | "upload" | "url" | "path";
  id?: string;
  url?: string;
  /** ISO timestamp of the last import/sync. */
  syncedAt?: string;
  /** Remote last-edited time at last sync (for update detection). */
  remoteEditedAt?: string;
  /** Import job/run that last wrote this node (lets an interrupted job resume without redoing work). */
  syncRun?: string;
  /** Content hash of the source file at last import (Obsidian re-sync skips unchanged notes). */
  hash?: string;
}

export interface DocFileInfo {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  ext: string;
  extractStatus: "ok" | "none" | "error" | "pending";
  extractError?: string;
  extractedChars?: number;
}

export interface DocNode {
  id: string;
  kind: DocNodeKind;
  title: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  author?: string;
  /** Document type id (doc-types.ts: built-in or custom). Unset = inferred at read time. */
  type?: string;
  /** Optional free-form category within the type (e.g. a client or area). */
  category?: string;
  tags?: string[];
  icon?: string;
  favorite?: boolean;
  /** Manual sort order among siblings (lower first). */
  sortOrder?: number;
  /** Soft-delete marker. Descendants of a deleted folder are hidden too. */
  deletedAt?: string;
  source?: DocSource;
  /** Doc: row properties (Notion DB row / imported frontmatter). */
  properties?: Record<string, DocPropertyValue>;
  /** Doc: body preview + length (maintained by the store). */
  preview?: string;
  bodyLength?: number;
  /** Folder: property columns (database folders). */
  schema?: DocPropertyColumn[];
  /** Folder: preferred view. */
  view?: DocFolderView;
  /** File: upload metadata. */
  file?: DocFileInfo;
}

export interface DocRevision {
  rev: string;
  at: string;
  title: string;
  bodyLength: number;
  author?: string;
}

export interface DocSearchHit {
  id: string;
  kind: DocNodeKind;
  title: string;
  parentId: string | null;
  path: string;
  snippet: string;
  score: number;
}

export interface DocCreateParams {
  kind: "doc" | "folder";
  title: string;
  parentId?: string | null;
  body?: string;
  author?: string;
  type?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  properties?: Record<string, DocPropertyValue>;
  schema?: DocPropertyColumn[];
  view?: DocFolderView;
  source?: DocSource;
  id?: string;
}

export interface DocUpdateParams {
  id: string;
  title?: string;
  body?: string;
  /** Document type id; "" clears it (back to inferred). */
  type?: string;
  /** Category; "" clears it. */
  category?: string;
  tags?: string[];
  icon?: string;
  favorite?: boolean;
  properties?: Record<string, DocPropertyValue>;
  schema?: DocPropertyColumn[];
  view?: DocFolderView;
  source?: DocSource;
  author?: string;
  /** Force a history snapshot even inside the coalescing window. */
  snapshot?: boolean;
}
