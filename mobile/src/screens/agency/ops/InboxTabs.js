/**
 * Approval inbox (web renderApprovalInbox) and Activity & audit
 * (web renderActivityAudit — entity rows navigate like focusAgencyAuditEntity).
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { SPACE } from '../../../ui-kit';
import { auditEntityLabel, auditTarget, relativeTime, sortedApprovals } from './agency-ops-model';
import { DecisionItem } from './OverviewTab';
import { Empty, KpiGrid, Meta, MoreButton, Panel, Row, Tile, Title } from './ui';

export function ApprovalsTab({ ctx }) {
  const s = ctx.ops.state;
  const approvals = sortedApprovals(s.approvals);
  const high = approvals.filter((a) => a.risk === 'high').length;
  const oldest = [...s.approvals].sort((a, b) => a.requestedAt - b.requestedAt)[0];
  return (
    <View>
      <Panel eyebrow="Human control" title="Approval inbox" subtitle="Review consequential AI and employee actions before execution." />
      <KpiGrid items={[
        { label: 'Pending', value: String(approvals.length) },
        { label: 'High risk', value: String(high), tone: high ? 'danger' : 'primary' },
        { label: 'Oldest request', value: oldest ? relativeTime(oldest.requestedAt) : '—' },
      ]}
      />
      {approvals.length ? approvals.map((a) => (
        <DecisionItem
          key={a.id}
          ctx={ctx}
          currency={s.finance.currency}
          item={{ kind: 'approval', id: a.id, risk: a.risk ?? 'medium', at: a.requestedAt, title: a.title, detail: a.description ?? `${a.type} approval requested by ${a.requestedBy}`, amount: a.amount, currency: a.currency }}
        />
      )) : <Empty icon="checkmark-done-outline" text="All caught up — there are no actions waiting for human approval." />}
    </View>
  );
}

export function ActivityTab({ ctx }) {
  const s = ctx.ops.state;
  const [limit, setLimit] = useState(30);
  const go = (e) => {
    const t = auditTarget(s, e.entityType, e.entityId);
    if (!t) return;
    if (t.projectId) ctx.focusProjectTasks(t.projectId);
    else if (t.clientId) ctx.focusClientProjects(t.clientId);
    else if (t.employeeId) { ctx.setSection('employees'); ctx.openEmployee(t.employeeId); } else ctx.setSection(t.section);
  };
  return (
    <View>
      <Panel eyebrow="Accountability" title="Activity & audit" subtitle="A durable timeline of employee actions, approvals and operating changes." />
      {s.auditEvents.length ? s.auditEvents.slice(0, limit).map((e) => {
        const label = auditEntityLabel(s, e.entityType, e.entityId);
        const target = label ? auditTarget(s, e.entityType, e.entityId) : null;
        return (
          <Tile key={e.id} onPress={target ? () => go(e) : undefined} accessibilityLabel={target ? `Open ${e.entityType} ${label}` : undefined}>
            <Row>
              <Title style={{ flex: 1 }}>{String(e.action).replace(/\./g, ' ').replace(/_/g, ' ')}</Title>
              <Meta>{relativeTime(e.createdAt)}</Meta>
            </Row>
            <Meta numberOfLines={1} style={target ? { textDecorationLine: 'underline' } : null}>{e.entityType} · {label ?? e.entityId}</Meta>
            <Meta>Actor {e.actorId ?? 'system'} · immutable event {e.id}</Meta>
          </Tile>
        );
      }) : <Empty icon="time-outline" text="No audit events have been recorded for this agency yet." />}
      <View style={{ marginBottom: SPACE.md }}>
        <MoreButton shown={Math.min(limit, s.auditEvents.length)} total={s.auditEvents.length} onPress={() => setLimit((l) => l + 30)} noun="events" />
      </View>
    </View>
  );
}
