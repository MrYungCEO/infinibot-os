/**
 * VaultScreen — native Kingly Vault (web /vault, registry key 'vault':
 * "Community vault — members, tiers, courses").
 *
 * 1:1 port of ui/src/ui/views/vault-dashboard.ts and its sub-views
 * (vault-members / vault-courses / vault-discord / vault-onboarding) over the
 * same `vault.*` WS RPCs the web controller (ui/src/ui/controllers/vault.ts)
 * calls. Sections: Overview, Members, Courses, Discord, Moderation,
 * Automation, Analytics, Learning Path, System.
 *
 * Route params: { section?, memberId?, courseId? }
 *   section  — any section key (aliases: tiers→members, onboarding→path, system→setup …)
 *   memberId — opens that member's profile sheet (vault.members.get)
 *   courseId — opens that course's editor (vault.courses.get)
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  Screen,
  AppHeader,
  Tabs,
  Card,
  ListRow,
  Divider,
  SectionTitle,
  Button,
  Field,
  BottomSheet,
  EmptyState,
  Skeleton,
  useUIKit,
  SPACE,
  RADIUS,
  MONO_FAMILY,
} from '../../ui-kit';
import {
  SECTIONS,
  resolveSection,
  normalizeAnalytics,
  normalizeGuild,
  buildKpis,
  mergeActivity,
  textChannels,
  activityIcon,
  timeAgo,
  formatNumber,
  formatPercent,
  titleCase,
  errorText,
  isMissingMethod,
} from './vault-model';
import { StatGrid, SectionError, Banner, useDialogs, Avatar, OptionChips } from './vault-ui';
import { VaultMembers } from './VaultMembers';
import { VaultCourses } from './VaultCourses';
import { VaultDiscord } from './VaultDiscord';
import { VaultModeration, VaultAutomation, VaultAnalytics, VaultSetup } from './VaultOps';
import { VaultPath } from './VaultPath';

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

export function VaultScreen({ navigation, route, gateway }) {
  const { colors, type } = useUIKit();
  const params = route?.params || {};
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [section, setSection] = useState(() => resolveSection(params));
  useEffect(() => {
    setSection(resolveSection(route?.params));
  }, [route?.params?.section, route?.params?.memberId, route?.params?.courseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared vault state (web loadVaultData): analytics, config, Discord guild + roles + channels.
  const [analytics, setAnalytics] = useState(null);
  const [rawAnalytics, setRawAnalytics] = useState(null);
  const [analyticsErr, setAnalyticsErr] = useState(null);
  const [guild, setGuild] = useState(null);
  const [guildErr, setGuildErr] = useState(null);
  const [config, setConfig] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState(null);
  const [intent, setIntent] = useState(null);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const dialogs = useDialogs();

  const notify = useCallback((text, tone = 'success') => {
    setToast({ text, tone, at: Date.now() });
  }, []);
  const fail = useCallback((err) => {
    setToast({ text: errorText(err), tone: 'danger', at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast || toast.tone === 'danger') return undefined;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const loadCore = useCallback(async () => {
    if (!sendReq) return;
    const [a, c, g, r, ch] = await Promise.all([
      settle(sendReq('vault.analytics.get', {})),
      settle(sendReq('vault.config.get', {})),
      settle(sendReq('vault.discord.guild', {})),
      settle(sendReq('vault.discord.roles.list', {})),
      settle(sendReq('vault.discord.channels.list', {})),
    ]);
    let norm = a.ok ? normalizeAnalytics(a.value?.analytics ?? a.value) : null;
    setRawAnalytics(a.ok ? (a.value?.analytics ?? a.value) : null);
    setAnalyticsErr(a.ok ? null : a.error);
    setConfig(c.ok ? (c.value?.config ?? null) : null);
    const g2 = g.ok ? normalizeGuild(g.value, r.ok ? r.value?.roles : [], ch.ok ? ch.value?.channels : []) : null;
    setGuild(g2);
    setGuildErr(g.ok ? null : g.error);
    // Recent Discord messages from up to 3 text channels join the activity feed (web parity).
    if (norm && g2) {
      const chans = (g2.channels || []).filter((x) => Number(x.type) === 0).slice(0, 3);
      if (chans.length) {
        const res = await Promise.all(chans.map((x) => settle(sendReq('vault.discord.messages.recent', { channelId: x.id, channelName: x.name, limit: 10 }))));
        const msgs = res.flatMap((x) => (x.ok && Array.isArray(x.value?.messages) ? x.value.messages : []));
        if (msgs.length) norm = { ...norm, recentActivity: mergeActivity(msgs, norm.recentActivity) };
      }
    }
    setAnalytics(norm);
    setLoaded(true);
  }, [sendReq]);

  useEffect(() => {
    if (connected) loadCore();
  }, [connected, loadCore]);

  // Web polls analytics every 30 s while the vault is open.
  useEffect(() => {
    if (!connected || !sendReq) return undefined;
    const t = setInterval(async () => {
      try {
        const res = await sendReq('vault.analytics.get', {});
        const n = normalizeAnalytics(res?.analytics ?? res);
        if (n) setAnalytics((prev) => (prev && prev.recentActivity.length > n.recentActivity.length ? { ...n, recentActivity: prev.recentActivity } : n));
      } catch {
        /* poll failures are silent, as on the web */
      }
    }, 30000);
    return () => clearInterval(t);
  }, [connected, sendReq]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadCore();
    } finally {
      setTick((t) => t + 1);
      setRefreshing(false);
    }
  }, [loadCore]);

  const go = useCallback((key, nextIntent) => {
    setSection(key);
    if (nextIntent) setIntent({ type: nextIntent, at: Date.now() });
  }, []);

  const ctx = useMemo(() => ({
    sendReq,
    connected,
    guild,
    guildErr,
    config,
    setConfig,
    analytics,
    rawAnalytics,
    analyticsErr,
    setAnalytics,
    reloadCore: loadCore,
    notify,
    fail,
    dialogs,
    tick,
    intent,
    clearIntent: () => setIntent(null),
    go,
    openAnnounce: () => setAnnounceOpen(true),
  }), [sendReq, connected, guild, guildErr, config, analytics, rawAnalytics, analyticsErr, loadCore, notify, fail, dialogs, tick, intent, go]);

  const isOnline = Boolean(analytics);
  const tabs = SECTIONS.map((s) => ({ key: s.key, label: s.label, icon: s.icon }));

  const header = (
    <AppHeader
      eyebrow="Community"
      title="Kingly Vault"
      subtitle={guild ? guild.name : guildErr ? 'Discord disconnected' : loaded ? 'Vault' : 'Loading...'}
      statusPill={{ label: isOnline ? 'ONLINE' : 'OFFLINE', color: isOnline ? colors.success : colors.textMuted, dot: true }}
      leftIcon="chevron-back"
      leftLabel="Back"
      onLeftPress={() => navigation?.goBack?.()}
      rightActions={[
        { key: 'sync', icon: 'sync-outline', label: 'Sync vault data', onPress: onRefresh, busy: refreshing },
        { key: 'announce', icon: 'megaphone-outline', label: 'Send announcement', onPress: () => setAnnounceOpen(true) },
        { key: 'config', icon: 'settings-outline', label: 'Vault configuration', onPress: () => setSection('setup') },
      ]}
    >
      <Tabs tabs={tabs} active={section} onSelect={setSection} />
    </AppHeader>
  );

  let body;
  if (!sendReq) {
    body = <EmptyState icon="cloud-offline-outline" title="No gateway" message="Connect to a gateway to manage the vault." />;
  } else if (!connected && !loaded) {
    body = <EmptyState icon="cloud-offline-outline" title="Waiting for the gateway" message="The vault loads once the gateway connection is up." />;
  } else if (section === 'members') {
    body = <VaultMembers ctx={ctx} memberId={params.memberId} />;
  } else if (section === 'courses') {
    body = <VaultCourses ctx={ctx} courseId={params.courseId} />;
  } else if (section === 'discord') {
    body = <VaultDiscord ctx={ctx} />;
  } else if (section === 'moderation') {
    body = <VaultModeration ctx={ctx} />;
  } else if (section === 'automation') {
    body = <VaultAutomation ctx={ctx} />;
  } else if (section === 'analytics') {
    body = <VaultAnalytics ctx={ctx} />;
  } else if (section === 'path') {
    body = <VaultPath ctx={ctx} />;
  } else if (section === 'setup') {
    body = <VaultSetup ctx={ctx} />;
  } else {
    body = <Overview ctx={ctx} loaded={loaded} />;
  }

  return (
    <Screen edges={['bottom', 'left', 'right']} header={header} refreshing={refreshing} onRefresh={onRefresh} keyboardAvoiding>
      {toast ? <Banner tone={toast.tone} text={toast.text} onClose={() => setToast(null)} /> : null}
      {body}
      <AnnounceSheet ctx={ctx} visible={announceOpen} onClose={() => setAnnounceOpen(false)} />
      {dialogs.element}
    </Screen>
  );
}

// ── Overview tab ─────────────────────────────────────────────

function Overview({ ctx, loaded }) {
  const { colors, type } = useUIKit();
  const { analytics, analyticsErr, guild, guildErr, go } = ctx;
  const [syncing, setSyncing] = useState(false);

  if (!loaded) {
    return (
      <View style={{ gap: SPACE.sm, marginTop: SPACE.lg }}>
        <Skeleton height={86} count={1} />
        <Skeleton height={86} count={1} />
        <Skeleton height={160} count={1} />
      </View>
    );
  }
  if (analyticsErr && isMissingMethod(analyticsErr)) {
    return <SectionError error={analyticsErr} onRetry={ctx.reloadCore} what="the Kingly Vault (vault.analytics.get)" />;
  }

  const kpis = buildKpis(analytics, guild);
  const a = analytics;
  const activity = a?.recentActivity || [];
  const top = a?.topCourses || [];

  const quick = [
    { key: 'announce', icon: 'megaphone-outline', label: 'Announce', onPress: ctx.openAnnounce },
    { key: 'member', icon: 'person-add-outline', label: 'Add member', onPress: () => go('members', 'addMember') },
    { key: 'course', icon: 'book-outline', label: 'New course', onPress: () => go('courses', 'newCourse') },
    { key: 'rule', icon: 'flash-outline', label: 'New rule', onPress: () => go('automation', 'newRule') },
    { key: 'mod', icon: 'shield-outline', label: 'Mod queue', onPress: () => go('moderation') },
    { key: 'reports', icon: 'bar-chart-outline', label: 'Reports', onPress: () => go('analytics') },
  ];

  const syncMembers = async () => {
    const ok = await ctx.dialogs.confirm({
      title: 'Sync members from Discord?',
      message: 'Imports up to 100 guild members into the vault. Synced members are written as active, free tier.',
      confirmLabel: 'Sync',
    });
    if (!ok) return;
    setSyncing(true);
    try {
      const res = await ctx.sendReq('vault.discord.sync', {});
      ctx.notify(`Synced ${res?.synced ?? 0} of ${res?.total ?? 0} Discord members`);
      await ctx.reloadCore();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <View>
      {analyticsErr ? <SectionError error={analyticsErr} onRetry={ctx.reloadCore} what="vault analytics" /> : null}
      <SectionTitle title="Vault at a glance" subtitle="Tap a tile to open its section" />
      <StatGrid items={kpis} onPressItem={(it) => go(it.section)} />

      <SectionTitle title="Quick actions" />
      <View style={styles.quickGrid}>
        {quick.map((q) => (
          <Pressable
            key={q.key}
            onPress={q.onPress}
            accessibilityRole="button"
            accessibilityLabel={q.label}
            style={({ pressed }) => [styles.quick, { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed ? 0.75 : 1 }]}
          >
            <Ionicons name={q.icon} size={20} color={colors.primary} />
            <Text style={[type.caption, { color: colors.text }]} numberOfLines={1}>{q.label}</Text>
          </Pressable>
        ))}
      </View>

      <SectionTitle title="Activity feed" count={activity.length} />
      <Card padded={false}>
        {activity.length === 0 ? (
          <EmptyState icon="pulse-outline" title="Waiting for member activity" message="Joins, completions, warnings and Discord messages appear here." compact />
        ) : (
          activity.slice(0, 15).map((ev, i) => (
            <View key={ev.id || i}>
              {i > 0 ? <Divider inset /> : null}
              <ListRow
                dense
                leading={ev.memberAvatar ? <Avatar uri={ev.memberAvatar} name={ev.memberName} size={28} /> : undefined}
                icon={ev.memberAvatar ? undefined : activityIcon(ev.type)}
                title={ev.memberName ? `@${ev.memberName}` : titleCase(ev.type)}
                subtitle={ev.text}
                value={timeAgo(ev.timestamp)}
                trailing={ev.channelName ? <Text style={[type.caption, { color: colors.primary }]}>#{ev.channelName}</Text> : undefined}
              />
            </View>
          ))
        )}
      </Card>

      <SectionTitle title="System insights" />
      <StatGrid
        items={[
          { key: 'churn', label: 'Churn rate', value: formatPercent(a?.churnRate ?? 0), icon: 'trending-down-outline' },
          { key: 'new', label: 'New this month', value: formatNumber(a?.newThisMonth ?? 0), icon: 'trending-up-outline' },
          { key: 'eng', label: 'Engagement', value: formatPercent(a?.averageEngagement ?? 0), icon: 'pulse-outline' },
          { key: 'warn', label: 'Total warnings', value: formatNumber(a?.totalWarnings ?? 0), icon: 'warning-outline' },
        ]}
      />

      {a?.byTier?.some((t) => t.count > 0) ? (
        <>
          <SectionTitle title="Members by tier" actionLabel="Members" onAction={() => go('members')} />
          <Card padded={false}>
            {a.byTier.map((t, i) => (
              <View key={t.tier}>
                {i > 0 ? <Divider inset /> : null}
                <ListRow dense icon="ribbon-outline" title={titleCase(t.tier)} value={formatNumber(t.count)} />
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <SectionTitle title="Server status" actionLabel="Discord" onAction={() => go('discord')} />
      <Card padded>
        {guild ? (
          <View style={{ gap: SPACE.sm }}>
            <View style={styles.row}>
              <Avatar uri={guild.iconUrl} name={guild.name} size={44} />
              <View style={{ flex: 1 }}>
                <Text style={[type.h3, { color: colors.text }]} numberOfLines={1}>{guild.name}</Text>
                <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>
                  {formatNumber(guild.memberCount)} members · {formatNumber(guild.onlineCount)} online
                </Text>
              </View>
            </View>
            <View style={styles.row}>
              <MiniStat label="Roles" value={guild.roles.length} />
              <MiniStat label="Channels" value={guild.channels.length} />
              <MiniStat label="Emojis" value={guild.emojis.length} />
              <MiniStat label="Boost" value={guild.premiumTier ? `T${guild.premiumTier}` : '-'} />
            </View>
          </View>
        ) : (
          <EmptyState
            icon="logo-discord"
            title="Discord not connected"
            message={guildErr ? errorText(guildErr) : 'Connect your Discord server to manage roles and channels.'}
            actionLabel="Open Discord"
            onAction={() => go('discord')}
            compact
          />
        )}
      </Card>

      <SectionTitle title="Top courses" actionLabel="View all" onAction={() => go('courses')} />
      <Card padded={false}>
        {top.length === 0 ? (
          <EmptyState icon="book-outline" title="No courses yet" actionLabel="Create a course" onAction={() => go('courses', 'newCourse')} compact />
        ) : (
          top.slice(0, 5).map((c, i) => (
            <View key={c.id || i}>
              {i > 0 ? <Divider inset /> : null}
              <ListRow
                dense
                leading={<Text style={[type.monoSmall, { color: colors.primary, fontFamily: MONO_FAMILY, minWidth: 24 }]}>#{i + 1}</Text>}
                title={c.title}
                value={`${c.enrollments} enrolled`}
                onPress={() => go('courses', c.id ? `openCourse:${c.id}` : undefined)}
                accessibilityLabel={`Open course ${c.title}`}
              />
            </View>
          ))
        )}
      </Card>

      <SectionTitle title="Server controls" />
      <View style={styles.wrapRow}>
        <Button title="Sync members" icon="people-outline" variant="secondary" size="sm" loading={syncing} onPress={syncMembers} />
        <Button title="Refresh" icon="refresh-outline" variant="secondary" size="sm" onPress={ctx.reloadCore} />
        <Button title="Audit log" icon="eye-outline" variant="secondary" size="sm" onPress={() => go('moderation')} />
        <Button title="Rule engine" icon="hardware-chip-outline" variant="secondary" size="sm" onPress={() => go('automation')} />
      </View>
    </View>
  );
}

function MiniStat({ label, value }) {
  const { colors, type } = useUIKit();
  return (
    <View style={[styles.mini, { borderColor: colors.borderSubtle || colors.border }]}>
      <Text style={[type.caption, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[type.mono, { color: colors.text, fontFamily: MONO_FAMILY }]}>{String(value)}</Text>
    </View>
  );
}

// ── Announcement sheet (dashboard + Discord tab) ─────────────

function AnnounceSheet({ ctx, visible, onClose }) {
  const { colors, type } = useUIKit();
  const [channelId, setChannelId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const channels = textChannels(ctx.guild?.channels);

  useEffect(() => {
    if (visible) {
      setChannelId('');
      setTitle('');
      setContent('');
    }
  }, [visible]);

  const send = async () => {
    setBusy(true);
    try {
      // vault.discord.send posts plain text under `message`; the web's optional
      // title rides along as a bold first line rather than an unsupported embed.
      const message = title.trim() ? `**${title.trim()}**\n${content}` : content;
      await ctx.sendReq('vault.discord.send', { channelId, message });
      ctx.notify('Announcement sent');
      onClose();
    } catch (e) {
      ctx.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Send announcement"
      subtitle={ctx.guild ? ctx.guild.name : 'Discord'}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title="Send" icon="megaphone-outline" onPress={send} loading={busy} disabled={!channelId || !content.trim()} />
        </View>
      }
    >
      {!ctx.guild ? (
        <EmptyState icon="logo-discord" title="Discord not connected" message="Announcements post to a Discord channel. Connect the server first." compact />
      ) : (
        <View style={{ gap: SPACE.md }}>
          {channels.length === 0 ? (
            <Text style={[type.small, { color: colors.textMuted }]}>No text channels found.</Text>
          ) : (
            <OptionChips
              label="Target channel"
              options={channels.map((c) => ({ key: c.id, label: `#${c.name}` }))}
              value={channelId}
              onChange={(k) => setChannelId(k || '')}
            />
          )}
          <Field label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Announcement title..." />
          <Field label="Message" value={content} onChangeText={setContent} placeholder="Your announcement..." multiline rows={5} required />
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  quick: {
    flexBasis: '31%',
    flexGrow: 1,
    minHeight: 64,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, flexWrap: 'wrap' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  mini: { flexGrow: 1, flexBasis: '22%', borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm, gap: 2 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACE.sm },
});

export default VaultScreen;
