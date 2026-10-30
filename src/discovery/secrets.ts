/**
 * Discovery secrets store — Netlify personal access token.
 *
 * Lives at `${stateDir}/secrets/netlify.json` with chmod 0600 so other
 * users on the box can't read it. We never round-trip the token through
 * the UI after save — the UI only reads `connected: true/false` and the
 * last 4 chars for display.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";

interface NetlifySecretsFile {
  token: string;
  /** Optional account slug — used to scope `GET /sites` so we don't enumerate every site the token can see. */
  accountSlug?: string;
  /** Optional site prefix when creating new sites (e.g. "tws-"). */
  sitePrefix?: string;
  updatedAt: number;
}

function secretsPath(stateDir: string): string {
  return join(stateDir, "secrets", "netlify.json");
}

function ensureDir(stateDir: string): void {
  const dir = join(stateDir, "secrets");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function getNetlifyToken(stateDir: string): string | null {
  const path = secretsPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as NetlifySecretsFile;
    return data.token || null;
  } catch {
    return null;
  }
}

export function readNetlifySecrets(stateDir: string): NetlifySecretsFile | null {
  const path = secretsPath(stateDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as NetlifySecretsFile;
  } catch {
    return null;
  }
}

export function writeNetlifySecrets(
  stateDir: string,
  patch: Partial<Omit<NetlifySecretsFile, "updatedAt">>,
): NetlifySecretsFile {
  ensureDir(stateDir);
  const path = secretsPath(stateDir);
  const existing = readNetlifySecrets(stateDir);
  const merged: NetlifySecretsFile = {
    token: patch.token ?? existing?.token ?? "",
    accountSlug: patch.accountSlug ?? existing?.accountSlug,
    sitePrefix: patch.sitePrefix ?? existing?.sitePrefix,
    updatedAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(merged, null, 2), "utf-8");
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort */
  }
  return merged;
}

export function clearNetlifySecrets(stateDir: string): void {
  const path = secretsPath(stateDir);
  if (existsSync(path)) {
    writeFileSync(path, "{}", "utf-8");
  }
}

/** Status view for the UI — never leaks the full token. */
export function netlifyStatus(stateDir: string): {
  connected: boolean;
  tokenSuffix: string | null;
  accountSlug: string | null;
  sitePrefix: string | null;
  updatedAt: number | null;
} {
  const secrets = readNetlifySecrets(stateDir);
  if (!secrets || !secrets.token) {
    return {
      connected: false,
      tokenSuffix: null,
      accountSlug: null,
      sitePrefix: null,
      updatedAt: null,
    };
  }
  const suffix = secrets.token.slice(-4);
  return {
    connected: true,
    tokenSuffix: suffix,
    accountSlug: secrets.accountSlug ?? null,
    sitePrefix: secrets.sitePrefix ?? null,
    updatedAt: secrets.updatedAt,
  };
}
