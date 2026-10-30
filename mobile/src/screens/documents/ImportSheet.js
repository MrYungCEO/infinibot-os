// ImportSheet — the web Documents "Import" dialog on the phone: Notion (API),
// Obsidian (git URL / folder on the gateway host), Map imported collections
// to projects · tasks · clients, and From URL. Imports run as background jobs
// on the gateway; progress arrives via documents.import.progress (the screen
// passes the latest job in) and documents.notion.jobs.get polling.
//
// The Notion export ZIP / Obsidian ZIP tabs need a document picker, which this
// app does not ship (no expo-document-picker) — they point to the desktop.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Button, Chip, EmptyState, ListRow, ProgressBar, SectionTitle, Tabs, SPACE, RADIUS, useUIKit } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import {
  MAPPING_ROLES,
  canUndoJob,
  errorText,
  isHttpUrl,
  isJobActive,
  isUnknownMethod,
  jobCounts,
  jobKindLabel,
  jobProgress,
  jobStatusText,
  notionImportParams,
  notionJobLabel,
  obsidianImportParams,
  pickedAlreadyImported,
  relTime,
} from './documents-model';

const TABS = [
  { key: 'notion', label: 'Notion' },
  { key: 'obsidian', label: 'Obsidian' },
  { key: 'map', label: 'Map' },
  { key: 'url', label: 'From URL' },
];

export function JobCard({ job, onCancel, onUndo, onOpen, onDismiss }) {
  const { colors, type } = useUIKit();
  const [errorsOpen, setErrorsOpen] = useState(false);
  if (!job) return null;
  const active = isJobActive(job);
  const p = job.progress || {};
  const errors = (job.report && job.report.errors) || [];
  const tone = job.status === 'failed' ? colors.error : job.status === 'done' ? colors.success : colors.primary;
  const limited = p.rateLimitedUntil && Date.parse(p.rateLimitedUntil) > Date.now();
  return (
    <View style={[s.job, { borderColor: withAlpha(tone, 0.45) }]} testID="documents-import-job">
      <View style={s.row}>
        <Chip label={jobStatusText(job)} tone={job.status === 'failed' ? 'danger' : job.status === 'done' ? 'success' : 'primary'} size="sm" dot={active} />
        <Text style={[type.bodyStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>
          {jobKindLabel(job)} · {job.label}
        </Text>
        {job.attempts > 1 ? <Chip label="Resumed" size="sm" /> : null}
      </View>
      <ProgressBar value={jobProgress(job)} style={{ marginTop: SPACE.sm }} />
      <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>
        {active ? `${Number(p.done || 0).toLocaleString()} done · ${Number(p.total || 0).toLocaleString()} found so far · ` : `${Number(p.done || 0).toLocaleString()} pages · `}
        {jobCounts(job).join(' · ')}
      </Text>
      {active && p.current ? (
        <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={1}>
          Now: {p.current}
        </Text>
      ) : null}
      {active && limited ? <Text style={[type.caption, { color: colors.warning }]}>Notion rate limit hit — retrying automatically ({p.rateLimited}× so far).</Text> : null}
      {active ? <Text style={[type.caption, { color: colors.textMuted }]}>Runs on the gateway — you can close this sheet; progress picks up where it is.</Text> : null}
      {job.undoneAt ? (
        <Text style={[type.caption, { color: colors.textMuted }]}>
          Undone {relTime(job.undoneAt)} — {(job.undoReport && job.undoReport.trashed) || 0} moved to Trash, {(job.undoReport && job.undoReport.restored) || 0} restored.
        </Text>
      ) : null}
      {job.status === 'failed' && job.error ? <Text style={[type.caption, { color: colors.error }]}>{job.error}</Text> : null}
      {errors.length ? (
        <Pressable onPress={() => setErrorsOpen(!errorsOpen)} style={s.linkHit} accessibilityRole="button" accessibilityLabel="Toggle import errors">
          <Text style={[type.caption, { color: colors.primary }]}>
            {errorsOpen ? 'Hide' : 'Show'} {job.errorCount || errors.length} page error{(job.errorCount || errors.length) === 1 ? '' : 's'} (the rest imported fine)
          </Text>
        </Pressable>
      ) : null}
      {errorsOpen
        ? errors.slice(0, 100).map((e, i) => (
            <Text key={`${e.id || i}`} style={[type.caption, { color: colors.textSecondary }]}>
              {e.title || e.id || 'item'} — {e.error}
            </Text>
          ))
        : null}
      <View style={[s.row, { marginTop: SPACE.sm, flexWrap: 'wrap' }]}>
        {active ? (
          <Button title="Cancel import" size="sm" variant="outline" disabled={!!job.cancelRequested} onPress={onCancel} />
        ) : (
          <>
            {job.status === 'done' && job.report && job.report.rootNodeIds && job.report.rootNodeIds[0] && onOpen ? (
              <Button title="Open imported" size="sm" variant="secondary" onPress={() => onOpen(job.report.rootNodeIds[0])} />
            ) : null}
            {canUndoJob(job) ? <Button title="Undo import" size="sm" variant="outline" onPress={onUndo} testID="import-undo" /> : null}
            <Button title={job.status === 'done' ? 'Done' : 'Dismiss'} size="sm" variant="ghost" onPress={onDismiss} />
          </>
        )}
      </View>
    </View>
  );
}

export function ImportSheet({ visible, onClose, sendReq, nodes, parentId, targetLabel, job, onJob, onOpenDoc, onImported, flash }) {
  const { colors, type } = useUIKit();
  const [tab, setTab] = useState('notion');
  const [status, setStatus] = useState(null); // { connected, limits } | 'unavailable'
  const [token, setToken] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [obs, setObs] = useState({ source: 'git', value: '', vaultName: '', createTasks: false });
  const [url, setUrl] = useState('');
  const [cols, setCols] = useState(null);
  const [map, setMap] = useState({ folderId: null, role: null, preview: null, busy: false });

  useEffect(() => {
    if (!visible) return;
    setMsg(null);
    sendReq('documents.notion.status', {})
      .then((r) => setStatus(r || { connected: false }))
      .catch((e) => setStatus(isUnknownMethod(e) ? 'unavailable' : { connected: false }));
  }, [visible, sendReq]);

  const loadCollections = useCallback(async () => {
    setCols(null);
    try {
      const r = await sendReq('documents.import.collections', {});
      setCols(r?.collections || []);
    } catch (e) {
      setCols([]);
      setMsg(isUnknownMethod(e) ? 'Mapping needs a newer gateway.' : errorText(e));
    }
  }, [sendReq]);

  useEffect(() => {
    if (visible && tab === 'map' && cols === null) void loadCollections();
  }, [visible, tab, cols, loadCollections]);

  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const searchNotion = () =>
    run(async () => {
      const r = await sendReq('documents.notion.search', { query, token: token.trim() || undefined });
      setResults(r?.results || []);
      if (!(r?.results || []).length) setMsg('No pages found — share them with your Notion integration first.');
    });

  const importNotion = (mode) =>
    run(async () => {
      const r = await sendReq(
        'documents.notion.import',
        notionImportParams(picked, parentId, { mode, force, token, label: notionJobLabel(results, picked) }),
      );
      if (r?.job) onJob(r.job);
      if (r?.reattached) flash('That import is already running — showing its progress');
    });

  const importObsidian = () =>
    run(async () => {
      const p = obsidianImportParams(obs, parentId);
      if (!p) throw new Error(obs.source === 'git' ? 'Enter an https:// git URL' : 'Enter the vault folder path on the gateway machine');
      const r = await sendReq('documents.obsidian.import', p);
      if (r?.job) onJob(r.job);
      if (r?.reattached) flash('That import is already running — showing its progress');
    });

  const importUrl = () =>
    run(async () => {
      const r = await sendReq('documents.uploadUrl', { url: url.trim(), parentId: parentId || null });
      setUrl('');
      flash(`Downloaded "${r?.node?.title || 'file'}"`);
      onImported?.();
      if (r?.node?.id) onOpenDoc(r.node.id);
    });

  const pickCollection = async (folderId, role = null) => {
    setMap((m) => ({ ...m, folderId, role, busy: true }));
    try {
      const { preview } = await sendReq('documents.import.mapping.preview', { folderId, role });
      setMap({ folderId, role: preview.role || role, preview, busy: false });
    } catch (e) {
      setMap((m) => ({ ...m, busy: false, preview: null }));
      setMsg(errorText(e));
    }
  };

  const applyMapping = () =>
    run(async () => {
      if (!map.folderId || !map.role) return;
      const r = await sendReq('documents.import.mapping.apply', { folderId: map.folderId, role: map.role });
      if (r?.job) onJob(r.job);
    });

  const jobBusy = busy || isJobActive(job);
  const cancel = () => run(async () => {
    const r = await sendReq('documents.notion.jobs.cancel', { jobId: job.id });
    if (r?.job) onJob(r.job);
  });
  const undo = () => run(async () => {
    const r = await sendReq('documents.import.undo', { jobId: job.id });
    if (r?.job) onJob(r.job);
    flash('Import undone');
    onImported?.();
  });

  const unavailable = status === 'unavailable';
  const connected = status && status !== 'unavailable' ? status.connected : null;
  const hosted = status && status !== 'unavailable' && status.limits;
  const already = pickedAlreadyImported(nodes, picked);

  const input = (props) => (
    <TextInput
      placeholderTextColor={colors.textMuted}
      {...props}
      style={[type.body, s.input, { color: colors.text, borderColor: withAlpha(colors.primary, 0.3) }, props.style]}
    />
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Import" subtitle={tab === 'map' ? 'Turn imported databases into real records' : `Into: ${targetLabel}`} maxHeightRatio={0.92} testID="documents-import-sheet">
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      {unavailable ? (
        <EmptyState compact icon="cloud-offline-outline" title="Not available on this gateway" message="Imports need a newer InfiniBot gateway." />
      ) : null}
      {job && tab !== 'url' ? (
        <JobCard job={job} onCancel={cancel} onUndo={undo} onOpen={(id) => { onOpenDoc(id); onJob(null); }} onDismiss={() => onJob(null)} />
      ) : null}

      {!unavailable && tab === 'notion' ? (
        <View>
          <Text style={[type.caption, { color: colors.textMuted, marginVertical: SPACE.sm }]}>
            Re-importing updates existing docs (matched by Notion id) — no duplicates. Every import can be undone.
          </Text>
          {connected === false ? (
            <View>
              <Text style={[type.label, { color: colors.textMuted }]}>Notion integration token</Text>
              {input({ value: token, onChangeText: setToken, placeholder: 'secret_… / ntn_…', secureTextEntry: true, autoCapitalize: 'none', accessibilityLabel: 'Notion token' })}
              <Text style={[type.caption, { color: colors.textMuted }]}>No saved Notion connection. The token is used for this import only.</Text>
            </View>
          ) : null}
          <View style={[s.row, { marginTop: SPACE.sm }]}>
            {input({ value: query, onChangeText: setQuery, placeholder: 'Search pages & databases…', onSubmitEditing: searchNotion, returnKeyType: 'search', style: { flex: 1 }, accessibilityLabel: 'Search Notion' })}
            <Button title="Search" size="sm" variant="secondary" loading={busy} onPress={searchNotion} />
          </View>
          {results.map((r) => {
            const on = picked.includes(r.id);
            return (
              <ListRow
                key={r.id}
                icon={on ? 'checkbox' : 'square-outline'}
                title={r.title || 'Untitled'}
                subtitle={`${r.type === 'database' ? 'Database → folder' : 'Page'}${r.lastEditedTime ? ` · ${relTime(r.lastEditedTime)}` : ''}`}
                selected={on}
                chevron={false}
                onPress={() => setPicked(on ? picked.filter((x) => x !== r.id) : [...picked, r.id])}
                accessibilityLabel={`${on ? 'Unpick' : 'Pick'} ${r.title || 'Untitled'}`}
              />
            );
          })}
          <Pressable onPress={() => setForce(!force)} style={[s.row, s.linkHit]} accessibilityRole="checkbox" accessibilityState={{ checked: force }} accessibilityLabel="Refetch unchanged pages">
            <Ionicons name={force ? 'checkbox' : 'square-outline'} size={20} color={colors.primary} />
            <Text style={[type.small, { color: colors.textSecondary }]}>Refetch unchanged pages too (slow)</Text>
          </Pressable>
          <View style={[s.row, { justifyContent: 'flex-end' }]}>
            {already ? <Button title="Sync changes" size="sm" variant="outline" disabled={jobBusy || !picked.length} onPress={() => importNotion('changes')} /> : null}
            <Button
              title={`${already ? 'Full re-sync' : 'Import'}${picked.length ? ` ${picked.length}` : ''}`}
              size="sm"
              variant="primary"
              disabled={jobBusy || !picked.length}
              onPress={() => importNotion('full')}
              testID="documents-notion-import"
            />
          </View>
          <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.md }]}>
            Notion export ZIPs need a file picker — upload them from the desktop Documents page.
          </Text>
        </View>
      ) : null}

      {!unavailable && tab === 'obsidian' ? (
        <View>
          {hosted ? (
            <EmptyState compact icon="archive-outline" title="Upload the vault as a ZIP" message="Hosted workspaces import Obsidian vaults as a ZIP upload — use the desktop Documents page." />
          ) : (
            <View>
              <View style={[s.row, { marginVertical: SPACE.sm }]}>
                <Chip label="Git URL" selected={obs.source === 'git'} onPress={() => setObs({ ...obs, source: 'git' })} />
                <Chip label="Folder on gateway" selected={obs.source === 'folder'} onPress={() => setObs({ ...obs, source: 'folder' })} />
              </View>
              {input({
                value: obs.value,
                onChangeText: (value) => setObs({ ...obs, value }),
                placeholder: obs.source === 'git' ? 'https://github.com/you/vault.git' : '~/Documents/MyVault',
                autoCapitalize: 'none',
                autoCorrect: false,
                accessibilityLabel: obs.source === 'git' ? 'Vault git URL' : 'Vault folder path',
              })}
              {input({ value: obs.vaultName, onChangeText: (vaultName) => setObs({ ...obs, vaultName }), placeholder: 'Vault name (optional)', style: { marginTop: SPACE.sm }, accessibilityLabel: 'Vault name' })}
              <Pressable onPress={() => setObs({ ...obs, createTasks: !obs.createTasks })} style={[s.row, s.linkHit]} accessibilityRole="checkbox" accessibilityState={{ checked: obs.createTasks }} accessibilityLabel="Create tasks from checkboxes">
                <Ionicons name={obs.createTasks ? 'checkbox' : 'square-outline'} size={20} color={colors.primary} />
                <Text style={[type.small, { color: colors.textSecondary }]}>Turn open checkboxes into kanban tasks</Text>
              </Pressable>
              <View style={[s.row, { justifyContent: 'flex-end' }]}>
                <Button title="Import vault" size="sm" variant="primary" disabled={jobBusy || !obs.value.trim() || (obs.source === 'git' && !/^https:\/\//i.test(obs.value.trim()))} onPress={importObsidian} />
              </View>
            </View>
          )}
        </View>
      ) : null}

      {!unavailable && tab === 'map' ? (
        <View>
          <Text style={[type.caption, { color: colors.textMuted, marginVertical: SPACE.sm }]}>
            Turn an imported database or vault folder into kanban projects, tasks or CRM clients. Re-running updates the same records; every run can be undone.
          </Text>
          {cols === null ? <ActivityIndicator color={colors.primary} /> : null}
          {cols && !cols.length ? (
            <EmptyState compact icon="server-outline" title="No imported databases yet" message="Import a Notion database (or an Obsidian folder with notes) first, then map it here." />
          ) : null}
          {(cols || []).map((c) => (
            <ListRow
              key={c.id}
              icon="server-outline"
              title={c.path}
              subtitle={`${c.rows} rows · ${c.columns} columns${c.suggestedRole ? ` · looks like ${c.suggestedRole}` : ''}`}
              selected={map.folderId === c.id}
              chevron={false}
              onPress={() => pickCollection(c.id, c.suggestedRole || null)}
              accessibilityLabel={`Map ${c.title}`}
            />
          ))}
          {map.folderId ? (
            <View style={{ marginTop: SPACE.sm }}>
              <SectionTitle title="Becomes" />
              <View style={s.row}>
                {MAPPING_ROLES.map((r) => (
                  <Chip key={r.key} label={`${r.label}${map.preview && map.preview.suggestedRole === r.key ? ' ·  suggested' : ''}`} selected={map.role === r.key} onPress={() => pickCollection(map.folderId, r.key)} />
                ))}
              </View>
              {map.busy ? <ActivityIndicator color={colors.primary} style={{ margin: SPACE.md }} /> : null}
              {map.preview && !map.busy ? (
                <View style={{ marginTop: SPACE.sm }}>
                  <Text style={[type.small, { color: colors.text }]}>
                    Preview — {map.preview.create} new · {map.preview.update} update{map.preview.update === 1 ? '' : 's'} (of {map.preview.total})
                  </Text>
                  {(map.preview.fields || []).map((f) => {
                    const col = (map.preview.columns || []).find((c) => c.key === (map.preview.fieldMap || {})[f.key]);
                    return (
                      <Text key={f.key} style={[type.caption, { color: colors.textSecondary }]}>
                        {f.label}
                        {f.required ? ' *' : ''} ← {col ? col.name : 'not imported'}
                      </Text>
                    );
                  })}
                  {(map.preview.sample || []).slice(0, 8).map((r, i) => (
                    <Text key={i} style={[type.caption, { color: colors.textMuted }]} numberOfLines={1}>
                      {r.action} · {String((r.values && (r.values.name || r.values.title)) || r.title)}
                    </Text>
                  ))}
                  <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>Column choices can be changed on the desktop Map tab.</Text>
                  <View style={[s.row, { justifyContent: 'flex-end', marginTop: SPACE.sm }]}>
                    <Button
                      title={`${map.preview.update && !map.preview.create ? 'Update' : 'Create'} ${map.preview.total} ${map.preview.role}`}
                      size="sm"
                      variant="primary"
                      disabled={jobBusy || !map.preview.total}
                      onPress={applyMapping}
                    />
                  </View>
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {!unavailable && tab === 'url' ? (
        <View>
          <Text style={[type.caption, { color: colors.textMuted, marginVertical: SPACE.sm }]}>Download a PDF, document or image from the web into {targetLabel}. Text is extracted so agents can read it.</Text>
          <View style={s.row}>
            {input({ value: url, onChangeText: setUrl, placeholder: 'https://example.com/report.pdf', autoCapitalize: 'none', autoCorrect: false, keyboardType: 'url', onSubmitEditing: () => isHttpUrl(url) && importUrl(), style: { flex: 1 }, accessibilityLabel: 'File URL' })}
            <Button title="Download" size="sm" variant="primary" loading={busy} disabled={!isHttpUrl(url)} onPress={importUrl} />
          </View>
        </View>
      ) : null}

      {msg ? <Text style={[type.small, { color: colors.error, marginTop: SPACE.sm }]}>{msg}</Text> : null}
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  input: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, minHeight: 44 },
  job: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginVertical: SPACE.sm },
  linkHit: { minHeight: 44, justifyContent: 'center', paddingVertical: SPACE.xs },
});
