/**
 * GroupSheet — create a group chat or edit its members / mode. The native twin
 * of the web's <ib-group-chat-dialog>: name, agents (order = who speaks first),
 * who replies (Everyone / Round robin / Moderator), the moderator pick, and
 * the group's model + thinking (the shared ModelSheet).
 * Presentational: `onSubmit({ title, members, mode, moderatorId, settings?, secure? })`;
 * the host does the RPC and passes `busy` / `error` back.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from '../chat-tokens';
import { GroupAvatar } from './GroupAvatar';
import { BindingFields } from './GroupContext';
import { MODES, MODE_LABELS, rosterName } from './group-logic';
import { shortModel, THINKING_LABELS } from './composer-logic';
import { ModelSheet } from '../ModelSheet';
import { ChevronDownIcon, ChipIcon } from '../../infini/icons';
import { tap } from '../../utils/haptics';
import { SecureToggle } from '../../secure/SecureControls';

export function GroupSheet({ visible, onClose, agents, initial, heading = 'New group chat', submitLabel = 'Create group', busy, error, onSubmit, sendReq, repo, allowSecure = false, defaultSecure = false }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState([]);
  const [mode, setMode] = useState('everyone');
  const [moderatorId, setModeratorId] = useState('');
  const [filter, setFilter] = useState('');
  const [binding, setBinding] = useState({});
  const [settings, setSettings] = useState({});
  const [modelOpen, setModelOpen] = useState(false);
  const [secure, setSecure] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setTitle(initial?.title ?? '');
    setMembers([...(initial?.members ?? [])]);
    setMode(initial?.mode ?? 'everyone');
    setModeratorId(initial?.moderatorId ?? '');
    setBinding({ ...(initial?.binding ?? {}) });
    setFilter('');
    setSettings({ ...(initial?.settings ?? {}) });
    setSecure(Boolean(allowSecure && defaultSecure));
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (agents || []).filter((a) => !f || a.id.toLowerCase().includes(f) || rosterName(agents, a.id).toLowerCase().includes(f));
  }, [agents, filter]);

  if (!visible) return null;

  const toggle = (id) => { tap(); setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id])); };
  const lead = members.includes(moderatorId) ? moderatorId : members[0];
  const submit = () => {
    if (!members.length || busy) return;
    onSubmit({
      title: title.trim(),
      members,
      mode,
      moderatorId: lead,
      binding: Object.keys(binding).length ? binding : null,
      ...(settings.model || settings.thinkingLevel ? { settings: { ...settings } } : {}),
      ...(allowSecure && secure ? { secure: true } : {}),
    });
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav} pointerEvents="box-none">
        <View testID="group-sheet" style={[styles.sheet, { backgroundColor: t.side, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 12) }]} accessibilityViewIsModal>
          <View style={[styles.grip, { backgroundColor: t.borderNeutral }]} />
          <View style={styles.head}>
            <View style={[styles.headIco, { backgroundColor: t.accentSoft, borderColor: t.borderStrong }]}>
              <Ionicons name="people" size={16} color={t.accent} />
            </View>
            <Text style={[styles.heading, { color: t.textStrong, fontFamily: t.font.semiBold }]} accessibilityRole="header">{heading}</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.x} accessibilityRole="button" accessibilityLabel="Close">
              <Ionicons name="close" size={20} color={t.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Name</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="e.g. Launch crew (optional)"
              testID="group-sheet-title"
              placeholderTextColor={t.mutedStrong}
              maxLength={120}
              accessibilityLabel="Group name"
              style={[styles.input, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.surface, fontFamily: t.font.regular }]}
            />

            {allowSecure ? (
              <View style={{ gap: 4 }}>
                <SecureToggle value={secure} onChange={setSecure} label="Secure group" testID="group-sheet-secure" />
                <Text style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>
                  Local models only, encrypted on this gateway, never synced. Needs Secure Mode on.
                </Text>
              </View>
            ) : null}

            <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>
              Agents <Text style={{ color: t.muted, fontFamily: t.font.regular }}>· {members.length} selected — order sets who speaks first</Text>
            </Text>
            {members.length ? (
              <View style={styles.chosen}>
                {members.map((id, i) => (
                  <View key={id} style={[styles.pill, { borderColor: t.borderStrong, backgroundColor: t.accentSoft }]}>
                    <Text style={{ color: t.accent, fontFamily: t.font.bold, fontSize: 11 }}>{i + 1}</Text>
                    <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 13, fontFamily: t.font.medium, maxWidth: 120 }}>{rosterName(agents, id)}</Text>
                    <Pressable onPress={() => toggle(id)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${rosterName(agents, id)}`}>
                      <Ionicons name="close" size={14} color={t.muted} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            {(agents || []).length > 8 ? (
              <View style={[styles.search, { borderColor: t.borderNeutral, backgroundColor: t.surface }]}>
                <Ionicons name="search" size={15} color={t.muted} />
                <TextInput
                  value={filter}
                  onChangeText={setFilter}
                  placeholder="Search agents"
                  placeholderTextColor={t.mutedStrong}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Search agents"
                  style={[styles.searchInput, { color: t.text }]}
                />
              </View>
            ) : null}
            <View style={[styles.agents, { borderColor: t.borderNeutral }]}>
              {list.map((a) => {
                const on = members.includes(a.id);
                const name = rosterName(agents, a.id);
                return (
                  <Pressable
                    key={a.id}
                    onPress={() => toggle(a.id)}
                    testID={`group-sheet-agent-${a.id}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={name}
                    style={({ pressed }) => [styles.agent, { backgroundColor: on ? t.accentSoft : pressed ? t.rowHover : 'transparent' }]}
                  >
                    <GroupAvatar id={a.id} name={name} url={a.identity?.avatarUrl} size={30} />
                    <View style={styles.flex}>
                      <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 14, fontFamily: t.font.medium }}>{name}</Text>
                      <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, fontFamily: t.font.mono }}>@{a.id}</Text>
                    </View>
                    <View style={[styles.check, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accent : 'transparent' }]}>
                      {on ? <Ionicons name="checkmark" size={14} color={t.accentForeground} /> : null}
                    </View>
                  </Pressable>
                );
              })}
              {list.length === 0 ? <Text style={[styles.none, { color: t.muted }]}>No agents match.</Text> : null}
            </View>

            <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Who replies</Text>
            <View style={styles.modes} accessibilityRole="radiogroup">
              {MODES.map((m) => {
                const on = mode === m;
                return (
                  <Pressable
                    key={m}
                    onPress={() => { tap(); setMode(m); }}
                    testID={`group-sheet-mode-${m}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={[styles.mode, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accentSoft : t.surface }]}
                  >
                    <View style={[styles.radio, { borderColor: on ? t.accent : t.mutedStrong }]}>{on ? <View style={[styles.radioDot, { backgroundColor: t.accent }]} /> : null}</View>
                    <View style={styles.flex}>
                      <Text style={{ color: t.textStrong, fontSize: 14, fontFamily: t.font.semiBold }}>{MODE_LABELS[m].label}</Text>
                      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>{MODE_LABELS[m].hint}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.tip, { color: t.muted }]}>Tip: @mention an agent in any message to have just them answer.</Text>

            {sendReq ? (
              <>
                <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>
                  Model & thinking <Text style={{ color: t.muted, fontFamily: t.font.regular }}>· for every member</Text>
                </Text>
                <Pressable
                  onPress={() => { tap(); setModelOpen(true); }}
                  testID="group-sheet-model"
                  accessibilityRole="button"
                  accessibilityLabel="Model and thinking for the group"
                  style={[styles.modelBtn, { borderColor: t.borderNeutral, backgroundColor: t.surface }]}
                >
                  <ChipIcon size={17} color={t.accent} />
                  <View style={styles.flex}>
                    <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 14, fontFamily: t.font.medium }}>{settings.model ? shortModel(settings.model) : 'Agent defaults'}</Text>
                    <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>
                      {settings.thinkingLevel ? `${THINKING_LABELS[settings.thinkingLevel] || settings.thinkingLevel} thinking` : 'Default thinking'} · per-member overrides live under the sliders button
                    </Text>
                  </View>
                  <ChevronDownIcon size={15} color={t.muted} />
                </Pressable>
              </>
            ) : null}

            {mode === 'moderator' && members.length ? (
              <>
                <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Moderator (lead)</Text>
                <View style={styles.chosen}>
                  {members.map((id) => {
                    const on = lead === id;
                    return (
                      <Pressable
                        key={id}
                        onPress={() => { tap(); setModeratorId(id); }}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        style={[styles.pill, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accentSoft : t.surface }]}
                      >
                        <GroupAvatar id={id} name={rosterName(agents, id)} size={20} />
                        <Text style={{ color: on ? t.textStrong : t.text, fontSize: 13, fontFamily: t.font.medium }}>{rosterName(agents, id)}</Text>
                        {on ? <Ionicons name="star" size={12} color={t.accent} /> : null}
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <BindingFields value={binding} onChange={setBinding} sendReq={sendReq} repo={repo} />

            {error ? (
              <Text style={[styles.error, { color: t.danger, borderColor: t.danger, backgroundColor: t.dangerSubtle }]} accessibilityLiveRegion="polite">{error}</Text>
            ) : null}
          </ScrollView>

          <View style={[styles.foot, { borderTopColor: t.borderNeutral }]}>
            <Pressable onPress={onClose} style={[styles.btn, { borderColor: t.borderNeutral }]} accessibilityRole="button">
              <Text style={{ color: t.text, fontFamily: t.font.semiBold, fontSize: 14 }}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={submit}
              testID="group-sheet-submit"
              disabled={!members.length || busy}
              style={[styles.btn, styles.btnPrimary, { backgroundColor: t.accent, opacity: !members.length || busy ? 0.4 : 1 }]}
              accessibilityRole="button"
              accessibilityState={{ disabled: !members.length || busy }}
            >
              {busy ? <ActivityIndicator size="small" color={t.accentForeground} /> : null}
              <Text style={{ color: t.accentForeground, fontFamily: t.font.semiBold, fontSize: 14 }}>{busy ? 'Saving…' : submitLabel}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ModelSheet
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        sendReq={sendReq}
        testID="model-sheet-create"
        title="Model · whole group"
        value={settings.model || null}
        thinkingLevel={settings.thinkingLevel || null}
        defaultLabel="Each agent's own model"
        onSelectModel={(ref) => setSettings(({ model: _m, ...rest }) => (ref ? { ...rest, model: ref } : rest))}
        onSelectThinking={(level) => setSettings(({ thinkingLevel: _t, ...rest }) => (level ? { ...rest, thinkingLevel: level } : rest))}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  modelBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 52 },
  flex: { flex: 1, minWidth: 0 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  kav: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, paddingTop: 8 },
  grip: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, minHeight: 44 },
  headIco: { width: 30, height: 30, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, fontSize: 17 },
  x: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  scroll: { flexGrow: 0 },
  body: { paddingHorizontal: 16, paddingBottom: 12 },
  label: { fontSize: 12, letterSpacing: 0.3, marginTop: 14, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 44, fontSize: 15, outlineStyle: 'none' },
  chosen: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 32 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 40, marginBottom: 6 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8, outlineStyle: 'none' },
  agents: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', maxHeight: 280 },
  agent: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingHorizontal: 10 },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  none: { padding: 14, fontSize: 13 },
  modes: { gap: 8 },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 12, minHeight: 56 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 9, height: 9, borderRadius: 5 },
  tip: { fontSize: 12, marginTop: 8 },
  error: { marginTop: 12, borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13, overflow: 'hidden' },
  foot: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  btn: { flex: 1, minHeight: 46, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  btnPrimary: { borderWidth: 0 },
});
