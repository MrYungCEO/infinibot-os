/**
 * Rate-limits the gateway's auth-failure log lines.
 *
 * A client holding a stale password reconnects in a loop (the mobile app used
 * to retry about once a second), and each attempt logged two WARN lines
 * ("unauthorized conn=…" + "closed before connect …"). This lets the first
 * failure per client through, swallows the repeats for a window, and folds
 * their count into the next line that is logged — about one line per client
 * per minute.
 */

export type AuthFailureLogDecision = {
  /** Log this failure at the normal level. */
  emit: boolean;
  /** Failures from this client swallowed since the last emitted line. */
  suppressed: number;
};

export function createAuthFailureLogLimiter(opts: { windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const maxKeys = opts.maxKeys ?? 1000;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { windowStart: number; suppressed: number }>();

  const prune = (t: number) => {
    if (entries.size <= maxKeys) return;
    for (const [k, e] of entries) {
      if (t - e.windowStart >= windowMs) entries.delete(k);
    }
    // Still full (a flood of distinct clients): drop the oldest.
    while (entries.size > maxKeys) {
      const first = entries.keys().next().value;
      if (first === undefined) break;
      entries.delete(first);
    }
  };

  return {
    hit(key: string): AuthFailureLogDecision {
      const t = now();
      const e = entries.get(key);
      if (!e || t - e.windowStart >= windowMs) {
        const suppressed = e?.suppressed ?? 0;
        entries.delete(key);
        entries.set(key, { windowStart: t, suppressed: 0 });
        prune(t);
        return { emit: true, suppressed };
      }
      e.suppressed += 1;
      return { emit: false, suppressed: e.suppressed };
    },
    /** Test hook. */
    size() {
      return entries.size;
    },
  };
}

/** Process-wide limiter shared by every WS connection. */
export const authFailureLogLimiter = createAuthFailureLogLimiter();

export function authFailureLogKey(remoteAddr: string | undefined, clientId: string | undefined | null): string {
  return `${remoteAddr ?? "?"}|${clientId ?? "?"}`;
}
