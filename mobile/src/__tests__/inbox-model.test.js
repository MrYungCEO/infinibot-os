import {
  normalizeView,
  parseRouteParams,
  errMessage,
  isUnknownMethod,
  isTimeout,
  decodeEntities,
  cleanFrom,
  emailAddress,
  fmtListDate,
  timeAgo,
  normalizeStatus,
  providerTag,
  totalUnread,
  activeUnread,
  normalizeEmailAccount,
  summarizeTestResult,
  emptyImapForm,
  applyDiscovery,
  validateImapForm,
  buildImapAccountPayload,
  normalizeMessage,
  messageBodyText,
  htmlToText,
  normalizeLabels,
  buildListParams,
  mergeMessages,
  patchMessage,
  normalizeSummary,
  normalizeProviderInfo,
  pickDefaultFrom,
  validateCompose,
  buildSendParams,
  replySubject,
  normalizeReply,
  filterReplies,
  replyCounts,
  confidenceLabel,
  normalizeInsights,
  normalizeRule,
  clampPoll,
  addTag,
  removeTag,
  buildAlertParams,
  threadAgentContext,
  extractChatText,
  normalizeHistory,
  stripInstructions,
  composeAgentMessage,
} from '../screens/inbox/inbox-model';

describe('inbox-model: views + route params', () => {
  test('normalizeView maps aliases and defaults to mail', () => {
    expect(normalizeView('replies')).toBe('replies');
    expect(normalizeView('reply-inbox')).toBe('replies');
    expect(normalizeView('Insights')).toBe('insights');
    expect(normalizeView('emails')).toBe('mail');
    expect(normalizeView('bogus')).toBe('mail');
    expect(normalizeView(undefined)).toBe('mail');
  });
  test('parseRouteParams accepts view + messageId/threadId', () => {
    expect(parseRouteParams({ view: 'insights' })).toEqual({ view: 'insights', messageId: null });
    expect(parseRouteParams({ threadId: 't1' })).toEqual({ view: 'mail', messageId: 't1' });
    expect(parseRouteParams({ messageId: 'm1', threadId: 't1' }).messageId).toBe('m1');
    expect(parseRouteParams(undefined)).toEqual({ view: 'mail', messageId: null });
  });
});

describe('inbox-model: errors', () => {
  test('errMessage strips Error: prefix', () => {
    expect(errMessage(new Error('Error: fetch failed'))).toBe('fetch failed');
    expect(errMessage('boom')).toBe('boom');
    expect(errMessage(null)).toBe('Unknown error');
  });
  test('isUnknownMethod / isTimeout', () => {
    expect(isUnknownMethod(new Error('unknown method: gmail.status'))).toBe(true);
    expect(isUnknownMethod({ code: 'METHOD_NOT_FOUND', message: 'x' })).toBe(true);
    expect(isUnknownMethod(new Error('nope'))).toBe(false);
    expect(isTimeout(new Error('Request timeout'))).toBe(true);
    expect(isTimeout(new Error('nope'))).toBe(false);
  });
});

describe('inbox-model: strings + dates', () => {
  test('decodeEntities handles named + numeric', () => {
    expect(decodeEntities('Mischief &amp; Magic We&#39;re &quot;x&quot; &#x41;')).toBe('Mischief & Magic We\'re "x" A');
    expect(decodeEntities('plain')).toBe('plain');
    expect(decodeEntities(null)).toBe('');
  });
  test('cleanFrom / emailAddress', () => {
    expect(cleanFrom('Michaels <m@x.com>')).toBe('Michaels');
    expect(cleanFrom('"Yung Ceo" <y@g.com>')).toBe('Yung Ceo');
    expect(cleanFrom('bare@x.com')).toBe('bare@x.com');
    expect(emailAddress('Michaels <m@x.com>')).toBe('m@x.com');
    expect(emailAddress('bare@x.com')).toBe('bare@x.com');
  });
  test('fmtListDate: time today, weekday this week, month day older', () => {
    const now = new Date(2026, 9, 14, 12, 0);
    expect(fmtListDate(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toBe('09:05');
    expect(fmtListDate(new Date(2026, 9, 12, 9, 5).toISOString(), now)).toBe('Mon');
    expect(fmtListDate(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toBe('Sep 1');
    expect(fmtListDate('not a date', now)).toBe('not a date');
  });
  test('fmtListDate tolerates Gmail "(UTC)" suffix', () => {
    expect(fmtListDate('Wed, 14 Oct 2026 07:11:35 +0000 (UTC)', new Date('2026-12-30T00:00:00Z'))).toBe('Oct 14');
  });
  test('timeAgo buckets', () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    expect(timeAgo('2026-10-14T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-10-14T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-10-14T07:00:00Z', now)).toBe('5h ago');
    expect(timeAgo('2026-10-11T12:00:00Z', now)).toBe('3d ago');
  });
});

describe('inbox-model: accounts', () => {
  test('normalizeStatus (live gmail.status shape)', () => {
    const s = normalizeStatus({ configured: true, accounts: [{ id: 'owner', email: 'y@gmail.com', isDefault: true }, null] });
    expect(s.configured).toBe(true);
    expect(s.accounts).toEqual([{ id: 'owner', email: 'y@gmail.com', isDefault: true, provider: null }]);
    expect(normalizeStatus(null)).toEqual({ configured: false, accounts: [] });
  });
  test('providerTag', () => {
    expect(providerTag({ email: 'a@gmail.com' })).toBe('G');
    expect(providerTag({ provider: 'imap', email: 'a@gmail.com' })).toBe('IMAP');
    expect(providerTag({ email: 'a@fastmail.com' })).toBe('@');
  });
  test('unread totals', () => {
    expect(totalUnread({ a: 3, b: 2 })).toBe(5);
    expect(activeUnread({ a: 3, b: 2 }, null)).toBe(5);
    expect(activeUnread({ a: 3, b: 2 }, 'b')).toBe(2);
    expect(activeUnread({}, 'z')).toBe(0);
  });
  test('normalizeEmailAccount health tones', () => {
    const a = normalizeEmailAccount({
      id: 'x', kind: 'gmail', address: 'y@g.com', isPrimary: true,
      outbound: { enabled: true }, inbound: { enabled: false },
      health: { outbound: { ok: false, lastError: 'nope', lastCheckedAt: 1 } },
    });
    expect(a.outboundHealth).toBe('error');
    expect(a.outboundError).toBe('nope');
    expect(a.inboundHealth).toBe('off');
    expect(a.displayName).toBe('y@g.com');
  });
  test('summarizeTestResult', () => {
    const acc = { outboundEnabled: true, inboundEnabled: true };
    expect(summarizeTestResult(acc, { outbound: { ok: true }, inbound: { ok: true } })).toBeNull();
    expect(summarizeTestResult(acc, { outbound: { ok: false, error: 'auth' }, inbound: { ok: true } })).toBe('outbound: auth');
    expect(summarizeTestResult({ outboundEnabled: false, inboundEnabled: true }, { outbound: { ok: false } })).toBeNull();
  });
  test('discovery + validation + payload for SMTP/IMAP', () => {
    let f = { ...emptyImapForm(), address: 'me@fast.com', smtpPassword: 'pw' };
    f = applyDiscovery(f, { ok: true, suggestion: { outbound: { smtpHost: 'smtp.fast.com', smtpPort: 465, smtpSecure: true }, inbound: { imapHost: 'imap.fast.com', imapPort: 993, imapSecure: true } } });
    expect(f.smtpHost).toBe('smtp.fast.com');
    expect(f.smtpPort).toBe('465');
    expect(applyDiscovery(f, { ok: false })).toEqual(f);
    expect(validateImapForm(f)).toBeNull();
    expect(validateImapForm({ ...f, address: 'x' })).toMatch(/address/);
    expect(validateImapForm({ ...f, imapHost: '' })).toMatch(/IMAP/);
    expect(validateImapForm({ ...f, imapHost: '', inboundEnabled: false })).toBeNull();
    const p = buildImapAccountPayload(f);
    expect(p.kind).toBe('smtp-imap');
    expect(p.displayName).toBe('me@fast.com');
    expect(p.outbound).toEqual({ enabled: true, config: { smtpHost: 'smtp.fast.com', smtpPort: 465, smtpSecure: true, smtpUser: 'me@fast.com', smtpPassword: 'pw' } });
    expect(p.inbound.config.imapUser).toBe('me@fast.com');
    expect(p.inbound.config.imapPassword).toBe('pw');
    const p2 = buildImapAccountPayload({ ...f, sameInboundCreds: false, imapUser: 'other', imapPassword: '' });
    expect(p2.inbound.config.imapUser).toBe('other');
    expect(p2.inbound.config.imapPassword).toBeUndefined();
  });
});

describe('inbox-model: mail', () => {
  test('normalizeMessage decodes + derives flags', () => {
    const m = normalizeMessage({ id: '1', subject: 'A &amp; B', snippet: 'We&#39;re', labels: ['UNREAD', 'INBOX'] });
    expect(m.subject).toBe('A & B');
    expect(m.snippet).toBe("We're");
    expect(m.isUnread).toBe(true);
    expect(m.isStarred).toBe(false);
    expect(m.threadId).toBe('1');
  });
  test('messageBodyText prefers plain body, falls back to html', () => {
    expect(messageBodyText({ body: '\r\nHi\r\n\r\n\r\n\r\nthere ' })).toBe('Hi\n\nthere');
    expect(messageBodyText({ body: '', bodyHtml: '<style>x</style><p>Hi &amp; bye</p><br>ok' })).toBe('Hi & bye\n\nok');
    expect(htmlToText('')).toBe('');
  });
  test('normalizeLabels orders system first, prettifies names', () => {
    const l = normalizeLabels([
      { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
      { id: 'Label_2', name: 'Zeta', type: 'user' },
      { id: 'SENT', name: 'SENT', type: 'system' },
      { id: 'INBOX', name: 'INBOX', type: 'system', messagesUnread: 4 },
      { id: 'Label_1', name: 'Alpha', type: 'user' },
    ]);
    expect(l.map((x) => x.name)).toEqual(['Inbox', 'Sent', 'Social', 'Alpha', 'Zeta']);
    expect(l[0].unread).toBe(4);
    expect(l[3].type).toBe('user');
  });
  test('buildListParams: search wins over label; pageToken passes through', () => {
    expect(buildListParams({ accountId: null, selectedLabel: 'INBOX' })).toEqual({ maxResults: 30, accountId: null, labelIds: ['INBOX'] });
    expect(buildListParams({ accountId: 'a', searchQuery: ' invoice ', selectedLabel: 'INBOX', pageToken: 'p2' }))
      .toEqual({ maxResults: 30, accountId: 'a', query: 'invoice', pageToken: 'p2' });
  });
  test('mergeMessages de-dupes', () => {
    expect(mergeMessages([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]).map((m) => m.id)).toEqual(['a', 'b']);
  });
  test('patchMessage applies optimistic actions', () => {
    const list = [{ id: 'a', isUnread: true, isStarred: false }, { id: 'b' }];
    expect(patchMessage(list, 'a', 'read')[0].isUnread).toBe(false);
    expect(patchMessage(list, 'a', 'star')[0].isStarred).toBe(true);
    expect(patchMessage(list, 'a', 'archive').map((m) => m.id)).toEqual(['b']);
    expect(patchMessage(list, 'a', 'trash').length).toBe(1);
  });
  test('normalizeSummary', () => {
    expect(normalizeSummary({ summary: 's', actions: ['a', '', 3], provider: 'p', model: 'm' })).toEqual({ summary: 's', actions: ['a'], provider: 'p', model: 'm' });
    expect(normalizeSummary(null)).toBeNull();
  });
});

describe('inbox-model: compose', () => {
  const info = {
    resend: false, loops: true, smtp: false, defaultFrom: null,
    accounts: [
      { id: 'x', businessId: null, isPrimary: false, outboundEnabled: true },
      { id: 'y', businessId: null, isPrimary: true, outboundEnabled: true },
      { id: 'z', businessId: null, isPrimary: true, outboundEnabled: false },
    ],
  };
  test('normalizeProviderInfo filters outbound + flags no provider', () => {
    expect(normalizeProviderInfo(info).accounts.map((a) => a.id)).toEqual(['x', 'y']);
    expect(normalizeProviderInfo(info).noProvider).toBe(false);
    expect(normalizeProviderInfo({ resend: false, loops: false, accounts: [] }).noProvider).toBe(true);
    expect(normalizeProviderInfo(null).noProvider).toBe(false);
  });
  test('pickDefaultFrom prefers primary', () => {
    expect(pickDefaultFrom(normalizeProviderInfo(info).accounts)).toBe('y');
    expect(pickDefaultFrom([])).toBe('');
  });
  test('validateCompose + buildSendParams', () => {
    expect(validateCompose({ to: '', subject: 'x' })).toBe('Recipient required');
    expect(validateCompose({ to: 'a@b', subject: ' ' })).toBe('Subject required');
    expect(validateCompose({ to: 'a@b', subject: 'Hi' })).toBeNull();
    expect(buildSendParams({ to: ' a@b ', subject: 'Hi', body: 'B', accountId: '' }))
      .toEqual({ to: 'a@b', subject: 'Hi', body: 'B', businessId: undefined, accountId: undefined });
  });
  test('replySubject', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
  });
});

describe('inbox-model: replies', () => {
  const now = '2026-10-14T12:00:00Z';
  const raw = [
    { id: '1', class: 'interested', urgency: 'low', receivedAt: '2026-10-14T10:00:00Z' },
    { id: '2', class: 'question', urgency: 'high', receivedAt: '2026-10-14T09:00:00Z' },
    { id: '3', class: 'oof', urgency: 'high', receivedAt: '2026-10-14T11:00:00Z', handled: true },
    { id: '4', class: 'weird', urgency: 'medium', receivedAt: now, confidence: 1.4 },
  ];
  const replies = raw.map(normalizeReply);
  test('normalizeReply clamps unknowns', () => {
    expect(replies[3].class).toBe('unknown');
    expect(replies[3].confidence).toBe(1);
    expect(replies[0].leadName).toBe('Unknown lead');
  });
  test('filterReplies hides handled and sorts urgency then newest', () => {
    expect(filterReplies(replies).map((r) => r.id)).toEqual(['2', '4', '1']);
    expect(filterReplies(replies, { showHandled: true }).map((r) => r.id)).toEqual(['3', '2', '4', '1']);
    expect(filterReplies(replies, { filterClass: 'interested' }).map((r) => r.id)).toEqual(['1']);
    expect(filterReplies(replies, { filterUrgency: 'high', showHandled: true }).map((r) => r.id)).toEqual(['3', '2']);
  });
  test('replyCounts + confidenceLabel', () => {
    expect(replyCounts(replies)).toEqual({ unhandled: 3, urgent: 1 });
    expect(confidenceLabel(0.65)).toEqual({ pct: 65, low: true });
    expect(confidenceLabel(0.9)).toEqual({ pct: 90, low: false });
  });
});

describe('inbox-model: insights + alert rule', () => {
  test('normalizeInsights (live shape)', () => {
    const i = normalizeInsights({ unread: 18, today: 11, last24h: 18, totalScanned: 18, topSenders: [{ sender: 'a@x', count: 5 }, { count: 1 }] });
    expect(i.unread).toBe(18);
    expect(i.topSenders).toEqual([{ sender: 'a@x', count: 5 }]);
    expect(normalizeInsights(null)).toBeNull();
  });
  test('normalizeRule: null → default rule; clamps poll', () => {
    expect(normalizeRule(null)).toEqual({ enabled: true, senders: [], keywords: [], pollIntervalMinutes: 5, doTelegramAlert: true });
    expect(normalizeRule({ enabled: false, pollIntervalMinutes: 500, senders: ['a', ''] })).toMatchObject({ enabled: false, pollIntervalMinutes: 60, senders: ['a'], keywords: [] });
    expect(clampPoll('0')).toBe(5);
    expect(clampPoll('7')).toBe(7);
  });
  test('addTag / removeTag', () => {
    expect(addTag(['a'], ' b ')).toEqual(['a', 'b']);
    expect(addTag(['a'], 'a')).toEqual(['a']);
    expect(addTag(['a'], '  ')).toEqual(['a']);
    expect(removeTag(['a', 'b'], 'a')).toEqual(['b']);
  });
  test('buildAlertParams', () => {
    const p = buildAlertParams(null, { enabled: true, senders: ['x'], keywords: [], pollIntervalMinutes: 10, telegramChatId: '' });
    expect(p.accountId).toBeNull();
    expect(p.rule.telegramChatId).toBeUndefined();
    expect(p.rule.pollIntervalMinutes).toBe(10);
    expect(buildAlertParams('acc', { telegramChatId: '-100' }).rule.telegramChatId).toBe('-100');
  });
});

describe('inbox-model: thread agent', () => {
  test('threadAgentContext for mail + replies', () => {
    expect(threadAgentContext('mail', { id: 'm', threadId: 't', subject: '', from: 'F' }, null, null))
      .toEqual({ docType: 'inbox_thread', documentId: 't', title: '(No subject)', extra: 'from=F account=(all)' });
    expect(threadAgentContext('replies', null, { id: 'r', messageId: 'mm', class: 'oof', urgency: 'low', leadName: 'L' }, 'a').documentId).toBe('mm');
    expect(threadAgentContext('insights', null, null, null)).toBeNull();
  });
  test('history extraction + instruction stripping', () => {
    expect(extractChatText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    const first = composeAgentMessage('hello', 'SYS', true);
    expect(first.startsWith('[INSTRUCTIONS')).toBe(true);
    expect(stripInstructions(first)).toBe('hello');
    expect(composeAgentMessage(' hi ', 'SYS', false)).toBe('hi');
    const h = normalizeHistory({ messages: [{ role: 'user', content: first, timestamp: 1 }, { role: 'toolResult', content: 'x' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    expect(h.map((m) => [m.role, m.text])).toEqual([['user', 'hello'], ['assistant', 'ok']]);
  });
});
