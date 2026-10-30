/**
 * MailView — the All Mail sub-view (web inbox-all-mail.ts): search bar,
 * label rail (system + user labels), message list with unread dot / star /
 * date, and paging via gmail.list nextPageToken. Selecting a row hands the
 * message up to InboxScreen, which renders MessageDetail.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT, Field, Chip, Button, EmptyState, SkeletonRow, IconButton } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  buildListParams,
  normalizeMessage,
  normalizeLabels,
  mergeMessages,
  cleanFrom,
  fmtListDate,
  errMessage,
  isUnknownMethod,
} from './inbox-model';

export function MailView({ gateway, accountId, selectedId, onSelect, onCompose, messagesRef, reloadKey, wide }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const [messages, setMessages] = useState([]);
  const [labels, setLabels] = useState([]);
  const [selectedLabel, setSelectedLabel] = useState('INBOX');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [nextPageToken, setNextPageToken] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const loadSeq = useRef(0);

  // Expose the live list so InboxScreen can patch rows after detail actions.
  if (messagesRef) messagesRef.current = { messages, setMessages };

  const load = useCallback(
    async ({ query = activeQuery, label = selectedLabel, pull = false } = {}) => {
      if (!sendReq) return;
      const seq = ++loadSeq.current;
      if (pull) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [msgRes, labelRes] = await Promise.all([
          sendReq('gmail.list', buildListParams({ accountId, searchQuery: query, selectedLabel: label })),
          sendReq('gmail.labels', { accountId: accountId ?? null }).catch(() => null),
        ]);
        if (seq !== loadSeq.current) return;
        setMessages((msgRes?.messages || []).map(normalizeMessage));
        setNextPageToken(msgRes?.nextPageToken || null);
        if (labelRes) setLabels(normalizeLabels(labelRes.labels));
        setUnavailable(false);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        if (isUnknownMethod(e)) setUnavailable(true);
        setError(errMessage(e));
      } finally {
        if (seq === loadSeq.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [sendReq, accountId, activeQuery, selectedLabel],
  );

  // Reload whenever the account changes (web _switchAccount resets mail state).
  useEffect(() => {
    if (!connected) return;
    setMessages([]);
    setNextPageToken(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, accountId, reloadKey]);

  const loadMore = async () => {
    if (!nextPageToken || loadingMore || !sendReq) return;
    setLoadingMore(true);
    try {
      const res = await sendReq(
        'gmail.list',
        buildListParams({ accountId, searchQuery: activeQuery, selectedLabel, pageToken: nextPageToken }),
      );
      setMessages((cur) => mergeMessages(cur, (res?.messages || []).map(normalizeMessage)));
      setNextPageToken(res?.nextPageToken || null);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const runSearch = () => {
    const q = searchQuery.trim();
    setActiveQuery(q);
    load({ query: q });
  };
  const clearSearch = () => {
    setSearchQuery('');
    setActiveQuery('');
    load({ query: '' });
  };
  const pickLabel = (id) => {
    if (id === selectedLabel && !activeQuery) return;
    setSelectedLabel(id);
    setSearchQuery('');
    setActiveQuery('');
    onSelect?.(null);
    load({ query: '', label: id });
  };

  if (unavailable) {
    return (
      <EmptyState
        icon="cloud-offline-outline"
        title="Mail is not available on this gateway"
        message="This gateway does not expose the gmail.* methods. Update the gateway to use the unified inbox."
        style={{ marginTop: SPACE.xxl }}
      />
    );
  }

  const header = (
    <View style={{ gap: SPACE.sm, paddingBottom: SPACE.sm }}>
      <View style={styles.searchRow}>
        <Field
          style={{ flex: 1 }}
          icon="search-outline"
          placeholder="Search messages…"
          value={searchQuery}
          onChangeText={setSearchQuery}
          returnKeyType="search"
          onSubmitEditing={runSearch}
          autoCapitalize="none"
          rightIcon={searchQuery ? 'close-circle' : undefined}
          onRightPress={clearSearch}
          accessibilityLabel="Search messages"
        />
        <IconButton icon="search" variant="outline" onPress={runSearch} accessibilityLabel="Run search" />
        <IconButton icon="create-outline" variant="outline" onPress={() => onCompose?.()} accessibilityLabel="Compose email" />
      </View>
      {activeQuery ? (
        <View style={styles.searchNote}>
          <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
            Results for “{activeQuery}”
          </Text>
          <Button title="Clear" size="sm" variant="ghost" icon="close" onPress={clearSearch} />
        </View>
      ) : null}
      {labels.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.labelRow}>
          {labels.map((l) => (
            <Chip
              key={l.id}
              label={l.name}
              icon={l.icon}
              count={l.unread || undefined}
              tone={l.type === 'user' ? 'info' : 'primary'}
              selected={!activeQuery && selectedLabel === l.id}
              onPress={() => pickLabel(l.id)}
              accessibilityLabel={`Show ${l.name}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {error ? (
        <Text style={[type.small, { color: colors.error }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );

  const renderItem = ({ item: m }) => {
    const sel = selectedId === m.id;
    return (
      <Pressable
        onPress={() => onSelect?.(m)}
        accessibilityRole="button"
        accessibilityLabel={`${m.isUnread ? 'Unread. ' : ''}From ${cleanFrom(m.from)}. ${m.subject || 'No subject'}`}
        style={({ pressed }) => [
          styles.row,
          {
            borderColor: sel ? withAlpha(colors.primary, 0.55) : withAlpha(colors.text, 0.06),
            backgroundColor: sel ? withAlpha(colors.primary, 0.08) : withAlpha(colors.text, pressed ? 0.06 : 0.03),
          },
        ]}
      >
        <View
          style={[
            styles.dot,
            { backgroundColor: m.isUnread ? colors.primary : 'transparent', borderColor: m.isUnread ? colors.primary : withAlpha(colors.text, 0.2) },
          ]}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={styles.rowTop}>
            <Text
              style={[m.isUnread ? type.bodyStrong : type.body, { color: colors.text, flex: 1 }]}
              numberOfLines={1}
            >
              {cleanFrom(m.from) || '(unknown sender)'}
            </Text>
            {m.isStarred ? <Ionicons name="star" size={14} color={colors.warning} /> : null}
            <Text style={[type.monoSmall, { color: colors.textMuted }]}>{fmtListDate(m.date)}</Text>
          </View>
          <Text style={[m.isUnread ? type.smallStrong : type.small, { color: colors.textSecondary }]} numberOfLines={1}>
            {m.subject || '(No subject)'}
          </Text>
          <Text style={[type.small, { color: colors.textMuted }]} numberOfLines={wide ? 1 : 2}>
            {m.snippet}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <FlatList
      data={messages}
      keyExtractor={(m) => m.id}
      renderItem={renderItem}
      ListHeaderComponent={header}
      contentContainerStyle={styles.list}
      ItemSeparatorComponent={() => <View style={{ height: SPACE.sm }} />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ pull: true })} tintColor={colors.primary} />}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={
        loading ? (
          <View style={{ gap: SPACE.sm }}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : error ? (
          <EmptyState icon="alert-circle-outline" tone="danger" title="Could not load mail" message={error} actionLabel="Retry" onAction={() => load()} />
        ) : (
          <EmptyState icon="mail-outline" title="No messages" message={activeQuery ? 'Nothing matches this search.' : 'This label is empty.'} />
        )
      }
      ListFooterComponent={
        nextPageToken && messages.length ? (
          <View style={{ paddingTop: SPACE.md }}>
            <Button title="Load more" variant="outline" icon="chevron-down" loading={loadingMore} onPress={loadMore} fullWidth />
          </View>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  searchNote: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  labelRow: { gap: SPACE.sm, paddingVertical: SPACE.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACE.md,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    minHeight: HIT.min,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, marginTop: 7 },
});

export default MailView;
