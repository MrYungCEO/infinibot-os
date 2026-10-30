/**
 * Live gesture overlay — the web stage's `.kg-overlay` SVG: lasso polygon,
 * link-drag line (gold → cyan) with its tip text, drop-target ring with the
 * "Move …" / "Hold …" hint while dragging a node onto a project.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Polygon, Stop } from 'react-native-svg';

import { KG, kgSheet } from './kg-theme';

export function KgOverlay({ c, stage }) {
  const lasso = c.lassoPts;
  const dl = c.dragLine;
  const dt = c.dropTarget;
  if (!lasso && !dl && !dt) return null;
  const from = dl && stage ? stage.screenOf(dl.fromId) : null;
  const drop = dt && stage ? stage.screenOf(dt.id) : null;
  let path = null;
  if (dl && from) {
    const mx = (from.x + dl.x) / 2;
    const my = Math.min(from.y, dl.y) - Math.abs(dl.x - from.x) * 0.15 - 20;
    path = `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${dl.x.toFixed(1)},${dl.y.toFixed(1)}`;
  }
  const dropCol = dt ? (dt.ok ? (dt.armed ? KG.ok : KG.gold) : KG.danger) : KG.gold;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="kg-overlay">
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <LinearGradient id="kgdl" x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#f5c542" />
            <Stop offset="1" stopColor="#5ee7ff" />
          </LinearGradient>
        </Defs>
        {lasso && lasso.length >= 4 ? (
          <Polygon points={lasso.join(',')} fill="rgba(245,197,66,0.08)" stroke="#f5c542" strokeWidth={1.5} strokeDasharray="5 4" />
        ) : null}
        {path ? <Path d={path} stroke={dl.ok ? 'url(#kgdl)' : 'rgba(240,82,95,0.8)'} strokeWidth={2.2} fill="none" strokeDasharray={dl.ok ? undefined : '6 5'} /> : null}
        {drop ? <Circle cx={drop.x} cy={drop.y} r={drop.r * 1.6 + 8} stroke={dropCol} strokeWidth={2} fill="none" strokeDasharray={dt.armed ? undefined : '4 4'} /> : null}
      </Svg>
      {dl && dl.text ? (
        <View style={[styles.tip, { left: Math.max(6, dl.x + 14), top: Math.max(6, dl.y - 34) }]}>
          <Text style={[styles.tipText, !dl.ok && dl.targetId && { color: '#fca5a5' }]} numberOfLines={1}>{dl.text}</Text>
        </View>
      ) : null}
      {dt && drop && dt.text ? (
        <View style={[styles.tip, { left: Math.max(6, drop.x - 80), top: Math.max(6, drop.y - drop.r * 1.6 - 40) }]}>
          <Text style={[styles.tipText, !dt.ok && { color: '#fca5a5' }]} numberOfLines={1}>{dt.armed || !dt.ok ? dt.text : `Hold… ${dt.text}`}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = kgSheet({
  tip: { position: 'absolute', maxWidth: 240, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(8,6,15,0.92)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.4)' },
  tipText: { color: '#fff3cf', fontSize: 12, fontWeight: '600' },
});
