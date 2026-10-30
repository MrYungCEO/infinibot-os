/**
 * Where capture's CRM clients come from (I/O side of client-match.ts).
 *
 *   - loadCaptureClients()  every client of the ACTIVE business from the
 *     agency store (agency.db — the list Business HQ › Clients shows). The
 *     "default" agency is only used when the active one is empty, so a
 *     single-business install still works.
 *   - projectClientRefs()   the clients a board project is linked to, from
 *     both relation indexes (relations.db pairs — what the project page and
 *     the Notion "Clients" bridge use — and objrel client→project edges).
 *   - linkedClientIds()     the clients an idea / note / task / project is
 *     currently linked to (objrel client --relates_to--> item), used to
 *     un-link the old client when it changes.
 *
 * Reads are cached for a few seconds: capture.structure runs the matcher
 * over ~1300 rows per utterance and the picker asks for the same list.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { clientsOfProject, toCaptureClients, type CaptureClient } from "./client-match.js";

const TTL_MS = 15_000;
let cache: { key: string; at: number; clients: CaptureClient[]; agencyId: string } | null = null;

/** The active business id (business.json), which is the agency id of its clients. */
export function activeAgencyId(stateDir = resolveStateDir()): string {
  try {
    const p = join(stateDir, "business.json");
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8")) as { activeBusinessId?: unknown };
      if (typeof j.activeBusinessId === "string" && j.activeBusinessId.trim())
        return j.activeBusinessId.trim();
    }
  } catch {
    /* fall through */
  }
  return "default";
}

export async function loadCaptureClients(
  opts: { stateDir?: string; agencyId?: string; fresh?: boolean } = {},
): Promise<{ clients: CaptureClient[]; agencyId: string }> {
  const stateDir = opts.stateDir || resolveStateDir();
  const wanted = opts.agencyId?.trim() || activeAgencyId(stateDir);
  const key = `${stateDir}::${wanted}`;
  if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < TTL_MS)
    return { clients: cache.clients, agencyId: cache.agencyId };
  const { getAgencyOperationsStore } = await import("../agency-operations/store.js");
  const store = getAgencyOperationsStore(stateDir);
  let agencyId = wanted;
  let rows = store.listClients(agencyId);
  if (!rows.length && agencyId !== "default") {
    agencyId = "default";
    rows = store.listClients(agencyId);
  }
  const clients = toCaptureClients(rows);
  cache = { key, at: Date.now(), clients, agencyId };
  return { clients, agencyId };
}

export function invalidateCaptureClients(): void {
  cache = null;
}

type ObjrelLister = {
  list(q: { fromType?: string; fromId?: string; toType?: string; toId?: string }): Array<{
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
  }>;
};

async function objrelStore(stateDir?: string): Promise<ObjrelLister | null> {
  try {
    const { getRelationsStore } = await import("../relations/store.js");
    return getRelationsStore(stateDir) as unknown as ObjrelLister;
  } catch {
    return null;
  }
}

/** Client ids linked to a board project in either relation index. */
export async function projectClientRefs(projectId: string, stateDir?: string): Promise<string[]> {
  const dir = stateDir || resolveStateDir();
  const out = new Set<string>();
  try {
    const { listRelations } = await import("../databases/relations-store.js");
    for (const r of listRelations(dir, { type: "project", id: projectId }, "client")) out.add(r.id);
  } catch {
    /* index unavailable */
  }
  try {
    const rel = await objrelStore(stateDir);
    for (const r of rel?.list({ fromType: "client", toType: "project", toId: projectId }) ?? [])
      out.add(r.fromId);
    for (const r of rel?.list({ fromType: "project", fromId: projectId, toType: "client" }) ?? [])
      out.add(r.toId);
  } catch {
    /* index unavailable */
  }
  return [...out];
}

/** Client ids currently linked to an item (objrel client → item, relations.db pairs). */
export async function linkedClientIds(
  kind: string,
  id: string,
  stateDir?: string,
): Promise<string[]> {
  const out = new Set<string>();
  try {
    const rel = await objrelStore(stateDir);
    for (const r of rel?.list({ fromType: "client", toType: kind, toId: id }) ?? [])
      out.add(r.fromId);
  } catch {
    /* index unavailable */
  }
  try {
    const { listRelations } = await import("../databases/relations-store.js");
    for (const r of listRelations(stateDir || resolveStateDir(), { type: kind, id }, "client"))
      out.add(r.id);
  } catch {
    /* index unavailable */
  }
  return [...out];
}

/**
 * project id → the project's client, for every project at once: relations.db
 * client↔project pairs, objrel client→project edges, then the project's own
 * Notion "Clients" relation (`clientNotionIds` on kanban rows). Sync lookups
 * afterwards, so capture's draft guard can call it freely.
 */
export async function projectClientResolver(
  clients: CaptureClient[],
  projects: Array<{ id: string; clientNotionIds?: string[] }>,
  stateDir?: string,
): Promise<(projectId: string) => CaptureClient | undefined> {
  const linked = new Map<string, string[]>();
  const add = (pid: string, cid: string) => {
    const xs = linked.get(pid) ?? [];
    if (!xs.includes(cid)) xs.push(cid);
    linked.set(pid, xs);
  };
  try {
    const { listPairsByType } = await import("../databases/relations-store.js");
    for (const r of listPairsByType(stateDir || resolveStateDir(), "project", "client"))
      add(r.aId, r.bId);
  } catch {
    /* index unavailable */
  }
  try {
    const rel = await objrelStore(stateDir);
    for (const r of rel?.list({ fromType: "client", toType: "project" }) ?? [])
      add(r.toId, r.fromId);
  } catch {
    /* index unavailable */
  }
  const notion = new Map(projects.map((p) => [p.id, p.clientNotionIds ?? []]));
  return (projectId) =>
    clientsOfProject(clients, {
      linkedIds: linked.get(projectId) ?? [],
      notionIds: notion.get(projectId) ?? [],
    })[0];
}
