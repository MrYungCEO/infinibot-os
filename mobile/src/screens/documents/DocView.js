// DocView — one opened document or uploaded file (web workspace renderDoc /
// renderFile + toolbar): title rename, type chip + category, properties
// (editable; doc: relations open the target), markdown body rendered natively
// with an Edit mode that autosaves (debounced documents.update, snapshot on
// Done), remote-change banner, backlinks, favourite, version history +
// restore, move, trash, export .md. Files: meta, extract status, inline image
// preview, extracted text, re-extract, download / share the original.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';

import { AppHeader, BottomSheet, Button, Chip, EmptyState, ListRow, SegmentedControl, SPACE, RADIUS, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  SAVE_DEBOUNCE_MS,
  categoryParams,
  docRefIds,
  docTypeOf,
  errorText,
  exportMarkdown,
  extractStatusText,
  ocrStatusLine,
  formatBytes,
  formatProp,
  linkifyWiki,
  parsePropInput,
  previewKind,
  relTime,
  renameParams,
  resolveLink,
  saveStateLabel,
  typeById,
} from './documents-model';
import { HistorySheet, PromptModal, TypeGlyph, TypePickerSheet } from './DocumentsSheets';
import { fileSource, shareMarkdown, shareOriginal } from './documents-http';

function PropRow({ k, v, titleOf, onOpen, onSave }) {
  const { colors, type } = useUIKit();
  const refs = docRefIds(v);
  const [draft, setDraft] = useState(formatProp(v));
  useEffect(() => setDraft(formatProp(v)), [v]);
  return (
    <View style={s.propRow}>
      <Text style={[type.caption, s.propKey, { color: colors.textMuted }]} numberOfLines={2}>
        {k}
      </Text>
      {refs.length ? (
        <View style={[s.wrap, { flex: 1 }]}>
          {refs.map((id) => (
            <Chip key={id} icon="link-outline" label={titleOf(id) || id} size="sm" onPress={() => onOpen(id)} accessibilityLabel={`Open ${titleOf(id) || id}`} testID="doc-prop-link" />
          ))}
        </View>
      ) : (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onEndEditing={() => draft !== formatProp(v) && onSave(k, parsePropInput(v, draft))}
          onSubmitEditing={() => draft !== formatProp(v) && onSave(k, parsePropInput(v, draft))}
          style={[type.small, s.propInput, { color: colors.text, borderColor: colors.borderSubtle || colors.border }]}
          accessibilityLabel={`Property ${k}`}
        />
      )}
    </View>
  );
}

export function DocView({ id, sendReq, types, typesLive, index, nodes, remote, mdStyles, onBack, onOpen, onChanged, onMove, onTrash, onNewType, flash, startEditing }) {
  const { colors, type } = useUIKit();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(!!startEditing);
  const [draft, setDraft] = useState('');
  const [saveState, setSaveState] = useState('saved');
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [hist, setHist] = useState(null); // { revisions, loading, preview, previewLoading }
  const [fileTab, setFileTab] = useState('preview');
  const [imgSrc, setImgSrc] = useState(null);
  const [busy, setBusy] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const pending = useRef(null);
  const draftRef = useRef('');
  draftRef.current = draft;
  const timer = useRef(null);
  const ownWriteUntil = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;
  const detailRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await sendReq('documents.get', { id });
      if (idRef.current !== id) return;
      setDetail(d);
      detailRef.current = d;
      setError(null);
      setRemoteChanged(false);
      if (pending.current == null) setDraft(d?.body || '');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [id, sendReq]);

  // Local auto-OCR status for uploaded files (gateway files.context.get by docId).
  const [ocr, setOcr] = useState(null);
  const isFileNode = detail?.node?.kind === 'file' || detail?.kind === 'file';
  useEffect(() => {
    if (!isFileNode) {
      setOcr(null);
      return undefined;
    }
    let alive = true;
    let t = null;
    const poll = async () => {
      try {
        const r = await sendReq('files.context.get', { docId: id });
        if (!alive) return;
        setOcr(r?.found ? r : null);
        const st = r?.entry?.status;
        if (st === 'queued' || st === 'processing') {
          t = setTimeout(poll, 4000);
        } else if (st === 'done' && detailRef.current?.node?.file?.extractStatus === 'pending') {
          void load(); // OCR text just landed in the document
        }
      } catch {
        if (alive) setOcr(null); // older gateway without auto-OCR
      }
    };
    void poll();
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, [id, isFileNode, sendReq, load]);

  useEffect(() => {
    setLoading(true);
    setDetail(null);
    setFileTab('preview');
    setImgSrc(null);
    pending.current = null;
    setSaveState('saved');
    void load();
  }, [load]);

  // Flush on unmount / doc switch.
  const flush = useCallback(
    async (snapshot = false) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const body = pending.current;
      if (body == null && !snapshot) return true;
      const docId = idRef.current;
      pending.current = null;
      setSaveState('saving');
      ownWriteUntil.current = Date.now() + 3000;
      try {
        const params = { id: docId, snapshot };
        if (body != null) params.body = body;
        else if (snapshot) params.body = draftRef.current;
        await sendReq('documents.update', params);
        ownWriteUntil.current = Date.now() + 1500;
        setDetail((d) => (d && d.node.id === docId ? { ...d, body: params.body } : d));
        setSaveState(pending.current == null ? 'saved' : 'dirty');
        onChanged?.();
        return true;
      } catch (e) {
        pending.current = body;
        setSaveState('error');
        flash(`Save failed: ${errorText(e)}`);
        return false;
      }
    },
    [sendReq, flash, onChanged],
  );
  useEffect(() => () => {
    if (pending.current != null) void flush(false);
  }, [flush]);

  // Live updates from other devices / agents.
  useEffect(() => {
    if (!remote || !detail) return;
    if (remote.op === 'delete' && remote.id === id) {
      flash('This document was deleted elsewhere');
      onBack();
      return;
    }
    if (remote.id && remote.id !== id) return;
    if (Date.now() < ownWriteUntil.current) return;
    if (editing && (pending.current != null || saveState === 'dirty' || saveState === 'saving')) {
      setRemoteChanged(true);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  const n = detail?.node;
  const isDoc = n?.kind === 'doc';
  const isFile = n?.kind === 'file';

  useEffect(() => {
    if (!isFile || previewKind(n.file) !== 'image') return;
    fileSource(sendReq, n.id).then(setImgSrc).catch(() => setImgSrc(null));
  }, [isFile, n, sendReq]);

  const onDraft = (md) => {
    setDraft(md);
    pending.current = md;
    setSaveState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(false), SAVE_DEBOUNCE_MS);
  };

  const finishEditing = async () => {
    const ok = await flush(true);
    if (ok) setEditing(false);
  };

  const act = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      if (ok) flash(ok);
    } catch (e) {
      flash(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const update = (params, ok) =>
    act(
      'update',
      async () => {
        ownWriteUntil.current = Date.now() + 1500;
        await sendReq('documents.update', params);
        await load();
        onChanged?.();
      },
      ok,
    );

  const titleOf = useCallback((tid) => index.byId.get(tid)?.title, [index]);

  const openLink = (url) => {
    let target = String(url || '');
    if (target.startsWith('wiki:')) target = decodeURIComponent(target.slice(5));
    const r = resolveLink(index, nodes, target);
    if (!r) return false;
    if (r.kind === 'url') {
      Linking.openURL(r.url).catch(() => {});
      return false;
    }
    if (r.kind === 'doc') {
      void flush(false).then(() => onOpen(r.id));
      return false;
    }
    flash(`"${r.title}" doesn't exist yet`);
    return false;
  };

  const openHistory = async () => {
    await flush(false);
    setHist({ revisions: [], loading: true, preview: null });
    try {
      const r = await sendReq('documents.history', { id });
      setHist({ revisions: r?.revisions || [], loading: false, preview: null });
    } catch (e) {
      setHist(null);
      flash(errorText(e));
    }
  };
  const previewRev = async (rev) => {
    if (!rev) {
      setHist((h) => ({ ...h, preview: null }));
      return;
    }
    setHist((h) => ({ ...h, previewLoading: true }));
    try {
      const r = await sendReq('documents.revision', { id, rev });
      setHist((h) => ({ ...h, previewLoading: false, preview: { rev, body: r?.body || '' } }));
    } catch (e) {
      setHist((h) => ({ ...h, previewLoading: false }));
      flash(errorText(e));
    }
  };
  const restoreRev = (rev) =>
    act(
      'restore',
      async () => {
        await sendReq('documents.restoreRevision', { id, rev });
        setHist(null);
        pending.current = null;
        await load();
        onChanged?.();
      },
      'Revision restored',
    );

  const body = isDoc ? (editing ? draft : detail?.body || '') : detail?.extracted || '';
  const t = n ? typeById(types, docTypeOf(n) || 'document') : null;
  const inferred = n && (n.typeInferred || !n.type);
  const md = useMemo(() => linkifyWiki(body), [body]);

  const rightActions = n
    ? [
        ...(isDoc ? [{ key: 'edit', icon: editing ? 'checkmark-done' : 'create-outline', onPress: editing ? finishEditing : () => setEditing(true), label: editing ? 'Done editing' : 'Edit' }] : []),
        { key: 'fav', icon: n.favorite ? 'star' : 'star-outline', onPress: () => update({ id: n.id, favorite: !n.favorite }), label: n.favorite ? 'Unfavourite' : 'Favourite' },
        { key: 'more', icon: 'ellipsis-horizontal', onPress: () => setMoreOpen(true), label: 'More actions' },
      ]
    : [];

  const crumbs = (detail?.breadcrumbs || []).filter((c) => c.id !== n?.id);

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AppHeader
        variant="nav"
        title={n ? n.title : 'Document'}
        subtitle={crumbs.length ? crumbs.map((c) => c.title).join(' / ') : isDoc ? saveStateLabel(saveState) : undefined}
        leftIcon="chevron-back"
        leftLabel="Back"
        onLeftPress={async () => {
          await flush(false);
          onBack();
        }}
        rightActions={rightActions}
        testID="documents-doc-header"
      />
      {loading && !detail ? <ActivityIndicator color={colors.primary} style={{ marginTop: SPACE.xl }} /> : null}
      {error && !detail ? (
        <EmptyState icon="alert-circle-outline" tone="danger" title="Couldn't open this document" message={error} actionLabel="Retry" onAction={load} secondaryLabel="Back" onSecondary={onBack} />
      ) : null}
      {n ? (
        <ScrollView
          style={s.flex}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={editing ? undefined : <RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        >
          <Pressable onPress={() => setRenameOpen(true)} accessibilityRole="button" accessibilityLabel="Rename" style={s.titleRow}>
            {t ? <TypeGlyph type={isFile ? { icon: 'fileText', color: colors.primary } : t} size={20} /> : null}
            <Text style={[type.h1, { color: colors.text, flex: 1 }]}>{n.title}</Text>
            <Ionicons name="pencil-outline" size={16} color={colors.textMuted} />
          </Pressable>

          {isDoc ? (
            <View style={[s.wrap, { marginTop: SPACE.sm }]}>
              <Chip
                label={`${t.label}${inferred ? ' · auto' : ''}`}
                color={t.color}
                onPress={() => setTypeOpen(true)}
                accessibilityLabel="Change type"
                testID="documents-type-chip"
              />
              {n.category ? <Chip icon="pricetag-outline" label={n.category} onPress={() => setTypeOpen(true)} accessibilityLabel="Change category" /> : null}
              {n.source?.type === 'notion' && n.source.url ? <Chip icon="open-outline" label="Notion" onPress={() => Linking.openURL(n.source.url)} accessibilityLabel="Open in Notion" /> : null}
              {n.source?.type === 'note' ? <Chip label="Synced note" size="sm" /> : null}
              <Text style={[type.caption, { color: colors.textMuted, alignSelf: 'center' }]}>Updated {relTime(n.updatedAt)}</Text>
            </View>
          ) : null}

          {isFile && n.file ? (
            <View style={{ marginTop: SPACE.sm }}>
              <View style={s.wrap}>
                <Chip label={String(n.file.ext || '').replace('.', '').toUpperCase() || 'FILE'} size="sm" />
                <Text style={[type.small, { color: colors.textSecondary }]}>{formatBytes(n.file.size)}</Text>
                <Text style={[type.caption, { color: colors.textMuted, flexShrink: 1 }]} numberOfLines={1}>
                  {n.file.name}
                </Text>
              </View>
              <Text style={[type.caption, { color: n.file.extractStatus === 'error' ? colors.error : colors.textMuted, marginTop: SPACE.xs }]}>{extractStatusText(n.file)}</Text>
              {ocr?.entry ? (
                <Text testID="documents-ocr-status" style={[type.caption, { color: ocr.entry.status === 'failed' ? colors.error : colors.textMuted, marginTop: 2 }]}>
                  {ocrStatusLine(ocr)}
                </Text>
              ) : null}
              <View style={[s.wrap, { marginTop: SPACE.sm }]}>
                <Button title="Download / share" icon="share-outline" size="sm" variant="secondary" loading={busy === 'dl'} onPress={() => act('dl', () => shareOriginal(sendReq, n))} />
                <Button
                  title="Re-extract"
                  icon="refresh"
                  size="sm"
                  variant="ghost"
                  loading={busy === 'rx'}
                  onPress={() => act('rx', async () => { await sendReq('documents.reextract', { id: n.id }); await load(); }, 'Text re-extracted')}
                />
              </View>
              <SegmentedControl
                size="sm"
                style={{ marginTop: SPACE.md }}
                options={[{ key: 'preview', label: 'Preview' }, { key: 'text', label: 'Extracted text' }]}
                value={fileTab}
                onChange={(k) => (k === 'text' && !detail.extracted ? null : setFileTab(k))}
              />
            </View>
          ) : null}

          {n.properties && Object.keys(n.properties).length ? (
            <View style={[s.props, { borderColor: colors.border }]}>
              {Object.keys(n.properties).map((k) => (
                <PropRow key={k} k={k} v={n.properties[k]} titleOf={titleOf} onOpen={onOpen} onSave={(key, val) => update({ id: n.id, properties: { ...n.properties, [key]: val } })} />
              ))}
            </View>
          ) : null}

          {remoteChanged ? (
            <View style={[s.banner, { borderColor: withAlpha(colors.warning, 0.5) }]}>
              <Text style={[type.small, { color: colors.text, flex: 1 }]}>This document was changed elsewhere (maybe by an agent).</Text>
              <Button
                title="Load latest"
                size="sm"
                variant="outline"
                onPress={() => {
                  pending.current = null;
                  setSaveState('saved');
                  void load();
                }}
              />
            </View>
          ) : null}

          {isDoc && editing ? (
            <TextInput
              value={draft}
              onChangeText={onDraft}
              multiline
              autoFocus={!!startEditing}
              textAlignVertical="top"
              placeholder="Start writing — markdown, [[Title]] links a doc"
              placeholderTextColor={colors.textMuted}
              style={[s.editor, type.mono, { color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }]}
              accessibilityLabel="Document body"
              testID="documents-editor"
            />
          ) : null}

          {isFile && fileTab === 'preview' && previewKind(n.file) === 'image' ? (
            imgSrc ? (
              <Image source={imgSrc} style={[s.image, { borderColor: colors.border }]} resizeMode="contain" accessibilityLabel={n.title} />
            ) : (
              <ActivityIndicator color={colors.primary} style={{ margin: SPACE.lg }} />
            )
          ) : null}
          {isFile && fileTab === 'preview' && previewKind(n.file) !== 'image' && previewKind(n.file) !== 'text' ? (
            <EmptyState
              compact
              icon={previewKind(n.file) === 'pdf' ? 'document-text-outline' : previewKind(n.file) === 'video' ? 'film-outline' : previewKind(n.file) === 'audio' ? 'musical-notes-outline' : 'attach-outline'}
              title="Open it in another app"
              message={detail.extracted ? 'Download / share opens the original. The extracted text is one tab over.' : 'Download / share opens the original file.'}
              actionLabel={detail.extracted ? 'Show extracted text' : undefined}
              onAction={detail.extracted ? () => setFileTab('text') : undefined}
            />
          ) : null}

          {(isDoc && !editing) || (isFile && (fileTab === 'text' || previewKind(n.file) === 'text')) ? (
            <View style={s.reader}>
              {body ? (
                <Markdown style={mdStyles} onLinkPress={openLink}>
                  {md}
                </Markdown>
              ) : (
                <Pressable onPress={() => isDoc && setEditing(true)} accessibilityRole="button" accessibilityLabel="Start writing" style={s.emptyHit}>
                  <Text style={[type.body, { color: colors.textMuted }]}>{isDoc ? 'Empty document — tap to start writing.' : 'No text to show for this file.'}</Text>
                </Pressable>
              )}
              {isFile && detail.extractedTruncated ? <Text style={[type.caption, { color: colors.textMuted }]}>Showing the first part of the text.</Text> : null}
            </View>
          ) : null}

          {detail.backlinks && detail.backlinks.length ? (
            <View style={{ marginTop: SPACE.lg }}>
              <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.sm }]}>Linked from</Text>
              <View style={s.wrap}>
                {detail.backlinks.map((b) => (
                  <Chip key={b.id} icon="return-up-back-outline" label={b.title} onPress={() => onOpen(b.id)} accessibilityLabel={`Open ${b.title}`} />
                ))}
              </View>
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      <PromptModal
        visible={renameOpen}
        title="Rename"
        initial={n?.title}
        onClose={() => setRenameOpen(false)}
        onSubmit={(v) => {
          setRenameOpen(false);
          const p = renameParams(n, v);
          if (p) void update(p);
        }}
      />
      {n ? (
        <TypePickerSheet
          visible={typeOpen}
          onClose={() => setTypeOpen(false)}
          types={types}
          current={docTypeOf(n)}
          category={n.category}
          categoryEnabled={typesLive}
          onNewType={() => {
            setTypeOpen(false);
            onNewType();
          }}
          onPick={(tid) => {
            setTypeOpen(false);
            if (tid === n.type) return;
            if (!typesLive) {
              flash('Changing a type needs the gateway restart that turns document types on.');
              return;
            }
            void update({ id: n.id, type: tid }, `Now a ${typeById(types, tid).label}`);
          }}
          onCategory={(raw) => {
            setTypeOpen(false);
            const p = categoryParams(n, raw);
            if (p) void update(p);
          }}
        />
      ) : null}
      <HistorySheet
        visible={!!hist}
        onClose={() => setHist(null)}
        revisions={hist?.revisions || []}
        loading={!!hist?.loading}
        preview={hist?.preview || null}
        previewLoading={!!hist?.previewLoading}
        onPreview={previewRev}
        onRestore={restoreRev}
        mdStyles={mdStyles}
      />
      {n ? (
        <MoreSheet
          visible={moreOpen}
          onClose={() => setMoreOpen(false)}
          node={n}
          isDoc={isDoc}
          onHistory={() => {
            setMoreOpen(false);
            void openHistory();
          }}
          onExport={() => {
            setMoreOpen(false);
            void act('export', async () => {
              await flush(false);
              await shareMarkdown(n.title, exportMarkdown(n, editing ? draft : detail?.body));
            });
          }}
          onRename={() => {
            setMoreOpen(false);
            setRenameOpen(true);
          }}
          onType={() => {
            setMoreOpen(false);
            setTypeOpen(true);
          }}
          onMove={() => {
            setMoreOpen(false);
            onMove(n);
          }}
          onTrash={() => {
            setMoreOpen(false);
            onTrash(n);
          }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}

function MoreSheet({ visible, onClose, node, isDoc, onHistory, onExport, onRename, onType, onMove, onTrash }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title={node.title}>
      {isDoc ? <ListRow icon="time-outline" title="Version history" onPress={onHistory} chevron={false} accessibilityLabel="Version history" testID="documents-history" /> : null}
      {isDoc ? <ListRow icon="pricetags-outline" title="Type & category" onPress={onType} chevron={false} accessibilityLabel="Type and category" /> : null}
      {isDoc ? <ListRow icon="share-outline" title="Export Markdown" onPress={onExport} chevron={false} accessibilityLabel="Export Markdown" /> : null}
      <ListRow icon="create-outline" title="Rename" onPress={onRename} chevron={false} accessibilityLabel="Rename" />
      <ListRow icon="return-down-forward-outline" title="Move to…" onPress={onMove} chevron={false} accessibilityLabel="Move" />
      <ListRow icon="trash-outline" iconTone="danger" title="Move to trash" onPress={onTrash} chevron={false} accessibilityLabel="Move to trash" />
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: SPACE.lg, paddingBottom: 96 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.sm },
  props: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md, gap: SPACE.xs },
  propRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  propKey: { width: 110 },
  propInput: { flex: 1, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: SPACE.xs, minHeight: 40 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
  editor: { minHeight: 360, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
  reader: { marginTop: SPACE.md },
  emptyHit: { minHeight: 44, justifyContent: 'center' },
  image: { width: '100%', aspectRatio: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.md, marginTop: SPACE.md },
});
