/**
 * Keep an item's project association visible everywhere it is read.
 *
 * Two relation indexes exist and different surfaces read different ones:
 *   - objrel (src/relations/store.ts) — typed edges the knowledge graph and
 *     ideas.get read (idea_about_project, project_has_task).
 *   - entity relations (src/databases/relations-store.ts, relations.db) — the
 *     bidirectional pairs the web project page's Related panel lists
 *     (relations.list {type:"project", peerType:"note"}).
 *
 * The item's own projectId / projectIds stays the source of truth; these are
 * indexes, so every write here is best-effort and never fails the caller.
 */

import { resolveStateDir } from "../config/paths.js";

export type ProjectLinkKind = "idea" | "note" | "task";

export type EntityLinker = {
  link(a: { type: string; id: string }, b: { type: string; id: string }): void;
  unlink(a: { type: string; id: string }, b: { type: string; id: string }): void;
};

export type ObjrelLinker = {
  link(edge: {
    fromType: string;
    fromId: string;
    edge: string;
    toType: string;
    toId: string;
    createdBy?: string;
  }): void;
  unlink(edge: { fromType: string; fromId: string; toType: string; toId: string }): void;
};

/** relations.db pairs (web project page). Null when better-sqlite3 is unavailable. */
export async function defaultEntityLinker(stateDir?: string): Promise<EntityLinker | null> {
  try {
    const rs = await import("../databases/relations-store.js");
    const dir = stateDir || resolveStateDir();
    return {
      link: (a, b) => rs.linkEntities(dir, a, b),
      unlink: (a, b) => rs.unlinkEntities(dir, a, b),
    };
  } catch {
    return null;
  }
}

function edgeFor(kind: ProjectLinkKind, itemId: string, projectId: string) {
  // ideas point at the project; the project contains tasks / notes.
  if (kind === "idea")
    return {
      fromType: "idea",
      fromId: itemId,
      edge: "idea_about_project",
      toType: "project",
      toId: projectId,
    };
  return {
    fromType: "project",
    fromId: projectId,
    edge: kind === "task" ? "project_has_task" : "relates_to",
    toType: kind,
    toId: itemId,
  };
}

function quiet(fn: () => void): void {
  try {
    fn();
  } catch {
    /* indexes only */
  }
}

/**
 * Bring both indexes in line with an item's project change: unlink projects
 * it left, link projects it joined. `before`/`after` are project id lists.
 */
export function syncProjectLinks(
  p: {
    kind: ProjectLinkKind;
    id: string;
    before: Array<string | undefined | null>;
    after: Array<string | undefined | null>;
    createdBy?: string;
  },
  linkers: { objrel?: ObjrelLinker | null; entity?: EntityLinker | null },
): { linked: string[]; unlinked: string[] } {
  const clean = (xs: Array<string | undefined | null>) =>
    [...new Set(xs.filter((x): x is string => typeof x === "string" && !!x.trim()))].map((x) =>
      x.trim(),
    );
  const before = clean(p.before);
  const after = clean(p.after);
  const unlinked = before.filter((x) => !after.includes(x));
  const linked = after.filter((x) => !before.includes(x));
  const item = { type: p.kind, id: p.id };
  for (const pid of unlinked) {
    const e = edgeFor(p.kind, p.id, pid);
    quiet(() => linkers.objrel?.unlink(e));
    quiet(() => linkers.entity?.unlink({ type: "project", id: pid }, item));
  }
  // Re-assert links for every current project (idempotent) so an item saved
  // before this sync existed heals on its next edit.
  for (const pid of after) {
    const e = edgeFor(p.kind, p.id, pid);
    quiet(() => linkers.objrel?.link({ ...e, createdBy: p.createdBy ?? "capture" }));
    quiet(() => linkers.entity?.link({ type: "project", id: pid }, item));
  }
  return { linked, unlinked };
}

// ── clients ───────────────────────────────────────────────────────────────────

export type ClientLinkKind = ProjectLinkKind | "project";

/**
 * Same as syncProjectLinks, for an item's CRM client. The client page
 * (Business HQ › Clients) lists notes/projects from relations.db and every
 * typed edge from objrel; the knowledge graph draws the objrel edge between
 * the client node and the item. Edge: client --relates_to--> item (the shape
 * the existing client↔project links already use).
 */
export function syncClientLinks(
  p: {
    kind: ClientLinkKind;
    id: string;
    before: Array<string | undefined | null>;
    after: Array<string | undefined | null>;
    createdBy?: string;
  },
  linkers: { objrel?: ObjrelLinker | null; entity?: EntityLinker | null },
): { linked: string[]; unlinked: string[] } {
  const clean = (xs: Array<string | undefined | null>) =>
    [...new Set(xs.filter((x): x is string => typeof x === "string" && !!x.trim()))].map((x) =>
      x.trim(),
    );
  const before = clean(p.before);
  const after = clean(p.after);
  const unlinked = before.filter((x) => !after.includes(x));
  const linked = after.filter((x) => !before.includes(x));
  const item = { type: p.kind, id: p.id };
  const edge = (cid: string) => ({
    fromType: "client",
    fromId: cid,
    edge: "relates_to",
    toType: p.kind,
    toId: p.id,
  });
  for (const cid of unlinked) {
    quiet(() => linkers.objrel?.unlink(edge(cid)));
    quiet(() => linkers.entity?.unlink({ type: "client", id: cid }, item));
  }
  for (const cid of after) {
    quiet(() => linkers.objrel?.link({ ...edge(cid), createdBy: p.createdBy ?? "capture" }));
    quiet(() => linkers.entity?.link({ type: "client", id: cid }, item));
  }
  return { linked, unlinked };
}
