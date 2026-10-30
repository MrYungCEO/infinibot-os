/**
 * Business Command Center — HUD-style overview
 * Mirrors the web business dashboard: greeting, system status, KPIs,
 * jump tiles, priorities, mini task board, and activity feed.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
  RefreshControl,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIncome } from '../hooks/useIncome';
import { useKanban } from '../hooks/useKanban';
import { useActiveProjects } from '../hooks/useActiveProjects';
import { COLORS } from '../constants/theme';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';

const { width } = Dimensions.get('window');
const DOCK_BOTTOM_SPACE = 90;

// Single source of truth: the imported COLORS proxy is the live theme.
// The local primary alias below keeps a `primaryGlow` token (legacy name from
// the previous static palette) wired to the active theme's tinted primary.
// Every other color reference resolves through the proxy directly.
const SURFACE_GLASS = 'rgba(14,14,20,0.78)';
const SURFACE_GLASS_DEEP = 'rgba(10,10,16,0.86)';
const BORDER_SUBTLE = 'rgba(255,255,255,0.04)';

// ============================================================
// Constants
// ============================================================
const REVENUE_HIDE_KEY = 'business.hideRevenue';
const PRIORITIES_KEY = (bizId) => `business.priorities.${bizId || 'default'}`;
const MAX_PRIORITIES = 5;

const ACTIVE_PROJECT_STATUSES = new Set(['In progress', 'Updating', 'Reviewing', 'Awaiting Client', 'in_progress', 'review']);
const ACTIVE_TASK_STATUSES = new Set(['todo', 'in_progress', 'review', 'backlog', 'Not started', 'In progress']);

// ============================================================
// Helpers
// ============================================================
const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount || 0);

const maskMoney = (amount, hide) => (hide ? '••••' : formatCurrency(amount));

const fmtCompact = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
};

const STATUS_ORDER = { backlog: 0, todo: 1, 'Not started': 1, in_progress: 2, 'In progress': 2, review: 3, done: 10, Done: 10 };
const STATUS_LABEL = { backlog: 'Backlog', todo: 'To Do', 'Not started': 'To Do', in_progress: 'In Progress', 'In progress': 'In Progress', review: 'Review', done: 'Done', Done: 'Done' };
const STATUS_COLOR = { backlog: COLORS.textMuted, todo: COLORS.info, 'Not started': COLORS.info, in_progress: COLORS.accent, 'In progress': COLORS.accent, review: COLORS.purple, done: COLORS.success, Done: COLORS.success };

// ============================================================
// Business Switcher
// ============================================================
function BusinessSwitcher({ businesses, activeId, onSelect, onAdd }) {
  if (!businesses.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.switcherRow}>
      {businesses.map((biz) => {
        const active = biz.id === activeId;
        return (
          <TouchableOpacity
            key={biz.id}
            style={[styles.switcherTab, active && styles.switcherTabActive]}
            onPress={() => onSelect(biz.id)}
            activeOpacity={0.7}
          >
            {active && <View style={styles.switcherAccent} />}
            <Text style={[styles.switcherLabel, active && styles.switcherLabelActive]} numberOfLines={1}>
              {biz.name || 'Untitled'}
            </Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity style={styles.switcherAdd} onPress={onAdd} activeOpacity={0.7}>
        <Ionicons name="add" size={16} color={COLORS.primary} />
      </TouchableOpacity>
    </ScrollView>
  );
}

// ============================================================
// Greeting Header
// ============================================================
function GreetingHeader({ business, onSync, hideRevenue, onToggleRevenue, onSettings }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const timeStr = time.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  return (
    <View style={styles.greeting}>
      {/* Glass layer (blur + theme-tinted gradient → reveals AmbientBackground) */}
      <BlurView intensity={Platform.OS === 'android' ? 45 : 60} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[
          withAlpha(COLORS.primary, 0.22),
          withAlpha(COLORS.primary, 0.06),
          'rgba(0,0,0,0.4)',
        ]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* Inner top highlight — perceived "lift" */}
      <LinearGradient
        colors={innerTopHighlight}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 0.55 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* Hairline primary border */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: 24, borderWidth: 1, borderColor: withAlpha(COLORS.primary, 0.18) },
        ]}
        pointerEvents="none"
      />
      {/* Primary-tinted glow orb that bleeds out top-right */}
      <View style={[styles.greetingGlow, { backgroundColor: COLORS.primaryStrong }]} pointerEvents="none" />
      {/* Top hairline of primary */}
      <LinearGradient
        colors={['transparent', COLORS.primaryStrong, 'transparent']}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={styles.greetingTopHairline}
      />

      <View style={styles.greetingInner}>
        <View style={styles.greetingTop}>
          <View style={styles.greetingLeft}>
            {/* Logo with halo */}
            <View style={styles.greetingLogoWrap}>
              <View style={[styles.greetingLogoHalo, { backgroundColor: COLORS.primaryStrong }]} />
              <LinearGradient
                colors={[COLORS.primary, COLORS.primaryDark]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.greetingLogo}
              >
                <Text style={styles.greetingLogoText}>∞</Text>
              </LinearGradient>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.greetingEyebrow}>COMMAND CENTER · {timeStr}</Text>
              <Text style={styles.greetingTitle} numberOfLines={1}>
                {business?.name ?? 'No business selected'}
              </Text>
              {business?.industry ? (
                <View style={styles.greetingTag}>
                  <View style={[styles.greetingTagDot, { backgroundColor: COLORS.primary }]} />
                  <Text style={styles.greetingTagText}>{business.industry}</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* Action row */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionRow}>
          <TouchableOpacity style={styles.actionBtn} onPress={onSync} activeOpacity={0.7}>
            <Ionicons name="refresh" size={14} color={COLORS.primary} />
            <Text style={styles.actionBtnText}>Sync</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={onToggleRevenue} activeOpacity={0.7}>
            <Ionicons name={hideRevenue ? 'eye-outline' : 'eye-off-outline'} size={14} color={COLORS.primary} />
            <Text style={styles.actionBtnText}>{hideRevenue ? 'Show $' : 'Hide $'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtn} onPress={onSettings} activeOpacity={0.7}>
            <Ionicons name="settings-outline" size={14} color={COLORS.primary} />
            <Text style={styles.actionBtnText}>Settings</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </View>
  );
}

// ============================================================
// System Status Rail
// ============================================================
function SystemStatusRail({ gatewayConnected, businesses, activeBusinessId, incomeStreams }) {
  const pills = [
    {
      key: 'gateway',
      label: 'Gateway',
      value: gatewayConnected ? 'online' : 'offline',
      state: gatewayConnected ? 'ok' : 'off',
    },
    {
      key: 'businesses',
      label: 'Businesses',
      value: businesses.length === 0 ? 'none' : `${businesses.length} active`,
      state: businesses.length > 0 ? 'ok' : 'off',
    },
    {
      key: 'income',
      label: 'Income',
      value: incomeStreams > 0 ? `${incomeStreams} source${incomeStreams !== 1 ? 's' : ''}` : 'no sources',
      state: incomeStreams > 0 ? 'ok' : 'warn',
    },
    {
      key: 'active',
      label: 'Active biz',
      value: activeBusinessId ? 'selected' : 'none',
      state: activeBusinessId ? 'ok' : 'warn',
    },
  ];

  const dotColor = { ok: COLORS.success, warn: COLORS.accent, off: COLORS.textMuted };
  const dotGlow  = { ok: COLORS.success, warn: COLORS.accent, off: 'transparent' };

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.statusRail}>
      {pills.map((p) => (
        <View key={p.key} style={styles.statusPill}>
          <View style={[styles.statusDot, { backgroundColor: dotColor[p.state], shadowColor: dotGlow[p.state] }]} />
          <View>
            <Text style={styles.statusPillLabel}>{p.label}</Text>
            <Text style={styles.statusPillValue}>{p.value}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ============================================================
// KPI Strip
// ============================================================
function KPIStrip({ projects, tasks, incomeStats, hideRevenue }) {
  const activeProjects = projects.filter((p) => ACTIVE_PROJECT_STATUSES.has(p.status || p.notionStatus)).length;
  const activeTasks = tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status)).length;

  const kpis = [
    { label: 'Active Projects', value: fmtCompact(activeProjects), icon: 'briefcase-outline', color: COLORS.info },
    { label: 'Active Tasks', value: fmtCompact(activeTasks), icon: 'checkbox-outline', color: COLORS.accent },
    { label: 'This Month', value: maskMoney(incomeStats?.month, hideRevenue), icon: 'trending-up', color: COLORS.success },
    { label: 'All Time', value: maskMoney(incomeStats?.allTime, hideRevenue), icon: 'wallet-outline', color: COLORS.purple },
  ];

  return (
    <View style={styles.kpiStrip}>
      <BlurView intensity={Platform.OS === 'android' ? 35 : 50} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[
          withAlpha(COLORS.primary, 0.12),
          withAlpha(COLORS.primary, 0.02),
          'rgba(0,0,0,0.35)',
        ]}
        start={{ x: 0, y: 0 }} end={{ x: 0, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { borderRadius: 20, borderWidth: 1, borderColor: withAlpha(COLORS.primary, 0.18) }]} pointerEvents="none" />
      <View style={styles.kpiRow}>
        {kpis.map((k, i) => (
          <View key={k.label} style={[styles.kpiCard, i < kpis.length - 1 && styles.kpiCardBorder]}>
            {/* Top accent bar */}
            <View style={[styles.kpiAccent, { backgroundColor: k.color }]} />
            <View style={[styles.kpiIcon, { backgroundColor: k.color + '20', borderColor: k.color + '32' }]}>
              <Ionicons name={k.icon} size={15} color={k.color} />
            </View>
            <Text style={styles.kpiValue}>{k.value}</Text>
            <Text style={styles.kpiLabel} numberOfLines={2}>{k.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// Jump Tiles
// ============================================================
// Jump tiles — accents resolve through the live theme so every chip re-paints
// when the master switches palette. We keep distinct hue *roles* (purple,
// cyan, success…) but the proxy rotates them around the active primary.
const JUMP_TILES = [
  { id: 'clients',   label: 'Clients',   desc: 'CRM & contacts',        icon: 'people-outline',    accentKey: 'purple',  screen: 'Clients',         tab: null },
  { id: 'overview',  label: 'Overview',  desc: 'Profile & KPIs',        icon: 'analytics-outline', accentKey: 'success', screen: 'BusinessProfile', tab: null },
  { id: 'leads',     label: 'Funnels',   desc: 'Leads & campaigns',     icon: 'magnet-outline',    accentKey: 'cyan',    screen: 'Leads',           tab: null },
  { id: 'tasks',     label: 'Tasks',     desc: 'Kanban board',          icon: 'checkbox-outline',  accentKey: 'warning', screen: null,              tab: 'Board' },
  { id: 'income',    label: 'Income',    desc: 'Revenue streams',       icon: 'cash-outline',      accentKey: 'primary', screen: 'IncomeStreams',   tab: null },
  { id: 'budget',    label: 'Spend',     desc: 'Credits & usage',       icon: 'pie-chart-outline', accentKey: 'accent',  screen: null,              modal: 'CreditsModal' },
  { id: 'settings',  label: 'Settings',  desc: 'Business config',       icon: 'settings-outline',  accentKey: 'textMuted', screen: null,            modal: 'SettingsModal' },
  // KIS Phase 1 command centers (§15-§21). They live in the Business stack, so
  // they route through `nested` rather than `screen` — this hub is registered in
  // two stacks and only one of them owns those routes.
  { id: 'execcc',    label: 'Executive', desc: 'What needs you',        icon: 'ribbon-outline',      accentKey: 'primary', screen: null, tab: 'Business', nested: 'ExecutiveCommandCenter' },
  { id: 'opscc',     label: 'Operations',desc: 'Run the organization',  icon: 'speedometer-outline', accentKey: 'cyan',    screen: null, tab: 'Business', nested: 'OperationsCommandCenter' },
  { id: 'opsagents', label: 'Ops Agents',desc: 'Briefing & exceptions', icon: 'eye-outline',         accentKey: 'success', screen: null, tab: 'Business', nested: 'OpsAgents' },
];

function JumpTileGrid({ onNavigateStack, onNavigateTab, onNavigateModal, onNavigateNested, projects, tasks, clients }) {
  const projectCount = projects?.length;
  const taskCount = tasks?.filter((t) => ACTIVE_TASK_STATUSES.has(t.status)).length;
  const clientCount = clients?.length;

  const counts = { clients: clientCount, tasks: taskCount, leads: null, overview: projectCount };

  return (
    <View>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionEyebrow}>NAVIGATE</Text>
        <Text style={styles.sectionTitle}>Quick Access</Text>
      </View>
      <View style={styles.tilesGrid}>
        {JUMP_TILES.map((tile) => {
          const count = counts[tile.id];
          const accent = COLORS[tile.accentKey] || COLORS.primary;
          return (
            <TouchableOpacity
              key={tile.id}
              style={styles.tile}
              onPress={() => {
                if (tile.nested) onNavigateNested(tile.tab, tile.nested);
                else if (tile.tab) onNavigateTab(tile.tab);
                else if (tile.modal) onNavigateModal(tile.modal);
                else onNavigateStack(tile.screen);
              }}
              activeOpacity={0.75}
            >
              {/* Diagonal accent wash */}
              <LinearGradient
                colors={[accent + '22', accent + '08', 'transparent']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.tileAurora}
                pointerEvents="none"
              />
              {/* Left accent bar */}
              <View style={[styles.tileBar, { backgroundColor: accent }]} />
              <View style={[styles.tileIconWrap, { backgroundColor: accent + '22', borderColor: accent + '38' }]}>
                <Ionicons name={tile.icon} size={20} color={accent} />
              </View>
              <Text style={styles.tileLabel}>{tile.label}</Text>
              <Text style={styles.tileDesc} numberOfLines={1}>{tile.desc}</Text>
              {count != null && (
                <Text style={[styles.tileCount, { color: accent }]}>{fmtCompact(count)}</Text>
              )}
              <View style={[styles.tileArrow, { backgroundColor: accent + '20', borderColor: accent + '38' }]}>
                <Ionicons name="arrow-forward" size={12} color={accent} />
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ============================================================
// Top Priorities
// ============================================================
function TopPriorities({ projects, priorities, setPriorities, businessId, onNavigateTab }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const savePriorities = useCallback(async (newList) => {
    setPriorities(newList);
    await AsyncStorage.setItem(PRIORITIES_KEY(businessId), JSON.stringify(newList));
  }, [setPriorities, businessId]);

  const addPriority = useCallback(async (projectId) => {
    if (priorities.length >= MAX_PRIORITIES) return;
    const next = [...priorities, projectId];
    await savePriorities(next);
    setPickerOpen(false);
  }, [priorities, savePriorities]);

  const removePriority = useCallback(async (projectId) => {
    await savePriorities(priorities.filter((id) => id !== projectId));
  }, [priorities, savePriorities]);

  const pinned = priorities
    .map((id) => projects.find((p) => p.id === id))
    .filter(Boolean);

  const candidates = projects.filter((p) => !priorities.includes(p.id));

  return (
    <View>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionEyebrow}>Focus</Text>
          <Text style={styles.sectionTitle}>Top Priorities</Text>
        </View>
        <TouchableOpacity
          style={[styles.addPriorityBtn, priorities.length >= MAX_PRIORITIES && styles.addPriorityBtnDisabled]}
          onPress={() => setPickerOpen(true)}
          disabled={priorities.length >= MAX_PRIORITIES || candidates.length === 0}
          activeOpacity={0.7}
        >
          <Ionicons name="add" size={14} color={priorities.length >= MAX_PRIORITIES ? COLORS.textMuted : COLORS.primary} />
          <Text style={[styles.addPriorityText, priorities.length >= MAX_PRIORITIES && { color: COLORS.textMuted }]}>
            Add
          </Text>
        </TouchableOpacity>
      </View>

      {pinned.length === 0 ? (
        <View style={styles.priorityEmpty}>
          <Text style={styles.priorityEmptyText}>
            {projects.length === 0
              ? 'Create projects in the Kanban board first.'
              : 'Tap "Add" to pin up to 5 focus projects.'}
          </Text>
        </View>
      ) : (
        <View style={styles.priorityList}>
          {pinned.map((proj, idx) => {
            const statusColor = STATUS_COLOR[proj.status || proj.notionStatus] || COLORS.textMuted;
            return (
              <TouchableOpacity
                key={proj.id}
                style={styles.priorityCard}
                onPress={() => onNavigateTab('Board')}
                activeOpacity={0.75}
              >
                <Text style={styles.priorityRank}>{idx + 1}</Text>
                <View style={styles.priorityBody}>
                  <Text style={styles.priorityName} numberOfLines={1}>{proj.name}</Text>
                  <Text style={styles.priorityDetail}>Project</Text>
                </View>
                {proj.status || proj.notionStatus ? (
                  <View style={[styles.priorityStatus, { borderColor: statusColor + '40' }]}>
                    <Text style={[styles.priorityStatusText, { color: statusColor }]}>
                      {STATUS_LABEL[proj.status] || STATUS_LABEL[proj.notionStatus] || proj.status || proj.notionStatus}
                    </Text>
                  </View>
                ) : null}
                <TouchableOpacity onPress={() => removePriority(proj.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close" size={14} color={COLORS.textMuted} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Picker */}
      <Modal visible={pickerOpen} transparent animationType="fade">
        <TouchableOpacity style={styles.pickerOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.pickerModal}>
            <Text style={styles.pickerTitle}>Pin a Priority</Text>
            <ScrollView style={styles.pickerScroll}>
              {candidates.length === 0 ? (
                <Text style={styles.priorityEmptyText}>All projects are already pinned.</Text>
              ) : (
                candidates.map((p) => (
                  <TouchableOpacity key={p.id} style={styles.pickerItem} onPress={() => addPriority(p.id)} activeOpacity={0.7}>
                    <Text style={styles.pickerItemName} numberOfLines={1}>{p.name}</Text>
                    {(p.status || p.notionStatus) && (
                      <Text style={styles.pickerItemStatus}>{p.status || p.notionStatus}</Text>
                    )}
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

// ============================================================
// Active Projects Section
// ============================================================
function ActiveProjectsSection({ projects, activeBusinessId, navigation, gateway }) {
  const activeProjects = projects.filter((p) => {
    if (!p.active) return false;
    if (activeBusinessId && p.businessId && p.businessId !== activeBusinessId) return false;
    return true;
  });

  if (activeProjects.length === 0) {
    return (
      <View style={styles.actSection}>
        <View style={styles.sectionHeader}>
          <View>
            <Text style={styles.sectionEyebrow}>Running</Text>
            <Text style={styles.sectionTitle}>Active Projects</Text>
          </View>
        </View>
        <View style={styles.actEmpty}>
          <Text style={styles.actEmptyText}>
            Tick "Active Client Project" on any project in the Kanban to surface it here.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.actSection}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.sectionEyebrow}>Running</Text>
          <Text style={styles.sectionTitle}>Active Projects</Text>
        </View>
        <View style={styles.actCountBadge}>
          <Text style={styles.actCountText}>{activeProjects.length}</Text>
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actCards}>
        {activeProjects.map((p) => {
          const statusColor = STATUS_COLOR[p.status] || COLORS.textMuted;
          return (
            <TouchableOpacity
              key={p.id}
              style={styles.actCard}
              onPress={() => navigation?.getParent()?.navigate('Board')}
              activeOpacity={0.75}
            >
              <View style={styles.actCardHead}>
                <View style={styles.actPulse} />
                <Text style={styles.actCardName} numberOfLines={1}>{p.name || 'Untitled'}</Text>
              </View>
              {p.status ? (
                <View style={[styles.actStatusPill, { borderColor: statusColor + '50' }]}>
                  <Text style={[styles.actStatusText, { color: statusColor }]}>{p.status}</Text>
                </View>
              ) : null}
              <View style={styles.actKpiRow}>
                {p.paidAmount != null ? (
                  <View style={styles.actKpiItem}>
                    <Text style={styles.actKpiLabel}>Paid</Text>
                    <Text style={[styles.actKpiValue, { color: COLORS.primary }]}>
                      {p.paidAmount >= 1000 ? `$${(p.paidAmount / 1000).toFixed(1)}k` : `$${Math.round(p.paidAmount)}`}
                    </Text>
                  </View>
                ) : null}
                {p.pendingPay != null ? (
                  <View style={styles.actKpiItem}>
                    <Text style={styles.actKpiLabel}>Pending</Text>
                    <Text style={styles.actKpiValue}>
                      {p.pendingPay >= 1000 ? `$${(p.pendingPay / 1000).toFixed(1)}k` : `$${Math.round(p.pendingPay)}`}
                    </Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ============================================================
// Mini Task Board
// ============================================================
function MiniTaskBoard({ tasks, projects }) {
  if (!tasks.length) return null;

  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'Done');

  // Group by status
  const columns = {};
  for (const t of openTasks) {
    const key = t.status || 'todo';
    if (!columns[key]) columns[key] = [];
    columns[key].push(t);
  }

  // Sort column keys
  const sortedKeys = Object.keys(columns).sort(
    (a, b) => (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99),
  ).slice(0, 4); // max 4 columns

  if (!sortedKeys.length) return null;

  const projectMap = {};
  for (const p of projects) projectMap[p.id] = p;

  return (
    <View>
      <Text style={styles.sectionTitle}>Task Pipeline</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boardScroll}>
        {sortedKeys.map((key) => {
          const col = columns[key].slice(0, 5);
          const color = STATUS_COLOR[key] || COLORS.textMuted;
          return (
            <View key={key} style={styles.boardColumn}>
              <View style={styles.boardColumnHeader}>
                <View style={[styles.boardColDot, { backgroundColor: color }]} />
                <Text style={[styles.boardColLabel, { color }]}>
                  {STATUS_LABEL[key] || key}
                </Text>
                <Text style={styles.boardColCount}>{columns[key].length}</Text>
              </View>
              {col.map((t) => {
                const proj = projectMap[t.projectId];
                return (
                  <View key={t.id} style={styles.boardCard}>
                    <Text style={styles.boardCardTitle} numberOfLines={2}>{t.title}</Text>
                    {proj && (
                      <Text style={styles.boardCardProject} numberOfLines={1}>{proj.name}</Text>
                    )}
                  </View>
                );
              })}
              {columns[key].length > 5 && (
                <Text style={styles.boardMoreText}>+{columns[key].length - 5} more</Text>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

// ============================================================
// Activity Feed
// ============================================================
function buildActivityFeed(recentTransactions, tasks, projects) {
  const events = [];

  for (const tx of (recentTransactions || []).slice(0, 6)) {
    events.push({
      key: `tx-${tx.id || Math.random()}`,
      icon: 'cash-outline',
      color: COLORS.success,
      title: tx.description || `${tx.source || 'Income'} payment`,
      detail: formatCurrency(tx.amount),
      time: tx.date ? new Date(tx.date) : null,
    });
  }

  const sortedTasks = [...(tasks || [])]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 6);

  for (const t of sortedTasks) {
    const isDone = t.status === 'done' || t.status === 'Done';
    events.push({
      key: `task-${t.id}`,
      icon: isDone ? 'checkmark-circle-outline' : 'ellipse-outline',
      color: isDone ? COLORS.success : COLORS.textMuted,
      title: t.title || 'Untitled task',
      detail: STATUS_LABEL[t.status] || t.status || '',
      time: t.updatedAt ? new Date(t.updatedAt) : null,
    });
  }

  return events.sort((a, b) => (b.time?.getTime() || 0) - (a.time?.getTime() || 0)).slice(0, 12);
}

function fmtTime(date) {
  if (!date) return '';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function ActivityFeed({ recentTransactions, tasks, projects }) {
  const events = buildActivityFeed(recentTransactions, tasks, projects);

  if (!events.length) return null;

  return (
    <View>
      <Text style={styles.sectionTitle}>Recent Activity</Text>
      <View style={styles.activityList}>
        {events.map((e) => (
          <View key={e.key} style={styles.activityItem}>
            <View style={[styles.activityIcon, { backgroundColor: e.color + '18' }]}>
              <Ionicons name={e.icon} size={16} color={e.color} />
            </View>
            <View style={styles.activityContent}>
              <Text style={styles.activityTitle} numberOfLines={1}>{e.title}</Text>
              {e.detail ? <Text style={styles.activityDetail}>{e.detail}</Text> : null}
            </View>
            {e.time && <Text style={styles.activityTime}>{fmtTime(e.time)}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}

// ============================================================
// Log Income Modal
// ============================================================
function LogIncomeModal({ visible, onClose, onSubmit }) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('other');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ amount: parseFloat(amount), description, source });
      setAmount('');
      setDescription('');
      setSource('other');
      onClose();
    } catch (err) {
      Alert.alert('Error', err.message || 'Failed to log income');
    } finally {
      setSubmitting(false);
    }
  };

  const sources = ['whop', 'stripe', 'paypal', 'cash', 'crypto', 'other'];

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Log Income</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={24} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>

          <TextInput
            style={styles.modalInput}
            value={amount}
            onChangeText={setAmount}
            placeholder="Amount"
            placeholderTextColor={COLORS.textMuted}
            keyboardType="numeric"
          />

          <TextInput
            style={styles.modalInput}
            value={description}
            onChangeText={setDescription}
            placeholder="Description"
            placeholderTextColor={COLORS.textMuted}
          />

          <View style={styles.sourceOptions}>
            {sources.map((s) => (
              <TouchableOpacity
                key={s}
                style={[styles.sourceOption, source === s && styles.sourceOptionActive]}
                onPress={() => setSource(s)}
              >
                <Text style={[styles.sourceOptionText, source === s && styles.sourceOptionTextActive]}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.modalSubmit} onPress={handleSubmit} disabled={submitting}>
            <LinearGradient colors={[COLORS.primary, COLORS.primaryDark]} style={styles.modalSubmitGradient}>
              {submitting ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={styles.modalSubmitText}>Add Income</Text>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================
// Main Component
// ============================================================
export function BusinessCommandCenter({ navigation, gateway }) {
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [hideRevenue, setHideRevenue] = useState(false);
  const [businesses, setBusinesses] = useState([]);
  const [activeBusinessId, setActiveBusinessId] = useState(null);
  const [priorities, setPriorities] = useState([]);

  const income = useIncome(gateway);
  const { stats, recentTransactions, refresh: refreshIncome, logIncome } = income;

  const kanban = useKanban(gateway?.sendReq);
  const { projects, tasks, loadProjects } = kanban;

  // Revenue hide preference
  useEffect(() => {
    AsyncStorage.getItem(REVENUE_HIDE_KEY).then((v) => setHideRevenue(v === '1'));
  }, []);

  // Load businesses
  const loadBusinesses = useCallback(async () => {
    if (!gateway?.sendReq) return;
    try {
      const res = await gateway.sendReq('business.list', {});
      const bizList = res?.businesses || [];
      setBusinesses(bizList);
      if (bizList.length > 0) {
        const active = bizList.find((b) => b.isActive) || bizList[0];
        setActiveBusinessId((prev) => prev || active.id);
      }
    } catch (_) { /* silent */ }
  }, [gateway]);

  // Load priorities when active business changes
  useEffect(() => {
    AsyncStorage.getItem(PRIORITIES_KEY(activeBusinessId)).then((v) => {
      setPriorities(v ? JSON.parse(v) : []);
    });
  }, [activeBusinessId]);

  // Initial load
  useEffect(() => {
    loadBusinesses();
    loadProjects();
  }, []);

  const activeBusiness = businesses.find((b) => b.id === activeBusinessId) || null;

  const toggleRevenue = useCallback(async () => {
    const next = !hideRevenue;
    setHideRevenue(next);
    await AsyncStorage.setItem(REVENUE_HIDE_KEY, next ? '1' : '0');
  }, [hideRevenue]);

  const handleSelectBusiness = useCallback(async (bizId) => {
    setActiveBusinessId(bizId);
    if (gateway?.sendReq) {
      try { await gateway.sendReq('business.setActive', { id: bizId }); } catch (_) {}
    }
  }, [gateway]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshIncome(), loadProjects(), loadBusinesses()]);
    setRefreshing(false);
  }, [refreshIncome, loadProjects, loadBusinesses]);

  const handleLogIncome = useCallback(async (data) => {
    await logIncome({ ...data, syncToNotion: true });
    await refreshIncome();
  }, [logIncome, refreshIncome]);

  // Navigation helpers
  const navigateToStack = useCallback((screen) => navigation?.navigate(screen), [navigation]);
  const navigateToTab = useCallback((tab) => navigation?.getParent()?.navigate(tab), [navigation]);
  // Route into another tab's stack (the KIS command centers live in Business).
  const navigateToNested = useCallback(
    (tab, screen) => navigation?.getParent()?.navigate(tab, { screen }),
    [navigation],
  );
  const navigateToModal = useCallback((modal) => navigation?.getParent()?.getParent()?.navigate(modal, { gateway }), [navigation, gateway]);

  const incomeStreamCount = income?.incomeStreams?.length ?? 0;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: DOCK_BOTTOM_SPACE + 24 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        {/* Back row — this is a header-less stack screen reached from the
            Dashboard "Command" tile, so it needs an explicit back affordance. */}
        <View style={styles.backRow}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => navigation?.goBack?.()}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={20} color={COLORS.primary} />
            <Text style={styles.backLabel}>Dashboard</Text>
          </TouchableOpacity>
        </View>

        {/* Business Switcher */}
        <BusinessSwitcher
          businesses={businesses}
          activeId={activeBusinessId}
          onSelect={handleSelectBusiness}
          onAdd={() => Alert.alert('New Business', 'Use the web app to create a new business.')}
        />

        {/* Greeting */}
        <GreetingHeader
          business={activeBusiness}
          onSync={onRefresh}
          hideRevenue={hideRevenue}
          onToggleRevenue={toggleRevenue}
          onSettings={() => navigateToModal('SettingsModal')}
        />

        {/* System Status */}
        <SystemStatusRail
          gatewayConnected={gateway?.status === 'connected'}
          businesses={businesses}
          activeBusinessId={activeBusinessId}
          incomeStreams={incomeStreamCount}
        />

        {/* KPI Strip */}
        <KPIStrip
          projects={projects}
          tasks={tasks}
          incomeStats={stats}
          hideRevenue={hideRevenue}
        />

        {/* Jump Tiles */}
        <JumpTileGrid
          onNavigateStack={navigateToStack}
          onNavigateTab={navigateToTab}
          onNavigateModal={navigateToModal}
          onNavigateNested={navigateToNested}
          projects={projects}
          tasks={tasks}
          clients={null}
        />

        {/* Top Priorities */}
        <TopPriorities
          projects={projects}
          priorities={priorities}
          setPriorities={setPriorities}
          businessId={activeBusinessId}
          onNavigateTab={navigateToTab}
        />

        {/* Active Projects */}
        <ActiveProjectsSection
          projects={projects}
          activeBusinessId={activeBusinessId}
          navigation={navigation}
          gateway={gateway}
        />

        {/* Mini Task Board */}
        <MiniTaskBoard tasks={tasks} projects={projects} />

        {/* Activity Feed */}
        <ActivityFeed
          recentTransactions={recentTransactions}
          tasks={tasks}
          projects={projects}
        />
      </ScrollView>

      {/* FAB — Log Income */}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <View style={[styles.fabHalo, { backgroundColor: COLORS.primaryStrong }]} pointerEvents="none" />
        <TouchableOpacity style={styles.fab} onPress={() => setLogModalVisible(true)} activeOpacity={0.85}>
          <LinearGradient
            colors={[COLORS.primary, COLORS.primaryDark]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.fabGradient}
          >
            <Ionicons name="add" size={28} color="#000" />
          </LinearGradient>
        </TouchableOpacity>
      </View>

      <LogIncomeModal
        visible={logModalVisible}
        onClose={() => setLogModalVisible(false)}
        onSubmit={handleLogIncome}
      />
    </View>
  );
}

// ============================================================
// Styles
// ============================================================
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, gap: 22 },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: -8 },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    minHeight: 44,
    paddingRight: 12,
  },
  backLabel: { color: COLORS.primary, fontSize: 15, fontWeight: '600' },

  // Business Switcher — glass pill row
  switcherRow: { gap: 8, paddingBottom: 4 },
  switcherTab: {
    position: 'relative',
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 22,
    backgroundColor: SURFACE_GLASS,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    maxWidth: 160,
  },
  switcherTabActive: {
    borderColor: COLORS.primaryMuted,
    backgroundColor: COLORS.primaryDim,
  },
  switcherAccent: {
    position: 'absolute',
    left: 0,
    top: 9,
    bottom: 9,
    width: 3,
    borderRadius: 2,
    backgroundColor: COLORS.primary,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
    elevation: 2,
  },
  switcherLabel: { fontSize: 13, color: COLORS.textSecondary, fontWeight: '500', paddingLeft: 6 },
  switcherLabelActive: { color: COLORS.primary, fontWeight: '700', letterSpacing: 0.2 },
  switcherAdd: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Greeting Header — premium glass hero
  greeting: {
    position: 'relative',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.primaryLight,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 14,
  },
  greetingInner: {
    padding: 18,
    gap: 14,
    zIndex: 2,
  },
  greetingGlow: {
    position: 'absolute',
    top: -80,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    opacity: 0.35,
  },
  greetingTopHairline: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 1,
  },
  greetingTop: { flexDirection: 'row', alignItems: 'flex-start' },
  greetingLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  greetingLogoWrap: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  greetingLogoHalo: {
    position: 'absolute',
    width: 70,
    height: 70,
    borderRadius: 35,
    opacity: 0.55,
  },
  greetingLogo: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 8,
  },
  greetingLogoText: { fontSize: 24, fontWeight: '900', color: '#000' },
  greetingEyebrow: {
    fontSize: 10,
    color: COLORS.textMuted,
    letterSpacing: 1.4,
    marginBottom: 4,
    fontWeight: '700',
  },
  greetingTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: -0.3,
    marginBottom: 6,
  },
  greetingTag: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: COLORS.primaryDim,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  greetingTagDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  greetingTagText: { fontSize: 10, color: COLORS.primary, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  actionRow: { gap: 8, paddingRight: 4 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: COLORS.primaryDim,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  actionBtnText: { fontSize: 12, color: COLORS.primary, fontWeight: '700', letterSpacing: 0.3 },

  // System Status Rail
  statusRail: { gap: 8, paddingBottom: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: SURFACE_GLASS,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
  },
  statusDot: {
    width: 8, height: 8, borderRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 3,
  },
  statusPillLabel: { fontSize: 9, color: COLORS.textMuted, letterSpacing: 1.2, fontWeight: '700', textTransform: 'uppercase' },
  statusPillValue: { fontSize: 12, color: COLORS.text, fontWeight: '600', marginTop: 1 },

  // KPI Strip — glass card with per-cell accent bar
  kpiStrip: {
    position: 'relative',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 10,
  },
  kpiRow: { flexDirection: 'row', zIndex: 2 },
  kpiCard: {
    flex: 1,
    paddingTop: 18,
    paddingBottom: 14,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 6,
    position: 'relative',
  },
  kpiCardBorder: { borderRightWidth: 1, borderRightColor: BORDER_SUBTLE },
  kpiAccent: {
    position: 'absolute',
    top: 0,
    left: '20%',
    right: '20%',
    height: 2,
    borderBottomLeftRadius: 2,
    borderBottomRightRadius: 2,
  },
  kpiIcon: {
    width: 30, height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginBottom: 2,
  },
  kpiValue: { fontSize: 18, fontWeight: '800', color: COLORS.text, letterSpacing: -0.4 },
  kpiLabel: { fontSize: 9, color: COLORS.textMuted, textAlign: 'center', lineHeight: 13, letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: '600' },

  // Section headers
  sectionHeaderRow: { flexDirection: 'column', marginBottom: 10, gap: 2 },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 },
  sectionEyebrow: { fontSize: 9, color: COLORS.primary, letterSpacing: 1.6, marginBottom: 2, fontWeight: '700', textTransform: 'uppercase' },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: COLORS.text, letterSpacing: -0.2, marginBottom: 10 },

  // Jump Tiles
  tilesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    width: (width - 42) / 2,
    backgroundColor: SURFACE_GLASS_DEEP,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    padding: 14,
    paddingLeft: 16,
    overflow: 'hidden',
    position: 'relative',
    minHeight: 110,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.32,
    shadowRadius: 10,
    elevation: 6,
  },
  tileAurora: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  tileBar: {
    position: 'absolute',
    left: 0,
    top: 14,
    bottom: 14,
    width: 3,
    borderRadius: 2,
  },
  tileIconWrap: {
    width: 38, height: 38,
    borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
    borderWidth: 1,
  },
  tileLabel: { fontSize: 14, fontWeight: '800', color: COLORS.text, marginBottom: 2, letterSpacing: -0.1 },
  tileDesc: { fontSize: 11, color: COLORS.textMuted, marginBottom: 4 },
  tileCount: { fontSize: 20, fontWeight: '900', marginBottom: 2, letterSpacing: -0.5 },
  tileArrow: {
    position: 'absolute', bottom: 12, right: 12,
    width: 24, height: 24,
    borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },

  // Priorities
  addPriorityBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: COLORS.primaryDim,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
  },
  addPriorityBtnDisabled: { opacity: 0.4 },
  addPriorityText: { fontSize: 12, color: COLORS.primary, fontWeight: '700' },
  priorityEmpty: {
    padding: 22,
    backgroundColor: 'rgba(14,14,20,0.5)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    alignItems: 'center',
    borderStyle: 'dashed',
  },
  priorityEmptyText: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', lineHeight: 19 },
  priorityList: { gap: 8 },
  priorityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: SURFACE_GLASS,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    paddingVertical: 12,
    paddingHorizontal: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  priorityRank: {
    fontSize: 20,
    fontWeight: '900',
    color: COLORS.primary,
    width: 24,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  priorityBody: { flex: 1 },
  priorityName: { fontSize: 14, fontWeight: '700', color: COLORS.text, letterSpacing: -0.1 },
  priorityDetail: { fontSize: 10, color: COLORS.textMuted, marginTop: 2, letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: '600' },
  priorityStatus: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
  },
  priorityStatusText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },

  // Picker modal
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center' },
  pickerModal: {
    width: width - 48,
    maxHeight: 360,
    backgroundColor: COLORS.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 20,
  },
  pickerTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 14 },
  pickerScroll: { maxHeight: 260 },
  pickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderLight,
  },
  pickerItemName: { fontSize: 14, color: COLORS.text, flex: 1 },
  pickerItemStatus: { fontSize: 11, color: COLORS.textMuted, marginLeft: 8 },

  // Active Projects Section — primary-tinted hero stripe
  actSection: {
    marginTop: 4,
    padding: 18,
    borderRadius: 18,
    backgroundColor: COLORS.primaryDim,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 6,
  },
  actCountBadge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 99,
    backgroundColor: COLORS.primaryLight,
    borderWidth: 1,
    borderColor: COLORS.primaryStrong,
  },
  actCountText: { fontSize: 12, fontWeight: '800', color: COLORS.primary, letterSpacing: 0.3 },
  actEmpty: { paddingVertical: 28, alignItems: 'center' },
  actEmptyText: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20 },
  actCards: { gap: 10, paddingVertical: 2 },
  actCard: {
    width: 210,
    padding: 14,
    borderRadius: 16,
    backgroundColor: SURFACE_GLASS_DEEP,
    borderWidth: 1,
    borderColor: COLORS.primaryMuted,
    gap: 9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  actCardHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  actPulse: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: COLORS.primary,
    flexShrink: 0,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 5,
    elevation: 3,
  },
  actCardName: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.text,
  },
  actStatusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  actStatusText: { fontSize: 10, fontWeight: '600' },
  actKpiRow: { flexDirection: 'row', gap: 12 },
  actKpiItem: { gap: 2 },
  actKpiLabel: { fontSize: 9, letterSpacing: 0.06, textTransform: 'uppercase', color: COLORS.textMuted },
  actKpiValue: { fontSize: 13, fontWeight: '700', color: COLORS.text },

  // Mini Task Board
  boardScroll: { gap: 12, paddingBottom: 4 },
  boardColumn: {
    width: 170,
    backgroundColor: SURFACE_GLASS,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    padding: 12,
  },
  boardColumnHeader: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  boardColDot: { width: 7, height: 7, borderRadius: 4 },
  boardColLabel: { flex: 1, fontSize: 10, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' },
  boardColCount: { fontSize: 10, color: COLORS.textMuted, fontWeight: '700' },
  boardCard: {
    backgroundColor: COLORS.elevated,
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
  },
  boardCardTitle: { fontSize: 12, color: COLORS.text, lineHeight: 16, fontWeight: '500' },
  boardCardProject: { fontSize: 10, color: COLORS.textMuted, marginTop: 4, letterSpacing: 0.3 },
  boardMoreText: { fontSize: 10, color: COLORS.textMuted, textAlign: 'center', marginTop: 6, fontWeight: '600', letterSpacing: 0.4 },

  // Activity Feed
  activityList: { gap: 6 },
  activityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: SURFACE_GLASS,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER_SUBTLE,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  activityIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activityContent: { flex: 1 },
  activityTitle: { fontSize: 13, fontWeight: '700', color: COLORS.text, letterSpacing: -0.05 },
  activityDetail: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
  activityTime: { fontSize: 10, color: COLORS.textMuted, fontWeight: '600', letterSpacing: 0.4 },

  // FAB — primary glow halo
  fabWrap: {
    position: 'absolute',
    bottom: 110,
    right: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabHalo: {
    position: 'absolute',
    width: 86,
    height: 86,
    borderRadius: 43,
    opacity: 0.4,
  },
  fab: {
    borderRadius: 30,
    overflow: 'hidden',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 12,
  },
  fabGradient: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: width - 48, backgroundColor: COLORS.card, borderRadius: 22, padding: 24, borderWidth: 1, borderColor: COLORS.primaryLight },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  modalTitle: { fontSize: 19, fontWeight: '800', color: COLORS.text, letterSpacing: -0.3 },
  modalInput: { backgroundColor: COLORS.elevated, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, color: COLORS.text, marginBottom: 12, borderWidth: 1, borderColor: BORDER_SUBTLE },
  sourceOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  sourceOption: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: COLORS.elevated, borderWidth: 1, borderColor: BORDER_SUBTLE },
  sourceOptionActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  sourceOptionText: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600' },
  sourceOptionTextActive: { color: '#000', fontWeight: '700' },
  modalSubmit: { borderRadius: 16, overflow: 'hidden' },
  modalSubmitGradient: { paddingVertical: 16, alignItems: 'center' },
  modalSubmitText: { fontSize: 16, fontWeight: '800', color: '#000', letterSpacing: 0.3 },
});

export default BusinessCommandCenter;
