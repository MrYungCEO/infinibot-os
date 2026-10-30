/**
 * Searchable project picker — one component for every place an idea, note or
 * task gets a board project (quick capture, Ideas, Notes, the task sheet).
 *
 *   <ProjectPickerPanel>  search box + "No project" + Recent + every project
 *                         (type-to-filter over name / aliases / parent /
 *                         description; sub-projects show their parent).
 *                         Plain View, so it can live inside another sheet.
 *   <ProjectPickerSheet>  the panel in its own BottomSheet.
 *   <ProjectField>        "Project" row for forms: current project, the
 *                         "Auto: X · why" / "Suggested: X" chip, tap to change.
 *
 * Ranking + filtering live in lib/project-picker-model.js (unit-tested).
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { pickerRows, projectPath, suggestionLabel } from '../lib/project-picker-model';

export function ProjectPickerPanel({ projects = [], usage = {}, selectedId, onSelect, onCancel, loading, error, onRetry, suggestion, height, autoFocus = true, testID = 'project-picker' }) {
  const { colors, type } = useUIKit();
  const { height: winH } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => pickerRows(projects, query, usage), [projects, query, usage]);
  const h = height || Math.min(560, Math.round(winH * 0.62));
  const line = withAlpha(colors.text, 0.08);

  const renderRow = ({ item }) => {
    if (item.type === 'header') {
      return <Text style={[type.label, styles.header, { color: colors.textMuted }]}>{item.title}</Text>;
    }
    const p = item.project;
    const on = p.id === selectedId;
    const suggested = suggestion?.id === p.id;
    return (
      <Pressable
        onPress={() => onSelect?.(p)}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={projectPath(p)}
        testID={`project-row-${p.id}`}
        style={({ pressed }) => [
          styles.row,
          { borderColor: on ? colors.primary : line, backgroundColor: on ? withAlpha(colors.primary, 0.12) : pressed ? withAlpha(colors.text, 0.05) : 'transparent' },
        ]}
      >
        <Ionicons name={p.parentId ? 'git-branch-outline' : 'folder-outline'} size={18} color={on ? colors.primary : colors.textSecondary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: on ? colors.primary : colors.text }]} numberOfLines={1}>
            {p.name}
          </Text>
          {p.parentName || suggested ? (
            <Text style={[type.caption, { color: suggested ? colors.primary : colors.textMuted }]} numberOfLines={1}>
              {[p.parentName ? `in ${p.parentName}` : null, suggested ? `suggested · ${suggestion.reason || 'AI'}` : null].filter(Boolean).join('  ·  ')}
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
          placeholder={`Search ${projects.length || ''} projects`.replace('  ', ' ')}
          placeholderTextColor={withAlpha(colors.text, 0.35)}
          autoFocus={autoFocus}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          accessibilityLabel="Search projects"
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
        <Text style={[type.bodyStrong, { flex: 1, color: !selectedId ? colors.primary : colors.text }]}>No project</Text>
        {!selectedId ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
      </Pressable>

      {loading && !projects.length ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: SPACE.lg }} />
      ) : error && !projects.length ? (
        <Pressable onPress={onRetry} style={styles.empty} accessibilityRole="button">
          <Text style={[type.small, { color: colors.error, textAlign: 'center' }]}>Couldn’t load projects ({error}). Tap to retry.</Text>
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
          ListEmptyComponent={<Text style={[type.small, styles.empty, { color: colors.textMuted }]}>No projects</Text>}
          ListFooterComponent={
            query && rows.length <= 1 ? (
              <Text style={[type.small, styles.empty, { color: colors.textMuted }]}>No project matches “{query}”.</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

export function ProjectPickerSheet({ visible, onClose, title = 'Choose project', onSelect, ...panel }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} scroll={false} maxHeightRatio={0.9} testID="project-picker-sheet">
      {visible ? (
        <ProjectPickerPanel
          {...panel}
          onSelect={(p) => {
            onSelect?.(p);
            onClose?.();
          }}
        />
      ) : null}
    </BottomSheet>
  );
}

/**
 * Form row: shows the chosen project (with parent), an Auto / Suggested chip,
 * and opens the picker via `onOpen` (inline pickers) — or its own sheet when
 * `catalog` is passed.
 */
export function ProjectField({ label = 'Project', projectId, projectName, projects = [], suggestion, onChange, onOpen, catalog, disabled, testID = 'project-field' }) {
  const { colors, type } = useUIKit();
  const [open, setOpen] = useState(false);
  const list = catalog?.projects?.length ? catalog.projects : projects;
  const current = projectId ? list.find((p) => p.id === projectId) || { id: projectId, name: projectName || projectId } : null;
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
        accessibilityLabel={current ? `Project: ${projectPath(current)}. Change project` : 'No project. Choose a project'}
        testID={`${testID}-open`}
        style={({ pressed }) => [
          styles.field,
          { borderColor: current ? withAlpha(colors.primary, 0.45) : withAlpha(colors.text, 0.14), backgroundColor: pressed ? withAlpha(colors.primary, 0.08) : withAlpha('#000000', 0.3), opacity: disabled ? 0.5 : 1 },
        ]}
      >
        <Ionicons name={current ? 'folder-open-outline' : 'folder-outline'} size={18} color={current ? colors.primary : colors.textSecondary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: current ? colors.text : colors.textSecondary }]} numberOfLines={1}>
            {current ? current.name : 'No project'}
          </Text>
          {current?.parentName ? (
            <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
              in {current.parentName}
            </Text>
          ) : null}
        </View>
        <Text style={[type.smallStrong, { color: colors.primary }]}>{current ? 'Change' : 'Choose'}</Text>
      </Pressable>
      {isAuto ? (
        <View style={[styles.chip, { borderColor: withAlpha(colors.primary, 0.45), backgroundColor: withAlpha(colors.primary, 0.1) }]} testID={`${testID}-auto`}>
          <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
          <Text style={[type.caption, { color: colors.primary, flexShrink: 1 }]} numberOfLines={2}>
            {suggestionLabel(suggestion, { selected: true })}
          </Text>
        </View>
      ) : null}
      {offer ? (
        <Pressable
          onPress={() => onChange?.({ id: offer.id, name: offer.name })}
          accessibilityRole="button"
          accessibilityLabel={`Use suggested project ${offer.name}`}
          testID={`${testID}-suggested`}
          style={[styles.chip, { borderColor: withAlpha(colors.text, 0.2), borderStyle: 'dashed' }]}
        >
          <Ionicons name="sparkles-outline" size={14} color={colors.textSecondary} />
          <Text style={[type.caption, { color: colors.textSecondary, flexShrink: 1 }]} numberOfLines={2}>
            {suggestionLabel(offer)} — tap to use
          </Text>
        </Pressable>
      ) : null}
      {catalog && !onOpen ? (
        <ProjectPickerSheet
          visible={open}
          onClose={() => setOpen(false)}
          projects={list}
          usage={catalog.usage}
          loading={catalog.loading}
          error={catalog.error}
          onRetry={() => catalog.refresh?.()}
          selectedId={projectId}
          suggestion={suggestion}
          onSelect={(p) => {
            if (p?.id) catalog.markUsed?.(p.id);
            onChange?.(p ? { id: p.id, name: p.name } : null);
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
  empty: { padding: SPACE.lg, textAlign: 'center' },
});
