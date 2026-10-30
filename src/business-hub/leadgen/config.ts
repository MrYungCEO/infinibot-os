/**
 * Lead generation — provider config persisted in hub_meta `leadgen.config`.
 * API keys are stored encrypted (services/email/secret-crypto) and only ever
 * leave this module masked.
 */

import { getMeta, setMeta, type HubDb } from "../db.js";
import { decryptSecret, encryptSecret } from "../../services/email/secret-crypto.js";
import { isFleetTenantMachineEnv } from "../../saas/fleet-config-guard.js";
import { assertPublicUrl } from "./http.js";
import { getProvider, LEAD_PROVIDERS } from "./providers.js";
import type {
  Availability,
  LeadgenConfig,
  LeadgenDeps,
  LeadProvider,
  ProviderCtx,
  ProviderSettings,
} from "./types.js";

export const CONFIG_KEY = "leadgen.config";
export const DEFAULT_OVERPASS_QUOTA = 200;

const defaultSecrets = {
  encrypt: (s: string) => encryptSecret(s),
  decrypt: (s: string) => decryptSecret(s),
};

export function loadLeadgenConfig(db: HubDb): LeadgenConfig {
  let raw: Partial<LeadgenConfig> = {};
  try {
    raw = JSON.parse(getMeta(db, CONFIG_KEY) ?? "{}") as Partial<LeadgenConfig>;
  } catch {
    raw = {};
  }
  return {
    providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
    defaultCountry:
      typeof raw.defaultCountry === "string" && raw.defaultCountry ? raw.defaultCountry : "US",
    dailyOverpassQuota:
      typeof raw.dailyOverpassQuota === "number" && raw.dailyOverpassQuota > 0
        ? Math.floor(raw.dailyOverpassQuota)
        : DEFAULT_OVERPASS_QUOTA,
  };
}

function validServiceUrl(u: string): string {
  const parsed = new URL(u);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("service URL must be http(s)");
  return parsed.toString().replace(/\/+$/, "");
}

export type ConfigPatch = {
  providers?: Record<
    string,
    {
      enabled?: boolean;
      serviceUrl?: string | null;
      apiKey?: string | null;
      endpoint?: string | null;
      geocoderUrl?: string | null;
    }
  >;
  defaultCountry?: string;
  dailyOverpassQuota?: number;
};

/**
 * Merge a patch into the stored config. `apiKey: ""|null` clears a key;
 * a non-empty key is encrypted and implicitly enables the provider unless
 * `enabled` is given.
 */
export function saveLeadgenConfig(
  db: HubDb,
  patch: ConfigPatch,
  deps: LeadgenDeps = {},
): LeadgenConfig {
  const secrets = deps.secrets ?? defaultSecrets;
  const cfg = loadLeadgenConfig(db);
  for (const [id, p] of Object.entries(patch.providers ?? {})) {
    if (!getProvider(id)) throw new Error(`unknown provider: ${id}`);
    const cur: ProviderSettings = { ...cfg.providers[id] };
    if (typeof p.enabled === "boolean") cur.enabled = p.enabled;
    for (const k of ["serviceUrl", "endpoint", "geocoderUrl"] as const) {
      const v = p[k];
      if (v === undefined) continue;
      if (v === null || v === "") delete cur[k];
      else cur[k] = k === "geocoderUrl" && v === "none" ? "none" : validServiceUrl(v);
    }
    if (p.apiKey !== undefined) {
      if (!p.apiKey) delete cur.apiKey;
      else {
        const enc = secrets.encrypt(p.apiKey.trim());
        if (!enc) throw new Error("could not encrypt API key");
        cur.apiKey = enc;
        if (typeof p.enabled !== "boolean") cur.enabled = true;
      }
    }
    if (p.serviceUrl && typeof p.enabled !== "boolean") cur.enabled = true;
    cfg.providers[id] = cur;
  }
  if (typeof patch.defaultCountry === "string" && /^[a-z]{2}$/i.test(patch.defaultCountry))
    cfg.defaultCountry = patch.defaultCountry.toUpperCase();
  if (typeof patch.dailyOverpassQuota === "number" && patch.dailyOverpassQuota > 0)
    cfg.dailyOverpassQuota = Math.min(10_000, Math.floor(patch.dailyOverpassQuota));
  setMeta(db, CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

/** Stored key (decrypted) or the first matching env var. */
export function resolveApiKey(
  provider: LeadProvider,
  cfg: LeadgenConfig,
  deps: LeadgenDeps = {},
): { key: string | null; from: "config" | "env" | null } {
  const stored = cfg.providers[provider.id]?.apiKey;
  if (stored) {
    const key = (deps.secrets ?? defaultSecrets).decrypt(stored);
    if (key) return { key, from: "config" };
  }
  const env = deps.env ?? process.env;
  // InfiniBot Cloud: the tenant Machine's env is the platform's, so paid
  // lead-gen providers use only the key the tenant saved (BYOK).
  if (isFleetTenantMachineEnv(env)) return { key: null, from: null };
  for (const k of provider.envKeys ?? []) {
    const v = env[k]?.trim();
    if (v) return { key: v, from: "env" };
  }
  return { key: null, from: null };
}

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

export function isEnabled(provider: LeadProvider, cfg: LeadgenConfig): boolean {
  return cfg.providers[provider.id]?.enabled ?? provider.defaultEnabled;
}

export type ProviderStatus = {
  id: string;
  label: string;
  kind: LeadProvider["kind"];
  description: string;
  notice?: string;
  requires?: LeadProvider["requires"];
  enabled: boolean;
  availability: Availability;
  config: {
    serviceUrl?: string;
    endpoint?: string;
    geocoderUrl?: string;
    apiKey: string | null;
    apiKeySource: "config" | "env" | null;
  };
};

/** Provider list for the UI — keys masked, never raw. */
export function listProviderStatus(
  db: HubDb,
  deps: LeadgenDeps = {},
): {
  providers: ProviderStatus[];
  defaultCountry: string;
  dailyOverpassQuota: number;
} {
  const cfg = loadLeadgenConfig(db);
  return {
    providers: LEAD_PROVIDERS.map((p) => {
      const s = cfg.providers[p.id] ?? {};
      const key = resolveApiKey(p, cfg, deps);
      return {
        id: p.id,
        label: p.label,
        kind: p.kind,
        description: p.description,
        notice: p.notice,
        requires: p.requires,
        enabled: isEnabled(p, cfg),
        availability: p.available(cfg, key.key),
        config: {
          serviceUrl: s.serviceUrl,
          endpoint: s.endpoint,
          geocoderUrl: s.geocoderUrl,
          apiKey: maskKey(key.key),
          apiKeySource: key.from,
        },
      };
    }),
    defaultCountry: cfg.defaultCountry,
    dailyOverpassQuota: cfg.dailyOverpassQuota,
  };
}

/**
 * InfiniBot Cloud: provider calls leave a tenant Machine that sits on the
 * platform's private network, and a tenant can point a provider at any
 * service URL. Every request must target a public host, and redirects are
 * refused so a public URL cannot bounce the call onto an internal one.
 * Self-hosted installs keep plain fetch (local sidecars on localhost work).
 */
export function cloudGuardedFetch(
  base: typeof fetch,
  deps: LeadgenDeps,
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch {
  if (!isFleetTenantMachineEnv(env)) return base;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    await assertPublicUrl(new URL(raw), deps);
    return base(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

export function providerCtx(
  db: HubDb,
  cfg: LeadgenConfig,
  provider: LeadProvider,
  deps: LeadgenDeps,
  country?: string,
): ProviderCtx {
  return {
    db,
    cfg,
    settings: cfg.providers[provider.id] ?? {},
    apiKey: resolveApiKey(provider, cfg, deps).key,
    deps,
    fetch: cloudGuardedFetch(deps.fetchImpl ?? fetch, deps),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    country: country ?? cfg.defaultCountry,
  };
}
