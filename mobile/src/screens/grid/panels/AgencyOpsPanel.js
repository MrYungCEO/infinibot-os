/**
 * AgencyOpsPanel — web agencyOps grid tile (view-adapter renderAgencyOpsTabPanel):
 * the Agency Operations Center scoped to one section.
 *
 * Same agency.ops.* RPCs as ui/src/ui/controllers/agency-operations.ts:
 *   agency.ops.agencies.list                     agency picker (persists `agencyId`)
 *   overview    agency.ops.dashboard              KPI tiles
 *   allocation  agency.ops.employees.list         capacity / utilisation bars
 *   approvals   agency.ops.approvals.list {status:'pending'} + agency.ops.approval.resolve
 *   activity    agency.ops.audit.list {limit}
 *   employees   agency.ops.employees.list
 * "Open Agencies" goes to the full native Agency Operations screen at that section.
 */
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Button, ListRow, ProgressBar, SPACE, RADIUS, StatCard, StatusChip, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { navigateToScreen } from '../../../navigation/screen-registry';
import { usePluginAvailability } from '../../../components/PluginGate';
import { AGENCY_SECTIONS } from '../grid-model';
import { agencyRows, auditRows, employeeRows, humanize, relTime } from '../grid-data';
import { PanelEmpty, PanelError, PanelLoading, PanelOpen, useRpc, withTimeout } from '../panel-kit';

const T = 20000;

export function AgencyOpsPanel({ panel, gateway, navigation, onPatch, refreshSignal }) {
  const { colors, type } = useUIKit();
  const avail = usePluginAvailability('business-agency');
  const section = AGENCY_SECTIONS[panel.agencyOpsSection] ? panel.agencyOpsSection : 'overview';
  const [picker, setPicker] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const off = avail === 'off' || avail === 'missing';

  const agencies = useRpc(gateway, (sendReq) => withTimeout(sendReq('agency.ops.agencies.list', {}), T, 'agency.ops.agencies.list'), [], { refreshSignal, enabled: !off });
  const list = useMemo(() => agencyRows(agencies.data), [agencies.data]);
  const agencyId = (list.find((a) => a.id === panel.agencyId) || list[0])?.id || null;

  const data = useRpc(gateway, async (sendReq) => {
    if (!agencyId) return null;
    switch (section) {
      case 'overview': return withTimeout(sendReq('agency.ops.dashboard', { agencyId }), T, 'agency.ops.dashboard');
      case 'approvals': return withTimeout(sendReq('agency.ops.approvals.list', { agencyId, status: 'pending' }), T, 'agency.ops.approvals.list');
      case 'activity': return withTimeout(sendReq('agency.ops.audit.list', { agencyId, limit: 50 }), T, 'agency.ops.audit.list');
      default: return withTimeout(sendReq('agency.ops.employees.list', { agencyId, status: 'active' }), T, 'agency.ops.employees.list');
    }
  }, [agencyId, section], { refreshSignal, pollMs: 60000, enabled: Boolean(agencyId) && !off });

  const open = () => navigateToScreen(navigation, { screen: 'AgencyOperationsScreen', params: { section } }, { gateway });

  if (off) {
    return <PanelEmpty icon="briefcase-outline" title="Business & Agency is turned off" message="Turn the plugin on to use agency panels." actionLabel="Plugins" onAction={() => navigateToScreen(navigation, { screen: 'PluginsScreen' }, { gateway })} />;
  }
  if (agencies.loading && !agencies.data) return <PanelLoading rows={4} />;
  if (agencies.error && !agencies.data) return <PanelError message={agencies.error} onRetry={() => agencies.reload()} />;
  if (!list.length) return <PanelEmpty icon="briefcase-outline" title="No agencies yet" message="Create an agency on the Agencies page." actionLabel="Open Agencies" onAction={open} />;

  const resolve = async (approvalId, decision) => {
    setBusyId(approvalId);
    setActionErr(null);
    try {
      await gateway.sendReq('agency.ops.approval.resolve', { agencyId, approvalId, decision });
      data.reload({ quiet: true });
    } catch (err) {
      setActionErr(String(err?.message || err));
    } finally {
      setBusyId(null);
    }
  };

  let body;
  if (data.loading && !data.data) body = <PanelLoading rows={4} />;
  else if (data.error && !data.data) body = <PanelError message={data.error} onRetry={() => data.reload()} />;
  else if (section === 'overview') {
    const kpis = data.data?.dashboard?.kpis || [];
    body = kpis.length ? (
      <View style={styles.grid}>
        {kpis.map((k) => <StatCard key={k.id} compact label={humanize(k.label)} value={k.value} footnote={k.context} style={styles.kpi} />)}
      </View>
    ) : <PanelEmpty icon="speedometer-outline" title="No KPIs yet" />;
  } else if (section === 'approvals') {
    const approvals = Array.isArray(data.data?.approvals) ? data.data.approvals : [];
    body = approvals.length ? approvals.map((a) => (
      <View key={a.id} style={[styles.approval, { borderColor: colors.borderSubtle }]}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>{a.title || humanize(a.kind || a.type) || 'Approval'}</Text>
        {a.summary || a.description ? <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={3}>{a.summary || a.description}</Text> : null}
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>{relTime(a.createdAt)}</Text>
        <View style={styles.row}>
          <Button title="Approve" size="sm" variant="primary" loading={busyId === a.id} onPress={() => resolve(a.id, 'approved')} />
          <Button title="Reject" size="sm" variant="danger" disabled={busyId === a.id} onPress={() => resolve(a.id, 'rejected')} />
        </View>
      </View>
    )) : <PanelEmpty icon="checkmark-done-outline" title="Inbox zero" message="No decisions are waiting on you." />;
  } else if (section === 'activity') {
    const events = auditRows(data.data);
    body = events.length ? events.map((e) => <ListRow key={e.id} dense icon="ellipse-outline" title={e.title} subtitle={e.actor} value={relTime(e.ts)} />) : <PanelEmpty icon="list-outline" title="No activity yet" />;
  } else {
    const people = employeeRows(data.data);
    body = people.length ? people.map((p) => (section === 'allocation' ? (
      <View key={p.id} style={styles.alloc}>
        <View style={styles.row}>
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{p.name}</Text>
          <Text style={[type.monoSmall, { color: colors.textMuted }]}>{`${p.allocatedHours}/${p.capacityHours}h`}</Text>
        </View>
        <ProgressBar value={p.utilization / 100} height={4} tone={p.utilization >= 90 ? 'danger' : p.utilization >= 70 ? 'warning' : 'primary'} />
      </View>
    ) : (
      <ListRow
        key={p.id}
        dense
        icon={p.kind === 'AI' ? 'sparkles-outline' : 'person-outline'}
        title={p.name}
        subtitle={[p.role, p.department].filter(Boolean).join('  ')}
        trailing={<StatusChip size="sm" status={p.availability || 'unknown'} />}
      />
    ))) : <PanelEmpty icon="people-outline" title="No active employees" />;
  }

  const agency = list.find((a) => a.id === agencyId);
  return (
    <View style={styles.root}>
      <Pressable onPress={() => setPicker(true)} style={[styles.select, { borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.05) }]} accessibilityRole="button" accessibilityLabel="Choose agency">
        <Ionicons name="briefcase-outline" size={15} color={colors.primary} />
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{agency?.name}</Text>
        <Text style={[type.caption, { color: colors.textMuted }]}>{AGENCY_SECTIONS[section].title}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
      </Pressable>
      {actionErr ? <Text style={[type.caption, { color: colors.error, paddingHorizontal: SPACE.md }]}>{actionErr}</Text> : null}
      <ScrollView style={styles.flex} contentContainerStyle={styles.pad} nestedScrollEnabled>{body}</ScrollView>
      <PanelOpen label="Agencies" onPress={open} />

      <BottomSheet visible={picker} onClose={() => setPicker(false)} title="Agency">
        {list.map((a) => (
          <ListRow key={a.id} dense icon="briefcase-outline" title={a.name} subtitle={a.role} selected={a.id === agencyId} onPress={() => { onPatch({ agencyId: a.id }); setPicker(false); }} accessibilityLabel={`Use ${a.name}`} />
        ))}
        <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.md, marginBottom: SPACE.xs }]}>Section</Text>
        {Object.entries(AGENCY_SECTIONS).map(([k, s]) => (
          <ListRow key={k} dense icon={s.icon} title={s.title} subtitle={s.description} selected={k === section} onPress={() => { onPatch({ agencyOpsSection: k, title: s.title }); setPicker(false); }} accessibilityLabel={`Show ${s.title}`} />
        ))}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  pad: { padding: SPACE.sm, gap: SPACE.sm },
  select: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 40, margin: SPACE.sm, marginBottom: 0, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  kpi: { flexGrow: 1, flexBasis: '46%' },
  approval: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: SPACE.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  alloc: { gap: SPACE.xs, paddingVertical: SPACE.xs },
});
