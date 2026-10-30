/**
 * vault-model — pure data mapping for the native Kingly Vault screen.
 *
 * Port of the web vault views (ui/src/ui/views/vault-*.ts + controllers/vault.ts)
 * against the REAL gateway shapes (src/gateway/server-methods/vault.ts +
 * src/vault/store/types.ts). The web controller was typed against an older
 * shape (title/tier/enrollmentCount/username …) while the store answers with
 * name/accessLevel/enrolledCount/discordUsername …; every normalizer here
 * accepts both so the screen renders whichever a gateway sends.
 *
 * No react-native imports — covered by src/__tests__/vault-model.test.js.
 */

// ── Sections ─────────────────────────────────────────────────

export const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: 'pulse-outline' },
  { key: 'members', label: 'Members', icon: 'people-outline' },
  { key: 'courses', label: 'Courses', icon: 'book-outline' },
  { key: 'discord', label: 'Discord', icon: 'logo-discord' },
  { key: 'moderation', label: 'Moderation', icon: 'shield-outline' },
  { key: 'automation', label: 'Automation', icon: 'flash-outline' },
  { key: 'analytics', label: 'Analytics', icon: 'bar-chart-outline' },
  { key: 'path', label: 'Learning Path', icon: 'compass-outline' },
  { key: 'setup', label: 'System', icon: 'settings-outline' },
];

const SECTION_ALIASES = {
  dashboard: 'overview',
  home: 'overview',
  member: 'members',
  tiers: 'members',
  tier: 'members',
  course: 'courses',
  lessons: 'courses',
  mod: 'moderation',
  rules: 'automation',
  stats: 'analytics',
  reports: 'analytics',
  onboarding: 'path',
  learning: 'path',
  'learning-path': 'path',
  learningpath: 'path',
  system: 'setup',
  config: 'setup',
  settings: 'setup',
};

/** Deep-link `section` → a known section key. memberId/courseId imply their tab. */
export function resolveSection(params) {
  const p = params || {};
  const raw = String(p.section || '').trim().toLowerCase();
  if (SECTIONS.some((s) => s.key === raw)) return raw;
  if (SECTION_ALIASES[raw]) return SECTION_ALIASES[raw];
  if (p.memberId) return 'members';
  if (p.courseId) return 'courses';
  return 'overview';
}

// ── Vocabulary ───────────────────────────────────────────────

/** Filter tiers exactly as the web members filter offers them. */
export const FILTER_TIERS = ['free', 'basic', 'premium', 'vip'];
/** Every tier the store accepts (MemberTier) — offered when changing a member's tier. */
export const MEMBER_TIERS = ['free', 'basic', 'paid', 'premium', 'vip', 'lifetime', 'admin'];
/** Course access tiers, as the web course modal offers them. */
export const COURSE_TIERS = ['free', 'basic', 'premium', 'vip'];
export const MEMBER_STATUSES = ['active', 'inactive', 'warned', 'suspended', 'banned'];
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export const MEMBER_SORTS = [
  { key: 'joinedAt', label: 'Join date' },
  { key: 'lastActive', label: 'Last active' },
  { key: 'username', label: 'Name A-Z' },
  { key: 'engagementScore', label: 'Engagement' },
  { key: 'warningCount', label: 'Warnings' },
];
export const COURSE_FILTERS = ['all', 'published', 'draft', 'archived'];
export const LESSON_TYPES = [
  { key: 'text', label: 'Text', icon: 'document-text-outline' },
  { key: 'video', label: 'Video', icon: 'videocam-outline' },
  { key: 'quiz', label: 'Quiz', icon: 'help-circle-outline' },
  { key: 'assignment', label: 'Assignment', icon: 'clipboard-outline' },
];
export const RULE_TRIGGERS = [
  'member_join',
  'member_leave',
  'payment_received',
  'payment_cancelled',
  'course_enroll',
  'course_complete',
  'warning_issued',
  'warning_threshold',
  'inactivity',
  'discord_role_added',
  'discord_role_removed',
  'discord_message',
];
export const ANALYTICS_PERIODS = [
  { key: 'day', label: '24h' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
  { key: 'all', label: 'All time' },
];
export const AUTONOMY_LEVELS = [
  { key: 1, label: 'Level 1 - Monitor only' },
  { key: 2, label: 'Level 2 - Moderate (no kick/ban)' },
  { key: 3, label: 'Level 3 - Full autonomy' },
];
export const APPROVAL_ACTIONS = ['warn', 'timeout', 'kick', 'ban'];

export function titleCase(s) {
  const str = String(s || '').replace(/_/g, ' ');
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// ── Errors ───────────────────────────────────────────────────

const MISSING_RX = /unknown method|method not found|no handler|not implemented|unsupported method/i;
export function isMissingMethod(err) {
  return MISSING_RX.test(String(err?.message || err || ''));
}
export function isNotConfigured(err) {
  return err?.code === 'NOT_CONFIGURED' || /not configured/i.test(String(err?.message || err || ''));
}
export function errorText(err) {
  return String(err?.message || err || 'Something went wrong');
}

// ── Formatting ───────────────────────────────────────────────

function toMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const n = Date.parse(String(v));
  return Number.isNaN(n) ? NaN : n;
}

export function timeAgo(value, now = Date.now()) {
  const t = toMs(value);
  if (Number.isNaN(t)) return '-';
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatDate(value) {
  const t = toMs(value);
  if (Number.isNaN(t)) return '-';
  const d = new Date(t);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${M[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export function formatPercent(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return `${Math.round(v)}%`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Web: online when last active within 15 minutes. */
export function isOnline(lastActive, now = Date.now()) {
  const t = toMs(lastActive);
  return !Number.isNaN(t) && now - t < 15 * 60 * 1000;
}

// ── Members ──────────────────────────────────────────────────

function avatarUrl(raw) {
  const a = raw.avatar || raw.discordAvatar;
  if (!a) return null;
  if (/^https?:\/\//i.test(a)) return a;
  const did = raw.discordId || raw.id;
  return did ? `https://cdn.discordapp.com/avatars/${did}/${a}.png?size=128` : null;
}

export function normalizeMember(raw) {
  const m = raw || {};
  const warnings = Array.isArray(m.warnings) ? m.warnings : [];
  const warningCount = Number.isFinite(Number(m.warningCount)) ? Number(m.warningCount) : warnings.length;
  const completed = Number(m.coursesCompleted ?? m.completedCourses ?? 0) || 0;
  return {
    id: String(m.id ?? ''),
    discordId: m.discordId || '',
    username: m.username || m.discordUsername || m.name || m.email || String(m.id ?? 'member'),
    discriminator: m.discriminator && m.discriminator !== '0' ? m.discriminator : '',
    avatar: avatarUrl(m),
    email: m.email || '',
    joinedAt: m.joinedAt ?? null,
    lastActive: m.lastActive ?? m.lastActiveAt ?? null,
    roles: Array.isArray(m.roles) ? m.roles.map(String) : [],
    tier: String(m.tier || 'free').toLowerCase(),
    status: String(m.status || 'active').toLowerCase(),
    warningCount,
    warnings,
    engagementScore: Math.round(Number(m.engagementScore ?? m.totalProgress ?? 0) || 0),
    coursesCompleted: completed,
    coursesInProgress: Number(m.coursesInProgress ?? 0) || 0,
    notes: m.notes || '',
    paymentSource: m.paymentSource || '',
    subscriptionStatus: m.subscriptionStatus || '',
  };
}

export const DEFAULT_MEMBER_FILTERS = Object.freeze({
  search: '',
  status: null,
  tier: null,
  sortBy: 'joinedAt',
  hasWarnings: false,
});

/**
 * The gateway's vault.members.list only honours tier/status/limit/offset;
 * free-text search lives on vault.members.search. (The web sends `search` to
 * .list, where it is ignored — the native screen routes it properly.)
 */
export function memberQuery(filters, page = 0, pageSize = 50) {
  const f = filters || DEFAULT_MEMBER_FILTERS;
  const q = String(f.search || '').trim();
  if (q) return { method: 'vault.members.search', params: { query: q, limit: 200 } };
  const params = { limit: pageSize, offset: Math.max(0, page) * pageSize };
  if (f.tier) params.tier = f.tier;
  if (f.status) params.status = f.status;
  return { method: 'vault.members.list', params };
}

function sortValue(m, key) {
  switch (key) {
    case 'username': return String(m.username || '').toLowerCase();
    case 'lastActive': return toMs(m.lastActive) || 0;
    case 'engagementScore': return m.engagementScore || 0;
    case 'warningCount': return m.warningCount || 0;
    case 'joinedAt':
    default: return toMs(m.joinedAt) || 0;
  }
}

/** Client-side filter + sort (search results arrive unfiltered; sort/hasWarnings are never server-side). */
export function applyMemberFilters(members, filters) {
  const f = filters || DEFAULT_MEMBER_FILTERS;
  const q = String(f.search || '').trim().toLowerCase();
  let out = (members || []).filter(Boolean);
  if (q) {
    out = out.filter((m) => [m.username, m.email, m.discordId, m.id].some((v) => String(v || '').toLowerCase().includes(q)));
  }
  if (f.status) out = out.filter((m) => m.status === f.status);
  if (f.tier) out = out.filter((m) => m.tier === f.tier);
  if (f.hasWarnings) out = out.filter((m) => m.warningCount > 0);
  const key = f.sortBy || 'joinedAt';
  const asc = key === 'username';
  return out.slice().sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });
}

export function hasActiveMemberFilters(f) {
  return Boolean(f && (String(f.search || '').trim() || f.status || f.tier || f.hasWarnings));
}

export function memberStatusTone(status) {
  switch (status) {
    case 'active': return 'success';
    case 'warned': return 'warning';
    case 'suspended':
    case 'muted': return 'warning';
    case 'banned': return 'danger';
    case 'pending': return 'info';
    default: return 'neutral';
  }
}

export function tierCounts(members) {
  const out = {};
  for (const m of members || []) out[m.tier] = (out[m.tier] || 0) + 1;
  return out;
}

/** Map role ids on a member to Discord role names when the guild roles are known. */
export function roleNames(roleIds, guildRoles) {
  const byId = new Map((guildRoles || []).map((r) => [String(r.id), r]));
  return (roleIds || []).map((id) => {
    const r = byId.get(String(id));
    return { id: String(id), name: r ? r.name : String(id), color: r ? roleColorHex(r.color) : null };
  });
}

export function buildMemberCreateParams(form) {
  const f = form || {};
  const out = { tier: f.tier || 'free' };
  const did = String(f.discordId || '').trim();
  const name = String(f.discordUsername || '').trim();
  const email = String(f.email || '').trim();
  if (did) out.discordId = did;
  if (name) out.discordUsername = name;
  if (email) out.email = email;
  return out;
}

export function canCreateMember(form) {
  const f = form || {};
  return Boolean(String(f.discordId || '').trim() || String(f.discordUsername || '').trim() || String(f.email || '').trim());
}

// ── Analytics ────────────────────────────────────────────────

const n0 = (...vals) => {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return 0;
};

export function normalizeAnalytics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw;
  const m = a.members || {};
  const c = a.courses || {};
  const e = a.engagement || {};
  const mod = a.moderation || {};
  const topRaw = Array.isArray(a.topCourses) && a.topCourses.length ? a.topCourses : (Array.isArray(c.topCourses) ? c.topCourses : []);
  const byTier = m.byTier && typeof m.byTier === 'object' ? m.byTier : {};
  return {
    totalMembers: n0(a.totalMembers, m.total),
    activeMembers: n0(a.activeMembers, m.active),
    newThisWeek: n0(a.newMembersThisWeek),
    newThisMonth: n0(a.newMembersThisMonth, m.new),
    churned: n0(m.churned),
    churnRate: n0(a.churnRate),
    retentionRate: n0(a.retentionRate),
    averageEngagement: n0(a.averageEngagement),
    totalCourses: n0(a.totalCourses),
    enrollments: n0(a.totalEnrollments, c.totalEnrollments),
    completions: n0(c.completions),
    averageProgress: n0(c.averageProgress),
    lessonsCompleted: n0(e.lessonsCompleted),
    quizzesPassed: n0(e.quizzesPassed),
    totalWarnings: n0(a.totalWarnings, mod.warnings),
    activeWarnings: n0(a.activeWarnings),
    moderation: {
      warnings: n0(mod.warnings, a.totalWarnings),
      timeouts: n0(mod.timeouts),
      kicks: n0(mod.kicks),
      bans: n0(mod.bans),
    },
    byTier: Object.entries(byTier).map(([tier, count]) => ({ tier, count: Number(count) || 0 })),
    topCourses: topRaw.map((t) => ({
      id: String(t.id ?? t.courseId ?? t.name ?? t.title ?? ''),
      title: t.title || t.name || 'Untitled',
      enrollments: Number(t.enrollments ?? 0) || 0,
      completionRate: Number(t.completionRate ?? 0) || 0,
    })),
    recentActivity: (Array.isArray(a.recentActivity) ? a.recentActivity : []).map(normalizeActivity),
    platform: [
      { key: 'aiMessages', label: 'AI messages', value: n0(a.totalAiChatMessages) },
      { key: 'aiConversations', label: 'Conversations', value: n0(a.totalAiChatConversations) },
      { key: 'images', label: 'Images', value: n0(a.totalImageGenerations) },
      { key: 'imagesOk', label: 'Image success', value: n0(a.totalImageGenerationSuccess) },
      { key: 'imagesFailed', label: 'Image failed', value: n0(a.totalImageGenerationFailed) },
      { key: 'pageViews', label: 'Page views', value: n0(a.totalPageViews) },
      { key: 'logins', label: 'Logins', value: n0(a.totalLogins) },
      { key: 'courseStarts', label: 'Course starts', value: n0(a.totalCourseStarts) },
      { key: 'lessonViews', label: 'Lesson views', value: n0(a.totalLessonViews) },
      { key: 'lessonStarts', label: 'Lesson starts', value: n0(a.totalLessonStarts) },
      { key: 'videoPlays', label: 'Video plays', value: n0(a.totalVideoPlays) },
      { key: 'downloads', label: 'Downloads', value: n0(a.totalDownloads) },
      { key: 'searches', label: 'Searches', value: n0(a.totalSearches) },
    ],
    activityBreakdown: (Array.isArray(a.userActivityBreakdown) ? a.userActivityBreakdown : [])
      .slice(0, 12)
      .map((it) => ({ label: titleCase(it.eventType || 'event'), count: Number(it.count) || 0 })),
    toolEngagement: a.toolEngagement && n0(a.toolEngagement.totalToolViews) > 0
      ? { views: n0(a.toolEngagement.totalToolViews), clicks: n0(a.toolEngagement.totalToolClicks), usage: n0(a.toolEngagement.totalToolUsage) }
      : null,
    vaultEngagement: a.vaultEngagement && n0(a.vaultEngagement.totalVaultViews) > 0
      ? {
        views: n0(a.vaultEngagement.totalVaultViews),
        downloads: n0(a.vaultEngagement.totalFileDownloads),
        uploads: n0(a.vaultEngagement.totalFileUploads),
        agents: n0(a.vaultEngagement.totalAgentCreations),
      }
      : null,
  };
}

/** The six KPI tiles at the top of the web dashboard (renderStatsBar), Discord counts as fallback. */
export function buildKpis(analytics, guild) {
  const a = analytics || normalizeAnalytics({});
  const g = guild || null;
  const total = a.totalMembers || g?.memberCount || 0;
  const online = a.activeMembers || g?.onlineCount || 0;
  const onlinePct = total > 0 ? Math.round((online / total) * 100) : null;
  return [
    { key: 'members', label: 'Total members', value: formatNumber(total), icon: 'people-outline', section: 'members',
      delta: a.newThisWeek || undefined, deltaLabel: a.newThisWeek ? 'this week' : undefined,
      footnote: a.newThisMonth ? `${formatNumber(a.newThisMonth)} this month` : undefined },
    { key: 'online', label: 'Online now', value: formatNumber(online), icon: 'pulse-outline', section: 'members',
      footnote: onlinePct !== null ? `${onlinePct}% of members` : undefined },
    { key: 'channels', label: 'Channels', value: formatNumber(g?.channels?.length || 0), icon: 'chatbubbles-outline', section: 'discord' },
    { key: 'roles', label: 'Roles', value: formatNumber(g?.roles?.length || 0), icon: 'ribbon-outline', section: 'discord' },
    { key: 'courses', label: 'Courses', value: formatNumber(a.totalCourses), icon: 'book-outline', section: 'courses',
      footnote: a.completions ? `${formatNumber(a.completions)} completed` : undefined },
    { key: 'warnings', label: 'Active warnings', value: formatNumber(a.activeWarnings), icon: 'warning-outline', section: 'moderation',
      footnote: a.totalWarnings ? `${formatNumber(a.totalWarnings)} total` : undefined },
  ];
}

export function normalizeActivity(raw) {
  const a = raw || {};
  return {
    id: String(a.id ?? `${a.type}-${a.timestamp}`),
    type: a.type || 'event',
    memberName: a.memberName || '',
    memberAvatar: a.memberAvatar || null,
    channelName: a.channelName || '',
    text: a.type === 'message' && a.content ? a.content : (a.description || a.content || titleCase(a.type)),
    timestamp: a.timestamp ?? a.createdAt ?? null,
  };
}

export function activityIcon(type) {
  switch (type) {
    case 'member_join': return 'person-add-outline';
    case 'member_leave': return 'exit-outline';
    case 'course_complete': return 'trophy-outline';
    case 'warning_issued': return 'warning-outline';
    case 'role_change': return 'ribbon-outline';
    case 'payment': return 'trending-up-outline';
    case 'message': return 'chatbubble-outline';
    default: return 'pulse-outline';
  }
}

/** Merge Discord channel messages (newest first, top 15) ahead of the store activity, cap 20 — web loadVaultData. */
export function mergeActivity(messages, existing) {
  const msgs = (messages || []).map(normalizeActivity)
    .sort((x, y) => (toMs(y.timestamp) || 0) - (toMs(x.timestamp) || 0))
    .slice(0, 15);
  return [...msgs, ...(existing || [])].slice(0, 20);
}

// ── Discord ──────────────────────────────────────────────────

export function normalizeGuild(guild, roles, channels) {
  if (!guild || typeof guild !== 'object') return null;
  return {
    id: String(guild.id ?? ''),
    name: guild.name || 'Discord server',
    icon: guild.icon || null,
    iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
    memberCount: Number(guild.memberCount ?? 0) || 0,
    onlineCount: Number(guild.onlineCount ?? 0) || 0,
    premiumTier: Number(guild.premiumTier ?? 0) || 0,
    roles: Array.isArray(roles) ? roles : (Array.isArray(guild.roles) ? guild.roles : []),
    channels: Array.isArray(channels) ? channels : (Array.isArray(guild.channels) ? guild.channels : []),
    emojis: Array.isArray(guild.emojis) ? guild.emojis : [],
  };
}

export function roleColorHex(color) {
  const n = Number(color);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Highest position first, @everyone dropped (web sortRoles + filter). */
export function sortRoles(roles) {
  return (roles || []).filter((r) => r && r.name !== '@everyone').slice().sort((a, b) => (b.position || 0) - (a.position || 0));
}

export function channelIcon(type) {
  switch (Number(type)) {
    case 2: return 'volume-medium-outline';
    case 4: return 'folder-outline';
    case 5: return 'megaphone-outline';
    case 13: return 'mic-outline';
    case 15: return 'albums-outline';
    default: return 'chatbox-outline';
  }
}

/** Uncategorised first, then each category (by position) with its channels (by position). */
export function groupChannels(channels) {
  const list = channels || [];
  const cats = list.filter((c) => Number(c.type) === 4).sort((a, b) => (a.position || 0) - (b.position || 0));
  const byParent = new Map();
  for (const ch of list) {
    if (Number(ch.type) === 4) continue;
    const key = ch.parentId ?? ch.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(ch);
  }
  for (const [, arr] of byParent) arr.sort((a, b) => (a.position || 0) - (b.position || 0));
  const groups = [];
  const loose = byParent.get(null) || [];
  if (loose.length) groups.push({ id: '__none', name: null, channels: loose });
  for (const cat of cats) groups.push({ id: String(cat.id), name: cat.name, channels: byParent.get(cat.id) || [] });
  return groups;
}

/** Channels an announcement can go to (text + announcement). */
export function textChannels(channels) {
  return (channels || []).filter((c) => Number(c.type) === 0 || Number(c.type) === 5);
}

export function channelCounts(channels) {
  const list = channels || [];
  return {
    text: list.filter((c) => Number(c.type) === 0).length,
    voice: list.filter((c) => Number(c.type) === 2).length,
    total: list.filter((c) => Number(c.type) !== 4).length,
  };
}

// ── Courses ──────────────────────────────────────────────────

function lessonText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.markdown || content.text || content.task || content.instructions || content.assignment?.instructions || '';
}

export function normalizeLesson(raw, moduleId) {
  const l = raw || {};
  const content = l.content;
  const contentType = String(l.contentType || l.type || (content && typeof content === 'object' && content.type) || 'text');
  return {
    id: String(l.id ?? ''),
    moduleId: String(l.moduleId ?? moduleId ?? ''),
    title: l.name || l.title || 'Untitled lesson',
    contentType,
    content: lessonText(content),
    videoUrl: l.videoUrl || (content && typeof content === 'object' ? content.url || content.videoUrl || '' : ''),
    duration: Number(l.duration ?? l.durationMinutes ?? 0) || 0,
    order: Number(l.order ?? 0) || 0,
  };
}

export function normalizeModule(raw, courseId) {
  const m = raw || {};
  const lessons = (Array.isArray(m.lessons) ? m.lessons : []).map((l) => normalizeLesson(l, m.id)).sort((a, b) => a.order - b.order);
  return {
    id: String(m.id ?? ''),
    courseId: String(m.courseId ?? courseId ?? ''),
    title: m.name || m.title || 'Untitled module',
    description: m.description || '',
    order: Number(m.order ?? 0) || 0,
    lessons,
  };
}

export function normalizeCourse(raw) {
  const c = raw || {};
  const modules = (Array.isArray(c.modules) ? c.modules : []).map((m) => normalizeModule(m, c.id)).sort((a, b) => a.order - b.order);
  return {
    id: String(c.id ?? ''),
    title: c.name || c.title || 'Untitled course',
    slug: c.slug || '',
    description: c.description || '',
    coverImage: c.coverImage || c.thumbnailUrl || null,
    tier: String(c.accessLevel || c.requiredTier || c.tier || 'free').toLowerCase(),
    status: String(c.status || 'draft').toLowerCase(),
    modules,
    lessonCount: modules.reduce((s, m) => s + m.lessons.length, 0),
    enrollmentCount: Number(c.enrolledCount ?? c.enrollmentCount ?? 0) || 0,
    completionRate: Math.round(Number(c.completionRate ?? 0) || 0),
    sortOrder: Number(c.sortOrder ?? 0) || 0,
    updatedAt: c.updatedAt ?? null,
  };
}

export function courseStats(courses) {
  const list = courses || [];
  return {
    total: list.length,
    published: list.filter((c) => c.status === 'published').length,
    draft: list.filter((c) => c.status === 'draft').length,
    archived: list.filter((c) => c.status === 'archived').length,
    enrollments: list.reduce((s, c) => s + (c.enrollmentCount || 0), 0),
  };
}

export function filterCourses(courses, { status = 'all', search = '' } = {}) {
  let out = courses || [];
  if (status && status !== 'all') out = out.filter((c) => c.status === status);
  const q = String(search || '').trim().toLowerCase();
  if (q) out = out.filter((c) => c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
  return out;
}

export function courseStatusTone(status) {
  if (status === 'published') return 'success';
  if (status === 'archived') return 'danger';
  return 'neutral';
}

/**
 * Course create/update params in the gateway's vocabulary
 * (title / description / requiredTier / thumbnailUrl). The web modal sends
 * `tier`/`coverImage`, which the handler ignores.
 */
export function buildCourseParams(form, id) {
  const f = form || {};
  const out = {
    title: String(f.title || '').trim(),
    description: String(f.description || '').trim(),
    requiredTier: f.tier || 'free',
  };
  const cover = String(f.coverImage || '').trim();
  if (id) {
    out.courseId = id;
    out.thumbnailUrl = cover;
  } else if (cover) {
    out.thumbnailUrl = cover;
  }
  return out;
}

export function courseForm(course) {
  const c = course || {};
  return { title: c.title || '', description: c.description || '', tier: c.tier || 'free', coverImage: c.coverImage || '' };
}

export function videoProvider(url) {
  const u = String(url || '').toLowerCase();
  if (/youtu\.?be/.test(u)) return 'youtube';
  if (u.includes('vimeo')) return 'vimeo';
  if (u.includes('loom')) return 'loom';
  if (u.includes('wistia')) return 'wistia';
  return 'custom';
}

/** Lesson content object in the store's shape for the chosen type. */
export function buildLessonContent(type, { content = '', videoUrl = '' } = {}) {
  const markdown = String(content || '');
  if (type === 'video') {
    const url = String(videoUrl || '').trim();
    return { type: 'video', url, provider: videoProvider(url), videoUrl: url, markdown };
  }
  if (type === 'text') return { type: 'text', markdown };
  return { type, markdown };
}

/** vault.lessons.update params — gateway needs lessonId + moduleId (the web sends `id` only). */
export function buildLessonUpdate(lesson, form) {
  const f = form || {};
  const type = f.contentType || lesson?.contentType || 'text';
  const out = {
    lessonId: lesson.id,
    moduleId: lesson.moduleId,
    name: String(f.title ?? lesson.title ?? '').trim() || lesson.title,
    type,
    content: buildLessonContent(type, { content: f.content ?? lesson.content, videoUrl: f.videoUrl ?? lesson.videoUrl }),
  };
  const dur = parseInt(String(f.duration ?? ''), 10);
  if (Number.isFinite(dur) && dur > 0) out.duration = dur;
  return out;
}

export function buildLessonCreate(moduleId, title, order) {
  return { moduleId, name: String(title || '').trim(), type: 'text', content: { type: 'text', markdown: '' }, order };
}

export function buildModuleCreate(courseId, title, order) {
  return { courseId, name: String(title || '').trim(), order };
}

export function buildModuleUpdate(mod, form) {
  return {
    moduleId: mod.id,
    courseId: mod.courseId,
    name: String(form?.title ?? mod.title).trim() || mod.title,
    description: String(form?.description ?? mod.description ?? ''),
  };
}

/** Pull the created entity out of a create response ({module}|{lesson}|bare). */
export function unwrap(res, key) {
  if (!res || typeof res !== 'object') return null;
  return res[key] || (res.id ? res : null);
}

// ── Moderation ───────────────────────────────────────────────

export function normalizeModLog(raw) {
  const l = raw || {};
  const action = String(l.action || 'note');
  return {
    id: String(l.id ?? `${action}-${l.timestamp}`),
    action,
    memberId: String(l.memberId ?? l.targetMemberId ?? ''),
    memberName: l.memberName || l.details?.memberName || l.targetDiscordId || l.targetMemberId || l.memberId || 'unknown',
    moderator: l.moderatorName || l.moderatorId || l.performedBy || 'System',
    reason: l.reason || '',
    timestamp: l.timestamp ?? null,
    auto: Boolean(l.autoAction || l.metadata?.autoAction),
  };
}

export function moderationCounts(logs) {
  const list = logs || [];
  return {
    total: list.length,
    warnings: list.filter((l) => l.action === 'warning' || l.action === 'warn').length,
    timeouts: list.filter((l) => l.action === 'timeout' || l.action === 'mute').length,
    bans: list.filter((l) => l.action === 'ban').length,
  };
}

export function modActionTone(action) {
  switch (action) {
    case 'warn':
    case 'warning': return 'warning';
    case 'timeout':
    case 'mute': return 'warning';
    case 'kick':
    case 'ban': return 'danger';
    case 'unban':
    case 'unmute':
    case 'clear_warnings': return 'success';
    default: return 'info';
  }
}

export function modActionIcon(action) {
  switch (action) {
    case 'warn':
    case 'warning': return 'warning-outline';
    case 'timeout':
    case 'mute': return 'timer-outline';
    case 'kick': return 'exit-outline';
    case 'ban': return 'hammer-outline';
    case 'unban':
    case 'unmute': return 'checkmark-circle-outline';
    case 'clear_warnings': return 'sparkles-outline';
    default: return 'document-text-outline';
  }
}

// ── Automation rules ─────────────────────────────────────────

export function normalizeRule(raw) {
  const r = raw || {};
  return {
    id: String(r.id ?? ''),
    name: r.name || 'Untitled rule',
    description: r.description || '',
    enabled: r.enabled !== false,
    triggerType: (r.trigger && r.trigger.type) || 'unknown',
    trigger: r.trigger || null,
    conditions: Array.isArray(r.conditions) ? r.conditions : [],
    actions: Array.isArray(r.actions) ? r.actions : [],
    triggerCount: Number(r.triggerCount ?? 0) || 0,
    lastTriggered: r.lastTriggered ?? r.lastTriggeredAt ?? null,
  };
}

export function triggerIcon(type) {
  switch (type) {
    case 'member_join': return 'person-add-outline';
    case 'member_leave': return 'exit-outline';
    case 'payment_received': return 'cash-outline';
    case 'payment_cancelled': return 'close-circle-outline';
    case 'course_enroll': return 'book-outline';
    case 'course_complete': return 'school-outline';
    case 'warning_issued': return 'warning-outline';
    case 'warning_threshold': return 'alert-circle-outline';
    case 'inactivity': return 'moon-outline';
    case 'scheduled': return 'alarm-outline';
    case 'discord_role_added':
    case 'discord_role_removed': return 'pricetag-outline';
    case 'discord_message': return 'chatbubble-outline';
    default: return 'flash-outline';
  }
}

/**
 * vault.rules.create / .update params. Keeps an existing trigger's extra
 * config when the type is unchanged; conditions/actions are passed through
 * untouched (they are edited by agents, not on the phone).
 */
export function buildRuleParams(form, existing) {
  const f = form || {};
  const type = f.triggerType || existing?.triggerType || 'member_join';
  const trigger = existing?.trigger && existing.trigger.type === type ? existing.trigger : { type };
  const out = {
    name: String(f.name || '').trim(),
    description: String(f.description || '').trim(),
    enabled: f.enabled !== false,
    trigger,
  };
  if (existing?.id) out.id = existing.id;
  else {
    out.conditions = [];
    out.actions = [];
  }
  return out;
}

// ── Setup / config ───────────────────────────────────────────

export function configForm(config) {
  const c = config || {};
  return {
    welcomeChannelId: c.welcomeChannelId || '',
    announcementChannelId: c.announcementChannelId || '',
    modLogChannelId: c.modLogChannelId || '',
    autoModEnabled: c.autoModEnabled !== false,
    autonomyLevel: Number(c.ashAutonomy?.level ?? 3) || 3,
    requireApproval: Array.isArray(c.ashAutonomy?.requireApproval) ? c.ashAutonomy.requireApproval.slice() : [],
    tierRoles: { ...(c.tierRoles || {}) },
  };
}

/** vault.config.update takes the patch nested under `config`. */
export function buildConfigPatch(form) {
  const f = form || {};
  return {
    config: {
      welcomeChannelId: f.welcomeChannelId || undefined,
      announcementChannelId: f.announcementChannelId || undefined,
      modLogChannelId: f.modLogChannelId || undefined,
      autoModEnabled: Boolean(f.autoModEnabled),
      tierRoles: { ...(f.tierRoles || {}) },
      ashAutonomy: { level: Number(f.autonomyLevel) || 3, requireApproval: (f.requireApproval || []).slice() },
    },
  };
}

export function normalizeSetup(raw) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : [];
  return {
    completed: Boolean(raw?.completed),
    steps: steps.map((s) => ({
      id: String(s.id),
      title: s.title || titleCase(s.id),
      description: s.description || '',
      required: Boolean(s.required),
      completed: Boolean(s.completed),
    })),
    doneCount: steps.filter((s) => s.completed).length,
  };
}

export function toggleIn(list, item) {
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
}

// ── Learning path (vault-onboarding) ─────────────────────────

export const INTEREST_OPTIONS = [
  'Automation', 'AI & Machine Learning', 'Content Creation',
  'Digital Products', 'Business Strategy', 'Notion & Productivity',
  'Mindset & Psychology', 'Crypto & Web3', 'Design & Branding',
  'Marketing & Sales', 'Video Production', 'Data Analysis',
];
export const GOAL_OPTIONS = [
  'Start a side business', 'Scale an existing business',
  'Build a personal brand', 'Learn new skills for career growth',
  'Automate my workflow', 'Create digital products',
  'Master productivity systems', 'Generate passive income',
];
export const FOCUS_OPTIONS = [
  'Build no-code automations', 'Create and sell digital products',
  'Develop a success mindset', 'Master Notion for productivity',
  'Build a content engine', 'Generate AI-powered visuals',
  'Navigate crypto markets', 'All of the above',
];
export const SKILL_LEVELS = [
  { key: 'beginner', label: 'Beginner', desc: 'New to these topics' },
  { key: 'intermediate', label: 'Intermediate', desc: 'Some experience' },
  { key: 'advanced', label: 'Advanced', desc: 'Experienced and skilled' },
];
export const HOURS_PRESETS = [2, 5, 10, 20];
export const PATH_STEPS = ['Welcome', 'Interests', 'Goals', 'Skill level', 'Commitment', 'Focus'];

export function emptyAnswers() {
  return { interests: [], goals: [], skillLevel: 'beginner', hoursPerWeek: 5, wantToLearn: '' };
}

/** Mirrors the gateway's guard: at least one interest or a wantToLearn topic. */
export function canGeneratePath(answers) {
  const a = answers || {};
  return (Array.isArray(a.interests) && a.interests.length > 0) || Boolean(String(a.wantToLearn || '').trim());
}

/** Step gate — the web disables Continue on Interests until one is picked. */
export function canAdvancePath(step, answers) {
  if (step === 1) return (answers?.interests || []).length > 0;
  if (step === 4) return Number(answers?.hoursPerWeek) > 0;
  if (step === 5) return canGeneratePath(answers);
  return true;
}

export function buildLearningPathParams(answers, memberId = 'current') {
  const a = answers || emptyAnswers();
  const hrs = parseInt(String(a.hoursPerWeek), 10);
  return {
    memberId: memberId || 'current',
    interests: (a.interests || []).slice(),
    goals: (a.goals || []).slice(),
    skillLevel: a.skillLevel || 'beginner',
    hoursPerWeek: Number.isFinite(hrs) && hrs > 0 ? Math.min(hrs, 80) : 5,
    wantToLearn: String(a.wantToLearn || '').trim(),
  };
}

export function normalizeLearningPath(raw) {
  const lp = raw && (raw.learningPath !== undefined ? raw.learningPath : raw);
  if (!lp || typeof lp !== 'object' || !Array.isArray(lp.weeks)) return null;
  return {
    id: String(lp.id ?? ''),
    summary: lp.summary || '',
    totalWeeks: Number(lp.totalWeeks ?? lp.weeks.length) || lp.weeks.length,
    totalCourses: Number(lp.totalCourses ?? 0) || 0,
    hoursPerWeek: Number(lp.answers?.hoursPerWeek ?? 0) || 0,
    generatedAt: lp.generatedAt ?? null,
    weeks: lp.weeks.map((w) => ({
      week: Number(w.week) || 0,
      focus: w.focus || '',
      courses: (Array.isArray(w.courses) ? w.courses : []).map((c) => ({
        id: String(c.courseId ?? c.id ?? c.name ?? ''),
        name: c.name || c.title || 'Course',
        reason: c.reason || '',
      })),
    })),
  };
}
