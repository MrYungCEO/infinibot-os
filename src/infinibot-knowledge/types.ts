/**
 * InfiniBot self-knowledge — shared types.
 *
 * The knowledge base describes the product AS IT EXISTS IN THE CODE: every
 * sidebar page and sub-tab (ui/src/ui/navigation.ts), Setup sections, plugin
 * manifests (pages, settings sections, permissions, tools, setup checks),
 * setup-status checks, Learn walkthroughs and the docs/ tree. Only intent the
 * code can't express lives in curated.ts, and every curated entry is checked
 * against real routes by tests.
 *
 * Every entry carries UI target ids (targets.ts) so an agent can navigate to
 * and highlight the exact place instead of describing a click-path.
 */

export type KnowledgeKind =
  /** A routable control-UI page (sidebar entry, retired/hidden page or plugin page). */
  | "page"
  /** A sub-tab of a merged host page (`/setup?view=coders`). */
  | "subview"
  /** An in-page section without its own URL (Setup › Voice). */
  | "section"
  /** A plugin's card/detail in Home › Plugins. */
  | "plugin"
  /** A section of a plugin's detail page (Settings, Permissions, …). */
  | "plugin-detail"
  /** A plugin-contributed settings panel (`contributes.settings`). */
  | "plugin-settings"
  /** One control inside a page/panel (Solatrix › Agent access mode). */
  | "control"
  /** A setup-status check (sidebar glow + page banner). */
  | "setup-check"
  /** An agent tool. */
  | "tool"
  /** A how-to flow (curated or a Learn walkthrough). */
  | "flow"
  /** A docs/ page. */
  | "doc";

export type KnowledgeEntry = {
  /** Stable id — also the primary UI target id (`page:apikeys`). */
  id: string;
  kind: KnowledgeKind;
  title: string;
  /** One or two sentences: what it is / what it's for. */
  summary: string;
  /** Human breadcrumb that MATCHES the UI labels (["Home", "Plugins"]). */
  breadcrumb: string[];
  /** URL path (+ query) inside the control UI; always resolvable (tests). */
  route?: string;
  /** Tab id that `nav.switch_tab` accepts to reach this place (closest page). */
  tab?: string;
  /** UI target ids for navigate/highlight (self first). */
  targets: string[];
  /** Extra search words (synonyms, retired names, labels). */
  keywords: string[];
  /** Plugin that owns/contributes this entry. */
  pluginId?: string;
  /** The page/panel only exists while this plugin is enabled. */
  requiresPlugin?: string;
  /** Absent in hosted cloud (SaaS) mode. */
  localOnly?: boolean;
  /** Ordered steps (flows). */
  steps?: string[];
  /** Related entry ids. */
  related?: string[];
  /** Where this entry was derived from (file or registry). */
  source: string;
  /** Free-form facts (tool trust, permission ids, setup action, …). */
  facts?: Record<string, unknown>;
};

export type KnowledgeSnapshot = {
  version: 1;
  /** Hash of the generator inputs — tests compare it to detect drift. */
  inputsHash: string;
  entries: KnowledgeEntry[];
  /** Sidebar groups in order (for the compact prompt map). */
  sidebar: { label: string; items: { tab: string; label: string }[] }[];
  /** Plugin sidebar sections (manifest navSection), all installed plugins. */
  pluginSections: { pluginId: string; title: string; items: { tab: string; label: string }[] }[];
  counts: Record<string, number>;
};

export type KnowledgeBase = {
  entries: KnowledgeEntry[];
  byId: Map<string, KnowledgeEntry>;
  sidebar: KnowledgeSnapshot["sidebar"];
  pluginSections: KnowledgeSnapshot["pluginSections"];
  /** Where plugin data came from: live registry or build snapshot. */
  pluginSource: "registry" | "snapshot";
  /** Whether the UI target registry (feat/ui-highlight-nav) was found. */
  uiTargets: { available: boolean; source: string | null; count: number };
  builtAt: number;
};
