/**
 * Local persistence for the Kingly Vault CLI token bundle.
 *
 * The bundle lives at `~/.infinibot/auth.json` (overridable via
 * `INFINIBOT_AUTH_FILE` for tests). The file is `chmod 600` to keep the
 * refresh token out of reach of other local users; chmod is silently
 * skipped on win32 where POSIX modes don't apply.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type StoredAuth = {
  access_token: string;
  refresh_token: string;
  /** ms epoch */
  expires_at: number;
  /** ms epoch */
  refresh_expires_at: number;
  tenant_id: string;
  scopes: string[];
  /** Vault base URL we authenticated against — pinned per bundle. */
  vault_url: string;
  /** ms epoch */
  saved_at: number;
};

export function resolveAuthFilePath(): string {
  const override = process.env.INFINIBOT_AUTH_FILE;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), ".infinibot", "auth.json");
}

export async function loadAuth(): Promise<StoredAuth | null> {
  const file = resolveAuthFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredAuth(parsed)) return null;
  return parsed;
}

export async function saveAuth(auth: StoredAuth): Promise<void> {
  const file = resolveAuthFilePath();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const json = JSON.stringify(auth, null, 2);
  await fs.writeFile(file, json, "utf8");
  if (process.platform !== "win32") {
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // Best-effort: filesystems like /tmp on some CI hosts reject chmod.
    }
  }
}

export async function clearAuth(): Promise<void> {
  const file = resolveAuthFilePath();
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function isStoredAuth(value: unknown): value is StoredAuth {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    typeof v.refresh_token === "string" &&
    typeof v.expires_at === "number" &&
    typeof v.refresh_expires_at === "number" &&
    typeof v.tenant_id === "string" &&
    Array.isArray(v.scopes) &&
    v.scopes.every((s) => typeof s === "string") &&
    typeof v.vault_url === "string" &&
    typeof v.saved_at === "number"
  );
}
