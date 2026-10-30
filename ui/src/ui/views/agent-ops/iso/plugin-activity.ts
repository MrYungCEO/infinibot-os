/**
 * Activity → plugin mapping for the agent mesh map (pure, no Pixi).
 *
 * One function decides which plugin an agent is currently working in, from
 * the same manifest declarations the host enforces (plugins.list):
 *
 *   tool name        contributes.tools               (`solana_market`)
 *   RPC method       contributes.rpc / rpcAliases    (`infinitrade.orders.list`, `aurum.pine.get`)
 *   RPC namespace    `<id>.` token in the tool label / task text
 *   page route       contributes.pages[].route       (`/solatrix/wallets`)
 *   tag              `#<id>`, `plugin:<id>`, `[<id>]` in text or tags
 *   roster agent     plugin-contributed agent ids    (`oc-literature-scout`)
 *   mention          whole-word plugin name / id in the task text
 *
 * The engine routes the agent to that plugin's room; null falls back to the
 * core sectors (agent-spread.ts domains / sectorForToolKind).
 */

export interface PluginActivitySource {
  id: string;
  name: string;
  tools: string[];
  rpc: string[];
  aliases: string[];
  routes: string[];
  tabs: string[];
  agentIds: string[];
}

/** plugins.list item fields the index reads. */
export interface PluginActivityListItem {
  id: string;
  name?: string;
  status?: string;
  enabled?: boolean;
  manifestVersion?: number;
  contributes?: {
    pages?: Array<{ tab: string; route: string }>;
    tools?: Array<string | { name: string }>;
    rpc?: Array<{ method: string; aliases?: string[] }>;
    rpcAliases?: Array<{ method: string }>;
  };
  /** Roster agent ids the plugin seeds (plugins.list `rosterAgentIds`). */
  rosterAgentIds?: string[];
}

export interface ActivityInput {
  /** Explicit plugin tag on the run/task (wins when it names a known plugin). */
  pluginId?: string | null;
  /** Latest tool kind (lowercased tool name) and its human label. */
  toolKind?: string | null;
  toolLabel?: string | null;
  /** Task title / current task / label text. */
  text?: string | null;
  /** A page route the agent is working on, when known. */
  route?: string | null;
  /** Roster agent id (`main`, `cmo`, `oc-literature-scout`…). */
  agentId?: string | null;
  tags?: readonly string[] | null;
}

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Build one source from a plugins.list item (loaded v2 plugins only). */
export function activitySourceFromPlugin(p: PluginActivityListItem): PluginActivitySource | null {
  if (!p?.id || p.manifestVersion !== 2) return null;
  const loaded = p.status ? p.status === 'loaded' : p.enabled !== false;
  if (!loaded) return null;
  const c = p.contributes ?? {};
  const tools = (c.tools ?? [])
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .map(lower)
    .filter(Boolean);
  const rpc: string[] = [];
  const aliases: string[] = [];
  for (const r of c.rpc ?? []) {
    if (lower(r?.method)) rpc.push(lower(r.method));
    for (const a of r?.aliases ?? []) if (lower(a)) aliases.push(lower(a));
  }
  for (const a of c.rpcAliases ?? []) if (lower(a?.method)) aliases.push(lower(a.method));
  const pages = c.pages ?? [];
  return {
    id: p.id,
    name: (p.name ?? p.id).trim(),
    tools,
    rpc,
    aliases,
    routes: pages.map((pg) => lower(pg?.route)).filter((r) => r.startsWith('/')),
    tabs: pages.map((pg) => lower(pg?.tab)).filter(Boolean),
    agentIds: (p.rosterAgentIds ?? []).map(lower).filter(Boolean),
  };
}

/** Split free text into candidate tokens (keeps dots, slashes, colons, dashes). */
export function activityTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[\s,;()"'`<>{}|]+/)
    .map((t) => t.replace(/^[^a-z0-9#/\[]+|[^a-z0-9\]\/]+$/g, ''))
    .filter((t) => t.length >= 2);
}

const WORD_BOUNDARY = (s: string) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z0-9])`, 'i');

export class PluginActivityIndex {
  private readonly sources = new Map<string, PluginActivitySource>();
  private readonly byTool = new Map<string, string>();
  private readonly byMethod = new Map<string, string>();
  private readonly byAgent = new Map<string, string>();
  private readonly byTab = new Map<string, string>();
  /** Routes longest-first so "/infinitrade/scanner" beats "/infinitrade". */
  private readonly routes: Array<{ route: string; id: string }> = [];
  private readonly nameRes: Array<{ re: RegExp; id: string }> = [];

  constructor(sources: Iterable<PluginActivitySource | null | undefined>) {
    for (const s of sources) {
      if (!s || this.sources.has(s.id)) continue;
      this.sources.set(s.id, s);
      for (const t of s.tools) if (!this.byTool.has(t)) this.byTool.set(t, s.id);
      for (const m of [...s.rpc, ...s.aliases]) if (!this.byMethod.has(m)) this.byMethod.set(m, s.id);
      for (const a of s.agentIds) if (!this.byAgent.has(a)) this.byAgent.set(a, s.id);
      for (const t of s.tabs) if (!this.byTab.has(t)) this.byTab.set(t, s.id);
      for (const r of s.routes) this.routes.push({ route: r, id: s.id });
      const names = new Set<string>([s.name.toLowerCase()]);
      if (s.id.length >= 4) names.add(s.id.toLowerCase());
      for (const n of names) if (n.length >= 4) this.nameRes.push({ re: WORD_BOUNDARY(n), id: s.id });
    }
    this.routes.sort((a, b) => b.route.length - a.route.length);
  }

  get size(): number {
    return this.sources.size;
  }

  has(pluginId: string | null | undefined): boolean {
    return !!pluginId && this.sources.has(pluginId);
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }

  /** Plugin owning a page route (exact or parent route), else null. */
  pluginForRoute(route: string | null | undefined): string | null {
    const r = lower(route).split(/[?#]/)[0].replace(/\/+$/, '');
    if (!r.startsWith('/')) return null;
    for (const { route: pr, id } of this.routes) {
      if (r === pr || r.startsWith(pr + '/')) return id;
    }
    return null;
  }

  /** Plugin whose tool/RPC/alias/namespace a token names, else null. */
  pluginForToken(token: string): string | null {
    const t = lower(token).replace(/^(gateway|rpc|tool|mcp)[:=]/, '');
    if (!t) return null;
    const direct = this.byTool.get(t) ?? this.byMethod.get(t);
    if (direct) return direct;
    const dot = t.indexOf('.');
    if (dot > 0) {
      const ns = t.slice(0, dot);
      if (this.sources.has(ns)) return ns;
    }
    if (t.startsWith('/')) return this.pluginForRoute(t);
    const tag = /^(?:#|plugin:)([a-z0-9][a-z0-9-]*)$/.exec(t) ?? /^\[([a-z0-9][a-z0-9-]*)\]$/.exec(t);
    if (tag && this.sources.has(tag[1])) return tag[1];
    return null;
  }

  /** Plugin a roster agent belongs to (declared id, `<id>`, or `<id>-…`). */
  pluginForAgent(agentId: string | null | undefined): string | null {
    const a = lower(agentId);
    if (!a || a === 'main') return null;
    const declared = this.byAgent.get(a);
    if (declared) return declared;
    if (this.sources.has(a)) return a;
    for (const id of this.sources.keys()) if (a.startsWith(id + '-')) return id;
    return null;
  }

  /** Plugin mentioned by whole-word name or id in free text, else null. */
  pluginMentioned(text: string | null | undefined): string | null {
    if (!text) return null;
    for (const { re, id } of this.nameRes) if (re.test(text)) return id;
    return null;
  }

  /**
   * The plugin the agent is working in right now, or null → core sectors.
   * Live signals (tool, RPC) win over static ones (task text, roster id).
   */
  resolve(input: ActivityInput): string | null {
    if (this.sources.size === 0) return null;
    if (input.pluginId && this.sources.has(input.pluginId)) return input.pluginId;
    const kind = lower(input.toolKind);
    if (kind) {
      const byKind = this.pluginForToken(kind);
      if (byKind) return byKind;
    }
    for (const tok of activityTokens(input.toolLabel)) {
      const hit = this.pluginForToken(tok);
      if (hit) return hit;
    }
    if (input.route) {
      const hit = this.pluginForRoute(input.route);
      if (hit) return hit;
    }
    for (const tag of input.tags ?? []) {
      const t = lower(tag);
      const hit = this.pluginForToken(t.startsWith('#') || t.startsWith('plugin:') ? t : `#${t}`);
      if (hit) return hit;
    }
    for (const tok of activityTokens(input.text)) {
      const hit = this.pluginForToken(tok);
      if (hit) return hit;
    }
    // Task text names the plugin (work signal) before the agent's roster home
    // (identity signal): a content-studio agent reviewing Infinitrade works
    // on the trading floor.
    const mentioned = this.pluginMentioned(input.text) ?? this.pluginMentioned(input.toolLabel);
    if (mentioned) return mentioned;
    return this.pluginForAgent(input.agentId);
  }
}

/** Convenience: index straight from a plugins.list response. */
export function buildPluginActivityIndex(items: readonly PluginActivityListItem[]): PluginActivityIndex {
  return new PluginActivityIndex(items.map(activitySourceFromPlugin));
}
