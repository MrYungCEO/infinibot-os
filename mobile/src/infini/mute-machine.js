/**
 * mute-machine — the Infini page's two mutes as pure rules (tested in jest).
 *
 *   mic      no audio is captured or sent: the wake listener is held
 *            ('muted'), push-to-talk and tap-to-talk are blocked, and a call
 *            that is listening stops its recorder (the clip is discarded).
 *            Typing still works. Unmuting resumes the wake listener and, in a
 *            hands-free call, listening.
 *   speaker  InfiniBot's replies are not synthesised or played; the
 *            transcript still shows them and the face lip-syncs from the
 *            text envelope.
 *
 * Both persist per device (useCallOptions prefs: micMuted / speakerMuted).
 */

export const MUTE_DEFAULTS = Object.freeze({ mic: false, speaker: false });

export function muteReducer(state, ev) {
  switch (ev.type) {
    case 'toggleMic':
      return { ...state, mic: !state.mic };
    case 'toggleSpeaker':
      return { ...state, speaker: !state.speaker };
    case 'setMic':
      return { ...state, mic: Boolean(ev.value) };
    case 'setSpeaker':
      return { ...state, speaker: Boolean(ev.value) };
    default:
      return state;
  }
}

/**
 * Why the wake listener must not hold the mic right now (null = free to
 * listen). The mic mute wins so the badge can say "Muted".
 */
export function wakeHoldReason({ micMuted = false, focused = true, inCall = false, sheetBusy = false } = {}) {
  if (micMuted) return 'muted';
  if (inCall) return 'call';
  if (!focused || sheetBusy) return 'hold';
  return null;
}

/** What the mic controls may do. */
export function micGate({ micMuted = false } = {}) {
  return {
    capture: !micMuted,
    pushToTalk: !micMuted,
    tapToTalk: !micMuted,
    typing: true,
  };
}

/**
 * What a call does when the mic mute flips.
 * @returns {'stopListening' | 'resumeListening' | null}
 */
export function callOnMicMute({ micMuted, inCall, phase, handsFree = true }) {
  if (!inCall) return null;
  if (micMuted) return phase === 'listening' || phase === 'starting' ? 'stopListening' : null;
  return handsFree && phase === 'idle' ? 'resumeListening' : null;
}

/** How a reply sentence is voiced. */
export function replyOutput({ speakerMuted = false } = {}) {
  return speakerMuted ? 'silent-lipsync' : 'speak';
}
