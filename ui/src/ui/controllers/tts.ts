/**
 * TTS Controller — speak agent replies.
 *
 * Local voice (the default): this gateway's /api/voice/tts (local Kokoro, or
 * the Speaches container's Kokoro) — free, no account.
 * Cloud voice (Robovoice selected): every synthesis is one
 * robovoice.speech.tts request (free — measured for fair use only); when
 * Robovoice is off, unlinked or busy, speaking fails with a
 * TtsUnavailableError whose message says what to do (busy → switch to local voice).
 *
 * The provider / model / voice picks are the chat sidebar's speech prefs
 * (components/chat-speech-state.ts), so a voice chosen in one place is used
 * everywhere. The choices come from robovoice.speech.catalog — the org's real
 * account; nothing here names a provider or voice of its own.
 *
 * Sessions are keyed by an opaque key (default: messageId) so multiple
 * panels in the same tab can play concurrently and each can be paused/
 * resumed independently.
 */

import { getGatewayClient } from "../gateway-client";
import { isTabAvailable } from "../plugin-host";
import { gatewayHttpBase } from "../gateway-http-auth";
import { isCloudVoiceActive } from "./voice-provider";
import {
  WALLET_EMPTY_TEXT,
  isWalletEmptyError,
  loadSpeechPrefs,
  saveSpeechPrefs,
  speechChunks,
  speechGate,
  LOCAL_SPEECH_CATALOG,
  speechText,
  ttsReady,
  type SpeechCatalog,
  type SpeechPrefs,
  type SpeechUnavailable,
} from "../components/chat-speech-state";

/** The Robovoice TTS picks (shared with the chat sidebar). */
export type TTSSettings = Pick<SpeechPrefs, "ttsProvider" | "ttsModel" | "ttsVoice">;

export type TTSState = 'loading' | 'playing' | 'paused' | 'stopped';

/** Why speaking isn't possible right now; `reason` drives the UI hint. */
export class TtsUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "connect" | "wallet-empty" | "pick-voice" | "error",
  ) {
    super(message);
    this.name = "TtsUnavailableError";
  }
}

type Catalog = SpeechCatalog & { topUpUrl?: string };

interface PlaybackSession {
  key: string;
  audio: HTMLAudioElement | null;
  audioUrl: string | null;
  state: TTSState;
}

const CATALOG_TTL_MS = 60_000;
let catalogCache: { at: number; value: Catalog } | null = null;

const sessions = new Map<string, PlaybackSession>();

type PlaybackCallback = (key: string | null, state: TTSState) => void;
const playbackCallbacks: Set<PlaybackCallback> = new Set();

function notifyPlaybackChange(key: string | null, state: TTSState) {
  playbackCallbacks.forEach(cb => cb(key, state));
}

function setState(session: PlaybackSession, state: TTSState) {
  session.state = state;
  notifyPlaybackChange(session.key, state);
}

function disposeAudio(session: PlaybackSession) {
  if (session.audio) {
    session.audio.onended = null;
    session.audio.onerror = null;
    try { session.audio.pause(); } catch {}
    session.audio.src = '';
    session.audio = null;
  }
  if (session.audioUrl) {
    try { URL.revokeObjectURL(session.audioUrl); } catch {}
    session.audioUrl = null;
  }
}

function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// --- settings (the shared Robovoice speech prefs) -----------------------------------

export function loadTTSSettings(): TTSSettings {
  return getTTSSettings();
}

export function getTTSSettings(): TTSSettings {
  const p = loadSpeechPrefs(globalThis.localStorage);
  return { ttsProvider: p.ttsProvider, ttsModel: p.ttsModel, ttsVoice: p.ttsVoice };
}

export function saveTTSSettings(settings: Partial<TTSSettings>): TTSSettings {
  const p = { ...loadSpeechPrefs(globalThis.localStorage), ...settings };
  saveSpeechPrefs(globalThis.localStorage, p);
  return { ttsProvider: p.ttsProvider, ttsModel: p.ttsModel, ttsVoice: p.ttsVoice };
}

/**
 * The org's Robovoice speech catalog (cached for a minute). Throws a
 * TtsUnavailableError when the plugin is off, unlinked or unreachable.
 */
export async function getTTSCatalog(force = false): Promise<Catalog> {
  // Local voice (the default): one local voice, nothing metered.
  if (!isCloudVoiceActive()) return LOCAL_SPEECH_CATALOG;
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value;
  const pluginEnabled = isTabAvailable("robovoice");
  const client = getGatewayClient();
  if (!pluginEnabled) throw new TtsUnavailableError("Connect Robovoice to read replies aloud", "connect");
  if (!client) throw new TtsUnavailableError("Not connected to the gateway", "error");
  let catalog: Catalog | SpeechUnavailable | null = null;
  let rpcError: string | null = null;
  try {
    catalog = await client.request<Catalog | SpeechUnavailable>("robovoice.speech.catalog", {});
  } catch (e) {
    rpcError = e instanceof Error ? e.message : String(e);
  }
  const gate = speechGate({ pluginEnabled, loaded: true, catalog, rpcError });
  if (gate.kind === "connect") throw new TtsUnavailableError("Connect Robovoice to read replies aloud", "connect");
  if (gate.kind === "error") throw new TtsUnavailableError(`Robovoice speech unavailable: ${gate.message}`, "error");
  if (gate.kind === "hidden") throw new TtsUnavailableError("Robovoice speech unavailable", "error");
  catalogCache = { at: Date.now(), value: gate.catalog as Catalog };
  return catalogCache.value;
}

export function onPlaybackChange(callback: PlaybackCallback): () => void {
  playbackCallbacks.add(callback);
  return () => { playbackCallbacks.delete(callback); };
}

// --- playback --------------------------------------------------------------------

/**
 * Stop a session (or all sessions if no key given). Stopped sessions are
 * disposed — a subsequent speakText with the same key starts fresh.
 */
export function stopTTS(key?: string) {
  if (key) {
    const session = sessions.get(key);
    if (!session) return;
    disposeAudio(session);
    sessions.delete(key);
    notifyPlaybackChange(key, 'stopped');
    return;
  }
  for (const [k, session] of sessions) {
    disposeAudio(session);
    notifyPlaybackChange(k, 'stopped');
  }
  sessions.clear();
}

/** Pause a session without disposing it. Use resumeTTS to continue. */
export function pauseTTS(key?: string) {
  const pause = (session: PlaybackSession) => {
    if (session.state !== 'playing' || !session.audio) return;
    try { session.audio.pause(); } catch {}
    setState(session, 'paused');
  };
  if (key) {
    const session = sessions.get(key);
    if (session) pause(session);
    return;
  }
  for (const session of sessions.values()) pause(session);
}

/** Resume a paused session. */
export async function resumeTTS(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session || session.state !== 'paused' || !session.audio) return;
  try {
    await session.audio.play();
    setState(session, 'playing');
  } catch (err) {
    console.warn('[TTS] Resume failed:', err);
  }
}

/**
 * Play one chunk. `onStart` fires once the browser actually starts playing;
 * the promise settles when the chunk ends.
 */
function playChunk(session: PlaybackSession, clip: Blob, onStart: () => void): Promise<void> {
  disposeAudio(session);
  session.audioUrl = URL.createObjectURL(clip);
  const audio = new Audio(session.audioUrl);
  session.audio = audio;
  return new Promise((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('This browser could not play the audio.'));
    audio.play().then(() => {
      if (sessions.get(session.key) === session) setState(session, 'playing');
      onStart();
    }, reject);
  });
}

/**
 * Speak text through Robovoice. Resolves once playback has started (so
 * callers can offer pause right away) and rejects if it can't start; the
 * rest of a long reply keeps playing in the background. The session key
 * defaults to messageId — pass the same key later to pause/resume/stop.
 * Calling speakText with a key that already has a session replaces it.
 */
export function speakText(text: string, messageId?: string): Promise<void> {
  const key = messageId || 'default';

  const prior = sessions.get(key);
  if (prior) {
    disposeAudio(prior);
    sessions.delete(key);
  }

  const clean = speechText(text);
  if (!clean.trim()) return Promise.reject(new Error('No text to speak'));

  const session: PlaybackSession = { key, audio: null, audioUrl: null, state: 'loading' };
  sessions.set(key, session);
  notifyPlaybackChange(key, 'loading');
  const live = () => sessions.get(key) === session;
  const finish = () => {
    if (!live()) return;
    disposeAudio(session);
    sessions.delete(key);
    notifyPlaybackChange(key, 'stopped');
  };

  let started = false;
  let startResolve!: () => void;
  let startReject!: (e: unknown) => void;
  const startedP = new Promise<void>((res, rej) => { startResolve = res; startReject = rej; });
  const onStart = () => {
    if (started) return;
    started = true;
    startResolve();
  };

  void (async () => {
    if (!isCloudVoiceActive()) {
      // Local voice: this gateway's own TTS, one sentence-sized piece ahead of playback.
      const synthLocal = async (chunk: string): Promise<Blob> => {
        const res = await fetch(`${gatewayHttpBase()}/api/voice/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: chunk, response_format: "mp3" }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new TtsUnavailableError(`Local text-to-speech: ${data?.error ?? `HTTP ${res.status}`}`, "error");
        }
        return res.blob();
      };
      const chunks = speechChunks(clean, 1500);
      let nextLocal: Promise<Blob> | null = synthLocal(chunks[0]);
      for (let i = 0; i < chunks.length && nextLocal; i++) {
        const clip: Blob = await nextLocal;
        if (!live()) return;
        nextLocal = i + 1 < chunks.length ? synthLocal(chunks[i + 1]) : null;
        nextLocal?.catch(() => undefined);
        await playChunk(session, clip, onStart);
        if (!live()) return;
      }
      return;
    }
    const catalog = await getTTSCatalog();
    if (catalog.wallet.empty) throw new TtsUnavailableError(WALLET_EMPTY_TEXT, "wallet-empty");
    const prefs = loadSpeechPrefs(globalThis.localStorage);
    if (!ttsReady(prefs, catalog)) {
      throw new TtsUnavailableError("Pick a Robovoice voice in the chat speech settings", "pick-voice");
    }
    const client = getGatewayClient();
    if (!client) throw new TtsUnavailableError("Not connected to the gateway", "error");

    type TtsOut = { audioBase64: string; mime: string; charge?: { wallet?: { empty?: boolean } } };
    const synth = (chunk: string) =>
      client.request<TtsOut>("robovoice.speech.tts", {
        provider: prefs.ttsProvider,
        model: prefs.ttsModel ?? undefined,
        voice: prefs.ttsVoice,
        text: chunk,
      });
    const chunks = speechChunks(clean, catalog.pricing.limits.ttsMaxChars || 2000);
    // Synthesize one piece ahead of playback so long replies don't pause.
    let next: Promise<TtsOut> | null = synth(chunks[0]);
    for (let i = 0; i < chunks.length && next; i++) {
      const out: TtsOut = await next;
      if (!live()) return;
      next = i + 1 < chunks.length && !out.charge?.wallet?.empty ? synth(chunks[i + 1]) : null;
      next?.catch(() => undefined);
      await playChunk(session, b64ToBlob(out.audioBase64, out.mime), onStart);
      if (!live()) return;
    }
  })()
    .then(() => {
      finish();
      onStart();
    })
    .catch((e) => {
      finish();
      if (isWalletEmptyError(e)) catalogCache = null;
      const err = isWalletEmptyError(e) ? new TtsUnavailableError(WALLET_EMPTY_TEXT, "wallet-empty") : e;
      if (started) console.warn('[TTS] read-aloud stopped:', err);
      else {
        started = true;
        startReject(err);
      }
    });

  return startedP;
}

/**
 * Cycle through play → pause → resume for a message key. If nothing is
 * playing under that key, starts a new speak.
 */
export async function toggleTTS(text: string, messageId: string): Promise<void> {
  const session = sessions.get(messageId);
  if (session?.state === 'playing') {
    pauseTTS(messageId);
    return;
  }
  if (session?.state === 'paused') {
    await resumeTTS(messageId);
    return;
  }
  await speakText(text, messageId);
}

export function getMessageState(messageId: string): TTSState {
  return sessions.get(messageId)?.state ?? 'stopped';
}

export function isMessagePlaying(messageId: string): boolean {
  return sessions.get(messageId)?.state === 'playing';
}

export function isMessagePaused(messageId: string): boolean {
  return sessions.get(messageId)?.state === 'paused';
}

export function isTTSPlaying(): boolean {
  for (const session of sessions.values()) {
    if (session.state === 'playing') return true;
  }
  return false;
}
