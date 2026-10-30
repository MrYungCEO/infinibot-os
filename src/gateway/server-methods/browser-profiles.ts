/**
 * browser.profiles.* — view and clear the agents' browser profiles (saved
 * cookies / logins per profile, src/browser/agent/profile-store.ts).
 *
 * Admin scope only (they are not in READ_METHODS) and on a hosted tenant the
 * same owner/admin check as the live browser panel. Cookie VALUES never leave
 * the gateway: the UI only gets site names, counts and expiry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_DEFAULT_PROFILE,
  describeStoredProfile,
  listStoredProfileNames,
  normalizeAgentProfileName,
  SECURE_BROWSER_PROFILE,
} from "../../browser/agent/profile-store.js";
import { managedProfileName, openManagedProfile } from "../../browser/agent/runtime.js";
import {
  clearSavedSessionCookies,
  cookieMatchesSite,
  readSavedSessionCookies,
} from "../../browser/agent/session-cookies.js";
import { isChromeReachable } from "../../browser/chrome.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import { browserViewerAccess } from "../../browser/viewer/access.js";
import { isSaasMode } from "../../saas/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

export type ProfileSite = {
  site: string;
  cookies: number;
  sessionCookies: number;
  /** Latest expiry among the site's cookies (ms epoch), null = session only. */
  expiresAt: number | null;
};

function guard(client: GatewayClient | null, respond: RespondFn): boolean {
  const access = browserViewerAccess({
    saasMode: isSaasMode(),
    role: client?.saasRole,
    scopes: client?.connect?.scopes,
    hasTenant: Boolean(client?.saasTenantId),
  });
  if (!access.allowed) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, access.reason));
    return false;
  }
  return true;
}

function fail(respond: RespondFn, err: unknown) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, err instanceof Error ? err.message : String(err)),
  );
}

function siteOf(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

/** Group cookies (from CDP or the Cookies DB) by site. */
export function groupCookiesBySite(
  rows: Array<{ domain: string; session: boolean; expiresMs: number | null }>,
): ProfileSite[] {
  const bySite = new Map<string, ProfileSite>();
  for (const r of rows) {
    const site = siteOf(r.domain);
    const entry = bySite.get(site) ?? { site, cookies: 0, sessionCookies: 0, expiresAt: null };
    entry.cookies += 1;
    if (r.session) entry.sessionCookies += 1;
    else if (r.expiresMs && (!entry.expiresAt || r.expiresMs > entry.expiresAt))
      entry.expiresAt = r.expiresMs;
    bySite.set(site, entry);
  }
  return [...bySite.values()].sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

async function managedFor(name: string): Promise<string> {
  const state = (await startBrowserControlServiceFromConfig()) ?? getBrowserControlState();
  return state ? managedProfileName(state, name) : name === AGENT_DEFAULT_PROFILE ? "clawd" : name;
}

async function isRunning(managed: string): Promise<boolean> {
  const state = getBrowserControlState();
  const cfg = state?.resolved.profiles[managed];
  if (!state || !cfg?.cdpPort) return false;
  return await isChromeReachable(`http://127.0.0.1:${cfg.cdpPort}`, 400);
}

/** Chrome's Cookies DB, read from a copy (Chrome may hold a lock on it). */
async function readCookieDb(userDataDir: string) {
  const db = ["Default/Cookies", "Default/Network/Cookies"]
    .map((p) => path.join(userDataDir, p))
    .find((p) => fs.existsSync(p));
  if (!db) return [];
  const tmp = path.join(os.tmpdir(), `ib-cookies-${process.pid}-${Date.now()}.db`);
  fs.copyFileSync(db, tmp);
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const conn = new DatabaseSync(tmp, { readOnly: true });
    try {
      const rows = conn
        .prepare(
          "SELECT host_key AS domain, is_persistent AS persistent, expires_utc AS exp FROM cookies",
        )
        .all() as Array<{ domain: string; persistent: number; exp: number | bigint }>;
      return rows.map((r) => ({
        domain: r.domain,
        session: !r.persistent,
        // Chrome time: microseconds since 1601-01-01.
        expiresMs: r.persistent ? Number(BigInt(r.exp) / 1000n) - 11_644_473_600_000 : null,
      }));
    } finally {
      conn.close();
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function profileSites(name: string): Promise<{ running: boolean; sites: ProfileSite[] }> {
  const managed = await managedFor(name);
  const info = describeStoredProfile(name, managed, { withSize: false });
  if (await isRunning(managed)) {
    const h = await openManagedProfile(name);
    const cookies = await h.context.cookies();
    return {
      running: true,
      sites: groupCookiesBySite(
        cookies.map((c) => ({
          domain: c.domain,
          session: c.expires === -1,
          expiresMs: c.expires > 0 ? c.expires * 1000 : null,
        })),
      ),
    };
  }
  const rows = info.exists ? await readCookieDb(info.userDataDir) : [];
  // Session cookies saved by the keeper come back on next launch: show them too.
  for (const c of readSavedSessionCookies(info.userDataDir)) {
    rows.push({ domain: c.domain, session: true, expiresMs: null });
  }
  return { running: false, sites: groupCookiesBySite(rows) };
}

export const browserProfilesHandlers: GatewayRequestHandlers = {
  "browser.profiles.list": async ({ client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const names = [
        AGENT_DEFAULT_PROFILE,
        ...listStoredProfileNames().filter((n) => n !== AGENT_DEFAULT_PROFILE),
      ];
      const profiles = [];
      for (const name of names) {
        const managed = await managedFor(name);
        const info = describeStoredProfile(name, managed);
        let siteCount = 0;
        try {
          siteCount = (await profileSites(name)).sites.length;
        } catch {
          // unreadable cookie store: show the profile anyway
        }
        profiles.push({
          name,
          dir: info.userDataDir,
          exists: info.exists,
          sizeBytes: info.sizeBytes,
          running: await isRunning(managed),
          lockedByOther: info.lockedByOther,
          lockPid: info.lock?.pid ?? null,
          siteCount,
        });
      }
      respond(true, {
        profiles,
        secure: {
          name: SECURE_BROWSER_PROFILE,
          ephemeral: true,
          note: "Secure Mode uses a separate in-memory profile that is wiped when its browser closes.",
        },
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "browser.profiles.sites": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const name = normalizeAgentProfileName(params.profile);
      if (name === SECURE_BROWSER_PROFILE) throw new Error("The secure profile is not listed.");
      respond(true, { profile: name, ...(await profileSites(name)) });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Clear one site's cookies ({profile, site}) or all cookies ({profile, all:true}). */
  "browser.profiles.clear": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const name = normalizeAgentProfileName(params.profile);
      if (name === SECURE_BROWSER_PROFILE)
        throw new Error("The secure profile is wiped automatically.");
      const site = typeof params.site === "string" ? params.site.trim().toLowerCase() : "";
      if (!site && params.all !== true) throw new Error("Pass site, or all:true.");
      const managed = await managedFor(name);
      const info = describeStoredProfile(name, managed, { withSize: false });
      if (info.lockedByOther)
        throw new Error(
          `Profile "${name}" is in use by another InfiniBot process (pid ${info.lock?.pid}).`,
        );
      let removed = 0;
      if (await isRunning(managed)) {
        const h = await openManagedProfile(name);
        const before = await h.context.cookies();
        const doomed = site ? before.filter((c) => cookieMatchesSite(c, site)) : before;
        removed = doomed.length;
        if (site) {
          for (const c of doomed)
            await h.context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        } else {
          await h.context.clearCookies();
        }
      } else if (info.exists) {
        const db = ["Default/Cookies", "Default/Network/Cookies"]
          .map((p) => path.join(info.userDataDir, p))
          .find((p) => fs.existsSync(p));
        if (db) {
          const { DatabaseSync } = await import("node:sqlite");
          const conn = new DatabaseSync(db);
          try {
            const res = site
              ? conn
                  .prepare(
                    "DELETE FROM cookies WHERE host_key = ? OR host_key = ? OR host_key LIKE ?",
                  )
                  .run(site, `.${site}`, `%.${site}`)
              : conn.prepare("DELETE FROM cookies").run();
            removed = Number(res.changes);
          } finally {
            conn.close();
          }
        }
      }
      const savedBefore = readSavedSessionCookies(info.userDataDir).length;
      clearSavedSessionCookies(info.userDataDir, site || undefined);
      removed += savedBefore - readSavedSessionCookies(info.userDataDir).length;
      respond(true, { ok: true, profile: name, site: site || null, removed });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Delete a whole profile (stops its browser first). */
  "browser.profiles.delete": async ({ params, client, respond }) => {
    if (!guard(client, respond)) return;
    try {
      const name = normalizeAgentProfileName(params.profile);
      if (name === SECURE_BROWSER_PROFILE || name === "chrome")
        throw new Error(`"${name}" can't be deleted here.`);
      if (name === AGENT_DEFAULT_PROFILE && params.confirm !== true) {
        throw new Error(
          'Deleting "default" signs the shared browser out of every site. Pass confirm:true.',
        );
      }
      const managed = await managedFor(name);
      const info = describeStoredProfile(name, managed, { withSize: false });
      if (info.lockedByOther)
        throw new Error(
          `Profile "${name}" is in use by another InfiniBot process (pid ${info.lock?.pid}).`,
        );
      if (getBrowserControlState()?.resolved.profiles[managed]) {
        await createBrowserControlContext()
          .forProfile(managed)
          .stopRunningBrowser()
          .catch(() => {});
      }
      fs.rmSync(path.dirname(info.userDataDir), { recursive: true, force: true });
      respond(true, { ok: true, profile: name });
    } catch (err) {
      fail(respond, err);
    }
  },
};
