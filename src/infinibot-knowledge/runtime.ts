/**
 * Runtime knowledge base = build snapshot + live plugin registry + UI target
 * registry. Rebuilt lazily whenever the active plugin registry changes (plugin
 * enabled/disabled/installed → gateway reload) so agents always describe the
 * product that is actually running. Cheap: ~500 entries, pure data.
 */

import { getActivePluginRegistry, getActivePluginRegistryKey } from "../plugins/runtime.js";
import { indexEntries } from "./build.js";
import { CORE_KNOWLEDGE } from "./generated/core-knowledge.generated.js";
import { pluginEntries, pluginSection, type PluginManifestLike } from "./plugins.js";
import { loadUiTargets, type UiTarget } from "./targets.js";
import type { KnowledgeBase, KnowledgeEntry, KnowledgeKind, KnowledgeSnapshot } from "./types.js";

type RegistryPlugin = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  status?: string;
  contributes?: unknown;
  permissions?: unknown;
  configJsonSchema?: unknown;
  configUiHints?: unknown;
  listing?: { tagline?: string };
};

export type BuildKnowledgeOpts = {
  snapshot?: KnowledgeSnapshot;
  /** Live registry plugins; null = use the snapshot only. */
  plugins?: RegistryPlugin[] | null;
  uiTargets?: UiTarget[];
};

const KIND_OF_PREFIX: Record<string, KnowledgeKind> = {
  page: "page",
  section: "section",
  plugin: "plugin-detail",
  control: "control",
  check: "setup-check",
  tool: "tool",
  flow: "flow",
};

/** Pure: snapshot + live plugins + UI targets → knowledge base. */
export function composeKnowledgeBase(opts: BuildKnowledgeOpts = {}): KnowledgeBase {
  const snap = opts.snapshot ?? CORE_KNOWLEDGE;
  const entries: KnowledgeEntry[] = snap.entries.map((e) => ({ ...e }));
  const ids = new Set(entries.map((e) => e.id));
  const pluginSections = [...snap.pluginSections];

  // Plugins installed/updated after the build: add what the snapshot lacks.
  for (const p of opts.plugins ?? []) {
    const manifest: PluginManifestLike = {
      id: p.id,
      name: p.name,
      description: p.description,
      listing: p.listing,
      contributes: p.contributes as PluginManifestLike["contributes"],
      permissions: p.permissions as PluginManifestLike["permissions"],
      configSchema: p.configJsonSchema as PluginManifestLike["configSchema"],
      uiHints: p.configUiHints as PluginManifestLike["uiHints"],
    };
    for (const e of pluginEntries(manifest, "plugin registry (live)")) {
      if (ids.has(e.id)) continue;
      ids.add(e.id);
      entries.push(e);
    }
    const sec = pluginSection(manifest);
    if (sec && !pluginSections.some((s) => s.pluginId === sec.pluginId)) pluginSections.push(sec);
  }

  // UI target registry (feat/ui-highlight-nav): targets we don't describe yet
  // still become findable, minimal entries.
  for (const t of opts.uiTargets ?? []) {
    const byTarget = entries.find((e) => e.targets.includes(t.id));
    if (byTarget) continue;
    const prefix = t.id.split(":")[0] ?? "";
    const crumb = Array.isArray(t.breadcrumb)
      ? t.breadcrumb
      : typeof t.breadcrumb === "string"
        ? t.breadcrumb.split(/\s*›\s*/)
        : [t.label ?? t.id];
    entries.push({
      id: t.id,
      kind: KIND_OF_PREFIX[prefix] ?? "control",
      title: t.label ?? t.id,
      summary: t.label ?? t.id,
      breadcrumb: crumb,
      route: t.route,
      targets: [t.id],
      keywords: [t.label ?? "", ...crumb].filter(Boolean),
      source: "ui-targets registry",
    });
    ids.add(t.id);
  }

  return {
    entries,
    byId: indexEntries(entries),
    sidebar: snap.sidebar,
    pluginSections,
    pluginSource: opts.plugins ? "registry" : "snapshot",
    uiTargets: {
      available: Boolean(opts.uiTargets?.length),
      source: null,
      count: opts.uiTargets?.length ?? 0,
    },
    builtAt: Date.now(),
  };
}

let cache: { key: string; kb: KnowledgeBase } | null = null;

/** The live knowledge base (cached until the plugin registry or UI targets change). */
export function getKnowledgeBase(opts: { force?: boolean } = {}): KnowledgeBase {
  const registry = getActivePluginRegistry();
  const targets = loadUiTargets();
  const plugins = (registry?.plugins ?? []) as unknown as RegistryPlugin[];
  const key = [
    getActivePluginRegistryKey() ?? "none",
    plugins.map((p) => `${p.id}:${p.status}`).join(","),
    targets.source ?? "no-targets",
    targets.targets.size,
  ].join("|");
  if (!opts.force && cache?.key === key) return cache.kb;
  const kb = composeKnowledgeBase({
    plugins: registry ? plugins : null,
    uiTargets: [...targets.targets.values()],
  });
  kb.uiTargets.source = targets.source;
  cache = { key, kb };
  return kb;
}

/** Drop the cache (tests; plugin install hooks). */
export function resetKnowledgeBaseCache(): void {
  cache = null;
}

/** Enabled plugin ids from the live registry (null when no registry). */
export function enabledPluginIds(): string[] | null {
  const registry = getActivePluginRegistry();
  if (!registry) return null;
  return registry.plugins.filter((p) => p.enabled && p.status === "loaded").map((p) => p.id);
}
