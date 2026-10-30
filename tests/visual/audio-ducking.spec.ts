import { test } from "@playwright/test";

/**
 * Audio ducking — placeholder / TODO.
 *
 * Audio ducking (lowering media volume while the voice agent speaks) is not a
 * VISUAL change, so screenshot diffing can't verify it. It needs an audio-graph
 * assertion, not a pixel one.
 *
 * Approach to implement later (out of this agent's scope):
 *   1. Run the voice surface in headed Chromium with a fake media stream
 *      (`--use-fake-device-for-media-stream`, `--autoplay-policy=no-user-gesture-required`).
 *   2. Play a known tone through a <audio>/<video> element, then trigger TTS
 *      playback.
 *   3. Tap a Web Audio AnalyserNode (or read HTMLMediaElement.volume / the
 *      GainNode value the ducking code sets) before/during/after TTS and assert
 *      the measured gain drops by the configured duck ratio, then restores.
 *   4. Cross-check against scripts/audio-ducking-smoke.mts (the existing
 *      non-visual smoke) so both share one expectation.
 *
 * Until that harness exists, this is recorded as skipped coverage so it shows in
 * the report rather than being silently absent.
 */
test.describe("audio ducking", () => {
  test.fixme(true, "audio ducking is non-visual — needs a Web Audio gain assertion harness (see file header)");

  test("media volume ducks while TTS plays", async () => {
    // intentionally unimplemented — see header for the planned approach.
  });
});
