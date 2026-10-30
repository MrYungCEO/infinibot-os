// Defaults for agent metadata when upstream does not supply them.
//
// Default provider is OpenRouter (configurable via VITE_OPENROUTER_API_KEY /
// OPENROUTER_API_KEY) so the gateway works out of the box with a single key.
// Override per-agent via config or INFINIBOT_DEFAULT_PROVIDER env var.
export const DEFAULT_PROVIDER = "openrouter";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
// Context window: Opus 4.5 supports ~200k tokens (per pi-ai models.generated.ts).
export const DEFAULT_CONTEXT_TOKENS = 200_000;
