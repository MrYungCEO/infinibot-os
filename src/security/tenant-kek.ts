/**
 * Tenant data-key wrapping with the platform BYOK key-encryption key (KEK).
 *
 * Envelope scheme: a feature keeps its secrets encrypted under its OWN random
 * 32-byte data key (DEK), and stores that DEK only in wrapped form. Wrapping
 * uses the platform KEK, which exists solely as a server secret:
 *
 *   BYOK_KEK           base64 of 32 random bytes (required to wrap)
 *   BYOK_KEK_ID        name of the active key (default "k1")
 *   BYOK_KEK_PREVIOUS  "<id>:<base64>,…" older keys that may still unwrap
 *
 * This is the same env contract as the cloud surface's BYOK store
 * (feat/cloud-serverless src/saas/cloud/crypto.ts), so one Fly/Netlify secret
 * serves both. The AAD binds a wrapped key to its tenant and purpose, so a
 * wrapped DEK copied to another tenant (or another feature) will not open.
 *
 * The KEK never leaves this module: callers get wrap/unwrap, never the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { platformSecret } from "../saas/config.js";

export interface WrappedDataKey {
  v: 1;
  alg: "aes-256-gcm";
  kekId: string;
  iv: string;
  tag: string;
  data: string;
}

function decodeKek(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`${label} must be base64 of exactly 32 bytes`);
  }
  return key;
}

/**
 * On a fleet tenant Machine the KEK is sealed out of process.env at boot
 * (sealPlatformSecrets) so children never inherit it; read it from the seal
 * when the caller uses the live environment.
 */
function kekVar(env: NodeJS.ProcessEnv, key: "BYOK_KEK" | "BYOK_KEK_PREVIOUS"): string | undefined {
  return env === process.env ? platformSecret(key) : env[key];
}

function activeKek(env: NodeJS.ProcessEnv): { id: string; key: Buffer } {
  const raw = kekVar(env, "BYOK_KEK")?.trim();
  if (!raw) throw new Error("BYOK_KEK is not configured: tenant secrets cannot be stored");
  return { id: env.BYOK_KEK_ID?.trim() || "k1", key: decodeKek(raw, "BYOK_KEK") };
}

function kekById(id: string, env: NodeJS.ProcessEnv): Buffer {
  const active = activeKek(env);
  if (active.id === id) return active.key;
  for (const pair of (kekVar(env, "BYOK_KEK_PREVIOUS") ?? "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0 && pair.slice(0, i).trim() === id) {
      return decodeKek(pair.slice(i + 1), `BYOK_KEK_PREVIOUS[${id}]`);
    }
  }
  throw new Error(`no key-encryption key for id "${id}"`);
}

function aad(tenantId: string, purpose: string): Buffer {
  if (!tenantId || !purpose) throw new Error("tenant id and purpose are required");
  return Buffer.from(`tenant:${tenantId}|purpose:${purpose}`, "utf8");
}

/** Is a well-formed KEK present? Never reveals it. */
export function tenantKekConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    activeKek(env);
    return true;
  } catch {
    return false;
  }
}

/** Wrap a data key for `tenantId` + `purpose` with the active KEK. */
export function wrapTenantDataKey(
  dataKey: Uint8Array,
  tenantId: string,
  purpose: string,
  env: NodeJS.ProcessEnv = process.env,
): WrappedDataKey {
  if (dataKey.length !== 32) throw new Error("data key must be 32 bytes");
  const kek = activeKek(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", kek.key, iv);
  cipher.setAAD(aad(tenantId, purpose));
  const data = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    kekId: kek.id,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** Unwrap a data key. Throws on the wrong tenant/purpose, a missing KEK or tampering. */
export function unwrapTenantDataKey(
  wrapped: WrappedDataKey,
  tenantId: string,
  purpose: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  if (!wrapped || wrapped.v !== 1 || wrapped.alg !== "aes-256-gcm") {
    throw new Error("unsupported wrapped key format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    kekById(wrapped.kekId, env),
    Buffer.from(wrapped.iv, "base64"),
  );
  decipher.setAAD(aad(tenantId, purpose));
  decipher.setAuthTag(Buffer.from(wrapped.tag, "base64"));
  const key = Buffer.concat([
    decipher.update(Buffer.from(wrapped.data, "base64")),
    decipher.final(),
  ]);
  if (key.length !== 32) throw new Error("unwrapped data key has the wrong length");
  return key;
}

/** Re-wrap under the currently active KEK (rotation). */
export function rewrapTenantDataKey(
  wrapped: WrappedDataKey,
  tenantId: string,
  purpose: string,
  env: NodeJS.ProcessEnv = process.env,
): WrappedDataKey {
  const key = unwrapTenantDataKey(wrapped, tenantId, purpose, env);
  try {
    return wrapTenantDataKey(key, tenantId, purpose, env);
  } finally {
    key.fill(0);
  }
}
