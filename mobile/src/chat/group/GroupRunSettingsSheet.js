/**
 * GroupRunSettingsSheet — native twin of the web's <ib-group-run-settings>:
 * the group's model + thinking for every member, and a per-member override,
 * each picked in the shared ModelSheet. Changes go straight to
 * groupchat.update (`settings` / `memberSettings`) through `onChange`.
 */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from '../chat-tokens';
import { ModelSheet } from '../ModelSheet';
import { GroupAvatar } from './GroupAvatar';
import { effectiveSettings, shortModel, SOURCE_LABELS, THINKING_LABELS } from './composer-logic';
import { ChevronDownIcon, ChipIcon, CloseIcon, RetryIcon, SlidersIcon, TerminalIcon, UsersIcon } from '../../infini/icons';
import { tap } from '../../utils/haptics';

export function GroupRunSettingsSheet({ visible, onClose, group, members, agents, sendReq, onChange, error }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  // null | { agentId?: string }
  const [target, setTarget] = useState(null);
  if (!group) return null;
  const s = group.settings || {};
  const agentModel = (id) => agents?.find((a) => a.id === id)?.model || null;

  const targetMember = target?.agentId;
  const own = targetMember ? group.memberSettings?.[targetMember] || {} : s;
  const eff = targetMember ? effectiveSettings(group, targetMember) : null;

  const Trigger = ({ label, onPress, testID }) => (
    <Pressable onPress={() => { tap(); onPress(); }} testID={testID} accessibilityRole="button" style={[styles.trigger, { borderColor: t.borderStrong, backgroundColor: t.surface }]}>
      <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 12.5, fontFamily: t.font.medium, maxWidth: 120 }}>{label}</Text>
      <ChevronDownIcon size={13} color={t.muted} />
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View testID="group-run-settings" style={[styles.sheet, { backgroundColor: t.side, borderColor: t.borderStrong, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <View style={styles.head}>
          <View style={[styles.headIco, { backgroundColor: t.accentSoft }]}><SlidersIcon size={18} color={t.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 16 }}>Models & thinking</Text>
            <Text style={{ color: t.muted, fontSize: 12 }}>Set once for the group, or override one member.</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close"><CloseIcon size={18} color={t.muted} /></Pressable>
        </View>

        <ScrollView style={{ flexGrow: 0 }}>
          <View style={[styles.row, styles.rowGroup, { borderColor: t.accent, backgroundColor: t.surface }]} testID="grs-group">
            <View style={[styles.groupAv, { backgroundColor: t.accentSoft }]}><UsersIcon size={16} color={t.accent} /></View>
            <View style={styles.rowText}>
              <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 14 }}>Whole group</Text>
              <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>
                {s.model ? shortModel(s.model) : "Each agent's own model"} · {s.thinkingLevel ? `${THINKING_LABELS[s.thinkingLevel] || s.thinkingLevel} thinking` : 'default thinking'}
              </Text>
            </View>
            <Trigger label={s.model ? shortModel(s.model) : 'Agent defaults'} onPress={() => setTarget({})} testID="grs-group-trigger" />
          </View>

          <Text style={[styles.section, { color: t.muted }]}>PER MEMBER</Text>
          {members.map((m) => {
            const e = effectiveSettings(group, m.id);
            const mine = group.memberSettings?.[m.id];
            const model = e.model || agentModel(m.id);
            return (
              <View key={m.id} style={[styles.row, { borderColor: t.borderNeutral, backgroundColor: t.surface }]} testID={`grs-member-${m.id}`}>
                <GroupAvatar id={m.id} name={m.name} url={m.avatarUrl} size={32} />
                <View style={styles.rowText}>
                  <Text numberOfLines={1} style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 14 }}>
                    {m.name} <Text style={{ color: t.muted, fontSize: 12, fontFamily: t.font.mono }}>@{m.id}</Text>
                  </Text>
                  <Text numberOfLines={1} style={{ color: t.text, fontSize: 12.5 }}>
                    {model ? shortModel(model) : 'default model'} · {e.thinkingLevel ? THINKING_LABELS[e.thinkingLevel] || e.thinkingLevel : 'default'} thinking
                  </Text>
                  <View style={styles.subRow}>
                    {[['Model', e.source.model], ['Thinking', e.source.thinkingLevel]].map(([field, src]) => (
                      <Text key={field} numberOfLines={1} style={[styles.badge, { color: src === 'member' ? t.accent : t.muted, borderColor: src === 'member' ? t.accent : t.borderNeutral }]}>
                        {`${field}: ${SOURCE_LABELS[src]}`}
                      </Text>
                    ))}
                  </View>
                </View>
                <Pressable onPress={() => { tap(); setTarget({ agentId: m.id }); }} testID={`grs-trigger-${m.id}`} accessibilityRole="button" accessibilityLabel={`Change ${m.name}'s model and thinking`} style={[styles.iconBtn, { borderColor: t.borderStrong, backgroundColor: t.surface }]}>
                  <ChipIcon size={15} color={t.accent} />
                  <ChevronDownIcon size={12} color={t.muted} />
                </Pressable>
                {mine ? (
                  <Pressable onPress={() => { tap(); onChange({ agentId: m.id, patch: null }); }} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Reset ${m.name} to the group settings`} style={[styles.reset, { borderColor: t.borderNeutral }]}>
                    <RetryIcon size={14} color={t.muted} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          {error ? <Text style={[styles.err, { color: t.danger, backgroundColor: t.dangerSubtle }]}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.foot}>
          <TerminalIcon size={14} color={t.accent} />
          <Text style={{ color: t.muted, fontSize: 11.5, flex: 1 }}>Or type /model, /think or /mode in the composer — add @agent for one member.</Text>
          <Pressable onPress={onClose} accessibilityRole="button" style={[styles.done, { backgroundColor: t.accent }]}>
            <Text style={{ color: t.accentForeground, fontFamily: t.font.semiBold, fontSize: 14 }}>Done</Text>
          </Pressable>
        </View>
      </View>

      <ModelSheet
        visible={Boolean(target)}
        onClose={() => setTarget(null)}
        sendReq={sendReq}
        testID={targetMember ? `model-sheet-${targetMember}` : 'model-sheet-group'}
        title={targetMember ? `Model · ${members.find((x) => x.id === targetMember)?.name || targetMember}` : 'Model · whole group'}
        value={own.model || null}
        thinkingLevel={own.thinkingLevel || null}
        defaultLabel={targetMember ? (eff?.source.model === 'member' || !s.model ? 'Use the group setting' : `Group: ${shortModel(s.model)}`) : "Each agent's own model"}
        onSelectModel={(ref) => onChange({ agentId: targetMember, patch: { model: ref } })}
        onSelectThinking={(level) => onChange({ agentId: targetMember, patch: { thinkingLevel: level } })}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '88%', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderBottomWidth: 0, padding: 14, alignSelf: 'center', width: '100%', maxWidth: 720 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  headIco: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 14, padding: 10, marginBottom: 6 },
  rowGroup: { marginBottom: 10 },
  groupAv: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2, flexWrap: 'wrap' },
  badge: { fontSize: 10, borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, overflow: 'hidden', flexShrink: 0 },
  iconBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, minHeight: 34 },
  section: { fontSize: 10.5, letterSpacing: 1.2, marginBottom: 6, marginLeft: 4 },
  trigger: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingHorizontal: 9, minHeight: 34 },
  reset: { width: 32, height: 32, borderWidth: 1, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  err: { fontSize: 12.5, padding: 10, borderRadius: 10, marginTop: 6 },
  foot: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  done: { borderRadius: 12, paddingHorizontal: 18, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
});
