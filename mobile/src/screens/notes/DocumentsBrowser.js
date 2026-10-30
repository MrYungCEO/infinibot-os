// DocumentsBrowser — mobile view of the Documents workspace (folders, docs,
// uploaded files). Read + basic edit: drill into folders, read docs and the
// extracted text of uploaded files (PDF/DOCX/…), edit a doc's markdown body.
//
// Uses the same documents.* gateway RPCs as the desktop Documents page, so an
// edit here streams to open desktop tabs (and agents see it) immediately.
// Colors come from the live theme via props (see NotesScreen).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { withAlpha } from '../../theme/color-utils';

function iconFor(node) {
  if (node.kind === 'folder') return node.schema && node.schema.length ? 'server-outline' : 'folder-outline';
  if (node.kind === 'doc') return 'document-text-outline';
  const mime = (node.file && node.file.mime) || '';
  if (mime === 'application/pdf') return 'document-outline';
  if (mime.startsWith('image/')) return 'image-outline';
  if (mime.startsWith('video/')) return 'film-outline';
  if (mime.startsWith('audio/')) return 'musical-notes-outline';
  return 'attach-outline';
}

function sortNodes(a, b) {
  if (a.kind === 'folder' && b.kind !== 'folder') return -1;
  if (b.kind === 'folder' && a.kind !== 'folder') return 1;
  const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  return sa !== sb ? sa - sb : String(a.title).localeCompare(String(b.title));
}

export default function DocumentsBrowser({ sendReq, colors, markdownStyles, onClose, initialDocId }) {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [folderStack, setFolderStack] = useState([]); // [{id,title}]
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(null);
  const [open, setOpen] = useState(null); // documents.get result
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const s = useMemo(() => makeStyles(colors), [colors]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendReq('documents.tree', {});
      setNodes(res?.nodes || []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [sendReq]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const res = await sendReq('documents.search', { query: q, limit: 40 });
        setHits(res?.hits || []);
      } catch {
        setHits([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, sendReq]);

  const folderId = folderStack.length ? folderStack[folderStack.length - 1].id : null;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const children = useMemo(
    () =>
      nodes
        .filter((n) => (n.parentId && byId.has(n.parentId) ? n.parentId : null) === folderId)
        .sort(sortNodes),
    [nodes, byId, folderId],
  );

  const openNode = useCallback(
    async (node) => {
      if (node.kind === 'folder') {
        setFolderStack((st) => [...st, { id: node.id, title: node.title }]);
        return;
      }
      try {
        const res = await sendReq('documents.get', { id: node.id });
        setOpen(res);
        setDraft(res?.body || '');
        setEditing(false);
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [sendReq],
  );

  // Opened from the Library with a specific document.
  useEffect(() => {
    if (initialDocId) openNode({ id: initialDocId, kind: 'doc' });
  }, [initialDocId, openNode]);

  const save = useCallback(async () => {
    if (!open) return;
    setSaving(true);
    try {
      await sendReq('documents.update', { id: open.node.id, body: draft, snapshot: true });
      setOpen({ ...open, body: draft });
      setEditing(false);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [open, draft, sendReq]);

  const createDoc = useCallback(async () => {
    try {
      const res = await sendReq('documents.create', { kind: 'doc', title: 'Untitled', parentId: folderId, body: '' });
      await load();
      if (res?.node) {
        setOpen({ node: res.node, body: '', breadcrumbs: [], backlinks: [], outgoing: [] });
        setDraft('');
        setEditing(true);
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, [sendReq, folderId, load]);

  // ── Document / file reader ──
  if (open) {
    const n = open.node;
    const isDoc = n.kind === 'doc';
    const text = isDoc ? open.body || '' : open.extracted || '';
    return (
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.bar}>
          <TouchableOpacity onPress={() => setOpen(null)} style={s.barBtn}>
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <Text style={s.barTitle} numberOfLines={1}>
            {n.title}
          </Text>
          {isDoc ? (
            editing ? (
              <TouchableOpacity onPress={save} style={s.barBtn} disabled={saving}>
                {saving ? <ActivityIndicator color={colors.primary} /> : <Text style={s.barAction}>Save</Text>}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => setEditing(true)} style={s.barBtn}>
                <Text style={s.barAction}>Edit</Text>
              </TouchableOpacity>
            )
          ) : null}
        </View>
        {n.properties && Object.keys(n.properties).length ? (
          <View style={s.props}>
            {Object.entries(n.properties).map(([k, v]) => (
              <Text key={k} style={s.prop} numberOfLines={1}>
                <Text style={s.propKey}>{k}: </Text>
                {Array.isArray(v) ? v.join(', ') : v === true ? <Ionicons name="checkmark" size={12} color={colors.primary} /> : v == null ? '' : String(v)}
              </Text>
            ))}
          </View>
        ) : null}
        {!isDoc && n.file ? (
          <Text style={s.fileMeta}>
            {n.file.name} · {Math.max(1, Math.round(n.file.size / 1024))} KB ·{' '}
            {n.file.extractStatus === 'ok' ? 'text extracted' : 'no text layer'}
          </Text>
        ) : null}
        {editing ? (
          <TextInput
            style={s.editor}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            textAlignVertical="top"
            placeholder="Markdown…"
            placeholderTextColor={colors.textMuted}
          />
        ) : (
          <ScrollView style={s.flex} contentContainerStyle={s.reader}>
            {text ? (
              <Markdown style={markdownStyles}>{text}</Markdown>
            ) : (
              <Text style={s.empty}>{isDoc ? 'Empty document' : 'No text to show for this file.'}</Text>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    );
  }

  // ── Folder listing ──
  const list = hits
    ? hits.map((h) => ({ ...(byId.get(h.id) || { id: h.id, kind: h.kind, title: h.title }), _snippet: h.snippet, _path: h.path }))
    : children;
  return (
    <View style={s.flex}>
      <View style={s.bar}>
        <TouchableOpacity
          onPress={() => (folderStack.length ? setFolderStack((st) => st.slice(0, -1)) : onClose && onClose())}
          style={s.barBtn}
        >
          <Ionicons name={folderStack.length ? 'chevron-back' : 'close'} size={20} color={colors.primary} />
        </TouchableOpacity>
        <Text style={s.barTitle} numberOfLines={1}>
          {folderStack.length ? folderStack.map((f) => f.title).join(' / ') : 'Documents'}
        </Text>
        <TouchableOpacity onPress={createDoc} style={s.barBtn}>
          <Ionicons name="add" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>
      <View style={s.search}>
        <Ionicons name="search-outline" size={16} color={colors.textMuted} />
        <TextInput
          style={s.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search documents & files…"
          placeholderTextColor={colors.textMuted}
        />
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <FlatList
        data={list}
        keyExtractor={(n) => n.id}
        refreshing={loading}
        onRefresh={load}
        ListEmptyComponent={
          loading ? null : <Text style={s.empty}>{hits ? 'No matches' : 'This folder is empty'}</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => openNode(item)} activeOpacity={0.8}>
            <Ionicons name={iconFor(item)} size={20} color={colors.primary} />
            <View style={s.rowText}>
              <Text style={s.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={s.rowSub} numberOfLines={1}>
                {item._snippet || item._path || item.preview || (item.kind === 'folder' ? 'Folder' : '')}
              </Text>
            </View>
            {item.kind === 'folder' ? <Ionicons name="chevron-forward" size={16} color={colors.textMuted} /> : null}
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(colors.primary, 0.25),
    },
    barBtn: { padding: 8, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    barTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '700' },
    barAction: { color: colors.primary, fontWeight: '700' },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      margin: 12,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.2),
    },
    searchInput: { flex: 1, color: colors.text, fontSize: 14 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: withAlpha(colors.primary, 0.1),
    },
    rowText: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowSub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
    empty: { color: colors.textMuted, textAlign: 'center', padding: 24 },
    error: { color: colors.error, paddingHorizontal: 16 },
    reader: { padding: 16, paddingBottom: 48 },
    editor: {
      flex: 1,
      color: colors.text,
      padding: 16,
      fontSize: 15,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    props: { paddingHorizontal: 16, paddingTop: 10, gap: 2 },
    prop: { color: colors.text, fontSize: 12.5 },
    propKey: { color: colors.textMuted },
    fileMeta: { color: colors.textMuted, fontSize: 12, paddingHorizontal: 16, paddingTop: 10 },
  });
}
