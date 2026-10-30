/**
 * Dedicated project page (web ProjectDetailPage): Overview (facts + status
 * buttons), Tasks (+ Task, per-task status/assignee/edit), Notes (notes.list /
 * notes.create tagged project:<id>) and Activity (audit events for the project
 * and its tasks).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text } from 'react-native';
import { BottomSheet, Button, Field, ProgressBar, SegmentedControl, SPACE, StatusChip, useUIKit } from '../../../ui-kit';
import { PROJECT_STATUSES, humanize, money, normalizeNotes, projectNoteTag, relativeTime, shortDate } from './agency-ops-model';
import { TaskControls } from './DeliveryTab';
import { Actions, ActionButton, Empty, Meta, Row, StatPairs, Tile, Title } from './ui';

export function ProjectDetailSheet({ ctx, projectId, onClose }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const s = ops.state;
  const project = s.projects.find((p) => p.id === projectId);
  const [tab, setTab] = useState('overview');
  const [notes, setNotes] = useState({ loading: false, list: [], error: null });
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const tasks = useMemo(() => s.tasks.filter((t) => t.projectId === projectId), [s.tasks, projectId]);

  const loadNotes = useCallback(async () => {
    if (!projectId) return;
    setNotes((n) => ({ ...n, loading: true }));
    try {
      const r = await ops.req('notes.list', { tags: [projectNoteTag(projectId)], limit: 100 });
      setNotes({ loading: false, list: normalizeNotes(r), error: null });
    } catch (e) { setNotes({ loading: false, list: [], error: e?.message || String(e) }); }
  }, [ops, projectId]);

  useEffect(() => { if (projectId) { setTab('overview'); setDraft(''); loadNotes(); } }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const addNote = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      await ops.call('notes.create', { name: `${project?.name ?? 'Project'} · ${new Date().toLocaleDateString()}`, body: draft.trim(), category: 'project', tags: [projectNoteTag(projectId), 'project'] });
      setDraft('');
      await loadNotes();
    } catch { /* recorded */ } finally { setSaving(false); }
  };

  const clientName = project?.clientId ? s.clients.find((c) => c.id === project.clientId)?.name ?? 'Linked client' : 'No client linked';
  const done = tasks.filter((t) => t.status === 'done').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const taskIds = new Set(tasks.map((t) => t.id));
  const events = s.auditEvents
    .filter((e) => (e.entityType === 'agency_project' && e.entityId === projectId) || (e.entityType === 'agency_task' && taskIds.has(e.entityId)))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);

  return (
    <BottomSheet
      visible={!!projectId && !!project}
      onClose={onClose}
      title={project?.name ?? 'Project'}
      subtitle={clientName}
      maxHeightRatio={0.94}
      headerRight={project && !project.mirrored ? <Button title="Edit" size="sm" variant="secondary" onPress={() => ctx.openDialog('project-edit', { entityId: projectId })} accessibilityLabel="Edit project" /> : null}
    >
      {project ? (
        <View>
          <SegmentedControl
            options={[{ key: 'overview', label: 'Overview' }, { key: 'tasks', label: `Tasks ${tasks.length}` }, { key: 'notes', label: 'Notes' }, { key: 'activity', label: 'Activity' }]}
            value={tab}
            onChange={setTab}
            style={{ marginBottom: SPACE.md }}
          />
          {tab === 'overview' ? (
            <View>
              <Row style={{ marginBottom: SPACE.sm }}>
                <StatusChip status={project.status} label={humanize(project.status)} />
                <Meta mono>{pct}% complete</Meta>
              </Row>
              <ProgressBar value={pct / 100} style={{ marginBottom: SPACE.md }} />
              <StatPairs
                cols={2}
                pairs={[
                  { label: 'Budget', value: project.budgetCents ? money(project.budgetCents / 100) : 'Not set' },
                  { label: 'MRR', value: money((project.mrrCents ?? 0) / 100) },
                  { label: 'Target end', value: project.targetEndAt ? shortDate(project.targetEndAt) : '—' },
                  { label: 'Tasks done', value: `${done}/${tasks.length}` },
                  { label: 'Open tasks', value: String(tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length) },
                  { label: 'Blocked', value: String(tasks.filter((t) => t.status === 'blocked').length), tone: tasks.some((t) => t.status === 'blocked') ? 'danger' : undefined },
                ]}
              />
              <Text style={[type.label, { color: colors.textSecondary, marginTop: SPACE.sm }]}>Move project</Text>
              {project.mirrored ? <Meta>This project lives on the kanban board — change its status from the Command center.</Meta> : (
                <Actions>
                  {PROJECT_STATUSES.map(([st, label]) => (
                    <ActionButton key={st} title={label} variant={st === project.status ? 'primary' : 'secondary'} disabled={st === project.status} loading={ops.busy === project.id && st !== project.status ? false : undefined} onPress={() => ctx.transitionProject(project.id, st)} accessibilityLabel={`Move project to ${label}`} />
                  ))}
                </Actions>
              )}
              <Actions style={{ marginTop: SPACE.md }}>
                <Button title="Open on board" size="sm" variant="ghost" onPress={() => ctx.focusProjectTasks(project.id)} accessibilityLabel="Open this project's tasks on the board" />
                {project.clientId ? <Button title="Client profile" size="sm" variant="ghost" onPress={() => { onClose(); ctx.openClient(project.clientId); }} accessibilityLabel="Open the client profile" /> : null}
              </Actions>
            </View>
          ) : null}
          {tab === 'tasks' ? (
            <View>
              <Button title="+ Task" size="sm" onPress={() => ctx.openDialog('task', { entityId: projectId })} style={{ alignSelf: 'flex-start', marginBottom: SPACE.sm }} accessibilityLabel="Create a task in this project" />
              {tasks.length ? tasks.slice(0, 80).map((t) => (
                <Tile key={t.id}>
                  <Title>{t.title}</Title>
                  <Meta>{t.priority} priority{t.dueAt ? ` · due ${shortDate(t.dueAt)}` : ''}{t.description ? ` · ${t.description.slice(0, 80)}` : ''}</Meta>
                  <TaskControls ctx={ctx} task={t} />
                  <ActionButton title="Edit" onPress={() => ctx.openDialog('task-edit', { entityId: t.id })} accessibilityLabel={`Edit task ${t.title}`} />
                </Tile>
              )) : <Empty icon="list-outline" text="No tasks in this project yet." />}
              {tasks.length > 80 ? <Meta>Showing 80 of {tasks.length}. Use the board to see every task.</Meta> : null}
            </View>
          ) : null}
          {tab === 'notes' ? (
            <View>
              <Field label="Add a note" value={draft} onChangeText={setDraft} multiline rows={3} placeholder="Add a note about this project…" />
              <Button title={saving ? 'Saving' : 'Add note'} size="sm" loading={saving} disabled={!draft.trim()} onPress={addNote} style={{ alignSelf: 'flex-start', marginVertical: SPACE.sm }} accessibilityLabel="Add note" />
              {notes.loading ? <Meta>Loading notes…</Meta> : notes.error ? <Meta>{notes.error}</Meta> : notes.list.length ? notes.list.map((n) => (
                <Tile key={n.id}>
                  <Row><Title style={{ flex: 1 }}>{n.name}</Title><Meta>{shortDate(n.updatedAt)}</Meta></Row>
                  <Text style={[type.small, { color: colors.textSecondary }]}>{n.body}</Text>
                </Tile>
              )) : <Empty icon="document-text-outline" text="No notes yet. Add the first one above." />}
            </View>
          ) : null}
          {tab === 'activity' ? (
            events.length ? events.map((e) => (
              <Tile key={e.id}>
                <Row><Title style={{ flex: 1 }}>{String(e.action).replace(/[._]/g, ' ')}</Title><Meta>{relativeTime(e.createdAt)}</Meta></Row>
                <Meta>{String(e.entityType).replace('agency_', '')} · actor {e.actorId ?? 'system'}</Meta>
              </Tile>
            )) : <Empty icon="time-outline" text="No recorded activity for this project yet." />
          ) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}
