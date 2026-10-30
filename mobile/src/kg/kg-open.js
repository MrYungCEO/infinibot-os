/**
 * "Open" for a graph node → the app's own screen (never the web page).
 * Projects / tasks → Board, notes → Notes (the note), documents → Notes (the
 * doc), research → Research, ideas → Ideas (the idea), reports → Reports (the
 * report), runs → Oversight, agents → Agents, business objects → their
 * Business screens.
 */
import * as core from './generated/kg-core';

const { storeIdOf } = core;

function isResearch(node) {
  const tags = Array.isArray(node.meta?.tags) ? node.meta.tags : [];
  return tags.some((t) => String(t).toLowerCase() === 'research') || node.meta?.category === 'research';
}

/** A navigateToScreen() entry for the node, or null when the phone has no page for it. */
export function openTargetFor(node) {
  if (!node) return null;
  const raw = storeIdOf(node);
  switch (node.kind) {
    case 'project':
      return { tab: 'Board', params: { projectId: raw }, title: node.label };
    case 'task':
      return { tab: 'Board', params: { taskId: raw }, title: node.label };
    case 'note':
      if (isResearch(node)) return { tab: 'Knowledge', params: { screen: 'Research' }, title: 'Research' };
      if (raw.startsWith('doc:')) return { tab: 'Knowledge', params: { screen: 'Notes', params: { docId: raw.slice(4) } }, title: node.label };
      return { tab: 'Knowledge', params: { screen: 'Notes', params: { noteId: raw } }, title: node.label };
    case 'idea':
      return { tab: 'Knowledge', params: { screen: 'Ideas', params: { ideaId: raw } }, title: 'Ideas' };
    case 'report':
      if (isResearch(node)) return { tab: 'Knowledge', params: { screen: 'Research' }, title: 'Research' };
      return { screen: 'ReportsScreen', params: { reportId: raw }, title: 'Reports' };
    case 'run':
      return { screen: 'OversightScreen', params: { runId: node.meta?.runId || raw }, title: 'Run' };
    case 'agent':
      return { screen: 'AgentsScreen', title: 'Agents' };
    case 'opportunity':
      return { businessScreen: 'Opportunities', title: 'Opportunities' };
    case 'decision':
      return { businessScreen: 'Decisions', title: 'Decisions' };
    case 'person':
      return { businessScreen: 'People', title: 'People' };
    case 'client':
      return { businessScreen: 'Clients', title: 'Clients' };
    case 'product':
      return { businessScreen: 'ProductRegistry', title: 'Product Portfolio' };
    default:
      return null;
  }
}

export function canOpenNode(node) {
  return openTargetFor(node) != null;
}
