/**
 * Calendar Controller — Google Calendar Integration
 * Full calendar management with OAuth2, events CRUD, and alerts
 */

import type { GatewayBrowserClient } from "../gateway";

// ============================================================
// Types
// ============================================================

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  end: {
    dateTime?: string;
    date?: string;
    timeZone?: string;
  };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: "needsAction" | "declined" | "tentative" | "accepted";
    self?: boolean;
    organizer?: boolean;
  }>;
  status?: "confirmed" | "tentative" | "cancelled";
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType: string;
      uri: string;
      label?: string;
    }>;
  };
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{
      method: "email" | "popup";
      minutes: number;
    }>;
  };
  colorId?: string;
  created?: string;
  updated?: string;
  recurringEventId?: string;
  originalStartTime?: {
    dateTime?: string;
    date?: string;
  };
}

export interface Calendar {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
  selected?: boolean;
  timeZone?: string;
}

export interface CalendarSettings {
  // OAuth2 settings
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  
  // Calendar preferences
  defaultCalendarId: string;
  selectedCalendars: string[];
  defaultView: "day" | "week" | "month" | "agenda";
  weekStartsOn: 0 | 1 | 6; // Sunday, Monday, Saturday
  workingHoursStart: string; // "09:00"
  workingHoursEnd: string;   // "17:00"
  timeZone: string;
  
  // Alert settings
  alertsEnabled: boolean;
  defaultReminderMinutes: number;
  alertChannels: ("notification" | "telegram" | "discord" | "email")[];
  
  // MCP settings
  mcpEnabled: boolean;
  mcpAutoSync: boolean;
  mcpSyncIntervalMinutes: number;
}

export interface CalendarState {
  connected: boolean;
  loading: boolean;
  error: string | null;
  calendars: Calendar[];
  events: CalendarEvent[];
  selectedDate: Date;
  view: "day" | "week" | "month" | "agenda";
  settings: CalendarSettings;
}

// ============================================================
// Storage
// ============================================================

const STORAGE_KEY = "infinibot-calendar-settings";
const TOKEN_STORAGE_KEY = "infinibot-calendar-tokens";

function defaultSettings(): CalendarSettings {
  return {
    clientId: "",
    clientSecret: "",
    refreshToken: "",
    accessToken: "",
    tokenExpiry: 0,
    defaultCalendarId: "primary",
    selectedCalendars: ["primary"],
    defaultView: "week",
    weekStartsOn: 1,
    workingHoursStart: "09:00",
    workingHoursEnd: "17:00",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    alertsEnabled: true,
    defaultReminderMinutes: 15,
    alertChannels: ["notification"],
    mcpEnabled: true,
    mcpAutoSync: true,
    mcpSyncIntervalMinutes: 5,
  };
}

export function loadCalendarSettings(): CalendarSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const tokens = loadTokens();
    
    console.log("[Calendar] Loading settings...");
    console.log("[Calendar] Has stored settings:", Boolean(raw));
    console.log("[Calendar] Has refresh token:", Boolean(tokens.refreshToken));
    
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = { ...defaultSettings(), ...parsed, ...tokens };
      console.log("[Calendar] Loaded settings, connected:", Boolean(merged.refreshToken));
      return merged;
    }
    
    // Even without saved settings, merge tokens if they exist
    if (tokens.refreshToken) {
      return { ...defaultSettings(), ...tokens };
    }
  } catch (e) {
    console.error("[Calendar] Failed to load settings:", e);
  }
  return defaultSettings();
}

export function saveCalendarSettings(settings: CalendarSettings) {
  try {
    // Save sensitive data (tokens + clientSecret) separately
    saveTokens({
      accessToken: settings.accessToken,
      refreshToken: settings.refreshToken,
      tokenExpiry: settings.tokenExpiry,
      clientSecret: settings.clientSecret,
    });
    
    // Save settings without sensitive data
    const { accessToken, refreshToken, tokenExpiry, clientSecret, ...safeSettings } = settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeSettings));
    
    console.log("[Calendar] Settings saved. Connected:", Boolean(settings.refreshToken));
  } catch (e) {
    console.error("[Calendar] Failed to save settings:", e);
  }
}

function loadTokens(): Partial<CalendarSettings> {
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

// ============================================================
// Gateway-backed credential sync
// ============================================================
//
// Google Calendar creds (clientId / clientSecret / refresh+access tokens)
// are persisted to the gateway config under integrations.calendar so the
// connection survives across browsers and devices. The browser still
// mirrors them to localStorage for offline render, but the gateway copy
// is the source of truth — `pullCalendarSettingsFromGateway` runs on
// schedule view init and overrides any stale local cache.
//
// The gateway never returns the clientSecret to the browser (only a
// `hasClientSecret` boolean), so we keep whatever secret is in the local
// mirror untouched when pulling.

interface GatewayLikeClient {
  request: (method: string, params?: unknown) => Promise<unknown>;
}

export async function pullCalendarSettingsFromGateway(
  client: GatewayLikeClient,
): Promise<CalendarSettings | null> {
  try {
    const res = (await client.request("calendar.config.get", {})) as
      | {
          clientId?: string;
          hasClientSecret?: boolean;
          refreshToken?: string;
          accessToken?: string;
          tokenExpiry?: number;
        }
      | undefined;
    if (!res) return null;
    const current = loadCalendarSettings();
    const merged: CalendarSettings = {
      ...current,
      clientId: res.clientId || current.clientId,
      refreshToken: res.refreshToken || current.refreshToken,
      accessToken: res.accessToken || current.accessToken,
      tokenExpiry: typeof res.tokenExpiry === "number" && res.tokenExpiry > 0
        ? res.tokenExpiry
        : current.tokenExpiry,
    };
    // Gateway intentionally never returns clientSecret, so any client-side
    // refresh path (`refreshAccessToken` below) will fail when this hydration
    // is the user's only source of creds (e.g. they just opened the schedule
    // on a fresh browser/tab/machine). If the access token is missing or
    // already expired, mint a fresh one server-side BEFORE handing the
    // settings back to the view — otherwise the very next listEvents call
    // 401s and refreshEvents silently returns []. That was the canonical
    // "creds connected but no events show up" symptom.
    const needsFreshToken =
      Boolean(merged.refreshToken) &&
      (!merged.accessToken || !merged.tokenExpiry || Date.now() > merged.tokenExpiry - 60_000);
    const localCanRefresh = Boolean(merged.clientSecret && merged.clientId);
    if (needsFreshToken && !localCanRefresh) {
      try {
        const fresh = (await client.request("calendar.token.refresh", {})) as
          | { accessToken?: string; tokenExpiry?: number }
          | undefined;
        if (fresh?.accessToken) {
          merged.accessToken = fresh.accessToken;
          merged.tokenExpiry = typeof fresh.tokenExpiry === "number"
            ? fresh.tokenExpiry
            : Date.now() + 55 * 60_000;
        }
      } catch (e) {
        console.warn("[Calendar] gateway-side token refresh failed:", e);
      }
    }
    saveCalendarSettings(merged);
    return merged;
  } catch (e) {
    console.warn("[Calendar] pull from gateway failed:", e);
    return null;
  }
}

/**
 * Ask the gateway to mint a fresh Google access token using the server-held
 * clientSecret. The browser calls this when its locally-cached token expires
 * mid-session and no clientSecret is available client-side (i.e. settings
 * were hydrated from gateway rather than entered locally). Best-effort: a
 * failure here means the user needs to reconnect calendar; callers should
 * surface that, not silently swallow.
 */
export async function refreshAccessTokenViaGateway(
  client: GatewayLikeClient,
  settings: CalendarSettings,
): Promise<boolean> {
  try {
    const fresh = (await client.request("calendar.token.refresh", {})) as
      | { accessToken?: string; tokenExpiry?: number }
      | undefined;
    if (!fresh?.accessToken) return false;
    settings.accessToken = fresh.accessToken;
    settings.tokenExpiry = typeof fresh.tokenExpiry === "number"
      ? fresh.tokenExpiry
      : Date.now() + 55 * 60_000;
    saveCalendarSettings(settings);
    return true;
  } catch (e) {
    console.warn("[Calendar] gateway token refresh failed:", e);
    return false;
  }
}

export async function pushCalendarCredsToGateway(
  client: GatewayLikeClient,
  settings: CalendarSettings,
  opts: { clear?: boolean } = {},
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      clientId: settings.clientId,
      refreshToken: settings.refreshToken,
      accessToken: settings.accessToken,
      tokenExpiry: settings.tokenExpiry,
    };
    if (settings.clientSecret) payload.clientSecret = settings.clientSecret;
    if (opts.clear) payload.clear = true;
    await client.request("calendar.config.set", payload);
  } catch (e) {
    console.warn("[Calendar] push to gateway failed:", e);
  }
}

function saveTokens(tokens: {
  accessToken?: string; 
  refreshToken?: string; 
  tokenExpiry?: number;
  clientSecret?: string;
}) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
  } catch {}
}

// ============================================================
// State Factory
// ============================================================

export function createCalendarState(): CalendarState {
  const settings = loadCalendarSettings();
  const connected = Boolean(settings.refreshToken);
  
  console.log("[Calendar] Creating state, connected:", connected);
  
  return {
    connected,
    loading: false,
    error: null,
    calendars: [],
    events: [],
    selectedDate: new Date(),
    view: settings.defaultView,
    settings,
  };
}

// ============================================================
// Google Calendar API — via Gateway Proxy
// ============================================================

const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Generate OAuth2 authorization URL
 */
export function getAuthUrl(clientId: string, redirectUri: string): string {
  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.events",
  ].join(" ");
  
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
  });
  
  return `${GOOGLE_OAUTH_URL}?${params}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error_description || "Failed to exchange code");
  }
  
  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh access token
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error_description || "Failed to refresh token");
  }
  
  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Make authenticated API request
 */
async function calendarApiRequest(
  endpoint: string,
  settings: CalendarSettings,
  options: RequestInit = {}
): Promise<any> {
  // Check if token needs refresh
  if (settings.tokenExpiry && Date.now() > settings.tokenExpiry - 60000) {
    const tokens = await refreshAccessToken(
      settings.refreshToken,
      settings.clientId,
      settings.clientSecret
    );
    settings.accessToken = tokens.accessToken;
    settings.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
    saveCalendarSettings(settings);
  }
  
  const response = await fetch(`${GOOGLE_CALENDAR_API}${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${settings.accessToken}`,
      "Content-Type": "application/json",
    },
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API error: ${response.status}`);
  }
  
  return response.json();
}

// ============================================================
// Calendar Operations
// ============================================================

/**
 * List all calendars
 */
export async function listCalendars(settings: CalendarSettings): Promise<Calendar[]> {
  const data = await calendarApiRequest("/users/me/calendarList", settings);
  return data.items || [];
}

/**
 * List events for a date range
 */
export async function listEvents(
  settings: CalendarSettings,
  calendarId: string,
  timeMin: Date,
  timeMax: Date,
  maxResults: number = 250
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
    settings
  );
  
  return (data.items || []).map((e: any) => ({ ...e, calendarId }));
}

/**
 * Get single event
 */
export async function getEvent(
  settings: CalendarSettings,
  calendarId: string,
  eventId: string
): Promise<CalendarEvent> {
  const event = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    settings
  );
  return { ...event, calendarId };
}

/**
 * Create new event
 */
export async function createEvent(
  settings: CalendarSettings,
  calendarId: string,
  event: Partial<CalendarEvent>
): Promise<CalendarEvent> {
  const created = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    settings,
    {
      method: "POST",
      body: JSON.stringify(event),
    }
  );
  return { ...created, calendarId };
}

/**
 * Update existing event
 */
export async function updateEvent(
  settings: CalendarSettings,
  calendarId: string,
  eventId: string,
  updates: Partial<CalendarEvent>
): Promise<CalendarEvent> {
  const updated = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    settings,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    }
  );
  return { ...updated, calendarId };
}

/**
 * Delete event
 */
export async function deleteEvent(
  settings: CalendarSettings,
  calendarId: string,
  eventId: string
): Promise<void> {
  await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    settings,
    { method: "DELETE" }
  );
}

/**
 * Quick add event (natural language)
 */
export async function quickAddEvent(
  settings: CalendarSettings,
  calendarId: string,
  text: string
): Promise<CalendarEvent> {
  const created = await calendarApiRequest(
    `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`,
    settings,
    { method: "POST" }
  );
  return { ...created, calendarId };
}

// ============================================================
// Event Helpers
// ============================================================

/**
 * Get events for multiple calendars
 */
export async function listAllEvents(
  settings: CalendarSettings,
  calendarIds: string[],
  timeMin: Date,
  timeMax: Date
): Promise<CalendarEvent[]> {
  const allEvents: CalendarEvent[] = [];
  
  await Promise.all(
    calendarIds.map(async (calId) => {
      try {
        const events = await listEvents(settings, calId, timeMin, timeMax);
        allEvents.push(...events);
      } catch (e) {
        console.warn(`Failed to fetch events for calendar ${calId}:`, e);
      }
    })
  );
  
  // Sort by start time
  return allEvents.sort((a, b) => {
    const aTime = new Date(a.start.dateTime || a.start.date || 0).getTime();
    const bTime = new Date(b.start.dateTime || b.start.date || 0).getTime();
    return aTime - bTime;
  });
}

/**
 * Get events for today
 */
export async function getTodaysEvents(settings: CalendarSettings): Promise<CalendarEvent[]> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  
  return listAllEvents(settings, settings.selectedCalendars, startOfDay, endOfDay);
}

/**
 * Get upcoming events
 */
export async function getUpcomingEvents(
  settings: CalendarSettings,
  hours: number = 24
): Promise<CalendarEvent[]> {
  const now = new Date();
  const future = new Date(now.getTime() + hours * 60 * 60 * 1000);
  
  return listAllEvents(settings, settings.selectedCalendars, now, future);
}

/**
 * Get week's events
 */
export async function getWeekEvents(
  settings: CalendarSettings,
  date: Date = new Date()
): Promise<CalendarEvent[]> {
  const dayOfWeek = date.getDay();
  const diff = (dayOfWeek < settings.weekStartsOn ? 7 : 0) + dayOfWeek - settings.weekStartsOn;
  
  const startOfWeek = new Date(date);
  startOfWeek.setDate(date.getDate() - diff);
  startOfWeek.setHours(0, 0, 0, 0);
  
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);
  
  return listAllEvents(settings, settings.selectedCalendars, startOfWeek, endOfWeek);
}

/**
 * Get month's events
 */
export async function getMonthEvents(
  settings: CalendarSettings,
  date: Date = new Date()
): Promise<CalendarEvent[]> {
  const startOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const endOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
  
  return listAllEvents(settings, settings.selectedCalendars, startOfMonth, endOfMonth);
}

// ============================================================
// Date Helpers
// ============================================================

export function formatEventTime(event: CalendarEvent): string {
  if (event.start.date) {
    // All-day event
    return "All day";
  }
  
  const start = new Date(event.start.dateTime!);
  const end = new Date(event.end.dateTime!);
  
  const startTime = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const endTime = end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  
  return `${startTime} - ${endTime}`;
}

export function formatEventDate(event: CalendarEvent): string {
  const date = new Date(event.start.dateTime || event.start.date!);
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

export function isAllDayEvent(event: CalendarEvent): boolean {
  return Boolean(event.start.date && !event.start.dateTime);
}

export function getEventDuration(event: CalendarEvent): number {
  if (isAllDayEvent(event)) return 24 * 60; // All day = 24 hours in minutes
  
  const start = new Date(event.start.dateTime!).getTime();
  const end = new Date(event.end.dateTime!).getTime();
  
  return Math.round((end - start) / (1000 * 60)); // Duration in minutes
}

export function isEventInProgress(event: CalendarEvent): boolean {
  const now = Date.now();
  const start = new Date(event.start.dateTime || event.start.date!).getTime();
  const end = new Date(event.end.dateTime || event.end.date!).getTime();
  
  return now >= start && now <= end;
}

export function isEventPast(event: CalendarEvent): boolean {
  const now = Date.now();
  const end = new Date(event.end.dateTime || event.end.date!).getTime();
  
  return now > end;
}

// ============================================================
// Color Mapping
// ============================================================

const GOOGLE_CALENDAR_COLORS: Record<string, { bg: string; fg: string }> = {
  "1": { bg: "#7986cb", fg: "#1d1d1d" },  // Lavender
  "2": { bg: "#33b679", fg: "#1d1d1d" },  // Sage
  "3": { bg: "#8e24aa", fg: "#ffffff" },  // Grape
  "4": { bg: "#e67c73", fg: "#1d1d1d" },  // Flamingo
  "5": { bg: "#f6bf26", fg: "#1d1d1d" },  // Banana
  "6": { bg: "#f4511e", fg: "#ffffff" },  // Tangerine
  "7": { bg: "#039be5", fg: "#ffffff" },  // Peacock
  "8": { bg: "#616161", fg: "#ffffff" },  // Graphite
  "9": { bg: "#3f51b5", fg: "#ffffff" },  // Blueberry
  "10": { bg: "#0b8043", fg: "#ffffff" }, // Basil
  "11": { bg: "#d50000", fg: "#ffffff" }, // Tomato
};

export function getEventColor(event: CalendarEvent, calendar?: Calendar): { bg: string; fg: string } {
  if (event.colorId && GOOGLE_CALENDAR_COLORS[event.colorId]) {
    return GOOGLE_CALENDAR_COLORS[event.colorId];
  }
  if (calendar?.backgroundColor) {
    return { bg: calendar.backgroundColor, fg: calendar.foregroundColor || "#fff" };
  }
  return { bg: "#039be5", fg: "#ffffff" }; // Default blue
}
