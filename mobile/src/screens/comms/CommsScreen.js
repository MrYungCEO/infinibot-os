/**
 * CommsScreen — native Channels page (web /channels with its "Inbox" sub-tab,
 * which /comms routes to). Mobile registry key 'comms'.
 *
 *   Channels  per-channel connection cards from channels.status (Telegram,
 *             WhatsApp, Discord, Slack, Signal, iMessage, Google Chat, plugins),
 *             detail sheet with guided Telegram setup, WhatsApp pairing-code /
 *             QR link, credential form + enable toggle (config.patch with
 *             baseHash from config.get), disconnect (channels.logout), probe,
 *             channel health snapshot.
 *   Inbox     cross-channel threads (comms.*) — see InboxPane.
 *
 * Route params: { channel?, threadId?, view? }
 *   threadId          → Inbox with that thread open
 *   view: 'inbox'     → Inbox (channel pre-filters when it is an inbox channel)
 *   channel           → Channels with that channel's sheet open
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, Pressable, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  Screen, AppHeader, SegmentedControl, StatCard, Chip, EmptyState, SkeletonRow, SectionTitle, Button,
  useUIKit, SPACE, RADIUS, MONO_FAMILY,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  orderChannels,
  channelStats,
  channelBrand,
  channelLabel,
  channelCardState,
  channelIdentity,
  channelLastError,
  formatAgo,
  extractSetupPrefill,
  setupPatchParams,
  togglePatchParams,
  isUnknownMethod,
  initialViewFromParams,
  STATE_LABEL,
  STATE_TONE,
} from './comms-model';
import { ChannelDetailSheet } from './ChannelDetailSheet';
import { InboxPane } from './InboxPane';

export function CommsScreen({ navigation, route, gateway }) {
  const { colors, type } = useUIKit();
  const { width, height } = useWindowDimensions();
  const wide = width >= 700 || width > height;
  const compact = height < 500; // landscape phone: trim header + composer chrome
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const init = useMemo(() => initialViewFromParams(route?.params), [route?.params]);

  const [tab, setTab] = useState(init.tab);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [setup, setSetup] = useState({ current: {}, sensitiveSet: {}, baseHash: null });
  const [openId, setOpenId] = useState(init.openChannel);
  const [busy, setBusy] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [pending, setPending] = useState(0);
  const [showHealth, setShowHealth] = useState(false);
  const loadingRef = useRef(false);
  const toastTimer = useRef(null);

  // Deep links arriving while mounted.
  useEffect(() => {
    setTab(init.tab);
    if (init.openChannel) setOpenId(init.openChannel);
  }, [init]);

  const showToast = useCallback((t) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  useEffect(() => () => toastTimer.current && clearTimeout(toastTimer.current), []);

  const loadConfig = useCallback(async () => {
    if (!sendReq) return;
    try {
      const snap = await sendReq('config.get', {});
      setSetup(extractSetupPrefill(snap));
    } catch { /* best-effort: cards still render without prefills / baseHash */ }
  }, [sendReq]);

  const loadChannels = useCallback(async (probe = false) => {
    if (!sendReq || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await sendReq('channels.status', { probe, timeoutMs: 8000 });
      setSnapshot(res || {});
      setLastSuccessAt(Date.now());
    } catch (e) {
      setError(isUnknownMethod(e) ? 'This gateway does not serve channels.status.' : e?.message || String(e));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [sendReq]);

  const refreshAll = useCallback(async (probe = false) => {
    await Promise.all([loadChannels(probe), loadConfig()]);
  }, [loadChannels, loadConfig]);

  useEffect(() => {
    if (connected) refreshAll(false);
  }, [connected, refreshAll]);

  // ── mutations (comms-hub controller semantics) ──────────────────────────
  const saveSetup = async (fields) => {
    if (!openId || saving) return false;
    setSaving(true);
    try {
      await sendReq('config.patch', setupPatchParams(openId, fields, setup.baseHash));
      showToast({ kind: 'ok', message: `${openId} saved — applying config…` });
      await refreshAll(true);
      return true;
    } catch (e) {
      showToast({ kind: 'error', message: e?.message || String(e) });
      await loadConfig(); // a stale baseHash is the usual failure: re-read it
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (id, enabled) => {
    if (busy[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    // Optimistic flip on the default account.
    setSnapshot((s) => {
      if (!s) return s;
      const accounts = (s.channelAccounts?.[id] || []).map((a, i) => (i === 0 ? { ...a, enabled } : a));
      return { ...s, channelAccounts: { ...(s.channelAccounts || {}), [id]: accounts.length ? accounts : [{ accountId: 'default', enabled }] } };
    });
    try {
      await sendReq('config.patch', togglePatchParams(id, enabled, setup.baseHash));
      showToast({ kind: 'ok', message: `${id} ${enabled ? 'enabled' : 'disabled'} — applying…` });
    } catch (e) {
      showToast({ kind: 'error', message: e?.message || String(e) });
    } finally {
      await refreshAll(false); // reconcile the optimistic flip
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const disconnect = async (id, accountId) => {
    if (busy[id]) return;
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await sendReq('channels.logout', { channel: id, accountId });
      showToast({ kind: 'ok', message: `${id} disconnected` });
      await refreshAll(true);
    } catch (e) {
      showToast({ kind: 'error', message: e?.message || String(e) });
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const ordered = orderChannels(snapshot);
  const stats = channelStats(snapshot);

  // ── channels list ───────────────────────────────────────────────────────
  const channelCard = ({ id, enabled }) => {
    const brand = channelBrand(id);
    const state = channelCardState(id, snapshot);
    const identity = channelIdentity(id, snapshot);
    const err = channelLastError(id, snapshot);
    const label = channelLabel(snapshot, id);
    return (
      <Pressable
        key={id}
        onPress={() => setOpenId(id)}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${STATE_LABEL[state]}. Open setup`}
        style={({ pressed }) => [
          st.card,
          wide && st.cardWide,
          {
            borderColor: state === 'connected' ? withAlpha(brand.color, 0.5) : state === 'error' ? withAlpha(colors.error, 0.5) : colors.border,
            backgroundColor: colors.surface,
            opacity: pressed ? 0.88 : enabled || state !== 'unconfigured' ? 1 : 0.82,
          },
        ]}
      >
        <View style={st.cardHead}>
          <View style={[st.logo, { borderColor: withAlpha(brand.color, 0.5), backgroundColor: withAlpha(brand.color, 0.14) }]}>
            <Ionicons name={brand.icon} size={22} color={brand.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{label}</Text>
            <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>{identity || brand.tagline}</Text>
          </View>
          <Chip size="sm" dot tone={STATE_TONE[state]} label={STATE_LABEL[state]} />
        </View>
        {err ? <Text style={[type.caption, { color: colors.error }]} numberOfLines={2}>{err}</Text> : null}
        <View style={st.cardFoot}>
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {state === 'unconfigured' ? 'Tap to connect' : state === 'connected' ? 'Tap to manage' : 'Tap to fix'}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
        </View>
      </Pressable>
    );
  };

  const channelsPane = (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xxl, gap: SPACE.md }}
      refreshControl={<RefreshControl refreshing={loading && snapshot != null} onRefresh={() => refreshAll(false)} tintColor={colors.primary} colors={[colors.primary]} />}
    >
      <Text style={[type.small, { color: colors.textSecondary }]}>
        Connect every place your people already communicate. Credentials stay scoped to the gateway while live status, setup, and diagnostics remain in one control surface.
      </Text>
      <View style={st.stats}>
        <StatCard compact label="Active" value={snapshot ? String(stats.active) : '—'} icon="radio-outline" style={{ flex: 1 }} />
        <StatCard compact label="Available" value={snapshot ? String(stats.available) : '—'} icon="apps-outline" style={{ flex: 1 }} />
      </View>

      {error && !snapshot ? (
        <EmptyState tone="danger" icon="alert-circle-outline" title="Couldn't load channels" message={error} actionLabel="Retry" onAction={() => refreshAll(false)} />
      ) : !snapshot ? (
        <View style={{ gap: SPACE.sm }}>{[0, 1, 2, 3].map((i) => <SkeletonRow key={i} avatar />)}</View>
      ) : ordered.length === 0 ? (
        <EmptyState icon="chatbubbles-outline" title="No channels available" message="This gateway reports no channel plugins." />
      ) : (
        <View style={[st.grid, wide && st.gridWide]}>{ordered.map(channelCard)}</View>
      )}

      <SectionTitle
        title="Channel health"
        subtitle="Channel status snapshots from the gateway."
        right={<Text style={[type.monoSmall, { color: colors.textMuted }]}>{lastSuccessAt ? formatAgo(lastSuccessAt) : 'n/a'}</Text>}
      />
      {error && snapshot ? (
        <View style={[st.callout, { borderColor: withAlpha(colors.error, 0.5) }]}>
          <Text style={[type.small, { color: colors.error }]}>{error}</Text>
        </View>
      ) : null}
      <View style={st.row}>
        <Button title="Probe all" icon="pulse-outline" variant="outline" size="sm" loading={loading} disabled={loading} onPress={() => refreshAll(true)} />
        <Button title={showHealth ? 'Hide snapshot' : 'Show snapshot'} icon="code-slash-outline" variant="ghost" size="sm" onPress={() => setShowHealth(!showHealth)} />
      </View>
      {showHealth ? (
        <View style={[st.raw, { borderColor: colors.border, backgroundColor: colors.surfaceDeep || colors.inputBg }]}>
          <Text selectable style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary }}>
            {snapshot ? JSON.stringify(snapshot, null, 2) : 'No snapshot yet.'}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );

  const header = (
    <AppHeader
      eyebrow={compact ? undefined : 'Communication matrix'}
      title="Channels"
      subtitle={compact ? undefined : snapshot ? `${stats.active} active · ${stats.available} available` : connected ? 'Loading…' : 'Waiting for the gateway'}
      leftIcon="chevron-back"
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      status={connected ? 'connected' : 'connecting'}
      rightActions={[{ key: 'refresh', icon: 'refresh', label: 'Refresh channel status', busy: loading, onPress: () => refreshAll(false) }]}
    >
      <SegmentedControl
        size="sm"
        options={[
          { key: 'channels', label: 'Channels', icon: 'radio-outline' },
          { key: 'inbox', label: pending > 0 ? `Inbox (${pending})` : 'Inbox', icon: 'mail-outline' },
        ]}
        value={tab}
        onChange={setTab}
      />
    </AppHeader>
  );

  return (
    <Screen scroll={false} padded={false} edges={['bottom', 'left', 'right']} opaque keyboardAvoiding header={header}>
      {!connected && !snapshot && tab === 'channels' ? (
        <View style={{ padding: SPACE.lg }}>
          <EmptyState icon="cloud-offline-outline" title="Not connected" message="Channels load once the app reconnects to your InfiniBot gateway." />
        </View>
      ) : tab === 'channels' ? channelsPane : (
        <InboxPane
          gateway={gateway}
          wide={wide}
          compact={compact}
          initialThreadId={init.threadId}
          initialChannelFilter={init.channelFilter}
          onPendingChange={setPending}
          onToast={showToast}
        />
      )}

      <ChannelDetailSheet
        visible={Boolean(openId)}
        channelId={openId}
        snapshot={snapshot}
        setup={setup}
        busy={Boolean(openId && busy[openId])}
        saving={saving}
        gateway={gateway}
        onClose={() => setOpenId(null)}
        onProbe={() => refreshAll(true)}
        onRefresh={(probe) => refreshAll(Boolean(probe))}
        onToggle={(enabled) => toggleEnabled(openId, enabled)}
        onDisconnect={(accountId) => disconnect(openId, accountId)}
        onSave={saveSetup}
      />

      {toast ? (
        <View pointerEvents="none" style={[st.toast, {
          borderColor: toast.kind === 'error' ? withAlpha(colors.error, 0.6) : toast.kind === 'ok' ? withAlpha(colors.success, 0.6) : colors.border,
          backgroundColor: colors.surfaceDeep || colors.surface,
        }]}>
          <Ionicons name={toast.kind === 'error' ? 'alert-circle' : toast.kind === 'ok' ? 'checkmark-circle' : 'information-circle'} size={16}
            color={toast.kind === 'error' ? colors.error : toast.kind === 'ok' ? colors.success : colors.primary} />
          <Text style={[type.small, { color: colors.text, flex: 1 }]} numberOfLines={4}>{toast.message}</Text>
        </View>
      ) : null}
    </Screen>
  );
}

const st = StyleSheet.create({
  stats: { flexDirection: 'row', gap: SPACE.sm },
  grid: { gap: SPACE.sm },
  gridWide: { flexDirection: 'row', flexWrap: 'wrap' },
  card: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.sm, minHeight: 44 },
  cardWide: { width: '48.5%' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logo: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  callout: { padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  raw: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.sm, padding: SPACE.md },
  toast: {
    position: 'absolute', left: SPACE.lg, right: SPACE.lg, bottom: SPACE.xxl,
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1,
  },
});

export default CommsScreen;
