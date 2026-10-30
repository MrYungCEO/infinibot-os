/**
 * Client-side document-versioning helpers — mirror of src/notes/versioning.ts.
 *
 * The UI collapses families itself so it works whether or not the gateway has
 * been restarted to serve the new server-side collapse: when the note rows
 * carry `documentFamilyId` / `version` the families fold; when they don't
 * (pre-restart, or for non-versioned notes) every note passes through
 * untouched and the view renders exactly as before.
 */

export interface VersionedNote {
  id: string;
  name: string;
  updatedAt?: string;
  createdAt?: string;
  documentFamilyId?: string;
  version?: number;
  versionLabel?: string;
  supersededBy?: string;
  supersedes?: string;
  isCurrent?: boolean;
  familyVersionCount?: number;
}

export function versionOf(n: { version?: number }): number {
  return typeof n.version === "number" && Number.isFinite(n.version) ? n.version : 0;
}

export function sortVersionsDesc<T extends VersionedNote>(members: T[]): T[] {
  return [...members].sort((a, b) => {
    const dv = versionOf(b) - versionOf(a);
    if (dv !== 0) return dv;
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

/** Index notes by family id. */
export function familyMap<T extends VersionedNote>(notes: T[]): Map<string, T[]> {
  const families = new Map<string, T[]>();
  for (const n of notes) {
    if (!n.documentFamilyId) continue;
    const arr = families.get(n.documentFamilyId) ?? [];
    arr.push(n);
    families.set(n.documentFamilyId, arr);
  }
  return families;
}

/** Annotate each note with computed isCurrent / supersedes / family count. */
export function annotateFamilies<T extends VersionedNote>(notes: T[]): T[] {
  const families = familyMap(notes);
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

/** Collapse families to their current member; standalone notes pass through. */
export function collapseFamilies<T extends VersionedNote>(annotated: T[]): T[] {
  const families = familyMap(annotated);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const n of annotated) {
    if (!n.documentFamilyId) {
      out.push(n);
      continue;
    }
    if (seen.has(n.documentFamilyId)) continue;
    seen.add(n.documentFamilyId);
    const members = sortVersionsDesc(families.get(n.documentFamilyId) ?? [n]);
    out.push(members[0] ?? n);
  }
  return out;
}

/** Members of a family newest-first (or [note] if it has no family). */
export function familyMembers<T extends VersionedNote>(all: T[], note: T): T[] {
  if (!note.documentFamilyId) return [note];
  return sortVersionsDesc(all.filter((n) => n.documentFamilyId === note.documentFamilyId));
}
