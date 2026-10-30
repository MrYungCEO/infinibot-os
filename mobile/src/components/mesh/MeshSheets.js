/**
 * MeshSheets — the web mesh's overlays as native bottom sheets, styled like
 * the web's gold glass card (.bx-tooltip.is-mobile):
 *   · AgentCardSheet  — the agent card (agency-world-viz.ts hover card →
 *     tap card on phones), filled by the web's own buildAgentHoverCardModel +
 *     buildHoverExtras; actions Details · Message · Stop · Thread ·
 *     Screenshots · Task · Follow (+ Open in app).
 *   · MeshActionSheet — the long-press menu (web touch sheet + radial menu).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PROVIDER_BADGES } from '../../lib/mesh/mesh-assets';
import { buildAgentHoverCardModel, buildHoverExtras } from '../../lib/mesh/web-mesh.generated';
import { GOLD, GOLD_LT, MONO, badgeFor } from './mesh-style';
import { MeshIcon } from './MeshIcons';
import { decisionsForAgent } from '../../lib/mesh/owner-decisions';

const TONE = { active: '#e9c46a', waiting: '#7dd3fc', success: '#86efac', danger: '#fb7185', idle: '#a1a1aa' };

export function MeshSheet({ visible, onClose, children, testID, maxHeight = 0.78, landscape }) {
  const insets = useSafeAreaInsets();
  // A ghost click from the opening tap must not close the sheet at once.
  const openedAt = useRef(0);
  useEffect(() => { if (visible) openedAt.current = Date.now(); }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.backdropWrap}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => { if (Date.now() - openedAt.current > 450) onClose?.(); }} accessibilityLabel="Close" />
        <View
          style={[styles.sheet, landscape ? styles.sheetSide : null, { paddingBottom: 12 + insets.bottom, maxHeight: `${Math.round(maxHeight * 100)}%`, marginLeft: landscape ? undefined : 0 }]}
          testID={testID}
        >
          <View style={styles.accent} />
          <View style={styles.grip} />
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Metric({ label, value, color }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.metricValue, color ? { color } : null]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Action({ label, icon, onPress, disabled, primary, testID }) {
  return (
    <Pressable onPress={disabled ? undefined : onPress} style={({ pressed }) => [styles.action, primary && styles.actionPrimary, disabled && styles.actionOff, pressed && !disabled && styles.actionPressed]} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} accessibilityLabel={label} testID={testID}>
      <Text style={[styles.actionIcon, disabled && styles.offText]}>{icon}</Text>
      <Text style={[styles.actionText, disabled && styles.offText]}>{label}</Text>
    </Pressable>
  );
}

export function AgentCardSheet({ agent, node, agents, review, thread, record, decisions = [], following, onClose, onDetails, onMessage, onStop, onThread, onShots, onTask, onFollow, onInApp, onDecision, landscape }) {
  const [compose, setCompose] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState(null);
  useEffect(() => { setCompose(false); setText(''); setNote(null); }, [agent?.sessionKey]);
  const now = Date.now();
  const m = useMemo(() => (agent ? buildAgentHoverCardModel(agent, node, review, now) : null), [agent, node, review, now]);
  const x = useMemo(() => (agent ? buildHoverExtras(agent, { now, agents, thread, record }) : null), [agent, agents, thread, record, now]);
  const ownerDecisions = useMemo(() => (agent ? decisionsForAgent(decisions, agent) : []), [decisions, agent]);
  if (!agent || !m || !x) return <MeshSheet visible={false} onClose={onClose} />;
  const tone = TONE[m.tone] || TONE.idle;
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setNote({ text: 'Sending…' });
    try {
      const r = await onMessage(agent, t);
      if (r && r.ok === false) setNote({ text: r.error || 'Message not delivered', err: true });
      else {
        setNote({ text: 'Message sent' });
        setText('');
        setCompose(false);
      }
    } catch (e) {
      setNote({ text: e?.message || String(e), err: true });
    }
  };
  const stop = async () => {
    setNote({ text: 'Stopping…' });
    try {
      await onStop(agent);
      setNote({ text: 'Stop requested' });
    } catch (e) {
      setNote({ text: e?.message || String(e), err: true });
    }
  };
  return (
    <MeshSheet visible onClose={onClose} testID="mesh-agent-card" landscape={landscape}>
      <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
        <View style={[styles.cardAccent, { backgroundColor: tone }]} />
        <View style={styles.head}>
          <View style={styles.logoWrap}><Image source={PROVIDER_BADGES[badgeFor(agent)]} style={styles.logo} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.name} numberOfLines={2}>{m.name}</Text>
            <Text style={styles.role} numberOfLines={1}>{x.role}</Text>
            <Text style={styles.id} numberOfLines={1}>{(agent.sessionKey || '').split(':').slice(1, 3).join(' · ')}{m.runId ? ` · ${String(m.runId).slice(0, 18)}` : ''}</Text>
          </View>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: tone }]} />
            <Text style={[styles.status, { color: tone }]}>{m.statusLabel.toUpperCase()}</Text>
          </View>
          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close agent details" hitSlop={8}><Text style={styles.closeText}>✕</Text></Pressable>
        </View>

        {ownerDecisions.length ? (
          <Pressable onPress={() => onDecision?.(ownerDecisions[0])} style={styles.decisionBadge} accessibilityRole="button" accessibilityLabel={`${ownerDecisions.length} decisions needed`} testID="mesh-card-decisions">
            <MeshIcon name="alert" size={14} color="#fde68a" strokeWidth={2} />
            <View style={{ flex: 1 }}>
              <Text style={styles.decisionBadgeTitle}>DECISION NEEDED · {ownerDecisions.length}{ownerDecisions[0].risk ? ` · ${ownerDecisions[0].risk.toUpperCase()} RISK` : ''}</Text>
              <Text style={styles.decisionBadgeQuestion} numberOfLines={2}>{ownerDecisions[0].question || ownerDecisions[0].title}</Text>
            </View>
            <MeshIcon name="chevronRight" size={14} color={GOLD_LT} strokeWidth={2.2} />
          </Pressable>
        ) : null}

        <View style={styles.work}>
          <Text style={styles.kicker}>CURRENT TASK</Text>
          <Text style={styles.task} numberOfLines={3}>{m.task}</Text>
          <Text style={styles.activity} numberOfLines={1}><Text style={styles.dim}>Latest action · </Text>{m.activity}{x.activityAge ? <Text style={styles.dim}>{` · ${x.activityAge}`}</Text> : null}</Text>
          <View style={styles.progRow}><Text style={styles.dim}>Run progress</Text><Text style={styles.progVal}>{m.progress}%</Text></View>
          <View style={styles.track}><View style={[styles.fill, { width: `${m.progress}%` }]} /></View>
        </View>

        <View style={styles.metrics}>
          <Metric label="RUNTIME" value={m.runtime} />
          <Metric label="TOKENS" value={m.tokens} />
          <Metric label="BACKEND" value={m.backend} />
        </View>
        <View style={styles.metrics}>
          <Metric label="ATTEMPT · ROUND" value={x.attemptRound || '—'} />
          <Metric label="VERDICT" value={x.verdict || '—'} color={x.verdictColor} />
          <Metric label="FILES · COMMITS" value={`${x.files} · ${x.commits}`} />
        </View>
        {x.latest ? (
          <View style={styles.latest}>
            <Text style={styles.kicker}>🛡 LATEST REVIEW MESSAGE</Text>
            <Text style={styles.latestRow} numberOfLines={2}><Text style={{ color: x.latest.color, fontWeight: '700' }}>{x.latest.kind} </Text>{x.latest.title}</Text>
          </View>
        ) : null}
        <View style={styles.meta}>
          {x.parent ? <Text style={styles.metaItem}>Parent · <Text style={styles.metaVal}>{x.parent}</Text></Text> : <Text style={styles.metaItem}>Parent · <Text style={styles.metaVal}>none</Text></Text>}
          <Text style={styles.metaItem}>Children · <Text style={styles.metaVal}>{x.children}</Text></Text>
          <Text style={styles.metaItem}>Node · <Text style={styles.metaVal}>{m.node}</Text></Text>
          <Text style={styles.metaItem}>Checkpoint · <Text style={styles.metaVal}>{m.checkpoint || '—'}</Text></Text>
          <Text style={styles.metaItem}>Plugin · <Text style={styles.metaVal}>{m.plugin || 'Core'}</Text></Text>
          <Text style={styles.metaItem}><Text style={styles.metaVal}>{m.updated}</Text></Text>
        </View>
        {m.review ? <Text style={styles.review} numberOfLines={4}>{m.reviewStatus ? `${m.reviewStatus.toUpperCase()} · ` : ''}{m.review}</Text> : null}

        <View style={styles.actions}>
          <Action icon="↗" label="Details" primary onPress={() => onDetails(agent)} testID="mesh-card-details" />
          <Action icon="✉" label="Message" onPress={() => setCompose((v) => !v)} testID="mesh-card-message" />
          <Action icon="■" label="Stop" onPress={stop} disabled={!x.running} testID="mesh-card-stop" />
          <Action icon="🛡" label="Thread" onPress={() => onThread(agent)} disabled={!agent.runId} testID="mesh-card-thread" />
          <Action icon="📷" label="Screenshots" onPress={() => onShots(agent)} disabled={!agent.runId} testID="mesh-card-shots" />
          <Action icon="▦" label="Task" onPress={() => onTask(agent)} disabled={!x.kanbanTaskId} testID="mesh-card-task" />
          <Action icon="◎" label={following ? 'Following' : 'Follow'} onPress={() => onFollow(agent)} testID="mesh-card-follow" />
          <Action icon="📱" label="In app" onPress={() => onInApp(agent)} testID="mesh-card-inapp" />
        </View>
        {compose ? (
          <View style={styles.compose}>
            <TextInput value={text} onChangeText={setText} placeholder="Message this agent…" placeholderTextColor="#7a7466" style={styles.input} autoFocus onSubmitEditing={send} returnKeyType="send" accessibilityLabel="Message this agent" />
            <Pressable onPress={send} style={styles.send} accessibilityRole="button" accessibilityLabel="Send"><Text style={styles.sendText}>➤</Text></Pressable>
          </View>
        ) : null}
        {note ? <Text style={[styles.note, note.err && { color: '#fb7185' }]} accessibilityLiveRegion="polite">{note.text}</Text> : null}
      </ScrollView>
    </MeshSheet>
  );
}

export function DecisionSheet({ visible, decisions = [], initialId, onClose, onResolve, onOpenLink, landscape }) {
  const [selectedId, setSelectedId] = useState(initialId || null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  useEffect(() => {
    if (!visible) return;
    setSelectedId(initialId || null);
    setReply('');
    setError(null);
    setStatus(null);
  }, [initialId, visible]);
  const selected = decisions.find((decision) => decision.id === selectedId) || null;
  const choose = async (action) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setStatus('Applying decision…');
    try {
      const result = await onResolve(selected, action, reply);
      setStatus(result?.message || 'Decision applied');
      setReply('');
      setTimeout(() => {
        const next = decisions.find((decision) => decision.id !== selected.id);
        if (next) setSelectedId(next.id);
        else onClose?.();
      }, 450);
    } catch (e) {
      setError(e?.message || String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <MeshSheet visible={visible} onClose={onClose} testID="mesh-decision-sheet" maxHeight={0.82} landscape={landscape}>
      <View style={styles.decisionHead}>
        <View style={styles.decisionHeadIcon}><MeshIcon name="alert" size={18} color="#fde68a" strokeWidth={2} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.decisionSheetTitle}>OWNER DECISIONS</Text>
          <Text style={styles.decisionSheetCount}>{decisions.length} pending</Text>
        </View>
        {selected ? <Pressable onPress={() => setSelectedId(null)} style={styles.decisionBack} accessibilityRole="button"><MeshIcon name="back" size={17} color={GOLD_LT} /></Pressable> : null}
      </View>
      {!selected ? (
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 7 }}>
          {decisions.map((decision) => (
            <Pressable key={decision.id} onPress={() => { setSelectedId(decision.id); setReply(''); setError(null); }} style={styles.decisionRow} accessibilityRole="button" testID={`mesh-decision-${decision.id}`}>
              <View style={styles.decisionRowIcon}><MeshIcon name={decision.kind === 'approval' ? 'check' : 'alert'} size={14} color="#fde68a" /></View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.decisionRowTitle} numberOfLines={1}>{decision.title}{decision.risk ? ` · ${decision.risk.toUpperCase()} RISK` : ''}</Text>
                <Text style={styles.decisionRowQuestion} numberOfLines={2}>{decision.question}</Text>
              </View>
              <MeshIcon name="chevronRight" size={15} color="#9d957e" />
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
          <Text style={styles.decisionQuestion}>{selected.question || selected.title}</Text>
          {selected.context && selected.context !== selected.question ? <Text style={styles.decisionContext}>{selected.context}</Text> : null}
          {selected.allowText ? (
            <TextInput value={reply} onChangeText={setReply} placeholder={selected.kind === 'run_input' ? 'Reply to the agent…' : 'Optional note…'} placeholderTextColor="#756f61" style={styles.decisionInput} multiline accessibilityLabel="Decision reply" />
          ) : null}
          <View style={styles.decisionActions}>
            {(selected.choices || []).map((choice) => (
              <Pressable key={choice.id} disabled={busy} onPress={() => choose(choice.action)} style={[styles.decisionAction, choice.tone === 'primary' && styles.decisionActionPrimary, choice.tone === 'danger' && styles.decisionActionDanger, busy && styles.actionOff]} accessibilityRole="button">
                <MeshIcon name={choice.tone === 'danger' ? 'close' : 'check'} size={13} color={choice.tone === 'danger' ? '#fda4af' : '#fde68a'} />
                <Text style={[styles.decisionActionText, choice.tone === 'danger' && { color: '#fda4af' }]}>{choice.label}</Text>
              </Pressable>
            ))}
            {selected.allowText ? <Pressable disabled={busy} onPress={() => choose(selected.kind === 'approval' ? 'approve' : selected.kind === 'kanban_blocked' ? 'unblock' : selected.kind === 'run_owner' ? 'continue' : 'reply')} style={[styles.decisionAction, styles.decisionActionPrimary, busy && styles.actionOff]} accessibilityRole="button" testID="mesh-decision-reply"><MeshIcon name="check" size={13} color="#fde68a" /><Text style={styles.decisionActionText}>{selected.kind === 'run_input' ? 'Reply & resume' : 'Send note'}</Text></Pressable> : null}
          </View>
          <Pressable onPress={() => onOpenLink?.(selected)} style={styles.decisionLink} accessibilityRole="link"><Text style={styles.decisionLinkText}>{selected.link?.label || 'Open item'}</Text><MeshIcon name="chevronRight" size={13} color={GOLD_LT} /></Pressable>
          {status ? <Text style={styles.decisionStatus}>{status}</Text> : null}
          {error ? <Text style={styles.decisionError} accessibilityLiveRegion="assertive">{error}</Text> : null}
        </ScrollView>
      )}
    </MeshSheet>
  );
}

/** Long-press menu: the web's touch sheet (incl. the radial actions) for an agent, or the map menu. */
export function MeshActionSheet({ title, items, onClose, landscape }) {
  return (
    <MeshSheet visible={!!items} onClose={onClose} testID="mesh-action-sheet" maxHeight={0.7} landscape={landscape}>
      <Text style={styles.sheetTitle} numberOfLines={1}>{(title || 'Agent Mesh').toUpperCase()}</Text>
      <ScrollView style={{ flexGrow: 0 }}>
        {(items || []).map((it, i) => (it.sep ? <View key={`s${i}`} style={styles.sep} /> : (
          <Pressable key={it.label} onPress={it.disabled ? undefined : () => { onClose(); it.run?.(); }} style={({ pressed }) => [styles.item, pressed && !it.disabled && styles.itemPressed]} accessibilityRole="menuitem" accessibilityState={{ disabled: !!it.disabled }} testID={`mesh-sheet-${it.label.replace(/\W+/g, '-').toLowerCase()}`}>
            <Text style={[styles.itemText, it.disabled && styles.offText, it.danger && { color: '#fb7185' }]}>{it.label}</Text>
          </Pressable>
        )))}
      </ScrollView>
    </MeshSheet>
  );
}

export const sheetStyles = StyleSheet.create({
  title: { color: GOLD_LT, fontSize: 11, letterSpacing: 1.6, fontFamily: MONO, paddingHorizontal: 6, paddingBottom: 8 },
});

const styles = StyleSheet.create({
  backdropWrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 8, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(232,200,104,0.42)', backgroundColor: '#0f1014', overflow: 'hidden' },
  sheetSide: { maxWidth: 460, alignSelf: 'flex-end', marginRight: 12 },
  accent: { position: 'absolute', left: 0, top: 0, right: 0, height: 120, backgroundColor: 'rgba(212,175,55,0.07)' },
  grip: { width: 38, height: 4, borderRadius: 2, backgroundColor: 'rgba(212,175,55,0.45)', alignSelf: 'center', marginBottom: 10 },
  cardAccent: { position: 'absolute', left: -16, top: 0, bottom: 0, width: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logoWrap: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)', backgroundColor: '#0b0d14', alignItems: 'center', justifyContent: 'center' },
  logo: { width: 24, height: 24 },
  name: { color: '#f4f4f5', fontSize: 15, fontWeight: '700' },
  role: { color: GOLD_LT, fontSize: 12, fontWeight: '600' },
  id: { color: '#8b8778', fontSize: 10.5, fontFamily: MONO },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  status: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  close: { width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  closeText: { color: '#d4d4d8', fontSize: 13 },
  work: { borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(255,255,255,0.03)', padding: 12, gap: 6 },
  kicker: { color: GOLD, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.6 },
  task: { color: '#f4f4f5', fontSize: 13, fontWeight: '600', lineHeight: 18 },
  activity: { color: '#d4d4d8', fontSize: 11 },
  dim: { color: '#71717a', fontSize: 11 },
  progRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progVal: { color: GOLD, fontSize: 11, fontWeight: '700' },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: GOLD_LT },
  metrics: { flexDirection: 'row', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  metric: { flex: 1, padding: 9, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: 'rgba(255,255,255,0.08)', gap: 3 },
  metricLabel: { color: '#71717a', fontSize: 8.5, letterSpacing: 1.1, fontWeight: '600' },
  metricValue: { color: '#f4f4f5', fontSize: 12.5, fontWeight: '600' },
  latest: { gap: 4 },
  latestRow: { color: '#d4d4d8', fontSize: 11.5 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6 },
  metaItem: { width: '50%', color: '#71717a', fontSize: 11 },
  metaVal: { color: '#d4d4d8' },
  review: { color: '#d4d4d8', fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { flexGrow: 1, flexBasis: '22%', minHeight: 52, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(10,14,26,0.72)', alignItems: 'center', justifyContent: 'center', gap: 2 },
  actionPrimary: { borderColor: 'rgba(212,175,55,0.7)', backgroundColor: 'rgba(212,175,55,0.12)' },
  actionPressed: { backgroundColor: 'rgba(30,41,59,0.85)' },
  actionOff: { opacity: 0.45 },
  actionIcon: { color: GOLD_LT, fontSize: 14 },
  actionText: { color: '#f4f4f5', fontSize: 11.5, fontWeight: '600' },
  offText: { color: '#71717a' },
  compose: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: { flex: 1, minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(212,175,55,0.45)', paddingHorizontal: 12, color: '#f4f4f5', backgroundColor: 'rgba(0,0,0,0.35)' },
  send: { width: 44, height: 42, borderRadius: 10, backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center' },
  sendText: { color: '#1a1408', fontSize: 16, fontWeight: '800' },
  note: { color: '#86efac', fontSize: 11 },
  decisionBadge: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: 'rgba(245,197,66,0.48)', borderRadius: 12, padding: 10, backgroundColor: 'rgba(245,197,66,0.08)' },
  decisionBadgeTitle: { color: '#fde68a', fontSize: 9.5, fontWeight: '800', letterSpacing: 1.1, fontFamily: MONO },
  decisionBadgeQuestion: { color: '#e8e6e3', fontSize: 11, lineHeight: 15, marginTop: 3 },
  decisionHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  decisionHeadIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,197,66,0.1)', borderWidth: 1, borderColor: 'rgba(245,197,66,0.36)' },
  decisionSheetTitle: { color: '#fde68a', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, fontFamily: MONO },
  decisionSheetCount: { color: '#8b8778', fontSize: 10, marginTop: 2, fontFamily: MONO },
  decisionBack: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)' },
  decisionRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)', borderRadius: 11, padding: 10, backgroundColor: 'rgba(255,255,255,0.025)' },
  decisionRowIcon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(245,197,66,0.08)' },
  decisionRowTitle: { color: '#f5f2e9', fontSize: 12, fontWeight: '700' },
  decisionRowQuestion: { color: '#8f8b82', fontSize: 10.5, lineHeight: 14, marginTop: 2 },
  decisionQuestion: { color: '#f5f2e9', fontSize: 14, lineHeight: 20, fontWeight: '700' },
  decisionContext: { color: '#9d998f', fontSize: 11, lineHeight: 16 },
  decisionInput: { minHeight: 62, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(245,197,66,0.35)', paddingHorizontal: 11, paddingVertical: 9, color: '#f5f2e9', backgroundColor: 'rgba(0,0,0,0.3)', textAlignVertical: 'top', fontFamily: MONO, fontSize: 11 },
  decisionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  decisionAction: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(255,255,255,0.035)' },
  decisionActionPrimary: { borderColor: 'rgba(245,197,66,0.58)', backgroundColor: 'rgba(245,197,66,0.1)' },
  decisionActionDanger: { borderColor: 'rgba(251,113,133,0.48)', backgroundColor: 'rgba(127,29,29,0.14)' },
  decisionActionText: { color: '#fde68a', fontSize: 11, fontWeight: '700', fontFamily: MONO },
  decisionLink: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingVertical: 4 },
  decisionLinkText: { color: GOLD_LT, fontSize: 10.5, textDecorationLine: 'underline', fontFamily: MONO },
  decisionStatus: { color: '#86efac', fontSize: 10.5, fontFamily: MONO },
  decisionError: { color: '#fb7185', fontSize: 10.5, lineHeight: 15, fontFamily: MONO },
  sheetTitle: { color: '#e9c46a', fontSize: 11, letterSpacing: 1.4, fontFamily: MONO, paddingHorizontal: 6, paddingBottom: 6 },
  item: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10 },
  itemPressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
  itemText: { color: '#e4e4e7', fontSize: 13.5, fontFamily: MONO },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 4, marginHorizontal: 6 },
});
