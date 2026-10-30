/**
 * VerdictCard — verified-completion verdict for one run (parity with
 * ui/src/ui/components/completion-verdict.ts): verdict + state badges,
 * attempts, "why not verified" reasons, visual_verify screenshots, the
 * evidence list, the embedded review thread, and the operator actions
 * Continue / Retry / Accept / Reject (`verification.decide`).
 *
 * Continue and Retry start agent work, so they ask for confirmation first.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable, Modal as RNModal, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Card, Chip, Button, IconButton } from '../../ui-kit';
import {
  VERDICT_STATE_LABEL,
  VERDICT_ACTIONS,
  verdictTone,
  verdictBadgeTone,
  verdictSettled,
  visibleEvidence,
  evidenceTone,
  evidenceIcon,
  verificationFileUrl,
  baseName,
} from './oversight-model';
import { ReviewThread } from './ReviewThread';
import { ConfirmModal, AuthImage } from './ui';

export function VerdictCard({ completion: c, runId, gateway, http, busy, onDecide }) {
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const [showEvidence, setShowEvidence] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [error, setError] = useState(null);
  const [shot, setShot] = useState(null);
  if (!c) return null;

  const label = VERDICT_STATE_LABEL[c.state] ?? c.verdict;
  const settled = verdictSettled(c);
  const evidence = visibleEvidence(c);
  const shotW = Math.max(120, Math.min(220, (Math.min(width, 900) - SPACE.lg * 2 - SPACE.lg * 2 - SPACE.sm) / 2));

  const run = async (action) => {
    setConfirm(null);
    setError(null);
    const res = await onDecide(runId, action);
    if (res && !res.ok) setError(res.error || 'Action failed');
  };

  return (
    <Card tint={verdictTone(c.state || c.verdict) === 'success' ? 'success' : 'primary'} padded={SPACE.md}>
      <View style={{ gap: SPACE.md }}>
      <View style={styles.head}>
        <Chip label={c.verdict} tone={verdictBadgeTone(c.verdict)} solid icon="shield-checkmark-outline" />
        {String(label).toUpperCase() !== c.verdict ? <Chip label={label} tone={verdictTone(c.state || c.verdict)} /> : null}
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {c.attempts} attempt{c.attempts === 1 ? '' : 's'}
          {c.visualFiles.length ? ` · ${c.visualFiles.length} visual file(s)` : ''}
        </Text>
      </View>

      {c.reasons.length ? (
        <View style={{ gap: SPACE.xs }}>
          <Text style={[type.label, { color: colors.textMuted }]}>Why not verified</Text>
          {c.reasons.slice(0, 10).map((r, i) => (
            <Text key={i} style={[type.small, { color: colors.text }]} selectable>
              {'•'} {r}
            </Text>
          ))}
        </View>
      ) : null}

      {c.screenshots.length ? (
        <View style={{ gap: SPACE.xs }}>
          <Text style={[type.label, { color: colors.textMuted }]}>Screenshots</Text>
          <View style={styles.shots}>
            {c.screenshots.slice(0, 8).map((s) => (
              <Pressable
                key={s}
                onPress={() => setShot(s)}
                accessibilityRole="imagebutton"
                accessibilityLabel={`Open screenshot ${baseName(s)}`}
                style={({ pressed }) => [
                  styles.shot,
                  { width: shotW, height: shotW * 0.625, borderColor: colors.border, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                {http?.origin ? (
                  <AuthImage uri={verificationFileUrl(http.origin, s, true)} headers={http.headers} style={StyleSheet.absoluteFill} />
                ) : null}
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {evidence.length ? (
        <View style={{ gap: SPACE.xs }}>
          <Pressable
            onPress={() => setShowEvidence((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel={`${showEvidence ? 'Hide' : 'Show'} evidence`}
            style={styles.toggle}
          >
            <Ionicons name={showEvidence ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
            <Text style={[type.smallStrong, { color: colors.primary }]}>
              {showEvidence ? 'Hide' : 'Show'} evidence ({evidence.length})
            </Text>
          </Pressable>
          {showEvidence
            ? evidence.map((e, i) => {
                const tc = toneColor(evidenceTone(e.status), colors);
                return (
                  <View key={i} style={[styles.ev, { borderBottomColor: colors.borderSubtle }]}>
                    <Ionicons name={evidenceIcon(e.status)} size={14} color={tc} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <View style={styles.evHead}>
                        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{e.kind}</Text>
                        <Text style={[type.monoSmall, { color: colors.text, flex: 1 }]} numberOfLines={3} selectable>
                          {e.ref}
                        </Text>
                      </View>
                      {e.detail ? (
                        <Text style={[type.caption, { color: colors.textMuted }]} selectable>
                          {e.detail}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })
            : null}
        </View>
      ) : null}

      <ReviewThread runId={runId} gateway={gateway} http={http} onOpenShot={setShot} />

      {!settled ? (
        <View style={styles.actions}>
          {VERDICT_ACTIONS.map((a) => {
            const isBusy = busy?.runId === runId && busy?.action === a.key;
            return (
              <Button
                key={a.key}
                title={isBusy ? `${a.busy}…` : a.label}
                icon={a.icon}
                size="sm"
                variant={a.key === 'reject' ? 'danger' : a.key === 'accept' ? 'secondary' : 'outline'}
                loading={isBusy}
                disabled={!!busy}
                accessibilityHint={a.hint}
                onPress={() => (a.confirm ? setConfirm(a) : run(a.key))}
              />
            );
          })}
        </View>
      ) : null}
      {error ? (
        <Text style={[type.caption, { color: colors.error }]} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <ConfirmModal
        visible={!!confirm}
        title={confirm ? `${confirm.label} this run?` : ''}
        message={confirm ? `${confirm.hint}. This starts agent work on the gateway.` : ''}
        confirmLabel={confirm?.label}
        onConfirm={() => confirm && run(confirm.key)}
        onClose={() => setConfirm(null)}
      />
      <ShotViewer path={shot} http={http} onClose={() => setShot(null)} />
      </View>
    </Card>
  );
}

/** Full-size screenshot viewer. */
export function ShotViewer({ path, http, onClose }) {
  const { colors, type, alpha } = useUIKit();
  return (
    <RNModal visible={!!path} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: alpha(colors.background, 0.96) }]}>
        <View style={styles.viewerBar}>
          <Text style={[type.monoSmall, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
            {path ? baseName(path) : ''}
          </Text>
          <IconButton icon="close" onPress={onClose} accessibilityLabel="Close screenshot" />
        </View>
        {path && http?.origin ? (
          <AuthImage uri={verificationFileUrl(http.origin, path, false)} headers={http.headers} style={{ flex: 1, margin: SPACE.md }} resizeMode="contain" />
        ) : null}
      </View>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACE.sm },
  shots: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  shot: { borderRadius: RADIUS.sm, overflow: 'hidden', borderWidth: 1 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 44 },
  ev: { flexDirection: 'row', gap: SPACE.sm, paddingVertical: SPACE.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth },
  evHead: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  viewerBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.lg, paddingTop: SPACE.xxl, gap: SPACE.sm },
});

export default VerdictCard;
