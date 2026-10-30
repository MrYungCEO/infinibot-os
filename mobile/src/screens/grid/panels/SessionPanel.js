/**
 * SessionPanel — web <masonry-panel> (a chat session tile) on the phone.
 *
 * Same transport as the Chat tab: useSessionChat → chat.history / chat.send /
 * chat.abort + the gateway `chat` / `agent` broadcasts, rendered with the
 * shared ChatTurn + ChatComposer. The panel's `sessionKey` persists on the
 * layout (web: "grid-session-<ts>" for a fresh panel); "Switch" picks any
 * session from sessions.list, like the web grid's session picker.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ChatComposer } from '../../../chat/ChatComposer';
import { ChatTurn, TranscriptSkeleton } from '../../../chat/ChatTranscript';
import { useSessionChat } from '../../../chat/useSessionChat';
import { BottomSheet, Button, ListRow, SPACE, useUIKit } from '../../../ui-kit';
import { openWebPath } from '../../../navigation/web-link';
import { newSessionKey } from '../grid-model';
import { relTime, sessionRows, shortKey } from '../grid-data';
import { PanelError, PanelLoading, withTimeout } from '../panel-kit';

export function SessionPanel({ panel, gateway, navigation, onPatch, refreshSignal }) {
  const { colors, type } = useUIKit();
  const sessionKey = panel.sessionKey || '';
  const chat = useSessionChat(gateway, sessionKey);
  const listRef = useRef(null);
  const [picker, setPicker] = useState(false);
  const [sessions, setSessions] = useState(null);
  const [pickErr, setPickErr] = useState(null);

  useEffect(() => { if (refreshSignal) chat.refresh(); }, [refreshSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = chat.turns[chat.turns.length - 1];
  const tail = `${chat.turns.length}:${last?.blocks?.length || 0}:${last?.blocks?.[last.blocks.length - 1]?.text?.length || 0}`;
  useEffect(() => {
    const id = setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [tail]);

  const openPicker = useCallback(async () => {
    setPicker(true);
    setPickErr(null);
    try {
      const res = await withTimeout(gateway.sendReq('sessions.list', { limit: 60, includeDerivedTitles: true }), 15000, 'sessions.list');
      setSessions(sessionRows(res));
    } catch (err) {
      setPickErr(String(err?.message || err));
    }
  }, [gateway]);

  const pick = useCallback((key, title) => {
    onPatch({ sessionKey: key, ...(title ? { title } : {}) });
    setPicker(false);
  }, [onPatch]);

  const openLink = useCallback((link, title) => {
    const path = link?.path || (link?.tab ? `/${link.tab}` : null);
    if (path) openWebPath(navigation, path, title || link.label, { gateway });
  }, [navigation, gateway]);

  const renderItem = useCallback(({ item }) => (
    <ChatTurn turn={item} agentName="InfiniBot" sendReq={gateway?.sendReq} onOpenLink={openLink} />
  ), [gateway?.sendReq, openLink]);

  let body;
  if (chat.loading && chat.turns.length === 0) body = <View style={styles.pad}><TranscriptSkeleton /></View>;
  else if (chat.error && chat.turns.length === 0) body = <PanelError message={chat.error} onRetry={() => chat.refresh()} />;
  else if (chat.turns.length === 0) {
    body = (
      <View style={styles.empty}>
        <Ionicons name="chatbubbles-outline" size={26} color={colors.textMuted} />
        <Text style={[type.bodyStrong, { color: colors.text }]}>New conversation</Text>
        <Text style={[type.caption, { color: colors.textMuted, textAlign: 'center' }]}>Messages go to {shortKey(sessionKey)}. Switch to continue another session.</Text>
      </View>
    );
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={chat.turns}
        keyExtractor={(t) => t.id}
        renderItem={renderItem}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
        ListFooterComponent={chat.live.error ? <Text style={[type.caption, { color: colors.error }]}>{chat.live.error}</Text> : null}
      />
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.bar, { borderBottomColor: colors.borderSubtle }]}>
        <View style={[styles.dot, { backgroundColor: chat.isStreaming ? colors.primary : chat.connected ? colors.success : colors.textMuted }]} />
        <Text style={[type.monoSmall, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>{chat.isStreaming ? 'replying...' : shortKey(sessionKey)}</Text>
        <Pressable onPress={openPicker} hitSlop={10} style={styles.barBtn} accessibilityRole="button" accessibilityLabel="Switch session">
          <Ionicons name="swap-horizontal-outline" size={15} color={colors.primary} />
          <Text style={[type.caption, { color: colors.primary }]}>Switch</Text>
        </Pressable>
      </View>
      <View style={styles.flex}>{body}</View>
      <View style={styles.composer}>
        <ChatComposer onSend={chat.send} onAbort={chat.abort} isStreaming={chat.isStreaming} disabled={!chat.connected} placeholder="Message this session" />
      </View>

      <BottomSheet visible={picker} onClose={() => setPicker(false)} title="Chat session" subtitle="Continue any session, or start a new one">
        <Button title="New session" icon="add" variant="secondary" onPress={() => pick(newSessionKey(), 'Chat Session')} style={{ marginBottom: SPACE.sm }} />
        {pickErr ? <PanelError message={pickErr} onRetry={openPicker} /> : !sessions ? <PanelLoading rows={4} /> : sessions.map((s) => (
          <ListRow
            key={s.key}
            icon="chatbubble-ellipses-outline"
            title={s.title}
            subtitle={shortKey(s.key)}
            value={relTime(s.updatedAt)}
            selected={s.key === sessionKey}
            onPress={() => pick(s.key, s.title)}
            dense
            accessibilityLabel={`Open session ${s.title}`}
          />
        ))}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.md },
  list: { paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.sm },
  bar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 36, borderBottomWidth: StyleSheet.hairlineWidth },
  barBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, padding: SPACE.lg },
  composer: { paddingHorizontal: SPACE.sm, paddingBottom: SPACE.sm, paddingTop: SPACE.xs },
});
