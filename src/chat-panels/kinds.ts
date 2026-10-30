/**
 * Chat panel kinds — each maps `{ query }` onto EXISTING gateway RPCs (no new
 * stores) and turns what came back into a compact, factual summary + a markdown
 * fallback for channels that can't render UI.
 *
 * HONESTY (carried over from the OmniTrade panels): summary/count/empty are
 * derived only from what the RPCs returned. A lookup that finds nothing throws
 * a real, specific error (with suggestions) rather than inventing a record.
 *
 * Adding a kind = one entry here + one renderer in
 * ui/src/ui/chat-panels/panel-renderers.ts. Keep the two in lockstep.
 */

import type { PanelCaller, PanelKindDef, PanelQuery } from "./types.js";

// ── small honest helpers ────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

export function str(q: PanelQuery, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = q[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

export function num(q: PanelQuery, k: string): number | undefined {
  const v = q[k];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function arr(v: unknown, key?: string): Rec[] {
  const src = key && v && typeof v === "object" && !Array.isArray(v) ? (v as Rec)[key] : v;
  return Array.isArray(src) ? (src.filter((x) => x && typeof x === "object") as Rec[]) : [];
}

function s(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function money(n?: number): string {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  return `${sign}$${Math.round(a)}`;
}

function clampLimit(q: PanelQuery, def: number, max: number): number {
  return Math.min(max, Math.max(1, Math.floor(num(q, "limit") ?? def)));
}

function mdEscape(v: unknown): string {
  return s(v).replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 80);
}

export function mdTable(columns: string[], rows: unknown[][], max = 15): string {
  if (!rows.length) return "_(no rows)_";
  const head = `| ${columns.map(mdEscape).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, max)
    .map((r) => `| ${columns.map((_, i) => mdEscape(r[i])).join(" | ")} |`)
    .join("\n");
  const more = rows.length > max ? `\n_…and ${rows.length - max} more_` : "";
  return `${head}\n${body}${more}`;
}

/** Find a record by exact id, then exact name, then substring name. */
export function findByIdOrName(
  items: Rec[],
  needle: string,
  nameKeys: string[] = ["name", "title"],
): Rec | undefined {
  const n = needle.toLowerCase();
  const byId = items.find((i) => s(i.id) === needle || s(i.notionId) === needle);
  if (byId) return byId;
  const names = (i: Rec) => nameKeys.map((k) => s(i[k]).toLowerCase()).filter(Boolean);
  return (
    items.find((i) => names(i).includes(n)) ??
    items.find((i) => names(i).some((x) => x.includes(n)))
  );
}

function suggestions(items: Rec[], key = "name"): string {
  const names = items
    .map((i) => s(i[key]))
    .filter(Boolean)
    .slice(0, 6);
  return names.length ? ` Known: ${names.map((x) => `"${x}"`).join(", ")}.` : "";
}

function ts(v: unknown): number {
  if (typeof v === "number") return v;
  const p = Date.parse(s(v));
  return Number.isNaN(p) ? 0 : p;
}

// ── kanban helpers (mirror ui views/command-center-shared.ts) ───────────────

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  review: 1,
  todo: 2,
  backlog: 3,
  done: 4,
};
const isDone = (t: Rec) => t.status === "done" || t.done === true;
const isBlocked = (t: Rec) => t.autonomousStatus === "blocked";
function isOverdue(t: Rec): boolean {
  const due = ts(t.dueDate);
  if (!due || isDone(t)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today.getTime();
}
const ACTIVE_PROJECT_STATUSES = new Set([
  "In progress",
  "Updating",
  "Reviewing",
  "Awaiting Client",
]);
const projectIsActive = (p: Rec) => ACTIVE_PROJECT_STATUSES.has(s(p.status));

function pickTask(t: Rec): Rec {
  return {
    id: t.id,
    projectId: t.projectId,
    title: t.title,
    status: t.status,
    priority: t.priority ?? t.priorityLevel,
    assignee: t.assignee ?? t.assignedAgent,
    dueDate: t.dueDate,
    autonomousStatus: t.autonomousStatus,
    updatedAt: t.updatedAt,
    createdAt: t.createdAt,
  };
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** Split a task description into markdown checklist items + remaining prose. */
export function parseChecklist(description: string): { checklist: ChecklistItem[]; prose: string } {
  const checklist: ChecklistItem[] = [];
  const prose: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/.exec(line);
    if (m) checklist.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
    else prose.push(line);
  }
  return { checklist, prose: prose.join("\n").trim() };
}

// ── subagent helpers ────────────────────────────────────────────────────────

const RUNNING = /running|active|in_progress|working|started|pending|spawn/i;
function isRunning(r: Rec): boolean {
  return RUNNING.test(s(r.status)) && !r.endedAt;
}

function pickRun(r: Rec): Rec {
  return {
    runId: r.runId,
    sessionKey: r.sessionKey,
    label: r.label,
    task: r.task,
    status: r.status,
    progress: r.progress,
    currentCheckpoint: r.currentCheckpoint,
    checkpoints: r.checkpoints,
    startedAt: r.startedAt ?? r.createdAt,
    endedAt: r.endedAt,
    lastUpdateAt: r.lastUpdateAt,
    lastActivity: r.lastActivity,
    outcome: r.outcome,
    coderBackend: r.coderBackend,
    filesTouchedCount: r.filesTouchedCount,
    remote: r.remote,
    nodeName: r.nodeName,
  };
}

async function listSubagents(call: PanelCaller, params: Rec): Promise<Rec[]> {
  return arr(await call("subagents.list", params), "subagents");
}

function runName(r: Rec): string {
  return s(r.label) || s(r.task).slice(0, 60) || s(r.runId).slice(0, 8);
}

// ── kinds ───────────────────────────────────────────────────────────────────

const mesh: PanelKindDef = {
  id: "mesh",
  title: "Agent Mesh",
  description: "the LIVE isometric agent mesh map (who is working on what right now)",
  queryHelp: "mesh: {} (no params)",
  refreshMs: 5000,
  methods: ["subagents.list", "agents.list"],
  async resolve(_q, call) {
    const [subsR, agentsR] = await Promise.allSettled([
      listSubagents(call, { includeCompleted: true, limit: 40, updatesTail: 1 }),
      call("agents.list", {}),
    ]);
    if (subsR.status === "rejected" && agentsR.status === "rejected") throw subsR.reason;
    const subs = subsR.status === "fulfilled" ? subsR.value : [];
    const agents = agentsR.status === "fulfilled" ? arr(agentsR.value, "agents") : [];
    const running = subs.filter(isRunning).map(pickRun);
    const recent = subs
      .filter((r) => !isRunning(r))
      .slice(0, 6)
      .map(pickRun);
    const data = {
      agents: agents.map((a) => ({
        id: a.id,
        name: s((a.identity as Rec | undefined)?.name) || s(a.name) || s(a.id),
        emoji: (a.identity as Rec | undefined)?.emoji,
        model: a.model,
      })),
      running,
      recent,
      counts: { agents: agents.length, running: running.length, recent: recent.length },
    };
    return {
      data,
      count: running.length,
      empty: agents.length === 0 && subs.length === 0,
      summary: `${plural(running.length, "sub-agent")} running · ${plural(agents.length, "roster agent")}${
        running.length ? ` · ${running.slice(0, 3).map(runName).join(", ")}` : ""
      }`,
    };
  },
  toText(data) {
    const d = data as { running: Rec[]; agents: Rec[] };
    const lines = [
      `**Agent mesh** — ${d.running.length} running, ${d.agents.length} roster agents`,
    ];
    for (const r of d.running.slice(0, 10))
      lines.push(
        `• ${runName(r)} — ${s(r.status)} ${r.progress != null ? `${s(r.progress)}%` : ""}`.trim(),
      );
    return lines.join("\n");
  },
  link: () => ({ tab: "mesh", path: "/mesh", label: "Open full map" }),
};

const project: PanelKindDef = {
  id: "project",
  title: "Project",
  description: "one kanban project: status, progress, tasks and recent activity",
  queryHelp: "project: { id | name } (name is fuzzy-matched)",
  refreshMs: 15000,
  methods: ["kanban.projects.list", "kanban.tasks.list"],
  async resolve(q, call) {
    const needle = str(q, "id", "projectId", "name", "project");
    if (!needle) throw new Error("project panel needs an id or name");
    const projects = arr(await call("kanban.projects.list", { includeArchived: true }));
    const p = findByIdOrName(projects, needle);
    if (!p) throw new Error(`No project matches "${needle}".${suggestions(projects)}`);
    const tasks = arr(await call("kanban.tasks.list", { projectId: p.id })).filter(
      (t) => !t.projectId || t.projectId === p.id,
    );
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[s(t.status) || "todo"] = (counts[s(t.status) || "todo"] ?? 0) + 1;
    const done = tasks.filter(isDone).length;
    const progressPct = tasks.length
      ? Math.round((done / tasks.length) * 100)
      : typeof p.progress === "number"
        ? Math.round(p.progress <= 1 ? p.progress * 100 : p.progress)
        : 0;
    const sorted = [...tasks].sort(
      (a, b) =>
        (STATUS_ORDER[s(a.status)] ?? 5) - (STATUS_ORDER[s(b.status)] ?? 5) ||
        ts(b.updatedAt) - ts(a.updatedAt),
    );
    const recent = [...tasks].sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt)).slice(0, 8);
    const blocked = tasks.filter(isBlocked).length;
    const overdue = tasks.filter(isOverdue).length;
    const data = {
      project: {
        id: p.id,
        name: p.name,
        description: s(p.description).slice(0, 600),
        status: p.status,
        priority: p.priority,
        dueDate: p.dueDate,
        color: p.color,
        updatedAt: p.updatedAt,
        archived: p.archived,
      },
      counts,
      total: tasks.length,
      done,
      blocked,
      overdue,
      progressPct,
      tasks: sorted.slice(0, 60).map(pickTask),
      recent: recent.map(pickTask),
    };
    return {
      data,
      title: s(p.name) || "Project",
      count: tasks.length,
      empty: false,
      summary: `${s(p.name)} · ${s(p.status) || "no status"} · ${progressPct}% (${done}/${tasks.length} tasks done)${
        blocked ? ` · ${blocked} blocked` : ""
      }${overdue ? ` · ${overdue} overdue` : ""}`,
      link: {
        tab: "projects",
        path: `/projects/${encodeURIComponent(s(p.id))}`,
        label: "Open project",
      },
    };
  },
  toText(data) {
    const d = data as {
      project: Rec;
      tasks: Rec[];
      progressPct: number;
      done: number;
      total: number;
    };
    return [
      `**${s(d.project.name)}** — ${s(d.project.status) || "no status"} · ${d.progressPct}% (${d.done}/${d.total} done)`,
      mdTable(
        ["Task", "Status", "Assignee"],
        d.tasks.filter((t) => !isDone(t)).map((t) => [t.title, t.status, t.assignee]),
        12,
      ),
    ].join("\n\n");
  },
  link: (q) => ({
    tab: "projects",
    path: str(q, "id", "projectId")
      ? `/projects/${encodeURIComponent(str(q, "id", "projectId")!)}`
      : undefined,
    label: "Open project",
  }),
};

const task: PanelKindDef = {
  id: "task",
  title: "Task",
  description:
    "one kanban task card: status, assignee, content preview, checklist (status is changeable)",
  queryHelp: "task: { id | title } (title is fuzzy-matched)",
  refreshMs: 15000,
  methods: ["kanban.tasks.list", "kanban.projects.list"],
  async resolve(q, call) {
    const needle = str(q, "id", "taskId", "title", "name", "task");
    if (!needle) throw new Error("task panel needs an id or title");
    const tasks = arr(await call("kanban.tasks.list", {}));
    const t = findByIdOrName(tasks, needle, ["title", "name"]);
    if (!t) throw new Error(`No task matches "${needle}".${suggestions(tasks, "title")}`);
    let projectName = "";
    try {
      const projects = arr(await call("kanban.projects.list", { includeArchived: true }));
      projectName = s(projects.find((p) => p.id === t.projectId)?.name);
    } catch {
      /* project name is decorative — the task itself is what was asked for */
    }
    const { checklist, prose } = parseChecklist(s(t.description));
    const data = {
      task: { ...pickTask(t), tags: t.tags, department: t.department },
      projectName,
      preview: prose.slice(0, 1200),
      checklist,
      statuses: TASK_STATUSES,
    };
    const doneItems = checklist.filter((c) => c.done).length;
    return {
      data,
      title: s(t.title) || "Task",
      count: 1,
      empty: false,
      summary: `${s(t.title)} · ${s(t.status)}${t.assignee || t.assignedAgent ? ` · ${s(t.assignee ?? t.assignedAgent)}` : ""}${
        projectName ? ` · ${projectName}` : ""
      }${checklist.length ? ` · checklist ${doneItems}/${checklist.length}` : ""}`,
      link: { tab: "projects", path: `/tasks/${encodeURIComponent(s(t.id))}`, label: "Open task" },
    };
  },
  toText(data) {
    const d = data as {
      task: Rec;
      projectName: string;
      preview: string;
      checklist: ChecklistItem[];
    };
    const lines = [
      `**${s(d.task.title)}** — ${s(d.task.status)}${d.projectName ? ` (${d.projectName})` : ""}`,
    ];
    if (d.task.assignee) lines.push(`Assignee: ${s(d.task.assignee)}`);
    if (d.preview) lines.push(d.preview.slice(0, 500));
    for (const c of d.checklist.slice(0, 12)) lines.push(`${c.done ? "☑" : "☐"} ${c.text}`);
    return lines.join("\n");
  },
  link: (q) => ({
    tab: "projects",
    path: str(q, "id", "taskId")
      ? `/tasks/${encodeURIComponent(str(q, "id", "taskId")!)}`
      : undefined,
    label: "Open task",
  }),
};

const agent: PanelKindDef = {
  id: "agent",
  title: "Agent run",
  description:
    "one agent / sub-agent run: status, progress, current task, recent activity, files touched",
  queryHelp: "agent: { runId | sessionKey | label } (omit all = most recent running agent)",
  refreshMs: 4000,
  methods: ["subagents.list", "subagents.detail"],
  async resolve(q, call) {
    const runId = str(q, "runId", "id");
    const sessionKey = str(q, "sessionKey");
    const label = str(q, "label", "name");
    const runs = await listSubagents(call, { includeCompleted: true, limit: 100, updatesTail: 10 });
    let r: Rec | undefined;
    if (runId) r = runs.find((x) => x.runId === runId || s(x.runId).startsWith(runId));
    if (!r && sessionKey) r = runs.find((x) => x.sessionKey === sessionKey);
    if (!r && label) {
      const l = label.toLowerCase();
      r =
        runs.find((x) => s(x.label).toLowerCase() === l) ??
        runs.find(
          (x) => s(x.label).toLowerCase().includes(l) || s(x.task).toLowerCase().includes(l),
        );
    }
    if (!r && !runId && !sessionKey && !label) r = runs.find(isRunning) ?? runs[0];

    let detail: Rec = {};
    const key = r ? { runId: r.runId } : runId ? { runId } : sessionKey ? { sessionKey } : null;
    if (key) {
      try {
        const res = (await call("subagents.detail", key)) as Rec;
        if (res && res.ok !== false && res.run) detail = res.run as Rec;
      } catch {
        /* detail is enrichment; the list row is the source of truth */
      }
    }
    if (!r && !detail.runId) {
      const wanted = runId ?? sessionKey ?? label ?? "";
      throw new Error(
        wanted
          ? `No agent run matches "${wanted}".${suggestions(runs, "label")}`
          : "No agent runs found.",
      );
    }
    const base = r ?? {
      runId: detail.runId,
      label: detail.label,
      task: detail.task,
      status:
        s((detail.outcome as Rec | undefined)?.status) ||
        (detail.endedAt ? "completed" : "unknown"),
      progress: detail.endedAt ? 100 : 0,
      startedAt: detail.startedAt,
      endedAt: detail.endedAt,
      sessionKey: detail.childSessionKey,
    };
    const filesRaw = Array.isArray(detail.filesTouched)
      ? (detail.filesTouched as Rec[])
      : Array.isArray(detail.filesTouchedSample)
        ? (detail.filesTouchedSample as unknown[]).map((f) =>
            typeof f === "string" ? { path: f } : (f as Rec),
          )
        : [];
    const files = [...filesRaw]
      .sort((a, b) => ts(b.at) - ts(a.at))
      .slice(0, 25)
      .map((f) => ({ path: s(f.path), action: s(f.action), at: f.at }));
    const run: Rec = {
      ...pickRun(base),
      task: s(detail.task) || s(base.task),
      workdir: detail.workdir,
    };
    const updates = arr(base.recentUpdates).slice(-10).reverse();
    const data = {
      run,
      updates,
      files,
      filesCount: Number(detail.filesTouchedCount ?? filesRaw.length) || files.length,
    };
    const act = run.lastActivity as Rec | undefined;
    return {
      data,
      title: runName(base),
      count: 1,
      empty: false,
      summary: `${runName(base)} · ${s(base.status)}${base.progress != null ? ` · ${s(base.progress)}%` : ""}${
        act?.label
          ? ` · now: ${s(act.label)}`
          : run.currentCheckpoint
            ? ` · ${s(run.currentCheckpoint)}`
            : ""
      }${files.length ? ` · ${plural(data.filesCount, "file")}` : ""}`,
      link: {
        tab: "activity",
        label: "Open agent focus",
        action: "agent-focus",
        actionParams: {
          runId: base.runId,
          sessionKey: base.sessionKey,
          label: base.label,
          status: base.status,
        },
      },
    };
  },
  toText(data) {
    const d = data as { run: Rec; updates: Rec[]; files: Rec[] };
    const lines = [
      `**${runName(d.run)}** — ${s(d.run.status)}${d.run.progress != null ? ` ${s(d.run.progress)}%` : ""}`,
    ];
    if (d.run.task) lines.push(s(d.run.task).slice(0, 300));
    for (const u of d.updates.slice(0, 5)) lines.push(`• ${s(u.message).slice(0, 140)}`);
    if (d.files.length)
      lines.push(
        `Files: ${d.files
          .slice(0, 8)
          .map((f) => s(f.path).split("/").pop())
          .join(", ")}`,
      );
    return lines.join("\n");
  },
  link: (q) => ({
    tab: "activity",
    label: "Open agent focus",
    action: "agent-focus",
    actionParams: { runId: str(q, "runId", "id"), sessionKey: str(q, "sessionKey") },
  }),
};

const agents: PanelKindDef = {
  id: "agents",
  title: "Agents",
  description: "table of running / recent agent runs",
  queryHelp: "agents: { status: 'running'|'completed'|'all' (default all), limit }",
  refreshMs: 5000,
  methods: ["subagents.list"],
  async resolve(q, call) {
    const status = str(q, "status") ?? "all";
    const limit = clampLimit(q, 30, 100);
    const runs = await listSubagents(call, {
      includeCompleted: status !== "running",
      limit: 100,
      compact: true,
    });
    const filtered = runs.filter((r) =>
      status === "running" ? isRunning(r) : status === "completed" ? !isRunning(r) : true,
    );
    const rows = filtered.slice(0, limit).map(pickRun);
    const running = runs.filter(isRunning).length;
    return {
      data: { rows, running, total: filtered.length },
      count: filtered.length,
      empty: filtered.length === 0,
      summary: `${plural(filtered.length, "agent run")}${status !== "all" ? ` (${status})` : ""} · ${running} running now`,
    };
  },
  toText(data) {
    const d = data as { rows: Rec[] };
    return mdTable(
      ["Agent", "Status", "Progress"],
      d.rows.map((r) => [runName(r), r.status, r.progress != null ? `${s(r.progress)}%` : ""]),
    );
  },
  link: () => ({ tab: "activity", path: "/activity", label: "Open Activity" }),
};

const business: PanelKindDef = {
  id: "business",
  title: "Business snapshot",
  description:
    "business health from the Command/Business HQ data: needs-attention items, clients, opportunities, outstanding invoices",
  queryHelp: "business: {} (no params)",
  refreshMs: 30000,
  methods: [
    "kanban.projects.list",
    "kanban.tasks.list",
    "opportunity.list",
    "decision.list",
    "risk.list",
    "commitment.list",
    "clients.list",
  ],
  async resolve(_q, call) {
    const sources = {
      projects: () => call("kanban.projects.list", {}).then((r) => arr(r)),
      tasks: () => call("kanban.tasks.list", {}).then((r) => arr(r)),
      opportunities: () => call("opportunity.list", {}).then((r) => arr(r, "opportunities")),
      decisions: () => call("decision.list", {}).then((r) => arr(r, "decisions")),
      risks: () => call("risk.list", {}).then((r) => arr(r, "risks")),
      commitments: () => call("commitment.list", {}).then((r) => arr(r, "commitments")),
      clients: () => call("clients.list", { all: true }).then((r) => arr(r, "clients")),
    } as const;
    const keys = Object.keys(sources) as Array<keyof typeof sources>;
    const settled = await Promise.allSettled(keys.map((k) => sources[k]()));
    const got: Record<string, Rec[]> = {};
    const warnings: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") got[keys[i]] = r.value;
      else {
        got[keys[i]] = [];
        warnings.push(
          `${keys[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    });
    if (warnings.length === keys.length)
      throw new Error(`all business sources failed — ${warnings[0]}`);

    const { projects, tasks, opportunities, decisions, risks, commitments, clients } = got;
    const openTasks = tasks.filter((t) => !isDone(t));
    const activeProjects = projects.filter(projectIsActive);
    const activeOpps = opportunities.filter(
      (o) => !/won|lost|hold/i.test(s(o.stage) || s(o.status)),
    );
    const pipelineValue = activeOpps.reduce((a, o) => a + (Number(o.estimatedValue) || 0), 0);
    const outstanding = commitments.filter(
      (c) =>
        /money in/i.test(s(c.direction)) &&
        /invoiced|expected|overdue|partially/i.test(s(c.status)),
    );
    const outstandingValue = outstanding.reduce(
      (a, c) => a + (Number(c.remainingBalance ?? c.amount) || 0),
      0,
    );
    const overdueCommitments = commitments.filter((c) => {
      if (c.overdue === true) return true;
      if (/paid|settled|closed|cancelled/i.test(s(c.status)) || !c.dueDate) return false;
      const due = ts(c.dueDate);
      return due > 0 && due < Date.now() && (Number(c.remainingBalance) || 0) > 0;
    });
    const CRIT = new Set(["P0", "P1"]);
    const criticalRisks = risks.filter(
      (r) =>
        !/closed|mitigated|accepted|resolved/i.test(s(r.status)) &&
        (CRIT.has(s(r.priority).toUpperCase()) || /critical|high/i.test(s(r.riskLevel))),
    );
    const ceoDecisions = decisions.filter(
      (d) =>
        d.ceoRequired === true ||
        (CRIT.has(s(d.priority).toUpperCase()) && !/decided|closed|final/i.test(s(d.status))),
    );
    const blockedTasks = openTasks.filter(isBlocked);
    const overdueTasks = openTasks.filter(isOverdue);
    const activeClients = clients.filter((c) => /^active/i.test(s(c.status)));

    const attention: Rec[] = [
      ...criticalRisks.map((r) => ({
        type: "risk",
        title: s(r.title),
        detail: s(r.category) || s(r.owner),
        tone: "danger",
      })),
      ...ceoDecisions.map((d) => ({
        type: "decision",
        title: s(d.title),
        detail: s(d.decisionDeadline) ? `by ${s(d.decisionDeadline)}` : s(d.owner),
        tone: "warn",
      })),
      ...overdueCommitments.map((c) => ({
        type: "commitment",
        title: s(c.name),
        detail: `${money(Number(c.remainingBalance ?? c.amount))} overdue`,
        tone: "danger",
      })),
      ...blockedTasks.map((t) => ({
        type: "blocked task",
        title: s(t.title),
        detail: s(projects.find((p) => p.id === t.projectId)?.name),
        tone: "danger",
      })),
      ...overdueTasks.map((t) => ({
        type: "overdue task",
        title: s(t.title),
        detail: s(t.dueDate),
        tone: "warn",
      })),
    ];
    const metrics = {
      activeClients: activeClients.length,
      totalClients: clients.length,
      activeProjects: activeProjects.length,
      activeOpportunities: activeOpps.length,
      pipelineValue,
      outstandingInvoices: outstanding.length,
      outstandingValue,
      overdueCommitments: overdueCommitments.length,
      criticalRisks: criticalRisks.length,
      ceoDecisions: ceoDecisions.length,
      blockedTasks: blockedTasks.length,
      overdueTasks: overdueTasks.length,
      openTasks: openTasks.length,
    };
    const data = {
      metrics,
      attention: attention.slice(0, 30),
      attentionTotal: attention.length,
      topOpportunities: [...activeOpps]
        .sort((a, b) => (Number(b.estimatedValue) || 0) - (Number(a.estimatedValue) || 0))
        .slice(0, 6)
        .map((o) => ({
          id: o.id,
          name: o.name,
          stage: o.stage,
          value: Number(o.estimatedValue) || 0,
          owner: o.owner,
        })),
      clients: [...activeClients, ...clients.filter((c) => !/^active/i.test(s(c.status)))]
        .slice(0, 8)
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          pipeline: c.pipelineStatusLabel ?? c.pipelineStatus,
        })),
      outstanding: outstanding.slice(0, 8).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        amount: Number(c.remainingBalance ?? c.amount) || 0,
        dueDate: c.dueDate,
      })),
      warnings,
    };
    const total = keys.reduce((a, k) => a + got[k].length, 0);
    return {
      data,
      count: attention.length,
      empty: total === 0,
      summary: `${plural(attention.length, "item")} need attention · ${activeClients.length} active clients · ${
        activeOpps.length
      } open opportunities (${money(pipelineValue)}) · ${money(outstandingValue)} outstanding invoices${
        warnings.length ? ` · ${warnings.length} source(s) unavailable` : ""
      }`,
    };
  },
  toText(data) {
    const d = data as { metrics: Record<string, number>; attention: Rec[] };
    const m = d.metrics;
    const lines = [
      `**Business snapshot**`,
      `Clients: ${m.activeClients} active / ${m.totalClients} · Projects active: ${m.activeProjects}`,
      `Opportunities: ${m.activeOpportunities} open (${money(m.pipelineValue)}) · Outstanding invoices: ${money(m.outstandingValue)}`,
      `Critical risks: ${m.criticalRisks} · CEO decisions: ${m.ceoDecisions} · Blocked tasks: ${m.blockedTasks} · Overdue tasks: ${m.overdueTasks}`,
    ];
    if (d.attention.length) {
      lines.push("", "**Needs attention**");
      for (const a of d.attention.slice(0, 8))
        lines.push(`• [${s(a.type)}] ${s(a.title)}${a.detail ? ` — ${s(a.detail)}` : ""}`);
    }
    return lines.join("\n");
  },
  link: () => ({ tab: "command-ceo", label: "Open Command" }),
};

const clientsKind: PanelKindDef = {
  id: "clients",
  title: "Clients",
  description: "CRM clients table",
  queryHelp: "clients: { status: 'prospect'|'active'|'inactive', pipelineStatus, search, limit }",
  refreshMs: 30000,
  methods: ["clients.list"],
  async resolve(q, call) {
    const status = str(q, "status");
    const pipelineStatus = str(q, "pipelineStatus");
    const search = str(q, "search", "query", "name")?.toLowerCase();
    const res = (await call("clients.list", {
      all: true,
      ...(status ? { status } : {}),
      ...(pipelineStatus ? { pipelineStatus } : {}),
    })) as Rec;
    let rows = arr(res, "clients");
    if (search)
      rows = rows.filter((c) =>
        [c.name, c.email, c.billingEmail, c.legalName].some((v) =>
          s(v).toLowerCase().includes(search),
        ),
      );
    const limit = clampLimit(q, 50, 500);
    const stats = (res.stats ?? {}) as Rec;
    return {
      data: {
        rows: rows.slice(0, limit).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          pipeline: c.pipelineStatusLabel ?? c.pipelineStatus,
          email: c.email ?? c.billingEmail,
          phone: c.phone,
          updatedAt: c.updatedAt,
        })),
        total: rows.length,
        stats,
      },
      count: rows.length,
      empty: rows.length === 0,
      summary: `${plural(rows.length, "client")}${status ? ` (${status})` : ""}${search ? ` matching "${search}"` : ""}${
        typeof stats.active === "number" ? ` · ${stats.active} active overall` : ""
      }`,
    };
  },
  toText(data) {
    const d = data as { rows: Rec[] };
    return mdTable(
      ["Client", "Status", "Pipeline"],
      d.rows.map((c) => [c.name, c.status, c.pipeline]),
    );
  },
  link: () => ({ tab: "clients", path: "/clients", label: "Open Clients" }),
};

const opportunities: PanelKindDef = {
  id: "opportunities",
  title: "Opportunities",
  description: "sales opportunities / pipeline table from the register",
  queryHelp:
    "opportunities: { stage, owner, priority, search, open: true (hide won/lost/hold), limit }",
  refreshMs: 30000,
  methods: ["opportunity.list"],
  async resolve(q, call) {
    const params: Rec = {};
    const stage = str(q, "stage");
    const owner = str(q, "owner");
    const priority = str(q, "priority");
    const search = str(q, "search", "query");
    if (stage) params.stage = stage;
    if (owner) params.owner = owner;
    if (priority) params.priority = priority;
    if (search) params.query = search;
    let rows = arr(await call("opportunity.list", params), "opportunities");
    if (q.open === true || q.open === "true")
      rows = rows.filter((o) => !/won|lost|hold/i.test(s(o.stage) || s(o.status)));
    rows.sort((a, b) => (Number(b.estimatedValue) || 0) - (Number(a.estimatedValue) || 0));
    const value = rows.reduce((a, o) => a + (Number(o.estimatedValue) || 0), 0);
    const limit = clampLimit(q, 50, 500);
    return {
      data: {
        rows: rows.slice(0, limit).map((o) => ({
          id: o.id,
          name: o.name,
          stage: o.stage,
          status: o.status,
          priority: o.priority,
          value: Number(o.estimatedValue) || 0,
          owner: o.owner,
          nextAction: o.nextAction,
          expectedCloseDate: o.expectedCloseDate,
        })),
        total: rows.length,
        value,
      },
      count: rows.length,
      empty: rows.length === 0,
      summary: `${plural(rows.length, "opportunity", "opportunities")}${stage ? ` in ${stage}` : ""} · ${money(value)} total value`,
    };
  },
  toText(data) {
    const d = data as { rows: Rec[] };
    return mdTable(
      ["Opportunity", "Stage", "Value", "Owner"],
      d.rows.map((o) => [o.name, o.stage, money(Number(o.value)), o.owner]),
    );
  },
  link: () => ({ tab: "opportunities", path: "/opportunities", label: "Open Register" }),
};

const table: PanelKindDef = {
  id: "table",
  title: "Table",
  description: "generic table from rows YOU supply (fallback for anything else)",
  queryHelp: "table: { columns: string[], rows: any[][] | object[] }",
  refreshMs: 0,
  methods: [],
  async resolve(q) {
    const rawRows = Array.isArray(q.rows) ? (q.rows as unknown[]) : [];
    let columns = Array.isArray(q.columns)
      ? (q.columns as unknown[]).map((c) => s(c) || String(c))
      : [];
    const firstObj = rawRows.find((r) => r && typeof r === "object" && !Array.isArray(r)) as
      | Rec
      | undefined;
    if (!columns.length && firstObj) columns = Object.keys(firstObj).slice(0, 12);
    const rows = rawRows.slice(0, 500).map((r) => {
      if (Array.isArray(r))
        return r
          .slice(0, Math.max(columns.length, 1))
          .map((c) => (c == null ? "" : typeof c === "object" ? JSON.stringify(c) : c));
      if (r && typeof r === "object")
        return columns.map((c) => {
          const v = (r as Rec)[c];
          return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v;
        });
      return [r];
    });
    if (!columns.length && rows.length) columns = rows[0].map((_, i) => `Col ${i + 1}`);
    return {
      data: { columns, rows, total: rawRows.length },
      count: rawRows.length,
      empty: rows.length === 0,
      summary: `${plural(rawRows.length, "row")} × ${plural(columns.length, "column")}`,
    };
  },
  toText(data) {
    const d = data as { columns: string[]; rows: unknown[][] };
    return mdTable(d.columns, d.rows);
  },
  link: () => ({ tab: "", label: "" }),
};

export const PANEL_KIND_DEFS: readonly PanelKindDef[] = [
  mesh,
  project,
  task,
  agent,
  agents,
  business,
  clientsKind,
  opportunities,
  table,
];
