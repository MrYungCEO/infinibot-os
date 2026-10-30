/**
 * Microphone check for the onboarding voice step.
 *
 *   1. ask for the mic (getUserMedia) and show a live level meter;
 *   2. record ~4 s, play it back so you hear yourself;
 *   3. when local speech-to-text is running, send the clip to
 *      `/api/voice/stt` (Speaches / Whisper on this machine) and show the words.
 *
 * The audio never leaves the machine: the clip goes to this gateway only.
 * Pure-ish state machine + a tiny driver; the view just renders `MicTestState`.
 */
import { gatewayHttpBase } from "../gateway-http-auth.js";
import { clipToWav } from "../lib/to-wav.js";

export type MicPhase = "idle" | "asking" | "listening" | "recording" | "transcribing" | "done" | "error";

export interface MicTestState {
  phase: MicPhase;
  /** 0..1 smoothed input level. */
  level: number;
  /** Highest level seen this run: "we heard you" once it clears the threshold. */
  peak: number;
  /** Seconds left while recording. */
  remaining: number;
  transcript: string | null;
  sttError: string | null;
  playbackUrl: string | null;
  error: string | null;
  deviceLabel: string | null;
}

/** Peak level that counts as "the mic picks up your voice". */
export const HEARD_THRESHOLD = 0.12;
export const RECORD_SECONDS = 4;

export const IDLE_MIC: MicTestState = {
  phase: "idle",
  level: 0,
  peak: 0,
  remaining: 0,
  transcript: null,
  sttError: null,
  playbackUrl: null,
  error: null,
  deviceLabel: null,
};

export function micHeard(s: MicTestState): boolean {
  return s.peak >= HEARD_THRESHOLD;
}

/** Plain-language message for a getUserMedia failure. */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "The browser blocked the microphone. Click the lock icon in the address bar, allow the microphone, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Plug one in or pick another input in your system settings, then try again.";
  }
  if (name === "NotReadableError") {
    return "Another app is using the microphone. Close it, then try again.";
  }
  if (typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia) {
    return "This page can't reach the microphone. Open InfiniBot on https:// or on this computer (localhost).";
  }
  return `The microphone didn't start (${String((err as Error)?.message ?? err).slice(0, 120)}).`;
}

/** RMS of a time-domain byte buffer (128 = silence) mapped to 0..1 with a little gain. */
export function levelFromBytes(buf: ArrayLike<number>): number {
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i]! - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
}

export interface MicTestDeps {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  transcribe?: (clip: Blob) => Promise<string>;
}

async function transcribeOnGateway(recorded: Blob): Promise<string> {
  // WAV works with every local engine (the built-in one needs no ffmpeg).
  const clip = await clipToWav(recorded);
  const form = new FormData();
  const ext = clip.type.includes("wav") ? "wav" : clip.type.includes("ogg") ? "ogg" : clip.type.includes("mp4") ? "m4a" : "webm";
  form.append("file", clip, `mic-check.${ext}`);
  form.append("response_format", "json");
  const res = await fetch(`${gatewayHttpBase()}/api/voice/stt`, { method: "POST", body: form });
  const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `speech-to-text HTTP ${res.status}`);
  return typeof data?.text === "string" ? data.text.trim() : "";
}

/**
 * One mic check run. `onChange` fires on every state change (about 30×/s
 * while the meter runs). Call `stop()` when the step unmounts.
 */
export class MicTest {
  state: MicTestState = { ...IDLE_MIC };
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (s: MicTestState) => void,
    private readonly deps: MicTestDeps = {},
  ) {}

  private set(patch: Partial<MicTestState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Open the mic and start the live meter. */
  async start(): Promise<void> {
    this.stop();
    this.set({ ...IDLE_MIC, phase: "asking" });
    try {
      const gum = this.deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
      this.stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      this.set({ phase: "error", error: micErrorMessage(err) });
      return;
    }
    const track = this.stream.getAudioTracks()[0];
    this.set({ phase: "listening", deviceLabel: track?.label || null });
    try {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        const now = levelFromBytes(buf);
        const level = this.state.level * 0.6 + now * 0.4;
        this.set({ level, peak: Math.max(this.state.peak, now) });
        this.raf = requestAnimationFrame(tick);
      };
      this.raf = requestAnimationFrame(tick);
    } catch {
      /* no Web Audio: recording still works, just no meter */
    }
  }

  /** Record a short clip, play it back, and transcribe it when STT is available. */
  async record(withTranscript: boolean): Promise<void> {
    if (!this.stream) await this.start();
    if (!this.stream || typeof MediaRecorder === "undefined") {
      if (this.state.phase !== "error") this.set({ phase: "error", error: "This browser can't record audio." });
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(this.stream);
    this.recorder = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    if (this.state.playbackUrl) URL.revokeObjectURL(this.state.playbackUrl);
    this.set({ phase: "recording", remaining: RECORD_SECONDS, transcript: null, sttError: null, playbackUrl: null });
    rec.start();
    this.timer = setInterval(() => {
      const left = this.state.remaining - 1;
      this.set({ remaining: Math.max(0, left) });
      if (left <= 0 && rec.state === "recording") rec.stop();
    }, 1000);
    await stopped;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const clip = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    const playbackUrl = clip.size ? URL.createObjectURL(clip) : null;
    if (!withTranscript || !clip.size) {
      this.set({ phase: "done", playbackUrl });
      return;
    }
    this.set({ phase: "transcribing", playbackUrl });
    try {
      const text = await (this.deps.transcribe ?? transcribeOnGateway)(clip);
      this.set({ phase: "done", transcript: text });
    } catch (err) {
      this.set({ phase: "done", sttError: String((err as Error)?.message ?? err).slice(0, 160) });
    }
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      if (this.recorder?.state === "recording") this.recorder.stop();
    } catch {
      /* already stopped */
    }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
