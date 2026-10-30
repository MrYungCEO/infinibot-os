/**
 * Executive Command Center — "What needs you." (spec §15, §16, §17)
 *
 * The mobile counterpart of `ui/src/ui/views/command-ceo.ts`. This is the
 * management interface, and it deliberately does NOT display everything: only
 * exceptions, priorities and decisions, arranged in three bands —
 *
 *   TODAY           what only the CEO can move today
 *   THIS WEEK       what is approaching
 *   BUSINESS HEALTH the state of the business as KPI tiles
 *
 * followed by the CEO QUEUE (§16), whose every item renders in the structured
 * CEO REQUEST FORMAT (§17).
 *
 * Data provenance — nothing here is derived on the phone that the gateway can
 * derive better:
 *   · the TODAY / deadline buckets come from `opsagent.ceoBriefing` (§19),
 *     which reads the live kanban + object stores server-side
 *   · the queue comes from `decision.ceoQueue({ triggerFiltered: true })`, so
 *     the §16 trigger gate is applied by the store, not re-implemented here
 *   · project delivery + blocked counts come from `opsagent.projectHealth` (§21)
 *   · the health tiles come from the Phase-1 object stores
 *
 * Every one of those RPCs lands on the next gateway restart. Until then each
 * slice shows a labelled EmptyState. No row on this screen is ever invented.
 */

import React, { useMemo } from 'react';
import { View } from 'react-native';

import {
  AppHeader,
  Card,
  Chip,
  EmptyState,
  ListRow,
  PriorityChip,
  Screen,
  SkeletonRow,
  StatCard,
  Divider,
  SPACE,
  toneColor,
  useUIKit,
} from '../ui-kit';
import { useBusinessObjects } from '../hooks/useBusinessObjects';
import { useOpsAgents } from '../hooks/useOpsAgents';
import { Band, Block, Panel, Provenance, Rows, StatGrid } from './command/CommandBlocks';
import { CeoRequestCard } from './command/CeoRequestCard';
import {
  clientIsActive,
  firesProductDirection,
  fmtIsoDue,
  fmtStamp,
  isCriticalRisk,
  isOutstandingInvoice,
  isoWithinDays,
  money,
  needsCeoApproval,
  oppIsActive,
} from './command/command-shared';

/** A §19 BriefingItem as a dense row. `why` is the whole value of the item. */
function BriefingRow({ item, tone = 'warning' }) {
  return (
    <ListRow
      title={item.summary || 'Untitled'}
      subtitle={item.why}
      meta={
        <>
          {item.dueDate ? <Chip label={fmtIsoDue(item.dueDate)} tone={tone} size="sm" /> : null}
          <PriorityChip priority={item.priority} size="sm" />
        </>
      }
      accessibilityLabel={item.summary}
    />
  );
}

export function ExecutiveCommandCenterScreen({ navigation, gateway }) {
  // `valueTone` on ListRow is a COLOR, not a tone name — resolve through the
  // kit's toneColor so the right-hand data column repaints with the palette.
  const { colors } = useUIKit();
  const sendReq = gateway?.sendReq;

  const ops = useOpsAgents(sendReq);
  const O = useBusinessObjects(sendReq);

  const loading = ops.loading || O.loading;
  const refresh = React.useCallback(() => {
    ops.refresh();
    O.refresh();
  }, [ops.refresh, O.refresh]);

  const briefing = ops.briefing;
  const health = ops.health;
  const today = briefing?.today;

  // ── §15 TODAY ──
  const criticalRisks = useMemo(
    () =>
      (O.risks || [])
        .filter(isCriticalRisk)
        .sort((a, b) => (Number(b.riskScore) || 0) - (Number(a.riskScore) || 0)),
    [O.risks],
  );

  // ── §15 THIS WEEK ──
  const productDecisions = useMemo(
    () => (O.ceoDecisions || []).filter(firesProductDirection),
    [O.ceoDecisions],
  );
  const projectsApproaching = useMemo(
    () =>
      (health?.projects || [])
        .filter((p) => isoWithinDays(p.signals?.dueDate, 14))
        .sort(
          (a, b) =>
            (Date.parse(a.signals?.dueDate || '') || 0) - (Date.parse(b.signals?.dueDate || '') || 0),
        ),
    [health],
  );
  const proposals = useMemo(
    () => (O.opportunities || []).filter((o) => oppIsActive(o) && needsCeoApproval(o)),
    [O.opportunities],
  );

  // ── §15 BUSINESS HEALTH ──
  const activeOpps = useMemo(() => (O.opportunities || []).filter(oppIsActive), [O.opportunities]);
  const activeClients = useMemo(() => (O.clients || []).filter(clientIsActive).length, [O.clients]);
  const pipelineValue = useMemo(
    () => activeOpps.reduce((s, o) => s + (Number(o.estimatedValue) || 0), 0),
    [activeOpps],
  );
  const outstandingInvoices = useMemo(
    () =>
      (O.commitments || [])
        .filter(isOutstandingInvoice)
        .reduce((s, c) => s + (Number(c.remainingBalance ?? c.amount) || 0), 0),
    [O.commitments],
  );
  const healthProjects = health?.projects || [];
  const activeProjects = healthProjects.length;
  const projectsBlocked = healthProjects.filter((p) => (p.signals?.blockedTasks || 0) > 0).length;
  const ceoQueue = O.ceoDecisions || [];

  const todayCount =
    (today?.ceoActions?.length || 0) +
    (today?.decisionsRequired?.length || 0) +
    (today?.criticalBlockers?.length || 0) +
    (today?.clientMatters?.length || 0) +
    criticalRisks.length;
  const weekCount =
    (today?.upcomingDeadlines?.length || 0) +
    productDecisions.length +
    projectsApproaching.length +
    proposals.length;

  const firstLoad = loading && !briefing && !O.anyServed;
  const briefingReason = ops.reasonFor?.('briefing');
  const healthReason = ops.reasonFor?.('health');

  return (
    <Screen
      scroll
      refreshing={loading}
      onRefresh={refresh}
      dockSpace
      header={
        <AppHeader
          eyebrow="Executive Command Center · CEO"
          title="What needs you."
          subtitle={
            firstLoad
              ? 'Loading live business data…'
              : `${todayCount} today · ${ceoQueue.length} on the CEO queue`
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[
            { icon: 'refresh', label: 'Refresh command center', onPress: refresh, busy: loading },
          ]}
        />
      }
    >
      {/* ═══ TODAY ═══ */}
      <Band
        title="Today"
        subtitle="What only the CEO can move today."
        count={todayCount}
      />

      {firstLoad ? (
        <Card padded={SPACE.md}>
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
        </Card>
      ) : !briefing ? (
        <EmptyState
          tone={ops.anyServed ? 'danger' : 'neutral'}
          icon="sunny-outline"
          title="Daily briefing unavailable"
          message={
            briefingReason ||
            'The Daily CEO Briefing agent has not returned yet. Pull to refresh.'
          }
          actionLabel="Retry"
          onAction={refresh}
        />
      ) : (
        <>
          <Panel
            title="Immediate"
            subtitle="CEO tasks, decisions due, and critical blockers."
            count={
              (today?.ceoActions?.length || 0) +
              (today?.decisionsRequired?.length || 0) +
              (today?.criticalBlockers?.length || 0)
            }
            countTone="warning"
          >
            <Block
              title="CEO tasks due today"
              count={today?.ceoActions?.length || 0}
              tone="warning"
            >
              <Rows
                items={today?.ceoActions}
                empty="No CEO tasks due today."
                keyOf={(i) => `${i.kind}:${i.id}`}
                render={(i) => <BriefingRow item={i} tone="warning" />}
              />
            </Block>

            <Block
              title="CEO decisions due"
              count={today?.decisionsRequired?.length || 0}
              tone="danger"
            >
              <Rows
                items={today?.decisionsRequired}
                empty="No decisions due today."
                keyOf={(i) => `${i.kind}:${i.id}`}
                render={(i) => <BriefingRow item={i} tone="danger" />}
              />
            </Block>

            <Block
              title="Critical blockers"
              count={today?.criticalBlockers?.length || 0}
              tone="danger"
            >
              <Rows
                items={today?.criticalBlockers}
                empty="No critical blockers."
                keyOf={(i) => `${i.kind}:${i.id}`}
                render={(i) => <BriefingRow item={i} tone="danger" />}
              />
            </Block>
          </Panel>

          <Panel
            title="Critical risk & clients"
            subtitle="Critical risks and critical client matters."
            count={criticalRisks.length + (today?.clientMatters?.length || 0)}
            countTone={criticalRisks.length || today?.clientMatters?.length ? 'danger' : 'success'}
          >
            <Block title="Critical risks" count={criticalRisks.length} tone="danger">
              <Rows
                items={criticalRisks}
                empty={
                  O.anyServed
                    ? 'No critical risks open.'
                    : 'Restart the gateway to serve risk.list.'
                }
                render={(r) => (
                  <ListRow
                    title={r.title}
                    subtitle={`${r.category || 'risk'}${r.owner ? ` · ${r.owner}` : ''}`}
                    value={r.riskScore ? `score ${r.riskScore}` : undefined}
                    valueTone={toneColor('danger', colors)}
                    meta={<PriorityChip priority={r.priority} size="sm" />}
                    accessibilityLabel={r.title}
                  />
                )}
              />
            </Block>

            <Block
              title="Critical client matters"
              count={today?.clientMatters?.length || 0}
              tone="warning"
            >
              <Rows
                items={today?.clientMatters}
                empty="No critical client matters."
                keyOf={(i) => `${i.kind}:${i.id}`}
                render={(i) => <BriefingRow item={i} tone="warning" />}
              />
            </Block>
          </Panel>
        </>
      )}

      {/* ═══ THIS WEEK ═══ */}
      <Band
        title="This Week"
        subtitle="Approaching — plan the week around these."
        count={weekCount}
      />

      <Panel
        title="Deadlines"
        subtitle="Upcoming deadlines the briefing surfaced."
        count={today?.upcomingDeadlines?.length || 0}
        countTone="primary"
      >
        <Block
          title="Upcoming deadlines"
          count={today?.upcomingDeadlines?.length || 0}
          tone="primary"
        >
          <Rows
            items={today?.upcomingDeadlines}
            empty={
              briefing
                ? 'No deadlines approaching.'
                : briefingReason || 'Briefing unavailable.'
            }
            keyOf={(i) => `${i.kind}:${i.id}`}
            render={(i) => <BriefingRow item={i} tone="primary" />}
          />
        </Block>
      </Panel>

      <Panel
        title="Decisions & delivery"
        subtitle="Product decisions, delivery, and proposals to approve."
        count={productDecisions.length + projectsApproaching.length + proposals.length}
        countTone="primary"
      >
        <Block title="Product decisions" count={productDecisions.length} tone="primary">
          <Rows
            items={productDecisions}
            limit={4}
            empty={
              O.anyServed
                ? 'No product decisions pending.'
                : 'Restart the gateway to serve decision.ceoQueue.'
            }
            render={(d) => (
              <ListRow
                title={d.title}
                subtitle={d.decisionType || 'Product'}
                meta={
                  <>
                    <Chip label="product" tone="primary" size="sm" />
                    <PriorityChip priority={d.priority} size="sm" />
                  </>
                }
                accessibilityLabel={d.title}
              />
            )}
          />
        </Block>

        <Block
          title="Projects approaching delivery"
          count={projectsApproaching.length}
          tone="warning"
        >
          <Rows
            items={projectsApproaching}
            limit={4}
            keyOf={(p) => p.projectId}
            empty={
              health
                ? 'No projects approaching delivery.'
                : healthReason || 'Project Health agent unavailable.'
            }
            render={(p) => (
              <ListRow
                title={p.name}
                subtitle={p.reasons?.[0] || `${p.signals?.openTasks || 0} open tasks`}
                value={fmtIsoDue(p.signals?.dueDate)}
                valueTone={toneColor(p.signals?.deadlinePassed ? 'danger' : 'warning', colors)}
                meta={<Chip label={p.status} tone={p.status === 'Red' ? 'danger' : p.status === 'Yellow' ? 'warning' : 'success'} size="sm" dot />}
                accessibilityLabel={`${p.name}, ${p.status}`}
              />
            )}
          />
        </Block>

        <Block title="Proposals requiring approval" count={proposals.length} tone="warning">
          <Rows
            items={proposals}
            limit={4}
            empty={
              O.anyServed
                ? 'No proposals awaiting approval.'
                : 'Restart the gateway to serve opportunity.list.'
            }
            render={(o) => (
              <ListRow
                title={o.name}
                subtitle={o.stage || 'Proposal'}
                value={o.estimatedValue ? money(o.estimatedValue) : undefined}
                valueTone={toneColor('primary', colors)}
                meta={<Chip label="approve" tone="warning" size="sm" />}
                accessibilityLabel={o.name}
              />
            )}
          />
        </Block>
      </Panel>

      {/* ═══ BUSINESS HEALTH ═══ */}
      <Band title="Business Health" subtitle="The state of the business at a glance." />

      {!O.anyServed && !health ? (
        <EmptyState
          icon="pulse-outline"
          title="Business health not being served"
          message={
            O.unavailableReason ||
            'The Phase 1 object stores land on the next gateway restart. No figures are shown until they are real. Pull down to retry.'
          }
        />
      ) : (
        <StatGrid>
          <StatCard label="Clients" value={activeClients} footnote="active" icon="people-outline" loading={firstLoad} />
          <StatCard label="Projects" value={activeProjects} footnote="active" icon="folder-open-outline" loading={firstLoad} />
          <StatCard label="Opportunities" value={activeOpps.length} footnote="active" icon="briefcase-outline" loading={firstLoad} />
          <StatCard label="Pipeline" value={money(pipelineValue)} footnote="open value" tone="success" icon="trending-up-outline" loading={firstLoad} />
          <StatCard
            label="Invoices out"
            value={money(outstandingInvoices)}
            footnote="outstanding"
            tone={outstandingInvoices ? 'warning' : 'success'}
            icon="receipt-outline"
            loading={firstLoad}
          />
          <StatCard
            label="Blocked"
            value={projectsBlocked}
            footnote="projects"
            tone={projectsBlocked ? 'danger' : 'success'}
            icon="hand-left-outline"
            loading={firstLoad}
          />
          <StatCard
            label="Critical risks"
            value={criticalRisks.length}
            footnote="open"
            tone={criticalRisks.length ? 'danger' : 'success'}
            icon="warning-outline"
            loading={firstLoad}
          />
          <StatCard
            label="CEO decisions"
            value={ceoQueue.length}
            footnote="waiting on you"
            tone={ceoQueue.length ? 'warning' : 'success'}
            icon="help-circle-outline"
            loading={firstLoad}
          />
        </StatGrid>
      )}

      {/* A partially-served set of stores would otherwise read as real zeros. */}
      {O.anyServed && O.unavailableReason ? <Provenance text={O.unavailableReason} /> : null}

      {/* ═══ CEO QUEUE (§16) — rendered in the §17 request format ═══ */}
      <Band
        title="CEO Queue"
        subtitle="Only decisions that fired a CEO Decision Trigger."
        count={ceoQueue.length}
      />

      {firstLoad ? (
        <Card padded={SPACE.md}>
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
        </Card>
      ) : ceoQueue.length ? (
        <View>
          {ceoQueue.slice(0, 12).map((d) => (
            <CeoRequestCard key={d.id} decision={d} />
          ))}
          {ceoQueue.length > 12 ? (
            <Provenance text={`+${ceoQueue.length - 12} more decisions on the queue — open the web CEO queue for the full list.`} />
          ) : null}
        </View>
      ) : (
        <EmptyState
          icon="checkmark-circle-outline"
          tone={O.anyServed ? 'neutral' : 'neutral'}
          title={O.anyServed ? 'The CEO queue is clear' : 'Decision store not being served'}
          message={
            O.anyServed
              ? 'No decision has fired a CEO Decision Trigger. Operational work stays with Operations.'
              : 'decision.ceoQueue lands on the next gateway restart. Until then the queue is empty by design — nothing is fabricated. Pull down to retry.'
          }
        />
      )}

      <Provenance
        text={`Executive Command Center · KIS Phase 1 · exceptions / priorities / decisions only. Briefing generated ${fmtStamp(
          briefing?.generatedAt,
        )}${briefing?.authorityLevel ? ` · authority ${briefing.authorityLevel} (observe & recommend)` : ''}.`}
      />
    </Screen>
  );
}

export default ExecutiveCommandCenterScreen;
