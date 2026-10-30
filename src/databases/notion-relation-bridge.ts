/**
 * Bidirectional bridge between the local relations store (clients ↔
 * projects) and the matching Notion relation properties on the
 * Projects + Clients databases.
 *
 * Kept as a thin helper module so the existing sync engines
 * (kanban-store-ops.ts mirror-out + notion-bidirectional-sync.ts
 * apply-in) can call into it without growing more conditional plumbing.
 * No-ops when Notion isn't configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { linkEntities, listRelations, unlinkEntities } from "./relations-store.js";

interface ClientRecordLike {
  id: string;
  notion_page_id?: string;
}

interface BusinessProfileLike {
  id: string;
  clients?: ClientRecordLike[];
}

interface BusinessStateLike {
  businesses?: BusinessProfileLike[];
}

function readBusinessState(): BusinessStateLike | null {
  try {
    const p = join(resolveStateDir(), "business.json");
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as BusinessStateLike;
  } catch {
    return null;
  }
}

/**
 * Map local clientId → Notion page id by walking every business
 * profile. Returns `null` when the client has no Notion link (likely
 * a manually-created client) so callers can skip writing relations
 * that wouldn't round-trip.
 */
function buildLocalClientToNotionMap(): Map<string, string> {
  const map = new Map<string, string>();
  const state = readBusinessState();
  if (!state?.businesses) return map;
  for (const biz of state.businesses) {
    for (const c of biz.clients ?? []) {
      if (typeof c.id === "string" && typeof c.notion_page_id === "string" && c.notion_page_id) {
        map.set(c.id, c.notion_page_id);
      }
    }
  }
  return map;
}

/** Inverse map: Notion page id → local clientId. */
function buildNotionClientToLocalMap(): Map<string, string> {
  const map = new Map<string, string>();
  const state = readBusinessState();
  if (!state?.businesses) return map;
  for (const biz of state.businesses) {
    for (const c of biz.clients ?? []) {
      if (typeof c.id === "string" && typeof c.notion_page_id === "string" && c.notion_page_id) {
        map.set(c.notion_page_id, c.id);
      }
    }
  }
  return map;
}

/**
 * Builds the Notion property payload for a project's `Clients`
 * relation property by reading the local relations store and mapping
 * client ids → Notion page ids. Returns `null` when there's nothing
 * to write (no relations OR no clients have notion ids).
 */
export function buildProjectClientsRelationProperty(
  projectId: string,
): { relation: Array<{ id: string }> } | null {
  const stateDir = resolveStateDir();
  const peers = listRelations(stateDir, { type: "project", id: projectId }, "client");
  if (!peers || peers.length === 0) return { relation: [] }; // clear if no peers
  const clientToNotion = buildLocalClientToNotionMap();
  const ids: Array<{ id: string }> = [];
  for (const p of peers) {
    const notionId = clientToNotion.get(p.id);
    if (notionId) ids.push({ id: notionId });
  }
  return ids.length > 0 ? { relation: ids } : { relation: [] };
}

/** Mirror of {@link buildProjectClientsRelationProperty} for the inverse direction. */
export function buildClientProjectsRelationProperty(
  clientId: string,
  /**
   * Lookup that resolves a local projectId to its Notion page id.
   * Supplied by the caller because the projects table is owned by the
   * kanban store which sits below this module — passing it as a
   * callback avoids a circular import.
   */
  resolveProjectNotionId: (projectId: string) => string | null,
): { relation: Array<{ id: string }> } | null {
  const stateDir = resolveStateDir();
  const peers = listRelations(stateDir, { type: "client", id: clientId }, "project");
  if (!peers) return { relation: [] };
  const ids: Array<{ id: string }> = [];
  for (const p of peers) {
    const notionId = resolveProjectNotionId(p.id);
    if (notionId) ids.push({ id: notionId });
  }
  return { relation: ids };
}

/**
 * Inbound: given a Notion page's properties bag for a project, read
 * the `Clients` relation and reconcile it with the local relations
 * store. Adds links for new pairings, removes ones that are no longer
 * in Notion. Notion entries without a matching local client are
 * dropped silently — the operator can pull the Clients DB separately
 * to populate them.
 */
export function applyProjectClientsRelationFromNotion(
  projectId: string,
  props: Record<string, unknown>,
  relationPropName = "Clients",
): { added: number; removed: number; skipped: number } {
  const stateDir = resolveStateDir();
  const prop = props[relationPropName] as
    | { type?: string; relation?: Array<{ id: string }> }
    | undefined;
  const result = { added: 0, removed: 0, skipped: 0 };
  if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) return result;

  const notionToLocal = buildNotionClientToLocalMap();
  const wantClientIds = new Set<string>();
  for (const ref of prop.relation) {
    const localId = notionToLocal.get(ref.id);
    if (localId) wantClientIds.add(localId);
    else result.skipped += 1;
  }

  const existing = new Set(
    (listRelations(stateDir, { type: "project", id: projectId }, "client") ?? []).map((p) => p.id),
  );

  for (const want of wantClientIds) {
    if (!existing.has(want)) {
      linkEntities(stateDir, { type: "project", id: projectId }, { type: "client", id: want });
      result.added += 1;
    }
  }
  for (const have of existing) {
    if (!wantClientIds.has(have)) {
      unlinkEntities(stateDir, { type: "project", id: projectId }, { type: "client", id: have });
      result.removed += 1;
    }
  }
  return result;
}

/** Mirror of {@link applyProjectClientsRelationFromNotion} for the Clients DB. */
export function applyClientProjectsRelationFromNotion(
  clientId: string,
  props: Record<string, unknown>,
  resolveLocalProjectByNotionId: (notionId: string) => string | null,
  relationPropName = "Projects",
): { added: number; removed: number; skipped: number } {
  const stateDir = resolveStateDir();
  const prop = props[relationPropName] as
    | { type?: string; relation?: Array<{ id: string }> }
    | undefined;
  const result = { added: 0, removed: 0, skipped: 0 };
  if (!prop || prop.type !== "relation" || !Array.isArray(prop.relation)) return result;

  const wantProjectIds = new Set<string>();
  for (const ref of prop.relation) {
    const localId = resolveLocalProjectByNotionId(ref.id);
    if (localId) wantProjectIds.add(localId);
    else result.skipped += 1;
  }

  const existing = new Set(
    (listRelations(stateDir, { type: "client", id: clientId }, "project") ?? []).map((p) => p.id),
  );

  for (const want of wantProjectIds) {
    if (!existing.has(want)) {
      linkEntities(stateDir, { type: "client", id: clientId }, { type: "project", id: want });
      result.added += 1;
    }
  }
  for (const have of existing) {
    if (!wantProjectIds.has(have)) {
      unlinkEntities(stateDir, { type: "client", id: clientId }, { type: "project", id: have });
      result.removed += 1;
    }
  }
  return result;
}
