/**
 * Plugin manifest v2 — declared-capability manifests.
 *
 * A v2 manifest (`"manifestVersion": 2` in infinibot.plugin.json) declares up
 * front everything the plugin will contribute (nav entries, pages, RPC
 * methods, HTTP routes) and the permissions it wants. The host enforces the
 * declaration: registering an RPC method or HTTP route the manifest did not
 * declare is rejected, and the plugin only loads when its declared plugin-API
 * range covers this host. v1 manifests (no manifestVersion) are untouched.
 *
 * Design: docs/plugins/PLUGIN-PLATFORM.md §3.
 */

/** Version of the plugin host API. Semver: majors break plugins. Kept apart
 *  from the product's calver so a product release doesn't imply an API break. */
export const PLUGIN_API_VERSION = "2.0.0";

import type { PluginLearnContribution } from "../learn/guided/types.js";
import { parseLearnContribution } from "../learn/guided/validate.js";
import {
  APPEARANCE_TOKENS,
  parseAppearanceManifest,
  type PluginAppearanceManifest,
} from "./appearance.js";

const APPEARANCE_TOKEN_NAMES: ReadonlySet<string> = new Set(Object.keys(APPEARANCE_TOKENS));
import {
  buildContributionCatalog,
  type ContributionItem,
  type PluginImporter,
} from "./contributions.js";

export type PluginRpcScope = "read" | "write" | "admin";

export type PluginNavContribution = {
  /** Control-UI tab id the entry opens (must match a page's `tab`). */
  tab: string;
  label: string;
  icon?: string;
  /** Sidebar group label (TAB_GROUPS label, e.g. "Agents"). */
  group?: string;
};

export type PluginPageContribution = {
  tab: string;
  /** URL path, e.g. "/inficode". */
  route: string;
  /** First-party page compiled into the control UI (lazy chunk key). */
  builtin?: string;
  /** Marketplace page: HTTP path of an ES module the plugin serves. */
  entry?: string;
  title?: string;
};

export type PluginRpcContribution = {
  method: string;
  scope: PluginRpcScope;
  /**
   * Temporary compatibility names registered by the same plugin. Aliases are
   * present only while the plugin is loaded and inherit the canonical
   * method's scope. The canonical method must remain namespaced `<id>.*`;
   * aliases may use a legacy namespace while callers migrate.
   */
  aliases?: string[];
};

/**
 * Legacy (un-namespaced) RPC name served by one of the plugin's own declared
 * methods — for plugins that replace a forked gateway whose clients still call
 * the old names. The host wires the alias; it never shadows a core method.
 */
export type PluginRpcAlias = { method: string; target: string; scope: PluginRpcScope };
/** One entry of the plugin's own sidebar section (`contributes.navSection`). */
export type PluginNavSectionItem = {
  /** Tab of a `contributes.pages` entry. */
  page: string;
  label?: string;
  icon?: string;
};

/**
 * Optional shape of the plugin's sidebar section. Every enabled plugin that
 * contributes a page gets a section headed by its name + monogram; this only
 * tunes it. Without `items` the section lists every declared page in
 * manifest order (labels/icons from the matching nav entry).
 */
export type PluginNavSectionContribution = {
  title?: string;
  /** Sections sort by order (default 1000), then title. */
  order?: number;
  collapsedByDefault?: boolean;
  items?: PluginNavSectionItem[];
};
export type PluginMcpServerContribution = {
  id: string;
  label?: string;
  command: string;
  args: string[];
};

export type PluginContributes = {
  nav: PluginNavContribution[];
  pages: PluginPageContribution[];
  rpc: PluginRpcContribution[];
  /** Legacy RPC names aliased onto declared `rpc` methods. */
  rpcAliases: PluginRpcAlias[];
  http: string[];
  /**
   * Subset of `http` the plugin authenticates itself (scoped tokens, signed
   * webhooks). These skip the shared-secret gate — the handler MUST reject
   * unauthenticated requests.
   */
  selfAuthHttp?: string[];
  services: string[];
  /** Voice-provider ids the plugin registers (api.registerVoiceProvider). */
  voiceProviders?: string[];
  /** Roster-agent JSON files (relative to the plugin root) seeded into
   *  agents.list while the plugin is enabled (agent-contributions.ts). */
  agents: string[];
  /** Tab the plugin can make the start page ("clinic mode"). Only used when
   *  the operator opts in via `plugins.landing: "<id>"`. Must be a page tab. */
  landing?: string;
  /** Agent tool names the plugin registers (registerTool rejects others).
   *  Entries are names or { name, trust?, requires? } objects. */
  tools: string[];
  /** Chat panel kinds (`<id>.<kind>`) the plugin registers for show_panel. */
  panels: string[];
  /** Shape of the plugin's own sidebar section (optional). */
  navSection?: PluginNavSectionContribution;
  /** Bundled stdio MCP servers. The host surfaces these only while the plugin is enabled. */
  mcpServers: PluginMcpServerContribution[];
  /** Sections the plugin adds to the expanded topbar clock (optional). */
  clockSections?: PluginClockSectionContribution[];
  /** Controls the plugin adds to the app topbar (optional). */
  topbarSlots?: PluginTopbarSlotContribution[];
  /** First-party settings sections shown on Setup › Plugins › <plugin> (optional). */
  settings?: PluginSettingsSectionContribution[];
  /** Guided Learn tracks the plugin ships (docs/plugins/LEARN.md). Listed only while enabled. */
  learn?: PluginLearnContribution;
  /**
   * "Needs setup" checks the plugin registers (api.registerSetupCheck). Each
   * names the plugin's own pages that glow in the sidebar while the check
   * isn't ready. Design: docs/gateway/setup-status.md.
   */
  setupChecks?: PluginSetupCheckContribution[];
  /** The plugin's room on the agent mesh map (default for plugins with pages;
   *  absent when the manifest opts out with `"mapRoom": false`). */
  mapRoom?: PluginMapRoomContribution;
};

/**
 * A settings section a plugin adds to its Setup › Plugins detail page
 * (`contributes.settings`), rendered above the auto-generated config form.
 * `builtin` names first-party UI compiled into the control UI
 * (ui/src/ui/components/plugin-settings-sections.ts); unknown keys render
 * nothing. Design: docs/plugins/SETTINGS-SECTIONS.md.
 */
export type PluginSettingsSectionContribution = {
  /** Plugin-local id, lowercase `a-z0-9-`. Contribution key `settings:<id>`. */
  id: string;
  label: string;
  description?: string;
  builtin: string;
  /** Sections sort by order (default 100). */
  order: number;
};

/** A declared setup check (`contributes.setupChecks`). */
export type PluginSetupCheckContribution = {
  /** Namespaced `<pluginId>.<name>`; must match api.registerSetupCheck. */
  id: string;
  /** Short name of what's being set up ("Solana RPC"). */
  title: string;
  /** The plugin's own page tabs that glow (must be in contributes.pages). */
  tabs: string[];
  /** Default action: one of the plugin's page tabs (+ optional sub-view). */
  action?: { label: string; tab: string; view?: string };
};

/**
 * A section in the expanded topbar clock (`contributes.clockSections`). The
 * clock lists one toggle per section while the plugin is loaded; the user's
 * on/off choice is kept per user in the browser. `builtin` names first-party
 * UI compiled into the control UI (see ui/src/ui/components/clock-sections.ts).
 * Design: docs/plugins/CLOCK-SECTIONS.md.
 */
export type PluginClockSectionContribution = {
  /** Plugin-local id, lowercase `a-z0-9-`. Contribution key `clockSection:<id>`. */
  id: string;
  /** Toggle label shown in the clock ("Trading sessions"). */
  label: string;
  description?: string;
  /** First-party renderer key. */
  builtin: string;
  /** Initial toggle state before the user chooses (default true). */
  defaultEnabled: boolean;
};

/**
 * A control a plugin adds to the app topbar (`contributes.topbarSlots`), e.g.
 * the Business & Agency plugin's agency selector. It renders only while the
 * plugin is loaded and the owner hasn't switched `topbarSlot:<id>` off in
 * Setup › Plugins. `builtin` names first-party UI compiled into the control UI
 * (ui/src/ui/components/topbar-slots.ts). Design: docs/plugins/TOPBAR-SLOTS.md.
 */
export type PluginTopbarSlotContribution = {
  /** Plugin-local id, lowercase `a-z0-9-`. Contribution key `topbarSlot:<id>`. */
  id: string;
  /** Human label (Setup › Plugins, overflow menus). */
  label: string;
  description?: string;
  /** First-party renderer key. */
  builtin: string;
  /** Slots sort by order (default 100), then plugin id. */
  order: number;
  /**
   * Which topbar group hosts the control: "left" (default, next to the
   * agency selector) or "right" (the status group, next to Approvals).
   */
  placement?: "left" | "right";
};

/** Room themes the agent mesh map knows how to build (iso prop sets). */
export const MAP_ROOM_THEMES = [
  "generic",
  "fleet",
  "voice-studio",
  "clinic",
  "media-studio",
  "trading-floor",
  "terminal-vault",
  "dojo",
  "content-lab",
  "showroom",
  "drawing-studio",
  "holo-gallery",
  "boardroom",
] as const;
export type PluginMapRoomTheme = (typeof MAP_ROOM_THEMES)[number];
export const MAP_ROOM_SIZES = ["S", "M", "L"] as const;
export type PluginMapRoomSize = (typeof MAP_ROOM_SIZES)[number];
export const MAP_ROOM_PLACEMENTS = ["auto", "north", "east", "south", "west"] as const;
export type PluginMapRoomPlacement = (typeof MAP_ROOM_PLACEMENTS)[number];
/** Props a room may list explicitly (baked iso textures in the control UI). */
export const MAP_ROOM_PROPS = [
  "desk",
  "bench",
  "server",
  "holoTable",
  "bigDisplay",
  "antenna",
  "vaultDoor",
  "crate",
  "easel",
  "crystal",
  "telescope",
  "consoleWide",
  "commsBoard",
  "micBooth",
  "speaker",
  "safe",
  "ingots",
  "roboArm",
  "gateArch",
  "pedestal",
  "plantHolo",
  "couch",
  "bed",
  "tickerBoard",
  "coinPillar",
  "labBench",
  "cameraRig",
  "softbox",
  "dojoMat",
  "bonsai",
  "shelfRack",
  "drawingBoard",
  "holoFrame",
  "boardTable",
  "waveformWall",
] as const;
export type PluginMapRoomProp = (typeof MAP_ROOM_PROPS)[number];

/**
 * The plugin's room on the isometric agent mesh map (`contributes.mapRoom`).
 * Every enabled plugin that contributes a page gets a room by default (a
 * `generic` M room titled after the plugin); this block tunes it. `false`
 * opts out. Agents walk to the room while they work in the plugin (its tools,
 * RPCs, pages or roster agents). Design: docs/plugins/MAP-ROOMS.md.
 */
export type PluginMapRoomContribution = {
  /** Room sign (≤ 24 chars). Defaults to the plugin name. */
  title: string;
  /** Prop set / floor motif the map builds. */
  theme: PluginMapRoomTheme;
  /** Accent for trim, sign and floor tint: `token:<name>` or `#rrggbb`.
   *  Defaults to the theme's own accent so rooms stay distinct. */
  accent?: string;
  /** Explicit prop list (≤ 12) replacing the theme's default furniture. */
  props?: PluginMapRoomProp[];
  /** Footprint on the station grid: S 6×6, M 8×8, L 10×10 tiles. */
  size: PluginMapRoomSize;
  /** Preferred side of the Plugin District ring; "auto" fills nearest the
   *  Gateway Concourse first. */
  placement: PluginMapRoomPlacement;
};

/**
 * A capability the plugin can use only after the owner grants it. Declared so
 * the host can show it (and its default-off state) before the plugin runs.
 */
export type PluginGatedPermission = { id: string; label: string; description?: string };

export type PluginPermissions = {
  network?: string[];
  fs?: string[];
  exec?: boolean;
  secrets?: string[];
  channels?: string[];
  credits?: boolean;
  /** The plugin stores protected health information (patient data). */
  phi?: boolean;
  /** High-risk capabilities that are OFF until the owner grants them. */
  gated?: PluginGatedPermission[];
};

export type PluginManifestV2Fields = {
  manifestVersion: 2;
  engines: { pluginApi: string };
  /** Optional RPC namespace when a hyphenated plugin id needs an ergonomic API prefix. */
  rpcNamespace: string;
  contributes: PluginContributes;
  permissions: PluginPermissions;
  publisher?: string;
  /** SPDX licence the publisher ships under. */
  license?: string;
  homepage?: string;
  /** Declared appearance (defaults filled in; InfiniBot tokens only). */
  appearance: PluginAppearanceManifest;
  /** Every declared contribution, flattened for Setup › Plugins (lenient). */
  catalog: { items: ContributionItem[]; importers: PluginImporter[] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => str(v)).filter((v): v is string => Boolean(v));
}

const RPC_SCOPES: ReadonlySet<string> = new Set(["read", "write", "admin"]);

/**
 * Parse the v2-only fields of a manifest. Returns an error string for any
 * malformed declaration: a v2 manifest is a contract, so it fails closed.
 */
export function parseManifestV2(
  id: string,
  raw: Record<string, unknown>,
): { ok: true; fields: PluginManifestV2Fields } | { ok: false; error: string } {
  const engines = isRecord(raw.engines) ? raw.engines : {};
  const pluginApi = str(engines["infinibot-plugin-api"]);
  if (!pluginApi) {
    return { ok: false, error: 'v2 manifest requires engines["infinibot-plugin-api"]' };
  }
  const c = isRecord(raw.contributes) ? raw.contributes : {};
  const rpcNamespace = str(raw.rpcNamespace) ?? id;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(rpcNamespace)) {
    return {
      ok: false,
      error: "rpcNamespace must contain only lowercase letters, digits and hyphens",
    };
  }

  const pages: PluginPageContribution[] = [];
  for (const p of Array.isArray(c.pages) ? c.pages : []) {
    if (!isRecord(p)) return { ok: false, error: "contributes.pages entries must be objects" };
    const tab = str(p.tab);
    const route = str(p.route);
    const builtin = str(p.builtin);
    const entry = str(p.entry);
    if (!tab || !route) return { ok: false, error: "contributes.pages entries need tab + route" };
    if (!builtin && !entry) return { ok: false, error: `page "${tab}" needs builtin or entry` };
    if (entry && !entry.startsWith(`/plugins/${id}/`)) {
      return { ok: false, error: `page "${tab}" entry must live under /plugins/${id}/` };
    }
    pages.push({ tab, route, builtin, entry, title: str(p.title) });
  }

  const nav: PluginNavContribution[] = [];
  for (const n of Array.isArray(c.nav) ? c.nav : []) {
    if (!isRecord(n)) return { ok: false, error: "contributes.nav entries must be objects" };
    const tab = str(n.tab);
    const label = str(n.label);
    if (!tab || !label) return { ok: false, error: "contributes.nav entries need tab + label" };
    if (!pages.some((p) => p.tab === tab)) {
      return { ok: false, error: `nav entry "${tab}" has no matching contributes.pages entry` };
    }
    nav.push({ tab, label, icon: str(n.icon), group: str(n.group) });
  }

  const rpc: PluginRpcContribution[] = [];
  const rpcNames = new Set<string>();
  for (const r of Array.isArray(c.rpc) ? c.rpc : []) {
    const method = isRecord(r) ? str(r.method) : str(r);
    const scope = isRecord(r) ? (str(r.scope) ?? "admin") : "admin";
    if (!method) return { ok: false, error: "contributes.rpc entries need a method" };
    if (!method.startsWith(`${rpcNamespace}.`)) {
      return { ok: false, error: `rpc method "${method}" must be namespaced "${rpcNamespace}.*"` };
    }
    if (!RPC_SCOPES.has(scope))
      return { ok: false, error: `rpc "${method}" has unknown scope "${scope}"` };
    const aliases = isRecord(r) ? strList(r.aliases) : [];
    for (const alias of aliases) {
      if (!/^[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+$/i.test(alias)) {
        return { ok: false, error: `rpc alias "${alias}" is not a valid method name` };
      }
      if (alias === method) {
        return { ok: false, error: `rpc alias "${alias}" duplicates its canonical method` };
      }
    }
    for (const name of [method, ...aliases]) {
      if (rpcNames.has(name))
        return { ok: false, error: `duplicate rpc method or alias "${name}"` };
      rpcNames.add(name);
    }
    rpc.push({ method, scope: scope as PluginRpcScope, ...(aliases.length ? { aliases } : {}) });
  }

  const rpcAliases: PluginRpcAlias[] = [];
  for (const a of Array.isArray(c.rpcAliases) ? c.rpcAliases : []) {
    if (!isRecord(a)) return { ok: false, error: "contributes.rpcAliases entries must be objects" };
    const method = str(a.method);
    const target = str(a.target);
    if (!method || !target)
      return { ok: false, error: "contributes.rpcAliases entries need method + target" };
    const decl = rpc.find((r) => r.method === target);
    if (!decl) {
      return { ok: false, error: `rpc alias "${method}" targets undeclared method "${target}"` };
    }
    if (method.startsWith(`${id}.`)) {
      return { ok: false, error: `rpc alias "${method}" is already in the plugin namespace` };
    }
    // An alias can't widen access: it inherits (at most) its target's scope.
    rpcAliases.push({ method, target, scope: decl.scope });
  }

  const tools = (Array.isArray(c.tools) ? c.tools : [])
    .map((t) => (isRecord(t) ? str(t.name) : str(t)))
    .filter((t): t is string => Boolean(t));
  const panels = strList(c.panels);
  for (const panel of panels) {
    if (!panel.startsWith(`${id}.`)) {
      return { ok: false, error: `panel kind "${panel}" must be namespaced "${id}.*"` };
    }
  }

  const mcpServers: PluginMcpServerContribution[] = [];
  for (const server of Array.isArray(c.mcpServers) ? c.mcpServers : []) {
    if (!isRecord(server))
      return { ok: false, error: "contributes.mcpServers entries must be objects" };
    const serverId = str(server.id);
    const command = str(server.command);
    if (!serverId || !command)
      return { ok: false, error: "contributes.mcpServers entries need id + command" };
    mcpServers.push({
      id: serverId,
      label: str(server.label),
      command,
      args: strList(server.args),
    });
  }

  // Routes are strings, or { path, requires } objects (additive: `requires`
  // lists the permissions the route depends on — see contributions.ts).
  const http = (Array.isArray(c.http) ? c.http : [])
    .map((h) => (isRecord(h) ? str(h.path) : str(h)))
    .filter((h): h is string => Boolean(h));
  for (const route of http) {
    if (!route.startsWith(`/plugins/${id}/`)) {
      return { ok: false, error: `http route "${route}" must live under /plugins/${id}/` };
    }
  }
  // Routes the plugin authenticates itself (scoped tokens, signed webhooks):
  // dispatched BEFORE the gateway's shared-secret gate. Must also be in `http`.
  const selfAuthHttp = strList(c.selfAuthHttp);
  for (const route of selfAuthHttp) {
    if (!http.includes(route)) {
      return {
        ok: false,
        error: `selfAuthHttp route "${route}" must also be listed in contributes.http`,
      };
    }
  }

  const agents = strList(c.agents);
  for (const file of agents) {
    if (file.startsWith("/") || file.split(/[\\/]/).includes("..")) {
      return { ok: false, error: `agents file "${file}" must be a path inside the plugin` };
    }
  }
  const landing = str(c.landing);
  if (landing && !pages.some((pg) => pg.tab === landing)) {
    return { ok: false, error: `landing "${landing}" has no matching contributes.pages entry` };
  }
  const topbarSlots = parseTopbarSlots(c.topbarSlots);
  if (typeof topbarSlots === "string") return { ok: false, error: topbarSlots };

  const settingsSections = parseSettingsSections(c.settings);
  if (typeof settingsSections === "string") return { ok: false, error: settingsSections };

  const setupChecks = parseSetupChecks(id, c.setupChecks, pages);
  if (typeof setupChecks === "string") return { ok: false, error: setupChecks };

  const navSection = parseNavSection(c.navSection, pages);
  if (typeof navSection === "string") return { ok: false, error: navSection };

  const clockSections = parseClockSections(c.clockSections);
  if (typeof clockSections === "string") return { ok: false, error: clockSections };

  let learn: PluginLearnContribution | undefined;
  // A file reference ("learn.json" / { file }) is resolved and validated by
  // loadPluginManifest (manifest.ts) before this parser runs; parsing the raw
  // manifest on its own just leaves it unresolved.
  const learnIsFileRef =
    typeof c.learn === "string" ||
    (isRecord(c.learn) && typeof c.learn.file === "string" && !("tracks" in c.learn));
  if (c.learn !== undefined && !learnIsFileRef) {
    const parsedLearn = parseLearnContribution(id, c.learn);
    if (!parsedLearn.ok) return { ok: false, error: parsedLearn.error };
    learn = parsedLearn.learn;
  }
  const mapRoom = parseMapRoom(c.mapRoom, {
    name: str(raw.name) ?? id,
    hasPages: pages.length > 0,
  });
  if (typeof mapRoom === "string") return { ok: false, error: mapRoom };

  const p = isRecord(raw.permissions) ? raw.permissions : {};
  const gated: PluginGatedPermission[] = [];
  for (const g of Array.isArray(p.gated) ? p.gated : []) {
    const gid = isRecord(g) ? str(g.id) : undefined;
    const label = isRecord(g) ? str(g.label) : undefined;
    if (!gid || !label) return { ok: false, error: "permissions.gated entries need id + label" };
    gated.push({ id: gid, label, description: isRecord(g) ? str(g.description) : undefined });
  }
  const permissions: PluginPermissions = {
    network: strList(p.network),
    fs: strList(p.fs),
    exec: p.exec === true,
    secrets: strList(p.secrets),
    channels: strList(p.channels),
    credits: p.credits === true,
    phi: p.phi === true,
    gated,
  };

  const appearance = parseAppearanceManifest(id, raw.appearance);
  if (!appearance.ok) return { ok: false, error: appearance.error };

  return {
    ok: true,
    fields: {
      manifestVersion: 2,
      engines: { pluginApi },
      rpcNamespace,
      contributes: {
        nav,
        pages,
        rpc,
        rpcAliases,
        http,
        ...(selfAuthHttp.length ? { selfAuthHttp } : {}),
        services: strList(c.services),
        voiceProviders: strList(c.voiceProviders),
        agents,
        landing,
        tools,
        panels,
        ...(navSection ? { navSection } : {}),
        mcpServers,
        ...(clockSections.length ? { clockSections } : {}),
        ...(topbarSlots.length ? { topbarSlots } : {}),
        ...(settingsSections.length ? { settings: settingsSections } : {}),
        ...(learn ? { learn } : {}),
        ...(setupChecks.length ? { setupChecks } : {}),
        ...(mapRoom ? { mapRoom } : {}),
      },
      permissions,
      publisher: str(raw.publisher),
      license: str(raw.license),
      homepage: str(raw.homepage),
      appearance: appearance.appearance,
      catalog: buildContributionCatalog(raw),
    },
  };
}

const MAP_ROOM_ACCENT_RE = /^(token:[a-z]+|#[0-9a-f]{6})$/i;
const MAP_ROOM_TITLE_MAX = 24;

/**
 * `contributes.mapRoom` → the room the plugin gets on the agent mesh map.
 * Absent → default room when the plugin has pages (none otherwise); `false`
 * → no room; object → validated (fail closed). Returns an error string when
 * malformed.
 */
export function parseMapRoom(
  raw: unknown,
  ctx: { name: string; hasPages: boolean },
): PluginMapRoomContribution | undefined | string {
  const defaultTitle = ctx.name.trim().slice(0, MAP_ROOM_TITLE_MAX);
  if (raw === false) return undefined;
  if (raw === undefined || raw === null) {
    return ctx.hasPages
      ? { title: defaultTitle, theme: "generic", size: "M", placement: "auto" }
      : undefined;
  }
  if (!isRecord(raw)) return "contributes.mapRoom must be an object or false";
  const title = str(raw.title) ?? defaultTitle;
  if (title.length > MAP_ROOM_TITLE_MAX) {
    return `mapRoom title "${title}" is longer than ${MAP_ROOM_TITLE_MAX} characters`;
  }
  const theme = raw.theme === undefined ? "generic" : str(raw.theme);
  if (!theme || !(MAP_ROOM_THEMES as readonly string[]).includes(theme)) {
    return `mapRoom theme "${String(raw.theme)}" is not one of ${MAP_ROOM_THEMES.join(", ")}`;
  }
  const size = raw.size === undefined ? "M" : str(raw.size);
  if (!size || !(MAP_ROOM_SIZES as readonly string[]).includes(size)) {
    return `mapRoom size "${String(raw.size)}" must be S, M or L`;
  }
  const placement = raw.placement === undefined ? "auto" : str(raw.placement);
  if (!placement || !(MAP_ROOM_PLACEMENTS as readonly string[]).includes(placement)) {
    return `mapRoom placement "${String(raw.placement)}" must be auto, north, east, south or west`;
  }
  let accent: string | undefined;
  if (raw.accent !== undefined) {
    accent = str(raw.accent);
    if (!accent || !MAP_ROOM_ACCENT_RE.test(accent)) {
      return `mapRoom accent "${String(raw.accent)}" must be token:<name> or #rrggbb`;
    }
    if (accent.startsWith("token:") && !APPEARANCE_TOKEN_NAMES.has(accent.slice(6).toLowerCase())) {
      return `mapRoom accent "${accent}" names an unknown design token`;
    }
    accent = accent.startsWith("#")
      ? accent.toLowerCase()
      : `token:${accent.slice(6).toLowerCase()}`;
  }
  let props: PluginMapRoomProp[] | undefined;
  if (raw.props !== undefined) {
    if (!Array.isArray(raw.props)) return "mapRoom props must be a list";
    if (raw.props.length > 12) return "mapRoom props lists at most 12 props";
    props = [];
    for (const p of raw.props) {
      const name = str(p);
      if (!name || !(MAP_ROOM_PROPS as readonly string[]).includes(name)) {
        return `mapRoom prop "${String(p)}" is not a known map prop`;
      }
      props.push(name as PluginMapRoomProp);
    }
  }
  return {
    title,
    theme: theme as PluginMapRoomTheme,
    size: size as PluginMapRoomSize,
    placement: placement as PluginMapRoomPlacement,
    ...(accent ? { accent } : {}),
    ...(props ? { props } : {}),
  };
}

const TOPBAR_SLOT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `contributes.topbarSlots` → parsed list, or an error string. */
function parseTopbarSlots(raw: unknown): PluginTopbarSlotContribution[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "contributes.topbarSlots must be an array";
  const out: PluginTopbarSlotContribution[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return "contributes.topbarSlots entries must be objects";
    const id = str(entry.id);
    const label = str(entry.label);
    const builtin = str(entry.builtin);
    if (!id || !label) return "contributes.topbarSlots entries need id + label";
    if (!TOPBAR_SLOT_ID.test(id))
      return `topbar slot "${id}" id must match ${TOPBAR_SLOT_ID.source}`;
    if (!builtin) return `topbar slot "${id}" needs builtin`;
    if (out.some((t) => t.id === id)) return `topbar slot "${id}" is declared twice`;
    if (
      entry.order !== undefined &&
      (typeof entry.order !== "number" || !Number.isFinite(entry.order))
    ) {
      return `topbar slot "${id}" order must be a number`;
    }
    if (
      entry.placement !== undefined &&
      entry.placement !== "left" &&
      entry.placement !== "right"
    ) {
      return `topbar slot "${id}" placement must be "left" or "right"`;
    }
    const description = str(entry.description);
    out.push({
      id,
      label,
      builtin,
      order: typeof entry.order === "number" ? entry.order : 100,
      ...(entry.placement === "right" ? { placement: "right" as const } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}

const SETTINGS_SECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `contributes.settings` → parsed list, or an error string. */
/**
 * `contributes.setupChecks` → declared checks. A plugin can only light up its
 * OWN pages (and point its action at them), never a core page.
 */
function parseSetupChecks(
  pluginId: string,
  raw: unknown,
  pages: PluginPageContribution[],
): PluginSetupCheckContribution[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "contributes.setupChecks must be an array";
  const own = new Set(pages.map((pg) => pg.tab));
  const out: PluginSetupCheckContribution[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return "contributes.setupChecks entries must be objects";
    const checkId = str(entry.id);
    const title = str(entry.title);
    if (!checkId || !title) return "contributes.setupChecks entries need id + title";
    if (!checkId.startsWith(`${pluginId}.`)) {
      return `setup check "${checkId}" must be namespaced "${pluginId}.*"`;
    }
    if (out.some((c) => c.id === checkId)) return `setup check "${checkId}" is declared twice`;
    const tabs = strList(entry.tabs);
    if (tabs.length === 0) return `setup check "${checkId}" needs tabs`;
    const foreign = tabs.find((t) => !own.has(t));
    if (foreign)
      return `setup check "${checkId}" tab "${foreign}" is not one of the plugin's pages`;
    let action: PluginSetupCheckContribution["action"];
    if (entry.action !== undefined) {
      const a = isRecord(entry.action) ? entry.action : null;
      const label = a ? str(a.label) : undefined;
      const tab = a ? str(a.tab) : undefined;
      if (!label || !tab) return `setup check "${checkId}" action needs label + tab`;
      if (!own.has(tab))
        return `setup check "${checkId}" action tab "${tab}" is not one of the plugin's pages`;
      const view = a ? str(a.view) : undefined;
      action = { label, tab, ...(view ? { view } : {}) };
    }
    out.push({ id: checkId, title, tabs, ...(action ? { action } : {}) });
  }
  return out;
}

function parseSettingsSections(raw: unknown): PluginSettingsSectionContribution[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "contributes.settings must be an array";
  const out: PluginSettingsSectionContribution[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return "contributes.settings entries must be objects";
    const id = str(entry.id);
    const label = str(entry.label);
    const builtin = str(entry.builtin);
    if (!id || !label) return "contributes.settings entries need id + label";
    if (!SETTINGS_SECTION_ID.test(id))
      return `settings section "${id}" id must match ${SETTINGS_SECTION_ID.source}`;
    if (!builtin) return `settings section "${id}" needs builtin`;
    if (out.some((t) => t.id === id)) return `settings section "${id}" is declared twice`;
    if (
      entry.order !== undefined &&
      (typeof entry.order !== "number" || !Number.isFinite(entry.order))
    ) {
      return `settings section "${id}" order must be a number`;
    }
    const description = str(entry.description);
    out.push({
      id,
      label,
      builtin,
      order: typeof entry.order === "number" ? entry.order : 100,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

/** `contributes.navSection` → parsed section, undefined when absent, or an error string. */
function parseNavSection(
  raw: unknown,
  pages: PluginPageContribution[],
): PluginNavSectionContribution | undefined | string {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return "contributes.navSection must be an object";
  const out: PluginNavSectionContribution = {};
  const title = str(raw.title);
  if (title) out.title = title;
  if (raw.order !== undefined) {
    if (typeof raw.order !== "number" || !Number.isFinite(raw.order)) {
      return "contributes.navSection.order must be a number";
    }
    out.order = raw.order;
  }
  if (raw.collapsedByDefault !== undefined) {
    if (typeof raw.collapsedByDefault !== "boolean") {
      return "contributes.navSection.collapsedByDefault must be a boolean";
    }
    out.collapsedByDefault = raw.collapsedByDefault;
  }
  if (raw.items !== undefined) {
    if (!Array.isArray(raw.items)) return "contributes.navSection.items must be an array";
    const items: PluginNavSectionItem[] = [];
    for (const it of raw.items) {
      const page = isRecord(it) ? str(it.page) : str(it);
      if (!page) return "contributes.navSection.items entries need a page";
      if (!pages.some((pg) => pg.tab === page)) {
        return `navSection item "${page}" has no matching contributes.pages entry`;
      }
      if (items.some((i) => i.page === page)) return `navSection item "${page}" is listed twice`;
      const label = isRecord(it) ? str(it.label) : undefined;
      const icon = isRecord(it) ? str(it.icon) : undefined;
      items.push({ page, ...(label ? { label } : {}), ...(icon ? { icon } : {}) });
    }
    out.items = items;
  }
  return out;
}

const CLOCK_SECTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `contributes.clockSections` → parsed list, or an error string. */
function parseClockSections(raw: unknown): PluginClockSectionContribution[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "contributes.clockSections must be an array";
  const out: PluginClockSectionContribution[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return "contributes.clockSections entries must be objects";
    const id = str(entry.id);
    const label = str(entry.label);
    const builtin = str(entry.builtin);
    if (!id || !label) return "contributes.clockSections entries need id + label";
    if (!CLOCK_SECTION_ID.test(id))
      return `clock section "${id}" id must match ${CLOCK_SECTION_ID.source}`;
    if (!builtin) return `clock section "${id}" needs builtin`;
    if (out.some((s) => s.id === id)) return `clock section "${id}" is declared twice`;
    if (entry.defaultEnabled !== undefined && typeof entry.defaultEnabled !== "boolean") {
      return `clock section "${id}" defaultEnabled must be a boolean`;
    }
    const description = str(entry.description);
    out.push({
      id,
      label,
      builtin,
      defaultEnabled: entry.defaultEnabled !== false,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

type Semver = [number, number, number];

function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Minimal semver range check: space-separated comparators (AND), `||` for OR.
 * Supports `^x.y.z`, `~x.y.z`, `>=`, `>`, `<=`, `<`, `=`, bare versions and `*`.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  return range.split("||").some((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every((part) => {
      if (part === "*" || part === "x") return true;
      const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(part);
      if (!m) return false;
      const op = m[1] ?? "=";
      const target = parseSemver(m[2]);
      if (!target) return false;
      const c = cmp(v, target);
      switch (op) {
        case "^": {
          if (c < 0) return false;
          if (target[0] > 0) return v[0] === target[0];
          if (target[1] > 0) return v[0] === 0 && v[1] === target[1];
          return v[0] === 0 && v[1] === 0 && v[2] === target[2];
        }
        case "~":
          return c >= 0 && v[0] === target[0] && v[1] === target[1];
        case ">=":
          return c >= 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        case "<":
          return c < 0;
        default:
          return c === 0;
      }
    });
  });
}
