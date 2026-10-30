/**
 * deep-links — the mobile side of docs/mobile/DEEP-LINKS.md (pure; unit-tested
 * in src/__tests__/deep-links.test.js).
 *
 *   parseDeepLink(url)            -> { path, segments, query, params } | null
 *   resolveDeepLink(url, {plugins}) -> a screen-registry entry
 *        ({ tab | screen | businessScreen | webPath, params?, title }) or a
 *        special { connect } / { unknown } — navigateToScreen() performs it.
 *
 * Accepted inputs (all normalised to one path grammar):
 *   infinibot://plugin/infinitrade/signals?signal=1
 *   https://<any host>/m/plugin/infinitrade/signals?signal=1   (web opener / App Link)
 *   mobile://chat?sessionKey=X                                  (legacy gateway link)
 *   /solatrix/alerts , /infinitrade?section=signals             (relative web path)
 */
import { resolvePluginPage, pluginPageForWebPath } from '../plugins/plugin-nav';

export const SCHEME = 'infinibot';

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parseQuery(qs) {
  const out = {};
  for (const part of String(qs || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = safeDecode((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    if (k) out[k] = i < 0 ? '' : safeDecode(part.slice(i + 1).replace(/\+/g, ' '));
  }
  return out;
}

/**
 * Reduce any accepted link form to `path?query` (no leading slash), or null.
 * Relative web paths come back as `web/<path>`.
 */
export function normalizeDeepLink(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = /^infinibot:\/\/\/?(.*)$/i.exec(s))) return m[1].replace(/#.*$/, '');
  // Expo Go / dev builds: exp://host:port/--/<path> carries the app link after "/--/".
  if ((m = /^exps?:\/\/[^/]+\/--\/(.*)$/i.exec(s))) return m[1].replace(/#.*$/, '');
  if ((m = /^mobile:\/\/chat\/?\?(.*)$/i.exec(s))) {
    const q = parseQuery(m[1]);
    return q.sessionKey ? `chat/${encodeURIComponent(q.sessionKey)}` : 'chat';
  }
  if ((m = /^https?:\/\/[^/]+\/m\/?(.*)$/i.exec(s))) return m[1].replace(/#.*$/, '');
  if ((m = /^https?:\/\/[^/]+(\/.*)?$/i.exec(s))) {
    // A plain web-UI URL (e.g. shared from the browser): treat its path as a web route.
    const p = (m[1] || '/').replace(/#.*$/, '');
    return `web${p === '/' ? '' : p}`;
  }
  if (s.startsWith('#/')) s = s.slice(1); // hash-style hrefs from proactive actions
  if (s.startsWith('/') && !s.startsWith('//')) return `web${s.replace(/#.*$/, '')}`;
  return null;
}

export function parseDeepLink(raw) {
  const norm = normalizeDeepLink(raw);
  if (norm == null) return null;
  const q = norm.indexOf('?');
  const path = (q < 0 ? norm : norm.slice(0, q)).replace(/^\/+|\/+$/g, '');
  const query = q < 0 ? '' : norm.slice(q + 1);
  const segments = path ? path.split('/').map(safeDecode) : [];
  return { path, segments, query, params: parseQuery(query) };
}

const TABS = {
  '': 'Dashboard', home: 'Dashboard', dashboard: 'Dashboard',
  board: 'Board', business: 'Business', knowledge: 'Knowledge', more: 'More',
};

/** Simple native screens addressable by a single path segment. */
const SIMPLE_SCREENS = {
  settings: 'SettingsScreen',
  notifications: 'NotificationsCenterScreen',
  terminals: 'TerminalsScreen',
  agents: 'AgentsScreen',
  autonomy: 'AutonomyScreen',
  reports: 'ReportsScreen',
  oversight: 'OversightScreen',
  grid: 'GridScreen',
  mesh: 'NeuralMeshScreen',
  credits: 'CreditsScreen',
  sessions: 'ActivityScreen',
  activity: 'ActivityScreen',
  memory: 'MemoryScreen',
  workflows: 'WorkflowsScreen',
  inbox: 'InboxScreen',
  email: 'InboxScreen',
  comms: 'CommsScreen',
  channels: 'CommsScreen',
  vault: 'VaultScreen',
  workspace: 'WorkspaceScreen',
  reviews: 'OversightScreen',
};

/** Short hosts for plugin pages with native screens: infinibot://whiteboard … */
const PLUGIN_PAGE_HOSTS = {
  whiteboard: ['whiteboard', 'whiteboard'],
  products: ['products', 'products'],
  'agency-daily': ['business-agency', 'agency-daily'],
  'agency-operations': ['business-agency', 'agency-operations'],
  'agency-topology': ['business-agency', 'agency-topology'],
};

/**
 * Core (non-plugin) web routes that have a native screen. A shared control-UI
 * link (or a chat link to one of these paths) opens the native page.
 */
export const WEB_NATIVE_SCREENS = {
  workspace: 'WorkspaceScreen',
  reviews: 'OversightScreen',
  oversight: 'OversightScreen',
  grid: 'GridScreen',
};

/**
 * Web routes that now have a native screen (formerly opened in the
 * WebSurface host). `/notes` is the web Documents workspace; `/autonomy`
 * carries its sub-tab in ?view=goals|phases|scheduled (any other view is the
 * native Autonomy board).
 */
function nativeForWebPath(segments, params) {
  const [p0 = '', p1, p2] = segments.map((x) => String(x));
  const head = p0.toLowerCase();
  const withParams = (screen, title, extra) => {
    const merged = { ...params, ...extra };
    return { screen, title, ...(Object.keys(merged).length ? { params: merged } : {}) };
  };
  switch (head) {
    case 'learn': return withParams('LearnScreen', 'Learn', p1 ? { trackId: p1 } : {});
    case 'inbox': case 'email': case 'emails': return withParams('InboxScreen', 'Inbox', p1 ? { view: p1 } : {});
    case 'reply-inbox': return withParams('InboxScreen', 'Inbox', { view: 'replies' });
    // Web /comms (and /messages) is the Channels page's Inbox sub-tab; /channels its connection cards.
    case 'comms': case 'messages': return withParams('CommsScreen', 'Channels', { view: 'inbox', ...(p1 ? { channel: p1 } : {}) });
    case 'channels': return withParams('CommsScreen', 'Channels', p1 ? { channel: p1 } : {});
    case 'notes': case 'documents': return withParams('DocumentsScreen', 'Documents', p1 ? { docId: p1 } : {});
    case 'vault': return withParams('VaultScreen', 'Vault', p1 ? { section: p1 } : {});
    case 'autonomy': {
      const v = String(params.view || '').toLowerCase();
      if (v === 'goals' || v === 'phases' || v === 'scheduled') return withParams('GoalsPhasesScreen', 'Goals & Phases', {});
      return null;
    }
    default: return null;
  }
}

const webEntry = (webPath, title, extra = {}) => ({ webPath, title, ...extra });

function withQuery(path, query) {
  if (!query) return path;
  return path + (path.includes('?') ? '&' : '?') + query;
}

/**
 * Map a deep link to a navigation entry.
 * @param plugins the latest plugins.list result (or null when unknown)
 */
export function resolveDeepLink(raw, { plugins = null } = {}) {
  const link = parseDeepLink(raw);
  if (!link) return { unknown: true, reason: 'unparseable' };
  const { segments, query, params } = link;
  const [head = '', a, b, ...rest] = segments;
  const h = head.toLowerCase();

  // Pairing: infinibot://connect?url=…&token=…
  if (h === 'connect') return { connect: params, title: 'Connect' };

  if (h === 'chat' || (h === 'activity' && a === 'session')) {
    const sk = h === 'chat' ? a : b;
    return { tab: 'Chat', params: sk ? { sessionKey: sk } : undefined, sessionKey: sk || null, title: 'Chat' };
  }
  if (h === 'board') {
    const taskId = a === 'task' ? b : a;
    return { tab: 'Board', params: taskId ? { taskId } : undefined, title: 'Board' };
  }
  if (h in TABS && !a) return { tab: TABS[h], title: TABS[h] };

  // Knowledge graph (native): infinibot://knowledge/graph[?focus=<nodeId>],
  // infinibot://knowledge/<nodeId> (e.g. knowledge/project:abc),
  // infinibot://graph[/<nodeId>]; knowledge/<ideas|notes|research|workflows>
  // open those Knowledge-tab screens.
  if (h === 'knowledge' || h === 'graph' || h === 'knowledge-graph') {
    const KNOWLEDGE_SCREENS = { ideas: 'Ideas', notes: 'Notes', research: 'Research', workflows: 'Workflows' };
    if (h === 'knowledge' && a && KNOWLEDGE_SCREENS[a.toLowerCase()]) {
      const screen = KNOWLEDGE_SCREENS[a.toLowerCase()];
      return { tab: 'Knowledge', params: { screen }, title: screen };
    }
    const nodeId = h === 'knowledge' ? (a === 'graph' ? b : a) : a;
    return graphEntry(nodeId || params.focus, params);
  }
  if (h === 'reports' && a) {
    return { screen: 'ReportsScreen', params: { reportId: a }, title: 'Reports' };
  }

  // Voice = the InfiniBot call page (local voice by default). The Robovoice
  // console stays reachable as the cloud option: infinibot://robovoice, or the
  // call page's Voice engine › Cloud.
  if (h === 'voice' || h === 'call') return { screen: 'InfiniCallScreen', title: 'InfiniBot', ...(query ? { params: Object.fromEntries(new URLSearchParams(query)) } : {}) };
  if (h === 'robovoice') return webEntry(withQuery('/voice', query), 'Robovoice', { embed: true });
  if (h === 'ideas' || h === 'idea') return { tab: 'Knowledge', params: { screen: 'Ideas' }, title: 'Ideas' };
  if (h === 'documents' || h === 'notes') {
    const p = { ...params, ...(a ? { docId: a } : {}) };
    return { screen: 'DocumentsScreen', title: 'Documents', ...(Object.keys(p).length ? { params: p } : {}) };
  }
  // Agent Mesh: infinibot://mesh[?focus=<sessionKey|runId>&review=<runId>],
  // infinibot://mesh/<sessionKey|runId>, infinibot://mesh/review/<runId>.
  if (h === 'mesh' || h === 'agent-mesh') return meshEntry(a, b, params);
  if (h === 'runs' || h === 'run') {
    return { screen: 'OversightScreen', params: a ? { runId: a } : undefined, title: 'Run' };
  }
  if (h === 'approvals' || h === 'approval') {
    return { screen: 'ApprovalsScreen', params: a ? { approvalId: a } : undefined, title: 'Approvals' };
  }
  // Goals / Phases / Scheduled are the three tabs of the native Goals & Phases screen.
  if (h === 'goals' || h === 'goal') {
    return { screen: 'GoalsPhasesScreen', params: { view: 'goals', ...(a ? { goal: a } : {}) }, title: 'Goals' };
  }
  if (h === 'phases' || h === 'phase') {
    return { screen: 'GoalsPhasesScreen', params: { view: 'phases', ...(a ? { phase: a } : {}) }, title: 'Phases' };
  }
  if (h === 'scheduled') {
    return { screen: 'GoalsPhasesScreen', params: { view: 'scheduled', ...(a ? { task: a } : {}) }, title: 'Scheduled tasks' };
  }
  if (h === 'learn') {
    // Native Learn; a track id opens that track, a walkthrough id its steps.
    const p = { ...params, ...(a ? { trackId: a } : {}), ...(b ? { walkthrough: b } : {}) };
    return { screen: 'LearnScreen', title: 'Learn', ...(Object.keys(p).length ? { params: p } : {}) };
  }
  if (h === 'plugins') {
    return { screen: 'PluginsScreen', params: a ? { pluginId: a } : undefined, title: 'Plugins' };
  }
  if (h === 'plugin' && a) {
    return resolvePluginLink(plugins, a, b, query, rest);
  }
  if (h === 'discipline') {
    // Legacy alert link (extensions/discipline). Prefer the plugin page.
    if (plugins) return resolvePluginLink(plugins, 'discipline', a, query, []);
    return { screen: 'DisciplineScreen', title: 'Discipline' };
  }
  if (h === 'web') {
    // The web knowledge graph has a native screen.
    if ((a || '').toLowerCase() === 'knowledge-graph') return graphEntry(b || params.focus, params);
    // So does the web agent mesh.
    if ((a || '').toLowerCase() === 'mesh') return meshEntry(b, rest[0], params);
    const native = nativeForWebPath(segments.slice(1), params);
    if (native) return native;
    const webPath = '/' + segments.slice(1).map(encodeURIComponent).join('/');
    const nativeCore = WEB_NATIVE_SCREENS[(a || '').toLowerCase()];
    if (nativeCore && segments.length <= 2) {
      // /reviews?run=<id> keeps its run focus on the native Reviews screen.
      const p = { ...params };
      if (nativeCore === 'OversightScreen' && p.run && !p.runId) p.runId = p.run;
      return { screen: nativeCore, params: Object.keys(p).length ? p : undefined, title: a };
    }
    if (plugins) {
      const owner = pluginPageForWebPath(plugins, webPath);
      if (owner) {
        // Exact page route → the page (native when the app has it); a deeper
        // path under a page route stays on the web so nothing is lost.
        if (owner.exact) return resolvePluginLink(plugins, owner.pluginId, owner.page.tab, query, []);
        const p = resolvePluginPage(plugins, owner.pluginId, null);
        if (p.disabled) return { screen: 'PluginsScreen', params: { pluginId: owner.pluginId, reason: 'disabled' }, title: 'Plugins' };
      }
    }
    return webEntry(withQuery(webPath, query), 'InfiniBot');
  }
  if (h in PLUGIN_PAGE_HOSTS) {
    const [pluginId, page] = PLUGIN_PAGE_HOSTS[h];
    return resolvePluginLink(plugins, pluginId, page, query, []);
  }
  if (h in SIMPLE_SCREENS) {
    return { screen: SIMPLE_SCREENS[h], params: Object.keys(params).length ? params : undefined, title: h };
  }
  return { unknown: true, reason: `no route for "${h}"` };
}

/** Agent Mesh entry; `a` is an agent/run id, or `review` followed by a run id. */
export function meshEntry(a, b, params = {}) {
  const p = {};
  if (a && a.toLowerCase() === 'review' && b) p.review = b;
  else if (a) p.focus = a;
  if (!p.focus && params.focus) p.focus = params.focus;
  if (!p.review && params.review) p.review = params.review;
  return { screen: 'NeuralMeshScreen', params: Object.keys(p).length ? p : undefined, title: 'Agent Mesh' };
}

/** Knowledge-tab › KnowledgeGraph entry, optionally focused on a node / project family. */
export function graphEntry(nodeId, params = {}) {
  const p = {};
  if (nodeId) p.focus = nodeId;
  if (params.project) p.project = params.project;
  if (params.project && params.hops) p.hops = params.hops;
  if (params.project && params.projectName) p.projectName = params.projectName;
  if (params.family === '1' || params.family === 'true') p.family = true;
  return { tab: 'Knowledge', params: { screen: 'KnowledgeGraph', ...(Object.keys(p).length ? { params: p } : {}) }, title: 'Knowledge Graph' };
}

function resolvePluginLink(plugins, pluginId, page, query, rest) {
  if (!plugins) {
    // Plugin list not loaded yet (cold start before the socket is up): the
    // plugin's web route is the safest guess; the caller retries once plugins load.
    return { pending: true, pluginId, page, query };
  }
  const pageKey = page ? [page, ...rest].join('/') : null;
  const r = resolvePluginPage(plugins, pluginId, rest.length ? page : pageKey, query);
  if (r.unknown) return { screen: 'PluginsScreen', params: { pluginId, reason: 'unknown' }, title: 'Plugins' };
  if (r.disabled) return { screen: 'PluginsScreen', params: { pluginId, reason: 'disabled' }, title: 'Plugins' };
  const e = r.entry;
  if (e.query && !e.webPath) {
    // Native screen: hand query params to it as route params.
    return { ...e, params: { ...(e.params || {}), ...parseQuery(e.query) } };
  }
  return e;
}

/** Build a deep link (used by the app for share / "copy link"). */
export function buildDeepLink(path, query) {
  const p = String(path || '').replace(/^\/+/, '');
  const qs = query && typeof query === 'object'
    ? Object.entries(query).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : String(query || '');
  return `${SCHEME}://${p}${qs ? `?${qs}` : ''}`;
}

/**
 * Pick the deep link out of a notification payload (push `data`, in-app
 * `notification.created`, proactive event). Falls back to the legacy
 * type/sessionKey fields so old pushes still land somewhere sensible.
 */
export function deepLinkFromNotificationData(data) {
  if (!data || typeof data !== 'object') return null;
  const direct = data.deepLink || data.link?.deepLink || data.url || data.webUrl || data.link?.webUrl;
  if (typeof direct === 'string' && direct) return direct;
  const type = data.type ?? data.category ?? data.kind;
  const sk = data.sessionKey;
  if (data.approvalId) return buildDeepLink(`approvals/${encodeURIComponent(data.approvalId)}`);
  if (data.runId && (type === 'verification' || type === 'verdict')) return buildDeepLink(`runs/${encodeURIComponent(data.runId)}`);
  switch (type) {
    case 'agent_start':
    case 'autonomy':
      return buildDeepLink('autonomy');
    case 'agent_message': case 'chat': case 'agent.completed': case 'agent.error': case 'agent.input_required':
    case 'session': case 'activity':
      return sk ? buildDeepLink(`chat/${encodeURIComponent(sk)}`) : buildDeepLink('chat');
    case 'task_update': case 'kanban': case 'kanban.task.completed': case 'kanban.task.assigned': case 'kanban.task.due':
      return buildDeepLink('board');
    case 'discipline': case 'discipline.alert':
      return buildDeepLink('plugin/discipline');
    default:
      return sk ? buildDeepLink(`chat/${encodeURIComponent(sk)}`) : null;
  }
}
