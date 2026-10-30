/**
 * CreditsScreen — phone view of the unified credit ledger, at full parity with
 * the desktop web /credits page (ui/src/ui/views/credits.ts).
 *
 * Backed by the gateway `credits.*` namespace (same RPCs the web calls). Every
 * colour comes from the live theme runtime (`useTheme()`), so palette swaps
 * pushed from the master device repaint in place.
 *
 * Layout (top → bottom):
 *   • Header + "today vs yesterday" delta pill
 *   • TOTAL THIS MONTH headline (subscriptions + token usage)
 *   • Plan status — one ring card per configured provider plan (AUTO / detect)
 *   • Period chips → token-usage KPI grid
 *   • 24h usage by agent_backend (brand-coloured stacked bars)
 *   • Token donut (input / output / cache read / cache write)
 *   • Monthly subscriptions
 *   • Top providers / backends / projects / sessions (sessions drill into the
 *     AgentFocusSheet)
 *   • CLI plan pullers status · provider sync · budgets · recent entries
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { useTheme } from '../theme/ThemeProvider';
import { FONT_FAMILY } from '../constants/theme';
import { useCredits } from '../hooks/useCredits';
import { PlanRingCard } from '../components/credits/PlanRingCard';
import { TokenDonut } from '../components/credits/TokenDonut';
import { BackendTimeseries } from '../components/credits/BackendTimeseries';
import { CreditsSkeleton } from '../components/credits/Skeletons';
import { PROVIDER_ORDER } from '../components/credits/backend-brand';
import { AgentFocusSheet } from '../components/AgentFocusSheet';

const PERIODS = ['hour', 'day', 'week', 'month', 'all'];

function compact(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function usd(n) {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0';
}

function relative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return '—';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function StatusDot({ status, colors }) {
  const color = {
    ok: colors.success,
    configured: colors.primary,
    'missing-credentials': colors.textMuted,
    error: colors.error,
    unsupported: colors.textMuted,
  }[status] || colors.textMuted;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, marginRight: 8 }} />;
}

function PeriodChips({ period, onChange, styles, colors }) {
  return (
    <View style={styles.chipsRow}>
      {PERIODS.map((p) => (
        <TouchableOpacity
          key={p}
          onPress={() => onChange(p)}
          style={[styles.chip, period === p && { backgroundColor: colors.primarySoft || colors.primary + '22', borderColor: colors.primary }]}
        >
          <Text style={[styles.chipText, period === p && { color: colors.text }]}>{p}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function DeltaPill({ delta, styles, colors }) {
  if (!delta) return null;
  const { today, yesterday } = delta;
  const diff = today - yesterday;
  const pct = yesterday > 0 ? (diff / yesterday) * 100 : null;
  const up = diff > 0;
  const flat = Math.abs(diff) < 0.0001;
  const tone = flat ? colors.textMuted : up ? (colors.warning || '#ffcf6a') : (colors.success || '#6cd49a');
  const icon = flat ? 'remove' : up ? 'trending-up' : 'trending-down';
  return (
    <View style={[styles.deltaPill, { borderColor: tone + '55' }]}>
      <Ionicons name={icon} size={13} color={tone} />
      <Text style={[styles.deltaText, { color: tone }]}>
        {usd(today)} today
      </Text>
      <Text style={styles.deltaSub}>
        {flat ? 'flat vs yesterday' : `${pct != null ? `${up ? '+' : ''}${pct.toFixed(0)}%` : (up ? '+' : '−') + usd(Math.abs(diff))} vs yest. (${usd(yesterday)})`}
      </Text>
    </View>
  );
}

function KpiCard({ label, value, sub, styles }) {
  return (
    <View style={styles.kpiCard}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={styles.kpiValue}>{value}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

export function CreditsScreen({ navigation, gateway }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const {
    period,
    setPeriod,
    summary,
    usage24h,
    delta,
    recent,
    providers,
    providerPlans,
    budgetStatuses,
    dashboard,
    loading,
    refreshingPlan,
    error,
    lastLoadedAt,
    load,
    syncProvider,
    setPlan,
    setAuto,
    refreshPlan,
  } = useCredits(gateway);

  // Session drilled into via the AgentFocusSheet (built from a credits row).
  const [focusAgent, setFocusAgent] = useState(null);

  const subscriptions = dashboard?.subscriptions ?? [];
  const topSessionsFromDash = dashboard?.topSessions ?? [];
  const sessions = topSessionsFromDash.length > 0 ? topSessionsFromDash : (summary?.bySession ?? []);
  const monthTotal = dashboard?.totalMonthlyCostUsd ?? summary?.totalCostUsd ?? 0;
  const subUsd = dashboard?.totalSubscriptionUsd ?? 0;
  const usageUsd = dashboard?.totalUsageUsd ?? summary?.totalCostUsd ?? 0;

  const sortedPlans = useMemo(() => {
    return [...(providerPlans ?? [])].sort(
      (a, b) => (PROVIDER_ORDER.indexOf(a.provider) + 1 || 99) - (PROVIDER_ORDER.indexOf(b.provider) + 1 || 99),
    );
  }, [providerPlans]);

  const openSession = (sessionKey) => {
    if (!sessionKey) return;
    const short = sessionKey.length > 28 ? '…' + sessionKey.slice(-26) : sessionKey;
    setFocusAgent({
      id: sessionKey,
      sessionKey,
      displayName: short,
      label: short,
      status: 'idle',
    });
  };

  const firstLoad = loading && !lastLoadedAt;

  return (
    <View style={styles.container}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} colors={[colors.primary]} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.headerTitle}>CREDITS · LEDGER</Text>
          <Text style={styles.headerSubtitle}>
            Unified spend across every provider and CLI we spawn.
          </Text>
        </View>

        {firstLoad ? (
          <CreditsSkeleton colors={colors} />
        ) : (
          <>
            <DeltaPill delta={delta} styles={styles} colors={colors} />

            <LinearGradient
              colors={[colors.primarySoft || colors.primary + '20', 'transparent']}
              style={[styles.totalCard, { borderColor: colors.primary + '55' }]}
            >
              <Text style={styles.totalLabel}>TOTAL THIS MONTH</Text>
              <Text style={styles.totalValue}>{usd(monthTotal)}</Text>
              <Text style={styles.totalBreakdown}>
                {usd(subUsd)} subscriptions + {usd(usageUsd)} usage
              </Text>
            </LinearGradient>

            {/* ── Plan status rings ── */}
            <View style={styles.sectionBare}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>PLAN STATUS</Text>
                <Text style={styles.sectionHint}>live from each CLI</Text>
              </View>
              {sortedPlans.length === 0 ? (
                <Text style={styles.emptyText}>No backends tracked yet. Configure a plan on the web /credits page.</Text>
              ) : (
                <View style={styles.planGrid}>
                  {sortedPlans.map((p) => (
                    <PlanRingCard
                      key={p.provider}
                      plan={p}
                      colors={colors}
                      busy={refreshingPlan === p.provider}
                      onSetPlan={setPlan}
                      onSetAuto={setAuto}
                      onRefresh={refreshPlan}
                    />
                  ))}
                </View>
              )}
            </View>

            <PeriodChips period={period} onChange={setPeriod} styles={styles} colors={colors} />

            <View style={styles.kpiGrid}>
              <KpiCard
                label={`Spend (${period})`}
                value={usd(summary?.totalCostUsd ?? 0)}
                sub={`${compact(summary?.totalRequests ?? 0)} requests`}
                styles={styles}
              />
              <KpiCard
                label="Tokens in"
                value={compact(summary?.totalTokensIn ?? 0)}
                sub={`cache read: ${compact(summary?.totalCacheReadTokens ?? 0)}`}
                styles={styles}
              />
              <KpiCard
                label="Tokens out"
                value={compact(summary?.totalTokensOut ?? 0)}
                sub={`cache write: ${compact(summary?.totalCacheWriteTokens ?? 0)}`}
                styles={styles}
              />
              <KpiCard
                label="Autonomous"
                value={`${(summary?.autonomousPercent ?? 0).toFixed(1)}%`}
                sub="of token volume"
                styles={styles}
              />
            </View>

            {/* ── 24h usage by backend ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>24H USAGE BY BACKEND</Text>
              <BackendTimeseries points={usage24h?.points ?? []} colors={colors} />
            </View>

            {/* ── Token donut ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>TOKEN SHARE ({String(period).toUpperCase()})</Text>
              <TokenDonut summary={summary} colors={colors} />
            </View>

            {/* ── Subscriptions ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>MONTHLY SUBSCRIPTIONS</Text>
              {subscriptions.length === 0 ? (
                <Text style={styles.emptyText}>No subscriptions configured.</Text>
              ) : (
                subscriptions.map((s) => (
                  <View key={s.id} style={styles.row}>
                    <StatusDot status={s.isActive ? 'ok' : 'missing-credentials'} colors={colors} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{s.provider}</Text>
                      <Text style={styles.rowSub}>{s.plan} · {s.isActive ? 'active' : 'paused'}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.rowValue}>{usd(s.monthlyAmountUsd)}/mo</Text>
                      <Text style={styles.rowSub}>{usd(s.period?.periodCostUsd ?? 0)} this period</Text>
                    </View>
                  </View>
                ))
              )}
            </View>

            {/* ── Top providers ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>TOP PROVIDERS</Text>
              {(summary?.byProvider ?? []).length === 0 ? (
                <Text style={styles.emptyText}>No provider activity yet.</Text>
              ) : (
                (summary?.byProvider ?? []).slice(0, 8).map((p) => (
                  <View key={p.provider} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{p.provider}</Text>
                      <Text style={styles.rowSub}>{compact(p.requests)} reqs · {compact(p.tokensIn + p.tokensOut)} tok</Text>
                    </View>
                    <Text style={styles.rowValue}>{usd(p.costUsd)}</Text>
                  </View>
                ))
              )}
            </View>

            {/* ── Top backends ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>TOP AGENT BACKENDS</Text>
              {(summary?.byBackend ?? []).length === 0 ? (
                <Text style={styles.emptyText}>No CLI activity yet.</Text>
              ) : (
                (summary?.byBackend ?? []).slice(0, 8).map((b) => (
                  <View key={b.agentBackend} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{b.agentBackend}</Text>
                      <Text style={styles.rowSub}>{compact(b.requests)} reqs · {compact(b.tokensIn + b.tokensOut)} tok</Text>
                    </View>
                    <Text style={styles.rowValue}>{usd(b.costUsd)}</Text>
                  </View>
                ))
              )}
            </View>

            {/* ── Top projects ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>TOP PROJECTS</Text>
              {(summary?.byProject ?? []).length === 0 ? (
                <Text style={styles.emptyText}>No project-tagged usage yet.</Text>
              ) : (
                (summary?.byProject ?? []).slice(0, 5).map((p) => (
                  <TouchableOpacity
                    key={p.projectId}
                    style={styles.row}
                    onPress={() => navigation?.navigate?.('BusinessProfile', { businessId: p.projectId })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{p.projectId}</Text>
                      <Text style={styles.rowSub}>{compact(p.tokens)} tokens · {p.requests} reqs</Text>
                    </View>
                    <Text style={styles.rowValue}>{usd(p.costUsd)}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>

            {/* ── Top sessions (drill into AgentFocusSheet) ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>TOP SESSIONS</Text>
              {sessions.length === 0 ? (
                <Text style={styles.emptyText}>No session-tagged usage yet.</Text>
              ) : (
                sessions.slice(0, 8).map((s) => (
                  <TouchableOpacity key={s.sessionKey} style={styles.row} onPress={() => openSession(s.sessionKey)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{s.sessionKey}</Text>
                      <Text style={styles.rowSub}>{compact(s.tokens)} tokens · {s.requests} reqs</Text>
                    </View>
                    <Text style={styles.rowValue}>{usd(s.costUsd)}</Text>
                    <Ionicons name="chevron-forward" size={15} color={colors.textMuted} style={{ marginLeft: 6 }} />
                  </TouchableOpacity>
                ))
              )}
            </View>

            {/* ── CLI plan pullers status ── */}
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>CLI PLAN PULLERS</Text>
                <Text style={styles.sectionHint}>live where an API exists · else estimated</Text>
              </View>
              {sortedPlans.length === 0 ? (
                <Text style={styles.emptyText}>No plan pullers configured.</Text>
              ) : (
                sortedPlans.map((p) => {
                  const u = p.usage || {};
                  const live = u.source === 'api';
                  return (
                    <TouchableOpacity key={p.provider} style={styles.row} onPress={() => refreshPlan(p.provider)}>
                      <StatusDot status={u.status} colors={colors} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowTitle}>{p.provider}</Text>
                        <Text style={styles.rowSub} numberOfLines={1}>
                          {live ? 'live' : 'estimated'} · {relative(u.fetchedAt)}{u.message ? ` · ${u.message}` : ''}
                        </Text>
                      </View>
                      {refreshingPlan === p.provider ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : (
                        <Ionicons name="refresh" size={16} color={colors.primary} />
                      )}
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            {/* ── Provider sync ── */}
            <View style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>PROVIDER SYNC</Text>
                <TouchableOpacity onPress={() => syncProvider()}>
                  <Text style={styles.syncBtn}>Sync all</Text>
                </TouchableOpacity>
              </View>
              {providers.length === 0 ? (
                <Text style={styles.emptyText}>No providers detected.</Text>
              ) : (
                providers.map((p) => (
                  <TouchableOpacity key={p.provider} style={styles.row} onPress={() => syncProvider(p.provider)}>
                    <StatusDot status={p.status} colors={colors} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{p.provider}</Text>
                      <Text style={styles.rowSub}>{p.status} · {relative(p.lastSyncAt)}</Text>
                    </View>
                    <Ionicons name="refresh" size={16} color={colors.primary} />
                  </TouchableOpacity>
                ))
              )}
            </View>

            {/* ── Budgets ── */}
            {budgetStatuses.length > 0 ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>BUDGETS</Text>
                {budgetStatuses.map((b) => {
                  const pct = Math.min(100, b.pctUsed);
                  const barColor =
                    b.state === 'exceeded' || b.state === 'hard'
                      ? colors.error
                      : b.state === 'warn'
                      ? colors.warning
                      : colors.primary;
                  return (
                    <View key={b.id} style={styles.budgetRow}>
                      <View style={styles.budgetHead}>
                        <Text style={styles.rowTitle}>{b.name}</Text>
                        <Text style={styles.rowValue}>{usd(b.currentSpendUsd)} / {usd(b.monthlyLimitUsd)}</Text>
                      </View>
                      <View style={styles.budgetBar}>
                        <View style={[styles.budgetFill, { width: `${pct}%`, backgroundColor: barColor }]} />
                      </View>
                      <Text style={styles.budgetSub}>
                        {b.scopeAxis}{b.scopeValue ? ` = ${b.scopeValue}` : ''} · {b.pctUsed.toFixed(0)}% · {b.state}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ) : null}

            {/* ── Recent entries ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>RECENT ENTRIES</Text>
              {recent.length === 0 ? (
                <Text style={styles.emptyText}>No recorded entries yet.</Text>
              ) : (
                recent.slice(0, 30).map((e) => (
                  <View key={e.id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{e.provider} · {e.model}</Text>
                      <Text style={styles.rowSub}>{e.agentBackend} · {relative(e.timestamp)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={styles.rowValue}>{usd(e.costUsd)}</Text>
                      <Text style={styles.rowSub}>{compact(e.tokensIn + e.tokensOut)} tok</Text>
                    </View>
                  </View>
                ))
              )}
            </View>

            {error ? (
              <View style={[styles.section, { borderColor: colors.error }]}>
                <Text style={{ color: colors.error }}>Error: {error}</Text>
                <TouchableOpacity
                  onPress={load}
                  disabled={loading}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}
                >
                  <Ionicons name="refresh" size={14} color={colors.primary} />
                  <Text style={{ color: colors.primary, fontSize: 13 }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {lastLoadedAt ? (
              <Text style={styles.footnote}>Loaded {relative(lastLoadedAt)}</Text>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Session drill-in */}
      <AgentFocusSheet
        agent={focusAgent}
        provider={null}
        gateway={gateway}
        federation={null}
        navigation={navigation}
        onClose={() => setFocusAgent(null)}
      />
    </View>
  );
}

function makeStyles(colors) {
  const border = colors.border || colors.primary + '33';
  const softBg = colors.cardBg || colors.surface;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { padding: 16, paddingBottom: 64 },
    header: { marginBottom: 12 },
    headerTitle: { color: colors.primary, fontFamily: FONT_FAMILY.bold, fontSize: 18, letterSpacing: 2 },
    headerSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 4, fontFamily: FONT_FAMILY.regular },
    deltaPill: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999,
      paddingHorizontal: 12, paddingVertical: 6, marginBottom: 14,
    },
    deltaText: { fontSize: 13, fontWeight: '800' },
    deltaSub: { color: colors.textMuted, fontSize: 11 },
    totalCard: { padding: 18, borderRadius: 16, borderWidth: 1, marginBottom: 16 },
    totalLabel: { color: colors.primary, fontSize: 11, letterSpacing: 1.5, fontFamily: FONT_FAMILY.bold },
    totalValue: { color: colors.text, fontSize: 34, fontFamily: FONT_FAMILY.bold, marginTop: 6 },
    totalBreakdown: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
    chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
    chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border, backgroundColor: 'transparent' },
    chipText: { color: colors.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
    kpiGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 18 },
    kpiCard: { flexGrow: 1, flexBasis: '47%', padding: 14, borderRadius: 14, borderWidth: 1, borderColor: border, backgroundColor: softBg },
    kpiLabel: { color: colors.textMuted, fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase' },
    kpiValue: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 4 },
    kpiSub: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
    planGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
    sectionBare: { marginBottom: 14 },
    section: { backgroundColor: softBg, borderColor: border, borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 14 },
    sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sectionHint: { color: colors.textMuted, fontSize: 10, opacity: 0.7 },
    sectionTitle: { color: colors.primary, fontSize: 11, letterSpacing: 1.5, fontFamily: FONT_FAMILY.bold, marginBottom: 10 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border, gap: 10 },
    rowTitle: { color: colors.text, fontSize: 13 },
    rowSub: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
    rowValue: { color: colors.text, fontSize: 13, fontFamily: FONT_FAMILY.bold },
    syncBtn: { color: colors.primary, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
    emptyText: { color: colors.textMuted, fontSize: 12, textAlign: 'center', padding: 16 },
    budgetRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border },
    budgetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    budgetBar: { marginTop: 6, height: 6, borderRadius: 4, backgroundColor: colors.primary + '22', overflow: 'hidden' },
    budgetFill: { height: '100%', borderRadius: 4 },
    budgetSub: { color: colors.textMuted, fontSize: 10, marginTop: 4, textTransform: 'uppercase', letterSpacing: 1 },
    footnote: { color: colors.textMuted, fontSize: 10, textAlign: 'center', marginVertical: 16 },
  });
}

export default CreditsScreen;
