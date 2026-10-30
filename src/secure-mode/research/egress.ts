/**
 * Secure research egress policy: the ONLY network destinations a secure
 * research run may contact.
 *
 *   1. The configured SearXNG instance, and only when it is on this machine
 *      (loopback or an address bound to a local interface). The sanitized
 *      query text is the only secure-derived thing it receives.
 *   2. Plain page fetches of public http(s) URLs taken from the search
 *      results. Every hop (including redirects) is re-checked, and the
 *      connection is pinned to the vetted address so DNS cannot rebind it.
 *
 * Refused outright, whatever the URL path:
 *   - cloud LLM, "AI search" and search-API hosts (OpenAI, Anthropic,
 *     Perplexity, Brave Search API / Brave AI, Google Gemini, Exa, Tavily,
 *     Serper, SerpAPI, You.com, Bing API, Kagi API, OpenRouter, Groq, …);
 *   - private, loopback, link-local, CGNAT/tailnet and other non-public
 *     addresses (no reaching the gateway, the LAN or the tailnet);
 *   - anything that is not http/https, has credentials in it, or uses a
 *     non-standard port below 1024 other than 80/443.
 */

import dns from "node:dns/promises";
import net from "node:net";

import type { InfinibotConfig } from "../../config/config.js";
import { getHostLocalityChecker } from "../host-locality.js";

/**
 * Hosts (and their subdomains) that run cloud LLMs, AI answer engines or
 * paid search APIs. A secure query must never reach them.
 */
export const CLOUD_LLM_SEARCH_DENY: readonly string[] = Object.freeze([
  "openai.com",
  "chatgpt.com",
  "oaiusercontent.com",
  "anthropic.com",
  "claude.ai",
  "perplexity.ai",
  "pplx.ai",
  "api.search.brave.com",
  "search.brave.com", // Brave "Answer with AI" lives here; plain Brave stays off too
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "gemini.google.com",
  "bard.google.com",
  "customsearch.googleapis.com",
  "exa.ai",
  "tavily.com",
  "serper.dev",
  "serpapi.com",
  "searchapi.io",
  "you.com",
  "api.bing.microsoft.com",
  "copilot.microsoft.com",
  "bing.com/chat",
  "kagi.com",
  "phind.com",
  "openrouter.ai",
  "groq.com",
  "together.xyz",
  "together.ai",
  "deepseek.com",
  "mistral.ai",
  "cohere.ai",
  "cohere.com",
  "x.ai",
  "grok.com",
  "ollama.com",
  "huggingface.co",
  "hf.co",
  "replicate.com",
  "fireworks.ai",
  "deepinfra.com",
  "cerebras.ai",
  "jina.ai",
  "firecrawl.dev",
  "scrapingbee.com",
  "duckduckgo.com/duckchat",
  "duck.ai",
  "meta.ai",
  "poe.com",
  "character.ai",
  "githubcopilot.com",
  "azure.com",
  "openai.azure.com",
  "bedrock-runtime.amazonaws.com",
]);

export class SecureEgressError extends Error {
  readonly code = "SECURE_EGRESS_BLOCKED";
  constructor(message: string) {
    super(`Blocked by Secure Mode research egress policy: ${message}`);
    this.name = "SecureEgressError";
  }
}

export type EgressPurpose = "search" | "page";

export type EgressVerdict =
  | { allowed: true; url: URL; purpose: EgressPurpose; addresses?: string[] }
  | { allowed: false; reason: string };

const NON_PUBLIC = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT + Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC.addSubnet(net4, prefix, "ipv4");
}
for (const [net6, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["64:ff9b::", 96],
  ["fd7a:115c:a1e0::", 48], // Tailscale
] as const) {
  NON_PUBLIC.addSubnet(net6, prefix, "ipv6");
}

/** True when `addr` is a routable public internet address. */
export function isPublicAddress(addr: string): boolean {
  let a = addr.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  const fam = net.isIP(a);
  if (fam === 4) return !NON_PUBLIC.check(a, "ipv4");
  if (fam === 6) return !NON_PUBLIC.check(a, "ipv6");
  return false;
}

/** Is this host (or a parent domain) on the cloud LLM / search API deny list? */
export function isDeniedLlmHost(host: string, path = "/"): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const entry of CLOUD_LLM_SEARCH_DENY) {
    const slash = entry.indexOf("/");
    const domain = slash >= 0 ? entry.slice(0, slash) : entry;
    const prefix = slash >= 0 ? entry.slice(slash) : null;
    const hostMatch = h === domain || h.endsWith(`.${domain}`);
    if (!hostMatch) continue;
    if (!prefix || path.toLowerCase().startsWith(prefix)) return true;
  }
  return false;
}

export type ResearchEndpoints = {
  /** SearXNG base URL (must be on this machine). */
  searxngUrl: string;
};

export const DEFAULT_SEARXNG_URL = "http://127.0.0.1:8888";

export function resolveResearchEndpoints(cfg?: InfinibotConfig): ResearchEndpoints {
  const raw = cfg?.secureMode?.research?.searxngUrl?.trim();
  return { searxngUrl: (raw || DEFAULT_SEARXNG_URL).replace(/\/+$/, "") };
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase();
}

export type Resolver = (host: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => {
  const res = await dns.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};

/** Static checks only (no DNS). Use checkEgress on the request path. */
export function checkEgressStatic(
  rawUrl: string,
  purpose: EgressPurpose,
  endpoints: ResearchEndpoints,
): EgressVerdict {
  const url = parse(rawUrl);
  if (!url) return { allowed: false, reason: `not a URL: ${rawUrl.slice(0, 80)}` };
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { allowed: false, reason: `${url.protocol} is not allowed (http/https only)` };
  if (url.username || url.password)
    return { allowed: false, reason: "URLs with credentials are not allowed" };
  const host = url.hostname.toLowerCase();
  if (isDeniedLlmHost(host, url.pathname))
    return {
      allowed: false,
      reason: `${host} is a cloud LLM / AI search / search API host; Secure Mode never sends queries there`,
    };
  if (purpose === "search") {
    const base = parse(endpoints.searxngUrl);
    if (!base || !sameOrigin(url, base))
      return {
        allowed: false,
        reason: `search requests may only go to the local SearXNG (${endpoints.searxngUrl})`,
      };
    return { allowed: true, url, purpose };
  }
  // page fetch
  const searx = parse(endpoints.searxngUrl);
  if (searx && sameOrigin(url, searx))
    return { allowed: false, reason: "page fetches may not target the SearXNG instance" };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port < 1024 && port !== 80 && port !== 443)
    return { allowed: false, reason: `port ${port} is not allowed for page fetches` };
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return { allowed: false, reason: `${host} is not a public host` };
  const literal = host.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) && !isPublicAddress(literal))
    return { allowed: false, reason: `${literal} is not a public address` };
  return { allowed: true, url, purpose };
}

/**
 * Full check. For pages, resolves DNS and requires EVERY address to be public;
 * the caller connects to `addresses[0]` (pinned). For search, the SearXNG
 * host must be on this machine.
 *
 * `viaProxy`: the proxy resolves names (socks5h / HTTP CONNECT), so page DNS
 * is not resolved locally; literal IPs are still checked statically.
 */
export async function checkEgress(
  rawUrl: string,
  purpose: EgressPurpose,
  endpoints: ResearchEndpoints,
  opts: { cfg?: InfinibotConfig; resolver?: Resolver; viaProxy?: boolean } = {},
): Promise<EgressVerdict> {
  const v = checkEgressStatic(rawUrl, purpose, endpoints);
  if (!v.allowed) return v;
  const host = v.url.hostname.replace(/^\[|\]$/g, "");
  if (purpose === "search") {
    const local = await getHostLocalityChecker().check(host, opts.cfg);
    if (!local.local)
      return {
        allowed: false,
        reason: `SearXNG at ${host} is not on this machine (${local.detail}); run it locally (docker/searxng)`,
      };
    return v;
  }
  if (opts.viaProxy || net.isIP(host))
    return { ...v, addresses: net.isIP(host) ? [host] : undefined };
  let addrs: string[];
  try {
    addrs = await (opts.resolver ?? defaultResolver)(host);
  } catch (err) {
    return {
      allowed: false,
      reason: `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!addrs.length) return { allowed: false, reason: `${host} did not resolve` };
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) return { allowed: false, reason: `${host} resolves to non-public address ${bad}` };
  return { ...v, addresses: addrs };
}
