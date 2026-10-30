/**
 * Employee profile (web renderEmployeeDetailPanel): autonomy, facts, capacity
 * (editable), persona, skills, goals/KPIs, performance, communication profile,
 * channel bindings (bind / edit / remove), SOP schedules (attach / run now /
 * detach / provision starter catalogue) and recent runs, namespaced memory
 * (add / edit) and Deactivate.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { BottomSheet, Button, Chip, Field, ProgressBar, SPACE, useUIKit } from '../../../ui-kit';
import {
  allocationTone,
  channelLabel,
  describeAutonomy,
  lastRunSummary,
  money,
  relativeTime,
  shortDate,
  stringifyMemoryValue,
} from './agency-ops-model';
import { Actions, ActionButton, Avatar, Meta, Notice, Row, StatPairs, Tile, Title, toneOf } from './ui';

const CADENCE_SUMMARY = { daily: 'every day', weekly: 'weekly', monthly: 'monthly' };

function Block({ title, right, children }) {
  const { colors, type } = useUIKit();
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.borderSubtle, paddingTop: SPACE.md, marginTop: SPACE.md, gap: SPACE.xs }}>
      <Row>
        <Text style={[type.label, { color: colors.textSecondary, flex: 1 }]}>{title}</Text>
        {right}
      </Row>
      {children}
    </View>
  );
}

export function EmployeeDetailSheet({ ctx, employeeId, refreshKey, onClose }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const s = ops.state;
  const agencyId = s.selectedAgencyId;
  const employee = s.employees.find((e) => e.id === employeeId);
  const [detail, setDetail] = useState({ loading: false, data: null, error: null });
  const [memory, setMemory] = useState({ loading: false, list: [], error: null });
  const [sops, setSops] = useState({ loading: false, schedules: [], runs: [], error: null });
  const [channels, setChannels] = useState({ loading: false, list: [], unavailable: false });
  const [capacity, setCapacity] = useState('');

  const loadAll = useCallback(async () => {
    if (!employeeId || !agencyId) return;
    setDetail((d) => ({ ...d, loading: true }));
    setMemory((m) => ({ ...m, loading: true }));
    setSops((x) => ({ ...x, loading: true }));
    setChannels((c) => ({ ...c, loading: true }));
    const settle = (p) => p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));
    const [d, m, sch, runs, ch] = await Promise.all([
      settle(ops.req('agency.ops.employee.detail', { agencyId, workerId: employeeId })),
      settle(ops.req('agency.ops.employee.memory.list', { agencyId, workerId: employeeId })),
      settle(ops.req('agency.ops.sop.schedules.list', { agencyId, workerId: employeeId })),
      settle(ops.req('agency.ops.sop.runs.list', { agencyId, workerId: employeeId, limit: 20 })),
      settle(ops.req('agency.ops.employee.channels.list', { agencyId, employeeId })),
    ]);
    setDetail({ loading: false, data: d.ok ? d.v : null, error: d.ok ? null : (d.e?.message || String(d.e)) });
    setMemory({ loading: false, list: m.ok ? (m.v?.memory ?? []) : [], error: m.ok ? null : (m.e?.message || String(m.e)) });
    setSops({ loading: false, schedules: sch.ok ? (sch.v?.schedules ?? []) : [], runs: runs.ok ? (runs.v?.runs ?? []) : [], error: sch.ok ? null : (sch.e?.message || String(sch.e)) });
    setChannels({ loading: false, list: ch.ok ? (ch.v?.bindings ?? ch.v?.channels ?? []) : [], unavailable: !ch.ok });
  }, [ops, agencyId, employeeId]);

  useEffect(() => { if (employeeId) { setCapacity(''); loadAll(); } }, [employeeId, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!employeeId) return <BottomSheet visible={false} onClose={onClose} title="" />;
  const worker = detail.data?.employee ?? null;
  const autonomy = worker?.autonomyLevel ?? employee?.autonomyLevel;
  const threshold = worker?.approvalThreshold ?? employee?.approvalThreshold;
  const described = describeAutonomy(autonomy);
  const backend = worker?.modelBinding ?? employee?.modelBinding ?? employee?.model ?? null;
  const exec = worker?.executionProfile ?? null;
  const comm = worker?.communicationProfile ?? null;
  const perf = detail.data?.performance ?? null;
  const pct = employee?.capacityHours ? Math.round((employee.allocatedHours / employee.capacityHours) * 100) : 0;
  const sopById = new Map(s.sops.map((x) => [x.id, x]));
  const namespaces = [...new Set(memory.list.map((e) => e.namespace))].sort();

  const runSop = async (sopId) => {
    try { await ops.call('agency.ops.sop.run', { agencyId, sopId, workerId: employeeId }, { busyKey: `sop:${sopId}`, reload: true }); ctx.flash('SOP run queued.'); loadAll(); } catch { /* recorded */ }
  };
  const detachSop = async (scheduleId) => {
    try { await ops.call('agency.ops.sop.schedule.detach', { agencyId, scheduleId }, { busyKey: `det:${scheduleId}` }); loadAll(); } catch { /* recorded */ }
  };
  const seedSops = async () => {
    try { await ops.call('agency.ops.sops.seed', { agencyId }, { busyKey: 'sop-seed', reload: true }); ctx.flash('Starter SOP catalogue provisioned.'); } catch { /* recorded */ }
  };
  const unbind = async (bindingId) => {
    try { await ops.call('agency.ops.employee.channel.unbind', { agencyId, bindingId }, { busyKey: `unbind:${bindingId}` }); loadAll(); } catch { /* recorded */ }
  };
  const saveCapacity = async () => {
    const hours = Number(capacity);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return;
    try {
      await ops.call('agency.ops.employee.capacity.update', { agencyId, employeeId, capacityHours: hours }, { busyKey: 'capacity' });
      ops.mutateList('employees', employeeId, { capacityHours: hours });
      setCapacity('');
      ctx.flash('Capacity updated.');
    } catch { /* recorded */ }
  };
  const deactivate = async () => {
    try {
      await ops.call('agency.ops.employee.deactivate', { agencyId, employeeId, employmentStatus: 'inactive' }, { busyKey: 'deactivate', reload: true });
      ctx.flash(`${employee?.name ?? 'Employee'} deactivated.`);
      onClose();
    } catch { /* recorded */ }
  };

  return (
    <BottomSheet visible={!!employee} onClose={onClose} title={employee?.name ?? 'Employee'} subtitle={employee ? `${employee.kind === 'ai' ? 'AI employee' : 'Human employee'} · ${employee.role || 'No role set'}` : ''} maxHeightRatio={0.94}>
      {employee ? (
        <View>
          <Row>
            <Avatar name={employee.name} ai={employee.kind === 'ai'} size={52} />
            <Actions style={{ flex: 1 }}>
              <Button title="Customise employee" size="sm" onPress={() => ctx.openEmployeeEditor(employeeId)} accessibilityLabel={`Customise every setting for ${employee.name}`} />
              <Button title="Assign work" size="sm" variant="secondary" onPress={() => ctx.openDialog('employee-work-item', { entityId: employeeId })} accessibilityLabel={`Hand a work item to ${employee.name}`} />
            </Actions>
          </Row>

          <Block title="Autonomy">
            {described ? <Chip label={`L${described.level} ${described.label}`} tone={described.tone === 'neutral' ? 'neutral' : described.tone} style={{ alignSelf: 'flex-start' }} /> : <Chip label="Autonomy not reported" style={{ alignSelf: 'flex-start' }} />}
            <Meta>{described ? (described.level === 2 && typeof threshold === 'number' ? `Auto-completes under ${money(threshold)}. ${described.detail}` : described.detail) : 'This gateway did not report an autonomy level, so it is unknown whether this employee completes work unattended.'}</Meta>
            <Meta>{typeof threshold === 'number' ? `Approval threshold ${money(threshold)} — work estimated above this always escalates.` : 'Approval threshold not reported.'}</Meta>
          </Block>

          <Block title="Profile">
            <StatPairs
              cols={2}
              pairs={[
                { label: 'Department', value: employee.department || 'Unassigned' },
                { label: 'Reports to', value: employee.managerName ?? 'Not assigned' },
                { label: 'Status', value: employee.availability ?? '—' },
                { label: 'Employment', value: worker?.employmentStatus ?? employee.employmentStatus ?? 'Not reported' },
                { label: 'Timezone', value: worker?.timezone ?? employee.timezone ?? 'Not reported' },
                { label: 'Open work', value: String(employee.activeWork ?? 0) },
                { label: 'Performance', value: employee.performanceScore != null ? String(employee.performanceScore) : 'Not reviewed' },
                { label: 'Runs on', value: backend ?? (employee.kind === 'ai' ? 'Gateway default' : 'Human') },
                { label: 'Fallback', value: exec?.fallbackModelBinding ?? 'Gateway default' },
                { label: 'Concurrency', value: exec?.maxConcurrent != null ? String(exec.maxConcurrent) : 'Gateway default' },
                { label: 'Run timeout', value: exec?.timeoutMinutes != null ? `${exec.timeoutMinutes} min` : 'Gateway default' },
                { label: 'Heartbeat', value: worker?.lastHeartbeatAt ? relativeTime(worker.lastHeartbeatAt) : 'Not reported' },
              ]}
            />
            {exec?.toolAllowlist?.length || exec?.toolDenylist?.length ? <Meta>Tool policy: {exec.toolAllowlist?.length ? `allow ${exec.toolAllowlist.join(', ')}` : 'allow all'}{exec.toolDenylist?.length ? ` · deny ${exec.toolDenylist.join(', ')}` : ''}</Meta> : null}
          </Block>

          <Block title="Capacity">
            <Meta mono>{employee.allocatedHours} of {employee.capacityHours} hours allocated</Meta>
            <ProgressBar value={Math.min(1, pct / 100)} tone={allocationTone(pct)} />
            <Row>
              <Field value={capacity} onChangeText={setCapacity} placeholder={`${employee.capacityHours} h/wk`} keyboardType="number-pad" mono style={{ flex: 1 }} accessibilityLabel="Weekly capacity hours" />
              <ActionButton title="Set capacity" loading={ops.busy === 'capacity'} disabled={!capacity.trim()} onPress={saveCapacity} accessibilityLabel="Save weekly capacity" />
            </Row>
          </Block>

          {detail.loading ? <Meta style={{ marginTop: SPACE.md }}>Loading operating profile…</Meta> : worker ? (
            <>
              <Block title="Persona"><Text style={[type.small, { color: worker.persona ? colors.textSecondary : colors.textMuted }]}>{worker.persona || 'No persona written for this employee.'}</Text></Block>
              <Block title="Skills & capabilities">
                {worker.skills?.length || worker.capabilities?.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
                    {(worker.skills || []).map((sk) => <Chip key={`s-${sk.skill}`} size="sm" label={`${sk.skill} · L${sk.level}`} tone="primary" />)}
                    {(worker.capabilities || []).map((cp) => <Chip key={`c-${cp}`} size="sm" label={cp} />)}
                  </View>
                ) : <Meta>None recorded.</Meta>}
              </Block>
              <Block title="Goals & KPIs">
                {(worker.goals || []).map((g) => <Meta key={`g-${g}`}>Goal · {g}</Meta>)}
                {(worker.kpis || []).map((k) => <Meta key={`k-${k}`}>KPI · {k}</Meta>)}
                {!worker.goals?.length && !worker.kpis?.length ? <Meta>No goals or KPIs set.</Meta> : null}
              </Block>
              {perf && (perf.qualityScore != null || perf.reliabilityScore != null) ? (
                <StatPairs cols={3} pairs={[{ label: 'Quality', value: String(perf.qualityScore ?? '—') }, { label: 'Reliability', value: String(perf.reliabilityScore ?? '—') }, { label: 'Outcomes', value: `${perf.outcomeAttainmentPercent ?? '—'}%` }]} />
              ) : <Meta style={{ marginTop: SPACE.sm }}>No performance review recorded yet.</Meta>}
            </>
          ) : <Notice tone="warning" style={{ marginTop: SPACE.md }} text={`The operating profile could not be read for this employee${detail.error ? ` (${detail.error})` : ''}. Persona, skills, goals and autonomy may be incomplete.`} />}

          <Block title="Communication" right={<ActionButton title="Edit" onPress={() => ctx.openEmployeeEditor(employeeId, 'communication')} accessibilityLabel={`Edit how ${employee.name} communicates`} />}>
            {!worker ? <Meta>Operating profile has not loaded.</Meta> : comm ? (
              <>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.xs }}>
                  {[comm.tone ?? 'tone not set', comm.verbosity ?? 'verbosity not set', comm.proactivity ?? 'proactivity not set', `emoji: ${comm.emojiUse ?? 'not set'}`, comm.language ?? 'en'].map((t) => <Chip key={t} size="sm" label={t} />)}
                </View>
                <Meta>Replies after {comm.responseLatency?.minSeconds ?? '?'}s at the earliest, aiming for {comm.responseLatency?.targetSeconds ?? '?'}s, batching messages within {comm.responseLatency?.batchWindowSeconds ?? '?'}s.</Meta>
                <Meta>Outside working hours: {comm.workingHours?.outsideHours ?? 'not set'} · reports {comm.reportCadence ?? 'not set'} at {comm.reportTime ?? '—'}.</Meta>
                <Meta>Escalates to the manager after {comm.escalation?.escalateAfterMinutes ?? '?'} minutes of silence.</Meta>
              </>
            ) : <Meta>No structured communication profile on this record. The employee falls back to its legacy cadence: {worker.communicationCadence || 'none recorded'}.</Meta>}
          </Block>

          <Block title="Channels" right={<ActionButton title="+ Bind" onPress={() => ctx.openDialog('employee-channel', { entityId: employeeId, channels: channels.list })} accessibilityLabel={`Bind ${employee.name} to a chat channel`} />}>
            <Meta>Where this employee speaks. Routing only — credentials stay in the gateway.</Meta>
            {channels.loading ? <Meta>Loading channel bindings…</Meta> : channels.unavailable ? (
              <Notice tone="warning" text='This gateway does not expose agency.ops.employee.channels.list, so reachability cannot be read. This is not the same as "no channels".' />
            ) : channels.list.length ? channels.list.map((b) => (
              <Tile key={b.id}>
                <Row>
                  <Chip size="sm" label={channelLabel(b.channelId)} tone={b.enabled ? 'primary' : 'neutral'} />
                  <View style={{ flex: 1 }}><Title numberOfLines={1}>{b.handle || 'Default handle'}</Title><Meta>{b.target || 'channel default'} · {b.direction}</Meta></View>
                </Row>
                <Actions>
                  <ActionButton title="Edit" onPress={() => ctx.openDialog('employee-channel', { entityId: employeeId, bindingId: b.id, channels: channels.list })} accessibilityLabel="Edit binding" />
                  <ActionButton title="Remove" confirm variant="danger" loading={ops.busy === `unbind:${b.id}`} onPress={() => unbind(b.id)} accessibilityLabel="Remove binding" />
                </Actions>
              </Tile>
            )) : <Meta>Not bound to any channel. This employee cannot be reached on Discord, Slack, Telegram, WhatsApp, Signal, LINE or iMessage.</Meta>}
          </Block>

          <Block title="Standard operating procedures" right={<ActionButton title="+ Attach" disabled={!s.sops.length} onPress={() => ctx.openDialog('employee-sop-attach', { entityId: employeeId, detail: detail.data })} accessibilityLabel={`Attach an SOP schedule to ${employee.name}`} />}>
            <Meta>Procedures this employee runs on a cadence, and what they last produced.</Meta>
            {sops.loading ? <Meta>Loading SOPs…</Meta> : sops.error ? <Notice tone="warning" text={sops.error} /> : sops.schedules.length ? sops.schedules.map((sc) => {
              const sop = sopById.get(sc.sopId);
              return (
                <Tile key={sc.id}>
                  <Title>{sop?.name ?? sc.sopId}</Title>
                  <Meta>{CADENCE_SUMMARY[sc.cadence] ?? sc.cadence} at {sc.runAt} {sc.timezone} · next {shortDate(sc.nextRunAt)} · {sc.enabled ? 'enabled' : 'paused'}</Meta>
                  <Actions>
                    <ActionButton title="Run now" loading={ops.busy === `sop:${sc.sopId}`} onPress={() => runSop(sc.sopId)} accessibilityLabel={`Run ${sop?.name ?? 'this SOP'} now`} />
                    <ActionButton title="Detach" confirm variant="danger" loading={ops.busy === `det:${sc.id}`} onPress={() => detachSop(sc.id)} accessibilityLabel={`Detach ${sop?.name ?? 'this SOP'}`} />
                  </Actions>
                </Tile>
              );
            }) : s.sops.length ? <Meta>No SOP is attached. {s.sops.length} procedures are available to attach.</Meta> : (
              <>
                <Meta>The agency has no SOP catalogue, so there is nothing to attach yet. Provisioning the starter set writes the procedures only — it attaches no schedules, creates no cron jobs and generates no work.</Meta>
                <ActionButton title="Provision starter SOPs" loading={ops.busy === 'sop-seed'} onPress={seedSops} accessibilityLabel="Provision the starter SOP catalogue" />
              </>
            )}
            {sops.runs.length ? [...sops.runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((r) => {
              const sum = lastRunSummary([r]);
              return (
                <Row key={r.id}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneOf(sum?.tone, colors) }} />
                  <Meta style={{ flex: 1 }} numberOfLines={1}>{sopById.get(r.sopId)?.name ?? r.sopId}</Meta>
                  <Meta>{r.trigger} · {r.status} · {relativeTime(r.createdAt)}</Meta>
                </Row>
              );
            }) : !sops.loading ? <Meta>No SOP run history recorded for this employee.</Meta> : null}
          </Block>

          <Block title="Memory" right={<ActionButton title="+ Memory" onPress={() => ctx.openDialog('employee-memory', { entityId: employeeId, memory: memory.list })} accessibilityLabel={`Add a memory entry for ${employee.name}`} />}>
            <Meta>Namespaced recall this employee carries between work items.</Meta>
            {memory.loading ? <Meta>Loading memory…</Meta> : memory.list.length ? namespaces.map((ns) => (
              <View key={ns} style={{ gap: SPACE.xs }}>
                <Chip size="sm" label={ns} tone="primary" style={{ alignSelf: 'flex-start' }} />
                {memory.list.filter((m) => m.namespace === ns).map((m) => {
                  const expired = m.expiresAt !== null && m.expiresAt !== undefined && m.expiresAt <= Date.now();
                  return (
                    <Tile key={m.id}>
                      <Title>{m.key}</Title>
                      <Meta mono numberOfLines={4}>{stringifyMemoryValue(m.value).slice(0, 220)}</Meta>
                      <Meta>{m.source} · updated {relativeTime(m.updatedAt)}{m.expiresAt == null ? ' · no expiry' : ` · ${expired ? 'expired' : 'expires'} ${shortDate(m.expiresAt)}`}</Meta>
                      <ActionButton title="Edit" onPress={() => ctx.openDialog('employee-memory', { entityId: employeeId, memoryEntryId: m.id, memory: memory.list })} accessibilityLabel={`Edit memory ${m.key}`} />
                    </Tile>
                  );
                })}
              </View>
            )) : <Meta>{memory.error ? `Memory could not be read: ${memory.error}` : 'No memory recorded yet. Add the standing context this employee should always recall.'}</Meta>}
          </Block>

          <Block title="Deactivate">
            <Meta>Takes {employee.name} off the active roster and sets its status offline. Work already assigned is not deleted.</Meta>
            <ActionButton title="Deactivate employee" confirm variant="danger" loading={ops.busy === 'deactivate'} onPress={deactivate} accessibilityLabel={`Deactivate ${employee.name}`} />
          </Block>
        </View>
      ) : null}
    </BottomSheet>
  );
}
