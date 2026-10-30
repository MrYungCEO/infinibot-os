/**
 * comms-model — pure data logic for the native Channels page (web /channels +
 * its "Inbox" sub-tab /comms). No react-native imports: everything here is
 * covered by src/__tests__/comms-model.test.js.
 *
 * Web sources mirrored 1:1:
 *   ui/src/ui/views/channels*.ts            channel cards, status rows, ordering
 *   ui/src/ui/controllers/channels.ts       channels.status / web.login.* / logout
 *   ui/src/ui/controllers/comms-hub.ts      comms.* inbox + CHANNEL_SETUP_SPECS +
 *                                           config.patch setup / enable toggle
 *   ui/src/ui/components/telegram-setup.ts  guided Telegram setup (telegram.setup.*)
 */

// ── Inbox channels (comms.* — a fixed set on the gateway) ────────────────────

export const COMMS_CHANNEL_META = {
  telegram: { label: 'Telegram', icon: 'paper-plane-outline', color: '#2aabee' },
  email: { label: 'Email', icon: 'mail-outline', color: '#d4af37' },
  whatsapp: { label: 'WhatsApp', icon: 'logo-whatsapp', color: '#25d366' },
  discord: { label: 'Discord', icon: 'logo-discord', color: '#5865f2' },
  instagram: { label: 'Instagram', icon: 'logo-instagram', color: '#e1306c' },
};

export const ALL_COMMS_CHANNELS = Object.keys(COMMS_CHANNEL_META);

export function commsChannelMeta(channel) {
  return COMMS_CHANNEL_META[channel] || { label: String(channel || 'Channel'), icon: 'chatbubble-outline', color: '#d4af37' };
}

// ── Channel brands (channels.logos.ts) ───────────────────────────────────────

export const CHANNEL_BRANDS = {
  whatsapp: { label: 'WhatsApp', tagline: 'Personal & business messaging via WhatsApp Web', color: '#25D366', icon: 'logo-whatsapp' },
  telegram: { label: 'Telegram', tagline: 'Bot API messaging with channels, groups & DMs', color: '#229ED9', icon: 'paper-plane' },
  discord: { label: 'Discord', tagline: 'Bot status, guilds & channel configuration', color: '#5865F2', icon: 'logo-discord' },
  slack: { label: 'Slack', tagline: 'Socket-mode bot, workspaces & channel hooks', color: '#E01E5A', icon: 'logo-slack' },
  signal: { label: 'Signal', tagline: 'End-to-end encrypted messaging via signal-cli', color: '#3A76F0', icon: 'shield-checkmark-outline' },
  imessage: { label: 'iMessage', tagline: "macOS bridge for Apple's native messaging", color: '#00C853', icon: 'logo-apple' },
  googlechat: { label: 'Google Chat', tagline: 'Chat API webhooks, spaces & service accounts', color: '#00897B', icon: 'logo-google' },
  nostr: { label: 'Nostr', tagline: 'Decentralized DMs over Nostr relays (NIP-04)', color: '#8E44EC', icon: 'radio-outline' },
  bluebubbles: { label: 'BlueBubbles', tagline: 'BlueBubbles iMessage relay server', color: '#3E8AFA', icon: 'chatbubbles-outline' },
  mattermost: { label: 'Mattermost', tagline: 'Open-source team messaging', color: '#0072C6', icon: 'people-outline' },
  msteams: { label: 'Microsoft Teams', tagline: 'Microsoft Teams bot via Bot Framework', color: '#6264A7', icon: 'logo-microsoft' },
};

const FALLBACK_BRAND = { label: 'Channel', tagline: 'Custom channel plugin', color: '#6366f1', icon: 'extension-puzzle-outline' };

export function channelBrand(id) {
  return CHANNEL_BRANDS[id] || { ...FALLBACK_BRAND, label: String(id || 'Channel') };
}

/** Card title: snapshot label override when it differs from the id (web resolveChannelLabel). */
export function channelLabel(snapshot, id) {
  if (CHANNEL_BRANDS[id]) return CHANNEL_BRANDS[id].label;
  const meta = (snapshot?.channelMeta || []).find((m) => m.id === id);
  return meta?.label || snapshot?.channelLabels?.[id] || id;
}

// ── Connection state (channels.card.ts) ──────────────────────────────────────

export const STATE_LABEL = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
  pending: 'Connecting',
  unconfigured: 'Not Configured',
};

export const STATE_TONE = {
  connected: 'success',
  disconnected: 'neutral',
  error: 'danger',
  pending: 'warning',
  unconfigured: 'neutral',
};

export function deriveConnectionState({ configured, running, connected, hasError } = {}) {
  if (hasError) return 'error';
  if (connected) return 'connected';
  if (running && configured) return 'pending';
  if (configured) return 'disconnected';
  return 'unconfigured';
}

/** Per-channel pill state, exactly as each web card derives it. */
export function channelCardState(id, snapshot) {
  const st = snapshot?.channels?.[id] || null;
  const accounts = snapshot?.channelAccounts?.[id] || [];
  switch (id) {
    case 'whatsapp':
      return deriveConnectionState({
        configured: st?.configured ?? null,
        running: st?.running ?? null,
        connected: st?.connected ?? st?.linked ?? null,
        hasError: Boolean(st?.lastError),
      });
    case 'telegram': {
      const multi = accounts.length > 1;
      const running = multi ? accounts.some((a) => a.running) : Boolean(st?.running);
      const configured = multi ? accounts.some((a) => a.configured) : Boolean(st?.configured);
      // A bot that was disconnected on purpose is "not configured", not an error.
      const err = multi ? accounts.some((a) => a.configured && Boolean(a.lastError)) : Boolean(st?.configured && st?.lastError);
      return deriveConnectionState({ configured, running, connected: running, hasError: err });
    }
    case 'discord':
    case 'slack':
    case 'signal':
    case 'googlechat':
    case 'imessage':
      return deriveConnectionState({
        configured: st?.configured ?? null,
        running: st?.running ?? null,
        connected: st?.running ?? null,
        hasError: Boolean(st?.lastError),
      });
    default:
      return deriveConnectionState({
        configured: typeof st?.configured === 'boolean' ? st.configured : null,
        running: typeof st?.running === 'boolean' ? st.running : null,
        connected: typeof st?.connected === 'boolean' ? st.connected : null,
        hasError: typeof st?.lastError === 'string' && Boolean(st.lastError),
      });
  }
}

/** channels.shared.ts channelEnabled — "active" for ordering + the hero stat. */
export function channelEnabled(id, snapshot) {
  const channels = snapshot?.channels;
  if (!snapshot || !channels) return false;
  const st = channels[id] || {};
  const flag = (k) => typeof st[k] === 'boolean' && st[k];
  const accounts = snapshot.channelAccounts?.[id] || [];
  const accountActive = accounts.some((a) => a.configured || a.running || a.connected);
  return flag('configured') || flag('running') || flag('connected') || accountActive;
}

export const DEFAULT_CHANNEL_ORDER = ['whatsapp', 'telegram', 'discord', 'googlechat', 'slack', 'signal', 'imessage', 'nostr'];

export function resolveChannelOrder(snapshot) {
  if (snapshot?.channelMeta?.length) return snapshot.channelMeta.map((m) => m.id);
  if (snapshot?.channelOrder?.length) return snapshot.channelOrder;
  return DEFAULT_CHANNEL_ORDER.slice();
}

/** Ordered card list: active channels first, then gateway order. */
export function orderChannels(snapshot) {
  return resolveChannelOrder(snapshot)
    .map((id, order) => ({ id, enabled: channelEnabled(id, snapshot), order }))
    .sort((a, b) => (a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.order - b.order));
}

export function channelStats(snapshot) {
  const list = orderChannels(snapshot);
  return { active: list.filter((c) => c.enabled).length, available: list.length };
}

// ── Formatting (ui/src/ui/format.ts + channels.shared.ts) ────────────────────

export function formatAgo(ms, now = Date.now()) {
  if (!ms && ms !== 0) return 'n/a';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return 'n/a';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

const yn = (v) => (v ? 'Yes' : 'No');
const ago = (v, now) => (v ? formatAgo(v, now) : 'n/a');

const RECENT_ACTIVITY_MS = 10 * 60 * 1000;

function recentActivity(account, now) {
  return Boolean(account?.lastInboundAt) && now - account.lastInboundAt < RECENT_ACTIVITY_MS;
}

export function accountRunningLabel(account, now = Date.now()) {
  if (account?.running) return 'Yes';
  if (recentActivity(account, now)) return 'Active';
  return 'No';
}

export function accountConnectedLabel(account, now = Date.now()) {
  if (account?.connected === true) return 'Yes';
  if (account?.connected === false) return 'No';
  if (recentActivity(account, now)) return 'Active';
  return 'n/a';
}

/** The status grid each web card shows, as [label, value] rows. */
export function channelStatusRows(id, snapshot, now = Date.now()) {
  const st = snapshot?.channels?.[id] || null;
  switch (id) {
    case 'whatsapp':
      return [
        ['Configured', yn(st?.configured)],
        ['Linked', yn(st?.linked)],
        ['Running', yn(st?.running)],
        ['Connected', yn(st?.connected)],
        ['Last connect', ago(st?.lastConnectedAt, now)],
        ['Last message', ago(st?.lastMessageAt, now)],
        ['Auth age', st?.authAgeMs != null ? formatDuration(st.authAgeMs) : 'n/a'],
      ];
    case 'telegram':
      return [
        ['Configured', yn(st?.configured)],
        ['Running', yn(st?.running)],
        ['Mode', st?.mode ?? 'n/a'],
        ['Last start', ago(st?.lastStartAt, now)],
        ['Last probe', ago(st?.lastProbeAt, now)],
      ];
    case 'googlechat':
      return [
        ['Configured', st ? yn(st.configured) : 'n/a'],
        ['Running', st ? yn(st.running) : 'n/a'],
        ['Credential', st?.credentialSource ?? 'n/a'],
        ['Audience', st?.audienceType ? `${st.audienceType}${st.audience ? ` · ${st.audience}` : ''}` : 'n/a'],
        ['Last start', ago(st?.lastStartAt, now)],
        ['Last probe', ago(st?.lastProbeAt, now)],
      ];
    case 'signal':
      return [
        ['Configured', yn(st?.configured)],
        ['Running', yn(st?.running)],
        ['Base URL', st?.baseUrl ?? 'n/a'],
        ['Last start', ago(st?.lastStartAt, now)],
        ['Last probe', ago(st?.lastProbeAt, now)],
      ];
    case 'discord':
    case 'slack':
    case 'imessage':
      return [
        ['Configured', yn(st?.configured)],
        ['Running', yn(st?.running)],
        ['Last start', ago(st?.lastStartAt, now)],
        ['Last probe', ago(st?.lastProbeAt, now)],
      ];
    default: {
      const b = (k) => (typeof st?.[k] === 'boolean' ? yn(st[k]) : 'n/a');
      return [
        ['Configured', b('configured')],
        ['Running', b('running')],
        ['Connected', b('connected')],
      ];
    }
  }
}

/** "Probe ok · 200" callout text, or null. */
export function probeSummary(id, snapshot) {
  const p = snapshot?.channels?.[id]?.probe;
  if (!p || typeof p !== 'object') return null;
  const parts = [`Probe ${p.ok ? 'ok' : 'failed'}`];
  const tail = [id === 'imessage' ? null : p.status, p.error].filter((x) => x != null && x !== '').join(' ');
  if (tail) parts.push(tail);
  return { ok: Boolean(p.ok), text: parts.join(' · ') };
}

export function channelLastError(id, snapshot) {
  const st = snapshot?.channels?.[id];
  if (!st || typeof st.lastError !== 'string' || !st.lastError) return null;
  // Telegram: an intentionally-disconnected bot is not an error.
  if (id === 'telegram' && !st.configured) return null;
  return st.lastError;
}

/** One-line identity for the card (bot username, linked number, account name). */
export function channelIdentity(id, snapshot) {
  const st = snapshot?.channels?.[id] || {};
  const accounts = snapshot?.channelAccounts?.[id] || [];
  if (id === 'whatsapp' && st.self?.e164) return st.self.e164;
  if (id === 'telegram') {
    const u = accounts.find((a) => a?.probe?.bot?.username)?.probe?.bot?.username || st?.probe?.bot?.username;
    if (u) return `@${u}`;
  }
  const named = accounts.find((a) => a?.name);
  if (named) return named.name;
  const nonDefault = accounts.find((a) => a?.accountId && a.accountId !== 'default');
  return nonDefault ? nonDefault.accountId : null;
}

export function defaultAccountId(id, snapshot) {
  const accounts = snapshot?.channelAccounts?.[id] || [];
  return snapshot?.channelDefaultAccountId?.[id] || accounts[0]?.accountId || 'default';
}

/** Enabled flag of the default account (comms-hub buildSetupChannels). */
export function channelConfigEnabled(id, snapshot) {
  const accounts = snapshot?.channelAccounts?.[id] || [];
  const defId = defaultAccountId(id, snapshot);
  const def = accounts.find((a) => a.accountId === defId) || accounts[0] || null;
  return def ? def.enabled !== false : true;
}

// ── Channel setup form (comms-hub CHANNEL_SETUP_SPECS) ───────────────────────

export const CHANNEL_SETUP_SPECS = {
  telegram: {
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'password', sensitive: true, placeholder: '123456:ABC-DEF…', help: 'Create a bot with @BotFather and paste its token.' },
      { key: 'defaultChatId', label: 'Default chat ID', type: 'text', placeholder: 'e.g. 123456789', help: 'Optional — chat used for proactive sends.' },
      { key: 'allowFrom', label: 'Allow from', type: 'csv', placeholder: '* or comma-separated user IDs', help: 'Who may DM the bot. Use * for open (public) access.' },
    ],
  },
  discord: {
    fields: [
      { key: 'token', label: 'Bot token', type: 'password', sensitive: true, placeholder: 'Bot token from the Developer Portal', help: 'Discord Developer Portal → your app → Bot → Reset/Copy Token.' },
    ],
  },
  slack: {
    fields: [
      { key: 'botToken', label: 'Bot token', type: 'password', sensitive: true, placeholder: 'xoxb-…', help: 'Slack app → OAuth & Permissions → Bot User OAuth Token.' },
      { key: 'appToken', label: 'App token', type: 'password', sensitive: true, placeholder: 'xapp-…', help: 'Socket Mode app-level token (Basic Information → App-Level Tokens).' },
    ],
    note: 'Socket Mode. Create a Slack app, enable Socket Mode, then paste the bot + app tokens.',
  },
  googlechat: {
    fields: [
      { key: 'serviceAccountFile', label: 'Service account JSON path', type: 'text', placeholder: '/path/to/service-account.json', help: 'Path to the Google Cloud service-account key file for the Chat app.' },
      { key: 'audience', label: 'Audience', type: 'text', placeholder: 'App URL or project number', help: 'Optional — HTTP verification audience for the Chat app webhook.' },
    ],
    note: 'Google Workspace Chat app with an HTTP webhook. Configure the Chat API + service account in Google Cloud first.',
  },
  signal: {
    fields: [
      { key: 'account', label: 'Account (phone number)', type: 'text', placeholder: '+15551234567', help: 'The signal-cli registered/linked number for this account.' },
    ],
    note: 'Requires signal-cli installed and the number registered or linked on this machine.',
  },
  whatsapp: {
    fields: [],
    note: 'Link WhatsApp right here — enter your phone number for an 8-digit pairing code (recommended), or scan a QR. No terminal needed.',
  },
  imessage: {
    fields: [],
    note: 'macOS only. Enable to use the local Messages database — grant the gateway Full Disk Access first.',
  },
};

export function setupSpec(id) {
  return CHANNEL_SETUP_SPECS[id] || null;
}

/**
 * From a config.get snapshot: the baseHash for config.patch, non-sensitive
 * prefills keyed `<channel>.<field>`, and which secrets are already stored.
 * Secrets are never mirrored into state.
 */
export function extractSetupPrefill(snap) {
  const baseHash = typeof snap?.hash === 'string' ? snap.hash : null;
  const channelsCfg = snap?.config?.channels || {};
  const current = {};
  const sensitiveSet = {};
  for (const [id, spec] of Object.entries(CHANNEL_SETUP_SPECS)) {
    const cfg = channelsCfg[id];
    if (!cfg || typeof cfg !== 'object') continue;
    for (const f of spec.fields) {
      const v = cfg[f.key];
      if (f.sensitive) {
        if (typeof v === 'string' && v.trim()) sensitiveSet[`${id}.${f.key}`] = true;
        continue;
      }
      if (Array.isArray(v)) current[`${id}.${f.key}`] = v.map((x) => String(x)).join(', ');
      else if (typeof v === 'string' || typeof v === 'number') current[`${id}.${f.key}`] = String(v);
    }
  }
  return { baseHash, current, sensitiveSet };
}

/** Initial form values when a setup form opens (secrets start blank). */
export function initialSetupFields(id, current = {}) {
  const spec = CHANNEL_SETUP_SPECS[id];
  const out = {};
  if (!spec) return out;
  for (const f of spec.fields) out[f.key] = f.sensitive ? '' : current[`${id}.${f.key}`] ?? '';
  return out;
}

/** The channels.<id> merge patch saveChannelSetup builds. */
export function buildSetupPatch(id, fields = {}) {
  const spec = CHANNEL_SETUP_SPECS[id];
  const patch = { enabled: true };
  if (!spec) return patch;
  for (const f of spec.fields) {
    const raw = fields[f.key];
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (f.type === 'csv') {
      const arr = trimmed ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (arr.length) patch[f.key] = arr;
    } else if (trimmed) {
      patch[f.key] = trimmed; // sensitive: only overwrite when a new value is typed
    }
  }
  return patch;
}

/**
 * config.patch params, as the web sends them: { raw: JSON of
 * {channels:{<id>:patch}}, baseHash, note }. baseHash is omitted when unknown
 * (the gateway schema rejects null — NonEmptyString).
 */
export function buildConfigPatchParams(id, patch, baseHash, note) {
  const params = { raw: JSON.stringify({ channels: { [id]: patch } }) };
  if (typeof baseHash === 'string' && baseHash) params.baseHash = baseHash;
  if (note) params.note = note;
  return params;
}

export function setupPatchParams(id, fields, baseHash) {
  return buildConfigPatchParams(id, buildSetupPatch(id, fields), baseHash, `comms: configure ${id}`);
}

export function togglePatchParams(id, enabled, baseHash) {
  return buildConfigPatchParams(id, { enabled }, baseHash, `comms: ${enabled ? 'enable' : 'disable'} ${id}`);
}

// ── Inbox (comms-hub.ts) ─────────────────────────────────────────────────────

export const ASSIGNMENT_FILTERS = [
  { key: 'all', label: 'All assignments' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'me', label: 'Assigned to me' },
];

/** comms.threads.list params from the two filters (loadCommsThreads). */
export function threadsListParams(channelFilter = 'all', assignmentFilter = 'all') {
  const params = {};
  if (channelFilter && channelFilter !== 'all') params.channel = channelFilter;
  if (assignmentFilter === 'unassigned') params.assignedAgentId = null;
  else if (assignmentFilter && assignmentFilter !== 'all') params.assignedAgentId = assignmentFilter;
  return params;
}

export function threadTitle(t) {
  if (!t) return '';
  return t.clientName ?? t.peerDisplayName ?? t.peerHandle ?? t.threadKey ?? '';
}

/** Web fmtTime: clock time within 24h, otherwise "Mon D". */
export function fmtTime(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  if (now - ts < 86_400_000) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function normalizeThread(t) {
  if (!t || typeof t !== 'object' || !t.threadKey) return null;
  return {
    threadKey: String(t.threadKey),
    channel: t.channel || 'telegram',
    clientId: t.clientId ?? null,
    clientName: t.clientName ?? null,
    peerHandle: t.peerHandle ?? '',
    peerDisplayName: t.peerDisplayName ?? null,
    assignedAgentId: t.assignedAgentId ?? null,
    lastMessageAt: Number(t.lastMessageAt) || 0,
    lastMessagePreview: t.lastMessagePreview ?? '',
    lastDirection: t.lastDirection === 'outbound' ? 'outbound' : 'inbound',
    unreadCount: Number(t.unreadCount) || 0,
    messageCount: Number(t.messageCount) || 0,
  };
}

export function normalizeThreads(res) {
  const list = Array.isArray(res?.threads) ? res.threads : [];
  return {
    threads: list.map(normalizeThread).filter(Boolean),
    pendingApprovals: Number(res?.pendingApprovals) || 0,
  };
}

/**
 * A thread opened by deep link that is not in the (filtered) list: build the
 * header from its messages so the conversation still renders.
 */
export function threadFromMessages(threadKey, messages = []) {
  const last = messages[messages.length - 1] || null;
  const named = messages.find((m) => m.peerDisplayName) || null;
  return normalizeThread({
    threadKey,
    channel: last?.channel || messages[0]?.channel || 'telegram',
    clientId: last?.clientId ?? null,
    peerHandle: last?.peerHandle ?? '',
    peerDisplayName: named?.peerDisplayName ?? null,
    lastMessageAt: last?.createdAt ?? 0,
    lastMessagePreview: last?.text ?? '',
    lastDirection: last?.direction,
    messageCount: messages.length,
  });
}

export function messageFlags(m) {
  const outbound = m?.direction === 'outbound';
  return {
    outbound,
    pending: m?.status === 'pending_approval',
    failed: m?.status === 'failed',
    sent: m?.status === 'sent',
  };
}

/** comms.send params (sendReply). Null when there is nothing to send. */
export function buildSendParams(thread, composeChannel, text) {
  const body = String(text ?? '').trim();
  if (!thread || !body || !composeChannel) return null;
  return { channel: composeChannel, clientId: thread.clientId ?? null, peerHandle: thread.peerHandle, text: body };
}

export function isCommsChannelConfigured(channels, channel) {
  return (channels || []).find((c) => c.channel === channel)?.configured ?? false;
}

export function pendingDraftCount(messages) {
  return (messages || []).filter((m) => m?.status === 'pending_approval').length;
}

/** comms.threads.list / comms.thread.get on a gateway without the comms module. */
export function isUnknownMethod(err) {
  const text = String(err?.message ?? err ?? '');
  return err?.code === 'METHOD_NOT_FOUND' || /unknown method|method not found|no handler/i.test(text);
}

// ── WhatsApp link (controllers/channels.ts) ──────────────────────────────────

export const WA_LOGIN_TTL_MS = 180_000;

/** web.login.wait said the pending login is gone — stop polling. */
export function waLoginExpired(message) {
  return Boolean(message) && /expired|no active/i.test(String(message));
}

/** Loose phone check before asking for a pairing code (gateway validates too). */
export function normalizePhone(raw) {
  const s = String(raw ?? '').replace(/[\s().-]/g, '');
  return s;
}

export function phoneLooksValid(raw) {
  return /^\+?\d{7,15}$/.test(normalizePhone(raw));
}

/** Pairing codes read better as XXXX-XXXX. */
export function formatPairingCode(code) {
  const s = String(code ?? '').replace(/[^A-Za-z0-9]/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : String(code ?? '');
}

// ── Telegram guided setup (telegram-setup.ts) ────────────────────────────────

export const TG_STEPS = [
  { id: 'create', label: 'Create bot' },
  { id: 'verify', label: 'Check token' },
  { id: 'find', label: 'Find you' },
  { id: 'test', label: 'Test' },
  { id: 'done', label: 'Done' },
];

const TG_TOKEN_RE = /^(\d{5,16}):([A-Za-z0-9_-]{30,64})$/;

export function cleanTelegramToken(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  const END = "(?=$|[\\s/\"'`).,\\]])";
  const inText = new RegExp(`(?:^|[^0-9])(\\d{5,16}:[A-Za-z0-9_-]{30,64})${END}`).exec(s);
  if (inText) return inText[1];
  return s.replace(/\s+/g, '');
}

/** Same shape check the gateway + web use (src/telegram/setup/token-format.ts). */
export function checkTelegramTokenFormat(raw) {
  const token = cleanTelegramToken(raw);
  if (!token) return { ok: false, problem: 'empty', message: 'Paste the token BotFather gave you.' };
  const match = TG_TOKEN_RE.exec(token);
  if (match) return { ok: true, token, botId: match[1] };
  if (!token.includes(':')) {
    return { ok: false, problem: 'no-colon', message: "That doesn't look like a bot token. It has numbers, a colon, then a long mix of letters, like 123456789:AAH…" };
  }
  const [id, secret = ''] = token.split(':');
  if (!/^\d{5,16}$/.test(id)) {
    return { ok: false, problem: 'bad-id', message: 'The part before the colon should be only numbers. Copy the whole token again.' };
  }
  if (!/^[A-Za-z0-9_-]*$/.test(secret)) {
    return { ok: false, problem: 'bad-chars', message: "The token has characters that don't belong. Copy it again from BotFather." };
  }
  return { ok: false, problem: 'too-short', message: 'The token looks cut off. Copy the whole line from BotFather (about 46 characters).' };
}

export function tgWho(found) {
  if (!found) return '';
  if (found.chatType !== 'private') return found.chatTitle || 'your group';
  if (found.username) return `@${found.username}`;
  return found.firstName || 'you';
}

export function tgClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Map a thrown RPC error to the TgSetupError shape the wizard renders. */
export function tgErrorFromThrow(err) {
  const text = String(err?.message ?? err ?? '');
  if (/unknown method|method not found/i.test(text)) {
    return { code: 'unknown', title: 'InfiniBot needs a restart', message: "This InfiniBot hasn't loaded the Telegram setup yet.", fix: 'Restart InfiniBot, then open this page again.' };
  }
  return { code: 'network', title: 'Something went wrong', message: text.slice(0, 200), fix: 'Wait a moment for it to reconnect, then try again.', action: 'retry' };
}

export function tgStepIndex(step) {
  return TG_STEPS.findIndex((s) => s.id === step);
}

/** Pick the initial wizard step from the summary (web loadSummary). */
export function tgInitialStep(summary) {
  return summary?.ok && summary.connected ? 'summary' : 'create';
}

export function tgReportsTarget(defaultChatId) {
  if (!defaultChatId) return null;
  return `${defaultChatId} ${String(defaultChatId).startsWith('-') ? '(group)' : '(your private chat)'}`;
}

// ── Route params ─────────────────────────────────────────────────────────────

/**
 * Deep-link params → initial view. { channel?, threadId?, view? }.
 *   threadId            → Inbox, that thread open
 *   view: 'inbox'       → Inbox (channel, when an inbox channel, pre-filters)
 *   channel             → Channels, that channel's detail sheet open
 */
export function initialViewFromParams(params = {}) {
  const p = params || {};
  const threadId = p.threadId || p.threadKey || null;
  const channel = p.channel ? String(p.channel).toLowerCase() : null;
  const wantsInbox = p.view === 'inbox' || p.tab === 'inbox' || Boolean(threadId);
  if (wantsInbox) {
    return {
      tab: 'inbox',
      threadId,
      channelFilter: channel && ALL_COMMS_CHANNELS.includes(channel) ? channel : 'all',
      openChannel: null,
    };
  }
  return { tab: 'channels', threadId: null, channelFilter: 'all', openChannel: channel };
}
