/**
 * ChatScreen — the Chat tab. The same conversations as the web chat
 * (/webchat), read from and written to the gateway session store, in the same
 * visual language.
 *
 *   ┌ header: [chats]  title · agent ▾ · status          [sub-agents] [new] ┐
 *   │ transcript (web-styled turns, tool cards, live panels)                 │
 *   │ composer — floats above the dock, lifts with the keyboard              │
 *   └────────────────────────────────────────────────────────────────────────┘
 *
 * Phones: the chats list is a slide-in drawer. Tablets (>= 900pt): it docks on
 * the left and the transcript keeps the web's 768pt reading column.
 *
 * All state lives in `gateway.chat` (src/chat/useChatSync.js) so it survives
 * tab switches and keeps receiving live events while another tab is open.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AgentChip, AgentPicker } from '../chat/AgentSwitcher';
import { ChatComposer } from '../chat/ChatComposer';
import { CliModeSwitcher } from '../chat/CliModeSwitcher';
import { CLI_LABELS, folderName } from '../chat/cli-route';
import { ChatSessionsDrawer, ChatSessionsPanel } from '../chat/ChatSessionsPanel';
import { BrandAvatar, ChatTurn, TranscriptSkeleton } from '../chat/ChatTranscript';
import { useChatTokens } from '../chat/chat-tokens';
import { agentLabel, sessionTitle } from '../chat/session-sync';
import { SubAgentActivity } from '../components/SubAgentActivity';
import { DOCK_HEIGHT, DOCK_H_MARGIN, DOCK_V_MARGIN_BASE } from '../components/FloatingDock';
import { tap } from '../utils/haptics';
import { withAlpha } from '../theme/color-utils';

import { bindingPatch, isGroupChatKey, isGroupBusy, memberInfos, MODE_LABELS, MODES, rosterName } from '../chat/group/group-logic';
import { useGroupChat } from '../chat/group/useGroupChat';
import { GroupSheet } from '../chat/group/GroupSheet';
import { BindingChip } from '../chat/group/GroupContext';
import { GroupTranscript } from '../chat/group/GroupTranscript';
import { GroupComposer } from '../chat/group/GroupComposer';
import { WorkflowsPanel } from '../chat/group/WorkflowsPanel';
import { GroupRunSettingsSheet } from '../chat/group/GroupRunSettingsSheet';
import { settingsSummary, supportsComposerParity } from '../chat/group/composer-logic';
import { SlidersIcon } from '../infini/icons';
import { AvatarStack } from '../chat/group/GroupAvatar';
import { CHAT_TABLET_MIN as TABLET_MIN, CHAT_SIDE_WIDTH as SIDE_WIDTH, CHAT_READING_WIDTH as READING_WIDTH } from '../chat/layout';
import { openWebPath } from '../navigation/web-link';
import { useSecureMode } from '../secure/useSecureMode';
import { useSecureChatLane } from '../secure/useSecureChatLane';
import { isSecureSessionKey } from '../secure/secure-logic';
import { SecureBadge, SecureError, SecureToggle } from '../secure/SecureControls';


// Same starters as the web chat's empty state.
const SUGGESTIONS = [
  { title: 'Summarize my day', prompt: "Summarize what's on my plate today across tasks, projects and inbox." },
  { title: 'Plan a feature', prompt: 'Help me plan a new feature: ask me the key questions first.' },
  { title: 'Review my agents', prompt: 'Which agents are running right now and what are they working on?' },
  { title: 'Draft a message', prompt: 'Draft a short, friendly follow-up message to a client.' },
];

function HeaderButton({ icon, svg: Svg, onPress, label, active, badge, testID }) {
  const t = useChatTokens();
  return (
    <Pressable
      onPress={() => { tap(); onPress(); }}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: Boolean(active) }}
      testID={testID}
      style={({ pressed }) => [
        styles.headBtn,
        { borderColor: active ? t.borderStrong : t.borderNeutral, backgroundColor: active ? t.accentSoft : pressed ? t.rowHover : t.surface },
      ]}
    >
      {Svg ? <Svg size={19} color={active ? t.accent : t.text} /> : <Ionicons name={icon} size={19} color={active ? t.accent : t.text} />}
      {badge ? <View style={[styles.headBadge, { backgroundColor: t.accent, borderColor: t.bg }]} /> : null}
    </Pressable>
  );
}

export function ChatScreen({ navigation, route, gateway }) {
  const chat = gateway.chat;
  const { status, connect } = gateway;
  const connected = status === 'connected';
  const t = useChatTokens();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tablet = width >= TABLET_MIN;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [showSubAgents, setShowSubAgents] = useState(false);
  const [composerHeight, setComposerHeight] = useState(56);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const listRef = useRef(null);
  const nearBottomRef = useRef(true);

  // ── agent group chats (agent:<id>:groupchat-<id>) ──────────────────────
  const isGroup = isGroupChatKey(chat.activeKey);
  const group = useGroupChat({ sessionKey: isGroup ? chat.activeKey : null, connected, sendReq: gateway.sendReq, subscribeEvent: gateway.subscribeEvent });
  const groupMembers = useMemo(() => memberInfos(group.group, chat.agents), [group.group, chat.agents]);
  const groupBusy = isGroup && isGroupBusy(group);
  const [groupSheet, setGroupSheet] = useState(null); // null | 'create' | 'edit'
  const [groupSheetBusy, setGroupSheetBusy] = useState(false);
  const [groupSheetError, setGroupSheetError] = useState(null);
  const [groupTab, setGroupTab] = useState('chat');
  const [modeMenu, setModeMenu] = useState(false);
  const [groupRefreshing, setGroupRefreshing] = useState(false);
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const [runSettingsError, setRunSettingsError] = useState(null);
  const changeRunSettings = useCallback(async (change) => {
    setRunSettingsError(null);
    try {
      await group.setSettings(change);
    } catch (err) {
      setRunSettingsError(String(err?.message ?? err).replace(/^Error:\s*/, ''));
    }
  }, [group]);
  useEffect(() => { setGroupTab('chat'); }, [chat.activeKey]);

  // ── Secure Mode: a compact lane toggle by the composer; the key decides the lane.
  const secure = useSecureMode(gateway.sendReq, gateway.subscribeEvent, { connected });
  const lane = useSecureChatLane({ chat, secure, sendReq: gateway.sendReq });
  const keySecure = isSecureSessionKey(chat.activeKey);
  const [secureRowH, setSecureRowH] = useState(0);
  const showSecureRow = !isGroup || (keySecure && groupTab === 'chat');

  const openGroupSheet = useCallback((kind) => {
    setGroupSheetError(null);
    setGroupSheet(kind);
  }, []);

  const submitGroupSheet = useCallback(async (v) => {
    setGroupSheetBusy(true);
    setGroupSheetError(null);
    try {
      if (groupSheet === 'create') {
        const { binding, ...rest } = v;
        const res = await gateway.sendReq('groupchat.create', { ...rest, ...(binding ? { binding } : {}) });
        await chat.loadSessions({ silent: true });
        chat.openSession(res.key);
      } else {
        const binding = bindingPatch(v.binding, group.group?.binding);
        await group.update({
          members: v.members,
          mode: v.mode,
          moderatorId: v.moderatorId,
          settings: { model: v.settings?.model ?? null, thinkingLevel: v.settings?.thinkingLevel ?? null },
          ...(binding !== undefined ? { binding } : {}),
        });
        if (v.title && v.title !== sessionTitle(chat.activeRow)) await chat.renameSession(chat.activeKey, v.title);
      }
      setGroupSheet(null);
    } catch (err) {
      setGroupSheetError(String(err?.message ?? err).replace(/^Error:\s*/, ''));
    } finally {
      setGroupSheetBusy(false);
    }
  }, [groupSheet, gateway, chat, group]);

  const showRun = useCallback((runId) => {
    group.setRunFilter(runId);
    setGroupTab('chat');
  }, [group]);

  // Deep link / notification tap: chat/<sessionKey>.
  const linkedKey = route?.params?.sessionKey;
  useEffect(() => {
    if (!linkedKey) return;
    chat.openSession(linkedKey);
    navigation.setParams({ sessionKey: undefined });
  }, [linkedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Ask AI about this" from the knowledge graph (and any other screen): a
  // draft message to prefill the composer with. Kept until the next handoff.
  const draft = route?.params?.draft;
  const draftKey = route?.params?.draftKey || draft;

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => setKeyboardHeight(e.endCoordinates?.height || 0));
    const b = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => { a.remove(); b.remove(); };
  }, []);

  // Stick to the newest message unless the user scrolled up to read.
  const turnCount = chat.turns.length;
  const lastTurn = chat.turns[turnCount - 1];
  const tailSignature = `${turnCount}:${lastTurn?.blocks?.length || 0}:${lastTurn?.blocks?.[lastTurn.blocks.length - 1]?.text?.length || 0}`;
  useEffect(() => {
    if (!turnCount || !nearBottomRef.current) return undefined;
    const id = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(id);
  }, [tailSignature, turnCount, composerHeight, keyboardHeight]);

  useEffect(() => { nearBottomRef.current = true; }, [chat.activeKey]);

  // Renames / pins / deletes made on another device have no broadcast on
  // older gateways — re-read the list whenever it is brought into view.
  useEffect(() => {
    if (drawerOpen && connected) chat.loadSessions({ silent: true });
  }, [drawerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback((e) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    nearBottomRef.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 120;
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await chat.refresh(); } finally { setRefreshing(false); }
  }, [chat]);

  const openLink = useCallback((link, title) => {
    const path = link.path || (link.tab ? `/${link.tab}` : null);
    if (!path) return;
    openWebPath(navigation.getParent(), path, title || link.label);
  }, [navigation]);

  const agentName = agentLabel(chat.agents, chat.currentAgentId);
  const title = chat.activeKey
    ? (isGroup && !chat.activeRow?.label && group.group?.title ? group.group.title : sessionTitle(chat.activeRow))
    : 'New chat';
  const replying = Object.values(group.live || {}).map((x) => rosterName(chat.agents, x.agentId));

  // Composer sits above the floating dock; with the keyboard up it rides the keyboard.
  const dockClear = DOCK_HEIGHT + DOCK_V_MARGIN_BASE + Math.max(insets.bottom, 8) + 8;
  const composerBottom = keyboardHeight > 0 ? keyboardHeight + 8 : dockClear;
  // The group Workflows tab has no composer: don't reserve (or fade) room for one.
  const composerHeightEff = isGroup && groupTab === 'workflows' ? -36 : composerHeight + (showSecureRow ? secureRowH : 0);
  const listBottomPad = composerBottom + composerHeightEff + 48; // clears the fade above the composer

  const statusLabel = connected ? null : status === 'connecting' ? 'Connecting…' : 'Offline';

  const renderItem = useCallback(({ item }) => (
    <ChatTurn turn={item} agentName={agentName} sendReq={gateway.sendReq} onOpenLink={openLink} />
  ), [agentName, gateway.sendReq, openLink]);

  const column = useMemo(
    () => ({ width: '100%', maxWidth: READING_WIDTH, alignSelf: 'center', paddingHorizontal: tablet ? 20 : 14 }),
    [tablet],
  );

  let body;
  if (isGroup) {
    if (group.unsupported) {
      body = (
        <View style={styles.center}>
          <Ionicons name="people-outline" size={28} color={t.muted} />
          <Text style={[styles.centerTitle, { color: t.text }]}>Group chats need a gateway update</Text>
          <Text style={[styles.centerText, { color: t.muted }]}>This gateway was started before group chats were installed. Restart the gateway to open this group.</Text>
        </View>
      );
    } else if (group.error && !group.group) {
      body = (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={28} color={t.muted} />
          <Text style={[styles.centerTitle, { color: t.text }]}>Couldn't load this group</Text>
          <Text style={[styles.centerText, { color: t.muted }]}>{group.error}</Text>
          <Pressable onPress={() => group.reload()} style={[styles.retry, { borderColor: t.borderStrong }]} accessibilityRole="button">
            <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 13 }}>Try again</Text>
          </Pressable>
        </View>
      );
    } else if (groupTab === 'workflows') {
      body = (
        <WorkflowsPanel group={group} members={groupMembers} agents={chat.agents} contentStyle={column} bottomPad={listBottomPad} onRunStarted={showRun} />
      );
    } else {
      body = (
        <GroupTranscript
          group={group}
          agents={chat.agents}
          members={groupMembers}
          onShowRun={showRun}
          contentStyle={column}
          bottomPad={listBottomPad}
          refreshing={groupRefreshing}
          sendReq={gateway.sendReq}
          onOpenLink={openLink}
          onRefresh={async () => { setGroupRefreshing(true); try { await group.reload({ quiet: true }); } finally { setGroupRefreshing(false); } }}
        />
      );
    }
  } else if (chat.activeKey && chat.historyLoading && turnCount === 0) {
    body = <View style={[column, styles.pad]}><TranscriptSkeleton /></View>;
  } else if (chat.activeKey && chat.historyError && turnCount === 0) {
    body = (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={28} color={t.muted} />
        <Text style={[styles.centerTitle, { color: t.text }]}>Couldn't load this chat</Text>
        <Text style={[styles.centerText, { color: t.muted }]}>{chat.historyError}</Text>
        <Pressable onPress={() => chat.refresh()} style={[styles.retry, { borderColor: t.borderStrong }]} accessibilityRole="button">
          <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 13 }}>Try again</Text>
        </Pressable>
      </View>
    );
  } else if (turnCount === 0) {
    body = (
      <View style={[styles.center, { paddingBottom: listBottomPad }]}>
        <BrandAvatar size={56} />
        <Text style={[styles.heroTitle, { color: t.textStrong, fontFamily: t.font.bold }]}>How can I help?</Text>
        <Text style={[styles.centerText, { color: t.muted }]}>
          {chat.activeKey ? 'No messages in this chat yet.' : `You're talking to ${agentName}. Chats sync with the web.`}
        </Text>
        <View style={styles.suggest}>
          {SUGGESTIONS.map((s) => (
            <Pressable
              key={s.title}
              disabled={!connected}
              onPress={() => { tap(); chat.send(s.prompt); }}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.suggestItem,
                { borderColor: t.border, backgroundColor: pressed ? t.surfaceStrong : t.surface, borderRadius: t.radius.panel, opacity: connected ? 1 : 0.5 },
              ]}
            >
              <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 13 }}>{s.title}</Text>
              <Text numberOfLines={2} style={{ color: t.muted, fontSize: 12, lineHeight: 16 }}>{s.prompt}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  } else {
    body = (
      <FlatList
        ref={listRef}
        data={chat.turns}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        onScroll={onScroll}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={[column, { paddingTop: 16, paddingBottom: listBottomPad }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.accent} colors={[t.accent]} progressBackgroundColor={t.side} />}
        ListHeaderComponent={
          chat.hasOlder ? (
            <Pressable onPress={chat.loadOlder} disabled={chat.loadingOlder} style={styles.older} accessibilityRole="button">
              {chat.loadingOlder
                ? <ActivityIndicator size="small" color={t.accent} />
                : <Text style={{ color: t.accent, fontFamily: t.font.semiBold, fontSize: 12 }}>Load earlier messages</Text>}
            </Pressable>
          ) : null
        }
        ListFooterComponent={
          chat.live.error ? (
            <Text style={[styles.error, { color: t.danger, backgroundColor: t.dangerSubtle, borderColor: t.danger, borderRadius: t.radius.row }]}>
              {chat.live.error}
            </Text>
          ) : null
        }
      />
    );
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.split}>
        {tablet ? (
          <View style={{ width: SIDE_WIDTH }}>
            <ChatSessionsPanel chat={chat} connected={connected} docked onNewGroup={() => openGroupSheet('create')} />
          </View>
        ) : null}

        <View style={styles.main}>
          <View style={[styles.header, { borderBottomColor: t.borderNeutral }]}>
            {!tablet ? (
              <HeaderButton icon="menu" label="Open chats" onPress={() => setDrawerOpen(true)} badge={chat.unreadCount > 0} />
            ) : null}
            {isGroup && groupMembers.length ? <AvatarStack members={groupMembers} size={24} max={2} /> : null}
            <View style={styles.headTitles}>
              <Text numberOfLines={1} style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 16 }} accessibilityRole="header">
                {title}
              </Text>
              <View style={styles.headSub}>
                {isGroup ? (
                  <Text numberOfLines={1} style={{ color: groupBusy ? t.accent : t.muted, fontSize: 11.5, fontFamily: t.font.medium, flexShrink: 1 }}>
                    {groupBusy
                      ? (replying.length ? `${replying.join(', ')} replying…` : 'Working…')
                      : `${groupMembers.length} agent${groupMembers.length === 1 ? '' : 's'}`}
                    {!connected && statusLabel ? ` · ${statusLabel}` : ''}
                  </Text>
                ) : <AgentChip agents={chat.agents} agentId={chat.currentAgentId} onPress={() => setAgentPickerOpen(true)} />}
                {isGroup ? null : chat.isStreaming ? (
                  <Text style={{ color: t.accent, fontSize: 11, fontFamily: t.font.medium }}>replying…</Text>
                ) : statusLabel ? (
                  <Text style={{ color: status === 'connecting' ? t.warn : t.danger, fontSize: 11, fontFamily: t.font.medium }}>{statusLabel}</Text>
                ) : null}
              </View>
            </View>
            {isGroup && supportsComposerParity(group.group) ? (
              <HeaderButton
                svg={SlidersIcon}
                label={`Models and thinking: ${settingsSummary(group.group)}`}
                testID="group-run-settings-button"
                badge={Object.keys(group.group.memberSettings || {}).length > 0}
                onPress={() => { setRunSettingsError(null); setRunSettingsOpen(true); }}
              />
            ) : null}
            {secure.enabled || keySecure ? <SecureBadge compact label={secure.enabled ? 'Secure' : 'Locked'} /> : null}
            {isGroup ? (
              <HeaderButton icon="people-outline" label="Members and settings" onPress={() => openGroupSheet('edit')} />
            ) : null}
            {isGroup ? null : <HeaderButton
              icon="git-branch-outline"
              label={showSubAgents ? 'Hide sub-agent activity' : 'Show sub-agent activity'}
              active={showSubAgents}
              onPress={() => setShowSubAgents((v) => !v)}
            />}
            <HeaderButton icon="create-outline" label={keySecure && !isGroup ? 'New secure chat' : 'New chat'} onPress={() => (keySecure && !isGroup ? void lane.newSecureChat() : chat.newChat())} />
          </View>

          {!connected && status !== 'connecting' ? (
            <Pressable
              onPress={connect}
              style={[styles.offline, { backgroundColor: t.dangerSubtle, borderBottomColor: t.borderNeutral }]}
              accessibilityRole="button"
            >
              <Ionicons name="cloud-offline-outline" size={14} color={t.danger} />
              <Text style={{ color: t.text, fontSize: 12, flex: 1 }}>Not connected to the gateway. New messages will not send.</Text>
              <Text style={{ color: t.accent, fontSize: 12, fontFamily: t.font.semiBold }}>Reconnect</Text>
            </Pressable>
          ) : null}

          {showSubAgents && !isGroup ? <SubAgentActivity gateway={gateway} style={styles.subAgents} /> : null}

          {isGroup && group.group ? (
            <>
            {group.group.binding !== undefined ? (
              <View style={styles.gBind}>
                <BindingChip binding={group.group.binding} repo={group.group.repo} onPress={() => openGroupSheet('edit')} />
              </View>
            ) : null}
            <View style={[styles.gTabs, { borderBottomColor: t.borderNeutral }]} accessibilityRole="tablist">
              {[['chat', 'chatbubbles-outline', 'Chat'], ['workflows', 'git-network-outline', 'Workflows']].map(([k, icon, label]) => {
                const on = groupTab === k;
                const count = k === 'workflows' ? (group.group.workflows || []).length : 0;
                return (
                  <Pressable key={k} testID={`group-tab-${k}`} onPress={() => { tap(); setGroupTab(k); }} accessibilityRole="tab" accessibilityState={{ selected: on }}
                    style={[styles.gTab, { borderBottomColor: on ? t.accent : 'transparent' }]}>
                    <Ionicons name={icon} size={15} color={on ? t.accent : t.muted} />
                    <Text style={{ color: on ? t.textStrong : t.muted, fontFamily: t.font.semiBold, fontSize: 13 }}>{label}</Text>
                    {count ? <Text style={[styles.gCount, { color: t.accentForeground, backgroundColor: t.accent }]}>{count}</Text> : null}
                  </Pressable>
                );
              })}
              <View style={styles.flex} />
              <Pressable onPress={() => { tap(); setModeMenu(true); }} accessibilityRole="button" accessibilityLabel={`Who replies: ${MODE_LABELS[group.group.mode]?.label}. Change`}
                style={[styles.gMode, { borderColor: t.borderNeutral, backgroundColor: t.surface }]}>
                <Text numberOfLines={1} style={{ color: t.text, fontSize: 12, fontFamily: t.font.medium }}>{MODE_LABELS[group.group.mode]?.label}</Text>
                <Ionicons name="chevron-down" size={12} color={t.muted} />
              </Pressable>
            </View>
            </>
          ) : null}
          {isGroup && group.error && group.group ? (
            <Pressable onPress={() => group.setError(null)} style={[styles.gErr, { backgroundColor: t.dangerSubtle, borderBottomColor: t.borderNeutral }]} accessibilityRole="alert">
              <Text style={{ color: t.danger, fontSize: 12, flex: 1 }}>{group.error}</Text>
              <Ionicons name="close" size={14} color={t.danger} />
            </Pressable>
          ) : null}

          <View style={styles.flex}>{body}</View>

          {/* Fade the transcript out behind the composer + dock so text never
              shows through the gap between them. */}
          <LinearGradient
            pointerEvents="none"
            colors={[withAlpha(t.bg, 0), t.bg, t.bg]}
            locations={[0, 36 / (composerBottom + composerHeightEff + 36), 1]}
            style={[styles.fade, { height: composerBottom + composerHeightEff + 36 }]}
          />
          <View
            pointerEvents="box-none"
            style={[styles.composerWrap, { bottom: composerBottom, paddingHorizontal: tablet ? 20 : DOCK_H_MARGIN - 8 }]}
          >
            <View style={{ width: '100%', maxWidth: READING_WIDTH, alignSelf: 'center' }}>
              {showSecureRow ? (
                <View style={styles.secureRow} onLayout={(e) => setSecureRowH(e.nativeEvent.layout.height)}>
                  {lane.laneError ? <SecureError text={lane.laneError} onDismiss={lane.clearError} style={styles.flex} /> : <View style={styles.flex} />}
                  {isGroup ? (
                    <SecureBadge label="Secure group" />
                  ) : (
                    <SecureToggle
                      compact
                      value={keySecure}
                      busy={lane.switching || secure.busy}
                      disabled={!connected || !secure.supported}
                      onChange={(on) => { tap(); void lane.setLane(on); }}
                    />
                  )}
                </View>
              ) : null}
              {isGroup ? (
                groupTab === 'chat' && group.group ? (
                  <GroupComposer
                    key={chat.activeKey}
                    members={groupMembers}
                    group={group.group}
                    busy={groupBusy}
                    sending={group.sending}
                    disabled={!connected}
                    onSend={group.send}
                    onStop={group.stop}
                    onOpenSettings={() => { setRunSettingsError(null); setRunSettingsOpen(true); }}
                    settingsLabel={settingsSummary(group.group)}
                    onHeightChange={setComposerHeight}
                    secure={keySecure}
                  />
                ) : null
              ) : (
              <ChatComposer
                key={keySecure ? 'lane-secure' : 'lane-normal'}
                onSend={chat.send}
                onAbort={chat.abort}
                isStreaming={chat.isStreaming}
                disabled={!connected}
                placeholder={keySecure
                  ? `Secure message to ${agentName}`
                  : chat.route?.mode === 'cli'
                    ? `Message ${CLI_LABELS[chat.route.backend]} in ${folderName(chat.route.cwd)}`
                    : `Message ${agentName}`}
                accessory={keySecure ? null : (
                  <CliModeSwitcher
                    route={chat.route}
                    backends={chat.cliBackends}
                    cliSupported={chat.cliSupported === true}
                    folders={chat.cliFolders}
                    agentName={agentName}
                    onChange={chat.setRoute}
                    disabled={!connected || chat.isStreaming}
                  />
                )}
                onHeightChange={setComposerHeight}
                draft={keySecure ? undefined : draft}
                draftKey={keySecure ? undefined : draftKey}
                secure={keySecure}
              />
              )}
            </View>
          </View>

          {chat.toast ? (
            <View style={[styles.toast, { bottom: composerBottom + composerHeight + 10, backgroundColor: t.side, borderColor: t.borderStrong }]} accessibilityLiveRegion="polite">
              <Text style={{ color: t.text, fontSize: 13 }}>{chat.toast}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {!tablet ? (
        <ChatSessionsDrawer
          visible={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          chat={chat}
          connected={connected}
          width={Math.min(width * 0.86, 340)}
          onNewGroup={() => openGroupSheet('create')}
        />
      ) : null}
      <GroupSheet
        visible={Boolean(groupSheet)}
        onClose={() => setGroupSheet(null)}
        agents={chat.agents}
        heading={groupSheet === 'edit' ? 'Edit group' : 'New group chat'}
        submitLabel={groupSheet === 'edit' ? 'Save' : 'Create group'}
        initial={groupSheet === 'edit' && group.group
          ? { title: title, members: group.group.members.map((m) => m.id), mode: group.group.mode, moderatorId: group.group.moderatorId, binding: group.group.binding ?? null, settings: group.group.settings }
          : null}
        sendReq={gateway.sendReq}
        repo={groupSheet === 'edit' ? group.group?.repo ?? null : null}
        busy={groupSheetBusy}
        error={groupSheetError}
        onSubmit={submitGroupSheet}
        allowSecure={groupSheet === 'create'}
        defaultSecure={keySecure}
      />
      {isGroup && group.group ? (
        <GroupRunSettingsSheet
          visible={runSettingsOpen}
          onClose={() => setRunSettingsOpen(false)}
          group={group.group}
          members={groupMembers}
          agents={chat.agents}
          sendReq={gateway.sendReq}
          onChange={changeRunSettings}
          error={runSettingsError}
        />
      ) : null}
      {modeMenu && group.group ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setModeMenu(false)}>
          <Pressable style={styles.modeBackdrop} onPress={() => setModeMenu(false)} accessibilityLabel="Close" />
          <View style={[styles.modeSheet, { backgroundColor: t.side, borderColor: t.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 15, paddingHorizontal: 8, paddingBottom: 8 }}>Who replies</Text>
            {MODES.map((m) => {
              const on = group.group.mode === m;
              return (
                <Pressable key={m} onPress={() => { tap(); setModeMenu(false); group.setMode(m); }} accessibilityRole="radio" accessibilityState={{ checked: on }}
                  style={({ pressed }) => [styles.modeOpt, { backgroundColor: on ? t.accentSoft : pressed ? t.rowHover : 'transparent' }]}>
                  <View style={styles.flex}>
                    <Text style={{ color: t.textStrong, fontFamily: t.font.semiBold, fontSize: 14 }}>{MODE_LABELS[m].label}</Text>
                    <Text style={{ color: t.muted, fontSize: 12 }}>{MODE_LABELS[m].hint}</Text>
                  </View>
                  {on ? <Ionicons name="checkmark" size={16} color={t.accent} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Modal>
      ) : null}
      <AgentPicker
        visible={agentPickerOpen}
        onClose={() => setAgentPickerOpen(false)}
        agents={chat.agents}
        agentId={chat.currentAgentId}
        onPick={chat.pickAgent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  split: { flex: 1, flexDirection: 'row' },
  main: { flex: 1, minWidth: 0 },
  flex: { flex: 1 },
  pad: { paddingTop: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, minHeight: 60, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  headBtn: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  headBadge: { position: 'absolute', top: 8, right: 8, width: 9, height: 9, borderRadius: 5, borderWidth: 1.5 },
  headTitles: { flex: 1, minWidth: 0, gap: 4, paddingHorizontal: 4 },
  headSub: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  offline: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 40, borderBottomWidth: StyleSheet.hairlineWidth },
  subAgents: { marginHorizontal: 12, marginTop: 8, maxHeight: 240 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 24 },
  centerTitle: { fontSize: 16, fontWeight: '600', marginTop: 6 },
  centerText: { fontSize: 13, lineHeight: 19, textAlign: 'center', maxWidth: 320 },
  heroTitle: { fontSize: 22, marginTop: 10 },
  retry: { marginTop: 10, borderWidth: 1, borderRadius: 10, paddingHorizontal: 16, minHeight: 40, justifyContent: 'center' },
  suggest: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18, justifyContent: 'center', maxWidth: 560 },
  suggestItem: { flexBasis: '47%', flexGrow: 1, minWidth: 150, borderWidth: 1, padding: 12, gap: 4 },
  older: { alignSelf: 'center', minHeight: 40, justifyContent: 'center', paddingHorizontal: 16, marginBottom: 8 },
  error: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, overflow: 'hidden' },
  composerWrap: { position: 'absolute', left: 0, right: 0 },
  secureRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  gBind: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 6 },
  gTabs: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  gTab: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 42, paddingHorizontal: 10, borderBottomWidth: 2 },
  gCount: { fontSize: 10, fontWeight: '700', borderRadius: 8, minWidth: 16, paddingHorizontal: 4, textAlign: 'center', overflow: 'hidden' },
  gMode: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, height: 30, maxWidth: 160 },
  gErr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 36, borderBottomWidth: StyleSheet.hairlineWidth },
  modeBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' },
  modeSheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, borderBottomWidth: 0, padding: 12 },
  modeOpt: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 10, borderRadius: 12 },
  toast: { position: 'absolute', alignSelf: 'center', maxWidth: '88%', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
});

export default ChatScreen;
