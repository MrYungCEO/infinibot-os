/**
 * Daily Review — /daily-review
 *
 * What got done today, where the workload went, how productive the day was,
 * and the history behind it. Data comes from the per-day rollups written by
 * src/daily-review (systemd timer + gateway child process):
 *
 *   daily_review.get / .range / .config.* / .summarize   (gateway RPC)
 *
 * Before the gateway has loaded those handlers (they arrive with the next
 * restart) the page reads the same rollups through the long-served
 * `files.read` RPC from files/.daily-review/, so it works immediately; only
 * the settings and the "write summary" button wait for the RPCs.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../../app-view-state";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "../../icons";
import { glassAurora, glassHero, glassToolsStyle } from "../glass-tools-shared";
import {
  calendar,
  vbw,
  categoryColor,
  CATEGORY_ORDER,
  columns,
  fmtHours,
  fmtMoney,
  fmtNum,
  fmtTime,
  gantt,
  hBars,
  hourHeatmap,
  legend,
  lineTrend,
  OUTCOME_META,
  projectColor,
  projectTreemap,
  sparkline,
  stackedArea,
  stackedHours,
} from "./charts";
import { DAILY_REVIEW_CSS } from "./styles";
import type { DayIndexEntry, DayRollup, DayRun, ReviewConfig } from "./types";

type View = "today" | "breakdown" | "history";
type Source = "rpc" | "files" | "none";
type HistRange = "30" | "90" | "180" | "all";
type HistBucket = "day" | "week" | "month";

// ── Module state ─────────────────────────────────────────────────────────────

let _client: GatewayBrowserClient | null = null;
let _state: AppViewState | null = null;
let _update: (() => void) | null = null;
let _initialized = false;
let _view: View = "today";
let _date = localDay(Date.now());
let _source: Source = "rpc";
const _days = new Map<string, DayRollup | null>();
let _index: DayIndexEntry[] = [];
let _indexLoaded = false;
let _config: ReviewConfig | null = null;
let _loadingDay: string | null = null;
let _error = "";
let _busy: "" | "refresh" | "summary" | "config" = "";
let _toast = "";
let _filterProject = "";
let _filterBackend = "";
let _histRange: HistRange = "90";
let _histBucket: HistBucket = "day";
let _pollTimer: ReturnType<typeof setInterval> | null = null;

function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDay(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return localDay(new Date(y!, m! - 1, d! + n, 12).getTime());
}

function dayStartMs(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function prettyDay(key: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }): string {
  return new Date(dayStartMs(key) + 12 * 3600_000).toLocaleDateString([], opts);
}

const rerender = () => _update?.();

// ── Data ─────────────────────────────────────────────────────────────────────

async function readMirror<T>(rel: string): Promise<T | null> {
  if (!_client) return null;
  try {
    const res = await _client.request<{ content?: string }>("files.read", { path: `.daily-review/${rel}` });
    return res?.content ? (JSON.parse(res.content) as T) : null;
  } catch {
    return null;
  }
}

async function loadDay(date: string, opts: { refresh?: boolean } = {}): Promise<void> {
  if (!_client || _loadingDay === date) return;
  _loadingDay = date;
  _error = "";
  rerender();
  try {
    let day: DayRollup | null = null;
    if (_source === "rpc") {
      try {
        const res = await _client.request<DayRollup>("daily_review.get", { date, refresh: opts.refresh === true }, { timeoutMs: 200_000 });
        day = res && !res.empty ? res : null;
      } catch {
        _source = "files";
      }
    }
    if (_source !== "rpc") {
      day = await readMirror<DayRollup>(`days/${date}.json`);
      _source = day || _days.size ? "files" : "none";
    }
    _days.set(date, day);
  } catch (e) {
    _error = e instanceof Error ? e.message : String(e);
  } finally {
    _loadingDay = null;
    rerender();
  }
}

async function loadIndex(): Promise<void> {
  if (!_client) return;
  let days: DayIndexEntry[] | null = null;
  if (_source === "rpc") {
    try {
      days = (await _client.request<{ days: DayIndexEntry[] }>("daily_review.range", { range: "all" }))?.days ?? [];
    } catch {
      _source = "files";
    }
  }
  if (!days) days = (await readMirror<{ days: DayIndexEntry[] }>("index.json"))?.days ?? [];
  _index = days;
  _indexLoaded = true;
  rerender();
}

async function loadConfig(): Promise<void> {
  if (!_client || _source !== "rpc") return;
  try {
    _config = await _client.request<ReviewConfig>("daily_review.config.get", {});
  } catch {
    _config = null;
  }
  rerender();
}

async function saveConfig(patch: { telegram?: { enabled?: boolean; time?: string } }): Promise<void> {
  if (!_client) return;
  _busy = "config";
  rerender();
  try {
    _config = await _client.request<ReviewConfig>("daily_review.config.set", patch);
    flash("Saved");
  } catch {
    flash("Settings need the gateway restart that loads Daily Review");
  } finally {
    _busy = "";
    rerender();
  }
}

async function writeSummary(send: boolean): Promise<void> {
  if (!_client) return;
  _busy = "summary";
  rerender();
  try {
    await _client.request("daily_review.summarize", { date: _date, send }, { timeoutMs: 260_000 });
    _days.delete(_date);
    await loadDay(_date);
    flash(send ? "Summary written and sent to Telegram" : "Summary written");
  } catch {
    flash("Summary needs the gateway restart that loads Daily Review");
  } finally {
    _busy = "";
    rerender();
  }
}

async function refreshNow(): Promise<void> {
  _busy = "refresh";
  rerender();
  await loadDay(_date, { refresh: true });
  await loadIndex();
  _busy = "";
  rerender();
}

function flash(msg: string): void {
  _toast = msg;
  rerender();
  setTimeout(() => {
    if (_toast === msg) {
      _toast = "";
      rerender();
    }
  }, 4000);
}

// ── Navigation / URL ─────────────────────────────────────────────────────────

function syncUrl(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("view", _view);
    if (_date === localDay(Date.now())) url.searchParams.delete("date");
    else url.searchParams.set("date", _date);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    /* non-browser */
  }
}

function setView(v: View): void {
  _view = v;
  syncUrl();
  if (v === "history" && !_indexLoaded) void loadIndex();
  rerender();
}

function setDate(d: string): void {
  if (d > localDay(Date.now())) return;
  _date = d;
  syncUrl();
  if (!_days.has(d)) void loadDay(d);
  rerender();
}

function openRoute(route: string): void {
  const base = (_state?.basePath ?? "").replace(/\/+$/, "");
  window.history.pushState({}, "", `${base}${route}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const openRun = (runId?: string) => runId && openRoute(`/reviews/${encodeURIComponent(runId)}`);

// ── Tooltip (one element, event delegation on data-tip) ─────────────────────

function onTipMove(e: PointerEvent): void {
  const root = e.currentTarget as HTMLElement;
  const tip = root.querySelector<HTMLElement>(".dr-tip");
  if (!tip) return;
  const target = (e.target as Element | null)?.closest?.("[data-tip]");
  const text = target?.getAttribute("data-tip");
  if (!text) {
    tip.classList.remove("on");
    return;
  }
  if (tip.textContent !== text) tip.textContent = text;
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const x = e.clientX + pad + w > window.innerWidth ? e.clientX - w - pad : e.clientX + pad;
  const y = e.clientY + pad + h > window.innerHeight ? e.clientY - h - pad : e.clientY + pad;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
  tip.classList.add("on");
}

function hideTip(e: PointerEvent): void {
  (e.currentTarget as HTMLElement).querySelector(".dr-tip")?.classList.remove("on");
}

function onChartClick(e: MouseEvent): void {
  const run = (e.target as Element | null)?.closest?.("[data-run]")?.getAttribute("data-run");
  if (run) openRun(run);
}

// ── Filters ──────────────────────────────────────────────────────────────────

function filteredRuns(day: DayRollup): DayRun[] {
  return day.runs.filter(
    (r) => (!_filterProject || r.project === _filterProject) && (!_filterBackend || r.backend === _filterBackend),
  );
}

function renderFilters(day: DayRollup | null): TemplateResult {
  const projects = day ? [...new Set(day.runs.map((r) => r.project))].sort() : [];
  const backends = day ? [...new Set(day.runs.map((r) => r.backend))].sort() : [];
  return html`<div class="dr-filters">
    ${_view !== "history"
      ? html`<select class="dr-select" aria-label="Filter by project" .value=${_filterProject}
            @change=${(e: Event) => { _filterProject = (e.target as HTMLSelectElement).value; rerender(); }}>
            <option value="">All projects</option>
            ${projects.map((p) => html`<option value=${p} ?selected=${p === _filterProject}>${p}</option>`)}
          </select>
          <select class="dr-select" aria-label="Filter by backend" .value=${_filterBackend}
            @change=${(e: Event) => { _filterBackend = (e.target as HTMLSelectElement).value; rerender(); }}>
            <option value="">All backends</option>
            ${backends.map((b) => html`<option value=${b} ?selected=${b === _filterBackend}>${b}</option>`)}
          </select>`
      : html`<select class="dr-select" aria-label="Date range" .value=${_histRange}
            @change=${(e: Event) => { _histRange = (e.target as HTMLSelectElement).value as HistRange; rerender(); }}>
            <option value="30" ?selected=${_histRange === "30"}>Last 30 days</option>
            <option value="90" ?selected=${_histRange === "90"}>Last 90 days</option>
            <option value="180" ?selected=${_histRange === "180"}>Last 180 days</option>
            <option value="all" ?selected=${_histRange === "all"}>All time</option>
          </select>
          <select class="dr-select" aria-label="Group by" .value=${_histBucket}
            @change=${(e: Event) => { _histBucket = (e.target as HTMLSelectElement).value as HistBucket; rerender(); }}>
            <option value="day" ?selected=${_histBucket === "day"}>By day</option>
            <option value="week" ?selected=${_histBucket === "week"}>By week</option>
            <option value="month" ?selected=${_histBucket === "month"}>By month</option>
          </select>`}
  </div>`;
}

// ── Today ────────────────────────────────────────────────────────────────────

function scoreRing(value: number, grade: string): TemplateResult {
  const r = 52;
  const c = 2 * Math.PI * r;
  return html`<div class="dr-score" role="img" aria-label=${`Productivity score ${value} of 100, ${grade}`}>
    <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r=${r} class="dr-score-track"></circle>
      <circle cx="60" cy="60" r=${r} class="dr-score-arc" stroke-dasharray=${`${(c * Math.min(100, value)) / 100} ${c}`}></circle></svg>
    <div class="dr-score-center"><span class="dr-score-value">${value}</span><span class="dr-score-grade">${grade}</span></div>
  </div>`;
}

function trailing(date: string, n = 14): DayIndexEntry[] {
  return _index.filter((e) => e.date < date).slice(-n);
}

function renderHero(day: DayRollup): TemplateResult {
  const prev = trailing(day.date);
  const active = prev.filter((e) => e.net > 0);
  const avg = active.length ? active.reduce((a, e) => a + e.score, 0) / active.length : undefined;
  const series = [...prev.map((e) => e.score), day.score.value];
  const s = day.score;
  return html`<section class="dr-card">
    <div class="dr-hero">
      ${scoreRing(s.value, s.grade)}
      <div class="dr-hero-meta">
        <div class="dr-delta">
          ${avg !== undefined
            ? html`<b>${s.value >= avg ? "+" : ""}${Math.round(s.value - avg)}</b> vs the 14-day average of ${Math.round(avg)}`
            : html`First tracked days: building the baseline`}
          · <b>${s.net}</b> points, ${s.ratio}x your baseline of ${s.baseline}
        </div>
        ${sparkline(series, { avg, label: "Score over the last 14 days and today", w: 320 })}
        <div class="dr-note">${day.partial ? `So far today · updated ${fmtTime(day.generatedAt)}` : `Final for ${prettyDay(day.date, { month: "short", day: "numeric" })}`}
          ${day.totals.firstActivity ? html` · active ${fmtTime(day.totals.firstActivity)}–${fmtTime(day.totals.lastActivity ?? day.totals.firstActivity)}` : nothing}</div>
      </div>
    </div>
    ${renderProjectShare(day)}
  </section>`;
}

/** Hero companion: where today's agent time went, by project (top 5 + other). */
function renderProjectShare(day: DayRollup): TemplateResult {
  const total = day.byProject.reduce((a, p) => a + p.minutes, 0);
  if (!total) return html``;
  const top = day.byProject.slice(0, 5);
  const rest = total - top.reduce((a, p) => a + p.minutes, 0);
  const items = [
    ...top.map((p) => ({ name: p.name, value: p.minutes, sub: `${p.runs} tasks · ${p.verified} verified`, color: projectColor(p.name) })),
    ...(rest > 1 ? [{ name: "Other", value: rest, sub: "smaller projects", color: projectColor("Other") }] : []),
  ];
  return html`<div class="dr-hero-share">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.layers} Where the time went</h3><span class="dr-card-sub">${fmtHours(total)} of agent time</span></div>
    <div class="dr-stackbar" role="img" aria-label="Share of agent time by project">
      ${items.map((i) => html`<span style="flex:${i.value};background:${i.color}" data-tip=${`${i.name}\n${fmtHours(i.value)} · ${Math.round((100 * i.value) / total)}%`}></span>`)}
    </div>
    ${hBars(items, (v) => `${Math.round((100 * v) / total)}%`)}
  </div>`;
}

function renderBreakdownTable(day: DayRollup): TemplateResult {
  const s = day.score;
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.sliders} How the score is built</h3><span class="dr-card-sub">${s.net} net points</span></div>
    <table class="dr-breakdown">
      ${s.components.map(
        (c) => html`<tr>
          <td>${c.label}<span class="dr-note">${c.note}</span></td>
          <td class="num">${c.count}</td>
          <td class="num ${c.points < 0 ? "neg" : "pos"}">${c.points > 0 ? "+" : ""}${c.points}</td>
        </tr>`,
      )}
    </table>
    <p class="dr-formula">Score = 50% absolute output (net / (net + 60)) + 50% versus your own baseline (the median net of the previous 14 active days).
      Today: absolute ${Math.round(s.absolutePart * 100)}%, relative ${Math.round(s.relativePart * 100)}%. A day at your baseline lands near 50.</p>
  </section>`;
}

function kpi(icon: TemplateResult, label: string, value: string, sub: string): TemplateResult {
  return html`<div class="dr-kpi"><div class="dr-kpi-label">${icon}${label}</div><div class="dr-kpi-value">${value}</div><div class="dr-kpi-sub">${sub}</div></div>`;
}

function renderKpis(day: DayRollup): TemplateResult {
  const t = day.totals;
  return html`<div class="dr-kpis">
    ${kpi(icons.checkCircle, "Verified", String(t.verified), `${t.runs} agent tasks · ${t.failed} failed`)}
    ${kpi(icons.rocket, "Deploys", String(t.deploys), `${t.merges} merges`)}
    ${kpi(icons.fileCode, "Commits", String(t.commits), `${t.reposTouched} repos`)}
    ${kpi(icons.clock, "Agent time", fmtHours(t.agentMinutes), `${t.activeHours} active hours`)}
    ${kpi(icons.dollarSign, "Agent cost", fmtMoney(t.costUsd), `${fmtNum(t.tokensIn + t.tokensOut)} tokens · list price`)}
    ${kpi(icons.kanban, "Kanban done", String(t.kanbanCompleted), `${t.kanbanCreated} created`)}
  </div>`;
}

function itemRow(opts: { icon: TemplateResult; tone?: string; title: string; meta: TemplateResult | string; side?: TemplateResult | string; onClick?: () => void }): TemplateResult {
  return html`<li class="dr-item ${opts.onClick ? "dr-click" : ""}" role=${opts.onClick ? "button" : "listitem"} tabindex=${opts.onClick ? 0 : -1}
      @click=${opts.onClick ?? null}
      @keydown=${(e: KeyboardEvent) => { if (opts.onClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); opts.onClick(); } }}>
    <span class="dr-item-ico ${opts.tone ?? ""}">${opts.icon}</span>
    <div style="min-width:0"><div class="dr-item-title" title=${opts.title}>${opts.title}</div><div class="dr-item-meta">${opts.meta}</div></div>
    ${opts.side ?? nothing}
  </li>`;
}

function projChip(project: string): TemplateResult {
  return html`<span class="dr-chip"><span class="dr-chip-dot" style="background:${projectColor(project)}"></span>${project}</span>`;
}

function renderShipped(day: DayRollup): TemplateResult {
  const items = day.accomplishments.filter((a) => !_filterProject || a.project === _filterProject);
  const iconFor = (k: string) => (k === "deploy" ? icons.rocket : k === "merge" ? icons.layers : k === "kanban" ? icons.squareCheck : icons.checkCircle);
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.rocket} Shipped</h3><span class="dr-card-sub">${day.totals.verified} verified · ${day.totals.deploys} deploys</span></div>
    ${items.length
      ? html`<ul class="dr-list">${items.slice(0, 8).map((a) =>
          itemRow({
            icon: iconFor(a.kind),
            tone: a.kind === "run" ? "good" : "",
            title: a.title,
            meta: html`${projChip(a.project)}<span>${a.kind === "run" ? "verified" : a.kind} · ${fmtTime(a.ts)}</span>`,
            onClick: a.link?.startsWith("/reviews/") ? () => openRoute(a.link!) : a.link ? () => openRoute(a.link!) : undefined,
          }),
        )}</ul>`
      : html`<div class="dr-empty">Nothing verified or deployed yet.</div>`}
  </section>`;
}

function renderNeedsYou(day: DayRollup): TemplateResult {
  const items = day.needsYou.filter((a) => !_filterProject || a.project === _filterProject);
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.alertCircle} Needs you</h3><span class="dr-card-sub">${day.totals.needsYou} blocked · ${day.totals.unverified} unverified</span></div>
    ${items.length
      ? html`<ul class="dr-list">${items.slice(0, 7).map((n) =>
          itemRow({
            icon: n.reason.startsWith("Needs") ? icons.alertCircle : icons.eye,
            tone: n.reason.startsWith("Needs") ? "warn" : "",
            title: n.title,
            meta: html`${projChip(n.project)}<span>${n.reason}</span>`,
            onClick: () => openRun(n.runId),
          }),
        )}</ul>${items.length > 7 ? html`<div class="dr-more">+${items.length - 7} more in Reviews</div>` : nothing}`
      : html`<div class="dr-empty">Nothing waiting on you.</div>`}
  </section>`;
}

function renderInProgress(day: DayRollup): TemplateResult {
  const items = day.inProgress.filter((a) => !_filterProject || a.project === _filterProject);
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.loader} In progress</h3><span class="dr-card-sub">${day.totals.running} agents running</span></div>
    ${items.length
      ? html`<ul class="dr-list">${items.slice(0, 7).map((n) =>
          itemRow({
            icon: n.runId ? icons.terminal : icons.kanban,
            title: n.title,
            meta: html`${projChip(n.project)}<span>since ${fmtTime(n.since)}</span>`,
            onClick: n.runId ? () => openRun(n.runId) : () => openRoute("/projects"),
          }),
        )}</ul>`
      : html`<div class="dr-empty">Nothing running right now.</div>`}
  </section>`;
}

function renderSummary(day: DayRollup): TemplateResult {
  const s = day.summary;
  const canWrite = _source === "rpc";
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.sparkles} End-of-day summary</h3>
      <span class="dr-card-sub">${s ? `${s.by} · ${fmtTime(s.generatedAt)}${s.sentAt ? " · sent to Telegram" : ""}` : "Not written yet"}</span></div>
    ${s ? html`<ul class="dr-bullets">${s.bullets.map((b) => html`<li>${b}</li>`)}</ul>` : html`<div class="dr-empty">The summary is written automatically in the evening${_config ? ` (${_config.summary.autoTime})` : ""}, or on demand.</div>`}
    <div class="dr-row" style="margin-top:12px">
      <button class="dr-btn dr-btn--gold" ?disabled=${!canWrite || _busy === "summary"} @click=${() => writeSummary(false)}>
        ${_busy === "summary" ? icons.loader : icons.sparkles}${s ? "Rewrite" : "Write summary"}</button>
      <button class="dr-btn" ?disabled=${!canWrite || _busy === "summary"} @click=${() => writeSummary(true)}>${icons.send}Send to Telegram</button>
      ${_config
        ? html`<label class="dr-switch"><input type="checkbox" .checked=${_config.telegram.enabled} ?disabled=${_busy === "config"}
              @change=${(e: Event) => saveConfig({ telegram: { enabled: (e.target as HTMLInputElement).checked } })} />
            Send daily at</label>
            <input class="dr-date" type="time" .value=${_config.telegram.time} aria-label="Telegram send time"
              @change=${(e: Event) => saveConfig({ telegram: { time: (e.target as HTMLInputElement).value } })} />`
        : html`<span class="dr-note">${canWrite ? "" : "Writing, sending and the daily Telegram toggle turn on after the next gateway restart."}</span>`}
    </div>
  </section>`;
}

function renderTimeline(day: DayRollup): TemplateResult {
  const runs = filteredRuns(day);
  const projects = [...new Set(runs.map((r) => r.project))];
  return html`<section class="dr-card">
    <div class="dr-card-head"><h3 class="dr-card-title">${icons.activity} Timeline</h3>
      <span class="dr-card-sub">${runs.length} runs · one lane per concurrent agent · click a bar for its review</span></div>
    ${runs.length
      ? html`<div @click=${onChartClick}>${gantt(runs, dayStartMs(day.date), dayStartMs(shiftDay(day.date, 1)), Date.now())}</div>`
      : html`<div class="dr-empty">No agent runs on this day.</div>`}
    ${legend([
      ...projects.slice(0, 8).map((p) => ({ label: p, color: projectColor(p) })),
      ...["verified", "needs_you", "failed", "unverified", "running"].map((o) => ({ label: OUTCOME_META[o]!.label, color: OUTCOME_META[o]!.color, kind: "line" as const })),
    ])}
  </section>`;
}

function renderToday(day: DayRollup): TemplateResult {
  return html`
    <div class="dr-grid-2">${renderHero(day)}${renderBreakdownTable(day)}</div>
    ${renderKpis(day)}
    ${renderTimeline(day)}
    <div class="dr-grid-3">${renderShipped(day)}${renderInProgress(day)}${renderNeedsYou(day)}</div>
    ${renderSummary(day)}
  `;
}

// ── Breakdown ────────────────────────────────────────────────────────────────

function renderBreakdown(day: DayRollup): TemplateResult {
  const runs = filteredRuns(day);
  const dsMs = dayStartMs(day.date);
  // Projects → tasks from the (filtered) runs so filters apply to the treemap.
  const projMap = new Map<string, { name: string; minutes: number; tasks: Map<string, { label: string; minutes: number; outcome: string; runId: string }> }>();
  const catHours: Array<Record<string, number>> = Array.from({ length: 24 }, () => ({}));
  const backend = new Map<string, { minutes: number; cost: number; runs: Set<string> }>();
  const agentKind = new Map<string, { minutes: number; runs: Set<string> }>();
  for (const r of runs) {
    const p = projMap.get(r.project) ?? { name: r.project, minutes: 0, tasks: new Map() };
    p.minutes += r.minutes;
    const t = p.tasks.get(r.rootId) ?? { label: r.label, minutes: 0, outcome: r.outcome, runId: r.runId };
    t.minutes += r.minutes;
    t.outcome = r.outcome;
    t.runId = r.runId;
    p.tasks.set(r.rootId, t);
    projMap.set(r.project, p);
    const s = Math.max(r.start, dsMs);
    const e = Math.min(r.end ?? Date.now(), dsMs + 86_400_000);
    for (let h = 0; h < 24; h++) {
      const h0 = dsMs + h * 3600_000;
      const ov = Math.max(0, Math.min(e, h0 + 3600_000) - Math.max(s, h0));
      if (ov > 0) catHours[h]![r.category] = (catHours[h]![r.category] ?? 0) + ov / 60_000;
    }
    const b = backend.get(r.backend) ?? { minutes: 0, cost: 0, runs: new Set<string>() };
    b.minutes += r.minutes;
    b.cost += r.costUsd;
    b.runs.add(r.rootId);
    backend.set(r.backend, b);
    const a = agentKind.get(r.kind) ?? { minutes: 0, runs: new Set<string>() };
    a.minutes += r.minutes;
    a.runs.add(r.rootId);
    agentKind.set(r.kind, a);
  }
  const projects = [...projMap.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .map((p) => ({ name: p.name, minutes: p.minutes, tasks: [...p.tasks.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 14) }));
  const cats = CATEGORY_ORDER.filter((c) => catHours.some((h) => (h[c] ?? 0) > 0));
  const hours = day.hours;
  return html`
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.layoutGrid} Where the agent time went</h3>
        <span class="dr-card-sub">Area = agent time · project → task · click a task for its review</span></div>
      <div class="dr-scroll" @click=${onChartClick}><div style="min-width:640px">${projectTreemap(projects)}</div></div>
      ${legend(projects.slice(0, 8).map((p) => ({ label: `${p.name} ${fmtHours(p.minutes)}`, color: projectColor(p.name) })))}
    </section>
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.barChart} Work type by hour</h3><span class="dr-card-sub">Agent time per hour, stacked by type</span></div>
      <div class="dr-scroll"><div style="min-width:640px">${stackedHours(catHours, cats, categoryColor, (v) => fmtHours(v), Math.max(640, vbw(0.82)))}</div></div>
      ${legend(cats.map((c) => ({ label: `${c} ${fmtHours(catHours.reduce((a, h) => a + (h[c] ?? 0), 0))}`, color: categoryColor(c) })))}
    </section>
    <div class="dr-grid-2">
      <section class="dr-card">
        <div class="dr-card-head"><h3 class="dr-card-title">${icons.terminal} By backend</h3><span class="dr-card-sub">Agent time · tasks · cost</span></div>
        ${hBars(
          [...backend.entries()].sort((a, b) => b[1].minutes - a[1].minutes).map(([name, v], i) => ({
            name,
            value: v.minutes,
            sub: `${v.runs.size} tasks · ${fmtMoney(v.cost)}`,
            color: `var(--dr-s${(i % 8) + 1})`,
          })),
          fmtHours,
        )}
        <div class="dr-card-head" style="margin-top:18px"><h3 class="dr-card-title">${icons.bot} By agent kind</h3></div>
        ${hBars(
          [...agentKind.entries()].sort((a, b) => b[1].minutes - a[1].minutes).map(([name, v]) => ({ name, value: v.minutes, sub: `${v.runs.size} tasks`, color: "var(--dr-gold)" })),
          fmtHours,
        )}
        ${day.channels.length
          ? html`<div class="dr-card-head" style="margin-top:18px"><h3 class="dr-card-title">${icons.messageSquare} Gateway conversations</h3></div>
              ${hBars(day.channels.map((c) => ({ name: c.name, value: c.messages, sub: c.costUsd ? fmtMoney(c.costUsd) : "", color: "var(--dr-s7)" })), (v) => `${Math.round(v)} msgs`)}`
          : nothing}
      </section>
      <section class="dr-card">
        <div class="dr-card-head"><h3 class="dr-card-title">${icons.calendar} Hour of day</h3><span class="dr-card-sub">Darker = more</span></div>
        ${hourHeatmap([
          { label: "Agent time", values: hours.map((h) => h.agentMinutes), unit: fmtHours },
          { label: "Runs started", values: hours.map((h) => h.runsStarted), unit: (v) => `${v} started` },
          { label: "Commits", values: hours.map((h) => h.commits), unit: (v) => `${v} commits` },
          { label: "Messages", values: hours.map((h) => h.messages), unit: (v) => `${v} messages` },
        ])}
        <div class="dr-card-head" style="margin-top:18px"><h3 class="dr-card-title">${icons.dollarSign} Cost by hour</h3><span class="dr-card-sub">${fmtMoney(day.totals.costUsd)} list price</span></div>
        ${columns(hours.map((h) => ({ label: `${String(h.h).padStart(2, "0")}:00`, value: h.costUsd, tick: h.h % 3 === 0 ? String(h.h).padStart(2, "0") : undefined })), { unit: fmtMoney, color: "var(--dr-gold)", h: 140, w: vbw(0.4) })}
        <div class="dr-card-head" style="margin-top:12px"><h3 class="dr-card-title">${icons.zap} Tokens by hour</h3><span class="dr-card-sub">${fmtNum(day.totals.tokensIn + day.totals.tokensOut)} in+out · ${fmtNum(day.totals.tokensCached)} cached</span></div>
        ${columns(hours.map((h) => ({ label: `${String(h.h).padStart(2, "0")}:00`, value: h.tokens, tick: h.h % 3 === 0 ? String(h.h).padStart(2, "0") : undefined })), { unit: fmtNum, color: "var(--dr-s1)", h: 140, w: vbw(0.4) })}
      </section>
    </div>
    <div class="dr-grid-2">
      <section class="dr-card">
        <div class="dr-card-head"><h3 class="dr-card-title">${icons.fileCode} Commits</h3><span class="dr-card-sub">${day.totals.commits} commits · ${day.totals.merges} merges</span></div>
        ${day.repos.length ? hBars(day.repos.map((r) => ({ name: r.name, value: r.commits + r.merges, sub: `${r.merges} merges`, color: projectColor(r.project ?? r.name) })), (v) => `${v}`) : html`<div class="dr-empty">No commits.</div>`}
      </section>
      <section class="dr-card">
        <div class="dr-card-head"><h3 class="dr-card-title">${icons.fileText} Reports and incidents</h3></div>
        ${day.reports.length
          ? html`<ul class="dr-list">${day.reports.slice(0, 6).map((r) => itemRow({ icon: icons.fileText, title: r.name, meta: fmtTime(r.ts), onClick: () => openRoute("/reports") }))}</ul>`
          : html`<div class="dr-empty">No reports today.</div>`}
        ${day.incidents.length
          ? html`<ul class="dr-list" style="margin-top:10px">${day.incidents.slice(0, 5).map((i) => itemRow({ icon: icons.alertCircle, tone: "crit", title: i.detail, meta: `${i.kind.toUpperCase()} · ${fmtTime(i.ts)}` }))}</ul>`
          : nothing}
      </section>
    </div>
  `;
}

// ── History ──────────────────────────────────────────────────────────────────

function isoWeekStart(key: string): string {
  const d = new Date(dayStartMs(key) + 12 * 3600_000);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDay(d.getTime());
}

function bucketKey(date: string): string {
  return _histBucket === "week" ? isoWeekStart(date) : _histBucket === "month" ? date.slice(0, 7) : date;
}

function bucketLabel(key: string): string {
  if (_histBucket === "month") return new Date(`${key}-15T12:00:00`).toLocaleDateString([], { month: "short", year: "numeric" });
  if (_histBucket === "week") return `Week of ${prettyDay(key, { month: "short", day: "numeric" })}`;
  return prettyDay(key, { weekday: "short", month: "short", day: "numeric" });
}

function renderHistory(): TemplateResult {
  if (!_indexLoaded) return html`<div class="dr-empty">Loading history…</div>`;
  const today = localDay(Date.now());
  const from = _histRange === "all" ? "0000-00-00" : shiftDay(today, -Number(_histRange) + 1);
  const days = _index.filter((e) => e.date >= from);
  if (!days.length) return html`<div class="dr-empty">No history yet. The first backfill fills it from the run logs.</div>`;
  // Buckets.
  const groups = new Map<string, DayIndexEntry[]>();
  for (const d of days) {
    const k = bucketKey(d.date);
    groups.set(k, [...(groups.get(k) ?? []), d]);
  }
  const keys = [...groups.keys()].sort();
  const agg = keys.map((k) => {
    const list = groups.get(k)!;
    const active = list.filter((e) => e.net > 0);
    const sum = (f: (e: DayIndexEntry) => number) => list.reduce((a, e) => a + f(e), 0);
    const parts: Record<string, number> = {};
    for (const e of list) for (const p of e.projects) parts[p.name] = (parts[p.name] ?? 0) + p.minutes;
    return {
      key: k,
      label: bucketLabel(k),
      score: active.length ? Math.round(active.reduce((a, e) => a + e.score, 0) / active.length) : 0,
      verified: sum((e) => e.verified),
      commits: sum((e) => e.commits),
      deploys: sum((e) => e.deploys),
      cost: sum((e) => e.costUsd),
      parts,
    };
  });
  const n = agg.length;
  const tick = (i: number) => {
    // ~80px per label on the narrowest (half-width) chart in this view.
    const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(vbw(0.4) / 80))));
    if (i % every) return undefined;
    const k = agg[i]!.key;
    return _histBucket === "month" ? k.slice(2) : k.slice(5);
  };
  const avg7 = agg.map((_, i) => {
    const w = agg.slice(Math.max(0, i - 6), i + 1).filter((a) => a.score > 0);
    return w.length ? w.reduce((s, a) => s + a.score, 0) / w.length : 0;
  });
  const pick = (i: number) => {
    if (_histBucket !== "day") return;
    _view = "today";
    setDate(agg[i]!.key);
  };
  const projTotals = new Map<string, number>();
  for (const a of agg) for (const [p, m] of Object.entries(a.parts)) projTotals.set(p, (projTotals.get(p) ?? 0) + m);
  const topProjects = [...projTotals.entries()].filter(([p]) => p !== "Other").sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
  const areaBuckets = agg.map((a, i) => {
    const parts: Record<string, number> = {};
    let other = 0;
    for (const [p, m] of Object.entries(a.parts)) {
      if (topProjects.includes(p)) parts[p] = m;
      else other += m;
    }
    if (other > 0) parts.Other = other;
    return { label: a.label, tick: tick(i), parts };
  });
  const areaKeys = [...topProjects, ...(areaBuckets.some((b) => b.parts.Other) ? ["Other"] : [])];
  const best = [...days].sort((a, b) => b.score - a.score).slice(0, 6);
  const active = days.filter((d) => d.net > 0);
  const sumAll = (f: (e: DayIndexEntry) => number) => days.reduce((a, e) => a + f(e), 0);
  const series = (f: (a: (typeof agg)[number]) => number) => agg.map((a, i) => ({ label: a.label, value: f(a), tick: tick(i) }));
  return html`
    <div class="dr-kpis">
      ${kpi(icons.calendar, "Active days", String(active.length), `of ${days.length} tracked`)}
      ${kpi(icons.target, "Average score", String(active.length ? Math.round(active.reduce((a, e) => a + e.score, 0) / active.length) : 0), "active days")}
      ${kpi(icons.checkCircle, "Verified", String(sumAll((e) => e.verified)), `${sumAll((e) => e.failed)} failed`)}
      ${kpi(icons.fileCode, "Commits", fmtNum(sumAll((e) => e.commits)), "deduplicated")}
      ${kpi(icons.rocket, "Deploys", String(sumAll((e) => e.deploys)), "from run results")}
      ${kpi(icons.dollarSign, "Agent cost", fmtMoney(sumAll((e) => e.costUsd)), "list price")}
    </div>
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.calendar} Productivity calendar</h3><span class="dr-card-sub">Darker gold = higher score · click a day to open it</span></div>
      ${calendar(days.map((d) => ({ date: d.date, score: d.score, net: d.net })), (d) => { _view = "today"; setDate(d); }, _date)}
      ${legend([
        { label: "0", color: "var(--dr-q0)" },
        { label: "1-20", color: "var(--dr-q1)" },
        { label: "40", color: "var(--dr-q2)" },
        { label: "60", color: "var(--dr-q3)" },
        { label: "80", color: "var(--dr-q4)" },
        { label: "100", color: "var(--dr-q5)" },
      ])}
    </section>
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.activity} Score</h3><span class="dr-card-sub">Average score per ${_histBucket}${_histBucket === "day" ? " · dashed = 7-day average · click a day" : ""}</span></div>
      ${lineTrend(series((a) => a.score), { unit: (v) => String(Math.round(v)), max: 100, avgLine: _histBucket === "day" ? avg7 : undefined, w: vbw(0.82), onPick: pick })}
    </section>
    <div class="dr-grid-2">
      <section class="dr-card"><div class="dr-card-head"><h3 class="dr-card-title">${icons.checkCircle} Verified tasks</h3></div>
        ${columns(series((a) => a.verified), { unit: (v) => String(Math.round(v)), color: "var(--dr-s3)", w: vbw(0.4), onPick: pick })}</section>
      <section class="dr-card"><div class="dr-card-head"><h3 class="dr-card-title">${icons.fileCode} Commits</h3></div>
        ${columns(series((a) => a.commits), { unit: (v) => String(Math.round(v)), color: "var(--dr-s1)", w: vbw(0.4), onPick: pick })}</section>
      <section class="dr-card"><div class="dr-card-head"><h3 class="dr-card-title">${icons.rocket} Deploys</h3></div>
        ${columns(series((a) => a.deploys), { unit: (v) => String(Math.round(v)), color: "var(--dr-s7)", w: vbw(0.4), onPick: pick })}</section>
      <section class="dr-card"><div class="dr-card-head"><h3 class="dr-card-title">${icons.dollarSign} Agent cost</h3><span class="dr-card-sub">list price</span></div>
        ${columns(series((a) => a.cost), { unit: fmtMoney, color: "var(--dr-gold)", w: vbw(0.4), onPick: pick })}</section>
    </div>
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.layers} Project share over time</h3><span class="dr-card-sub">Share of agent time per ${_histBucket}</span></div>
      ${stackedArea(areaBuckets, areaKeys, vbw(0.82))}
      ${legend(areaKeys.map((k) => ({ label: k, color: projectColor(k) })))}
    </section>
    <section class="dr-card">
      <div class="dr-card-head"><h3 class="dr-card-title">${icons.crown} Best days</h3></div>
      <div class="dr-scroll"><table class="dr-table">
        <thead><tr><th>Day</th><th>Score</th><th>Verified</th><th>Commits</th><th>Deploys</th><th>Agent time</th><th>Cost</th></tr></thead>
        <tbody>${best.map(
          (b) => html`<tr class="dr-click" @click=${() => { _view = "today"; setDate(b.date); }}>
            <td>${prettyDay(b.date, { weekday: "short", month: "short", day: "numeric" })}</td><td><b>${b.score}</b> ${b.grade}</td>
            <td>${b.verified}</td><td>${b.commits}</td><td>${b.deploys}</td><td>${fmtHours(b.agentMinutes)}</td><td>${fmtMoney(b.costUsd)}</td></tr>`,
        )}</tbody>
      </table></div>
    </section>
  `;
}

// ── Page ─────────────────────────────────────────────────────────────────────

function init(): void {
  if (_initialized) return;
  _initialized = true;
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("view");
    if (v === "today" || v === "breakdown" || v === "history") _view = v;
    const d = q.get("date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= localDay(Date.now())) _date = d;
  } catch {
    /* ignore */
  }
  void (async () => {
    await loadDay(_date);
    await Promise.all([loadIndex(), loadConfig()]);
  })();
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerender, 200);
  });
  _pollTimer ??= setInterval(() => {
    if (document.hidden || _date !== localDay(Date.now()) || _view === "history") return;
    _days.delete(_date);
    void loadDay(_date);
  }, 120_000);
}

export function renderDailyReview(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  _state = state;
  _update = () => state.requestUpdate?.();
  if (_client !== client) {
    _client = client;
    _initialized = false;
    _source = "rpc";
  }
  init();
  const day = _days.get(_date) ?? null;
  const isToday = _date === localDay(Date.now());
  const loading = _loadingDay === _date || (!_days.has(_date) && !_error);
  const title = isToday ? `Today, ${prettyDay(_date, { month: "long", day: "numeric" })}` : prettyDay(_date);
  const body =
    _view === "history"
      ? renderHistory()
      : loading && !day
        ? html`<div class="dr-empty">Loading the day…</div>`
        : !day
          ? html`<section class="dr-card"><div class="dr-empty">No rollup for ${prettyDay(_date)} yet.
              ${_source === "none" ? "The rollup job has not run on this machine yet." : "Nothing was recorded that day, or it is still being computed."}</div></section>`
          : _view === "today"
            ? renderToday(day)
            : renderBreakdown(day);
  return html`
    ${glassToolsStyle()}
    <style>${DAILY_REVIEW_CSS}</style>
    <div class="gt-scope dr-root" @pointermove=${onTipMove} @pointerleave=${hideTip}>
      ${glassAurora()}
      ${glassHero({
        eyebrow: "Daily Review",
        title,
        sub: day
          ? `${day.totals.runs} agent tasks · ${day.totals.verified} verified · ${day.totals.commits} commits · ${day.totals.deploys} deploys`
          : "What got done, where the work went, and how the day compares.",
        trailing: html`<div class="dr-daynav">
          <button class="dr-btn" aria-label="Previous day" @click=${() => setDate(shiftDay(_date, -1))}>${icons.arrowLeft}</button>
          <input class="dr-date" type="date" .value=${_date} max=${localDay(Date.now())} aria-label="Pick a day"
            @change=${(e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) setDate(v); }} />
          <button class="dr-btn" aria-label="Next day" ?disabled=${isToday} @click=${() => setDate(shiftDay(_date, 1))}>${icons.arrowRight}</button>
          ${isToday ? nothing : html`<button class="dr-btn" @click=${() => setDate(localDay(Date.now()))}>Today</button>`}
          <button class="dr-btn" aria-label="Refresh" ?disabled=${_busy === "refresh"} @click=${refreshNow}>${_busy === "refresh" ? icons.loader : icons.refresh}</button>
        </div>`,
      })}
      ${_source === "files"
        ? html`<div class="dr-banner">${icons.alertCircle}<span>Showing the saved rollups (refreshed every 15 minutes). Live refresh, the AI summary button and the Telegram schedule switch on after the next gateway restart.</span></div>`
        : nothing}
      ${_error ? html`<div class="dr-banner">${icons.alertCircle}<span>${_error}</span></div>` : nothing}
      <div class="dr-toolbar">
        <div class="dr-tabs" role="tablist" aria-label="Daily review views">
          ${(["today", "breakdown", "history"] as View[]).map(
            (v) => html`<button class="dr-tab" role="tab" aria-selected=${String(_view === v)} @click=${() => setView(v)}>
              ${v === "today" ? (isToday ? "Today" : "Day") : v === "breakdown" ? "Workload" : "History"}</button>`,
          )}
        </div>
        ${renderFilters(day)}
      </div>
      ${body}
      ${_toast ? html`<div class="dr-banner" role="status">${icons.check}<span>${_toast}</span></div>` : nothing}
      <div class="dr-tip" role="tooltip"></div>
    </div>
  `;
}
