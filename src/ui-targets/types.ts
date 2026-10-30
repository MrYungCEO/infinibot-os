/**
 * UI target registry — shared schema (gateway + control UI + agents).
 *
 * A **target** is a stable, human-meaningful id for a place an agent can take
 * the user to (a page, a host sub-tab, a plugin settings section) or an
 * element it can point at (a switch, a topbar button, a sidebar entry):
 *
 *   page:plugins                           Home › Plugins
 *   plugin:solatrix/settings/agent-access  Solatrix › Agent access settings
 *   control:solatrix/agent-access/mode     the mode radio group itself
 *   control:topbar/chat                    the topbar "Chat" button
 *   nav:sidebar/mesh                       the sidebar entry for Agent Mesh
 *   setup-check:models                     "add a model API key" setup item
 *
 * Each target says how to reach it (`route` + `reveal` steps) and how to find
 * it on screen (`selectors`, piercing open shadow roots). The gateway resolves
 * ids / natural language to a {@link RevealPlan}; the browser only executes
 * plans, so every agent (in-app, voice, Telegram, sub-agents, MCP) gets the
 * same behaviour.
 *
 * Imported by the UI bundle via a relative path: keep this file
 * dependency-free and side-effect-free.
 */

export type UiTargetKind =
  /** A routable page or host sub-tab. */
  | "page"
  /** A section inside a page (Setup › Coders, a plugin settings section). */
  | "section"
  /** A sidebar / launchpad / ⌘K navigation entry. */
  | "nav"
  /** An interactive element (button, switch, selector, chip). */
  | "control"
  /** A plugin card / detail page / plugin-contributed surface. */
  | "plugin"
  /** A "needs setup" item from the setup-status registry. */
  | "setup-check"
  /** A modal, drawer or panel opened on top of a page. */
  | "modal";

export type UiTargetSource =
  | "navigation"
  | "host-subview"
  | "plugin-manifest"
  | "control-bar"
  | "curated"
  | "learn"
  | "setup-status";

/** When a target exists. Omitted fields = no restriction. */
export type UiTargetAvailability = {
  /** Only while this plugin is installed, enabled and loaded. */
  plugin?: string;
  /** false → not on InfiniBot Cloud (hosted tenants). */
  cloud?: boolean;
  /** false → not on self-hosted installs. */
  local?: boolean;
  /** Only operators with admin rights (owner) can open it. */
  ownerOnly?: boolean;
  /** Needs a viewport at least this wide (CSS px). */
  minWidth?: number;
  /** Free-text caveat shown to the agent ("Electron desktop app only"). */
  note?: string;
};

/**
 * One step the browser performs to reveal a target after (or instead of)
 * routing. Steps are idempotent: `click` steps are skipped when their
 * `unless` selectors already match a visible element.
 */
export type RevealStep =
  /** Navigate (history push + popstate — the router the sidebar uses). */
  | { kind: "route"; route: string }
  /** Fire a window CustomEvent the page listens to (e.g. `infinibot:setup-section`). */
  | { kind: "event"; name: string; detail?: Record<string, unknown> }
  /** Click an element (open a sub-tab / accordion / modal) unless `unless` is already visible. */
  | { kind: "click"; selectors: string[]; unless?: string[]; label?: string }
  /** Dispatch a UIControlBus action (`view` / `action` / `args`). */
  | { kind: "dispatch"; view: string; action: string; args?: Record<string, unknown> }
  /** Open an app-level surface through its own API (idempotent). */
  | { kind: "open"; surface: OpenableSurface; args?: Record<string, unknown> }
  /** Make a sidebar entry visible: expand its group, open the mobile drawer. */
  | { kind: "sidebar"; tab: string }
  /** Wait until one of `selectors` is visible. */
  | { kind: "wait"; selectors: string[]; timeoutMs?: number };

/** App surfaces the browser can open programmatically (guide/surfaces in the UI). */
export type OpenableSurface =
  | "agent-chat"
  | "approvals"
  | "launchpad"
  | "learn"
  | "chart"
  | "sidebar-search";

export type UiTarget = {
  /** Stable id: `<kind>:<path>` (see file header). */
  id: string;
  kind: UiTargetKind;
  title: string;
  /** One or two sentences an agent can read out ("Choose what agents may do…"). */
  description?: string;
  /** Extra phrases for natural-language resolution ("turn on trading", "kill switch"). */
  keywords?: string[];
  /** Other ids that resolve here (legacy tab ids, route-style ids). */
  aliases?: string[];
  /** Page the target lives on (path + query). Omit for global chrome (topbar, sidebar). */
  route?: string;
  /** Steps after routing to make the element exist / visible. */
  reveal?: RevealStep[];
  /** Element(s) to highlight, tried in order. Pierce open shadow roots. */
  selectors?: string[];
  /** Tried when no selector is visible (e.g. the ⋯ overflow menu button). */
  fallbackSelectors?: string[];
  /** Callout text used with the fallback ("It's in this menu"). */
  fallbackHint?: string;
  /** Parent target id (page for a control, plugin for a section). */
  parent?: string;
  /** Tab id backing this target (for page-allowlist checks in the browser). */
  tab?: string;
  availability?: UiTargetAvailability;
  source: UiTargetSource;
  /** Owning plugin (for plugin-contributed targets). */
  pluginId?: string;
};

/** Where the registry is being evaluated (drives availability). */
export type UiTargetEnv = {
  cloud: boolean;
  /** Ids of loaded (enabled) plugins. Undefined = unknown → treat as available. */
  enabledPlugins?: ReadonlySet<string>;
  /** Ids of installed plugins (loaded or not). */
  installedPlugins?: ReadonlySet<string>;
};

export type UiTargetAvailabilityResult = {
  available: boolean;
  /** Why not (for the agent to relay). */
  reason?: string;
  /** A target that fixes it (e.g. `plugin:solatrix/enable`). */
  fixTarget?: string;
};

/** A concrete plan the browser executes for navigate / highlight / guide steps. */
export type RevealPlan = {
  targetId: string;
  title: string;
  kind: UiTargetKind;
  route?: string;
  reveal: RevealStep[];
  selectors: string[];
  fallbackSelectors?: string[];
  fallbackHint?: string;
  tab?: string;
};

export type UiTargetMatch = {
  target: UiTarget;
  /** 0..1 */
  confidence: number;
  /** Which fields matched (debug / agent explanation). */
  matched: string[];
};

export type UiTargetResolution =
  | {
      ok: true;
      target: UiTarget;
      confidence: number;
      via: "id" | "alias" | "query";
      alternatives: UiTargetMatch[];
    }
  | { ok: false; reason: "ambiguous" | "not-found" | "empty"; candidates: UiTargetMatch[] };

/** Highlight rendering style. */
export type HighlightStyle = "pulse" | "spotlight" | "outline" | "arrow";

export const HIGHLIGHT_STYLES: readonly HighlightStyle[] = [
  "pulse",
  "spotlight",
  "outline",
  "arrow",
];

/** Attribute name for explicit targets in markup. */
export const TARGET_ATTR = "data-ib-target";

/** `[data-ib-target="<id>"]` */
export function targetAttrSelector(id: string): string {
  return `[${TARGET_ATTR}="${id.replace(/"/g, '\\"')}"]`;
}

/** `[data-learn-id="<id>"]` — Learn v2 walkthrough anchors double as targets. */
export function learnAttrSelector(id: string): string {
  return `[data-learn-id="${id.replace(/"/g, '\\"')}"]`;
}
