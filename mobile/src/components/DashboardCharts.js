/**
 * DashboardCharts — lightweight, theme-aware SVG visualizations for the
 * mobile Dashboard screen. These port the web dashboard's inline-SVG
 * renderers (renderSparkline / renderHourlyBars / renderDonut / renderGauge)
 * to react-native-svg so the mobile dashboard keeps visual parity without
 * any DOM or charting library.
 *
 * Every chart reads colours through the live COLORS proxy so they follow the
 * master theme. All are pure presentational components.
 */

import React from 'react';
import { View } from 'react-native';
import Svg, {
  Path,
  Circle,
  Rect,
  G,
  Line,
  Text as SvgText,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
} from 'react-native-svg';
import { COLORS } from '../constants/theme';
import { withAlpha } from '../theme/color-utils';

// ── Sparkline ────────────────────────────────────────────────────────────
// Tiny trend line for KPI tiles. `data` = array of numbers.
export function Sparkline({ data = [], width = 80, height = 28, color, strokeWidth = 1.6 }) {
  const stroke = color || COLORS.primary;
  const pts = (data || []).filter((n) => Number.isFinite(n));
  if (pts.length < 2) {
    return <View style={{ width, height }} />;
  }
  const max = Math.max(...pts);
  const min = Math.min(...pts);
  const range = max - min || 1;
  const stepX = width / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaD = `${d} L${width},${height} L0,${height} Z`;
  return (
    <Svg width={width} height={height}>
      <Defs>
        <SvgLinearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={stroke} stopOpacity="0.25" />
          <Stop offset="1" stopColor={stroke} stopOpacity="0" />
        </SvgLinearGradient>
      </Defs>
      <Path d={areaD} fill="url(#spark-fill)" />
      <Path d={d} stroke={stroke} strokeWidth={strokeWidth} fill="none" strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

// ── Bar chart ────────────────────────────────────────────────────────────
// Generic vertical-bar chart. Used for the 24h Activity Timeline (with an
// optional secondary overlay series) and for the 30-day Revenue chart.
export function BarChart({
  data = [],
  overlay = null,
  width = 320,
  height = 90,
  color,
  overlayColor,
  gap = 2,
}) {
  const bars = (data || []).map((n) => (Number.isFinite(n) ? n : 0));
  if (!bars.length) return <View style={{ width, height }} />;
  const fill = color || COLORS.primary;
  const oFill = overlayColor || COLORS.info;
  const allVals = overlay ? bars.concat(overlay) : bars;
  const max = Math.max(...allVals, 1);
  const barW = (width - gap * (bars.length - 1)) / bars.length;
  return (
    <Svg width={width} height={height}>
      {bars.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 2));
        const x = i * (barW + gap);
        return (
          <Rect
            key={`b${i}`}
            x={x}
            y={height - h}
            width={Math.max(1, barW)}
            height={h}
            rx={Math.min(2, barW / 2)}
            fill={withAlpha(fill, v > 0 ? 0.85 : 0.18)}
          />
        );
      })}
      {overlay &&
        overlay.map((v, i) => {
          const h = Math.max(0, (v / max) * (height - 2));
          if (h <= 0) return null;
          const x = i * (barW + gap) + barW * 0.28;
          return (
            <Rect
              key={`o${i}`}
              x={x}
              y={height - h}
              width={Math.max(1, barW * 0.44)}
              height={h}
              rx={1}
              fill={withAlpha(oFill, 0.9)}
            />
          );
        })}
    </Svg>
  );
}

// ── Donut ────────────────────────────────────────────────────────────────
// segments = [{ value, color, label }]. Renders a ring with a center label.
export function Donut({ segments = [], size = 120, thickness = 16, centerValue, centerLabel }) {
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((s, seg) => s + (seg.value || 0), 0) || 1;
  let offset = 0;

  return (
    <Svg width={size} height={size}>
      <G rotation="-90" origin={`${cx}, ${cy}`}>
        <Circle cx={cx} cy={cy} r={radius} stroke={withAlpha(COLORS.text, 0.06)} strokeWidth={thickness} fill="none" />
        {segments.map((seg, i) => {
          const frac = (seg.value || 0) / total;
          const dash = frac * circumference;
          const el = (
            <Circle
              key={i}
              cx={cx}
              cy={cy}
              r={radius}
              stroke={seg.color || COLORS.primary}
              strokeWidth={thickness}
              fill="none"
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += dash;
          return el;
        })}
      </G>
      {(centerValue != null || centerLabel) && (
        <>
          <SvgText
            x={cx}
            y={cy + (centerLabel ? -2 : 5)}
            fontSize={size * 0.22}
            fontWeight="700"
            fill={COLORS.text}
            textAnchor="middle"
          >
            {String(centerValue ?? '')}
          </SvgText>
          {centerLabel ? (
            <SvgText x={cx} y={cy + size * 0.15} fontSize={size * 0.09} fill={COLORS.textMuted} textAnchor="middle">
              {centerLabel}
            </SvgText>
          ) : null}
        </>
      )}
    </Svg>
  );
}

// ── Gauge ────────────────────────────────────────────────────────────────
// Half-circle gauge. value 0..100.
export function Gauge({ value = 0, size = 96, thickness = 10, color, label, sublabel }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = Math.PI; // 180deg
  const endAngle = Math.PI * 2; // 360deg → bottom half-circle sweep (top arc)
  const angle = startAngle + (pct / 100) * (endAngle - startAngle);

  const pointFor = (a) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  const [sx, sy] = pointFor(startAngle);
  const [ex, ey] = pointFor(angle);
  const [tx, ty] = pointFor(endAngle);
  const large = pct > 50 ? 1 : 0;
  const stroke = color || COLORS.primary;

  return (
    <Svg width={size} height={size / 1.7}>
      {/* track */}
      <Path
        d={`M ${sx} ${sy} A ${radius} ${radius} 0 1 1 ${tx} ${ty}`}
        stroke={withAlpha(COLORS.text, 0.08)}
        strokeWidth={thickness}
        fill="none"
        strokeLinecap="round"
      />
      {/* value */}
      {pct > 0 && (
        <Path
          d={`M ${sx} ${sy} A ${radius} ${radius} 0 ${large} 1 ${ex} ${ey}`}
          stroke={stroke}
          strokeWidth={thickness}
          fill="none"
          strokeLinecap="round"
        />
      )}
      <SvgText x={cx} y={cy - 2} fontSize={size * 0.2} fontWeight="700" fill={COLORS.text} textAnchor="middle">
        {label != null ? label : `${Math.round(pct)}%`}
      </SvgText>
      {sublabel ? (
        <SvgText x={cx} y={cy + size * 0.12} fontSize={size * 0.1} fill={COLORS.textMuted} textAnchor="middle">
          {sublabel}
        </SvgText>
      ) : null}
    </Svg>
  );
}

// ── Mini Gantt timeline (discipline blocks) ───────────────────────────────
// blocks = [{ startMin, endMin, state }] where state ∈ done|active|todo
export function DayTimeline({ blocks = [], width = 320, height = 16 }) {
  const DAY = 24 * 60;
  const colorFor = (s) =>
    s === 'done' ? COLORS.success : s === 'active' ? COLORS.primary : withAlpha(COLORS.text, 0.14);
  return (
    <Svg width={width} height={height}>
      <Rect x={0} y={0} width={width} height={height} rx={height / 2} fill={withAlpha(COLORS.text, 0.05)} />
      {(blocks || []).map((b, i) => {
        const x = (Math.max(0, b.startMin) / DAY) * width;
        const w = Math.max(2, ((Math.min(DAY, b.endMin) - Math.max(0, b.startMin)) / DAY) * width);
        return <Rect key={i} x={x} y={2} width={w} height={height - 4} rx={(height - 4) / 2} fill={colorFor(b.state)} />;
      })}
    </Svg>
  );
}

export default { Sparkline, BarChart, Donut, Gauge, DayTimeline };
