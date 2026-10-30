/**
 * ChannelDetailSheet — one channel card opened full: status grid, accounts,
 * last error / probe, guided setup (Telegram wizard, WhatsApp link), the
 * credential form (config.patch, same patch the web comms-hub sends),
 * enable/disable, disconnect (channels.logout) and the raw status JSON.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Button, Input, Chip, SectionTitle, Divider, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  channelBrand,
  channelLabel,
  channelCardState,
  channelStatusRows,
  probeSummary,
  channelLastError,
  channelIdentity,
  channelConfigEnabled,
  defaultAccountId,
  accountRunningLabel,
  accountConnectedLabel,
  formatAgo,
  setupSpec,
  initialSetupFields,
  STATE_LABEL,
  STATE_TONE,
} from './comms-model';
import { TelegramSetup } from './TelegramSetup';
import { WhatsAppLink } from './WhatsAppLink';

export function ChannelDetailSheet({
  visible,
  channelId,
  snapshot,
  setup,          // { current, sensitiveSet, baseHash, loaded }
  busy,           // bool — toggle/disconnect in flight for this channel
  saving,
  onClose,
  onProbe,        // () => refresh with probe
  onRefresh,      // (probe) => void
  onToggle,       // (enabled) => void
  onDisconnect,   // (accountId) => void
  onSave,         // (fields) => Promise<bool>
  gateway,
}) {
  const { colors, type } = useUIKit();
  const [fields, setFields] = useState({});
  const [showRaw, setShowRaw] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [confirmDisc, setConfirmDisc] = useState(false);

  useEffect(() => {
    if (visible && channelId) {
      setFields(initialSetupFields(channelId, setup?.current || {}));
      setShowRaw(false);
      setConfirmDisc(false);
      setShowAdvanced(false);
    }
    if (!visible) setFields({}); // drop typed secrets
  }, [visible, channelId, setup?.current]);

  if (!channelId) return null;
  const brand = channelBrand(channelId);
  const state = channelCardState(channelId, snapshot);
  const rows = channelStatusRows(channelId, snapshot);
  const probe = probeSummary(channelId, snapshot);
  const lastError = channelLastError(channelId, snapshot);
  const identity = channelIdentity(channelId, snapshot);
  const accounts = snapshot?.channelAccounts?.[channelId] || [];
  const spec = setupSpec(channelId);
  const enabled = channelConfigEnabled(channelId, snapshot);
  const configured = Boolean(snapshot?.channels?.[channelId]?.configured);
  const accountId = defaultAccountId(channelId, snapshot);
  const raw = snapshot?.channels?.[channelId];

  const muted = [type.caption, { color: colors.textMuted }];
  const body = [type.small, { color: colors.textSecondary }];

  const statusGrid = (
    <View style={[st.grid, { borderColor: colors.borderSubtle || colors.border }]}>
      {rows.map(([k, v]) => (
        <View key={k} style={st.gridRow}>
          <Text style={muted}>{k}</Text>
          <Text style={[type.monoSmall, { color: colors.text }]}>{v}</Text>
        </View>
      ))}
    </View>
  );

  const builtIn = ['telegram', 'whatsapp', 'discord', 'slack', 'signal', 'imessage', 'googlechat'].includes(channelId);
  // Built-in cards list accounts only when there are several; generic cards always do.
  const accountList = accounts.length > (builtIn ? 1 : 0) ? (
    <View style={st.gap}>
      <SectionTitle title={`Accounts (${accounts.length})`} style={{ marginTop: SPACE.sm }} />
      {accounts.map((a) => {
        const botUser = a?.probe?.bot?.username;
        return (
          <View key={a.accountId} style={[st.account, { borderColor: colors.border }]}>
            <View style={st.rowBetween}>
              <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{botUser ? `@${botUser}` : a.name || a.accountId}</Text>
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{a.accountId}</Text>
            </View>
            <Text style={muted}>
              Running {accountRunningLabel(a)} · Configured {a.configured ? 'Yes' : 'No'} · Connected {accountConnectedLabel(a)} · Last inbound {a.lastInboundAt ? formatAgo(a.lastInboundAt) : 'n/a'}
            </Text>
            {a.lastError ? <Text style={[type.caption, { color: colors.error }]}>{a.lastError}</Text> : null}
          </View>
        );
      })}
    </View>
  ) : null;

  const form = spec && spec.fields.length ? (
    <View style={st.gap}>
      <SectionTitle title="Configuration" style={{ marginTop: SPACE.sm }} />
      {spec.note ? <Text style={body}>{spec.note}</Text> : null}
      {spec.fields.map((f) => {
        const stored = setup?.sensitiveSet?.[`${channelId}.${f.key}`];
        return (
          <Input
            key={f.key}
            label={f.label}
            value={fields[f.key] ?? ''}
            onChangeText={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
            placeholder={f.sensitive && stored ? 'Saved — type to replace' : f.placeholder}
            helper={f.help}
            secureTextEntry={f.type === 'password'}
            mono={f.type !== 'csv'}
            autoCapitalize="none"
            autoCorrect={false}
          />
        );
      })}
      <View style={st.row}>
        <Button
          title={saving ? 'Saving…' : 'Save'}
          variant="primary"
          size="sm"
          loading={saving}
          disabled={saving}
          onPress={async () => {
            const ok = await onSave(fields);
            if (ok) setFields(initialSetupFields(channelId, setup?.current || {}));
          }}
        />
        <Button title="Reload" variant="outline" size="sm" disabled={saving} onPress={() => onRefresh(true)} />
      </View>
    </View>
  ) : spec?.note && channelId !== 'whatsapp' ? (
    <View style={st.gap}>
      <SectionTitle title="Configuration" style={{ marginTop: SPACE.sm }} />
      <Text style={body}>{spec.note}</Text>
      {!configured ? <Button title={saving ? 'Saving…' : 'Enable'} variant="primary" size="sm" loading={saving} onPress={() => onSave({})} /> : null}
    </View>
  ) : !spec ? (
    <View style={st.gap}>
      <SectionTitle title="Configuration" style={{ marginTop: SPACE.sm }} />
      <Text style={body}>This channel has no mobile setup form. Configure it from the web Channels page or the CLI; enable / disable and disconnect work here.</Text>
    </View>
  ) : null;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={channelLabel(snapshot, channelId)}
      subtitle={identity || undefined}
      maxHeightRatio={0.92}
      headerRight={<Chip size="sm" dot tone={STATE_TONE[state]} label={STATE_LABEL[state]} />}
    >
      <View style={st.gap}>
        <View style={[st.hero, { borderColor: withAlpha(brand.color, 0.45), backgroundColor: withAlpha(brand.color, 0.08) }]}>
          <Ionicons name={brand.icon} size={26} color={brand.color} />
          <Text style={[body, { flex: 1 }]}>{brand.tagline}</Text>
        </View>

        {lastError ? (
          <View style={[st.callout, { borderColor: withAlpha(colors.error, 0.5), backgroundColor: withAlpha(colors.error, 0.08) }]}>
            <Text style={[type.small, { color: colors.error }]}>{lastError}</Text>
          </View>
        ) : null}

        {channelId === 'telegram' ? (
          <>
            <TelegramSetup gateway={gateway} onChanged={() => onRefresh(true)} />
            {accountList}
            <Pressable onPress={() => setShowAdvanced(!showAdvanced)} accessibilityRole="button" accessibilityLabel="Advanced settings and status" style={st.disclosure}>
              <Ionicons name={showAdvanced ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
              <Text style={body}>Advanced settings and status</Text>
            </Pressable>
            {showAdvanced ? (
              <View style={st.gap}>
                {accounts.length > 1 ? null : statusGrid}
                {probe ? <Text style={[type.small, { color: probe.ok ? colors.success : colors.warning }]}>{probe.text}</Text> : null}
                {form}
                <Button title="Probe" icon="pulse-outline" variant="outline" size="sm" onPress={onProbe} />
              </View>
            ) : null}
          </>
        ) : (
          <>
            {statusGrid}
            {probe ? <Text style={[type.small, { color: probe.ok ? colors.success : colors.warning }]}>{probe.text}</Text> : null}
            {accountList}
            {channelId === 'whatsapp' ? (
              <View style={st.gap}>
                <SectionTitle title="Link WhatsApp" style={{ marginTop: SPACE.sm }} />
                <Text style={body}>{spec?.note}</Text>
                <WhatsAppLink gateway={gateway} onChanged={(probeIt) => onRefresh(probeIt)} />
              </View>
            ) : null}
            {form}
            <View style={st.row}>
              <Button title="Probe" icon="pulse-outline" variant="outline" size="sm" onPress={onProbe} />
            </View>
          </>
        )}

        <Divider spacing={SPACE.sm} />
        <View style={st.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={[type.smallStrong, { color: colors.text }]}>Enabled</Text>
            <Text style={muted}>channels.{channelId}.enabled — applies after the gateway reloads config</Text>
          </View>
          <Switch
            value={enabled}
            disabled={busy}
            onValueChange={(v) => onToggle(v)}
            trackColor={{ true: withAlpha(colors.primary, 0.6), false: colors.border }}
            thumbColor={enabled ? colors.primary : colors.textMuted}
            accessibilityLabel={`${enabled ? 'Disable' : 'Enable'} ${brand.label}`}
          />
        </View>
        {configured && channelId !== 'telegram' && channelId !== 'whatsapp' ? (
          confirmDisc ? (
            <View style={[st.callout, { borderColor: withAlpha(colors.warning, 0.5), gap: SPACE.sm }]}>
              <Text style={body}>Disconnect {brand.label} ({accountId})? The account is logged out; config stays so you can reconnect.</Text>
              <View style={st.row}>
                <Button title="Yes, disconnect" variant="danger" size="sm" loading={busy} disabled={busy} onPress={() => { setConfirmDisc(false); onDisconnect(accountId); }} />
                <Button title="Keep it" variant="outline" size="sm" onPress={() => setConfirmDisc(false)} />
              </View>
            </View>
          ) : (
            <Button title="Disconnect" icon="log-out-outline" variant="danger" size="sm" disabled={busy} onPress={() => setConfirmDisc(true)} />
          )
        ) : null}

        <Pressable onPress={() => setShowRaw(!showRaw)} accessibilityRole="button" accessibilityLabel="Raw status snapshot" style={st.disclosure}>
          <Ionicons name={showRaw ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
          <Text style={body}>Raw status snapshot</Text>
        </Pressable>
        {showRaw ? (
          <View style={[st.raw, { borderColor: colors.border, backgroundColor: colors.surfaceDeep || colors.inputBg }]}>
            <Text selectable style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary }}>
              {JSON.stringify({ status: raw ?? null, accounts }, null, 2)}
            </Text>
          </View>
        ) : null}
      </View>
    </BottomSheet>
  );
}

const st = StyleSheet.create({
  gap: { gap: SPACE.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACE.sm },
  hero: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  grid: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACE.sm, minHeight: 22, alignItems: 'center' },
  account: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
  callout: { padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  disclosure: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
  raw: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.sm, padding: SPACE.md },
});

export default ChannelDetailSheet;
