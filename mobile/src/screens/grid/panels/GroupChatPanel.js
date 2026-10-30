/**
 * GroupChatPanel — web <ib-group-chat-panel> for both `group_chat` and
 * `workflow_builder` grid panels (the latter opens on the Workflows tab).
 *
 * Same RPCs / events as ui/src/ui/features/group_chat:
 *   sessions.list { sessionPrefixes:['groupchat-'] }, agents.list   picker + names
 *   groupchat.get / chat.history                                     load
 *   groupchat.send / groupchat.abort / groupchat.update {mode}       chat
 *   groupchat.create                                                 new group
 *   groupchat.workflow.save / .run / .delete                         workflow builder
 *   events: `groupchat` (message / turn / round / workflow / meta) + member `chat` deltas
 *
 * The workflow builder is list-based on the phone (the web drags nodes on a
 * canvas): steps grouped by execution layer, tap to edit agent / name /
 * prompt, add sequential or parallel steps, run with an input.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { BottomSheet, Button, Chip, Field, ListRow, SegmentedControl, SPACE, RADIUS, StatusChip, useUIKit } from '../../../ui-kit';
import { withAlpha } from '../../../theme/color-utils';
import {
  GROUP_CHAT_PREFIX, MODE_LABELS, agentName, agentRows, applyChatEvent, groupRows, initials, reduceGroupEvent,
  toDisplayMessages, safeLayers, validateWorkflow, starterWorkflow, emptyWorkflow, addStep, removeStep, updateStep,
  describeOrder, latestRun, runSummary, relTime,
} from '../grid-data';
import { PanelEmpty, PanelError, PanelLoading, withTimeout } from '../panel-kit';

const MODES = ['everyone', 'round-robin', 'moderator'];

export function GroupChatPanel({ panel, gateway, onPatch, refreshSignal, initialTab = 'chat' }) {
  const { colors, type } = useUIKit();
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';
  const [groups, setGroups] = useState(null);
  const [agents, setAgents] = useState([]);
  const [listErr, setListErr] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [picker, setPicker] = useState(false);
  const [creating, setCreating] = useState(false);
  const groupKey = panel.groupId || null;

  const loadList = useCallback(async () => {
    if (!sendReq || !connected) return;
    try {
      const [s, a] = await Promise.allSettled([
        withTimeout(sendReq('sessions.list', { sessionPrefixes: [GROUP_CHAT_PREFIX], limit: 100, includeDerivedTitles: true }), 15000, 'sessions.list'),
        withTimeout(sendReq('agents.list', {}), 15000, 'agents.list'),
      ]);
      if (s.status === 'rejected') throw s.reason;
      const rows = groupRows(s.value);
      setGroups(rows);
      if (a.status === 'fulfilled') setAgents(agentRows(a.value));
      setListErr(null);
      if (!groupKey && rows[0]) onPatch({ groupId: rows[0].key });
    } catch (err) {
      setListErr(String(err?.message || err));
    }
  }, [sendReq, connected, groupKey, onPatch]);

  useEffect(() => { loadList(); }, [loadList, refreshSignal]);

  const current = groups?.find((g) => g.key === groupKey);

  if (listErr && !groups) return <PanelError message={listErr} onRetry={loadList} />;
  if (!groups) return <PanelLoading rows={5} />;

  return (
    <View style={styles.root}>
      <View style={[styles.bar, { borderBottomColor: colors.borderSubtle }]}>
        <Pressable
          onPress={() => setPicker(true)}
          style={[styles.select, { borderColor: colors.border, backgroundColor: withAlpha(colors.text, 0.05) }]}
          accessibilityRole="button"
          accessibilityLabel="Choose group chat"
        >
          <Ionicons name="people-outline" size={15} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{current?.title || (groups.length ? 'Choose a group' : 'No group chats yet')}</Text>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </Pressable>
        <Button title="New" icon="add" size="sm" variant="secondary" onPress={() => setCreating(true)} accessibilityLabel="New group chat" />
      </View>

      {groupKey ? (
        <>
          <SegmentedControl
            size="sm"
            options={[{ key: 'chat', label: 'Chat', icon: 'chatbubbles-outline' }, { key: 'workflows', label: 'Workflows', icon: 'git-merge-outline' }]}
            value={tab}
            onChange={setTab}
            style={styles.seg}
          />
          <GroupConversation key={groupKey} groupKey={groupKey} gateway={gateway} agents={agents} tab={tab} refreshSignal={refreshSignal} />
        </>
      ) : (
        <PanelEmpty icon="people-outline" title="No group chat" message="Create a group chat to talk to several agents at once." actionLabel="New group" onAction={() => setCreating(true)} />
      )}

      <BottomSheet visible={picker} onClose={() => setPicker(false)} title="Group chats">
        {groups.length === 0 ? <PanelEmpty icon="people-outline" title="No group chats yet" /> : groups.map((g) => (
          <ListRow key={g.key} icon="people-outline" title={g.title} value={relTime(g.updatedAt)} selected={g.key === groupKey} dense onPress={() => { onPatch({ groupId: g.key }); setPicker(false); }} accessibilityLabel={`Open ${g.title}`} />
        ))}
      </BottomSheet>

      <NewGroupSheet
        visible={creating}
        agents={agents}
        onClose={() => setCreating(false)}
        onCreate={async (v) => {
          const res = await sendReq('groupchat.create', v);
          setCreating(false);
          await loadList();
          if (res?.key) onPatch({ groupId: res.key });
        }}
      />
    </View>
  );
}

function NewGroupSheet({ visible, agents, onClose, onCreate }) {
  const { colors, type } = useUIKit();
  const [title, setTitle] = useState('');
  const [members, setMembers] = useState([]);
  const [mode, setMode] = useState('everyone');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { if (visible) { setTitle(''); setMembers([]); setMode('everyone'); setErr(null); } }, [visible]);
  const toggle = (id) => setMembers((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  const submit = async () => {
    if (members.length < 1) { setErr('Pick at least one agent.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onCreate({ title: title.trim(), members, mode, moderatorId: members[0] });
    } catch (e) {
      setErr(String(e?.message || e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="New group chat"
      footer={<Button title="Create group" variant="primary" loading={busy} onPress={submit} accessibilityLabel="Create group" />}
    >
      <Field label="Title" value={title} onChangeText={setTitle} placeholder="Optional" />
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.md, marginBottom: SPACE.sm }]}>Members</Text>
      <View style={styles.wrapRow}>
        {agents.map((a) => (
          <Chip key={a.id} label={a.name} selected={members.includes(a.id)} onPress={() => toggle(a.id)} icon={members.includes(a.id) ? 'checkmark' : undefined} />
        ))}
      </View>
      <Text style={[type.label, { color: colors.textMuted, marginTop: SPACE.md, marginBottom: SPACE.sm }]}>Mode</Text>
      <SegmentedControl size="sm" options={MODES.map((m) => ({ key: m, label: MODE_LABELS[m].label }))} value={mode} onChange={setMode} />
      <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]}>{MODE_LABELS[mode].hint}</Text>
      {err ? <Text style={[type.caption, { color: colors.error, marginTop: SPACE.sm }]}>{err}</Text> : null}
    </BottomSheet>
  );
}

function GroupConversation({ groupKey, gateway, agents, tab, refreshSignal }) {
  const { colors, type } = useUIKit();
  const { sendReq, subscribeEvent } = gateway;
  const connected = gateway?.status === 'connected';
  const [st, setSt] = useState({ group: null, messages: [], live: new Map(), ended: new Map(), roundActive: false });
  const stRef = useRef(st);
  stRef.current = st;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const [g, h] = await Promise.all([
        withTimeout(sendReq('groupchat.get', { key: groupKey }), 15000, 'groupchat.get'),
        withTimeout(sendReq('chat.history', { sessionKey: groupKey, limit: 300 }), 20000, 'chat.history'),
      ]);
      const live = new Map();
      for (const t of g?.activeTurns || []) live.set(t.runId, { ...t, text: '' });
      setSt({ group: g, messages: toDisplayMessages(h?.messages || []), live, ended: new Map(), roundActive: Boolean(g?.busy) });
      setError(null);
    } catch (err) {
      setError(String(err?.message || err).replace(/^Error:\s*/, ''));
    } finally {
      setLoading(false);
    }
  }, [sendReq, connected, groupKey]);

  const refreshGroup = useCallback(async () => {
    try {
      const g = await sendReq('groupchat.get', { key: groupKey });
      setSt((s) => ({ ...s, group: g, roundActive: Boolean(g?.busy) }));
    } catch { /* transient */ }
  }, [sendReq, groupKey]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  useEffect(() => {
    if (typeof subscribeEvent !== 'function') return undefined;
    const offG = subscribeEvent('groupchat', (e) => {
      if (!e || e.groupKey !== groupKey) return;
      const next = reduceGroupEvent(stRef.current, e);
      if (next === stRef.current) return;
      if (e.type === 'turn.end') {
        setTimeout(() => setSt((s) => {
          if (!s.live.has(e.runId)) return s;
          const live = new Map(s.live);
          live.delete(e.runId);
          return { ...s, live };
        }), e.ok ? 2500 : 300);
      }
      const { refresh, ...rest } = next;
      setSt(rest);
      if (refresh) setTimeout(refreshGroup, 150);
    });
    const offC = subscribeEvent('chat', (payload) => {
      if (stRef.current.live.size === 0) return;
      const live = applyChatEvent(stRef.current.live, payload);
      if (live !== stRef.current.live) setSt((s) => ({ ...s, live }));
    });
    return () => { offG?.(); offC?.(); };
  }, [subscribeEvent, groupKey, refreshGroup]);

  const items = useMemo(() => [
    ...st.messages,
    ...[...st.live.values()].map((t) => ({ id: `live-${t.runId}`, kind: 'agent', agentId: t.agentId, text: t.text, live: true })),
  ], [st.messages, st.live]);

  useEffect(() => {
    if (tab !== 'chat') return undefined;
    const id = setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 80);
    return () => clearTimeout(id);
  }, [items.length, items[items.length - 1]?.text?.length, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendReq('groupchat.send', { key: groupKey, message: text });
      setDraft('');
      setSt((s) => ({ ...s, roundActive: true }));
    } catch (err) {
      setError(String(err?.message || err).replace(/^Error:\s*/, ''));
    } finally {
      setSending(false);
    }
  };
  const stop = async () => {
    try { await sendReq('groupchat.abort', { key: groupKey }); } catch { /* ignore */ }
    setTimeout(refreshGroup, 300);
  };
  const setMode = async (mode) => {
    const prev = st.group;
    if (!prev || prev.mode === mode) return;
    setSt((s) => ({ ...s, group: { ...prev, mode } }));
    try {
      const g = await sendReq('groupchat.update', { key: groupKey, mode });
      setSt((s) => ({ ...s, group: g }));
    } catch (err) {
      setSt((s) => ({ ...s, group: prev }));
      setError(String(err?.message || err));
    }
  };

  if (loading && !st.group) return <PanelLoading rows={5} />;
  if (error && !st.group) return <PanelError message={error} onRetry={load} />;

  const members = (st.group?.members || []).map((m) => ({ id: m.id, name: agentName(agents, m.id, m.name) }));

  if (tab === 'workflows') {
    return <WorkflowsView groupKey={groupKey} gateway={gateway} group={st.group} members={members} onChanged={refreshGroup} />;
  }

  const nameOf = (m) => (m.kind === 'user' ? 'You' : agentName(agents, m.agentId, m.agentName));

  return (
    <View style={styles.flex}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.memberRow} nestedScrollEnabled style={{ flexGrow: 0 }}>
        {MODES.map((m) => (
          <Chip key={m} size="sm" label={MODE_LABELS[m].label} selected={st.group?.mode === m} onPress={() => setMode(m)} />
        ))}
        <View style={[styles.sep, { backgroundColor: colors.borderSubtle }]} />
        {members.map((m) => <Chip key={m.id} size="sm" label={`@${m.id}`} onPress={() => setDraft((d) => `${d}${d && !/\s$/.test(d) ? ' ' : ''}@${m.id} `)} />)}
      </ScrollView>
      {items.length === 0 ? (
        <PanelEmpty icon="chatbubbles-outline" title="Say hello" message={`Everyone in ${st.group?.title || 'the group'} will see your message.`} />
      ) : (
        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(m) => m.id}
          nestedScrollEnabled
          contentContainerStyle={styles.msgs}
          renderItem={({ item: m }) => {
            if (m.kind === 'status') {
              return <Text style={[type.caption, styles.status, { color: colors.textMuted }]}>{m.text}</Text>;
            }
            const mine = m.kind === 'user';
            return (
              <View style={[styles.msg, mine && styles.msgMine]}>
                {!mine ? (
                  <View style={[styles.av, { borderColor: withAlpha(colors.primary, 0.4), backgroundColor: withAlpha(colors.primary, 0.1) }]}>
                    <Text style={[type.caption, { color: colors.primary }]}>{initials(nameOf(m))}</Text>
                  </View>
                ) : null}
                <View style={[styles.bubble, { borderColor: m.error ? colors.error : mine ? withAlpha(colors.primary, 0.35) : colors.borderSubtle, backgroundColor: mine ? withAlpha(colors.primary, 0.08) : withAlpha(colors.text, 0.04) }]}>
                  <Text style={[type.caption, { color: mine ? colors.primary : colors.textSecondary }]}>{nameOf(m)}{m.live ? '  typing...' : ''}{m.workflowRunId ? '  workflow' : ''}</Text>
                  <Text style={[type.small, { color: colors.text }]} selectable>{m.text || '...'}</Text>
                </View>
              </View>
            );
          }}
        />
      )}
      {error ? <Text style={[type.caption, { color: colors.error, paddingHorizontal: SPACE.md }]} numberOfLines={2}>{error}</Text> : null}
      <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.inputBg || withAlpha(colors.text, 0.05) }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message the group (@ to mention)"
          placeholderTextColor={colors.textMuted}
          style={[type.small, styles.input, { color: colors.text }]}
          multiline
          accessibilityLabel="Group message"
        />
        {st.roundActive ? (
          <Pressable onPress={stop} style={[styles.sendBtn, { borderColor: colors.error }]} accessibilityRole="button" accessibilityLabel="Stop the round">
            <Ionicons name="stop" size={16} color={colors.error} />
          </Pressable>
        ) : null}
        <Pressable onPress={send} disabled={!draft.trim() || sending} style={[styles.sendBtn, { borderColor: colors.primary, opacity: draft.trim() ? 1 : 0.45 }]} accessibilityRole="button" accessibilityLabel="Send to group">
          <Ionicons name="arrow-up" size={17} color={colors.primary} />
        </Pressable>
      </View>
    </View>
  );
}

// ── Workflow builder (list form) ─────────────────────────────────────────────
function WorkflowsView({ groupKey, gateway, group, members, onChanged }) {
  const { colors, type } = useUIKit();
  const { sendReq } = gateway;
  const workflows = group?.workflows || [];
  const runs = group?.runs || [];
  const [currentId, setCurrentId] = useState(workflows[0]?.id || null);
  const [graph, setGraph] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [runInput, setRunInput] = useState('');
  const [editing, setEditing] = useState(null); // node id | '__new__'

  useEffect(() => {
    if (dirty) return;
    const wf = workflows.find((w) => w.id === currentId) || null;
    setGraph(wf ? JSON.parse(JSON.stringify(wf)) : null);
  }, [currentId, workflows, dirty]);

  const flash = (text, tone = 'ok') => {
    setNotice({ text, tone });
    setTimeout(() => setNotice(null), 3200);
  };
  const memberIds = members.map((m) => m.id);
  const nameOfAgent = (id) => members.find((m) => m.id === id)?.name || id;
  const stepName = (n) => n.label?.trim() || nameOfAgent(n.agentId);

  const save = async (g = graph) => {
    if (!g) return false;
    setBusy(true);
    try {
      const res = await sendReq('groupchat.workflow.save', { key: groupKey, workflow: g });
      setDirty(false);
      if (res?.workflow?.id) setCurrentId(res.workflow.id);
      await onChanged();
      return true;
    } catch (err) {
      flash(String(err?.message || err).replace(/^Error:\s*/, ''), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (g) => { setGraph(g); setDirty(true); };
  const create = async (starter) => {
    const g = starter && memberIds.length ? starterWorkflow(memberIds) : emptyWorkflow(`Workflow ${workflows.length + 1}`);
    setCurrentId(g.id);
    setGraph(g);
    await save(g);
  };
  const run = async () => {
    if (!graph) return;
    const check = validateWorkflow(graph, { members: memberIds });
    if (!check.valid) { flash(check.errors[0], 'err'); return; }
    setBusy(true);
    try {
      if (dirty && !(await save())) return;
      await sendReq('groupchat.workflow.run', { key: groupKey, workflowId: graph.id, input: runInput });
      setRunInput('');
      flash('Workflow started: follow it in the Chat tab');
      await onChanged();
    } catch (err) {
      flash(String(err?.message || err).replace(/^Error:\s*/, ''), 'err');
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    if (!graph) return;
    setBusy(true);
    try {
      await sendReq('groupchat.workflow.delete', { key: groupKey, workflowId: graph.id });
      setDirty(false);
      setCurrentId(null);
      setGraph(null);
      await onChanged();
    } catch (err) {
      flash(String(err?.message || err), 'err');
    } finally {
      setBusy(false);
    }
  };

  const last = graph ? latestRun(graph, runs) : null;
  const statusOf = new Map((last?.steps || []).map((s) => [s.nodeId, s.status]));
  const layers = graph ? safeLayers(graph) : [];
  const editNode = editing && editing !== '__new__' ? graph?.nodes.find((n) => n.id === editing) : null;

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.wfPad} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.wrapRowH} nestedScrollEnabled>
        {workflows.map((w) => (
          <Chip key={w.id} label={w.name} selected={w.id === currentId} onPress={async () => { if (dirty) await save(); setDirty(false); setCurrentId(w.id); }} />
        ))}
        <Chip label="Starter" icon="sparkles-outline" onPress={() => create(true)} />
        <Chip label="Blank" icon="add" onPress={() => create(false)} />
      </ScrollView>
      {notice ? <Text style={[type.caption, { color: notice.tone === 'err' ? colors.error : colors.success, marginTop: SPACE.sm }]}>{notice.text}</Text> : null}

      {!graph ? (
        <PanelEmpty icon="git-merge-outline" title={workflows.length ? 'Pick a workflow' : 'No workflows yet'} message="A workflow chains agent steps; steps in the same layer run in parallel." actionLabel="Starter workflow" onAction={() => create(true)} />
      ) : (
        <>
          <Field label="Workflow name" value={graph.name} onChangeText={(t) => edit({ ...graph, name: t })} style={{ marginTop: SPACE.md }} />
          <Text style={[type.caption, { color: colors.textMuted, marginTop: SPACE.xs }]} numberOfLines={2}>{describeOrder(graph, stepName) || 'No steps yet'}</Text>
          {last ? <StatusChip status={last.status} label={`Last run: ${runSummary(last)}`} style={{ alignSelf: 'flex-start', marginTop: SPACE.sm }} /> : null}

          {layers.map((layer, li) => (
            <View key={`l${li}`} style={styles.layer}>
              <Text style={[type.label, { color: colors.textMuted }]}>{layer.length > 1 ? `Step ${li + 1} - parallel` : `Step ${li + 1}`}</Text>
              {layer.map((n) => (
                <Pressable key={n.id} onPress={() => setEditing(n.id)} style={({ pressed }) => [styles.step, { borderColor: statusOf.get(n.id) === 'error' ? colors.error : colors.border, backgroundColor: withAlpha(colors.text, pressed ? 0.08 : 0.04) }]} accessibilityRole="button" accessibilityLabel={`Edit step ${stepName(n)}`}>
                  <View style={styles.stepHead}>
                    <Text style={[type.smallStrong, { color: colors.text, flex: 1 }]} numberOfLines={1}>{stepName(n)}</Text>
                    {statusOf.get(n.id) ? <StatusChip size="sm" status={statusOf.get(n.id)} /> : null}
                  </View>
                  <Text style={[type.monoSmall, { color: colors.primary }]}>@{n.agentId}</Text>
                  {n.prompt ? <Text style={[type.caption, { color: colors.textSecondary }]} numberOfLines={2}>{n.prompt}</Text> : null}
                </Pressable>
              ))}
            </View>
          ))}

          <View style={styles.actionsRow}>
            <Button title="Add step" icon="add" size="sm" variant="secondary" onPress={() => setEditing('__new__')} disabled={!memberIds.length} />
            {dirty ? <Button title="Save" icon="save-outline" size="sm" variant="outline" loading={busy} onPress={() => save()} /> : null}
            <Button title="Delete" icon="trash-outline" size="sm" variant="danger" onPress={del} />
          </View>

          <Field label="Run input" value={runInput} onChangeText={setRunInput} placeholder="What should the workflow work on?" multiline rows={2} style={{ marginTop: SPACE.md }} />
          <Button title="Run workflow" icon="play" variant="primary" loading={busy} onPress={run} style={{ marginTop: SPACE.sm }} />

          {runs.filter((r) => r.workflowId === graph.id).slice(-5).reverse().map((r) => (
            <ListRow key={r.id} dense icon="time-outline" title={r.input ? r.input.slice(0, 60) : 'Run'} subtitle={relTime(r.startedAt)} value={runSummary(r)} />
          ))}
        </>
      )}

      <StepSheet
        visible={Boolean(editing)}
        node={editNode}
        members={members}
        isNew={editing === '__new__'}
        onClose={() => setEditing(null)}
        onSave={(patch, opts) => {
          if (editing === '__new__') edit(addStep(graph, patch.agentId, { parallel: opts.parallel, label: patch.label, prompt: patch.prompt }));
          else edit(updateStep(graph, editing, patch));
          setEditing(null);
        }}
        onRemove={() => { edit(removeStep(graph, editing)); setEditing(null); }}
      />
    </ScrollView>
  );
}

function StepSheet({ visible, node, members, isNew, onClose, onSave, onRemove }) {
  const { colors, type } = useUIKit();
  const [agentId, setAgentId] = useState('');
  const [label, setLabel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [parallel, setParallel] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setAgentId(node?.agentId || members[0]?.id || '');
    setLabel(node?.label || '');
    setPrompt(node?.prompt || '');
    setParallel(false);
  }, [visible, node, members]);
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={isNew ? 'Add step' : 'Edit step'}
      footer={(
        <View style={styles.actionsRow}>
          {!isNew ? <Button title="Remove" variant="danger" icon="trash-outline" onPress={onRemove} /> : null}
          <Button title={isNew ? 'Add' : 'Done'} variant="primary" onPress={() => onSave({ agentId, label, prompt }, { parallel })} style={{ flex: 1 }} />
        </View>
      )}
    >
      <Text style={[type.label, { color: colors.textMuted, marginBottom: SPACE.sm }]}>Agent</Text>
      <View style={styles.wrapRow}>
        {members.map((m) => <Chip key={m.id} label={m.name} selected={m.id === agentId} onPress={() => setAgentId(m.id)} />)}
      </View>
      <Field label="Step name" value={label} onChangeText={setLabel} placeholder="e.g. Plan" style={{ marginTop: SPACE.md }} />
      <Field label="Instruction" value={prompt} onChangeText={setPrompt} placeholder="What this step should do; earlier outputs are appended." multiline rows={4} style={{ marginTop: SPACE.md }} />
      {isNew ? (
        <SegmentedControl size="sm" style={{ marginTop: SPACE.md }} options={[{ key: 'seq', label: 'After the last step' }, { key: 'par', label: 'Parallel' }]} value={parallel ? 'par' : 'seq'} onChange={(k) => setParallel(k === 'par')} />
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  select: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, minHeight: 40, paddingHorizontal: SPACE.md, borderRadius: RADIUS.md, borderWidth: 1 },
  seg: { marginHorizontal: SPACE.sm, marginTop: SPACE.sm },
  memberRow: { gap: SPACE.xs, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, alignItems: 'center' },
  sep: { width: 1, height: 20, marginHorizontal: SPACE.xs },
  msgs: { padding: SPACE.sm, gap: SPACE.sm },
  msg: { flexDirection: 'row', gap: SPACE.sm, alignItems: 'flex-start' },
  msgMine: { justifyContent: 'flex-end' },
  av: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  bubble: { maxWidth: '86%', borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, gap: 2 },
  status: { textAlign: 'center', paddingVertical: SPACE.xs },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACE.xs, margin: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.lg, paddingLeft: SPACE.md, paddingRight: SPACE.xs, paddingVertical: SPACE.xs },
  input: { flex: 1, minHeight: 36, maxHeight: 110, paddingVertical: SPACE.sm },
  sendBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  wrapRowH: { gap: SPACE.sm, alignItems: 'center' },
  wfPad: { padding: SPACE.md, paddingBottom: SPACE.xl },
  layer: { marginTop: SPACE.md, gap: SPACE.sm },
  step: { borderWidth: 1, borderRadius: RADIUS.md, padding: SPACE.md, gap: 2 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginTop: SPACE.md },
});
