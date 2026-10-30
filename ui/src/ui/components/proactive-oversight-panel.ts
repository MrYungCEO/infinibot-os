/**
 * <proactive-oversight-panel> — Settings panel for the default "Proactive
 * Oversight" cron jobs (seeded by src/cron/oversight-jobs.ts).
 *
 * Self-contained LitElement so it can be dropped into any view (it's mounted on
 * the /oversight page) without entangling the host module's state. It reuses the
 * existing cron management RPCs verbatim — no new backend surface:
 *
 *   cron.list({ includeDisabled: true })  → { jobs: CronJob[] }
 *   cron.update({ id, patch: { enabled } })
 *   cron.run({ id, mode: "force" })
 *
 * Rows are the jobs whose `category` starts with "oversight:", grouped by the
 * category suffix (daily / weekly / monthly / continuous). Each row shows a
 * toggle, last-run, next-run, and a "Run now" button.
 */

import { LitElement, html, css, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";

type CronJobWire = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  category?: string;
  defaultEnabled?: boolean;
  schedule: { kind: string; expr?: string; everyMs?: number };
  state?: { lastRunAtMs?: number; nextRunAtMs?: number; lastStatus?: string };
};

const GROUP_ORDER = ["daily", "weekly", "monthly", "continuous"] as const;
const GROUP_LABEL: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  continuous: "Continuous",
};

/** Group an oversight job: prefer its category suffix, else infer from schedule. */
function groupOf(j: CronJobWire): string {
  const cat = (j.category ?? "").split(":")[1];
  if (cat) return cat;
  const s = j.schedule;
  if (s.kind === "every") return "continuous";
  if (s.kind === "cron" && s.expr) {
    const parts = s.expr.trim().split(/\s+/);
    const dom = parts[2] ?? "*";
    const dow = parts[4] ?? "*";
    if (dom !== "*") return "monthly";
    if (dow !== "*") return "weekly";
    return "daily";
  }
  return "other";
}

function fmtSchedule(s: CronJobWire["schedule"]): string {
  if (s.kind === "cron" && s.expr) return s.expr;
  if (s.kind === "every" && s.everyMs) {
    const m = Math.round(s.everyMs / 60000);
    return m >= 60 ? `every ${Math.round(m / 60)}h` : `every ${m}m`;
  }
  return s.kind;
}

function fmtWhen(ts?: number): string {
  if (!ts) return "—";
  const d = ts - Date.now();
  const abs = Math.abs(d);
  const mins = Math.round(abs / 60000);
  const txt = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return d < 0 ? `${txt} ago` : `in ${txt}`;
}

@customElement("proactive-oversight-panel")
export class ProactiveOversightPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private jobs: CronJobWire[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private open = false;
  @state() private busy = new Set<string>();

  static styles = css`
    :host {
      display: block;
      font-family: "JetBrains Mono", "SF Mono", "Consolas", monospace;
      color: var(--g-fg, #e4e4e7);
      --gold: var(--g-primary, #d4af37);
      --muted: var(--g-fg-dim, #8a8a93);
      --surface: var(--g-surface, rgba(255, 255, 255, 0.04));
      --border: color-mix(in srgb, var(--gold) 25%, transparent);
      margin: 0 0 14px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      overflow: hidden;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 11px 14px;
      cursor: pointer;
      user-select: none;
    }
    .head h3 {
      margin: 0;
      font-size: 12.5px;
      letter-spacing: 0.5px;
      color: var(--gold);
      flex: 1;
    }
    .count {
      font-size: 11px;
      color: var(--muted);
    }
    .chev {
      transition: transform 0.15s;
      color: var(--muted);
    }
    .chev.open {
      transform: rotate(90deg);
    }
    .group-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--muted);
      padding: 10px 14px 4px;
    }
    .row {
      display: grid;
      grid-template-columns: 34px 1fr auto auto;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-top: 1px solid color-mix(in srgb, var(--gold) 10%, transparent);
    }
    .name {
      font-size: 12px;
      font-weight: 600;
      color: var(--g-fg, #fff);
    }
    .desc {
      font-size: 10.5px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .meta {
      font-size: 10px;
      color: var(--muted);
      text-align: right;
      white-space: nowrap;
    }
    .meta .sched {
      color: var(--gold);
    }
    .btn {
      font: inherit;
      font-size: 10.5px;
      padding: 4px 9px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--g-fg, #e4e4e7);
      cursor: pointer;
    }
    .btn:hover {
      background: color-mix(in srgb, var(--gold) 12%, transparent);
    }
    .btn[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    /* Toggle */
    .toggle {
      width: 30px;
      height: 17px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.12);
      border: none;
      position: relative;
      cursor: pointer;
      transition: background 0.15s;
    }
    .toggle.on {
      background: color-mix(in srgb, var(--gold) 75%, transparent);
    }
    .toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #fff;
      transition: transform 0.15s;
    }
    .toggle.on::after {
      transform: translateX(13px);
    }
    .err {
      padding: 10px 14px;
      color: #ef4444;
      font-size: 11px;
    }
    .empty {
      padding: 12px 14px;
      color: var(--muted);
      font-size: 11px;
    }
  `;

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && this.jobs.length === 0) void this.refresh();
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.client) throw new Error("no gateway client");
    return (await (this.client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }).request(
      method,
      params,
    )) as T;
  }

  private async refresh(): Promise<void> {
    if (!this.client) return;
    this.loading = true;
    this.error = null;
    try {
      const res = await this.rpc<{ jobs?: CronJobWire[] }>("cron.list", { includeDisabled: true });
      const all = Array.isArray(res?.jobs) ? res.jobs : [];
      // Match by category (post-migration) OR name prefix (resilient before the
      // category field is persisted), so the panel populates either way.
      this.jobs = all.filter(
        (j) => (j.category ?? "").startsWith("oversight:") || (j.name ?? "").startsWith("oversight-"),
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private async toggle(job: CronJobWire): Promise<void> {
    if (this.busy.has(job.id)) return;
    this.busy = new Set(this.busy).add(job.id);
    const next = !job.enabled;
    // optimistic
    this.jobs = this.jobs.map((j) => (j.id === job.id ? { ...j, enabled: next } : j));
    try {
      await this.rpc("cron.update", { id: job.id, patch: { enabled: next } });
      await this.refresh();
    } catch (e) {
      this.jobs = this.jobs.map((j) => (j.id === job.id ? { ...j, enabled: !next } : j));
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      const b = new Set(this.busy);
      b.delete(job.id);
      this.busy = b;
    }
  }

  private async runNow(job: CronJobWire): Promise<void> {
    if (this.busy.has(job.id)) return;
    this.busy = new Set(this.busy).add(job.id);
    try {
      await this.rpc("cron.run", { id: job.id, mode: "force" });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      const b = new Set(this.busy);
      b.delete(job.id);
      this.busy = b;
    }
  }

  private renderRow(job: CronJobWire): TemplateResult {
    const busy = this.busy.has(job.id);
    return html`
      <div class="row">
        <button
          class="toggle ${job.enabled ? "on" : ""}"
          ?disabled=${busy}
          title=${job.enabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          aria-pressed=${job.enabled}
          @click=${() => void this.toggle(job)}
        ></button>
        <div>
          <div class="name">${job.name.replace(/^oversight-/, "")}</div>
          <div class="desc" title=${job.description ?? ""}>${job.description ?? ""}</div>
        </div>
        <div class="meta">
          <div class="sched">${fmtSchedule(job.schedule)}</div>
          <div>last ${fmtWhen(job.state?.lastRunAtMs)} · next ${job.enabled ? fmtWhen(job.state?.nextRunAtMs) : "—"}</div>
        </div>
        <button class="btn" ?disabled=${busy} @click=${() => void this.runNow(job)}>
          ${busy ? "…" : "Run now"}
        </button>
      </div>
    `;
  }

  render(): TemplateResult {
    const byGroup = new Map<string, CronJobWire[]>();
    for (const j of this.jobs) {
      const g = groupOf(j);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(j);
    }
    const enabledCount = this.jobs.filter((j) => j.enabled).length;
    return html`
      <div class="panel">
        <div class="head" @click=${() => (this.open = !this.open)}>
          <span class="chev ${this.open ? "open" : ""}">▶</span>
          <h3>Proactive Oversight</h3>
          <span class="count">
            ${this.loading ? "loading…" : `${enabledCount}/${this.jobs.length} active`}
          </span>
        </div>
        ${this.open
          ? html`
              ${this.error ? html`<div class="err">${this.error}</div>` : nothing}
              ${this.jobs.length === 0 && !this.loading
                ? html`<div class="empty">No oversight jobs seeded yet (they seed on the next gateway start).</div>`
                : [
                    ...GROUP_ORDER.filter((g) => byGroup.has(g)),
                    ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g as never)),
                  ].map(
                    (g) => html`
                      <div class="group-label">${GROUP_LABEL[g] ?? g}</div>
                      ${byGroup.get(g)!.map((j) => this.renderRow(j))}
                    `,
                  )}
            `
          : nothing}
      </div>
    `;
  }
}
