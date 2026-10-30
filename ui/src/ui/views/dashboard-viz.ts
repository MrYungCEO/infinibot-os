/**
 * Tiny SVG data-viz primitives for the dashboard. Inline, dependency-free,
 * theme-aware (color in / size in). All return `TemplateResult` so they slot
 * straight into Lit templates.
 *
 * Sparkline   → narrow line graph with optional area fill
 * Hourly bars → 24-cell bar series (used for activity timeline)
 * Donut       → segmented donut chart (used for project velocity)
 * Gauge       → arc gauge (used for CPU/GPU/RAM health)
 */

import { html, svg, type TemplateResult } from "lit";

export interface SparklineOpts {
  width?: number;
  height?: number;
  color?: string;
  fill?: string;
  stroke?: number;
}

export function renderSparkline(values: number[], opts: SparklineOpts = {}): TemplateResult {
  const w = opts.width ?? 100;
  const h = opts.height ?? 28;
  const stroke = opts.stroke ?? 1.5;
  const color = opts.color ?? "var(--glass-gold, var(--dash-gold, #ffd700))";
  const fill = opts.fill ?? "var(--glass-gold-a16, rgba(255,215,0,0.14))";
  if (values.length === 0) return html`<svg width=${w} height=${h}></svg>`;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);
  const step = values.length > 1 ? w / (values.length - 1) : w;

  const points = values.map((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * (h - stroke * 2) - stroke;
    return [x, y] as const;
  });
  const path = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;

  return html`
    <svg viewBox="0 0 ${w} ${h}" width=${w} height=${h} class="dash-spark" preserveAspectRatio="none">
      <path d=${area} fill=${fill} stroke="none" />
      <path d=${path} fill="none" stroke=${color} stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" />
      ${points.slice(-1).map(
        ([x, y]) => svg`<circle cx=${x} cy=${y} r="2.2" fill=${color} />`,
      )}
    </svg>
  `;
}

export interface HourlyBarsOpts {
  width?: number;
  height?: number;
  color?: string;
  /** Optional secondary series rendered as a thin overlay line. */
  overlay?: number[];
  overlayColor?: string;
  /** Hour labels every Nth bar (default: every 4h). */
  labelEvery?: number;
}

export function renderHourlyBars(
  values: number[],
  opts: HourlyBarsOpts = {},
): TemplateResult {
  const w = opts.width ?? 760;
  const h = opts.height ?? 100;
  const color = opts.color ?? "var(--glass-gold, var(--dash-gold, #ffd700))";
  const overlayColor = opts.overlayColor ?? "var(--dash-info, #38bdf8)";
  const labelEvery = opts.labelEvery ?? 4;
  const padBottom = 14;
  const usableH = h - padBottom;

  const max = Math.max(1, ...values, ...(opts.overlay ?? []));
  const bw = w / values.length;
  const gap = Math.min(2, bw * 0.15);
  const barW = bw - gap;

  const overlay = opts.overlay;
  let overlayPath = "";
  if (overlay && overlay.length === values.length) {
    overlayPath = overlay
      .map((v, i) => {
        const x = i * bw + bw / 2;
        const y = usableH - (v / max) * usableH;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  const now = new Date();
  const baseHour = now.getHours();

  return html`
    <svg viewBox="0 0 ${w} ${h}" width="100%" height=${h} class="dash-bars" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dash-bar-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color=${color} stop-opacity="0.95" />
          <stop offset="100%" stop-color=${color} stop-opacity="0.35" />
        </linearGradient>
      </defs>
      ${values.map((v, i) => {
        const barH = (v / max) * usableH;
        const x = i * bw + gap / 2;
        const y = usableH - barH;
        return svg`
          <rect
            x=${x.toFixed(2)}
            y=${y.toFixed(2)}
            width=${barW.toFixed(2)}
            height=${Math.max(1, barH).toFixed(2)}
            rx="1.5"
            fill="url(#dash-bar-grad)"
          >
            <title>${v} task${v === 1 ? "" : "s"} · ${labelHour(baseHour, i, values.length)}</title>
          </rect>
        `;
      })}
      ${overlayPath
        ? svg`<path d=${overlayPath} fill="none" stroke=${overlayColor} stroke-width="1.5" stroke-linecap="round" stroke-dasharray="3 2" />`
        : null}
      ${values.map((_v, i) => {
        if (i % labelEvery !== 0) return null;
        const x = i * bw + bw / 2;
        const text = labelHour(baseHour, i, values.length);
        return svg`
          <text
            x=${x.toFixed(1)}
            y=${h - 2}
            text-anchor="middle"
            font-size="9"
            font-family="ui-monospace,monospace"
            fill="var(--glass-fg-4, rgba(245,245,244,0.42))"
          >${text}</text>
        `;
      })}
    </svg>
  `;
}

function labelHour(currentHour: number, i: number, total: number): string {
  // Buckets are ordered oldest → newest; the last bucket is "now".
  const hoursAgo = total - 1 - i;
  const h = (currentHour - hoursAgo + 24) % 24;
  return `${h.toString().padStart(2, "0")}h`;
}

// ── Donut ────────────────────────────────────────────────────

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export interface DonutOpts {
  size?: number;
  thickness?: number;
  /** Center label override (defaults to total). */
  centerValue?: string;
  centerLabel?: string;
}

export function renderDonut(slices: DonutSlice[], opts: DonutOpts = {}): TemplateResult {
  const size = opts.size ?? 140;
  const thickness = opts.thickness ?? 14;
  const r = size / 2 - thickness / 2;
  const c = size / 2;
  const total = slices.reduce((s, x) => s + Math.max(0, x.value), 0);
  const circumference = 2 * Math.PI * r;

  let offset = 0;
  const arcs: TemplateResult[] = [];
  if (total > 0) {
    for (const slice of slices) {
      const frac = Math.max(0, slice.value) / total;
      const len = frac * circumference;
      arcs.push(svg`
        <circle
          cx=${c} cy=${c} r=${r}
          fill="none"
          stroke=${slice.color}
          stroke-width=${thickness}
          stroke-dasharray="${len.toFixed(2)} ${(circumference - len).toFixed(2)}"
          stroke-dashoffset=${(-offset).toFixed(2)}
          transform="rotate(-90 ${c} ${c})"
        >
          <title>${slice.label}: ${slice.value}</title>
        </circle>
      `);
      offset += len;
    }
  } else {
    arcs.push(svg`
      <circle cx=${c} cy=${c} r=${r} fill="none" stroke="var(--glass-stroke, rgba(255,255,255,0.07))" stroke-width=${thickness} />
    `);
  }

  return html`
    <svg viewBox="0 0 ${size} ${size}" width=${size} height=${size} class="dash-donut">
      ${arcs}
      <text
        x=${c} y=${c - 2}
        text-anchor="middle"
        font-size="22"
        font-weight="700"
        font-family="ui-monospace,monospace"
        fill="var(--dash-fg, #f5f5f4)"
        dominant-baseline="middle"
      >${opts.centerValue ?? String(total)}</text>
      ${opts.centerLabel
        ? svg`
            <text
              x=${c} y=${c + 16}
              text-anchor="middle"
              font-size="9"
              letter-spacing="0.08em"
              font-family="ui-monospace,monospace"
              fill="var(--dash-fg-faint, rgba(245,245,244,0.45))"
            >${opts.centerLabel.toUpperCase()}</text>
          `
        : null}
    </svg>
  `;
}

// ── Gauge (arc) ──────────────────────────────────────────────

export interface GaugeOpts {
  size?: number;
  thickness?: number;
  label?: string;
  /** Tone color override; default scales red→yellow→green by value. */
  color?: string;
}

export function renderGauge(pct: number, opts: GaugeOpts = {}): TemplateResult {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const size = opts.size ?? 96;
  const thickness = opts.thickness ?? 8;
  const r = size / 2 - thickness / 2;
  const c = size / 2;

  // Open arc from 135° to 405° (270° sweep, bottom open).
  const startAngle = 135;
  const endAngle = 405;
  const sweep = endAngle - startAngle;
  const valueSweep = (sweep * clamped) / 100;

  const polar = (angle: number) => {
    const rad = (angle * Math.PI) / 180;
    return [c + r * Math.cos(rad), c + r * Math.sin(rad)];
  };
  const [sx, sy] = polar(startAngle);
  const [ex, ey] = polar(endAngle);
  const [vx, vy] = polar(startAngle + valueSweep);
  const largeArc = sweep > 180 ? 1 : 0;
  const valueLargeArc = valueSweep > 180 ? 1 : 0;

  const color =
    opts.color ?? (clamped < 60 ? "#22c55e" : clamped < 85 ? "#f59e0b" : "#ef4444");

  const trackPath = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  const valuePath = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${valueLargeArc} 1 ${vx.toFixed(2)} ${vy.toFixed(2)}`;

  return html`
    <svg viewBox="0 0 ${size} ${size}" width=${size} height=${size} class="dash-gauge">
      <path d=${trackPath} fill="none" stroke="var(--glass-stroke, rgba(255,255,255,0.07))" stroke-width=${thickness} stroke-linecap="round" />
      <path d=${valuePath} fill="none" stroke=${color} stroke-width=${thickness} stroke-linecap="round" />
      <text
        x=${c} y=${c}
        text-anchor="middle"
        font-size="18"
        font-weight="700"
        font-family="ui-monospace,monospace"
        fill="var(--dash-fg, #f5f5f4)"
        dominant-baseline="middle"
      >${clamped}<tspan font-size="11" fill="var(--dash-fg-faint, rgba(245,245,244,0.45))" dx="1">%</tspan></text>
      ${opts.label
        ? svg`
            <text
              x=${c} y=${size - 6}
              text-anchor="middle"
              font-size="9"
              letter-spacing="0.1em"
              font-family="ui-monospace,monospace"
              fill="var(--dash-fg-faint, rgba(245,245,244,0.45))"
            >${opts.label.toUpperCase()}</text>
          `
        : null}
    </svg>
  `;
}
