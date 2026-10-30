/**
 * IdeasScreen — Knowledge › Ideas on the phone (the web's Documents › Ideas).
 *
 * ideas.list / create / update / promote / delete over the gateway; refreshes
 * live on the `ideas.changed` event, so an idea captured by voice from the
 * InfiniBot face (or by an agent) appears here straight away.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet, Button, EmptyState, useUIKit, SPACE, RADIUS } from '../ui-kit';
import { withAlpha } from '../theme/color-utils';
import { IdeaIcon, ProjectIcon, TaskIcon, NoteIcon } from '../infini/icons';
import { ProjectField } from '../components/ProjectPicker';
import { useProjectCatalog } from '../lib/useProjectCatalog';
import { assignItemProject } from '../lib/project-assign';
import { ClientField } from '../components/ClientPicker';
import { DateField } from '../components/DatePicker';
import { useClientCatalog } from '../lib/useClientCatalog';
import { assignItemClient } from '../lib/client-assign';
import { findClient } from '../lib/client-picker-model';
import { formatWhen, joinWhen, splitWhen } from '../lib/date-pick';

export const IDEA_STATUSES = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'exploring', label: 'Exploring' },
  { key: 'parked', label: 'Parked' },
  { key: 'promoted', label: 'Promoted' },
];
const STATUS_COLOR = { new: '#f1d38a', exploring: '#8fb8ff', parked: '#9a9488', promoted: '#3fb27f' };
const SOURCE_LABEL = { voice: 'Voice', web: 'Web', agent: 'Agent', mobile: 'Phone' };

function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function IdeasScreen({ gateway, navigation, route }) {
  const { colors, type } = useUIKit();
  const [ideas, setIdeas] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const connected = gateway?.status === 'connected';
  const catalog = useProjectCatalog(gateway);
  const projectName = useCallback((id) => catalog.projects.find((p) => p.id === id)?.name, [catalog.projects]);
  const clientCatalog = useClientCatalog(gateway);
  const clientName = useCallback((id) => findClient(clientCatalog.clients, id)?.name, [clientCatalog.clients]);

  const load = useCallback(async () => {
    if (!connected) return;
    try {
      const res = await gateway.sendReq('ideas.list', { limit: 300 });
      setIdeas(res?.ideas || []);
      setCounts(res?.counts || {});
      setError(null);
    } catch (err) {
      const msg = err?.message || String(err);
      setError(/unknown method|not found|no handler/i.test(msg) ? 'Ideas turn on after the gateway restarts.' : msg);
    } finally {
      setLoading(false);
    }
  }, [connected, gateway]);

  useEffect(() => {
    void load();
    const unsub = gateway?.subscribeEvent?.('ideas.changed', () => void load());
    return () => unsub?.();
  }, [load, gateway]);

  // Library → tap an idea: open its sheet once the list has it.
  const focusId = route?.params?.ideaId;
  useEffect(() => {
    if (!focusId) return;
    const hit = ideas.find((i) => i.id === focusId);
    if (hit) {
      setSelected(hit);
      navigation?.setParams?.({ ideaId: undefined });
    }
  }, [focusId, ideas, navigation]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ideas.filter(
      (i) => (status === 'all' || i.status === status) && (!q || `${i.title}\n${i.body}\n${(i.tags || []).join(' ')}`.toLowerCase().includes(q)),
    );
  }, [ideas, status, query]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const r = await fn();
      if (ok) setNote(ok(r));
      await load();
      return r;
    } catch (err) {
      setNote(err?.message || String(err));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    void run('add', () => gateway.sendReq('ideas.create', { title, source: 'mobile' }), () => 'Idea saved').then((r) => r && setDraft(''));
  };

  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0);

  return (
    <View style={{ flex: 1 }} testID="ideas-screen">
      <View style={styles.top}>
        <View style={[styles.addRow, { borderColor: withAlpha(colors.primary, 0.3) }]}>
          <IdeaIcon size={20} color={colors.primary} />
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Capture an idea…"
            placeholderTextColor={withAlpha(colors.text, 0.35)}
            style={[type.body, { flex: 1, color: colors.text, minHeight: 44 }]}
            onSubmitEditing={add}
            returnKeyType="done"
            accessibilityLabel="New idea"
            testID="ideas-add-input"
          />
          <Button title="Add" size="sm" onPress={add} disabled={!draft.trim() || busy === 'add'} testID="ideas-add" />
        </View>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search ideas"
          placeholderTextColor={withAlpha(colors.text, 0.35)}
          style={[type.small, styles.search, { color: colors.text, borderColor: withAlpha(colors.text, 0.1) }]}
          accessibilityLabel="Search ideas"
        />
        <FlatList
          horizontal
          data={IDEA_STATUSES}
          keyExtractor={(s) => s.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: SPACE.sm }}
          renderItem={({ item }) => {
            const on = status === item.key;
            const n = item.key === 'all' ? total : counts[item.key] || 0;
            return (
              <Pressable
                onPress={() => setStatus(item.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={[styles.chip, { borderColor: on ? colors.primary : withAlpha(colors.text, 0.14), backgroundColor: on ? withAlpha(colors.primary, 0.12) : 'transparent' }]}
              >
                <Text style={[type.caption, { color: on ? colors.primary : colors.textSecondary }]}>
                  {item.label} {n}
                </Text>
              </Pressable>
            );
          }}
        />
      </View>

      {loading && !ideas.length ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: SPACE.xl }} />
      ) : error ? (
        <EmptyState icon="alert-circle-outline" title="Ideas unavailable" message={error} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(i) => i.id}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
          contentContainerStyle={{ padding: SPACE.lg, gap: SPACE.sm, paddingBottom: 140 }}
          ListEmptyComponent={
            <EmptyState
              icon="bulb-outline"
              title={ideas.length ? 'Nothing matches' : 'No ideas yet'}
              message={ideas.length ? 'Try another filter.' : 'Type one above, or tap Idea around the InfiniBot face and say it.'}
            />
          }
          renderItem={({ item: i }) => (
            <Pressable
              onPress={() => setSelected(i)}
              style={[styles.row, { borderColor: withAlpha(colors.text, 0.08), backgroundColor: withAlpha('#ffffff', 0.03) }]}
              accessibilityRole="button"
              accessibilityLabel={`${i.title}, ${i.status}`}
              testID={`idea-row-${i.id}`}
            >
              <View style={[styles.dot, { backgroundColor: STATUS_COLOR[i.status] || colors.primary }]} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text style={[type.bodyStrong, { color: colors.text }]} numberOfLines={1}>
                  {i.title}
                </Text>
                {i.body ? (
                  <Text style={[type.small, { color: colors.textSecondary }]} numberOfLines={2}>
                    {i.body}
                  </Text>
                ) : null}
                <Text style={[type.caption, { color: colors.textMuted }]}>
                  {[
                    i.status,
                    i.projectIds?.[0] ? projectName(i.projectIds[0]) || 'project' : null,
                    i.clientIds?.[0] ? clientName(i.clientIds[0]) || 'client' : null,
                    i.reviewOn ? `review ${formatWhen(splitWhen(i.reviewOn).date, splitWhen(i.reviewOn).time)}` : null,
                    SOURCE_LABEL[i.source] || i.source,
                    ago(i.updatedAt),
                    ...(i.tags || []).slice(0, 3).map((t) => `#${t}`),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      {note ? (
        <Pressable onPress={() => setNote(null)} style={[styles.note, { borderColor: withAlpha(colors.primary, 0.4) }]}>
          <Text style={[type.small, { color: colors.text }]}>{note}</Text>
        </Pressable>
      ) : null}

      <BottomSheet visible={!!selected} onClose={() => setSelected(null)} title={selected?.title || ''} subtitle={selected ? `${SOURCE_LABEL[selected.source] || selected.source} · ${ago(selected.createdAt)}` : ''} testID="idea-sheet">
        {selected ? (
          <View style={{ gap: SPACE.lg }}>
            {selected.body ? <Text style={[type.body, { color: colors.text }]}>{selected.body}</Text> : null}
            <ProjectField
              catalog={catalog}
              projectId={selected.projectIds?.[0]}
              projectName={projectName(selected.projectIds?.[0])}
              disabled={busy === 'project'}
              onChange={(p) =>
                void run(
                  'project',
                  () => assignItemProject(gateway.sendReq, { kind: 'idea', id: selected.id, projectId: p?.id || null, previousProjectId: selected.projectIds?.[0] }),
                  () => (p ? `Moved to ${p.name}` : 'Removed from project'),
                ).then((r) => r && setSelected({ ...selected, projectIds: p?.id ? [p.id] : [] }))
              }
              testID="idea-project"
            />
            <ClientField
              catalog={clientCatalog}
              clientId={selected.clientIds?.[0]}
              clientName={clientName(selected.clientIds?.[0])}
              disabled={busy === 'client'}
              onChange={(c) =>
                void run(
                  'client',
                  () => assignItemClient(gateway.sendReq, { kind: 'idea', id: selected.id, clientId: c?.id || null, previousClientId: selected.clientIds?.[0] }),
                  () => (c ? `Linked to ${c.name}` : 'Client removed'),
                ).then((r) => r && setSelected({ ...selected, clientIds: c?.id ? [c.id] : [] }))
              }
              testID="idea-client"
            />
            <DateField
              label="Review on"
              empty="No review date"
              date={splitWhen(selected.reviewOn).date}
              time={splitWhen(selected.reviewOn).time}
              disabled={busy === 'date'}
              onChange={({ date, time }) =>
                void run(
                  'date',
                  () => gateway.sendReq('ideas.update', { id: selected.id, patch: { reviewOn: date ? joinWhen(date, time) : null } }),
                  () => (date ? `Review on ${formatWhen(date, time)}` : 'Review date cleared'),
                ).then((r) => r?.idea && setSelected(r.idea))
              }
              testID="idea-date"
            />
            <View style={styles.wrap}>
              {['new', 'exploring', 'parked'].map((s) => (
                <Pressable
                  key={s}
                  onPress={() =>
                    void run('status', () => gateway.sendReq('ideas.update', { id: selected.id, patch: { status: s } }), () => `Moved to ${s}`).then(
                      (r) => r?.idea && setSelected(r.idea),
                    )
                  }
                  style={[styles.chip, { borderColor: selected.status === s ? STATUS_COLOR[s] : withAlpha(colors.text, 0.14) }]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: selected.status === s }}
                >
                  <Text style={[type.caption, { color: selected.status === s ? STATUS_COLOR[s] : colors.textSecondary }]}>{s}</Text>
                </Pressable>
              ))}
            </View>
            {selected.promotedTo ? (
              <Text style={[type.small, { color: STATUS_COLOR.promoted }]}>Promoted to a {selected.promotedTo.kind} ({selected.promotedTo.id})</Text>
            ) : null}
            <Text style={[type.label, { color: colors.textMuted }]}>Promote to</Text>
            <View style={styles.wrap}>
              {[
                { to: 'task', label: 'Task', Icon: TaskIcon },
                { to: 'project', label: 'Project', Icon: ProjectIcon },
                { to: 'document', label: 'Document', Icon: NoteIcon },
              ].map(({ to, label, Icon }) => (
                <Pressable
                  key={to}
                  disabled={!!busy}
                  onPress={() =>
                    void run(`promote-${to}`, () => gateway.sendReq('ideas.promote', { id: selected.id, to }), (r) => `Now a ${r.target.kind}: ${r.target.title}`).then(
                      (r) => r?.idea && setSelected(r.idea),
                    )
                  }
                  style={[styles.promote, { borderColor: withAlpha(colors.primary, 0.4) }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Promote to a ${label.toLowerCase()}`}
                  testID={`idea-promote-${to}`}
                >
                  {busy === `promote-${to}` ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon size={18} color={colors.primary} />}
                  <Text style={[type.smallStrong, { color: colors.text }]}>{label}</Text>
                </Pressable>
              ))}
            </View>
            <Button
              title="View in graph"
              icon="git-network-outline"
              variant="outline"
              onPress={() => {
                const id = selected.id;
                setSelected(null);
                navigation?.navigate?.('KnowledgeGraph', { focus: `idea:${id}`, _ts: Date.now() });
              }}
              accessibilityLabel="View this idea in the knowledge graph"
              testID="idea-view-graph"
            />
            <Button
              title="Delete idea"
              variant="danger"
              onPress={() => void run('delete', () => gateway.sendReq('ideas.delete', { id: selected.id }), () => 'Idea deleted').then(() => setSelected(null))}
            />
          </View>
        ) : null}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { paddingHorizontal: SPACE.lg, paddingTop: SPACE.md, gap: SPACE.sm },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.lg, paddingLeft: SPACE.md, paddingRight: SPACE.xs, backgroundColor: 'rgba(0,0,0,0.35)' },
  search: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, minHeight: 40 },
  chip: { minHeight: 36, paddingHorizontal: SPACE.md, borderRadius: RADIUS.pill, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: SPACE.md, padding: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1 },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 7 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  promote: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  note: { position: 'absolute', left: SPACE.lg, right: SPACE.lg, bottom: 110, padding: SPACE.md, borderRadius: RADIUS.lg, borderWidth: 1, backgroundColor: 'rgba(14,12,8,0.96)' },
});

export default IdeasScreen;
