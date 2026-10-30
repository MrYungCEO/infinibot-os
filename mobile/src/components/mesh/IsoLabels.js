/**
 * IsoLabels — the Agent Mesh's counter-scaled HUD text, drawn in SCREEN space
 * over the world (camera {k,x,y}) with the web's sizing rules:
 *   · zone / room / HQ / Executive labels: hud.ts ZoneLabel, scale clamp(1/k, 0.7, 2.2)·k
 *   · agent nameplates + progress bars: activity-map.ts, clamp(1/k, 0.32, 1.8)·k,
 *     active agents at k ≥ 0.5, resting ones at k ≥ 0.72
 *   · coder build tags: world-map-coder-builds.ts (212 px cards, 5 full then pills)
 *   · Auditor tag + "Screenshots · N" button: review-mesh-layer.ts
 * Returns hit rects for the tappable bits (tags, Auditor, screenshots).
 */
import React, { memo } from 'react';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { GALACTIC } from '../../lib/mesh/mesh-assets';
import { MONO } from './mesh-style';
import { ellip, layoutLabels, textW } from '../../lib/mesh/label-layout';

export { layoutLabels };

const SANS = 'System';

function ZonePlate({ z }) {
  const title = z.title.toUpperCase();
  const sub = (z.subtitle || '').toUpperCase();
  const tsz = z.titleSize;
  const w = Math.max(textW(title, tsz, 2, 0.62), sub ? textW(sub, 8, 1.5, 0.62) : 0) + 24 + 14;
  const h = 10 + tsz * 1.25 + (sub ? 11 : 0);
  const top = -h - 12;
  return (
    <G transform={`translate(${z.x} ${z.y}) scale(${z.scale})`} opacity={z.alpha}>
      <Rect x={-w / 2} y={top} width={w} height={h} rx={5} fill="#0a0a0c" fillOpacity={0.86} stroke={GALACTIC.gold} strokeOpacity={0.7} strokeWidth={1} />
      <Rect x={-w / 2 + 1.5} y={top + 3} width={2.5} height={h - 6} fill={z.accent || GALACTIC.goldLt} fillOpacity={0.9} />
      <Line x1={0} y1={-12} x2={0} y2={-2} stroke={GALACTIC.gold} strokeOpacity={0.5} strokeWidth={1} />
      <Rect x={-2} y={-3} width={4} height={4} fill={GALACTIC.goldLt} fillOpacity={0.9} />
      <SvgText x={-w / 2 + 12} y={top + 5 + tsz} fill={GALACTIC.goldLt} fontSize={tsz} fontWeight="600" letterSpacing={2} fontFamily={SANS}>{title}</SvgText>
      {sub ? <SvgText x={-w / 2 + 12} y={top + 5 + tsz + 10.5} fill={GALACTIC.muted} fontSize={8} fontWeight="500" letterSpacing={1.5} fontFamily={SANS}>{sub}</SvgText> : null}
    </G>
  );
}

function Nameplate({ p }) {
  const tw = textW(p.text, 9, 0.6);
  const w = 8 + tw + 12;
  const h = 14;
  return (
    <G transform={`translate(${p.x} ${p.y}) scale(${p.scale})`}>
      <Rect x={-w / 2} y={3} width={w} height={h} rx={5} fill="#000" fillOpacity={0.38} />
      <Rect x={-w / 2} y={0} width={w} height={h} rx={5} fill={GALACTIC.panel} fillOpacity={0.96} stroke={GALACTIC.gold} strokeOpacity={0.7} strokeWidth={1} />
      <Rect x={-w / 2 + 1} y={1} width={w - 2} height={h / 2 - 1} rx={4} fill={GALACTIC.goldLt} fillOpacity={0.1} />
      <Circle cx={-w / 2 + 7} cy={h / 2} r={4} fill={p.color} fillOpacity={0.3} />
      <Circle cx={-w / 2 + 7} cy={h / 2} r={2.2} fill={p.color} />
      <SvgText x={-w / 2 + 14} y={h / 2 + 3.2} fill={GALACTIC.goldLt} fontSize={9} fontWeight="700" fontFamily={MONO}>{p.text}</SvgText>
      {p.progress != null ? (
        <G>
          <Rect x={-27} y={h + 3} width={54} height={4} rx={2} fill={GALACTIC.glass} fillOpacity={0.92} stroke={GALACTIC.goldDp} strokeOpacity={0.45} strokeWidth={0.6} />
          <Rect x={-27} y={h + 3} width={(54 * p.progress) / 100} height={4} rx={2} fill={p.progress >= 90 ? '#22c55e' : GALACTIC.goldLt} />
        </G>
      ) : null}
    </G>
  );
}

function BuildTag({ t }) {
  const s = t.scale;
  return (
    <G>
      <Line x1={t.leader.x1} y1={t.leader.y1} x2={t.leader.x2} y2={t.leader.y2} stroke={t.color} strokeOpacity={0.6} strokeWidth={1} />
      <G transform={`translate(${t.x} ${t.y}) scale(${s})`}>
        <Rect x={0} y={0} width={212} height={54} rx={8} fill="#07060e" fillOpacity={0.9} stroke={t.color} strokeOpacity={0.5} strokeWidth={1} />
        <Rect x={0} y={0} width={212} height={54} rx={8} fill={t.color} fillOpacity={0.08} />
        <Rect x={0} y={4} width={2} height={46} fill={t.color} />
        <Circle cx={14} cy={15} r={6} fill="none" stroke={t.color} strokeWidth={1.2} />
        <SvgText x={14} y={18} fill={t.color} fontSize={8} fontWeight="700" textAnchor="middle" fontFamily={MONO}>C</SvgText>
        <SvgText x={25} y={19} fill="#f6edd2" fontSize={10.5} fontWeight="700" fontFamily={MONO}>{ellip(String(t.title || ''), t.pct ? 22 : 26)}</SvgText>
        {t.pct ? <SvgText x={204} y={19} fill={t.color} fontSize={10} fontWeight="700" textAnchor="end" fontFamily={MONO}>{t.pct}</SvgText> : null}
        <SvgText x={10} y={36} fill="rgba(239,230,204,0.62)" fontSize={9} fontFamily={MONO}>{ellip(t.sub, 33)}</SvgText>
        <Rect x={10} y={44} width={192} height={3} rx={1.5} fill="rgba(255,255,255,0.08)" />
        <Rect x={10} y={44} width={t.done ? 192 : t.progress > 0 ? (192 * Math.min(100, t.progress)) / 100 : 66} height={3} rx={1.5} fill={t.color} />
      </G>
    </G>
  );
}

function BuildPill({ t }) {
  return (
    <G transform={`translate(${t.x} ${t.y}) scale(${t.scale})`}>
      <Rect x={0} y={0} width={120} height={22} rx={11} fill="#07060e" fillOpacity={0.9} stroke={t.color} strokeOpacity={0.5} strokeWidth={1} />
      <Circle cx={11} cy={11} r={3} fill={t.color} />
      <SvgText x={20} y={14.5} fill="#f6edd2" fontSize={9} fontWeight="700" fontFamily={MONO}>{ellip(String(t.title || ''), t.pct ? 12 : 16)}</SvgText>
      {t.pct ? <SvgText x={112} y={14.5} fill={t.color} fontSize={9} fontWeight="700" textAnchor="end" fontFamily={MONO}>{t.pct}</SvgText> : null}
    </G>
  );
}

export const IsoLabels = memo(function IsoLabels({ layout, size, labelsHidden }) {
  if (!layout || !size.w) return null;
  const { auditor } = layout;
  return (
    <Svg width={size.w} height={size.h} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
      {labelsHidden ? null : layout.zones.map((z) => <ZonePlate key={z.id} z={z} />)}
      {labelsHidden ? null : layout.plates.map((p) => <Nameplate key={p.key} p={p} />)}
      {layout.pills.map((t) => <BuildPill key={t.key} t={t} />)}
      {layout.tags.map((t) => <BuildTag key={t.key} t={t} />)}
      {auditor ? (
        <G>
          <G transform={`translate(${auditor.tag.x} ${auditor.tag.y}) scale(${auditor.tag.scale})`}>
            <Rect x={0} y={0} width={auditor.tag.w / auditor.tag.scale} height={22} rx={11} fill="#1e1808" fillOpacity={0.86} stroke="rgba(245,197,66,0.55)" strokeWidth={1} />
            <Circle cx={13} cy={11} r={5} fill="none" stroke="#fde68a" strokeWidth={1.2} />
            <SvgText x={24} y={15} fill="#fde68a" fontSize={11} fontWeight="600" fontFamily={SANS}>Auditor · Reviewer</SvgText>
          </G>
          <G transform={`translate(${auditor.btn.x} ${auditor.btn.y}) scale(${auditor.btn.scale})`}>
            <Rect x={0} y={0} width={auditor.btn.w / auditor.btn.scale} height={22} rx={11} fill="#0a0a10" fillOpacity={0.86} stroke="rgba(148,163,184,0.45)" strokeWidth={1} />
            <SvgText x={12} y={15} fill="#e8e6e3" fontSize={10.5} fontWeight="600" fontFamily={SANS}>{auditor.btn.label}</SvgText>
          </G>
        </G>
      ) : null}
    </Svg>
  );
});
