/**
 * Document versioning helpers — pure functions shared by the notes gateway
 * handlers regardless of storage mode (legacy file store or database role).
 *
 * A "family" is a set of notes sharing the same `documentFamilyId`. The
 * member with the highest `version` is the current one. The UI collapses a
 * family to its current member by default; prior versions stay individually
 * accessible.
 */

import type { Note, NoteListItem, NoteMeta } from "./types.js";

export type FamilyMember = NoteMeta & { body?: string; preview?: string; bodyLength?: number };

/** Numeric version for sorting; notes without a version sort as 0. */
export function versionOf(n: { version?: number }): number {
  return typeof n.version === "number" && Number.isFinite(n.version) ? n.version : 0;
}

/** Sort a family's members newest-first (highest version, then newest updatedAt). */
export function sortVersionsDesc<T extends FamilyMember>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const dv = versionOf(b) - versionOf(a);
    if (dv !== 0) return dv;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

/** The current (highest-version) member of a family, or null. */
export function currentOf<T extends FamilyMember>(members: T[]): T | null {
  const sorted = sortVersionsDesc(members);
  return sorted[0] ?? null;
}

/**
 * Annotate notes with computed family fields (isCurrent, supersededBy /
 * supersedes, family count) WITHOUT persisting. Returns a new array.
 * Notes with no `documentFamilyId` pass through untouched.
 */
export function annotateFamilies<T extends FamilyMember>(
  notes: T[],
): Array<T & { familyVersionCount?: number }> {
  const families = new Map<string, T[]>();
  for (const n of notes) {
    if (!n.documentFamilyId) continue;
    const arr = families.get(n.documentFamilyId) ?? [];
    arr.push(n);
    families.set(n.documentFamilyId, arr);
  }

  return notes.map((n) => {
    if (!n.documentFamilyId) return n;
    const sorted = sortVersionsDesc(families.get(n.documentFamilyId) ?? [n]);
    const idx = sorted.findIndex((m) => m.id === n.id);
    const newer = idx > 0 ? sorted[idx - 1] : undefined;
    const older = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined;
    return {
      ...n,
      isCurrent: idx === 0,
      supersededBy: newer?.id,
      supersedes: older?.id,
      familyVersionCount: sorted.length,
    };
  });
}

/**
 * Collapse families to one entry each (the current version), leaving
 * standalone notes (no family) untouched. Preserves input order based on the
 * position of each family's current member / each standalone note.
 */
export function collapseFamilies<T extends FamilyMember & { familyVersionCount?: number }>(
  annotated: T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const n of annotated) {
    if (!n.documentFamilyId) {
      out.push(n);
      continue;
    }
    if (seen.has(n.documentFamilyId)) continue;
    seen.add(n.documentFamilyId);
    // Find the current member of this family within the list.
    const members = annotated.filter((m) => m.documentFamilyId === n.documentFamilyId);
    const current = currentOf(members) ?? n;
    out.push(current);
  }
  return out;
}

/** Next version number for a family given its existing members. */
export function nextVersion(members: Array<{ version?: number }>): number {
  let max = 0;
  for (const m of members) max = Math.max(max, versionOf(m));
  return max + 1;
}

/** Stable slug for a family id derived from a free-text name. */
export function familySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export type { Note, NoteListItem };
