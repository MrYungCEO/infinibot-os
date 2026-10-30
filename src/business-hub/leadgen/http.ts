/**
 * Lead generation — polite HTTP for crawling third-party business websites:
 * http(s) only, SSRF guard (every hop's host must resolve to public IPs),
 * robots.txt (User-agent `*` and ours), >=1s per-host spacing, 8s timeout,
 * 1.5 MB body cap. API calls to known providers use `jsonRequest` instead.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  LEADGEN_ROBOTS_TOKEN,
  LEADGEN_USER_AGENT,
  type LeadgenDeps,
  type LookupAddress,
} from "./types.js";

export const PAGE_TIMEOUT_MS = 8_000;
export const MAX_PAGE_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

export function depFetch(deps: LeadgenDeps): typeof fetch {
  return deps.fetchImpl ?? fetch;
}

export function depSleep(deps: LeadgenDeps): (ms: number) => Promise<void> {
  return deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

// ── SSRF guard ───────────────────────────────────────────────────────────────

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

/** True for loopback, private, link-local, CGNAT, ULA, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Private(ip);
  if (v !== 6) return true;
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return (
    s === "::" ||
    s === "::1" ||
    s.startsWith("fc") ||
    s.startsWith("fd") ||
    s.startsWith("fe8") ||
    s.startsWith("fe9") ||
    s.startsWith("fea") ||
    s.startsWith("feb") ||
    s.startsWith("ff") ||
    s.startsWith("64:ff9b:") ||
    s.startsWith("2001:db8")
  );
}

async function defaultLookup(host: string): Promise<LookupAddress[]> {
  return lookup(host, { all: true, verbatim: true });
}

/**
 * Throws unless `url` is http(s) on a host that resolves only to public IPs.
 * (A DNS-rebinding race between this check and fetch's own lookup remains;
 * acceptable for read-only GETs of public business pages.)
 */
export async function assertPublicUrl(url: URL, deps: LeadgenDeps): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`blocked scheme ${url.protocol}`);
  if (url.username || url.password) throw new Error("blocked credentials in URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal"))
    throw new Error(`blocked host ${host}`);
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`blocked private address ${host}`);
    return;
  }
  const addrs = await (deps.lookupHost ?? defaultLookup)(host);
  if (!addrs.length) throw new Error(`no address for ${host}`);
  for (const a of addrs)
    if (isPrivateAddress(a.address)) throw new Error(`blocked private address for ${host}`);
}

// ── Per-host politeness ──────────────────────────────────────────────────────

const hostNextAt = new Map<string, number>();

async function waitForHost(host: string, deps: LeadgenDeps): Promise<void> {
  const gap = deps.hostIntervalMs ?? 1_000;
  const now = (deps.now ?? Date.now)();
  const at = Math.max(now, hostNextAt.get(host) ?? 0);
  hostNextAt.set(host, at + gap);
  if (at > now) await depSleep(deps)(at - now);
}

// ── Body reading with a size cap ─────────────────────────────────────────────

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) throw new Error(`body too large (${len} bytes)`);
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("body exceeds size cap");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type PageResult = { url: string; status: number; contentType: string; body: string };

/**
 * GET a public page: SSRF-checked on every redirect hop, host-spaced,
 * timeout + size capped. Does not consult robots (see `politeGet`).
 */
export async function guardedGet(
  rawUrl: string,
  deps: LeadgenDeps,
  accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
): Promise<PageResult> {
  let url = new URL(rawUrl);
  const f = depFetch(deps);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url, deps);
    await waitForHost(url.host, deps);
    const res = await f(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": LEADGEN_USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new Error(`redirect without location (${res.status})`);
      url = new URL(loc, url);
      continue;
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { url: url.toString(), status: res.status, contentType, body: "" };
    }
    const body = await readCapped(res, MAX_PAGE_BYTES);
    return { url: url.toString(), status: res.status, contentType, body };
  }
  throw new Error("too many redirects");
}

// ── robots.txt ───────────────────────────────────────────────────────────────

export type RobotsRules = { allow: string[]; disallow: string[]; disallowAll?: boolean };

/**
 * Parse robots.txt and return the rule group for our token, falling back to
 * `*`. Only Allow/Disallow are honoured (with `*` and `$` wildcards).
 */
export function parseRobots(text: string, token = LEADGEN_ROBOTS_TOKEN): RobotsRules {
  type Group = { agents: string[]; allow: string[]; disallow: string[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], allow: [], disallow: [] };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === "disallow" && val) cur.disallow.push(val);
    else if (key === "allow" && val) cur.allow.push(val);
  }
  const t = token.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    allow: chosen.flatMap((g) => g.allow),
    disallow: chosen.flatMap((g) => g.disallow),
  };
}

function ruleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = body
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

/** Longest-match wins; Allow wins ties (RFC 9309). */
export function robotsAllows(rules: RobotsRules, pathWithQuery: string): boolean {
  if (rules.disallowAll) return false;
  let best = -1;
  let allowed = true;
  for (const r of rules.disallow)
    if (ruleMatches(r, pathWithQuery) && r.length > best) {
      best = r.length;
      allowed = false;
    }
  for (const r of rules.allow)
    if (ruleMatches(r, pathWithQuery) && r.length >= best) {
      best = r.length;
      allowed = true;
    }
  return allowed;
}

const robotsCache = new Map<string, { at: number; rules: RobotsRules }>();
const ROBOTS_TTL_MS = 60 * 60 * 1000;

export async function robotsFor(origin: string, deps: LeadgenDeps): Promise<RobotsRules> {
  const now = (deps.now ?? Date.now)();
  const hit = robotsCache.get(origin);
  if (hit && now - hit.at < ROBOTS_TTL_MS) return hit.rules;
  let rules: RobotsRules;
  try {
    const res = await guardedGet(`${origin}/robots.txt`, deps, "text/plain,*/*;q=0.5");
    if (res.status >= 500) rules = { allow: [], disallow: [], disallowAll: true };
    else if (res.status >= 400 || !res.body) rules = { allow: [], disallow: [] };
    else rules = parseRobots(res.body);
  } catch {
    // Unreachable robots.txt: the page fetch will fail the same way, so allow.
    rules = { allow: [], disallow: [] };
  }
  robotsCache.set(origin, { at: now, rules });
  return rules;
}

/** GET a page only if robots.txt allows it. Returns null when disallowed. */
export async function politeGet(rawUrl: string, deps: LeadgenDeps): Promise<PageResult | null> {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const rules = await robotsFor(u.origin, deps);
  if (!robotsAllows(rules, `${u.pathname}${u.search}`)) return null;
  return guardedGet(u.toString(), deps);
}

// ── JSON API helper (known provider endpoints, no SSRF guard) ───────────────

export async function jsonRequest<T>(
  f: typeof fetch,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null; text: string }> {
  const { timeoutMs, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", LEADGEN_USER_AGENT);
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  const res = await f(url, {
    ...rest,
    headers,
    signal: AbortSignal.timeout(timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

/** Reset module caches (tests). */
export function resetHttpState(): void {
  hostNextAt.clear();
  robotsCache.clear();
}
