/**
 * useInfiniCall — one LOCAL InfiniBot voice call from the phone.
 *
 * The phone records an utterance (expo-audio, metered), the gateway does the
 * rest with its own local stack — exactly the web Voice page's local engine:
 *
 *   mic ─▶ /api/voice/stt (local Whisper) ─▶ /api/voice/turn (SSE; the
 *   gateway's voice seam answers: the routed CLI session or the selected
 *   gateway agent) ─▶ /api/voice/tts (local Kokoro), sentence by sentence.
 *
 * Interaction model
 *   tap the face        idle → start the call and listen
 *                       listening → send what was said now
 *                       speaking → interrupt (barge-in) and listen
 *                       thinking → cancel the turn
 *   hold "Hold to talk" push-to-talk: listen while held, send on release
 *   hands-free          after the agent speaks the face listens again; an
 *                       utterance ends by itself after ~1.4 s of quiet
 *   quiet line          every few seconds the call asks for spawned-work
 *                       updates ({poll:true}) and speaks them
 *
 * Levels for the face: mic metering while listening (every 50 ms), the
 * player's PCM samples while speaking. When the platform reports no samples
 * (Expo Go on some devices, web), the mouth follows a lip-sync envelope built
 * from the sentence's text (face-math speechEnvelopeFromText) indexed by the
 * player's real playback position, so it moves in time with the words.
 *
 * One-shot calls (start({ oneShot: true }) — used by "Hey Infini"): one
 * utterance, one reply, then the call ends by itself so the wake listener can
 * take the mic back. The utterance always ends on silence, even with
 * hands-free off.
 *
 * Mutes (mute-machine.js): with the MIC muted nothing is recorded — a
 * listening turn stops and its clip is discarded, listen() refuses to open
 * the recorder — and unmuting resumes a hands-free call. With the SPEAKER
 * muted reply sentences are not synthesised; the face lip-syncs from the
 * text envelope for the time the sentence would take to say.
 *
 * The mic is taken through the mic arbiter, so the "Hey Infini" recorder is
 * stopped and released before this one is prepared (iOS: one recording).
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { Platform } from 'react-native';
import {
  RecordingPresets,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';

import { IDLE_CALL, callReducer, friendlyError } from './call-machine';
import { micArbiter } from './mic-arbiter';
import { callOnMicMute } from './mute-machine';
import { dbToLevel, rmsLevel, sampleEnvelope, speechEnvelopeFromText } from './face-math';
import {
  NOISE,
  deleteClipFile,
  gatewayHttp,
  newCallKey,
  releaseClip,
  streamVoiceTurn,
  synthesize,
  takeSentences,
  transcribeClip,
} from './voice-client';

const RECORDING = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
};

const SPEECH_LEVEL = 0.3;
const SILENCE_MS = 1400;
const MAX_UTTERANCE_MS = 45_000;
const POLL_MS = 6_000;
const METER_MS = 50;
const ONE_SHOT_WAIT_MS = 8_000;

export function useInfiniCall({ target, handsFree = true, micMuted = false, speakerMuted = false, onReplyDone } = {}) {
  const [state, dispatch] = useReducer(callReducer, IDLE_CALL);
  const recorder = useAudioRecorder(RECORDING);
  const levelRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;
  const targetRef = useRef(target);
  targetRef.current = target;
  const handsFreeRef = useRef(handsFree);
  handsFreeRef.current = handsFree;
  const micMutedRef = useRef(micMuted);
  micMutedRef.current = micMuted;
  const speakerMutedRef = useRef(speakerMuted);
  speakerMutedRef.current = speakerMuted;

  const s = useRef({
    callKey: '',
    history: [],
    seq: 0,
    meter: null,
    pollTimer: null,
    heard: false,
    lastLoud: 0,
    startedAt: 0,
    recording: false,
    turn: null,
    speech: Promise.resolve(),
    speechGen: 0,
    player: null,
    playerSubs: [],
    synthTimer: null,
    mounted: true,
    ptt: false,
    oneShot: false,
  }).current;

  // ── speech output ──────────────────────────────────────────────────────────

  const stopPlayback = useCallback(() => {
    s.speechGen += 1;
    s.speech = Promise.resolve();
    if (s.synthTimer) clearInterval(s.synthTimer);
    s.synthTimer = null;
    for (const sub of s.playerSubs) sub?.remove?.();
    s.playerSubs = [];
    if (s.player) {
      try {
        s.player.pause();
        s.player.remove();
      } catch {
        /* already gone */
      }
    }
    s.player = null;
    levelRef.current = 0;
  }, [s]);

  const playClip = useCallback(
    (uri, gen, text = '') =>
      new Promise((resolve) => {
        if (gen !== s.speechGen) return resolve();
        const player = createAudioPlayer(uri);
        s.player = player;
        let lastSample = 0;
        let done = false;
        const t0 = Date.now();
        // Lip-sync fallback, re-timed once the real duration is known.
        let lip = speechEnvelopeFromText(text);
        let lipDur = 0;
        const finish = () => {
          if (done) return;
          done = true;
          if (s.synthTimer) clearInterval(s.synthTimer);
          s.synthTimer = null;
          for (const sub of s.playerSubs) sub?.remove?.();
          s.playerSubs = [];
          try {
            player.remove();
          } catch {
            /* fine */
          }
          if (s.player === player) s.player = null;
          releaseClip(uri);
          levelRef.current = 0;
          resolve();
        };
        try {
          player.setAudioSamplingEnabled(true);
          s.playerSubs.push(
            player.addListener('audioSampleUpdate', (sample) => {
              lastSample = Date.now();
              levelRef.current = rmsLevel(sample?.channels?.[0]?.frames);
            }),
          );
        } catch {
          /* no sampling on this platform: synthetic envelope below */
        }
        s.playerSubs.push(
          player.addListener('playbackStatusUpdate', (st) => {
            if (st?.didJustFinish) finish();
          }),
        );
        s.synthTimer = setInterval(() => {
          if (gen !== s.speechGen) return finish();
          const dur = player.duration;
          if (Date.now() - lastSample > 250) {
            if (Number.isFinite(dur) && dur > 0 && Math.abs(dur - lipDur) > 0.05) {
              lipDur = dur;
              lip = speechEnvelopeFromText(text, { durationSec: dur });
            }
            const pos = Number.isFinite(player.currentTime) && player.currentTime > 0 ? player.currentTime : (Date.now() - t0) / 1000;
            levelRef.current = sampleEnvelope(lip, pos);
          }
          // Safety net if no finish event ever arrives.
          if (Date.now() - t0 > (Number.isFinite(dur) && dur > 0 ? dur * 1000 + 1500 : 60_000)) finish();
        }, 33);
        dispatch({ type: 'speaking' });
        player.play();
      }),
    [s],
  );

  /** Speaker muted: no audio, the mouth follows the text envelope for as long as the sentence would take. */
  const playSilent = useCallback(
    (text, gen) =>
      new Promise((resolve) => {
        if (gen !== s.speechGen) return resolve();
        const env = speechEnvelopeFromText(text);
        const durMs = (env.frames.length / env.fps) * 1000;
        const t0 = Date.now();
        dispatch({ type: 'speaking' });
        if (s.synthTimer) clearInterval(s.synthTimer);
        s.synthTimer = setInterval(() => {
          const el = Date.now() - t0;
          if (gen !== s.speechGen || el >= durMs) {
            clearInterval(s.synthTimer);
            s.synthTimer = null;
            levelRef.current = 0;
            return resolve();
          }
          levelRef.current = sampleEnvelope(env, el / 1000);
        }, 33);
      }),
    [s],
  );

  /** Queue one piece of the reply: synthesis starts now, playback waits its turn. */
  const say = useCallback(
    (http, text) => {
      const t = text.trim();
      if (!t) return;
      const gen = s.speechGen;
      if (speakerMutedRef.current) {
        s.speech = s.speech.then(() => playSilent(t, gen));
        return;
      }
      const clip = synthesize(http, t).catch((err) => err);
      s.speech = s.speech.then(async () => {
        if (gen !== s.speechGen) return;
        const uri = await clip;
        if (gen !== s.speechGen) return;
        if (speakerMutedRef.current) {
          // Muted while this sentence was being synthesised.
          if (typeof uri === 'string') releaseClip(uri);
          await playSilent(t, gen);
          return;
        }
        if (typeof uri !== 'string') {
          dispatch({ type: 'line', line: { id: `tts-${s.seq++}`, who: 'system', text: `Voice output failed: ${uri?.message || uri}`, final: true } });
          return;
        }
        if (Platform.OS === 'ios') await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
        await playClip(uri, gen, t);
      });
    },
    [s, playClip, playSilent],
  );

  // ── mic ────────────────────────────────────────────────────────────────────

  const stopMeter = useCallback(() => {
    if (s.meter) clearInterval(s.meter);
    s.meter = null;
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.pollTimer = null;
  }, [s]);

  const stopRecording = useCallback(async () => {
    stopMeter();
    if (!s.recording) return null;
    s.recording = false;
    levelRef.current = 0;
    try {
      await recorder.stop();
    } catch {
      return null;
    }
    return recorder.uri || null;
  }, [s, recorder, stopMeter]);

  // Forward refs so the callbacks below can call each other.
  const finishRef = useRef(null);
  const endRef = useRef(null);
  const listenRef = useRef(null);
  const pollRef = useRef(null);

  const listen = useCallback(async () => {
    if (!stateRef.current.inCall) return;
    stopPlayback();
    if (micMutedRef.current) {
      // Muted: never open the recorder. The call stays up; typing still works.
      stopMeter();
      dispatch({ type: 'settled', listen: false });
      return;
    }
    try {
      // One recording at a time (iOS): the wake listener lets go first.
      await micArbiter.acquire('call');
      if (!stateRef.current.inCall || micMutedRef.current) return;
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      // Options every time → a fresh file, so a re-listen never overwrites a clip still uploading.
      await recorder.prepareToRecordAsync(RECORDING);
      recorder.record();
    } catch (err) {
      dispatch({ type: 'fail', error: friendlyError(err) });
      return;
    }
    s.recording = true;
    s.heard = false;
    s.lastLoud = 0;
    s.startedAt = Date.now();
    dispatch({ type: 'listening' });
    stopMeter();
    s.meter = setInterval(() => {
      let lvl = 0;
      try {
        lvl = dbToLevel(recorder.getStatus()?.metering);
      } catch {
        lvl = 0;
      }
      levelRef.current = lvl;
      const now = Date.now();
      if (lvl >= SPEECH_LEVEL) {
        s.heard = true;
        s.lastLoud = now;
      }
      if (!s.ptt && (handsFreeRef.current || s.oneShot) && s.heard && now - s.lastLoud > SILENCE_MS) void finishRef.current?.();
      else if (s.oneShot && !s.heard && now - s.startedAt > ONE_SHOT_WAIT_MS) void endRef.current?.();
      else if (now - s.startedAt > MAX_UTTERANCE_MS) {
        if (s.heard) void finishRef.current?.();
        else {
          // Nobody spoke: recycle the recording so files stay small.
          void stopRecording().then(() => listenRef.current?.());
        }
      }
    }, METER_MS);
    s.pollTimer = setInterval(() => void pollRef.current?.(), POLL_MS);
  }, [s, recorder, stopMeter, stopPlayback, stopRecording]);
  listenRef.current = listen;

  const settle = useCallback(() => {
    if (s.oneShot && stateRef.current.inCall) {
      // A wake-word turn is done: hand the mic back to the wake listener.
      void endRef.current?.();
      return;
    }
    const again = handsFreeRef.current && stateRef.current.inCall;
    dispatch({ type: 'settled', listen: false });
    if (again) void listenRef.current?.();
  }, [s]);

  const runTurn = useCallback(
    async (http, message, spokeAt) => {
      dispatch({ type: 'thinking' });
      const lineId = `a-${s.seq++}`;
      const tgt = targetRef.current || {};
      let reply = '';
      let buffered = '';
      let failed = null;
      let doneEvt = null;
      let firstAudio = false;
      const turn = streamVoiceTurn(
        http,
        {
          message,
          agentId: tgt.agentId || 'main',
          callKey: s.callKey,
          ...(tgt.sessionKey ? { sessionKey: tgt.sessionKey } : {}),
          ...(s.history.length ? { history: s.history.slice(-12) } : {}),
        },
        (e) => {
          if (e.delta) {
            reply += e.delta;
            buffered += e.delta;
            dispatch({ type: 'line', line: { id: lineId, who: 'agent', text: reply.trim(), final: false } });
            const [ready, rest] = takeSentences(buffered);
            buffered = rest;
            for (const piece of ready) {
              if (!firstAudio) {
                firstAudio = true;
                dispatch({ type: 'latency', ms: Date.now() - spokeAt });
              }
              say(http, piece);
            }
          } else if (e.done) doneEvt = e;
          else if (e.error) failed = e.error;
        },
      );
      s.turn = turn;
      try {
        await turn.promise;
      } catch (err) {
        if (err?.aborted) return;
        failed = err?.message || String(err);
      }
      if (s.turn !== turn) return; // cancelled / barged
      s.turn = null;
      if (doneEvt?.timings?.toolCalls?.length) dispatch({ type: 'tools', tools: doneEvt.timings.toolCalls });
      const text = (reply || doneEvt?.text || '').trim();
      if (failed && !text) {
        dispatch({ type: 'line', line: { id: lineId, who: 'agent', text: `Sorry, that turn failed: ${failed}`, final: true } });
        dispatch({ type: 'fail', error: friendlyError(failed) });
        return;
      }
      if (text) {
        dispatch({ type: 'line', line: { id: lineId, who: 'agent', text, final: true } });
        if (buffered.trim()) say(http, buffered);
        else if (!reply) say(http, text);
        s.history = [...s.history, { role: 'user', content: message }, { role: 'assistant', content: text }].slice(-24);
      }
      await s.speech;
      onReplyDone?.(text);
      if (stateRef.current.inCall && stateRef.current.phase !== 'error') settle();
    },
    [s, say, settle, onReplyDone],
  );

  const finish = useCallback(async () => {
    if (!s.recording) return;
    const heard = s.heard;
    const spokeAt = Date.now();
    const uri = await stopRecording();
    s.ptt = false;
    if (!uri) return settle();
    const elapsed = Date.now() - s.startedAt;
    if (!heard && elapsed < 600) {
      deleteClipFile(uri);
      return settle();
    }
    dispatch({ type: 'transcribing' });
    let http;
    let text = '';
    try {
      http = await gatewayHttp();
      text = await transcribeClip(http, { uri });
    } catch (err) {
      dispatch({ type: 'line', line: { id: `e-${s.seq++}`, who: 'system', text: `I couldn't hear that: ${err?.message || err}`, final: true } });
      dispatch({ type: 'fail', error: friendlyError(err) });
      return;
    } finally {
      deleteClipFile(uri);
    }
    if (!text || NOISE.test(text)) {
      dispatch({ type: 'line', line: { id: `n-${s.seq++}`, who: 'system', text: 'Didn’t catch that — try again.', final: true } });
      return settle();
    }
    dispatch({ type: 'line', line: { id: `u-${s.seq++}`, who: 'you', text, final: true } });
    await runTurn(http, text, spokeAt);
  }, [s, stopRecording, settle, runTurn]);
  finishRef.current = finish;

  const poll = useCallback(async () => {
    const st = stateRef.current;
    if (!st.inCall || st.phase !== 'listening' || s.heard || s.turn || s.player) return;
    let http;
    try {
      http = await gatewayHttp();
    } catch {
      return;
    }
    const updates = [];
    try {
      const tgt = targetRef.current || {};
      await streamVoiceTurn(http, { agentId: tgt.agentId || 'main', callKey: s.callKey, poll: true, ...(tgt.sessionKey ? { sessionKey: tgt.sessionKey } : {}) }, (e) => {
        if (e.done && Array.isArray(e.updates)) updates.push(...e.updates);
      }).promise;
    } catch {
      return; // transient: next poll
    }
    if (!updates.length || s.heard || stateRef.current.phase !== 'listening') return;
    await stopRecording();
    for (const u of updates) {
      dispatch({ type: 'line', line: { id: `p-${s.seq++}`, who: 'agent', text: u, final: true } });
      say(http, u);
    }
    await s.speech;
    settle();
  }, [s, say, settle, stopRecording]);
  pollRef.current = poll;

  // ── public actions ─────────────────────────────────────────────────────────

  const start = useCallback(async (opts = {}) => {
    if (stateRef.current.inCall && stateRef.current.phase !== 'error') return;
    s.oneShot = Boolean(opts.oneShot);
    dispatch({ type: 'start' });
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm?.granted) throw new Error('Microphone permission denied');
    } catch (err) {
      dispatch({ type: 'fail', error: friendlyError(err) });
      return;
    }
    if (!s.callKey) s.callKey = newCallKey();
    stateRef.current = { ...stateRef.current, inCall: true };
    await listen();
  }, [s, listen]);

  const cancelTurn = useCallback(() => {
    s.turn?.abort();
    s.turn = null;
    stopPlayback();
  }, [s, stopPlayback]);

  const end = useCallback(async () => {
    cancelTurn();
    await stopRecording();
    const callKey = s.callKey;
    const tgt = targetRef.current || {};
    s.callKey = '';
    s.history = [];
    s.oneShot = false;
    stateRef.current = { ...stateRef.current, inCall: false, phase: 'idle' };
    dispatch({ type: 'end' });
    micArbiter.release('call');
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    if (callKey) {
      // Background results of this call now go to the chat only.
      gatewayHttp()
        .then((http) => streamVoiceTurn(http, { agentId: tgt.agentId || 'main', callKey, ended: true, ...(tgt.sessionKey ? { sessionKey: tgt.sessionKey } : {}) }, () => {}).promise)
        .catch(() => {});
    }
  }, [s, cancelTurn, stopRecording]);
  endRef.current = end;

  /** Tap on the face. */
  const tap = useCallback(() => {
    const { phase } = stateRef.current;
    if (micMutedRef.current && (phase === 'idle' || phase === 'error')) return; // muted: nothing to listen with
    if (phase === 'idle' || phase === 'error') return void start();
    s.oneShot = false; // touching the face turns a wake turn into a normal call
    if (phase === 'listening') return void finish();
    if (phase === 'speaking') {
      cancelTurn();
      return void listen();
    }
    if (phase === 'thinking' || phase === 'transcribing') {
      cancelTurn();
      settle();
    }
  }, [s, start, finish, cancelTurn, listen, settle]);

  /** "Hold to talk" pressed. */
  const pttStart = useCallback(async () => {
    if (micMutedRef.current) return; // muted: push-to-talk is suspended
    s.ptt = true;
    const st = stateRef.current;
    if (!st.inCall || st.phase === 'error') return void start();
    if (st.phase === 'speaking' || st.phase === 'thinking') cancelTurn();
    if (!s.recording) await listen();
  }, [s, start, listen, cancelTurn]);

  /** "Hold to talk" released. */
  const pttEnd = useCallback(() => {
    if (s.recording) void finish();
  }, [s, finish]);

  /** Type instead of speaking (also the accessibility path). */
  const sendText = useCallback(
    async (text, opts = {}) => {
      const msg = String(text || '').trim();
      if (!msg) return;
      if (!stateRef.current.inCall) {
        s.oneShot = Boolean(opts.oneShot);
        if (!s.callKey) s.callKey = newCallKey();
        dispatch({ type: 'start' });
        stateRef.current = { ...stateRef.current, inCall: true };
      }
      await stopRecording();
      cancelTurn();
      dispatch({ type: 'line', line: { id: `u-${s.seq++}`, who: 'you', text: msg, final: true } });
      try {
        const http = await gatewayHttp();
        await runTurn(http, msg, Date.now());
      } catch (err) {
        dispatch({ type: 'fail', error: friendlyError(err) });
      }
    },
    [s, stopRecording, cancelTurn, runTurn],
  );

  // Another recorder (a phrase test) taking the mic stops this one; the clip is dropped.
  useEffect(
    () =>
      micArbiter.register('call', async () => {
        const uri = await stopRecording();
        deleteClipFile(uri);
        s.ptt = false;
        if (stateRef.current.phase === 'listening') dispatch({ type: 'settled', listen: false });
      }),
    [s, stopRecording],
  );

  // Mic mute: stop a listening turn (discard the clip); unmute resumes hands-free listening.
  useEffect(() => {
    const st = stateRef.current;
    const act = callOnMicMute({ micMuted, inCall: st.inCall, phase: st.phase, handsFree: handsFreeRef.current });
    if (act === 'stopListening') {
      s.ptt = false;
      void stopRecording().then((uri) => {
        deleteClipFile(uri);
        if (stateRef.current.inCall) dispatch({ type: 'settled', listen: false });
      });
    } else if (act === 'resumeListening') void listen();
  }, [micMuted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Speaker mute mid-sentence: silence the clip that is playing (the queue goes silent too).
  useEffect(() => {
    try {
      if (s.player) s.player.muted = Boolean(speakerMuted);
    } catch {
      /* platform without a muted flag */
    }
  }, [speakerMuted, s]);

  useEffect(
    () => () => {
      s.mounted = false;
      stopMeter();
      s.turn?.abort();
      stopPlayback();
      if (s.recording) recorder.stop().catch(() => {});
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return {
    state,
    dispatch,
    levelRef,
    start,
    end,
    tap,
    pttStart,
    pttEnd,
    sendText,
    clearTranscript: () => dispatch({ type: 'clear' }),
  };
}
