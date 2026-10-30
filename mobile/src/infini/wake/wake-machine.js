/**
 * wake-machine — the "Hey Infini" always-on listener as a pure reducer.
 *
 *   off ──enable──▶ armed ──vadStart──▶ capturing ──vadEnd──▶ checking
 *                    ▲                      │ vadDrop             │
 *                    └──────────────────────┘◀── no match / error ┘
 *   checking ──match──▶ woke ──callStarted──▶ inCall ──callEnded──▶ armed
 *   any ──pause(background | call | tts | permission)──▶ paused ──resume──▶ armed
 *   any ──disable──▶ off
 *
 * A wake inside the cooldown window (after the previous wake) is ignored.
 */

export const WAKE_COOLDOWN_MS = 3000;

export const WAKE_IDLE = { mode: 'off', enabled: false, pausedFor: null, lastWakeAt: -Infinity, heard: '', wakes: 0 };

export function wakeReducer(state, ev) {
  const now = ev.now ?? Date.now();
  switch (ev.type) {
    case 'enable':
      return { ...state, enabled: true, mode: state.pausedFor ? 'paused' : 'armed' };
    case 'disable':
      return { ...state, enabled: false, mode: 'off', pausedFor: null };
    case 'pause':
      if (!state.enabled) return state;
      return { ...state, mode: 'paused', pausedFor: ev.reason || 'paused' };
    case 'resume':
      if (!state.enabled) return { ...state, pausedFor: null };
      if (ev.reason && state.pausedFor && ev.reason !== state.pausedFor) return state;
      return { ...state, mode: 'armed', pausedFor: null };
    case 'vadStart':
      return state.mode === 'armed' ? { ...state, mode: 'capturing' } : state;
    case 'vadDrop':
      return state.mode === 'capturing' ? { ...state, mode: 'armed' } : state;
    case 'vadEnd':
      return state.mode === 'capturing' ? { ...state, mode: 'checking' } : state;
    case 'result': {
      if (state.mode !== 'checking' && state.mode !== 'armed' && state.mode !== 'capturing') return state;
      const heard = ev.text || '';
      if (ev.match && now - state.lastWakeAt >= WAKE_COOLDOWN_MS) {
        return { ...state, mode: 'woke', heard, lastWakeAt: now, wakes: state.wakes + 1 };
      }
      return { ...state, mode: 'armed', heard };
    }
    case 'error':
      return state.mode === 'checking' ? { ...state, mode: 'armed' } : state;
    case 'callStarted':
      return state.enabled ? { ...state, mode: 'inCall' } : state;
    case 'callEnded':
      return state.enabled && (state.mode === 'inCall' || state.mode === 'woke') ? { ...state, mode: state.pausedFor ? 'paused' : 'armed' } : state;
    default:
      return state;
  }
}

/** True when the always-on mic should be open. */
export function wakeShouldListen(state) {
  return state.enabled && (state.mode === 'armed' || state.mode === 'capturing' || state.mode === 'checking');
}

/**
 * What a wake does on the call: start listening (exactly like tapping the
 * face), or — when the request came in the same breath ("Hey Infini, what's
 * on my board?") — send that request straight to the selected target.
 */
export function wakeAction(match) {
  if (!match) return null;
  const words = String(match.remainder || '')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 3) return { type: 'send', text: match.remainder.replace(/^[\s,.:;!-]+/, '').trim() };
  return { type: 'listen' };
}
