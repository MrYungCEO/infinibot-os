/**
 * Pixels to scroll this dragover tick: 0 outside the edge zone, ramping up to
 * `max` as the pointer reaches the start (negative) or end (positive) edge.
 */
export function edgeScrollStep(pos: number, start: number, end: number, zone = 56, max = 18): number {
  const z = Math.min(zone, (end - start) / 3);
  if (z <= 0) return 0;
  if (pos < start + z) return -Math.ceil(max * Math.min(1, (start + z - pos) / z));
  if (pos > end - z) return Math.ceil(max * Math.min(1, (pos - (end - z)) / z));
  return 0;
}
