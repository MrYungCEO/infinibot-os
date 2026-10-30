/**
 * Export API keys from the auth profile store into process.env so any
 * tool that reads e.g. REPLICATE_API_TOKEN (the PIXEL media agent's
 * `exec` calls, the federation identity sync, model probes) sees them.
 *
 * Without this hook, keys saved via the UI's /apikeys page would live
 * only inside the auth profile store on disk — invisible to spawned
 * shell commands.
 *
 * Called at gateway startup AND after every upsert/delete so changes
 * take effect immediately without a restart.
 */

import type { AuthProfileStore } from "./types.js";
import { isSaasTenantScope } from "../../saas/tenant-config.js";

/**
 * Provider id → env var name. Mirrors the UI's KNOWN_PROVIDERS list
 * (ui/src/ui/controllers/api-keys.ts). Keep them in sync when adding a
 * new provider so a key saved in the UI also reaches the runtime env.
 */
export const PROVIDER_ENV_KEYS: Record<string, string> = {
  // LLM model providers
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  cohere: "COHERE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  xai: "XAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  zai: "ZAI_API_KEY",
  llamacloud: "LLAMACLOUD_API_KEY",
  "ollama-cloud": "OLLAMA_CLOUD_API_KEY",
  // Media + voice
  replicate: "REPLICATE_API_TOKEN",
  elevenlabs: "ELEVENLABS_API_KEY",
  // Integrations
  notion: "NOTION_API_KEY",
  loops: "LOOPS_API_KEY",
  github: "GITHUB_TOKEN",
  brave: "BRAVE_API_KEY",
  hunter: "HUNTER_API_KEY",
  supabase: "SUPABASE_PAT",
  // Messaging channels (bot tokens)
  telegram: "TELEGRAM_BOT_TOKEN",
  discord: "DISCORD_BOT_TOKEN",
  slack: "SLACK_BOT_TOKEN",
};

/**
 * Walk the auth profile store and set process.env[ENV_KEY] for each
 * api_key or token profile whose provider has a mapped env var. If the
 * env var is *already* set externally (operator's shell, systemd unit),
 * we don't overwrite it — explicit env beats stored config.
 *
 * Returns the list of env vars that were exported so callers can log.
 */
export function exportAuthProfilesToEnv(
  store: AuthProfileStore,
  opts: { overwrite?: boolean } = {},
): string[] {
  // SaaS member: process.env is shared by every tenant (and the operator), so a
  // tenant's BYOK key must never be exported into it.
  if (isSaasTenantScope()) return [];
  const overwrite = opts.overwrite ?? false;
  const exported: string[] = [];

  for (const profile of Object.values(store.profiles ?? {})) {
    if (!profile || typeof profile !== "object") continue;
    const envKey = PROVIDER_ENV_KEYS[profile.provider];
    if (!envKey) continue;
    if (!overwrite && process.env[envKey]?.trim()) continue;

    const value =
      profile.type === "api_key" ? profile.key : profile.type === "token" ? profile.token : null;
    if (!value) continue;

    process.env[envKey] = value;
    exported.push(envKey);
  }

  return exported;
}

/**
 * Inverse: clear an env var when a profile is deleted. Only clears if
 * the current value matches what would have been exported from a
 * profile (i.e. don't clobber an operator-set value).
 */
export function clearAuthProfileEnv(provider: string, store: AuthProfileStore): void {
  const envKey = PROVIDER_ENV_KEYS[provider];
  if (!envKey) return;
  // If another profile for the same provider still exists, re-export it
  // instead of clearing. (Multi-profile providers — e.g. two OpenAI keys —
  // should keep at least one in env.)
  for (const profile of Object.values(store.profiles ?? {})) {
    if (profile?.provider === provider) {
      const value =
        profile.type === "api_key" ? profile.key : profile.type === "token" ? profile.token : null;
      if (value) {
        process.env[envKey] = value;
        return;
      }
    }
  }
  delete process.env[envKey];
}
