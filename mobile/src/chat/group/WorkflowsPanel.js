/**
 * WorkflowsPanel — the group's Workflows tab (web <ib-workflow-builder>), built
 * for touch:
 *
 *   list     saved workflows · execution order · last run · Run / Edit
 *   builder  ordered STAGES (one step, or parallel steps side by side), drag a
 *            stage by its handle to reorder, tap a step to set its agent,
 *            label and instruction, "parallel" to run it alongside the stage
 *            before. Saves through groupchat.workflow.save — the same graph
 *            the web canvas edits (see workflow-logic.js).
 *   run      optional input → groupchat.workflow.run; the chat tab then
 *            follows that run (run filter + live step card).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Animated, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from '../chat-tokens';
import { GroupAvatar } from './GroupAvatar';
import { rosterName } from './group-logic';
import {
  addStep, describeOrder, dragTargetIndex, emptyWorkflow, graphToStages, isStageShaped, moveStage, nodeStatuses,
  removeStep, stagesToGraph, starterWorkflow, toggleParallel, updateStep, validateWorkflow,
} from './workflow-logic';
import { tap, warn } from '../../utils/haptics';

const STATUS_COLOR = (t, s) => (s === 'running' ? t.accent : s === 'done' ? t.ok : s === 'error' ? t.danger : t.muted);

function confirm(title, message, okLabel = 'OK') {
  if (Platform.OS === 'web') return Promise.resolve(typeof window !== 'undefined' ? window.confirm(`${title}\n\n${message}`) : true);
  return new Promise((resolve) => Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
    { text: okLabel, style: 'destructive', onPress: () => resolve(true) },
  ]));
}

function Btn({ icon, label, onPress, primary, danger, disabled, busy, small, style, testID }) {
  const t = useChatTokens();
  const fg = primary ? t.accentForeground : danger ? t.danger : t.text;
  return (
    <Pressable
      onPress={() => { if (!disabled) { tap(); onPress(); } }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        { borderColor: primary ? t.accent : danger ? t.danger : t.borderNeutral, backgroundColor: primary ? t.accent : pressed ? t.rowHover : t.surface, opacity: disabled ? 0.45 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Ionicons name={icon} size={small ? 14 : 16} color={fg} /> : null}
      {label ? <Text style={{ color: fg, fontFamily: t.font.semiBold, fontSize: small ? 12 : 13 }}>{label}</Text> : null}
    </Pressable>
  );
}

// ── list ─────────────────────────────────────────────────────────────────

function WorkflowCard({ wf, runs, agents, onRun, onEdit }) {
  const t = useChatTokens();
  const order = describeOrder(wf, (n) => n.label || rosterName(agents, n.agentId));
  const { run } = nodeStatuses(wf, runs);
  return (
    <View style={[styles.card, { borderColor: t.border, backgroundColor: t.surface }]}>
      <Pressable onPress={onEdit} accessibilityRole="button" accessibilityLabel={`Edit ${wf.name}`} style={styles.cardMain}>
        <View style={[styles.cardIco, { backgroundColor: t.accentSoft, borderColor: t.borderStrong }]}>
          <Ionicons name="git-network-outline" size={16} color={t.accent} />
        </View>
        <View style={styles.flex}>
          <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 15, fontFamily: t.font.semiBold }}>{wf.name}</Text>
          <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>
            {order || `${wf.nodes.length} step${wf.nodes.length === 1 ? '' : 's'}`}
          </Text>
          {run ? (
            <Text style={{ color: STATUS_COLOR(t, run.status), fontSize: 11, fontFamily: t.font.medium, marginTop: 2 }}>
              Last run: {run.status}{run.status === 'running' ? ` · ${run.steps.filter((s) => s.status === 'done').length}/${run.steps.length}` : ''}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={t.mutedStrong} />
      </Pressable>
      <View style={styles.cardActions}>
        <Btn small testID={`wf-card-edit-${wf.id}`} icon="create-outline" label="Edit" onPress={onEdit} />
        <Btn small primary testID={`wf-card-run-${wf.id}`} icon="play" label="Run" onPress={onRun} disabled={!wf.nodes.length} />
      </View>
    </View>
  );
}

// ── builder ──────────────────────────────────────────────────────────────

function StepChip({ node, agents, status, selected, onPress }) {
  const t = useChatTokens();
  const name = rosterName(agents, node.agentId);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`Step ${node.label || name}, agent ${name}`}
      style={[styles.stepChip, { borderColor: selected ? t.accent : status ? STATUS_COLOR(t, status) : t.borderNeutral, backgroundColor: selected ? t.accentSoft : t.side }]}
    >
      <GroupAvatar id={node.agentId} name={name} url={agents?.find((a) => a.id === node.agentId)?.identity?.avatarUrl} size={26} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={{ color: t.textStrong, fontSize: 13, fontFamily: t.font.semiBold }}>{node.label || name}</Text>
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11 }}>{node.prompt ? node.prompt : `@${node.agentId}`}</Text>
      </View>
      {status ? <View style={[styles.dot, { backgroundColor: STATUS_COLOR(t, status) }]} /> : null}
    </Pressable>
  );
}

/** One draggable stage row. The handle starts a drag; release reorders. */
function StageRow({ index, count, stage, agents, statuses, selectedId, onSelect, onDragEnd, onMove, onAddParallel, heights, dragging, setDragging }) {
  const t = useChatTokens();
  const dy = useRef(new Animated.Value(0)).current;
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { warn(); setDragging(index); },
    onPanResponderMove: (_, g) => dy.setValue(g.dy),
    onPanResponderRelease: (_, g) => {
      dy.setValue(0);
      setDragging(null);
      onDragEnd(index, dragTargetIndex(index, g.dy, heights.current));
    },
    onPanResponderTerminate: () => { dy.setValue(0); setDragging(null); },
  }), [index, onDragEnd, heights, setDragging, dy]);
  const active = dragging === index;
  return (
    <Animated.View
      onLayout={(e) => { heights.current[index] = e.nativeEvent.layout.height + 10; }}
      style={[
        styles.stage,
        { borderColor: active ? t.accent : t.border, backgroundColor: t.surface, transform: [{ translateY: dy }], zIndex: active ? 10 : 1, elevation: active ? 12 : 0, shadowOpacity: active ? 0.4 : 0 },
      ]}
    >
      <View style={styles.stageHead}>
        <View {...responder.panHandlers} style={styles.handle} accessibilityLabel={`Drag to reorder stage ${index + 1}`} accessibilityHint="Or use the arrows">
          <Ionicons name="reorder-three" size={22} color={active ? t.accent : t.mutedStrong} />
        </View>
        <Text style={{ color: t.mutedStrong, fontSize: 11, fontFamily: t.font.semiBold, letterSpacing: 0.4, flex: 1 }}>
          STAGE {index + 1}{stage.length > 1 ? ` · ${stage.length} IN PARALLEL` : ''}
        </Text>
        <Pressable onPress={() => onMove(index, index - 1)} disabled={index === 0} hitSlop={6} style={styles.arrow} accessibilityRole="button" accessibilityLabel={`Move stage ${index + 1} up`}>
          <Ionicons name="chevron-up" size={18} color={index === 0 ? t.borderNeutral : t.muted} />
        </Pressable>
        <Pressable onPress={() => onMove(index, index + 1)} disabled={index === count - 1} hitSlop={6} style={styles.arrow} accessibilityRole="button" accessibilityLabel={`Move stage ${index + 1} down`}>
          <Ionicons name="chevron-down" size={18} color={index === count - 1 ? t.borderNeutral : t.muted} />
        </Pressable>
      </View>
      <View style={styles.stageSteps}>
        {stage.map((n) => (
          <StepChip key={n.id} node={n} agents={agents} status={statuses[n.id]} selected={selectedId === n.id} onPress={() => { tap(); onSelect(selectedId === n.id ? null : n.id); }} />
        ))}
      </View>
      <Pressable onPress={() => onAddParallel(index)} hitSlop={4} style={styles.addPar} accessibilityRole="button" accessibilityLabel={`Add a parallel step to stage ${index + 1}`}>
        <Ionicons name="git-compare-outline" size={13} color={t.accent} />
        <Text style={{ color: t.accent, fontSize: 12, fontFamily: t.font.semiBold }}>Add in parallel</Text>
      </Pressable>
    </Animated.View>
  );
}

function StepEditor({ node, stages, members, agents, onChange, onToggleParallel, onRemove, onDone }) {
  const t = useChatTokens();
  const at = stages.findIndex((s) => s.some((n) => n.id === node.id));
  const shared = stages[at]?.length > 1;
  return (
    <View style={[styles.editor, { borderColor: t.accent, backgroundColor: t.side }]}>
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold, marginTop: 0 }]}>Agent</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.agentRow}>
        {members.map((m) => {
          const on = m.id === node.agentId;
          return (
            <Pressable key={m.id} onPress={() => { tap(); onChange({ agentId: m.id }); }} accessibilityRole="radio" accessibilityState={{ checked: on }}
              style={[styles.agentPick, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accentSoft : t.surface }]}>
              <GroupAvatar id={m.id} name={m.name} url={m.avatarUrl} size={20} />
              <Text style={{ color: on ? t.textStrong : t.text, fontSize: 12, fontFamily: t.font.medium }}>{m.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Step name</Text>
      <TextInput
        value={node.label || ''}
        onChangeText={(v) => onChange({ label: v || undefined })}
        placeholder={rosterName(agents, node.agentId)}
        placeholderTextColor={t.mutedStrong}
        maxLength={80}
        accessibilityLabel="Step name"
        style={[styles.input, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.surface }]}
      />
      <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold }]}>Instruction</Text>
      <TextInput
        value={node.prompt || ''}
        onChangeText={(v) => onChange({ prompt: v || undefined })}
        placeholder="What should this agent do? The previous steps' outputs are passed in automatically."
        placeholderTextColor={t.mutedStrong}
        multiline
        maxLength={8000}
        accessibilityLabel="Step instruction"
        style={[styles.input, styles.textarea, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.surface }]}
      />
      <View style={styles.editorActions}>
        <Btn small icon={shared ? 'arrow-down' : 'git-compare-outline'} label={shared ? 'Run after instead' : 'Run in parallel'} onPress={onToggleParallel} disabled={!shared && at === 0} />
        <Btn small danger icon="trash-outline" label="Remove" onPress={onRemove} />
        <View style={styles.flex} />
        <Btn small label="Done" onPress={onDone} />
      </View>
    </View>
  );
}

function Builder({ initial, members, agents, runs, onSave, onDelete, onRun, onBack }) {
  const t = useChatTokens();
  const [name, setName] = useState(initial.name);
  const [stages, setStages] = useState(() => graphToStages(initial));
  const [selectedId, setSelectedId] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runInput, setRunInput] = useState('');
  const [starting, setStarting] = useState(false);
  const [flash, setFlash] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [addOpen, setAddOpen] = useState(null); // null | 'end' | stage index
  const heights = useRef([]);
  // A web-made graph with custom links: keep it untouched until a structural edit, and ask first.
  const customRef = useRef(!isStageShaped(initial) && initial.nodes.length > 0);
  const structuralRef = useRef(false);
  const memberIds = members.map((m) => m.id);

  const graph = useMemo(() => {
    if (!structuralRef.current) {
      // Only step fields changed: keep the original links and positions.
      const byId = new Map(stages.flat().map((n) => [n.id, n]));
      return { ...initial, name, nodes: initial.nodes.map((n) => byId.get(n.id) || n) };
    }
    return stagesToGraph({ ...initial, name }, stages);
  }, [initial, name, stages]);
  const { byNode } = nodeStatuses(graph, runs);
  const order = describeOrder(graph, (n) => n.label || rosterName(agents, n.agentId));
  const check = validateWorkflow(graph, { members: memberIds });

  const show = (msg, tone = 'ok') => {
    setFlash({ msg, tone });
    setTimeout(() => setFlash(null), 3200);
  };

  const structural = useCallback(async (fn) => {
    if (customRef.current) {
      const ok = await confirm('Rebuild links?', 'This workflow has custom links made on the web canvas. Changing its order here rebuilds them as simple stages.', 'Rebuild');
      if (!ok) return;
      customRef.current = false;
    }
    structuralRef.current = true;
    setStages((s) => fn(s));
    setDirty(true);
  }, []);
  const edit = useCallback((nodeId, patch) => { setStages((s) => updateStep(s, nodeId, patch)); setDirty(true); }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(graph);
      setDirty(false);
      return true;
    } catch (err) {
      show(String(err?.message || err).replace(/^Error:\s*/, ''), 'err');
      return false;
    } finally {
      setSaving(false);
    }
  }, [graph, onSave]);

  // Autosave like the web builder (debounced).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!dirty) return undefined;
    const id = setTimeout(() => saveRef.current(), 900);
    return () => clearTimeout(id);
  }, [dirty, graph]);

  const run = async () => {
    if (!check.valid) { show(check.errors[0] || 'Workflow is not valid', 'err'); return; }
    setStarting(true);
    try {
      if (dirty && !(await save())) return;
      await onRun(graph.id, runInput);
      setRunInput('');
    } catch (err) {
      show(String(err?.message || err).replace(/^Error:\s*/, ''), 'err');
    } finally {
      setStarting(false);
    }
  };

  const addAgent = (agentId) => {
    const where = addOpen;
    setAddOpen(null);
    const res = addStep(stages, agentId, { parallelWith: typeof where === 'number' ? where : null });
    structural(() => res.stages).then(() => setSelectedId(res.nodeId));
  };

  const selected = selectedId ? stages.flat().find((n) => n.id === selectedId) : null;

  return (
    <View>
      <View style={styles.bHead}>
        <Pressable onPress={async () => { if (dirty) await save(); onBack(); }} hitSlop={8} style={styles.back} accessibilityRole="button" accessibilityLabel="Back to workflows">
          <Ionicons name="chevron-back" size={18} color={t.accent} />
          <Text style={{ color: t.accent, fontSize: 13, fontFamily: t.font.semiBold }}>Workflows</Text>
        </Pressable>
        <View style={styles.flex} />
        <Text style={{ color: t.muted, fontSize: 11 }}>{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</Text>
        <Pressable
          onPress={async () => { if (await confirm('Delete workflow?', `Delete "${name}"? Its run history stays in the chat.`, 'Delete')) onDelete(initial.id); }}
          hitSlop={8} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Delete workflow">
          <Ionicons name="trash-outline" size={17} color={t.danger} />
        </Pressable>
      </View>

      <TextInput
        value={name}
        onChangeText={(v) => { setName(v); setDirty(true); }}
        placeholder="Workflow name"
        placeholderTextColor={t.mutedStrong}
        maxLength={120}
        accessibilityLabel="Workflow name"
        style={[styles.nameInput, { color: t.textStrong, borderColor: t.borderNeutral, fontFamily: t.font.semiBold }]}
      />
      {order ? <Text style={[styles.order, { color: t.muted }]}>{order}</Text> : null}

      <View style={styles.stages}>
        {stages.map((stage, i) => (
          <React.Fragment key={stage.map((n) => n.id).join('|')}>
            {i > 0 ? <View style={styles.flowArrow}><Ionicons name="arrow-down" size={14} color={t.mutedStrong} /></View> : null}
            <StageRow
              index={i}
              count={stages.length}
              stage={stage}
              agents={agents}
              statuses={byNode}
              selectedId={selectedId}
              onSelect={setSelectedId}
              heights={heights}
              dragging={dragging}
              setDragging={setDragging}
              onDragEnd={(from, to) => { if (from !== to) structural((s) => moveStage(s, from, to)); }}
              onMove={(from, to) => { if (to >= 0 && to < stages.length) structural((s) => moveStage(s, from, to)); }}
              onAddParallel={(idx) => setAddOpen(idx)}
            />
            {selected && stage.some((n) => n.id === selected.id) ? (
              <StepEditor
                node={selected}
                stages={stages}
                members={members}
                agents={agents}
                onChange={(patch) => edit(selected.id, patch)}
                onToggleParallel={() => structural((s) => toggleParallel(s, selected.id))}
                onRemove={() => { const id = selected.id; setSelectedId(null); structural((s) => removeStep(s, id)); }}
                onDone={() => setSelectedId(null)}
              />
            ) : null}
          </React.Fragment>
        ))}
        {!stages.length ? <Text style={[styles.emptyText, { color: t.muted, textAlign: 'center', paddingVertical: 16 }]}>No steps yet — add an agent below.</Text> : null}
      </View>

      {addOpen !== null ? (
        <View style={[styles.editor, { borderColor: t.borderStrong, backgroundColor: t.side }]}>
          <Text style={[styles.label, { color: t.mutedStrong, fontFamily: t.font.semiBold, marginTop: 0 }]}>
            {typeof addOpen === 'number' ? `Add to stage ${addOpen + 1} (runs in parallel)` : 'Add a step at the end'}
          </Text>
          <View style={styles.agentWrap}>
            {members.map((m) => (
              <Pressable key={m.id} onPress={() => addAgent(m.id)} accessibilityRole="button" accessibilityLabel={`Add ${m.name}`}
                style={({ pressed }) => [styles.agentPick, { borderColor: t.borderNeutral, backgroundColor: pressed ? t.accentSoft : t.surface }]}>
                <GroupAvatar id={m.id} name={m.name} url={m.avatarUrl} size={22} />
                <Text style={{ color: t.text, fontSize: 13, fontFamily: t.font.medium }}>{m.name}</Text>
              </Pressable>
            ))}
          </View>
          <Btn small label="Cancel" onPress={() => setAddOpen(null)} style={{ alignSelf: 'flex-end', marginTop: 8 }} />
        </View>
      ) : (
        <Btn testID="wf-add-step" icon="add" label="Add step" onPress={() => setAddOpen('end')} style={{ alignSelf: 'stretch', marginTop: 4 }} />
      )}

      <View style={[styles.runBox, { borderColor: t.border, backgroundColor: t.surface }]}>
        <TextInput
          value={runInput}
          onChangeText={setRunInput}
          placeholder="Optional input for the first step (e.g. what to build)…"
          placeholderTextColor={t.mutedStrong}
          multiline
          accessibilityLabel="Workflow input"
          style={[styles.input, styles.runInput, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.side }]}
        />
        <Btn testID="wf-run" primary icon="play" label={starting ? 'Starting…' : 'Run workflow'} busy={starting} onPress={run} disabled={starting || !stages.length} />
        {!check.valid && stages.length ? <Text style={{ color: t.warn, fontSize: 12, marginTop: 6 }}>{check.errors[0]}</Text> : null}
      </View>
      {flash ? (
        <Text style={[styles.flash, { color: flash.tone === 'err' ? t.danger : t.text, borderColor: flash.tone === 'err' ? t.danger : t.borderStrong, backgroundColor: t.side }]} accessibilityLiveRegion="polite">{flash.msg}</Text>
      ) : null}
    </View>
  );
}

export function WorkflowsPanel({ group, members, agents, onRunStarted, contentStyle, bottomPad, initialEditId }) {
  const t = useChatTokens();
  const g = group.group;
  const workflows = g?.workflows || [];
  const [editing, setEditing] = useState(null); // a WorkflowGraph
  const [quickRun, setQuickRun] = useState(null); // workflow id with the input box open
  const [quickInput, setQuickInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (initialEditId) {
      const wf = workflows.find((w) => w.id === initialEditId);
      if (wf) setEditing(wf);
    }
  }, [initialEditId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (starter) => {
    setErr(null);
    const ids = members.map((m) => m.id);
    const wf = starter && ids.length ? starterWorkflow(ids) : emptyWorkflow(`Workflow ${workflows.length + 1}`);
    try {
      const saved = await group.saveWorkflow(wf);
      setEditing(saved || wf);
    } catch (e) {
      setErr(String(e?.message || e).replace(/^Error:\s*/, ''));
    }
  };

  const runNow = async (wf, input) => {
    setBusy(true);
    setErr(null);
    try {
      const run = await group.runWorkflow(wf.id, input);
      setQuickRun(null);
      setQuickInput('');
      if (run) onRunStarted?.(run.id);
    } catch (e) {
      setErr(String(e?.message || e).replace(/^Error:\s*/, ''));
    } finally {
      setBusy(false);
    }
  };

  if (!g) return null;

  return (
    <ScrollView contentContainerStyle={[contentStyle, { paddingTop: 14, paddingBottom: bottomPad }]} keyboardShouldPersistTaps="handled">
      {editing ? (
        <Builder
          key={editing.id}
          initial={editing}
          members={members}
          agents={agents}
          runs={g.runs || []}
          onSave={(graph) => group.saveWorkflow(graph)}
          onDelete={async (id) => { try { await group.deleteWorkflow(id); setEditing(null); } catch (e) { setErr(String(e?.message || e)); } }}
          onRun={async (id, input) => { const run = await group.runWorkflow(id, input); if (run) onRunStarted?.(run.id); }}
          onBack={() => setEditing(null)}
        />
      ) : (
        <>
          <Text style={[styles.title, { color: t.textStrong, fontFamily: t.font.semiBold }]}>Workflows</Text>
          <Text style={[styles.sub, { color: t.muted }]}>
            Chain this group's agents into steps — each step gets the previous steps' output. Built here or on the web, they run the same.
          </Text>
          {workflows.length ? workflows.map((wf) => (
            <View key={wf.id}>
              <WorkflowCard wf={wf} runs={g.runs || []} agents={agents} onEdit={() => setEditing(wf)} onRun={() => { setQuickRun(quickRun === wf.id ? null : wf.id); setQuickInput(''); }} />
              {quickRun === wf.id ? (
                <View style={[styles.runBox, { borderColor: t.borderStrong, backgroundColor: t.surface, marginTop: -4, marginBottom: 12 }]}>
                  <TextInput
                    value={quickInput}
                    onChangeText={setQuickInput}
                    placeholder="Optional input for the first step…"
                    placeholderTextColor={t.mutedStrong}
                    multiline
                    autoFocus
                    accessibilityLabel="Workflow input"
                    style={[styles.input, styles.runInput, { color: t.textStrong, borderColor: t.borderNeutral, backgroundColor: t.side }]}
                  />
                  <Btn testID="wf-quick-run" primary icon="play" label={busy ? 'Starting…' : `Run ${wf.name}`} busy={busy} disabled={busy} onPress={() => runNow(wf, quickInput)} />
                </View>
              ) : null}
            </View>
          )) : (
            <View style={[styles.emptyBox, { borderColor: t.borderNeutral }]}>
              <Ionicons name="git-network-outline" size={28} color={t.muted} />
              <Text style={[styles.emptyText, { color: t.muted }]}>No workflows in this group yet.</Text>
            </View>
          )}
          <View style={styles.newRow}>
            <Btn testID="wf-template" primary icon="sparkles-outline" label="Start from a template" onPress={() => create(true)} style={styles.flex} />
            <Btn testID="wf-blank" icon="add" label="Blank workflow" onPress={() => create(false)} style={styles.flex} />
          </View>
        </>
      )}
      {err ? <Text style={[styles.flash, { color: t.danger, borderColor: t.danger, backgroundColor: t.dangerSubtle }]}>{err}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  title: { fontSize: 18 },
  sub: { fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 14 },
  card: { borderWidth: 1, borderRadius: 14, marginBottom: 12, overflow: 'hidden' },
  cardMain: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  cardIco: { width: 34, height: 34, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 12, paddingBottom: 12 },
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: 12, minHeight: 44, paddingHorizontal: 14 },
  btnSmall: { minHeight: 36, borderRadius: 10, paddingHorizontal: 12 },
  newRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  emptyBox: { alignItems: 'center', gap: 8, borderWidth: 1, borderStyle: 'dashed', borderRadius: 14, paddingVertical: 28, marginBottom: 12 },
  emptyText: { fontSize: 13 },
  bHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 36 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  nameInput: { fontSize: 18, borderBottomWidth: 1, paddingVertical: 8, outlineStyle: 'none' },
  order: { fontSize: 12, marginTop: 6 },
  stages: { marginTop: 14, marginBottom: 10 },
  flowArrow: { alignItems: 'center', height: 18, justifyContent: 'center' },
  stage: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingBottom: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowRadius: 16 },
  stageHead: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 40 },
  handle: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginLeft: -6, cursor: 'grab' },
  arrow: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
  stageSteps: { gap: 6 },
  stepChip: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, minHeight: 50 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  addPar: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', minHeight: 32, paddingHorizontal: 4, marginTop: 2 },
  editor: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 8, marginBottom: 4 },
  label: { fontSize: 12, letterSpacing: 0.3, marginTop: 12, marginBottom: 6 },
  agentRow: { gap: 6 },
  agentWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  agentPick: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingLeft: 4, paddingRight: 10, minHeight: 34 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, minHeight: 42, outlineStyle: 'none' },
  textarea: { minHeight: 84, textAlignVertical: 'top' },
  editorActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  runBox: { borderWidth: 1, borderRadius: 14, padding: 12, gap: 10, marginTop: 14 },
  runInput: { minHeight: 56, textAlignVertical: 'top' },
  flash: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13, marginTop: 10, overflow: 'hidden' },
});
