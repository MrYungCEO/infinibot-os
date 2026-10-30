/**
 * Object covers — Notion-style cover images for KIS business objects.
 *
 * A cover is a single image (or animated GIF) attached to one business object,
 * keyed by `(objectType, objectId)`. Two sources are supported and normalized
 * behind one record:
 *
 *   • `upload` — the bytes live under `<state-dir>/files/covers/<type>/<id>/<sha256><ext>`
 *     (the same files root `files.download` serves from, exactly like issue
 *     screenshots and kanban attachments), and `path` is set.
 *   • `link`   — an external image/GIF URL, and `url` is set.
 *
 * Deliberately generic: any object type (opportunity / project / client / …)
 * can carry a cover without touching that object's own store or schema, so the
 * feature composes with the per-object surfaces instead of forking them.
 */

/** Object types that may carry a cover. Free-form by design (a string), but the
 *  KIS Phase 1 objects are enumerated for validation + UI convenience. */
export const COVER_OBJECT_TYPES = [
  "opportunity",
  "project",
  "client",
  "product",
  "person",
  "decision",
  "risk",
  "commitment",
] as const;
export type CoverObjectType = (typeof COVER_OBJECT_TYPES)[number];

export type CoverSource = "upload" | "link";

/** A fully-materialized cover record as stored + returned by the store. */
export interface ObjectCover {
  id: string;
  objectType: CoverObjectType | string;
  objectId: string;
  /** Where the image came from. */
  source: CoverSource;
  /** External URL — set when `source === "link"`, else "". */
  url: string;
  /** Files-root-relative path — set when `source === "upload"`, else "". */
  path: string;
  /** Display name (original filename, or the link's basename). */
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /**
   * Vertical focal point of the banner crop, 0–100 (Notion's "reposition").
   * 50 = centered. Persisted so a chosen crop survives reloads.
   */
  positionY: number;
  createdAt: number;
  updatedAt: number;
}

/** Params accepted when setting a cover from an external image/GIF URL. */
export interface CoverSetLinkParams {
  objectType: string;
  objectId: string;
  url: string;
  name?: string;
  positionY?: number;
}

/** Params accepted when persisting an uploaded cover (post file-write). */
export interface CoverSetUploadParams {
  objectType: string;
  objectId: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  positionY?: number;
}

export interface CoverQueryParams {
  objectType: string;
  objectId: string;
}

/** Batch lookup for card grids — one round-trip for a whole board. */
export interface CoverListParams {
  objectType: string;
  /** When omitted, every cover for the type is returned. */
  objectIds?: string[];
}
