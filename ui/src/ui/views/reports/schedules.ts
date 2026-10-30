/**
 * Reports → Schedules sub-tab.
 *
 * Table of cron entries with enable toggle, inline cron edit, theme picker and
 * sinks multi-select. Edits are inline with an explicit Save; deletes get a
 * confirm step.
 *
 * RPCs (verbatim):
 *   reports.schedules.list()                       → { schedules: [...] } | [...]
 *   reports.schedules.upsert({ ...ScheduleRecord }) → { ok, schedule }
 *   reports.schedules.delete({ id })               → { ok }
 */

import { html, nothing, type TemplateResult } from "lit";
import { glassEmpty, glassSkeletonRows } from "../glass-agents-shared";
import type { GatewayBrowserClient } from "../../gateway";
import {
  REPORT_KINDS,
  REPORT_THEMES,
  ALL_SINKS,
  rpc,
  type ReportKindDef,
} from "./index";

export type ScheduleRecord = {
  id: string;
  kind: string;
  cron: string;
  theme: string;
  enabled: boolean;
  sinks: string[];
  last_run_at?: number | null;
  next_run_at?: number | null;
  config_json?: string | null;
};

let _schedules: ScheduleRecord[] = [];
let _loading = false;
let _error: string | null = null;
let _loaded = false;
let _client: GatewayBrowserClient | null = null;
let _ru: (() => void) | null = null;

// id → working copy while editing (null = not editing)
const _drafts = new Map<string, ScheduleRecord>();
const _confirmDelete = new Set<string>();
const _busy = new Set<string>();

function newDraft(): ScheduleRecord {
  return {
    id: `new-${_schedules.length + 1}-${_drafts.size + 1}`,
    kind: REPORT_KINDS[1]?.id ?? "ceo_hourly_insights",
    cron: "5 * * * *",
    theme: REPORT_THEMES[0]?.id ?? "black-gold",
    enabled: true,
    sinks: ["ui", "telegram"],
  };
}

/** The gateway speaks camelCase (`nextRunAt` / `lastRunAt`); accept both. */
function fromWire(s: ScheduleRecord & { nextRunAt?: number | null; lastRunAt?: number | null }): ScheduleRecord {
  return { ...s, next_run_at: s.next_run_at ?? s.nextRunAt ?? null, last_run_at: s.last_run_at ?? s.lastRunAt ?? null };
}

export async function loadSchedules(client: GatewayBrowserClient, ru: () => void): Promise<void> {
  _client = client;
  _ru = ru;
  if (_loading) return;
  _loading = true;
  _error = null;
  ru();
  try {
    const res = await rpc(client, "reports.schedules.list", {});
    _schedules = extractList<ScheduleRecord>(res, "schedules").map(fromWire);
    _error = null;
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _schedules = [];
  } finally {
    _loading = false;
    _loaded = true;
    ru();
  }
}

function extractList<T>(res: unknown, key: string): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as any)[key])) return (res as any)[key] as T[];
  return [];
}

async function saveDraft(id: string): Promise<void> {
  const draft = _drafts.get(id);
  if (!draft || !_client) return;
  _busy.add(id);
  _ru?.();
  try {
    const res = await rpc(_client, "reports.schedules.upsert", { ...draft });
    const saved = (res && typeof res === "object" && (res as any).schedule) ? fromWire((res as any).schedule as ScheduleRecord) : draft;
    const existing = _schedules.findIndex((s) => s.id === id);
    if (existing >= 0) _schedules[existing] = saved;
    else _schedules = [saved, ..._schedules];
    _drafts.delete(id);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busy.delete(id);
    _ru?.();
  }
}

async function toggleEnabled(s: ScheduleRecord): Promise<void> {
  if (!_client) return;
  const next = { ...s, enabled: !s.enabled };
  const idx = _schedules.findIndex((x) => x.id === s.id);
  if (idx >= 0) _schedules[idx] = next; // optimistic
  _ru?.();
  try {
    await rpc(_client, "reports.schedules.upsert", { ...next });
  } catch (e) {
    if (idx >= 0) _schedules[idx] = s; // revert
    _error = e instanceof Error ? e.message : String(e);
    _ru?.();
  }
}

async function doDelete(id: string): Promise<void> {
  if (!_client) return;
  _busy.add(id);
  _ru?.();
  try {
    await rpc(_client, "reports.schedules.delete", { id });
    _schedules = _schedules.filter((s) => s.id !== id);
    _confirmDelete.delete(id);
    _drafts.delete(id);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busy.delete(id);
    _ru?.();
  }
}

const ICO_CLOCK = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;

/** Option list that always contains the record's current value, so editing a
 *  row whose value isn't in the static list doesn't show (and imply) a
 *  different selection. */
function withCurrent(list: Array<{ id: string; label: string }>, current: string): Array<{ id: string; label: string }> {
  return !current || list.some((o) => o.id === current) ? list : [...list, { id: current, label: current.replace(/_/g, " ") }];
}

export function renderSchedulesTab(client: GatewayBrowserClient, ru: () => void): TemplateResult {
  _client = client;
  _ru = ru;
  if (!_loaded && !_loading) void loadSchedules(client, ru);

  const rows: Array<{ rec: ScheduleRecord; editing: boolean }> = [];
  for (const s of _schedules) rows.push({ rec: _drafts.get(s.id) ?? s, editing: _drafts.has(s.id) });
  for (const [id, d] of _drafts) if (!_schedules.some((s) => s.id === id)) rows.push({ rec: d, editing: true });

  return html`
    <div class="rep-sub">
      <div class="rep-sub-head">
        <div>
          <h2 class="rep-sub-title">Schedules</h2>
          <p class="rep-sub-desc">Cron-driven report runs. Each fires its kind into the selected sinks on schedule.</p>
        </div>
        <button class="rep-btn rep-btn--primary" @click=${() => { const d = newDraft(); _drafts.set(d.id, d); ru(); }}>+ New schedule</button>
      </div>

      ${_error ? html`<div class="rep-inline-error">${_error}</div>` : nothing}

      ${_loading && rows.length === 0 ? html`<div class="rep-table gt-glass">${glassSkeletonRows(3)}</div>`
        : rows.length === 0 ? html`<div class="rep-table gt-glass">${glassEmpty({
            title: "No schedules yet",
            sub: "Create a schedule to run a report kind on a cron and fan it out to the UI, Telegram or email.",
            icon: ICO_CLOCK,
            action: html`<button class="rep-btn rep-btn--primary" @click=${() => { const d = newDraft(); _drafts.set(d.id, d); ru(); }}>+ New schedule</button>`,
          })}</div>`
        : html`
        <div class="rep-table gt-glass" role="table" aria-label="Schedules">
          <div class="rep-trow rep-trow--head" role="row">
            <span class="rep-cell rep-cell--on">On</span>
            <span class="rep-cell" style="--f:1.2">Kind</span>
            <span class="rep-cell" style="--f:1.1">Cron</span>
            <span class="rep-cell" style="--f:1">Theme</span>
            <span class="rep-cell" style="--f:1.6">Sinks</span>
            <span class="rep-cell" style="--f:1">Next run</span>
            <span class="rep-cell rep-cell--actions">Actions</span>
          </div>
          ${rows.map(({ rec, editing }) => renderRow(rec, editing, ru))}
        </div>
      `}
    </div>
  `;
}

function renderRow(s: ScheduleRecord, editing: boolean, ru: () => void): TemplateResult {
  const busy = _busy.has(s.id);
  const confirming = _confirmDelete.has(s.id);
  const patch = (p: Partial<ScheduleRecord>) => { _drafts.set(s.id, { ...s, ...p }); ru(); };

  return html`
    <div class="rep-trow ${editing ? "rep-trow--editing" : ""}" role="row">
      <span class="rep-cell rep-cell--on">
        <button
          class="rep-toggle ${s.enabled ? "rep-toggle--on" : ""}"
          role="switch"
          aria-label="Enabled" aria-checked="${s.enabled}"
          title="${s.enabled ? "Enabled" : "Disabled"}"
          @click=${() => editing ? patch({ enabled: !s.enabled }) : void toggleEnabled(s)}
        ><span class="rep-toggle-knob"></span></button>
      </span>

      <span class="rep-cell" style="--f:1.2" data-label="Kind">
        ${editing ? html`
          <select class="rep-input" .value=${s.kind} @change=${(e: Event) => patch({ kind: (e.target as HTMLSelectElement).value })}>
            ${withCurrent(REPORT_KINDS, s.kind).map((k: ReportKindDef) => html`<option value="${k.id}" ?selected=${k.id === s.kind}>${k.label}</option>`)}
          </select>
        ` : html`<span class="rep-cell-strong">${REPORT_KINDS.find((k) => k.id === s.kind)?.label ?? s.kind}</span>`}
      </span>

      <span class="rep-cell" style="--f:1.1" data-label="Cron">
        ${editing ? html`
          <input class="rep-input rep-input--mono" .value=${s.cron} placeholder="m h dom mon dow"
            @input=${(e: Event) => patch({ cron: (e.target as HTMLInputElement).value })} />
        ` : html`<code class="rep-cron">${s.cron}</code>`}
      </span>

      <span class="rep-cell" style="--f:1" data-label="Theme">
        ${editing ? html`
          <select class="rep-input" .value=${s.theme} @change=${(e: Event) => patch({ theme: (e.target as HTMLSelectElement).value })}>
            ${withCurrent(REPORT_THEMES, s.theme).map((th) => html`<option value="${th.id}" ?selected=${th.id === s.theme}>${th.label}</option>`)}
          </select>
        ` : html`<span class="rep-theme-badge">${REPORT_THEMES.find((t) => t.id === s.theme)?.label ?? s.theme}</span>`}
      </span>

      <span class="rep-cell rep-cell--wide rep-sinks-cell" style="--f:1.6" data-label="Sinks">
        ${ALL_SINKS.map((sink) => {
          const on = s.sinks?.includes(sink.id);
          return html`<button
            class="rep-sink-chip ${on ? "rep-sink-chip--on" : ""}"
            ?disabled=${!editing}
            @click=${() => { const set = new Set(s.sinks ?? []); on ? set.delete(sink.id) : set.add(sink.id); patch({ sinks: [...set] }); }}
          >${sink.label}</button>`;
        })}
      </span>

      <span class="rep-cell rep-cell-dim" style="--f:1" data-label="Next run">${s.next_run_at ? new Date(s.next_run_at).toLocaleString() : "—"}</span>

      <span class="rep-cell rep-cell--actions">
        ${editing ? html`
          <button class="rep-btn rep-btn--primary ${busy ? "rep-btn--loading" : ""}" ?disabled=${busy} @click=${() => void saveDraft(s.id)}>${busy ? "Saving…" : "Save"}</button>
          <button class="rep-btn" @click=${() => { _drafts.delete(s.id); ru(); }}>Cancel</button>
        ` : confirming ? html`
          <button class="rep-btn rep-btn--danger ${busy ? "rep-btn--loading" : ""}" ?disabled=${busy} @click=${() => void doDelete(s.id)}>${busy ? "…" : "Confirm"}</button>
          <button class="rep-btn" @click=${() => { _confirmDelete.delete(s.id); ru(); }}>Cancel</button>
        ` : html`
          <button class="rep-btn" @click=${() => { _drafts.set(s.id, { ...s }); ru(); }}>Edit</button>
          <button class="rep-btn rep-btn--danger-ghost" @click=${() => { _confirmDelete.add(s.id); ru(); }}>Delete</button>
        `}
      </span>
    </div>
  `;
}
