// Single resolver: what TTS voice id is the user currently using?
// Reads ~/.infinibot/infinibot.json (`.voice.native.ttsVoice`) directly so
// overlay narration matches the voice chat without coupling to gateway code.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const FALLBACK_VOICE = "af_heart";

function configPath(): string {
  return process.env.INFINIBOT_STATE_DIR
    ? join(process.env.INFINIBOT_STATE_DIR, "infinibot.json")
    : join(homedir(), ".infinibot", "infinibot.json");
}

export function getActiveVoiceId(): string {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const cfg = JSON.parse(raw);
    const v: unknown = cfg?.voice?.native?.ttsVoice ?? cfg?.voice?.ttsVoice ?? cfg?.voice?.voiceId;
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    return FALLBACK_VOICE;
  } catch {
    return FALLBACK_VOICE;
  }
}
