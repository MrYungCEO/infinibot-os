import {
  ALL_COMMS_CHANNELS,
  channelBrand,
  channelLabel,
  deriveConnectionState,
  channelCardState,
  channelEnabled,
  orderChannels,
  channelStats,
  resolveChannelOrder,
  formatAgo,
  formatDuration,
  channelStatusRows,
  probeSummary,
  channelLastError,
  channelIdentity,
  defaultAccountId,
  channelConfigEnabled,
  accountRunningLabel,
  accountConnectedLabel,
  extractSetupPrefill,
  initialSetupFields,
  buildSetupPatch,
  buildConfigPatchParams,
  setupPatchParams,
  togglePatchParams,
  threadsListParams,
  threadTitle,
  fmtTime,
  normalizeThreads,
  threadFromMessages,
  messageFlags,
  buildSendParams,
  isCommsChannelConfigured,
  pendingDraftCount,
  isUnknownMethod,
  waLoginExpired,
  phoneLooksValid,
  normalizePhone,
  formatPairingCode,
  checkTelegramTokenFormat,
  cleanTelegramToken,
  tgWho,
  tgClock,
  tgErrorFromThrow,
  tgStepIndex,
  tgInitialStep,
  tgReportsTarget,
  initialViewFromParams,
} from '../screens/comms/comms-model';

// Shape probed from the live gateway (channels.status, 2026-10-14).
const SNAPSHOT = {
  channelOrder: ['telegram', 'whatsapp', 'discord', 'googlechat', 'slack', 'signal', 'imessage'],
  channelLabels: { telegram: 'Telegram', whatsapp: 'WhatsApp', custom: 'My Custom' },
  channelMeta: [
    { id: 'telegram', label: 'Telegram' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'discord', label: 'Discord' },
    { id: 'googlechat', label: 'Google Chat' },
    { id: 'slack', label: 'Slack' },
    { id: 'signal', label: 'Signal' },
    { id: 'imessage', label: 'iMessage' },
  ],
  channels: {
    telegram: { configured: true, running: true, mode: 'polling', lastStartAt: 1000, lastError: null, lastProbeAt: null },
    whatsapp: {
      configured: true, linked: true, authAgeMs: 7_200_000, self: { e164: '+66900000000' },
      running: false, connected: false, lastConnectedAt: null, lastError: 'status=401 Unauthorized',
    },
    discord: { configured: false },
    googlechat: { configured: false },
    slack: { configured: false, probe: { ok: false, status: 401, error: 'invalid_auth' } },
    signal: { configured: false },
    imessage: { configured: false },
  },
  channelAccounts: {
    telegram: [{ accountId: 'default', enabled: true, configured: true, running: true, probe: { bot: { username: 'KinglyBot' } } }],
    whatsapp: [{ accountId: 'default', enabled: true, configured: true, running: false }],
  },
};

describe('channel brands + labels', () => {
  it('knows the built-in brands and falls back for plugins', () => {
    expect(channelBrand('whatsapp').label).toBe('WhatsApp');
    expect(channelBrand('zzz').label).toBe('zzz');
    expect(channelBrand('zzz').tagline).toBe('Custom channel plugin');
    expect(channelLabel(SNAPSHOT, 'custom')).toBe('My Custom');
    expect(channelLabel(SNAPSHOT, 'telegram')).toBe('Telegram');
  });
});

describe('connection state', () => {
  it('derives the pill like channels.card.ts', () => {
    expect(deriveConnectionState({ hasError: true, connected: true })).toBe('error');
    expect(deriveConnectionState({ connected: true })).toBe('connected');
    expect(deriveConnectionState({ running: true, configured: true })).toBe('pending');
    expect(deriveConnectionState({ configured: true })).toBe('disconnected');
    expect(deriveConnectionState({})).toBe('unconfigured');
  });

  it('per-channel rules', () => {
    expect(channelCardState('telegram', SNAPSHOT)).toBe('connected');
    expect(channelCardState('whatsapp', SNAPSHOT)).toBe('error');
    expect(channelCardState('discord', SNAPSHOT)).toBe('unconfigured');
    // telegram: an unconfigured bot with a stale error is not an error
    const snap = { channels: { telegram: { configured: false, lastError: 'old' } } };
    expect(channelCardState('telegram', snap)).toBe('unconfigured');
    // whatsapp linked but not connected and no error → falls back to linked
    const wa = { channels: { whatsapp: { configured: true, linked: true } } };
    expect(channelCardState('whatsapp', wa)).toBe('connected');
    // generic
    expect(channelCardState('nostr', { channels: { nostr: { configured: true, running: true } } })).toBe('pending');
  });

  it('orders active channels first then by gateway order', () => {
    expect(resolveChannelOrder(null)[0]).toBe('whatsapp');
    const ids = orderChannels(SNAPSHOT).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual(['telegram', 'whatsapp']);
    expect(ids).toHaveLength(7);
    expect(channelStats(SNAPSHOT)).toEqual({ active: 2, available: 7 });
    expect(channelEnabled('slack', SNAPSHOT)).toBe(false);
    expect(channelEnabled('x', null)).toBe(false);
  });
});

describe('status rows + formatting', () => {
  const now = 10_000_000;
  it('formats ages and durations', () => {
    expect(formatAgo(null)).toBe('n/a');
    expect(formatAgo(now + 5, now)).toBe('just now');
    expect(formatAgo(now - 30_000, now)).toBe('30s ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAgo(now - 72 * 3_600_000, now)).toBe('3d ago');
    expect(formatDuration(7_200_000)).toBe('2h');
    expect(formatDuration(undefined)).toBe('n/a');
  });

  it('builds per-channel status grids', () => {
    const wa = channelStatusRows('whatsapp', SNAPSHOT, now);
    expect(wa.map((r) => r[0])).toEqual(['Configured', 'Linked', 'Running', 'Connected', 'Last connect', 'Last message', 'Auth age']);
    expect(wa[6][1]).toBe('2h');
    const tg = channelStatusRows('telegram', SNAPSHOT, now);
    expect(tg.find((r) => r[0] === 'Mode')[1]).toBe('polling');
    expect(channelStatusRows('signal', SNAPSHOT, now).some((r) => r[0] === 'Base URL')).toBe(true);
    expect(channelStatusRows('googlechat', { channels: {} }, now)[0][1]).toBe('n/a');
    expect(channelStatusRows('nostr', { channels: {} }, now).map((r) => r[1])).toEqual(['n/a', 'n/a', 'n/a']);
  });

  it('probe summary, last error, identity', () => {
    expect(probeSummary('slack', SNAPSHOT)).toEqual({ ok: false, text: 'Probe failed · 401 invalid_auth' });
    expect(probeSummary('telegram', SNAPSHOT)).toBeNull();
    expect(channelLastError('whatsapp', SNAPSHOT)).toMatch(/401/);
    expect(channelLastError('telegram', { channels: { telegram: { configured: false, lastError: 'x' } } })).toBeNull();
    expect(channelIdentity('whatsapp', SNAPSHOT)).toBe('+66900000000');
    expect(channelIdentity('telegram', SNAPSHOT)).toBe('@KinglyBot');
    expect(channelIdentity('discord', SNAPSHOT)).toBeNull();
  });

  it('account helpers', () => {
    expect(defaultAccountId('telegram', SNAPSHOT)).toBe('default');
    expect(defaultAccountId('slack', SNAPSHOT)).toBe('default');
    expect(channelConfigEnabled('telegram', SNAPSHOT)).toBe(true);
    expect(channelConfigEnabled('x', { channelAccounts: { x: [{ accountId: 'a', enabled: false }] } })).toBe(false);
    expect(accountRunningLabel({ running: true })).toBe('Yes');
    expect(accountRunningLabel({ lastInboundAt: now - 1000 }, now)).toBe('Active');
    expect(accountConnectedLabel({ connected: false })).toBe('No');
    expect(accountConnectedLabel({}, now)).toBe('n/a');
  });
});

describe('setup form + config.patch', () => {
  const snap = {
    hash: 'abc123',
    config: {
      channels: {
        telegram: { botToken: '__INFINIBOT_REDACTED__', defaultChatId: '6824', allowFrom: ['1', 2] },
        slack: { botToken: '' },
      },
    },
  };

  it('extracts prefills without mirroring secrets', () => {
    const p = extractSetupPrefill(snap);
    expect(p.baseHash).toBe('abc123');
    expect(p.current['telegram.defaultChatId']).toBe('6824');
    expect(p.current['telegram.allowFrom']).toBe('1, 2');
    expect(p.current['telegram.botToken']).toBeUndefined();
    expect(p.sensitiveSet['telegram.botToken']).toBe(true);
    expect(p.sensitiveSet['slack.botToken']).toBeUndefined();
    expect(extractSetupPrefill(null).baseHash).toBeNull();
  });

  it('opens a form with secrets blank', () => {
    const p = extractSetupPrefill(snap);
    expect(initialSetupFields('telegram', p.current)).toEqual({ botToken: '', defaultChatId: '6824', allowFrom: '1, 2' });
    expect(initialSetupFields('whatsapp', p.current)).toEqual({});
  });

  it('builds the merge patch like saveChannelSetup', () => {
    expect(buildSetupPatch('telegram', { botToken: '  ', defaultChatId: ' 42 ', allowFrom: '*, 7 ,' }))
      .toEqual({ enabled: true, defaultChatId: '42', allowFrom: ['*', '7'] });
    expect(buildSetupPatch('slack', { botToken: 'xoxb-1', appToken: 'xapp-2' }))
      .toEqual({ enabled: true, botToken: 'xoxb-1', appToken: 'xapp-2' });
    expect(buildSetupPatch('imessage', {})).toEqual({ enabled: true });
    expect(buildSetupPatch('unknown', { a: 'b' })).toEqual({ enabled: true });
  });

  it('config.patch params: raw JSON + baseHash + note', () => {
    const params = setupPatchParams('discord', { token: 't' }, 'h1');
    expect(params).toEqual({ raw: JSON.stringify({ channels: { discord: { enabled: true, token: 't' } } }), baseHash: 'h1', note: 'comms: configure discord' });
    expect(togglePatchParams('slack', false, 'h2')).toEqual({ raw: '{"channels":{"slack":{"enabled":false}}}', baseHash: 'h2', note: 'comms: disable slack' });
    // unknown hash → omitted (schema forbids null)
    expect('baseHash' in buildConfigPatchParams('x', { enabled: true }, null, 'n')).toBe(false);
  });
});

describe('inbox', () => {
  it('threads.list params from filters', () => {
    expect(threadsListParams()).toEqual({});
    expect(threadsListParams('whatsapp', 'all')).toEqual({ channel: 'whatsapp' });
    expect(threadsListParams('all', 'unassigned')).toEqual({ assignedAgentId: null });
    expect(threadsListParams('all', 'me')).toEqual({ assignedAgentId: 'me' });
  });

  it('normalizes threads + titles', () => {
    const { threads, pendingApprovals } = normalizeThreads({
      threads: [
        { threadKey: 'anon:+999:whatsapp', channel: 'whatsapp', peerHandle: '+999', lastMessageAt: 5, lastDirection: 'inbound', unreadCount: 2 },
        { nope: true },
      ],
      pendingApprovals: 3,
    });
    expect(threads).toHaveLength(1);
    expect(threads[0].unreadCount).toBe(2);
    expect(pendingApprovals).toBe(3);
    expect(threadTitle({ clientName: 'Acme', peerHandle: '+1' })).toBe('Acme');
    expect(threadTitle({ peerDisplayName: 'Bob', peerHandle: '+1' })).toBe('Bob');
    expect(threadTitle({ peerHandle: '+1' })).toBe('+1');
    expect(normalizeThreads(null)).toEqual({ threads: [], pendingApprovals: 0 });
  });

  it('fmtTime', () => {
    const now = new Date(2026, 9, 14, 12, 0).getTime();
    expect(fmtTime(0, now)).toBe('');
    expect(fmtTime(new Date(2026, 9, 14, 9, 5).getTime(), now)).toBe('09:05');
    expect(fmtTime(new Date(2026, 8, 3, 9, 5).getTime(), now)).toBe('Sep 3');
  });

  it('builds a thread from messages for deep links', () => {
    const t = threadFromMessages('k1', [
      { channel: 'telegram', peerHandle: '42', peerDisplayName: 'Ann', text: 'hi', createdAt: 9, direction: 'inbound' },
      { channel: 'telegram', peerHandle: '42', text: 'yo', createdAt: 10, direction: 'outbound', clientId: 'c1' },
    ]);
    expect(t).toMatchObject({ threadKey: 'k1', channel: 'telegram', peerHandle: '42', peerDisplayName: 'Ann', clientId: 'c1', lastDirection: 'outbound', messageCount: 2 });
  });

  it('message flags, send params, configured lookup', () => {
    expect(messageFlags({ direction: 'outbound', status: 'pending_approval' })).toEqual({ outbound: true, pending: true, failed: false, sent: false });
    const thread = { clientId: null, peerHandle: '+1' };
    expect(buildSendParams(thread, 'whatsapp', '  hello ')).toEqual({ channel: 'whatsapp', clientId: null, peerHandle: '+1', text: 'hello' });
    expect(buildSendParams(thread, 'whatsapp', '   ')).toBeNull();
    expect(buildSendParams(null, 'whatsapp', 'x')).toBeNull();
    expect(isCommsChannelConfigured([{ channel: 'telegram', configured: true }], 'telegram')).toBe(true);
    expect(isCommsChannelConfigured([], 'email')).toBe(false);
    expect(pendingDraftCount([{ status: 'pending_approval' }, { status: 'sent' }])).toBe(1);
    expect(ALL_COMMS_CHANNELS).toEqual(['telegram', 'email', 'whatsapp', 'discord', 'instagram']);
  });

  it('detects missing RPCs', () => {
    expect(isUnknownMethod(new Error('unknown method: comms.threads.list'))).toBe(true);
    expect(isUnknownMethod(new Error('timeout'))).toBe(false);
  });
});

describe('whatsapp link helpers', () => {
  it('expiry, phone, pairing code', () => {
    expect(waLoginExpired('Login expired')).toBe(true);
    expect(waLoginExpired('No active login')).toBe(true);
    expect(waLoginExpired('waiting')).toBe(false);
    expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
    expect(phoneLooksValid('+1 555 123 4567')).toBe(true);
    expect(phoneLooksValid('12')).toBe(false);
    expect(formatPairingCode('ABCD1234')).toBe('ABCD-1234');
    expect(formatPairingCode('XY')).toBe('XY');
  });
});

describe('telegram setup helpers', () => {
  it('token format', () => {
    const good = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1';
    expect(checkTelegramTokenFormat(good)).toMatchObject({ ok: true, botId: '123456789' });
    expect(cleanTelegramToken(`Use this token: ${good} to access`)).toBe(good);
    expect(checkTelegramTokenFormat('').problem).toBe('empty');
    expect(checkTelegramTokenFormat('abc').problem).toBe('no-colon');
    expect(checkTelegramTokenFormat('12ab:xyz').problem).toBe('bad-id');
    expect(checkTelegramTokenFormat('123456:a$b').problem).toBe('bad-chars');
    expect(checkTelegramTokenFormat('123456:abc').problem).toBe('too-short');
  });

  it('who / clock / errors / steps', () => {
    expect(tgWho({ chatType: 'private', username: 'ann' })).toBe('@ann');
    expect(tgWho({ chatType: 'private', firstName: 'Ann' })).toBe('Ann');
    expect(tgWho({ chatType: 'group', chatTitle: 'Team' })).toBe('Team');
    expect(tgWho(null)).toBe('');
    expect(tgClock(125_000)).toBe('2:05');
    expect(tgClock(-5)).toBe('0:00');
    expect(tgErrorFromThrow(new Error('unknown method: telegram.setup.summary')).code).toBe('unknown');
    expect(tgErrorFromThrow(new Error('boom')).code).toBe('network');
    expect(tgStepIndex('find')).toBe(2);
    expect(tgInitialStep({ ok: true, connected: true })).toBe('summary');
    expect(tgInitialStep({ ok: false })).toBe('create');
    expect(tgReportsTarget('-100')).toBe('-100 (group)');
    expect(tgReportsTarget('42')).toBe('42 (your private chat)');
    expect(tgReportsTarget(null)).toBeNull();
  });
});

describe('route params', () => {
  it('maps deep links to the initial view', () => {
    expect(initialViewFromParams({})).toEqual({ tab: 'channels', threadId: null, channelFilter: 'all', openChannel: null });
    expect(initialViewFromParams({ channel: 'WhatsApp' })).toMatchObject({ tab: 'channels', openChannel: 'whatsapp' });
    expect(initialViewFromParams({ threadId: 'k1', channel: 'telegram' })).toEqual({ tab: 'inbox', threadId: 'k1', channelFilter: 'telegram', openChannel: null });
    expect(initialViewFromParams({ view: 'inbox', channel: 'slack' })).toMatchObject({ tab: 'inbox', channelFilter: 'all' });
    expect(initialViewFromParams(undefined).tab).toBe('channels');
  });
});
