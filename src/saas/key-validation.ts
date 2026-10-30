/**
 * BYOK key validation (pure: catalog + fetch, no filesystem or gateway config).
 *
 * Shared by the gateway onboarding RPCs (onboarding.ts) and the stateless cloud
 * Functions (src/cloud), so both surfaces accept exactly the same keys.
 */
import {
  getOnboardingProvider,
  ONBOARDING_STT_PROVIDERS,
  ONBOARDING_VOICE_PROVIDERS,
  type KeyCheck,
} from "./onboarding-catalog.js";

export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// ── Key validation ──────────────────────────────────────────────────────────
//
// Strict: a key is only accepted when the provider authenticates it (see
// KeyCheck in onboarding-catalog.ts). The quickstart fetchers deliberately fall
// back to static lists / public endpoints, which would let a bogus key through.
//
// INFINIBOT_SAAS_PROVIDER_VALIDATE_BASE_URL is a test/staging hook: when set,
// every validation request goes to that origin (same paths) instead of the
// real provider. Operator-controlled env only.

function validationUrl(real: string): string {
  const base = process.env.INFINIBOT_SAAS_PROVIDER_VALIDATE_BASE_URL?.trim();
  if (!base) return real;
  const u = new URL(real);
  return `${base.replace(/\/$/, "")}${u.pathname}${u.search}`;
}

export interface KeyValidation {
  ok: boolean;
  error?: string;
  modelCount?: number;
  /** False when the key was stored without an authenticated check. */
  verified?: boolean;
  /** Display name of the connected account (bot username, workspace, login), when known. */
  account?: string;
}

function countModels(body: unknown, field: string | undefined): number | undefined {
  if (!field) return undefined;
  const arr = field === "*" ? body : (body as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(arr) ? arr.length : undefined;
}

function readPath(body: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], body);
}

export async function runKeyCheck(
  label: string,
  check: KeyCheck,
  key: string,
): Promise<KeyValidation> {
  let res: Response;
  const post = check.kind === "auth-probe" || check.method === "POST";
  try {
    res = await fetch(validationUrl(typeof check.url === "function" ? check.url(key) : check.url), {
      method: post ? "POST" : "GET",
      headers:
        check.kind === "get"
          ? check.headers(key)
          : { ...check.headers(key), "content-type": "application/json" },
      body: check.kind === "get" ? undefined : "{}",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      ok: false,
      // Never echo the URL or the fetch error: some checks carry the key in the URL.
      error: `Couldn't reach ${label}.`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: `${label} rejected this key (HTTP ${res.status}).` };
  }
  if (check.kind === "auth-probe") {
    // Past auth, the empty body is refused as a bad request — the key is good.
    if (res.ok || res.status === 400 || res.status === 422) return { ok: true, verified: true };
    return { ok: false, error: `${label} returned HTTP ${res.status}.` };
  }
  if (res.status === 400) {
    // xAI answers an invalid key with 400 on its models endpoint.
    return { ok: false, error: `${label} rejected this key (HTTP 400).` };
  }
  if (!res.ok) {
    return { ok: false, error: `${label} returned HTTP ${res.status}.` };
  }
  const body = await res.json().catch(() => ({}));
  if (check.okField && readPath(body, check.okField) !== true) {
    return { ok: false, error: `${label} rejected this token.` };
  }
  const account = check.accountField ? readPath(body, check.accountField) : undefined;
  return {
    ok: true,
    verified: true,
    modelCount: countModels(body, check.countField),
    ...(typeof account === "string" && account.trim() ? { account: account.trim() } : {}),
  };
}

export function wellFormed(apiKey: string): boolean {
  const key = apiKey.trim();
  return Boolean(key) && !/\s/.test(key) && key.length >= 8;
}

const VOICE_KEY_SPECS = [...ONBOARDING_VOICE_PROVIDERS, ...ONBOARDING_STT_PROVIDERS].filter(
  (v) => v.needsOwnKey,
);

/** Validate a model-provider key or an own-key voice provider key (elevenlabs/cartesia/deepgram). */
export async function validateProviderKey(
  provider: string,
  apiKey: string,
): Promise<KeyValidation> {
  if (!wellFormed(apiKey)) {
    return { ok: false, error: "That doesn't look like an API key." };
  }
  const key = apiKey.trim();
  const spec = getOnboardingProvider(provider) ?? VOICE_KEY_SPECS.find((v) => v.id === provider);
  if (!spec) return { ok: false, error: `Unsupported provider: ${String(provider)}` };
  if (!spec.check) return { ok: true, verified: false };
  return runKeyCheck(spec.label, spec.check, key);
}
