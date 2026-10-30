/**
 * Point InfiniBot at the voice engines the one-click setup started, using the
 * same stores the rest of voice reads:
 *   - voice.json         → mode "docker" (STT/TTS routes go to Speaches/Kokoro)
 *   - infinibot.json     → voice.kokoroUrl / voice.speachesUrl (+ autoFromMaster
 *                          false so a satellite's auto-wire doesn't undo it)
 * Existing push-to-talk / wake-word settings are kept.
 */

import { loadVoiceConfig, normalizeVoiceConfig, saveVoiceConfig } from "../config.js";
import { readSetupState } from "./runner.js";

export async function wireLocalVoiceConfig(s: {
  kokoroUrl: string;
  speachesUrl: string;
  sttModel?: string;
}): Promise<void> {
  const prev = loadVoiceConfig();
  saveVoiceConfig(
    normalizeVoiceConfig({
      ...(prev ?? {}),
      mode: "docker",
      stt: { provider: "native", model: s.sttModel ?? prev?.stt.model },
      tts: { provider: "native", voice: prev?.tts.voice },
    }),
  );

  const { readConfigFileSnapshot, writeConfigFile } = await import("../../../config/io.js");
  const snapshot = await readConfigFileSnapshot();
  const parsed = snapshot.parsed;
  const current: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  const voice = (current.voice ?? {}) as Record<string, unknown>;
  if (
    voice.kokoroUrl === s.kokoroUrl &&
    voice.speachesUrl === s.speachesUrl &&
    voice.autoFromMaster === false
  )
    return;
  current.voice = {
    ...voice,
    kokoroUrl: s.kokoroUrl,
    speachesUrl: s.speachesUrl,
    autoFromMaster: false,
  };
  const { sanitizeMergedConfig } = await import("../../../config/sanitize.js");
  sanitizeMergedConfig(current);
  await writeConfigFile(current as never);
}

/** The Whisper model the setup installed (CPU installs use a smaller one), if any. */
export function setupSttModel(): string | undefined {
  const s = readSetupState();
  return s?.phase === "done" ? s.services.speaches?.model : undefined;
}

/** The Kokoro container the setup manages (for the bootstrap's restart), if any. */
export function setupKokoroContainer(): string | null {
  const s = readSetupState();
  const k = s?.services.kokoro;
  return s?.phase === "done" && k?.container ? k.container : null;
}

/** Launch settings of the built-in engine when this install uses it. */
export function setupNativeEngine(): import("../native-engine/supervisor.js").EngineConfig | null {
  const s = readSetupState();
  return s?.engine === "native" && s.nativeEngine ? s.nativeEngine : null;
}

/** This install's voice runs in containers the one-click setup manages. */
export function setupUsesDocker(): boolean {
  const s = readSetupState();
  return s?.engine === "docker" && s.phase === "done";
}

/**
 * Start the built-in engine if this install uses it and it isn't running.
 * Returns true when the built-in engine is this install's voice (so Docker
 * bootstraps stay out of the way).
 */
export async function ensureNativeVoiceEngine(): Promise<boolean> {
  const cfg = setupNativeEngine();
  if (!cfg) return false;
  const { getVoiceEngine } = await import("../native-engine/supervisor.js");
  const engine = getVoiceEngine();
  if (!engine.isRunning()) engine.start(cfg);
  return true;
}
