/**
 * <autonomy-goals-view> — the primary surface of the Autonomy page.
 *
 * `/goal`-style runs: a goal + verifiable completion checks + any agent
 * (CLI backend or gateway agent). The gateway keeps the agent working until
 * every check passes (src/autonomy/goals). This view is a thin client over
 * the goals.* RPCs + goal.* events:
 *
 *   composer  → goals.create
 *   list      → goals.list   (refreshed on goal.changed / goal.checked)
 *   detail    → goals.get / goals.log + pause/resume/cancel/recheck/continue/retry/delete
 *
 * Styling uses the InfiniBot tokens (ui/src/styles/base.css) only, so light
 * and dark themes both work; the layout collapses to one column ≤ 900px.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/people-chips";
import type { GatewayBrowserClient } from "../gateway";
import { formatAgo } from "../format";
import "../components/webchat-model-picker";

// ── Wire types (mirror src/autonomy/goals/types.ts) ─────────────────────────

type CheckType = "shell" | "file" | "grep" | "llm" | "visual";
interface GoalCheck {
  id?: string;
  type: CheckType;
  label?: string;
  command?: string;
  path?: string;
  pattern?: string;
  negate?: boolean;
  criterion?: string;
  routes?: string[];
  expectation?: string;
  timeoutSec?: number;
}
interface CheckResult {
  checkId: string;
  pass: boolean;
  output: string;
  durationMs: number;
  at: number;
  trigger: "timer" | "iteration" | "manual" | "recovery";
  iteration: number;
}
type Target =
  | { kind: "cli"; backend: "claude-code" | "codex" | "opencode" | "gemini" | "grok"; model?: string }
  | { kind: "agent"; agentId: string; model?: string };
type Status =
  | "queued"
  | "running"
  | "checking"
  | "paused"
  | "completed"
  | "failed"
  | "exhausted"
  | "canceled";
interface Iteration {
  index: number;
  runId: string | null;
  sessionId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: string;
  exitCode: number | null;
  prompt: string;
  outputTail: string;
  resumed: boolean;
  note?: string;
}
interface GoalSummary {
  id: string;
  title: string;
  status: Status;
  reason: string | null;
  target: Target;
  workdir: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
  iterations: number;
  maxIterations: number;
  checksTotal: number;
  checksPassing: number;
  lastOutcome: string | null;
  currentRunId: string | null;
}
interface GoalRun {
  id: string;
  title: string;
  goal: string;
  checks: GoalCheck[];
  target: Target;
  workdir: string | null;
  limits: {
    maxIterations: number;
    maxWallClockSec: number;
    iterationTimeoutSec: number;
    checkIntervalSec: number;
    hangSec: number;
  };
  status: Status;
  reason: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  elapsedMs: number;
  activeSince: number | null;
  iterations: Iteration[];
  lastResults: Record<string, CheckResult>;
  pendingInstruction: string | null;
  lastCheckAt: number | null;
}
interface GoalDetail {
  run: GoalRun;
  summary: GoalSummary;
  history: CheckResult[];
}

interface DraftCheck {
  type: CheckType;
  command: string;
  path: string;
  pattern: string;
  criterion: string;
  negate: boolean;
  /** visual: comma-separated routes */
  routes?: string;
}
interface Draft {
  goal: string;
  title: string;
  checks: DraftCheck[];
  target: string; // "cli:claude-code" | "agent:<id>"
  model: string;
  workdir: string;
  maxIterations: number;
  maxMinutes: number;
  iterationMinutes: number;
  checkEverySec: number;
  hangMinutes: number;
  notify: boolean;
}

const CLI_OPTIONS: Array<{ id: string; label: string; models: string[] }> = [
  { id: "claude-code", label: "Claude Code", models: ["opus", "sonnet", "haiku"] },
  { id: "codex", label: "Codex", models: ["gpt-5.5", "gpt-5.4", "gpt-5-codex"] },
  { id: "opencode", label: "OpenCode", models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5"] },
  { id: "gemini", label: "Gemini CLI", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "grok", label: "Grok Build", models: ["grok-build", "grok-4.6", "grok-code-fast-1"] },
];

const CHECK_TYPES: Array<{ id: CheckType; label: string; hint: string }> = [
  { id: "shell", label: "Command", hint: "passes when it exits 0" },
  { id: "file", label: "File exists", hint: "path must exist" },
  { id: "grep", label: "File contains", hint: "regex must match" },
  { id: "llm", label: "AI judge", hint: "reviewer reads output + diff" },
  { id: "visual", label: "Screenshots look right", hint: "visual_verify screenshots + vision review" },
];

const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued",
  running: "Running",
  checking: "Checking",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  exhausted: "Exhausted",
  canceled: "Canceled",
};

const OUTCOME_LABEL: Record<string, string> = {
  running: "Working",
  exited: "Exited",
  nonzero_exit: "Non-zero exit",
  crashed: "Crashed",
  timeout: "Timed out",
  hung: "Hung (no output)",
  claimed_done_checks_failed: "Claimed done · checks failed",
  checks_passed: "Checks passed",
  spawn_failed: "Failed to start",
  canceled: "Canceled",
  interrupted: "Interrupted",
};

const TRIGGER_LABEL: Record<CheckResult["trigger"], string> = {
  timer: "while running",
  iteration: "after iteration",
  manual: "manual re-check",
  recovery: "after restart",
};

const ACTIVE: ReadonlySet<Status> = new Set(["queued", "running", "checking", "paused"]);
const TERMINAL: ReadonlySet<Status> = new Set(["completed", "failed", "exhausted", "canceled"]);
type Filter = "all" | "active" | "completed" | "failed";

const DRAFT_KEY = "infinibot.goals.draft.v1";

function emptyCheck(type: CheckType = "shell"): DraftCheck {
  return { type, command: "", path: "", pattern: "", criterion: "", negate: false };
}

function defaultDraft(): Draft {
  return {
    goal: "",
    title: "",
    checks: [emptyCheck("shell")],
    target: "cli:claude-code",
    model: "",
    workdir: "",
    maxIterations: 5,
    maxMinutes: 120,
    iterationMinutes: 30,
    checkEverySec: 120,
    hangMinutes: 10,
    notify: true,
  };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...defaultDraft(), ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    /* ignore */
  }
  return defaultDraft();
}

function describeCheck(c: GoalCheck): string {
  if (c.label) return c.label;
  switch (c.type) {
    case "shell":
      return `$ ${c.command ?? ""}`;
    case "file":
      return `${c.negate ? "absent" : "exists"}: ${c.path ?? ""}`;
    case "grep":
      return `${c.negate ? "not " : ""}/${c.pattern ?? ""}/ in ${c.path ?? ""}`;
    case "llm":
      return c.criterion ?? "";
    case "visual":
      return `${(c.routes ?? []).join(", ")}${c.expectation ? ` — ${c.expectation}` : ""}`;
  }
}

function targetLabel(t: Target): string {
  const base =
    t.kind === "cli" ? (CLI_OPTIONS.find((o) => o.id === t.backend)?.label ?? t.backend) : `@${t.agentId}`;
  return t.model ? `${base} · ${t.model}` : base;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

@customElement("autonomy-goals-view")
export class AutonomyGoalsView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;

  @state() private goals: GoalSummary[] = [];
  @state() private selectedId: string | null = null;
  @state() private detail: GoalDetail | null = null;
  @state() private liveLog: { iteration: number; output: string; running: boolean } | null = null;
  @state() private draft: Draft = loadDraft();
  @state() private agents: Array<{ id: string; name: string }> = [];
  @state() private filter: Filter = "all";
  @state() private creating = false;
  @state() private busy: string | null = null;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private instruction = "";
  @state() private composerOpen = true;
  @state() private openIteration: number | null = null;
  @state() private now = Date.now();

  private unsubscribe: (() => void) | null = null;
  private pollTimer: number | null = null;
  private refreshQueued = false;

  connectedCallback(): void {
    super.connectedCallback();
    this.pollTimer = window.setInterval(() => {
      this.now = Date.now();
      if (this.hasActive()) void this.refresh();
    }, 5_000);
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
        if (typeof evt.event === "string" && evt.event.startsWith("goal.")) this.queueRefresh();
      });
      void this.refresh();
      void this.loadAgents();
    }
  }

  private hasActive(): boolean {
    return this.goals.some((g) => ACTIVE.has(g.status) && g.status !== "paused");
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
      const res = await this.rpc<{ goals: GoalSummary[] }>("goals.list", { limit: 200 });
      this.goals = res.goals ?? [];
      if (!this.selectedId && this.goals.length && window.innerWidth > 900) {
        this.selectedId = this.goals[0].id;
      }
      if (this.selectedId) await this.loadDetail(this.selectedId);
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async loadDetail(id: string): Promise<void> {
    try {
      const d = await this.rpc<GoalDetail>("goals.get", { id });
      if (this.selectedId !== id) return;
      this.detail = d;
      const last = d.run.iterations.at(-1);
      if (last && (last.endedAt === null || this.openIteration === null)) {
        const log = await this.rpc<{ iteration: number; output: string; running: boolean }>(
          "goals.log",
          { id },
        );
        if (this.selectedId === id) this.liveLog = log;
      }
    } catch (err) {
      if (String(err).includes("not found")) {
        this.selectedId = null;
        this.detail = null;
      }
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

  // ── Composer ──────────────────────────────────────────────────────────

  private setDraft(patch: Partial<Draft>): void {
    this.draft = { ...this.draft, ...patch };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.draft));
    } catch {
      /* ignore */
    }
  }

  private setCheck(i: number, patch: Partial<DraftCheck>): void {
    const checks = this.draft.checks.map((c, j) => (j === i ? { ...c, ...patch } : c));
    this.setDraft({ checks });
  }

  private draftChecks(): GoalCheck[] {
    const out: GoalCheck[] = [];
    for (const c of this.draft.checks) {
      if (c.type === "shell" && c.command.trim()) out.push({ type: "shell", command: c.command.trim() });
      if (c.type === "file" && c.path.trim())
        out.push({ type: "file", path: c.path.trim(), ...(c.negate ? { negate: true } : {}) });
      if (c.type === "grep" && c.path.trim() && c.pattern.trim())
        out.push({ type: "grep", path: c.path.trim(), pattern: c.pattern.trim() });
      if (c.type === "llm" && c.criterion.trim()) out.push({ type: "llm", criterion: c.criterion.trim() });
      if (c.type === "visual" && (c.routes ?? "").trim()) {
        out.push({
          type: "visual",
          routes: (c.routes ?? "").split(",").map((r) => r.trim()).filter(Boolean),
          ...(c.criterion.trim() ? { expectation: c.criterion.trim() } : {}),
        });
      }
    }
    return out;
  }

  private async create(e: Event): Promise<void> {
    e.preventDefault();
    const d = this.draft;
    const checks = this.draftChecks();
    if (!d.goal.trim()) {
      this.error = "Describe the goal first.";
      return;
    }
    if (checks.length === 0) {
      this.error = "Add at least one completion check — that's how the run knows it's done.";
      return;
    }
    const [kind, id] = [d.target.split(":")[0], d.target.slice(d.target.indexOf(":") + 1)];
    const target =
      kind === "agent"
        ? { kind: "agent", agentId: id, ...(d.model.trim() ? { model: d.model.trim() } : {}) }
        : { kind: "cli", backend: id, ...(d.model.trim() ? { model: d.model.trim() } : {}) };
    this.creating = true;
    this.error = null;
    try {
      const res = await this.rpc<{ id: string }>("goals.create", {
        goal: d.goal.trim(),
        ...(d.title.trim() ? { title: d.title.trim() } : {}),
        checks,
        target,
        ...(d.workdir.trim() ? { workdir: d.workdir.trim() } : {}),
        notify: d.notify,
        limits: {
          maxIterations: d.maxIterations,
          maxWallClockSec: Math.round(d.maxMinutes * 60),
          iterationTimeoutSec: Math.round(d.iterationMinutes * 60),
          checkIntervalSec: d.checkEverySec,
          hangSec: Math.round(d.hangMinutes * 60),
        },
      });
      this.setDraft({ goal: "", title: "", checks: [emptyCheck("shell")] });
      this.selectedId = res.id;
      this.filter = "all";
      this.notice = "Goal started.";
      window.setTimeout(() => (this.notice = null), 3000);
      if (window.innerWidth <= 900) this.composerOpen = false;
      await this.refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.creating = false;
    }
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private async control(method: string, extra: Record<string, unknown> = {}): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    this.busy = method;
    this.error = null;
    try {
      const res = await this.rpc<{ allPass?: boolean }>(method, { id, ...extra });
      if (method === "goals.recheck") {
        this.notice = res?.allPass ? "All checks pass." : "Some checks still fail.";
        window.setTimeout(() => (this.notice = null), 3000);
      }
      if (method === "goals.continue") this.instruction = "";
      if (method === "goals.delete") {
        this.selectedId = null;
        this.detail = null;
      }
      await this.refresh();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = null;
    }
  }

  private select(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.detail = null;
    this.liveLog = null;
    this.openIteration = null;
    this.instruction = "";
    void this.loadDetail(id);
  }

  // ── Render ────────────────────────────────────────────────────────────

  render(): TemplateResult {
    const mobileDetail = Boolean(this.selectedId);
    return html`
      <div class="goals ${mobileDetail ? "has-detail" : ""}">
        <div class="col col-left">
          ${this.renderComposer()} ${this.renderList()}
        </div>
        <div class="col col-right">${this.renderDetail()}</div>
      </div>
    `;
  }

  private renderComposer(): TemplateResult {
    const d = this.draft;
    const isAgent = d.target.startsWith("agent:");
    const cli = CLI_OPTIONS.find((o) => `cli:${o.id}` === d.target);
    return html`
      <form class="card composer" data-learn-id="goals-composer" @submit=${(e: Event) => this.create(e)}>
        <button
          type="button"
          class="card-head"
          data-learn-id="goals-composer-toggle"
          aria-expanded=${this.composerOpen ? "true" : "false"}
          @click=${() => (this.composerOpen = !this.composerOpen)}
        >
          <span class="eyebrow">New goal</span>
          <span class="head-hint">Runs until every check passes</span>
          <span class="chev ${this.composerOpen ? "open" : ""}" aria-hidden="true"></span>
        </button>
        ${this.composerOpen
          ? html`
              <label class="field">
                <span class="lbl">Goal</span>
                <textarea
                  rows="3"
                  data-learn-id="goals-goal-input"
                  placeholder="e.g. Make the settings page load in under 1s and keep all tests green"
                  .value=${d.goal}
                  @input=${(e: Event) => this.setDraft({ goal: (e.target as HTMLTextAreaElement).value })}
                ></textarea>
              </label>

              <div class="field" data-learn-id="goals-checks">
                <span class="lbl">Done when</span>
                <div class="checks-edit">
                  ${d.checks.map((c, i) => this.renderCheckRow(c, i))}
                </div>
                <button
                  type="button"
                  class="btn ghost sm"
                  @click=${() => this.setDraft({ checks: [...d.checks, emptyCheck("shell")] })}
                >
                  + Add check
                </button>
              </div>

              <div class="row2" data-learn-id="goals-agent">
                <label class="field">
                  <span class="lbl">Agent</span>
                  <select
                    .value=${d.target}
                    @change=${(e: Event) =>
                      this.setDraft({ target: (e.target as HTMLSelectElement).value, model: "" })}
                  >
                    <optgroup label="Coding CLIs">
                      ${CLI_OPTIONS.map(
                        (o) =>
                          html`<option value="cli:${o.id}" ?selected=${d.target === `cli:${o.id}`}>
                            ${o.label}
                          </option>`,
                      )}
                    </optgroup>
                    ${this.agents.length
                      ? html`<optgroup label="Gateway agents">
                          ${this.agents.map(
                            (a) =>
                              html`<option value="agent:${a.id}" ?selected=${d.target === `agent:${a.id}`}>
                                ${a.name}${a.name !== a.id ? ` (${a.id})` : ""}
                              </option>`,
                          )}
                        </optgroup>`
                      : nothing}
                  </select>
                </label>
                <div class="field">
                  <span class="lbl">Model</span>
                  ${isAgent
                    ? html`<webchat-model-picker
                        .client=${this.client}
                        .connected=${this.connected}
                        .value=${d.model || null}
                        .overridden=${Boolean(d.model)}
                        @model-select=${(e: CustomEvent<{ model: string | null }>) =>
                          this.setDraft({ model: e.detail.model ?? "" })}
                      ></webchat-model-picker>`
                    : html`<input
                          list="goal-model-${cli?.id ?? "x"}"
                          placeholder="Backend default"
                          .value=${d.model}
                          @input=${(e: Event) => this.setDraft({ model: (e.target as HTMLInputElement).value })}
                        />
                        <datalist id="goal-model-${cli?.id ?? "x"}">
                          ${(cli?.models ?? []).map((m) => html`<option value=${m}></option>`)}
                        </datalist>`}
                </div>
              </div>

              <label class="field">
                <span class="lbl">Project folder</span>
                <input
                  placeholder="~/projects/my-app"
                  .value=${d.workdir}
                  @input=${(e: Event) => this.setDraft({ workdir: (e.target as HTMLInputElement).value })}
                />
              </label>

              <details class="advanced" data-learn-id="goals-limits">
                <summary>Advanced limits</summary>
                <div class="grid-limits">
                  ${this.numField("Max iterations", d.maxIterations, 1, 100, (v) => this.setDraft({ maxIterations: v }))}
                  ${this.numField("Max time (min)", d.maxMinutes, 1, 10080, (v) => this.setDraft({ maxMinutes: v }))}
                  ${this.numField("Per iteration (min)", d.iterationMinutes, 1, 1440, (v) => this.setDraft({ iterationMinutes: v }))}
                  ${this.numField("Check every (s)", d.checkEverySec, 0, 86400, (v) => this.setDraft({ checkEverySec: v }))}
                  ${this.numField("Hang after (min)", d.hangMinutes, 0, 1440, (v) => this.setDraft({ hangMinutes: v }))}
                  <label class="field toggle">
                    <input
                      type="checkbox"
                      .checked=${d.notify}
                      @change=${(e: Event) => this.setDraft({ notify: (e.target as HTMLInputElement).checked })}
                    />
                    <span>Notify on finish</span>
                  </label>
                </div>
              </details>

              ${this.error ? html`<div class="msg err" role="alert">${this.error}</div>` : nothing}
              ${this.notice ? html`<div class="msg ok" role="status">${this.notice}</div>` : nothing}
              <div class="actions">
                <button class="btn primary" type="submit" data-learn-id="goals-start" ?disabled=${this.creating || !this.client}>
                  ${this.creating ? "Starting…" : "Start goal"}
                </button>
              </div>
            `
          : nothing}
      </form>
    `;
  }

  private numField(label: string, value: number, min: number, max: number, set: (v: number) => void) {
    return html`<label class="field">
      <span class="lbl">${label}</span>
      <input
        type="number"
        min=${min}
        max=${max}
        .value=${String(value)}
        @change=${(e: Event) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) set(Math.min(max, Math.max(min, n)));
        }}
      />
    </label>`;
  }

  private renderCheckRow(c: DraftCheck, i: number): TemplateResult {
    const input = (key: keyof DraftCheck, placeholder: string, mono = true) => html`<input
      class=${mono ? "mono" : ""}
      placeholder=${placeholder}
      aria-label=${placeholder}
      .value=${String(c[key] ?? "")}
      @input=${(e: Event) => this.setCheck(i, { [key]: (e.target as HTMLInputElement).value } as Partial<DraftCheck>)}
    />`;
    return html`
      <div class="check-row">
        <select
          aria-label="Check type"
          .value=${c.type}
          @change=${(e: Event) => this.setCheck(i, { type: (e.target as HTMLSelectElement).value as CheckType })}
        >
          ${CHECK_TYPES.map(
            (t) => html`<option value=${t.id} ?selected=${c.type === t.id} title=${t.hint}>${t.label}</option>`,
          )}
        </select>
        <div class="check-inputs">
          ${c.type === "shell" ? input("command", "pnpm test  ·  curl -f http://localhost:3000") : nothing}
          ${c.type === "file" ? input("path", "dist/index.html") : nothing}
          ${c.type === "grep"
            ? html`${input("path", "README.md")}${input("pattern", "## Setup")}`
            : nothing}
          ${c.type === "visual"
            ? html`${input("routes", "/chat, /agents")}<textarea
                rows="2"
                placeholder="What the screenshots must show (desktop + mobile)"
                .value=${c.criterion}
                @input=${(e: Event) => this.setCheck(i, { criterion: (e.target as HTMLTextAreaElement).value })}
              ></textarea>`
            : nothing}
          ${c.type === "llm"
            ? html`<textarea
                rows="2"
                placeholder="The settings page shows the new billing section"
                .value=${c.criterion}
                @input=${(e: Event) => this.setCheck(i, { criterion: (e.target as HTMLTextAreaElement).value })}
              ></textarea>`
            : nothing}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label="Remove check"
          title="Remove check"
          ?disabled=${this.draft.checks.length <= 1}
          @click=${() => this.setDraft({ checks: this.draft.checks.filter((_, j) => j !== i) })}
        >
          ${xIcon}
        </button>
      </div>
    `;
  }

  private renderList(): TemplateResult {
    const counts = {
      all: this.goals.length,
      active: this.goals.filter((g) => ACTIVE.has(g.status)).length,
      completed: this.goals.filter((g) => g.status === "completed").length,
      failed: this.goals.filter((g) => g.status === "failed" || g.status === "exhausted").length,
    };
    const shown = this.goals.filter((g) =>
      this.filter === "all"
        ? true
        : this.filter === "active"
          ? ACTIVE.has(g.status)
          : this.filter === "completed"
            ? g.status === "completed"
            : g.status === "failed" || g.status === "exhausted",
    );
    return html`
      <section class="card list" aria-label="Goal runs" data-learn-id="goals-list">
        <div class="list-head">
          <span class="eyebrow">Goal runs</span>
          <div class="filters" role="tablist">
            ${(["all", "active", "completed", "failed"] as Filter[]).map(
              (f) => html`<button
                role="tab"
                aria-selected=${this.filter === f ? "true" : "false"}
                class="filter ${this.filter === f ? "on" : ""}"
                data-learn-id="goals-filter-${f}"
                @click=${() => (this.filter = f)}
              >
                ${f === "all" ? "All" : f === "active" ? "Active" : f === "completed" ? "Done" : "Failed"}
                <span class="n">${counts[f]}</span>
              </button>`,
            )}
          </div>
        </div>
        ${shown.length === 0
          ? html`<div class="empty">
              ${this.goals.length === 0
                ? "No goal runs yet. Describe a goal above, add a check like `pnpm test`, and start it."
                : "Nothing in this filter."}
            </div>`
          : html`<ul class="rows">
              ${shown.map(
                (g) => html`<li>
                  <button
                    class="goal-row ${this.selectedId === g.id ? "sel" : ""}"
                    @click=${() => this.select(g.id)}
                    aria-current=${this.selectedId === g.id ? "true" : "false"}
                  >
                    <span class="row-top">
                      ${statusChip(g.status)}
                      <span class="row-title">${g.title}</span>
                    </span>
                    <span class="row-meta">
                      <span>${targetLabel(g.target)}</span>
                      <span>${g.checksPassing}/${g.checksTotal} checks</span>
                      <span>iter ${g.iterations}/${g.maxIterations}</span>
                      <span>${formatAgo(g.updatedAt)}</span>
                    </span>
                  </button>
                </li>`,
              )}
            </ul>`}
      </section>
    `;
  }

  private renderDetail(): TemplateResult {
    if (!this.selectedId) {
      return html`<section class="card detail placeholder" data-learn-id="goals-how">
        <span class="eyebrow">How goal runs work</span>
        <ol class="how">
          <li><b>Describe the goal</b> and how to verify it: a command that must exit 0, a file that must exist or contain text, or a criterion an AI reviewer checks against the agent's output and diff.</li>
          <li><b>Pick any agent</b> — Claude Code, Codex, OpenCode, Gemini, Grok Build, or one of your gateway agents.</li>
          <li><b>The run keeps going</b>: when the agent stops, every check runs. Failing output is fed back and the same session resumes until all checks pass or a limit is hit.</li>
          <li>Crashes, hangs, timeouts and "said it was done but wasn't" are all detected and shown per iteration. Runs survive gateway restarts.</li>
        </ol>
      </section>`;
    }
    const d = this.detail;
    if (!d) return html`<section class="card detail"><div class="empty">Loading…</div></section>`;
    const r = d.run;
    const active = ACTIVE.has(r.status);
    const elapsed = r.elapsedMs + (r.activeSince ? this.now - r.activeSince : 0);
    const busy = (m: string) => this.busy === m;
    return html`
      <section class="card detail" aria-label="Goal run detail" data-learn-id="goals-detail">
        <div class="detail-head">
          <button class="btn ghost sm back" @click=${() => (this.selectedId = null)}>← All goals</button>
          <div class="title-line">
            ${statusChip(r.status)}
            <h2>${r.title}</h2>
          </div>
          <div class="meta">
            <span>${targetLabel(r.target)}</span>
            ${r.workdir ? html`<span class="mono">${r.workdir}</span>` : nothing}
            <span>iteration ${r.iterations.length}/${r.limits.maxIterations}</span>
            <span>${fmtDuration(elapsed)} of ${fmtDuration(r.limits.maxWallClockSec * 1000)}</span>
          </div>
          ${r.reason ? html`<div class="reason ${r.status}">${r.reason}</div>` : nothing}
          <ib-people-chips style="margin:6px 0" .client=${this.client} objectType="goal" objectId=${r.id}></ib-people-chips>
          <div class="controls">
            ${r.status === "paused"
              ? html`<button class="btn" ?disabled=${busy("goals.resume")} @click=${() => this.control("goals.resume")}>Resume</button>`
              : active
                ? html`<button class="btn" ?disabled=${busy("goals.pause")} @click=${() => this.control("goals.pause")}>Pause</button>`
                : nothing}
            <button class="btn" ?disabled=${busy("goals.recheck")} @click=${() => this.control("goals.recheck")}>
              ${busy("goals.recheck") ? "Checking…" : "Re-check now"}
            </button>
            ${r.status === "failed" || r.status === "exhausted" || r.status === "canceled"
              ? html`<button class="btn primary" ?disabled=${busy("goals.retry")} @click=${() => this.control("goals.retry")}>Retry</button>`
              : nothing}
            ${active
              ? html`<button class="btn danger" ?disabled=${busy("goals.cancel")} @click=${() => this.control("goals.cancel")}>Cancel</button>`
              : html`<button class="btn ghost danger" ?disabled=${busy("goals.delete")} @click=${() => this.control("goals.delete")}>Delete</button>`}
          </div>
          ${this.error ? html`<div class="msg err" role="alert">${this.error}</div>` : nothing}
          ${this.notice ? html`<div class="msg ok" role="status">${this.notice}</div>` : nothing}
        </div>

        <details class="goal-text">
          <summary>Goal</summary>
          <pre>${r.goal}</pre>
        </details>

        <div class="section">
          <div class="section-head">
            <span class="eyebrow">Checks</span>
            <span class="muted">${r.lastCheckAt ? `last run ${formatAgo(r.lastCheckAt)}` : "not run yet"}</span>
          </div>
          <ul class="checks">
            ${r.checks.map((c) => this.renderCheck(c, r, d.history))}
          </ul>
        </div>

        <div class="section">
          <div class="section-head">
            <span class="eyebrow">Iterations</span>
          </div>
          ${r.iterations.length === 0
            ? html`<div class="empty">Waiting to start…</div>`
            : html`<ol class="timeline">
                ${[...r.iterations].reverse().map((it) => this.renderIteration(it, r))}
              </ol>`}
        </div>

        <div class="section">
          <div class="section-head"><span class="eyebrow">${TERMINAL.has(r.status) ? "Continue with an instruction" : "Add an instruction"}</span></div>
          <div class="continue">
            <textarea
              rows="2"
              placeholder=${TERMINAL.has(r.status)
                ? "Reopen this run with extra guidance, e.g. “use the existing auth helper”"
                : "Interrupt and resume the agent with extra guidance"}
              .value=${this.instruction}
              @input=${(e: Event) => (this.instruction = (e.target as HTMLTextAreaElement).value)}
            ></textarea>
            <button
              class="btn"
              ?disabled=${!this.instruction.trim() || busy("goals.continue")}
              @click=${() => this.control("goals.continue", { instruction: this.instruction })}
            >
              ${TERMINAL.has(r.status) ? "Continue" : "Send"}
            </button>
          </div>
        </div>
      </section>
    `;
  }

  private renderCheck(c: GoalCheck, r: GoalRun, history: CheckResult[]): TemplateResult {
    const last = r.lastResults[c.id ?? ""];
    const hist = history.filter((h) => h.checkId === c.id).slice(-16);
    const state = !last ? "pending" : last.pass ? "pass" : "fail";
    return html`<li class="check ${state}">
      <div class="check-top">
        <span class="dot ${state}" aria-label=${state}></span>
        <span class="ctype">${CHECK_TYPES.find((t) => t.id === c.type)?.label}</span>
        <span class="cdesc ${c.type === "llm" ? "" : "mono"}">${describeCheck(c)}</span>
        <span class="spark" aria-label="history">
          ${hist.map(
            (h) =>
              html`<i
                class=${h.pass ? "p" : "f"}
                title="iteration ${h.iteration} · ${TRIGGER_LABEL[h.trigger] ?? h.trigger} · ${h.pass ? "pass" : "fail"} · ${new Date(h.at).toLocaleTimeString()}"
              ></i>`,
          )}
        </span>
      </div>
      ${last
        ? html`<details class="check-out">
            <summary>${last.pass ? "Passed" : "Failed"} · iteration ${last.iteration}, ${TRIGGER_LABEL[last.trigger] ?? last.trigger} · ${formatAgo(last.at)}</summary>
            <pre>${last.output || "(no output)"}</pre>
          </details>`
        : nothing}
    </li>`;
  }

  private renderIteration(it: Iteration, r: GoalRun): TemplateResult {
    const running = it.endedAt === null;
    const dur = (it.endedAt ?? this.now) - it.startedAt;
    const open = this.openIteration === it.index || (running && this.openIteration === null);
    const log = this.liveLog && this.liveLog.iteration === it.index ? this.liveLog.output : it.outputTail;
    const tone =
      it.outcome === "checks_passed" || (it.outcome === "exited" && r.status === "completed")
        ? "ok"
        : running
          ? "run"
          : it.outcome === "interrupted" || it.outcome === "canceled"
            ? "muted"
            : it.outcome === "exited"
              ? "warn"
              : "bad";
    const durable = r.target.kind === "cli" && it.runId;
    return html`<li class="it ${tone}">
      <button
        class="it-head"
        aria-expanded=${open ? "true" : "false"}
        @click=${async () => {
          this.openIteration = open ? -1 : it.index;
          if (!open && this.selectedId) {
            try {
              this.liveLog = await this.rpc("goals.log", { id: this.selectedId, iteration: it.index });
            } catch {
              /* ignore */
            }
          }
        }}
      >
        <span class="it-n">#${it.index}</span>
        <span class="it-outcome">${OUTCOME_LABEL[it.outcome] ?? it.outcome}</span>
        ${it.resumed ? html`<span class="tag">resumed</span>` : nothing}
        ${it.exitCode !== null ? html`<span class="tag">exit ${it.exitCode}</span>` : nothing}
        <span class="it-dur">${fmtDuration(dur)}</span>
      </button>
      ${it.note ? html`<div class="it-note">${it.note}</div>` : nothing}
      ${open
        ? html`<div class="it-body">
            ${running && durable
              ? html`<div class="attach">
                  <span class="muted">Live terminal:</span>
                  <code>tmux -L infinibot attach -t infinibot_spawn_${it.runId}</code>
                  <button
                    class="btn ghost sm"
                    @click=${() =>
                      window.dispatchEvent(
                        new CustomEvent("infinibot:navigate", { detail: { tab: "terminals" }, bubbles: true, composed: true }),
                      )}
                  >
                    Open Terminals
                  </button>
                </div>`
              : nothing}
            <details>
              <summary>Prompt sent</summary>
              <pre>${it.prompt}</pre>
            </details>
            <div class="log-head">
              <span class="muted">${running ? "Agent output (live)" : "Agent output"}</span>
            </div>
            <pre class="log">${log?.trim() ? log.slice(-8000) : "(no output yet)"}</pre>
          </div>`
        : nothing}
    </li>`;
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
    .goals {
      display: grid;
      grid-template-columns: minmax(340px, 420px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
    }
    .col-right {
      position: sticky;
      top: 0;
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
    .mono,
    code,
    pre {
      font-family: var(--mono, ui-monospace, monospace);
    }
    .card-head {
      all: unset;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      cursor: pointer;
    }
    .card-head:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
      outline-offset: 4px;
      border-radius: 6px;
    }
    .head-hint {
      color: var(--muted);
      font-size: 12px;
      flex: 1;
    }
    .chev {
      width: 8px;
      height: 8px;
      border-right: 1.5px solid var(--muted);
      border-bottom: 1.5px solid var(--muted);
      transform: rotate(45deg);
      transition: transform var(--duration-fast, 0.15s);
    }
    .chev.open {
      transform: rotate(-135deg);
    }
    .composer {
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
    .lbl {
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
      font-family: var(--mono, monospace);
      font-size: 12px;
    }
    .row2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .checks-edit {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .check-row {
      display: grid;
      grid-template-columns: 124px minmax(0, 1fr) 36px;
      gap: 6px;
      align-items: start;
    }
    .check-inputs {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    .check-inputs input:nth-child(2) {
      max-width: 40%;
    }
    .icon-btn {
      display: grid;
      place-items: center;
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
      opacity: 0.35;
      cursor: default;
    }
    .advanced summary,
    .goal-text summary,
    details summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
    }
    .grid-limits {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    .toggle {
      flex-direction: row;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      align-self: end;
      min-height: 36px;
    }
    .toggle input {
      width: auto;
      min-height: 0;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
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
      min-height: 30px;
      font-size: 12px;
      align-self: flex-start;
    }
    .msg {
      font-size: 12px;
      padding: 8px 10px;
      border-radius: var(--radius-md, 8px);
    }
    .msg.err {
      color: var(--danger);
      background: var(--danger-subtle);
    }
    .msg.ok {
      color: var(--ok);
      background: var(--ok-subtle);
    }
    .list-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .filters {
      display: flex;
      gap: 4px;
    }
    .filter {
      font: inherit;
      font-size: 12px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      padding: 4px 8px;
      border-radius: var(--radius-full, 999px);
      cursor: pointer;
      min-height: 28px;
    }
    .filter.on {
      color: var(--text);
      border-color: var(--border-strong, var(--border));
      background: var(--bg-hover);
    }
    .filter .n {
      opacity: 0.6;
      margin-left: 2px;
    }
    .rows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 56vh;
      overflow: auto;
    }
    .goal-row {
      all: unset;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: 100%;
      padding: 10px;
      border-radius: var(--radius-md, 8px);
      border: 1px solid transparent;
      cursor: pointer;
    }
    .goal-row:hover {
      background: var(--bg-hover);
    }
    .goal-row.sel {
      border-color: var(--accent);
      background: var(--accent-subtle, var(--bg-hover));
    }
    .goal-row:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
    }
    .row-top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .row-title {
      font-weight: 500;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .row-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      font-size: 11px;
      color: var(--muted);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid currentColor;
      line-height: 1.5;
    }
    .chip::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .chip.running,
    .chip.queued {
      color: var(--info, var(--accent));
    }
    .chip.running::before,
    .chip.checking::before {
      animation: pulse 1.4s ease-in-out infinite;
    }
    .chip.checking {
      color: var(--accent);
    }
    .chip.paused,
    .chip.canceled {
      color: var(--muted);
    }
    .chip.completed {
      color: var(--ok);
    }
    .chip.failed {
      color: var(--danger);
    }
    .chip.exhausted {
      color: var(--warn);
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .chip::before {
        animation: none !important;
      }
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      padding: 16px 4px;
      line-height: 1.5;
    }
    .detail {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .detail-head {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .back {
      display: none;
    }
    .title-line {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font-size: 17px;
      font-weight: 600;
      color: var(--text-strong, var(--text));
      overflow-wrap: anywhere;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      font-size: 12px;
      color: var(--muted);
    }
    .meta .mono {
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .reason {
      font-size: 12px;
      padding: 8px 10px;
      border-radius: var(--radius-md, 8px);
      background: var(--bg-muted, var(--bg-hover));
      border-left: 3px solid var(--muted);
      overflow-wrap: anywhere;
    }
    .reason.failed {
      border-left-color: var(--danger);
    }
    .reason.exhausted {
      border-left-color: var(--warn);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .goal-text pre,
    .check-out pre,
    .it-body pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 11.5px;
      line-height: 1.5;
      background: var(--bg-muted, var(--bg));
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      padding: 10px;
      margin: 6px 0 0;
      max-height: 320px;
      overflow: auto;
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .section-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .checks {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .check {
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      padding: 8px 10px;
    }
    .check.fail {
      border-color: var(--danger-muted, var(--border));
    }
    .check.pass {
      border-color: var(--ok-muted, var(--border));
    }
    .check-top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      background: var(--muted);
    }
    .dot.pass {
      background: var(--ok);
    }
    .dot.fail {
      background: var(--danger);
    }
    .ctype {
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .cdesc {
      font-size: 12px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .spark {
      display: flex;
      gap: 2px;
      flex-shrink: 0;
    }
    .spark i {
      width: 5px;
      height: 14px;
      border-radius: 2px;
      background: var(--danger);
      opacity: 0.8;
    }
    .spark i.p {
      background: var(--ok);
    }
    .check-out {
      margin-top: 6px;
    }
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .it {
      border: 1px solid var(--border);
      border-left: 3px solid var(--muted);
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
    }
    .it.ok {
      border-left-color: var(--ok);
    }
    .it.run {
      border-left-color: var(--info, var(--accent));
    }
    .it.warn {
      border-left-color: var(--warn);
    }
    .it.bad {
      border-left-color: var(--danger);
    }
    .it-head {
      all: unset;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      cursor: pointer;
      flex-wrap: wrap;
      min-height: 40px;
    }
    .it-head:hover {
      background: var(--bg-hover);
    }
    .it-head:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
      outline-offset: -2px;
    }
    .it-n {
      font-weight: 600;
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
    }
    .it-outcome {
      font-size: 13px;
      font-weight: 500;
    }
    .tag {
      font-size: 10.5px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: var(--radius-full, 999px);
      padding: 0 6px;
    }
    .it-dur {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
    }
    .it-note {
      font-size: 12px;
      color: var(--muted);
      padding: 0 10px 8px;
    }
    .it-body {
      padding: 0 10px 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .attach {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
      font-size: 12px;
    }
    .attach code {
      font-size: 11px;
      background: var(--bg-muted, var(--bg));
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 6px;
      overflow-wrap: anywhere;
    }
    .log-head {
      display: flex;
      justify-content: space-between;
    }
    pre.log {
      max-height: 360px;
    }
    .continue {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .how {
      margin: 10px 0 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      font-size: 13px;
      line-height: 1.55;
      color: var(--muted-strong, var(--text));
    }
    .how b {
      color: var(--text-strong, var(--text));
    }

    @media (max-width: 1100px) {
      .goals {
        grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
      }
      .grid-limits {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 900px) {
      .goals {
        grid-template-columns: minmax(0, 1fr);
      }
      .col-right {
        position: static;
      }
      .goals.has-detail .col-left {
        display: none;
      }
      .goals:not(.has-detail) .col-right {
        display: none;
      }
      .back {
        display: inline-flex;
      }
    }
    @media (max-width: 480px) {
      .card {
        padding: 12px;
        border-radius: var(--radius-md, 10px);
      }
      .row2 {
        grid-template-columns: minmax(0, 1fr);
      }
      .check-row {
        grid-template-columns: minmax(0, 1fr) 36px;
      }
      .check-row select {
        grid-column: 1 / 2;
      }
      .check-inputs {
        grid-column: 1 / 3;
        flex-direction: column;
      }
      .check-inputs input:nth-child(2) {
        max-width: none;
      }
      .check-row .icon-btn {
        grid-row: 1;
        grid-column: 2;
      }
      .continue {
        flex-direction: column;
        align-items: stretch;
      }
      .spark {
        display: none;
      }
    }
  `;
}

function statusChip(s: Status): TemplateResult {
  return html`<span class="chip ${s}">${STATUS_LABEL[s] ?? s}</span>`;
}

const xIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

declare global {
  interface HTMLElementTagNameMap {
    "autonomy-goals-view": AutonomyGoalsView;
  }
}
