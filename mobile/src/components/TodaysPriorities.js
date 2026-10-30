/**
 * TodaysPriorities — the prominent mobile daily-priorities surface.
 *
 * Mirrors the web `<todays-priorities>` component and is backed by the SAME
 * shared gateway service (`priorities.*` RPCs) so web and mobile stay in sync
 * via the `priorities:changed` WS broadcast. Feature parity:
 *   - persistent, per-day, HIERARCHICAL checklist (parent/child nesting)
 *   - reorder + indent/outdent (touch controls — reliable inside the dashboard
 *     ScrollView, where a nested DraggableFlatList would fight the parent
 *     VirtualizedList/gesture handler)
 *   - date pagination (prev / today / next) + history search
 *   - add existing kanban task, and create a NEW task with a MANDATORY project
 *
 * Styling follows the app's black/gold premium tokens (COLORS / FONT_FAMILY).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, FONT_FAMILY } from '../constants/theme';
import { toVisual, normalize } from './priorities-tree';

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
function shiftDate(date, days) {
  const [y, m, dd] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
    dt.getDate(),
  ).padStart(2, '0')}`;
}
function labelForDate(date) {
  const today = isoToday();
  if (date === today) return 'Today';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  if (date === shiftDate(today, 1)) return 'Tomorrow';
  const [y, m, dd] = date.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

export function TodaysPriorities({ gateway }) {
  const sendReq = gateway?.sendReq;
  const [date, setDate] = useState(isoToday());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newTitle, setNewTitle] = useState('');

  const [picker, setPicker] = useState('none'); // none | existing | create
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createProjectId, setCreateProjectId] = useState('');
  const [createError, setCreateError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);

  const dateRef = useRef(date);
  dateRef.current = date;

  const load = useCallback(
    async (silent) => {
      if (!sendReq) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      setError(null);
      try {
        const res = await sendReq('priorities.listByDate', { date: dateRef.current });
        setItems(res?.items || []);
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    },
    [sendReq],
  );

  useEffect(() => {
    load();
  }, [load, date]);

  // Live sync via WS broadcast.
  useEffect(() => {
    const sub = gateway?.subscribeEvent;
    if (!sub) return undefined;
    const unsub = sub('priorities:changed', (payload) => {
      if (!payload?.date || payload.date === dateRef.current) load(true);
    });
    return unsub;
  }, [gateway, load]);

  const persistOrder = useCallback(
    async (nextItems) => {
      const order = normalize(nextItems);
      const byId = {};
      order.forEach((o) => (byId[o.id] = o));
      setItems((prev) =>
        prev.map((i) => (byId[i.id] ? { ...i, parentId: byId[i.id].parentId, ordinal: byId[i.id].ordinal } : i)),
      );
      try {
        await sendReq('priorities.reorder', { date: dateRef.current, order });
      } catch (e) {
        setError(String(e?.message || e));
      }
      load(true);
    },
    [sendReq, load],
  );

  const siblingsOf = (arr, parentId) =>
    arr.filter((x) => (x.parentId || null) === (parentId || null)).sort((a, b) => a.ordinal - b.ordinal);

  const moveWithinSiblings = (item, dir) => {
    const arr = items.map((i) => ({ ...i }));
    const sibs = siblingsOf(arr, item.parentId);
    const idx = sibs.findIndex((s) => s.id === item.id);
    const swapWith = sibs[idx + dir];
    if (!swapWith) return;
    const a = arr.find((x) => x.id === item.id);
    const b = arr.find((x) => x.id === swapWith.id);
    const tmp = a.ordinal;
    a.ordinal = b.ordinal;
    b.ordinal = tmp;
    persistOrder(arr);
  };

  const indent = (item) => {
    const arr = items.map((i) => ({ ...i }));
    const sibs = siblingsOf(arr, item.parentId);
    const idx = sibs.findIndex((s) => s.id === item.id);
    if (idx <= 0) return; // needs a previous sibling to nest under
    const newParent = sibs[idx - 1];
    const target = arr.find((x) => x.id === item.id);
    const childOrdinals = arr.filter((x) => x.parentId === newParent.id).map((x) => x.ordinal);
    target.parentId = newParent.id;
    target.ordinal = childOrdinals.length ? Math.max(...childOrdinals) + 1 : 0;
    persistOrder(arr);
  };

  const outdent = (item) => {
    if (!item.parentId) return;
    const arr = items.map((i) => ({ ...i }));
    const parent = arr.find((x) => x.id === item.parentId);
    if (!parent) return;
    const target = arr.find((x) => x.id === item.id);
    target.parentId = parent.parentId || null;
    // place right after the parent
    target.ordinal = parent.ordinal + 0.5;
    persistOrder(arr);
  };

  const addItem = async () => {
    const title = newTitle.trim();
    if (!title || !sendReq) return;
    setNewTitle('');
    try {
      await sendReq('priorities.add', { date, title });
    } catch (e) {
      setError(String(e?.message || e));
    }
    load(true);
  };
  const toggle = async (item) => {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, completed: !i.completed } : i)));
    try {
      await sendReq('priorities.toggle', { id: item.id });
    } catch (e) {
      setError(String(e?.message || e));
    }
    load(true);
  };
  const remove = async (item) => {
    try {
      await sendReq('priorities.remove', { id: item.id });
    } catch (e) {
      setError(String(e?.message || e));
    }
    load(true);
  };

  const openPicker = async (kind) => {
    setPicker(kind);
    setCreateError(null);
    setPickerQuery('');
    await refreshPicker('');
  };
  const refreshPicker = async (q) => {
    try {
      const res = await sendReq('priorities.pickerData', { query: q });
      const ps = res?.projects || [];
      setProjects(ps);
      setTasks(res?.tasks || []);
      if (!createProjectId && ps[0]) setCreateProjectId(ps[0].id);
    } catch (e) {
      setCreateError(String(e?.message || e));
    }
  };
  const addExistingTask = async (t) => {
    setBusy(true);
    try {
      await sendReq('priorities.addExistingTask', { date, taskId: t.id });
      setPicker('none');
      load(true);
    } catch (e) {
      setCreateError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const createTaskAndAdd = async () => {
    const title = createTitle.trim();
    setCreateError(null);
    if (!title) {
      setCreateError('Task title is required.');
      return;
    }
    if (!createProjectId) {
      setCreateError('Choose a project — tasks must belong to a project.');
      return;
    }
    setBusy(true);
    try {
      await sendReq('priorities.createTaskAndAdd', { date, title, projectId: createProjectId });
      setCreateTitle('');
      setPicker('none');
      load(true);
    } catch (e) {
      setCreateError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const runSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    try {
      const res = await sendReq('priorities.search', { query: q });
      setSearchResults(res?.items || []);
    } catch (e) {
      setError(String(e?.message || e));
    }
  };

  const visual = toVisual(items);
  const done = items.filter((i) => i.completed).length;
  const searching = searchResults !== null;

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Ionicons name="star" size={15} color={COLORS.primary} />
          <Text style={styles.title}>Today's Priorities</Text>
          {items.length ? (
            <View style={styles.countPill}>
              <Text style={styles.countTxt}>
                {done}/{items.length}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.pager}>
          <TouchableOpacity style={styles.pagerBtn} onPress={() => setDate(shiftDate(date, -1))}>
            <Ionicons name="chevron-back" size={16} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.dayBtn} onPress={() => setDate(isoToday())}>
            <Text style={styles.dayTxt}>{labelForDate(date)}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.pagerBtn} onPress={() => setDate(shiftDate(date, 1))}>
            <Ionicons name="chevron-forward" size={16} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Search priority history…"
          placeholderTextColor={COLORS.textMuted}
          value={searchQuery}
          onChangeText={setSearchQuery}
          onSubmitEditing={runSearch}
          returnKeyType="search"
        />
        <TouchableOpacity style={styles.btn} onPress={runSearch}>
          <Text style={styles.btnTxt}>Search</Text>
        </TouchableOpacity>
        {searching ? (
          <TouchableOpacity
            style={styles.ghostBtn}
            onPress={() => {
              setSearchQuery('');
              setSearchResults(null);
            }}
          >
            <Text style={styles.ghostTxt}>Clear</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {error ? <Text style={styles.err}>{error}</Text> : null}

      {searching ? (
        <View>
          <Text style={styles.muted}>{searchResults.length} result(s)</Text>
          {searchResults.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={styles.resultRow}
              onPress={() => {
                setDate(r.date);
                setSearchResults(null);
                setSearchQuery('');
              }}
            >
              <Text style={[styles.resultTitle, r.completed && styles.doneTxt]}>{r.title}</Text>
              <Text style={styles.resultDate}>{labelForDate(r.date)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : (
        <View>
          {loading ? (
            <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 16 }} />
          ) : visual.length === 0 ? (
            <Text style={styles.empty}>
              No priorities yet for {labelForDate(date)}. Add one below or pull in a task.
            </Text>
          ) : (
            visual.map((node) => (
              <View
                key={node.id}
                style={[styles.row, { paddingLeft: node.depth * 18 + 2 }]}
              >
                <TouchableOpacity
                  style={[styles.check, node.completed && styles.checkOn]}
                  onPress={() => toggle(node)}
                >
                  {node.completed ? <Ionicons name="checkmark" size={13} color="#0a0a0e" /> : null}
                </TouchableOpacity>
                <View style={styles.rowMain}>
                  <Text style={[styles.rowTitle, node.completed && styles.doneTxt]} numberOfLines={2}>
                    {node.title}
                  </Text>
                  {node.projectName ? (
                    <View style={styles.chip}>
                      <Text style={styles.chipTxt}>{node.projectName}</Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.rowCtrls}>
                  <TouchableOpacity style={styles.ctrl} onPress={() => moveWithinSiblings(node, -1)}>
                    <Ionicons name="chevron-up" size={15} color={COLORS.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.ctrl} onPress={() => moveWithinSiblings(node, 1)}>
                    <Ionicons name="chevron-down" size={15} color={COLORS.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.ctrl} onPress={() => outdent(node)}>
                    <Ionicons name="chevron-back" size={15} color={COLORS.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.ctrl} onPress={() => indent(node)}>
                    <Ionicons name="chevron-forward" size={15} color={COLORS.textMuted} />
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.ctrl} onPress={() => remove(node)}>
                    <Ionicons name="close" size={15} color={COLORS.error} />
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}

          {/* Add bar */}
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              placeholder="Add a priority…"
              placeholderTextColor={COLORS.textMuted}
              value={newTitle}
              onChangeText={setNewTitle}
              onSubmitEditing={addItem}
              returnKeyType="done"
            />
            <TouchableOpacity style={styles.addBtn} onPress={addItem}>
              <Text style={styles.addBtnTxt}>Add</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.linkRow}>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => openPicker('existing')}>
              <Ionicons name="link" size={13} color={COLORS.textSecondary} />
              <Text style={styles.ghostTxt}> Add task</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => openPicker('create')}>
              <Ionicons name="add-circle-outline" size={13} color={COLORS.textSecondary} />
              <Text style={styles.ghostTxt}> New task</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Picker modal */}
      <Modal visible={picker !== 'none'} transparent animationType="fade" onRequestClose={() => setPicker('none')}>
        <View style={styles.backdrop}>
          <View style={styles.modal}>
            <View style={styles.modalHead}>
              <View style={styles.tabs}>
                <TouchableOpacity
                  style={[styles.tab, picker === 'existing' && styles.tabActive]}
                  onPress={() => openPicker('existing')}
                >
                  <Text style={[styles.tabTxt, picker === 'existing' && styles.tabTxtActive]}>Add existing</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.tab, picker === 'create' && styles.tabActive]}
                  onPress={() => openPicker('create')}
                >
                  <Text style={[styles.tabTxt, picker === 'create' && styles.tabTxtActive]}>Create new</Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => setPicker('none')}>
                <Ionicons name="close" size={20} color={COLORS.textMuted} />
              </TouchableOpacity>
            </View>

            {createError ? <Text style={styles.err}>{createError}</Text> : null}

            {picker === 'existing' ? (
              <View>
                <TextInput
                  style={styles.input}
                  placeholder="Search tasks…"
                  placeholderTextColor={COLORS.textMuted}
                  value={pickerQuery}
                  onChangeText={(t) => {
                    setPickerQuery(t);
                    refreshPicker(t);
                  }}
                />
                <ScrollView style={{ maxHeight: 320, marginTop: 8 }}>
                  {tasks.length === 0 ? (
                    <Text style={styles.muted}>No tasks found.</Text>
                  ) : (
                    tasks.map((t) => (
                      <TouchableOpacity
                        key={t.id}
                        style={styles.taskOpt}
                        disabled={busy}
                        onPress={() => addExistingTask(t)}
                      >
                        <Text style={styles.taskOptTitle} numberOfLines={1}>
                          {t.title}
                        </Text>
                        <Text style={styles.taskOptProj}>{t.projectName || '—'}</Text>
                      </TouchableOpacity>
                    ))
                  )}
                </ScrollView>
              </View>
            ) : (
              <View>
                <TextInput
                  style={styles.input}
                  placeholder="New task title…"
                  placeholderTextColor={COLORS.textMuted}
                  value={createTitle}
                  onChangeText={setCreateTitle}
                />
                <Text style={styles.lbl}>
                  Project <Text style={styles.req}>*required</Text>
                </Text>
                <ScrollView style={{ maxHeight: 180 }}>
                  {projects.length === 0 ? (
                    <Text style={styles.muted}>No projects yet — create one on the board first.</Text>
                  ) : (
                    projects.map((p) => (
                      <TouchableOpacity
                        key={p.id}
                        style={[styles.projOpt, createProjectId === p.id && styles.projOptOn]}
                        onPress={() => setCreateProjectId(p.id)}
                      >
                        <Ionicons
                          name={createProjectId === p.id ? 'radio-button-on' : 'radio-button-off'}
                          size={16}
                          color={createProjectId === p.id ? COLORS.primary : COLORS.textMuted}
                        />
                        <Text style={styles.projOptTxt}>{p.name}</Text>
                      </TouchableOpacity>
                    ))
                  )}
                </ScrollView>
                <TouchableOpacity style={styles.primaryBtn} disabled={busy} onPress={createTaskAndAdd}>
                  <Text style={styles.primaryBtnTxt}>Create task &amp; add</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 14,
    backgroundColor: 'rgba(15,15,15,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.22)',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 8,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  title: { fontFamily: FONT_FAMILY.bold, fontSize: 15, color: COLORS.text },
  countPill: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: 'rgba(251,191,36,0.28)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  countTxt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 11, color: COLORS.primary },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pagerBtn: {
    padding: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.18)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.18)',
  },
  dayTxt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 12, color: COLORS.primary, minWidth: 62, textAlign: 'center' },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  linkRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  input: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.16)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: COLORS.text,
    fontFamily: FONT_FAMILY.regular,
    fontSize: 13,
  },
  btn: {
    backgroundColor: 'rgba(251,191,36,0.14)',
    borderColor: 'rgba(251,191,36,0.3)',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  btnTxt: { fontFamily: FONT_FAMILY.semiBold, fontSize: 12, color: COLORS.primary },
  addBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 9 },
  addBtnTxt: { fontFamily: FONT_FAMILY.bold, fontSize: 13, color: '#0a0a0e' },
  ghostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  ghostTxt: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.textSecondary },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 8 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  rowTitle: { fontFamily: FONT_FAMILY.medium, fontSize: 13.5, color: COLORS.text, flexShrink: 1 },
  doneTxt: { textDecorationLine: 'line-through', color: COLORS.textMuted },
  rowCtrls: { flexDirection: 'row', alignItems: 'center' },
  ctrl: { paddingHorizontal: 3, paddingVertical: 3 },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: 'rgba(251,191,36,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chip: {
    backgroundColor: 'rgba(251,191,36,0.1)',
    borderColor: 'rgba(251,191,36,0.22)',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 1,
  },
  chipTxt: { fontFamily: FONT_FAMILY.medium, fontSize: 10, color: COLORS.primary },
  empty: { fontFamily: FONT_FAMILY.regular, fontSize: 13, color: COLORS.textMuted, paddingVertical: 12 },
  muted: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.textMuted, paddingVertical: 6 },
  err: { fontFamily: FONT_FAMILY.regular, fontSize: 12, color: COLORS.error, paddingVertical: 4 },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 4,
  },
  resultTitle: { fontFamily: FONT_FAMILY.medium, fontSize: 13, color: COLORS.text, flexShrink: 1 },
  resultDate: { fontFamily: FONT_FAMILY.medium, fontSize: 11, color: COLORS.primary },
  // Modal
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', paddingHorizontal: 20 },
  modal: {
    backgroundColor: '#111116',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.3)',
    padding: 16,
  },
  modalHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  tabs: { flexDirection: 'row', gap: 6 },
  tab: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  tabActive: { backgroundColor: 'rgba(251,191,36,0.16)', borderColor: 'rgba(251,191,36,0.35)' },
  tabTxt: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.textMuted },
  tabTxtActive: { color: COLORS.primary },
  taskOpt: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    borderRadius: 8,
    padding: 10,
    marginBottom: 4,
  },
  taskOptTitle: { fontFamily: FONT_FAMILY.medium, fontSize: 13, color: COLORS.text, flexShrink: 1, marginRight: 8 },
  taskOptProj: { fontFamily: FONT_FAMILY.medium, fontSize: 11, color: COLORS.primary },
  lbl: { fontFamily: FONT_FAMILY.medium, fontSize: 12, color: COLORS.textMuted, marginTop: 10, marginBottom: 6 },
  req: { color: COLORS.error, fontSize: 11 },
  projOpt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  projOptOn: { backgroundColor: 'rgba(251,191,36,0.08)' },
  projOptTxt: { fontFamily: FONT_FAMILY.medium, fontSize: 13, color: COLORS.text },
  primaryBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryBtnTxt: { fontFamily: FONT_FAMILY.bold, fontSize: 13.5, color: '#0a0a0e' },
});

export default TodaysPriorities;
