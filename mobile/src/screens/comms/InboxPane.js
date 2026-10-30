/**
 * InboxPane — the "Inbox" sub-tab of Channels (web /comms, comms-hub.ts):
 * cross-channel thread list (channel + assignment filters, channel readiness
 * chips, pending-approval count), conversation with draft approve/reject, and
 * the reply composer (channel picker + text).
 *
 * RPCs: comms.channels.status · comms.threads.list · comms.thread.get ·
 *       comms.send · comms.draft.approve · comms.draft.reject
 * Live: comms:updated → reload list (+ open thread).
 * Phone: list ↔ conversation. Wide (landscape/tablet): side by side.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, RefreshControl, Pressable, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Chip, Button, IconButton, EmptyState, SkeletonRow, Divider, useUIKit, SPACE, RADIUS, MONO_FAMILY } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  ALL_COMMS_CHANNELS,
  ASSIGNMENT_FILTERS,
  commsChannelMeta,
  threadsListParams,
  normalizeThreads,
  threadTitle,
  threadFromMessages,
  fmtTime,
  messageFlags,
  buildSendParams,
  isCommsChannelConfigured,
  isUnknownMethod,
} from './comms-model';

function ChannelBadge({ channel, size = 22 }) {
  const m = commsChannelMeta(channel);
  return (
    <View style={[st.badge, { width: size, height: size, borderColor: withAlpha(m.color, 0.45), backgroundColor: withAlpha(m.color, 0.14) }]} accessibilityLabel={m.label}>
      <Ionicons name={m.icon} size={size * 0.6} color={m.color} />
    </View>
  );
}

export function InboxPane({ gateway, initialThreadId, initialChannelFilter = 'all', wide, compact, onPendingChange, onToast }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [channels, setChannels] = useState([]);
  const [threads, setThreads] = useState(null);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [channelFilter, setChannelFilter] = useState(initialChannelFilter || 'all');
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [selectedKey, setSelectedKey] = useState(initialThreadId || null);
  const [messages, setMessages] = useState([]);
  const [threadMeta, setThreadMeta] = useState(null); // deep-linked thread not in list
  const [threadLoading, setThreadLoading] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeChannel, setComposeChannel] = useState(null);
  const [sending, setSending] = useState(false);
  const [composeError, setComposeError] = useState(null);
  const [busyDraft, setBusyDraft] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedRef = useRef(selectedKey);
  selectedRef.current = selectedKey;
  const scrollRef = useRef(null);

  const loadChannels = useCallback(async () => {
    if (!sendReq) return;
    try {
      const res = await sendReq('comms.channels.status', {});
      setChannels(Array.isArray(res?.channels) ? res.channels : []);
    } catch (e) {
      if (isUnknownMethod(e)) setUnavailable(true);
    }
  }, [sendReq]);

  const loadThreads = useCallback(async () => {
    if (!sendReq) return;
    setLoading(true);
    try {
      const res = await sendReq('comms.threads.list', threadsListParams(channelFilter, assignmentFilter));
      const n = normalizeThreads(res);
      setThreads(n.threads);
      setPending(n.pendingApprovals);
      onPendingChange?.(n.pendingApprovals);
      setError(null);
      setUnavailable(false);
    } catch (e) {
      if (isUnknownMethod(e)) setUnavailable(true);
      else setError(e?.message || String(e));
      setThreads((prev) => prev || []);
    } finally {
      setLoading(false);
    }
  }, [sendReq, channelFilter, assignmentFilter, onPendingChange]);

  const openThread = useCallback(async (threadKey, { quiet } = {}) => {
    if (!sendReq || !threadKey) return;
    setSelectedKey(threadKey);
    if (!quiet) setThreadLoading(true);
    try {
      const res = await sendReq('comms.thread.get', { threadKey });
      if (selectedRef.current !== threadKey) return;
      const msgs = Array.isArray(res?.messages) ? res.messages : [];
      setMessages(msgs);
      setThreadMeta(threadFromMessages(threadKey, msgs));
      setComposeError(null);
    } catch (e) {
      setComposeError(e?.message || String(e));
    } finally {
      setThreadLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    if (!connected) return;
    loadChannels();
    loadThreads();
  }, [connected, loadChannels, loadThreads]);

  useEffect(() => {
    if (connected && initialThreadId) openThread(initialThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, initialThreadId]);

  useEffect(() => {
    if (typeof gateway?.subscribeEvent !== 'function') return undefined;
    return gateway.subscribeEvent('comms:updated', () => {
      loadThreads();
      if (selectedRef.current) openThread(selectedRef.current, { quiet: true });
    });
  }, [gateway?.subscribeEvent, loadThreads, openThread]);

  const listThread = (threads || []).find((t) => t.threadKey === selectedKey) || null;
  const thread = listThread || (selectedKey ? threadMeta : null);

  // Compose channel follows the opened thread (web openThread).
  useEffect(() => {
    if (thread?.channel) setComposeChannel(thread.channel);
  }, [thread?.threadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    await Promise.all([loadChannels(), loadThreads()]);
    if (selectedKey) await openThread(selectedKey, { quiet: true });
  };

  const send = async () => {
    const params = buildSendParams(thread, composeChannel || thread?.channel, composeText);
    if (!params || sending) return;
    setSending(true);
    try {
      await sendReq('comms.send', params);
      setComposeText('');
      setComposeError(null);
      await openThread(thread.threadKey, { quiet: true });
      await loadThreads();
    } catch (e) {
      setComposeError(e?.message || String(e));
    } finally {
      setSending(false);
    }
  };

  const draft = async (messageId, action) => {
    setBusyDraft(`${messageId}:${action}`);
    try {
      await sendReq(action === 'approve' ? 'comms.draft.approve' : 'comms.draft.reject', { messageId });
      onToast?.({ kind: 'ok', message: action === 'approve' ? 'Draft approved and sent' : 'Draft rejected' });
      if (selectedRef.current) await openThread(selectedRef.current, { quiet: true });
      await loadThreads();
    } catch (e) {
      setComposeError(e?.message || String(e));
    } finally {
      setBusyDraft(null);
    }
  };

  const muted = [type.caption, { color: colors.textMuted }];

  if (unavailable) {
    return (
      <View style={{ flex: 1, padding: SPACE.lg }}>
        <EmptyState
          icon="mail-unread-outline"
          title="Inbox not available on this gateway"
          message="This InfiniBot does not serve the comms.* inbox yet. Update or restart the gateway, then pull to refresh."
          actionLabel="Retry"
          onAction={() => { setUnavailable(false); refresh(); }}
        />
      </View>
    );
  }

  // ── thread list ──────────────────────────────────────────────────────────
  const listPane = (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: SPACE.lg, paddingBottom: SPACE.xxl, gap: SPACE.sm }}
      refreshControl={<RefreshControl refreshing={loading && threads != null} onRefresh={refresh} tintColor={colors.primary} colors={[colors.primary]} />}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[st.rowBetween, { minHeight: 28 }]}>
        <Text style={[type.label, { color: colors.textMuted }]}>THREADS</Text>
        {pending > 0 ? <Chip size="sm" tone="primary" label={`${pending} to approve`} /> : null}
      </View>

      {channels.length ? (
        <View style={st.wrap}>
          {channels.map((c) => {
            const m = commsChannelMeta(c.channel);
            const ok = c.configured && c.enabled;
            return (
              <Chip
                key={c.channel}
                size="sm"
                icon={m.icon}
                color={ok ? m.color : undefined}
                tone={ok ? undefined : 'neutral'}
                label={`${m.label}${ok ? '' : ' · setup'}`}
                onPress={c.setupNotes ? () => onToast?.({ kind: 'info', message: c.setupNotes }) : undefined}
                accessibilityLabel={`${m.label} ${ok ? 'ready' : 'needs setup'}`}
              />
            );
          })}
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipsRow}>
        {ASSIGNMENT_FILTERS.map((f) => (
          <Chip key={f.key} size="sm" label={f.label} selected={assignmentFilter === f.key} tone={assignmentFilter === f.key ? 'primary' : 'neutral'} onPress={() => setAssignmentFilter(f.key)} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipsRow}>
        <Chip size="sm" label="All channels" selected={channelFilter === 'all'} tone={channelFilter === 'all' ? 'primary' : 'neutral'} onPress={() => setChannelFilter('all')} />
        {ALL_COMMS_CHANNELS.map((c) => (
          <Chip key={c} size="sm" icon={commsChannelMeta(c).icon} label={commsChannelMeta(c).label} selected={channelFilter === c} tone={channelFilter === c ? 'primary' : 'neutral'} onPress={() => setChannelFilter(c)} />
        ))}
      </ScrollView>

      {error ? (
        <EmptyState compact tone="danger" icon="alert-circle-outline" title="Couldn't load threads" message={error} actionLabel="Retry" onAction={refresh} />
      ) : threads == null ? (
        <View style={{ gap: SPACE.sm }}><SkeletonRow avatar /><SkeletonRow avatar /><SkeletonRow avatar /></View>
      ) : threads.length === 0 ? (
        <EmptyState icon="chatbubbles-outline" title="No conversations yet" message="Inbound client messages will appear here once a channel is wired." />
      ) : (
        threads.map((t) => {
          const active = t.threadKey === selectedKey;
          return (
            <Pressable
              key={t.threadKey}
              onPress={() => openThread(t.threadKey)}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation with ${threadTitle(t)}`}
              style={({ pressed }) => [st.threadRow, {
                borderColor: active ? colors.primary : colors.border,
                backgroundColor: active ? withAlpha(colors.primary, 0.08) : colors.surface,
                opacity: pressed ? 0.85 : 1,
              }]}
            >
              <View style={st.rowCenter}>
                <ChannelBadge channel={t.channel} />
                <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{threadTitle(t)}</Text>
                {t.unreadCount > 0 ? <Chip size="sm" tone="primary" solid label={String(t.unreadCount)} /> : null}
                <Text style={[muted, { fontFamily: MONO_FAMILY }]}>{fmtTime(t.lastMessageAt)}</Text>
              </View>
              <View style={st.rowCenter}>
                {t.lastDirection === 'outbound' ? <Ionicons name="arrow-redo-outline" size={13} color={colors.textMuted} /> : null}
                <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>{t.lastMessagePreview || '—'}</Text>
              </View>
              {t.assignedAgentId ? (
                <View style={st.rowCenter}>
                  <Ionicons name="person-outline" size={12} color={colors.textMuted} />
                  <Text style={muted}>{t.assignedAgentId}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );

  // ── conversation ─────────────────────────────────────────────────────────
  const configuredForThread = thread ? isCommsChannelConfigured(channels, thread.channel) : false;
  const canSend = Boolean(composeText.trim()) && !sending;

  const conversation = thread ? (
    <View style={{ flex: 1 }}>
      <View style={[st.convHead, { borderBottomColor: colors.border }]}>
        {!wide ? (
          <IconButton icon="chevron-back" accessibilityLabel="Back to threads" onPress={() => { setSelectedKey(null); setMessages([]); setThreadMeta(null); }} />
        ) : null}
        <ChannelBadge channel={thread.channel} size={28} />
        <View style={{ flex: 1 }}>
          <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>{threadTitle(thread)}</Text>
          <Text style={muted} numberOfLines={1}>{commsChannelMeta(thread.channel).label} · {thread.peerHandle}</Text>
        </View>
        {thread.assignedAgentId ? <Chip size="sm" icon="person-outline" label={thread.assignedAgentId} /> : null}
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.md }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd?.({ animated: false })}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => openThread(thread.threadKey, { quiet: true })} tintColor={colors.primary} />}
      >
        {threadLoading && !messages.length ? <SkeletonRow /> : messages.length === 0 ? (
          <Text style={muted}>No messages in this thread yet.</Text>
        ) : messages.map((m) => {
          const f = messageFlags(m);
          return (
            <View key={m.id} style={{ alignItems: f.outbound ? 'flex-end' : 'flex-start', gap: SPACE.xs }}>
              <View style={[st.bubble, {
                borderColor: f.failed ? withAlpha(colors.error, 0.6) : f.pending ? colors.primary : f.outbound ? withAlpha(colors.primary, 0.35) : colors.border,
                backgroundColor: f.outbound ? withAlpha(colors.primary, 0.1) : colors.surface,
                borderStyle: f.pending ? 'dashed' : 'solid',
              }]}>
                <Text selectable style={[type.body, { color: colors.text }]}>{m.text}</Text>
                {Array.isArray(m.mediaUrls) && m.mediaUrls.length ? (
                  <Text style={muted}>{m.mediaUrls.length} attachment{m.mediaUrls.length === 1 ? '' : 's'}</Text>
                ) : null}
                {f.failed && m.error ? (
                  <View style={st.rowCenter}>
                    <Ionicons name="alert-circle-outline" size={13} color={colors.error} />
                    <Text style={[type.caption, { color: colors.error, flex: 1 }]}>{m.error}</Text>
                  </View>
                ) : null}
              </View>
              <View style={st.rowCenter}>
                <Text style={[muted, { fontFamily: MONO_FAMILY }]}>{fmtTime(m.createdAt)}</Text>
                {m.sentByAgentId ? <Text style={muted}>· {m.sentByAgentId}</Text> : null}
                {f.pending ? <Text style={[type.caption, { color: colors.primary }]}>pending approval</Text> : null}
                {f.sent ? <Text style={muted}>sent</Text> : null}
                {m.autonomyDecision?.outcome ? <Text style={muted}>· {m.autonomyDecision.outcome}</Text> : null}
              </View>
              {f.pending ? (
                <View style={st.row}>
                  <Button title="Approve & send" size="sm" variant="primary" loading={busyDraft === `${m.id}:approve`} disabled={Boolean(busyDraft)} onPress={() => draft(m.id, 'approve')} />
                  <Button title="Reject" size="sm" variant="danger" loading={busyDraft === `${m.id}:reject`} disabled={Boolean(busyDraft)} onPress={() => draft(m.id, 'reject')} />
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>

      <View style={[st.composer, { borderTopColor: colors.border }]}>
        {composeError ? <Text style={[type.caption, { color: colors.error }]}>{composeError}</Text> : null}
        {!configuredForThread ? (
          <Text style={[type.caption, { color: colors.primary }]}>{commsChannelMeta(thread.channel).label} is not configured — replies will fail until setup.</Text>
        ) : null}
        {!compact || pickerOpen ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipsRow}>
            {ALL_COMMS_CHANNELS.map((c) => {
              const on = (composeChannel || thread.channel) === c;
              return <Chip key={c} size="sm" icon={commsChannelMeta(c).icon} label={commsChannelMeta(c).label} selected={on} tone={on ? 'primary' : 'neutral'} onPress={() => { setComposeChannel(c); setPickerOpen(false); }} accessibilityLabel={`Reply via ${commsChannelMeta(c).label}`} />;
            })}
          </ScrollView>
        ) : null}
        <View style={st.composeRow}>
          {compact && !pickerOpen ? (
            <IconButton icon={commsChannelMeta(composeChannel || thread.channel).icon} variant="outline" onPress={() => setPickerOpen(true)} accessibilityLabel={`Reply via ${commsChannelMeta(composeChannel || thread.channel).label}. Change channel`} />
          ) : null}
          <TextInput
            value={composeText}
            onChangeText={setComposeText}
            placeholder={`Reply to ${thread.clientName ?? thread.peerHandle}…`}
            placeholderTextColor={colors.textMuted}
            multiline
            style={[st.input, type.body, { color: colors.text, borderColor: colors.border, backgroundColor: colors.inputBg || colors.surface }]}
            accessibilityLabel="Reply text"
          />
          <IconButton icon="send" variant="solid" tone="primary" loading={sending} disabled={!canSend} onPress={send} accessibilityLabel="Send reply" />
        </View>
      </View>
    </View>
  ) : (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.lg }}>
      <Text style={muted}>{threadLoading ? 'Opening…' : 'Select a conversation'}</Text>
    </View>
  );

  if (wide) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <View style={{ width: 340, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border }}>{listPane}</View>
        <View style={{ flex: 1 }}>{conversation}</View>
      </View>
    );
  }
  return selectedKey ? conversation : listPane;
}

const st = StyleSheet.create({
  badge: { borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  chipsRow: { gap: SPACE.sm, paddingVertical: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  threadRow: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs, minHeight: 44 },
  convHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  bubble: { maxWidth: '86%', borderWidth: 1, borderRadius: RADIUS.lg, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: SPACE.xs },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: SPACE.md, gap: SPACE.sm },
  composeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.sm },
  input: { flex: 1, minHeight: 44, maxHeight: 140, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
});

export default InboxPane;
