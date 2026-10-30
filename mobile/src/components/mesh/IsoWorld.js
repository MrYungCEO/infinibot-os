/**
 * IsoWorld — the Agent Mesh station drawn natively with react-native-svg, in
 * the web engine's world coordinates (ui/src/ui/views/agent-ops/activity-map.ts
 * + iso/*): nebula, platform slab + checkerboard floor + gold trim, sector
 * tints and borders, the web's own baked prop art, Gateway Concourse beds,
 * Executive Suite + Auditor, the Plugin District (rooms, conduits, monogram
 * signs), federation islands, heatmap blobs and every agent (sprite, halo,
 * status pip, provider badge, Zzz while resting).
 *
 * Camera-dependent HUD text (zone labels, nameplates, build tags) is drawn by
 * IsoLabels in screen space, counter-scaled the way the web does it.
 */
import React, { memo } from 'react';
import Svg, { Circle, Defs, Ellipse, G, Image as SvgImage, Line, Path, Polygon, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';

import { AGENT_SPRITES, GALACTIC, PROP_IMAGES, PROP_SIZE, PROVIDER_BADGES } from '../../lib/mesh/mesh-assets';
import { CENTER } from '../../lib/mesh/world';
import { STATUS_COLOR, spriteSlot, badgeFor, heatColor } from './mesh-style';

const pts = (arr) => arr.map((p) => `${p.x},${p.y}`).join(' ');

function Platform({ geo, trimAlpha = 0.9 }) {
  const { corners } = geo;
  return (
    <G>
      <Polygon points={pts(geo.leftFace)} fill="#080705" />
      <Polygon points={pts(geo.rightFace)} fill="#0a0906" />
      <Polygon points={pts(geo.top)} fill={GALACTIC.floor} />
      <Path d={geo.altPath} fill={GALACTIC.floorAlt} />
      <Path d={geo.seamPath} stroke={GALACTIC.goldDp} strokeOpacity={0.22} strokeWidth={1} fill="none" />
      <Polygon points={pts(geo.top)} fill="none" stroke={GALACTIC.gold} strokeOpacity={trimAlpha} strokeWidth={3} />
      {[corners.top, corners.right, corners.bottom, corners.left].map((p, i) => (
        <Rect key={i} x={p.x - 3} y={p.y - 3} width={6} height={6} fill={GALACTIC.goldLt} fillOpacity={0.95} />
      ))}
    </G>
  );
}

function Prop({ item }) {
  const size = PROP_SIZE[item.t];
  const src = PROP_IMAGES[item.t];
  if (!size || !src) return null;
  const w = size[0] * (item.s || 1);
  const h = size[1] * (item.s || 1);
  return <SvgImage href={src} x={item.x - w / 2} y={item.y - h} width={w} height={h} preserveAspectRatio="none" />;
}

function Dashed({ a, b, color = GALACTIC.gold, opacity = 0.5, width = 2, dash = '10 10' }) {
  return <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeOpacity={opacity} strokeWidth={width} strokeDasharray={dash} />;
}

const AtriumRing = memo(function AtriumRing({ c }) {
  const R = 64 * 1.9;
  const arcs = [];
  for (let i = 0; i < 8; i++) {
    const a0 = (i * Math.PI) / 4 + 0.08;
    const a1 = ((i + 1) * Math.PI) / 4 - 0.08;
    arcs.push(`M${c.x + Math.cos(a0) * R} ${c.y + Math.sin(a0) * R * 0.5}A${R} ${R * 0.5} 0 0 1 ${c.x + Math.cos(a1) * R} ${c.y + Math.sin(a1) * R * 0.5}`);
  }
  let ticks = '';
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI * 2) / 12;
    ticks += `M${c.x + Math.cos(a) * (R - 10)} ${c.y + Math.sin(a) * (R - 10) * 0.5}L${c.x + Math.cos(a) * (R - 2)} ${c.y + Math.sin(a) * (R - 2) * 0.5}`;
  }
  return (
    <G>
      <Path d={arcs.join('')} stroke={GALACTIC.goldLt} strokeOpacity={0.4} strokeWidth={2.5} fill="none" />
      <Path d={ticks} stroke={GALACTIC.gold} strokeOpacity={0.3} strokeWidth={1} fill="none" />
      <Ellipse cx={c.x} cy={c.y} rx={R * 0.78} ry={R * 0.78 * 0.5} stroke={GALACTIC.gold} strokeOpacity={0.22} strokeWidth={1} fill="none" />
    </G>
  );
});

/** The static station (re-rendered only when rooms / islands / active sectors change). */
export const StationLayer = memo(function StationLayer({ station, district, islands, activeZones, activeRooms, showSigns }) {
  return (
    <G>
      <Ellipse cx={CENTER.x} cy={CENTER.y} rx={(48 * 64) / 2 * 0.95} ry={(48 * 32) / 2 * 1.05} fill={GALACTIC.nebula} fillOpacity={0.35} />
      {/* Bridges + plugin-district conduits under the platforms */}
      <Dashed a={station.exec.bridge[0]} b={station.exec.bridge[1]} />
      {islands.map((isl) => (
        <G key={`br-${isl.node.id}`}>
          <Line x1={isl.bridge[0].x} y1={isl.bridge[0].y + 2} x2={isl.bridge[1].x} y2={isl.bridge[1].y + 2} stroke="#000" strokeOpacity={0.22} strokeWidth={2} strokeDasharray="12 9" />
          <Path
            d={`M${isl.bridge[0].x} ${isl.bridge[0].y}Q${(isl.bridge[0].x + isl.bridge[1].x) / 2} ${Math.min(isl.bridge[0].y, isl.bridge[1].y) - Math.max(40, Math.hypot(isl.bridge[0].x - isl.bridge[1].x, isl.bridge[0].y - isl.bridge[1].y) * 0.22)} ${isl.bridge[1].x} ${isl.bridge[1].y}`}
            stroke={GALACTIC.gold} strokeOpacity={0.6} strokeWidth={2} strokeDasharray="12 9" fill="none"
          />
        </G>
      ))}
      {district.conduits.map((k, i) => {
        if (k.kind === 'loop') return <Dashed key={i} a={k.a} b={k.b} opacity={0.28} width={1.5} dash="10 10" />;
        if (k.kind === 'spoke') return <Dashed key={i} a={k.a} b={k.b} opacity={0.3} width={1.5} dash="10 8" />;
        if (k.kind === 'trunk') return <Line key={i} x1={k.a.x} y1={k.a.y} x2={k.b.x} y2={k.b.y} stroke={GALACTIC.goldLt} strokeOpacity={0.65} strokeWidth={2.5} />;
        const room = district.rooms.find((r) => r.id === k.roomId);
        return (
          <G key={i}>
            <Dashed a={k.a} b={k.b} color={room?.accent || GALACTIC.gold} opacity={0.6} width={2} dash="8 6" />
            <Circle cx={k.b.x} cy={k.b.y} r={2.5} fill={room?.accent || GALACTIC.gold} fillOpacity={0.85} />
          </G>
        );
      })}

      {/* Main station */}
      <Platform geo={station.platform} />
      {station.zones.map((z) => (
        <G key={z.id}>
          <Polygon points={pts(z.poly)} fill={z.accent} fillOpacity={activeZones.has(z.id) ? 0.16 : 0.09} stroke={z.accent} strokeOpacity={0.22} strokeWidth={1} />
          <Polygon points={pts(z.poly)} fill="none" stroke={GALACTIC.goldDp} strokeOpacity={0.45} strokeWidth={1} />
          <Line x1={z.top.x - 18} y1={z.top.y + 9} x2={z.top.x + 18} y2={z.top.y + 9} stroke={z.accent} strokeOpacity={0.7} strokeWidth={2} />
        </G>
      ))}
      <AtriumRing c={station.atrium} />

      {/* Executive Suite */}
      <Platform geo={station.exec.platform} trimAlpha={0.7} />
      {station.exec.decor.map((d, i) => <Prop key={`ex${i}`} item={d} />)}

      {/* Plugin District rooms */}
      {district.rooms.map((room) => (
        <G key={room.id}>
          <Platform geo={room.platform} trimAlpha={0.75} />
          <Polygon points={pts(room.poly)} fill={room.accent} fillOpacity={activeRooms.has(room.id) ? 0.2 : 0.1} />
          <Polygon points={pts(room.poly.map((p) => ({ x: room.center.x + (p.x - room.center.x) * 0.9, y: room.center.y + (p.y - room.center.y) * 0.9 })))} fill="none" stroke={room.accent} strokeOpacity={0.55} strokeWidth={1.5} />
          {room.poly.map((p, i) => {
            const q = { x: room.center.x + (p.x - room.center.x) * 0.9, y: room.center.y + (p.y - room.center.y) * 0.9 };
            return <Rect key={i} x={q.x - 2} y={q.y - 2} width={4} height={4} fill={room.accent} fillOpacity={0.9} />;
          })}
          {room.decor.map((d, i) => <Prop key={i} item={d} />)}
          {showSigns ? (
            <G>
              <Line x1={room.sign.x} y1={room.sign.y} x2={room.sign.x} y2={room.sign.y - 46} stroke={room.accent} strokeOpacity={0.5} strokeWidth={1.5} />
              <Rect x={room.sign.x - 22} y={room.sign.y - 46 - 26} width={44} height={26} rx={3} fill="#0a0a0c" fillOpacity={0.82} stroke={room.accent} strokeWidth={1.2} />
              <SvgText x={room.sign.x} y={room.sign.y - 46 - 7.5} fill={room.accent} fontSize={15} fontWeight="700" fontFamily="monospace" textAnchor="middle">{room.sign.text}</SvgText>
            </G>
          ) : null}
        </G>
      ))}

      {/* Federation islands */}
      {islands.map((isl) => <Platform key={isl.node.id} geo={isl.platform} trimAlpha={0.85} />)}

      {/* Station props (depth-sorted) incl. the concourse beds */}
      {station.decor.map((d, i) => <Prop key={`d${i}`} item={d} />)}
    </G>
  );
});

/** Heatmap blobs under the agents (world-overlays heatmap-layer.ts). */
export function HeatLayer({ blobs }) {
  if (!blobs?.length) return null;
  return (
    <G>
      <Defs>
        {blobs.map((b) => (
          <RadialGradient key={b.key} id={`hm-${b.id}`} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={heatColor(b.t)} stopOpacity={0.1 + 0.5 * b.t} />
            <Stop offset="1" stopColor={heatColor(b.t)} stopOpacity={0} />
          </RadialGradient>
        ))}
      </Defs>
      {blobs.map((b) => <Ellipse key={b.key} cx={b.x} cy={b.y} rx={70 + 90 * b.t} ry={(70 + 90 * b.t) * 0.55} fill={`url(#hm-${b.id})`} />)}
    </G>
  );
}

/** One agent: halo / build ring, sprite, status pip, provider badge, Zzz. */
export const AgentSprite = memo(function AgentSprite({ a, p: base, selected, dimmed, dx = 0, dy = 0 }) {
  const p = { x: base.x + dx, y: base.y + dy };
  const resting = a.resting || a.status === 'completed' || a.status === 'failed' || a.status === 'idle' || !a.status;
  const working = !resting;
  const col = STATUS_COLOR[a.status] || STATUS_COLOR.idle;
  const H = 64;
  const W = (H * 128) / 192;
  const y0 = p.y + 16;
  const badge = badgeFor(a);
  const build = !!a.coderBackend && working;
  return (
    <G opacity={dimmed ? 0.35 : 1}>
      {build ? (
        <G>
          <Ellipse cx={p.x} cy={p.y + 14} rx={23} ry={10} fill="none" stroke={col} strokeWidth={1.5} strokeOpacity={0.85} />
          <Ellipse cx={p.x} cy={p.y + 14} rx={30} ry={13} fill="none" stroke={col} strokeWidth={1} strokeOpacity={0.45} strokeDasharray="4 4" />
        </G>
      ) : (
        <Ellipse cx={p.x} cy={p.y + 14} rx={working ? 13 : 9} ry={working ? 6.5 : 4.5} fill={working ? '#fbbf24' : '#7dd3fc'} fillOpacity={working ? 0.2 : 0.1} />
      )}
      {selected ? <Ellipse cx={p.x} cy={p.y + 14} rx={26} ry={12} fill="none" stroke={GALACTIC.goldLt} strokeWidth={2} /> : null}
      <SvgImage href={AGENT_SPRITES[spriteSlot(a)]} x={p.x - W / 2} y={y0 - H} width={W} height={H} opacity={resting ? 0.72 : 1} />
      <Circle cx={p.x + 9} cy={y0 - 30} r={3.4} fill={col} stroke="#0b0d14" strokeWidth={1} />
      {badge ? (
        <G>
          <Circle cx={p.x} cy={y0 - 57} r={9} fill="#0b0d14" stroke={GALACTIC.gold} strokeWidth={1} />
          <SvgImage href={PROVIDER_BADGES[badge]} x={p.x - 8.1} y={y0 - 57 - 8.1} width={16.2} height={16.2} />
        </G>
      ) : null}
      {resting && a.status !== 'failed' && a.status !== 'completed' ? (
        <SvgText x={p.x + 12} y={y0 - 64} fill={GALACTIC.goldLt} fillOpacity={0.7} fontSize={10} fontWeight="700" fontFamily="monospace">z z</SvgText>
      ) : null}
      {a.status === 'completed' && a.resting ? <SvgText x={p.x + 12} y={y0 - 60} fill="#22c55e" fontSize={12} fontWeight="700">✓</SvgText> : null}
      {a.status === 'failed' && a.resting ? <SvgText x={p.x + 12} y={y0 - 60} fill="#ef4444" fontSize={12} fontWeight="700">✕</SvgText> : null}
    </G>
  );
});

/** Review packets in flight (review-mesh-layer.ts heads: r 11 @0.22, 6.5 @0.5, 3.6 @1). */
export function PacketLayer({ heads }) {
  if (!heads?.length) return null;
  return (
    <G>
      {heads.map((h) => (
        <G key={h.id}>
          <Circle cx={h.x} cy={h.y} r={11} fill={h.color} fillOpacity={0.22} />
          <Circle cx={h.x} cy={h.y} r={6.5} fill={h.color} fillOpacity={0.5} />
          <Circle cx={h.x} cy={h.y} r={3.6} fill={h.color} />
        </G>
      ))}
    </G>
  );
}

/** The Auditor (review-mesh-layer.ts): aura + shield + check. */
export function Auditor({ p, active }) {
  const shield = [0, -76, 17, -70, 17, -55, 14, -45, 0, -34, -14, -45, -17, -55, -17, -70];
  const poly = [];
  for (let i = 0; i < shield.length; i += 2) poly.push(`${p.x + shield[i]},${p.y + shield[i + 1]}`);
  return (
    <G>
      <Ellipse cx={p.x} cy={p.y} rx={40} ry={19} fill="#f5c542" fillOpacity={active ? 0.16 : 0.1} stroke="#f5c542" strokeOpacity={0.35} strokeWidth={1} />
      <Ellipse cx={p.x} cy={p.y} rx={30} ry={14} fill="#f5c542" fillOpacity={0.12} stroke="#f5c542" strokeOpacity={0.75} strokeWidth={2} />
      <SvgImage href={AGENT_SPRITES.default} x={p.x - 21} y={p.y + 4 - 64} width={42.7} height={64} opacity={0.9} />
      <Polygon points={poly.join(' ')} fill="#0c0f1c" stroke="#f5c542" strokeWidth={2.5} />
      <Path d={`M${p.x - 7} ${p.y - 56}L${p.x - 2} ${p.y - 50}L${p.x + 8} ${p.y - 62}`} stroke="#22c55e" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </G>
  );
}

export { Svg };
