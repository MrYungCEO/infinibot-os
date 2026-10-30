/**
 * Schedule view — native calendar with Google Calendar + Calendly integration.
 *
 * Glass G1: styles live in ./work-glass/schedule.css (scoped under `.sch`).
 * No emojis — all glyphs come from the SVG icon set.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { icon } from "../icons";
import {
  createCalendarState,
  saveCalendarSettings,
  pullCalendarSettingsFromGateway,
  pushCalendarCredsToGateway,
  refreshAccessTokenViaGateway,
  getAuthUrl,
  exchangeCodeForTokens,
  listCalendars,
  listAllEvents,
  createEvent as createGoogleEvent,
  updateEvent as updateGoogleEvent,
  deleteEvent as deleteGoogleEvent,
  formatEventTime,
  isAllDayEvent,
  getEventColor,
  type CalendarEvent,
  type CalendarSettings,
  type CalendarState,
} from "../controllers/calendar";
import {
  ensureCronState,
  loadCronJobs,
  loadCronRuns,
  saveCronJob,
  removeCronJob,
  toggleCronJob,
  runCronJob,
  openCronEditorForCreate,
  openCronEditorForEdit,
  closeCronEditor,
  patchDraft,
  describeSchedule,
  describePayload,
  CRON_PRESETS,
  INTERVAL_PRESETS,
  type CronJob,
  type CronJobDraft,
  type CronRun,
  type DeliveryChannel,
} from "../controllers/cron";
import type { WorkflowItem } from "../controllers/workflows";
import { gatewayOrigin } from "../gateway-endpoint";
import { wgAurora, wgEmpty, wgHero } from "./work-glass";
import "./work-glass/schedule.css";

// ── Date helpers ─────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfWeek(d: Date, weekStartsOn: number): Date {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartsOn + 7) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function eventStartDate(e: CalendarEvent): Date {
  return new Date(e.start.dateTime || e.start.date || 0);
}

function eventEndDate(e: CalendarEvent): Date {
  return new Date(e.end.dateTime || e.end.date || 0);
}

function eventsOnDate(events: CalendarEvent[], d: Date): CalendarEvent[] {
  return events.filter((e) => isSameDay(eventStartDate(e), d));
}

function localDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDateTimeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── State accessors ──────────────────────────────────────────

interface ScheduleEventEditor {
  open: boolean;
  isNew: boolean;
  saving: boolean;
  error: string | null;
  // form fields
  id?: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  alertChannels: string[];
  reminderMinutes: number;
}

interface ScheduleViewState {
  cal: CalendarState;
  editor: ScheduleEventEditor;
  syncing: boolean;
  oauthMode:
    | {
        active: boolean;
        redirectUri: string;
        sessionId: string;
        /** Wall-clock ms of the last poll for telemetry/debug only. */
        pollAt?: number;
        codeInput: string;
      }
    | null;
  calendlyConnecting: boolean;
  /** Server-resolved loopback redirect URL — what the operator registers
   *  in Google Cloud Console. `null` while loading, `""` if the lookup
   *  failed (we then fall back to the old OOB string). */
  redirectUri?: string | null;
  /** Transient: shows the "Copied ✓" badge on the redirect-URI copy button. */
  copyState?: { ok: boolean; at: number };
  /** True once we've pulled the gateway-side calendar creds for this
   *  session so we don't refire on every render. */
  gatewayCredsPulled?: boolean;
  /** Debounce handle for pushing clientId/secret edits to the gateway. */
  credsPushTimer?: ReturnType<typeof setTimeout> | null;
}

function schedulePushCalendarCreds(view: ScheduleViewState, client: GatewayBrowserClient): void {
  if (view.credsPushTimer) clearTimeout(view.credsPushTimer);
  view.credsPushTimer = setTimeout(() => {
    view.credsPushTimer = null;
    void pushCalendarCredsToGateway(client, view.cal.settings);
  }, 600);
}

function ensureScheduleState(state: AppViewState): ScheduleViewState {
  const s = state as unknown as { scheduleState?: ScheduleViewState };
  if (!s.scheduleState) {
    s.scheduleState = {
      cal: createCalendarState(),
      editor: emptyEditor(),
      syncing: false,
      oauthMode: null,
      calendlyConnecting: false,
    };
  }
  return s.scheduleState;
}

function emptyEditor(): ScheduleEventEditor {
  const now = new Date();
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  return {
    open: false,
    isNew: true,
    saving: false,
    error: null,
    calendarId: "primary",
    summary: "",
    description: "",
    location: "",
    allDay: false,
    start: localDateTimeInput(now),
    end: localDateTimeInput(inOneHour),
    alertChannels: ["notification"],
    reminderMinutes: 15,
  };
}

function openEditor(
  view: ScheduleViewState,
  source: { isNew: true; date?: Date } | { isNew: false; event: CalendarEvent },
) {
  if (source.isNew) {
    const d = source.date ?? new Date();
    const start = new Date(d);
    if (start.getHours() === 0 && start.getMinutes() === 0) {
      start.setHours(9, 0, 0, 0);
    }
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    view.editor = {
      ...emptyEditor(),
      open: true,
      isNew: true,
      calendarId: view.cal.settings.defaultCalendarId,
      start: localDateTimeInput(start),
      end: localDateTimeInput(end),
      alertChannels: [...view.cal.settings.alertChannels],
      reminderMinutes: view.cal.settings.defaultReminderMinutes,
    };
    return;
  }
  const e = source.event;
  const allDay = isAllDayEvent(e);
  const startStr = allDay ? (e.start.date || "") : localDateTimeInput(eventStartDate(e));
  const endStr = allDay ? (e.end.date || "") : localDateTimeInput(eventEndDate(e));
  view.editor = {
    open: true,
    isNew: false,
    saving: false,
    error: null,
    id: e.id,
    calendarId: e.calendarId,
    summary: e.summary || "",
    description: e.description || "",
    location: e.location || "",
    allDay,
    start: startStr,
    end: endStr,
    alertChannels: [...view.cal.settings.alertChannels],
    reminderMinutes: e.reminders?.overrides?.[0]?.minutes ?? view.cal.settings.defaultReminderMinutes,
  };
}

function closeEditor(view: ScheduleViewState) {
  view.editor.open = false;
  view.editor.error = null;
}

// ── Event API helpers ────────────────────────────────────────

async function refreshEvents(
  state: AppViewState,
  view: ScheduleViewState,
  client?: GatewayBrowserClient,
) {
  if (!view.cal.connected || !view.cal.settings.refreshToken) return;
  view.cal.loading = true;
  view.cal.error = null;
  state.requestUpdate?.();
  try {
    // The gateway intentionally does not return clientSecret to the browser,
    // so any client-side token refresh fails when the user opens schedule on
    // a fresh browser / tab / machine. Detect "stale access token + no local
    // clientSecret to refresh" and proactively mint a fresh token via the
    // gateway (which holds the secret) BEFORE we start hammering Google with
    // requests that would just 401. Without this, listAllEvents swallows the
    // 401s per calendar and the user sees "connected" with zero events.
    const s = view.cal.settings;
    const stale = !s.accessToken || !s.tokenExpiry || Date.now() > s.tokenExpiry - 60_000;
    const cannotLocalRefresh = !s.clientSecret;
    if (client && stale && cannotLocalRefresh) {
      const ok = await refreshAccessTokenViaGateway(client, view.cal.settings);
      if (!ok) {
        view.cal.error =
          "Couldn't refresh Google Calendar access. Reconnect your account in the connect card below.";
        return;
      }
    }

    // Range: 1 month before/after selected date so navigation is smooth.
    const center = view.cal.selectedDate;
    const min = new Date(center.getFullYear(), center.getMonth() - 1, 1);
    const max = new Date(center.getFullYear(), center.getMonth() + 2, 0, 23, 59, 59);
    if (view.cal.calendars.length === 0) {
      try {
        view.cal.calendars = await listCalendars(view.cal.settings);
      } catch (e) {
        // non-fatal
        console.warn("[Schedule] listCalendars failed", e);
      }
    }
    const calIds = view.cal.settings.selectedCalendars.length > 0
      ? view.cal.settings.selectedCalendars
      : ["primary"];

    let attempt = await tryListAllEvents(view.cal.settings, calIds, min, max);
    // Auth recovery: if every per-calendar fetch failed with a 401/invalid_
    // _grant-style error, the token Google handed us at hydration is no good
    // anymore. Force a gateway-side refresh and retry once before giving up.
    if (client && attempt.events.length === 0 && attempt.authFailed) {
      const ok = await refreshAccessTokenViaGateway(client, view.cal.settings);
      if (ok) {
        attempt = await tryListAllEvents(view.cal.settings, calIds, min, max);
      }
    }
    view.cal.events = attempt.events;
    if (attempt.events.length === 0 && attempt.firstError) {
      // Surface the underlying error instead of pretending the calendar is
      // empty — the most common cause here is "needs reconnect" and the user
      // should see that explicitly.
      view.cal.error = attempt.firstError;
    }
  } catch (e) {
    view.cal.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.cal.loading = false;
    state.requestUpdate?.();
  }
}

/**
 * listAllEvents wrapper that captures per-calendar errors instead of
 * swallowing them in the controller. Reports back whether every fetch
 * failed with an auth error so the caller can decide to refresh + retry.
 */
async function tryListAllEvents(
  settings: CalendarSettings,
  calIds: string[],
  min: Date,
  max: Date,
): Promise<{ events: CalendarEvent[]; firstError: string | null; authFailed: boolean }> {
  let firstError: string | null = null;
  let authErrors = 0;
  let totalAttempts = 0;
  const events = await listAllEvents(settings, calIds, min, max);
  // The controller already swallows per-calendar errors and resolves to []
  // on every-fail. To tell "really empty calendar" from "all-401", we do a
  // probe call against the first calendar id only when the result is empty.
  if (events.length === 0 && calIds.length > 0) {
    try {
      totalAttempts = 1;
      const params = new URLSearchParams({
        timeMin: min.toISOString(),
        timeMax: max.toISOString(),
        maxResults: "1",
        singleEvents: "true",
        orderBy: "startTime",
      });
      const r = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calIds[0])}/events?${params}`,
        { headers: { Authorization: `Bearer ${settings.accessToken || ""}` } },
      );
      if (r.status === 401 || r.status === 403) {
        authErrors = 1;
        firstError =
          "Google rejected the calendar access token (401/403). Trying to refresh…";
      } else if (!r.ok) {
        const txt = await r.text().catch(() => "");
        firstError = `Google Calendar error ${r.status}: ${txt.slice(0, 200)}`;
      }
    } catch (e) {
      firstError = e instanceof Error ? e.message : String(e);
    }
  }
  return { events, firstError, authFailed: totalAttempts > 0 && authErrors === totalAttempts };
}

async function saveEditorEvent(state: AppViewState, view: ScheduleViewState, client: GatewayBrowserClient) {
  const ed = view.editor;
  ed.saving = true;
  ed.error = null;
  state.requestUpdate?.();
  try {
    const payload: Partial<CalendarEvent> = {
      summary: ed.summary,
      description: ed.description || undefined,
      location: ed.location || undefined,
      reminders: {
        useDefault: false,
        overrides: ed.alertChannels.includes("notification") || ed.alertChannels.includes("email")
          ? [{ method: ed.alertChannels.includes("email") ? "email" : "popup", minutes: ed.reminderMinutes }]
          : [],
      },
    };
    if (ed.allDay) {
      payload.start = { date: ed.start.slice(0, 10) };
      payload.end = { date: ed.end.slice(0, 10) };
    } else {
      payload.start = { dateTime: new Date(ed.start).toISOString() };
      payload.end = { dateTime: new Date(ed.end).toISOString() };
    }
    let saved: CalendarEvent;
    if (ed.isNew) {
      saved = await createGoogleEvent(view.cal.settings, ed.calendarId, payload);
    } else if (ed.id) {
      saved = await updateGoogleEvent(view.cal.settings, ed.calendarId, ed.id, payload);
    } else {
      throw new Error("missing event id for update");
    }

    // Schedule Telegram alert via cron if requested.
    if (ed.alertChannels.includes("telegram") && !ed.allDay) {
      try {
        await scheduleTelegramAlert(client, saved, ed.reminderMinutes);
      } catch (e) {
        // non-fatal — event still saved
        console.warn("[Schedule] telegram alert failed:", e);
      }
    }

    ed.open = false;
    await refreshEvents(state, view, client);
  } catch (e) {
    ed.error = e instanceof Error ? e.message : String(e);
  } finally {
    ed.saving = false;
    state.requestUpdate?.();
  }
}

async function deleteEditorEvent(state: AppViewState, view: ScheduleViewState, client: GatewayBrowserClient) {
  const ed = view.editor;
  if (ed.isNew || !ed.id) {
    closeEditor(view);
    return;
  }
  if (!confirm("Delete this event?")) return;
  ed.saving = true;
  state.requestUpdate?.();
  try {
    await deleteGoogleEvent(view.cal.settings, ed.calendarId, ed.id);
    // Best-effort: cancel any associated Telegram alert.
    try {
      await client.request("schedule.cancelAlert", { eventId: ed.id });
    } catch { /* ignore — may not exist */ }
    ed.open = false;
    await refreshEvents(state, view, client);
  } catch (e) {
    ed.error = e instanceof Error ? e.message : String(e);
  } finally {
    ed.saving = false;
    state.requestUpdate?.();
  }
}

async function scheduleTelegramAlert(
  client: GatewayBrowserClient,
  event: CalendarEvent,
  minutesBefore: number,
) {
  const startMs = eventStartDate(event).getTime();
  const fireAt = startMs - minutesBefore * 60 * 1000;
  if (fireAt <= Date.now() + 5_000) return; // already past or too soon
  const title = event.summary || "Event";
  const time = new Date(startMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  await client.request("schedule.scheduleAlert", {
    eventId: event.id,
    eventTitle: title,
    fireAtMs: fireAt,
    channel: "telegram",
    message: `Reminder: ${title} at ${time}`,
  });
}

// ── Connect cards (Google + Calendly) ────────────────────────

/**
 * Pull the canonical Google OAuth redirect URI from the gateway. Same
 * loopback URL Gmail uses (`/gmail/oauth/callback`) — it's a generic
 * Google callback that parks the code keyed by `state`. Falls back to
 * `""` on failure so the UI shows a clear "couldn't reach gateway" state
 * rather than the deprecated OOB string.
 */
async function loadCalendarRedirectUri(
  view: ScheduleViewState,
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  // Optimistic fallback FIRST, synchronously: derive the loopback redirect from
  // the page origin (Calendar shares Gmail's `/gmail/oauth/callback`) so the
  // Connect button is usable immediately. Otherwise a slow or hung
  // `calendar.oauth.config` RPC leaves redirectUri unset forever and the flow
  // sits on "Loading…" / stays greyed. The gateway value refines it below.
  if (!view.redirectUri) {
    view.redirectUri = `${gatewayOrigin()}/gmail/oauth/callback`;
    state.requestUpdate?.();
  }
  try {
    const res = (await client.request("calendar.oauth.config", {})) as
      | { redirectUrl?: string }
      | undefined;
    const url = res?.redirectUrl?.trim();
    if (url) view.redirectUri = url;
  } catch {
    // Fallback already applied above — keep it.
  }
  state.requestUpdate?.();
}

async function startGoogleAuth(
  view: ScheduleViewState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const settings = view.cal.settings;
  if (!settings.clientId) {
    view.cal.error = "Set the Google Cloud Client ID in settings before connecting.";
    state.requestUpdate?.();
    return;
  }
  if (!view.redirectUri) {
    view.cal.error = "Gateway hasn't returned the OAuth redirect URL yet. Try again in a moment.";
    state.requestUpdate?.();
    return;
  }

  // Open a server-managed session so the gateway's `/gmail/oauth/callback`
  // (shared with Calendar) can park the code keyed by `state`. We then
  // poll until it shows up, exchange it for tokens, and stash them.
  try {
    const sess = (await client.request("calendar.oauth.startSession", {})) as
      | { sessionId?: string }
      | undefined;
    const sessionId = sess?.sessionId?.trim();
    if (!sessionId) throw new Error("Gateway didn't return a session id");

    const authUrl = getAuthUrl(settings.clientId, view.redirectUri) + `&state=${encodeURIComponent(sessionId)}`;
    view.oauthMode = {
      active: true,
      redirectUri: view.redirectUri,
      sessionId,
      codeInput: "",
    };
    try { window.open(authUrl, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
    state.requestUpdate?.();

    // Poll for the parked code every 1.5s for 5 minutes. As soon as it
    // shows up, complete the exchange. Operator can still cancel.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && view.oauthMode?.active && view.oauthMode.sessionId === sessionId) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const poll = (await client.request("calendar.oauth.pollCode", { sessionId })) as
          | { code?: string | null }
          | undefined;
        const code = poll?.code?.trim();
        if (code && view.oauthMode?.active) {
          view.oauthMode.codeInput = code;
          await completeGoogleAuth(view, state, client);
          return;
        }
      } catch {
        // transient — keep polling
      }
      if (view.oauthMode) view.oauthMode.pollAt = Date.now();
    }
  } catch (e) {
    view.cal.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

async function completeGoogleAuth(view: ScheduleViewState, state: AppViewState, client?: GatewayBrowserClient) {
  if (!view.oauthMode || !view.oauthMode.codeInput.trim()) return;
  const settings = view.cal.settings;
  view.cal.loading = true;
  view.cal.error = null;
  state.requestUpdate?.();
  try {
    const tokens = await exchangeCodeForTokens(
      view.oauthMode.codeInput.trim(),
      settings.clientId,
      settings.clientSecret,
      view.oauthMode.redirectUri,
    );
    settings.accessToken = tokens.accessToken;
    settings.refreshToken = tokens.refreshToken;
    settings.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
    saveCalendarSettings(settings);
    if (client) void pushCalendarCredsToGateway(client, settings);
    view.cal.connected = true;
    view.oauthMode = null;
    await refreshEvents(state, view, client);
  } catch (e) {
    view.cal.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.cal.loading = false;
    state.requestUpdate?.();
  }
}

function disconnectGoogle(view: ScheduleViewState, state: AppViewState, client?: GatewayBrowserClient) {
  if (!confirm("Disconnect Google Calendar? Tokens will be cleared from the gateway config and this device.")) return;
  view.cal.settings.accessToken = "";
  view.cal.settings.refreshToken = "";
  view.cal.settings.tokenExpiry = 0;
  saveCalendarSettings(view.cal.settings);
  if (client) void pushCalendarCredsToGateway(client, view.cal.settings, { clear: true });
  view.cal.connected = false;
  view.cal.events = [];
  view.cal.calendars = [];
  state.requestUpdate?.();
}

async function connectCalendly(view: ScheduleViewState, state: AppViewState, client: GatewayBrowserClient) {
  view.calendlyConnecting = true;
  state.requestUpdate?.();
  try {
    // Server will return either {url} for redirect-based auth, or {connected:true}
    // if a personal-access-token flow is in use.
    const res = (await client.request("calendly.connect", {})) as
      | { url?: string; connected?: boolean; error?: string };
    if (res?.url) {
      window.open(res.url, "_blank", "noopener,noreferrer");
    } else if (!res?.connected) {
      throw new Error(res?.error || "Calendly connect not configured on server");
    }
    await refreshCalendlyEvents(state, view, client);
  } catch (e) {
    view.cal.error = e instanceof Error ? e.message : String(e);
  } finally {
    view.calendlyConnecting = false;
    state.requestUpdate?.();
  }
}

async function refreshCalendlyEvents(state: AppViewState, view: ScheduleViewState, client: GatewayBrowserClient) {
  try {
    const center = view.cal.selectedDate;
    const min = new Date(center.getFullYear(), center.getMonth() - 1, 1).toISOString();
    const max = new Date(center.getFullYear(), center.getMonth() + 2, 0).toISOString();
    const res = (await client.request("calendly.events.list", { minTime: min, maxTime: max })) as
      | { events?: CalendarEvent[] };
    if (Array.isArray(res?.events)) {
      // Tag with calendarId="calendly" so we can filter / style differently.
      const tagged = res.events.map((e) => ({ ...e, calendarId: "calendly" }));
      // Merge into view.cal.events, replacing prior calendly entries.
      const others = view.cal.events.filter((e) => e.calendarId !== "calendly");
      view.cal.events = [...others, ...tagged].sort((a, b) =>
        eventStartDate(a).getTime() - eventStartDate(b).getTime(),
      );
    }
  } catch (e) {
    // optional source — log only
    console.warn("[Schedule] calendly events fetch failed", e);
  } finally {
    state.requestUpdate?.();
  }
}

// ── Render: Connect cards ────────────────────────────────────
// Styling for everything below lives in ./work-glass/schedule.css, scoped
// under `.sch` (page) and `.sch-overlay` (modals rendered beside the page).

/**
 * Render the redirect-URI row. The URL is fetched at render time from the
 * gateway (`calendar.oauth.config` → same loopback URL Gmail uses, since
 * /gmail/oauth/callback is a generic Google OAuth callback). Operators
 * paste this into Google Cloud Console under "Authorized redirect URIs"
 * when creating the OAuth client. While the lookup is pending we render a
 * spinner-style placeholder so the operator doesn't try to copy nothing.
 */
function renderGoogleRedirectUriRow(
  view: ScheduleViewState,
  state: AppViewState,
): TemplateResult {
  const value = view.redirectUri;
  const copyState: { ok: boolean; at: number } | undefined = view.copyState;
  const copied = copyState?.ok && (Date.now() - copyState.at) < 2000;
  const displayValue =
    value === undefined || value === null
      ? "Loading from gateway…"
      : value || "Could not resolve — restart gateway and retry";
  const canCopy = typeof value === "string" && value.length > 0;
  return html`
    <div class="sch-redirect">
      <div class="sch-redirect__text">
        <div class="sch-label">Redirect URI · register this in Google Cloud Console</div>
        <div class="sch-redirect__value ${canCopy ? "" : "is-pending"}" title=${displayValue}>
          ${displayValue}
        </div>
      </div>
      <button
        class="g-btn g-btn--sm sch-copy ${copied ? "is-copied" : ""}"
        title="Copy redirect URI"
        ?disabled=${!canCopy}
        @click=${async () => {
          if (!canCopy || !value) return;
          try {
            await navigator.clipboard.writeText(value);
            view.copyState = { ok: true, at: Date.now() };
          } catch {
            view.copyState = { ok: false, at: Date.now() };
          }
          state.requestUpdate?.();
          window.setTimeout(() => {
            if (view.copyState && (Date.now() - view.copyState.at) >= 2000) {
              view.copyState = undefined;
              state.requestUpdate?.();
            }
          }, 2100);
        }}>
        ${copied ? html`${icon("check")} Copied` : html`${icon("copy")} Copy`}
      </button>
    </div>
  `;
}

function renderGoogleConnectCard(
  view: ScheduleViewState,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const settings = view.cal.settings;
  const oauth = view.oauthMode;
  return html`
    <div class="wg-surface sch-connect">
      <div class="sch-connect__head">
        <span class="sch-tile">${icon("calendar")}</span>
        <div class="sch-connect__titles">
          <div class="sch-connect__name">Google Calendar</div>
          <div class="sch-connect__meta">Two-way sync · OAuth2</div>
        </div>
        ${view.cal.connected ? html`<span class="sch-pill sch-pill--ok"><i class="sch-led"></i>Connected</span>` : nothing}
      </div>

      ${!view.cal.connected ? html`
        <!-- Redirect URI panel — exactly the value Google Cloud Console
             needs in the OAuth client's "Authorized redirect URIs" list. -->
        ${renderGoogleRedirectUriRow(view, state)}

        <div class="sch-grid-2">
          <label class="sch-field">
            <span class="sch-label">Client ID</span>
            <input class="g-input sch-mono" type="text" .value=${settings.clientId}
              placeholder="*.apps.googleusercontent.com"
              @input=${(e: Event) => {
                settings.clientId = (e.target as HTMLInputElement).value;
                saveCalendarSettings(settings);
                schedulePushCalendarCreds(view, client);
                state.requestUpdate?.();
              }} />
          </label>
          <label class="sch-field">
            <span class="sch-label">Client secret</span>
            <input class="g-input sch-mono" type="password" .value=${settings.clientSecret}
              @input=${(e: Event) => {
                settings.clientSecret = (e.target as HTMLInputElement).value;
                saveCalendarSettings(settings);
                schedulePushCalendarCreds(view, client);
                state.requestUpdate?.();
              }} />
          </label>
        </div>
        ${oauth?.active ? html`
          <div class="sch-oauth">
            <div class="sch-oauth__hint">
              Authorize Google in the new tab. The gateway will catch the
              redirect and exchange the code automatically.
              If your browser blocked the redirect or the code didn't arrive,
              paste it manually below.
            </div>
            <div class="sch-oauth__row">
              <input class="g-input sch-mono" type="text" .value=${oauth.codeInput}
                placeholder="Paste authorization code"
                @input=${(e: Event) => {
                  if (view.oauthMode) view.oauthMode.codeInput = (e.target as HTMLInputElement).value;
                }} />
              <button class="g-btn g-btn--primary" @click=${() => completeGoogleAuth(view, state, client)}
                ?disabled=${view.cal.loading}>Exchange</button>
              <button class="g-btn g-btn--icon" aria-label="Cancel authorization"
                @click=${() => { view.oauthMode = null; state.requestUpdate?.(); }}>${icon("x")}</button>
            </div>
          </div>
        ` : html`
          <button class="g-btn g-btn--primary" @click=${() => startGoogleAuth(view, state, client)}
            ?disabled=${!settings.clientId || !settings.clientSecret || !view.redirectUri}>
            ${icon("link")} Connect Google Calendar
          </button>
        `}
      ` : html`
        <div class="sch-row-gap">
          <button class="g-btn" @click=${async () => { await refreshEvents(state, view, client); }}>
            ${icon("refresh")} Sync now
          </button>
          <button class="g-btn g-btn--ghost" @click=${() => disconnectGoogle(view, state, client)}>Disconnect</button>
        </div>
      `}
      ${view.cal.error ? html`<div class="sch-alert" role="alert">${view.cal.error}</div>` : nothing}
    </div>
  `;
}

function renderCalendlyConnectCard(
  view: ScheduleViewState,
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  return html`
    <div class="wg-surface sch-connect">
      <div class="sch-connect__head">
        <span class="sch-tile">${icon("link")}</span>
        <div class="sch-connect__titles">
          <div class="sch-connect__name">Calendly</div>
          <div class="sch-connect__meta">Read-only · Booked appointments</div>
        </div>
      </div>
      <p class="sch-connect__body">
        Connect your Calendly account to display all booked meetings inline with your other calendars.
        Imported events are read-only.
      </p>
      <button class="g-btn" @click=${() => connectCalendly(view, state, client)}
        ?disabled=${view.calendlyConnecting}>
        ${icon("link")} ${view.calendlyConnecting ? "Connecting…" : "Connect Calendly"}
      </button>
    </div>
  `;
}

// ── Render: Header / nav ─────────────────────────────────────

function renderHeader(view: ScheduleViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const cal = view.cal;
  const dt = cal.selectedDate;
  const tab = state.scheduleTab ?? "calendar";

  const goToday = () => { cal.selectedDate = new Date(); state.requestUpdate?.(); void refreshEvents(state, view, client); };
  const step = (delta: number) => () => {
    const d = new Date(cal.selectedDate);
    if (cal.view === "month") d.setMonth(d.getMonth() + delta);
    else if (cal.view === "week") d.setDate(d.getDate() + delta * 7);
    else if (cal.view === "day") d.setDate(d.getDate() + delta);
    else d.setMonth(d.getMonth() + delta);
    cal.selectedDate = d;
    state.requestUpdate?.();
    void refreshEvents(state, view, client);
  };

  const viewBtn = (label: string, val: CalendarState["view"]) => html`
    <button class="sch-seg__btn ${cal.view === val ? "is-active" : ""}" aria-pressed=${cal.view === val}
      @click=${() => { cal.view = val; cal.settings.defaultView = val; saveCalendarSettings(cal.settings); state.requestUpdate?.(); }}
    >${label}</button>
  `;

  const googleCount = cal.events.filter((e) => e.calendarId !== "calendly").length;
  const calendlyCount = cal.events.length - googleCount;
  const sub = tab === "calendar"
    ? (cal.connected
      ? html`${googleCount} event${googleCount === 1 ? "" : "s"} synced${calendlyCount ? html` · ${calendlyCount} Calendly booking${calendlyCount === 1 ? "" : "s"}` : nothing}`
      : "Connect Google Calendar or Calendly to see and edit your events here.")
    : tab === "cron"
      ? "Recurring system events and agent turns that run on a schedule."
      : "Attach a schedule to any workflow.";

  return html`
    ${wgHero({
      eyebrow: "Schedule",
      title: html`${MONTH_NAMES[dt.getMonth()]} <span class="wg-gold">${dt.getFullYear()}</span>`,
      sub,
      actions: html`
        <div class="sch-nav" role="group" aria-label="Navigate dates">
          <button class="g-btn g-btn--icon" @click=${step(-1)} title="Previous" aria-label="Previous">${icon("arrowLeft")}</button>
          <button class="g-btn" @click=${goToday}>Today</button>
          <button class="g-btn g-btn--icon" @click=${step(1)} title="Next" aria-label="Next">${icon("arrowRight")}</button>
        </div>
        <div class="sch-seg" role="group" aria-label="Calendar view">
          ${viewBtn("Month", "month")}
          ${viewBtn("Week", "week")}
          ${viewBtn("Day", "day")}
          ${viewBtn("Agenda", "agenda")}
        </div>
        <div class="sch-nav">
          <button class="g-btn g-btn--icon ${cal.loading ? "is-spinning" : ""}" ?disabled=${cal.loading}
            @click=${async () => {
              await refreshEvents(state, view, client);
              await refreshCalendlyEvents(state, view, client);
            }} title="Refresh" aria-label="Refresh">${icon(cal.loading ? "loader" : "refresh")}</button>
          <button class="g-btn g-btn--primary" @click=${() => { openEditor(view, { isNew: true, date: cal.selectedDate }); state.requestUpdate?.(); }}
            ?disabled=${!cal.connected}
            title=${cal.connected ? "New event" : "Connect a calendar first"}
          >${icon("plus")} New event</button>
        </div>
      `,
    })}
  `;
}

// ── Render: month view ───────────────────────────────────────

/** Event colour as a CSS custom property (data-driven, so it stays inline). */
function evStyle(event: CalendarEvent): string {
  return event.calendarId === "calendly" ? "" : `--ev:${getEventColor(event).bg}`;
}

function renderMonth(view: ScheduleViewState, state: AppViewState): TemplateResult {
  const cal = view.cal;
  const weekStart = cal.settings.weekStartsOn;
  const monthStart = startOfMonth(cal.selectedDate);
  const gridStart = startOfWeek(monthStart, weekStart);
  const today = startOfDay(new Date());
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(gridStart, i));

  const dayHeaders = [];
  for (let i = 0; i < 7; i++) {
    dayHeaders.push(DAY_LABELS[(weekStart + i) % 7]);
  }

  return html`
    <div class="wg-surface sch-frame sch-month">
      <div class="sch-month__dow">
        ${dayHeaders.map((d) => html`<div>${d}</div>`)}
      </div>
      <div class="sch-month__grid">
        ${cells.map((d) => {
          const inMonth = d.getMonth() === monthStart.getMonth();
          const isToday = isSameDay(d, today);
          const isSelected = isSameDay(d, cal.selectedDate);
          const dayEvents = eventsOnDate(cal.events, d);
          return html`
            <div
              class="sch-cell ${isSelected ? "is-selected" : ""} ${inMonth ? "" : "is-out"} ${isToday ? "is-today" : ""}"
              @click=${() => { cal.selectedDate = new Date(d); state.requestUpdate?.(); }}
              @dblclick=${() => { openEditor(view, { isNew: true, date: d }); state.requestUpdate?.(); }}
            >
              <div class="sch-daynum">${d.getDate()}</div>
              <div class="sch-cell__events">
                ${dayEvents.slice(0, 3).map((e) => renderMonthEventChip(e, view, state))}
                ${dayEvents.length > 3 ? html`<div class="sch-more">+${dayEvents.length - 3} more</div>` : nothing}
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderMonthEventChip(event: CalendarEvent, view: ScheduleViewState, state: AppViewState): TemplateResult {
  const isCalendly = event.calendarId === "calendly";
  const time = isAllDayEvent(event) ? "" : new Date(event.start.dateTime!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return html`
    <div
      class="sch-chip ${isCalendly ? "is-calendly" : ""}"
      style=${evStyle(event)}
      @click=${(e: Event) => { e.stopPropagation(); openEditor(view, { isNew: false, event }); state.requestUpdate?.(); }}
      title="${event.summary || ""}"
    >
      ${isCalendly ? html`<span class="sch-chip__icon">${icon("link")}</span>` : nothing}
      ${time ? html`<span class="sch-chip__time">${time}</span>` : nothing}
      <span class="sch-chip__title">${event.summary || "(untitled)"}</span>
    </div>
  `;
}

// ── Render: week view ────────────────────────────────────────

function renderWeek(view: ScheduleViewState, state: AppViewState): TemplateResult {
  const cal = view.cal;
  const start = startOfWeek(cal.selectedDate, cal.settings.weekStartsOn);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  const today = startOfDay(new Date());

  return html`
    <div class="wg-surface sch-frame sch-week">
      ${days.map((d) => {
        const isToday = isSameDay(d, today);
        const isSelected = isSameDay(d, cal.selectedDate);
        const dayEvents = eventsOnDate(cal.events, d);
        return html`
          <div
            class="sch-cell sch-week__col ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}"
            @click=${() => { cal.selectedDate = new Date(d); state.requestUpdate?.(); }}
            @dblclick=${() => { openEditor(view, { isNew: true, date: d }); state.requestUpdate?.(); }}
          >
            <div class="sch-week__head">
              <div class="sch-week__dow">${DAY_LABELS[d.getDay()]}</div>
              <div class="sch-daynum sch-daynum--lg">${d.getDate()}</div>
            </div>
            <div class="sch-week__events">
              ${dayEvents.length === 0
                ? html`<div class="sch-none">No events</div>`
                : dayEvents.map((e) => renderWeekEventChip(e, view, state))}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderWeekEventChip(event: CalendarEvent, view: ScheduleViewState, state: AppViewState): TemplateResult {
  const isCalendly = event.calendarId === "calendly";
  const time = isAllDayEvent(event) ? "All day" : formatEventTime(event);
  return html`
    <div
      class="sch-block ${isCalendly ? "is-calendly" : ""}"
      style=${evStyle(event)}
      @click=${(e: Event) => { e.stopPropagation(); openEditor(view, { isNew: false, event }); state.requestUpdate?.(); }}
    >
      <div class="sch-block__title">${event.summary || "(untitled)"}</div>
      <div class="sch-block__time">${time}</div>
    </div>
  `;
}

// ── Render: day view ─────────────────────────────────────────

const HOUR_PX = 52;

function renderDay(view: ScheduleViewState, state: AppViewState): TemplateResult {
  const cal = view.cal;
  const d = startOfDay(cal.selectedDate);
  const events = eventsOnDate(cal.events, d).sort((a, b) =>
    eventStartDate(a).getTime() - eventStartDate(b).getTime(),
  );
  const allDay = events.filter((e) => isAllDayEvent(e));

  const hours: number[] = [];
  for (let h = 0; h < 24; h++) hours.push(h);

  const now = new Date();
  const showNow = isSameDay(now, d);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;

  return html`
    <div class="wg-surface sch-frame sch-day">
      <div class="sch-day__head">
        <span class="sch-day__date">${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span>
        <span class="sch-day__count">${events.length} event${events.length === 1 ? "" : "s"}</span>
        ${allDay.map((e) => html`
          <span class="sch-chip sch-chip--inline ${e.calendarId === "calendly" ? "is-calendly" : ""}" style=${evStyle(e)}
            @click=${(ev: Event) => { ev.stopPropagation(); openEditor(view, { isNew: false, event: e }); state.requestUpdate?.(); }}
          ><span class="sch-chip__time">All day</span><span class="sch-chip__title">${e.summary || "(untitled)"}</span></span>
        `)}
      </div>
      <div class="sch-day__body" style="--hour:${HOUR_PX}px">
        <!-- Hour ruler -->
        <div class="sch-day__ruler">
          ${hours.map((h) => html`
            <div class="sch-day__hour">${h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`}</div>
          `)}
        </div>
        <!-- Event lane -->
        <div class="sch-day__lane" style="min-height:${24 * HOUR_PX}px">
          ${hours.map((h) => html`<div class="sch-day__line" style="top:${h * HOUR_PX}px"></div>`)}
          ${showNow ? html`<div class="sch-day__now" style="top:${nowTop}px" aria-hidden="true"></div>` : nothing}
          ${events.map((e) => {
            if (isAllDayEvent(e)) return nothing;
            const start = eventStartDate(e);
            const end = eventEndDate(e);
            const startMin = start.getHours() * 60 + start.getMinutes();
            const endMin = Math.max(end.getHours() * 60 + end.getMinutes(), startMin + 15);
            const top = (startMin / 60) * HOUR_PX;
            const height = ((endMin - startMin) / 60) * HOUR_PX;
            const isCalendly = e.calendarId === "calendly";
            return html`
              <div class="sch-block sch-block--abs ${isCalendly ? "is-calendly" : ""}"
                style="top:${top}px; height:${height}px; ${evStyle(e)}"
                @click=${(ev: Event) => { ev.stopPropagation(); openEditor(view, { isNew: false, event: e }); state.requestUpdate?.(); }}
              >
                <div class="sch-block__title">${e.summary || "(untitled)"}</div>
                <div class="sch-block__time">${formatEventTime(e)}</div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

// ── Render: agenda view ──────────────────────────────────────

function renderAgenda(view: ScheduleViewState, state: AppViewState): TemplateResult {
  const cal = view.cal;
  const today = startOfDay(new Date());
  const upcoming = cal.events
    .filter((e) => eventEndDate(e).getTime() >= today.getTime())
    .sort((a, b) => eventStartDate(a).getTime() - eventStartDate(b).getTime())
    .slice(0, 100);

  // Group by day
  const grouped = new Map<string, CalendarEvent[]>();
  for (const e of upcoming) {
    const k = localDateInput(eventStartDate(e));
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(e);
  }

  if (grouped.size === 0) {
    return html`
      <div class="wg-surface sch-frame">
        ${wgEmpty({
          icon: icon("calendar"),
          title: "No upcoming events",
          body: cal.connected
            ? "Your calendar is clear. Double-click any day in Month or Week view, or add one now."
            : "Connect Google Calendar or Calendly above to see your upcoming events here.",
          action: cal.connected
            ? html`<button class="g-btn g-btn--primary g-btn--sm" @click=${() => { openEditor(view, { isNew: true, date: cal.selectedDate }); state.requestUpdate?.(); }}>${icon("plus")} New event</button>`
            : undefined,
        })}
      </div>
    `;
  }

  return html`
    <div class="sch-agenda">
      ${[...grouped.entries()].map(([dateKey, evs]) => {
        const d = new Date(dateKey + "T00:00:00");
        const isToday = isSameDay(d, today);
        return html`
          <section class="wg-surface sch-frame sch-agenda__day ${isToday ? "is-today" : ""}">
            <div class="sch-agenda__head">
              <span class="sch-agenda__date">${d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</span>
              ${isToday ? html`<span class="sch-pill sch-pill--gold">Today</span>` : nothing}
              <span class="sch-agenda__count">${evs.length} event${evs.length === 1 ? "" : "s"}</span>
            </div>
            <div>
              ${evs.map((e) => renderAgendaRow(e, view, state))}
            </div>
          </section>
        `;
      })}
    </div>
  `;
}

function renderAgendaRow(event: CalendarEvent, view: ScheduleViewState, state: AppViewState): TemplateResult {
  const isCalendly = event.calendarId === "calendly";
  return html`
    <div
      class="sch-arow ${isCalendly ? "is-calendly" : ""}"
      style=${evStyle(event)}
      role="button"
      tabindex="0"
      @click=${() => { openEditor(view, { isNew: false, event }); state.requestUpdate?.(); }}
      @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { openEditor(view, { isNew: false, event }); state.requestUpdate?.(); } }}
    >
      <div class="sch-arow__time">${isAllDayEvent(event) ? "All day" : formatEventTime(event)}</div>
      <div class="sch-arow__bar"></div>
      <div class="sch-arow__main">
        <div class="sch-arow__title">${event.summary || "(untitled)"}</div>
        ${event.location ? html`<div class="sch-arow__meta">${event.location}</div>` : nothing}
        ${(event.attendees && event.attendees.length > 0) ? html`
          <div class="sch-arow__meta sch-arow__people">
            ${icon("users")}
            ${event.attendees.length} attendee${event.attendees.length === 1 ? "" : "s"}
          </div>
        ` : nothing}
      </div>
      ${isCalendly ? html`<span class="sch-pill sch-pill--gold">Calendly</span>` : nothing}
      ${event.htmlLink ? html`
        <a class="sch-arow__link" href=${event.htmlLink} target="_blank" rel="noopener noreferrer"
          @click=${(e: Event) => e.stopPropagation()}
          title="Open in source" aria-label="Open in source"
        >${icon("externalLink")}</a>
      ` : nothing}
    </div>
  `;
}

// ── Render: event editor modal ───────────────────────────────

function renderEditor(view: ScheduleViewState, state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ed = view.editor;
  if (!ed.open) return html``;
  const isCalendly = ed.calendarId === "calendly";

  const channelToggle = (val: string, label: string, iconName: Parameters<typeof icon>[0]) => {
    const on = ed.alertChannels.includes(val);
    return html`
      <button class="sch-toggle ${on ? "is-on" : ""}" aria-pressed=${on} @click=${() => {
        if (on) ed.alertChannels = ed.alertChannels.filter((c) => c !== val);
        else ed.alertChannels = [...ed.alertChannels, val];
        state.requestUpdate?.();
      }}>
        ${icon(iconName)} ${label}
      </button>
    `;
  };

  return html`
    <div class="sch-overlay sch-overlay--center" @click=${(e: Event) => { if (e.target === e.currentTarget) closeEditor(view); state.requestUpdate?.(); }}>
      <div class="wg-page sch-modal sch-modal--sm" role="dialog" aria-modal="true" aria-label=${ed.isNew ? "New event" : "Edit event"}>
        <div class="sch-modal__head">
          <span class="sch-tile">${icon(ed.isNew ? "plus" : "edit")}</span>
          <div class="sch-modal__titles">
            <div class="wg-eyebrow">${isCalendly ? "Calendly · read-only" : "Calendar"}</div>
            <div class="sch-modal__title">${ed.isNew ? html`New <span class="wg-gold-text">event</span>` : html`Edit <span class="wg-gold-text">event</span>`}</div>
          </div>
          <button class="g-btn g-btn--ghost g-btn--icon" aria-label="Close" @click=${() => { closeEditor(view); state.requestUpdate?.(); }}>${icon("x")}</button>
        </div>

        <div class="sch-modal__body">
          <label class="sch-field">
            <span class="sch-label">Title</span>
            <input class="g-input sch-input-lg" type="text" .value=${ed.summary} ?disabled=${isCalendly}
              @input=${(e: Event) => { ed.summary = (e.target as HTMLInputElement).value; }}
              placeholder="Event title" />
          </label>

          <div class="sch-grid-2">
            <label class="sch-field">
              <span class="sch-label">Start</span>
              <input class="g-input sch-mono" type=${ed.allDay ? "date" : "datetime-local"} .value=${ed.start} ?disabled=${isCalendly}
                @input=${(e: Event) => { ed.start = (e.target as HTMLInputElement).value; }} />
            </label>
            <label class="sch-field">
              <span class="sch-label">End</span>
              <input class="g-input sch-mono" type=${ed.allDay ? "date" : "datetime-local"} .value=${ed.end} ?disabled=${isCalendly}
                @input=${(e: Event) => { ed.end = (e.target as HTMLInputElement).value; }} />
            </label>
          </div>

          <label class="sch-check ${isCalendly ? "is-disabled" : ""}">
            <input type="checkbox" .checked=${ed.allDay} ?disabled=${isCalendly}
              @change=${(e: Event) => {
                ed.allDay = (e.target as HTMLInputElement).checked;
                if (ed.allDay) {
                  ed.start = ed.start.slice(0, 10);
                  ed.end = ed.end.slice(0, 10);
                } else {
                  ed.start = ed.start.length === 10 ? `${ed.start}T09:00` : ed.start;
                  ed.end = ed.end.length === 10 ? `${ed.end}T10:00` : ed.end;
                }
                state.requestUpdate?.();
              }} />
            All day
          </label>

          <label class="sch-field">
            <span class="sch-label">Location</span>
            <input class="g-input" type="text" .value=${ed.location} ?disabled=${isCalendly}
              @input=${(e: Event) => { ed.location = (e.target as HTMLInputElement).value; }}
              placeholder="Address, link, or room" />
          </label>

          <label class="sch-field">
            <span class="sch-label">Description</span>
            <textarea class="g-input" .value=${ed.description} ?disabled=${isCalendly}
              @input=${(e: Event) => { ed.description = (e.target as HTMLTextAreaElement).value; }}
              rows="3"></textarea>
          </label>

          ${!isCalendly ? html`
            <div class="sch-field">
              <span class="sch-label">Alerts</span>
              <div class="sch-row-gap">
                ${channelToggle("notification", "Popup", "alert")}
                ${channelToggle("telegram", "Telegram", "send")}
                ${channelToggle("email", "Email", "mail")}
              </div>
              <div class="sch-remind">
                <span>Remind</span>
                <input class="g-input sch-mono sch-remind__n" type="number" .value=${String(ed.reminderMinutes)} min="0" max="10080"
                  @input=${(e: Event) => { ed.reminderMinutes = Math.max(0, parseInt((e.target as HTMLInputElement).value) || 0); }} />
                <span>minutes before</span>
              </div>
            </div>
          ` : nothing}

          ${ed.error ? html`<div class="sch-alert" role="alert">${ed.error}</div>` : nothing}
        </div>

        <div class="sch-modal__foot">
          ${!ed.isNew && !isCalendly ? html`
            <button class="g-btn sch-btn-danger" @click=${() => deleteEditorEvent(state, view, client)} ?disabled=${ed.saving}>${icon("trash")} Delete</button>
          ` : nothing}
          <div class="sch-spacer"></div>
          <button class="g-btn" @click=${() => { closeEditor(view); state.requestUpdate?.(); }}>Cancel</button>
          ${!isCalendly ? html`
            <button class="g-btn g-btn--primary" @click=${() => saveEditorEvent(state, view, client)} ?disabled=${ed.saving || !ed.summary.trim()}
            >${icon("check")} ${ed.saving ? "Saving…" : (ed.isNew ? "Create" : "Save")}</button>
          ` : nothing}
        </div>
      </div>
    </div>
  `;
}

// ── Main render ──────────────────────────────────────────────

let initialLoaded = false;

export function renderSchedule(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const view = ensureScheduleState(state);
  const cal = view.cal;

  // Lazy-load events on first render after connect.
  if (cal.connected && !initialLoaded && cal.events.length === 0 && !cal.loading) {
    initialLoaded = true;
    void refreshEvents(state, view, client).then(() => refreshCalendlyEvents(state, view, client));
  }

  // Lazy-load the canonical Google OAuth redirect URI from the gateway
  // so the connect card can show the exact string the operator should
  // register in Google Cloud Console.
  if (!cal.connected && view.redirectUri === undefined) {
    view.redirectUri = null; // mark "loading" so we don't fire twice
    void loadCalendarRedirectUri(view, state, client);
  }

  // Hydrate clientId / tokens from the gateway config on first render so
  // the connection follows the user across browsers + devices. Local
  // storage is just a render cache; gateway is source of truth.
  if (!view.gatewayCredsPulled) {
    view.gatewayCredsPulled = true;
    void pullCalendarSettingsFromGateway(client).then((merged) => {
      if (!merged) return;
      view.cal.settings = merged;
      view.cal.connected = Boolean(merged.refreshToken);
      state.requestUpdate?.();
    });
  }

  // Read sub-tab from app state (defaults to calendar).
  const tab = state.scheduleTab ?? "calendar";

  return html`
    <div class="wg-page sch">
      ${wgAurora()}
      ${renderHeader(view, state, client)}

      ${renderScheduleTabs(state)}

      ${tab === "calendar" ? html`
        <!-- Connect cards row (visible when not connected) -->
        ${!cal.connected ? html`
          <div class="sch-connect-row">
            ${renderGoogleConnectCard(view, state, client)}
            ${renderCalendlyConnectCard(view, state, client)}
          </div>
        ` : nothing}

        <!-- Body -->
        <div class="sch-body">
          ${cal.view === "month" ? renderMonth(view, state)
            : cal.view === "week" ? renderWeek(view, state)
            : cal.view === "day" ? renderDay(view, state)
            : renderAgenda(view, state)}
        </div>
      ` : tab === "cron" ? renderCronPanel(state, client)
        : renderWorkflowsSchedulePanel(state, client)}

      <!-- Bottom: connection status (always visible) when connected -->
      ${tab === "calendar" && cal.connected ? html`
        <div class="sch-status">
          <span class="sch-pill sch-pill--ok"><i class="sch-led"></i>Google</span>
          <span class="sch-status__text">
            ${cal.events.filter((e) => e.calendarId !== "calendly").length} events synced
          </span>
          ${cal.events.some((e) => e.calendarId === "calendly") ? html`
            <span class="sch-pill sch-pill--gold">${icon("link")} Calendly</span>
            <span class="sch-status__text">
              ${cal.events.filter((e) => e.calendarId === "calendly").length} bookings
            </span>
          ` : html`
            <button class="g-btn g-btn--sm sch-status__add" @click=${() => connectCalendly(view, state, client)} ?disabled=${view.calendlyConnecting}
            >${icon("plus")} Add Calendly</button>
          `}
        </div>
      ` : nothing}
    </div>
    ${renderEditor(view, state, client)}
    ${renderCronEditorModal(state, client)}
  `;
}

// ── Sub-tab strip ───────────────────────────────────────────────────

function renderScheduleTabs(state: AppViewState): TemplateResult {
  const current = state.scheduleTab ?? "calendar";
  const tab = (id: "calendar" | "cron" | "workflows", label: string, ic: string) => html`
    <button class="sch-tabs__btn ${current === id ? "is-active" : ""}" aria-current=${current === id ? "page" : "false"}
      @click=${() => { state.scheduleTab = id; state.requestUpdate?.(); }}
    >${icon(ic as any)} ${label}</button>
  `;
  return html`
    <nav class="wg-surface sch-tabs" aria-label="Schedule sections">
      ${tab("calendar", "Calendar", "calendar")}
      ${tab("cron", "Cron jobs", "clock")}
      ${tab("workflows", "Workflows", "play")}
    </nav>
  `;
}

// ── Cron jobs panel ────────────────────────────────────────────────

let cronInitialLoaded = false;

function renderCronPanel(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const cs = ensureCronState(state);
  if (!cronInitialLoaded && !cs.loading && cs.jobs.length === 0 && !cs.error) {
    cronInitialLoaded = true;
    void loadCronJobs(state, client);
  }
  const enabled = cs.jobs.filter((j) => j.enabled).length;

  return html`
    <div class="sch-stack">
      <!-- Toolbar -->
      <div class="sch-toolbar">
        <button class="g-btn g-btn--primary" @click=${() => openCronEditorForCreate(state)}>${icon("plus")} New cron job</button>
        <button class="g-btn" @click=${() => loadCronJobs(state, client)}>${icon(cs.loading ? "loader" : "refresh")} ${cs.loading ? "Loading…" : "Refresh"}</button>
        <span class="sch-toolbar__stats">
          <span class="sch-pill">${cs.jobs.length} job${cs.jobs.length === 1 ? "" : "s"}</span>
          <span class="sch-pill sch-pill--ok"><i class="sch-led"></i>${enabled} enabled</span>
        </span>
      </div>

      ${cs.error ? html`<div class="sch-alert" role="alert">${cs.error}</div>` : nothing}

      ${cs.loading && cs.jobs.length === 0 ? html`
        <div class="sch-stack">
          ${[0, 1, 2].map(() => html`<div class="wg-card sch-job sch-job--skel"><div class="wg-skel" style="height:20px;width:36px;border-radius:999px"></div><div style="flex:1;display:grid;gap:8px"><div class="wg-skel" style="height:13px;width:40%"></div><div class="wg-skel" style="height:10px;width:70%"></div></div></div>`)}
        </div>
      ` : nothing}

      ${cs.jobs.length === 0 && !cs.loading ? html`
        <div class="wg-surface sch-frame">
          ${wgEmpty({
            icon: icon("clock"),
            title: "No cron jobs scheduled",
            body: "Create one to run a system event, fire an isolated agent turn, or deliver output to a channel on a schedule.",
            action: html`<button class="g-btn g-btn--primary g-btn--sm" @click=${() => openCronEditorForCreate(state)}>${icon("plus")} New cron job</button>`,
          })}
        </div>
      ` : nothing}

      <!-- Jobs list -->
      <div class="sch-stack sch-stack--tight">
        ${cs.jobs.map((job) => renderCronJobRow(state, client, job))}
      </div>
    </div>
  `;
}

function renderCronJobRow(
  state: AppViewState,
  client: GatewayBrowserClient,
  job: CronJob,
): TemplateResult {
  const cs = ensureCronState(state);
  const expanded = cs.expandedHistoryJobId === job.jobId;
  const runs = cs.runs[job.jobId] ?? [];
  const lastStatus = job.lastRunStatus;

  return html`
    <div class="wg-card sch-job ${job.enabled ? "" : "is-off"}">
      <div class="sch-job__row">
        <!-- Enable toggle -->
        <button class="sch-switch ${job.enabled ? "is-on" : ""}" role="switch" aria-checked=${job.enabled}
          @click=${() => toggleCronJob(state, client, job)}
          title="${job.enabled ? "Disable" : "Enable"}" aria-label="${job.enabled ? "Disable" : "Enable"} ${job.name || "job"}">
          <span class="sch-switch__knob"></span>
        </button>

        <!-- Main details -->
        <div class="sch-job__main">
          <div class="sch-job__title-row">
            <span class="sch-job__name">${job.name || "(unnamed)"}</span>
            <span class="sch-pill sch-pill--gold">${job.sessionTarget === "main" ? "Main" : "Isolated"}</span>
            <span class="sch-pill">${job.payload.kind === "systemEvent" ? "System event" : "Agent turn"}</span>
            ${job.payload.kind === "agentTurn" && job.payload.deliver ? html`
              <span class="sch-pill sch-pill--warn">→ ${(job.payload.channel ?? "last")}</span>
            ` : nothing}
          </div>
          <div class="sch-job__sched">${icon("clock")} ${describeSchedule(job.schedule)}</div>
          <div class="sch-job__payload">${describePayload(job.payload)}</div>
          ${job.lastRunAt ? html`
            <div class="sch-job__runs">
              Last run:
              <span class="sch-run" data-status=${lastStatus ?? ""}>${lastStatus ?? "—"}</span>
              · ${new Date(job.lastRunAt).toLocaleString()}
              ${job.nextRunAt ? html` · Next: ${new Date(job.nextRunAt).toLocaleString()}` : nothing}
            </div>
          ` : job.nextRunAt ? html`
            <div class="sch-job__runs">Next run: ${new Date(job.nextRunAt).toLocaleString()}</div>
          ` : nothing}
        </div>

        <!-- Actions -->
        <div class="sch-job__actions">
          <button class="g-btn g-btn--icon g-btn--sm sch-btn-gold" @click=${() => runCronJob(state, client, job.jobId, true)}
            title="Run now (force)" aria-label="Run now">${icon("play")}</button>
          <button class="g-btn g-btn--icon g-btn--sm ${expanded ? "is-active" : ""}" @click=${() => {
            if (cs.expandedHistoryJobId === job.jobId) {
              cs.expandedHistoryJobId = null;
              state.requestUpdate?.();
            } else {
              cs.expandedHistoryJobId = job.jobId;
              void loadCronRuns(state, client, job.jobId);
            }
          }}
            title="Run history" aria-label="Run history" aria-expanded=${expanded}>${icon("activity")}</button>
          <button class="g-btn g-btn--icon g-btn--sm" @click=${() => openCronEditorForEdit(state, job)}
            title="Edit" aria-label="Edit">${icon("edit")}</button>
          <button class="g-btn g-btn--icon g-btn--sm sch-btn-danger" @click=${() => {
            if (confirm(`Delete cron job "${job.name}"?`)) {
              void removeCronJob(state, client, job.jobId);
            }
          }}
            title="Delete" aria-label="Delete">${icon("trash")}</button>
        </div>
      </div>

      ${expanded ? renderCronRunHistory(runs) : nothing}
    </div>
  `;
}

function renderCronRunHistory(runs: CronRun[]): TemplateResult {
  if (runs.length === 0) {
    return html`<div class="sch-history sch-history--empty">No runs recorded yet.</div>`;
  }
  return html`
    <div class="sch-history">
      <div class="sch-label">Recent runs</div>
      <div class="sch-history__list">
        ${runs.slice(0, 10).map((r) => html`
          <div class="sch-history__row">
            <span class="sch-run" data-status=${r.status}>${r.status}</span>
            <span class="sch-history__at">${new Date(r.startedAt).toLocaleString()}</span>
            ${r.error ? html`<span class="sch-history__err">— ${r.error}</span>` : nothing}
          </div>
        `)}
      </div>
    </div>
  `;
}

// ── Cron editor modal ─────────────────────────────────────────────

function renderCronEditorModal(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const cs = ensureCronState(state);
  if (!cs.editorOpen || !cs.draft) return html``;
  const d = cs.draft;
  const update = (patch: Partial<CronJobDraft>) => patchDraft(state, patch);

  return html`
    <div class="sch-overlay" @click=${() => closeCronEditor(state)}>
      <div class="wg-page sch-modal" role="dialog" aria-modal="true" aria-label=${d.jobId ? "Edit cron job" : "New cron job"}
        @click=${(e: Event) => e.stopPropagation()}>
        <!-- Title -->
        <div class="sch-modal__head">
          <span class="sch-tile">${icon("clock")}</span>
          <div class="sch-modal__titles">
            <div class="wg-eyebrow">Cron</div>
            <div class="sch-modal__title">${d.jobId ? html`Edit <span class="wg-gold-text">cron job</span>` : html`New <span class="wg-gold-text">cron job</span>`}</div>
          </div>
          <button class="g-btn g-btn--ghost g-btn--icon" aria-label="Close" @click=${() => closeCronEditor(state)}>${icon("x")}</button>
        </div>

        <div class="sch-modal__body">
          <!-- Name + enabled -->
          <div class="sch-name-row">
            <label class="sch-field">
              <span class="sch-label">Name</span>
              <input class="g-input sch-input-lg" .value=${d.name}
                @input=${(e: Event) => update({ name: (e.target as HTMLInputElement).value })}
                placeholder="Morning summary" />
            </label>
            <label class="sch-check">
              <input type="checkbox" .checked=${d.enabled}
                @change=${(e: Event) => update({ enabled: (e.target as HTMLInputElement).checked })} />
              Enabled
            </label>
          </div>

          <!-- Schedule -->
          <section class="wg-card sch-section">
            <div class="sch-section__head">
              <span class="sch-label">Schedule</span>
              <div class="sch-seg sch-seg--sm" role="group" aria-label="Schedule type">
                ${(["cron", "every", "at"] as const).map((k) => html`
                  <button class="sch-seg__btn ${d.scheduleKind === k ? "is-active" : ""}" aria-pressed=${d.scheduleKind === k}
                    @click=${() => update({ scheduleKind: k })}
                  >${k === "cron" ? "Cron expr" : k === "every" ? "Interval" : "One-shot"}</button>
                `)}
              </div>
            </div>

            ${d.scheduleKind === "cron" ? html`
              <label class="sch-field">
                <span class="sch-label">Expression</span>
                <input class="g-input sch-mono" .value=${d.cronExpr}
                  @input=${(e: Event) => update({ cronExpr: (e.target as HTMLInputElement).value })}
                  placeholder="0 9 * * *" />
              </label>
              <div class="sch-presets">
                ${CRON_PRESETS.map((p) => html`
                  <button class="sch-preset ${d.cronExpr === p.expr ? "is-active" : ""}" @click=${() => update({ cronExpr: p.expr })}>${p.label}</button>
                `)}
              </div>
              <label class="sch-field">
                <span class="sch-label">Timezone (IANA)</span>
                <input class="g-input sch-mono" .value=${d.cronTz}
                  @input=${(e: Event) => update({ cronTz: (e.target as HTMLInputElement).value })}
                  placeholder="America/Los_Angeles" />
              </label>
            ` : d.scheduleKind === "every" ? html`
              <label class="sch-field">
                <span class="sch-label">Interval (ms)</span>
                <input class="g-input sch-mono" type="number" .value=${String(d.everyMs)}
                  @input=${(e: Event) => update({ everyMs: Number((e.target as HTMLInputElement).value) || 0 })} />
              </label>
              <div class="sch-presets">
                ${INTERVAL_PRESETS.map((p) => html`
                  <button class="sch-preset ${d.everyMs === p.ms ? "is-active" : ""}" @click=${() => update({ everyMs: p.ms })}>${p.label}</button>
                `)}
              </div>
            ` : html`
              <label class="sch-field">
                <span class="sch-label">Run at (local time)</span>
                <input class="g-input" type="datetime-local" .value=${d.atIso}
                  @input=${(e: Event) => update({ atIso: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="sch-check">
                <input type="checkbox" .checked=${d.deleteAfterRun}
                  @change=${(e: Event) => update({ deleteAfterRun: (e.target as HTMLInputElement).checked })} />
                Delete the job after a successful run
              </label>
            `}
          </section>

          <!-- Session target + payload -->
          <section class="wg-card sch-section">
            <div class="sch-section__head">
              <span class="sch-label">Target</span>
              <div class="sch-seg sch-seg--sm" role="group" aria-label="Session target">
                ${(["main", "isolated"] as const).map((s) => html`
                  <button class="sch-seg__btn ${d.sessionTarget === s ? "is-active" : ""}" aria-pressed=${d.sessionTarget === s}
                    @click=${() => update({ sessionTarget: s })}
                  >${s === "main" ? "Main session" : "Isolated session"}</button>
                `)}
              </div>
            </div>

            ${d.sessionTarget === "main" ? html`
              <label class="sch-field">
                <span class="sch-label">System-event text</span>
                <textarea class="g-input" style="min-height:90px"
                  .value=${d.systemEventText}
                  @input=${(e: Event) => update({ systemEventText: (e.target as HTMLTextAreaElement).value })}
                  placeholder="Reminder: review the inbox before standup."></textarea>
              </label>
              <div class="sch-row-gap">
                <label class="sch-check">
                  <input type="radio" name="wakeMode" .checked=${d.wakeMode === "next-heartbeat"}
                    @change=${() => update({ wakeMode: "next-heartbeat" })} />
                  Wake on next heartbeat
                </label>
                <label class="sch-check">
                  <input type="radio" name="wakeMode" .checked=${d.wakeMode === "now"}
                    @change=${() => update({ wakeMode: "now" })} />
                  Wake immediately
                </label>
              </div>
            ` : html`
              <label class="sch-field">
                <span class="sch-label">Agent message</span>
                <textarea class="g-input" style="min-height:110px"
                  .value=${d.agentMessage}
                  @input=${(e: Event) => update({ agentMessage: (e.target as HTMLTextAreaElement).value })}
                  placeholder="Summarize today's inbox + calendar."></textarea>
              </label>

              <div class="sch-grid-3">
                <label class="sch-field">
                  <span class="sch-label">Model override</span>
                  <input class="g-input sch-mono" .value=${d.agentModel}
                    @input=${(e: Event) => update({ agentModel: (e.target as HTMLInputElement).value })}
                    placeholder="opus / sonnet / provider/model" />
                </label>
                <label class="sch-field">
                  <span class="sch-label">Thinking</span>
                  <select class="g-input" .value=${d.agentThinking}
                    @change=${(e: Event) => update({ agentThinking: (e.target as HTMLSelectElement).value as any })}>
                    <option value="">— default —</option>
                    <option value="off">off</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="xhigh">xhigh</option>
                  </select>
                </label>
                <label class="sch-field">
                  <span class="sch-label">Timeout (s)</span>
                  <input class="g-input sch-mono" type="number" .value=${d.agentTimeoutSeconds == null ? "" : String(d.agentTimeoutSeconds)}
                    @input=${(e: Event) => {
                      const v = (e.target as HTMLInputElement).value;
                      update({ agentTimeoutSeconds: v ? Number(v) : null });
                    }}
                    placeholder="default" />
                </label>
              </div>

              <!-- Delivery -->
              <div class="sch-subsection">
                <label class="sch-check">
                  <input type="checkbox" .checked=${d.deliver}
                    @change=${(e: Event) => update({ deliver: (e.target as HTMLInputElement).checked })} />
                  Deliver output to a channel
                </label>
                ${d.deliver ? html`
                  <div class="sch-grid-12">
                    <label class="sch-field">
                      <span class="sch-label">Channel</span>
                      <select class="g-input" .value=${d.channel}
                        @change=${(e: Event) => update({ channel: (e.target as HTMLSelectElement).value as DeliveryChannel })}>
                        <option value="">— last route —</option>
                        <option value="whatsapp">whatsapp</option>
                        <option value="telegram">telegram</option>
                        <option value="discord">discord</option>
                        <option value="slack">slack</option>
                        <option value="signal">signal</option>
                        <option value="imessage">imessage</option>
                        <option value="last">last</option>
                      </select>
                    </label>
                    <label class="sch-field">
                      <span class="sch-label">To (recipient)</span>
                      <input class="g-input sch-mono" .value=${d.to}
                        @input=${(e: Event) => update({ to: (e.target as HTMLInputElement).value })}
                        placeholder="+15551234567 or -1001234567890:topic:123 or channel:<id>" />
                    </label>
                  </div>
                  <label class="sch-check">
                    <input type="checkbox" .checked=${d.bestEffortDeliver}
                      @change=${(e: Event) => update({ bestEffortDeliver: (e.target as HTMLInputElement).checked })} />
                    Don't fail the run if delivery fails
                  </label>
                ` : nothing}
              </div>

              <!-- Post-to-main + agent + wake -->
              <div class="sch-subsection sch-grid-2">
                <label class="sch-field">
                  <span class="sch-label">Post-to-main prefix</span>
                  <input class="g-input" .value=${d.postToMainPrefix}
                    @input=${(e: Event) => update({ postToMainPrefix: (e.target as HTMLInputElement).value })} />
                </label>
                <label class="sch-field">
                  <span class="sch-label">Post mode</span>
                  <select class="g-input" .value=${d.postToMainMode}
                    @change=${(e: Event) => update({ postToMainMode: (e.target as HTMLSelectElement).value as any })}>
                    <option value="summary">summary</option>
                    <option value="full">full</option>
                  </select>
                </label>
                <label class="sch-field">
                  <span class="sch-label">Agent binding (optional)</span>
                  <input class="g-input sch-mono" .value=${d.agentId}
                    @input=${(e: Event) => update({ agentId: (e.target as HTMLInputElement).value })}
                    placeholder="agent id (falls back to default)" />
                </label>
                <label class="sch-field">
                  <span class="sch-label">Wake</span>
                  <select class="g-input" .value=${d.wakeMode}
                    @change=${(e: Event) => update({ wakeMode: (e.target as HTMLSelectElement).value as any })}>
                    <option value="next-heartbeat">next-heartbeat</option>
                    <option value="now">now</option>
                  </select>
                </label>
              </div>
            `}
          </section>

          ${cs.error ? html`<div class="sch-alert" role="alert">${cs.error}</div>` : nothing}
        </div>

        <!-- Actions -->
        <div class="sch-modal__foot">
          <div class="sch-spacer"></div>
          <button class="g-btn" @click=${() => closeCronEditor(state)}>Cancel</button>
          <button class="g-btn g-btn--primary" @click=${async () => { await saveCronJob(state, client); }}
            ?disabled=${cs.saving}
          >${icon("check")} ${cs.saving ? "Saving…" : (d.jobId ? "Save" : "Create")}</button>
        </div>
      </div>
    </div>
  `;
}

// ── Workflows scheduling panel ─────────────────────────────────────

let workflowsListLoaded = false;
let workflowsListCache: WorkflowItem[] = [];
let workflowsListError: string | null = null;
let workflowsListLoading = false;

function renderWorkflowsSchedulePanel(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  if (!workflowsListLoaded && !workflowsListLoading) {
    workflowsListLoading = true;
    workflowsListLoaded = true;
    void (async () => {
      try {
        const res = (await client.request("workflows.list", {})) as { workflows?: WorkflowItem[] };
        workflowsListCache = res?.workflows ?? [];
        workflowsListError = null;
      } catch (e) {
        workflowsListError = e instanceof Error ? e.message : String(e);
      } finally {
        workflowsListLoading = false;
        state.requestUpdate?.();
      }
    })();
  }

  // Cron jobs whose payload is an agentTurn referencing a workflow run.
  const cs = ensureCronState(state);
  if (!cronInitialLoaded && !cs.loading && cs.jobs.length === 0 && !cs.error) {
    cronInitialLoaded = true;
    void loadCronJobs(state, client);
  }
  const scheduledByName = new Map<string, CronJob[]>();
  for (const job of cs.jobs) {
    if (job.payload.kind !== "agentTurn") continue;
    const m = /workflow[s]?[\s:"']+([\w\-./]+)/i.exec(job.payload.message);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const arr = scheduledByName.get(key) ?? [];
    arr.push(job);
    scheduledByName.set(key, arr);
  }

  const scheduleWorkflow = (wf: WorkflowItem) => {
    openCronEditorForCreate(state);
    patchDraft(state, {
      name: `Workflow: ${wf.name}`,
      sessionTarget: "isolated",
      payloadKind: "agentTurn",
      agentMessage: `Run the workflow named "${wf.name}" using the workflows tool. Workflow id: ${wf.id}.`,
      scheduleKind: "cron",
      cronExpr: "0 9 * * *",
    });
  };

  return html`
    <div class="sch-stack">
      <div class="sch-toolbar">
        <p class="sch-intro">
          Attach a cron schedule to any workflow. Each scheduled workflow becomes
          an isolated cron job that asks the agent to run it via the workflows tool —
          so model overrides, channel delivery, and agent binding all apply.
        </p>
        <button class="g-btn sch-toolbar__end" @click=${() => {
          workflowsListLoaded = false;
          state.requestUpdate?.();
        }}>${icon(workflowsListLoading ? "loader" : "refresh")} ${workflowsListLoading ? "Loading…" : "Refresh"}</button>
      </div>

      ${workflowsListError ? html`<div class="sch-alert" role="alert">${workflowsListError}</div>` : nothing}

      ${workflowsListCache.length === 0 && !workflowsListLoading ? html`
        <div class="wg-surface sch-frame">
          ${wgEmpty({
            icon: icon("play"),
            title: "No workflows defined yet",
            body: "Create one in the Workflows view, then come back here to schedule it.",
          })}
        </div>
      ` : nothing}

      <div class="sch-stack sch-stack--tight">
        ${workflowsListCache.map((wf) => {
          const linked = scheduledByName.get(wf.name.toLowerCase()) ?? scheduledByName.get(wf.id.toLowerCase()) ?? [];
          return html`
            <div class="wg-card sch-job">
              <div class="sch-job__row">
                <span class="sch-tile sch-tile--sm">${icon("play")}</span>
                <div class="sch-job__main">
                  <div class="sch-job__name">${wf.name}</div>
                  ${wf.description ? html`<div class="sch-job__desc">${wf.description}</div>` : nothing}
                  ${linked.length > 0 ? html`
                    <div class="sch-linked">
                      ${linked.map((job) => html`
                        <div class="sch-linked__row">
                          <i class="sch-led ${job.enabled ? "is-on" : ""}"></i>
                          <span>${describeSchedule(job.schedule)}</span>
                          <button class="g-btn g-btn--sm sch-linked__edit" @click=${() => openCronEditorForEdit(state, job)}>Edit</button>
                        </div>
                      `)}
                    </div>
                  ` : nothing}
                </div>
                <button class="g-btn sch-btn-gold" @click=${() => scheduleWorkflow(wf)}>${icon("plus")} Schedule</button>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}
