/**
 * Gateway Methods — Profiles (password-free multi-user / data isolation)
 *
 * RPC surface for the profile-picker "gate" screen. Distinct from
 * `users.*` (the password-auth UserStore). Profiles only control which
 * per-user DATA directory the data layer points at + UI appearance.
 *
 * Methods:
 *   profiles.list    → { profiles, currentUserId }
 *   profiles.current → { profile, currentUserId }
 *   profiles.create  → { profile }            (name, avatar?, theme?, wallpaper?)
 *   profiles.update  → { profile }            (id, patch)
 *   profiles.delete  → { ok }                 (id, deleteData?)
 *   profiles.switch  → { profile, reload:true } (id) — UI must reload to
 *                       re-resolve the data layer under the new profile.
 *
 * No auth gate here beyond the gateway's own connection auth: these are
 * local-device profiles (like OS user-switching on a personal machine),
 * not security boundaries.
 */

import {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  deleteProfile,
  switchProfile,
  stampProfileCreatedAt,
  type SkillLevel,
} from "../../users/profiles.js";
import { buildProfileContextBlock } from "../../users/profile-context.js";
import { getCurrentUserId } from "../../config/paths.js";
import { isSaasMode } from "../../saas/config.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

/**
 * SaaS mode: local profiles are a single-install feature. Tenancy comes from
 * the Clerk identity (one namespace per tenant), and switching/editing a local
 * profile mutates PROCESS-GLOBAL state (the active data dir for every tenant),
 * so members must never reach these. Returns true when it refused.
 */
function refuseInSaas(opts: GatewayRequestHandlerOptions): boolean {
  if (!isSaasMode()) return false;
  opts.respond(false, undefined, {
    code: "INVALID_REQUEST",
    message: "Local profiles are not available in the hosted workspace.",
  });
  return true;
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asSkillLevel(v: unknown): SkillLevel | undefined {
  return v === "beginner" || v === "intermediate" || v === "advanced" ? v : undefined;
}

export const profilesHandlers: GatewayRequestHandlers = {
  "profiles.list": async (opts) => {
    try {
      opts.respond(true, listProfiles());
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "profiles.current": async (opts) => {
    try {
      const id = getCurrentUserId();
      opts.respond(true, { profile: getProfile(id), currentUserId: id });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "profiles.create": async (opts) => {
    if (refuseInSaas(opts)) return;
    try {
      const name = asStr(opts.params?.name)?.trim();
      if (!name) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "name required" });
        return;
      }
      const profile = createProfile({
        name,
        avatar: asStr(opts.params?.avatar),
        theme: asStr(opts.params?.theme),
        wallpaper: asStr(opts.params?.wallpaper),
      });
      // Stamp wall-clock time here (the module stays Date-free for tests).
      stampProfileCreatedAt(profile.id, Date.now());
      opts.respond(true, { profile: getProfile(profile.id) });
    } catch (e) {
      opts.respond(false, undefined, {
        code: "INVALID_PARAMS",
        message: String((e as Error).message ?? e),
      });
    }
  },

  "profiles.update": async (opts) => {
    if (refuseInSaas(opts)) return;
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const profile = updateProfile(id, {
        name: asStr(opts.params?.name),
        avatar: asStr(opts.params?.avatar),
        theme: asStr(opts.params?.theme),
        wallpaper: asStr(opts.params?.wallpaper),
        // Operator context (Layer 1). Each is optional; the store treats
        // empty string as "clear this field". skillLevel is enum-validated.
        role: asStr(opts.params?.role),
        goals: asStr(opts.params?.goals),
        notes: asStr(opts.params?.notes),
        preferredLanguage: asStr(opts.params?.preferredLanguage),
        secondaryLanguage: asStr(opts.params?.secondaryLanguage),
        skillLevel: asSkillLevel(opts.params?.skillLevel),
        projectContext: asStr(opts.params?.projectContext),
        communicationStyle: asStr(opts.params?.communicationStyle),
      });
      if (!profile) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "profile not found" });
        return;
      }
      opts.respond(true, { profile });
    } catch (e) {
      opts.respond(false, undefined, {
        code: "INVALID_PARAMS",
        message: String((e as Error).message ?? e),
      });
    }
  },

  "profiles.getContext": async (opts) => {
    try {
      // Default to the active profile when no id is given.
      const id = asStr(opts.params?.id) ?? getCurrentUserId();
      const profile = getProfile(id);
      if (!profile) {
        opts.respond(false, undefined, { code: "NOT_FOUND", message: "profile not found" });
        return;
      }
      opts.respond(true, { context: buildProfileContextBlock(profile), profileId: id });
    } catch (e) {
      opts.respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "profiles.delete": async (opts) => {
    if (refuseInSaas(opts)) return;
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const ok = deleteProfile(id, { deleteData: asBool(opts.params?.deleteData) ?? false });
      opts.respond(true, { ok });
    } catch (e) {
      opts.respond(false, undefined, {
        code: "INVALID_PARAMS",
        message: String((e as Error).message ?? e),
      });
    }
  },

  "profiles.switch": async (opts) => {
    if (refuseInSaas(opts)) return;
    try {
      const id = asStr(opts.params?.id);
      if (!id) {
        opts.respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const profile = switchProfile(id);
      // The data layer's in-process pointer is now updated, but stores
      // opened earlier in this gateway process keep their cached handles.
      // The UI reloads on `reload:true` so a fresh connection re-resolves
      // every store under the new profile's data dir. Shared services
      // (gateway, plugins, model backends) are untouched.
      opts.respond(true, { profile, reload: true });
    } catch (e) {
      opts.respond(false, undefined, {
        code: "INVALID_PARAMS",
        message: String((e as Error).message ?? e),
      });
    }
  },
};

export default profilesHandlers;
