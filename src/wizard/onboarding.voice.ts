/**
 * Wizard step — "Voice setup".
 *
 * One choice screen: Cloud (managed providers) vs Native (local models) vs
 * Skip. Persists into the unified `voice` block via `saveVoiceSetup`. The
 * step is prompter-driven so it works in both the clack CLI wizard and any
 * other `WizardPrompter` implementation, and is unit-testable with a mock.
 */
import type { InfinibotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  DEFAULT_KOKORO_VOICE,
  DEFAULT_NATIVE_STT_MODEL,
  type VoiceCloudTtsProvider,
  type VoiceSetupConfig,
} from "../voice/schema.js";
import { saveVoiceSetup } from "../voice/config.js";
import { setVoiceInput, DEFAULT_HOTKEY } from "../gateway/voice/config.js";
import { detectNativeModels, validateCloudVoiceKey } from "../voice/validate.js";
import { detectVoiceEnv, formatVoiceEnvReport } from "../voice/detect.js";
import { runVoiceSmokeTest } from "../voice/smoke-test.js";
import type { WizardPrompter } from "./prompts.js";

export type VoiceSetupDeps = {
  validateKey?: typeof validateCloudVoiceKey;
  detectModels?: typeof detectNativeModels;
  detectEnv?: typeof detectVoiceEnv;
  runSmoke?: typeof runVoiceSmokeTest;
  saveSetup?: typeof saveVoiceSetup;
  setInput?: typeof setVoiceInput;
};

/**
 * Run the Voice setup step. Returns the (possibly unchanged) config so the
 * caller can keep threading it. Persists via `saveVoiceSetup` when a path is
 * chosen; a "Skip" answer leaves config untouched.
 */
export async function setupVoice(params: {
  config: InfinibotConfig;
  prompter: WizardPrompter;
  runtime?: RuntimeEnv;
  deps?: VoiceSetupDeps;
}): Promise<InfinibotConfig> {
  const { config, prompter } = params;
  const runtime = params.runtime ?? defaultRuntime;
  const validateKey = params.deps?.validateKey ?? validateCloudVoiceKey;
  const detectModels = params.deps?.detectModels ?? detectNativeModels;
  const runSmoke = params.deps?.runSmoke ?? runVoiceSmokeTest;
  const saveSetup = params.deps?.saveSetup ?? saveVoiceSetup;
  const detectEnv = params.deps?.detectEnv ?? detectVoiceEnv;
  const setInput = params.deps?.setInput ?? setVoiceInput;

  // Surface what this machine already has (mic, local STT/TTS, cloud keys,
  // docker) so the user picks an informed path instead of guessing.
  try {
    const env = await detectEnv();
    await prompter.note(formatVoiceEnvReport(env), "Detected");
  } catch {
    // Detection is best-effort — never block the step on a probe failure.
  }

  const choice = await prompter.select<"cloud" | "native" | "skip">({
    message: "Voice setup — how should your bot hear and speak?",
    options: [
      {
        value: "cloud",
        label: "Cloud (managed)",
        hint: "OpenAI STT + OpenAI/ElevenLabs/Edge TTS. Best quality, needs an API key.",
      },
      {
        value: "native",
        label: "Native (local)",
        hint: "Kokoro/Piper TTS + local Whisper STT. Private, no API key, runs on this machine.",
      },
      {
        value: "skip",
        label: "Skip — configure later",
        hint: "Set it up anytime with `infinibot voice doctor`.",
      },
    ],
    initialValue: "native",
  });

  if (choice === "skip") {
    await prompter.note("Voice not configured. Run `infinibot voice doctor` when ready.", "Voice");
    return config;
  }

  let setup: VoiceSetupConfig;

  if (choice === "cloud") {
    const tts = await prompter.select<VoiceCloudTtsProvider>({
      message: "Cloud TTS provider",
      options: [
        { value: "openai", label: "OpenAI", hint: "tts-1 / tts-1-hd voices" },
        { value: "elevenlabs", label: "ElevenLabs", hint: "Highest quality, separate key" },
        { value: "edge", label: "Edge TTS", hint: "Free, no API key" },
      ],
      initialValue: "openai",
    });

    let apiKey = "";
    if (tts !== "edge") {
      // Validate the key against the provider before continuing.
      for (;;) {
        apiKey = (
          await prompter.text({
            message: tts === "elevenlabs" ? "ElevenLabs API key" : "OpenAI API key",
            placeholder: tts === "elevenlabs" ? "xi-..." : "sk-...",
            validate: (v) => (v.trim() ? undefined : "API key is required"),
          })
        ).trim();
        const progress = prompter.progress("Validating API key");
        const result = await validateKey(tts, apiKey);
        progress.stop(result.ok ? "Key validated" : "Key rejected");
        if (result.ok) break;
        const retry = await prompter.confirm({
          message: `${result.message}. Try a different key?`,
          initialValue: true,
        });
        if (!retry) {
          await prompter.note("Voice not configured (key not validated).", "Voice");
          return config;
        }
      }
    }

    setup = {
      provider: "cloud",
      cloud: {
        stt: "openai",
        tts,
        apiKey: tts === "edge" ? "edge" : apiKey, // edge has no key; placeholder keeps schema happy
      },
      fallback: "cloud-to-native",
    };
  } else {
    // native
    const progress = prompter.progress("Detecting local voice models");
    const status = await detectModels();
    progress.stop("Detection complete");
    await prompter.note(
      [
        `Kokoro TTS: ${status.kokoro.present ? "found" : "missing"} — ${status.kokoro.detail}`,
        `Whisper STT: ${status.speaches.present ? "found" : "missing"} — ${status.speaches.detail}`,
      ].join("\n"),
      "Local models",
    );
    if (!status.kokoro.present || !status.speaches.present) {
      await prompter.note(
        "Local voice runs on the Kokoro + Speaches containers. Start them with:\n  docker compose -f docker-compose.voice.yaml up -d",
        "Heads up",
      );
    }
    setup = {
      provider: "native",
      native: {
        tts: "kokoro",
        ttsVoice: DEFAULT_KOKORO_VOICE,
        sttModel: DEFAULT_NATIVE_STT_MODEL,
        wakeWord: false,
      },
      fallback: "native-to-cloud",
    };
  }

  // Input bindings — push-to-talk hotkey (default Ctrl+Space) + wake word
  // (default off). Persisted to voice.json under `input` via the bridge below.
  const wakeWord = await prompter.confirm({
    message: "Enable wake-word listening (always-on)?",
    initialValue: false,
  });
  const hotkey =
    (
      await prompter.text({
        message: "Push-to-talk hotkey",
        placeholder: DEFAULT_HOTKEY,
        initialValue: DEFAULT_HOTKEY,
      })
    ).trim() || DEFAULT_HOTKEY;
  if (setup.provider === "native" && setup.native) setup.native.wakeWord = wakeWord;

  await saveSetup(setup); // writes infinibot.json + bridges → voice.json

  // Persist input bindings onto voice.json (the bridge only knows defaults).
  try {
    setInput({ hotkey, wakeWord });
  } catch {
    // Non-fatal — the stack is already saved; input is a convenience layer.
  }

  // End-of-step smoke test with a clear ✓ / ✗ and a Retry option.
  for (;;) {
    const progress = prompter.progress("Running voice smoke test");
    const smoke = await runSmoke({ setup });
    progress.stop(smoke.pass ? "Smoke test passed" : "Smoke test failed");
    if (smoke.pass) {
      await prompter.note(`✓ ${smoke.message}`, "Voice ready");
      break;
    }
    runtime.error(`Voice smoke test failed at ${smoke.stage}: ${smoke.message}`);
    const retry = await prompter.confirm({
      message: `✗ Failed at ${smoke.stage}: ${smoke.message}. Retry?`,
      initialValue: true,
    });
    if (!retry) {
      await prompter.note(
        "Saved your choice. Run `infinibot voice doctor` to retry later.",
        "Voice",
      );
      break;
    }
  }

  return { ...config, voice: { ...config.voice, ...setup } };
}
