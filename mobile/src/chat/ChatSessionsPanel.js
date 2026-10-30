/**
 * ChatSessionsPanel — the chats list, the mobile twin of the web chat sidebar
 * (`.wc-side` in ui/src/ui/views/webchat.ts): New chat, search, a Pinned group
 * then day buckets, each row with title · agent · relative time, and the same
 * actions (rename, pin, delete).
 *
 * Phones show it in a slide-in drawer (ChatSessionsDrawer); tablets dock it
 * beside the transcript.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from './chat-tokens';
import { BrandAvatar } from './ChatTranscript';
import { agentIdFromKey, agentLabel, groupSessions, isMultiAgent, relTime, sessionTitle } from './session-sync';
import { tap, warn } from '../utils/haptics';
import { isGroupChatKey } from './group/group-logic';

const Row = memo(function Row({ row, active, unread, streaming, agentName, onOpen, onMenu, renaming, renameValue, onRenameChange, onRenameCommit }) {
  const t = useChatTokens();
  const isGroup = isGroupChatKey(row.key);
  const inner = (
    <>
      <View style={[styles.rowBar, { backgroundColor: t.accent, height: active ? 22 : 0 }]} />
      <View style={styles.rowMain}>
        {renaming ? (
          <TextInput
            value={renameValue}
            onChangeText={onRenameChange}
            onBlur={() => onRenameCommit('blur')}
            onSubmitEditing={() => onRenameCommit('submit')}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            accessibilityLabel="Chat title"
            style={[styles.rename, { color: t.textStrong, borderColor: t.accent, fontFamily: t.font.medium, fontSize: t.type.rowTitle }]}
          />
        ) : (
          <View style={styles.rowTitle}>
          {isGroup ? <Ionicons name="people" size={13} color={t.accent} accessibilityLabel="Group chat" /> : null}
          <Text
            numberOfLines={1}
            style={{
              flexShrink: 1,
              color: active || unread ? t.textStrong : t.text,
              fontFamily: active || unread ? t.font.semiBold : t.font.medium,
              fontSize: t.type.rowTitle,
              lineHeight: Math.round(t.type.rowTitle * 1.35),
            }}
          >
            {sessionTitle(row)}
          </Text>
          </View>
        )}
        <View style={styles.rowMeta}>
          {isGroup || agentName ? (
            <Text numberOfLines={1} style={[styles.rowAgent, { color: t.muted, borderColor: t.borderNeutral, fontSize: t.type.rowMeta }]}>
              {isGroup ? 'Group chat' : agentName}
            </Text>
          ) : null}
          <Text style={{ color: t.muted, fontSize: t.type.rowMeta }}>
            {isGroup || agentName ? '· ' : ''}{relTime(row.updatedAt)}
          </Text>
        </View>
      </View>
      {streaming ? (
        <ActivityIndicator size="small" color={t.accent} style={styles.rowState} accessibilityLabel="Replying" />
      ) : unread ? (
        <View style={[styles.unread, { backgroundColor: t.accent }]} accessibilityLabel="Unread reply" />
      ) : row.pinned ? (
        <Ionicons name="pin" size={12} color={t.muted} style={styles.rowState} />
      ) : null}
      <Pressable
        onPress={() => { tap(); onMenu(row); }}
        hitSlop={10}
        style={styles.rowMenu}
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${sessionTitle(row)}`}
      >
        <Ionicons name="ellipsis-horizontal" size={16} color={t.muted} />
      </Pressable>
    </>
  );
  return (
    <Pressable
      onPress={() => onOpen(row.key)}
      onLongPress={() => { warn(); onMenu(row); }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${sessionTitle(row)}${unread ? ', unread' : ''}`}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: t.size.rowMinHeight,
          borderRadius: t.radius.row,
          borderColor: active ? t.activeRowBorder : 'transparent',
          backgroundColor: !active && pressed ? t.rowHover : 'transparent',
        },
      ]}
    >
      {active ? (
        <LinearGradient
          colors={t.activeRow}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[StyleSheet.absoluteFill, { borderRadius: t.radius.row }]}
        />
      ) : null}
      {inner}
    </Pressable>
  );
});

function ListSkeleton() {
  const t = useChatTokens();
  return (
    <View style={styles.skel} accessibilityLabel="Loading chats">
      {[72, 56, 64, 48, 60, 52].map((w, i) => (
        <View key={i} style={styles.skelRow}>
          <View style={[styles.skelLine, { width: `${w}%`, backgroundColor: t.surfaceStrong }]} />
          <View style={[styles.skelLine, { width: '24%', height: 8, backgroundColor: t.surface }]} />
        </View>
      ))}
    </View>
  );
}

/** Bottom action sheet for one chat: rename / pin / delete (with confirm). */
function RowSheet({ row, onClose, onRename, onPin, onDelete }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [row]);
  if (!row) return null;
  const Action = ({ icon, label, onPress, danger }) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.sheetAction, { backgroundColor: pressed ? t.rowHover : 'transparent' }]}
    >
      <Ionicons name={icon} size={18} color={danger ? t.danger : t.text} />
      <Text style={{ color: danger ? t.danger : t.text, fontFamily: t.font.medium, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { backgroundColor: t.side, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={[styles.sheetGrip, { backgroundColor: t.borderNeutral }]} />
        <Text numberOfLines={1} style={[styles.sheetTitle, { color: t.textStrong, fontFamily: t.font.semiBold }]}>
          {sessionTitle(row)}
        </Text>
        {confirming ? (
          <>
            <Text style={[styles.sheetNote, { color: t.muted }]}>
              Delete this chat on every device? The transcript is archived by the gateway.
            </Text>
            <Action icon="trash-outline" label="Delete chat" danger onPress={() => { warn(); onDelete(row); }} />
            <Action icon="close" label="Cancel" onPress={() => setConfirming(false)} />
          </>
        ) : (
          <>
            <Action icon="create-outline" label="Rename" onPress={() => onRename(row)} />
            <Action icon={row.pinned ? 'pin-outline' : 'pin'} label={row.pinned ? 'Unpin' : 'Pin to top'} onPress={() => onPin(row)} />
            <Action icon="trash-outline" label="Delete" danger onPress={() => setConfirming(true)} />
          </>
        )}
      </View>
    </Modal>
  );
}

export function ChatSessionsPanel({ chat, connected, onPicked, onClose, onNewGroup, docked = false }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [menuRow, setMenuRow] = useState(null);
  const [renamingKey, setRenamingKey] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const { sessions, activeKey, activity, agents } = chat;
  const groups = useMemo(() => groupSessions(sessions, { query }), [sessions, query]);
  const sections = useMemo(() => groups.map((g) => ({ title: g.title, data: g.rows })), [groups]);
  const multiAgent = useMemo(() => isMultiAgent(sessions), [sessions]);

  const open = useCallback((key) => {
    if (renamingKey) return;
    tap();
    chat.openSession(key);
    onPicked?.();
  }, [chat, onPicked, renamingKey]);

  // The action sheet is a modal: when it closes, focus moves, and a field that
  // mounted in the same tick would blur (and commit) immediately. Open the
  // field after the sheet is gone and ignore the blur that closing causes.
  const renameStartedAt = useRef(0);
  const startRename = useCallback((row) => {
    setMenuRow(null);
    setTimeout(() => {
      renameStartedAt.current = Date.now();
      setRenameValue(sessionTitle(row));
      setRenamingKey(row.key);
    }, 280);
  }, []);

  const commitRename = useCallback((reason) => {
    const key = renamingKey;
    if (!key) return;
    if (reason === 'blur' && Date.now() - renameStartedAt.current < 600) return;
    setRenamingKey(null);
    chat.renameSession(key, renameValue);
  }, [chat, renamingKey, renameValue]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await chat.loadSessions({ silent: true }); } finally { setRefreshing(false); }
  }, [chat]);

  const renderItem = useCallback(({ item }) => (
    <Row
      row={item}
      active={item.key === activeKey}
      unread={Boolean(activity.unread[item.key])}
      streaming={Boolean(activity.streaming[item.key])}
      agentName={multiAgent ? agentLabel(agents, agentIdFromKey(item.key)) : null}
      onOpen={open}
      onMenu={setMenuRow}
      renaming={renamingKey === item.key}
      renameValue={renameValue}
      onRenameChange={setRenameValue}
      onRenameCommit={commitRename}
    />
  ), [activeKey, activity, multiAgent, agents, open, renamingKey, renameValue, commitRename]);

  const empty = chat.sessionsLoaded && sections.length === 0;

  return (
    <View style={[styles.panel, { backgroundColor: t.side, paddingTop: docked ? 12 : insets.top + 8, borderRightColor: t.border }]}>
      <View style={styles.head}>
        <BrandAvatar size={26} />
        <Text style={[styles.headTitle, { color: t.textStrong, fontFamily: t.font.semiBold }]}>Chats</Text>
        {chat.unreadCount ? (
          <View style={[styles.headBadge, { backgroundColor: t.accent }]}>
            <Text style={[styles.headBadgeText, { color: t.accentForeground }]}>{chat.unreadCount}</Text>
          </View>
        ) : null}
        <View style={styles.flex} />
        {!docked ? (
          <Pressable onPress={onClose} hitSlop={10} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Close chats">
            <Ionicons name="close" size={20} color={t.muted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.newRow}>
        <Pressable
          onPress={() => { tap(); chat.newChat(); onPicked?.(); }}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          style={({ pressed }) => [styles.newBtn, styles.flex, { borderColor: t.borderStrong, backgroundColor: pressed ? t.accentSoft : t.surface, borderRadius: t.radius.row }]}
        >
          <Ionicons name="add" size={18} color={t.accent} />
          <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 14 }}>New chat</Text>
        </Pressable>
        {onNewGroup ? (
          <Pressable
            onPress={() => { tap(); onNewGroup(); }}
            disabled={!connected}
            accessibilityRole="button"
            accessibilityLabel="New group chat"
            testID="chat-new-group"
            style={({ pressed }) => [styles.newBtn, styles.newGroup, { borderColor: t.borderNeutral, backgroundColor: pressed ? t.accentSoft : t.surface, borderRadius: t.radius.row, opacity: connected ? 1 : 0.5 }]}
          >
            <Ionicons name="people-outline" size={17} color={t.accent} />
            <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 14 }}>Group</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.search, { borderColor: t.borderNeutral, backgroundColor: t.surface, borderRadius: t.radius.row }]}>
        <Ionicons name="search" size={15} color={t.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search chats"
          placeholderTextColor={t.mutedStrong}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search chats"
          style={[styles.searchInput, { color: t.text, fontFamily: t.font.regular }]}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={16} color={t.muted} />
          </Pressable>
        ) : null}
      </View>

      {!chat.sessionsLoaded ? (
        <ListSkeleton />
      ) : chat.sessionsError && sessions.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="cloud-offline-outline" size={26} color={t.muted} />
          <Text style={[styles.emptyTitle, { color: t.text }]}>Couldn't load chats</Text>
          <Text style={[styles.emptyText, { color: t.muted }]}>{chat.sessionsError}</Text>
          <Pressable onPress={() => chat.loadSessions()} style={[styles.emptyBtn, { borderColor: t.borderStrong }]} accessibilityRole="button">
            <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 13 }}>Try again</Text>
          </Pressable>
        </View>
      ) : empty ? (
        <View style={styles.empty}>
          <Ionicons name={query ? 'search' : 'chatbubbles-outline'} size={26} color={t.muted} />
          <Text style={[styles.emptyTitle, { color: t.text }]}>{query ? 'No chats match' : 'No chats yet'}</Text>
          <Text style={[styles.emptyText, { color: t.muted }]}>
            {query ? `Nothing matches “${query}”.` : connected ? 'Start one — it shows up on the web too.' : 'Connect to a gateway to see your chats.'}
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionTitle, { color: t.mutedStrong, backgroundColor: t.side, fontFamily: t.font.semiBold }]}>
              {section.title}
            </Text>
          )}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: insets.bottom + 24 }}
          onEndReachedThreshold={0.4}
          onEndReached={() => { if (!query) chat.loadMoreSessions(); }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} />}
          ListFooterComponent={
            chat.hasMoreSessions && !query ? (
              <View style={styles.footer}>
                {chat.sessionsLoading
                  ? <ActivityIndicator size="small" color={t.accent} />
                  : (
                    <Pressable onPress={chat.loadMoreSessions} accessibilityRole="button" hitSlop={8}>
                      <Text style={{ color: t.accent, fontSize: 12, fontFamily: t.font.semiBold }}>Load older chats</Text>
                    </Pressable>
                  )}
              </View>
            ) : null
          }
        />
      )}

      <RowSheet
        row={menuRow}
        onClose={() => setMenuRow(null)}
        onRename={startRename}
        onPin={(row) => { setMenuRow(null); chat.togglePin(row.key); }}
        onDelete={(row) => { setMenuRow(null); chat.deleteSession(row.key); }}
      />
    </View>
  );
}

/** Phone presentation: slide in from the left over a dimmed backdrop. */
export function ChatSessionsDrawer({ visible, onClose, chat, connected, width, onNewGroup }) {
  const x = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(x, {
      toValue: visible ? 1 : 0,
      duration: visible ? 240 : 180,
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => { if (finished && !visible) setMounted(false); });
  }, [visible, x]);
  if (!mounted) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.backdrop, { opacity: x }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close chats" />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          { width, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] },
        ]}
      >
        <ChatSessionsPanel chat={chat} connected={connected} onPicked={onClose} onClose={onClose} onNewGroup={onNewGroup ? () => { onClose(); onNewGroup(); } : undefined} />
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  panel: { flex: 1, borderRightWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 44 },
  headTitle: { fontSize: 16 },
  headBadge: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, alignItems: 'center', justifyContent: 'center' },
  headBadgeText: { fontSize: 11, fontWeight: '700' },
  iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 },
  newRow: { flexDirection: 'row', gap: 8, marginHorizontal: 12, marginTop: 6 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 12, borderWidth: 1 },
  newGroup: { paddingHorizontal: 14 },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, marginHorizontal: 12, marginTop: 10, marginBottom: 6, paddingHorizontal: 10, borderWidth: 1 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8, outlineStyle: 'none' },
  sectionTitle: { fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase', paddingHorizontal: 14, paddingTop: 14, paddingBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 1, paddingLeft: 14, paddingRight: 4, paddingVertical: 7, borderWidth: 1, overflow: 'hidden' },
  rowBar: { position: 'absolute', left: 4, width: 3, borderRadius: 3 },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowAgent: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, maxWidth: 140, overflow: 'hidden' },
  rowState: { marginLeft: 8 },
  rowMenu: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  unread: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  rename: { borderWidth: 1, borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4 },
  footer: { alignItems: 'center', paddingVertical: 16 },
  empty: { alignItems: 'center', gap: 6, paddingHorizontal: 28, paddingTop: 48 },
  emptyTitle: { fontSize: 15, fontWeight: '600', marginTop: 4 },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 18 },
  emptyBtn: { marginTop: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, minHeight: 40, justifyContent: 'center' },
  skel: { paddingHorizontal: 22, paddingTop: 22, gap: 18 },
  skelRow: { gap: 7 },
  skelLine: { height: 12, borderRadius: 6 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  drawer: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, paddingTop: 8, paddingHorizontal: 8 },
  sheetGrip: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 10 },
  sheetTitle: { fontSize: 15, paddingHorizontal: 12, paddingBottom: 8 },
  sheetNote: { fontSize: 13, lineHeight: 18, paddingHorizontal: 12, paddingBottom: 8 },
  sheetAction: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12, borderRadius: 10 },
});
