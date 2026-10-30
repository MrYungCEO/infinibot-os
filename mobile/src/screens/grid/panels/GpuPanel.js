/**
 * GpuPanel — the web grid's GPU tile on the phone. The web tile is a GPU
 * particle showcase of the agent mesh; on a phone the useful thing is the
 * GPU itself, so this shows the live hardware snapshot (useHardware: the same
 * /api/hardware endpoints as the Hardware page) — GPU load, VRAM,
 * temperature, CPU / memory — plus every federation node's GPU.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ProgressBar, SPACE, StatCard, useUIKit } from '../../../ui-kit';
import { useHardware } from '../../../hooks/useHardware';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { MiniLabel, PanelEmpty, PanelError, PanelLoading, PanelOpen } from '../panel-kit';

const pct = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
const gb = (b) => (Number.isFinite(Number(b)) ? (Number(b) / 1024 ** 3).toFixed(1) : '-');

function tone(p) {
  if (p == null) return 'neutral';
  if (p >= 90) return 'danger';
  if (p >= 70) return 'warning';
  return 'primary';
}

export function GpuPanel({ gateway, navigation }) {
  const { colors, type } = useUIKit();
  const hw = useHardware({ enabled: true });
  const snap = hw.snapshot;
  const gpu = snap?.gpu || null;
  const gpuPct = pct(gpu?.utilizationPercent);
  const vramPct = gpu?.vramTotalBytes > 0 ? Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100) : null;
  const cpuPct = pct(snap?.cpu?.percent ?? snap?.cpu?.usagePercent);
  const memPct = snap?.memory?.totalBytes > 0 ? Math.round((snap.memory.usedBytes / snap.memory.totalBytes) * 100) : pct(snap?.memory?.usagePercent);

  let body;
  if (!snap && hw.status !== 'error') body = <PanelLoading rows={4} />;
  else if (!snap) body = <PanelError message={hw.error} onRetry={hw.refresh} />;
  else {
    body = (
      <ScrollView style={styles.flex} contentContainerStyle={styles.pad} nestedScrollEnabled>
        {gpu ? (
          <>
            <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{gpu.name || 'GPU'}</Text>
            <View style={styles.stats}>
              <StatCard compact label="GPU" value={gpuPct ?? '-'} unit="%" icon="speedometer-outline" style={styles.flex} />
              <StatCard compact label="Temp" value={Number.isFinite(gpu.temperatureC) ? Math.round(gpu.temperatureC) : '-'} unit="C" icon="thermometer-outline" style={styles.flex} />
            </View>
            <ProgressBar value={gpuPct != null ? gpuPct / 100 : 0} tone={tone(gpuPct)} label="GPU load" showValue style={styles.bar} />
            <ProgressBar value={vramPct != null ? vramPct / 100 : 0} tone={tone(vramPct)} label={`VRAM ${gb(gpu.vramUsedBytes)} / ${gb(gpu.vramTotalBytes)} GB`} showValue style={styles.bar} />
          </>
        ) : <PanelEmpty icon="hardware-chip-outline" title="No GPU on this node" message="The gateway host reports no GPU." />}
        {cpuPct != null ? <ProgressBar value={cpuPct / 100} tone={tone(cpuPct)} label="CPU" showValue style={styles.bar} /> : null}
        {memPct != null ? <ProgressBar value={memPct / 100} tone={tone(memPct)} label="Memory" showValue style={styles.bar} /> : null}
        {hw.nodes.length ? <MiniLabel>Federation nodes</MiniLabel> : null}
        {hw.nodes.map((n, i) => {
          const s = n.snapshot || n;
          const g = s?.gpu;
          const p = pct(g?.utilizationPercent);
          return (
            <View key={n.nodeId || n.id || i} style={styles.node}>
              <View style={styles.nodeHead}>
                <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{n.nodeName || n.name || n.nodeId || 'Node'}</Text>
                <Text style={[type.monoSmall, { color: colors.textMuted }]}>{g ? `${p ?? '-'}%` : 'no GPU'}</Text>
              </View>
              {g ? <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>{g.name}</Text> : null}
              {g && p != null ? <ProgressBar value={p / 100} tone={tone(p)} height={4} /> : null}
            </View>
          );
        })}
      </ScrollView>
    );
  }

  return (
    <View style={styles.root}>
      {body}
      <PanelOpen label="Hardware" onPress={() => navigateToScreen(navigation, { screen: 'HardwareScreen' }, { gateway })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.md, gap: SPACE.sm },
  stats: { flexDirection: 'row', gap: SPACE.sm },
  bar: { marginTop: SPACE.xs },
  node: { gap: SPACE.xs, paddingVertical: SPACE.xs },
  nodeHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
});
