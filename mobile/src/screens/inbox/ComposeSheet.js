/**
 * ComposeSheet — the web global email composer (email-composer-host.ts) as a
 * bottom sheet: From picker (email.providerInfo outbound accounts, primary
 * preselected), To / Subject / Body, "no provider configured" warning, and
 * Send via email.send (auto-closes on success like the web).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';

import { useUIKit, SPACE, BottomSheet, Button, Field, Chip } from '../../ui-kit';
import {
  normalizeProviderInfo,
  pickDefaultFrom,
  validateCompose,
  buildSendParams,
  errMessage,
} from './inbox-model';

export function ComposeSheet({ visible, onClose, gateway, initial }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [accountId, setAccountId] = useState('');
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!visible) return;
    setTo(initial?.to || '');
    setSubject(initial?.subject || '');
    setBody(initial?.body || '');
    setStatus(null);
    setAccountId('');
    setInfo(null);
    if (!sendReq) return;
    sendReq('email.providerInfo', {})
      .then((r) => {
        const n = normalizeProviderInfo(r);
        setInfo(n);
        setAccountId((cur) => cur || pickDefaultFrom(n.accounts, initial?.businessId || ''));
      })
      .catch(() => {
        /* informational only (web behaviour) */
      });
  }, [visible, sendReq, initial]);

  const send = async () => {
    const invalid = validateCompose({ to, subject });
    if (invalid) {
      setStatus({ ok: false, message: invalid });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await sendReq(
        'email.send',
        buildSendParams({ to, subject, body, businessId: initial?.businessId, accountId }),
      );
      setStatus({ ok: true, message: `Sent via ${res?.providerUsed || 'provider'}` });
      setTimeout(() => onClose?.(), 1200);
    } catch (e) {
      setStatus({ ok: false, message: errMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const accounts = info?.accounts || [];
  const noProvider = !!info?.noProvider;

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Send email"
      subtitle={info?.defaultFrom ? `From: ${info.defaultFrom}` : initial?.contextLabel || undefined}
      maxHeightRatio={0.94}
      footer={
        <View style={styles.footer}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <View style={{ flex: 1 }} />
          <Button title={busy ? 'Sending…' : 'Send'} icon="send" loading={busy} disabled={noProvider} onPress={send} />
        </View>
      }
    >
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ gap: SPACE.md }}>
        {noProvider ? (
          <Text style={[type.small, { color: colors.warning }]}>
            No email provider configured. Set RESEND_API_KEY, LOOPS_API_KEY, or add an SMTP/IMAP account from Manage accounts.
          </Text>
        ) : null}
        {accounts.length ? (
          <View style={{ gap: SPACE.xs }}>
            <Text style={[type.label, { color: colors.textSecondary }]}>From</Text>
            <View style={styles.chips}>
              {accounts.map((a) => (
                <Chip
                  key={a.id}
                  label={`${a.displayName || a.address}${a.isPrimary ? ' · primary' : ''}`}
                  icon="at-outline"
                  tone="primary"
                  selected={accountId === a.id}
                  onPress={() => setAccountId(a.id)}
                  accessibilityLabel={`Send from ${a.address}`}
                />
              ))}
            </View>
          </View>
        ) : null}
        <Field label="To" value={to} onChangeText={setTo} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="name@example.com" />
        <Field label="Subject" value={subject} onChangeText={setSubject} />
        <Field label="Body" value={body} onChangeText={setBody} multiline rows={8} />
        {status ? (
          <Text style={[type.small, { color: status.ok ? colors.success : colors.error }]} accessibilityRole="alert">
            {status.message}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
});

export default ComposeSheet;
