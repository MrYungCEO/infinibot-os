/**
 * call-machine — pure state for the InfiniBot call page (tested in jest).
 *
 * Phases of one call:
 *   idle → starting → listening → transcribing → thinking → speaking → listening …
 *                                                   ↘ error (friendly, recoverable)
 *
 * `inCall` stays true across turns (hands-free: after the agent speaks the
 * face listens again) until the owner ends the call.
 */

export const IDLE_CALL = Object.freeze({
  phase: 'idle',
  inCall: false,
  error: null,
  transcript: [],
  /** Latest round-trip timing (ms) for the little latency readout. */
  lastLatencyMs: null,
  /** Tools the last turn used (badge). */
  tools: [],
});

const MAX_LINES = 60;

function upsertLine(lines, line) {
  const i = lines.findIndex((l) => l.id === line.id);
  if (i < 0) return [...lines, line].slice(-MAX_LINES);
  const next = lines.slice();
  next[i] = { ...next[i], ...line };
  return next;
}

/** The face's animation state for a call phase. */
export function faceStateFor(phase) {
  switch (phase) {
    case 'starting':
      return 'connecting';
    case 'listening':
      return 'listening';
    case 'transcribing':
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'speaking';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** What tapping the face does right now. */
export function tapActionFor(phase) {
  switch (phase) {
    case 'idle':
    case 'error':
      return 'start';
    case 'listening':
      return 'send';
    case 'speaking':
      return 'barge';
    case 'transcribing':
    case 'thinking':
      return 'cancel';
    default:
      return 'none';
  }
}

/** Status line under the face. */
export function statusText(state, { targetLabel = 'InfiniBot', handsFree = true, micMuted = false } = {}) {
  if (micMuted && (state.phase === 'idle' || state.phase === 'listening' || state.phase === 'starting')) return 'Muted — unmute to talk, or type';
  switch (state.phase) {
    case 'idle':
      return state.inCall ? 'Tap or hold the face to talk' : `Tap or hold the face to talk to ${targetLabel}`;
    case 'starting':
      return 'Opening the mic…';
    case 'listening':
      return handsFree ? 'Listening… tap when you’re done' : 'Listening… tap to send';
    case 'transcribing':
      return 'Got it — transcribing…';
    case 'thinking':
      return `${targetLabel} is thinking…`;
    case 'speaking':
      return 'Speaking — tap to interrupt';
    case 'error':
      return state.error || 'Something went wrong';
    default:
      return '';
  }
}

export function callReducer(state, ev) {
  switch (ev.type) {
    case 'start':
      return { ...state, phase: 'starting', inCall: true, error: null };
    case 'listening':
      return state.inCall ? { ...state, phase: 'listening', error: null } : state;
    case 'transcribing':
      return { ...state, phase: 'transcribing' };
    case 'thinking':
      return { ...state, phase: 'thinking' };
    case 'speaking':
      return state.inCall ? { ...state, phase: 'speaking' } : state;
    case 'settled':
      // A turn finished (or was empty): listen again if hands-free, else wait.
      if (!state.inCall) return { ...state, phase: 'idle' };
      return { ...state, phase: ev.listen ? 'listening' : 'idle' };
    case 'line':
      return { ...state, transcript: upsertLine(state.transcript, ev.line) };
    case 'latency':
      return { ...state, lastLatencyMs: ev.ms };
    case 'tools':
      return { ...state, tools: Array.isArray(ev.tools) ? ev.tools : [] };
    case 'fail':
      return { ...state, phase: 'error', error: ev.error || 'Something went wrong' };
    case 'end':
      return { ...state, phase: 'idle', inCall: false, error: null };
    case 'clear':
      return { ...state, transcript: [] };
    default:
      return state;
  }
}

/** Friendly wording for common failures (shown on the sad face). */
export function friendlyError(err) {
  const msg = String((err && err.message) || err || '').trim();
  if (/denied|not ?allowed|permission/i.test(msg)) return 'I can’t hear you — allow the microphone for InfiniBot and try again.';
  if (/network|reachable|failed to fetch|timeout/i.test(msg)) return 'I can’t reach your gateway right now. Check the connection and tap me to retry.';
  if (/speech-to-text|stt|whisper|speaches/i.test(msg)) return 'My ears (local speech-to-text) aren’t running. Start voice on the gateway, then tap me.';
  if (/401|unauthori[sz]ed/i.test(msg)) return 'The gateway didn’t accept this phone’s login. Reconnect in Settings › Connections.';
  if (/no gateway configured/i.test(msg)) return msg;
  return msg ? `Oops — ${msg.slice(0, 140)}` : 'Oops — something went wrong. Tap me to try again.';
}
