/**
 * KgAiDrawer — direct chat with the graph selection (port of the web
 * <kg-ai-drawer>). "Chat with this", "Summarize", "Find related" and the AI
 * half of "Consolidate" open a real agent session scoped to the selection
 * (`doc_agent.spawn`, docType "generic", the selection's context as the
 * document), send the opening prompt with `chat.send`, and stream the reply
 * from the gateway's `chat` events. "Open in Chat" hands the session to the
 * app's Chat tab. Nothing is simulated.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';

import { INTENT_LABEL, createAiSession } from './kg-ai-session';
import { KG, kgSheet, kgStyles } from './kg-theme';
import { rgba } from './kg-colors';

export function KgAiDrawer({ c, gateway, onOpenChat, style }) {
  const req = c.ai;
  const [st, setSt] = useState(null);
  const [draft, setDraft] = useState('');
  const sessionRef = useRef(null);
  const scrollRef = useRef(null);
  if (!sessionRef.current) {
    sessionRef.current = createAiSession(
      { request: (m, p) => gateway.sendReq(m, p), subscribe: (e, fn) => gateway.subscribeEvent?.(e, fn) },
      (next) => setSt(next),
    );
  }
  useEffect(() => () => sessionRef.current?.dispose(), []);
  useEffect(() => {
    if (req) void sessionRef.current.start(req);
  }, [req?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scrollRef.current?.scrollToEnd?.({ animated: true });
  }, [st?.messages.length, st?.streaming]);
  const submit = useCallback(() => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    void sessionRef.current.send(t);
  }, [draft]);
  if (!req) return null;
  const s = st || sessionRef.current.state;
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.wrap, style]} pointerEvents="box-none">
      <View style={[kgStyles.panel, styles.drawer]} testID="kg-ai-drawer">
        <View style={styles.head}>
          <Ionicons name="sparkles" size={15} color={KG.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={1}>{INTENT_LABEL[req.intent]} · {req.title}</Text>
            <Text style={styles.sub}>{req.count} item{req.count === 1 ? '' : 's'} in context</Text>
          </View>
          <Pressable onPress={() => s.sessionKey && onOpenChat?.(s.sessionKey)} disabled={!s.sessionKey} hitSlop={8} style={styles.icon} accessibilityLabel="Open in Chat" testID="kg-ai-open-chat">
            <Ionicons name="open-outline" size={18} color={s.sessionKey ? KG.goldSoft : KG.dimmer} />
          </Pressable>
          <Pressable onPress={() => c.closeAi()} hitSlop={8} style={styles.icon} accessibilityLabel="Close" testID="kg-ai-close">
            <Ionicons name="close" size={20} color={KG.dim} />
          </Pressable>
        </View>
        <View style={styles.chips}>
          {[['summarize', 'document-text-outline', 'Summarize'], ['related', 'git-network-outline', 'Find related'], ['consolidate', 'layers-outline', 'Merge plan']].map(([intent, icon, label]) => (
            <Pressable
              key={intent}
              onPress={() => sessionRef.current.quick(intent)}
              disabled={s.busy || !s.sessionKey || (intent === 'consolidate' && req.count < 2)}
              style={[styles.chip, (s.busy || !s.sessionKey || (intent === 'consolidate' && req.count < 2)) && { opacity: 0.4 }]}
            >
              <Ionicons name={icon} size={13} color={KG.cyan} />
              <Text style={styles.chipText}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <ScrollView ref={scrollRef} style={styles.log} contentContainerStyle={{ gap: 8, paddingBottom: 6 }}>
          {!s.sessionKey && !s.error ? <Text style={kgStyles.muted}>Opening a session…</Text> : null}
          {s.messages.map((m, i) => (
            <View key={i} style={[styles.msg, m.role === 'user' ? styles.user : styles.asst]}>
              {m.role === 'user' ? (
                <Text style={styles.userText}>{m.label || m.text}</Text>
              ) : (
                <Markdown style={md}>{m.text}</Markdown>
              )}
            </View>
          ))}
          {s.streaming ? (
            <View style={[styles.msg, styles.asst]}>
              <Markdown style={md}>{s.streaming}</Markdown>
            </View>
          ) : s.busy ? (
            <View style={styles.thinking}>
              <ActivityIndicator size="small" color={KG.cyan} />
              <Text style={kgStyles.muted}>Thinking…</Text>
            </View>
          ) : null}
          {s.error ? <Text style={styles.err}>{s.error}</Text> : null}
        </ScrollView>
        <View style={styles.compose}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask about the selection…"
            placeholderTextColor={KG.dimmer}
            style={[kgStyles.input, { flex: 1 }]}
            editable={!!s.sessionKey}
            onSubmitEditing={submit}
            returnKeyType="send"
            testID="kg-ai-input"
          />
          {s.busy ? (
            <Pressable onPress={() => void sessionRef.current.abort()} style={styles.send} accessibilityLabel="Stop">
              <Ionicons name="stop" size={16} color="#fff3cf" />
            </Pressable>
          ) : (
            <Pressable onPress={submit} disabled={!draft.trim() || !s.sessionKey} style={[styles.send, (!draft.trim() || !s.sessionKey) && { opacity: 0.4 }]} accessibilityLabel="Send">
              <Ionicons name="send" size={16} color="#fff3cf" />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const md = {
  body: { color: KG.fg, fontSize: 13.5, lineHeight: 19 },
  code_inline: { backgroundColor: 'rgba(255,255,255,0.06)', color: '#fde68a' },
  fence: { backgroundColor: 'rgba(0,0,0,0.4)', color: KG.fg, borderColor: rgba(KG.gold, 0.2) },
  link: { color: KG.cyan },
  heading1: { color: '#fff3cf', fontSize: 17 },
  heading2: { color: '#fff3cf', fontSize: 15.5 },
  heading3: { color: '#fff3cf', fontSize: 14.5 },
};

const styles = kgSheet({
  wrap: { flex: 1, justifyContent: 'flex-end' },
  drawer: { maxHeight: '100%', padding: 10, borderColor: 'rgba(94,231,255,0.3)' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  title: { color: '#fff3cf', fontWeight: '700', fontSize: 13.5 },
  sub: { color: KG.dimmer, fontSize: 11 },
  icon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, height: 30, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(94,231,255,0.3)', backgroundColor: 'rgba(94,231,255,0.06)' },
  chipText: { color: '#cffafe', fontSize: 12 },
  log: { marginTop: 8, flexGrow: 1, flexShrink: 1, minHeight: 80 },
  msg: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7 },
  user: { alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: rgba(KG.gold, 0.14), borderWidth: 1, borderColor: rgba(KG.gold, 0.3) },
  userText: { color: '#fff3cf', fontSize: 13 },
  asst: { alignSelf: 'stretch', backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  err: { color: '#fca5a5', fontSize: 12.5 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  send: { width: 42, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(94,231,255,0.25)', borderWidth: 1, borderColor: 'rgba(94,231,255,0.5)' },
});
