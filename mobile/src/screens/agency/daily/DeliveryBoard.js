/**
 * Projects & tasks — the delivery half of "Operations command" (web
 * `renderDeliveryBoard`): project/search/unowned/closed filters, the
 * autonomy-queue strip (drag on web → select + Send here), the routing-engine
 * dry run with its armed "Auto-route the backlog", the bulk bar, and the six
 * delivery columns as a stage strip.
 */

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, Chip, Button, Tabs, Field, useUIKit, SPACE, RADIUS, HIT, a11yPress } from '../../../ui-kit';
import * as M from './daily-model';
import { Panel, Note, PanelEmpty, OptionSheet, SelectField } from './parts';

function Checkbox({ checked, disabled, onPress, label }) {
  const { colors } = useUIKit();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      hitSlop={HIT.slop}
      style={styles.check}
      {...a11yPress({ label, role: 'checkbox', selected: checked, disabled })}
    >
      <Ionicons
        name={checked ? 'checkbox' : 'square-outline'}
        size={22}
        color={disabled ? colors.textTertiary : checked ? colors.primary : colors.textMuted}
      />
    </Pressable>
  );
}

function TaskCard({ task, state, actions, projectName, owner }) {
  const { colors, type } = useUIKit();
  const selected = state.selectedTaskIds.has(task.id);
  const sendable = M.HANDOFF_ELIGIBLE_STATUSES.has(task.status);
  return (
    <Card
      padded={false}
      depth={1}
      tint={selected ? 'primary' : undefined}
      style={styles.card}
    >
      <View style={styles.head}>
        <Checkbox
          checked={selected}
          disabled={!sendable}
          onPress={() => actions.toggleSelected(task.id)}
          label={`Select ${task.title} for a batch handoff`}
        />
        <Pressable
          onPress={() => actions.openTaskDetail(task.id)}
          style={({ pressed }) => [styles.titleTap, pressed && { opacity: 0.7 }]}
          {...a11yPress({
            label: `${task.title}. ${projectName}. Status ${M.humanStatus(task.status)}. ${
              owner ? `Owned by ${owner}` : 'No owner'
            }. Open for full details.`,
            role: 'button',
          })}
        >
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={3}>
            {task.title}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
      </View>
      <View style={styles.chips}>
        <Chip size="sm" label={task.priority} tone={M.priorityTone(task.priority)} />
        <Chip size="sm" label={owner ?? 'no owner'} tone={owner ? 'primary' : 'warning'} />
      </View>
      <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={2}>
        {projectName} · {M.dueLabel(task.dueAt)}
      </Text>
      {sendable ? (
        <Button
          size="sm"
          variant="outline"
          icon="paper-plane-outline"
          title="Send to autonomy…"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => actions.openHandoff([task.id])}
          accessibilityLabel={`Send ${task.title} to autonomy — opens a confirmation naming the employee and what it will do`}
        />
      ) : null}
    </Card>
  );
}

function RoutingBar({ state, actions }) {
  const { colors, type } = useUIKit();
  const routing = state.routing;
  if (routing.status === 'unavailable') return null;
  const counts = routing.counts;
  const canApply = state.methods.apply !== false && routing.status === 'ready';
  const assigned = counts?.assigned ?? 0;
  const copy =
    routing.status === 'loading' || routing.status === 'idle'
      ? 'Working out what it would assign…'
      : routing.status === 'failed'
        ? `Dry run failed — ${routing.error}. Hand work over manually below; nothing is blocked.`
        : `Dry run over the backlog: ${assigned} of ${counts?.candidates ?? 0} candidate tasks would be assigned, ${
            counts?.needsHuman ?? 0
          } flagged for a human.${routing.enabled === false ? ' The engine is switched OFF.' : ''} Nothing written.`;
  return (
    <Note tone={routing.status === 'failed' ? 'danger' : 'info'} icon="git-network-outline" title="Routing engine">
      <Text style={[type.small, { color: colors.textSecondary }]}>{copy}</Text>
      <View style={styles.rowWrap}>
        {routing.status === 'ready' || routing.status === 'failed' ? (
          <Button
            size="sm"
            variant="ghost"
            icon="refresh"
            title="Re-run"
            onPress={() => actions.loadRoutingPreview()}
            accessibilityLabel="Re-run the routing dry run"
          />
        ) : null}
        {canApply && !state.applyArmed ? (
          <Button
            size="sm"
            variant="outline"
            title="Auto-route the backlog…"
            disabled={assigned === 0}
            onPress={() => actions.setApplyArmed(true)}
            accessibilityLabel="Apply the routing engine across the whole agency"
          />
        ) : null}
      </View>
      {canApply && state.applyArmed ? (
        <View style={{ gap: SPACE.sm }}>
          <Text style={[type.smallStrong, { color: colors.text }]}>
            Assign {assigned} tasks across the agency for real?
          </Text>
          <View style={styles.rowWrap}>
            <Button size="sm" variant="ghost" title="Cancel" onPress={() => actions.setApplyArmed(false)} />
            <Button
              size="sm"
              variant="primary"
              title={state.applying ? 'Routing…' : 'Yes, route them'}
              loading={state.applying}
              onPress={() => actions.applyRouting()}
              accessibilityLabel="Confirm — run the routing engine across the agency"
            />
          </View>
        </View>
      ) : null}
    </Note>
  );
}

export function DeliveryBoard({ state, actions }) {
  const { colors, type } = useUIKit();
  const filters = {
    search: state.search,
    showDone: state.showDone,
    unassignedOnly: state.unassignedOnly,
    projectFilter: state.projectFilter,
  };
  const shown = useMemo(
    () => M.visibleTasks(state.tasks, filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.tasks, state.search, state.showDone, state.unassignedOnly, state.projectFilter, state.lastLoadedAt, state.notice],
  );
  const projectNames = useMemo(() => new Map(state.projects.map((p) => [p.id, p.name])), [state.projects]);
  const employeeNames = useMemo(() => new Map(state.employees.map((e) => [e.id, e.name])), [state.employees]);
  const byStatus = useMemo(() => {
    const out = {};
    for (const t of shown) (out[t.status] = out[t.status] || []).push(t);
    return out;
  }, [shown]);
  const columns = M.DELIVERY_COLUMNS.filter((c) => c.key !== 'done' || state.showDone);
  const firstNonEmpty = columns.find((c) => (byStatus[c.key] || []).length)?.key || columns[0].key;
  const [picked, setPicked] = useState(null);
  const column = picked && columns.some((c) => c.key === picked) ? picked : firstNonEmpty;
  const colDef = columns.find((c) => c.key === column) || columns[0];
  const items = byStatus[column] || [];
  const visible = items.slice(0, M.DELIVERY_COLUMN_CAP);
  const selectable = items.filter((t) => M.HANDOFF_ELIGIBLE_STATUSES.has(t.status));
  const count = state.selectedTaskIds.size;
  const [projectSheet, setProjectSheet] = useState(false);
  const sortedProjects = useMemo(
    () => [...state.projects].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [state.projects],
  );
  const filtered = M.deliveryFiltered(state.tasks, filters);

  return (
    <Panel
      title="Projects & tasks"
      count={`${shown.length} shown of ${state.tasks.length}${
        state.projectFilter ? ` · ${projectNames.get(state.projectFilter) ?? 'project'}` : ''
      }`}
    >
      {state.projectFilter ? (
        <Button
          size="sm"
          variant="outline"
          icon="layers-outline"
          title="Send whole project…"
          onPress={() =>
            actions.openHandoff(
              shown.map((t) => t.id),
              { projectId: state.projectFilter, projectName: projectNames.get(state.projectFilter) ?? null },
            )
          }
          accessibilityLabel="Hand every visible task in this project to autonomy"
        />
      ) : null}
      <SelectField
        label="Project"
        valueLabel={
          state.projectFilter
            ? projectNames.get(state.projectFilter) ?? 'Project'
            : `All projects (${state.projects.length})`
        }
        onPress={() => setProjectSheet(true)}
      />
      <Field
        label="Search"
        icon="search"
        value={state.search}
        onChangeText={(v) => actions.setFilter({ search: v })}
        placeholder="Filter by task title"
        returnKeyType="search"
      />
      <View style={styles.rowWrap}>
        <Chip
          label="Unowned only"
          icon="person-remove-outline"
          tone="primary"
          selected={state.unassignedOnly}
          onPress={() => actions.setFilter({ unassignedOnly: !state.unassignedOnly })}
          accessibilityLabel="Show only tasks with no owner"
        />
        <Chip
          label="Show closed"
          icon="archive-outline"
          tone="primary"
          selected={state.showDone}
          onPress={() => actions.setFilter({ showDone: !state.showDone })}
          accessibilityLabel="Include completed and cancelled tasks"
        />
      </View>

      <Note tone="primary" icon="git-merge-outline" title="Autonomy queue.">
        <Text style={[type.small, { color: colors.textSecondary }]}>
          Tick delivery cards and send them to an AI employee — or use Send to autonomy on any card. Nothing runs
          until you authorise it.
        </Text>
        <View style={styles.rowWrap}>
          <Button
            size="sm"
            variant="outline"
            disabled={count === 0}
            title={count === 0 ? 'Select tasks to send' : `Send ${Math.min(count, M.MAX_BATCH)}…`}
            onPress={() => actions.openHandoff([...state.selectedTaskIds])}
            accessibilityLabel={
              count === 0 ? 'Select tasks first to hand a batch to autonomy' : `Hand the ${count} selected tasks to autonomy`
            }
          />
        </View>
      </Note>

      <RoutingBar state={state} actions={actions} />

      {count > 0 ? (
        <Note tone="primary" icon="checkbox-outline" title={`${count} selected`}>
          <Text style={[type.small, { color: colors.textSecondary }]}>
            {count > M.MAX_BATCH
              ? `Batches are capped at ${M.MAX_BATCH} — the first ${M.MAX_BATCH} go in this pass.`
              : 'Sending creates one work item per task and records the owner on the delivery task.'}
          </Text>
          <View style={styles.rowWrap}>
            <Button
              size="sm"
              variant="ghost"
              title="Select all shown"
              onPress={() =>
                actions.setSelected(
                  shown.filter((t) => M.HANDOFF_ELIGIBLE_STATUSES.has(t.status)).map((t) => t.id),
                  true,
                )
              }
            />
            <Button size="sm" variant="ghost" title="Clear" onPress={() => actions.clearSelection()} />
            <Button
              size="sm"
              variant="primary"
              icon="paper-plane"
              title={`Send ${Math.min(count, M.MAX_BATCH)} to autonomy…`}
              onPress={() => actions.openHandoff([...state.selectedTaskIds])}
            />
          </View>
        </Note>
      ) : null}

      {shown.length === 0 ? (
        <PanelEmpty
          icon={filtered ? 'filter-outline' : 'file-tray-outline'}
          title={filtered ? 'No tasks match these filters' : 'No delivery tasks'}
          message={
            filtered
              ? `${state.tasks.length} tasks exist — the project, search and "unowned only" filters are hiding all of them.`
              : state.kanbanLoaded
                ? 'This agency has no project tasks yet. Create a project and its tasks in Agency Operations and they appear here.'
                : 'The project database did not answer — see the failure list above.'
          }
          actionLabel={filtered ? 'Clear filters' : undefined}
          onAction={
            filtered ? () => actions.setFilter({ projectFilter: '', search: '', unassignedOnly: false }) : undefined
          }
        />
      ) : (
        <>
          <Tabs
            tabs={columns.map((c) => ({ key: c.key, label: c.label, count: (byStatus[c.key] || []).length }))}
            active={column}
            onSelect={setPicked}
          />
          <View style={[styles.colHint, { borderColor: colors.borderSubtle || colors.border }]}>
            <Text style={[type.label, { color: colors.textSecondary }]}>
              {colDef.label} · {items.length}
            </Text>
            <Text style={[type.caption, { color: colors.textMuted }]}>{colDef.hint}</Text>
          </View>
          {selectable.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              icon="checkmark-done"
              title={`Select ${selectable.length}`}
              onPress={() =>
                actions.setSelected(
                  selectable.map((t) => t.id),
                  true,
                )
              }
              accessibilityLabel={`Select all ${selectable.length} tasks in ${colDef.label}`}
            />
          ) : null}
          {visible.length === 0 ? (
            <Text style={[type.caption, styles.colEmpty, { color: colors.textMuted }]}>NONE IN THIS FILTER</Text>
          ) : (
            <View style={{ gap: SPACE.sm }}>
              {visible.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  state={state}
                  actions={actions}
                  projectName={projectNames.get(task.projectId) ?? 'Unlinked project'}
                  owner={task.assigneeId ? employeeNames.get(task.assigneeId) ?? task.assigneeId : null}
                />
              ))}
              {items.length > visible.length ? (
                <Text style={[type.caption, styles.colEmpty, { color: colors.textMuted }]}>
                  +{items.length - visible.length} more — narrow the filter
                </Text>
              ) : null}
            </View>
          )}
        </>
      )}

      <OptionSheet
        visible={projectSheet}
        onClose={() => setProjectSheet(false)}
        title="Filter by project"
        value={state.projectFilter}
        options={[
          { key: '', label: `All projects (${state.projects.length})`, icon: 'apps-outline' },
          ...sortedProjects.map((p) => ({ key: p.id, label: p.name, icon: 'folder-outline' })),
        ]}
        onSelect={(key) => {
          setProjectSheet(false);
          actions.setFilter({ projectFilter: key });
        }}
      />
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: { padding: SPACE.md, gap: SPACE.xs },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  titleTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 44 },
  check: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, alignItems: 'center' },
  colHint: { borderLeftWidth: 2, paddingLeft: SPACE.sm, gap: 2, borderRadius: RADIUS.sm },
  colEmpty: { textAlign: 'center', paddingVertical: SPACE.lg, letterSpacing: 1.2 },
});
