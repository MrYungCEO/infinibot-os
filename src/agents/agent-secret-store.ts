/**
 * Per-agent encrypted secret store.
 *
 * Stores agent-scoped secrets (currently just the outbound Telegram bot token)
 * encrypted at rest with AES-256-GCM via the shared `secret-crypto` helper. The
 * agent config only ever holds a *reference* of the form
 *
 *     vault://agents/<agentId>/<key>
 *
 * and never the plaintext. Ciphertext lives in `agent-secrets.json` under the
 * state dir, keyed by that reference.
 *
 * Naming note: the "vault://" scheme is a logical pointer convention — it is
 * unrelated to the Discord "Kingly Vault" community module in src/vault/. We
 * reuse the established email-secret crypto (key in ~/.infinibot/infinibot.json
 * under secrets.emailAccountsKey) rather than introducing a second key.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { decryptSecret, encryptSecret } from "../services/email/secret-crypto.js";

const STORE_FILE = "agent-secrets.json";

/** Logical key for the per-agent outbound Telegram bot token secret. */
export const TELEGRAM_BOT_TOKEN_KEY = "telegram-bot-token";

const VAULT_PREFIX = "vault://";

type SecretsFile = Record<string, string>;

type StoreOpts = { stateDir?: string };

function storePath(opts?: StoreOpts): string {
  return join(opts?.stateDir ?? resolveStateDir(), STORE_FILE);
}

function readStore(opts?: StoreOpts): SecretsFile {
  const path = storePath(opts);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as SecretsFile) : {};
  } catch {
    return {};
  }
}

function writeStore(value: SecretsFile, opts?: StoreOpts): void {
  writeFileSync(storePath(opts), JSON.stringify(value, null, 2));
}

/**
 * Build the canonical reference for an agent secret, e.g.
 * `vault://agents/main/telegram-bot-token`.
 */
export function agentSecretRef(agentId: string, key: string): string {
  return `${VAULT_PREFIX}agents/${normalizeAgentId(agentId)}/${key}`;
}

/** True iff `ref` looks like one of our agent-secret references. */
export function isAgentSecretRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(`${VAULT_PREFIX}agents/`);
}

/**
 * Encrypt and persist a secret. Returns the reference to store on the agent
 * config. Pass `null`/empty plaintext to delete the secret (returns the ref so
 * callers can clear the config field uniformly).
 */
export function setAgentSecret(
  ref: string,
  plaintext: string | null | undefined,
  opts?: StoreOpts,
): string {
  const store = readStore(opts);
  if (!plaintext) {
    delete store[ref];
  } else {
    const encrypted = encryptSecret(plaintext);
    if (!encrypted) throw new Error("Failed to encrypt agent secret");
    store[ref] = encrypted;
  }
  writeStore(store, opts);
  return ref;
}

/** Decrypt and return the plaintext for `ref`, or null when absent/unreadable. */
export function getAgentSecret(ref: string | null | undefined, opts?: StoreOpts): string | null {
  if (!ref) return null;
  const blob = readStore(opts)[ref];
  if (!blob) return null;
  return decryptSecret(blob);
}

/** True iff a secret is stored for `ref` (without decrypting it). */
export function hasAgentSecret(ref: string | null | undefined, opts?: StoreOpts): boolean {
  if (!ref) return false;
  return Boolean(readStore(opts)[ref]);
}

/** Remove a stored secret. No-op when absent. */
export function deleteAgentSecret(ref: string | null | undefined, opts?: StoreOpts): void {
  if (!ref) return;
  const store = readStore(opts);
  if (ref in store) {
    delete store[ref];
    writeStore(store, opts);
  }
}
