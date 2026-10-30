/* Mobile mirror of the gateway's shared group context (ledger + binding). */
const { activityLine, activitySummary, bindingPatch, repoStatusLine, toDisplayMessages } = require('../chat/group/group-logic');
const shared = require('../../../src/shared/group-chat/activity.ts');

const PUSH_FAILED = [
  { tool: 'exec', summary: 'git commit -m "add"', ok: true, exitCode: 0, commit: '1a2b3c4', cwd: '/repo' },
  { tool: 'exec', summary: 'git push origin main', ok: false, exitCode: 128, error: "fatal: 'origin' does not appear to be a git repository", push: { ok: false, target: 'origin main' }, cwd: '/repo' },
  { tool: 'claude_coder', summary: 'claude_coder "x"', ok: true, spawnedRunId: 'coder-x-1' },
];

describe('group shared context (mobile)', () => {
  it('formats ledger lines exactly like the gateway', () => {
    for (const a of PUSH_FAILED) expect(activityLine(a)).toBe(shared.formatActivityLine(a).replace(/^- /, ''));
    expect(activitySummary(PUSH_FAILED)).toEqual({ count: 3, failed: 1, push: 'push failed', commits: ['1a2b3c4'] });
  });

  it('carries activity + unverified flags into display messages', () => {
    const unverified = [{ kind: 'push', claim: 'Pushed.', reason: 'the git push FAILED' }];
    const [m] = toDisplayMessages([
      { role: 'assistant', content: [{ type: 'text', text: 'Pushed.' }], timestamp: 1, groupChat: { messageId: 'a', kind: 'agent', agentId: 'coder', activity: PUSH_FAILED, unverified } },
    ]);
    expect(m.activity).toEqual(PUSH_FAILED);
    expect(m.unverified).toEqual(unverified);
  });

  it('repo status says "no remote" and binding patches only send changes', () => {
    expect(repoStatusLine({ path: '/r', exists: true, isGitRepo: true, branch: 'main', head: 'abc1234', remotes: [] })).toBe('main @ abc1234 · no remote');
    expect(bindingPatch({ workdir: '/r' }, { workdir: '/r' })).toBeUndefined();
    expect(bindingPatch({ workdir: '/r', purpose: 'x' }, { workdir: '/r' })).toEqual({ workdir: '/r', purpose: 'x' });
    expect(bindingPatch(null, { workdir: '/r' })).toBeNull();
  });
});
