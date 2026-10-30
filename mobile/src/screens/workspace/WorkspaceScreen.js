/**
 * WorkspaceScreen — native Workspace (web /workspace): per-project files,
 * diffs, live preview and the coder agent chat, on the same gateway RPCs.
 *
 * Layout
 *   portrait   header · project bar · tabs [Chat | Preview | Files | Code | Diff | Git]
 *   landscape  header · project bar · Chat pane (left) + tabbed pane (right),
 *              the web's two-column studio
 *
 * Web section → native
 *   picker popover           PickerSheet (search / Recent / All / Add)
 *   framework + branch       chips in the project bar; status pill starts the server
 *   device toggle / route / reload / open   Preview toolbar
 *   overflow menu            MoreSheet (every web item + project modes + URL override)
 *   workspace agent chat     WorkspaceChat (same session, checkpoints, suggestions)
 *   live preview / Select    WorkspacePreview (+ element inspector on dev previews)
 *   workbench files/code/diff/components   Files, Code, Diff tabs + ComponentsSheet
 *   terminal drawer          LogsSheet (dev logs + Claude terminal → Terminals)
 *   versions drawer          VersionsSheet
 *   templates / bind / new workspace modals   sheets
 *   (native extra) Git tab — git.status + working-tree / staged patch
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AppHeader,
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  IconButton,
  MONO_FAMILY,
  RADIUS,
  SPACE,
  SegmentedControl,
  Skeleton,
  SkeletonRow,
  Tabs,
  toneColor,
  useUIKit,
} from '../../ui-kit';
import { useWorkspace } from './useWorkspace';
import {
  collapseContext,
  diffLines,
  diffTotals,
  fileIcon,
  fixServerPrompt,
  flattenTree,
  frameworkLabel,
  gitStatusMeta,
  isBinaryLike,
  isHtmlFile,
  parseUnifiedDiff,
  relativeToRoot,
  runtimeLabel,
  runtimeStatusOf,
  runtimeTone,
  selectionContext,
  shortPath,
  summarizeGitStatus,
  treeStats,
} from './workspace-model';
import { CodeEditor, CodeViewer, DiffView } from './WorkspaceCode';
import { WorkspaceChat } from './WorkspaceChat';
import { WorkspacePreview, openExternal, usePreviewUrl } from './WorkspacePreview';
import {
  BindSheet,
  ComponentsSheet,
  LinkedSheet,
  LogsSheet,
  ModelSheet,
  MoreSheet,
  NewWorkspaceSheet,
  PickerSheet,
  TemplatesSheet,
  VersionsSheet,
  WorkflowSheet,
} from './WorkspaceSheets';

const ALL_TABS = [
  { key: 'chat', label: 'Chat', icon: 'sparkles-outline' },
  { key: 'preview', label: 'Preview', icon: 'desktop-outline' },
  { key: 'files', label: 'Files', icon: 'folder-outline' },
  { key: 'code', label: 'Code', icon: 'code-slash-outline' },
  { key: 'diff', label: 'Diff', icon: 'git-compare-outline' },
  { key: 'git', label: 'Git', icon: 'git-branch-outline' },
];

// ── Project bar ─────────────────────────────────────────────────────

function ProjectBar({ ws, onPick, compact = false }) {
  const { colors, type, alpha } = useUIKit();
  const status = runtimeStatusOf(ws.server, ws.runtimeLoading);
  const tone = toneColor(runtimeTone(status), colors);
  const sel = ws.selected;
  return (
    <View style={[styles.projectBar, compact && styles.projectBarCompact, { borderBottomColor: colors.borderSubtle }]}>
      <Pressable
        onPress={onPick}
        accessibilityRole="button"
        accessibilityLabel="Switch workspace"
        testID="workspace-picker"
        style={({ pressed }) => [styles.pickBtn, compact && { flex: 1, minHeight: 44 }, { borderColor: colors.border, backgroundColor: pressed ? alpha(colors.primary, 0.1) : alpha(colors.text, 0.04) }]}
      >
        <Ionicons name="folder-open-outline" size={18} color={colors.primary} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{sel ? sel.name : ws.workspaces.length ? 'Pick a workspace' : 'No workspaces — add one'}</Text>
          {sel ? <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textMuted }} numberOfLines={1}>{shortPath(sel.path, 60)}</Text> : null}
        </View>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      {sel ? (
        <View style={[styles.metaRow, compact && { flexShrink: 1, maxWidth: '55%' }]}>
          <Pressable
            onPress={() => { if (status !== 'ready' && status !== 'detecting') ws.startServer(Boolean(ws.detection?.missingDependencies)); }}
            accessibilityRole="button"
            accessibilityLabel={`Development server ${status}`}
            testID="workspace-server-pill"
            style={[styles.statusPill, { borderColor: alpha(tone, 0.55), backgroundColor: alpha(colors.text, 0.06) }]}
          >
            <View style={[styles.dot, { backgroundColor: tone }]} />
            <Text style={[type.caption, { color: tone }]}>{runtimeLabel(status)}</Text>
          </Pressable>
          <Chip label={frameworkLabel(ws.detection, ws.projectMode)} tone="primary" size="sm" />
          {ws.detection?.gitBranch ? <View style={{ flexShrink: 1, minWidth: 0 }}><Chip label={ws.detection.gitBranch} icon="git-branch-outline" size="sm" style={{ maxWidth: '100%' }} textStyle={{ flexShrink: 1 }} /></View> : null}
        </View>
      ) : null}
    </View>
  );
}

// ── Preview tab ─────────────────────────────────────────────────────

function PreviewPane({ ws, onFix, onEditWithAI, onOpenCode }) {
  const { colors, type, alpha } = useUIKit();
  const [route, setRoute] = useState(ws.previewRoute);
  const [inspector, setInspector] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const { url } = usePreviewUrl(ws);
  useEffect(() => setRoute(ws.previewRoute), [ws.previewRoute]);
  const live = ws.projectMode === 'web' || ws.projectMode === 'app';
  return (
    <View style={styles.flex} testID="workspace-preview">
      {live ? (
        <View style={[styles.toolbar, { borderBottomColor: colors.borderSubtle }]}>
          <SegmentedControl
            options={[{ key: 'desktop', label: '', icon: 'desktop-outline' }, { key: 'tablet', label: '', icon: 'tablet-portrait-outline' }, { key: 'mobile', label: '', icon: 'phone-portrait-outline' }]}
            value={ws.previewDevice}
            onChange={ws.setPreviewDevice}
            style={{ width: 132 }}
          />
          <TextInput
            value={route}
            onChangeText={setRoute}
            onSubmitEditing={() => { ws.setPreviewRoute(route); ws.reloadPreview(); }}
            placeholder="/"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Preview route"
            style={[styles.routeInput, { color: colors.text, borderColor: colors.border, backgroundColor: alpha(colors.text, 0.04) }]}
          />
          <IconButton icon="refresh" onPress={ws.reloadPreview} accessibilityLabel="Reload preview" />
          <IconButton icon="locate-outline" tone={inspector ? colors.primary : undefined} variant={inspector ? 'outline' : 'ghost'} onPress={() => setInspector((v) => !v)} accessibilityLabel={inspector ? 'Stop selecting' : 'Select an element'} />
          <IconButton icon="open-outline" disabled={!url} onPress={() => openExternal(url)} accessibilityLabel="Open preview in browser" />
        </View>
      ) : null}
      {ws.selectedElement ? (
        <View style={[styles.selBar, { borderColor: colors.border, backgroundColor: alpha(colors.primary, 0.06) }]} testID="workspace-selection-actions">
          <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.text, flex: 1 }} numberOfLines={1}>{ws.selectedElement.tag} · {ws.selectedElement.selector}</Text>
          <Button title="Edit with AI" size="sm" onPress={onEditWithAI} />
          <Button title="Code" size="sm" variant="outline" onPress={onOpenCode} />
        </View>
      ) : null}
      <View style={styles.flex} onLayout={(e) => setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
        {box.width > 0 ? (
          <WorkspacePreview
            ws={ws}
            width={box.width}
            height={box.height}
            inspector={inspector}
            onSelectElement={(d) => {
              ws.setSelectedElement({ selector: String(d.selector || ''), tag: String(d.tag || ''), text: String(d.text || ''), html: String(d.html || ''), source: typeof d.source === 'string' ? d.source : null, screenshotPath: null });
              setInspector(false);
            }}
            onFixWithAgent={onFix}
            onEditSource={onOpenCode}
          />
        ) : null}
      </View>
    </View>
  );
}

// ── Files tab ───────────────────────────────────────────────────────

function FilesPane({ ws, onOpenFile }) {
  const { colors, type, alpha } = useUIKit();
  const rows = useMemo(() => flattenTree(ws.tree, ws.expanded), [ws.tree, ws.expanded]);
  const stats = useMemo(() => treeStats(ws.tree), [ws.tree]);
  const dirty = new Set(ws.tabs.filter((t) => t.dirty).map((t) => t.path));
  return (
    <View style={styles.flex} testID="workspace-files">
      <View style={[styles.toolbar, { borderBottomColor: colors.borderSubtle }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>{ws.selected ? shortPath(ws.selected.path, 48) : 'Pick a workspace'}</Text>
          {ws.tree ? <Text style={[type.caption, { color: colors.textMuted }]}>{stats.files} files · {stats.folders} folders</Text> : null}
        </View>
        <IconButton icon="contract-outline" onPress={ws.collapseAll} accessibilityLabel="Collapse all folders" />
        <IconButton icon="refresh" onPress={() => ws.loadTree()} accessibilityLabel="Refresh file tree" />
      </View>
      {ws.treeLoading && !ws.tree ? (
        <View style={{ padding: SPACE.md, gap: SPACE.sm }}>{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={36} />)}</View>
      ) : ws.treeError && !ws.tree ? (
        <EmptyState tone="danger" icon="alert-circle-outline" title="Couldn't read this folder" message={ws.treeError} actionLabel="Retry" onAction={() => ws.loadTree()} />
      ) : rows.length === 0 ? (
        <EmptyState icon="folder-open-outline" title={ws.selected ? 'Empty folder' : 'Pick a workspace'} message={ws.selected ? 'Scaffold a template from the actions menu to get started.' : undefined} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.key}
          refreshControl={<RefreshControl refreshing={ws.treeLoading} onRefresh={() => ws.loadTree()} tintColor={colors.primary} />}
          initialNumToRender={40}
          renderItem={({ item }) => {
            const active = ws.activePath === item.path;
            return (
              <Pressable
                onPress={() => (item.isDirectory ? ws.toggleExpand(item.path) : onOpenFile(item.path))}
                accessibilityRole="button"
                accessibilityLabel={`${item.isDirectory ? 'Folder' : 'File'} ${item.name}`}
                style={({ pressed }) => [
                  styles.treeRow,
                  { paddingLeft: SPACE.md + item.depth * 14, backgroundColor: active ? alpha(colors.primary, 0.1) : pressed ? alpha(colors.text, 0.05) : 'transparent' },
                ]}
              >
                {item.isDirectory ? <Ionicons name={item.expanded ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} /> : <View style={{ width: 14 }} />}
                <Ionicons name={fileIcon(item.name, item.isDirectory, item.expanded)} size={16} color={item.isDirectory ? colors.primary : colors.textSecondary} />
                <Text style={[type.small, { color: active ? colors.primary : colors.text, flex: 1 }]} numberOfLines={1}>{item.name}</Text>
                {dirty.has(item.path) ? <View style={[styles.dot, { backgroundColor: colors.warning }]} /> : null}
                {item.isDirectory ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>{item.childCount}</Text> : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

// ── Open-file tabs strip ────────────────────────────────────────────

function TabStrip({ ws }) {
  const { colors, type, alpha } = useUIKit();
  if (!ws.tabs.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.tabStrip}>
      {ws.tabs.map((t) => {
        const on = t.path === ws.activePath;
        return (
          <View key={t.path} style={[styles.fileTab, { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? alpha(colors.primary, 0.1) : alpha(colors.text, 0.03) }]}>
            <Pressable onPress={() => ws.activateTab(t.path)} style={styles.fileTabMain} accessibilityRole="button" accessibilityLabel={`Show ${t.name}`}>
              {t.dirty ? <View style={[styles.dot, { backgroundColor: colors.warning }]} /> : null}
              <Text style={[type.caption, { color: on ? colors.primary : colors.textSecondary, maxWidth: 140 }]} numberOfLines={1}>{t.name}</Text>
            </Pressable>
            <Pressable onPress={() => ws.closeTab(t.path)} style={styles.fileTabClose} accessibilityRole="button" accessibilityLabel={`Close ${t.name}`}>
              <Ionicons name="close" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

// ── Code tab ────────────────────────────────────────────────────────

function CodePane({ ws, onComponents, onPreview }) {
  const { colors, type } = useUIKit();
  const [editing, setEditing] = useState(false);
  const tab = ws.activeTab;
  const anyDirty = ws.tabs.some((t) => t.dirty);
  return (
    <View style={styles.flex} testID="workspace-code">
      <TabStrip ws={ws} />
      {!tab ? (
        <EmptyState icon="code-slash-outline" title="Select a file" message="Browse in Files, then tap a file to open it here." />
      ) : (
        <>
          <View style={[styles.toolbar, { borderBottomColor: colors.borderSubtle }]}>
            <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textMuted, flex: 1 }} numberOfLines={1}>
              {ws.selected ? relativeToRoot(tab.path, ws.selected.path) ?? tab.path : tab.path}
            </Text>
            <IconButton icon={editing ? 'eye-outline' : 'create-outline'} onPress={() => setEditing((v) => !v)} accessibilityLabel={editing ? 'View with highlighting' : 'Edit file'} disabled={isBinaryLike(tab.name)} />
            {isHtmlFile(tab.name) ? <IconButton icon="play-outline" onPress={onPreview} accessibilityLabel="Preview this file" /> : null}
            <IconButton icon="cube-outline" onPress={onComponents} accessibilityLabel="Insert a component" />
            <IconButton icon="reload" onPress={() => ws.reloadTab(tab.path)} accessibilityLabel="Reload from disk" />
          </View>
          {tab.dirty || anyDirty ? (
            <View style={[styles.saveBar, { borderBottomColor: colors.borderSubtle }]}>
              <Text style={[type.caption, { color: colors.warning, flex: 1 }]}>{tab.dirty ? 'Unsaved changes' : 'Other files have unsaved changes'}</Text>
              {tab.dirty ? <Button title="Save" size="sm" icon="save-outline" onPress={() => ws.saveTab(tab.path)} /> : null}
              <Button title="Save all" size="sm" variant="outline" disabled={!anyDirty} onPress={ws.saveAll} />
            </View>
          ) : null}
          {tab.error ? <Text style={[type.small, { color: colors.error, padding: SPACE.md }]}>{tab.error}</Text> : null}
          {tab.loading ? (
            <View style={{ padding: SPACE.md, gap: SPACE.sm }}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} height={14} width={`${90 - i * 12}%`} />)}</View>
          ) : isBinaryLike(tab.name) ? (
            <EmptyState icon="image-outline" title="Binary file" message="This file type isn't previewable as text." />
          ) : editing ? (
            <View style={[styles.flex, { padding: SPACE.sm }]}>
              <CodeEditor value={tab.content} onChangeText={(v) => ws.updateTabContent(tab.path, v)} testID="workspace-editor" />
            </View>
          ) : (
            <CodeViewer name={tab.name} content={tab.content} testID="workspace-code-view" />
          )}
        </>
      )}
    </View>
  );
}

// ── Diff tab (unsaved edits, web renderDiff) ────────────────────────

function DiffPane({ ws, onGoGit }) {
  const { colors, type } = useUIKit();
  const [full, setFull] = useState(false);
  const dirtyTabs = ws.tabs.filter((t) => t.dirty);
  const tab = ws.activeTab?.dirty ? ws.activeTab : dirtyTabs[0] || ws.activeTab;
  const lines = useMemo(() => (tab ? diffLines(tab.original, tab.content) : []), [tab?.original, tab?.content]); // eslint-disable-line react-hooks/exhaustive-deps
  const totals = diffTotals(lines);
  const rows = useMemo(() => (full ? lines : collapseContext(lines, 3)), [lines, full]);
  return (
    <View style={styles.flex} testID="workspace-diff">
      <TabStrip ws={ws} />
      {!tab ? (
        <EmptyState icon="git-compare-outline" title="No file open" message="Open a file and edit it to see your unsaved changes here. Committed-vs-working changes live in Git." actionLabel="Open Git changes" onAction={onGoGit} />
      ) : (
        <>
          <View style={[styles.toolbar, { borderBottomColor: colors.borderSubtle }]}>
            <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textMuted, flex: 1 }} numberOfLines={1}>{tab.name}</Text>
            <Text style={[type.mono, { color: colors.success }]}>+{totals.add}</Text>
            <Text style={[type.mono, { color: colors.error }]}>-{totals.remove}</Text>
            <IconButton icon={full ? 'contract-outline' : 'expand-outline'} onPress={() => setFull((v) => !v)} accessibilityLabel={full ? 'Collapse unchanged lines' : 'Show the whole file'} />
            {tab.dirty ? <Button title="Save" size="sm" onPress={() => ws.saveTab(tab.path)} /> : null}
          </View>
          {totals.add + totals.remove === 0 ? (
            <EmptyState icon="checkmark-done-outline" title="No unsaved changes" message={`${tab.name} matches the file on disk. Edit it in Code, or see repository changes in Git.`} actionLabel="Open Git changes" onAction={onGoGit} />
          ) : (
            <DiffView rows={rows} testID="workspace-diff-view" />
          )}
        </>
      )}
    </View>
  );
}

// ── Git tab (native extra: git.status + git.diff) ───────────────────

function GitPane({ ws }) {
  const { colors, type, alpha } = useUIKit();
  const [sheet, setSheet] = useState(null); // 'all' | path
  const st = ws.git.status;
  const parsed = useMemo(() => parseUnifiedDiff(ws.git.patch), [ws.git.patch]);
  const fileRows = useMemo(() => (ws.fileDiff?.patch ? parseUnifiedDiff(ws.fileDiff.patch).rows : []), [ws.fileDiff?.patch]);
  const openFileDiff = (path) => {
    setSheet(path);
    ws.loadFileDiff(path, { staged: ws.git.staged });
  };
  return (
    <View style={styles.flex} testID="workspace-git">
      <ScrollView refreshControl={<RefreshControl refreshing={ws.git.loading} onRefresh={() => ws.loadGit(undefined, { staged: ws.git.staged })} tintColor={colors.primary} />} contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}>
        {ws.git.loading && !st ? (
          <><Skeleton height={72} /><SkeletonRow /><SkeletonRow /></>
        ) : ws.git.error ? (
          <EmptyState compact tone="danger" icon="git-branch-outline" title="Not a git repository" message={ws.git.error} actionLabel="Retry" onAction={() => ws.loadGit()} />
        ) : st ? (
          <>
            <View style={[styles.gitCard, { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.03) }]}>
              <View style={styles.rowCenter}>
                <Ionicons name="git-branch-outline" size={18} color={colors.primary} />
                <Text style={[type.mono, { color: colors.text, flex: 1 }]} numberOfLines={1}>{st.branch}</Text>
                {st.ahead ? <Chip label={`${st.ahead} ahead`} size="sm" tone="info" /> : null}
                {st.behind ? <Chip label={`${st.behind} behind`} size="sm" tone="warning" /> : null}
              </View>
              <Text style={[type.small, { color: st.clean ? colors.success : colors.textSecondary }]}>{summarizeGitStatus(st)}</Text>
              {st.remote ? <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textMuted }} numberOfLines={1}>{st.remote}</Text> : null}
              <View style={[styles.rowCenter, { marginTop: SPACE.xs }]}>
                <SegmentedControl options={[{ key: 'work', label: 'Working tree' }, { key: 'staged', label: 'Staged' }]} value={ws.git.staged ? 'staged' : 'work'} onChange={(k) => ws.loadGit(undefined, { staged: k === 'staged' })} style={{ flex: 1 }} />
              </View>
            </View>
            {parsed.files.length ? (
              <Pressable onPress={() => setSheet('all')} accessibilityRole="button" accessibilityLabel="Show the full diff" style={[styles.allDiff, { borderColor: colors.border }]}>
                <Ionicons name="git-compare-outline" size={16} color={colors.primary} />
                <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>{ws.git.staged ? 'Staged' : 'Unstaged'} diff · {parsed.files.length} file{parsed.files.length === 1 ? '' : 's'}</Text>
                <Text style={[type.mono, { color: colors.success }]}>+{parsed.files.reduce((s, f) => s + f.add, 0)}</Text>
                <Text style={[type.mono, { color: colors.error }]}>-{parsed.files.reduce((s, f) => s + f.remove, 0)}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>
            ) : null}
            {(st.files || []).length === 0 ? (
              <EmptyState compact icon="checkmark-circle-outline" title="Working tree clean" message="Nothing to commit." />
            ) : (
              <View style={[styles.gitList, { borderColor: colors.borderSubtle }]}>
                {(st.files || []).map((f) => {
                  const meta = gitStatusMeta(f.status);
                  const c = toneColor(meta.tone, colors);
                  return (
                    <Pressable key={`${f.status}:${f.path}`} onPress={() => openFileDiff(f.path)} accessibilityRole="button" accessibilityLabel={`${meta.label} ${f.path}`} style={({ pressed }) => [styles.gitRow, { borderBottomColor: colors.borderSubtle, backgroundColor: pressed ? alpha(colors.text, 0.05) : 'transparent' }]}>
                      <View style={[styles.gitBadge, { borderColor: alpha(c, 0.6) }]}><Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, fontWeight: '700', color: c }}>{meta.short}</Text></View>
                      <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.text, flex: 1 }} numberOfLines={1}>{f.path}</Text>
                      {meta.staged ? <Chip label="staged" size="sm" tone="success" /> : null}
                    </Pressable>
                  );
                })}
                {st.files.length >= 50 ? <Text style={[type.caption, { color: colors.textMuted, padding: SPACE.md }]}>Showing the first 50 changed paths.</Text> : null}
              </View>
            )}
          </>
        ) : (
          <EmptyState compact icon="git-branch-outline" title="No git data yet" actionLabel="Load" onAction={() => ws.loadGit()} />
        )}
      </ScrollView>
      <BottomSheet visible={Boolean(sheet)} onClose={() => { setSheet(null); ws.setFileDiff(null); }} title={sheet === 'all' ? 'All changes' : shortPath(sheet || '', 40)} subtitle={ws.git.staged ? 'Staged' : 'Working tree'} maxHeightRatio={0.92} scroll={false}>
        <View style={{ height: 520, maxHeight: '100%' }}>
          {sheet === 'all' ? (
            <DiffView rows={parsed.rows} testID="workspace-git-diff" />
          ) : ws.fileDiff?.loading ? (
            <Skeleton height={120} />
          ) : fileRows.length ? (
            <DiffView rows={fileRows} testID="workspace-git-file-diff" />
          ) : (
            <Text style={[type.small, { color: ws.fileDiff?.error ? colors.error : colors.textMuted, padding: SPACE.md }]}>
              {ws.fileDiff?.error || 'No textual diff — the file is untracked, binary, or only staged/unstaged on the other side.'}
            </Text>
          )}
        </View>
      </BottomSheet>
    </View>
  );
}

// ── Screen ──────────────────────────────────────────────────────────

export function WorkspaceScreen({ navigation, gateway }) {
  const { colors, type, alpha } = useUIKit();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height && width >= 700;
  const ws = useWorkspace(gateway);
  const [tab, setTab] = useState('chat');
  const [sheet, setSheet] = useState(null);
  const [bindRequest, setBindRequest] = useState(null);
  const [draft, setDraft] = useState({ text: '', key: 0 });
  const { url: previewUrl, path: previewPath, origin } = usePreviewUrl(ws);

  const tabs = landscape ? ALL_TABS.filter((t) => t.key !== 'chat') : ALL_TABS;
  const activeTabKey = landscape && tab === 'chat' ? 'preview' : tab;
  const dirtyCount = ws.tabs.filter((t) => t.dirty).length;
  const gitCount = ws.git.status?.files?.length || 0;
  const tabItems = tabs.map((t) => ({ ...t, count: t.key === 'diff' ? dirtyCount || undefined : t.key === 'git' ? gitCount || undefined : t.key === 'code' ? ws.tabs.length || undefined : undefined }));

  const toChat = useCallback((text) => {
    setDraft((d) => ({ text, key: d.key + 1 }));
    if (!landscape) setTab('chat');
  }, [landscape]);

  const openFile = useCallback((path) => {
    ws.openFile(path);
    setTab('code');
  }, [ws]);

  // Notices auto-clear.
  useEffect(() => {
    if (!ws.notice) return undefined;
    const t = setTimeout(ws.clearNotice, 3200);
    return () => clearTimeout(t);
  }, [ws.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const actions = {
    addWorkspace: () => setSheet('new'),
    templates: () => setSheet('templates'),
    components: () => setSheet('components'),
    versions: () => setSheet('versions'),
    logs: () => setSheet('logs'),
    workflow: () => setSheet('workflow'),
    model: () => setSheet('model'),
    linked: () => setSheet('linked'),
    openExternal: () => openExternal(previewUrl),
    visualVerify: () => {
      if (!previewPath) return;
      const port = Number((/:(\d+)$/.exec(origin || '') || [])[1]) || (String(origin).startsWith('https') ? 443 : 80);
      ws.runVisualVerify({ baseUrl: origin, gatewayPort: port, route: previewPath.split('?')[0] });
      ws.flash('Visual verify started — results appear here when done', 'info');
    },
  };

  useEffect(() => {
    if (ws.visualVerify.running) return;
    if (ws.visualVerify.error) ws.flash(`Visual verify: ${ws.visualVerify.error}`, 'danger');
    else if (ws.visualVerify.screenshots.length) ws.flash(`Visual verify captured ${ws.visualVerify.screenshots.length} screenshots`, 'success');
  }, [ws.visualVerify.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderTab = (key) => {
    switch (key) {
      case 'chat':
        return <WorkspaceChat gateway={gateway} ws={ws} draft={draft} compactHeader={landscape} onOpenModel={() => setSheet('model')} onShowVersions={() => setSheet('versions')} />;
      case 'preview':
        return (
          <PreviewPane
            ws={ws}
            onFix={() => toChat(fixServerPrompt(ws.server, ws.runtimeLogs))}
            onEditWithAI={() => { toChat(`Update this selected element.\n\n${selectionContext(ws.selectedElement).trim()}`); }}
            onOpenCode={() => setTab('code')}
          />
        );
      case 'files':
        return <FilesPane ws={ws} onOpenFile={openFile} />;
      case 'code':
        return <CodePane ws={ws} onComponents={() => setSheet('components')} onPreview={() => setTab('preview')} />;
      case 'diff':
        return <DiffPane ws={ws} onGoGit={() => setTab('git')} />;
      case 'git':
        return <GitPane ws={ws} />;
      default:
        return null;
    }
  };

  let body;
  if (ws.loading && ws.workspaces.length === 0) {
    body = <View style={{ padding: SPACE.lg, gap: SPACE.md }}><Skeleton height={56} /><Skeleton height={40} /><SkeletonRow /><SkeletonRow /><SkeletonRow /></View>;
  } else if (ws.error && ws.workspaces.length === 0) {
    body = <EmptyState tone="danger" icon="cloud-offline-outline" title="Couldn't load workspaces" message={ws.error} actionLabel="Retry" onAction={() => ws.loadWorkspaces()} />;
  } else if (ws.workspaces.length === 0) {
    body = (
      <EmptyState
        icon="folder-outline"
        title="No workspaces yet"
        message="A workspace is a local directory bound to a project. Its files become editable here, the coder agent runs scoped to its path, and matching kanban tasks show as linked context."
        actionLabel="Add your first workspace"
        onAction={() => setSheet('new')}
      />
    );
  } else {
    const tabsBar = (
      <View style={[styles.tabsBar, { borderBottomColor: colors.borderSubtle }]}>
        <Tabs tabs={tabItems} active={activeTabKey} onSelect={setTab} testID="workspace-tabs" />
      </View>
    );
    body = (
      <>
        <ProjectBar ws={ws} onPick={() => setSheet('picker')} compact={landscape} />
        {landscape ? (
          <View style={[styles.flex, styles.row]}>
            <View style={[styles.leftPane, { width: Math.min(420, Math.round(width * 0.4)), borderRightColor: colors.borderSubtle }]}>{renderTab('chat')}</View>
            <View style={styles.flex}>
              {tabsBar}
              <View style={styles.flex}>{renderTab(activeTabKey)}</View>
            </View>
          </View>
        ) : (
          <>
            {tabsBar}
            <View style={styles.flex}>{renderTab(activeTabKey)}</View>
          </>
        )}
      </>
    );
  }

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]} testID="workspace-screen">
      <AppHeader
        variant="nav"
        title="Workspace"
        leftIcon="chevron-back"
        leftLabel="Back"
        onLeftPress={() => navigation?.goBack?.()}
        rightComponent={
          <View style={styles.headerRight}>
            <IconButton icon="refresh" onPress={ws.refreshAll} accessibilityLabel="Refresh workspace" />
            <IconButton icon="ellipsis-horizontal" onPress={() => setSheet('more')} accessibilityLabel="More workspace actions" testID="workspace-more" />
          </View>
        }
      />
      {body}
      {ws.notice ? (
        <View pointerEvents="none" style={[styles.toast, { bottom: insets.bottom + SPACE.xl, borderColor: alpha(toneColor(ws.notice.tone, colors), 0.6), backgroundColor: colors.surfaceDeep || colors.surface }]}>
          <Text style={[type.small, { color: colors.text }]} numberOfLines={3}>{ws.notice.text}</Text>
        </View>
      ) : null}

      <PickerSheet visible={sheet === 'picker'} onClose={() => setSheet(null)} ws={ws} onAdd={() => setSheet('new')} />
      <NewWorkspaceSheet visible={sheet === 'new'} onClose={() => setSheet(null)} ws={ws} />
      <TemplatesSheet visible={sheet === 'templates'} onClose={() => setSheet(null)} ws={ws} onBind={setBindRequest} />
      <ComponentsSheet visible={sheet === 'components'} onClose={() => setSheet(null)} ws={ws} onBind={setBindRequest} />
      <BindSheet request={bindRequest} onClose={() => setBindRequest(null)} ws={ws} />
      <WorkflowSheet visible={sheet === 'workflow'} onClose={() => setSheet(null)} ws={ws} />
      <VersionsSheet visible={sheet === 'versions'} onClose={() => setSheet(null)} ws={ws} />
      <LogsSheet visible={sheet === 'logs'} onClose={() => setSheet(null)} ws={ws} onOpenTerminals={() => navigation?.navigate?.('TerminalsModal')} />
      <ModelSheet visible={sheet === 'model'} onClose={() => setSheet(null)} ws={ws} />
      <LinkedSheet visible={sheet === 'linked'} onClose={() => setSheet(null)} ws={ws} />
      <MoreSheet visible={sheet === 'more'} onClose={() => setSheet(null)} ws={ws} actions={actions} previewUrl={previewUrl} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1, minHeight: 0, minWidth: 0 },
  row: { flexDirection: 'row' },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  leftPane: { borderRightWidth: StyleSheet.hairlineWidth },
  projectBar: { paddingHorizontal: SPACE.md, paddingTop: SPACE.sm, paddingBottom: SPACE.sm, gap: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  projectBarCompact: { flexDirection: 'row', alignItems: 'center', paddingTop: SPACE.xs, paddingBottom: SPACE.xs },
  pickBtn: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, minHeight: 48 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.md, minHeight: 32 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  routeInput: { flex: 1, minWidth: 60, height: 40, borderWidth: 1, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, fontFamily: MONO_FAMILY, fontSize: 13 },
  selBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, margin: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.sm },
  treeRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingRight: SPACE.md },
  tabStrip: { gap: SPACE.sm, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm },
  fileTab: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.pill, paddingLeft: SPACE.md },
  fileTabMain: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  fileTabClose: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  saveBar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  gitCard: { borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, gap: SPACE.xs },
  allDiff: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, minHeight: 48 },
  gitList: { borderWidth: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  gitRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.md, borderBottomWidth: StyleSheet.hairlineWidth },
  gitBadge: { width: 24, height: 24, borderRadius: 6, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  tabsBar: { flexGrow: 0, flexShrink: 0, paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  toast: { position: 'absolute', left: SPACE.lg, right: SPACE.lg, borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md },
});

export default WorkspaceScreen;
