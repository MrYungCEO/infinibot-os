/**
 * Ops Agents — the three KIS Phase 1 operations agents on one surface
 * (§19 Daily CEO Briefing · §20 Operations Monitor · §21 Project Health).
 *
 * All three are **authority L1: observe and recommend only**. Nothing on this
 * screen mutates a store, and there is deliberately no action that would — the
 * agents' whole contract is that they read the live objects and tell you what
 * they see. That constraint is surfaced in the footer of every tab rather than
 * left implicit.
 *
 * The Command Centers each consume a slice of these agents in context. This
 * screen is the agents themselves, unfiltered — the report you'd read top to
 * bottom rather than the dashboard you'd scan.
 *
 * A tab whose RPC hasn't been served yet shows exactly that, and shows nothing
 * else. There are no placeholder rows anywhere in this file.
 */

import React, { useMemo, useState } from 'react';
import { View, Text } from 'react-native';

import {
  AppHeader,
  Card,
  Chip,
  Divider,
  EmptyState,
  ListRow,
  PriorityChip,
  Screen,
  SegmentedControl,
  SkeletonRow,
  StatCard,
  SPACE,
  toneColor,
  useUIKit,
} from '../ui-kit';
import { useOpsAgents } from '../hooks/useOpsAgents';
import { Band, Block, Panel, Provenance, Rows, StatGrid } from './command/CommandBlocks';
import {
  briefingTodayCount,
  exceptionTone,
  fmtIsoDue,
  fmtStamp,
  healthTone,
  plural,
} from './command/command-shared';

const TABS = [
  { key: 'briefing', label: 'Briefing', icon: 'sunny-outline' },
  { key: 'monitor', label: 'Monitor', icon: 'alert-circle-outline' },
  { key: 'health', label: 'Health', icon: 'pulse-outline' },
];

/** A §19 BriefingItem row: the summary is the decision, `why` is the evidence. */
function BriefingRow({ item, tone }) {
  const { colors } = useUIKit();
  return (
    <ListRow
      title={item.summary || 'Untitled'}
      subtitle={item.why}
      value={item.dueDate ? fmtIsoDue(item.dueDate) : undefined}
      valueTone={toneColor(tone, colors)}
      meta={
        <>
          <Chip label={item.kind} tone="neutral" size="sm" />
          <PriorityChip priority={item.priority} size="sm" />
        </>
      }
      accessibilityLabel={item.summary}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════
// §19 DAILY CEO BRIEFING
// ═══════════════════════════════════════════════════════════════════

function BriefingTab({ briefing, reason, loading, onRetry }) {
  const { colors, type } = useUIKit();

  if (loading && !briefing) {
    return (
      <Card padded={SPACE.md}>
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
      </Card>
    );
  }
  if (!briefing) {
    return (
      <EmptyState
        icon="sunny-outline"
        title="Daily CEO Briefing not served"
        message={reason || 'opsagent.ceoBriefing has not returned yet.'}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }

  const t = briefing.today || {};
  const count = briefingTodayCount(briefing);

  const buckets = [
    { key: 'ceoActions', title: 'Actions only the CEO can take', tone: 'warning', items: t.ceoActions },
    { key: 'decisionsRequired', title: 'Decisions required', tone: 'danger', items: t.decisionsRequired },
    { key: 'criticalBlockers', title: 'Critical blockers', tone: 'danger', items: t.criticalBlockers },
    { key: 'clientMatters', title: 'Important client matters', tone: 'warning', items: t.clientMatters },
    { key: 'upcomingDeadlines', title: 'Upcoming deadlines', tone: 'primary', items: t.upcomingDeadlines },
  ];

  return (
    <View>
      <Band title="Today" subtitle="Capped at roughly ten items — a briefing, not a backlog." count={count} />

      {briefing.quietDay ? (
        <EmptyState
          icon="cafe-outline"
          title="A genuinely quiet day"
          message="Nothing needs the CEO today. The briefing agent reports this honestly rather than manufacturing urgency to fill the page."
        />
      ) : (
        <Panel title="What needs you today" count={count} countTone={count ? 'warning' : 'success'}>
          {buckets.map((b) => (
            <Block key={b.key} title={b.title} count={b.items?.length || 0} tone={b.tone}>
              <Rows
                items={b.items}
                limit={6}
                keyOf={(i, idx) => `${b.key}:${i.id}:${idx}`}
                empty="Nothing in this bucket."
                render={(i) => <BriefingRow item={i} tone={b.tone} />}
              />
            </Block>
          ))}
        </Panel>
      )}

      <Band title="FYI — no action required" count={briefing.fyi?.length || 0} />
      <Card padded={SPACE.md}>
        {briefing.fyi?.length ? (
          briefing.fyi.map((line, i) => (
            <React.Fragment key={`${i}:${line}`}>
              {i > 0 ? <Divider /> : null}
              <View style={{ paddingVertical: SPACE.sm }}>
                <Text style={[type.body, { color: colors.textSecondary }]}>{line}</Text>
              </View>
            </React.Fragment>
          ))
        ) : (
          <Text style={[type.caption, { color: colors.textMuted }]}>Nothing to note.</Text>
        )}
      </Card>

      <Provenance
        text={`§19 Daily CEO Briefing · generated ${fmtStamp(briefing.generatedAt)} · authority ${
          briefing.authorityLevel || 'L1'
        } — observes and recommends, never acts.`}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════
// §20 OPERATIONS MONITOR
// ═══════════════════════════════════════════════════════════════════

function MonitorTab({ report, reason, loading, onRetry }) {
  const { colors } = useUIKit();
  if (loading && !report) {
    return (
      <Card padded={SPACE.md}>
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
      </Card>
    );
  }
  if (!report) {
    return (
      <EmptyState
        icon="alert-circle-outline"
        title="Operations Monitor not served"
        message={reason || 'opsagent.monitor has not returned yet.'}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }

  return (
    <View>
      <Band
        title="Exception report"
        subtitle="Exceptions only — never a summary of everything that is fine."
        count={report.totalExceptions}
      />

      {report.clean ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title="The organization is clean"
          message="The monitor found zero exceptions: nothing overdue, unowned, stale, blocked or past deadline."
        />
      ) : (
        <Panel
          title="Exceptions found"
          subtitle={`${report.groups?.length || 0} groups`}
          count={report.totalExceptions}
          countTone="danger"
        >
          {(report.groups || []).map((g) => {
            const tone = exceptionTone(g.kind);
            return (
              <Block key={g.kind} title={g.label} count={g.count} tone={tone}>
                <Rows
                  items={g.items}
                  limit={6}
                  keyOf={(x, i) => `${g.kind}:${x.id}:${i}`}
                  empty="Nothing here."
                  render={(x) => (
                    <ListRow
                      title={x.title || 'Untitled'}
                      subtitle={x.detail}
                      value={x.dueDate ? fmtIsoDue(x.dueDate) : undefined}
                      valueTone={toneColor(tone, colors)}
                      meta={
                        <>
                          <Chip label={x.objectType} tone="neutral" size="sm" />
                          {x.owner ? <Chip label={x.owner} tone="neutral" size="sm" /> : null}
                          <PriorityChip priority={x.priority} size="sm" />
                        </>
                      }
                      accessibilityLabel={x.title}
                    />
                  )}
                />
              </Block>
            );
          })}
        </Panel>
      )}

      <Provenance
        text={`§20 Operations Monitor · generated ${fmtStamp(report.generatedAt)} · authority ${
          report.authorityLevel || 'L1'
        } — observes and recommends, never acts.`}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════
// §21 PROJECT HEALTH
// ═══════════════════════════════════════════════════════════════════

/**
 * The adverse signals behind a rating. Renders nothing but an honest line when
 * there are none — an empty chip row reads as "we didn't check".
 */
function SignalsBlock({ signals }) {
  const { colors, type } = useUIKit();
  const s = signals || {};
  const chips = [
    s.dueDate && {
      key: 'due',
      // fmtIsoDue already says "overdue 3d"; prefixing "due" would double it.
      label: s.deadlinePassed ? fmtIsoDue(s.dueDate) : `due ${fmtIsoDue(s.dueDate)}`,
      tone: s.deadlinePassed ? 'danger' : 'primary',
    },
    s.overdueInvoices && { key: 'inv', label: plural(s.overdueInvoices, 'overdue invoice'), tone: 'danger' },
    s.criticalRisks && { key: 'crit', label: plural(s.criticalRisks, 'critical risk'), tone: 'danger' },
    s.clientRisks && { key: 'client', label: plural(s.clientRisks, 'client risk'), tone: 'warning' },
    s.stale && { key: 'stale', label: 'stale', tone: 'warning' },
    s.missingNextAction && { key: 'nna', label: 'no next action', tone: 'warning' },
  ].filter(Boolean);

  return (
    <Block title="Signals" count={chips.length} tone={chips.length ? 'warning' : 'success'}>
      {chips.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, paddingHorizontal: SPACE.md }}>
          {chips.map((c) => (
            <Chip key={c.key} label={c.label} tone={c.tone} size="sm" />
          ))}
        </View>
      ) : (
        <Text style={[type.caption, { color: colors.textMuted, paddingHorizontal: SPACE.md }]}>
          No adverse signals on this project.
        </Text>
      )}
    </Block>
  );
}

function HealthTab({ report, reason, loading, onRetry }) {
  const { colors, type } = useUIKit();

  if (loading && !report) {
    return (
      <Card padded={SPACE.md}>
        <SkeletonRow />
        <Divider inset />
        <SkeletonRow />
      </Card>
    );
  }
  if (!report) {
    return (
      <EmptyState
        icon="pulse-outline"
        title="Project Health not served"
        message={reason || 'opsagent.projectHealth has not returned yet.'}
        actionLabel="Retry"
        onAction={onRetry}
      />
    );
  }

  const counts = report.counts || { green: 0, yellow: 0, red: 0 };
  const projects = report.projects || [];

  return (
    <View>
      <Band title="Ratings" subtitle="Every active project, red first." count={projects.length} />
      <StatGrid columns={3}>
        <StatCard label="Green" value={counts.green} tone="success" compact icon="checkmark-circle-outline" />
        <StatCard label="Yellow" value={counts.yellow} tone="warning" compact icon="alert-outline" />
        <StatCard label="Red" value={counts.red} tone="danger" compact icon="close-circle-outline" />
      </StatGrid>

      <Band title="Projects" count={projects.length} />
      {!projects.length ? (
        <EmptyState
          icon="folder-open-outline"
          title="No active projects"
          message="The health agent rates active projects only. Nothing is currently active."
        />
      ) : (
        projects.map((p) => (
          <Panel
            key={p.projectId}
            title={p.name}
            subtitle={`${p.signals?.openTasks || 0} open · ${p.signals?.overdueTasks || 0} overdue · ${
              p.signals?.blockedTasks || 0
            } blocked · ${p.signals?.unassignedTasks || 0} unassigned`}
            count={p.status}
            countTone={healthTone(p.status)}
          >
            {/* The agent MUST explain its rating — the reasons are the product. */}
            <Block title="Why this rating" count={p.reasons?.length || 0} tone={healthTone(p.status)}>
              {p.reasons?.length ? (
                <View style={{ gap: SPACE.xs, paddingHorizontal: SPACE.md }}>
                  {p.reasons.map((r, i) => (
                    <Text key={`${i}:${r}`} style={[type.body, { color: colors.textSecondary }]}>
                      · {r}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text style={[type.caption, { color: colors.textMuted, paddingHorizontal: SPACE.md }]}>
                  No reasons recorded.
                </Text>
              )}
            </Block>

            <SignalsBlock signals={p.signals} />
          </Panel>
        ))
      )}

      <Provenance
        text={`§21 Project Health · generated ${fmtStamp(report.generatedAt)} · authority ${
          report.authorityLevel || 'L1'
        } — observes and recommends, never acts.`}
      />
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════

export function OpsAgentsScreen({ navigation, gateway }) {
  const [tab, setTab] = useState('briefing');
  const ops = useOpsAgents(gateway?.sendReq);

  const subtitle = useMemo(() => {
    if (ops.loading && !ops.anyServed) return 'Running the operations agents…';
    if (!ops.anyServed) return 'Not served — restart the gateway';
    const parts = [];
    if (ops.briefing) parts.push(`${briefingTodayCount(ops.briefing)} for the CEO`);
    if (ops.monitor) parts.push(plural(ops.monitor.totalExceptions, 'exception'));
    if (ops.health) parts.push(`${plural(ops.health.counts?.red || 0, 'red project')}`);
    return parts.join(' · ') || 'No agent returned data';
  }, [ops.loading, ops.anyServed, ops.briefing, ops.monitor, ops.health]);

  return (
    <Screen
      scroll
      refreshing={ops.loading}
      onRefresh={ops.refresh}
      dockSpace
      header={
        <AppHeader
          eyebrow="Operations Agents · authority L1"
          title="Observe & recommend"
          subtitle={subtitle}
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[
            { icon: 'refresh', label: 'Re-run the operations agents', onPress: ops.refresh, busy: ops.loading },
          ]}
        >
          <SegmentedControl options={TABS} value={tab} onChange={setTab} />
        </AppHeader>
      }
    >
      {tab === 'briefing' ? (
        <BriefingTab
          briefing={ops.briefing}
          reason={ops.reasonFor?.('briefing')}
          loading={ops.loading}
          onRetry={ops.refresh}
        />
      ) : tab === 'monitor' ? (
        <MonitorTab
          report={ops.monitor}
          reason={ops.reasonFor?.('monitor')}
          loading={ops.loading}
          onRetry={ops.refresh}
        />
      ) : (
        <HealthTab
          report={ops.health}
          reason={ops.reasonFor?.('health')}
          loading={ops.loading}
          onRetry={ops.refresh}
        />
      )}
    </Screen>
  );
}

export default OpsAgentsScreen;
