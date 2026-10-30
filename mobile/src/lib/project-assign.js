/**
 * Change the board project of an idea, note or task.
 *
 * Prefers the gateway's capture.assignProject (moves the item AND keeps the
 * relation indexes — project page, knowledge graph — in line). On a gateway
 * that predates it, falls back to each store's own update RPC so the item's
 * projectId still changes.
 */

const UNKNOWN_METHOD = /unknown method|no handler|not found: capture\.assignProject|method not found/i;

export async function assignItemProject(sendReq, { kind, id, projectId, previousProjectId }) {
  if (typeof sendReq !== 'function') throw new Error('Not connected');
  if (!id) throw new Error('id is required');
  const next = projectId || null;
  try {
    return await sendReq('capture.assignProject', {
      kind,
      id,
      projectId: next,
      ...(previousProjectId ? { previousProjectId } : {}),
    });
  } catch (err) {
    if (!UNKNOWN_METHOD.test(String(err?.message || err))) throw err;
  }
  if (kind === 'idea') {
    await sendReq('ideas.update', { id, patch: { projectIds: next ? [next] : [] } });
  } else if (kind === 'note') {
    await sendReq('notes.update', { id, projectId: next || '' });
  } else if (kind === 'task') {
    await sendReq('kanban.tasks.update', { id, patch: { projectId: next } });
    // Older gateways ignore projectId for Notion-backed tasks; set the relation directly.
    if (next) await sendReq('notion.update', { pageId: id, properties: { Project: { relation: [{ id: next }] } } }).catch(() => {});
  } else {
    throw new Error('kind must be idea | note | task');
  }
  return { kind, id, projectId: next, fallback: true };
}
