/**
 * Voice environment detection.
 *
 * Surfaces what the local machine already has so the wizard (web step 5) and
 * the CLI onboard/setup step can pre-fill choices and tell the user the truth
 * instead of making them guess: a microphone, local STT/TTS binaries, cloud
 * provider keys in the environment, and the Docker voice containers.
 *
 * Every external probe is wrapped in try/catch with a hard 1.5s timeout so a
 * hung `arecord`/`docker` can never stall onboarding. No probe throws — each
 * degrades to `{ present: false }`.
 */
import { execFile } from "node:child_process";

import {
  STT_ENV_KEYS,
  TTS_ENV_KEYS,
  type SttProviderId,
  type TtsProviderId,
} from "../gateway/voice/config.js";
import { detectNativeModels, type NativeModelStatus } from "./validate.js";

const PROBE_TIMEOUT_MS = 1500;

export interface BinaryProbe {
  present: boolean;
  /** Absolute path when found, else a short reason. */
  detail: string;
}

export interface CloudKeyProbe {
  provider: string;
  present: boolean;
  /** Masked source, e.g. "detected from env (GROQ_API_KEY)". Never the value. */
  detail: string;
}

export interface VoiceEnvReport {
  mic: BinaryProbe;
  stt: {
    whisper: BinaryProbe;
    whisperCpp: BinaryProbe;
    fasterWhisper: BinaryProbe;
    any: boolean;
  };
  tts: {
    piper: BinaryProbe;
    any: boolean;
  };
  cloudKeys: CloudKeyProbe[];
  /** Docker/native container reachability (existing probe — unchanged). */
  docker: NativeModelStatus | { present: false; detail: string };
}

/** Run a command with a hard timeout; resolve to stdout or null (never reject). */
function run(cmd: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
      });
    } catch {
      resolve(null);
    }
  });
}

/** `which <bin>` → path, or absent. */
async function which(bin: string): Promise<BinaryProbe> {
  const out = await run("which", [bin]);
  const p = out?.trim().split("\n")[0]?.trim();
  return p ? { present: true, detail: p } : { present: false, detail: `${bin} not on PATH` };
}

/** Microphone: `arecord -l`, falling back to `pactl list short sources`. */
async function detectMic(): Promise<BinaryProbe> {
  const arecord = await run("arecord", ["-l"]);
  if (arecord && /card \d+/i.test(arecord)) {
    const first = arecord
      .split("\n")
      .find((l) => /card \d+/i.test(l))
      ?.trim();
    return { present: true, detail: first ?? "capture device found (arecord)" };
  }
  const pactl = await run("pactl", ["list", "short", "sources"]);
  if (pactl && pactl.trim()) {
    const lines = pactl.trim().split("\n").filter(Boolean);
    // Skip monitor sources — they aren't real mics.
    const real = lines.find((l) => !/\.monitor\b/.test(l));
    if (real) return { present: true, detail: `${real.split(/\s+/)[1] ?? "source"} (pactl)` };
  }
  return { present: false, detail: "no capture device (arecord/pactl)" };
}

/** Cloud keys present in the environment, masked. */
function detectCloudKeys(): CloudKeyProbe[] {
  const seen = new Map<string, CloudKeyProbe>();
  const scan = (provider: string, keys: string[]) => {
    for (const k of keys) {
      const v = process.env[k];
      if (typeof v === "string" && v.trim()) {
        seen.set(provider, { provider, present: true, detail: `detected from env (${k})` });
        return;
      }
    }
    if (!seen.has(provider))
      seen.set(provider, { provider, present: false, detail: "no key in env" });
  };
  (Object.keys(STT_ENV_KEYS) as SttProviderId[]).forEach((p) => {
    if (STT_ENV_KEYS[p].length) scan(p, STT_ENV_KEYS[p]);
  });
  (Object.keys(TTS_ENV_KEYS) as TtsProviderId[]).forEach((p) => {
    if (TTS_ENV_KEYS[p].length) scan(p, TTS_ENV_KEYS[p]);
  });
  return [...seen.values()];
}

/**
 * Detect the local voice environment. Best-effort — every field is populated
 * even when a probe times out or the tool is missing.
 */
export async function detectVoiceEnv(): Promise<VoiceEnvReport> {
  const [mic, whisper, whisperCpp, fasterWhisper, piper] = await Promise.all([
    detectMic(),
    which("whisper"),
    which("whisper-cpp"),
    which("faster-whisper"),
    which("piper"),
  ]);

  // Docker/native container probe stays as the existing reachability check.
  let docker: VoiceEnvReport["docker"];
  try {
    docker = await detectNativeModels();
  } catch (err) {
    docker = { present: false, detail: `container probe failed: ${(err as Error).message}` };
  }

  return {
    mic,
    stt: {
      whisper,
      whisperCpp,
      fasterWhisper,
      any: whisper.present || whisperCpp.present || fasterWhisper.present,
    },
    tts: { piper, any: piper.present },
    cloudKeys: detectCloudKeys(),
    docker,
  };
}

/** One-line-per-row human summary for the CLI step + `voice doctor`. */
export function formatVoiceEnvReport(r: VoiceEnvReport): string {
  const row = (label: string, p: BinaryProbe) =>
    `  ${p.present ? "✓" : "•"}  ${label.padEnd(16)} ${p.detail}`;
  const lines = [
    row("microphone", r.mic),
    row("whisper", r.stt.whisper),
    row("whisper-cpp", r.stt.whisperCpp),
    row("faster-whisper", r.stt.fasterWhisper),
    row("piper (TTS)", r.tts.piper),
  ];
  for (const k of r.cloudKeys) {
    lines.push(`  ${k.present ? "✓" : "•"}  ${`key:${k.provider}`.padEnd(16)} ${k.detail}`);
  }
  if ("kokoro" in r.docker) {
    lines.push(
      `  ${r.docker.kokoro.present ? "✓" : "•"}  ${"kokoro (docker)".padEnd(16)} ${r.docker.kokoro.detail}`,
    );
    lines.push(
      `  ${r.docker.speaches.present ? "✓" : "•"}  ${"speaches (docker)".padEnd(16)} ${r.docker.speaches.detail}`,
    );
  }
  return ["Voice environment", "─".repeat(20), ...lines].join("\n");
}
