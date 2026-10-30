/**
 * Planning section for automated reports (ticket 2409 — "Closed-loop + recursive
 * InfiniBot — feedback architecture & rollout").
 *
 * The CEO hourly report (and any other report kind that wants it) embeds a
 * PLANNING block that does three things the rest of the report did not:
 *
 *   1. DETAILED UI SURFACES — an explicit catalog of the InfiniBot control-UI
 *      surfaces, what each is for, and its role in the feedback loop. Reports
 *      previously listed *what happened* (kanban/credits/agents) but never said
 *      *where* the human acts on it. Planning closes that: every open task is
 *      mapped to the surface where it is driven.
 *
 *   2. OPEN / PLANNED WORK — kanban tasks that are NOT done, each routed to its
 *      UI surface so the report doubles as a "here is what to look at" index.
 *
 *   3. FEEDBACK ARCHITECTURE — the documented closed-loop + recursive InfiniBot
 *      loop, surfaced inside the automated report itself so the architecture is
 *      visible in every run rather than buried in a one-off plan PDF.
 *
 * This module is intentionally self-contained (pure data + two renderers) so it
 * can be reused by other report kinds without dragging in the CEO-specific
 * collection logic.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { getKanbanStore } from "../../tasks/store.js";

/** A single InfiniBot control-UI surface and its role in the feedback loop. */
export interface PlanningSurface {
  /** Route in the control UI (clickable in the dashboard). */
  route: string;
  /** Human label. */
  label: string;
  /** What the operator does here. */
  purpose: string;
  /** This surface's role in the closed-loop / recursive feedback cycle. */
  feedbackRole: string;
}

/**
 * Detailed UI surfaces catalog. This is the canonical list the planning section
 * renders. Ordered to mirror the loop: observe → plan → act → verify.
 */
export const INFINIBOT_UI_SURFACES: PlanningSurface[] = [
  {
    route: "/dashboard",
    label: "Dashboard",
    purpose: "Fleet/world-map overview, health, and at-a-glance status across nodes.",
    feedbackRole: "OBSERVE — top of the loop; surfaces signals that seed the next plan.",
  },
  {
    route: "/reports",
    label: "Reports",
    purpose: "Generated CEO/operational/strategic reports and their persisted insights.",
    feedbackRole:
      "OBSERVE→PLAN — reports are the loop's structured readout; this section lives here.",
  },
  {
    route: "/kanban",
    label: "Projects / Kanban",
    purpose: "Plan, prioritize, and track project tasks (backlog → done).",
    feedbackRole: "PLAN — where insights become tracked, ownable work.",
  },
  {
    route: "/agents",
    label: "Agents",
    purpose: "Spawn, monitor, and retry subagent runs; inspect the agent mesh.",
    feedbackRole:
      "ACT — plans dispatched as autonomous work; recursion happens here (agents spawn agents).",
  },
  {
    route: "/terminals",
    label: "Terminals",
    purpose: "Live terminal/session views for in-flight agent and shell work.",
    feedbackRole: "ACT — direct execution surface for hands-on intervention.",
  },
  {
    route: "/grid",
    label: "Grid",
    purpose: "Multi-session grid for watching many agents/terminals at once.",
    feedbackRole: "VERIFY — wide-angle confirmation that dispatched work is progressing.",
  },
  {
    route: "/chat",
    label: "Chat",
    purpose: "Conversational control surface with the main session.",
    feedbackRole: "ACT/VERIFY — the human-in-the-loop steering channel.",
  },
  {
    route: "/discipline",
    label: "Discipline",
    purpose: "Time-blocking, routines, and focus posture.",
    feedbackRole: "PLAN — aligns the day's blocks with the work the loop surfaces.",
  },
  {
    route: "/clients",
    label: "Clients (CRM)",
    purpose: "Lead/client records driving the closed-loop lead pipeline.",
    feedbackRole: "ACT — outbound side of the closed-loop lead cadence.",
  },
];

/**
 * Closed-loop + recursive InfiniBot feedback architecture (ticket 2409).
 * Documented here so it ships *inside* every report that includes the planning
 * section, rather than only in the original plan PDF.
 */
export const FEEDBACK_ARCHITECTURE = {
  ticketRef: "2409",
  title: "Closed-loop + recursive InfiniBot — feedback architecture & rollout",
  summary:
    "InfiniBot runs a closed feedback loop: activity is continuously observed, " +
    "compressed into reports + insights, turned into planned work, dispatched to " +
    "agents, and verified by the next observation pass. The loop is RECURSIVE — " +
    "reports analyze prior reports, and agents spawn agents — so each cycle " +
    "compounds on the last instead of starting from zero.",
  stages: [
    "OBSERVE — collect kanban/agents/credits/discipline activity over the window (dashboard, reports).",
    "REPORT — the CEO/overseer agent compresses activity into actionable insights.",
    "PLAN — insights + open tasks are mapped to UI surfaces (this section); work is queued on the kanban.",
    "ACT — planned work is dispatched to subagents / cron (agents, terminals, lead cadence).",
    "VERIFY — the next report measures the effect of the last cycle's actions.",
    "RECURSE — reports analyze prior reports and agents spawn sub-agents, compounding each loop.",
  ],
} as const;

/** What the planning section collects each run. */
export interface PlanningSnapshot {
  /** Open (not-done) kanban tasks, each routed to the surface that drives it. */
  openTasks: Array<{ id: string; title: string; status: string; surface: string }>;
  /** Detailed UI surfaces catalog. */
  surfaces: PlanningSurface[];
  /** The documented closed-loop + recursive feedback architecture. */
  feedbackArchitecture: typeof FEEDBACK_ARCHITECTURE;
}

const DONE_STATUSES = new Set(["done", "completed", "complete", "cancelled", "canceled"]);
const PLANNING_LOOKBACK_MS = 30 * 24 * 60 * 60_000; // 30 days of recently-touched work

/** Map a task status to the UI surface where it is primarily driven. */
function surfaceForStatus(status: string): string {
  const s = status.toLowerCase();
  if (s === "in_progress" || s === "review") return "/agents";
  return "/kanban";
}

/**
 * Collect the planning snapshot. Synchronous and defensive: a kanban store
 * failure degrades to an empty open-task list (the surfaces catalog + feedback
 * doc are static and always render).
 */
export function collectPlanning(opts?: { now?: number; stateDir?: string }): PlanningSnapshot {
  const now = opts?.now ?? Date.now();
  const stateDir =
    opts?.stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
  let openTasks: PlanningSnapshot["openTasks"] = [];
  try {
    const store = getKanbanStore(stateDir);
    openTasks = store
      .listTasksSince(now - PLANNING_LOOKBACK_MS)
      .filter((t) => !DONE_STATUSES.has(String(t.status).toLowerCase()) && !t.completedAt)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: String(t.status),
        surface: surfaceForStatus(String(t.status)),
      }))
      .slice(0, 25);
  } catch {
    openTasks = [];
  }
  return {
    openTasks,
    surfaces: INFINIBOT_UI_SURFACES,
    feedbackArchitecture: FEEDBACK_ARCHITECTURE,
  };
}

/** Render the planning snapshot as compact labelled text (for the CEO prompt). */
export function planningToText(p: PlanningSnapshot): string {
  const lines: string[] = [];
  lines.push("PLANNING — open work & where to act:");
  if (!p.openTasks.length) lines.push("  (no open tasks in the last 30 days)");
  for (const t of p.openTasks)
    lines.push(`  [${t.id}] "${t.title}" → ${t.status} · surface ${t.surface}`);

  lines.push("", "DETAILED UI SURFACES:");
  for (const s of p.surfaces)
    lines.push(`  ${s.route} (${s.label}) — ${s.purpose} [${s.feedbackRole}]`);

  const fa = p.feedbackArchitecture;
  lines.push("", `FEEDBACK ARCHITECTURE (ticket ${fa.ticketRef}) — ${fa.title}:`);
  lines.push(`  ${fa.summary}`);
  for (const stage of fa.stages) lines.push(`  • ${stage}`);
  return lines.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render the planning section as a themed HTML fragment for the report PDF. */
export function renderPlanningHtml(p: PlanningSnapshot): string {
  const fa = p.feedbackArchitecture;
  const tasks = p.openTasks.length
    ? p.openTasks
        .map(
          (t) =>
            `<li><code>${esc(t.id)}</code> ${esc(t.title)} <span class="pl-status">${esc(t.status)}</span> <span class="pl-surface">${esc(t.surface)}</span></li>`,
        )
        .join("")
    : '<li class="pl-empty">No open tasks in the last 30 days.</li>';

  const surfaces = p.surfaces
    .map(
      (s) =>
        `<tr><td><code>${esc(s.route)}</code></td><td>${esc(s.label)}</td><td>${esc(s.purpose)}</td><td class="pl-role">${esc(s.feedbackRole)}</td></tr>`,
    )
    .join("");

  const stages = fa.stages.map((s) => `<li>${esc(s)}</li>`).join("");

  return `
  <section class="planning">
    <h2 class="pl-h">PLANNING</h2>

    <h3 class="pl-sub">Open work &amp; where to act</h3>
    <ul class="pl-tasks">${tasks}</ul>

    <h3 class="pl-sub">Detailed UI surfaces</h3>
    <table class="pl-surfaces">
      <thead><tr><th>Route</th><th>Surface</th><th>Purpose</th><th>Feedback role</th></tr></thead>
      <tbody>${surfaces}</tbody>
    </table>

    <h3 class="pl-sub">Feedback architecture <span class="pl-ticket">ticket ${esc(fa.ticketRef)}</span></h3>
    <p class="pl-fa-title">${esc(fa.title)}</p>
    <p class="pl-fa-summary">${esc(fa.summary)}</p>
    <ol class="pl-stages">${stages}</ol>
  </section>`;
}

/** CSS for the planning section, appended to the report stylesheet. */
export function planningCss(): string {
  return `
  .planning{margin-top:30px;border-top:2px solid var(--accent);padding-top:18px}
  .planning .pl-h{font-family:var(--font-heading);color:var(--accent);letter-spacing:1px;font-size:18px;margin:0 0 12px}
  .planning .pl-sub{font-family:var(--font-heading);color:var(--accent-strong);font-size:13px;letter-spacing:.5px;margin:18px 0 8px}
  .planning .pl-ticket{font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:10px;padding:1px 8px;margin-left:6px}
  .planning ul,.planning ol{margin:0;padding-left:18px}
  .planning .pl-tasks li{margin:4px 0;line-height:1.4}
  .planning .pl-tasks code{color:var(--accent);font-family:var(--font-heading);font-size:11px}
  .planning .pl-status{font-size:10px;text-transform:uppercase;color:var(--text-muted);margin-left:6px}
  .planning .pl-surface{font-size:10px;color:var(--accent-strong);background:var(--surface-alt);padding:1px 6px;border-radius:8px;margin-left:6px}
  .planning .pl-empty{color:var(--text-muted)}
  .planning .pl-surfaces{width:100%;border-collapse:collapse;font-size:12px;margin-top:4px}
  .planning .pl-surfaces th{text-align:left;color:var(--text-muted);font-family:var(--font-heading);font-size:10px;letter-spacing:.5px;border-bottom:1px solid var(--border);padding:6px 8px}
  .planning .pl-surfaces td{border-bottom:1px solid var(--border);padding:6px 8px;vertical-align:top;color:var(--text)}
  .planning .pl-surfaces code{color:var(--accent)}
  .planning .pl-role{color:var(--text-muted);font-size:11px}
  .planning .pl-fa-title{color:var(--text);font-weight:600;margin:6px 0}
  .planning .pl-fa-summary{color:var(--text);line-height:1.5;margin:6px 0}
  .planning .pl-stages li{margin:4px 0;line-height:1.4;color:var(--text)}`;
}
