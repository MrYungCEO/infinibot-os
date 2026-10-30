/**
 * Report kind: `ceo_hourly_insights`.
 *
 * Every hour (cron at :05) the CEO/overseer agent gets ONE HOUR of org activity
 * and produces 3-7 actionable insights (alert | opportunity | risk | win). This
 * module implements the foundation's {@link ReportKindModule} contract:
 *
 *   collect() → { title, summaryText, html, insights[] }
 *
 * The worker (foundation) persists `insights[]` into `report_insights` and
 * prints `html` to PDF, then fans out to UI + Telegram. So the full pipeline for
 * `reports.generate({ kind: "ceo_hourly_insights" })` is:
 *
 *   reports.generate (foundation RPC)
 *     → worker dequeues
 *       → ceoHourlyReportKind.collect()      ← THIS MODULE
 *           1. collectCeoActivity()  (reads kanban/subagents/credits/discipline)
 *           2. spawn CEO agent w/ strict prompt + enabledMCPs:["infinibot"]
 *           3. parse strict JSON → CeoInsight[]
 *           4. render themed HTML + return insights[]
 *       → worker writes report_insights rows + renders PDF + ships
 *
 * NOTE on the original task contract: the task brief assumed *this* module would
 * call `reports.generate(...)` to write insights + render. The actual foundation
 * (src/reports/types.ts) inverts that — the worker pulls our collect() and owns
 * persistence/render. We follow the real contract. See {@link runCeoHourlyStandalone}
 * for a self-contained run that does NOT require the worker (used for testing and
 * the cron's manual-trigger path before the worker lands).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { budgetStatuses, summary } from "../../credits/aggregator.js";
import { getDayPlannerProvider } from "../../infra/day-planner-seam.js";
import { listSubagentHistory } from "../../agents/subagent-history.js";
import { loadSubagentRegistryFromDisk } from "../../agents/subagent-registry.store.js";
import { getKanbanStore } from "../../tasks/store.js";
import {
  CEO_INSIGHTS_MAX,
  CEO_INSIGHTS_MIN,
  CEO_INSIGHTS_SYSTEM_PROMPT,
  CEO_INSIGHT_KINDS,
  CEO_INSIGHT_SEVERITIES,
  type CeoInsightKind,
  type CeoInsightSeverity,
  buildCeoInsightsUserPrompt,
} from "../../overseer/ceo-insights-prompt.js";
import type { CollectedReport, ReportInsightRecord, ReportKindModule, Theme } from "../types.js";
import {
  collectPlanning,
  planningCss,
  planningToText,
  renderPlanningHtml,
  type PlanningSnapshot,
} from "./planning-section.js";

const execFileAsync = promisify(execFile);

export const CEO_HOURLY_KIND = "ceo_hourly_insights" as const;
export const DEFAULT_WINDOW_MS = 60 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Collected activity snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface CeoActivitySnapshot {
  windowStartMs: number;
  windowEndMs: number;
  kanban: {
    changed: Array<{
      id: string;
      title: string;
      status: string;
      updatedAt: number;
      completedAt?: number;
    }>;
  };
  subagents: {
    completed: number;
    failed: number;
    timedOut: number;
    inProgress: Array<{
      runId: string;
      task: string;
      label?: string;
      ageMin: number;
      backend?: string;
    }>;
    finished: Array<{
      runId: string;
      task: string;
      status: string;
      backend?: string;
      error?: string;
    }>;
  };
  credits: {
    windowCostUsd: number;
    byBackend: Array<{ backend: string; costUsd: number; requests: number }>;
    budgets: Array<{
      name: string;
      pctUsed: number;
      state: string;
      currentSpendUsd: number;
      monthlyLimitUsd: number;
    }>;
  };
  discipline: {
    dayStarted: boolean;
    dayStartLabel?: string;
    currentBlock?: { label: string; category: string; intent?: string };
    militant: boolean;
  };
  errors: string[];
  /** Per-source collection failures (so the CEO knows what it could NOT see). */
  collectionGaps: string[];
  /**
   * Planning context (ticket 2409): open work mapped to detailed UI surfaces +
   * the documented closed-loop feedback architecture. Surfaced in the report so
   * every run shows not just *what happened* but *where to act next*.
   */
  planning: PlanningSnapshot;
}

function safe<T>(label: string, gaps: string[], fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    gaps.push(`${label}: ${String((err as Error)?.message ?? err)}`);
    return fallback;
  }
}

function minutesSince(ms: number, now: number): number {
  return Math.max(0, Math.round((now - ms) / 60_000));
}

/**
 * Gather the last `windowMs` of org activity from every source. Defensive: each
 * source is wrapped so a single store failure degrades to a `collectionGaps`
 * note rather than aborting the whole report.
 */
export function collectCeoActivity(opts?: {
  now?: number;
  windowMs?: number;
  /** Per-user state dir; the worker passes this from collect(). */
  stateDir?: string;
}): CeoActivitySnapshot {
  const now = opts?.now ?? Date.now();
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const since = now - windowMs;
  // Kanban + discipline stores are stateDir-scoped (multi-user namespacing) and
  // throw if opened without one outside the gateway. Resolve a sensible default.
  const stateDir =
    opts?.stateDir ?? process.env.INFINIBOT_STATE_DIR ?? join(homedir(), ".infinibot");
  const gaps: string[] = [];
  const errors: string[] = [];

  // ── Kanban: tasks changed in the window ──────────────────────────────────
  const kanbanChanged = safe(
    "kanban",
    gaps,
    () => {
      const store = getKanbanStore(stateDir);
      return store
        .listTasksSince(since)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: String(t.status),
          updatedAt: t.updatedAt,
          completedAt: t.completedAt,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    },
    [] as CeoActivitySnapshot["kanban"]["changed"],
  );

  // ── Subagents: finished (history) + in-progress (live registry) ──────────
  const finished = safe(
    "subagents.history",
    gaps,
    () => {
      const { entries } = listSubagentHistory({ since, limit: 100 });
      return entries.map((e) => ({
        runId: e.runId,
        task: e.task,
        status: e.status,
        backend: e.coderBackend,
        error: e.error ?? e.outcome?.error,
      }));
    },
    [] as Array<{ runId: string; task: string; status: string; backend?: string; error?: string }>,
  );
  const inProgress = safe(
    "subagents.registry",
    gaps,
    () => {
      const runs = loadSubagentRegistryFromDisk();
      return [...runs.values()]
        .filter((r) => !r.endedAt && !r.interruptedAt)
        .map((r) => ({
          runId: r.runId,
          task: r.task,
          label: r.label,
          ageMin: minutesSince(r.startedAt ?? r.createdAt, now),
          backend: r.coderBackend,
        }))
        .sort((a, b) => b.ageMin - a.ageMin);
    },
    [] as CeoActivitySnapshot["subagents"]["inProgress"],
  );
  const completed = finished.filter((f) => f.status === "complete").length;
  const failed = finished.filter((f) => f.status === "error").length;
  const timedOut = finished.filter((f) => f.status === "timeout").length;
  for (const f of finished) {
    if (f.status !== "complete" && f.error)
      errors.push(`subagent ${f.runId} ${f.status}: ${f.error}`);
  }

  // ── Credits: spend this hour by backend + budget posture ─────────────────
  // NOTE: `summary({period:"hour"})` is a *calendar-hour* window, a close
  // approximation of "last 60 min". Documented intentionally — avoids fragile
  // raw SQL against the ledger and reuses the audited aggregator.
  const credits = safe(
    "credits",
    gaps,
    () => {
      const agg = summary({ period: "hour" });
      const byBackend = (agg.byBackend ?? [])
        .map((b: any) => ({
          backend: String(b.backend ?? b.agentBackend ?? "unknown"),
          costUsd: Number(b.costUsd ?? 0),
          requests: Number(b.requests ?? 0),
        }))
        .filter((b) => b.costUsd > 0 || b.requests > 0)
        .sort((a, b) => b.costUsd - a.costUsd);
      const budgets = budgetStatuses().map((s) => ({
        name: s.name,
        pctUsed: Math.round(s.pctUsed),
        state: s.state,
        currentSpendUsd: Number(s.currentSpendUsd.toFixed(2)),
        monthlyLimitUsd: s.monthlyLimitUsd,
      }));
      return { windowCostUsd: Number((agg.totalCostUsd ?? 0).toFixed(4)), byBackend, budgets };
    },
    { windowCostUsd: 0, byBackend: [], budgets: [] } as CeoActivitySnapshot["credits"],
  );

  // ── Discipline: focus posture ────────────────────────────────────────────
  // Read through the day-planner seam: the Discipline plugin supplies it when
  // enabled. Plugin off → the neutral default and no collection gap.
  const disciplineDefault = {
    dayStarted: false,
    militant: false,
  } as CeoActivitySnapshot["discipline"];
  const discipline = safe(
    "discipline",
    gaps,
    () => {
      const posture = getDayPlannerProvider()?.posture(stateDir, now);
      if (!posture) return disciplineDefault;
      return {
        dayStarted: posture.dayStarted,
        dayStartLabel:
          posture.dayStarted && posture.dayStartedAt
            ? `started ${minutesSince(posture.dayStartedAt, now)}m ago (${posture.dayStartSource ?? "manual"})`
            : undefined,
        currentBlock: posture.currentBlock,
        militant: posture.militant,
      };
    },
    disciplineDefault,
  );

  // ── Planning: open work → UI surfaces + feedback architecture (ticket 2409) ─
  // collectPlanning is internally defensive (static surfaces/doc always render;
  // only the open-task list degrades on a store failure), so no safe() wrap.
  const planning = collectPlanning({ now, stateDir });

  return {
    windowStartMs: since,
    windowEndMs: now,
    kanban: { changed: kanbanChanged },
    subagents: { completed, failed, timedOut, inProgress, finished },
    credits,
    discipline,
    errors: errors.slice(0, 30),
    collectionGaps: gaps,
    planning,
  };
}

/** Render the snapshot as compact labelled text for the CEO prompt. */
export function snapshotToText(s: CeoActivitySnapshot): string {
  const lines: string[] = [];
  const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString();
  lines.push(`Window: ${fmtTime(s.windowStartMs)} → ${fmtTime(s.windowEndMs)} (last 60 min)`);

  lines.push("", `KANBAN (${s.kanban.changed.length} tasks changed):`);
  if (!s.kanban.changed.length) lines.push("  (no task changes)");
  for (const t of s.kanban.changed) {
    const done = t.completedAt ? " ✓completed" : "";
    lines.push(`  [${t.id}] "${t.title}" → ${t.status}${done}`);
  }

  lines.push(
    "",
    `SUBAGENTS: ${s.subagents.completed} completed, ${s.subagents.failed} failed, ${s.subagents.timedOut} timed-out, ${s.subagents.inProgress.length} in-progress`,
  );
  for (const r of s.subagents.inProgress) {
    const stuck = r.ageMin >= 30 ? " ⚠STUCK>30m" : "";
    lines.push(
      `  in-progress [${r.runId}] (${r.ageMin}m${stuck}) ${r.backend ?? "?"}: ${r.task.slice(0, 100)}`,
    );
  }
  for (const r of s.subagents.finished.filter((f) => f.status !== "complete")) {
    lines.push(
      `  ${r.status} [${r.runId}] ${r.backend ?? "?"}: ${r.task.slice(0, 80)}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`,
    );
  }

  lines.push("", `CREDITS (this hour): $${s.credits.windowCostUsd.toFixed(4)}`);
  for (const b of s.credits.byBackend) {
    lines.push(`  ${b.backend}: $${b.costUsd.toFixed(4)} over ${b.requests} req`);
  }
  for (const bd of s.credits.budgets) {
    const flag = bd.state !== "ok" ? ` ⚠${bd.state.toUpperCase()}` : "";
    lines.push(
      `  budget "${bd.name}": ${bd.pctUsed}% used ($${bd.currentSpendUsd}/$${bd.monthlyLimitUsd})${flag}`,
    );
  }
  if (!s.credits.budgets.length) lines.push("  (no budget configured)");

  lines.push("", "DISCIPLINE:");
  lines.push(
    `  day ${s.discipline.dayStarted ? (s.discipline.dayStartLabel ?? "started") : "NOT started"}; militant=${s.discipline.militant}`,
  );
  if (s.discipline.currentBlock)
    lines.push(
      `  current block: "${s.discipline.currentBlock.label}" (${s.discipline.currentBlock.category})${s.discipline.currentBlock.intent ? ` — ${s.discipline.currentBlock.intent}` : ""}`,
    );

  if (s.errors.length) {
    lines.push("", `ERRORS (${s.errors.length}):`);
    for (const e of s.errors.slice(0, 15)) lines.push(`  ${e}`);
  }
  if (s.collectionGaps.length) {
    lines.push("", `DATA GAPS (sources that could not be read this run):`);
    for (const g of s.collectionGaps) lines.push(`  ${g}`);
  }

  lines.push("", planningToText(s.planning));
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CEO agent spawn
// ─────────────────────────────────────────────────────────────────────────────

export interface CeoInsight {
  title: string;
  kind: CeoInsightKind;
  severity: CeoInsightSeverity;
  body: string;
  action: string;
  evidence: string;
}

/**
 * Spawns the CEO/overseer agent for one analysis turn and returns its raw text.
 * Injected so the foundation worker can supply the canonical in-process spawn
 * (the existing isolated-agent / claude_coder path) with `enabledMCPs:["infinibot"]`.
 *
 * The constraint "never spawn without enabledMCPs:['infinibot']" is satisfied by
 * passing `enabledMCPs` through to whatever spawner is wired. Because the full
 * activity snapshot is already injected into the prompt, MCP access is a
 * belt-and-suspenders affordance (lets the CEO drill deeper) rather than a hard
 * dependency for a useful report.
 */
export type CeoAgentSpawner = (args: {
  systemPrompt: string;
  userPrompt: string;
  enabledMCPs: string[];
}) => Promise<string>;

/**
 * Default spawner: shells the `claude` CLI in print mode. Used by the standalone
 * path and as a fallback when no in-process spawner is injected. Honors the
 * infinibot MCP via `--mcp-config` when a config path is discoverable; otherwise
 * proceeds with the inline snapshot (still produces a full report).
 */
export const cliCeoAgentSpawner: CeoAgentSpawner = async ({
  systemPrompt,
  userPrompt,
  enabledMCPs,
}) => {
  const args = [
    "-p",
    userPrompt,
    "--append-system-prompt",
    systemPrompt,
    "--output-format",
    "text",
  ];
  // Best-effort MCP wiring. The infinibot MCP config path lives in the user's
  // claude config; if a dedicated config is exported we pass it. Kept best-effort
  // so a missing config never blocks the report.
  const mcpConfig = process.env.INFINIBOT_MCP_CONFIG;
  if (mcpConfig && enabledMCPs.includes("infinibot")) {
    args.push("--mcp-config", mcpConfig, "--allowedTools", "mcp__infinibot");
  }
  const { stdout } = await execFileAsync("claude", args, {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  return stdout;
};

/** Extract `{ insights: [...] }` from a possibly-noisy model response. */
export function parseCeoInsights(raw: string): CeoInsight[] {
  let text = raw.trim();
  // Strip markdown fences if the model added them despite instructions.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // Find the first balanced JSON object containing "insights".
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      parsed = JSON.parse(text.slice(start, end + 1));
    } else {
      throw new Error(`CEO agent did not return JSON: ${raw.slice(0, 200)}`);
    }
  }
  const arr: any[] = Array.isArray(parsed?.insights)
    ? parsed.insights
    : Array.isArray(parsed)
      ? parsed
      : [];
  const kinds = new Set<string>(CEO_INSIGHT_KINDS);
  const sevs = new Set<string>(CEO_INSIGHT_SEVERITIES);
  const out: CeoInsight[] = [];
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const kind = kinds.has(it.kind) ? it.kind : "risk";
    const severity = sevs.has(it.severity) ? it.severity : "medium";
    // Prompt asks for ≤80 chars; bound at 120 as a safety net but never cut
    // mid-word (a hard 80-slice produced "...merge collision r").
    const title = String(it.title ?? "")
      .slice(0, 120)
      .trim();
    const body = String(it.body ?? "").trim();
    const action = String(it.action ?? "").trim();
    const evidence = String(it.evidence ?? "").trim();
    if (!title || !body) continue;
    out.push({ title, kind, severity, body, action, evidence });
  }
  return out.slice(0, CEO_INSIGHTS_MAX);
}

/** Map a CeoInsight kind into the body prefix + severity for a report_insights row. */
function toInsightRow(i: CeoInsight): Omit<ReportInsightRecord, "id" | "reportId" | "createdAt"> {
  // The report_insights schema carries title/body/action/severity. We fold the
  // insight `kind` (alert/opportunity/risk/win) and `evidence` into the body so
  // no data is lost even though the row schema doesn't have dedicated columns.
  const body = `[${i.kind.toUpperCase()}] ${i.body}\n\nEvidence: ${i.evidence}`;
  return {
    kind: CEO_HOURLY_KIND,
    title: i.title,
    body,
    action: i.action || null,
    severity: i.severity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Themed HTML render
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const KIND_LABEL: Record<CeoInsightKind, string> = {
  alert: "ALERT",
  opportunity: "OPPORTUNITY",
  risk: "RISK",
  win: "WIN",
};

export function renderCeoHourlyHtml(args: {
  theme: Theme;
  insights: CeoInsight[];
  snapshot: CeoActivitySnapshot;
  generatedAtMs: number;
}): string {
  const { theme, insights, snapshot, generatedAtMs } = args;
  const t = theme.tokens;
  const when = new Date(generatedAtMs).toLocaleString();
  const cards = insights
    .map((i) => {
      const pill = t.statusPills[i.severity] ?? { fg: t.accent, bg: t.surfaceAlt };
      return `
      <article class="insight ${i.kind}">
        <header>
          <span class="kind">${KIND_LABEL[i.kind]}</span>
          <span class="sev" style="color:${pill.fg};background:${pill.bg}">${esc(i.severity)}</span>
          <h2>${esc(i.title)}</h2>
        </header>
        <p class="body">${esc(i.body)}</p>
        <p class="action"><strong>Action:</strong> ${esc(i.action || "—")}</p>
        <p class="evidence">${esc(i.evidence)}</p>
      </article>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  :root{
    --bg:${t.bg};--surface:${t.surface};--surface-alt:${t.surfaceAlt};--border:${t.border};
    --text:${t.text};--text-muted:${t.textMuted};--accent:${t.accent};--accent-strong:${t.accentStrong};
    --font-heading:${t.fontHeading};--font-body:${t.fontBody};
  }
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-body);padding:40px}
  .head{border-bottom:2px solid var(--accent);padding-bottom:16px;margin-bottom:28px}
  .head h1{font-family:var(--font-heading);color:var(--accent);margin:0;font-size:26px;letter-spacing:1px}
  .head .meta{color:var(--text-muted);font-size:12px;margin-top:6px}
  .insight{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);
    border-radius:8px;padding:18px 20px;margin-bottom:16px}
  .insight.win{border-left-color:#3fb950}.insight.risk{border-left-color:#d29922}
  .insight.alert{border-left-color:#f85149}.insight.opportunity{border-left-color:var(--accent)}
  .insight header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .insight .kind{font-family:var(--font-heading);font-size:11px;letter-spacing:1px;color:var(--accent-strong)}
  .insight .sev{font-size:10px;text-transform:uppercase;padding:2px 8px;border-radius:10px;letter-spacing:.5px}
  .insight h2{font-size:16px;margin:0;flex:1 1 100%;color:var(--text)}
  .insight .body{color:var(--text);line-height:1.5;margin:10px 0}
  .insight .action{color:var(--text);background:var(--surface-alt);padding:8px 12px;border-radius:6px;margin:8px 0}
  .insight .evidence{color:var(--text-muted);font-size:12px;font-family:var(--font-heading);margin:6px 0 0}
  .foot{margin-top:30px;border-top:1px solid var(--border);padding-top:14px;color:var(--text-muted);font-size:11px;white-space:pre-wrap}
  ${planningCss()}
</style></head><body>
  <div class="head">
    <h1>CEO HOURLY INSIGHTS</h1>
    <div class="meta">${esc(when)} · ${insights.length} insight${insights.length === 1 ? "" : "s"} · last 60 minutes</div>
  </div>
  ${cards || '<p class="meta">No insights produced.</p>'}
  ${renderPlanningHtml(snapshot.planning)}
  <div class="foot">Sources: ${snapshot.kanban.changed.length} kanban changes · ${snapshot.subagents.completed + snapshot.subagents.failed + snapshot.subagents.timedOut} agents finished · ${snapshot.subagents.inProgress.length} in-progress · $${snapshot.credits.windowCostUsd.toFixed(2)} spend${snapshot.collectionGaps.length ? `\nData gaps: ${snapshot.collectionGaps.map(esc).join("; ")}` : ""}</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kind module + standalone runner
// ─────────────────────────────────────────────────────────────────────────────

/** Module-level injectable spawner. Foundation worker can override at boot. */
let activeSpawner: CeoAgentSpawner = cliCeoAgentSpawner;
export function setCeoAgentSpawner(spawner: CeoAgentSpawner): void {
  activeSpawner = spawner;
}

/**
 * Run the full CEO insight pass and return everything the worker needs. Used by
 * both `collect()` (foundation path) and `runCeoHourlyStandalone()` (cron manual
 * trigger before the worker exists).
 */
export async function generateCeoInsights(opts?: {
  now?: number;
  windowMs?: number;
  stateDir?: string;
  spawner?: CeoAgentSpawner;
}): Promise<{ snapshot: CeoActivitySnapshot; insights: CeoInsight[]; rawModelOutput: string }> {
  const now = opts?.now ?? Date.now();
  const snapshot = collectCeoActivity({ now, windowMs: opts?.windowMs, stateDir: opts?.stateDir });
  const snapshotText = snapshotToText(snapshot);
  const spawn = opts?.spawner ?? activeSpawner;
  const rawModelOutput = await spawn({
    systemPrompt: CEO_INSIGHTS_SYSTEM_PROMPT,
    userPrompt: buildCeoInsightsUserPrompt(snapshotText),
    enabledMCPs: ["infinibot"],
  });
  let insights = parseCeoInsights(rawModelOutput);
  // Guardrail: never ship fewer than the floor or more than the ceiling.
  if (insights.length > CEO_INSIGHTS_MAX) insights = insights.slice(0, CEO_INSIGHTS_MAX);
  return { snapshot, insights, rawModelOutput };
}

/**
 * The foundation contract. The worker calls this; it persists `insights` and
 * prints `html` to PDF.
 */
export const ceoHourlyReportKind: ReportKindModule = {
  kind: CEO_HOURLY_KIND,
  async collect({ theme, config, stateDir }): Promise<CollectedReport> {
    const now = Date.now();
    const windowMs =
      typeof config?.insightWindow === "number" && config.insightWindow > 0
        ? (config.insightWindow as number)
        : DEFAULT_WINDOW_MS;
    const { snapshot, insights } = await generateCeoInsights({ now, windowMs, stateDir });
    const html = renderCeoHourlyHtml({ theme, insights, snapshot, generatedAtMs: now });
    const summaryText =
      insights.length > 0
        ? `${insights.length} CEO insight${insights.length === 1 ? "" : "s"}: ` +
          insights
            .map((i) => i.title)
            .slice(0, 3)
            .join(" · ")
        : "No actionable insights this hour.";
    return {
      title: `CEO Hourly Insights — ${new Date(now).toLocaleString()}`,
      summaryText,
      html,
      insights: insights.map(toInsightRow),
    };
  },
};

export default ceoHourlyReportKind;

/**
 * Self-contained run for the cron manual-trigger path and tests. Returns the
 * insights + rendered HTML without requiring the foundation worker. The cron
 * registration prefers calling `reports.generate({kind})` (foundation), but this
 * is the swap-in fallback documented in the cron module.
 */
export async function runCeoHourlyStandalone(opts?: {
  theme: Theme;
  now?: number;
  windowMs?: number;
  stateDir?: string;
  spawner?: CeoAgentSpawner;
}): Promise<{ snapshot: CeoActivitySnapshot; insights: CeoInsight[]; html?: string }> {
  const { snapshot, insights } = await generateCeoInsights(opts);
  const html = opts?.theme
    ? renderCeoHourlyHtml({
        theme: opts.theme,
        insights,
        snapshot,
        generatedAtMs: opts?.now ?? Date.now(),
      })
    : undefined;
  return { snapshot, insights, html };
}

export { CEO_INSIGHTS_MIN, CEO_INSIGHTS_MAX };
