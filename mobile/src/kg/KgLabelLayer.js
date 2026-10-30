/**
 * Native label layer for the 3D stage — the RN twin of the web stage's DOM
 * label pool (`.kg3d-label*` + `.kg3d-leaders`, phone sizes).
 *
 * The stage places labels itself (collision-free, LOD by camera distance,
 * per-lobe quotas) and hands the accepted set here every third frame; this
 * layer only draws them. Identical frames are skipped so a still camera
 * costs nothing.
 */
import React, { forwardRef, memo, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';

import { mixHex, rgba } from './kg-colors';

const FONT = undefined; // system font (Inter isn't bundled on every platform)

function labelStyle(cls, color) {
  const gc = color || '#d4af37';
  switch (cls) {
    case 'anchor':
      return [styles.base, styles.anchor];
    case 'client':
      return [styles.base, styles.client];
    case 'quiet':
      return [styles.base, styles.quiet];
    case 'focus':
      return [styles.base, styles.focus];
    case 'tag':
      return [styles.base, styles.tag, { color: mixHex(gc, '#ffffff', 0.82), borderColor: rgba(gc, 0.45), textShadowColor: rgba(gc, 0.5) }];
    case 'pocket':
      return [styles.base, styles.pocket, { color: mixHex(gc || '#a1a1aa', '#e7e5e4', 0.62), borderColor: rgba(gc || '#a1a1aa', 0.4) }];
    case 'super':
      return [styles.base, styles.super, { borderColor: rgba(gc, 0.55) }];
    case 'group':
      return [styles.base, styles.group, { color: mixHex(gc, '#ffffff', 0.85), borderColor: rgba(gc, 0.35), backgroundColor: mixHex(gc, '#04030a', 0.1, 0.6), textShadowColor: rgba(gc, 0.6) }];
    default:
      return [styles.base];
  }
}

const Label = memo(function Label({ text, cls, x, y, h, scale, opacity, color }) {
  return (
    <Text
      numberOfLines={1}
      style={[
        labelStyle(cls, color),
        {
          opacity,
          transform: [{ translateX: x }, { translateY: y - h / 2 }, ...(scale > 1.01 ? [{ scale }] : [])],
        },
      ]}
    >
      {text}
    </Text>
  );
});

function signature(labels) {
  let s = '';
  for (const l of labels) s += `${l.id}\u0001${l.text}\u0001${Math.round(l.x)}\u0001${Math.round(l.y)}\u0001${Math.round(l.opacity * 20)}\u0001${l.cls}\u0002`;
  return s;
}

export const KgLabelLayer = forwardRef(function KgLabelLayer(_props, ref) {
  const [frame, setFrame] = useState({ labels: [], leaders: [] });
  const sig = useRef('');
  useImperativeHandle(ref, () => ({
    set(labels, leaders) {
      const next = signature(labels) + leaders.map((l) => l.map((v) => (typeof v === 'number' ? Math.round(v) : v)).join(',')).join(';');
      if (next === sig.current) return;
      sig.current = next;
      setFrame({ labels, leaders });
    },
    /** Placed labels (tests / harness). */
    get labels() {
      return frame.labels;
    },
  }));
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {frame.leaders.length ? (
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {frame.leaders.map(([x0, y0, x1, y1, c], i) => (
            <React.Fragment key={i}>
              <Line x1={x0} y1={y0} x2={x1} y2={y1} stroke={c} strokeWidth={1} strokeOpacity={0.6} strokeDasharray="3 3" />
              <Circle cx={x0} cy={y0} r={2.2} fill={c} fillOpacity={0.85} />
            </React.Fragment>
          ))}
        </Svg>
      ) : null}
      {frame.labels.map((l) => (
        <Label key={l.id} text={l.text} cls={l.cls} x={l.x} y={l.y} h={l.height} scale={l.scale} opacity={l.opacity} color={l.color} />
      ))}
    </View>
  );
});

const shadow = { textShadowColor: 'rgba(3,2,8,0.95)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 6 };

const styles = StyleSheet.create({
  base: {
    position: 'absolute',
    left: 0,
    top: 0,
    transformOrigin: 'left top',
    fontFamily: FONT,
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '500',
    letterSpacing: 0.1,
    color: 'rgba(214,214,222,0.92)',
    backgroundColor: 'rgba(3,2,8,0.7)',
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
    ...shadow,
  },
  anchor: { fontWeight: '700', fontSize: 11, color: '#fbf6ea', textShadowColor: 'rgba(212,175,55,0.45)', textShadowRadius: 10 },
  client: { fontWeight: '700', fontSize: 10.5, color: '#fbf1d6', letterSpacing: 0.42, textTransform: 'uppercase', textShadowColor: 'rgba(232,197,107,0.55)', textShadowRadius: 10 },
  quiet: { fontWeight: '600', fontSize: 10.5, color: 'rgba(214,210,200,0.82)' },
  focus: { fontWeight: '800', fontSize: 12, color: '#ffe08a', textShadowColor: 'rgba(245,197,66,0.9)', textShadowRadius: 12 },
  tag: { fontWeight: '700', fontSize: 8.5, letterSpacing: 1.0, lineHeight: 15, paddingHorizontal: 5, backgroundColor: 'rgba(5,4,12,0.84)', borderWidth: 1, textShadowRadius: 6 },
  pocket: { fontWeight: '600', fontSize: 8, letterSpacing: 0.8, lineHeight: 14, paddingHorizontal: 5, backgroundColor: 'rgba(5,4,12,0.74)', borderWidth: 1, borderStyle: 'dashed', borderRadius: 999 },
  super: { fontWeight: '700', fontSize: 10, lineHeight: 15, paddingHorizontal: 6, color: '#fff7e0', backgroundColor: 'rgba(5,4,12,0.86)', borderWidth: 1, borderRadius: 999 },
  group: { fontWeight: '700', fontSize: 10, letterSpacing: 2.2, lineHeight: 18, paddingHorizontal: 7, borderRadius: 4, borderWidth: 1 },
});
