/** Knowledge Graph route params (infinibot://knowledge/graph|<nodeId>, ?family, layer, group). */

/** Stable signature of the deep-link params (focus / family / layer / group). */
export function deepLinkSig(p) {
  if (!p) return '';
  return [p.focus || p.nodeId || '', p.family ? 1 : 0, p.layer || '', p.group || '', p.project || '', p.hops || '', p._ts || ''].join('|');
}

export function deepLinkOf(p) {
  if (!p) return null;
  const focus = p.focus || p.nodeId || null;
  if (!focus && !p.layer && !p.group) return null;
  return { focus, family: !!p.family, layer: p.layer || null, group: p.group || null };
}

/** `{ id, name, hops }` when the route scopes the graph to one project (`?project=<id>`). */
export function projectScopeOf(p) {
  const raw = p && typeof p.project === 'string' ? p.project.trim() : '';
  if (!raw) return null;
  return { id: raw.replace(/^project:/, ''), name: p.projectName || null, hops: p.hops != null ? Number(p.hops) : 2 };
}
