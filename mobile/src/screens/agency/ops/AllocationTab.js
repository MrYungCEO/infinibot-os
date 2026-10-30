/**
 * Work allocation — web renderWorkAllocation: live oversight (running agents,
 * waiting on you, off track + open escalations, recent activity), weekly
 * capacity per employee (editable), and assignments with Check candidates
 * (assignment.suitability) and Plan hybrid team (assignment.hybrid-plan).
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Field, ProgressBar, SPACE } from '../../../ui-kit';
import { allocationPct, allocationSummary, allocationTone, firstLine, humanize, money, oversightSummary, relativeTime, workerNameOf } from './agency-ops-model';
import { Actions, ActionButton, Avatar, Empty, KpiGrid, Meta, MoreButton, Notice, Panel, Row, Tile, Title } from './ui';

function CapacityRow({ ctx, employee }) {
  const { ops } = ctx;
  const [value, setValue] = useState('');
  const pct = allocationPct(employee);
  const save = async () => {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return;
    const prev = employee.capacityHours;
    ops.mutateList('employees', employee.id, { capacityHours: hours });
    try {
      await ops.call('agency.ops.employee.capacity.update', { agencyId: ops.state.selectedAgencyId, employeeId: employee.id, capacityHours: hours }, { busyKey: `cap:${employee.id}` });
      setValue('');
    } catch { ops.mutateList('employees', employee.id, { capacityHours: prev }); }
  };
  return (
    <Tile>
      <Row>
        <Avatar name={employee.name} ai={employee.kind === 'ai'} size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Row><Title numberOfLines={1} style={{ flexShrink: 1 }}>{employee.name}</Title><Chip size="sm" label={employee.kind} tone={employee.kind === 'ai' ? 'info' : 'primary'} /></Row>
          <Meta numberOfLines={1}>{employee.role} · {employee.activeWork ?? 0} active work items</Meta>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Meta mono>{employee.allocatedHours}/{employee.capacityHours}h</Meta>
          <Meta mono>{pct}% allocated</Meta>
        </View>
      </Row>
      <ProgressBar value={Math.min(1, pct / 100)} tone={allocationTone(pct)} />
      <Row>
        <Field value={value} onChangeText={setValue} placeholder={`Capacity ${employee.capacityHours}h`} keyboardType="number-pad" mono style={{ flex: 1 }} accessibilityLabel={`Weekly capacity for ${employee.name}`} />
        <ActionButton title="Save" loading={ops.busy === `cap:${employee.id}`} disabled={!value.trim()} onPress={save} accessibilityLabel={`Save capacity for ${employee.name}`} />
      </Row>
    </Tile>
  );
}

export function AllocationTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const sum = allocationSummary(s.employees);
  const ov = oversightSummary(s);
  const [suit, setSuit] = useState(null); // { id, results }
  const [plan, setPlan] = useState(null); // { id, plan }
  const [capLimit, setCapLimit] = useState(10);
  const name = (id) => workerNameOf(s.employees, id);

  const checkCandidates = async (a) => {
    try {
      const r = await ops.call('agency.ops.assignment.suitability', { agencyId: s.selectedAgencyId, requiredSkills: a.requiredSkills, requiredCapabilities: a.requiredCapabilities, estimatedHours: a.estimatedHours }, { busyKey: `suit:${a.id}` });
      setSuit({ id: a.id, results: r?.recommendations ?? [] });
    } catch { /* recorded */ }
  };
  const planTeam = async (a) => {
    try {
      const r = await ops.call('agency.ops.assignment.hybrid-plan', { agencyId: s.selectedAgencyId, requiredSkills: a.requiredSkills, requiredCapabilities: a.requiredCapabilities, estimatedHours: a.estimatedHours, maximumTeamSize: 4, requireHuman: true, requireAi: true }, { busyKey: `plan:${a.id}` });
      setPlan({ id: a.id, plan: r?.plan ?? null });
    } catch { /* recorded */ }
  };

  return (
    <View>
      <Panel
        eyebrow="Live oversight"
        title="Work allocation"
        subtitle="Mission control for the autonomous workforce — the live work board, running agents, the human gate and the activity feed on one screen."
        right={<Button title="+ Assignment" size="sm" onPress={() => ctx.openDialog('assignment')} accessibilityLabel="Create assignment" />}
      />
      <KpiGrid items={[
        { label: 'Executing now', value: String(ov.running.length), tone: 'info' },
        { label: 'Waiting on you', value: String(ov.waiting.length), tone: ov.waiting.length ? 'warning' : 'primary' },
        { label: 'Off track', value: String(ov.offTrack.length + ov.escalations.length), tone: ov.offTrack.length + ov.escalations.length ? 'danger' : 'primary' },
      ]}
      />
      <Panel title="Running agents" count={ov.running.length}>
        {ov.running.length ? ov.running.slice(0, 8).map((i) => (
          <Tile key={i.id}><Title>{i.title}</Title><Meta>{name(i.workerId)} · started {relativeTime(i.updatedAt)}</Meta></Tile>
        )) : <Empty icon="flash-outline" text="No agent is executing right now." />}
      </Panel>
      <Panel title="Waiting on you" count={ov.waiting.length}>
        {ov.waiting.length ? ov.waiting.slice(0, 8).map((i) => (
          <Tile key={i.id}>
            <Row><Title style={{ flex: 1 }}>{i.title}</Title><Chip size="sm" label={humanize(i.status)} tone="warning" /></Row>
            <Meta>{name(i.workerId)} · {i.priority} priority</Meta>
            <Actions>
              <ActionButton title={i.status === 'queued' ? 'Approve' : 'Accept review'} variant="primary" loading={ops.busy === i.id} onPress={() => ctx.transitionWorkItem(i.id, i.status === 'queued' ? 'accepted' : 'completed')} accessibilityLabel={`Approve ${i.title}`} />
              <ActionButton title="Reject" variant="danger" onPress={() => ctx.transitionWorkItem(i.id, 'cancelled')} accessibilityLabel={`Reject ${i.title}`} />
            </Actions>
          </Tile>
        )) : <Empty icon="checkmark-done-outline" text="Nothing is waiting on you." />}
      </Panel>
      <Panel title="Off track" count={ov.offTrack.length + ov.escalations.length}>
        {ov.escalations.map((e) => <Notice key={e.id} tone="danger" title={e.title ?? e.summary ?? 'Escalation'} text={`${e.urgency ?? e.risk ?? ''} ${e.status ?? ''} · ${relativeTime(e.createdAt)}`} />)}
        {ov.offTrack.length ? ov.offTrack.slice(0, 8).map((i) => (
          <Tile key={i.id}><Row><Title style={{ flex: 1 }}>{i.title}</Title><Chip size="sm" label={humanize(i.status)} tone="danger" /></Row><Meta>{name(i.workerId)}{i.dueAt ? ` · due ${relativeTime(i.dueAt)}` : ''}</Meta></Tile>
        )) : !ov.escalations.length ? <Empty icon="shield-checkmark-outline" text="Nothing is off track." /> : null}
      </Panel>
      <Panel title="Activity feed">
        {s.auditEvents.length ? s.auditEvents.slice(0, 6).map((e) => (
          <Row key={e.id} style={{ marginBottom: SPACE.xs }}>
            <Meta style={{ flex: 1 }} numberOfLines={1}>{String(e.action).replace(/[._]/g, ' ')} · {e.entityType}</Meta>
            <Meta>{relativeTime(e.createdAt)}</Meta>
          </Row>
        )) : <Empty icon="pulse-outline" text="No activity recorded yet." />}
      </Panel>

      <Panel eyebrow="Delivery planning" title="Weekly capacity" subtitle={`${sum.allocated}/${sum.capacity}h allocated · ${sum.over} overallocated`}>
        {sum.sorted.length ? sum.sorted.slice(0, capLimit).map((e) => <CapacityRow key={e.id} ctx={ctx} employee={e} />)
          : <Empty icon="people-outline" text="No employee capacity is available. Add employees before allocating work." />}
        <MoreButton shown={Math.min(capLimit, sum.sorted.length)} total={sum.sorted.length} onPress={() => setCapLimit((l) => l + 10)} noun="employees" />
      </Panel>

      <Panel eyebrow="Work queue" title="Assignments" count={`${s.assignments.length} total`}>
        {s.assignments.length ? s.assignments.map((a) => (
          <Tile key={a.id}>
            <Row><Title style={{ flex: 1 }}>{a.title}</Title><Chip size="sm" label={a.status} /></Row>
            <Meta>{a.estimatedHours}h estimated · priority {a.priority} · {a.members?.length ?? 0} assigned</Meta>
            {a.requiredSkills?.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>{a.requiredSkills.map((sk) => <Chip key={sk.skill} size="sm" label={`${sk.skill} L${sk.minimumLevel}`} />)}</View> : null}
            <Actions>
              <ActionButton title="Check candidates" loading={ops.busy === `suit:${a.id}`} onPress={() => checkCandidates(a)} accessibilityLabel={`Score every candidate against ${a.title}`} />
              <ActionButton title="Plan hybrid team" loading={ops.busy === `plan:${a.id}`} onPress={() => planTeam(a)} accessibilityLabel={`Plan a hybrid team for ${a.title}`} />
            </Actions>
            {suit?.id === a.id ? (
              <View style={{ gap: SPACE.xs }}>
                <Title>Candidate suitability</Title>
                {suit.results.length ? suit.results.slice(0, 8).map((c) => {
                  const blockers = [...new Set([...(c.missingSkills || []).map((x) => `missing ${x}`), ...(c.missingCapabilities || []).map((x) => `no ${x}`), ...(c.reasons || [])])];
                  return (
                    <Row key={c.workerId}>
                      <Chip size="sm" label={String(Math.round(c.score))} tone={c.eligible ? 'success' : 'neutral'} />
                      <View style={{ flex: 1 }}>
                        <Meta>{name(c.workerId)} · {Math.round((c.skillCoverage ?? 0) * 100)}% skill coverage · {c.availableHours}h free · {c.eligible ? 'eligible' : 'not eligible'}</Meta>
                        {blockers.length ? <Meta>{blockers.join(' · ')}</Meta> : null}
                      </View>
                    </Row>
                  );
                }) : <Meta>No active workers were scored for this assignment.</Meta>}
              </View>
            ) : null}
            {plan?.id === a.id ? (
              plan.plan ? (
                <Notice tone="info" title={`${Math.round((plan.plan.skillCoverage ?? 0) * 100)}% skill coverage · ${money(plan.plan.estimatedCost ?? 0, s.finance.currency)}`} text={(plan.plan.members || []).map((m) => `${m.worker?.displayName} (${m.worker?.type}, ${m.allocatedHours}h)`).join(' · ') || 'No eligible team available'}>
                  {(plan.plan.warnings || []).map((w) => <Meta key={w}>{w}</Meta>)}
                </Notice>
              ) : <Meta>No eligible team available.</Meta>
            ) : null}
          </Tile>
        )) : <Empty icon="git-network-outline" text="No workforce assignments yet. Create the first one to start allocating work." actionLabel="+ Assignment" onAction={() => ctx.openDialog('assignment')} />}
      </Panel>
    </View>
  );
}

export { firstLine };
