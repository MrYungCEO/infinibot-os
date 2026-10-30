/**
 * <autonomy-phases-view> — the "Phases" section of the Autonomy page.
 *
 * A thin client over the persistent phase queue (src/queue): an entry is a
 * brief + an ordered list of phases, each run by any agent (Claude Code,
 * Codex, OpenCode, Gemini CLI or a gateway agent). A phase only completes when
 * the run is VERIFIED and its gate passes.
 *
 *   header    → queue.setPaused / queue.backends / queue.metrics
 *   composer  → queue.enqueue
 *   list      → queue.list  (refreshed on queue.changed / queue.entry.* / queue.phase.*)
 *   detail    → queue.get / queue.logs + pause/resume/retry/advance/cancel/reorder
 *
 * Styling uses the InfiniBot tokens (ui/src/styles/base.css) only, so light
 * and dark themes both work; the layout collapses to one column ≤ 900px.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { formatAgo } from "../format";

// ── Wire types (mirror src/queue/types.ts) ──────────────────────────────────

type QueueStatus = "queued" | "running" | "paused" | "blocked" | "done" | "failed" | "canceled" | "dead";
type Isolation = "none" | "entry" | "phase";
type CheckType = "shell" | "file" | "grep" | "llm";

interface GateCheck {
  id?: string;
  type: CheckType | "visual";
  label?: string;
  command?: string;
  path?: string;
  pattern?: string;
  negate?: boolean;
  criterion?: string;
}

interface QueuePhase {
  name: string;
  brief: string;
  gateCriteria?: string | GateCheck[];
  agent?: string;
  model?: string;
  fallbackAgent?: string;
  workdir?: string;
  maxAttempts?: number;
  timeoutSec?: number;
  requireVerified?: boolean;
  isolation?: Isolation;
}

interface GateResult {
  pass: boolean;
  at: number;
  phaseIdx: number;
  attempt: number;
  results: Array<{ checkId: string; label: string; pass: boolean; output: string }>;
}

interface QueueAttempt {
  id: number;
  entryId: string;
  phaseIdx: number;
  n: number;
  runId: string;
  agent: string;
  backend: string | null;
  modelRequested: string | null;
  model: string | null;
  sessionId: string | null;
  resumedSession: string | null;
  fallbackFrom: string | null;
  workdir: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: string;
  counted: boolean;
  exitCode: number | null;
  verdict: string | null;
  verdictReasons: string[];
  gate: GateResult | null;
  error: string | null;
}

interface QueueEntryView {
  id: string;
  title: string;
  briefMd: string;
  phaseSpec: QueuePhase[];
  status: QueueStatus;
  priority: number;
  dependsOn: string[];
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  currentPhaseIdx: number;
  attempts: number;
  lastError: string | null;
  currentRunId: string | null;
  phaseAttempts: number;
  lastGate: GateResult | null;
  blockedKind: string | null;
  fixHint: string | null;
  nextAttemptAt: number | null;
  waitingReason: string | null;
  workdir: string | null;
  isolation: Isolation;
  worktrees: Record<string, { path: string; branch: string; repo: string }>;
  pauseRequested: boolean;
  currentAttempt: QueueAttempt | null;
}

interface QueueEventRow {
  seq: number;
  entryId: string;
  ts: number;
  kind: string;
  phaseIdx: number | null;
  message: string;
}

interface EntryDetail {
  entry: QueueEntryView;
  attempts: QueueAttempt[];
  events: QueueEventRow[];
}

interface BackendInfo {
  id: string;
  installed: boolean;
  authState: "ok" | "auth-required" | "not-installed" | "unknown";
  available: boolean;
  version?: string;
  reason?: string;
  fix?: string;
}

interface AgentMetric {
  agent: string;
  attempts: number;
  passed: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
}

interface LogState {
  loading: boolean;
  text: string;
  source: string;
  tmuxAttach?: string;
  error?: string;
}

// ── Draft (composer) ────────────────────────────────────────────────────────

interface DraftCheck {
  type: CheckType;
  command: string;
  path: string;
  pattern: string;
  criterion: string;
  negate: boolean;
}
interface DraftPhase {
  name: string;
  brief: string;
  agent: string;
  model: string;
  fallbackAgent: string;
  checks: DraftCheck[];
  maxAttempts: number;
  timeoutMin: number;
}
interface Draft {
  title: string;
  brief: string;
  workdir: string;
  isolation: Isolation;
  priority: number;
  phases: DraftPhase[];
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
];

const STATUS_LABEL: Record<QueueStatus, string> = {
  queued: "Queued",
  running: "Running",
  paused: "Paused",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
  dead: "Dead-letter",
};
const ALL_STATUSES: QueueStatus[] = ["queued", "running", "paused", "blocked", "done", "failed", "canceled", "dead"];

const OUTCOME_LABEL: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  passed: "Passed",
  gate_failed: "Gate failed",
  unverified: "Unverified",
  failed: "Failed",
  needs_input: "Needs input",
  timeout: "Timed out",
  crashed: "Crashed",
  spawn_failed: "Failed to start",
  unavailable: "Backend unavailable",
  interrupted: "Interrupted",
  canceled: "Canceled",
};

const BLOCKED_LABEL: Record<string, string> = {
  gate_failed: "Gate failed",
  unverified: "Not verified",
  needs_input: "Needs your input",
  backend_unavailable: "Backend unavailable",
  model_unavailable: "Model unavailable",
  spawn_failed: "Agent failed to start",
  timeout: "Timed out",
  dependency_failed: "Dependency failed",
  invalid: "Invalid entry",
  restart: "Interrupted by restart",
  operator: "Held by operator",
};

type Filter = "all" | "active" | "blocked" | "done" | "failed";
const FILTERS: Array<{ id: Filter; label: string; statuses: QueueStatus[] | null }> = [
  { id: "all", label: "All", statuses: null },
  { id: "active", label: "Active", statuses: ["queued", "running", "paused"] },
  { id: "blocked", label: "Blocked", statuses: ["blocked", "dead"] },
  { id: "done", label: "Done", statuses: ["done"] },
  { id: "failed", label: "Failed", statuses: ["failed", "canceled"] },
];

const TERMINAL: ReadonlySet<QueueStatus> = new Set(["done", "failed", "canceled", "dead"]);
const DRAFT_KEY = "infinibot.queue.phases.draft.v1";

function emptyCheck(type: CheckType = "shell"): DraftCheck {
  return { type, command: "", path: "", pattern: "", criterion: "", negate: false };
}

function emptyPhase(): DraftPhase {
  return {
    name: "",
    brief: "",
    agent: "claude-code",
    model: "",
    fallbackAgent: "",
    checks: [],
    maxAttempts: 3,
    timeoutMin: 30,
  };
}

function defaultDraft(): Draft {
  return { title: "", brief: "", workdir: "", isolation: "none", priority: 0, phases: [emptyPhase()] };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Draft>;
      const d = { ...defaultDraft(), ...parsed };
      d.phases = Array.isArray(parsed.phases) && parsed.phases.length
        ? parsed.phases.map((p) => ({ ...emptyPhase(), ...p, checks: Array.isArray(p.checks) ? p.checks : [] }))
        : [emptyPhase()];
      return d;
    }
  } catch {
    /* ignore */
  }
  return defaultDraft();
}

function toChecks(list: DraftCheck[]): GateCheck[] {
  const out: GateCheck[] = [];
  for (const c of list) {
    if (c.type === "shell" && c.command.trim()) out.push({ type: "shell", command: c.command.trim() });
    if (c.type === "file" && c.path.trim())
      out.push({ type: "file", path: c.path.trim(), ...(c.negate ? { negate: true } : {}) });
    if (c.type === "grep" && c.path.trim() && c.pattern.trim())
      out.push({ type: "grep", path: c.path.trim(), pattern: c.pattern.trim() });
    if (c.type === "llm" && c.criterion.trim()) out.push({ type: "llm", criterion: c.criterion.trim() });
  }
  return out;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function agentLabel(agent: string | null | undefined): string {
  if (!agent) return "default agent";
  const id = agent.startsWith("agent:") ? agent.slice(6) : agent;
  const cli = CLI_OPTIONS.find((o) => o.id === id);
  if (cli) return cli.label;
  return `@${id}`;
}

function modelLabel(a: QueueAttempt): string | null {
  if (a.modelRequested && a.model && a.modelRequested !== a.model) return `${a.modelRequested} → ${a.model}`;
  return a.model || a.modelRequested || null;
}

function outcomeTone(o: string): string {
  if (o === "passed") return "ok";
  if (o === "running" || o === "starting") return "run";
  if (o === "interrupted" || o === "canceled") return "muted";
  if (o === "gate_failed" || o === "unverified" || o === "needs_input" || o === "timeout" || o === "unavailable")
    return "warn";
  return "bad";
}

function verdictTone(v: string): string {
  const s = v.toLowerCase();
  if (s === "verified" || s === "accepted") return "ok";
  if (s === "unverified" || s === "stalled" || s === "needs_input" || s === "blocked") return "warn";
  if (s === "failed" || s === "rejected") return "bad";
  return "muted";
}

function describeGate(c: GateCheck): string {
  if (c.label) return c.label;
  switch (c.type) {
    case "shell":
      return `$ ${c.command ?? ""}`;
    case "file":
      return `${c.negate ? "absent" : "exists"}: ${c.path ?? ""}`;
    case "grep":
      return `/${c.pattern ?? ""}/ in ${c.path ?? ""}`;
    default:
      return c.criterion ?? c.type;
  }
}

function gateList(g: QueuePhase["gateCriteria"]): GateCheck[] {
  if (!g) return [];
  if (Array.isArray(g)) return g;
  return g
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("$") ? { type: "shell" as const, command: l.slice(1).trim() } : { type: "llm" as const, criterion: l }));
}

@customElement("autonomy-phases-view")
export class AutonomyPhasesView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;

  @state() private entries: QueueEntryView[] = [];
  @state() private globalPaused = false;
  @state() private loaded = false;
  @state() private selectedId: string | null = null;
  @state() private detail: EntryDetail | null = null;
  @state() private backends: BackendInfo[] = [];
  @state() private metrics: AgentMetric[] = [];
  @state() private agents: Array<{ id: string; name: string }> = [];
  @state() private draft: Draft = loadDraft();
  @state() private filter: Filter = "all";
  @state() private composerOpen: boolean | null = null;
  @state() private creating = false;
  @state() private formError: string | null = null;
  @state() private listError: string | null = null;
  @state() private detailError: string | null = null;
  @state() private notice: string | null = null;
  @state() private busy: string | null = null;
  @state() private retryOpen = false;
  @state() private retryInstruction = "";
  @state() private retryFresh = false;
  @state() private retryAgent = "";
  @state() private retryModel = "";
  @state() private retryFrom = -1;
  @state() private logs: Record<number, LogState> = {};
  @state() private now = Date.now();

  private unsubscribe: (() => void) | null = null;
  private pollTimer: number | null = null;
  private refreshTimer: number | null = null;
  private metricsAt = 0;

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
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has("client") && this.client) {
      this.unsubscribe?.();
      this.unsubscribe = this.client.subscribe((evt) => {
        if (typeof evt.event === "string" && evt.event.startsWith("queue.")) this.queueRefresh();
      });
      void this.refresh();
      void this.loadBackends(false);
      void this.loadAgents();
    }
  }

  private hasActive(): boolean {
    return this.entries.some((e) => e.status === "queued" || e.status === "running");
  }

  private queueRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
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
      const res = await this.rpc<{ entries: QueueEntryView[]; paused: boolean }>("queue.list", { limit: 200 });
      this.entries = res.entries ?? [];
      this.globalPaused = Boolean(res.paused);
      if (!this.loaded) {
        this.loaded = true;
        if (this.composerOpen === null) this.composerOpen = this.entries.length === 0;
      }
      if (!this.selectedId && this.entries.length && window.innerWidth > 900) {
        this.selectedId = this.entries[0].id;
      }
      this.listError = null;
      if (this.selectedId) await this.loadDetail(this.selectedId);
    } catch (err) {
      this.listError = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() - this.metricsAt > 30_000) void this.loadMetrics();
  }

  private async loadDetail(id: string): Promise<void> {
    try {
      const d = await this.rpc<EntryDetail>("queue.get", { id, events: 60 });
      if (this.selectedId !== id) return;
      this.detail = d;
      // Keep any open log panel of a still-running attempt live.
      for (const a of d.attempts) {
        if (this.logs[a.id] && a.endedAt === null && !this.logs[a.id].loading) void this.loadLogs(a.id, true);
      }
    } catch (err) {
      if (String(err).toLowerCase().includes("not found")) {
        this.selectedId = null;
        this.detail = null;
      } else {
        this.detailError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private async loadBackends(refresh: boolean): Promise<void> {
    try {
      const res = await this.rpc<{ backends: BackendInfo[] }>("queue.backends", refresh ? { refresh: true } : {});
      this.backends = res.backends ?? [];
    } catch {
      /* optional */
    }
  }

  private async loadMetrics(): Promise<void> {
    this.metricsAt = Date.now();
    try {
      const res = await this.rpc<{ byAgent: AgentMetric[] }>("queue.metrics", {});
      this.metrics = res.byAgent ?? [];
    } catch {
      /* optional */
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

  private async loadLogs(attemptId: number, silent = false): Promise<void> {
    const id = this.selectedId;
    if (!id) return;
    const prev = this.logs[attemptId];
    if (!silent) this.logs = { ...this.logs, [attemptId]: { loading: true, text: prev?.text ?? "", source: prev?.source ?? "" } };
    try {
      const res = await this.rpc<{ text: string; source: string; tmuxAttach?: string }>("queue.logs", {
        id,
        attemptId,
        maxChars: 20000,
      });
      if (this.selectedId !== id) return;
      this.logs = {
        ...this.logs,
        [attemptId]: { loading: false, text: res.text ?? "", source: res.source ?? "none", tmuxAttach: res.tmuxAttach },
      };
    } catch (err) {
      this.logs = {
        ...this.logs,
        [attemptId]: { loading: false, text: "", source: "none", error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private toggleLogs(attemptId: number): void {
    if (this.logs[attemptId]) {
      const next = { ...this.logs };
      delete next[attemptId];
      this.logs = next;
    } else {
      void this.loadLogs(attemptId);
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

  private setPhase(i: number, patch: Partial<DraftPhase>): void {
    this.setDraft({ phases: this.draft.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  }

  private setCheck(pi: number, ci: number, patch: Partial<DraftCheck>): void {
    const p = this.draft.phases[pi];
    this.setPhase(pi, { checks: p.checks.map((c, j) => (j === ci ? { ...c, ...patch } : c)) });
  }

  private movePhase(i: number, dir: -1 | 1): void {
    const j = i + dir;
    const phases = [...this.draft.phases];
    if (j < 0 || j >= phases.length) return;
    [phases[i], phases[j]] = [phases[j], phases[i]];
    this.setDraft({ phases });
  }

  private async enqueue(e: Event): Promise<void> {
    e.preventDefault();
    const d = this.draft;
    if (d.phases.length === 0) {
      this.formError = "Add at least one phase.";
      return;
    }
    const unnamed = d.phases.findIndex((p) => !p.name.trim());
    if (unnamed >= 0) {
      this.formError = `Phase ${unnamed + 1} needs a name.`;
      return;
    }
    const phaseSpec = d.phases.map((p) => {
      const checks = toChecks(p.checks);
      return {
        name: p.name.trim(),
        ...(p.brief.trim() ? { brief: p.brief.trim() } : {}),
        agent: p.agent,
        ...(p.model.trim() ? { model: p.model.trim() } : {}),
        ...(p.fallbackAgent ? { fallbackAgent: p.fallbackAgent } : {}),
        ...(checks.length ? { gateCriteria: checks } : {}),
        maxAttempts: Math.min(20, Math.max(1, Math.round(p.maxAttempts || 3))),
        timeoutSec: Math.min(24 * 3600, Math.max(10, Math.round((p.timeoutMin || 30) * 60))),
      };
    });
    this.creating = true;
    this.formError = null;
    try {
      const res = await this.rpc<{ id: string; deduped?: boolean }>("queue.enqueue", {
        ...(d.title.trim() ? { title: d.title.trim() } : {}),
        briefMd: d.brief.trim(),
        phaseSpec,
        priority: Math.round(d.priority) || 0,
        ...(d.workdir.trim() ? { workdir: d.workdir.trim() } : {}),
        isolation: d.isolation,
      });
      this.setDraft({ title: "", brief: "", phases: [emptyPhase()] });
      this.selectedId = res.id;
      this.detail = null;
      this.logs = {};
      this.filter = "all";
      this.flash(res.deduped ? "An identical entry already exists — selected it." : "Entry queued.");
      if (window.innerWidth <= 900) this.composerOpen = false;
      await this.refresh();
    } catch (err) {
      this.formError = err instanceof Error ? err.message : String(err);
    } finally {
      this.creating = false;
    }
  }

  private flash(msg: string): void {
    this.notice = msg;
    window.setTimeout(() => {
      if (this.notice === msg) this.notice = null;
    }, 3000);
  }

  // ── Controls ──────────────────────────────────────────────────────────

  private async control(method: string, extra: Record<string, unknown> = {}, confirmText?: string): Promise<void> {
    const id = this.selectedId;
    if (!id || this.busy) return;
    if (confirmText && !window.confirm(confirmText)) return;
    this.busy = method + (extra.force ? ":force" : "");
    this.detailError = null;
    try {
      await this.rpc(method, { id, ...extra });
      if (method === "queue.retry") {
        this.retryOpen = false;
        this.retryInstruction = "";
        this.retryFresh = false;
        this.retryAgent = "";
        this.retryModel = "";
        this.retryFrom = -1;
      }
      await this.refresh();
    } catch (err) {
      this.detailError = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = null;
    }
  }

  private async toggleDispatch(): Promise<void> {
    if (this.busy) return;
    this.busy = "queue.setPaused";
    this.listError = null;
    try {
      const res = await this.rpc<{ paused: boolean }>("queue.setPaused", { paused: !this.globalPaused });
      this.globalPaused = Boolean(res?.paused ?? !this.globalPaused);
      await this.refresh();
    } catch (err) {
      this.listError = err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = null;
    }
  }

  private select(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.detail = null;
    this.detailError = null;
    this.logs = {};
    this.retryOpen = false;
    this.retryInstruction = "";
    this.retryAgent = "";
    this.retryModel = "";
    this.retryFrom = -1;
    void this.loadDetail(id);
  }

  // ── Render ────────────────────────────────────────────────────────────

  render(): TemplateResult {
    return html`
      ${this.renderHeader()}
      <div class="aph ${this.selectedId ? "has-detail" : ""}">
        <div class="col col-left">${this.renderComposer()} ${this.renderList()}</div>
        <div class="col col-right">${this.renderDetail()}</div>
      </div>
    `;
  }

  private renderHeader(): TemplateResult {
    const counts = new Map<QueueStatus, number>();
    for (const e of this.entries) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
    const busy = this.busy === "queue.setPaused";
    return html`
      <section class="card aph-head" aria-label="Phase queue status" data-learn-id="phases-status">
        <div class="aph-head-row">
          <button
            class="aph-dispatch ${this.globalPaused ? "paused" : "running"}"
            data-learn-id="phases-dispatch"
            role="switch"
            aria-checked=${this.globalPaused ? "false" : "true"}
            ?disabled=${busy || !this.client}
            title=${this.globalPaused ? "Dispatch is paused — click to resume" : "Dispatch is running — click to pause"}
            @click=${() => this.toggleDispatch()}
          >
            <span class="aph-knob" aria-hidden="true"></span>
            <span>Dispatch: <b>${this.globalPaused ? "paused" : "running"}</b></span>
          </button>
          <div class="aph-counts" aria-label="Entries by status">
            ${ALL_STATUSES.filter((s) => counts.get(s)).map(
              (s) => html`<span class="aph-count ${s}"><b>${counts.get(s)}</b> ${STATUS_LABEL[s].toLowerCase()}</span>`,
            )}
            ${this.entries.length === 0 && this.loaded ? html`<span class="muted">Queue empty</span>` : nothing}
          </div>
        </div>
        <div class="aph-head-row">
          <div class="aph-backends" aria-label="CLI backends" data-learn-id="phases-backends">
            ${this.backends.map((b) => {
              const tone = b.authState === "ok" && b.available ? "ok" : b.authState === "auth-required" ? "warn" : "muted";
              const label =
                b.authState === "ok" ? (b.available ? "ok" : "unavailable")
                  : b.authState === "auth-required" ? "not logged in"
                  : b.authState === "not-installed" ? "not installed"
                  : "unknown";
              const tip = [b.version ? `v${b.version}` : "", b.reason ?? "", b.fix ?? ""].filter(Boolean).join(" — ");
              return html`<span class="aph-be ${tone}" title=${tip || label} tabindex="0">
                <span class="aph-be-dot" aria-hidden="true"></span>${agentLabel(b.id)}<span class="aph-be-st">${label}</span>
              </span>`;
            })}
            <button class="btn ghost xs" title="Re-probe CLI backends" @click=${() => this.loadBackends(true)}>
              Re-check
            </button>
          </div>
          ${this.metrics.length
            ? html`<div class="aph-metrics" aria-label="Success rate by agent">
                ${this.metrics.slice(0, 5).map(
                  (m) => html`<span title="${m.passed} passed · ${m.failed} failed of ${m.attempts} attempts"
                    >${agentLabel(m.agent)} <b>${Math.round((m.successRate ?? 0) * 100)}%</b> · avg
                    ${fmtDuration(m.avgDurationMs)}</span
                  >`,
                )}
              </div>`
            : nothing}
        </div>
        ${this.listError ? html`<div class="msg err" role="alert">${this.listError}</div>` : nothing}
      </section>
    `;
  }

  private agentOptions(selected: string, includeNone: boolean): TemplateResult {
    return html`
      ${includeNone ? html`<option value="" ?selected=${!selected}>None</option>` : nothing}
      <optgroup label="Coding CLIs">
        ${CLI_OPTIONS.map((o) => html`<option value=${o.id} ?selected=${selected === o.id}>${o.label}</option>`)}
      </optgroup>
      ${this.agents.length
        ? html`<optgroup label="Gateway agents">
            ${this.agents.map(
              (a) => html`<option value=${a.id} ?selected=${selected === a.id}>
                ${a.name}${a.name !== a.id ? ` (${a.id})` : ""}
              </option>`,
            )}
          </optgroup>`
        : nothing}
    `;
  }

  private renderComposer(): TemplateResult {
    const d = this.draft;
    const open = this.composerOpen === true;
    return html`
      <form class="card composer" data-learn-id="phases-composer" @submit=${(e: Event) => this.enqueue(e)} novalidate>
        <button
          type="button"
          class="card-head"
          data-learn-id="phases-composer-toggle"
          aria-expanded=${open ? "true" : "false"}
          @click=${() => (this.composerOpen = !open)}
        >
          <span class="eyebrow">New phased entry</span>
          <span class="head-hint">Verified, gated phases</span>
          <span class="chev ${open ? "open" : ""}" aria-hidden="true"></span>
        </button>
        ${open
          ? html`
              <label class="field">
                <span class="lbl">Title</span>
                <input
                  data-learn-id="phases-title-input"
                  placeholder="e.g. Billing page v2"
                  .value=${d.title}
                  @input=${(e: Event) => this.setDraft({ title: (e.target as HTMLInputElement).value })}
                />
              </label>
              <label class="field">
                <span class="lbl">Brief</span>
                <textarea
                  rows="3"
                  data-learn-id="phases-brief-input"
                  placeholder="What the whole entry should achieve. Shared with every phase."
                  .value=${d.brief}
                  @input=${(e: Event) => this.setDraft({ brief: (e.target as HTMLTextAreaElement).value })}
                ></textarea>
              </label>
              <label class="field">
                <span class="lbl">Project folder</span>
                <input
                  class="mono"
                  placeholder="~/projects/my-app"
                  .value=${d.workdir}
                  @input=${(e: Event) => this.setDraft({ workdir: (e.target as HTMLInputElement).value })}
                />
              </label>
              <div class="row2" data-learn-id="phases-isolation">
                <label class="field">
                  <span class="lbl">Isolation</span>
                  <select
                    .value=${d.isolation}
                    @change=${(e: Event) => this.setDraft({ isolation: (e.target as HTMLSelectElement).value as Isolation })}
                  >
                    <option value="none" ?selected=${d.isolation === "none"}>None (run in folder)</option>
                    <option value="entry" ?selected=${d.isolation === "entry"}>One worktree per entry</option>
                    <option value="phase" ?selected=${d.isolation === "phase"}>One worktree per phase</option>
                  </select>
                </label>
                <label class="field">
                  <span class="lbl">Priority</span>
                  <input
                    type="number"
                    min="-1000"
                    max="1000"
                    .value=${String(d.priority)}
                    @change=${(e: Event) => {
                      const n = Number((e.target as HTMLInputElement).value);
                      if (Number.isFinite(n)) this.setDraft({ priority: Math.min(1000, Math.max(-1000, Math.round(n))) });
                    }}
                  />
                </label>
              </div>

              <div class="field" data-learn-id="phases-phases">
                <span class="lbl">Phases</span>
                <ol class="prows">
                  ${d.phases.map((p, i) => this.renderPhaseRow(p, i))}
                </ol>
                <button
                  type="button"
                  class="btn ghost sm"
                  @click=${() => this.setDraft({ phases: [...d.phases, emptyPhase()] })}
                >
                  + Add phase
                </button>
              </div>

              ${this.formError ? html`<div class="msg err" role="alert">${this.formError}</div>` : nothing}
              ${this.notice ? html`<div class="msg ok" role="status">${this.notice}</div>` : nothing}
              <div class="actions">
                <button
                  type="button"
                  class="btn ghost"
                  @click=${() => {
                    this.setDraft(defaultDraft());
                    this.formError = null;
                  }}
                >
                  Clear
                </button>
                <button class="btn primary" type="submit" data-learn-id="phases-queue-btn" ?disabled=${this.creating || !this.client}>
                  ${this.creating ? "Queuing…" : `Queue ${d.phases.length} phase${d.phases.length === 1 ? "" : "s"}`}
                </button>
              </div>
            `
          : nothing}
      </form>
    `;
  }

  private renderPhaseRow(p: DraftPhase, i: number): TemplateResult {
    const n = this.draft.phases.length;
    const cli = CLI_OPTIONS.find((o) => o.id === p.agent);
    const listId = `aph-models-${i}`;
    return html`<li class="prow">
      <div class="prow-head">
        <span class="prow-n">Phase ${i + 1}</span>
        <span class="prow-tools">
          <button type="button" class="icon-btn" aria-label="Move phase ${i + 1} up" title="Move up" ?disabled=${i === 0} @click=${() => this.movePhase(i, -1)}>${upIcon}</button>
          <button type="button" class="icon-btn" aria-label="Move phase ${i + 1} down" title="Move down" ?disabled=${i === n - 1} @click=${() => this.movePhase(i, 1)}>${downIcon}</button>
          <button
            type="button"
            class="icon-btn danger"
            aria-label="Remove phase ${i + 1}"
            title="Remove phase"
            ?disabled=${n <= 1}
            @click=${() => this.setDraft({ phases: this.draft.phases.filter((_, j) => j !== i) })}
          >
            ${xIcon}
          </button>
        </span>
      </div>
      <input
        data-learn-id="phases-phase-name-${i}"
        aria-label="Phase ${i + 1} name"
        placeholder="Phase name, e.g. Implement API"
        class=${!p.name.trim() && this.formError ? "invalid" : ""}
        .value=${p.name}
        @input=${(e: Event) => this.setPhase(i, { name: (e.target as HTMLInputElement).value })}
      />
      <textarea
        rows="2"
        aria-label="Phase ${i + 1} brief"
        placeholder="What this phase must do"
        .value=${p.brief}
        @input=${(e: Event) => this.setPhase(i, { brief: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
      <div class="row2">
        <label class="field">
          <span class="lbl">Agent</span>
          <select
            .value=${p.agent}
            @change=${(e: Event) => this.setPhase(i, { agent: (e.target as HTMLSelectElement).value, model: "" })}
          >
            ${this.agentOptions(p.agent, false)}
          </select>
        </label>
        <label class="field">
          <span class="lbl">Model</span>
          <input
            list=${listId}
            placeholder="Backend default"
            .value=${p.model}
            @input=${(e: Event) => this.setPhase(i, { model: (e.target as HTMLInputElement).value })}
          />
          <datalist id=${listId}>${(cli?.models ?? []).map((m) => html`<option value=${m}></option>`)}</datalist>
        </label>
      </div>
      <div class="row3">
        <label class="field span-sm">
          <span class="lbl">Fallback agent</span>
          <select
            .value=${p.fallbackAgent}
            @change=${(e: Event) => this.setPhase(i, { fallbackAgent: (e.target as HTMLSelectElement).value })}
          >
            ${this.agentOptions(p.fallbackAgent, true)}
          </select>
        </label>
        <label class="field">
          <span class="lbl">Max attempts</span>
          <input
            type="number"
            min="1"
            max="20"
            .value=${String(p.maxAttempts)}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) this.setPhase(i, { maxAttempts: Math.min(20, Math.max(1, Math.round(v))) });
            }}
          />
        </label>
        <label class="field">
          <span class="lbl">Timeout (min)</span>
          <input
            type="number"
            min="1"
            max="1440"
            .value=${String(p.timeoutMin)}
            @change=${(e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) this.setPhase(i, { timeoutMin: Math.min(1440, Math.max(1, v)) });
            }}
          />
        </label>
      </div>
      <div class="field" data-learn-id="phases-gate-${i}">
        <span class="lbl">Gate checks ${p.checks.length ? nothing : html`<span class="muted">· none (verification verdict only)</span>`}</span>
        ${p.checks.length ? html`<div class="checks-edit">${p.checks.map((c, ci) => this.renderCheckRow(c, i, ci))}</div>` : nothing}
        <button
          type="button"
          class="btn ghost sm"
          data-learn-id="phases-add-gate-${i}"
          @click=${() => this.setPhase(i, { checks: [...p.checks, emptyCheck("shell")] })}
        >
          + Add gate check
        </button>
      </div>
    </li>`;
  }

  private renderCheckRow(c: DraftCheck, pi: number, ci: number): TemplateResult {
    const input = (key: keyof DraftCheck, placeholder: string) => html`<input
      class="mono"
      placeholder=${placeholder}
      aria-label=${placeholder}
      .value=${String(c[key] ?? "")}
      @input=${(e: Event) => this.setCheck(pi, ci, { [key]: (e.target as HTMLInputElement).value } as Partial<DraftCheck>)}
    />`;
    return html`
      <div class="check-row">
        <select
          aria-label="Check type"
          .value=${c.type}
          @change=${(e: Event) => this.setCheck(pi, ci, { type: (e.target as HTMLSelectElement).value as CheckType })}
        >
          ${CHECK_TYPES.map(
            (t) => html`<option value=${t.id} ?selected=${c.type === t.id} title=${t.hint}>${t.label}</option>`,
          )}
        </select>
        <div class="check-inputs">
          ${c.type === "shell" ? input("command", "pnpm test") : nothing}
          ${c.type === "file" ? input("path", "dist/index.html") : nothing}
          ${c.type === "grep" ? html`${input("path", "README.md")}${input("pattern", "## Setup")}` : nothing}
          ${c.type === "llm"
            ? html`<textarea
                rows="2"
                placeholder="The API returns paginated results"
                .value=${c.criterion}
                @input=${(e: Event) => this.setCheck(pi, ci, { criterion: (e.target as HTMLTextAreaElement).value })}
              ></textarea>`
            : nothing}
        </div>
        <button
          type="button"
          class="icon-btn danger"
          aria-label="Remove check"
          title="Remove check"
          @click=${() =>
            this.setPhase(pi, { checks: this.draft.phases[pi].checks.filter((_, j) => j !== ci) })}
        >
          ${xIcon}
        </button>
      </div>
    `;
  }

  private renderList(): TemplateResult {
    const match = (f: Filter, e: QueueEntryView) => {
      const st = FILTERS.find((x) => x.id === f)?.statuses;
      return !st || st.includes(e.status);
    };
    const shown = this.entries.filter((e) => match(this.filter, e));
    return html`
      <section class="card list" aria-label="Queue entries" data-learn-id="phases-list">
        <div class="list-head">
          <span class="eyebrow">Entries</span>
          <div class="filters" role="tablist" aria-label="Filter entries">
            ${FILTERS.map(
              (f) => html`<button
                role="tab"
                aria-selected=${this.filter === f.id ? "true" : "false"}
                class="filter ${this.filter === f.id ? "on" : ""}"
                data-learn-id="phases-filter-${f.id}"
                @click=${() => (this.filter = f.id)}
              >
                ${f.label} <span class="n">${this.entries.filter((e) => match(f.id, e)).length}</span>
              </button>`,
            )}
          </div>
        </div>
        ${!this.loaded
          ? html`<div class="empty">${this.client ? "Loading…" : "Not connected to the gateway."}</div>`
          : shown.length === 0
            ? html`<div class="empty">
                ${this.entries.length === 0
                  ? "No phased entries yet. Open “New phased entry”, split the work into phases, and queue it."
                  : "Nothing in this filter."}
              </div>`
            : html`<ul class="rows" role="listbox" aria-label="Entries">
                ${shown.map((e) => this.renderRow(e))}
              </ul>`}
      </section>
    `;
  }

  private renderRow(e: QueueEntryView): TemplateResult {
    const total = e.phaseSpec.length;
    const idx = Math.min(e.currentPhaseIdx, Math.max(0, total - 1));
    const phase = e.phaseSpec[idx];
    const a = e.currentAttempt;
    const who = a ? agentLabel(a.agent) : agentLabel(phase?.agent);
    const model = a ? modelLabel(a) : phase?.model;
    const sel = this.selectedId === e.id;
    return html`<li>
      <button
        class="entry-row ${sel ? "sel" : ""}"
        role="option"
        aria-selected=${sel ? "true" : "false"}
        @click=${() => this.select(e.id)}
      >
        <span class="row-top">
          ${statusChip(e.status)}
          <span class="row-title">${e.title || e.id}</span>
          <span class="row-age">${formatAgo(e.updatedAt)}</span>
        </span>
        <span class="row-meta">
          <span class="row-phase">${e.status === "done" ? `${total}/${total} phases` : `phase ${idx + 1}/${total}`} · ${phase?.name ?? "—"}</span>
          <span class="row-agent">${who}${model ? html` · <span class="mono">${model}</span>` : nothing}</span>
        </span>
      </button>
    </li>`;
  }

  private renderDetail(): TemplateResult {
    if (!this.selectedId) {
      return html`<section class="card detail placeholder" data-learn-id="phases-how">
        <span class="eyebrow">How phased entries work</span>
        <ol class="how">
          <li><b>Split the work into phases</b> — each with its own brief, agent, model and gate checks.</li>
          <li><b>Any agent per phase</b>: Claude Code, Codex, OpenCode, Gemini CLI, Grok Build or a gateway agent, with an optional fallback when a CLI is missing or logged out.</li>
          <li><b>A phase completes only when</b> the run is verified and every gate check passes — never just because the process exited.</li>
          <li>Failed attempts retry in the same session up to the limit, then the entry blocks with a concrete fix. The queue survives gateway restarts.</li>
        </ol>
      </section>`;
    }
    const d = this.detail;
    if (!d)
      return html`<section class="card detail">
        <button class="btn ghost sm back" @click=${() => (this.selectedId = null)}>← All entries</button>
        <div class="empty">${this.detailError ?? "Loading…"}</div>
      </section>`;
    const e = d.entry;
    const busyAny = this.busy !== null;
    const btn = (label: string, method: string, extra: Record<string, unknown> = {}, cls = "", confirmText?: string) => {
      const key = method + (extra.force ? ":force" : "");
      return html`<button
        class="btn ${cls}"
        ?disabled=${busyAny || !this.client}
        aria-busy=${this.busy === key ? "true" : "false"}
        @click=${() => this.control(method, extra, confirmText)}
      >
        ${this.busy === key ? `${label}…` : label}
      </button>`;
    };
    const s = e.status;
    const canPause = s === "running" || s === "queued";
    const canResume = s === "paused";
    const canRetry = s === "blocked" || s === "dead" || s === "failed" || s === "canceled" || s === "paused";
    const canSkip = s === "blocked" || s === "paused" || s === "dead" || s === "failed";
    const canCancel = !TERMINAL.has(s);
    const canReorder = !TERMINAL.has(s);
    const phaseName = e.phaseSpec[e.currentPhaseIdx]?.name ?? `phase ${e.currentPhaseIdx + 1}`;
    const worktrees = Object.entries(e.worktrees ?? {});
    return html`
      <section class="card detail" aria-label="Entry detail">
        <div class="detail-head">
          <button class="btn ghost sm back" @click=${() => (this.selectedId = null)}>← All entries</button>
          <div class="title-line">
            ${statusChip(s)}
            <h2>${e.title || e.id}</h2>
          </div>
          <div class="meta">
            <span class="mono" title="Entry id">${e.id}</span>
            <span>priority ${e.priority}</span>
            <span>${e.attempts} attempt${e.attempts === 1 ? "" : "s"}</span>
            <span>isolation ${e.isolation}</span>
            <span>created ${formatAgo(e.createdAt)}</span>
            ${e.startedAt ? html`<span>${fmtDuration((e.finishedAt ?? this.now) - e.startedAt)} elapsed</span>` : nothing}
            ${e.workdir ? html`<span class="mono wrap">${e.workdir}</span>` : nothing}
          </div>
          ${worktrees.length
            ? html`<div class="meta">
                ${worktrees.map(([k, w]) => html`<span class="mono wrap" title=${w.repo}>${k}: ${w.branch} · ${w.path}</span>`)}
              </div>`
            : nothing}
          ${this.renderBanner(e)}
          <div class="controls">
            ${canPause && s === "running"
              ? html`${e.pauseRequested
                  ? html`<span class="tag warn">Pause requested — parks after this attempt</span>`
                  : btn("Pause", "queue.pause", {}, "", undefined)}
                ${btn("Force pause", "queue.pause", { force: true }, "", "Stop the running attempt now? It will not count against the attempt limit.")}`
              : canPause
                ? btn("Pause", "queue.pause")
                : nothing}
            ${canResume ? btn("Resume", "queue.resume", {}, s === "paused" ? "primary" : "") : nothing}
            ${canRetry
              ? html`<button
                  class="btn ${s === "paused" ? "" : "primary"}"
                  aria-expanded=${this.retryOpen ? "true" : "false"}
                  ?disabled=${busyAny}
                  @click=${() => (this.retryOpen = !this.retryOpen)}
                >
                  Retry…
                </button>`
              : nothing}
            ${canSkip
              ? btn("Skip phase", "queue.advance", { reason: "operator skip from UI" }, "", `Skip “${phaseName}” and advance to the next phase? This is recorded in the audit log.`)
              : nothing}
            ${canReorder
              ? html`<span class="prio" role="group" aria-label="Priority">
                  <button
                    class="btn sm"
                    title="Raise priority"
                    aria-label="Raise priority"
                    ?disabled=${busyAny || e.priority >= 1000}
                    @click=${() => this.control("queue.reorder", { priority: Math.min(1000, e.priority + 1) })}
                  >${upIcon}</button>
                  <span class="prio-n">P${e.priority}</span>
                  <button
                    class="btn sm"
                    title="Lower priority"
                    aria-label="Lower priority"
                    ?disabled=${busyAny || e.priority <= -1000}
                    @click=${() => this.control("queue.reorder", { priority: Math.max(-1000, e.priority - 1) })}
                  >${downIcon}</button>
                </span>`
              : nothing}
            ${canCancel
              ? btn("Cancel", "queue.cancel", { reason: "canceled from UI" }, "danger", `Cancel “${e.title || e.id}”? The running attempt is stopped.`)
              : nothing}
          </div>
          ${this.retryOpen && canRetry ? this.renderRetry(e) : nothing}
          ${this.detailError ? html`<div class="msg err" role="alert">${this.detailError}</div>` : nothing}
        </div>

        ${e.briefMd
          ? html`<details class="brief">
              <summary>Brief</summary>
              <pre>${e.briefMd}</pre>
            </details>`
          : nothing}

        <div class="section">
          <div class="section-head">
            <span class="eyebrow">Phases</span>
            <span class="muted">${Math.min(e.currentPhaseIdx + (s === "done" ? 0 : 1), e.phaseSpec.length)}/${e.phaseSpec.length}</span>
          </div>
          <ol class="timeline">
            ${e.phaseSpec.map((p, i) => this.renderPhase(e, p, i, d.attempts.filter((a) => a.phaseIdx === i)))}
          </ol>
        </div>

        <details class="events">
          <summary>Events (${d.events.length})</summary>
          ${d.events.length
            ? html`<ol class="ev-list">
                ${[...d.events].sort((a, b) => b.seq - a.seq).map(
                  (ev) => html`<li>
                    <time title=${new Date(ev.ts).toLocaleString()}>${new Date(ev.ts).toLocaleTimeString()}</time>
                    <span class="ev-kind mono">${ev.kind}${ev.phaseIdx !== null ? ` · p${ev.phaseIdx + 1}` : ""}</span>
                    <span class="ev-msg">${ev.message}</span>
                  </li>`,
                )}
              </ol>`
            : html`<div class="empty">No events.</div>`}
        </details>
      </section>
    `;
  }

  private renderBanner(e: QueueEntryView): TemplateResult | typeof nothing {
    const bad = e.status === "blocked" || e.status === "dead" || e.status === "failed";
    const waiting = e.status === "queued" && (e.waitingReason || e.nextAttemptAt);
    if (!bad && !waiting && !(e.lastError && e.status !== "done")) return nothing;
    const tone = e.status === "blocked" ? "warn" : bad ? "bad" : "info";
    const title = bad
      ? `${STATUS_LABEL[e.status]}${e.blockedKind ? ` — ${BLOCKED_LABEL[e.blockedKind] ?? e.blockedKind}` : ""}`
      : waiting
        ? "Waiting to dispatch"
        : "Last error";
    return html`<div class="banner ${tone}" role=${bad ? "alert" : "status"}>
      <div class="banner-title">${title}</div>
      ${waiting
        ? html`<div class="banner-text">
            ${e.waitingReason ?? ""}${e.nextAttemptAt && e.nextAttemptAt > this.now
              ? ` Next attempt in ${fmtDuration(e.nextAttemptAt - this.now)}.`
              : ""}
          </div>`
        : nothing}
      ${e.fixHint ? html`<div class="banner-fix"><span class="lbl">Fix</span><span>${e.fixHint}</span></div>` : nothing}
      ${e.lastError ? html`<pre class="banner-err">${e.lastError}</pre>` : nothing}
    </div>`;
  }

  private renderRetry(e: QueueEntryView): TemplateResult {
    const from = this.retryFrom < 0 ? e.currentPhaseIdx : this.retryFrom;
    return html`<div class="retry">
      <label class="field">
        <span class="lbl">Instruction for the next attempt (optional)</span>
        <textarea
          rows="2"
          placeholder="e.g. Use the existing auth helper instead of adding a new one"
          .value=${this.retryInstruction}
          @input=${(ev: Event) => (this.retryInstruction = (ev.target as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      <div class="retry-row">
        <label class="field inline">
          <span class="lbl">Agent</span>
          <select
            aria-label="Run the retried phase on"
            .value=${this.retryAgent}
            @change=${(ev: Event) => (this.retryAgent = (ev.target as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${this.retryAgent === ""}>Same (${e.phaseSpec[from]?.agent ?? "claude-code"})</option>
            ${["claude-code", "codex", "opencode", "gemini", "grok"].map(
              (a) => html`<option value=${a} ?selected=${this.retryAgent === a}>${a}</option>`,
            )}
          </select>
        </label>
        <label class="field inline">
          <span class="lbl">Model</span>
          <input
            type="text"
            placeholder=${e.phaseSpec[from]?.model ?? "default"}
            .value=${this.retryModel}
            @input=${(ev: Event) => (this.retryModel = (ev.target as HTMLInputElement).value)}
          />
        </label>
      </div>
      <div class="retry-row">
        <label class="field inline">
          <span class="lbl">From</span>
          <select
            .value=${String(from)}
            @change=${(ev: Event) => (this.retryFrom = Number((ev.target as HTMLSelectElement).value))}
          >
            ${e.phaseSpec.map(
              (p, i) => html`<option value=${String(i)} ?selected=${i === from}>${i + 1}. ${p.name}</option>`,
            )}
          </select>
        </label>
        <label class="toggle">
          <input
            type="checkbox"
            .checked=${this.retryFresh}
            @change=${(ev: Event) => (this.retryFresh = (ev.target as HTMLInputElement).checked)}
          />
          <span>Fresh session</span>
        </label>
        <button
          class="btn primary"
          ?disabled=${this.busy !== null}
          @click=${() =>
            this.control("queue.retry", {
              ...(from !== e.currentPhaseIdx ? { fromPhase: from } : {}),
              ...(this.retryInstruction.trim() ? { instruction: this.retryInstruction.trim() } : {}),
              ...(this.retryFresh ? { freshSession: true } : {}),
              ...(this.retryAgent ? { agent: this.retryAgent } : {}),
              ...(this.retryModel.trim() ? { model: this.retryModel.trim() } : {}),
            })}
        >
          ${this.busy === "queue.retry" ? "Retrying…" : "Retry now"}
        </button>
      </div>
    </div>`;
  }

  private phaseState(e: QueueEntryView, i: number): "done" | "active" | "blocked" | "pending" | "skipped" {
    if (e.status === "done") return "done";
    if (i < e.currentPhaseIdx) return "done";
    if (i > e.currentPhaseIdx) return "pending";
    if (e.status === "blocked" || e.status === "dead" || e.status === "failed") return "blocked";
    if (e.status === "canceled") return "skipped";
    return "active";
  }

  private renderPhase(e: QueueEntryView, p: QueuePhase, i: number, attempts: QueueAttempt[]): TemplateResult {
    const st = this.phaseState(e, i);
    const gates = gateList(p.gateCriteria);
    const stLabel =
      st === "done" ? "Done"
        : st === "blocked" ? STATUS_LABEL[e.status]
        : st === "skipped" ? "Canceled"
        : st === "active" ? (e.status === "running" ? "Running" : STATUS_LABEL[e.status])
        : "Pending";
    return html`<li class="ph ${st}">
      <div class="ph-rail" aria-hidden="true"><span class="ph-dot">${st === "done" ? checkIcon : String(i + 1)}</span></div>
      <div class="ph-body">
        <div class="ph-head">
          <span class="ph-name">${p.name}</span>
          <span class="tag ${st}">${stLabel}</span>
          <span class="ph-spec">
            ${agentLabel(p.agent)}${p.model ? html` · <span class="mono">${p.model}</span>` : nothing}
            ${p.fallbackAgent ? html` · fallback ${agentLabel(p.fallbackAgent)}` : nothing}
            · max ${p.maxAttempts ?? 3} · ${fmtDuration((p.timeoutSec ?? 1800) * 1000)}
          </span>
        </div>
        ${p.brief ? html`<div class="ph-brief">${p.brief}</div>` : nothing}
        ${gates.length
          ? html`<div class="ph-gates" aria-label="Gate checks">
              ${gates.map((g) => html`<span class="gate-spec ${g.type === "llm" ? "" : "mono"}" title=${describeGate(g)}>${describeGate(g)}</span>`)}
            </div>`
          : nothing}
        ${attempts.length
          ? html`<ol class="attempts">${[...attempts].sort((a, b) => b.n - a.n).map((a) => this.renderAttempt(a))}</ol>`
          : st === "active"
            ? html`<div class="muted small">Waiting for the first attempt…</div>`
            : nothing}
      </div>
    </li>`;
  }

  private renderAttempt(a: QueueAttempt): TemplateResult {
    const running = a.endedAt === null;
    const dur = (a.endedAt ?? this.now) - a.startedAt;
    const tone = outcomeTone(a.outcome);
    const model = modelLabel(a);
    const log = this.logs[a.id];
    return html`<li class="att ${tone}">
      <div class="att-head">
        <span class="att-n">#${a.n}</span>
        <span class="chip o-${tone}">${OUTCOME_LABEL[a.outcome] ?? a.outcome}</span>
        <span class="att-who">
          ${agentLabel(a.agent)}${a.backend && agentLabel(a.backend) !== agentLabel(a.agent) ? html` <span class="muted">(${a.backend})</span>` : nothing}
          ${model ? html` · <span class="mono">${model}</span>` : nothing}
        </span>
        <span class="att-dur" title=${new Date(a.startedAt).toLocaleString()}>${running ? "running " : ""}${fmtDuration(dur)}</span>
      </div>
      <div class="att-tags">
        ${a.verdict ? html`<span class="chip v-${verdictTone(a.verdict)}" title="Verification verdict">${a.verdict}</span>` : nothing}
        ${a.gate
          ? html`<span class="tag ${a.gate.pass ? "ok" : "bad"}">gate ${a.gate.pass ? "pass" : "fail"} ${a.gate.results.filter((r) => r.pass).length}/${a.gate.results.length}</span>`
          : nothing}
        ${a.resumedSession ? html`<span class="tag" title="Resumed session ${a.resumedSession}">resumed</span>` : nothing}
        ${a.fallbackFrom ? html`<span class="tag warn">fallback from ${agentLabel(a.fallbackFrom)}</span>` : nothing}
        ${!a.counted && !running ? html`<span class="tag">not counted</span>` : nothing}
        ${a.exitCode !== null ? html`<span class="tag">exit ${a.exitCode}</span>` : nothing}
        ${a.sessionId
          ? html`<button
              class="tag sess mono"
              title="Session ${a.sessionId} — click to copy"
              @click=${() => {
                void navigator.clipboard?.writeText(a.sessionId ?? "").then(
                  () => this.flash("Session id copied."),
                  () => undefined,
                );
              }}
            >
              ${a.sessionId.slice(0, 8)}
            </button>`
          : nothing}
        <button class="btn ghost xs logs-btn" aria-expanded=${log ? "true" : "false"} @click=${() => this.toggleLogs(a.id)}>
          ${log ? "Hide logs" : "Logs"}
        </button>
      </div>
      ${a.verdictReasons?.length
        ? html`<ul class="reasons">${a.verdictReasons.map((r) => html`<li>${r}</li>`)}</ul>`
        : nothing}
      ${a.gate?.results.length
        ? html`<ul class="gate-res">
            ${a.gate.results.map(
              (r) => html`<li class="${r.pass ? "pass" : "fail"}">
                <details>
                  <summary>
                    <span class="dot ${r.pass ? "pass" : "fail"}" aria-hidden="true"></span>
                    <span class="gr-state">${r.pass ? "pass" : "fail"}</span>
                    <span class="gr-label">${r.label}</span>
                  </summary>
                  <pre>${r.output || "(no output)"}</pre>
                </details>
              </li>`,
            )}
          </ul>`
        : nothing}
      ${a.error ? html`<pre class="att-err">${a.error}</pre>` : nothing}
      ${log
        ? html`<div class="logs">
            ${log.tmuxAttach
              ? html`<div class="attach"><span class="muted">Live terminal:</span><code>${log.tmuxAttach}</code></div>`
              : nothing}
            ${log.error
              ? html`<div class="msg err">${log.error}</div>`
              : html`<pre class="log">${log.loading && !log.text
                  ? "Loading…"
                  : log.text.trim()
                    ? log.text
                    : "(no output captured)"}</pre>
                  ${log.source && !log.loading ? html`<span class="muted small">source: ${log.source}</span>` : nothing}`}
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
    .aph {
      display: grid;
      grid-template-columns: minmax(340px, 440px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: 16px;
      min-width: 0;
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
    .mono,
    code,
    pre {
      font-family: var(--mono, ui-monospace, monospace);
    }
    .wrap {
      overflow-wrap: anywhere;
    }

    /* ── Header strip ── */
    .aph-head {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 16px;
      padding: 12px 16px;
    }
    .aph-head-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px 16px;
      min-width: 0;
    }
    .aph-dispatch {
      font: inherit;
      font-size: 13px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px 6px 6px;
      min-height: 36px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid var(--border-strong, var(--border));
      background: var(--panel, transparent);
      color: var(--text);
      cursor: pointer;
    }
    .aph-dispatch[disabled] {
      opacity: 0.6;
      cursor: default;
    }
    .aph-dispatch:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
      outline-offset: 2px;
    }
    .aph-knob {
      position: relative;
      width: 34px;
      height: 20px;
      border-radius: 999px;
      background: var(--ok);
      flex-shrink: 0;
      transition: background var(--duration-fast, 0.15s);
    }
    .aph-knob::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 17px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--card);
      transition: left var(--duration-fast, 0.15s);
    }
    .aph-dispatch.paused .aph-knob {
      background: var(--muted);
    }
    .aph-dispatch.paused .aph-knob::after {
      left: 3px;
    }
    .aph-dispatch.paused b {
      color: var(--warn);
    }
    .aph-dispatch.running b {
      color: var(--ok);
    }
    .aph-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .aph-count b {
      color: var(--text);
      font-weight: 600;
    }
    .aph-count.running b,
    .aph-count.queued b {
      color: var(--info, var(--accent));
    }
    .aph-count.blocked b {
      color: var(--warn);
    }
    .aph-count.failed b,
    .aph-count.dead b {
      color: var(--danger);
    }
    .aph-count.done b {
      color: var(--ok);
    }
    .aph-backends {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .aph-be {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      padding: 3px 10px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid var(--border);
      background: var(--bg-muted, transparent);
      color: var(--text);
      white-space: nowrap;
      cursor: help;
    }
    .aph-be:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
    }
    .aph-be-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
    }
    .aph-be-st {
      color: var(--muted);
      font-size: 11px;
    }
    .aph-be.ok .aph-be-dot {
      background: var(--ok);
    }
    .aph-be.warn .aph-be-dot {
      background: var(--warn);
    }
    .aph-be.warn .aph-be-st {
      color: var(--warn);
    }
    .aph-metrics {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      font-size: 12px;
      color: var(--muted);
      margin-left: auto;
    }
    .aph-metrics b {
      color: var(--text);
      font-weight: 600;
    }

    /* ── Composer ── */
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
      min-width: 0;
    }
    .chev {
      width: 8px;
      height: 8px;
      flex-shrink: 0;
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
    .field.inline {
      flex-direction: row;
      align-items: center;
      gap: 8px;
      flex: 1;
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
    input.invalid {
      border-color: var(--danger);
    }
    .row2 {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
    }
    .row3 {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
    }
    .prows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .prow {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-md, 8px);
      background: var(--bg-muted, transparent);
      min-width: 0;
    }
    .prow-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .prow-n {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted-strong, var(--muted));
    }
    .prow-tools {
      display: flex;
      gap: 4px;
    }
    .checks-edit {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .check-row {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr) 32px;
      gap: 6px;
      align-items: start;
    }
    .check-inputs {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    .check-inputs input:nth-child(2) {
      max-width: 42%;
    }
    .icon-btn {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }
    .icon-btn:hover:not([disabled]) {
      color: var(--text);
      border-color: var(--accent);
    }
    .icon-btn.danger:hover:not([disabled]) {
      color: var(--danger);
      border-color: var(--danger);
    }
    .icon-btn[disabled] {
      opacity: 0.35;
      cursor: default;
    }
    details summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
    }
    .toggle {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      min-height: 36px;
      white-space: nowrap;
    }
    .toggle input {
      width: auto;
      min-height: 0;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn:hover:not([disabled]) {
      border-color: var(--accent);
    }
    .btn:focus-visible,
    .filter:focus-visible,
    .tag.sess:focus-visible {
      outline: 2px solid var(--focus, var(--accent));
      outline-offset: 1px;
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
    .btn.xs {
      padding: 2px 8px;
      min-height: 24px;
      font-size: 11.5px;
    }
    .msg {
      font-size: 12px;
      padding: 8px 10px;
      border-radius: var(--radius-md, 8px);
      overflow-wrap: anywhere;
    }
    .msg.err {
      color: var(--danger);
      background: var(--danger-subtle);
    }
    .msg.ok {
      color: var(--ok);
      background: var(--ok-subtle);
    }

    /* ── List ── */
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
      flex-wrap: wrap;
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
      max-height: 60vh;
      overflow: auto;
    }
    .entry-row {
      all: unset;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: 5px;
      width: 100%;
      padding: 10px;
      border-radius: var(--radius-md, 8px);
      border: 1px solid transparent;
      cursor: pointer;
    }
    .entry-row:hover {
      background: var(--bg-hover);
    }
    .entry-row.sel {
      border-color: var(--accent);
      background: var(--accent-subtle, var(--bg-hover));
    }
    .entry-row:focus-visible {
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
      flex: 1;
    }
    .row-age {
      font-size: 11px;
      color: var(--muted);
      flex-shrink: 0;
    }
    .row-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 12px;
      font-size: 11.5px;
      color: var(--muted);
      min-width: 0;
    }
    .row-phase,
    .row-agent {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row-phase {
      color: var(--muted-strong, var(--muted));
    }

    /* ── Chips / tags ── */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 600;
      padding: 1px 8px;
      border-radius: var(--radius-full, 999px);
      border: 1px solid currentColor;
      line-height: 1.5;
      white-space: nowrap;
    }
    .chip::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .chip.running,
    .chip.queued,
    .chip.o-run {
      color: var(--info, var(--accent));
    }
    .chip.running::before,
    .chip.o-run::before {
      animation: pulse 1.4s ease-in-out infinite;
    }
    .chip.paused,
    .chip.canceled,
    .chip.o-muted,
    .chip.v-muted {
      color: var(--muted);
    }
    .chip.done,
    .chip.o-ok,
    .chip.v-ok {
      color: var(--ok);
    }
    .chip.failed,
    .chip.dead,
    .chip.o-bad,
    .chip.v-bad {
      color: var(--danger);
    }
    .chip.blocked,
    .chip.o-warn,
    .chip.v-warn {
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
    .tag {
      font: inherit;
      font-size: 10.5px;
      line-height: 1.6;
      color: var(--muted);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-full, 999px);
      padding: 0 7px;
      white-space: nowrap;
    }
    .tag.ok,
    .tag.done {
      color: var(--ok);
      border-color: currentColor;
    }
    .tag.bad {
      color: var(--danger);
      border-color: currentColor;
    }
    .tag.warn,
    .tag.blocked {
      color: var(--warn);
      border-color: currentColor;
    }
    .tag.active {
      color: var(--info, var(--accent));
      border-color: currentColor;
    }
    .tag.warn {
      white-space: normal;
    }
    .tag.sess {
      cursor: copy;
    }
    .tag.sess:hover {
      color: var(--text);
      border-color: var(--accent);
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      padding: 16px 4px;
      line-height: 1.5;
    }

    /* ── Detail ── */
    .detail {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .detail-head {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }
    .back {
      display: none;
    }
    .title-line {
      display: flex;
      flex-wrap: wrap;
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
      min-width: 0;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      font-size: 12px;
      color: var(--muted);
      min-width: 0;
    }
    .meta .mono {
      font-size: 11px;
      overflow-wrap: anywhere;
      min-width: 0;
    }
    .banner {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12.5px;
      padding: 10px 12px;
      border-radius: var(--radius-md, 8px);
      background: var(--bg-muted, var(--bg-hover));
      border: 1px solid var(--border);
      border-left: 3px solid var(--muted);
      min-width: 0;
    }
    .banner.warn {
      border-left-color: var(--warn);
      background: var(--warn-subtle, var(--bg-muted, var(--bg-hover)));
    }
    .banner.bad {
      border-left-color: var(--danger);
      background: var(--danger-subtle, var(--bg-muted, var(--bg-hover)));
    }
    .banner.info {
      border-left-color: var(--info, var(--accent));
    }
    .banner-title {
      font-weight: 600;
      color: var(--text-strong, var(--text));
    }
    .banner.warn .banner-title {
      color: var(--warn);
    }
    .banner.bad .banner-title {
      color: var(--danger);
    }
    .banner-text {
      overflow-wrap: anywhere;
    }
    .banner-fix {
      display: flex;
      gap: 8px;
      align-items: baseline;
      overflow-wrap: anywhere;
      line-height: 1.5;
      min-width: 0;
    }
    .banner-fix .lbl {
      flex-shrink: 0;
      text-transform: uppercase;
      font-size: 10.5px;
      letter-spacing: 0.06em;
    }
    .banner-err,
    .att-err {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 11.5px;
      line-height: 1.45;
      max-height: 160px;
      overflow: auto;
      padding: 8px;
      border-radius: 6px;
      background: var(--bg, transparent);
      border: 1px solid var(--border);
      color: var(--text);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .prio {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .prio .btn.sm {
      padding: 4px 8px;
      min-height: 36px;
      align-self: auto;
    }
    .prio-n {
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
      min-width: 28px;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .retry {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      background: var(--bg-muted, transparent);
    }
    .retry-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
    }
    .retry-row select,
    .retry-row input {
      min-width: 0;
      width: 100%;
    }
    .retry-row .field.inline {
      flex: 1 1 160px;
    }
    .brief pre,
    .gate-res pre,
    .logs pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 11.5px;
      line-height: 1.5;
      background: var(--bg-muted, var(--bg));
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 8px);
      padding: 10px;
      margin: 6px 0 0;
      max-height: 280px;
      overflow: auto;
    }
    pre.log {
      max-height: 360px;
      margin: 0;
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

    /* ── Phase timeline ── */
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    .ph {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
    }
    .ph-rail {
      position: relative;
      display: flex;
      justify-content: center;
    }
    .ph-rail::after {
      content: "";
      position: absolute;
      top: 26px;
      bottom: 0;
      width: 2px;
      background: var(--border);
    }
    .ph:last-child .ph-rail::after {
      display: none;
    }
    .ph.done .ph-rail::after {
      background: var(--ok);
      opacity: 0.5;
    }
    .ph-dot {
      position: relative;
      z-index: 1;
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 600;
      border: 2px solid var(--border-strong, var(--border));
      background: var(--card);
      color: var(--muted);
    }
    .ph.done .ph-dot {
      background: var(--ok);
      border-color: var(--ok);
      color: var(--card);
    }
    .ph.active .ph-dot {
      border-color: var(--info, var(--accent));
      color: var(--info, var(--accent));
      box-shadow: 0 0 0 4px var(--accent-subtle, transparent);
    }
    .ph.blocked .ph-dot {
      border-color: var(--warn);
      color: var(--warn);
    }
    .ph-body {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      padding-bottom: 16px;
    }
    .ph.pending .ph-body,
    .ph.skipped .ph-body {
      opacity: 0.7;
    }
    .ph-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      min-height: 24px;
      min-width: 0;
    }
    .ph-name {
      font-weight: 600;
      font-size: 13.5px;
      color: var(--text-strong, var(--text));
      overflow-wrap: anywhere;
    }
    .ph-spec {
      font-size: 11.5px;
      color: var(--muted);
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .ph-brief {
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
      line-height: 1.45;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .ph-gates {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      min-width: 0;
    }
    .gate-spec {
      font-size: 11px;
      color: var(--muted-strong, var(--muted));
      background: var(--bg-muted, transparent);
      border: 1px dashed var(--border);
      border-radius: 6px;
      padding: 1px 6px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .attempts {
      list-style: none;
      margin: 2px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .att {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border: 1px solid var(--border);
      border-left: 3px solid var(--muted);
      border-radius: var(--radius-md, 8px);
      padding: 8px 10px;
      min-width: 0;
      background: var(--card);
    }
    .att.ok {
      border-left-color: var(--ok);
    }
    .att.run {
      border-left-color: var(--info, var(--accent));
    }
    .att.warn {
      border-left-color: var(--warn);
    }
    .att.bad {
      border-left-color: var(--danger);
    }
    .att-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 8px;
      min-width: 0;
    }
    .att-n {
      font-weight: 600;
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
    }
    .att-who {
      font-size: 12.5px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .att-who .mono {
      font-size: 11.5px;
    }
    .att-dur {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .att-tags {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 6px;
    }
    .logs-btn {
      margin-left: auto;
    }
    .reasons {
      margin: 0;
      padding-left: 18px;
      font-size: 12px;
      color: var(--muted-strong, var(--muted));
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .gate-res {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .gate-res summary {
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
      min-width: 0;
      padding: 2px 0;
      color: var(--text);
    }
    .gate-res summary::-webkit-details-marker {
      display: none;
    }
    .gate-res summary::after {
      content: "output";
      margin-left: auto;
      flex-shrink: 0;
      font-size: 10.5px;
      color: var(--muted);
    }
    .gate-res details[open] summary::after {
      content: "hide";
    }
    .gr-state {
      font-size: 11px;
      font-weight: 600;
      flex-shrink: 0;
      width: 26px;
    }
    .pass .gr-state {
      color: var(--ok);
    }
    .fail .gr-state {
      color: var(--danger);
    }
    .gr-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
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
    .logs {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .attach {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 8px;
      font-size: 12px;
      min-width: 0;
    }
    .attach code {
      font-size: 11px;
      background: var(--bg-muted, var(--bg));
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 6px;
      overflow-wrap: anywhere;
      min-width: 0;
      user-select: all;
    }

    /* ── Events ── */
    .events summary {
      font-size: 12px;
    }
    .ev-list {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 280px;
      overflow: auto;
      font-size: 12px;
    }
    .ev-list li {
      display: grid;
      grid-template-columns: 76px minmax(110px, 180px) minmax(0, 1fr);
      gap: 8px;
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
      min-width: 0;
    }
    .ev-list time {
      color: var(--muted);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .ev-kind {
      color: var(--muted-strong, var(--muted));
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .ev-msg {
      overflow-wrap: anywhere;
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
      .aph {
        grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
      }
      .aph-metrics {
        margin-left: 0;
      }
    }
    @media (max-width: 900px) {
      .aph {
        grid-template-columns: minmax(0, 1fr);
      }
      .aph.has-detail .col-left {
        display: none;
      }
      .aph:not(.has-detail) .col-right {
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
      .aph-head {
        padding: 10px 12px;
      }
      .row2 {
        grid-template-columns: minmax(0, 1fr);
      }
      .row3 {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
      .row3 .span-sm {
        grid-column: 1 / -1;
      }
      .check-row {
        grid-template-columns: minmax(0, 1fr) 32px;
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
      .ph {
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 8px;
      }
      .ph-dot {
        width: 22px;
        height: 22px;
      }
      .ev-list li {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .ev-msg {
        grid-column: 1 / -1;
      }
      .att-dur {
        margin-left: 0;
      }
    }
  `;
}

function statusChip(s: QueueStatus): TemplateResult {
  return html`<span class="chip ${s}">${STATUS_LABEL[s] ?? s}</span>`;
}

const xIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
const upIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>`;
const downIcon = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
const checkIcon = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

declare global {
  interface HTMLElementTagNameMap {
    "autonomy-phases-view": AutonomyPhasesView;
  }
}
