/**
 * Slug helpers for databases and database rows ("pages").
 *
 * URL shape:
 *   /<database-slug>                  → the database itself
 *   /<database-slug>/<page-slug>      → a specific row (page) within it
 *
 * Slugs are stored alongside the canonical id; lookups accept either.
 * A slug is unique within its scope (databases globally, rows per-database).
 * Auto-generated from name/title on create when not supplied.
 */

const MAX_SLUG_LEN = 80;

export function slugify(input: string): string {
  if (!input) return "untitled";
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN);
  return cleaned || "untitled";
}

/** True if the value already looks like a usable slug (skip re-slugify). */
export function isSlug(input: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(input) && input.length <= MAX_SLUG_LEN;
}

/** Append "-2", "-3"… until `isTaken` returns false. */
export function uniqueSlug(base: string, isTaken: (candidate: string) => boolean): string {
  const start = base || "untitled";
  if (!isTaken(start)) return start;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${start}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Fallback — extremely unlikely
  return `${start}-${Date.now()}`;
}

/**
 * Parse a path or URL into (databaseSlug, pageSlug?).
 *   "https://app.example/db/my-db/page-one" → ["my-db", "page-one"]
 *   "/my-db"                                → ["my-db"]
 *   "my-db/page-one"                        → ["my-db", "page-one"]
 *   "db_abc123"                             → ["db_abc123"]   (id form, fine)
 * Strips a leading "db/" segment so URLs the UI emits like "/db/<slug>" still parse.
 */
export function parseDatabaseUrl(input: string): { databaseSlug: string; pageSlug?: string } | null {
  let path = input.trim();
  if (!path) return null;
  try {
    const u = new URL(path);
    path = u.pathname;
  } catch {
    /* not an absolute URL — treat as plain path */
  }
  path = path.replace(/^\/+/, "").replace(/^db\//, "").replace(/\/+$/, "");
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const [databaseSlug, pageSlug] = parts;
  return pageSlug ? { databaseSlug, pageSlug } : { databaseSlug };
}
