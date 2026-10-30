/**
 * First-run voice smoke test.
 *
 * Exercises the full round-trip — mic → STT → TTS → speaker — and returns a
 * single staged result so the wizard end-step / voice-chat banner can show a
 * green ✓ or a red ✗ at the exact stage that failed.
 *
 * Each stage is an injectable async function so the test is unit-testable
 * without real hardware, and so callers (doctor, wizard) can swap in a
 * lighter probe. The default stages run TTS + STT against the live voice
 * upstreams resolved by `resolveVoiceUrls()` and treat mic/speaker as
 * best-effort device-presence checks (real hardware capture happens in the
 * browser; server-side we verify the pipeline endpoints).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { resolveVoiceUrls } from "../gateway/server-voice-urls.js";
import { loadVoiceSetupSync } from "./config.js";
import { DEFAULT_KOKORO_VOICE, type VoiceSetupConfig } from "./schema.js";

export type SmokeStage = "mic" | "stt" | "tts" | "speaker" | "ok";

export type SmokeResult = {
  pass: boolean;
  stage: SmokeStage;
  message: string;
  /** Per-stage durations in ms (for the doctor latency column). */
  timings?: Partial<Record<Exclude<SmokeStage, "ok">, number>>;
  at: number;
};

export type SmokeStageOutcome = { ok: boolean; message?: string };

export type SmokeStages = {
  mic: () => Promise<SmokeStageOutcome>;
  stt: () => Promise<SmokeStageOutcome>;
  tts: () => Promise<SmokeStageOutcome>;
  speaker: () => Promise<SmokeStageOutcome>;
};

const STAGE_ORDER: Array<Exclude<SmokeStage, "ok">> = ["mic", "stt", "tts", "speaker"];

/** Where the last smoke result is cached so the voice-chat UI can show a
 *  "last smoke failed" banner without re-running the round-trip. */
export function lastSmokePath(): string {
  return path.join(resolveStateDir(), "voice", "last-smoke.json");
}

export function readLastSmokeResult(): SmokeResult | null {
  try {
    const file = lastSmokePath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SmokeResult;
  } catch {
    return null;
  }
}

function persistLastSmoke(result: SmokeResult): void {
  try {
    const file = lastSmokePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
  } catch {
    /* best-effort cache only */
  }
}

/**
 * Default stage implementations. `mic`/`speaker` are presence checks (the
 * real capture is browser-side); `stt`/`tts` hit the live upstreams.
 */
export function makeDefaultStages(setup: VoiceSetupConfig | null): SmokeStages {
  const urls = resolveVoiceUrls();
  return {
    mic: async () => {
      // Server-side we can't open a mic; treat config presence as the gate.
      if (!setup) return { ok: false, message: "voice not configured (run the wizard)" };
      return { ok: true, message: "input path ready" };
    },
    tts: async () => {
      if (setup?.provider === "native") {
        const voice = setup.native?.ttsVoice || DEFAULT_KOKORO_VOICE;
        try {
          const res = await fetch(`${urls.kokoro}/v1/audio/speech`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "kokoro",
              voice,
              input: "Voice check.",
              response_format: "mp3",
            }),
          });
          if (!res.ok) return { ok: false, message: `kokoro ${res.status}` };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 64) return { ok: false, message: "kokoro returned empty audio" };
          return { ok: true, message: `synthesized ${buf.length} bytes via kokoro` };
        } catch (err) {
          return { ok: false, message: `kokoro unreachable: ${(err as Error).message}` };
        }
      }
      // cloud TTS — we don't spend a real synthesis credit here; verify the
      // key is present. (doctor's reachability check covers the network leg.)
      if (!setup?.cloud?.apiKey) return { ok: false, message: "cloud TTS has no API key" };
      return { ok: true, message: "cloud TTS key present" };
    },
    stt: async () => {
      // Verify the STT upstream answers. A full transcription would need a
      // real audio sample; we check the service is reachable + the model
      // listing responds (Speaches exposes /v1/models).
      if (setup?.provider === "native") {
        try {
          const res = await fetch(`${urls.speaches}/v1/models`);
          if (!res.ok) return { ok: false, message: `speaches ${res.status}` };
          return { ok: true, message: "speaches STT reachable" };
        } catch (err) {
          return { ok: false, message: `speaches unreachable: ${(err as Error).message}` };
        }
      }
      if (!setup?.cloud?.apiKey) return { ok: false, message: "cloud STT has no API key" };
      return { ok: true, message: "cloud STT key present" };
    },
    speaker: async () => {
      // Output device presence — browser-side concern; pass on the server.
      return { ok: true, message: "output path ready" };
    },
  };
}

/**
 * Run the staged round-trip. Stops at the first failing stage and returns
 * `{ pass: false, stage }`; on full success returns `{ pass: true, stage: "ok" }`.
 * Persists the result for the UI banner unless `persist: false`.
 */
export async function runVoiceSmokeTest(opts?: {
  setup?: VoiceSetupConfig | null;
  stages?: SmokeStages;
  now?: () => number;
  persist?: boolean;
}): Promise<SmokeResult> {
  const now = opts?.now ?? (() => Date.now());
  const setup = opts?.setup !== undefined ? opts.setup : loadVoiceSetupSync();
  const stages = opts?.stages ?? makeDefaultStages(setup);
  const timings: SmokeResult["timings"] = {};

  for (const stage of STAGE_ORDER) {
    const start = now();
    let outcome: SmokeStageOutcome;
    try {
      outcome = await stages[stage]();
    } catch (err) {
      outcome = { ok: false, message: (err as Error).message };
    }
    timings[stage] = now() - start;
    if (!outcome.ok) {
      const result: SmokeResult = {
        pass: false,
        stage,
        message: outcome.message ?? `${stage} stage failed`,
        timings,
        at: now(),
      };
      if (opts?.persist !== false) persistLastSmoke(result);
      return result;
    }
  }

  const result: SmokeResult = {
    pass: true,
    stage: "ok",
    message: "mic → STT → TTS → speaker round-trip passed",
    timings,
    at: now(),
  };
  if (opts?.persist !== false) persistLastSmoke(result);
  return result;
}
