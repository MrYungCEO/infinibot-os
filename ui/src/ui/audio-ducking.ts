/**
 * Audio ducking for AI speech.
 *
 * When the assistant is speaking — over LiveKit, Kokoro, browser TTS,
 * or any other audio surface we own — drop the volume on every other
 * playing media element in the page so the user can hear the reply
 * over a background call, music player, or video.
 *
 * Two pieces:
 *
 *   markAsAIAudio(el, kind?)
 *     Tag an HTMLMediaElement (or the underlying <audio>/<video>) as
 *     belonging to the assistant so the ducking sweep skips it. Idempotent.
 *
 *   setAIAudioActive(active)
 *     Flip ducking on/off. Many independent callers (LiveKit
 *     ActiveSpeakersChanged, Kokoro playback start/end, the wake chime)
 *     can race; we count overlapping activations and only restore when
 *     every caller has released. A short trailing debounce prevents
 *     volume flapping between back-to-back utterances.
 *
 * Design notes:
 *   - We restore by *saved volume*, not "1.0", because the user might
 *     have a media player at half volume already.
 *   - Elements that appear *while* ducking is active are also ducked
 *     (a `MutationObserver` watches `<audio>`/`<video>` creation).
 *   - Skipping rules: paused or volume<=0 elements are left alone; AI-
 *     marked elements are left alone; same for elements in a shadow
 *     subtree of `<voice-chat>` since that's where the assistant orb
 *     visualizer lives (its analyser node shouldn't be touched).
 */

/** Data-attribute name applied by markAsAIAudio. */
const AI_AUDIO_ATTR = "infinibotAiAudio";
/** Default duck volume. 0.15× lets background audio remain audible. */
const DUCK_VOLUME_FACTOR = 0.15;
/** Trailing debounce — keep the duck for this long after the last
 *  release so a brief gap between words doesn't ratchet music back up. */
const RESTORE_DEBOUNCE_MS = 350;

let activeCount = 0;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;
const ducked = new WeakMap<HTMLMediaElement, number>();
const duckedList: HTMLMediaElement[] = [];
let observer: MutationObserver | null = null;

function isAIOwned(el: HTMLMediaElement): boolean {
  return el.dataset?.[AI_AUDIO_ATTR] !== undefined;
}

function isAudible(el: HTMLMediaElement): boolean {
  return !el.paused && !el.muted && el.volume > 0;
}

function applyDuck(el: HTMLMediaElement): void {
  if (ducked.has(el) || isAIOwned(el) || !isAudible(el)) return;
  ducked.set(el, el.volume);
  duckedList.push(el);
  try { el.volume = Math.max(0, el.volume * DUCK_VOLUME_FACTOR); } catch { /* noop */ }
}

function restoreAll(): void {
  for (const el of duckedList) {
    const original = ducked.get(el);
    ducked.delete(el);
    if (original === undefined) continue;
    try { el.volume = original; } catch { /* noop */ }
  }
  duckedList.length = 0;
}

function duckPage(): void {
  if (typeof document === "undefined") return;
  const all = document.querySelectorAll("audio, video");
  for (const node of Array.from(all)) {
    applyDuck(node as HTMLMediaElement);
  }
}

function startObserver(): void {
  if (observer || typeof document === "undefined") return;
  observer = new MutationObserver((records) => {
    if (activeCount === 0) return;
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLMediaElement) {
          applyDuck(n);
        } else if (n instanceof Element) {
          n.querySelectorAll?.("audio, video").forEach((m) =>
            applyDuck(m as HTMLMediaElement),
          );
        }
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function stopObserver(): void {
  if (!observer) return;
  observer.disconnect();
  observer = null;
}

/**
 * Mark `el` as AI-owned so the ducking sweep skips it. Pass any
 * descriptive `kind` for inspection in DevTools.
 */
export function markAsAIAudio(
  el: HTMLMediaElement | null | undefined,
  kind: string = "ai",
): void {
  if (!el) return;
  try {
    el.dataset[AI_AUDIO_ATTR] = kind;
  } catch { /* noop — e.g. detached element */ }
}

/**
 * Flip ducking on/off. Reference-counted: every `true` call must be
 * matched by a `false` call. Mismatched calls are tolerated (counter
 * clamped to >= 0) so a buggy caller doesn't poison the global state.
 */
export function setAIAudioActive(active: boolean): void {
  if (active) {
    activeCount = Math.min(activeCount + 1, 32);
    if (restoreTimer) {
      clearTimeout(restoreTimer);
      restoreTimer = null;
    }
    if (activeCount === 1) {
      startObserver();
      duckPage();
    }
  } else {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) {
      if (restoreTimer) clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        if (activeCount === 0) {
          stopObserver();
          restoreAll();
        }
      }, RESTORE_DEBOUNCE_MS);
    }
  }
}

/**
 * Hard-reset — used by tests and by the live-action panel teardown path
 * when the user disconnects. Drops the counter to 0, cancels the timer,
 * restores every ducked element synchronously.
 */
export function resetAudioDucking(): void {
  activeCount = 0;
  if (restoreTimer) {
    clearTimeout(restoreTimer);
    restoreTimer = null;
  }
  stopObserver();
  restoreAll();
}

/** Test introspection: number of currently-ducked elements. */
export function _duckingActiveCountForTests(): number {
  return activeCount;
}
export function _duckedElementsForTests(): readonly HTMLMediaElement[] {
  return duckedList;
}
