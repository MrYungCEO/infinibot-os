/**
 * Keeps SESSION cookies (no Expires/Max-Age) across browser restarts.
 *
 * Chrome writes persistent cookies to the profile's Cookies DB, but session
 * cookies only live in memory and are gone when Chrome exits — and most login
 * flows set exactly those. So while a managed profile's Chrome runs we copy its
 * session cookies to `<profile>/session-cookies.json` (0600, next to the
 * Chrome data dir) on a timer and right before a clean stop, and put them back
 * right after the next launch. The secure profile never uses this.
 */
import fs from "node:fs";
import path from "node:path";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CdpSendFn } from "../cdp.helpers.js";

const log = createSubsystemLogger("browser").child("session-cookies");
const FILE = "session-cookies.json";
export const SESSION_COOKIE_BACKUP_INTERVAL_MS = 30_000;

export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  priority?: string;
  sameParty?: boolean;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
};

export function sessionCookieFile(userDataDir: string): string {
  return path.join(path.dirname(userDataDir), FILE);
}

/** Cookies worth carrying: session-only ones (persistent ones are on disk). */
export function pickSessionCookies(cookies: CdpCookie[]): CdpCookie[] {
  return cookies.filter((c) => c.session === true || c.expires === -1);
}

/** CDP Storage.setCookies params for saved cookies (drops read-only fields). */
export function toSetCookieParams(cookies: CdpCookie[]): Array<Record<string, unknown>> {
  return cookies.map((c) => {
    const out: Record<string, unknown> = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
    };
    if (c.sameSite) out.sameSite = c.sameSite;
    if (c.priority) out.priority = c.priority;
    if (c.sourceScheme) out.sourceScheme = c.sourceScheme;
    if (typeof c.sourcePort === "number") out.sourcePort = c.sourcePort;
    return out;
  });
}

export async function backupSessionCookies(send: CdpSendFn, userDataDir: string): Promise<number> {
  const res = (await send("Storage.getCookies")) as { cookies?: CdpCookie[] } | undefined;
  const picked = pickSessionCookies(res?.cookies ?? []);
  const file = sessionCookieFile(userDataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies: picked }), {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  return picked.length;
}

export function readSavedSessionCookies(userDataDir: string): CdpCookie[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionCookieFile(userDataDir), "utf8")) as {
      cookies?: CdpCookie[];
    };
    return Array.isArray(parsed.cookies) ? parsed.cookies : [];
  } catch {
    return [];
  }
}

export async function restoreSessionCookies(send: CdpSendFn, userDataDir: string): Promise<number> {
  const saved = readSavedSessionCookies(userDataDir);
  if (!saved.length) return 0;
  try {
    await send("Storage.setCookies", { cookies: toSetCookieParams(saved) });
    return saved.length;
  } catch (err) {
    log.warn(`restore failed: ${String(err)}`);
    return 0;
  }
}

export function clearSavedSessionCookies(userDataDir: string, domain?: string): void {
  const file = sessionCookieFile(userDataDir);
  if (!domain) {
    fs.rmSync(file, { force: true });
    return;
  }
  const kept = readSavedSessionCookies(userDataDir).filter((c) => !cookieMatchesSite(c, domain));
  if (!fs.existsSync(file)) return;
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: kept }), {
    mode: 0o600,
  });
}

/** "github.com" matches cookies for github.com and .github.com and sub.github.com. */
export function cookieMatchesSite(cookie: { domain: string }, site: string): boolean {
  const d = cookie.domain.replace(/^\./, "").toLowerCase();
  const s = site.replace(/^\./, "").toLowerCase();
  return d === s || d.endsWith(`.${s}`);
}
