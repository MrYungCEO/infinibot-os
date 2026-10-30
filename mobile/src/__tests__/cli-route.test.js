import { backendInfo, folderName, messageCli, parseRoute, parseRouteCommand, routeStorageKey } from '../chat/cli-route';
import { buildTurns } from '../chat/session-sync';

describe('cli-route', () => {
  it('parses /cli and /agent like the web chat', () => {
    expect(parseRouteCommand('/cli codex')).toEqual({ kind: 'cli', backend: 'codex' });
    expect(parseRouteCommand('/cli claude ~/proj')).toEqual({ kind: 'cli', backend: 'claude-code', cwd: '~/proj' });
    expect(parseRouteCommand('/cli')).toEqual({ kind: 'cli', backend: null });
    expect(parseRouteCommand('/agent cmo')).toEqual({ kind: 'agent', agentId: 'cmo' });
    expect(parseRouteCommand('/cli grok')).toEqual({ kind: 'cli-unknown', name: 'grok' });
    expect(parseRouteCommand('/claude on')).toBeNull();
    expect(parseRouteCommand('hello')).toBeNull();
  });

  it('validates stored routes and keys per thread', () => {
    expect(parseRoute({ mode: 'cli', backend: 'codex-cli', cwd: ' /r ' })).toEqual({ mode: 'cli', backend: 'codex', cwd: '/r' });
    expect(parseRoute({ mode: 'cli', backend: 'nope' })).toBeNull();
    expect(routeStorageKey(null)).toBe('infinibot.chat.route.__draft');
    expect(routeStorageKey('agent:main:webchat-a')).toBe('infinibot.chat.route.agent:main:webchat-a');
  });

  it('maps backend status and folder names', () => {
    expect(backendInfo({ id: 'claude-cli', installed: true, auth: 'signed-in', version: '2.1.3 (Claude Code)' })).toMatchObject({ id: 'claude-code', status: 'ready', version: '2.1.3' });
    expect(backendInfo({ id: 'gemini-cli', installed: true, auth: 'signed-out' }).status).toBe('login');
    expect(backendInfo({ id: 'opencode-cli', installed: false }).status).toBe('unavailable');
    expect(folderName('/a/b/demo/')).toBe('demo');
    expect(messageCli({ cli: { backend: 'codex' } })).toBe('codex');
  });

  it('buildTurns labels CLI replies and folds their tool calls', () => {
    const turns = buildTurns([
      { role: 'user', content: [{ type: 'text', text: 'pwd' }], cli: { backend: 'codex' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'demo' }],
        cli: { backend: 'codex', cwd: '/x/demo' },
        cliTools: [{ id: 't1', name: 'shell', input: 'pwd', status: 'done', output: '/x/demo' }],
      },
    ]);
    const a = turns.find((t) => t.role === 'assistant');
    expect(a.model).toBe('Codex · CLI · demo');
    expect(a.blocks.map((b) => b.kind)).toEqual(['tool', 'text']);
  });
});
