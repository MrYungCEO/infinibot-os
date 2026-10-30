/**
 * Turns a provider's raw model listing into what a setup picker should offer:
 * chat models only, nothing deprecated or shut down, a `free` flag where we can
 * back it up, and a sensible default that actually exists on the key's list.
 *
 * Pure (no I/O) so it is unit-testable against captured listings. The fetchers
 * in server-methods/quickstart-providers.ts fill the raw hints (`deprecated`,
 * `chat`, `free`) from the provider's own fields; this module applies the
 * provider rules and the maintained deny-list on top.
 *
 * FREE TABLE (where the listing carries no price):
 *   - OpenRouter: from the API — `:free` ids or prompt+completion price "0".
 *   - Google Gemini: free tier on a free API key covers every Flash and
 *     Flash-Lite model, Gemma, and Gemini 2.5 Pro. Pro previews / 3.x Pro /
 *     Gemini 4 have no free tier. Source: ai.google.dev/gemini-api/docs/pricing
 *     (checked 2026-10-17).
 *   - Groq: the free plan serves every chat model (rate-limited).
 *     Source: console.groq.com/docs/rate-limits.
 *   - Ollama (local): always free.
 *   - Ollama Cloud: the free plan only includes starter credits for an
 *     unpublished set of "starter models", so no per-model Free claim.
 */
import { RETIRED_MODEL_REPLACEMENTS } from "../agents/provider-model-defaults.js";

export interface CuratableModel {
  id: string;
  label?: string;
  contextWindow?: number;
  family?: string;
  toolUse?: boolean;
  /** Free to call on a free key / plan. */
  free?: boolean;
  /** Provider marked it deprecated, inactive or past its expiration date. */
  deprecated?: boolean;
  /** False when the listing says it can't do text chat (TTS, image, embeddings…). */
  chat?: boolean;
}

/** Known shutdowns that some listings still return. `provider/model` refs. */
export const RETIRED_MODEL_DENY_LIST: readonly string[] = [
  ...Object.keys(RETIRED_MODEL_REPLACEMENTS),
  "google/gemini-pro",
  "google/gemini-pro-vision",
  "google/gemini-1.0-pro",
  "google/gemini-2.0-flash",
  "google/gemini-2.0-flash-001",
  "google/gemini-2.0-flash-lite",
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.0-flash-exp",
];
/** Whole families that are shut down (prefix match on `provider/model`). */
const RETIRED_PREFIXES: readonly string[] = ["google/gemini-1.0-", "google/gemini-1.5-"];

/** Non-chat models that answer generateContent / chat listings. */
const NON_CHAT: Record<string, RegExp> = {
  google:
    /(tts|image|nano-banana|lyria|transcribe|robotics|computer-use|antigravity|deep-research|embedding|aqa|-live|veo|imagen)/i,
  openai: /(image|tts|transcribe|audio|realtime|embedding|moderation|search|dall-e|whisper)/i,
  groq: /(whisper|tts|playai|orpheus|guard)/i,
  mistral: /(embed|moderation|ocr)/i,
  together: /(embed|rerank|flux|stable-diffusion|whisper|tts|guard)/i,
  fireworks: /(embed|flux|whisper|stable-diffusion)/i,
};

/** Never chat models, whoever lists them (OpenRouter re-lists everyone's). */
const NON_CHAT_ANY =
  /(tts|embed|whisper|lyria|nano-banana|guard|content-safety|transcribe|:batch$|-image(-|$)|image-preview)/i;

/** Dated previews (`-preview-10-2025`, `-preview-05-20`) older than this are treated as expired. */
const PREVIEW_MAX_AGE_MS = 270 * 24 * 60 * 60 * 1000;

function canonical(provider: string): string {
  if (provider === "gemini") return "google";
  if (provider === "grok") return "xai";
  if (provider === "llama-cloud") return "llamacloud";
  return provider;
}

function isRetired(provider: string, id: string): boolean {
  const ref = `${provider}/${id}`;
  return RETIRED_MODEL_DENY_LIST.includes(ref) || RETIRED_PREFIXES.some((p) => ref.startsWith(p));
}

/** `-preview-MM-YYYY` (Gemini) dates; null when the id carries none. */
function previewDate(id: string): number | null {
  const m = /-preview-(\d{2})-(\d{4})$/.exec(id);
  if (!m) return null;
  return Date.UTC(Number(m[2]), Number(m[1]) - 1, 1);
}

function isFree(provider: string, m: CuratableModel): boolean {
  if (m.free !== undefined) return m.free;
  switch (provider) {
    case "google":
      return /flash/i.test(m.id) || /^gemma/i.test(m.id) || m.id === "gemini-2.5-pro";
    case "groq":
    case "ollama":
      return true;
    default:
      return false;
  }
}

export function curateModels<T extends CuratableModel>(
  providerRaw: string,
  models: T[],
  now = Date.now(),
): T[] {
  const provider = canonical(providerRaw);
  const nonChat = NON_CHAT[provider];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of models) {
    if (!m.id || seen.has(m.id)) continue;
    if (m.deprecated || m.chat === false) continue;
    if (nonChat?.test(m.id) || NON_CHAT_ANY.test(m.id)) continue;
    if (isRetired(provider, m.id)) continue;
    const dated = previewDate(m.id);
    if (dated !== null && now - dated > PREVIEW_MAX_AGE_MS) continue;
    seen.add(m.id);
    out.push({ ...m, free: isFree(provider, m) });
  }
  return out;
}

function versionOf(id: string, re: RegExp): number {
  const m = re.exec(id);
  return m ? Number.parseFloat(m[1]!) : -1;
}

/**
 * The model to preselect: `preferred` when the key really has it, else the
 * provider's best generally-available pick, else the first listed model.
 */
export function pickDefaultModel(
  providerRaw: string,
  models: CuratableModel[],
  preferred?: string,
): string | undefined {
  if (!models.length) return undefined;
  const ids = models.map((m) => m.id);
  if (preferred && ids.includes(preferred)) return preferred;
  const provider = canonical(providerRaw);
  if (provider === "google") {
    // Newest GA Flash (no preview / lite / -latest alias).
    const ga = /^gemini-(\d+(?:\.\d+)?)-flash$/;
    const best = ids
      .filter((id) => ga.test(id))
      .sort((a, b) => versionOf(b, ga) - versionOf(a, ga))[0];
    if (best) return best;
    const flash = ids.find((id) => /flash/.test(id) && !/preview|exp/.test(id));
    if (flash) return flash;
  }
  if (provider === "openrouter") {
    const sonnet = /^anthropic\/claude-sonnet-(\d+(?:\.\d+)?)$/;
    const best = ids
      .filter((id) => sonnet.test(id))
      .sort((a, b) => versionOf(b, sonnet) - versionOf(a, sonnet))[0];
    if (best) return best;
  }
  return ids[0];
}
