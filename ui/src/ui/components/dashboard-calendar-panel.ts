/**
 * <dashboard-calendar-panel> — slim agenda preview for the dashboard world-map band.
 *
 * Sits beside <agency-world-viz>. On connect it loads the stored Google Calendar
 * settings (via the existing calendar controller) and fetches the next 7 days of
 * events, re-polling every 60s while connected.
 *
 * Layout: compact agenda grouped into Today / Tomorrow / Later this week. Today's
 * rows show a relative countdown ("in 23m"); other rows show a weekday + clock.
 *
 * Empty state: "No upcoming events", with a "Connect Google Calendar →" CTA when
 * the events fetch reports the calendar is not authenticated.
 *
 * Emits (bubbles + composed):
 *   - "dashboard-open-calendar" {}  -> host navigates to the schedule view.
 *
 * Side-effect-free on import beyond the customElement registration.
 */

import { LitElement, html, css, unsafeCSS, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import {
  loadCalendarSettings,
  getUpcomingEvents,
  isAllDayEvent,
  type CalendarEvent,
} from "../controllers/calendar.js";

/* Dynamic theme tokens — the hex literals are fallbacks only so the panel still
   renders if the glass-theme variables haven't been installed on :root. */
const GOLD = unsafeCSS("var(--g-primary, #d4af37)");
const BG = unsafeCSS("var(--g-bg, #06000f)");
const PRIMARY_SOFT = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 7.5%, transparent)");
const PRIMARY_MUTED = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent)");
const PRIMARY_LINE = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 32%, transparent)");
const PRIMARY_GLOW = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 42%, transparent)");
const PRIMARY_TINT = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 12%, transparent)");
const PRIMARY_SCRIM = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 9.5%, transparent)");
const PRIMARY_HAIRLINE = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 2.8%, transparent)");
const PRIMARY_RIM = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 22%, transparent)");
const PRIMARY_HALO = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 26%, transparent)");
const PRIMARY_GLOW_SOFT = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent)");
const PRIMARY_GLOW_SOFTER = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 5.5%, transparent)");
const PRIMARY_BTN = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 20%, transparent)");
const PRIMARY_BTN_HOVER = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 28%, transparent)");
const PRIMARY_BTN_BORDER = unsafeCSS("color-mix(in srgb, var(--g-primary, #d4af37) 50%, transparent)");
const ACCENT_BTN = unsafeCSS("color-mix(in srgb, var(--g-accent, #7c3aed) 22%, transparent)");
const ACCENT_BTN_HOVER = unsafeCSS("color-mix(in srgb, var(--g-accent, #7c3aed) 28%, transparent)");
const ACCENT_TINT = unsafeCSS("color-mix(in srgb, var(--g-accent, #7c3aed) 10%, transparent)");

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 60_000;
const LOOKAHEAD_HOURS = 7 * 24;

type Status = "loading" | "ready" | "unauthenticated" | "error";

interface AgendaGroup {
  key: "today" | "tomorrow" | "later";
  label: string;
  events: CalendarEvent[];
}

function eventStartMs(e: CalendarEvent): number {
  return new Date(e.start.dateTime || e.start.date || 0).getTime();
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Group upcoming events into today / tomorrow / later-this-week buckets. */
function groupEvents(events: CalendarEvent[]): AgendaGroup[] {
  const todayStart = startOfDay(Date.now());
  const tomorrowStart = todayStart + DAY_MS;
  const dayAfterStart = tomorrowStart + DAY_MS;

  const today: CalendarEvent[] = [];
  const tomorrow: CalendarEvent[] = [];
  const later: CalendarEvent[] = [];

  for (const e of events) {
    const ms = eventStartMs(e);
    if (ms < tomorrowStart) today.push(e);
    else if (ms < dayAfterStart) tomorrow.push(e);
    else later.push(e);
  }

  const groups: AgendaGroup[] = [
    { key: "today", label: "Today", events: today },
    { key: "tomorrow", label: "Tomorrow", events: tomorrow },
    { key: "later", label: "Later this week", events: later },
  ];
  return groups.filter((g) => g.events.length > 0);
}

/** Relative countdown for today's events, e.g. "now", "in 23m", "in 2h". */
function relativeTime(e: CalendarEvent): string {
  if (isAllDayEvent(e)) return "All day";
  const ms = eventStartMs(e);
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
}

/** Clock time (or weekday for later events). */
function clockTime(e: CalendarEvent): string {
  if (isAllDayEvent(e)) return "All day";
  return new Date(e.start.dateTime!).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function weekday(e: CalendarEvent): string {
  return new Date(e.start.dateTime || e.start.date!).toLocaleDateString([], {
    weekday: "short",
  });
}

function meetingLink(e: CalendarEvent): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  const ep = e.conferenceData?.entryPoints?.find((p) => p.uri);
  return ep?.uri ?? null;
}

@customElement("dashboard-calendar-panel")
export class DashboardCalendarPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Number }) maxItems = 6;

  @state() private status: Status = "loading";
  @state() private events: CalendarEvent[] = [];

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refresh() {
    const settings = loadCalendarSettings();
    if (!settings.refreshToken) {
      this.status = "unauthenticated";
      this.events = [];
      return;
    }
    try {
      const events = await getUpcomingEvents(settings, LOOKAHEAD_HOURS);
      this.events = events;
      this.status = "ready";
    } catch (err) {
      // A 401/invalid-grant means the stored token is no longer good — treat as
      // "needs to (re)connect" rather than a hard error so the CTA shows.
      const msg = String((err as Error)?.message || "").toLowerCase();
      if (
        msg.includes("401") ||
        msg.includes("unauth") ||
        msg.includes("invalid_grant") ||
        msg.includes("invalid grant") ||
        msg.includes("token")
      ) {
        this.status = "unauthenticated";
        this.events = [];
      } else {
        this.status = "error";
        console.warn("[dashboard-calendar-panel] fetch failed", err);
      }
    }
  }

  private emitOpen = () => {
    this.dispatchEvent(
      new CustomEvent("dashboard-open-calendar", {
        bubbles: true,
        composed: true,
      }),
    );
  };

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
      color: #e4e4e7;
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    .panel {
      position: relative;
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      min-height: 0;
      background:
        linear-gradient(135deg, ${PRIMARY_SOFT}, rgba(255, 255, 255, 0.018) 48%, rgba(0, 0, 0, 0.44)),
        radial-gradient(110% 80% at 18% 0%, ${PRIMARY_TINT}, transparent 60%),
        radial-gradient(95% 85% at 100% 8%, ${ACCENT_TINT}, transparent 66%),
        ${BG};
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 32%, transparent);
      border-radius: 12px;
      overflow: hidden;
      backdrop-filter: blur(22px) saturate(150%);
      -webkit-backdrop-filter: blur(22px) saturate(150%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.04),
        inset 0 0 34px ${PRIMARY_GLOW_SOFTER},
        0 18px 40px -18px rgba(0, 0, 0, 0.7);
    }
    .panel::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.035), transparent 24%),
        repeating-linear-gradient(
          180deg,
          transparent 0,
          transparent 22px,
          ${PRIMARY_HAIRLINE} 22px,
          ${PRIMARY_HAIRLINE} 23px
        );
      opacity: 0.75;
    }
    .hdr {
      position: relative;
      z-index: 1;
      flex: none;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 14px 16px 12px;
      border-bottom: 1px solid ${PRIMARY_MUTED};
      background: linear-gradient(180deg, ${PRIMARY_SCRIM}, transparent);
    }
    .eyebrow {
      font-family: "Space Grotesk", system-ui, sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5em;
      text-transform: uppercase;
      color: ${GOLD};
    }
    .eyebrow::before {
      content: "";
      display: inline-block;
      width: 24px;
      height: 1px;
      margin-right: 9px;
      vertical-align: middle;
      background: ${GOLD};
      box-shadow: 0 0 10px ${PRIMARY_GLOW};
    }
    .title {
      font-family: "Space Grotesk", system-ui, sans-serif;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.01em;
      color: #fff;
      margin-top: 4px;
    }
    .count {
      font-size: 10px;
      color: rgba(245, 245, 244, 0.58);
      white-space: nowrap;
    }
    .body {
      position: relative;
      z-index: 1;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 12px 12px;
      scrollbar-color: color-mix(in srgb, var(--g-primary, #d4af37) 35%, transparent) transparent;
    }
    .group-label {
      display: flex;
      align-items: center;
      gap: 9px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: ${GOLD};
      padding: 11px 2px 7px;
      text-shadow: 0 0 12px ${PRIMARY_MUTED};
    }
    .group-label::after {
      content: "";
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, ${PRIMARY_LINE}, transparent);
    }
    .group:first-child .group-label {
      padding-top: 2px;
    }
    .ev {
      display: flex;
      align-items: baseline;
      gap: 9px;
      padding: 9px 9px 9px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.055);
      background: rgba(0, 0, 0, 0.18);
      transition:
        background 0.12s ease,
        border-color 0.12s ease,
        transform 0.12s ease;
    }
    .ev + .ev {
      margin-top: 6px;
    }
    .ev:hover {
      background: ${PRIMARY_SOFT};
      border-color: ${PRIMARY_RIM};
      transform: translateY(-1px);
    }
    .ev--today {
      border-left: 2px solid ${GOLD};
      background:
        linear-gradient(90deg, ${PRIMARY_TINT}, rgba(0, 0, 0, 0.18) 42%),
        rgba(0, 0, 0, 0.18);
    }
    .ev .when {
      flex: none;
      width: 66px;
      font-size: 10px;
      color: ${GOLD};
      text-align: right;
      line-height: 1.35;
      text-shadow: 0 0 10px ${PRIMARY_MUTED};
    }
    .ev .when .wd {
      color: rgba(245, 245, 244, 0.58);
      margin-right: 4px;
    }
    .ev .meta {
      flex: 1;
      min-width: 0;
    }
    .ev .summary {
      font-size: 11.5px;
      font-weight: 650;
      color: rgba(255, 255, 255, 0.92);
      line-height: 1.35;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ev .sub {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 9px;
      color: rgba(245, 245, 244, 0.42);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ev .sub .ic {
      font-size: 9px;
      opacity: 0.85;
    }
    .empty {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      height: 100%;
      padding: 20px 16px;
      text-align: center;
    }
    .empty .glyph {
      font-size: 22px;
      color: ${GOLD};
      opacity: 0.85;
      filter: drop-shadow(0 0 12px ${PRIMARY_HALO});
    }
    .empty .msg {
      font-size: 11.5px;
      color: rgba(245, 245, 244, 0.56);
    }
    .cta {
      font-family: inherit;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #fff;
      background: linear-gradient(120deg, ${ACCENT_BTN}, ${PRIMARY_BTN});
      border: 1px solid ${PRIMARY_BTN_BORDER};
      border-radius: 999px;
      padding: 8px 13px;
      cursor: pointer;
      transition:
        background 0.15s ease,
        box-shadow 0.15s ease,
        transform 0.12s ease;
    }
    .cta:hover {
      background: linear-gradient(120deg, ${ACCENT_BTN_HOVER}, ${PRIMARY_BTN_HOVER});
      box-shadow: 0 8px 22px ${PRIMARY_GLOW_SOFT};
      transform: translateY(-1px);
    }
    .skeleton {
      position: relative;
      z-index: 1;
      padding: 14px 12px;
    }
    .skeleton .ln {
      height: 11px;
      border-radius: 4px;
      margin-bottom: 10px;
      background: linear-gradient(
        100deg,
        rgba(255, 255, 255, 0.03) 30%,
        ${PRIMARY_SCRIM} 50%,
        rgba(255, 255, 255, 0.03) 70%
      );
      background-size: 200% 100%;
      animation: cal-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton .ln.short {
      width: 55%;
    }
    @keyframes cal-shimmer {
      0% {
        background-position: 200% 0;
      }
      100% {
        background-position: -100% 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .skeleton .ln {
        animation: none;
      }
    }
    .ftr {
      position: relative;
      z-index: 1;
      flex: none;
      padding: 10px 12px 12px;
      border-top: 1px solid ${PRIMARY_MUTED};
      background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.26));
    }
    .ftr button {
      width: 100%;
      font-family: inherit;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #fff;
      background: linear-gradient(120deg, ${ACCENT_BTN}, ${PRIMARY_BTN});
      border: 1px solid ${PRIMARY_BTN_BORDER};
      border-radius: 999px;
      padding: 9px 12px;
      cursor: pointer;
      transition:
        background 0.15s ease,
        box-shadow 0.15s ease,
        transform 0.12s ease;
    }
    .ftr button:hover {
      background: linear-gradient(120deg, ${ACCENT_BTN_HOVER}, ${PRIMARY_BTN_HOVER});
      box-shadow: 0 8px 22px ${PRIMARY_GLOW_SOFT};
      transform: translateY(-1px);
    }
    @media (prefers-reduced-motion: reduce) {
      .ev,
      .cta,
      .ftr button {
        transition: none;
      }
      .ev:hover,
      .cta:hover,
      .ftr button:hover {
        transform: none;
      }
    }
  `;

  render() {
    return html`
      <div class="panel">
        <header class="hdr">
          <div>
            <div class="eyebrow">Agenda</div>
            <div class="title">Calendar</div>
          </div>
          ${this.status === "ready" && this.events.length
            ? html`<span class="count"
                >${Math.min(this.events.length, this.maxItems)} of
                ${this.events.length}</span
              >`
            : nothing}
        </header>
        <div class="body">${this.renderBody()}</div>
        <div class="ftr">
          <button @click=${this.emitOpen}>View calendar →</button>
        </div>
      </div>
    `;
  }

  private renderBody() {
    if (this.status === "loading") {
      return html`<div class="skeleton">
        <div class="ln"></div>
        <div class="ln short"></div>
        <div class="ln"></div>
        <div class="ln short"></div>
      </div>`;
    }

    if (this.status === "unauthenticated") {
      return html`<div class="empty">
        <div class="glyph">${icons.calendar}</div>
        <div class="msg">No upcoming events</div>
        <button class="cta" @click=${this.emitOpen}>
          Connect Google Calendar →
        </button>
      </div>`;
    }

    if (this.status === "error") {
      return html`<div class="empty">
        <div class="glyph">${icons.alert}</div>
        <div class="msg">Couldn't load events</div>
      </div>`;
    }

    if (!this.events.length) {
      return html`<div class="empty">
        <div class="glyph">${icons.calendar}</div>
        <div class="msg">No upcoming events</div>
      </div>`;
    }

    const shown = this.events.slice(0, this.maxItems);
    const groups = groupEvents(shown);
    return groups.map(
      (g) => html`
        <div class="group">
          <div class="group-label">${g.label}</div>
          ${g.events.map((e) => this.renderEvent(e, g.key))}
        </div>
      `,
    );
  }

  private renderEvent(e: CalendarEvent, group: AgendaGroup["key"]) {
    const when =
      group === "today"
        ? html`${relativeTime(e)}`
        : group === "tomorrow"
          ? html`${clockTime(e)}`
          : html`<span class="wd">${weekday(e)}</span>${clockTime(e)}`;
    const link = meetingLink(e);
    const loc = e.location;
    const sub = link
      ? html`<span class="ic">${icons.link}</span>Meeting link`
      : loc
        ? html`<span class="ic">${icons.globe}</span>${loc}`
        : nothing;
    return html`
      <div class=${`ev ${group === "today" ? "ev--today" : ""}`} title=${e.summary || "(no title)"}>
        <div class="when">${when}</div>
        <div class="meta">
          <div class="summary">${e.summary || "(no title)"}</div>
          ${sub === nothing ? nothing : html`<div class="sub">${sub}</div>`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dashboard-calendar-panel": DashboardCalendarPanel;
  }
}
