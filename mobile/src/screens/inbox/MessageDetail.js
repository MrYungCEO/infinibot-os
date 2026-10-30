/**
 * MessageDetail — one email (web inbox-all-mail detail panel): subject, From /
 * To / date, AI Summarize (gmail.summarize → summary + action chips +
 * provider·model), body. Opening hydrates via gmail.get and marks it read
 * (gmail.markRead), as the web does. Native adds the actions the gateway
 * already exposes: Reply (gmail.reply), Star/Unstar, Mark unread, Archive,
 * Trash, and "Ask agent" (doc-agent on the thread, like the web side panel).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, Card, Chip, Button, IconButton, Field, Skeleton } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  normalizeMessage,
  normalizeSummary,
  messageBodyText,
  fmtLongDate,
  replySubject,
  MESSAGE_ACTION_RPC,
  errMessage,
} from './inbox-model';

function confirmAsync(title, message, okLabel) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(`${title}\n\n${message}`) : true);
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: okLabel, style: 'destructive', onPress: () => resolve(true) },
    ]);
  });
}

export function MessageDetail({ gateway, accountId, message, onPatched, onRemoved, onAskAgent, onCompose }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [msg, setMsg] = useState(message);
  const [hydrating, setHydrating] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyStatus, setReplyStatus] = useState(null);
  const idRef = useRef(message?.id);

  useEffect(() => {
    idRef.current = message?.id;
    setMsg(message);
    setSummary(null);
    setSummaryError(null);
    setActionError(null);
    setReplyOpen(false);
    setReplyBody('');
    setReplyStatus(null);
    setLoadError(null);
    if (!message?.id || !sendReq) return;
    const id = message.id;
    setHydrating(true);
    (async () => {
      try {
        const res = await sendReq('gmail.get', { accountId: accountId ?? null, messageId: id });
        if (idRef.current !== id) return;
        if (res?.message) setMsg(normalizeMessage(res.message));
        const unread = res?.message ? normalizeMessage(res.message).isUnread : message.isUnread;
        if (unread) {
          await sendReq('gmail.markRead', { accountId: accountId ?? null, messageId: id }).catch(() => {});
          if (idRef.current === id) setMsg((m) => (m ? { ...m, isUnread: false } : m));
          onPatched?.(id, 'read');
        }
      } catch (e) {
        if (idRef.current === id) setLoadError(errMessage(e));
      } finally {
        if (idRef.current === id) setHydrating(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message?.id, accountId, sendReq]);

  if (!msg) return null;

  const summarize = async () => {
    setSummaryBusy(true);
    setSummaryError(null);
    try {
      const r = await sendReq('gmail.summarize', { accountId: accountId ?? null, messageId: msg.id });
      setSummary(normalizeSummary(r));
    } catch (e) {
      setSummaryError(errMessage(e));
    } finally {
      setSummaryBusy(false);
    }
  };

  const act = async (action) => {
    if (action === 'trash') {
      const ok = await confirmAsync('Move to trash?', 'This message moves to the Trash label.', 'Trash');
      if (!ok) return;
    }
    setBusyAction(action);
    setActionError(null);
    try {
      await sendReq(MESSAGE_ACTION_RPC[action], { accountId: accountId ?? null, messageId: msg.id });
      if (action === 'archive' || action === 'trash') {
        onRemoved?.(msg.id, action);
        return;
      }
      setMsg((m) => ({
        ...m,
        isUnread: action === 'unread' ? true : action === 'read' ? false : m.isUnread,
        isStarred: action === 'star' ? true : action === 'unstar' ? false : m.isStarred,
      }));
      onPatched?.(msg.id, action);
    } catch (e) {
      setActionError(errMessage(e));
    } finally {
      setBusyAction(null);
    }
  };

  const sendReply = async () => {
    if (!replyBody.trim()) {
      setReplyStatus({ ok: false, message: 'Write a reply first.' });
      return;
    }
    setReplyBusy(true);
    setReplyStatus(null);
    try {
      await sendReq('gmail.reply', { accountId: accountId ?? null, messageId: msg.id, body: replyBody });
      setReplyStatus({ ok: true, message: 'Reply sent.' });
      setReplyBody('');
      setReplyOpen(false);
    } catch (e) {
      setReplyStatus({ ok: false, message: errMessage(e) });
    } finally {
      setReplyBusy(false);
    }
  };

  const body = messageBodyText(msg);

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      <Text style={[type.display || type.bodyStrong, { color: colors.text, fontSize: 20, lineHeight: 26 }]} selectable>
        {msg.subject || '(No subject)'}
      </Text>
      <View style={{ gap: 2 }}>
        <Text style={[type.small, { color: colors.textSecondary }]} selectable>
          From: {msg.from || '(unknown)'}
        </Text>
        {msg.to ? (
          <Text style={[type.small, { color: colors.textSecondary }]} selectable>
            To: {msg.to}
          </Text>
        ) : null}
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{fmtLongDate(msg.date)}</Text>
      </View>

      <View style={styles.actions}>
        <IconButton
          icon={msg.isStarred ? 'star' : 'star-outline'}
          tone={msg.isStarred ? colors.warning : undefined}
          variant="outline"
          onPress={() => act(msg.isStarred ? 'unstar' : 'star')}
          accessibilityLabel={msg.isStarred ? 'Unstar' : 'Star'}
        />
        <IconButton icon="mail-unread-outline" variant="outline" onPress={() => act('unread')} accessibilityLabel="Mark unread" />
        <IconButton icon="archive-outline" variant="outline" onPress={() => act('archive')} accessibilityLabel="Archive" />
        <IconButton icon="trash-outline" variant="outline" tone={colors.error} onPress={() => act('trash')} accessibilityLabel="Move to trash" />
        <View style={{ flex: 1 }} />
        {busyAction ? <Text style={[type.caption, { color: colors.textMuted }]}>Working…</Text> : null}
      </View>
      {actionError ? <Text style={[type.small, { color: colors.error }]}>{actionError}</Text> : null}

      <View style={styles.actions}>
        <Button title="Reply" icon="arrow-undo-outline" variant="secondary" size="sm" onPress={() => setReplyOpen((o) => !o)} />
        <Button
          title="Forward"
          icon="arrow-redo-outline"
          variant="ghost"
          size="sm"
          onPress={() => onCompose?.({ subject: `Fwd: ${msg.subject || ''}`, body: `\n\n---------- Forwarded message ----------\nFrom: ${msg.from}\nDate: ${msg.date}\nSubject: ${msg.subject}\n\n${body}` })}
        />
        <Button title="Ask agent" icon="sparkles-outline" variant="ghost" size="sm" onPress={() => onAskAgent?.(msg)} />
      </View>

      {replyOpen ? (
        <Card padded tint="primary">
          <Text style={[type.label, { color: colors.textSecondary, marginBottom: SPACE.sm }]}>{replySubject(msg.subject)}</Text>
          <Field
            multiline
            rows={6}
            placeholder="Write your reply…"
            value={replyBody}
            onChangeText={setReplyBody}
            accessibilityLabel="Reply body"
          />
          <View style={[styles.actions, { marginTop: SPACE.sm }]}>
            <Button title="Cancel" variant="ghost" size="sm" onPress={() => setReplyOpen(false)} />
            <View style={{ flex: 1 }} />
            <Button title="Send reply" icon="send" size="sm" loading={replyBusy} onPress={sendReply} />
          </View>
        </Card>
      ) : null}
      {replyStatus ? (
        <Text style={[type.small, { color: replyStatus.ok ? colors.success : colors.error }]}>{replyStatus.message}</Text>
      ) : null}

      {summary ? (
        <Card padded tint="primary">
          <View style={styles.sumHead}>
            <Ionicons name="sparkles" size={16} color={colors.primary} />
            <Text style={[type.bodyStrong, { color: colors.text }]}>AI Summary</Text>
          </View>
          <Text style={[type.body, { color: colors.textSecondary }]} selectable>
            {summary.summary || 'No summary returned.'}
          </Text>
          {summary.actions.length ? (
            <View style={styles.chips}>
              {summary.actions.map((a, i) => (
                <Chip key={`${i}-${a}`} label={a} tone="primary" icon="checkmark-circle-outline" />
              ))}
            </View>
          ) : null}
          {summary.provider ? (
            <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.sm }]}>
              {summary.provider}
              {summary.model ? ` · ${summary.model}` : ''}
            </Text>
          ) : null}
        </Card>
      ) : (
        <View style={{ alignItems: 'flex-start' }}>
          <Button title={summaryBusy ? 'Summarizing…' : 'AI Summarize'} icon="sparkles-outline" loading={summaryBusy} onPress={summarize} />
          {summaryError ? <Text style={[type.small, { color: colors.error, marginTop: SPACE.xs }]}>{summaryError}</Text> : null}
        </View>
      )}

      <View style={[styles.body, { borderColor: withAlpha(colors.text, 0.08), backgroundColor: withAlpha(colors.text, 0.03) }]}>
        {hydrating && !body ? (
          <Skeleton count={5} height={14} gap={8} />
        ) : body ? (
          <Text style={[type.body, { color: colors.text }]} selectable>
            {body}
          </Text>
        ) : msg.snippet ? (
          <Text style={[type.body, { color: colors.textSecondary }]} selectable>
            <Text style={{ fontStyle: 'italic', color: colors.textMuted }}>Preview: </Text>
            {msg.snippet}
          </Text>
        ) : (
          <Text style={[type.body, { color: colors.textMuted }]}>No body content available.</Text>
        )}
        {loadError ? <Text style={[type.small, { color: colors.error, marginTop: SPACE.sm }]}>{loadError}</Text> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, flexWrap: 'wrap' },
  sumHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
  body: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
});

export default MessageDetail;
