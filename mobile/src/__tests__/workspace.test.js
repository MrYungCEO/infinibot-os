import {
  addTab,
  agentSessionKeyFor,
  appendSnippet,
  bindingFieldMap,
  closeTab,
  collapseContext,
  composeAgentMessage,
  deriveWorkspaceName,
  detectProjectMode,
  diffLines,
  diffTotals,
  fileIcon,
  flattenTree,
  frameworkLabel,
  gitStatusMeta,
  languageFor,
  matchLinkedRows,
  MAX_TABS,
  normalizeVersions,
  normalizeWorkflows,
  normalizeWorkspaces,
  parseSlides,
  parseUnifiedDiff,
  patchTab,
  pickableModels,
  pickerGroups,
  pickInitialWorkspace,
  previewTarget,
  pushRecent,
  quickActionsForMode,
  relativeToRoot,
  repairGitStatusFiles,
  runtimeLabel,
  runtimeTone,
  samePath,
  shouldAutoStartRuntime,
  statPaths,
  statusForLinked,
  summarizeGitStatus,
  templateEntryFile,
  templateWrites,
  tokenizeLine,
  viewLines,
} from '../screens/workspace/workspace-model';
import { COMPONENT_LIBRARY, TEMPLATE_LIBRARY, findTemplate } from '../screens/workspace/workspace-templates';

const WS = [
  { id: 'a', path: '/p/alpha', name: 'Alpha', icon: 'x', tags: ['t'] },
  { id: 'b', path: '/p/beta', name: 'Beta' },
  { id: 'c', path: '/p/gamma' },
];

describe('workspaces', () => {
  test('normalizes array or {entries}, drops bad rows, derives names', () => {
    expect(normalizeWorkspaces(WS).map((w) => w.name)).toEqual(['Alpha', 'Beta', 'gamma']);
    expect(normalizeWorkspaces({ entries: [WS[0], { id: 1 }] })).toHaveLength(1);
    expect(normalizeWorkspaces(null)).toEqual([]);
    expect(normalizeWorkspaces(WS)[0]).not.toHaveProperty('icon');
  });
  test('session key matches the web', () => {
    expect(agentSessionKeyFor('abc')).toBe('agent:coder:workspace-abc');
    expect(agentSessionKeyFor(null)).toBe('');
  });
  test('picker groups recents then the rest, filtered', () => {
    const list = normalizeWorkspaces(WS);
    const g = pickerGroups(list, ['b', 'zz'], '');
    expect(g.recents.map((w) => w.id)).toEqual(['b']);
    expect(g.rest.map((w) => w.id)).toEqual(['a', 'c']);
    expect(pickerGroups(list, ['b'], 'gam').rest.map((w) => w.id)).toEqual(['c']);
  });
  test('recents dedupe + cap', () => {
    expect(pushRecent(['a', 'b', 'c'], 'c', 3)).toEqual(['c', 'a', 'b']);
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
  test('initial pick: remembered else first', () => {
    const list = normalizeWorkspaces(WS);
    expect(pickInitialWorkspace(list, 'b').id).toBe('b');
    expect(pickInitialWorkspace(list, 'zz').id).toBe('a');
    expect(pickInitialWorkspace([], 'zz')).toBeNull();
  });
  test('auto name only while blank or auto-filled', () => {
    expect(deriveWorkspaceName('', '/x/proj', '')).toBe('proj');
    expect(deriveWorkspaceName('/x/pro', '/x/proj', 'pro')).toBe('proj');
    expect(deriveWorkspaceName('/x/pro', '/x/proj', 'Custom')).toBe('Custom');
  });
  test('paths', () => {
    expect(relativeToRoot('/p/a/src/x.ts', '/p/a/')).toBe('src/x.ts');
    expect(relativeToRoot('/p/b/x', '/p/a')).toBeNull();
    expect(relativeToRoot('C:\\p\\a\\x.html', 'C:\\p\\a')).toBe('x.html');
    expect(samePath('/a/b/', '/a/b')).toBe(true);
  });
});

describe('tree + tabs', () => {
  const tree = {
    path: '/r', isDirectory: true, children: [
      { name: 'z.txt', path: '/r/z.txt' },
      { name: 'src', path: '/r/src', isDirectory: true, children: [{ name: 'a.js', path: '/r/src/a.js' }] },
      { name: '.git', path: '/r/.git', isDirectory: true, children: [] },
    ],
  };
  test('folders first, collapsed unless expanded, .git hidden', () => {
    expect(flattenTree(tree, new Set()).map((r) => r.name)).toEqual(['src', 'z.txt']);
    const open = flattenTree(tree, new Set(['/r/src']));
    expect(open.map((r) => [r.name, r.depth])).toEqual([['src', 0], ['a.js', 1], ['z.txt', 0]]);
    expect(open[0].expanded).toBe(true);
  });
  test('icons + languages', () => {
    expect(fileIcon('x', true, true)).toBe('folder-open-outline');
    expect(fileIcon('a.png')).toBe('image-outline');
    expect(fileIcon('a.ts')).toBe('code-slash-outline');
    expect(languageFor('a.tsx')).toBe('js');
    expect(languageFor('README.md')).toBe('md');
    expect(languageFor('noext')).toBe('text');
  });
  test('tabs: add, FIFO trim, dirty tracking, close', () => {
    let tabs = [];
    for (let i = 0; i < MAX_TABS + 2; i += 1) tabs = addTab(tabs, `/f${i}`);
    expect(tabs).toHaveLength(MAX_TABS);
    expect(tabs[0].path).toBe('/f2');
    tabs = patchTab(tabs, '/f2', { content: 'x', original: 'x', loading: false });
    expect(tabs[0].dirty).toBe(false);
    tabs = patchTab(tabs, '/f2', { content: 'y' });
    expect(tabs[0].dirty).toBe(true);
    const r = closeTab(tabs, '/f2', '/f2');
    expect(r.active).toBe(`/f${MAX_TABS + 1}`);
    expect(appendSnippet('a', 'S')).toBe('a\n\nS\n');
    expect(appendSnippet('a\n', 'S')).toBe('a\n\nS\n');
  });
  test('viewLines caps very long files', () => {
    const v = viewLines(Array.from({ length: 5000 }, (_, i) => i).join('\n'));
    expect(v.truncated).toBe(true);
    expect(v.total).toBe(5000);
  });
});

describe('diffs', () => {
  test('LCS diff matches the web shape', () => {
    const d = diffLines('a\nb\nc', 'a\nx\nc\nd');
    expect(d.map((l) => `${l.kind[0]}${l.text}`)).toEqual(['ca', 'rb', 'ax', 'cc', 'ad']);
    expect(diffTotals(d)).toEqual({ add: 2, remove: 1 });
    expect(d[3]).toMatchObject({ oldNum: 3, newNum: 3 });
  });
  test('identical text has no changes', () => {
    expect(diffTotals(diffLines('a\nb', 'a\nb'))).toEqual({ add: 0, remove: 0 });
  });
  test('collapseContext keeps changes + context, marks skips', () => {
    const orig = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const mod = orig.replace('l10', 'L10');
    const rows = collapseContext(diffLines(orig, mod), 2);
    expect(rows[0]).toEqual({ kind: 'skip', count: 8 });
    expect(rows.filter((r) => r.kind === 'add')).toHaveLength(1);
    expect(rows[rows.length - 1]).toEqual({ kind: 'skip', count: 7 });
  });
  test('unified diff parsing with numbers + file totals', () => {
    const patch = [
      'diff --git a/src/App.tsx b/src/App.tsx',
      'index bc2821a..239047a 100644',
      '--- a/src/App.tsx',
      '+++ b/src/App.tsx',
      '@@ -10,3 +10,4 @@ export',
      ' keep',
      '-old',
      '+new',
      '+more',
    ].join('\n');
    const { rows, files } = parseUnifiedDiff(patch);
    expect(files).toEqual([{ path: 'src/App.tsx', add: 2, remove: 1, index: 0 }]);
    expect(rows.map((r) => r.kind)).toEqual(['file', 'meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'add']);
    expect(rows[5]).toMatchObject({ oldNum: 10, newNum: 10, text: 'keep' });
    expect(rows[7]).toMatchObject({ newNum: 11 });
    expect(parseUnifiedDiff('').rows).toEqual([]);
  });
});

describe('git status', () => {
  test('repairs the first entry the gateway trims', () => {
    const files = [{ status: 'M ', path: 'gitignore' }, { status: ' M', path: 'AGENTS.md' }];
    const fixed = repairGitStatusFiles(files, ['.gitignore', 'AGENTS.md']);
    expect(fixed[0]).toEqual({ status: ' M', path: '.gitignore' });
    expect(fixed[1]).toEqual(files[1]);
    // a genuinely staged first file is left alone when nothing matches
    expect(repairGitStatusFiles([{ status: 'M ', path: 'src/a.ts' }], ['src/a.ts'])[0].path).toBe('src/a.ts');
  });
  test('stat paths', () => {
    expect(statPaths(' src/App.tsx | 14 ++-\n b.md | 2 +\n 2 files changed')).toEqual(['src/App.tsx', 'b.md']);
  });
  test('status meta + summary', () => {
    expect(gitStatusMeta('??')).toMatchObject({ label: 'Untracked', tone: 'info' });
    expect(gitStatusMeta(' M')).toMatchObject({ label: 'Modified', staged: false });
    expect(gitStatusMeta('M ')).toMatchObject({ label: 'Modified', staged: true });
    expect(gitStatusMeta('A ')).toMatchObject({ label: 'Added', tone: 'success' });
    expect(gitStatusMeta('UU')).toMatchObject({ label: 'Conflict' });
    expect(summarizeGitStatus({ clean: true })).toBe('Working tree clean');
    expect(summarizeGitStatus({ staged: 1, unstaged: 2, untracked: 3 })).toBe('1 staged · 2 modified · 3 untracked');
  });
});

describe('runtime + preview', () => {
  test('labels and tones match the web pill', () => {
    expect(runtimeLabel('stopped')).toBe('Start');
    expect(runtimeLabel('installing')).toBe('Installing');
    expect(runtimeTone('error')).toBe('danger');
    expect(frameworkLabel({ kind: 'unknown' }, 'document')).toBe('document');
    expect(frameworkLabel({ kind: 'vite' }, 'web')).toBe('vite');
  });
  test('auto-start gate', () => {
    const base = { autoStart: true, explicitIds: ['a'], directoryId: 'a', detection: { kind: 'vite' }, server: null };
    expect(shouldAutoStartRuntime(base)).toBe(true);
    expect(shouldAutoStartRuntime({ ...base, explicitIds: [] })).toBe(false);
    expect(shouldAutoStartRuntime({ ...base, server: { status: 'ready' } })).toBe(false);
    expect(shouldAutoStartRuntime({ ...base, detection: { kind: 'vite', missingDependencies: true } })).toBe(false);
  });
  test('preview target priority', () => {
    const workspace = { id: 'w 1', path: '/p/site' };
    const htmlTab = { name: 'index.html', path: '/p/site/pages/index.html' };
    expect(previewTarget({ devUrl: 'http://x:1', workspace })).toEqual({ kind: 'url', url: 'http://x:1' });
    expect(previewTarget({ server: { status: 'ready', previewPath: '/api/workspace/dev/w/' }, route: '/about', workspace, nonce: 5 }).url).toBe('/api/workspace/dev/w/about?_n=5');
    expect(previewTarget({ workspace, activeTab: htmlTab })).toMatchObject({ kind: 'gateway', url: '/api/workspace/preview/w%201/pages/index.html', html: true });
    expect(previewTarget({ workspace, activeTab: { name: 'a.ts', path: '/p/site/a.ts' } })).toBeNull();
  });
});

describe('modes, slides, actions', () => {
  test('project mode heuristics', () => {
    expect(detectProjectMode(['package.json'], '{"scripts":{"dev":"vite"}}')).toBe('app');
    expect(detectProjectMode(['package.json', 'index.html'], '{"scripts":{"dev":"vite"}}')).toBe('web');
    expect(detectProjectMode(['package.json'], '{"devDependencies":{"electron":"1"}}')).toBe('app');
    expect(detectProjectMode(['deck.md'])).toBe('presentation');
    expect(detectProjectMode(['README.md'])).toBe('document');
    expect(detectProjectMode(['README.md', 'index.html'])).toBe('web');
  });
  test('slides split on --- or H1', () => {
    expect(parseSlides('# A\nx\n---\n# B')).toHaveLength(2);
    expect(parseSlides('# A\nx\n# B\ny')).toHaveLength(2);
    expect(parseSlides('just text')).toEqual(['just text']);
  });
  test('quick actions per mode', () => {
    expect(quickActionsForMode('web').map((a) => a.label)).toContain('Audit HTML');
    expect(quickActionsForMode('presentation')).toHaveLength(4);
    expect(quickActionsForMode('nope')).toEqual(quickActionsForMode('web'));
  });
  test('selection context appended once', () => {
    const sel = { selector: '#hero', html: '<div id="hero">', text: 'Hi', source: null, tag: 'div' };
    expect(composeAgentMessage('Make it bigger', sel)).toContain('Selector: #hero');
    expect(composeAgentMessage('change #hero', sel)).toBe('change #hero');
    expect(composeAgentMessage(' x ', null)).toBe('x');
  });
});

describe('templates, linked rows, misc', () => {
  test('template library is the web set, without emoji glyphs', () => {
    expect(TEMPLATE_LIBRARY.map((t) => t.id)).toEqual(['business-inquiry-form', 'contact-form', 'landing-hero-cta', 'pricing-page', 'newsletter-signup', 'coming-soon', 'code-starter']);
    expect(COMPONENT_LIBRARY).toHaveLength(5);
    expect(TEMPLATE_LIBRARY.some((t) => 'glyph' in t)).toBe(false);
  });
  test('template writes substitute action + workspace name', () => {
    const tpl = findTemplate('business-inquiry-form');
    const writes = templateWrites(tpl, { path: '/p/site/', name: 'Site' }, 'bind1');
    expect(writes[0].path.startsWith('/p/site/')).toBe(true);
    expect(writes.some((w) => w.content.includes('/api/forms/bind1/submit'))).toBe(true);
    expect(writes.every((w) => !w.content.includes('__FORM_ACTION__'))).toBe(true);
    expect(templateEntryFile(tpl).path).toBe('index.html');
    expect(Object.keys(bindingFieldMap(tpl.binding)).length).toBeGreaterThan(0);
  });
  test('linked rows match by projectId or title', () => {
    const db = { id: 'd', name: 'KK Tasks' };
    const rows = [
      { id: '1', title: 'Fix Alpha nav', values: {} },
      { id: '2', title: 'Other', values: { p: { type: 'relation', ids: ['PID-9'] }, s: { type: 'status', optionId: 'done' } } },
      { id: '3', title: 'Nope', values: {} },
    ];
    const out = matchLinkedRows(db, rows, { name: 'Alpha', projectId: 'pid-9' });
    expect(out.map((r) => r.rowId)).toEqual(['1', '2']);
    expect(out[1].status).toBe('done');
    expect(statusForLinked('in_progress')).toBe('active');
  });
  test('versions, workflows, models', () => {
    expect(normalizeVersions({ versions: [{ id: 'v', commit: 'abc', createdAt: 5 }, {}] })).toEqual([{ id: 'v', commit: 'abc', description: 'Checkpoint', createdAt: 5, stats: '' }]);
    expect(normalizeWorkflows({ workflows: [{ id: 'w', name: 'W' }] })[0]).toMatchObject({ id: 'w', name: 'W', description: '' });
    expect(normalizeWorkflows([{ id: 'x' }])[0].name).toBe('x');
    const models = pickableModels({ models: [{ id: 'm', provider: 'p', allowed: true }, { id: 'n', provider: 'p' }, { id: 'o', pinned: true, available: false }] });
    expect(models.map((m) => m.value)).toEqual(['p/m', 'o']);
    expect(models[1].available).toBe(false);
  });
  test('tokenizer tints keywords, strings, comments', () => {
    const t = tokenizeLine('const a = "x"; // hi', 'js');
    expect(t.find((s) => s.k === 'kw').t).toBe('const');
    expect(t.find((s) => s.k === 'str').t).toBe('"x"');
    expect(t.find((s) => s.k === 'com').t).toBe('// hi');
    expect(tokenizeLine('<a href="x">', 'html').map((s) => s.k)).toEqual(['tag', 'attr', 'plain', 'str', 'tag']);
    expect(tokenizeLine('# Title', 'md')).toEqual([{ t: '# Title', k: 'head' }]);
    expect(tokenizeLine('', 'js')).toEqual([{ t: '', k: 'plain' }]);
  });
});
