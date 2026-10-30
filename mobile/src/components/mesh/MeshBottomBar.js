/**
 * MeshBottomBar — the web mesh's bottom chrome, natively:
 *   · heatmap mission bar (world-overlays.ts): Off · Burn · Activity · Failures
 *   · zoom controls (activity-map.ts UIControls): + − fit · labels, lifted above the rail pill
 *   · "Recently completed" pill (mesh-completed-rail.ts, phone form)
 *   · broadcast caption (agency-world-viz.ts .bx-caption)
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MeshIcon } from './MeshIcons';
import { GOLD, GOLD_LT, MONO } from './mesh-style';

export const HEAT_MODES = [
  { mode: null, label: 'Off', icon: 'off' },
  { mode: 'credit_burn', label: 'Burn', icon: 'coin' },
  { mode: 'activity_density', label: 'Activity', icon: 'bolt' },
  { mode: 'failure_rate', label: 'Failures', icon: 'alert' },
];

function ZoomBtn({ icon, onPress, a11y, on }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.zoom, on && styles.zoomOn, pressed && { backgroundColor: 'rgba(212,175,55,0.18)' }]} accessibilityRole="button" accessibilityLabel={a11y} hitSlop={4}>
      <MeshIcon name={icon} size={17} color={GOLD_LT} strokeWidth={2} />
    </Pressable>
  );
}

export function MeshBottomBar({ heat, onHeat, completedCount, onCompleted, onZoomIn, onZoomOut, onFit, labelsHidden, onToggleLabels, caption, bottom, compact }) {
  return (
    <>
      <View style={[styles.zoomCol, { bottom: bottom + 52 }]} pointerEvents="box-none">
        <ZoomBtn icon="plus" onPress={onZoomIn} a11y="Zoom in" />
        <ZoomBtn icon="minus" onPress={onZoomOut} a11y="Zoom out" />
        <ZoomBtn icon="fit" onPress={onFit} a11y="Fit the whole mesh" />
        <ZoomBtn icon={labelsHidden ? 'eyeOff' : 'eye'} onPress={onToggleLabels} a11y={labelsHidden ? 'Show labels' : 'Hide labels'} on={labelsHidden} />
      </View>
      {caption ? (
        <View style={[styles.caption, { bottom: bottom + 56 }]} pointerEvents="none" testID="mesh-broadcast-caption">
          <MeshIcon name="live" size={10} color="#f87171" />
          <Text style={styles.live}>LIVE</Text>
          <Text style={styles.captionText} numberOfLines={1}>{caption}</Text>
        </View>
      ) : null}
      <View style={[styles.row, { bottom: bottom + 8 }]} pointerEvents="box-none">
        <View style={styles.missions} testID="mesh-heatmap-bar">
          {HEAT_MODES.map((m) => {
            const on = heat === m.mode;
            return (
              <Pressable key={m.label} onPress={() => onHeat(m.mode)} style={[styles.mission, on && styles.missionOn]} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`Heatmap ${m.label}`} hitSlop={2}>
                <MeshIcon name={m.icon} size={13} color={on ? '#1a1408' : GOLD_LT} strokeWidth={2} />
                {compact && !on && m.mode ? null : <Text style={[styles.missionText, on && styles.missionTextOn]} numberOfLines={1}>{m.label}</Text>}
              </Pressable>
            );
          })}
        </View>
        <Pressable onPress={onCompleted} style={styles.completed} accessibilityRole="button" accessibilityLabel={`Recently completed agents, ${completedCount}`} testID="mesh-completed-pill">
          <MeshIcon name="check" size={14} color={GOLD_LT} strokeWidth={2.4} />
          <Text style={styles.completedText}> Completed </Text>
          <View style={styles.badge}><Text style={styles.badgeText}>{completedCount}</Text></View>
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  row: { position: 'absolute', left: 8, right: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  missions: { flexDirection: 'row', alignItems: 'center', gap: 2, padding: 3, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)', backgroundColor: 'rgba(10,8,4,0.86)', flexShrink: 1 },
  mission: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, minHeight: 36, justifyContent: 'center', borderRadius: 9 },
  missionOn: { backgroundColor: '#e9c46a' },
  missionText: { color: '#f3e7c4', fontSize: 11, fontWeight: '600' },
  missionTextOn: { color: '#1a1408' },
  completed: { flexDirection: 'row', alignItems: 'center', minHeight: 40, paddingLeft: 12, paddingRight: 6, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(212,175,55,0.55)', backgroundColor: 'rgba(10,8,4,0.9)' },
  completedText: { color: GOLD_LT, fontSize: 12, fontWeight: '700' },
  badge: { minWidth: 26, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#1a1408', fontSize: 11, fontWeight: '800' },
  zoomCol: { position: 'absolute', right: 10, gap: 8 },
  zoom: { width: 34, height: 34, borderRadius: 7, borderWidth: 1.5, borderColor: 'rgba(212,175,55,0.75)', backgroundColor: 'rgba(10,8,4,0.85)', alignItems: 'center', justifyContent: 'center' },
  zoomOn: { backgroundColor: 'rgba(212,175,55,0.25)' },
  caption: { position: 'absolute', alignSelf: 'center', maxWidth: '80%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 7, borderRadius: 999, backgroundColor: 'rgba(10,14,26,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  captionText: { color: '#e4e4e7', fontSize: 12, fontFamily: MONO, flexShrink: 1 },
  live: { color: '#f87171', fontWeight: '700', fontSize: 12, fontFamily: MONO, letterSpacing: 0.6 },
});
