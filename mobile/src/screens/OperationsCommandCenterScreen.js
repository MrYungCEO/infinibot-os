/**
 * Operations Command Center — "Run the organization." (spec §18)
 *
 * The mobile counterpart of `ui/src/ui/views/command-ops.ts`. Where the
 * Executive Command Center shows only what needs the CEO, this gives Operations
 * broad visibility across four panels:
 *
 *   NEEDS ATTENTION  every open loop right now — overdue, blocked, unowned,
 *                    invoices, risks to review, decisions closing in
 *   PORTFOLIO        everything you own: projects, opportunities, clients,
 *                    products
 *   WORKLOAD         who is carrying what, and what nobody is carrying
 *   SYSTEM QUALITY   where the RECORDS need maintenance, not the work
 *
 * "Your dashboard manages the organization. His dashboard manages his attention."
 *
 * Needs Attention and System Quality are both projections of ONE source — the
 * §20 Operations Monitor exception report. The monitor emits a flat list of
 * typed exception groups; `splitExceptionGroups` partitions them so every kind
 * appears in exactly one panel (open loops vs. record hygiene) and an exception
 * kind added to the agent later still surfaces rather than vanishing.
 *
 * Portfolio and Workload read the Phase 1 object stores plus `person.workload`,
 * which derives capacity from the typed-edge relations store.
 */

import React, { useMemo } from 'react';

import {
  AppHeader,
  Card,
  Chip,
  Divider,
  EmptyState,
  ListRow,
  PriorityChip,
  Screen,
  SkeletonRow,
  StatCard,
  StatusChip,
  SPACE,
  toneColor,
  useUIKit,
} from '../ui-kit';
import { useBusinessObjects } from '../hooks/useBusinessObjects';
import { useOpsAgents } from '../hooks/useOpsAgents';
import { usePersonWorkloads } from '../hooks/usePersonWorkloads';
import { Band, Block, Panel, Provenance, Rows, StatGrid } from './command/CommandBlocks';
import {
  clientIsActive,
  exceptionTone,
  fmtIsoDue,
  fmtStamp,
  groupTotal,
  healthTone,
  money,
  oppIsActive,
  plural,
  splitExceptionGroups,
} from './command/command-shared';

const FOUNDER_RE = /founder|owner|ceo|principal/i;

/** One §20 Exception as a dense row. */
function ExceptionRow({ item, tone }) {
  const { colors } = useUIKit();
  return (
    <ListRow
      title={item.title || 'Untitled'}
      subtitle={item.detail}
      value={item.dueDate ? fmtIsoDue(item.dueDate) : undefined}
      valueTone={toneColor(tone, colors)}
      meta={
        <>
          <Chip label={item.objectType} tone="neutral" size="sm" />
          {item.owner ? <Chip label={item.owner} tone="neutral" size="sm" /> : null}
          <PriorityChip priority={item.priority} size="sm" />
        </>
      }
      accessibilityLabel={item.title}
    />
  );
}

/** Render one exception group as a Block of rows. */
function ExceptionGroupBlock({ group }) {
  const tone = exceptionTone(group.kind);
  return (
    <Block title={group.label} count={group.count} tone={tone}>
      <Rows
        items={group.items}
        empty="Nothing here."
        keyOf={(x, i) => `${group.kind}:${x.id}:${i}`}
        render={(x) => <ExceptionRow item={x} tone={tone} />}
      />
    </Block>
  );
}

export function OperationsCommandCenterScreen({ navigation, gateway }) {
  // ListRow's `valueTone` is a COLOR, not a tone name.
  const { colors } = useUIKit();
  const sendReq = gateway?.sendReq;

  const ops = useOpsAgents(sendReq);
  const O = useBusinessObjects(sendReq);
  const { workloads, truncated: workloadTruncated } = usePersonWorkloads(sendReq, O.people);

  const loading = ops.loading || O.loading;
  const refresh = React.useCallback(() => {
    ops.refresh();
    O.refresh();
  }, [ops.refresh, O.refresh]);

  const monitor = ops.monitor;
  const health = ops.health;

  // ── PANEL 1 + 4 · the exception report, partitioned ──
  const { attention, quality } = useMemo(() => splitExceptionGroups(monitor), [monitor]);
  const attnCount = groupTotal(attention);
  const qualityCount = groupTotal(quality);

  // ── PANEL 2 · PORTFOLIO ──
  const projects = health?.projects || [];
  const activeOpps = useMemo(() => (O.opportunities || []).filter(oppIsActive), [O.opportunities]);
  const clients = O.clients || [];
  const products = O.products || [];

  // ── PANEL 3 · WORKLOAD ──
  const people = O.people || [];
  const ranked = useMemo(
    () =>
      people
        .map((p) => ({ person: p, load: workloads[p.id] }))
        .filter((r) => r.load)
        .sort((a, b) => (b.load.totalLinks || 0) - (a.load.totalLinks || 0)),
    [people, workloads],
  );
  const founder = useMemo(
    () => people.find((p) => FOUNDER_RE.test(`${p.role || ''} ${p.relationshipType || ''}`)),
    [people],
  );
  const founderLoad = founder ? workloads[founder.id] : undefined;

  // Unowned work: the monitor already found it. Re-presented here by the
  // question Workload answers ("what is nobody carrying?") rather than
  // duplicating the Needs Attention group.
  const unownedGroup = useMemo(
    () => (monitor?.groups || []).find((g) => g.kind === 'missing_owner'),
    [monitor],
  );

  const firstLoad = loading && !monitor && !O.anyServed;
  const monitorReason = ops.reasonFor?.('monitor');
  const healthReason = ops.reasonFor?.('health');

  return (
    <Screen
      scroll
      refreshing={loading}
      onRefresh={refresh}
      dockSpace
      header={
        <AppHeader
          eyebrow="Operations Command Center"
          title="Run the organization."
          subtitle={
            firstLoad
              ? 'Loading live business data…'
              : `${attnCount} needing attention · ${plural(projects.length, 'active project')}`
          }
          leftIcon="chevron-back"
          leftLabel="Back"
          onLeftPress={() => navigation?.goBack()}
          rightActions={[
            { icon: 'refresh', label: 'Refresh operations center', onPress: refresh, busy: loading },
          ]}
        />
      }
    >
      {/* ═══ AT A GLANCE ═══ */}
      <Band title="At a glance" subtitle="The four panels, sized." />
      <StatGrid>
        <StatCard
          label="Attention"
          value={monitor ? attnCount : '—'}
          footnote={monitor ? 'open loops' : 'not served'}
          tone={!monitor ? 'neutral' : attnCount ? 'danger' : 'success'}
          icon="alert-circle-outline"
          loading={firstLoad}
        />
        <StatCard
          label="Projects"
          value={health ? projects.length : '—'}
          footnote={health ? 'active' : 'not served'}
          tone="primary"
          icon="folder-open-outline"
          loading={firstLoad}
        />
        <StatCard
          label="People"
          value={O.anyServed ? people.length : '—'}
          footnote={O.anyServed ? 'tracked' : 'not served'}
          tone="primary"
          icon="people-outline"
          loading={firstLoad}
        />
        <StatCard
          label="Record debt"
          value={monitor ? qualityCount : '—'}
          footnote={monitor ? 'hygiene issues' : 'not served'}
          tone={!monitor ? 'neutral' : qualityCount ? 'warning' : 'success'}
          icon="construct-outline"
          loading={firstLoad}
        />
      </StatGrid>

      {/* ═══ PANEL 1 · NEEDS ATTENTION ═══ */}
      <Band title="Needs Attention" subtitle="Everything with an open loop right now." count={attnCount} />

      {firstLoad ? (
        <Card padded={SPACE.md}>
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
          <Divider inset />
          <SkeletonRow />
        </Card>
      ) : !monitor ? (
        <EmptyState
          tone={ops.anyServed ? 'danger' : 'neutral'}
          icon="alert-circle-outline"
          title="Operations Monitor unavailable"
          message={
            monitorReason ||
            'The Operations Monitor agent has not returned yet. Pull to refresh.'
          }
          actionLabel="Retry"
          onAction={refresh}
        />
      ) : !attention.length ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title="No open loops"
          message="The Operations Monitor found no exceptions in this category. This is an exception report, not a summary — an empty panel means a clean org."
        />
      ) : (
        <Panel
          title="Exceptions"
          subtitle="Open operational loops, grouped by kind."
          count={attnCount}
          countTone={attnCount ? 'danger' : 'success'}
        >
          {attention.map((g) => (
            <ExceptionGroupBlock key={g.kind} group={g} />
          ))}
        </Panel>
      )}

      {/* ═══ PANEL 2 · PORTFOLIO ═══ */}
      <Band
        title="Portfolio"
        subtitle="Everything you own, at a glance."
        count={projects.length + activeOpps.length + clients.length + products.length}
      />

      <Panel
        title="Portfolio"
        subtitle="Projects, opportunities, clients and products."
        count={projects.length + activeOpps.length + clients.length + products.length}
      >
        <Block title="Active projects" count={projects.length} tone="primary">
          <Rows
            items={projects}
            limit={6}
            keyOf={(p) => p.projectId}
            empty={health ? 'No active projects.' : healthReason || 'Project Health agent unavailable.'}
            render={(p) => (
              <ListRow
                title={p.name}
                subtitle={p.reasons?.[0] || `${p.signals?.openTasks || 0} open · ${p.signals?.blockedTasks || 0} blocked`}
                value={p.signals?.dueDate ? fmtIsoDue(p.signals.dueDate) : undefined}
                valueTone={toneColor(p.signals?.deadlinePassed ? 'danger' : 'neutral', colors)}
                meta={<Chip label={p.status} tone={healthTone(p.status)} size="sm" dot />}
                accessibilityLabel={`${p.name}, ${p.status}`}
              />
            )}
          />
        </Block>

        <Block title="Active opportunities" count={activeOpps.length} tone="primary">
          <Rows
            items={[...activeOpps].sort(
              (a, b) => (Number(b.estimatedValue) || 0) - (Number(a.estimatedValue) || 0),
            )}
            limit={5}
            empty={O.anyServed ? 'No opportunities.' : 'Restart the gateway to serve opportunity.list.'}
            render={(o) => (
              <ListRow
                title={o.name}
                subtitle={o.stage || o.status || 'New'}
                value={o.estimatedValue ? money(o.estimatedValue) : undefined}
                valueTone={toneColor('primary', colors)}
                meta={<StatusChip status={o.stage || o.status} size="sm" />}
                accessibilityLabel={o.name}
              />
            )}
          />
        </Block>

        <Block title="Clients" count={clients.length} tone="neutral">
          <Rows
            items={clients}
            limit={5}
            empty={O.anyServed ? 'No clients.' : 'Restart the gateway to serve clients.list.'}
            render={(c) => (
              <ListRow
                title={c.name}
                subtitle={c.pipelineStatus || c.status}
                meta={
                  <Chip
                    label={clientIsActive(c) ? 'active' : c.status || '—'}
                    tone={clientIsActive(c) ? 'success' : 'neutral'}
                    size="sm"
                  />
                }
                accessibilityLabel={c.name}
              />
            )}
          />
        </Block>

        <Block title="Product status" count={products.length} tone="primary">
          <Rows
            items={products}
            limit={5}
            empty={O.anyServed ? 'No products.' : 'Restart the gateway to serve product.list.'}
            render={(p) => (
              <ListRow
                title={p.name}
                subtitle={p.productType || 'product'}
                meta={<StatusChip status={p.status} size="sm" />}
                accessibilityLabel={p.name}
              />
            )}
          />
        </Block>
      </Panel>

      {/* ═══ PANEL 3 · WORKLOAD ═══ */}
      <Band title="Workload" subtitle="Who is carrying what." count={ranked.length} />

      <Panel
        title="Capacity"
        subtitle="Derived from the typed-edge relations store, never stored on the record."
        count={ranked.length}
      >
        <Block title="Founder workload" count={founderLoad ? 1 : 0} tone={founderLoad ? 'primary' : 'neutral'}>
          {founderLoad ? (
            <ListRow
              title={founder.name}
              subtitle={`${founder.role || 'Founder'}${founder.availability ? ` · ${founder.availability}` : ''}`}
              value={`${founderLoad.activeTaskCount}/${founderLoad.taskCount}`}
              valueTone={toneColor(founderLoad.totalLinks > 8 ? 'danger' : 'primary', colors)}
              meta={<Chip label={`${founderLoad.totalLinks} linked`} tone={founderLoad.totalLinks > 8 ? 'danger' : 'primary'} size="sm" />}
              accessibilityLabel={`${founder.name} workload`}
            />
          ) : (
            <Rows
              items={[]}
              empty={
                O.anyServed
                  ? 'No founder identified — add a Person whose role is Founder.'
                  : 'Restart the gateway to serve person.list.'
              }
              render={() => null}
            />
          )}
        </Block>

        <Block title="Work by owner" count={ranked.length} tone="primary">
          <Rows
            items={ranked}
            limit={8}
            keyOf={(r) => r.person.id}
            empty={O.anyServed ? 'No assigned work.' : 'Restart the gateway to serve person.workload.'}
            render={({ person, load }) => (
              <ListRow
                title={person.name}
                subtitle={`${load.activeTaskCount} active · ${plural(load.projectCount, 'project')} · ${plural(load.decisionCount, 'decision')}`}
                value={String(load.totalLinks)}
                valueTone={toneColor(load.totalLinks > 8 ? 'danger' : load.totalLinks > 4 ? 'warning' : 'neutral', colors)}
                meta={person.role ? <Chip label={person.role} tone="neutral" size="sm" /> : null}
                accessibilityLabel={`${person.name}, ${load.totalLinks} linked items`}
              />
            )}
          />
          {workloadTruncated > 0 ? (
            <Provenance
              text={`Workload derived for the first ${ranked.length} of ${people.length} people — ${workloadTruncated} not queried.`}
            />
          ) : null}
        </Block>

        <Block
          title="Unowned work"
          count={unownedGroup?.count || 0}
          tone={unownedGroup?.count ? 'warning' : 'success'}
        >
          <Rows
            items={unownedGroup?.items}
            limit={5}
            keyOf={(x, i) => `unowned:${x.id}:${i}`}
            empty={monitor ? 'Everything is owned.' : monitorReason || 'Operations Monitor unavailable.'}
            render={(x) => <ExceptionRow item={x} tone="warning" />}
          />
        </Block>
      </Panel>

      {/* ═══ PANEL 4 · SYSTEM QUALITY ═══ */}
      <Band
        title="System Quality"
        subtitle="Where the records themselves need maintenance."
        count={qualityCount}
      />

      {!monitor ? (
        <EmptyState
          icon="construct-outline"
          title="Record quality unavailable"
          message={
            monitorReason || 'The Operations Monitor agent has not returned yet. Pull down to retry.'
          }
        />
      ) : !quality.length ? (
        <EmptyState
          icon="checkmark-circle-outline"
          title="Records are clean"
          message="No stale records, missing deadlines, missing next actions or un-followed-up opportunities."
        />
      ) : (
        <Panel
          title="Record hygiene"
          subtitle="Maintenance the organization owes its own data."
          count={qualityCount}
          countTone={qualityCount ? 'warning' : 'success'}
        >
          {quality.map((g) => (
            <ExceptionGroupBlock key={g.kind} group={g} />
          ))}
        </Panel>
      )}

      <Provenance
        text={`Operations Command Center · KIS Phase 1 · full-visibility operating view. Monitor generated ${fmtStamp(
          monitor?.generatedAt,
        )} · ${monitor ? `${monitor.totalExceptions} exceptions` : 'not served'}${
          monitor?.authorityLevel ? ` · authority ${monitor.authorityLevel} (observe & recommend)` : ''
        }.`}
      />
    </Screen>
  );
}


export default OperationsCommandCenterScreen;
