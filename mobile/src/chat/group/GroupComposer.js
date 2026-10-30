/**
 * GroupComposer — the group chat's message box (web `.gc-dock`): the same
 * glass pill as ChatComposer, plus
 *   - @mention autocomplete at the caret (members + "Everyone"),
 *   - quick @chips per member ("ask only X"),
 *   - a live "who will reply" hint from the gateway's own planner,
 *   - Stop (all agents) while a round runs — and sending stays enabled, so you
 *     can interject mid-round like on the web,
 *   - composer parity with the 1:1 chat: image attachments (shared
 *     useImageAttach), group slash commands with suggestions (/model, /think,
 *     /mode, /stop, /help), and a "Models & thinking" chip (group model +
 *     thinking, per-member overrides).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from '../chat-tokens';
import { useSecureAccent } from '../../secure/SecureControls';
import { GroupAvatar } from './GroupAvatar';
import { appendMention, applyMention, mentionQueryAt, replyHint, suggestMembers } from './group-logic';
import { slashSuggestions, supportsComposerParity } from './composer-logic';
import { useImageAttach } from '../useImageAttach';
import { CloseIcon, PaperclipIcon, SlidersIcon, TerminalIcon } from '../../infini/icons';
import { success, tap } from '../../utils/haptics';

export function GroupComposer({ members, group, busy, sending, disabled, onSend, onStop, onHeightChange, initialDraft = '', onOpenSettings, settingsLabel, secure = false }) {
  const t = useChatTokens();
  const secureColor = useSecureAccent();
  const [text, setText] = useState(initialDraft);
  const [sel, setSel] = useState({ start: initialDraft.length, end: initialDraft.length });
  const [forcedSel, setForcedSel] = useState(null);
  const [focused, setFocused] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const inputRef = useRef(null);
  const [images, setImages] = useState([]);
  const [cmdIndex, setCmdIndex] = useState(0);
  const addImage = useCallback((img) => setImages((cur) => [...cur, { ...img, key: `${Date.now()}-${cur.length}` }]), []);
  const { attach } = useImageAttach(addImage);
  const parity = supportsComposerParity(group);
  const cmds = useMemo(() => (parity ? slashSuggestions(text) : []), [text, parity]);
  useEffect(() => setCmdIndex(0), [text]);

  const mention = useMemo(() => (focused || Platform.OS === 'web' ? mentionQueryAt(text, sel.start) : null), [text, sel.start, focused]);
  const sugg = useMemo(() => (mention ? suggestMembers(members, mention.query) : []), [mention, members]);
  useEffect(() => setMentionIndex(0), [mention?.query]);
  useEffect(() => {
    if (!forcedSel) return undefined;
    const id = setTimeout(() => setForcedSel(null), 50);
    return () => clearTimeout(id);
  }, [forcedSel]);

  const hint = useMemo(() => replyHint(text, group, members), [text, group, members]);
  const canSend = (text.trim().length > 0 || images.length > 0) && !disabled && !sending;

  const submit = useCallback(async () => {
    if (!canSend) return;
    success();
    const ok = await onSend(text, images);
    if (ok !== false) {
      setText('');
      setImages([]);
      setSel({ start: 0, end: 0 });
    }
  }, [canSend, onSend, text, images]);

  const pickCommand = useCallback((name) => {
    tap();
    const next = `/${name} `;
    setText(next);
    setSel({ start: next.length, end: next.length });
    setForcedSel({ start: next.length, end: next.length });
    inputRef.current?.focus();
  }, []);

  const pick = useCallback((id) => {
    if (!mention) return;
    tap();
    const res = applyMention(text, mention.start, sel.start, id);
    setText(res.text);
    setSel({ start: res.caret, end: res.caret });
    setForcedSel({ start: res.caret, end: res.caret });
    inputRef.current?.focus();
  }, [mention, text, sel.start]);

  const quick = useCallback((id) => {
    tap();
    const next = appendMention(text, id);
    setText(next);
    setSel({ start: next.length, end: next.length });
    setForcedSel({ start: next.length, end: next.length });
    inputRef.current?.focus();
  }, [text]);

  return (
    <View onLayout={(e) => onHeightChange?.(e.nativeEvent.layout.height)}>
      {cmds.length ? (
        <View style={[styles.sugg, { backgroundColor: t.side, borderColor: t.borderStrong }]} accessibilityRole="menu" testID="group-commands">
          {cmds.map((c, i) => (
            <Pressable
              key={c.name}
              onPress={() => pickCommand(c.name)}
              accessibilityRole="menuitem"
              testID={`group-command-${c.name}`}
              style={({ pressed }) => [styles.suggRow, { backgroundColor: i === cmdIndex || pressed ? t.accentSoft : 'transparent' }]}
            >
              <TerminalIcon size={16} color={t.accent} />
              <View style={{ flex: 1, minWidth: 0, paddingVertical: 4 }}>
                <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 12.5, fontFamily: t.font.mono }}>{c.usage}</Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11.5 }}>{c.description}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
      {sugg.length ? (
        <View style={[styles.sugg, { backgroundColor: t.side, borderColor: t.borderStrong }]} accessibilityRole="menu">
          {sugg.map((m, i) => (
            <Pressable
              key={m.id}
              onPress={() => pick(m.id)}
              accessibilityRole="menuitem"
              testID={`group-mention-${m.id}`}
              accessibilityLabel={`Mention ${m.name}`}
              style={({ pressed }) => [styles.suggRow, { backgroundColor: i === mentionIndex || pressed ? t.accentSoft : 'transparent' }]}
            >
              <GroupAvatar id={m.id} name={m.name} url={m.avatarUrl} size={24} />
              <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 14, fontFamily: t.font.medium, flex: 1 }}>{m.name}</Text>
              <Text style={{ color: t.muted, fontSize: 12, fontFamily: t.font.mono }}>@{m.id}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {members.length > 1 || (onOpenSettings && parity) ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.quick} accessibilityLabel="Mention an agent">
          {onOpenSettings && parity ? (
            <Pressable
              onPress={() => { tap(); onOpenSettings(); }}
              testID="group-settings-chip"
              accessibilityRole="button"
              accessibilityLabel={`Models and thinking: ${settingsLabel || 'agent defaults'}`}
              style={({ pressed }) => [styles.qchip, styles.setChip, { borderColor: t.accent, backgroundColor: pressed ? t.accentSoft : t.side }]}
            >
              <SlidersIcon size={13} color={t.accent} />
              <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 12, fontFamily: t.font.medium, maxWidth: 190 }}>{settingsLabel || 'Agent defaults'}</Text>
            </Pressable>
          ) : null}
          {(members.length > 1 ? members : []).map((m) => (
            <Pressable
              key={m.id}
              onPress={() => quick(m.id)}
              accessibilityRole="button"
              accessibilityLabel={`Ask only ${m.name}`}
              style={({ pressed }) => [styles.qchip, { borderColor: t.borderNeutral, backgroundColor: pressed ? t.accentSoft : t.side }]}
            >
              <Text style={{ color: t.text, fontSize: 12, fontFamily: t.font.medium }}>@{m.id}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <View style={[styles.box, { borderRadius: t.radius.composer, borderColor: secure ? secureColor : focused ? t.accent : t.borderStrong, ...(secure ? { borderWidth: 2 } : null), backgroundColor: t.side, shadowColor: secure ? secureColor : focused ? t.accent : '#000' }]}>
        {images.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.atts} testID="group-attachments">
            {images.map((img) => (
              <View key={img.key}>
                <Image source={{ uri: img.uri || `data:${img.mimeType};base64,${img.base64}` }} style={[styles.att, { borderColor: t.border }]} />
                <Pressable
                  onPress={() => setImages((cur) => cur.filter((x) => x.key !== img.key))}
                  hitSlop={10}
                  style={[styles.attX, { backgroundColor: t.side, borderColor: t.borderStrong }]}
                  accessibilityRole="button"
                  accessibilityLabel="Remove image"
                >
                  <CloseIcon size={11} color={t.text} strokeWidth={2.2} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.row}>
          {parity ? (
            <Pressable onPress={attach} disabled={disabled} hitSlop={6} style={styles.tool} accessibilityRole="button" accessibilityLabel="Attach an image" testID="group-attach">
              <PaperclipIcon size={19} color={disabled ? t.mutedStrong : t.muted} />
            </Pressable>
          ) : <View style={{ width: 8 }} />}
          <TextInput
            ref={inputRef}
            testID="group-input"
            value={text}
            onChangeText={setText}
            selection={forcedSel || undefined}
            onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder={disabled ? 'Connecting…' : images.length ? 'Add a caption' : 'Message the group'}
            placeholderTextColor={t.muted}
            multiline
            rows={1}
            maxLength={8000}
            editable={!disabled}
            blurOnSubmit={false}
            onKeyPress={(e) => {
              if (Platform.OS !== 'web') return;
              const k = e.nativeEvent.key;
              if (cmds.length && (k === 'ArrowDown' || k === 'ArrowUp')) {
                e.preventDefault?.();
                setCmdIndex((i) => (i + (k === 'ArrowDown' ? 1 : -1) + cmds.length) % cmds.length);
                return;
              }
              if (cmds.length && (k === 'Tab' || (k === 'Enter' && cmds[cmdIndex]?.name !== text.slice(1)))) {
                e.preventDefault?.();
                pickCommand(cmds[cmdIndex]?.name ?? cmds[0].name);
                return;
              }
              if (sugg.length && (k === 'ArrowDown' || k === 'ArrowUp')) {
                e.preventDefault?.();
                setMentionIndex((i) => (i + (k === 'ArrowDown' ? 1 : -1) + sugg.length) % sugg.length);
                return;
              }
              if (sugg.length && (k === 'Enter' || k === 'Tab')) {
                e.preventDefault?.();
                pick(sugg[mentionIndex]?.id ?? sugg[0].id);
                return;
              }
              if (k === 'Enter' && !e.nativeEvent.shiftKey) {
                e.preventDefault?.();
                submit();
              }
            }}
            accessibilityLabel="Message the group"
            style={[styles.input, { color: t.textStrong, fontFamily: t.font.regular, fontSize: t.type.body, lineHeight: Math.round(t.type.body * 1.5) }]}
          />
          {!text && parity ? (
            <Pressable
              onPress={() => { tap(); setText('/'); setSel({ start: 1, end: 1 }); setForcedSel({ start: 1, end: 1 }); inputRef.current?.focus(); }}
              hitSlop={6}
              style={styles.tool}
              accessibilityRole="button"
              accessibilityLabel="Group commands"
              testID="group-commands-button"
            >
              <TerminalIcon size={19} color={t.muted} />
            </Pressable>
          ) : null}
          {busy ? (
            <Pressable
              onPress={() => { tap(); onStop?.(); }}
              style={[styles.stop, { borderColor: t.danger, backgroundColor: t.dangerSubtle }]}
              accessibilityRole="button"
              accessibilityLabel="Stop all agents"
              testID="group-stop"
            >
              <Ionicons name="stop" size={12} color={t.danger} />
              <Text style={{ color: t.danger, fontSize: 12, fontFamily: t.font.semiBold }}>Stop</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={submit}
            disabled={!canSend}
            style={({ pressed }) => [styles.send, { width: t.size.sendButton + 4, height: t.size.sendButton + 4, backgroundColor: t.accent, opacity: canSend ? 1 : 0.3, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
            accessibilityRole="button"
            accessibilityLabel="Send to the group"
            testID="group-send"
            accessibilityState={{ disabled: !canSend }}
          >
            <Ionicons name="arrow-up" size={18} color={t.accentForeground} />
          </Pressable>
        </View>
      </View>
      <Text numberOfLines={1} style={[styles.hint, { color: t.muted }]}>
        {busy ? 'You can keep typing — agents see new messages on their next turn.' : hint}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sugg: { borderWidth: 1, borderRadius: 14, paddingVertical: 4, marginBottom: 6, overflow: 'hidden' },
  suggRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 12 },
  quick: { gap: 6, paddingBottom: 6, paddingHorizontal: 2 },
  qchip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 30, justifyContent: 'center' },
  box: { borderWidth: 1, paddingLeft: 6, paddingRight: 8, paddingVertical: 6, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: { flex: 1, minHeight: 38, maxHeight: 140, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 2, outlineStyle: 'none' },
  stop: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, height: 34 },
  send: { borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 11, textAlign: 'center', marginTop: 5 },
  tool: { width: 36, height: 38, alignItems: 'center', justifyContent: 'center' },
  setChip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  atts: { gap: 10, paddingLeft: 8, paddingTop: 8, paddingBottom: 4, paddingRight: 8 },
  att: { width: 56, height: 56, borderRadius: 10, borderWidth: 1 },
  attX: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
