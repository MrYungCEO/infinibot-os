/**
 * InboxScreen — native port of the web unified Inbox (/inbox,
 * ui/src/ui/views/inbox.ts):
 *
 *   account bar   All + one pill per connected account (unread badges from
 *                 gmail.insights lookbackDays 1) + Manage accounts
 *   view toggle   All Mail · Replies · Insights (unread / urgent badges)
 *   body          MailView + MessageDetail / RepliesView / InsightsView
 *   overlays      ComposeSheet (email.send), AccountsSheet (email.accounts.*),
 *                 ThreadAgentSheet (doc_agent on the open thread)
 *
 * Route params: { view?: 'mail'|'replies'|'insights', messageId?, threadId? }
 * — a message/thread id opens that message's detail in All Mail.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, StyleSheet, useWindowDimensions } from 'react-native';

import { useUIKit, SPACE, Screen, AppHeader, SegmentedControl, Chip, EmptyState } from '../../ui-kit';
import { withAlpha } from '../../theme/color-utils';
import { useRotationWhileFocused } from '../../infini/orientation';
import {
  INBOX_VIEWS,
  parseRouteParams,
  normalizeView,
  normalizeStatus,
  accountLabel,
  providerTag,
  totalUnread,
  activeUnread,
  replyCounts,
  patchMessage,
  threadAgentContext,
  errMessage,
  isUnknownMethod,
} from './inbox-model';
import { MailView } from './MailView';
import { MessageDetail } from './MessageDetail';
import { RepliesView } from './RepliesView';
import { InsightsView } from './InsightsView';
import { ComposeSheet } from './ComposeSheet';
import { AccountsSheet } from './AccountsSheet';
import { ThreadAgentSheet } from './ThreadAgentSheet';

function createReplyState() {
  return {
    loading: false,
    replies: [],
    error: null,
    filterClass: null,
    filterUrgency: null,
    showHandled: false,
    selectedReplyId: null,
  };
}

export function InboxScreen({ navigation, route, gateway }) {
  useRotationWhileFocused();
  const { colors } = useUIKit();
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  const sendReq = gateway?.sendReq;
  const connected = gateway?.status === 'connected';

  const initial = useMemo(() => parseRouteParams(route?.params), [route?.params]);
  const [view, setView] = useState(initial.view);
  const [accounts, setAccounts] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsError, setAccountsError] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const [activeAccountId, setActiveAccountId] = useState(null);
  const [unreadByAccount, setUnreadByAccount] = useState({});
  const [selectedMessage, setSelectedMessage] = useState(initial.messageId ? { id: initial.messageId, threadId: initial.messageId } : null);
  const [replyState, setReplyState] = useState(createReplyState);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [agentContext, setAgentContext] = useState(null);
  const [mailReloadKey, setMailReloadKey] = useState(0);
  const messagesRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Deep link changes while mounted (e.g. a second push lands here).
  useEffect(() => {
    const p = parseRouteParams(route?.params);
    setView(p.view);
    if (p.messageId) setSelectedMessage({ id: p.messageId, threadId: p.messageId });
  }, [route?.params]);

  const loadUnread = useCallback(
    async (list) => {
      for (const acc of list) {
        try {
          const ins = await sendReq('gmail.insights', { accountId: acc.id, lookbackDays: 1 });
          if (!mounted.current) return;
          setUnreadByAccount((u) => ({ ...u, [acc.id]: Number(ins?.unread) || 0 }));
        } catch {
          /* non-fatal (web behaviour) */
        }
      }
    },
    [sendReq],
  );

  const loadAccounts = useCallback(async () => {
    if (!sendReq) return;
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const s = normalizeStatus(await sendReq('gmail.status', {}));
      if (!mounted.current) return;
      setConfigured(s.configured);
      setAccounts(s.accounts);
      setUnreadByAccount((u) => Object.fromEntries(Object.entries(u).filter(([k]) => s.accounts.some((a) => a.id === k))));
      setUnavailable(false);
      loadUnread(s.accounts);
    } catch (e) {
      if (!mounted.current) return;
      if (isUnknownMethod(e)) setUnavailable(true);
      setAccountsError(errMessage(e));
    } finally {
      if (mounted.current) {
        setAccountsLoading(false);
        setAccountsLoaded(true);
      }
    }
  }, [sendReq, loadUnread]);

  useEffect(() => {
    if (connected && !accountsLoaded && !accountsLoading) loadAccounts();
  }, [connected, accountsLoaded, accountsLoading, loadAccounts]);

  const switchAccount = (id) => {
    if (id === activeAccountId) return;
    setActiveAccountId(id);
    setSelectedMessage(null);
  };

  const switchView = (v) => {
    setView(normalizeView(v));
  };

  const refreshReplies = () => {
    // Web parity: the Replies data source is still a TODO there (fake 600 ms spinner).
    setReplyState((s) => ({ ...s, loading: true }));
    setTimeout(() => mounted.current && setReplyState((s) => ({ ...s, loading: false })), 600);
  };

  const openCompose = (init) => {
    setComposeInitial(init || null);
    setComposeOpen(true);
  };

  const onPatched = (id, action) => {
    const r = messagesRef.current;
    if (r) r.setMessages((list) => patchMessage(list, id, action));
  };
  const onRemoved = (id, action) => {
    onPatched(id, action);
    setSelectedMessage(null);
  };

  const askAgentForMessage = (msg) => setAgentContext(threadAgentContext('mail', msg, null, activeAccountId));
  const askAgentForReply = (reply) => setAgentContext(threadAgentContext('replies', null, reply, activeAccountId));

  const unreadActive = activeUnread(unreadByAccount, activeAccountId);
  const { urgent } = replyCounts(replyState.replies);
  const segOptions = INBOX_VIEWS.map((v) => {
    const n = v.key === 'mail' ? unreadActive : v.key === 'replies' ? urgent : 0;
    return { key: v.key, label: n > 0 ? `${v.label} ${n > 99 ? '99+' : n}` : v.label };
  });

  const detailOpen = view === 'mail' && !!selectedMessage;
  const onBack = () => {
    if (detailOpen && !wide) {
      setSelectedMessage(null);
      return;
    }
    navigation?.goBack?.();
  };

  const activeAcc = accounts.find((a) => a.id === activeAccountId);
  const notConfigured = accountsLoaded && !configured && accounts.length === 0 && !accountsError;

  const accountBar = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.accountBar}>
      <Chip
        label="All"
        icon="albums-outline"
        tone="primary"
        count={totalUnread(unreadByAccount) || undefined}
        selected={activeAccountId === null}
        onPress={() => switchAccount(null)}
        accessibilityLabel="All accounts"
      />
      {accounts.map((a) => (
        <Chip
          key={a.id}
          label={`${providerTag(a)}  ${accountLabel(a)}`}
          tone="primary"
          count={unreadByAccount[a.id] || undefined}
          selected={activeAccountId === a.id}
          onPress={() => switchAccount(a.id)}
          accessibilityLabel={`Account ${accountLabel(a)}`}
        />
      ))}
      <Chip label="Manage accounts" icon="add" tone="neutral" onPress={() => setAccountsOpen(true)} accessibilityLabel="Add or manage email accounts" />
    </ScrollView>
  );

  const header = (
    <AppHeader
      eyebrow="Communication"
      title={detailOpen && !wide ? 'Message' : 'Inbox'}
      subtitle={activeAcc ? accountLabel(activeAcc) : accounts.length ? `All accounts · ${accounts.length}` : accountsLoading ? 'Loading accounts…' : undefined}
      leftIcon="chevron-back"
      leftLabel={detailOpen && !wide ? 'Back to messages' : 'Back'}
      onLeftPress={onBack}
      rightActions={[
        { key: 'compose', icon: 'create-outline', label: 'Compose email', onPress: () => openCompose(null) },
        { key: 'accounts', icon: 'people-circle-outline', label: 'Manage email accounts', onPress: () => setAccountsOpen(true) },
      ]}
    >
      {detailOpen && !wide ? null : (
        <View style={{ gap: SPACE.sm }}>
          {accountBar}
          <SegmentedControl options={segOptions} value={view} onChange={switchView} />
        </View>
      )}
    </AppHeader>
  );

  let body;
  if (!connected && !accountsLoaded) {
    body = <EmptyState icon="cloud-offline-outline" title="Not connected" message="Connect to your gateway to load the inbox." style={styles.empty} />;
  } else if (unavailable) {
    body = (
      <EmptyState
        icon="cloud-offline-outline"
        title="Inbox is not available on this gateway"
        message="This gateway does not expose the gmail.* methods."
        style={styles.empty}
      />
    );
  } else if (accountsError && !accounts.length) {
    body = (
      <EmptyState icon="alert-circle-outline" tone="danger" title="Could not load accounts" message={accountsError} actionLabel="Retry" onAction={loadAccounts} style={styles.empty} />
    );
  } else if (notConfigured) {
    body = (
      <EmptyState
        icon="mail-outline"
        title="No email accounts connected"
        message="Connect a Gmail account via OAuth or add a custom IMAP/SMTP account to start using the unified inbox."
        actionLabel="Connect an account"
        onAction={() => setAccountsOpen(true)}
        style={styles.empty}
      />
    );
  } else {
    const detail = selectedMessage ? (
      <MessageDetail
        gateway={gateway}
        accountId={activeAccountId}
        message={selectedMessage}
        onPatched={onPatched}
        onRemoved={onRemoved}
        onAskAgent={askAgentForMessage}
        onCompose={openCompose}
      />
    ) : null;
    body = (
      <View style={{ flex: 1 }}>
        <View style={[styles.mailWrap, view !== 'mail' && styles.hidden]}>
          <View style={[{ flex: 1 }, detailOpen && !wide && styles.hidden]}>
            <MailView
              gateway={gateway}
              accountId={activeAccountId}
              selectedId={selectedMessage?.id}
              onSelect={setSelectedMessage}
              onCompose={() => openCompose(null)}
              messagesRef={messagesRef}
              reloadKey={mailReloadKey}
              wide={wide}
            />
          </View>
          {wide ? (
            <View style={[styles.detailPane, { borderLeftColor: withAlpha(colors.primary, 0.18) }]}>
              {detail || <EmptyState icon="mail-open-outline" title="No message selected" message="Pick a message to read it here." style={styles.empty} />}
            </View>
          ) : detailOpen ? (
            <View style={{ flex: 1 }}>{detail}</View>
          ) : null}
        </View>
        {view === 'replies' ? (
          <RepliesView state={replyState} setState={setReplyState} onRefresh={refreshReplies} onAskAgent={askAgentForReply} />
        ) : null}
        <View style={[{ flex: 1 }, view !== 'insights' && styles.hidden]}>
          <InsightsView gateway={gateway} accountId={activeAccountId} active={view === 'insights'} />
        </View>
      </View>
    );
  }

  return (
    <Screen scroll={false} padded={false} edges={['bottom', 'left', 'right']} header={header}>
      {body}
      <ComposeSheet visible={composeOpen} onClose={() => setComposeOpen(false)} gateway={gateway} initial={composeInitial} />
      <AccountsSheet
        visible={accountsOpen}
        onClose={() => {
          setAccountsOpen(false);
          // Web closeAccountsManager → reload accounts (and the mail list).
          setAccountsLoaded(false);
          setMailReloadKey((k) => k + 1);
        }}
        gateway={gateway}
        onOpenWeb={() => {
          setAccountsOpen(false);
          navigation?.navigate?.('WebSurfaceModal', { path: '/inbox', title: 'Inbox' });
        }}
      />
      <ThreadAgentSheet visible={!!agentContext} onClose={() => setAgentContext(null)} gateway={gateway} context={agentContext} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  accountBar: { gap: SPACE.sm, paddingVertical: SPACE.xs },
  mailWrap: { flex: 1, flexDirection: 'row' },
  detailPane: { flex: 1.2, borderLeftWidth: 1 },
  hidden: { display: 'none' },
  empty: { marginTop: SPACE.xxl },
});

export default InboxScreen;
