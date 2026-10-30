/**
 * One-time migration: copy API keys/tokens scattered across the legacy
 * config (notion.apiKey, loops.apiKey, talk.apiKey, channels.*.botToken,
 * models.providers.*.apiKey, research.brave.apiKey) into the auth
 * profile store so they show up in the /apikeys UI and become editable
 * from one screen.
 *
 * Runs at every gateway boot (cheap — just object reads + a possible
 * write) but is idempotent: never overwrites a profile that already
 * exists, so the profile store remains the source of truth once
 * populated.
 */

import type { InfinibotConfig } from "../../config/config.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { ApiKeyCredential, AuthProfileStore, TokenCredential } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("auth-profiles-migrate");

/**
 * Static map of legacy config locations → (provider, type). The "lookup"
 * function pulls the value out of the config object; we keep a function
 * rather than a string path so accessors can be type-checked.
 */
type MigrationSource = {
  provider: string;
  type: "api_key" | "token";
  /** Read the credential value off the config object. */
  read(cfg: InfinibotConfig): string | undefined;
  /** Human description for logs. */
  source: string;
};

const STATIC_SOURCES: MigrationSource[] = [
  {
    provider: "notion",
    type: "api_key",
    read: (cfg) => (cfg as any)?.notion?.apiKey,
    source: "config.notion.apiKey",
  },
  {
    provider: "loops",
    type: "api_key",
    read: (cfg) => (cfg as any)?.loops?.apiKey,
    source: "config.loops.apiKey",
  },
  {
    provider: "elevenlabs",
    type: "api_key",
    read: (cfg) => (cfg as any)?.talk?.apiKey,
    source: "config.talk.apiKey",
  },
  {
    provider: "brave",
    type: "api_key",
    read: (cfg) => (cfg as any)?.research?.brave?.apiKey,
    source: "config.research.brave.apiKey",
  },
  {
    provider: "telegram",
    type: "token",
    read: (cfg) => (cfg as any)?.channels?.telegram?.botToken,
    source: "config.channels.telegram.botToken",
  },
  {
    provider: "discord",
    type: "token",
    read: (cfg) => (cfg as any)?.channels?.discord?.botToken,
    source: "config.channels.discord.botToken",
  },
  {
    provider: "slack",
    type: "token",
    read: (cfg) => (cfg as any)?.channels?.slack?.botToken,
    source: "config.channels.slack.botToken",
  },
  {
    provider: "hunter",
    type: "api_key",
    read: (cfg) => (cfg as any)?.leads?.hunter?.apiKey,
    source: "config.leads.hunter.apiKey",
  },
  {
    provider: "github",
    type: "token",
    read: (cfg) => (cfg as any)?.github?.token ?? (cfg as any)?.github?.apiKey,
    source: "config.github.token",
  },
];

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function hasProfileForProvider(store: AuthProfileStore, provider: string): boolean {
  for (const credential of Object.values(store.profiles ?? {})) {
    if (credential?.provider === provider) return true;
  }
  return false;
}

/**
 * Scan the config for legacy credentials and copy them into the auth
 * profile store. Returns the list of providers migrated this call so
 * the caller can log a one-line summary.
 */
export function migrateConfigKeysToAuthProfiles(cfg: InfinibotConfig): string[] {
  const store = ensureAuthProfileStore();
  const migrated: string[] = [];
  let mutated = false;

  // Static sources — one fixed config path per provider.
  for (const src of STATIC_SOURCES) {
    const value = trimOrNull(src.read(cfg));
    if (!value) continue;
    if (hasProfileForProvider(store, src.provider)) continue;
    const profileId = `${src.provider}:default`;
    const credential: ApiKeyCredential | TokenCredential =
      src.type === "api_key"
        ? { type: "api_key", provider: src.provider, key: value }
        : { type: "token", provider: src.provider, token: value };
    store.profiles[profileId] = credential;
    migrated.push(`${src.provider} (from ${src.source})`);
    mutated = true;
  }

  // Dynamic source: models.providers.<id>.apiKey covers the LLM
  // providers (anthropic, openai, google, groq, together, ...). The
  // provider id matches our KNOWN_PROVIDERS list so they slot in
  // without a translation table.
  const modelProviders = ((cfg as any)?.models?.providers ?? {}) as Record<string, any>;
  for (const [providerId, providerCfg] of Object.entries(modelProviders)) {
    const value = trimOrNull(providerCfg?.apiKey);
    if (!value) continue;
    if (hasProfileForProvider(store, providerId)) continue;
    const profileId = `${providerId}:default`;
    store.profiles[profileId] = {
      type: "api_key",
      provider: providerId,
      key: value,
    };
    migrated.push(`${providerId} (from config.models.providers.${providerId}.apiKey)`);
    mutated = true;
  }

  // ── Gmail accounts ──────────────────────────────────────────────────
  // Each entry under `integrations.gmail.accounts[]` becomes its own
  // profile so multiple connected mailboxes show up as separate rows on
  // the API Keys page. The refresh token is the long-lived secret we
  // care about; clientId/clientSecret stay in config as app-level creds.
  // We dedupe per accountId (not per provider) so adding a new account
  // doesn't skip migration just because another one is already there.
  const gmailAccounts = ((cfg as any)?.integrations?.gmail?.accounts ?? []) as Array<{
    id?: string;
    email?: string;
    refreshToken?: string;
  }>;
  for (const acc of gmailAccounts) {
    const accId = trimOrNull(acc?.id);
    const refresh = trimOrNull(acc?.refreshToken);
    if (!accId || !refresh) continue;
    const profileId = `gmail:${accId}`;
    if (store.profiles[profileId]) continue;
    store.profiles[profileId] = {
      type: "token",
      provider: "gmail",
      token: refresh,
      ...(acc.email ? { email: acc.email } : {}),
    };
    migrated.push(`gmail (${acc.email ?? accId})`);
    mutated = true;
  }

  // ── Google Calendar (single account) ────────────────────────────────
  const calendarCreds = (cfg as any)?.integrations?.calendar ?? {};
  const calRefresh = trimOrNull(calendarCreds?.refreshToken);
  if (calRefresh && !hasProfileForProvider(store, "google-calendar")) {
    store.profiles["google-calendar:default"] = {
      type: "token",
      provider: "google-calendar",
      token: calRefresh,
      ...(calendarCreds.email ? { email: calendarCreds.email } : {}),
    };
    migrated.push("google-calendar (from config.integrations.calendar.refreshToken)");
    mutated = true;
  }

  if (mutated) {
    saveAuthProfileStore(store);
    log.info("Migrated legacy API keys to auth profile store", {
      count: migrated.length,
      providers: migrated,
    });
  } else {
    log.debug("No legacy API keys to migrate (auth profile store is already populated)");
  }

  return migrated;
}
