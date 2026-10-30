/**
 * AgencyOperationsScreen — native Agencies page (web /agency-operations, which
 * the live control UI hosts as /ceo?view=agencies). Business & Agency plugin.
 *
 * Same data and actions as ui/src/ui/views/agency-operations.ts, via the same
 * agency.ops.* / kanban.* / notes.* RPCs:
 *   - agency switcher, + New agency, Share, shared-data sync banner
 *     (export / merge snapshot, sync now, conflicts)
 *   - ten sections in a scrollable tab bar: Command center, Projects & tasks,
 *     Clients & revenue, Employees, Employee ops, Work allocation, Approval
 *     inbox, Activity & audit, Reliability, Agency settings
 *   - detail sheets: project page, client profile, employee profile, invoice
 *     composer, client revenue; every create/edit dialog as a FormSheet.
 *
 * Data + mutations: ./ops/useAgencyOps.js. Pure logic: ./ops/agency-ops-*.js.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppHeader, Button, Chip, Screen, Skeleton, SPACE, Tabs, useUIKit, EmptyState } from '../../ui-kit';
import { PluginGate } from '../../components/PluginGate';
import * as Clipboard from 'expo-clipboard';
import { openWebPath } from '../../navigation/web-link';
import { useAgencyOps } from './ops/useAgencyOps';
import { SECTIONS } from './ops/agency-ops-model';
import {
  DIALOG_TITLES,
  INDEPENDENT_CALL_KINDS,
  PROFILE_TABS,
  buildDraft,
  dialogCalls,
  dialogFields,
  dialogValid,
  isEditDialog,
} from './ops/agency-ops-forms';
import { FormSheet, Notice, SelectField, Meta } from './ops/ui';
import { SyncBanner } from './ops/SyncBanner';
import { OverviewTab } from './ops/OverviewTab';
import { DeliveryTab } from './ops/DeliveryTab';
import { FinanceTab } from './ops/FinanceTab';
import { EmployeesTab } from './ops/EmployeesTab';
import { EmployeeOpsTab } from './ops/EmployeeOpsTab';
import { AllocationTab } from './ops/AllocationTab';
import { ApprovalsTab, ActivityTab } from './ops/InboxTabs';
import { ReliabilityTab } from './ops/ReliabilityTab';
import { SettingsTab } from './ops/SettingsTab';
import { ProjectDetailSheet } from './ops/ProjectDetailSheet';
import { ClientProfileSheet } from './ops/ClientProfileSheet';
import { EmployeeDetailSheet } from './ops/EmployeeDetailSheet';
import { InvoiceComposerSheet } from './ops/InvoiceComposerSheet';
import { ClientRevenueSheet } from './ops/ClientRevenueSheet';
import { PaymentKeysSheet } from './ops/PaymentKeysSheet';

const TAB_COMPONENTS = {
  overview: OverviewTab,
  delivery: DeliveryTab,
  finance: FinanceTab,
  employees: EmployeesTab,
  'employee-ops': EmployeeOpsTab,
  allocation: AllocationTab,
  approvals: ApprovalsTab,
  activity: ActivityTab,
  reliability: ReliabilityTab,
  settings: SettingsTab,
};

export function AgencyOperationsScreen({ navigation, route, gateway }) {
  const { colors, type } = useUIKit();
  const ops = useAgencyOps(gateway);
  const s = ops.state;
  const [section, setSection] = useState(route?.params?.section && TAB_COMPONENTS[route.params.section] ? route.params.section : 'overview');
  // Deep links / the Grid's agency panel pass the web section id (e.g. 'finance').
  const requestedSection = route?.params?.section;
  useEffect(() => {
    if (requestedSection && TAB_COMPONENTS[requestedSection]) setSection(requestedSection);
  }, [requestedSection]);
  const [dialog, setDialog] = useState(null); // { draft, error, saving }
  const [projectId, setProjectId] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [employeeId, setEmployeeId] = useState(null);
  const [employeeRefresh, setEmployeeRefresh] = useState(0);
  const [composer, setComposer] = useState(null); // { clientId, backdated }
  const [revenueClientId, setRevenueClientId] = useState(null);
  const [delivery, setDelivery] = useState({ view: 'list', clientFilter: '', projectFilter: '' });
  const [share, setShare] = useState(null); // { link, status }
  const [notice, setNotice] = useState(null);
  const [paymentKeysOpen, setPaymentKeysOpen] = useState(false);

  const flash = useCallback((text, tone = 'success') => {
    setNotice({ text, tone });
    setTimeout(() => setNotice((n) => (n && n.text === text ? null : n)), 5000);
  }, []);

  // ── dialogs ────────────────────────────────────────────────────────────────
  const openDialog = useCallback(async (kind, opts = {}) => {
    let detail = opts.detail;
    if (kind === 'employee-profile' && !detail && s.selectedAgencyId) {
      setDialog({ draft: buildDraft(kind, s, opts), error: null, saving: false, loadingDetail: true });
      try {
        detail = await ops.req('agency.ops.employee.detail', { agencyId: s.selectedAgencyId, workerId: opts.entityId });
      } catch (e) {
        setDialog((d) => d && { ...d, loadingDetail: false, error: `Stored profile could not be read: ${e?.message || e}. Fields show defaults — saving writes them over the record.` });
        return;
      }
      setDialog((d) => (d && d.draft.employeeId === opts.entityId ? { ...d, draft: { ...buildDraft(kind, s, { ...opts, detail }), tab: d.draft.tab }, loadingDetail: false } : d));
      return;
    }
    setDialog({ draft: buildDraft(kind, s, { ...opts, detail }), error: null, saving: false });
  }, [s, ops]);

  const patchDialog = useCallback((p) => setDialog((d) => (d ? { ...d, draft: { ...d.draft, ...p } } : d)), []);

  const submitDialog = useCallback(async () => {
    if (!dialog) return;
    const draft = dialog.draft;
    if (draft.kind !== 'agency' && !s.selectedAgencyId) { setDialog({ ...dialog, error: 'Select an agency first.' }); return; }
    setDialog({ ...dialog, saving: true, error: null });
    const calls = dialogCalls(draft, s.selectedAgencyId, { employees: s.employees });
    const rejected = [];
    let lastResult = null;
    for (const [method, params] of calls) {
      try {
        lastResult = await ops.call(method, params, { quiet: true });
      } catch (e) {
        rejected.push(`${method} — ${e?.message || e}`);
        ops.addFailure(method, e);
        if (!INDEPENDENT_CALL_KINDS.has(draft.kind)) break;
      }
    }
    if (rejected.length) {
      setDialog((d) => d && { ...d, saving: false, error: rejected.join('; ') });
      return;
    }
    setDialog(null);
    if (draft.kind === 'agency') {
      const created = lastResult?.agency ?? lastResult;
      if (created?.id) ops.selectAgency(created.id); else ops.load({ background: true });
      flash(`Agency "${draft.name.trim()}" created.`);
      return;
    }
    if (draft.kind === 'share') {
      setShare({ link: lastResult?.joinUrl ?? null, status: lastResult?.collaboration?.message ?? lastResult?.collaboration?.state ?? null });
    } else {
      flash(isEditDialog(draft) ? 'Changes saved.' : `${DIALOG_TITLES[draft.kind].replace(/^(Create|Add|Start|Schedule|Hand|Attach)\s*/, '')} created.`);
    }
    if (draft.kind.startsWith('employee-')) setEmployeeRefresh((n) => n + 1);
    ops.load({ background: true });
  }, [dialog, s, ops, flash]);

  // ── navigation helpers ───────────────────────────────────────────────────
  const focusClientProjects = useCallback((cid) => {
    setDelivery({ view: 'list', clientFilter: cid, projectFilter: '' });
    setClientId(null);
    setSection('delivery');
  }, []);
  const focusProjectTasks = useCallback((pid) => {
    setDelivery({ view: 'board', clientFilter: '', projectFilter: pid });
    setProjectId(null);
    setSection('delivery');
  }, []);

  // ── shared mutations ─────────────────────────────────────────────────────
  const agencyId = s.selectedAgencyId;
  const guarded = useCallback(async (fn) => { try { await fn(); } catch { /* recorded in failures */ } }, []);

  const ctx = useMemo(() => ({
    ops,
    navigation,
    section,
    setSection,
    delivery,
    setDelivery,
    flash,
    copy: async (text) => { try { await Clipboard.setStringAsync(String(text)); flash('Copied to clipboard.'); } catch { flash('Copy failed.', 'danger'); } },
    openDialog,
    openEmployeeEditor: (id, tab = 'identity') => openDialog('employee-profile', { entityId: id, tab }),
    openProject: (id) => setProjectId(id),
    openClient: (id) => setClientId(id),
    openEmployee: (id) => setEmployeeId(id),
    openInvoiceComposer: (opts = {}) => setComposer({ clientId: opts.clientId ?? '', backdated: !!opts.backdated }),
    openClientRevenue: (id) => setRevenueClientId(id),
    openHub: (hubSection) => openWebPath(navigation, `/hub?view=${hubSection}`, hubSection === 'pipeline' ? 'Pipeline' : 'Revenue'),
    focusClientProjects,
    focusProjectTasks,
    setKanbanProjectStatus: (id, status) => guarded(async () => {
      const prev = s.kanbanProjects.find((p) => p.id === id)?.status;
      ops.mutateList('kanbanProjects', id, { status });
      try { await ops.call('kanban.projects.update', { id, patch: { status } }, { busyKey: id }); } catch (e) { ops.mutateList('kanbanProjects', id, { status: prev }); throw e; }
    }),
    setKanbanTaskStatus: (id, status) => guarded(async () => {
      const prev = s.kanbanTasks.find((t) => t.id === id);
      ops.mutateList('kanbanTasks', id, { status, done: status === 'done' });
      try { await ops.call('kanban.tasks.update', { id, patch: { status, done: status === 'done' } }, { busyKey: id }); } catch (e) { if (prev) ops.mutateList('kanbanTasks', id, { status: prev.status, done: prev.done }); throw e; }
    }),
    transitionTask: (id, status) => guarded(async () => {
      const prev = s.tasks.find((t) => t.id === id)?.status;
      ops.mutateList('tasks', id, { status });
      try { await ops.call('agency.ops.tasks.transition', { agencyId, taskId: id, status }, { busyKey: id }); } catch (e) { ops.mutateList('tasks', id, { status: prev }); throw e; }
    }),
    assignTask: (id, employee) => guarded(async () => {
      const prev = s.tasks.find((t) => t.id === id);
      ops.mutateList('tasks', id, { assigneeId: employee?.id ?? null, assigneeType: employee?.kind ?? null });
      try {
        await ops.call('agency.ops.tasks.assign', { agencyId, taskId: id, assigneeId: employee?.id, assigneeType: employee?.kind }, { busyKey: `assign:${id}` });
      } catch (e) { if (prev) ops.mutateList('tasks', id, { assigneeId: prev.assigneeId, assigneeType: prev.assigneeType }); throw e; }
    }),
    transitionProject: (id, status) => guarded(async () => {
      const prev = s.projects.find((p) => p.id === id)?.status;
      ops.mutateList('projects', id, { status });
      try { await ops.call('agency.ops.projects.transition', { agencyId, projectId: id, status }, { busyKey: id }); } catch (e) { ops.mutateList('projects', id, { status: prev }); throw e; }
    }),
    setClientStatus: (id, status) => guarded(async () => {
      const prev = s.clients.find((c) => c.id === id)?.status;
      ops.mutateList('clients', id, { status });
      try { await ops.call('agency.ops.clients.update', { agencyId, clientId: id, status }, { busyKey: `client:${id}` }); } catch (e) { ops.mutateList('clients', id, { status: prev }); throw e; }
    }),
    setClientPipeline: (id, label) => guarded(async () => {
      const prev = s.clients.find((c) => c.id === id);
      ops.mutateList('clients', id, { pipelineStatus: label.toLowerCase(), pipelineStatusLabel: label });
      try {
        const r = await ops.call('agency.ops.clients.update', { agencyId, clientId: id, pipelineStatus: label }, { busyKey: `client:${id}` });
        if (r?.client) ops.mutateList('clients', id, { status: r.client.status, pipelineStatus: r.client.pipelineStatus, pipelineStatusLabel: r.client.pipelineStatusLabel });
      } catch (e) { if (prev) ops.mutateList('clients', id, { status: prev.status, pipelineStatus: prev.pipelineStatus, pipelineStatusLabel: prev.pipelineStatusLabel }); throw e; }
    }),
    openPaymentKeys: () => setPaymentKeysOpen(true),
    transitionWorkItem: (id, status) => guarded(async () => {
      const r = await ops.call('agency.ops.employee.work-item.transition', { agencyId, workItemId: id, status }, { busyKey: id });
      const updated = r?.workItem;
      ops.mutateList('workItems', id, updated || { status });
    }),
    decide: (item, approve) => guarded(async () => {
      if (item.kind === 'approval') {
        await ops.call('agency.ops.approval.resolve', { agencyId, approvalId: item.id, decision: approve ? 'approved' : 'rejected' }, { busyKey: item.id });
        ops.patch((prev) => ({ approvals: prev.approvals.filter((a) => a.id !== item.id) }));
      } else {
        const r = await ops.call('agency.ops.employee.work-item.transition', { agencyId, workItemId: item.id, status: approve ? 'accepted' : 'cancelled' }, { busyKey: item.id });
        ops.mutateList('workItems', item.id, r?.workItem || { status: approve ? 'accepted' : 'cancelled' });
      }
      flash(approve ? 'Approved.' : 'Declined.');
    }),
  }), [ops, navigation, section, delivery, flash, openDialog, focusClientProjects, focusProjectTasks, guarded, s, agencyId]);

  const TabBody = TAB_COMPONENTS[section] || OverviewTab;
  const agencyOptions = s.agencies.map((a) => [a.id, `${a.name}${a.role === 'owner' ? '' : ' (shared)'}`]);
  const tabs = SECTIONS.map((sec) => ({
    key: sec.key,
    label: sec.key === 'approvals' && s.approvals.length ? `${sec.label} ${s.approvals.length}` : sec.label,
    icon: sec.icon,
  }));
  const fields = dialog ? dialogFields(dialog.draft, s) : [];

  const body = (
    <View style={{ flex: 1 }}>
      <AppHeader
        variant="nav"
        title="Agencies"
        subtitle={ops.agency?.name}
        leftIcon="chevron-back"
        leftLabel="Back"
        onLeftPress={() => navigation?.goBack?.()}
        rightActions={[{ icon: 'refresh', label: 'Refresh', onPress: () => ops.load({ background: true }), busy: s.refreshing }]}
      />
      <Screen
        edges={['bottom', 'left', 'right']}
        refreshing={s.refreshing}
        onRefresh={() => ops.load({ background: true })}
        testID="agency-ops-screen"
      >
        <View style={styles.hero}>
          <Text style={[type.label, { color: colors.primary }]}>Agency operations center</Text>
          <Text style={[type.h1, { color: colors.text }]}>{section === 'overview' ? 'Agency Operations Center' : 'Agency Operating System'}</Text>
          <Text style={[type.small, { color: colors.textSecondary }]}>Revenue, delivery, decisions and workforce in one operating rhythm.</Text>
        </View>

        {s.agencies.length ? (
          <View style={[styles.agencyBar, { borderColor: colors.border }]}>
            <View style={{ flex: 1, minWidth: 200 }}>
              <SelectField label="Current agency" value={s.selectedAgencyId} options={agencyOptions} onChange={ops.selectAgency} compact testID="aops-agency-switcher" />
            </View>
            {ops.agency ? (
              <View style={styles.roleCol}>
                <Chip label={ops.agency.role} tone="primary" size="sm" />
                <Meta>{ops.agency.role === 'owner' ? 'Owned by you' : `Owned by ${ops.agency.ownerName ?? 'another operator'}`}</Meta>
              </View>
            ) : null}
            <View style={styles.agencyActions}>
              {ops.caps.canAdmin ? <Button title="Share" size="sm" variant="secondary" icon="share-social-outline" onPress={() => openDialog('share')} accessibilityLabel="Share agency" /> : null}
              <Button title="New agency" size="sm" icon="add" onPress={() => openDialog('agency')} accessibilityLabel="Create a new agency" />
            </View>
          </View>
        ) : null}

        {s.selectedAgencyId ? <SyncBanner ctx={ctx} /> : null}

        <Tabs tabs={tabs} active={section} onSelect={setSection} style={{ marginBottom: SPACE.md }} testID="aops-sections" />

        {notice ? <Notice tone={notice.tone} text={notice.text} /> : null}
        {share ? (
          <Notice tone={share.link ? 'success' : 'info'} title={share.link ? 'Private collaboration link ready.' : 'Share request sent.'} text={share.status ?? 'Only verified members of your Tailscale network can open it.'}>
            {share.link ? <Text selectable style={[type.monoSmall, { color: colors.text }]}>{share.link}</Text> : null}
            <View style={{ flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs }}>
              {share.link ? <Button title="Copy link" size="sm" variant="secondary" onPress={() => ctx.copy(share.link)} accessibilityLabel="Copy collaboration link" /> : null}
              <Button title="Dismiss" size="sm" variant="ghost" onPress={() => setShare(null)} accessibilityLabel="Dismiss" />
            </View>
          </Notice>
        ) : null}
        {section === 'overview' && s.migration?.sourceExists ? (
          <Notice
            tone="info"
            title="Legacy business data secured in Agency OS."
            text={`${s.migration.businessesFound} businesses, ${s.migration.clientsImported} clients, ${s.migration.projectsImported} projects and ${s.migration.tasksImported} tasks synchronized.${s.migration.projectsQuarantined || s.migration.databaseRowsQuarantined ? ` ${s.migration.projectsQuarantined} unassigned projects and ${s.migration.databaseRowsQuarantined} database rows were moved to Legacy Unassigned.` : ''}`}
          />
        ) : null}
        {s.error ? (
          <Notice tone="danger" text={s.error}>
            <View style={{ flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs }}>
              <Button title="Retry" size="sm" variant="secondary" onPress={() => ops.load({ background: true })} accessibilityLabel="Retry loading" />
              <Button title="Dismiss" size="sm" variant="ghost" onPress={ops.dismissError} accessibilityLabel="Dismiss error" />
            </View>
          </Notice>
        ) : null}
        {s.failures.length ? (
          <Notice tone="warning" title={`${s.failures.length} panel${s.failures.length === 1 ? '' : 's'} failed to load.`} text="Data shown below may be incomplete or stale.">
            {s.failures.slice(0, 6).map((f) => <Meta key={f} numberOfLines={2}>{f}</Meta>)}
          </Notice>
        ) : null}

        {s.loading && !s.lastLoadedAt ? (
          <View style={{ gap: SPACE.md }} testID="aops-loading">
            <Skeleton height={96} />
            <Skeleton height={180} />
            <Skeleton height={180} />
          </View>
        ) : !gateway || ops.connected === false && !s.lastLoadedAt ? (
          <EmptyState icon="cloud-offline-outline" title="Not connected" message="Connect to your gateway to load agency operations." actionLabel="Retry" onAction={() => ops.load()} />
        ) : !s.agencies.length ? (
          <EmptyState icon="briefcase-outline" title="No agencies yet" message="Create an agency to start running clients, delivery and an AI workforce." actionLabel="New agency" onAction={() => openDialog('agency')} />
        ) : (
          <TabBody ctx={ctx} />
        )}
      </Screen>

      <FormSheet
        visible={!!dialog}
        title={dialog ? DIALOG_TITLES[dialog.draft.kind] : ''}
        subtitle={dialog?.loadingDetail ? 'Loading the stored profile…' : undefined}
        fields={fields}
        draft={dialog?.draft}
        onPatch={patchDialog}
        onSubmit={submitDialog}
        onClose={() => setDialog(null)}
        saving={dialog?.saving}
        error={dialog?.error}
        valid={dialog ? dialogValid(dialog.draft) : false}
        submitLabel={dialog ? (dialog.saving ? 'Saving' : isEditDialog(dialog.draft) ? 'Save changes' : 'Create') : ''}
        tabs={dialog?.draft.kind === 'employee-profile' ? PROFILE_TABS : null}
      />
      <ProjectDetailSheet ctx={ctx} projectId={projectId} onClose={() => setProjectId(null)} />
      <ClientProfileSheet ctx={ctx} clientId={clientId} onClose={() => setClientId(null)} />
      <EmployeeDetailSheet ctx={ctx} employeeId={employeeId} refreshKey={employeeRefresh} onClose={() => setEmployeeId(null)} />
      <InvoiceComposerSheet ctx={ctx} options={composer} onClose={() => setComposer(null)} />
      <ClientRevenueSheet ctx={ctx} clientId={revenueClientId} onClose={() => setRevenueClientId(null)} />
      <PaymentKeysSheet ctx={ctx} visible={paymentKeysOpen} onClose={() => setPaymentKeysOpen(false)} />
    </View>
  );

  return <PluginGate pluginId="business-agency" title="Agencies" navigation={navigation}>{body}</PluginGate>;
}

const styles = StyleSheet.create({
  hero: { paddingTop: SPACE.md, paddingBottom: SPACE.md, gap: 4 },
  agencyBar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: SPACE.sm, borderWidth: 1, borderRadius: 16, padding: SPACE.md, marginBottom: SPACE.md },
  roleCol: { gap: 4, alignItems: 'flex-start', paddingBottom: 4 },
  agencyActions: { flexDirection: 'row', gap: SPACE.sm, flexWrap: 'wrap' },
});

export default AgencyOperationsScreen;
