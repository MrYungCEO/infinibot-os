/**
 * <WakeDebugPanel> — the on-page "Hey Infini" diagnostics readout.
 *
 * Shown when Call options › Listening › Diagnostics is on (or after a
 * long-press on the wake badge). One glance tells why a wake did or didn't
 * happen on the real phone: the live mic level (and raw dB) against the VAD
 * threshold, the VAD state, the last clip's length and STT time, what
 * Whisper heard, and whether the matcher accepted it — with the reason.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useUIKit, SPACE, RADIUS } from '../ui-kit';
import { GLASS } from './Glass';
import { CloseIcon, PulseIcon } from './icons';
import { sensitivityConfig } from './wake/wake-phrase';

const VAD_LABEL = {
  off: 'off',
  silence: 'quiet',
  voiced: 'voice',
  hangover: 'voice (pause)',
  overflow: 'long sound',
  native: 'on-device',
};

export function describeWakeMode(wakeState, { enabled, micMuted }) {
  if (micMuted) return 'muted (mic off)';
  if (!enabled) return 'off (turn on in Call options)';
  const m = wakeState?.mode || 'off';
  if (m === 'paused') return `paused (${wakeState.pausedFor === 'call' ? 'call in progress' : wakeState.pausedFor || 'held'})`;
  return m;
}

export function WakeDebugPanel({ snap, wakeState, enabled, micMuted, tier, sensitivity, onClose, style }) {
  const { type } = useUIKit();
  const d = snap || {};
  const sens = sensitivityConfig(sensitivity);
  const level = Math.max(0, Math.min(1, Number(d.level) || 0));
  const thr = Math.max(0, Math.min(1, Number(d.threshold ?? sens.threshold)));
  const hot = level >= thr;
  const mono = [type.monoSmall, styles.mono];
  const matchColor = d.match == null ? GLASS.textMuted : d.match ? '#7be3a8' : '#f2a39b';

  return (
    <View style={[styles.panel, style]} testID="infini-wake-debug" accessibilityLabel="Wake diagnostics" accessible={false}>
      <View style={styles.head}>
        <PulseIcon size={14} color={GLASS.gold} />
        <Text style={[type.label, { color: GLASS.gold, flex: 1 }]} numberOfLines={1}>
          Wake diagnostics
        </Text>
        {onClose ? (
          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Hide wake diagnostics" hitSlop={8}>
            <CloseIcon size={15} color={GLASS.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.row}>
        <Text style={[mono, styles.key]}>Mic</Text>
        <View style={styles.meter} accessibilityLabel={`Mic level ${Math.round(level * 100)} percent`}>
          <View style={[styles.meterFill, { width: `${level * 100}%`, backgroundColor: hot ? '#6fd8ff' : 'rgba(233,185,73,0.75)' }]} />
          <View style={[styles.thr, { left: `${thr * 100}%` }]} />
        </View>
        <Text style={[mono, styles.val]} numberOfLines={1}>
          {d.db == null ? '— dB' : `${d.db} dB`}
        </Text>
      </View>
      <Text style={mono} numberOfLines={1}>
        <Text style={styles.key}>VAD </Text>
        {VAD_LABEL[d.vad] || d.vad || 'off'} · thr {thr.toFixed(2)}
      </Text>
      <Text style={mono} numberOfLines={2}>
        <Text style={styles.key}>Wake </Text>
        {describeWakeMode(wakeState, { enabled, micMuted })} · {tier || 'gateway'} · {sens.label}
        {d.clips ? ` · ${d.clips} clip${d.clips > 1 ? 's' : ''}` : ''}
      </Text>
      <Text style={mono} numberOfLines={1}>
        <Text style={styles.key}>Clip </Text>
        {d.clipMs != null ? `${(d.clipMs / 1000).toFixed(1)} s` : '—'}
        {d.sttMs != null ? ` · STT ${d.sttMs} ms` : ''}
      </Text>
      <Text style={mono} numberOfLines={2}>
        <Text style={styles.key}>Heard </Text>
        {d.text ? `“${d.text}”` : '—'}
      </Text>
      <Text style={[mono, { color: matchColor }]} numberOfLines={2} testID="infini-wake-debug-match">
        <Text style={styles.key}>Match </Text>
        {d.match == null ? '—' : d.match ? 'YES' : 'no'}
        {d.reason ? ` — ${d.reason}` : ''}
      </Text>
      {d.error ? (
        <Text style={[mono, { color: '#f2a39b' }]} numberOfLines={2}>
          {d.error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 2,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(111,216,255,0.35)',
    backgroundColor: 'rgba(6,12,16,0.86)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, minHeight: 24 },
  close: { width: 28, height: 24, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  mono: { color: '#d8e9ef', fontSize: 11.5, lineHeight: 16 },
  key: { color: 'rgba(191,239,255,0.7)' },
  val: { width: 56, textAlign: 'right' },
  meter: { flex: 1, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  meterFill: { height: 8, borderRadius: 4 },
  thr: { position: 'absolute', top: -2, width: 2, height: 12, backgroundColor: '#fbe6a2' },
});
