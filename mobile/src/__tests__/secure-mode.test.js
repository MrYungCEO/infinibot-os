/**
 * Secure Mode (mobile): session-key lane rule mirrors the gateway's
 * src/secure-mode/session-key.ts; secure board grouping helpers.
 */
const L = require('../secure/secure-logic');
const gw = require('../../../src/secure-mode/session-key.ts');

const KEYS = [
  'agent:main:secure-lx9k2a-abc123',
  'agent:coder:secure-1',
  'agent:main:groupchat-sec-team1',
  'agent:main:gcmember-sec-team1',
  'agent:main:secure-x:thread:1',
  'agent:main:sub:secure-x',
  'AGENT:Main:SECURE-abc',
  '  agent:main:secure-abc  ',
  'agent:main:main',
  'agent:main:groupchat-team1',
  'agent:main:gcmember-team1',
  'agent:main:securely-not',
  'agent:main:web-secure-x',
  'secure-abc',
  'agent:main:',
  '',
  null,
  undefined,
  42,
];

describe('isSecureSessionKey', () => {
  test.each(KEYS.map((k) => [String(k), k]))('%s matches the gateway', (_, k) => {
    expect(L.isSecureSessionKey(k)).toBe(gw.isSecureSessionKey(k));
  });
  test('known answers', () => {
    expect(L.isSecureSessionKey('agent:main:secure-abc')).toBe(true);
    expect(L.isSecureSessionKey('agent:main:groupchat-sec-x')).toBe(true);
    expect(L.isSecureSessionKey('agent:main:gcmember-sec-x')).toBe(true);
    expect(L.isSecureSessionKey('agent:main:x:secure-y')).toBe(true);
    expect(L.isSecureSessionKey('agent:main:groupchat-x')).toBe(false);
    expect(L.isSecureSessionKey('agent:main:main')).toBe(false);
    expect(L.isSecureSessionKey(null)).toBe(false);
  });
  test('isSecureGroupKey only for the shared secure group session', () => {
    expect(L.isSecureGroupKey('agent:main:groupchat-sec-x')).toBe(true);
    expect(L.isSecureGroupKey('agent:main:gcmember-sec-x')).toBe(false);
    expect(L.isSecureGroupKey('agent:main:secure-x')).toBe(false);
  });
});

describe('newSecureSessionKey', () => {
  test('shape + recognised as secure', () => {
    const k = L.newSecureSessionKey('coder', 1_700_000_000_000, () => 0.5);
    expect(k).toMatch(/^agent:coder:secure-[0-9a-z]+-[0-9a-z]{6}$/);
    expect(L.isSecureSessionKey(k)).toBe(true);
    expect(gw.isSecureSessionKey(k)).toBe(true);
    expect(L.newSecureSessionKey('', 1).startsWith('agent:main:secure-')).toBe(true);
  });
});

describe('secure board helpers', () => {
  const tasks = [
    { id: 'a', title: 'A', status: 'todo', updatedAt: 1, projectId: 'p1' },
    { id: 'b', title: 'B', status: 'done', updatedAt: 2 },
    { id: 'c', title: 'C', status: 'weird', updatedAt: 3, projectId: 'p1' },
    { id: 'd', title: 'D', status: 'todo', updatedAt: 5 },
    { title: 'no id' },
  ];
  test('groups by status, unknown → todo, newest first', () => {
    const g = L.groupSecureTasks(tasks);
    expect(g.todo.map((t) => t.id)).toEqual(['d', 'c', 'a']);
    expect(g.done.map((t) => t.id)).toEqual(['b']);
    expect(g.in_progress).toEqual([]);
    expect(Object.keys(g)).toEqual(L.SECURE_STATUSES.map((s) => s.key));
  });
  test('project filter', () => {
    expect(L.groupSecureTasks(tasks, 'p1').todo.map((t) => t.id)).toEqual(['c', 'a']);
  });
  test('next status cycles', () => {
    expect(L.nextSecureStatus('todo')).toBe('in_progress');
    expect(L.nextSecureStatus('done')).toBe('todo');
    expect(L.nextSecureStatus('blocked')).toBe('in_progress');
  });
  test('error text', () => {
    const locked = Object.assign(new Error('locked'), { code: 'SECURE_MODE_LOCKED' });
    expect(L.secureErrorText(locked)).toMatch(/Secure Mode is off/);
    expect(L.secureErrorText(new Error('unknown method: secure.status'))).toMatch(/does not support/);
    expect(L.secureErrorText(new Error('Error: no keyring key'))).toBe('no keyring key');
  });
});
