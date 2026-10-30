/**
 * WorkspaceChat — the "Workspace agent" panel (web renderAgent).
 *
 * Same session as the web (`agent:coder:workspace-<directoryId>`), same
 * transport (chat.send + the `chat` / `agent` broadcasts via useSessionChat),
 * same rendering as the app's Chat tab (ChatTurn / ChatComposer). Each send
 * first records a Git checkpoint (workspace.version.create) exactly like the
 * web, and appends the selected preview element as context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Chip, MONO_FAMILY, RADIUS, SPACE, useUIKit } from '../../ui-kit';
import { ChatComposer } from '../../chat/ChatComposer';
import { BrandAvatar, ChatTurn, TranscriptSkeleton } from '../../chat/ChatTranscript';
import { useSessionChat } from '../../chat/useSessionChat';
import { tap } from '../../utils/haptics';
import { COMPOSER_SUGGESTIONS, composeAgentMessage, formatWhen, quickActionsForMode } from './workspace-model';
import { confirmAction } from './WorkspaceSheets';

export function WorkspaceChat({ gateway, ws, draft, onOpenModel, onShowVersions, compactHeader = false }) {
  const { colors, type, alpha } = useUIKit();
  const chat = useSessionChat(gateway, ws.sessionKey);
  const listRef = useRef(null);
  const [composerDraft, setComposerDraft] = useState({ text: '', key: 0 });

  // A prefill handed in (Fix with agent / Edit with AI / quick action) lands in the box, never auto-sent.
  useEffect(() => {
    if (draft?.text) setComposerDraft({ text: draft.text, key: draft.key });
  }, [draft?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const prefill = useCallback((text) => {
    tap();
    setComposerDraft((d) => ({ text, key: d.key + 1 }));
  }, []);

  const send = useCallback(async (text) => {
    const msg = composeAgentMessage(text, ws.selectedElement);
    if (!msg) return;
    await ws.createCheckpoint(text);
    const ok = await chat.send(msg);
    if (ok) ws.setSelectedElement(null);
  }, [chat, ws]);

  const last = chat.turns[chat.turns.length - 1];
  const tail = `${chat.turns.length}:${last?.blocks?.length || 0}:${last?.blocks?.[last.blocks.length - 1]?.text?.length || 0}`;
  useEffect(() => {
    const id = setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [tail]);

  // Agent turns edit files: refresh the tree + git when a run settles.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !chat.isStreaming) {
      ws.loadTree(undefined, { quiet: true });
      ws.loadGit();
      ws.tabs.forEach((t) => { if (!t.dirty) ws.reloadTab(t.path); });
    }
    wasStreaming.current = chat.isStreaming;
  }, [chat.isStreaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const modelLabel = ws.agentModel || ws.agentDefaultModel || 'default';
  const quick = quickActionsForMode(ws.projectMode);

  const checkpoints = ws.versions.slice(0, 3).map((v) => (
    <View key={v.id} style={[styles.checkpoint, { borderColor: colors.border, backgroundColor: alpha(colors.primary, 0.05) }]} testID="workspace-checkpoint">
      <Ionicons name="git-commit-outline" size={16} color={colors.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>{v.description}</Text>
        <Text style={[type.monoSmall, { color: colors.textMuted }]}>Checkpoint · {v.commit.slice(0, 8)} · {formatWhen(v.createdAt)}</Text>
      </View>
      <Pressable onPress={() => { onShowVersions?.(); ws.showVersionDiff(v.id); }} style={styles.cpBtn} accessibilityRole="button" accessibilityLabel="View checkpoint diff">
        <Text style={[type.caption, { color: colors.primary }]}>Diff</Text>
      </Pressable>
      <Pressable
        onPress={() => confirmAction('Revert to checkpoint', `Restore the files to "${v.description}"?`, 'Revert', () => ws.revertVersion(v.id))}
        style={styles.cpBtn}
        accessibilityRole="button"
        accessibilityLabel="Revert to checkpoint"
      >
        <Text style={[type.caption, { color: colors.error }]}>Revert</Text>
      </Pressable>
    </View>
  ));

  const activity = ws.activity.map((a) => (
    <View key={a.id} style={[styles.checkpoint, { borderColor: a.error ? alpha(colors.error, 0.5) : colors.border }]}>
      <Ionicons name={a.pending ? 'hourglass-outline' : a.error ? 'alert-circle-outline' : 'git-network-outline'} size={16} color={a.error ? colors.error : colors.primary} />
      <Text style={[type.small, { color: colors.textSecondary, flex: 1 }]} numberOfLines={4}>{a.text}</Text>
      <Pressable onPress={() => ws.dismissActivity(a.id)} style={styles.cpBtn} accessibilityRole="button" accessibilityLabel="Dismiss">
        <Ionicons name="close" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  ));

  let body;
  if (chat.loading && chat.turns.length === 0) {
    body = <View style={{ padding: SPACE.lg }}><TranscriptSkeleton /></View>;
  } else if (chat.turns.length === 0) {
    body = (
      <ScrollView contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled">
        <View style={[styles.emptyIcon, { borderColor: colors.borderStrong || colors.border, backgroundColor: alpha(colors.primary, 0.08) }]}>
          <Ionicons name="sparkles" size={24} color={colors.primary} />
        </View>
        <Text style={[type.h3, { color: colors.text }]}>Build by describing it</Text>
        <Text style={[type.small, { color: colors.textMuted, textAlign: 'center', maxWidth: 320 }]}>
          Your workspace agent can edit files, run commands, and use the selected preview element as context.
        </Text>
        {chat.error ? <Text style={[type.caption, { color: colors.error }]}>{chat.error}</Text> : null}
        <View style={{ alignSelf: 'stretch', gap: SPACE.sm, marginTop: SPACE.md }}>{activity}{checkpoints}</View>
      </ScrollView>
    );
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={chat.turns}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <ChatTurn turn={item} agentName="Workspace agent" sendReq={gateway?.sendReq} />}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.md }}
        ListFooterComponent={
          <View style={{ gap: SPACE.sm }}>
            {chat.live.error ? <Text style={[type.small, { color: colors.error }]}>{chat.live.error}</Text> : null}
            {activity}
            {checkpoints}
          </View>
        }
      />
    );
  }

  return (
    <View style={styles.flex} testID="workspace-chat">
      <View style={[styles.head, { borderBottomColor: colors.borderSubtle }]}>
        <BrandAvatar size={32} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.smallStrong, { color: colors.text }]} numberOfLines={1}>Workspace agent</Text>
          <Text style={[type.caption, { color: chat.isStreaming ? colors.primary : colors.textMuted }]} numberOfLines={1}>
            {chat.isStreaming ? 'Working in this project…' : chat.connected ? 'Ready to build with you' : 'Offline'}
          </Text>
        </View>
        <Pressable
          onPress={onOpenModel}
          accessibilityRole="button"
          accessibilityLabel="Choose the agent model"
          style={[styles.modelPill, { borderColor: colors.border, backgroundColor: alpha(colors.text, 0.04) }]}
        >
          <Ionicons name="hardware-chip-outline" size={14} color={colors.primary} />
          <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary, maxWidth: compactHeader ? 80 : 110 }} numberOfLines={1}>{modelLabel}</Text>
          {!ws.agentModel ? <Text style={[type.caption, { color: colors.textMuted }]}>DEFAULT</Text> : null}
        </Pressable>
      </View>
      <View style={styles.flex}>{body}</View>
      {compactHeader ? null : <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={styles.suggest} keyboardShouldPersistTaps="handled">
        {[...COMPOSER_SUGGESTIONS.map((s) => ({ label: s, prompt: s })), ...quick].map((q) => (
          <Chip key={q.label} label={q.label} onPress={() => prefill(q.prompt)} accessibilityLabel={`Suggest: ${q.label}`} />
        ))}
      </ScrollView>}
      {ws.selectedElement ? (
        <View style={[styles.selCtx, { borderColor: colors.border, backgroundColor: alpha(colors.primary, 0.06) }]} testID="workspace-composer-context">
          <Ionicons name="locate-outline" size={16} color={colors.primary} />
          <Text style={[type.smallStrong, { color: colors.text }]}>Selected element</Text>
          <Text style={{ fontFamily: MONO_FAMILY, fontSize: 12, color: colors.textSecondary, flex: 1 }} numberOfLines={1}>{ws.selectedElement.selector}</Text>
          <Pressable onPress={() => ws.setSelectedElement(null)} style={styles.cpBtn} accessibilityRole="button" accessibilityLabel="Remove element context">
            <Ionicons name="close" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      ) : null}
      <View style={styles.composer}>
        <ChatComposer
          onSend={send}
          onAbort={chat.abort}
          isStreaming={chat.isStreaming}
          disabled={!chat.connected || !ws.selectedId}
          placeholder="Describe what you want to change…"
          draft={composerDraft.text}
          draftKey={composerDraft.key}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  head: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  modelPill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.md, minHeight: 44, flexShrink: 0 },
  empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, padding: SPACE.lg },
  emptyIcon: { width: 52, height: 52, borderRadius: RADIUS.md, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
  checkpoint: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md, minHeight: 52 },
  cpBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  suggest: { gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingVertical: SPACE.xs },
  selCtx: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginHorizontal: SPACE.md, borderWidth: 1, borderRadius: RADIUS.md, paddingLeft: SPACE.md },
  composer: { paddingHorizontal: SPACE.sm, paddingTop: SPACE.xs, paddingBottom: SPACE.sm },
});
