/**
 * Database-pack RPC handlers.
 *
 * Surface for the Business workspace's "Library" pane:
 *
 *   - business.packs.list                    → catalogue of packs
 *   - business.pack.install({businessId, packId})
 *       Idempotent: reuses any database whose system role is already mapped,
 *       creates the rest with the pack's default property schema, then
 *       resolves cross-database relation properties' targetDatabaseId so the
 *       fresh schema "just works" without a second pass.
 *
 * Pack definitions live in `src/business/database-packs.ts` so the agent and
 * any other callers can introspect packs without going through RPC.
 */
import { DatabasesStore, getDatabasesStore } from "../../databases/store.js";
import type { PropertyConfig, SystemRole } from "../../databases/types.js";
import {
  type DatabasePack,
  type PackDatabaseDef,
  getPack,
  listPacks,
} from "../../business/database-packs.js";
import type { GatewayRequestHandlers } from "./types.js";

function store(): DatabasesStore {
  return getDatabasesStore();
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

interface InstalledDatabase {
  role: SystemRole;
  databaseId: string;
  name: string;
  /** True if we created it just now; false if reused an existing role mapping. */
  created: boolean;
}

/**
 * Single pack-install pass:
 *   1. Walk databases in pack order. Skip-and-record any whose role is
 *      already mapped (we won't touch existing schemas).
 *   2. Create the remaining ones with the pack's default properties; bind
 *      the role mapping after.
 *   3. After everything's created, resolve cross-database `targetRole`
 *      relations into concrete `targetDatabaseId` values by updating the
 *      relation property's config in place.
 */
function installPack(s: DatabasesStore, pack: DatabasePack): InstalledDatabase[] {
  const result: InstalledDatabase[] = [];
  // role → resolved databaseId. Seeded with already-mapped roles so freshly
  // created relation targets find them in the same pass.
  const roleToDbId = new Map<SystemRole, string>();

  // Pass 1: map already-mapped roles.
  for (const def of pack.databases) {
    const existing = s.resolveSystemRole(def.role);
    if (existing) {
      roleToDbId.set(def.role, existing.database.id);
      result.push({
        role: def.role,
        databaseId: existing.database.id,
        name: existing.database.name,
        created: false,
      });
    }
  }

  // Pass 2: create the missing ones.
  for (const def of pack.databases) {
    if (roleToDbId.has(def.role)) continue;
    const created = createDatabaseFromPack(s, def);
    s.setSystemRole(def.role, created.id);
    roleToDbId.set(def.role, created.id);
    result.push({
      role: def.role,
      databaseId: created.id,
      name: created.name,
      created: true,
    });
  }

  // Pass 3: resolve relation targetRole → targetDatabaseId. We only touch
  // properties that are missing a targetDatabaseId AND came from THIS install
  // (i.e. the database we just created). Existing user-curated relations on
  // pre-existing databases are left alone.
  const createdRoles = new Set(result.filter((r) => r.created).map((r) => r.role));
  for (const def of pack.databases) {
    if (!createdRoles.has(def.role)) continue;
    const dbId = roleToDbId.get(def.role)!;
    const props = s.listProperties(dbId);
    for (const propDef of def.properties) {
      if (propDef.type !== "relation" || !propDef.targetRole) continue;
      const targetId = roleToDbId.get(propDef.targetRole);
      if (!targetId) continue;
      const live = props.find((p) => p.name === propDef.name && p.type === "relation");
      if (!live) continue;
      const nextConfig: PropertyConfig = {
        ...live.config,
        targetDatabaseId: targetId,
      };
      s.updateProperty(live.id, { config: nextConfig });
    }
  }

  return result;
}

/**
 * Create one database for a pack entry. Properties are inserted in the order
 * they appear in the pack; sortOrder is auto-assigned by createProperty.
 */
function createDatabaseFromPack(
  s: DatabasesStore,
  def: PackDatabaseDef,
): { id: string; name: string } {
  const created = s.createDatabase({
    name: def.name,
    icon: def.icon ?? null,
    description: def.description ?? null,
    source: "native",
    properties: def.properties.map((p) => ({
      name: p.name,
      type: p.type,
      // targetDatabaseId is resolved in pass 3 after every db exists; for
      // now we drop targetRole and pass through the rest of config.
      config: p.config ?? null,
      hidden: p.hidden,
    })),
  });
  return { id: created.id, name: created.name };
}

export const databasePacksHandlers: GatewayRequestHandlers = {
  /**
   * Returns the static pack catalogue. Public — agents call this to choose
   * what to recommend for a freshly-created business.
   */
  "business.packs.list": async ({ respond }) => {
    try {
      respond(true, { packs: listPacks() });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Install a pack. The businessId is captured for *future* row inserts that
   * the workspace will scope to this business — at this layer we only set
   * up the schema. Returning the freshly-created system-role mapping lets
   * the workspace UI render the resulting panels without re-fetching the
   * full database list.
   */
  "business.pack.install": async ({ params, respond }) => {
    try {
      const businessId = asStr((params as Record<string, unknown>).businessId);
      const packId = asStr((params as Record<string, unknown>).packId);
      if (!businessId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "businessId is required" });
        return;
      }
      if (!packId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "packId is required" });
        return;
      }
      const pack = getPack(packId);
      if (!pack) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Unknown pack: ${packId}` });
        return;
      }
      const installed = installPack(store(), pack);
      respond(true, {
        packId: pack.id,
        businessId,
        databases: installed,
        createdCount: installed.filter((r) => r.created).length,
        reusedCount: installed.filter((r) => !r.created).length,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

// Re-export for tests and tooling that wants in-process access.
export { installPack };
export type { InstalledDatabase };
