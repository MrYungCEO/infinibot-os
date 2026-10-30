/**
 * Notes system types.
 * Notes are markdown-based documents with YAML frontmatter.
 */

export interface NoteMeta {
  /** Unique note ID (slug-style). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Tags for categorization and search. */
  tags?: string[];
  /** Agent that created/owns this note. */
  author?: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
  /** Category for grouping. */
  category?: string;
  /** Whether this note is pinned to the top. */
  pinned?: boolean;
  /** Optional array of related note IDs. */
  linkedTo?: string[];
  /** Kanban project ID if this note is linked to a project. */
  projectId?: string;
  /** CRM client (agency client id) this note is for. */
  clientId?: string;
  /** Review / follow-up date ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"); a log's date. */
  reviewOn?: string;
  /** Notion page ID if synced. */
  notionPageId?: string;
  /** Notion last sync timestamp. */
  notionSyncedAt?: string;

  // ── Document versioning ──────────────────────────────────────
  /**
   * Stable family slug grouping multiple versions of the same
   * conceptual document, e.g. `infinibot-competitor-analysis`.
   * When absent the note is a standalone document (renders as today).
   */
  documentFamilyId?: string;
  /** Monotonic version within the family (1, 2, 3 …). Higher = newer. */
  version?: number;
  /** Optional human label for this version, e.g. "Business OS reframe". */
  versionLabel?: string;
  /** Note id of the version that supersedes this one (denormalized). */
  supersededBy?: string;
  /** Note id of the version this one supersedes (denormalized). */
  supersedes?: string;
  /**
   * Whether this note is the current (highest-version) member of its
   * family. Computed by the versioning layer; persisted denormalized so
   * the UI can collapse families even before the new family RPCs are served.
   */
  isCurrent?: boolean;
}

export interface Note extends NoteMeta {
  /** Full markdown body (without frontmatter). */
  body: string;
}

export interface NoteListItem extends NoteMeta {
  /** First ~200 chars of body for preview. */
  preview: string;
  /** Character count of body. */
  bodyLength: number;
}

export interface NoteCreateParams {
  name: string;
  description?: string;
  tags?: string[];
  body: string;
  author?: string;
  category?: string;
  pinned?: boolean;
  linkedTo?: string[];
  /** Kanban project ID if this note is linked to a project. */
  projectId?: string;
  /** CRM client id this note is for. */
  clientId?: string;
  /** Review / follow-up date ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"). */
  reviewOn?: string;
  /** Optional custom ID (auto-generated from name if not provided). */
  id?: string;
  /** Notion page ID — set on creation so the note is immediately linkable. */
  notionPageId?: string;
  notionSyncedAt?: string;
  /** Document family slug for versioned documents. */
  documentFamilyId?: string;
  /** Version number within the family. */
  version?: number;
  /** Optional human label for this version. */
  versionLabel?: string;
}

export interface NoteUpdateParams {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  body?: string;
  category?: string;
  pinned?: boolean;
  linkedTo?: string[];
  projectId?: string;
  /** "" clears it. */
  clientId?: string;
  /** "" clears it. */
  reviewOn?: string;
  notionPageId?: string;
  notionSyncedAt?: string;
  documentFamilyId?: string;
  version?: number;
  versionLabel?: string;
  supersededBy?: string;
  supersedes?: string;
  isCurrent?: boolean;
}

export interface NoteSearchParams {
  query?: string;
  tags?: string[];
  author?: string;
  category?: string;
  pinned?: boolean;
  projectId?: string;
  /** Only notes for this CRM client. */
  clientId?: string;
  limit?: number;
  /** Filter to a single document family. */
  documentFamilyId?: string;
  /**
   * When false (default), collapse each document family to its current
   * (highest) version. When true, return every version individually.
   */
  includeAllVersions?: boolean;
}
