/**
 * Searchable CRM client picker — the client twin of ProjectPicker: one
 * component wherever an idea, note, task or project gets a client (quick
 * capture, Ideas, Notes, the task sheet).
 *
 *   <ClientPickerPanel>  search (name / company / email / about) + "No client"
 *                        + Recent + every client of the active business.
 *   <ClientPickerSheet>  the panel in its own BottomSheet.
 *   <ClientField>        form row: current client, "Auto: X · why" /
 *                        "Suggested: X" chip, tap to change.
 *
 * Ranking + filtering live in lib/client-picker-model.js (unit-tested).
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { clientRows, clientSuggestionLabel, findClient } from '../lib/client-picker-model';

function initials(name) {
  const parts = String(name || '?').replace(/[^A-Za-z0-9\u00C0-\u024F\u0E00-\u0E7F ]/g, ' ').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function Monogram({ name, on, colors }) {
  return (
    <View style={[styles.mono, { borderColor: on ? colors.primary : withAlpha(colors.text, 0.18), backgroundColor: withAlpha(colors.primary, on ? 0.2 : 0.06) }]}>
      <Text style={{ color: on ? colors.primary : colors.textSecondary, fontSize: 12, fontWeight: '700' }}>{initials(name)}</Text>
    </View>
  );
}

export function ClientPickerPanel({ clients = [], usage = {}, selectedId, onSelect, onCancel, loading, error, onRetry, suggestion, height, autoFocus = true, testID = 'client-picker' }) {
  const { colors, type } = useUIKit();
  const { height: winH } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => clientRows(clients, query, usage), [clients, query, usage]);
  const h = height || Math.min(560, Math.round(winH * 0.62));
  const line = withAlpha(colors.text, 0.08);

  const renderRow = ({ item }) => {
    if (item.type === 'header') return <Text style={[type.label, styles.header, { color: colors.textMuted }]}>{item.title}</Text>;
    const c = item.client;
    const on = c.id === selectedId;
    const suggested = suggestion?.id === c.id;
    const sub = [c.aliases?.[0], c.status, suggested ? `suggested · ${suggestion.reason || 'AI'}` : null].filter(Boolean).join('  ·  ');
    return (
      <Pressable
        onPress={() => onSelect?.(c)}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={c.name}
        testID={`client-row-${c.id}`}
        style={({ pressed }) => [styles.row, { borderColor: on ? colors.primary : line, backgroundColor: on ? withAlpha(colors.primary, 0.12) : pressed ? withAlpha(colors.text, 0.05) : 'transparent' }]}
      >
        <Monogram name={c.name} on={on} colors={colors} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: on ? colors.primary : colors.text }]} numberOfLines={1}>
            {c.name}
          </Text>
          {sub ? (
            <Text style={[type.caption, { color: suggested ? colors.primary : colors.textMuted }]} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
        {on ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
      </Pressable>
    );
  };

  return (
    <View style={{ height: h, gap: SPACE.sm }} testID={testID}>
      <View style={[styles.search, { borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha('#000000', 0.35) }]}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={`Search ${clients.length || ''} clients`.replace('  ', ' ')}
          placeholderTextColor={withAlpha(colors.text, 0.35)}
          autoFocus={autoFocus}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search clients"
          testID={`${testID}-search`}
          style={[type.body, { flex: 1, minWidth: 0, width: 0, color: colors.text, minHeight: 44 }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={10}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
        {onCancel ? (
          <Pressable onPress={onCancel} accessibilityRole="button" accessibilityLabel="Back" style={styles.cancel} testID={`${testID}-cancel`}>
            <Text style={[type.smallStrong, { color: colors.primary }]}>Cancel</Text>
          </Pressable>
        ) : null}
      </View>

      <Pressable
        onPress={() => onSelect?.(null)}
        accessibilityRole="radio"
        accessibilityState={{ selected: !selectedId }}
        testID={`${testID}-none`}
        style={[styles.row, { borderColor: !selectedId ? colors.primary : line, backgroundColor: !selectedId ? withAlpha(colors.primary, 0.12) : 'transparent' }]}
      >
        <Ionicons name="remove-circle-outline" size={18} color={!selectedId ? colors.primary : colors.textSecondary} />
        <Text style={[type.bodyStrong, { flex: 1, color: !selectedId ? colors.primary : colors.text }]}>No client</Text>
        {!selectedId ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
      </Pressable>

      {loading && !clients.length ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: SPACE.lg }} />
      ) : error && !clients.length ? (
        <Pressable onPress={onRetry} style={styles.empty} accessibilityRole="button">
          <Text style={[type.small, { color: colors.error, textAlign: 'center' }]}>Couldn’t load clients ({error}). Tap to retry.</Text>
        </Pressable>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderRow}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={20}
          windowSize={7}
          contentContainerStyle={{ gap: 6, paddingBottom: SPACE.lg }}
          ListEmptyComponent={<Text style={[type.small, styles.empty, { color: colors.textMuted }]}>No clients yet — add them in Business HQ › Clients.</Text>}
          ListFooterComponent={query && rows.length <= 1 ? <Text style={[type.small, styles.empty, { color: colors.textMuted }]}>No client matches “{query}”.</Text> : null}
        />
      )}
    </View>
  );
}

export function ClientPickerSheet({ visible, onClose, title = 'Choose client', onSelect, ...panel }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} scroll={false} maxHeightRatio={0.9} testID="client-picker-sheet">
      {visible ? (
        <ClientPickerPanel
          {...panel}
          onSelect={(c) => {
            onSelect?.(c);
            onClose?.();
          }}
        />
      ) : null}
    </BottomSheet>
  );
}

/**
 * Form row: the chosen client, an Auto / Suggested chip, tap to change
 * (`onOpen` for inline pickers, else its own sheet when `catalog` is passed).
 */
export function ClientField({ label = 'Client', clientId, clientName, clients = [], suggestion, onChange, onOpen, catalog, disabled, testID = 'client-field' }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = useState(false);
  const list = catalog?.clients?.length ? catalog.clients : clients;
  const current = clientId ? findClient(list, clientId) || { id: clientId, name: clientName || 'Client' } : null;
  const isAuto = !!(suggestion && current && suggestion.id === current.id && suggestion.auto);
  const offer = suggestion && (!current || suggestion.id !== current.id) ? suggestion : null;
  const openPicker = () => {
    if (disabled) return;
    if (onOpen) onOpen();
    else setOpen(true);
  };
  return (
    <View style={{ gap: 6 }} testID={testID}>
      <Text style={[type.label, { color: colors.textMuted }]}>{label}</Text>
      <Pressable
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel={current ? `Client: ${current.name}. Change client` : 'No client. Choose a client'}
        testID={`${testID}-open`}
        style={({ pressed }) => [
          styles.field,
          { borderColor: current ? withAlpha(colors.primary, 0.45) : withAlpha(colors.text, 0.14), backgroundColor: pressed ? withAlpha(colors.primary, 0.08) : withAlpha('#000000', 0.3), opacity: disabled ? 0.5 : 1 },
        ]}
      >
        {current ? <Monogram name={current.name} on colors={colors} /> : <Ionicons name="person-outline" size={18} color={colors.textSecondary} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: current ? colors.text : colors.textSecondary }]} numberOfLines={1} testID={`${testID}-value`}>
            {current ? current.name : 'No client'}
          </Text>
          {current?.aliases?.[0] || current?.status ? (
            <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
              {[current.aliases?.[0], current.status].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
        </View>
        <Text style={[type.smallStrong, { color: colors.primary }]}>{current ? 'Change' : 'Choose'}</Text>
      </Pressable>
      {isAuto ? (
        <View style={[styles.chip, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.1) }]} testID={`${testID}-auto`}>
          <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
          <Text style={[type.caption, { color: colors.primary, flexShrink: 1 }]} numberOfLines={2}>
            {clientSuggestionLabel(suggestion, { selected: true })}
          </Text>
        </View>
      ) : null}
      {offer ? (
        <Pressable
          onPress={() => onChange?.({ id: offer.id, name: offer.name })}
          accessibilityRole="button"
          accessibilityLabel={`Use suggested client ${offer.name}`}
          testID={`${testID}-suggested`}
          style={[styles.chip, { borderColor: withAlpha(colors.text, 0.2), borderStyle: 'dashed' }]}
        >
          <Ionicons name="sparkles-outline" size={14} color={colors.textSecondary} />
          <Text style={[type.caption, { color: colors.textSecondary, flexShrink: 1 }]} numberOfLines={2}>
            {clientSuggestionLabel(offer)} — tap to use
          </Text>
        </Pressable>
      ) : null}
      {catalog && !onOpen ? (
        <ClientPickerSheet
          visible={open}
          onClose={() => setOpen(false)}
          clients={list}
          usage={catalog.usage}
          loading={catalog.loading}
          error={catalog.error}
          onRetry={() => catalog.refresh?.()}
          selectedId={current?.id}
          suggestion={suggestion}
          onSelect={(c) => {
            if (c?.id) catalog.markUsed?.(c.id);
            onChange?.(c ? { id: c.id, name: c.name } : null);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md, paddingRight: SPACE.sm },
  cancel: { minHeight: 44, justifyContent: 'center', paddingHorizontal: SPACE.sm, flexShrink: 0 },
  header: { marginTop: SPACE.sm, marginBottom: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 52, paddingHorizontal: SPACE.md, paddingVertical: 8, borderRadius: RADIUS.md, borderWidth: 1 },
  field: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md, minHeight: 52, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 32, paddingHorizontal: SPACE.md, paddingVertical: 6, borderRadius: RADIUS.pill, borderWidth: 1 },
  mono: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { padding: SPACE.lg, textAlign: 'center' },
});
