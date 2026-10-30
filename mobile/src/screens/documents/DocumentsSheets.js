// DocumentsSheets — the Documents workspace's overlays (web dialogs / popovers):
// New menu, Move to…, Version history, Trash, Manage types, Type picker,
// row actions, rename prompt, confirm. Pure presentation + callbacks; the
// screen owns the RPCs.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';

import { BottomSheet, Button, Chip, Divider, EmptyState, IconButton, ListRow, Modal, SectionTitle, SPACE, RADIUS, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  TYPE_COLOR_CHOICES,
  TYPE_ICON_CHOICES,
  assignableTypes,
  creatableTypes,
  ionIconFor,
  moveInOrder,
  newTypeParams,
  nodeIcon,
  relTime,
  revisionLabel,
  typeById,
} from './documents-model';

export function makeMarkdownStyles(colors, type) {
  const mono = type.mono.fontFamily;
  return {
    body: { color: colors.text, fontFamily: type.body.fontFamily, fontSize: 15, lineHeight: 23 },
    heading1: { color: colors.text, fontFamily: type.h1.fontFamily, fontSize: 22, lineHeight: 28, marginTop: SPACE.md, marginBottom: SPACE.sm },
    heading2: { color: colors.text, fontFamily: type.h2.fontFamily, fontSize: 18, lineHeight: 24, marginTop: SPACE.lg, marginBottom: SPACE.xs },
    heading3: { color: colors.primary, fontFamily: type.h3.fontFamily, fontSize: 15, lineHeight: 21, marginTop: SPACE.md, marginBottom: SPACE.xs },
    heading4: { color: colors.textSecondary, fontFamily: type.h3.fontFamily, fontSize: 14, marginTop: SPACE.sm },
    strong: { fontFamily: type.bodyStrong.fontFamily, color: colors.text },
    em: { fontStyle: 'italic' },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    blockquote: { backgroundColor: withAlpha(colors.primary, 0.07), borderLeftColor: colors.primary, borderLeftWidth: 3, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, marginVertical: SPACE.sm },
    code_inline: { fontFamily: mono, fontSize: 13, color: colors.primary, backgroundColor: withAlpha(colors.text, 0.08), borderRadius: 4, paddingHorizontal: 4 },
    code_block: { fontFamily: mono, fontSize: 12.5, color: colors.text, backgroundColor: withAlpha(colors.text, 0.06), borderRadius: RADIUS.sm, padding: SPACE.md, borderWidth: 0 },
    fence: { fontFamily: mono, fontSize: 12.5, color: colors.text, backgroundColor: withAlpha(colors.text, 0.06), borderRadius: RADIUS.sm, padding: SPACE.md, borderWidth: 0 },
    hr: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth, marginVertical: SPACE.md },
    bullet_list_icon: { color: colors.primary },
    ordered_list_icon: { color: colors.primary },
    table: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.sm },
    th: { padding: SPACE.xs, borderColor: colors.border },
    td: { padding: SPACE.xs, borderColor: colors.border },
    tr: { borderColor: colors.border },
  };
}

/** Type glyph in a tinted round. */
export function TypeGlyph({ type, size = 18 }) {
  const { colors } = useUIKit();
  const c = (type && type.color) || colors.primary;
  return (
    <View style={[st.glyph, { width: size + 16, height: size + 16, borderColor: withAlpha(c, 0.45), backgroundColor: withAlpha(c, 0.1) }]}>
      <Ionicons name={ionIconFor(type && type.icon)} size={size} color={c} />
    </View>
  );
}

export function NodeGlyph({ node, types, size = 18 }) {
  const { colors } = useUIKit();
  const { icon, color } = nodeIcon(node, types);
  const c = color || colors.primary;
  return (
    <View style={[st.glyph, { width: size + 16, height: size + 16, borderColor: withAlpha(c, 0.4), backgroundColor: withAlpha(c, 0.08) }]}>
      <Ionicons name={icon} size={size} color={c} />
    </View>
  );
}

// ── New… ─────────────────────────────────────────────────────

export function NewSheet({ visible, onClose, types, onCreate, onFolder, onNewType, onUpload, onImport, target }) {
  const list = creatableTypes(types);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Create" subtitle={target ? `In ${target}` : 'Top level'} testID="documents-new-sheet">
      {list.map((t) => (
        <ListRow
          key={t.id}
          leading={<TypeGlyph type={t} />}
          title={t.label}
          subtitle={t.backing === 'ideas' ? 'Goes to Ideas' : t.template ? 'Starts from a template' : t.description || undefined}
          onPress={() => onCreate(t)}
          chevron={false}
          accessibilityLabel={`New ${t.label}`}
          testID={`documents-new-${t.id}`}
        />
      ))}
      <Divider spacing={SPACE.sm} />
      <ListRow icon="folder-outline" title="Folder" onPress={onFolder} chevron={false} accessibilityLabel="New folder" testID="documents-new-folder" />
      {onUpload ? <ListRow icon="cloud-upload-outline" title="Upload photos / videos" onPress={onUpload} chevron={false} accessibilityLabel="Upload" /> : null}
      {onImport ? <ListRow icon="download-outline" title="Import (Notion, Obsidian, URL)" onPress={onImport} chevron={false} accessibilityLabel="Import" /> : null}
      <ListRow icon="add-circle-outline" title="New type…" onPress={onNewType} chevron={false} accessibilityLabel="New type" testID="documents-new-type" />
    </BottomSheet>
  );
}

// ── Row actions ──────────────────────────────────────────────

export function NodeActionsSheet({ node, types, onClose, onOpen, onRename, onFavorite, onMove, onTrash, onNewInside }) {
  return (
    <BottomSheet visible={!!node} onClose={onClose} title={node ? node.title : ''} subtitle={node ? node.path || undefined : undefined}>
      {node ? (
        <View>
          <ListRow leading={<NodeGlyph node={node} types={types} />} title="Open" onPress={() => onOpen(node)} chevron={false} accessibilityLabel="Open" />
          {node.kind === 'folder' ? <ListRow icon="add-outline" title="New inside…" onPress={() => onNewInside(node)} chevron={false} accessibilityLabel="New inside folder" /> : null}
          <ListRow icon="create-outline" title="Rename" onPress={() => onRename(node)} chevron={false} accessibilityLabel="Rename" />
          <ListRow icon={node.favorite ? 'star' : 'star-outline'} title={node.favorite ? 'Unfavourite' : 'Favourite'} onPress={() => onFavorite(node)} chevron={false} accessibilityLabel="Toggle favourite" />
          <ListRow icon="return-down-forward-outline" title="Move to…" onPress={() => onMove(node)} chevron={false} accessibilityLabel="Move" />
          <ListRow icon="trash-outline" iconTone="danger" title="Move to trash" onPress={() => onTrash(node)} chevron={false} accessibilityLabel="Move to trash" />
        </View>
      ) : null}
    </BottomSheet>
  );
}

// ── Prompt / confirm ─────────────────────────────────────────

export function PromptModal({ visible, title, initial, placeholder, confirmLabel = 'Save', onSubmit, onClose }) {
  const { colors, type } = useUIKit();
  const [v, setV] = useState(initial || '');
  useEffect(() => {
    if (visible) setV(initial || '');
  }, [visible, initial]);
  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={title}
      footer={
        <View style={st.row}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button title={confirmLabel} variant="primary" onPress={() => onSubmit(v)} disabled={!String(v).trim()} />
        </View>
      }
    >
      <TextInput
        value={v}
        onChangeText={setV}
        autoFocus
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        onSubmitEditing={() => String(v).trim() && onSubmit(v)}
        style={[type.body, st.input, { color: colors.text, borderColor: withAlpha(colors.primary, 0.35) }]}
        accessibilityLabel={title}
      />
    </Modal>
  );
}

export function ConfirmModal({ confirm, onClose }) {
  return (
    <Modal
      visible={!!confirm}
      onClose={onClose}
      title={confirm ? confirm.title : ''}
      subtitle={confirm ? confirm.message : ''}
      footer={
        <View style={st.row}>
          <Button title="Cancel" variant="ghost" onPress={onClose} />
          <Button
            title={(confirm && confirm.confirmLabel) || 'Confirm'}
            variant={confirm && confirm.danger ? 'danger' : 'primary'}
            onPress={() => {
              const fn = confirm && confirm.onConfirm;
              onClose();
              if (fn) fn();
            }}
            testID="documents-confirm"
          />
        </View>
      }
    />
  );
}

// ── Move ─────────────────────────────────────────────────────

export function MoveSheet({ node, targets, onClose, onMove }) {
  return (
    <BottomSheet visible={!!node} onClose={onClose} title={node ? `Move “${node.title}”` : ''} subtitle="Pick a destination">
      <ListRow icon="albums-outline" title="Top level" onPress={() => onMove(null)} chevron={false} selected={node ? !node.parentId : false} accessibilityLabel="Move to top level" />
      {targets.map((f) => (
        <ListRow
          key={f.id}
          icon="folder-outline"
          title={f.title}
          subtitle={f.path !== f.title ? f.path : undefined}
          selected={f.current}
          onPress={() => onMove(f.id)}
          chevron={false}
          accessibilityLabel={`Move to ${f.path}`}
        />
      ))}
      {!targets.length ? <EmptyState compact icon="folder-open-outline" title="No folders yet" message="Create a folder first, or move this to the top level." /> : null}
    </BottomSheet>
  );
}

// ── History ──────────────────────────────────────────────────

export function HistorySheet({ visible, onClose, revisions, loading, preview, previewLoading, onPreview, onRestore, mdStyles }) {
  const { colors, type } = useUIKit();
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Version history" subtitle={preview ? 'Preview' : 'Pick a version to preview it'} maxHeightRatio={0.9}>
      {loading ? <ActivityIndicator color={colors.primary} style={{ margin: SPACE.lg }} /> : null}
      {!loading && preview ? (
        <View>
          <View style={st.row}>
            <Button title="Back to versions" variant="ghost" size="sm" icon="chevron-back" onPress={() => onPreview(null)} />
            <Button title="Restore this version" variant="primary" size="sm" onPress={() => onRestore(preview.rev)} testID="documents-restore-revision" />
          </View>
          <View style={[st.previewBox, { borderColor: colors.border }]}>
            {preview.body ? <Markdown style={mdStyles}>{preview.body}</Markdown> : <Text style={[type.small, { color: colors.textMuted }]}>Empty version</Text>}
          </View>
        </View>
      ) : null}
      {!loading && !preview ? (
        <View>
          {!revisions.length ? (
            <EmptyState compact icon="time-outline" title="No earlier versions yet" message="Versions are captured as you edit (every few minutes) and each time you tap Done." />
          ) : null}
          {revisions.map((r) => {
            const l = revisionLabel(r);
            return <ListRow key={r.rev} icon="time-outline" title={l.title} subtitle={l.subtitle} onPress={() => onPreview(r.rev)} accessibilityLabel={`Preview version from ${l.title}`} />;
          })}
          {previewLoading ? <ActivityIndicator color={colors.primary} style={{ margin: SPACE.md }} /> : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}

// ── Trash ────────────────────────────────────────────────────

export function TrashSheet({ visible, onClose, nodes, loading, types, onRestore, onPurge }) {
  const { colors } = useUIKit();
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Trash" subtitle="Restore items, or delete them for good">
      {loading ? <ActivityIndicator color={colors.primary} style={{ margin: SPACE.lg }} /> : null}
      {!loading && nodes && !nodes.length ? <EmptyState compact icon="trash-outline" title="Trash is empty" /> : null}
      {(nodes || []).map((n) => (
        <ListRow
          key={n.id}
          leading={<NodeGlyph node={n} types={types} />}
          title={n.title}
          subtitle={n.deletedAt ? `Trashed ${relTime(n.deletedAt)}` : n.path}
          chevron={false}
          trailing={
            <View style={st.row}>
              <IconButton icon="arrow-undo-outline" size="sm" onPress={() => onRestore(n)} accessibilityLabel={`Restore ${n.title}`} />
              <IconButton icon="close-circle-outline" size="sm" tone="danger" onPress={() => onPurge(n)} accessibilityLabel={`Delete ${n.title} forever`} />
            </View>
          }
        />
      ))}
    </BottomSheet>
  );
}

// ── Type picker (editor chip) ────────────────────────────────

export function TypePickerSheet({ visible, onClose, types, current, onPick, onNewType, category, onCategory, categoryEnabled }) {
  const { colors, type } = useUIKit();
  const [cat, setCat] = useState(category || '');
  useEffect(() => {
    if (visible) setCat(category || '');
  }, [visible, category]);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Document type" subtitle="What kind of document this is">
      {assignableTypes(types).map((t) => (
        <ListRow
          key={t.id}
          leading={<TypeGlyph type={t} />}
          title={t.label}
          selected={t.id === current}
          trailing={t.id === current ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
          chevron={false}
          onPress={() => onPick(t.id)}
          accessibilityLabel={`Set type ${t.label}`}
        />
      ))}
      <ListRow icon="add-circle-outline" title="New type…" onPress={onNewType} chevron={false} accessibilityLabel="New type" />
      <SectionTitle title="Category" />
      <View style={st.row}>
        <TextInput
          value={cat}
          onChangeText={setCat}
          editable={categoryEnabled}
          placeholder={categoryEnabled ? 'e.g. client-research' : 'Needs the gateway restart for types'}
          placeholderTextColor={colors.textMuted}
          style={[type.body, st.input, { flex: 1, color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }]}
          onSubmitEditing={() => onCategory(cat)}
          accessibilityLabel="Category"
          testID="documents-category-input"
        />
        <Button title="Set" size="sm" variant="secondary" disabled={!categoryEnabled} onPress={() => onCategory(cat)} />
      </View>
    </BottomSheet>
  );
}

// ── Manage types ─────────────────────────────────────────────

const EMPTY_TYPE = { label: '', icon: 'tag', color: TYPE_COLOR_CHOICES[0], template: '' };

function IconChoices({ value, onChange }) {
  const { colors } = useUIKit();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipsRow}>
      {TYPE_ICON_CHOICES.map((name) => {
        const on = name === value;
        return (
          <Pressable
            key={name}
            onPress={() => onChange(name)}
            style={[st.iconChoice, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? withAlpha(colors.primary, 0.12) : 'transparent' }]}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Icon ${name}`}
          >
            <Ionicons name={ionIconFor(name)} size={18} color={on ? colors.primary : colors.textSecondary} />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ColorChoices({ value, onChange }) {
  const { colors } = useUIKit();
  return (
    <View style={st.swatches}>
      {TYPE_COLOR_CHOICES.map((c) => (
        <Pressable
          key={c}
          onPress={() => onChange(c)}
          style={[st.swatchHit]}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === c }}
          accessibilityLabel={`Colour ${c}`}
        >
          <View style={[st.swatch, { backgroundColor: c, borderColor: value === c ? colors.text : 'transparent' }]} />
        </Pressable>
      ))}
    </View>
  );
}

function TypeEditor({ t, onUpdate, onClose }) {
  const { colors, type } = useUIKit();
  const [label, setLabel] = useState(t.label);
  useEffect(() => setLabel(t.label), [t.label]);
  return (
    <View style={[st.editor, { borderColor: withAlpha(colors.primary, 0.3) }]}>
      {!t.builtin ? (
        <View style={st.row}>
          <TextInput
            value={label}
            onChangeText={setLabel}
            style={[type.body, st.input, { flex: 1, color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }]}
            accessibilityLabel="Type name"
          />
          <Button title="Rename" size="sm" variant="secondary" disabled={!label.trim() || label.trim() === t.label} onPress={() => onUpdate({ id: t.id, label: label.trim() }, 'Renamed')} />
        </View>
      ) : (
        <Text style={[type.small, { color: colors.textMuted }]}>Built-in type — can be hidden, recoloured and re-iconed.</Text>
      )}
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm }]}>Icon</Text>
      <IconChoices value={t.icon} onChange={(icon) => onUpdate({ id: t.id, icon })} />
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm }]}>Colour</Text>
      <ColorChoices value={t.color} onChange={(color) => onUpdate({ id: t.id, color })} />
      <View style={[st.row, { marginTop: SPACE.sm }]}>
        {t.builtin ? (
          <Button title={t.hidden ? 'Show' : 'Hide'} size="sm" variant="outline" onPress={() => onUpdate({ id: t.id, hidden: !t.hidden }, t.hidden ? 'Shown' : 'Hidden')} />
        ) : (
          <Button title={t.archived ? 'Restore' : 'Archive'} size="sm" variant="outline" onPress={() => onUpdate({ id: t.id, archived: !t.archived }, t.archived ? 'Restored' : 'Archived')} />
        )}
        <Button title="Close" size="sm" variant="ghost" onPress={onClose} />
      </View>
    </View>
  );
}

export function TypesSheet({ visible, onClose, types, counts, typesLive, onReorder, onUpdate, onCreate }) {
  const { colors, type } = useUIKit();
  const [editing, setEditing] = useState(null);
  const [nt, setNt] = useState(EMPTY_TYPE);
  const [busy, setBusy] = useState(false);
  const order = types.map((t) => t.id);
  const preview = typeById(types, null);
  const create = async () => {
    const p = newTypeParams(nt);
    if (!p) return;
    setBusy(true);
    const ok = await onCreate(p);
    setBusy(false);
    if (ok) setNt(EMPTY_TYPE);
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Document types" subtitle="Hide, recolour, reorder — or add your own" maxHeightRatio={0.92} testID="documents-types-sheet">
      {!typesLive ? (
        <Text style={[type.small, st.banner, { color: colors.warning, borderColor: withAlpha(colors.warning, 0.4) }]}>
          Read-only until the gateway restart that turns document types on.
        </Text>
      ) : null}
      {types.map((t, i) => (
        <View key={t.id}>
          <ListRow
            leading={<TypeGlyph type={t} />}
            title={t.label}
            subtitle={[t.builtin ? 'Built-in' : 'Custom', t.hidden ? 'hidden' : null, t.archived ? 'archived' : null].filter(Boolean).join(' · ')}
            value={String((counts && counts[t.id]) || 0)}
            style={t.hidden || t.archived ? { opacity: 0.6 } : null}
            onPress={() => setEditing(editing === t.id ? null : t.id)}
            chevron={false}
            accessibilityLabel={`Edit type ${t.label}`}
            trailing={
              <View style={st.row}>
                <IconButton icon="chevron-up" size="sm" disabled={!typesLive || i === 0} onPress={() => onReorder(moveInOrder(order, t.id, -1))} accessibilityLabel={`Move ${t.label} up`} />
                <IconButton icon="chevron-down" size="sm" disabled={!typesLive || i === order.length - 1} onPress={() => onReorder(moveInOrder(order, t.id, 1))} accessibilityLabel={`Move ${t.label} down`} />
              </View>
            }
          />
          {editing === t.id && typesLive ? <TypeEditor t={t} onUpdate={onUpdate} onClose={() => setEditing(null)} /> : null}
        </View>
      ))}
      <SectionTitle title="New type" />
      <TextInput
        value={nt.label}
        onChangeText={(label) => setNt({ ...nt, label })}
        placeholder="Name, e.g. Client brief"
        placeholderTextColor={colors.textMuted}
        style={[type.body, st.input, { color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }]}
        accessibilityLabel="New type name"
        testID="documents-type-name"
      />
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm }]}>Icon</Text>
      <IconChoices value={nt.icon} onChange={(icon) => setNt({ ...nt, icon })} />
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.sm }]}>Colour</Text>
      <ColorChoices value={nt.color} onChange={(color) => setNt({ ...nt, color })} />
      <TextInput
        value={nt.template}
        onChangeText={(template) => setNt({ ...nt, template })}
        placeholder="Optional template body (markdown). {{date}} becomes today."
        placeholderTextColor={colors.textMuted}
        multiline
        textAlignVertical="top"
        style={[type.small, st.input, { minHeight: 88, marginTop: SPACE.sm, color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }]}
        accessibilityLabel="Template body"
      />
      <View style={[st.row, { marginTop: SPACE.md, justifyContent: 'space-between' }]}>
        <View style={[st.row, { flexShrink: 1 }]}>
          <TypeGlyph type={{ ...preview, icon: nt.icon, color: nt.color }} />
          <Text style={[type.bodyStrong, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>
            {nt.label || 'Preview'}
          </Text>
        </View>
        <Button title="Create type" icon="add" variant="primary" size="sm" loading={busy} disabled={!typesLive || !nt.label.trim()} onPress={create} testID="documents-type-create" />
      </View>
    </BottomSheet>
  );
}

// ── Library filter sheet (categories + sort) ─────────────────

export function FilterSheet({ visible, onClose, categories, category, onCategory, sorts, sort, onSort, title = 'Sort & filter' }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <SectionTitle title="Sort" />
      <View style={st.wrapRow}>
        {sorts.map((s) => (
          <Chip key={s.key} label={s.label} selected={sort === s.key} onPress={() => onSort(s.key)} accessibilityLabel={`Sort by ${s.label}`} />
        ))}
      </View>
      {categories ? (
        <View>
          <SectionTitle title="Categories" />
          {!categories.length ? <EmptyState compact icon="pricetags-outline" title="No categories yet" message="Give a document a category from its type chip." /> : null}
          <View style={st.wrapRow}>
            {categories.length ? <Chip label="Any" selected={!category} onPress={() => onCategory(null)} accessibilityLabel="Any category" /> : null}
            {categories.map((c) => (
              <Chip key={c.category} icon="pricetag-outline" label={c.category} count={c.count} selected={category === c.category} onPress={() => onCategory(c.category)} accessibilityLabel={`Category ${c.category}`} />
            ))}
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

const st = StyleSheet.create({
  glyph: { borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 44 },
  previewBox: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.sm },
  chipsRow: { gap: SPACE.sm, paddingVertical: SPACE.xs },
  iconChoice: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  swatchHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
  editor: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginVertical: SPACE.xs },
  banner: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginBottom: SPACE.sm },
});
