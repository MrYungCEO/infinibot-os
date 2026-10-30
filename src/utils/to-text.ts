/**
 * `String(v)` for values typed `unknown` (SQL rows, JSON bodies, fetch inputs).
 *
 * Identical output to `String(v)`. It exists so call sites that deliberately
 * stringify loosely-typed data say so once, instead of tripping
 * `no-base-to-string` at every column read.
 */
export function toText(v: unknown): string {
  // oxlint-disable-next-line typescript/no-base-to-string -- deliberate, see above
  return String(v);
}
