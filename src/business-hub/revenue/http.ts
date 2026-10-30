/**
 * Business hub revenue — the only HTTP client revenue sync uses. It is
 * GET-only by construction: any other method throws before a request is
 * made, so sync can never create, modify, refund or cancel anything at
 * Whop or Stripe. Adds a timeout, retry with backoff on 429/5xx/network
 * errors (honours Retry-After, max 5 tries) and a per-provider token bucket.
 *
 * Error messages never include the API key or request headers.
 */

export type HttpResponseLike = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export type QueryValue = string | number | boolean | undefined | null | string[];

export class ReadOnlyViolation extends Error {
  constructor(method: string) {
    super(`revenue http client is read-only: refusing ${method.toUpperCase()}`);
  }
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly path: string,
    readonly bodySnippet: string,
  ) {
    super(`${provider} API ${status} on ${path}${bodySnippet ? `: ${bodySnippet}` : ""}`);
  }
}

/** Simple token bucket: `rate` tokens per second, burst = rate. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.tokens = rate;
    this.last = now();
  }
  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.rate, this.tokens + ((t - this.last) / 1000) * this.rate);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }
}

const DEFAULT_RATES: Record<string, number> = { whop: 5, stripe: 20 };
const buckets = new Map<string, TokenBucket>();

function sharedBucket(provider: string): TokenBucket {
  let b = buckets.get(provider);
  if (!b) {
    b = new TokenBucket(DEFAULT_RATES[provider] ?? 5);
    buckets.set(provider, b);
  }
  return b;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type RevenueHttpOptions = {
  provider: string;
  apiKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxTries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** false disables throttling (tests); a number overrides req/s; default per provider. */
  rateLimit?: boolean | number;
  signal?: AbortSignal;
};

export type RevenueHttp = {
  provider: string;
  /** Number of HTTP requests that returned a response (any status). */
  readonly requests: number;
  /** GET a URL with query params and parse JSON. */
  get(url: string, query?: Record<string, QueryValue>): Promise<unknown>;
  /** Generic entry point kept only to enforce the GET-only rule. */
  request(method: string, url: string, query?: Record<string, QueryValue>): Promise<unknown>;
};

export function buildUrl(url: string, query?: Record<string, QueryValue>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Retry-After as seconds or HTTP date → ms (capped at 60 s), or null. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), 60_000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), 60_000) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createRevenueHttp(opts: RevenueHttpOptions): RevenueHttp {
  const doFetch: FetchLike =
    opts.fetch ?? ((url, init) => fetch(url, init) as Promise<HttpResponseLike>);
  const sleep = opts.sleep ?? defaultSleep;
  const maxTries = Math.max(1, Math.min(opts.maxTries ?? 5, 5));
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const bucket =
    opts.rateLimit === false
      ? null
      : typeof opts.rateLimit === "number"
        ? new TokenBucket(opts.rateLimit, Date.now, sleep)
        : sharedBucket(opts.provider);
  let requests = 0;

  async function request(
    method: string,
    url: string,
    query?: Record<string, QueryValue>,
  ): Promise<unknown> {
    if (method.toUpperCase() !== "GET") throw new ReadOnlyViolation(method);
    const full = buildUrl(url, query);
    const path = new URL(full).pathname;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      if (opts.signal?.aborted) throw new Error("sync aborted");
      if (bucket) await bucket.take();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      let res: HttpResponseLike;
      try {
        res = await doFetch(full, {
          method: "GET",
          headers: { Authorization: `Bearer ${opts.apiKey}`, Accept: "application/json" },
          signal: ctrl.signal,
        });
        requests++;
      } catch (err) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) throw new Error("sync aborted");
        lastErr = err;
        if (attempt < maxTries) await sleep(backoff(attempt));
        continue;
      }
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const body = await res.text().catch(() => "");
      if (res.status >= 200 && res.status < 300) {
        try {
          return body ? (JSON.parse(body) as unknown) : {};
        } catch {
          throw new ProviderHttpError(opts.provider, res.status, path, "invalid JSON");
        }
      }
      const err = new ProviderHttpError(opts.provider, res.status, path, snippet(body));
      if (!isRetryableStatus(res.status) || attempt >= maxTries) throw err;
      lastErr = err;
      await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt));
    }
    if (lastErr instanceof ProviderHttpError) throw lastErr;
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`${opts.provider} request failed after ${maxTries} tries on ${path}: ${msg}`);
  }

  return {
    provider: opts.provider,
    get requests() {
      return requests;
    },
    get: (url, query) => request("GET", url, query),
    request,
  };
}

function backoff(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** First 200 chars of an error body, with anything email-like masked. */
function snippet(body: string): string {
  return body
    .slice(0, 200)
    .replace(/\s+/g, " ")
    .replace(/[^\s"'@]+@[^\s"'@]+\.[a-z]{2,}/gi, "<email>")
    .trim();
}
