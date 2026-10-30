import {
  BUILTIN_TYPES,
  creatableTypes,
  fallbackLibrary,
  filterLibrary,
  ionIconFor,
  newTitleFor,
  routeForItem,
  typeById,
  typeChips,
} from '../lib/library-model';

describe('library model (document types on the phone)', () => {
  it('ships the same 13 built-in type ids as the gateway, each with an Ionicon', () => {
    expect(BUILTIN_TYPES.map((t) => t.id)).toEqual([
      'note', 'idea', 'document', 'meeting', 'research', 'report', 'sop', 'spec', 'brief', 'journal', 'plan', 'template', 'snippet',
    ]);
    for (const t of BUILTIN_TYPES) expect(ionIconFor(t.icon)).not.toBe('document-outline');
  });

  it('create-with-type offers Idea but not Report; hidden types drop out', () => {
    const ids = creatableTypes(BUILTIN_TYPES).map((t) => t.id);
    expect(ids).toContain('idea');
    expect(ids).not.toContain('report');
    const hidden = BUILTIN_TYPES.map((t) => (t.id === 'plan' ? { ...t, hidden: true } : t));
    expect(creatableTypes(hidden).map((t) => t.id)).not.toContain('plan');
  });

  it('filter chips: All first, counts per type, hidden types kept while they hold items', () => {
    const types = BUILTIN_TYPES.map((t) => (t.id === 'plan' ? { ...t, hidden: true } : t));
    const chips = typeChips(types, { idea: 2, plan: 1 }, 9);
    expect(chips[0]).toMatchObject({ id: null, label: 'All', count: 9 });
    expect(chips.find((c) => c.id === 'idea').count).toBe(2);
    expect(chips.find((c) => c.id === 'plan').count).toBe(1);
    expect(typeChips(types, {}, 0).some((c) => c.id === 'plan')).toBe(false);
  });

  it('fallback library merges notes (typed by legacy category) and ideas, newest first', () => {
    const lib = fallbackLibrary(
      [
        { id: 'n1', name: 'Standup', category: 'log', updatedAt: '2026-10-01T00:00:00Z' },
        { id: 'n2', name: 'Plain', updatedAt: '2026-10-03T00:00:00Z' },
      ],
      [{ id: 'i1', title: 'Voice CRM', body: 'x', tags: ['crm'], status: 'new', updatedAt: '2026-10-02T00:00:00Z' }],
    );
    expect(lib.items.map((i) => [i.id, i.type])).toEqual([
      ['n2', 'note'],
      ['i1', 'idea'],
      ['n1', 'journal'],
    ]);
    expect(lib.counts.byType).toEqual({ note: 1, idea: 1, journal: 1 });
    expect(filterLibrary(lib.items, 'idea', '').map((i) => i.id)).toEqual(['i1']);
    expect(filterLibrary(lib.items, null, 'crm').map((i) => i.id)).toEqual(['i1']);
  });

  it('routes items to the right screen', () => {
    expect(routeForItem({ source: 'idea', id: 'i1' })).toEqual(['Ideas', { ideaId: 'i1' }]);
    expect(routeForItem({ source: 'doc', id: 'd1' })).toEqual(['Notes', { docId: 'd1' }]);
    expect(routeForItem({ source: 'doc', id: 'n1', noteId: 'n1' })).toEqual(['Notes', { noteId: 'n1' }]);
    expect(routeForItem({ source: 'report', id: 'r' })[0]).toBe('ReportsModal');
  });

  it('unknown ids and titles', () => {
    expect(typeById(BUILTIN_TYPES, 'c-recipe')).toMatchObject({ id: 'c-recipe', label: 'recipe' });
    expect(newTitleFor(typeById(BUILTIN_TYPES, 'journal'), new Date('2026-10-14T08:00:00Z'))).toBe('Journal · 2026-10-14');
  });
});
