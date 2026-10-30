/**
 * RepliesView — AI-classified lead replies (web reply-inbox.ts): unhandled /
 * urgent counts, Refresh, Show handled, class + urgency filter chips, rows
 * sorted urgency → newest, expand for suggested action / confidence /
 * campaign, Mark handled, and a full-detail card.
 *
 * Data source: the web view has none yet (its onLoad is a TODO stub and
 * mark-handled is local-only), so neither does this. The list state lives in
 * InboxScreen so the Replies tab badge can count urgent items.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, RefreshControl, StyleSheet, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIKit, SPACE, RADIUS, HIT, Card, Chip, Button, EmptyState, SkeletonRow, toneColor } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  REPLY_CLASSES,
  REPLY_CLASS_FILTERS,
  REPLY_URGENCY,
  filterReplies,
  replyCounts,
  confidenceLabel,
  timeAgo,
  fmtLongDate,
} from './inbox-model';

export function RepliesView({ state, setState, onRefresh, onAskAgent }) {
  const { colors, type } = useUIKit();
  const { replies, loading, error, filterClass, filterUrgency, showHandled, selectedReplyId } = state;
  const filtered = filterReplies(replies, { filterClass, filterUrgency, showHandled });
  const { unhandled, urgent } = replyCounts(replies);
  const patch = (p) => setState((s) => ({ ...s, ...p }));
  const markHandled = (id) =>
    setState((s) => ({ ...s, replies: s.replies.map((r) => (r.id === id ? { ...r, handled: true } : r)) }));
  const selected = replies.find((r) => r.id === selectedReplyId) || null;

  return (
    <ScrollView
      contentContainerStyle={styles.wrap}
      refreshControl={<RefreshControl refreshing={!!loading} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      <Card padded>
        <View style={styles.headRow}>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyStrong, { color: colors.text }]}>Reply Inbox</Text>
            <Text style={[type.small, { color: colors.textSecondary }]}>
              {unhandled} unhandled
              {urgent > 0 ? <Text style={{ color: colors.error }}>{`  ·  ${urgent} urgent`}</Text> : null}
            </Text>
          </View>
          <Button title="Refresh" icon="refresh" variant="ghost" size="sm" onPress={onRefresh} />
        </View>
        <View style={styles.toggleRow}>
          <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]}>Show handled</Text>
          <Switch
            value={showHandled}
            onValueChange={(v) => patch({ showHandled: v })}
            trackColor={{ false: withAlpha(colors.text, 0.2), true: withAlpha(colors.primary, 0.6) }}
            thumbColor={showHandled ? colors.primary : colors.textSecondary}
            accessibilityLabel="Show handled replies"
          />
        </View>
      </Card>

      <View style={{ gap: SPACE.xs }}>
        <Text style={[type.label, { color: colors.textMuted }]}>Class</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Chip label="All" selected={filterClass === null} onPress={() => patch({ filterClass: null })} accessibilityLabel="All classes" />
          {REPLY_CLASS_FILTERS.map((c) => (
            <Chip
              key={c}
              label={REPLY_CLASSES[c].label}
              icon={REPLY_CLASSES[c].icon}
              tone={REPLY_CLASSES[c].tone}
              selected={filterClass === c}
              onPress={() => patch({ filterClass: filterClass === c ? null : c })}
              accessibilityLabel={`Filter ${REPLY_CLASSES[c].label}`}
            />
          ))}
        </ScrollView>
        <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.xs }]}>Urgency</Text>
        <View style={styles.chipRow}>
          {Object.keys(REPLY_URGENCY).map((u) => (
            <Chip
              key={u}
              label={REPLY_URGENCY[u].label}
              tone={REPLY_URGENCY[u].tone}
              dot
              selected={filterUrgency === u}
              onPress={() => patch({ filterUrgency: filterUrgency === u ? null : u })}
              accessibilityLabel={`Filter ${REPLY_URGENCY[u].label} urgency`}
            />
          ))}
        </View>
      </View>

      {error ? <Text style={[type.small, { color: colors.error }]}>{error}</Text> : null}

      {loading && !replies.length ? (
        <View style={{ gap: SPACE.sm }}>
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="checkmark-done-outline"
          title="Inbox clear"
          message="Replies from leads will appear here after classification."
        />
      ) : (
        filtered.map((r) => {
          const cls = REPLY_CLASSES[r.class];
          const urg = REPLY_URGENCY[r.urgency];
          const open = selectedReplyId === r.id;
          const conf = confidenceLabel(r.confidence);
          return (
            <View key={r.id} style={{ gap: SPACE.xs }}>
              <Pressable
                onPress={() => patch({ selectedReplyId: open ? null : r.id })}
                accessibilityRole="button"
                accessibilityLabel={`${r.leadName}, ${cls.label}, ${urg.label} urgency`}
                style={({ pressed }) => [
                  styles.row,
                  {
                    opacity: r.handled ? 0.55 : 1,
                    borderColor: open ? withAlpha(colors.primary, 0.55) : withAlpha(colors.text, 0.06),
                    backgroundColor: withAlpha(colors.text, pressed ? 0.06 : 0.03),
                  },
                ]}
              >
                <Ionicons name={cls.icon} size={20} color={toneColor(cls.tone, colors)} style={{ marginTop: 2 }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
                    {r.leadName}
                  </Text>
                  <Text style={[type.small, { color: colors.textSecondary }]} numberOfLines={1}>
                    {r.subject}
                  </Text>
                  <Text style={[type.small, { color: colors.textMuted }]} numberOfLines={2}>
                    {r.bodyPreview}
                  </Text>
                  <View style={styles.metaRow}>
                    <Chip label={urg.label} tone={urg.tone} size="sm" />
                    <Chip label={cls.label} tone={cls.tone} size="sm" />
                    <Text style={[type.monoSmall, { color: colors.textMuted }]}>{timeAgo(r.receivedAt)}</Text>
                    <View style={{ flex: 1 }} />
                    {!r.handled ? (
                      <Button title="Handled" icon="checkmark" size="sm" variant="outline" onPress={() => markHandled(r.id)} />
                    ) : (
                      <Ionicons name="checkmark-circle" size={18} color={colors.success} accessibilityLabel="Handled" />
                    )}
                  </View>
                </View>
              </Pressable>
              {open ? (
                <Card padded>
                  <Text style={[type.small, { color: colors.textSecondary }]}>
                    <Text style={{ fontWeight: '700', color: colors.text }}>Suggested action: </Text>
                    {r.suggestedAction || '—'}
                  </Text>
                  <Text style={[type.small, { color: colors.textMuted, marginTop: SPACE.xs }]}>
                    AI confidence: {conf.pct}%
                    {conf.low ? <Text style={{ color: colors.warning }}> (low — human review recommended)</Text> : null}
                  </Text>
                  {r.campaignName ? (
                    <Text style={[type.small, { color: colors.textMuted, marginTop: SPACE.xs }]}>Campaign: {r.campaignName}</Text>
                  ) : null}
                </Card>
              ) : null}
            </View>
          );
        })
      )}

      {selected ? (
        <Card padded tint="primary">
          <Text style={[type.bodyStrong, { color: colors.text }]}>{selected.leadName} — Reply</Text>
          <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>
            Received: {fmtLongDate(selected.receivedAt)}
            {selected.leadEmail ? `  ·  From: ${selected.leadEmail}` : ''}
          </Text>
          <Text style={[type.body, { color: colors.textSecondary, marginTop: SPACE.sm }]} selectable>
            {selected.bodyPreview}
          </Text>
          <View style={{ marginTop: SPACE.sm, alignItems: 'flex-start' }}>
            <Button title="Ask agent" icon="sparkles-outline" variant="ghost" size="sm" onPress={() => onAskAgent?.(selected)} />
          </View>
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: SPACE.lg, gap: SPACE.md, paddingBottom: SPACE.xxl * 2 },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: HIT.min, marginTop: SPACE.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'nowrap', gap: SPACE.sm, paddingVertical: SPACE.xs },
  row: { flexDirection: 'row', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.xs, flexWrap: 'wrap' },
});

export default RepliesView;
