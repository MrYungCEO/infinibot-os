/**
 * Native Knowledge Graph chrome — toolbar, legend (status + layer filters),
 * node-shape legend, Signals HUD (signals / activity / groups), mode hint,
 * toast with Undo, banners. Mirrors the web graph's phone layout: back /
 * count / search row + a swipeable tools strip (portrait), one row in
 * landscape; legend as a one-row strip.
 */
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Path } from 'react-native-svg';

import * as core from './generated/kg-core';
import { KG, kgSheet, kgStyles } from './kg-theme';
import { rgba, mixHex } from './kg-colors';

const { CONNECTIONS_MODES, GROUP_MODES, HEALTH_COLOR, HEALTH_LABEL, KIND_LABEL, KIND_PALETTE, REL_LEGEND, REL_STYLES, relativeAge } = core;

export function KgButton({ icon, label, onPress, on, primary, danger, disabled, badge, hot, compact, testID, style, iconSize = 17 }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label || icon}
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      hitSlop={4}
      style={({ pressed }) => [
        kgStyles.btn,
        compact && { paddingHorizontal: 9 },
        on && kgStyles.btnOn,
        primary && kgStyles.btnPrimary,
        danger && kgStyles.btnDanger,
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={iconSize} color={danger ? '#fca5a5' : primary || on ? '#fff3cf' : KG.fg} /> : null}
      {label ? <Text style={[kgStyles.btnText, (primary || on) && kgStyles.btnTextPrimary, danger && { color: '#fca5a5' }]} numberOfLines={1}>{label}</Text> : null}
      {badge ? (
        <View style={[styles.badge, hot && styles.badgeHot]}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Pill({ text, color = KG.dim, live }) {
  return (
    <View style={[kgStyles.pill, { backgroundColor: rgba(color, 0.16), borderColor: rgba(color, 0.4) }]}>
      <Text style={[kgStyles.pillText, { color: mixHex(color, '#ffffff', 0.8) }]}>{live ? '● ' : ''}{text}</Text>
    </View>
  );
}

// ── Toolbar ─────────────────────────────────────────────────

export function KgToolbar({ c, landscape, onBack, onGroupPress, can3d = true, secureSlot = null, secureBadge = null }) {
  const shown = c.nodes.length;
  const total = c.snapshot?.nodes.length ?? 0;
  const high = c.hudInsights.filter((i) => i.severity === 'high').length;
  const tools = (
    <>
      {/* Secure Mode toggle first: the lane switch is always in view. */}
      {secureSlot}
      {/* The renderer toggle leads the strip so it's always in view (the web's .kg-btn--mode). */}
      <KgModeButton c={c} can3d={can3d} />
      <View style={styles.seg}>
        <KgButton icon="scan-outline" on={c.selectMode} compact onPress={() => c.setModes(false, !c.selectMode)} testID="kg-select-mode" label={null} />
        <KgButton icon="link-outline" on={c.linkMode} compact onPress={() => c.setModes(!c.linkMode, false)} testID="kg-link-mode" />
      </View>
      <KgButton icon="layers-outline" label={GROUP_MODES.find((g) => g.id === c.groupMode)?.label ?? 'Group'} onPress={onGroupPress} testID="kg-group" />
      <View style={styles.conn}>
        <Ionicons name="git-network-outline" size={14} color={KG.dim} style={{ marginHorizontal: 4 }} />
        {CONNECTIONS_MODES.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => c.setConnectionsMode(m.id)}
            style={[styles.connB, c.prefs.connections === m.id && styles.connOn]}
            testID={`kg-connections-${m.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: c.prefs.connections === m.id }}
          >
            <Text style={[styles.connText, c.prefs.connections === m.id && { color: '#fff3cf' }]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>
      <KgButton icon="ellipse-outline" on={c.prefs.hulls} compact onPress={() => c.setHulls(!c.prefs.hulls)} testID="kg-hulls" />
      <KgButton icon="radio-outline" label="Signals" on={c.hudOpen} onPress={() => c.toggleHud()} badge={c.hudInsights.length || null} hot={high > 0} testID="kg-signals" />
      <KgButton icon="refresh" compact disabled={c.loading} onPress={() => void c.refresh(true)} testID="kg-refresh" />
      <KgButton icon="expand-outline" compact onPress={() => c.resetView()} testID="kg-fit" />
      <KgButton icon="options-outline" on={c.settingsOpen} compact onPress={() => { c.settingsOpen = !c.settingsOpen; c.emit(); }} testID="kg-settings" />
    </>
  );
  return (
    <View style={styles.toolbar}>
      <View style={styles.row}>
        <KgButton icon="chevron-back" compact onPress={onBack} testID="kg-back" />
        <Text style={styles.title} numberOfLines={1}>{landscape ? 'GRAPH' : 'KNOWLEDGE GRAPH'}</Text>
        {total > 0 ? <Text style={styles.count} numberOfLines={1} testID="kg-count">{shown}</Text> : null}
        {secureBadge}
        <TextInput
          value={c.search}
          onChangeText={(t) => c.setSearch(t)}
          placeholder="Search projects, clients, notes…"
          placeholderTextColor={KG.dimmer}
          style={[kgStyles.input, styles.search]}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          testID="kg-search"
        />
        {landscape ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools} style={{ flexShrink: 1 }}>
            {tools}
          </ScrollView>
        ) : null}
      </View>
      {!landscape ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools} testID="kg-tools">
          {tools}
        </ScrollView>
      ) : null}
    </View>
  );
}

/**
 * The web's renderer toggle (`.kg-btn--mode`): "3D" lit gold while the 3D
 * galaxy shows, "2D" for the flat map; a tap flips it (remembered).
 */
export function KgModeButton({ c, can3d = true }) {
  const is3d = c.renderer === '3d';
  const disabled = !is3d && !can3d;
  return (
    <Pressable
      onPress={() => c.setRenderer(is3d ? '2d' : '3d')}
      disabled={disabled}
      style={[kgStyles.btn, styles.modeBtn, is3d && kgStyles.btnOn, disabled && { opacity: 0.4 }]}
      testID="kg-renderer"
      accessibilityRole="button"
      accessibilityLabel={is3d ? '3D galaxy — tap for the flat map' : 'Flat map — tap for the 3D galaxy'}
    >
      <Text style={[styles.modeText, is3d && { color: KG.goldText }]}>{is3d ? '3D' : '2D'}</Text>
    </Pressable>
  );
}

// ── Legend (filters) ────────────────────────────────────────

/** Premium stroke chevron (up = collapse, down = expand). */
function Chevron({ up, size = 14, color = KG.goldSoft }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <Path d={up ? 'M5 12.5 10 7.5 15 12.5' : 'M5 7.5 10 12.5 15 7.5'} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function KgLegend({ c, landscape = false }) {
  const lg = c.legend();
  const { width } = useWindowDimensions();
  // ≤ 640 px the web shows three link colours (.kg-legend-links :nth-child(n+4) hidden).
  const links = REL_LEGEND.slice(0, width <= 640 ? 3 : 5);
  // Landscape phones are short: the strip starts as its one-row summary
  // (a tap opens it for this session); portrait follows the saved choice.
  const open = landscape ? !!c.legendLandscapeOpen : c.prefs.legend !== 'closed';
  const setOpen = (v) => {
    if (landscape) {
      c.legendLandscapeOpen = v;
      c.emit();
    } else c.setLegendOpen(v);
  };
  const toggle = (
    <Pressable onPress={() => setOpen(!open)} hitSlop={8} style={styles.legendToggle} testID="kg-legend-toggle" accessibilityRole="button" accessibilityLabel={open ? 'Collapse filters' : 'Expand filters'}>
      <Chevron up={open} />
    </Pressable>
  );
  if (!open) {
    const hOn = lg.health.filter((h) => h.on).length;
    const kOn = lg.kinds.filter((k) => k.on).length;
    return (
      <Pressable onPress={() => setOpen(true)} style={[styles.legend, styles.legendClosed]} testID="kg-legend">
        <Text style={styles.legendLabel}>STATUS</Text>
        <Text style={styles.lchipCount}>{hOn}/{lg.health.length}</Text>
        <Text style={styles.legendLabel}>LAYERS</Text>
        <Text style={styles.lchipCount}>{kOn}/{lg.kinds.length}</Text>
        <View style={{ flex: 1 }} />
        {toggle}
      </Pressable>
    );
  }
  // The web legend strip: one wrapping flow of groups (STATUS chips, LAYERS
  // chips, the size + link-colour key).
  return (
    <View style={styles.legend} testID="kg-legend">
      <View style={styles.legendGroup} testID="kg-legend-status">
        <Text style={styles.legendLabel}>STATUS</Text>
        {lg.health.map((h) => (
          <Pressable key={h.health} onPress={() => c.toggleHealth(h.health)} style={[styles.lchip, h.on ? styles.lchipOn : styles.lchipOff]} testID={`kg-health-${h.health}`} accessibilityState={{ selected: h.on }}>
            <View style={[styles.ring, { backgroundColor: HEALTH_COLOR[h.health], shadowColor: HEALTH_COLOR[h.health] }]} />
            <Text style={styles.lchipText}>{HEALTH_LABEL[h.health]}</Text>
            <Text style={styles.lchipCount}>{h.count}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.legendGroup} testID="kg-legend-layers">
        <Text style={styles.legendLabel}>LAYERS</Text>
        {lg.kinds.map((k) => (
          <Pressable key={k.kind} onPress={() => c.toggleKind(k.kind)} style={[styles.lchip, k.on ? styles.lchipOn : styles.lchipOff]} testID={`kg-kind-${k.kind}`} accessibilityState={{ selected: k.on }}>
            <View style={[styles.dot, { backgroundColor: KIND_PALETTE[k.kind] }, k.kind === 'client' && styles.hex]} />
            <Text style={styles.lchipText}>{KIND_LABEL[k.kind]}</Text>
            <Text style={styles.lchipCount}>{k.count}</Text>
          </Pressable>
        ))}
        {lg.consolidated ? (
          <Pressable onPress={() => c.toggleConsolidated()} style={[styles.lchip, c.showConsolidated ? styles.lchipOn : styles.lchipOff]} testID="kg-consolidated">
            <Text style={styles.lchipText}>Consolidated</Text>
            <Text style={styles.lchipCount}>{lg.consolidated}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.legendGroup} testID="kg-legend-key">
        <View style={styles.note}>
          <View style={styles.sizeDots}>
            <View style={[styles.sd, { width: 5, height: 5 }]} />
            <View style={[styles.sd, { width: 8, height: 8 }]} />
            <View style={[styles.sd, { width: 12, height: 12 }]} />
          </View>
          <Text style={styles.noteText}>size = connections</Text>
        </View>
        {links.map((cls) => (
          <View key={cls} style={styles.lk}>
            <View style={{ width: 16, height: Math.max(2, Math.round(REL_STYLES[cls].width)), borderRadius: 2, backgroundColor: REL_STYLES[cls].color, shadowColor: REL_STYLES[cls].color, shadowOpacity: 0.8, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } }} />
            <Text style={styles.lkText}>{REL_STYLES[cls].label}</Text>
          </View>
        ))}
        {toggle}
      </View>
    </View>
  );
}

// ── Node shapes (mirrors KIND_SHAPE) ────────────────────────

const SHAPES = [
  ['Project', 'M10 2 17 8 10 18 3 8Z M3 8H17 M7 8 10 2 13 8 10 18', '#f5c542'],
  ['Sub-project', 'M10 6 14 9.5 10 15 6 9.5Z M6 9.5H14', '#c9a64a'],
  ['Task', 'M4 4H16V16H4Z M7 7H13V13H7Z'],
  ['Note', 'M6 3H15V15H6Z M4 5H13V17H4Z'],
  ['Report', 'M4 3H16V17H4Z M7 14V11 M10 14V8 M13 14V6'],
  ['Media', 'M3 5H17V15H3Z M9 8 12 10 9 12Z'],
  ['Agent', 'M10 6.5A3.5 3.5 0 1 1 9.99 6.5Z M2 11C6 6 14 6 18 9'],
  ['Person', 'M10 3.5A2.5 2.5 0 1 1 9.99 3.5Z M6 17V12A4 4 0 0 1 14 12V17Z'],
  ['System', 'M10 3 16 6.5V13.5L10 17 4 13.5V6.5Z'],
  ['Knowledge', 'M10 7.5A2.5 2.5 0 1 1 9.99 7.5Z M10 2V5 M10 15V18 M2 10H5 M15 10H18 M4.5 4.5 6.5 6.5 M15.5 15.5 13.5 13.5 M15.5 4.5 13.5 6.5 M4.5 15.5 6.5 13.5'],
];

export function KgShapeLegend({ style }) {
  return (
    <View style={[styles.shapes, style]} pointerEvents="none" testID="kg-shape-legend">
      {SHAPES.map(([label, d, color]) => (
        <View key={label} style={styles.shapeItem}>
          <Svg width={13} height={13} viewBox="0 0 20 20">
            <Path d={d} stroke={color || 'rgba(228,228,231,0.75)'} strokeWidth={1.6} fill="none" strokeLinejoin="round" />
          </Svg>
          <Text style={styles.shapeText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Signals HUD ─────────────────────────────────────────────

const ACTION_LABEL = {
  focus: ['Focus', 'locate-outline'],
  select: ['Select', 'checkmark'],
  consolidate: ['Consolidate', 'layers-outline'],
  subs: ['Consolidate', 'layers-outline'],
  link: ['Link', 'link-outline'],
  suggest: ['Suggest links', 'git-network-outline'],
  chat: ['Ask AI', 'sparkles-outline'],
  spawn: ['Send agent', 'hardware-chip-outline'],
  dismiss: ['Dismiss', 'close'],
};

export function KgHudPill({ c, style }) {
  const high = c.hudInsights.filter((i) => i.severity === 'high').length;
  return (
    <Pressable onPress={() => c.toggleHud()} style={[styles.hudPill, high && styles.hudPillHot, style]} testID="kg-hud-pill" accessibilityRole="button" accessibilityLabel="Open signals">
      <Ionicons name="radio-outline" size={15} color={high ? '#fca5a5' : KG.goldSoft} />
      <Text style={styles.hudPillN}>{c.hudInsights.length}</Text>
      <Text style={styles.hudPillT}>signals</Text>
    </Pressable>
  );
}

function InsightCard({ c, ins }) {
  const active = c.activeInsight?.id === ins.id;
  const sev = KG.sev[ins.severity] || KG.gold;
  return (
    <View style={[styles.insight, active && { backgroundColor: rgba(sev, 0.14), borderColor: rgba(sev, 0.55) }]} testID={`kg-insight-${ins.kind}`}>
      <Pressable onPress={() => void c.insightAction(ins, 'focus')} style={{ borderLeftWidth: 2, borderLeftColor: sev, paddingLeft: 8 }}>
        <Text style={styles.insightTitle}>{ins.title}</Text>
        {ins.detail ? <Text style={styles.insightDetail} numberOfLines={2}>{ins.detail}</Text> : null}
      </Pressable>
      <View style={styles.insightActions}>
        {ins.actions
          .filter((a) => a !== 'focus')
          .slice(0, 3)
          .map((a) => (
            <Pressable key={a} onPress={() => void c.insightAction(ins, a)} style={styles.ia} testID={`kg-ia-${a}`}>
              <Ionicons name={ACTION_LABEL[a][1]} size={13} color={KG.goldSoft} />
              <Text style={styles.iaText}>{ACTION_LABEL[a][0]}</Text>
            </Pressable>
          ))}
        <Pressable onPress={() => c.dismissInsight(ins)} style={[styles.ia, { marginLeft: 'auto' }]} accessibilityLabel="Dismiss">
          <Ionicons name="close" size={14} color={KG.dim} />
        </Pressable>
      </View>
    </View>
  );
}

export function KgHud({ c, fps, style }) {
  const st = c.hudStats();
  const groups = c.grouping?.groups ?? [];
  const Tab = ({ id, label, n }) => (
    <Pressable onPress={() => c.setHudTab(id)} style={[styles.hudTab, c.hudTab === id && styles.hudTabOn]} testID={`kg-hud-tab-${id}`}>
      <Text style={[styles.hudTabText, c.hudTab === id && { color: '#fff3cf' }]}>{label} <Text style={{ color: KG.dim }}>{n}</Text></Text>
    </Pressable>
  );
  return (
    <View style={[kgStyles.panel, styles.hud, style]} testID="kg-hud">
      <View style={styles.hudHead}>
        <View style={[styles.beacon, st.high && { backgroundColor: KG.danger }]} />
        <Text style={kgStyles.panelTitle}>Signals</Text>
        <Text style={styles.fps}>{fps ? `${fps} fps` : ''}</Text>
        <Pressable onPress={() => c.toggleHud()} hitSlop={8} accessibilityLabel="Collapse" testID="kg-hud-close">
          <Ionicons name="chevron-down" size={18} color={KG.dim} />
        </Pressable>
      </View>
      <View style={styles.hudStats}>
        {[
          [st.active, 'active', HEALTH_COLOR.active],
          [st.blocked, 'blocked', HEALTH_COLOR.blocked],
          [st.atRisk, 'at risk', HEALTH_COLOR.at_risk],
          [st.stale, 'stale', KG.fg],
          [st.live, 'live', st.live ? KG.ok : KG.fg],
        ].map(([n, l, col]) => (
          <View key={l} style={styles.hudStat}>
            <Text style={[styles.hudStatN, { color: col }]}>{n}</Text>
            <Text style={styles.hudStatL}>{l}</Text>
          </View>
        ))}
      </View>
      <View style={styles.hudTabs}>
        <Tab id="signals" label="Signals" n={c.hudInsights.length} />
        <Tab id="activity" label="Activity" n={c.activity.length} />
        {c.groupMode !== 'orbit' ? <Tab id="groups" label="Groups" n={groups.length} /> : null}
      </View>
      <ScrollView style={styles.hudBody} contentContainerStyle={{ gap: 6, paddingBottom: 4 }} nestedScrollEnabled>
        {c.hudTab === 'signals' ? (
          c.hudInsights.length ? (
            c.hudInsights.slice(0, 30).map((ins) => <InsightCard key={ins.id} c={c} ins={ins} />)
          ) : (
            <Text style={kgStyles.muted}>{c.snapshot ? 'All clear — nothing needs attention.' : 'Scanning…'}</Text>
          )
        ) : c.hudTab === 'activity' ? (
          c.activity.length ? (
            c.activity.map((a) => (
              <Pressable key={a.id} onPress={() => c.nodeById.has(a.nodeId) && (c.selectNode(a.nodeId), c.emit())} style={styles.act}>
                <View style={[styles.actDot, { backgroundColor: a.tone === 'new' ? KG.ok : a.tone === 'live' ? KG.cyan : a.tone === 'warn' ? KG.warn : KG.gold }]} />
                <Text style={styles.actText} numberOfLines={2}>{a.text}</Text>
                <Text style={styles.actTime}>{relativeAge(a.at)}</Text>
              </Pressable>
            ))
          ) : (
            <Text style={kgStyles.muted}>Changes since you opened the graph show up here — new items, status flips, agents starting, and your own edits.</Text>
          )
        ) : groups.length ? (
          groups.slice(0, 40).map((g) => (
            <View key={g.key} style={styles.grp}>
              <View style={[styles.dot, { backgroundColor: g.color }]} />
              <Pressable style={{ flex: 1 }} onPress={() => { c.setSelection(g.memberIds); c.emit(); }}>
                <Text style={styles.grpName} numberOfLines={1}>{g.label}</Text>
              </Pressable>
              <Text style={kgStyles.chipCount}>{g.memberIds.length}</Text>
              <Pressable onPress={() => c.openAi('summarize', g.memberIds.slice(0, 40))} hitSlop={6} style={styles.mini}>
                <Ionicons name="chatbubble-outline" size={14} color={KG.goldSoft} />
              </Pressable>
              <Pressable onPress={() => c.fitTo(g.memberIds, 1.4)} hitSlop={6} style={styles.mini}>
                <Ionicons name="locate-outline" size={14} color={KG.goldSoft} />
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={kgStyles.muted}>No groups under this mode.</Text>
        )}
      </ScrollView>
    </View>
  );
}

// ── Mode hint, toast, banners ───────────────────────────────

export function KgModeHint({ c, style }) {
  if (!c.linkMode && !c.selectMode) return null;
  const from = c.linkTapFrom ? c.nodeById.get(c.linkTapFrom) : null;
  const text = c.linkMode
    ? from
      ? `Linking ${core.truncate(from.label, 22)} · tap the target`
      : 'Link mode · tap a node, then its target (or drag one onto another)'
    : 'Select mode · drag a lasso around nodes';
  return (
    <View style={[styles.modeHint, style]} testID="kg-mode-hint">
      <Ionicons name={c.linkMode ? 'link-outline' : 'scan-outline'} size={15} color={KG.goldSoft} />
      <Text style={styles.modeHintText} numberOfLines={2}>{text}</Text>
      <Pressable onPress={() => c.setModes(false, false)} hitSlop={8}>
        <Text style={styles.link}>Done</Text>
      </Pressable>
    </View>
  );
}

export function KgToast({ c, style }) {
  const t = c.toast;
  if (!t) return null;
  const col = t.tone === 'err' ? KG.danger : t.tone === 'warn' ? KG.warn : KG.ok;
  return (
    <View style={[styles.toast, { borderColor: rgba(col, 0.5) }, style]} testID="kg-toast" accessibilityLiveRegion="polite">
      <Ionicons name={t.tone === 'err' ? 'alert-circle-outline' : t.tone === 'warn' ? 'warning-outline' : 'checkmark-circle-outline'} size={17} color={col} />
      <Text style={styles.toastText} numberOfLines={3}>{t.text}</Text>
      {t.undo && c.canUndo ? (
        <Pressable onPress={() => void c.undoLast()} style={styles.undo} testID="kg-undo">
          <Text style={styles.undoText}>Undo</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function KgBanner({ text, err, loading, style }) {
  return (
    <View style={[styles.banner, err && styles.bannerErr, style]}>
      {loading ? <ActivityIndicator size="small" color={KG.gold} /> : null}
      <Text style={[styles.bannerText, err && { color: '#fca5a5' }]}>{text}</Text>
    </View>
  );
}

const styles = kgSheet({
  toolbar: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 6, gap: 6, backgroundColor: 'rgba(212,175,55,0.05)', borderBottomWidth: 1, borderBottomColor: KG.borderSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 10, fontWeight: '700', letterSpacing: 3.2, color: KG.goldText, flexShrink: 0 },
  count: { fontSize: 13, fontWeight: '700', color: mixHex(KG.gold, '#ffffff', 0.8), minWidth: 16, flexShrink: 0 },
  search: { flex: 1, minWidth: 110, minHeight: 36, fontSize: 13 },
  tools: { gap: 6, alignItems: 'center', paddingRight: 8 },
  seg: { flexDirection: 'row', gap: 4 },
  conn: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: KG.btnBorder, borderRadius: 9, height: 38, paddingRight: 3, backgroundColor: 'rgba(0,0,0,0.35)' },
  connB: { paddingHorizontal: 9, height: 30, borderRadius: 7, justifyContent: 'center' },
  connOn: { backgroundColor: rgba(KG.gold, 0.24) },
  connText: { color: KG.dim, fontSize: 12, fontWeight: '600' },
  modeBtn: { paddingHorizontal: 12, minWidth: 44, justifyContent: 'center' },
  modeText: { color: KG.fg, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
  badge: { backgroundColor: rgba(KG.gold, 0.3), borderRadius: 999, paddingHorizontal: 6, minWidth: 18, alignItems: 'center' },
  badgeHot: { backgroundColor: 'rgba(240,82,95,0.5)' },
  badgeText: { color: '#fff3cf', fontSize: 10.5, fontWeight: '700' },
  // .kg-legend: one wrapping flow, gap 5 (groups keep together, 10 px apart).
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', rowGap: 5, columnGap: 12, paddingHorizontal: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: rgba(KG.gold, 0.12), backgroundColor: 'rgba(212,175,55,0.02)' },
  legendClosed: { flexWrap: 'nowrap', columnGap: 6, minHeight: 36 },
  legendGroup: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: '100%' },
  legendLabel: { fontSize: 9, letterSpacing: 2, color: mixHex(KG.gold, '#888888', 0.7), marginLeft: 2, marginRight: 1 },
  legendToggle: { width: 28, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: rgba(KG.gold, 0.22) },
  sep: { width: 1, height: 16, marginHorizontal: 4, backgroundColor: rgba(KG.gold, 0.22) },
  // .kg-chip: pill, 1px gold 18 % border, padding 3 8, 0.7rem; .on gold 5 %, .off 38 %.
  lchip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 24, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: rgba(KG.gold, 0.18) },
  lchipOn: { backgroundColor: rgba(KG.gold, 0.05) },
  lchipOff: { opacity: 0.38 },
  lchipText: { color: KG.fg, fontSize: 10.5 },
  lchipCount: { color: KG.dim, fontSize: 10, marginLeft: 1, fontVariant: ['tabular-nums'] },
  ring: { width: 9, height: 9, borderRadius: 5, shadowOpacity: 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hex: { borderRadius: 1, transform: [{ rotate: '45deg' }], width: 7, height: 7 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: 6 },
  sizeDots: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sd: { borderRadius: 5, backgroundColor: rgba(KG.gold, 0.8) },
  noteText: { color: '#efe6cf', fontSize: 10 },
  lkText: { color: KG.dim, fontSize: 9.5 },
  lk: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: 6 },
  shapes: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, columnGap: 9, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 10, backgroundColor: 'rgba(7,6,12,0.78)', borderWidth: 1, borderColor: rgba(KG.gold, 0.26) },
  shapeItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  shapeText: { color: 'rgba(228,228,231,0.75)', fontSize: 9.5 },
  hudPill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 999, backgroundColor: 'rgba(8,6,15,0.86)', borderWidth: 1, borderColor: rgba(KG.gold, 0.35) },
  hudPillHot: { borderColor: 'rgba(240,82,95,0.6)' },
  hudPillN: { color: '#fff3cf', fontWeight: '800', fontSize: 13 },
  hudPillT: { color: KG.dim, fontSize: 12 },
  hud: { padding: 10, maxHeight: '100%', flexShrink: 1 },
  hudHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexShrink: 0 },
  beacon: { width: 7, height: 7, borderRadius: 4, backgroundColor: KG.ok },
  fps: { marginLeft: 'auto', color: KG.dimmer, fontSize: 10.5, fontVariant: ['tabular-nums'] },
  hudStats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8, flexShrink: 0 },
  hudStat: { alignItems: 'center', flex: 1 },
  hudStatN: { fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hudStatL: { fontSize: 9.5, color: KG.dim, letterSpacing: 0.5 },
  hudTabs: { flexDirection: 'row', gap: 4, marginBottom: 6, flexShrink: 0 },
  hudTab: { flex: 1, height: 30, borderRadius: 7, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: KG.borderSoft },
  hudTabOn: { backgroundColor: rgba(KG.gold, 0.16), borderColor: rgba(KG.gold, 0.45) },
  hudTabText: { fontSize: 12, color: KG.fg, fontWeight: '600' },
  hudBody: { flexGrow: 0, flexShrink: 1 },
  insight: { borderRadius: 9, borderWidth: 1, borderColor: rgba(KG.gold, 0.12), backgroundColor: 'rgba(255,255,255,0.02)', padding: 8, gap: 6 },
  insightTitle: { fontWeight: '700', fontSize: 12.5, color: '#ececef' },
  insightDetail: { color: '#9a9aa3', fontSize: 11.5, lineHeight: 15, marginTop: 2 },
  insightActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ia: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, height: 28, borderRadius: 7, backgroundColor: 'rgba(212,175,55,0.07)' },
  iaText: { color: KG.goldSoft, fontSize: 11.5, fontWeight: '600' },
  act: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  actDot: { width: 6, height: 6, borderRadius: 3 },
  actText: { flex: 1, color: KG.fg, fontSize: 12 },
  actTime: { color: KG.dimmer, fontSize: 10.5 },
  grp: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  grpName: { color: KG.fg, fontSize: 12.5 },
  mini: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: 'rgba(212,175,55,0.07)' },
  modeHint: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(8,6,15,0.9)', borderWidth: 1, borderColor: rgba(KG.gold, 0.4) },
  modeHintText: { color: KG.fg, fontSize: 12, flexShrink: 1 },
  link: { color: KG.goldSoft, fontWeight: '700', fontSize: 12.5 },
  toast: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, backgroundColor: 'rgba(8,6,15,0.96)' },
  toastText: { flex: 1, color: KG.fg, fontSize: 12.5 },
  undo: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, backgroundColor: rgba(KG.gold, 0.2) },
  undoText: { color: '#fff3cf', fontWeight: '700', fontSize: 12.5 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(8,6,15,0.9)', borderWidth: 1, borderColor: rgba(KG.gold, 0.25) },
  bannerErr: { borderColor: 'rgba(239,68,68,0.4)' },
  bannerText: { color: KG.fg, fontSize: 12.5 },
});
