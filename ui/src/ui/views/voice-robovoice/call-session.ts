/**
 * One Robovoice call from the Voice page.
 *
 *   1. robovoice.call.start {agentId, mode:"auto", sessionKey?} — Robovoice resolves the
 *      agent's character; if Robovoice Desktop is online in the org it takes
 *      the call locally (mode "local"), else it's a cloud call.
 *   2. cloud → join in the page: GET /plugins/robovoice/connection-details
 *      (LiveKit token for this install's Robovoice device room; Robovoice
 *      places the billing hold there) and connect with livekit-client.
 *      Transcript: data topic "lk-chat-topic" + native transcriptions.
 *      Latency: data topic "response_latency" (published per turn by the
 *      Robovoice voice agent).
 *   3. robovoice.call.status {room, since} every few seconds — live state,
 *      participants and credits charged, straight from Robovoice.
 *   4. End → robovoice.call.end {room} + leave the LiveKit room.
 *
 * A call started from a chat surface carries that chat's `sessionKey`: the
 * plugin runs every turn of the call on it, so replies and the transcript
 * land in that chat session (not the agent's main session).
 *
 * Every dependency is injectable so the lifecycle is unit-tested without a
 * browser or LiveKit.
 */

import { callReducer, CLOUD_VOICE_BUSY_TEXT, IDLE_CALL, isCloudVoiceBusy, type CallEvent, type CallState, type LatencySample, type TranscriptLine } from "./console-state.js";
import {
  AGENT_STATE_ATTRIBUTE,
  LANGUAGE_TOPIC,
  LATENCY_TOPIC,
  SILENT_LEVELS,
  TOOL_STATUS_TOPIC,
  TRANSCRIPT_TOPIC,
  parseAgentState,
  parseToolStatus,
  parseTurnLanguage,
  sampleLevels,
  type AgentVoiceState,
  type AudioLevels,
  type ToolStatus,
  type TurnLanguage,
} from "./live-state.js";
import { SilentReplyDetector, applySink, clampVolume, loadAudioPrefs, speakWithBrowserVoice } from "./audio-output.js";

export type RvCallStart = {
  ok?: boolean;
  mode: "cloud" | "local";
  character_id?: string;
  room: string;
  started_at: string;
  url?: string;
  device?: { device_id: string; name: string; hostname?: string | null };
  fellBackToCloud?: boolean;
};

export type RvCallStatus = {
  room: string;
  live: boolean;
  participants: number | null;
  usage?: { sessions: number; billable_seconds: number; credits_charged: number };
};

export type RvConnection = { serverUrl: string; participantToken: string; roomName: string; characterId?: string | null };

export type RoomHandlers = {
  onTranscript: (line: TranscriptLine) => void;
  onLatency: (sample: LatencySample) => void;
  onDisconnected: () => void;
  /** The agent's "lk.agent.state" attribute changed. */
  onAgentState?: (state: AgentVoiceState | null) => void;
  onTool?: (tool: ToolStatus) => void;
  onLanguage?: (language: TurnLanguage) => void;
  /** The browser is playing the agent's audio, or refused to (autoplay policy). */
  onPlayback?: (playback: "playing" | "blocked") => void;
  /** Agent voice audio really arrived in this browser (energy on its track). */
  onAudioIn?: () => void;
  /** The agent answered in text but no voice audio came with it. */
  onSilentReply?: (reply: { text: string; at: number }) => void;
  /** Where the agent's voice is routed: the picked speaker, or the default when it is gone / unsupported. */
  onOutput?: (output: OutputRoute) => void;
};

export type OutputRoute = { deviceId: string; routed: "applied" | "fallback-default" | "unsupported" };

/** Per-frame audio read-out of the room: what the voice blob animates from. */
export type RoomLevels = { mic: AudioLevels; agentLevel: number; userSpeaking: boolean; agentSpeaking: boolean };
export const SILENT_ROOM: RoomLevels = { mic: SILENT_LEVELS, agentLevel: 0, userSpeaking: false, agentSpeaking: false };

export type JoinedRoom = {
  leave: () => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  /** Sample the mic + agent audio analysers now (cheap; called from rAF). */
  levels?: () => RoomLevels;
  /** Unlock blocked agent audio; must run inside a tap/click. */
  startAudio?: () => Promise<void>;
  /** Route the agent's voice to a speaker ("" = system default) and set its volume (0..1), live. */
  setOutput?: (deviceId: string, volume: number) => Promise<void>;
  /** Switch the microphone mid-call ("" = system default). */
  setMicDevice?: (deviceId: string) => Promise<void>;
};

export type CallDeps = {
  rpc: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** `sessionKey` is the chat session the call is bound to (absent = the agent's main session). */
  fetchConnection: (agentId: string, sessionKey?: string) => Promise<RvConnection>;
  joinRoom: (conn: RvConnection, handlers: RoomHandlers) => Promise<JoinedRoom>;
  onChange: (state: CallState, start: RvCallStart | null) => void;
  pollMs?: number;
  /** Fallback voice for a reply that arrived without audio (default: the browser's speech synthesis, if enabled). */
  speakFallback?: (text: string) => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

/** Optional binding of a call to the chat it was started from. */
export type CallBeginOptions = { sessionKey?: string | null };

export class RobovoiceCallSession {
  state: CallState = IDLE_CALL;
  /** Robovoice's answer to call.start (has the "open in Robovoice" url for cloud calls). */
  start: RvCallStart | null = null;
  private joined: JoinedRoom | null = null;
  private pollTimer: unknown = null;
  private disposed = false;

  constructor(private readonly deps: CallDeps) {
    if (typeof window !== "undefined") window.addEventListener("infinibot:daily-limit", this.onDailyLimit);
  }

  /** Hosted Free hit its daily limit (cloud/daily-limit.ts): hang up cleanly. */
  private readonly onDailyLimit = (ev: Event): void => {
    const reached = (ev as CustomEvent<{ reached?: boolean }>).detail?.reached === true;
    if (reached && this.state.room) void this.end();
  };

  private dispatch(ev: CallEvent): void {
    this.state = callReducer(this.state, ev);
    this.deps.onChange(this.state, this.start);
  }

  async begin(agentId: string, opts: CallBeginOptions = {}): Promise<void> {
    const sessionKey = opts.sessionKey?.trim() || undefined;
    this.dispatch({ type: "start", agentId, sessionKey: sessionKey ?? null });
    if (this.state.phase !== "starting") return;
    this.start = null;
    let start: RvCallStart;
    try {
      start = await this.deps.rpc<RvCallStart>("robovoice.call.start", sessionKey ? { agentId, mode: "auto", sessionKey } : { agentId, mode: "auto" });
    } catch (err) {
      const msg = errText(err);
      this.dispatch({ type: "fail", error: isCloudVoiceBusy(msg) ? CLOUD_VOICE_BUSY_TEXT : msg });
      return;
    }
    this.start = start;
    this.dispatch({
      type: "started",
      room: start.room,
      mode: start.mode,
      startedAt: start.started_at,
      desktopName: start.device?.name ?? null,
    });
    if (start.mode === "cloud") await this.joinAudio(agentId, sessionKey);
    this.schedulePoll(0);
  }

  private async joinAudio(agentId: string, sessionKey?: string): Promise<void> {
    this.dispatch({ type: "media", media: "connecting" });
    let conn: RvConnection;
    try {
      conn = sessionKey ? await this.deps.fetchConnection(agentId, sessionKey) : await this.deps.fetchConnection(agentId);
    } catch (err) {
      const msg = errText(err);
      // Cloud voice busy (fair-use limit): the call fails with the friendly line;
      // the UI offers the one-click switch to local voice. Never a top-up.
      if (isCloudVoiceBusy(msg)) {
        this.dispatch({ type: "fail", error: CLOUD_VOICE_BUSY_TEXT });
        return;
      }
      this.dispatch({ type: "media", media: "unavailable", error: msg });
      return;
    }
    // Robovoice tracks the in-page call under this install's device room.
    this.dispatch({ type: "media", media: "connecting", room: conn.roomName });
    // LiveKit emits Disconnected for a connect attempt that fails too; only a
    // room we actually joined can end the call.
    let joinedRoom = false;
    try {
      this.joined = await this.deps.joinRoom(conn, {
        onTranscript: (line) => this.dispatch({ type: "transcript", line }),
        onLatency: (sample) => this.dispatch({ type: "latency", sample }),
        onAgentState: (state) => this.dispatch({ type: "agent-state", state }),
        onTool: (tool) => this.dispatch({ type: "tool", tool }),
        onLanguage: (language) => this.dispatch({ type: "language", language }),
        onPlayback: (playback) => this.dispatch({ type: "playback", playback }),
        onAudioIn: () => this.dispatch({ type: "audio-in" }),
        onOutput: (output) => this.dispatch({ type: "output", output }),
        onSilentReply: (reply) => {
          const spoken = (this.deps.speakFallback ?? defaultSpeakFallback)(reply.text);
          this.dispatch({ type: "silent-reply", text: reply.text, at: reply.at, fallback: spoken });
        },
        onDisconnected: () => {
          if (!joinedRoom) return;
          this.joined = null;
          if (this.state.phase === "active" || this.state.phase === "connecting") this.dispatch({ type: "ended" });
          this.stopPoll();
        },
      });
      joinedRoom = true;
      this.dispatch({ type: "media", media: "connected" });
    } catch (err) {
      this.dispatch({ type: "media", media: "unavailable", error: errText(err) });
    }
  }

  private schedulePoll(ms = this.deps.pollMs ?? 3000): void {
    this.stopPoll();
    if (this.disposed) return;
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t));
    this.pollTimer = set(() => void this.poll(), ms);
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.pollTimer);
    this.pollTimer = null;
  }

  /** One robovoice.call.status round (exposed for tests). */
  async poll(): Promise<void> {
    this.pollTimer = null;
    const room = this.state.room;
    if (!room || (this.state.phase !== "connecting" && this.state.phase !== "active")) return;
    try {
      const st = await this.deps.rpc<RvCallStatus>("robovoice.call.status", { room, since: this.state.startedAt ?? undefined });
      this.dispatch({
        type: "status",
        live: st.live,
        participants: st.participants,
        creditsCharged: st.usage?.credits_charged ?? null,
        billableSeconds: st.usage?.billable_seconds ?? null,
      });
    } catch {
      // Transient (or the room isn't known yet) — keep polling.
    }
    if (this.state.phase === "connecting" || this.state.phase === "active") this.schedulePoll();
  }

  setMuted(muted: boolean): Promise<void> {
    return this.joined?.setMuted(muted) ?? Promise.resolve();
  }

  /** Speaker + volume for the agent's voice, applied to the live call. */
  setOutput(deviceId: string, volume: number): Promise<void> {
    return this.joined?.setOutput?.(deviceId, volume) ?? Promise.resolve();
  }

  setMicDevice(deviceId: string): Promise<void> {
    return this.joined?.setMicDevice?.(deviceId) ?? Promise.resolve();
  }

  /** "Tap to enable audio": retry playback from inside the tap. */
  startAudio(): Promise<void> {
    return this.joined?.startAudio?.() ?? Promise.resolve();
  }

  /** Live mic / agent audio levels of the joined room (silent when no audio is joined). */
  levels(): RoomLevels {
    return this.joined?.levels?.() ?? SILENT_ROOM;
  }

  async end(): Promise<void> {
    const room = this.state.room;
    this.dispatch({ type: "end" });
    this.stopPoll();
    const joined = this.joined;
    this.joined = null;
    await Promise.allSettled([
      room ? this.deps.rpc("robovoice.call.end", { room }) : Promise.resolve(),
      joined ? joined.leave() : Promise.resolve(),
    ]);
    this.dispatch({ type: "ended" });
  }

  reset(): void {
    this.stopPoll();
    this.dispatch({ type: "reset" });
    this.start = null;
  }

  dispose(): void {
    this.disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("infinibot:daily-limit", this.onDailyLimit);
    this.stopPoll();
    void this.joined?.leave();
    this.joined = null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultSpeakFallback(text: string): boolean {
  const prefs = loadAudioPrefs();
  return prefs.fallbackVoice ? speakWithBrowserVoice(text, { volume: prefs.volume }) : false;
}

// ── Browser implementations ─────────────────────────────────────────────────

/** Connection-details URL for an agent, optionally bound to a chat session. */
export function robovoiceConnectionUrl(agentId: string, base = "", sessionKey?: string | null): string {
  const q = `agent=${encodeURIComponent(agentId)}${sessionKey ? `&sessionKey=${encodeURIComponent(sessionKey)}` : ""}`;
  return `${base}/plugins/robovoice/connection-details?${q}`;
}

/** LiveKit session for an agent from the plugin's connection-details route. */
export async function fetchRobovoiceConnection(agentId: string, base = "", sessionKey?: string | null): Promise<RvConnection> {
  const res = await fetch(robovoiceConnectionUrl(agentId, base, sessionKey));
  const data = (await res.json().catch(() => null)) as (RvConnection & { error?: string }) | null;
  if (!res.ok || !data?.participantToken) {
    throw new Error(data?.error || `Robovoice connection failed (HTTP ${res.status})`);
  }
  return data;
}

export const MIC_DEVICE_KEY = "infinibot.voice.micDeviceId";
/** Agent level (0..100) that counts as real voice audio, not line noise. */
const AUDIO_IN_LEVEL = 3;
const AUDIO_WATCH_MS = 200;

type Livekit = typeof import("livekit-client");
let livekit: Livekit | null = null;
let livekitLoading: Promise<Livekit> | null = null;

/** Load livekit-client ahead of the Connect tap, so the tap itself can unlock audio on a real Room. */
export function loadLivekit(): Promise<Livekit> {
  livekitLoading ??= import("livekit-client").then((m) => (livekit = m));
  livekitLoading.catch(() => (livekitLoading = null));
  return livekitLoading;
}

type PrimedAudio = { room: InstanceType<Livekit["Room"]> | null; ctx: AudioContext | null; el: HTMLAudioElement };
let primed: PrimedAudio | null = null;

function dropPrimed(p: PrimedAudio | null): void {
  p?.el.remove();
  void p?.ctx?.close().catch(() => undefined);
}

/**
 * Unlock agent audio for the call about to start. MUST run synchronously
 * inside the Connect tap/keypress, before any await: Safari (iPad/iPhone/Mac)
 * only lets an element play if play() was asked for in a gesture, and the
 * agent's track arrives seconds later, long after the gesture is gone. So the
 * tap plays the <audio> element the agent's track will be attached to, resumes
 * the level-meter AudioContext, and runs LiveKit's own startAudio().
 */
export function primeCallAudio(): void {
  if (typeof document === "undefined") return;
  dropPrimed(primed);
  primed = null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext();
    void ctx.resume().catch(() => undefined);
  } catch {
    /* no Web Audio: levels fall back to LiveKit's speaker levels */
  }
  const el = document.createElement("audio");
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  el.dataset.robovoiceCall = "1";
  document.body.appendChild(el);
  void el.play().catch(() => undefined);
  let room: PrimedAudio["room"] = null;
  if (livekit) {
    room = new livekit.Room();
    void room.startAudio().catch(() => undefined);
  }
  primed = { room, ctx, el };
}

/** Join the Robovoice LiveKit room: mic on, agent audio played, transcript + latency surfaced. */
export async function joinLivekitRoom(conn: RvConnection, h: RoomHandlers): Promise<JoinedRoom> {
  const { Room, RoomEvent, Track } = await loadLivekit();
  const unlocked = primed;
  primed = null;
  const room = unlocked?.room ?? new Room();
  // The element the Connect tap already played (see primeCallAudio); the agent's track goes on it.
  let sink: HTMLAudioElement | null = unlocked?.el ?? null;
  const audio = new Map<string, HTMLMediaElement>();
  let seq = 0;
  // Analysers are taps only (never connected to the destination). The agent
  // one reads a CLONE of the remote track: the track the <audio> element plays
  // is never routed into Web Audio, which can silence the element (Safari).
  let ctx: AudioContext | null = unlocked?.ctx ?? null;
  let micAnalyser: AnalyserNode | null = null;
  let agentAnalyser: AnalyserNode | null = null;
  let agentTap: MediaStreamTrack | null = null;
  let micBuf: Uint8Array<ArrayBuffer> | null = null;
  let agentBuf: Uint8Array<ArrayBuffer> | null = null;
  let userSpeaking = false;
  let agentSpeaking = false;
  // LiveKit's own level for the agent (0..1): what the meter shows when the analyser can't read.
  let agentSpeakerLevel = 0;
  const tap = (track: MediaStreamTrack | undefined): AnalyserNode | null => {
    if (!track) return null;
    try {
      ctx ??= new AudioContext();
      const a = ctx.createAnalyser();
      a.fftSize = 64;
      a.smoothingTimeConstant = 0.4;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(a);
      return a;
    } catch {
      return null;
    }
  };
  const dropAgentTap = () => {
    agentTap?.stop();
    agentTap = null;
    agentAnalyser = null;
    agentBuf = null;
  };
  // Playback is reported once per change: "playing" when an agent element
  // really plays, "blocked" when the browser refused (autoplay policy).
  let playback: "playing" | "blocked" | null = null;
  const reportPlayback = (next: "playing" | "blocked") => {
    if (playback === next) return;
    playback = next;
    h.onPlayback?.(next);
  };
  const checkPlayback = () => {
    if (!room.canPlaybackAudio) return reportPlayback("blocked");
    for (const el of audio.values()) if (!el.paused && !el.muted) return reportPlayback("playing");
  };
  // Speaker + volume picked in the System panel; a speaker that is gone falls back to the default.
  let output = { deviceId: loadAudioPrefs().outputDeviceId, volume: loadAudioPrefs().volume };
  const routeOutput = async (el: HTMLMediaElement) => {
    el.volume = clampVolume(output.volume);
    const routed = await applySink(el, output.deviceId);
    h.onOutput?.({ deviceId: routed === "applied" ? output.deviceId : "", routed });
  };
  // "Text arrived, voice did not": watch the agent track's energy against its transcript lines.
  const silent = new SilentReplyDetector();
  let heardAgent = false;
  const readAgentLevel = (): number => {
    let level = 0;
    if (agentAnalyser && agentBuf) {
      agentAnalyser.getByteFrequencyData(agentBuf);
      level = sampleLevels(agentBuf).level;
    }
    if (level === 0 && agentSpeaking) level = Math.min(100, Math.round(agentSpeakerLevel * 100));
    return level;
  };
  const watch = setInterval(() => {
    const now = Date.now();
    if (readAgentLevel() >= AUDIO_IN_LEVEL || agentSpeaking) {
      silent.noteAudio(now);
      if (!heardAgent) {
        heardAgent = true;
        h.onAudioIn?.();
      }
    }
    for (const reply of silent.due(now)) {
      // The next real audio is news again (it clears the fault notice).
      heardAgent = false;
      h.onSilentReply?.({ text: reply.text, at: reply.at });
    }
  }, AUDIO_WATCH_MS);
  const noteAgentLine = (line: TranscriptLine) => {
    if (line.who === "agent" && line.final) silent.noteReply(line.id, Date.now(), line.text);
  };
  const reportAgentState = (attrs: Record<string, string> | undefined) => {
    if (attrs && AGENT_STATE_ATTRIBUTE in attrs) h.onAgentState?.(parseAgentState(attrs[AGENT_STATE_ATTRIBUTE]));
  };
  // Robovoice's agent publishes transcripts on "lk-chat-topic" (what its own
  // call page reads); native LiveKit transcriptions are only a fallback, so
  // once the data topic speaks we ignore them (no doubled lines).
  let dataTranscripts = false;
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = sink ? track.attach(sink) : track.attach();
    sink = null;
    el.dataset.robovoiceCall = "1";
    el.autoplay = true;
    el.muted = false;
    el.setAttribute("playsinline", "");
    if (!el.isConnected) document.body.appendChild(el);
    audio.set(track.sid ?? `a-${seq++}`, el);
    void routeOutput(el);
    el.addEventListener("playing", checkPlayback);
    // attach() already asked to play; a refusal here is the autoplay policy.
    if (el.paused) el.play().then(checkPlayback, (err: unknown) => (err as { name?: string })?.name === "NotAllowedError" && reportPlayback("blocked"));
    else checkPlayback();
    dropAgentTap();
    try {
      agentTap = track.mediaStreamTrack.clone();
    } catch {
      agentTap = null;
    }
    agentAnalyser = tap(agentTap ?? undefined);
    agentBuf = agentAnalyser ? new Uint8Array(agentAnalyser.frequencyBinCount) : null;
  });
  room.on(RoomEvent.AudioPlaybackStatusChanged, checkPlayback);
  // The agent's state machine, as Robovoice's call page reads it (useVoiceAssistant).
  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    if (!participant.isLocal) reportAgentState(participant.attributes);
  });
  room.on(RoomEvent.ParticipantConnected, (participant) => reportAgentState(participant.attributes));
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    userSpeaking = speakers.some((s) => s.isLocal);
    agentSpeaking = speakers.some((s) => !s.isLocal);
    agentSpeakerLevel = speakers.reduce((max, s) => (s.isLocal ? max : Math.max(max, s.audioLevel ?? 0)), 0);
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    const gone = track.detach();
    gone.forEach((el) => el.remove());
    for (const [key, el] of audio) if (gone.includes(el)) audio.delete(key);
    if (track.kind === Track.Kind.Audio) dropAgentTap();
  });
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p?: unknown, _k?: unknown, topic?: string) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (topic === TOOL_STATUS_TOPIC) {
      h.onTool?.(parseToolStatus(msg));
      return;
    }
    if (topic === LANGUAGE_TOPIC) {
      const language = parseTurnLanguage(msg);
      if (language) h.onLanguage?.(language);
      return;
    }
    if (topic === LATENCY_TOPIC && typeof msg.total_ms === "number") {
      h.onLatency({
        at: typeof msg.ts === "number" ? msg.ts : Date.now(),
        totalMs: msg.total_ms,
        sttToLlmMs: typeof msg.stt_to_llm_ms === "number" ? msg.stt_to_llm_ms : null,
        llmToTtsMs: typeof msg.llm_to_tts_ms === "number" ? msg.llm_to_tts_ms : null,
      });
      return;
    }
    const text = typeof msg.message === "string" ? msg.message : typeof msg.text === "string" ? msg.text : "";
    if ((topic === TRANSCRIPT_TOPIC || msg.type === "transcript") && text.trim()) {
      dataTranscripts = true;
      const at = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      const line: TranscriptLine = { id: `d-${at}-${msg.role}-${seq++}`, who: msg.role === "user" ? "you" : "agent", text: text.trim(), final: true, at };
      noteAgentLine(line);
      h.onTranscript(line);
    }
  });
  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    if (dataTranscripts) return;
    for (const s of segments) {
      if (!s.text?.trim()) continue;
      const line: TranscriptLine = { id: `t-${s.id}`, who: participant?.isLocal ? "you" : "agent", text: s.text.trim(), final: s.final !== false, at: Date.now() };
      noteAgentLine(line);
      h.onTranscript(line);
    }
  });
  room.on(RoomEvent.Disconnected, () => {
    clearInterval(watch);
    audio.forEach((el) => el.remove());
    audio.clear();
    sink?.remove();
    sink = null;
    dropAgentTap();
    void ctx?.close().catch(() => undefined);
    ctx = null;
    micAnalyser = null;
    h.onAgentState?.(null);
    h.onDisconnected();
  });
  try {
    await room.connect(conn.serverUrl, conn.participantToken);
  } catch (err) {
    clearInterval(watch);
    sink?.remove();
    void ctx?.close().catch(() => undefined);
    throw err;
  }
  // The microphone picked in the session's System panel (if it's still plugged in).
  const deviceId = loadAudioPrefs().micDeviceId || undefined;
  try {
    await room.localParticipant.setMicrophoneEnabled(true, deviceId ? { deviceId } : undefined);
  } catch (err) {
    if (!deviceId) throw err;
    await room.localParticipant.setMicrophoneEnabled(true);
  }
  for (const p of room.remoteParticipants.values()) reportAgentState(p.attributes);
  const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
  micAnalyser = tap(micTrack);
  micBuf = micAnalyser ? new Uint8Array(micAnalyser.frequencyBinCount) : null;
  return {
    levels: () => {
      let mic = SILENT_LEVELS;
      let agentLevel = 0;
      if (micAnalyser && micBuf) {
        micAnalyser.getByteFrequencyData(micBuf);
        mic = sampleLevels(micBuf);
      }
      if (agentAnalyser && agentBuf) {
        agentAnalyser.getByteFrequencyData(agentBuf);
        agentLevel = sampleLevels(agentBuf).level;
      }
      if (agentLevel === 0 && agentSpeaking) agentLevel = Math.min(100, Math.round(agentSpeakerLevel * 100));
      return { mic, agentLevel, userSpeaking, agentSpeaking };
    },
    startAudio: async () => {
      // In the tap: LiveKit plays every attached element and resumes its context.
      void ctx?.resume().catch(() => undefined);
      try {
        await room.startAudio();
      } catch {
        return reportPlayback("blocked");
      }
      checkPlayback();
    },
    setOutput: async (deviceId, volume) => {
      output = { deviceId, volume };
      await Promise.all([...audio.values()].map((el) => routeOutput(el)));
    },
    setMicDevice: async (id) => {
      await room.switchActiveDevice("audioinput", id || "default");
      const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
      micAnalyser = tap(track);
      micBuf = micAnalyser ? new Uint8Array(micAnalyser.frequencyBinCount) : null;
    },
    leave: async () => {
      clearInterval(watch);
      await room.disconnect();
    },
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
  };
}
