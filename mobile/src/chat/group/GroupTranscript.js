/**
 * GroupTranscript — the group conversation, twin of the web's `.gc-scroll`:
 * per-agent attributed messages (avatar, name in the agent's colour, @handle,
 * time), the user's bubbles, workflow status lines, a live bubble per agent
 * currently speaking (typing dots → streamed text), the workflow run card and
 * the run filter. Composer parity: user image attachments, the model each
 * reply used, and the chat panels (show_panel / plugin cards) a member's run
 * produced — the same PanelCard the 1:1 transcript renders.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useChatTokens } from '../chat-tokens';
import { MarkdownText, PanelCard, TranscriptSkeleton, TypingDots } from '../ChatTranscript';
import { shortModel } from './composer-logic';
import { GroupAvatar, AvatarStack } from './GroupAvatar';
import { ActivityLedger } from './GroupContext';
import { MODE_LABELS, agentColor, cardRun, filterMessages, rosterName } from './group-logic';
import { runOptions } from './workflow-logic';
import { tap } from '../../utils/haptics';

const STEP_ICON = { pending: 'ellipse-outline', running: 'sync', done: 'checkmark-circle', error: 'alert-circle', skipped: 'remove-circle-outline' };

export const RunCard = memo(function RunCard({ run, agents }) {
  const t = useChatTokens();
  const tone = run.status === 'running' ? t.accent : run.status === 'done' ? t.ok : t.danger;
  return (
    <View style={[styles.run, { borderColor: tone, backgroundColor: t.surface }]} accessibilityLabel={`Workflow ${run.workflowName}, ${run.status}`}>
      <View style={styles.runTop}>
        {run.status === 'running'
          ? <ActivityIndicator size="small" color={tone} />
          : <Ionicons name={run.status === 'done' ? 'checkmark-circle' : 'alert-circle'} size={16} color={tone} />}
        <Text numberOfLines={1} style={[styles.runName, { color: t.textStrong, fontFamily: t.font.semiBold }]}>{run.workflowName}</Text>
        <Text style={{ color: tone, fontSize: 11, fontFamily: t.font.semiBold, textTransform: 'uppercase', letterSpacing: 0.5 }}>{run.status}</Text>
      </View>
      <View style={styles.steps}>
        {run.steps.map((s) => {
          const c = s.status === 'running' ? t.accent : s.status === 'done' ? t.ok : s.status === 'error' ? t.danger : t.muted;
          return (
            <View key={s.nodeId} style={[styles.step, { borderColor: s.status === 'running' ? t.accent : t.borderNeutral }]}>
              <GroupAvatar id={s.agentId} name={rosterName(agents, s.agentId)} size={18} />
              <Text numberOfLines={1} style={{ color: s.status === 'pending' ? t.muted : t.text, fontSize: 12, fontFamily: t.font.medium, maxWidth: 110 }}>
                {s.label || rosterName(agents, s.agentId)}
              </Text>
              <Ionicons name={STEP_ICON[s.status] || 'ellipse-outline'} size={13} color={c} />
            </View>
          );
        })}
      </View>
    </View>
  );
});

function RunFilter({ runs, value, onChange }) {
  const t = useChatTokens();
  const opts = useMemo(() => runOptions(runs), [runs]);
  if (!opts.length) return null;
  const Chip = ({ id, label, on, icon }) => (
    <Pressable
      onPress={() => { tap(); onChange(id); }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[styles.chip, { borderColor: on ? t.accent : t.borderNeutral, backgroundColor: on ? t.accentSoft : t.surface }]}
    >
      {icon}
      <Text numberOfLines={1} style={{ color: on ? t.textStrong : t.text, fontSize: 12, fontFamily: t.font.medium, maxWidth: 170 }}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filter} accessibilityLabel="Filter by workflow run">
      <Ionicons name="funnel-outline" size={13} color={t.muted} style={{ alignSelf: 'center' }} />
      <Chip id={null} label="All messages" on={!value} />
      {opts.map((r) => (
        <Chip
          key={r.id}
          id={r.id}
          on={value === r.id}
          label={`${r.name} · ${r.status === 'running' ? `${r.done}/${r.total}` : r.status}`}
          icon={r.status === 'running' ? <ActivityIndicator size="small" color={t.accent} style={{ transform: [{ scale: 0.6 }], width: 14, height: 14 }} /> : null}
        />
      ))}
    </ScrollView>
  );
}

const Message = memo(function Message({ m, agents, group, onShowRun, runFilter, sendReq, onOpenLink }) {
  const t = useChatTokens();
  if (m.kind === 'status') {
    return (
      <View>
      <View style={styles.status}>
        <View style={[styles.statusLine, { backgroundColor: t.borderNeutral }]} />
        <Text style={{ color: t.muted, fontSize: 12, textAlign: 'center', flexShrink: 1 }}>{m.text}</Text>
        {m.workflowRunId && runFilter !== m.workflowRunId ? (
          <Pressable onPress={() => onShowRun(m.workflowRunId)} hitSlop={8} accessibilityRole="button">
            <Text style={{ color: t.accent, fontSize: 12, fontFamily: t.font.semiBold }}>Show run</Text>
          </Pressable>
        ) : null}
        <View style={[styles.statusLine, { backgroundColor: t.borderNeutral }]} />
      </View>
      {m.activity || m.unverified ? <View style={styles.statusLedger}><ActivityLedger activity={m.activity} unverified={m.unverified} /></View> : null}
      </View>
    );
  }
  if (m.kind === 'user') {
    const isCmd = m.text.startsWith('/');
    return (
      <View style={styles.user}>
        {m.images?.length ? (
          <View style={styles.userImgs}>
            {m.images.map((uri, i) => <Image key={i} source={{ uri }} style={[styles.userImg, { borderColor: t.border, backgroundColor: t.surfaceStrong }]} accessibilityLabel="Attached image" />)}
          </View>
        ) : null}
        {m.text ? <View style={[styles.bubble, { maxWidth: `${t.size.bubbleMaxWidthPct}%`, paddingVertical: t.size.bubblePadV, paddingHorizontal: t.size.bubblePadH, borderRadius: t.radius.bubble, backgroundColor: t.surfaceStrong, borderColor: t.border }]}>
          <Text selectable style={{ color: t.textStrong, fontFamily: isCmd ? t.font.mono : t.font.regular, fontSize: isCmd ? 13 : t.type.body, lineHeight: Math.round(t.type.body * t.type.bubbleLineHeight) }}>{m.text}</Text>
        </View> : null}
      </View>
    );
  }
  const name = rosterName(agents, m.agentId, m.agentName || group?.members?.find((x) => x.id === m.agentId)?.name);
  const time = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return (
    <AgentRow id={m.agentId} name={name} url={agents?.find((a) => a.id === m.agentId)?.identity?.avatarUrl} time={time} tag={m.workflowRunId ? 'workflow' : null} model={m.model} error={m.error}>
      {m.error
        ? <Text style={[styles.err, { color: t.danger, backgroundColor: t.dangerSubtle, borderColor: t.danger }]}>{m.text}</Text>
        : m.text ? <MarkdownText text={m.text} /> : null}
      {m.panels?.length ? (
        <View style={styles.panels}>
          {m.panels.map((p, i) => <PanelCard key={p.panelId || i} panel={p} sendReq={sendReq} onOpenLink={onOpenLink} />)}
        </View>
      ) : null}
      {m.activity || m.unverified ? <ActivityLedger activity={m.activity} unverified={m.unverified} /> : null}
    </AgentRow>
  );
});

function AgentRow({ id, name, url, time, tag, model, error, live, children }) {
  const t = useChatTokens();
  const avatarUrl = url;
  return (
    <View style={styles.agent} accessibilityLabel={`${name}${live ? ' is replying' : ''}`}>
      <GroupAvatar id={id} name={name} url={avatarUrl} size={30} style={styles.agentAv} />
      <View style={[styles.agentBody, live ? { borderLeftColor: agentColor(id || name, { a: 0.6 }), borderLeftWidth: 2, paddingLeft: 10 } : null]}>
        <View style={styles.agentHead}>
          <Text numberOfLines={1} style={{ color: error ? t.danger : agentColor(id || name, { l: 70, s: 65 }), fontFamily: t.font.semiBold, fontSize: 13.5, flexShrink: 1 }}>{name}</Text>
          <Text numberOfLines={1} style={{ color: t.muted, fontFamily: t.font.mono, fontSize: 11 }}>@{id || 'agent'}</Text>
          {tag ? <Text style={[styles.tag, { color: t.accent, borderColor: t.borderStrong }]}>{tag}</Text> : null}
          {model ? <Text numberOfLines={1} style={[styles.model, { color: t.muted, borderColor: t.borderNeutral }]}>{shortModel(model)}</Text> : null}
          {time ? <Text style={{ color: t.mutedStrong, fontSize: 11, marginLeft: 'auto' }}>{time}</Text> : null}
        </View>
        {children}
      </View>
    </View>
  );
}

export function GroupTranscript({ group, agents, members, onShowRun, onRefresh, refreshing, contentStyle, bottomPad, topPad = 12, sendReq, onOpenLink }) {
  const t = useChatTokens();
  const listRef = useRef(null);
  const nearBottom = useRef(true);
  const g = group.group;
  const runFilter = group.runFilter;
  const filtered = useMemo(() => filterMessages(group.messages, runFilter ? { runId: runFilter } : null), [group.messages, runFilter]);
  const liveTurns = useMemo(
    () => Object.values(group.live).filter((x) => !runFilter || x.workflowRunId === runFilter),
    [group.live, runFilter],
  );
  const data = useMemo(() => [
    ...filtered.map((m) => ({ type: 'msg', id: m.id, m })),
    ...liveTurns.map((x) => ({ type: 'live', id: `live-${x.runId}`, turn: x })),
  ], [filtered, liveTurns]);
  const card = cardRun(g, runFilter);

  // Stick to the newest message unless the user scrolled up. Scroll events
  // caused by our own scrollToEnd (or by content growing under it while
  // markdown lays out) must not un-stick it, so they're ignored briefly.
  const programmaticUntil = useRef(0);
  const toEnd = useCallback((animated) => {
    programmaticUntil.current = Date.now() + 900;
    listRef.current?.scrollToEnd({ animated });
  }, []);
  const tail = `${data.length}:${liveTurns.map((x) => x.text.length).join(',')}`;
  useEffect(() => {
    if (!nearBottom.current || !data.length) return undefined;
    const id = setTimeout(() => toEnd(true), 60);
    return () => clearTimeout(id);
  }, [tail, bottomPad]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { nearBottom.current = true; }, [runFilter, group.group?.key]);

  const onScroll = useCallback((e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120;
    if (near || Date.now() > programmaticUntil.current) nearBottom.current = near;
  }, []);

  const renderItem = useCallback(({ item }) => {
    if (item.type === 'msg') return <Message m={item.m} agents={agents} group={g} onShowRun={onShowRun} runFilter={runFilter} sendReq={sendReq} onOpenLink={onOpenLink} />;
    const x = item.turn;
    const name = rosterName(agents, x.agentId, g?.members?.find((m) => m.id === x.agentId)?.name);
    return (
      <AgentRow id={x.agentId} name={name} url={agents?.find((a) => a.id === x.agentId)?.identity?.avatarUrl} tag={x.workflowRunId ? 'workflow' : null} live>
        {x.text ? <MarkdownText text={x.text} /> : <TypingDots />}
      </AgentRow>
    );
  }, [agents, g, onShowRun, runFilter, sendReq, onOpenLink]);

  const header = (
    <View>
      {g?.runs?.length ? <RunFilter runs={g.runs} value={runFilter} onChange={(id) => group.setRunFilter(id)} /> : null}
      {card ? <RunCard run={card} agents={agents} /> : null}
    </View>
  );

  if (group.loading && !group.messages.length) {
    return <View style={[contentStyle, { paddingTop: 20 }]}><TranscriptSkeleton /></View>;
  }

  return (
    <FlatList
      ref={listRef}
      data={data}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      onScroll={onScroll}
      onContentSizeChange={() => { if (nearBottom.current) toEnd(false); }}
      scrollEventThrottle={32}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={[contentStyle, { paddingTop: topPad, flexGrow: 1 }]}
      ListHeaderComponent={header}
      // A spacer, not paddingBottom: VirtualizedList.scrollToEnd ignores
      // content padding, so padding would leave the newest message under the composer.
      ListFooterComponent={<View style={{ height: bottomPad }} />}
      refreshControl={onRefresh ? <RefreshControl refreshing={Boolean(refreshing)} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} /> : undefined}
      ListEmptyComponent={
        <View style={styles.empty}>
          <AvatarStack members={members} size={44} max={5} />
          <Text style={[styles.emptyTitle, { color: t.textStrong, fontFamily: t.font.semiBold }]}>
            {runFilter ? 'No messages for this run yet' : `Say hello to ${members.map((m) => m.name).join(', ') || 'the group'}`}
          </Text>
          {!runFilter && g ? (
            <Text style={[styles.emptyText, { color: t.muted }]}>{MODE_LABELS[g.mode]?.hint} @mention an agent to ask just them.</Text>
          ) : null}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  run: { borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 14, gap: 10 },
  runTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runName: { flex: 1, fontSize: 14 },
  steps: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 999, paddingLeft: 3, paddingRight: 8, minHeight: 26 },
  filter: { flexDirection: 'row', gap: 6, paddingBottom: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, minHeight: 32 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14, paddingHorizontal: 4 },
  statusLine: { flex: 1, height: StyleSheet.hairlineWidth, minWidth: 12 },
  statusLedger: { marginTop: -8, marginBottom: 14, paddingHorizontal: 4 },
  user: { alignItems: 'flex-end', marginBottom: 16 },
  bubble: { borderWidth: 1 },
  userImgs: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, marginBottom: 6, maxWidth: '86%' },
  userImg: { width: 150, height: 110, borderRadius: 12, borderWidth: 1 },
  model: { fontSize: 10, borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, overflow: 'hidden', maxWidth: 120 },
  panels: { marginTop: 6, gap: 8 },
  agent: { flexDirection: 'row', gap: 10, marginBottom: 18 },
  agentAv: { marginTop: 1 },
  agentBody: { flex: 1, minWidth: 0, gap: 2 },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 20, marginBottom: 2 },
  tag: { fontSize: 10, borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, overflow: 'hidden', textTransform: 'uppercase', letterSpacing: 0.4 },
  err: { borderWidth: 1, borderRadius: 10, padding: 10, fontSize: 13, overflow: 'hidden' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24, paddingVertical: 40 },
  emptyTitle: { fontSize: 17, textAlign: 'center', marginTop: 6 },
  emptyText: { fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
});
