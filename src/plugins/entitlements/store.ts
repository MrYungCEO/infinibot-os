/**
 * KinglyVault plugin entitlements on this install: the signed token, its
 * on-disk cache, offline grace and refresh.
 *
 * Token = RS256 JWT signed by KinglyVault (edge function
 * `infinibot-entitlements`) with the licence key; verified here against the
 * embedded public key (./kinglyvault-key.ts). Claims:
 *
 *   { iss: "kinglyvault", aud: "infinibot-plugins", sub, email?, iat, exp, jti,
 *     link?: "<device link id>",
 *     ent: [{ p: "<plugin id>" | "*", src: "purchase" | "plan:ceo" | …, until: <epoch s> | null }] }
 *
 * `p: "*"` (a plan that includes every paid first-party plugin) never unlocks
 * a third-party plugin.
 *
 * Offline grace: a token is good until `exp` (KinglyVault issues ~14 days and
 * the gateway refreshes every 12 h). If it cannot be refreshed, plugins keep
 * working for GRACE_MS after `exp`, then lock. A revoked device link (401/403/
 * 410 from KinglyVault) locks immediately. An entitlement's own `until` (a
 * lapsed subscription) is a hard end; grace does not extend it.
 *
 * Cache file: <shared state dir>/plugin-entitlements.json (0600). Holds the
 * token and the device refresh token; never logged.
 */
import { createHash, createVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSharedDir } from "../../config/paths.js";
import { KINGLYVAULT_PLAN_LICENSE_PUBLIC_KEY, KINGLYVAULT_PUBLIC_KEY } from "./kinglyvault-key.js";
import { ownerGrantEntitlement, ownerGrantStamp, ownerGrantSummary } from "./owner-grant.js";
import { coerceString } from "../../shared/text/coerce.js";

export const ENTITLEMENT_AUDIENCE = "infinibot-plugins";
/** Audience of a KinglyVault PLAN licence (license-jwt), not a plugin token. */
export const PLAN_LICENSE_AUDIENCE = "infinibot";
/** Plans whose licence includes every paid first-party plugin. */
const ALL_PLUGIN_PLANS = new Set(["ceo", "vip", "gold", "owner"]);
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_EVERY_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_KINGLYVAULT_URL = "https://kinglyvault.com";
export const DEFAULT_ENTITLEMENTS_API =
  "https://cxwswtnpmjuftqmaqzae.supabase.co/functions/v1/infinibot-entitlements";

export type EntitlementItem = { p: string; src: string; until: number | null };

export type EntitlementClaims = {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  iat: number;
  exp: number;
  jti?: string;
  link?: string;
  ent: EntitlementItem[];
};

export type VerifyOutcome =
  | { ok: true; claims: EntitlementClaims }
  | { ok: false; reason: "malformed" | "bad-signature" | "wrong-issuer" | "wrong-audience" };

let publicKeyOverride: string | null = null;
let planKeyOverride: string | null = null;
/** Tests only: verify against a throwaway key. */
export function __setEntitlementPublicKeyForTests(pem: string | null): void {
  publicKeyOverride = pem;
  memo = null;
}
/** Tests only: verify plan licences against a throwaway key. */
export function __setPlanLicensePublicKeyForTests(pem: string | null): void {
  planKeyOverride = pem;
  memo = null;
}

function rsaVerify(signingInput: string, sig: Buffer, pem: string): boolean {
  try {
    const v = createVerify("RSA-SHA256");
    v.update(signingInput);
    v.end();
    return v.verify(pem, sig);
  } catch {
    return false;
  }
}

function b64urlDecode(seg: string): Buffer {
  const pad = seg.length % 4 === 0 ? "" : "=".repeat(4 - (seg.length % 4));
  return Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * Signature + issuer + audience + shape. Expiry is NOT checked here (the
 * caller applies exp and offline grace).
 */
export function verifyEntitlementToken(
  token: unknown,
  audience: string = ENTITLEMENT_AUDIENCE,
): VerifyOutcome {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!header || (header as { alg?: unknown }).alg !== "RS256") {
    return { ok: false, reason: "bad-signature" };
  }
  const c = payload as (Partial<EntitlementClaims> & { plan?: unknown }) | null;
  if (!c || typeof c !== "object") return { ok: false, reason: "malformed" };
  const signingInput = `${parts[0]}.${parts[1]}`;
  const sig = b64urlDecode(parts[2]);
  // A KinglyVault PLAN licence (license-jwt: { aud: "infinibot", plan }) for
  // the plugin gate: signed with the plan-licence key; a CEO/VIP plan becomes
  // the plan-wide "*" entitlement, any other plan unlocks nothing.
  if (audience === ENTITLEMENT_AUDIENCE && c.aud === PLAN_LICENSE_AUDIENCE) {
    if (!rsaVerify(signingInput, sig, planKeyOverride ?? KINGLYVAULT_PLAN_LICENSE_PUBLIC_KEY)) {
      return { ok: false, reason: "bad-signature" };
    }
    if (c.iss !== "kinglyvault") return { ok: false, reason: "wrong-issuer" };
    if (typeof c.exp !== "number" || typeof c.sub !== "string") {
      return { ok: false, reason: "malformed" };
    }
    const plan = typeof c.plan === "string" ? c.plan.toLowerCase() : "";
    return {
      ok: true,
      claims: {
        iss: c.iss,
        aud: c.aud,
        sub: c.sub,
        email: typeof c.email === "string" ? c.email : undefined,
        iat: typeof c.iat === "number" ? c.iat : 0,
        exp: c.exp,
        jti: typeof c.jti === "string" ? c.jti : undefined,
        ent: ALL_PLUGIN_PLANS.has(plan) ? [{ p: "*", src: `plan:${plan}`, until: null }] : [],
      },
    };
  }
  if (!rsaVerify(signingInput, sig, publicKeyOverride ?? KINGLYVAULT_PUBLIC_KEY)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (c.iss !== "kinglyvault") return { ok: false, reason: "wrong-issuer" };
  if (c.aud !== audience) return { ok: false, reason: "wrong-audience" };
  if (typeof c.exp !== "number" || typeof c.sub !== "string" || !Array.isArray(c.ent)) {
    return { ok: false, reason: "malformed" };
  }
  const ent = c.ent
    .filter((e): e is EntitlementItem => Boolean(e) && typeof e.p === "string")
    .map((e) => ({
      p: e.p,
      src: typeof e.src === "string" ? e.src : "purchase",
      until: typeof e.until === "number" ? e.until : null,
    }));
  return {
    ok: true,
    claims: {
      iss: c.iss,
      aud: c.aud,
      sub: c.sub,
      email: typeof c.email === "string" ? c.email : undefined,
      iat: typeof c.iat === "number" ? c.iat : 0,
      exp: c.exp,
      jti: typeof c.jti === "string" ? c.jti : undefined,
      link: typeof c.link === "string" ? c.link : undefined,
      ent,
    },
  };
}

export type EntitlementFile = {
  version: 1;
  token: string | null;
  refreshToken?: string | null;
  apiUrl?: string | null;
  /** Last time KinglyVault handed us a fresh token (ms). */
  verifiedAt?: number | null;
  lastRefreshAt?: number | null;
  lastError?: string | null;
};

export function entitlementFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "plugin-entitlements.json");
}

let memo: { file: string; mtimeMs: number; data: EntitlementFile } | null = null;

export function readEntitlementFile(env: NodeJS.ProcessEnv = process.env): EntitlementFile {
  const file = entitlementFilePath(env);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { version: 1, token: null };
  }
  if (memo && memo.file === file && memo.mtimeMs === st.mtimeMs) return memo.data;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<EntitlementFile>;
    const data: EntitlementFile = {
      version: 1,
      token: typeof raw.token === "string" ? raw.token : null,
      refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : null,
      apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl : null,
      verifiedAt: typeof raw.verifiedAt === "number" ? raw.verifiedAt : null,
      lastRefreshAt: typeof raw.lastRefreshAt === "number" ? raw.lastRefreshAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : null,
    };
    memo = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return { version: 1, token: null };
  }
}

export function writeEntitlementFile(data: EntitlementFile, env: NodeJS.ProcessEnv = process.env) {
  const file = entitlementFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  memo = null;
}

export type TokenState =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "valid"; claims: EntitlementClaims }
  | { state: "grace"; claims: EntitlementClaims; graceEndsAt: number }
  | { state: "expired"; claims: EntitlementClaims };

export function tokenState(token: string | null | undefined, now = Date.now()): TokenState {
  if (!token) return { state: "none" };
  const v = verifyEntitlementToken(token);
  if (!v.ok) return { state: "invalid", reason: v.reason };
  const expMs = v.claims.exp * 1000;
  if (now < expMs) return { state: "valid", claims: v.claims };
  if (now < expMs + GRACE_MS)
    return { state: "grace", claims: v.claims, graceEndsAt: expMs + GRACE_MS };
  return { state: "expired", claims: v.claims };
}

export type PluginEntitlement =
  | { state: "none" }
  | { state: "valid"; source: string; until: string | null }
  | { state: "grace"; source: string; until: string | null; graceEndsAt: string }
  | { state: "expired"; why?: string };

export type EntitlementLookup = (
  id: string,
  now?: number,
  opts?: { wildcard?: boolean },
) => PluginEntitlement;

/**
 * The entitlement for one plugin: the signed owner grant for this machine
 * (./owner-grant.ts) first, else the cached KinglyVault token.
 */
export const entitlementFor: EntitlementLookup = (id, now = Date.now(), opts = {}) => {
  const owner = ownerGrantEntitlement(id, now, opts.wildcard !== false);
  if (owner) return owner;
  const ts = tokenState(readEntitlementFile().token, now);
  return entitlementFromState(ts, id, now, opts.wildcard !== false);
};

export function entitlementFromState(
  ts: TokenState,
  id: string,
  now: number,
  wildcard: boolean,
): PluginEntitlement {
  if (ts.state === "none" || ts.state === "invalid") return { state: "none" };
  const items = ts.claims.ent.filter((e) => e.p === id || (wildcard && e.p === "*"));
  if (items.length === 0) return { state: "none" };
  const live = items.filter((e) => e.until === null || e.until * 1000 > now);
  if (live.length === 0) {
    const last = Math.max(...items.map((e) => e.until ?? 0));
    return {
      state: "expired",
      why: `Your access to this plugin ended on ${new Date(last * 1000).toISOString().slice(0, 10)}.`,
    };
  }
  // Prefer a direct purchase over a plan, and an unlimited item over a dated one.
  live.sort((a, b) => {
    const pa = a.p === id ? 0 : 1;
    const pb = b.p === id ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (b.until ?? Infinity) - (a.until ?? Infinity);
  });
  const best = live[0];
  const until = best.until === null ? null : new Date(best.until * 1000).toISOString();
  if (ts.state === "expired") return { state: "expired" };
  if (ts.state === "grace") {
    return {
      state: "grace",
      source: best.src,
      until,
      graceEndsAt: new Date(ts.graceEndsAt).toISOString(),
    };
  }
  return { state: "valid", source: best.src, until };
}

// ── Account summary (Plugins › Purchases) ───────────────────────────────────

export type EntitlementSummary = {
  linked: boolean;
  state: TokenState["state"];
  account: { id: string; email: string | null } | null;
  items: Array<{ pluginId: string; source: string; until: string | null; active: boolean }>;
  expiresAt: string | null;
  graceEndsAt: string | null;
  verifiedAt: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
  canRefresh: boolean;
  invalidReason?: string;
  /** The owner/admin grant for this machine (./owner-grant.ts), when present. */
  ownerGrant: ReturnType<typeof ownerGrantSummary>;
};

export function entitlementSummary(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): EntitlementSummary {
  const file = readEntitlementFile(env);
  const ts = tokenState(file.token, now);
  const claims = "claims" in ts ? ts.claims : null;
  const iso = (ms: number | null | undefined) =>
    typeof ms === "number" ? new Date(ms).toISOString() : null;
  return {
    linked: Boolean(file.token),
    state: ts.state,
    account: claims ? { id: claims.sub, email: claims.email ?? null } : null,
    items: (claims?.ent ?? []).map((e) => ({
      pluginId: e.p,
      source: e.src,
      until: e.until === null ? null : new Date(e.until * 1000).toISOString(),
      active: e.until === null || e.until * 1000 > now,
    })),
    expiresAt: claims ? new Date(claims.exp * 1000).toISOString() : null,
    graceEndsAt: claims ? new Date(claims.exp * 1000 + GRACE_MS).toISOString() : null,
    verifiedAt: iso(file.verifiedAt),
    lastRefreshAt: iso(file.lastRefreshAt),
    lastError: file.lastError ?? null,
    canRefresh: Boolean(file.refreshToken),
    ...(ts.state === "invalid" ? { invalidReason: ts.reason } : {}),
    ownerGrant: ownerGrantSummary(now, env),
  };
}

// ── Import / refresh / unlink ───────────────────────────────────────────────

export function kinglyVaultWebUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.INFINIBOT_KINGLYVAULT_URL?.trim() || DEFAULT_KINGLYVAULT_URL).replace(/\/+$/, "");
}

export function entitlementsApiUrl(
  file?: EntitlementFile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.INFINIBOT_KINGLYVAULT_ENTITLEMENTS_API?.trim() || file?.apiUrl || DEFAULT_ENTITLEMENTS_API
  );
}

/** Ids whose unlock state differs between two tokens (for "restart needed"). */
export function changedPluginIds(
  before: string | null,
  after: string | null,
  now = Date.now(),
): string[] {
  const ids = (t: string | null) => {
    const ts = tokenState(t, now);
    if (ts.state !== "valid" && ts.state !== "grace") return new Set<string>();
    return new Set(
      ts.claims.ent.filter((e) => e.until === null || e.until * 1000 > now).map((e) => e.p),
    );
  };
  const a = ids(before);
  const b = ids(after);
  return [...new Set([...a, ...b])].filter((p) => a.has(p) !== b.has(p)).sort();
}

export type ImportResult =
  | { ok: true; changed: string[]; summary: EntitlementSummary }
  | { ok: false; error: string };

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}/;

/**
 * The token inside whatever the member pasted or picked: a bare JWT, a JSON
 * file/envelope ({ token | license | licenseKey | jwt | entitlementToken }),
 * or text with a JWT in it (quotes, "Bearer ", line breaks).
 */
export function extractEntitlementToken(raw: unknown): {
  token: string | null;
  refreshToken?: string;
  apiUrl?: string;
} {
  if (typeof raw !== "string") return { token: null };
  const text = raw.trim();
  if (!text) return { token: null };
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      for (const k of [
        "token",
        "entitlementToken",
        "license",
        "licenseKey",
        "licence",
        "jwt",
        "key",
      ]) {
        const v = o[k];
        if (typeof v === "string" && JWT_RE.test(v)) {
          return {
            token: JWT_RE.exec(v)![0],
            refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : undefined,
            apiUrl: typeof o.apiUrl === "string" ? o.apiUrl : undefined,
          };
        }
      }
    } catch {
      // not JSON: fall through to the plain-text scan
    }
  }
  const m = JWT_RE.exec(text.replace(/\s+/g, ""));
  return { token: m ? m[0] : null };
}

const REJECT_COPY: Record<string, string> = {
  "bad-signature":
    "it isn't signed by KinglyVault (copy the key again from your KinglyVault account, or use Connect KinglyVault)",
  "wrong-audience": "it's a different kind of KinglyVault key, not a plugin licence",
  "wrong-issuer": "it wasn't issued by KinglyVault",
  malformed: "it isn't a KinglyVault key",
};

export function importEntitlementToken(
  params: { token: unknown; refreshToken?: unknown; apiUrl?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): ImportResult {
  const found = extractEntitlementToken(params.token);
  const ts = tokenState(found.token, now);
  if (ts.state === "none") return { ok: false, error: "missing entitlement token" };
  if (ts.state === "invalid") {
    return {
      ok: false,
      error: `KinglyVault entitlement rejected (${ts.reason}): ${REJECT_COPY[ts.reason] ?? ts.reason}`,
    };
  }
  if (ts.state === "expired") return { ok: false, error: "KinglyVault entitlement has expired" };
  const before = readEntitlementFile(env);
  const token = found.token as string;
  if (params.refreshToken === undefined && found.refreshToken)
    params = { ...params, refreshToken: found.refreshToken };
  if (params.apiUrl === undefined && found.apiUrl) params = { ...params, apiUrl: found.apiUrl };
  const apiUrl =
    typeof params.apiUrl === "string" && /^https?:\/\//.test(params.apiUrl)
      ? params.apiUrl
      : before.apiUrl;
  writeEntitlementFile(
    {
      version: 1,
      token,
      refreshToken:
        typeof params.refreshToken === "string" && params.refreshToken.trim()
          ? params.refreshToken.trim()
          : (before.refreshToken ?? null),
      apiUrl: apiUrl ?? null,
      verifiedAt: now,
      lastRefreshAt: now,
      lastError: null,
    },
    env,
  );
  return {
    ok: true,
    changed: changedPluginIds(before.token, token, now),
    summary: entitlementSummary(now, env),
  };
}

export function unlinkEntitlements(env: NodeJS.ProcessEnv = process.env): { changed: string[] } {
  const before = readEntitlementFile(env);
  try {
    fs.rmSync(entitlementFilePath(env), { force: true });
  } catch {
    // already gone
  }
  memo = null;
  return { changed: changedPluginIds(before.token, null) };
}

export type RefreshResult =
  | { ok: true; changed: string[]; summary: EntitlementSummary }
  | { ok: false; error: string; revoked?: boolean; summary: EntitlementSummary };

/**
 * Ask KinglyVault for a fresh token with the device refresh token. Network
 * trouble keeps the cached token (grace); a revoked link drops it.
 */
export async function refreshEntitlements(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RefreshResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const file = readEntitlementFile(env);
  if (!file.refreshToken) {
    return {
      ok: false,
      error: "not linked to KinglyVault",
      summary: entitlementSummary(now(), env),
    };
  }
  const record = (patch: Partial<EntitlementFile>) =>
    writeEntitlementFile({ ...file, ...patch, lastRefreshAt: now() }, env);
  let res: Response;
  try {
    res = await fetchImpl(entitlementsApiUrl(file, env), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh", refreshToken: file.refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const msg = `KinglyVault unreachable: ${String((err as Error)?.message ?? err)}`;
    record({ lastError: msg });
    return { ok: false, error: msg, summary: entitlementSummary(now(), env) };
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (res.status === 401 || res.status === 403 || res.status === 410) {
    const msg = `KinglyVault revoked this device link (${coerceString(body.error ?? res.status)})`;
    writeEntitlementFile(
      {
        version: 1,
        token: null,
        refreshToken: null,
        apiUrl: file.apiUrl,
        lastRefreshAt: now(),
        lastError: msg,
      },
      env,
    );
    return {
      ok: false,
      error: msg,
      revoked: true,
      summary: entitlementSummary(now(), env),
    };
  }
  if (!res.ok || typeof body.token !== "string") {
    const msg = `KinglyVault refresh failed (${res.status}${body.error ? `: ${coerceString(body.error)}` : ""})`;
    record({ lastError: msg });
    return { ok: false, error: msg, summary: entitlementSummary(now(), env) };
  }
  const ts = tokenState(body.token, now());
  if (ts.state !== "valid") {
    const msg = `KinglyVault returned an unusable token (${ts.state === "invalid" ? ts.reason : ts.state})`;
    record({ lastError: msg });
    return { ok: false, error: msg, summary: entitlementSummary(now(), env) };
  }
  writeEntitlementFile(
    {
      version: 1,
      token: body.token,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : file.refreshToken,
      apiUrl: file.apiUrl,
      verifiedAt: now(),
      lastRefreshAt: now(),
      lastError: null,
    },
    env,
  );
  return {
    ok: true,
    changed: changedPluginIds(file.token, body.token, now()),
    summary: entitlementSummary(now(), env),
  };
}

/**
 * Changes whenever what the entitlement gate would decide can change (new
 * token, or the cached one crossing exp / the grace end). Part of the
 * plugin loader's registry cache key, so a restart after a purchase reloads.
 */
export function entitlementCacheStamp(
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = readEntitlementFile(env);
  const owner = ownerGrantStamp(now, env);
  if (!file.token) return `none:${owner}`;
  const digest = createHash("sha256").update(file.token).digest("hex").slice(0, 16);
  return `${digest}:${tokenState(file.token, now).state}:${owner}`;
}

/** True when the cached token is due a refresh. */
export function refreshDue(now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  const file = readEntitlementFile(env);
  if (!file.refreshToken) return false;
  const last = file.lastRefreshAt ?? 0;
  return now - last >= REFRESH_EVERY_MS;
}
