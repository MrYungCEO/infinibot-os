/**
 * Voice stack configuration — the single source of truth.
 *
 *   ~/.infinibot/voice.json = { mode, stt:{provider,model,apiKey?}, tts:{provider,voice,apiKey?} }
 *
 * No new .env files. API keys may live in voice.json (written by the wizard)
 * OR in the environment — resolveSttApiKey/resolveTtsApiKey check config first,
 * then provider-specific env vars.
 *
 * When voice.json is ABSENT the gateway falls back to the legacy Docker voice
 * path (Kokoro + Speaches containers) so existing Docker installs are
 * unaffected — see server-voice-tts.ts / server-voice-stt.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { STATE_DIR, resolveStateDir } from "../../config/paths.js";
import { isSaasTenantScope } from "../../saas/tenant-config.js";
import type { VoiceSetupConfig } from "../../voice/schema.js";

export type VoiceMode = "cloud" | "native" | "docker";

/**
 * Which node serves voice for THIS install:
 *   - "master" → use the configured/federation URLs (a satellite points at the
 *     master's containers; a standalone resolves to localhost). Default.
 *   - "local"  → force this node's OWN local Docker containers (localhost),
 *     ignoring any master-derived URLs. The satellite-wide voice toggle.
 * Routing applies automatic fallback to the other node when the selected side
 * is unreachable (see server-voice-urls.ts).
 */
export type VoiceNode = "local" | "master";

export type SttProviderId = "groq" | "deepgram" | "openai" | "native";
export type TtsProviderId = "elevenlabs" | "openai" | "cartesia" | "native";

export interface VoiceSttConfig {
  provider: SttProviderId;
  model?: string;
  apiKey?: string;
  /** Absolute path to the native STT binary (whisper.cpp), written by the
   *  installer. The router reads this when present; otherwise it falls back to
   *  whisperBinaryPath(). Only set for provider === 'native'. */
  binary?: string;
  /** Absolute path to the native STT model file (.bin), written by the installer. */
  modelPath?: string;
}

export interface VoiceTtsConfig {
  provider: TtsProviderId;
  voice?: string;
  apiKey?: string;
  /** Absolute path to the native TTS voice file (piper .onnx), written by the
   *  installer when piper is the native engine. kokoro-js downloads its own
   *  weights so this stays unset for the kokoro path. */
  voicePath?: string;
}

/** Input bindings: push-to-talk hotkey + wake-word toggle. Persisted alongside
 *  the stack so the wizard and CLI both round-trip them. */
export interface VoiceInputConfig {
  /** Push-to-talk hotkey. Default Ctrl+Space. */
  hotkey?: string;
  /** Wake-word listening enabled. Default false. */
  wakeWord?: boolean;
}

/** Default push-to-talk hotkey when none is chosen. */
export const DEFAULT_HOTKEY = "Ctrl+Space";

export interface VoiceConfig {
  mode: VoiceMode;
  stt: VoiceSttConfig;
  tts: VoiceTtsConfig;
  input?: VoiceInputConfig;
  /** Satellite-wide voice node selection (local Docker vs master). Default
   *  "master" preserves the pre-toggle behavior. */
  voiceNode?: VoiceNode;
  /** Set by the one-shot infinibot.json→voice.json migrator (ISO timestamp). */
  migratedAt?: string;
}

export const VOICE_CONFIG_PATH = path.join(STATE_DIR, "voice.json");

/** voice.json for the current scope — a SaaS member's lives in its own namespace. */
export function resolveVoiceConfigPath(): string {
  return isSaasTenantScope() ? path.join(resolveStateDir(), "voice.json") : VOICE_CONFIG_PATH;
}

/** Default cloud stack: Groq STT + ElevenLabs TTS. */
export const DEFAULT_CLOUD_CONFIG: VoiceConfig = {
  mode: "cloud",
  stt: { provider: "groq", model: "whisper-large-v3-turbo" },
  tts: { provider: "elevenlabs", voice: "onwK4e9ZLuTAKqWW03F9" },
};

/** Default native stack: whisper.cpp base.en + Kokoro am_puck. */
export const DEFAULT_NATIVE_CONFIG: VoiceConfig = {
  mode: "native",
  stt: { provider: "native", model: "ggml-base.en" },
  tts: { provider: "native", voice: "am_puck" },
};

const STT_PROVIDERS = new Set<SttProviderId>(["groq", "deepgram", "openai", "native"]);
const TTS_PROVIDERS = new Set<TtsProviderId>(["elevenlabs", "openai", "cartesia", "native"]);

/** Read voice.json. Returns null when the file is absent (→ legacy Docker path). */
export function loadVoiceConfig(): VoiceConfig | null {
  try {
    const file = resolveVoiceConfigPath();
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return normalizeVoiceConfig(raw);
  } catch (err) {
    console.warn("[voice-config] failed to read voice.json:", err);
    return null;
  }
}

/** Coerce arbitrary JSON into a valid VoiceConfig, filling defaults. */
export function normalizeVoiceConfig(raw: unknown): VoiceConfig {
  const o = (raw ?? {}) as Partial<VoiceConfig> & Record<string, any>;
  const mode: VoiceMode =
    o.mode === "native" || o.mode === "docker" || o.mode === "cloud" ? o.mode : "cloud";
  const base = mode === "native" ? DEFAULT_NATIVE_CONFIG : DEFAULT_CLOUD_CONFIG;

  const sttProvider: SttProviderId = STT_PROVIDERS.has(o.stt?.provider as SttProviderId)
    ? (o.stt!.provider as SttProviderId)
    : base.stt.provider;
  const ttsProvider: TtsProviderId = TTS_PROVIDERS.has(o.tts?.provider as TtsProviderId)
    ? (o.tts!.provider as TtsProviderId)
    : base.tts.provider;

  const input: VoiceInputConfig | undefined =
    o.input && typeof o.input === "object"
      ? {
          hotkey:
            typeof o.input.hotkey === "string" && o.input.hotkey.trim()
              ? o.input.hotkey.trim()
              : DEFAULT_HOTKEY,
          wakeWord: o.input.wakeWord === true,
        }
      : undefined;

  return {
    mode,
    stt: {
      provider: sttProvider,
      model: o.stt?.model ?? base.stt.model,
      apiKey: typeof o.stt?.apiKey === "string" ? o.stt.apiKey : undefined,
      ...(typeof o.stt?.binary === "string" ? { binary: o.stt.binary } : {}),
      ...(typeof o.stt?.modelPath === "string" ? { modelPath: o.stt.modelPath } : {}),
    },
    tts: {
      provider: ttsProvider,
      voice: o.tts?.voice ?? base.tts.voice,
      apiKey: typeof o.tts?.apiKey === "string" ? o.tts.apiKey : undefined,
      ...(typeof o.tts?.voicePath === "string" ? { voicePath: o.tts.voicePath } : {}),
    },
    ...(input ? { input } : {}),
    ...(o.voiceNode === "local" || o.voiceNode === "master" ? { voiceNode: o.voiceNode } : {}),
    ...(typeof o.migratedAt === "string" ? { migratedAt: o.migratedAt } : {}),
  };
}

/**
 * Persist voice.json atomically (temp-write + rename) so a concurrent reader
 * never sees a half-written file and a crashed write can't corrupt the store.
 * Idempotent: writing the same config twice yields byte-identical output.
 */
export function saveVoiceConfig(cfg: VoiceConfig): void {
  const file = resolveVoiceConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(cfg, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, file);
}

// ── Bridge: rich infinibot.json voice setup → runtime voice.json ────────────
// The CLI `onboard`/`setup` wizard persists a rich {provider,cloud,native,
// fallback} block into infinibot.json. The runtime ONLY reads voice.json, so
// without this translation the CLI path is a silent no-op. saveVoiceSetup
// (src/voice/config.ts) calls this after the infinibot.json write so both
// stores converge; the startup migrator below uses it for legacy installs.

/** Lightweight API-key shape guard — rejects obviously-bad keys before save. */
export function isPlausibleApiKey(key: string | undefined): boolean {
  if (typeof key !== "string") return false;
  const k = key.trim();
  // Non-empty, no whitespace, and long enough to be a real token (not "x").
  return k.length >= 8 && !/\s/.test(k);
}

/**
 * Translate the rich voice-setup shape into the runtime VoiceConfig.
 *
 * Rules (one comment per branch, per the setup spec):
 *   cloud   → mode 'cloud'  + apiKey on stt/tts
 *   native  → mode 'native' + local whisper model id
 *   (docker endpoints live in infinibot.json::voice and are untouched here)
 */
export function voiceSetupToRuntimeConfig(setup: VoiceSetupConfig): VoiceConfig {
  // Wake-word rides on the rich native block; cloud has no wake-word field.
  const input: VoiceInputConfig = {
    hotkey: DEFAULT_HOTKEY,
    wakeWord: setup.native?.wakeWord ?? false,
  };

  if (setup.provider === "cloud") {
    const c = setup.cloud!;
    // cloud STT is OpenAI-only in the managed path → provider 'openai' + key.
    const stt: VoiceSttConfig = { provider: "openai", model: "whisper-1", apiKey: c.apiKey };
    let tts: VoiceTtsConfig;
    if (c.tts === "elevenlabs") {
      // elevenlabs → same runtime provider, share the managed key.
      tts = {
        provider: "elevenlabs",
        voice: c.ttsVoice ?? DEFAULT_CLOUD_CONFIG.tts.voice,
        apiKey: c.apiKey,
      };
    } else if (c.tts === "openai") {
      // openai TTS → runtime 'openai', default voice 'alloy', share the key.
      tts = { provider: "openai", voice: c.ttsVoice ?? "alloy", apiKey: c.apiKey };
    } else {
      // edge → no runtime equivalent (runtime TTS is elevenlabs|openai|cartesia|
      // native). Fall back to local/native TTS so speech still works.
      tts = { provider: "native", voice: c.ttsVoice ?? DEFAULT_NATIVE_CONFIG.tts.voice };
    }
    return { mode: "cloud", stt, tts, input };
  }

  // native → local whisper STT (runtime 'native' encodes local whisper; the
  // whisper model id rides in `model`) + local TTS engine.
  const n = setup.native!;
  return {
    mode: "native",
    stt: { provider: "native", model: n.sttModel ?? DEFAULT_NATIVE_CONFIG.stt.model },
    tts: { provider: "native", voice: n.ttsVoice ?? DEFAULT_NATIVE_CONFIG.tts.voice },
    input,
  };
}

/** Load voice.json or return the cloud default (without writing it). */
export function loadVoiceConfigOrDefault(): VoiceConfig {
  return loadVoiceConfig() ?? DEFAULT_CLOUD_CONFIG;
}

/**
 * Persist the input bindings (push-to-talk hotkey + wake-word) onto the current
 * voice.json without disturbing the stack. Used by the CLI wizard so the chosen
 * hotkey survives the bridge (which only knows the default). Idempotent.
 *
 * TODO(input-runtime): no global hotkey reader exists in the gateway/CLI yet;
 * these values currently only round-trip through config. Wire a reader here when
 * one lands (web client already PTTs via the browser).
 */
export function setVoiceInput(input: VoiceInputConfig): VoiceConfig {
  const cfg = loadVoiceConfigOrDefault();
  const next: VoiceConfig = {
    ...cfg,
    input: {
      hotkey: input.hotkey?.trim() || cfg.input?.hotkey || DEFAULT_HOTKEY,
      wakeWord: input.wakeWord ?? cfg.input?.wakeWord ?? false,
    },
  };
  saveVoiceConfig(next);
  return next;
}

/**
 * Read the selected voice node (local Docker vs master), defaulting to
 * "master" — i.e. use the configured/federation URLs — when unset. Cheap;
 * reads voice.json (which has its own callers' caching upstream).
 */
export function resolveVoiceNode(): VoiceNode {
  const cfg = loadVoiceConfig();
  return cfg?.voiceNode === "local" ? "local" : "master";
}

/**
 * Persist the satellite-wide voice node selection onto voice.json without
 * disturbing the rest of the stack. Creates a default cloud config first if
 * voice.json is absent so the toggle is always honored. Idempotent.
 */
export function setVoiceNode(node: VoiceNode): VoiceConfig {
  const cfg = loadVoiceConfigOrDefault();
  const next: VoiceConfig = { ...cfg, voiceNode: node };
  saveVoiceConfig(next);
  return next;
}

// ── API key resolution ──────────────────────────────────────────────────────
// config.apiKey wins; otherwise provider-specific env vars. No new .env files —
// the existing process environment is consulted directly.

export const STT_ENV_KEYS: Record<SttProviderId, string[]> = {
  groq: ["GROQ_API_KEY"],
  deepgram: ["DEEPGRAM_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  native: [],
};

export const TTS_ENV_KEYS: Record<TtsProviderId, string[]> = {
  elevenlabs: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  cartesia: ["CARTESIA_API_KEY"],
  native: [],
};

// ── Provider catalog (single source of truth for the onboarding wizard) ──────
// The setup wizard renders cloud provider rows from this catalog via the
// `/api/voice/catalog` endpoint, so the provider list / env-key names never
// drift out of sync with the resolver maps above.

/** Where to get an API key for each cloud provider. */
export const VOICE_SIGNUP_URLS: Record<string, string> = {
  groq: "https://console.groq.com/keys",
  deepgram: "https://console.deepgram.com/",
  openai: "https://platform.openai.com/api-keys",
  elevenlabs: "https://elevenlabs.io/app/settings/api-keys",
  cartesia: "https://play.cartesia.ai/keys",
};

export interface VoiceProviderInfo {
  id: SttProviderId | TtsProviderId;
  kind: "stt" | "tts";
  label: string;
  /** Default model (STT) or voice (TTS) id. */
  default?: string;
  /** Env vars consulted for the key, in priority order. */
  envKeys: string[];
  signupUrl?: string;
  recommended?: boolean;
}

export const VOICE_STT_CATALOG: VoiceProviderInfo[] = [
  {
    id: "groq",
    kind: "stt",
    label: "Groq (Whisper)",
    default: "whisper-large-v3-turbo",
    envKeys: STT_ENV_KEYS.groq,
    signupUrl: VOICE_SIGNUP_URLS.groq,
    recommended: true,
  },
  {
    id: "deepgram",
    kind: "stt",
    label: "Deepgram",
    default: "nova-2",
    envKeys: STT_ENV_KEYS.deepgram,
    signupUrl: VOICE_SIGNUP_URLS.deepgram,
  },
  {
    id: "openai",
    kind: "stt",
    label: "OpenAI (Whisper)",
    default: "whisper-1",
    envKeys: STT_ENV_KEYS.openai,
    signupUrl: VOICE_SIGNUP_URLS.openai,
  },
];

export const VOICE_TTS_CATALOG: VoiceProviderInfo[] = [
  {
    id: "elevenlabs",
    kind: "tts",
    label: "ElevenLabs",
    default: DEFAULT_CLOUD_CONFIG.tts.voice,
    envKeys: TTS_ENV_KEYS.elevenlabs,
    signupUrl: VOICE_SIGNUP_URLS.elevenlabs,
    recommended: true,
  },
  {
    id: "cartesia",
    kind: "tts",
    label: "Cartesia (Sonic)",
    default: "sonic-english",
    envKeys: TTS_ENV_KEYS.cartesia,
    signupUrl: VOICE_SIGNUP_URLS.cartesia,
  },
  {
    id: "openai",
    kind: "tts",
    label: "OpenAI (TTS)",
    default: "alloy",
    envKeys: TTS_ENV_KEYS.openai,
    signupUrl: VOICE_SIGNUP_URLS.openai,
  },
];

export interface VoiceCatalog {
  stt: Array<VoiceProviderInfo & { envDetected: boolean }>;
  tts: Array<VoiceProviderInfo & { envDetected: boolean }>;
  /** Current persisted config (keys redacted to booleans), or null if absent. */
  current: {
    mode: VoiceMode;
    stt: { provider: SttProviderId; model?: string; hasKey: boolean };
    tts: { provider: TtsProviderId; voice?: string; hasKey: boolean };
  } | null;
}

/** Build the wizard-facing catalog: providers + per-provider env detection +
 *  the current (redacted) config. Never returns raw key material. */
export function buildVoiceCatalog(): VoiceCatalog {
  const stt = VOICE_STT_CATALOG.map((p) => ({ ...p, envDetected: Boolean(pickEnv(p.envKeys)) }));
  const tts = VOICE_TTS_CATALOG.map((p) => ({ ...p, envDetected: Boolean(pickEnv(p.envKeys)) }));
  const cfg = loadVoiceConfig();
  const current = cfg
    ? {
        mode: cfg.mode,
        stt: {
          provider: cfg.stt.provider,
          model: cfg.stt.model,
          hasKey: Boolean(resolveSttApiKey(cfg.stt)),
        },
        tts: {
          provider: cfg.tts.provider,
          voice: cfg.tts.voice,
          hasKey: Boolean(resolveTtsApiKey(cfg.tts)),
        },
      }
    : null;
  return { stt, tts, current };
}

/** True when voice.json exists AND the selected providers have a resolvable
 *  key (cloud) or are native. Used by the dashboard "set up voice" card. */
export function isVoiceConfigured(): boolean {
  const cfg = loadVoiceConfig();
  if (!cfg) return false;
  const sttOk = cfg.stt.provider === "native" || Boolean(resolveSttApiKey(cfg.stt));
  const ttsOk = cfg.tts.provider === "native" || Boolean(resolveTtsApiKey(cfg.tts));
  return sttOk && ttsOk;
}

function pickEnv(names: string[]): string | undefined {
  // SaaS member: the process env carries the operator's voice keys, not theirs.
  if (isSaasTenantScope()) return undefined;
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function resolveSttApiKey(cfg: VoiceSttConfig): string | undefined {
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
  return pickEnv(STT_ENV_KEYS[cfg.provider] ?? []);
}

export function resolveTtsApiKey(cfg: VoiceTtsConfig): string | undefined {
  if (cfg.apiKey && cfg.apiKey.trim()) return cfg.apiKey.trim();
  return pickEnv(TTS_ENV_KEYS[cfg.provider] ?? []);
}

/** True when ANY cloud provider key is present in the environment. */
export function anyCloudKeyInEnv(): boolean {
  return Boolean(
    pickEnv([
      "GROQ_API_KEY",
      "ELEVENLABS_API_KEY",
      "XI_API_KEY",
      "OPENAI_API_KEY",
      "DEEPGRAM_API_KEY",
      "CARTESIA_API_KEY",
    ]),
  );
}
