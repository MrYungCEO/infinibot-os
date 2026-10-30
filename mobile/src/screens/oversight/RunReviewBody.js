/**
 * RunReviewBody — the in-depth run review (parity with
 * ui/src/ui/components/agent-run-review.ts renderAgentRunReview): status +
 * build banner, meta chips, markdown summary with regenerate, issues, files
 * touched (A/M/D/R with +/- lines), activity timeline, run details and the
 * forward actions (Respawn / Verify / Open PR / Follow-up).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Card, Chip, Button, IconButton } from '../../ui-kit';
import {
  runStatusMeta,
  severityTone,
  runFileRow,
  sortedActions,
  fmtDuration,
  fmtCost,
  fmtClock,
  fmtTime,
  forwardActionPlan,
} from './oversight-model';
import { Section, KV, Callout, ConfirmModal } from './ui';

function makeMd(colors, type, alpha) {
  return {
    body: { color: colors.text, fontFamily: type.body.fontFamily, fontSize: 14, lineHeight: 21 },
    heading1: { color: colors.text, fontFamily: type.h2.fontFamily, fontSize: 18, lineHeight: 24, marginTop: SPACE.sm, marginBottom: SPACE.xs },
    heading2: { color: colors.primary, fontFamily: type.h3.fontFamily, fontSize: 15, lineHeight: 21, marginTop: SPACE.md, marginBottom: SPACE.xs },
    heading3: { color: colors.textSecondary, fontFamily: type.h3.fontFamily, fontSize: 14, lineHeight: 20, marginTop: SPACE.sm },
    strong: { fontFamily: type.bodyStrong.fontFamily, color: colors.text },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    bullet_list: { marginVertical: 2 },
    ordered_list: { marginVertical: 2 },
    list_item: { marginVertical: 1 },
    code_inline: { fontFamily: type.mono.fontFamily, backgroundColor: alpha(colors.text, 0.08), color: colors.text, borderWidth: 0, fontSize: 12, paddingHorizontal: 4, borderRadius: 4 },
    fence: { fontFamily: type.mono.fontFamily, backgroundColor: alpha(colors.text, 0.06), color: colors.text, borderWidth: 0, fontSize: 12, padding: SPACE.sm, borderRadius: RADIUS.sm },
    code_block: { fontFamily: type.mono.fontFamily, backgroundColor: alpha(colors.text, 0.06), color: colors.text, borderWidth: 0, fontSize: 12, padding: SPACE.sm, borderRadius: RADIUS.sm },
    blockquote: { backgroundColor: alpha(colors.primary, 0.07), borderLeftColor: colors.primary, borderLeftWidth: 3, paddingHorizontal: SPACE.sm, marginVertical: SPACE.xs },
    hr: { backgroundColor: colors.borderSubtle },
    table: { borderColor: colors.border },
    tr: { borderColor: colors.borderSubtle },
  };
}

export function RunReviewBody({ review, regenerating, onRegenerate, actionBusy, onForward }) {
  const { colors, type, alpha } = useUIKit();
  const md = useMemo(() => makeMd(colors, type, alpha), [colors, type, alpha]);
  const [confirm, setConfirm] = useState(null);
  const [note, setNote] = useState(null);
  const sm = runStatusMeta(review.status);
  const sc = toneColor(sm.tone, colors);

  const fire = async (a, i) => {
    setConfirm(null);
    setNote(null);
    const res = await onForward(review, a, i);
    if (res?.note) setNote({ ok: res.ok, text: res.note });
    else if (res?.ok) setNote({ ok: true, text: `${a.label}: sent` });
  };

  const regen = async () => {
    setNote(null);
    const res = await onRegenerate(review);
    if (res && !res.ok) setNote({ ok: false, text: res.error || 'Could not regenerate the summary' });
  };

  return (
    <View style={{ gap: SPACE.sm }}>
      {/* Status + build banner */}
      <View style={[styles.banner, { borderColor: alpha(sc, 0.45), backgroundColor: alpha(colors.text, 0.04) }]}>
        <Ionicons name={sm.icon} size={16} color={sc} />
        <Text style={[type.label, { color: sc }]}>{sm.label}</Text>
        <Chip
          label={review.built ? 'Build verified' : 'Not built'}
          tone={review.built ? 'success' : 'warning'}
          icon={review.built ? 'checkmark' : 'ellipse-outline'}
          size="sm"
        />
      </View>
      {review.buildEvidence ? (
        <Text style={[type.monoSmall, { color: colors.textMuted }]} numberOfLines={3} selectable>
          {review.buildEvidence}
        </Text>
      ) : null}

      {/* Meta chips */}
      <View style={styles.chips}>
        <Chip label={review.agentKind} size="sm" />
        {review.backend ? <Chip label={review.backend} size="sm" /> : null}
        {review.model ? <Chip label={review.model} size="sm" /> : null}
        <Chip label={fmtDuration(review.durationMs)} size="sm" icon="time-outline" />
        {review.tokensUsed ? <Chip label={`${review.tokensUsed.toLocaleString()} tok`} size="sm" /> : null}
        {review.cost != null && fmtCost(review.cost) ? <Chip label={fmtCost(review.cost)} size="sm" /> : null}
        {review.projectId ? <Chip label={`proj ${review.projectId}`} size="sm" tone="info" /> : null}
      </View>

      {/* Summary */}
      <Section
        title="Summary"
        icon="sparkles-outline"
        right={
          <IconButton
            icon="refresh"
            size="sm"
            loading={regenerating}
            disabled={regenerating}
            onPress={regen}
            accessibilityLabel="Regenerate summary"
          />
        }
      >
        {review.summaryMarkdown ? (
          <Markdown style={md}>{review.summaryMarkdown}</Markdown>
        ) : (
          <Text style={[type.small, { color: colors.textMuted, fontStyle: 'italic' }]}>No summary was recorded for this run.</Text>
        )}
      </Section>

      {/* Issues */}
      {review.issues.length ? (
        <Section title={`Issues (${review.issues.length})`} icon="warning-outline" tone="warning">
          {review.issues.map((i, k) => (
            <Callout key={k} tone={severityTone(i.severity)} label={String(i.severity || 'info').toUpperCase()}>
              {i.text}
            </Callout>
          ))}
        </Section>
      ) : null}

      {/* Files */}
      {review.filesTouched.length ? (
        <Section title={`Files touched (${review.filesTouched.length})`} icon="document-outline">
          {review.filesTouched.map((f, k) => {
            const r = runFileRow(f);
            const kc = toneColor(r.kind.tone, colors);
            return (
              <View key={k} style={[styles.file, { borderBottomColor: colors.borderSubtle }]}>
                <View style={[styles.kind, { borderColor: alpha(kc, 0.5) }]}>
                  <Text style={[type.monoSmall, { color: kc }]}>{r.kind.glyph}</Text>
                </View>
                <Text style={[type.monoSmall, { color: colors.textSecondary, flex: 1 }]} numberOfLines={2} selectable>
                  {r.path}
                </Text>
                {r.added != null ? <Text style={[type.monoSmall, { color: colors.success }]}>+{r.added}</Text> : null}
                {r.removed != null ? <Text style={[type.monoSmall, { color: colors.error }]}>-{r.removed}</Text> : null}
              </View>
            );
          })}
        </Section>
      ) : null}

      {/* Activity */}
      {review.actions.length ? (
        <Section title={`Activity (${review.actions.length})`} icon="pulse-outline">
          {sortedActions(review.actions).map((a, k) => (
            <View key={k} style={[styles.file, { borderBottomColor: colors.borderSubtle, alignItems: 'flex-start' }]}>
              <Text style={[type.monoSmall, { color: colors.textMuted, width: 70 }]}>{fmtTime(a.ts)}</Text>
              <Text style={[type.monoSmall, { color: colors.primary, width: 72 }]} numberOfLines={1}>
                {a.kind}
              </Text>
              <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>{a.detail}</Text>
            </View>
          ))}
        </Section>
      ) : null}

      {/* Run details */}
      <Section title="Run details" icon="information-circle-outline">
        <KV k="Run ID" v={review.runId} mono />
        {review.taskId ? <KV k="Task" v={review.taskId} mono /> : null}
        <KV k="Started" v={fmtClock(review.startedAt)} />
        <KV k="Finished" v={fmtClock(review.finishedAt)} />
      </Section>

      {/* Forward actions */}
      {review.forwardActions.length ? (
        <View style={styles.actions}>
          {review.forwardActions.map((a, i) => {
            const plan = forwardActionPlan(review, a);
            const busy = actionBusy === `${review.runId}:${i}`;
            return (
              <Button
                key={i}
                title={a.label}
                size="sm"
                variant={i === 0 ? 'primary' : 'outline'}
                loading={busy}
                disabled={!!actionBusy}
                onPress={() => (plan.confirm ? setConfirm({ a, i }) : fire(a, i))}
                style={{ maxWidth: '100%' }}
              />
            );
          })}
        </View>
      ) : null}
      {note ? (
        <Text style={[type.caption, { color: note.ok ? colors.success : colors.warning }]} accessibilityRole="alert">
          {note.text}
        </Text>
      ) : null}

      <ConfirmModal
        visible={!!confirm}
        title={confirm ? confirm.a.label : ''}
        message={
          confirm && String(confirm.a.kind).toLowerCase() === 'respawn'
            ? 'Respawns this agent run on the gateway.'
            : 'Starts follow-up work for this run.'
        }
        confirmLabel="Go"
        onConfirm={() => confirm && fire(confirm.a, confirm.i)}
        onClose={() => setConfirm(null)}
      />
    </View>
  );
}

export function RunReviewCard(props) {
  return (
    <Card padded={SPACE.md}>
      <RunReviewBody {...props} />
    </Card>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, minHeight: 44, flexWrap: 'wrap' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs + 2 },
  file: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth },
  kind: { width: 22, height: 22, borderRadius: 5, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.sm },
});

export default RunReviewBody;
