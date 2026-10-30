/**
 * <autonomy-scheduled-view> — Autonomy → Scheduled.
 *
 * Scheduled Agent Tasks (src/autonomy/scheduled-tasks): on a cron schedule an
 * agent or CLI reviews repos READ-ONLY and returns a standard work-suggestion
 * report; the owner approves items here or in Telegram; approved items run as
 * verified goal runs in isolated worktrees, with a second approval before
 * deploy. Thin client over the scheduledTasks.* RPCs + `scheduledTask.changed`.
 *
 *   list    → scheduledTasks.list        (+ create / edit form)
 *   detail  → scheduledTasks.get + scheduledTasks.items.list
 *   actions → scheduledTasks.approvals.decide / runNow / update / delete
 *
 * InfiniBot tokens only (light + dark); one column ≤ 900px, verified at 390px.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { formatAgo } from "../format";

// ── Wire types (mirror src/autonomy/scheduled-tasks/types.ts) ───────────────

type Target =
  | { kind: "cli"; backend: "claude-code" | "codex" | "opencode" | "gemini" | "grok"; model?: string }
  | { kind: "agent"; agentId: string; model?: string };
interface RepoSpec {
  label: string;
  path: string;
  branch?: string;
  focus?: string[];
  notes?: string;
}
interface Task {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  scheduleText: string;
  assignee: Target;
  repos: RepoSpec[];
  instructions: string;
  delivery: Array<"telegram" | "ui">;
  approval: { autoContinueOnApprove: boolean; requireDeployApproval: boolean };
  limits: Record<string, number>;
  deployCommand: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRun: { id: string; status: string; createdAt: number; items: number | null; error: string | null } | null;
  counts: { awaitingDecision: number; inFlight: number; deployed: number; closed: number };
  seedKey: string | null;
}
interface RunRow {
  id: string;
  status: "running" | "validating" | "delivered" | "failed";
  trigger: string;
  goalId: string | null;
  error: string | null;
  items: number | null;
  summary: string | null;
  readOnlyViolations: string[];
  reportId: string | null;
  deliveredAt: number | null;
  deliveryError: string | null;
  createdAt: number;
  finishedAt: number | null;
}
interface Check {
  type: "shell" | "file" | "grep" | "llm";
  label?: string;
  command?: string;
  path?: string;
  pattern?: string;
  negate?: boolean;
  criterion?: string;
}
interface WorkItem {
  id: string;
  title: string;
  why: string;
  priority: string;
  effort: string;
  risk: "low" | "medium" | "high";
  repo: string;
  files: string[];
  dev: { steps: string[] };
  checks: Check[];
  deploy: { steps: string[]; rollback: string; command?: string; checks?: Check[] };
  approvals: string[];
}
type Stage =
  | "suggested"
  | "snoozed"
  | "rejected"
  | "approved"
  | "building"
  | "build_failed"
  | "awaiting_deploy"
  | "deploy_rejected"
  | "deploying"
  | "deploy_failed"
  | "deployed";
type Action =
  | "approve"
  | "reject"
  | "modify"
  | "snooze"
  | "start"
  | "approve_deploy"
  | "reject_deploy"
  | "retry"
  | "continue";
interface Item {
  id: string;
  runId: string;
  taskId: string;
  item: WorkItem;
  stage: Stage;
  stageLabel: string;
  actions: Action[];
  instructions: string[];
  snoozeUntil: number | null;
  devGoalId: string | null;
  deployGoalId: string | null;
  worktreePath: string | null;
  branch: string | null;
  diffSummary: string | null;
  testEvidence: string | null;
  deployOutput: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
interface PipelineEvent {
  seq: number;
  from: string | null;
  to: string;
  actor: string;
  note: string | null;
  at: number;
}

interface RepoDraft {
  label: string;
  path: string;
  branch: string;
}
interface Draft {
  id: string | null;
  name: string;
  cron: string;
  timezone: string;
  target: string; // "cli:claude-code" | "agent:<id>"
  model: string;
  repos: RepoDraft[];
  instructions: string;
  telegram: boolean;
  ui: boolean;
  requireDeployApproval: boolean;
  autoContinueOnApprove: boolean;
  deployCommand: string;
  enabled: boolean;
}

const CLI_TARGETS: Array<{ id: string; label: string }> = [
  { id: "cli:claude-code", label: "Claude Code" },
  { id: "cli:codex", label: "Codex" },
  { id: "cli:opencode", label: "OpenCode" },
  { id: "cli:gemini", label: "Gemini CLI" },
];

const PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Daily 17:00", cron: "0 17 * * *" },
  { label: "Daily 09:00", cron: "0 9 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Mondays 10:00", cron: "0 10 * * 1" },
];

const ACTION_LABEL: Record<Action, string> = {
  approve: "Approve",
  reject: "Reject",
  modify: "Modify",
  snooze: "Snooze 24h",
  start: "Start build",
  approve_deploy: "Approve deploy",
  reject_deploy: "Reject deploy",
  retry: "Retry",
  continue: "Continue…",
};

const STEPS = ["Suggested", "Approved", "Building", "Verified", "Deploy approval", "Deployed"];

/** [index of the current step, state of that step]. */
function stepOf(stage: Stage): [number, "now" | "done" | "fail" | "off"] {
  switch (stage) {
    case "suggested":
      return [0, "now"];
    case "snoozed":
      return [0, "off"];
    case "rejected":
      return [0, "fail"];
    case "approved":
      return [1, "now"];
    case "building":
      return [2, "now"];
    case "build_failed":
      return [2, "fail"];
    case "awaiting_deploy":
      return [4, "now"];
    case "deploy_rejected":
      return [4, "fail"];
    case "deploying":
      return [5, "now"];
    case "deploy_failed":
      return [5, "fail"];
    case "deployed":
      return [5, "done"];
  }
}

const NEEDS_YOU: ReadonlySet<Stage> = new Set([
  "suggested",
  "awaiting_deploy",
  "build_failed",
  "deploy_failed",
]);
const IN_FLIGHT: ReadonlySet<Stage> = new Set(["approved", "building", "deploying"]);

function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    cron: "0 17 * * *",
    timezone: localTz(),
    target: "cli:claude-code",
    model: "",
    repos: [{ label: "", path: "", branch: "" }],
    instructions: "",
    telegram: true,
    ui: true,
    requireDeployApproval: true,
    autoContinueOnApprove: true,
    deployCommand: "",
    enabled: true,
  };
}

function targetLabel(t: Target): string {
  if (t.kind === "agent") return `Agent · ${t.agentId}`;
  const name = CLI_TARGETS.find((c) => c.id === `cli:${t.backend}`)?.label ?? t.backend;
  return t.model ? `${name} · ${t.model}` : name;
}

function whenText(ms: number | null, tz: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function checkText(c: Check): string {
  if (c.label) return c.label;
  if (c.type === "shell") return `$ ${c.command ?? ""}`;
  if (c.type === "file") return `${c.negate ? "absent" : "exists"}: ${c.path ?? ""}`;
  if (c.type === "grep") return `/${c.pattern ?? ""}/ in ${c.path ?? ""}`;
  return `AI judge: ${c.criterion ?? ""}`;
}

@customElement("autonomy-scheduled-view")
export class AutonomyScheduledView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;

  @state() private tasks: Task[] = [];
  @state() private selectedId: string | null = null;
  @state() private runs: RunRow[] = [];
  @state() private items: Item[] = [];
  @state() private agents: Array<{ id: string; name: string }> = [];
  @state() private draft: Draft | null = null;
  @state() private busy: string | null = null;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private openItem: string | null = null;
  @state() private itemEvents: Record<string, PipelineEvent[]> = {};
  @state() private instructionFor: { id: string; action: "modify" | "continue" } | null = null;
  @state() private instruction = "";
  @state() private mobileDetail = false;
  @state() private loaded = false;

  private unsubscribe: (() => void) | null = null;
  private pollTimer: number | null = null;
  private refreshQueued = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.pollTimer = window.setInterval(() => {
      if (this.items.some((i) => IN_FLIGHT.has(i.stage)) || this.runs.some((r) => r.status === "running"))
        void this.refresh();
    }, 8_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("client") && this.client) {
      this.unsubscribe?.();
      this.unsubscribe = this.client.subscribe((evt) => {
        if (evt.event === "scheduledTask.changed" || evt.event === "goal.changed") this.queueRefresh();
      });
      void this.refresh();
      void this.loadAgents();
    }
  }

  private queueRefresh(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    window.setTimeout(() => {
      this.refreshQueued = false;
      void this.refresh();
    }, 300);
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    if (!this.client) throw new Error("Not connected to the gateway");
    return this.client.request<T>(method, params);
  }

  private async refresh(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.rpc<{ tasks: Task[] }>("scheduledTasks.list", {});
      this.tasks = res.tasks ?? [];
      if (this.selectedId && !this.tasks.some((t) => t.id === this.selectedId)) this.selectedId = null;
      if (!this.selectedId && this.tasks.length) this.selectedId = this.tasks[0].id;
      if (this.selectedId) await this.loadDetail(this.selectedId);
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loaded = true;
    }
  }

  private async loadDetail(id: string): Promise<void> {
    const [d, it] = await Promise.all([
      this.rpc<{ runs: RunRow[] }>("scheduledTasks.get", { id }),
      this.rpc<{ items: Item[] }>("scheduledTasks.items.list", { taskId: id, limit: 200 }),
    ]);
    if (this.selectedId !== id) return;
    this.runs = d.runs ?? [];
    this.items = it.items ?? [];
    if (this.openItem) void this.loadEvents(this.openItem);
  }

  private async loadEvents(itemId: string): Promise<void> {
    try {
      const r = await this.rpc<{ events: PipelineEvent[] }>("scheduledTasks.items.get", { itemId });
      this.itemEvents = { ...this.itemEvents, [itemId]: r.events ?? [] };
    } catch {
      /* item gone */
    }
  }

  private async loadAgents(): Promise<void> {
    try {
      const res = await this.rpc<{ agents?: Array<Record<string, unknown>> }>("agents.list", {});
      this.agents = (res.agents ?? [])
        .map((a) => ({
          id: String(a.id ?? ""),
          name: String((a.name as string) || (a.identity as { name?: string })?.name || a.id || ""),
        }))
        .filter((a) => a.id);
    } catch {
      this.agents = [];
    }
  }

  private async act(key: string, fn: () => Promise<unknown>, ok?: string): Promise<void> {
    this.busy = key;
    this.error = null;
    try {
      await fn();
      if (ok) this.notice = ok;
      await this.refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = null;
    }
  }

  private selectTask(id: string): void {
    this.selectedId = id;
    this.openItem = null;
    this.mobileDetail = true;
    this.draft = null;
    void this.loadDetail(id);
  }

  // ── Decisions ────────────────────────────────────────────────────────

  private decide(item: Item, action: Action): void {
    if (action === "modify" || action === "continue") {
      this.instructionFor = { id: item.id, action };
      this.instruction = "";
      this.openItem = item.id;
      return;
    }
    void this.act(
      `${item.id}:${action}`,
      () => this.rpc("scheduledTasks.approvals.decide", { itemId: item.id, action }),
      `${item.item.title}: ${ACTION_LABEL[action].toLowerCase()} ✓`,
    );
  }

  private submitInstruction(item: Item): void {
    const text = this.instruction.trim();
    const pending = this.instructionFor;
    if (!text || !pending) return;
    void this.act(
      `${item.id}:${pending.action}`,
      async () => {
        await this.rpc("scheduledTasks.approvals.decide", {
          itemId: item.id,
          action: pending.action,
          instruction: text,
        });
        this.instructionFor = null;
        this.instruction = "";
      },
      pending.action === "modify" ? "Approved with your changes" : "Sent to the agent",
    );
  }

  private approveLowRisk(runId: string, n: number): void {
    void this.act(
      `lowrisk:${runId}`,
      () => this.rpc("scheduledTasks.approvals.decide", { runId, action: "approve_low_risk" }),
      `Approved ${n} low-risk item(s)`,
    );
  }

  // ── Task form ────────────────────────────────────────────────────────

  private newTask(): void {
    this.draft = emptyDraft();
    this.mobileDetail = true;
  }

  private editTask(t: Task): void {
    this.draft = {
      id: t.id,
      name: t.name,
      cron: t.cron,
      timezone: t.timezone,
      target: t.assignee.kind === "cli" ? `cli:${t.assignee.backend}` : `agent:${t.assignee.agentId}`,
      model: t.assignee.model ?? "",
      repos: t.repos.length
        ? t.repos.map((r) => ({ label: r.label, path: r.path, branch: r.branch ?? "" }))
        : [{ label: "", path: "", branch: "" }],
      instructions: t.instructions,
      telegram: t.delivery.includes("telegram"),
      ui: t.delivery.includes("ui"),
      requireDeployApproval: t.approval.requireDeployApproval,
      autoContinueOnApprove: t.approval.autoContinueOnApprove,
      deployCommand: t.deployCommand ?? "",
      enabled: t.enabled,
    };
  }

  private setDraft(patch: Partial<Draft>): void {
    if (this.draft) this.draft = { ...this.draft, ...patch };
  }

  private setRepo(i: number, patch: Partial<RepoDraft>): void {
    if (!this.draft) return;
    this.setDraft({ repos: this.draft.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  }

  private async saveDraft(e: Event, runNow = false): Promise<void> {
    e.preventDefault();
    const d = this.draft;
    if (!d) return;
    if (!d.name.trim()) {
      this.error = "Give the task a name.";
      return;
    }
    const repos = d.repos
      .filter((r) => r.path.trim())
      .map((r) => ({
        path: r.path.trim(),
        ...(r.label.trim() ? { label: r.label.trim() } : {}),
        ...(r.branch.trim() ? { branch: r.branch.trim() } : {}),
      }));
    if (!repos.length) {
      this.error = "Add at least one repository path to review.";
      return;
    }
    const delivery = [...(d.telegram ? ["telegram"] : []), ...(d.ui ? ["ui"] : [])];
    const [kind, ...rest] = d.target.split(":");
    const id = rest.join(":");
    const assignee =
      kind === "agent"
        ? { kind: "agent", agentId: id, ...(d.model.trim() ? { model: d.model.trim() } : {}) }
        : { kind: "cli", backend: id, ...(d.model.trim() ? { model: d.model.trim() } : {}) };
    const body = {
      name: d.name.trim(),
      cron: d.cron.trim(),
      timezone: d.timezone.trim() || "UTC",
      assignee,
      repos,
      instructions: d.instructions,
      delivery: delivery.length ? delivery : ["ui"],
      approval: {
        requireDeployApproval: d.requireDeployApproval,
        autoContinueOnApprove: d.autoContinueOnApprove,
      },
      deployCommand: d.deployCommand.trim() || null,
      enabled: d.enabled,
    };
    await this.act(
      "save",
      async () => {
        if (d.id) {
          await this.rpc("scheduledTasks.update", { id: d.id, patch: body });
          if (runNow) await this.rpc("scheduledTasks.runNow", { id: d.id });
          this.selectedId = d.id;
        } else {
          const res = await this.rpc<{ id: string }>("scheduledTasks.create", { ...body, runNow });
          this.selectedId = res.id;
        }
        this.draft = null;
      },
      d.id ? "Task saved" : runNow ? "Task created — first review started" : "Task created",
    );
  }

  // ── Render ───────────────────────────────────────────────────────────

  render() {
    if (!this.connected && !this.client) {
      return html`<div class="card empty">Connect to the gateway to manage scheduled tasks.</div>`;
    }
    const task = this.tasks.find((t) => t.id === this.selectedId) ?? null;
    return html`
      ${this.error ? html`<div class="msg err" role="alert">${this.error}</div>` : nothing}
      ${this.notice
        ? html`<div class="msg ok" role="status" @click=${() => (this.notice = null)}>${this.notice}</div>`
        : nothing}
      <div class="sched ${this.mobileDetail ? "show-detail" : ""}">
        <div class="col col-list">${this.renderList()}</div>
        <div class="col col-detail">
          ${this.mobileDetail
            ? html`<button class="btn ghost sm back" @click=${() => {
                this.mobileDetail = false;
                this.draft = null;
              }}>← All scheduled tasks</button>`
            : nothing}
          ${this.draft ? this.renderForm(this.draft) : task ? this.renderDetail(task) : this.renderIntro()}
        </div>
      </div>
    `;
  }

  private renderIntro(): TemplateResult {
    return html`
      <div class="card intro" data-learn-id="scheduled-intro">
        <div class="eyebrow">Scheduled agent tasks</div>
        <h2>Let an agent review your repos on a schedule</h2>
        <p class="muted">
          Each run is read-only: the agent checks repo health and suggests work items with a dev plan,
          verification checks and a deploy plan. You approve items here or in Telegram. Approved items are
          built by a verified goal run in their own git worktree, then wait for your deploy approval.
        </p>
        <button class="btn primary" data-learn-id="scheduled-new-intro" @click=${() => this.newTask()}>New scheduled task</button>
      </div>
    `;
  }

  private renderList(): TemplateResult {
    const waiting = this.tasks.reduce((n, t) => n + t.counts.awaitingDecision, 0);
    return html`
      <div class="card" data-learn-id="scheduled-list">
        <div class="list-head">
          <div>
            <div class="eyebrow">Scheduled</div>
            <div class="muted">${this.tasks.length} task${this.tasks.length === 1 ? "" : "s"}${waiting
              ? html` · <span class="need">${waiting} waiting for you</span>`
              : nothing}</div>
          </div>
          <button class="btn primary sm" data-learn-id="scheduled-new" @click=${() => this.newTask()}>New task</button>
        </div>
        ${!this.loaded
          ? html`<div class="empty muted">Loading…</div>`
          : this.tasks.length === 0
            ? html`<div class="empty muted">No scheduled tasks yet.</div>`
            : html`<div class="rows" role="list">
                ${this.tasks.map((t) => this.renderTaskRow(t))}
              </div>`}
      </div>
    `;
  }

  private renderTaskRow(t: Task): TemplateResult {
    const sel = t.id === this.selectedId && !this.draft;
    const last = t.lastRun;
    return html`
      <button
        class="task-row ${sel ? "sel" : ""}"
        role="listitem"
        aria-current=${sel ? "true" : "false"}
        @click=${() => this.selectTask(t.id)}
      >
        <div class="row-top">
          <span class="row-title">${t.name}</span>
          <span class="chip ${t.enabled ? "on" : "off"}">${t.enabled ? "On" : "Paused"}</span>
        </div>
        <div class="row-meta">
          <span>${t.scheduleText}</span>
          <span>${targetLabel(t.assignee)}</span>
        </div>
        <div class="row-meta">
          <span>Next: ${t.enabled ? whenText(t.nextRunAt, t.timezone) : "—"}</span>
          ${last
            ? html`<span class=${last.status === "failed" ? "bad" : ""}
                >Last: ${last.status}${last.items !== null ? ` · ${last.items} items` : ""} ·
                ${formatAgo(last.createdAt)}</span
              >`
            : html`<span>Never run</span>`}
        </div>
        ${t.counts.awaitingDecision || t.counts.inFlight
          ? html`<div class="row-badges">
              ${t.counts.awaitingDecision
                ? html`<span class="badge need">${t.counts.awaitingDecision} need you</span>`
                : nothing}
              ${t.counts.inFlight ? html`<span class="badge">${t.counts.inFlight} in flight</span>` : nothing}
              ${t.counts.deployed ? html`<span class="badge ok">${t.counts.deployed} deployed</span>` : nothing}
            </div>`
          : nothing}
      </button>
    `;
  }

  private renderDetail(t: Task): TemplateResult {
    const needs = this.items.filter((i) => NEEDS_YOU.has(i.stage));
    const flight = this.items.filter((i) => IN_FLIGHT.has(i.stage));
    const done = this.items.filter((i) => !NEEDS_YOU.has(i.stage) && !IN_FLIGHT.has(i.stage));
    const running = this.runs.find((r) => r.status === "running" || r.status === "validating");
    return html`
      <div class="card">
        <div class="detail-head">
          <div class="detail-title">
            <div class="eyebrow">${t.scheduleText}</div>
            <h2>${t.name}</h2>
            <div class="row-meta">
              <span>${targetLabel(t.assignee)}</span>
              <span>Next: ${t.enabled ? whenText(t.nextRunAt, t.timezone) : "paused"}</span>
              <span>Delivery: ${t.delivery.join(" + ")}</span>
              <span>${t.approval.requireDeployApproval ? "Deploy needs approval" : "Auto-deploy after checks"}</span>
            </div>
          </div>
          <div class="detail-actions" data-learn-id="scheduled-actions">
            <button
              class="btn primary sm"
              ?disabled=${Boolean(running) || this.busy === "run"}
              @click=${() => this.act("run", () => this.rpc("scheduledTasks.runNow", { id: t.id }), "Review started")}
            >
              ${running ? "Reviewing…" : "Run now"}
            </button>
            <button
              class="btn sm"
              @click=${() =>
                this.act(
                  "toggle",
                  () => this.rpc("scheduledTasks.update", { id: t.id, patch: { enabled: !t.enabled } }),
                  t.enabled ? "Paused" : "Enabled",
                )}
            >
              ${t.enabled ? "Pause" : "Enable"}
            </button>
            <button class="btn sm" @click=${() => this.editTask(t)}>Edit</button>
            <button
              class="btn danger sm"
              @click=${() => {
                if (confirm(`Delete "${t.name}" and its history?`))
                  void this.act("delete", () => this.rpc("scheduledTasks.delete", { id: t.id }), "Deleted");
              }}
            >
              Delete
            </button>
          </div>
        </div>
        <div class="repos">
          ${t.repos.map(
            (r) => html`<span class="repo" title=${r.path}
              ><b>${r.label}</b>${r.branch ? html` <span class="mono">${r.branch}</span>` : nothing}</span
            >`,
          )}
        </div>
      </div>

      ${running
        ? html`<div class="card running">
            <span class="pulse"></span>
            <div>
              <div class="strong">Review in progress</div>
              <div class="muted">
                Read-only run ${running.id}${running.goalId ? html` · goal <span class="mono">${running.goalId}</span>` : nothing}
                · started ${formatAgo(running.createdAt)}. The report arrives here${t.delivery.includes("telegram")
                  ? " and in Telegram"
                  : ""}.
              </div>
            </div>
          </div>`
        : nothing}

      <section class="card" data-learn-id="scheduled-needs">
        <div class="sec-head">
          <div class="eyebrow">Needs you</div>
          <span class="count">${needs.length}</span>
          ${this.lowRiskButton(needs)}
        </div>
        ${needs.length
          ? html`<div class="items">${needs.map((i) => this.renderItem(i, t))}</div>`
          : html`<div class="empty muted">Nothing waiting for a decision.</div>`}
      </section>

      ${flight.length
        ? html`<section class="card">
            <div class="sec-head"><div class="eyebrow">In flight</div><span class="count">${flight.length}</span></div>
            <div class="items">${flight.map((i) => this.renderItem(i, t))}</div>
          </section>`
        : nothing}

      <section class="card" data-learn-id="scheduled-history">
        <div class="sec-head"><div class="eyebrow">Run history</div><span class="count">${this.runs.length}</span></div>
        ${this.runs.length
          ? html`<div class="runs">${this.runs.map((r) => this.renderRun(r))}</div>`
          : html`<div class="empty muted">No runs yet — use Run now to try it.</div>`}
      </section>

      ${done.length
        ? html`<section class="card">
            <div class="sec-head"><div class="eyebrow">Closed & snoozed</div><span class="count">${done.length}</span></div>
            <div class="items">${done.map((i) => this.renderItem(i, t))}</div>
          </section>`
        : nothing}
    `;
  }

  private lowRiskButton(needs: Item[]): TemplateResult | typeof nothing {
    const low = needs.filter((i) => i.stage === "suggested" && i.item.risk === "low");
    if (low.length < 2) return nothing;
    const runId = low[0].runId;
    const n = low.filter((i) => i.runId === runId).length;
    if (n < 2) return nothing;
    return html`<button
      class="btn sm"
      ?disabled=${this.busy === `lowrisk:${runId}`}
      @click=${() => this.approveLowRisk(runId, n)}
    >
      Approve all low-risk (${n})
    </button>`;
  }

  private renderStepper(i: Item): TemplateResult {
    const [cur, st] = stepOf(i.stage);
    return html`<ol class="stepper" aria-label="Pipeline stage: ${i.stageLabel}">
      ${STEPS.map((label, idx) => {
        const cls =
          idx < cur || (idx === cur && st === "done") ? "done" : idx === cur ? st : "todo";
        return html`<li class=${cls}><span class="dot"></span><span class="step-l">${label}</span></li>`;
      })}
    </ol>`;
  }

  private renderItem(i: Item, t: Task): TemplateResult {
    const w = i.item;
    const open = this.openItem === i.id;
    const events = this.itemEvents[i.id];
    const asking = this.instructionFor?.id === i.id ? this.instructionFor : null;
    return html`
      <article class="item stage-${i.stage}">
        <div class="item-top">
          <button
            class="item-title"
            aria-expanded=${open ? "true" : "false"}
            @click=${() => {
              this.openItem = open ? null : i.id;
              if (!open) void this.loadEvents(i.id);
            }}
          >
            <span class="chev ${open ? "open" : ""}"></span>${w.title}
          </button>
          <span class="stage-chip ${i.stage}">${i.stageLabel}</span>
        </div>
        <div class="tags">
          <span class="tag prio">${w.priority}</span>
          <span class="tag">Effort ${w.effort}</span>
          <span class="tag risk-${w.risk}">${w.risk} risk</span>
          <span class="tag mono">${w.repo}</span>
          ${i.snoozeUntil ? html`<span class="tag">until ${whenText(i.snoozeUntil, t.timezone)}</span>` : nothing}
        </div>
        <p class="why">${w.why}</p>
        ${this.renderStepper(i)}
        ${i.lastError && (i.stage === "build_failed" || i.stage === "deploy_failed")
          ? html`<div class="msg err">${i.lastError}</div>`
          : nothing}
        ${i.stage === "awaiting_deploy"
          ? html`<div class="evidence">
              <div class="lbl">Checks passed</div>
              <pre>${i.testEvidence ?? ""}</pre>
              <div class="lbl">What changed · <span class="mono">${i.branch ?? ""}</span></div>
              <pre>${i.diffSummary ?? ""}</pre>
            </div>`
          : nothing}
        ${open ? this.renderItemDetail(i, events) : nothing}
        ${asking
          ? html`<div class="ask">
              <label class="lbl" for="ins-${i.id}"
                >${asking.action === "modify"
                  ? "How should this item change? It will be approved with your changes."
                  : "Instruction for the agent"}</label
              >
              <textarea
                id="ins-${i.id}"
                rows="3"
                .value=${this.instruction}
                @input=${(e: Event) => (this.instruction = (e.target as HTMLTextAreaElement).value)}
              ></textarea>
              <div class="actions">
                <button class="btn ghost sm" @click=${() => (this.instructionFor = null)}>Cancel</button>
                <button
                  class="btn primary sm"
                  ?disabled=${!this.instruction.trim() || this.busy === `${i.id}:${asking.action}`}
                  @click=${() => this.submitInstruction(i)}
                >
                  ${asking.action === "modify" ? "Approve with changes" : "Send"}
                </button>
              </div>
            </div>`
          : i.actions.length
            ? html`<div class="item-actions">
                ${i.actions.map(
                  (a) => html`<button
                    class="btn sm ${a === "approve" || a === "approve_deploy" || a === "start"
                      ? "primary"
                      : a === "reject" || a === "reject_deploy"
                        ? "danger"
                        : ""}"
                    ?disabled=${this.busy === `${i.id}:${a}`}
                    @click=${() => this.decide(i, a)}
                  >
                    ${ACTION_LABEL[a]}
                  </button>`,
                )}
              </div>`
            : nothing}
      </article>
    `;
  }

  private renderItemDetail(i: Item, events: PipelineEvent[] | undefined): TemplateResult {
    const w = i.item;
    return html`
      <div class="plan">
        <div>
          <div class="lbl">Dev plan</div>
          <ol>${w.dev.steps.map((s) => html`<li>${s}</li>`)}</ol>
          ${w.files.length ? html`<div class="files mono">${w.files.join(" · ")}</div>` : nothing}
        </div>
        <div>
          <div class="lbl">Verification (gates the build)</div>
          <ul class="checks">${w.checks.map((c) => html`<li><span class="ctype">${c.type}</span> ${checkText(c)}</li>`)}</ul>
        </div>
        <div>
          <div class="lbl">Deploy plan</div>
          <ol>${w.deploy.steps.map((s) => html`<li>${s}</li>`)}</ol>
          <div class="muted">Rollback: ${w.deploy.rollback}</div>
          ${w.deploy.command ? html`<div class="mono small">$ ${w.deploy.command}</div>` : nothing}
        </div>
        ${i.instructions.length
          ? html`<div><div class="lbl">Your instructions</div><ul>${i.instructions.map((s) => html`<li>${s}</li>`)}</ul></div>`
          : nothing}
        ${i.worktreePath
          ? html`<div class="muted small">
              Worktree <span class="mono">${i.worktreePath}</span>${i.devGoalId
                ? html` · dev goal <span class="mono">${i.devGoalId}</span>`
                : nothing}${i.deployGoalId ? html` · deploy goal <span class="mono">${i.deployGoalId}</span>` : nothing}
            </div>`
          : nothing}
        ${i.deployOutput ? html`<div><div class="lbl">Deploy output</div><pre>${i.deployOutput}</pre></div>` : nothing}
        <div>
          <div class="lbl">Stage log</div>
          ${events
            ? html`<ul class="log">
                ${events.map(
                  (e) => html`<li>
                    <span class="mono">${new Date(e.at).toLocaleString()}</span>
                    <b>${e.from ? `${e.from} → ` : ""}${e.to}</b>
                    <span class="muted">${e.actor}${e.note ? ` · ${e.note}` : ""}</span>
                  </li>`,
                )}
              </ul>`
            : html`<div class="muted">Loading…</div>`}
        </div>
      </div>
    `;
  }

  private renderRun(r: RunRow): TemplateResult {
    return html`
      <div class="run">
        <div class="row-top">
          <span class="run-status ${r.status}">${r.status}</span>
          <span class="muted">${r.trigger} · ${formatAgo(r.createdAt)}</span>
          ${r.items !== null ? html`<span class="muted">${r.items} items</span>` : nothing}
          ${r.reportId
            ? html`<a class="link" href="/reports" title="Report ${r.reportId}">PDF in Reports</a>`
            : nothing}
        </div>
        ${r.summary ? html`<p class="why">${r.summary}</p>` : nothing}
        ${r.error ? html`<div class="msg err">${r.error}</div>` : nothing}
        ${r.readOnlyViolations.length
          ? html`<div class="msg warn">Read-only violation: ${r.readOnlyViolations.join("; ")}</div>`
          : nothing}
        ${r.deliveryError ? html`<div class="msg warn">Telegram delivery: ${r.deliveryError}</div>` : nothing}
      </div>
    `;
  }

  private renderForm(d: Draft): TemplateResult {
    return html`
      <form class="card form" data-learn-id="scheduled-form" @submit=${(e: Event) => this.saveDraft(e)}>
        <div class="eyebrow">${d.id ? "Edit scheduled task" : "New scheduled task"}</div>
        <div class="field">
          <label class="lbl" for="st-name">Name</label>
          <input id="st-name" data-learn-id="scheduled-name" .value=${d.name} placeholder="Nightly repo review"
            @input=${(e: Event) => this.setDraft({ name: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="field" data-learn-id="scheduled-schedule">
          <span class="lbl">Schedule</span>
          <div class="presets">
            ${PRESETS.map(
              (p) => html`<button type="button" class="filter ${d.cron === p.cron ? "on" : ""}" data-learn-id="scheduled-preset-${PRESETS.indexOf(p)}"
                @click=${() => this.setDraft({ cron: p.cron })}>${p.label}</button>`,
            )}
          </div>
          <div class="row2">
            <input class="mono" aria-label="Cron expression" .value=${d.cron}
              @input=${(e: Event) => this.setDraft({ cron: (e.target as HTMLInputElement).value })} />
            <input aria-label="Timezone" .value=${d.timezone} placeholder="Asia/Bangkok"
              @input=${(e: Event) => this.setDraft({ timezone: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <div class="row2">
          <div class="field">
            <label class="lbl" for="st-agent">Assignee</label>
            <select id="st-agent" .value=${d.target}
              @change=${(e: Event) => this.setDraft({ target: (e.target as HTMLSelectElement).value })}>
              <optgroup label="Coding CLIs">
                ${CLI_TARGETS.map((c) => html`<option value=${c.id} ?selected=${d.target === c.id}>${c.label}</option>`)}
              </optgroup>
              ${this.agents.length
                ? html`<optgroup label="Gateway agents">
                    ${this.agents.map(
                      (a) => html`<option value="agent:${a.id}" ?selected=${d.target === `agent:${a.id}`}>${a.name}</option>`,
                    )}
                  </optgroup>`
                : nothing}
            </select>
          </div>
          <div class="field">
            <label class="lbl" for="st-model">Model (optional)</label>
            <input id="st-model" .value=${d.model} placeholder="default"
              @input=${(e: Event) => this.setDraft({ model: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <div class="field" data-learn-id="scheduled-repos">
          <span class="lbl">Repositories (reviewed read-only; approved work happens in a new worktree)</span>
          ${d.repos.map(
            (r, i) => html`<div class="repo-row">
              <input aria-label="Label" .value=${r.label} placeholder="label"
                @input=${(e: Event) => this.setRepo(i, { label: (e.target as HTMLInputElement).value })} />
              <input class="mono" aria-label="Path" .value=${r.path} placeholder="/abs/path/to/repo"
                @input=${(e: Event) => this.setRepo(i, { path: (e.target as HTMLInputElement).value })} />
              <input class="mono" aria-label="Branch" .value=${r.branch} placeholder="branch (optional)"
                @input=${(e: Event) => this.setRepo(i, { branch: (e.target as HTMLInputElement).value })} />
              <button type="button" class="icon-btn" aria-label="Remove repository" ?disabled=${d.repos.length === 1}
                @click=${() => this.setDraft({ repos: d.repos.filter((_, j) => j !== i) })}>×</button>
            </div>`,
          )}
          <button type="button" class="btn ghost sm"
            @click=${() => this.setDraft({ repos: [...d.repos, { label: "", path: "", branch: "" }] })}>+ Add repository</button>
        </div>
        <div class="field">
          <label class="lbl" for="st-ins">What should the review focus on?</label>
          <textarea id="st-ins" rows="4" .value=${d.instructions}
            placeholder="e.g. failing CI, security of auth routes, deploy drift vs production"
            @input=${(e: Event) => this.setDraft({ instructions: (e.target as HTMLTextAreaElement).value })}></textarea>
        </div>
        <div class="toggles" data-learn-id="scheduled-toggles">
          <label class="toggle"><input type="checkbox" .checked=${d.telegram}
            @change=${(e: Event) => this.setDraft({ telegram: (e.target as HTMLInputElement).checked })} /> Send to Telegram</label>
          <label class="toggle"><input type="checkbox" .checked=${d.ui}
            @change=${(e: Event) => this.setDraft({ ui: (e.target as HTMLInputElement).checked })} /> Show here</label>
          <label class="toggle"><input type="checkbox" .checked=${d.autoContinueOnApprove}
            @change=${(e: Event) => this.setDraft({ autoContinueOnApprove: (e.target as HTMLInputElement).checked })} /> Start building on approve</label>
          <label class="toggle"><input type="checkbox" .checked=${d.requireDeployApproval}
            @change=${(e: Event) => this.setDraft({ requireDeployApproval: (e.target as HTMLInputElement).checked })} /> Ask before every deploy</label>
          <label class="toggle"><input type="checkbox" .checked=${d.enabled}
            @change=${(e: Event) => this.setDraft({ enabled: (e.target as HTMLInputElement).checked })} /> Enabled</label>
        </div>
        <div class="field">
          <label class="lbl" for="st-deploy">Deploy command (optional — overrides the agent's proposed deploy commands)</label>
          <input id="st-deploy" class="mono" .value=${d.deployCommand} placeholder="e.g. pnpm deploy:staging"
            @input=${(e: Event) => this.setDraft({ deployCommand: (e.target as HTMLInputElement).value })} />
        </div>
        <div class="actions">
          <button type="button" class="btn ghost" data-learn-id="scheduled-cancel" @click=${() => {
            this.draft = null;
            this.mobileDetail = false;
          }}>Cancel</button>
          <button type="button" class="btn" ?disabled=${this.busy === "save"}
            @click=${(e: Event) => this.saveDraft(e, true)}>${d.id ? "Save & run now" : "Create & run now"}</button>
          <button type="submit" class="btn primary" data-learn-id="scheduled-create" ?disabled=${this.busy === "save"}>${d.id ? "Save" : "Create"}</button>
        </div>
      </form>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--text);
      font-family: var(--font-body, inherit);
      min-height: 0;
    }
    * {
      box-sizing: border-box;
    }
    h2 {
      margin: 4px 0 6px;
      font-size: 18px;
      font-weight: 600;
      line-height: 1.25;
    }
    p {
      margin: 0;
    }
    .sched {
      display: grid;
      grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
    }
    .back {
      display: none;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 12px);
      padding: 16px;
      min-width: 0;
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted-strong, var(--muted));
    }
    .muted {
      color: var(--muted);
      font-size: 12px;
    }
    .small {
      font-size: 11px;
    }
    .strong {
      font-weight: 600;
    }
    .mono,
    code,
    pre {
      font-family: var(--mono, ui-monospace, monospace);
    }
    pre {
      margin: 4px 0 8px;
      padding: 8px 10px;
      background: var(--bg-muted, var(--bg-elevated));
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow: auto;
    }
    .msg {
      font-size: 12px;
      padding: 8px 10px;
      border-radius: var(--radius-md, 8px);
      margin-bottom: 10px;
      word-break: break-word;
    }
    .msg.err {
      color: var(--danger);
      background: var(--danger-subtle);
    }
    .msg.ok {
      color: var(--ok);
      background: var(--ok-subtle);
      cursor: pointer;
    }
    .msg.warn {
      color: var(--warn);
      background: var(--warn-subtle, var(--bg-muted));
    }
    .list-head,
    .sec-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .list-head > div {
      flex: 1;
      min-width: 0;
    }
    .sec-head .count {
      font-size: 11px;
      color: var(--muted);
      flex: 1;
    }
    .need {
      color: var(--warn);
      font-weight: 600;
    }
    .rows,
    .items,
    .runs {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .task-row {
      all: unset;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px;
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border);
      background: var(--panel, transparent);
      cursor: pointer;
      min-width: 0;
    }
    .task-row:hover {
      border-color: var(--border-strong, var(--accent));
    }
    .task-row.sel {
      border-color: var(--accent);
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .task-row:focus-visible,
    .item-title:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
      outline-offset: 2px;
    }
    .row-top {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .row-title {
      flex: 1;
      font-weight: 600;
      font-size: 14px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      font-size: 11px;
      color: var(--muted);
    }
    .row-meta .bad {
      color: var(--danger);
    }
    .row-badges,
    .tags,
    .repos {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .badge,
    .tag,
    .repo {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid var(--border);
      color: var(--muted-strong, var(--muted));
      background: var(--bg-muted, transparent);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge.need {
      color: var(--warn);
      border-color: currentColor;
    }
    .badge.ok {
      color: var(--ok);
      border-color: currentColor;
    }
    .tag.prio {
      color: var(--accent);
      border-color: currentColor;
      font-weight: 600;
    }
    .tag.risk-low {
      color: var(--ok);
    }
    .tag.risk-medium {
      color: var(--warn);
    }
    .tag.risk-high {
      color: var(--danger);
    }
    .repos {
      margin-top: 12px;
    }
    .repo b {
      color: var(--text);
      font-weight: 600;
    }
    .chip {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid currentColor;
    }
    .chip.on {
      color: var(--ok);
    }
    .chip.off {
      color: var(--muted);
    }
    .detail-head {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .detail-title {
      min-width: 0;
      flex: 1 1 260px;
    }
    .detail-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .running {
      display: flex;
      gap: 12px;
      align-items: center;
      border-color: var(--accent);
    }
    .pulse {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      flex-shrink: 0;
      animation: pulse 1.6s ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .pulse {
        animation: none;
      }
    }
    .item {
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--panel, transparent);
      min-width: 0;
    }
    .item.stage-awaiting_deploy {
      border-color: var(--accent);
    }
    .item.stage-build_failed,
    .item.stage-deploy_failed {
      border-color: var(--danger);
    }
    .item-top {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 4px 12px;
      justify-content: space-between;
    }
    .item-title {
      all: unset;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      display: flex;
      gap: 8px;
      align-items: baseline;
      flex: 1 1 240px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .chev {
      width: 7px;
      height: 7px;
      border-right: 1.5px solid var(--muted);
      border-bottom: 1.5px solid var(--muted);
      transform: rotate(-45deg);
      flex-shrink: 0;
      transition: transform var(--duration-fast, 0.15s);
    }
    .chev.open {
      transform: rotate(45deg);
    }
    .stage-chip {
      font-size: 11px;
      font-weight: 600;
      color: var(--muted-strong, var(--muted));
      margin-left: auto;
      text-align: right;
    }
    .stage-chip.building,
    .stage-chip.deploying,
    .stage-chip.approved {
      color: var(--info, var(--accent));
    }
    .stage-chip.awaiting_deploy,
    .stage-chip.suggested {
      color: var(--accent);
    }
    .stage-chip.deployed {
      color: var(--ok);
    }
    .stage-chip.build_failed,
    .stage-chip.deploy_failed,
    .stage-chip.rejected,
    .stage-chip.deploy_rejected {
      color: var(--danger);
    }
    .why {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text);
      word-break: break-word;
    }
    .stepper {
      list-style: none;
      margin: 2px 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 4px;
    }
    .stepper li {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 10px;
      color: var(--muted);
      min-width: 0;
    }
    .stepper .dot {
      height: 4px;
      border-radius: 2px;
      background: var(--border);
    }
    .stepper .done .dot {
      background: var(--ok);
    }
    .stepper .now .dot {
      background: var(--accent);
    }
    .stepper .fail .dot {
      background: var(--danger);
    }
    .stepper .off .dot {
      background: var(--muted);
    }
    .stepper .now,
    .stepper .fail {
      color: var(--text);
      font-weight: 600;
    }
    .step-l {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .evidence .lbl,
    .plan .lbl,
    .ask .lbl {
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
      font-weight: 500;
      display: block;
      margin-bottom: 2px;
    }
    .plan {
      display: grid;
      gap: 12px;
      border-top: 1px solid var(--border);
      padding-top: 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    .plan ol,
    .plan ul {
      margin: 2px 0;
      padding-left: 18px;
    }
    .checks {
      list-style: none;
      padding: 0 !important;
    }
    .checks li {
      word-break: break-word;
    }
    .ctype {
      font-size: 10px;
      text-transform: uppercase;
      font-weight: 600;
      color: var(--accent);
      margin-right: 4px;
    }
    .files {
      font-size: 11px;
      color: var(--muted);
      word-break: break-all;
    }
    .log {
      list-style: none;
      padding: 0 !important;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .log li {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
      font-size: 11px;
    }
    .item-actions,
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .actions {
      justify-content: flex-end;
    }
    .ask {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .run {
      padding: 10px 0;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .run:first-child {
      border-top: none;
      padding-top: 0;
    }
    .run-status {
      font-size: 11px;
      font-weight: 600;
      text-transform: capitalize;
    }
    .run-status.delivered {
      color: var(--ok);
    }
    .run-status.failed {
      color: var(--danger);
    }
    .run-status.running,
    .run-status.validating {
      color: var(--info, var(--accent));
    }
    .link {
      font-size: 12px;
      color: var(--accent);
    }
    .empty {
      padding: 8px 0;
    }
    .intro p {
      margin: 6px 0 14px;
      line-height: 1.55;
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .field > .lbl,
    .field > label.lbl {
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
      font-weight: 500;
    }
    input,
    select,
    textarea {
      font: inherit;
      font-size: 13px;
      color: var(--text);
      background: var(--input, var(--bg-elevated));
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      padding: 8px 10px;
      width: 100%;
      min-width: 0;
      min-height: 36px;
    }
    textarea {
      resize: vertical;
      line-height: 1.45;
    }
    input:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle, transparent);
    }
    input.mono {
      font-size: 12px;
    }
    .row2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .repo-row {
      display: grid;
      grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.6fr) minmax(0, 1fr) 36px;
      gap: 6px;
    }
    .presets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filter {
      font: inherit;
      font-size: 12px;
      padding: 4px 10px;
      min-height: 30px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted-strong, var(--muted));
      cursor: pointer;
    }
    .filter.on {
      color: var(--accent);
      border-color: var(--accent);
      background: var(--accent-subtle, transparent);
    }
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
    }
    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      cursor: pointer;
    }
    .toggle input {
      width: 16px;
      height: 16px;
      min-height: 0;
      accent-color: var(--accent);
    }
    .icon-btn {
      font: inherit;
      width: 36px;
      height: 36px;
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .icon-btn:hover:not([disabled]) {
      color: var(--danger);
      border-color: var(--danger);
    }
    .icon-btn[disabled] {
      opacity: 0.4;
      cursor: default;
    }
    .btn {
      font: inherit;
      font-size: 13px;
      font-weight: 500;
      padding: 8px 14px;
      min-height: 36px;
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border-strong, var(--border));
      background: var(--panel, transparent);
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
    }
    .btn:hover:not([disabled]) {
      border-color: var(--accent);
    }
    .btn[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-foreground);
    }
    .btn.primary:hover:not([disabled]) {
      background: var(--accent-hover, var(--accent));
    }
    .btn.danger {
      color: var(--danger);
    }
    .btn.danger:hover:not([disabled]) {
      border-color: var(--danger);
    }
    .btn.ghost {
      background: transparent;
      border-color: transparent;
    }
    .btn.ghost:hover:not([disabled]) {
      border-color: var(--border);
    }
    .btn.sm {
      padding: 4px 10px;
      min-height: 32px;
      font-size: 12px;
    }
    @media (max-width: 900px) {
      .sched {
        grid-template-columns: minmax(0, 1fr);
      }
      .sched.show-detail .col-list {
        display: none;
      }
      .sched:not(.show-detail) .col-detail {
        display: none;
      }
      .back {
        display: inline-flex;
        align-self: flex-start;
      }
    }
    @media (max-width: 520px) {
      .card {
        padding: 12px;
      }
      .row2 {
        grid-template-columns: minmax(0, 1fr);
      }
      .repo-row {
        grid-template-columns: minmax(0, 1fr) 36px;
      }
      .repo-row input:nth-child(2),
      .repo-row input:nth-child(3) {
        grid-column: 1 / 2;
      }
      .repo-row .icon-btn {
        grid-column: 2;
        grid-row: 1;
      }
      .stepper .step-l {
        display: none;
      }
      .item-actions .btn {
        flex: 1 1 auto;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "autonomy-scheduled-view": AutonomyScheduledView;
  }
}
