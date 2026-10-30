/**
 * Canonical provider catalogue — the ONE source of truth for "which providers
 * can the user add a key / pick a model for".
 *
 * This module is deliberately import-safe from BOTH the UI bundle and the
 * gateway runtime: it has zero imports and no side effects, so it can be loaded
 * by the Lit control UI, by gateway server-methods, and by the Electron first-
 * run wizard (via dist/) without dragging in heavy dependencies.
 *
 * - The UI (`ui/src/ui/controllers/api-keys.ts`) re-exports `KNOWN_PROVIDERS`
 *   and `getProviderInfo` from here to preserve its public surface.
 * - The gateway serves it via the `providers.catalog.list` RPC.
 * - The wizard reads it from dist as a first-run fallback (before any gateway
 *   exists) so BYOK-only providers appear in the Step 4 picker even with no
 *   keys configured yet.
 *
 * Keep the `envKey` values in sync with the server-side `PROVIDER_ENV_KEYS`
 * map (src/agents/auth-profiles/env-export.ts) so keys saved in the UI reach
 * process.env at the matching name.
 *
 * `category` lets consumers group rows: "model" providers cluster together,
 * "channel" providers (Telegram/Discord/Slack) cluster together, "media"
 * covers Replicate/ElevenLabs, "integration" covers everything else.
 */
export const KNOWN_PROVIDERS = [
  // ── LLM model providers ─────────────────────────────────────────────
  {
    id: "anthropic",
    label: "Anthropic",
    icon: "🧠",
    envKey: "ANTHROPIC_API_KEY",
    category: "model",
  },
  { id: "openai", label: "OpenAI", icon: "🤖", envKey: "OPENAI_API_KEY", category: "model" },
  {
    id: "google",
    label: "Google AI (Gemini)",
    icon: "🔷",
    envKey: "GOOGLE_API_KEY",
    category: "model",
  },
  { id: "groq", label: "Groq", icon: "⚡", envKey: "GROQ_API_KEY", category: "model" },
  {
    id: "together",
    label: "Together AI",
    icon: "🤝",
    envKey: "TOGETHER_API_KEY",
    category: "model",
  },
  { id: "deepseek", label: "DeepSeek", icon: "🔍", envKey: "DEEPSEEK_API_KEY", category: "model" },
  { id: "mistral", label: "Mistral", icon: "🌪️", envKey: "MISTRAL_API_KEY", category: "model" },
  { id: "cohere", label: "Cohere", icon: "💬", envKey: "COHERE_API_KEY", category: "model" },
  {
    id: "perplexity",
    label: "Perplexity",
    icon: "🔮",
    envKey: "PERPLEXITY_API_KEY",
    category: "model",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    icon: "🎆",
    envKey: "FIREWORKS_API_KEY",
    category: "model",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    icon: "🛣️",
    envKey: "OPENROUTER_API_KEY",
    category: "model",
  },
  { id: "xai", label: "xAI (Grok)", icon: "𝕏", envKey: "XAI_API_KEY", category: "model" },
  { id: "cerebras", label: "Cerebras", icon: "🧠", envKey: "CEREBRAS_API_KEY", category: "model" },
  { id: "zai", label: "Z.ai (GLM)", icon: "🇿", envKey: "ZAI_API_KEY", category: "model" },
  {
    id: "llamacloud",
    label: "LlamaCloud (Llama API)",
    icon: "🦙",
    envKey: "LLAMACLOUD_API_KEY",
    category: "model",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud (Turbo)",
    icon: "☁️",
    envKey: "OLLAMA_CLOUD_API_KEY",
    category: "model",
  },
  // `local`: runs on the member's own machine — never offered in cloud-only (SaaS) flows.
  {
    id: "ollama",
    label: "Ollama (local)",
    icon: "🦙",
    envKey: "",
    category: "model",
    local: true,
  },
  // ── Media + voice ──────────────────────────────────────────────────
  {
    id: "replicate",
    label: "Replicate",
    icon: "🔄",
    envKey: "REPLICATE_API_TOKEN",
    category: "media",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    icon: "🔊",
    envKey: "ELEVENLABS_API_KEY",
    category: "media",
  },
  // ── Integrations (documents, CRM, search) ──────────────────────────
  { id: "notion", label: "Notion", icon: "📝", envKey: "NOTION_API_KEY", category: "integration" },
  { id: "loops", label: "Loops", icon: "💌", envKey: "LOOPS_API_KEY", category: "integration" },
  { id: "github", label: "GitHub", icon: "🐙", envKey: "GITHUB_TOKEN", category: "integration" },
  {
    id: "brave",
    label: "Brave Search",
    icon: "🦁",
    envKey: "BRAVE_API_KEY",
    category: "integration",
  },
  {
    id: "hunter",
    label: "Hunter.io",
    icon: "🎯",
    envKey: "HUNTER_API_KEY",
    category: "integration",
  },
  // ── Google OAuth integrations (refresh tokens) ─────────────────────
  // Both consume from config.integrations.* at runtime (so no envKey
  // mapping); the auth profile entries here are the discoverable view
  // of "what's connected" plus the editable manage surface.
  { id: "gmail", label: "Gmail", icon: "📧", envKey: "", category: "integration" },
  {
    id: "google-calendar",
    label: "Google Calendar",
    icon: "📅",
    envKey: "",
    category: "integration",
  },
  // ── Messaging channels (bot tokens) ────────────────────────────────
  {
    id: "telegram",
    label: "Telegram",
    icon: "✈️",
    envKey: "TELEGRAM_BOT_TOKEN",
    category: "channel",
  },
  { id: "discord", label: "Discord", icon: "🎮", envKey: "DISCORD_BOT_TOKEN", category: "channel" },
  { id: "slack", label: "Slack", icon: "💼", envKey: "SLACK_BOT_TOKEN", category: "channel" },
] as const;

export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

export function getProviderInfo(providerId: string): KnownProvider | null {
  return KNOWN_PROVIDERS.find((p) => p.id === providerId) ?? null;
}

/**
 * The subset most consumers actually want: providers the user picks a *model*
 * from. Used by the `providers.catalog.list` RPC and the Electron wizard's
 * Step 4 gateway-chat picker.
 */
export function listModelProviders(): KnownProvider[] {
  return KNOWN_PROVIDERS.filter((p) => p.category === "model");
}
