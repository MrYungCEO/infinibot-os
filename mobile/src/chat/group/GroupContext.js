/**
 * Group chat shared context on mobile — native twins of the web's
 * group-context-ui.ts:
 *   <BindingFields>   repo / kanban project / purpose inputs (GroupSheet)
 *   <BindingChip>     header chip: repo · branch · "no remote" · project
 *   <ActivityLedger>  per-message real tool results + "Unverified" flags
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from '../chat-tokens';
import { withAlpha } from '../../theme/color-utils';
import { activityLine, activitySummary, repoStatusLine } from './group-logic';
import { tap } from '../../utils/haptics';

function baseName(p) {
  const parts = String(p || '').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function BindingFields({ value, onChange, sendReq, repo }) {
  const t = useChatTokens();
  const v = value || {};
  const [projects, setProjects] = useState([]);
  const [open, setOpen] = useState(false);
  const [workdir, setWorkdir] = useState(v.workdir || '');
  const [purpose, setPurpose] = useState(v.purpose || '');
  useEffect(() => { setWorkdir(v.workdir || ''); setPurpose(v.purpose || ''); }, [v.workdir, v.purpose]);

  useEffect(() => {
    let alive = true;
    if (!sendReq) return undefined;
    sendReq('kanban.projects.list', {})
      .then((res) => {
        const list = Array.isArray(res) ? res : Array.isArray(res?.projects) ? res.projects : [];
        if (!alive) return;
        setProjects(list.filter((p) => typeof p?.id === 'string').map((p) => ({ id: p.id, name: String(p.name ?? p.title ?? p.id), githubLocalPath: p.githubLocalPath })).sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [sendReq]);

  const emit = (patch) => {
    const next = { ...v, ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    onChange(next);
  };
  const pick = (p) => {
    tap();
    setOpen(false);
    emit({ projectId: p?.id, projectName: p?.name, ...(p?.githubLocalPath && !v.workdir ? { workdir: p.githubLocalPath } : {}) });
  };
  const inputStyle = [styles.input, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.surface, fontFamily: t.font.regular }];
  const projectLabel = v.projectName || v.projectId || 'None';

  return (
    <View testID="group-binding-fields" style={[styles.box, { borderColor: t.borderNeutral, backgroundColor: t.accentSoft }]}>
      <View style={styles.titleRow}>
        <Ionicons name="folder-open-outline" size={15} color={t.accent} />
        <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 13 }}>Shared workspace</Text>
        <Text style={{ color: t.muted, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>— every member's tools run here</Text>
      </View>
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Repo / working directory</Text>
      <TextInput
        testID="group-binding-workdir"
        value={workdir}
        onChangeText={setWorkdir}
        onEndEditing={() => emit({ workdir: workdir.trim() || undefined })}
        onBlur={() => emit({ workdir: workdir.trim() || undefined })}
        placeholder="/home/you/code/project"
        placeholderTextColor={t.mutedStrong}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Shared repo path"
        style={[...inputStyle, { fontFamily: t.font.mono, fontSize: 13 }]}
      />
      {repo && v.workdir === repo.path ? (
        <Text style={{ color: repo.isGitRepo && repo.remotes?.length ? t.muted : t.warn, fontSize: 12, marginTop: 4 }}>{repoStatusLine(repo)}</Text>
      ) : null}
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Kanban project</Text>
      <Pressable testID="group-binding-project" onPress={() => { tap(); setOpen((o) => !o); }} accessibilityRole="button" accessibilityLabel={`Kanban project: ${projectLabel}`}
        style={[...inputStyle, styles.select]}>
        <Text numberOfLines={1} style={{ color: v.projectId ? t.textStrong : t.mutedStrong, flex: 1, fontSize: 14 }}>{projectLabel}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={t.muted} />
      </Pressable>
      {open ? (
        <View style={[styles.menu, { borderColor: t.borderNeutral, backgroundColor: t.side }]}>
          <Pressable onPress={() => pick(null)} style={styles.menuRow}><Text style={{ color: t.text }}>None</Text></Pressable>
          {projects.slice(0, 60).map((p) => (
            <Pressable key={p.id} onPress={() => pick(p)} style={[styles.menuRow, p.id === v.projectId ? { backgroundColor: t.accentSoft } : null]}>
              <Text numberOfLines={1} style={{ color: t.textStrong }}>{p.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Purpose</Text>
      <TextInput
        testID="group-binding-purpose"
        value={purpose}
        onChangeText={setPurpose}
        onEndEditing={() => emit({ purpose: purpose.trim() || undefined })}
        onBlur={() => emit({ purpose: purpose.trim() || undefined })}
        placeholder="What is this group working on? (optional)"
        placeholderTextColor={t.mutedStrong}
        maxLength={1000}
        style={inputStyle}
      />
    </View>
  );
}

export function BindingChip({ binding, repo, onPress }) {
  const t = useChatTokens();
  const b = binding || {};
  const bound = b.workdir || b.projectId || b.projectName;
  const noRemote = repo?.isGitRepo && !repo.remotes?.length;
  return (
    <Pressable testID="group-binding-chip" onPress={onPress} accessibilityRole="button"
      accessibilityLabel={bound ? `Shared repo ${b.workdir || ''} ${repoStatusLine(repo)}. Edit` : 'No shared repo. Bind one'}
      style={[styles.chip, { borderColor: t.borderNeutral, backgroundColor: t.surface, borderStyle: bound ? 'solid' : 'dashed' }]}>
      <Ionicons name="folder-outline" size={12} color={t.accent} />
      {bound ? (
        <>
          {b.workdir ? <Text numberOfLines={1} style={{ color: t.textStrong, fontFamily: t.font.mono, fontSize: 11, flexShrink: 1 }}>{baseName(b.workdir)}</Text> : null}
          {repo?.isGitRepo ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, flexShrink: 0 }}>⎇ {repo.branch ?? '?'}</Text> : null}
          {noRemote ? <Text numberOfLines={1} style={{ color: t.warn, fontSize: 11, fontFamily: t.font.semiBold, flexShrink: 0 }}>no remote</Text> : null}
          {b.projectName || b.projectId ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, flexShrink: 1 }}>· {b.projectName || b.projectId}</Text> : null}
        </>
      ) : (
        <Text style={{ color: t.muted, fontSize: 11 }}>No shared repo</Text>
      )}
    </Pressable>
  );
}

export function ActivityLedger({ activity, unverified }) {
  const t = useChatTokens();
  const [open, setOpen] = useState(false);
  const acts = Array.isArray(activity) ? activity : [];
  const flags = Array.isArray(unverified) ? unverified : [];
  if (!acts.length && !flags.length) return null;
  const s = activitySummary(acts);
  const warn = t.warn;
  return (
    <View style={styles.ledgerWrap}>
      {flags.length ? (
        <View testID="group-unverified" style={[styles.flags, { borderColor: warn, backgroundColor: withAlpha(t.warn, 0.1) }]} accessibilityRole="alert">
          <Text style={{ color: warn, fontSize: 10, fontFamily: t.font.bold, letterSpacing: 0.4 }}>⚠ UNVERIFIED</Text>
          {flags.map((f, i) => (
            <Text key={i} style={{ color: t.text, fontSize: 12, lineHeight: 16 }}>“{f.claim}” — {f.reason}</Text>
          ))}
        </View>
      ) : null}
      {acts.length ? (
        <View style={[styles.ledger, { borderColor: t.borderNeutral, backgroundColor: t.surface }]}>
          <Pressable testID="group-ledger-toggle" onPress={() => { tap(); setOpen((o) => !o); }} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.ledgerHead}>
            <Ionicons name="terminal-outline" size={13} color={t.muted} />
            <Text style={{ color: t.muted, fontSize: 12 }}>{s.count} tool call{s.count === 1 ? '' : 's'}</Text>
            <Text style={{ color: s.failed ? t.danger : t.ok, fontSize: 12, fontFamily: t.font.semiBold }}>{s.failed ? `${s.failed} failed` : 'all ok'}</Text>
            {s.push ? <Text style={{ color: s.push === 'pushed' ? t.ok : t.danger, fontSize: 12, fontFamily: t.font.semiBold }}>{s.push}</Text> : null}
            {s.commits.map((c) => <Text key={c} style={{ color: t.muted, fontFamily: t.font.mono, fontSize: 11 }}>{c}</Text>)}
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={12} color={t.muted} style={{ marginLeft: 'auto' }} />
          </Pressable>
          {open ? acts.map((a, i) => (
            <Text key={i} selectable style={{ color: a.ok ? t.text : t.danger, fontFamily: t.font.mono, fontSize: 11, lineHeight: 15, paddingHorizontal: 10, paddingBottom: 4 }}>{activityLine(a)}</Text>
          )) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { fontSize: 12, letterSpacing: 0.3, marginTop: 10, marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, minHeight: 42, fontSize: 14, outlineStyle: 'none' },
  select: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menu: { borderWidth: 1, borderRadius: 10, marginTop: 4, maxHeight: 220, overflow: 'hidden' },
  menuRow: { minHeight: 40, paddingHorizontal: 12, justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, minHeight: 24, maxWidth: '100%', flexShrink: 1 },
  ledgerWrap: { marginTop: 6, gap: 6 },
  flags: { borderWidth: 1, borderRadius: 10, padding: 8, gap: 3 },
  ledger: { borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  ledgerHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: 10, minHeight: 32 },
});
