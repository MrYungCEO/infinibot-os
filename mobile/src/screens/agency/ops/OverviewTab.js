/**
 * Command center — web renderAgencyOperations overview: KPIs, active projects
 * (kanban "Active" set, grouped by client, with status + task controls),
 * financial command, revenue pipeline links, employee roster, decision queue
 * and the operating cadence.
 */
import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { Button, Chip, ProgressBar, SegmentedControl, SPACE, useUIKit } from '../../../ui-kit';
import {
  KANBAN_PROJECT_STATUS_OPTIONS,
  KANBAN_TASK_STATUS_OPTIONS,
  activeKanbanCount,
  activeProjectGroups,
  allocationPct,
  allocationTone,
  decisionQueue,
  filterEmployees,
  kanbanProjectRoll,
  money,
  overviewKpis,
  relativeTime,
  taskStatusMeta,
} from './agency-ops-model';
import { Actions, ActionButton, Avatar, Empty, KpiGrid, Meta, MoreButton, Notice, Panel, Row, SelectField, StatPairs, Tile, Title, toneOf } from './ui';

export function OverviewTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const f = s.finance;
  const currency = f.currency;
  return (
    <View>
      <KpiGrid items={overviewKpis(s)} testID="aops-kpis" />
      <Panel title="Active projects" count={`${activeKanbanCount(s)} in progress`}>
        <ActiveProjects ctx={ctx} />
      </Panel>
      <Panel
        title="Financial command"
        subtitle="This month"
        right={null}
      >
        <Actions style={{ marginBottom: SPACE.sm }}>
          <Button title="Create invoice" icon="add" size="sm" onPress={() => ctx.openInvoiceComposer({})} accessibilityLabel="Create invoice" />
          <Button title="Log money" icon="time-outline" size="sm" variant="secondary" onPress={() => ctx.openInvoiceComposer({ backdated: true })} accessibilityLabel="Log money received on a past invoice" />
          <Button title="Revenue snapshot" size="sm" variant="secondary" onPress={() => ctx.setSection('finance')} accessibilityLabel="Open revenue snapshot" />
        </Actions>
        <StatPairs
          cols={2}
          pairs={[
            { label: 'Revenue (mo)', value: money(f.revenueMonth, currency) },
            { label: 'Cash collected', value: money(f.cashCollectedMonth, currency) },
            { label: 'Outstanding', value: money(f.outstandingReceivables, currency), tone: f.outstandingReceivables > 0 ? 'warning' : undefined },
            { label: 'Overdue', value: money(f.overdueReceivables, currency), tone: f.overdueReceivables > 0 ? 'danger' : undefined },
          ]}
        />
        <StatPairs
          pairs={[
            { label: 'MRR', value: money(f.mrr, currency) },
            { label: 'ARR', value: money(f.arr, currency) },
            { label: 'Target', value: money(f.revenueTarget, currency) },
            { label: 'Backlog', value: money(f.contractedBacklog, currency) },
            { label: 'Gross margin', value: `${f.grossMarginPercent ?? 0}%` },
            { label: 'Payroll', value: money(f.payrollMonth, currency) },
            { label: 'AI spend', value: money(f.aiSpendMonth, currency) },
            { label: 'Runway', value: f.cashRunwayMonths === undefined || f.cashRunwayMonths === null ? '—' : `${f.cashRunwayMonths} mo` },
          ]}
        />
      </Panel>
      <Panel title="Revenue pipeline" subtitle="One shared source">
        <Tile>
          <Title>Pipeline lives in Business hub</Title>
          <Meta>{s.pipelineDeals.length} opportunities are managed in the canonical pipeline — no second board or duplicate store here.</Meta>
          <Actions>
            <Button title="Open pipeline" size="sm" variant="secondary" onPress={() => ctx.openHub('pipeline')} accessibilityLabel="Open pipeline in Business hub" />
            <Button title="+ Opportunity" size="sm" variant="ghost" onPress={() => ctx.openDialog('deal')} accessibilityLabel="Create pipeline opportunity" />
          </Actions>
        </Tile>
        <Tile>
          <Title>Revenue analytics lives in Business hub</Title>
          <Meta>Use the shared ledger for transactions, source attribution and customer revenue. Agency invoicing stays here.</Meta>
          <Actions>
            <Button title="Open revenue" size="sm" variant="secondary" onPress={() => ctx.openHub('revenue')} accessibilityLabel="Open revenue in Business hub" />
            <Button title="+ Engagement" size="sm" variant="ghost" onPress={() => ctx.openDialog('engagement')} accessibilityLabel="Start engagement" />
          </Actions>
        </Tile>
      </Panel>
      <RosterPanel ctx={ctx} />
      <DecisionQueuePanel ctx={ctx} />
      <Panel title="Operating cadence">
        <Tile><Title>Daily</Title><Meta>Clear approvals · unblock delivery · assign capacity</Meta></Tile>
        <Tile><Title>Weekly</Title><Meta>Pipeline review · engagement health · utilization · cash collection</Meta></Tile>
        <Tile><Title>Monthly</Title><Meta>P&amp;L · margins by client · performance reviews · capacity plan</Meta></Tile>
      </Panel>
    </View>
  );
}

function ActiveProjects({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const groups = activeProjectGroups(s);
  if (!groups.length) return <Empty icon="albums-outline" text="No in-progress projects. Move a project to an active status to see it here." />;
  return groups.map((g) => (
    <View key={g.key} style={{ marginBottom: SPACE.sm }}>
      <Row style={{ marginBottom: SPACE.xs }}>
        <View style={{ flex: 1 }}>
          <Title>{g.name}</Title>
          <Meta>{g.projects.length} in-progress project{g.projects.length === 1 ? '' : 's'}</Meta>
        </View>
        {g.clientId ? <Button title="Open client" size="sm" variant="ghost" onPress={() => ctx.focusClientProjects(g.clientId)} accessibilityLabel={`Open client ${g.name}`} /> : null}
      </Row>
      {g.projects.map((p) => <ActiveProjectCard key={p.id} ctx={ctx} project={p} />)}
    </View>
  ));
}

function ActiveProjectCard({ ctx, project }) {
  const { ops } = ctx;
  const { colors } = useUIKit();
  const roll = kanbanProjectRoll(ops.state.kanbanTasks, project.id);
  const [showAll, setShowAll] = useState(false);
  const open = showAll ? roll.open : roll.open.slice(0, 6);
  const busy = ops.busy === project.id;
  return (
    <Tile
      accent={colors.info}
      onPress={project.agencyProjectId ? () => ctx.openProject(project.agencyProjectId) : undefined}
      accessibilityLabel={`Open project ${project.name}`}
    >
      <Row>
        <Text style={{ flex: 1, color: colors.text, fontWeight: '600', fontSize: 14 }} numberOfLines={2}>{project.name}</Text>
        <Chip label="In progress" tone="info" size="sm" dot />
      </Row>
      <Meta>{roll.pct}% complete · {roll.done}/{roll.total} tasks done{roll.inProgress ? ` · ${roll.inProgress} active` : ''}</Meta>
      <ProgressBar value={roll.pct / 100} tone="info" />
      <SelectField
        label="Project status"
        value={project.status}
        options={KANBAN_PROJECT_STATUS_OPTIONS}
        onChange={(v) => ctx.setKanbanProjectStatus(project.id, v)}
        compact
      />
      <Actions>
        <ActionButton title={busy ? 'Saving' : 'Mark complete'} loading={busy} disabled={project.status === 'Completed'} onPress={() => ctx.setKanbanProjectStatus(project.id, 'Completed')} accessibilityLabel={`Mark project ${project.name} complete`} />
      </Actions>
      {open.map((t) => {
        const meta = taskStatusMeta(t.status);
        return (
          <View key={t.id} style={{ borderLeftWidth: 2, borderLeftColor: toneOf(meta.tone, colors), paddingLeft: SPACE.sm, gap: 4, marginTop: SPACE.xs }}>
            <Text style={{ color: colors.text, fontSize: 13 }} numberOfLines={2}>{t.title}</Text>
            <Row>
              <View style={{ flex: 1 }}>
                <SelectField value={t.status} options={KANBAN_TASK_STATUS_OPTIONS} onChange={(v) => ctx.setKanbanTaskStatus(t.id, v)} compact />
              </View>
              <ActionButton title="Done" loading={ops.busy === t.id} onPress={() => ctx.setKanbanTaskStatus(t.id, 'done')} accessibilityLabel={`Mark task ${t.title} done`} />
            </Row>
          </View>
        );
      })}
      {roll.open.length > 6 ? (
        <Button title={showAll ? 'Show fewer' : `+${roll.open.length - 6} more open`} size="sm" variant="ghost" onPress={() => setShowAll((v) => !v)} accessibilityLabel="Toggle all open tasks" />
      ) : null}
    </Tile>
  );
}

export function EmployeeCard({ ctx, employee }) {
  const { colors, type } = useUIKit();
  const pct = allocationPct(employee);
  const tone = allocationTone(pct);
  const isAi = employee.kind === 'ai';
  const level = typeof employee.autonomyLevel === 'number' ? employee.autonomyLevel : null;
  return (
    <Tile onPress={() => ctx.openEmployee(employee.id)} accessibilityLabel={`Open ${employee.name}`}>
      <Row>
        <Avatar name={employee.name} ai={isAi} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Row>
            <Text style={[type.bodyStrong, { color: colors.text, flexShrink: 1 }]} numberOfLines={1}>{employee.name}</Text>
            <Chip label={isAi ? 'AI' : 'Human'} size="sm" tone={isAi ? 'info' : 'primary'} />
          </Row>
          <Meta numberOfLines={1}>{employee.role || 'No role set'}{employee.department ? ` · ${employee.department}` : ''}</Meta>
        </View>
        {level !== null ? <Chip label={`L${level}`} size="sm" tone={level >= 3 ? 'danger' : level === 2 ? 'warning' : 'neutral'} /> : null}
      </Row>
      <ProgressBar value={Math.min(1, pct / 100)} tone={tone} />
      <Row>
        <Meta style={{ flex: 1 }} mono>{employee.allocatedHours}/{employee.capacityHours}h allocated</Meta>
        <Meta mono style={{ color: toneOf(tone, colors) }}>{employee.utilizationPercent ?? pct}% utilised</Meta>
      </Row>
      <Meta>{employee.activeWork ?? 0} active work · {employee.availability ?? 'available'}{employee.modelBinding || employee.model ? ` · runs on ${employee.modelBinding || employee.model}` : ''}</Meta>
      <Actions>
        <ActionButton title="Profile" onPress={() => ctx.openEmployee(employee.id)} accessibilityLabel={`Open profile of ${employee.name}`} />
        <ActionButton title="Customise" onPress={() => ctx.openEmployeeEditor(employee.id)} accessibilityLabel={`Customise ${employee.name}`} />
        <ActionButton title="Assign work" onPress={() => ctx.openDialog('employee-work-item', { entityId: employee.id })} accessibilityLabel={`Assign work to ${employee.name}`} />
      </Actions>
    </Tile>
  );
}

function RosterPanel({ ctx }) {
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(8);
  const list = filterEmployees(ctx.ops.state.employees, { filter });
  return (
    <Panel title="Employee roster & capacity" count={ctx.ops.state.employees.length}>
      <SegmentedControl
        size="sm"
        options={[{ key: 'all', label: 'All' }, { key: 'ai', label: 'AI employees' }, { key: 'human', label: 'Humans' }]}
        value={filter}
        onChange={setFilter}
        style={{ marginBottom: SPACE.sm }}
      />
      {list.length ? list.slice(0, limit).map((e) => <EmployeeCard key={e.id} ctx={ctx} employee={e} />) : <Empty icon="people-outline" text="No employees match this filter." />}
      <MoreButton shown={Math.min(limit, list.length)} total={list.length} onPress={() => setLimit((l) => l + 8)} noun="employees" />
    </Panel>
  );
}

export function DecisionItem({ ctx, item, currency }) {
  const { ops } = ctx;
  const busy = ops.busy === item.id;
  const tone = item.risk === 'high' ? 'danger' : item.risk === 'low' ? 'success' : 'warning';
  return (
    <Tile>
      <Row>
        <Chip label={item.riskLabel || `${item.risk} risk`} tone={tone} size="sm" dot />
        <View style={{ flex: 1 }} />
        <Meta>{relativeTime(item.at)}</Meta>
      </Row>
      <Title>{item.title}</Title>
      <Meta numberOfLines={3}>{item.detail}</Meta>
      {item.amount ? <Meta mono>{money(item.amount, item.currency || currency)}</Meta> : null}
      <Actions>
        <ActionButton title={item.kind === 'work' ? 'Reject' : 'Decline'} variant="danger" disabled={busy} onPress={() => ctx.decide(item, false)} accessibilityLabel={`Decline ${item.title}`} />
        <ActionButton title={busy ? 'Working' : 'Approve'} variant="primary" loading={busy} onPress={() => ctx.decide(item, true)} accessibilityLabel={`Approve ${item.title}`} />
      </Actions>
    </Tile>
  );
}

function DecisionQueuePanel({ ctx }) {
  const s = ctx.ops.state;
  const items = decisionQueue(s);
  const [limit, setLimit] = useState(6);
  return (
    <Panel title="Decision queue" count={`${items.length} pending`} subtitle="Work paused for your call — client approvals and staged work items the operating loop queued but won't run until you authorize them.">
      {items.length
        ? items.slice(0, limit).map((i) => <DecisionItem key={`${i.kind}:${i.id}`} ctx={ctx} item={i} currency={s.finance.currency} />)
        : <Empty icon="checkmark-done-outline" text="All caught up — no work is waiting on your authorization." />}
      <MoreButton shown={Math.min(limit, items.length)} total={items.length} onPress={() => setLimit((l) => l + 10)} noun="decisions" />
    </Panel>
  );
}

export { Notice };
