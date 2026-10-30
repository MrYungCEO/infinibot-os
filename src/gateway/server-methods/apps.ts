/**
 * Gateway Methods — Apps & Sites Registry.
 *
 * The unified catalog of every app, site, project, and directory the
 * operator has built or assigned. Drives the dashboard's `/apps` page.
 *
 * The auto-register hook (`autoRegister` in `src/apps/store.ts`) is
 * called from the create handlers of underlying stores (kanban,
 * directories, compositions, storyboards, landing pages) so every new
 * piece of work shows up here automatically.
 */

import { resolveStateDir } from "../../config/paths.js";
import {
  backfillApps,
  getAppsStore,
  type AppPatch,
  type AppType,
} from "../../apps/store.js";
import type { GatewayRequestHandlers } from "./types.js";

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asStrArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export const appsHandlers: GatewayRequestHandlers = {
  /** List apps with optional filters (type, business, directory, featured). */
  "apps.list": async ({ respond, params }) => {
    try {
      const filters: Parameters<ReturnType<typeof getAppsStore>["list"]>[0] = {};
      const t = asStr(params?.type) as AppType | undefined;
      if (t) filters.type = t;
      if (asStr(params?.businessId)) filters.businessId = asStr(params?.businessId)!;
      if (asStr(params?.directoryId)) filters.directoryId = asStr(params?.directoryId)!;
      if (typeof params?.featured === "boolean") filters.featured = params.featured as boolean;
      const apps = getAppsStore(resolveStateDir()).list(filters);
      respond(true, { apps });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "apps.get": async ({ respond, params }) => {
    try {
      const id = asStr(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const app = getAppsStore(resolveStateDir()).get(id);
      if (!app) {
        respond(false, undefined, { code: "NOT_FOUND", message: "app not found" });
        return;
      }
      respond(true, { app });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Create a manual entry. The auto-register hook is what populates
   * source-backed entries (kanban, directories, etc.); this is for the
   * "I deployed something external" case — a Vercel app, a separately-
   * hosted site, a thing the operator wants tracked but isn't mirroring
   * a local source store.
   */
  "apps.create": async ({ respond, params }) => {
    try {
      const name = asStr(params?.name);
      if (!name) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "name required" });
        return;
      }
      const app = getAppsStore(resolveStateDir()).create({
        name,
        slug: asStr(params?.slug),
        description: asStr(params?.description) ?? "",
        type: (asStr(params?.type) as AppType | undefined) ?? "web-app",
        url: asStr(params?.url) ?? null,
        businessId: asStr(params?.businessId) ?? null,
        directoryId: asStr(params?.directoryId) ?? null,
        ownerId: asStr(params?.ownerId) ?? null,
        tags: asStrArr(params?.tags) ?? [],
        featured: asBool(params?.featured) ?? false,
        meta: (params?.meta as Record<string, unknown> | undefined) ?? {},
      });
      respond(true, { app });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "apps.update": async ({ respond, params }) => {
    try {
      const id = asStr(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const patch: AppPatch = {};
      for (const key of [
        "name", "slug", "description", "url",
      ] as const) {
        const v = asStr(params?.[key]);
        if (params?.[key] !== undefined) (patch as Record<string, unknown>)[key] = v ?? null;
      }
      if (params?.type !== undefined) patch.type = asStr(params.type) as AppType;
      if (params?.status !== undefined) patch.status = asStr(params.status) as never;
      if (params?.businessId !== undefined) patch.businessId = asStr(params.businessId) ?? null;
      if (params?.directoryId !== undefined) patch.directoryId = asStr(params.directoryId) ?? null;
      if (params?.ownerId !== undefined) patch.ownerId = asStr(params.ownerId) ?? null;
      if (params?.tags !== undefined) patch.tags = asStrArr(params.tags) ?? [];
      if (params?.featured !== undefined) patch.featured = asBool(params.featured) ?? false;
      if (params?.meta !== undefined) patch.meta = (params.meta as Record<string, unknown>) ?? {};
      const app = getAppsStore(resolveStateDir()).update(id, patch);
      if (!app) {
        respond(false, undefined, { code: "NOT_FOUND", message: "app not found" });
        return;
      }
      respond(true, { app });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "apps.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const ok = getAppsStore(resolveStateDir()).delete(id);
      respond(true, { deleted: ok });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Toggle the spotlight flag — surfaces the app on the home dashboard. */
  "apps.featured.toggle": async ({ respond, params }) => {
    try {
      const id = asStr(params?.id);
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const store = getAppsStore(resolveStateDir());
      const cur = store.get(id);
      if (!cur) {
        respond(false, undefined, { code: "NOT_FOUND", message: "app not found" });
        return;
      }
      const app = store.update(id, { featured: !cur.featured })!;
      respond(true, { app });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Walk every source store (kanban, directories, compositions, ...) and
   * upsert one registry entry per record. Idempotent — running twice
   * leaves the same registry, only updates timestamps.
   */
  "apps.backfill": async ({ respond }) => {
    try {
      const summary = backfillApps(resolveStateDir());
      respond(true, { summary });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default appsHandlers;
