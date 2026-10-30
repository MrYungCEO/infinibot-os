/**
 * Instagram credential storage — ~/.infinibot/secrets/instagram.json (mode 0600).
 *
 * Falls back to env vars (INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_APP_ID,
 * INSTAGRAM_APP_SECRET) so existing setups keep working without migration.
 * Never reads from or writes to .env / infinibot.json.
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface InstagramSecrets {
  accessToken: string;
  appId?: string;
  appSecret?: string;
  igBusinessAccountId?: string;
  accountName?: string;
  /** Unix ms timestamp when the long-lived token expires (60 days from issue). */
  tokenExpiresAt?: number;
  lastSyncAt?: number;
  connectedAt?: number;
}

function resolveStateDir(): string {
  return (
    process.env.INFINIBOT_STATE_DIR ??
    process.env.MOLTBOT_STATE_DIR ??
    join(homedir(), ".infinibot")
  );
}

function secretsDir(): string {
  return join(resolveStateDir(), "secrets");
}

function secretsPath(): string {
  return join(secretsDir(), "instagram.json");
}

export function readInstagramSecrets(): InstagramSecrets | null {
  try {
    const raw = readFileSync(secretsPath(), "utf8");
    return JSON.parse(raw) as InstagramSecrets;
  } catch {
    // Fall back to env vars so pre-existing env-based setups keep working.
    const token = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (token) {
      return {
        accessToken: token,
        appId: process.env.INSTAGRAM_APP_ID,
        appSecret: process.env.INSTAGRAM_APP_SECRET,
      };
    }
    return null;
  }
}

export async function writeInstagramSecrets(secrets: InstagramSecrets): Promise<void> {
  const dir = secretsDir();
  mkdirSync(dir, { recursive: true });
  const path = secretsPath();
  writeFileSync(path, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
  // Enforce 0600 even on systems that ignore the mode option.
  await chmod(path, 0o600);
}

export function deleteInstagramSecrets(): boolean {
  try {
    unlinkSync(secretsPath());
    return true;
  } catch {
    return false;
  }
}

/** Convenience: is there a valid (non-expired) token in the secrets file? */
export function isInstagramConnected(): boolean {
  const s = readInstagramSecrets();
  if (!s?.accessToken) return false;
  if (s.tokenExpiresAt && s.tokenExpiresAt < Date.now()) return false;
  return true;
}

/**
 * Days until the stored token expires. Returns null if no expiry is stored.
 * Returns 0 if already expired.
 */
export function tokenDaysRemaining(secrets: InstagramSecrets): number | null {
  if (!secrets.tokenExpiresAt) return null;
  const ms = secrets.tokenExpiresAt - Date.now();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}
