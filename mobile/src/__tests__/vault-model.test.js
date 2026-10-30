import {
  SECTIONS,
  resolveSection,
  isMissingMethod,
  isNotConfigured,
  timeAgo,
  formatNumber,
  formatPercent,
  initials,
  isOnline,
  normalizeMember,
  memberQuery,
  applyMemberFilters,
  hasActiveMemberFilters,
  DEFAULT_MEMBER_FILTERS,
  roleNames,
  buildMemberCreateParams,
  canCreateMember,
  normalizeAnalytics,
  buildKpis,
  mergeActivity,
  normalizeGuild,
  sortRoles,
  roleColorHex,
  groupChannels,
  textChannels,
  channelCounts,
  normalizeCourse,
  courseStats,
  filterCourses,
  buildCourseParams,
  buildLessonContent,
  buildLessonUpdate,
  buildLessonCreate,
  buildModuleCreate,
  buildModuleUpdate,
  videoProvider,
  unwrap,
  normalizeModLog,
  moderationCounts,
  normalizeRule,
  buildRuleParams,
  configForm,
  buildConfigPatch,
  normalizeSetup,
  toggleIn,
  canGeneratePath,
  canAdvancePath,
  buildLearningPathParams,
  normalizeLearningPath,
  emptyAnswers,
  tierCounts,
} from '../screens/vault/vault-model';

const NOW = Date.parse('2026-10-14T12:00:00Z');

describe('sections + deep links', () => {
  test('every web tab plus the learning path is a section', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'overview', 'members', 'courses', 'discord', 'moderation', 'automation', 'analytics', 'path', 'setup',
    ]);
  });
  test('resolveSection: exact, alias, implied by ids, default', () => {
    expect(resolveSection({ section: 'courses' })).toBe('courses');
    expect(resolveSection({ section: 'System' })).toBe('setup');
    expect(resolveSection({ section: 'onboarding' })).toBe('path');
    expect(resolveSection({ section: 'tiers' })).toBe('members');
    expect(resolveSection({ memberId: 'm1' })).toBe('members');
    expect(resolveSection({ courseId: 'c1' })).toBe('courses');
    expect(resolveSection({ section: 'nope' })).toBe('overview');
    expect(resolveSection(undefined)).toBe('overview');
  });
});

describe('errors + formatting', () => {
  test('missing-method and not-configured detection', () => {
    expect(isMissingMethod(new Error('unknown method: vault.analytics.get'))).toBe(true);
    expect(isMissingMethod(new Error('Member not found'))).toBe(false);
    expect(isNotConfigured({ code: 'NOT_CONFIGURED', message: 'x' })).toBe(true);
    expect(isNotConfigured(new Error('Discord not configured'))).toBe(true);
  });
  test('timeAgo buckets and bad input', () => {
    expect(timeAgo(NOW - 30 * 1000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 5 * 60000, NOW)).toBe('5m ago');
    expect(timeAgo(new Date(NOW - 3 * 3600000).toISOString(), NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 2 * 86400000, NOW)).toBe('2d ago');
    expect(timeAgo(null, NOW)).toBe('-');
    expect(timeAgo('garbage', NOW)).toBe('-');
  });
  test('numbers, percents, initials, online window', () => {
    expect(formatNumber(950)).toBe('950');
    expect(formatNumber(1530)).toBe('1.5K');
    expect(formatNumber(2400000)).toBe('2.4M');
    expect(formatNumber('x')).toBe('0');
    expect(formatPercent(42.4)).toBe('42%');
    expect(initials('kingly vault')).toBe('KV');
    expect(initials('ash')).toBe('AS');
    expect(isOnline(NOW - 5 * 60000, NOW)).toBe(true);
    expect(isOnline(NOW - 60 * 60000, NOW)).toBe(false);
    expect(isOnline(undefined, NOW)).toBe(false);
  });
});

describe('members', () => {
  const storeMember = {
    id: '123456789',
    discordId: '123456789',
    discordUsername: 'ash',
    discordAvatar: 'abc',
    tier: 'premium',
    status: 'active',
    joinedAt: '2026-09-01T00:00:00Z',
    lastActiveAt: '2026-10-14T11:58:00Z',
    roles: ['r1', 'r2'],
    warnings: [{ id: 'w1' }, { id: 'w2' }],
    completedCourses: 3,
    totalProgress: 64,
  };

  test('normalizeMember maps the store shape (discordUsername / warnings[] / lastActiveAt)', () => {
    const m = normalizeMember(storeMember);
    expect(m.username).toBe('ash');
    expect(m.avatar).toBe('https://cdn.discordapp.com/avatars/123456789/abc.png?size=128');
    expect(m.warningCount).toBe(2);
    expect(m.coursesCompleted).toBe(3);
    expect(m.engagementScore).toBe(64);
    expect(m.lastActive).toBe('2026-10-14T11:58:00Z');
    expect(m.tier).toBe('premium');
  });

  test('normalizeMember keeps the legacy web shape too', () => {
    const m = normalizeMember({ id: 'x', username: 'neo', warningCount: 4, engagementScore: 10, avatar: 'https://a/b.png' });
    expect(m.username).toBe('neo');
    expect(m.warningCount).toBe(4);
    expect(m.avatar).toBe('https://a/b.png');
    expect(m.tier).toBe('free');
  });

  test('memberQuery routes search to vault.members.search, filters to .list with paging', () => {
    expect(memberQuery({ ...DEFAULT_MEMBER_FILTERS, search: ' ash ' })).toEqual({
      method: 'vault.members.search', params: { query: 'ash', limit: 200 },
    });
    expect(memberQuery({ ...DEFAULT_MEMBER_FILTERS, tier: 'vip', status: 'banned' }, 2, 50)).toEqual({
      method: 'vault.members.list', params: { limit: 50, offset: 100, tier: 'vip', status: 'banned' },
    });
  });

  test('applyMemberFilters: search, tier, status, warnings, sort', () => {
    const list = [
      normalizeMember({ id: 'a', discordUsername: 'zed', tier: 'vip', joinedAt: '2026-01-01', warnings: [1] }),
      normalizeMember({ id: 'b', discordUsername: 'amy', tier: 'free', joinedAt: '2026-05-01' }),
      normalizeMember({ id: 'c', discordUsername: 'max', tier: 'vip', status: 'banned', joinedAt: '2026-03-01' }),
    ];
    expect(applyMemberFilters(list, DEFAULT_MEMBER_FILTERS).map((m) => m.id)).toEqual(['b', 'c', 'a']);
    expect(applyMemberFilters(list, { ...DEFAULT_MEMBER_FILTERS, sortBy: 'username' }).map((m) => m.id)).toEqual(['b', 'c', 'a']);
    expect(applyMemberFilters(list, { ...DEFAULT_MEMBER_FILTERS, tier: 'vip' }).map((m) => m.id)).toEqual(['c', 'a']);
    expect(applyMemberFilters(list, { ...DEFAULT_MEMBER_FILTERS, hasWarnings: true }).map((m) => m.id)).toEqual(['a']);
    expect(applyMemberFilters(list, { ...DEFAULT_MEMBER_FILTERS, search: 'MA' }).map((m) => m.id)).toEqual(['c']);
    expect(applyMemberFilters(list, { ...DEFAULT_MEMBER_FILTERS, status: 'banned' }).map((m) => m.id)).toEqual(['c']);
    expect(hasActiveMemberFilters(DEFAULT_MEMBER_FILTERS)).toBe(false);
    expect(hasActiveMemberFilters({ ...DEFAULT_MEMBER_FILTERS, hasWarnings: true })).toBe(true);
    expect(tierCounts(list)).toEqual({ vip: 2, free: 1 });
  });

  test('roleNames resolves ids against guild roles', () => {
    const r = roleNames(['1', '9'], [{ id: '1', name: 'VIP', color: 0xd4af37 }]);
    expect(r).toEqual([{ id: '1', name: 'VIP', color: '#d4af37' }, { id: '9', name: '9', color: null }]);
  });

  test('member create params trim and require an identity', () => {
    expect(canCreateMember({ tier: 'free' })).toBe(false);
    expect(canCreateMember({ email: ' a@b.co ' })).toBe(true);
    expect(buildMemberCreateParams({ discordId: ' 42 ', discordUsername: '', email: 'a@b.co', tier: 'vip' }))
      .toEqual({ tier: 'vip', discordId: '42', email: 'a@b.co' });
  });
});

describe('analytics + KPIs', () => {
  const live = {
    members: { total: 0, active: 0, new: 0, byTier: { free: 3, vip: 1 } },
    courses: { totalEnrollments: 5, completions: 2, averageProgress: 40, topCourses: [{ courseId: 'c1', name: 'AI Images', enrollments: 1 }] },
    engagement: { lessonsCompleted: 7 },
    moderation: { warnings: 1, timeouts: 0, kicks: 2, bans: 0 },
    totalMembers: 12,
    activeMembers: 6,
    newMembersThisWeek: 2,
    newMembersThisMonth: 4,
    totalCourses: 7,
    activeWarnings: 1,
    totalWarnings: 3,
    topCourses: [{ id: 'c1', title: 'AI Images', enrollments: 1 }],
    recentActivity: [{ id: 'e1', type: 'member_join', description: 'joined', timestamp: '2026-10-14T10:00:00Z' }],
  };

  test('normalizeAnalytics flattens both the nested and the flat fields', () => {
    const a = normalizeAnalytics(live);
    expect(a.totalMembers).toBe(12);
    expect(a.newThisMonth).toBe(4);
    expect(a.enrollments).toBe(5);
    expect(a.completions).toBe(2);
    expect(a.lessonsCompleted).toBe(7);
    expect(a.moderation.kicks).toBe(2);
    expect(a.byTier).toEqual([{ tier: 'free', count: 3 }, { tier: 'vip', count: 1 }]);
    expect(a.topCourses[0]).toMatchObject({ id: 'c1', title: 'AI Images', enrollments: 1 });
    expect(a.recentActivity[0].text).toBe('joined');
    expect(normalizeAnalytics(null)).toBeNull();
  });

  test('nested-only analytics still produce totals (fallback chain)', () => {
    const a = normalizeAnalytics({ members: { total: 9, active: 3, new: 1 }, courses: { topCourses: [{ courseId: 'x', name: 'N', enrollments: 2 }] } });
    expect(a.totalMembers).toBe(9);
    expect(a.activeMembers).toBe(3);
    expect(a.topCourses[0]).toMatchObject({ id: 'x', title: 'N' });
  });

  test('buildKpis falls back to Discord counts when the store is empty', () => {
    const guild = normalizeGuild({ id: 'g', name: 'Vault', memberCount: 300, onlineCount: 30 }, [{ id: 'r' }], [{ id: 'c', type: 0 }, { id: 'v', type: 2 }]);
    const k = buildKpis(normalizeAnalytics({ totalCourses: 7 }), guild);
    expect(k.map((x) => x.section)).toEqual(['members', 'members', 'discord', 'discord', 'courses', 'moderation']);
    expect(k[0].value).toBe('300');
    expect(k[1].footnote).toBe('10% of members');
    expect(k[2].value).toBe('2');
    expect(k[4].value).toBe('7');
  });

  test('mergeActivity puts newest messages first and caps at 20', () => {
    const msgs = Array.from({ length: 18 }, (_, i) => ({ id: `m${i}`, type: 'message', content: `hi ${i}`, timestamp: new Date(NOW - i * 1000).toISOString() }));
    const merged = mergeActivity(msgs.reverse(), [{ id: 'old', text: 'x' }, { id: 'old2' }, { id: 'old3' }, { id: 'old4' }, { id: 'old5' }, { id: 'old6' }]);
    expect(merged).toHaveLength(20);
    expect(merged[0].id).toBe('m0');
    expect(merged[0].text).toBe('hi 0');
    expect(merged[15].id).toBe('old');
  });
});

describe('discord', () => {
  test('roles sorted by position without @everyone; colours as hex', () => {
    const roles = sortRoles([{ name: '@everyone', position: 0 }, { name: 'A', position: 1 }, { name: 'B', position: 5 }]);
    expect(roles.map((r) => r.name)).toEqual(['B', 'A']);
    expect(roleColorHex(0)).toBeNull();
    expect(roleColorHex(255)).toBe('#0000ff');
  });

  test('channels grouped by category with loose channels first', () => {
    const ch = [
      { id: 'cat2', name: 'Voice', type: 4, position: 2 },
      { id: 'cat1', name: 'Text', type: 4, position: 1 },
      { id: 'g', name: 'general', type: 0, parentId: 'cat1', position: 2 },
      { id: 'a', name: 'announce', type: 5, parentId: 'cat1', position: 1 },
      { id: 'v', name: 'lounge', type: 2, parentId: 'cat2', position: 1 },
      { id: 'r', name: 'rules', type: 0, position: 0 },
    ];
    const groups = groupChannels(ch);
    expect(groups.map((g) => g.name)).toEqual([null, 'Text', 'Voice']);
    expect(groups[1].channels.map((c) => c.id)).toEqual(['a', 'g']);
    expect(textChannels(ch).map((c) => c.id)).toEqual(['g', 'a', 'r']);
    expect(channelCounts(ch)).toEqual({ text: 2, voice: 1, total: 4 });
  });

  test('normalizeGuild builds the icon url and tolerates nulls', () => {
    expect(normalizeGuild(null)).toBeNull();
    const g = normalizeGuild({ id: '1', name: 'V', icon: 'h' });
    expect(g.iconUrl).toBe('https://cdn.discordapp.com/icons/1/h.png?size=128');
    expect(g.roles).toEqual([]);
  });
});

describe('courses', () => {
  const live = {
    id: 'c1', name: 'Automations', slug: 'automations', description: 'Build flows', status: 'draft', accessLevel: 'premium',
    enrolledCount: 4, completionRate: 12.6, thumbnailUrl: 'https://img/x.png',
    modules: [
      { id: 'm2', courseId: 'c1', name: 'Second', order: 1, lessons: [] },
      { id: 'm1', courseId: 'c1', name: 'First', order: 0, lessons: [
        { id: 'l2', moduleId: 'm1', name: 'Watch', order: 1, type: 'video', content: { type: 'video', url: 'https://youtu.be/x', markdown: 'notes' }, durationMinutes: 9 },
        { id: 'l1', moduleId: 'm1', name: 'Read', order: 0, contentType: 'text', content: { type: 'text', markdown: '# hi' } },
      ] },
    ],
  };

  test('normalizeCourse maps the store shape and orders modules/lessons', () => {
    const c = normalizeCourse(live);
    expect(c.title).toBe('Automations');
    expect(c.tier).toBe('premium');
    expect(c.coverImage).toBe('https://img/x.png');
    expect(c.enrollmentCount).toBe(4);
    expect(c.completionRate).toBe(13);
    expect(c.modules.map((m) => m.title)).toEqual(['First', 'Second']);
    expect(c.modules[0].lessons.map((l) => l.title)).toEqual(['Read', 'Watch']);
    expect(c.modules[0].lessons[1]).toMatchObject({ contentType: 'video', videoUrl: 'https://youtu.be/x', content: 'notes', duration: 9 });
    expect(c.lessonCount).toBe(2);
  });

  test('stats + filter', () => {
    const list = [normalizeCourse(live), normalizeCourse({ id: 'c2', name: 'Crypto', status: 'published', enrolledCount: 3 }), normalizeCourse({ id: 'c3', name: 'Old', status: 'archived' })];
    expect(courseStats(list)).toEqual({ total: 3, published: 1, draft: 1, archived: 1, enrollments: 7 });
    expect(filterCourses(list, { status: 'published' }).map((c) => c.id)).toEqual(['c2']);
    expect(filterCourses(list, { search: 'flows' }).map((c) => c.id)).toEqual(['c1']);
  });

  test('course params use the gateway vocabulary (requiredTier / thumbnailUrl / courseId)', () => {
    expect(buildCourseParams({ title: ' New ', description: 'd', tier: 'vip', coverImage: '' }))
      .toEqual({ title: 'New', description: 'd', requiredTier: 'vip' });
    expect(buildCourseParams({ title: 'T', description: '', tier: 'free', coverImage: 'https://c' }, 'c1'))
      .toEqual({ title: 'T', description: '', requiredTier: 'free', courseId: 'c1', thumbnailUrl: 'https://c' });
  });

  test('module + lesson params carry the ids the handlers require', () => {
    expect(buildModuleCreate('c1', ' Intro ', 2)).toEqual({ courseId: 'c1', name: 'Intro', order: 2 });
    expect(buildModuleUpdate({ id: 'm1', courseId: 'c1', title: 'Old', description: '' }, { title: 'New', description: 'x' }))
      .toEqual({ moduleId: 'm1', courseId: 'c1', name: 'New', description: 'x' });
    expect(buildLessonCreate('m1', 'L', 0)).toEqual({ moduleId: 'm1', name: 'L', type: 'text', content: { type: 'text', markdown: '' }, order: 0 });
    const lesson = normalizeCourse(live).modules[0].lessons[0];
    expect(buildLessonUpdate(lesson, { title: 'Read 2', contentType: 'video', content: 'body', videoUrl: 'https://vimeo.com/1', duration: '12' })).toEqual({
      lessonId: 'l1', moduleId: 'm1', name: 'Read 2', type: 'video', duration: 12,
      content: { type: 'video', url: 'https://vimeo.com/1', provider: 'vimeo', videoUrl: 'https://vimeo.com/1', markdown: 'body' },
    });
    expect(buildLessonContent('quiz', { content: 'q' })).toEqual({ type: 'quiz', markdown: 'q' });
    expect(videoProvider('https://www.youtube.com/watch?v=1')).toBe('youtube');
    expect(videoProvider('https://x.com/v.mp4')).toBe('custom');
  });

  test('unwrap pulls the entity out of a create response', () => {
    expect(unwrap({ module: { id: 'm' } }, 'module')).toEqual({ id: 'm' });
    expect(unwrap({ id: 'bare' }, 'lesson')).toEqual({ id: 'bare' });
    expect(unwrap(null, 'lesson')).toBeNull();
  });
});

describe('moderation + rules', () => {
  test('mod log store shape normalises and counts', () => {
    const logs = [
      { id: '1', action: 'warn', targetMemberId: 'm1', performedBy: 'admin', reason: 'spam', timestamp: 't', autoAction: true },
      { id: '2', action: 'ban', targetMemberId: 'm2', reason: 'x' },
      { id: '3', action: 'timeout', targetMemberId: 'm3' },
    ].map(normalizeModLog);
    expect(logs[0]).toMatchObject({ memberId: 'm1', moderator: 'admin', auto: true });
    expect(logs[1].moderator).toBe('System');
    expect(moderationCounts(logs)).toEqual({ total: 3, warnings: 1, timeouts: 1, bans: 1 });
  });

  test('rules: normalise, build create + update params', () => {
    const r = normalizeRule({ id: 'r1', name: 'Welcome', enabled: false, trigger: { type: 'course_complete', courseId: 'c1' }, lastTriggeredAt: 5, triggerCount: 2 });
    expect(r).toMatchObject({ triggerType: 'course_complete', enabled: false, lastTriggered: 5 });
    expect(buildRuleParams({ name: ' New ', description: '', triggerType: 'member_join' })).toEqual({
      name: 'New', description: '', enabled: true, trigger: { type: 'member_join' }, conditions: [], actions: [],
    });
    // Same trigger type keeps its config; update never resets conditions/actions.
    expect(buildRuleParams({ name: 'W', triggerType: 'course_complete', enabled: false }, r)).toEqual({
      id: 'r1', name: 'W', description: '', enabled: false, trigger: { type: 'course_complete', courseId: 'c1' },
    });
    expect(buildRuleParams({ name: 'W', triggerType: 'member_leave' }, r).trigger).toEqual({ type: 'member_leave' });
  });
});

describe('setup + config', () => {
  test('config round-trips into a nested vault.config.update patch', () => {
    const f = configForm({ modLogChannelId: 'c9', ashAutonomy: { level: 2, requireApproval: ['ban'] }, tierRoles: { vip: 'r1' } });
    expect(f).toMatchObject({ modLogChannelId: 'c9', autonomyLevel: 2, requireApproval: ['ban'], autoModEnabled: true });
    const patch = buildConfigPatch({ ...f, requireApproval: toggleIn(f.requireApproval, 'kick') });
    expect(patch.config.ashAutonomy).toEqual({ level: 2, requireApproval: ['ban', 'kick'] });
    expect(patch.config.tierRoles).toEqual({ vip: 'r1' });
    expect(patch.config.welcomeChannelId).toBeUndefined();
    expect(configForm(null).autonomyLevel).toBe(3);
  });

  test('setup status counts completed steps', () => {
    const s = normalizeSetup({ completed: false, steps: [{ id: 'discord', required: true, completed: false }, { id: 'courses', completed: true }] });
    expect(s.doneCount).toBe(1);
    expect(s.steps[0].title).toBe('Discord');
  });

  test('toggleIn adds and removes', () => {
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('learning path', () => {
  test('step gates mirror the web wizard + gateway guard', () => {
    const a = emptyAnswers();
    expect(canAdvancePath(0, a)).toBe(true);
    expect(canAdvancePath(1, a)).toBe(false);
    expect(canGeneratePath(a)).toBe(false);
    expect(canGeneratePath({ ...a, wantToLearn: ' funnels ' })).toBe(true);
    expect(canAdvancePath(1, { ...a, interests: ['Automation'] })).toBe(true);
  });

  test('params clamp hours and default the member to current', () => {
    expect(buildLearningPathParams({ interests: ['AI'], goals: [], skillLevel: 'advanced', hoursPerWeek: '200', wantToLearn: ' x ' })).toEqual({
      memberId: 'current', interests: ['AI'], goals: [], skillLevel: 'advanced', hoursPerWeek: 80, wantToLearn: 'x',
    });
    expect(buildLearningPathParams({ ...emptyAnswers(), hoursPerWeek: 'nope' }, 'm1').hoursPerWeek).toBe(5);
  });

  test('normalizeLearningPath accepts {learningPath} or the bare object', () => {
    const lp = { id: 'p', summary: 'S', totalWeeks: 2, totalCourses: 3, answers: { hoursPerWeek: 5 }, weeks: [{ week: 1, focus: 'F', courses: [{ courseId: 'c1', name: 'AI', reason: 'r', order: 0 }] }] };
    expect(normalizeLearningPath({ learningPath: lp }).weeks[0].courses[0]).toEqual({ id: 'c1', name: 'AI', reason: 'r' });
    expect(normalizeLearningPath(lp).hoursPerWeek).toBe(5);
    expect(normalizeLearningPath({ learningPath: null })).toBeNull();
  });
});
