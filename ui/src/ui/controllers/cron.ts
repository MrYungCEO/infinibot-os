/**
 * Cron controller — typed wrapper over the gateway's `cron.*` RPCs.
 *
 * Covers every scenario the docs call out:
 *   - schedule kinds: `at` (one-shot), `every` (interval), `cron` (5-field expr)
 *   - sessionTarget: `main` (systemEvent) / `isolated` (agentTurn)
 *   - delivery to channels (whatsapp/telegram/discord/slack/imessage/last)
 *   - model + thinking overrides for isolated agentTurn payloads
 *   - agent binding, deleteAfterRun, wakeMode
 *   - run history (cron.runs) + force run (cron.run)
 *
 * UI state lives on `state.cronState` so the schedule view can re-render in
 * place. All mutations go through `state.requestUpdate?.()` so Lit picks
 * them up.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";

// ── Types ─────────────────────────────────────────────────────────────────

export type ScheduleKind = "at" | "every" | "cron";
export type SessionTarget = "main" | "isolated";
export type WakeMode = "now" | "next-heartbeat";
export type PayloadKind = "systemEvent" | "agentTurn";
export type DeliveryChannel =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "mattermost"
  | "signal"
  | "imessage"
  | "last";

export interface CronScheduleAt {
  kind: "at";
  /** ISO 8601 string. UTC unless an offset is included. */
  when: string;
}
export interface CronScheduleEvery {
  kind: "every";
  /** Interval in milliseconds. */
  intervalMs: number;
}
export interface CronScheduleCron {
  kind: "cron";
  /** 5-field cron expression. */
  expr: string;
  /** IANA timezone (defaults to host TZ when omitted). */
  tz?: string;
}
export type CronSchedule = CronScheduleAt | CronScheduleEvery | CronScheduleCron;

export interface SystemEventPayload {
  kind: "systemEvent";
  text: string;
}

export interface AgentTurnPayload {
  kind: "agentTurn";
  message: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutSeconds?: number;
  deliver?: boolean;
  channel?: DeliveryChannel;
  to?: string;
  bestEffortDeliver?: boolean;
  postToMainPrefix?: string;
  postToMainMode?: "summary" | "full";
  postToMainMaxChars?: number;
}

export type CronPayload = SystemEventPayload | AgentTurnPayload;

export interface CronJob {
  jobId: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: SessionTarget;
  payload: CronPayload;
  wakeMode?: WakeMode;
  deleteAfterRun?: boolean;
  agentId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastRunAt?: string | null;
  lastRunStatus?: "success" | "failure" | null;
  nextRunAt?: string | null;
}

export interface CronRun {
  runId: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "failure" | "cancelled";
  error?: string;
  output?: string;
}

export interface CronJobDraft {
  jobId?: string; // present when editing
  name: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  // schedule fields (UI-friendly — normalized at submit time)
  atIso: string;            // for kind="at"
  everyMs: number;          // for kind="every"
  cronExpr: string;         // for kind="cron"
  cronTz: string;           // for kind="cron"
  sessionTarget: SessionTarget;
  payloadKind: PayloadKind;
  systemEventText: string;
  agentMessage: string;
  agentModel: string;
  agentThinking: AgentTurnPayload["thinking"] | "";
  agentTimeoutSeconds: number | null;
  deliver: boolean;
  channel: DeliveryChannel | "";
  to: string;
  bestEffortDeliver: boolean;
  postToMainPrefix: string;
  postToMainMode: "summary" | "full";
  postToMainMaxChars: number;
  wakeMode: WakeMode;
  deleteAfterRun: boolean;
  agentId: string;
}

export interface CronState {
  loading: boolean;
  error: string | null;
  jobs: CronJob[];
  runs: Record<string, CronRun[]>; // keyed by jobId
  /** Editor open flag + draft. */
  editorOpen: boolean;
  draft: CronJobDraft | null;
  saving: boolean;
  /** Sub-tab selection inside the schedule view. */
  selectedJobId: string | null;
  expandedHistoryJobId: string | null;
}

// ── State helpers ─────────────────────────────────────────────────────────

export function emptyDraft(): CronJobDraft {
  const now = new Date();
  // Default the at-input to "20 minutes from now" so the field is usable
  // immediately without forcing the operator to type a full ISO string.
  const future = new Date(now.getTime() + 20 * 60 * 1000);
  const tz =
    Intl?.DateTimeFormat?.()?.resolvedOptions?.()?.timeZone ?? "UTC";
  return {
    name: "",
    enabled: true,
    scheduleKind: "cron",
    atIso: future.toISOString().slice(0, 16), // <input type="datetime-local">
    everyMs: 60 * 60 * 1000, // 1h
    cronExpr: "0 9 * * *",
    cronTz: tz,
    sessionTarget: "main",
    payloadKind: "systemEvent",
    systemEventText: "",
    agentMessage: "",
    agentModel: "",
    agentThinking: "",
    agentTimeoutSeconds: null,
    deliver: false,
    channel: "",
    to: "",
    bestEffortDeliver: false,
    postToMainPrefix: "Cron",
    postToMainMode: "summary",
    postToMainMaxChars: 8000,
    wakeMode: "next-heartbeat",
    deleteAfterRun: false,
    agentId: "",
  };
}

export function ensureCronState(state: AppViewState): CronState {
  if (!state.cronState) {
    state.cronState = {
      loading: false,
      error: null,
      jobs: [],
      runs: {},
      editorOpen: false,
      draft: null,
      saving: false,
      selectedJobId: null,
      expandedHistoryJobId: null,
    };
  }
  return state.cronState;
}

export function draftFromJob(job: CronJob): CronJobDraft {
  const d = emptyDraft();
  d.jobId = job.jobId;
  d.name = job.name;
  d.enabled = job.enabled;
  d.sessionTarget = job.sessionTarget;
  d.wakeMode = job.wakeMode ?? "next-heartbeat";
  d.deleteAfterRun = !!job.deleteAfterRun;
  d.agentId = job.agentId ?? "";

  if (job.schedule.kind === "at") {
    d.scheduleKind = "at";
    // datetime-local wants "YYYY-MM-DDTHH:mm" without timezone suffix
    d.atIso = job.schedule.when.replace(/(\.\d{3})?Z?$/, "").slice(0, 16);
  } else if (job.schedule.kind === "every") {
    d.scheduleKind = "every";
    d.everyMs = job.schedule.intervalMs;
  } else {
    d.scheduleKind = "cron";
    d.cronExpr = job.schedule.expr;
    d.cronTz = job.schedule.tz ?? d.cronTz;
  }

  if (job.payload.kind === "systemEvent") {
    d.payloadKind = "systemEvent";
    d.systemEventText = job.payload.text;
  } else {
    d.payloadKind = "agentTurn";
    d.agentMessage = job.payload.message;
    d.agentModel = job.payload.model ?? "";
    d.agentThinking = job.payload.thinking ?? "";
    d.agentTimeoutSeconds = job.payload.timeoutSeconds ?? null;
    d.deliver = !!job.payload.deliver;
    d.channel = job.payload.channel ?? "";
    d.to = job.payload.to ?? "";
    d.bestEffortDeliver = !!job.payload.bestEffortDeliver;
    d.postToMainPrefix = job.payload.postToMainPrefix ?? "Cron";
    d.postToMainMode = job.payload.postToMainMode ?? "summary";
    d.postToMainMaxChars = job.payload.postToMainMaxChars ?? 8000;
  }
  return d;
}

// ── Validation + serialization ────────────────────────────────────────────

export interface DraftIssue {
  field: string;
  message: string;
}

export function validateDraft(d: CronJobDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!d.name.trim()) issues.push({ field: "name", message: "Name is required" });

  if (d.scheduleKind === "at") {
    if (!d.atIso) issues.push({ field: "atIso", message: "Pick a date + time" });
    else if (Number.isNaN(new Date(d.atIso).getTime())) {
      issues.push({ field: "atIso", message: "Invalid date" });
    }
  } else if (d.scheduleKind === "every") {
    if (!Number.isFinite(d.everyMs) || d.everyMs < 5_000) {
      issues.push({
        field: "everyMs",
        message: "Interval must be at least 5 seconds",
      });
    }
  } else if (d.scheduleKind === "cron") {
    if (!d.cronExpr.trim()) {
      issues.push({ field: "cronExpr", message: "Cron expression is required" });
    } else {
      const fields = d.cronExpr.trim().split(/\s+/);
      if (fields.length !== 5) {
        issues.push({
          field: "cronExpr",
          message: "Cron expression must have exactly 5 fields (min hour dom mon dow)",
        });
      }
    }
  }

  // Main-session jobs must be systemEvent; isolated must be agentTurn.
  if (d.sessionTarget === "main" && d.payloadKind !== "systemEvent") {
    issues.push({
      field: "payloadKind",
      message: "Main-session jobs require a systemEvent payload",
    });
  }
  if (d.sessionTarget === "isolated" && d.payloadKind !== "agentTurn") {
    issues.push({
      field: "payloadKind",
      message: "Isolated jobs require an agentTurn payload",
    });
  }

  if (d.payloadKind === "systemEvent" && !d.systemEventText.trim()) {
    issues.push({
      field: "systemEventText",
      message: "System-event text is required",
    });
  }
  if (d.payloadKind === "agentTurn" && !d.agentMessage.trim()) {
    issues.push({
      field: "agentMessage",
      message: "Agent message is required",
    });
  }

  if (d.deliver && !d.channel && !d.to) {
    issues.push({
      field: "deliver",
      message: "Delivery enabled but no channel or `to` target set",
    });
  }
  return issues;
}

export function serializeDraft(d: CronJobDraft): Omit<CronJob, "jobId" | "createdAt" | "updatedAt" | "nextRunAt" | "lastRunAt" | "lastRunStatus"> & { jobId?: string } {
  let schedule: CronSchedule;
  if (d.scheduleKind === "at") {
    // datetime-local lacks tz info; treat as local time and emit ISO.
    schedule = { kind: "at", when: new Date(d.atIso).toISOString() };
  } else if (d.scheduleKind === "every") {
    schedule = { kind: "every", intervalMs: d.everyMs };
  } else {
    schedule = { kind: "cron", expr: d.cronExpr.trim(), tz: d.cronTz || undefined };
  }

  let payload: CronPayload;
  if (d.payloadKind === "systemEvent") {
    payload = { kind: "systemEvent", text: d.systemEventText.trim() };
  } else {
    const turn: AgentTurnPayload = {
      kind: "agentTurn",
      message: d.agentMessage.trim(),
    };
    if (d.agentModel.trim()) turn.model = d.agentModel.trim();
    if (d.agentThinking) turn.thinking = d.agentThinking;
    if (d.agentTimeoutSeconds != null) turn.timeoutSeconds = d.agentTimeoutSeconds;
    if (d.deliver) turn.deliver = true;
    if (d.channel) turn.channel = d.channel as DeliveryChannel;
    if (d.to.trim()) turn.to = d.to.trim();
    if (d.bestEffortDeliver) turn.bestEffortDeliver = true;
    if (d.postToMainPrefix && d.postToMainPrefix !== "Cron") {
      turn.postToMainPrefix = d.postToMainPrefix;
    }
    if (d.postToMainMode !== "summary") turn.postToMainMode = d.postToMainMode;
    if (d.postToMainMaxChars && d.postToMainMaxChars !== 8000) {
      turn.postToMainMaxChars = d.postToMainMaxChars;
    }
    payload = turn;
  }

  const out: Omit<CronJob, "jobId" | "createdAt" | "updatedAt" | "nextRunAt" | "lastRunAt" | "lastRunStatus"> & { jobId?: string } = {
    name: d.name.trim(),
    enabled: d.enabled,
    schedule,
    sessionTarget: d.sessionTarget,
    payload,
    wakeMode: d.wakeMode,
    deleteAfterRun: d.deleteAfterRun,
  };
  if (d.agentId.trim()) out.agentId = d.agentId.trim();
  if (d.jobId) out.jobId = d.jobId;
  return out;
}

// ── Gateway calls ─────────────────────────────────────────────────────────

export async function loadCronJobs(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const cs = ensureCronState(state);
  cs.loading = true;
  cs.error = null;
  state.requestUpdate?.();
  try {
    const res = (await client.request("cron.list", { includeDisabled: true })) as
      | { jobs: CronJob[] }
      | CronJob[];
    cs.jobs = Array.isArray(res) ? res : (res.jobs ?? []);
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
  } finally {
    cs.loading = false;
    state.requestUpdate?.();
  }
}

export async function saveCronJob(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<boolean> {
  const cs = ensureCronState(state);
  if (!cs.draft) return false;
  const issues = validateDraft(cs.draft);
  if (issues.length > 0) {
    cs.error = issues.map((i) => `${i.field}: ${i.message}`).join("; ");
    state.requestUpdate?.();
    return false;
  }
  cs.saving = true;
  cs.error = null;
  state.requestUpdate?.();
  try {
    const payload = serializeDraft(cs.draft);
    const method = payload.jobId ? "cron.update" : "cron.add";
    await client.request(method, payload);
    cs.editorOpen = false;
    cs.draft = null;
    await loadCronJobs(state, client);
    return true;
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    cs.saving = false;
    state.requestUpdate?.();
  }
}

export async function removeCronJob(
  state: AppViewState,
  client: GatewayBrowserClient,
  jobId: string,
): Promise<void> {
  const cs = ensureCronState(state);
  cs.error = null;
  state.requestUpdate?.();
  try {
    await client.request("cron.remove", { jobId });
    await loadCronJobs(state, client);
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function toggleCronJob(
  state: AppViewState,
  client: GatewayBrowserClient,
  job: CronJob,
): Promise<void> {
  try {
    await client.request("cron.update", {
      jobId: job.jobId,
      enabled: !job.enabled,
    });
    await loadCronJobs(state, client);
  } catch (e) {
    const cs = ensureCronState(state);
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function runCronJob(
  state: AppViewState,
  client: GatewayBrowserClient,
  jobId: string,
  force = true,
): Promise<void> {
  try {
    await client.request("cron.run", { jobId, mode: force ? "force" : "due" });
    await loadCronRuns(state, client, jobId);
  } catch (e) {
    const cs = ensureCronState(state);
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

export async function loadCronRuns(
  state: AppViewState,
  client: GatewayBrowserClient,
  jobId: string,
  limit = 25,
): Promise<void> {
  const cs = ensureCronState(state);
  try {
    const res = (await client.request("cron.runs", { jobId, limit })) as
      | { runs: CronRun[] }
      | CronRun[];
    cs.runs[jobId] = Array.isArray(res) ? res : (res.runs ?? []);
    state.requestUpdate?.();
  } catch (e) {
    cs.error = e instanceof Error ? e.message : String(e);
    state.requestUpdate?.();
  }
}

// ── Editor state ──────────────────────────────────────────────────────────

export function openCronEditorForCreate(state: AppViewState): void {
  const cs = ensureCronState(state);
  cs.draft = emptyDraft();
  cs.editorOpen = true;
  cs.error = null;
  state.requestUpdate?.();
}

export function openCronEditorForEdit(state: AppViewState, job: CronJob): void {
  const cs = ensureCronState(state);
  cs.draft = draftFromJob(job);
  cs.editorOpen = true;
  cs.error = null;
  state.requestUpdate?.();
}

export function closeCronEditor(state: AppViewState): void {
  const cs = ensureCronState(state);
  cs.editorOpen = false;
  cs.draft = null;
  cs.error = null;
  state.requestUpdate?.();
}

export function patchDraft(
  state: AppViewState,
  patch: Partial<CronJobDraft>,
): void {
  const cs = ensureCronState(state);
  if (!cs.draft) return;
  cs.draft = { ...cs.draft, ...patch };
  // Auto-pair sessionTarget ↔ payloadKind to avoid invalid combos.
  if (patch.sessionTarget === "main") cs.draft.payloadKind = "systemEvent";
  if (patch.sessionTarget === "isolated") cs.draft.payloadKind = "agentTurn";
  state.requestUpdate?.();
}

// ── Schedule preview helpers (UI nicety, no gateway round trip) ───────────

export function describeSchedule(s: CronSchedule): string {
  if (s.kind === "at") {
    try {
      const d = new Date(s.when);
      return `Once at ${d.toLocaleString()}`;
    } catch {
      return `Once at ${s.when}`;
    }
  }
  if (s.kind === "every") {
    const m = Math.round(s.intervalMs / 60000);
    if (m < 60) return `Every ${m}m`;
    if (m < 60 * 24) return `Every ${Math.round(m / 60)}h`;
    return `Every ${Math.round(m / (60 * 24))}d`;
  }
  return `cron \`${s.expr}\`${s.tz ? ` (${s.tz})` : ""}`;
}

export function describePayload(p: CronPayload): string {
  if (p.kind === "systemEvent") return p.text;
  return p.message;
}

/** Common cron expression presets exposed in the editor. */
export const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: "Every minute", expr: "* * * * *" },
  { label: "Every 5 minutes", expr: "*/5 * * * *" },
  { label: "Every 15 minutes", expr: "*/15 * * * *" },
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Daily at 09:00", expr: "0 9 * * *" },
  { label: "Daily at 18:00", expr: "0 18 * * *" },
  { label: "Weekdays 09:00", expr: "0 9 * * 1-5" },
  { label: "Mondays 07:00", expr: "0 7 * * 1" },
  { label: "1st of month 06:00", expr: "0 6 1 * *" },
];

export const INTERVAL_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "5 min", ms: 5 * 60 * 1000 },
  { label: "15 min", ms: 15 * 60 * 1000 },
  { label: "30 min", ms: 30 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "4 hours", ms: 4 * 60 * 60 * 1000 },
  { label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { label: "Daily", ms: 24 * 60 * 60 * 1000 },
];
