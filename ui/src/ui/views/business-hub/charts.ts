/**
 * Business hub — hand-rolled SVG charts (no chart library): area/line with a
 * gold gradient and hover readout, bars, a funnel, a donut, sparklines and a
 * cohort heatmap. Colours come from the page tokens so light/dark both work.
 */

import { html, svg, nothing, type TemplateResult } from "lit";

export type Point = { label: string; value: number };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

let gradSeq = 0;

/** Area chart with an optional comparison line and y-axis ticks. */
export function areaChart(
  points: Point[],
  opts: { height?: number; format?: (v: number) => string; compare?: Point[]; empty?: string; ariaLabel?: string } = {},
): TemplateResult {
  const h = opts.height ?? 180;
  const w = 600;
  const pad = { t: 12, r: 8, b: 22, l: 44 };
  const fmt = opts.format ?? ((v: number) => String(Math.round(v)));
  const values = points.map((p) => p.value);
  const max = niceMax(Math.max(0, ...values, ...(opts.compare ?? []).map((p) => p.value)));
  const empty = !points.length || values.every((v) => v === 0);
  const x = (i: number) => pad.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (w - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = points.length ? `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : "";
  const cmp = opts.compare?.length ? opts.compare.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("") : "";
  const id = `bhg${++gradSeq}`;
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  return html`<div class="chart" role="img" aria-label=${opts.ariaLabel ?? "chart"}>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="chart-svg">
      <defs>
        <linearGradient id=${id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--bh-gold)" stop-opacity="0.38"></stop>
          <stop offset="100%" stop-color="var(--bh-gold)" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${ticks.map((t) => svg`<line x1=${pad.l} x2=${w - pad.r} y1=${y(t)} y2=${y(t)} class="grid"></line>
        <text x=${pad.l - 8} y=${y(t) + 4} class="tick" text-anchor="end">${fmt(t)}</text>`)}
      ${empty ? nothing : svg`<path d=${area} fill="url(#${id})"></path>`}
      ${cmp ? svg`<path d=${cmp} class="cmp"></path>` : nothing}
      ${empty ? nothing : svg`<path d=${line} class="line"></path>`}
      ${points.map((p, i) =>
        i % labelEvery === 0 || i === points.length - 1
          ? svg`<text x=${x(i)} y=${h - 4} class="tick" text-anchor=${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>${p.label}</text>`
          : nothing,
      )}
      ${empty
        ? nothing
        : points.map(
            (p, i) => svg`<g class="hit"><rect x=${x(i) - (w - pad.l) / Math.max(points.length, 1) / 2} y=${pad.t} width=${(w - pad.l) / Math.max(points.length, 1)} height=${h - pad.t - pad.b} fill="transparent"></rect>
              <circle cx=${x(i)} cy=${y(p.value)} r="3.5" class="dot"></circle>
              <title>${p.label}: ${fmt(p.value)}</title></g>`,
          )}
    </svg>
    ${empty ? html`<div class="chart-empty">${opts.empty ?? "No data yet"}</div>` : nothing}
  </div>`;
}

/** Stacked area chart for source/project composition over time. */
export function stackedAreaChart(
  series: Array<{ label: string; points: Point[] }>,
  opts: { height?: number; format?: (v: number) => string; empty?: string } = {},
): TemplateResult {
  const labels = Array.from(new Set(series.flatMap((item) => item.points.map((point) => point.label))));
  if (!labels.length || !series.some((item) => item.points.some((point) => point.value > 0)))
    return html`<div class="chart chart-empty">${opts.empty ?? "No revenue in this period."}</div>`;
  const h = opts.height ?? 210;
  const w = 600;
  const pad = { t: 12, r: 8, b: 24, l: 44 };
  const values = series.map((item) => {
    const byLabel = new Map(item.points.map((point) => [point.label, Math.max(0, point.value)]));
    return labels.map((label) => byLabel.get(label) ?? 0);
  });
  const totals = labels.map((_, index) => values.reduce((sum, row) => sum + row[index], 0));
  const max = niceMax(Math.max(...totals, 1));
  const x = (index: number) =>
    pad.l + (labels.length <= 1 ? 0 : (index / (labels.length - 1)) * (w - pad.l - pad.r));
  const y = (value: number) => pad.t + (1 - value / max) * (h - pad.t - pad.b);
  const colours = [
    "var(--bh-gold)",
    "var(--bh-gold-2)",
    "var(--bh-bronze)",
    "var(--bh-ink-3)",
    "var(--bh-ink-4)",
    "var(--bh-ink-5)",
  ];
  const cumulative = labels.map(() => 0);
  const layers = values.map((row, seriesIndex) => {
    const lower = [...cumulative];
    row.forEach((value, index) => (cumulative[index] += value));
    const top = row
      .map((_, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(cumulative[index]).toFixed(1)}`)
      .join("");
    const bottom = lower
      .map((value, index) => ({ value, index }))
      .reverse()
      .map(({ value, index }) => `L${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .join("");
    return { path: `${top}${bottom}Z`, colour: colours[seriesIndex % colours.length] };
  });
  const labelEvery = Math.max(1, Math.ceil(labels.length / 6));
  const fmt = opts.format ?? ((value: number) => String(Math.round(value)));
  return html`<div class="chart stacked-chart" role="img" aria-label="Revenue over time by source">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="chart-svg">
      ${[0, 0.5, 1].map((tick) => svg`<line x1=${pad.l} x2=${w - pad.r} y1=${y(tick * max)} y2=${y(tick * max)} class="grid"></line>
        <text x=${pad.l - 8} y=${y(tick * max) + 4} class="tick" text-anchor="end">${fmt(tick * max)}</text>`)}
      ${layers.map((layer) => svg`<path d=${layer.path} fill=${layer.colour} fill-opacity="0.48" stroke=${layer.colour} stroke-width="1"></path>`)}
      ${labels.map((label, index) =>
        index % labelEvery === 0 || index === labels.length - 1
          ? svg`<text x=${x(index)} y=${h - 4} class="tick" text-anchor=${index === 0 ? "start" : index === labels.length - 1 ? "end" : "middle"}>${label}</text>`
          : nothing,
      )}
    </svg>
    <div class="legend inline">${series.map((item, index) => html`<div class="legend-row"><i style="background:${colours[index % colours.length]}"></i><span>${item.label}</span></div>`)}</div>
  </div>`;
}

/** Horizontal bars, sorted as given. */
export function barList(rows: Array<{ label: string; value: number; sub?: string; href?: string }>, opts: { format?: (v: number) => string; empty?: string; max?: number } = {}): TemplateResult {
  const fmt = opts.format ?? ((v: number) => String(v));
  if (!rows.length) return html`<div class="empty-mini">${opts.empty ?? "Nothing yet"}</div>`;
  const max = opts.max ?? Math.max(...rows.map((r) => r.value), 1);
  return html`<div class="bars">
    ${rows.map(
      (r) => html`<div class="bar-row">
        <div class="bar-label" title=${r.label}>${r.label}${r.sub ? html`<span class="bar-sub">${r.sub}</span>` : nothing}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (r.value / max) * 100).toFixed(1)}%"></div></div>
        <div class="bar-value">${fmt(r.value)}</div>
      </div>`,
    )}
  </div>`;
}

/** Stage funnel: trapezoid-ish bars with conversion between steps. */
export function funnelChart(steps: Array<{ label: string; value: number; conv?: number | null; color?: string | null }>): TemplateResult {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return html`<div class="funnel">
    ${steps.map(
      (s, i) => html`<div class="funnel-step">
        <div class="funnel-label">${s.label}</div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width:${Math.max(3, (s.value / max) * 100).toFixed(1)}%; ${s.color ? `--stage:${s.color}` : ""}"><span>${s.value}</span></div>
        </div>
        <div class="funnel-conv">${i === 0 || s.conv === null || s.conv === undefined ? "" : `${Math.round(s.conv * 100)}%`}</div>
      </div>`,
    )}
  </div>`;
}

/** Donut with a centre label. Segments use graded gold tones. */
export function donut(segments: Array<{ label: string; value: number }>, centre: { value: string; label: string }): TemplateResult {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let off = 0;
  const tones = ["var(--bh-gold)", "var(--bh-gold-2)", "var(--bh-bronze)", "var(--bh-ink-3)", "var(--bh-ink-4)", "var(--bh-ink-5)"];
  return html`<div class="donut-wrap">
    <svg viewBox="0 0 120 120" class="donut" role="img" aria-label=${centre.label}>
      <circle cx="60" cy="60" r=${r} class="donut-bg"></circle>
      ${total
        ? segments.map((s, i) => {
            const len = (s.value / total) * c;
            const el = svg`<circle cx="60" cy="60" r=${r} fill="none" stroke=${tones[i % tones.length]} stroke-width="12"
              stroke-dasharray="${len} ${c - len}" stroke-dashoffset=${-off} transform="rotate(-90 60 60)"><title>${s.label}: ${s.value}</title></circle>`;
            off += len;
            return el;
          })
        : nothing}
      <text x="60" y="58" text-anchor="middle" class="donut-v">${centre.value}</text>
      <text x="60" y="74" text-anchor="middle" class="donut-l">${centre.label}</text>
    </svg>
    <div class="legend">
      ${segments.map((s, i) => html`<div class="legend-row"><i style="background:${tones[i % tones.length]}"></i><span>${s.label}</span><b>${total ? Math.round((s.value / total) * 100) : 0}%</b></div>`)}
    </div>
  </div>`;
}

export function sparkline(values: number[], opts: { w?: number; h?: number } = {}): TemplateResult {
  const w = opts.w ?? 96;
  const h = opts.h ?? 28;
  if (values.length < 2 || values.every((v) => v === 0)) return html`<svg class="spark" viewBox="0 0 ${w} ${h}"><line x1="0" x2=${w} y1=${h - 2} y2=${h - 2} class="spark-flat"></line></svg>`;
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d=${d}></path></svg>`;
}

/** Cohort retention heatmap: rows = first-purchase month, cols = months since. */
export function cohortGrid(rows: Array<{ cohort: string; size: number; cells: Array<number | null> }>, opts: { format?: (v: number) => string } = {}): TemplateResult {
  if (!rows.length) return html`<div class="empty-mini">Cohorts appear after your first paying customers.</div>`;
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const fmt = opts.format ?? ((v: number) => `${Math.round(v * 100)}%`);
  return html`<div class="cohort" style="--cols:${cols}">
    <div class="cohort-row head"><span>Cohort</span><span>Customers</span>${Array.from({ length: cols }, (_, i) => html`<span>M${i}</span>`)}</div>
    ${rows.map(
      (r) => html`<div class="cohort-row">
        <span>${r.cohort}</span><span>${r.size}</span>
        ${Array.from({ length: cols }, (_, i) => {
          const v = r.cells[i];
          return v === null || v === undefined
            ? html`<span class="cell none"></span>`
            : html`<span class="cell" style="--a:${Math.min(1, Math.max(0.06, v)).toFixed(2)}" title=${fmt(v)}>${fmt(v)}</span>`;
        })}
      </div>`,
    )}
  </div>`;
}
