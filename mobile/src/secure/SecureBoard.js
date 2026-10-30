/**
 * SecureBoard — the Secure Mode kanban (secure.kanban.*), used by the Board
 * and Dashboard screens while Secure Mode is on. Grouped by status; add a
 * task (into the selected project), tap a task to change its status or
 * delete it. Plain Views (no virtualised list) so it can sit inside a
 * parent ScrollView. Refetches on `secure.lane.changed {kind:"kanban"}`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../theme/color-utils';
import { SECURE_STATUSES, groupSecureTasks, secureErrorText } from './secure-logic';
import { useSecureLane } from './useSecureMode';
import { LockIcon, secureAccent } from './SecureControls';

function statusTone(colors, key) {
  switch (key) {
    case 'in_progress': return colors.info;
    case 'review': return colors.warning;
    case 'blocked': return colors.error;
    case 'done': return colors.success;
    default: return colors.textMuted;
  }
}

function confirmDelete(title, onYes) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window === 'undefined' || window.confirm(`Delete "${title}"?`)) onYes();
    return;
  }
  Alert.alert('Delete task', `Delete "${title}"?`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onYes },
  ]);
}

export function SecureBoard({ sendReq, subscribeEvent, connected = true, style }) {
  const { colors } = useTheme();
  const accent = secureAccent(colors);
  const [data, setData] = useState({ projects: [], tasks: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [draft, setDraft] = useState('');
  const [projectDraft, setProjectDraft] = useState(null); // null = closed
  const [openId, setOpenId] = useState(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!sendReq || !connected) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const res = await sendReq('secure.kanban.list', {});
      if (my !== seq.current) return;
      setData({
        projects: Array.isArray(res?.projects) ? res.projects : [],
        tasks: Array.isArray(res?.tasks) ? res.tasks : [],
      });
      setError(null);
    } catch (err) {
      if (my === seq.current) setError(secureErrorText(err));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [sendReq, connected]);

  useEffect(() => { void load(); }, [load]);
  useSecureLane(subscribeEvent, ['kanban'], () => { void load(); });

  const run = useCallback(async (method, params) => {
    setPending(true);
    try {
      await sendReq(method, params);
      await load();
      return true;
    } catch (err) {
      setError(secureErrorText(err));
      return false;
    } finally {
      setPending(false);
    }
  }, [sendReq, load]);

  const addTask = async () => {
    const title = draft.trim();
    if (!title || pending) return;
    const ok = await run('secure.kanban.tasks.create', { title, status: 'todo', ...(projectId ? { projectId } : {}) });
    if (ok) setDraft('');
  };
  const addProject = async () => {
    const name = String(projectDraft || '').trim();
    if (!name || pending) return;
    const ok = await run('secure.kanban.projects.create', { name });
    if (ok) setProjectDraft(null);
  };
  const setStatus = (task, status) => {
    if (task.status === status) return;
    // Optimistic: move it now, the refetch confirms.
    setData((d) => ({ ...d, tasks: d.tasks.map((t) => (t.id === task.id ? { ...t, status, updatedAt: Date.now() } : t)) }));
    void run('secure.kanban.tasks.update', { id: task.id, patch: { status } });
  };
  const remove = (task) => confirmDelete(task.title || 'task', () => {
    setOpenId(null);
    setData((d) => ({ ...d, tasks: d.tasks.filter((t) => t.id !== task.id) }));
    void run('secure.kanban.tasks.delete', { id: task.id });
  });

  const groups = useMemo(() => groupSecureTasks(data.tasks, projectId), [data.tasks, projectId]);
  const total = SECURE_STATUSES.reduce((n, s) => n + groups[s.key].length, 0);
  const projectName = (id) => data.projects.find((p) => p.id === id)?.name;

  const chip = (on) => [styles.chip, { borderColor: on ? withAlpha(accent, 0.7) : colors.border, backgroundColor: on ? withAlpha(accent, 0.14) : 'transparent' }];

  return (
    <View style={[styles.root, style]} testID="secure-board">
      <View style={styles.head}>
        <LockIcon size={16} color={accent} />
        <Text style={[styles.title, { color: colors.text }]}>Secure board</Text>
        <Text style={[styles.count, { color: colors.textMuted }]}>{total} task{total === 1 ? '' : 's'}</Text>
        <View style={styles.flex} />
        {loading || pending ? <ActivityIndicator size="small" color={accent} /> : null}
        <Pressable onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Refresh secure board" hitSlop={6} style={[styles.iconBtn, { borderColor: colors.border }]}>
          <Ionicons name="refresh" size={16} color={colors.text} />
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.textMuted }]}>Encrypted on this gateway, local models only. Never synced to Notion or the cloud.</Text>

      {error ? (
        <Pressable onPress={() => setError(null)} accessibilityRole="alert" style={[styles.err, { borderColor: withAlpha(colors.error, 0.6), backgroundColor: withAlpha(colors.error, 0.12) }]}>
          <Text style={{ color: colors.error, fontSize: 12, flex: 1 }}>{error}</Text>
          <Ionicons name="close" size={14} color={colors.error} />
        </Pressable>
      ) : null}

      <View style={styles.chips}>
        <Pressable onPress={() => setProjectId(null)} style={chip(!projectId)} accessibilityRole="button" accessibilityState={{ selected: !projectId }}>
          <Text style={[styles.chipText, { color: !projectId ? accent : colors.text }]}>All</Text>
        </Pressable>
        {data.projects.map((p) => (
          <Pressable key={p.id} onPress={() => setProjectId(p.id === projectId ? null : p.id)} style={chip(p.id === projectId)} accessibilityRole="button" accessibilityState={{ selected: p.id === projectId }}>
            <Text style={[styles.chipText, { color: p.id === projectId ? accent : colors.text }]} numberOfLines={1}>{p.name || 'Untitled'}</Text>
          </Pressable>
        ))}
        {projectDraft === null ? (
          <Pressable onPress={() => setProjectDraft('')} style={chip(false)} accessibilityRole="button" accessibilityLabel="New secure project" testID="secure-new-project">
            <Ionicons name="add" size={13} color={colors.textMuted} />
            <Text style={[styles.chipText, { color: colors.textMuted }]}>Project</Text>
          </Pressable>
        ) : (
          <View style={[styles.inline, { borderColor: colors.border }]}>
            <TextInput
              value={projectDraft}
              onChangeText={setProjectDraft}
              onSubmitEditing={addProject}
              placeholder="Project name"
              placeholderTextColor={colors.textMuted}
              autoFocus
              style={[styles.inlineInput, { color: colors.text }]}
            />
            <Pressable onPress={addProject} accessibilityRole="button" accessibilityLabel="Create project" hitSlop={6}><Ionicons name="checkmark" size={16} color={accent} /></Pressable>
            <Pressable onPress={() => setProjectDraft(null)} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={6}><Ionicons name="close" size={16} color={colors.textMuted} /></Pressable>
          </View>
        )}
      </View>

      <View style={[styles.add, { borderColor: withAlpha(accent, 0.45) }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={addTask}
          placeholder={projectId ? `New task in ${projectName(projectId) || 'project'}` : 'New secure task'}
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          style={[styles.addInput, { color: colors.text }]}
          testID="secure-task-input"
        />
        <Pressable
          onPress={addTask}
          disabled={!draft.trim() || pending}
          accessibilityRole="button"
          accessibilityLabel="Add secure task"
          testID="secure-task-add"
          style={[styles.addBtn, { backgroundColor: accent, opacity: !draft.trim() || pending ? 0.45 : 1 }]}
        >
          <Ionicons name="add" size={18} color={colors.background} />
        </Pressable>
      </View>

      {SECURE_STATUSES.map((s) => {
        const list = groups[s.key];
        const tone = statusTone(colors, s.key);
        return (
          <View key={s.key} style={[styles.col, { borderColor: colors.border, backgroundColor: withAlpha(colors.text || accent, 0.03) }]} testID={`secure-col-${s.key}`}>
            <View style={styles.colHead}>
              <View style={[styles.dot, { backgroundColor: tone }]} />
              <Text style={[styles.colTitle, { color: colors.text }]}>{s.label}</Text>
              <Text style={[styles.count, { color: colors.textMuted }]}>{list.length}</Text>
            </View>
            {list.length === 0 ? <Text style={[styles.empty, { color: colors.textMuted }]}>Nothing here</Text> : null}
            {list.map((task) => {
              const open = openId === task.id;
              return (
                <View key={task.id} style={[styles.task, { borderColor: open ? withAlpha(accent, 0.6) : colors.border }]}>
                  <Pressable onPress={() => setOpenId(open ? null : task.id)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.taskMain}>
                    <Text style={[styles.taskTitle, { color: colors.text }, task.status === 'done' && styles.doneText]} numberOfLines={2}>{task.title || 'Untitled'}</Text>
                    {task.description ? <Text style={{ color: colors.textMuted, fontSize: 12 }} numberOfLines={1}>{task.description}</Text> : null}
                    {!projectId && task.projectId && projectName(task.projectId) ? (
                      <Text style={{ color: colors.textMuted, fontSize: 11 }} numberOfLines={1}>{projectName(task.projectId)}</Text>
                    ) : null}
                  </Pressable>
                  {open ? (
                    <View style={styles.actions}>
                      {SECURE_STATUSES.map((o) => (
                        <Pressable key={o.key} onPress={() => setStatus(task, o.key)} style={chip(task.status === o.key)} accessibilityRole="radio" accessibilityState={{ checked: task.status === o.key }}>
                          <Text style={[styles.chipText, { color: task.status === o.key ? accent : colors.text }]}>{o.label}</Text>
                        </Pressable>
                      ))}
                      <Pressable onPress={() => remove(task)} style={[styles.chip, { borderColor: withAlpha(colors.error, 0.6) }]} accessibilityRole="button" accessibilityLabel={`Delete ${task.title}`}>
                        <Ionicons name="trash-outline" size={13} color={colors.error} />
                        <Text style={[styles.chipText, { color: colors.error }]}>Delete</Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '700' },
  count: { fontSize: 12 },
  hint: { fontSize: 12, lineHeight: 16 },
  iconBtn: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  err: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 30, maxWidth: 200 },
  chipText: { fontSize: 12, fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 30 },
  inlineInput: { minWidth: 120, fontSize: 13, paddingVertical: 4 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingLeft: 12, paddingRight: 6, minHeight: 48 },
  addInput: { flex: 1, fontSize: 14, paddingVertical: 8 },
  addBtn: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  col: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 8 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  colTitle: { fontSize: 13, fontWeight: '700', flex: 1 },
  empty: { fontSize: 12, paddingVertical: 2 },
  task: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 8 },
  taskMain: { gap: 2 },
  taskTitle: { fontSize: 14, fontWeight: '600' },
  doneText: { textDecorationLine: 'line-through', opacity: 0.7 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
