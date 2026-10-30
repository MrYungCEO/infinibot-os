/**
 * RunDetail — the full run page. Combines the two web detail surfaces for one
 * runId:
 *   · Oversight detail (views/oversight/index.ts _renderDetailPage): status,
 *     links, (re)review, approve / send back, decision + drift + cost +
 *     confidence, verdict card, summary, exit reason, blockers, next steps,
 *     recent activity, files, tests, run details.
 *   · Run review (views/reviews → renderAgentRunReview) when agents.reviews
 *     has a record for the run.
 * A segmented control switches between them when both exist.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUIKit, SPACE, Chip, Button, SegmentedControl, EmptyState, Skeleton } from '../../ui-kit';
import {
  statusMeta,
  decisionLabel,
  decisionTone,
  fmtDuration,
  fmtCost,
  timeAgo,
  finishedAt,
  runStatusMeta,
} from './oversight-model';
import { ConfidenceBar } from './ui';
import { VerdictCard } from './VerdictCard';
import { RunReviewBody } from './RunReviewBody';
import {
  SummarySection,
  ExitSection,
  BlockersSection,
  NextStepsSection,
  TimelineSection,
  FilesSection,
  TestsSection,
  MetaSection,
  LinkButtons,
} from './sections';

export function RunDetail({ runId, ov, rr, gateway, http, initialSegment = 'oversight', onOpenSession, onOpenTask, onForward }) {
  const { colors, type } = useUIKit();
  const entry = ov.findEntry(runId);
  const runReview = rr.findReview(runId);
  const [segment, setSegment] = useState(initialSegment);

  // Fetch what we don't have yet (deep link to an aged-out run).
  useEffect(() => {
    if (!runId) return;
    if (!entry && ov.loaded && !ov.lookup[runId]) ov.ensureRun(runId);
  }, [runId, entry, ov.loaded, ov.lookup, ov.ensureRun]);
  useEffect(() => {
    if (!runId) return;
    if (!runReview && rr.loaded && !rr.lookup[runId]) rr.ensureReview(runId);
  }, [runId, runReview, rr.loaded, rr.lookup, rr.ensureReview]);

  const both = !!entry && !!runReview;
  const seg = both ? segment : entry ? 'oversight' : runReview ? 'review' : segment;

  const pending =
    (!entry && (!ov.loaded || ov.lookup[runId] === 'loading' || !ov.lookup[runId])) ||
    (!runReview && !entry && (!rr.loaded || rr.lookup[runId] === 'loading'));

  if (!entry && !runReview) {
    if (pending) {
      return (
        <View style={{ gap: SPACE.md, paddingTop: SPACE.md }}>
          <Skeleton height={28} width="70%" />
          <Skeleton height={16} width="40%" />
          <Skeleton height={120} />
          <Skeleton count={4} />
        </View>
      );
    }
    return (
      <EmptyState
        icon="search-outline"
        title="Run not found"
        message={`Run ID: ${runId}. It may have aged out of the live registry.`}
        actionLabel="Reload"
        onAction={() => {
          ov.load();
          rr.load();
          ov.ensureRun(runId);
          rr.ensureReview(runId);
        }}
      />
    );
  }

  const title = entry?.label || runReview?.title || runId;
  const review = entry?.review;
  const decision = review?.decision ?? 'pending';
  const busyDecide = ov.deciding.has(runId);

  return (
    <View style={{ paddingTop: SPACE.lg }}>
      <Text style={[type.h2, { color: colors.text }]} selectable>
        {title}
      </Text>
      <Text style={[type.monoSmall, { color: colors.textMuted, marginTop: 2 }]} selectable numberOfLines={1}>
        {runId}
      </Text>

      <View style={styles.chips}>
        {entry ? <Chip label={statusMeta(entry.status).label} tone={statusMeta(entry.status).tone} dot size="sm" /> : null}
        {!entry && runReview ? <Chip label={runStatusMeta(runReview.status).label} tone={runStatusMeta(runReview.status).tone} dot size="sm" /> : null}
        {entry?.coderBackend ? <Chip label={entry.coderBackend} size="sm" /> : null}
        {entry?.remote && entry?.nodeName ? <Chip label={`@${entry.nodeName}`} size="sm" icon="git-network-outline" /> : null}
        {entry ? <Chip label={fmtDuration(entry.durationMs)} size="sm" icon="time-outline" /> : null}
        {entry ? <Chip label={timeAgo(finishedAt(entry), ov.now)} size="sm" /> : null}
        {review ? <Chip label={decisionLabel(decision)} tone={decisionTone(decision)} size="sm" /> : null}
        {review?.drift ? <Chip label="Drift" tone="warning" icon="warning-outline" size="sm" /> : null}
        {review?.tokenCost && fmtCost(review.tokenCost) ? <Chip label={fmtCost(review.tokenCost)} size="sm" /> : null}
      </View>
      {review ? (
        <View style={{ marginTop: SPACE.sm }}>
          <ConfidenceBar value={review.confidence} />
        </View>
      ) : null}
      {review?.drift && review.driftNote ? (
        <Text style={[type.caption, { color: colors.warning, marginTop: SPACE.xs }]}>{review.driftNote}</Text>
      ) : null}

      {entry ? (
        <View style={styles.actions}>
          <LinkButtons
            entry={entry}
            onOpenSession={onOpenSession}
            onOpenTask={onOpenTask}
            onForce={ov.forceReview}
            forcing={ov.forcing.has(runId)}
          />
          {review ? (
            <>
              <Button
                title={decision === 'approved' ? 'Approved' : 'Approve'}
                icon="checkmark"
                size="sm"
                variant={decision === 'approved' ? 'secondary' : 'outline'}
                disabled={busyDecide || decision === 'approved'}
                onPress={() => ov.decide(runId, 'approved')}
                accessibilityLabel="Approve this run"
              />
              <Button
                title={decision === 'sent_back' ? 'Sent back' : 'Send back'}
                icon="arrow-undo-outline"
                size="sm"
                variant={decision === 'sent_back' ? 'danger' : 'outline'}
                disabled={busyDecide || decision === 'sent_back'}
                onPress={() => ov.decide(runId, 'sent_back')}
                accessibilityLabel="Send this run back for rework"
              />
            </>
          ) : null}
        </View>
      ) : null}
      {ov.actionError ? (
        <Text style={[type.caption, { color: colors.error, marginTop: SPACE.xs }]} accessibilityRole="alert">
          {ov.actionError}
        </Text>
      ) : null}

      {both ? (
        <SegmentedControl
          style={{ marginTop: SPACE.md }}
          size="sm"
          value={seg}
          onChange={setSegment}
          options={[
            { key: 'oversight', label: 'Oversight', icon: 'eye-outline' },
            { key: 'review', label: 'Run review', icon: 'document-text-outline' },
          ]}
        />
      ) : null}

      {seg === 'oversight' && entry ? (
        <View>
          {review?.completion ? (
            <View style={{ marginTop: SPACE.md }}>
              <VerdictCard
                completion={review.completion}
                runId={runId}
                gateway={gateway}
                http={http}
                busy={ov.verdictBusy}
                onDecide={ov.verdictDecide}
              />
            </View>
          ) : null}
          <SummarySection entry={entry} />
          <ExitSection entry={entry} />
          <BlockersSection review={review} />
          <NextStepsSection review={review} acked={ov.acked[runId]} onToggle={(i) => ov.toggleAck(runId, i)} />
          <TimelineSection entry={entry} now={ov.now} />
          <FilesSection files={review?.filesTouched} showAll />
          <TestsSection review={review} />
          <MetaSection entry={entry} />
        </View>
      ) : null}

      {seg === 'review' && runReview ? (
        <View style={{ marginTop: SPACE.md }}>
          <RunReviewBody
            review={runReview}
            regenerating={rr.regenerating.has(runReview.id)}
            onRegenerate={rr.regenerate}
            actionBusy={rr.actionBusy}
            onForward={onForward || rr.runForward}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs + 2, marginTop: SPACE.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
});

export default RunDetail;
