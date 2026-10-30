/**
 * Detail sections shared by the inline (expanded row) and full-page run
 * detail — the web's _renderSection* helpers in views/oversight/index.ts.
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Button } from '../../ui-kit';
import { Section, KV, Callout } from './ui';
import { timeAgo, fmtClock } from './oversight-model';

export function SummarySection({ entry }) {
  const { colors, type } = useUIKit();
  const text = entry.review?.summary || entry.task;
  return (
    <Section title={entry.review ? 'Review summary' : 'Task brief'} icon="document-text-outline">
      {text ? (
        <Text style={[type.small, { color: colors.text, lineHeight: 20 }]} selectable>
          {text}
        </Text>
      ) : (
        <Text style={[type.small, { color: colors.textMuted, fontStyle: 'italic' }]}>No brief recorded for this run.</Text>
      )}
    </Section>
  );
}

export function ExitSection({ entry }) {
  if (!entry.exitReason) return null;
  const tone = entry.status === 'errored' ? 'danger' : entry.status === 'aborted' ? 'neutral' : 'warning';
  return (
    <Section title="Exit reason" tone={tone} icon="exit-outline">
      <Callout tone={tone}>{entry.exitReason}</Callout>
    </Section>
  );
}

export function BlockersSection({ review }) {
  if (!review?.blockers?.length) return null;
  return (
    <Section title="Blockers" tone="danger" icon="alert-circle-outline">
      {review.blockers.map((b, i) => (
        <Callout key={i} tone="danger">
          {b}
        </Callout>
      ))}
    </Section>
  );
}

export function NextStepsSection({ review, acked, onToggle }) {
  const { colors, type, alpha } = useUIKit();
  if (!review?.nextSteps?.length) return null;
  const done = new Set(acked || []);
  return (
    <Section title="Next steps" icon="list-outline" right={<Text style={[type.monoSmall, { color: colors.textMuted }]}>{done.size}/{review.nextSteps.length}</Text>}>
      {review.nextSteps.map((step, i) => {
        const isDone = done.has(i);
        return (
          <Pressable
            key={i}
            onPress={() => onToggle(i)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isDone }}
            accessibilityLabel={`${isDone ? 'Mark as pending' : 'Mark as acknowledged'}: ${step}`}
            style={({ pressed }) => [styles.step, { opacity: pressed ? 0.8 : 1 }]}
          >
            <View
              style={[
                styles.check,
                { borderColor: isDone ? colors.success : colors.border, backgroundColor: isDone ? alpha(colors.success, 0.15) : 'transparent' },
              ]}
            >
              {isDone ? <Ionicons name="checkmark" size={14} color={colors.success} /> : null}
            </View>
            <Text
              style={[
                type.small,
                { color: isDone ? colors.textMuted : colors.text, flex: 1, textDecorationLine: isDone ? 'line-through' : 'none' },
              ]}
            >
              {step}
            </Text>
          </Pressable>
        );
      })}
    </Section>
  );
}

export function TimelineSection({ entry, now }) {
  const { colors, type } = useUIKit();
  if (!entry.recentUpdates?.length) return null;
  const updates = [...entry.recentUpdates].sort((a, b) => b.timestamp - a.timestamp);
  return (
    <Section title="Recent activity" icon="pulse-outline">
      {updates.map((u, i) => (
        <View key={i} style={[styles.tl, { borderBottomColor: colors.borderSubtle }]}>
          <Text style={[type.monoSmall, { color: colors.textMuted, width: 64 }]}>{timeAgo(u.timestamp, now)}</Text>
          <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]} numberOfLines={3}>
            {u.message || u.status}
          </Text>
          {typeof u.progress === 'number' ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{u.progress}%</Text> : null}
        </View>
      ))}
    </Section>
  );
}

export function FilesSection({ files, showAll = false }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = React.useState(showAll);
  const [all, setAll] = React.useState(showAll);
  if (!files?.length) return null;
  const limit = all ? files.length : Math.min(files.length, 10);
  return (
    <Section
      title={`Files touched (${files.length})`}
      icon="document-outline"
      right={
        <Pressable
          onPress={() => setOpen((o) => !o)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={open ? 'Collapse files' : 'Expand files'}
        >
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textTertiary} />
        </Pressable>
      }
    >
      {open ? (
        <View>
          {files.slice(0, limit).map((f) => (
            <Text key={f} style={[type.monoSmall, styles.file, { color: colors.textSecondary, borderBottomColor: colors.borderSubtle }]} selectable>
              {f}
            </Text>
          ))}
          {files.length > limit ? (
            <Button title={`+ ${files.length - limit} more`} variant="ghost" size="sm" onPress={() => setAll(true)} />
          ) : null}
        </View>
      ) : null}
    </Section>
  );
}

export function TestsSection({ review }) {
  const { colors, type } = useUIKit();
  const [openIdx, setOpenIdx] = React.useState(null);
  const tests = review?.testsRun || [];
  if (!tests.length) return null;
  const passed = tests.filter((t) => t.passed).length;
  const allPass = passed === tests.length;
  return (
    <Section title={`Tests — ${passed}/${tests.length} pass`} tone={allPass ? 'success' : 'danger'} icon="flask-outline">
      {tests.map((t, i) => (
        <View key={i} style={[styles.tl, { borderBottomColor: colors.borderSubtle, flexWrap: 'wrap' }]}>
          <Ionicons name={t.passed ? 'checkmark' : 'close'} size={14} color={t.passed ? colors.success : colors.error} />
          <Text style={[type.caption, { color: colors.text, flex: 1 }]}>{t.name}</Text>
          {t.output ? (
            <Pressable onPress={() => setOpenIdx(openIdx === i ? null : i)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Toggle test output">
              <Text style={[type.caption, { color: colors.primary }]}>output</Text>
            </Pressable>
          ) : null}
          {openIdx === i ? (
            <Text style={[type.monoSmall, styles.pre, { color: colors.textSecondary, backgroundColor: colors.surfaceDeep || colors.surface }]} selectable>
              {t.output}
            </Text>
          ) : null}
        </View>
      ))}
    </Section>
  );
}

export function MetaSection({ entry }) {
  return (
    <Section title="Run details" icon="information-circle-outline">
      <KV k="Run ID" v={entry.runId} mono />
      <KV k="Session" v={entry.sessionKey || '—'} mono />
      {entry.kanbanTaskId ? <KV k="Kanban task" v={entry.kanbanTaskId} mono /> : null}
      <KV k="Started" v={fmtClock(entry.startedAt || entry.createdAt)} />
      <KV k={entry.endedAt ? 'Ended' : 'Last update'} v={fmtClock(entry.endedAt || entry.lastUpdateAt)} />
      <KV k="Backend" v={`${entry.coderBackend || '—'}${entry.remote && entry.nodeName ? ` @ ${entry.nodeName}` : ''}`} />
    </Section>
  );
}

/** Session / Kanban task / Generate-review buttons (the web's link buttons). */
export function LinkButtons({ entry, onOpenSession, onOpenTask, onForce, forcing }) {
  return (
    <>
      {entry.sessionKey ? (
        <Button title="Session" icon="link-outline" size="sm" variant="outline" onPress={() => onOpenSession(entry)} accessibilityLabel="Open originating session" />
      ) : null}
      {entry.kanbanTaskId ? (
        <Button title="Kanban task" icon="link-outline" size="sm" variant="outline" onPress={() => onOpenTask(entry.kanbanTaskId)} accessibilityLabel={`Open kanban task ${entry.kanbanTaskId}`} />
      ) : null}
      {entry.status !== 'running' ? (
        <Button
          title={forcing ? 'Reviewing…' : entry.review ? 'Re-review' : 'Generate review'}
          icon="refresh-outline"
          size="sm"
          variant="outline"
          loading={forcing}
          disabled={forcing}
          onPress={() => onForce(entry.runId)}
          accessibilityHint="Run the auto-reviewer for this run"
        />
      ) : null}
    </>
  );
}

export function toneOf(colors, tone) {
  return toneColor(tone, colors);
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  tl: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.sm, paddingVertical: SPACE.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth },
  file: { paddingVertical: SPACE.xs + 1, borderBottomWidth: StyleSheet.hairlineWidth },
  pre: { width: '100%', padding: SPACE.sm, borderRadius: RADIUS.sm, marginTop: SPACE.xs },
});
