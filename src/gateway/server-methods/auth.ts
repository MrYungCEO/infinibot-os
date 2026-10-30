import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStore,
  saveAuthProfileStore,
  type ApiKeyCredential,
  type TokenCredential,
} from "../../agents/auth-profiles.js";
import {
  clearAuthProfileEnv,
  exportAuthProfilesToEnv,
} from "../../agents/auth-profiles/env-export.js";
import { buildAuthHealthSummary } from "../../agents/auth-health.js";
import { loadConfig } from "../../config/config.js";
import { getCanvaAccessToken, getCanvaOauthRedirectUri } from "../canva-oauth-http.js";

export type AuthProfileEntry = {
  profileId: string;
  provider: string;
  type: "api_key" | "oauth" | "token";
  email?: string;
  status: "ok" | "expiring" | "expired" | "missing" | "static";
  expiresAt?: number;
  remainingMs?: number;
  label: string;
  maskedKey?: string;
};

export type AuthProviderSummary = {
  provider: string;
  status: "ok" | "expiring" | "expired" | "missing" | "static";
  profiles: AuthProfileEntry[];
  profileCount: number;
};

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "••••••••";
  return key.slice(0, 4) + "••••" + key.slice(-4);
}

function resolveLabel(profileId: string, provider: string): string {
  const parts = profileId.split(":");
  if (parts.length >= 2 && parts[1] !== "default") {
    return `${provider} (${parts[1]})`;
  }
  return provider;
}

// List all auth profiles grouped by provider
async function handleProfilesList(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { respond } = opts;
  try {
    const store = loadAuthProfileStore();
    const cfg = loadConfig();
    const health = buildAuthHealthSummary({ store, cfg });

    const providers: AuthProviderSummary[] = health.providers.map((p) => ({
      provider: p.provider,
      status: p.status,
      profileCount: p.profiles.length,
      profiles: p.profiles.map((profile) => {
        const cred = store.profiles[profile.profileId];
        const credAny = cred as any;
        return {
          profileId: profile.profileId,
          provider: profile.provider,
          type: profile.type,
          email: credAny?.email,
          // Extra fields stored by OAuth flows (not in TypeScript type, but in JSON)
          displayName: credAny?.displayName,
          userId: credAny?.userId,
          status: profile.status,
          expiresAt: profile.expiresAt,
          remainingMs: profile.remainingMs,
          label: profile.label || resolveLabel(profile.profileId, profile.provider),
          maskedKey:
            cred?.type === "api_key"
              ? maskApiKey((cred as ApiKeyCredential).key)
              : cred?.type === "token"
                ? maskApiKey((cred as TokenCredential).token)
                : undefined,
        };
      }),
    }));

    respond(true, {
      providers,
      profileCount: Object.keys(store.profiles).length,
      now: health.now,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Get a single auth profile
async function handleProfilesGet(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;
  const profileId = params.profileId as string;

  if (!profileId) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "profileId required" });
    return;
  }

  try {
    const store = loadAuthProfileStore();
    const cred = store.profiles[profileId];
    if (!cred) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Profile not found" });
      return;
    }

    const cfg = loadConfig();
    const health = buildAuthHealthSummary({ store, cfg });
    const profileHealth = health.profiles.find((p) => p.profileId === profileId);

    respond(true, {
      profileId,
      provider: cred.provider,
      type: cred.type,
      email: (cred as { email?: string })?.email,
      status: profileHealth?.status ?? "static",
      expiresAt: profileHealth?.expiresAt,
      remainingMs: profileHealth?.remainingMs,
      label: profileHealth?.label || resolveLabel(profileId, cred.provider),
      maskedKey:
        cred.type === "api_key"
          ? maskApiKey((cred as ApiKeyCredential).key)
          : cred.type === "token"
            ? maskApiKey((cred as TokenCredential).token)
            : undefined,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Upsert an API key profile
async function handleProfilesUpsert(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;
  const provider = params.provider as string;
  const type = params.type as "api_key" | "token";
  const key = params.key as string;
  const profileId = params.profileId as string | undefined;
  const email = params.email as string | undefined;

  if (!provider || !type || !key) {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "provider, type, and key are required",
    });
    return;
  }

  try {
    const resolvedProfileId = profileId || `${provider}:default`;
    const store = ensureAuthProfileStore();

    if (type === "api_key") {
      store.profiles[resolvedProfileId] = {
        type: "api_key",
        provider,
        key,
        ...(email ? { email } : {}),
      };
    } else {
      store.profiles[resolvedProfileId] = {
        type: "token",
        provider,
        token: key,
        ...(email ? { email } : {}),
      };
    }

    saveAuthProfileStore(store);
    // Re-export the just-saved key into process.env so spawned `exec`
    // calls (PIXEL → Replicate API, etc.) pick it up immediately
    // without needing a gateway restart.
    exportAuthProfilesToEnv(store, { overwrite: true });

    respond(true, {
      profileId: resolvedProfileId,
      provider,
      type,
      maskedKey: maskApiKey(key),
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Delete an auth profile
async function handleProfilesDelete(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;
  const profileId = params.profileId as string;

  if (!profileId) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "profileId required" });
    return;
  }

  try {
    const store = ensureAuthProfileStore();

    if (!store.profiles[profileId]) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Profile not found" });
      return;
    }

    const deletedProvider = store.profiles[profileId]?.provider;
    delete store.profiles[profileId];

    // Clean up related entries
    if (store.lastGood) {
      for (const [key, value] of Object.entries(store.lastGood)) {
        if (value === profileId) {
          delete store.lastGood[key];
        }
      }
    }
    if (store.usageStats) {
      delete store.usageStats[profileId];
    }
    if (store.order) {
      for (const [key, value] of Object.entries(store.order)) {
        store.order[key] = value.filter((id) => id !== profileId);
      }
    }

    saveAuthProfileStore(store);
    // Reflect the deletion in process.env: clear the env var unless
    // another profile for the same provider still exists.
    if (deletedProvider) clearAuthProfileEnv(deletedProvider, store);

    respond(true, { deleted: profileId });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Test an API key by making a live request to the provider's API
async function handleProfilesTest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;
  const profileId = params.profileId as string;

  if (!profileId) {
    respond(false, undefined, { code: "INVALID_REQUEST", message: "profileId required" });
    return;
  }

  try {
    const store = loadAuthProfileStore();
    const cred = store.profiles[profileId];

    if (!cred) {
      respond(false, undefined, { code: "NOT_FOUND", message: "Profile not found" });
      return;
    }

    // Supabase: list projects via Management API
    if (cred.provider === "supabase") {
      const pat = cred.type === "api_key" ? (cred as any).key : (cred as any).token;
      if (!pat) {
        respond(true, { profileId, provider: "supabase", valid: false, message: "No PAT stored." });
        return;
      }
      try {
        const r = await fetch("https://api.supabase.com/v1/projects", {
          headers: { Authorization: `Bearer ${pat}` },
        });
        if (r.ok) {
          const projects = (await r.json()) as Array<{ id: string; name: string }>;
          respond(true, {
            profileId,
            provider: "supabase",
            valid: true,
            message: `Connected · ${projects.length} project${projects.length !== 1 ? "s" : ""}`,
            data: { projectCount: projects.length, projectName: projects[0]?.name ?? null },
          });
        } else {
          const text = await r.text().catch(() => "");
          respond(true, {
            profileId,
            provider: "supabase",
            valid: false,
            message: `Supabase API HTTP ${r.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
          });
        }
      } catch (fetchErr) {
        respond(true, {
          profileId,
          provider: "supabase",
          valid: false,
          message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
      }
      return;
    }

    // Canva: call /rest/v1/designs to count designs
    if (cred.provider === "canva") {
      const token = await getCanvaAccessToken();
      if (!token) {
        respond(true, {
          profileId,
          provider: "canva",
          valid: false,
          message: "No active token found. Please reconnect.",
        });
        return;
      }
      try {
        const r = await fetch("https://api.canva.com/rest/v1/designs?limit=1", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) {
          const data = (await r.json()) as { items?: unknown[] };
          respond(true, {
            profileId,
            provider: "canva",
            valid: true,
            message: "Connected to Canva Connect API",
            data: { designCount: data?.items?.length ?? 0 },
          });
        } else {
          const text = await r.text().catch(() => "");
          respond(true, {
            profileId,
            provider: "canva",
            valid: false,
            message: `Canva API returned HTTP ${r.status}${text ? `: ${text.slice(0, 120)}` : ""}`,
          });
        }
      } catch (fetchErr) {
        respond(true, {
          profileId,
          provider: "canva",
          valid: false,
          message: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
        });
      }
      return;
    }

    // Default: just confirm the profile exists
    respond(true, {
      profileId,
      provider: cred.provider,
      valid: true,
      message: "Profile exists and is configured",
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Return the Canva OAuth redirect URI (so the UI can show it to the user)
async function handleCanvaOauthGetRedirectUri(opts: GatewayRequestHandlerOptions): Promise<void> {
  opts.respond(true, { redirectUri: getCanvaOauthRedirectUri() });
}

// Get health summary for all providers
async function handleHealth(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { respond } = opts;
  try {
    const store = loadAuthProfileStore();
    const cfg = loadConfig();
    const health = buildAuthHealthSummary({ store, cfg });

    respond(true, {
      now: health.now,
      warnAfterMs: health.warnAfterMs,
      providers: health.providers.map((p) => ({
        provider: p.provider,
        status: p.status,
        expiresAt: p.expiresAt,
        remainingMs: p.remainingMs,
        profileCount: p.profiles.length,
      })),
      profileCount: health.profiles.length,
      expiringSoon: health.profiles.filter((p) => p.status === "expiring").length,
      expired: health.profiles.filter((p) => p.status === "expired").length,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

export const authHandlers: GatewayRequestHandlers = {
  "auth.profiles.list": handleProfilesList,
  "auth.profiles.get": handleProfilesGet,
  "auth.profiles.upsert": handleProfilesUpsert,
  "auth.profiles.delete": handleProfilesDelete,
  "auth.profiles.test": handleProfilesTest,
  "auth.health": handleHealth,
  "canva.oauth.getRedirectUri": handleCanvaOauthGetRedirectUri,
};
