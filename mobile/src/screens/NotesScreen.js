// NotesScreen — markdown notes with edit/preview tabs.
//
// Goes through the same gateway methods (`notes.list`, `notes.get`,
// `notes.create`, `notes.update`, `notes.delete`) that the desktop UI
// Notes view (ui/src/ui/controllers/notes.ts) consumes. The gateway
// routes those through the system-role bridge when "notes" is mapped to
// a database, so any note created here shows up in the desktop UI list
// immediately and vice versa.
//
// All colors come from the live theme via `useTheme()` — palette swaps on
// the master device repaint this screen without remount.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Markdown from 'react-native-markdown-display';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useTheme } from '../theme/ThemeProvider';
import { SPACING, TYPOGRAPHY, FONTS, FONT_FAMILY } from '../constants/theme';
import { withAlpha, innerTopHighlight } from '../theme/color-utils';
import HandwritingEditor from './notes/HandwritingEditor';
import DocumentsBrowser from './notes/DocumentsBrowser';
import { isCanvasNote, decodeNoteBody } from './notes/canvasFormat';
import { ProjectField } from '../components/ProjectPicker';
import { ClientField } from '../components/ClientPicker';
import { DateField } from '../components/DatePicker';
import { useClientCatalog } from '../lib/useClientCatalog';
import { joinWhen, splitWhen } from '../lib/date-pick';
import { useProjectCatalog } from '../lib/useProjectCatalog';

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return '';
  }
}

function NoteListItem({ note, onPress, index, colors, styles: s }) {
  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, {
      toValue: 1,
      duration: 260,
      delay: Math.min(index * 40, 240),
      useNativeDriver: true,
    }).start();
  }, []);
  return (
    <Animated.View style={{ opacity: fade }}>
      <TouchableOpacity
        style={s.noteCard}
        onPress={() => onPress(note)}
        activeOpacity={0.85}
      >
        <LinearGradient
          colors={[
            withAlpha(note.pinned ? colors.primary : colors.accent, 0.14),
            withAlpha(note.pinned ? colors.primary : colors.accent, 0.02),
            'rgba(0,0,0,0.25)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            s.noteCardBorder,
            { backgroundColor: note.pinned ? colors.primary : colors.accent },
          ]}
        />
        <View style={s.noteCardContent}>
          <View style={s.noteCardHeaderRow}>
            <View style={s.noteCardTitleRow}>
              {note.pinned ? (
                <Ionicons
                  name="pin"
                  size={12}
                  color={colors.primary}
                  style={{ marginRight: 6 }}
                />
              ) : null}
              <Text style={s.noteCardTitle} numberOfLines={1}>
                {note.name || '(untitled)'}
              </Text>
            </View>
            <Text style={s.noteCardDate}>{fmtDate(note.updatedAt)}</Text>
          </View>

          {note.description ? (
            <Text style={s.noteCardDesc} numberOfLines={1}>
              {note.description}
            </Text>
          ) : null}
          {note.preview ? (
            <Text style={s.noteCardPreview} numberOfLines={2}>
              {note.preview}
            </Text>
          ) : null}

          {(note.category || (note.tags && note.tags.length)) ? (
            <View style={s.noteCardFooter}>
              {note.category ? (
                <View
                  style={[
                    s.noteBadge,
                    {
                      backgroundColor: colors.primary + '14',
                      borderColor: colors.primary + '33',
                    },
                  ]}
                >
                  <Text style={[s.noteBadgeText, { color: colors.primary }]}>
                    {note.category}
                  </Text>
                </View>
              ) : null}
              {note.tags?.slice(0, 3).map((t, i) => (
                <View
                  key={i}
                  style={[
                    s.noteBadge,
                    {
                      backgroundColor: colors.accent + '14',
                      borderColor: colors.accent + '33',
                    },
                  ]}
                >
                  <Text style={[s.noteBadgeText, { color: colors.accent }]}>
                    {t}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

export function NotesScreen({ gateway, route }) {
  const { colors } = useTheme();
  const { sendReq, status } = gateway || {};
  const isConnected = status === 'connected';

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Editor state
  const [editorVisible, setEditorVisible] = useState(false);
  const [editingNote, setEditingNote] = useState(null);
  const [editorName, setEditorName] = useState('');
  const [editorBody, setEditorBody] = useState('');
  const [editorCategory, setEditorCategory] = useState('');
  const [editorTags, setEditorTags] = useState('');
  const [editorPinned, setEditorPinned] = useState(false);
  const [editorProject, setEditorProject] = useState(null); // { id, name } | null
  const [editorClient, setEditorClient] = useState(null); // { id, name } | null
  const [editorWhen, setEditorWhen] = useState({ date: null, time: null }); // review / follow-up date
  const clientCatalog = useClientCatalog(gateway, { enabled: editorVisible });
  const catalog = useProjectCatalog(gateway, { enabled: editorVisible });
  const [saving, setSaving] = useState(false);
  const [editorTab, setEditorTab] = useState('edit'); // 'edit' | 'preview'
  // Documents workspace (folders, uploaded files, Notion imports) browser.
  const [docsVisible, setDocsVisible] = useState(false);

  // Handwriting-canvas editor (GoodNotes-style) state.
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [canvasNote, setCanvasNote] = useState(null);
  const [canvasDoc, setCanvasDoc] = useState(null);
  const [canvasName, setCanvasName] = useState('');

  // Debounced preview body so live preview doesn't re-render on every keystroke.
  const [previewBody, setPreviewBody] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setPreviewBody(editorBody), 200);
    return () => clearTimeout(id);
  }, [editorBody]);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 280,
      useNativeDriver: true,
    }).start();
  }, []);

  const loadNotes = useCallback(async () => {
    if (!sendReq || !isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await sendReq('notes.list', {
        query: searchQuery || undefined,
      });
      setNotes(res?.notes || []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [sendReq, isConnected, searchQuery]);

  useEffect(() => {
    if (isConnected) loadNotes();
  }, [isConnected]);

  useEffect(() => {
    if (!isConnected) return;
    const timer = setTimeout(() => loadNotes(), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const openNote = useCallback(
    async (note) => {
      if (!sendReq) return;
      try {
        const full = await sendReq('notes.get', { id: note.id });
        // Handwriting notes open in the GoodNotes-style canvas editor instead
        // of the markdown editor.
        if (isCanvasNote(full)) {
          const { markdown, doc } = decodeNoteBody(full.body || '');
          setCanvasNote({ ...full, _ocrMarkdown: markdown });
          setCanvasDoc(doc);
          setCanvasName(full.name || '');
          setCanvasVisible(true);
          return;
        }
        setEditingNote(full);
        setEditorName(full.name || '');
        setEditorBody(full.body || '');
        setEditorCategory(full.category || '');
        setEditorTags(full.tags?.join(', ') || '');
        setEditorPinned(!!full.pinned);
        setEditorProject(full.projectId ? { id: full.projectId } : null);
        setEditorClient(full.clientId ? { id: full.clientId } : null);
        setEditorWhen(splitWhen(full.reviewOn));
        setPreviewBody(full.body || '');
        setEditorTab(full.body ? 'preview' : 'edit');
        setEditorVisible(true);
      } catch (err) {
        setError(err?.message || String(err));
      }
    },
    [sendReq],
  );

  const startCreate = useCallback(() => {
    setEditingNote(null);
    setEditorName('');
    setEditorBody('');
    setEditorCategory('');
    setEditorTags('');
    setEditorPinned(false);
    setEditorProject(null);
    setEditorClient(null);
    setEditorWhen({ date: null, time: null });
    setPreviewBody('');
    setEditorTab('edit');
    setEditorVisible(true);
  }, []);

  const startHandwriting = useCallback(() => {
    setCanvasNote(null);
    setCanvasDoc(null);
    setCanvasName('');
    setCanvasVisible(true);
  }, []);

  // Deep-link from Library: ?docId=... opens the Documents browser on that doc.
  const incomingDocId = route?.params?.docId;
  useEffect(() => {
    if (incomingDocId && isConnected) setDocsVisible(true);
  }, [incomingDocId, isConnected]);

  // Deep-link from Library: ?noteId=...
  const incomingNoteId = route?.params?.noteId;
  useEffect(() => {
    if (!incomingNoteId || !isConnected) return;
    openNote({ id: incomingNoteId });
  }, [incomingNoteId, isConnected, openNote]);

  const handleSave = useCallback(async () => {
    if (!sendReq || !editorName.trim()) return;
    setSaving(true);
    try {
      const tags = editorTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const payload = {
        name: editorName.trim(),
        body: editorBody,
        category: editorCategory.trim() || undefined,
        tags: tags.length ? tags : undefined,
        pinned: editorPinned || undefined,
      };
      if (editingNote) {
        // "" clears the project (notes.update keeps the old value for undefined).
        // Same for the client and the review date.
        await sendReq('notes.update', {
          id: editingNote.id,
          ...payload,
          projectId: editorProject?.id || '',
          clientId: editorClient?.id || '',
          reviewOn: joinWhen(editorWhen.date, editorWhen.time),
        });
      } else {
        await sendReq('notes.create', {
          ...payload,
          ...(editorProject?.id ? { projectId: editorProject.id } : {}),
          ...(editorClient?.id ? { clientId: editorClient.id } : {}),
          ...(editorWhen.date ? { reviewOn: joinWhen(editorWhen.date, editorWhen.time) } : {}),
        });
      }
      if (editorProject?.id) catalog.markUsed(editorProject.id);
      if (editorClient?.id) clientCatalog.markUsed(editorClient.id);
      setEditorVisible(false);
      loadNotes();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }, [
    sendReq,
    editingNote,
    editorName,
    editorBody,
    editorCategory,
    editorTags,
    editorPinned,
    editorProject,
    editorClient,
    editorWhen,
    catalog,
    clientCatalog,
    loadNotes,
  ]);

  const handleDelete = useCallback(async () => {
    if (!sendReq || !editingNote) return;
    try {
      await sendReq('notes.delete', { id: editingNote.id });
      setEditorVisible(false);
      loadNotes();
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, [sendReq, editingNote, loadNotes]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadNotes();
    setRefreshing(false);
  }, [loadNotes]);

  const styles = useMemo(() => makeStyles(colors), [colors]);
  const markdownStyles = useMemo(() => makeMarkdownStyles(colors), [colors]);

  if (!isConnected) {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={36} color={colors.textMuted} />
        <Text style={styles.emptyText}>Not connected to gateway</Text>
      </View>
    );
  }

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <Modal visible={docsVisible} animationType="slide" onRequestClose={() => setDocsVisible(false)}>
        <View style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 44 : 0 }]}>
          {docsVisible ? (
            <DocumentsBrowser
              sendReq={sendReq}
              colors={colors}
              markdownStyles={markdownStyles}
              initialDocId={incomingDocId}
              onClose={() => setDocsVisible(false)}
            />
          ) : null}
        </View>
      </Modal>
      {/* Search + create — gradient glass header slab */}
      <View style={styles.headerSlab}>
        <BlurView intensity={Platform.OS === 'android' ? 45 : 50} tint="dark" style={StyleSheet.absoluteFill} />
        <LinearGradient
          colors={[
            withAlpha(colors.primary, 0.22),
            withAlpha(colors.primary, 0.06),
            'rgba(0,0,0,0.4)',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={innerTopHighlight}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 0.6 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[StyleSheet.absoluteFill, styles.headerSlabBorder, { borderColor: withAlpha(colors.primary, 0.18) }]} />
        <View style={styles.searchRow}>
          <View style={styles.searchInputWrapper}>
            <Ionicons name="search-outline" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search notes…"
              placeholderTextColor={colors.textMuted}
            />
            {searchQuery ? (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            ) : null}
          </View>
          <TouchableOpacity
            style={[
              styles.createBtn,
              {
                backgroundColor: withAlpha(colors.primary, 0.16),
                borderWidth: 1,
                borderColor: withAlpha(colors.primary, 0.5),
              },
            ]}
            onPress={() => setDocsVisible(true)}
            activeOpacity={0.85}
            accessibilityLabel="Open Documents"
          >
            <Ionicons name="folder-open-outline" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.createBtn,
              {
                backgroundColor: withAlpha(colors.primary, 0.16),
                borderWidth: 1,
                borderColor: withAlpha(colors.primary, 0.5),
              },
            ]}
            onPress={startHandwriting}
            activeOpacity={0.85}
          >
            <Ionicons name="pencil" size={18} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.createBtn, { backgroundColor: colors.primary }]}
            onPress={startCreate}
            activeOpacity={0.85}
          >
            <Ionicons name="add" size={20} color={colors.bg || colors.background} />
          </TouchableOpacity>
        </View>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={14} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Ionicons name="close" size={14} color={colors.error} />
          </TouchableOpacity>
        </View>
      ) : null}

      <FlatList
        data={notes}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <NoteListItem
            note={item}
            onPress={openNote}
            index={index}
            colors={colors}
            styles={styles}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            {loading ? (
              <ActivityIndicator color={colors.primary} size="large" />
            ) : (
              <View style={styles.emptyInner}>
                <Ionicons
                  name="document-text-outline"
                  size={44}
                  color={colors.textMuted}
                />
                <Text style={styles.emptyTitle}>
                  {searchQuery ? 'No matches' : 'No notes yet'}
                </Text>
                <Text style={styles.emptySubtitle}>
                  {searchQuery
                    ? 'Try a different search term'
                    : 'Capture an idea, log a meeting, or jot a quick thought'}
                </Text>
                {!searchQuery ? (
                  <TouchableOpacity
                    style={[
                      styles.emptyCta,
                      {
                        backgroundColor: colors.primary + '18',
                        borderColor: colors.primary + '40',
                      },
                    ]}
                    onPress={startCreate}
                  >
                    <Ionicons name="add-circle" size={18} color={colors.primary} />
                    <Text style={[styles.emptyCtaText, { color: colors.primary }]}>
                      Create your first note
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
          </View>
        }
        contentContainerStyle={{
          paddingHorizontal: SPACING.md,
          paddingTop: SPACING.md,
          paddingBottom: 40,
          flexGrow: 1,
          gap: SPACING.sm,
        }}
      />

      <Modal
        visible={editorVisible}
        animationType="slide"
        onRequestClose={() => setEditorVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.editorContainer}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.editorHeader}>
            <TouchableOpacity
              onPress={() => setEditorVisible(false)}
              hitSlop={10}
            >
              <Text style={styles.editorCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.editorTitle} numberOfLines={1}>
              {editingNote ? 'Edit Note' : 'New Note'}
            </Text>
            <TouchableOpacity
              onPress={handleSave}
              disabled={saving || !editorName.trim()}
              hitSlop={10}
            >
              <Text
                style={[
                  styles.editorSave,
                  (!editorName.trim() || saving) && { opacity: 0.4 },
                ]}
              >
                {saving ? '…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Title + meta */}
          <View style={styles.editorMeta}>
            <TextInput
              style={styles.editorNameInput}
              value={editorName}
              onChangeText={setEditorName}
              placeholder="Note title"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.metaRow}>
              <TextInput
                style={styles.editorMetaInput}
                value={editorCategory}
                onChangeText={setEditorCategory}
                placeholder="Category"
                placeholderTextColor={colors.textMuted}
              />
              <TextInput
                style={[styles.editorMetaInput, { flex: 2 }]}
                value={editorTags}
                onChangeText={setEditorTags}
                placeholder="Tags (comma separated)"
                placeholderTextColor={colors.textMuted}
              />
              <TouchableOpacity
                style={[
                  styles.pinToggle,
                  editorPinned
                    ? {
                        backgroundColor: colors.primary + '22',
                        borderColor: colors.primary + '60',
                      }
                    : {
                        backgroundColor: colors.surface,
                        borderColor: colors.primary + '22',
                      },
                ]}
                onPress={() => setEditorPinned((v) => !v)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={editorPinned ? 'pin' : 'pin-outline'}
                  size={16}
                  color={editorPinned ? colors.primary : colors.textMuted}
                />
              </TouchableOpacity>
            </View>
            <ProjectField
              catalog={catalog}
              projectId={editorProject?.id}
              projectName={editorProject?.name}
              onChange={(p) => setEditorProject(p)}
              testID="note-project"
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <ClientField
                  catalog={clientCatalog}
                  clientId={editorClient?.id}
                  clientName={editorClient?.name}
                  onChange={(c) => setEditorClient(c)}
                  testID="note-client"
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <DateField
                  label="Review on"
                  empty="No date"
                  date={editorWhen.date}
                  time={editorWhen.time}
                  onChange={(v) => setEditorWhen({ date: v.date || null, time: v.date ? v.time || null : null })}
                  testID="note-date"
                />
              </View>
            </View>
          </View>

          {/* Mode tabs */}
          <View style={styles.tabBar}>
            <TouchableOpacity
              style={[
                styles.tab,
                editorTab === 'edit' && {
                  backgroundColor: colors.primary + '18',
                  borderColor: colors.primary + '55',
                },
              ]}
              onPress={() => setEditorTab('edit')}
              activeOpacity={0.85}
            >
              <Ionicons
                name="create-outline"
                size={14}
                color={editorTab === 'edit' ? colors.primary : colors.textMuted}
              />
              <Text
                style={[
                  styles.tabText,
                  {
                    color: editorTab === 'edit' ? colors.primary : colors.textMuted,
                  },
                ]}
              >
                Edit
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.tab,
                editorTab === 'preview' && {
                  backgroundColor: colors.accent + '18',
                  borderColor: colors.accent + '55',
                },
              ]}
              onPress={() => setEditorTab('preview')}
              activeOpacity={0.85}
            >
              <Ionicons
                name="eye-outline"
                size={14}
                color={editorTab === 'preview' ? colors.accent : colors.textMuted}
              />
              <Text
                style={[
                  styles.tabText,
                  {
                    color:
                      editorTab === 'preview' ? colors.accent : colors.textMuted,
                  },
                ]}
              >
                Preview
              </Text>
            </TouchableOpacity>
          </View>

          {editorTab === 'edit' ? (
            <ScrollView
              style={styles.editorPane}
              keyboardShouldPersistTaps="handled"
            >
              <TextInput
                style={styles.editorContentInput}
                value={editorBody}
                onChangeText={setEditorBody}
                placeholder={[
                  '# Heading',
                  '',
                  'Write **markdown** here.',
                  '',
                  '- bullet',
                  '- list',
                  '',
                  '```js',
                  'console.log("code blocks too");',
                  '```',
                ].join('\n')}
                placeholderTextColor={colors.textMuted}
                multiline
                textAlignVertical="top"
                autoCapitalize="sentences"
              />
            </ScrollView>
          ) : (
            <ScrollView
              style={styles.editorPane}
              contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 80 }}
            >
              {previewBody.trim() ? (
                <Markdown style={markdownStyles}>{previewBody}</Markdown>
              ) : (
                <View style={styles.previewEmpty}>
                  <Ionicons
                    name="eye-off-outline"
                    size={32}
                    color={colors.textMuted}
                  />
                  <Text style={styles.emptyText}>
                    Nothing to preview yet — switch to Edit and start writing
                  </Text>
                </View>
              )}
            </ScrollView>
          )}

          {editingNote ? (
            <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
              <Ionicons name="trash-outline" size={16} color={colors.error} />
              <Text style={styles.deleteBtnText}>Delete Note</Text>
            </TouchableOpacity>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>

      <HandwritingEditor
        visible={canvasVisible}
        note={canvasNote}
        initialDoc={canvasDoc}
        initialName={canvasName}
        colors={colors}
        sendReq={sendReq}
        onClose={() => setCanvasVisible(false)}
        onSaved={loadNotes}
      />
    </Animated.View>
  );
}

function makeStyles(colors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: 'transparent' },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 40,
      gap: 12,
    },
    emptyText: {
      ...TYPOGRAPHY.body,
      color: colors.textMuted,
      textAlign: 'center',
    },

    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: SPACING.md,
      marginTop: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.error + '14',
      borderWidth: 1,
      borderColor: colors.error + '33',
    },
    errorText: { color: colors.error, ...TYPOGRAPHY.small, flex: 1 },

    headerSlab: {
      overflow: 'hidden',
      backgroundColor: 'transparent',
    },
    headerSlabBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    searchRow: {
      flexDirection: 'row',
      gap: SPACING.sm,
      paddingHorizontal: SPACING.md,
      paddingTop: SPACING.sm,
      paddingBottom: SPACING.sm,
      alignItems: 'center',
    },
    searchInputWrapper: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: withAlpha(colors.surfaceTint || '#000', 0.32),
      borderRadius: 14,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.22),
    },
    searchInput: {
      flex: 1,
      color: colors.text,
      ...TYPOGRAPHY.body,
      paddingVertical: Platform.OS === 'ios' ? 4 : 0,
    },
    createBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.4,
      shadowRadius: 10,
      elevation: 6,
    },

    noteCard: {
      borderRadius: 16,
      backgroundColor: withAlpha(colors.surfaceTint || colors.surface, 0.28),
      borderWidth: 1,
      borderColor: withAlpha(colors.primary, 0.18),
      overflow: 'hidden',
    },
    noteCardBorder: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: 3,
      opacity: 0.85,
    },
    noteCardContent: { padding: SPACING.md, paddingLeft: SPACING.md + 4 },
    noteCardHeaderRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    noteCardTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    noteCardTitle: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      fontWeight: '600',
      flex: 1,
    },
    noteCardDate: {
      ...TYPOGRAPHY.caption,
      color: colors.textMuted,
      marginLeft: 8,
    },
    noteCardDesc: {
      ...TYPOGRAPHY.small,
      color: colors.textSecondary,
      marginTop: 4,
    },
    noteCardPreview: {
      ...TYPOGRAPHY.small,
      color: colors.textMuted,
      marginTop: 4,
      opacity: 0.85,
    },
    noteCardFooter: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 8,
      gap: 6,
      flexWrap: 'wrap',
    },
    noteBadge: {
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: 1,
    },
    noteBadgeText: { ...TYPOGRAPHY.caption, fontWeight: '600' },

    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: SPACING.xl,
      paddingTop: 60,
    },
    emptyInner: { alignItems: 'center', gap: 10 },
    emptyTitle: {
      ...TYPOGRAPHY.heading,
      color: colors.text,
      marginTop: 4,
    },
    emptySubtitle: {
      ...TYPOGRAPHY.body,
      color: colors.textMuted,
      textAlign: 'center',
      maxWidth: 280,
    },
    emptyCta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 14,
      borderWidth: 1,
      marginTop: 10,
    },
    emptyCtaText: { ...TYPOGRAPHY.body, fontWeight: '700' },

    editorContainer: { flex: 1, backgroundColor: colors.background },
    editorHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: SPACING.lg,
      paddingVertical: SPACING.md,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.primary + '1a',
      paddingTop: Platform.OS === 'ios' ? 50 : SPACING.md,
    },
    editorCancel: { color: colors.textSecondary, ...TYPOGRAPHY.body },
    editorTitle: {
      ...TYPOGRAPHY.heading,
      color: colors.text,
      fontSize: 16,
      flex: 1,
      textAlign: 'center',
      marginHorizontal: SPACING.md,
    },
    editorSave: {
      color: colors.primary,
      ...TYPOGRAPHY.body,
      fontWeight: '700',
    },

    editorMeta: {
      paddingHorizontal: SPACING.lg,
      paddingTop: SPACING.md,
      gap: SPACING.sm,
    },
    editorNameInput: {
      fontFamily: FONT_FAMILY.bold,
      fontSize: 22,
      lineHeight: 28,
      color: colors.text,
      paddingVertical: 4,
    },
    metaRow: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    editorMetaInput: {
      flex: 1,
      ...TYPOGRAPHY.small,
      color: colors.text,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingHorizontal: SPACING.md,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: colors.primary + '1a',
    },
    pinToggle: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },

    tabBar: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: SPACING.lg,
      paddingTop: SPACING.md,
      paddingBottom: SPACING.sm,
    },
    tab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 9,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.primary + '14',
      backgroundColor: colors.surface,
    },
    tabText: { ...TYPOGRAPHY.small, fontWeight: '700', letterSpacing: 0.5 },

    editorPane: { flex: 1 },
    editorContentInput: {
      ...TYPOGRAPHY.body,
      color: colors.text,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: SPACING.md,
      margin: SPACING.lg,
      marginTop: 0,
      minHeight: 360,
      borderWidth: 1,
      borderColor: colors.primary + '1a',
      lineHeight: 22,
      fontFamily: FONT_FAMILY.mono,
    },
    previewEmpty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingTop: 40,
    },

    deleteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: SPACING.lg,
      borderTopWidth: 1,
      borderTopColor: colors.primary + '14',
    },
    deleteBtnText: {
      color: colors.error,
      ...TYPOGRAPHY.body,
      fontWeight: '600',
    },
  });
}

function makeMarkdownStyles(colors) {
  return {
    body: {
      color: colors.text,
      fontFamily: FONT_FAMILY.regular,
      fontSize: 15,
      lineHeight: 23,
    },
    heading1: {
      color: colors.text,
      fontFamily: FONT_FAMILY.display || FONT_FAMILY.bold,
      fontSize: 28,
      lineHeight: 34,
      marginTop: 12,
      marginBottom: 8,
      letterSpacing: -0.5,
    },
    heading2: {
      color: colors.text,
      fontFamily: FONT_FAMILY.bold,
      fontSize: 22,
      lineHeight: 28,
      marginTop: 16,
      marginBottom: 6,
    },
    heading3: {
      color: colors.text,
      fontFamily: FONT_FAMILY.bold,
      fontSize: 18,
      lineHeight: 24,
      marginTop: 12,
      marginBottom: 4,
    },
    heading4: {
      color: colors.text,
      fontFamily: FONT_FAMILY.semiBold,
      fontSize: 16,
      lineHeight: 22,
      marginTop: 10,
      marginBottom: 4,
    },
    strong: { fontFamily: FONT_FAMILY.bold, color: colors.text },
    em: { fontStyle: 'italic', color: colors.text },
    link: { color: colors.primary, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: colors.primary + '0e',
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
      paddingLeft: 12,
      paddingVertical: 6,
      marginVertical: 6,
      borderRadius: 6,
    },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    list_item: { marginVertical: 2, color: colors.text },
    bullet_list_icon: { color: colors.primary, marginRight: 8 },
    ordered_list_icon: { color: colors.primary, marginRight: 8 },
    code_inline: {
      backgroundColor: colors.primary + '14',
      color: colors.primary,
      fontFamily: FONT_FAMILY.mono,
      fontSize: 13,
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      backgroundColor: (colors.surfaceTint || colors.surface) + 'cc',
      color: colors.text,
      fontFamily: FONT_FAMILY.mono,
      fontSize: 12,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.primary + '22',
      marginVertical: 8,
    },
    fence: {
      backgroundColor: (colors.surfaceTint || colors.surface) + 'cc',
      color: colors.text,
      fontFamily: FONT_FAMILY.mono,
      fontSize: 12,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.primary + '22',
      marginVertical: 8,
    },
    hr: {
      backgroundColor: colors.primary + '22',
      height: 1,
      marginVertical: 14,
    },
    table: {
      borderWidth: 1,
      borderColor: colors.primary + '22',
      borderRadius: 8,
      marginVertical: 8,
    },
    thead: { backgroundColor: colors.primary + '10' },
    th: {
      padding: 8,
      color: colors.text,
      fontFamily: FONT_FAMILY.semiBold,
    },
    tr: { borderBottomWidth: 1, borderBottomColor: colors.primary + '14' },
    td: { padding: 8, color: colors.text },
    paragraph: { marginTop: 0, marginBottom: 10 },
    image: { borderRadius: 10, marginVertical: 8 },
  };
}

export default NotesScreen;
