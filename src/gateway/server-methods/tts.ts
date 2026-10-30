import { loadConfig } from "../../config/config.js";
import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  getTtsProvider,
  getTtsVoiceSettings,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsAutoMode,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsProvider,
  setTtsVoiceSettings,
  textToSpeech,
} from "../../tts/tts.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import { proxyMethodsToMaster } from "../../federation/satellite-context.js";
import type { GatewayRequestHandlers } from "./types.js";

const _rawTtsHandlers: GatewayRequestHandlers = {
  "tts.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider)
        .slice(1)
        .filter((candidate) => isTtsProviderConfigured(config, candidate));
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        auto: autoMode,
        provider,
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        hasOpenAIKey: Boolean(resolveTtsApiKey(config, "openai")),
        hasElevenLabsKey: Boolean(resolveTtsApiKey(config, "elevenlabs")),
        edgeEnabled: isTtsProviderConfigured(config, "edge"),
        kokoroEnabled: isTtsProviderConfigured(config, "kokoro"),
        kokoroBaseUrl: config.kokoro.baseUrl,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.enable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.disable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.convert": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const channel = typeof params.channel === "string" ? params.channel.trim() : undefined;
      const result = await textToSpeech({ text, cfg, channel });
      if (result.success && result.audioPath) {
        respond(true, {
          audioPath: result.audioPath,
          provider: result.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setProvider": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider.trim() : "";
    if (
      provider !== "openai" &&
      provider !== "elevenlabs" &&
      provider !== "edge" &&
      provider !== "kokoro"
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Invalid provider. Use openai, elevenlabs, edge, or kokoro.",
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);

      // Live-probe Kokoro so the UI can show whether the local server is up.
      // We hit /health (universally supported) for availability, and
      // /v1/audio/voices for the voice list (some Kokoro builds don't expose
      // it; that's fine — the UI falls back to a bundled voice list).
      const kokoroBase = config.kokoro.baseUrl.replace(/\/+$/, "");
      let kokoroVoices: string[] = [];
      let kokoroAvailable = false;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const healthRes = await fetch(`${kokoroBase}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (healthRes.ok) {
          kokoroAvailable = true;
          // Best-effort voice list — if 404, leave empty and UI falls back.
          try {
            const vCtrl = new AbortController();
            const vTimer = setTimeout(() => vCtrl.abort(), 1500);
            const vRes = await fetch(`${kokoroBase}/v1/audio/voices`, { signal: vCtrl.signal });
            clearTimeout(vTimer);
            if (vRes.ok) {
              const data = (await vRes.json()) as { voices?: string[] };
              if (Array.isArray(data.voices)) kokoroVoices = data.voices;
            }
          } catch {
            // voices endpoint absent — UI bundled list takes over
          }
        }
      } catch {
        // server offline — configured stays false
      }

      respond(true, {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            configured: Boolean(resolveTtsApiKey(config, "openai")),
            models: [...OPENAI_TTS_MODELS],
            voices: [...OPENAI_TTS_VOICES],
          },
          {
            id: "elevenlabs",
            name: "ElevenLabs",
            configured: Boolean(resolveTtsApiKey(config, "elevenlabs")),
            models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
          },
          {
            id: "edge",
            name: "Edge TTS",
            configured: isTtsProviderConfigured(config, "edge"),
            models: [],
          },
          {
            id: "kokoro",
            name: "Kokoro (local)",
            configured: kokoroAvailable,
            baseUrl: config.kokoro.baseUrl,
            voices: kokoroVoices,
            models: ["kokoro"],
          },
        ],
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.voiceSettings": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const voiceSettings = getTtsVoiceSettings(config, prefsPath);
      respond(true, voiceSettings);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setVoiceSettings": async ({ params, respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);

      const settings: {
        openaiVoice?: string;
        openaiModel?: string;
        elevenlabsVoiceId?: string;
        elevenlabsModelId?: string;
        edgeVoice?: string;
        kokoroVoice?: string;
        kokoroSpeed?: number;
      } = {};

      if (typeof params.openaiVoice === "string") {
        settings.openaiVoice = params.openaiVoice.trim();
      }
      if (typeof params.openaiModel === "string") {
        settings.openaiModel = params.openaiModel.trim();
      }
      if (typeof params.elevenlabsVoiceId === "string") {
        settings.elevenlabsVoiceId = params.elevenlabsVoiceId.trim();
      }
      if (typeof params.elevenlabsModelId === "string") {
        settings.elevenlabsModelId = params.elevenlabsModelId.trim();
      }
      if (typeof params.edgeVoice === "string") {
        settings.edgeVoice = params.edgeVoice.trim();
      }
      if (typeof params.kokoroVoice === "string") {
        settings.kokoroVoice = params.kokoroVoice.trim();
      }
      if (typeof params.kokoroSpeed === "number" && params.kokoroSpeed > 0) {
        settings.kokoroSpeed = params.kokoroSpeed;
      }

      setTtsVoiceSettings(prefsPath, settings);

      // Return updated settings
      const updatedSettings = getTtsVoiceSettings(config, prefsPath);
      respond(true, updatedSettings);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};

// Voice prefs (provider choice, voice settings, enable/disable, wake-word
// triggers) are user-level — wrap them so a satellite UI shows + edits the
// same TTS state as master. Audio synthesis itself (`tts.convert`) is left
// LOCAL: it writes the rendered audio to a node-local file path, so proxying
// would return a master-side path the satellite can't read.
//
// The HTTP voice routes (/api/voice/tts, /api/voice/stt, /api/voice/chat)
// already point at master via `resolveVoiceUrls()` (commit ce8da33), so the
// audio bytes themselves are always synthesized/transcribed by master's
// containers regardless of where the call originated.
export const ttsHandlers: GatewayRequestHandlers = proxyMethodsToMaster(
  _rawTtsHandlers,
  [
    "tts.status",
    "tts.enable",
    "tts.disable",
    "tts.providers",
    "tts.setProvider",
    "tts.voiceSettings",
    "tts.setVoiceSettings",
  ],
);
