/**
 * <content-posting-panel> — the "Posting" tab of a content page.
 *
 * Binds the page to one Droid Swarm phone + its logged-in Instagram/TikTok
 * account(s), sets the posting frequency and caption template, and manages the
 * ordered video queue the `content-studio-posting` ticker drains through
 * Droid Swarm. Everything goes through `content-studio.posting.*`
 * (src/content-studio/posting-ops.ts) — the same operations the
 * `content_posting` agent tool uses.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { gatewayAuthHeaders, gatewayHttpBase } from "../../gateway-http-auth.js";
import { mediaSrc, type GatewayCallable, type MediaView } from "./api.js";

type Platform = "instagram" | "tiktok";
type QueueStatus =
  | "queued"
  | "scheduled"
  | "awaiting_approval"
  | "posting"
  | "posted"
  | "failed"
  | "skipped"
  | "paused";

interface Schedule {
  mode: "interval" | "daily";
  everyMinutes: number;
  postsPerDay: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  jitterMinutes: number;
  dailyCap: number;
}
type Verification =
  | "unverified"
  | "verified"
  | "mismatch"
  | "logged_out"
  | "challenge"
  | "app_missing"
  | "error"
  | "offline";
interface Binding {
  platform: Platform;
  handle: string;
  accountId: string | null;
  verification?: Verification;
  verifiedAt?: number | null;
  verificationNote?: string | null;
}
interface Config {
  pageId: string;
  enabled: boolean;
  deviceId: string | null;
  deviceLabel: string | null;
  bindings: Binding[];
  schedule: Schedule;
  template: string;
  defaultHashtags: string[];
  cta: string;
  requireApproval: boolean;
  dryRun: boolean;
  updatedAt: number;
}
interface Entry {
  id: string;
  platform: Platform;
  position: number;
  status: QueueStatus;
  mediaId: string | null;
  title: string;
  hook: string;
  series: string;
  episode: string;
  hashtags: string[];
  captionOverride: string | null;
  scheduledAt: number | null;
  /** Owner-chosen exact time (null = follows the page schedule). */
  designatedAt?: number | null;
  lateByMs?: number | null;
  verifyStatus?: "verifying" | "verified" | "unverified" | null;
  verifyNote?: string | null;
  verifiedAt?: number | null;
  verifyNextAt?: number | null;
  permalink?: string | null;
  verifyEvidence?: { sources: string[]; captionMatched: boolean; seenCaption: string | null; steps: string[]; screenshots: string[]; checkedAt: number } | null;
  nextRun?: { at: number | null; tone: "ok" | "wait" | "late" | "held"; reason: string } | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  approvalId: string | null;
  postedAt: number | null;
  postUrl: string | null;
  postRef: string | null;
  dryRun: boolean | null;
  /** Instagram only: share as a Trial reel (non-followers first). */
  trialReel?: boolean;
  /** Where the entry came from ("flypic" = queued from FlyPic via the Droid Swarm link). */
  sourceKind?: string | null;
  media: MediaView | null;
  caption: string;
  captionSource: "override" | "template";
  captionWarnings: string[];
}
interface HistoryEvent {
  id: number;
  entryId: string | null;
  at: number;
  event: string;
  status: string | null;
  message: string;
  meta: Record<string, unknown>;
}
interface Upcoming {
  entryId: string;
  title: string;
  platform: string;
  at: number;
  reason: string;
}
interface PostingState {
  pageId: string;
  config: Config;
  effective: { intervalMinutes: number; dailyCap: number; summary: string };
  limits: { live: { minIntervalMinutes: number; maxPostsPerDay: number }; dryRun: { minIntervalMinutes: number } };
  queue: Entry[];
  preview: { next: Upcoming | null; upcoming: Upcoming[]; held?: string | null };
  history: HistoryEvent[];
  droidAvailable: boolean;
  /** Backend's answer to "will this page auto-post?" (older gateways omit it). */
  autoPosting?: {
    enabled: boolean;
    canEnable: boolean;
    blocker: { kind: "unbound" | "off"; text: string } | null;
  };
  captionVariables: string[];
  now: number;
}
type SessionHealth = "ok" | "logged_out" | "challenge" | "app_missing" | "error";
interface Detection {
  platform: string;
  sessionHealth?: SessionHealth;
  challenge?: string | null;
  trace?: string[];
  loggedIn: boolean;
  activeHandle: string | null;
  accounts: string[];
  postCount: number | null;
  switcherSupported: boolean;
  detectedAt: number;
  error: string | null;
}
interface Presence {
  connection: string;
  online: boolean;
  adbState: string;
  lastSeenAt: number | null;
  summary: string;
  fix: string[];
  screen: { awake: boolean | null; locked: boolean | null; foreground: string | null } | null;
}
interface DetectRun {
  kind?: "detect" | "publish";
  platform: string;
  startedAt: number;
  step: string;
  steps: Array<{ step: string; ok: boolean; detail: string | null }>;
}
interface Device {
  id: string;
  label: string;
  model: string | null;
  status: string;
  adbState: string;
  online: boolean;
  lastSeenAt?: number | null;
  presence?: Presence;
  accounts: Array<{ id: string; platform: string; handle: string; sessionHealth: string }>;
  detected: Record<string, Detection>;
  detecting?: DetectRun | null;
}

/** Plain-language labels for the detection steps the phone runs. */
const STEP_LABEL: Record<string, string> = {
  starting: "Connecting to the phone",
  wake: "Waking the screen",
  unlock_check: "Checking the lock screen",
  app_installed: "Checking the app is installed",
  launch_app: "Opening the app",
  profile_tab: "Looking for the profile tab",
  open_profile: "Opening the profile",
  read_profile: "Reading the profile",
  read_active_account: "Reading the logged-in account",
  list_accounts: "Reading the account switcher",
  return_home: "Returning to the home screen",
  // posting runs (dry run or live)
  verify_account: "Verifying the bound account",
  prepare_video: "Preparing video",
  stage_media: "Staging the video",
  push_media: "Sending to phone",
  verify_on_phone: "Checking the video arrived on the phone",
  open_composer: "Opening the app's composer",
  composer_ready: "Waiting for the composer",
  dismiss_sheet: "Closing an in-app pop-up",
  choose_format: "Choosing Reels",
  tap_next: "Tapping Next",
  caption_screen: "Waiting for the caption screen",
  focus_caption: "Opening the caption field",
  type_caption: "Typing the caption",
  caption_done: "Closing the keyboard",
  trial_reel: "Setting the Trial reel switch",
  trial_info_sheet: "Closing the trial reels info",
  publish_button: "Checking the Share button",
  dry_run_stop: "Dry run: stopped before Share",
  discard_draft: "Discarding the draft",
  exit_create: "Leaving the create screen",
  tap_publish: "Sharing",
  tap_publish_confirm: "Confirming the share",
  confirm_post: "Confirming the post on the profile",
  remove_from_phone: "Removing the video from the phone",
};

const HEALTH_CHIP: Record<SessionHealth, { cls: string; text: string }> = {
  ok: { cls: "chip--ok", text: "logged in" },
  logged_out: { cls: "chip--err", text: "logged out" },
  challenge: { cls: "chip--warn", text: "checkpoint on phone" },
  app_missing: { cls: "chip--err", text: "app not installed" },
  error: { cls: "chip--err", text: "check failed" },
};

const VERIFY_CHIP: Record<Verification, { cls: string; text: string }> = {
  verified: { cls: "chip--ok", text: "verified on phone" },
  mismatch: { cls: "chip--err", text: "account mismatch" },
  logged_out: { cls: "chip--err", text: "logged out" },
  challenge: { cls: "chip--warn", text: "checkpoint" },
  app_missing: { cls: "chip--err", text: "app missing" },
  error: { cls: "chip--err", text: "check failed" },
  offline: { cls: "chip", text: "phone offline" },
  unverified: { cls: "chip", text: "not verified yet" },
};

/** "Instagram open" / "home screen" / "lock screen" for the phone's foreground app. */
function fgLabel(pkg: string): string {
  if (pkg === "com.instagram.android") return "Instagram open";
  if (pkg === "com.zhiliaoapp.musically" || pkg === "com.ss.android.ugc.trill") return "TikTok open";
  if (pkg === "com.android.systemui") return "system screen";
  if (/launcher|home/i.test(pkg)) return "home screen";
  return `${pkg.split(".").pop()} open`;
}

const healthOf = (d: Detection | undefined | null): SessionHealth | null =>
  d ? (d.sessionHealth ?? (d.loggedIn ? "ok" : "error")) : null;
interface Candidate {
  source: "item" | "library";
  itemId: string | null;
  title: string;
  hook: string;
  media: MediaView;
  queued: boolean;
}
interface CaptionPreview {
  text: string;
  length: number;
  hashtagCount: number;
  warnings: string[];
}

const PLATFORM_LABEL: Record<Platform, string> = { instagram: "Instagram", tiktok: "TikTok" };
/** lastError prefix the runner uses when the phone's Instagram had no Trial switch. */
const TRIAL_UNAVAILABLE = "trial_unavailable";
const STATUS_LABEL: Record<QueueStatus, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  awaiting_approval: "Needs approval",
  posting: "Posting",
  posted: "Posted",
  failed: "Failed",
  skipped: "Skipped",
  paused: "Paused",
};
const COMMON_TZ = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(sec).padStart(2, "0")}s`;
}

function fmtAt(ms: number | null | undefined, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "numeric",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

/** Offset (local − UTC) of `tz` at `ms`. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!) - Math.floor(ms / 60_000) * 60_000;
}

/** "2026-10-09T19:30" wall time in the page timezone → epoch ms. */
function wallToUtc(local: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  try {
    let ms = guess - tzOffsetMs(guess, tz);
    ms = guess - tzOffsetMs(ms, tz);
    return ms;
  } catch {
    return guess;
  }
}

/** epoch ms → "2026-10-09T19:30" in the page timezone (datetime-local value). */
function utcToWall(ms: number, tz: string): string {
  try {
    return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16);
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

function fmtDur(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${Math.max(1, m)}m`;
}

const VERIFY_LABEL: Record<string, string> = {
  verifying: "Verifying…",
  verified: "Verified",
  unverified: "Unverified",
};

function relAgo(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

@customElement("content-posting-panel")
export class ContentPostingPanel extends LitElement {
  @property({ attribute: false }) client: GatewayCallable | null = null;
  @property({ type: String }) pageId = "";
  @property({ type: String }) pageName = "";

  @state() private data: PostingState | null = null;
  @state() private devices: Device[] = [];
  @state() private devicesError: string | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private toast: { text: string; tone: "ok" | "err" } | null = null;
  @state() private busy = new Set<string>();
  @state() private now = Date.now();
  // Draft form state (unsaved edits).
  @state() private draftDevice = "";
  @state() private draftBindings: Partial<Record<Platform, string>> = {};
  @state() private draftSchedule: Schedule | null = null;
  @state() private draftTemplate = "";
  @state() private draftHashtags = "";
  @state() private draftCta = "";
  @state() private preview: CaptionPreview | null = null;
  @state() private picker = false;
  @state() private candidates: Candidate[] = [];
  @state() private pickPlatforms: Platform[] = [];
  /** Composer: queue new Instagram videos as Trial reels. */
  @state() private pickTrial = false;
  @state() private editing: string | null = null;
  @state() private editCaption = "";
  @state() private aiDraft: string | null = null;
  @state() private dragId: string | null = null;
  @state() private dragOver: string | null = null;
  @state() private intervalUnit: "h" | "m" = "h";

  private poll: ReturnType<typeof setInterval> | null = null;
  private devPoll: ReturnType<typeof setInterval> | null = null;
  private deviceChangedAt = 0;
  private pressedDetect: Platform | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.clock = setInterval(() => (this.now = Date.now()), 1000);
    this.poll = setInterval(() => void this.refresh(true), 8000);
    // Device truth goes stale too: re-read live adb presence every 30 s.
    this.devPoll = setInterval(() => void this.loadDevices(), 30_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.clock) clearInterval(this.clock);
    if (this.poll) clearInterval(this.poll);
    if (this.devPoll) clearInterval(this.devPoll);
    if (this.previewTimer) clearTimeout(this.previewTimer);
  }

  protected updated(changed: PropertyValues): void {
    if ((changed.has("pageId") || changed.has("client")) && this.pageId && this.client) {
      this.data = null;
      this.loading = true;
      void this.refresh(false);
      void this.loadDevices(true); // fresh adb check on open
    }
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) return Promise.reject(new Error("not connected"));
    return this.client.request<T>(`content-studio.posting.${method}`, params);
  }

  /** Entry whose designated-time editor is open, and its draft value. */
  @state() private timeEdit: string | null = null;
  @state() private timeDraft = "";

  private openTimeEdit(e: Entry, tz: string) {
    this.timeEdit = e.id;
    this.timeDraft = utcToWall(e.designatedAt ?? Math.ceil((this.now + 30 * 60_000) / 300_000) * 300_000, tz);
  }

  private saveTime(e: Entry, tz: string, clear = false) {
    const at = clear ? null : wallToUtc(this.timeDraft, tz);
    if (!clear && at === null) return this.flash("Pick a date and time", "err");
    void this.act(
      `time:${e.id}`,
      async () => {
        await this.call("update", { entryId: e.id, postAt: at });
        this.timeEdit = null;
      },
      clear ? "Back on the page schedule" : `Will post at ${fmtAt(at, tz)} (${tz})`,
    );
  }

  private reverify(e: Entry) {
    void this.act(`verify:${e.id}`, () => this.call("action", { entryId: e.id, op: "verify" }));
  }

  /** Next run + reason, designated time, late note, verification + reel link. */
  private renderRunInfo(e: Entry, tz: string): TemplateResult {
    const nr = e.nextRun ?? null;
    const shownErr = (e.lastError ?? "").replace(/^delayed:\s*/i, "");
    const reason = nr && (!shownErr || !nr.reason.includes(shownErr)) ? nr.reason : nr?.tone === "wait" ? "delayed (see above)" : nr?.reason;
    const timeShown = e.status === "scheduled" || e.status === "awaiting_approval";
    const editable = ["queued", "scheduled", "paused", "failed"].includes(e.status);
    const v = e.verifyStatus ?? null;
    return html`
      <div class="run-info">
        ${nr
          ? html`<span class="run run--${nr.tone}">
              <b>${nr.tone === "held" ? "On hold" : nr.tone === "late" ? "Late" : nr.tone === "wait" ? "Delayed" : "Next"}</b>
              ${nr.at && !timeShown ? html` ${fmtAt(nr.at, tz)} · <span class="mono">${nr.at > this.now ? fmtCountdown(nr.at - this.now) : "due"}</span>` : nothing}
              ${nr.at && timeShown && nr.tone === "wait" ? html` · next attempt ${fmtAt(nr.at, tz)}` : nothing}
              ${reason ? html` — ${reason}` : nothing}
            </span>`
          : nothing}
        ${e.designatedAt
          ? html`<span class="pin" title="Designated time (${tz})">📌 ${fmtAt(e.designatedAt, tz)}</span>`
          : nothing}
        ${e.status === "posted" && e.lateByMs ? html`<span class="run run--late">posted ${fmtDur(e.lateByMs)} late</span>` : nothing}
        ${e.status === "posted" && v
          ? html`<span class="vchip vchip--${v}" title=${e.verifyNote ?? ""}>${VERIFY_LABEL[v]}${v === "verifying" && e.verifyNextAt && e.verifyNextAt > this.now ? ` · ${fmtCountdown(e.verifyNextAt - this.now)}` : ""}</span>`
          : nothing}
        ${e.permalink ? html`<a class="reel-link" href=${e.permalink} target="_blank" rel="noopener">View reel ↗</a>` : nothing}
        ${e.status === "posted" && !e.dryRun && v !== "verifying" && (v === "unverified" || !e.permalink)
          ? html`<button class="mini" ?disabled=${this.busy.has(`verify:${e.id}`)} @click=${() => this.reverify(e)}>${this.busy.has(`verify:${e.id}`) ? "Checking…" : "Re-verify"}</button>`
          : nothing}
        ${editable && this.timeEdit !== e.id
          ? html`<button class="mini" title="Post at an exact time" @click=${() => this.openTimeEdit(e, tz)}>${e.designatedAt ? "Change time" : "Set time"}</button>`
          : nothing}
      </div>
      ${e.status === "posted" && v === "unverified" && e.verifyNote ? html`<div class="entry-err">Not verified: ${e.verifyNote}</div>` : nothing}
      ${this.timeEdit === e.id
        ? html`<div class="time-edit">
            <label>Post at <input type="datetime-local" .value=${this.timeDraft} @input=${(ev: Event) => (this.timeDraft = (ev.target as HTMLInputElement).value)} /> <span class="muted">${tz}</span></label>
            <button class="mini gold-t" @click=${() => this.saveTime(e, tz)}>Save</button>
            ${e.designatedAt ? html`<button class="mini" @click=${() => this.saveTime(e, tz, true)}>Use page schedule</button>` : nothing}
            <button class="mini" @click=${() => (this.timeEdit = null)}>Cancel</button>
          </div>`
        : nothing}
      ${e.verifyEvidence && (e.verifyEvidence.steps.length || e.verifyEvidence.screenshots.length)
        ? html`<details class="v-evidence">
            <summary>Verification evidence (${e.verifyEvidence.sources.join(" + ") || "none"} · ${fmtAt(e.verifyEvidence.checkedAt, tz)})</summary>
            ${e.verifyEvidence.seenCaption ? html`<div class="muted">Seen caption: “${e.verifyEvidence.seenCaption}”</div>` : nothing}
            <ol>${e.verifyEvidence.steps.slice(-14).map((st) => html`<li class=${st.startsWith("✗") ? "bad" : ""}>${st}</li>`)}</ol>
            ${e.verifyEvidence.screenshots.map((p) => html`<div class="mono muted">📷 ${p}</div>`)}
          </details>`
        : nothing}
    `;
  }

  private flash(text: string, tone: "ok" | "err" = "ok") {
    this.toast = { text, tone };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 4200);
  }

  private async refresh(quiet: boolean) {
    if (!this.pageId || !this.client) return;
    try {
      const data = await this.call<PostingState>("get", { pageId: this.pageId });
      const first = !this.data || this.data.pageId !== data.pageId;
      this.data = data;
      this.error = null;
      if (first) this.resetDrafts(data.config);
      if (data.queue.some((e) => e.status === "posting")) void this.loadDevices();
    } catch (e) {
      if (!quiet) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private resetDrafts(cfg: Config) {
    this.draftDevice = cfg.deviceId ?? "";
    this.draftBindings = Object.fromEntries(cfg.bindings.map((b) => [b.platform, b.handle]));
    this.draftSchedule = {
      ...cfg.schedule,
      timezone: cfg.updatedAt ? cfg.schedule.timezone : browserTz(),
    };
    this.intervalUnit = cfg.schedule.everyMinutes % 60 === 0 ? "h" : "m";
    this.draftTemplate = cfg.template;
    this.draftHashtags = cfg.defaultHashtags.join(" ");
    this.draftCta = cfg.cta;
    this.schedulePreview();
  }

  private async loadDevices(refresh = false) {
    try {
      const res = await this.call<{ ok: boolean; reason?: string; devices: Device[] }>("devices", { refresh });
      this.devices = res.devices ?? [];
      this.devicesError = res.ok ? null : (res.reason ?? "Droid Swarm unavailable");
    } catch (e) {
      this.devicesError = e instanceof Error ? e.message : String(e);
    }
  }

  private async act(key: string, fn: () => Promise<unknown>, ok?: string) {
    this.busy = new Set([...this.busy, key]);
    try {
      await fn();
      if (ok) this.flash(ok);
      await this.refresh(true);
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "err");
    } finally {
      const next = new Set(this.busy);
      next.delete(key);
      this.busy = next;
    }
  }

  // ── Binding ─────────────────────────────────────────────────────────────

  private get selectedDevice(): Device | null {
    return this.devices.find((d) => d.id === this.draftDevice) ?? null;
  }

  /** Bindable accounts = what detection actually found logged in on the phone. */
  private accountOptions(dev: Device | null, platform: Platform): string[] {
    if (!dev) return [];
    const det = dev.detected?.[platform];
    return healthOf(det) === "ok" ? [...new Set(det!.accounts)] : [];
  }

  /** Why Detect accounts can't run right now (null = it can). */
  private detectBlockedWhy(dev: Device | null): string | null {
    if (!dev) return "Choose a phone first.";
    if (dev.detecting)
      return dev.detecting.kind === "publish"
        ? "The phone is busy posting — try again when it finishes"
        : `Already checking ${PLATFORM_LABEL[dev.detecting.platform as Platform] ?? dev.detecting.platform} on this phone…`;
    if (!dev.online) {
      return `Phone not connected: ${dev.presence?.summary ?? `adb ${dev.adbState}`}.${dev.presence?.fix?.[0] ? ` ${dev.presence.fix[0]}` : ""}`;
    }
    return null;
  }

  /**
   * The ONLY way a detection starts. A click only counts when the press began
   * on this button and not right after the phone dropdown closed — on Linux
   * Chrome the release that picks a <select> option can land on the button
   * beneath it and fire a click the owner never made.
   */
  private onDetectClick(e: MouseEvent, platform: Platform) {
    const pressedHere = this.pressedDetect === platform || e.detail === 0; // detail 0 = keyboard
    this.pressedDetect = null;
    if (!pressedHere || Date.now() - this.deviceChangedAt < 800) return;
    void this.detect(platform);
  }

  private async detect(platform: Platform) {
    const dev = this.selectedDevice;
    if (!dev) return;
    // The phone run takes ~10-40 s: poll the device list for live progress.
    const progress = setInterval(() => void this.loadDevices(), 1200);
    await this.act(
      `detect:${platform}`,
      async () => {
        const res = await this.call<{
          ok: boolean;
          status?: string;
          reason: string | null;
          detection: Detection | null;
        }>("detect", { deviceId: dev.id, platform });
        clearInterval(progress);
        await this.loadDevices();
        const h = healthOf(res.detection);
        if (res.status && res.status !== "ok") throw new Error(res.reason ?? `phone ${res.status}`);
        if (h !== "ok") throw new Error(`${PLATFORM_LABEL[platform]}: ${res.detection?.error ?? res.reason ?? "detection failed"}`);
        if (res.detection?.activeHandle && !this.draftBindings[platform]) {
          this.draftBindings = { ...this.draftBindings, [platform]: res.detection.activeHandle };
        }
      },
      `${PLATFORM_LABEL[platform]} accounts detected`,
    );
    clearInterval(progress);
  }

  private async saveBinding() {
    const dev = this.selectedDevice;
    const bindings = (Object.entries(this.draftBindings) as Array<[Platform, string]>)
      .filter(([, h]) => h)
      .map(([platform, handle]) => ({
        platform,
        handle,
        accountId: dev?.accounts.find((a) => a.platform === platform && a.handle === handle)?.id ?? null,
      }));
    let warnings: string[] | null = null;
    await this.act("bind", async () => {
      const res = await this.call<{ warnings?: string[] }>("configure", {
        pageId: this.pageId,
        deviceId: this.draftDevice || null,
        deviceLabel: dev?.label ?? null,
        bindings,
      });
      warnings = res.warnings ?? [];
    });
    const w = warnings as string[] | null;
    if (w && w.length) this.flash(`Saved — ${w[0]}`, "err");
    else if (w) this.flash("Binding saved");
  }

  private async toggle(field: "enabled" | "requireApproval" | "dryRun", value: boolean) {
    if (field === "dryRun" && !value) {
      const ok = confirm(
        "Go LIVE? Queued videos will really be published to the bound account on the phone. Keep dry run on to rehearse the full flow without posting.",
      );
      if (!ok) return;
    }
    if (field === "requireApproval" && !value) {
      const ok = confirm(
        this.data?.config.enabled
          ? "Stop asking for approval? Videos will post on schedule without asking you first."
          : "Stop asking for approval? Once Auto-posting is switched on, videos will post on schedule without asking you first. (This does not switch Auto-posting on.)",
      );
      if (!ok) return;
    }
    let released = 0;
    await this.act(field, async () => {
      const res = await this.call<{ released?: number }>("configure", { pageId: this.pageId, [field]: value });
      released = res.released ?? 0;
    });
    if (field === "enabled" && value && this.data?.config.enabled) {
      this.flash(
        released
          ? `Auto-posting on — ${released} held ${released === 1 ? "video" : "videos"} back on the schedule`
          : "Auto-posting on",
      );
    }
  }

  // ── Schedule / template ─────────────────────────────────────────────────

  private patchSchedule(patch: Partial<Schedule>) {
    if (!this.draftSchedule) return;
    this.draftSchedule = { ...this.draftSchedule, ...patch };
  }

  private async saveSchedule() {
    if (!this.draftSchedule) return;
    await this.act("schedule", () => this.call("configure", { pageId: this.pageId, schedule: this.draftSchedule }), "Frequency saved");
    if (this.data) this.draftSchedule = { ...this.data.config.schedule };
  }

  private schedulePreview() {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(async () => {
      try {
        this.preview = await this.call<CaptionPreview>("preview", {
          pageId: this.pageId,
          template: this.draftTemplate,
          defaultHashtags: this.draftHashtags,
          cta: this.draftCta,
        });
      } catch {
        /* preview is best-effort */
      }
    }, 250);
  }

  private insertVar(v: string) {
    const ta = this.renderRoot.querySelector<HTMLTextAreaElement>("#tpl");
    const token = `{${v}}`;
    if (!ta) {
      this.draftTemplate += token;
    } else {
      const s = ta.selectionStart ?? this.draftTemplate.length;
      const e = ta.selectionEnd ?? s;
      this.draftTemplate = this.draftTemplate.slice(0, s) + token + this.draftTemplate.slice(e);
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(s + token.length, s + token.length);
      });
    }
    this.schedulePreview();
  }

  private async saveTemplate() {
    await this.act(
      "template",
      () =>
        this.call("configure", {
          pageId: this.pageId,
          template: this.draftTemplate,
          defaultHashtags: this.draftHashtags,
          cta: this.draftCta,
        }),
      "Template saved",
    );
  }

  // ── Queue ───────────────────────────────────────────────────────────────

  private async openPicker() {
    this.picker = true;
    this.pickPlatforms = (this.data?.config.bindings.map((b) => b.platform) ?? []) as Platform[];
    if (!this.pickPlatforms.length) this.pickPlatforms = ["instagram"];
    try {
      const res = await this.call<{ candidates: Candidate[] }>("candidates", { pageId: this.pageId });
      this.candidates = res.candidates;
    } catch (e) {
      this.flash(e instanceof Error ? e.message : String(e), "err");
    }
  }

  private async enqueue(c: Candidate) {
    await this.act(
      `enqueue:${c.media.id}`,
      () =>
        this.call("enqueue", {
          pageId: this.pageId,
          platforms: this.pickPlatforms,
          ...(c.itemId ? { itemId: c.itemId } : { mediaId: c.media.id }),
          ...(this.trialOffered ? { trialReel: this.pickTrial } : {}),
        }),
      `Queued "${c.title}"`,
    );
    this.candidates = this.candidates.map((x) => (x.media.id === c.media.id ? { ...x, queued: true } : x));
  }

  private async upload(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    await this.act(
      "upload",
      async () => {
        const qs = new URLSearchParams({ filename: file.name });
        const res = await fetch(`${gatewayHttpBase()}/plugins/content-studio/media?${qs}`, {
          method: "POST",
          credentials: "include",
          headers: { ...(await gatewayAuthHeaders()), "Content-Type": file.type || "video/mp4" },
          body: file,
        });
        const body = (await res.json().catch(() => ({}))) as { media?: MediaView };
        if (!res.ok || !body.media) throw new Error(`upload failed (${res.status})`);
        await this.call("enqueue", {
          pageId: this.pageId,
          platforms: this.pickPlatforms.length ? this.pickPlatforms : undefined,
          mediaId: body.media.id,
          title: file.name.replace(/\.[a-z0-9]+$/i, ""),
          ...(this.trialOffered ? { trialReel: this.pickTrial } : {}),
        });
      },
      `Uploaded and queued ${file.name}`,
    );
  }

  /** The composer offers Trial reel only when Instagram is a target. */
  private get trialOffered(): boolean {
    const targets = this.pickPlatforms.length
      ? this.pickPlatforms
      : ((this.data?.config.bindings.map((b) => b.platform) ?? []) as Platform[]);
    return targets.includes("instagram");
  }

  private setTrial(e: Entry, on: boolean) {
    void this.act(
      `trial:${e.id}`,
      () => this.call("update", { entryId: e.id, trialReel: on }),
      on ? "Will post as a trial reel" : "Will post as a regular reel",
    );
  }

  private retryWithoutTrial(e: Entry) {
    void this.act(
      `retry:${e.id}`,
      async () => {
        await this.call("update", { entryId: e.id, trialReel: false });
        await this.call("action", { entryId: e.id, op: "retry" });
      },
      "Retrying as a regular reel",
    );
  }

  private entryAction(e: Entry, op: string) {
    if (op === "remove" && !confirm(`Remove "${e.title || "this video"}" from the queue?`)) return;
    void this.act(`${op}:${e.id}`, () => this.call("action", { entryId: e.id, op }));
  }

  private postNow(e: Entry) {
    const live = this.data && !this.data.config.dryRun;
    if (live && !confirm(`Post "${e.title || "this video"}" now to the bound ${PLATFORM_LABEL[e.platform]} account?`)) return;
    // The phone run takes a minute or more: poll the device list for live
    // progress ("Preparing video… / Sending to phone… / Opening Instagram…").
    const progress = setInterval(() => void this.loadDevices(), 1200);
    void this.act(
      `post:${e.id}`,
      async () => {
        const res = await this.call<{ report: { status: string; reason: string | null } }>("postNow", { entryId: e.id }).finally(() => {
          clearInterval(progress);
          void this.loadDevices();
        });
        if (res.report.reason && res.report.status !== "posted") this.flash(res.report.reason, res.report.status === "awaiting_approval" ? "ok" : "err");
        else if (res.report.status === "posted") this.flash(this.data?.config.dryRun ? "Dry run complete" : "Posted");
      },
    );
  }

  private onDragStart(e: DragEvent, id: string) {
    this.dragId = id;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  private async onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    const from = this.dragId;
    this.dragId = null;
    this.dragOver = null;
    if (!from || from === targetId || !this.data) return;
    const ids = this.data.queue.map((q) => q.id).filter((id) => id !== from);
    const at = ids.indexOf(targetId);
    ids.splice(at < 0 ? ids.length : at, 0, from);
    // Optimistic reorder.
    const byId = new Map(this.data.queue.map((q) => [q.id, q]));
    this.data = { ...this.data, queue: ids.map((id, i) => ({ ...byId.get(id)!, position: i })) };
    await this.act("reorder", () => this.call("reorder", { pageId: this.pageId, order: ids }));
  }

  private move(e: Entry, delta: number) {
    void this.act("reorder", () => this.call("reorder", { pageId: this.pageId, entryId: e.id, toIndex: e.position + delta }));
  }

  private startEdit(e: Entry) {
    this.editing = e.id;
    this.editCaption = e.captionOverride ?? e.caption;
    this.aiDraft = null;
  }

  private async saveCaption(e: Entry, clear = false) {
    await this.act(
      `caption:${e.id}`,
      () => this.call("update", { entryId: e.id, captionOverride: clear ? "" : this.editCaption }),
      clear ? "Back to the page template" : "Caption saved for this video",
    );
    this.editing = null;
  }

  private async aiWrite(e: Entry) {
    await this.act(`ai:${e.id}`, async () => {
      const res = await this.call<{ draft: string }>("aiCaption", { pageId: this.pageId, entryId: e.id });
      this.aiDraft = res.draft;
    });
  }

  // ── Render ──────────────────────────────────────────────────────────────

  render(): TemplateResult {
    if (this.loading && !this.data) return html`<div class="state">Loading posting queue…</div>`;
    if (this.error && !this.data) return html`<div class="state state--err">${this.error}</div>`;
    const d = this.data!;
    const cfg = d.config;
    return html`
      <div class="posting">
        ${this.renderHero(d)}
        <div class="grid">
          <div class="col">
            ${this.renderBinding(cfg)} ${this.renderFrequency(d)} ${this.renderTemplate(d)}
          </div>
          <div class="col col--wide">
            ${this.renderQueue(d)} ${this.renderUpcoming(d)} ${this.renderHistory(d)}
          </div>
        </div>
        ${this.toast ? html`<div class="toast toast--${this.toast.tone}" role="status">${this.toast.text}</div>` : nothing}
      </div>
    `;
  }

  private renderHero(d: PostingState): TemplateResult {
    const cfg = d.config;
    const next = d.preview.next;
    const awaiting = d.queue.find((e) => e.status === "awaiting_approval");
    const posting = d.queue.find((e) => e.status === "posting");
    const pending = d.queue.filter((e) => ["queued", "scheduled", "awaiting_approval", "posting"].includes(e.status)).length;
    const posted = d.queue.filter((e) => e.status === "posted").length;
    const ready = d.autoPosting ? d.autoPosting.canEnable : !!(cfg.deviceId && cfg.bindings.length);
    let headline: TemplateResult;
    if (!ready)
      headline = html`<span class="cd-label">${cfg.deviceId ? "No account bound — nothing will post" : "Bind a phone and account to start"}</span>`;
    else if (!cfg.enabled) headline = html`<span class="cd-label">Auto-posting is off</span>`;
    else if (posting) headline = html`<span class="cd-label">Posting now</span><span class="cd-value">“${posting.title}”</span>`;
    else if (awaiting) headline = html`<span class="cd-label">Waiting for your approval</span><span class="cd-value">“${awaiting.title}”</span>`;
    else if (next) headline = html`<span class="cd-label">Next post in</span><span class="cd-value mono">${fmtCountdown(next.at - this.now)}</span>`;
    else headline = html`<span class="cd-label">Queue empty</span>`;
    return html`
      <section class="hero" data-learn-id="content-posting-hero">
        <div class="hero-main">
          <div class="countdown">${headline}</div>
          ${next && cfg.enabled && !posting && !awaiting
            ? html`<div class="hero-sub">“${next.title || "Untitled"}” · ${PLATFORM_LABEL[next.platform as Platform] ?? next.platform} · ${fmtAt(next.at, cfg.schedule.timezone)}</div>`
            : nothing}
          <div class="hero-sub">${d.effective.summary}</div>
        </div>
        <div class="hero-switches">
          ${this.switch("Auto-posting", cfg.enabled, !ready, (v) => this.toggle("enabled", v), "enabled")}
          ${this.switch("Require approval", cfg.requireApproval, false, (v) => this.toggle("requireApproval", v), "requireApproval")}
          ${this.switch("Dry run", cfg.dryRun, false, (v) => this.toggle("dryRun", v), "dryRun")}
          ${!ready
            ? html`<p class="sw-why" data-learn-id="content-posting-autopost-locked">Auto-posting unlocks once ${cfg.deviceId ? "an account is" : "a phone and an account are"} bound — Phone &amp; account › pick the account › Save binding.</p>`
            : !cfg.enabled && !cfg.requireApproval
              ? html`<p class="sw-why">Approval is off, but Auto-posting is still off — switch it on to start posting.</p>`
              : nothing}
        </div>
        <div class="hero-stats">
          <div class="hs"><b>${pending}</b><span>in queue</span></div>
          <div class="hs"><b>${posted}</b><span>${cfg.dryRun ? "rehearsed" : "posted"}</span></div>
          <div class="hs"><b>${d.effective.dailyCap}</b><span>max / day</span></div>
        </div>
        ${cfg.dryRun
          ? html`<div class="ribbon ribbon--dry">DRY RUN — the phone runs the full flow and stops before Share. Nothing is published.</div>`
          : html`<div class="ribbon ribbon--live">LIVE — posts publish to ${cfg.bindings.map((b) => `@${b.handle}`).join(", ") || "the bound account"}.</div>`}
        ${!d.droidAvailable ? html`<div class="ribbon ribbon--warn">Droid Swarm is off on this gateway — enable it under Setup › Plugins to post.</div>` : nothing}
        ${(() => {
          const bound = cfg.deviceId ? this.devices.find((x) => x.id === cfg.deviceId) : null;
          if (bound && !bound.online)
            return html`<div class="ribbon ribbon--warn">${bound.label} is offline${bound.lastSeenAt ? ` (last seen ${relAgo(bound.lastSeenAt, this.now)})` : ""} — posts wait until it reconnects. See Phone & account for how to fix it.</div>`;
          const bad = cfg.bindings.filter((b) => b.verification && b.verification !== "verified");
          if (ready && bad.length)
            return html`<div class="ribbon ribbon--warn">Not verified on the phone: ${bad.map((b) => `@${b.handle} (${VERIFY_CHIP[b.verification!].text})`).join(", ")} — posting refuses until Detect accounts confirms it.</div>`;
          return nothing;
        })()}
        ${(() => {
          // Live phone progress for the post in flight (Post now or the scheduler).
          const bound = cfg.deviceId ? this.devices.find((x) => x.id === cfg.deviceId) : null;
          return bound?.detecting?.kind === "publish" ? this.renderDetecting(bound.detecting) : nothing;
        })()}
      </section>
    `;
  }

  private switch(label: string, on: boolean, disabled: boolean, fn: (v: boolean) => void, key: string): TemplateResult {
    return html`
      <button
        class="sw ${on ? "is-on" : ""}"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        ?disabled=${disabled || this.busy.has(key)}
        @click=${() => fn(!on)}
      >
        <span class="sw-track"><span class="sw-knob"></span></span>
        <span class="sw-label">${label}</span>
      </button>
    `;
  }

  /** "Trial reel — show to non-followers first" switch (composer + each Instagram entry). */
  private trialSwitch(on: boolean, disabled: boolean, fn: (v: boolean) => void, key: string): TemplateResult {
    return html`
      <button
        class="sw sw--trial ${on ? "is-on" : ""}"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        aria-label="Trial reel — show to non-followers first"
        ?disabled=${disabled || this.busy.has(key)}
        @click=${() => fn(!on)}
      >
        <span class="sw-track"><span class="sw-knob"></span></span>
        <span class="sw-label"><b>Trial reel</b><span class="sw-sub"> — show to non-followers first</span></span>
      </button>
    `;
  }

  private renderBinding(cfg: Config): TemplateResult {
    const dev = this.selectedDevice;
    const dirty =
      (this.draftDevice || null) !== cfg.deviceId ||
      JSON.stringify(Object.entries(this.draftBindings).filter(([, h]) => h).sort()) !==
        JSON.stringify(cfg.bindings.map((b) => [b.platform, b.handle]).sort());
    return html`
      <section class="panel" data-learn-id="content-posting-binding">
        <header class="ph">
          <h3>Phone & account</h3>
          <button class="ghost sm" ?disabled=${this.busy.has("devices")} @click=${() => this.act("devices", () => this.loadDevices(true))}>
            ${this.busy.has("devices") ? "Checking…" : "Refresh devices"}
          </button>
        </header>
        ${this.devicesError ? html`<p class="note note--warn">${this.devicesError}</p>` : nothing}
        <label class="fld">
          <span>Droid Swarm device</span>
          <select .value=${this.draftDevice} @change=${(e: Event) => {
            // Choosing a phone only selects it — it never starts anything on
            // the phone. (Detect accounts is the one trigger; see onDetectClick.)
            this.deviceChangedAt = Date.now();
            this.pressedDetect = null;
            this.draftDevice = (e.target as HTMLSelectElement).value;
            this.draftBindings = {};
          }}>
            <option value="">— choose a phone —</option>
            ${this.devices.map(
              (x) =>
                html`<option value=${x.id} ?selected=${x.id === this.draftDevice}>${x.label}${x.model ? ` · ${x.model}` : ""} — ${x.online ? "online" : `offline${x.lastSeenAt ? `, seen ${relAgo(x.lastSeenAt, this.now)}` : ""}`}</option>`,
            )}
          </select>
        </label>
        ${dev ? this.renderDeviceState(dev) : nothing}
        ${dev?.detecting && dev.detecting.kind !== "publish" ? this.renderDetecting(dev.detecting) : nothing}
        ${(["instagram", "tiktok"] as Platform[]).map((p) => this.renderPlatformRow(dev, p, cfg))}
        <div class="row-end">
          <button class="gold" ?disabled=${!dirty || this.busy.has("bind")} @click=${() => this.saveBinding()}>
            ${this.busy.has("bind") ? "Saving…" : "Save binding"}
          </button>
        </div>
        <p class="hint">You can only bind accounts that Detect accounts found logged in on the phone. Before every post the phone is re-checked (cached 30 min) and the active account is verified on screen — posting refuses any other account, a logged-out app or a security prompt.</p>
      </section>
    `;
  }

  private renderDeviceState(dev: Device): TemplateResult {
    const p = dev.presence;
    const screen = p?.screen;
    if (dev.online) {
      const bits = [
        p?.summary ?? "Online",
        screen?.awake === false ? "screen off" : null,
        screen?.locked ? "lock screen up" : null,
        screen?.foreground ? fgLabel(screen.foreground) : null,
      ].filter(Boolean);
      return html`<div class="devstat" data-learn-id="content-posting-device-state">
        <span class="dot dot--ok"></span><span>${bits.join(" · ")}</span>
      </div>`;
    }
    return html`
      <div class="offline" role="status" data-learn-id="content-posting-device-state">
        <div class="devstat">
          <span class="dot dot--off"></span>
          <b>Offline</b>
          <span class="muted">${p?.summary ?? `adb ${dev.adbState}`}</span>
        </div>
        ${p?.fix?.length
          ? html`<ol class="fixlist">${p.fix.map((f) => html`<li>${f}</li>`)}</ol>`
          : nothing}
        <p class="hint">Posts for this page wait (nothing is attempted) until the phone is back. Press Refresh after reconnecting.</p>
      </div>
    `;
  }

  private renderDetecting(run: DetectRun): TemplateResult {
    const label = STEP_LABEL[run.step] ?? run.step.replace(/_/g, " ");
    const app = PLATFORM_LABEL[run.platform as Platform] ?? run.platform;
    const publishing = run.kind === "publish";
    const dry = this.data?.config.dryRun !== false;
    return html`
      <div class="detecting" role="status" aria-live="polite">
        <div class="det-head">
          <span class="spin" aria-hidden="true"></span>
          <b>${publishing ? `${dry ? "Dry run" : "Posting"} to ${app} on the phone` : `Checking ${app} on the phone`}</b>
          <span class="muted mono">${Math.max(0, Math.round((this.now - run.startedAt) / 1000))}s</span>
        </div>
        <div class="det-step">${label}…</div>
        ${run.steps.length
          ? html`<ol class="det-steps">${run.steps.slice(-6).map(
              (st) => html`<li class=${st.ok ? "ok" : "bad"}>${st.ok ? "✓" : "✗"} ${STEP_LABEL[st.step] ?? st.step}${st.detail ? html` <span class="muted">— ${st.detail}</span>` : nothing}</li>`,
            )}</ol>`
          : nothing}
        <p class="hint">${publishing
          ? dry
            ? "Dry run: the video is prepared, sent to the phone and filled into the composer, then the run stops before Share and removes the video."
            : "The video is prepared on this computer, sent to the phone, posted from the bound account, then removed from the phone."
          : "Read-only: the phone only opens the app and its profile. Nothing is posted, liked, followed or changed."}</p>
      </div>
    `;
  }

  private renderPlatformRow(dev: Device | null, p: Platform, cfg: Config): TemplateResult {
    const det = dev?.detected?.[p];
    const health = healthOf(det);
    const opts = this.accountOptions(dev, p);
    const chosen = this.draftBindings[p] ?? "";
    const saved = cfg.bindings.find((b) => b.platform === p && b.handle === chosen && cfg.deviceId === this.draftDevice);
    const running = dev?.detecting?.platform === p || this.busy.has(`detect:${p}`);
    const chip = health ? HEALTH_CHIP[health] : null;
    const notDetected = chosen && !opts.includes(chosen);
    return html`
      <div class="plat">
        <div class="plat-head">
          <span class="plat-name">${PLATFORM_LABEL[p]}</span>
          ${det && chip
            ? html`<span class="chip ${chip.cls}" title=${det.error ?? ""}>${health === "ok" ? `@${det.activeHandle} active` : chip.text}</span>
                <span class="muted sm-t" title=${new Date(det.detectedAt).toLocaleString()}>${relAgo(det.detectedAt, this.now)}</span>`
            : html`<span class="chip">not checked</span>`}
          <button
            class="ghost sm"
            type="button"
            title=${this.detectBlockedWhy(dev) ?? "Open the app on the phone (read-only) and read the logged-in account(s)"}
            ?disabled=${Boolean(this.detectBlockedWhy(dev)) || running}
            @pointerdown=${() => (this.pressedDetect = p)}
            @click=${(e: MouseEvent) => this.onDetectClick(e, p)}
          >
            ${running ? "Checking phone…" : "Detect accounts"}
          </button>
        </div>
        ${dev && this.detectBlockedWhy(dev) && !running
          ? html`<p class="hint why">${this.detectBlockedWhy(dev)}</p>`
          : nothing}
        ${det && health === "ok"
          ? html`<div class="detected" data-learn-id="content-posting-detected">
              <span class="muted">Logged in on ${dev?.label ?? "the phone"}:</span>
              ${det.accounts.map((h) => html`<b class=${h === det.activeHandle ? "act" : ""}>@${h}${h === det.activeHandle ? " (active)" : ""}</b>`)}
              <span class="muted">· ${PLATFORM_LABEL[p]} · session ok${det.postCount !== null ? ` · ${det.postCount} posts` : ""} · checked ${relAgo(det.detectedAt, this.now)}</span>
            </div>`
          : nothing}
        ${health === "challenge"
          ? html`<p class="note note--warn">A security prompt is on the phone${det?.challenge ? html` (“${det.challenge}”)` : nothing}. It was left untouched — answer it on the phone yourself, then Detect again.</p>`
          : health && health !== "ok"
            ? html`<p class="note note--err">${det?.error ?? chip?.text}</p>`
            : nothing}
        <select
          .value=${chosen}
          ?disabled=${!dev}
          @change=${(e: Event) => (this.draftBindings = { ...this.draftBindings, [p]: (e.target as HTMLSelectElement).value })}
        >
          <option value="">${opts.length ? `Not posting to ${PLATFORM_LABEL[p]}` : health === "ok" ? "No accounts found" : "Detect accounts to choose"}</option>
          ${opts.map((h) => html`<option value=${h} ?selected=${h === chosen}>@${h}${det?.activeHandle === h ? " (active)" : ""}</option>`)}
          ${notDetected ? html`<option value=${chosen} selected>@${chosen} — not detected on this phone</option>` : nothing}
        </select>
        ${saved?.verification
          ? html`<div class="verify">
              <span class="chip ${VERIFY_CHIP[saved.verification].cls}" title=${saved.verificationNote ?? ""}>${VERIFY_CHIP[saved.verification].text}</span>
              ${saved.verifiedAt ? html`<span class="muted sm-t">${relAgo(saved.verifiedAt, this.now)}</span>` : nothing}
            </div>`
          : nothing}
        ${notDetected && health === "ok"
          ? html`<p class="note note--warn" data-learn-id="content-posting-mismatch">Mismatch: @${chosen} is not logged in on this phone (found ${opts.map((h) => `@${h}`).join(", ") || "no account"}). Posts are refused until it is — log it in on the phone and Detect again, or pick a detected account.</p>`
          : notDetected && !det
            ? html`<p class="note note--warn">@${chosen} has not been checked on this phone yet — run Detect accounts.</p>`
            : nothing}
        ${det && health === "ok" && !det.switcherSupported && chosen && det.activeHandle && det.activeHandle !== chosen && !notDetected
          ? html`<p class="note note--warn">@${det.activeHandle} is active on the phone. ${PLATFORM_LABEL[p]} can't be switched automatically, so posts will be refused until you switch it on the phone.</p>`
          : nothing}
      </div>
    `;
  }

  private renderFrequency(d: PostingState): TemplateResult {
    const s = this.draftSchedule ?? d.config.schedule;
    const minI = d.config.dryRun ? d.limits.dryRun.minIntervalMinutes : d.limits.live.minIntervalMinutes;
    const dirty = JSON.stringify(s) !== JSON.stringify(d.config.schedule);
    const tzs = COMMON_TZ.includes(s.timezone) ? COMMON_TZ : [s.timezone, ...COMMON_TZ];
    return html`
      <section class="panel" data-learn-id="content-posting-frequency">
        <header class="ph"><h3>Frequency</h3><span class="muted sm-t">${d.effective.summary}</span></header>
        <div class="seg" role="tablist">
          <button class=${s.mode === "interval" ? "is-on" : ""} @click=${() => this.patchSchedule({ mode: "interval" })}>Every N hours</button>
          <button class=${s.mode === "daily" ? "is-on" : ""} @click=${() => this.patchSchedule({ mode: "daily" })}>X per day</button>
        </div>
        <div class="fgrid">
          ${s.mode === "interval"
            ? html`<label class="fld"><span>Every</span>
                <div class="unit">
                  <input type="number" min=${this.intervalUnit === "h" ? minI / 60 : minI} step=${this.intervalUnit === "h" ? "0.5" : "1"}
                    .value=${String(this.intervalUnit === "h" ? +(s.everyMinutes / 60).toFixed(2) : s.everyMinutes)}
                    @change=${(e: Event) => {
                      const v = Number((e.target as HTMLInputElement).value);
                      this.patchSchedule({ everyMinutes: Math.round(this.intervalUnit === "h" ? v * 60 : v) });
                    }} />
                  <select aria-label="Interval unit" .value=${this.intervalUnit} @change=${(e: Event) => (this.intervalUnit = (e.target as HTMLSelectElement).value as "h" | "m")}>
                    <option value="h" ?selected=${this.intervalUnit === "h"}>hours</option>
                    <option value="m" ?selected=${this.intervalUnit === "m"}>minutes</option>
                  </select>
                </div></label>`
            : html`<label class="fld"><span>Posts per day</span>
                <input type="number" min="1" max=${d.limits.live.maxPostsPerDay} .value=${String(s.postsPerDay)}
                  @change=${(e: Event) => this.patchSchedule({ postsPerDay: Number((e.target as HTMLInputElement).value) })} /></label>`}
          <label class="fld"><span>Daily cap</span>
            <input type="number" min="1" .value=${String(s.dailyCap)} @change=${(e: Event) => this.patchSchedule({ dailyCap: Number((e.target as HTMLInputElement).value) })} /></label>
          <label class="fld"><span>Window opens</span>
            <input type="time" .value=${s.windowStart} @change=${(e: Event) => this.patchSchedule({ windowStart: (e.target as HTMLInputElement).value })} /></label>
          <label class="fld"><span>Window closes</span>
            <input type="time" .value=${s.windowEnd} @change=${(e: Event) => this.patchSchedule({ windowEnd: (e.target as HTMLInputElement).value })} /></label>
          <label class="fld"><span>Timezone</span>
            <select .value=${s.timezone} @change=${(e: Event) => this.patchSchedule({ timezone: (e.target as HTMLSelectElement).value })}>
              ${tzs.map((tz) => html`<option value=${tz} ?selected=${tz === s.timezone}>${tz}</option>`)}
            </select></label>
          <label class="fld"><span>Jitter ± min</span>
            <input type="number" min="0" max="120" .value=${String(s.jitterMinutes)} @change=${(e: Event) => this.patchSchedule({ jitterMinutes: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        <p class="hint">
          ${d.config.dryRun
            ? html`Dry run allows spacing down to ${d.limits.dryRun.minIntervalMinutes} min for testing.`
            : html`Live posting is floored at ${d.limits.live.minIntervalMinutes} min between posts and ${d.limits.live.maxPostsPerDay} posts/day per account; the phone also keeps its own pacing.`}
        </p>
        <div class="row-end">
          ${dirty ? html`<button class="ghost" @click=${() => (this.draftSchedule = { ...d.config.schedule })}>Reset</button>` : nothing}
          <button class="gold" ?disabled=${!dirty || this.busy.has("schedule")} @click=${() => this.saveSchedule()}>Save frequency</button>
        </div>
      </section>
    `;
  }

  private renderTemplate(d: PostingState): TemplateResult {
    const cfg = d.config;
    const dirty = this.draftTemplate !== cfg.template || this.draftHashtags !== cfg.defaultHashtags.join(" ") || this.draftCta !== cfg.cta;
    const pv = this.preview;
    return html`
      <section class="panel" data-learn-id="content-posting-template">
        <header class="ph"><h3>Caption template</h3></header>
        <div class="vars">
          ${d.captionVariables.map((v) => html`<button class="var" @click=${() => this.insertVar(v)}>{${v}}</button>`)}
        </div>
        <textarea id="tpl" rows="5" .value=${this.draftTemplate} @input=${(e: Event) => {
          this.draftTemplate = (e.target as HTMLTextAreaElement).value;
          this.schedulePreview();
        }}></textarea>
        <div class="fgrid">
          <label class="fld fld--wide"><span>Default hashtags</span>
            <input type="text" placeholder="#brand #reels" .value=${this.draftHashtags} @input=${(e: Event) => {
              this.draftHashtags = (e.target as HTMLInputElement).value;
              this.schedulePreview();
            }} /></label>
          <label class="fld fld--wide"><span>Call to action ({cta})</span>
            <input type="text" placeholder="Follow for part 2" .value=${this.draftCta} @input=${(e: Event) => {
              this.draftCta = (e.target as HTMLInputElement).value;
              this.schedulePreview();
            }} /></label>
        </div>
        <div class="preview">
          <div class="pv-head"><span>Live preview</span>${pv ? html`<span class="muted">${pv.length} chars · ${pv.hashtagCount} hashtags</span>` : nothing}</div>
          <pre class="pv-body">${pv?.text || "…"}</pre>
          ${pv?.warnings.length ? html`<div class="pv-warn">${pv.warnings.join(" · ")}</div>` : nothing}
        </div>
        <div class="row-end">
          <button class="gold" ?disabled=${!dirty || this.busy.has("template")} @click=${() => this.saveTemplate()}>Save template</button>
        </div>
      </section>
    `;
  }

  private renderQueue(d: PostingState): TemplateResult {
    const tz = d.config.schedule.timezone;
    const active = d.queue.filter((e) => e.status !== "posted" && e.status !== "skipped");
    const done = d.queue.filter((e) => e.status === "posted" || e.status === "skipped");
    return html`
      <section class="panel panel--queue" data-learn-id="content-posting-queue">
        <header class="ph">
          <h3>Queue <span class="count">${active.length}</span></h3>
          <div class="ph-actions">
            <label class="ghost sm upl">Upload video<input type="file" accept="video/*" @change=${(e: Event) => this.upload(e)} /></label>
            <button class="gold sm" @click=${() => (this.picker ? (this.picker = false) : this.openPicker())}>${this.picker ? "Close" : "+ Add videos"}</button>
          </div>
        </header>
        ${this.picker ? this.renderPicker(d) : nothing}
        ${active.length === 0
          ? html`<div class="empty">No videos queued. Add finished videos from this page's pipeline items or the media library.</div>`
          : html`<ol class="queue">${active.map((e, i) => this.renderEntry(e, i, active.length, tz))}</ol>`}
        ${done.length
          ? html`<details class="done"><summary>${done.length} posted / skipped</summary>
              <ol class="queue queue--done">${done.map((e, i) => this.renderEntry(e, i, done.length, tz))}</ol></details>`
          : nothing}
      </section>
    `;
  }

  private renderPicker(d: PostingState): TemplateResult {
    const bound = d.config.bindings.map((b) => b.platform);
    const plats: Platform[] = bound.length ? bound : ["instagram", "tiktok"];
    return html`
      <div class="picker">
        <div class="picker-head">
          <span>Post to:</span>
          ${plats.map((p) => html`<label class="ck"><input type="checkbox" .checked=${this.pickPlatforms.includes(p)} @change=${(e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            this.pickPlatforms = on ? [...new Set([...this.pickPlatforms, p])] : this.pickPlatforms.filter((x) => x !== p);
          }} />${PLATFORM_LABEL[p]}</label>`)}
        </div>
        ${this.trialOffered
          ? html`<div class="trial-opt" data-learn-id="content-posting-trial">
              ${this.trialSwitch(this.pickTrial, false, (v) => (this.pickTrial = v), "pickTrial")}
              <span class="hint">Applies to Instagram videos you add or upload now. If the phone's Instagram has no Trial option the post fails instead of going out as a regular reel.</span>
            </div>`
          : nothing}
        ${this.candidates.length === 0
          ? html`<div class="empty sm-t">No videos yet — upload one, or attach video to a pipeline item for this page.</div>`
          : html`<div class="cands">
              ${this.candidates.map(
                (c) => html`<button class="cand" ?disabled=${c.queued || this.busy.has(`enqueue:${c.media.id}`) || !this.pickPlatforms.length} @click=${() => this.enqueue(c)}>
                  <video src=${mediaSrc(c.media.url)} muted preload="metadata"></video>
                  <span class="cand-t">${c.title || c.media.filename}</span>
                  <span class="cand-s">${c.source === "item" ? "Pipeline item" : "Library"}${c.queued ? " · queued" : ""}</span>
                </button>`,
              )}
            </div>`}
      </div>
    `;
  }

  private renderEntry(e: Entry, i: number, n: number, tz: string): TemplateResult {
    const movable = !["posting", "posted"].includes(e.status);
    const editing = this.editing === e.id;
    return html`
      <li
        class="entry ${this.dragOver === e.id ? "is-over" : ""} ${this.dragId === e.id ? "is-drag" : ""} st-${e.status}"
        draggable=${movable ? "true" : "false"}
        @dragstart=${(ev: DragEvent) => movable && this.onDragStart(ev, e.id)}
        @dragover=${(ev: DragEvent) => {
          if (!this.dragId) return;
          ev.preventDefault();
          this.dragOver = e.id;
        }}
        @dragleave=${() => this.dragOver === e.id && (this.dragOver = null)}
        @drop=${(ev: DragEvent) => this.onDrop(ev, e.id)}
        @dragend=${() => {
          this.dragId = null;
          this.dragOver = null;
        }}
      >
        <div class="entry-main">
          <span class="grip" aria-hidden="true">${movable ? html`<svg viewBox="0 0 10 16" width="10" height="16"><g fill="currentColor"><circle cx="2" cy="2" r="1.5"/><circle cx="8" cy="2" r="1.5"/><circle cx="2" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="2" cy="14" r="1.5"/><circle cx="8" cy="14" r="1.5"/></g></svg>` : nothing}</span>
          <div class="thumb">
            ${e.media?.url ? html`<video src=${mediaSrc(e.media.url)} muted preload="metadata"></video>` : html`<span>▶</span>`}
            <span class="pos">${e.position + 1}</span>
          </div>
          <div class="entry-body">
            <div class="entry-top">
              <span class="entry-title">${e.title || e.media?.filename || "Untitled video"}</span>
              <span class="st st--${e.status}">${STATUS_LABEL[e.status]}${e.status === "posted" && e.dryRun ? " · dry run" : ""}</span>
              <span class="plat-chip plat-chip--${e.platform}">${PLATFORM_LABEL[e.platform]}</span>
              ${e.trialReel ? html`<span class="chip chip--trial" title="Trial reel — shown to non-followers first">Trial</span>` : nothing}
              ${e.sourceKind === "flypic" ? html`<span class="chip chip--flypic" title="Queued from FlyPic through the Droid Swarm link">from FlyPic</span>` : nothing}
            </div>
            <div class="entry-meta">
              ${e.status === "scheduled" || e.status === "awaiting_approval"
                ? html`<span>⏱ ${fmtAt(e.scheduledAt, tz)}${e.scheduledAt ? html` · <b class="mono">${fmtCountdown(e.scheduledAt - this.now)}</b>` : nothing}</span>`
                : nothing}
              ${e.status === "posted" ? html`<span>✓ ${fmtAt(e.postedAt, tz)}${e.postRef ? ` · ${e.postRef}` : ""}</span>` : nothing}
              ${e.postUrl ? html`<a href=${e.postUrl} target="_blank" rel="noopener">open post</a>` : nothing}
              ${e.attempts > 0 && e.status !== "posted" ? html`<span>attempt ${e.attempts}/${e.maxAttempts}</span>` : nothing}
              ${e.captionSource === "override" ? html`<span class="chip chip--gold">custom caption</span>` : nothing}
            </div>
            ${e.lastError && e.status !== "posted"
              ? e.lastError.startsWith(TRIAL_UNAVAILABLE)
                ? html`<div class="entry-err entry-err--trial" role="alert"><b>Trial reel unavailable.</b> ${e.lastError.slice(TRIAL_UNAVAILABLE.length).replace(/^[:\s]+/, "")}</div>`
                : html`<div class="entry-err">${e.lastError}</div>`
              : nothing}
            ${e.platform === "instagram" && !["posting", "posted", "skipped"].includes(e.status)
              ? html`<div class="trial-opt trial-opt--entry">
                  ${this.trialSwitch(Boolean(e.trialReel), false, (v) => this.setTrial(e, v), `trial:${e.id}`)}
                </div>`
              : nothing}
            <div class="entry-caption">${e.caption.split("\n")[0]}</div>
            ${this.renderRunInfo(e, tz)}
          </div>
          <div class="entry-actions">
            ${movable
              ? html`<button class="icon" title="Move up" ?disabled=${i === 0} @click=${() => this.move(e, -1)}>↑</button>
                  <button class="icon" title="Move down" ?disabled=${i === n - 1} @click=${() => this.move(e, 1)}>↓</button>`
              : nothing}
            ${["queued", "scheduled", "failed", "paused"].includes(e.status)
              ? html`<button class="mini gold-t" ?disabled=${this.busy.has(`post:${e.id}`)} @click=${() => this.postNow(e)}>${this.busy.has(`post:${e.id}`) ? "Posting…" : "Post now"}</button>`
              : nothing}
            ${["queued", "scheduled", "awaiting_approval"].includes(e.status) ? html`<button class="mini" @click=${() => this.entryAction(e, "pause")}>Pause</button>` : nothing}
            ${e.status === "paused" ? html`<button class="mini" @click=${() => this.entryAction(e, "resume")}>Resume</button>` : nothing}
            ${e.status === "failed" && e.trialReel && e.lastError?.startsWith(TRIAL_UNAVAILABLE)
              ? html`<button class="mini gold-t" ?disabled=${this.busy.has(`retry:${e.id}`)} @click=${() => this.retryWithoutTrial(e)}>Retry without trial</button>`
              : nothing}
            ${e.status === "failed" ? html`<button class="mini" @click=${() => this.entryAction(e, "retry")}>Retry</button>` : nothing}
            ${["queued", "scheduled", "paused", "failed", "awaiting_approval"].includes(e.status) ? html`<button class="mini" @click=${() => this.entryAction(e, "skip")}>Skip</button>` : nothing}
            ${e.status === "skipped" ? html`<button class="mini" @click=${() => this.entryAction(e, "unskip")}>Unskip</button>` : nothing}
            ${!["posting", "posted"].includes(e.status) ? html`<button class="mini" @click=${() => (editing ? (this.editing = null) : this.startEdit(e))}>Caption</button>` : nothing}
            ${e.status !== "posting" ? html`<button class="mini danger" @click=${() => this.entryAction(e, "remove")}>Remove</button>` : nothing}
          </div>
        </div>
        ${editing ? this.renderCaptionEditor(e) : nothing}
      </li>
    `;
  }

  private renderCaptionEditor(e: Entry): TemplateResult {
    return html`
      <div class="cap-edit">
        <textarea rows="5" .value=${this.editCaption} @input=${(ev: Event) => (this.editCaption = (ev.target as HTMLTextAreaElement).value)}></textarea>
        ${this.aiDraft !== null
          ? html`<div class="ai-draft">
              <div class="pv-head"><span>AI draft — review before using</span></div>
              <pre class="pv-body">${this.aiDraft}</pre>
              <div class="row-end">
                <button class="ghost sm" @click=${() => (this.aiDraft = null)}>Discard</button>
                <button class="gold sm" @click=${() => {
                  this.editCaption = this.aiDraft ?? "";
                  this.aiDraft = null;
                }}>Use draft</button>
              </div>
            </div>`
          : nothing}
        <div class="row-end">
          <button class="ghost sm" ?disabled=${this.busy.has(`ai:${e.id}`)} @click=${() => this.aiWrite(e)}>${this.busy.has(`ai:${e.id}`) ? "Writing…" : "✦ AI write from template"}</button>
          ${e.captionOverride ? html`<button class="ghost sm" @click=${() => this.saveCaption(e, true)}>Use template</button>` : nothing}
          <button class="gold sm" @click=${() => this.saveCaption(e)}>Save caption</button>
        </div>
      </div>
    `;
  }

  private renderUpcoming(d: PostingState): TemplateResult {
    const tz = d.config.schedule.timezone;
    return html`
      <section class="panel" data-learn-id="content-posting-upcoming">
        <header class="ph"><h3>Upcoming schedule</h3><span class="muted sm-t">${tz}</span></header>
        ${d.preview.held ? html`<div class="ribbon ribbon--warn held-note">${d.preview.held}</div>` : nothing}
        ${d.preview.upcoming.length === 0
          ? html`<div class="empty sm-t">Nothing scheduled.</div>`
          : html`<ol class="timeline">
              ${d.preview.upcoming.slice(0, 8).map(
                (u, i) => html`<li class=${i === 0 ? "is-next" : ""}>
                  <span class="tl-dot"></span>
                  <span class="tl-at">${fmtAt(u.at, tz)}</span>
                  <span class="tl-t">${u.reason === "designated" ? "📌 " : ""}${u.title || "Untitled"}</span>
                  <span class="plat-chip plat-chip--${u.platform}">${PLATFORM_LABEL[u.platform as Platform] ?? u.platform}</span>
                </li>`,
              )}
            </ol>`}
      </section>
    `;
  }

  private renderHistory(d: PostingState): TemplateResult {
    return html`
      <section class="panel" data-learn-id="content-posting-history">
        <header class="ph"><h3>History</h3></header>
        ${d.history.length === 0
          ? html`<div class="empty sm-t">No activity yet.</div>`
          : html`<ul class="hist">
              ${d.history.slice(0, 40).map((h) => {
                const steps = Array.isArray(h.meta?.steps) ? (h.meta.steps as string[]) : [];
                return html`<li class="ev ev--${h.event}">
                  <span class="ev-at">${relAgo(h.at, this.now)}</span>
                  <span class="ev-msg">${h.message}</span>
                  ${steps.length
                    ? html`<details class="ev-steps"><summary>${steps.length} device steps</summary><ol>${steps.map((s) => html`<li class=${s.startsWith("✗") ? "bad" : ""}>${s}</li>`)}</ol></details>`
                    : nothing}
                </li>`;
              })}
            </ul>`}
      </section>
    `;
  }

  static styles = css`
    :host {
      --gold: var(--g-primary, #caa45a);
      --txt: var(--text, #f2efe8);
      --dim: rgba(242, 239, 232, 0.6);
      --faint: rgba(242, 239, 232, 0.38);
      --line: rgba(255, 255, 255, 0.07);
      --line-gold: color-mix(in srgb, var(--gold) 28%, transparent);
      --ok: #4ade80;
      --err: #f87171;
      --warn: #fbbf24;
      display: block;
      color: var(--txt);
      font-family: var(--font-body, Inter, system-ui, sans-serif);
    }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; color: inherit; }
    .mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; }
    .muted { color: var(--dim); }
    .sm-t { font-size: 12px; }
    .state { padding: 40px; text-align: center; color: var(--dim); }
    .state--err { color: var(--err); }
    .posting { display: flex; flex-direction: column; gap: 18px; position: relative; }

    /* hero */
    .hero {
      position: relative; overflow: hidden;
      display: grid; grid-template-columns: minmax(0, 1.4fr) auto auto; gap: 18px 26px; align-items: center;
      padding: 22px 24px; border-radius: 20px; border: 1px solid var(--line-gold);
      background:
        radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--gold) 20%, transparent) 0%, transparent 55%),
        linear-gradient(135deg, rgba(255,255,255,0.05), rgba(0,0,0,0.25));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 30px 60px -24px rgba(0,0,0,0.6);
    }
    .countdown { display: flex; flex-direction: column; gap: 4px; }
    .cd-label { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); }
    .cd-value { font-size: 34px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.05; }
    .hero-sub { font-size: 12.5px; color: var(--dim); margin-top: 4px; }
    .hero-switches { display: flex; flex-direction: column; gap: 8px; }
    .sw-why { margin: 0; max-width: 240px; font-size: 11.5px; line-height: 1.35; color: var(--warn); }
    .hero-stats { display: flex; gap: 10px; }
    .hs { min-width: 76px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(0,0,0,0.25); text-align: center; }
    .hs b { display: block; font-size: 20px; }
    .hs span { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
    .ribbon { grid-column: 1 / -1; font-size: 12px; padding: 8px 12px; border-radius: 10px; letter-spacing: 0.02em; }
    .ribbon--dry { color: var(--gold); background: color-mix(in srgb, var(--gold) 9%, transparent); border: 1px dashed var(--line-gold); }
    .ribbon--live { color: var(--ok); background: rgba(74,222,128,0.07); border: 1px solid rgba(74,222,128,0.3); }
    .ribbon--warn { color: var(--warn); background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.3); }

    /* switch */
    .sw { display: inline-flex; align-items: center; gap: 10px; background: none; border: 0; padding: 2px 0; cursor: pointer; color: var(--dim); }
    .sw:disabled { opacity: 0.45; cursor: not-allowed; }
    .sw-track { width: 36px; height: 20px; border-radius: 999px; background: rgba(255,255,255,0.1); border: 1px solid var(--line); position: relative; transition: background 160ms; }
    .sw-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #d9d4c7; transition: transform 160ms; }
    .sw.is-on { color: var(--txt); }
    .sw.is-on .sw-track { background: linear-gradient(90deg, color-mix(in srgb, var(--gold) 70%, #000), var(--gold)); border-color: var(--line-gold); }
    .sw.is-on .sw-knob { transform: translateX(16px); background: #0b0a08; }
    .sw-label { font-size: 13px; }

    /* layout */
    .grid { display: grid; grid-template-columns: minmax(300px, 0.9fr) minmax(0, 1.3fr); gap: 18px; align-items: start; }
    .col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .panel {
      padding: 18px; border-radius: 18px; border: 1px solid var(--line);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--gold) 8%, transparent) 0%, transparent 60%),
        linear-gradient(160deg, rgba(255,255,255,0.045), rgba(255,255,255,0.01) 50%, rgba(0,0,0,0.2));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 20px 40px -24px rgba(0,0,0,0.6);
      display: flex; flex-direction: column; gap: 12px; min-width: 0;
    }
    .ph { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .ph h3 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: 0.02em; }
    .ph-actions { display: flex; gap: 8px; }
    .count { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 6px; margin-left: 6px; border-radius: 999px; font-size: 11px; color: #0b0a08; background: var(--gold); }
    .hint { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.45; }
    .note { margin: 0; font-size: 12px; padding: 8px 10px; border-radius: 10px; }
    .note--warn { color: var(--warn); background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.25); }
    .row-end { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

    /* controls */
    select, input[type="text"], input[type="number"], input[type="time"], textarea {
      width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line);
      background: rgba(0,0,0,0.32); outline: none; transition: border-color 140ms, box-shadow 140ms;
    }
    select:focus, input:focus, textarea:focus { border-color: var(--line-gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 14%, transparent); }
    textarea { resize: vertical; line-height: 1.45; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12.5px; }
    .fld { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .fld > span { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
    .fgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .fld--wide { grid-column: 1 / -1; }
    .unit { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 6px; }
    button.gold, button.ghost, label.ghost, button.mini, button.icon {
      border-radius: 10px; cursor: pointer; transition: transform 120ms, background 140ms, border-color 140ms;
    }
    button.gold {
      padding: 8px 14px; border: 1px solid var(--line-gold); color: #0b0a08; font-weight: 650;
      background: linear-gradient(140deg, color-mix(in srgb, var(--gold) 82%, #fff), var(--gold));
      box-shadow: 0 8px 20px -12px var(--gold);
    }
    button.gold:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    button.ghost, label.ghost { padding: 8px 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); color: var(--txt); }
    button.ghost:hover, label.ghost:hover { border-color: var(--line-gold); }
    button.ghost:disabled { opacity: 0.45; cursor: not-allowed; }
    .sm { padding: 5px 10px !important; font-size: 12px; }
    label.upl { position: relative; display: inline-flex; align-items: center; }
    label.upl input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .seg { display: inline-flex; padding: 3px; gap: 3px; border-radius: 11px; background: rgba(0,0,0,0.3); border: 1px solid var(--line); align-self: flex-start; }
    .seg button { padding: 6px 12px; border-radius: 8px; border: 0; background: none; color: var(--dim); cursor: pointer; font-size: 12.5px; }
    .seg button.is-on { color: #0b0a08; background: var(--gold); font-weight: 650; }

    /* binding */
    .devstat { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot--ok { background: var(--ok); box-shadow: 0 0 10px var(--ok); }
    .dot--off { background: #6b7280; }
    .plat { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(0,0,0,0.18); }
    .plat-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .plat-name { font-weight: 600; font-size: 13px; margin-right: auto; }
    .chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
    .chip--ok { color: var(--ok); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.07); }
    .chip--err { color: var(--err); border-color: rgba(248,113,113,0.35); background: rgba(248,113,113,0.07); }
    .chip--gold { color: var(--gold); border-color: var(--line-gold); }
    .chip--warn { color: var(--warn); border-color: rgba(251,191,36,0.35); background: rgba(251,191,36,0.07); }
    .chip--flypic { color: var(--accent, #a78bfa); border-color: color-mix(in srgb, var(--accent, #a78bfa) 40%, transparent); background: color-mix(in srgb, var(--accent, #a78bfa) 12%, transparent); font-weight: 600; }
    .chip--trial { color: var(--gold); border-color: var(--line-gold); background: color-mix(in srgb, var(--gold) 12%, transparent); font-weight: 600; letter-spacing: 0.02em; }
    .trial-opt { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
    .trial-opt .hint { margin: 0; flex: 1 1 220px; }
    .trial-opt--entry { padding: 2px 0; border: 0; background: none; }
    .trial-opt .sw--trial { justify-content: flex-start; text-align: left; }
    .sw--trial .sw-track { flex-shrink: 0; }
    .sw--trial .sw-label b { font-weight: 600; color: inherit; }
    .sw--trial .sw-sub { color: var(--dim); }
    .trial-opt--entry .sw-label { font-size: 12px; }
    .entry-err--trial b { font-weight: 600; }
    .note--err { color: var(--err); background: rgba(248,113,113,0.07); border: 1px solid rgba(248,113,113,0.25); }
    .offline { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid rgba(248,113,113,0.28); background: rgba(248,113,113,0.05); }
    .offline b { color: var(--err); font-weight: 650; }
    .fixlist { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--dim); line-height: 1.45; }
    .fixlist li::marker { color: var(--gold); }
    .detecting { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 12px; border: 1px solid var(--line-gold); background: color-mix(in srgb, var(--gold) 6%, transparent); }
    .det-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .det-head .muted { margin-left: auto; }
    .det-step { font-size: 12.5px; color: var(--gold); }
    .det-steps { margin: 0; padding-left: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--dim); }
    .det-steps li.bad { color: var(--err); }
    .det-steps li { overflow-wrap: anywhere; }
    .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--gold) 30%, transparent); border-top-color: var(--gold); animation: spin 0.9s linear infinite; flex: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    .verify { display: flex; align-items: center; gap: 8px; }
    .why { color: var(--warn); }
    .detected { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; padding: 8px 10px; border-radius: 10px; border: 1px solid rgba(74,222,128,0.25); background: rgba(74,222,128,0.05); }
    .detected b { font-weight: 600; color: var(--txt); }
    .detected b.act { color: var(--ok); }

    /* template */
    .vars { display: flex; flex-wrap: wrap; gap: 6px; }
    .var { padding: 3px 8px; border-radius: 8px; border: 1px solid var(--line-gold); background: color-mix(in srgb, var(--gold) 8%, transparent); color: var(--gold); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11.5px; cursor: pointer; }
    .var:hover { background: color-mix(in srgb, var(--gold) 16%, transparent); }
    .preview, .ai-draft { border-radius: 12px; border: 1px solid var(--line-gold); background: rgba(0,0,0,0.35); overflow: hidden; }
    .pv-head { display: flex; justify-content: space-between; gap: 8px; padding: 7px 12px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gold); border-bottom: 1px solid var(--line); }
    .pv-head .muted { text-transform: none; letter-spacing: 0; }
    .pv-body { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; font: 13px/1.5 var(--font-body, Inter, system-ui, sans-serif); max-height: 220px; overflow: auto; }
    .pv-warn { padding: 7px 12px; font-size: 11.5px; color: var(--warn); border-top: 1px solid var(--line); }

    /* queue */
    .empty { padding: 18px; text-align: center; color: var(--faint); border: 1px dashed var(--line); border-radius: 12px; }
    .queue { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .entry { border-radius: 14px; border: 1px solid var(--line); background: rgba(0,0,0,0.22); transition: border-color 140ms, transform 140ms, opacity 140ms; }
    .entry.is-over { border-color: var(--gold); transform: translateY(2px); }
    .entry.is-drag { opacity: 0.45; }
    .entry.st-posting { border-color: var(--line-gold); box-shadow: 0 0 0 1px var(--line-gold), 0 0 24px -8px var(--gold); }
    .entry.st-failed { border-color: rgba(248,113,113,0.35); }
    .entry-main { display: grid; grid-template-columns: 14px 64px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; }
    .grip { color: var(--faint); cursor: grab; display: grid; place-items: center; }
    .thumb { position: relative; width: 64px; height: 84px; border-radius: 10px; overflow: hidden; background: #0c0b09; border: 1px solid var(--line); display: grid; place-items: center; color: var(--faint); }
    .thumb video { width: 100%; height: 100%; object-fit: cover; }
    .pos { position: absolute; left: 4px; top: 4px; min-width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center; font-size: 10.5px; font-weight: 700; color: #0b0a08; background: var(--gold); }
    .entry-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .entry-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .entry-title { font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
    .entry-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--dim); }
    .entry-meta a { color: var(--gold); }
    .entry-err { font-size: 11.5px; color: var(--err); }
    .run-info { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 11.5px; color: var(--dim); }
    .run { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
    .run b { font-weight: 600; }
    .run--ok b { color: var(--ok); }
    .run--wait { border-color: rgba(251,191,36,0.35); color: var(--warn); }
    .run--late { border-color: rgba(251,146,60,0.4); color: #fb923c; }
    .run--held { border-color: rgba(248,113,113,0.35); color: var(--err); }
    .pin { color: var(--gold); }
    .vchip { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-weight: 600; }
    .vchip--verifying { color: var(--gold); border-color: var(--line-gold); }
    .vchip--verified { color: var(--ok); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.07); }
    .vchip--unverified { color: var(--err); border-color: rgba(248,113,113,0.35); }
    .reel-link { color: var(--gold); font-weight: 600; text-decoration: none; }
    .reel-link:hover { text-decoration: underline; }
    .time-edit { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
    .time-edit input { background: rgba(0,0,0,0.35); color: inherit; border: 1px solid var(--line-gold); border-radius: 8px; padding: 3px 6px; color-scheme: dark; }
    .v-evidence { font-size: 11.5px; color: var(--dim); }
    .v-evidence summary { cursor: pointer; color: var(--faint); }
    .v-evidence ol { margin: 4px 0; padding-left: 18px; }
    .v-evidence li.bad { color: var(--err); }
    .held-note { margin-bottom: 8px; }
    .entry-caption { font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .entry-actions { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; max-width: 260px; }
    button.mini { padding: 4px 9px; font-size: 11.5px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
    button.mini:hover { border-color: var(--line-gold); }
    button.mini.gold-t { color: var(--gold); border-color: var(--line-gold); }
    button.mini.danger:hover { color: var(--err); border-color: rgba(248,113,113,0.4); }
    button.icon { width: 26px; height: 26px; padding: 0; border: 1px solid var(--line); background: rgba(255,255,255,0.03); }
    button.icon:disabled, button.mini:disabled { opacity: 0.35; cursor: not-allowed; }
    .st { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
    .st--scheduled { color: #93c5fd; border-color: rgba(147,197,253,0.35); background: rgba(147,197,253,0.07); }
    .st--awaiting_approval { color: var(--warn); border-color: rgba(251,191,36,0.4); background: rgba(251,191,36,0.08); }
    .st--posting { color: var(--gold); border-color: var(--line-gold); background: color-mix(in srgb, var(--gold) 12%, transparent); animation: pulse 1.4s ease-in-out infinite; }
    .st--posted { color: var(--ok); border-color: rgba(74,222,128,0.35); background: rgba(74,222,128,0.07); }
    .st--failed { color: var(--err); border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.08); }
    .st--paused, .st--skipped { color: var(--faint); }
    @keyframes pulse { 50% { opacity: 0.55; } }
    .plat-chip { font-size: 10.5px; padding: 2px 7px; border-radius: 6px; border: 1px solid var(--line); color: var(--dim); }
    .plat-chip--instagram { color: #f0abfc; border-color: rgba(240,171,252,0.3); }
    .plat-chip--tiktok { color: #67e8f9; border-color: rgba(103,232,249,0.3); }
    .cap-edit { padding: 0 12px 12px 102px; display: flex; flex-direction: column; gap: 8px; }
    .done summary { cursor: pointer; font-size: 12px; color: var(--dim); padding: 4px 2px; }
    .queue--done { margin-top: 8px; opacity: 0.85; }

    .picker { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; border: 1px dashed var(--line-gold); background: rgba(0,0,0,0.2); }
    .picker-head { display: flex; gap: 14px; align-items: center; font-size: 12.5px; color: var(--dim); flex-wrap: wrap; }
    .ck { display: inline-flex; gap: 6px; align-items: center; color: var(--txt); }
    .cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; }
    .cand { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,0.03); cursor: pointer; text-align: left; }
    .cand:hover:not(:disabled) { border-color: var(--gold); }
    .cand:disabled { opacity: 0.45; cursor: default; }
    .cand video { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; border-radius: 8px; background: #0c0b09; }
    .cand-t { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cand-s { font-size: 10.5px; color: var(--faint); }

    /* upcoming */
    .timeline { list-style: none; margin: 0; padding: 0 0 0 4px; display: flex; flex-direction: column; }
    .timeline li { display: grid; grid-template-columns: 12px 150px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 0; font-size: 12.5px; border-left: 1px solid var(--line); margin-left: 5px; padding-left: 0; position: relative; }
    .tl-dot { width: 9px; height: 9px; border-radius: 50%; background: #3a3630; border: 1px solid var(--line-gold); margin-left: -5px; }
    .timeline li.is-next .tl-dot { background: var(--gold); box-shadow: 0 0 12px var(--gold); }
    .tl-at { color: var(--dim); font-variant-numeric: tabular-nums; }
    .tl-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* history */
    .hist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 420px; overflow: auto; }
    .ev { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 10px; padding: 7px 8px; border-radius: 8px; font-size: 12.5px; }
    .ev:nth-child(odd) { background: rgba(255,255,255,0.02); }
    .ev-at { color: var(--faint); font-size: 11.5px; }
    .ev-msg { word-break: break-word; }
    .ev--posted .ev-msg { color: var(--ok); }
    .ev--dry_run .ev-msg { color: var(--gold); }
    .ev--failed .ev-msg, .ev--wrong_account .ev-msg, .ev--approval_denied .ev-msg { color: var(--err); }
    .ev--approval_requested .ev-msg, .ev--auto_paused .ev-msg { color: var(--warn); }
    .ev-steps { grid-column: 2; font-size: 11.5px; color: var(--dim); }
    .ev-steps summary { cursor: pointer; }
    .ev-steps ol { margin: 4px 0 0; padding-left: 18px; }
    .ev-steps li.bad { color: var(--err); }

    .toast { position: fixed; right: 24px; bottom: 24px; z-index: 50; padding: 10px 14px; border-radius: 12px; font-size: 13px; background: rgba(14,13,11,0.95); border: 1px solid var(--line-gold); box-shadow: 0 16px 40px -12px rgba(0,0,0,0.7); }
    .toast--err { border-color: rgba(248,113,113,0.5); color: var(--err); }

    @media (max-width: 1100px) {
      .grid { grid-template-columns: minmax(0, 1fr); }
      /* Single column: the queue comes first, settings after it. */
      .col--wide { order: -1; }
      .hero { grid-template-columns: minmax(0, 1fr) auto; }
      .hero-stats { grid-column: 1 / -1; }
    }
    @media (max-width: 640px) {
      .hero { grid-template-columns: minmax(0, 1fr); padding: 18px; }
      .cd-value { font-size: 28px; }
      .hero-switches { flex-direction: row; flex-wrap: wrap; gap: 10px 16px; }
      .hero-stats .hs { flex: 1; min-width: 0; padding: 8px 6px; }
      .hs b { font-size: 18px; }
      .fgrid { grid-template-columns: minmax(0, 1fr); }
      .entry-main { grid-template-columns: 52px minmax(0, 1fr); }
      .grip { display: none; }
      .thumb { width: 52px; height: 68px; }
      .entry-actions { grid-column: 1 / -1; justify-content: flex-start; max-width: none; }
      .cap-edit { padding: 0 12px 12px; }
      .timeline li { grid-template-columns: 12px minmax(0, 1fr) auto; }
      .tl-at { grid-column: 2; }
      .tl-t { grid-column: 2; }
      .timeline li .plat-chip { grid-row: 1; grid-column: 3; }
      .ev { grid-template-columns: minmax(0, 1fr); }
      .ev-steps { grid-column: 1; }
      .panel { padding: 14px; }
    }

    /* Light theme: the panel's palette assumed a dark page (light text on
       translucent black cards → a grey wash). Swap to dark-on-porcelain glass. */
    :host-context([data-theme="light"]), :host-context([data-theme-mode="light"]) {
      --gold: color-mix(in srgb, var(--g-primary, #caa45a) 70%, #4a3608);
      --txt: #1d1a14;
      --dim: rgba(29, 26, 20, 0.7);
      --faint: rgba(29, 26, 20, 0.55);
      --line: rgba(29, 26, 20, 0.12);
      --line-gold: color-mix(in srgb, var(--gold) 40%, transparent);
      --ok: #15803d;
      --err: #b42318;
      --warn: #9a5b00;
    }
    :host-context([data-theme="light"]) .hero, :host-context([data-theme-mode="light"]) .hero {
      background:
        radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--gold) 14%, transparent) 0%, transparent 55%),
        linear-gradient(135deg, rgba(255,255,255,0.92), rgba(250,246,236,0.85));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 18px 40px -26px rgba(60,45,10,0.35);
    }
    :host-context([data-theme="light"]) .panel, :host-context([data-theme-mode="light"]) .panel {
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--gold) 7%, transparent) 0%, transparent 60%),
        linear-gradient(160deg, rgba(255,255,255,0.94), rgba(252,249,242,0.88));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.9), 0 16px 34px -24px rgba(60,45,10,0.3);
    }
    :host-context([data-theme="light"]) .entry, :host-context([data-theme-mode="light"]) .entry, :host-context([data-theme="light"]) .picker, :host-context([data-theme-mode="light"]) .picker, :host-context([data-theme="light"]) .hs, :host-context([data-theme-mode="light"]) .hs, :host-context([data-theme="light"]) .plat, :host-context([data-theme-mode="light"]) .plat, :host-context([data-theme="light"]) .cand, :host-context([data-theme-mode="light"]) .cand,
    :host-context([data-theme="light"]) .preview, :host-context([data-theme-mode="light"]) .preview, :host-context([data-theme="light"]) .ai-draft, :host-context([data-theme-mode="light"]) .ai-draft, :host-context([data-theme="light"]) .trial-opt:not(.trial-opt--entry), :host-context([data-theme-mode="light"]) .trial-opt:not(.trial-opt--entry), :host-context([data-theme="light"]) .seg, :host-context([data-theme-mode="light"]) .seg {
      background: rgba(255, 255, 255, 0.78);
    }
    :host-context([data-theme="light"]) .ev:nth-child(odd), :host-context([data-theme-mode="light"]) .ev:nth-child(odd) { background: rgba(29, 26, 20, 0.035); }
    :host-context([data-theme="light"]) button.ghost, :host-context([data-theme-mode="light"]) button.ghost, :host-context([data-theme="light"]) label.ghost, :host-context([data-theme-mode="light"]) label.ghost, :host-context([data-theme="light"]) button.mini, :host-context([data-theme-mode="light"]) button.mini, :host-context([data-theme="light"]) button.icon, :host-context([data-theme-mode="light"]) button.icon {
      background: rgba(255, 255, 255, 0.85); color: var(--txt);
    }
    :host-context([data-theme="light"]) .sw-track, :host-context([data-theme-mode="light"]) .sw-track { background: rgba(29, 26, 20, 0.14); }
    :host-context([data-theme="light"]) .sw-knob, :host-context([data-theme-mode="light"]) .sw-knob { background: #ffffff; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }
    :host-context([data-theme="light"]) .sw.is-on .sw-knob, :host-context([data-theme-mode="light"]) .sw.is-on .sw-knob { background: #ffffff; }
    :host-context([data-theme="light"]) .sw.is-on .sw-track, :host-context([data-theme-mode="light"]) .sw.is-on .sw-track {
      background: linear-gradient(90deg, color-mix(in srgb, var(--gold) 75%, #000), var(--gold)); border-color: var(--line-gold);
    }
    :host-context([data-theme="light"]) select, :host-context([data-theme-mode="light"]) select, :host-context([data-theme="light"]) input[type="text"], :host-context([data-theme-mode="light"]) input[type="text"], :host-context([data-theme="light"]) input[type="number"], :host-context([data-theme-mode="light"]) input[type="number"], :host-context([data-theme="light"]) input[type="time"], :host-context([data-theme-mode="light"]) input[type="time"], :host-context([data-theme="light"]) textarea, :host-context([data-theme-mode="light"]) textarea { background: rgba(255, 255, 255, 0.9); }
    :host-context([data-theme="light"]) .st--scheduled, :host-context([data-theme-mode="light"]) .st--scheduled { color: #1d4ed8; border-color: rgba(29,78,216,0.3); background: rgba(29,78,216,0.06); }
    :host-context([data-theme="light"]) .plat-chip--instagram, :host-context([data-theme-mode="light"]) .plat-chip--instagram { color: #a21caf; border-color: rgba(162,28,175,0.3); }
    :host-context([data-theme="light"]) .plat-chip--tiktok, :host-context([data-theme-mode="light"]) .plat-chip--tiktok { color: #0e7490; border-color: rgba(14,116,144,0.3); }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "content-posting-panel": ContentPostingPanel;
  }
}
