/**
 * inbox-model — pure data logic for the native Inbox screen (web /inbox:
 * ui/src/ui/views/inbox.ts + inbox-all-mail.ts + reply-inbox.ts +
 * email-composer-host.ts + email-accounts.ts). No react-native imports so it
 * is covered by jest (src/__tests__/inbox-model.test.js).
 */

// ── Views ────────────────────────────────────────────────────────────────────

export const INBOX_VIEWS = [
  { key: 'mail', label: 'All Mail' },
  { key: 'replies', label: 'Replies' },
  { key: 'insights', label: 'Insights' },
];

const VIEW_ALIASES = {
  mail: 'mail', email: 'mail', emails: 'mail', all: 'mail', 'all-mail': 'mail',
  replies: 'replies', reply: 'replies', 'reply-inbox': 'replies',
  insights: 'insights', insight: 'insights',
};

export function normalizeView(v) {
  if (typeof v !== 'string') return 'mail';
  return VIEW_ALIASES[v.trim().toLowerCase()] || 'mail';
}

/** Route params → { view, messageId } (threadId is accepted as a message id fallback). */
export function parseRouteParams(params) {
  const p = params || {};
  const messageId = str(p.messageId) || str(p.threadId) || str(p.id) || null;
  return { view: normalizeView(p.view || p.tab || (messageId ? 'mail' : undefined)), messageId };
}

// ── Errors ───────────────────────────────────────────────────────────────────

export function errMessage(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e.replace(/^Error:\s*/, '');
  const m = e.message || e.error?.message || String(e);
  return String(m).replace(/^Error:\s*/, '');
}

export function isUnknownMethod(e) {
  const m = errMessage(e).toLowerCase();
  return m.includes('unknown method') || e?.code === 'METHOD_NOT_FOUND' || m.includes('method not found');
}

export function isTimeout(e) {
  return /timeout|timed out/i.test(errMessage(e));
}

// ── Strings / dates ──────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Gmail snippets arrive HTML-escaped (`&amp;`, `&#39;`). */
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s || '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const c = code.toLowerCase();
    if (ENTITIES[c] != null) return ENTITIES[c];
    if (c.startsWith('#x')) {
      const n = parseInt(c.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    if (c.startsWith('#')) {
      const n = parseInt(c.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

/** `"Name" <a@b.c>` → `Name` (web _cleanFrom). */
export function cleanFrom(from) {
  if (typeof from !== 'string') return '';
  const m = from.match(/^"?([^"<]+)"?\s*<.*>$/);
  return m ? m[1].trim() : from;
}

/** `Name <a@b.c>` → `a@b.c`; bare address passes through. */
export function emailAddress(from) {
  if (typeof from !== 'string') return '';
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function parseDate(d) {
  if (d == null || d === '') return null;
  const t = typeof d === 'number' ? new Date(d) : new Date(String(d).replace(/\s*\([A-Z]+\)\s*$/, ''));
  return Number.isNaN(t.getTime()) ? null : t;
}

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** List date: time today, weekday within 7 days, else "Mon D" (web _fmtDate). */
export function fmtListDate(date, now = new Date()) {
  const d = parseDate(date);
  if (!d) return typeof date === 'string' ? date : '';
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays >= 0 && diffDays < 7) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function fmtLongDate(date) {
  const d = parseDate(date);
  if (!d) return typeof date === 'string' ? date : '';
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** reply-inbox _timeAgo */
export function timeAgo(iso, now = Date.now()) {
  const d = parseDate(iso);
  if (!d) return '';
  const mins = Math.floor((now - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** gmail.status payload → { configured, accounts[] } */
export function normalizeStatus(res) {
  const accounts = Array.isArray(res?.accounts) ? res.accounts : [];
  return {
    configured: !!res?.configured,
    accounts: accounts
      .filter((a) => a && (a.id || a.email))
      .map((a) => ({
        id: String(a.id || a.email),
        email: a.email || null,
        isDefault: !!a.isDefault,
        provider: a.provider || null,
      })),
  };
}

export function accountLabel(acc) {
  return (acc && (acc.email || acc.id)) || '';
}

/** web _providerIcon: IMAP / G / @ */
export function providerTag(acc) {
  const email = acc?.email || '';
  if (acc?.provider === 'imap') return 'IMAP';
  if (email.includes('gmail') || email.includes('google') || acc?.provider === 'gmail') return 'G';
  return '@';
}

export function totalUnread(unreadByAccount) {
  return Object.values(unreadByAccount || {}).reduce((s, n) => s + (Number(n) || 0), 0);
}

export function activeUnread(unreadByAccount, activeAccountId) {
  if (activeAccountId == null) return totalUnread(unreadByAccount);
  return Number(unreadByAccount?.[activeAccountId]) || 0;
}

/** email.accounts.list row → display model for the accounts manager. */
export function normalizeEmailAccount(a) {
  const health = a?.health || {};
  const outEnabled = !!a?.outbound?.enabled;
  const inEnabled = !!a?.inbound?.enabled;
  const healthTone = (h, enabled) => {
    if (!enabled) return 'off';
    if (!h || h.lastCheckedAt == null) return 'unknown';
    return h.ok ? 'ok' : 'error';
  };
  return {
    id: String(a?.id || ''),
    kind: a?.kind || 'smtp-imap',
    address: a?.address || '',
    displayName: a?.displayName || a?.address || '',
    isPrimary: !!a?.isPrimary,
    labels: Array.isArray(a?.labels) ? a.labels : [],
    businessId: a?.businessId || null,
    outboundEnabled: outEnabled,
    inboundEnabled: inEnabled,
    outboundHealth: healthTone(health.outbound, outEnabled),
    inboundHealth: healthTone(health.inbound, inEnabled),
    outboundError: health.outbound && !health.outbound.ok ? health.outbound.lastError || null : null,
    inboundError: health.inbound && !health.inbound.ok ? health.inbound.lastError || null : null,
  };
}

export const ACCOUNT_KIND_LABEL = {
  gmail: 'Gmail',
  'smtp-imap': 'SMTP / IMAP',
  mailgun: 'Mailgun',
  sendgrid: 'SendGrid',
  resend: 'Resend',
};

/** email.accounts.test result → null (ok) or a readable error line (web runTest). */
export function summarizeTestResult(account, result) {
  const errs = [];
  if (result?.outbound && !result.outbound.ok && result.outbound.error) errs.push(`outbound: ${result.outbound.error}`);
  if (result?.inbound && !result.inbound.ok && result.inbound.error) errs.push(`inbound: ${result.inbound.error}`);
  const ok =
    (!account?.outboundEnabled || result?.outbound?.ok !== false) &&
    (!account?.inboundEnabled || result?.inbound?.ok !== false);
  return ok ? null : errs.join('  ·  ') || 'test reported failures';
}

export function emptyImapForm() {
  return {
    address: '',
    displayName: '',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: false,
    smtpUser: '',
    smtpPassword: '',
    imapHost: '',
    imapPort: '993',
    imapSecure: true,
    imapMailbox: 'INBOX',
    imapUser: '',
    imapPassword: '',
    sameInboundCreds: true,
    inboundEnabled: true,
    isPrimary: false,
  };
}

/** email.accounts.discover suggestion → form patch */
export function applyDiscovery(form, result) {
  const s = result?.ok ? result.suggestion : null;
  if (!s) return { ...form };
  const next = { ...form };
  if (s.outbound) {
    next.smtpHost = s.outbound.smtpHost || next.smtpHost;
    if (s.outbound.smtpPort) next.smtpPort = String(s.outbound.smtpPort);
    if (typeof s.outbound.smtpSecure === 'boolean') next.smtpSecure = s.outbound.smtpSecure;
  }
  if (s.inbound) {
    next.imapHost = s.inbound.imapHost || next.imapHost;
    if (s.inbound.imapPort) next.imapPort = String(s.inbound.imapPort);
    if (typeof s.inbound.imapSecure === 'boolean') next.imapSecure = s.inbound.imapSecure;
  }
  return next;
}

export function validateImapForm(form) {
  const f = form || {};
  if (!str(f.address) || !f.address.includes('@')) return 'Enter the email address.';
  if (!str(f.smtpHost)) return 'SMTP host is required.';
  if (!(Number(f.smtpPort) > 0)) return 'SMTP port must be a number.';
  if (f.inboundEnabled && !str(f.imapHost)) return 'IMAP host is required (or turn inbound off).';
  if (f.inboundEnabled && !(Number(f.imapPort) > 0)) return 'IMAP port must be a number.';
  return null;
}

/** SMTP/IMAP form → email.accounts.create params (mirrors web saveWizard). */
export function buildImapAccountPayload(form) {
  const f = form || {};
  const address = str(f.address);
  const smtpUser = str(f.smtpUser) || address;
  const outboundConfig = {
    smtpHost: str(f.smtpHost),
    smtpPort: Number(f.smtpPort) || 587,
    smtpSecure: !!f.smtpSecure,
    smtpUser,
  };
  if (f.smtpPassword) outboundConfig.smtpPassword = f.smtpPassword;
  const inboundConfig = {
    imapHost: str(f.imapHost),
    imapPort: Number(f.imapPort) || 993,
    imapSecure: !!f.imapSecure,
    imapMailbox: str(f.imapMailbox) || 'INBOX',
    imapUser: f.sameInboundCreds ? smtpUser : str(f.imapUser) || address,
  };
  const inPw = f.sameInboundCreds ? f.smtpPassword : f.imapPassword;
  if (inPw) inboundConfig.imapPassword = inPw;
  return {
    kind: 'smtp-imap',
    address,
    displayName: str(f.displayName) || address,
    labels: ['business'],
    businessId: null,
    isPrimary: !!f.isPrimary,
    outbound: { enabled: true, config: outboundConfig },
    inbound: { enabled: !!f.inboundEnabled, config: inboundConfig },
  };
}

// ── Mail ─────────────────────────────────────────────────────────────────────

export function normalizeMessage(m) {
  const labels = Array.isArray(m?.labels) ? m.labels : [];
  return {
    id: String(m?.id || ''),
    threadId: m?.threadId ? String(m.threadId) : String(m?.id || ''),
    subject: decodeEntities(m?.subject || ''),
    from: m?.from || '',
    to: m?.to || '',
    snippet: decodeEntities(m?.snippet || ''),
    date: m?.date || '',
    labels,
    isUnread: m?.isUnread != null ? !!m.isUnread : labels.includes('UNREAD'),
    isStarred: m?.isStarred != null ? !!m.isStarred : labels.includes('STARRED'),
    body: typeof m?.body === 'string' ? m.body : '',
    bodyHtml: typeof m?.bodyHtml === 'string' ? m.bodyHtml : '',
  };
}

/** Collapse runs of blank lines / CRLF so a plain-text body reads on a phone. */
export function cleanBody(body) {
  if (typeof body !== 'string') return '';
  return body.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Very small HTML → text for messages that only carry bodyHtml. */
export function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';
  return cleanBody(
    decodeEntities(
      html
        .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    ),
  );
}

export function messageBodyText(m) {
  if (!m) return '';
  return cleanBody(m.body) || htmlToText(m.bodyHtml) || '';
}

const LABEL_ORDER = ['INBOX', 'STARRED', 'IMPORTANT', 'UNREAD', 'SENT', 'DRAFT', 'DRAFTS', 'SPAM', 'TRASH'];
const LABEL_NAMES = {
  INBOX: 'Inbox', STARRED: 'Starred', IMPORTANT: 'Important', UNREAD: 'Unread', SENT: 'Sent',
  DRAFT: 'Drafts', DRAFTS: 'Drafts', SPAM: 'Spam', TRASH: 'Trash', CHAT: 'Chat',
};
export const LABEL_ICONS = {
  INBOX: 'file-tray-outline', SENT: 'send-outline', DRAFT: 'document-text-outline', DRAFTS: 'document-text-outline',
  STARRED: 'star-outline', IMPORTANT: 'pricetag-outline', TRASH: 'trash-outline', SPAM: 'alert-circle-outline',
  UNREAD: 'mail-unread-outline', CHAT: 'chatbubble-outline',
};

export function labelName(l) {
  const id = l?.id || '';
  if (LABEL_NAMES[id]) return LABEL_NAMES[id];
  if (id.startsWith('CATEGORY_')) {
    const rest = id.slice(9).toLowerCase();
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return l?.name || id;
}

/** gmail.labels → ordered [{ id, name, type, unread, icon }] (system first, then user). */
export function normalizeLabels(labels) {
  const list = (Array.isArray(labels) ? labels : []).filter((l) => l && l.id);
  const sys = list.filter((l) => l.type !== 'user');
  const user = list.filter((l) => l.type === 'user');
  const rank = (id) => {
    const i = LABEL_ORDER.indexOf(id);
    if (i >= 0) return i;
    if (id.startsWith('CATEGORY_')) return 50;
    return 100;
  };
  sys.sort((a, b) => rank(a.id) - rank(b.id) || String(a.id).localeCompare(String(b.id)));
  user.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const map = (l) => ({
    id: l.id,
    name: labelName(l),
    type: l.type === 'user' ? 'user' : 'system',
    unread: Number(l.messagesUnread) || 0,
    icon: LABEL_ICONS[l.id] || 'folder-outline',
  });
  return [...sys.map(map), ...user.map(map)];
}

/** gmail.list params (web loadMailData: search query wins over the label). */
export function buildListParams({ accountId = null, searchQuery = '', selectedLabel = 'INBOX', pageToken, maxResults = 30 } = {}) {
  const p = { maxResults, accountId: accountId ?? null };
  const q = str(searchQuery);
  if (q) p.query = q;
  else if (selectedLabel) p.labelIds = [selectedLabel];
  if (pageToken) p.pageToken = pageToken;
  return p;
}

/** Append a page without duplicating ids. */
export function mergeMessages(existing, incoming) {
  const seen = new Set((existing || []).map((m) => m.id));
  const out = [...(existing || [])];
  for (const m of incoming || []) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/** Optimistic local patch after markRead / star / archive / trash. */
export function patchMessage(messages, id, action) {
  const list = messages || [];
  if (action === 'archive' || action === 'trash') return list.filter((m) => m.id !== id);
  return list.map((m) => {
    if (m.id !== id) return m;
    switch (action) {
      case 'read': return { ...m, isUnread: false };
      case 'unread': return { ...m, isUnread: true };
      case 'star': return { ...m, isStarred: true };
      case 'unstar': return { ...m, isStarred: false };
      default: return m;
    }
  });
}

export const MESSAGE_ACTION_RPC = {
  read: 'gmail.markRead',
  unread: 'gmail.markUnread',
  star: 'gmail.star',
  unstar: 'gmail.unstar',
  archive: 'gmail.archive',
  trash: 'gmail.trash',
};

/** gmail.summarize payload → { summary, actions[], provider, model } */
export function normalizeSummary(r) {
  if (!r) return null;
  return {
    summary: typeof r.summary === 'string' ? r.summary : '',
    actions: Array.isArray(r.actions) ? r.actions.filter((a) => typeof a === 'string' && a.trim()) : [],
    provider: r.provider || null,
    model: r.model || null,
  };
}

// ── Compose / reply ──────────────────────────────────────────────────────────

/** email.providerInfo → { accounts (outbound only), noProvider, defaultFrom } */
export function normalizeProviderInfo(info) {
  const accounts = (Array.isArray(info?.accounts) ? info.accounts : []).filter((a) => a && a.outboundEnabled);
  const noProvider = !!info && !info.resend && !info.loops && !info.smtp && accounts.length === 0;
  return { accounts, noProvider, defaultFrom: info?.defaultFrom || null };
}

/** Web composer preselect: the business primary, else the first outbound-enabled account. */
export function pickDefaultFrom(accounts, businessId = '') {
  const list = accounts || [];
  const biz = list.find((a) => (a.businessId || '') === (businessId || '') && a.isPrimary);
  const fb = biz || list.find((a) => a.isPrimary) || list[0];
  return fb ? fb.id : '';
}

export function validateCompose({ to, subject } = {}) {
  if (!str(to)) return 'Recipient required';
  if (!str(subject)) return 'Subject required';
  return null;
}

/** email.send params (web _send). */
export function buildSendParams({ to, subject, body, businessId, accountId } = {}) {
  return {
    to: str(to),
    subject: subject || '',
    body: body || '',
    businessId: businessId || undefined,
    accountId: accountId || undefined,
  };
}

export function replySubject(subject) {
  const s = subject || '';
  return /^re:/i.test(s.trim()) ? s : `Re: ${s}`;
}

// ── Replies (AI-classified lead replies) ─────────────────────────────────────

export const REPLY_CLASSES = {
  interested: { label: 'Interested', tone: 'success', icon: 'flash-outline' },
  not_interested: { label: 'Not Interested', tone: 'danger', icon: 'close-circle-outline' },
  unsubscribe: { label: 'Unsubscribe', tone: 'neutral', icon: 'alert-circle-outline' },
  oof: { label: 'Out of Office', tone: 'warning', icon: 'mail-outline' },
  question: { label: 'Question', tone: 'info', icon: 'help-circle-outline' },
  unknown: { label: 'Unknown', tone: 'neutral', icon: 'pricetag-outline' },
};
export const REPLY_CLASS_FILTERS = ['interested', 'question', 'oof', 'not_interested', 'unsubscribe'];

export const REPLY_URGENCY = {
  high: { label: 'High', tone: 'danger' },
  medium: { label: 'Medium', tone: 'warning' },
  low: { label: 'Low', tone: 'neutral' },
};
export const URGENCY_ORDER = { high: 0, medium: 1, low: 2 };

export function normalizeReply(r) {
  const cls = REPLY_CLASSES[r?.class] ? r.class : 'unknown';
  const urg = REPLY_URGENCY[r?.urgency] ? r.urgency : 'low';
  const conf = Number(r?.confidence);
  return {
    id: String(r?.id || r?.messageId || ''),
    leadId: r?.leadId || '',
    leadName: r?.leadName || r?.leadEmail || 'Unknown lead',
    leadEmail: r?.leadEmail || '',
    messageId: r?.messageId || '',
    threadId: r?.threadId || '',
    subject: r?.subject || '',
    bodyPreview: r?.bodyPreview || '',
    receivedAt: r?.receivedAt || '',
    class: cls,
    urgency: urg,
    suggestedAction: r?.suggestedAction || '',
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    handled: !!r?.handled,
    campaignId: r?.campaignId || '',
    campaignName: r?.campaignName || '',
  };
}

/** web _applyFilters: hide handled, class + urgency filters, sort urgency then newest. */
export function filterReplies(replies, { filterClass = null, filterUrgency = null, showHandled = false } = {}) {
  let list = replies || [];
  if (!showHandled) list = list.filter((r) => !r.handled);
  if (filterClass) list = list.filter((r) => r.class === filterClass);
  if (filterUrgency) list = list.filter((r) => r.urgency === filterUrgency);
  return [...list].sort((a, b) => {
    const u = (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3);
    if (u !== 0) return u;
    return (parseDate(b.receivedAt)?.getTime() || 0) - (parseDate(a.receivedAt)?.getTime() || 0);
  });
}

export function replyCounts(replies) {
  const list = replies || [];
  return {
    unhandled: list.filter((r) => !r.handled).length,
    urgent: list.filter((r) => r.urgency === 'high' && !r.handled).length,
  };
}

export function confidenceLabel(c) {
  const pct = Math.round((Number(c) || 0) * 100);
  return { pct, low: (Number(c) || 0) < 0.7 };
}

// ── Insights + alert rule ────────────────────────────────────────────────────

export function normalizeInsights(r) {
  if (!r) return null;
  return {
    unread: Number(r.unread) || 0,
    today: Number(r.today) || 0,
    last24h: Number(r.last24h) || 0,
    totalScanned: Number(r.totalScanned) || 0,
    topSenders: (Array.isArray(r.topSenders) ? r.topSenders : [])
      .filter((s) => s && s.sender)
      .map((s) => ({ sender: String(s.sender), count: Number(s.count) || 0 })),
  };
}

export const EMPTY_RULE = Object.freeze({
  enabled: true,
  senders: [],
  keywords: [],
  pollIntervalMinutes: 5,
  doTelegramAlert: true,
});

export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return { ...EMPTY_RULE, senders: [], keywords: [] };
  return {
    ...rule,
    enabled: rule.enabled !== false,
    telegramChatId: rule.telegramChatId || '',
    senders: Array.isArray(rule.senders) ? rule.senders.filter(Boolean).map(String) : [],
    keywords: Array.isArray(rule.keywords) ? rule.keywords.filter(Boolean).map(String) : [],
    pollIntervalMinutes: clampPoll(rule.pollIntervalMinutes),
  };
}

export function clampPoll(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(60, Math.max(1, n));
}

/** Add a sender/keyword tag (trimmed, de-duplicated, ignores blanks). */
export function addTag(list, value) {
  const v = str(value);
  const cur = Array.isArray(list) ? list : [];
  if (!v || cur.includes(v)) return cur;
  return [...cur, v];
}

export function removeTag(list, value) {
  return (Array.isArray(list) ? list : []).filter((x) => x !== value);
}

/** gmail.alerts.set params (web _saveAlertRule). */
export function buildAlertParams(activeAccountId, rule) {
  const r = normalizeRule(rule);
  const out = {
    ...r,
    telegramChatId: r.telegramChatId ? r.telegramChatId : undefined,
  };
  return { accountId: activeAccountId ?? null, rule: out };
}

// ── Thread agent (doc-agent-panel docType inbox_thread) ──────────────────────

export function threadAgentContext(view, message, reply, activeAccountId) {
  if (view === 'mail' && message) {
    return {
      docType: 'inbox_thread',
      documentId: message.threadId || message.id,
      title: message.subject || '(No subject)',
      extra: `from=${message.from || '(unknown)'} account=${activeAccountId ?? '(all)'}`,
    };
  }
  if (view === 'replies' && reply) {
    return {
      docType: 'inbox_thread',
      documentId: reply.threadId || reply.messageId || reply.id,
      title: reply.subject || `Reply from ${reply.leadName || reply.leadEmail || '(unknown)'}`,
      extra: `class=${reply.class} urgency=${reply.urgency} lead=${reply.leadEmail || reply.leadName || '(unknown)'}`,
    };
  }
  return null;
}

export function extractChatText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

/** chat.history → [{ role, text, ts }] (user/assistant only, non-empty). */
export function normalizeHistory(res) {
  const msgs = Array.isArray(res?.messages) ? res.messages : [];
  return msgs
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m, i) => ({
      key: `${m.timestamp || m.ts || 0}-${i}`,
      role: m.role,
      text: stripInstructions(extractChatText(m)),
      ts: m.timestamp || m.ts || 0,
    }))
    .filter((m) => m.text);
}

/** The first user turn carries the doc-agent instructions block — show only "My message". */
export function stripInstructions(text) {
  if (typeof text !== 'string') return '';
  const i = text.indexOf('My message: ');
  if (text.startsWith('[INSTRUCTIONS') && i >= 0) return text.slice(i + 12).trim();
  return text;
}

export function composeAgentMessage(text, systemPrompt, isFirst) {
  const t = str(text);
  if (!isFirst || !systemPrompt) return t;
  return `[INSTRUCTIONS — read once, then respond to my message]\n\n${systemPrompt}\n\n---\n\nMy message: ${t}`;
}
