/** Business hub — small shared render helpers (KPI tile, empty state, skeletons, avatars, modals, period picker). */

import { html, nothing, type TemplateResult } from "lit";
import type { BusinessHubApp } from "../app";
import { PERIODS } from "../app";
import { sparkline } from "../charts";
import { hueFor, initials, LIFECYCLE_LABEL, pct } from "../format";
import { icons } from "../icons";

export function kpi(o: { label: string; value: string; delta?: number | null; foot?: string; spark?: number[]; onClick?: () => void }): TemplateResult {
  const d = o.delta;
  const cls = d === null || d === undefined ? "" : d > 0.005 ? "up" : d < -0.005 ? "down" : "flat";
  return html`<button class="glass kpi" style="text-align:left;border:0;cursor:${o.onClick ? "pointer" : "default"}" @click=${() => o.onClick?.()}>
    <div class="label">${o.label}</div>
    <div class="value">${o.value}</div>
    <div class="foot">
      <span>${d !== null && d !== undefined ? html`<span class="delta ${cls}">${d > 0 ? "▲" : d < 0 ? "▼" : ""} ${d >= 9 ? `${Math.round(1 + d)}×` : pct(Math.abs(d))}</span> ` : nothing}${o.foot ?? ""}</span>
      ${o.spark && o.spark.length > 1 ? sparkline(o.spark) : nothing}
    </div>
  </button>`;
}

export function skeletonKpis(n = 4): TemplateResult {
  return html`<div class="kpis">${Array.from({ length: n }, () => html`<div class="glass kpi"><div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:28px;width:60%;margin-top:8px"></div><div class="sk" style="height:10px;width:80%;margin-top:auto"></div></div>`)}</div>`;
}

export function skeletonRows(n = 6): TemplateResult {
  return html`<div class="glass card stack">${Array.from({ length: n }, () => html`<div class="row"><div class="sk" style="width:34px;height:34px;border-radius:11px"></div><div style="flex:1" class="stack"><div class="sk" style="height:11px;width:42%"></div><div class="sk" style="height:9px;width:26%"></div></div><div class="sk" style="height:11px;width:70px"></div></div>`)}</div>`;
}

export type EmptyAction = { label: string; primary?: boolean; run: () => void };

export function emptyState(o: { icon: keyof typeof icons; title: string; text: string; actions?: EmptyAction[]; inline?: boolean }): TemplateResult {
  return html`<section class="${o.inline ? "" : "glass card"} empty">
    <div class="glyph">${icons[o.icon]()}</div>
    <h2>${o.title}</h2>
    <p>${o.text}</p>
    ${o.actions?.length ? html`<div class="row">${o.actions.map((a) => html`<button class="btn ${a.primary ? "primary" : ""}" @click=${a.run}>${a.label}</button>`)}</div>` : nothing}
  </section>`;
}

export function avatar(name: string | null | undefined, lg = false): TemplateResult {
  const n = name ?? "?";
  return html`<span class="avatar ${lg ? "lg" : ""}" style="--h:${hueFor(n)}">${initials(n)}</span>`;
}

export function lifecycleChip(l: string): TemplateResult {
  const cls = l === "customer" ? "ok" : l === "qualified" ? "gold" : l === "churned" ? "bad" : "";
  return html`<span class="chip ${cls}">${LIFECYCLE_LABEL[l] ?? l}</span>`;
}

export function emailStatusChip(s: string | null | undefined): TemplateResult {
  if (!s || s === "unknown") return html``;
  const cls = s === "valid" ? "ok" : s === "risky" ? "warn" : "bad";
  return html`<span class="chip ${cls}" title="Email ${s}">${s}</span>`;
}

export function periodPicker(h: BusinessHubApp): TemplateResult {
  const range = h.range();
  const fmt = (value: number) =>
    new Date(value).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const custom = h.ui.revCustomRange as { from?: number; to?: number } | undefined;
  const inputDay = (value?: number) => (value ? new Date(value).toISOString().slice(0, 10) : "");
  return html`<div class="period-control">
    <div class="chips" role="group" aria-label="Revenue period">
      ${PERIODS.map((p) => html`<button class="chip" aria-pressed=${h.period === p.id} @click=${() => h.setPeriod(p.id)}>${p.label}</button>`)}
    </div>
    ${h.period === "custom"
      ? html`<div class="custom-range">
          <label>From<input class="input" type="date" .value=${inputDay(custom?.from)}
            @change=${(event: Event) => {
              const from = new Date(`${(event.target as HTMLInputElement).value}T00:00:00`).getTime();
              const to = custom?.to ?? Date.now();
              if (Number.isFinite(from) && from < to) h.setCustomRange(from, to);
            }} /></label>
          <label>To<input class="input" type="date" .value=${inputDay(custom?.to)}
            @change=${(event: Event) => {
              const day = new Date(`${(event.target as HTMLInputElement).value}T00:00:00`).getTime();
              const to = day + 86_400_000;
              const from = custom?.from ?? to - 30 * 86_400_000;
              if (Number.isFinite(to) && from < to) h.setCustomRange(from, to);
            }} /></label>
        </div>`
      : nothing}
    <div class="active-range" aria-live="polite">
      <span class="range-dot"></span>
      ${h.period === "all" ? "All recorded revenue" : `${fmt(range.from ?? 0)} – ${fmt(range.to)}`}
    </div>
  </div>`;
}

export function searchBox(value: string, onInput: (v: string) => void, placeholder = "Search"): TemplateResult {
  let t: ReturnType<typeof setTimeout> | null = null;
  return html`<label class="search">${icons.search()}<input class="input" type="search" .value=${value} placeholder=${placeholder} aria-label=${placeholder}
    @input=${(e: Event) => { const v = (e.target as HTMLInputElement).value; if (t) clearTimeout(t); t = setTimeout(() => onInput(v), 220); }} /></label>`;
}

export function modal(h: BusinessHubApp, title: string, body: TemplateResult, actions: TemplateResult, wide = false): TemplateResult {
  return html`<div class="scrim" @click=${() => { h.ui.modal = null; h.refresh(); }}></div>
    <div class="modal glass ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="card-head"><h2>${title}</h2><button class="btn ghost icon-btn" aria-label="Close" @click=${() => { h.ui.modal = null; h.refresh(); }}>${icons.x()}</button></div>
      ${body}
      <div class="modal-actions">${actions}</div>
    </div>`;
}

/** Read every named input in a form element into a plain object. */
export function formValues(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  new FormData(form).forEach((v, k) => {
    out[k] = typeof v === "string" ? v.trim() : "";
  });
  return out;
}

export function errorCard(h: BusinessHubApp, message: string, prefix: string): TemplateResult {
  return html`<div class="glass banner"><span class="bad">●</span><span class="grow" style="flex:1">${message}</span><button class="btn sm" @click=${() => h.invalidate(prefix)}>Retry</button></div>`;
}
