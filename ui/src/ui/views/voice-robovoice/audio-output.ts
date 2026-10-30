/**
 * Audio devices of a Robovoice call in this browser: which speaker plays the
 * agent, how loud, which microphone is sent — and a detector for the one
 * failure a caller can't see: the agent answered (text arrived) but no voice
 * audio did.
 *
 * Device ids are per browser + origin, so the choice lives in this browser's
 * localStorage (same place as the microphone pick), not in the gateway's voice
 * config. The TTS provider / voice is Robovoice's and is edited on the
 * Pipeline and Voice agents tabs.
 *
 * Pure helpers are unit-tested; the browser ones take their globals as
 * arguments where a test needs to fake them.
 */

export const AUDIO_KEYS = {
  mic: "infinibot.voice.micDeviceId",
  output: "infinibot.voice.outputDeviceId",
  volume: "infinibot.voice.outputVolume",
  fallbackVoice: "infinibot.voice.fallbackVoice",
} as const;

export type AudioPrefs = {
  /** "" = the system default device. */
  micDeviceId: string;
  outputDeviceId: string;
  /** 0..1 */
  volume: number;
  /** Speak a reply with the browser's own voice when the agent's audio never arrived. */
  fallbackVoice: boolean;
};

export const DEFAULT_AUDIO_PREFS: AudioPrefs = { micDeviceId: "", outputDeviceId: "", volume: 1, fallbackVoice: true };

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function clampVolume(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v));
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export function loadAudioPrefs(store: Store | null = storage()): AudioPrefs {
  const get = (k: string): string | null => {
    try {
      return store?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const vol = get(AUDIO_KEYS.volume);
  return {
    micDeviceId: get(AUDIO_KEYS.mic) ?? "",
    outputDeviceId: get(AUDIO_KEYS.output) ?? "",
    volume: vol === null ? 1 : clampVolume(vol),
    fallbackVoice: get(AUDIO_KEYS.fallbackVoice) !== "0",
  };
}

export function saveAudioPrefs(patch: Partial<AudioPrefs>, store: Store | null = storage()): void {
  const set = (k: string, v: string | null) => {
    try {
      if (v === null || v === "") store?.removeItem(k);
      else store?.setItem(k, v);
    } catch {
      /* private mode */
    }
  };
  if (patch.micDeviceId !== undefined) set(AUDIO_KEYS.mic, patch.micDeviceId);
  if (patch.outputDeviceId !== undefined) set(AUDIO_KEYS.output, patch.outputDeviceId);
  if (patch.volume !== undefined) set(AUDIO_KEYS.volume, String(clampVolume(patch.volume)));
  if (patch.fallbackVoice !== undefined) set(AUDIO_KEYS.fallbackVoice, patch.fallbackVoice ? "1" : "0");
}

export type AudioDevice = { deviceId: string; label: string };
export type AudioDevices = { inputs: AudioDevice[]; outputs: AudioDevice[] };

/** enumerateDevices() → labelled inputs / outputs (unlabelled ones get a numbered name). */
export function splitDevices(all: ReadonlyArray<Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">>): AudioDevices {
  const pick = (kind: MediaDeviceKind, name: string): AudioDevice[] => {
    const seen = new Set<string>();
    const out: AudioDevice[] = [];
    for (const d of all) {
      if (d.kind !== kind || seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);
      out.push({ deviceId: d.deviceId, label: d.label || (d.deviceId === "default" || !d.deviceId ? `Default ${name}` : `${name} ${out.length + 1}`) });
    }
    return out;
  };
  return { inputs: pick("audioinput", "microphone"), outputs: pick("audiooutput", "speaker") };
}

/**
 * The device to really use: the saved one while it is still plugged in,
 * otherwise the system default ("") — `missing` says the saved device is gone,
 * so the UI can say it fell back instead of failing the call.
 */
export function resolveDevice(saved: string, devices: readonly AudioDevice[]): { deviceId: string; missing: boolean } {
  if (!saved) return { deviceId: "", missing: false };
  // Before permission is granted browsers list devices without ids/labels: can't tell, keep the choice.
  if (!devices.length || devices.every((d) => !d.deviceId)) return { deviceId: saved, missing: false };
  return devices.some((d) => d.deviceId === saved) ? { deviceId: saved, missing: false } : { deviceId: "", missing: true };
}

type SinkElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

/** Can this browser route an element to a chosen speaker? (Chrome/Edge/Firefox desktop yes; Safari/iOS no.) */
export function outputSelectionSupported(proto: object | null = typeof HTMLMediaElement === "undefined" ? null : HTMLMediaElement.prototype): boolean {
  return Boolean(proto && "setSinkId" in proto);
}

/**
 * Route an element to a speaker. A device that has gone falls back to the
 * system default; "unsupported" = this browser always uses the system output.
 */
export async function applySink(el: HTMLMediaElement, deviceId: string): Promise<"applied" | "fallback-default" | "unsupported"> {
  const sink = el as SinkElement;
  if (typeof sink.setSinkId !== "function") return "unsupported";
  if ((sink.sinkId ?? "") === deviceId) return "applied";
  try {
    await sink.setSinkId(deviceId);
    return "applied";
  } catch {
    if (!deviceId) return "applied";
    try {
      await sink.setSinkId("");
    } catch {
      /* stays where it was */
    }
    return "fallback-default";
  }
}

/** Firefox's permission prompt for speakers (returns the picked device, null when unsupported / dismissed). */
export async function promptForOutput(): Promise<AudioDevice | null> {
  const md = navigator.mediaDevices as MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
  if (typeof md?.selectAudioOutput !== "function") return null;
  try {
    const d = await md.selectAudioOutput();
    return { deviceId: d.deviceId, label: d.label || "Speaker" };
  } catch {
    return null;
  }
}

export type ToneResult = { ok: boolean; routed: "applied" | "fallback-default" | "unsupported"; error?: string };

/**
 * Play a short two-note chime on the chosen speaker at the chosen volume — the
 * same route the agent's voice takes (an <audio> element with setSinkId).
 * Must be called from a click so the browser allows playback.
 */
export async function playTestTone(opts: { deviceId: string; volume: number; durationMs?: number }): Promise<ToneResult> {
  const duration = (opts.durationMs ?? 900) / 1000;
  let ctx: AudioContext | null = null;
  const el = document.createElement("audio");
  el.dataset.voiceTestTone = "1";
  try {
    ctx = new AudioContext();
    await ctx.resume().catch(() => undefined);
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.connect(dest);
    const t0 = ctx.currentTime + 0.02;
    const notes: Array<[number, number, number]> = [
      [659.25, 0, duration * 0.45],
      [880, duration * 0.4, duration * 0.6],
    ];
    gain.gain.setValueAtTime(0, t0);
    for (const [freq, at, len] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
    el.srcObject = dest.stream;
    el.volume = clampVolume(opts.volume);
    document.body.appendChild(el);
    const routed = await applySink(el, opts.deviceId);
    await el.play();
    await new Promise((r) => setTimeout(r, duration * 1000 + 150));
    return { ok: true, routed };
  } catch (err) {
    return { ok: false, routed: "unsupported", error: err instanceof Error ? err.message : String(err) };
  } finally {
    el.pause();
    el.srcObject = null;
    el.remove();
    void ctx?.close().catch(() => undefined);
  }
}

// ── silent replies ──────────────────────────────────────────────────────────

/** Agent audio this long before a reply's text still counts as that reply being spoken. */
export const SILENT_LOOKBACK_MS = 12_000;
/** How long after the text to wait for audio before calling the reply silent. */
export const SILENT_GRACE_MS = 6_000;

/**
 * "The agent answered in text but no voice arrived." Robovoice publishes each
 * agent line as text; its audio is a separate track. When the speech step
 * fails on Robovoice (provider error, exhausted credits) the text still comes
 * and the track stays silent — which a caller only experiences as nothing.
 *
 *   noteAudio(t)        agent audio energy was heard at t
 *   noteReply(id, t)    an agent line arrived at t → check at t + grace
 *   due(t)              replies whose grace ended by t with no audio in
 *                       [reply - lookback, reply + grace]
 */
export class SilentReplyDetector {
  private lastAudioAt = Number.NEGATIVE_INFINITY;
  private pending: Array<{ id: string; at: number; text: string }> = [];

  constructor(
    private readonly lookbackMs = SILENT_LOOKBACK_MS,
    private readonly graceMs = SILENT_GRACE_MS,
  ) {}

  noteAudio(at: number): void {
    if (at > this.lastAudioAt) this.lastAudioAt = at;
    // Audio after a reply's text settles it.
    this.pending = this.pending.filter((p) => at < p.at - this.lookbackMs);
  }

  noteReply(id: string, at: number, text: string): void {
    if (this.lastAudioAt >= at - this.lookbackMs) return; // being / just spoken
    if (!this.pending.some((p) => p.id === id)) this.pending.push({ id, at, text });
  }

  /** Replies now known to be silent (each reported once). */
  due(now: number): Array<{ id: string; at: number; text: string }> {
    const out = this.pending.filter((p) => now >= p.at + this.graceMs);
    if (out.length) this.pending = this.pending.filter((p) => now < p.at + this.graceMs);
    return out;
  }

  get waiting(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = [];
    this.lastAudioAt = Number.NEGATIVE_INFINITY;
  }
}

/** Speak text with the browser's own voice (the last-resort fallback: free, local, always there). */
export function speakWithBrowserVoice(text: string, opts: { volume: number; lang?: string | null }): boolean {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined" || !text.trim()) return false;
  try {
    const u = new SpeechSynthesisUtterance(text.trim());
    u.volume = clampVolume(opts.volume);
    if (opts.lang) u.lang = opts.lang;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}
