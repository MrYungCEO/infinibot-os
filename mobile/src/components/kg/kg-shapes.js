/**
 * kg-shapes — SVG node shapes for the native Knowledge Graph, drawn in screen
 * space. Same drawing language as the web legend (glow3d node-shapes): a gem
 * for projects, a check block for tasks, stacked pages for notes, a bar-chart
 * slab for reports, a lens for research, an orbit-ringed orb for agents, a
 * person capsule for clients, a bulb for ideas.
 *
 * Each shape is a primary filled path (`fill`) plus an optional detail path
 * (`detail`, stroked dark over the fill) — two <Path>s per node at most, so a
 * few hundred nodes stay cheap for react-native-svg.
 */
import React from 'react';
import Svg, { Path } from 'react-native-svg';

import { KIND_PALETTE, shapeFor } from '../../lib/kg-model';

const f = (n) => (Math.round(n * 10) / 10).toString();

function poly(cx, cy, s, pts) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(cx + x * s)} ${f(cy + y * s)}`).join(' ') + ' Z';
}

function rect(cx, cy, s, x0, y0, x1, y1) {
  return poly(cx, cy, s, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
}

function circle(cx, cy, r) {
  return `M${f(cx - r)} ${f(cy)} a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0 a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0 Z`;
}

function line(cx, cy, s, pts) {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${f(cx + x * s)} ${f(cy + y * s)}`).join(' ');
}

/** { fill, detail? } path data for a shape centred on (cx, cy) with radius s. */
export function shapePaths(shape, cx, cy, s) {
  switch (shape) {
    case 'gem':
      return {
        fill: poly(cx, cy, s, [[-0.55, -0.85], [0.55, -0.85], [1, -0.25], [0, 1], [-1, -0.25]]),
        detail: line(cx, cy, s, [[-1, -0.25], [1, -0.25]]) + ' ' + line(cx, cy, s, [[-0.55, -0.85], [-0.25, -0.25], [0, 1], [0.25, -0.25], [0.55, -0.85]]),
      };
    case 'block':
      return {
        fill: rect(cx, cy, s, -0.82, -0.82, 0.82, 0.82),
        detail: line(cx, cy, s, [[-0.42, 0.02], [-0.1, 0.34], [0.46, -0.3]]),
      };
    case 'pages':
      return {
        fill: rect(cx, cy, s, -0.45, -0.95, 0.9, 0.6) + ' ' + poly(cx, cy, s, [[-0.9, -0.6], [0.2, -0.6], [0.5, -0.3], [0.5, 0.95], [-0.9, 0.95]]),
        detail: line(cx, cy, s, [[-0.6, -0.05], [0.25, -0.05]]) + ' ' + line(cx, cy, s, [[-0.6, 0.35], [0.25, 0.35]]),
      };
    case 'report':
      return {
        fill: rect(cx, cy, s, -0.78, -0.95, 0.78, 0.95),
        detail: line(cx, cy, s, [[-0.42, 0.62], [-0.42, 0.1]]) + ' ' + line(cx, cy, s, [[0, 0.62], [0, -0.45]]) + ' ' + line(cx, cy, s, [[0.42, 0.62], [0.42, -0.12]]),
      };
    case 'media':
      return {
        fill: rect(cx, cy, s, -0.95, -0.7, 0.95, 0.7),
        detail: poly(cx, cy, s, [[-0.25, -0.35], [0.38, 0], [-0.25, 0.35]]),
      };
    case 'agent':
      return {
        fill: circle(cx, cy, s * 0.62),
        ring: { rx: s * 1.05, ry: s * 0.42 },
      };
    case 'person':
      return {
        fill: circle(cx, cy - s * 0.48, s * 0.38) + ' ' + `M${f(cx - s * 0.75)} ${f(cy + s)} Q${f(cx - s * 0.75)} ${f(cy - s * 0.05)} ${f(cx)} ${f(cy - s * 0.05)} Q${f(cx + s * 0.75)} ${f(cy - s * 0.05)} ${f(cx + s * 0.75)} ${f(cy + s)} Z`,
      };
    case 'chip': {
      const pts = [];
      for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; pts.push([Math.cos(a), Math.sin(a)]); }
      return { fill: poly(cx, cy, s, pts), detail: rect(cx, cy, s, -0.32, -0.32, 0.32, 0.32) };
    }
    case 'neuron': {
      const pts = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? 0.45 : 1; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      return { fill: poly(cx, cy, s, pts) };
    }
    case 'lens':
      return {
        fill: circle(cx - s * 0.18, cy - s * 0.18, s * 0.66),
        detail: circle(cx - s * 0.18, cy - s * 0.18, s * 0.32),
        handle: line(cx, cy, s, [[0.3, 0.3], [0.95, 0.95]]),
      };
    case 'bulb':
      return {
        fill: circle(cx, cy - s * 0.22, s * 0.68) + ' ' + rect(cx, cy, s, -0.32, 0.4, 0.32, 0.95),
        detail: line(cx, cy, s, [[-0.32, 0.62], [0.32, 0.62]]),
      };
    default:
      return { fill: circle(cx, cy, s) };
  }
}

/** A standalone glyph (legend chips, sheet header). */
export function KindGlyph({ kind, color, size = 18, ink = '#0b0a08' }) {
  const shape = shapeFor(kind);
  const c = color || KIND_PALETTE[kind] || '#9ca3af';
  const s = size * 0.42;
  const p = shapePaths(shape, size / 2, size / 2, s);
  return (
    <Svg width={size} height={size}>
      {p.ring ? <Path d={`M${size / 2 - p.ring.rx} ${size / 2} a${p.ring.rx} ${p.ring.ry} 0 1 0 ${p.ring.rx * 2} 0 a${p.ring.rx} ${p.ring.ry} 0 1 0 ${-p.ring.rx * 2} 0`} stroke={c} strokeWidth={1.2} fill="none" /> : null}
      <Path d={p.fill} fill={c} />
      {p.detail ? <Path d={p.detail} stroke={ink} strokeWidth={1.2} fill={shape === 'media' ? ink : 'none'} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {p.handle ? <Path d={p.handle} stroke={c} strokeWidth={2} strokeLinecap="round" /> : null}
    </Svg>
  );
}

