/**
 * AgentSwitcher — the header chip + picker for "which agent am I talking to",
 * matching the web chat's agent menu (`.wc-agent-*`): filterable roster, name
 * and id per row, a check on the current one. The agent is part of the session
 * key, so picking another agent opens a fresh chat with it (same as the web).
 */
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatTokens } from './chat-tokens';
import { agentLabel } from './session-sync';
import { tap } from '../utils/haptics';

function Monogram({ name, active }) {
  const t = useChatTokens();
  const letters = String(name || '?').replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  return (
    <View style={[styles.mono, { backgroundColor: active ? t.accentSoft : t.surfaceStrong, borderColor: active ? t.borderStrong : t.borderNeutral }]}>
      <Text style={{ color: active ? t.accent : t.muted, fontFamily: t.font.semiBold, fontSize: 11 }}>{letters}</Text>
    </View>
  );
}

export function AgentChip({ agents, agentId, onPress, disabled }) {
  const t = useChatTokens();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Agent: ${agentLabel(agents, agentId)}. Change agent`}
      style={({ pressed }) => [styles.chip, { borderColor: t.borderNeutral, backgroundColor: pressed ? t.rowHover : t.surface }]}
    >
      <Text numberOfLines={1} style={{ color: t.text, fontFamily: t.font.medium, fontSize: 12, maxWidth: 150 }}>
        {agentLabel(agents, agentId)}
      </Text>
      <Ionicons name="chevron-down" size={12} color={t.muted} />
    </Pressable>
  );
}

export function AgentPicker({ visible, onClose, agents, agentId, onPick }) {
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState('');
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = Array.isArray(agents) ? agents : [];
    if (!q) return list;
    return list.filter((a) => a.id.toLowerCase().includes(q) || agentLabel(list, a.id).toLowerCase().includes(q));
  }, [agents, filter]);
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close agent picker" />
      <View style={[styles.sheet, { backgroundColor: t.side, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={[styles.grip, { backgroundColor: t.borderNeutral }]} />
        <Text style={[styles.title, { color: t.textStrong, fontFamily: t.font.semiBold }]}>Switch agent</Text>
        <Text style={[styles.sub, { color: t.muted }]}>Picking another agent starts a new chat with it.</Text>
        {(agents || []).length > 6 ? (
          <View style={[styles.search, { borderColor: t.borderNeutral, backgroundColor: t.surface }]}>
            <Ionicons name="search" size={15} color={t.muted} />
            <TextInput
              value={filter}
              onChangeText={setFilter}
              placeholder="Filter agents"
              placeholderTextColor={t.mutedStrong}
              autoCorrect={false}
              autoCapitalize="none"
              accessibilityLabel="Filter agents"
              style={[styles.searchInput, { color: t.text }]}
            />
          </View>
        ) : null}
        <FlatList
          data={rows}
          keyExtractor={(a) => a.id}
          style={styles.list}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={[styles.none, { color: t.muted }]}>No agents match.</Text>}
          renderItem={({ item }) => {
            const on = item.id === agentId;
            const name = agentLabel(agents, item.id);
            return (
              <Pressable
                onPress={() => { tap(); onPick(item.id); onClose(); }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.opt, { backgroundColor: on ? t.accentSoft : pressed ? t.rowHover : 'transparent', borderRadius: t.radius.row }]}
              >
                <Monogram name={name} active={on} />
                <Text numberOfLines={1} style={[styles.optName, { color: t.text, fontFamily: t.font.medium }]}>{name}</Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontFamily: t.font.mono, fontSize: 11, maxWidth: 120 }}>{item.id}</Text>
                {on ? <Ionicons name="checkmark" size={16} color={t.accent} /> : <View style={styles.checkGap} />}
              </Pressable>
            );
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, height: 24 },
  mono: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, paddingTop: 8, paddingHorizontal: 10 },
  grip: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 10 },
  title: { fontSize: 16, paddingHorizontal: 8 },
  sub: { fontSize: 12, paddingHorizontal: 8, paddingTop: 2, paddingBottom: 10 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, minHeight: 40, marginBottom: 6 },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 8, outlineStyle: 'none' },
  list: { flexGrow: 0 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 8 },
  optName: { flex: 1, fontSize: 14 },
  checkGap: { width: 16 },
  none: { padding: 14, fontSize: 13 },
});
