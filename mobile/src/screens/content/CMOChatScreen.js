// CMOChatScreen — chat with the CMO agent (roster id "cmo": growth strategy and
// script generation grounded in your reel data).
//
// It is the SAME thread as the web's CMO chat: both use the gateway session
// `agent:cmo:cmo-chat` (ui/src/ui/components/agent-chat-state.ts), so a
// question asked on the web is here too, and replies stream to both. Rendering
// and transport are the shared chat pieces (src/chat) — same look as the Chat
// tab and the web chat.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatComposer } from '../../chat/ChatComposer';
import { BrandAvatar, ChatLinkHandler, ChatTurn, TranscriptSkeleton } from '../../chat/ChatTranscript';
import { useChatTokens } from '../../chat/chat-tokens';
import { useSessionChat } from '../../chat/useSessionChat';
import { tap } from '../../utils/haptics';
import { openWebPath } from '../../navigation/web-link';

export const CMO_SESSION_KEY = 'agent:cmo:cmo-chat';

const SUGGESTIONS = [
  'Why do my winning reels win? Pull the data.',
  'What should I kill, and what should I do more of?',
  'Write me a script for my next reel based on my top performers.',
  'Diagnose my worst 5 reels — what went wrong?',
];

export function CMOChatScreen({ gateway, navigation, route }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const chat = useSessionChat(gateway, CMO_SESSION_KEY);
  const seed = route?.params?.seed || '';
  const seededRef = useRef(false);
  const listRef = useRef(null);
  const [composerHeight, setComposerHeight] = useState(56);

  // Auto-send a prompt handed in from Content Intelligence.
  useEffect(() => {
    if (seed && chat.connected && !chat.loading && !seededRef.current) {
      seededRef.current = true;
      chat.send(seed);
    }
  }, [seed, chat.connected, chat.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = chat.turns[chat.turns.length - 1];
  const tail = `${chat.turns.length}:${last?.blocks?.length || 0}:${last?.blocks?.[last.blocks.length - 1]?.text?.length || 0}`;
  useEffect(() => {
    const id = setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [tail]);

  // Reel links open the reel in Content Intelligence instead of the browser.
  const onLinkPress = useCallback((url) => {
    const m = /instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/.exec(url || '');
    if (m) {
      navigation?.navigate?.('ContentIntelModal', { openShortcode: m[1] });
      return false;
    }
    return true;
  }, [navigation]);

  const openLink = useCallback((link, title) => {
    const path = link.path || (link.tab ? `/${link.tab}` : null);
    if (path) openWebPath(navigation, path, title || link.label);
  }, [navigation]);

  const renderItem = useCallback(({ item }) => (
    <ChatTurn turn={item} agentName="CMO" sendReq={gateway?.sendReq} onOpenLink={openLink} />
  ), [gateway?.sendReq, openLink]);

  let body;
  if (chat.loading && chat.turns.length === 0) {
    body = <View style={styles.pad}><TranscriptSkeleton /></View>;
  } else if (chat.error && chat.turns.length === 0) {
    body = (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={28} color={t.muted} />
        <Text style={[styles.centerTitle, { color: t.text }]}>Couldn't load the CMO chat</Text>
        <Text style={[styles.centerText, { color: t.muted }]}>{chat.error}</Text>
        <Pressable onPress={() => chat.refresh()} style={[styles.retry, { borderColor: t.borderStrong }]} accessibilityRole="button">
          <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 13 }}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (chat.turns.length === 0) {
    body = (
      <View style={styles.center}>
        <BrandAvatar size={52} />
        <Text style={[styles.hero, { color: t.textStrong, fontFamily: t.font.bold }]}>Ask your CMO</Text>
        <Text style={[styles.centerText, { color: t.muted }]}>Answers are grounded in your reel library. This is the same thread as the CMO chat on the web.</Text>
        <View style={styles.suggest}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s}
              disabled={!chat.connected}
              onPress={() => { tap(); chat.send(s); }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.suggestItem, { borderColor: t.border, backgroundColor: pressed ? t.surfaceStrong : t.surface, borderRadius: t.radius.panel, opacity: chat.connected ? 1 : 0.5 }]}
            >
              <Ionicons name="sparkles-outline" size={14} color={t.accent} />
              <Text style={{ color: t.text, fontSize: 13, lineHeight: 18, flex: 1 }}>{s}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={chat.turns}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 14, paddingTop: 16, paddingBottom: composerHeight + insets.bottom + 28 }}
        ListFooterComponent={
          chat.live.error ? (
            <Text style={[styles.error, { color: t.danger, backgroundColor: t.dangerSubtle, borderColor: t.danger }]}>{chat.live.error}</Text>
          ) : null
        }
      />
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: t.bg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[styles.header, { borderBottomColor: t.borderNeutral }]}>
        <Pressable onPress={() => navigation?.goBack?.()} hitSlop={6} style={styles.back} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={t.accent} />
        </Pressable>
        <View style={styles.titles}>
          <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 17 }} accessibilityRole="header">CMO</Text>
          <Text numberOfLines={1} style={{ color: chat.isStreaming ? t.accent : t.muted, fontSize: 12 }}>
            {chat.isStreaming ? 'replying…' : chat.connected ? 'Growth strategy, grounded in your reel data' : 'Offline'}
          </Text>
        </View>
      </View>
      <ChatLinkHandler value={onLinkPress}>
        <View style={styles.flex}>{body}</View>
      </ChatLinkHandler>
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10), backgroundColor: t.bg }]}>
        <ChatComposer
          onSend={chat.send}
          onAbort={chat.abort}
          isStreaming={chat.isStreaming}
          disabled={!chat.connected}
          placeholder="Ask the CMO"
          onHeightChange={setComposerHeight}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: 16 },
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titles: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  centerTitle: { fontSize: 16, fontWeight: '600', marginTop: 6 },
  centerText: { fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
  hero: { fontSize: 20, marginTop: 10 },
  retry: { marginTop: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, minHeight: 40, justifyContent: 'center' },
  suggest: { alignSelf: 'stretch', gap: 8, marginTop: 16 },
  suggestItem: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, paddingHorizontal: 12, minHeight: 48, paddingVertical: 10 },
  error: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, overflow: 'hidden' },
  composer: { paddingHorizontal: 12, paddingTop: 6 },
});

export default CMOChatScreen;
