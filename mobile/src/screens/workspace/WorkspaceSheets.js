/**
 * WorkspaceSheets — every overlay of the native Workspace page, each the
 * phone form of a web popover / modal / drawer:
 *
 *   PickerSheet        workspace picker (search, Recent, All, + Add workspace)
 *   NewWorkspaceSheet  Add-workspace modal (mode, folder, recent folders,
 *                      scaffold template, display name)
 *   TemplatesSheet     template gallery (CRM-bind tag)
 *   BindSheet          "Hook this form into a database" (existing / new, field map)
 *   ComponentsSheet    snippet library (insert into the active file)
 *   WorkflowSheet      Run workflow
 *   VersionsSheet      checkpoints: diff + revert
 *   LogsSheet          Terminal & logs: dev-server output + Claude terminal
 *   ModelSheet         agent model + thinking level (webchat-model-picker)
 *   MoreSheet          the header's overflow menu
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import {
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  Field,
  ListRow,
  MONO_FAMILY,
  RADIUS,
  SPACE,
  SegmentedControl,
  SectionTitle,
  Skeleton,
  useUIKit,
} from '../../ui-kit';
import { DiffView } from './WorkspaceCode';
import { COMPONENT_LIBRARY, TEMPLATE_LIBRARY } from './workspace-templates';
import {
  PROJECT_MODES,
  RELATION_ICONS,
  SCAFFOLD_TEMPLATES,
  TEMPLATE_ICONS,
  THINK_LEVELS,
  deriveWorkspaceName,
  formatWhen,
  parseUnifiedDiff,
  pickerGroups,
  relationKindForDb,
  shortPath,
  statusForLinked,
} from './workspace-model';

function confirm(title, message, okLabel, onOk) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (window.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: okLabel, style: 'destructive', onPress: onOk }]);
}

export { confirm as confirmAction };

// ── Picker ──────────────────────────────────────────────────────────

export function PickerSheet({ visible, onClose, ws, onAdd }) {
  const { colors, type } = useUIKit();
  const [filter, setFilter] = useState('');
  useEffect(() => { if (!visible) setFilter(''); }, [visible]);
  const { recents, rest } = pickerGroups(ws.workspaces, ws.recentIds, filter);
  const row = (w) => {
    const active = w.id === ws.selectedId;
    return (
      <ListRow
        key={w.id}
        icon={active ? 'folder-open' : 'folder-outline'}
        iconTone={active ? 'primary' : 'neutral'}
        title={w.name}
        subtitle={shortPath(w.path, 48)}
        selected={active}
        trailing={active ? <Chip label="Active" tone="primary" size="sm" dot /> : null}
        onPress={() => {
          onClose();
          if (!active) ws.selectWorkspace(w.id, { explicit: true });
          else ws.openActiveExplicitly();
        }}
        accessibilityLabel={`Open workspace ${w.name}`}
      />
    );
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Workspaces"
      subtitle={`${ws.workspaces.length} registered`}
      footer={<Button title="Add workspace" icon="add" variant="outline" onPress={() => { onClose(); onAdd(); }} />}
    >
      <Field value={filter} onChangeText={setFilter} placeholder="Search workspaces…" icon="search" autoCapitalize="none" testID="workspace-picker-search" />
      {recents.length === 0 && rest.length === 0 ? (
        <Text style={[type.small, { color: colors.textMuted, paddingVertical: SPACE.lg, textAlign: 'center' }]}>
          {ws.workspaces.length === 0 ? 'No workspaces yet.' : 'No matches.'}
        </Text>
      ) : null}
      {recents.length ? <SectionTitle title="Recent" /> : null}
      {recents.map(row)}
      {rest.length ? <SectionTitle title={recents.length ? 'All' : 'Workspaces'} /> : null}
      {rest.map(row)}
    </BottomSheet>
  );
}

// ── New workspace ───────────────────────────────────────────────────

export function NewWorkspaceSheet({ visible, onClose, ws }) {
  const { colors, type } = useUIKit();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('web');
  const [template, setTemplate] = useState('none');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (visible) { setPath(''); setName(''); setMode('web'); setTemplate('none'); setErr(null); }
  }, [visible]);
  const onPath = (v) => { setName((n) => deriveWorkspaceName(path, v, n)); setPath(v); };
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const res = await ws.createWorkspace({ path, name, mode, template });
    setBusy(false);
    if (res.ok) onClose();
    else setErr(res.error);
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Add workspace"
      subtitle="Bind a local folder to a project"
      maxHeightRatio={0.92}
      footer={
        <View style={styles.footerRow}>
          <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
          <Button title="Add workspace" icon="add" disabled={!path.trim()} loading={busy} onPress={submit} style={{ flex: 1 }} />
        </View>
      }
    >
      <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.sm }]}>Project type</Text>
      <View style={styles.chipWrap}>
        {PROJECT_MODES.map((m) => (
          <Chip key={m.key} label={m.label} icon={m.icon} selected={mode === m.key} onPress={() => setMode(m.key)} />
        ))}
      </View>
      <Field label="Local folder" value={path} onChangeText={onPath} placeholder="/absolute/path/to/your/project" mono autoCapitalize="none" autoCorrect={false} required />
      {ws.recentFolders.length ? (
        <>
          <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.sm }]}>Recent folders</Text>
          <View style={styles.chipWrap}>
            {ws.recentFolders.map((p) => <Chip key={p} label={shortPath(p, 34)} icon="time-outline" onPress={() => onPath(p)} />)}
          </View>
        </>
      ) : null}
      <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.sm }]}>Start from a template</Text>
      <View style={styles.chipWrap}>
        {SCAFFOLD_TEMPLATES.map((t) => <Chip key={t.key} label={t.label} selected={template === t.key} onPress={() => setTemplate(t.key)} />)}
      </View>
      <Field label="Display name" value={name} onChangeText={setName} placeholder="Auto-derived from folder name" />
      {err ? <Text style={[type.small, { color: colors.error }]}>{err}</Text> : null}
    </BottomSheet>
  );
}

// ── Templates + bind ────────────────────────────────────────────────

export function TemplatesSheet({ visible, onClose, ws, onBind }) {
  const { colors, type, alpha } = useUIKit();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Workspace templates"
      subtitle="Scaffold ready-to-edit files into this workspace"
      maxHeightRatio={0.9}
    >
      <Text style={[type.small, { color: colors.textSecondary, marginBottom: SPACE.md }]}>
        Templates with a CRM tag let you bind their forms straight into an existing database (or create a new one for them).
      </Text>
      {ws.applyingTemplate ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /><Text style={[type.small, { color: colors.textMuted }]}>Scaffolding files…</Text></View>
      ) : (
        TEMPLATE_LIBRARY.map((tpl) => (
          <Pressable
            key={tpl.id}
            onPress={() => {
              if (tpl.binding) { onClose(); onBind({ template: tpl }); }
              else { onClose(); ws.applyTemplate(tpl, null); }
            }}
            accessibilityRole="button"
            accessibilityLabel={`Use template ${tpl.name}`}
            style={({ pressed }) => [styles.tplCard, { borderColor: colors.border, backgroundColor: pressed ? alpha(colors.primary, 0.08) : alpha(colors.text, 0.03) }]}
          >
            <View style={[styles.tplIcon, { borderColor: colors.border, backgroundColor: alpha(colors.primary, 0.08) }]}>
              <Ionicons name={TEMPLATE_ICONS[tpl.id] || 'document-outline'} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={[type.bodyStrong, { color: colors.text }]}>{tpl.name}</Text>
              <Text style={[type.small, { color: colors.textMuted }]}>{tpl.tagline}</Text>
              <View style={[styles.chipWrap, { marginTop: SPACE.xs, marginBottom: 0 }]}>
                <Chip label={tpl.category} size="sm" />
                <Chip label={`${tpl.files.length} file${tpl.files.length === 1 ? '' : 's'}`} size="sm" />
                {tpl.binding ? <Chip label="CRM bind" tone="primary" size="sm" icon="link-outline" /> : null}
              </View>
            </View>
          </Pressable>
        ))
      )}
    </BottomSheet>
  );
}

export function BindSheet({ request, onClose, ws }) {
  const { colors, type, alpha } = useUIKit();
  const visible = Boolean(request);
  const spec = request?.template?.binding || request?.snippet?.binding || null;
  const [mode, setMode] = useState('existing');
  const [choices, setChoices] = useState(null);
  const [dbId, setDbId] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!visible || !spec) return;
    setMode('existing');
    setChoices(null);
    setDbId('');
    setNewName(spec.newDatabaseName || '');
    setErr(null);
    ws.loadBindChoices(spec)
      .then(({ choices: c, preselect }) => { setChoices(c); setDbId(preselect); })
      .catch((e) => { setChoices([]); setErr(String(e?.message || e)); });
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!spec) return null;
  const submit = async () => {
    setBusy(true);
    setErr(null);
    const res = await ws.confirmBind({ spec, mode, databaseId: dbId, newName, template: request.template, snippet: request.snippet });
    setBusy(false);
    if (res.ok) onClose();
    else setErr(res.error);
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Hook this form into a database"
      subtitle={spec.label}
      maxHeightRatio={0.92}
      footer={
        <View style={styles.footerRow}>
          <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
          <Button title="Bind & apply" icon="link-outline" loading={busy} onPress={submit} style={{ flex: 1 }} />
        </View>
      }
    >
      <Text style={[type.small, { color: colors.textSecondary, marginBottom: SPACE.md }]}>
        Submissions land as rows in the chosen database. Each form field is mapped to a property by name; unmapped fields are dropped.
      </Text>
      <SegmentedControl options={[{ key: 'existing', label: 'Existing' }, { key: 'new', label: 'New database' }]} value={mode} onChange={setMode} />
      <View style={{ height: SPACE.md }} />
      {mode === 'existing' ? (
        choices == null ? (
          <Skeleton height={44} />
        ) : choices.length === 0 ? (
          <Text style={[type.small, { color: colors.textMuted }]}>No databases yet — create a new one.</Text>
        ) : (
          choices.map((d) => (
            <ListRow key={d.id} dense icon="server-outline" title={d.name} subtitle={d.slug} selected={d.id === dbId} trailing={d.id === dbId ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null} onPress={() => setDbId(d.id)} />
          ))
        )
      ) : (
        <>
          <Field label="New database name" value={newName} onChangeText={setNewName} />
          {spec.newDatabaseProperties?.length ? (
            <Text style={[type.caption, { color: colors.textMuted }]}>
              Will create with {spec.newDatabaseProperties.length} properties: {spec.newDatabaseProperties.map((p) => p.name).join(', ')}.
            </Text>
          ) : null}
        </>
      )}
      <View style={[styles.fieldMap, { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.03) }]}>
        <Text style={[type.label, { color: colors.primary, marginBottom: SPACE.sm }]}>Field mapping</Text>
        {spec.fields.map((f) => (
          <View key={f.formField} style={styles.mapRow}>
            <Text style={[type.mono, { color: colors.textSecondary, flex: 1 }]} numberOfLines={1}>{f.formField}</Text>
            <Ionicons name="arrow-forward" size={14} color={colors.primary} />
            <Text style={[type.mono, { color: colors.text, flex: 1, textAlign: 'right' }]} numberOfLines={1}>{f.propertyName}</Text>
          </View>
        ))}
      </View>
      {err ? <Text style={[type.small, { color: colors.error }]}>{err}</Text> : null}
    </BottomSheet>
  );
}

export function ComponentsSheet({ visible, onClose, ws, onBind }) {
  const { colors, type } = useUIKit();
  const tab = ws.activeTab;
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Components" subtitle={tab ? `Insert into ${tab.name}` : 'Open a file first to insert a snippet'}>
      {COMPONENT_LIBRARY.map((c) => (
        <ListRow
          key={c.id}
          icon={c.surface === 'css' ? 'color-palette-outline' : c.surface === 'js' ? 'code-slash-outline' : 'code-outline'}
          title={c.name}
          subtitle={c.description}
          trailing={<Chip label={c.binding ? 'CRM' : c.surface.toUpperCase()} tone={c.binding ? 'primary' : 'neutral'} size="sm" />}
          disabled={!ws.selectedId}
          onPress={() => {
            onClose();
            if (c.binding) onBind({ snippet: c });
            else ws.insertSnippet(c, null);
          }}
        />
      ))}
      {!tab ? <Text style={[type.caption, { color: colors.warning, marginTop: SPACE.sm }]}>Snippets append to the active file — open one in Files first.</Text> : null}
    </BottomSheet>
  );
}

// ── Workflows ───────────────────────────────────────────────────────

export function WorkflowSheet({ visible, onClose, ws }) {
  const { colors, type } = useUIKit();
  const [q, setQ] = useState('');
  useEffect(() => { if (visible) { setQ(''); ws.loadWorkflows(); } }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return ws.workflows.list.filter((w) => !s || w.name.toLowerCase().includes(s) || w.description.toLowerCase().includes(s));
  }, [ws.workflows.list, q]);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Run workflow" subtitle={ws.selected ? `Against ${ws.selected.name}` : ''} maxHeightRatio={0.9}>
      <Field value={q} onChangeText={setQ} placeholder="Search workflows…" icon="search" autoCapitalize="none" />
      {ws.workflows.loading ? (
        <><Skeleton height={52} /><Skeleton height={52} style={{ marginTop: SPACE.sm }} /></>
      ) : ws.workflows.error ? (
        <EmptyState compact tone="danger" icon="alert-circle-outline" title="Couldn't load workflows" message={ws.workflows.error} actionLabel="Retry" onAction={ws.loadWorkflows} />
      ) : list.length === 0 ? (
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center', paddingVertical: SPACE.lg }]}>No workflows found. Create one in the Workflows tab.</Text>
      ) : (
        list.map((wf) => (
          <ListRow
            key={wf.id}
            icon="git-network-outline"
            title={wf.name}
            subtitle={wf.description ? wf.description.slice(0, 140) : undefined}
            onPress={() => {
              confirm('Run workflow', `Start "${wf.name}" against ${ws.selected?.name || 'this workspace'}? It runs as an agent job.`, 'Run', () => {
                onClose();
                ws.runWorkflow(wf);
              });
            }}
          />
        ))
      )}
    </BottomSheet>
  );
}

// ── Versions ────────────────────────────────────────────────────────

export function VersionsSheet({ visible, onClose, ws }) {
  const { colors, type } = useUIKit();
  useEffect(() => { if (visible) ws.loadVersions(); else ws.setVersionDiff(null); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const diff = ws.versionDiff;
  const rows = useMemo(() => (diff?.text && !diff.error ? parseUnifiedDiff(diff.text).rows : []), [diff]);
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Versions" subtitle="Git checkpoints — one is created before every agent turn" maxHeightRatio={0.92}>
      {ws.versions.length === 0 ? (
        <EmptyState compact icon="git-commit-outline" title="No checkpoints yet" message="One is created before every visual-agent turn." />
      ) : (
        ws.versions.map((v) => (
          <View key={v.id} style={[styles.versionRow, { borderColor: colors.borderSubtle }]}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={2}>{v.description}</Text>
              <Text style={[type.monoSmall, { color: colors.textMuted }]}>{formatWhen(v.createdAt)} · {v.commit.slice(0, 8)}{v.stats ? ` · ${v.stats}` : ''}</Text>
            </View>
            <Button title="Diff" size="sm" variant={diff?.versionId === v.id ? 'secondary' : 'outline'} onPress={() => ws.showVersionDiff(v.id)} />
            <Button
              title="Revert"
              size="sm"
              variant="danger"
              onPress={() => confirm('Revert to checkpoint', `Restore the workspace files to "${v.description}"? Current changes are replaced.`, 'Revert', () => ws.revertVersion(v.id))}
            />
          </View>
        ))
      )}
      {diff ? (
        <View style={[styles.diffBox, { borderColor: colors.border }]}>
          {diff.loading ? (
            <Skeleton height={80} />
          ) : rows.length ? (
            <DiffView rows={rows} scroll={false} />
          ) : (
            <Text style={[type.mono, { color: diff.error ? colors.error : colors.textMuted, padding: SPACE.md }]}>{diff.text}</Text>
          )}
        </View>
      ) : null}
    </BottomSheet>
  );
}

// ── Logs / terminal ─────────────────────────────────────────────────

export function LogsSheet({ visible, onClose, ws, onOpenTerminals }) {
  const { colors, type, alpha } = useUIKit();
  const [spawning, setSpawning] = useState(false);
  useEffect(() => {
    if (!visible) return undefined;
    ws.refreshLogs();
    const t = setInterval(ws.refreshLogs, 2500);
    return () => clearInterval(t);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = ws.runtimeLogs || ws.server?.error || 'Waiting for server output…';
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Terminal & logs"
      subtitle={ws.server?.command || 'Development server not started'}
      maxHeightRatio={0.92}
      footer={
        <View style={styles.footerRow}>
          <Button
            title="Claude terminal here"
            icon="terminal-outline"
            variant="outline"
            loading={spawning}
            style={{ flex: 1 }}
            onPress={() =>
              confirm('Open a Claude terminal', `Start the Claude CLI in ${ws.selected?.path || 'this workspace'} (reuses an existing one) and open Terminals?`, 'Open', async () => {
                setSpawning(true);
                const ok = await ws.spawnClaudeTerminal();
                setSpawning(false);
                if (ok) { onClose(); onOpenTerminals(); }
              })
            }
          />
        </View>
      }
    >
      <View style={[styles.logHead]}>
        <View style={[styles.dot, { backgroundColor: ws.server?.status === 'ready' ? colors.success : ws.server?.status === 'error' ? colors.error : colors.textMuted }]} />
        <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]}>Development server · {ws.server?.status || 'stopped'}</Text>
        {ws.server?.port ? <Text style={[type.monoSmall, { color: colors.textMuted }]}>:{ws.server.port}</Text> : null}
      </View>
      <ScrollView horizontal style={[styles.logBox, { backgroundColor: alpha(colors.background, 0.7), borderColor: colors.borderSubtle }]}>
        <Text style={[styles.log, { color: colors.textSecondary }]} selectable testID="workspace-logs">
          {text.split('\n').slice(-400).join('\n')}
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

// ── Model ───────────────────────────────────────────────────────────

export function ModelSheet({ visible, onClose, ws }) {
  const { colors, type } = useUIKit();
  useEffect(() => { if (visible) ws.loadModels(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = ws.agentModel;
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Workspace agent model" subtitle={`Session ${ws.sessionKey}`} maxHeightRatio={0.9}>
      <SectionTitle title="Model" />
      <ListRow
        icon="sparkles-outline"
        title="Agent default"
        subtitle={ws.agentDefaultModel || 'Gateway default'}
        selected={!current}
        trailing={!current ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
        onPress={() => ws.setModel(null)}
      />
      {ws.models.map((m) => (
        <ListRow
          key={m.value}
          icon={m.reasoning ? 'bulb-outline' : 'cube-outline'}
          title={m.name}
          subtitle={m.provider}
          selected={current === m.value}
          disabled={!m.available}
          trailing={current === m.value ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : !m.available ? <Chip label="Offline" size="sm" /> : null}
          onPress={() => ws.setModel(m.value)}
        />
      ))}
      {ws.models.length === 0 ? <Text style={[type.small, { color: colors.textMuted }]}>No allow-listed models — pin models from the chat model picker on the web.</Text> : null}
      <SectionTitle title="Thinking" />
      <View style={styles.chipWrap}>
        {THINK_LEVELS.map((l) => (
          <Chip key={l.key || 'inherit'} label={l.label} selected={(ws.thinkingLevel || '') === l.key} onPress={() => ws.setThinking(l.key || null)} />
        ))}
      </View>
    </BottomSheet>
  );
}

// ── Overflow ────────────────────────────────────────────────────────

export function MoreSheet({ visible, onClose, ws, actions, previewUrl }) {
  const { colors, type } = useUIKit();
  const [url, setUrl] = useState(ws.devUrl);
  useEffect(() => { if (visible) setUrl(ws.devUrl); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const has = Boolean(ws.selectedId);
  const ready = ws.server?.status === 'ready';
  const item = (key, icon, title, tag, onPress, disabled) => (
    <ListRow
      key={key}
      dense
      icon={icon}
      title={title}
      disabled={disabled}
      trailing={<Text style={[type.label, { color: colors.textMuted }]}>{tag}</Text>}
      onPress={() => { onClose(); onPress(); }}
    />
  );
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Workspace actions" maxHeightRatio={0.92}>
      {item('add', 'add-circle-outline', 'Add workspace', 'NEW', actions.addWorkspace)}
      {item('tpl', 'albums-outline', 'Templates', 'LIBRARY', actions.templates, !has)}
      {item('comp', 'cube-outline', 'Components', 'SNIPPETS', actions.components, !has)}
      {item('ver', 'git-commit-outline', 'Versions', 'CHECKPOINTS', actions.versions, !has)}
      {item('logs', 'terminal-outline', 'Terminal & logs', 'DRAWER', actions.logs, !has)}
      {item('restart', 'refresh-outline', 'Restart preview', 'SERVER', ws.restartServer, !has)}
      {item('stop', 'stop-circle-outline', 'Stop preview', 'SERVER', ws.stopServer, !ready)}
      {item('auto', ws.autoStart ? 'toggle' : 'toggle-outline', 'Auto-start', ws.autoStart ? 'ON' : 'OFF', () => ws.setAutoStart(!ws.autoStart))}
      {item('vv', 'scan-outline', 'Visual verify', ws.visualVerify.running ? 'RUNNING' : 'CHECK', actions.visualVerify, ws.visualVerify.running || !previewUrl)}
      {item('wf', 'git-network-outline', 'Run workflow', 'AGENT', actions.workflow, !has)}
      {item('model', 'hardware-chip-outline', 'Agent model & thinking', 'MODEL', actions.model, !has)}
      {item('ext', 'open-outline', 'Open preview in browser', 'EXTERNAL', actions.openExternal, !previewUrl)}
      {item('linked', 'link-outline', 'Linked tasks & notes', 'CONTEXT', actions.linked, !has)}
      <SectionTitle title="Project mode" />
      <View style={styles.chipWrap}>
        {PROJECT_MODES.map((m) => (
          <Chip key={m.key} label={m.label} icon={m.icon} selected={ws.projectMode === m.key} onPress={() => ws.setProjectMode(m.key)} />
        ))}
      </View>
      <SectionTitle title="Manual preview URL override" />
      <Field
        value={url}
        onChangeText={setUrl}
        placeholder="http://127.0.0.1:5173"
        mono
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        onSubmitEditing={() => ws.setDevUrl(url)}
        onBlur={() => ws.setDevUrl(url)}
        rightIcon={url ? 'close-circle' : undefined}
        onRightPress={() => { setUrl(''); ws.setDevUrl(''); }}
      />
    </BottomSheet>
  );
}

// ── Linked rows ─────────────────────────────────────────────────────

export function LinkedSheet({ visible, onClose, ws, onOpenRow }) {
  const { colors, type } = useUIKit();
  useEffect(() => { if (visible) ws.loadLinked(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Linked tasks & notes" subtitle={ws.selected?.name}>
      {ws.linkedLoading && ws.linked.length === 0 ? (
        <><Skeleton height={48} /><Skeleton height={48} style={{ marginTop: SPACE.sm }} /></>
      ) : ws.linked.length === 0 ? (
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center', paddingVertical: SPACE.lg }]}>No linked tasks/notes for this workspace.</Text>
      ) : (
        ws.linked.map((l) => {
          const kind = relationKindForDb(l.databaseName);
          const st = statusForLinked(l.status);
          return (
            <ListRow
              key={`${l.databaseId}:${l.rowId}`}
              icon={RELATION_ICONS[kind]}
              title={l.title}
              subtitle={l.databaseName}
              trailing={st ? <Chip label={st} size="sm" tone={st === 'done' ? 'success' : st === 'blocked' ? 'danger' : st === 'active' ? 'primary' : 'neutral'} /> : null}
              onPress={onOpenRow ? () => { onClose(); onOpenRow(l); } : undefined}
            />
          );
        })
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  footerRow: { flexDirection: 'row', gap: SPACE.sm },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.md },
  center: { alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.xl },
  tplCard: { flexDirection: 'row', gap: SPACE.md, borderWidth: 1, borderRadius: RADIUS.lg, padding: SPACE.md, marginBottom: SPACE.sm, alignItems: 'flex-start' },
  tplIcon: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  fieldMap: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, marginTop: SPACE.md },
  mapRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 28 },
  versionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  diffBox: { borderWidth: 1, borderRadius: RADIUS.md, marginTop: SPACE.md, overflow: 'hidden' },
  logHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  logBox: { borderWidth: 1, borderRadius: RADIUS.sm, minHeight: 240 },
  log: { fontFamily: MONO_FAMILY, fontSize: 12, lineHeight: 17, padding: SPACE.md },
});
