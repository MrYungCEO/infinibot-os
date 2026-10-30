import { html, nothing, type TemplateResult } from "lit";

import type { LogEntry, LogLevel } from "../types";
import { opsIcon, renderOpsSharedStyles, renderOpsTelemetryRail } from "./ops-glass";

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type LogsProps = {
  loading: boolean;
  error: string | null;
  file: string | null;
  entries: LogEntry[];
  filterText: string;
  levelFilters: Record<LogLevel, boolean>;
  autoFollow: boolean;
  truncated: boolean;
  onFilterTextChange: (next: string) => void;
  onLevelToggle: (level: LogLevel, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onRefresh: () => void;
  onExport: (lines: string[], label: string) => void;
  onScroll: (event: Event) => void;
};

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString();
}

function matchesFilter(entry: LogEntry, needle: string) {
  if (!needle) return true;
  const haystack = [entry.message, entry.subsystem, entry.raw]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function renderTintedMessage(value: string): TemplateResult {
  const parts = value.split(
    /("(?:\\.|[^"\\])*"\s*:?)|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)/g,
  );
  return html`${parts.map((part) => {
    if (!part) return nothing;
    if (/^"/.test(part)) return html`<span class="ops-syntax-string">${part}</span>`;
    if (/^(?:true|false|null)$/.test(part))
      return html`<span class="ops-syntax-bool">${part}</span>`;
    if (/^-?\d/.test(part)) return html`<span class="ops-syntax-number">${part}</span>`;
    return part;
  })}`;
}

function jumpToNow(event: Event, props: LogsProps) {
  const root = (event.currentTarget as HTMLElement).closest(".ops-logs-page");
  const stream = root?.querySelector<HTMLElement>(".ops-log-stream");
  if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
  props.onToggleAutoFollow(true);
}

export function renderLogs(props: LogsProps) {
  const needle = props.filterText.trim().toLowerCase();
  const levelFiltered = LEVELS.some((level) => !props.levelFilters[level]);
  const filtered = props.entries.filter((entry) => {
    if (entry.level && !props.levelFilters[entry.level]) return false;
    return matchesFilter(entry, needle);
  });
  const exportLabel = needle || levelFiltered ? "filtered" : "visible";
  const errorCount = filtered.filter(
    (entry) => entry.level === "error" || entry.level === "fatal",
  ).length;
  const subsystemCount = new Set(filtered.map((entry) => entry.subsystem).filter(Boolean)).size;
  const activeLevels = LEVELS.filter((level) => props.levelFilters[level]).length;

  return html`
    <div class="ops-page ops-logs-page" aria-busy=${props.loading ? "true" : "false"}>
      ${renderOpsSharedStyles()}
      <style>
        .ops-logs-page .ops-toolbar { display:flex;align-items:center;gap:8px;flex-wrap:wrap; }
        .ops-logs-page .ops-toolbar .btn { display:inline-flex;align-items:center;gap:8px; }
        .ops-logs-page .ops-control-deck { display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:14px;align-items:end;margin-top:22px;padding:14px;border:1px solid var(--g-border);border-radius:var(--g-radius);background:color-mix(in srgb,var(--g-bg-deep) 36%,var(--g-surface));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 7%,transparent); }
        .ops-logs-page .ops-search-wrap { position:relative;display:block;min-width:0; }
        .ops-logs-page .ops-search-wrap .ops-icon { position:absolute;left:13px;top:50%;z-index:1;transform:translateY(-50%);color:var(--g-fg-faint); }
        .ops-logs-page .ops-search-wrap input { width:100%;min-height:42px;padding-left:40px; }
        .ops-logs-page .ops-search-label { display:block;margin-bottom:7px;color:var(--g-fg-faint);font-size:9px;font-weight:750;letter-spacing:.13em;text-transform:uppercase; }
        .ops-logs-page .ops-tail-toggle { display:inline-flex;align-items:center;gap:10px;min-height:42px;padding:0 13px;border:1px solid var(--g-border);border-radius:var(--g-radius-sm);background:var(--g-surface);color:var(--g-fg-dim);cursor:pointer;font-size:11px;font-weight:650;white-space:nowrap; }
        .ops-logs-page .ops-tail-toggle input { position:absolute;opacity:0;pointer-events:none; }
        .ops-logs-page .ops-switch { position:relative;width:31px;height:18px;border:1px solid var(--g-border);border-radius:999px;background:color-mix(in srgb,var(--g-bg-deep) 54%,var(--g-surface));transition:background 160ms ease,border-color 160ms ease; }
        .ops-logs-page .ops-switch::after { content:"";position:absolute;top:3px;left:3px;width:10px;height:10px;border-radius:50%;background:var(--g-fg-faint);transition:transform 160ms ease,background 160ms ease,box-shadow 160ms ease; }
        .ops-logs-page .ops-tail-toggle input:checked + .ops-switch { border-color:var(--g-border-strong);background:var(--g-primary-soft); }
        .ops-logs-page .ops-tail-toggle input:checked + .ops-switch::after { transform:translateX(13px);background:var(--g-primary);box-shadow:0 0 12px color-mix(in srgb,var(--g-primary) 76%,transparent); }
        .ops-logs-page .ops-levels { display:flex;gap:7px;margin-top:12px;overflow-x:auto;padding:1px 1px 5px;scrollbar-width:thin;scrollbar-color:var(--g-border-strong) transparent; }
        .ops-logs-page .ops-level-chip { display:inline-flex;align-items:center;gap:7px;flex:none;min-height:30px;padding:0 10px;border:1px solid var(--g-border);border-radius:999px;background:var(--g-surface);color:var(--g-fg-faint);cursor:pointer;font:700 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;transition:border-color 160ms ease,background 160ms ease,color 160ms ease,transform 160ms ease; }
        .ops-logs-page .ops-level-chip:hover { transform:translateY(-1px);border-color:var(--g-border-strong); }
        .ops-logs-page .ops-level-chip input { position:absolute;opacity:0;pointer-events:none; }
        .ops-logs-page .ops-level-chip:has(input:checked) { border-color:var(--g-border-strong);background:var(--g-primary-soft);color:var(--g-primary);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 10%,transparent),0 0 18px color-mix(in srgb,var(--g-primary) 8%,transparent); }
        .ops-logs-page .ops-level-chip.error:has(input:checked),.ops-logs-page .ops-level-chip.fatal:has(input:checked) { border-color:var(--g-danger-border);background:var(--g-danger-soft);color:var(--g-danger); }
        .ops-logs-page .ops-level-chip.warn:has(input:checked) { border-color:var(--g-warning-border);background:var(--g-warning-soft);color:var(--g-warning); }
        .ops-logs-page .ops-level-dot { width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor; }
        .ops-logs-page .ops-file-rail { display:flex;align-items:center;gap:9px;min-width:0;margin-top:10px;color:var(--g-fg-faint);font:500 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
        .ops-logs-page .ops-file-rail span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .ops-logs-page .ops-console { position:relative;overflow:hidden;margin-top:14px;border:1px solid var(--g-border);border-radius:var(--g-radius);background:color-mix(in srgb,var(--g-bg-deep) 72%,var(--g-surface));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--g-fg) 8%,transparent),inset 0 20px 70px color-mix(in srgb,var(--g-bg-deep) 34%,transparent),var(--g-shadow); }
        .ops-logs-page .ops-console-bar { display:grid;grid-template-columns:94px 78px 130px minmax(0,1fr);align-items:center;min-height:36px;padding:0 15px;border-bottom:1px solid var(--g-border);background:color-mix(in srgb,var(--g-surface-strong) 76%,transparent);color:var(--g-fg-faint);font:700 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;backdrop-filter:var(--g-blur);-webkit-backdrop-filter:var(--g-blur); }
        .ops-logs-page .ops-log-stream { max-height:min(62vh,680px);min-height:340px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--g-border-strong) transparent; }
        .ops-logs-page .ops-log-row { display:grid;grid-template-columns:94px 78px 130px minmax(0,1fr);align-items:baseline;min-height:38px;padding:8px 15px;border-bottom:1px solid color-mix(in srgb,var(--g-border) 62%,transparent);color:var(--g-fg-dim);font:500 11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;transition:background 120ms ease,box-shadow 120ms ease; }
        .ops-logs-page .ops-log-row:hover { background:var(--g-surface-hover);box-shadow:inset 2px 0 0 var(--g-primary); }
        .ops-logs-page .ops-log-time { color:var(--g-fg-faint);font-variant-numeric:tabular-nums; }
        .ops-logs-page .ops-log-level { width:fit-content;padding:3px 7px;border:1px solid var(--g-border);border-radius:999px;color:var(--g-primary);font-size:8px;font-weight:800;letter-spacing:.08em;line-height:1;text-transform:uppercase; }
        .ops-logs-page .ops-log-level.warn { border-color:var(--g-warning-border);background:var(--g-warning-soft);color:var(--g-warning); }
        .ops-logs-page .ops-log-level.error,.ops-logs-page .ops-log-level.fatal { border-color:var(--g-danger-border);background:var(--g-danger-soft);color:var(--g-danger); }
        .ops-logs-page .ops-log-level.info { border-color:var(--g-info-border);background:var(--g-info-soft);color:var(--g-info); }
        .ops-logs-page .ops-log-subsystem { overflow:hidden;padding-right:14px;color:var(--g-primary);text-overflow:ellipsis;white-space:nowrap; }
        .ops-logs-page .ops-log-message { min-width:0;overflow-wrap:anywhere;color:var(--g-fg-dim); }
        .ops-logs-page .ops-syntax-string { color:var(--g-success); }.ops-logs-page .ops-syntax-number { color:var(--g-info); }.ops-logs-page .ops-syntax-bool { color:var(--g-warning); }
        .ops-logs-page .ops-console-tail { position:absolute;right:12px;bottom:12px;display:inline-flex;align-items:center;gap:8px;min-height:34px;border-color:var(--g-border-strong);background:color-mix(in srgb,var(--g-bg-deep) 80%,var(--g-primary-soft));color:var(--g-primary);backdrop-filter:var(--g-blur-heavy);-webkit-backdrop-filter:var(--g-blur-heavy); }
        .ops-logs-page .ops-cursor { width:5px;height:12px;background:var(--g-primary);box-shadow:0 0 10px var(--g-primary);animation:opsCursor 1s steps(1) infinite; }
        .ops-logs-page .ops-notices { display:grid;gap:8px;margin-top:10px; }.ops-logs-page .ops-notices .callout { margin:0 !important; }
        @keyframes opsCursor { 50% { opacity:.2; } }
        @media (max-width:760px) { .ops-logs-page .ops-control-deck{grid-template-columns:1fr}.ops-logs-page .ops-tail-toggle{justify-content:space-between}.ops-logs-page .ops-console-bar{display:none}.ops-logs-page .ops-log-stream{min-height:360px}.ops-logs-page .ops-log-row{grid-template-columns:auto auto 1fr;gap:7px 9px;padding:11px 12px}.ops-logs-page .ops-log-time{grid-column:1}.ops-logs-page .ops-log-level{grid-column:2}.ops-logs-page .ops-log-subsystem{grid-column:3;padding:0}.ops-logs-page .ops-log-message{grid-column:1/-1} }
        @media (max-width:390px) { .ops-logs-page .ops-toolbar{width:100%}.ops-logs-page .ops-toolbar .btn{flex:1;justify-content:center;font-size:10px;white-space:nowrap}.ops-logs-page .ops-log-row{font-size:10px}.ops-logs-page .ops-console-tail{left:12px;right:12px;justify-content:center} }
      </style>

      <header class="ops-hero">
        <div class="ops-hero-copy"><div class="ops-eyebrow">Observability / Live stream</div><h1 class="ops-title">Gateway <em>logs</em></h1><p class="ops-subtitle">A precision console for the gateway JSONL stream, with fast level isolation, live tailing, and syntax-aware inspection.</p></div>
        <div class="ops-live-badge"><span class="ops-status-dot ${props.error ? "warn" : ""}"></span>${props.error ? "Stream issue" : props.autoFollow ? "Live tailing" : "Tail paused"}</div>
      </header>

      <div class="ops-metrics" aria-label="Log stream summary">
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("logs", 13)}Visible lines</span><strong class="ops-metric-value accent">${filtered.length}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("filter", 13)}Active levels</span><strong class="ops-metric-value">${activeLevels}/${LEVELS.length}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("database", 13)}Subsystems</span><strong class="ops-metric-value">${subsystemCount}</strong></div>
        <div class="ops-metric"><span class="ops-metric-label">${opsIcon("shield", 13)}Errors</span><strong class="ops-metric-value">${errorCount}</strong></div>
      </div>

      ${renderOpsTelemetryRail("Log pipeline telemetry", [
        { label: "stream", value: props.error ? "degraded" : "nominal", tone: props.error ? "danger" : "success" },
        { label: "tail", value: props.autoFollow ? "following" : "paused", tone: props.autoFollow ? "accent" : "warning" },
        { label: "buffer", value: `${filtered.length}/${props.entries.length}` },
        { label: "source", value: props.file ? "jsonl" : "awaiting" },
      ])}

      <section class="ops-panel">
        <div class="ops-section-head">
          <div class="ops-heading-group"><span class="ops-heading-icon">${opsIcon("terminal", 19)}</span><div><h2 class="ops-heading">Live console</h2><p class="ops-kicker">Filter the current buffer without interrupting ingestion.</p></div></div>
          <div class="ops-toolbar"><button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>${opsIcon("refresh", 15)}${props.loading ? "Loading…" : "Refresh"}</button><button class="btn" ?disabled=${filtered.length === 0} @click=${() =>
            props.onExport(
              filtered.map((entry) => entry.raw),
              exportLabel,
            )}>${opsIcon("download", 15)}Export ${exportLabel}</button></div>
        </div>
        <div class="ops-control-deck">
          <label><span class="ops-search-label">Search buffer</span><span class="ops-search-wrap">${opsIcon("search", 16)}<input .value=${props.filterText} @input=${(event: Event) => props.onFilterTextChange((event.target as HTMLInputElement).value)} placeholder="Message, subsystem, or raw payload" /></span></label>
          <label class="ops-tail-toggle"><input type="checkbox" .checked=${props.autoFollow} @change=${(event: Event) => props.onToggleAutoFollow((event.target as HTMLInputElement).checked)} /><span class="ops-switch" aria-hidden="true"></span><span>Auto-follow</span></label>
        </div>
        <div class="ops-levels" aria-label="Log level filters">${LEVELS.map((level) => html`<label class="ops-level-chip ${level}"><input type="checkbox" .checked=${props.levelFilters[level]} @change=${(event: Event) => props.onLevelToggle(level, (event.target as HTMLInputElement).checked)} /><span class="ops-level-dot"></span><span>${level}</span></label>`)}</div>
        ${props.file ? html`<div class="ops-file-rail">${opsIcon("database", 13)}<span>${props.file}</span></div>` : nothing}
        <div class="ops-notices">${
          props.truncated
            ? html`
                <div class="callout">Log output truncated; showing latest chunk.</div>
              `
            : nothing
        }${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}</div>
        <div class="ops-console">
          <div class="ops-console-bar" aria-hidden="true"><span>Time</span><span>Level</span><span>Subsystem</span><span>Event</span></div>
          <div class="ops-log-stream" role="log" aria-label="Gateway log entries" aria-live=${props.autoFollow ? "polite" : "off"} aria-relevant="additions text" @scroll=${props.onScroll}>
            ${
              props.loading && props.entries.length === 0
                ? html`<div style="display:grid;gap:8px;padding:12px;">${Array.from(
                    { length: 6 },
                    () =>
                      html`
                        <div class="ops-skeleton"></div>
                      `,
                  )}</div>`
                : filtered.length === 0
                  ? html`<div class="ops-empty"><div><span class="ops-empty-icon">${opsIcon("search", 23)}</span><strong>No matching log entries</strong><span>${props.entries.length === 0 ? "The gateway has not emitted any visible entries yet." : "Adjust the query or enable another level."}</span></div></div>`
                  : filtered.map(
                      (entry) =>
                        html`<div class="ops-log-row"><div class="ops-log-time">${formatTime(entry.time)}</div><div><span class="ops-log-level ${entry.level ?? ""}">${entry.level ?? "event"}</span></div><div class="ops-log-subsystem">${entry.subsystem ?? "gateway"}</div><div class="ops-log-message">${renderTintedMessage(entry.message ?? entry.raw)}</div></div>`,
                    )
            }
          </div>
          <button class="btn ops-console-tail" @click=${(event: Event) => jumpToNow(event, props)}>${
            props.autoFollow
              ? html`
                  <span class="ops-cursor"></span>
                `
              : opsIcon("arrowDown", 15)
          }<span>Jump to now</span></button>
        </div>
      </section>
    </div>
  `;
}
