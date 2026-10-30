/**
 * WhiteboardPanels — the overlays of the native Whiteboard:
 *   BoardsSheet      saved boards (open / new / save as / rename / delete)
 *   TemplatesSheet   built-in + custom templates (load on canvas / new board)
 *   StyleSheetPanel  stroke / fill / width / style / sloppiness / opacity /
 *                    font size + selection actions
 *   ArchitectSheet   "Canvas Architect" (sessions.spawn agentId canvas)
 *   MoreSheet        clear, paper, clipboard, select all, save as template
 *   PromptModal / ConfirmModal
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, RefreshControl, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  BottomSheet,
  Modal,
  Button,
  IconButton,
  Input,
  ListRow,
  EmptyState,
  SkeletonRow,
  useUIKit,
  SPACE,
  RADIUS,
  HIT,
} from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { renderColor, isTransparent } from './whiteboard-geometry';
import {
  STROKE_PALETTE,
  FILL_PALETTE,
  STROKE_WIDTHS,
  FILL_STYLES,
  STROKE_STYLES,
  ROUGHNESS_LEVELS,
  FONT_SIZES,
  relativeTime,
  ARCHITECT_HINTS,
} from './whiteboard-model';

// ── boards ────────────────────────────────────────────────────────────────

export function BoardsSheet({ visible, onClose, side, boards, loading, error, currentId, onRefresh, onOpen, onNew, onSaveAs, onRename, onDelete }) {
  const { colors, type } = useUIKit();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      side={side}
      title="Saved Boards"
      subtitle={boards.length ? `${boards.length} board${boards.length === 1 ? '' : 's'} in plugin data` : 'Boards live in the plugin data folder'}
      headerRight={<IconButton icon="refresh-outline" onPress={onRefresh} accessibilityLabel="Refresh boards" loading={loading} />}
      scroll={false}
      footer={
        <View style={styles.footerRow}>
          <Button title="New board" icon="add" variant="outline" onPress={onNew} style={styles.flex} accessibilityLabel="Create a new board" />
          <Button title="Save canvas as" icon="save-outline" variant="primary" onPress={onSaveAs} style={styles.flex} accessibilityLabel="Save the canvas as a board" />
        </View>
      }
    >
      <ScrollView
        style={styles.sheetScroll}
        contentContainerStyle={{ paddingBottom: SPACE.md }}
        refreshControl={<RefreshControl refreshing={!!loading && boards.length > 0} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {loading && !boards.length ? (
          <View style={{ gap: SPACE.sm }}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : error && !boards.length ? (
          <EmptyState compact icon="alert-circle-outline" tone="danger" title="Couldn't load boards" message={error} actionLabel="Retry" onAction={onRefresh} />
        ) : !boards.length ? (
          <EmptyState compact icon="folder-open-outline" title="No saved boards yet" message="Draw something and tap Save!" />
        ) : (
          boards.map((b) => {
            const active = b.id === currentId;
            return (
              <View key={b.id} style={[styles.boardRow, { borderColor: active ? withAlpha(colors.primary, 0.45) : colors.borderSubtle, backgroundColor: active ? withAlpha(colors.primary, 0.08) : 'transparent' }]}>
                <Pressable
                  onPress={() => onOpen(b.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open board ${b.name}`}
                  style={({ pressed }) => [styles.boardMain, pressed && { opacity: 0.7 }]}
                >
                  <View style={[styles.boardIcon, { borderColor: active ? colors.primary : colors.border }]}>
                    <Ionicons name={active ? 'easel' : 'easel-outline'} size={18} color={active ? colors.primary : colors.textSecondary} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
                      {b.name}
                    </Text>
                    <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                      {`${b.id}  ·  ${relativeTime(b.updatedAt) || 'saved'}`}
                    </Text>
                  </View>
                </Pressable>
                <IconButton icon="create-outline" size="sm" onPress={() => onRename(b)} accessibilityLabel={`Rename ${b.name}`} />
                <IconButton icon="trash-outline" size="sm" tone={colors.error} onPress={() => onDelete(b)} accessibilityLabel={`Delete ${b.name}`} />
              </View>
            );
          })
        )}
        {error && boards.length ? <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>{error}</Text> : null}
      </ScrollView>
    </BottomSheet>
  );
}

// ── templates ─────────────────────────────────────────────────────────────

export function TemplatesSheet({ visible, onClose, side, templates, loading, onLoad, onNewBoard, onRefresh, width }) {
  const { colors, type } = useUIKit();
  const cols = width > 640 ? 3 : 2;
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      side={side}
      title="Templates"
      subtitle="Tap to load onto the live canvas"
      headerRight={<IconButton icon="refresh-outline" onPress={onRefresh} loading={loading} accessibilityLabel="Reload templates" />}
    >
      <View style={styles.grid}>
        {templates.map((t) => (
          <View key={t.id} style={[styles.tplCard, { width: `${100 / cols - 2}%`, borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Pressable
              onPress={() => onLoad(t)}
              accessibilityRole="button"
              accessibilityLabel={`Load template ${t.name}`}
              style={({ pressed }) => [styles.tplMain, pressed && { opacity: 0.7 }]}
            >
              <View style={styles.tplTop}>
                <View style={[styles.tplIcon, { borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha(colors.primary, 0.08) }]}>
                  <Ionicons name={t.icon || 'shapes-outline'} size={20} color={colors.primary} />
                </View>
                <Text style={[type.caption, { color: colors.textMuted, flexShrink: 1, textAlign: 'right' }]} numberOfLines={2}>
                  {t.category || 'Other'}
                </Text>
              </View>
              <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>
                {t.name}
              </Text>
              <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
                {t.description || ''}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onNewBoard(t)}
              accessibilityRole="button"
              accessibilityLabel={`New board from ${t.name}`}
              style={({ pressed }) => [styles.tplNew, { borderTopColor: colors.borderSubtle }, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
              <Text style={[type.caption, { color: colors.primary }]}>New board</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </BottomSheet>
  );
}

// ── style ─────────────────────────────────────────────────────────────────

function Swatch({ color, active, onPress, dark, label }) {
  const { colors } = useUIKit();
  const transparent = isTransparent(color);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} style={styles.swatchHit} hitSlop={2}>
      <View
        style={[
          styles.swatch,
          { borderColor: active ? colors.primary : colors.border, backgroundColor: transparent ? 'transparent' : renderColor(color, dark) },
          active && styles.swatchActive,
        ]}
      >
        {transparent ? <Ionicons name="close-outline" size={18} color={colors.textMuted} /> : null}
      </View>
    </Pressable>
  );
}

function Seg({ options, value, onChange, render, labelOf }) {
  const { colors } = useUIKit();
  return (
    <View style={styles.segRow}>
      {options.map((o) => {
        const active = o === value;
        return (
          <Pressable
            key={String(o)}
            onPress={() => onChange(o)}
            accessibilityRole="button"
            accessibilityLabel={labelOf ? labelOf(o) : String(o)}
            accessibilityState={{ selected: active }}
            style={[styles.seg, { borderColor: active ? colors.primary : colors.border, backgroundColor: active ? withAlpha(colors.primary, 0.12) : 'transparent' }]}
          >
            {render(o, active)}
          </Pressable>
        );
      })}
    </View>
  );
}

const ROUGH_LABEL = { 0: 'Architect', 1: 'Artist', 2: 'Cartoonist' };

export function StyleSheetPanel({ visible, onClose, side, dark, value, onChange, hasSelection, hasText, onEditText, onDuplicate, onFront, onBack, onDelete }) {
  const { colors, type } = useUIKit();
  const v = value || {};
  const lineIcon = (w, active) => <View style={{ width: 26, height: w + 1, borderRadius: 2, backgroundColor: active ? colors.primary : colors.textSecondary }} />;
  return (
    <BottomSheet visible={visible} onClose={onClose} side={side} title={hasSelection ? 'Selection style' : 'Drawing style'} subtitle={hasSelection ? 'Changes apply to the selected elements' : 'Used for the next thing you draw'}>
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Stroke</Text>
      <View style={styles.swatchRow}>
        {STROKE_PALETTE.map((c) => (
          <Swatch key={c} color={c} dark={dark} active={v.strokeColor === c} onPress={() => onChange({ strokeColor: c })} label={`Stroke colour ${c}`} />
        ))}
      </View>
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Background</Text>
      <View style={styles.swatchRow}>
        {FILL_PALETTE.map((c) => (
          <Swatch key={c} color={c} dark={dark} active={v.backgroundColor === c} onPress={() => onChange({ backgroundColor: c })} label={c === 'transparent' ? 'No background' : `Background colour ${c}`} />
        ))}
      </View>
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Fill</Text>
      <Seg
        options={FILL_STYLES}
        value={v.fillStyle}
        onChange={(fillStyle) => onChange({ fillStyle })}
        labelOf={(o) => `Fill ${o}`}
        render={(o, a) => <Text style={[type.caption, { color: a ? colors.primary : colors.textSecondary }]}>{o === 'cross-hatch' ? 'Cross' : o === 'hachure' ? 'Hatch' : 'Solid'}</Text>}
      />
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Stroke width</Text>
      <Seg options={STROKE_WIDTHS} value={v.strokeWidth} onChange={(strokeWidth) => onChange({ strokeWidth })} labelOf={(o) => `Stroke width ${o}`} render={(o, a) => lineIcon(o + 1, a)} />
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Stroke style</Text>
      <Seg
        options={STROKE_STYLES}
        value={v.strokeStyle}
        onChange={(strokeStyle) => onChange({ strokeStyle })}
        labelOf={(o) => `Stroke ${o}`}
        render={(o, a) => <Text style={[type.caption, { color: a ? colors.primary : colors.textSecondary }]}>{o[0].toUpperCase() + o.slice(1)}</Text>}
      />
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Sloppiness</Text>
      <Seg
        options={ROUGHNESS_LEVELS}
        value={v.roughness}
        onChange={(roughness) => onChange({ roughness })}
        labelOf={(o) => `Sloppiness ${ROUGH_LABEL[o]}`}
        render={(o, a) => <Text style={[type.caption, { color: a ? colors.primary : colors.textSecondary }]}>{ROUGH_LABEL[o]}</Text>}
      />
      <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Opacity</Text>
      <Seg
        options={[20, 50, 80, 100]}
        value={v.opacity}
        onChange={(opacity) => onChange({ opacity })}
        labelOf={(o) => `Opacity ${o} percent`}
        render={(o, a) => <Text style={[type.monoSmall, { color: a ? colors.primary : colors.textSecondary }]}>{o}%</Text>}
      />
      {hasText || !hasSelection ? (
        <>
          <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Font size</Text>
          <Seg
            options={FONT_SIZES}
            value={v.fontSize}
            onChange={(fontSize) => onChange({ fontSize })}
            labelOf={(o) => `Font size ${o}`}
            render={(o, a) => <Text style={[type.monoSmall, { color: a ? colors.primary : colors.textSecondary }]}>{o}</Text>}
          />
        </>
      ) : null}
      {hasSelection ? (
        <>
          <Text style={[type.label, styles.lbl, { color: colors.textMuted }]}>Actions</Text>
          <View style={styles.actionGrid}>
            <Button title="Edit text" icon="text-outline" variant="outline" size="sm" onPress={onEditText} accessibilityLabel="Edit text or label" />
            <Button title="Duplicate" icon="copy-outline" variant="outline" size="sm" onPress={onDuplicate} accessibilityLabel="Duplicate selection" />
            <Button title="To front" icon="arrow-up-outline" variant="outline" size="sm" onPress={onFront} accessibilityLabel="Bring to front" />
            <Button title="To back" icon="arrow-down-outline" variant="outline" size="sm" onPress={onBack} accessibilityLabel="Send to back" />
            <Button title="Delete" icon="trash-outline" variant="danger" size="sm" onPress={onDelete} accessibilityLabel="Delete selection" />
          </View>
        </>
      ) : null}
    </BottomSheet>
  );
}

// ── canvas architect ──────────────────────────────────────────────────────

export function ArchitectSheet({ visible, onClose, side, messages, busy, onSend }) {
  const { colors, type } = useUIKit();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [messages.length]);
  const send = (text) => {
    const t = String(text ?? draft).trim();
    if (!t || busy) return;
    setDraft('');
    onSend(t);
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      side={side}
      title="Canvas Architect"
      subtitle="Diagram specialist — draws on the live canvas"
      scroll={false}
      maxHeightRatio={0.8}
      footer={
        <View style={styles.footerRow}>
          <View style={styles.flex}>
            <Input value={draft} onChangeText={setDraft} placeholder="Describe what to draw..." returnKeyType="send" onSubmitEditing={() => send()} editable={!busy} />
          </View>
          <IconButton icon="send" variant="solid" onPress={() => send()} disabled={busy || !draft.trim()} loading={busy} accessibilityLabel="Send drawing request" />
        </View>
      }
    >
      <ScrollView ref={scrollRef} style={styles.sheetScroll} contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
        {!messages.length ? (
          <View style={{ alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.md }}>
            <View style={[styles.archIcon, { borderColor: withAlpha(colors.primary, 0.35), backgroundColor: withAlpha(colors.primary, 0.08) }]}>
              <Ionicons name="color-palette-outline" size={30} color={colors.primary} />
            </View>
            <Text style={[type.h3, { color: colors.primary }]}>Canvas Architect</Text>
            <Text style={[type.caption, { color: colors.textMuted, fontStyle: 'italic' }]}>I create beautiful diagrams</Text>
            {ARCHITECT_HINTS.map((h) => (
              <Pressable
                key={h}
                onPress={() => send(h)}
                accessibilityRole="button"
                accessibilityLabel={`Ask: ${h}`}
                style={({ pressed }) => [styles.hint, { borderColor: withAlpha(colors.primary, 0.18), backgroundColor: withAlpha(colors.primary, pressed ? 0.1 : 0.04) }]}
              >
                <Text style={[type.small, { color: colors.textSecondary }]}>{`"${h}"`}</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          messages.map((m, i) => {
            const mine = m.role === 'user';
            return (
              <View key={i} style={[styles.msg, mine ? styles.msgMine : null, { backgroundColor: mine ? withAlpha(colors.primary, 0.14) : colors.surface, borderColor: mine ? withAlpha(colors.primary, 0.3) : colors.borderSubtle }]}>
                {m.loading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text style={[type.small, { color: colors.textSecondary }]}>Creating your diagram</Text>
                  </View>
                ) : (
                  <Text style={[type.small, { color: m.tone === 'error' ? colors.error : colors.text }]}>{m.content}</Text>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </BottomSheet>
  );
}

// ── more ──────────────────────────────────────────────────────────────────

export function MoreSheet({ visible, onClose, side, dark, onTogglePaper, onClear, onCopy, onPaste, onSelectAll, onSaveTemplate, onFit, hasBoard }) {
  const items = [
    { icon: dark ? 'sunny-outline' : 'moon-outline', title: dark ? 'Light paper' : 'Dark paper', subtitle: 'Excalidraw light / dark canvas', onPress: onTogglePaper },
    { icon: 'scan-outline', title: 'Zoom to fit', subtitle: 'Fit every element on screen', onPress: onFit },
    { icon: 'checkmark-done-outline', title: 'Select all', onPress: onSelectAll },
    { icon: 'copy-outline', title: 'Copy to clipboard', subtitle: 'Excalidraw JSON (selection or whole scene)', onPress: onCopy },
    { icon: 'clipboard-outline', title: 'Paste from clipboard', subtitle: 'Excalidraw JSON from the web canvas', onPress: onPaste },
    { icon: 'bookmark-outline', title: 'Save as template', subtitle: hasBoard ? 'Reusable from Templates' : 'Saves the current canvas', onPress: onSaveTemplate },
    { icon: 'trash-outline', title: 'Clear canvas', subtitle: 'Empties the live canvas everywhere', onPress: onClear, tone: 'danger' },
  ];
  return (
    <BottomSheet visible={visible} onClose={onClose} side={side} title="Canvas">
      {items.map((it) => (
        <ListRow
          key={it.title}
          icon={it.icon}
          iconTone={it.tone === 'danger' ? 'danger' : 'primary'}
          title={it.title}
          subtitle={it.subtitle}
          onPress={() => {
            onClose();
            it.onPress();
          }}
          chevron={false}
          accessibilityLabel={it.title}
        />
      ))}
    </BottomSheet>
  );
}

// ── modals ────────────────────────────────────────────────────────────────

export function PromptModal({ visible, title, subtitle, label, initial, placeholder, confirmLabel = 'Save', multiline, hint, validate, onCancel, onConfirm, busy }) {
  const [value, setValue] = useState(initial || '');
  useEffect(() => {
    if (visible) setValue(initial || '');
  }, [visible, initial]);
  const err = validate ? validate(value) : null;
  return (
    <Modal
      visible={visible}
      onClose={onCancel}
      title={title}
      subtitle={subtitle}
      footer={
        <View style={styles.footerRow}>
          <Button title="Cancel" variant="ghost" onPress={onCancel} style={styles.flex} accessibilityLabel="Cancel" />
          <Button title={confirmLabel} onPress={() => onConfirm(value)} disabled={!!err || !String(value).trim()} loading={busy} style={styles.flex} accessibilityLabel={confirmLabel} />
        </View>
      }
    >
      <Input
        label={label}
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        autoFocus
        multiline={multiline}
        rows={multiline ? 4 : undefined}
        helper={err ? undefined : hint}
        error={value && err ? err : undefined}
        autoCapitalize={multiline ? 'sentences' : 'none'}
        onSubmitEditing={multiline ? undefined : () => !err && String(value).trim() && onConfirm(value)}
      />
    </Modal>
  );
}

export function ConfirmModal({ visible, title, message, confirmLabel = 'Delete', onCancel, onConfirm, busy }) {
  const { colors, type } = useUIKit();
  return (
    <Modal
      visible={visible}
      onClose={onCancel}
      title={title}
      footer={
        <View style={styles.footerRow}>
          <Button title="Cancel" variant="ghost" onPress={onCancel} style={styles.flex} accessibilityLabel="Cancel" />
          <Button title={confirmLabel} variant="danger" onPress={onConfirm} loading={busy} style={styles.flex} accessibilityLabel={confirmLabel} />
        </View>
      }
    >
      <Text style={[type.body, { color: colors.textSecondary }]}>{message}</Text>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  sheetScroll: { maxHeight: 520 },
  boardRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.md, paddingRight: SPACE.xs, marginBottom: SPACE.sm },
  boardMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.md, padding: SPACE.md, minHeight: HIT.min },
  boardIcon: { width: 36, height: 36, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, justifyContent: 'space-between' },
  tplCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, overflow: 'hidden', marginBottom: SPACE.xs },
  tplMain: { padding: SPACE.md, gap: SPACE.xs, minHeight: 112 },
  tplTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACE.xs, marginBottom: SPACE.xs },
  tplIcon: { width: 40, height: 40, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  tplNew: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, minHeight: HIT.min, borderTopWidth: StyleSheet.hairlineWidth },
  lbl: { marginTop: SPACE.md, marginBottom: SPACE.sm },
  swatchRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  swatchHit: { width: HIT.min, height: HIT.min, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 32, height: 32, borderRadius: RADIUS.sm, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  swatchActive: { borderWidth: 2.5 },
  segRow: { flexDirection: 'row', gap: SPACE.sm },
  seg: { flex: 1, minHeight: HIT.min, borderRadius: RADIUS.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: SPACE.xs },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  archIcon: { width: 64, height: 64, borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  hint: { alignSelf: 'stretch', borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.md, minHeight: HIT.min, justifyContent: 'center' },
  msg: { maxWidth: '86%', alignSelf: 'flex-start', borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm },
  msgMine: { alignSelf: 'flex-end' },
});
