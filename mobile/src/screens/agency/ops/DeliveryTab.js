/**
 * Projects & tasks — web renderDeliveryOperations + renderTaskBoard: KPIs,
 * client scope, List (project cards with start/complete, edit, open tasks,
 * per-task assign + start/done) and Board (status columns, project filter,
 * per-card assignee + status — the touch replacement for drag-and-drop).
 */
import React, { useMemo, useState } from 'react';
import { View, Text, ScrollView, useWindowDimensions } from 'react-native';
import { Button, Chip, PriorityChip, ProgressBar, SegmentedControl, SPACE, StatusChip, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import {
  TASK_BOARD_STATUSES,
  boardColumns,
  deliveryKpis,
  humanize,
  projectRoll,
  scopedProjects,
  shortDate,
  tasksByProject,
} from './agency-ops-model';
import { Actions, ActionButton, Empty, KpiGrid, Meta, MoreButton, Notice, Panel, Row, SelectField, Tile, Title } from './ui';

export function assigneeOptions(employees) {
  return [['', 'Unassigned'], ...employees.map((e) => [e.id, `${e.name} · ${e.kind === 'ai' ? 'AI' : 'Human'}`])];
}

export function TaskControls({ ctx, task }) {
  const { ops } = ctx;
  const employees = ops.state.employees;
  return (
    <View style={{ gap: SPACE.xs }}>
      <SelectField
        label="Assignee"
        value={task.assigneeId ?? ''}
        options={assigneeOptions(employees)}
        onChange={(id) => ctx.assignTask(task.id, employees.find((e) => e.id === id) ?? null)}
        compact
      />
      <SelectField
        label="Status"
        value={task.status}
        options={TASK_BOARD_STATUSES}
        onChange={(st) => ctx.transitionTask(task.id, st)}
        compact
      />
    </View>
  );
}

export function DeliveryTab({ ctx }) {
  const { ops, delivery, setDelivery } = ctx;
  const s = ops.state;
  const k = deliveryKpis(s);
  const clientNames = useMemo(() => new Map(s.clients.map((c) => [c.id, c.name])), [s.clients]);
  const scoped = scopedProjects(s.projects, delivery.clientFilter);
  return (
    <View>
      <Panel
        eyebrow="Delivery operations"
        title="Projects and execution"
        subtitle="Agency-scoped work with visible ownership, state, client context and next actions."
      >
        <SegmentedControl
          options={[{ key: 'list', label: 'List' }, { key: 'board', label: 'Board' }]}
          value={delivery.view}
          onChange={(view) => setDelivery((d) => ({ ...d, view }))}
          style={{ marginBottom: SPACE.sm }}
          testID="aops-delivery-view"
        />
        <Actions>
          <Button title="+ Task" size="sm" variant="secondary" onPress={() => ctx.openDialog('task', { entityId: delivery.projectFilter || undefined })} accessibilityLabel="Create task" />
          <Button title="+ Project" size="sm" onPress={() => ctx.openDialog('project', { entityId: delivery.clientFilter || undefined })} accessibilityLabel="Create project" />
        </Actions>
      </Panel>
      <KpiGrid
        items={[
          { label: 'Projects', value: String(k.projects), context: `${k.activeProjects} active` },
          { label: 'Open tasks', value: String(k.open), context: `${k.done} complete` },
          { label: 'Blocked', value: String(k.blocked), context: k.blocked ? 'Operator attention required' : 'Delivery flowing', tone: k.blocked ? 'danger' : 'primary' },
          { label: 'AI-assigned', value: String(k.aiAssigned), context: 'Visible agent workload' },
        ]}
      />
      {delivery.clientFilter ? (
        <Notice tone="success" text={`Scoped to ${clientNames.get(delivery.clientFilter) ?? 'one client'} · ${scoped.length} project${scoped.length === 1 ? '' : 's'}.`}>
          <Button title="Show all projects" size="sm" variant="ghost" onPress={() => setDelivery((d) => ({ ...d, clientFilter: '' }))} accessibilityLabel="Clear the client scope and show every project" />
        </Notice>
      ) : null}
      {delivery.view === 'board' ? <TaskBoard ctx={ctx} /> : <ProjectList ctx={ctx} projects={scoped} clientNames={clientNames} />}
    </View>
  );
}

function ProjectList({ ctx, projects, clientNames }) {
  const { ops } = ctx;
  const byProject = useMemo(() => tasksByProject(ops.state.tasks), [ops.state.tasks]);
  const [limit, setLimit] = useState(12);
  if (!projects.length) return <Empty icon="albums-outline" text="No agency projects yet. Create the first project." actionLabel="+ Project" onAction={() => ctx.openDialog('project')} />;
  return (
    <View>
      {projects.slice(0, limit).map((p) => <ProjectCard key={p.id} ctx={ctx} project={p} tasks={byProject.get(p.id) ?? []} clientName={p.clientId ? clientNames.get(p.clientId) : null} />)}
      <MoreButton shown={Math.min(limit, projects.length)} total={projects.length} onPress={() => setLimit((l) => l + 12)} noun="projects" />
    </View>
  );
}

function ProjectCard({ ctx, project, tasks, clientName }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const roll = projectRoll(tasks);
  return (
    <Panel>
      <Row>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text onPress={() => ctx.openProject(project.id)} accessibilityRole="link" style={[type.h3, { color: colors.text }]} numberOfLines={2}>{project.name}</Text>
          {project.clientId ? (
            <Text onPress={() => ctx.focusClientProjects(project.clientId)} accessibilityRole="link" style={[type.caption, { color: colors.primary }]}>{clientName ?? 'Linked client'}</Text>
          ) : <Meta>No client linked{project.mirrored ? ' · from the kanban board' : ''}</Meta>}
        </View>
        <StatusChip status={project.status} label={humanize(project.status)} size="sm" />
      </Row>
      <ProgressBar value={roll.pct / 100} style={{ marginVertical: SPACE.sm }} />
      <Meta>{roll.done}/{roll.total} tasks complete · {project.targetEndAt ? shortDate(project.targetEndAt) : 'No deadline'}</Meta>
      <Actions>
        <ActionButton title="Open" icon="open-outline" onPress={() => ctx.openProject(project.id)} accessibilityLabel={`Open the dedicated page for ${project.name}`} />
        {!project.mirrored ? <ActionButton title="Edit" onPress={() => ctx.openDialog('project-edit', { entityId: project.id })} accessibilityLabel={`Edit project ${project.name}`} /> : null}
        {project.status === 'planned' ? <ActionButton title="Start" loading={ops.busy === project.id} onPress={() => ctx.transitionProject(project.id, 'active')} accessibilityLabel={`Start ${project.name}`} /> : null}
        {project.status === 'active' && roll.active.length === 0 && !project.mirrored ? <ActionButton title="Complete" loading={ops.busy === project.id} onPress={() => ctx.transitionProject(project.id, 'completed')} accessibilityLabel={`Complete ${project.name}`} /> : null}
      </Actions>
      <View style={{ marginTop: SPACE.sm }}>
        {roll.active.length ? roll.active.slice(0, 4).map((t) => (
          <Tile key={t.id}>
            <Title>{t.title}</Title>
            <Meta>{t.assigneeType ?? 'unassigned'} · {t.priority}</Meta>
            <Row>
              <View style={{ flex: 1 }}>
                <SelectField value={t.assigneeId ?? ''} options={assigneeOptions(ops.state.employees)} onChange={(id) => ctx.assignTask(t.id, ops.state.employees.find((e) => e.id === id) ?? null)} compact />
              </View>
              <ActionButton
                title={t.status === 'in_progress' ? 'Done' : 'Start'}
                loading={ops.busy === t.id}
                onPress={() => ctx.transitionTask(t.id, t.status === 'in_progress' ? 'done' : 'in_progress')}
                accessibilityLabel={`${t.status === 'in_progress' ? 'Complete' : 'Start'} task ${t.title}`}
              />
            </Row>
          </Tile>
        )) : <Meta>No open tasks.</Meta>}
        {roll.active.length > 4 ? (
          <Button title={`+${roll.active.length - 4} more open tasks`} size="sm" variant="ghost" onPress={() => ctx.focusProjectTasks(project.id)} accessibilityLabel={`Open the board with all open tasks for ${project.name}`} />
        ) : null}
      </View>
    </Panel>
  );
}

function TaskBoard({ ctx }) {
  const { ops, delivery, setDelivery } = ctx;
  const { colors, type } = useUIKit();
  const { width } = useWindowDimensions();
  const s = ops.state;
  const projectNames = useMemo(() => new Map(s.projects.map((p) => [p.id, p.name])), [s.projects]);
  const employeeById = useMemo(() => new Map(s.employees.map((e) => [e.id, e])), [s.employees]);
  const cols = boardColumns(s, { projectFilter: delivery.projectFilter, clientFilter: delivery.clientFilter });
  const colWidth = Math.min(320, Math.max(260, width * 0.78));
  const [limits, setLimits] = useState({});
  return (
    <View>
      <SelectField
        label="Project"
        value={delivery.projectFilter}
        options={[['', 'All projects'], ...s.projects.map((p) => [p.id, p.name])]}
        onChange={(v) => setDelivery((d) => ({ ...d, projectFilter: v }))}
        searchable
      />
      <Meta style={{ marginBottom: SPACE.sm }}>Swipe across the columns. Change status or assignee from each card — the touch equivalent of dragging between columns or onto an employee.</Meta>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: SPACE.sm, paddingBottom: SPACE.sm }} testID="aops-task-board">
        {cols.map((col) => {
          const limit = limits[col.key] ?? 15;
          return (
            <View key={col.key} style={{ width: colWidth, borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: 16, padding: SPACE.sm, backgroundColor: withAlpha(colors.text, 0.03) }}>
              <Row style={{ marginBottom: SPACE.sm }}>
                <Text style={[type.label, { color: colors.textSecondary, flex: 1 }]}>{col.label}</Text>
                <Chip label={String(col.tasks.length)} size="sm" />
              </Row>
              {col.tasks.length ? col.tasks.slice(0, limit).map((t) => {
                const assignee = t.assigneeId ? employeeById.get(t.assigneeId) : null;
                return (
                  <Tile key={t.id}>
                    <Title>{t.title}</Title>
                    <Row wrap>
                      <Meta style={{ flexShrink: 1 }} numberOfLines={1}>{projectNames.get(t.projectId) ?? 'Unlinked'}</Meta>
                      {t.priority ? <PriorityChip priority={t.priority} size="sm" /> : null}
                    </Row>
                    <Row>
                      <Chip size="sm" label={assignee ? assignee.name : (t.assigneeType ?? 'Unassigned')} tone={assignee?.kind === 'ai' ? 'info' : 'neutral'} />
                      {t.dueAt ? <Meta>{shortDate(t.dueAt)}</Meta> : null}
                    </Row>
                    <TaskControls ctx={ctx} task={t} />
                    <ActionButton title="Edit" onPress={() => ctx.openDialog('task-edit', { entityId: t.id })} accessibilityLabel={`Edit task ${t.title}`} />
                  </Tile>
                );
              }) : <Meta style={{ padding: SPACE.sm }}>No tasks here.</Meta>}
              <MoreButton shown={Math.min(limit, col.tasks.length)} total={col.tasks.length} onPress={() => setLimits((l) => ({ ...l, [col.key]: limit + 15 }))} noun="tasks" />
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
