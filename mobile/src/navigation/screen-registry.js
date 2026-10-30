/**
 * screen-registry — the single source of truth for "every page this app has".
 *
 * Historically this catalogue lived inline in `MoreScreen` (App.js) and the
 * More index was the only thing that could read it. The Launchpad (a
 * search-centric page switcher) needs the exact same list, and the one thing
 * guaranteed to rot is a second hand-maintained copy. So the catalogue and the
 * routing rules moved here, and BOTH surfaces derive from them:
 *
 *   App.js  MoreScreen      -> SCREEN_SECTIONS + navigateToScreen()
 *   components/Launchpad.js -> SCREEN_SECTIONS + navigateToScreen()
 *
 * Adding a screen is therefore still a single edit (add an item to the section
 * it belongs to, per design-system/MASTER.md sec 11 step 4) and it shows up in
 * the More index AND the Launchpad automatically.
 *
 * Entry shape — exactly one routing key per item:
 *   { key, title, icon, desc, highlight?,
 *     tab?           -> a bottom-tab destination ('Chat', 'Business', ...);
 *                       `params: { screen }` opens a screen inside that tab
 *     screen?        -> a root-stack modal, via SCREEN_ROUTES
 *     businessScreen?-> a route nested in the Business stack
 *     webPath?       -> a web parity surface, via the WebSurface host
 *   }
 *
 * `navigateToScreen` takes the ROOT navigator (NavigationContainer ref, or
 * `navigation.getParent()` from inside a tab) so one implementation serves the
 * More screen, the Launchpad, and anything added later.
 */

/**
 * `screen:` value -> root-stack modal route name.
 *
 * This was a `switch` inside MoreScreen. As data it is enumerable, so the
 * Launchpad can tell a routable entry from a broken one instead of silently
 * doing nothing on tap.
 */
export const SCREEN_ROUTES = {
  GridScreen:                'GridModal',
  TerminalsScreen:           'TerminalsModal',
  FederationDirectoryScreen: 'FederationDirectoryModal',
  NeuralMeshScreen:          'NeuralMeshModal',
  MeshGamificationScreen:    'MeshGamificationModal',
  AgentsScreen:              'AgentsModal',
  CronScreen:                'CronModal',
  MemoryScreen:              'MemoryModal',
  GlassesScreen:             'GlassesModal',
  VideoScreen:               'VideoModal',
  ActivityScreen:            'ActivityModal',
  AutonomyScreen:            'AutonomyModal',
  HardwareScreen:            'HardwareModal',
  CampaignsScreen:           'CampaignsModal',
  DisciplineScreen:          'DisciplineModal',
  NotificationsCenterScreen: 'NotificationsModal',
  SettingsScreen:            'SettingsModal',
  CreditsScreen:             'CreditsModal',
  ReportsScreen:             'ReportsModal',
  OversightScreen:           'OversightModal',
  ContentPagesScreen:        'ContentModal',
  ContentIntelScreen:        'ContentIntelModal',
  CMOChatScreen:             'CMOChatModal',
  TrendsScreen:              'TrendsModal',
  WorkflowsScreen:           'WorkflowsModal',
  PluginsScreen:             'PluginsModal',
  ApprovalsScreen:           'ApprovalsModal',
  ConnectionsScreen:         'ConnectionsModal',
  InfiniCallScreen:          'InfiniCallModal',
  LearnScreen:               'LearnModal',
  InboxScreen:               'InboxModal',
  CommsScreen:               'CommsModal',
  DocumentsScreen:           'DocumentsModal',
  VaultScreen:               'VaultModal',
  GoalsPhasesScreen:         'GoalsModal',
  WorkspaceScreen:           'WorkspaceModal',
  AgencyDailyScreen:         'AgencyDailyModal',
  AgencyOperationsScreen:    'AgencyOperationsModal',
  AgencyTopologyScreen:      'AgencyTopologyModal',
  ProductCatalogScreen:      'ProductCatalogModal',
  WhiteboardScreen:          'WhiteboardModal',
};

/**
 * `screen:` values that are NOT a root modal but a route inside the Business
 * stack (the KIS command centers). Kept separate from SCREEN_ROUTES because
 * they need the MainTabs -> Business -> route nesting.
 */
export const BUSINESS_STACK_SCREENS = {
  ExecutiveCommandCenterScreen:  'ExecutiveCommandCenter',
  OperationsCommandCenterScreen: 'OperationsCommandCenter',
  OpsAgentsScreen:               'OpsAgents',
};

/**
 * The bottom-tab destinations. Surfaced in the Launchpad (so it is a complete
 * page switcher) but NOT in the More index, which deliberately lists only what
 * the dock does not already reach - hence `launchpadOnly`.
 */
const MAIN_TABS_SECTION = {
  title: 'Main',
  launchpadOnly: true,
  items: [
    { key: 'tabchat',      title: 'Chat',      icon: 'chatbubble-ellipses-outline', tab: 'Chat',      desc: 'Talk to your agent' },
    { key: 'tabboard',     title: 'Board',     icon: 'albums-outline',              tab: 'Board',     desc: 'Projects and kanban board' },
    { key: 'tabdashboard', title: 'Dashboard', icon: 'speedometer-outline',         tab: 'Dashboard', desc: 'Home dashboard' },
    { key: 'tabbusiness',  title: 'Business',  icon: 'briefcase-outline',           tab: 'Business',  desc: 'Business control layer home' },
    { key: 'tabknowledge', title: 'Knowledge', icon: 'library-outline',             tab: 'Knowledge', desc: 'Notes, research & workflows' },
    { key: 'tabmore',      title: 'More',      icon: 'ellipsis-horizontal',         tab: 'More',      desc: 'The full index of every screen' },
  ],
};

/**
 * The one voice surface: the InfiniBot call page (screens/InfiniCallScreen) —
 * the friendly face, local voice through the gateway (Whisper → the selected
 * gateway agent or CLI session → Kokoro), quick voice capture. Every voice
 * entry point opens it: the More/Launchpad "InfiniBot" item, the dock's center
 * button, the terminal/chat/glasses voice buttons, infinibot://voice|call.
 * The Robovoice console is the cloud option (Voice engine › Cloud on that page,
 * or infinibot://robovoice).
 */
export const VOICE_ENTRY = {
  key: 'voice',
  title: 'InfiniBot',
  icon: 'mic-outline',
  screen: 'InfiniCallScreen',
  desc: 'Talk to InfiniBot — local voice calls (Robovoice as the cloud option), quick capture of notes, ideas, tasks',
  highlight: true,
};

/** Open the InfiniBot call page from any navigator (nested navigators bubble up). */
export function openVoice(nav) {
  return navigateToScreen(nav, VOICE_ENTRY);
}

/**
 * Sections mirror the web sidebar's consolidated groups (ui/src/ui/navigation.ts
 * TAB_GROUPS): Home · Chat & Voice · Work · Agents · Settings, with plugin-owned
 * pages in between. Entries tagged `plugin: '<id>'` are the offline fallback for
 * that plugin's pages: once plugins.list is known they are dropped and the
 * plugin's own section (from its manifest) takes their place, so a disabled
 * plugin's pages disappear (plugins/plugin-nav.js mergeCatalogue).
 *
 * One entry per destination — no page is listed twice.
 */
export const SCREEN_SECTIONS = [
  MAIN_TABS_SECTION,
  {
    title: 'Home',
    items: [
      { key: 'notifications', title: 'Notifications', icon: 'notifications-outline', screen: 'NotificationsCenterScreen', desc: 'Recent alerts from agents, approvals and schedules', highlight: true },
      { key: 'approvals', title: 'Approvals', icon: 'hand-left-outline', screen: 'ApprovalsScreen', desc: 'Pending agent approvals — approve or deny from your phone', highlight: true },
      { key: 'learn', title: 'Learn', icon: 'school-outline', screen: 'LearnScreen', desc: 'Guided walkthroughs for every feature — progress syncs with the web' },
    ],
  },
  {
    title: 'Chat & Voice',
    items: [
      // The InfiniBot call page (local voice; Robovoice is its cloud option).
      VOICE_ENTRY,
      { key: 'grid', title: 'Grid', icon: 'apps-outline', screen: 'GridScreen', desc: 'Multi-panel canvas — chat, kanban, ops, terminals side by side', highlight: true },
      { key: 'inbox', title: 'Inbox', icon: 'mail-outline', screen: 'InboxScreen', desc: 'Unified email inbox with AI-triaged replies' },
      { key: 'comms', title: 'Channels', icon: 'chatbubbles-outline', screen: 'CommsScreen', desc: 'Telegram, WhatsApp, Slack and email connections' },
      { key: 'glasses', title: 'Glasses', icon: 'glasses-outline', screen: 'GlassesScreen', desc: 'Point the camera, ask a question' },
      { key: 'video', title: 'Video', icon: 'videocam-outline', screen: 'VideoScreen', desc: 'Camera stream to your agent' },
    ],
  },
  {
    title: 'Work',
    items: [
      { key: 'documents', title: 'Documents', icon: 'document-text-outline', screen: 'DocumentsScreen', desc: 'Pages, typed library, ideas, imports and uploads', highlight: true },
      { key: 'notes', title: 'Notes', icon: 'create-outline', tab: 'Knowledge', params: { screen: 'Notes' }, desc: 'Quick notes and handwriting' },
      { key: 'ideas', title: 'Ideas', icon: 'bulb-outline', tab: 'Knowledge', params: { screen: 'Ideas' }, desc: 'Captured ideas — explore, park, promote to a task, project or doc' },
      { key: 'research', title: 'Research', icon: 'search-outline', tab: 'Knowledge', params: { screen: 'Research' }, desc: 'Research documents and deep dives' },
      { key: 'cron', title: 'Schedule', icon: 'time-outline', screen: 'CronScreen', desc: 'Scheduled jobs and reminders' },
      { key: 'reports', title: 'Reports', icon: 'reader-outline', screen: 'ReportsScreen', desc: 'Generate, preview and resend PDF reports' },
      { key: 'vault', title: 'Vault', icon: 'lock-closed-outline', screen: 'VaultScreen', desc: 'Community vault — members, tiers, courses' },
    ],
  },
  {
    title: 'Agents',
    items: [
      { key: 'agents', title: 'Agents', icon: 'people-circle-outline', screen: 'AgentsScreen', desc: 'Your agent roster', highlight: true },
      { key: 'activity', title: 'Activity', icon: 'pulse-outline', screen: 'ActivityScreen', desc: 'Live agent sessions and sub-agent runs' },
      { key: 'mesh', title: 'Agent Mesh', icon: 'git-network-outline', screen: 'NeuralMeshScreen', desc: 'The live map of agents and nodes', highlight: true },
      { key: 'oversight', title: 'Reviews', icon: 'shield-checkmark-outline', screen: 'OversightScreen', desc: 'Review every agent run — verdicts, files, follow-ups', highlight: true },
      { key: 'opsagents', title: 'Ops Agents', icon: 'eye-outline', screen: 'OpsAgentsScreen', desc: 'Daily CEO briefing, exception report, project health' },
      { key: 'autonomy', title: 'Autonomy', icon: 'rocket-outline', screen: 'AutonomyScreen', desc: 'Autonomous task execution' },
      // Goals, Phases and Scheduled are tabs of the web Autonomy page; natively
      // they are one screen with the same three tabs.
      { key: 'goals', title: 'Goals & Phases', icon: 'flag-outline', screen: 'GoalsPhasesScreen', desc: 'Verified goal runs, the gated phase queue and scheduled tasks' },
      { key: 'workflows', title: 'Workflows', icon: 'git-merge-outline', screen: 'WorkflowsScreen', desc: 'Saved multi-step workflows' },
      { key: 'memory', title: 'Memory', icon: 'albums-outline', screen: 'MemoryScreen', desc: 'Long-term agent memory' },
      { key: 'kgraph', title: 'Knowledge Graph', icon: 'share-social-outline', tab: 'Knowledge', params: { screen: 'KnowledgeGraph' }, desc: 'Entity graph across projects, notes, research and agents', highlight: true },
      { key: 'terminals', title: 'Terminals', icon: 'terminal-outline', screen: 'TerminalsScreen', desc: 'Live shells — Claude, OpenCode, Codex, bash', highlight: true },
      { key: 'workspace', title: 'Workspace', icon: 'code-slash-outline', screen: 'WorkspaceScreen', desc: 'Per-project files, diffs and coder chat' },
      { key: 'feddir', title: 'Federation', icon: 'folder-open-outline', screen: 'FederationDirectoryScreen', desc: 'Browse files on federated nodes' },
      { key: 'hardware', title: 'Hardware', icon: 'hardware-chip-outline', screen: 'HardwareScreen', desc: 'GPU and node snapshot' },
      { key: 'meshxp', title: 'Mesh Progression', icon: 'trophy-outline', screen: 'MeshGamificationScreen', desc: 'XP, quests and leaderboard' },
    ],
  },
  {
    // Business & Agency plugin pages (fallback until plugins.list is known).
    title: 'Business & Agency',
    items: [
      { key: 'execcc', plugin: 'business-agency', title: 'Executive Command', icon: 'ribbon-outline', screen: 'ExecutiveCommandCenterScreen', desc: 'What needs you — today, this week, business health', highlight: true },
      { key: 'opscc', plugin: 'business-agency', title: 'Operations Command', icon: 'speedometer-outline', screen: 'OperationsCommandCenterScreen', desc: 'Needs attention, portfolio, workload, system quality' },
      { key: 'agencydaily', plugin: 'business-agency', title: 'Agency Today', icon: 'today-outline', screen: 'AgencyDailyScreen', desc: "Today's work queue, reviews and approvals" },
      { key: 'agencyops', plugin: 'business-agency', title: 'Agencies', icon: 'briefcase-outline', screen: 'AgencyOperationsScreen', desc: 'Pipeline, delivery, AI workforce, finance' },
      { key: 'agencytopo', plugin: 'business-agency', title: 'Agency Topology', icon: 'git-branch-outline', screen: 'AgencyTopologyScreen', desc: 'Org and delivery map — clients, projects, reporting lines' },
      { key: 'kisopps', plugin: 'business-agency', title: 'Opportunities', icon: 'trending-up-outline', businessScreen: 'Opportunities', desc: 'Pipeline stages, value in play and next actions' },
      { key: 'kisdecisions', plugin: 'business-agency', title: 'Decisions', icon: 'git-compare-outline', businessScreen: 'Decisions', desc: 'CEO decision queue' },
      { key: 'kisrisks', plugin: 'business-agency', title: 'Risks', icon: 'warning-outline', businessScreen: 'Risks', desc: 'Risk register scored probability × impact' },
      { key: 'kiscommitments', plugin: 'business-agency', title: 'Commitments', icon: 'cash-outline', businessScreen: 'Commitments', desc: 'Money in and out, overdue and deposits' },
      { key: 'kispeople', plugin: 'business-agency', title: 'People', icon: 'people-outline', businessScreen: 'People', desc: 'Roster and workload' },
      { key: 'campaigns', plugin: 'business-agency', title: 'Campaigns', icon: 'megaphone-outline', screen: 'CampaignsScreen', desc: 'Outreach campaigns' },
    ],
  },
  {
    title: 'Content',
    items: [
      { key: 'content', plugin: 'content-studio', title: 'Content Studio', icon: 'film-outline', screen: 'ContentPagesScreen', desc: 'Pages, scripts, generation and publishing', highlight: true },
      { key: 'contentintel', plugin: 'content-studio', title: 'Content Intelligence', icon: 'analytics-outline', screen: 'ContentIntelScreen', desc: 'Reel scores, tiers and a playable library' },
      { key: 'cmo', title: 'CMO', icon: 'bulb-outline', screen: 'CMOChatScreen', desc: 'Growth strategy grounded in your reel data' },
      { key: 'trends', title: 'Trends & Research', icon: 'flame-outline', screen: 'TrendsScreen', desc: 'Social signal, news and trending formats' },
    ],
  },
  {
    // Other first-party plugin pages (fallback until plugins.list is known).
    title: 'Plugins',
    items: [
      { key: 'products', plugin: 'products', title: 'Products', icon: 'pricetags-outline', screen: 'ProductCatalogScreen', desc: 'Catalog, inventory, pricing and variants' },
      { key: 'kisproducts', plugin: 'products', title: 'Product Portfolio', icon: 'cube-outline', businessScreen: 'ProductRegistry', desc: 'Portfolio and commercial validation ladder' },
      { key: 'discipline', plugin: 'discipline', title: 'Discipline', icon: 'medal-outline', screen: 'DisciplineScreen', desc: 'Daily rituals and counters' },
      { key: 'whiteboard', plugin: 'whiteboard', title: 'Whiteboard', icon: 'brush-outline', screen: 'WhiteboardScreen', desc: 'Diagrams and visual thinking' },
    ],
  },
  {
    title: 'Settings',
    items: [
      { key: 'settings', title: 'Settings', icon: 'settings-outline', screen: 'SettingsScreen', desc: 'App and gateway settings' },
      { key: 'connections', title: 'Connections', icon: 'swap-horizontal-outline', screen: 'ConnectionsScreen', desc: 'InfiniBot Cloud or self-hosted gateways — switch or add' },
      { key: 'plugins', title: 'Plugins', icon: 'extension-puzzle-outline', screen: 'PluginsScreen', desc: 'Browse, turn on or off and inspect plugins', highlight: true },
      { key: 'credits', title: 'Credits & Usage', icon: 'wallet-outline', screen: 'CreditsScreen', desc: 'Token and dollar spend across providers' },
    ],
  },
];

/** Sections the More index shows (everything the dock does not already reach). */
export const MORE_SECTIONS = SCREEN_SECTIONS.filter((s) => !s.launchpadOnly);

/** Every entry, flattened, each tagged with the section it came from. */
export function flattenScreens(sections = SCREEN_SECTIONS) {
  const out = [];
  for (const section of sections) {
    for (const item of section.items) out.push({ ...item, section: section.title });
  }
  return out;
}

/**
 * True when every character of `q` appears in `s` in order. Typo-tolerant
 * ("dsh" -> "Dashboard") without the cost of a real fuzzy scorer.
 */
export function isSubsequence(s, q) {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) {
      i += 1;
      if (i === q.length) return true;
    }
  }
  return i === q.length;
}

/** Lowercased match target: title + description + section + route + key. */
export function haystack(entry) {
  return [
    entry.title,
    entry.desc,
    entry.section,
    entry.tab,
    entry.screen,
    entry.businessScreen,
    entry.webPath,
    entry.pluginId,
    entry.key,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Substring anywhere in the haystack, OR a subsequence match against the short
 * title alone. Subsequence is deliberately NOT run over the description - the
 * prose is long enough that almost any query would match it.
 */
export function matchesQuery(entry, rawQuery) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q) return true;
  if (haystack(entry).includes(q)) return true;
  return isSubsequence(String(entry.title || '').toLowerCase(), q);
}

/**
 * Filter the catalogue for the Launchpad. Returns the surviving sections (empty
 * ones dropped) plus the flat, in-render-order list so the caller can address
 * results by index.
 */
export function filterScreens(rawQuery, sections = SCREEN_SECTIONS) {
  const q = String(rawQuery || '').trim();
  const outSections = [];
  const flat = [];
  for (const section of sections) {
    const items = section.items
      .map((item) => ({ ...item, section: section.title }))
      .filter((item) => matchesQuery(item, q));
    if (!items.length) continue;
    // Keep the section's own fields (plugin id, monogram, accent …).
    outSections.push({ ...section, items });
    flat.push(...items);
  }
  return { sections: outSections, flat };
}

/** True when an entry has a routing key this app knows how to follow. */
export function isRoutable(entry) {
  if (!entry) return false;
  if (entry.tab || entry.webPath || entry.businessScreen || entry.webFallback) return true;
  return Boolean(SCREEN_ROUTES[entry.screen] || BUSINESS_STACK_SCREENS[entry.screen]);
}

// React Navigation 7: `navigate()` to a route that exists further down the
// stack PUSHES A SECOND COPY unless told to pop back to it. From an open modal
// that stacked a whole new tab tree (every tab screen mounted and polling
// again) on top. Tab destinations always return to the one MainTabs.
const TO_EXISTING = { pop: true };

/**
 * Navigate to a catalogue entry.
 *
 * @param rootNav  the ROOT navigator - NavigationContainer ref (Launchpad) or
 *                 `navigation.getParent()` from a tab screen (MoreScreen).
 * @param entry    a SCREEN_SECTIONS item.
 * @param ctx      { gateway, notifications, switchSession? }
 * @returns true when a navigation was performed.
 */
export function navigateToScreen(rootNav, entry, ctx = {}) {
  if (!entry) return false;
  const { gateway, notifications } = ctx;

  const extra = entry.params && typeof entry.params === 'object' ? entry.params : {};

  // Bottom-tab destination (optionally a screen nested in that tab's stack).
  if (entry.tab) {
    if (entry.sessionKey && ctx.switchSession) ctx.switchSession(entry.sessionKey);
    // `initial: false` keeps the tab's home screen underneath a nested
    // screen, so Back always has somewhere to go.
    const params = entry.params?.screen ? { initial: false, ...entry.params } : entry.params;
    rootNav?.navigate('MainTabs', { screen: entry.tab, params }, TO_EXISTING);
    return true;
  }

  // Web parity surfaces (and plugin pages without a native screen) route
  // through the one generic WebView host. Plugin pages render chromeless.
  if (entry.webPath) {
    rootNav?.navigate('WebSurfaceModal', {
      path: entry.webPath,
      title: entry.title,
      embed: Boolean(entry.embed || entry.pluginId),
      pluginId: entry.pluginId,
      accent: entry.accent,
    });
    return true;
  }

  // Business-stack routes. Addressed explicitly through MainTabs so the
  // Business tab stays the parent and back goes to Business home, not More.
  const businessRoute = entry.businessScreen || BUSINESS_STACK_SCREENS[entry.screen];
  if (businessRoute) {
    rootNav?.navigate('MainTabs', {
      screen: 'Business',
      params: { screen: businessRoute, initial: false, params: entry.params },
    }, TO_EXISTING);
    return true;
  }

  const route = SCREEN_ROUTES[entry.screen];
  if (!route) {
    // A native screen this build does not have: fall back to its web page.
    if (entry.webFallback) {
      rootNav?.navigate('WebSurfaceModal', { path: entry.webFallback, title: entry.title, embed: true });
      return true;
    }
    return false;
  }
  // NotificationsModal / SettingsModal also want the notifications controller.
  const params =
    route === 'NotificationsModal' || route === 'SettingsModal'
      ? { gateway, notifications, ...extra }
      : { gateway, ...extra };
  rootNav?.navigate(route, params);
  return true;
}
