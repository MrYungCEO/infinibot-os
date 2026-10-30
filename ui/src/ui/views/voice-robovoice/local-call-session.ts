/**
 * One LOCAL voice call from the Voice page — InfiniBot's built-in voice
 * provider (the default; Robovoice is the opt-in cloud option).
 *
 *   mic ─▶ Silero VAD (browser, /vad/ assets) ─▶ one WAV per utterance
 *       ─▶ POST /api/voice/stt     local Whisper (Speaches container)
 *       ─▶ POST /api/voice/turn    SSE: the gateway's voice-turn seam answers —
 *                                  direct CLI mode (the routing switch sends it
 *                                  straight to the selected Claude Code / Codex
 *                                  / OpenCode session, its reply comes back, no
 *                                  relay narration) or the selected gateway agent
 *       ─▶ POST /api/voice/tts     local Kokoro (or Speaches' Kokoro), sentence
 *                                  by sentence as the reply streams
 *   quiet line ─▶ {poll:true} every few seconds: progress / results of the
 *                 sub-agents a turn spawned are spoken on the call
 *
 * It drives the SAME CallState as a Robovoice call (console-state.ts), so the
 * Voice page renders it with no UI changes: transcript, agent state
 * (listening / thinking / speaking) for the blob and live pipeline, per-turn
 * latency, tool badge, playback.
 *
 * Every dependency is injectable; the browser implementations are at the end.
 */

import { gatewayHttpBase } from "../../gateway-http-auth.js";
import type { RoomLevels, RvCallStart } from "./call-session.js";
import { SILENT_ROOM } from "./call-session.js";
import { applySink, clampVolume, loadAudioPrefs, speakWithBrowserVoice } from "./audio-output.js";
import { callReducer, IDLE_CALL, type CallEvent, type CallState } from "./console-state.js";
import { SILENT_LEVELS, sampleLevels, type AudioLevels } from "./live-state.js";

export type LocalTurnBody = {
  message?: string;
  agentId: string;
  callKey: string;
  sessionKey?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  poll?: boolean;
  ended?: boolean;
};

export type LocalTurnEvent = {
  delta?: string;
  done?: boolean;
  text?: string;
  updates?: string[];
  running?: number;
  error?: string;
  timings?: { toolCalls?: string[]; path?: string };
};

export type MicHandle = {
  pause(): void;
  resume(): void;
  destroy(): Promise<void>;
  levels(): AudioLevels;
  speaking(): boolean;
  switchDevice?(deviceId: string): Promise<void>;
};

export type MicHandlers = {
  onSpeechStart: () => void;
  onSpeechEnd: (wav: Blob) => void;
};

export type VoicePlayer = {
  /** Start synthesizing now (the reply streams faster than it is spoken). */
  synth(text: string, signal: AbortSignal): Promise<Blob>;
  /** Play one clip; resolves when it finished (or was stopped). */
  play(audio: Blob, signal: AbortSignal): Promise<void>;
  stop(): void;
  level(): number;
  playing(): boolean;
  setOutput(deviceId: string, volume: number): Promise<"applied" | "fallback-default" | "unsupported">;
  /** Inside a tap: let the browser play the agent later. */
  unlock(): void;
};

export type LocalCallDeps = {
  onChange: (state: CallState, start: RvCallStart | null) => void;
  openMic: (deviceId: string, h: MicHandlers) => Promise<MicHandle>;
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>;
  turn: (body: LocalTurnBody, onEvent: (e: LocalTurnEvent) => void, signal: AbortSignal) => Promise<void>;
  player: VoicePlayer;
  /** Fallback voice when local TTS fails (default: the browser's, if enabled). */
  speakFallback?: (text: string) => boolean;
  now?: () => number;
  newCallKey?: () => string;
  /** How often a quiet line asks for spawned-work updates (default 5 s). */
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

/** A transcript that only echoes what the agent just said (speaker bleed), not the user. */
export function isLikelyEcho(heard: string, spoken: ReadonlyArray<{ text: string; at: number }>, now: number, windowMs = 10_000): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const h = norm(heard);
  if (!h || h.split(" ").length < 2) return false;
  return spoken.some((s) => now - s.at < windowMs && norm(s.text).includes(h));
}

/** Whisper's stock hallucinations on breath / silence. */
const NOISE = /^(?:you|thank you\.?|thanks for watching!?|\.+|bye\.?|uh+|um+|hmm+)$/i;

export class LocalVoiceCallSession {
  state: CallState = IDLE_CALL;
  start: RvCallStart | null = null;
  private mic: MicHandle | null = null;
  private turnCtl: AbortController | null = null;
  private callCtl: AbortController | null = null;
  private pollTimer: unknown = null;
  private muted = false;
  private seq = 0;
  private callKey = "";
  private agentId = "main";
  private sessionKey: string | undefined;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private spoken: Array<{ text: string; at: number }> = [];
  private speechChain: Promise<void> = Promise.resolve();
  private polling = false;

  constructor(private readonly deps: LocalCallDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private dispatch(ev: CallEvent): void {
    this.state = callReducer(this.state, ev);
    this.deps.onChange(this.state, this.start);
  }

  private live(): boolean {
    return this.state.phase === "active" || this.state.phase === "connecting";
  }

  async begin(agentId: string, opts: { sessionKey?: string | null } = {}): Promise<void> {
    const sessionKey = opts.sessionKey?.trim() || undefined;
    this.dispatch({ type: "start", agentId, sessionKey: sessionKey ?? null });
    if (this.state.phase !== "starting") return;
    this.agentId = agentId;
    this.sessionKey = sessionKey;
    this.history = [];
    this.spoken = [];
    this.muted = false;
    this.callKey = (this.deps.newCallKey ?? defaultCallKey)();
    this.callCtl = new AbortController();
    const startedAt = new Date(this.now()).toISOString();
    this.start = { mode: "local", room: this.callKey, started_at: startedAt };
    this.dispatch({ type: "started", room: this.callKey, mode: "device", startedAt });
    this.dispatch({ type: "media", media: "connecting" });
    try {
      this.mic = await this.deps.openMic(loadAudioPrefs().micDeviceId, {
        onSpeechStart: () => undefined,
        onSpeechEnd: (wav) => void this.onUtterance(wav),
      });
    } catch (err) {
      const msg = errText(err);
      this.dispatch({ type: "fail", error: /denied|NotAllowed/i.test(msg) ? "Microphone access was blocked — allow it for this page and try again." : `Microphone unavailable: ${msg}` });
      this.callCtl = null;
      return;
    }
    if (!this.live()) {
      // Ended while the mic was opening.
      await this.mic.destroy().catch(() => undefined);
      this.mic = null;
      return;
    }
    this.dispatch({ type: "media", media: "connected" });
    this.dispatch({ type: "status", live: true, participants: 1 });
    this.dispatch({ type: "agent-state", state: "listening" });
    this.schedulePoll();
  }

  /** One finished utterance from the VAD (exposed for tests). */
  async onUtterance(wav: Blob): Promise<void> {
    if (this.muted || !this.live()) return;
    const ctl = this.callCtl;
    if (!ctl) return;
    const speechEndAt = this.now();
    let text = "";
    try {
      text = (await this.deps.transcribe(wav, ctl.signal)).trim();
    } catch (err) {
      if (!ctl.signal.aborted) this.dispatch({ type: "transcript", line: { id: `e-${this.seq++}`, who: "agent", text: `I couldn't hear that: speech-to-text failed (${errText(err)}).`, final: true, at: this.now() } });
      return;
    }
    if (!text || NOISE.test(text) || !this.live()) return;
    if (isLikelyEcho(text, this.spoken, this.now())) return;
    const sttDoneAt = this.now();
    // Barge-in: a new utterance replaces whatever the agent was still saying.
    this.cancelTurn();
    this.dispatch({ type: "transcript", line: { id: `u-${this.seq++}`, who: "you", text, final: true, at: sttDoneAt } });
    await this.runTurn(text, speechEndAt, sttDoneAt);
  }

  private cancelTurn(): void {
    this.turnCtl?.abort();
    this.turnCtl = null;
    this.deps.player.stop();
    this.speechChain = Promise.resolve();
  }

  /** Speak one piece of the reply: synthesis starts now, playback queues behind earlier pieces. */
  private say(text: string, signal: AbortSignal, onFirstAudio?: () => void): void {
    const t = text.trim();
    if (!t) return;
    this.spoken = [...this.spoken, { text: t, at: this.now() }].slice(-20);
    const audio = this.deps.player.synth(t, signal).catch((err: unknown) => err as Error);
    this.speechChain = this.speechChain.then(async () => {
      if (signal.aborted) return;
      const clip = await audio;
      if (signal.aborted) return;
      if (clip instanceof Blob) {
        this.dispatch({ type: "agent-state", state: "speaking" });
        onFirstAudio?.();
        await this.deps.player.play(clip, signal);
        return;
      }
      // Local TTS failed: the UI shows the fault; the browser voice may cover it.
      const fallback = (this.deps.speakFallback ?? defaultSpeakFallback)(t);
      this.dispatch({ type: "silent-reply", text: t, at: this.now(), fallback });
    });
  }

  private async runTurn(message: string, speechEndAt: number, sttDoneAt: number): Promise<void> {
    const ctl = new AbortController();
    this.turnCtl = ctl;
    this.dispatch({ type: "agent-state", state: "thinking" });
    const lineId = `a-${this.seq++}`;
    let reply = "";
    let firstDeltaAt: number | null = null;
    let firstAudioAt: number | null = null;
    const onFirstAudio = () => {
      if (firstAudioAt !== null) return;
      firstAudioAt = this.now();
      this.dispatch({ type: "audio-in" });
      this.dispatch({ type: "playback", playback: "playing" });
      this.dispatch({
        type: "latency",
        sample: {
          at: firstAudioAt,
          totalMs: firstAudioAt - speechEndAt,
          sttToLlmMs: firstDeltaAt !== null ? firstDeltaAt - sttDoneAt : null,
          llmToTtsMs: firstDeltaAt !== null ? firstAudioAt - firstDeltaAt : null,
        },
      });
    };
    let failed: string | null = null;
    let done: LocalTurnEvent | null = null;
    try {
      await this.deps.turn(
        {
          message,
          agentId: this.agentId,
          callKey: this.callKey,
          ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}),
          ...(this.history.length ? { history: this.history.slice(-12) } : {}),
        },
        (e) => {
          if (ctl.signal.aborted) return;
          if (e.delta) {
            firstDeltaAt ??= this.now();
            reply += e.delta;
            this.dispatch({ type: "transcript", line: { id: lineId, who: "agent", text: reply.trim(), final: false, at: this.now() } });
            this.say(e.delta, ctl.signal, onFirstAudio);
          } else if (e.done) {
            done = e;
          } else if (e.error) {
            failed = e.error;
          }
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted) failed = errText(err);
    }
    if (ctl.signal.aborted) return;
    const finalDone = done as LocalTurnEvent | null;
    if (finalDone?.timings?.toolCalls?.length) this.dispatch({ type: "tool", tool: { used: true, names: finalDone.timings.toolCalls } });
    const text = (reply || finalDone?.text || "").trim();
    if (failed && !text) {
      const said = `Sorry, that turn failed: ${failed}`;
      this.dispatch({ type: "transcript", line: { id: lineId, who: "agent", text: said, final: true, at: this.now() } });
      this.say("Sorry, that didn't work.", ctl.signal, onFirstAudio);
    } else if (text) {
      this.dispatch({ type: "transcript", line: { id: lineId, who: "agent", text, final: true, at: this.now() } });
      if (!reply) this.say(text, ctl.signal, onFirstAudio);
      this.history = [...this.history, { role: "user" as const, content: message }, { role: "assistant" as const, content: text }].slice(-24);
    }
    await this.speechChain;
    if (this.turnCtl === ctl) {
      this.turnCtl = null;
      if (this.live()) this.dispatch({ type: "agent-state", state: "listening" });
    }
  }

  private schedulePoll(): void {
    this.stopPoll();
    if (!this.live()) return;
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.pollTimer = set(() => void this.poll(), this.deps.pollMs ?? 5_000);
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.pollTimer);
    this.pollTimer = null;
  }

  /** Speak what background work (spawned sub-agents) reported since the last turn (exposed for tests). */
  async poll(): Promise<void> {
    this.pollTimer = null;
    const ctl = this.callCtl;
    if (!ctl || !this.live()) return;
    // Only on a quiet line: never talk over a turn in flight.
    if (!this.turnCtl && !this.polling && !this.deps.player.playing()) {
      this.polling = true;
      const updates: string[] = [];
      try {
        await this.deps.turn(
          { agentId: this.agentId, callKey: this.callKey, poll: true, ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}) },
          (e) => {
            if (e.done && e.updates?.length) updates.push(...e.updates);
          },
          ctl.signal,
        );
      } catch {
        /* transient — next poll */
      } finally {
        this.polling = false;
      }
      if (updates.length && this.live() && !this.turnCtl) {
        const speak = new AbortController();
        this.turnCtl = speak;
        for (const u of updates) {
          this.dispatch({ type: "transcript", line: { id: `p-${this.seq++}`, who: "agent", text: u, final: true, at: this.now() } });
          this.say(u, speak.signal);
        }
        await this.speechChain;
        if (this.turnCtl === speak) {
          this.turnCtl = null;
          if (this.live()) this.dispatch({ type: "agent-state", state: "listening" });
        }
      }
    }
    this.schedulePoll();
  }

  async setMuted(muted: boolean): Promise<void> {
    this.muted = muted;
    if (muted) this.mic?.pause();
    else this.mic?.resume();
  }

  async setOutput(deviceId: string, volume: number): Promise<void> {
    const routed = await this.deps.player.setOutput(deviceId, volume);
    if (this.live()) this.dispatch({ type: "output", output: { deviceId: routed === "applied" ? deviceId : "", routed } });
  }

  async setMicDevice(deviceId: string): Promise<void> {
    await this.mic?.switchDevice?.(deviceId);
  }

  startAudio(): Promise<void> {
    this.deps.player.unlock();
    return Promise.resolve();
  }

  levels(): RoomLevels {
    if (!this.mic) return SILENT_ROOM;
    const agentSpeaking = this.deps.player.playing();
    return {
      mic: this.muted ? SILENT_LEVELS : this.mic.levels(),
      agentLevel: agentSpeaking ? Math.max(this.deps.player.level(), 8) : 0,
      userSpeaking: !this.muted && this.mic.speaking(),
      agentSpeaking,
    };
  }

  async end(): Promise<void> {
    if (!this.live() && this.state.phase !== "starting") return;
    this.dispatch({ type: "end" });
    this.stopPoll();
    this.cancelTurn();
    const callKey = this.callKey;
    this.callCtl?.abort();
    this.callCtl = null;
    const mic = this.mic;
    this.mic = null;
    await Promise.allSettled([
      mic ? mic.destroy() : Promise.resolve(),
      // Background results of this call now go to the chat only.
      callKey ? this.deps.turn({ agentId: this.agentId, callKey, ended: true, ...(this.sessionKey ? { sessionKey: this.sessionKey } : {}) }, () => undefined, new AbortController().signal) : Promise.resolve(),
    ]);
    this.dispatch({ type: "ended" });
  }

  reset(): void {
    this.stopPoll();
    this.dispatch({ type: "reset" });
    this.start = null;
  }

  dispose(): void {
    this.stopPoll();
    this.cancelTurn();
    this.callCtl?.abort();
    void this.mic?.destroy();
    this.mic = null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultCallKey(): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local-${id}`;
}

function defaultSpeakFallback(text: string): boolean {
  const prefs = loadAudioPrefs();
  return prefs.fallbackVoice ? speakWithBrowserVoice(text, { volume: prefs.volume }) : false;
}

// ── Browser implementations ─────────────────────────────────────────────────

/** Silero VAD on the picked microphone; one WAV per utterance. */
export async function openBrowserMic(deviceId: string, h: MicHandlers): Promise<MicHandle> {
  const { MicVAD, utils } = await import("@ricky0123/vad-web");
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let speaking = false;
  let wantedDevice = deviceId;
  const tap = (s: MediaStream) => {
    try {
      ctx ??= new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.4;
      ctx.createMediaStreamSource(s).connect(analyser);
      buf = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      analyser = null;
      buf = null;
    }
  };
  const getStream = async () => {
    const audio: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (wantedDevice) audio.deviceId = { exact: wantedDevice };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (!wantedDevice) throw err;
      // The saved mic is gone: use the default one.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
    tap(stream);
    return stream;
  };
  const make = () =>
    MicVAD.new({
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
      model: "v5",
      getStream,
      onSpeechStart: () => {
        speaking = true;
        h.onSpeechStart();
      },
      onVADMisfire: () => {
        speaking = false;
      },
      onSpeechEnd: (audio: Float32Array) => {
        speaking = false;
        h.onSpeechEnd(new Blob([utils.encodeWAV(audio)], { type: "audio/wav" }));
      },
    });
  let vad = await make();
  await vad.start();
  const stopStream = () => {
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
  };
  return {
    pause: () => void vad.pause(),
    resume: () => void vad.start(),
    speaking: () => speaking,
    levels: () => {
      if (!analyser || !buf) return SILENT_LEVELS;
      analyser.getByteFrequencyData(buf);
      return sampleLevels(buf);
    },
    switchDevice: async (id: string) => {
      wantedDevice = id;
      await vad.destroy();
      stopStream();
      vad = await make();
      await vad.start();
    },
    destroy: async () => {
      await vad.destroy();
      stopStream();
      await (ctx as AudioContext | null)?.close().catch(() => undefined);
      ctx = null;
    },
  };
}

/** Local Whisper through the gateway (Speaches container). */
export async function transcribeLocal(wav: Blob, signal: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append("file", wav, "utterance.wav");
  form.append("response_format", "json");
  const res = await fetch(`${gatewayHttpBase()}/api/voice/stt`, { method: "POST", body: form, signal });
  const data = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!res.ok) throw new Error(data?.error || `speech-to-text HTTP ${res.status}`);
  return typeof data?.text === "string" ? data.text : "";
}

/** POST /api/voice/turn and feed each SSE event to `onEvent`. */
export async function runLocalTurn(body: LocalTurnBody, onEvent: (e: LocalTurnEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${gatewayHttpBase()}/api/voice/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || `voice turn HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = pending.indexOf("\n\n")) >= 0) {
      const block = pending.slice(0, cut);
      pending = pending.slice(cut + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as LocalTurnEvent);
        } catch {
          /* partial / foreign line */
        }
      }
    }
  }
}

/** Local TTS (/api/voice/tts → Kokoro / Speaches) played on the picked speaker, with a level meter. */
export function createBrowserPlayer(): VoicePlayer {
  let el: HTMLAudioElement | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let isPlaying = false;
  let output = { deviceId: loadAudioPrefs().outputDeviceId, volume: loadAudioPrefs().volume };
  let stopCurrent: (() => void) | null = null;
  const element = (): HTMLAudioElement => {
    if (el) return el;
    el = document.createElement("audio");
    el.setAttribute("playsinline", "");
    el.dataset.localVoiceCall = "1";
    el.volume = clampVolume(output.volume);
    document.body.appendChild(el);
    try {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.5;
      ctx.createMediaElementSource(el).connect(analyser);
      analyser.connect(ctx.destination);
      buf = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      analyser = null;
    }
    void applySink(el, output.deviceId);
    return el;
  };
  return {
    async synth(text, signal) {
      const res = await fetch(`${gatewayHttpBase()}/api/voice/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text, response_format: "mp3" }),
        signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `text-to-speech HTTP ${res.status}`);
      }
      return res.blob();
    },
    play(audio, signal) {
      const a = element();
      void ctx?.resume().catch(() => undefined);
      const url = URL.createObjectURL(audio);
      return new Promise<void>((resolve) => {
        const finish = () => {
          isPlaying = false;
          stopCurrent = null;
          a.removeEventListener("ended", finish);
          a.removeEventListener("error", finish);
          signal.removeEventListener("abort", stop);
          URL.revokeObjectURL(url);
          resolve();
        };
        const stop = () => {
          a.pause();
          finish();
        };
        stopCurrent = stop;
        a.addEventListener("ended", finish);
        a.addEventListener("error", finish);
        signal.addEventListener("abort", stop);
        a.src = url;
        isPlaying = true;
        a.play().catch(finish);
      });
    },
    stop() {
      stopCurrent?.();
    },
    level() {
      if (!analyser || !buf) return isPlaying ? 30 : 0;
      analyser.getByteFrequencyData(buf);
      return sampleLevels(buf).level;
    },
    playing: () => isPlaying,
    async setOutput(deviceId, volume) {
      output = { deviceId, volume };
      const a = element();
      a.volume = clampVolume(volume);
      return applySink(a, deviceId);
    },
    unlock() {
      const a = element();
      void ctx?.resume().catch(() => undefined);
      if (!a.src) void a.play().catch(() => undefined);
    },
  };
}

/** The browser wiring of a local call. */
export function browserLocalCallDeps(onChange: LocalCallDeps["onChange"]): LocalCallDeps {
  return { onChange, openMic: openBrowserMic, transcribe: transcribeLocal, turn: runLocalTurn, player: createBrowserPlayer() };
}
