/**
 * Generic renderer for chat panel kinds contributed by manifest-v2 plugins
 * ("<pluginId>.<kind>"). A plugin ships NO UI code here: its resolver returns
 * data in this shape and the host renders it (docs/plugins/api-reference.md ›
 * Plugin panel data). Every block is optional.
 *
 *   v0  badge, tiles, table, candles, notes
 *   v1  alert, progress, media, fields, actions, filters, search, grid
 *
 * Buttons (`actions`) may: open a link (http(s), or an in-app "/path"),
 * download a URL, or call one of the PLUGIN'S OWN RPCs (method must start
 * with "<pluginId>."), optionally after asking for text (`input`) or a
 * confirmation. RPC results that carry a `chatPanel` ref open as a nested live
 * card; `open` names a result field (URL) to open in a popup (OAuth). The
 * gateway still enforces the caller's scopes on every RPC.
 */
import { html, nothing, type TemplateResult } from "lit";

import { renderCandleChart, type Candle } from "../components/candle-chart";
import { icons } from "../icons";
import type { ChatPanelRef } from "./panel-ref";

type Rec = Record<string, unknown>;
type Tone = "ok" | "danger" | "warn" | "gold" | "";

export interface PluginPanelAction {
  id: string;
  label: string;
  icon?: string;
  tone?: "primary" | "danger" | "";
  title?: string;
  disabled?: boolean;
  href?: string;
  download?: string;
  rpc?: { method: string; params?: Rec };
  input?: { param: string; label?: string; placeholder?: string; value?: string; multiline?: boolean; submitLabel?: string };
  confirm?: string;
  open?: string;
  done?: string;
}

/** Card/modal state the renderer reads and drives (owned by PanelLiveElement). */
export interface PluginPanelCtx {
  kind: string;
  query: Rec;
  setQuery: (patch: Rec) => void;
  selected: string | null;
  select: (id: string | null) => void;
  inputFor: string | null;
  inputValue: string;
  openInput: (key: string, initial: string) => void;
  setInputValue: (v: string) => void;
  cancelInput: () => void;
  run: (action: PluginPanelAction, key: string) => void;
  busyKey: string | null;
  actionError: string | null;
  actionNote: string | null;
  spawned: ChatPanelRef[];
  /** Re-render tick for live elapsed time (ms epoch). */
  now: number;
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Rec[]) : []);
const toneOf = (v: unknown): Tone => (["ok", "danger", "warn", "gold"].includes(s(v)) ? (s(v) as Tone) : "");

/** Media URLs a panel may render. */
export function safeMediaUrl(u: unknown): string | null {
  const v = s(u).trim();
  if (/^https?:\/\//i.test(v) || /^blob:/i.test(v) || /^data:(image|video)\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  return null;
}

/** Link targets an action may open. */
export function safeHref(u: unknown): string | null {
  const v = s(u).trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (/^data:(image|video)\//i.test(v)) return v;
  return null;
}

/** May a panel of `kind` call `method`? Only its own plugin's RPCs. */
export function actionMethodAllowed(kind: string, method: unknown): boolean {
  const plugin = kind.split(".")[0];
  return typeof method === "string" && Boolean(plugin) && method.startsWith(`${plugin}.`) && !method.startsWith("chat.panel.");
}

function tile(value: string, label: string, tone = "") {
  return html`<div class="tile"><div class="v ${tone}">${value}</div><div class="k">${label}</div></div>`;
}

const icon = (name?: string) => (name && (icons as Record<string, TemplateResult>)[name]) || nothing;

function fmtClock(ms: number): string {
  const t = Math.max(0, Math.round(ms / 1000));
  return t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` : `${t}s`;
}

function renderAlert(a: Rec) {
  const tone = toneOf(a.tone);
  const details = arr(a.details);
  return html`<div class="p-alert ${tone}" role=${tone === "danger" ? "alert" : "status"}>
    <span class="p-alert-ic">${tone === "ok" ? icons.checkCircle : tone === "danger" ? icons.xCircle : icons.alertCircle}</span>
    <div class="grow">
      ${a.title ? html`<div class="p-alert-t">${s(a.title)}</div>` : nothing}
      <div class="p-alert-m">${s(a.message)}</div>
      ${details.length
        ? html`<dl class="p-kv">${details.map((d) => html`<dt>${s(d.label)}</dt><dd class="mono">${s(d.value)}</dd>`)}</dl>`
        : nothing}
    </div>
  </div>`;
}

function renderProgress(p: Rec, now: number) {
  const started = Number(p.startedAt) || 0;
  const typical = Math.max(1, Number(p.typicalSeconds) || 0);
  const elapsed = started ? now - started : 0;
  const over = elapsed / 1000 > typical;
  const pct = started ? Math.min(95, (elapsed / 1000 / typical) * 100) : 0;
  return html`<div class="p-prog" aria-live="polite">
    <div class="row">
      <span class="spin"></span>
      <span class="grow ellipsis" style="font-weight:600">${s(p.label) || "Working…"}</span>
      <span class="mono p-clock">${started ? fmtClock(elapsed) : ""}${p.typicalSeconds ? html`<span class="muted"> / ~${fmtClock(typical * 1000)}</span>` : nothing}</span>
    </div>
    <div class="bar p-bar ${over ? "over" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(pct)}><i style="width:${over ? 100 : pct}%"></i></div>
    <div class="muted p-hint">${over ? "Taking longer than usual — still waiting on the provider." : p.typicalSeconds ? `Typically ~${fmtClock(typical * 1000)}${p.basis ? ` (${s(p.basis)})` : ""}` : ""}</div>
  </div>`;
}

function renderMedia(list: Rec[], card: boolean) {
  const items = list.map((m) => ({ url: safeMediaUrl(m.url), kind: s(m.kind) === "video" ? "video" : "image", alt: s(m.alt) })).filter((m) => m.url);
  if (!items.length) return nothing;
  return html`<div class="p-media ${items.length > 1 ? "multi" : ""} ${card ? "card" : ""}">
    ${items.map((m) =>
      m.kind === "video"
        ? html`<video src=${m.url!} controls playsinline preload="metadata" aria-label=${m.alt || "Generated video"}></video>`
        : html`<img src=${m.url!} alt=${m.alt || "Generated image"} loading="lazy" decoding="async" />`,
    )}
  </div>`;
}

function renderFields(list: Rec[]) {
  if (!list.length) return nothing;
  return html`<dl class="p-fields">
    ${list.map(
      (f) => html`<dt>${s(f.label)}</dt><dd class="${f.mono ? "mono" : ""} ${f.clamp ? "p-clamp" : ""}" title=${s(f.value)}>${s(f.value)}</dd>`,
    )}
  </dl>`;
}

function renderActions(list: Rec[], ctx: PluginPanelCtx, scope: string) {
  const actions = list as unknown as PluginPanelAction[];
  if (!actions.length) return nothing;
  const pending = actions.find((a) => a.input && ctx.inputFor === `${scope}:${a.id}`);
  return html`<div class="p-actions" role="group" aria-label="Actions">
      ${actions.map((a) => {
        const key = `${scope}:${a.id}`;
        const busy = ctx.busyKey === key;
        return html`<button
          class="btn ${a.tone === "primary" ? "primary" : ""} ${a.tone === "danger" ? "danger" : ""} ${ctx.inputFor === key ? "on" : ""}"
          ?disabled=${Boolean(a.disabled) || Boolean(ctx.busyKey)}
          title=${a.title ?? a.label}
          @click=${(e: Event) => {
            e.stopPropagation();
            ctx.run(a, key);
          }}
        >
          ${busy ? html`<span class="spin"></span>` : icon(a.icon)}<span>${a.label}</span>
        </button>`;
      })}
    </div>
    ${pending ? renderInput(pending, ctx, `${scope}:${pending.id}`) : nothing}`;
}

function renderInput(a: PluginPanelAction, ctx: PluginPanelCtx, key: string) {
  const inp = a.input!;
  const submit = (e: Event) => {
    e.preventDefault();
    if (ctx.inputValue.trim()) ctx.run(a, key);
  };
  return html`<form class="p-input" @submit=${submit} @click=${(e: Event) => e.stopPropagation()}>
    ${inp.label ? html`<label class="p-input-l" for="p-in">${inp.label}</label>` : nothing}
    ${inp.multiline
      ? html`<textarea
          id="p-in"
          rows="3"
          .value=${ctx.inputValue}
          placeholder=${inp.placeholder ?? ""}
          @input=${(e: Event) => ctx.setInputValue((e.target as HTMLTextAreaElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            if (e.key === "Escape") ctx.cancelInput();
          }}
        ></textarea>`
      : html`<input
          id="p-in"
          .value=${ctx.inputValue}
          placeholder=${inp.placeholder ?? ""}
          @input=${(e: Event) => ctx.setInputValue((e.target as HTMLInputElement).value)}
        />`}
    <div class="row" style="justify-content:flex-end">
      <button type="button" class="btn" @click=${() => ctx.cancelInput()}>Cancel</button>
      <button type="submit" class="btn primary" ?disabled=${!ctx.inputValue.trim() || Boolean(ctx.busyKey)}>
        ${ctx.busyKey === key ? html`<span class="spin"></span>` : icons.sparkles}<span>${inp.submitLabel ?? a.label}</span>
      </button>
    </div>
  </form>`;
}

function renderFilters(d: Rec, ctx: PluginPanelCtx) {
  const filters = arr(d.filters);
  const search = (d.search ?? null) as Rec | null;
  if (!filters.length && !search) return nothing;
  return html`<div class="p-filters">
    ${search
      ? html`<form
          class="p-search"
          role="search"
          @submit=${(e: Event) => {
            e.preventDefault();
            const v = ((e.currentTarget as HTMLFormElement).querySelector("input") as HTMLInputElement).value.trim();
            ctx.setQuery({ [s(search.param)]: v || undefined });
          }}
        >
          ${icons.search}
          <input type="search" aria-label=${s(search.placeholder) || "Search"} placeholder=${s(search.placeholder)} .value=${s(ctx.query[s(search.param)] ?? search.value)} />
        </form>`
      : nothing}
    ${filters.map((f) => {
      const current = s(ctx.query[s(f.param)] ?? f.value);
      return html`<div class="chips" role="radiogroup" aria-label=${s(f.label) || s(f.param)}>
        ${arr(f.options).map(
          (o) => html`<button
            class="chip ${current === s(o.value) ? "on" : ""}"
            role="radio"
            aria-checked=${current === s(o.value) ? "true" : "false"}
            @click=${() => ctx.setQuery({ [s(f.param)]: s(o.value) || undefined })}
          >${s(o.label)}</button>`,
        )}
      </div>`;
    })}
  </div>`;
}

function badges(list: Rec[]) {
  return list.map((b) => html`<span class="pill ${toneOf(b.tone)}">${s(b.label)}</span>`);
}

function renderGrid(g: Rec, ctx: PluginPanelCtx, card: boolean) {
  const items = arr(g.items);
  const selected = ctx.selected ? items.find((i) => s(i.id) === ctx.selected) : undefined;
  if (selected) {
    const det = (selected.detail ?? {}) as Rec;
    return html`<div class="p-detail">
      <button class="btn" @click=${() => ctx.select(null)}>${icons.arrowLeft}<span>Back</span></button>
      ${det.alert ? renderAlert(det.alert as Rec) : nothing}
      ${renderMedia(arr(det.media), card)}
      ${renderFields(arr(det.fields))}
      ${renderActions(arr(det.actions), ctx, `item-${s(selected.id)}`)}
    </div>`;
  }
  if (!items.length) return html`<div class="state">${s(g.empty) || "Nothing to show."}</div>`;
  const layout = s(g.layout) === "list" ? "list" : "media";
  const groups = arr(g.groups);
  const cap = card && layout === "media" ? 9 : items.length;
  const shown = items.slice(0, cap);
  const more = (g.more ?? null) as Rec | null;
  const renderItem = (i: Rec) => {
    const m = (i.media ?? null) as Rec | null;
    const url = m ? safeMediaUrl(m.url) : null;
    const hasDetail = Boolean(i.detail);
    if (layout === "media") {
      return html`<button
        class="p-tile"
        title=${s(i.title)}
        aria-label=${`${s(i.title)}${i.subtitle ? ` — ${s(i.subtitle)}` : ""}`}
        @click=${() => hasDetail && ctx.select(s(i.id))}
      >
        ${url
          ? s(m!.kind) === "video"
            ? html`<video src=${url} muted playsinline preload="metadata"></video><span class="p-play">${icons.play}</span>`
            : html`<img src=${url} alt="" loading="lazy" decoding="async" />`
          : html`<span class="p-ph">${icons.image}</span>`}
        <span class="p-tile-b">${badges(arr(i.badges))}</span>
        <span class="p-tile-t">${s(i.title)}</span>
      </button>`;
    }
    return html`<div class="p-row">
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:6px"><span class="p-row-t ellipsis">${s(i.title)}</span>${badges(arr(i.badges))}</div>
        ${i.subtitle ? html`<div class="muted p-row-s ellipsis" title=${s(i.subtitle)}>${s(i.subtitle)}</div>` : nothing}
      </div>
      ${renderActions(arr(i.actions), ctx, `item-${s(i.id)}`)}
    </div>`;
  };
  const body = (list: Rec[]) =>
    layout === "media" ? html`<div class="p-grid">${list.map(renderItem)}</div>` : html`<div class="p-list">${list.map(renderItem)}</div>`;
  return html`
    ${groups.length
      ? groups.map((gr) => {
          const inGroup = shown.filter((i) => s(i.group) === s(gr.id));
          return inGroup.length
            ? html`<div class="sec"><div class="sec-h">${s(gr.label)}<span class="n">${inGroup.length}</span></div>${body(inGroup)}</div>`
            : nothing;
        })
      : body(shown)}
    ${items.length > shown.length ? html`<div class="muted" style="font-size:11px;margin-top:6px">+${items.length - shown.length} more — expand to see all</div>` : nothing}
    ${more && !card
      ? html`<div style="margin-top:10px;text-align:center"><button class="btn" @click=${() => ctx.setQuery({ [s(more.param)]: more.value })}>${s(more.label) || "Load more"}</button></div>`
      : nothing}
  `;
}

/** Render a plugin panel's data. `ctx` is absent on surfaces without live state. */
export function renderPluginPanel(d: Rec, mode: "card" | "modal", ctx?: PluginPanelCtx): TemplateResult {
  const card = mode === "card";
  const tiles = arr(d.tiles);
  const t = (d.table ?? null) as { columns?: unknown[]; rows?: unknown[][]; tones?: unknown[] } | null;
  const candles = Array.isArray(d.candles) ? (d.candles as Candle[]) : [];
  const notes = Array.isArray(d.notes) ? (d.notes as unknown[]).map(s).filter(Boolean) : [];
  const rows = Array.isArray(t?.rows) ? t!.rows : [];
  const tones = Array.isArray(t?.tones) ? t!.tones.map(s) : [];
  const shown = card ? rows.slice(0, 6) : rows;
  const live = ctx;
  return html`
    ${d.badge === "demo" ? html`<div style="margin-bottom:6px"><span class="pill warn">Demo data</span></div>` : nothing}
    ${d.alert ? html`<div class="sec">${renderAlert(d.alert as Rec)}</div>` : nothing}
    ${live && (d.filters || d.search) ? html`<div class="sec">${renderFilters(d, live)}</div>` : nothing}
    ${d.progress ? html`<div class="sec">${renderProgress(d.progress as Rec, live?.now ?? Date.now())}</div>` : nothing}
    ${Array.isArray(d.media) ? html`<div class="sec">${renderMedia(arr(d.media), card)}</div>` : nothing}
    ${Array.isArray(d.fields) ? html`<div class="sec">${renderFields(arr(d.fields))}</div>` : nothing}
    ${tiles.length
      ? html`<div class="sec"><div class="tiles">${(card ? tiles.slice(0, 4) : tiles).map((x) => tile(s(x.value), s(x.label), s(x.tone)))}</div></div>`
      : nothing}
    ${candles.length ? html`<div class="sec">${renderCandleChart(candles, { height: card ? 120 : 300, width: card ? 360 : 560, compact: card })}</div>` : nothing}
    ${t && Array.isArray(t.columns)
      ? html`<div class="sec">${rows.length
          ? html`<div style="overflow:auto"><table>
              <thead><tr>${t.columns.map((c) => html`<th>${s(c)}</th>`)}</tr></thead>
              <tbody>${shown.map(
                (r, i) => html`<tr>${(r ?? []).map(
                  (v, j) => html`<td class=${typeof v === "number" ? "num" : ""} style=${j === r.length - 1 && tones[i] ? `color:var(--${tones[i] === "ok" ? "pos" : tones[i] === "danger" ? "neg" : tones[i] === "warn" ? "mid" : "gold"})` : ""}>${s(v)}</td>`,
                )}</tr>`,
              )}</tbody></table></div>
              ${card && rows.length > shown.length ? html`<div class="muted" style="font-size:11px;margin-top:6px">+${rows.length - shown.length} more — expand to see all</div>` : nothing}`
          : html`<div class="state">Nothing to show.</div>`}</div>`
      : nothing}
    ${live && d.grid ? html`<div class="sec">${renderGrid(d.grid as Rec, live, card)}</div>` : nothing}
    ${live && Array.isArray(d.actions) ? html`<div class="sec">${renderActions(arr(d.actions), live, "panel")}</div>` : nothing}
    ${live?.actionError ? html`<div class="sec state err" role="alert" style="padding:8px">${icons.alertCircle}<span>${live.actionError}</span></div>` : nothing}
    ${live?.actionNote ? html`<div class="sec muted" role="status" style="font-size:11.5px">${live.actionNote}</div>` : nothing}
    ${live?.spawned.length
      ? html`<div class="sec p-spawned">${live.spawned.map((r) => html`<chat-panel-card .ref=${r}></chat-panel-card>`)}</div>`
      : nothing}
    ${notes.length ? html`<div class="muted" style="font-size:11px;margin-top:8px">${notes.map((n) => html`<div>${n}</div>`)}</div>` : nothing}
  `;
}
