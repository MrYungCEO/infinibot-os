/**
 * InsightsView — web inbox.ts Insights: stat cards (Unread 7d / Today /
 * Last 24h / Scanned), top senders, and the Telegram alert-rule configurator
 * (enable, poll interval, chat id, sender + keyword tags, Save rule) over
 * gmail.insights / gmail.alerts.get / gmail.alerts.set.
 *
 * gmail.insights scans up to 100 messages server-side and can outlast the
 * mobile 30 s request timeout on a 7-day window; on timeout we retry with a
 * 1-day window and say so rather than showing a dead error.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet, Switch, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, HIT, Card, Chip, Button, Field, StatCard, EmptyState, SectionTitle } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  normalizeInsights,
  normalizeRule,
  addTag,
  removeTag,
  clampPoll,
  buildAlertParams,
  errMessage,
  isTimeout,
  isUnknownMethod,
} from './inbox-model';

export function InsightsView({ gateway, accountId, active }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [data, setData] = useState(null);
  const [windowDays, setWindowDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [rule, setRule] = useState(normalizeRule(null));
  const [ruleLoading, setRuleLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [senderInput, setSenderInput] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [pollText, setPollText] = useState('5');
  const seq = useRef(0);
  const loadedFor = useRef(undefined);

  const load = useCallback(async () => {
    if (!sendReq) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      let res;
      let days = 7;
      try {
        res = await sendReq('gmail.insights', { accountId: accountId ?? null, lookbackDays: 7 });
      } catch (e) {
        if (!isTimeout(e)) throw e;
        days = 1;
        res = await sendReq('gmail.insights', { accountId: accountId ?? null, lookbackDays: 1 });
      }
      if (my !== seq.current) return;
      setData(normalizeInsights(res));
      setWindowDays(days);
      setUnavailable(false);
    } catch (e) {
      if (my !== seq.current) return;
      if (isUnknownMethod(e)) setUnavailable(true);
      setError(errMessage(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    setRuleLoading(true);
    try {
      const r = await sendReq('gmail.alerts.get', { accountId: accountId ?? null });
      if (my !== seq.current) return;
      const n = normalizeRule(r?.rule);
      setRule(n);
      setPollText(String(n.pollIntervalMinutes));
    } catch {
      /* keep default (web behaviour) */
    } finally {
      if (my === seq.current) setRuleLoading(false);
    }
  }, [sendReq, accountId]);

  // Lazy: load the first time the tab is shown, and again when the account changes.
  useEffect(() => {
    if (!connected || !active) return;
    if (loadedFor.current === (accountId ?? null)) return;
    loadedFor.current = accountId ?? null;
    setData(null);
    setRule(normalizeRule(null));
    load();
  }, [connected, active, accountId, load]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const next = { ...rule, pollIntervalMinutes: clampPoll(pollText) };
      setRule(next);
      setPollText(String(next.pollIntervalMinutes));
      const res = await sendReq('gmail.alerts.set', buildAlertParams(accountId, next));
      if (res?.rule) setRule(normalizeRule(res.rule));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setSaveError(errMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (unavailable) {
    return (
      <EmptyState
        icon="cloud-offline-outline"
        title="Insights are not available on this gateway"
        message="This gateway does not expose gmail.insights."
        style={{ marginTop: SPACE.xxl }}
      />
    );
  }

  const cols = width >= 700 ? 4 : 2;
  const tileW = `${100 / cols - 2}%`;
  const suffix = windowDays === 7 ? '7d' : '24h';

  const tagEditor = (label, list, input, setInput, key, placeholder) => (
    <View style={{ gap: SPACE.sm }}>
      <Text style={[type.label, { color: colors.textSecondary }]}>{label}</Text>
      {list.length ? (
        <View style={styles.tags}>
          {list.map((t) => (
            <Chip
              key={t}
              label={t}
              tone="primary"
              icon="close"
              onPress={() => setRule((r) => ({ ...r, [key]: removeTag(r[key], t) }))}
              accessibilityLabel={`Remove ${t}`}
            />
          ))}
        </View>
      ) : (
        <Text style={[type.caption, { color: colors.textMuted }]}>None yet.</Text>
      )}
      <View style={styles.addRow}>
        <Field
          style={{ flex: 1 }}
          placeholder={placeholder}
          value={input}
          onChangeText={setInput}
          autoCapitalize="none"
          returnKeyType="done"
          onSubmitEditing={() => {
            setRule((r) => ({ ...r, [key]: addTag(r[key], input) }));
            setInput('');
          }}
          accessibilityLabel={label}
        />
        <Button
          title="Add"
          size="sm"
          variant="secondary"
          onPress={() => {
            setRule((r) => ({ ...r, [key]: addTag(r[key], input) }));
            setInput('');
          }}
        />
      </View>
    </View>
  );

  return (
    <ScrollView
      contentContainerStyle={styles.wrap}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading && !!data} onRefresh={load} tintColor={colors.primary} />}
    >
      {error && !data ? (
        <EmptyState icon="alert-circle-outline" tone="danger" title="Could not load insights" message={error} actionLabel="Retry" onAction={load} compact />
      ) : (
        <>
          {windowDays !== 7 && data ? (
            <Text style={[type.caption, { color: colors.warning }]}>
              The 7-day scan timed out on mobile; showing the last 24 hours. Pull to retry.
            </Text>
          ) : null}
          <View style={styles.grid}>
            {[
              { k: 'unread', label: `Unread (${suffix})`, icon: 'mail-unread-outline' },
              { k: 'today', label: 'Today', icon: 'today-outline' },
              { k: 'last24h', label: 'Last 24h', icon: 'time-outline' },
              { k: 'totalScanned', label: 'Scanned', icon: 'scan-outline' },
            ].map((t) => (
              <View key={t.k} style={{ width: tileW }}>
                <StatCard label={t.label} value={data ? data[t.k] : '—'} icon={t.icon} loading={loading && !data} compact />
              </View>
            ))}
          </View>
          {loading && !data ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>Scanning mail — this can take up to a minute…</Text>
          ) : null}
          {data && data.topSenders.length ? (
            <Card padded>
              <Text style={[type.label, { color: colors.textSecondary, marginBottom: SPACE.sm }]}>Top senders ({suffix})</Text>
              <View style={styles.tags}>
                {data.topSenders.map((s) => (
                  <Chip key={s.sender} label={s.sender} count={s.count} tone="neutral" />
                ))}
              </View>
            </Card>
          ) : null}
        </>
      )}

      <SectionTitle title="Telegram Alert Rules" />
      <Card padded tint="primary">
        <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start' }}>
          <Ionicons name="notifications-outline" size={18} color={colors.primary} style={{ marginTop: 2 }} />
          <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]}>
            Get a Telegram message when important emails arrive.
            {accountId == null ? (
              <Text style={{ color: colors.textMuted }}> (Select a specific account to configure per-account rules.)</Text>
            ) : null}
          </Text>
        </View>
        {ruleLoading ? <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>Loading rule…</Text> : null}

        <View style={[styles.toggleRow, { borderBottomColor: withAlpha(colors.text, 0.06) }]}>
          <Text style={[type.body, { color: colors.text, flex: 1 }]}>Enable alerts</Text>
          <Switch
            value={!!rule.enabled}
            onValueChange={(v) => setRule((r) => ({ ...r, enabled: v }))}
            trackColor={{ false: withAlpha(colors.text, 0.2), true: withAlpha(colors.primary, 0.6) }}
            thumbColor={rule.enabled ? colors.primary : colors.textSecondary}
            accessibilityLabel="Enable alerts"
          />
        </View>

        <View style={{ gap: SPACE.md, marginTop: SPACE.md }}>
          <Field
            label="Poll every (min)"
            mono
            keyboardType="number-pad"
            value={pollText}
            onChangeText={(t) => setPollText(t.replace(/[^0-9]/g, '').slice(0, 2))}
            helper="1–60 minutes"
          />
          <Field
            label="Telegram chat ID"
            mono
            placeholder="-100xxxxxxxxx"
            value={rule.telegramChatId || ''}
            onChangeText={(t) => setRule((r) => ({ ...r, telegramChatId: t }))}
            autoCapitalize="none"
          />
          {tagEditor('Alert from senders', rule.senders, senderInput, setSenderInput, 'senders', 'sender@example.com')}
          {tagEditor('Alert on keywords', rule.keywords, keywordInput, setKeywordInput, 'keywords', 'urgent, invoice, …')}
          <View style={styles.addRow}>
            <Button title={saving ? 'Saving…' : 'Save rule'} icon="save-outline" loading={saving} onPress={save} />
            {saved ? (
              <View style={styles.saved}>
                <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                <Text style={[type.small, { color: colors.success }]}>Saved</Text>
              </View>
            ) : null}
          </View>
          {saveError ? <Text style={[type.small, { color: colors.error }]}>{saveError}</Text> : null}
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: SPACE.sm },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  toggleRow: { flexDirection: 'row', alignItems: 'center', minHeight: HIT.min, marginTop: SPACE.sm, borderBottomWidth: 1 },
  saved: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
});

export default InsightsView;
