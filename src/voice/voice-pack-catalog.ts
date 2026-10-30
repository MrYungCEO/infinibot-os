/**
 * Voice-pack catalogue — static metadata for the downloadable local voice
 * stacks (Kokoro TTS, Whisper STT, Piper TTS).
 *
 * These are the OPT-IN local engines. The product default stays cloud
 * TTS/STT (zero-install, BYOK-compatible). Local packs are gated to CEO+
 * via the `infinibot_voice_pack` license feature and exist for offline /
 * privacy / premium tiers. Never bundle these binaries into the installer.
 *
 * ── CDN decision ──────────────────────────────────────────────────────────
 * Binaries are served from `INFINIBOT_VOICE_PACK_BASE` if set, else from the
 * canonical CDN `https://cdn.infinibot.app/voice-packs/`. If that domain is
 * not live yet, point the env at an operator-managed mirror.
 *
 * NOTE: the sha256 values below are PLACEHOLDERS. They MUST be rotated from
 * the real CDN artifacts before public release — see each entry's comment.
 */

export type VoicePackId = "kokoro-en" | "whisper-base" | "piper-en";

export interface VoicePackEntry {
  /** Stable identifier; also the install sub-directory under voice-packs/. */
  id: VoicePackId;
  /** Human-facing label. */
  label: string;
  /** One-line description for the UI. */
  description: string;
  /** Which engine this pack feeds. */
  engine: "tts" | "stt";
  /** Expected total download size in bytes. */
  bytes: number;
  /** Expected sha256 of the downloaded file. "TODO: rotate from CDN" = skip verify. */
  sha256: string;
  /**
   * Either a bare filename (joined with the configured base URL) or a full
   * absolute URL. Use {@link resolveVoicePackUrl} to normalize.
   */
  url: string;
  /** File name written under ~/.infinibot/voice-packs/<id>/. */
  installPath: string;
  /** License feature required to download. */
  feature: "infinibot_voice_pack";
}

/** Canonical CDN base. Override with INFINIBOT_VOICE_PACK_BASE. */
export const DEFAULT_VOICE_PACK_BASE = "https://cdn.infinibot.app/voice-packs/";

export const VOICE_PACKS: Record<VoicePackId, VoicePackEntry> = {
  "kokoro-en": {
    id: "kokoro-en",
    label: "Kokoro (English) — Local TTS",
    description: "Kokoro v0.19 ONNX English voices for offline text-to-speech.",
    engine: "tts",
    // ~310 MB ONNX model + voices bundle.
    bytes: 325_058_560,
    // TODO: rotate from CDN — placeholder, do not ship publicly with this.
    sha256: "TODO: rotate from CDN",
    url: "kokoro-en/kokoro-v0_19.onnx.tar.gz",
    installPath: "kokoro-v0_19.onnx.tar.gz",
    feature: "infinibot_voice_pack",
  },
  "whisper-base": {
    id: "whisper-base",
    label: "Whisper Base — Local STT",
    description: "OpenAI Whisper base.en GGML model for offline speech-to-text.",
    engine: "stt",
    // ~142 MB ggml base.en model.
    bytes: 147_951_616,
    // TODO: rotate from CDN — placeholder, do not ship publicly with this.
    sha256: "TODO: rotate from CDN",
    url: "whisper-base/ggml-base.en.bin",
    installPath: "ggml-base.en.bin",
    feature: "infinibot_voice_pack",
  },
  "piper-en": {
    id: "piper-en",
    label: "Piper (English) — Local TTS",
    description: "Piper en_US-amy medium voice for fast offline text-to-speech.",
    engine: "tts",
    // ~63 MB onnx + json config tarball.
    bytes: 66_060_288,
    // TODO: rotate from CDN — placeholder, do not ship publicly with this.
    sha256: "TODO: rotate from CDN",
    url: "piper-en/en_US-amy-medium.tar.gz",
    installPath: "en_US-amy-medium.tar.gz",
    feature: "infinibot_voice_pack",
  },
};

/** Returns the configured base URL (env override → CDN default). Always ends with "/". */
export function voicePackBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INFINIBOT_VOICE_PACK_BASE?.trim();
  const base = override && override.length > 0 ? override : DEFAULT_VOICE_PACK_BASE;
  return base.endsWith("/") ? base : `${base}/`;
}

/** Resolve a pack's full download URL, honoring absolute `url` values. */
export function resolveVoicePackUrl(
  entry: VoicePackEntry,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (/^https?:\/\//i.test(entry.url)) return entry.url;
  // Strip any leading slash so it joins cleanly onto the base.
  return voicePackBaseUrl(env) + entry.url.replace(/^\/+/, "");
}

/** Whether the catalogue entry has a real sha256 (vs the TODO placeholder). */
export function hasRealSha256(entry: VoicePackEntry): boolean {
  return /^[0-9a-f]{64}$/i.test(entry.sha256.trim());
}

export function listVoicePacks(): VoicePackEntry[] {
  return Object.values(VOICE_PACKS);
}

export function getVoicePack(id: string): VoicePackEntry | undefined {
  return (VOICE_PACKS as Record<string, VoicePackEntry>)[id];
}
