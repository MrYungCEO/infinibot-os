/**
 * Shared-data replication banner (web renderReplicationHealth): status, Sync now,
 * Export snapshot (share/download JSON), Merge snapshot (paste JSON) and the
 * conflict review list.
 */
import React, { useState } from 'react';
import { View, Text } from 'react-native';
import { BottomSheet, Button, Chip, Field, SPACE, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import { isoDate } from './agency-ops-forms';
import { relativeTime, syncBanner } from './agency-ops-model';
import { shareFile } from './files';
import { Meta, Notice, Tile, toneOf } from './ui';

export function SyncBanner({ ctx }) {
  const { ops } = ctx;
  const { colors, type } = useUIKit();
  const s = ops.state;
  const b = syncBanner(s.replication);
  const c = toneOf(b.tone, colors);
  const [conflicts, setConflicts] = useState(null); // null closed | { loading, list }
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeText, setMergeText] = useState('');
  const [note, setNote] = useState(null);
  const agencyId = s.selectedAgencyId;

  const sync = async () => {
    try {
      await ops.call('agency.ops.replication.sync', { agencyId }, { busyKey: 'replication-sync', reload: true });
      setNote('Sync requested.');
    } catch { /* recorded */ }
  };
  const exportSnap = async () => {
    try {
      const r = await ops.call('agency.ops.replication.export', { agencyId }, { busyKey: 'replication-export' });
      const snapshot = r?.snapshot ?? r;
      await shareFile({ text: JSON.stringify(snapshot, null, 2), name: `agency-${agencyId}-snapshot-${isoDate()}.json`, mime: 'application/json', uti: 'public.json' });
      setNote('Snapshot exported. Keep it on encrypted storage.');
    } catch (e) { setNote(`Export failed: ${e?.message || e}`); }
  };
  const merge = async () => {
    let snapshot;
    try { snapshot = JSON.parse(mergeText); } catch { setNote('That is not valid JSON — paste the whole exported snapshot.'); return; }
    try {
      const r = await ops.call('agency.ops.replication.merge', { agencyId, snapshot }, { busyKey: 'replication-merge', reload: true });
      const m = r?.merge;
      setNote(m ? `Merged ${m.applied ?? 0} row(s); ${m.conflicts ?? 0} conflict(s) logged.` : 'Snapshot merged.');
      setMergeOpen(false);
      setMergeText('');
    } catch { /* recorded */ }
  };
  const toggleConflicts = async () => {
    if (conflicts) { setConflicts(null); return; }
    setConflicts({ loading: true, list: [] });
    try {
      const r = await ops.call('agency.ops.replication.conflicts.list', { agencyId, limit: 100 });
      setConflicts({ loading: false, list: r?.conflicts ?? [] });
    } catch { setConflicts({ loading: false, list: [] }); }
  };

  return (
    <View style={{ borderWidth: 1, borderColor: withAlpha(c, 0.4), backgroundColor: withAlpha(c, 0.07), borderRadius: 16, padding: SPACE.md, marginBottom: SPACE.md, gap: SPACE.sm }} testID="aops-sync">
      <View style={{ flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start' }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c, marginTop: 5 }} />
        <View style={{ flex: 1 }}>
          <Text style={[type.smallStrong, { color: colors.text }]}>{b.title}</Text>
          <Meta>{b.detail}</Meta>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm }}>
        {ops.caps.canAdmin && b.conflicts > 0 ? (
          <Button title={conflicts ? 'Hide conflicts' : `Review ${b.conflicts} conflict${b.conflicts === 1 ? '' : 's'}`} size="sm" variant="secondary" onPress={toggleConflicts} accessibilityLabel="Review replication conflicts" />
        ) : null}
        {ops.caps.canWrite ? (
          <>
            <Button title="Export snapshot" size="sm" variant="secondary" icon="download-outline" loading={ops.busy === 'replication-export'} onPress={exportSnap} accessibilityLabel="Export this agency's replication snapshot" />
            <Button title="Merge snapshot" size="sm" variant="secondary" icon="git-merge-outline" onPress={() => setMergeOpen(true)} accessibilityLabel="Merge a snapshot exported from another node" />
          </>
        ) : null}
        <Button title="Sync now" size="sm" variant="secondary" icon="sync-outline" loading={ops.busy === 'replication-sync'} onPress={sync} accessibilityLabel="Sync shared data now" />
      </View>
      {note ? <Notice tone="success" text={note} style={{ marginBottom: 0 }} /> : null}
      {conflicts ? (
        conflicts.loading ? <Meta>Loading conflicts…</Meta> : conflicts.list.length ? conflicts.list.map((cf) => (
          <Tile key={cf.id ?? `${cf.table_name}:${cf.row_key}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE.sm }}>
              <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>{cf.table_name}</Text>
              <Chip size="sm" label={cf.resolved_at ? 'resolved' : `kept ${cf.winner}`} tone={cf.resolved_at ? 'success' : 'warning'} />
            </View>
            <Meta>{cf.row_key} · from {cf.source_node_id} · {relativeTime(cf.created_at)} · local v{cf.local_version ?? '—'} vs remote v{cf.remote_version ?? '—'}</Meta>
            <Meta mono numberOfLines={4}>Local: {cf.local_json}</Meta>
            <Meta mono numberOfLines={4}>Remote: {cf.remote_json}</Meta>
          </Tile>
        )) : <Meta>No replication conflicts are recorded for this agency.</Meta>
      ) : null}
      <BottomSheet
        visible={mergeOpen}
        onClose={() => setMergeOpen(false)}
        title="Merge snapshot"
        subtitle="Paste a replication snapshot exported from another node."
        footer={<Button title="Merge" onPress={merge} loading={ops.busy === 'replication-merge'} disabled={!mergeText.trim()} accessibilityLabel="Merge snapshot" />}
      >
        <Field label="Snapshot JSON" value={mergeText} onChangeText={setMergeText} multiline rows={10} mono placeholder='{"agencyId": ...}' />
      </BottomSheet>
    </View>
  );
}
