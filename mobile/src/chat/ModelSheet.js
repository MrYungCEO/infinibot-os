/**
 * ModelSheet — native twin of the web's <webchat-model-picker> in sheet mode:
 * a bottom sheet listing every usable model from models.list ("Your models"
 * = the allowlist first, the rest by provider), search, an "Agent default"
 * row, and the thinking level chips. Picking a model outside the allowlist adds
 * it first (models.allowlist.add), exactly like the web picker, so a pick never
 * ends in a gateway rejection.
 *
 * Props: visible, onClose, sendReq, value (model ref | null), thinkingLevel
 * (string | null), defaultLabel, title, onSelectModel(ref | null),
 * onSelectThinking(level | null). Used by the group chat (whole group, each
 * member, the create sheet); reusable for any chat surface.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from './chat-tokens';
import { CheckIcon, ChipIcon, CloseIcon, SearchIcon, BrainIcon } from '../infini/icons';
import { modelRows, needsAllowlistAdd, thinkingOptions, thinkingPatchValue, THINKING_LABELS } from './group/composer-logic';
import { tap } from '../utils/haptics';

function splitRef(ref) {
  const s = String(ref || '');
  const i = s.indexOf('/');
  return i > 0 ? { provider: s.slice(0, i), model: s.slice(i + 1) } : { provider: '', model: s };
}

export function ModelSheet({
  visible,
  onClose,
  sendReq,
  value = null,
  thinkingLevel = null,
  defaultLabel = 'Agent default',
  title = 'Model',
  onSelectModel,
  onSelectThinking,
  testID = 'model-sheet',
}) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(null);

  const load = useCallback(async () => {
    if (typeof sendReq !== 'function') return;
    setLoading(true);
    setError(null);
    try {
      setCatalog(await sendReq('models.list', {}));
    } catch (err) {
      setError(String(err?.message || err).replace(/^Error:\s*/, ''));
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    if (visible && !catalog && !loading) load();
    if (!visible) setQuery('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => modelRows(catalog, query), [catalog, query]);
  const provider = splitRef(value).provider;
  const levels = thinkingOptions(provider);

  const pick = useCallback(async (row) => {
    tap();
    if (row && needsAllowlistAdd(row)) {
      setPending(row.id);
      try {
        await sendReq('models.allowlist.add', { model: row.id });
      } catch (err) {
        setError(String(err?.message || err).replace(/^Error:\s*/, ''));
        setPending(null);
        return;
      }
      setPending(null);
    }
    onSelectModel?.(row ? row.id : null);
    onClose?.();
  }, [sendReq, onSelectModel, onClose]);

  const Row = ({ row }) => {
    const on = Boolean(value) && row.id === value;
    return (
      <Pressable
        onPress={() => pick(row)}
        testID={`${testID}-row-${row.id}`}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        style={({ pressed }) => [styles.row, { backgroundColor: on ? t.accentSoft : pressed ? t.rowHover : 'transparent' }]}
      >
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={{ color: on ? t.accent : t.textStrong, fontSize: 14, fontFamily: t.font.semiBold }}>{row.name}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11.5, fontFamily: t.font.mono }}>{row.provider || row.id}</Text>
        </View>
        {row.free ? <Text style={[styles.tag, { color: t.ok, borderColor: t.borderNeutral }]}>{row.free === 'local' ? 'Local' : 'Free'}</Text> : null}
        {row.reasoning ? <Text style={[styles.tag, { color: t.muted, borderColor: t.borderNeutral }]}>Reasoning</Text> : null}
        {pending === row.id ? <ActivityIndicator size="small" color={t.accent} /> : on ? <CheckIcon size={16} color={t.accent} strokeWidth={2.4} /> : null}
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View testID={testID} style={[styles.sheet, { backgroundColor: t.side, borderColor: t.borderStrong, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={[styles.grab, { backgroundColor: t.borderStrong }]} />
        <View style={styles.head}>
          <ChipIcon size={18} color={t.accent} />
          <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 16, flex: 1 }} numberOfLines={1}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <CloseIcon size={18} color={t.muted} />
          </Pressable>
        </View>
        <View style={[styles.search, { borderColor: t.borderStrong, backgroundColor: t.surface }]}>
          <SearchIcon size={16} color={t.muted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={rows.total ? `Search ${rows.total} models` : 'Search models'}
            placeholderTextColor={t.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.searchInput, { color: t.textStrong, fontFamily: t.font.regular }]}
            accessibilityLabel="Search models"
          />
        </View>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {!query.trim() ? (
            <Pressable
              onPress={() => pick(null)}
              testID={`${testID}-default`}
              accessibilityRole="radio"
              accessibilityState={{ checked: !value }}
              style={({ pressed }) => [styles.row, { backgroundColor: !value ? t.accentSoft : pressed ? t.rowHover : 'transparent' }]}
            >
              <View style={styles.rowText}>
                <Text style={{ color: !value ? t.accent : t.textStrong, fontSize: 14, fontFamily: t.font.semiBold }}>Agent default</Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11.5 }}>{defaultLabel}</Text>
              </View>
              {!value ? <CheckIcon size={16} color={t.accent} strokeWidth={2.4} /> : null}
            </Pressable>
          ) : null}
          {loading && !catalog ? <ActivityIndicator style={{ marginVertical: 18 }} color={t.accent} /> : null}
          {error ? <Text style={[styles.err, { color: t.danger, backgroundColor: t.dangerSubtle }]}>{error}</Text> : null}
          {rows.mine.length ? <Text style={[styles.section, { color: t.muted }]}>YOUR MODELS</Text> : null}
          {rows.mine.map((r) => <Row key={r.id} row={r} />)}
          {rows.groups.map((g) => (
            <View key={g.provider}>
              <Text style={[styles.section, { color: t.muted }]}>{(g.provider || 'other').toUpperCase()}</Text>
              {g.models.map((r) => <Row key={r.id} row={r} />)}
            </View>
          ))}
          {catalog && rows.total === 0 ? <Text style={{ color: t.muted, textAlign: 'center', marginVertical: 16 }}>No models match.</Text> : null}
        </ScrollView>
        {onSelectThinking ? (
          <View style={[styles.think, { borderTopColor: t.borderNeutral }]}>
            <View style={styles.thinkHead}>
              <BrainIcon size={15} color={t.accent} />
              <Text style={{ color: t.text, fontSize: 12.5, fontFamily: t.font.semiBold }}>Thinking</Text>
            </View>
            <View style={styles.thinkChips}>
              {levels.map((lvl) => {
                const cur = thinkingLevel || '';
                const on = lvl === cur || (lvl === 'on' && cur && cur !== 'off');
                return (
                  <Pressable
                    key={lvl || 'auto'}
                    testID={`${testID}-think-${lvl || 'auto'}`}
                    onPress={() => { tap(); onSelectThinking(thinkingPatchValue(lvl)); }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={[styles.chip, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accentSoft : t.surface }]}
                  >
                    <Text style={{ color: on ? t.accent : t.text, fontSize: 12.5, fontFamily: t.font.medium }}>{lvl ? (THINKING_LABELS[lvl] || (lvl === 'on' ? 'On' : lvl)) : 'Auto'}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '84%', borderTopLeftRadius: 22, borderTopRightRadius: 22, borderWidth: 1, borderBottomWidth: 0, paddingHorizontal: 12, alignSelf: 'center', width: '100%', maxWidth: 720 },
  grab: { width: 40, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 8, marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6, paddingVertical: 6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, marginHorizontal: 4, marginBottom: 6, minHeight: 42 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8, outlineStyle: 'none' },
  list: { flexGrow: 0 },
  section: { fontSize: 10.5, letterSpacing: 1.2, marginTop: 10, marginBottom: 2, paddingHorizontal: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingHorizontal: 10, borderRadius: 10 },
  rowText: { flex: 1, minWidth: 0 },
  tag: { fontSize: 10, borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  err: { fontSize: 12.5, padding: 10, borderRadius: 10, marginVertical: 8 },
  think: { borderTopWidth: 1, paddingTop: 10, marginTop: 6 },
  thinkHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, marginBottom: 8 },
  thinkChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 4, paddingBottom: 4 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, minHeight: 34, justifyContent: 'center' },
});
