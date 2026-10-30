/**
 * Learn › track page — overview, badge, mobile deep link, guided walkthroughs
 * (Start / Resume / Replay / Reset) and the quick check (quiz).
 * (web: renderTrackPage / walkthroughRow / renderQuiz in views/learn.ts)
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, HIT, Card, Chip, Button, SectionTitle, EmptyState } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  LEVEL_LABEL, LEVEL_TONE, trackStatus, trackMinutes, trackCta, prerequisiteTracks, badgeCaption, walkthroughRow,
  quizAllAnswered, quizHeader, quizResultLine, setAnswer, deepLinkFor, pluginAccent,
} from './learn-model';
import { Ring, Monogram, Md } from './parts';

let Clipboard = null;
try {
  // eslint-disable-next-line global-require
  Clipboard = require('expo-clipboard');
} catch {
  Clipboard = null;
}

export function MissingTrack({ trackId, onAll, onPlugins }) {
  return (
    <EmptyState
      icon="help-circle-outline"
      title="That track isn't available"
      message={`"${trackId}" may belong to a plugin that is turned off, or it needs a newer InfiniBot build.`}
      actionLabel="All tracks"
      onAction={onAll}
      secondaryLabel="Plugins"
      onSecondary={onPlugins}
    />
  );
}

function WalkthroughItem({ track, w, i, progress, onOpen, onReset }) {
  const { colors, type } = useUIKit();
  const row = walkthroughRow(track, w, progress);
  return (
    <Card
      padded
      tint={row.done ? 'success' : 'neutral'}
      style={{ marginTop: SPACE.sm }}
      onPress={() => onOpen(w)}
      accessibilityLabel={`${w.title}. ${row.done ? 'Done' : row.started ? 'In progress' : 'Not started'}. Open steps`}
    >
      <View style={styles.wtRow}>
        <View style={[styles.num, row.done ? { backgroundColor: colors.success, borderColor: colors.success } : { borderColor: colors.primary }]}>
          {row.done ? (
            <Ionicons name="checkmark" size={16} color={colors.background} />
          ) : (
            <Text style={[type.monoSmall, { color: colors.primary }]}>{i + 1}</Text>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: colors.text }]}>{w.title}</Text>
          <Text style={[type.small, { color: colors.textSecondary, marginTop: 2 }]}>{w.summary}</Text>
          <View style={styles.meta}>
            <Text style={[type.caption, { color: colors.textMuted }]}>{w.steps.length} steps</Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>~{w.estMinutes} min</Text>
            {row.risky ? <Chip label="Safe practice" icon="shield-checkmark-outline" tone="success" size="sm" /> : null}
            {row.bonus ? <Chip label="Bonus" tone="primary" size="sm" /> : null}
            {row.prereqMissing.length ? (
              <Text style={[type.caption, { color: colors.warning }]}>Best after: {row.prereqMissing.join(', ')}</Text>
            ) : null}
          </View>
        </View>
      </View>
      <View style={styles.wtActions}>
        <Button
          title={row.ctaLabel}
          size="sm"
          variant={row.done ? 'outline' : 'primary'}
          icon={row.done ? 'refresh' : 'play'}
          onPress={() => onOpen(w)}
          style={{ flex: 1 }}
          accessibilityLabel={`${row.ctaLabel} ${w.title}`}
        />
        {row.canReset ? (
          <Button title="Reset" size="sm" variant="ghost" onPress={() => onReset(w)} accessibilityLabel={`Reset ${w.title}`} />
        ) : null}
      </View>
    </Card>
  );
}

function Quiz({ track, progress, answers, result, busy, onAnswer, onSubmit }) {
  const { colors, type } = useUIKit();
  const best = progress?.quizzes?.[track.id];
  const all = quizAllAnswered(track, answers);
  return (
    <View>
      <SectionTitle title="Quick check" subtitle={quizHeader(track, best)} />
      {track.quiz.map((q, qi) => {
        const r = result?.results?.[qi];
        return (
          <Card key={q.id || qi} padded tint={r ? (r.correct ? 'success' : 'danger') : 'neutral'} style={{ marginTop: SPACE.sm }}>
            <Text style={[type.smallStrong, { color: colors.text, marginBottom: SPACE.xs }]}>{q.prompt}</Text>
            <View accessibilityRole="radiogroup">
              {q.options.map((o, oi) => {
                const checked = answers?.[qi] === oi;
                const isAnswer = r && r.answer === oi;
                return (
                  <Pressable
                    key={oi}
                    onPress={() => onAnswer(qi, oi)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked }}
                    accessibilityLabel={o}
                    style={({ pressed }) => [
                      styles.opt,
                      isAnswer && { borderColor: colors.success },
                      checked && { backgroundColor: withAlpha(colors.primary, 0.08) },
                      pressed && { opacity: 0.8 },
                    ]}
                  >
                    <Ionicons name={checked ? 'radio-button-on' : 'radio-button-off'} size={20} color={checked ? colors.primary : colors.textMuted} />
                    <Text style={[type.small, { color: colors.text, flex: 1 }]}>{o}</Text>
                  </Pressable>
                );
              })}
            </View>
            {r && r.explain ? (
              <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.xs }]}>
                {r.correct ? 'Correct. ' : 'Not quite. '}
                {r.explain}
              </Text>
            ) : null}
          </Card>
        );
      })}
      <View style={[styles.rowWrap, { marginTop: SPACE.md }]}>
        <Button title="Check answers" variant="primary" onPress={onSubmit} disabled={!all || busy} loading={busy} />
        {result ? (
          <Text accessibilityLiveRegion="polite" style={[type.smallStrong, { color: result.passed ? colors.success : colors.error }]}>
            {quizResultLine(result)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function TrackPage({ track, tracks, plugins, progress, onOpenTrack, onOpenWalkthrough, onReset, onSubmitQuiz }) {
  const { colors, type } = useUIKit();
  const [answers, setAnswers] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const plugin = track.pluginId ? plugins.find((p) => p.id === track.pluginId) : null;
  const accent = pluginAccent(plugin) || colors.primary;
  const s = trackStatus(track, progress);
  const prereq = prerequisiteTracks(track, tracks);
  const link = deepLinkFor(track.id);

  const submit = async () => {
    setBusy(true);
    try {
      setResult(await onSubmitQuiz(track, answers));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Card padded glow>
        <View style={styles.head}>
          <Monogram plugin={plugin} pluginId={track.pluginId} size={56} />
          <View style={{ flex: 1 }}>
            <View style={styles.rowWrap}>
              <Chip label={plugin ? plugin.name : track.category} size="sm" />
              <Chip label={LEVEL_LABEL[track.level]} tone={LEVEL_TONE[track.level]} size="sm" />
              <Chip label={`~${trackMinutes(track)} min`} size="sm" />
            </View>
          </View>
          <Ring percent={s.percent} accent={accent} size={48} />
        </View>
        <Text style={[type.h1, { color: colors.text, marginTop: SPACE.sm }]}>{track.title}</Text>
        <Text style={[type.small, { color: colors.textSecondary, marginTop: SPACE.xs }]}>{track.summary}</Text>
        <Button
          title={trackCta(s)}
          variant="primary"
          icon={s.completed ? 'refresh' : 'play'}
          onPress={() => onOpenWalkthrough(null)}
          style={{ marginTop: SPACE.md }}
          accessibilityLabel={`${trackCta(s)}: ${track.title}`}
        />
      </Card>

      {track.disclaimer ? (
        <View style={[styles.disclaimer, { borderColor: withAlpha(colors.warning, 0.55), backgroundColor: withAlpha(colors.warning, 0.1) }]} accessibilityRole="text">
          <Ionicons name="warning-outline" size={16} color={colors.warning} />
          <Text style={[type.small, { color: colors.text, flex: 1 }]}>
            <Text style={{ fontWeight: '700' }}>Important: </Text>
            {track.disclaimer}
          </Text>
        </View>
      ) : null}

      <SectionTitle title="Overview" />
      <Card padded tint="neutral">
        <Md>{track.overview}</Md>
        {prereq.length ? (
          <View style={[styles.rowWrap, { marginTop: SPACE.xs }]}>
            <Text style={[type.caption, { color: colors.textMuted }]}>Recommended first:</Text>
            {prereq.map((p) => (
              <Chip key={p.id} label={p.title} tone="primary" size="sm" onPress={() => onOpenTrack(p)} accessibilityLabel={`Open ${p.title}`} />
            ))}
          </View>
        ) : null}
      </Card>

      <View style={[styles.side]}>
        <Card padded tint={s.completed ? 'success' : 'neutral'} style={{ flex: 1, minWidth: 220 }}>
          <View style={styles.badgeRow}>
            <View style={[styles.badgeIcon, { borderColor: accent, backgroundColor: withAlpha(accent, 0.14), opacity: s.completed ? 1 : 0.6 }]}>
              <Ionicons name={s.completed ? 'ribbon' : 'ribbon-outline'} size={22} color={s.completed ? accent : colors.textMuted} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.smallStrong, { color: colors.text }]}>{track.badge?.label}</Text>
              <Text style={[type.caption, { color: colors.textMuted }]}>{badgeCaption(track, s)}</Text>
            </View>
          </View>
        </Card>
        <Card padded tint="neutral" style={{ flex: 1, minWidth: 220 }}>
          <Text style={[type.caption, { color: colors.textMuted }]}>Open on your phone</Text>
          <Text selectable style={[type.monoSmall, { color: colors.text, marginVertical: SPACE.xs }]}>{link}</Text>
          {Clipboard?.setStringAsync ? (
            <Button
              title={copied ? 'Copied' : 'Copy link'}
              size="sm"
              variant="ghost"
              icon={copied ? 'checkmark' : 'copy-outline'}
              onPress={async () => {
                try {
                  await Clipboard.setStringAsync(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard unavailable */
                }
              }}
            />
          ) : null}
        </Card>
      </View>

      <SectionTitle title="Guided walkthroughs" subtitle={`${s.walkthroughsDone}/${s.walkthroughsTotal} done`} />
      {track.walkthroughs.map((w, i) => (
        <WalkthroughItem key={w.id} track={track} w={w} i={i} progress={progress} onOpen={onOpenWalkthrough} onReset={onReset} />
      ))}

      {track.quiz.length ? (
        <Quiz
          track={track}
          progress={progress}
          answers={answers}
          result={result}
          busy={busy}
          onAnswer={(qi, oi) => {
            setAnswers((a) => setAnswer(a, qi, oi));
            setResult(null);
          }}
          onSubmit={submit}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  disclaimer: { flexDirection: 'row', gap: SPACE.sm, padding: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1, marginTop: SPACE.md },
  side: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  badgeIcon: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  wtRow: { flexDirection: 'row', gap: SPACE.md },
  num: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm, marginTop: SPACE.xs },
  wtActions: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },
  opt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.sm,
    minHeight: HIT.min || 44,
    paddingHorizontal: SPACE.sm,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
});
