/**
 * useWakeWord — "Hey Infini", always listening while the Infini page is open.
 *
 * Two tiers, picked at runtime:
 *
 *  native   On-device keyword spotting through expo-speech-recognition's
 *           continuous mode, when that native module is present (a dev /
 *           EAS build that includes it — `npx expo install
 *           expo-speech-recognition` + its config plugin, then rebuild).
 *           Detected with requireOptionalNativeModule, so Expo Go (which
 *           does not ship it) simply falls through to the gateway tier.
 *           Audio never leaves the phone.
 *
 *  gateway  Works in Expo Go today (wake-engine.js). A low-power loop records
 *           with metering (16 kHz mono AAC .m4a); a VAD (wake-vad) cuts short
 *           voiced segments (≤ 2.5 s) and only those are sent to the user's
 *           OWN gateway — /api/voice/stt, the same local Whisper the call
 *           uses — never a third party. Silence is never uploaded; silent
 *           recordings are recycled (and deleted) every few seconds; uploads
 *           are rate limited and the meter polls slower after a minute of quiet.
 *
 * Held (no mic at all) whenever `holdReason` is set: 'muted' (the mic mute),
 * or 'hold' (a call is running — so it never hears InfiniBot's own voice — a
 * sheet holds the mic, or the page lost focus), and whenever the app leaves
 * the foreground (Expo Go cannot record in the background).
 *
 * Diagnostics: `debug` (mic level / dB, VAD state, last clip length, last STT
 * text, match + reason) updates while `withDebug` is on or a test runs.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';

import { deleteClipFile, gatewayHttp, transcribeClip } from '../voice-client';
import { micArbiter } from '../mic-arbiter';
import { explainWake, sensitivityConfig } from './wake-phrase';
import { createWakeEngine } from './wake-engine';
import { WAKE_IDLE, wakeReducer, wakeShouldListen } from './wake-machine';

/**
 * 16 kHz mono AAC in an .m4a on BOTH platforms. (LOW_QUALITY's Android
 * branch is 3GP / AMR-NB, which is 8 kHz only — a 16 kHz request fails to
 * prepare — and Whisper does not take .3gp.) iOS: MPEG4AAC at MIN quality.
 */
export const WAKE_RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  android: { ...(RecordingPresets.HIGH_QUALITY?.android || {}), extension: '.m4a', outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { ...(RecordingPresets.HIGH_QUALITY?.ios || {}), audioQuality: 0 /* AudioQuality.MIN */ },
};

/** The optional native speech recogniser (null in Expo Go / web / jest). */
export function nativeRecognizer() {
  if (Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line global-require
    const core = require('expo-modules-core');
    return core.requireOptionalNativeModule?.('ExpoSpeechRecognition') || null;
  } catch {
    return null;
  }
}

export function useWakeWord({ enabled, holdReason = null, phrases, sensitivity = 'normal', withDebug = false, onWake }) {
  const [state, dispatch] = useReducer(wakeReducer, WAKE_IDLE);
  const recorder = useAudioRecorder(WAKE_RECORDING);
  const sens = sensitivityConfig(sensitivity);
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;
  const sensRef = useRef(sens);
  sensRef.current = sens;
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const debugOnRef = useRef(withDebug);
  debugOnRef.current = withDebug;
  const [debug, setDebug] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const lastDebugAt = useRef(0);
  const lastAt = useRef(0);
  const testingRef = useRef(false);
  const tierRef = useRef(nativeRecognizer() ? 'native' : 'gateway');
  const nativeRef = useRef({ subs: [], rec: null, gen: 0, running: false });

  const engine = useMemo(
    () =>
      createWakeEngine({
        recorder,
        recordingOptions: WAKE_RECORDING,
        arbiter: micArbiter,
        setAudioMode: setAudioModeAsync,
        requestPermission: requestRecordingPermissionsAsync,
        transcribe: async (uri) => transcribeClip(await gatewayHttp(), { uri, mimeType: Platform.OS === 'web' ? 'audio/webm' : 'audio/m4a' }),
        releaseFile: deleteClipFile,
        explain: (text) => explainWake(text, phrasesRef.current, { strictness: sensRef.current.strictness }),
        emit: (ev) => dispatch(ev),
        onWake: (match, text) => onWakeRef.current?.(match, text),
        onDebug: (snap) => {
          if (!debugOnRef.current && !testingRef.current) return;
          const t = Date.now();
          // ~6 renders/s for the level bar; results always land.
          if (t - lastDebugAt.current < 160 && snap.at === lastAt.current && snap.vad !== 'off') return;
          lastDebugAt.current = t;
          lastAt.current = snap.at;
          setDebug(snap);
        },
        onTest: (res) => {
          testingRef.current = false;
          setTesting(false);
          setTestResult({ ...res, at: Date.now() });
        },
        vad: { threshold: sens.threshold, margin: sens.margin },
      }),
    [recorder], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Sensitivity → VAD threshold (the matcher reads sensRef on every clip).
  useEffect(() => {
    engine.setVad({ threshold: sens.threshold, margin: sens.margin });
  }, [engine, sens.threshold, sens.margin]);

  // Another recorder (the call, a test) taking the mic stops this one first.
  useEffect(() => micArbiter.register('wake', () => engine.yieldMic()), [engine]);

  // enable / disable / pause → reducer
  useEffect(() => {
    dispatch({ type: enabled ? 'enable' : 'disable' });
  }, [enabled]);
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener?.('change', (st) => setAppActive(st === 'active'));
    return () => sub?.remove?.();
  }, []);
  const reason = holdReason || (!appActive ? 'hold' : null);
  const prevReason = useRef(null);
  useEffect(() => {
    if (reason) dispatch({ type: 'pause', reason });
    else if (prevReason.current) dispatch({ type: 'resume', reason: prevReason.current });
    prevReason.current = reason;
  }, [reason, enabled]);
  // A wake that never turned into a call (e.g. the call failed to start) re-arms.
  useEffect(() => {
    if (state.mode !== 'woke') return undefined;
    const t = setTimeout(() => dispatch({ type: 'callEnded' }), 4000);
    return () => clearTimeout(t);
  }, [state.mode, state.wakes]);

  // ── native tier ────────────────────────────────────────────────────────────
  const stopNative = useCallback(() => {
    const n = nativeRef.current;
    n.running = false;
    n.gen += 1;
    for (const sub of n.subs) sub?.remove?.();
    n.subs = [];
    try {
      n.rec?.abort?.() ?? n.rec?.stop?.();
    } catch {
      /* already stopped */
    }
    n.rec = null;
  }, []);

  const startNative = useCallback(async () => {
    const native = nativeRecognizer();
    if (!native) return false;
    const n = nativeRef.current;
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm?.granted) {
        dispatch({ type: 'pause', reason: 'permission' });
        return true;
      }
      await micArbiter.acquire('wake');
      n.gen += 1;
      const gen = n.gen;
      n.rec = native;
      n.running = true;
      const opts = { lang: 'en-US', interimResults: true, continuous: true, requiresOnDeviceRecognition: true, addsPunctuation: true };
      const onResult = (e) => {
        if (gen !== n.gen) return;
        const text = e?.results?.[0]?.transcript || '';
        const ex = explainWake(text, phrasesRef.current, { strictness: sensRef.current.strictness });
        if (debugOnRef.current) setDebug((d) => ({ ...(d || {}), text, match: Boolean(ex.match), reason: ex.reason, at: Date.now(), vad: 'native' }));
        if (ex.match) {
          stopNative();
          micArbiter.release('wake');
          dispatch({ type: 'result', match: true, text });
          onWakeRef.current?.(ex.match, text);
        }
      };
      const onEnd = () => {
        // Continuous mode still ends on long silences: restart while armed.
        if (gen === n.gen && n.running) {
          try {
            native.start(opts);
          } catch {
            /* next arm */
          }
        }
      };
      n.subs = [native.addListener?.('result', onResult), native.addListener?.('end', onEnd)].filter(Boolean);
      native.start(opts);
      return true;
    } catch {
      stopNative();
      tierRef.current = 'gateway';
      return false;
    }
  }, [stopNative]);

  // Open / close the mic as the machine says.
  const listen = wakeShouldListen(state);
  useEffect(() => {
    if (listen) {
      if (tierRef.current === 'native') {
        void startNative().then((ok) => {
          if (!ok) void engine.start();
        });
      } else void engine.start();
    } else {
      stopNative();
      if (!engine.testing) void engine.stop();
    }
  }, [listen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      stopNative();
      void engine.stop();
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Record once and report the transcript + whether it matched. */
  const runTest = useCallback(async () => {
    if (testingRef.current) return;
    if (holdReason === 'muted') {
      setTestResult({ text: '', match: null, reason: 'The mic is muted — unmute it to test', at: Date.now() });
      return;
    }
    if (holdReason === 'call') {
      setTestResult({ text: '', match: null, reason: 'End the call first — it is using the mic', at: Date.now() });
      return;
    }
    testingRef.current = true;
    setTesting(true);
    setTestResult(null);
    await engine.runTest();
  }, [engine, holdReason]);

  return {
    state,
    dispatch,
    listening: listen,
    tier: tierRef.current,
    permissionDenied: state.pausedFor === 'permission',
    muted: state.pausedFor === 'muted',
    debug,
    testing,
    testResult,
    runTest,
    /** The call took the mic (wake → call) / gave it back. */
    callStarted: () => dispatch({ type: 'callStarted' }),
    callEnded: () => dispatch({ type: 'callEnded' }),
  };
}
