/**
 * Calendar Tool — Google Calendar MCP Integration
 * Allows agents to view, create, and manage calendar events
 */

import { z } from "zod";

// Calendar credentials (loaded from config)
let calendarCredentials: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
} | null = null;

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// ============================================================
// Token Management
// ============================================================

async function refreshAccessToken(): Promise<string> {
  if (
    !calendarCredentials?.refreshToken ||
    !calendarCredentials?.clientId ||
    !calendarCredentials?.clientSecret
  ) {
    throw new Error(
      "Calendar not configured. Please connect Google Calendar in the Schedule settings.",
    );
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: calendarCredentials.refreshToken,
      client_id: calendarCredentials.clientId,
      client_secret: calendarCredentials.clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error_description || "Failed to refresh Google Calendar token");
  }

  const data = await response.json();
  calendarCredentials.accessToken = data.access_token;
  calendarCredentials.tokenExpiry = Date.now() + data.expires_in * 1000;

  return data.access_token;
}

async function getAccessToken(): Promise<string> {
  if (!calendarCredentials) {
    throw new Error("Calendar not configured");
  }

  // Check if token needs refresh
  if (
    !calendarCredentials.accessToken ||
    (calendarCredentials.tokenExpiry && Date.now() > calendarCredentials.tokenExpiry - 60000)
  ) {
    return refreshAccessToken();
  }

  return calendarCredentials.accessToken;
}

async function calendarApiRequest(endpoint: string, options: RequestInit = {}): Promise<any> {
  const accessToken = await getAccessToken();

  const response = await fetch(`${GOOGLE_CALENDAR_API}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Calendar API error: ${response.status}`);
  }

  // DELETE returns no content
  if (response.status === 204) return {};

  return response.json();
}

// ============================================================
// Tool Configuration
// ============================================================

export function configureCalendar(credentials: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
}) {
  calendarCredentials = credentials;
  console.log("[Calendar] Calendar tool configured");
}

/** True once Google Calendar OAuth credentials have been wired in. */
export function isCalendarConfigured(): boolean {
  return Boolean(
    calendarCredentials?.refreshToken &&
    calendarCredentials?.clientId &&
    calendarCredentials?.clientSecret,
  );
}

/**
 * Force a Google access-token refresh using the server-held clientSecret and
 * return the new token + expiry. Exposed so the gateway's
 * `calendar.token.refresh` RPC can mint a fresh token for the browser without
 * leaking the clientSecret across the wire.
 *
 * Throws if the calendar tool hasn't been configured yet (no refreshToken /
 * clientId / clientSecret on disk) so the caller can surface a clear
 * "reconnect calendar" message instead of a generic 500.
 */
export async function forceRefreshCalendarAccessToken(): Promise<{
  accessToken: string;
  tokenExpiry: number;
}> {
  const token = await refreshAccessToken();
  return {
    accessToken: token,
    tokenExpiry: calendarCredentials?.tokenExpiry ?? 0,
  };
}

// ============================================================
// Calendar Operations
// ============================================================

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
}

async function listCalendars(): Promise<any[]> {
  const data = await calendarApiRequest("/users/me/calendarList");
  return data.items || [];
}

async function listEvents(
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  maxResults: number = 50,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const data = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  );

  return (data.items || []).map((e: any) => ({ ...e, calendarId }));
}

async function createEvent(
  calendarId: string,
  event: {
    summary: string;
    description?: string;
    location?: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
    attendees?: Array<{ email: string }>;
  },
): Promise<CalendarEvent> {
  const created = await calendarApiRequest(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  return { ...created, calendarId };
}

async function updateEvent(
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>,
): Promise<CalendarEvent> {
  const updated = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  );
  return { ...updated, calendarId };
}

async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" },
  );
}

async function quickAddEvent(calendarId: string, text: string): Promise<CalendarEvent> {
  const created = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`,
    { method: "POST" },
  );
  return { ...created, calendarId };
}

interface BusyInterval {
  start: number;
  end: number;
}

/** Query Google's free/busy endpoint across one or more calendars/attendees. */
async function queryBusy(
  calendarIds: string[],
  timeMin: Date,
  timeMax: Date,
): Promise<BusyInterval[]> {
  const data = await calendarApiRequest("/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });
  const busy: BusyInterval[] = [];
  for (const cal of Object.values<any>(data.calendars || {})) {
    for (const b of cal?.busy || []) {
      const start = new Date(b.start).getTime();
      const end = new Date(b.end).getTime();
      if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end });
    }
  }
  return busy.sort((a, b) => a.start - b.start);
}

/** Find the first gap of at least `durationMs` between `fromMs` and `toMs`. */
function findGap(
  busy: BusyInterval[],
  fromMs: number,
  toMs: number,
  durationMs: number,
): { start: number; end: number } | null {
  let cursor = fromMs;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start - cursor >= durationMs) return { start: cursor, end: cursor + durationMs };
    cursor = Math.max(cursor, b.end);
    if (cursor >= toMs) break;
  }
  if (toMs - cursor >= durationMs) return { start: cursor, end: cursor + durationMs };
  return null;
}

/** Coerce an ISO-ish string into a full RFC3339 timestamp Google accepts. */
function toDateTime(value: string): string {
  // Already has an explicit offset/zone — pass through untouched.
  if (value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value)) return value;
  // `YYYY-MM-DDTHH:MM` (no seconds) — append seconds so Google parses it.
  if (/T\d\d:\d\d$/.test(value)) return `${value}:00`;
  return value;
}

/** Build Google reminders override block from a list of minutes-before values. */
function buildReminders(minutes: number[] | undefined) {
  if (!minutes?.length) return undefined;
  return {
    useDefault: false,
    overrides: minutes.map((m) => ({ method: "popup", minutes: Math.max(0, Math.round(m)) })),
  };
}

// ============================================================
// Tool Schema & Handler
// ============================================================

export const calendarToolSchema = {
  name: "calendar",
  description: `Manage Google Calendar events — view, create, reschedule, and proactively schedule.
Actions: list_calendars, list_events, list_upcoming, create_event, update_event,
delete_event, cancel_event, move_event, find_free_slot, set_reminder, quick_add.

Examples:
- Upcoming agenda: { "action": "list_upcoming", "days": 7, "max": 20 }
- Create meeting: { "action": "create_event", "summary": "Team Standup", "start": "2025-02-17T10:00:00", "end": "2025-02-17T10:30:00", "attendees": ["a@x.com"], "reminders": [15, 1] }
- Reschedule: { "action": "move_event", "eventId": "abc123", "newStart": "2025-02-18T11:00:00", "newEnd": "2025-02-18T11:30:00" }
- Patch fields: { "action": "update_event", "eventId": "abc123", "patch": { "location": "Zoom", "description": "Bring deck" } }
- Cancel: { "action": "cancel_event", "eventId": "abc123" }
- Find a 30-min slot in the next 8h: { "action": "find_free_slot", "durationMinutes": 30, "withinHours": 8 }
- Add a reminder: { "action": "set_reminder", "eventId": "abc123", "minutesBefore": 10 }
- Quick add: { "action": "quick_add", "text": "Dinner with friends tomorrow 7pm" }`,
  parameters: z.object({
    action: z.enum([
      "list_calendars",
      "list_events",
      "list_upcoming",
      "create_event",
      "update_event",
      "delete_event",
      "cancel_event",
      "move_event",
      "find_free_slot",
      "set_reminder",
      "quick_add",
    ]),
    calendarId: z.string().optional().default("primary"),
    eventId: z.string().optional(),
    // For list_events
    timeMin: z.string().optional(),
    timeMax: z.string().optional(),
    maxResults: z.number().optional().default(50),
    // For list_upcoming
    days: z.number().optional(),
    max: z.number().optional(),
    // For create/update event
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    // Preferred ISO start/end for create/move; legacy *DateTime still accepted.
    start: z.string().optional(),
    end: z.string().optional(),
    startDateTime: z.string().optional(),
    endDateTime: z.string().optional(),
    startDate: z.string().optional(), // For all-day events
    endDate: z.string().optional(),
    timeZone: z.string().optional(),
    attendees: z.array(z.string()).optional(), // Email addresses
    // Minutes-before reminders for create_event (popup).
    reminders: z.array(z.number()).optional(),
    // For move_event
    newStart: z.string().optional(),
    newEnd: z.string().optional(),
    // For update_event (generic field patch)
    patch: z.record(z.string(), z.any()).optional(),
    // For find_free_slot
    durationMinutes: z.number().optional(),
    withinHours: z.number().optional(),
    // For set_reminder
    minutesBefore: z.number().optional(),
    // For quick_add
    text: z.string().optional(),
  }),
};

export async function handleCalendarTool(
  params: z.infer<(typeof calendarToolSchema)["parameters"]>,
): Promise<string> {
  if (!calendarCredentials) {
    return JSON.stringify({
      success: false,
      error: "Calendar not configured. Please connect Google Calendar in the Schedule settings.",
    });
  }

  try {
    switch (params.action) {
      case "list_calendars": {
        const calendars = await listCalendars();
        return JSON.stringify({
          success: true,
          calendars: calendars.map((c: any) => ({
            id: c.id,
            summary: c.summary,
            primary: c.primary,
            accessRole: c.accessRole,
            backgroundColor: c.backgroundColor,
          })),
        });
      }

      case "list_events": {
        const now = new Date();
        const timeMin = params.timeMin ? new Date(params.timeMin) : now;
        const timeMax = params.timeMax
          ? new Date(params.timeMax)
          : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // Default: next 7 days

        const events = await listEvents(
          params.calendarId || "primary",
          timeMin,
          timeMax,
          params.maxResults,
        );

        return JSON.stringify({
          success: true,
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            description: e.description,
            location: e.location,
            start: e.start,
            end: e.end,
            attendees: e.attendees?.map((a) => ({
              email: a.email,
              displayName: a.displayName,
              status: a.responseStatus,
            })),
            status: e.status,
            link: e.htmlLink,
            videoLink: e.hangoutLink,
          })),
          count: events.length,
          range: {
            from: timeMin.toISOString(),
            to: timeMax.toISOString(),
          },
        });
      }

      case "create_event": {
        if (!params.summary) {
          return JSON.stringify({ success: false, error: "Event summary is required" });
        }

        const event: any = {
          summary: params.summary,
          description: params.description,
          location: params.location,
        };

        // Handle date/time — prefer `start`/`end`, fall back to legacy *DateTime.
        const startDt = params.start || params.startDateTime;
        const endDt = params.end || params.endDateTime;
        const tz = params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (params.startDate && params.endDate) {
          // All-day event
          event.start = { date: params.startDate };
          event.end = { date: params.endDate };
        } else if (startDt && endDt) {
          event.start = { dateTime: toDateTime(startDt), timeZone: tz };
          event.end = { dateTime: toDateTime(endDt), timeZone: tz };
        } else {
          return JSON.stringify({
            success: false,
            error: "Event start and end times are required",
          });
        }

        // Handle attendees
        if (params.attendees?.length) {
          event.attendees = params.attendees.map((email: string) => ({ email }));
        }

        // Handle reminders (minutes-before popups)
        const reminders = buildReminders(params.reminders);
        if (reminders) event.reminders = reminders;

        const created = await createEvent(params.calendarId || "primary", event);

        return JSON.stringify({
          success: true,
          event: {
            id: created.id,
            summary: created.summary,
            start: created.start,
            end: created.end,
            link: created.htmlLink,
          },
          message: `Created event: ${created.summary}`,
        });
      }

      case "update_event": {
        if (!params.eventId) {
          return JSON.stringify({ success: false, error: "Event ID is required" });
        }

        // Start from a generic field patch if provided, then layer explicit params.
        const updates: any = { ...params.patch };
        if (params.summary) updates.summary = params.summary;
        if (params.description) updates.description = params.description;
        if (params.location) updates.location = params.location;
        if (params.reminders) updates.reminders = buildReminders(params.reminders);

        const uStart = params.start || params.startDateTime;
        const uEnd = params.end || params.endDateTime;
        if (uStart && uEnd) {
          updates.start = { dateTime: toDateTime(uStart), timeZone: params.timeZone };
          updates.end = { dateTime: toDateTime(uEnd), timeZone: params.timeZone };
        }

        const updated = await updateEvent(params.calendarId || "primary", params.eventId, updates);

        return JSON.stringify({
          success: true,
          event: {
            id: updated.id,
            summary: updated.summary,
            start: updated.start,
            end: updated.end,
          },
          message: `Updated event: ${updated.summary}`,
        });
      }

      case "delete_event": {
        if (!params.eventId) {
          return JSON.stringify({ success: false, error: "Event ID is required" });
        }

        await deleteEvent(params.calendarId || "primary", params.eventId);

        return JSON.stringify({
          success: true,
          message: `Deleted event ${params.eventId}`,
        });
      }

      case "cancel_event": {
        if (!params.eventId) {
          return JSON.stringify({ success: false, error: "Event ID is required" });
        }
        await deleteEvent(params.calendarId || "primary", params.eventId);
        return JSON.stringify({
          success: true,
          message: `Cancelled event ${params.eventId}`,
        });
      }

      case "move_event": {
        if (!params.eventId) {
          return JSON.stringify({ success: false, error: "Event ID is required" });
        }
        if (!params.newStart || !params.newEnd) {
          return JSON.stringify({ success: false, error: "newStart and newEnd are required" });
        }
        const tz = params.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        const updated = await updateEvent(params.calendarId || "primary", params.eventId, {
          start: { dateTime: toDateTime(params.newStart), timeZone: tz },
          end: { dateTime: toDateTime(params.newEnd), timeZone: tz },
        });
        return JSON.stringify({
          success: true,
          event: {
            id: updated.id,
            summary: updated.summary,
            start: updated.start,
            end: updated.end,
          },
          message: `Moved event: ${updated.summary}`,
        });
      }

      case "find_free_slot": {
        const durationMinutes = params.durationMinutes ?? 30;
        const withinHours = params.withinHours ?? 24;
        const from = new Date();
        const to = new Date(from.getTime() + withinHours * 60 * 60 * 1000);
        const calendarIds = [params.calendarId || "primary", ...(params.attendees || [])];
        const busy = await queryBusy(calendarIds, from, to);
        const slot = findGap(busy, from.getTime(), to.getTime(), durationMinutes * 60 * 1000);
        if (!slot) {
          return JSON.stringify({
            success: false,
            error: `No free ${durationMinutes}-minute slot found in the next ${withinHours}h`,
          });
        }
        return JSON.stringify({
          success: true,
          start: new Date(slot.start).toISOString(),
          end: new Date(slot.end).toISOString(),
          message: `Free ${durationMinutes}-minute slot found`,
        });
      }

      case "set_reminder": {
        if (!params.eventId) {
          return JSON.stringify({ success: false, error: "Event ID is required" });
        }
        if (params.minutesBefore == null) {
          return JSON.stringify({ success: false, error: "minutesBefore is required" });
        }
        const updated = await updateEvent(params.calendarId || "primary", params.eventId, {
          reminders: buildReminders([params.minutesBefore]),
        } as any);
        return JSON.stringify({
          success: true,
          event: { id: updated.id, summary: updated.summary },
          message: `Reminder set ${params.minutesBefore} min before ${updated.summary}`,
        });
      }

      case "list_upcoming": {
        const now = new Date();
        const days = params.days ?? 7;
        const max = params.max ?? params.maxResults ?? 20;
        const events = await listEvents(
          params.calendarId || "primary",
          now,
          new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
          max,
        );
        return JSON.stringify({
          success: true,
          events: events.map((e) => ({
            id: e.id,
            summary: e.summary,
            location: e.location,
            start: e.start,
            end: e.end,
            link: e.htmlLink,
          })),
          count: events.length,
        });
      }

      case "quick_add": {
        if (!params.text) {
          return JSON.stringify({ success: false, error: "Event text is required" });
        }

        const created = await quickAddEvent(params.calendarId || "primary", params.text);

        return JSON.stringify({
          success: true,
          event: {
            id: created.id,
            summary: created.summary,
            start: created.start,
            end: created.end,
            link: created.htmlLink,
          },
          message: `Created event: ${created.summary}`,
        });
      }

      default:
        return JSON.stringify({ success: false, error: `Unknown action: ${params.action}` });
    }
  } catch (error: any) {
    console.error("[Calendar] Calendar tool error:", error.message);
    return JSON.stringify({
      success: false,
      error: error.message,
    });
  }
}

// ============================================================
// Formatted Output Helpers
// ============================================================

export function formatEventsList(events: CalendarEvent[]): string {
  if (!events.length) return "No events found.";

  const lines: string[] = ["📅 **Upcoming Events**", ""];

  const groupedByDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const dateKey = new Date(event.start.dateTime || event.start.date!).toDateString();
    if (!groupedByDate.has(dateKey)) groupedByDate.set(dateKey, []);
    groupedByDate.get(dateKey)!.push(event);
  }

  for (const [dateKey, dayEvents] of groupedByDate) {
    const date = new Date(dateKey);
    const today = new Date();
    const isToday = date.toDateString() === today.toDateString();
    const isTomorrow = date.toDateString() === new Date(today.getTime() + 86400000).toDateString();

    let dayLabel = date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    if (isToday) dayLabel = `**Today** (${dayLabel})`;
    else if (isTomorrow) dayLabel = `**Tomorrow** (${dayLabel})`;

    lines.push(`### ${dayLabel}`);

    for (const event of dayEvents) {
      const time = event.start.date ? "All day" : formatTime(event.start.dateTime!);
      const duration = event.start.date
        ? ""
        : ` (${formatDuration(event.start.dateTime!, event.end.dateTime!)})`;

      lines.push(`- **${time}${duration}**: ${event.summary}`);
      if (event.location) lines.push(`  📍 ${event.location}`);
      if (event.hangoutLink) lines.push(`  🎥 [Join Video Call](${event.hangoutLink})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatTime(dateTime: string): string {
  return new Date(dateTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}
