import {
  parseLearnParams, normalizeCatalog, availableTracks, listEnvFor, isListable, trackStatus, computeBadges,
  computeCertLadder, recommendTracks, buildCatalogView, heroStats, missionItems, applyLocalEvent, mergeProgress,
  progressUpdateParams, walkthroughRow, walkthroughSteps, stepParity, describeAction, nextWalkthrough, trackCta,
  quizAllAnswered, quizHeader, quizResultLine, setAnswer, certView, prepareCertSvg, certFileName, classicTabs,
  isAdminFromMe, classicMyTracks, classicLibrary, classicStepper, stepCtaTarget, classicEligibilityPill,
  parseAuthorDraft, authorDraftFor, newTrackTemplate, isUnknownMethod, monogramText, trackMinutes, webTourPath,
  deepLinkFor, matchesQuery, badgeCaption, prerequisiteTracks,
} from '../screens/learn/learn-model';

const step = (id, extra = {}) => ({ id, title: `Step ${id}`, body: `Body ${id}`, ...extra });
const wt = (id, steps, extra = {}) => ({ id, title: `WT ${id}`, summary: `sum ${id}`, estMinutes: 2, steps, ...extra });

function rawCatalog() {
  return {
    tracks: [
      {
        id: 'getting-started', title: 'Getting started', summary: 'Find your way', overview: '**Hi**', category: 'Basics',
        level: 'beginner', certRequired: true, signals: ['dashboard'], order: 1,
        walkthroughs: [
          wt('tour', [step('a'), step('b', { route: '/', target: '.topbar' }), step('c', { target: '.x', action: { kind: 'click' } })]),
          wt('find', [step('x', { action: { kind: 'input', match: 'proj' } }), step('y', { check: { kind: 'route', path: '/projects' }, checkHint: 'Waiting…' })]),
        ],
        quiz: [{ id: 'q1', prompt: 'P?', options: ['a', 'b'] }],
        badge: { id: 'oriented', label: 'Oriented', icon: 'X' },
      },
      {
        id: 'agents', title: 'Agents', summary: 'Team', overview: '', category: 'Agents', level: 'intermediate',
        certRequired: true, prerequisites: ['getting-started'], signals: ['agents'], order: 5,
        walkthroughs: [wt('roster', [step('r1', { practice: { mode: 'explain', note: 'never sends' } })])],
        quiz: [], badge: { id: 'lead', label: 'Team lead' },
      },
      {
        id: 'robovoice', title: 'Robovoice', summary: 'Voice', overview: '', category: 'Voice', level: 'intermediate',
        pluginId: 'robovoice', estMinutes: 14,
        walkthroughs: [wt('calls', [step('c1')]), wt('bonus', [step('b1')], { requires: { kind: 'surface', surface: 'x' } })],
        quiz: [], badge: { id: 'rv', label: 'Robovoice mastery' },
      },
      {
        id: 'hidden', title: 'Hidden plugin', summary: '', overview: '', category: 'X', level: 'beginner', pluginId: 'off',
        requires: { kind: 'pluginEnabled', plugin: 'off' },
        walkthroughs: [wt('w', [step('s')])], quiz: [], badge: { id: 'h', label: 'H' },
      },
    ],
    plugins: [{ id: 'robovoice', name: 'Robovoice', monogram: 'RV', trackIds: ['robovoice'] }],
    missions: [{ walkthrough: 'getting-started/tour', starter: true }, { walkthrough: 'agents/roster', starter: true }, { walkthrough: 'robovoice/calls' }],
    progress: {
      userId: '_owner',
      walkthroughs: { 'getting-started/tour': { status: 'completed', stepId: null, completedSteps: ['a', 'b', 'c'], updatedAt: 1, completedAt: 1 } },
      quizzes: {},
      prefs: {},
      session: null,
    },
  };
}

describe('route params', () => {
  test('native params', () => {
    expect(parseLearnParams({ trackId: 'agents', walkthrough: 'roster' })).toEqual({ trackId: 'agents', walkthrough: 'roster' });
    expect(parseLearnParams(undefined)).toEqual({ trackId: null, walkthrough: null });
    expect(parseLearnParams({ walkthrough: 'x' })).toEqual({ trackId: null, walkthrough: null });
  });
  test('web path forms', () => {
    expect(parseLearnParams({ path: '/learn/agents?walkthrough=roster' })).toEqual({ trackId: 'agents', walkthrough: 'roster' });
    expect(parseLearnParams({ path: 'learn/agents/roster' })).toEqual({ trackId: 'agents', walkthrough: 'roster' });
    expect(parseLearnParams({ path: '/learn' })).toEqual({ trackId: null, walkthrough: null });
  });
  test('links', () => {
    expect(webTourPath('agents', 'roster')).toBe('/learn/agents?walkthrough=roster');
    expect(webTourPath('agents')).toBe('/learn/agents');
    expect(deepLinkFor('agents')).toBe('infinibot://learn/agents');
    expect(deepLinkFor('agents', 'roster')).toBe('infinibot://learn/agents/roster');
  });
});

describe('catalog', () => {
  const cat = normalizeCatalog(rawCatalog());
  const tracks = availableTracks(cat);

  test('requires guards: disabled plugin tracks hidden; surface walkthrough listed', () => {
    expect(tracks.map((t) => t.id)).toEqual(['getting-started', 'agents', 'robovoice']);
    expect(tracks.find((t) => t.id === 'robovoice').walkthroughs).toHaveLength(2);
    const env = listEnvFor(cat);
    expect(isListable({ kind: 'not', condition: { kind: 'pluginEnabled', plugin: 'robovoice' } }, env)).toBe(false);
    expect(isListable({ kind: 'any', conditions: [{ kind: 'pluginEnabled', plugin: 'off' }, { kind: 'route', path: '/' }] }, env)).toBe(true);
  });

  test('normalizeCatalog tolerates junk', () => {
    const c = normalizeCatalog({ tracks: [null, { id: 'z' }] });
    expect(c.tracks).toHaveLength(1);
    expect(c.tracks[0]).toMatchObject({ title: 'z', level: 'beginner', walkthroughs: [], quiz: [] });
    expect(c.progress.walkthroughs).toEqual({});
    expect(normalizeCatalog(null).tracks).toEqual([]);
  });

  test('trackStatus counts quiz + ignores bonus walkthroughs', () => {
    const gs = trackStatus(tracks[0], cat.progress);
    expect(gs).toMatchObject({ walkthroughsDone: 1, walkthroughsTotal: 2, quizPassed: false, percent: 33, completed: false });
    expect(trackStatus(tracks[2], cat.progress).walkthroughsTotal).toBe(1);
  });

  test('badges, ladder and recommendations', () => {
    const progress = {
      ...cat.progress,
      walkthroughs: { ...cat.progress.walkthroughs, 'getting-started/find': { status: 'completed' }, 'robovoice/calls': { status: 'completed' } },
      quizzes: { 'getting-started': { score: 1, total: 1, passed: true } },
    };
    const badges = computeBadges(tracks, progress);
    expect(badges.map((b) => b.trackId)).toEqual(['getting-started', 'robovoice']);
    expect(badges[1].mastery).toBe(true);
    const ladder = computeCertLadder(tracks, progress);
    expect(ladder[0]).toMatchObject({ tier: 'apprentice', required: ['getting-started'], eligible: true, percent: 100 });
    expect(ladder[1]).toMatchObject({ tier: 'practitioner', missing: ['agents'], eligible: false });
    expect(ladder[2]).toMatchObject({ needsPluginMastery: true, hasPluginMastery: true });
    // in-progress getting-started first
    expect(recommendTracks(tracks, cat.progress, [], 3)[0]).toBe('getting-started');
  });

  test('catalog view: filters, search, plugin groups, reco, empty text', () => {
    const v = buildCatalogView(tracks, cat, {});
    expect(v.core.map((t) => t.id)).toEqual(['getting-started', 'agents']);
    expect(v.pluginGroups).toEqual([expect.objectContaining({ pluginId: 'robovoice', name: 'Robovoice' })]);
    expect(v.reco.length).toBeGreaterThan(0);
    expect(v.searching).toBe(false);
    const p = buildCatalogView(tracks, cat, { filter: 'plugins' });
    expect(p.core).toEqual([]);
    expect(p.reco).toEqual([]);
    expect(buildCatalogView(tracks, cat, { filter: 'progress' }).visible.map((t) => t.id)).toEqual(['getting-started']);
    expect(buildCatalogView(tracks, cat, { filter: 'done' }).emptyText).toMatch(/another filter/);
    expect(buildCatalogView(tracks, cat, { query: 'zzz' }).emptyText).toMatch(/No tracks match "zzz"/);
    expect(buildCatalogView(tracks, cat, { query: 'robovoice calls' }).visible.map((t) => t.id)).toEqual(['robovoice']);
    expect(matchesQuery(tracks[2], 'robovoice', cat.plugins[0])).toBe(true);
  });

  test('hero stats + missions', () => {
    const s = heroStats(tracks, cat.progress);
    expect(s).toMatchObject({ tracksDone: 0, tracksTotal: 3, walkthroughsDone: 1, walkthroughsTotal: 4, badges: 0, tierLabel: '—' });
    expect(s.inProgress.id).toBe('getting-started');
    const m = missionItems(tracks, cat);
    expect(m.items.map((i) => [i.walkthrough.id, i.done])).toEqual([['tour', true], ['roster', false]]);
    expect(m.subtitle).toBe('1 of 2 left — a few minutes each');
    expect(missionItems(tracks, { ...cat, progress: { ...cat.progress, prefs: { missionsDismissed: true } } })).toBeNull();
  });

  test('misc helpers', () => {
    expect(trackMinutes(tracks[0])).toBe(4);
    expect(trackMinutes(tracks[2])).toBe(14);
    expect(monogramText(cat.plugins[0], 'robovoice')).toBe('RV');
    expect(monogramText({ name: 'Business & Agency' }, 'x')).toBe('BA');
    expect(trackCta({ completed: false, percent: 0 })).toBe('Start track');
    expect(trackCta({ completed: false, percent: 20 })).toBe('Continue');
    expect(trackCta({ completed: true, percent: 100 })).toBe('Replay');
    expect(badgeCaption(tracks[0], { completed: false })).toBe('Finish 2 walkthroughs + the check');
    expect(prerequisiteTracks(tracks[1], tracks).map((t) => t.id)).toEqual(['getting-started']);
    expect(isUnknownMethod(new Error('unknown method: learn.guided.catalog'))).toBe(true);
    expect(isUnknownMethod(new Error('boom'))).toBe(false);
  });
});

describe('walkthroughs + progress writes', () => {
  const cat = normalizeCatalog(rawCatalog());
  const [gs, agents] = availableTracks(cat);

  test('row + steps view with web-only parity notes', () => {
    const row = walkthroughRow(gs, gs.walkthroughs[0], cat.progress);
    expect(row).toMatchObject({ done: true, ctaLabel: 'Replay', canReset: true });
    expect(walkthroughRow(agents, agents.walkthroughs[0], cat.progress)).toMatchObject({ risky: true, ctaLabel: 'Start', canReset: false });
    const steps = walkthroughSteps(gs, gs.walkthroughs[1], cat.progress);
    expect(steps[0]).toMatchObject({ current: true, done: false, webOnly: true });
    expect(steps[0].note).toMatch(/type something containing "proj"/);
    expect(steps[1].note).toMatch(/checks: Waiting/);
    expect(stepParity(step('plain'))).toEqual({ webOnly: false, note: null, parityNote: null });
    expect(stepParity(step('r', { route: '/goals' })).note).toBe('On the web this step opens /goals.');
    expect(describeAction({ kind: 'navigate', path: '/x' })).toBe('open /x');
  });

  test('nextWalkthrough picks in-progress, then first unfinished', () => {
    expect(nextWalkthrough(gs, cat.progress).id).toBe('find');
    const p = applyLocalEvent(cat.progress, gs, 'find', 'complete');
    expect(nextWalkthrough(gs, p).id).toBe('tour');
  });

  test('applyLocalEvent step/complete/reset', () => {
    let p = applyLocalEvent(cat.progress, gs, 'find', 'step', 'x', true, 5);
    expect(p.walkthroughs['getting-started/find']).toEqual({ status: 'in_progress', stepId: 'x', completedSteps: ['x'], updatedAt: 5, completedAt: null });
    p = applyLocalEvent(p, gs, 'find', 'step', 'y', false, 6);
    expect(p.walkthroughs['getting-started/find']).toMatchObject({ stepId: 'y', completedSteps: ['x'] });
    expect(walkthroughSteps(gs, gs.walkthroughs[1], p)[1].current).toBe(true);
    p = applyLocalEvent(p, gs, 'find', 'complete', null, null, 7);
    expect(p.walkthroughs['getting-started/find']).toMatchObject({ status: 'completed', completedSteps: ['x', 'y'], completedAt: 7 });
    p = applyLocalEvent(p, gs, 'find', 'reset');
    expect(p.walkthroughs['getting-started/find']).toBeUndefined();
    expect(cat.progress.walkthroughs['getting-started/find']).toBeUndefined(); // no mutation
  });

  test('gateway params + merge', () => {
    expect(progressUpdateParams('t', 'w', 'step', 's', true)).toEqual({ trackId: 't', walkthroughId: 'w', event: 'step', stepId: 's', done: true });
    expect(progressUpdateParams('t', 'w', 'complete')).toEqual({ trackId: 't', walkthroughId: 'w', event: 'complete' });
    const cur = { ...cat.progress, session: { trackId: 'a' } };
    expect(mergeProgress(cur, null)).toBe(cur);
    expect(mergeProgress(cur, { progress: { walkthroughs: { k: {} } } })).toMatchObject({ walkthroughs: { k: {} }, session: { trackId: 'a' } });
  });

  test('quiz helpers', () => {
    expect(quizAllAnswered(gs, [])).toBe(false);
    expect(quizAllAnswered(gs, setAnswer([], 0, 1))).toBe(true);
    expect(quizHeader(gs, null)).toBe('1 questions · 70% to pass');
    expect(quizHeader(gs, { score: 1, total: 1, passed: true })).toBe('Best: 1/1 · passed');
    expect(quizResultLine({ score: 0, total: 1, passed: false })).toBe('0/1 — 70% needed, try again');
  });
});

describe('certification', () => {
  test('certView: rung items + view gate', () => {
    const cat = normalizeCatalog(rawCatalog());
    const tracks = availableTracks(cat);
    const v = certView(tracks, cat.progress, 'gateway');
    expect(v.rungs.map((r) => r.title)).toEqual(['Apprentice', 'Practitioner', 'Master']);
    expect(v.rungs[2].items.at(-1)).toMatchObject({ id: '_mastery', trackId: null });
    expect(v.rungs.every((r) => r.canView === false)).toBe(true);
    expect(v.mastery.map((m) => [m.track.id, m.earned])).toEqual([['robovoice', false]]);
  });

  test('prepareCertSvg scales + simplifies fonts', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" width="1200" height="850" font-family="ui-serif, Georgia, 'Times New Roman', serif"><!-- c --><text font-family="ui-monospace, monospace">x</text></svg>`;
    const out = prepareCertSvg(svg);
    expect(out).not.toMatch(/width="1200"/);
    expect(out).not.toMatch(/height="850"/);
    expect(out).toMatch(/viewBox="0 0 1200 850"/);
    expect(out).toMatch(/<svg[^>]*font-family="serif"/);
    expect(out).toMatch(/<text font-family="monospace"/);
    expect(out).not.toMatch(/<!--/);
    expect(prepareCertSvg('')).toBeNull();
    expect(certFileName('master', 'Jane Doe!')).toBe('infinibot-master-Jane_Doe_.svg');
  });
});

describe('classic & admin', () => {
  const classic = [
    { id: 'b', title: 'B', category: 'Chat', percent: 100, order: 1, progress: { completedSteps: [] } },
    { id: 'a', title: 'A', category: 'Chat', percent: 20, order: 2, progress: { completedSteps: [] } },
    { id: 'c', title: 'C', percent: 0, order: 3, progress: null, steps: [{ id: 's1' }] },
  ];
  test('tabs + admin detection', () => {
    expect(classicTabs(false).map((t) => t.key)).toEqual(['my-tracks', 'library', 'certification']);
    expect(classicTabs(true)).toHaveLength(5);
    expect(isAdminFromMe({ user: null, implicitAdmin: true })).toBe(true);
    expect(isAdminFromMe({ user: { role: 'admin' } })).toBe(true);
    expect(isAdminFromMe({ user: { role: 'user' } })).toBe(false);
    expect(isAdminFromMe(null)).toBe(false);
  });
  test('my tracks + library', () => {
    expect(classicMyTracks(classic).map((t) => t.id)).toEqual(['a', 'b']);
    expect(classicLibrary(classic)).toEqual([
      { category: 'Chat', tracks: [classic[0], classic[1]] },
      { category: 'General', tracks: [classic[2]] },
    ]);
  });
  test('stepper', () => {
    const track = { id: 't', steps: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two', estMinutes: 2 }] };
    const v0 = classicStepper(track, null, null);
    expect(v0).toMatchObject({ idx: 0, isFirst: true, isLast: false, prevId: null, nextId: 's2', completeLabel: 'Mark complete', footer: 'Mark a step complete to start' });
    const v1 = classicStepper(track, { completedSteps: ['s1'] }, 's2');
    expect(v1).toMatchObject({ idx: 1, isLast: true, nextId: null, prevId: 's1', completeLabel: 'Finish', footer: '1/2 done' });
    expect(v1.rail[0]).toMatchObject({ done: true, active: false, n: 1 });
    expect(classicStepper(track, { completedSteps: ['s1', 's2'], completedAt: 9 }, 's2')).toMatchObject({ completeLabel: 'Re-mark complete', trackComplete: true, footer: 'Track complete' });
  });
  test('cta + eligibility pill', () => {
    expect(stepCtaTarget({ label: 'Open Chat', tab: 'chat' })).toEqual({ kind: 'web', path: '/chat', label: 'Open Chat' });
    expect(stepCtaTarget({ label: 'Docs', url: 'https://x.dev' })).toEqual({ kind: 'url', url: 'https://x.dev', label: 'Docs' });
    expect(stepCtaTarget(null)).toBeNull();
    expect(classicEligibilityPill({ awarded: true, percent: 100 }).label).toBe('Awarded');
    expect(classicEligibilityPill({ awarded: false, percent: 100 }).label).toBe('Ready to mint');
    expect(classicEligibilityPill({ awarded: false, percent: 40 }).label).toBe('40%');
  });
  test('author draft', () => {
    expect(parseAuthorDraft('{')).toMatchObject({ ok: false });
    expect(parseAuthorDraft('{"id":"x"}')).toEqual({ ok: false, error: 'Track JSON needs at least { id, steps[] }' });
    expect(parseAuthorDraft(JSON.stringify(newTrackTemplate()))).toMatchObject({ ok: true, track: { id: 'my-track' } });
    const d = JSON.parse(authorDraftFor({ id: 'x', steps: [], progress: {}, percent: 1, totalSteps: 0, completedCount: 0 }));
    expect(d).toEqual({ id: 'x', steps: [] });
  });
});
