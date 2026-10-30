import type { IncomingMessage, ServerResponse } from "node:http";
import { REDACTED_SENTINEL } from "./server-methods/config-redact.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveVoiceUrls } from "./server-voice-urls.js";

const TTS_VOICE_DEFAULT = process.env.TTS_VOICE || "bm_george";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "deepdml/faster-whisper-large-v3-turbo-ct2";

const SETTINGS_FILE = path.join(process.cwd(), "voice-settings.json");

// Kokoro voice IDs follow <lang><gender>_<name>. Decode the prefix for display.
const KOKORO_LANG_LABELS: Record<string, string> = {
  a: "American",
  b: "British",
  e: "European Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Portuguese",
  z: "Chinese",
};
const KOKORO_GENDER_LABELS: Record<string, string> = { f: "Female", m: "Male" };

function prettifyKokoroVoice(id: string): string {
  const m = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!m) return id;
  const [, lang, gender, rawName] = m;
  const name =
    rawName
      .replace(/^v\d+/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || rawName;
  const langLabel = KOKORO_LANG_LABELS[lang] ?? lang.toUpperCase();
  const genderLabel = KOKORO_GENDER_LABELS[gender] ?? gender;
  return `${name} (${langLabel} ${genderLabel})`;
}

// Cached Kokoro voice list. Refetched when stale. Falls back to a small hardcoded list if Kokoro is unreachable.
const KOKORO_VOICES_FALLBACK = [
  { id: "am_puck", name: "Puck (American Male)", provider: "kokoro" },
  { id: "af_bella", name: "Bella (American Female)", provider: "kokoro" },
  { id: "af_sarah", name: "Sarah (American Female)", provider: "kokoro" },
  { id: "bm_george", name: "George (British Male)", provider: "kokoro" },
  { id: "bf_emma", name: "Emma (British Female)", provider: "kokoro" },
  { id: "am_michael", name: "Michael (American Male)", provider: "kokoro" },
  { id: "am_adam", name: "Adam (American Male)", provider: "kokoro" },
  { id: "af_nicole", name: "Nicole (American Female)", provider: "kokoro" },
  { id: "af_sky", name: "Sky (American Female)", provider: "kokoro" },
];

const KOKORO_CACHE_TTL_MS = 60_000;
let kokoroVoicesCache: { at: number; voices: any[] } | null = null;

async function fetchKokoroVoices(): Promise<any[]> {
  const now = Date.now();
  if (kokoroVoicesCache && now - kokoroVoicesCache.at < KOKORO_CACHE_TTL_MS) {
    return kokoroVoicesCache.voices;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const { kokoro: KOKORO_URL } = resolveVoiceUrls();
    const res = await fetch(`${KOKORO_URL}/v1/audio/voices`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`kokoro voices ${res.status}`);
    const data = (await res.json()) as { voices?: string[] };
    const ids = Array.isArray(data.voices)
      ? data.voices.filter((id) => !/^[a-z][fm]_v\d/.test(id))
      : [];
    const voices = ids
      .map((id) => ({ id, name: prettifyKokoroVoice(id), provider: "kokoro" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (voices.length === 0) throw new Error("kokoro returned empty voice list");
    kokoroVoicesCache = { at: now, voices };
    return voices;
  } catch (err) {
    console.warn("[voice-config] Failed to fetch Kokoro voices, using fallback:", err);
    return KOKORO_VOICES_FALLBACK;
  }
}

const PIPER_VOICES = [
  { id: "en_US-amy-medium", name: "Amy (US Female)", provider: "piper" },
  { id: "en_US-bryce-medium", name: "Bryce (US Male)", provider: "piper" },
  { id: "en_US-danny-low", name: "Danny (US Male)", provider: "piper" },
  { id: "en_US-hfc_male-medium", name: "HFC Male (US)", provider: "piper" },
  { id: "en_US-kristin-medium", name: "Kristin (US Female)", provider: "piper" },
  { id: "en_US-lessac-medium", name: "Lessac (US Female)", provider: "piper" },
  { id: "en_US-libritts-high", name: "LibriTTS (US)", provider: "piper" },
  { id: "en_US-ryan-medium", name: "Ryan (US Male)", provider: "piper" },
  { id: "en_GB-alan-medium", name: "Alan (UK Male)", provider: "piper" },
  {
    id: "en_GB-southern_english_female-low",
    name: "Southern English (UK Female)",
    provider: "piper",
  },
];

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Failed to load settings file:", err);
  }
  return {};
}

/**
 * Read the persisted voice routing decision. Exposed so the gateway voice
 * stream can branch on it (gateway_agent → existing dispatch flow,
 * claude_code → spawn a Claude Code sub-agent with the transcript).
 * Default is "gateway_agent" if the setting is unset or malformed.
 */
const VALID_CLI_ROUTES = new Set(["claude_code", "opencode", "codex", "gemini", "grok"]);

export function getVoiceRoute():
  | "gateway_agent"
  | "claude_code"
  | "opencode"
  | "codex"
  | "gemini"
  | "grok" {
  const saved = loadSettings();
  const route: unknown = saved.voice_route;
  if (typeof route === "string" && VALID_CLI_ROUTES.has(route))
    return route as "claude_code" | "opencode" | "codex" | "gemini" | "grok";
  return "gateway_agent";
}

function saveSettings(settings: any) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save settings file:", err);
  }
}

export async function handleVoiceConfigRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!req.url) return false;

  // Use URL object for robust parsing
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Check if path matches our endpoints
  if (pathname === "/api/settings" || pathname === "/api/voices") {
    // Same-origin only (the central HTTP gate authenticates these routes).
    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }

    // Handle /api/settings GET
    if (pathname === "/api/settings" && req.method === "GET") {
      const saved = loadSettings();

      // Allow merging logic.
      // If saved has tts_provider, use it.
      // If saved has tts_voice_kokoro/piper, use it.

      // Defaults
      const settings = {
        llm_model: "infinibot-gateway",
        llm_provider: "infinibot",
        tts_provider: saved.tts_provider || "kokoro",
        tts_voice: saved.tts_voice || TTS_VOICE_DEFAULT, // Legacy field
        tts_voice_kokoro: saved.tts_voice_kokoro,
        tts_voice_piper: saved.tts_voice_piper,
        tts_voice_elevenlabs: saved.tts_voice_elevenlabs,
        // Never hand the key back out; the UI only needs to know it is set.
        elevenlabs_api_key: saved.elevenlabs_api_key ? REDACTED_SENTINEL : undefined,
        elevenlabs_api_key_set: Boolean(saved.elevenlabs_api_key),
        stt_model: WHISPER_MODEL,
        vad_enabled: saved.vad_enabled ?? true,
        wake_word_enabled: saved.wake_word_enabled ?? false,
        voice_route:
          typeof saved.voice_route === "string" && VALID_CLI_ROUTES.has(saved.voice_route)
            ? (saved.voice_route as "claude_code" | "opencode" | "codex" | "gemini" | "grok")
            : "gateway_agent",
      };

      // Map active voice if needed (for simple_agent compatibility which might read legacy 'tts_voice')
      if (settings.tts_provider === "kokoro")
        settings.tts_voice = settings.tts_voice_kokoro || settings.tts_voice;
      if (settings.tts_provider === "piper")
        settings.tts_voice = settings.tts_voice_piper || settings.tts_voice;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(settings));
      return true;
    }

    // Handle /api/settings POST
    if (pathname === "/api/settings" && req.method === "POST") {
      try {
        const body = await new Promise<string>((resolve, reject) => {
          let data = "";
          req.on("data", (chunk) => (data += chunk));
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });

        const newSettings = JSON.parse(body) as Record<string, unknown>;
        if (!newSettings || typeof newSettings !== "object" || Array.isArray(newSettings)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "settings must be an object" }));
          return true;
        }
        // A redacted key echoed back by the UI means "unchanged".
        if (newSettings.elevenlabs_api_key === REDACTED_SENTINEL) {
          delete newSettings.elevenlabs_api_key;
        }
        delete newSettings.elevenlabs_api_key_set;
        if (
          newSettings.voice_route !== undefined &&
          newSettings.voice_route !== "gateway_agent" &&
          !(
            typeof newSettings.voice_route === "string" &&
            VALID_CLI_ROUTES.has(newSettings.voice_route)
          )
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid voice_route" }));
          return true;
        }
        const current = loadSettings();
        const merged = { ...current, ...newSettings };
        saveSettings(merged);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error("Error processing settings POST:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal Error" }));
      }
      return true;
    }

    // Handle /api/voices
    if (pathname === "/api/voices" && req.method === "GET") {
      const provider = url.searchParams.get("provider");
      let voices: any[] = [];

      if (!provider || provider === "kokoro") {
        voices = voices.concat(await fetchKokoroVoices());
      }
      if (!provider || provider === "piper") {
        voices = voices.concat(PIPER_VOICES);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      // UI expects { voices: [...] } structure
      res.end(JSON.stringify({ voices: voices }));
      return true;
    }
  }

  return false;
}
