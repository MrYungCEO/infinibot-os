/**
 * Tiny HTTP helpers for plan pullers — timeout-guarded JSON fetch + a defensive
 * recursive numeric-field summer (provider report schemas vary and nest results,
 * so we sum a named field wherever it appears rather than hard-coding paths).
 */

const DEFAULT_TIMEOUT_MS = 12_000;

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recursively sum every occurrence of a numeric `field` in an arbitrarily
 * nested object/array. Accepts numbers and numeric strings. Also handles the
 * `{ value, currency }` money shape some providers wrap amounts in.
 */
export function sumNumericField(node: unknown, field: string): number {
  let total = 0;
  const visit = (n: unknown): void => {
    if (n == null) return;
    if (Array.isArray(n)) {
      for (const item of n) visit(item);
      return;
    }
    if (typeof n === "object") {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (k === field) {
          total += coerceMoney(v);
        } else {
          visit(v);
        }
      }
    }
  };
  visit(node);
  return total;
}

function coerceMoney(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  // `{ value: "1.23", currency: "USD" }` style.
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if ("value" in obj) return coerceMoney(obj.value);
    if ("amount" in obj) return coerceMoney(obj.amount);
  }
  return 0;
}
