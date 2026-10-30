/**
 * Mic / speaker mute, custom wake phrases + sensitivity, dB → level, and the
 * wake ↔ call recorder hand-off (mocked expo-audio recorder).
 *
 * Live transcripts in fixtures/wake-transcripts.json came from the real
 * gateway: Kokoro TTS of "Hey Infini, …" / "I watched Infinity War" →
 * ffmpeg to the phone's upload formats → POST /api/voice/stt (local Whisper).
 */
import fixtures from './fixtures/wake-transcripts.json';
import { dbToLevel } from '../infini/face-math';
import { createMicArbiter } from '../infini/mic-arbiter';
import { MUTE_DEFAULTS, callOnMicMute, micGate, muteReducer, replyOutput, wakeHoldReason } from '../infini/mute-machine';
import { statusText, IDLE_CALL } from '../infini/call-machine';
import { createWakeEngine } from '../infini/wake/wake-engine';
import { WAKE_IDLE, wakeReducer, wakeShouldListen } from '../infini/wake/wake-machine';
import {
  DEFAULT_WAKE_PHRASES,
  WAKE_SENSITIVITY,
  explainWake,
  matchWake,
  phoneticSimilarity,
  validateWakePhrase,
  wakePhrasesFor,
} from '../infini/wake/wake-phrase';

// ── mute state machine ────────────────────────────────────────────────────────

describe('mute state machine', () => {
  const armed = () => wakeReducer(WAKE_IDLE, { type: 'enable' });
  /** What the hook does with a hold reason. */
  const applyHold = (wake, reason, prev) => (reason ? wakeReducer(wake, { type: 'pause', reason }) : prev ? wakeReducer(wake, { type: 'resume', reason: prev }) : wake);

  test('defaults: nothing muted; toggles flip one side each', () => {
    expect(MUTE_DEFAULTS).toEqual({ mic: false, speaker: false });
    const m = muteReducer(MUTE_DEFAULTS, { type: 'toggleMic' });
    expect(m).toEqual({ mic: true, speaker: false });
    expect(muteReducer(m, { type: 'toggleSpeaker' })).toEqual({ mic: true, speaker: true });
    expect(muteReducer(m, { type: 'setMic', value: false }).mic).toBe(false);
  });

  test('muting the mic suspends the wake listener; unmuting resumes it', () => {
    let wake = armed();
    expect(wakeShouldListen(wake)).toBe(true);
    const reason = wakeHoldReason({ micMuted: true, focused: true });
    expect(reason).toBe('muted');
    wake = applyHold(wake, reason, null);
    expect(wake).toMatchObject({ mode: 'paused', pausedFor: 'muted' });
    expect(wakeShouldListen(wake)).toBe(false);
    wake = applyHold(wake, wakeHoldReason({ micMuted: false, focused: true }), reason);
    expect(wake.mode).toBe('armed');
    expect(wakeShouldListen(wake)).toBe(true);
  });

  test('the mic mute wins over other holds, and a call hold after unmute still holds', () => {
    expect(wakeHoldReason({ micMuted: true, inCall: true, focused: false })).toBe('muted');
    let wake = applyHold(armed(), 'muted', null);
    // Unmute during a call: the call hold takes over, no listening over the call.
    wake = applyHold(wake, wakeHoldReason({ micMuted: false, inCall: true }), 'muted');
    expect(wake.pausedFor).toBe('call');
    expect(wakeShouldListen(wake)).toBe(false);
    wake = applyHold(wake, wakeHoldReason({ micMuted: false, inCall: false }), 'call');
    expect(wakeShouldListen(wake)).toBe(true);
  });

  test('push-to-talk and tap-to-talk are suspended while muted; typing is not', () => {
    expect(micGate({ micMuted: true })).toEqual({ capture: false, pushToTalk: false, tapToTalk: false, typing: true });
    expect(micGate({ micMuted: false })).toEqual({ capture: true, pushToTalk: true, tapToTalk: true, typing: true });
  });

  test('a call: mute stops a listening turn, unmute resumes hands-free listening', () => {
    expect(callOnMicMute({ micMuted: true, inCall: true, phase: 'listening' })).toBe('stopListening');
    expect(callOnMicMute({ micMuted: true, inCall: true, phase: 'speaking' })).toBeNull(); // the reply keeps playing
    expect(callOnMicMute({ micMuted: false, inCall: true, phase: 'idle', handsFree: true })).toBe('resumeListening');
    expect(callOnMicMute({ micMuted: false, inCall: true, phase: 'idle', handsFree: false })).toBeNull();
    expect(callOnMicMute({ micMuted: true, inCall: false, phase: 'idle' })).toBeNull();
  });

  test('status says Muted; speaker mute keeps the text and lip-syncs silently', () => {
    expect(statusText({ ...IDLE_CALL }, { micMuted: true })).toMatch(/^Muted/);
    expect(statusText({ ...IDLE_CALL, inCall: true, phase: 'listening' }, { micMuted: true })).toMatch(/^Muted/);
    expect(statusText({ ...IDLE_CALL, inCall: true, phase: 'speaking' }, { micMuted: true })).toMatch(/Speaking/);
    expect(replyOutput({ speakerMuted: true })).toBe('silent-lipsync');
    expect(replyOutput({ speakerMuted: false })).toBe('speak');
  });
});

// ── custom phrase matcher ─────────────────────────────────────────────────────

describe('wake phrases: custom list, variants, negatives, sensitivity', () => {
  const N = { strictness: WAKE_SENSITIVITY.normal.strictness };

  test('live Whisper transcripts (fixtures) fire / stay quiet as recorded', () => {
    const phrases = wakePhrasesFor('main');
    expect(fixtures.samples.length).toBeGreaterThanOrEqual(20);
    for (const s of fixtures.samples) {
      const got = Boolean(matchWake(s.transcript, phrases, N));
      if (got !== s.wake) throw new Error(`${s.id}: "${s.transcript}" expected wake=${s.wake}`);
    }
    const pos = fixtures.samples.find((s) => s.id === 'positive.m4a');
    expect(pos.transcript).toBe("Hey Infini, what's on my board?");
    expect(matchWake(pos.transcript, phrases, N)).toMatchObject({ phrase: 'hey infini', remainder: "what's on my board" });
    const neg = fixtures.samples.find((s) => s.id === 'negative.m4a');
    expect(matchWake(neg.transcript, phrases, N)).toBeNull();
  });

  test.each([
    ['Hey and Finny.', 'split brand'],
    ['He and Finney, add a task to call mom.', 'he + split brand + request'],
    ['Hey, infinity.', 'alias + pause'],
    ['Harry Infini', 'fuzzy'],
    ['Hey, Infimio.', 'fuzzy'],
  ])('fires on the Whisper variant %s (%s)', (t) => {
    expect(matchWake(t, DEFAULT_WAKE_PHRASES, N)).not.toBeNull();
  });

  test.each(['I watched Infinity War last night.', 'Hey, Infinity War was a great movie.', 'Hey Infinite loop is broken', 'hey Tiffany', 'hey there', 'Hey everyone', 'hey and fine thanks'])(
    'does not fire: %s',
    (t) => {
      expect(matchWake(t, DEFAULT_WAKE_PHRASES, N)).toBeNull();
    },
  );

  test('custom phrases replace the defaults; normalised; start-of-utterance rule kept', () => {
    const phrases = wakePhrasesFor('main', { phrases: ['Hey Jarvis!', 'okay  computer friend'], agentName: false });
    expect(phrases).toEqual(['hey jarvis', 'okay computer friend']);
    expect(matchWake('Hey Jarvis, what is on my board?', phrases, N)).toMatchObject({ phrase: 'hey jarvis', remainder: 'what is on my board' });
    expect(matchWake('Hey Jarvi.', phrases, N)).toMatchObject({ phrase: 'hey jarvis' }); // fuzzy, ends the clip
    expect(matchWake('Okay computer friend', phrases, N)).not.toBeNull();
    expect(matchWake('Hey Infini', phrases, N)).toBeNull(); // defaults are gone
    expect(matchWake('I told him hey jarvis yesterday', phrases, N)).toBeNull(); // not at the start
    expect(matchWake('Right. Hey Jarvis, add milk.', phrases, N)).not.toBeNull(); // after a sentence break
  });

  test('"hey <agent>" is optional', () => {
    expect(wakePhrasesFor('Nova', { agentName: true })).toContain('hey nova');
    expect(wakePhrasesFor('Nova', { agentName: false })).not.toContain('hey nova');
    expect(wakePhrasesFor('main', { agentName: true })).not.toContain('hey main');
    expect(matchWake('Hey Nova, open the board', wakePhrasesFor('Nova', { agentName: true }), N)).toMatchObject({ phrase: 'hey nova' });
  });

  test('sensitivity: strict rejects loose matches that normal / high accept', () => {
    const at = (t, k) => Boolean(matchWake(t, DEFAULT_WAKE_PHRASES, { strictness: WAKE_SENSITIVITY[k].strictness }));
    expect([at('Harry Infini', 'low'), at('Harry Infini', 'normal'), at('Harry Infini', 'high')]).toEqual([false, true, true]);
    expect([at('Tay and Finney.', 'low'), at('Tay and Finney.', 'high')]).toEqual([false, true]);
    // Exact / known mishearings fire at every level.
    for (const k of ['low', 'normal', 'high']) expect(at('Hey and Finny.', k)).toBe(true);
    // Thresholds get looser as sensitivity rises.
    expect(WAKE_SENSITIVITY.low.threshold).toBeGreaterThan(WAKE_SENSITIVITY.normal.threshold);
    expect(WAKE_SENSITIVITY.normal.threshold).toBeGreaterThan(WAKE_SENSITIVITY.high.threshold);
    expect(WAKE_SENSITIVITY.low.strictness).toBeGreaterThan(WAKE_SENSITIVITY.high.strictness);
  });

  test('explainWake gives a reason either way (diagnostics readout)', () => {
    expect(explainWake('Hey and Finny.', DEFAULT_WAKE_PHRASES).reason).toMatch(/Matched “hey infini”/);
    expect(explainWake('Hey, Infinity War was great', DEFAULT_WAKE_PHRASES).reason).toMatch(/“war” followed/);
    expect(explainWake('I watched Infinity War.', DEFAULT_WAKE_PHRASES).reason).toMatch(/Closest/);
    expect(explainWake('', DEFAULT_WAKE_PHRASES).reason).toMatch(/Nothing/);
    expect(explainWake('Thank you.', DEFAULT_WAKE_PHRASES).reason).toMatch(/noise/);
    expect(phoneticSimilarity('hey infini', 'hey infini')).toBe(1);
  });

  test('validation: 2–5 words, not generic, no duplicates; warns on everyday words', () => {
    expect(validateWakePhrase('nova').error).toMatch(/2 words/);
    expect(validateWakePhrase('one two three four five six').error).toMatch(/5 words/);
    expect(validateWakePhrase('hello okay').error).toMatch(/name/);
    expect(validateWakePhrase('hey yo').ok).toBe(false);
    expect(validateWakePhrase('Hey Infini', DEFAULT_WAKE_PHRASES).error).toMatch(/already/);
    expect(validateWakePhrase('  Hey,  NOVA! ')).toEqual({ ok: true, phrase: 'hey nova' });
    const generic = validateWakePhrase('hey computer');
    expect(generic.ok).toBe(true);
    expect(generic.warning).toMatch(/Everyday words/);
    expect(validateWakePhrase('okay listen up').warning).toBeTruthy();
  });
});

// ── dB → level ───────────────────────────────────────────────────────────────

describe('metering dB → level (expo-audio: iOS averagePower / Android 20·log10(maxAmp/32767), both −160…0 dB)', () => {
  test('maps −55 dB → 0 and −10 dB → 1, linear between, clamped', () => {
    expect(dbToLevel(-160)).toBe(0);
    expect(dbToLevel(-55)).toBe(0);
    expect(dbToLevel(-32.5)).toBeCloseTo(0.5, 5);
    expect(dbToLevel(-10)).toBe(1);
    expect(dbToLevel(0)).toBe(1);
    expect(dbToLevel(undefined)).toBe(0);
    expect(dbToLevel(NaN)).toBe(0);
  });

  test('sensitivity thresholds sit between a quiet room and speech at arm’s length', () => {
    const toDb = (lv) => -55 + lv * 45;
    expect(toDb(WAKE_SENSITIVITY.normal.threshold)).toBeCloseTo(-41.5, 1);
    expect(toDb(WAKE_SENSITIVITY.high.threshold)).toBeCloseTo(-45.1, 1);
    expect(toDb(WAKE_SENSITIVITY.low.threshold)).toBeCloseTo(-37.9, 1);
    // A quiet room (≈ −50 dB) is below every threshold; normal speech (≈ −30 dB) above every one.
    for (const k of ['low', 'normal', 'high']) {
      expect(dbToLevel(-50)).toBeLessThan(WAKE_SENSITIVITY[k].threshold);
      expect(dbToLevel(-30)).toBeGreaterThan(WAKE_SENSITIVITY[k].threshold);
    }
  });
});

// ── recorder hand-off (mocked) ───────────────────────────────────────────────

function fakeRecorder(log) {
  let n = 0;
  let cur = null;
  let db = -60;
  let prepareGate = null;
  return {
    setDb(v) {
      db = v;
    },
    holdNextPrepare() {
      let open;
      prepareGate = new Promise((res) => {
        open = res;
      });
      return open;
    },
    async prepareToRecordAsync(opts) {
      log.push(`prepare:${opts ? 'options' : 'NO-OPTIONS'}`);
      if (prepareGate) {
        const g = prepareGate;
        prepareGate = null;
        await g;
      }
      n += 1;
      cur = `file:///ExpoAudio/clip-${n}.m4a`;
    },
    record() {
      log.push(`record:${cur.slice(-10)}`);
    },
    async stop() {
      log.push(`stop:${cur.slice(-10)}`);
    },
    get uri() {
      return cur;
    },
    getStatus() {
      return { metering: db };
    },
  };
}

const flush = () => new Promise((res) => setImmediate(res));

function setup({ transcript = 'Hey and Finny.' } = {}) {
  const log = [];
  const arbiter = createMicArbiter();
  const recorder = fakeRecorder(log);
  let t = 0;
  const wakes = [];
  const tests = [];
  const events = [];
  const engine = createWakeEngine({
    recorder,
    recordingOptions: { extension: '.m4a', sampleRate: 16000 },
    arbiter,
    setAudioMode: async (m) => log.push(`audioMode:${m.allowsRecording ? 'record' : 'play'}${m.playsInSilentMode ? '+silent' : ''}`),
    requestPermission: async () => ({ granted: true }),
    transcribe: async (uri) => {
      log.push(`upload:${uri.slice(-10)}`);
      return transcript;
    },
    releaseFile: (uri) => log.push(`delete:${uri.slice(-10)}`),
    explain: (text) => explainWake(text, DEFAULT_WAKE_PHRASES),
    emit: (ev) => events.push(ev.type),
    onWake: (m) => {
      log.push(`WAKE:${m.phrase}`);
      wakes.push(m);
    },
    onTest: (r) => tests.push(r),
    now: () => t,
    timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    sleep: async () => {},
  });
  arbiter.register('wake', () => engine.yieldMic());
  /** Feed n meter ticks at `db`, 100 ms apart. */
  const feed = async (db, n) => {
    recorder.setDb(db);
    for (let i = 0; i < n; i++) {
      t += 100;
      await engine.tick();
    }
    await flush();
  };
  return { log, arbiter, recorder, engine, wakes, tests, events, feed };
}

describe('wake ↔ call recorder hand-off', () => {
  test('start: mic arbiter → audio mode (record + silent) → prepare WITH options → record', async () => {
    const { log, arbiter, engine } = setup();
    await engine.start();
    expect(log).toEqual(['audioMode:record+silent', 'prepare:options', 'record:clip-1.m4a']);
    expect(arbiter.owner).toBe('wake');
    expect(arbiter.log).toEqual(['acquire:wake']);
  });

  test('voiced clip → stop, NEW file recording, upload the finished one → match → recorder released, mic freed, THEN wake', async () => {
    const { log, arbiter, engine, wakes, feed } = setup();
    await engine.start();
    await feed(-60, 5); // quiet
    await feed(-20, 8); // "Hey Infini"
    await feed(-60, 6); // trailing silence → VAD end
    await flush();
    const tail = log.slice(log.indexOf('stop:clip-1.m4a'));
    expect(tail).toEqual([
      'stop:clip-1.m4a', // the spoken clip is finalised
      'prepare:options', // a fresh file — never re-prepare the one being uploaded
      'record:clip-2.m4a',
      'upload:clip-1.m4a',
      'delete:clip-1.m4a',
      'stop:clip-2.m4a', // match: the wake recorder stops …
      'delete:clip-2.m4a',
      'WAKE:hey infini', // … before the call is told to open its own
    ]);
    expect(wakes).toHaveLength(1);
    expect(arbiter.owner).toBeNull();
    expect(engine.running).toBe(false);
    expect(engine.debug).toMatchObject({ text: 'Hey and Finny.', match: true });
    expect(engine.debug.clipMs).toBeGreaterThan(1000);
    // The call now takes the mic without having to stop anything.
    await arbiter.acquire('call');
    expect(arbiter.log.slice(-1)).toEqual(['acquire:call']);
    expect(log.filter((l) => l.startsWith('record:'))).toHaveLength(2);
  });

  test('no match: keeps listening on the new file', async () => {
    const { log, engine, wakes, feed } = setup({ transcript: 'I watched Infinity War.' });
    await engine.start();
    await feed(-20, 8);
    await feed(-60, 6);
    await flush();
    expect(wakes).toHaveLength(0);
    expect(engine.running).toBe(true);
    expect(engine.recording).toBe(true);
    expect(engine.debug).toMatchObject({ match: false });
    expect(log).not.toContain('stop:clip-2.m4a');
  });

  test('the call taking the mic stops the wake recorder FIRST (one recording on iOS)', async () => {
    const { log, arbiter, engine } = setup();
    await engine.start();
    await arbiter.acquire('call');
    expect(arbiter.log).toEqual(['acquire:wake', 'release:wake', 'acquire:call']);
    expect(log.slice(-2)).toEqual(['stop:clip-1.m4a', 'delete:clip-1.m4a']);
    expect(engine.recording).toBe(false);
  });

  test('a prepare that resolves after stop() never starts recording', async () => {
    const { log, recorder, engine } = setup();
    const open = recorder.holdNextPrepare();
    const started = engine.start();
    await flush();
    await engine.stop(); // e.g. the call started meanwhile
    open();
    expect(await started).toBe(false);
    expect(log.filter((l) => l.startsWith('record:'))).toEqual([]);
  });

  test('test phrase: one clip, reported, no wake, recorder released', async () => {
    const { arbiter, engine, wakes, tests, feed } = setup({ transcript: 'Hey and Finny.' });
    await engine.runTest();
    expect(engine.recording).toBe(true);
    await feed(-20, 8);
    await feed(-60, 6);
    await flush();
    expect(wakes).toHaveLength(0);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ text: 'Hey and Finny.', match: { phrase: 'hey infini' } });
    expect(engine.running).toBe(false);
    expect(arbiter.owner).toBeNull();
  });

  test('permission denied pauses the listener without touching the recorder', async () => {
    const log = [];
    const events = [];
    const denied = createWakeEngine({
      recorder: fakeRecorder(log),
      recordingOptions: {},
      arbiter: createMicArbiter(),
      requestPermission: async () => ({ granted: false }),
      transcribe: async () => '',
      explain: () => ({ match: null }),
      emit: (ev) => events.push(`${ev.type}:${ev.reason || ''}`),
      timers: { setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 2, clearTimeout: () => {} },
    });
    expect(await denied.start()).toBe(false);
    expect(events).toContain('pause:permission');
    expect(log).toEqual([]);
  });
});
