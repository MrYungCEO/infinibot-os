/**
 * Wake Word Controller — on-device keyword spotter.
 *
 * Local voice is the default (Cloud voice (Robovoice) is an optional, free
 * choice). The wake listener is a lightweight keyword spotter on the browser's ON-DEVICE speech
 * recognizer (Web Speech API with `processLocally = true`): audio never leaves
 * the machine, no model the app downloads, and the spotter itself never
 * transcribes speech — a match fires the registered callback, which starts a
 * voice call on whichever voice the user chose (enableLiveActionMode).
 *
 * If the browser has no on-device recognizer (or its language pack isn't
 * installed), the listener reports that in its status and stays off. It never
 * falls back to cloud recognition.
 */

// ============================================================
// Types & Config
// ============================================================

export interface WakeWordSettings {
  enabled: boolean;
  word: string;
  silenceTimeoutMs: number;
  forceLocal: boolean;
  threshold: number;
}

export interface PanelWakeConfig {
  panelId: string;
  enabled: boolean;
  wakeWord: string;
  callback: () => void;
  threshold?: number;
}

export const AVAILABLE_WAKE_WORDS = [
  { id: 'infini', name: 'Infini', description: 'Primary assistant' },
  { id: 'hey_infini', name: 'Hey Infini', description: 'Primary assistant' },
  { id: 'hello', name: 'Hello', description: 'Simple greeting' },
  { id: 'computer', name: 'Computer', description: 'Star Trek style' },
];

const STORAGE_KEY = "infinibot-wake-word";
const PANEL_STORAGE_KEY = "infinibot-panel-wake-words";
const WAKE_COOLDOWN_MS = 3000;

/**
 * Recognition language for the on-device recognizer (BCP-47, e.g. "en-US").
 * Stored per browser; empty = the browser's own language.
 */
const LANGUAGE_STORAGE_KEY = "infinibot-wake-language";
/** localStorage keys of the removed gateway-whisper listener (cleared once). */
const LEGACY_STT_KEYS = [
  "infinibot-wake-stt-url",
  "infinibot-wake-stt-model",
  "infinibot-wake-stt-language",
  "infinibot-wake-stt-model-migrated-medium",
];
function dropLegacySttKeys(): void {
  try {
    for (const k of LEGACY_STT_KEYS) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
function resolveLanguage(): string {
  try {
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (raw && raw.trim()) return raw.trim();
  } catch { /* ignore */ }
  return (typeof navigator !== "undefined" && navigator.language) || "en-US";
}
export function getWakeWordLanguage(): string {
  return resolveLanguage();
}
export function setWakeWordLanguage(lang: string): void {
  try {
    if ((lang ?? "").trim()) localStorage.setItem(LANGUAGE_STORAGE_KEY, lang.trim());
    else localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  } catch { /* ignore */ }
  if (listening) {
    stopCapture();
    listening = false;
    updateListenerState();
  }
}

// ============================================================
// Module State
// ============================================================

let globalSettings = loadGlobalSettings();

// ============================================================
// Microphone opt-in
// ============================================================
//
// Wake-word listening keeps the mic open, so it is opt-in: nothing calls
// getUserMedia until the user turns it on (Voice → Commands). The decision
// is made once per browser and persisted. Browsers that already carry wake
// state from before this gate existed (an enabled panel/global wake word)
// are treated as opted in, so existing installs keep listening unchanged.
const OPT_IN_KEY = "infinibot.wakeWord.micOptIn.v1";

function hadLegacyWakeState(): boolean {
  try {
    const panels = localStorage.getItem(PANEL_STORAGE_KEY);
    if (panels) {
      const parsed = JSON.parse(panels) as Record<string, { enabled?: boolean }>;
      if (Object.values(parsed ?? {}).some((p) => p?.enabled)) return true;
    }
    const global = localStorage.getItem(STORAGE_KEY);
    if (global && (JSON.parse(global) as { enabled?: boolean })?.enabled) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function resolveInitialOptIn(): boolean {
  try {
    const stored = localStorage.getItem(OPT_IN_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
    // First load with this gate: decide once, before any registration below
    // writes fresh (default-enabled) panel entries to storage.
    const decided = hadLegacyWakeState();
    localStorage.setItem(OPT_IN_KEY, decided ? "1" : "0");
    return decided;
  } catch {
    return false;
  }
}

let micOptIn = resolveInitialOptIn();

/** True when the user has allowed wake-word listening to use the microphone. */
export function isWakeWordOptedIn(): boolean {
  return micOptIn;
}

/** Turn wake-word microphone listening on/off (user action). */
export function setWakeWordOptIn(on: boolean): void {
  micOptIn = on;
  try { localStorage.setItem(OPT_IN_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  captureBlocked = null;
  captureFailures = 0;
  captureRetryAt = 0;
  if (!on) {
    stopCapture();
    listening = false;
    serverStatus = 'disconnected';
    serverError = null;
  }
  notifyStatusChange();
  updateListenerState();
}

// Capture failure handling. A missing/denied microphone won't fix itself, so
// stop trying until the user acts (retry / toggle). Other errors back off.
let captureBlocked: string | null = null;
let captureFailures = 0;
let captureRetryAt = 0;
let captureRetryTimer: number | null = null;

function describeCaptureError(e: unknown): { permanent: boolean; message: string } {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return { permanent: true, message: "No microphone found" };
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { permanent: true, message: "Microphone permission denied" };
  }
  if (typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia) {
    return { permanent: true, message: "Microphone not available in this context" };
  }
  return { permanent: false, message: (e as Error)?.message || "Mic access failed" };
}
let listening = false;
let pausedForRecording = new Set<string>();
let pauseMediaOnWake = true;

// Follower mode: when true, this tab does NOT open the mic / run capture.
// Set by the wake-coordinator on every tab except the elected leader so
// only one window is listening across an entire browser session. The
// follower still keeps its panel registrations so it can dispatch a
// wake-word locally on receiving a broadcast from the leader.
let followerMode = false;
const phraseChangeListeners = new Set<() => void>();
let phraseChangeNotifyScheduled = false;
function notifyPhraseChange() {
  if (phraseChangeNotifyScheduled) return;
  phraseChangeNotifyScheduled = true;
  queueMicrotask(() => {
    phraseChangeNotifyScheduled = false;
    for (const cb of phraseChangeListeners) { try { cb(); } catch { /* ignore */ } }
  });
}

// On-device recognizer (Web Speech API, processLocally)
type Recognizer = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecognizerCtor = {
  new (): Recognizer;
  available?: (opts: { langs: string[]; processLocally: boolean }) => Promise<string>;
};
let recognizer: Recognizer | null = null;

// Panel configs
const panelConfigs = new Map<string, PanelWakeConfig>();
const panelCooldowns = new Map<string, number>();
const legacyHandlers: Array<{ id: string; callback: () => void }> = [];
const statusListeners = new Set<() => void>();

// Active wake words
let activeWakeWords: string[] = [];

// Status
let serverStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
let serverConnected = false;
let serverError: string | null = null;

// ============================================================
// Storage
// ============================================================

function loadGlobalSettings(): WakeWordSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {}
  return defaultSettings();
}

function defaultSettings(): WakeWordSettings {
  return { enabled: false, word: "infini", silenceTimeoutMs: 3000, forceLocal: true, threshold: 0.5 };
}

function loadPanelWakeWords(): Record<string, { enabled: boolean; word: string; threshold?: number }> {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function savePanelWakeWords(data: Record<string, { enabled: boolean; word: string; threshold?: number }>) {
  try { localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(data)); } catch {}
}

// ============================================================
// Public API
// ============================================================

export function initWakeWord() {
  console.log('[WakeWord] Initializing on-device wake word detection');
  
  // Keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
      e.preventDefault();
      for (const config of panelConfigs.values()) {
        if (config.enabled) {
          console.log(`[WakeWord] Keyboard shortcut → panel ${config.panelId}`);
          config.callback();
          break;
        }
      }
    }
  });
  console.log('[WakeWord] Keyboard shortcut: Ctrl+Shift+Space');
}

export function registerPanelWakeWord(config: PanelWakeConfig): () => void {
  panelConfigs.set(config.panelId, config);
  
  const stored = loadPanelWakeWords();
  stored[config.panelId] = { enabled: config.enabled, word: config.wakeWord, threshold: config.threshold };
  savePanelWakeWords(stored);
  
  updateActiveWakeWords();
  updateListenerState();
  
  return () => {
    panelConfigs.delete(config.panelId);
    updateActiveWakeWords();
    updateListenerState();
  };
}

export function updatePanelWakeWord(panelId: string, settings: { enabled?: boolean; wakeWord?: string; threshold?: number }) {
  const config = panelConfigs.get(panelId);
  if (!config) return;

  // Short-circuit if nothing actually changed. Callers (e.g.
  // syncAgentWakeWords) reconcile blindly on every app re-render, so without
  // this guard we'd do a localStorage round-trip per agent per render — the
  // dominant CPU cost in profiler captures.
  const nextEnabled = settings.enabled !== undefined ? settings.enabled : config.enabled;
  const nextWord = settings.wakeWord !== undefined ? settings.wakeWord : config.wakeWord;
  const nextThreshold = settings.threshold !== undefined ? settings.threshold : config.threshold;
  if (
    nextEnabled === config.enabled &&
    nextWord === config.wakeWord &&
    nextThreshold === config.threshold
  ) {
    return;
  }

  config.enabled = nextEnabled;
  config.wakeWord = nextWord;
  config.threshold = nextThreshold;

  const stored = loadPanelWakeWords();
  stored[panelId] = { enabled: config.enabled, word: config.wakeWord, threshold: config.threshold };
  savePanelWakeWords(stored);

  updateActiveWakeWords();
  updateListenerState();
}

export function getPanelWakeSettings(panelId: string): { enabled: boolean; word: string; threshold?: number } {
  const stored = loadPanelWakeWords();
  return stored[panelId] || { enabled: false, word: "infini", threshold: 0.5 };
}

export async function panelStartedRecording(panelId: string): Promise<void> {
  pausedForRecording.add(panelId);
  console.log(`[WakeWord] Panel ${panelId} recording → pausing wake detection`);
  
  // Pause continuous capture while panel records
  if (pausedForRecording.size === 1) {
    stopCapture();
  }
}

export function panelStoppedRecording(panelId: string) {
  pausedForRecording.delete(panelId);
  console.log(`[WakeWord] Panel ${panelId} done → resuming wake detection`);
  
  if (pausedForRecording.size === 0 && listening && micOptIn) {
    startCapture();
  }
}

export function anyPanelWakeEnabled(): boolean {
  for (const config of panelConfigs.values()) {
    if (config.enabled) return true;
  }
  return legacyHandlers.length > 0 && globalSettings.enabled;
}

export function getWakeSettings(): WakeWordSettings {
  return { ...globalSettings };
}

export function setWakeSettings(patch: Partial<WakeWordSettings>) {
  // Turning the master listener on is an explicit user choice → mic opt-in.
  if (patch.enabled === true && !micOptIn) setWakeWordOptIn(true);
  Object.assign(globalSettings, patch);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(globalSettings)); } catch {}
  updateActiveWakeWords();
  updateListenerState();
}

export function onWakeWordDetected(id: string, callback: () => void): () => void {
  const idx = legacyHandlers.findIndex(h => h.id === id);
  if (idx >= 0) legacyHandlers[idx] = { id, callback };
  else legacyHandlers.push({ id, callback });
  updateActiveWakeWords();
  updateListenerState();
  return () => {
    const i = legacyHandlers.findIndex(h => h.id === id);
    if (i >= 0) legacyHandlers.splice(i, 1);
    updateActiveWakeWords();
    updateListenerState();
  };
}

export function isWakeListening(): boolean {
  return listening && recognizer !== null;
}

export function isWakeFailed(): boolean {
  return serverStatus === 'error';
}

export function resetWakeErrors() {
  captureBlocked = null;
  captureFailures = 0;
  captureRetryAt = 0;
  serverError = null;
  serverStatus = 'disconnected';
  notifyStatusChange();
  updateListenerState();
}

export function startWakeListener() {
  resetWakeErrors();
  updateListenerState();
}

export function stopWakeListener() {
  stopCapture();
  listening = false;
  serverStatus = 'disconnected';
  notifyStatusChange();
}

export function isElectronEnvironment(): boolean {
  const w = window as any;
  return !!(w.electronAPI || w.__INFINIBOT_GATEWAY_URL__);
}

export function onStatusChange(callback: () => void): () => void {
  statusListeners.add(callback);
  return () => statusListeners.delete(callback);
}

export function getWakeWordStatus() {
  return {
    optedIn: micOptIn,
    blocked: captureBlocked,
    listening,
    connected: serverConnected,
    status: serverStatus,
    error: serverError,
    activeWakeWords: [...activeWakeWords],
    engine: 'on-device' as const,
    language: resolveLanguage(),
  };
}

export function setPauseMediaOnWake(enabled: boolean) { pauseMediaOnWake = enabled; }
export function isPauseMediaOnWakeEnabled(): boolean { return pauseMediaOnWake; }
export function getWakeWordMode(): 'browser' | 'server' | 'disabled' {
  return anyPanelWakeEnabled() ? 'browser' : 'disabled';
}

// ============================================================
// Internal
// ============================================================

function notifyStatusChange() {
  statusListeners.forEach(cb => { try { cb(); } catch {} });
}

function updateActiveWakeWordsNow() {
  const words: string[] = [];
  for (const config of panelConfigs.values()) {
    if (config.enabled && config.wakeWord) {
      const word = config.wakeWord.toLowerCase().trim();
      if (!words.includes(word)) words.push(word);
    }
  }
  if (globalSettings.enabled && globalSettings.word) {
    const word = globalSettings.word.toLowerCase().trim();
    if (!words.includes(word)) words.push(word);
  }
  activeWakeWords = words;
  console.log(`[WakeWord] Active (${words.length}): ${JSON.stringify(words.slice(0, 8))}${words.length > 8 ? "…" : ""}`);
}

// Coalesce many bulk-register calls into one recompute per microtask.
// Bootstrapping the activity feed registers ~50 panel wake words; without
// this, updateActiveWakeWords + updateListenerState fired 50 times back-to-back
// (each spamming the console + restarting the audio capture).
let activeWordsRecomputeScheduled = false;
function updateActiveWakeWords() {
  if (activeWordsRecomputeScheduled) return;
  activeWordsRecomputeScheduled = true;
  queueMicrotask(() => {
    activeWordsRecomputeScheduled = false;
    updateActiveWakeWordsNow();
  });
}

function updateListenerStateNow() {
  // Notify the coordinator that this tab's phrase set may have changed —
  // it'll re-broadcast and possibly re-elect / re-register remote routes.
  notifyPhraseChange();

  if (followerMode) {
    // Coordinator says we're not the leader. Stay silent on the mic;
    // a leader peer is listening and will broadcast detections to us.
    if (listening) {
      stopCapture();
      listening = false;
    }
    return;
  }

  const shouldListen =
    micOptIn && (anyPanelWakeEnabled() || (globalSettings.enabled && legacyHandlers.length > 0));

  if (shouldListen && !listening) {
    if (captureBlocked) return; // quiet until the user retries
    const wait = captureRetryAt - Date.now();
    if (wait > 0) {
      if (captureRetryTimer === null) {
        captureRetryTimer = window.setTimeout(() => {
          captureRetryTimer = null;
          updateListenerState();
        }, wait);
      }
      return;
    }
    startCapture();
  } else if (!shouldListen && listening) {
    stopCapture();
    listening = false;
  }
}

/**
 * Coordinator hook. Followers tear down their own capture so only the
 * elected leader holds the mic; on becoming leader again, capture
 * resumes through the normal updateListenerState path.
 */
export function setFollowerMode(on: boolean): void {
  if (followerMode === on) return;
  followerMode = on;
  updateListenerState();
}

export function isFollowerMode(): boolean {
  return followerMode;
}

/** Subscribe to changes in the registered phrase set. */
export function onWakePhrasesChange(cb: () => void): () => void {
  phraseChangeListeners.add(cb);
  return () => phraseChangeListeners.delete(cb);
}

/**
 * Snapshot of every ORGANIC wake phrase currently registered on this tab
 * — i.e. phrases owned by tab-wake / agent-wake / compound-wake / panel
 * registrations. Excludes panels with panelId starting "coord:" because
 * those are routing-only registrations the wake-coordinator installed on
 * the leader; including them here would cause the coordinator to
 * generate codenamed variants OF its own variants on every reconcile
 * tick — exponential phrase blow-up and unbounded RAM growth.
 */
export function listRegisteredWakePhrases(): string[] {
  const set = new Set<string>();
  for (const [panelId, config] of panelConfigs.entries()) {
    if (!config.enabled || !config.wakeWord) continue;
    if (panelId.startsWith("coord:")) continue;
    set.add(config.wakeWord.toLowerCase().trim());
  }
  if (globalSettings.enabled && globalSettings.word) {
    set.add(globalSettings.word.toLowerCase().trim());
  }
  return [...set];
}

/**
 * Coordinator hook. The leader broadcasts the matched phrase back to the
 * owner peer; that peer calls this to fire its local handler as if the
 * mic had picked it up locally. Bypasses the cooldown matcher — the
 * coordinator already debounces on the leader side.
 */
export function dispatchWakeWord(phrase: string): void {
  const cleaned = (phrase || "").toLowerCase().trim();
  if (!cleaned) return;
  console.log(`[WakeWord] ← Remote dispatch: "${cleaned}"`);
  handleWakeDetection(cleaned);
}

// Coalesce listener-state recomputes too — pairs with updateActiveWakeWords.
// Avoids stopCapture/startCapture flapping while panels are still being
// registered during boot.
let listenerStateRecomputeScheduled = false;
function updateListenerState() {
  if (listenerStateRecomputeScheduled) return;
  listenerStateRecomputeScheduled = true;
  queueMicrotask(() => {
    listenerStateRecomputeScheduled = false;
    updateListenerStateNow();
  });
}

// ============================================================
// On-device capture
// ============================================================

function recognizerCtor(): RecognizerCtor | null {
  const w = (typeof window !== "undefined" ? window : {}) as {
    SpeechRecognition?: RecognizerCtor;
    webkitSpeechRecognition?: RecognizerCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Why the on-device recognizer can't run here, or null when it can. Only an
 * explicit "available" from `SpeechRecognition.available({processLocally:true})`
 * counts: "downloadable"/"downloading" mean the browser's language pack isn't
 * installed, and a browser without `available()` can't promise on-device
 * recognition at all — both keep the listener off (never cloud recognition).
 */
async function onDeviceUnavailable(lang: string): Promise<string | null> {
  const Ctor = recognizerCtor();
  if (!Ctor || typeof Ctor.available !== "function") {
    return "This browser has no on-device speech recognition — the wake word is off here";
  }
  try {
    const state = await Ctor.available({ langs: [lang], processLocally: true });
    if (state === "available") return null;
    if (state === "downloadable" || state === "downloading") {
      return `The browser's on-device speech pack for ${lang} isn't installed — the wake word is off here`;
    }
    return `On-device speech recognition isn't available for ${lang} — the wake word is off here`;
  } catch (e) {
    return (e as Error)?.message || "On-device speech recognition unavailable";
  }
}

async function startCapture() {
  if (recognizer) return; // Already running
  if (pausedForRecording.size > 0) return;
  dropLegacySttKeys();
  try {
    // Microphone check first: a missing/denied mic is permanent until the user
    // acts, and the recognizer's own errors don't say which.
    const probe = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    probe.getTracks().forEach((t) => t.stop());
  } catch (e) {
    const { permanent, message } = describeCaptureError(e);
    if (permanent) {
      if (captureBlocked !== message) console.warn(`[WakeWord] ${message} — wake word paused.`);
      captureBlocked = message;
    } else {
      captureFailures += 1;
      const delay = Math.min(60_000, 2_000 * 2 ** (captureFailures - 1));
      captureRetryAt = Date.now() + delay;
      console.warn(`[WakeWord] Failed to start capture (${message}); retrying in ${Math.round(delay / 1000)}s`);
    }
    serverError = message;
    serverStatus = "error";
    notifyStatusChange();
    return;
  }
  const lang = resolveLanguage();
  const unavailable = await onDeviceUnavailable(lang);
  if (unavailable) {
    if (captureBlocked !== unavailable) console.warn(`[WakeWord] ${unavailable}`);
    captureBlocked = unavailable;
    serverError = unavailable;
    serverStatus = "error";
    notifyStatusChange();
    return;
  }
  const Ctor = recognizerCtor()!;
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.processLocally = true;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = (e.results[i]?.[0]?.transcript ?? "").toLowerCase().trim();
      if (text) checkForWakeWord(text);
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "language-not-supported") {
      captureBlocked = `On-device speech recognition refused (${e.error})`;
      serverError = captureBlocked;
      serverStatus = "error";
      notifyStatusChange();
    }
  };
  // Continuous recognition still ends on long silence: restart while we
  // should be listening.
  rec.onend = () => {
    if (recognizer !== rec) return;
    recognizer = null;
    if (listening && !captureBlocked && pausedForRecording.size === 0 && !followerMode) {
      listening = false;
      updateListenerState();
    }
  };
  try {
    rec.start();
  } catch (e) {
    serverError = (e as Error)?.message || "Speech recognition failed to start";
    serverStatus = "error";
    notifyStatusChange();
    return;
  }
  recognizer = rec;
  listening = true;
  captureFailures = 0;
  captureRetryAt = 0;
  serverStatus = "connected";
  serverConnected = true;
  serverError = null;
  notifyStatusChange();
  console.log(`[WakeWord] Listening on-device (${lang}) for: ${activeWakeWords.slice(0, 8).join(", ")}`);
}

function stopCapture() {
  const rec = recognizer;
  recognizer = null;
  if (rec) {
    rec.onend = null;
    try { rec.abort(); } catch { /* ignore */ }
  }
}

// ── Matching primitives ─────────────────────────────────────
//
// Goals (vs. the old `transcript.includes(wakeWord)`):
//   1. Word-boundary matching — "hey miker" no longer triggers "hey mike",
//      and "infinity-fold" no longer triggers "infini".
//   2. Longest phrase wins — when both "hey mike" and "hey mike projects"
//      are registered, the more specific compound binding fires instead
//      of being pre-empted by its own prefix.
//   3. Cross-chunk stitching — a phrase that straddles the 3.5s capture
//      boundary ("hey mike" in chunk N, "projects" in chunk N+1) still
//      matches by checking the join of the last and current transcript.
//   4. Alias normalization — small swap table for the most common
//      mistranscriptions of project-specific words so the user isn't
//      penalized for recognizer quirks.

const TOKEN_ALIAS: Record<string, string> = {
  // Recognizers consistently mistranscribe "infini" because it isn't a word.
  infinity: "infini",
  infinite: "infini",
  infiniti: "infini",
  infinitybot: "infinibot",
  infinitybought: "infinibot",
  infinityboard: "infinibot",
  infiniboard: "infinibot",
  infinibought: "infinibot",
  // Common greeting variants — the recognizer picks based on prosody.
  hi: "hey",
  hay: "hey",
};

function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizePhrase(s).split(" ")) {
    if (!raw) continue;
    out.push(TOKEN_ALIAS[raw] ?? raw);
  }
  return out;
}

/** True if `phrase` appears as a contiguous run of tokens in `transcript`. */
function phraseMatches(transcriptTokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0) return false;
  if (transcriptTokens.length < phraseTokens.length) return false;
  outer: for (let i = 0; i <= transcriptTokens.length - phraseTokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (transcriptTokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

// Rolling stitch state. Holds the previous chunk's transcript so phrases
// that straddle the chunk boundary can still match. Cleared on detection
// (so the same phrase isn't refired) and expires after ~one chunk so the
// stitch only spans an adjacent pair.
let stitchTranscript = "";
let stitchExpiresAt = 0;
// Interim results arrive per phrase; stitch a phrase split across two results.
const STITCH_WINDOW_MS = 5000;

function checkForWakeWord(transcript: string) {
  const now = Date.now();

  // Build the token stream to scan. Prefer the stitched (prev+current)
  // form if the previous chunk is still fresh, otherwise just current.
  const currentTokens = tokenize(transcript);
  let scanTokens = currentTokens;
  let scanSource = transcript;
  if (stitchTranscript && now < stitchExpiresAt) {
    const stitched = `${stitchTranscript} ${transcript}`;
    scanTokens = tokenize(stitched);
    scanSource = stitched;
  }

  // Longest-phrase-first — the more specific binding wins. We have to do
  // this every call because activeWakeWords can change while listening.
  const sorted = [...activeWakeWords].sort((a, b) => tokenize(b).length - tokenize(a).length || b.length - a.length);

  for (const wakeWord of sorted) {
    const phraseTokens = tokenize(wakeWord);
    if (phraseMatches(scanTokens, phraseTokens)) {
      console.log(`[WakeWord] ✓ DETECTED "${wakeWord}" in "${scanSource}"`);
      // Consume the stitch so we don't refire the same phrase from the
      // overlap window on the next chunk.
      stitchTranscript = "";
      stitchExpiresAt = 0;
      handleWakeDetection(wakeWord);
      return;
    }
  }

  // No match. Diagnostic so the user can see WHY a transcript didn't fire
  // — most of the time it's because none of the registered phrases appear
  // in the heard text. Show the first few candidates for context.
  if (sorted.length === 0) {
    console.log(`[WakeWord] ✗ no phrases registered (heard: "${scanSource}")`);
  } else {
    console.log(
      `[WakeWord] ✗ no match in "${scanSource}" ` +
      `(scanning ${sorted.length} phrases, e.g. ${sorted.slice(0, 5).map((s) => JSON.stringify(s)).join(", ")}${sorted.length > 5 ? "…" : ""})`
    );
  }

  // Remember this transcript as the prefix for the next chunk.
  stitchTranscript = transcript;
  stitchExpiresAt = now + STITCH_WINDOW_MS;
}

function handleWakeDetection(wakeWord: string) {
  if (pauseMediaOnWake) {
    document.querySelectorAll("video, audio").forEach((el: any) => {
      if (!el.paused) el.pause();
    });
  }

  const detectedTokens = tokenize(wakeWord);
  const detectedNorm = detectedTokens.join(" ");

  // Dispatch loop also runs longest-first so "hey mike projects" beats
  // "hey mike" at the panel layer too. Match by exact (normalized) phrase
  // — no more substring containment that would let a short panel-wake
  // hijack a long compound-wake.
  const candidates = Array.from(panelConfigs.entries())
    .filter(([, c]) => c.enabled)
    .map(([id, c]) => ({ id, c, tokens: tokenize(c.wakeWord) }))
    .sort((a, b) => b.tokens.length - a.tokens.length || b.c.wakeWord.length - a.c.wakeWord.length);

  for (const { id: panelId, c: config, tokens } of candidates) {
    if (pausedForRecording.has(panelId)) continue;
    const lastTrigger = panelCooldowns.get(panelId) || 0;
    if (Date.now() - lastTrigger < WAKE_COOLDOWN_MS) continue;

    if (tokens.join(" ") !== detectedNorm) continue;

    console.log(`[WakeWord] → Triggering panel ${panelId}`);
    panelCooldowns.set(panelId, Date.now());
    // Don't unconditionally tear down capture here. Recording wakes (voice
    // panel etc.) call panelStartedRecording which stops the mic for the
    // duration of the recording and resumes via panelStoppedRecording.
    // Non-recording wakes (tab-wake, window-wake, compound-wake) shouldn't
    // pay that cost — previously their callback fired once and then the
    // listener stayed dead until the user navigated to the voice panel
    // and back. Cooldown prevents same-panel refire within WAKE_COOLDOWN_MS.
    try { config.callback(); } catch (e) { console.error("[WakeWord] Callback error:", e); }
    return;
  }

  for (const h of legacyHandlers) {
    try { h.callback(); } catch { /* swallow */ }
  }
}

// ── Devtools helpers ──────────────────────────────────────────
// Call from the browser console to inspect wake-word state, or to nuke
// localStorage when stale state from the earlier coordinator infinite-
// loop bug is poisoning the matcher.

function wakeStatus() {
  const panels: Array<{ panelId: string; wakeWord: string; enabled: boolean }> = [];
  for (const [panelId, config] of panelConfigs.entries()) {
    panels.push({ panelId, wakeWord: config.wakeWord, enabled: config.enabled });
  }
  return {
    listening,
    followerMode,
    captureRunning: recognizer !== null,
    activeWakeWords: [...activeWakeWords],
    activeWakeWordsCount: activeWakeWords.length,
    panels,
    panelCount: panels.length,
    engine: "on-device",
    language: resolveLanguage(),
    serverStatus,
    serverError,
    globalSettings,
  };
}

/**
 * Hard reset for wake-word state. Clears every wake-related localStorage
 * key (panel registrations, tab-wake overrides, compound-wake entries,
 * language / legacy STT overrides) and reloads. Use when localStorage is bloated
 * by the earlier coordinator infinite-loop bug (thousands of
 * `coord:hey alpha alpha alpha ...` entries).
 */
function wakeResetStorage(opts?: { reload?: boolean }) {
  const keys = [
    "infinibot-wake-word",
    "infinibot-panel-wake-words",
    "infinibot-tab-wake",
    "infinibot-compound-wake",
    "infinibot-agent-wake",
    "infinibot-voice-panel-wake",
    "infinibot-wake-language",
    ...LEGACY_STT_KEYS,
  ];
  const dropped: string[] = [];
  for (const k of keys) {
    try {
      if (localStorage.getItem(k) !== null) {
        localStorage.removeItem(k);
        dropped.push(k);
      }
    } catch { /* ignore */ }
  }
  console.log("[WakeWord] reset storage — dropped:", dropped);
  if (opts?.reload !== false) {
    console.log("[WakeWord] reloading…");
    setTimeout(() => location.reload(), 100);
  }
  return { dropped };
}

if (typeof window !== "undefined") {
  (window as unknown as {
    infinibotWakeStatus?: typeof wakeStatus;
    infinibotWakeReset?: typeof wakeResetStorage;
    infinibotDispatchWake?: typeof dispatchWakeWord;
  }).infinibotWakeStatus = wakeStatus;
  (window as unknown as {
    infinibotWakeStatus?: typeof wakeStatus;
    infinibotWakeReset?: typeof wakeResetStorage;
    infinibotDispatchWake?: typeof dispatchWakeWord;
  }).infinibotWakeReset = wakeResetStorage;
  // Diagnostic: simulate a heard wake phrase from the console without a mic.
  //   window.infinibotDispatchWake("hey infinibot")
  // Routes through the same handleWakeDetection matcher the recognizer uses, so
  // it exercises the full wake → live-action path (panel match → callback).
  (window as unknown as {
    infinibotDispatchWake?: typeof dispatchWakeWord;
  }).infinibotDispatchWake = dispatchWakeWord;
}
