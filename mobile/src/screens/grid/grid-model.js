/**
 * grid-model — pure layout + catalogue logic for the native Grid
 * (web /grid: ui/src/ui/controllers/masonry-grid.ts + views/masonry-grid.ts).
 *
 * Persistence parity: the web grid keeps its layout in localStorage
 * ("infinibot-masonry-layout") — there is NO gateway-backed layout RPC — so
 * the phone keeps its own copy in AsyncStorage. The stored shape mirrors the
 * web MasonryGridState (canvases → panels with x/y/width/height/zIndex and the
 * same per-type fields: sessionKey, kanbanProjectId, databaseId,
 * terminalSessionId, viewKind, agencyOpsSection, groupId) so a future
 * gateway sync can move layouts between the two without translation.
 *
 * Phone additions: `mode` ('stack' | 'canvas') — a phone-friendly vertical
 * stack next to the free canvas — and per-panel `stackHeight`.
 *
 * No React / react-native imports: unit-tested in node (__tests__/grid-model.test.js).
 */

export const STORAGE_KEY = '@infinibot/grid_layout_v2';
export const LEGACY_STORAGE_KEY = '@moltbot/grid_layout_v1';

export const MIN_PANEL_W = 200; // web MIN_PANEL_WIDTH
export const MIN_PANEL_H = 150; // web MIN_PANEL_HEIGHT
export const MAX_CANVASES = 5; // web MAX_CANVASES
export const CANVAS_NAMES = ['Main', 'Work', 'Research', 'Focus', 'Quick'];
export const STACK_MIN_H = 220;
export const STACK_MAX_H = 900;

export const PANEL_CATEGORIES = ['Ops', 'Agents', 'Data', 'Media', 'Voice', 'Work'];

// ── Catalogue (web getPanelCatalog: native entries + VIEW_PANEL_DEFS + AGENCY_OPS_TAB_DEFS) ──
// Icons are Ionicons names (the web uses emoji glyphs; the app never does).
const NATIVE_ENTRIES = [
  { id: 'native:voice', type: 'voice', title: 'Voice Cockpit', description: 'Start a voice call, open the live call.', icon: 'mic-outline', category: 'Voice', w: 420, h: 360, keywords: 'microphone speech stt tts call' },
  { id: 'native:session', type: 'session', title: 'Chat Session', description: 'A conversational agent chat panel.', icon: 'chatbubbles-outline', category: 'Agents', w: 480, h: 500, keywords: 'message conversation' },
  { id: 'native:group_chat', type: 'group_chat', title: 'Group Chat', description: 'Talk to several agents at once.', icon: 'people-outline', category: 'Agents', w: 760, h: 560, keywords: 'agents team conversation' },
  { id: 'native:workflow_builder', type: 'workflow_builder', title: 'Workflow Builder', description: 'Conversation workflows: steps, runs and edits.', icon: 'git-merge-outline', category: 'Agents', w: 920, h: 620, keywords: 'workflow steps pipeline run' },
  { id: 'native:terminal', type: 'terminal', title: 'Terminal', description: 'Shell or coding-CLI terminal (Claude / Codex / ...).', icon: 'terminal-outline', category: 'Agents', w: 640, h: 460, keywords: 'cli claude codex opencode gemini ollama shell' },
  { id: 'native:kanban', type: 'kanban', title: 'Kanban', description: 'Project + task board (gallery or single project).', icon: 'albums-outline', category: 'Work', w: 720, h: 560, keywords: 'board tasks projects' },
  { id: 'native:projects', type: 'projects', title: 'Projects', description: 'Projects gallery with progress and status.', icon: 'folder-open-outline', category: 'Work', w: 720, h: 560, keywords: 'kanban' },
  { id: 'native:tasks', type: 'tasks', title: 'Tasks', description: 'Task list scoped to a project.', icon: 'checkbox-outline', category: 'Work', w: 560, h: 520, keywords: 'todo' },
  { id: 'native:knowledgeGraph', type: 'knowledgeGraph', title: 'Knowledge Graph', description: 'Live knowledge graph map.', icon: 'share-social-outline', category: 'Data', w: 640, h: 520, keywords: 'graph nodes' },
  { id: 'native:database', type: 'database', title: 'Database', description: 'Browse a database / table.', icon: 'server-outline', category: 'Data', w: 720, h: 560, keywords: 'table records' },
  { id: 'native:activity', type: 'activity', title: 'Activity Feed', description: 'Compact live agent activity feed.', icon: 'pulse-outline', category: 'Agents', w: 420, h: 560, keywords: 'events log subagents sessions' },
  { id: 'native:credits', type: 'credits', title: 'Credit Usage', description: 'Credit + token usage breakdown.', icon: 'wallet-outline', category: 'Data', w: 480, h: 520, keywords: 'cost tokens billing' },
  { id: 'native:chart', type: 'chart', title: 'Chart', description: 'Market chart: crypto pairs and Solana tokens.', icon: 'stats-chart-outline', category: 'Data', w: 600, h: 480, keywords: 'metric graph line price' },
  { id: 'native:canvas', type: 'canvas', title: 'Canvas', description: 'Freeform drawing / whiteboard canvas.', icon: 'brush-outline', category: 'Media', w: 640, h: 520, keywords: 'whiteboard draw excalidraw', plugin: 'whiteboard' },
  { id: 'native:video', type: 'video', title: 'Video Feed', description: 'Live camera feed to your agent.', icon: 'videocam-outline', category: 'Media', w: 480, h: 400, keywords: 'camera stream' },
  { id: 'native:gpu', type: 'gpu', title: 'GPU', description: 'GPU and node load, VRAM and temperature.', icon: 'hardware-chip-outline', category: 'Media', w: 420, h: 500, keywords: 'particles fx hardware vram' },
];

export const VIEW_KINDS = {
  notes: { title: 'Notes', description: 'Your notebook: capture and edit notes.', icon: 'create-outline', category: 'Work', open: { tab: 'Knowledge', params: { screen: 'Notes' } } },
  research: { title: 'Research Intel', description: 'Watchlist topics, saved articles and market signals.', icon: 'search-outline', category: 'Data', open: { tab: 'Knowledge', params: { screen: 'Research' } } },
  clients: { title: 'Clients (CRM)', description: 'Client roster, statuses and revenue at a glance.', icon: 'people-outline', category: 'Ops', open: { businessScreen: 'Clients' } },
  funnels: { title: 'Funnels', description: 'Funnel map: stages, deals and flow.', icon: 'funnel-outline', category: 'Ops', open: { businessScreen: 'Opportunities' } },
  autonomy: { title: 'Autonomy', description: 'Autonomous run status, approvals and controls.', icon: 'rocket-outline', category: 'Agents', open: { screen: 'AutonomyScreen' } },
  agentActivity: { title: 'Agent Activity', description: 'Full agent activity dashboard and session history.', icon: 'radio-outline', category: 'Agents', open: { screen: 'ActivityScreen' } },
  reports: { title: 'Reports', description: 'Generated reports, schedules and delivery sinks.', icon: 'reader-outline', category: 'Media', open: { screen: 'ReportsScreen' } },
  business: { title: 'Business HQ', description: 'Business command center: systems and KPIs.', icon: 'business-outline', category: 'Ops', open: { tab: 'Business' } },
  // Phone-only extras (legacy mobile panels from the WebView grid).
  agencyDaily: { title: 'Agency Today', description: "Today's work queue, reviews and approvals.", icon: 'today-outline', category: 'Ops', open: { screen: 'AgencyDailyScreen' }, plugin: 'business-agency', phoneOnly: true },
  contentIntel: { title: 'Content Intel', description: 'Reel scores, tiers and a playable library.', icon: 'analytics-outline', category: 'Media', open: { screen: 'ContentIntelScreen' }, plugin: 'content-studio', phoneOnly: true },
  workspace: { title: 'Workspace', description: 'Per-project files, diffs and coder chat.', icon: 'code-slash-outline', category: 'Agents', open: { screen: 'WorkspaceScreen' }, phoneOnly: true },
  oversight: { title: 'Reviews', description: 'Review every agent run: verdicts and follow-ups.', icon: 'shield-checkmark-outline', category: 'Agents', open: { screen: 'OversightScreen' }, phoneOnly: true },
};

const VIEW_SIZES = { notes: [640, 560], research: [760, 600], clients: [820, 600], funnels: [820, 600], autonomy: [720, 580], agentActivity: [780, 600], reports: [760, 600], business: [820, 600] };

export const AGENCY_SECTIONS = {
  overview: { title: 'Command Center', description: 'Agency command center: revenue, delivery, decisions.', icon: 'speedometer-outline' },
  allocation: { title: 'Work Allocation', description: 'Live workforce allocation and capacity.', icon: 'bar-chart-outline' },
  approvals: { title: 'Approvals', description: 'Approval inbox: decisions awaiting your call.', icon: 'checkmark-done-outline' },
  activity: { title: 'Activity & Audit', description: 'Agency activity feed and audit trail.', icon: 'list-outline' },
  employees: { title: 'Employees', description: 'Human + AI employees and their profiles.', icon: 'id-card-outline' },
};

export const PANEL_CATALOG = [
  ...NATIVE_ENTRIES,
  ...Object.entries(VIEW_KINDS).map(([kind, v]) => ({
    id: `view:${kind}`,
    type: 'view',
    viewKind: kind,
    title: v.title,
    description: v.description,
    icon: v.icon,
    category: v.category,
    w: (VIEW_SIZES[kind] || [720, 560])[0],
    h: (VIEW_SIZES[kind] || [720, 560])[1],
    plugin: v.plugin,
  })),
  ...Object.entries(AGENCY_SECTIONS).map(([section, v]) => ({
    id: `agencyOps:${section}`,
    type: 'agencyOps',
    agencyOpsSection: section,
    title: v.title,
    description: v.description,
    icon: v.icon,
    category: 'Ops',
    w: 820,
    h: 600,
    plugin: 'business-agency',
  })),
];

export const PANEL_TYPES = [
  'session', 'group_chat', 'workflow_builder', 'canvas', 'chart', 'video', 'gpu', 'kanban', 'database',
  'terminal', 'activity', 'voice', 'projects', 'tasks', 'knowledgeGraph', 'credits', 'view', 'agencyOps',
];

/** Default phone stack height for a panel body (chat/terminal want room). */
export function defaultStackHeight(type) {
  switch (type) {
    case 'session':
    case 'group_chat':
    case 'workflow_builder':
    case 'terminal':
      return 480;
    case 'kanban':
    case 'projects':
    case 'tasks':
    case 'database':
    case 'activity':
    case 'knowledgeGraph':
    case 'agencyOps':
      return 420;
    case 'chart':
    case 'credits':
    case 'gpu':
      return 380;
    default:
      return 260;
  }
}

/** Catalogue entry for a stored panel (by viewKind / section for adapters). */
export function catalogEntryFor(panel) {
  if (!panel) return null;
  if (panel.type === 'view') return PANEL_CATALOG.find((e) => e.type === 'view' && e.viewKind === panel.viewKind) || null;
  if (panel.type === 'agencyOps') return PANEL_CATALOG.find((e) => e.type === 'agencyOps' && e.agencyOpsSection === (panel.agencyOpsSection || 'overview')) || null;
  return PANEL_CATALOG.find((e) => e.type === panel.type) || null;
}

export function panelIcon(panel) {
  return catalogEntryFor(panel)?.icon || 'square-outline';
}

/** Search + category filter for the add-panel picker (web renderAddPanelMenu). */
export function filterCatalog(catalog, query, category) {
  const q = String(query || '').trim().toLowerCase();
  return catalog.filter((e) => {
    if (category && e.category !== category) return false;
    if (!q) return true;
    return `${e.title} ${e.description} ${e.category} ${e.keywords || ''}`.toLowerCase().includes(q);
  });
}

/** Group picker matches by category in chip order (empty groups dropped). */
export function groupCatalog(entries) {
  return PANEL_CATEGORIES.map((cat) => ({ cat, items: entries.filter((e) => e.category === cat) })).filter((g) => g.items.length > 0);
}

// ── Text hygiene ─────────────────────────────────────────────────────────────
// The app never renders emoji; web panel titles / gateway labels often carry them.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2190}-\u{21FF}\u{25A0}-\u{25FF}\u{2300}-\u{23FF}\u{3030}\u{303D}\u{3297}\u{3299}\u{00A9}\u{00AE}\u{2122}]/gu;

export function stripEmoji(s) {
  return String(s ?? '').replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// ── Ids ──────────────────────────────────────────────────────────────────────
let seq = 0;
export function newPanelId(now = Date.now()) {
  seq += 1;
  return `panel-${now}-${seq}`;
}

export function newSessionKey(now = Date.now()) {
  // Same shape the web uses for "+ Chat Session" (handleAddChatSessionPanel).
  return `grid-session-${now}`;
}

// ── State ────────────────────────────────────────────────────────────────────
function makeCanvas(index) {
  return { id: `canvas-${index}`, name: CANVAS_NAMES[index] || `Canvas ${index + 1}`, panels: [], activePanel: null, maxZIndex: 1 };
}

export function emptyState() {
  return { version: 2, mode: 'stack', activeCanvasId: 'canvas-0', canvases: [makeCanvas(0)], view: { tx: 0, ty: 0, scale: 1 } };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function sanitizePanel(p) {
  if (!p || typeof p !== 'object' || !p.id) return null;
  if (!PANEL_TYPES.includes(p.type)) return null;
  const out = {
    ...p,
    title: stripEmoji(p.title) || catalogEntryFor(p)?.title || 'Panel',
    sessionKey: typeof p.sessionKey === 'string' ? p.sessionKey : '',
    x: num(p.x, 24),
    y: num(p.y, 24),
    width: Math.max(MIN_PANEL_W, num(p.width, 480)),
    height: Math.max(MIN_PANEL_H, num(p.height, 400)),
    zIndex: num(p.zIndex, 1),
    minimized: Boolean(p.minimized),
    maximized: false,
  };
  if (p.stackHeight != null) out.stackHeight = clamp(num(p.stackHeight, defaultStackHeight(p.type)), STACK_MIN_H, STACK_MAX_H);
  if (out.type === 'view' && !VIEW_KINDS[out.viewKind]) return null;
  if (out.type === 'agencyOps' && !AGENCY_SECTIONS[out.agencyOpsSection]) out.agencyOpsSection = 'overview';
  return out;
}

function sanitizeCanvas(c, i) {
  if (!c || typeof c !== 'object') return null;
  const panels = (Array.isArray(c.panels) ? c.panels : []).map(sanitizePanel).filter(Boolean);
  return {
    id: typeof c.id === 'string' && c.id ? c.id : `canvas-${i}`,
    name: stripEmoji(c.name) || CANVAS_NAMES[i] || `Canvas ${i + 1}`,
    panels,
    activePanel: panels.some((p) => p.id === c.activePanel) ? c.activePanel : null,
    maxZIndex: Math.max(1, num(c.maxZIndex, 1), ...panels.map((p) => p.zIndex)),
  };
}

/** Any stored layout (v2, a web-shaped MasonryGridState, or junk) → a valid state. */
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return emptyState();
  let canvases;
  if (Array.isArray(raw.canvases)) canvases = raw.canvases.map(sanitizeCanvas).filter(Boolean).slice(0, MAX_CANVASES);
  else if (Array.isArray(raw.panels)) canvases = [sanitizeCanvas({ id: 'canvas-0', name: 'Main', panels: raw.panels }, 0)];
  else canvases = [];
  if (canvases.length === 0) canvases = [makeCanvas(0)];
  const activeCanvasId = canvases.some((c) => c.id === raw.activeCanvasId) ? raw.activeCanvasId : canvases[0].id;
  const v = raw.view && typeof raw.view === 'object' ? raw.view : {};
  return {
    version: 2,
    mode: raw.mode === 'canvas' ? 'canvas' : 'stack',
    activeCanvasId,
    canvases,
    view: { tx: num(v.tx, 0), ty: num(v.ty, 0), scale: clamp(num(v.scale, 1), 0.35, 2.5) },
  };
}

// The first mobile grid (WebView panels) stored { panels: [{type,title,path,x,y,w,h,z}], tf }.
const LEGACY_TYPE_MAP = {
  session: { type: 'session' },
  kanban: { type: 'kanban' },
  activity: { type: 'activity' },
  terminal: { type: 'terminal' },
  agencyOps: { type: 'agencyOps', agencyOpsSection: 'overview' },
  agencyDaily: { type: 'view', viewKind: 'agencyDaily' },
  credits: { type: 'credits' },
  knowledgeGraph: { type: 'knowledgeGraph' },
  notes: { type: 'view', viewKind: 'notes' },
  voice: { type: 'voice' },
  research: { type: 'view', viewKind: 'research' },
  clients: { type: 'view', viewKind: 'clients' },
  content: { type: 'view', viewKind: 'contentIntel' },
};

export function migrateLegacy(raw, now = Date.now()) {
  if (!raw || !Array.isArray(raw.panels)) return null;
  const panels = raw.panels
    .map((p, i) => {
      const m = LEGACY_TYPE_MAP[p?.type];
      if (!m) return null;
      const entry = catalogEntryFor(m);
      return {
        id: String(p.id || `panel-${now}-${i}`),
        ...m,
        sessionKey: m.type === 'session' ? newSessionKey(now + i) : '',
        title: entry?.title || stripEmoji(p.title) || 'Panel',
        x: num(p.x, 24),
        y: num(p.y, 24),
        width: Math.max(MIN_PANEL_W, num(p.w, 320)),
        height: Math.max(MIN_PANEL_H, num(p.h, 380)),
        zIndex: num(p.z, i + 1),
        minimized: false,
        maximized: false,
      };
    })
    .filter(Boolean);
  const tf = raw.tf && typeof raw.tf === 'object' ? raw.tf : {};
  return sanitizeState({ mode: 'canvas', canvases: [{ id: 'canvas-0', name: 'Main', panels }], view: { tx: tf.tx, ty: tf.ty, scale: tf.scale } });
}

export function activeCanvas(state) {
  return state.canvases.find((c) => c.id === state.activeCanvasId) || state.canvases[0];
}

function mapActive(state, fn) {
  const id = activeCanvas(state).id;
  return { ...state, canvases: state.canvases.map((c) => (c.id === id ? fn(c) : c)) };
}

/** New panel record from a catalogue entry, cascaded like the web grid. */
export function createPanel(entry, canvas, opts = {}) {
  const now = opts.now ?? Date.now();
  const n = canvas?.panels?.length || 0;
  const offset = (n % 6) * 26;
  const z = (canvas?.maxZIndex || 1) + 1;
  const scale = opts.canvasScale || 0.62; // phone canvas: web sizes are desktop px
  const panel = {
    id: newPanelId(now),
    type: entry.type,
    sessionKey: entry.type === 'session' ? newSessionKey(now) : '',
    title: entry.title,
    x: 16 + offset,
    y: 16 + offset,
    width: Math.max(MIN_PANEL_W + 60, Math.round((entry.w || 480) * scale)),
    height: Math.max(MIN_PANEL_H + 150, Math.round((entry.h || 420) * scale)),
    zIndex: z,
    minimized: false,
    maximized: false,
  };
  if (entry.viewKind) panel.viewKind = entry.viewKind;
  if (entry.agencyOpsSection) panel.agencyOpsSection = entry.agencyOpsSection;
  if (entry.type === 'kanban' || entry.type === 'projects' || entry.type === 'tasks') panel.kanbanProjectId = null;
  if (entry.type === 'database') panel.databaseId = null;
  if (entry.type === 'terminal') { panel.terminalSessionId = null; panel.terminalCli = opts.cli || 'shell'; panel.terminalNodeId = 'local'; }
  if (opts.sessionKey) panel.sessionKey = opts.sessionKey;
  if (opts.title) panel.title = opts.title;
  return panel;
}

export function addPanel(state, entry, opts) {
  let added = null;
  const next = mapActive(state, (c) => {
    added = createPanel(entry, c, opts);
    return { ...c, panels: [...c.panels, added], activePanel: added.id, maxZIndex: added.zIndex };
  });
  return { state: next, panel: added };
}

export function removePanel(state, id) {
  return mapActive(state, (c) => ({ ...c, panels: c.panels.filter((p) => p.id !== id), activePanel: c.activePanel === id ? null : c.activePanel }));
}

export function patchPanel(state, id, patch) {
  return mapActive(state, (c) => ({ ...c, panels: c.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
}

export function focusPanel(state, id) {
  return mapActive(state, (c) => {
    const p = c.panels.find((x) => x.id === id);
    if (!p) return c;
    if (c.activePanel === id && p.zIndex === c.maxZIndex) return c;
    const z = c.maxZIndex + 1;
    return { ...c, activePanel: id, maxZIndex: z, panels: c.panels.map((x) => (x.id === id ? { ...x, zIndex: z } : x)) };
  });
}

/** Stack order = array order. dir -1 = up, +1 = down. */
export function movePanel(state, id, dir) {
  const cur = activeCanvas(state);
  const i0 = cur.panels.findIndex((p) => p.id === id);
  if (i0 < 0 || i0 + dir < 0 || i0 + dir >= cur.panels.length) return state;
  return mapActive(state, (c) => {
    const i = c.panels.findIndex((p) => p.id === id);
    const j = i + dir;
    const panels = [...c.panels];
    [panels[i], panels[j]] = [panels[j], panels[i]];
    return { ...c, panels };
  });
}

export function resizeStackPanel(state, id, delta) {
  const p = activeCanvas(state).panels.find((x) => x.id === id);
  if (!p) return state;
  const cur = p.stackHeight ?? defaultStackHeight(p.type);
  return patchPanel(state, id, { stackHeight: clamp(cur + delta, STACK_MIN_H, STACK_MAX_H) });
}

export function clearCanvas(state) {
  return mapActive(state, (c) => ({ ...c, panels: [], activePanel: null }));
}

export function setMode(state, mode) {
  return { ...state, mode: mode === 'canvas' ? 'canvas' : 'stack' };
}

export function setView(state, view) {
  return { ...state, view: { tx: num(view.tx, 0), ty: num(view.ty, 0), scale: clamp(num(view.scale, 1), 0.35, 2.5) } };
}

/** Web workspace buttons 1..5: switch, creating canvases up to that slot. */
export function switchToCanvasSlot(state, index) {
  if (index < 0 || index >= MAX_CANVASES) return state;
  const canvases = [...state.canvases];
  while (canvases.length <= index) canvases.push(makeCanvas(canvases.length));
  return { ...state, canvases, activeCanvasId: canvases[index].id };
}

/** Web tileGrid: near-square grid that fills the viewport (canvas coords). */
export function tileCanvas(state, viewportW, viewportH, gap = 8) {
  return mapActive(state, (c) => {
    const n = c.panels.length;
    if (!n) return c;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const w = Math.max(MIN_PANEL_W, Math.floor((viewportW - gap * (cols + 1)) / cols));
    const h = Math.max(MIN_PANEL_H, Math.floor((viewportH - gap * (rows + 1)) / rows));
    return {
      ...c,
      panels: c.panels.map((p, i) => ({
        ...p,
        x: gap + (i % cols) * (w + gap),
        y: gap + Math.floor(i / cols) * (h + gap),
        width: w,
        height: h,
        minimized: false,
      })),
    };
  });
}

/** Canvas "maximize": fill the visible viewport, remembering prior geometry. */
export function toggleMaximize(state, id, viewport) {
  return mapActive(state, (c) => {
    const z = c.maxZIndex + 1;
    return {
      ...c,
      maxZIndex: z,
      activePanel: id,
      panels: c.panels.map((p) => {
        if (p.id !== id) return p;
        if (p.preMax) return { ...p, ...p.preMax, preMax: null, zIndex: z };
        const s = viewport.scale || 1;
        return {
          ...p,
          preMax: { x: p.x, y: p.y, width: p.width, height: p.height },
          x: -viewport.tx / s + 8,
          y: -viewport.ty / s + 8,
          width: Math.max(MIN_PANEL_W, viewport.w / s - 16),
          height: Math.max(MIN_PANEL_H, viewport.h / s - 16),
          zIndex: z,
        };
      }),
    };
  });
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Count panels per canvas for the workspace tabs. */
export function canvasTabs(state) {
  const tabs = state.canvases.map((c, i) => ({ key: c.id, label: c.name || `${i + 1}`, count: c.panels.length || undefined }));
  if (state.canvases.length < MAX_CANVASES) tabs.push({ key: '__add__', label: 'New', icon: 'add' });
  return tabs;
}
