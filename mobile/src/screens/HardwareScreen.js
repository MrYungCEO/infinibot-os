// HardwareScreen — rich hardware analysis view mirroring the web hardware-analysis view.
// Surfaces: header summary · per-GPU card · CPU/RAM/disk/network · federation node fleet.
// Polls every 10 s while the screen is focused; pull-to-refresh always available.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS, FONTS, SPACING } from '../constants/theme';
import { GlassCard } from '../components/GlassCard';
import { withAlpha } from '../theme/color-utils';
import { useHardware } from '../hooks/useHardware';

const VIEW_MODE_STORAGE_KEY = '@moltbot/hardware_view_mode';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtBytes(bytes, decimals = 1) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(decimals)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(decimals)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(decimals)} GB`;
}

function fmtUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `${Math.round(n)}%`;
}

function loadColor(pct) {
  if (!Number.isFinite(pct)) return COLORS.textMuted;
  if (pct >= 85) return COLORS.error;
  if (pct >= 70) return COLORS.warning;
  return COLORS.success;
}

function healthColor(health) {
  if (health === 'online') return COLORS.success;
  if (health === 'stale') return COLORS.warning;
  return COLORS.textMuted;
}

function systemStatusInfo(cpuPct, memPct, gpuPct) {
  const max = Math.max(cpuPct || 0, memPct || 0, gpuPct || 0);
  if (max >= 90) return { label: 'CRITICAL', color: COLORS.error };
  if (max >= 75) return { label: 'ELEVATED', color: COLORS.warning };
  return { label: 'NOMINAL', color: COLORS.success };
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function ProgressBar({ pct, color, style }) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const fill = color || loadColor(clamped);
  return (
    <View style={[styles.barTrack, style]}>
      <View style={[styles.barFill, { width: `${clamped}%`, backgroundColor: fill }]} />
    </View>
  );
}

function SectionLabel({ text }) {
  return <Text style={styles.sectionLabel}>{text}</Text>;
}

function DivRow() {
  return <View style={styles.divRow} />;
}

// ─── Mini metric card (CPU / RAM / GPU summary row) ───────────────────────────

function MiniMetricCard({ label, pct, icon, hasData = true }) {
  const color = hasData ? loadColor(pct) : COLORS.textMuted;
  return (
    <View style={styles.miniCard}>
      <Ionicons name={icon} size={16} color={color} />
      <Text style={[styles.miniPct, { color }]}>{hasData ? fmtPct(pct) : '—'}</Text>
      <Text style={styles.miniLabel}>{label}</Text>
      <ProgressBar pct={hasData ? pct : 0} color={color} style={styles.miniBar} />
    </View>
  );
}

// ─── Metric row (icon + label + value) ───────────────────────────────────────

function MetricRow({ ionIcon, mcIcon, label, value, hint, color }) {
  const IconComp = mcIcon ? MaterialCommunityIcons : Ionicons;
  const iconName = mcIcon || ionIcon;
  const iconColor = color || COLORS.primary;
  return (
    <View style={styles.metricRow}>
      <View style={[styles.iconWrap, { backgroundColor: iconColor + '22' }]}>
        <IconComp name={iconName} size={14} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.rowValue, color ? { color } : null]}>{value ?? '—'}</Text>
    </View>
  );
}

// ─── Stat grid (2–4 cells with label + value) ────────────────────────────────

function StatGrid({ cells }) {
  return (
    <View style={styles.statGrid}>
      {cells.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <View style={styles.statDivider} />}
          <View style={styles.statCell}>
            <Text style={styles.statLabel}>{c.label}</Text>
            <Text style={[styles.statValue, c.color ? { color: c.color } : null]}>{c.value ?? '—'}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

// ─── Federation node card (used in horizontal scroll) ────────────────────────

function NodeCard({ node }) {
  const snap = node.snapshot;
  const cpuPct = snap?.cpu?.percent ?? null;
  const memPct = snap?.memory?.percent ?? null;
  const gpuPct = snap?.gpu?.utilizationPercent ?? null;
  const hColor = healthColor(node.health);

  return (
    <View style={styles.nodeCard}>
      {/* Header */}
      <View style={styles.nodeCardHeader}>
        <MaterialCommunityIcons
          name={node.role === 'master' ? 'server' : 'server-network'}
          size={13}
          color={hColor}
        />
        <Text style={[styles.nodeCardName, { color: hColor }]} numberOfLines={1}>
          {node.nodeName || node.nodeId}
        </Text>
        {node.isLocal && (
          <View style={styles.localBadge}>
            <Text style={styles.localBadgeText}>local</Text>
          </View>
        )}
      </View>

      {/* Health */}
      <View style={styles.nodeHealthRow}>
        <View style={[styles.healthDot, { backgroundColor: hColor }]} />
        <Text style={[styles.nodeHealthText, { color: hColor }]}>{node.health.toUpperCase()}</Text>
        {node.ageMs > 0 && (
          <Text style={styles.nodeAgeText}>{Math.round(node.ageMs / 1000)}s</Text>
        )}
      </View>

      {/* Per-node metrics */}
      {snap ? (
        <>
          <View style={styles.nodeMiniRow}>
            <Text style={styles.nodeMiniLabel}>CPU</Text>
            <Text style={[styles.nodeMiniVal, { color: loadColor(cpuPct) }]}>{fmtPct(cpuPct)}</Text>
          </View>
          <ProgressBar pct={cpuPct} style={styles.nodeMiniBar} />

          <View style={styles.nodeMiniRow}>
            <Text style={styles.nodeMiniLabel}>RAM</Text>
            <Text style={[styles.nodeMiniVal, { color: loadColor(memPct) }]}>{fmtPct(memPct)}</Text>
          </View>
          <ProgressBar pct={memPct} style={styles.nodeMiniBar} />

          {gpuPct !== null && (
            <>
              <View style={styles.nodeMiniRow}>
                <Text style={styles.nodeMiniLabel}>GPU</Text>
                <Text style={[styles.nodeMiniVal, { color: loadColor(gpuPct) }]}>{fmtPct(gpuPct)}</Text>
              </View>
              <ProgressBar pct={gpuPct} style={styles.nodeMiniBar} />
            </>
          )}

          {snap.gpu?.name ? (
            <Text style={styles.nodeGpuName} numberOfLines={1}>{snap.gpu.name}</Text>
          ) : null}
        </>
      ) : (
        <Text style={styles.nodeNoSnap}>No snapshot</Text>
      )}
    </View>
  );
}

// ─── Fleet aggregate helpers ─────────────────────────────────────────────────

function computeFleetSummary(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  let online = 0;
  let offline = 0;
  let gpuCount = 0;
  let vramUsed = 0;
  let vramTotal = 0;
  let ramUsed = 0;
  let ramTotal = 0;
  let cpuSum = 0;
  let cpuSamples = 0;
  let gpuUtilSum = 0;
  let gpuUtilSamples = 0;
  let masters = 0;
  let satellites = 0;

  for (const n of list) {
    if (n?.health === 'online') online += 1; else offline += 1;
    if (n?.role === 'master') masters += 1; else satellites += 1;

    const snap = n?.snapshot;
    if (!snap) continue;

    if (snap.gpu) {
      gpuCount += 1;
      if (Number.isFinite(snap.gpu.vramUsedBytes))  vramUsed  += snap.gpu.vramUsedBytes;
      if (Number.isFinite(snap.gpu.vramTotalBytes)) vramTotal += snap.gpu.vramTotalBytes;
      if (Number.isFinite(snap.gpu.utilizationPercent)) {
        gpuUtilSum += snap.gpu.utilizationPercent;
        gpuUtilSamples += 1;
      }
    }
    if (snap.memory) {
      if (Number.isFinite(snap.memory.usedBytes))  ramUsed  += snap.memory.usedBytes;
      if (Number.isFinite(snap.memory.totalBytes)) ramTotal += snap.memory.totalBytes;
    }
    if (Number.isFinite(snap.cpu?.percent)) {
      cpuSum += snap.cpu.percent;
      cpuSamples += 1;
    }
  }

  return {
    totalNodes: list.length,
    online,
    offline,
    masters,
    satellites,
    gpuCount,
    vramUsed,
    vramTotal,
    vramPct: vramTotal > 0 ? Math.round((vramUsed / vramTotal) * 100) : 0,
    ramUsed,
    ramTotal,
    ramPct: ramTotal > 0 ? Math.round((ramUsed / ramTotal) * 100) : 0,
    avgCpu: cpuSamples > 0 ? cpuSum / cpuSamples : null,
    avgGpu: gpuUtilSamples > 0 ? gpuUtilSum / gpuUtilSamples : null,
  };
}

// ─── Fleet rich node card (expandable) ───────────────────────────────────────

function FleetNodeCard({ node, expanded, onToggle }) {
  const snap = node?.snapshot;
  const cpuPct = snap?.cpu?.percent ?? null;
  const memPct = snap?.memory?.percent ?? null;
  const gpu    = snap?.gpu ?? null;
  const gpuPct = gpu?.utilizationPercent ?? null;
  const vramPct = gpu && gpu.vramTotalBytes > 0
    ? Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100)
    : null;
  const disk = snap?.disk?.mounts?.[0] ?? null;
  const iface = snap?.network?.interfaces?.[0] ?? null;
  const hColor = healthColor(node?.health);
  const isMaster = node?.role === 'master';

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onToggle}
      style={[styles.fleetCard, expanded && styles.fleetCardActive]}
    >
      {/* Title row */}
      <View style={styles.fleetCardHeader}>
        <MaterialCommunityIcons
          name={isMaster ? 'server' : 'server-network'}
          size={15}
          color={hColor}
        />
        <Text style={styles.fleetCardName} numberOfLines={1}>
          {node?.nodeName || node?.nodeId || 'unknown'}
        </Text>
        <View style={[styles.fleetRoleBadge, { borderColor: hColor + '50', backgroundColor: hColor + '14' }]}>
          <Text style={[styles.fleetRoleBadgeText, { color: hColor }]}>
            {isMaster ? 'MASTER' : 'SATELLITE'}
          </Text>
        </View>
      </View>

      {/* Health + age */}
      <View style={styles.fleetHealthRow}>
        <View style={[styles.healthDot, { backgroundColor: hColor }]} />
        <Text style={[styles.fleetHealthText, { color: hColor }]}>
          {(node?.health ?? 'unknown').toUpperCase()}
        </Text>
        {node?.isLocal ? (
          <View style={styles.localBadge}>
            <Text style={styles.localBadgeText}>local</Text>
          </View>
        ) : null}
        {node?.ageMs > 0 ? (
          <Text style={styles.nodeAgeText}>{Math.round(node.ageMs / 1000)}s ago</Text>
        ) : null}
        <View style={{ flex: 1 }} />
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={COLORS.textMuted}
        />
      </View>

      {snap ? (
        <>
          {/* GPU summary line */}
          {gpu ? (
            <View style={styles.fleetGpuLine}>
              <MaterialCommunityIcons name="expansion-card" size={12} color={COLORS.primary} />
              <Text style={styles.fleetGpuName} numberOfLines={1}>{gpu.name || 'GPU'}</Text>
              {Number.isFinite(gpu.temperatureC) ? (
                <Text style={styles.fleetGpuTemp}>{Math.round(gpu.temperatureC)}°C</Text>
              ) : null}
            </View>
          ) : null}

          {/* Compact metric strip */}
          <View style={styles.fleetMetricStrip}>
            <FleetMetric label="CPU" pct={cpuPct} />
            <FleetMetric label="RAM" pct={memPct} />
            {gpuPct !== null ? <FleetMetric label="GPU" pct={gpuPct} /> : null}
            {vramPct !== null ? <FleetMetric label="VRAM" pct={vramPct} /> : null}
          </View>

          {/* Expanded details */}
          {expanded ? (
            <View style={styles.fleetExpand}>
              <View style={styles.fleetDivider} />

              {snap.system ? (
                <View style={styles.fleetDetailGrid}>
                  <FleetDetail label="HOST"   value={snap.system.hostname} />
                  <FleetDetail label="OS"     value={[snap.system.platform, snap.system.arch].filter(Boolean).join('/')} />
                  <FleetDetail label="UPTIME" value={fmtUptime(snap.system.uptimeSec)} />
                  <FleetDetail label="CORES"  value={snap.cpu?.cores ?? '—'} />
                </View>
              ) : null}

              {snap.memory ? (
                <View style={styles.fleetMemRow}>
                  <Text style={styles.fleetMemLabel}>MEMORY</Text>
                  <Text style={styles.fleetMemValue}>
                    {fmtBytes(snap.memory.usedBytes)} / {fmtBytes(snap.memory.totalBytes)}
                  </Text>
                </View>
              ) : null}

              {gpu ? (
                <View style={styles.fleetMemRow}>
                  <Text style={styles.fleetMemLabel}>VRAM</Text>
                  <Text style={styles.fleetMemValue}>
                    {fmtBytes(gpu.vramUsedBytes)} / {fmtBytes(gpu.vramTotalBytes)}
                  </Text>
                </View>
              ) : null}

              {disk ? (
                <View style={styles.fleetMemRow}>
                  <Text style={styles.fleetMemLabel}>DISK ({disk.path})</Text>
                  <Text style={[styles.fleetMemValue, { color: loadColor(disk.percent) }]}>
                    {fmtBytes(disk.usedBytes)} / {fmtBytes(disk.totalBytes)} · {disk.percent}%
                  </Text>
                </View>
              ) : null}

              {iface ? (
                <View style={styles.fleetMemRow}>
                  <Text style={styles.fleetMemLabel}>NET ({iface.name})</Text>
                  <Text style={styles.fleetMemValue}>
                    <Text style={{ color: COLORS.success }}>↑ </Text>
                    {fmtBytes(iface.txBytesPerSec, 0)}/s
                    <Text style={{ color: '#60a5fa' }}>   ↓ </Text>
                    {fmtBytes(iface.rxBytesPerSec, 0)}/s
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.nodeNoSnap}>No snapshot</Text>
      )}
    </TouchableOpacity>
  );
}

function FleetMetric({ label, pct }) {
  const has = Number.isFinite(pct);
  const color = has ? loadColor(pct) : COLORS.textMuted;
  return (
    <View style={styles.fleetMetric}>
      <Text style={styles.fleetMetricLabel}>{label}</Text>
      <Text style={[styles.fleetMetricVal, { color }]}>{has ? fmtPct(pct) : '—'}</Text>
      <ProgressBar pct={has ? pct : 0} color={color} style={styles.fleetMetricBar} />
    </View>
  );
}

function FleetDetail({ label, value }) {
  return (
    <View style={styles.fleetDetail}>
      <Text style={styles.fleetDetailLabel}>{label}</Text>
      <Text style={styles.fleetDetailValue} numberOfLines={1}>{value ?? '—'}</Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function HardwareScreen({ navigation }) {
  const [enabled, setEnabled] = useState(true);
  const [viewMode, setViewMode] = useState('master'); // 'master' | 'fleet'
  const [viewModeRestored, setViewModeRestored] = useState(false);
  const [expandedNodeId, setExpandedNodeId] = useState(null);
  const { snapshot, nodes, federationRole, status, error, refresh } = useHardware({ enabled });

  // Start/stop polling based on screen focus.
  useFocusEffect(
    useCallback(() => {
      setEnabled(true);
      return () => setEnabled(false);
    }, [])
  );

  // Restore persisted view mode on mount.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(VIEW_MODE_STORAGE_KEY).then((v) => {
      if (cancelled) return;
      if (v === 'fleet' || v === 'master') setViewMode(v);
      setViewModeRestored(true);
    }).catch(() => {
      if (!cancelled) setViewModeRestored(true);
    });
    return () => { cancelled = true; };
  }, []);

  // Mirror the web view: first time we see >1 node AND nothing was persisted,
  // snap to FLEET so multi-device installs land on the overview. Single-node
  // setups stay on MASTER. User taps on the toggle stick from then on.
  useEffect(() => {
    if (!viewModeRestored) return;
    if (Array.isArray(nodes) && nodes.length > 1) {
      AsyncStorage.getItem(VIEW_MODE_STORAGE_KEY).then((v) => {
        if (v == null) setViewMode('fleet');
      }).catch(() => {});
    }
    // Intentionally only fires after the restore completes.
  }, [viewModeRestored, nodes]);

  const changeViewMode = useCallback((mode) => {
    setViewMode(mode);
    AsyncStorage.setItem(VIEW_MODE_STORAGE_KEY, mode).catch(() => {});
  }, []);

  const fleetSummary = useMemo(() => computeFleetSummary(nodes), [nodes]);

  const cpu     = snapshot?.cpu ?? null;
  const memory  = snapshot?.memory ?? null;
  const gpu     = snapshot?.gpu ?? null;
  const disk    = snapshot?.disk ?? null;
  const network = snapshot?.network ?? null;
  const system  = snapshot?.system ?? null;

  const cpuPct = cpu?.percent ?? 0;
  const memPct = memory?.percent ?? 0;
  const gpuPct = gpu?.utilizationPercent ?? 0;
  const vramPct = gpu && gpu.vramTotalBytes > 0
    ? Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100)
    : 0;

  const statusInfo = snapshot ? systemStatusInfo(cpuPct, memPct, gpuPct) : null;
  const isLoading  = status === 'loading' && !snapshot;
  const hasData    = !!snapshot;
  const multiNode  = Array.isArray(nodes) && nodes.length > 1;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={status === 'loading'}
          onRefresh={refresh}
          tintColor={COLORS.primary}
          colors={[COLORS.primary]}
        />
      }
    >
      {/* ── Back / Title ── */}
      <TouchableOpacity style={styles.backBtn} onPress={() => navigation?.goBack?.()} hitSlop={{ top: 10, bottom: 10, left: 6, right: 12 }} accessibilityRole="button" accessibilityLabel="Back">
        <Ionicons name="chevron-back" size={18} color={COLORS.primary} />
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.heading}>Hardware</Text>
          <Text style={styles.subheading}>
            {viewMode === 'fleet' ? 'Whole federation, every device' : 'Master + federation node metrics'}
          </Text>
        </View>
        {statusInfo && (
          <View style={[styles.statusBadge, { borderColor: statusInfo.color + '50', backgroundColor: statusInfo.color + '18' }]}>
            <View style={[styles.statusDot, { backgroundColor: statusInfo.color }]} />
            <Text style={[styles.statusBadgeText, { color: statusInfo.color }]}>{statusInfo.label}</Text>
          </View>
        )}
      </View>

      {/* ── View-mode toggle (MASTER / FLEET) ── */}
      <View style={styles.modeToggleRow}>
        {[
          { key: 'master', label: 'MASTER', icon: 'crown-outline' },
          { key: 'fleet',  label: 'FLEET',  icon: 'server-network' },
        ].map((m) => {
          const active = viewMode === m.key;
          return (
            <TouchableOpacity
              key={m.key}
              style={[styles.modeChip, active && styles.modeChipActive]}
              onPress={() => changeViewMode(m.key)}
              activeOpacity={0.7}
              hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            >
              <MaterialCommunityIcons
                name={m.icon}
                size={12}
                color={active ? COLORS.primary : COLORS.textMuted}
              />
              <Text style={[styles.modeChipText, active && styles.modeChipTextActive]}>
                {m.label}
              </Text>
              {m.key === 'fleet' && nodes.length > 0 ? (
                <View style={[styles.modeCountPip, active && styles.modeCountPipActive]}>
                  <Text style={[styles.modeCountPipText, active && styles.modeCountPipTextActive]}>
                    {nodes.length}
                  </Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Error ── */}
      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={14} color={COLORS.error} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* ── Initial loading ── */}
      {isLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.loadingText}>Loading hardware metrics…</Text>
        </View>
      ) : null}

      {/* ── Empty / no gateway ── */}
      {!isLoading && !hasData && !error ? (
        <GlassCard style={styles.card}>
          <View style={styles.emptyState}>
            <MaterialCommunityIcons name="server-off" size={36} color={COLORS.textMuted} />
            <Text style={styles.emptyTitle}>No Hardware Data</Text>
            <Text style={styles.emptyHint}>Connect to the gateway to view hardware metrics.</Text>
          </View>
        </GlassCard>
      ) : null}

      {/* ═══════════════════════════════ DATA SECTIONS ══════════════════════════ */}
      {hasData && viewMode === 'master' && (
        <>
          {/* ── Header: hostname + platform + uptime ── */}
          <GlassCard style={styles.card} animated cornerAccents>
            <View style={styles.headerRow}>
              <View style={[styles.headerIconWrap, { backgroundColor: COLORS.primary + '20' }]}>
                <MaterialCommunityIcons name="server" size={22} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: SPACING.md }}>
                <Text style={styles.hostName} numberOfLines={1}>{system?.hostname ?? '—'}</Text>
                <Text style={styles.hostMeta}>
                  {[system?.platform, system?.arch].filter(Boolean).join('/')}
                  {system?.kernelRelease ? `  ·  ${system.kernelRelease}` : ''}
                </Text>
              </View>
              <View style={styles.uptimeCol}>
                <Text style={styles.uptimeLabel}>UPTIME</Text>
                <Text style={styles.uptimeValue}>{fmtUptime(system?.uptimeSec)}</Text>
              </View>
            </View>
            {federationRole === 'master' && (
              <View style={styles.roleBadge}>
                <MaterialCommunityIcons name="crown" size={10} color={COLORS.primary} />
                <Text style={styles.roleBadgeText}>MASTER NODE</Text>
              </View>
            )}
          </GlassCard>

          {/* ── Summary row: CPU / RAM / GPU at a glance ── */}
          <View style={styles.metricsRow}>
            <MiniMetricCard label="CPU" pct={cpuPct} icon="speedometer-outline" />
            <MiniMetricCard label="RAM" pct={memPct} icon="hardware-chip-outline" />
            <MiniMetricCard label="GPU" pct={gpuPct} icon="layers-outline" hasData={!!gpu} />
          </View>

          {/* ── GPU card ── */}
          {gpu ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="GPU" />

              <Text style={styles.gpuName}>{gpu.name}</Text>
              {gpu.vendor ? <Text style={styles.gpuVendor}>{gpu.vendor}</Text> : null}

              <View style={styles.metricRow}>
                <Text style={styles.rowLabel}>Utilization</Text>
                <Text style={[styles.rowValue, { color: loadColor(gpuPct) }]}>{fmtPct(gpuPct)}</Text>
              </View>
              <ProgressBar pct={gpuPct} style={styles.metricBarSp} />

              <View style={styles.metricRow}>
                <Text style={styles.rowLabel}>VRAM</Text>
                <Text style={[styles.rowValue, { color: loadColor(vramPct) }]}>
                  {fmtBytes(gpu.vramUsedBytes)} / {fmtBytes(gpu.vramTotalBytes)}
                </Text>
              </View>
              <Text style={styles.rowHintSm}>{vramPct}% used · {fmtBytes(gpu.vramTotalBytes - gpu.vramUsedBytes)} free</Text>
              <ProgressBar pct={vramPct} style={styles.metricBarSp} />
            </GlassCard>
          ) : (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="GPU" />
              <View style={styles.noGpuRow}>
                <MaterialCommunityIcons name="card-off-outline" size={22} color={COLORS.textMuted} />
                <View style={{ marginLeft: SPACING.sm }}>
                  <Text style={styles.noGpuTitle}>No GPU Detected</Text>
                  <Text style={styles.noGpuHint}>nvidia-smi / rocm-smi not found</Text>
                </View>
              </View>
            </GlassCard>
          )}

          {/* ── CPU card ── */}
          {cpu ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="CPU" />

              {cpu.model ? (
                <Text style={styles.modelText} numberOfLines={2}>{cpu.model}</Text>
              ) : null}

              <View style={styles.metricRow}>
                <Text style={styles.rowLabel}>Utilization</Text>
                <Text style={[styles.rowValue, { color: loadColor(cpuPct) }]}>{fmtPct(cpuPct)}</Text>
              </View>
              <ProgressBar pct={cpuPct} style={styles.metricBarSp} />

              <StatGrid cells={[
                { label: 'CORES', value: cpu.cores ?? '—' },
                { label: '1m', value: cpu.loadAvg?.[0] ?? '—' },
                { label: '5m', value: cpu.loadAvg?.[1] ?? '—' },
                { label: '15m', value: cpu.loadAvg?.[2] ?? '—' },
              ]} />
            </GlassCard>
          ) : null}

          {/* ── Memory card ── */}
          {memory ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="MEMORY" />

              <View style={styles.metricRow}>
                <Text style={styles.rowLabel}>Used</Text>
                <Text style={[styles.rowValue, { color: loadColor(memPct) }]}>
                  {fmtBytes(memory.usedBytes)} / {fmtBytes(memory.totalBytes)}
                </Text>
              </View>
              <ProgressBar pct={memPct} style={styles.metricBarSp} />

              <StatGrid cells={[
                { label: 'USED',  value: fmtBytes(memory.usedBytes, 0) },
                { label: 'FREE',  value: fmtBytes(memory.freeBytes, 0) },
                { label: 'TOTAL', value: fmtBytes(memory.totalBytes, 0) },
              ]} />
            </GlassCard>
          ) : null}

          {/* ── Disk card ── */}
          {disk?.mounts?.length > 0 ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="DISK" />
              {disk.mounts.map((m, i) => (
                <View key={i} style={i > 0 ? styles.mountSep : null}>
                  <View style={styles.diskMountRow}>
                    <Ionicons name="save-outline" size={13} color={COLORS.primary} />
                    <Text style={[styles.diskPath, { flex: 1 }]} numberOfLines={1}>{m.path}</Text>
                    <Text style={[styles.rowValue, { color: loadColor(m.percent) }]}>{m.percent}%</Text>
                  </View>
                  <Text style={styles.diskMeta}>{fmtBytes(m.usedBytes)} / {fmtBytes(m.totalBytes)}</Text>
                  <ProgressBar pct={m.percent} style={styles.diskBar} />
                </View>
              ))}
            </GlassCard>
          ) : null}

          {/* ── Network card ── */}
          {network?.interfaces?.length > 0 ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="NETWORK" />
              {network.interfaces.slice(0, 4).map((iface, i) => (
                <View key={i} style={i > 0 ? styles.mountSep : null}>
                  <View style={styles.ifaceNameRow}>
                    <MaterialCommunityIcons name="ethernet" size={13} color={COLORS.primary} />
                    <Text style={styles.ifaceName}>{iface.name}</Text>
                  </View>
                  <View style={styles.netStatsRow}>
                    <View style={styles.netStat}>
                      <Text style={styles.netUp}>↑</Text>
                      <Text style={styles.netVal}>{fmtBytes(iface.txBytesPerSec, 0)}/s</Text>
                    </View>
                    <View style={styles.netStat}>
                      <Text style={styles.netDown}>↓</Text>
                      <Text style={styles.netVal}>{fmtBytes(iface.rxBytesPerSec, 0)}/s</Text>
                    </View>
                  </View>
                </View>
              ))}
            </GlassCard>
          ) : null}

          {/* ── System info card ── */}
          {system ? (
            <GlassCard style={styles.card} animated>
              <SectionLabel text="SYSTEM" />
              <MetricRow ionIcon="desktop-outline"    label="Hostname" value={system.hostname} />
              <MetricRow ionIcon="layers-outline"     label="OS"       value={`${system.platform}/${system.arch}`} />
              <MetricRow ionIcon="code-slash-outline" label="Kernel"   value={system.kernelRelease} />
              <MetricRow ionIcon="time-outline"       label="Uptime"   value={fmtUptime(system.uptimeSec)} />
              {cpu?.loadAvg ? (
                <MetricRow
                  ionIcon="speedometer-outline"
                  label="Load avg"
                  value={`${cpu.loadAvg[0]} / ${cpu.loadAvg[1]} / ${cpu.loadAvg[2]}`}
                />
              ) : null}
            </GlassCard>
          ) : null}
        </>
      )}

      {/* ── Federation nodes (MASTER mode only) ── */}
      {viewMode === 'master' && (hasData || nodes.length > 0) && (
        <GlassCard style={styles.card} animated>
          <View style={styles.nodeHeaderRow}>
            <SectionLabel text={`FEDERATION NODES`} />
            <View style={styles.nodeCountBadge}>
              <Text style={styles.nodeCountText}>{nodes.length}</Text>
            </View>
          </View>

          {nodes.length === 0 ? (
            <Text style={styles.emptyText}>No federation nodes reporting.</Text>
          ) : multiNode ? (
            /* Horizontal scroller for fleet mode */
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.nodeScrollContent}
            >
              {nodes.map((n, i) => (
                <NodeCard key={n.nodeId || i} node={n} />
              ))}
            </ScrollView>
          ) : (
            /* Single-node: simple vertical list row */
            nodes.map((n, i) => {
              const hColor = healthColor(n.health);
              return (
                <View key={n.nodeId || i} style={styles.nodeListRow}>
                  <MaterialCommunityIcons
                    name={n.role === 'master' ? 'server' : 'server-network'}
                    size={16}
                    color={hColor}
                  />
                  <View style={{ flex: 1, marginLeft: SPACING.sm }}>
                    <Text style={styles.nodeListName}>{n.nodeName || n.nodeId}</Text>
                    <Text style={styles.nodeListMeta}>
                      {n.role}
                      {n.isLocal ? ' · local' : ''}
                      {n.snapshot?.system?.hostname ? ` · ${n.snapshot.system.hostname}` : ''}
                    </Text>
                  </View>
                  <View style={[styles.healthBadge, { borderColor: hColor + '50', backgroundColor: hColor + '18' }]}>
                    <View style={[styles.healthDot, { backgroundColor: hColor }]} />
                    <Text style={[styles.nodeHealthText, { color: hColor }]}>{n.health.toUpperCase()}</Text>
                  </View>
                </View>
              );
            })
          )}
        </GlassCard>
      )}

      {/* ═══════════════════════════════ FLEET MODE ═══════════════════════════ */}
      {viewMode === 'fleet' && !isLoading && (
        <>
          {/* ── Fleet summary ── */}
          <GlassCard style={styles.card} animated cornerAccents>
            <View style={styles.fleetSummaryHeader}>
              <View style={[styles.headerIconWrap, { backgroundColor: COLORS.primary + '20' }]}>
                <MaterialCommunityIcons name="server-network" size={22} color={COLORS.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: SPACING.md }}>
                <Text style={styles.hostName} numberOfLines={1}>FEDERATION FLEET</Text>
                <Text style={styles.hostMeta}>
                  {fleetSummary.totalNodes} node{fleetSummary.totalNodes === 1 ? '' : 's'}
                  {fleetSummary.masters > 0 ? `  ·  ${fleetSummary.masters} master` : ''}
                  {fleetSummary.satellites > 0 ? `  ·  ${fleetSummary.satellites} satellite${fleetSummary.satellites === 1 ? '' : 's'}` : ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={refresh}
                style={styles.refreshBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                activeOpacity={0.7}
              >
                <Ionicons name="refresh" size={16} color={COLORS.primary} />
              </TouchableOpacity>
            </View>

            {/* Health pip row */}
            <View style={styles.fleetHealthPips}>
              <View style={[styles.fleetHealthPip, { borderColor: COLORS.success + '50', backgroundColor: COLORS.success + '14' }]}>
                <View style={[styles.healthDot, { backgroundColor: COLORS.success }]} />
                <Text style={[styles.fleetHealthPipText, { color: COLORS.success }]}>
                  {fleetSummary.online} ONLINE
                </Text>
              </View>
              {fleetSummary.offline > 0 ? (
                <View style={[styles.fleetHealthPip, { borderColor: COLORS.textMuted + '50', backgroundColor: COLORS.textMuted + '14' }]}>
                  <View style={[styles.healthDot, { backgroundColor: COLORS.textMuted }]} />
                  <Text style={[styles.fleetHealthPipText, { color: COLORS.textMuted }]}>
                    {fleetSummary.offline} OFFLINE
                  </Text>
                </View>
              ) : null}
            </View>

            {/* Aggregate stats */}
            <StatGrid cells={[
              { label: 'GPUs',  value: String(fleetSummary.gpuCount) },
              { label: 'VRAM',  value: fleetSummary.vramTotal > 0 ? fmtBytes(fleetSummary.vramTotal, 0) : '—' },
              { label: 'RAM',   value: fleetSummary.ramTotal > 0  ? fmtBytes(fleetSummary.ramTotal, 0)  : '—' },
            ]} />

            <View style={{ height: SPACING.sm }} />

            <StatGrid cells={[
              { label: 'AVG CPU', value: fleetSummary.avgCpu  !== null ? fmtPct(fleetSummary.avgCpu)  : '—', color: fleetSummary.avgCpu  !== null ? loadColor(fleetSummary.avgCpu)  : undefined },
              { label: 'AVG GPU', value: fleetSummary.avgGpu  !== null ? fmtPct(fleetSummary.avgGpu)  : '—', color: fleetSummary.avgGpu  !== null ? loadColor(fleetSummary.avgGpu)  : undefined },
              { label: 'RAM USE', value: fleetSummary.ramTotal > 0    ? fmtPct(fleetSummary.ramPct)   : '—', color: fleetSummary.ramTotal > 0   ? loadColor(fleetSummary.ramPct)   : undefined },
              { label: 'VRAM',    value: fleetSummary.vramTotal > 0   ? fmtPct(fleetSummary.vramPct)  : '—', color: fleetSummary.vramTotal > 0  ? loadColor(fleetSummary.vramPct)  : undefined },
            ]} />
          </GlassCard>

          {/* ── Fleet device grid ── */}
          {nodes.length === 0 ? (
            <GlassCard style={styles.card}>
              <Text style={styles.emptyText}>No federation nodes reporting.</Text>
            </GlassCard>
          ) : (
            <View style={styles.fleetGrid}>
              {nodes.map((n, i) => {
                const id = n.nodeId || String(i);
                return (
                  <FleetNodeCard
                    key={id}
                    node={n}
                    expanded={expandedNodeId === id}
                    onToggle={() => setExpandedNodeId(expandedNodeId === id ? null : id)}
                  />
                );
              })}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

export default HardwareScreen;

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  content: { padding: SPACING.lg, paddingBottom: 88 },

  // Navigation
  backBtn:  { flexDirection: 'row', alignItems: 'center', marginBottom: SPACING.sm },
  backText: { ...FONTS.small, color: COLORS.primary, marginLeft: 4 },

  // Title row
  titleRow:        { flexDirection: 'row', alignItems: 'flex-start', marginBottom: SPACING.lg },
  heading:         { ...FONTS.heading, color: COLORS.text, fontSize: 24, marginTop: 2 },
  subheading:      { ...FONTS.small, color: COLORS.textMuted, marginTop: 2 },
  statusBadge:     { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, gap: 5, marginTop: 4 },
  statusDot:       { width: 6, height: 6, borderRadius: 3 },
  statusBadgeText: { ...FONTS.tiny, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },

  // Error / loading
  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderColor: 'rgba(239,68,68,0.25)', borderWidth: 1, borderRadius: 10,
    padding: SPACING.sm, marginBottom: SPACING.md,
  },
  errorText:   { ...FONTS.small, color: COLORS.error, flex: 1 },
  loadingWrap: { alignItems: 'center', paddingVertical: 40, gap: SPACING.md },
  loadingText: { ...FONTS.small, color: COLORS.textMuted },

  // Empty
  emptyState: { alignItems: 'center', paddingVertical: SPACING.xl, gap: SPACING.sm },
  emptyTitle: { ...FONTS.small, color: COLORS.text, fontWeight: '700', fontSize: 15 },
  emptyHint:  { ...FONTS.small, color: COLORS.textMuted, textAlign: 'center' },
  emptyText:  { ...FONTS.small, color: COLORS.textMuted, paddingVertical: SPACING.sm },

  // Card container
  card: { padding: SPACING.lg, marginBottom: SPACING.md },

  // Section label
  sectionLabel: {
    ...FONTS.mono, color: COLORS.primary,
    fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
    marginBottom: SPACING.md,
  },

  // Divider
  divRow: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: SPACING.sm },

  // Header card
  headerRow:     { flexDirection: 'row', alignItems: 'center' },
  headerIconWrap:{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hostName:      { ...FONTS.small, color: COLORS.textStrong, fontWeight: '700', fontSize: 15 },
  hostMeta:      { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 3, lineHeight: 16 },
  uptimeCol:     { alignItems: 'flex-end' },
  uptimeLabel:   { ...FONTS.tiny, color: COLORS.textMuted, letterSpacing: 1.5 },
  uptimeValue:   { ...FONTS.small, color: COLORS.primary, fontWeight: '700', marginTop: 2 },
  roleBadge:     { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: SPACING.sm, alignSelf: 'flex-start', backgroundColor: COLORS.primary + '18', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
  roleBadgeText: { ...FONTS.tiny, color: COLORS.primary, fontSize: 9, letterSpacing: 1.5 },

  // Summary metrics row
  metricsRow: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.md },
  miniCard: {
    flex: 1,
    backgroundColor: withAlpha(COLORS.surfaceTint || '#000', 0.28),
    borderWidth: 1, borderColor: withAlpha(COLORS.primary, 0.18),
    borderRadius: 14, padding: SPACING.md,
    alignItems: 'center', gap: 3,
  },
  miniPct:   { ...FONTS.heading, fontSize: 20, fontWeight: '800', lineHeight: 26 },
  miniLabel: { ...FONTS.tiny, color: COLORS.textMuted, letterSpacing: 1.5, textTransform: 'uppercase' },
  miniBar:   { height: 3, borderRadius: 2, marginTop: SPACING.xs, alignSelf: 'stretch' },

  // Progress bar
  barTrack: { height: 4, backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 4, overflow: 'hidden' },
  barFill:  { height: '100%', borderRadius: 4 },
  metricBarSp: { marginBottom: SPACING.md },

  // Metric row (icon + label + value)
  metricRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  iconWrap:  { width: 26, height: 26, borderRadius: 7, alignItems: 'center', justifyContent: 'center', marginRight: SPACING.sm },
  rowLabel:  { ...FONTS.small, color: COLORS.textMuted, flex: 1 },
  rowHint:   { ...FONTS.tiny, color: COLORS.textMuted },
  rowHintSm: { ...FONTS.tiny, color: COLORS.textMuted, marginBottom: SPACING.xs },
  rowValue:  { ...FONTS.small, color: COLORS.text, fontWeight: '700' },

  // Stat grid
  statGrid:    { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: SPACING.sm, marginTop: SPACING.xs },
  statCell:    { flex: 1, alignItems: 'center', paddingVertical: SPACING.xs },
  statDivider: { width: 1, backgroundColor: 'rgba(255,255,255,0.07)' },
  statLabel:   { ...FONTS.tiny, color: COLORS.textMuted, letterSpacing: 1.5, textTransform: 'uppercase', fontSize: 9 },
  statValue:   { ...FONTS.small, color: COLORS.text, fontWeight: '700', marginTop: 3 },

  // GPU
  gpuName:   { ...FONTS.small, color: COLORS.textStrong, fontWeight: '700', fontSize: 14, marginBottom: 2 },
  gpuVendor: { ...FONTS.tiny, color: COLORS.textMuted, marginBottom: SPACING.md },
  noGpuRow:  { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.sm },
  noGpuTitle:{ ...FONTS.small, color: COLORS.textMuted, fontWeight: '600' },
  noGpuHint: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 2 },

  // CPU
  modelText: { ...FONTS.small, color: COLORS.textMuted, marginBottom: SPACING.md, lineHeight: 18 },

  // Disk
  mountSep:    { marginTop: SPACING.md, paddingTop: SPACING.md, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' },
  diskMountRow:{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  diskPath:    { ...FONTS.small, color: COLORS.text, fontFamily: 'monospace', fontSize: 12 },
  diskMeta:    { ...FONTS.tiny, color: COLORS.textMuted, marginBottom: 5 },
  diskBar:     { marginBottom: 0 },

  // Network
  ifaceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  ifaceName:    { ...FONTS.small, color: COLORS.text, fontFamily: 'monospace', fontSize: 12 },
  netStatsRow:  { flexDirection: 'row', gap: SPACING.lg, marginLeft: 19, marginBottom: SPACING.xs },
  netStat:      { flexDirection: 'row', alignItems: 'center', gap: 4 },
  netUp:        { ...FONTS.small, color: COLORS.success, fontWeight: '700' },
  netDown:      { ...FONTS.small, color: '#60a5fa', fontWeight: '700' },
  netVal:       { ...FONTS.small, color: COLORS.text },

  // Federation node header
  nodeHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  nodeCountBadge:{ backgroundColor: COLORS.primary + '22', borderRadius: 10, paddingHorizontal: 7, paddingVertical: 2 },
  nodeCountText: { ...FONTS.tiny, color: COLORS.primary, fontWeight: '700' },

  // Node scroll (horizontal)
  nodeScrollContent: { paddingBottom: 4, gap: SPACING.sm },
  nodeCard: {
    width: 148,
    backgroundColor: 'rgba(18,18,24,0.85)',
    borderWidth: 1, borderColor: COLORS.primaryDim,
    borderRadius: 12, padding: SPACING.md,
  },
  nodeCardHeader:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 5 },
  nodeCardName:    { ...FONTS.tiny, fontWeight: '700', flex: 1, fontSize: 11 },
  localBadge:      { backgroundColor: COLORS.primary + '22', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  localBadgeText:  { fontSize: 8, color: COLORS.primary, fontWeight: '700', letterSpacing: 0.5 },
  nodeHealthRow:   { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: SPACING.sm },
  healthDot:       { width: 5, height: 5, borderRadius: 3 },
  nodeHealthText:  { ...FONTS.tiny, letterSpacing: 1.5, fontSize: 9, fontWeight: '700' },
  nodeAgeText:     { ...FONTS.tiny, color: COLORS.textMuted, fontSize: 9 },
  nodeMiniRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 5, marginBottom: 2 },
  nodeMiniLabel:   { fontSize: 9, color: COLORS.textMuted, letterSpacing: 1.5, textTransform: 'uppercase' },
  nodeMiniVal:     { fontSize: 9, fontWeight: '700' },
  nodeMiniBar:     { height: 2, borderRadius: 1, marginBottom: 2 },
  nodeGpuName:     { fontSize: 9, color: COLORS.textMuted, marginTop: SPACING.xs },
  nodeNoSnap:      { ...FONTS.tiny, color: COLORS.textMuted, fontStyle: 'italic', marginTop: SPACING.sm },

  // Node list row (single-node or vertical list)
  nodeListRow:  { flexDirection: 'row', alignItems: 'center', paddingVertical: SPACING.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)' },
  nodeListName: { ...FONTS.small, color: COLORS.text, fontWeight: '600' },
  nodeListMeta: { ...FONTS.tiny, color: COLORS.textMuted, marginTop: 2 },
  healthBadge:  { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },

  // ── Mode toggle (MASTER / FLEET pill chips) ──
  modeToggleRow: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginBottom: SPACING.md,
  },
  modeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  modeChipActive: {
    backgroundColor: COLORS.primary + '18',
    borderColor: COLORS.primary + '60',
  },
  modeChipText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1.2,
  },
  modeChipTextActive: { color: COLORS.primary },
  modeCountPip: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 99,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: 2,
  },
  modeCountPipActive: { backgroundColor: COLORS.primary + '28' },
  modeCountPipText: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontWeight: '700',
    fontSize: 9,
  },
  modeCountPipTextActive: { color: COLORS.primary },

  // ── Fleet summary header ──
  fleetSummaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  refreshBtn: {
    width: 32, height: 32, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.primary + '14',
    borderWidth: 1, borderColor: COLORS.primary + '30',
  },
  fleetHealthPips: {
    flexDirection: 'row',
    gap: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  fleetHealthPip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 99,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  fleetHealthPipText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
  },

  // ── Fleet grid + rich node card ──
  fleetGrid: {
    gap: SPACING.sm,
    marginBottom: SPACING.md,
  },
  fleetCard: {
    backgroundColor: 'rgba(18,18,24,0.85)',
    borderWidth: 1,
    borderColor: COLORS.primaryDim || (COLORS.primary + '30'),
    borderRadius: 12,
    padding: SPACING.md,
  },
  fleetCardActive: {
    borderColor: COLORS.primary + '70',
    backgroundColor: 'rgba(24,24,32,0.92)',
  },
  fleetCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  fleetCardName: {
    ...FONTS.small,
    color: COLORS.textStrong,
    fontWeight: '700',
    fontSize: 13,
    flex: 1,
  },
  fleetRoleBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  fleetRoleBadgeText: {
    ...FONTS.tiny,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  fleetHealthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: SPACING.sm,
  },
  fleetHealthText: {
    ...FONTS.tiny,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  fleetGpuLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: SPACING.sm,
  },
  fleetGpuName: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    flex: 1,
    fontSize: 11,
  },
  fleetGpuTemp: {
    ...FONTS.tiny,
    color: COLORS.primary,
    fontWeight: '700',
    fontSize: 10,
  },
  fleetMetricStrip: {
    flexDirection: 'row',
    gap: SPACING.xs,
  },
  fleetMetric: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 5,
    alignItems: 'center',
    gap: 2,
  },
  fleetMetricLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 8,
    letterSpacing: 1.3,
  },
  fleetMetricVal: {
    ...FONTS.small,
    fontSize: 13,
    fontWeight: '800',
  },
  fleetMetricBar: {
    height: 2,
    borderRadius: 1,
    alignSelf: 'stretch',
    marginTop: 2,
  },
  fleetExpand: {
    marginTop: SPACING.sm,
  },
  fleetDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginBottom: SPACING.sm,
  },
  fleetDetailGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: SPACING.sm,
  },
  fleetDetail: {
    width: '50%',
    paddingVertical: 3,
  },
  fleetDetailLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 8,
    letterSpacing: 1.3,
  },
  fleetDetailValue: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 12,
    marginTop: 1,
  },
  fleetMemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  fleetMemLabel: {
    ...FONTS.tiny,
    color: COLORS.textMuted,
    fontSize: 9,
    letterSpacing: 1.3,
  },
  fleetMemValue: {
    ...FONTS.small,
    color: COLORS.text,
    fontWeight: '600',
    fontSize: 11,
  },
});
