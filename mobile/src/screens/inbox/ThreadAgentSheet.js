/**
 * ThreadAgentSheet — the web <doc-agent-panel docType="inbox_thread"> that
 * docks beside an open thread: doc_agent.spawn gives a per-thread session key
 * + system prompt, chat.history restores the conversation, session.send
 * posts a turn (the first turn carries the instructions block, as on web),
 * and `chat` events stream deltas / final for that session.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';

import { useUIKit, SPACE, RADIUS, BottomSheet, Button, Field } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { normalizeHistory, extractChatText, composeAgentMessage, errMessage, isUnknownMethod } from './inbox-model';

export function ThreadAgentSheet({ visible, onClose, gateway, context }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const [session, setSession] = useState(null); // { sessionKey, systemPrompt, model }
  const [messages, setMessages] = useState([]);
  const [streaming, setStreaming] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [spawning, setSpawning] = useState(false);
  const keyRef = useRef(null);
  const scrollRef = useRef(null);

  const loadHistory = async (sessionKey) => {
    try {
      const h = await sendReq('chat.history', { sessionKey, limit: 100 });
      if (keyRef.current === sessionKey) setMessages(normalizeHistory(h));
    } catch {
      /* fresh session */
    }
  };

  useEffect(() => {
    if (!visible || !context?.documentId || !sendReq) return undefined;
    let cancelled = false;
    setSession(null);
    setMessages([]);
    setStreaming(null);
    setError(null);
    setSending(false);
    keyRef.current = null;
    setSpawning(true);
    (async () => {
      try {
        const r = await sendReq('doc_agent.spawn', {
          docType: context.docType,
          documentId: context.documentId,
          title: context.title,
          extra: context.extra,
        });
        if (cancelled) return;
        keyRef.current = r?.sessionKey || null;
        setSession({ sessionKey: r?.sessionKey, systemPrompt: r?.systemPrompt || '', model: r?.model || null });
        sendReq('doc_agent.set_modalities', {
          sessionKey: r?.sessionKey,
          docType: context.docType,
          modalities: { sidePanel: true, voice: false, liveActionObserve: false, liveActionAct: false },
        }).catch(() => {});
        if (r?.sessionKey) await loadHistory(r.sessionKey);
      } catch (e) {
        if (!cancelled) setError(isUnknownMethod(e) ? 'The thread agent is not available on this gateway.' : errMessage(e));
      } finally {
        if (!cancelled) setSpawning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, context?.documentId, sendReq]);

  useEffect(() => {
    if (!visible || typeof gateway?.subscribeEvent !== 'function') return undefined;
    return gateway.subscribeEvent('chat', (payload) => {
      if (!payload || payload.sessionKey !== keyRef.current) return;
      const st = payload.state;
      if (st === 'delta') {
        const t = extractChatText(payload.message);
        if (t) setStreaming((cur) => (!cur || t.length >= cur.length ? t : cur));
      } else if (st === 'final') {
        setStreaming(null);
        setSending(false);
        loadHistory(keyRef.current);
      } else if (st === 'aborted') {
        setStreaming(null);
        setSending(false);
      } else if (st === 'error') {
        setStreaming(null);
        setSending(false);
        setError(payload.errorMessage || 'Agent error');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, gateway?.subscribeEvent]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 50);
    return () => clearTimeout(t);
  }, [messages.length, streaming]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !session?.sessionKey) return;
    const isFirst = !messages.some((m) => m.role === 'user');
    setSending(true);
    setError(null);
    setMessages((m) => [...m, { key: `local-${Date.now()}`, role: 'user', text, ts: Date.now() }]);
    setDraft('');
    try {
      await sendReq('session.send', {
        sessionKey: session.sessionKey,
        message: composeAgentMessage(text, session.systemPrompt, isFirst),
      });
    } catch (e) {
      setSending(false);
      setError(errMessage(e));
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Thread agent"
      subtitle={context?.title || undefined}
      maxHeightRatio={0.92}
      scroll={false}
      footer={
        <View style={styles.composer}>
          <Field
            style={{ flex: 1 }}
            placeholder={session ? 'Ask about this thread…' : 'Starting agent…'}
            value={draft}
            onChangeText={setDraft}
            multiline
            rows={2}
            disabled={!session}
            accessibilityLabel="Message the thread agent"
          />
          <Button title="Send" icon="send" size="sm" loading={sending} disabled={!session || !draft.trim()} onPress={send} />
        </View>
      }
    >
      <ScrollView ref={scrollRef} style={{ maxHeight: 520 }} contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
        {spawning ? <ActivityIndicator color={colors.primary} style={{ marginTop: SPACE.lg }} /> : null}
        {!spawning && session && !messages.length && !streaming ? (
          <Text style={[type.small, { color: colors.textMuted }]}>
            Ask the agent to summarize, draft a reply, extract tasks, or explain this thread.
            {session.model ? ` Model: ${session.model}.` : ''}
          </Text>
        ) : null}
        {messages.map((m) => (
          <View
            key={m.key}
            style={[
              styles.bubble,
              m.role === 'user'
                ? { alignSelf: 'flex-end', backgroundColor: withAlpha(colors.primary, 0.12), borderColor: withAlpha(colors.primary, 0.35) }
                : { alignSelf: 'flex-start', backgroundColor: withAlpha(colors.text, 0.04), borderColor: withAlpha(colors.text, 0.08) },
            ]}
          >
            <Text style={[type.body, { color: colors.text }]} selectable>
              {m.text}
            </Text>
          </View>
        ))}
        {streaming ? (
          <View style={[styles.bubble, { alignSelf: 'flex-start', backgroundColor: withAlpha(colors.text, 0.04), borderColor: withAlpha(colors.text, 0.08) }]}>
            <Text style={[type.body, { color: colors.textSecondary }]}>{streaming}</Text>
          </View>
        ) : sending ? (
          <Text style={[type.caption, { color: colors.textMuted }]}>Agent is thinking…</Text>
        ) : null}
        {error ? <Text style={[type.small, { color: colors.error }]}>{error}</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.sm },
  bubble: { maxWidth: '88%', padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
});

export default ThreadAgentSheet;
