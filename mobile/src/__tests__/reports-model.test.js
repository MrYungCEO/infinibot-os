import {
  isResearchReport,
  isSystemEvent,
  filterReports,
  sortReports,
  groupReports,
  dateBucket,
  matchesSearch,
  categoryLabel,
  categoriesOf,
  dedupeReports,
  assetKind,
  toolPayload,
  researchDocToRow,
  describeCron,
} from '../lib/reports-model';

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime(); // Tue 13 Oct 2026 15:00 local
const DAY = 24 * 60 * 60 * 1000;

const R = (over) => ({ id: over.id, kind: 'custom', title: over.id, status: 'ready', category: 'general', createdAt: NOW, ...over });

describe('research detection (port of web isResearchReport)', () => {
  test('research kinds and category count; noise kinds never do', () => {
    expect(isResearchReport(R({ id: 'a', kind: 'research_brief' }))).toBe(true);
    expect(isResearchReport(R({ id: 'b', category: 'research' }))).toBe(true);
    expect(isResearchReport(R({ id: 'c', kind: 'oversight_event', category: 'research', title: 'Sub-agent failed — research PDF' }))).toBe(false);
    expect(isResearchReport(R({ id: 'd', title: 'Global Robotics — Competitor Landscape' }))).toBe(true);
    expect(isResearchReport(R({ id: 'e', title: 'Weekly invoice' }))).toBe(false);
    expect(isResearchReport(R({ id: 'f', sourceSession: 'agent:main:research-abc' }))).toBe(true);
  });
  test('system events', () => {
    expect(isSystemEvent(R({ id: 'x', kind: 'oversight_event' }))).toBe(true);
    expect(isSystemEvent(R({ id: 'y', kind: 'research_brief' }))).toBe(false);
  });
});

describe('filter + search', () => {
  const list = [
    R({ id: '1', kind: 'oversight_event', title: 'Sub-agent failed — X' }),
    R({ id: '2', kind: 'research_brief', category: 'research', title: 'Robotics landscape', sourceAgent: 'claude_coder' }),
    R({ id: '3', category: 'finance', title: 'Invoice March', status: 'failed' }),
  ];
  test('hideSystem drops oversight noise', () => {
    expect(filterReports(list, { hideSystem: true }).map((r) => r.id)).toEqual(['2', '3']);
  });
  test('category, status, researchOnly', () => {
    expect(filterReports(list, { category: 'finance' }).map((r) => r.id)).toEqual(['3']);
    expect(filterReports(list, { status: 'failed' }).map((r) => r.id)).toEqual(['3']);
    expect(filterReports(list, { researchOnly: true }).map((r) => r.id)).toEqual(['2']);
  });
  test('search is multi-token across title/category/source', () => {
    expect(matchesSearch(list[1], 'robotics claude')).toBe(true);
    expect(matchesSearch(list[1], 'robotics invoice')).toBe(false);
    expect(filterReports(list, { search: 'invoice' }).map((r) => r.id)).toEqual(['3']);
    expect(filterReports(list, { search: 'Research' }).map((r) => r.id)).toEqual(['2']);
  });
});

describe('sorting', () => {
  const list = [
    R({ id: 'b', title: 'beta', createdAt: NOW - 2 * DAY, sourceAgent: 'zed' }),
    R({ id: 'a', title: 'Alpha', createdAt: NOW, sourceAgent: 'amy' }),
    R({ id: 'c', title: 'gamma', createdAt: NOW - DAY }),
  ];
  test('date desc / asc', () => {
    expect(sortReports(list, 'date', -1).map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(sortReports(list, 'date', 1).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });
  test('title is case-insensitive', () => {
    expect(sortReports(list, 'title', 1).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sortReports(list, 'title', -1).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
  test('source falls back to category', () => {
    expect(sortReports(list, 'source', 1).map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
  test('does not mutate the input', () => {
    const copy = list.map((r) => r.id);
    sortReports(list, 'title', 1);
    expect(list.map((r) => r.id)).toEqual(copy);
  });
});

describe('grouping', () => {
  test('date buckets', () => {
    expect(dateBucket(NOW - 60_000, NOW)).toBe('Today');
    expect(dateBucket(NOW - DAY, NOW)).toBe('Yesterday');
    expect(dateBucket(NOW - 4 * DAY, NOW)).toBe('This week');
    expect(dateBucket(NOW - 20 * DAY, NOW)).toBe('This month');
    expect(dateBucket(NOW - 90 * DAY, NOW)).toBe('Older');
    expect(dateBucket(0, NOW)).toBe('Older');
  });
  test('group by date keeps bucket order and item order', () => {
    const list = sortReports([
      R({ id: 'old', createdAt: NOW - 100 * DAY }),
      R({ id: 't1', createdAt: NOW - 1000 }),
      R({ id: 'y', createdAt: NOW - DAY }),
      R({ id: 't2', createdAt: NOW - 5000 }),
    ]);
    const g = groupReports(list, 'date', { now: NOW });
    expect(g.map((s) => s.title)).toEqual(['Today', 'Yesterday', 'Older']);
    expect(g[0].data.map((r) => r.id)).toEqual(['t1', 't2']);
    const asc = groupReports(sortReports(list, 'date', 1), 'date', { now: NOW, dir: 1 });
    expect(asc.map((s) => s.title)).toEqual(['Older', 'Yesterday', 'Today']);
  });
  test('group by category: biggest first, labelled', () => {
    const g = groupReports(
      [R({ id: '1', category: 'finance' }), R({ id: '2', category: 'research' }), R({ id: '3', category: 'research' }), R({ id: '4', category: 'agent-output' })],
      'category',
    );
    expect(g.map((s) => s.key)).toEqual(['research', 'agent-output', 'finance']);
    expect(g.map((s) => s.title)).toEqual(['Research', 'Agent Output', 'Finance']);
  });
  test('none and empty', () => {
    expect(groupReports([], 'category')).toEqual([]);
    expect(groupReports([R({ id: 'z' })], 'none')[0].data).toHaveLength(1);
  });
});

describe('helpers', () => {
  test('category labels and list', () => {
    expect(categoryLabel('ceo_hourly_insights')).toBe('CEO Hourly');
    expect(categoryLabel('oversight:event')).toBe('Oversight Event');
    expect(categoriesOf([R({ id: '1', category: 'finance' })], ['research'])).toEqual(['finance', 'research']);
  });
  test('dedupe merges by id', () => {
    const out = dedupeReports([R({ id: '1', title: 'a' })], [R({ id: '1', title: 'b' }), R({ id: '2' })]);
    expect(out.map((r) => [r.id, r.title])).toEqual([['1', 'b'], ['2', '2']]);
  });
  test('asset kind', () => {
    expect(assetKind({ filePath: '/x/r.pdf' })).toBe('pdf');
    expect(assetKind({ filePath: '/x/r.html', originalFormat: 'html' })).toBe('html');
    expect(assetKind({ filePath: null })).toBe('none');
  });
  test('tool payload + research doc rows', () => {
    const res = { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', research: [{ id: 'd1', name: 'Dossier', createdAt: '2026-10-01T00:00:00Z' }] }) }] } };
    const p = toolPayload(res);
    expect(p.research).toHaveLength(1);
    const row = researchDocToRow(p.research[0]);
    expect(row).toMatchObject({ id: 'research-doc:d1', docId: 'd1', isResearchDoc: true, category: 'research', title: 'Dossier' });
    expect(row.createdAt).toBe(Date.parse('2026-10-01T00:00:00Z'));
  });
  test('cron descriptions', () => {
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00');
    expect(describeCron('30 7 * * 1')).toBe('Every Mon at 07:30');
    expect(describeCron('*/5 * * * *')).toBe('*/5 * * * *');
  });
});
