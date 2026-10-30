/**
 * KanbanPanel — the web grid's kanban / projects / tasks panels
 * (views/grid-panels/{kanban,projects,tasks}-panel.ts, all wrapping renderKanban).
 *
 * Same RPCs as ui/src/ui/controllers/kanban.ts:
 *   kanban.projects.list                       gallery
 *   kanban.tasks.list { projectId }            board
 *   kanban.tasks.update { id, patch:{status,done} }   move a task
 *   kanban.tasks.create { title, projectId, status }  add a task
 * Scope persists on the panel as `kanbanProjectId` (web panel-meta-update).
 *
 * variant: 'kanban'   gallery → single-project board (columns as tabs)
 *          'projects' gallery (Active / AI / All / Done filters) → board
 *          'tasks'    project picker → every column of that project as one list
 */
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Button, Chip, IconButton, ListRow, PriorityChip, ProgressBar, SPACE, RADIUS, StatusChip, Tabs, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { PROJECT_FILTERS, TASK_COLUMNS, groupTasks, projectRows, relTime, statusPatch, taskRows } from '../grid-data';
import { PanelEmpty, PanelError, PanelLoading, PanelOpen, useRpc, withTimeout } from '../panel-kit';

// One projects list shared by every kanban-ish panel on the grid (124 KB on a
// big board) — refetched at most every 30 s unless a panel forces it.
let projectsCache = { at: 0, data: null, inflight: null };
async function loadProjects(sendReq, force) {
  if (!force && projectsCache.data && Date.now() - projectsCache.at < 30000) return projectsCache.data;
  if (!force && projectsCache.inflight) return projectsCache.inflight;
  projectsCache.inflight = withTimeout(sendReq('kanban.projects.list', {}), 30000, 'kanban.projects.list')
    .then((res) => {
      projectsCache = { at: Date.now(), data: res, inflight: null };
      return res;
    })
    .catch((err) => {
      projectsCache.inflight = null;
      throw err;
    });
  return projectsCache.inflight;
}

export function KanbanPanel({ panel, gateway, navigation, onPatch, refreshSignal, variant = 'kanban' }) {
  const projectId = panel.kanbanProjectId || null;
  const projects = useRpc(gateway, (sendReq) => loadProjects(sendReq, refreshSignal > 0), [], { refreshSignal });
  const project = useMemo(() => {
    const list = Array.isArray(projects.data) ? projects.data : [];
    return list.find((p) => p.id === projectId) || null;
  }, [projects.data, projectId]);

  const openBoard = () => navigateToScreen(navigation, { tab: 'Board' }, { gateway });

  if (projectId) {
    return (
      <ProjectBoard
        key={projectId}
        projectId={projectId}
        project={project}
        gateway={gateway}
        refreshSignal={refreshSignal}
        asList={variant === 'tasks'}
        onBack={() => onPatch({ kanbanProjectId: null })}
        onOpenBoard={openBoard}
      />
    );
  }
  return (
    <Gallery
      rpc={projects}
      variant={variant}
      onPick={(id) => onPatch({ kanbanProjectId: id })}
      onOpenBoard={openBoard}
    />
  );
}

function Gallery({ rpc, variant, onPick, onOpenBoard }) {
  const { colors, type } = useUIKit();
  const [filter, setFilter] = useState('active');
  const [query, setQuery] = useState('');
  const rows = useMemo(() => projectRows(rpc.data, filter, query), [rpc.data, filter, query]);

  if (rpc.loading && !rpc.data) return <PanelLoading rows={5} />;
  if (rpc.error && !rpc.data) return <PanelError message={rpc.error} onRetry={() => rpc.reload()} />;

  return (
    <View style={styles.root}>
      {variant === 'tasks' ? <Text style={[type.caption, styles.hint, { color: colors.textMuted }]}>Pick a project for this task list.</Text> : null}
      <View style={[styles.search, { borderColor: colors.borderSubtle, backgroundColor: withAlpha(colors.text, 0.05) }]}>
        <Ionicons name="search" size={14} color={colors.textMuted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search projects" placeholderTextColor={colors.textMuted} style={[type.small, styles.searchInput, { color: colors.text }]} accessibilityLabel="Search projects" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} nestedScrollEnabled style={{ flexGrow: 0 }}>
        {PROJECT_FILTERS.map((f) => <Chip key={f.key} size="sm" label={f.label} selected={filter === f.key} onPress={() => setFilter(f.key)} />)}
        <Text style={[type.monoSmall, { color: colors.textMuted, alignSelf: 'center' }]}>{rows.length}</Text>
      </ScrollView>
      <FlatList
        style={styles.flex}
        data={rows}
        keyExtractor={(p) => p.id}
        nestedScrollEnabled
        ListEmptyComponent={<PanelEmpty icon="folder-open-outline" title="No projects" message="Nothing matches this filter." />}
        renderItem={({ item: p }) => (
          <Pressable onPress={() => onPick(p.id)} style={({ pressed }) => [styles.proj, { borderBottomColor: colors.borderSubtle, backgroundColor: pressed ? withAlpha(colors.text, 0.05) : 'transparent' }]} accessibilityRole="button" accessibilityLabel={`Open project ${p.name}`}>
            <View style={styles.projHead}>
              <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{p.name}</Text>
              <StatusChip size="sm" status={p.status} />
            </View>
            <View style={styles.projMeta}>
              <ProgressBar value={p.progress / 100} height={4} style={styles.flex} />
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${p.progress}%`}</Text>
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${p.taskCount} tasks`}</Text>
            </View>
          </Pressable>
        )}
      />
      <PanelOpen label="Board" onPress={onOpenBoard} />
    </View>
  );
}

function ProjectBoard({ projectId, project, gateway, refreshSignal, asList, onBack, onOpenBoard }) {
  const { colors, type } = useUIKit();
  const tasksRpc = useRpc(gateway, (sendReq) => withTimeout(sendReq('kanban.tasks.list', { projectId }), 30000, 'kanban.tasks.list'), [projectId], { refreshSignal, pollMs: 30000 });
  const [local, setLocal] = useState({}); // optimistic status overrides
  const [col, setCol] = useState('todo');
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState(null);

  const tasks = useMemo(() => taskRows(tasksRpc.data).map((t) => (local[t.id] ? { ...t, status: local[t.id], done: local[t.id] === 'done' } : t)), [tasksRpc.data, local]);
  const grouped = useMemo(() => groupTasks(tasks), [tasks]);
  const tabs = TASK_COLUMNS.map((c) => ({ key: c.key, label: c.label, count: grouped[c.key].length }));
  const autoCol = React.useRef(false);
  React.useEffect(() => {
    if (autoCol.current || !tasksRpc.data) return;
    autoCol.current = true;
    if (!grouped[col].length) {
      const first = TASK_COLUMNS.find((c) => grouped[c.key].length && c.key !== 'done') || TASK_COLUMNS.find((c) => grouped[c.key].length);
      if (first) setCol(first.key);
    }
  }, [tasksRpc.data, grouped, col]);

  const move = useCallback(async (task, status) => {
    setSel(null);
    setLocal((m) => ({ ...m, [task.id]: status }));
    try {
      await gateway.sendReq('kanban.tasks.update', { id: task.id, patch: statusPatch(status) });
      tasksRpc.reload({ quiet: true });
    } catch (e) {
      setLocal((m) => { const n = { ...m }; delete n[task.id]; return n; });
      setErr(String(e?.message || e));
    }
  }, [gateway, tasksRpc]);

  const add = async () => {
    const title = draft.trim();
    if (!title) return;
    setAdding(true);
    try {
      await gateway.sendReq('kanban.tasks.create', { title, projectId, status: asList ? 'todo' : col });
      setDraft('');
      tasksRpc.reload({ quiet: true });
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setAdding(false);
    }
  };

  const renderTask = (t) => (
    <ListRow
      key={t.id}
      dense
      title={t.title}
      subtitle={[t.assignee, relTime(t.updatedAt)].filter(Boolean).join('  ')}
      leading={<Ionicons name={t.done ? 'checkmark-circle' : 'ellipse-outline'} size={18} color={t.done ? colors.success : colors.textMuted} />}
      trailing={t.priority ? <PriorityChip priority={t.priority} size="sm" /> : null}
      onPress={() => setSel(t)}
      accessibilityLabel={`Task ${t.title}`}
    />
  );

  let body;
  if (tasksRpc.loading && !tasksRpc.data) body = <PanelLoading rows={5} />;
  else if (tasksRpc.error && !tasksRpc.data) body = <PanelError message={tasksRpc.error} onRetry={() => tasksRpc.reload()} />;
  else if (asList) {
    body = (
      <ScrollView style={styles.flex} nestedScrollEnabled>
        {TASK_COLUMNS.map((c) => (grouped[c.key].length ? (
          <View key={c.key}>
            <Text style={[type.label, styles.section, { color: colors.textMuted }]}>{`${c.label}  ${grouped[c.key].length}`}</Text>
            {grouped[c.key].slice(0, 60).map(renderTask)}
          </View>
        ) : null))}
        {tasks.length === 0 ? <PanelEmpty icon="checkbox-outline" title="No tasks yet" message="Add the first task below." /> : null}
      </ScrollView>
    );
  } else {
    body = (
      <>
        <Tabs tabs={tabs} active={col} onSelect={setCol} style={styles.tabs} />
        <FlatList
          style={styles.flex}
          data={grouped[col]}
          keyExtractor={(t) => t.id}
          nestedScrollEnabled
          renderItem={({ item }) => renderTask(item)}
          ListEmptyComponent={<PanelEmpty icon="checkbox-outline" title={`Nothing in ${TASK_COLUMNS.find((c) => c.key === col)?.label}`} />}
        />
      </>
    );
  }

  return (
    <View style={styles.root}>
      <View style={[styles.boardHead, { borderBottomColor: colors.borderSubtle }]}>
        <IconButton icon="chevron-back" size="sm" onPress={onBack} accessibilityLabel="All projects" />
        <View style={styles.flex}>
          <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{project?.name || 'Project'}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${tasks.length} tasks  ${grouped.done.length} done`}</Text>
        </View>
        {project?.status ? <StatusChip size="sm" status={project.status} /> : null}
      </View>
      {body}
      {err ? <Text style={[type.caption, { color: colors.error, paddingHorizontal: SPACE.md }]} numberOfLines={2}>{err}</Text> : null}
      <View style={[styles.addRow, { borderTopColor: colors.borderSubtle }]}>
        <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={add} placeholder={asList ? 'Add a task' : `Add to ${TASK_COLUMNS.find((c) => c.key === col)?.label}`} placeholderTextColor={colors.textMuted} style={[type.small, styles.addInput, { color: colors.text, borderColor: colors.borderSubtle }]} accessibilityLabel="New task title" returnKeyType="done" />
        <IconButton icon="add" variant="solid" size="sm" loading={adding} disabled={!draft.trim()} onPress={add} accessibilityLabel="Add task" />
      </View>
      <PanelOpen label="Board" onPress={onOpenBoard} />

      <BottomSheet visible={Boolean(sel)} onClose={() => setSel(null)} title={sel?.title} subtitle="Move this task">
        {TASK_COLUMNS.map((c) => (
          <ListRow key={c.key} icon={sel?.status === c.key ? 'radio-button-on' : 'radio-button-off'} title={c.label} selected={sel?.status === c.key} onPress={() => sel && sel.status !== c.key && move(sel, c.key)} accessibilityLabel={`Move to ${c.label}`} />
        ))}
        <Button title="Open the Board" variant="ghost" icon="open-outline" onPress={() => { setSel(null); onOpenBoard(); }} style={{ marginTop: SPACE.sm }} />
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  hint: { paddingHorizontal: SPACE.md, paddingTop: SPACE.sm },
  search: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginHorizontal: SPACE.sm, marginTop: SPACE.sm, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1, minHeight: 40 },
  searchInput: { flex: 1, minHeight: 38 },
  chips: { gap: SPACE.sm, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.sm },
  proj: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: SPACE.xs, minHeight: 56, justifyContent: 'center' },
  projHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  projMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  boardHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingRight: SPACE.md, paddingVertical: SPACE.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { paddingVertical: SPACE.xs, flexGrow: 0 },
  section: { paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.xs },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.sm, borderTopWidth: StyleSheet.hairlineWidth },
  addInput: { flex: 1, minHeight: 40, borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md },
});
