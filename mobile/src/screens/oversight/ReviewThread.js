/**
 * ReviewThread — the worker <-> Auditor review conversation for one run
 * (parity with ui/src/ui/components/review-thread-view.ts, compact mode as
 * embedded in the verdict card). Loads `review.thread.get`; renders nothing
 * when the run has no thread.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUIKit, SPACE, RADIUS, toneColor, Chip, Button } from '../../ui-kit';
import {
  normalizeThread,
  packetTone,
  messageRoute,
  messageChipLabel,
  threadHeadline,
  threadHeadTone,
  evidenceTone,
  verificationFileUrl,
  fmtTime,
} from './oversight-model';
import { withTimeout } from '../../hooks/useOversight';
import { AuthImage } from './ui';

const COMPACT_LIMIT = 4;

export function ReviewThread({ runId, gateway, http, onOpenShot }) {
  const { colors, type, alpha } = useUIKit();
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!runId || !gateway?.sendReq) return undefined;
    setLoading(true);
    withTimeout(gateway.sendReq('review.thread.get', { runId }), 20_000, 'thread')
      .then((t) => alive && setThread(normalizeThread(t)))
      .catch(() => alive && setThread(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [runId, gateway]);

  if (!thread) {
    return loading ? <Text style={[type.caption, { color: colors.textMuted }]}>Loading review thread…</Text> : null;
  }
  const { summary, messages, pinned } = thread;
  if (!messages.length) return null;
  const shown = expanded ? messages : messages.slice(Math.max(0, messages.length - COMPACT_LIMIT));
  const headTone = threadHeadTone(summary);

  return (
    <View style={{ gap: SPACE.sm }}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Hide' : 'Show'} review thread`}
        style={styles.head}
      >
        <Ionicons name="shield-checkmark-outline" size={14} color={colors.textMuted} />
        <Text style={[type.label, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
          Review thread · {messages.length} messages
        </Text>
        <Chip label={threadHeadline(summary)} tone={headTone} size="sm" />
        <View style={{ flex: 1 }} />
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textTertiary} />
      </Pressable>
      {open ? (
        <>
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {summary.rounds} round{summary.rounds === 1 ? '' : 's'} · state {summary.state}
            {summary.backend ? ` · ${summary.backend}` : ''}
          </Text>
          {pinned ? <Escalation esc={pinned} /> : null}
          {shown.map((m) => {
            const tone = toneColor(packetTone(m), colors);
            const route = messageRoute(m, summary.label);
            const isPinned = pinned && m.escalation && m.escalation.decision === pinned.decision;
            return (
              <View
                key={m.id}
                style={[
                  styles.msg,
                  { borderColor: alpha(tone, 0.3), borderLeftColor: tone, backgroundColor: alpha(colors.text, 0.03) },
                  m.from === 'reviewer' && { marginLeft: SPACE.md },
                ]}
              >
                <View style={styles.msgHead}>
                  <Chip label={messageChipLabel(m)} color={tone} size="sm" />
                  <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>
                    {route.from} → {route.to}
                  </Text>
                  <Text style={[type.monoSmall, { color: colors.textMuted }]}>R{m.round ?? 1}</Text>
                  {m.ts ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{fmtTime(m.ts)}</Text> : null}
                </View>
                <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={4} selectable>
                  {m.title}
                </Text>
                {m.items.length ? (
                  <View style={{ gap: 2 }}>
                    {m.items.map((it, i) => (
                      <Text key={i} style={[type.caption, { color: colors.textSecondary }]} numberOfLines={5} selectable>
                        {'•'} {it}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {m.evidence.length ? (
                  <View style={{ gap: 2 }}>
                    {m.evidence.map((e, i) => (
                      <EvRow key={i} kind={e.kind} text={e.ref} detail={e.detail} cwd={e.cwd} status={e.status} />
                    ))}
                  </View>
                ) : null}
                {m.actions.length ? (
                  <View style={{ gap: 2 }}>
                    {m.actions.map((a, i) => (
                      <EvRow key={i} kind={a.kind} text={a.detail} cwd={a.cwd} status={a.status} />
                    ))}
                  </View>
                ) : null}
                {m.screenshots.length ? (
                  <View style={styles.shots}>
                    {m.screenshots.slice(0, 3).map((p) => (
                      <Pressable
                        key={p}
                        onPress={() => onOpenShot?.(p)}
                        accessibilityRole="imagebutton"
                        accessibilityLabel="Open screenshot"
                        style={[styles.shot, { borderColor: colors.border }]}
                      >
                        {http?.origin ? (
                          <AuthImage uri={verificationFileUrl(http.origin, p, true)} headers={http.headers} style={StyleSheet.absoluteFill} />
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                ) : null}
                {m.escalation && !isPinned ? <Escalation esc={m.escalation} /> : null}
                {isPinned ? (
                  <Text style={[type.caption, { color: toneColor('accent', colors) }]}>Owner decision pinned above.</Text>
                ) : null}
              </View>
            );
          })}
          {!expanded && messages.length > COMPACT_LIMIT ? (
            <Button title={`Show all ${messages.length}`} variant="ghost" size="sm" onPress={() => setExpanded(true)} />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function EvRow({ kind, text, detail, cwd, status }) {
  const { colors, type } = useUIKit();
  return (
    <View style={styles.evRow}>
      <Text style={[type.monoSmall, { color: colors.textMuted, width: 70 }]} numberOfLines={1}>
        {kind}
      </Text>
      <Text style={[type.monoSmall, { color: colors.textSecondary, flex: 1 }]} numberOfLines={3} selectable>
        {text}
        {detail ? <Text style={{ color: colors.textMuted }}>{`  ${detail}`}</Text> : null}
        {cwd ? <Text style={{ color: colors.textMuted }}>{`  cwd ${cwd}`}</Text> : null}
      </Text>
      {status ? (
        <Text style={[type.monoSmall, { color: toneColor(status === 'skipped' ? 'neutral' : evidenceTone(status), colors) }]}>{status}</Text>
      ) : null}
    </View>
  );
}

function Escalation({ esc }) {
  const { colors, type, alpha } = useUIKit();
  const c = toneColor('accent', colors);
  return (
    <View style={[styles.esc, { borderColor: alpha(c, 0.45), backgroundColor: alpha(c, 0.08) }]} accessibilityRole="alert">
      <View style={styles.msgHead}>
        <Ionicons name="alert-circle-outline" size={14} color={c} />
        <Text style={[type.label, { color: c }]}>Owner decision needed</Text>
      </View>
      <Text style={[type.smallStrong, { color: colors.text }]}>{esc.decision}</Text>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {String(esc.category || '').replace(/_/g, ' ')}: {esc.reason}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs + 2, minHeight: 44 },
  msg: { borderWidth: 1, borderLeftWidth: 3, borderRadius: RADIUS.sm, padding: SPACE.sm + 2, gap: SPACE.xs + 2 },
  msgHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs + 2 },
  evRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACE.xs + 2 },
  shots: { flexDirection: 'row', gap: SPACE.sm },
  shot: { width: 96, height: 60, borderRadius: RADIUS.sm, overflow: 'hidden', borderWidth: 1 },
  esc: { borderWidth: 1, borderRadius: RADIUS.sm, padding: SPACE.sm + 2, gap: 2 },
});

export default ReviewThread;
