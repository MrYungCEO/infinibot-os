#!/usr/bin/env node
/**
 * Smoke for the audio-ducking module. Verifies:
 *   1. Non-AI audible elements get ducked when AI starts speaking.
 *   2. AI-marked elements are skipped.
 *   3. Muted / paused / volume=0 elements are skipped.
 *   4. Reference counting: overlapping activations don't restore early.
 *   5. Restore returns each element to its *original* volume (not 1.0).
 *   6. resetAudioDucking restores everything synchronously.
 *
 * Hand-rolled DOM stubs — no jsdom dependency.
 *
 * Run: node --import tsx scripts/audio-ducking-smoke.mts
 */

// ── Minimal stubs for the surface audio-ducking touches ──

class FakeAudio {
  volume: number;
  muted: boolean;
  paused: boolean;
  dataset: Record<string, string> = {};
  constructor(volume: number, opts: { paused?: boolean; muted?: boolean } = {}) {
    this.volume = volume;
    this.muted = opts.muted ?? false;
    this.paused = opts.paused ?? false;
  }
}

const elements: FakeAudio[] = [];

(globalThis as any).document = {
  querySelectorAll: (selector: string) => {
    // Module asks for "audio, video" — return everything we've made.
    void selector;
    return elements;
  },
  documentElement: {},
};
// MutationObserver is only constructed when ducking activates; provide a
// no-op so the import + activation paths don't blow up. We don't exercise
// the observer path in this smoke (would need real DOM mutation events).
(globalThis as any).MutationObserver = class {
  observe() { /* noop */ }
  disconnect() { /* noop */ }
};
// HTMLMediaElement only used by app-level callers; we feed FakeAudio
// instances directly through markAsAIAudio so this can be a stub.
(globalThis as any).HTMLMediaElement = class {};

// ── Import after stubs are in place ──
const ducking = await import("../ui/src/ui/audio-ducking.ts");

function ok(label: string) { console.log(`✓ ${label}`); }
function fail(label: string, detail?: unknown): never {
  console.error(`✗ ${label}`);
  if (detail !== undefined) console.error("  detail:", detail);
  process.exit(1);
}

function reset() {
  ducking.resetAudioDucking();
  elements.length = 0;
}

function add(volume: number, opts: { paused?: boolean; muted?: boolean } = {}): FakeAudio {
  const el = new FakeAudio(volume, opts);
  elements.push(el);
  return el;
}

const tick = () => new Promise((r) => setImmediate(r));

// ── 1. Basic duck + restore ──────────────────────────────────
{
  reset();
  const a = add(0.8);
  const b = add(0.5);
  ducking.setAIAudioActive(true);
  await tick();
  if (a.volume >= 0.8) fail(`a should be ducked; got ${a.volume}`);
  if (b.volume >= 0.5) fail(`b should be ducked; got ${b.volume}`);

  // Hard-reset (rather than waiting for the 350ms debounce after a single
  // release) restores synchronously.
  ducking.setAIAudioActive(false);
  ducking.resetAudioDucking();
  if (Math.abs(a.volume - 0.8) > 0.001) fail(`a should restore to 0.8; got ${a.volume}`);
  if (Math.abs(b.volume - 0.5) > 0.001) fail(`b should restore to 0.5; got ${b.volume}`);
  ok("audible elements ducked then restored to original volumes");
}

// ── 2. AI-marked elements skipped ────────────────────────────
{
  reset();
  const ai = add(0.9);
  ducking.markAsAIAudio(ai as unknown as HTMLMediaElement, "agent-speech");
  const other = add(0.7);
  ducking.setAIAudioActive(true);
  await tick();
  if (ai.volume !== 0.9) fail(`AI-marked should not be ducked; got ${ai.volume}`);
  if (other.volume >= 0.7) fail(`other should be ducked; got ${other.volume}`);
  ducking.resetAudioDucking();
  ok("AI-marked elements left untouched");
}

// ── 3. Paused / muted / volume=0 skipped ─────────────────────
{
  reset();
  const paused = add(0.8, { paused: true });
  const muted = add(0.8, { muted: true });
  const silent = add(0);
  const playing = add(0.6);
  ducking.setAIAudioActive(true);
  await tick();
  if (paused.volume !== 0.8) fail("paused element should be skipped");
  if (muted.volume !== 0.8) fail("muted element should be skipped");
  if (silent.volume !== 0) fail("volume=0 element should be skipped");
  if (playing.volume >= 0.6) fail(`playing audible element should be ducked; got ${playing.volume}`);
  ducking.resetAudioDucking();
  ok("paused / muted / volume=0 elements skipped");
}

// ── 4. Overlapping activations — refcount ────────────────────
{
  reset();
  const a = add(0.8);
  ducking.setAIAudioActive(true);   // counter=1
  ducking.setAIAudioActive(true);   // counter=2 (e.g. Kokoro + LiveKit overlap)
  await tick();
  if (a.volume >= 0.8) fail("should be ducked while either source active");

  ducking.setAIAudioActive(false);  // counter=1 — still ducked
  if (a.volume >= 0.8) fail("should stay ducked when one source releases but others still active");
  if (ducking._duckingActiveCountForTests() !== 1) {
    fail(`expected activeCount=1, got ${ducking._duckingActiveCountForTests()}`);
  }
  ducking.resetAudioDucking();
  ok("overlapping activations refcount correctly");
}

// ── 5. Original volume preserved (not 1.0) ───────────────────
{
  reset();
  const a = add(0.35); // user has music at 35%
  ducking.setAIAudioActive(true);
  await tick();
  if (a.volume >= 0.35) fail(`expected duck below original 0.35; got ${a.volume}`);
  if (a.volume > 0.1) fail(`expected duck to ~0.0525 (35% × 0.15); got ${a.volume}`);
  ducking.resetAudioDucking();
  if (Math.abs(a.volume - 0.35) > 0.001) {
    fail(`should restore to user's 0.35, got ${a.volume}`);
  }
  ok("restored to user-set original volume, not 1.0");
}

// ── 6. Excess releases tolerated (clamped) ───────────────────
{
  reset();
  ducking.setAIAudioActive(true);
  ducking.setAIAudioActive(false);
  ducking.setAIAudioActive(false); // extra release — should clamp at 0
  ducking.setAIAudioActive(false); // even more — still 0
  if (ducking._duckingActiveCountForTests() !== 0) {
    fail(`expected activeCount clamped to 0, got ${ducking._duckingActiveCountForTests()}`);
  }
  ducking.resetAudioDucking();
  ok("excess setAIAudioActive(false) clamped at 0");
}

// ── 7. Hard reset restores synchronously ─────────────────────
{
  reset();
  const a = add(0.6);
  ducking.setAIAudioActive(true);
  ducking.setAIAudioActive(true);
  await tick();
  if (a.volume >= 0.6) fail("should be ducked");
  ducking.resetAudioDucking();
  if (Math.abs(a.volume - 0.6) > 0.001) {
    fail(`reset should restore synchronously to 0.6; got ${a.volume}`);
  }
  if (ducking._duckingActiveCountForTests() !== 0) {
    fail("reset should zero activeCount");
  }
  ok("resetAudioDucking restores synchronously, zeroes refcount");
}

console.log("\nOK — audio-ducking module verified");
process.exit(0);
