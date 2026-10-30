/**
 * The five lower panels of Daily Operations (web `.agx-grid-daily`):
 * Approvals waiting · Reviews · Recurring responsibilities · Delivery pulse ·
 * AI workforce. Each panel that describes a thing can also create/act on it,
 * exactly as on the web page.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Chip, Button, Divider, useUIKit, SPACE } from '../../../ui-kit';
import * as M from './daily-model';
import { Panel, Note, PanelEmpty, PanelAction, KpiTile } from './parts';

function Row({ tag, tagTone, title, meta, children, last }) {
  const { colors, type } = useUIKit();
  return (
    <View>
      <View style={styles.row}>
        <View style={styles.rowTop}>
          <Chip size="sm" label={tag} tone={tagTone || 'neutral'} dot />
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
        {meta ? (
          <Text style={[type.caption, { color: colors.textMuted }]} numberOfLines={3}>
            {meta}
          </Text>
        ) : null}
        {children}
      </View>
      {last ? null : <Divider />}
    </View>
  );
}

export function ApprovalsPanel({ state, actions }) {
  const { colors, type } = useUIKit();
  const intent = state.approvalIntent;
  return (
    <Panel title="Approvals waiting" count={state.approvals.length}>
      {state.approvals.length === 0 ? (
        <PanelEmpty
          icon="checkmark-done-outline"
          title="Nothing is waiting on you"
          message="Spend, outbound and deliverables above a worker's threshold land here. Nobody is blocked on you right now."
        />
      ) : (
        state.approvals.map((approval, i) => {
          const armed = intent?.approvalId === approval.id;
          const busy = state.busyApprovalId === approval.id;
          return (
            <Row
              key={approval.id}
              tag={approval.risk}
              tagTone={M.riskTone(approval.risk)}
              title={approval.title}
              meta={`${approval.type} · requested by ${approval.requestedBy} ${M.relativeTime(approval.requestedAt)}${
                approval.engagementName ? ` · ${approval.engagementName}` : ''
              }${approval.amount ? ` · ${M.money(approval.amount, approval.currency || 'USD')}` : ''}`}
              last={i === state.approvals.length - 1}
            >
              {approval.description ? (
                <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={4}>
                  {approval.description}
                </Text>
              ) : null}
              <View style={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  icon="checkmark"
                  title="Approve"
                  disabled={busy}
                  onPress={() => actions.setApprovalIntent({ approvalId: approval.id, decision: 'approved' })}
                  accessibilityLabel={`Approve ${approval.title}`}
                />
                <Button
                  size="sm"
                  variant="danger"
                  icon="close"
                  title="Reject"
                  disabled={busy}
                  onPress={() => actions.setApprovalIntent({ approvalId: approval.id, decision: 'rejected' })}
                  accessibilityLabel={`Reject ${approval.title}`}
                />
              </View>
              {armed ? (
                <Note tone={intent.decision === 'approved' ? 'success' : 'danger'} icon="alert-circle-outline">
                  <Text style={[type.small, { color: colors.text }]}>
                    {intent.decision === 'approved' ? 'Approve' : 'Reject'} {approval.title}? This cannot be undone here.
                  </Text>
                  <View style={styles.actions}>
                    <Button size="sm" variant="ghost" title="Cancel" onPress={() => actions.setApprovalIntent(null)} />
                    <Button
                      size="sm"
                      variant={intent.decision === 'approved' ? 'primary' : 'danger'}
                      title={busy ? 'Saving…' : intent.decision === 'approved' ? 'Yes, approve' : 'Yes, reject'}
                      loading={busy}
                      onPress={() => actions.resolveApproval()}
                      accessibilityLabel={`Confirm ${intent.decision === 'approved' ? 'approval' : 'rejection'} of ${approval.title}`}
                    />
                  </View>
                </Note>
              ) : null}
            </Row>
          );
        })
      )}
    </Panel>
  );
}

export function ReviewsPanel({ state, actions }) {
  const names = new Map(state.employees.map((e) => [e.id, e.name]));
  const ordered = [...state.reviews].sort((a, b) => a.nextReviewAt - b.nextReviewAt);
  const outstanding = ordered.filter((c) => c.status !== 'completed');
  const canSchedule = state.employees.length > 0;
  return (
    <Panel
      title="Reviews"
      count={`${outstanding.length} outstanding`}
      action={
        <PanelAction
          title="Schedule"
          disabled={!canSchedule}
          onPress={() => actions.openComposer('review')}
          accessibilityLabel="Schedule a manager review cycle"
        />
      }
    >
      {ordered.length === 0 ? (
        <PanelEmpty
          icon="time-outline"
          title="No review cycles scheduled"
          message="Reviews are how the loop holds workers accountable. Schedule one and it appears here when it falls due."
          actionLabel={canSchedule ? 'Schedule a review' : undefined}
          onAction={canSchedule ? () => actions.openComposer('review') : undefined}
        />
      ) : (
        ordered.map((cycle, i) => {
          const worker = names.get(cycle.workerId) ?? cycle.workerId;
          return (
            <Row
              key={cycle.id}
              tag={cycle.status}
              tagTone={M.reviewTone(cycle.status)}
              title={worker}
              meta={`reviewed by ${names.get(cycle.managerWorkerId) ?? cycle.managerWorkerId} · ${M.dueLabel(
                cycle.nextReviewAt,
              )}${cycle.agenda?.length ? ` · ${cycle.agenda.length} agenda items` : ''}`}
              last={i === ordered.length - 1}
            >
              {cycle.status === 'completed' ? null : (
                <View style={styles.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    icon="create-outline"
                    title="Sign off…"
                    onPress={() =>
                      actions.openComposer('review-complete', {
                        reviewCycleId: cycle.id,
                        workerId: cycle.workerId,
                        managerWorkerId: cycle.managerWorkerId,
                      })
                    }
                    accessibilityLabel={`Sign off the review cycle for ${worker}`}
                  />
                </View>
              )}
            </Row>
          );
        })
      )}
    </Panel>
  );
}

export function ResponsibilitiesPanel({ state, actions }) {
  const names = new Map(state.employees.map((e) => [e.id, e.name]));
  const ordered = [...state.responsibilities].sort((a, b) => a.nextRunAt - b.nextRunAt);
  const canAdd = state.employees.length > 0;
  return (
    <Panel
      title="Recurring responsibilities"
      count={`${ordered.filter((e) => e.enabled).length} enabled`}
      action={
        <PanelAction
          title="Add"
          disabled={!canAdd}
          onPress={() => actions.openComposer('responsibility')}
          accessibilityLabel="Give a worker a recurring responsibility"
        />
      }
    >
      {ordered.length === 0 ? (
        <PanelEmpty
          icon="repeat-outline"
          title="The loop has nothing to generate"
          message="Responsibilities are the loop's only input. Without one, today's queue stays empty however often it runs."
          actionLabel={canAdd ? 'Add a responsibility' : undefined}
          onAction={canAdd ? () => actions.openComposer('responsibility') : undefined}
        />
      ) : (
        ordered.map((entry, i) => (
          <Row
            key={entry.id}
            tag={entry.cadence}
            tagTone={entry.enabled ? 'primary' : 'neutral'}
            title={entry.title}
            meta={`${names.get(entry.workerId) ?? entry.workerId} · runs ${entry.runAt} · next ${M.relativeTime(
              entry.nextRunAt,
            )} · SLA ${entry.slaMinutes}m`}
            last={i === ordered.length - 1}
          />
        ))
      )}
    </Panel>
  );
}

export function DeliveryPulsePanel({ state, columns = 2 }) {
  const { colors, type } = useUIKit();
  const delivery = state.delivery;
  const tileW = columns >= 5 ? '18.6%' : columns >= 3 ? '31.8%' : '48.4%';
  return (
    <Panel title="Delivery pulse" count={`${delivery.total} tasks`}>
      {delivery.total === 0 ? (
        <PanelEmpty
          icon="pulse-outline"
          title="No delivery tasks"
          message="Project tasks are the client-facing half of today. Create a project to see what is moving."
        />
      ) : (
        <>
          <View style={styles.tiles}>
            {M.DELIVERY_BUCKETS.map((bucket) => {
              const value = delivery.byStatus[bucket.key] ?? 0;
              return (
                <KpiTile
                  key={bucket.key}
                  label={bucket.label}
                  value={String(value)}
                  dim={value === 0}
                  tone={value > 0 ? (bucket.tone === 'crit' ? 'danger' : bucket.tone === 'warn' ? 'warning' : undefined) : undefined}
                  style={{ width: tileW }}
                />
              );
            })}
            <KpiTile
              label="Overdue"
              value={String(delivery.overdue)}
              context={`${delivery.dueToday} due today`}
              dim={delivery.overdue === 0}
              tone={delivery.overdue > 0 ? 'danger' : undefined}
              style={{ width: tileW }}
            />
          </View>
          {delivery.active.map((task, i) => (
            <Row
              key={task.id}
              tag={M.humanStatus(task.status)}
              tagTone={task.status === 'blocked' ? 'danger' : task.status === 'in_progress' ? 'primary' : 'neutral'}
              title={task.title}
              meta={`${task.projectName} · ${task.priority} · ${M.dueLabel(task.dueAt)}`}
              last={i === delivery.active.length - 1}
            />
          ))}
          {delivery.active.length === 0 ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>Nothing blocked, running, in review or ready.</Text>
          ) : null}
        </>
      )}
    </Panel>
  );
}

export function WorkforcePanel({ state, actions }) {
  const workload = M.openWorkloadByWorker(state.workItems);
  return (
    <Panel title="AI workforce" count={`${state.employees.length} on shift`}>
      {state.employees.length === 0 ? (
        <PanelEmpty
          icon="people-outline"
          title="No workers hired"
          message="The workforce executes the queue. Hire in Agency Operations and they report for duty here."
        />
      ) : (
        state.employees.map((employee, i) => (
          <Row
            key={employee.id}
            tag={employee.kind}
            tagTone={employee.kind === 'ai' ? 'primary' : 'neutral'}
            title={`${employee.name} — ${employee.role}`}
            meta={`${employee.availability} · ${workload.get(employee.id) ?? 0} open items · ${
              employee.activeWork
            } assignments · ${Math.round(employee.utilizationPercent || 0)}% of ${employee.capacityHours}h`}
            last={i === state.employees.length - 1}
          >
            <View style={styles.actions}>
              <Button
                size="sm"
                variant="outline"
                icon="add-circle-outline"
                title="Assign"
                onPress={() => actions.openComposer('work-item', { workerId: employee.id })}
                accessibilityLabel={`Assign a work item to ${employee.name}`}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="calendar-outline"
                title="Shift"
                onPress={() => actions.openComposer('schedule', { workerId: employee.id })}
                accessibilityLabel={`Set the working shift for ${employee.name}`}
              />
            </View>
          </Row>
        ))
      )}
    </Panel>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: SPACE.sm, gap: SPACE.xs },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.xs },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, justifyContent: 'flex-start' },
});
