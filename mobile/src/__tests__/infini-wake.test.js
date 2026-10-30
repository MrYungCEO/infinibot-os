/**
 * "Hey Infini" — phrase matcher, VAD segmenter and the wake state machine.
 */
import { DEFAULT_WAKE_PHRASES, matchWake, wakePhrasesFor } from '../infini/wake/wake-phrase';
import { createVad } from '../infini/wake/wake-vad';
import { WAKE_COOLDOWN_MS, WAKE_IDLE, wakeAction, wakeReducer, wakeShouldListen } from '../infini/wake/wake-machine';
import { callReducer, IDLE_CALL } from '../infini/call-machine';

describe('wake phrase matcher', () => {
  const phrases = wakePhrasesFor('main');

  test('includes the web defaults plus "hey infini"', () => {
    expect(DEFAULT_WAKE_PHRASES).toEqual(expect.arrayContaining(['hey infinibot', 'hey infini']));
    expect(phrases).not.toContain('hey main'); // generic names are not wake words
    expect(wakePhrasesFor('Nova')).toContain('hey nova');
  });

  test.each([
    'Hey Infini',
    'hey infini.',
    'Hey, Infini!',
    'Hey Infinity.',
    'Hey infinite',
    'Hey Infiniti',
    'A infini',
    'Hi Infini',
    'Okay, hey Infini.',
    'Um hey infinity',
    'Hey InfiniBot',
    'Hey Infinity, what is on my board?',
    'Hey infinity what is on my board',
    'heyinfinity',
  ])('fires: %s', (t) => {
    expect(matchWake(t, phrases)).not.toBeNull();
  });

  test.each([
    'Infinity war was a great movie',
    'I watched hey infinity war last night',
    'Hey Infinity War was great',
    'hey there',
    'to infinity and beyond',
    'a definite maybe',
    'hey infiniband cable',
    '',
  ])('does not fire: %s', (t) => {
    expect(matchWake(t, phrases)).toBeNull();
  });

  test('a sentence break lets the phrase start mid-clip', () => {
    expect(matchWake('Right. Hey Infini, add milk to the list.', phrases)).toMatchObject({ phrase: 'hey infini' });
  });

  test('returns what was said after the phrase', () => {
    expect(matchWake('Hey Infini, what is on my board today?', phrases).remainder).toBe('what is on my board today');
    expect(matchWake('Hey Infini.', phrases).remainder).toBe('');
  });

  test('"hey <agent>" for the selected target', () => {
    expect(matchWake('Hey Nova, open the board', wakePhrasesFor('Nova'))).toMatchObject({ phrase: 'hey nova' });
  });
});

/** Feed a level sequence sampled every `step` ms; collect events. */
function run(vad, levels, step = 100, t0 = 0) {
  const out = [];
  levels.forEach((lv, i) => {
    const ev = vad.push(lv, t0 + i * step);
    if (ev) out.push(ev);
  });
  return out;
}
const rep = (v, n) => Array(n).fill(v);

describe('VAD segmenter', () => {
  test('a short spoken phrase becomes one segment', () => {
    const ev = run(createVad(), [...rep(0.05, 10), ...rep(0.7, 9), ...rep(0.05, 10)]);
    expect(ev.map((e) => e.type)).toEqual(['start', 'end']);
    expect(ev[1].reason).toBe('silence');
    expect(ev[1].endMs - ev[1].startMs).toBeGreaterThanOrEqual(700);
  });

  test('a brief pause inside the phrase (hangover) does not split it', () => {
    const ev = run(createVad(), [...rep(0.05, 5), ...rep(0.7, 5), ...rep(0.1, 3), ...rep(0.7, 5), ...rep(0.05, 8)]);
    expect(ev.map((e) => e.type)).toEqual(['start', 'end']);
  });

  test('clicks shorter than the onset window are ignored', () => {
    expect(run(createVad(), [...rep(0.05, 5), 0.9, ...rep(0.05, 10)], 100)).toEqual([]);
  });

  test('a too-short burst is dropped, not uploaded', () => {
    const ev = run(createVad(), [...rep(0.05, 5), ...rep(0.8, 3), ...rep(0.05, 10)]);
    expect(ev.map((e) => e.type)).toEqual(['start', 'drop']);
  });

  test('long talk is cut at 2.5 s, then waits for silence before re-arming', () => {
    const ev = run(createVad(), [...rep(0.05, 3), ...rep(0.7, 60), ...rep(0.05, 8)]);
    expect(ev.map((e) => e.type)).toEqual(['start', 'end', 'ready']);
    expect(ev[1].reason).toBe('max');
    expect(ev[1].endMs - ev[1].startMs).toBeLessThanOrEqual(2600);
  });

  test('the threshold adapts to a noisy room', () => {
    const vad = createVad();
    run(vad, rep(0.33, 80)); // steady fan / traffic noise just over the base threshold
    expect(vad.threshold).toBeGreaterThan(0.4);
    const ev = run(vad, [...rep(0.34, 5), ...rep(0.85, 6), ...rep(0.34, 8)], 100, 10_000);
    expect(ev.map((e) => e.type)).toEqual(['start', 'end']);
  });
});

describe('wake state machine', () => {
  test('off by default; enabling arms the listener', () => {
    expect(WAKE_IDLE.enabled).toBe(false);
    expect(wakeShouldListen(WAKE_IDLE)).toBe(false);
    const s = wakeReducer(WAKE_IDLE, { type: 'enable' });
    expect(s.mode).toBe('armed');
    expect(wakeShouldListen(s)).toBe(true);
  });

  test('idle → wake → listening → turn to the selected target → back to wake-listening', () => {
    let wake = wakeReducer(WAKE_IDLE, { type: 'enable', now: 0 });
    let call = IDLE_CALL;
    const target = { agentId: 'nova', sessionKey: 'agent:nova:cli-1' };
    const sent = [];

    // Voice segment → STT → match.
    wake = wakeReducer(wake, { type: 'vadStart', now: 1000 });
    expect(wake.mode).toBe('capturing');
    wake = wakeReducer(wake, { type: 'vadEnd', now: 1800 });
    expect(wake.mode).toBe('checking');
    const match = matchWake('Hey Infini.', wakePhrasesFor('Nova'));
    wake = wakeReducer(wake, { type: 'result', match: !!match, text: 'Hey Infini.', now: 2300 });
    expect(wake.mode).toBe('woke');
    expect(wakeShouldListen(wake)).toBe(false); // mic handed to the call

    // Same as tapping the face: the call starts listening.
    expect(wakeAction(match)).toEqual({ type: 'listen' });
    call = callReducer(call, { type: 'start' });
    wake = wakeReducer(wake, { type: 'callStarted', now: 2310 });
    call = callReducer(call, { type: 'listening' });
    expect(call.phase).toBe('listening');

    // The utterance goes to the CURRENTLY selected target.
    call = callReducer(call, { type: 'thinking' });
    sent.push({ message: 'what is on my board', agentId: target.agentId, sessionKey: target.sessionKey });
    call = callReducer(call, { type: 'speaking' });
    expect(wakeShouldListen(wake)).toBe(false); // never listens over its own voice
    call = callReducer(call, { type: 'end' });
    wake = wakeReducer(wake, { type: 'callEnded', now: 9000 });

    expect(sent).toEqual([{ message: 'what is on my board', agentId: 'nova', sessionKey: 'agent:nova:cli-1' }]);
    expect(call.phase).toBe('idle');
    expect(wake.mode).toBe('armed');
    expect(wakeShouldListen(wake)).toBe(true);
  });

  test('no match, drops and STT errors go back to armed', () => {
    let s = wakeReducer(WAKE_IDLE, { type: 'enable' });
    s = wakeReducer(wakeReducer(s, { type: 'vadStart' }), { type: 'vadEnd' });
    expect(wakeReducer(s, { type: 'result', match: false, text: 'pass the salt' }).mode).toBe('armed');
    expect(wakeReducer(s, { type: 'error' }).mode).toBe('armed');
    expect(wakeReducer(wakeReducer(wakeReducer(WAKE_IDLE, { type: 'enable' }), { type: 'vadStart' }), { type: 'vadDrop' }).mode).toBe('armed');
  });

  test('cooldown: a second wake right after the first is ignored', () => {
    let s = wakeReducer(WAKE_IDLE, { type: 'enable', now: 0 });
    s = wakeReducer(s, { type: 'result', match: true, now: 10_000 });
    s = wakeReducer(s, { type: 'callEnded', now: 10_500 });
    s = wakeReducer(s, { type: 'result', match: true, now: 10_000 + WAKE_COOLDOWN_MS - 1 });
    expect(s.mode).toBe('armed');
    expect(s.wakes).toBe(1);
  });

  test('pauses in the background and resumes in the foreground', () => {
    let s = wakeReducer(WAKE_IDLE, { type: 'enable' });
    s = wakeReducer(s, { type: 'pause', reason: 'background' });
    expect(wakeShouldListen(s)).toBe(false);
    expect(wakeReducer(s, { type: 'resume', reason: 'call' }).mode).toBe('paused'); // a different pause reason doesn't resume it
    s = wakeReducer(s, { type: 'resume', reason: 'background' });
    expect(wakeShouldListen(s)).toBe(true);
    expect(wakeReducer(s, { type: 'disable' }).mode).toBe('off');
  });

  test('a request in the same breath is sent straight to the target', () => {
    expect(wakeAction(matchWake('Hey Infini, what is on my board today?'))).toEqual({ type: 'send', text: 'what is on my board today' });
    expect(wakeAction(matchWake('Hey Infini, hello'))).toEqual({ type: 'listen' });
  });
});
