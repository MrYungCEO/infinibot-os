/**
 * Quick-capture date picker + client picker (pure logic).
 */
import {
  chipFor,
  dateChipLabel,
  formatTime,
  formatWhen,
  isYmd,
  joinWhen,
  monthGrid,
  quickChips,
  relativeHint,
  shiftMonth,
  splitWhen,
  stepTime,
} from '../lib/date-pick';
import {
  clientRows,
  clientSuggestionLabel,
  filterClients,
  findClient,
  normalizeClients,
  resolveAutoClient,
} from '../lib/client-picker-model';
import { recordUsage } from '../lib/project-picker-model';
import { assignItemClient } from '../lib/client-assign';

// Wed 14 Oct 2026, 10:00 local.
const NOW = new Date(2026, 9, 14, 10, 0, 0);

describe('date chips', () => {
  it('Today / Tomorrow / This weekend / Next week / In 2 weeks', () => {
    expect(quickChips(NOW).map((c) => [c.key, c.date])).toEqual([
      ['today', '2026-10-14'],
      ['tomorrow', '2026-10-15'],
      ['weekend', '2026-10-17'],
      ['next-week', '2026-10-19'],
      ['two-weeks', '2026-10-28'],
    ]);
  });

  it('on a weekend "This weekend" is today and "Next week" is the coming Monday', () => {
    const sat = new Date(2026, 9, 17, 9);
    const sun = new Date(2026, 9, 18, 9);
    expect(quickChips(sat).find((c) => c.key === 'weekend').date).toBe('2026-10-17');
    expect(quickChips(sun).find((c) => c.key === 'weekend').date).toBe('2026-10-18');
    expect(quickChips(sun).find((c) => c.key === 'next-week').date).toBe('2026-10-19');
  });

  it('chipFor finds the chip a date came from', () => {
    expect(chipFor('2026-10-15', NOW)).toBe('tomorrow');
    expect(chipFor('2026-12-25', NOW)).toBeNull();
  });
});

describe('calendar grid', () => {
  it('6 Monday-first weeks with in-month / today / past flags', () => {
    const weeks = monthGrid(2026, 9, { now: NOW });
    expect(weeks).toHaveLength(6);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 1 Oct 2026 is a Thursday → the first row starts Mon 28 Sep.
    expect(weeks[0][0]).toMatchObject({ date: '2026-09-28', inMonth: false });
    expect(weeks[0][3]).toMatchObject({ date: '2026-10-01', day: 1, inMonth: true });
    const flat = weeks.flat();
    expect(flat.find((c) => c.isToday).date).toBe('2026-10-14');
    expect(flat.find((c) => c.date === '2026-10-13').isPast).toBe(true);
    expect(flat.find((c) => c.date === '2026-10-15').isPast).toBe(false);
  });

  it('month arrows roll over years', () => {
    expect(shiftMonth({ y: 2026, m: 11 }, 1)).toEqual({ y: 2027, m: 0 });
    expect(shiftMonth({ y: 2026, m: 0 }, -1)).toEqual({ y: 2025, m: 11 });
  });
});

describe('formatting', () => {
  it('human-readable dates and times', () => {
    expect(formatWhen('2026-10-17', null, { now: NOW })).toBe('Sat 17 Oct');
    expect(formatWhen('2026-10-17', '15:00', { now: NOW })).toBe('Sat 17 Oct, 3 pm');
    expect(formatWhen('2026-10-17', '09:30', { now: NOW })).toBe('Sat 17 Oct, 9:30 am');
    expect(formatWhen('2027-01-05', null, { now: NOW })).toBe('Tue 5 Jan 2027');
    expect(formatWhen('nope', null, { now: NOW })).toBe('');
    expect(formatTime('00:00')).toBe('12 am');
    expect(formatTime('12:15')).toBe('12:15 pm');
  });

  it('relative hints', () => {
    expect(relativeHint('2026-10-14', { now: NOW })).toBe('today');
    expect(relativeHint('2026-10-15', { now: NOW })).toBe('tomorrow');
    expect(relativeHint('2026-10-13', { now: NOW })).toBe('yesterday');
    expect(relativeHint('2026-10-20', { now: NOW })).toBe('in 6 days');
    expect(relativeHint('2026-11-25', { now: NOW })).toBe('in 6 weeks');
    expect(relativeHint('2026-10-11', { now: NOW })).toBe('3 days ago');
  });

  it('auto chip label shows the date and the words it came from', () => {
    expect(dateChipLabel({ date: '2026-10-16', phrase: 'by Friday' }, { now: NOW })).toBe('Auto: Fri 16 Oct · from “by Friday”');
    expect(dateChipLabel({ date: '2026-10-20', time: '15:00', phrase: 'next Tuesday at 3' }, { now: NOW })).toBe(
      'Auto: Tue 20 Oct, 3 pm · from “next Tuesday at 3”',
    );
    expect(dateChipLabel(null)).toBe('');
  });

  it('split / join / step / validate', () => {
    expect(splitWhen('2026-10-17T15:00')).toEqual({ date: '2026-10-17', time: '15:00' });
    expect(splitWhen('2026-10-17T15:00:00.000+07:00')).toEqual({ date: '2026-10-17', time: '15:00' });
    expect(splitWhen('2026-10-17')).toEqual({ date: '2026-10-17', time: null });
    expect(splitWhen('')).toEqual({ date: null, time: null });
    expect(joinWhen('2026-10-17', '09:00')).toBe('2026-10-17T09:00');
    expect(joinWhen(null, '09:00')).toBe('');
    expect(stepTime('09:00', 15)).toBe('09:15');
    expect(stepTime('00:00', -15)).toBe('23:45');
    expect(stepTime(null, 15)).toBe('09:15');
    expect(isYmd('2026-02-30')).toBe(false);
    expect(isYmd('2026-02-28')).toBe(true);
  });
});

const RAW_CLIENTS = {
  clients: [
    { id: 'c-gengu', name: 'Gengu Dinosaurs Technology Co., Ltd.', aliases: ['Gengu'], email: 'gengudino@zggengu.com', status: 'Lead', updatedAt: 300, notionPageId: '202f4bdd-aaaa-bbbb' },
    { id: 'c-Sample', name: 'SAMPLE Robopark', status: 'Active', updatedAt: 200 },
    { id: 'c-alan', name: 'Alan', updatedAt: 100 },
    { id: 'c-afk', name: 'AfriKayla', about: 'Black Brand, clothing' },
    { id: '', name: 'no id' },
  ],
};
const CLIENTS = normalizeClients(RAW_CLIENTS);

describe('client picker', () => {
  it('normalises capture.clients and the older clients.list shape', () => {
    expect(CLIENTS.map((c) => c.id)).toEqual(['c-gengu', 'c-Sample', 'c-alan', 'c-afk']);
    const old = normalizeClients({ clients: [{ id: 'x', data: { Name: 'Legacy Co', Company: 'LCo', Email: 'a@b.c' }, notion_page_id: 'np' }] });
    expect(old[0]).toMatchObject({ name: 'Legacy Co', aliases: ['LCo'], email: 'a@b.c', notionPageId: 'np' });
  });

  it('search covers name, company alias, email and about', () => {
    expect(filterClients(CLIENTS, 'gengu').map((c) => c.id)).toEqual(['c-gengu']);
    expect(filterClients(CLIENTS, 'robo park')[0].id).toBe('c-Sample'); // spacing variant
    expect(filterClients(CLIENTS, 'zggengu')[0].id).toBe('c-gengu'); // email
    expect(filterClients(CLIENTS, 'clothing').map((c) => c.id)).toEqual(['c-afk']);
    expect(filterClients(CLIENTS, 'zzz')).toEqual([]);
  });

  it('recent first with no query, then most recently active', () => {
    const usage = recordUsage({}, 'c-alan', 5);
    const rows = clientRows(CLIENTS, '', usage);
    expect(rows[0]).toMatchObject({ type: 'header', title: 'Recent' });
    expect(rows[1].client.id).toBe('c-alan');
    expect(rows[2]).toMatchObject({ type: 'header', title: 'All clients (4)' });
    expect(rows.slice(3).map((r) => r.client.id)).toEqual(['c-gengu', 'c-Sample', 'c-afk']);
    expect(clientRows(CLIENTS, 'al')[0].title).toBe('1 match');
  });

  it('findClient resolves agency ids and Notion page ids', () => {
    expect(findClient(CLIENTS, 'c-Sample').name).toBe('SAMPLE Robopark');
    expect(findClient(CLIENTS, '202f4bddaaaabbbb').id).toBe('c-gengu');
    expect(findClient(CLIENTS, 'nope')).toBeNull();
  });
});

describe('auto client', () => {
  it('confident suggestion → preselected with an Auto chip', () => {
    const r = resolveAutoClient({ clientSuggestion: { id: 'c-gengu', name: 'Gengu', confidence: 0.9, reason: 'named the client', source: 'match', auto: true } }, CLIENTS);
    expect(r).toMatchObject({ clientId: 'c-gengu', autoSelected: true });
    expect(clientSuggestionLabel(r.suggestion, { selected: true })).toBe('Auto: Gengu Dinosaurs Technology Co., Ltd. · named the client');
  });

  it('weak suggestion is only offered', () => {
    const r = resolveAutoClient({ clientSuggestion: { id: 'c-alan', name: 'Alan', confidence: 0.4, auto: false } }, CLIENTS);
    expect(r.clientId).toBeUndefined();
    expect(clientSuggestionLabel(r.suggestion)).toBe('Suggested: Alan');
  });

  it('an id the phone does not know is never selected', () => {
    expect(resolveAutoClient({ clientId: 'ghost', clientSuggestion: { id: 'ghost', confidence: 0.99, auto: true } }, CLIENTS)).toMatchObject({
      clientId: undefined,
      suggestion: null,
    });
  });

  it('older gateway / offline: on-device name match on the transcript', () => {
    const r = resolveAutoClient({ transcript: 'call SAMPLE Robopark about the gate' }, CLIENTS);
    expect(r).toMatchObject({ clientId: 'c-Sample', autoSelected: true });
  });
});

describe('assignItemClient', () => {
  it('uses capture.assignClient, falls back per store on older gateways', async () => {
    const calls = [];
    const modern = async (m, p) => {
      calls.push([m, p]);
      return { ok: true };
    };
    await assignItemClient(modern, { kind: 'task', id: 't1', clientId: 'c-alan', previousClientId: 'c-Sample' });
    expect(calls[0]).toEqual(['capture.assignClient', { kind: 'task', id: 't1', clientId: 'c-alan', previousClientId: 'c-Sample' }]);

    const legacyCalls = [];
    const legacy = async (m, p) => {
      legacyCalls.push([m, p]);
      if (m === 'capture.assignClient') throw new Error('unknown method: capture.assignClient');
      return { ok: true };
    };
    await assignItemClient(legacy, { kind: 'note', id: 'n1', clientId: null });
    expect(legacyCalls.at(-1)).toEqual(['notes.update', { id: 'n1', clientId: '' }]);
    await assignItemClient(legacy, { kind: 'idea', id: 'i1', clientId: 'c-alan' });
    expect(legacyCalls.at(-1)).toEqual(['ideas.update', { id: 'i1', patch: { clientIds: ['c-alan'] } }]);
    await expect(assignItemClient(legacy, { kind: 'task', id: 't1', clientId: 'c-alan' })).rejects.toThrow(/newer gateway/);
  });
});
