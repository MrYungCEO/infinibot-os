import { decisionMatchesAgent, resolveOwnerDecision } from '../lib/mesh/owner-decisions';

const base = {
  id: 'run:r1',
  kind: 'run_input',
  target: { runId: 'r1', sessionKey: 'agent:one' },
};

describe('mobile mesh owner decisions', () => {
  test('matches a decision to its native mesh agent card', () => {
    expect(decisionMatchesAgent(base, { runId: 'r1', sessionKey: 'agent:one' })).toBe(true);
    expect(decisionMatchesAgent({ ...base, target: { taskId: 't1' } }, { kanbanTaskId: 't1' })).toBe(true);
    expect(decisionMatchesAgent(base, { runId: 'r2', sessionKey: 'agent:two' })).toBe(false);
  });

  test('replies through the inbox then resumes the run', async () => {
    const sendReq = jest.fn(async () => ({ ok: true }));
    await expect(resolveOwnerDecision(sendReq, base, 'reply', 'Use Asia')).resolves.toEqual({
      resumed: true,
      message: 'Reply delivered — run resumed',
    });
    expect(sendReq).toHaveBeenNthCalledWith(1, 'subagents.message', {
      runId: 'r1',
      childSessionKey: 'agent:one',
      message: 'Use Asia',
    });
    expect(sendReq).toHaveBeenNthCalledWith(2, 'verification.decide', {
      runId: 'r1',
      action: 'continue',
      note: 'Use Asia',
    });
  });

  test('unblocks a kanban task with the existing update API', async () => {
    const sendReq = jest.fn(async () => ({ ok: true }));
    await expect(resolveOwnerDecision(sendReq, { ...base, kind: 'kanban_blocked', target: { taskId: 't1' } }, 'unblock', '')).resolves.toMatchObject({ resumed: true });
    expect(sendReq).toHaveBeenCalledWith('kanban.tasks.update', {
      id: 't1',
      patch: { status: 'todo', autonomousStatus: 'approved' },
      source: 'ui',
    });
  });
});
