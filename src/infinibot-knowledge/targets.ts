/**
 * UI target ids + the adapter to the UI target registry.
 *
 * Id scheme (shared with feat/ui-highlight-nav, which owns navigation and
 * highlighting through ui_control):
 *
 *   page:<tab>                          a routable page     page:apikeys, page:solatrix
 *   page:<host>/<view>                  host sub-tab        page:setup/coders (alias page:coders)
 *   section:<tab>/<section>             in-page section     section:setup/voice
 *   plugin:<id>                         Home › Plugins card/detail
 *   plugin:<id>/<detailSection>         detail tab          plugin:solatrix/permissions
 *   plugin:<id>/settings/<settingsId>   contributes.settings panel
 *   control:<owner>/<panel>/<control>   one control         control:solatrix/agent-access/mode
 *   check:<setupCheckId>                setup-status check  check:core.models
 *   tool:<name>                         agent tool          tool:solana_portfolio
 *   flow:<id>                           how-to flow         flow:connect-gmail
 *
 * The registry branch exports its targets as `ui-targets.json` (and/or an
 * in-process provider). When it is present we enrich entries with its routes
 * and tell agents to use `ui_control navigate/highlight`; when it is absent
 * everything degrades to `nav.switch_tab` on the closest existing page.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { KnowledgeEntry } from "./types.js";

export const pageTarget = (tab: string) => `page:${tab}`;
export const sectionTarget = (tab: string, section: string) => `section:${tab}/${section}`;
export const pluginTarget = (id: string, ...rest: string[]) =>
  rest.length ? `plugin:${id}/${rest.join("/")}` : `plugin:${id}`;
export const controlTarget = (owner: string, panel: string, control: string) =>
  `control:${owner}/${panel}/${control}`;
export const checkTarget = (id: string) => `check:${id}`;
export const toolTarget = (name: string) => `tool:${name}`;
export const flowTarget = (id: string) => `flow:${id}`;

const TARGET_ID = /^(page|section|plugin|control|check|tool|flow|doc):[a-z0-9][a-z0-9._/-]*$/i;

export function isTargetId(id: string): boolean {
  return TARGET_ID.test(id);
}

/** One target as exported by the UI target registry (tolerant shape). */
export type UiTarget = {
  id: string;
  route?: string;
  label?: string;
  breadcrumb?: string[] | string;
};

export type UiTargetRegistry = {
  available: boolean;
  source: string | null;
  targets: Map<string, UiTarget>;
};

type Provider = () => UiTarget[] | { targets: UiTarget[] } | null | undefined;
let provider: Provider | null = null;

/**
 * In-process hook for the UI target registry branch: call once at boot with a
 * function returning its targets. Takes precedence over ui-targets.json.
 */
export function registerUiTargetsProvider(fn: Provider | null): void {
  provider = fn;
  cached = null;
}

function normalize(raw: unknown): UiTarget[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { targets?: unknown }).targets)
      ? (raw as { targets: unknown[] }).targets
      : [];
  const out: UiTarget[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const id = (t as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const r = t as Record<string, unknown>;
    out.push({
      id,
      route: typeof r.route === "string" ? r.route : undefined,
      label: typeof r.label === "string" ? r.label : undefined,
      breadcrumb:
        Array.isArray(r.breadcrumb) || typeof r.breadcrumb === "string"
          ? (r.breadcrumb as string[] | string)
          : undefined,
    });
  }
  return out;
}

/** Candidate locations of the exported registry, most specific first. */
export function uiTargetsCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/infinibot-knowledge or dist/infinibot-knowledge → repo root is ../..
  const root = path.resolve(here, "..", "..");
  const env = process.env.INFINIBOT_UI_TARGETS_PATH?.trim();
  return [
    ...(env ? [env] : []),
    path.join(root, "dist", "control-ui", "ui-targets.json"),
    path.join(root, "dist", "ui-targets.json"),
    path.join(root, "ui", "src", "ui", "ui-targets.json"),
    path.join(root, "src", "ui-targets", "ui-targets.json"),
  ];
}

let cached: { at: number; reg: UiTargetRegistry } | null = null;
const TTL_MS = 30_000;

/** The UI target registry, or an empty `available: false` one. Never throws. */
export function loadUiTargets(
  opts: { force?: boolean; candidates?: string[] } = {},
): UiTargetRegistry {
  if (!opts.force && !opts.candidates && cached && Date.now() - cached.at < TTL_MS)
    return cached.reg;
  let reg: UiTargetRegistry = { available: false, source: null, targets: new Map() };
  try {
    if (provider && !opts.candidates) {
      const list = normalize(provider());
      if (list.length)
        reg = { available: true, source: "provider", targets: new Map(list.map((t) => [t.id, t])) };
    }
    if (!reg.available) {
      for (const file of opts.candidates ?? uiTargetsCandidates()) {
        if (!fs.existsSync(file)) continue;
        const list = normalize(JSON.parse(fs.readFileSync(file, "utf8")));
        if (!list.length) continue;
        reg = { available: true, source: file, targets: new Map(list.map((t) => [t.id, t])) };
        break;
      }
    }
  } catch {
    reg = { available: false, source: null, targets: new Map() };
  }
  if (!opts.candidates) cached = { at: Date.now(), reg };
  return reg;
}

/** Does the live ui_control tool accept `action: "navigate"` / "highlight"? */
export type UiControlCaps = { navigate: boolean; highlight: boolean; guide: boolean };

export function detectUiControlCaps(parameters: unknown): UiControlCaps {
  let text = "";
  try {
    const action = (parameters as { properties?: { action?: unknown } })?.properties?.action;
    text = JSON.stringify(action ?? "");
  } catch {
    text = "";
  }
  return {
    navigate: text.includes('"navigate"'),
    highlight: text.includes('"highlight"'),
    guide: text.includes('"guide"'),
  };
}

/** The exact ui_control call(s) that take the user to an entry. */
export type NavigateHint = {
  /** Call this. */
  call: Record<string, unknown>;
  /** Then this, when available (spotlight the control). */
  highlight?: Record<string, unknown>;
  /** Plain words for the reply ("Opening Solatrix › Settings"). */
  say: string;
  /** True when `call` lands on a nearby page rather than the exact panel. */
  approximate: boolean;
  /** Where the user still has to look after landing (approximate only). */
  thenLookFor?: string;
};

export function navigateHintFor(
  entry: KnowledgeEntry,
  opts: { caps: UiControlCaps; registry: UiTargetRegistry; label?: (tab: string) => string },
): NavigateHint | null {
  const target = entry.targets[0] ?? entry.id;
  const known =
    opts.registry.available &&
    (opts.registry.targets.has(target) || entry.targets.some((t) => opts.registry.targets.has(t)));
  const where = entry.breadcrumb.join(" › ");
  if (opts.caps.navigate && (known || !opts.registry.available)) {
    const exact = entry.targets.find((t) => opts.registry.targets.has(t)) ?? target;
    return {
      call: { action: "navigate", args: { target: exact } },
      highlight: opts.caps.highlight ? { action: "highlight", args: { target: exact } } : undefined,
      say: `Opening ${where}`,
      approximate: false,
    };
  }
  if (!entry.tab) return null;
  const tabTitle = opts.label?.(entry.tab) ?? entry.tab;
  // switch_tab lands on a page/sub-tab; it can't open a plugin's detail tab,
  // scroll to a control or pick an in-page Setup section.
  const route = entry.route ?? "";
  const landsExactly =
    Boolean(route) &&
    !route.includes("&") &&
    !["control", "plugin", "plugin-detail", "plugin-settings", "setup-check"].includes(
      entry.kind,
    ) &&
    (entry.kind !== "section" || route.includes("?view="));
  return {
    call: { action: "dispatch", view: "nav", op: "switch_tab", args: { tab: entry.tab } },
    say: `Opening ${landsExactly ? where : tabTitle}`,
    approximate: !landsExactly,
    thenLookFor: landsExactly ? undefined : `${entry.title} (${where})`,
  };
}
