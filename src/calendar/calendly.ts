/**
 * Calendly integration — read-only event import.
 *
 * Two auth modes are supported:
 *  1. Personal Access Token (env `CALENDLY_PAT` or `CALENDLY_API_KEY`) — recommended for single-user.
 *  2. OAuth2 (env `CALENDLY_CLIENT_ID` / `CALENDLY_CLIENT_SECRET`) — for multi-user, completes via callback URL.
 *
 * Persistence:
 *   <CONFIG_DIR>/calendar/calendly.json — stores access/refresh tokens, organization URI, user URI.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { CONFIG_DIR } from "../utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("calendly");

const STATE_DIR = path.join(CONFIG_DIR, "calendar");
const STATE_PATH = path.join(STATE_DIR, "calendly.json");

const CALENDLY_API = "https://api.calendly.com";
const CALENDLY_OAUTH_AUTH = "https://auth.calendly.com/oauth/authorize";
const CALENDLY_OAUTH_TOKEN = "https://auth.calendly.com/oauth/token";

interface CalendlyState {
  version: 1;
  /** Personal access token. If set, OAuth fields are ignored. */
  pat?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAtMs?: number;
  organizationUri?: string;
  userUri?: string;
}

let state: CalendlyState | null = null;

async function loadState(): Promise<CalendlyState> {
  if (state) return state;
  try {
    const raw = await fs.readFile(STATE_PATH, "utf-8");
    state = JSON.parse(raw) as CalendlyState;
  } catch {
    state = { version: 1 };
  }
  // Layer in env-based PAT if not stored.
  if (!state.pat && (process.env.CALENDLY_PAT || process.env.CALENDLY_API_KEY)) {
    state.pat = process.env.CALENDLY_PAT || process.env.CALENDLY_API_KEY;
  }
  return state;
}

async function saveState(): Promise<void> {
  if (!state) return;
  await fs.mkdir(STATE_DIR, { recursive: true });
  const tmp = `${STATE_PATH}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmp, STATE_PATH);
}

function authHeader(): { Authorization: string } | null {
  if (!state) return null;
  const token = state.pat || state.accessToken;
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

async function refreshTokenIfNeeded(): Promise<void> {
  await loadState();
  if (!state || state.pat) return; // PAT mode never expires
  if (!state.refreshToken) return;
  if (state.tokenExpiresAtMs && Date.now() < state.tokenExpiresAtMs - 60_000) return;
  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return;
  const res = await fetch(CALENDLY_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    log.warn(`refresh failed: ${res.status}`);
    return;
  }
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  state.accessToken = data.access_token;
  if (data.refresh_token) state.refreshToken = data.refresh_token;
  state.tokenExpiresAtMs = Date.now() + (data.expires_in ?? 3600) * 1000;
  await saveState();
}

async function calendlyFetch<T>(url: string): Promise<T> {
  await refreshTokenIfNeeded();
  const headers = authHeader();
  if (!headers) throw new Error("Calendly not connected");
  const res = await fetch(url, { headers: { ...headers, "Content-Type": "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Calendly API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────

export async function getCalendlyStatus(): Promise<{
  connected: boolean;
  mode: "pat" | "oauth" | "none";
  userUri?: string;
  organizationUri?: string;
}> {
  await loadState();
  if (!state) return { connected: false, mode: "none" };
  if (state.pat) return { connected: true, mode: "pat", userUri: state.userUri, organizationUri: state.organizationUri };
  if (state.accessToken) return { connected: true, mode: "oauth", userUri: state.userUri, organizationUri: state.organizationUri };
  return { connected: false, mode: "none" };
}

/**
 * Begin connection. If a PAT is available (env or stored), this just hydrates user/org URIs.
 * Otherwise returns an OAuth URL for the client to open.
 */
export async function beginConnect(opts?: { redirectUri?: string }): Promise<
  | { connected: true; userUri?: string; organizationUri?: string }
  | { connected: false; url: string }
  | { connected: false; error: string }
> {
  await loadState();
  if (!state) return { connected: false, error: "state init failed" };

  // PAT path
  if (state.pat) {
    try {
      await hydrateUserOrg();
      return { connected: true, userUri: state.userUri, organizationUri: state.organizationUri };
    } catch (e) {
      return { connected: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // OAuth path
  const clientId = process.env.CALENDLY_CLIENT_ID;
  if (!clientId) {
    return {
      connected: false,
      error: "Set CALENDLY_PAT (recommended) or CALENDLY_CLIENT_ID + CALENDLY_CLIENT_SECRET env vars.",
    };
  }
  const redirect = opts?.redirectUri || process.env.CALENDLY_REDIRECT_URI || "http://localhost/calendly/callback";
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
  });
  return { connected: false, url: `${CALENDLY_OAUTH_AUTH}?${params}` };
}

/** Complete OAuth code exchange. Called from a redirect URL handler. */
export async function completeOAuth(code: string, redirectUri: string): Promise<void> {
  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("OAuth not configured");
  const res = await fetch(CALENDLY_OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`OAuth exchange failed: ${res.status}`);
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  await loadState();
  if (!state) state = { version: 1 };
  state.accessToken = data.access_token;
  state.refreshToken = data.refresh_token;
  state.tokenExpiresAtMs = Date.now() + data.expires_in * 1000;
  await saveState();
  await hydrateUserOrg();
}

export async function disconnect(): Promise<void> {
  state = { version: 1 };
  await saveState();
}

async function hydrateUserOrg(): Promise<void> {
  await loadState();
  if (!state) return;
  const me = await calendlyFetch<{ resource: { uri: string; current_organization?: string } }>(
    `${CALENDLY_API}/users/me`,
  );
  state.userUri = me.resource.uri;
  state.organizationUri = me.resource.current_organization;
  await saveState();
}

export interface CalendlyEvent {
  /** Calendly UUID */
  id: string;
  uri: string;
  name: string;
  status: string;
  startTimeIso: string;
  endTimeIso: string;
  location?: { type?: string; location?: string; join_url?: string };
  invitees?: Array<{ name?: string; email?: string }>;
  htmlLink?: string;
}

export async function listScheduledEvents(opts: { minTimeIso: string; maxTimeIso: string }): Promise<CalendlyEvent[]> {
  await loadState();
  if (!state) throw new Error("not connected");
  if (!state.userUri) await hydrateUserOrg();
  if (!state.userUri) throw new Error("could not resolve Calendly user URI");

  const params = new URLSearchParams({
    user: state.userUri,
    min_start_time: opts.minTimeIso,
    max_start_time: opts.maxTimeIso,
    count: "100",
    sort: "start_time:asc",
    status: "active",
  });
  const url = `${CALENDLY_API}/scheduled_events?${params}`;
  const res = await calendlyFetch<{ collection: Array<Record<string, unknown>> }>(url);
  const events = (res.collection || []).map((raw) => {
    const uri = String(raw.uri || "");
    const id = uri.split("/").pop() || `cly-${Date.now()}`;
    return {
      id,
      uri,
      name: String(raw.name || "Calendly event"),
      status: String(raw.status || "active"),
      startTimeIso: String(raw.start_time || ""),
      endTimeIso: String(raw.end_time || ""),
      location: raw.location as CalendlyEvent["location"],
      htmlLink: typeof raw.event_url === "string" ? raw.event_url : undefined,
    } satisfies CalendlyEvent;
  });
  return events;
}

/** Convert a Calendly event to the shape used by the calendar UI controller. */
export function calendlyToCalendarEvent(e: CalendlyEvent): {
  id: string;
  calendarId: string;
  summary: string;
  status?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  location?: string;
  htmlLink?: string;
} {
  return {
    id: e.id,
    calendarId: "calendly",
    summary: e.name,
    status: e.status === "active" ? "confirmed" : "tentative",
    start: { dateTime: e.startTimeIso },
    end: { dateTime: e.endTimeIso },
    location: e.location?.location || e.location?.join_url,
    htmlLink: e.htmlLink,
  };
}
