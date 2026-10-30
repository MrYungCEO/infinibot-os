/**
 * The one provider → logo map. Every brain/provider/CLI picker resolves its
 * logo here and renders it through <ib-provider-logo>.
 *
 * Marks live in provider-logos.data.ts (bundled, so they work offline in the
 * desktop app). Taking a key out of PROVIDER_LOGO_MARKS turns that brand back
 * into a lettermark everywhere at once. See docs/licensing/BRAND-USAGE.md.
 */
import { PROVIDER_LOGO_MARKS, type ProviderLogoMark } from "./provider-logos.data";

export type ProviderLogoId = keyof typeof PROVIDER_LOGO_MARKS;

/** Ids used across the catalogue, CLI backends and model refs → the mark they show. */
const ALIASES: Record<string, ProviderLogoId> = {
  anthropic: "claude",
  "claude-code": "claude",
  "claude-cli": "claude",
  chatgpt: "openai",
  // The subscription card is the ChatGPT account, so it shows OpenAI; the "codex" coder keeps its own mark.
  "codex-cli": "openai",
  google: "gemini",
  "google-gemini": "gemini",
  "gemini-cli": "gemini",
  xai: "grok",
  "grok-cli": "grok",
  "opencode-cli": "opencode",
  "ollama-cloud": "ollama",
  moonshot: "kimi",
  alibaba: "qwen",
  dashscope: "qwen",
  zhipu: "zai",
  glm: "zai",
  llamacloud: "llamaindex",
  kinglyvault: "kv",
};

export function providerLogoId(id: string | null | undefined): ProviderLogoId | null {
  // Also accepts display labels ("Ollama Cloud", "xAI (Grok)", "Z.ai").
  const key = (id ?? "").replace(/\(.*?\)/g, "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "-");
  if (key in PROVIDER_LOGO_MARKS) return key as ProviderLogoId;
  return ALIASES[key] ?? null;
}

export function providerLogoMark(id: string | null | undefined): ProviderLogoMark | null {
  const logo = providerLogoId(id);
  return logo ? PROVIDER_LOGO_MARKS[logo] : null;
}

/** Fallback for anything without a mark: 1–2 letters from the label, else the id. */
export function providerLetters(label: string | null | undefined, id?: string | null): string {
  const [first = "", second = ""] = (label || id || "").replace(/\(.*?\)/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!first) return "?";
  if (second) return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase();
  return first.slice(0, 1).toUpperCase() + first.slice(1, 2).toLowerCase();
}
