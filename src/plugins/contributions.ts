/**
 * Contribution catalog — every capability a manifest-v2 plugin declares,
 * flattened into individually addressable items for Setup › Plugins.
 *
 * Each item has a stable key (`<kind>:<id>`), says whether the host can
 * toggle it at runtime today (`live`) and which permissions it depends on
 * (`requires`), so revoking a permission can disable exactly the dependent
 * contributions. Parsing here is deliberately lenient: the strict contract
 * checks live in manifest-v2.ts; this only describes what was declared, so
 * a manifest field this host doesn't understand yet never breaks loading.
 *
 * Additive manifest fields read here (all optional):
 *  - `requires: string[]` on any contribution entry — permission keys it
 *    needs (`exec`, `credits`, `network:<host>`, `secrets:<NAME>`,
 *    `channels:<id>`, `fs:<path>`, or a bare category like `network`).
 *  - `contributes.importers: [{ id, label, description?, method, accept? }]`
 *    — data importers surfaced in the Data tab; `method` must be one of the
 *    plugin's declared RPCs. `input: "none"` renders a run button instead of
 *    a file picker (for importers that read from a configured source).
 */

export type ContributionKind =
  | "nav"
  | "page"
  | "subview"
  | "widget"
  | "overlay"
  | "settings"
  | "launchpad"
  | "mapLayer"
  | "mapRoom"
  | "clockSection"
  | "topbarSlot"
  | "panelKind"
  | "rpc"
  | "http"
  | "tool"
  | "skill"
  | "cron"
  | "agent"
  | "channel"
  | "provider"
  | "hook"
  | "service"
  | "sidecar"
  | "mcp"
  | "importer"
  | "learn";

export type ContributionItem = {
  key: string;
  kind: ContributionKind;
  id: string;
  label: string;
  detail?: string;
  /** Owner can switch it off individually. */
  toggleable: boolean;
  /** The running host enforces the toggle immediately (no restart). When
   *  false the choice is saved and applied by the host that owns that
   *  contribution type once it lands (Phase 0B/0D). */
  live: boolean;
  /** Permission keys this contribution depends on. */
  requires: string[];
  /** Default state for contributions that ship off (e.g. cron). */
  defaultEnabled?: boolean;
};

export type PluginImporter = {
  id: string;
  label: string;
  description?: string;
  method: string;
  accept?: string;
  /** "file" (default): the UI sends { filename, content }. "none": a run button, sends {}. */
  input?: "file" | "none";
};

export type PermissionItem = {
  key: string;
  category: "network" | "fs" | "exec" | "secrets" | "channels" | "credits" | "gated";
  value?: string;
  /** Consent text shown before granting/revoking. */
  consent: string;
  /** Gated permissions only: short name of the capability. */
  label?: string;
  /** False for gated permissions: OFF until the owner grants them. */
  defaultGranted?: boolean;
};

/** Key of a gated (default-off) permission, e.g. `gated:orders`. */
export function gatedPermissionKey(id: string): string {
  return `gated:${id}`;
}

export const CONTRIBUTION_KIND_LABELS: Record<ContributionKind, string> = {
  nav: "Nav entry",
  page: "Page",
  subview: "Sub-view",
  widget: "Widget",
  overlay: "Overlay",
  settings: "Settings section",
  launchpad: "Launchpad entry",
  mapLayer: "Map layer",
  mapRoom: "Mesh map room",
  clockSection: "Clock section",
  topbarSlot: "Topbar control",
  panelKind: "Chat panel kind",
  rpc: "RPC method",
  http: "HTTP route",
  tool: "Agent tool",
  skill: "Skill",
  cron: "Cron job",
  agent: "Agent",
  channel: "Channel",
  provider: "Provider",
  hook: "Hook",
  service: "Background service",
  sidecar: "Sidecar",
  mcp: "MCP server",
  importer: "Importer",
  learn: "Learn track",
};

/** Group headings on the Plugins page (explicit so we never print "Nav entrys"). */
export const CONTRIBUTION_KIND_PLURALS: Record<ContributionKind, string> = {
  nav: "Nav entries",
  page: "Pages",
  subview: "Sub-views",
  widget: "Widgets",
  overlay: "Overlays",
  settings: "Settings sections",
  launchpad: "Launchpad entries",
  mapLayer: "Map layers",
  mapRoom: "Mesh map rooms",
  clockSection: "Clock sections",
  topbarSlot: "Topbar controls",
  panelKind: "Chat panel kinds",
  rpc: "RPC methods",
  http: "HTTP routes",
  tool: "Agent tools",
  skill: "Skills",
  cron: "Cron jobs",
  agent: "Agents",
  channel: "Channels",
  provider: "Providers",
  hook: "Hooks",
  service: "Background services",
  sidecar: "Sidecars",
  mcp: "MCP servers",
  importer: "Importers",
  learn: "Learn tracks",
};

/** Which kinds the host toggles live today. */
const LIVE_KINDS: ReadonlySet<ContributionKind> = new Set([
  "nav",
  "page",
  // The control UI drops a switched-off topbar slot on its next plugins.list.
  "topbarSlot",
  "rpc",
  "http",
  "tool",
  "service",
  "importer",
  // The control UI drops a switched-off clock section on its next plugins.list.
  "clockSection",
  // Setup › Plugins drops a switched-off settings section on its next plugins.list.
  "settings",
  // learn.guided.catalog leaves a switched-off track out on the next fetch.
  "learn",
  // The agent mesh map dissolves a switched-off room on its next plugins.list.
  "mapRoom",
]);
/** Which kinds may be toggled at all (saved even when not yet live). */
const TOGGLEABLE_KINDS: ReadonlySet<ContributionKind> = new Set([
  ...LIVE_KINDS,
  "subview",
  "widget",
  "overlay",
  "launchpad",
  "mapLayer",
  "cron",
  "agent",
  "skill",
  "mcp",
  "sidecar",
  "panelKind",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiresOf(entry: unknown): string[] {
  if (!isRecord(entry)) return [];
  return list(entry.requires)
    .map((r) => str(r))
    .filter((r): r is string => Boolean(r));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** Build the catalog from a raw v2 manifest object. */
export function buildContributionCatalog(raw: Record<string, unknown>): {
  items: ContributionItem[];
  importers: PluginImporter[];
} {
  const c = isRecord(raw.contributes) ? raw.contributes : {};
  const items: ContributionItem[] = [];
  const seen = new Set<string>();
  const push = (
    kind: ContributionKind,
    id: string | undefined,
    label: string | undefined,
    entry: unknown,
    extra: Partial<ContributionItem> = {},
  ) => {
    if (!id) return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      key,
      kind,
      id,
      label: label ?? id,
      toggleable: TOGGLEABLE_KINDS.has(kind),
      live: LIVE_KINDS.has(kind),
      requires: requiresOf(entry),
      ...extra,
    });
  };

  for (const n of list(c.nav)) {
    if (isRecord(n))
      push("nav", str(n.tab), str(n.label), n, {
        detail: str(n.group) ? `Sidebar › ${str(n.group)}` : "Sidebar",
      });
  }
  for (const p of list(c.pages)) {
    if (isRecord(p))
      push("page", str(p.tab), str(p.title) ?? str(p.route), p, { detail: str(p.route) });
  }
  for (const s of list(c.subviews)) {
    if (isRecord(s))
      push("subview", str(s.id), str(s.label), s, {
        detail: str(s.host) ? `in ${str(s.host)}` : undefined,
      });
  }
  for (const w of list(c.widgets)) {
    if (isRecord(w)) push("widget", str(w.id), str(w.label), w, { detail: str(w.surface) });
  }
  for (const o of list(c.overlays)) {
    if (isRecord(o)) push("overlay", str(o.id), str(o.label), o, { detail: str(o.trigger) });
  }
  for (const s of list(c.settings)) {
    if (isRecord(s)) push("settings", str(s.id), str(s.label), s, { detail: "Setup › Plugins" });
  }
  for (const l of list(c.launchpad)) {
    if (isRecord(l)) push("launchpad", str(l.id), str(l.label), l);
  }
  for (const m of list(c.mapLayers)) {
    if (isRecord(m)) push("mapLayer", str(m.id), str(m.label), m);
  }
  // One room per plugin on the agent mesh map: declared, or the default every
  // plugin with pages gets. Keyed by the plugin id (`mapRoom:<id>`).
  if (c.mapRoom !== false && (isRecord(c.mapRoom) || list(c.pages).length > 0)) {
    const pluginId = str(raw.id);
    const title = isRecord(c.mapRoom) ? str(c.mapRoom.title) : undefined;
    push("mapRoom", pluginId, title ?? str(raw.name) ?? pluginId, c.mapRoom, {
      detail: isRecord(c.mapRoom) ? str(c.mapRoom.theme) : "generic",
    });
  }
  for (const k of list(c.clockSections)) {
    if (isRecord(k)) push("clockSection", str(k.id), str(k.label), k, { detail: "Topbar clock" });
  }
  for (const t of list(c.topbarSlots)) {
    if (isRecord(t)) push("topbarSlot", str(t.id), str(t.label), t, { detail: "Topbar" });
  }
  const learn = c.learn;
  for (const t of list(Array.isArray(learn) ? learn : isRecord(learn) ? learn.tracks : undefined)) {
    if (isRecord(t)) push("learn", str(t.id), str(t.title), t, { detail: "Learn page" });
  }
  for (const k of list(c.panelKinds)) {
    if (isRecord(k)) push("panelKind", str(k.id), str(k.label), k);
  }
  for (const k of list(c.panels)) {
    const id = isRecord(k) ? str(k.id) : str(k);
    push("panelKind", id, isRecord(k) ? (str(k.label) ?? id) : id, k);
  }
  for (const r of list(c.rpc)) {
    const method = isRecord(r) ? str(r.method) : str(r);
    push("rpc", method, method, r, { detail: isRecord(r) ? (str(r.scope) ?? "admin") : "admin" });
  }
  for (const h of list(c.http)) {
    const path = isRecord(h) ? str(h.path) : str(h);
    push("http", path, path, h);
  }
  for (const t of list(c.tools)) {
    const name = isRecord(t) ? str(t.name) : str(t);
    const trust = isRecord(t) ? str(t.trust) : undefined;
    const implicit = trust === "exec" ? ["exec"] : [];
    push("tool", name, name, t, { detail: trust ? `trust: ${trust}` : undefined });
    const item = items.find((i) => i.key === `tool:${name}`);
    if (item) item.requires = [...new Set([...item.requires, ...implicit])];
  }
  for (const s of list(c.skills)) {
    const path = isRecord(s) ? (str(s.path) ?? str(s.id)) : str(s);
    push("skill", path, path, s);
  }
  for (const j of list(c.cron)) {
    if (!isRecord(j)) continue;
    push("cron", str(j.id), str(j.label) ?? str(j.id), j, {
      detail: str(j.schedule),
      defaultEnabled: j.defaultEnabled !== false,
    });
  }
  for (const a of [...list(c.roster), ...list(c.agents)]) {
    if (isRecord(a))
      push("agent", str(a.agentId) ?? str(a.id), str(a.label) ?? str(a.agentId) ?? str(a.id), a);
  }
  for (const ch of list(c.channels)) {
    const id = isRecord(ch) ? str(ch.id) : str(ch);
    push("channel", id, id, ch);
  }
  for (const p of list(c.providers)) {
    if (isRecord(p))
      push("provider", str(p.id), str(p.label) ?? str(p.id), p, { detail: str(p.kind) });
    else push("provider", str(p), str(p), p);
  }
  for (const h of list(c.hooks)) {
    const id = isRecord(h) ? (str(h.event) ?? str(h.id)) : str(h);
    push("hook", id, id, h);
  }
  for (const s of list(c.services)) {
    const id = isRecord(s) ? str(s.id) : str(s);
    push("service", id, id, s);
  }
  for (const s of list(c.sidecars)) {
    if (!isRecord(s)) continue;
    push("sidecar", str(s.id), str(s.label) ?? str(s.id), s, { detail: str(s.image) });
  }
  for (const m of list(c.mcpServers)) {
    if (!isRecord(m)) continue;
    const id = str(m.id);
    push("mcp", id, str(m.label) ?? id, m, { detail: str(m.url) ?? str(m.command) });
    const item = items.find((i) => i.key === `mcp:${id}`);
    if (item) {
      const auth = str(m.auth);
      const secret = auth?.startsWith("secret:") ? `secrets:${auth.slice(7)}` : undefined;
      const host = str(m.url) ? hostOf(str(m.url) as string) : undefined;
      item.requires = [
        ...new Set([
          ...item.requires,
          ...(secret ? [secret] : []),
          ...(host ? [`network:${host}`] : []),
        ]),
      ];
    }
  }

  const rpcMethods = new Set(items.filter((i) => i.kind === "rpc").map((i) => i.id));
  const importers: PluginImporter[] = [];
  for (const imp of list(c.importers)) {
    if (!isRecord(imp)) continue;
    const id = str(imp.id);
    const method = str(imp.method);
    if (!id || !method || !rpcMethods.has(method)) continue;
    importers.push({
      id,
      label: str(imp.label) ?? id,
      description: str(imp.description),
      method,
      accept: str(imp.accept),
      input: imp.input === "none" ? "none" : "file",
    });
    push("importer", id, str(imp.label) ?? id, imp, { detail: method });
  }
  return { items, importers };
}

const CONSENT: Record<PermissionItem["category"], (v?: string) => string> = {
  network: (v) => `Connect to ${v ?? "the network"} from the gateway.`,
  fs: (v) => `Read and write files in ${v ?? "its data folder"}.`,
  exec: () => "Run programs and commands on this machine or on your connected servers.",
  secrets: (v) => `Read the ${v ?? ""} secret from your vault.`,
  channels: (v) => `Send messages on your ${v ?? ""} channel.`,
  credits: () => "Spend InfiniBot Cloud credits for paid usage.",
  gated: (v) => `Allow ${v ?? "this capability"}. Off until you turn it on.`,
};

/** Flatten a manifest's `permissions` into individually grantable keys. */
export function listPermissionItems(perms: Record<string, unknown> | undefined): PermissionItem[] {
  const out: PermissionItem[] = [];
  if (!perms) return out;
  for (const category of ["network", "fs", "secrets", "channels"] as const) {
    for (const v of list(perms[category])) {
      const value = str(v);
      if (value)
        out.push({
          key: `${category}:${value}`,
          category,
          value,
          consent: CONSENT[category](value),
        });
    }
  }
  if (perms.exec === true) out.push({ key: "exec", category: "exec", consent: CONSENT.exec() });
  if (perms.credits === true)
    out.push({ key: "credits", category: "credits", consent: CONSENT.credits() });
  // High-risk capabilities declared in permissions.gated: listed like any
  // other permission, but OFF until the owner grants them (host-state.ts).
  for (const g of list(perms.gated)) {
    if (!isRecord(g)) continue;
    const id = str(g.id);
    if (!id) continue;
    const label = str(g.label) ?? id;
    out.push({
      key: gatedPermissionKey(id),
      category: "gated",
      value: id,
      label,
      consent: str(g.description) ?? CONSENT.gated(label),
      defaultGranted: false,
    });
  }
  return out;
}

/** A requirement is unmet when its permission key (or its whole category) is revoked. */
export function isRequirementRevoked(requirement: string, revoked: ReadonlySet<string>): boolean {
  if (revoked.has(requirement)) return true;
  const category = requirement.split(":")[0];
  if (category !== requirement) return false;
  // Bare category ("network"): conservatively unmet when any key in it is revoked.
  for (const key of revoked) if (key === category || key.startsWith(`${category}:`)) return true;
  return false;
}

/** Contributions disabled as a consequence of revoked permissions. */
export function contributionsBlockedByRevokes(
  items: ContributionItem[],
  revoked: ReadonlySet<string>,
): ContributionItem[] {
  if (revoked.size === 0) return [];
  return items.filter((i) => i.requires.some((r) => isRequirementRevoked(r, revoked)));
}
