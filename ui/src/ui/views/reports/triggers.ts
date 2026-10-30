/**
 * Reports → Triggers sub-tab.
 *
 * List of event→kind wirings with an enable toggle. Each row maps a system
 * event_type (gateway_crash, kanban_milestone, credit_threshold, …) to a report
 * kind + theme + sinks. Inline edit, explicit save, confirm-on-delete.
 *
 * RPCs (verbatim):
 *   reports.triggers.list()                       → { triggers: [...] } | [...]
 *   reports.triggers.upsert({ ...TriggerRecord })  → { ok, trigger }
 *   reports.triggers.delete({ id })               → { ok }
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

export type TriggerRecord = {
  id: string;
  kind: string;
  event_type: string;
  theme: string;
  sinks: string[];
  enabled: boolean;
  config_json?: string | null;
};

export const EVENT_TYPES: Array<{ id: string; label: string }> = [
  { id: "gateway_crash", label: "Gateway crash" },
  { id: "kanban_milestone", label: "Kanban milestone" },
  { id: "credit_threshold", label: "Credit threshold" },
  { id: "agent_failed", label: "Agent failed" },
  { id: "incident", label: "Incident raised" },
  { id: "federation_degraded", label: "Federation degraded" },
];

let _triggers: TriggerRecord[] = [];
let _loading = false;
let _error: string | null = null;
let _loaded = false;
let _client: GatewayBrowserClient | null = null;
let _ru: (() => void) | null = null;

const _drafts = new Map<string, TriggerRecord>();
const _confirmDelete = new Set<string>();
const _busy = new Set<string>();

function newDraft(): TriggerRecord {
  return {
    id: `new-${_triggers.length + 1}-${_drafts.size + 1}`,
    kind: "incident",
    event_type: EVENT_TYPES[0].id,
    theme: REPORT_THEMES[0]?.id ?? "black-gold",
    sinks: ["ui", "telegram"],
    enabled: true,
  };
}

/** The gateway speaks camelCase (`eventType`); this view uses `event_type`.
 *  Accept either shape on read, and send both on write. */
function fromWire(t: TriggerRecord & { eventType?: string }): TriggerRecord {
  return { ...t, event_type: t.event_type ?? t.eventType ?? "" };
}
function toWire(t: TriggerRecord): TriggerRecord & { eventType: string } {
  return { ...t, eventType: t.event_type };
}

export async function loadTriggers(client: GatewayBrowserClient, ru: () => void): Promise<void> {
  _client = client;
  _ru = ru;
  if (_loading) return;
  _loading = true;
  _error = null;
  ru();
  try {
    const res = await rpc(client, "reports.triggers.list", {});
    _triggers = (Array.isArray(res) ? res as TriggerRecord[]
      : (res && typeof res === "object" && Array.isArray((res as any).triggers)) ? (res as any).triggers as TriggerRecord[]
      : []).map(fromWire);
    _error = null;
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
    _triggers = [];
  } finally {
    _loading = false;
    _loaded = true;
    ru();
  }
}

async function saveDraft(id: string): Promise<void> {
  const draft = _drafts.get(id);
  if (!draft || !_client) return;
  _busy.add(id);
  _ru?.();
  try {
    const res = await rpc(_client, "reports.triggers.upsert", toWire(draft));
    const saved = (res && typeof res === "object" && (res as any).trigger) ? fromWire((res as any).trigger as TriggerRecord) : draft;
    const existing = _triggers.findIndex((t) => t.id === id);
    if (existing >= 0) _triggers[existing] = saved;
    else _triggers = [saved, ..._triggers];
    _drafts.delete(id);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busy.delete(id);
    _ru?.();
  }
}

async function toggleEnabled(t: TriggerRecord): Promise<void> {
  if (!_client) return;
  const next = { ...t, enabled: !t.enabled };
  const idx = _triggers.findIndex((x) => x.id === t.id);
  if (idx >= 0) _triggers[idx] = next;
  _ru?.();
  try {
    await rpc(_client, "reports.triggers.upsert", toWire(next));
  } catch (e) {
    if (idx >= 0) _triggers[idx] = t;
    _error = e instanceof Error ? e.message : String(e);
    _ru?.();
  }
}

async function doDelete(id: string): Promise<void> {
  if (!_client) return;
  _busy.add(id);
  _ru?.();
  try {
    await rpc(_client, "reports.triggers.delete", { id });
    _triggers = _triggers.filter((t) => t.id !== id);
    _confirmDelete.delete(id);
    _drafts.delete(id);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _busy.delete(id);
    _ru?.();
  }
}

const ICO_BOLT = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;

/** Option list that always contains the record's current value, so editing a
 *  row whose value isn't in the static list doesn't show (and imply) a
 *  different selection. */
function withCurrent(list: Array<{ id: string; label: string }>, current: string): Array<{ id: string; label: string }> {
  return !current || list.some((o) => o.id === current) ? list : [...list, { id: current, label: current.replace(/_/g, " ") }];
}

export function renderTriggersTab(client: GatewayBrowserClient, ru: () => void): TemplateResult {
  _client = client;
  _ru = ru;
  if (!_loaded && !_loading) void loadTriggers(client, ru);

  const rows: Array<{ rec: TriggerRecord; editing: boolean }> = [];
  for (const t of _triggers) rows.push({ rec: _drafts.get(t.id) ?? t, editing: _drafts.has(t.id) });
  for (const [id, d] of _drafts) if (!_triggers.some((t) => t.id === id)) rows.push({ rec: d, editing: true });

  return html`
    <div class="rep-sub">
      <div class="rep-sub-head">
        <div>
          <h2 class="rep-sub-title">Triggers</h2>
          <p class="rep-sub-desc">Wire system events to report kinds. When the event fires, the report is generated and fanned out to its sinks.</p>
        </div>
        <button class="rep-btn rep-btn--primary" @click=${() => { const d = newDraft(); _drafts.set(d.id, d); ru(); }}>+ New trigger</button>
      </div>

      ${_error ? html`<div class="rep-inline-error">${_error}</div>` : nothing}

      ${_loading && rows.length === 0 ? html`<div class="rep-table gt-glass">${glassSkeletonRows(3)}</div>`
        : rows.length === 0 ? html`<div class="rep-table gt-glass">${glassEmpty({
            title: "No triggers yet",
            sub: "Wire a system event (a crash, a failed agent, a credit threshold) to a report kind so it is generated the moment it fires.",
            icon: ICO_BOLT,
            action: html`<button class="rep-btn rep-btn--primary" @click=${() => { const d = newDraft(); _drafts.set(d.id, d); ru(); }}>+ New trigger</button>`,
          })}</div>`
        : html`
        <div class="rep-table gt-glass" role="table" aria-label="Triggers">
          <div class="rep-trow rep-trow--head" role="row">
            <span class="rep-cell rep-cell--on">On</span>
            <span class="rep-cell" style="--f:1.4">Event</span>
            <span class="rep-cell" style="--f:1.2">Report kind</span>
            <span class="rep-cell" style="--f:1">Theme</span>
            <span class="rep-cell" style="--f:1.6">Sinks</span>
            <span class="rep-cell rep-cell--actions">Actions</span>
          </div>
          ${rows.map(({ rec, editing }) => renderRow(rec, editing, ru))}
        </div>
      `}
    </div>
  `;
}

function renderRow(t: TriggerRecord, editing: boolean, ru: () => void): TemplateResult {
  const busy = _busy.has(t.id);
  const confirming = _confirmDelete.has(t.id);
  const patch = (p: Partial<TriggerRecord>) => { _drafts.set(t.id, { ...t, ...p }); ru(); };

  return html`
    <div class="rep-trow ${editing ? "rep-trow--editing" : ""}" role="row">
      <span class="rep-cell rep-cell--on">
        <button
          class="rep-toggle ${t.enabled ? "rep-toggle--on" : ""}"
          role="switch"
          aria-label="Enabled" aria-checked="${t.enabled}"
          title="${t.enabled ? "Enabled" : "Disabled"}"
          @click=${() => editing ? patch({ enabled: !t.enabled }) : void toggleEnabled(t)}
        ><span class="rep-toggle-knob"></span></button>
      </span>

      <span class="rep-cell" style="--f:1.4" data-label="Event">
        ${editing ? html`
          <select class="rep-input" .value=${t.event_type} @change=${(e: Event) => patch({ event_type: (e.target as HTMLSelectElement).value })}>
            ${withCurrent(EVENT_TYPES, t.event_type).map((ev) => html`<option value="${ev.id}" ?selected=${ev.id === t.event_type}>${ev.label}</option>`)}
          </select>
        ` : html`<span class="rep-cell-strong">${EVENT_TYPES.find((e) => e.id === t.event_type)?.label ?? t.event_type}</span>`}
      </span>

      <span class="rep-cell" style="--f:1.2" data-label="Report kind">
        ${editing ? html`
          <select class="rep-input" .value=${t.kind} @change=${(e: Event) => patch({ kind: (e.target as HTMLSelectElement).value })}>
            ${withCurrent(REPORT_KINDS, t.kind).map((k: ReportKindDef) => html`<option value="${k.id}" ?selected=${k.id === t.kind}>${k.label}</option>`)}
          </select>
        ` : html`<span class="rep-kind-badge">${REPORT_KINDS.find((k) => k.id === t.kind)?.label ?? t.kind}</span>`}
      </span>

      <span class="rep-cell" style="--f:1" data-label="Theme">
        ${editing ? html`
          <select class="rep-input" .value=${t.theme} @change=${(e: Event) => patch({ theme: (e.target as HTMLSelectElement).value })}>
            ${withCurrent(REPORT_THEMES, t.theme).map((th) => html`<option value="${th.id}" ?selected=${th.id === t.theme}>${th.label}</option>`)}
          </select>
        ` : html`<span class="rep-theme-badge">${REPORT_THEMES.find((th) => th.id === t.theme)?.label ?? t.theme}</span>`}
      </span>

      <span class="rep-cell rep-cell--wide rep-sinks-cell" style="--f:1.6" data-label="Sinks">
        ${ALL_SINKS.map((sink) => {
          const on = t.sinks?.includes(sink.id);
          return html`<button
            class="rep-sink-chip ${on ? "rep-sink-chip--on" : ""}"
            ?disabled=${!editing}
            @click=${() => { const set = new Set(t.sinks ?? []); on ? set.delete(sink.id) : set.add(sink.id); patch({ sinks: [...set] }); }}
          >${sink.label}</button>`;
        })}
      </span>

      <span class="rep-cell rep-cell--actions">
        ${editing ? html`
          <button class="rep-btn rep-btn--primary ${busy ? "rep-btn--loading" : ""}" ?disabled=${busy} @click=${() => void saveDraft(t.id)}>${busy ? "Saving…" : "Save"}</button>
          <button class="rep-btn" @click=${() => { _drafts.delete(t.id); ru(); }}>Cancel</button>
        ` : confirming ? html`
          <button class="rep-btn rep-btn--danger ${busy ? "rep-btn--loading" : ""}" ?disabled=${busy} @click=${() => void doDelete(t.id)}>${busy ? "…" : "Confirm"}</button>
          <button class="rep-btn" @click=${() => { _confirmDelete.delete(t.id); ru(); }}>Cancel</button>
        ` : html`
          <button class="rep-btn" @click=${() => { _drafts.set(t.id, { ...t }); ru(); }}>Edit</button>
          <button class="rep-btn rep-btn--danger-ghost" @click=${() => { _confirmDelete.add(t.id); ru(); }}>Delete</button>
        `}
      </span>
    </div>
  `;
}
