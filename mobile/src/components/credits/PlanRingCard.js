/**
 * PlanRingCard — one provider plan as a progress ring + quota + controls.
 *
 * Mobile mirror of `renderPlanCards()` in ui/src/ui/views/credits.ts. Each card
 * shows: provider label, an inline plan picker (locked while AUTO), an
 * AUTO/MANUAL toggle, a "use detected" CTA when the CLI reports a different
 * plan than the pinned one, an SVG quota ring (used vs limit), the live/
 * estimated status badge, reset countdown, and Refresh.
 *
 * Data shape = CreditsProviderPlan from credits.providers.list.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { providerLabel } from './backend-brand';

const usd = (n) => {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0';
};

const compact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

function fmtResetIn(periodEnd) {
  if (!periodEnd) return '—';
  const diff = periodEnd - Date.now();
  if (diff <= 0) return '—';
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  if (days >= 1) return `${days}d ${hours}h`;
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}h ${mins}m`;
}

function statusBanner(p) {
  const u = p.usage || {};
  if (u.status === 'unsupported' && /not installed/i.test(u.message ?? '')) {
    return { text: 'CLI not installed', tone: 'muted' };
  }
  if (u.status === 'missing-credentials') return { text: 'Auth required', tone: 'warn' };
  if (u.status === 'error') return { text: 'Error', tone: 'warn' };
  if (u.source === 'api') return { text: 'Live', tone: 'ok' };
  return { text: 'Estimated', tone: 'muted' };
}

function Ring({ pct, label, color, track }) {
  const size = 84;
  const stroke = 9;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const filled = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  const dash = (filled / 100) * circ;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        {pct != null ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${dash} ${circ - dash}`}
          />
        ) : (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray="4 8"
            opacity={0.5}
          />
        )}
      </Svg>
      <Text style={{ color: '#fff8d8', fontSize: 16, fontWeight: '800' }}>{label}</Text>
    </View>
  );
}

export function PlanRingCard({ plan, colors, busy, onSetPlan, onSetAuto, onRefresh, onPress }) {
  const u = plan.usage || {};
  const cfg = plan.config || {};
  const used = u.usedUsd ?? 0;
  const limit = u.limitUsd;
  const pct = limit && limit > 0 ? (used / limit) * 100 : null;
  const tone = pct == null ? 'muted' : pct >= 95 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  const ringColor =
    tone === 'bad' ? colors.error : tone === 'warn' ? (colors.warning || '#ffcf6a') : colors.primary;
  const banner = statusBanner(plan);
  const auto = cfg.auto ?? true;
  const detected = u.detectedPlan;
  const available = plan.availablePlans || [];
  const detectedLabel = available.find((o) => o.id === detected)?.label ?? detected;
  const currentLabel =
    available.find((o) => o.id === cfg.plan)?.label ?? plan.planDef?.label ?? cfg.plan ?? '—';
  const showDetectPrompt = !auto && !!detected && detected !== cfg.plan;
  const center = pct != null ? `${Math.round(pct)}%` : '∙';

  const [pickerOpen, setPickerOpen] = useState(false);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  const bannerColor =
    banner.tone === 'ok' ? (colors.success || '#6cd49a')
      : banner.tone === 'warn' ? (colors.warning || '#ffcf6a')
        : colors.textMuted;

  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.85 : 1}
      onPress={onPress}
      style={[
        styles.card,
        tone === 'bad' && { borderColor: colors.error },
        tone === 'warn' && { borderColor: colors.warning || '#ffcf6a' },
      ]}
    >
      <View style={styles.head}>
        <Text style={styles.title}>{providerLabel(plan.provider)}</Text>
        <View style={[styles.badge, { borderColor: bannerColor + '66' }]}>
          <View style={[styles.dot, { backgroundColor: bannerColor }]} />
          <Text style={[styles.badgeText, { color: bannerColor }]}>{banner.text}</Text>
        </View>
      </View>

      {/* Plan picker row */}
      <View style={styles.pickerRow}>
        <TouchableOpacity
          disabled={auto || busy}
          onPress={() => setPickerOpen((v) => !v)}
          style={[styles.planChip, (auto || busy) && { opacity: 0.55 }]}
        >
          <Text style={styles.planChipText} numberOfLines={1}>{currentLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={busy}
          onPress={() => onSetAuto?.(plan.provider, !auto)}
          style={[styles.autoToggle, auto && styles.autoToggleOn]}
        >
          <Text style={[styles.autoText, auto && { color: colors.success || '#8fe6b4' }]}>
            {auto ? 'AUTO' : 'MANUAL'}
          </Text>
        </TouchableOpacity>
      </View>

      {pickerOpen && !auto ? (
        <View style={styles.planList}>
          {available.map((o) => (
            <TouchableOpacity
              key={o.id}
              onPress={() => { setPickerOpen(false); onSetPlan?.(plan.provider, o.id); }}
              style={styles.planOption}
            >
              <Text style={[styles.planOptionText, cfg.plan === o.id && { color: colors.primary }]}>
                {o.label}{o.hasUsageApi ? ' · live' : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      {showDetectPrompt ? (
        <TouchableOpacity onPress={() => onSetPlan?.(plan.provider, detected)} style={styles.detectPrompt}>
          <Text style={styles.detectText}>
            CLI says <Text style={{ fontWeight: '800' }}>{detectedLabel}</Text> — tap to use detected
          </Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.body}>
        <Ring pct={pct} label={center} color={ringColor} track={colors.primary + '22'} />
        <View style={{ flex: 1 }}>
          <Text style={styles.used}>{usd(used)}</Text>
          <Text style={styles.limit}>{limit ? `of ${usd(limit)}` : 'no limit set'}</Text>
          <Text style={styles.reset}>resets in {fmtResetIn(u.periodEnd)}</Text>
          {u.usedTokens ? <Text style={styles.reset}>{compact(u.usedTokens)} tok</Text> : null}
        </View>
      </View>

      <View style={styles.foot}>
        <TouchableOpacity
          disabled={busy}
          onPress={() => onRefresh?.(plan.provider)}
          style={styles.refreshBtn}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.refreshText}>Refresh</Text>
          )}
        </TouchableOpacity>
        {u.message ? (
          <Text style={styles.msg} numberOfLines={1}>{u.message}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function makeStyles(colors) {
  const border = colors.border || colors.primary + '33';
  return StyleSheet.create({
    card: {
      backgroundColor: colors.cardBg || colors.surface,
      borderColor: border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 14,
      flexGrow: 1,
      flexBasis: '47%',
      minWidth: 150,
    },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 },
    title: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
    badge: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2,
    },
    dot: { width: 6, height: 6, borderRadius: 3 },
    badgeText: { fontSize: 9, letterSpacing: 0.5, textTransform: 'uppercase' },
    pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
    planChip: {
      flex: 1, borderWidth: 1, borderColor: border, borderRadius: 6,
      paddingHorizontal: 8, paddingVertical: 5, backgroundColor: colors.background + '55',
    },
    planChipText: { color: colors.text, fontSize: 11 },
    autoToggle: {
      borderWidth: 1, borderColor: border, borderRadius: 999,
      paddingHorizontal: 8, paddingVertical: 4,
    },
    autoToggleOn: { borderColor: (colors.success || '#6cd49a') + '88', backgroundColor: (colors.success || '#6cd49a') + '22' },
    autoText: { color: colors.textMuted, fontSize: 9, letterSpacing: 0.5 },
    planList: {
      marginTop: 6, borderWidth: 1, borderColor: border, borderRadius: 8, overflow: 'hidden',
    },
    planOption: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: border },
    planOptionText: { color: colors.text, fontSize: 12 },
    detectPrompt: { marginTop: 6 },
    detectText: { color: colors.warning || '#ffcf6a', fontSize: 11 },
    body: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
    used: { color: colors.text, fontSize: 20, fontWeight: '800' },
    limit: { color: colors.textMuted, fontSize: 11, marginTop: 1 },
    reset: { color: colors.textMuted, fontSize: 11, marginTop: 1, opacity: 0.85 },
    foot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
    refreshBtn: {
      borderWidth: 1, borderColor: border, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 6, minWidth: 76, alignItems: 'center',
    },
    refreshText: { color: colors.text, fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase' },
    msg: { color: colors.textMuted, fontSize: 10, flex: 1, opacity: 0.7 },
  });
}

export default PlanRingCard;
