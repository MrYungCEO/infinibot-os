/**
 * Privacy-hardened HTTP client for Secure Mode research.
 *
 * - No cookies (none are stored, none are sent), no Referer, no
 *   Authorization, a generic browser User-Agent shared by many users.
 * - No JavaScript: the body is read as bytes and converted to text locally
 *   (extract.ts); nothing is executed.
 * - Hard size and time limits; text-like content types only.
 * - Redirects are followed manually (at most 4) and every hop is re-checked
 *   against the egress policy (egress.ts).
 * - Without a proxy the TCP connection is pinned to the address the policy
 *   vetted, so a DNS answer cannot change between check and connect.
 * - Optional proxy (`secureMode.research.proxy`): `socks5://127.0.0.1:9050`
 *   (Tor) or `http(s)://host:port`. The proxy then resolves names.
 *
 * Every attempt is reported to the `onEgress` sink so the run log (and the
 * e2e network capture) records exactly which hosts were contacted.
 */

import net from "node:net";

import { Agent, ProxyAgent, Socks5ProxyAgent, request, type Dispatcher } from "undici";

import type { InfinibotConfig } from "../../config/config.js";
import {
  checkEgress,
  type EgressPurpose,
  type ResearchEndpoints,
  type Resolver,
  SecureEgressError,
} from "./egress.js";

/** A current, very common desktop UA (no InfiniBot / Node marker). */
export const GENERIC_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

export const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
export const DEFAULT_MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;

const TEXT_TYPES =
  /^(?:text\/(?:html|plain|xml)|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))\b/i;

export type EgressEvent = {
  at: number;
  purpose: EgressPurpose;
  /** Host only (paths of page fetches are public URLs from the search results). */
  host: string;
  url: string;
  status?: number;
  bytes?: number;
  blocked?: string;
  error?: string;
  viaProxy?: boolean;
  /** The vetted address the connection was pinned to (page fetches without a proxy). */
  address?: string;
};

export type FetchResult = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
};

export type SecureFetcherOptions = {
  endpoints: ResearchEndpoints;
  cfg?: InfinibotConfig;
  proxy?: string;
  timeoutMs?: number;
  maxBytes?: number;
  resolver?: Resolver;
  onEgress?: (e: EgressEvent) => void;
  /** Test seam: replaces undici.request. */
  requestImpl?: typeof request;
};

export function describeProxy(proxy: string | undefined): {
  kind: "none" | "socks5" | "http";
  url?: string;
} {
  const p = proxy?.trim();
  if (!p) return { kind: "none" };
  if (/^socks5h?:\/\//i.test(p)) return { kind: "socks5", url: p.replace(/^socks5h:/i, "socks5:") };
  if (/^https?:\/\//i.test(p)) return { kind: "http", url: p };
  throw new SecureEgressError(
    `secureMode.research.proxy must be socks5://… or http(s)://… (got "${p.slice(0, 40)}")`,
  );
}

function pinnedAgent(address: string, timeoutMs: number): Agent {
  const family = net.isIP(address) === 6 ? 6 : 4;
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: ((_host: string, opts: unknown, cb: (...args: unknown[]) => void) => {
        if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) {
          cb(null, [{ address, family }]);
        } else {
          cb(null, address, family);
        }
      }) as unknown as net.LookupFunction,
    },
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    pipelining: 0,
  });
}

export class SecureFetcher {
  private readonly proxy: ReturnType<typeof describeProxy>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly req: typeof request;

  constructor(private readonly opts: SecureFetcherOptions) {
    this.proxy = describeProxy(opts.proxy);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.req = opts.requestImpl ?? request;
  }

  get proxyKind(): "none" | "socks5" | "http" {
    return this.proxy.kind;
  }

  private dispatcherFor(purpose: EgressPurpose, addresses?: string[]): Dispatcher | undefined {
    // The local SearXNG is reached directly; only page fetches use the proxy.
    if (purpose === "page" && this.proxy.kind === "socks5" && this.proxy.url)
      return new Socks5ProxyAgent(this.proxy.url);
    if (purpose === "page" && this.proxy.kind === "http" && this.proxy.url)
      return new ProxyAgent({ uri: this.proxy.url });
    if (addresses?.length) return pinnedAgent(addresses[0], this.timeoutMs);
    return undefined;
  }

  /** GET a URL under the egress policy. Throws SecureEgressError when refused. */
  async get(rawUrl: string, purpose: EgressPurpose, signal?: AbortSignal): Promise<FetchResult> {
    let current = rawUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const viaProxy = purpose === "page" && this.proxy.kind !== "none";
      const verdict = await checkEgress(current, purpose, this.opts.endpoints, {
        cfg: this.opts.cfg,
        resolver: this.opts.resolver,
        viaProxy,
      });
      if (!verdict.allowed) {
        this.opts.onEgress?.({
          at: Date.now(),
          purpose,
          host: safeHost(current),
          url: current,
          blocked: verdict.reason,
        });
        throw new SecureEgressError(verdict.reason);
      }
      const dispatcher = this.dispatcherFor(purpose, verdict.addresses);
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let status = 0;
      try {
        const res = await this.req(verdict.url, {
          method: "GET",
          dispatcher,
          signal: combined,
          headersTimeout: this.timeoutMs,
          bodyTimeout: this.timeoutMs,
          headers: {
            "user-agent": GENERIC_USER_AGENT,
            accept:
              purpose === "search"
                ? "application/json"
                : "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            "accept-language": "en-US,en;q=0.7",
            // Explicitly nothing else: no cookie, referer, authorization, DNT
            // (a rare header is itself a fingerprint).
          },
        });
        status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location) {
          await res.body.dump().catch(() => undefined);
          const loc = Array.isArray(res.headers.location)
            ? res.headers.location[0]
            : res.headers.location;
          this.opts.onEgress?.({
            at: Date.now(),
            purpose,
            host: verdict.url.hostname,
            url: current,
            status,
            viaProxy,
            address: verdict.addresses?.[0],
          });
          current = new URL(loc, verdict.url).toString();
          continue;
        }
        const ctype = String(res.headers["content-type"] ?? "");
        if (ctype && !TEXT_TYPES.test(ctype)) {
          await res.body.dump().catch(() => undefined);
          this.opts.onEgress?.({
            at: Date.now(),
            purpose,
            host: verdict.url.hostname,
            url: current,
            status,
            error: `skipped content-type ${ctype.split(";")[0]}`,
            viaProxy,
          });
          throw new Error(`unsupported content type ${ctype.split(";")[0]}`);
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        for await (const chunk of res.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          if (bytes + buf.length > this.maxBytes) {
            chunks.push(buf.subarray(0, this.maxBytes - bytes));
            bytes = this.maxBytes;
            truncated = true;
            break;
          }
          chunks.push(buf);
          bytes += buf.length;
        }
        if (truncated) res.body.destroy();
        this.opts.onEgress?.({
          at: Date.now(),
          purpose,
          host: verdict.url.hostname,
          url: current,
          status,
          bytes,
          viaProxy,
          address: verdict.addresses?.[0],
        });
        return {
          url: rawUrl,
          finalUrl: current,
          status,
          contentType: ctype,
          body: Buffer.concat(chunks).toString("utf8"),
          bytes,
          truncated,
        };
      } catch (err) {
        if (err instanceof SecureEgressError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (!/unsupported content type/.test(message)) {
          this.opts.onEgress?.({
            at: Date.now(),
            purpose,
            host: verdict.url.hostname,
            url: current,
            status: status || undefined,
            error: message,
            viaProxy,
          });
        }
        throw err;
      } finally {
        if (dispatcher && "close" in dispatcher)
          void (dispatcher as Agent).close().catch(() => undefined);
      }
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
  }
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "(invalid)";
  }
}
