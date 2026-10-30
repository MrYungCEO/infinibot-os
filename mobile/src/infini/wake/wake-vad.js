/**
 * wake-vad — a tiny voice-activity segmenter over recorder metering levels
 * (0..1, see face-math dbToLevel). Pure, so jest can drive it with synthetic
 * level sequences.
 *
 *   silence ──level ≥ thr for minVoicedMs──▶ voiced   (emits 'start')
 *   voiced  ──level < thr──▶ hangover ──back above──▶ voiced
 *   hangover ──hangoverMs of quiet──▶ silence         (emits 'end' | 'drop')
 *   voiced  ──maxSegmentMs──▶ overflow                (emits 'end', reason 'max')
 *   overflow ──hangoverMs of quiet──▶ silence         (long talk / TV: one check, then wait)
 *
 * The threshold adapts to the room: max(threshold, noiseFloor + margin),
 * where the noise floor is a slow average of the level while silent (and of
 * any sound that runs past the max segment length — a fan, a TV).
 */

export const VAD_DEFAULTS = {
  threshold: 0.3,
  margin: 0.14,
  minVoicedMs: 120,
  hangoverMs: 450,
  maxSegmentMs: 2500,
  minSegmentMs: 280,
  floorAlpha: 0.05,
};

export function createVad(opts = {}) {
  const o = { ...VAD_DEFAULTS, ...opts };
  let mode = 'silence';
  let floor = 0;
  let onsetAt = -1;
  let startAt = -1;
  let lastVoiced = -1;
  let quietSince = -1;

  const thr = () => Math.max(o.threshold, floor + o.margin);

  function push(level, t) {
    const lv = typeof level === 'number' && Number.isFinite(level) ? level : 0;
    const loud = lv >= thr();
    switch (mode) {
      case 'silence':
        if (!loud) {
          floor += (lv - floor) * o.floorAlpha;
          onsetAt = -1;
          return null;
        }
        if (onsetAt < 0) onsetAt = t;
        if (t - onsetAt >= o.minVoicedMs) {
          mode = 'voiced';
          startAt = onsetAt;
          lastVoiced = t;
          return { type: 'start', startMs: startAt };
        }
        return null;
      case 'voiced':
      case 'hangover':
        if (t - startAt >= o.maxSegmentMs) {
          mode = 'overflow';
          quietSince = loud ? -1 : t;
          return { type: 'end', startMs: startAt, endMs: t, reason: 'max' };
        }
        if (loud) {
          mode = 'voiced';
          lastVoiced = t;
          return null;
        }
        if (mode === 'voiced') mode = 'hangover';
        if (t - lastVoiced >= o.hangoverMs) {
          mode = 'silence';
          onsetAt = -1;
          const ev = lastVoiced - startAt >= o.minSegmentMs ? { type: 'end', startMs: startAt, endMs: lastVoiced, reason: 'silence' } : { type: 'drop', startMs: startAt, endMs: lastVoiced };
          startAt = -1;
          return ev;
        }
        return null;
      case 'overflow':
        // Sound that never stops (fan, TV, traffic) is the room, not a voice: learn it.
        floor += (lv - floor) * o.floorAlpha * 2;
        if (lv >= thr()) {
          quietSince = -1;
          return null;
        }
        if (quietSince < 0) quietSince = t;
        if (t - quietSince >= o.hangoverMs) {
          mode = 'silence';
          onsetAt = -1;
          startAt = -1;
          return { type: 'ready' };
        }
        return null;
      default:
        return null;
    }
  }

  return {
    push,
    reset() {
      mode = 'silence';
      onsetAt = -1;
      startAt = -1;
      lastVoiced = -1;
      quietSince = -1;
    },
    get mode() {
      return mode;
    },
    get threshold() {
      return thr();
    },
  };
}
