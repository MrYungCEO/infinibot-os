/**
 * Dependency-free SVG charts for trading data: candlesticks (with optional
 * level lines) and a line/area series (equity curve). Colours come from the
 * InfiniBot tokens (--ok / --danger / --accent / --border / --muted), so light
 * and dark themes both work. Returned as Lit templates; the SVG scales to its
 * container width via viewBox.
 */
import { html, nothing, svg, type TemplateResult } from "lit";

export type Candle = { time: number; open: number; high: number; low: number; close: number };

/** Approximate chart width from the viewport (content column minus padding). */
function viewWidth(): number {
  const w = typeof window !== "undefined" ? window.innerWidth : 1200;
  return Math.max(300, Math.min(1100, w < 1025 ? w - 56 : w - 420));
}

function digitsFor(v: number): number {
  const a = Math.abs(v);
  return a >= 1000 ? 1 : a >= 10 ? 2 : 5;
}

function fmt(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: digitsFor(v), maximumFractionDigits: digitsFor(v) });
}

function timeLabel(sec: number, spanSec: number): string {
  const d = new Date(sec * 1000);
  if (spanSec > 20 * 86_400) return d.toISOString().slice(5, 10);
  if (spanSec > 2 * 86_400) return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 13)}h`;
  return d.toISOString().slice(11, 16);
}

export function renderCandleChart(
  candles: Candle[],
  opts: { height?: number; width?: number; levels?: Array<{ price: number; label: string; tone?: "ok" | "danger" | "accent" }>; compact?: boolean } = {},
): TemplateResult {
  if (!candles.length) return html`<div class="chart-empty" style="padding:24px;text-align:center;color:var(--muted)">No candles</div>`;
  // viewBox width ≈ rendered width so axis text isn't stretched/squashed.
  const W = opts.width ?? viewWidth();
  const H = opts.height ?? 320;
  const padR = opts.compact ? 6 : 64;
  const padB = opts.compact ? 4 : 22;
  const padT = 8;
  const levels = opts.levels ?? [];
  const lo = Math.min(...candles.map((c) => c.low), ...levels.map((l) => l.price));
  const hi = Math.max(...candles.map((c) => c.high), ...levels.map((l) => l.price));
  const range = hi - lo || hi * 0.001 || 1;
  const y = (p: number) => padT + ((hi - p) / range) * (H - padT - padB);
  const n = candles.length;
  const slot = (W - padR) / n;
  const body = Math.max(1, slot * 0.64);
  const x = (i: number) => i * slot + slot / 2;
  const ticks = opts.compact ? [] : [0, 0.25, 0.5, 0.75, 1].map((f) => lo + range * f);
  const span = candles[n - 1].time - candles[0].time;
  const xTicks = opts.compact ? [] : W < 500 ? [0, n - 1] : [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1];
  const last = candles[n - 1].close;
  const toneVar = (t?: string) => (t === "ok" ? "var(--ok)" : t === "danger" ? "var(--danger)" : "var(--accent)");
  return html`<svg class="candle-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
    aria-label="Candlestick chart, ${n} bars, last ${fmt(last)}" style="width:100%;height:${H}px;display:block">
    ${ticks.map(
      (p) => svg`<line x1="0" x2=${W - padR} y1=${y(p)} y2=${y(p)} stroke="var(--border)" stroke-width="1" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>
        <text x=${W - padR + 6} y=${y(p) + 4} font-size="11" fill="var(--muted)" font-family="var(--mono)">${fmt(p)}</text>`,
    )}
    ${xTicks.map(
      (i, k) => svg`<text x=${k === 0 ? 2 : k === xTicks.length - 1 ? W - padR - 2 : x(i)} y=${H - 6} font-size="11" fill="var(--muted)" text-anchor=${k === 0 ? "start" : k === xTicks.length - 1 ? "end" : "middle"} font-family="var(--mono)">${timeLabel(candles[i].time, span)}</text>`,
    )}
    ${candles.map((c, i) => {
      const up = c.close >= c.open;
      const col = up ? "var(--ok)" : "var(--danger)";
      const top = y(Math.max(c.open, c.close));
      const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
      return svg`<line x1=${x(i)} x2=${x(i)} y1=${y(c.high)} y2=${y(c.low)} stroke=${col} stroke-width="1" vector-effect="non-scaling-stroke"/>
        <rect x=${x(i) - body / 2} y=${top} width=${body} height=${h} fill=${up ? "none" : col} stroke=${col} stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    })}
    ${levels.map(
      (l) => svg`<line x1="0" x2=${W - padR} y1=${y(l.price)} y2=${y(l.price)} stroke=${toneVar(l.tone)} stroke-width="1" stroke-dasharray="6 3" vector-effect="non-scaling-stroke"/>
        ${opts.compact ? nothing : svg`<text x="6" y=${y(l.price) - 4} font-size="11" fill=${toneVar(l.tone)}>${l.label} ${fmt(l.price)}</text>`}`,
    )}
    ${opts.compact
      ? nothing
      : svg`<rect x=${W - padR + 2} y=${y(last) - 9} width=${padR - 4} height="18" fill="var(--accent)" rx="2"/>
        <text x=${W - padR + 6} y=${y(last) + 4} font-size="11" fill="var(--accent-foreground)" font-family="var(--mono)">${fmt(last)}</text>`}
  </svg>`;
}

/** Line + soft area for a cumulative series (e.g. equity curve). */
export function renderLineChart(points: Array<{ t: string; v: number }>, opts: { height?: number } = {}): TemplateResult {
  if (points.length < 2) return html`<div style="padding:24px;text-align:center;color:var(--muted)">Not enough data</div>`;
  const W = viewWidth();
  const H = opts.height ?? 180;
  const vals = points.map((p) => p.v);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const range = hi - lo || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => 6 + ((hi - v) / range) * (H - 12);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${W},${y(0).toFixed(1)} L0,${y(0).toFixed(1)} Z`;
  const up = vals[vals.length - 1] >= 0;
  const col = up ? "var(--ok)" : "var(--danger)";
  return html`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Equity curve" style="width:100%;height:${H}px;display:block">
    <line x1="0" x2=${W} y1=${y(0)} y2=${y(0)} stroke="var(--border-strong)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    <path d=${area} fill=${col} opacity="0.12"/>
    <path d=${line} fill="none" stroke=${col} stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
