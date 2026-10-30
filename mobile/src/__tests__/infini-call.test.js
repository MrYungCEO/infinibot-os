/**
 * InfiniBot call page — pure pieces: face geometry per state, the call state
 * machine, the SSE parser / sentence chunker of the voice client, and the
 * offline capture queue.
 */
import {
  blinkAmount,
  blobPath,
  dbToLevel,
  faceParams,
  infinityEyes,
  mouthPath,
  rmsLevel,
  smoothLevel,
  syntheticSpeechLevel,
} from '../infini/face-math';
import { IDLE_CALL, callReducer, faceStateFor, friendlyError, statusText, tapActionFor } from '../infini/call-machine';
import { createSseParser, streamVoiceTurn, takeSentences } from '../infini/voice-client';
import { CAPTURE_QUEUE_KEY, createCaptureQueue, isRetryableError } from '../infini/capture-queue';

describe('face geometry', () => {
  test('every state yields finite params; listening/speaking react to level', () => {
    for (const s of ['idle', 'listening', 'thinking', 'speaking', 'error', 'connecting']) {
      const p = faceParams(s, 1.234, 0.5);
      expect(Number.isFinite(p.scale)).toBe(true);
      expect(Number.isFinite(p.mouth.open)).toBe(true);
    }
    expect(faceParams('listening', 1, 1).mouth.open).toBeGreaterThan(faceParams('listening', 1, 0).mouth.open);
    expect(faceParams('speaking', 1, 1).mouth.open).toBeGreaterThan(faceParams('speaking', 1, 0.1).mouth.open + 10);
    expect(faceParams('listening', 1, 1).glow).toBeGreaterThan(faceParams('idle', 1, 0).glow);
  });

  test('thinking swirls, error frowns with brows, idle smiles', () => {
    expect(faceParams('thinking', 2, 0).swirl).not.toBeNull();
    const err = faceParams('error', 2, 0);
    expect(err.mouth.curve).toBeLessThan(0);
    expect(err.brows).toBe(1);
    expect(faceParams('idle', 2, 0).mouth.curve).toBeGreaterThan(0);
  });

  test('reduced motion freezes breathing, wander, blinks and swirl', () => {
    const a = faceParams('idle', 1, 0, { reducedMotion: true });
    const b = faceParams('idle', 7.7, 0, { reducedMotion: true });
    expect(a).toEqual(b);
    expect(a.blink).toBe(0);
    expect(faceParams('thinking', 3, 0, { reducedMotion: true }).swirl.angle).toBe(0);
  });

  test('blink happens briefly every ~4.2 s', () => {
    expect(blinkAmount(0.08)).toBeGreaterThan(0.9);
    expect(blinkAmount(1)).toBe(0);
    expect(blinkAmount(4.2 + 0.08)).toBeGreaterThan(0.9);
  });

  test('paths are well-formed', () => {
    const blob = blobPath(3, { wobble: 1 });
    expect(blob.startsWith('M')).toBe(true);
    expect(blob.endsWith('Z')).toBe(true);
    expect(blob).not.toMatch(/NaN/);
    const eyes = infinityEyes({ squash: 0.5 });
    expect(eyes.d).not.toMatch(/NaN/);
    expect(eyes.left.x).toBeLessThan(eyes.right.x);
    expect(eyes.openness).toBeLessThan(1);
    expect(mouthPath({ open: 0 }).filled).toBe(false);
    expect(mouthPath({ open: 10 }).filled).toBe(true);
  });

  test('levels', () => {
    expect(rmsLevel([])).toBe(0);
    expect(rmsLevel([0.5, -0.5, 0.5, -0.5])).toBe(1);
    expect(dbToLevel(-160)).toBe(0);
    expect(dbToLevel(-10)).toBe(1);
    // Rises fast, falls slowly.
    expect(smoothLevel(0, 1)).toBeGreaterThan(1 - smoothLevel(1, 0));
    for (let t = 0; t < 3; t += 0.07) {
      const v = syntheticSpeechLevel(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('call state machine', () => {
  test('a full hands-free turn', () => {
    let s = callReducer(IDLE_CALL, { type: 'start' });
    expect(faceStateFor(s.phase)).toBe('connecting');
    s = callReducer(s, { type: 'listening' });
    expect(tapActionFor(s.phase)).toBe('send');
    s = callReducer(s, { type: 'transcribing' });
    s = callReducer(s, { type: 'line', line: { id: 'u1', who: 'you', text: 'hi', final: true } });
    s = callReducer(s, { type: 'thinking' });
    expect(faceStateFor(s.phase)).toBe('thinking');
    s = callReducer(s, { type: 'line', line: { id: 'a1', who: 'agent', text: 'Hel', final: false } });
    s = callReducer(s, { type: 'line', line: { id: 'a1', text: 'Hello!', final: true } });
    expect(s.transcript).toEqual([
      { id: 'u1', who: 'you', text: 'hi', final: true },
      { id: 'a1', who: 'agent', text: 'Hello!', final: true },
    ]);
    s = callReducer(s, { type: 'speaking' });
    expect(tapActionFor(s.phase)).toBe('barge');
    s = callReducer(s, { type: 'settled', listen: true });
    expect(s.phase).toBe('listening');
    s = callReducer(s, { type: 'end' });
    expect(s).toMatchObject({ phase: 'idle', inCall: false });
    // Late events from the ended call can't revive it.
    expect(callReducer(s, { type: 'speaking' }).phase).toBe('idle');
  });

  test('errors are friendly and recoverable by tapping', () => {
    const s = callReducer(callReducer(IDLE_CALL, { type: 'start' }), { type: 'fail', error: friendlyError(new Error('NotAllowedError: Permission denied')) });
    expect(s.phase).toBe('error');
    expect(s.error).toMatch(/allow the microphone/);
    expect(tapActionFor(s.phase)).toBe('start');
    expect(statusText(s)).toBe(s.error);
    expect(friendlyError(new Error('Network error — is the gateway reachable?'))).toMatch(/can’t reach your gateway/);
  });
});

describe('voice client protocol helpers', () => {
  test('SSE parser handles split chunks and foreign lines', () => {
    const got = [];
    const feed = createSseParser((e) => got.push(e));
    feed('data: {"delta":"Hel');
    feed('lo"}\n\ndata: {"delta":" world"}\n\n: keepalive\n\ndata: {"done":true,"text":"Hello world"}\n');
    expect(got).toEqual([{ delta: 'Hello' }, { delta: ' world' }]);
    feed('\n');
    expect(got[2]).toEqual({ done: true, text: 'Hello world' });
  });

  test('sentence chunker speaks whole sentences as they stream', () => {
    const [ready, rest] = takeSentences('Sure, I added that to your board. It is due Friday. And');
    expect(ready).toEqual(['Sure, I added that to your board.', 'It is due Friday.']);
    expect(rest).toBe('And');
    expect(takeSentences('Short.')[0]).toEqual([]);
    const long = 'word '.repeat(80);
    expect(takeSentences(long)[0][0].length).toBeLessThanOrEqual(220);
  });

  test('streamVoiceTurn posts the turn body with auth and streams events via XHR progress', async () => {
    const sent = {};
    const xhr = {
      headers: {},
      open: (m, u) => Object.assign(sent, { m, u }),
      setRequestHeader(k, v) {
        this.headers[k] = v;
      },
      send(body) {
        sent.body = JSON.parse(body);
        this.responseText = 'data: {"delta":"Hi"}\n\n';
        this.onprogress();
        this.responseText += 'data: {"done":true,"text":"Hi"}\n\n';
        this.status = 200;
        this.onload();
      },
    };
    const events = [];
    const turn = streamVoiceTurn({ base: 'http://gw:18789', headers: { Authorization: 'Bearer t' } }, { message: 'hello', agentId: 'main', callKey: 'mobile-1' }, (e) => events.push(e), {
      xhrFactory: () => xhr,
    });
    await turn.promise;
    expect(sent).toMatchObject({ m: 'POST', u: 'http://gw:18789/api/voice/turn', body: { message: 'hello', agentId: 'main', callKey: 'mobile-1' } });
    expect(xhr.headers.Authorization).toBe('Bearer t');
    expect(events).toEqual([{ delta: 'Hi' }, { done: true, text: 'Hi' }]);
  });
});

describe('offline capture queue', () => {
  function memStorage() {
    const m = new Map();
    return { m, getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => void m.set(k, v) };
  }

  test('queues on network failure, flushes later, dedups by clientRequestId', async () => {
    const storage = memStorage();
    let online = false;
    const saved = [];
    const q = createCaptureQueue({
      storage,
      save: async (draft, key) => {
        if (!online) throw new Error('Not connected to the gateway');
        saved.push(key);
        return { id: `n-${key}`, kind: draft.kind };
      },
    });
    const r = await q.submit({ kind: 'note', title: 'Milk' }, 'cap-1');
    expect(r.status).toBe('queued');
    await q.enqueue({ kind: 'note', title: 'Milk' }, 'cap-1');
    expect(await q.size()).toBe(1);
    expect(JSON.parse(storage.m.get(CAPTURE_QUEUE_KEY))[0]).toMatchObject({ clientRequestId: 'cap-1', draft: { title: 'Milk' } });

    const offlineFlush = await q.flush();
    expect(offlineFlush.kept).toHaveLength(1);
    expect(offlineFlush.kept[0].attempts).toBe(1);

    online = true;
    const res = await q.flush();
    expect(res.sent.map((s) => s.result.id)).toEqual(['n-cap-1']);
    expect(await q.size()).toBe(0);
    expect(saved).toEqual(['cap-1']);
  });

  test('permanent errors are thrown on submit and dropped on flush', async () => {
    const storage = memStorage();
    const q = createCaptureQueue({ storage, save: async () => Promise.reject(new Error('draft.title is required')) });
    await expect(q.submit({ kind: 'note', title: '' }, 'x')).rejects.toThrow(/required/);
    await q.enqueue({ kind: 'note' }, 'y');
    const res = await q.flush();
    expect(res.dropped).toHaveLength(1);
    expect(await q.size()).toBe(0);
    expect(isRetryableError(new Error('unknown method: capture.save'))).toBe(true);
    expect(isRetryableError(new Error('kind must be one of note'))).toBe(false);
  });
});
