// Shared slug / deep-link utilities for dynamic entities (projects, tasks,
// notes, clients, generic database rows).
//
// A slug encodes BOTH a human-readable name and the entity id, joined by a
// double-dash separator:  "my-cool-project--<id>".  This lets resolveSlug()
// recover the id even when the entity store has not loaded yet (fallback path),
// while keeping URLs readable.  Pure-id and pure-name slugs are also accepted.

export type EntityKind =
  | "project"
  | "task"
  | "note"
  | "client"
  | "database"
  | "generic";

/** Separator between the human-readable name part and the embedded id. */
export const SLUG_ID_SEP = "--";

const MAX_NAME_LEN = 60;

/** Turn an arbitrary display name into a URL-safe kebab token (no id). */
export function slugifyName(input: string): string {
  if (!input) return "item";
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/g, "");
  return cleaned || "item";
}

/**
 * Deterministic slug for an entity. Combines a readable name with the id so the
 * id can always be recovered from the URL.  If no id is provided, returns just
 * the name token.
 */
export function slugify(name: string, id?: string | null): string {
  const namePart = slugifyName(name || "");
  const idPart = String(id ?? "").trim();
  if (!idPart) return namePart;
  return `${namePart}${SLUG_ID_SEP}${idPart}`;
}

/** Extract the embedded id from a slug, or null if none is encoded. */
export function idFromSlug(slug: string): string | null {
  if (!slug) return null;
  const decoded = safeDecode(slug);
  const idx = decoded.lastIndexOf(SLUG_ID_SEP);
  if (idx >= 0) {
    const id = decoded.slice(idx + SLUG_ID_SEP.length).trim();
    return id || null;
  }
  return null;
}

/** Extract the human-readable name part of a slug (without the embedded id). */
export function nameFromSlug(slug: string): string {
  const decoded = safeDecode(slug || "");
  const idx = decoded.lastIndexOf(SLUG_ID_SEP);
  return idx >= 0 ? decoded.slice(0, idx) : decoded;
}

export type EntityRef = { id: string; name?: string };

/**
 * Resolve a slug back to a concrete entity.  `candidates` is the currently
 * loaded store for that kind (id + optional name).  Resolution order:
 *   1. Embedded id → match in store (or return { id } even if not loaded).
 *   2. Exact id match.
 *   3. Full-slug match (slugify(name,id)).
 *   4. Name-token match (slugifyName(name)).
 * Returns null only when nothing matches AND no id could be recovered.
 *
 * The `kind` param is accepted for API symmetry / future per-kind resolution;
 * resolution itself is store-driven.
 */
export function resolveSlug(
  kind: EntityKind,
  slug: string,
  candidates: readonly EntityRef[] = [],
): EntityRef | null {
  if (!slug) return null;
  void kind;
  const decoded = safeDecode(slug);

  // 1. Embedded id.
  const embeddedId = idFromSlug(decoded);
  if (embeddedId) {
    const byId = candidates.find((c) => c.id === embeddedId);
    if (byId) return byId;
    return { id: embeddedId }; // fallback: id known, entity not loaded yet
  }

  // 2. Exact id.
  const exact = candidates.find((c) => c.id === decoded);
  if (exact) return exact;

  // 3. Full-slug match.
  const bySlug = candidates.find(
    (c) => slugify(c.name || "", c.id) === decoded,
  );
  if (bySlug) return bySlug;

  // 4. Name-token match.
  const namePart = nameFromSlug(decoded);
  const byName = candidates.find(
    (c) => slugifyName(c.name || "") === namePart,
  );
  return byName ?? null;
}

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}
