/**
 * VaultDiscord — port of ui/src/ui/views/vault-discord.ts.
 * Server card (refresh, sync time), quick actions (announcement), roles,
 * channels grouped by category, tier → role mapping (saved through
 * vault.config.update — a dead <select> on the web), emojis and the activity feed.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import {
  Card,
  ListRow,
  Divider,
  SectionTitle,
  Button,
  Chip,
  EmptyState,
  useUIKit,
  SPACE,
  MONO_FAMILY,
} from '../../ui-kit';
import {
  COURSE_TIERS,
  sortRoles,
  roleColorHex,
  groupChannels,
  channelIcon,
  channelCounts,
  activityIcon,
  configForm,
  buildConfigPatch,
  timeAgo,
  formatNumber,
  titleCase,
  errorText,
} from './vault-model';
import { Avatar, OptionChips } from './vault-ui';

export function VaultDiscord({ ctx }) {
  const { colors, type } = useUIKit();
  const { guild, guildErr } = ctx;
  const [syncedAt, setSyncedAt] = useState(guild ? Date.now() : null);
  const [refreshing, setRefreshing] = useState(false);
  const [tierRoles, setTierRoles] = useState(() => configForm(ctx.config).tierRoles);
  const [savingTiers, setSavingTiers] = useState(false);
  const [expandedTier, setExpandedTier] = useState(null);

  useEffect(() => {
    setTierRoles(configForm(ctx.config).tierRoles);
  }, [ctx.config]);
  useEffect(() => {
    if (guild) setSyncedAt(Date.now());
  }, [guild]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await ctx.reloadCore();
    } finally {
      setRefreshing(false);
    }
  };

  if (!guild) {
    return (
      <View style={{ marginTop: SPACE.lg }}>
        <EmptyState
          icon="logo-discord"
          title="Discord not connected"
          message={`${guildErr ? `${errorText(guildErr)}. ` : ''}Connect your Discord server to manage roles, channels and members. The gateway reads DISCORD_BOT_TOKEN and DISCORD_GUILD_ID.`}
          actionLabel="Connect Discord"
          onAction={refresh}
        />
      </View>
    );
  }

  const counts = channelCounts(guild.channels);
  const roles = sortRoles(guild.roles);
  const groups = groupChannels(guild.channels);
  const activity = ctx.analytics?.recentActivity || [];
  const tierDirty = JSON.stringify(tierRoles) !== JSON.stringify(configForm(ctx.config).tierRoles);

  const saveTiers = async () => {
    setSavingTiers(true);
    try {
      const patch = buildConfigPatch({ ...configForm(ctx.config), tierRoles });
      const res = await ctx.sendReq('vault.config.update', { config: { tierRoles: patch.config.tierRoles } });
      if (res?.config) ctx.setConfig(res.config);
      ctx.notify('Tier role mapping saved');
    } catch (e) {
      ctx.fail(e);
    } finally {
      setSavingTiers(false);
    }
  };

  return (
    <View>
      <Card padded style={{ marginTop: SPACE.md }}>
        <View style={{ gap: SPACE.md }}>
          <View style={styles.row}>
            <Avatar uri={guild.iconUrl} name={guild.name} size={56} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[type.h2, { color: colors.text }]} numberOfLines={1}>{guild.name}</Text>
              <Text style={[type.monoSmall, { color: colors.textMuted, fontFamily: MONO_FAMILY }]}>
                {formatNumber(guild.memberCount)} members · {roles.length} roles · {counts.text} text · {counts.voice} voice · {guild.emojis.length} emojis
              </Text>
              {syncedAt ? <Text style={[type.caption, { color: colors.textMuted }]}>Synced {timeAgo(syncedAt)}</Text> : null}
            </View>
            {guild.premiumTier > 0 ? <Chip label={`Tier ${guild.premiumTier}`} icon="flash" tone="accent" size="sm" /> : null}
          </View>
          <View style={styles.wrap}>
            <Button title="Refresh" icon="refresh-outline" size="sm" variant="secondary" loading={refreshing} onPress={refresh} />
            <Button title="Announcement" icon="megaphone-outline" size="sm" onPress={ctx.openAnnounce} />
            <Button title="Moderation" icon="shield-outline" size="sm" variant="secondary" onPress={() => ctx.go('moderation')} />
          </View>
          <Text style={[type.caption, { color: colors.textMuted }]}>Server settings are not editable from InfiniBot yet (no backend endpoint, same as the web).</Text>
        </View>
      </Card>

      <SectionTitle title="Roles" count={roles.length} />
      <Card padded={false}>
        {roles.length === 0 ? (
          <EmptyState icon="ribbon-outline" title="No roles" compact />
        ) : (
          roles.map((r, i) => {
            const hex = roleColorHex(r.color);
            return (
              <View key={r.id}>
                {i > 0 ? <Divider inset /> : null}
                <ListRow
                  dense
                  leading={<View style={[styles.swatch, { backgroundColor: hex || colors.textMuted, borderColor: colors.border }]} />}
                  title={r.name}
                  trailing={r.managed ? <Chip label="BOT" size="sm" tone="info" /> : undefined}
                  value={r.memberCount != null ? String(r.memberCount) : '?'}
                />
              </View>
            );
          })
        )}
      </Card>

      <SectionTitle title="Channels" count={counts.total} />
      <Card padded={false}>
        {groups.length === 0 ? (
          <EmptyState icon="chatbox-outline" title="No channels" compact />
        ) : (
          groups.map((g) => (
            <View key={g.id}>
              {g.name ? (
                <Text style={[type.label, styles.cat, { color: colors.textSecondary }]}>{g.name}</Text>
              ) : null}
              {g.channels.map((c) => (
                <ListRow
                  key={c.id}
                  dense
                  icon={channelIcon(c.type)}
                  iconTone="neutral"
                  title={c.name}
                  subtitle={(Number(c.type) === 0 || Number(c.type) === 5) && c.topic ? c.topic : undefined}
                />
              ))}
            </View>
          ))
        )}
      </Card>

      <SectionTitle title="Tier role mapping" subtitle="Which Discord role each membership tier grants" />
      <Card padded>
        <View style={{ gap: SPACE.sm }}>
          {COURSE_TIERS.map((tier) => {
            const roleId = tierRoles[tier] || '';
            const role = roles.find((r) => String(r.id) === String(roleId));
            const open = expandedTier === tier;
            return (
              <View key={tier} style={{ gap: SPACE.xs }}>
                <ListRow
                  dense
                  icon="ribbon-outline"
                  title={titleCase(tier)}
                  value={role ? role.name : 'Not mapped'}
                  valueTone={role ? 'primary' : undefined}
                  onPress={() => setExpandedTier(open ? null : tier)}
                  accessibilityLabel={`${tier} tier role: ${role ? role.name : 'not mapped'}. Tap to change`}
                />
                {open ? (
                  <OptionChips
                    options={roles.filter((r) => !r.managed).map((r) => ({ key: String(r.id), label: r.name }))}
                    value={roleId || null}
                    allowNone
                    noneLabel="Not mapped"
                    onChange={(k) => setTierRoles((prev) => {
                      const next = { ...prev };
                      if (k) next[tier] = k;
                      else delete next[tier];
                      return next;
                    })}
                  />
                ) : null}
              </View>
            );
          })}
          {tierDirty ? <Button title="Save mapping" icon="save-outline" size="sm" loading={savingTiers} onPress={saveTiers} /> : null}
        </View>
      </Card>

      <SectionTitle title="Emojis" count={guild.emojis.length} />
      <Card padded>
        {guild.emojis.length === 0 ? (
          <Text style={[type.small, { color: colors.textMuted }]}>No custom emojis</Text>
        ) : (
          <View style={styles.wrap}>
            {guild.emojis.slice(0, 50).map((e) => (
              <Image
                key={e.id}
                source={{ uri: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? 'gif' : 'png'}?size=32` }}
                style={styles.emoji}
                accessibilityLabel={`:${e.name}:`}
              />
            ))}
            {guild.emojis.length > 50 ? <Text style={[type.caption, { color: colors.textMuted }]}>+{guild.emojis.length - 50} more</Text> : null}
          </View>
        )}
      </Card>

      {activity.length ? (
        <>
          <SectionTitle title="Recent activity" count={activity.length} />
          <Card padded={false}>
            {activity.slice(0, 15).map((a, i) => (
              <View key={a.id || i}>
                {i > 0 ? <Divider inset /> : null}
                <ListRow
                  dense
                  icon={activityIcon(a.type)}
                  title={a.memberName || titleCase(a.type)}
                  subtitle={`${a.text}${a.channelName ? `  #${a.channelName}` : ''}`}
                  value={timeAgo(a.timestamp)}
                />
              </View>
            ))}
          </Card>
        </>
      ) : null}
      <View style={{ height: SPACE.lg }} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  swatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 1 },
  cat: { paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.xs },
  emoji: { width: 28, height: 28 },
});

export default VaultDiscord;
