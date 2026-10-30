/**
 * AccountsSheet — the web "Manage Email Accounts" modal (email-accounts.ts):
 * account cards with outbound/inbound health, Test (email.accounts.test),
 * Make primary (email.accounts.setPrimary), Delete (email.accounts.delete),
 * and an "Add SMTP / IMAP account" form with auto-discovery
 * (email.accounts.discover → email.accounts.create).
 *
 * Gmail OAuth, the transactional-API kinds (Mailgun / SendGrid / Resend) and
 * editing an existing account stay on the web wizard — the OAuth consent
 * redirect lands on the gateway's own origin, which a phone browser usually
 * cannot reach — so those open the web inbox in the WebSurface host.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Switch, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, HIT, BottomSheet, Button, Field, Card, Chip, EmptyState, SkeletonRow } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  normalizeEmailAccount,
  summarizeTestResult,
  emptyImapForm,
  applyDiscovery,
  validateImapForm,
  buildImapAccountPayload,
  ACCOUNT_KIND_LABEL,
  errMessage,
} from './inbox-model';

const HEALTH_TONE = { ok: 'success', error: 'danger', unknown: 'neutral', off: 'neutral' };
const HEALTH_LABEL = { ok: 'ok', error: 'failing', unknown: 'untested', off: 'off' };

function confirmAsync(title, message) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(`${title}\n\n${message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Delete', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

export function AccountsSheet({ visible, onClose, gateway, onOpenWeb }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState(null); // null = list mode
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState(null);
  const [discovery, setDiscovery] = useState(null);

  const refresh = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    try {
      const r = await sendReq('email.accounts.list', {});
      setAccounts((r?.accounts || []).map(normalizeEmailAccount));
    } catch (e) {
      setBanner(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    if (visible) {
      setBanner(null);
      setForm(null);
      refresh();
    }
  }, [visible, refresh]);

  const runTest = async (a) => {
    setBusyId(a.id);
    try {
      const r = await sendReq('email.accounts.test', { id: a.id, direction: 'both' });
      setBanner(summarizeTestResult(a, r));
      await refresh();
    } catch (e) {
      setBanner(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  const setPrimary = async (a) => {
    setBusyId(a.id);
    try {
      await sendReq('email.accounts.setPrimary', { id: a.id });
      await refresh();
    } catch (e) {
      setBanner(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };
  const remove = async (a) => {
    const ok = await confirmAsync('Delete this email account?', 'Inbound listener will stop immediately.');
    if (!ok) return;
    setBusyId(a.id);
    try {
      await sendReq('email.accounts.delete', { id: a.id });
      await refresh();
    } catch (e) {
      setBanner(errMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const setF = (patch) => setForm((f) => ({ ...f, ...patch }));
  const discover = async () => {
    if (!form?.address?.includes('@')) {
      setFormError('Enter the email address first.');
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      const r = await sendReq('email.accounts.discover', { address: form.address.trim() });
      setForm((f) => applyDiscovery(f, r));
      setDiscovery(r?.ok && r.suggestion ? r.suggestion.source || 'found' : 'none');
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setFormBusy(false);
    }
  };
  const save = async () => {
    const invalid = validateImapForm(form);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFormBusy(true);
    setFormError(null);
    try {
      await sendReq('email.accounts.create', buildImapAccountPayload(form));
      setForm(null);
      await refresh();
    } catch (e) {
      setFormError(errMessage(e));
    } finally {
      setFormBusy(false);
    }
  };

  const healthChip = (label, tone) => (
    <Chip label={`${label} ${HEALTH_LABEL[tone]}`} tone={HEALTH_TONE[tone]} dot size="sm" />
  );

  const listBody = (
    <View style={{ gap: SPACE.md }}>
      {banner ? (
        <Text style={[type.small, { color: colors.error }]} accessibilityRole="alert">
          {banner}
        </Text>
      ) : null}
      {accounts === null && loading ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : accounts && accounts.length === 0 ? (
        <EmptyState icon="mail-outline" title="No email accounts" message="Add an SMTP/IMAP account here, or connect Gmail on the web." compact />
      ) : (
        (accounts || []).map((a) => (
          <Card key={a.id} padded tint={a.isPrimary ? 'primary' : 'neutral'}>
            <View style={styles.cardHead}>
              <Ionicons name={a.kind === 'gmail' ? 'logo-google' : 'mail-outline'} size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
                  {a.displayName}
                </Text>
                <Text style={[type.small, { color: colors.textMuted }]} numberOfLines={1}>
                  {a.address} · {ACCOUNT_KIND_LABEL[a.kind] || a.kind}
                </Text>
              </View>
              {a.isPrimary ? <Chip label="Primary" tone="primary" size="sm" /> : null}
            </View>
            <View style={styles.chips}>
              {healthChip('Outbound', a.outboundHealth)}
              {healthChip('Inbound', a.inboundHealth)}
              {a.labels.map((l) => (
                <Chip key={l} label={l} size="sm" />
              ))}
            </View>
            {a.outboundError && a.outboundHealth === 'error' ? (
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
                outbound: {a.outboundError}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button title="Test" icon="pulse-outline" size="sm" variant="outline" loading={busyId === a.id} onPress={() => runTest(a)} />
              {!a.isPrimary ? (
                <Button title="Make primary" icon="star-outline" size="sm" variant="ghost" disabled={busyId === a.id} onPress={() => setPrimary(a)} />
              ) : null}
              <View style={{ flex: 1 }} />
              <Button title="Delete" icon="trash-outline" size="sm" variant="danger" disabled={busyId === a.id} onPress={() => remove(a)} />
            </View>
          </Card>
        ))
      )}
      <Button title="Add SMTP / IMAP account" icon="add" variant="secondary" fullWidth onPress={() => { setForm(emptyImapForm()); setFormError(null); setDiscovery(null); }} />
      <Button
        title="Connect Gmail / API provider / edit on web"
        icon="open-outline"
        variant="ghost"
        fullWidth
        onPress={onOpenWeb}
      />
    </View>
  );

  const switchRow = (label, value, onChange) => (
    <View style={[styles.switchRow, { borderBottomColor: withAlpha(colors.text, 0.06) }]}>
      <Text style={[type.body, { color: colors.text, flex: 1 }]}>{label}</Text>
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ false: withAlpha(colors.text, 0.2), true: withAlpha(colors.primary, 0.6) }}
        thumbColor={value ? colors.primary : colors.textSecondary}
        accessibilityLabel={label}
      />
    </View>
  );

  const formBody = form ? (
    <View style={{ gap: SPACE.md }}>
      <Field label="Email address" required value={form.address} onChangeText={(t) => setF({ address: t })} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="you@yourdomain.com" />
      <Field label="Display name" value={form.displayName} onChangeText={(t) => setF({ displayName: t })} placeholder="Defaults to the address" />
      <Button title="Find server settings" icon="search-outline" variant="outline" size="sm" loading={formBusy} onPress={discover} />
      {discovery ? (
        <Text style={[type.caption, { color: discovery === 'none' ? colors.warning : colors.success }]}>
          {discovery === 'none' ? 'No settings found — fill them in manually.' : `Settings found (${discovery}).`}
        </Text>
      ) : null}
      <Text style={[type.label, { color: colors.textSecondary }]}>Outbound (SMTP)</Text>
      <Field label="SMTP host" mono value={form.smtpHost} onChangeText={(t) => setF({ smtpHost: t })} autoCapitalize="none" autoCorrect={false} />
      <Field label="SMTP port" mono keyboardType="number-pad" value={form.smtpPort} onChangeText={(t) => setF({ smtpPort: t.replace(/[^0-9]/g, '') })} />
      {switchRow('SSL/TLS (port 465)', form.smtpSecure, (v) => setF({ smtpSecure: v }))}
      <Field label="SMTP username" value={form.smtpUser} onChangeText={(t) => setF({ smtpUser: t })} autoCapitalize="none" autoCorrect={false} placeholder="Defaults to the address" />
      <Field label="SMTP password" value={form.smtpPassword} onChangeText={(t) => setF({ smtpPassword: t })} secureTextEntry autoCapitalize="none" />
      <Text style={[type.label, { color: colors.textSecondary }]}>Inbound (IMAP)</Text>
      {switchRow('Receive mail (IMAP listener)', form.inboundEnabled, (v) => setF({ inboundEnabled: v }))}
      {form.inboundEnabled ? (
        <>
          <Field label="IMAP host" mono value={form.imapHost} onChangeText={(t) => setF({ imapHost: t })} autoCapitalize="none" autoCorrect={false} />
          <Field label="IMAP port" mono keyboardType="number-pad" value={form.imapPort} onChangeText={(t) => setF({ imapPort: t.replace(/[^0-9]/g, '') })} />
          {switchRow('IMAP SSL/TLS', form.imapSecure, (v) => setF({ imapSecure: v }))}
          <Field label="Mailbox" mono value={form.imapMailbox} onChangeText={(t) => setF({ imapMailbox: t })} autoCapitalize="none" />
          {switchRow('Use the SMTP credentials', form.sameInboundCreds, (v) => setF({ sameInboundCreds: v }))}
          {!form.sameInboundCreds ? (
            <>
              <Field label="IMAP username" value={form.imapUser} onChangeText={(t) => setF({ imapUser: t })} autoCapitalize="none" autoCorrect={false} />
              <Field label="IMAP password" value={form.imapPassword} onChangeText={(t) => setF({ imapPassword: t })} secureTextEntry autoCapitalize="none" />
            </>
          ) : null}
        </>
      ) : null}
      {switchRow('Make primary', form.isPrimary, (v) => setF({ isPrimary: v }))}
      {formError ? (
        <Text style={[type.small, { color: colors.error }]} accessibilityRole="alert">
          {formError}
        </Text>
      ) : null}
    </View>
  ) : null;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={form ? 'Add SMTP / IMAP account' : 'Manage Email Accounts'}
      subtitle={form ? undefined : 'SMTP/IMAP, Gmail, and API providers — one per business primary.'}
      maxHeightRatio={0.94}
      headerRight={
        form ? null : (
          <Button title="Refresh" icon="refresh" size="sm" variant="ghost" loading={loading && accounts !== null} onPress={refresh} />
        )
      }
      footer={
        form ? (
          <View style={styles.actions}>
            <Button title="Back" variant="ghost" icon="chevron-back" onPress={() => setForm(null)} />
            <View style={{ flex: 1 }} />
            <Button title="Save account" icon="save-outline" loading={formBusy} onPress={save} />
          </View>
        ) : null
      }
    >
      {form ? formBody : listBody}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.sm, flexWrap: 'wrap' },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: HIT.min, borderBottomWidth: 1 },
});

export default AccountsSheet;
