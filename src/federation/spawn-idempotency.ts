/**
 * Idempotency guard for cross-node spawns.
 *
 * A cross-node spawn can be retried by the caller (or replayed after a forward
 * timeout where the remote actually spawned). Without a guard, each retry
 * creates a duplicate sub-agent on the target node. Callers attach a stable
 * `idempotencyKey`; the receiving handler records the spawn result under that
 * key for a short TTL and returns the cached result on any replay instead of
 * spawning again.
 *
 * The key travels in the forwarded params (only `nodeId`/`node` are stripped on
 * forward), so the dedupe happens on whichever node actually performs the local
 * spawn — origin, master relay, and target all converge on the same answer.
 */

interface CacheEntry {
  result: unknown;
  expires: number;
}

const DEFAULT_TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

function sweep(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expires <= now) cache.delete(key);
  }
}

/**
 * Return the cached result for this idempotency key, or undefined if there is
 * no live entry. A missing/blank key is never a hit.
 */
export function getIdempotentResult<T = unknown>(key: string | null | undefined): T | undefined {
  if (!key) return undefined;
  const now = Date.now();
  sweep(now);
  const entry = cache.get(key);
  return entry ? (entry.result as T) : undefined;
}

/**
 * Record a spawn result under an idempotency key for a short TTL so retries
 * with the same key return the same answer instead of double-spawning.
 */
export function recordIdempotentResult(
  key: string | null | undefined,
  result: unknown,
  ttlMs: number = DEFAULT_TTL_MS,
): void {
  if (!key) return;
  cache.set(key, { result, expires: Date.now() + ttlMs });
}

/** Test-only: clear the cache between cases. */
export function __clearIdempotencyCache(): void {
  cache.clear();
}
