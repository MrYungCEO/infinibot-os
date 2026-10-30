/**
 * wake-engine — the gateway-tier "Hey Infini" loop, free of React so jest can
 * drive the whole recorder hand-off with a mocked recorder.
 *
 *   start   permission → mic arbiter (stops whoever held the mic) →
 *           setAudioModeAsync({ allowsRecording, playsInSilentMode }) →
 *           prepareToRecordAsync(OPTIONS) → record()
 *   tick    recorder.getStatus().metering (dB) → dbToLevel → VAD
 *   vad end stop() → upload THAT file → prepare a NEW file → record()
 *           (prepareToRecordAsync is always given the options: without them
 *           iOS re-prepares the same AVAudioRecorder and overwrites the file
 *           that is still being uploaded — Whisper then gets a truncated m4a
 *           with no moov atom and answers 415)
 *   match   stop + release the recorder, free the mic, THEN onWake — the call
 *           opens its own recorder only after this one is gone
 *   stop    stop, delete the file, free the mic
 *
 * A prepare that resolves after stop()/a wake never calls record() (the
 * generation counter), so the wake recorder can't come back to life under
 * the call.
 *
 * `runTest()` records one clip and reports {text, match, reason} through
 * `onTest` without waking (Call options › Test phrase).
 */

import { dbToLevel } from '../face-math';
import { createVad } from './wake-vad';

export const METER_FAST_MS = 100;
export const METER_SLOW_MS = 220; // after a minute of quiet
const QUIET_SLOW_AFTER_MS = 60_000;
const RECYCLE_MS = 6_000; // restart a silent recording so a clip never carries much dead air
const MAX_CHECKS_PER_MIN = 12;
const TEST_TIMEOUT_MS = 7_000;
const RETRY_MS = 350;

const NOOP = () => {};

export function createWakeEngine(deps) {
  const {
    recorder,
    recordingOptions,
    arbiter,
    setAudioMode = async () => {},
    requestPermission = async () => ({ granted: true }),
    transcribe,
    releaseFile = NOOP,
    explain,
    emit = NOOP,
    onWake = NOOP,
    onDebug = NOOP,
    onTest = NOOP,
    now = () => Date.now(),
    // Wrapped: browsers throw "Illegal invocation" when window timers are called as methods of another object.
    timers = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    },
    sleep = (ms) => new Promise((res) => timers.setTimeout(res, ms)),
  } = deps;

  let vadOpts = deps.vad || {};
  let vad = createVad(vadOpts);
  const r = {
    running: false,
    recording: false,
    recStart: 0,
    gen: 0,
    meter: null,
    meterMs: 0,
    lastVoice: 0,
    checks: [],
    busy: false,
    permission: null,
    test: null, // { testOnly, timer }
  };
  const dbg = {
    level: 0,
    db: null,
    vad: 'off',
    threshold: vad.threshold,
    clipMs: null,
    sttMs: null,
    text: '',
    match: null,
    reason: '',
    error: null,
    at: 0,
    clips: 0,
  };
  const debug = (patch) => {
    Object.assign(dbg, patch);
    onDebug({ ...dbg });
  };

  async function stopRec() {
    if (!r.recording) return null;
    r.recording = false;
    try {
      await recorder.stop();
    } catch {
      return null;
    }
    return recorder.uri || null;
  }

  async function prepareAndRecord(gen) {
    // Fresh options → a fresh file per clip (see the header).
    await recorder.prepareToRecordAsync(recordingOptions);
    if (!r.running || gen !== r.gen) return false; // stopped / woke while preparing
    recorder.record();
    r.recording = true;
    r.recStart = now();
    vad.reset();
    return true;
  }

  async function startRec(gen) {
    try {
      return await prepareAndRecord(gen);
    } catch (err) {
      // Most often the audio mode was flipped to playback-only by the call
      // that just ended: set it again and retry once.
      try {
        await sleep(RETRY_MS);
        if (!r.running || gen !== r.gen) return false;
        await setAudioMode({ allowsRecording: true, playsInSilentMode: true });
        return await prepareAndRecord(gen);
      } catch (err2) {
        debug({ error: `Recorder: ${err2?.message || err?.message || err2}` });
        return false;
      }
    }
  }

  function clearMeter() {
    if (r.meter) timers.clearInterval(r.meter);
    r.meter = null;
    r.meterMs = 0;
  }

  function schedule(ms) {
    clearMeter();
    r.meterMs = ms;
    r.meter = timers.setInterval(() => void tick(), ms);
  }

  async function tick() {
    if (!r.running || !r.recording || r.busy) return;
    r.busy = true;
    try {
      await tickBody();
    } finally {
      r.busy = false;
    }
  }

  async function tickBody() {
    let db = null;
    try {
      db = recorder.getStatus()?.metering;
    } catch {
      db = null;
    }
    const level = dbToLevel(db);
    const t = now();
    const ev = vad.push(level, t);
    dbg.level = level;
    dbg.db = typeof db === 'number' ? Math.round(db) : null;
    dbg.vad = vad.mode;
    dbg.threshold = vad.threshold;
    onDebug({ ...dbg });
    if (ev?.type === 'start') {
      r.lastVoice = t;
      emit({ type: 'vadStart' });
    } else if (ev?.type === 'drop') emit({ type: 'vadDrop' });
    else if (ev?.type === 'end') {
      r.lastVoice = t;
      emit({ type: 'vadEnd' });
      const gen = r.gen;
      const clipMs = t - r.recStart;
      // A test with a clip in flight waits for its transcript, not the timeout.
      if (r.test?.timer) {
        timers.clearTimeout(r.test.timer);
        r.test.timer = null;
      }
      const uri = await stopRec();
      // Keep listening while the clip is checked (a one-off test needs only this clip).
      if (r.running && gen === r.gen && !r.test?.testOnly) await startRec(gen);
      if (uri) void check(uri, gen, clipMs);
      else emit({ type: 'error' });
      return;
    }
    // Recycle a silent recording (and delete it).
    if (vad.mode === 'silence' && t - r.recStart > RECYCLE_MS) {
      const gen = r.gen;
      const uri = await stopRec();
      if (uri) releaseFile(uri);
      if (r.running && gen === r.gen) await startRec(gen);
    }
    // Duty cycle: poll slower after a long quiet spell.
    const want = t - r.lastVoice > QUIET_SLOW_AFTER_MS ? METER_SLOW_MS : METER_FAST_MS;
    if (r.running && want !== r.meterMs) schedule(want);
  }

  async function check(uri, gen, clipMs) {
    const t = now();
    r.checks = r.checks.filter((c) => t - c < 60_000);
    if (r.checks.length >= MAX_CHECKS_PER_MIN && !r.test) {
      releaseFile(uri);
      debug({ clipMs, reason: 'Skipped: too many clips this minute (rate limit)', match: null });
      emit({ type: 'error' });
      return;
    }
    r.checks.push(t);
    dbg.clips += 1;
    let text = '';
    try {
      text = await transcribe(uri);
    } catch (err) {
      debug({ clipMs, sttMs: now() - t, text: '', match: null, reason: `Speech-to-text failed: ${err?.message || err}`, error: err?.message || String(err), at: now() });
      if (r.test) finishTest({ text: '', match: null, reason: `Speech-to-text failed: ${err?.message || err}`, clipMs });
      emit({ type: 'error' });
      return;
    } finally {
      releaseFile(uri);
    }
    const ex = explain(text) || { match: null, reason: '' };
    debug({ clipMs, sttMs: now() - t, text, match: Boolean(ex.match), reason: ex.reason, error: null, at: now() });
    if (r.test) {
      finishTest({ text, match: ex.match, reason: ex.reason, clipMs });
      emit({ type: 'result', match: false, text });
      return;
    }
    if (gen !== r.gen) return; // stopped meanwhile
    if (ex.match) {
      // Hand the mic to the call BEFORE it opens its own recorder.
      r.gen += 1;
      r.running = false;
      clearMeter();
      const left = await stopRec();
      if (left) releaseFile(left);
      arbiter?.release('wake');
      dbg.vad = 'off';
      emit({ type: 'result', match: true, text });
      onWake(ex.match, text);
      return;
    }
    emit({ type: 'result', match: false, text });
  }

  function finishTest(result) {
    const test = r.test;
    if (!test) return;
    r.test = null;
    if (test.timer) timers.clearTimeout(test.timer);
    onTest(result);
    if (test.testOnly) void stop();
  }

  async function start({ test = false } = {}) {
    if (r.running) return true;
    r.running = true;
    r.gen += 1;
    const gen = r.gen;
    if (r.permission !== true) {
      try {
        const perm = await requestPermission();
        r.permission = Boolean(perm?.granted);
      } catch {
        r.permission = false;
      }
      if (!r.permission) {
        r.running = false;
        debug({ error: 'Microphone permission denied', vad: 'off' });
        emit({ type: 'pause', reason: 'permission' });
        if (test) onTest({ text: '', match: null, reason: 'Microphone permission denied' });
        return false;
      }
    }
    if (!r.running || gen !== r.gen) return false;
    await arbiter?.acquire('wake');
    if (!r.running || gen !== r.gen) return false;
    try {
      await setAudioMode({ allowsRecording: true, playsInSilentMode: true });
    } catch {
      /* best effort; startRec retries */
    }
    if (!r.running || gen !== r.gen) return false;
    r.lastVoice = now();
    if (!(await startRec(gen))) {
      if (gen === r.gen) {
        r.running = false;
        arbiter?.release('wake');
        emit({ type: 'pause', reason: 'error' });
        if (r.test) finishTest({ text: '', match: null, reason: dbg.error || 'The recorder would not start' });
      }
      return false;
    }
    debug({ vad: vad.mode, error: null });
    schedule(METER_FAST_MS);
    return true;
  }

  /** Stop listening, delete the open file and free the mic. */
  async function stop() {
    r.running = false;
    r.gen += 1;
    clearMeter();
    const uri = await stopRec();
    if (uri) releaseFile(uri);
    arbiter?.release('wake');
    dbg.vad = 'off';
    dbg.level = 0;
    dbg.db = null;
    onDebug({ ...dbg });
  }

  /** Record one clip and report what it heard (no wake). */
  async function runTest() {
    if (r.test) return;
    const testOnly = !r.running;
    r.test = { testOnly, timer: null };
    r.test.timer = timers.setTimeout(() => finishTest({ text: '', match: null, reason: 'No speech heard in 7 s — speak louder, or raise the sensitivity' }), TEST_TIMEOUT_MS);
    if (testOnly) await start({ test: true });
  }

  /** Released by the arbiter when another recorder takes the mic. */
  async function yieldMic() {
    r.running = false;
    r.gen += 1;
    clearMeter();
    const uri = await stopRec();
    if (uri) releaseFile(uri);
    dbg.vad = 'off';
  }

  function setVad(opts) {
    vadOpts = { ...opts };
    vad = createVad(vadOpts);
    dbg.threshold = vad.threshold;
  }

  return {
    start,
    stop,
    runTest,
    yieldMic,
    setVad,
    tick,
    get running() {
      return r.running;
    },
    get recording() {
      return r.recording;
    },
    get testing() {
      return Boolean(r.test);
    },
    get debug() {
      return { ...dbg };
    },
    _r: r,
  };
}
