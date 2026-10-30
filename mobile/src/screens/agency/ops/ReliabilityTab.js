/**
 * Reliability — web renderAgencyReliability: schema status, back up now,
 * ensure current backup, health strip, backups (verify / prepare restore),
 * retention (prune) and the staged two-phase restore (typed confirmation).
 */
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Field, SPACE } from '../../../ui-kit';
import { fileSize, healthLine, relativeTime, shortDate } from './agency-ops-model';
import { Actions, ActionButton, Empty, KpiGrid, Meta, Notice, Panel, Row, Tile, Title } from './ui';

export function ReliabilityTab({ ctx }) {
  const { ops } = ctx;
  const s = ops.state;
  const agencyId = s.selectedAgencyId;
  const health = s.dbHealth;
  const [schema, setSchema] = useState(null);
  const [keep, setKeep] = useState('14');
  const [days, setDays] = useState('30');
  const [pruned, setPruned] = useState(null);
  const [plan, setPlan] = useState(null);
  const [confirm, setConfirm] = useState('');

  if (!ops.caps.canAdmin) return <Empty icon="lock-closed-outline" text="Database resilience controls require an owner or admin role." />;

  const refreshDiag = async () => {
    try {
      const [h, b] = await Promise.all([ops.req('agency.ops.database.health', { agencyId }), ops.req('agency.ops.database.backups.list', { agencyId })]);
      ops.patch({ dbHealth: h, backups: b?.backups ?? [] });
    } catch { /* ignore */ }
  };
  const run = async (key, method, params, after) => {
    try { const r = await ops.call(method, params, { busyKey: key }); await after?.(r); await refreshDiag(); } catch { /* recorded */ }
  };
  const line = healthLine(health);

  return (
    <View>
      <Panel eyebrow="Data resilience" title="Database health, backups and recovery" subtitle="Verified recovery points, schema compatibility and an explicit two-phase restore workflow.">
        <Actions>
          <Button title="Schema status" size="sm" variant="secondary" loading={ops.busy === 'schema-status'} onPress={() => run('schema-status', 'agency.ops.database.schema.status', { agencyId }, (r) => setSchema(r))} accessibilityLabel="Read the database schema and migration status" />
          <Button title="Back up now" size="sm" variant="secondary" loading={ops.busy === 'backup-create'} onPress={() => run('backup-create', 'agency.ops.database.backup.create', { agencyId }, () => ctx.flash('Backup created.'))} accessibilityLabel="Create a new database backup now" />
          <Button title="Ensure current backup" size="sm" loading={ops.busy === 'backup-ensure'} onPress={() => run('backup-ensure', 'agency.ops.database.backup.ensure', { agencyId, maxAgeHours: 24 }, () => ctx.flash('A current backup is in place.'))} accessibilityLabel="Ensure a backup from the last 24 hours exists" />
        </Actions>
      </Panel>
      <KpiGrid items={[
        { label: 'Integrity', value: String(health?.integrity ?? 'unavailable'), tone: health?.integrity === 'ok' ? 'success' : 'warning' },
        { label: 'Schema version', value: `${health?.schema?.currentVersion ?? '—'}/${health?.schema?.supportedVersion ?? '—'}` },
        { label: 'Recovery points', value: String(health?.backupCount ?? 0) },
        { label: 'Latest backup', value: health?.latestVerified ? 'Verified' : 'Needs backup', tone: health?.latestVerified ? 'success' : 'warning' },
      ]}
      />
      <Notice tone={line.ok ? 'success' : 'warning'} text={line.text} />
      {schema ? (
        <Notice
          tone={schema.upToDate ? 'success' : 'warning'}
          text={`Schema v${schema.currentVersion} of v${schema.supportedVersion} · ${schema.migrationCount} migration${schema.migrationCount === 1 ? '' : 's'} applied · last migrated ${schema.lastMigratedAt ? relativeTime(schema.lastMigratedAt) : 'never'}${schema.newerThanRuntime ? ' · this database was written by a newer build than the running gateway' : ''}.`}
        />
      ) : null}

      <Panel eyebrow="Verified recovery points" title="Backups" subtitle="Local encrypted-volume storage recommended">
        {s.backups.length ? s.backups.map((b) => (
          <Tile key={b.id}>
            <Row><Title style={{ flex: 1 }}>{shortDate(b.createdAt)} · {fileSize(b.sizeBytes)}</Title><Chip size="sm" label={b.verified ? 'verified' : 'unverified'} tone={b.verified ? 'success' : 'warning'} /></Row>
            <Meta mono>Schema {b.schemaVersion} · SHA-256 {String(b.sha256 ?? '').slice(0, 12)}… · {relativeTime(b.createdAt)}</Meta>
            <Actions>
              <ActionButton title="Verify" loading={ops.busy === b.id} onPress={() => run(b.id, 'agency.ops.database.backup.verify', { agencyId, backupId: b.id }, () => ctx.flash('Backup verified.'))} accessibilityLabel="Verify backup" />
              <ActionButton title="Prepare restore" disabled={!b.verified} loading={ops.busy === `prep:${b.id}`} onPress={() => run(`prep:${b.id}`, 'agency.ops.database.restore.prepare', { agencyId, backupId: b.id }, (r) => { setPlan(r?.plan ?? r); setConfirm(''); })} accessibilityLabel="Stage a restore from this backup" />
            </Actions>
          </Tile>
        )) : <Empty icon="server-outline" text="No recovery points yet. Create the first verified backup before making major changes." />}
      </Panel>

      <Panel title="Retention" subtitle="Prune older recovery points. The newest backup is always kept, whatever the policy says.">
        <Row>
          <Field label="Keep newest" value={keep} onChangeText={setKeep} keyboardType="number-pad" mono style={{ flex: 1 }} />
          <Field label="Max age (days)" value={days} onChangeText={setDays} keyboardType="number-pad" mono style={{ flex: 1 }} />
        </Row>
        <ActionButton
          title="Apply retention"
          confirm
          loading={ops.busy === 'backup-prune'}
          onPress={() => run('backup-prune', 'agency.ops.database.backups.prune', { agencyId, maxCount: Number(keep) || 14, maxAgeDays: Number(days) || 30 }, (r) => setPruned(r))}
          accessibilityLabel="Apply the backup retention policy now"
          style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }}
        />
        {pruned ? <Notice tone="success" style={{ marginTop: SPACE.sm }} text={`Removed ${pruned.removedIds?.length ?? 0} recovery point${pruned.removedIds?.length === 1 ? '' : 's'}; ${pruned.retained ?? 0} retained.`} /> : null}
      </Panel>

      {plan ? (
        <Panel title="Restore staged" subtitle={`Expires ${relativeTime(plan.expiresAt)}. A pre-restore safety backup and rollback fallback are automatic.`} right={<Chip size="sm" label="Destructive" tone="danger" />}>
          <Field label={`Type the exact confirmation: ${plan.confirmation}`} value={confirm} onChangeText={setConfirm} autoCapitalize="none" mono />
          <Actions style={{ marginTop: SPACE.sm }}>
            <ActionButton title="Cancel staged restore" onPress={() => run('restore-cancel', 'agency.ops.database.restore.cancel', { agencyId, restoreId: plan.restoreId }, () => setPlan(null))} accessibilityLabel="Cancel staged restore" />
            <ActionButton
              title="Activate verified restore"
              variant="danger"
              disabled={confirm !== plan.confirmation}
              loading={ops.busy === 'restore-activate'}
              onPress={() => run('restore-activate', 'agency.ops.database.restore.activate', { agencyId, restoreId: plan.restoreId, confirmation: confirm }, () => { setPlan(null); ctx.flash('Restore activated.'); ops.load({ background: true }); })}
              accessibilityLabel="Activate verified restore"
            />
          </Actions>
        </Panel>
      ) : null}
    </View>
  );
}
