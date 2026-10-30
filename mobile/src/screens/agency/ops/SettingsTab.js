/**
 * Agency settings — web renderAgencySettings + renderMigrationControls: agency
 * profile, members & access (invite, role change, remove), legacy migration
 * report, dry-run preview and the typed-confirmation forced re-import.
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Field, SPACE } from '../../../ui-kit';
import { MIGRATION_CONFIRMATION, shortDate } from './agency-ops-model';
import { Actions, ActionButton, Empty, Meta, Notice, Panel, Row, SelectField, StatPairs, Tile, Title } from './ui';

function MigrationStats({ m }) {
  return (
    <StatPairs
      cols={3}
      pairs={[
        { label: 'Businesses', value: String(m.businessesFound ?? 0) },
        { label: 'Clients', value: String(m.clientsImported ?? 0) },
        { label: 'Projects', value: String(m.projectsImported ?? 0) },
        { label: 'Tasks', value: String(m.tasksImported ?? 0) },
        { label: 'Quarantined', value: String((m.projectsQuarantined ?? 0) + (m.databaseRowsQuarantined ?? 0)) },
      ]}
    />
  );
}

export function SettingsTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const agency = ops.agency;
  const migration = s.migration;
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState('');
  const canAdmin = ops.caps.canAdmin;

  const setRole = async (userId, role) => {
    try { await ops.call('agency.ops.member.role.update', { agencyId: s.selectedAgencyId, userId, role }, { busyKey: `m:${userId}` }); ops.patch((p) => ({ members: p.members.map((m) => (m.userId === userId ? { ...m, role } : m)) })); } catch { /* recorded */ }
  };
  const remove = async (userId) => {
    try { await ops.call('agency.ops.member.remove', { agencyId: s.selectedAgencyId, userId }, { busyKey: `m:${userId}` }); ops.patch((p) => ({ members: p.members.filter((m) => m.userId !== userId) })); } catch { /* recorded */ }
  };
  const runPreview = async () => {
    try { setPreview(await ops.call('agency.ops.migration.preview', {}, { busyKey: 'migration-preview' })); } catch { /* recorded */ }
  };
  const runMigration = async () => {
    if (confirm !== MIGRATION_CONFIRMATION) return;
    try {
      const r = await ops.call('agency.ops.migration.run', {}, { busyKey: 'migration-run', reload: true });
      ops.patch({ migration: r });
      setConfirm(''); setPreview(null);
      ctx.flash('Legacy re-import finished.');
    } catch { /* recorded */ }
  };

  return (
    <View>
      <Panel eyebrow="Administration" title="Agency settings" subtitle="Ownership, members, collaboration and migration readiness." />
      <Panel title="Agency profile">
        <StatPairs
          cols={2}
          pairs={[
            { label: 'Name', value: agency?.name ?? 'No agency selected' },
            { label: 'Your role', value: agency?.role ?? '—' },
            { label: 'Owner', value: agency?.ownerName ?? (agency?.role === 'owner' ? 'You' : 'Not available') },
            { label: 'Members', value: String(agency?.memberCount ?? s.members.length) },
          ]}
        />
        <Meta mono selectable>Agency ID {agency?.id ?? '—'}</Meta>
      </Panel>
      <Panel title="Members & access" count={s.members.length} right={canAdmin ? <Button title="Invite member" size="sm" onPress={() => ctx.openDialog('share')} accessibilityLabel="Invite member" /> : null}>
        {s.members.length ? s.members.map((m) => (
          <Tile key={m.userId}>
            <Row>
              <View style={{ flex: 1 }}><Title>{m.userId}</Title><Meta>Joined {shortDate(m.createdAt)}</Meta></View>
              {m.role === 'owner' || !canAdmin ? <Chip size="sm" label={m.role} tone="primary" /> : null}
            </Row>
            {m.role !== 'owner' && canAdmin ? (
              <>
                <SelectField label="Role" value={m.role} options={[['admin', 'Admin'], ['member', 'Member'], ['viewer', 'Viewer']]} onChange={(r) => setRole(m.userId, r)} compact />
                <ActionButton title="Remove" confirm variant="danger" loading={ops.busy === `m:${m.userId}`} onPress={() => remove(m.userId)} accessibilityLabel={`Remove ${m.userId}`} />
              </>
            ) : null}
          </Tile>
        )) : <Empty icon="people-outline" text="No agency members were returned." />}
      </Panel>
      <Panel title="Legacy migration" right={<Chip size="sm" label={migration?.completedAt ? 'Completed' : migration?.sourceExists ? 'Ready' : 'No source detected'} tone={migration?.completedAt ? 'success' : 'neutral'} />}>
        {migration ? (
          <>
            <MigrationStats m={migration} />
            {migration.warnings?.length ? <Notice tone="warning" text={migration.warnings.join(' ')} /> : <Notice tone="success" text="No migration warnings reported." />}
          </>
        ) : <Empty icon="swap-horizontal-outline" text="Migration status will appear after the agency list reports a migration preview." />}
        <Button title="Preview re-import" size="sm" variant="secondary" loading={ops.busy === 'migration-preview'} onPress={runPreview} style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }} accessibilityLabel="Preview what a legacy re-import would touch, without writing anything" />
        {preview ? (<><MigrationStats m={preview} /><Meta>Dry run only — nothing has been written.</Meta></>) : null}
        {agency?.role === 'owner' ? (
          <View style={{ marginTop: SPACE.md }}>
            <Notice tone="warning" title="Running the import forces a full re-import." text="Every legacy business, client, project and task is read and rewritten, not just what changed. On a dataset this size that takes minutes and rewrites existing agency rows. Take a backup from the Reliability section first." />
            <Field label={`Type ${MIGRATION_CONFIRMATION} to enable the forced re-import`} value={confirm} onChangeText={setConfirm} autoCapitalize="characters" mono />
            <Actions style={{ marginTop: SPACE.sm }}>
              <ActionButton title="Run forced re-import" variant="danger" disabled={confirm !== MIGRATION_CONFIRMATION} loading={ops.busy === 'migration-run'} onPress={runMigration} accessibilityLabel="Run the forced legacy re-import" />
            </Actions>
          </View>
        ) : <Meta style={{ marginTop: SPACE.sm }}>Only the agency owner can run the legacy import.</Meta>}
      </Panel>
    </View>
  );
}
