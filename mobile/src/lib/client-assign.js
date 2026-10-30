/**
 * Change the CRM client of an idea, note, task or project.
 *
 * capture.assignClient moves the item AND keeps the client page / knowledge
 * graph links in line (and Notion's Customer / Clients relation). On a
 * gateway that predates it, ideas and notes fall back to their own update
 * RPC; tasks and projects need the newer gateway.
 */

const UNKNOWN_METHOD = /unknown method|no handler|method not found/i;

export async function assignItemClient(sendReq, { kind, id, clientId, previousClientId }) {
  if (typeof sendReq !== 'function') throw new Error('Not connected');
  if (!id) throw new Error('id is required');
  const next = clientId || null;
  try {
    return await sendReq('capture.assignClient', {
      kind,
      id,
      clientId: next,
      ...(previousClientId ? { previousClientId } : {}),
    });
  } catch (err) {
    if (!UNKNOWN_METHOD.test(String(err?.message || err))) throw err;
  }
  if (kind === 'idea') {
    await sendReq('ideas.update', { id, patch: { clientIds: next ? [next] : [] } });
  } else if (kind === 'note') {
    await sendReq('notes.update', { id, clientId: next || '' });
  } else {
    throw new Error('Linking a client to a task needs a newer gateway — restart it to pick up the update.');
  }
  return { kind, id, clientId: next, fallback: true };
}
