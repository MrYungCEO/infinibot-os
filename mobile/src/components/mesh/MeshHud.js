/**
 * MeshHud — the web mesh's top-left HUD column, natively (agency-world-viz.ts
 * installHudColumn + agent-mesh-page.ts .mesh-hud + queue-holding-zone.ts +
 * world-map-active-breakdown.ts):
 *   toolbar      ← · ● AGENT MESH n · FIT │ BROADCAST │ Auto-focus │ Spread │ Director
 *   live stats   ONLINE AGENTS · TOOLS / MIN · TOKENS / HR
 *   holding zone queue.list (one line when the queue is clear)
 *   active list  ACTIVE AGENTS n (working → blocked → idle, max 6, +N)
 *
 * Phone fit: in portrait the toolbar WRAPS onto a second row (never scrolls
 * sideways); in landscape (`compact`) the pills go icon-only, the panels are
 * opaque and narrow, and the holding zone shows at most two entries — so the
 * column stays a slim strip beside the map instead of a see-through sheet
 * over it. `onLayout` reports the column's box so the camera fits around it.
 *
 * Details toggle: the stats, holding zone and active list collapse behind one
 * chevron pill (`detailsOpen`, persisted by the screen; closed by default in
 * portrait), and the pills go icon-only, so the HUD is a single slim row and
 * the map gets the screen.
 */
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AGENT_SPRITES } from '../../lib/mesh/mesh-assets';
import { formatHudNumber } from '../../lib/mesh/web-mesh.generated';
import { MeshIcon } from './MeshIcons';
import { BX_BTN, BX_TEXT, GOLD, GOLD_LT, MONO, spriteSlot } from './mesh-style';
import { decisionsForAgent } from '../../lib/mesh/owner-decisions';

const BUCKET = (s) => (s === 'working' || s === 'starting' || s === 'finishing' ? 'working' : s === 'blocked' ? 'blocked' : s === 'completed' || s === 'failed' ? 'completed' : 'idle');
const BUCKET_COLOR = { working: '#e9c46a', blocked: '#fb7185', idle: '#94a3b8' };
const PANEL = 'rgba(9,9,12,0.97)';

function Pill({ label, icon, on, onPress, tone = 'gold', testID, a11y, iconOnly }) {
  const onStyle = on ? (tone === 'red' ? styles.onRed : styles.onGold) : null;
  const color = on ? (tone === 'red' ? '#fecaca' : '#f3d98a') : '#d4d4d8';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [BX_BTN, styles.pill, iconOnly && styles.pillIcon, onStyle, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      accessibilityLabel={a11y || label}
      testID={testID}
      hitSlop={4}
    >
      <MeshIcon name={icon} size={iconOnly ? 17 : 14} color={on ? (tone === 'red' ? '#f87171' : GOLD_LT) : '#a1a1aa'} />
      {iconOnly ? (on ? <View style={[styles.onDot, tone === 'red' && { backgroundColor: '#f87171' }]} /> : null) : <Text style={[BX_TEXT, styles.pillText, { color }]} numberOfLines={1}>{label}</Text>}
    </Pressable>
  );
}

export function activeBreakdown(agents) {
  const list = agents.filter((a) => !a.resting && BUCKET(a.status) !== 'completed');
  const order = { working: 0, blocked: 1, idle: 2 };
  list.sort((a, b) => order[BUCKET(a.status)] - order[BUCKET(b.status)] || (Number(b.progress) || 0) - (Number(a.progress) || 0));
  return { total: list.length, cards: list.slice(0, 6), more: Math.max(0, list.length - 6) };
}

export function MeshHud({
  live, count, onBack, onFit, broadcast, onBroadcast, autoFocus, onAutoFocus, spread, onSpread, director, onDirector,
  stats, queue, agents, activeOpen, onToggleActive, onAgentPress, width, compact = false, onLayout,
  decisions = [], onDecisions, detailsOpen = true, onToggleDetails,
}) {
  const icons = compact || !!onToggleDetails;
  const breakdown = activeBreakdown(agents);
  const qMax = compact ? 2 : 4;
  return (
    <View style={[styles.col, compact && styles.colCompact, { width }]} pointerEvents="box-none" testID="mesh-hud" onLayout={onLayout}>
      <View style={styles.toolbar} testID="mesh-toolbar">
        <View style={styles.meshHud}>
          {onBack ? (
            <Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Back" testID="mesh-back" hitSlop={6}>
              <MeshIcon name="back" size={17} color={GOLD} strokeWidth={2.2} />
            </Pressable>
          ) : null}
          <View style={[styles.dot, !live && styles.dotOff]} />
          <Text style={styles.meshTitle}>AGENT MESH</Text>
          <Text style={styles.meshCount} accessibilityLabel={`${count} agents on the map`}>{count}</Text>
          <Pressable onPress={onFit} style={styles.fit} accessibilityRole="button" accessibilityLabel="Fit every agent in view" testID="mesh-fit" hitSlop={4}>
            <Text style={styles.fitText}>FIT</Text>
          </Pressable>
        </View>
        <Pill icon="broadcast" iconOnly={icons} label={broadcast ? 'BROADCAST ON' : 'BROADCAST'} a11y={broadcast ? 'Broadcast camera on' : 'Broadcast camera off'} on={broadcast} tone="red" onPress={onBroadcast} testID="mesh-broadcast" />
        <Pill icon="target" iconOnly={icons} label={`Auto-focus: ${autoFocus ? 'ON' : 'OFF'}`} on={autoFocus} onPress={onAutoFocus} testID="mesh-autofocus" />
        <Pill icon="spread" iconOnly={icons} label={`Spread: ${spread ? 'ON' : 'OFF'}`} on={spread} onPress={onSpread} testID="mesh-spread" />
        <Pill icon="director" iconOnly={icons} label="Director" a11y={director ? 'Director mode on' : 'Director mode off'} on={director} onPress={onDirector} testID="mesh-director" />
        {onToggleDetails ? (
          <Pressable
            onPress={onToggleDetails}
            style={({ pressed }) => [BX_BTN, styles.pill, styles.detailsPill, detailsOpen && styles.onGold, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityState={{ expanded: detailsOpen }}
            accessibilityLabel={detailsOpen ? 'Hide stats, holding zone and active agents' : 'Show stats, holding zone and active agents'}
            testID="mesh-details-toggle"
            hitSlop={4}
          >
            <MeshIcon name={detailsOpen ? 'chevronDown' : 'chevronRight'} size={13} color={GOLD_LT} strokeWidth={2.2} />
            <Text style={[BX_TEXT, styles.pillText, { color: '#f3d98a' }]}>{stats.online ?? 0}</Text>
          </Pressable>
        ) : null}
        {decisions.length ? <Pill icon="alert" iconOnly={icons} label={`Decisions (${decisions.length})`} a11y={`${decisions.length} owner decisions`} on onPress={onDecisions} testID="mesh-decisions" /> : null}
      </View>

      {detailsOpen ? (<>
      <View style={[styles.stats, compact && styles.statsCompact]} accessibilityRole="summary" accessibilityLabel="Live agent metrics">
        {[['ONLINE AGENTS', 'ONLINE', String(stats.online ?? 0)], ['TOOLS / MIN', 'TOOLS/MIN', formatHudNumber(stats.toolsPerMin ?? 0)], ['TOKENS / HR', 'TOKENS/HR', stats.tokensPerHr == null ? '—' : formatHudNumber(stats.tokensPerHr)]].map(([l, short, v], i) => (
          <View key={l} style={[styles.stat, compact && styles.statCompact, i > 0 && styles.statSep]}>
            <Text style={styles.statLabel} numberOfLines={1}>{compact ? short : l}</Text>
            <Text style={[styles.statValue, compact && styles.statValueCompact]}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.atrium, compact && styles.atriumCompact]} testID="mesh-holding-zone">
        <View style={styles.atriumHead}>
          <Text style={styles.atriumTitle}>HOLDING ZONE</Text>
          <Text style={styles.atriumCount}>{queue.length}</Text>
        </View>
        {queue.slice(0, qMax).map((q) => (
          <View key={q.id} style={[styles.qRow, compact && styles.qRowCompact]}>
            <Text style={styles.qName} numberOfLines={1}>{q.phaseSpec?.[q.currentPhaseIdx || 0]?.name || q.id}</Text>
            {compact ? null : <Text style={styles.qMeta} numberOfLines={1}>{String(q.id).slice(0, 8)} · {q.status}{q.phaseSpec?.length ? ` · ${(q.currentPhaseIdx || 0) + 1}/${q.phaseSpec.length}` : ''}</Text>}
          </View>
        ))}
        {queue.length > qMax ? <Text style={styles.qMore}>+{queue.length - qMax} more</Text> : null}
      </View>

      {breakdown.total ? (
        <View style={[styles.active, compact && styles.activeCompact]}>
          <Pressable onPress={onToggleActive} style={[styles.activeHead, compact && styles.activeHeadCompact]} accessibilityRole="button" accessibilityState={{ expanded: activeOpen }} testID="mesh-active-toggle">
            <Text style={styles.activeTitle}>ACTIVE AGENTS</Text>
            <Text style={styles.activeCount}>{breakdown.total}</Text>
            <MeshIcon name={activeOpen ? 'chevronDown' : 'chevronRight'} size={12} color={GOLD_LT} strokeWidth={2.2} />
          </Pressable>
          {activeOpen ? breakdown.cards.slice(0, compact ? 3 : 6).map((a) => {
            const b = BUCKET(a.status);
            const pr = Number(a.progress) || 0;
            const decisionCount = decisionsForAgent(decisions, a).length;
            return (
              <Pressable key={a.sessionKey} onPress={() => onAgentPress(a.sessionKey)} style={[styles.card, compact && styles.cardCompact]} accessibilityRole="button" accessibilityLabel={`${a.label}, ${b}`}>
                <Image source={AGENT_SPRITES[spriteSlot(a)]} style={[styles.cardSprite, compact && styles.cardSpriteCompact]} resizeMode="contain" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.cardLabel} numberOfLines={1}>{String(a.label || a.agentId).toUpperCase()}</Text>
                  {compact ? null : <Text style={styles.cardTask} numberOfLines={1}>{a.currentTask || a.activityLabel || '—'}</Text>}
                  <View style={styles.cardTrack}><View style={[styles.cardFill, { width: `${Math.min(100, pr > 1 ? pr : pr * 100)}%` }]} /></View>
                </View>
                {decisionCount ? <View style={styles.decisionBadge}><MeshIcon name="alert" size={10} color="#fde68a" /><Text style={styles.decisionBadgeText}>{decisionCount}</Text></View> : null}
                <View style={[styles.bucket, { borderColor: BUCKET_COLOR[b] }]}><Text style={[styles.bucketText, { color: BUCKET_COLOR[b] }]}>{b.toUpperCase()}</Text></View>
              </Pressable>
            );
          }) : null}
          {activeOpen && breakdown.total > (compact ? 3 : 6) ? <Text style={styles.more}>+{breakdown.total - (compact ? 3 : 6)} more</Text> : null}
        </View>
      ) : null}
      </>) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  col: { position: 'absolute', top: 8, left: 8, gap: 6 },
  colCompact: { gap: 5 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  pill: { paddingHorizontal: 9, gap: 6, minHeight: 34, backgroundColor: PANEL, borderColor: 'rgba(255,255,255,0.16)' },
  pillIcon: { width: 38, paddingHorizontal: 0, justifyContent: 'center' },
  detailsPill: { paddingHorizontal: 8, gap: 4 },
  pillText: { fontSize: 10.5, letterSpacing: 0.4 },
  onDot: { position: 'absolute', top: 5, right: 5, width: 5, height: 5, borderRadius: 3, backgroundColor: GOLD_LT },
  onGold: { borderColor: 'rgba(212,175,55,0.85)', backgroundColor: 'rgba(38,30,8,0.97)' },
  onRed: { borderColor: '#f87171', backgroundColor: 'rgba(48,12,12,0.97)' },
  pressed: { backgroundColor: 'rgba(30,41,59,0.97)' },
  meshHud: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingLeft: 2, paddingRight: 3, borderWidth: 1, borderColor: 'rgba(212,175,55,0.34)', borderRadius: 8, backgroundColor: PANEL },
  back: { paddingHorizontal: 6, minHeight: 30, justifyContent: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: GOLD, shadowColor: GOLD, shadowOpacity: 0.9, shadowRadius: 4 },
  dotOff: { backgroundColor: '#777', shadowOpacity: 0 },
  meshTitle: { color: GOLD, fontSize: 10.5, letterSpacing: 1.5, fontWeight: '600', fontFamily: MONO },
  meshCount: { color: '#e8e6e3', fontSize: 10.5, letterSpacing: 0.6, fontFamily: MONO },
  fit: { paddingHorizontal: 8, minHeight: 30, justifyContent: 'center', borderRadius: 6, borderLeftWidth: 1, borderLeftColor: 'rgba(212,175,55,0.2)' },
  fitText: { color: '#e8e6e3', fontSize: 10.5, letterSpacing: 0.9, fontFamily: MONO },
  stats: { flexDirection: 'row', maxWidth: 340, borderRadius: 8, backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)', borderLeftWidth: 3, borderLeftColor: GOLD_LT },
  statsCompact: { maxWidth: undefined },
  stat: { flex: 1, paddingHorizontal: 8, paddingVertical: 4, gap: 2 },
  statCompact: { paddingHorizontal: 6, paddingVertical: 3, gap: 1 },
  statSep: { borderLeftWidth: 1, borderLeftColor: 'rgba(212,175,55,0.18)' },
  statLabel: { color: '#9ca3af', fontSize: 7.5, fontWeight: '600', letterSpacing: 1.1, fontFamily: MONO },
  statValue: { color: GOLD_LT, fontSize: 13, fontWeight: '700', fontFamily: MONO },
  statValueCompact: { fontSize: 12 },
  atrium: { maxWidth: 340, paddingVertical: 7, paddingHorizontal: 10, borderRadius: 12, backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)' },
  atriumCompact: { maxWidth: undefined, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 8 },
  atriumHead: { flexDirection: 'row', justifyContent: 'space-between' },
  atriumTitle: { color: GOLD, fontSize: 10, letterSpacing: 1.5, fontFamily: MONO },
  atriumCount: { color: 'rgba(255,240,200,0.75)', fontSize: 10, fontWeight: '600', fontFamily: MONO },
  qRow: { marginTop: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(212,175,55,0.18)' },
  qRowCompact: { marginTop: 4, paddingTop: 4 },
  qName: { color: '#f6edd2', fontSize: 11, fontWeight: '600' },
  qMeta: { color: 'rgba(255,240,200,0.55)', fontSize: 9.5, fontFamily: MONO },
  qMore: { color: 'rgba(255,240,200,0.55)', fontSize: 9.5, fontFamily: MONO, marginTop: 4 },
  active: { maxWidth: 340, borderRadius: 8, backgroundColor: PANEL, borderWidth: 1, borderColor: 'rgba(212,175,55,0.35)', paddingHorizontal: 8, paddingVertical: 2 },
  activeCompact: { maxWidth: undefined },
  activeHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  activeHeadCompact: { minHeight: 30 },
  activeTitle: { color: GOLD_LT, fontSize: 9.5, letterSpacing: 1.6, fontWeight: '700', fontFamily: MONO, flex: 1 },
  activeCount: { color: GOLD_LT, fontSize: 11, fontWeight: '700', fontFamily: MONO },
  card: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(212,175,55,0.15)', minHeight: 44 },
  cardCompact: { minHeight: 36, paddingVertical: 3 },
  cardSprite: { width: 22, height: 33 },
  cardSpriteCompact: { width: 16, height: 24 },
  cardLabel: { color: '#f6edd2', fontSize: 9.5, fontWeight: '700', letterSpacing: 0.6, fontFamily: MONO },
  cardTask: { color: 'rgba(239,230,204,0.6)', fontSize: 9.5 },
  cardTrack: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: 3, overflow: 'hidden' },
  cardFill: { height: 3, backgroundColor: GOLD_LT },
  bucket: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
  bucketText: { fontSize: 8, fontWeight: '700', letterSpacing: 0.8, fontFamily: MONO },
  decisionBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: 'rgba(245,197,66,0.55)', borderRadius: 999, paddingHorizontal: 5, paddingVertical: 2, backgroundColor: 'rgba(245,197,66,0.1)' },
  decisionBadgeText: { color: '#fde68a', fontSize: 8, fontWeight: '800', fontFamily: MONO },
  more: { color: 'rgba(239,230,204,0.6)', fontSize: 9.5, textAlign: 'center', paddingVertical: 4, fontFamily: MONO },
});
