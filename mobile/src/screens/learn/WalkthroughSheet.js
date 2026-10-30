/**
 * Learn › walkthrough steps (native stand-in for the web overlay tour).
 *
 * On the web a walkthrough spotlights real DOM controls (data-learn-id
 * targets) and waits for clicks / typing / live checks. Natively each step is
 * shown as a readable card; progress is recorded through the same
 * learn.guided.progress.update RPC the web tour uses (step / complete / reset),
 * so it syncs both ways. Steps that only work against the web DOM say so, and
 * "Run the tour on the web" opens the real interactive tour in the app's web
 * surface.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, BottomSheet, Button, Chip, Card } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { walkthroughSteps, walkthroughRow } from './learn-model';
import { Md, Flash } from './parts';

export function WalkthroughSheet({ track, walkthrough, progress, busy, flash, onClose, onStep, onComplete, onReset, onRunOnWeb, onOpenRoute }) {
  const { colors, type } = useUIKit();
  if (!track || !walkthrough) return null;
  const steps = walkthroughSteps(track, walkthrough, progress);
  const row = walkthroughRow(track, walkthrough, progress);
  const doneCount = steps.filter((s) => s.done).length;
  const webOnlyCount = steps.filter((s) => s.webOnly).length;

  return (
    <BottomSheet
      visible
      onClose={onClose}
      title={walkthrough.title}
      subtitle={`${track.title} · ${steps.length} steps · ~${walkthrough.estMinutes} min · ${doneCount}/${steps.length} done`}
      maxHeightRatio={0.92}
      footer={
        <View style={{ gap: SPACE.sm }}>
          <View style={styles.row}>
            <Button
              title={row.done ? 'Completed' : 'Complete walkthrough'}
              icon="checkmark-done"
              variant="primary"
              style={{ flex: 1 }}
              disabled={row.done || Boolean(busy)}
              loading={busy === 'complete'}
              onPress={onComplete}
            />
            {row.canReset ? (
              <Button title="Reset" variant="ghost" onPress={onReset} disabled={Boolean(busy)} loading={busy === 'reset'} accessibilityLabel={`Reset ${walkthrough.title}`} />
            ) : null}
          </View>
          <Button title="Run the interactive tour on the web" icon="open-outline" variant="outline" fullWidth onPress={onRunOnWeb} />
        </View>
      }
    >
      {flash ? <Flash text={flash.text} tone={flash.tone} /> : null}
      <Text style={[type.small, { color: colors.textSecondary }]}>{walkthrough.summary}</Text>
      {webOnlyCount ? (
        <View style={[styles.note, { borderColor: withAlpha(colors.info, 0.45), backgroundColor: withAlpha(colors.info, 0.08) }]}>
          <Ionicons name="information-circle-outline" size={16} color={colors.info} />
          <Text style={[type.caption, { color: colors.text, flex: 1 }]}>
            {webOnlyCount} of {steps.length} steps point at controls in the web app. Read them here and mark them done, or run the
            interactive tour on the web.
          </Text>
        </View>
      ) : null}
      {steps.map((s) => (
        <Card
          key={s.id}
          padded
          tint={s.done ? 'success' : s.current ? 'primary' : 'neutral'}
          style={{ marginTop: SPACE.sm }}
        >
          <View style={styles.stepHead}>
            <View style={[styles.num, s.done ? { backgroundColor: colors.success, borderColor: colors.success } : { borderColor: colors.primary }]}>
              {s.done ? (
                <Ionicons name="checkmark" size={14} color={colors.background} />
              ) : (
                <Text style={[type.monoSmall, { color: colors.primary }]}>{s.index + 1}</Text>
              )}
            </View>
            <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>{s.title}</Text>
            {s.current ? <Chip label="Current" tone="primary" size="sm" /> : null}
            {s.optional ? <Chip label="Optional" size="sm" /> : null}
          </View>
          <View style={{ marginTop: SPACE.xs }}>
            <Md>{s.body}</Md>
          </View>
          {s.practice ? (
            <View style={[styles.note, { borderColor: withAlpha(colors.success, 0.45), backgroundColor: withAlpha(colors.success, 0.07) }]}>
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.success} />
              <Text style={[type.caption, { color: colors.text, flex: 1 }]}>
                {s.practice.mode === 'sandbox' ? 'Sandbox: ' : 'Explained, never performed: '}
                {s.practice.note}
              </Text>
            </View>
          ) : null}
          {s.note ? <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>{s.note}</Text> : null}
          {s.parityNote ? (
            <Text style={[type.caption, { color: colors.warning, marginTop: 2 }]}>{s.parityNote}</Text>
          ) : null}
          <View style={[styles.row, { marginTop: SPACE.sm, flexWrap: 'wrap' }]}>
            {!s.done ? (
              <Button
                title="Mark done"
                size="sm"
                variant="outline"
                icon="checkmark"
                disabled={Boolean(busy)}
                loading={busy === `step:${s.id}:1`}
                onPress={() => onStep(s.id, true)}
                accessibilityLabel={`Mark step ${s.index + 1} done`}
              />
            ) : null}
            {!s.current && !row.done ? (
              <Button
                title="Set as current"
                size="sm"
                variant="ghost"
                disabled={Boolean(busy)}
                loading={busy === `step:${s.id}:0`}
                onPress={() => onStep(s.id, false)}
                accessibilityLabel={`Make step ${s.index + 1} the current step`}
              />
            ) : null}
            {s.route ? (
              <Button
                title={`Open ${s.route}`}
                size="sm"
                variant="ghost"
                icon="open-outline"
                onPress={() => onOpenRoute(s.route, s.title)}
                accessibilityLabel={`Open the ${s.route} page`}
              />
            ) : null}
          </View>
        </Card>
      ))}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  num: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  note: { flexDirection: 'row', gap: SPACE.sm, padding: SPACE.sm, borderRadius: RADIUS.sm, borderWidth: 1, marginTop: SPACE.sm },
});
