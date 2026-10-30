import { ErrorCodes, errorShape } from "../protocol/index.js";
import {
  deleteStoredEvent,
  listStoredEvents,
  mergeEvents,
  type CalendarSource,
  type StoredCalendarEvent,
} from "../../calendar/store.js";
import { syncAll } from "../../calendar/sync.js";
import { runAlertsScan } from "../../calendar/alerts.js";
import {
  configureCalendar,
  forceRefreshCalendarAccessToken,
  isCalendarConfigured,
} from "../../agents/tools/calendar-tool.js";
import {
  getCalendarOauthRedirectUrl,
  createGmailOauthSession,
  consumePendingGmailCode,
} from "../gmail-oauth-http.js";
import { readConfigFileSnapshot, writeConfigFile } from "../../config/io.js";
import type { GatewayRequestHandlers } from "./types.js";

interface StoredCalendarCreds {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  tokenExpiry?: number;
}

async function readCalendarCreds(): Promise<StoredCalendarCreds> {
  const snap = await readConfigFileSnapshot();
  const parsed = snap.parsed as Record<string, unknown> | undefined;
  if (!parsed || typeof parsed !== "object") return {};
  const integ = (parsed.integrations as Record<string, unknown> | undefined) ?? {};
  const cal = (integ.calendar as StoredCalendarCreds | undefined) ?? {};
  return { ...cal };
}

async function mutateCalendarCreds(
  fn: (block: StoredCalendarCreds) => StoredCalendarCreds,
): Promise<StoredCalendarCreds> {
  const snap = await readConfigFileSnapshot();
  const parsed = (snap.parsed as Record<string, unknown> | undefined) ?? {};
  const cfg = { ...parsed };
  const integ = { ...((cfg.integrations as Record<string, unknown> | undefined) ?? {}) };
  const prev = (integ.calendar as StoredCalendarCreds | undefined) ?? {};
  const next = fn({ ...prev });
  integ.calendar = next;
  cfg.integrations = integ;
  await writeConfigFile(cfg as never);
  return next;
}

/**
 * Wire the Google Calendar OAuth credentials into the agent calendar tool on
 * boot. Calendar shares Google OAuth with Gmail under `integrations.calendar`
 * (clientId / clientSecret / refreshToken). No-op + warn if not yet connected.
 */
export function initCalendar(state: {
  config: {
    integrations?: {
      calendar?: { clientId?: string; clientSecret?: string; refreshToken?: string };
    };
  };
}): void {
  const creds = state.config.integrations?.calendar;
  if (creds?.clientId && creds?.clientSecret && creds?.refreshToken) {
    configureCalendar({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: creds.refreshToken,
    });
    console.log("[Calendar] Agent calendar tool configured from integrations.calendar");
  } else {
    console.warn(
      "[Calendar] Google Calendar not connected — calendar tool actions will be unavailable until OAuth is completed",
    );
  }
}

const VALID_SOURCES: CalendarSource[] = ["google", "calendly"];

function asSource(v: unknown): CalendarSource | null {
  if (typeof v !== "string") return null;
  return VALID_SOURCES.includes(v as CalendarSource) ? (v as CalendarSource) : null;
}

export const calendarSyncHandlers: GatewayRequestHandlers = {
  "calendar.events.list": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const source = typeof p.source === "string" ? (asSource(p.source) ?? undefined) : undefined;
    const fromIso = typeof p.fromIso === "string" ? p.fromIso : undefined;
    const toIso = typeof p.toIso === "string" ? p.toIso : undefined;
    try {
      const events = await listStoredEvents({ source, fromIso, toIso });
      respond(true, { events });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "calendar.events.upsert": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const source = asSource(p.source);
    if (!source) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `source must be one of: ${VALID_SOURCES.join(", ")}`,
        ),
      );
      return;
    }
    const list = Array.isArray(p.events) ? (p.events as Partial<StoredCalendarEvent>[]) : [];
    const now = Date.now();
    const stored: StoredCalendarEvent[] = list
      .filter((e) => typeof e.id === "string" && e.id.length > 0)
      .map((e) => ({
        id: e.id!,
        source,
        calendarId: e.calendarId || "primary",
        summary: e.summary || "",
        description: e.description,
        location: e.location,
        startIso: e.startIso,
        endIso: e.endIso,
        startDate: e.startDate,
        endDate: e.endDate,
        status: e.status,
        htmlLink: e.htmlLink,
        remoteUpdatedAtMs: e.remoteUpdatedAtMs ?? now,
        cachedAtMs: now,
      }));
    try {
      const result = await mergeEvents(source, stored);
      respond(true, result);
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "calendar.events.delete": async ({ params, respond }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    const source = asSource(p.source);
    const id = typeof p.id === "string" ? p.id : "";
    if (!source || !id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "source + id required"));
      return;
    }
    try {
      const ok = await deleteStoredEvent(source, id);
      respond(true, { deleted: ok ? 1 : 0 });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "calendar.sync.run": async ({ respond }) => {
    try {
      const results = await syncAll();
      respond(true, { results });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  // Manually trigger the proactive alert scan (meeting reminders + deadline
  // watchers). Useful for testing without waiting for the 60s runner tick.
  "calendar.alerts.run": async ({ respond }) => {
    try {
      const result = await runAlertsScan();
      respond(true, { ...result, calendarConfigured: isCalendarConfigured() });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  // ── Google Calendar OAuth helpers ─────────────────────────────────
  // Calendar piggybacks on the existing /gmail/oauth/callback endpoint
  // (same Google OAuth callback — the path name is historical, the
  // handler is generic). These thin wrappers give the schedule page
  // proper names + scope hints so the UI doesn't have to know about
  // the gmail subsystem.

  "calendar.oauth.config": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const host = typeof p.host === "string" && p.host.trim() ? p.host.trim() : undefined;
      // Use the /calendar/oauth/callback route — same handler as the
      // gmail one (shared session map under the hood), but published
      // under a path that reads correctly on the Schedule page.
      const redirectUrl = getCalendarOauthRedirectUrl(host ? { hostOverride: host } : undefined);
      respond(true, {
        redirectUrl,
        scopes: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/userinfo.email",
        ],
      });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "calendar.oauth.startSession": async ({ respond }) => {
    try {
      respond(true, { sessionId: createGmailOauthSession() });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  // Read the Google Calendar credentials that the gateway has on disk
  // (~/.infinibot/infinibot.json → integrations.calendar). The UI uses
  // this to hydrate the schedule page across browsers / machines instead
  // of relying on localStorage. Never returns the clientSecret to the
  // browser — it's only kept server-side for token refresh.
  "calendar.config.get": async ({ respond }) => {
    try {
      const creds = await readCalendarCreds();
      respond(true, {
        clientId: creds.clientId ?? "",
        hasClientSecret: Boolean(creds.clientSecret),
        refreshToken: creds.refreshToken ?? "",
        accessToken: creds.accessToken ?? "",
        tokenExpiry: typeof creds.tokenExpiry === "number" ? creds.tokenExpiry : 0,
        connected: Boolean(creds.clientId && creds.clientSecret && creds.refreshToken),
      });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  // Persist Google Calendar credentials to ~/.infinibot/infinibot.json
  // under integrations.calendar so they survive restarts and follow the
  // user across browsers. Only fields the caller passes are updated;
  // omitted fields are preserved. After writing, re-configure the
  // in-process calendar tool so agent actions pick up the new tokens
  // without a gateway restart.
  "calendar.config.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const pickStr = (k: string): string | undefined => {
        const v = p[k];
        return typeof v === "string" ? v.trim() : undefined;
      };
      const next = await mutateCalendarCreds((prev) => {
        const out = { ...prev };
        const clientId = pickStr("clientId");
        const clientSecret = pickStr("clientSecret");
        const refreshToken = pickStr("refreshToken");
        const accessToken = pickStr("accessToken");
        if (clientId !== undefined) out.clientId = clientId;
        if (clientSecret !== undefined && clientSecret.length > 0) out.clientSecret = clientSecret;
        if (refreshToken !== undefined) out.refreshToken = refreshToken;
        if (accessToken !== undefined) out.accessToken = accessToken;
        if (typeof p.tokenExpiry === "number") out.tokenExpiry = p.tokenExpiry;
        if (p.clear === true) {
          out.refreshToken = "";
          out.accessToken = "";
          out.tokenExpiry = 0;
        }
        return out;
      });
      if (next.clientId && next.clientSecret && next.refreshToken) {
        configureCalendar({
          clientId: next.clientId,
          clientSecret: next.clientSecret,
          refreshToken: next.refreshToken,
        });
      }
      respond(true, {
        clientId: next.clientId ?? "",
        hasClientSecret: Boolean(next.clientSecret),
        refreshToken: next.refreshToken ?? "",
        accessToken: next.accessToken ?? "",
        tokenExpiry: typeof next.tokenExpiry === "number" ? next.tokenExpiry : 0,
        connected: Boolean(next.clientId && next.clientSecret && next.refreshToken),
      });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  /**
   * Force a Google access-token refresh using the gateway's clientSecret and
   * return the fresh `{accessToken, tokenExpiry}` so the browser can call
   * Google Calendar directly without ever seeing the clientSecret.
   *
   * The browser hits this whenever its locally-cached access token is missing
   * or expired (the normal case after hydrating settings from gateway on a
   * new browser/tab/machine). Without this RPC the schedule page would show
   * "connected" but zero events because the browser-side refresh fails
   * silently when the clientSecret isn't present.
   *
   * Also persists the freshly minted token + expiry to disk so server-side
   * agent tools pick up the same window without re-refreshing.
   */
  "calendar.token.refresh": async ({ respond }) => {
    try {
      // Make sure the in-memory calendar tool is hydrated from disk before
      // we ask it to refresh — on a cold gateway the configureCalendar wire-
      // up only runs when calendar.config.set is called, so a browser that
      // hits us first would otherwise see a "not configured" error.
      if (!isCalendarConfigured()) {
        const creds = await readCalendarCreds();
        if (creds?.clientId && creds?.clientSecret && creds?.refreshToken) {
          configureCalendar({
            clientId: creds.clientId,
            clientSecret: creds.clientSecret,
            refreshToken: creds.refreshToken,
            accessToken: creds.accessToken,
            tokenExpiry: creds.tokenExpiry,
          });
        }
      }
      const fresh = await forceRefreshCalendarAccessToken();
      // Persist the refreshed token so a gateway restart, or a server-side
      // agent tool that bypasses this RPC, sees the same valid token.
      await mutateCalendarCreds((prev) => ({
        ...prev,
        accessToken: fresh.accessToken,
        tokenExpiry: fresh.tokenExpiry,
      }));
      respond(true, fresh);
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },

  "calendar.oauth.pollCode": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const sessionId = typeof p.sessionId === "string" ? p.sessionId.trim() : "";
      if (!sessionId) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionId required"));
        return;
      }
      const code = consumePendingGmailCode(sessionId);
      respond(true, { code });
    } catch (e) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INTERNAL_ERROR, e instanceof Error ? e.message : String(e)),
      );
    }
  },
};
