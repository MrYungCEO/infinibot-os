/**
 * Self-heal known schema requirements before writing config to disk.
 *
 * Strict validation is desirable (it catches typos early), but a partially
 * complete config from one wizard step shouldn't block a later step from
 * saving. The most common case: a previous run left
 * `models.providers.anthropic` with no `models: []` array because the
 * user bailed before fetching the live model list. Subsequent writers
 * that didn't author `models.providers` would still trip strict validation
 * when they tried to write back the unmodified block.
 *
 * Both `quickstart.applyPatch` and `notion-config.writeNotionConfig` go
 * through this helper so step order can't strand the user with an
 * unsavable file.
 */

export function sanitizeMergedConfig(cfg: Record<string, unknown>): void {
  // Each ModelProviderConfig must have a `models: []` array and a string
  // `baseUrl`. Backfill with sensible defaults when missing.
  const models = cfg.models as Record<string, unknown> | undefined;
  if (models && typeof models === "object") {
    const providers = models.providers as Record<string, unknown> | undefined;
    if (providers && typeof providers === "object") {
      for (const [name, raw] of Object.entries(providers)) {
        if (!raw || typeof raw !== "object") {
          delete providers[name];
          continue;
        }
        const prov = raw as Record<string, unknown>;
        if (!Array.isArray(prov.models)) prov.models = [];
        if (typeof prov.baseUrl !== "string" || !prov.baseUrl) {
          prov.baseUrl = defaultBaseUrlFor(name);
        }
      }
    }
  }
}

export function defaultBaseUrlFor(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "zai":
      return "https://api.z.ai/api/paas/v4";
    case "ollama":
      return "http://localhost:11434";
    case "ollama-cloud":
      return "https://ollama.com/v1";
    default:
      return "https://api.anthropic.com/v1";
  }
}
