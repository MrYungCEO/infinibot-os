/**
 * WorkspaceCode — the monospace surfaces of the native Workspace page:
 *
 *   CodeViewer  read-only file view: line numbers + cheap per-line syntax
 *               tint (workspace-model.tokenizeLine), virtualised, horizontally
 *               scrollable so long lines never wrap into soup.
 *   CodeEditor  the web's textarea editor — a mono multi-line TextInput.
 *   DiffView    coloured +/- rows for both the LCS unsaved-edit diff and
 *               unified git / checkpoint patches (file + hunk headers).
 */
import React, { memo, useMemo } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { MONO_FAMILY, RADIUS, SPACE, useUIKit } from '../../ui-kit';
import { languageFor, tokenizeLine, viewLines } from './workspace-model';

const LINE_H = 18;

function useTintColors() {
  const { colors, alpha } = useUIKit();
  return useMemo(
    () => ({
      plain: colors.text,
      kw: colors.primary,
      str: colors.success,
      num: colors.warning,
      com: colors.textMuted,
      tag: colors.info,
      attr: colors.warning,
      head: colors.primary,
      gutter: colors.textMuted,
      gutterBg: alpha(colors.text, 0.03),
      addBg: alpha(colors.success, 0.12),
      addFg: colors.success,
      remBg: alpha(colors.error, 0.12),
      remFg: colors.error,
      hunkBg: alpha(colors.info, 0.1),
      hunkFg: colors.info,
      fileBg: alpha(colors.primary, 0.09),
      border: colors.borderSubtle,
    }),
    [colors, alpha],
  );
}

const CodeLine = memo(function CodeLine({ num, text, lang, tint, gutterW }) {
  const spans = tokenizeLine(text, lang);
  return (
    <View style={styles.row}>
      <Text style={[styles.gutter, { width: gutterW, color: tint.gutter, backgroundColor: tint.gutterBg }]}>{num}</Text>
      <Text style={[styles.code, { color: tint.plain }]} selectable>
        {spans.map((s, i) => (
          <Text key={i} style={{ color: tint[s.k] || tint.plain }}>{s.t}</Text>
        ))}
        {text === '' ? ' ' : null}
      </Text>
    </View>
  );
});

/** Read-only, syntax-tinted file view. */
export function CodeViewer({ name, content, footer, testID }) {
  const tint = useTintColors();
  const { colors, type } = useUIKit();
  const lang = languageFor(name);
  const { lines, total, truncated } = useMemo(() => viewLines(content), [content]);
  const gutterW = Math.max(30, String(total).length * 8 + 14);
  const longest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);
  const innerW = Math.min(6000, Math.max(320, gutterW + longest * 7.9 + 32));
  return (
    <ScrollView horizontal style={styles.flex} contentContainerStyle={{ minWidth: '100%' }} testID={testID}>
      <FlatList
        style={{ width: innerW }}
        data={lines}
        keyExtractor={(_, i) => String(i)}
        initialNumToRender={60}
        maxToRenderPerBatch={80}
        windowSize={11}
        getItemLayout={(_, index) => ({ length: LINE_H, offset: LINE_H * index, index })}
        renderItem={({ item, index }) => <CodeLine num={index + 1} text={item} lang={lang} tint={tint} gutterW={gutterW} />}
        ListFooterComponent={
          <View style={{ paddingVertical: SPACE.md, paddingLeft: gutterW + SPACE.sm }}>
            {truncated ? (
              <Text style={[type.caption, { color: colors.warning }]}>
                Showing the first {lines.length.toLocaleString()} of {total.toLocaleString()} lines
              </Text>
            ) : null}
            {footer}
          </View>
        }
      />
    </ScrollView>
  );
}

/** Editable buffer — the web's textarea, monospace, no autocorrect. */
export function CodeEditor({ value, onChangeText, testID }) {
  const { colors, alpha } = useUIKit();
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChangeText}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      textAlignVertical="top"
      scrollEnabled
      accessibilityLabel="File editor"
      style={[
        styles.editor,
        { color: colors.text, backgroundColor: alpha(colors.text, 0.03), borderColor: colors.border },
      ]}
    />
  );
}

const DiffRow = memo(function DiffRow({ row, tint, type, colors }) {
  if (row.kind === 'file') {
    return (
      <View style={[styles.fileRow, { backgroundColor: tint.fileBg, borderColor: tint.border }]}>
        <Ionicons name="document-text-outline" size={14} color={colors.primary} />
        <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>{row.file.path}</Text>
        <Text style={[styles.monoSmall, { color: tint.addFg }]}>+{row.file.add}</Text>
        <Text style={[styles.monoSmall, { color: tint.remFg }]}>-{row.file.remove}</Text>
      </View>
    );
  }
  if (row.kind === 'skip') {
    return (
      <View style={[styles.skip, { borderColor: tint.border }]}>
        <Text style={[type.caption, { color: colors.textMuted }]}>{row.count} unchanged line{row.count === 1 ? '' : 's'}</Text>
      </View>
    );
  }
  if (row.kind === 'hunk') {
    return (
      <View style={[styles.row, { backgroundColor: tint.hunkBg }]}>
        <Text style={[styles.code, { color: tint.hunkFg, paddingLeft: SPACE.sm }]}>{row.text}</Text>
      </View>
    );
  }
  if (row.kind === 'meta') {
    return (
      <View style={styles.row}>
        <Text style={[styles.code, { color: colors.textMuted, paddingLeft: SPACE.sm }]}>{row.text}</Text>
      </View>
    );
  }
  const add = row.kind === 'add';
  const rem = row.kind === 'remove';
  const bg = add ? tint.addBg : rem ? tint.remBg : 'transparent';
  const fg = add ? tint.addFg : rem ? tint.remFg : colors.textSecondary;
  return (
    <View style={[styles.row, { backgroundColor: bg }]}>
      <Text style={[styles.num, { color: tint.gutter }]}>{row.oldNum ?? ''}</Text>
      <Text style={[styles.num, { color: tint.gutter }]}>{row.newNum ?? ''}</Text>
      <Text style={[styles.sign, { color: fg }]}>{add ? '+' : rem ? '-' : ' '}</Text>
      <Text style={[styles.code, { color: add || rem ? colors.text : colors.textSecondary }]} selectable>
        {row.text === '' ? ' ' : row.text}
      </Text>
    </View>
  );
});

/**
 * Coloured diff rows. `rows` come from diffLines (+collapseContext) or
 * parseUnifiedDiff. `scroll=false` renders inline (inside a parent scroller).
 */
export function DiffView({ rows, header, empty, scroll = true, testID }) {
  const tint = useTintColors();
  const { colors, type } = useUIKit();
  const longest = useMemo(() => (rows || []).reduce((m, r) => Math.max(m, (r.text || r.file?.path || '').length), 0), [rows]);
  const innerW = Math.min(6000, Math.max(320, 96 + longest * 7.9));
  if (!rows || rows.length === 0) return empty || null;
  const list = scroll ? (
    <FlatList
      style={{ width: innerW }}
      data={rows}
      keyExtractor={(_, i) => String(i)}
      initialNumToRender={60}
      maxToRenderPerBatch={80}
      windowSize={11}
      ListHeaderComponent={header}
      renderItem={({ item }) => <DiffRow row={item} tint={tint} type={type} colors={colors} />}
    />
  ) : (
    <View style={{ width: innerW }}>
      {header}
      {rows.map((r, i) => <DiffRow key={i} row={r} tint={tint} type={type} colors={colors} />)}
    </View>
  );
  return (
    <ScrollView horizontal style={scroll ? styles.flex : null} contentContainerStyle={{ minWidth: '100%' }} testID={testID}>
      {list}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', minHeight: LINE_H, alignItems: 'flex-start' },
  gutter: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: LINE_H, textAlign: 'right', paddingRight: SPACE.sm },
  code: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: LINE_H, paddingLeft: SPACE.sm, paddingRight: SPACE.lg, flexShrink: 0 },
  num: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: LINE_H, width: 38, textAlign: 'right', paddingRight: 4 },
  sign: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: LINE_H, width: 16, textAlign: 'center', fontWeight: '700' },
  monoSmall: { fontFamily: MONO_FAMILY, fontSize: 12, fontWeight: '700' },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, minHeight: 36, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, marginTop: SPACE.sm },
  fileName: { fontFamily: MONO_FAMILY, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  skip: { paddingVertical: 4, paddingLeft: 96, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  editor: { flex: 1, fontFamily: MONO_FAMILY, fontSize: 13, lineHeight: 19, padding: SPACE.md, borderWidth: 1, borderRadius: RADIUS.sm, minHeight: 200 },
});
