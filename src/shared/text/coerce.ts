/**
 * Turn an untyped value (JSON payloads, tool args, DB rows) into a string.
 *
 * Same result as `String(value)` for strings, numbers, booleans and bigints.
 * `null`/`undefined` give `fallback`. Dates keep their `String()` form. Other
 * objects and arrays are JSON-encoded instead of becoming "[object Object]".
 */
export function coerceString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Date) return value.toString();
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    return Object.prototype.toString.call(value);
  }
}
