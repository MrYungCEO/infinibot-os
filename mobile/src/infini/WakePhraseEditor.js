/**
 * <WakePhraseEditor> — Call options › Listening: the "Hey Infini" phrases.
 *
 *   phrases       editable list (default "hey infini" + variants), add with
 *                 validation (2–5 words, warns on everyday words), remove,
 *                 reset to default
 *   agent name    also wake on "hey <selected agent>"
 *   sensitivity   Low / Normal / High — the VAD threshold and match strictness
 *   test phrase   record once, show the transcript and whether it matched
 *   diagnostics   the on-page wake readout (also: long-press the wake badge)
 *
 * Everything persists per device through useCallOptions prefs.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Slider from '@react-native-community/slider';

import { useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { haptic } from './InfiniFace';
import { CloseIcon, MicIcon, PlusIcon, PulseIcon, RetryIcon } from './icons';
import { DEFAULT_WAKE_PHRASES, SENSITIVITY_ORDER, sensitivityConfig, validateWakePhrase, wakePhrasesFor } from './wake/wake-phrase';

export function WakePhraseEditor({ options, wake, targetTitle }) {
  const { colors, type } = useUIKit();
  const o = options;
  const phrases = Array.isArray(o.prefs.wakePhrases) && o.prefs.wakePhrases.length ? o.prefs.wakePhrases : DEFAULT_WAKE_PHRASES;
  const isDefault = !Array.isArray(o.prefs.wakePhrases) || !o.prefs.wakePhrases.length;
  const [draft, setDraft] = useState('');
  const [check, setCheck] = useState(null); // last validation of the draft
  const sens = sensitivityConfig(o.prefs.wakeSensitivity);
  const sensIndex = Math.max(0, SENSITIVITY_ORDER.indexOf(sens.key));
  const agentPhrase = useMemo(() => wakePhrasesFor(targetTitle, { phrases: ['x x'], agentName: true }).find((p) => p !== 'x x'), [targetTitle]);

  const add = () => {
    const v = validateWakePhrase(draft, phrases);
    if (!v.ok) {
      haptic('warn');
      setCheck(v);
      return;
    }
    // A warning needs a second, deliberate tap.
    if (v.warning && !(check && check.phrase === v.phrase && check.warning)) {
      haptic('warn');
      setCheck(v);
      return;
    }
    haptic('success');
    o.savePrefs({ wakePhrases: [...phrases, v.phrase] });
    setDraft('');
    setCheck(null);
  };
  const remove = (p) => {
    if (phrases.length <= 1) return;
    haptic('light');
    o.savePrefs({ wakePhrases: phrases.filter((x) => x !== p) });
  };
  const reset = () => {
    haptic('medium');
    o.savePrefs({ wakePhrases: null });
    setCheck(null);
  };

  const border = withAlpha(colors.text, 0.1);
  const res = wake?.testResult;

  return (
    <View style={{ gap: SPACE.sm }} testID="wake-phrase-editor">
      <Text style={[type.smallStrong, { color: colors.text }]}>Wake phrases</Text>
      <View style={styles.chips}>
        {phrases.map((p) => (
          <View key={p} style={[styles.chip, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.08) }]}>
            <Text style={[type.small, { color: colors.text }]}>{p}</Text>
            <Pressable
              onPress={() => remove(p)}
              disabled={phrases.length <= 1}
              style={[styles.chipX, { opacity: phrases.length <= 1 ? 0.3 : 1 }]}
              accessibilityRole="button"
              accessibilityLabel={`Remove wake phrase ${p}`}
              testID={`wake-phrase-remove-${p}`}
            >
              <CloseIcon size={15} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}
      </View>
      <View style={[styles.addRow, { borderColor: check?.error ? withAlpha(colors.error, 0.7) : check?.warning ? withAlpha(colors.warning, 0.7) : border }]}>
        <TextInput
          value={draft}
          onChangeText={(t) => {
            setDraft(t);
            if (check) setCheck(null);
          }}
          onSubmitEditing={add}
          placeholder="Add a phrase, e.g. hey nova"
          placeholderTextColor={withAlpha(colors.text, 0.38)}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          style={[type.body, { flex: 1, color: colors.text, minHeight: 44 }]}
          accessibilityLabel="New wake phrase"
          testID="wake-phrase-input"
        />
        <Pressable
          onPress={add}
          disabled={!draft.trim()}
          style={[styles.addBtn, { backgroundColor: withAlpha(colors.primary, draft.trim() ? 0.22 : 0.08), borderColor: withAlpha(colors.primary, 0.5) }]}
          accessibilityRole="button"
          accessibilityLabel={check?.warning ? 'Add this phrase anyway' : 'Add wake phrase'}
          testID="wake-phrase-add"
        >
          <PlusIcon size={18} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.primary }]}>Add</Text>
        </Pressable>
      </View>
      {check?.error ? <Text style={[type.caption, { color: colors.error }]} testID="wake-phrase-error">{check.error}</Text> : null}
      {check?.warning ? (
        <Text style={[type.caption, { color: colors.warning }]} testID="wake-phrase-warning">
          {check.warning} Tap Add again to use it anyway.
        </Text>
      ) : null}
      <Text style={[type.caption, { color: colors.textMuted }]}>2–5 words. Say it at the start of what you say; a request can follow in the same breath.</Text>
      {!isDefault ? (
        <Pressable onPress={reset} style={styles.linkBtn} accessibilityRole="button" accessibilityLabel="Reset wake phrases to default" testID="wake-phrase-reset">
          <RetryIcon size={16} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.primary }]}>Reset to default</Text>
        </Pressable>
      ) : null}

      <View style={[styles.row, { borderColor: border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[type.smallStrong, { color: colors.text }]}>Also wake on the agent’s name</Text>
          <Text style={[type.caption, { color: colors.textMuted }]}>
            {agentPhrase ? `“${agentPhrase}” for the selected target` : 'The selected target has a generic name, so this adds nothing right now'}
          </Text>
        </View>
        <Switch
          value={o.prefs.wakeAgentName !== false}
          onValueChange={(v) => o.savePrefs({ wakeAgentName: v })}
          trackColor={{ true: withAlpha(colors.primary, 0.6) }}
          thumbColor={colors.primary}
          accessibilityLabel="Also wake on hey plus the agent's name"
          testID="wake-agent-name-toggle"
        />
      </View>

      <View style={[styles.block, { borderColor: border }]}>
        <View style={styles.sensHead}>
          <Text style={[type.smallStrong, { color: colors.text }]}>Sensitivity</Text>
          <Text style={[type.smallStrong, { color: colors.primary }]} testID="wake-sensitivity-value">{sens.label}</Text>
        </View>
        <Slider
          minimumValue={0}
          maximumValue={2}
          step={1}
          value={sensIndex}
          onSlidingComplete={(v) => {
            const key = SENSITIVITY_ORDER[Math.round(v)] || 'normal';
            if (key !== sens.key) {
              haptic('light');
              o.savePrefs({ wakeSensitivity: key });
            }
          }}
          onValueChange={(v) => {
            const key = SENSITIVITY_ORDER[Math.round(v)] || 'normal';
            if (key !== sens.key) o.savePrefs({ wakeSensitivity: key });
          }}
          minimumTrackTintColor={colors.primary}
          maximumTrackTintColor={withAlpha(colors.text, 0.2)}
          thumbTintColor={colors.primary}
          style={{ height: 44 }}
          accessibilityLabel={`Wake sensitivity, ${sens.label}`}
          testID="wake-sensitivity"
        />
        <View style={styles.sensLabels}>
          {SENSITIVITY_ORDER.map((k) => (
            <Pressable key={k} onPress={() => o.savePrefs({ wakeSensitivity: k })} style={styles.sensLabel} accessibilityRole="button" accessibilityLabel={`Sensitivity ${sensitivityConfig(k).label}`}>
              <Text style={[type.caption, { color: k === sens.key ? colors.primary : colors.textMuted }]}>{sensitivityConfig(k).label}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[type.caption, { color: colors.textMuted }]}>{sens.hint}</Text>
      </View>

      <View style={[styles.block, { borderColor: border }]}>
        <View style={styles.sensHead}>
          <Text style={[type.smallStrong, { color: colors.text }]}>Test phrase</Text>
          <Pressable
            onPress={() => {
              haptic('light');
              void wake?.runTest?.();
            }}
            disabled={!wake?.runTest || wake?.testing}
            style={[styles.addBtn, { backgroundColor: withAlpha(colors.primary, 0.18), borderColor: withAlpha(colors.primary, 0.5) }]}
            accessibilityRole="button"
            accessibilityLabel="Test phrase: record once and show what was heard"
            testID="wake-test"
          >
            {wake?.testing ? <ActivityIndicator size="small" color={colors.primary} /> : <MicIcon size={17} color={colors.primary} />}
            <Text style={[type.smallStrong, { color: colors.primary }]}>{wake?.testing ? 'Listening…' : 'Test'}</Text>
          </Pressable>
        </View>
        <Text style={[type.caption, { color: colors.textMuted }]}>
          {wake?.testing ? 'Say your wake phrase now.' : 'Records once, sends the clip to your gateway’s Whisper and shows whether it would wake.'}
        </Text>
        {res ? (
          <View style={[styles.result, { borderColor: res.match ? withAlpha(colors.success || '#3fb27f', 0.6) : withAlpha(colors.warning, 0.5) }]} testID="wake-test-result" accessibilityLiveRegion="polite">
            <Text style={[type.small, { color: colors.text }]}>{res.text ? `Heard: “${res.text}”` : 'Heard nothing'}</Text>
            <Text style={[type.smallStrong, { color: res.match ? colors.success || '#3fb27f' : colors.warning }]}>{res.match ? `Would wake (${res.match.phrase})` : 'Would not wake'}</Text>
            {res.reason ? <Text style={[type.caption, { color: colors.textMuted }]}>{res.reason}</Text> : null}
          </View>
        ) : null}
      </View>

      <View style={[styles.row, { borderColor: border }]}>
        <PulseIcon size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={[type.smallStrong, { color: colors.text }]}>Diagnostics</Text>
          <Text style={[type.caption, { color: colors.textMuted }]}>Show mic level, VAD state, last clip and what Whisper heard on the Infini page. Long-press the wake badge to toggle.</Text>
        </View>
        <Switch
          value={o.prefs.wakeDebug === true}
          onValueChange={(v) => o.savePrefs({ wakeDebug: v })}
          trackColor={{ true: withAlpha(colors.primary, 0.6) }}
          thumbColor={colors.primary}
          accessibilityLabel="Wake diagnostics"
          testID="wake-debug-toggle"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  chip: { flexDirection: 'row', alignItems: 'center', minHeight: 44, paddingLeft: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1 },
  chipX: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md, paddingRight: 4, paddingVertical: 4 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, minWidth: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1, justifyContent: 'center' },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 52, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, borderWidth: 1 },
  block: { gap: SPACE.xs, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, borderWidth: 1 },
  sensHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  sensLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  sensLabel: { minHeight: 32, minWidth: 56, justifyContent: 'center', alignItems: 'center' },
  result: { gap: 2, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm, marginTop: SPACE.xs },
});
