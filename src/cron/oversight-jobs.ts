/**
 * Default "Proactive Oversight" cron jobs + on-event rules.
 *
 * On a fresh install these are created DISABLED until the operator opts in to
 * autonomy (`cron.autonomy: true`, see ./autonomy-optin.ts); installs that
 * already run them keep them exactly as they are. They follow the exact
 * pattern the existing defaults use (src/cron/default-jobs.ts, src/reports/ceo-cron.ts):
 * a `main` session `systemEvent` nudge that tells the main agent to trigger the
 * deterministic work (usually `reports.generate({ kind })`, which the report
 * worker renders + ships). Jobs are matched/deduped by `name`, so re-running
 * setup never duplicates and never clobbers operator edits.
 *
 * Every job carries:
 *   - `category`       — UI grouping (oversight:daily|weekly|monthly|continuous)
 *   - `defaultEnabled` — the shipped on/off, so the Settings UI can offer "reset"
 *
 * The 3 on-event items (#14–16) are NOT crons — they're report_triggers fired by
 * a firing site via `fireEventTriggers(eventType, config)`. They're seeded into
 * the reports store and render the generic `oversight_event` kind.
 *
 * QUIET-BY-DEFAULT: the payload text instructs the agent to respect DND / muted
 * notifications (skip the Telegram/popup push, still write the report to disk).
 */

import { isBusinessAgencyCronJob } from "../business-agency/cron.js";
import { isBusinessAgencyActive } from "../business-agency/runtime.js";
import { addAutonomyJob, resolveAutonomySeedEnabled } from "./autonomy-optin.js";
import type { CronService } from "./service.js";
import type { CronJobCreate } from "./types.js";

const QUIET =
  "Respect DND / muted notifications: if quiet hours are on, still write the report to disk but skip the Telegram/popup push.";

/** Build a "trigger reports.generate({kind})" systemEvent nudge. */
function reportNudge(slug: string, kind: string, human: string): CronJobCreate["payload"] {
  return {
    kind: "systemEvent",
    text:
      `[oversight:${slug}] Generate the ${human} now: call reports.generate({ kind: "${kind}" }). ` +
      `Do NOT summarize it yourself — just trigger the report and confirm the run id. ` +
      `The report worker collects from the canonical kanban/clients/credits stores, renders the PDF + ` +
      `a markdown copy under ~/.infinibot/reports/, and ships to UI + Telegram. ${QUIET}`,
  };
}

export const OVERSIGHT_CRON_JOBS: CronJobCreate[] = [
  // ── DAILY (07:00 local) ────────────────────────────────────────────────────
  {
    name: "oversight-morning-brief",
    description:
      "Daily 07:00 — last-24h morning brief (tasks done/in-progress/blocked, sub-agent success/fail, drift, top-3 actions).",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:daily",
    schedule: { kind: "cron", expr: "0 7 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("morning-brief", "morning_brief", "Morning Brief"),
  },
  {
    name: "oversight-drift-digest",
    description: "Daily 07:00 — projects with no activity in 7+ days, priority-ordered.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:daily",
    schedule: { kind: "cron", expr: "0 7 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("drift-digest", "drift_digest", "Drift Digest"),
  },
  {
    name: "oversight-inbox-triage",
    description: "Daily 07:00 — unread DMs/threads across channels with sender + 1-line preview.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:daily",
    schedule: { kind: "cron", expr: "0 7 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    // Inbox lives only in the live gateway session feed (the report worker can't
    // read it), so this one is a main-session gather+render nudge, not a kind.
    payload: {
      kind: "systemEvent",
      text:
        "[oversight:inbox-triage] Build the Inbox Triage report. Use your live session/channel tools " +
        "(sessions list + channel history) to find unread/unanswered inbound DMs and threads across all " +
        "configured channels. For each: sender, channel, and a 1-line preview. Render it via " +
        'reports.render({ payload: { title: "Inbox Triage", eyebrow: "InfiniBot · Oversight", ' +
        'sections: [{ heading: "Unread / awaiting reply", table: { columns: ["Channel","Sender","Preview","Age"], rows: [...] } }], ' +
        'footer: "inbox_triage" }, kind: "inbox_triage", category: "operations" }). ' +
        "If there is nothing unread, say so and skip the push. " +
        QUIET,
    },
  },

  // ── WEEKLY (Monday 08:00 local) ─────────────────────────────────────────────
  {
    name: "oversight-velocity-report",
    description:
      "Weekly Mon 08:00 — projects ranked by completed tasks last week + WoW delta; lowest-velocity flagged.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:weekly",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("velocity-report", "velocity_report", "Velocity Report"),
  },
  {
    name: "oversight-cost-report",
    description:
      "Weekly Mon 08:00 — token/cost burn by backend + project vs budget + provider plan ceilings.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:weekly",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("cost-report", "cost_report", "Cost / Token-Usage Report"),
  },
  {
    name: "oversight-client-snapshot",
    description:
      "Weekly Mon 08:00 — per active client: progress, last touch, next deliverable, days since update; stale > 14d flagged.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:weekly",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("client-snapshot", "client_snapshot", "Client Status Snapshot"),
  },
  {
    name: "oversight-followups-report",
    description: 'Weekly Mon 08:00 — tasks tagged "follow-up" / "waiting-on" with age.',
    enabled: true,
    defaultEnabled: true,
    category: "oversight:weekly",
    schedule: { kind: "cron", expr: "0 8 * * 1" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("followups-report", "followups_report", "Outstanding Follow-ups"),
  },

  // ── MONTHLY (1st 09:00 local) ───────────────────────────────────────────────
  {
    name: "oversight-health-audit",
    description: "Monthly 1st 09:00 — disk, log size, db size, errors, uptime housekeeping audit.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:monthly",
    schedule: { kind: "cron", expr: "0 9 1 * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("health-audit", "health_audit", "Health Audit"),
  },
  {
    name: "oversight-memory-hygiene",
    description: "Monthly 1st 09:00 — orphaned/empty/oversized agent-memory files.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:monthly",
    schedule: { kind: "cron", expr: "0 9 1 * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: reportNudge("memory-hygiene", "memory_hygiene", "Memory Hygiene"),
  },

  // ── CONTINUOUS / HIGH-FREQUENCY ─────────────────────────────────────────────
  {
    name: "oversight-pulse",
    description:
      "Every 5 min — gateway health + critical services (voice STT/TTS, kanban store, federation peers). Alerts ONLY on a state flip.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:continuous",
    schedule: { kind: "every", everyMs: 5 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[oversight:pulse] Run the lightweight service pulse (deterministic state-flip check in " +
        "src/proactive/pulse-check.ts → runPulse(); call the oversight.pulse RPC if available). " +
        "Compare each critical service (kanban store, voice STT/TTS if configured, federation peers) to its " +
        "last snapshot. ONLY emit a proactive alert for services whose status FLIPPED since last check. " +
        "If nothing flipped, stay silent. " +
        QUIET,
    },
  },
  {
    name: "oversight-subagent-watchdog",
    description:
      "Every 10 min — flag active sub-agent runs > 1h with no check-in; surface as a proactive popup.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:continuous",
    schedule: { kind: "every", everyMs: 10 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[oversight:subagent-watchdog] List active sub-agent runs (subagents_list). For any run older than " +
        "1 hour with no check-in/progress update in the last hour, surface a NOTABLE proactive popup naming the " +
        "run, its age, and last activity, so it can be respawned or stopped. If none, stay silent. " +
        QUIET,
    },
  },
  {
    name: "oversight-provider-ratelimit-watch",
    description:
      "Every 15 min — poll provider usage tier; alert when ≥ 80% of the plan window is used.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:continuous",
    schedule: { kind: "every", everyMs: 15 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[oversight:provider-ratelimit-watch] Check provider plan-window usage (the plan-aware credits system: " +
        "credits plans / budgetStatuses). For any provider or budget at or above 80% of its window, emit a " +
        "NOTABLE proactive alert with provider, % used, and remaining. If all under 80%, stay silent. " +
        QUIET,
    },
  },
  {
    name: "oversight-disk-log-rolloff",
    description:
      "Hourly — if ~/.infinibot/logs > 1 GB OR free disk < 5 GB, rotate + compress old logs and alert.",
    enabled: true,
    defaultEnabled: true,
    category: "oversight:continuous",
    schedule: { kind: "every", everyMs: 60 * 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text:
        "[oversight:disk-log-rolloff] Check storage: if ~/.infinibot/logs exceeds 1 GB OR free disk is under 5 GB, " +
        "compress + roll off the oldest logs (gzip files older than 7 days) and emit a CRITICAL proactive alert with " +
        "the freed space. Otherwise stay silent. " +
        QUIET,
    },
  },
];

/** On-event proactive rules (#14–16): event_type → generic oversight_event report. */
export interface OversightEventRule {
  eventType: string;
  description: string;
  defaultEnabled: boolean;
}

export const OVERSIGHT_EVENT_RULES: OversightEventRule[] = [
  {
    eventType: "subagent_failed",
    description:
      "Sub-agent failure — fires a summary with the last 30 lines of stderr to the operator.",
    defaultEnabled: true,
  },
  {
    eventType: "notion_sync_error",
    description: "Notion sync error — auto-retry once, then alert with the row id that failed.",
    defaultEnabled: true,
  },
  {
    eventType: "kanban_p1_blocked",
    description:
      "Critical kanban transition — any P1 task moving to blocked → immediate notification.",
    defaultEnabled: true,
  },
];

/**
 * Idempotently ensure the default oversight cron jobs exist. Safe on every boot;
 * existing jobs (matched by name) are left untouched. Returns newly-created names.
 */
export async function ensureOversightCronJobs(cron: CronService): Promise<string[]> {
  const existing = await cron.list({ includeDisabled: true });
  const names = new Set(existing.map((j) => j.name));
  const enabled = await resolveAutonomySeedEnabled(cron);
  const created: string[] = [];
  for (const spec of OVERSIGHT_CRON_JOBS) {
    if (names.has(spec.name)) continue;
    // Per-client reports belong to the Business & Agency plugin: seeded only
    // while it is loaded (src/business-agency/cron.ts).
    if (isBusinessAgencyCronJob(spec.name) && !isBusinessAgencyActive()) continue;
    await addAutonomyJob(cron, spec, { enabled });
    created.push(spec.name);
  }
  return created;
}

/**
 * Idempotently ensure the on-event oversight rules exist as report_triggers in
 * the reports store. Best-effort: a store failure (e.g. reports schema not yet
 * migrated) is swallowed so it never blocks boot. Returns created eventTypes.
 */
export async function ensureOversightEventTriggers(): Promise<string[]> {
  const created: string[] = [];
  try {
    const { getReportsStore } = await import("../reports/store.js");
    const store = getReportsStore();
    for (const rule of OVERSIGHT_EVENT_RULES) {
      const existing = store.listTriggers(rule.eventType) ?? [];
      if (existing.some((t) => t.kind === "oversight_event")) continue;
      store.upsertTrigger({
        kind: "oversight_event",
        eventType: rule.eventType,
        theme: "black-gold",
        enabled: rule.defaultEnabled,
        // subagent_failed fires on every failed sub-agent — telegram spam.
        // UI-only; operator can re-enable telegram per-trigger in the DB if desired.
        sinks: rule.eventType === "subagent_failed" ? ["ui"] : ["ui", "telegram"],
        config: { category: "oversight:event" },
      });
      created.push(rule.eventType);
    }
  } catch {
    // reports store unavailable — triggers will seed on a later boot
  }
  return created;
}
