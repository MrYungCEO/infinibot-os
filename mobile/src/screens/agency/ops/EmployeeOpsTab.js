/**
 * Employee ops — web renderEmployeeOperatingLoop: + Work item, Run operating
 * loop, summary strip, the durable inbox (advance each item through its
 * lifecycle), schedules (+ Schedule), recurring responsibilities
 * (+ Responsibility) and manager reviews (+ Review cycle, complete with outcome).
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Field, SegmentedControl, SPACE } from '../../../ui-kit';
import { employeeOpsSummary, firstLine, humanize, nextWorkItemStatus, relativeTime, shortDate, workerNameOf } from './agency-ops-model';
import { Actions, ActionButton, Empty, KpiGrid, Meta, MoreButton, Notice, Panel, Row, Tile, Title } from './ui';

const STATUS_FILTERS = [
  { key: 'open', label: 'Open' },
  { key: 'queued', label: 'Queued' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'all', label: 'All' },
];

export function EmployeeOpsTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const sum = employeeOpsSummary(s);
  const [lastRun, setLastRun] = useState(null);
  const [filter, setFilter] = useState('open');
  const [limit, setLimit] = useState(15);
  const [outcomes, setOutcomes] = useState({});
  const name = (id) => workerNameOf(s.employees, id);
  const items = s.workItems.filter((i) => (filter === 'all' ? true : filter === 'open' ? !['completed', 'cancelled'].includes(i.status) : i.status === filter));

  const runLoop = async () => {
    try {
      await ops.call('agency.ops.employee.loop.tick', { agencyId: s.selectedAgencyId }, { busyKey: 'employee-loop', reload: true });
      setLastRun(Date.now());
    } catch { /* recorded */ }
  };
  const completeReview = async (id) => {
    const outcome = String(outcomes[id] ?? '').trim();
    if (!outcome) return;
    try {
      const r = await ops.call('agency.ops.employee.review-cycle.complete', { agencyId: s.selectedAgencyId, reviewCycleId: id, outcome }, { busyKey: id });
      if (r?.reviewCycle) ops.mutateList('reviewCycles', id, r.reviewCycle); else ops.load({ background: true });
      setOutcomes(({ [id]: _drop, ...rest }) => rest);
    } catch { /* recorded */ }
  };

  return (
    <View>
      <Panel
        eyebrow="Employee operating loop"
        title="Inbox, schedules, responsibilities and reviews"
        subtitle="Durable operating rhythm for human and AI employees, with explicit lifecycle and SLA escalation."
      >
        <Actions>
          <Button title="+ Work item" size="sm" variant="secondary" onPress={() => ctx.openDialog('employee-work-item')} accessibilityLabel="Hand a work item to an employee" />
          <Button title="Run operating loop" size="sm" loading={ops.busy === 'employee-loop'} onPress={runLoop} accessibilityLabel="Run the employee operating loop now" />
        </Actions>
      </Panel>
      <KpiGrid items={[
        { label: 'Open inbox items', value: String(sum.open) },
        { label: 'SLA escalations', value: String(sum.escalated), tone: sum.escalated ? 'danger' : 'primary' },
        { label: 'Recurring duties', value: String(sum.duties) },
        { label: 'Reviews due', value: String(sum.reviewsDue), tone: sum.reviewsDue ? 'warning' : 'primary' },
      ]}
      />
      {lastRun ? <Notice tone="success" text={`Operating loop ran ${relativeTime(lastRun)}.`} /> : null}

      <Panel eyebrow="Durable employee inbox" title="Work items" count={`${s.workItems.length} total`}>
        <SegmentedControl size="sm" options={STATUS_FILTERS} value={filter} onChange={(f) => { setFilter(f); setLimit(15); }} style={{ marginBottom: SPACE.sm }} />
        {items.length ? items.slice(0, limit).map((i) => {
          const next = nextWorkItemStatus(i.status);
          return (
            <Tile key={i.id}>
              <Row>
                <Title style={{ flex: 1 }}>{i.title}</Title>
                <Chip size="sm" label={humanize(i.status)} tone={i.status === 'escalated' ? 'danger' : i.status === 'completed' ? 'success' : i.status === 'in_progress' ? 'info' : 'neutral'} />
              </Row>
              <Meta>{name(i.workerId)} · {i.priority} priority · updated {relativeTime(i.updatedAt)}</Meta>
              {i.instructions ? <Meta numberOfLines={3}>{firstLine(i.instructions, 240)}</Meta> : null}
              {i.dueAt ? <Meta>Due {shortDate(i.dueAt)}</Meta> : null}
              {i.waitingReason ? <Notice tone="warning" text={i.waitingReason} /> : null}
              <Actions>
                {next ? <ActionButton title={humanize(next)} loading={ops.busy === i.id} onPress={() => ctx.transitionWorkItem(i.id, next)} accessibilityLabel={`Move ${i.title} to ${humanize(next)}`} /> : null}
                {!['completed', 'cancelled'].includes(i.status) ? <ActionButton title="Cancel" confirm variant="danger" onPress={() => ctx.transitionWorkItem(i.id, 'cancelled')} accessibilityLabel={`Cancel ${i.title}`} /> : null}
              </Actions>
            </Tile>
          );
        }) : <Empty icon="file-tray-outline" text="No employee inbox items. Recurring responsibilities will generate work on the next loop run." />}
        <MoreButton shown={Math.min(limit, items.length)} total={items.length} onPress={() => setLimit((l) => l + 15)} noun="work items" />
      </Panel>

      <Panel title="Schedules" right={<ActionButton title="+ Schedule" onPress={() => ctx.openDialog('employee-schedule')} accessibilityLabel="Add a working schedule for an employee" />}>
        {s.schedules.length ? s.schedules.map((sc) => (
          <Row key={sc.id} style={{ marginBottom: SPACE.sm }}>
            <View style={{ flex: 1 }}><Title>{name(sc.workerId)}</Title><Meta>{sc.timezone} · {sc.shiftStart}–{sc.shiftEnd}</Meta></View>
            <Chip size="sm" label={sc.enabled ? 'active' : 'disabled'} tone={sc.enabled ? 'success' : 'neutral'} />
          </Row>
        )) : <Empty icon="calendar-outline" text="No employee schedules configured." />}
      </Panel>

      <Panel title="Recurring responsibilities" subtitle="Recurring duties are what generate inbox work on each loop run." right={<ActionButton title="+ Responsibility" variant="primary" onPress={() => ctx.openDialog('employee-responsibility')} accessibilityLabel="Add a recurring responsibility" />}>
        {s.responsibilities.length ? s.responsibilities.map((r) => (
          <Tile key={r.id}>
            <Row><Title style={{ flex: 1 }}>{r.title}</Title><Chip size="sm" label={r.cadence} tone="primary" /></Row>
            <Meta>{name(r.workerId)} · {r.runAt} · SLA {r.slaMinutes}m · next {shortDate(r.nextRunAt)}{r.enabled ? '' : ' · disabled'}</Meta>
          </Tile>
        )) : <Empty icon="repeat-outline" text="No recurring responsibilities configured." />}
      </Panel>

      <Panel title="Manager reviews" right={<ActionButton title="+ Review cycle" onPress={() => ctx.openDialog('employee-review')} accessibilityLabel="Schedule a manager review cycle" />}>
        {s.reviewCycles.length ? s.reviewCycles.map((r) => (
          <Tile key={r.id}>
            <Row><Title style={{ flex: 1 }}>{name(r.workerId)}</Title><Chip size="sm" label={r.status} tone={r.status === 'overdue' ? 'danger' : r.status === 'due' ? 'warning' : r.status === 'completed' ? 'success' : 'neutral'} /></Row>
            <Meta>Manager {name(r.managerWorkerId)} · {shortDate(r.nextReviewAt)}</Meta>
            {r.status !== 'completed' ? (
              <Row>
                <Field value={outcomes[r.id] ?? ''} onChangeText={(v) => setOutcomes((o) => ({ ...o, [r.id]: v }))} placeholder="Review outcome" style={{ flex: 1 }} accessibilityLabel={`Outcome for the review of ${name(r.workerId)}`} />
                <ActionButton title="Complete" loading={ops.busy === r.id} disabled={!String(outcomes[r.id] ?? '').trim()} onPress={() => completeReview(r.id)} accessibilityLabel="Complete review cycle" />
              </Row>
            ) : null}
          </Tile>
        )) : <Empty icon="ribbon-outline" text="No manager review cycles configured." />}
      </Panel>
    </View>
  );
}
