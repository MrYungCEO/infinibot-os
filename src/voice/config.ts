/**
 * Voice-setup config: load, validate, migrate, save.
 *
 * The unified voice config lives under the top-level `voice` block in
 * `infinibot.json` (see src/config/types.infinibot.ts). This module is the
 * one place that reads/writes the setup-relevant fields and performs the
 * one-shot migration from the legacy flat `voice-settings.json`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/io.js";
import type { InfinibotConfig } from "../config/config.js";
import {
  isPlausibleApiKey,
  loadVoiceConfig,
  saveVoiceConfig,
  voiceSetupToRuntimeConfig,
} from "../gateway/voice/config.js";
import {
  DEFAULT_KOKORO_VOICE,
  DEFAULT_NATIVE_STT_MODEL,
  DEFAULT_PIPER_VOICE,
  VoiceSetupSchema,
  type VoiceSetupConfig,
} from "./schema.js";

/** Legacy flat settings file (cwd-relative, matching server-voice-config.ts). */
export const LEGACY_VOICE_SETTINGS_FILE = path.join(process.cwd(), "voice-settings.json");

export type LegacyVoiceSettings = {
  tts_provider?: string;
  tts_voice?: string;
  tts_voice_kokoro?: string;
  tts_voice_piper?: string;
  tts_voice_elevenlabs?: string;
  elevenlabs_api_key?: string;
  wake_word_enabled?: boolean;
  voice_route?: string;
};

function readLegacySettings(file = LEGACY_VOICE_SETTINGS_FILE): LegacyVoiceSettings | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as LegacyVoiceSettings) : null;
  } catch {
    return null;
  }
}

/**
 * Translate the legacy flat `voice-settings.json` into the unified shape.
 * Pure — no I/O — so it's directly unit-testable.
 *
 * Mapping:
 *   tts_provider kokoro|piper  → provider: "native"
 *   tts_provider elevenlabs|openai|edge → provider: "cloud"
 *   (unset / unknown)          → defaults to native/kokoro
 */
export function migrateLegacyVoiceSettings(legacy: LegacyVoiceSettings | null): VoiceSetupConfig {
  const provider = (legacy?.tts_provider ?? "kokoro").toLowerCase();

  if (provider === "elevenlabs" || provider === "openai" || provider === "edge") {
    const tts = provider as "elevenlabs" | "openai" | "edge";
    const apiKey = legacy?.elevenlabs_api_key ?? "";
    const cloud: VoiceSetupConfig["cloud"] = {
      stt: "openai",
      tts,
      apiKey,
      ...(tts === "elevenlabs" && legacy?.tts_voice_elevenlabs
        ? { ttsVoice: legacy.tts_voice_elevenlabs }
        : legacy?.tts_voice
          ? { ttsVoice: legacy.tts_voice }
          : {}),
    };
    return { provider: "cloud", cloud };
  }

  // Native (default). kokoro|piper or anything unrecognized → kokoro.
  const tts = provider === "piper" ? "piper" : "kokoro";
  const ttsVoice =
    tts === "piper"
      ? (legacy?.tts_voice_piper ?? DEFAULT_PIPER_VOICE)
      : (legacy?.tts_voice_kokoro ?? DEFAULT_KOKORO_VOICE);
  return {
    provider: "native",
    native: {
      tts,
      ttsVoice,
      sttModel: DEFAULT_NATIVE_STT_MODEL,
      wakeWord: legacy?.wake_word_enabled ?? false,
    },
  };
}

/** Extract & validate the setup fields from a config's `voice` block. */
function parseSetupFromConfig(cfg: InfinibotConfig): VoiceSetupConfig | null {
  const v = cfg.voice as Record<string, unknown> | undefined;
  if (!v || typeof v.provider !== "string") return null;
  const parsed = VoiceSetupSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/**
 * Load the unified voice setup. If the config has no `voice.provider` yet,
 * run the one-shot migration from `voice-settings.json` and persist it, then
 * return the migrated value. Returns null only when neither source exists
 * (truly unconfigured — the wizard hasn't run).
 */
export async function loadVoiceSetup(): Promise<VoiceSetupConfig | null> {
  const cfg = loadConfig();
  const fromConfig = parseSetupFromConfig(cfg);
  if (fromConfig) return fromConfig;

  // Nothing in config yet — attempt one-shot migration from the legacy file.
  const legacy = readLegacySettings();
  if (!legacy) return null;
  const migrated = migrateLegacyVoiceSettings(legacy);
  // Persist so this only happens once.
  await saveVoiceSetup(migrated);
  return migrated;
}

/** Synchronous best-effort read (no migration write). For hot paths like the
 *  router that must not block on disk writes. */
export function loadVoiceSetupSync(): VoiceSetupConfig | null {
  const cfg = loadConfig();
  const fromConfig = parseSetupFromConfig(cfg);
  if (fromConfig) return fromConfig;
  const legacy = readLegacySettings();
  return legacy ? migrateLegacyVoiceSettings(legacy) : null;
}

/** Validate + persist a voice setup into `infinibot.json`'s `voice` block,
 *  preserving any federation endpoint-override keys already present. */
export async function saveVoiceSetup(setup: VoiceSetupConfig): Promise<VoiceSetupConfig> {
  const validated = VoiceSetupSchema.parse(setup);
  const snapshot = await readConfigFileSnapshot();
  const base: InfinibotConfig = snapshot.valid ? snapshot.config : (snapshot.config ?? {});
  const existingVoice = (base.voice ?? {}) as Record<string, unknown>;
  // Drop any stale setup fields before re-applying, but keep endpoint keys.
  const { provider: _p, cloud: _c, native: _n, fallback: _f, ...endpointKeys } = existingVoice;
  const nextVoice = {
    ...endpointKeys,
    provider: validated.provider,
    ...(validated.cloud ? { cloud: validated.cloud } : {}),
    ...(validated.native ? { native: validated.native } : {}),
    ...(validated.fallback ? { fallback: validated.fallback } : {}),
  };
  await writeConfigFile({ ...base, voice: nextVoice } as InfinibotConfig);

  // ── Bridge to the runtime store ───────────────────────────────────────────
  // The runtime ONLY reads ~/.infinibot/voice.json. Translate the rich setup
  // into that schema and persist it so the CLI onboard/setup path is no longer
  // a silent no-op. Never let a voice.json failure roll back the (already
  // committed) infinibot.json write — log and continue.
  try {
    const runtime = voiceSetupToRuntimeConfig(validated);
    // apiKey shape validation before save (cloud paths only).
    if (
      runtime.mode === "cloud" &&
      runtime.stt.provider !== "native" &&
      !isPlausibleApiKey(runtime.stt.apiKey)
    ) {
      console.warn(
        "[voice-setup] cloud config has an implausible API key; writing voice.json anyway",
      );
    }
    saveVoiceConfig(runtime);
    console.log(
      `[voice-setup] bridged voice setup → voice.json (mode=${runtime.mode}, stt=${runtime.stt.provider}, tts=${runtime.tts.provider})`,
    );
  } catch (err) {
    console.warn(`[voice-setup] failed to bridge setup into voice.json: ${String(err)}`);
  }

  return validated;
}

/**
 * One-shot startup migrator. When the runtime store (voice.json) is absent but
 * the rich infinibot.json::voice block exists (e.g. an install that only ran
 * the CLI onboard before this bridge landed), translate it forward and stamp
 * `migratedAt` so it runs exactly once. Idempotent: a present voice.json (even
 * one already carrying migratedAt) short-circuits.
 *
 * Returns true when a migration was performed, false when skipped.
 */
export function migrateInfinibotVoiceToRuntime(): boolean {
  try {
    // voice.json already present → nothing to migrate (and never overwrite it).
    if (loadVoiceConfig()) return false;
    const setup = parseSetupFromConfig(loadConfig());
    if (!setup) return false; // no rich config to migrate from
    const runtime = voiceSetupToRuntimeConfig(setup);
    runtime.migratedAt = new Date().toISOString();
    saveVoiceConfig(runtime);
    console.log(`[voice-setup] migrated infinibot.json::voice → voice.json (mode=${runtime.mode})`);
    return true;
  } catch (err) {
    console.warn(`[voice-setup] migration check failed: ${String(err)}`);
    return false;
  }
}

/** True once the unified config has a provider set (used to gate the wizard
 *  "already configured" branch and the smoke-test banner). */
export function isVoiceConfigured(): boolean {
  return parseSetupFromConfig(loadConfig()) !== null;
}
