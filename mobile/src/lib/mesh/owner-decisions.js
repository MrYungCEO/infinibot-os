export const OWNER_DECISION_EVENTS = [
  'approval.requested',
  'approval.resolved',
  'verification.completion',
  'review.message',
  'kanban:changed',
  'kanban.task.updated',
];

const same = (a, b) => !!a && !!b && a === b;

export function decisionMatchesAgent(decision, agent) {
  return !!decision && !!agent && (
    same(decision.target?.runId, agent.runId)
    || same(decision.target?.sessionKey, agent.sessionKey)
    || same(decision.target?.agentId, agent.agentId)
    || same(decision.target?.taskId, agent.kanbanTaskId)
  );
}

export function decisionsForAgent(decisions, agent) {
  return (decisions || []).filter((decision) => decisionMatchesAgent(decision, agent));
}

async function resumeRun(sendReq, runId, note) {
  try {
    return await sendReq('verification.decide', { runId, action: 'continue', note: note || undefined });
  } catch (error) {
    const message = error?.message || String(error);
    if (!/use retry|no session id|cannot be resumed/i.test(message)) throw error;
    return sendReq('verification.decide', { runId, action: 'retry', note: note || undefined });
  }
}

export async function resolveOwnerDecision(sendReq, decision, action, reply) {
  if (!sendReq) throw new Error('Not connected');
  const note = String(reply || '').trim();
  if (decision.kind === 'approval') {
    const result = await sendReq('approvals.resolve', {
      id: decision.target?.approvalId,
      action,
      note: note || undefined,
    });
    if (result?.ok === false) throw new Error(result.error || 'Approval could not be resolved.');
    return { resumed: action === 'approve', message: action === 'approve' ? 'Approved and resumed' : 'Denied' };
  }
  if (decision.kind === 'run_input') {
    const response = note || action;
    if (!response || response === 'reply') throw new Error('Write a reply or choose an option.');
    try {
      await sendReq('subagents.message', {
        runId: decision.target?.runId,
        childSessionKey: decision.target?.sessionKey,
        message: response,
      });
    } catch {}
    await resumeRun(sendReq, decision.target?.runId, response);
    return { resumed: true, message: 'Reply delivered — run resumed' };
  }
  if (decision.kind === 'run_owner') {
    if (action === 'continue' || action === 'retry') {
      await resumeRun(sendReq, decision.target?.runId, note);
      return { resumed: true, message: 'Run resumed' };
    }
    await sendReq('verification.decide', { runId: decision.target?.runId, action, note: note || undefined });
    return { resumed: false, message: action === 'accept' ? 'Accepted' : 'Rejected' };
  }
  await sendReq('kanban.tasks.update', {
    id: decision.target?.taskId,
    patch: { status: 'todo', autonomousStatus: 'approved' },
    source: 'ui',
  });
  if (decision.target?.runId) {
    await resumeRun(sendReq, decision.target.runId, note || 'Owner unblocked the linked task.');
  } else if (decision.target?.sessionKey && note) {
    await sendReq('subagents.message', { childSessionKey: decision.target.sessionKey, message: note });
  }
  return { resumed: true, message: 'Task unblocked' };
}
