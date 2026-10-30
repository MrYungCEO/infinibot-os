/**
 * Single auth checkpoint for the CLI.
 *
 * `ensureValidToken()` is intended to be called from the program-wide
 * preAction hook. It enforces the four lifecycle rules in order:
 *
 *   1. If `INFINIBOT_TOKEN` is set, validate it against the Vault (no
 *      refresh, no save). Used by short-lived CI runners.
 *   2. Otherwise, load the persisted bundle. Missing → throw.
 *   3. If the access token is within 60s of expiry, refresh it. A hard
 *      `invalid_grant` from the Vault clears the bundle and treats the
 *      user as logged out.
 *   4. Hit `/cli-token-validate` at most once per hour per token to catch
 *      server-side revocations. A 401 clears the bundle and throws.
 *
 * The in-memory validate cache is intentionally per-process: the CLI is a
 * short-lived process, so "once per hour" effectively means "once per
 * command unless the user just ran the previous one within the hour".
 */

import crypto from "node:crypto";

import { NotAuthenticatedError } from "./errors.js";
import { clearAuth, loadAuth, saveAuth, type StoredAuth } from "./token-store.js";
import { refreshToken, resolveVaultBaseUrl, validateToken, VaultError } from "./vault-client.js";

const VALIDATE_TTL_MS = 60 * 60 * 1000;
const REFRESH_LEEWAY_MS = 60 * 1000;

type ValidateCacheEntry = { checkedAt: number; ok: boolean };
const validateCache = new Map<string, ValidateCacheEntry>();

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Test-only: clear the per-process validate cache. */
export function __resetValidateCacheForTests(): void {
  validateCache.clear();
}

export type EnsureValidTokenOpts = {
  /** Test seam: override the wall clock. */
  now?: () => number;
};

export async function ensureValidToken(opts: EnsureValidTokenOpts = {}): Promise<StoredAuth> {
  const now = opts.now ?? Date.now;

  const envToken = process.env.INFINIBOT_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return ensureEnvTokenValid(envToken, now);
  }

  let stored = await loadAuth();
  if (!stored) {
    throw new NotAuthenticatedError("No stored Vault credentials.");
  }

  if (stored.expires_at - REFRESH_LEEWAY_MS <= now()) {
    stored = await refreshAndSave(stored, now);
  }

  await validateOncePerHour(stored, now);
  return stored;
}

async function ensureEnvTokenValid(token: string, now: () => number): Promise<StoredAuth> {
  const key = hashToken(token);
  const cached = validateCache.get(key);
  if (!cached || now() - cached.checkedAt > VALIDATE_TTL_MS) {
    try {
      const res = await validateToken(token);
      if (!res.valid) {
        throw new NotAuthenticatedError("INFINIBOT_TOKEN rejected by Vault.");
      }
      validateCache.set(key, { checkedAt: now(), ok: true });
      const base = resolveVaultBaseUrl();
      return {
        access_token: token,
        refresh_token: "",
        expires_at: typeof res.expires_at === "number" ? res.expires_at : now() + VALIDATE_TTL_MS,
        refresh_expires_at: 0,
        tenant_id: res.tenant_id,
        scopes: res.scopes,
        vault_url: base,
        saved_at: now(),
      };
    } catch (err) {
      if (err instanceof VaultError && err.httpStatus === 401) {
        throw new NotAuthenticatedError("INFINIBOT_TOKEN rejected by Vault.");
      }
      throw err;
    }
  }
  // Cache hit — we still need to return something useful. Re-issue a
  // minimal synthetic StoredAuth without contacting the Vault.
  return {
    access_token: token,
    refresh_token: "",
    expires_at: cached.checkedAt + VALIDATE_TTL_MS,
    refresh_expires_at: 0,
    tenant_id: "",
    scopes: [],
    vault_url: resolveVaultBaseUrl(),
    saved_at: cached.checkedAt,
  };
}

async function refreshAndSave(stored: StoredAuth, now: () => number): Promise<StoredAuth> {
  try {
    const tokens = await refreshToken(
      { refresh_token: stored.refresh_token },
      { baseUrl: stored.vault_url },
    );
    const refreshLifetime = tokens.refresh_expires_in ?? Math.max(tokens.expires_in * 12, 86_400);
    const next: StoredAuth = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: now() + tokens.expires_in * 1000,
      refresh_expires_at: now() + refreshLifetime * 1000,
      tenant_id: tokens.tenant_id,
      scopes: tokens.scopes,
      vault_url: stored.vault_url,
      saved_at: now(),
    };
    await saveAuth(next);
    // Invalidate the previous access-token's validate-cache entry.
    validateCache.delete(hashToken(stored.access_token));
    return next;
  } catch (err) {
    if (err instanceof VaultError && err.code === "invalid_grant") {
      await clearAuth();
      throw new NotAuthenticatedError("Refresh token rejected; please sign in again.");
    }
    throw err;
  }
}

async function validateOncePerHour(stored: StoredAuth, now: () => number): Promise<void> {
  const key = hashToken(stored.access_token);
  const cached = validateCache.get(key);
  if (cached && now() - cached.checkedAt <= VALIDATE_TTL_MS) return;
  try {
    const res = await validateToken(stored.access_token, { baseUrl: stored.vault_url });
    if (!res.valid) {
      await clearAuth();
      validateCache.delete(key);
      throw new NotAuthenticatedError("Vault rejected the stored token.");
    }
    validateCache.set(key, { checkedAt: now(), ok: true });
  } catch (err) {
    if (err instanceof VaultError && err.httpStatus === 401) {
      await clearAuth();
      validateCache.delete(key);
      throw new NotAuthenticatedError("Vault rejected the stored token.");
    }
    throw err;
  }
}
