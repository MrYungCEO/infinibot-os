/**
 * <agent-cron-manager agentId="..."> — per-agent cron job CRUD panel.
 *
 * Reads/writes cron jobs via the existing gateway WS-RPC surface:
 *   cron.list / cron.add / cron.update / cron.remove / cron.run
 *
 * Jobs are standard CronJob entries with agentId set to the bound agent.
 * Schedule supports two modes:
 *   - interval: "every N minutes/hours/days" → kind:"every"
 *   - cron:     raw cron expression          → kind:"cron"
 * Payload is always kind:"agentTurn" targeting an isolated session so the
 * job runs as that agent without polluting the main chat.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { awaitGatewayClient, gatewayCall } from "../gateway-client.js";

// ── minimal local types (mirrors src/cron/types.ts) ─────────────────────────

type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
}

interface CronJob {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "next-heartbeat" | "now";
  payload: { kind: "systemEvent"; text: string } | { kind: "agentTurn"; message: string; model?: string; deliver?: boolean };
  state: CronJobState;
}

// ── smart defaults per agent ─────────────────────────────────────────────────

const AGENT_DEFAULT_CRONS: Record<string, Array<{ name: string; scheduleExpr: string; task: string }>> = {
  main: [
    {
      name: "Hourly insights sweep",
      scheduleExpr: "0 * * * *",
      task: "Review all agent run outputs from the past hour. Surface the top 3 insights or blockers to Telegram.",
    },
  ],
  cmo: [
    {
      name: "Daily content opportunities",
      scheduleExpr: "0 8 * * *",
      task: "Pull content performance metrics from the past 24h. Draft 3 content opportunities for review and post summary to Telegram.",
    },
  ],
  ledger: [
    {
      name: "Daily revenue reconciliation",
      scheduleExpr: "0 7 * * *",
      task: "Reconcile revenue events from the past 24 hours. Flag any anomalies and post summary to Telegram.",
    },
  ],
  monitor: [
    {
      name: "Session health check",
      scheduleExpr: "*/30 * * * *",
      task: "Health-check all agent sessions. Alert main if any session has been stalled for more than 15 minutes.",
    },
  ],
  scout: [
    {
      name: "Daily market research",
      scheduleExpr: "0 9 * * *",
      task: "Research 3 market trends relevant to the current client pipeline. Post findings to Telegram.",
    },
  ],
  outreach: [
    {
      name: "Lead pipeline review",
      scheduleExpr: "0 10 * * *",
      task: "Review the lead pipeline. Identify the top 5 warm leads to action today and post the list to Telegram.",
    },
  ],
};

// ── helpers ──────────────────────────────────────────────────────────────────

function humanSchedule(s: CronSchedule): string {
  if (s.kind === "cron") return s.expr;
  if (s.kind === "every") {
    const ms = s.everyMs;
    if (ms < 60_000) return `Every ${ms / 1000}s`;
    if (ms < 3_600_000) return `Every ${ms / 60_000} min`;
    if (ms < 86_400_000) return `Every ${ms / 3_600_000} hr`;
    return `Every ${ms / 86_400_000} day(s)`;
  }
  return `Once at ${new Date(s.atMs).toLocaleString()}`;
}

function humanRelative(ms?: number): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (Math.abs(diff) < 5_000) return "now";
  const abs = Math.abs(diff);
  const label = diff < 0 ? "ago" : "in";
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${label}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${label}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${label}`;
  return `${Math.round(abs / 86_400_000)}d ${label}`;
}

type ScheduleMode = "interval" | "cron";

interface FormState {
  name: string;
  scheduleMode: ScheduleMode;
  intervalValue: string;
  intervalUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  task: string;
  enabled: boolean;
}

function emptyForm(): FormState {
  return {
    name: "",
    scheduleMode: "cron",
    intervalValue: "60",
    intervalUnit: "minutes",
    cronExpr: "0 * * * *",
    task: "",
    enabled: true,
  };
}

function formToSchedule(f: FormState): CronSchedule {
  if (f.scheduleMode === "interval") {
    const units: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
    const everyMs = (parseFloat(f.intervalValue) || 60) * (units[f.intervalUnit] ?? 60_000);
    return { kind: "every", everyMs };
  }
  return { kind: "cron", expr: f.cronExpr.trim() || "0 * * * *" };
}

// ── LitElement ───────────────────────────────────────────────────────────────

@customElement("agent-cron-manager")
export class AgentCronManager extends LitElement {
  @property({ type: String }) agentId = "";

  @state() private crons: CronJob[] = [];
  @state() private loading = false;
  @state() private error = "";
  @state() private showForm = false;
  @state() private form: FormState = emptyForm();
  @state() private submitting = false;
  @state() private runningIds = new Set<string>();
  @state() private togglingIds = new Set<string>();
  @state() private deletingIds = new Set<string>();
  @state() private seeding = false;

  static styles = css`
    :host {
      display: block;
      padding: 16px;
      font-family: var(--g-font-mono, "JetBrains Mono", monospace);
      font-size: 13px;
      color: var(--g-fg, #e4e4e7);
    }

    /* ── toolbar ── */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 14px;
    }
    .toolbar-title {
      flex: 1;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary) 80%, transparent);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      color: var(--g-primary);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:hover {
      background: color-mix(in srgb, var(--g-primary) 18%, transparent);
    }
    .btn:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .btn-danger {
      border-color: rgba(239,68,68,0.3);
      background: rgba(239,68,68,0.08);
      color: #ef4444;
    }
    .btn-danger:hover {
      background: rgba(239,68,68,0.18);
    }
    .btn-sm {
      padding: 4px 8px;
      font-size: 10px;
    }

    /* ── empty state ── */
    .empty {
      padding: 32px 20px;
      text-align: center;
      color: rgba(228,228,231,0.45);
      border: 1px dashed color-mix(in srgb, var(--g-primary) 15%, transparent);
      border-radius: 8px;
    }
    .empty p { margin: 6px 0; }
    .empty .hint { font-size: 11px; opacity: 0.6; }

    /* ── cron list ── */
    .cron-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .cron-card {
      border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
      border-radius: 8px;
      background: linear-gradient(155deg, rgba(15,15,22,0.62) 0%, rgba(7,7,12,0.78) 100%);
      overflow: hidden;
    }
    .cron-card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
    }
    .cron-name {
      flex: 1;
      font-weight: 600;
      font-size: 12px;
      color: var(--g-fg, #e4e4e7);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cron-schedule {
      font-size: 10px;
      font-family: monospace;
      color: var(--g-primary);
      padding: 2px 6px;
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      border-radius: 4px;
      white-space: nowrap;
    }
    .cron-meta {
      padding: 0 12px 10px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 16px;
      font-size: 10px;
      color: rgba(228,228,231,0.5);
    }
    .cron-meta .meta-label { opacity: 0.6; }
    .cron-status-ok    { color: #22c55e; }
    .cron-status-error { color: #ef4444; }
    .cron-task {
      padding: 0 12px 10px;
      font-size: 10px;
      color: rgba(228,228,231,0.55);
      line-height: 1.45;
      white-space: pre-wrap;
      max-height: 60px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cron-actions {
      display: flex;
      gap: 6px;
      padding: 0 12px 10px;
    }

    /* ── toggle switch ── */
    .toggle {
      position: relative;
      width: 32px;
      height: 18px;
      flex-shrink: 0;
    }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-track {
      position: absolute; inset: 0;
      border-radius: 9px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.1);
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
    }
    .toggle input:checked + .toggle-track {
      background: color-mix(in srgb, var(--g-primary) 35%, transparent);
      border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
    }
    .toggle-thumb {
      position: absolute;
      top: 2px; left: 2px;
      width: 12px; height: 12px;
      border-radius: 50%;
      background: rgba(255,255,255,0.35);
      transition: transform 0.2s, background 0.2s;
      pointer-events: none;
    }
    .toggle input:checked ~ .toggle-thumb {
      transform: translateX(14px);
      background: var(--g-primary);
    }

    /* ── inline add form ── */
    .form-card {
      border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
      border-radius: 8px;
      background: linear-gradient(155deg, rgba(20,20,28,0.8) 0%, rgba(10,10,16,0.9) 100%);
      padding: 16px;
      margin-bottom: 12px;
    }
    .form-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--g-primary);
      margin-bottom: 14px;
    }
    .form-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }
    .form-row label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: rgba(228,228,231,0.55);
    }
    .form-input, .form-select, .form-textarea {
      background: rgba(5,5,10,0.55);
      border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
      border-radius: 5px;
      color: var(--g-fg, #e4e4e7);
      font-family: inherit;
      font-size: 12px;
      padding: 7px 10px;
      width: 100%;
      box-sizing: border-box;
      transition: border-color 0.15s;
    }
    .form-input:focus, .form-select:focus, .form-textarea:focus {
      outline: none;
      border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
    }
    .form-select option { background: #0e0e14; color: #e4e4e7; }
    .form-textarea { resize: vertical; min-height: 72px; }
    .form-schedule-row {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }
    .form-schedule-row .form-input { flex: 1; }
    .schedule-preview {
      font-size: 10px;
      color: color-mix(in srgb, var(--g-primary) 70%, transparent);
      margin-top: 4px;
    }
    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }

    .error-msg {
      color: #ef4444;
      font-size: 11px;
      margin-bottom: 10px;
      padding: 6px 10px;
      background: rgba(239,68,68,0.1);
      border-radius: 5px;
      border: 1px solid rgba(239,68,68,0.2);
    }

    .spinner {
      display: inline-block;
      width: 10px; height: 10px;
      border: 1.5px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
      border-top-color: var(--g-primary);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  override connectedCallback() {
    super.connectedCallback();
    void this._load();
  }

  private async _load() {
    this.loading = true;
    this.error = "";
    try {
      const res = (await gatewayCall("cron.list", { includeDisabled: true })) as { jobs?: CronJob[] };
      const all: CronJob[] = res?.jobs ?? [];
      this.crons = all.filter((j) => j.agentId === this.agentId);
    } catch (err) {
      this.error = String(err);
    } finally {
      this.loading = false;
    }
  }

  private async _seedDefaults() {
    const defaults = AGENT_DEFAULT_CRONS[this.agentId];
    if (!defaults?.length) return;
    this.seeding = true;
    try {
      for (const d of defaults) {
        await gatewayCall("cron.add", {
          name: d.name,
          agentId: this.agentId,
          enabled: true,
          schedule: { kind: "cron", expr: d.scheduleExpr },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: d.task },
        });
      }
      await this._load();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.seeding = false;
    }
  }

  private async _toggle(job: CronJob) {
    this.togglingIds = new Set([...this.togglingIds, job.id]);
    try {
      await gatewayCall("cron.update", {
        id: job.id,
        patch: { enabled: !job.enabled },
      });
      await this._load();
    } catch (err) {
      this.error = String(err);
    } finally {
      const s = new Set(this.togglingIds);
      s.delete(job.id);
      this.togglingIds = s;
    }
  }

  private async _run(job: CronJob) {
    this.runningIds = new Set([...this.runningIds, job.id]);
    try {
      await gatewayCall("cron.run", { id: job.id, mode: "force" });
      await this._load();
    } catch (err) {
      this.error = String(err);
    } finally {
      const s = new Set(this.runningIds);
      s.delete(job.id);
      this.runningIds = s;
    }
  }

  private async _delete(job: CronJob) {
    this.deletingIds = new Set([...this.deletingIds, job.id]);
    try {
      await gatewayCall("cron.remove", { id: job.id });
      await this._load();
    } catch (err) {
      this.error = String(err);
    } finally {
      const s = new Set(this.deletingIds);
      s.delete(job.id);
      this.deletingIds = s;
    }
  }

  private async _submit() {
    if (!this.form.name.trim() || !this.form.task.trim()) return;
    this.submitting = true;
    this.error = "";
    try {
      await gatewayCall("cron.add", {
        name: this.form.name.trim(),
        agentId: this.agentId,
        enabled: this.form.enabled,
        schedule: formToSchedule(this.form),
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: this.form.task.trim() },
      });
      this.showForm = false;
      this.form = emptyForm();
      await this._load();
    } catch (err) {
      this.error = String(err);
    } finally {
      this.submitting = false;
    }
  }

  private _updateForm(patch: Partial<FormState>) {
    this.form = { ...this.form, ...patch };
  }

  private _renderForm() {
    const f = this.form;
    const previewSchedule = formToSchedule(f);
    return html`
      <div class="form-card">
        <div class="form-title">New cron job</div>

        <div class="form-row">
          <label>Name</label>
          <input
            class="form-input"
            .value=${f.name}
            placeholder="e.g. Daily brief"
            @input=${(e: Event) => this._updateForm({ name: (e.target as HTMLInputElement).value })}
          />
        </div>

        <div class="form-row">
          <label>Schedule type</label>
          <select
            class="form-select"
            .value=${f.scheduleMode}
            @change=${(e: Event) => this._updateForm({ scheduleMode: (e.target as HTMLSelectElement).value as ScheduleMode })}
          >
            <option value="cron">Cron expression</option>
            <option value="interval">Simple interval</option>
          </select>
        </div>

        ${f.scheduleMode === "interval" ? html`
          <div class="form-row">
            <label>Interval</label>
            <div class="form-schedule-row">
              <input
                class="form-input"
                type="number"
                min="1"
                .value=${f.intervalValue}
                @input=${(e: Event) => this._updateForm({ intervalValue: (e.target as HTMLInputElement).value })}
              />
              <select
                class="form-select"
                style="width: 110px; flex-shrink: 0;"
                .value=${f.intervalUnit}
                @change=${(e: Event) => this._updateForm({ intervalUnit: (e.target as HTMLSelectElement).value as FormState["intervalUnit"] })}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
            <div class="schedule-preview">${humanSchedule(previewSchedule)}</div>
          </div>
        ` : html`
          <div class="form-row">
            <label>Cron expression</label>
            <input
              class="form-input"
              placeholder="0 * * * *"
              .value=${f.cronExpr}
              @input=${(e: Event) => this._updateForm({ cronExpr: (e.target as HTMLInputElement).value })}
            />
            <div class="schedule-preview">${humanSchedule(previewSchedule)}</div>
          </div>
        `}

        <div class="form-row">
          <label>Task prompt</label>
          <textarea
            class="form-textarea"
            placeholder="What should this agent do when the job fires?"
            .value=${f.task}
            @input=${(e: Event) => this._updateForm({ task: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
        </div>

        <div class="form-actions">
          <button class="btn" ?disabled=${this.submitting} @click=${() => void this._submit()}>
            ${this.submitting ? html`<span class="spinner"></span>` : nothing}
            Save
          </button>
          <button class="btn btn-danger" @click=${() => { this.showForm = false; this.form = emptyForm(); }}>
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  private _renderJob(job: CronJob) {
    const isRunning = this.runningIds.has(job.id);
    const isToggling = this.togglingIds.has(job.id);
    const isDeleting = this.deletingIds.has(job.id);
    const task = job.payload.kind === "agentTurn" ? job.payload.message
      : job.payload.kind === "systemEvent" ? job.payload.text : "";

    return html`
      <div class="cron-card">
        <div class="cron-card-header">
          <!-- toggle -->
          <label class="toggle" title="${job.enabled ? "Disable" : "Enable"}">
            <input
              type="checkbox"
              ?checked=${job.enabled}
              ?disabled=${isToggling}
              @change=${() => void this._toggle(job)}
            />
            <span class="toggle-track"></span>
            <span class="toggle-thumb"></span>
          </label>

          <span class="cron-name">${job.name}</span>
          <span class="cron-schedule">${humanSchedule(job.schedule)}</span>
        </div>

        <div class="cron-meta">
          <span class="meta-label">Last run</span>
          <span class="${job.state.lastStatus === "ok" ? "cron-status-ok" : job.state.lastStatus === "error" ? "cron-status-error" : ""}">
            ${job.state.lastRunAtMs ? humanRelative(job.state.lastRunAtMs) : "never"}
            ${job.state.lastStatus ? ` · ${job.state.lastStatus}` : ""}
          </span>

          <span class="meta-label">Next run</span>
          <span>${job.enabled ? humanRelative(job.state.nextRunAtMs) : "disabled"}</span>
        </div>

        ${task ? html`<div class="cron-task">${task}</div>` : nothing}

        <div class="cron-actions">
          <button
            class="btn btn-sm"
            ?disabled=${isRunning}
            @click=${() => void this._run(job)}
            title="Run now"
          >
            ${isRunning ? html`<span class="spinner"></span>` : "▶"}
            Run now
          </button>
          <button
            class="btn btn-sm btn-danger"
            ?disabled=${isDeleting}
            @click=${() => void this._delete(job)}
            title="Delete"
          >
            ${isDeleting ? html`<span class="spinner"></span>` : "✕"}
          </button>
        </div>
      </div>
    `;
  }

  override render() {
    const hasDefaults = !!AGENT_DEFAULT_CRONS[this.agentId]?.length;

    return html`
      <div class="toolbar">
        <span class="toolbar-title">Scheduled jobs · ${this.agentId}</span>
        <button class="btn btn-sm" @click=${() => void this._load()} title="Refresh">
          ↻
        </button>
        <button class="btn btn-sm" @click=${() => { this.showForm = !this.showForm; }}>
          ${this.showForm ? "✕ Cancel" : "+ Add cron"}
        </button>
      </div>

      ${this.error ? html`<div class="error-msg">${this.error}</div>` : nothing}

      ${this.showForm ? this._renderForm() : nothing}

      ${this.loading ? html`
        <div style="text-align:center; padding: 24px; color: rgba(228,228,231,0.4);">
          <span class="spinner"></span> Loading…
        </div>
      ` : this.crons.length === 0 ? html`
        <div class="empty">
          <p>No cron jobs yet for this agent.</p>
          ${hasDefaults ? html`
            <p class="hint">Seed default jobs for <strong>${this.agentId}</strong>?</p>
            <button class="btn" style="margin-top: 10px;" ?disabled=${this.seeding} @click=${() => void this._seedDefaults()}>
              ${this.seeding ? html`<span class="spinner"></span>` : nothing}
              Seed defaults
            </button>
          ` : nothing}
        </div>
      ` : html`
        <div class="cron-list">
          ${this.crons.map((j) => this._renderJob(j))}
        </div>
      `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-cron-manager": AgentCronManager;
  }
}
