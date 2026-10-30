/**
 * Group chat composer parity (mobile): model / thinking settings, slash
 * commands, attachments and display of images + chat panels. The JS mirror
 * (src/chat/group/composer-logic.js) is checked against the shared TypeScript
 * the gateway runs (src/shared/group-chat/{settings,commands}.ts) and the web
 * view logic (ui/src/ui/features/group_chat/logic.ts).
 */
const C = require('../chat/group/composer-logic');
const G = require('../chat/group/group-logic');
const settings = require('../../../src/shared/group-chat/settings.ts');
const commands = require('../../../src/shared/group-chat/commands.ts');
const web = require('../../../ui/src/ui/features/group_chat/logic.ts');

const metas = [
  {},
  { settings: { model: 'a/one', thinkingLevel: 'low' } },
  { settings: { model: 'a/one' }, memberSettings: { coder: { thinkingLevel: 'high' }, qa: { model: 'b/two' } } },
  { memberSettings: { main: { model: 'c/three', thinkingLevel: 'xhigh' } } },
];

describe('settings parity with src/shared/group-chat/settings.ts', () => {
  test.each(metas.flatMap((m) => ['main', 'coder', 'qa'].map((id) => [JSON.stringify(m), id, m])))('%s @%s', (_, id, meta) => {
    expect(C.effectiveSettings(meta, id)).toEqual(settings.effectiveSettings(meta, id));
  });
  test('thinking levels', () => {
    expect(C.THINKING_LEVELS).toEqual([...settings.THINKING_LEVELS]);
  });
  test('summary + short model match the web', () => {
    for (const m of metas) expect(C.settingsSummary(m)).toBe(web.settingsSummary(m));
    expect(C.shortModel('openrouter/deepseek/v4')).toBe(web.shortModel('openrouter/deepseek/v4'));
    expect(C.THINKING_LABELS).toEqual(web.THINKING_LABELS);
  });
});

describe('slash commands parity with src/shared/group-chat/commands.ts', () => {
  test('same command specs', () => {
    expect(C.GROUP_COMMANDS).toEqual(commands.GROUP_COMMANDS.map((c) => ({ ...c })));
  });
  test.each(['/', '/m', '/mo', '/th', '/eff', '/s', '/x', '/model x', 'hi /mo', ''])('suggest %j', (draft) => {
    expect(C.slashSuggestions(draft).map((c) => c.name)).toEqual(web.slashSuggestions(draft).map((c) => c.name));
  });
});

describe('attachments', () => {
  test('picked images → chat.send attachment shape (same as the web)', () => {
    const picked = [{ uri: 'file:///x.jpg', base64: 'QUJD', mimeType: 'image/png' }, { uri: 'x' }, null];
    expect(C.toAttachments(picked)).toEqual([{ type: 'image', mimeType: 'image/png', content: 'QUJD' }]);
    expect(C.toAttachments(picked)).toEqual(web.toApiAttachments([{ id: '1', dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' }]));
  });
});

describe('model sheet rows', () => {
  const res = {
    models: [
      { id: 'mock-fast', name: 'Mock Fast', provider: 'mock', allowed: true, reasoning: true },
      { id: 'gpt-x', name: 'GPT X', provider: 'openai', allowed: false },
      { id: 'local-1', name: 'Local 1', provider: 'ollama', allowed: false, free: 'local' },
      { id: 'off', name: 'Offline', provider: 'groq', unconfigured: true },
    ],
  };
  test('allowlist first, rest by provider, unconfigured hidden, refs are provider/model', () => {
    const r = C.modelRows(res);
    expect(r.mine.map((m) => m.id)).toEqual(['mock/mock-fast']);
    expect(r.groups.map((g) => g.provider)).toEqual(['ollama', 'openai']);
    expect(r.total).toBe(3);
    expect(C.needsAllowlistAdd(r.groups[1].models[0])).toBe(true);
    expect(C.modelRows(res, 'local').total).toBe(1);
  });
  test('thinking options + patch value', () => {
    expect(C.thinkingOptions('zai')).toEqual(['', 'off', 'on']);
    expect(C.thinkingPatchValue('on')).toBe('low');
    expect(C.thinkingPatchValue('')).toBeNull();
  });
});

describe('group transcript: images, chat panels, model', () => {
  const panel = { v: 1, panelId: 'p1', kind: 'agents', query: {}, title: 'Agents', display: 'inline', summary: '', count: 1, empty: false, error: null, link: { tab: 'agents', label: 'Agents' }, refreshMs: 0, ts: 1 };
  const raw = [
    { role: 'user', content: [{ type: 'text', text: '' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 1, groupChat: { messageId: 'u1', kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 2, groupChat: { messageId: 'a1', kind: 'agent', agentId: 'main', panels: [panel], model: 'mock/fast' } },
    { role: 'assistant', content: [{ type: 'text', text: '' }], timestamp: 3, groupChat: { messageId: 'a2', kind: 'agent', agentId: 'qa' } },
    { role: 'user', content: [{ type: 'text', text: '/think high' }], timestamp: 4, groupChat: { messageId: 'u2', kind: 'user', command: true } },
  ];
  test('matches the web display model', () => {
    const mine = G.toDisplayMessages(raw);
    const webMsgs = web.toDisplayMessages(raw);
    expect(mine.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    expect(mine.map((m) => [m.id, m.images, m.panels.map((p) => p.panelId), m.model])).toEqual(
      webMsgs.map((m) => [m.id, m.images, m.panels.map((p) => p.panelId), m.model]),
    );
    expect(mine[0].images).toEqual(['data:image/png;base64,AAAA']);
  });
});

describe('composer parity gating', () => {
  test('matches the web: controls only for gateways that return settings', () => {
    for (const g of [null, undefined, {}, { settings: {} }, { settings: { model: 'a/b' } }]) {
      expect(C.supportsComposerParity(g)).toBe(web.supportsComposerParity(g));
    }
    expect(C.supportsComposerParity({ settings: {} })).toBe(true);
    expect(C.supportsComposerParity({ mode: 'everyone' })).toBe(false);
  });
});
